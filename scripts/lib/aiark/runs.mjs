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
// Paying twice for a person: everyone bought (or checked and found without an
// email) is kept in aiark_people the moment the call returns, and each run asks
// AI Ark to leave out the most recent 100,000 of them (AI Ark Lists: 10 lists
// of 10,000 a request, 50 lists a day, 24 hours each). Past those limits a
// single run pays for Preview pages of people it then skips, and an export run
// stops rather than post without its lists. Anyone a job still brings back is
// paid for again and written as "Bought before".
//
// Crash and cancel: a slice holds the run with a claim token and a 10-minute
// lease. Cursor writes are fenced on the token; a person already paid for is
// written whoever holds the run. The cursor (progress) is saved after each
// page, so a crash repeats at most one page — and the registry keeps that page
// from buying anyone again. Cancelling sets status 'cancelled', which means no
// new paid calls: a single run stops at its next write, and an export job AI
// Ark has taken is still read to the end, because it is paid for. Credits are
// recorded either way.
//
// A job AI Ark has taken is never dropped over an error: the run backs off and
// tries again until AI Ark has had time to deliver or refund it.

import { randomUUID } from "node:crypto";
import {
  AiArkError, createAiArk, EXPORT_MAX, LIST_MAX, LISTS_PER_DAY, LISTS_PER_REQUEST, PAGE_MAX, SEARCH_CAP, personInputs,
} from "./client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./demo.mjs";
import { PERSON_SEARCH_KEYS, RUN_COLUMNS, RUN_INPUT_KEYS } from "./columns.mjs";

export const LEASE_MIN = 10;
const MAX_ATTEMPTS = 6;
const BACKOFF_MAX_MS = 15 * 60_000;
const LIST_BUDGET = LISTS_PER_DAY - 5; // a few spare for anyone using the key by hand
const LIST_REFRESH_MS = 23 * 3600_000; // lists younger than this stay in use
const LIST_LIFE_MS = 24 * 3600_000; // AI Ark drops a list after 24 h
const EXPORT_POLL_MS = 15_000;
const EXPORT_WAIT_MAX_MS = 11 * 3600_000; // AI Ark auto-refunds a job it can't deliver within ~10 h, so by 11 it has delivered or refunded
const PROCESSING_WAIT_MS = 2 * 3600_000; // per page: how long to wait for emails AI Ark is still checking
const PROCESSING_POLL_MS = 30_000;
const OTHER_JOB_WAIT_MS = 30_000;
const ADOPT_WINDOW_MS = 120_000;
const REFUND_LOOKUP_PAGES = 5;
const LOST_ANSWERS_MAX = 5; // Export Single answers lost in a row before the run backs off
const WRITE_RETRIES = 3;
const WRITE_RETRY_MS = 500;
export const DEMO_WEBHOOK = "https://demo.invalid/api/aiark/webhook"; // .invalid never resolves; the demo sends nothing

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Number(n).toLocaleString("en-US");
const backoffMs = (attempts) => Math.min(30_000 * 2 ** (attempts - 1), BACKOFF_MAX_MS);

/**
 * The most a run may spend: a brake on a run that keeps paying without gaining
 * people, not a client's budget. Its size at full price, a quarter on top, and
 * a little room for each search.
 */
const spendCeiling = (run) => Math.ceil(run.size_requested * 1.25) + 5 * run.requests.length + 10;
const brakeReason = (run, used) =>
  `Stopped by the run's spending brake: ${fmt(used)} credits used against a limit of ${fmt(spendCeiling(run))} for ${fmt(run.size_requested)} people. Going on could pass it, so nothing more was bought.`;

// ── Clients ─────────────────────────────────────────────────────────────────

let liveClient = null;
let demoTransport = null;

/**
 * The AI Ark client for a mode: { client } or { client: null, why }. The demo
 * transport is kept for the life of the process (its export jobs and lists
 * outlive a slice); its credit balance is re-read from the demo runs' spend.
 * AI Ark's rate limit is per key, so each process gets its own share of it:
 * `rps` is the web app's (see src/lib/aiark/server.ts), AIARK_RPS the worker's.
 *
 * @param {"live" | "demo"} mode
 * @param {{ env?: Record<string, string | undefined>, db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, rps?: number | null }} opts
 * @returns {Promise<{ client: ReturnType<typeof createAiArk> | null, why?: string }>}
 */
export async function aiArkFor(mode, { env = process.env, db, rps = null }) {
  if (mode === "demo") {
    if (env.AIARK_DEMO !== "1") return { client: null, why: "Demo runs are off (AIARK_DEMO=1 turns them on)" };
    const base = num(env.AIARK_DEMO_CREDITS, 25_000);
    const { rows } = await db.query(`SELECT coalesce(sum(credits_used), 0)::float8 AS used FROM aiark_runs WHERE mode = 'demo'`);
    if (!demoTransport) demoTransport = createDemoTransport({ latencyMs: num(env.AIARK_DEMO_LATENCY_MS, 120) });
    demoTransport.state.balance = Math.max(0, base - Number(rows[0].used));
    return { client: createAiArk({ token: DEMO_TOKEN, transport: demoTransport, rps: 5 }) };
  }
  const token = String(env.AIARK_API_KEY ?? "").trim();
  if (!token) return { client: null, why: "Needs AIARK_API_KEY" };
  if (/[^\x20-\x7e]/.test(token)) return { client: null, why: "AIARK_API_KEY has a line break or invalid character" };
  const rate = rps ?? num(env.AIARK_RPS, 4);
  if (!liveClient || liveClient.token !== token || liveClient.rate !== rate) {
    liveClient = { token, rate, client: createAiArk({ token, rps: rate }) };
  }
  return { client: liveClient.client };
}

/**
 * The webhook AI Ark needs for export jobs, or why there is none. AI Ark's
 * completion POST carries every exported person and email, so it must be
 * public, HTTPS, this app's route and, when NEXT_PUBLIC_SITE_URL is set, on
 * this app's host. Without that variable the host cannot be checked.
 */
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
  const site = String(env.NEXT_PUBLIC_SITE_URL ?? "").trim();
  if (site) {
    let host = null;
    try {
      host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname;
    } catch {
      /* not an address: nothing to compare with */
    }
    if (host && u.hostname !== host) return { url: null, why: `AIARK_WEBHOOK_URL must be on this app's own host (${host})` };
  }
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

// Runs with work left. A cancelled run stays here while it holds an export job:
// that job is paid for, and the worker sets finished_at once it has been read.
const HAS_WORK = `(q.status IN ('queued', 'running')
                   OR (q.status = 'cancelled' AND q.finished_at IS NULL AND jsonb_typeof(q.progress->'job') = 'object'))`;

async function claimRun(pool) {
  const { rows } = await pool.query(
    `UPDATE aiark_runs r
        SET claim_token = $1, claimed_at = now(), started_at = coalesce(r.started_at, now()),
            status = CASE WHEN r.status = 'cancelled' THEN 'cancelled' ELSE 'running' END
      WHERE r.id = (
        SELECT q.id FROM aiark_runs q
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

/** Is any run due now? (The worker's drain-and-exit mode asks.) */
export async function runDue(pool) {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM aiark_runs q WHERE ${HAS_WORK} AND q.next_run_at <= now()
                     AND (q.claim_token IS NULL OR q.claimed_at < now() - make_interval(mins => $1))) AS due`,
    [LEASE_MIN]
  );
  return rows[0].due;
}

class LostClaim extends Error {}
class Cancelled extends Error {}

/**
 * Saves the cursor mid-slice (fenced). This is where a cancel stops a slice
 * with no job AI Ark has taken, so nothing is posted after it. A job it has
 * taken is paid for and keeps being read.
 */
async function savePosition(ctx) {
  const { rows } = await ctx.pool.query(
    `UPDATE aiark_runs SET progress = $3, claimed_at = now() WHERE id = $1 AND claim_token = $2 RETURNING status`,
    [ctx.run.id, ctx.run.claim_token, ctx.progress]
  );
  if (!rows[0]) throw new LostClaim();
  if (rows[0].status === "cancelled" && !ctx.progress.job?.track_id) {
    ctx.progress = { ...ctx.progress, job: null };
    throw new Cancelled();
  }
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
            stop_reason = coalesce($4, stop_reason),
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

const waitedTooLong = (job) => Date.now() - Date.parse(job.submitted_at ?? job.submitting_at) > EXPORT_WAIT_MAX_MS;

function notRead(job) {
  const hours = EXPORT_WAIT_MAX_MS / 3600_000;
  return job.track_id
    ? `Gave up on AI Ark's export ${job.track_id} after ${hours} hours: its people were not read${job.page ? ` past page ${job.page}` : ""}.`
    : `Gave up after ${hours} hours on an export whose answer never arrived: if AI Ark took it, its people were not read.`;
}

/**
 * An error while holding a job AI Ark may have charged for: back off and try
 * again, up to the limit. A job AI Ark has delivered still gets its tries past
 * the limit, so one short outage can't cost the pages left to read.
 */
async function holdJob(ctx, why) {
  const { run, log, progress: { job } } = ctx;
  const msg = String(why ?? "").slice(0, 300);
  const attempts = run.attempts + 1;
  if (waitedTooLong(job) && (!job.done_at || attempts >= MAX_ATTEMPTS)) {
    await finish(ctx, { status: "error", lastError: `${notRead(job)} Last error: ${msg}` }).catch(() => {});
    return;
  }
  await release(ctx, { inMs: backoffMs(attempts), attempts, lastError: msg }).catch(() => {});
  log?.(`AI Ark run ${run.id.slice(0, 8)}: ${msg} (holding its export, try ${attempts})`);
}

/** Credits AI Ark charged outside a person write (a Preview page). Recorded even on a cancelled run. */
async function addCredits(ctx, n) {
  if (!n) return;
  const { rows } = await ctx.pool.query(
    `UPDATE aiark_runs SET credits_used = credits_used + $2, claimed_at = CASE WHEN claim_token = $3 THEN now() ELSE claimed_at END
      WHERE id = $1 RETURNING status, claim_token = $3 AS held`,
    [ctx.run.id, n, ctx.run.claim_token]
  );
  if (!rows[0]?.held) throw new LostClaim();
  if (rows[0].status === "cancelled") throw new Cancelled();
}

/**
 * One person into the run's table, the registry and the run's counters — one
 * statement, so a crash never leaves a paid person half-recorded. Everything
 * is written even if the claim was lost, since the person is paid for by then,
 * and ON CONFLICT keeps a repeat harmless; the slice stops right after.
 */
async function writePersonOnce(ctx, { inputs, credits, pulledBefore = null }) {
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
       SELECT $3::uuid, $4::uuid, $5::text, $6::text
       ON CONFLICT (table_id, row_key) DO NOTHING
       RETURNING id
     ), c AS (
       INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
       SELECT r.id, kv.key, $3::uuid, 'done', to_jsonb(kv.value), left(kv.value, 300)
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
              credits_used = credits_used + $14,
              claimed_at = CASE WHEN claim_token = $2 THEN now() ELSE claimed_at END
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
  // An export job is paid for as a whole, so its reading carries on to the end.
  if (r.status === "cancelled" && ctx.run.strategy === "single") throw new Cancelled();
  return r;
}

/** A paid answer lives only in memory until it is written, so a failed write is tried again. */
async function writePerson(ctx, person) {
  for (let tries = 0; ; tries++) {
    try {
      return await writePersonOnce(ctx, person);
    } catch (e) {
      if (e instanceof LostClaim || e instanceof Cancelled || tries >= WRITE_RETRIES) throw e;
      await sleep(WRITE_RETRY_MS * (tries + 1));
    }
  }
}

// ── Exclusion lists ─────────────────────────────────────────────────────────

const listsStale = (p) => !p.lists_at || Date.now() - Date.parse(p.lists_at) > LIST_REFRESH_MS;
const listsAlive = (p) => Boolean(p.lists_at) && Date.now() - Date.parse(p.lists_at) < LIST_LIFE_MS;

/**
 * Asks AI Ark to leave out the people already bought: the most recent up to
 * 10 × 10,000, as far as today's list budget allows. Lists are reused, because
 * the budget is what runs out: while they are younger than 23 hours, people
 * registered since get one more list. Only when that can't be done does a
 * rebuild replace them, and never with fewer than the run already holds.
 *
 * Lists are made one at a time and saved as they are made, so a retry carries
 * on instead of spending the budget again. An error worth retrying is rethrown
 * (a run that can't get past it ends like any other); a list AI Ark refuses
 * outright ends the attempt with what was made.
 *
 * progress.lists_short says the lists fall short of what they should cover.
 * A single run carries on with a note, because it checks the registry before
 * buying. An export run does not post, because those people would be bought
 * again.
 */
async function buildLists(ctx) {
  const { pool, client, run } = ctx;
  const demo = run.mode === "demo";
  const p = ctx.progress;
  const { rows: [{ made }] } = await pool.query(
    `SELECT count(*)::int AS made
       FROM aiark_runs r, jsonb_array_elements_text(coalesce(r.progress->'lists_log', '[]'::jsonb)) AS t(at)
      WHERE r.mode = $1 AND t.at::timestamptz > now() - interval '24 hours'`,
    [run.mode]
  );
  const { rows: [{ held, fresh, at }] } = await pool.query(
    `SELECT count(*)::int AS held, count(*) FILTER (WHERE pulled_at >= $2::timestamptz)::int AS fresh, now()::text AS at
       FROM aiark_people WHERE demo = $1 AND pulled_at < now()`,
    [demo, p.lists_through ?? null]
  );
  const budget = Math.max(0, LIST_BUDGET - made);
  const want = Math.min(held, LISTS_PER_REQUEST * LIST_MAX);
  const alive = listsAlive(p);
  const lists = alive ? p.lists ?? [] : [];
  const covered = alive ? p.excluded ?? 0 : 0;

  // plan: the lists being made. { adds: true } joins the run's lists, anything else replaces them.
  const resumed = Boolean(p.lists_new) && Date.now() - Date.parse(p.lists_new.started) < LIST_REFRESH_MS;
  let plan = resumed ? p.lists_new : null;
  if (!plan) {
    const reusable = !listsStale(p) && covered + fresh >= want;
    const more = Math.ceil(fresh / LIST_MAX);
    if (reusable && fresh && more <= budget && lists.length + more <= LISTS_PER_REQUEST) plan = { adds: true, since: p.lists_through, want: fresh };
    else if (reusable && !fresh) plan = null;
    else if (Math.ceil(want / LIST_MAX) <= budget) plan = { want };
    else if (run.strategy === "single" && Math.min(budget * LIST_MAX, want) > covered) plan = { want: budget * LIST_MAX };
    if (plan) plan = { ...plan, at, started: new Date().toISOString(), ids: [], count: 0 };
  }

  let refused = null;
  for (let left = budget; plan && plan.count < plan.want && left > 0; left--) {
    const { rows } = await pool.query(
      `SELECT person_id FROM aiark_people
        WHERE demo = $1 AND pulled_at < $2::timestamptz AND ($3::timestamptz IS NULL OR pulled_at >= $3::timestamptz)
        ORDER BY pulled_at DESC, person_id OFFSET $4 LIMIT $5`,
      [demo, plan.at, plan.since ?? null, plan.count, Math.min(LIST_MAX, plan.want - plan.count)]
    );
    if (!rows.length) break;
    let id;
    try {
      id = await client.createList(rows.map((x) => x.person_id));
    } catch (e) {
      if (!(e instanceof AiArkError) || e.retryable || e.kind === "key" || e.kind === "credits") throw e;
      refused = e.message;
      break;
    }
    plan = { ...plan, ids: [...plan.ids, id], count: plan.count + rows.length };
    ctx.progress = { ...ctx.progress, lists_new: plan, lists_log: [...(ctx.progress.lists_log ?? []), new Date().toISOString()] };
    await savePosition(ctx);
  }

  let ids = lists;
  let excluded = covered;
  let listsAt = alive ? p.lists_at : null;
  let through = p.lists_through ?? null;
  let leftOut = fresh;
  if (plan?.adds) {
    ids = [...lists, ...plan.ids];
    excluded = covered + plan.count;
    leftOut = plan.want - plan.count;
    if (!leftOut) through = plan.at;
  } else if (plan && (plan.count >= covered || !alive)) {
    ids = plan.ids;
    excluded = plan.count;
    listsAt = plan.started;
    through = plan.at;
    leftOut = 0;
  }
  const short = excluded < want || leftOut > 0;
  const note = refused
    ? `AI Ark refused an exclusion list (${refused}); the rest are left out.`
    : short
      ? `Not enough exclusion lists left today (AI Ark allows ${LISTS_PER_DAY} a day): they cover ${fmt(excluded)} of the ${fmt(want)} people they should, so people bought before may come back.`
      : excluded < held
        ? `Left out the ${fmt(excluded)} most recently bought of ${fmt(held)} people (AI Ark takes 100,000 a search).`
        : null;
  // New lists change what a search returns, so a single run's page number means nothing any more.
  const changed = ids.join() !== (p.lists ?? []).join();
  ctx.progress = {
    ...ctx.progress,
    lists: ids,
    lists_at: listsAt,
    lists_through: through,
    lists_new: null,
    excluded,
    lists_short: short,
    lists_note: note,
    ...(changed && run.strategy === "single" ? { page: 0 } : {}),
  };
  await savePosition(ctx);
  // People registered while a cut-short rebuild waited still need their list.
  if (resumed) await buildLists(ctx);
}

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
    // AI Ark pages through 10,000 matches per search at most. Going deeper would
    // take excluding everyone seen and starting over; a run stops at the cap
    // instead, short of its size if it must, and its stop reason says so.
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
  let lostInARow = 0;
  let stopping = false;
  for (const item of res.content) {
    if (ctx.pulled >= run.size_requested) break;
    if (!item?.id || mine.has(item.id)) continue;
    if (held.has(item.id)) {
      skipped++;
      continue;
    }
    if (ctx.shouldStop()) {
      stopping = true;
      break;
    }
    let got;
    try {
      got = await ctx.client.exportSingle(item.id);
      lostInARow = 0;
    } catch (e) {
      if (!(e instanceof AiArkError) || (e.kind !== "network" && e.kind !== "server")) throw e;
      // The answer is gone and AI Ark may have charged for it. The person stays
      // unregistered, so a later run can buy them; an outage is rethrown so the
      // run backs off instead of walking the page.
      ctx.progress = { ...ctx.progress, lost_answers: (ctx.progress.lost_answers ?? 0) + 1 };
      if (++lostInARow >= LOST_ANSWERS_MAX) throw e;
      continue;
    }
    // No email: AI Ark sends nothing (and charges nothing), so the row keeps
    // what Preview showed — the last name stays masked.
    await writePerson(ctx, { inputs: got.found ? personInputs(got.person) : personInputs(item), credits: got.credits });
    held.add(item.id);
  }
  if (skipped) {
    await ctx.pool.query(`UPDATE aiark_runs SET skipped_held = skipped_held + $2 WHERE id = $1`, [run.id, skipped]);
  }
  if (stopping) {
    // The page repeats on resume; the registry skips everyone it already bought.
    ctx.progress = { ...ctx.progress, matches };
    return { wait: 0 };
  }

  const lastPage = res.content.length < PAGE_MAX || (page + 1) * PAGE_MAX >= res.totalElements;
  ctx.progress = { ...ctx.progress, matches, ...(lastPage ? { chunk: chunk + 1, page: 0 } : { page: page + 1 }) };
  await savePosition(ctx);
  if (ctx.pulled >= run.size_requested) return { done: null };
  if (lastPage && chunk + 1 >= run.requests.length) return { done: endReason(ctx.progress) };
  return { more: true };
}

// ── export: async jobs, read by polling ─────────────────────────────────────

/**
 * The submissions that could be this job's: made around the same moment, the
 * same size, not refunded, and not any run's already.
 */
async function adoptionCandidates(ctx, job) {
  const at = Date.parse(job.submitting_at);
  const subs = await ctx.client.exportSubmissions({ size: 100 });
  const near = subs.filter((s) => s.trackId && !s.fullyRefunded && Number(s.requestSize) === job.size && Math.abs(Date.parse(s.created) - at) <= ADOPT_WINDOW_MS);
  if (!near.length) return [];
  const { rows } = await ctx.pool.query(
    `SELECT t.id FROM unnest($1::text[]) AS t(id)
      WHERE NOT EXISTS (SELECT 1 FROM aiark_runs r WHERE r.progress->'track_ids' ? t.id OR r.progress #>> '{job,track_id}' = t.id)`,
    [near.map((s) => s.trackId)]
  );
  return rows.map((r) => r.id);
}

/**
 * Does AI Ark list this job as refunded? Newest first, so older ones can be
 * ruled out. The row's own flag decides, not the filter: a yes here buys again.
 */
async function refundedAtAiArk(ctx, job) {
  const since = Date.parse(job.submitted_at ?? job.submitting_at) - 3600_000;
  for (let page = 0; page < REFUND_LOOKUP_PAGES; page++) {
    const subs = await ctx.client.exportSubmissions({ page, size: 100, fullyRefunded: true });
    if (subs.some((s) => s.trackId === job.track_id && s.fullyRefunded === true)) return true;
    if (subs.length < 100 || subs.some((s) => Date.parse(s.created) < since)) return false;
  }
  return false;
}

/** AI Ark answered 403 or 404 for a held job. A 404 never buys anything by itself: only a refund does. */
async function lostJob(ctx, e) {
  const { job } = ctx.progress;
  if (e.kind === "refunded" || (await refundedAtAiArk(ctx, job))) return resubmit(ctx, e);
  const read = ctx.pulled - (job.pulled_at_submit ?? ctx.pulled);
  return {
    fail: `AI Ark no longer has export ${job.track_id} and does not show it as refunded. ${fmt(read)}${job.total == null ? "" : ` of its ${fmt(job.total)}`} people were read before it went, and it was not bought again.`,
  };
}

/** A refunded job: its price comes off, and what is still owed goes out again, leaving out everyone already written. */
async function resubmit(ctx, e) {
  const { run } = ctx;
  const { job } = ctx.progress;
  const resubmits = (ctx.progress.resubmits ?? 0) + 1;
  const next = { ...ctx.progress, job: null, resubmits, last_refund: e.message };
  const { rows: [w] } = await ctx.pool.query(
    `UPDATE aiark_runs SET credits_used = credits_used - $3, progress = $4, claimed_at = now()
      WHERE id = $1 AND claim_token = $2 RETURNING status`,
    [run.id, run.claim_token, job.charged ? job.price ?? 0 : 0, next]
  );
  if (!w) throw new LostClaim();
  ctx.progress = next;
  if (w.status === "cancelled") throw new Cancelled();
  if (resubmits > 3) return { fail: `AI Ark refunded this run's export ${resubmits} times in a row (${e.message})` };
  ctx.log?.(`AI Ark run ${run.id.slice(0, 8)}: ${e.message} — submitting again`);
  return { wait: 5_000 };
}

async function sliceExport(ctx) {
  const { run } = ctx;
  let p = ctx.progress;
  const chunk = p.chunk ?? 0;
  let job = p.job ?? null;
  if (!job && chunk >= run.requests.length) return { done: "No more matches" };

  // A submission whose answer never arrived: adopt it if AI Ark has it.
  if (job && !job.track_id) {
    const found = await adoptionCandidates(ctx, job);
    if (found.length > 1) {
      return { stop: `The answer to this run's export never arrived, and AI Ark shows ${found.length} exports that could be it: ${found.join(", ")}. Nothing more was sent; an operator needs to check which is ours.` };
    }
    if (found.length) {
      job = { ...job, track_id: found[0], submitted_at: job.submitting_at, adopted: true };
    } else if (Date.now() - Date.parse(job.submitting_at) < ADOPT_WINDOW_MS) {
      return { wait: EXPORT_POLL_MS, hold: true };
    } else {
      job = null; // never reached AI Ark: submit again
    }
    ctx.progress = p = { ...p, job, ...(job ? { track_ids: [...(p.track_ids ?? []), job.track_id] } : {}) };
    await savePosition(ctx);
    if (!job && run.attempts >= MAX_ATTEMPTS) return { fail: `Gave up after ${run.attempts} tries: ${run.last_error ?? "AI Ark did not take the export"}` };
  }

  if (!job) {
    const remaining = run.size_requested - ctx.pulled;
    if (remaining <= 0) return { done: null };
    const hook = webhookFor(run.mode, ctx.env);
    if (!hook.url) return { fail: hook.why };
    // One unread export job per mode: two jobs out at once can't leave out each
    // other's people, so whatever they share is paid for twice. This comes
    // before the lists, which must include the people the other job brings in.
    const { rows: [{ used, busy }] } = await ctx.pool.query(
      `SELECT r.credits_used::float8 AS used,
              EXISTS (SELECT 1 FROM aiark_runs q
                       WHERE q.id <> r.id AND q.mode = r.mode AND ${HAS_WORK} AND jsonb_typeof(q.progress->'job') = 'object') AS busy
         FROM aiark_runs r WHERE r.id = $1`,
      [run.id]
    );
    if (busy) return { wait: OTHER_JOB_WAIT_MS, hold: true };
    const size = Math.min(remaining, EXPORT_MAX);
    if (used + size > spendCeiling(run)) return { stop: brakeReason(run, used) };
    await buildLists(ctx);
    p = ctx.progress;
    if (p.lists_short) {
      return { stop: `The day's exclusion list budget ran out, so this run stopped rather than pay again for people already bought. A later run can carry on. ${p.lists_note ?? ""}`.trim() };
    }
    job = { submitting_at: new Date().toISOString(), size, chunk, pulled_at_submit: ctx.pulled };
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
    if (started.empty) {
      // Taken as no matches here (see exportStart): on to the next location group.
      ctx.progress = { ...p, job: null, chunk: chunk + 1 };
      await savePosition(ctx);
      return chunk + 1 >= run.requests.length ? { done: "No more matches" } : { more: true };
    }
    job = { ...job, track_id: started.trackId, submitted_at: new Date().toISOString() };
    ctx.progress = p = { ...p, job, track_ids: [...(p.track_ids ?? []), started.trackId] };
    await savePosition(ctx);
    return { wait: Math.min(EXPORT_POLL_MS, 5_000) };
  }

  if (!job.done_at) {
    let st;
    try {
      st = await ctx.client.exportStatus(job.track_id);
    } catch (e) {
      if (e instanceof AiArkError && (e.kind === "refunded" || e.kind === "expired")) return lostJob(ctx, e);
      throw e;
    }
    if (st.state !== "DONE") {
      if (waitedTooLong(job)) return { fail: notRead(job) };
      ctx.progress = { ...p, job: { ...job, state: st.state, total: st.total, found: st.found } };
      await savePosition(ctx);
      return { wait: EXPORT_POLL_MS };
    }
    // The job's price, from AI Ark's own count: 0.5 for everyone exported and
    // 0.5 for each email found. Recorded once, with the cursor, in one write,
    // and kept on the job so a refund can take it off again.
    const price = job.charged ? job.price : 0.5 * st.total + 0.5 * st.found;
    const priced = { ...job, state: "DONE", total: st.total, found: st.found, done_at: new Date().toISOString(), page: job.page ?? 0, charged: true, price };
    const next = { ...p, job: priced };
    const { rows: [w] } = await ctx.pool.query(
      `UPDATE aiark_runs SET credits_used = credits_used + $3, progress = $4, claimed_at = now()
        WHERE id = $1 AND claim_token = $2 RETURNING status`,
      [run.id, run.claim_token, job.charged ? 0 : price, next]
    );
    if (!w) throw new LostClaim();
    ctx.progress = p = next;
    job = priced;
  }

  let res;
  try {
    res = await ctx.client.exportResults(job.track_id, { page: job.page ?? 0, size: PAGE_MAX });
  } catch (e) {
    if (e instanceof AiArkError && (e.kind === "refunded" || e.kind === "expired")) return lostJob(ctx, e);
    if (e instanceof AiArkError && e.kind === "not_ready") {
      if (waitedTooLong(job)) return { fail: notRead(job) };
      ctx.progress = { ...p, job: { ...job, done_at: null } };
      await savePosition(ctx);
      return { wait: EXPORT_POLL_MS };
    }
    throw e;
  }
  // Emails AI Ark is still checking: this page waits a while, then is written
  // with what it has. Past the job's limit no page waits at all, so the wait
  // can't cost the pages after it.
  if (res.content.some((x) => String(x?.email?.state ?? "").toUpperCase() === "PROCESSING")) {
    const since = job.page_wait_since ?? new Date().toISOString();
    if (Date.now() - Date.parse(since) < PROCESSING_WAIT_MS && !waitedTooLong(job)) {
      if (!job.page_wait_since) {
        ctx.progress = p = { ...p, job: { ...job, page_wait_since: since } };
        await savePosition(ctx);
      }
      return { wait: PROCESSING_POLL_MS };
    }
  }

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
    if (ctx.shouldStop()) return { wait: 0 }; // the page is read again on resume, and rows already written stay as they are
    const prev = before.get(item.id);
    const pulledBefore = prev ? `Bought ${new Date(prev.pulled_at).toISOString().slice(0, 10)}${prev.run_id ? ` (run ${String(prev.run_id).slice(0, 6)})` : ""}` : null;
    // Paid for with the job (above), not per person.
    await writePerson(ctx, { inputs: personInputs(item), credits: 0, pulledBefore });
  }

  const lastPage = res.last || !res.content.length;
  if (!lastPage) {
    ctx.progress = { ...p, job: { ...job, page: (job.page ?? 0) + 1, page_wait_since: null } };
    await savePosition(ctx);
    return { more: true };
  }
  // The job is read. Fewer people than asked, or nobody this run didn't already
  // have, means this location group is used up: asking again would only pay again.
  const added = ctx.pulled - (job.pulled_at_submit ?? ctx.pulled);
  const usedUp = (job.total ?? 0) < job.size || added === 0;
  const nextChunk = usedUp ? chunk + 1 : chunk;
  ctx.progress = { ...p, job: null, chunk: nextChunk, jobs_done: (p.jobs_done ?? 0) + 1, resubmits: 0 };
  await savePosition(ctx);
  if (ctx.pulled >= run.size_requested) return { done: null };
  if (nextChunk >= run.requests.length) return { done: "No more matches" };
  return { more: true };
}

// ── One slice ───────────────────────────────────────────────────────────────

/**
 * Claims one due run, works one slice of it and lets go. Returns the run's id
 * when one was worked, null when nothing was due.
 *
 * `clientFor(mode)` replaces aiArkFor (tests use it to inject faults).
 * `shouldStop()` is checked between people: when it turns true the slice lets
 * go of the run at once, so a restart need not wait out the lease.
 */
export async function advanceOneRun({ pool, env = process.env, log = () => {}, clientFor = null, maxPagesPerSlice = 1, shouldStop = () => false }) {
  const run = await claimRun(pool);
  if (!run) return null;
  const got = clientFor ? await clientFor(run.mode) : await aiArkFor(run.mode, { env, db: pool });
  const ctx = { pool, env, log, run, client: got.client, progress: run.progress ?? {}, pulled: run.pulled, shouldStop };

  if (!got.client) {
    if (ctx.progress.job) {
      await holdJob(ctx, got.why);
      return run.id;
    }
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
    // A job in hand is read whatever the count or the spend: reading is free and the job is paid for.
    if (!ctx.progress.job) {
      if (ctx.pulled >= run.size_requested) {
        await finish(ctx, { status: "done" });
        return run.id;
      }
      if (Number(run.credits_used) >= spendCeiling(run)) {
        await finish(ctx, { status: "stopped", stopReason: brakeReason(run, Number(run.credits_used)) });
        return run.id;
      }
    }
    if (run.strategy === "single" && listsStale(ctx.progress)) await buildLists(ctx);

    let out = { more: true };
    for (let i = 0; i < maxPagesPerSlice && out.more && !shouldStop(); i++) {
      out = run.strategy === "export" ? await sliceExport(ctx) : await sliceSingle(ctx);
    }
    if (out.fail) {
      await finish(ctx, { status: "error", lastError: out.fail });
    } else if (out.stop) {
      await finish(ctx, { status: "stopped", stopReason: out.stop });
    } else if (out.done !== undefined) {
      await finish(ctx, { status: "done", stopReason: out.done });
    } else if (out.error) {
      // A lost export answer: the next slice looks for the job first, and the
      // tries run out there, once it is clear AI Ark has nothing of ours.
      const attempts = run.attempts + 1;
      await release(ctx, { inMs: backoffMs(attempts), attempts, lastError: out.error.message });
    } else if (out.hold) {
      await release(ctx, { inMs: out.wait, attempts: run.attempts, lastError: run.last_error });
    } else {
      await release(ctx, { inMs: out.wait ?? 0, attempts: 0 });
    }
  } catch (e) {
    if (e instanceof LostClaim) {
      log(`AI Ark run ${run.id.slice(0, 8)}: claim lost mid-slice (reclaimed elsewhere) — stopped`);
    } else if (e instanceof Cancelled) {
      await finish(ctx, { status: "cancelled" });
    } else if (ctx.progress.job) {
      await holdJob(ctx, e?.message ?? e);
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
      else await release(ctx, { inMs: backoffMs(attempts), attempts, lastError: msg }).catch(() => {});
      log(`AI Ark run ${run.id.slice(0, 8)}: ${msg} (try ${attempts} of ${MAX_ATTEMPTS})`);
    }
  }
  return run.id;
}
