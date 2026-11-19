#!/usr/bin/env node
// topup-worker.mjs: the weekly top-up and never-contact inboxes, one firing.
//
// Railway cron service "topup-worker", hourly, start command
// `node scripts/topup-worker.mjs` (npm run topup-worker), build command
// `echo 'worker service: no next build'` (CLAUDE.md: every worker service
// overrides the build). It needs DATABASE_URL only: it creates AI Ark runs,
// which the enrich-worker works with its own key, and calls no paid API.
//
// Each firing (scripts/lib/topup/run.mjs):
//   (a) cancels queued or running top-up runs of clients that can no longer
//       receive (a churn date within 15 days, status, Groups tab, places);
//   (b) the weekly pass: flags every Active client of the covered types, when
//       weekly_topup is on and the last finished pass is 7 or more days old,
//       or someone pressed "Run now" on the Sharing page's Low places tab;
//   (c) auto pulls: starts waiting top-up pulls within the weekly budget and
//       pulls_per_day (pull_mode auto only);
//   (d) never-contact inboxes: works an apply an admin started, while that
//       switch is on.
// Everything ships off: with weekly_topup and never_contact_inboxes off a
// firing writes nothing.
//
// Production already adds finished AI Ark pulls to the lead database on its
// own (AIARK_AUTO_ADD_URL and AIARK_AUTO_ADD_KEY are set on the enrich-worker),
// so the leads a top-up pull finds reach leads, and overlap sharing, by
// themselves.
//
// A lease row in worker_locks (not an advisory lock: DATABASE_URL is the
// transaction pooler) keeps two firings from overlapping, and a 50-minute
// watchdog ends a hung firing before the next one is due.
//
//   node scripts/topup-worker.mjs
//   TOPUP_RUN_MODE=demo node scripts/topup-worker.mjs    # pulls it starts are demo runs (local work only)

import pg from "pg";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { acquireLease, releaseLease, topupOnce } from "./lib/topup/run.mjs";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...m) => console.log(ts(), ...m);
const WATCHDOG_MS = 50 * 60_000;
const WORK_MS = 40 * 60_000; // leaves the last 10 minutes for the step in hand to end cleanly

// WATCHDOG: die before the next hourly firing. Railway skips a firing while the
// previous container still runs, so one hung firing would stop them all. Exit
// 0: freeing the slot is not a failure (nonzero on a cron service with a
// restart policy crash-loops it). Every step is resumable.
setTimeout(() => {
  console.error("WATCHDOG: exceeded 50 min, exiting so the next firing is not skipped");
  process.exit(0);
}, WATCHDOG_MS).unref();

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, keepAlive: true });
pool.on("error", (e) => log(`pg pool: ${e.message}`));

const OWNER = randomUUID();
const started = Date.now();
try {
  if (!(await acquireLease(pool, OWNER))) {
    log("another firing holds the lease: nothing to do");
  } else {
    try {
      const mode = process.env.TOPUP_RUN_MODE === "demo" ? "demo" : "live";
      const out = await topupOnce(pool, { deadline: started + WORK_MS, mode, log });
      log(`done in ${((Date.now() - started) / 1000).toFixed(0)} s: ${JSON.stringify(out)}`);
    } finally {
      await releaseLease(pool, OWNER).catch(() => {});
    }
  }
} catch (e) {
  console.error(ts(), `topup-worker failed: ${e?.stack ?? e}`);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
