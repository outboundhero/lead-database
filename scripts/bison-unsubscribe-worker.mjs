#!/usr/bin/env node
// bison-unsubscribe-worker.mjs — push never-contact decisions into Email Bison.
//
//   node scripts/bison-unsubscribe-worker.mjs                 drain the queue (paced)
//   node scripts/bison-unsubscribe-worker.mjs --dry-run       show what it would call
//   node scripts/bison-unsubscribe-worker.mjs --limit=50      cap this run
//   node scripts/bison-unsubscribe-worker.mjs --pace=800      ms between API calls
//
// Suppressing an address in this database never touched Bison, so a lead we had
// promised never to contact could still be mid-sequence there (measured
// 2026-09-23: 542 of them). The queue (migration 116) holds one job per address
// per install; this drains it.
//
//   unsubscribe -> PATCH /api/leads/{id}/unsubscribe
//                  Verified live: 200, status becomes 'unsubscribed', and the
//                  documented response empties lead_campaign_data.
//   reactivate  -> PATCH /api/leads/{id}/update-status {status:'unverified'}
//                  Bison has NO resubscribe endpoint. This makes the lead
//                  contactable again; it does NOT put it back in the sequences
//                  it was removed from. Nothing can.
//
// PACING IS THE POINT. Bison answers one lead per request and 429s hard under
// sustained load — a blanket 429 once killed the mirror sync at 188,761 of
// 8.05M rows. A 429 is an instruction to wait, not a blip: back off and retry,
// never hammer. Default 400ms between calls (~2.5/s).

import pg from "pg";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const argv = process.argv.slice(2);
const flag = (n) => {
  const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return h ? (h.includes("=") ? h.slice(h.indexOf("=") + 1) : true) : undefined;
};
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
const DRY = !!flag("dry-run");
const LIMIT = num(flag("limit"), num(process.env.BISON_UNSUB_LIMIT, 500));
const PACE_MS = num(flag("pace"), num(process.env.BISON_UNSUB_PACE_MS, 400));
const MAX_ATTEMPTS = num(process.env.BISON_UNSUB_MAX_ATTEMPTS, 3);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...m) => console.log(ts(), ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
const KEYS = process.env.EMAILBISON_KEYS ? JSON.parse(process.env.EMAILBISON_KEYS) : {};
if (Object.keys(KEYS).length === 0) { console.error("EMAILBISON_KEYS is required"); process.exit(1); }

// Never outlive the cron slot.
setTimeout(() => { console.error("WATCHDOG: 50 min — exiting"); process.exit(0); }, 50 * 60_000).unref();

// Lease-row lock, not a pg advisory lock: DATABASE_URL is the transaction-mode
// pooler, where a session lock sticks to an arbitrary pooled backend.
const LOCK_KEY = "bison-unsubscribe-worker";
const LOCK_OWNER = randomUUID();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = (s, p = []) => client.query(s, p);

async function acquireLock() {
  const { rows } = await q(
    `INSERT INTO worker_locks (key, owner, locked_until)
     VALUES ($1, $2, now() + interval '1 hour')
     ON CONFLICT (key) DO UPDATE
       SET owner = EXCLUDED.owner, locked_until = EXCLUDED.locked_until
       WHERE worker_locks.locked_until < now()
     RETURNING owner`, [LOCK_KEY, LOCK_OWNER]);
  return rows.length > 0;
}

/** One Bison call. Returns {ok} | {gone} | {retryAfterMs} | {error}. */
async function callBison(job) {
  const key = KEYS[job.instance_url];
  if (!key) return { error: `no API key configured for ${job.instance_url}` };
  const base = `https://${job.instance_url}`;
  const path = job.action === "unsubscribe"
    ? `/api/leads/${job.bison_lead_id}/unsubscribe`
    : `/api/leads/${job.bison_lead_id}/update-status`;
  const init = {
    method: "PATCH",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
    ...(job.action === "reactivate" ? { body: JSON.stringify({ status: "unverified" }) } : {}),
  };
  if (DRY) { log(`[dry] PATCH ${base}${path}${init.body ? ` ${init.body}` : ""}`); return { ok: true, dry: true }; }
  let res;
  try { res = await fetch(`${base}${path}`, init); }
  catch (e) { return { error: `network: ${e.message}` }; }
  // 429 is Bison saying SLOW DOWN. Honour Retry-After when it gives one.
  if (res.status === 429) {
    const ra = Number(res.headers.get("retry-after"));
    return { retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 45_000 };
  }
  // The lead no longer exists on that install (deleted since the last mirror
  // sync). Terminal, and not a failure: there is nothing left to unsubscribe.
  if (res.status === 404) return { gone: true };
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200).replace(/\s+/g, " ")}` };
  return { ok: true };
}

async function finish(job, patch) {
  await q(
    `update bison_unsubscribe_queue
        set status = $2, attempts = attempts + 1, last_error = $3,
            completed_at = case when $2 in ('done','gone','failed') then now() else null end,
            updated_at = now()
      where id = $1`,
    [job.id, patch.status, patch.error ?? null]);
}

let done = 0, gone = 0, failed = 0, retried = 0;
try {
  if (!(await acquireLock())) { log("another run holds the lease — exiting"); process.exit(0); }

  const { rows: pending } = await q(
    `select id, email, instance_url, bison_lead_id, action, attempts
       from bison_unsubscribe_queue
      where status = 'pending' and attempts < $2
      order by id
      limit $1`, [LIMIT, MAX_ATTEMPTS]);
  if (pending.length === 0) { log("queue is empty"); process.exit(0); }

  const byInstance = pending.reduce((m, j) => ((m[j.instance_url] = (m[j.instance_url] ?? 0) + 1), m), {});
  log(`${pending.length} job(s) to send: ${Object.entries(byInstance).map(([k, v]) => `${k}=${v}`).join(", ")}` +
      `${DRY ? " [DRY RUN]" : ""} (pace ${PACE_MS}ms)`);

  for (const job of pending) {
    // The mirror can be up to 3 days stale; an address with no id there cannot
    // be actioned by id. Resolve it live, once.
    if (!job.bison_lead_id) {
      const key = KEYS[job.instance_url];
      try {
        const r = await fetch(`https://${job.instance_url}/api/leads/${encodeURIComponent(job.email)}`,
          { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
        if (r.status === 404) { await finish(job, { status: "gone" }); gone++; continue; }
        const j = await r.json();
        job.bison_lead_id = (j.data ?? j)?.id;
      } catch { /* fall through to the error path below */ }
      if (!job.bison_lead_id) { await finish(job, { status: "failed", error: "could not resolve lead id" }); failed++; continue; }
      await q(`update bison_unsubscribe_queue set bison_lead_id = $2 where id = $1`, [job.id, job.bison_lead_id]);
    }

    let out = await callBison(job);
    if (out.retryAfterMs) {           // one wait, then a single retry
      retried++;
      log(`429 from ${job.instance_url} — waiting ${Math.round(out.retryAfterMs / 1000)}s`);
      await sleep(out.retryAfterMs);
      out = await callBison(job);
    }

    if (out.ok) { if (!out.dry) await finish(job, { status: "done" }); done++; }
    else if (out.gone) { await finish(job, { status: "gone" }); gone++; }
    else if (out.retryAfterMs) {      // still throttled: leave pending, stop the run
      log("still throttled after waiting — stopping this run, the rest stays queued");
      break;
    } else {
      const attempts = job.attempts + 1;
      await finish(job, { status: attempts >= MAX_ATTEMPTS ? "failed" : "pending", error: out.error });
      failed++;
      log(`  ${job.email} @ ${job.instance_url}: ${out.error}`);
    }
    if (PACE_MS > 0) await sleep(PACE_MS);
  }

  const { rows: [left] } = await q(`select count(*)::int n from bison_unsubscribe_queue where status = 'pending'`);
  log(`done ${done}, gone ${gone}, failed ${failed}${retried ? `, 429 waits ${retried}` : ""} — ${left.n} still queued`);
} catch (e) {
  console.error(ts(), "ERROR", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await q("DELETE FROM worker_locks WHERE key = $1 AND owner = $2", [LOCK_KEY, LOCK_OWNER]).catch(() => {});
  await client.end();
}
process.exit(process.exitCode ?? 0);
