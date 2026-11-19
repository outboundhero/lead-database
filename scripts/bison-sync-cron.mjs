#!/usr/bin/env node
// bison-sync cron — every 30 minutes since 2026-11-20 (was `0 3 */3 * *`).
//
// Each check:
//   1. a run with no heartbeat for 10 minutes (killed, redeployed) is marked failed;
//   2. a "Sync now" request from the top bar runs at once; otherwise the regular
//      slot (03:00 UTC on days 1, 4, 7 … 31, as before) runs if no run has
//      started since it; otherwise it exits — most checks take about a second;
//   3. the run is the same incremental sync as before
//      (scripts/sync-bison-leads.mjs --incremental, as a child process, its
//      output passed through to the logs), recorded in bison_sync_runs: start,
//      heartbeat every minute, finish, rows fetched, new leads, failed shards.
// Two syncs never overlap: bison_sync_runs allows one 'running' row at a time.
//
//   node scripts/bison-sync-cron.mjs              (npm run bison-sync-cron)
//   node scripts/bison-sync-cron.mjs --dry-run    (print the decision, write nothing)
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  decide, failStale, claimRun, heartbeat, finishRun, lastStartedAt, parseSyncOutput,
} from "./lib/bison-sync-runs.mjs";

const DRY = process.argv.includes("--dry-run");
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, keepAlive: true });
pool.on("error", (e) => console.error("[pool]", e.message));
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const done = async (code) => { await pool.end().catch(() => {}); process.exit(code); };

const now = new Date();
if (!DRY) {
  const stale = await failStale(q);
  if (stale.length) console.log(`marked interrupted run(s) failed: ${stale.map((r) => `#${r.id}`).join(", ")}`);
}
const request = (await q(`select id, requested_by, requested_at from bison_sync_runs where status = 'requested' order by requested_at limit 1`))[0];
const running = (await q(`select id, trigger, started_at from bison_sync_runs where status = 'running' limit 1`))[0];
const last = await lastStartedAt(q);
const what = decide({ now, requested: !!request, lastStartedAt: last });
console.log(
  `check ${now.toISOString()}: ${request ? `request #${request.id} by ${request.requested_by ?? "?"}` : "no request"}; ` +
  `last run started ${last ? new Date(last).toISOString() : "never"}; ` +
  `${running ? `run #${running.id} (${running.trigger}) is still going, ` : ""}→ ${what ?? "nothing to do"}${DRY ? " [dry run]" : ""}`
);
if (!what || running || DRY) await done(0);

const id = await claimRun(q, what);
if (!id) { console.log("another run started first — nothing to do"); await done(0); }
console.log(`run #${id} (${what}) started`);

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "sync-bison-leads.mjs");
const child = spawn(process.execPath, [script, "--incremental"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
const pass = (stream) => (buf) => {
  const s = buf.toString();
  out += s;
  if (out.length > 2_000_000) out = out.slice(-1_000_000);
  stream.write(s);
};
child.stdout.on("data", pass(process.stdout));
child.stderr.on("data", pass(process.stderr));
const beat = setInterval(() => { heartbeat(q, id).catch((e) => console.error(`heartbeat failed: ${e.message}`)); }, 60_000);
const exit = await new Promise((resolve) => {
  child.on("error", (e) => resolve(`spawn error: ${e.message}`));
  child.on("close", (code, signal) => resolve(signal ? `signal ${signal}` : code));
});
clearInterval(beat);

const { rowsFetched, newLeads, failures } = parseSyncOutput(out);
const ok = exit === 0 && rowsFetched !== null;
const tail = out.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 400);
const error = !ok
  ? `sync exited ${exit}: ${tail}`
  : failures.length
    ? `${failures.length} shard(s) failed; their ids are skipped by later incremental runs (a full sync re-reads them): ${failures.join("; ")}`.slice(0, 2000)
    : null;
await finishRun(q, id, { ok, rowsFetched, newLeads, error });
console.log(`run #${id} ${ok ? "done" : "FAILED"}: ${rowsFetched ?? "?"} rows fetched, ${newLeads ?? "?"} new lead(s)${error ? ` — ${error}` : ""}`);
await done(ok ? 0 : 1);
