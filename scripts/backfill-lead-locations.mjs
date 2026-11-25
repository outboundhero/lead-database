#!/usr/bin/env node
import "dotenv/config";

/**
 * Link every located lead to the geo reference (migration 064) and flip the
 * display convention:
 *   state "WA" -> state "Washington" + state_code "WA"
 *   country     -> "USA" + country_code "US" (derived from the state's country)
 *
 * location_status: resolved (city verified in reference), partial (state-level
 * only — city missing or unverified), unresolved (location text present but
 * unrecognized -> review queue). Leads with no location data keep NULL.
 *
 * Re-runnable: processes leads whose state_code is still NULL (or --all).
 *
 * The passes themselves, what each reads and writes for a lead, are in
 * scripts/lib/lead-places.mjs (2026-11-26): a promotion round places the leads
 * it has just made with the same code, so what it writes is what this run
 * would have written for them. This script walks the whole table through
 * them.
 *
 * Each run is recorded in cron_runs (migration 133) as location_backfill: when
 * it started, and once it finished, the start of the run that finished. A
 * share job waits for a location run that started after its import finished
 * (scripts/lib/share/), so new leads have their place before they are matched.
 * Not with --dry-run. A database without cron_runs records nothing.
 *
 * Usage: node --env-file=.env.local scripts/backfill-lead-locations.mjs [--dry-run] [--all]
 */

import pg from "pg";
import { CRON_LOCATION_BACKFILL } from "./lib/overlap-topup.mjs";
import {
  loadPlaceReference, markForReview, placeByCity, placeByStateCode, placeByStateName, placeWhere, writePlaces,
} from "./lib/lead-places.mjs";

const DRY = process.argv.includes("--dry-run");
const ALL = process.argv.includes("--all");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));
async function q(text, params, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(text, params); }
    catch (err) {
      const transient = /ECONNRESET|termin|timeout|socket|EPIPE|server closed/i.test(err.message || "");
      if (!transient || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}
// The shared passes read and write through the same retrying query.
const db = { query: q };

// The run's start in cron_runs, before any lead is read. 42P01: no cron_runs
// (before 133), nothing recorded. Any other failure is said and the run goes
// on: the location pass matters more than its record.
let runStartedAt = null;
if (!DRY) {
  try {
    const { rows: [r] } = await q(
      `INSERT INTO cron_runs (name, started_at) VALUES ($1, now())
       ON CONFLICT (name) DO UPDATE SET started_at = EXCLUDED.started_at, updated_at = now()
       RETURNING started_at`,
      [CRON_LOCATION_BACKFILL]
    );
    runStartedAt = r.started_at;
  } catch (err) {
    if (err?.code !== "42P01") console.warn(`could not record the run's start in cron_runs: ${err.message}`);
  }
}

// ── reference into memory ──
console.log("loading reference...");
const ref = await loadPlaceReference(db, { onGeoRows: (n) => process.stdout.write(`\r  geo rows: ${n}`) });
console.log(`\n  lookup keys: ${ref.geo.size}`);

const counts = { resolved: 0, partial: 0, cityMiss: 0, statelessResolved: 0, unresolved: 0 };
const updates = [];
/** A lead's outcome in the counts; its pass's update, if any, in the next write. */
function take({ update, outcome }) {
  if (outcome === "resolved") counts.resolved++;
  else if (outcome === "partial") counts.partial++;
  else if (outcome === "city_miss") { counts.partial++; counts.cityMiss++; }
  else if (outcome === "stateless") counts.statelessResolved++;
  else if (outcome === "unresolved") counts.unresolved++;
  if (update) updates.push(update);
}
async function flush(force = false) {
  if (!updates.length || (!force && updates.length < 2000)) return;
  const b = updates.splice(0, updates.length);
  if (DRY) return;
  await writePlaces(db, b);
}
const w = placeWhere("l");

// ── pass 1: leads with a state code ──
console.log("pass 1: leads with state...");
{
  let lastId = "00000000-0000-0000-0000-000000000000"; let seen = 0;
  const cond = ALL ? "" : `AND ${w.open}`;
  for (;;) {
    const rs = (await q(`
      SELECT id, city, state FROM leads l
      WHERE ${w.code} ${cond} AND id > $1
      ORDER BY id LIMIT 5000`, [lastId])).rows;
    if (!rs.length) break;
    for (const r of rs) {
      lastId = r.id;
      take(placeByStateCode(ref, r));
    }
    seen += rs.length;
    await flush();
    process.stdout.write(`\r  scanned ${seen}  resolved=${counts.resolved} partial=${counts.partial}`);
  }
  await flush(true);
  console.log("");
}

// ── pass 1b: leads whose state is a FULL NAME ("Illinois", "Ontario") ──
// Pass 1 takes 2-letter codes only, so this cohort (Bison's full state names)
// would refill forever; text naming no state is left exactly as it is (see
// placeByStateName).
console.log("pass 1b: full state names...");
{
  let lastId = "00000000-0000-0000-0000-000000000000"; let seen = 0;
  const cond = ALL ? "" : `AND ${w.open}`;
  for (;;) {
    const rs = (await q(`
      SELECT id, city, state FROM leads l
      WHERE ${w.name} ${cond} AND id > $1
      ORDER BY id LIMIT 5000`, [lastId])).rows;
    if (!rs.length) break;
    for (const r of rs) {
      lastId = r.id;
      take(placeByStateName(ref, r));
    }
    seen += rs.length;
    await flush();
    process.stdout.write(`\r  scanned ${seen}  resolved=${counts.resolved} partial=${counts.partial}`);
  }
  await flush(true);
  console.log("");
}

// ── pass 2: city but no state — unique-city resolution across the reference ──
console.log("pass 2: city-only leads...");
{
  const rs = (await q(`
    SELECT id, city FROM leads l
    WHERE ${w.city}
      ${ALL ? "" : `AND ${w.fresh}`}`)).rows;
  console.log(`  candidates: ${rs.length}`);
  for (const r of rs) take(placeByCity(ref, r));
  await flush(true);
}

// ── pass 3: review-flagged leads with no resolution -> unresolved queue ──
if (!DRY) counts.unresolved += await markForReview(db);

console.log(`done: resolved=${counts.resolved} partial=${counts.partial} (city-miss=${counts.cityMiss})`
  + ` stateless-resolved=${counts.statelessResolved} unresolved=${counts.unresolved}`);
// The closing status breakdown is a full GROUP BY over leads: ~1 GB of reads
// and ~2.5 s on EVERY 30-minute cron run, for a log line nobody reads. The
// 2026-09-16 audit found this pipeline behind 66% of all disk reads since
// Aug 1. Opt in with --verbose when the breakdown is actually wanted.
if (!DRY && process.argv.includes("--verbose")) {
  const after = (await q(`
    SELECT location_status, count(*) n FROM leads GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log("status:", after.map((r) => `${r.location_status ?? "none"}=${r.n}`).join("  "));
}
// The run's finish: finished_run_started_at is this run's own start, unless a
// later run finished first (greatest), so it never moves back.
if (runStartedAt) {
  try {
    await q(
      `UPDATE cron_runs
          SET finished_at = now(),
              finished_run_started_at = greatest(coalesce(finished_run_started_at, '-infinity'::timestamptz), $2::timestamptz),
              updated_at = now()
        WHERE name = $1`,
      [CRON_LOCATION_BACKFILL, runStartedAt]
    );
  } catch (err) {
    if (err?.code !== "42P01") console.warn(`could not record the run's finish in cron_runs: ${err.message}`);
  }
}
await pool.end();
