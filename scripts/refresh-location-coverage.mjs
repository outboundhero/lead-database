// Precompute per-location lead coverage for every client with include
// locations, into client_location_coverage (migration 096).
//
//   node scripts/refresh-location-coverage.mjs                    # all targeted clients
//   node scripts/refresh-location-coverage.mjs --tag UJ           # one client
//   node scripts/refresh-location-coverage.mjs --threshold 300    # one number for every client
//
// Runs on the client-sync cron AFTER the targeting sync, so coverage reflects
// the sheet's latest locations. The UI reads the stored row instantly instead
// of triggering a 7-10s grouped scan on every client selection (client
// decision 2026-09-02).
//
// Each client is measured against its own minimum of good leads a place
// (client_targeting.min_leads_per_place, set in the Rules dialog), else the
// weekly top-up's default (weekly_topup.default_minimum, 500); --threshold
// forces one number for this run. The number used is stored as the row's
// threshold, which the Leads page popup prints. General inboxes the Clay
// General inboxes filter matches are not counted, once that filter is loaded.
// The computation is scripts/lib/coverage.mjs, shared with the route and the
// weekly top-up.
import pg from "pg";
import dotenv from "dotenv";
import { computeCoverage, coverageSettings, hasMinimumColumn, minimumOf, storeCoverage, wholeMinimum } from "./lib/coverage.mjs";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname });

const env = process.env;
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1] ?? true) : d; };
const ONLY = flag("tag");
const FORCED = flag("threshold");
if (FORCED !== null && wholeMinimum(FORCED) === null) {
  console.error("--threshold must be a whole number from 1 to 100,000");
  process.exit(1);
}

if (!env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, keepAlive: true });
pool.on("error", (e) => console.log(`   pg pool: ${e.message}`));

const { defaultMinimum, pattern, patternSha256 } = await coverageSettings(pool);
// Before migration 135 there is no per-client minimum: every client takes the default.
const ownMinimum = (await hasMinimumColumn(pool)) ? "t.min_leads_per_place" : "null::int";
const { rows: clients } = await pool.query(
  `select t.client_tag, t.include_locations, ${ownMinimum} as min_leads_per_place
     from client_targeting t
     join client_tags ct on ct.tag = t.client_tag
    where jsonb_array_length(t.include_locations) > 0
      ${ONLY ? "and t.client_tag = $1" : ""}
    order by t.client_tag`,
  ONLY ? [ONLY] : []);
console.log(
  `computing coverage for ${clients.length} client(s), ` +
  (FORCED !== null ? `threshold ${Number(FORCED)} for all` : `each at its own minimum (default ${defaultMinimum})`) +
  (pattern ? ", general inboxes on the Clay filter left out" : ""));

let ok = 0, failed = 0;
const started = Date.now();
for (const c of clients) {
  try {
    const { minimum } = minimumOf({ forced: FORCED !== null ? Number(FORCED) : null, own: c.min_leads_per_place, defaultMinimum });
    const { payload, total, ms } = await computeCoverage(pool, {
      tag: c.client_tag, entries: c.include_locations, threshold: minimum, pattern, patternSha256,
    });
    await storeCoverage(pool, { tag: c.client_tag, threshold: minimum, total, payload, ms });
    ok++;
    console.log(`   ${c.client_tag.padEnd(10)} ${String(payload.low.length).padStart(3)} low of ${String(payload.locations.length).padStart(3)}  total ${total.toLocaleString().padStart(9)}  min ${String(minimum).padStart(6)}  (${(ms/1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.log(`   ${c.client_tag.padEnd(10)} FAILED: ${String(e.message).slice(0, 90)}`);
  }
}
console.log(`\ndone in ${((Date.now()-started)/60000).toFixed(1)} min: ${ok} computed, ${failed} failed`);
await pool.end();
process.exit(failed > 0 && ok === 0 ? 1 : 0);
