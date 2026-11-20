#!/usr/bin/env node
// backfill-worker.mjs: the database backfill, one firing (migration 138).
//
// Meant as an hourly Railway cron service "backfill-worker", start command
// `node scripts/backfill-worker.mjs` (npm run backfill-worker), build command
// `echo 'worker service: no next build'` (CLAUDE.md: every worker service
// overrides the build). The owner creates that service later: this build
// creates none. It needs DATABASE_URL only and calls no paid API and no
// network: the shares it queues are pushed by the share step's push timer and
// the share push, as every share is.
//
// Each firing (scripts/lib/backfill/run.mjs), for each client on
// database_backfill.tags that may receive, finds leads already in the
// database (untagged, or of other clients of its sharing pool) that fit its
// rules and places and were never sent, in flight, shared or tagged for it,
// and in apply mode queues them as shares of one share job (kind backfill,
// origin DATABASE), within the caps. In preview mode (the setting, or
// --preview) it writes only its run row.
//
// Everything ships off: with database_backfill.enabled false (as 138 seeds
// it) a firing logs one line and writes nothing; without 138 it does the same.
// A lease row in worker_locks (not an advisory lock: DATABASE_URL is the
// transaction pooler) keeps two firings from overlapping, and a 50-minute
// watchdog ends a hung firing before the next one is due. Work stops at
// database_backfill.max_minutes (40 as shipped).
//
//   node scripts/backfill-worker.mjs                 # one firing as the setting says
//   node scripts/backfill-worker.mjs --preview       # a preview firing, even while switched off
//   node scripts/backfill-worker.mjs --tag ABC       # only that client (with --preview, even off the list)

import pg from "pg";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { read } from "./lib/share/db.mjs";
import { backfillFrom, backfillTag } from "./lib/backfill/settings.mjs";
import { acquireLease, backfillOnce, backfillReady, oneLine, releaseLease } from "./lib/backfill/run.mjs";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...m) => console.log(ts(), ...m);
const WATCHDOG_MS = 50 * 60_000;
const WORK_MS = 48 * 60_000; // the most any firing works; database_backfill.max_minutes (5 to 50, 40 as shipped) usually ends it first

// WATCHDOG: die before the next hourly firing. Railway skips a firing while the
// previous container still runs, so one hung firing would stop them all. Exit
// 0: freeing the slot is not a failure. Every step is resumable: the cursors
// say where each place's pass stands.
setTimeout(() => {
  console.error("WATCHDOG: exceeded 50 min, exiting so the next firing is not skipped");
  process.exit(0);
}, WATCHDOG_MS).unref();

const args = process.argv.slice(2);
const preview = args.includes("--preview");
const tagAt = args.indexOf("--tag");
const tag = tagAt >= 0 ? backfillTag(args[tagAt + 1]) : null;
if (tagAt >= 0 && !tag) {
  console.error("--tag needs a client tag");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, keepAlive: true });
pool.on("error", (e) => log(`pg pool: ${e.message}`));

const OWNER = randomUUID();
const started = Date.now();
try {
  // Off, or no 138: one line, and nothing written (not even the lease).
  if (!(await backfillReady(pool))) {
    log("backfill: the backfill tables are not there (migration 138): nothing to do");
  } else if (!preview && !backfillFrom((await read(pool, `SELECT key, value FROM enrich_settings WHERE key = 'database_backfill'`)).rows).enabled) {
    log("backfill: switched off (database_backfill.enabled is false): nothing to do");
  } else if (!(await acquireLease(pool, OWNER))) {
    log("backfill: another firing holds the lease: nothing to do");
  } else {
    try {
      const out = await backfillOnce(pool, { deadline: started + WORK_MS, log, preview, tag });
      log(`backfill: done in ${((Date.now() - started) / 1000).toFixed(0)} s: ${JSON.stringify({ state: out.state, stop: out.stopReason, run: out.run })}`);
    } finally {
      await releaseLease(pool, OWNER).catch(() => {});
    }
  }
} catch (e) {
  console.error(ts(), `backfill-worker failed: ${oneLine(e)}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
