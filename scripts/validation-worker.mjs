#!/usr/bin/env node
// validation-worker.mjs — spend Reoon's DAILY credits on email validation, then
// wait for them to replenish, until every address has been checked.
//
// Railway cron, hourly. Each run is short and stateless in memory; all progress
// lives in the database (migration 099), so a run can die anywhere and the next
// one carries on.
//
//   1. RECONCILE  poll Reoon bulk tasks already submitted; apply finished ones
//   2. REFILL     once a day, queue unvalidated leads eligible for active clients
//   3. SUBMIT     if no task is in flight and daily credits remain, claim the
//                 next batch and hand it to Reoon as one bulk task
//
// Usage:
//   node scripts/validation-worker.mjs              normal run
//   node scripts/validation-worker.mjs --dry-run    balance + claim preview, no writes, no spend
//   node scripts/validation-worker.mjs --max=20     cap the task size (testing)
//   node scripts/validation-worker.mjs --no-refill  skip the client-refill step
//
// ⚠ RESULTS GO TO email_validations, NEVER leads.validation_status. Client
// decision 2026-09-14: the push/export gates read leads.validation_status, and
// campaign logic must not change while the backfill runs. See migration 099.
//
// Why these choices (Reoon behaviour, checked 2026-09-14):
//   * BULK endpoint, not the single-address one. Reoon's docs cap the single
//     endpoint at 5 concurrent threads; the export path ran 12 and wedged. A bulk
//     task takes up to 50,000 addresses and Reoon paces it server-side (power mode).
//   * Budget comes from remaining_daily_credits ONLY. The account holds 0 instant
//     credits today; if some are bought later, this worker still stops at the
//     daily balance, so it can never spend pay-as-you-go credit.
//   * Reoon documents neither the reset time nor the allotment size. Every
//     balance read is logged to validation_balance_log so both are learned from
//     data instead of assumed.
//   * "unknown" verdicts are refunded by Reoon, so they cost nothing to re-check.

import pg from "pg";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};
const DRY = !!flag("dry-run");
const NO_REFILL = !!flag("no-refill");
const MAX_OVERRIDE = Number(flag("max"));

const num = (v, dflt) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : dflt);
const API_KEY = process.env.REOON_API_KEY;
const RESERVE = num(process.env.VALIDATION_DAILY_RESERVE, 2000);      // left for anything else using the key
const TASK_SIZE = Math.min(num(process.env.VALIDATION_TASK_SIZE, 25000), 50000); // Reoon max 50k/task
const MIN_TASK = num(process.env.VALIDATION_MIN_TASK, 200);           // not worth a task below this
const TTL_DAYS = num(process.env.VALIDATION_REVALIDATE_DAYS, 90);
const CLIENT_CAP = num(process.env.VALIDATION_CLIENT_REFILL_CAP, 10000);
const QUEUE_MAX = num(process.env.VALIDATION_QUEUE_MAX, 300000);
const TASK_STALE_HOURS = 72;
const WINDOW = 100000;        // leads scanned per backfill window
const MAX_WINDOWS = 40;       // per run — bounds the claim at ~4M rows scanned
const MAX_ATTEMPTS = 5;
const REOON = "https://emailverifier.reoon.com/api/v1";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

if (!API_KEY || !process.env.DATABASE_URL) {
  console.error("REOON_API_KEY and DATABASE_URL are required");
  process.exit(1);
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...m) => console.log(ts(), ...m);

// WATCHDOG — die before the next hourly firing. Railway skips a firing while the
// previous container still runs, so one hung run would silently stop them all.
// Exit 0: freeing the schedule slot is not a failure (nonzero on a cron service
// with a restart policy crash-loops it). Every step below is resumable.
setTimeout(() => {
  console.error("WATCHDOG: exceeded 50 min — exiting so the next firing is not skipped");
  process.exit(0);
}, 50 * 60_000).unref();

// ── database ────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, keepAlive: true });
pool.on("error", (e) => log(`pg pool: ${e.message}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TRANSIENT = /Connection terminated|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|terminating connection|server closed|statement timeout|deadlock detected/i;

async function q(text, params, attempts = 4) {
  for (let i = 1; ; i++) {
    try { return await pool.query(text, params); }
    catch (e) {
      if (i >= attempts || !TRANSIENT.test(String(e?.message))) throw e;
      await sleep(1000 * i * i);
    }
  }
}

/** Run fn(client) inside BEGIN/COMMIT with its own statement_timeout. */
async function tx(fn, timeout = "120s", attempts = 3) {
  for (let i = 1; ; i++) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`set local statement_timeout = '${timeout}'`);
      const out = await fn(client);
      await client.query("commit");
      return out;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      if (i >= attempts || !TRANSIENT.test(String(e?.message))) throw e;
      await sleep(2000 * i);
    } finally {
      client.release();
    }
  }
}

async function getState(key, dflt) {
  const { rows } = await q("select value from validation_worker_state where key = $1", [key]);
  return rows[0]?.value ?? dflt;
}
async function setState(key, value, client = pool) {
  await client.query(
    `insert into validation_worker_state (key, value, updated_at) values ($1, $2::jsonb, now())
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

// Lease row, not an advisory lock: DATABASE_URL is the transaction pooler, where
// session locks stick to arbitrary backends (same reasoning as categorize-worker).
const LOCK_KEY = "validation-worker";
const LOCK_OWNER = randomUUID();
async function acquireLock() {
  const { rows } = await q(
    `insert into worker_locks (key, owner, locked_until) values ($1, $2, now() + interval '55 minutes')
     on conflict (key) do update set owner = excluded.owner, locked_until = excluded.locked_until
       where worker_locks.locked_until < now()
     returning owner`,
    [LOCK_KEY, LOCK_OWNER]
  );
  return rows.length > 0;
}
async function releaseLock() {
  await q("delete from worker_locks where key = $1 and owner = $2", [LOCK_KEY, LOCK_OWNER]).catch(() => {});
}

// ── Reoon ───────────────────────────────────────────────────────────────────
async function reoon(path, { method = "GET", body, timeoutMs = 120_000 } = {}) {
  const res = await fetch(`${REOON}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),   // a request that never returns must not wedge the run
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* reported below */ }
  return { ok: res.ok, http: res.status, json, text: text.slice(0, 300) };
}

async function balance() {
  const r = await reoon(`/check-account-balance/?key=${encodeURIComponent(API_KEY)}`, { timeoutMs: 30_000 });
  const daily = Number(r.json?.remaining_daily_credits);
  const instant = Number(r.json?.remaining_instant_credits);
  if (!r.ok || r.json?.status !== "success" || !Number.isFinite(daily)) {
    throw new Error(`balance check failed: HTTP ${r.http} ${r.text}`);
  }
  if (!DRY) {
    await q("insert into validation_balance_log (daily_credits, instant_credits) values ($1, $2)",
      [daily, Number.isFinite(instant) ? instant : null]);
  }
  return { daily, instant };
}

// Reoon's words -> the leads.validation_status vocabulary, so the eventual gate
// switch is a straight swap. Mirrors src/lib/validation/providers/reoon.ts, plus
// the two statuses only the bulk API documents (disabled, inbox_full).
function mapStatus(native) {
  const s = String(native ?? "").toLowerCase().trim();
  switch (s) {
    case "safe": case "valid": case "role_account": return "valid";   // role mailboxes are deliverable
    case "catch_all": return "catch_all";
    case "invalid": case "disposable": case "spamtrap": case "disabled": return "invalid";
    case "inbox_full": return "risky";        // temporarily undeliverable — re-check after TTL
    default: return "unknown";                // includes "unknown" (refunded by Reoon)
  }
}

// ── 1. reconcile ────────────────────────────────────────────────────────────
async function requeueItems(client, taskId) {
  const { rowCount } = await client.query(
    `insert into validation_queue (email, priority, source, attempts)
     select email, least(coalesce(priority, 3), 3), coalesce(source, 'requeue'), attempts + 1
       from validation_task_items where task_id = $1 and attempts + 1 < $2
     on conflict (email) do update set priority = least(validation_queue.priority, excluded.priority)`,
    [taskId, MAX_ATTEMPTS]
  );
  await client.query("delete from validation_task_items where task_id = $1", [taskId]);
  return rowCount;
}

async function failTask(taskId, status, error) {
  const n = await tx(async (c) => {
    const requeued = await requeueItems(c, taskId);
    await c.query(
      `update validation_tasks set status = $2, error = $3, completed_at = now(), updated_at = now() where id = $1`,
      [taskId, status, String(error).slice(0, 500)]
    );
    return requeued;
  });
  log(`task ${taskId} ${status}: ${error} — ${n} address(es) requeued`);
}

async function applyResults(task, results) {
  const byEmail = new Map();
  for (const [k, v] of Object.entries(results ?? {})) byEmail.set(String(k).toLowerCase().trim(), v);

  const { rows: items } = await q(
    "select email, priority, source, attempts from validation_task_items where task_id = $1", [task.id]
  );
  const writes = [];
  const missing = [];
  const counts = {};
  for (const it of items) {
    // Look up case-insensitively, but store under the lead's EXACT email so the
    // claim's `v.email = l.email` anti-join always recognises it as done.
    const r = byEmail.get(it.email.toLowerCase().trim());
    if (!r) { missing.push(it.email); continue; }
    const native = String(r.status ?? "unknown").toLowerCase();
    counts[native] = (counts[native] ?? 0) + 1;
    writes.push([it.email, mapStatus(native), native]);
  }

  // Sorted + chunked: bounded statements, and a stable lock order.
  writes.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (let i = 0; i < writes.length; i += 5000) {
    const chunk = writes.slice(i, i + 5000);
    await tx((c) => c.query(
      `insert into email_validations (email, status, native_status, provider, task_id, validated_at)
       select e, s, n, 'reoon', $4, now()
         from unnest($1::text[], $2::text[], $3::text[]) as v(e, s, n)
       on conflict (email) do update
         set status = excluded.status, native_status = excluded.native_status,
             provider = excluded.provider, task_id = excluded.task_id, validated_at = excluded.validated_at`,
      [chunk.map((w) => w[0]), chunk.map((w) => w[1]), chunk.map((w) => w[2]), task.id]
    ));
  }

  // Finalise atomically. Addresses Reoon did not return (rejected as malformed,
  // or dropped) go back to the queue; requeueItems drops any past MAX_ATTEMPTS.
  // A crash before this point leaves the task 'submitted': the next run re-polls
  // it and re-applies — the upsert above is idempotent.
  await tx(async (c) => {
    if (missing.length) {
      await c.query(
        `delete from validation_task_items where task_id = $1 and email <> all($2::text[])`,
        [task.id, missing]
      );
      counts.not_returned = missing.length;
      await requeueItems(c, task.id);
    }
    await c.query("delete from validation_task_items where task_id = $1", [task.id]);
    await c.query(
      `update validation_tasks set status = 'applied', result_counts = $2::jsonb, count_checked = $3,
              completed_at = now(), updated_at = now() where id = $1`,
      [task.id, JSON.stringify(counts), writes.length]
    );
  });
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ");
  log(`task ${task.id} applied: ${writes.length.toLocaleString()} verdicts (${summary})`);
}

async function reconcile() {
  // Claimed but never accepted by Reoon (crash between claim and submit).
  const { rows: stale } = await q(
    `select id from validation_tasks where status = 'claimed' and created_at < now() - interval '15 minutes'`
  );
  for (const t of stale) {
    if (DRY) { log(`[dry] would abandon stale claim ${t.id}`); continue; }
    await failTask(t.id, "abandoned", "claimed but never submitted");
  }

  const { rows: open } = await q(
    `select id, reoon_task_id, submitted_at from validation_tasks where status = 'submitted' order by id`
  );
  for (const t of open) {
    const r = await reoon(
      `/get-result-bulk-verification-task/?key=${encodeURIComponent(API_KEY)}&task_id=${t.reoon_task_id}`
    ).catch((e) => ({ ok: false, http: 0, text: e.message }));
    const ageH = (Date.now() - new Date(t.submitted_at).getTime()) / 3_600_000;
    const st = r.json?.status;

    if (r.ok && st === "completed") {
      if (DRY) { log(`[dry] task ${t.id} completed — would apply ${r.json.count_checked} results`); continue; }
      await applyResults(t, r.json.results);
    } else if (r.ok && (st === "waiting" || st === "running")) {
      const pct = r.json.progress_percentage ?? 0;
      log(`task ${t.id} (reoon ${t.reoon_task_id}) ${st}: ${r.json.count_checked ?? 0}/${r.json.count_total ?? "?"} (${pct}%)`);
      if (!DRY) {
        await q("update validation_tasks set count_checked = $2, updated_at = now() where id = $1",
          [t.id, r.json.count_checked ?? null]);
      }
      if (ageH > TASK_STALE_HOURS && !DRY) await failTask(t.id, "failed", `still ${st} after ${Math.round(ageH)}h`);
    } else if (r.ok && st) {
      // file_not_found / file_loading_error / anything undocumented
      if (!DRY) await failTask(t.id, "failed", `reoon status ${st}`);
    } else {
      // Transient (network / 5xx): leave it for the next run, unless it is ancient.
      log(`task ${t.id} poll failed (HTTP ${r.http}): ${r.text}`);
      if (ageH > TASK_STALE_HOURS && !DRY) await failTask(t.id, "failed", `unpollable after ${Math.round(ageH)}h`);
    }
  }
}

// ── 2. refill: leads eligible for active clients jump the backfill ─────────
// Time-boxed and resumable (next_index), because 69 eligibility queries can take
// minutes and the whole run has a 50-minute watchdog.
async function refill() {
  const st = await getState("client_refill", { next_index: 0, last_completed_at: null });
  const due = st.next_index > 0 ||
    !st.last_completed_at || Date.now() - new Date(st.last_completed_at).getTime() > 24 * 3_600_000;
  if (!due) return;

  const { rows: [{ n: queued }] } = await q("select count(*)::int as n from validation_queue");
  if (queued > QUEUE_MAX) { log(`refill skipped: queue already holds ${queued.toLocaleString()}`); return; }

  const { rows: tags } = await q(
    `select tag from client_tags
      where group_no is not null and coalesce(status, '') !~* '(churn|paused)'
      order by tag`
  );
  const deadline = Date.now() + 15 * 60_000;
  let added = 0;
  let i = Math.min(st.next_index, tags.length);
  for (; i < tags.length; i++) {
    if (Date.now() > deadline) break;
    const tag = tags[i].tag;
    try {
      const { rows } = await q("select fn_client_eligibility_conditions($1) as conds", [tag]);
      const conds = rows[0]?.conds ?? [];
      if (!conds.length) continue;   // no targeting → nothing client-specific; the backfill covers it
      if (DRY) { log(`[dry] would refill ${tag}`); continue; }
      const n = await tx((c) => c.query(
        `insert into validation_queue (email, priority, source)
         select l.email, 2, $1 from leads l
          where ${conds.join(" and ")}
            and l.email is not null and l.email <> ''
            and l.is_bounced = false and l.is_suppressed = false
            and not exists (select 1 from email_validations v
                             where v.email = l.email and v.validated_at > now() - make_interval(days => $2))
            and not exists (select 1 from validation_task_items ti
                              join validation_tasks t on t.id = ti.task_id and t.status in ('claimed','submitted')
                             where ti.email = l.email)
          limit $3
         on conflict (email) do update set priority = least(validation_queue.priority, excluded.priority)`,
        [`client:${tag}`, TTL_DAYS, CLIENT_CAP]
      ), "90s", 1).then((r) => r.rowCount);
      added += n;
    } catch (e) {
      log(`refill ${tag} skipped: ${String(e.message).slice(0, 90)}`);
    }
  }
  if (DRY) return;
  const done = i >= tags.length;
  await setState("client_refill", {
    next_index: done ? 0 : i,
    last_completed_at: done ? new Date().toISOString() : st.last_completed_at,
  });
  // `added` counts queue rows written — new addresses PLUS re-prioritised ones
  // (clients overlap), so it can exceed the number of distinct addresses queued.
  log(`refill: ${added.toLocaleString()} client-eligible queue row(s) written` +
      (done ? ` (all ${tags.length} active clients)` : ` (paused at ${i}/${tags.length}, resumes next run)`));
}

// ── 3. claim + submit ───────────────────────────────────────────────────────
async function submit() {
  const { rows: [{ n: inFlight }] } = await q(
    "select count(*)::int as n from validation_tasks where status in ('claimed','submitted')"
  );
  if (inFlight > 0) { log("a task is still in flight — not submitting another"); return; }

  const { daily, instant } = await balance();
  const budget = daily - RESERVE;
  log(`reoon balance: ${daily.toLocaleString()} daily, ${instant.toLocaleString()} instant (reserve ${RESERVE})`);
  if (budget < MIN_TASK) { log("daily credits exhausted for now — waiting for them to replenish"); return; }

  const want = Math.max(0, Math.min(budget, TASK_SIZE, MAX_OVERRIDE > 0 ? MAX_OVERRIDE : Infinity));
  if (DRY) {
    const { rows: [{ n }] } = await q("select count(*)::int as n from validation_queue");
    const cur = await getState("cursor", { id: ZERO_UUID, wraps: 0 });
    log(`[dry] would claim ${want.toLocaleString()} (queue ${n.toLocaleString()}, backfill cursor ${cur.id})`);
    return;
  }

  const claimed = await tx(async (c) => {
    const { rows: [task] } = await c.query(
      "insert into validation_tasks (status, daily_credits_before) values ('claimed', $1) returning id", [daily]
    );

    // Priority first: exports (1), client-eligible (2), retries (3). Stale queue
    // entries (validated since they were queued) are dropped, not re-checked.
    const { rows: fromQueue } = await c.query(
      `with picked as (
         select email from validation_queue order by priority, enqueued_at limit $2 for update skip locked
       ), gone as (
         delete from validation_queue q using picked p where q.email = p.email
         returning q.email, q.priority, q.source, q.attempts
       )
       insert into validation_task_items (task_id, email, priority, source, attempts)
       select $1, g.email, g.priority, g.source, g.attempts from gone g
        where not exists (select 1 from email_validations v
                           where v.email = g.email and v.validated_at > now() - make_interval(days => $3))
       returning email`,
      [task.id, want, TTL_DAYS]
    );
    let got = fromQueue.length;

    // Backfill: walk leads by id in bounded windows. Each window is a PK range of
    // at most WINDOW rows, so the claim can never degrade into an unbounded scan
    // as the unvalidated cohort thins out (the failure that hit the location
    // worker and the Bison import).
    let cur = await getState("cursor", { id: ZERO_UUID, wraps: 0 });
    let windows = 0;
    while (got < want && windows < MAX_WINDOWS) {
      windows++;
      // Window end = the WINDOW-th id after the cursor, or the table's last id
      // when fewer remain. (Postgres has no max(uuid); both forms are PK scans.)
      const { rows: [w] } = await c.query(
        `select coalesce(
           (select id from leads where id > $1::uuid order by id offset $2 - 1 limit 1),
           (select id from leads where id > $1::uuid order by id desc limit 1)
         )::text as hi`,
        [cur.id, WINDOW]
      );
      if (!w.hi) {                              // end of table → one full pass done
        cur = { id: ZERO_UUID, wraps: (cur.wraps ?? 0) + 1, last_wrap_at: new Date().toISOString() };
        log(`backfill cursor wrapped — full pass #${cur.wraps} over leads complete`);
        break;                                   // resume from the top next run
      }
      const need = want - got;
      const { rows } = await c.query(
        `select l.id::text as id, l.email from leads l
          where l.id > $1::uuid and l.id <= $2::uuid
            and l.email is not null and l.email <> ''
            and l.is_bounced = false and l.is_suppressed = false
            and not exists (select 1 from email_validations v
                             where v.email = l.email and v.validated_at > now() - make_interval(days => $4))
            and not exists (select 1 from validation_queue vq where vq.email = l.email)
            and not exists (select 1 from validation_task_items ti
                              join validation_tasks t on t.id = ti.task_id and t.status in ('claimed','submitted')
                             where ti.email = l.email)
          order by l.id
          limit $3`,
        [cur.id, w.hi, need, TTL_DAYS]
      );
      if (rows.length) {
        await c.query(
          `insert into validation_task_items (task_id, email, priority, source)
           select $1, e, 4, 'backfill' from unnest($2::text[]) as e
           on conflict do nothing`,
          [task.id, rows.map((r) => r.email)]
        );
        got += rows.length;
      }
      // Advance exactly past what was consumed: if this window filled the task,
      // stop at the last claimed id (the rest of the window is still unseen);
      // otherwise the whole window has been examined.
      cur = { ...cur, id: rows.length === need ? rows[rows.length - 1].id : w.hi };
    }
    await setState("cursor", cur, c);

    if (got === 0) {
      await c.query("delete from validation_tasks where id = $1", [task.id]);
      return null;
    }
    await c.query("update validation_tasks set count_items = $2, updated_at = now() where id = $1", [task.id, got]);
    return { id: task.id, count: got, windows };
  }, "300s");

  if (!claimed) { log("nothing left to validate right now"); return; }
  log(`claimed ${claimed.count.toLocaleString()} address(es) into task ${claimed.id} (${claimed.windows} backfill window(s))`);

  const { rows: emails } = await q(
    "select email from validation_task_items where task_id = $1 order by email", [claimed.id]
  );
  const r = await reoon("/create-bulk-verification-task/", {
    method: "POST",
    body: { name: `OH-validate-${claimed.id}`.slice(0, 25), emails: emails.map((e) => e.email), key: API_KEY },
    timeoutMs: 180_000,
  }).catch((e) => ({ ok: false, http: 0, text: e.message }));

  if (r.ok && r.json?.status === "success" && r.json.task_id) {
    await q(
      `update validation_tasks set status = 'submitted', reoon_task_id = $2, count_submitted = $3,
              submitted_at = now(), updated_at = now() where id = $1`,
      [claimed.id, r.json.task_id, r.json.count_processing ?? r.json.count_submitted ?? null]
    );
    log(`task ${claimed.id} submitted as reoon task ${r.json.task_id}: ` +
        `${r.json.count_submitted} submitted, ${r.json.count_duplicates_removed ?? 0} duplicates, ` +
        `${r.json.count_rejected_emails ?? 0} rejected, ${r.json.count_processing} processing`);
  } else {
    await failTask(claimed.id, "failed", `submit HTTP ${r.http}: ${r.json?.reason ?? r.text}`);
  }
}

// ── main ────────────────────────────────────────────────────────────────────
const started = Date.now();
log(`validation-worker starting${DRY ? " (dry run)" : ""}`);
if (!DRY && !(await acquireLock())) {
  log("another run holds the lease — exiting");
  await pool.end();
  process.exit(0);
}
try {
  await reconcile();
  if (!NO_REFILL) await refill();
  await submit();
} catch (e) {
  console.error(ts(), "ERROR", e instanceof Error ? e.stack : e);
  process.exitCode = 1;
} finally {
  if (!DRY) await releaseLock();
  await pool.end().catch(() => {});
}
log(`finished in ${((Date.now() - started) / 1000).toFixed(0)}s (exit ${process.exitCode ?? 0})`);
process.exit(process.exitCode ?? 0);
