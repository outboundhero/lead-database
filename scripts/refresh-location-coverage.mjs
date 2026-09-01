// Precompute per-location lead coverage for every client with include
// locations, into client_location_coverage (migration 096).
//
//   node scripts/refresh-location-coverage.mjs            # all targeted clients
//   node scripts/refresh-location-coverage.mjs --tag UJ   # one client
//
// Runs on the client-sync cron AFTER the targeting sync, so coverage reflects
// the sheet's latest locations. The UI reads the stored row instantly instead
// of triggering a 7-10s grouped scan on every client selection (client
// decision 2026-09-02).
//
// The scan itself is the same one the live route used, including the state
// pre-filter that took UJ from a >180s timeout to 7.6s: every sheet-synced
// entry names a state, so the state_code index cuts the table down before the
// expensive per-lead conditions run.
import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname });

const env = process.env;
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1] ?? true) : d; };
const ONLY = flag("tag");
const THRESHOLD = Number(flag("threshold")) || 500;

if (!env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, keepAlive: true });
pool.on("error", (e) => console.log(`   pg pool: ${e.message}`));

const ELIGIBLE =
  "l.email is not null and l.email <> '' and l.is_bounced = false and l.is_suppressed = false " +
  "and (l.validation_status in ('valid','catch_all') or l.validation_status is null)";
const esc = (v) => `'${String(v).replace(/'/g, "''")}'`;

async function computeFor(tag, entries) {
  const started = Date.now();
  const { rows: eligRows } = await pool.query(`select fn_client_eligibility_conditions($1) as conds`, [tag]);
  const conds = eligRows[0]?.conds ?? [];
  const notPushed = `not exists (
    select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
    where pb.client_tag = $1 and pi.lead_id = l.id and pi.status = 'sent')`;

  const everyEntryHasState = entries.every((e) => e.state);
  const stateCond = everyEntryHasState
    ? "(" + [...new Set(entries.map((e) => `${e.country}|${String(e.state).toUpperCase()}`))]
        .map((s) => { const [co, st] = s.split("|"); return `(l.country_code = ${esc(co)} and l.state_code = ${esc(st)})`; })
        .join(" or ") + ")"
    : null;
  const where = [stateCond, ELIGIBLE, ...conds, notPushed].filter(Boolean).join(" and ");

  const client = await pool.connect();
  let agg;
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '160s'");
    const res = await client.query(
      `select l.country_code, l.state_code, l.location_id, count(*)::int as n
         from leads l where ${where} group by 1, 2, 3`, [tag]);
    await client.query("commit");
    agg = res.rows;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }

  const byLocation = new Map();
  const byState = new Map();
  let total = 0;
  for (const r of agg) {
    total += r.n;
    if (r.location_id != null) byLocation.set(String(r.location_id), (byLocation.get(String(r.location_id)) ?? 0) + r.n);
    const sk = `${r.country_code ?? ""}|${r.state_code ?? ""}`;
    byState.set(sk, (byState.get(sk) ?? 0) + r.n);
  }

  // Resolve all city entries to geoname ids in one round trip.
  const cityEntries = entries.filter((e) => e.city && e.state);
  const idsByIdx = new Map();
  if (cityEntries.length > 0) {
    const { rows } = await pool.query(
      `select e.idx::int as idx, array_agg(g.geoname_id::text) as ids
         from unnest($1::text[], $2::text[], $3::text[]) with ordinality as e(country, state, city, idx)
         join geo_admin1 a on a.country_code = e.country and a.state_code = upper(e.state)
         join geo_locations g on g.country_code = e.country and g.admin1_code = a.admin1_code
          and g.city_key = regexp_replace(lower(e.city), '[^a-z]', '', 'g')
        group by e.idx`,
      [cityEntries.map((e) => e.country), cityEntries.map((e) => e.state), cityEntries.map((e) => e.city)]);
    for (const r of rows) idsByIdx.set(Number(r.idx), r.ids ?? []);
  }

  let cityIdx = 0;
  const locations = entries.map((e) => {
    if (e.city && e.state) {
      cityIdx += 1;
      const ids = idsByIdx.get(cityIdx) ?? [];
      return {
        label: `${e.city}, ${e.state}`, kind: "city",
        country: e.country, state: e.state ?? null, city: e.city ?? null,
        available: ids.reduce((s, id) => s + (byLocation.get(id) ?? 0), 0),
        resolved: ids.length > 0,
      };
    }
    const sk = `${e.country}|${String(e.state ?? "").toUpperCase()}`;
    return {
      label: e.state ? `${e.state} (state-wide)` : e.country, kind: "state",
      country: e.country, state: e.state ?? null, city: null,
      available: e.state ? (byState.get(sk) ?? 0) : total,
      resolved: true,
    };
  });
  locations.sort((a, b) => a.available - b.available);
  return {
    payload: {
      tag, threshold: THRESHOLD, hasTargeting: true, totalAvailable: total,
      locations, low: locations.filter((l) => l.available < THRESHOLD),
      computedAt: new Date().toISOString(),
    },
    total,
    ms: Date.now() - started,
  };
}

const { rows: clients } = await pool.query(
  `select t.client_tag, t.include_locations
     from client_targeting t
     join client_tags ct on ct.tag = t.client_tag
    where jsonb_array_length(t.include_locations) > 0
      ${ONLY ? "and t.client_tag = $1" : ""}
    order by t.client_tag`,
  ONLY ? [ONLY] : []);
console.log(`computing coverage for ${clients.length} client(s), threshold ${THRESHOLD}`);

let ok = 0, failed = 0;
const started = Date.now();
for (const c of clients) {
  try {
    const { payload, total, ms } = await computeFor(c.client_tag, c.include_locations);
    await pool.query(
      `insert into client_location_coverage (client_tag, threshold, total_available, payload, computed_at, compute_ms)
       values ($1, $2, $3, $4::jsonb, now(), $5)
       on conflict (client_tag) do update set
         threshold = excluded.threshold, total_available = excluded.total_available,
         payload = excluded.payload, computed_at = now(), compute_ms = excluded.compute_ms`,
      [c.client_tag, THRESHOLD, total, JSON.stringify(payload), ms]);
    ok++;
    console.log(`   ${c.client_tag.padEnd(10)} ${String(payload.low.length).padStart(3)} low of ${String(payload.locations.length).padStart(3)}  total ${total.toLocaleString().padStart(9)}  (${(ms/1000).toFixed(1)}s)`);
  } catch (e) {
    failed++;
    console.log(`   ${c.client_tag.padEnd(10)} FAILED: ${String(e.message).slice(0, 90)}`);
  }
}
console.log(`\ndone in ${((Date.now()-started)/60000).toFixed(1)} min: ${ok} computed, ${failed} failed`);
await pool.end();
process.exit(failed > 0 && ok === 0 ? 1 : 0);
