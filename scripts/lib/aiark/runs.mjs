// AI Ark runs: one aiark_runs row per pull, worked a slice at a time by the
// enrichment worker (scripts/enrich-worker.mjs) and written into the run's
// own Clay-tab table, where the worker's row loop then works out each
// person's outcome.
//
// Two ways to pull (aiark_runs.strategy):
//   single — page People Preview (1 credit a page of 100), skip anyone already
//            bought, then Export Single each new person (1 credit only when a
//            valid email is found). No webhook needed.
//   export — one Export People with Email job per location group (0.5 credits
//            a person + 0.5 per email). AI Ark requires a public HTTPS webhook
//            (AIARK_WEBHOOK_URL); results are read by polling, the webhook body
//            is never used.
//
// Never pays twice for a person: everyone bought (or checked and found
// without an email) is kept in aiark_people the moment the call returns, and
// each run asks AI Ark to leave out the most recent 100,000 of them (AI Ark
// Lists: 10 lists of 10,000 a request, 50 lists a day, 24 hours each).
//
// Crash and cancel: a slice holds the run with a claim token and a 10-minute
// lease. Every write is fenced on the token; the cursor (progress) is saved
// after each page, so a crash repeats at most one page — and the registry
// keeps that page from buying anyone again. Cancelling sets status
// 'cancelled'; the slice sees it on its next write and stops. Credits are
// recorded even then: a person paid for is never lost.

import { randomUUID } from "node:crypto";
import {
  AiArkError, createAiArk, EXPORT_MAX, LIST_MAX, LISTS_PER_DAY, LISTS_PER_REQUEST, PAGE_MAX, SEARCH_CAP, personInputs,
} from "./client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./demo.mjs";
import { PERSON_SEARCH_KEYS, RUN_COLUMNS, RUN_INPUT_KEYS } from "./columns.mjs";

export const LEASE_MIN = 10;
const MAX_ATTEMPTS = 6;
const LIST_BUDGET = LISTS_PER_DAY - 5; // a few spare for anyone using the key by hand
const LIST_REFRESH_MS = 23 * 3600_000; // AI Ark drops lists after 24 h
const EXPORT_POLL_MS = 15_000;
const EXPORT_WAIT_MAX_MS = 3 * 3600_000; // AI Ark auto-refunds a job it can't deliver within ~10 h; we stop waiting at 3
const PROCESSING_WAIT_MS = 10 * 60_000; // a finished job's people whose email AI Ark is still checking
const ADOPT_WINDOW_MS = 120_000;
export const DEMO_WEBHOOK = "https://demo.invalid/api/aiark/webhook"; // .invalid never resolves; the demo sends nothing

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};

// ── Clients ─────────────────────────────────────────────────────────────────

let liveClient = null;
let demoTransport = null;

/**
 * The AI Ark client for a mode: { client } or { client: null, why }. The demo
 * transport is kept for the life of the process (its export jobs and lists
 * outlive a slice); its credit balance is re-read from the demo runs' spend.
 *
 * @param {"live" | "demo"} mode
 * @param {{ env?: Record<string, string | undefined>, db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } }} opts
 * @returns {Promise<{ client: ReturnType<typeof createAiArk> | null, why?: string }>}
 */
export async function aiArkFor(mode, { env = process.env, db }) {
  if (mode === "demo") {
    if (env.AIARK_DEMO !== "1") return { client: null, why: "Demo runs are off (AIARK_DEMO=1 turns them on)" };
    const base = num(env.AIARK_DEMO_CREDITS, 25_000);
    const { rows } = await db.query(`SELECT coalesce(sum(credits_used), 0)::float8 AS used FROM aiark_runs WHERE mode = 'demo'`);
    if (!demoTransport) demoTransport = createDemoTransport({ latencyMs: num(env.AIARK_DEMO_LATENCY_MS, 120) });
    demoTransport.state.balance = Math.max(0, base - Number(rows[0].used));
    return { client: createAiArk({ token: DEMO_TOKEN, transport: demoTransport, rps: 5 }) };
  }
  if (!env.AIARK_API_KEY) return { client: null, why: "Needs AIARK_API_KEY" };
  if (!liveClient || liveClient.token !== env.AIARK_API_KEY) {
    liveClient = { token: env.AIARK_API_KEY, client: createAiArk({ token: env.AIARK_API_KEY, rps: num(env.AIARK_RPS, 4) }) };
  }
  return { client: liveClient.client };
}

/** The webhook AI Ark needs for export jobs, or why there is none. Must be ours, public and HTTPS. */
export function webhookFor(mode, env = process.env) {
  if (mode === "demo") return { url: DEMO_WEBHOOK };
  const raw = String(env.AIARK_WEBHOOK_URL ?? "").trim();
  if (!raw) return { url: null, why: "Needs AIARK_WEBHOOK_URL (this app's /api/aiark/webhook on a public HTTPS address)" };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { url: null, why: "AIARK_WEBHOOK_URL is not a URL" };
  }
  if (u.protocol !== "https:") return { url: null, why: "AIARK_WEBHOOK_URL must be HTTPS" };
  if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(u.hostname)) return { url: null, why: "AIARK_WEBHOOK_URL must be public (AI Ark rejects local addresses)" };
  if (!u.pathname.endsWith("/api/aiark/webhook")) return { url: null, why: "AIARK_WEBHOOK_URL must point at this app's /api/aiark/webhook" };
  return { url: u.href };
}

// ── Creating a run (called by POST /api/aiark/runs inside its transaction) ──

function stamp(d = new Date()) {
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Creates the run's table (kind 'ai_ark', the shared column set), its source
 * and the aiark_runs row. `db` is a client inside the caller's transaction.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ tag: string, mode: "live" | "demo", strategy: "single" | "export", size: number, filters: object,
 *           requests: object[], matchCount?: number | null, createdBy?: string | null }} opts
 */
export async function createRun(db, { tag, mode, strategy, size, filters, requests, matchCount = null, createdBy = null }) {
  const id = randomUUID();
  const name = `AI Ark ${stamp()} · ${size.toLocaleString("en-US")} people${mode === "demo" ? " · demo" : ""} · ${id.slice(0, 6)}`;
  const { rows: [table] } = await db.query(
    `INSERT INTO enrich_tables (client_tag, kind, name, source_note) VALUES ($1, 'ai_ark', $2, $3) RETURNING id`,
    [tag, name, `AI Ark run ${id} (${strategy}${mode === "demo" ? ", made-up people" : ""})`]
  );
  await db.query(
    `INSERT INTO enrich_columns (table_id, key, name, position, kind, action, formula, waterfall, inputs, config, run_if,
                                 data_type, description, provider, needs_env, phase, hidden)
     SELECT $1, x.key, x.name, x.position, x.kind, x.action, x.formula, x.waterfall, coalesce(x.inputs, '{}'::jsonb),
            coalesce(x.config, '{}'::jsonb), x.run_if, x.data_type, x.description, x.provider, x.needs_env, x.phase, x.hidden
       FROM jsonb_to_recordset($2::jsonb) AS x(key text, name text, position int, kind text, action text, formula text,
            waterfall jsonb, inputs jsonb, config jsonb, run_if text, data_type text, description text, provider text,
            needs_env text[], phase smallint, hidden boolean)`,
    [table.id, JSON.stringify(RUN_COLUMNS)]
  );
  const { rows: [source] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, label, meta, created_by) VALUES ($1, 'ai_ark', $2, $3, $4) RETURNING id`,
    [table.id, `AI Ark run (${strategy})`, JSON.stringify({ run_id: id, mode, strategy, size }), createdBy]
  );
  const { rows: [run] } = await db.query(
    `INSERT INTO aiark_runs (id, client_tag, mode, strategy, size_requested, table_id, source_id, filters, requests, match_count, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [id, tag, mode, strategy, size, table.id, source.id, JSON.stringify(filters), JSON.stringify(requests), matchCount, createdBy]
  );
  return run;
}

// ── Queue ───────────────────────────────────────────────────────────────────

async function claimRun(pool) {
  const { rows } = await pool.query(
    `UPDATE aiark_runs r
        SET claim_token = $1, claimed_at = now(), status = 'running', started_at = coalesce(r.started_at, now())
      WHERE r.id = (
        SELECT q.id FROM aiark_runs q
         WHERE q.status IN ('queued', 'running') AND q.next_run_at <= now()
           AND (q.claim_token IS NULL OR q.claimed_at < now() - make_interval(mins => $2))
         ORDER BY q.next_run_at, q.created_at
         LIMIT 1
           FOR UPDATE SKIP LOCKED)
      RETURNING r.*`,
    [randomUUID(), LEASE_MIN]
  );
  return rows[0] ?? null;
}

/** Is any run due now? (The worker's drain-and-exit mode asks.) */
export async function runDue(pool) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM aiark_runs WHERE status IN ('queued', 'running') AND next_run_at <= now()
                     AND (claim_token IS NULL OR claimed_at < now() - make_interval(mins => $1))) AS due`,
    [LEASE_MIN]
  );
  return rows[0].due;
}

class LostClaim extends Error {}
class Cancelled extends Error {}

/** Saves the cursor mid-slice (fenced). */
async function savePosition(ctx) {
  const { rowCount } = await ctx.pool.query(
    `UPDATE aiark_runs SET progress = $3, claimed_at = now() WHERE id = $1 AND claim_token = $2`,
    [ctx.run.id, ctx.run.claim_token, ctx.progress]
  );
  if (!rowCount) throw new LostClaim();
}

async function release(ctx, { inMs = 0, attempts = 0, lastError = null } = {}) {
  await ctx.pool.query(
    `UPDATE aiark_runs SET claim_token = NULL, claimed_at = NULL, progress = $3, attempts = $4, last_error = $5,
            next_run_at = now() + make_interval(secs => $6)
      WHERE id = $1 AND claim_token = $2`,
    [ctx.run.id, ctx.run.claim_token, ctx.progress, attempts, lastError, inMs / 1000]
  );
}

async function finish(ctx, { status, stopReason = null, lastError = null }) {
  let creditsAfter = null;
  try {
    creditsAfter = await ctx.client.credits();
  } catch {
    /* the balance is a nicety; never fail a finish over it */
  }
  const { rows } = await ctx.pool.query(
    `UPDATE aiark_runs
        SET status = CASE WHEN status = 'running' THEN $3 ELSE status END,
            stop_reason = CASE WHEN status = 'running' THEN $4 ELSE stop_reason END,
            last_error = coalesce($5, last_error), progress = $6, credits_after = coalesce($7, credits_after),
            finished_at = coalesce(finished_at, now()), claim_token = NULL, claimed_at = NULL
      WHERE id = $1 AND claim_token = $2
      RETURNING status, pulled, source_id`,
    [ctx.run.id, ctx.run.claim_token, status, stopReason, lastError, ctx.progress, creditsAfter]
  );
  if (rows[0]?.source_id) {
    await ctx.pool.query(`UPDATE enrich_sources SET received = $2, created = $2 WHERE id = $1`, [rows[0].source_id, rows[0].pulled]);
  }
  ctx.log?.(`AI Ark run ${ctx.run.id.slice(0, 8)}: ${rows[0]?.status ?? "?"}${stopReason ? ` — ${stopReason}` : ""}${lastError ? ` (${lastError})` : ""}`);
  return rows[0]?.status;
}

/** Credits AI Ark charged outside a person write (a Preview page). Recorded even on a cancelled run. */
async function addCredits(ctx, n) {
  if (!n) return;
  const { rows } = await ctx.pool.query(
    `UPDATE aiark_runs SET credits_used = credits_used + $2 WHERE id = $1 RETURNING status, claim_token = $3 AS held`,
    [ctx.run.id, n, ctx.run.claim_token]
  );
  if (!rows[0]?.held) throw new LostClaim();
  if (rows[0].status === "cancelled") throw new Cancelled();
}

/**
 * One person into the run's table, the registry and the run's counters — one
 * statement, so a crash never leaves a paid person half-recorded. The
 * registry row and the credits are written even if the claim was lost.
 */
async function writePerson(ctx, { inputs, credits, pulledBefore = null }) {
  const cells = {};
  for (const k of RUN_INPUT_KEYS) {
    const v = k === "pulled_before" ? pulledBefore : inputs[k];
    if (v) cells[k] = String(v).replace(/\u0000/g, "").slice(0, 5_000);
  }
  const personId = cells.aiark_id;
  if (!personId) return { inserted: 0 };
  const search = PERSON_SEARCH_KEYS.map((k) => cells[k]).filter(Boolean).join(" ").toLowerCase().slice(0, 2_000);
  const usable = cells.email_status === "VALID" && Boolean(cells.email);
  const { rows: [r] } = await ctx.pool.query(
    `WITH ok AS (
       SELECT id, status FROM aiark_runs WHERE id = $1 AND claim_token = $2 FOR UPDATE
     ), r AS (
       INSERT INTO enrich_rows (table_id, source_id, row_key, search_text)
       SELECT $3, $4, $5, $6 FROM ok
       ON CONFLICT (table_id, row_key) DO NOTHING
       RETURNING id
     ), c AS (
       INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
       SELECT r.id, kv.key, $3, 'done', to_jsonb(kv.value), left(kv.value, 300)
         FROM r CROSS JOIN LATERAL jsonb_each_text($7::jsonb) AS kv
       RETURNING 1
     ), p AS (
       INSERT INTO aiark_people (person_id, demo, run_id, row_id, email, email_status)
       VALUES ($8, $9, $1, (SELECT id FROM r), nullif($10, ''), nullif($11, ''))
       ON CONFLICT (person_id) DO NOTHING
       RETURNING 1
     ), u AS (
       UPDATE aiark_runs
          SET pulled = pulled + (SELECT count(*) FROM r)::int,
              with_email = with_email + CASE WHEN $12::boolean AND EXISTS (SELECT 1 FROM r) THEN 1 ELSE 0 END,
              skipped_held = skipped_held + CASE WHEN $13::boolean AND EXISTS (SELECT 1 FROM r) THEN 1 ELSE 0 END,
              credits_used = credits_used + $14
        WHERE id = $1
       RETURNING 1
     )
     SELECT (SELECT count(*) FROM ok)::int AS held, (SELECT status FROM ok) AS status,
            (SELECT count(*) FROM r)::int AS inserted, (SELECT count(*) FROM p)::int AS registered,
            (SELECT count(*) FROM u)::int AS counted`,
    [
      ctx.run.id, ctx.run.claim_token, ctx.run.table_id, ctx.run.source_id, `aiark:${personId}`, search, JSON.stringify(cells),
      personId, ctx.run.mode === "demo", cells.email ?? "", cells.email_status ?? "", usable, Boolean(pulledBefore), credits,
    ]
  );
  if (!r.held) throw new LostClaim();
  ctx.pulled += r.inserted;
  if (r.status === "cancelled") throw new Cancelled();
  return r;
}

// ── Exclusion lists ─────────────────────────────────────────────────────────

/**
 * Asks AI Ark to leave out the people already bought: the most recent up to
 * 10 × 10,000, as far as today's list budget allows. A run never fails over
 * lists — without them a held person costs a Preview slot (single) or is
 * bought again and marked "Bought before" (export).
 */
async function buildLists(ctx) {
  const { pool, client, run, progress } = ctx;
  const demo = run.mode === "demo";
  const { rows: [{ made }] } = await pool.query(
    `SELECT count(*)::int AS made
       FROM aiark_runs r, jsonb_array_elements_text(coalesce(r.progress->'lists_log', '[]'::jsonb)) AS t(at)
      WHERE r.mode = $1 AND t.at::timestamptz > now() - interval '24 hours'`,
    [run.mode]
  );
  const { rows: [{ held }] } = await pool.query(`SELECT count(*)::int AS held FROM aiark_people WHERE demo = $1`, [demo]);
  const budget = Math.max(0, Math.min(LISTS_PER_REQUEST, LIST_BUDGET - made));
  const lists = [];
  const logAt = [];
  let note = null;
  if (held && budget) {
    const { rows } = await pool.query(
      `SELECT person_id FROM aiark_people WHERE demo = $1 ORDER BY pulled_at DESC, person_id LIMIT $2`,
      [demo, Math.min(held, budget * LIST_MAX)]
    );
    for (let i = 0; i < rows.length; i += LIST_MAX) {
      const ids = rows.slice(i, i + LIST_MAX).map((x) => x.person_id);
      try {
        lists.push({ id: await client.createList(ids), count: ids.length });
        logAt.push(new Date().toISOString());
      } catch (e) {
        if (!(e instanceof AiArkError) || e.retryable || e.kind === "key" || e.kind === "credits") throw e;
        note = `AI Ark refused an exclusion list (${e.message}); the rest are left out.`;
        break;
      }
    }
  }
  const covered = lists.reduce((s, l) => s + l.count, 0);
  if (!note && covered < held) {
    note = budget
      ? `Left out the ${covered.toLocaleString("en-US")} most recently bought of ${held.toLocaleString("en-US")} people (AI Ark takes 100,000 a search).`
      : `No exclusion lists left today (AI Ark allows ${LISTS_PER_DAY} a day): people bought before may come back.`;
  }
  ctx.progress = {
    ...progress,
    lists: lists.map((l) => l.id),
    lists_at: new Date().toISOString(),
    lists_log: [...(progress.lists_log ?? []), ...logAt],
    lists_dirty: false,
    excluded: covered,
    held_at_start: held,
    lists_note: note,
  };
  await savePosition(ctx);
}

const listsStale = (p) => !p.lists_at || Date.now() - Date.parse(p.lists_at) > LIST_REFRESH_MS;

// ── single: Preview pages + Export Single per new person ────────────────────

const endReason = (p) =>
  p.capped?.length ? "Reached AI Ark's limit of 10,000 matches per search" : "No more matches";

async function sliceSingle(ctx) {
  const { run } = ctx;
  const p = ctx.progress;
  const chunk = p.chunk ?? 0;
  if (chunk >= run.requests.length) return { done: endReason(p) };
  const page = p.page ?? 0;
  if ((page + 1) * PAGE_MAX > SEARCH_CAP) {
    // AI Ark pages through 10,000 matches per search at most.
    ctx.progress = { ...p, chunk: chunk + 1, page: 0, capped: [...(p.capped ?? []), chunk] };
    await savePosition(ctx);
    return { more: true };
  }

  const res = await ctx.client.preview(run.requests[chunk], { page, size: PAGE_MAX, lists: p.lists });
  await addCredits(ctx, 1);
  const matches = { ...(p.matches ?? {}), [chunk]: res.totalElements };

  const ids = res.content.map((x) => x?.id).filter(Boolean);
  const { rows } = ids.length
    ? await ctx.pool.query(`SELECT person_id, run_id FROM aiark_people WHERE person_id = ANY($1::text[])`, [ids])
    : { rows: [] };
  // Already in this run's table (a page repeated after a crash) / bought by an earlier run.
  const mine = new Set(rows.filter((x) => x.run_id === run.id).map((x) => x.person_id));
  const held = new Set(rows.filter((x) => x.run_id !== run.id).map((x) => x.person_id));
  let skipped = 0;
  for (const item of res.content) {
    if (ctx.pulled >= run.size_requested) break;
    if (!item?.id || mine.has(item.id)) continue;
    if (held.has(item.id)) {
      skipped++;
      continue;
    }
    const got = await ctx.client.exportSingle(item.id);
    // No email: AI Ark sends nothing (and charges nothing), so the row keeps
    // what Preview showed — the last name stays masked.
    await writePerson(ctx, { inputs: got.found ? personInputs(got.person) : personInputs(item), credits: got.credits });
    held.add(item.id);
  }
  if (skipped) {
    await ctx.pool.query(`UPDATE aiark_runs SET skipped_held = skipped_held + $2 WHERE id = $1`, [run.id, skipped]);
  }

  const lastPage = res.content.length < PAGE_MAX || (page + 1) * PAGE_MAX >= res.totalElements;
  ctx.progress = { ...p, matches, ...(lastPage ? { chunk: chunk + 1, page: 0 } : { page: page + 1 }) };
  await savePosition(ctx);
  if (ctx.pulled >= run.size_requested) return { done: null };
  if (lastPage && chunk + 1 >= run.requests.length) return { done: endReason(ctx.progress) };
  return { more: true };
}

// ── export: async jobs, read by polling ─────────────────────────────────────

async function adoptSubmission(ctx, job) {
  const since = Date.parse(job.submitting_at) - ADOPT_WINDOW_MS;
  const subs = await ctx.client.exportSubmissions({ size: 25 });
  return subs.find((s) => Number(s.requestSize) === job.size && Date.parse(s.created) >= since && s.trackId) ?? null;
}

async function sliceExport(ctx) {
  const { run } = ctx;
  let p = ctx.progress;
  const chunk = p.chunk ?? 0;
  if (chunk >= run.requests.length) return { done: "No more matches" };
  let job = p.job ?? null;

  // A submission whose answer never arrived: adopt it if AI Ark has it.
  if (job && !job.track_id) {
    const sub = await adoptSubmission(ctx, job);
    if (sub) {
      job = { ...job, track_id: sub.trackId, adopted: true };
    } else if (Date.now() - Date.parse(job.submitting_at) < ADOPT_WINDOW_MS) {
      return { wait: EXPORT_POLL_MS };
    } else {
      job = null; // never reached AI Ark: submit again
    }
    ctx.progress = p = { ...p, job };
    await savePosition(ctx);
  }

  if (!job) {
    const remaining = run.size_requested - ctx.pulled;
    if (remaining <= 0) return { done: null };
    const hook = webhookFor(run.mode, ctx.env);
    if (!hook.url) return { fail: hook.why };
    if (listsStale(p) || p.lists_dirty) {
      await buildLists(ctx);
      p = ctx.progress;
    }
    job = { submitting_at: new Date().toISOString(), size: Math.min(remaining, EXPORT_MAX), chunk };
    ctx.progress = p = { ...p, job };
    await savePosition(ctx);
    let started;
    try {
      started = await ctx.client.exportStart(run.requests[chunk], { size: job.size, lists: p.lists, webhook: hook.url });
    } catch (e) {
      // Refused outright (400/402/401): nothing was bought. Lost answer: the
      // next slice looks for the submission before sending anything again.
      if (e instanceof AiArkError && (e.kind === "network" || e.kind === "server")) return { wait: EXPORT_POLL_MS, error: e };
      ctx.progress = { ...p, job: null };
      await savePosition(ctx);
      throw e;
    }
    job = { ...job, track_id: started.trackId, submitted_at: new Date().toISOString() };
    ctx.progress = p = { ...p, job };
    await savePosition(ctx);
    return { wait: Math.min(EXPORT_POLL_MS, 5_000) };
  }

  if (!job.done_at) {
    let st;
    try {
      st = await ctx.client.exportStatus(job.track_id);
    } catch (e) {
      if (e instanceof AiArkError && (e.kind === "refunded" || e.kind === "expired")) return resubmit(ctx, e);
      throw e;
    }
    if (st.state !== "DONE") {
      if (Date.now() - Date.parse(job.submitted_at ?? job.submitting_at) > EXPORT_WAIT_MAX_MS) {
        return { fail: `AI Ark's export ${job.track_id} did not finish within 3 hours; AI Ark refunds jobs it can't deliver` };
      }
      ctx.progress = { ...p, job: { ...job, state: st.state, total: st.total, found: st.found } };
      await savePosition(ctx);
      return { wait: EXPORT_POLL_MS };
    }
    // The job's price, from AI Ark's own count: 0.5 for everyone exported and
    // 0.5 for each email found. Recorded once, with the cursor, in one write.
    const price = job.charged ? 0 : 0.5 * st.total + 0.5 * st.found;
    job = { ...job, state: "DONE", total: st.total, found: st.found, done_at: new Date().toISOString(), page: job.page ?? 0, charged: true };
    ctx.progress = p = { ...p, job };
    const { rows: [w] } = await ctx.pool.query(
      `UPDATE aiark_runs SET credits_used = credits_used + $3, progress = $4, claimed_at = now()
        WHERE id = $1 AND claim_token = $2 RETURNING status`,
      [run.id, run.claim_token, price, p]
    );
    if (!w) throw new LostClaim();
    if (w.status === "cancelled") throw new Cancelled();
  }

  let res;
  try {
    res = await ctx.client.exportResults(job.track_id, { page: job.page ?? 0, size: PAGE_MAX });
  } catch (e) {
    if (e instanceof AiArkError && (e.kind === "refunded" || e.kind === "expired")) return resubmit(ctx, e);
    if (e instanceof AiArkError && e.kind === "not_ready") {
      ctx.progress = { ...p, job: { ...job, done_at: null } };
      await savePosition(ctx);
      return { wait: EXPORT_POLL_MS };
    }
    throw e;
  }
  const checking = res.content.some((x) => String(x?.email?.state ?? "").toUpperCase() === "PROCESSING");
  if (checking && Date.now() - Date.parse(job.done_at) < PROCESSING_WAIT_MS) return { wait: 30_000 };

  const ids = res.content.map((x) => x?.id).filter(Boolean);
  const { rows } = ids.length
    ? await ctx.pool.query(
        `SELECT person_id, pulled_at, run_id FROM aiark_people WHERE person_id = ANY($1::text[]) AND run_id IS DISTINCT FROM $2`,
        [ids, run.id]
      )
    : { rows: [] };
  const before = new Map(rows.map((x) => [x.person_id, x]));
  for (const item of res.content) {
    if (!item?.id) continue;
    const prev = before.get(item.id);
    const pulledBefore = prev ? `Bought ${new Date(prev.pulled_at).toISOString().slice(0, 10)}${prev.run_id ? ` (run ${String(prev.run_id).slice(0, 6)})` : ""}` : null;
    // Paid for with the job (above), not per person.
    await writePerson(ctx, { inputs: personInputs(item), credits: 0, pulledBefore });
  }

  const lastPage = res.last || !res.content.length;
  if (!lastPage) {
    ctx.progress = { ...p, job: { ...job, page: (job.page ?? 0) + 1 } };
    await savePosition(ctx);
    return { more: true };
  }
  // The job is read. Fewer people than asked means this location group is used up.
  const exhausted = (job.total ?? 0) < job.size;
  const nextChunk = exhausted ? chunk + 1 : chunk;
  ctx.progress = { ...p, job: null, chunk: nextChunk, jobs_done: (p.jobs_done ?? 0) + 1, lists_dirty: true };
  await savePosition(ctx);
  if (ctx.pulled >= run.size_requested) return { done: null };
  if (nextChunk >= run.requests.length) return { done: "No more matches" };
  return { more: true };
}

/** A refunded or expired job: submit what is still owed again, leaving out everyone already written. */
async function resubmit(ctx, e) {
  const resubmits = (ctx.progress.resubmits ?? 0) + 1;
  if (resubmits > 3) return { fail: `AI Ark refunded or dropped this run's export ${resubmits - 1} times (${e.message})` };
  ctx.progress = { ...ctx.progress, job: null, resubmits, lists_dirty: true, last_refund: e.message };
  await savePosition(ctx);
  ctx.log?.(`AI Ark run ${ctx.run.id.slice(0, 8)}: ${e.message} — submitting again`);
  return { wait: 5_000 };
}

// ── One slice ───────────────────────────────────────────────────────────────

/**
 * Claims one due run, works one slice of it and lets go. Returns the run's id
 * when one was worked, null when nothing was due.
 *
 * `clientFor(mode)` replaces aiArkFor (tests use it to inject faults).
 */
export async function advanceOneRun({ pool, env = process.env, log = () => {}, clientFor = null, maxPagesPerSlice = 1 }) {
  const run = await claimRun(pool);
  if (!run) return null;
  const got = clientFor ? await clientFor(run.mode) : await aiArkFor(run.mode, { env, db: pool });
  const ctx = { pool, env, log, run, client: got.client, progress: run.progress ?? {}, pulled: run.pulled };

  if (!got.client) {
    await pool.query(
      `UPDATE aiark_runs SET status = CASE WHEN status = 'running' THEN 'error' ELSE status END, last_error = $3,
              finished_at = coalesce(finished_at, now()), claim_token = NULL, claimed_at = NULL
        WHERE id = $1 AND claim_token = $2`,
      [run.id, run.claim_token, got.why]
    );
    log(`AI Ark run ${run.id.slice(0, 8)}: ${got.why}`);
    return run.id;
  }

  try {
    if (run.credits_before == null) {
      // The balance is for the record only: a run never waits on it (a bad key fails the first real call).
      const before = await ctx.client.credits().catch(() => null);
      if (before != null) {
        await pool.query(`UPDATE aiark_runs SET credits_before = $3 WHERE id = $1 AND claim_token = $2`, [run.id, run.claim_token, before]);
      }
    }
    if (ctx.pulled >= run.size_requested) {
      await finish(ctx, { status: "done" });
      return run.id;
    }
    if (run.strategy === "single" && listsStale(ctx.progress)) await buildLists(ctx);

    let out = { more: true };
    for (let i = 0; i < maxPagesPerSlice && out.more; i++) {
      out = run.strategy === "export" ? await sliceExport(ctx) : await sliceSingle(ctx);
    }
    if (out.fail) {
      await finish(ctx, { status: "error", lastError: out.fail });
    } else if (out.done !== undefined) {
      await finish(ctx, { status: "done", stopReason: out.done });
    } else if (out.error) {
      const attempts = run.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) await finish(ctx, { status: "error", lastError: out.error.message });
      else await release(ctx, { inMs: 30_000 * 2 ** (attempts - 1), attempts, lastError: out.error.message });
    } else {
      await release(ctx, { inMs: out.wait ?? 0, attempts: 0 });
    }
  } catch (e) {
    if (e instanceof LostClaim) {
      log(`AI Ark run ${run.id.slice(0, 8)}: claim lost mid-slice (reclaimed elsewhere) — stopped`);
    } else if (e instanceof Cancelled) {
      await finish(ctx, { status: "cancelled" });
    } else if (e instanceof AiArkError && e.kind === "credits") {
      await finish(ctx, { status: "stopped", stopReason: "The AI Ark account ran out of credits" });
    } else if (e instanceof AiArkError && e.kind === "key") {
      await finish(ctx, { status: "error", lastError: e.message });
    } else if (e instanceof AiArkError && !e.retryable && e.kind !== "pending_cap") {
      await finish(ctx, { status: "error", lastError: e.message });
    } else {
      const attempts = run.attempts + 1;
      const msg = String(e?.message ?? e).slice(0, 300);
      if (attempts >= MAX_ATTEMPTS) await finish(ctx, { status: "error", lastError: `Gave up after ${attempts} tries: ${msg}` }).catch(() => {});
      else await release(ctx, { inMs: 30_000 * 2 ** (attempts - 1), attempts, lastError: msg }).catch(() => {});
      log(`AI Ark run ${run.id.slice(0, 8)}: ${msg} (try ${attempts} of ${MAX_ATTEMPTS})`);
    }
  }
  return run.id;
}
