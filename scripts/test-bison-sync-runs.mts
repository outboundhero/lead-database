// The bison-sync cron's decisions and run log (migration 131).
//
//   npx tsx --env-file=.env.local scripts/test-bison-sync-runs.mts
//
// Pure pass: the regular slot (the old `0 3 */3 * *` calendar), what a check
// decides, and reading the sync's output. Live pass (needs DATABASE_URL and
// migration 131): the request → claim → heartbeat → finish cycle, the one-running
// rule, and stale-run recovery — all inside one transaction that is rolled back.
import { Client } from "pg";
import {
  lastSlotAtOrBefore, decide, parseSyncOutput, requestSync, syncStatus, activeRun,
  claimRun, heartbeat, finishRun, failStale, lastStartedAt,
} from "./lib/bison-sync-runs.mjs";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
const iso = (d: Date) => d.toISOString();

console.log("regular slot = 03:00 UTC on days 1, 4, 7 … 31");
eq("19 Nov 02:59 → 16 Nov", iso(lastSlotAtOrBefore("2026-11-19T02:59:00Z")), "2026-11-16T03:00:00.000Z");
eq("19 Nov 03:00 → 19 Nov", iso(lastSlotAtOrBefore("2026-11-19T03:00:00Z")), "2026-11-19T03:00:00.000Z");
eq("20 Nov 10:00 → 19 Nov", iso(lastSlotAtOrBefore("2026-11-20T10:00:00Z")), "2026-11-19T03:00:00.000Z");
eq("22 Nov 03:30 → 22 Nov", iso(lastSlotAtOrBefore("2026-11-22T03:30:00Z")), "2026-11-22T03:00:00.000Z");
eq("1 Dec 01:00 → 28 Nov (30-day month)", iso(lastSlotAtOrBefore("2026-12-01T01:00:00Z")), "2026-11-28T03:00:00.000Z");
eq("31 Jan 04:00 → 31 Jan", iso(lastSlotAtOrBefore("2026-01-31T04:00:00Z")), "2026-01-31T03:00:00.000Z");
eq("1 Feb 05:00 → 1 Feb (31st then 1st)", iso(lastSlotAtOrBefore("2026-02-01T05:00:00Z")), "2026-02-01T03:00:00.000Z");
eq("1 Mar 02:00 → 28 Feb", iso(lastSlotAtOrBefore("2026-03-01T02:00:00Z")), "2026-02-28T03:00:00.000Z");

console.log("\nwhat a check decides");
const now = "2026-11-20T10:00:00Z";
eq("a request runs at once", decide({ now, requested: true, lastStartedAt: "2026-11-20T09:59:00Z" }), "button");
eq("ran after the last slot → nothing", decide({ now, requested: false, lastStartedAt: "2026-11-19T20:27:07Z" }), null);
eq("nothing since the last slot → schedule", decide({ now, requested: false, lastStartedAt: "2026-11-18T20:00:00Z" }), "schedule");
eq("never ran → schedule", decide({ now, requested: false, lastStartedAt: null }), "schedule");
eq("the 03:00 check on a slot day → schedule", decide({ now: "2026-11-22T03:00:05Z", requested: false, lastStartedAt: "2026-11-19T20:27:07Z" }), "schedule");
eq("the 03:30 check after it ran → nothing", decide({ now: "2026-11-22T03:30:05Z", requested: false, lastStartedAt: "2026-11-22T03:00:06Z" }), null);
eq("the 02:30 check on a slot day → nothing yet", decide({ now: "2026-11-22T02:30:05Z", requested: false, lastStartedAt: "2026-11-19T20:27:07Z" }), null);

console.log("\nreading the sync's output");
const real = [
  "incremental sync of 4 instance(s)",
  "=== personal.outboundclean.com — incremental: ids 1,869,800..1,869,800 (1 ids, 1 shard) ===",
  "personal.outboundclean.com: 1 new rows in 4s (0/sec)",
  "=== app.facilityreach.com — no new leads (top 4,700,009) ===",
  "=== app.outboundhero.co — incremental: ids 8,763,653..8,809,907 (46,255 ids, 3 shards) ===",
  "app.outboundhero.co: 46,255 new rows in 676s (68/sec)",
  "importing leads Bison has that we don't…",
  "done: 62,455 rows fetched, 2,088 new lead(s) added to the database.",
].join("\n");
eq("the 19 Nov run's summary", parseSyncOutput(real), { rowsFetched: 62455, newLeads: 2088, failures: [] });
const withFail = real.replace("app.outboundhero.co: 46,255", "   shard 2 failed: fetch failed\napp.outboundhero.co: 30,000");
eq("a failed shard is attributed to its install", parseSyncOutput(withFail).failures, ["app.outboundhero.co shard 2: fetch failed"]);
eq("no summary line (crashed) → nulls", parseSyncOutput("incremental sync of 4 instance(s)\nError: boom"), { rowsFetched: null, newLeads: null, failures: [] });

if (process.env.DATABASE_URL) {
  console.log("\nLIVE (one transaction, rolled back): request → claim → heartbeat → finish");
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query("begin");
  await db.query("set local statement_timeout = '60s'");
  // Each statement in its own savepoint, so an expected unique violation does not abort the transaction.
  const q = async (sql: string, params?: unknown[]) => {
    await db.query("savepoint s");
    try { const r = await db.query(sql, params); await db.query("release savepoint s"); return r.rows; }
    catch (e) { await db.query("rollback to savepoint s"); throw e; }
  };
  try {
    // Start from a clean slate inside the transaction.
    await q(`update bison_sync_runs set status = 'failed' where status in ('requested', 'running')`);
    const a = await requestSync(q, "test@example");
    eq("first press creates a request", [a.created, a.run?.status, a.run?.trigger], [true, "requested", "button"]);
    const b = await requestSync(q, "someone-else@example");
    eq("second press returns the same request", [b.created, b.run?.id], [false, a.run?.id]);
    eq("status shows it as active", (await syncStatus(q)).active?.id, a.run?.id);
    const id = await claimRun(q, "button");
    eq("the cron claims the request", id, a.run?.id);
    eq("a scheduled run cannot start beside it", await claimRun(q, "schedule"), null);
    const c = await requestSync(q, "test@example");
    eq("pressing while it runs returns the running one", [c.created, c.run?.status], [false, "running"]);
    await heartbeat(q, id);
    await finishRun(q, id, { ok: true, rowsFetched: 120, newLeads: 7, error: null });
    const s = await syncStatus(q);
    eq("finished run is the last one, nothing active", [s.last?.id, s.last?.status, Number(s.last?.new_leads), s.active], [id, "done", 7, null]);
    eq("lastStartedAt is this run's start", !!(await lastStartedAt(q)), true);
    const sid = await claimRun(q, "schedule");
    eq("a scheduled run starts when nothing is running (id comes back as a bigint string)", sid != null, true);
    await q(`update bison_sync_runs set heartbeat_at = now() - interval '11 minutes' where id = $1`, [sid]);
    const stale = await failStale(q);
    eq("a run with no heartbeat for 11 minutes is marked failed", stale.map((r: { id: number }) => r.id), [sid]);
    const after = (await q(`select status, error from bison_sync_runs where id = $1`, [sid]))[0];
    eq("…with the reason", [after.status, /interrupted/.test(after.error)], ["failed", true]);
    eq("nothing active afterwards", await activeRun(q), null);
  } finally {
    await db.query("rollback");
    await db.end();
  }
} else {
  console.log("\nSKIP live pass (no DATABASE_URL)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
