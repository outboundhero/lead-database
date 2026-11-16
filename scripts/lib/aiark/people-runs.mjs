// People runs (the Companies tab, phase 2): the people at a client's pipeline
// companies, from AI Ark, one aiark_people_runs row per run, worked a slice at
// a time by the enrichment worker beside the AI Ark tab's runs and the company
// pulls (one AI Ark client, one throttle).
//
// A run, in order:
//   1. Look   one People Preview page a slice (1 credit), by company id, in
//             batches of ids_per_search companies, at most pages_per_search
//             pages a batch. Everyone seen goes into aiark_people_candidates,
//             screened for free in the same slice: the database (by name and
//             company, lead_lookup), the person's own place (client_area), the
//             client's exclusions (client_exclusions), the track (trackOf), and
//             the registry (bought before). A person bought before with an
//             email is copied free as a People row (D27).
//   2. Pick   per company of the batch, one statement: a company where anyone
//             was screened "held" is skipped (D11); per track, in the agreed
//             order, the best-ranked candidate is picked, the next ones kept in
//             reserve up to tries_per_track; a track a copy covers is not bought.
//   3. Pause  with auto_buy off (the default, D25) the run stops in status
//             "looked" until a manager clicks Buy (approveBuy).
//   4. Buy    Export Single per pick, at most maxBuysPerSlice a slice: the
//             People row, the registry entry and the counters in one statement,
//             written even after a lost claim (the person is paid for). With no
//             email the row is written with stage no_email and the track's next
//             reserve is bought, if any.
//   5. Settle a track is settled when it has a usable email (or one waiting for
//             Enrichley), has used its tries, or has no candidate left, and none
//             of its People rows is queued or running. When all three are, the
//             company is settled and its company row is queued again (2A.7).
//   6. Finish when every company is settled, with the balance after (free).
//
// Paying twice: the registry (aiark_people) is read per page, and again for
// the picks right before a Buy, so a person bought by any run (since the Look
// too) is copied, never bought again; candidates are written once per run (ON
// CONFLICT); a buy is recorded with its registry entry in one statement. A Look
// sends no exclusion lists (the shared daily budget stays with the AI Ark tab
// and the company pulls).
//
// Crash and cancel: a slice holds the run with a claim token and a 10-minute
// lease, and every cursor write is fenced on it. A page whose write never
// committed is bought again on resume (1 credit); its people go in once. The
// person about to be bought is saved in the cursor before the call, so a buy
// whose answer was lost in a crash is counted as lost (1 credit), never bought
// twice. A cancel is seen before every paid call: no new paid call after it.
//
// Brakes: searches x pages_per_search + ceil(max_people x 1.25) + 10 credits,
// checked before each Preview page and each Export Single, counting lost
// answers at full price; AI Ark's balance, read free, must stay at or above
// people_pipeline.min_balance; the run stops when people runs are switched off
// for the client. While an AI Ark tab export job of the same mode is unread,
// the run waits (it reads aiark_runs and changes nothing there).
//
// Nothing here reads or writes leads, and these runs never appear on the AI
// Ark tab (pullsToAdd reads aiark_runs only).
//
// LinkedIn people runs (source "linkedin", which looks by area: migration 128)
// take the same queue, claim, brakes and pause, with their own Look, pick and
// Buy (linkedin-people.mjs, handed this file's helpers as KIT below).

import { randomUUID } from "node:crypto";
import { AiArkError, clip, PAGE_MAX, personInputs, SEARCH_CAP } from "./client.mjs";
import { aiArkFor, LEASE_MIN } from "./runs.mjs";
import { excludedTitlesFor, IDS_PER_SEARCH, peopleRequestsFor, peopleSourceInfo, trackOf } from "./people-requests.mjs";
import { scopeOf, standardFor } from "./standard-filters.mjs";
// Registers the "linkedin" people source (by area) wherever people runs are worked.
import "./linkedin-requests.mjs";
import { buyByArea, createLinkedinPeopleRun, lookByArea } from "./linkedin-people.mjs";
import { CLIENT_ACTIONS } from "../enrich/client-checks.mjs";
import { normTag, readSettings, settingsFrom, TRACKS } from "../enrich/settings.mjs";
import { ensurePipelineTables } from "../enrich/templates.mjs";
import { aiarkPersonRowKey, PEOPLE_INPUT_KEYS, sourceObject } from "../enrich/people-template.mjs";
import { bareDomain } from "../enrich/domain.mjs";

const MAX_ATTEMPTS = 6;
const BACKOFF_MAX_MS = 15 * 60_000;
const LOST_PAGES_MAX = 3; // Preview answers lost in a row before the run stops
const LOST_ANSWERS_MAX = 5; // Export Single answers lost in a row before the run backs off
const OTHER_JOB_WAIT_MS = 30_000;
const ROWS_WAIT_MS = 15_000; // People rows still being worked: settle again after this
const WRITE_RETRIES = 3;
const WRITE_RETRY_MS = 500;
const SCREEN_THREADS = 4;
const SETTLE_CHUNK = 2_000;
/** The most companies one run takes; the next run takes the rest. */
export const COMPANIES_MAX = 10_000;
/** Export Single's price when no email comes back: 0 by AI Ark's docs, not yet seen live. The estimates allow this much. */
export const MISS_ESTIMATE = 0.5;
const ACTIVE = ["queued", "running", "looked"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n).toLocaleString("en-US");
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const backoffMs = (attempts) => Math.min(30_000 * 2 ** (attempts - 1), BACKOFF_MAX_MS);

/** A refusal to start a run, with its reason: the route answers 409 (changed: the settings changed since the page loaded them). */
export class PeopleRunRefused extends Error {
  constructor(message, { changed = false } = {}) {
    super(message);
    this.name = "PeopleRunRefused";
    this.status = 409;
    this.changed = changed;
  }
}
class LostClaim extends Error {}
class Cancelled extends Error {}
/** Does a run's source look by area (the LinkedIn people runs)? */
const byArea = (run) => peopleSourceInfo(run?.source)?.look === "by_area";

/** A free check of the screen could not be made (the client's rules are gone, say): the run ends with it. */
class CheckFailed extends Error {}
/** A write failed and the run could not be read back: what its row holds is unknown, so nothing is written over it. */
class Unread extends Error {}

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 */

// ── The brake ───────────────────────────────────────────────────────────────

/** Searches a run makes at most: each batch once per group of titles. */
const searchesOf = (run) => Math.max(1, Number(run.batches) || 0) * Math.max(1, Number(run.filters?.bodies_per_batch) || 1);
/** The most a run may spend, in credits: its Look pages, its Buys at full price and a quarter more, and a little room. */
export const peopleSpendCeiling = (run) =>
  searchesOf(run) * Math.max(1, Number(run.filters?.pages_per_search) || 1) + Math.ceil(Number(run.max_people) * 1.25) + 10;
/** What a run has spent, counting answers that were lost at full price. */
const spentOf = (ctx) => round2(ctx.spent + Number(ctx.progress.lost_credits ?? 0));
const brakeReason = (run, used) =>
  `Stopped by the run's spending brake: ${fmt(used)} credits used (answers that were lost count at full price) against a limit of ${fmt(peopleSpendCeiling(run))} for ${fmt(run.batches)} ${run.batches === 1 ? "batch" : "batches"} and at most ${fmt(run.max_people)} people. The next call could pass it, so nothing more was bought.`;

// ── Eligible companies ──────────────────────────────────────────────────────

const COMPANY_ID = `coalesce(nullif(btrim(e.aiark_id), ''), CASE WHEN r.row_key LIKE 'aiark:%' THEN nullif(substr(r.row_key, 7), '') END)`;
// held_people's count (D11, D28): a number, or null when the check has not answered.
const HELD = `(SELECT CASE WHEN jsonb_typeof(h.value -> 'count') = 'number' THEN (h.value ->> 'count')::numeric
                           WHEN h.status = 'empty' THEN 0 END
                FROM enrich_cells h WHERE h.row_id = e.row_id AND h.column_key = 'held_people' AND h.status IN ('done', 'empty'))`;
const TEMPLATE_TABLE = `coalesce($2::uuid, (SELECT t.id FROM enrich_tables t WHERE t.client_tag = $1 AND t.kind = 'companies' AND t.template = 'companies_v2' LIMIT 1))`;
const LOOKED_AT = `EXISTS (SELECT 1 FROM aiark_people_run_companies rc JOIN aiark_people_runs pr ON pr.id = rc.run_id
                            WHERE rc.company_row_id = e.row_id AND pr.source = $3
                              AND (rc.settled_at > now() - make_interval(days => $4) OR pr.status = ANY($5::text[])))`;

/**
 * The companies of a client a people run may look at (2A.6): in its pipeline
 * Companies table, passing the client's rules, not on the never-contact list,
 * not in error, with an AI Ark id, nobody usable already held there (held_people
 * counted 0; skipHeld false takes them too), and not settled for this source
 * within recheckDays nor in a run still going.
 *
 * @param {Db} db
 * @param {{ tag: string, source?: string, recheckDays?: number, tableId?: string | null, skipHeld?: boolean, limit?: number | null }} opts
 * @returns {Promise<Array<{ company_row_id: number, company_id: string }>>}
 */
export async function eligibleCompanies(db, { tag, source = "ai_ark", recheckDays = 90, tableId = null, skipHeld = true, limit = null }) {
  const { rows } = await db.query(
    `SELECT e.row_id::bigint AS company_row_id, x.company_id
       FROM enrich_companies e
       JOIN enrich_rows r ON r.id = e.row_id
       CROSS JOIN LATERAL (SELECT ${COMPANY_ID} AS company_id, ${HELD} AS held) x
      WHERE e.client_tag = $1 AND e.table_id = ${TEMPLATE_TABLE}
        AND coalesce(e.passes, false) AND NOT e.never_contact AND e.outcome <> 'Error'
        AND x.company_id IS NOT NULL
        AND (NOT $6::boolean OR x.held = 0)
        AND NOT ${LOOKED_AT}
      ORDER BY e.row_id
      LIMIT $7`,
    [normTag(tag), tableId, source, recheckDays, ACTIVE, skipHeld, limit ?? 1_000_000]
  );
  return rows.map((r) => ({ company_row_id: Number(r.company_row_id), company_id: String(r.company_id) }));
}

/**
 * What the people panel shows about a client's companies: those a run would
 * take, those skipped because someone usable is held, those looked at
 * recently, those with no AI Ark id, and those passing in all.
 *
 * @param {Db} db
 * @param {{ tag: string, source?: string, recheckDays?: number, tableId?: string | null, skipHeld?: boolean }} opts
 */
export async function eligibilityCounts(db, { tag, source = "ai_ark", recheckDays = 90, tableId = null, skipHeld = true }) {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS passing,
            count(*) FILTER (WHERE x.company_id IS NULL)::int AS no_id,
            count(*) FILTER (WHERE x.company_id IS NOT NULL AND x.held > 0)::int AS held,
            count(*) FILTER (WHERE x.company_id IS NOT NULL AND x.held IS NULL)::int AS not_checked,
            count(*) FILTER (WHERE x.company_id IS NOT NULL AND (NOT $6::boolean OR x.held = 0) AND x.looked)::int AS looked,
            count(*) FILTER (WHERE x.company_id IS NOT NULL AND (NOT $6::boolean OR x.held = 0) AND NOT x.looked)::int AS eligible
       FROM enrich_companies e
       JOIN enrich_rows r ON r.id = e.row_id
       CROSS JOIN LATERAL (SELECT ${COMPANY_ID} AS company_id, ${HELD} AS held, ${LOOKED_AT} AS looked) x
      WHERE e.client_tag = $1 AND e.table_id = ${TEMPLATE_TABLE}
        AND coalesce(e.passes, false) AND NOT e.never_contact AND e.outcome <> 'Error'`,
    [normTag(tag), tableId, source, recheckDays, ACTIVE, skipHeld]
  );
  return { passing: r.passing, eligible: r.eligible, held: r.held, notChecked: r.not_checked, looked: r.looked, noId: r.no_id };
}

/** The client's people run still going (queued, running, or looked and waiting for Buy), or null. */
export async function activePeopleRun(db, tag) {
  const { rows } = await db.query(
    `SELECT id, status FROM aiark_people_runs WHERE client_tag = $1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1`,
    [normTag(tag), ACTIVE]
  );
  return rows[0] ?? null;
}

// ── Creating a run (POST /api/companies/people/runs, inside its transaction) ──

/**
 * Makes the client's three pipeline tables ready (ensurePipelineTables: 409s
 * RetiredV1Table and OriginalsMissing), takes the eligible companies in
 * batches of ids_per_search, and queues the run with its two sources (People
 * rows bought, and People rows copied free from the registry). One run per
 * client: the advisory lock, then a check for a run still going.
 *
 * Throws PeopleRunRefused for a reason the route answers 409.
 *
 * A LinkedIn people run (a source that looks by area) is made by
 * createLinkedinPeopleRun (linkedin-people.mjs): refused unless LinkedIn
 * people runs are on for the client, with a run of any source going, when
 * `version` (the LinkedIn settings' version the page loaded) is no longer
 * current (PeopleRunRefused with changed), or with a plan blocker.
 *
 * @param {Db} db  a client inside the caller's transaction
 * @param {{ tag: string, mode: "live" | "demo", source?: string, maxPeople?: number | null, createdBy?: string | null,
 *           settings?: import("../enrich/settings.mjs").PipelineSettings | null, version?: string | null,
 *           ensureTables?: typeof ensurePipelineTables }} opts
 *   ensureTables: tests only, a stand-in for ensurePipelineTables
 * @returns {Promise<Record<string, any>>} the aiark_people_runs row
 */
export async function createPeopleRun(db, { tag, mode, source = "ai_ark", maxPeople = null, createdBy = null, settings = null, version = null, ensureTables = ensurePipelineTables }) {
  const t = normTag(tag);
  if (!t) throw new PeopleRunRefused("No client tag");
  if (mode !== "live" && mode !== "demo") throw new PeopleRunRefused("mode must be live or demo");
  const sourceInfo = peopleSourceInfo(source);
  if (!sourceInfo) throw new PeopleRunRefused(`No people source "${source}"`);
  const s = settings ?? settingsFrom((await db.query(`SELECT key, value FROM enrich_settings`)).rows);
  if (sourceInfo.look === "by_area") return createLinkedinPeopleRun(db, { tag: t, mode, source, maxPeople, createdBy, settings: s, version, ensureTables }, KIT);
  const pp = s.people_pipeline;
  if (!pp.enabled) throw new PeopleRunRefused("People runs are off, so nothing was started.");
  if (!s.flagOn("people_pipeline", t)) throw new PeopleRunRefused(`${t} is not on the people runs' client list, so nothing was started.`);
  if (!s.people_tracks) {
    throw new PeopleRunRefused("The people tracks are not loaded: they come from the Clay originals (the seed script writes enrich_settings.people_tracks).");
  }
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('aiark-people-run:' || $1))`, [t]);
  const going = await activePeopleRun(db, t);
  if (going) throw new PeopleRunRefused(`${t} already has a people run going (${going.status}). Cancel it or let it finish first.`);
  const tables = await ensureTables(db, t, { settings: s });

  const found = await eligibleCompanies(db, {
    tag: t, source, recheckDays: pp.recheck_days, tableId: tables.companies, skipHeld: pp.skip_company_when_held, limit: COMPANIES_MAX + 1,
  });
  if (!found.length) {
    throw new PeopleRunRefused(`No company of ${t} is ready for a people run: none passes the client's rules with an AI Ark id and nobody usable held, outside those looked at in the last ${pp.recheck_days} days.`);
  }
  const companies = found.slice(0, COMPANIES_MAX);
  const { rows: [client] } = await db.query(`SELECT client_type FROM client_tags WHERE tag = $1`, [t]);
  const { rows: [saved] } = await db.query(`SELECT exclude_titles FROM client_people_filters WHERE client_tag = $1`, [t]);
  const scope = scopeOf(source);
  const excluded = excludedTitlesFor(saved ?? null, client?.client_type ?? null, { scope });
  const cleaning = standardFor(client?.client_type ?? null, scope);
  const ids = pp.ids_per_search;
  const probe = peopleRequestsFor(source, {
    companyIds: companies.slice(0, ids).map((c) => c.company_id), tracks: s.people_tracks, excludeTitles: excluded.titles, cleaning, idsPerSearch: ids,
  });
  if (probe.blockers.length) throw new PeopleRunRefused(probe.blockers.join(" "));
  const size = Math.max(1, Math.min(pp.max_people_per_run, Number.isInteger(maxPeople) && maxPeople > 0 ? maxPeople : pp.max_people_per_run));
  const batches = Math.ceil(companies.length / ids);

  const id = randomUUID();
  const { rows: [bought] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, label, meta, created_by) VALUES ($1, 'ai_ark', $2, $3, $4) RETURNING id`,
    [tables.people, `AI Ark people run${mode === "demo" ? " (made-up people)" : ""}`, JSON.stringify({ people_run_id: id, mode, source, max_people: size }), createdBy]
  );
  const { rows: [copied] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, label, meta, created_by) VALUES ($1, 'registry', $2, $3, $4) RETURNING id`,
    [tables.people, "Copied from earlier runs (no charge)", JSON.stringify({ people_run_id: id, mode, source }), createdBy]
  );
  const filters = {
    source,
    tracks: s.people_tracks,
    exclude_titles: excluded.titles,
    exclude_titles_from: excluded.from,
    cleaning,
    ids_per_search: ids,
    pages_per_search: pp.pages_per_search,
    tries_per_track: pp.tries_per_track,
    skip_company_when_held: pp.skip_company_when_held,
    recheck_days: pp.recheck_days,
    bodies_per_batch: Math.max(1, probe.batches[0]?.bodies.length ?? 1),
    notes: probe.notes,
    variant: tables.variant ?? "default",
    more_companies: found.length > COMPANIES_MAX,
  };
  const { rows: [run] } = await db.query(
    `INSERT INTO aiark_people_runs (id, client_tag, mode, source, companies_table_id, people_table_id, source_id, registry_source_id,
                                    max_people, filters, companies, batches, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
    [id, t, mode, source, tables.companies, tables.people, bought.id, copied.id, size, JSON.stringify(filters), companies.length, batches, createdBy]
  );
  await db.query(
    `INSERT INTO aiark_people_run_companies (run_id, company_row_id, company_id, batch)
     SELECT $1, x.r, x.c, x.b FROM jsonb_to_recordset($2::jsonb) AS x(r bigint, c text, b int)`,
    [id, JSON.stringify(companies.map((c, i) => ({ r: c.company_row_id, c: c.company_id, b: Math.floor(i / ids) })))]
  );
  return run;
}

/**
 * A manager's click on Buy: a run that stopped in "looked" goes on to buy its
 * picks. Null when the run is not waiting for it.
 *
 * @param {Db} db
 * @param {{ runId: string, userId?: string | null }} opts
 */
export async function approveBuy(db, { runId, userId = null }) {
  const { rows } = await db.query(
    `UPDATE aiark_people_runs
        SET status = 'queued', buy_approved_by = $2, buy_approved_at = now(), next_run_at = now(), attempts = 0, last_error = NULL
      WHERE id = $1 AND status = 'looked'
      RETURNING id, client_tag, mode, picked, max_people`,
    [runId, userId]
  );
  return rows[0] ?? null;
}

/**
 * Cancels a run that is queued, running or waiting for Buy: no new paid call.
 * The worker sees it before its next paid call; what was bought is kept and
 * still worked. The run's sources get their counts now. Null when the run was
 * not going.
 *
 * @param {Db} db
 * @param {{ runId: string }} opts
 */
export async function cancelPeopleRun(db, { runId }) {
  const { rows } = await db.query(
    `UPDATE aiark_people_runs SET status = 'cancelled', finished_at = coalesce(finished_at, now())
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING id, client_tag, bought, copied, source_id, registry_source_id`,
    [runId, ACTIVE]
  );
  const r = rows[0];
  if (!r) return null;
  await countSources(db, r);
  return r;
}

async function countSources(db, r) {
  if (r.source_id) {
    await db.query(
      `UPDATE enrich_sources SET received = $2, created = (SELECT count(*)::int FROM enrich_rows WHERE source_id = $1) WHERE id = $1`,
      [r.source_id, Number(r.bought ?? 0)]
    );
  }
  if (r.registry_source_id) {
    await db.query(`UPDATE enrich_sources SET received = $2, created = $2 WHERE id = $1`, [r.registry_source_id, Number(r.copied ?? 0)]);
  }
}

// ── Queue ───────────────────────────────────────────────────────────────────

const HAS_WORK = `q.status IN ('queued', 'running')`;

async function claimRun(pool) {
  const { rows } = await pool.query(
    `UPDATE aiark_people_runs r
        SET claim_token = $1, claimed_at = now(), started_at = coalesce(r.started_at, now()), status = 'running'
      WHERE r.id = (
        SELECT q.id FROM aiark_people_runs q
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

/** Is any people run due now? (The worker's drain-and-exit mode asks.) */
export async function peopleRunDue(pool) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM aiark_people_runs q WHERE ${HAS_WORK} AND q.next_run_at <= now()
                     AND (q.claim_token IS NULL OR q.claimed_at < now() - make_interval(mins => $1))) AS due`,
    [LEASE_MIN]
  );
  return rows[0].due;
}

/** Saves the cursor (fenced). A cancel stops the slice here, before anything more is bought. */
async function savePosition(ctx) {
  const { rows } = await ctx.pool.query(
    `UPDATE aiark_people_runs SET progress = $3, claimed_at = now() WHERE id = $1 AND claim_token = $2 RETURNING status`,
    [ctx.run.id, ctx.run.claim_token, ctx.progress]
  );
  if (!rows[0]) throw new LostClaim();
  if (rows[0].status === "cancelled") throw new Cancelled();
}

async function release(ctx, { inMs = 0, attempts = 0, lastError = null } = {}) {
  await ctx.pool.query(
    `UPDATE aiark_people_runs SET claim_token = NULL, claimed_at = NULL, progress = $3, attempts = $4, last_error = $5,
            next_run_at = now() + make_interval(secs => $6)
      WHERE id = $1 AND claim_token = $2`,
    [ctx.run.id, ctx.run.claim_token, ctx.progress, attempts, lastError, inMs / 1000]
  );
}

/** Stops in "looked": the Look is done and its picks wait for a manager's Buy. */
async function pause(ctx) {
  await ctx.pool.query(
    `UPDATE aiark_people_runs SET status = CASE WHEN status = 'running' THEN 'looked' ELSE status END,
            claim_token = NULL, claimed_at = NULL, progress = $3, attempts = 0, last_error = NULL
      WHERE id = $1 AND claim_token = $2`,
    [ctx.run.id, ctx.run.claim_token, ctx.progress]
  );
  ctx.log?.(`AI Ark people run ${ctx.run.id.slice(0, 8)}: looked, waiting for Buy`);
}

/** Ends the run. A cancelled run stays cancelled. Its sources get their counts. */
async function finish(ctx, { status, stopReason = null, lastError = null }) {
  let creditsAfter = null;
  try {
    if (!ctx.shouldStop()) creditsAfter = await ctx.client.credits();
  } catch {
    /* the balance is a nicety; never fail a finish over it */
  }
  ctx.progress = { ...ctx.progress, buying: null };
  const { rows } = await ctx.pool.query(
    `UPDATE aiark_people_runs
        SET status = CASE WHEN status = 'running' THEN $3 ELSE status END,
            stop_reason = coalesce($4, stop_reason),
            last_error = CASE WHEN $3 IN ('done', 'stopped') THEN $5 ELSE coalesce($5, last_error) END,
            progress = $6, credits_after = coalesce($7, credits_after),
            finished_at = coalesce(finished_at, now()), claim_token = NULL, claimed_at = NULL
      WHERE id = $1 AND claim_token = $2
      RETURNING status, bought, copied, source_id, registry_source_id`,
    [ctx.run.id, ctx.run.claim_token, status, stopReason, lastError, ctx.progress, creditsAfter]
  );
  if (rows[0]) await countSources(ctx.pool, rows[0]);
  ctx.log?.(`AI Ark people run ${ctx.run.id.slice(0, 8)}: ${rows[0]?.status ?? "?"}${stopReason ? `: ${stopReason}` : ""}${lastError ? ` (${lastError})` : ""}`);
  return rows[0]?.status;
}

// ── Before every paid call ──────────────────────────────────────────────────

/**
 * Whether another run holds an AI Ark tab export job of this mode that is not
 * read yet: its people reach the registry only when it is read, so until then
 * a buy here could pay for someone that job also returns.
 */
async function tabExportUnread(pool, mode) {
  const { rows: [r] } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM aiark_runs q
                     WHERE q.mode = $1 AND jsonb_typeof(q.progress->'job') = 'object'
                       AND (q.status IN ('queued', 'running') OR (q.status = 'cancelled' AND q.finished_at IS NULL))) AS busy`,
    [mode]
  );
  return r.busy === true;
}

/**
 * The checks before a paid call of `price` credits: the switch, the tab's
 * unread export, the brake, and AI Ark's balance against min_balance (read
 * free once a slice, then counted down here). Answers what the slice returns
 * instead of calling, or null to go ahead.
 */
async function beforePaidCall(ctx, price) {
  const { run, settings } = ctx;
  if (byArea(run) && !settings.flagOn("linkedin_people", run.client_tag)) {
    return { stop: `LinkedIn people runs were switched off for ${run.client_tag}, so nothing more was bought.` };
  }
  if (!settings.flagOn("people_pipeline", run.client_tag)) {
    return { stop: `People runs were switched off for ${run.client_tag}, so nothing more was bought.` };
  }
  if (await tabExportUnread(ctx.pool, run.mode)) return { wait: OTHER_JOB_WAIT_MS, hold: true };
  const spent = spentOf(ctx);
  if (spent + price > peopleSpendCeiling(run) + 1e-9) return { stop: brakeReason(run, spent) };
  if (ctx.balance == null) ctx.balance = await ctx.client.credits();
  const floor = settings.people_pipeline.min_balance;
  if (ctx.balance - price < floor) {
    return { stop: `AI Ark's balance (${fmt(ctx.balance)} credits) is at the people runs' minimum of ${fmt(floor)}, so nothing more was bought.` };
  }
  ctx.balance -= price;
  return null;
}

// ── 1. Look ─────────────────────────────────────────────────────────────────

/** The companies of one batch, with what the screen and the People rows need from each company row. */
async function batchCompanies(ctx, batch) {
  const { rows } = await ctx.pool.query(
    `SELECT rc.company_row_id::bigint AS company_row_id, rc.company_id, e.company AS name, e.domain, e.website, e.industry,
            (SELECT jsonb_object_agg(c.column_key, c.value) FROM enrich_cells c
              WHERE c.row_id = rc.company_row_id AND c.column_key IN ('company', 'use_domain', 'use_website', 'domain', 'website', 'industry', 'description')) AS cells
       FROM aiark_people_run_companies rc
       LEFT JOIN enrich_companies e ON e.row_id = rc.company_row_id
      WHERE rc.run_id = $1 AND rc.batch = $2
      ORDER BY rc.company_row_id`,
    [ctx.run.id, batch]
  );
  return rows.map((r) => {
    const cell = (k) => {
      const v = r.cells?.[k];
      return v == null || typeof v === "object" ? "" : text(v);
    };
    return {
      company_row_id: Number(r.company_row_id),
      company_id: String(r.company_id),
      name: cell("company") || text(r.name),
      domain: bareDomain(cell("use_domain")) ?? bareDomain(cell("domain")) ?? bareDomain(r.domain) ?? "",
      website: cell("use_website") || text(r.website),
      industry: cell("industry") || text(r.industry),
      description: cell("description"),
    };
  });
}

/** One AI Ark person's facts, as a Preview (or an Export Single answer) gives them. */
function factsOf(p) {
  const prof = p?.profile ?? p?.summary ?? {};
  const loc = p?.location ?? {};
  const dep = p?.department ?? {};
  const co = p?.company ?? {};
  return {
    person_id: text(p?.id),
    company_id: text(co.id),
    company: text(co.summary?.name ?? co.name),
    industry: text(co.summary?.industry),
    description: clip(text(co.summary?.description), 2_000),
    first_name: text(prof.first_name),
    last_name: text(prof.last_name),
    title: text(prof.title),
    city: text(loc.city),
    region: text(loc.state).replace(/\s+metropolitan area$/i, ""),
    country: text(loc.country),
    seniority: text(dep.seniority),
    department: (Array.isArray(dep.departments) ? dep.departments : []).slice(0, 3).join(", "),
  };
}

/** Runs fn over items, `threads` at a time, in order. */
async function mapLimit(items, threads, fn) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(threads, items.length) }, lane));
  return out;
}

/**
 * The screen, free, with the People template's own checks (client-checks.mjs):
 * the database by name and company (a Preview has no email, so lead_lookup's
 * name check, with the masked last name), the person's own place, the
 * client's exclusions on the company and the title, then the track, then the
 * registry. The first that applies is the verdict.
 */
async function screenOne(ctx, f, company) {
  const db = ctx.pool;
  const table = { client_tag: ctx.run.client_tag };
  const look = await CLIENT_ACTIONS.lead_lookup.run({
    inputs: { email: "", verdict: "Not found", first_name: f.first_name, last_name: f.last_name, full_name: "", company: f.company || company.name, domain: company.domain },
    db,
  });
  if (look.status === "error") throw new CheckFailed(`The database check failed: ${look.note ?? "no details"}`);
  const held = look.status === "done" ? look.value : null;
  if (held?.never_contact) return { verdict: "never_contact", held_lead_id: held.lead_id ?? null };
  if (held?.bounced) return { verdict: "bounced", held_lead_id: held.lead_id ?? null };
  if (held && (held.lead_id || held.in_bison)) return { verdict: "held", held_lead_id: held.lead_id ?? null };
  const area = await CLIENT_ACTIONS.client_area.run({ inputs: { city: f.city, state: f.region, country: f.country }, table, row: null, db });
  if (area.status === "error") throw new CheckFailed(`The client's area could not be checked: ${area.note ?? "no details"}`);
  if (area.value === false) return { verdict: "outside" };
  const rules = await CLIENT_ACTIONS.client_exclusions.run({
    inputs: { company: f.company || company.name, industry: f.industry || company.industry, description: f.description || company.description, title: f.title },
    table, row: null, db,
  });
  if (rules.status === "error") throw new CheckFailed(`The client's exclusions could not be checked: ${rules.note ?? "no details"}`);
  if (rules.status === "done" && rules.value) return { verdict: "excluded" };
  return { verdict: "candidate" };
}

/**
 * A People row's input cells (PEOPLE_INPUTS) for an AI Ark person: the source
 * object P#1's place holds, the email, the written city and state (D13: an AI
 * Ark person's own place; a LinkedIn person's office, passed as `written`),
 * who found them (found_by: "aiark", or "linkedin") and the run's own facts.
 * Every value is text except the source object.
 */
export function personRowCells({
  tag, company, track, rank, person, email = "", emailStatus = "", domainType = "", stage, source, pulledBefore = "", foundBy = "aiark", written = null,
}) {
  const so = sourceObject(person);
  const f = factsOf(person);
  const values = {
    find_people_from_linkedin_company_url: so,
    email: text(email).toLowerCase(),
    client_tag: normTag(tag),
    company_website: text(company.website),
    written_city: written ? text(written.city) : f.city,
    written_state: written ? text(written.state) : f.region,
    company_row: String(company.company_row_id),
    company_aiark_id: company.company_id,
    person_aiark_id: f.person_id,
    found_by: foundBy,
    stage,
    track: track ?? "",
    rank: Number.isInteger(rank) ? String(rank) : "",
    person_first_name: f.first_name,
    person_last_name: f.last_name,
    seniority: f.seniority,
    department: f.department,
    person_city: f.city,
    person_state: f.region,
    person_country: f.country,
    aiark_email_status: text(emailStatus),
    aiark_email_domain_type: text(domainType),
    pulled_before: text(pulledBefore),
    source,
  };
  const keys = new Set(PEOPLE_INPUT_KEYS);
  const cells = {};
  for (const [k, v] of Object.entries(values)) {
    if (!keys.has(k)) continue;
    if (k === "find_people_from_linkedin_company_url") cells[k] = v;
    else if (v) cells[k] = clip(String(v).replace(/\u0000/g, ""), 5_000);
  }
  const search = clip([so.name, so.latest_experience_title, so.latest_experience_company, cells.email, f.city, f.region].filter(Boolean).join(" ").toLowerCase(), 2_000);
  return { cells, search };
}

/** A Preview-shaped record from what a candidate row and its company hold (a no-email buy, or a copy's fallback). */
function recordOf(c, company) {
  return {
    id: c.person_id,
    profile: { first_name: c.first_name ?? "", last_name: c.last_name ?? "", title: c.title ?? "" },
    company: { id: c.company_id, summary: { name: company.name || null, industry: company.industry || null }, link: { domain: company.domain || null } },
    location: { city: c.city ?? "", state: c.region ?? "", country: c.country ?? "" },
    department: { seniority: c.seniority ?? "", departments: c.department ? String(c.department).split(", ") : [] },
  };
}

/** Text with no lone half of a surrogate pair and no NUL, which Postgres refuses inside jsonb. */
function sane(v) {
  if (typeof v === "string") return v.toWellFormed().replace(/\u0000/g, "");
  if (Array.isArray(v)) return v.map(sane);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sane(x)]));
  return v;
}
/** Only printable ASCII: what is kept when Postgres refuses a person's values. */
const plainOf = (v) => JSON.parse(JSON.stringify(v).replace(/[^\x20-\x7e]/g, "?"));

const REGISTRY_FIELDS = `person_id, run_id, people_run_id, row_id, email, email_status, record, pulled_at`;

/** The registry rows (aiark_people) of these people, by person id: anyone any run has bought. Free. */
async function registryOf(pool, ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(`SELECT ${REGISTRY_FIELDS} FROM aiark_people WHERE person_id = ANY($1::text[])`, [ids]);
  return new Map(rows.map((r) => [r.person_id, r]));
}

/** The AI Ark tab rows' own name, LinkedIn and title cells, for registry rows with no record (the tab's purchases). */
async function tabCellsOf(pool, rowIds) {
  const out = new Map();
  if (!rowIds.length) return out;
  const { rows } = await pool.query(
    `SELECT row_id, jsonb_object_agg(column_key, value) AS cells FROM enrich_cells
      WHERE row_id = ANY($1::bigint[]) AND column_key IN ('full_name', 'first_name', 'last_name', 'linkedin', 'title', 'email_domain_type')
      GROUP BY row_id`,
    [rowIds]
  );
  for (const r of rows) out.set(Number(r.row_id), r.cells ?? {});
  return out;
}

/** The tab rows a set of registry rows needs read: those with an email and no record. */
const tabRowsOf = (regs) => [...new Set(regs.filter((r) => r && !r.record && r.row_id && r.email).map((r) => Number(r.row_id)))];

/**
 * A free copy of a person another run bought with an email (D27), as the
 * People row's input cells: the registry's record, else (the AI Ark tab's
 * purchases keep none) the tab row's own name, LinkedIn URL and title, so no
 * masked name is copied. `p` is the person as the Look saw them (factsOf, or a
 * candidate row).
 */
function copyOf(ctx, { p, company, track, rank, reg, tab }) {
  let record = reg.record;
  if (!record) {
    const c = tab ?? {};
    const v = (k) => (typeof c[k] === "string" ? c[k] : "");
    record = {
      ...recordOf(p, company),
      profile: { full_name: v("full_name"), first_name: v("first_name") || p.first_name || "", last_name: v("last_name"), title: v("title") || p.title || "" },
      link: { linkedin: v("linkedin") },
      email: { state: "DONE", output: [{ address: reg.email, status: reg.email_status === "VALID" ? "VALID" : "INVALID", domainType: v("email_domain_type") }] },
    };
  }
  const inputs = personInputs(record);
  const when = new Date(reg.pulled_at).toISOString().slice(0, 10);
  const { cells, search } = personRowCells({
    tag: ctx.run.client_tag, company, track, rank, person: record,
    email: reg.email, emailStatus: reg.email_status ?? inputs.email_status ?? "", domainType: inputs.email_domain_type ?? "",
    stage: "copied", source: "Copied from an earlier run (no charge)",
    pulledBefore: `Bought ${when}${reg.people_run_id ? ` (people run ${String(reg.people_run_id).slice(0, 6)})` : reg.run_id ? ` (AI Ark run ${String(reg.run_id).slice(0, 6)})` : ""}`,
  });
  return { person_id: p.person_id, row_key: aiarkPersonRowKey(p.person_id), search, cells };
}

/** Screens one Preview page: the candidates' rows, and the registry copies (D27). */
async function screenPage(ctx, people, companies) {
  const byCompany = new Map(companies.map((c) => [c.company_id, c]));
  const facts = people.map(factsOf).filter((f) => f.person_id && byCompany.has(f.company_id));
  const registry = await registryOf(ctx.pool, facts.map((f) => f.person_id));
  const tracks = ctx.run.filters.tracks;
  const screened = await mapLimit(facts, SCREEN_THREADS, async (f) => {
    const company = byCompany.get(f.company_id);
    const found = trackOf(f.title, tracks);
    let { verdict, held_lead_id = null } = await screenOne(ctx, f, company);
    if (verdict === "candidate" && !found) verdict = "no_track";
    if (verdict === "candidate" && registry.has(f.person_id)) verdict = "bought_before";
    return { f, company, verdict, held_lead_id, track: found?.track ?? null, rank: found?.rank ?? null };
  });
  const tabCells = await tabCellsOf(ctx.pool, tabRowsOf(screened.filter((x) => x.verdict === "bought_before").map((x) => registry.get(x.f.person_id))));

  const candidates = [];
  const copies = [];
  for (const x of screened) {
    const { f, company } = x;
    candidates.push({
      person_id: f.person_id, company_row_id: company.company_row_id, company_id: company.company_id,
      first_name: f.first_name || null, last_name: f.last_name || null, title: f.title || null, city: f.city || null,
      region: f.region || null, country: f.country || null, seniority: f.seniority || null, department: f.department || null,
      track: x.track, rank: x.rank, verdict: x.verdict, held_lead_id: x.held_lead_id,
    });
    if (x.verdict !== "bought_before") continue;
    const reg = registry.get(f.person_id);
    if (!reg?.email) continue; // a person bought with no email is not copied (D27)
    copies.push(copyOf(ctx, { p: f, company, track: x.track, rank: x.rank, reg, tab: tabCells.get(Number(reg.row_id)) }));
  }
  return { candidates, copies, skipped: people.length - facts.length };
}

const LOOK_SQL = `
  WITH st AS (
    SELECT status, claim_token = $2 AS held, (progress->>'last_page') IS NOT DISTINCT FROM $3::text AS repeat
      FROM aiark_people_runs WHERE id = $1 FOR UPDATE
  ), cx AS (
    SELECT * FROM jsonb_to_recordset($5::jsonb) AS x(person_id text, row_key text, search text, cells jsonb)
  ), r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text)
    SELECT $6::uuid, $7::uuid, cx.row_key, cx.search FROM cx
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id, row_key
  ), c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $6::uuid, 'done', kv.value,
           left(CASE WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}' ELSE coalesce(kv.value ->> 'name', kv.value::text) END, 300)
      FROM r JOIN cx ON cx.row_key = r.row_key CROSS JOIN LATERAL jsonb_each(cx.cells) AS kv
    RETURNING 1
  ), rowids AS (
    SELECT cx.person_id, coalesce(r.id, er.id) AS row_id
      FROM cx LEFT JOIN r ON r.row_key = cx.row_key
      LEFT JOIN enrich_rows er ON er.table_id = $6::uuid AND er.row_key = cx.row_key
  ), cand AS (
    INSERT INTO aiark_people_candidates (run_id, person_id, company_row_id, company_id, first_name, last_name, title, city, region, country,
                                         seniority, department, track, rank, verdict, held_lead_id, row_id)
    SELECT $1, x.person_id, x.company_row_id, x.company_id, x.first_name, x.last_name, x.title, x.city, x.region, x.country,
           x.seniority, x.department, x.track, x.rank, x.verdict, x.held_lead_id, ri.row_id
      FROM jsonb_to_recordset($4::jsonb) AS x(person_id text, company_row_id bigint, company_id text, first_name text, last_name text,
           title text, city text, region text, country text, seniority text, department text, track text, rank smallint,
           verdict text, held_lead_id uuid)
      LEFT JOIN rowids ri ON ri.person_id = x.person_id
    ON CONFLICT (run_id, person_id) DO NOTHING
    RETURNING person_id
  ), u AS (
    UPDATE aiark_people_runs q
       SET pages = q.pages + CASE WHEN (SELECT repeat FROM st) THEN 0 ELSE 1 END,
           looked = q.looked + (SELECT count(*) FROM cand)::int,
           copied = q.copied + (SELECT count(*) FROM r)::int,
           credits_used = q.credits_used + CASE WHEN (SELECT repeat FROM st) THEN 0 ELSE $8::numeric END,
           progress = CASE WHEN (SELECT held FROM st) THEN $9::jsonb ELSE q.progress END,
           claimed_at = CASE WHEN q.claim_token = $2 THEN now() ELSE q.claimed_at END
     WHERE q.id = $1
    RETURNING q.credits_used
  )
  SELECT (SELECT held FROM st) AS held, (SELECT status FROM st) AS status, (SELECT count(*) FROM cand)::int AS looked,
         (SELECT count(*) FROM r)::int AS copied, (SELECT credits_used::float8 FROM u) AS used`;

/**
 * A Look page into the run, in one statement: its candidates, the registry
 * copies with their cells, the run's counters and cursor. Everything is
 * written even if the claim was lost (the page is paid for); the cursor moves
 * only while the claim is held, and the page's credit counts once (pageId).
 * A value Postgres refuses (SQLSTATE class 22) is refused every time: the
 * page then goes in with plain text only. A write that can't be made reads
 * the run back, so what is released is what the database holds.
 */
async function writeLookPage(ctx, { candidates, copies, pageId, progress, credits }) {
  let plain = false;
  for (let tries = 0; ; tries++) {
    try {
      const cand = plain ? plainOf(candidates) : sane(candidates);
      const cop = plain ? plainOf(copies) : sane(copies);
      const { rows: [r] } = await ctx.pool.query(LOOK_SQL, [
        ctx.run.id, ctx.run.claim_token, pageId, JSON.stringify(cand), JSON.stringify(cop), ctx.run.people_table_id,
        ctx.run.registry_source_id, credits, JSON.stringify(progress),
      ]);
      ctx.spent = r.used;
      if (!r.held) throw new LostClaim();
      ctx.progress = progress;
      if (r.status === "cancelled") throw new Cancelled();
      return r;
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
      await readBack(ctx, e);
      throw e;
    }
  }
}

/** After a write that failed for good: the run's row as the database holds it. */
async function readBack(ctx, e) {
  let row;
  try {
    ({ rows: [row] } = await ctx.pool.query(
      `SELECT progress, credits_used::float8 AS used, bought FROM aiark_people_runs WHERE id = $1 AND claim_token = $2`,
      [ctx.run.id, ctx.run.claim_token]
    ));
  } catch {
    throw new Unread(String(e?.message ?? e));
  }
  if (!row) throw new LostClaim();
  ctx.progress = row.progress ?? {};
  ctx.spent = row.used;
  ctx.run.bought = row.bought;
}

/**
 * AI Ark refused the batch's request as too large (a free 400): the second
 * half of its companies becomes a new batch at the end, and the batch is
 * asked again. One company too many to send is an error.
 */
async function halveBatch(ctx, batch, companies, err) {
  if (companies.length <= 1) return { fail: `AI Ark refused the request as too large even for one company (${err.message})` };
  const keep = Math.ceil(companies.length / 2);
  const moved = companies.slice(keep).map((c) => c.company_row_id);
  const next = { ...ctx.progress, body: 0, page: 0, halvings: Number(ctx.progress.halvings ?? 0) + 1, last_halving: err.message };
  const c = await ctx.pool.connect();
  try {
    await c.query("BEGIN");
    const { rows: [run] } = await c.query(
      `SELECT batches FROM aiark_people_runs WHERE id = $1 AND claim_token = $2 FOR UPDATE`,
      [ctx.run.id, ctx.run.claim_token]
    );
    if (!run) throw new LostClaim();
    await c.query(
      `UPDATE aiark_people_run_companies SET batch = $3 WHERE run_id = $1 AND batch = $2 AND company_row_id = ANY($4::bigint[])`,
      [ctx.run.id, batch, run.batches, moved]
    );
    await c.query(`UPDATE aiark_people_runs SET batches = batches + 1, progress = $2, claimed_at = now() WHERE id = $1`, [ctx.run.id, next]);
    await c.query("COMMIT");
    ctx.run.batches = run.batches + 1;
    ctx.progress = next;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  ctx.log?.(`AI Ark people run ${ctx.run.id.slice(0, 8)}: batch ${batch} refused as too large, halved to ${keep} companies`);
  return { more: true };
}

async function sliceLook(ctx) {
  const { run } = ctx;
  const f = run.filters;
  const p = ctx.progress;
  const batch = p.batch ?? 0;
  if (batch >= run.batches) {
    ctx.progress = { ...p, look_done: true, looked_at: new Date().toISOString() };
    await savePosition(ctx);
    return { more: true };
  }
  const companies = await batchCompanies(ctx, batch);
  const req = companies.length
    ? peopleRequestsFor(run.source, { companyIds: companies.map((c) => c.company_id), tracks: f.tracks, excludeTitles: f.exclude_titles, cleaning: f.cleaning, idsPerSearch: companies.length })
    : { bodies: [], blockers: [] };
  if (req.blockers.length) return { fail: req.blockers.join(" ") };
  const body = p.body ?? 0;
  if (body >= req.bodies.length) {
    // The batch is looked at: pick it, then on to the next.
    if (companies.length) await pickBatch(ctx, batch);
    ctx.progress = { ...ctx.progress, batch: batch + 1, body: 0, page: 0 };
    await savePosition(ctx);
    return { more: true };
  }
  const page = p.page ?? 0;
  if (page >= f.pages_per_search || (page + 1) * PAGE_MAX > SEARCH_CAP) {
    // More people than a batch may look at: the rest are not looked at (R24).
    ctx.progress = { ...p, body: body + 1, page: 0, capped: [...new Set([...(p.capped ?? []), batch])] };
    await savePosition(ctx);
    return { more: true };
  }
  const gate = await beforePaidCall(ctx, 1);
  if (gate) return gate;
  await savePosition(ctx); // a cancel is seen here, before the page is bought

  let res;
  try {
    res = await ctx.client.preview(req.bodies[body], { page, size: PAGE_MAX });
  } catch (e) {
    if (e instanceof AiArkError && e.kind === "bad_request" && /request size/i.test(e.message)) {
      ctx.balance = ctx.balance == null ? null : ctx.balance + 1; // a refusal is free
      return halveBatch(ctx, batch, companies, e);
    }
    if (e instanceof AiArkError && (e.kind === "network" || e.kind === "server")) {
      // The answer is gone and AI Ark may have charged for the page.
      const lost = Number(p.lost_in_row ?? 0) + 1;
      ctx.progress = { ...p, lost_in_row: lost, lost_pages: Number(p.lost_pages ?? 0) + 1, lost_credits: round2(Number(p.lost_credits ?? 0) + 1) };
      if (lost >= LOST_PAGES_MAX) return { stop: `AI Ark's answer was lost ${lost} times in a row (${e.message}). Each of those pages may have been charged, so the run stopped.` };
      return { error: e };
    }
    throw e;
  }

  const people = res.content.filter((x) => x && typeof x === "object" && x.id);
  const shot = await screenPage(ctx, people, companies);
  const lastPage = !res.content.length || res.content.length < PAGE_MAX || (page + 1) * PAGE_MAX >= res.totalElements;
  const pageId = randomUUID();
  const next = {
    ...ctx.progress,
    lost_in_row: 0,
    matches: { ...(ctx.progress.matches ?? {}), [`${batch}.${body}`]: res.totalElements },
    other_company: Number(ctx.progress.other_company ?? 0) + shot.skipped,
    ...(lastPage ? { body: body + 1, page: 0 } : { page: page + 1 }),
    last_page: pageId,
  };
  await writeLookPage(ctx, { candidates: shot.candidates, copies: shot.copies, pageId, progress: next, credits: 1 });
  return { more: true };
}

// ── 2. Pick ─────────────────────────────────────────────────────────────────

const OPEN_TRACKS = JSON.stringify(Object.fromEntries(TRACKS.map((t) => [t, { tried: 0, found: false, settled: false }])));
const HELD_TRACKS = JSON.stringify(Object.fromEntries(TRACKS.map((t) => [t, { tried: 0, found: true, settled: true }])));

/**
 * One batch's picks, in one transaction fenced on the claim: the companies
 * where anyone was screened "held" are skipped whole (D11, while
 * skip_company_when_held); per company and track, the best-ranked candidate
 * not covered by a registry copy is picked and the next ones kept in reserve,
 * up to tries_per_track (the agreed order is the tracks' own: each track is
 * picked for itself).
 */
async function pickBatch(ctx, batch) {
  const { run } = ctx;
  const f = run.filters;
  const c = await ctx.pool.connect();
  let skippedRows = [];
  try {
    await c.query("BEGIN");
    const { rows: [held] } = await c.query(`SELECT 1 FROM aiark_people_runs WHERE id = $1 AND claim_token = $2 FOR UPDATE`, [run.id, run.claim_token]);
    if (!held) throw new LostClaim();
    ({ rows: skippedRows } = await c.query(
      `UPDATE aiark_people_run_companies rc
          SET state = 'skipped_held', looked_at = coalesce(rc.looked_at, now()), settled_at = now(), tracks = $3::jsonb
        WHERE rc.run_id = $1 AND rc.batch = $2 AND rc.state = 'waiting' AND $4::boolean
          AND EXISTS (SELECT 1 FROM aiark_people_candidates h
                       WHERE h.run_id = rc.run_id AND h.company_row_id = rc.company_row_id AND h.verdict = 'held')
       RETURNING rc.company_row_id::bigint AS company_row_id`,
      [run.id, batch, HELD_TRACKS, f.skip_company_when_held !== false]
    ));
    const skipped = skippedRows.length;
    const { rows: picks } = await c.query(
      `WITH ranked AS (
         SELECT c.person_id,
                row_number() OVER (PARTITION BY c.company_row_id, c.track ORDER BY c.rank, c.person_id) AS n
           FROM aiark_people_candidates c
           JOIN aiark_people_run_companies rc ON rc.run_id = c.run_id AND rc.company_row_id = c.company_row_id
          WHERE c.run_id = $1 AND rc.batch = $2 AND rc.state = 'waiting' AND c.verdict = 'candidate' AND c.pick = 'none'
            AND NOT EXISTS (SELECT 1 FROM aiark_people_candidates b
                             WHERE b.run_id = c.run_id AND b.company_row_id = c.company_row_id AND b.track = c.track
                               AND b.verdict = 'bought_before' AND b.row_id IS NOT NULL)
       )
       UPDATE aiark_people_candidates x SET pick = CASE WHEN r.n = 1 THEN 'picked' ELSE 'reserve' END
         FROM ranked r
        WHERE x.run_id = $1 AND x.person_id = r.person_id AND r.n <= $3
       RETURNING x.company_row_id, x.pick`,
      [run.id, batch, Math.max(1, Number(f.tries_per_track) || 1)]
    );
    await c.query(
      `UPDATE aiark_people_run_companies rc
          SET state = CASE WHEN n.picked > 0 THEN 'picked' ELSE 'looked' END, looked_at = coalesce(rc.looked_at, now()),
              picked = n.picked, tracks = $3::jsonb
         FROM (SELECT x.company_row_id,
                      (SELECT count(*)::int FROM aiark_people_candidates k
                        WHERE k.run_id = x.run_id AND k.company_row_id = x.company_row_id AND k.pick = 'picked') AS picked
                 FROM aiark_people_run_companies x WHERE x.run_id = $1 AND x.batch = $2 AND x.state = 'waiting') n
        WHERE rc.run_id = $1 AND rc.company_row_id = n.company_row_id`,
      [run.id, batch, OPEN_TRACKS]
    );
    const picked = picks.filter((x) => x.pick === "picked").length;
    await c.query(`UPDATE aiark_people_runs SET picked = picked + $2, skipped_held = skipped_held + $3, claimed_at = now() WHERE id = $1`, [run.id, picked, skipped]);
    await c.query("COMMIT");
    ctx.run.picked = Number(ctx.run.picked) + picked;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
  // A company skipped because someone is held is settled now: its row is worked again, so people_at_company says so.
  if (skippedRows.length) {
    await ctx.pool.query(`UPDATE enrich_companies SET people_settled_at = now() WHERE row_id = ANY($1::bigint[])`, [skippedRows.map((x) => Number(x.company_row_id))]);
    ctx.progress = { ...ctx.progress, requeue: [...new Set([...(ctx.progress.requeue ?? []), ...skippedRows.map((x) => Number(x.company_row_id))])] };
    await requeueCompanies(ctx);
  }
}

// ── 4. Buy, 5. Settle ───────────────────────────────────────────────────────

/**
 * Where each unsettled company's tracks stand, and which settle now. A track
 * is settled when none of its People rows (from this run: bought or copied) is
 * queued or running, and it has a person found (usable, or waiting for
 * Enrichley), a row waiting on a key (no more is bought for it), used its
 * tries, or no candidate left. A track that could still buy but the run may
 * not (its most people bought) stays open.
 */
async function settle(ctx, { canBuy }) {
  const { run, pool } = ctx;
  const tries = Math.max(1, Number(run.filters.tries_per_track) || 1);
  const { rows: entries } = await pool.query(
    `SELECT company_row_id::bigint AS company_row_id, state, tracks FROM aiark_people_run_companies
      WHERE run_id = $1 AND state IN ('looked', 'picked', 'buying') ORDER BY company_row_id LIMIT $2`,
    [run.id, SETTLE_CHUNK]
  );
  const open = [];
  let busy = 0;
  if (!entries.length) return { unsettled: 0, open, busy };
  const ids = entries.map((e) => Number(e.company_row_id));
  const { rows: per } = await pool.query(
    `SELECT c.company_row_id::bigint AS company_row_id, c.track,
            count(*) FILTER (WHERE c.pick IN ('bought', 'no_email', 'lost'))::int AS tried,
            count(*) FILTER (WHERE c.pick IN ('picked', 'reserve'))::int AS remaining,
            coalesce(bool_or(r.run_status IN ('queued', 'running')), false) AS busy,
            coalesce(bool_or(r.run_status = 'waiting'), false) AS waiting
       FROM aiark_people_candidates c
       LEFT JOIN enrich_rows r ON r.id = c.row_id
      WHERE c.run_id = $1 AND c.company_row_id = ANY($2::bigint[]) AND c.track IS NOT NULL
      GROUP BY 1, 2`,
    [run.id, ids]
  );
  const { rows: found } = await pool.query(
    `SELECT company_row_id::bigint AS company_row_id, track FROM enrich_contacts
      WHERE company_row_id = ANY($1::bigint[]) AND kind = 'person' AND track IS NOT NULL AND (usable OR verdict = 'enrichley')
      GROUP BY 1, 2`,
    [ids]
  );
  const key = (row, t) => `${row}|${t}`;
  const stats = new Map(per.map((x) => [key(x.company_row_id, x.track), x]));
  const foundSet = new Set(found.map((x) => key(x.company_row_id, x.track)));
  const settledNow = [];
  const changed = [];
  for (const e of entries) {
    const row = Number(e.company_row_id);
    const tracks = {};
    let all = true;
    for (const t of TRACKS) {
      const s = stats.get(key(row, t)) ?? { tried: 0, remaining: 0, busy: false, waiting: false };
      const isFound = foundSet.has(key(row, t));
      const done = !s.busy && (isFound || s.waiting || s.tried >= tries || s.remaining === 0);
      tracks[t] = { tried: s.tried, found: isFound, settled: done };
      if (!done) {
        all = false;
        if (s.busy) busy++;
        else if (canBuy) open.push({ company_row_id: row, track: t });
      }
    }
    if (all) settledNow.push({ cr: row, tracks });
    else if (JSON.stringify(tracks) !== JSON.stringify(e.tracks ?? {})) changed.push({ cr: row, tracks });
  }
  if (changed.length) {
    await pool.query(
      `UPDATE aiark_people_run_companies rc SET tracks = x.tracks
         FROM jsonb_to_recordset($2::jsonb) AS x(cr bigint, tracks jsonb)
        WHERE rc.run_id = $1 AND rc.company_row_id = x.cr AND rc.state IN ('looked', 'picked', 'buying')`,
      [run.id, JSON.stringify(changed)]
    );
  }
  if (settledNow.length) await settleCompanies(ctx, settledNow);
  return { unsettled: entries.length - settledNow.length, open, busy };
}

/**
 * Companies whose three tracks are settled: their entries settled, the
 * company's people_settled_at stamped, and the company row queued again so
 * people_at_company and the AI searches read the new state (2A.7). A company
 * row being worked right now is queued once it is not (progress.requeue).
 */
async function settleCompanies(ctx, settled) {
  const { run, pool } = ctx;
  const rows = settled.map((s) => s.cr);
  await pool.query(
    `UPDATE aiark_people_run_companies rc
        SET state = 'settled', settled_at = now(), tracks = x.tracks,
            found = (SELECT count(*)::int FROM jsonb_each(x.tracks) AS t(k, v) WHERE (t.v ->> 'found')::boolean)
       FROM jsonb_to_recordset($2::jsonb) AS x(cr bigint, tracks jsonb)
      WHERE rc.run_id = $1 AND rc.company_row_id = x.cr AND rc.state IN ('looked', 'picked', 'buying')`,
    [run.id, JSON.stringify(settled)]
  );
  await pool.query(`UPDATE enrich_companies SET people_settled_at = now() WHERE row_id = ANY($1::bigint[])`, [rows]);
  ctx.progress = { ...ctx.progress, requeue: [...new Set([...(ctx.progress.requeue ?? []), ...rows])] };
  await requeueCompanies(ctx);
}

/** Queues the settled companies' rows again; one being worked waits for its next slice. */
async function requeueCompanies(ctx) {
  const want = (ctx.progress.requeue ?? []).map(Number);
  if (!want.length) return;
  const { rows } = await ctx.pool.query(
    `WITH q AS (
       UPDATE enrich_rows
          SET run_status = 'queued', next_run_at = now(), attempts = 0, claim_token = NULL, claimed_at = NULL, last_error = NULL, updated_at = now()
        WHERE id = ANY($1::bigint[]) AND run_status IN ('done', 'waiting', 'error')
       RETURNING id)
     SELECT r.id FROM enrich_rows r WHERE r.id = ANY($1::bigint[]) AND r.run_status = 'running' AND r.id NOT IN (SELECT id FROM q)`,
    [want]
  );
  ctx.progress = { ...ctx.progress, requeue: rows.map((r) => Number(r.id)) };
}

const BUY_SQL = `
  WITH st AS (
    SELECT status, claim_token = $2 AS held FROM aiark_people_runs WHERE id = $1 FOR UPDATE
  ), cand AS (
    SELECT pick FROM aiark_people_candidates WHERE run_id = $1 AND person_id = $3 FOR UPDATE
  ), fresh AS (
    SELECT coalesce((SELECT pick FROM cand) IN ('picked', 'reserve'), false) AS yes
  ), r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text)
    SELECT $4::uuid, $5::uuid, $6::text, $7::text WHERE (SELECT yes FROM fresh)
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id
  ), c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $4::uuid, 'done', kv.value,
           left(CASE WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}' ELSE coalesce(kv.value ->> 'name', kv.value::text) END, 300)
      FROM r CROSS JOIN LATERAL jsonb_each($8::jsonb) AS kv
    RETURNING 1
  ), rowid AS (
    SELECT coalesce((SELECT id FROM r), (SELECT e.id FROM enrich_rows e WHERE e.table_id = $4::uuid AND e.row_key = $6::text)) AS id
  ), p AS (
    INSERT INTO aiark_people (person_id, demo, run_id, row_id, email, email_status, company_id, record, people_run_id)
    SELECT $3, $9::boolean, NULL, (SELECT id FROM rowid), nullif($10, ''), nullif($11, ''), $12, $13::jsonb, $1
     WHERE (SELECT yes FROM fresh)
    ON CONFLICT (person_id) DO NOTHING
    RETURNING 1
  ), k AS (
    UPDATE aiark_people_candidates SET pick = $14, row_id = (SELECT id FROM rowid)
     WHERE run_id = $1 AND person_id = $3 AND (SELECT yes FROM fresh)
    RETURNING 1
  ), rc AS (
    UPDATE aiark_people_run_companies
       SET state = CASE WHEN state IN ('looked', 'picked') THEN 'buying' ELSE state END,
           with_email = with_email + CASE WHEN $15::boolean THEN 1 ELSE 0 END
     WHERE run_id = $1 AND company_row_id = $16 AND (SELECT yes FROM fresh)
    RETURNING 1
  ), u AS (
    UPDATE aiark_people_runs q
       SET bought = q.bought + CASE WHEN (SELECT yes FROM fresh) THEN 1 ELSE 0 END,
           with_email = q.with_email + CASE WHEN (SELECT yes FROM fresh) AND $15::boolean THEN 1 ELSE 0 END,
           credits_used = q.credits_used + CASE WHEN (SELECT yes FROM fresh) THEN $17::numeric ELSE 0 END,
           progress = CASE WHEN (SELECT held FROM st) THEN $18::jsonb ELSE q.progress END,
           claimed_at = CASE WHEN q.claim_token = $2 THEN now() ELSE q.claimed_at END
     WHERE q.id = $1
    RETURNING q.bought, q.credits_used
  )
  SELECT (SELECT held FROM st) AS held, (SELECT status FROM st) AS status, (SELECT yes FROM fresh) AS fresh,
         (SELECT id FROM rowid) AS row_id, (SELECT count(*) FROM r)::int AS inserted,
         (SELECT bought FROM u) AS bought, (SELECT credits_used::float8 FROM u) AS used`;

/**
 * A person bought, in one statement: the People row with its input cells
 * (queued, so its email goes through P#11 to P#56), the registry entry (with
 * the company, AI Ark's record and this run), the candidate's pick and row,
 * and the counters. Written even after a lost claim, since the person is paid
 * for; a retry of a write that committed changes nothing (the candidate is no
 * longer picked).
 */
async function writeBought(ctx, c, company, got) {
  const found = got.found === true;
  const record = found ? got.person : recordOf(c, company);
  const inputs = personInputs(record);
  const email = found ? inputs.email ?? "" : "";
  const { cells, search } = personRowCells({
    tag: ctx.run.client_tag, company, track: c.track, rank: c.rank, person: record,
    email, emailStatus: found ? inputs.email_status ?? "" : "", domainType: found ? inputs.email_domain_type ?? "" : "",
    stage: found ? "bought" : "no_email", source: "AI Ark people run",
  });
  const credits = Number(got.credits) || 0;
  const next = { ...ctx.progress, buying: null };
  let plain = false;
  for (let tries = 0; ; tries++) {
    try {
      const { rows: [r] } = await ctx.pool.query(BUY_SQL, [
        ctx.run.id, ctx.run.claim_token, c.person_id, ctx.run.people_table_id, ctx.run.source_id, aiarkPersonRowKey(c.person_id), search,
        JSON.stringify(plain ? plainOf(cells) : sane(cells)), ctx.run.mode === "demo", email, found ? inputs.email_status ?? "" : "",
        c.company_id, JSON.stringify(plain ? plainOf(record) : sane(record)), found ? "bought" : "no_email", Boolean(email), c.company_row_id, credits,
        JSON.stringify(next),
      ]);
      ctx.spent = r.used;
      ctx.run.bought = r.bought;
      if (!r.held) throw new LostClaim();
      ctx.progress = next;
      if (r.status === "cancelled") throw new Cancelled();
      return r;
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
      await readBack(ctx, e);
      throw e;
    }
  }
}

/**
 * An Export Single whose answer never came (a network error, a 5xx, or a
 * crash after the call): AI Ark may have charged, so it counts at 1 credit
 * and the candidate is not bought again (pick "lost", a try of its track).
 */
async function markLost(ctx, personId, why) {
  const lost = {
    ...ctx.progress, buying: null, lost_credits: round2(Number(ctx.progress.lost_credits ?? 0) + 1), last_lost: String(why ?? "").slice(0, 300),
  };
  // A buy whose write did commit (only its answer to this slice was lost) is not counted twice.
  const kept = { ...ctx.progress, buying: null };
  const { rows: [r] } = await ctx.pool.query(
    `WITH k AS (
       UPDATE aiark_people_candidates SET pick = 'lost' WHERE run_id = $1 AND person_id = $3 AND pick IN ('picked', 'reserve') RETURNING 1
     )
     UPDATE aiark_people_runs
        SET lost_answers = lost_answers + (SELECT count(*) FROM k)::int,
            progress = CASE WHEN EXISTS (SELECT 1 FROM k) THEN $4::jsonb ELSE $5::jsonb END, claimed_at = now()
      WHERE id = $1 AND claim_token = $2
     RETURNING progress`,
    [ctx.run.id, ctx.run.claim_token, personId, lost, kept]
  );
  if (!r) throw new LostClaim();
  ctx.progress = r.progress;
}

const COPY_SQL = `
  WITH st AS (
    SELECT status, claim_token = $2 AS held FROM aiark_people_runs WHERE id = $1 FOR UPDATE
  ), cand AS (
    SELECT pick FROM aiark_people_candidates WHERE run_id = $1 AND person_id = $3 FOR UPDATE
  ), fresh AS (
    SELECT coalesce((SELECT pick FROM cand) IN ('picked', 'reserve'), false) AND coalesce((SELECT held FROM st), false) AS yes
  ), r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text)
    SELECT $4::uuid, $5::uuid, $6::text, $7::text WHERE (SELECT yes FROM fresh) AND $8::jsonb IS NOT NULL
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id
  ), c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $4::uuid, 'done', kv.value,
           left(CASE WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}' ELSE coalesce(kv.value ->> 'name', kv.value::text) END, 300)
      FROM r CROSS JOIN LATERAL jsonb_each($8::jsonb) AS kv
    RETURNING 1
  ), rowid AS (
    SELECT CASE WHEN $8::jsonb IS NULL THEN NULL
                ELSE coalesce((SELECT id FROM r), (SELECT e.id FROM enrich_rows e WHERE e.table_id = $4::uuid AND e.row_key = $6::text)) END AS id
  ), k AS (
    UPDATE aiark_people_candidates SET verdict = 'bought_before', pick = 'none', row_id = (SELECT id FROM rowid)
     WHERE run_id = $1 AND person_id = $3 AND (SELECT yes FROM fresh)
    RETURNING 1
  ), u AS (
    UPDATE aiark_people_runs SET copied = copied + (SELECT count(*) FROM r)::int, claimed_at = now()
     WHERE id = $1 AND claim_token = $2
    RETURNING 1
  )
  SELECT (SELECT held FROM st) AS held, (SELECT status FROM st) AS status, (SELECT count(*) FROM k)::int AS changed,
         (SELECT count(*) FROM r)::int AS copied`;

/**
 * A pick another run bought between the Look and this Buy (the AI Ark tab, or
 * another client's people run): not bought again. With an email they are
 * copied free as the Look would have copied them; with none they are only
 * marked (D27). Either way the candidate becomes "bought before" and leaves
 * the picks, so the track settles on the copy, or buys its next reserve.
 */
async function copyBeforeBuy(ctx, c, company, reg) {
  let copy = null;
  if (reg.email) {
    const tab = (await tabCellsOf(ctx.pool, tabRowsOf([reg]))).get(Number(reg.row_id));
    copy = copyOf(ctx, { p: c, company, track: c.track, rank: c.rank, reg, tab });
  }
  for (let plain = false; ; plain = true) {
    try {
      const cells = copy ? JSON.stringify(plain ? plainOf(copy.cells) : sane(copy.cells)) : null;
      const { rows: [r] } = await ctx.pool.query(COPY_SQL, [
        ctx.run.id, ctx.run.claim_token, c.person_id, ctx.run.people_table_id, ctx.run.registry_source_id,
        aiarkPersonRowKey(c.person_id), copy?.search ?? "", cells,
      ]);
      if (!r.held) throw new LostClaim();
      if (r.status === "cancelled") throw new Cancelled();
      return r;
    } catch (e) {
      if (plain || !/^22/.test(String(e?.code ?? ""))) throw e;
    }
  }
}

/** The next people to buy: per open track, the picked one first, then its reserves, best rank first. */
async function nextBuys(ctx, open, n) {
  if (!open.length || n <= 0) return [];
  const { rows } = await ctx.pool.query(
    `SELECT DISTINCT ON (c.company_row_id, c.track) c.person_id, c.company_row_id::bigint AS company_row_id, c.company_id, c.track, c.rank,
            c.first_name, c.last_name, c.title, c.city, c.region, c.country, c.seniority, c.department
       FROM aiark_people_candidates c
       JOIN unnest($2::bigint[], $3::text[]) AS o(cr, tr) ON o.cr = c.company_row_id AND o.tr = c.track
      WHERE c.run_id = $1 AND c.pick IN ('picked', 'reserve')
      ORDER BY c.company_row_id, c.track, (c.pick = 'picked') DESC, c.rank, c.person_id`,
    [ctx.run.id, open.map((o) => o.company_row_id), open.map((o) => o.track)]
  );
  return rows.slice(0, n).map((r) => ({ ...r, company_row_id: Number(r.company_row_id) }));
}

async function sliceBuy(ctx) {
  const { run } = ctx;
  if (ctx.progress.buying?.person_id) {
    // The slice before was cut off between a call and its write.
    await markLost(ctx, ctx.progress.buying.person_id, "The worker stopped before the answer was written");
  }
  if (ctx.progress.requeue?.length) await requeueCompanies(ctx);
  const room = () => Number(run.max_people) - Number(run.bought);
  let st = await settle(ctx, { canBuy: room() > 0 });
  const picks = await nextBuys(ctx, st.open, Math.min(ctx.maxBuysPerSlice, Math.max(0, room())));
  let bought = 0;
  let copied = 0;
  let lostInARow = 0;
  const companies = new Map();
  // Anyone bought by another run since the Look (free to check): copied or passed over, never bought again.
  const registry = await registryOf(ctx.pool, picks.map((c) => c.person_id));
  for (const c of picks) {
    if (ctx.shouldStop()) return { wait: 0 };
    if (room() <= 0) break;
    if (!companies.has(c.company_row_id)) {
      const { rows: [b] } = await ctx.pool.query(`SELECT batch FROM aiark_people_run_companies WHERE run_id = $1 AND company_row_id = $2`, [run.id, c.company_row_id]);
      for (const x of b ? await batchCompanies(ctx, b.batch) : []) companies.set(x.company_row_id, x);
    }
    const company = companies.get(c.company_row_id) ?? { company_row_id: c.company_row_id, company_id: c.company_id, name: "", domain: "", website: "", industry: "", description: "" };
    const reg = registry.get(c.person_id);
    if (reg) {
      await copyBeforeBuy(ctx, c, company, reg);
      copied++;
      continue;
    }
    const gate = await beforePaidCall(ctx, 1);
    if (gate) return gate;
    ctx.progress = { ...ctx.progress, buying: { person_id: c.person_id, company_row_id: c.company_row_id, track: c.track, at: new Date().toISOString() } };
    await savePosition(ctx); // a cancel is seen here, before the person is bought
    let got;
    try {
      got = await ctx.client.exportSingle(c.person_id);
      lostInARow = 0;
    } catch (e) {
      if (e instanceof AiArkError && (e.kind === "network" || e.kind === "server")) {
        await markLost(ctx, c.person_id, e.message);
        if (++lostInARow >= LOST_ANSWERS_MAX) return { error: e };
        continue;
      }
      // Refused before AI Ark did anything (out of credits, the key, too fast): nothing was bought.
      ctx.progress = { ...ctx.progress, buying: null };
      throw e;
    }
    await writeBought(ctx, c, company, got);
    bought++;
  }
  if (bought || copied) return { more: true };
  st = await settle(ctx, { canBuy: room() > 0 });
  // People rows still being worked, or settled companies whose rows are being worked: settle again shortly.
  if (st.busy || ctx.progress.requeue?.length) return { wait: ROWS_WAIT_MS };
  if (st.open.length) return { more: true };
  // Tracks still open that the run may not buy for: its most people are bought.
  if (st.unsettled) {
    return { done: room() <= 0 ? `Bought the most people this run allows (${fmt(run.max_people)}); the companies left wait for the next run.` : null };
  }
  // Settle reads its companies in chunks: the next chunk, if any, before the run ends.
  const { rows: [left] } = await ctx.pool.query(
    `SELECT count(*)::int AS n FROM aiark_people_run_companies WHERE run_id = $1 AND state IN ('looked', 'picked', 'buying')`,
    [run.id]
  );
  return left.n ? { more: true } : { done: null };
}

// ── One slice ───────────────────────────────────────────────────────────────

/**
 * Claims one due people run, works one slice of it and lets go. Returns the
 * run's id when one was worked, null when nothing was due.
 *
 * `clientFor(mode)` replaces aiArkFor (tests use it to inject faults);
 * `settings` replaces the worker's 30-second settings read (tests);
 * `maxBuysPerSlice` the Export Singles one slice may make (10), so the AI Ark
 * loop takes turns; `shouldStop()` turning true lets go of the run before its
 * next paid call.
 *
 * @param {{ pool: Db & { connect: () => Promise<any> }, env?: Record<string, string | undefined>, log?: (m: string) => void,
 *           clientFor?: ((mode: string) => Promise<{ client: any, why?: string }>) | null, shouldStop?: () => boolean,
 *           maxBuysPerSlice?: number, settings?: import("../enrich/settings.mjs").PipelineSettings | null }} opts
 * @returns {Promise<string | null>}
 */
export async function advanceOnePeopleRun({
  pool, env = process.env, log = () => {}, clientFor = null, shouldStop = () => false, maxBuysPerSlice = 10, settings = null,
}) {
  const run = await claimRun(pool);
  if (!run) return null;
  const got = clientFor ? await clientFor(run.mode) : await aiArkFor(run.mode, { env, db: pool });
  const ctx = {
    pool, env, log, run, client: got.client, progress: run.progress ?? {}, spent: Number(run.credits_used), shouldStop,
    maxBuysPerSlice: Math.max(1, Math.floor(maxBuysPerSlice) || 10), settings: settings ?? (await readSettings(pool)), balance: null,
  };
  const area = byArea(run);
  const why = !got.client
    ? got.why
    : !run.people_table_id || !run.companies_table_id
      ? "The client's People or Companies table was deleted, so the run has nowhere to read or write"
      : area
        ? !Array.isArray(run.filters?.bodies) || !run.filters.bodies.length
          ? "The run has no searches to make"
          : null
        : !run.filters?.tracks
          ? "The run has no tracks to look for"
          : null;
  if (why) {
    await pool.query(
      `UPDATE aiark_people_runs SET status = CASE WHEN status = 'running' THEN 'error' ELSE status END, last_error = $3,
              finished_at = coalesce(finished_at, now()), claim_token = NULL, claimed_at = NULL
        WHERE id = $1 AND claim_token = $2`,
      [run.id, run.claim_token, why]
    );
    log(`AI Ark people run ${run.id.slice(0, 8)}: ${why}`);
    return run.id;
  }

  try {
    if (run.credits_before == null) {
      const before = await ctx.client.credits().catch(() => null);
      if (before != null) {
        await pool.query(`UPDATE aiark_people_runs SET credits_before = $3 WHERE id = $1 AND claim_token = $2`, [run.id, run.claim_token, before]);
      }
    }
    const waitingForBuy =
      ctx.progress.look_done && Number(run.picked) > 0 && !run.buy_approved_at && !ctx.settings.flagOn("auto_buy", run.client_tag);
    const out = !ctx.progress.look_done
      ? area ? await lookByArea(ctx, KIT) : await sliceLook(ctx)
      : waitingForBuy
        ? { pause: true }
        : area ? await buyByArea(ctx, KIT) : await sliceBuy(ctx);
    if (out.fail) {
      await finish(ctx, { status: "error", lastError: out.fail });
    } else if (out.stop) {
      await finish(ctx, { status: "stopped", stopReason: out.stop });
    } else if (out.done !== undefined) {
      await finish(ctx, { status: "done", stopReason: out.done });
    } else if (out.pause) {
      await pause(ctx);
    } else if (out.error) {
      const attempts = run.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) await finish(ctx, { status: "error", lastError: `Gave up after ${attempts} tries: ${out.error.message}` });
      else await release(ctx, { inMs: backoffMs(attempts), attempts, lastError: out.error.message });
    } else if (out.hold) {
      await release(ctx, { inMs: out.wait, attempts: run.attempts, lastError: run.last_error });
    } else {
      await release(ctx, { inMs: out.wait ?? 0, attempts: 0 });
    }
  } catch (e) {
    if (e instanceof LostClaim) {
      log(`AI Ark people run ${run.id.slice(0, 8)}: claim lost mid-slice (reclaimed elsewhere), stopped`);
    } else if (e instanceof Unread) {
      log(`AI Ark people run ${run.id.slice(0, 8)}: ${e.message}, and the run could not be read back; left as it is until its lease runs out`);
    } else if (e instanceof Cancelled) {
      await finish(ctx, { status: "cancelled" });
    } else if (e instanceof CheckFailed) {
      await finish(ctx, { status: "error", lastError: e.message });
    } else if (e instanceof AiArkError && e.kind === "credits") {
      await finish(ctx, { status: "stopped", stopReason: "The AI Ark account ran out of credits" });
    } else if (e instanceof AiArkError && (e.kind === "key" || (!e.retryable && e.kind !== "pending_cap"))) {
      // 401/403: the key. 400: AI Ark refused the request (free), or a check could not be made.
      await finish(ctx, { status: "error", lastError: e.message });
    } else {
      const attempts = run.attempts + 1;
      const msg = String(e?.message ?? e).slice(0, 300);
      if (attempts >= MAX_ATTEMPTS) await finish(ctx, { status: "error", lastError: `Gave up after ${attempts} tries: ${msg}` }).catch(() => {});
      else await release(ctx, { inMs: backoffMs(attempts), attempts, lastError: msg }).catch(() => {});
      log(`AI Ark people run ${run.id.slice(0, 8)}: ${msg} (try ${attempts} of ${MAX_ATTEMPTS})`);
    }
  }
  return run.id;
}

/** For the tab and the tests: the ids-per-search a run starts at (people_pipeline.ids_per_search's default). */
export { IDS_PER_SEARCH };

/** This file's helpers the LinkedIn path (linkedin-people.mjs) works with, handed over so the two never import each other. */
const KIT = Object.freeze({
  savePosition, beforePaidCall, markLost, readBack, sane, plainOf, screenOne, factsOf, registryOf, tabCellsOf, tabRowsOf, recordOf,
  personRowCells, mapLimit, sleep, activePeopleRun, PeopleRunRefused, LostClaim, Cancelled,
  consts: { SCREEN_THREADS, LOST_PAGES_MAX, LOST_ANSWERS_MAX, WRITE_RETRIES, WRITE_RETRY_MS },
});
