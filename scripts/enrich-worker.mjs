#!/usr/bin/env node
// The Clay tab's enrichment worker (Phase 1 of the Clay replacement).
//
// Flow: claim queued enrich_rows (FOR UPDATE SKIP LOCKED, one claim token per
// claim) → load the row's cells → evaluate every column in dependency order
// (scripts/lib/enrich/engine.mjs: the client's own Clay formulas, waterfalls
// and run conditions, plus the actions behind them) → write the cells that
// changed → mark the row done / waiting (a provider key is missing) / error,
// or re-queue it with backoff when a call failed for a reason worth retrying.
//
// Rows run concurrently and independently: a slow AI call never holds up the
// others, and a free slot is refilled as soon as a row finishes.
//
// Crash model: a row is 'running' with a claim token while it is worked. A
// crash leaves it 'running'; after STALE_MIN the sweep re-queues it and it is
// evaluated again. Paid answers are reused when their inputs are unchanged
// (enrich_cells.input_hash), so a re-run never pays twice. Every write is
// fenced on the claim token: a row that was reclaimed meanwhile is left alone.
//
// AI Ark runs (the AI Ark tab) are worked here too, one at a time, in a loop of
// their own beside the rows (scripts/lib/aiark/runs.mjs): each slice pulls a
// page of people into the run's table, and the row loop then works out each
// person's outcome like any other row.
//
// Env: DATABASE_URL (required). OPENAI_API_KEY, CLEARBIT_API_KEY — optional;
// without one, the columns that need it show "Needs key" and the row waits.
// AIARK_API_KEY — live AI Ark runs; AIARK_DEMO=1 — demo runs with made-up
// people (AIARK_DEMO_CREDITS, 25000); AIARK_WEBHOOK_URL — needed only for the
// export strategy; AIARK_RPS (4).
// ENRICH_CONCURRENCY (6), ENRICH_POLL_MS (2000), ENRICH_STALE_MIN (15),
// ENRICH_WORKER_ID ("enrich-worker"), ENRICH_ONCE=1 (drain the queue, then exit).

import os from "node:os";
import pg from "pg";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { order } from "./lib/enrich/formula.mjs";
import { runRow } from "./lib/enrich/engine.mjs";
import { advanceOneRun, runDue } from "./lib/aiark/runs.mjs";
import { PERSON_SEARCH_KEYS } from "./lib/aiark/columns.mjs";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const env = process.env;
const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};
const CONCURRENCY = Math.max(1, Math.min(32, num(env.ENRICH_CONCURRENCY, 6)));
const POLL_MS = Math.max(500, num(env.ENRICH_POLL_MS, 2000));
const STALE_MIN = Math.max(5, num(env.ENRICH_STALE_MIN, 15));
const MAX_ATTEMPTS = 3;
const ONCE = env.ENRICH_ONCE === "1";
const WORKER_ID = env.ENRICH_WORKER_ID || "enrich-worker";
const PROVIDER_KEYS = ["OPENAI_API_KEY", "CLEARBIT_API_KEY"];
const SEARCH_KEYS = [
  ...new Set(["company", "address", "website", "domain", "use_website", "use_domain", "place_id", "phone", "use_city", ...PERSON_SEARCH_KEYS]),
];

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: CONCURRENCY + 3,
  keepAlive: true,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 70_000,
});
pool.on("error", (e) => log(`pg pool idle-client error: ${e.message}`)); // never crash the loop

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shuttingDown = false;
process.on("SIGTERM", () => { shuttingDown = true; log("SIGTERM — finishing rows in flight, then exiting"); });
process.on("SIGINT", () => { shuttingDown = true; });

const stats = { processed: 0, failed: 0, calls: 0 };
let inFlight = 0;
const aiark = { slices: 0, active: null, idle: true };

// ── Table definitions (columns change rarely; re-read every 30 s) ───────────

const defs = new Map();
async function tableDef(id) {
  const hit = defs.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const { rows: [table] } = await pool.query(
    `SELECT id, client_tag, kind, name FROM enrich_tables WHERE id = $1`, [id]);
  if (!table) throw new Error(`table ${id} no longer exists`);
  const { rows: columns } = await pool.query(
    `SELECT key, name, position, kind, action, formula, waterfall, inputs, config, run_if, provider, needs_env, phase
       FROM enrich_columns WHERE table_id = $1 ORDER BY position`, [id]);
  const { rows: counts } = await pool.query(
    `SELECT source_table, count(*)::int AS n FROM imported_company_keys WHERE client_tag = $1 GROUP BY 1`, [table.client_tag]);
  table.keyCounts = Object.fromEntries(counts.map((r) => [r.source_table, r.n]));
  let ordered;
  let orderError = null;
  try {
    ordered = order(columns);
  } catch (e) {
    orderError = e.message;
    ordered = columns;
  }
  const def = { at: Date.now(), table, ordered, orderError };
  defs.set(id, def);
  return def;
}

// ── Queue ───────────────────────────────────────────────────────────────────

async function claim(n) {
  const { rows } = await pool.query(
    `UPDATE enrich_rows r
        SET run_status = 'running', claim_token = $1, claimed_at = now(), attempts = r.attempts + 1, updated_at = now()
      WHERE r.id IN (
        SELECT q.id FROM enrich_rows q
          JOIN enrich_tables t ON t.id = q.table_id AND NOT t.is_paused
         WHERE q.run_status = 'queued' AND q.next_run_at <= now()
         ORDER BY q.next_run_at, q.id
         LIMIT $2
           FOR UPDATE OF q SKIP LOCKED)
      RETURNING r.id, r.table_id, r.run_force, r.attempts, r.created_at, r.claim_token`,
    [randomUUID(), n]
  );
  return rows;
}

async function reclaimStale() {
  const { rowCount } = await pool.query(
    `UPDATE enrich_rows
        SET run_status = 'queued', claim_token = NULL, claimed_at = NULL, next_run_at = now(), updated_at = now()
      WHERE run_status = 'running' AND claimed_at < now() - make_interval(mins => $1)`,
    [STALE_MIN]
  );
  if (rowCount) log(`re-queued ${rowCount} row(s) stuck in 'running' for over ${STALE_MIN} min`);
}

/** Writes cells and run records, but only while this worker still holds the row. */
async function writeCells(r, cells, runs) {
  if (!cells.length && !runs.length) return true;
  const { rows } = await pool.query(
    `WITH ok AS (SELECT 1 FROM enrich_rows WHERE id = $1 AND claim_token = $3),
     c AS (
       INSERT INTO enrich_cells AS e (row_id, column_key, table_id, status, value, display, note, input_hash, runs, updated_at)
       SELECT $1, x.column_key, $2, x.status, x.value, x.display, x.note, x.input_hash, coalesce(x.runs, 0), now()
         FROM jsonb_to_recordset($4::jsonb)
              AS x(column_key text, status text, value jsonb, display text, note text, input_hash text, runs int)
        WHERE EXISTS (SELECT 1 FROM ok)
       ON CONFLICT (row_id, column_key) DO UPDATE
         SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, note = EXCLUDED.note,
             input_hash = EXCLUDED.input_hash, runs = e.runs + EXCLUDED.runs, updated_at = now()
       RETURNING 1),
     h AS (
       INSERT INTO enrich_cell_runs (row_id, column_key, status, provider, request, response, error, http_status, duration_ms, started_at)
       SELECT $1, y.column_key, y.status, y.provider, y.request, y.response, y.error, y.http_status, y.duration_ms, y.started_at
         FROM jsonb_to_recordset($5::jsonb)
              AS y(column_key text, status text, provider text, request jsonb, response jsonb, error text,
                   http_status int, duration_ms int, started_at timestamptz)
        WHERE EXISTS (SELECT 1 FROM ok)
       RETURNING 1)
     SELECT (SELECT count(*) FROM ok)::int AS held, (SELECT count(*) FROM c)::int AS cells, (SELECT count(*) FROM h)::int AS runs`,
    [r.id, r.table_id, r.claim_token, JSON.stringify(cells), JSON.stringify(runs)]
  );
  return rows[0].held > 0;
}

async function finish(r, { status, nextRunAt = null, lastError = null, search = null }) {
  const { rowCount } = await pool.query(
    `UPDATE enrich_rows
        SET run_status = $3, next_run_at = coalesce($4::timestamptz, next_run_at), claim_token = NULL, claimed_at = NULL,
            run_force = NULL, last_error = $5, search_text = coalesce($6, search_text),
            finished_at = CASE WHEN $3 = 'queued' THEN finished_at ELSE now() END, updated_at = now()
      WHERE id = $1 AND claim_token = $2`,
    [r.id, r.claim_token, status, nextRunAt, lastError, search]
  );
  if (!rowCount) log(`row ${r.id}: claim lost before finishing (re-queued elsewhere) — left as is`);
}

// ── One row ─────────────────────────────────────────────────────────────────

async function processRow(r) {
  const def = await tableDef(r.table_id);
  if (def.orderError) {
    await finish(r, { status: "error", lastError: def.orderError });
    return;
  }
  const { rows: stored } = await pool.query(
    `SELECT column_key, status, value, display, note, input_hash FROM enrich_cells WHERE row_id = $1`, [r.id]);
  const cells = new Map(stored.map((c) => [c.column_key, c]));
  const pending = new Map();
  const runs = [];
  let held = true;
  const flush = async () => {
    if (!held) return;
    const batch = [...pending].map(([column_key, c]) => ({ column_key, ...c }));
    const hist = runs.splice(0);
    pending.clear();
    held = await writeCells(r, batch, hist);
  };

  const result = await runRow({
    row: r,
    table: def.table,
    columns: def.ordered,
    cells,
    env,
    db: pool,
    hooks: {
      changed: (key, cell) => pending.set(key, cell),
      running: async (key, prev) => {
        pending.set(key, {
          status: "running", value: prev?.value ?? null, display: prev?.display ?? null,
          note: null, input_hash: prev?.input_hash ?? null, runs: 0,
        });
        await flush();
      },
      ran: async (run) => {
        runs.push(run);
        await flush();
      },
    },
  });
  await flush();
  if (!held) {
    log(`row ${r.id}: claim lost mid-run — stopped writing`);
    return;
  }
  stats.calls += result.calls;

  const search = SEARCH_KEYS.map((k) => result.values[k])
    .filter((v) => typeof v === "string" && v)
    .join(" ")
    .toLowerCase()
    .slice(0, 2000);
  if (result.retryable && r.attempts < MAX_ATTEMPTS) {
    const delay = 30_000 * 2 ** (r.attempts - 1);
    await finish(r, { status: "queued", nextRunAt: new Date(Date.now() + delay).toISOString(), lastError: result.retryable, search });
  } else if (result.errors) {
    await finish(r, { status: "error", lastError: result.retryable ?? `${result.errors} cell(s) failed`, search });
  } else {
    await finish(r, { status: result.needsKey ? "waiting" : "done", search });
  }
  stats.processed++;
}

async function safeProcess(r) {
  try {
    await processRow(r);
  } catch (e) {
    stats.failed++;
    log(`row ${r.id}: ${e.message}`);
    // Put it back with backoff; after MAX_ATTEMPTS it is parked as an error.
    const status = r.attempts < MAX_ATTEMPTS ? "queued" : "error";
    await finish(r, {
      status,
      nextRunAt: new Date(Date.now() + 60_000 * r.attempts).toISOString(),
      lastError: `worker: ${String(e.message).slice(0, 300)}`,
    }).catch((e2) => log(`row ${r.id}: could not release (${e2.message}); the stale sweep will`));
  }
}

// ── Heartbeat (the Clay tab's "worker running" pill) ────────────────────────

async function heartbeat({ starting = false, stopping = false } = {}) {
  const info = {
    concurrency: CONCURRENCY,
    in_flight: inFlight,
    ...stats,
    keys: Object.fromEntries(PROVIDER_KEYS.map((k) => [k, Boolean(env[k])])),
    aiark: {
      key: Boolean(env.AIARK_API_KEY),
      demo: env.AIARK_DEMO === "1",
      webhook: Boolean(env.AIARK_WEBHOOK_URL),
      active_run: aiark.active,
      slices: aiark.slices,
    },
    host: os.hostname(),
    pid: process.pid,
    stopped: stopping,
  };
  await pool.query(
    `INSERT INTO enrich_worker_state (id, started_at, last_seen, info) VALUES ($1, now(), now(), $2)
     ON CONFLICT (id) DO UPDATE
       SET last_seen = now(), info = EXCLUDED.info,
           started_at = CASE WHEN $3::boolean THEN now() ELSE enrich_worker_state.started_at END`,
    [WORKER_ID, info, starting]
  );
}

// ── AI Ark runs (one at a time: the API's rate limit is per key) ────────────

async function aiarkLoop() {
  while (!shuttingDown) {
    let worked = null;
    try {
      worked = await advanceOneRun({ pool, env, log });
      if (worked) aiark.slices++;
    } catch (e) {
      log(`AI Ark loop error: ${e.message}`);
    }
    aiark.active = worked;
    aiark.idle = !worked;
    await sleep(worked ? 50 : POLL_MS);
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  log(`enrich-worker ${WORKER_ID}: concurrency ${CONCURRENCY}, keys: ` +
    [...PROVIDER_KEYS, "AIARK_API_KEY"].map((k) => `${k} ${env[k] ? "set" : "missing"}`).join(", ") +
    (env.AIARK_DEMO === "1" ? ", AI Ark demo on" : "") + (ONCE ? " (drain and exit)" : ""));
  await heartbeat({ starting: true });
  const runs = aiarkLoop();
  let lastSweep = 0;
  let lastBeat = Date.now();
  while (!shuttingDown) {
    try {
      if (Date.now() - lastSweep > 60_000) {
        await reclaimStale();
        lastSweep = Date.now();
      }
      if (Date.now() - lastBeat > 10_000) {
        await heartbeat();
        lastBeat = Date.now();
      }
      const free = CONCURRENCY - inFlight;
      const claimed = free > 0 ? await claim(free) : [];
      for (const r of claimed) {
        inFlight++;
        safeProcess(r).finally(() => { inFlight--; });
      }
      if (ONCE && !claimed.length && inFlight === 0 && aiark.idle && !(await runDue(pool))) break;
      await sleep(claimed.length ? 50 : inFlight ? 250 : POLL_MS);
    } catch (e) {
      log(`loop error: ${e.message}`);
      await sleep(POLL_MS);
    }
  }
  shuttingDown = true;
  const deadline = Date.now() + 25_000;
  while (inFlight > 0 && Date.now() < deadline) await sleep(250);
  if (inFlight > 0) log(`${inFlight} row(s) still in flight at exit — the stale sweep will re-queue them`);
  await Promise.race([runs, sleep(Math.max(0, deadline - Date.now()))]);
  await heartbeat({ stopping: true }).catch(() => {});
  log(`stopped: ${stats.processed} rows processed, ${stats.calls} provider calls, ${stats.failed} failures`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
