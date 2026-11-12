// Company pulls (the Companies tab): one aiark_company_runs row per pull,
// worked a slice at a time by the enrichment worker (scripts/enrich-worker.mjs)
// beside the people runs (runs.mjs), into the client's template Companies table
// on the Clay tab (enrich_tables.template = 'companies_v1'). The worker's row
// loop then works each company: the office in the area, a held inbox, the
// website, the general email (company-template.mjs).
//
// A slice does one thing, in this order across the pull:
//   1. copy  up to 1,000 companies from the registry (aiark_companies): bought
//            before, for any client, with an office in this client's places,
//            passing its company filters, not in its table yet. Free, and they
//            count toward the pull's size.
//   2. lists leave out what is held: AI Ark exclusion lists (company_id, free)
//            of the registry companies in this client's places and of those
//            any of its pulls bought, newest first, at most 10 x 10,000, within
//            the 50 lists a day people runs also spend (listsMadeToday).
//   3. buy   one page of Company Search (up to 100 companies, 0.1 credit each),
//            written in one statement: rows, input cells, registry entries,
//            the pull's counters and cursor.
//
// Paying twice for a company: the registry copy, then the lists, keep a pull
// from buying what any pull bought. Past them (more than 100,000 ids, or no
// list budget) AI Ark may return one again: it is paid again, written once
// (ON CONFLICT), marked "Bought before" and counted in bought_before.
//
// One search pages through 10,000 records at most. At that point the pull
// makes its lists again, now leaving out what it bought, and starts the search
// over; with no list budget left it moves on to the next search instead and
// records the cap.
//
// Crash and cancel: a slice holds the pull with a claim token and a 10-minute
// lease; cursor writes are fenced on it. A page whose write never committed is
// bought again on resume (at most 10 credits); its companies still go in once.
// A page write that committed but whose answer was lost is not counted twice:
// each page carries an id the run records (progress.last_page). A cancel means
// no new paid call: it is seen before each page.
//
// Spending brake: before each page, at that page's full price, the pull stops
// rather than pass ceil(size x 0.125) + searches + 2 credits. A page whose
// answer was lost (a network error or a 5xx) may have been charged: it counts
// against the brake at full price, the pull backs off, and 3 in a row stop it.

import { randomUUID } from "node:crypto";
import { AiArkError, clip, COMPANY_PRICE, LIST_MAX, LISTS_PER_DAY, LISTS_PER_REQUEST, PAGE_MAX, SEARCH_CAP } from "./client.mjs";
import { companyMatch, companyPlaceKeys, companySpendCeiling, matchesCompanyFilters } from "./company-filters.mjs";
import { aiArkFor, LEASE_MIN, LIST_BUDGET, LIST_LIFE_MS, LIST_REFRESH_MS, listsMadeToday } from "./runs.mjs";
import { geoFor } from "../enrich/client-checks.mjs";
import {
  COMPANY_COLUMNS, COMPANY_INPUT_KEYS, COMPANY_SEARCH_KEYS, COMPANY_TEMPLATE, companyInputs, SOURCE_BOUGHT, SOURCE_COPIED,
  TEMPLATE_TABLE_NAME,
} from "../enrich/company-template.mjs";

const MAX_ATTEMPTS = 6;
const BACKOFF_MAX_MS = 15 * 60_000;
const COPY_BATCH = 1_000; // registry companies looked at per slice
const WRITE_CHUNK = 100; // companies per write statement
const LOST_PAGES_MAX = 3; // lost answers in a row before the pull stops
const LISTS_RETRY_MS = 3600_000; // a list build that fell short is tried again at most hourly
const WRITE_RETRIES = 3;
const WRITE_RETRY_MS = 500;
const PLAIN = /^[\x20-\x7e]*$/; // the cells kept when Postgres refuses a company's values

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n).toLocaleString("en-US");
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const backoffMs = (attempts) => Math.min(30_000 * 2 ** (attempts - 1), BACKOFF_MAX_MS);

/** What a pull has spent, counting pages whose answer was lost at full price. */
const spentOf = (ctx) => round2(ctx.spent + Number(ctx.progress.lost_credits ?? 0));
const ceilingOf = (run) => companySpendCeiling(run.size_requested, run.requests.length);
const brakeReason = (run, used) =>
  `Stopped by the pull's spending brake: ${fmt(used)} credits used (pages whose answer was lost count at full price) against a limit of ${fmt(ceilingOf(run))} for ${fmt(run.size_requested)} companies. The next page could pass it, so nothing more was bought.`;

// ── The client's template table ─────────────────────────────────────────────

/**
 * The client's template Companies table, made on its first pull. Every call
 * brings its columns up to date with COMPANY_COLUMNS, by key, as
 * scripts/enrich-seed-table.mjs does, and never removes one: a template change
 * reaches a client's table on its next pull. Rows already worked are not re-run.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db  a client inside the caller's transaction
 * @param {string} tag
 * @returns {Promise<{ id: string, created: boolean }>}
 */
export async function ensureTemplateTable(db, tag) {
  const { rows: [table] } = await db.query(
    `INSERT INTO enrich_tables (client_tag, kind, name, source_note, template)
     VALUES ($1, 'companies', $2, $3, $4)
     ON CONFLICT (client_tag, kind, template) WHERE template IS NOT NULL
     DO UPDATE SET source_note = EXCLUDED.source_note
     RETURNING id, (xmax = 0) AS created`,
    [tag, TEMPLATE_TABLE_NAME, `Companies template ${COMPANY_TEMPLATE}: companies from AI Ark pulls on the Companies tab`, COMPANY_TEMPLATE]
  );
  await db.query(
    `INSERT INTO enrich_columns AS e (table_id, key, name, position, kind, action, formula, waterfall, inputs, config, run_if,
                                       data_type, description, provider, needs_env, phase, hidden)
     SELECT $1, x.key, x.name, x.position, x.kind, x.action, x.formula, x.waterfall, coalesce(x.inputs, '{}'::jsonb),
            coalesce(x.config, '{}'::jsonb), x.run_if, x.data_type, x.description, x.provider, x.needs_env, x.phase, x.hidden
       FROM jsonb_to_recordset($2::jsonb) AS x(key text, name text, position int, kind text, action text, formula text,
            waterfall jsonb, inputs jsonb, config jsonb, run_if text, data_type text, description text, provider text,
            needs_env text[], phase smallint, hidden boolean)
     ON CONFLICT (table_id, key) DO UPDATE SET
       name = EXCLUDED.name, position = EXCLUDED.position, kind = EXCLUDED.kind, action = EXCLUDED.action,
       formula = EXCLUDED.formula, waterfall = EXCLUDED.waterfall, inputs = EXCLUDED.inputs, config = EXCLUDED.config,
       run_if = EXCLUDED.run_if, data_type = EXCLUDED.data_type, description = EXCLUDED.description,
       provider = EXCLUDED.provider, needs_env = EXCLUDED.needs_env, phase = EXCLUDED.phase, hidden = EXCLUDED.hidden`,
    [table.id, JSON.stringify(COMPANY_COLUMNS)]
  );
  return { id: table.id, created: table.created };
}

// ── Creating a pull (called by POST /api/companies/runs inside its transaction) ──

/**
 * Brings the client's template table up to date (or makes it), then creates
 * the pull's two sources (bought, and copied free from the registry) and the
 * queued aiark_company_runs row. What the registry copy matches is worked out
 * here from the client's rules and the request's company filters, and kept on
 * the pull as filters.copy, so the copy asks for what AI Ark is asked for.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db  a client inside the caller's transaction
 * @param {{ tag: string, mode: "live" | "demo", size: number, filters: object, requests: object[],
 *           matchCount?: number | null, createdBy?: string | null }} opts
 *   filters: what the tab showed (versions, report, notes); requests: buildCompanyRequests()'s bodies
 * @returns {Promise<object>} the aiark_company_runs row
 */
export async function createCompanyRun(db, { tag, mode, size, filters, requests, matchCount = null, createdBy = null }) {
  const id = randomUUID();
  const table = await ensureTemplateTable(db, tag);
  const { rows: [targeting] } = await db.query(`SELECT include_locations, exclude_locations FROM client_targeting WHERE client_tag = $1`, [tag]);
  const { geo } = await geoFor(db);
  const copy = companyMatch({ targeting: targeting ?? null, request: requests?.[0], geo });
  const { rows: [bought] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, label, meta, created_by) VALUES ($1, 'ai_ark', $2, $3, $4) RETURNING id`,
    [table.id, `AI Ark company pull${mode === "demo" ? " (made-up companies)" : ""}`, JSON.stringify({ run_id: id, mode, size }), createdBy]
  );
  const { rows: [copied] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, label, meta, created_by) VALUES ($1, 'registry', $2, $3, $4) RETURNING id`,
    [table.id, "Copied from earlier pulls (no charge)", JSON.stringify({ run_id: id, mode }), createdBy]
  );
  const { rows: [run] } = await db.query(
    `INSERT INTO aiark_company_runs (id, client_tag, mode, size_requested, table_id, source_id, registry_source_id, filters, requests,
                                     match_count, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [id, tag, mode, size, table.id, bought.id, copied.id, JSON.stringify({ ...(filters ?? {}), copy }), JSON.stringify(requests), matchCount, createdBy]
  );
  return run;
}

// ── Queue ───────────────────────────────────────────────────────────────────

const HAS_WORK = `q.status IN ('queued', 'running')`;

async function claimRun(pool) {
  const { rows } = await pool.query(
    `UPDATE aiark_company_runs r
        SET claim_token = $1, claimed_at = now(), started_at = coalesce(r.started_at, now()), status = 'running'
      WHERE r.id = (
        SELECT q.id FROM aiark_company_runs q
         WHERE ${HAS_WORK} AND q.next_run_at <= now()
           AND (q.claim_token IS NULL OR q.claimed_at < now() - make_interval(mins => $2))
         ORDER BY q.next_run_at, q.created_at
         LIMIT 1
           FOR UPDATE SKIP LOCKED)
      RETURNING r.*`,
    [randomUUID(), LEASE_MIN]
  );
  return rows[0] ?? null;
}

/** Is any company pull due now? (The worker's drain-and-exit mode asks.) */
export async function companyRunDue(pool) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM aiark_company_runs q WHERE ${HAS_WORK} AND q.next_run_at <= now()
                     AND (q.claim_token IS NULL OR q.claimed_at < now() - make_interval(mins => $1))) AS due`,
    [LEASE_MIN]
  );
  return rows[0].due;
}

class LostClaim extends Error {}
class Cancelled extends Error {}
/** A write failed and the pull could not be read back: what its row holds is unknown, so nothing is written over it. */
class Unread extends Error {}

/** Saves the cursor (fenced). A cancel stops the slice here, before anything more is bought. */
async function savePosition(ctx) {
  const { rows } = await ctx.pool.query(
    `UPDATE aiark_company_runs SET progress = $3, claimed_at = now() WHERE id = $1 AND claim_token = $2 RETURNING status`,
    [ctx.run.id, ctx.run.claim_token, ctx.progress]
  );
  if (!rows[0]) throw new LostClaim();
  if (rows[0].status === "cancelled") throw new Cancelled();
}

async function release(ctx, { inMs = 0, attempts = 0, lastError = null } = {}) {
  await ctx.pool.query(
    `UPDATE aiark_company_runs SET claim_token = NULL, claimed_at = NULL, progress = $3, attempts = $4, last_error = $5,
            next_run_at = now() + make_interval(secs => $6)
      WHERE id = $1 AND claim_token = $2`,
    [ctx.run.id, ctx.run.claim_token, ctx.progress, attempts, lastError, inMs / 1000]
  );
}

/** Ends the pull. A cancelled pull stays cancelled. Its sources get their counts. */
async function finish(ctx, { status, stopReason = null, lastError = null }) {
  let creditsAfter = null;
  try {
    // A worker that is stopping doesn't wait for it.
    if (!ctx.shouldStop()) creditsAfter = await ctx.client.credits();
  } catch {
    /* the balance is a nicety; never fail a finish over it */
  }
  const { rows } = await ctx.pool.query(
    `UPDATE aiark_company_runs
        SET status = CASE WHEN status = 'running' THEN $3 ELSE status END,
            stop_reason = coalesce($4, stop_reason),
            last_error = CASE WHEN $3 IN ('done', 'stopped') THEN $5 ELSE coalesce($5, last_error) END,
            progress = $6, credits_after = coalesce($7, credits_after),
            finished_at = coalesce(finished_at, now()), claim_token = NULL, claimed_at = NULL
      WHERE id = $1 AND claim_token = $2
      RETURNING status, pulled, from_registry, source_id, registry_source_id`,
    [ctx.run.id, ctx.run.claim_token, status, stopReason, lastError, ctx.progress, creditsAfter]
  );
  const r = rows[0];
  if (r?.source_id) {
    await ctx.pool.query(`UPDATE enrich_sources SET received = $2, created = $3 WHERE id = $1`, [r.source_id, Number(ctx.progress.bought ?? 0), r.pulled - r.from_registry]);
  }
  if (r?.registry_source_id) {
    await ctx.pool.query(`UPDATE enrich_sources SET received = $2, created = $2 WHERE id = $1`, [r.registry_source_id, r.from_registry]);
  }
  ctx.log?.(`AI Ark company pull ${ctx.run.id.slice(0, 8)}: ${r?.status ?? "?"}${stopReason ? `: ${stopReason}` : ""}${lastError ? ` (${lastError})` : ""}`);
  return r?.status;
}

// ── Writing companies ───────────────────────────────────────────────────────

/** Text with no lone half of a surrogate pair and no NUL, which Postgres refuses inside jsonb. */
function sane(v) {
  if (typeof v === "string") return v.toWellFormed().replace(/\u0000/g, "");
  if (Array.isArray(v)) return v.map(sane);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sane(x)]));
  return v;
}

/** The record the registry keeps: everything but technologies, funding and the logo. */
export function trimRecord(record) {
  const { technologies, financial, ...rest } = record ?? {};
  void technologies;
  const out = { ...rest };
  if (out.summary && typeof out.summary === "object") {
    const { logo, ...summary } = out.summary;
    void logo;
    out.summary = summary;
  }
  if (financial && typeof financial === "object") {
    const { funding, ...fin } = financial;
    void funding;
    if (Object.keys(fin).length) out.financial = fin;
  }
  return sane(out);
}

/** AI Ark's last_updated as a date, or null when it isn't one. */
function dateOf(v) {
  const s = String(v ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

/** One company as the write statement takes it. */
function companyRow(record, { source, pulledBefore = null, geo = null }, plain = false) {
  const inputs = companyInputs(record, { source, pulledBefore });
  const cells = {};
  for (const k of COMPANY_INPUT_KEYS) {
    const v = inputs[k];
    if (v && (!plain || k === "aiark_id" || PLAIN.test(String(v)))) cells[k] = clip(String(v).replace(/\u0000/g, ""), 5_000);
  }
  const trimmed = trimRecord(record);
  return {
    company_id: String(record.id),
    row_key: `aiark:${record.id}`,
    search: clip(COMPANY_SEARCH_KEYS.map((k) => cells[k]).filter(Boolean).join(" ").toLowerCase(), 2_000),
    cells,
    record: plain ? JSON.parse(JSON.stringify(trimmed).replace(/[^\x20-\x7e]/g, "?")) : trimmed,
    name: cells.company ?? null,
    domain: cells.domain ?? null,
    place_keys: geo ? companyPlaceKeys(record, geo) : [],
    updated: dateOf(record.last_updated),
  };
}

const WRITE_SQL = `
  WITH st AS (
    SELECT status, claim_token = $2 AS held, (progress->>'last_page') IS NOT DISTINCT FROM $8::text AS repeat
      FROM aiark_company_runs WHERE id = $1 FOR UPDATE
  ), x AS (
    SELECT * FROM jsonb_to_recordset($5::jsonb)
           AS x(company_id text, row_key text, search text, cells jsonb, record jsonb, name text, domain text,
                place_keys text[], updated date)
  ), r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text)
    SELECT $3::uuid, $4::uuid, x.row_key, x.search FROM x
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id, row_key
  ), c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $3::uuid, 'done', to_jsonb(kv.value), left(kv.value, 300)
      FROM r JOIN x ON x.row_key = r.row_key CROSS JOIN LATERAL jsonb_each_text(x.cells) AS kv
    RETURNING 1
  ), g AS (
    INSERT INTO aiark_companies (company_id, demo, run_id, name, domain, place_keys, record, aiark_updated)
    SELECT x.company_id, $6::boolean, $1::uuid, x.name, x.domain, coalesce(x.place_keys, '{}'::text[]), x.record, x.updated
      FROM x WHERE $7::boolean
    ON CONFLICT (company_id) DO NOTHING
    RETURNING 1
  ), u AS (
    UPDATE aiark_company_runs q
       SET pulled = q.pulled + (SELECT count(*) FROM r)::int,
           from_registry = q.from_registry + CASE WHEN $7::boolean THEN 0 ELSE (SELECT count(*) FROM r)::int END,
           bought_before = q.bought_before + CASE WHEN (SELECT repeat FROM st) THEN 0 ELSE $9::int END,
           credits_used = q.credits_used + CASE WHEN (SELECT repeat FROM st) THEN 0 ELSE $10::numeric END,
           progress = CASE WHEN (SELECT held FROM st) AND $11::jsonb IS NOT NULL THEN $11::jsonb ELSE q.progress END,
           claimed_at = CASE WHEN q.claim_token = $2 THEN now() ELSE q.claimed_at END
     WHERE q.id = $1
    RETURNING q.pulled, q.credits_used
  )
  SELECT (SELECT held FROM st) AS held, (SELECT status FROM st) AS status, (SELECT count(*) FROM r)::int AS inserted,
         (SELECT count(*) FROM g)::int AS registered, (SELECT pulled FROM u) AS pulled, (SELECT credits_used::float8 FROM u) AS used`;

/**
 * Companies into the client's table (and, for a bought page, the registry),
 * with the pull's counters and cursor, in one statement. Everything is written
 * even if the claim was lost, since a bought page is paid for by then, and ON
 * CONFLICT keeps a repeat harmless; the cursor moves only while the claim is
 * held. pageId makes a page count once: a retry of a write that committed adds
 * no credits and no "bought before" again.
 */
async function writeOnce(ctx, { companies, sourceId, register, credits = 0, boughtBefore = 0, pageId = null, progress = null }) {
  const { rows: [r] } = await ctx.pool.query(WRITE_SQL, [
    ctx.run.id, ctx.run.claim_token, ctx.run.table_id, sourceId, JSON.stringify(companies), ctx.run.mode === "demo", register,
    pageId, boughtBefore, credits, progress === null ? null : JSON.stringify(progress),
  ]);
  ctx.pulled = r.pulled;
  ctx.spent = r.used;
  if (r.held && progress) ctx.progress = progress;
  if (!r.held) throw new LostClaim();
  return r;
}

/**
 * A bought page lives only in memory until it is written, so a failed write is
 * tried again. A value Postgres refuses (SQLSTATE class 22) is refused every
 * time: the companies then go in with only their plain-text cells. If the
 * write can't be made, the pull's row is read back, so what is released is
 * what the database holds, not the copy in memory.
 */
async function writeCompanies(ctx, args, build) {
  let plain = false;
  for (let tries = 0; ; tries++) {
    try {
      return await writeOnce(ctx, { ...args, companies: build(plain) });
    } catch (e) {
      if (e instanceof LostClaim || e instanceof Cancelled) throw e;
      if (/^22/.test(String(e?.code ?? "")) && !plain) {
        plain = true;
        continue;
      }
      if (tries < WRITE_RETRIES) {
        await sleep(WRITE_RETRY_MS * (tries + 1));
        continue;
      }
      let row;
      try {
        ({ rows: [row] } = await ctx.pool.query(
          `SELECT progress, pulled, credits_used::float8 AS used FROM aiark_company_runs WHERE id = $1 AND claim_token = $2`,
          [ctx.run.id, ctx.run.claim_token]
        ));
      } catch {
        throw new Unread(String(e?.message ?? e));
      }
      if (!row) throw new LostClaim();
      ctx.progress = row.progress ?? {};
      ctx.pulled = row.pulled;
      ctx.spent = row.used;
      throw e;
    }
  }
}

// ── 1. The registry copy ────────────────────────────────────────────────────

async function sliceCopy(ctx) {
  const { run, pool } = ctx;
  const copy = run.filters?.copy;
  const p = ctx.progress;
  if (!copy?.include?.length) {
    ctx.progress = { ...p, copy_done: true };
    await savePosition(ctx);
    return { more: true };
  }
  const { rows } = await pool.query(
    `SELECT c.company_id, c.record
       FROM aiark_companies c
      WHERE c.demo = $1 AND c.place_keys && $2::text[] AND c.company_id > $3
        AND NOT EXISTS (SELECT 1 FROM enrich_rows r WHERE r.table_id = $4 AND r.row_key = 'aiark:' || c.company_id)
      ORDER BY c.company_id
      LIMIT $5`,
    [run.mode === "demo", copy.include, p.copy_after ?? "", run.table_id, ctx.copyBatch]
  );
  const { geo } = await geoFor(pool);
  const room = Math.max(0, run.size_requested - ctx.pulled);
  const picked = rows.filter((r) => matchesCompanyFilters(r.record, copy, geo)).slice(0, room);
  for (let i = 0; i < picked.length; i += WRITE_CHUNK) {
    const chunk = picked.slice(i, i + WRITE_CHUNK);
    await writeCompanies(ctx, { sourceId: run.registry_source_id, register: false }, (plain) =>
      chunk.map((r) => companyRow({ ...r.record, id: r.company_id }, { source: SOURCE_COPIED }, plain))
    );
  }
  const done = rows.length < ctx.copyBatch || ctx.pulled >= run.size_requested;
  ctx.progress = {
    ...ctx.progress,
    copy_after: rows.at(-1)?.company_id ?? p.copy_after ?? null,
    copy_done: done,
    copy_checked: (p.copy_checked ?? 0) + rows.length,
  };
  await savePosition(ctx);
  if (ctx.pulled >= run.size_requested) return { done: null };
  return { more: true };
}

// ── 2. Exclusion lists ──────────────────────────────────────────────────────

const listsAlive = (p) => Boolean(p.lists_at) && Date.now() - Date.parse(p.lists_at) < LIST_LIFE_MS;

/** Does the next slice make lists? At the start, when they are a day old, and when a search reached the cap. */
function listsDue(p) {
  if (p.cap_hit != null) return true;
  if (!p.lists_at) return true;
  const stale = Date.now() - Date.parse(p.lists_at) > LIST_REFRESH_MS;
  return stale && (!p.lists_tried || Date.now() - Date.parse(p.lists_tried) > LISTS_RETRY_MS);
}

/**
 * Asks AI Ark to leave out the companies already held for this client: the
 * registry companies with an office in its places and those any of its pulls
 * bought, newest first, up to 10 lists of 10,000, as far as today's budget
 * allows. Lists are made one at a time and saved as they are made, so a retry
 * carries on instead of spending the budget again. A list AI Ark refuses ends
 * the build with what was made; an error worth retrying is rethrown.
 */
async function sliceLists(ctx) {
  const { pool, client, run } = ctx;
  const p = ctx.progress;
  const demo = run.mode === "demo";
  const include = run.filters?.copy?.include ?? [];
  const made = await listsMadeToday(pool, run.mode);
  const budget = Math.max(0, LIST_BUDGET - made);
  const held = `demo = $1 AND pulled_at < $2::timestamptz
                AND (place_keys && $3::text[] OR run_id IN (SELECT id FROM aiark_company_runs WHERE client_tag = $4))`;

  let plan = p.lists_new && Date.now() - Date.parse(p.lists_new.started) < LIST_REFRESH_MS ? p.lists_new : null;
  if (!plan) {
    const { rows: [{ at }] } = await pool.query(`SELECT now()::text AS at`);
    const { rows: [{ n }] } = await pool.query(`SELECT count(*)::int AS n FROM aiark_companies WHERE ${held}`, [demo, at, include, run.client_tag]);
    const want = Math.min(n, LISTS_PER_REQUEST * LIST_MAX);
    plan = { at, started: new Date().toISOString(), held: n, want, room: Math.min(want, budget * LIST_MAX), ids: [], count: 0 };
  }

  let refused = null;
  for (let left = budget; plan.count < plan.room && left > 0; left--) {
    const { rows } = await pool.query(
      `SELECT company_id FROM aiark_companies WHERE ${held} ORDER BY pulled_at DESC, company_id OFFSET $5 LIMIT $6`,
      [demo, plan.at, include, run.client_tag, plan.count, Math.min(LIST_MAX, plan.room - plan.count)]
    );
    if (!rows.length) break;
    let id;
    try {
      id = await client.createList(rows.map((x) => x.company_id), "company_id");
    } catch (e) {
      if (!(e instanceof AiArkError) || e.retryable || e.kind === "key" || e.kind === "credits") throw e;
      refused = e.message;
      break;
    }
    plan = { ...plan, ids: [...plan.ids, id], count: plan.count + rows.length };
    ctx.progress = { ...ctx.progress, lists_new: plan, lists_log: [...(ctx.progress.lists_log ?? []), new Date().toISOString()] };
    await savePosition(ctx);
  }

  const short = plan.count < plan.want;
  // A build cut short never replaces lists that still leave out more.
  const keepOld = listsAlive(p) && Number(p.excluded ?? 0) > plan.count;
  const lists = keepOld ? p.lists ?? [] : plan.ids;
  const excluded = keepOld ? Number(p.excluded) : plan.count;
  const note = refused
    ? `AI Ark refused an exclusion list (${refused}), so some companies bought before may be bought again.`
    : short
      ? `Not enough exclusion lists left today (AI Ark allows ${LISTS_PER_DAY} a day, shared with people pulls): they leave out ${fmt(excluded)} of the ${fmt(plan.want)} companies held, so some may be bought again.`
      : plan.want < plan.held
        ? `Left out the ${fmt(excluded)} most recently bought of ${fmt(plan.held)} companies held (AI Ark takes 100,000 a search).`
        : null;
  let next = {
    ...ctx.progress,
    lists,
    lists_at: keepOld ? p.lists_at : plan.started,
    lists_tried: new Date().toISOString(),
    lists_new: null,
    excluded,
    lists_short: short || Boolean(refused),
    lists_note: note,
  };
  if (p.cap_hit != null) {
    // The search went as deep as AI Ark allows. Start it over if the new lists
    // leave out everything held, this pull's own companies included; else move on.
    const s = p.cap_hit;
    const whole = !refused && !keepOld && plan.count >= plan.held;
    next = whole
      ? { ...next, cap_hit: null, search: s, offset: 0, restarts: { ...(p.restarts ?? {}), [s]: Number(p.restarts?.[s] ?? 0) + 1 } }
      : { ...next, cap_hit: null, search: s + 1, offset: 0, capped: [...(p.capped ?? []), s] };
  } else if (lists.join() !== (p.lists ?? []).join() && p.lists_at) {
    // New lists change what a search returns, so the current search starts over.
    next = { ...next, offset: 0 };
  }
  ctx.progress = next;
  await savePosition(ctx);
  return { more: true };
}

// ── 3. Buying a page ────────────────────────────────────────────────────────

/**
 * The page size at an offset: AI Ark pages by page x size, so a smaller last
 * page must divide the offset to start where the last one ended.
 */
export function pageSizeAt(offset, max) {
  if (max <= 1) return 1;
  if (offset === 0) return max;
  for (let s = max; s > 1; s--) if (offset % s === 0) return s;
  return 1;
}

const endReason = (p, searches) => {
  const n = p.capped?.length ?? 0;
  if (!n) return "No more matches";
  const which = searches === 1 ? "the search" : n === 1 ? "1 of the searches" : `${n} of the ${searches} searches`;
  return `Reached AI Ark's limit of 10,000 records in ${which}, with no exclusion lists left today to go deeper.${n < searches ? " The other searches ran out of matches." : ""}`;
};

async function sliceBuy(ctx) {
  const { run, pool } = ctx;
  const p = ctx.progress;
  const search = p.search ?? 0;
  if (search >= run.requests.length) return { done: endReason(p, run.requests.length) };
  const remaining = run.size_requested - ctx.pulled;
  if (remaining <= 0) return { done: null };
  const offset = p.offset ?? 0;
  if (offset >= ctx.searchCap) {
    ctx.progress = { ...p, cap_hit: search };
    await savePosition(ctx);
    return { more: true };
  }
  const size = pageSizeAt(offset, Math.min(PAGE_MAX, remaining, ctx.searchCap - offset));
  const price = round2(size * COMPANY_PRICE);
  const spent = spentOf(ctx);
  if (spent + price > ceilingOf(run) + 1e-9) return { stop: brakeReason(run, spent) };
  if (ctx.shouldStop()) return { wait: 0 };
  await savePosition(ctx); // a cancel is seen here, before anything is bought

  let res;
  try {
    res = await ctx.client.companySearch(run.requests[search], { page: offset / size, size, lists: p.lists ?? [] });
  } catch (e) {
    if (e instanceof AiArkError && (e.kind === "network" || e.kind === "server")) {
      // The answer is gone and AI Ark may have charged for the page.
      const lost = Number(p.lost_in_row ?? 0) + 1;
      ctx.progress = { ...p, lost_in_row: lost, lost_pages: Number(p.lost_pages ?? 0) + 1, lost_credits: round2(Number(p.lost_credits ?? 0) + price) };
      if (lost >= LOST_PAGES_MAX) {
        return { stop: `AI Ark's answer was lost ${lost} times in a row (${e.message}). Each of those pages may have been charged, so the pull stopped.` };
      }
      return { error: e };
    }
    throw e;
  }

  const content = res.content.filter((c) => c && typeof c === "object" && c.id);
  const ids = [...new Set(content.map((c) => String(c.id)))];
  const { rows: prior } = ids.length
    ? await pool.query(`SELECT company_id, pulled_at, run_id FROM aiark_companies WHERE company_id = ANY($1::text[])`, [ids])
    : { rows: [] };
  const before = new Map(prior.map((x) => [x.company_id, x]));
  const { geo } = await geoFor(pool);
  const seen = new Set();
  const unique = content.filter((c) => !seen.has(String(c.id)) && seen.add(String(c.id)));
  const lastPage = res.content.length < size || offset + size >= res.totalElements;
  const next = {
    ...p,
    matches: { ...(p.matches ?? {}), [search]: res.totalElements },
    bought: Number(p.bought ?? 0) + res.content.length,
    pages: Number(p.pages ?? 0) + 1,
    lost_in_row: 0,
    ...(lastPage ? { search: search + 1, offset: 0 } : { offset: offset + size }),
  };
  const pageId = randomUUID();
  const w = await writeCompanies(
    ctx,
    { sourceId: run.source_id, register: true, credits: res.credits, boughtBefore: unique.filter((c) => before.has(String(c.id))).length, pageId, progress: { ...next, last_page: pageId } },
    (plain) =>
      unique.map((c) => {
        const prev = before.get(String(c.id));
        const pulledBefore = prev
          ? `Bought ${new Date(prev.pulled_at).toISOString().slice(0, 10)}${prev.run_id ? ` (pull ${String(prev.run_id).slice(0, 6)})` : ""}`
          : null;
        return companyRow(c, { source: SOURCE_BOUGHT, pulledBefore, geo }, plain);
      })
  );
  if (w.status === "cancelled") throw new Cancelled();
  if (ctx.pulled >= run.size_requested) return { done: null };
  if (lastPage && search + 1 >= run.requests.length) return { done: endReason(ctx.progress, run.requests.length) };
  return { more: true };
}

// ── One slice ───────────────────────────────────────────────────────────────

/**
 * Claims one due company pull, works one slice of it and lets go. Returns the
 * pull's id when one was worked, null when nothing was due.
 *
 * `clientFor(mode)` replaces aiArkFor (tests use it to inject faults);
 * `searchCap` lowers the 10,000-record cap for tests (with the demo's own
 * searchCap); `copyBatch` the registry companies looked at per slice.
 * `shouldStop()` turning true lets go of the pull before its next paid call.
 */
export async function advanceOneCompanyRun({
  pool, env = process.env, log = () => {}, clientFor = null, shouldStop = () => false, searchCap = SEARCH_CAP, copyBatch = COPY_BATCH,
}) {
  const run = await claimRun(pool);
  if (!run) return null;
  const got = clientFor ? await clientFor(run.mode) : await aiArkFor(run.mode, { env, db: pool });
  // spent: the pull's credits_used as its own writes return it, for the spending brake.
  const ctx = {
    pool, env, log, run, client: got.client, progress: run.progress ?? {}, pulled: run.pulled, spent: Number(run.credits_used),
    shouldStop, searchCap, copyBatch,
  };

  const why = !got.client ? got.why : !run.table_id ? "The client's Companies table was deleted, so the pull has nowhere to write" : null;
  if (why) {
    await pool.query(
      `UPDATE aiark_company_runs SET status = CASE WHEN status = 'running' THEN 'error' ELSE status END, last_error = $3,
              finished_at = coalesce(finished_at, now()), claim_token = NULL, claimed_at = NULL
        WHERE id = $1 AND claim_token = $2`,
      [run.id, run.claim_token, why]
    );
    log(`AI Ark company pull ${run.id.slice(0, 8)}: ${why}`);
    return run.id;
  }

  try {
    if (run.credits_before == null) {
      // The balance is for the record only: a pull never waits on it (a bad key fails the first real call).
      const before = await ctx.client.credits().catch(() => null);
      if (before != null) {
        await pool.query(`UPDATE aiark_company_runs SET credits_before = $3 WHERE id = $1 AND claim_token = $2`, [run.id, run.claim_token, before]);
      }
    }
    if (ctx.pulled >= run.size_requested) {
      await finish(ctx, { status: "done" });
      return run.id;
    }
    if (spentOf(ctx) >= ceilingOf(run)) {
      await finish(ctx, { status: "stopped", stopReason: brakeReason(run, spentOf(ctx)) });
      return run.id;
    }

    const out = !ctx.progress.copy_done ? await sliceCopy(ctx) : listsDue(ctx.progress) ? await sliceLists(ctx) : await sliceBuy(ctx);
    if (out.fail) {
      await finish(ctx, { status: "error", lastError: out.fail });
    } else if (out.stop) {
      await finish(ctx, { status: "stopped", stopReason: out.stop });
    } else if (out.done !== undefined) {
      await finish(ctx, { status: "done", stopReason: out.done });
    } else if (out.error) {
      const attempts = run.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) await finish(ctx, { status: "error", lastError: `Gave up after ${attempts} tries: ${out.error.message}` });
      else await release(ctx, { inMs: backoffMs(attempts), attempts, lastError: out.error.message });
    } else {
      await release(ctx, { inMs: out.wait ?? 0, attempts: 0 });
    }
  } catch (e) {
    if (e instanceof LostClaim) {
      log(`AI Ark company pull ${run.id.slice(0, 8)}: claim lost mid-slice (reclaimed elsewhere), stopped`);
    } else if (e instanceof Unread) {
      log(`AI Ark company pull ${run.id.slice(0, 8)}: ${e.message}, and the pull could not be read back; left as it is until its lease runs out`);
    } else if (e instanceof Cancelled) {
      await finish(ctx, { status: "cancelled" });
    } else if (e instanceof AiArkError && e.kind === "credits") {
      await finish(ctx, { status: "stopped", stopReason: "The AI Ark account ran out of credits" });
    } else if (e instanceof AiArkError && (e.kind === "key" || !e.retryable)) {
      // 401/403: the key. 400: AI Ark refused the request, and charged nothing for it.
      await finish(ctx, { status: "error", lastError: e.message });
    } else {
      const attempts = run.attempts + 1;
      const msg = String(e?.message ?? e).slice(0, 300);
      if (attempts >= MAX_ATTEMPTS) await finish(ctx, { status: "error", lastError: `Gave up after ${attempts} tries: ${msg}` }).catch(() => {});
      else await release(ctx, { inMs: backoffMs(attempts), attempts, lastError: msg }).catch(() => {});
      log(`AI Ark company pull ${run.id.slice(0, 8)}: ${msg} (try ${attempts} of ${MAX_ATTEMPTS})`);
    }
  }
  return run.id;
}
