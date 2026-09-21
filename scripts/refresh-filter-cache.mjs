#!/usr/bin/env node
// refresh-filter-cache.mjs — repopulate filter_options_cache, the table behind
// the Leads-page dropdowns (source, title, city, state, esp, …).
//
//   node scripts/refresh-filter-cache.mjs            refresh if the OLDEST row is > 20h
//   node scripts/refresh-filter-cache.mjs --force    refresh regardless
//   node scripts/refresh-filter-cache.mjs --max-age-hours=6
//
// Runs as the last step of the 6-hourly `client-sync` cron; the age gate makes
// that effectively once a day. It exists because the previous refresh path was
// `refreshFilterCache()` inside categorize-worker, which has been parked by its
// worker_locks lease since 2026-08-17 — so the dropdowns had not refreshed since
// 2026-07-28 (found by the 2026-09-16 performance audit).
//
// SAFETY GATE. The first refresh after that gap (2026-09-17 13:18 UTC) pushed
// 13,156 "states" into a chip that renders its whole list locally — phone
// numbers, addresses, a JSON blob — because leads.state had drifted and the
// function had no quality filter. Migration 102 added the filters; this script
// additionally runs the refresh INSIDE a transaction and ROLLS BACK unless the
// resulting cardinalities are sane, so a future data drift fails loudly here
// instead of shipping junk to every operator.
//
// Timeouts: fn_refresh_filter_cache() carries `SET statement_timeout = '300s'`,
// but a function-level SET cannot re-arm the timer of the statement that is
// already running it — the 600 s SET LOCAL below is the bound that actually
// applies. Everything is transaction-scoped (SET LOCAL): DATABASE_URL is the
// transaction pooler, where a session-level SET leaks onto shared backends —
// that mistake took the push-worker down for 51 minutes on 2026-09-16.

import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const argv = process.argv.slice(2);
const flag = (name) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
};
const FORCE = !!flag("force");
const MAX_AGE_H = Number(flag("max-age-hours")) || 20;
// Upper bounds a healthy refresh stays well under (measured 2026-09-17 after
// migration 102: state 125, city ~10k, title well under 100k).
const SANE = { state: 200, city: 20000, title: 100000 };
// The "Email / Domain Ends With" dropdown lists (migration 112): ~500 endings each.
const SUFFIX_COLS = ["email_suffix", "domain_suffix"];
const SANE_SUFFIX = 3000;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (...m) => console.log(ts(), ...m);

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

// Watchdog: never outlive the cron slot (the SET LOCAL bounds the SQL at 600 s).
setTimeout(() => { console.error("WATCHDOG: exceeded 12 min — exiting"); process.exit(0); }, 12 * 60_000).unref();

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("begin");
  await client.query("set local statement_timeout = '30s'");
  // The OLDEST row decides: a single-row writer elsewhere must not make the
  // whole cache look fresh. An empty table (NULL) refreshes.
  const { rows: [age] } = await client.query(
    `select count(*)::int as n, extract(epoch from (now() - min(updated_at)))/3600 as hours
       from filter_options_cache where col_name <> all($1::text[])`, [SUFFIX_COLS]
  );
  const { rows: [sfxAge] } = await client.query(
    `select count(*)::int as n, extract(epoch from (now() - min(updated_at)))/3600 as hours
       from filter_options_cache where col_name = any($1::text[])`, [SUFFIX_COLS]
  );
  await client.query("commit");
  const hours = age.hours == null ? Infinity : Number(age.hours);

  if (!FORCE && hours < MAX_AGE_H) {
    log(`filter cache is ${hours.toFixed(1)}h old (${age.n} rows) — under ${MAX_AGE_H}h, nothing to do`);
  } else {
    log(`filter cache is ${Number.isFinite(hours) ? hours.toFixed(1) + "h old" : "empty"} — refreshing`);
    const started = Date.now();
    await client.query("begin");
    await client.query("set local statement_timeout = '600s'");
    await client.query("select fn_refresh_filter_cache()");
    const { rows } = await client.query(
      `select col_name, cardinality(options) as n from filter_options_cache order by col_name`
    );
    const card = Object.fromEntries(rows.map((r) => [r.col_name, Number(r.n)]));
    const bad = Object.entries(SANE).filter(([col, max]) => (card[col] ?? 0) > max);
    if (bad.length) {
      await client.query("rollback");
      throw new Error(
        `refresh ROLLED BACK — cardinality out of bounds: ` +
        bad.map(([col, max]) => `${col}=${card[col]} (max ${max})`).join(", ") +
        ". The source columns have drifted; fix the data or the gates in fn_refresh_filter_cache before retrying."
      );
    }
    await client.query("commit");
    log(`refreshed in ${((Date.now() - started) / 1000).toFixed(0)}s: ` +
        rows.map((r) => `${r.col_name}=${r.n}`).join(" "));
  }

  // Endings for the "Email / Domain Ends With" dropdowns. Own age gate and own
  // transaction: one parallel scan of leads (~1 min); if it is slow or fails it
  // must neither roll back the main cache nor make it look stale.
  const sfxHours = sfxAge.n < SUFFIX_COLS.length || sfxAge.hours == null ? Infinity : Number(sfxAge.hours);
  if (!FORCE && sfxHours < MAX_AGE_H) {
    log(`suffix options are ${sfxHours.toFixed(1)}h old — under ${MAX_AGE_H}h, nothing to do`);
  } else {
    const started = Date.now();
    await client.query("begin");
    await client.query("set local statement_timeout = '600s'");
    await client.query("select fn_refresh_suffix_options()");
    const { rows } = await client.query(
      `select col_name, cardinality(options) as n from filter_options_cache where col_name = any($1::text[]) order by col_name`, [SUFFIX_COLS]
    );
    const bad = rows.filter((r) => Number(r.n) === 0 || Number(r.n) > SANE_SUFFIX);
    if (bad.length || rows.length < SUFFIX_COLS.length) {
      await client.query("rollback");
      throw new Error(`suffix options refresh ROLLED BACK — ` + (bad.length ? bad.map((r) => `${r.col_name}=${r.n}`).join(", ") : "rows missing") + ` (expected 1–${SANE_SUFFIX} options each)`);
    }
    await client.query("commit");
    log(`suffix options refreshed in ${((Date.now() - started) / 1000).toFixed(0)}s: ` + rows.map((r) => `${r.col_name}=${r.n}`).join(" "));
  }
} catch (e) {
  await client.query("rollback").catch(() => {});
  console.error(ts(), "ERROR", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await client.end();
}
process.exit(process.exitCode ?? 0);
