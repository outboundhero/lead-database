#!/usr/bin/env node
import "dotenv/config";

/**
 * Load the GeoNames reference into geo_admin1 + geo_locations.
 *
 * Inputs (data/geo/raw/, fetched from download.geonames.org/export/dump):
 *   admin1.txt        — admin1CodesASCII.txt (all countries)
 *   ../places_slim.tsv — populated places (feature class P) pre-filtered to
 *                        the supported countries: geonameid, name, ascii,
 *                        alternatenames, country, admin1, population
 *
 * Re-runnable: upserts by primary key. To add a country later: insert into
 * supported_countries, download its dump, re-run the slimmer + this loader.
 *
 * Usage: node --env-file=.env.local scripts/load-geo-reference.mjs
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "geo");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));

const ck = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

// Display state codes where GeoNames admin1 codes aren't already postal codes.
const CA_CODES = { "01":"AB","02":"BC","03":"MB","04":"NB","05":"NL","07":"NS","08":"ON","09":"PE","10":"QC","11":"SK","12":"YT","13":"NT","14":"NU" };
const AU_CODES = { "01":"ACT","02":"NSW","03":"NT","04":"QLD","05":"SA","06":"TAS","07":"VIC","08":"WA" };
const NZ_CODES = { E7:"AUK",E8:"BOP",E9:"CAN",F1:"GIS",F2:"HKB",F3:"MWT",F4:"MBH",F5:"NSN",F6:"NTL",F7:"OTA",F8:"STL",F9:"TKI",G1:"WKO",G2:"WGN",G3:"WTC",TAS:"TAS","10":"CIT" };
// GB + IE admin1 codes are already usable (ENG/SCT/WLS/NIR, C/L/M/U).

const SUPPORTED = new Set(["US", "CA", "AU", "NZ", "GB", "IE"]);

function stateCodeFor(country, admin1) {
  if (country === "US") return admin1;
  if (country === "CA") return CA_CODES[admin1] ?? admin1;
  if (country === "AU") return AU_CODES[admin1] ?? admin1;
  if (country === "NZ") return NZ_CODES[admin1] ?? admin1;
  return admin1; // GB, IE
}

// Trim GeoNames NZ decoration ("Wellington Region" -> "Wellington")
function cleanAdmin1Name(country, name) {
  if (country === "NZ") return name.replace(/\s+(Region|District)$/i, "");
  return name;
}

// ── admin1 ──
console.log("loading geo_admin1...");
{
  const lines = fs.readFileSync(path.join(DIR, "raw", "admin1.txt"), "utf8").split("\n");
  const rows = [];
  for (const line of lines) {
    const [code, name] = line.split("\t");
    if (!code || !name) continue;
    const [country, admin1] = code.split(".");
    if (!SUPPORTED.has(country)) continue;
    rows.push({ country, admin1, name: cleanAdmin1Name(country, name), state_code: stateCodeFor(country, admin1) });
  }
  await pool.query(`
    INSERT INTO geo_admin1 (country_code, admin1_code, name, state_code)
    SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), unnest($4::text[])
    ON CONFLICT (country_code, admin1_code) DO UPDATE SET name = EXCLUDED.name, state_code = EXCLUDED.state_code
  `, [rows.map((r) => r.country), rows.map((r) => r.admin1), rows.map((r) => r.name), rows.map((r) => r.state_code)]);
  console.log(`  ${rows.length} regions loaded`);
}

// ── places ──
console.log("loading geo_locations (streaming)...");
{
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(DIR, "places_slim.tsv")), crlfDelay: Infinity });
  let batch = [], total = 0, skipped = 0;
  async function flush() {
    if (!batch.length) return;
    const b = batch; batch = [];
    await pool.query(`
      INSERT INTO geo_locations (geoname_id, city, city_key, alternate_names, country_code, admin1_code, population)
      SELECT unnest($1::bigint[]), unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), unnest($5::text[]), unnest($6::text[]), unnest($7::bigint[])
      ON CONFLICT (geoname_id) DO UPDATE SET
        city = EXCLUDED.city, city_key = EXCLUDED.city_key, alternate_names = EXCLUDED.alternate_names,
        country_code = EXCLUDED.country_code, admin1_code = EXCLUDED.admin1_code, population = EXCLUDED.population
    `, [b.map((r) => r.id), b.map((r) => r.city), b.map((r) => r.key), b.map((r) => r.alt),
        b.map((r) => r.country), b.map((r) => r.admin1), b.map((r) => r.pop)]);
    total += b.length;
    process.stdout.write(`\r  ${total} places`);
  }
  for await (const line of rl) {
    const [id, name, ascii, alt, country, admin1, pop] = line.split("\t");
    if (!id || !name || !SUPPORTED.has(country)) continue;
    if (!admin1 || admin1 === "00") { skipped++; continue; }  // no region — unusable for validation
    const key = ck(ascii || name);
    if (!key) { skipped++; continue; }
    batch.push({ id: Number(id), city: name, key, alt: alt || null, country, admin1, pop: Number(pop) || 0 });
    if (batch.length >= 5000) await flush();
  }
  await flush();
  console.log(`\n  loaded=${total} skipped(no-region)=${skipped}`);
}

// ── seed reference aliases: full state names + codes + country variants ──
console.log("seeding reference aliases...");
{
  const admin1 = (await pool.query(`SELECT country_code, name, state_code FROM geo_admin1`)).rows;
  // Context-free aliases: on cross-country collisions ("WA" = US Washington
  // AND AU Western Australia) the higher-priority country wins. Leads WITH a
  // country context bypass aliases entirely (direct geo_admin1 lookup).
  const PRIORITY = { US: 0, CA: 1, AU: 2, NZ: 3, GB: 4, IE: 5 };
  const aliases = new Map(); // key -> {level, country, state}
  const put = (raw, entry) => {
    const k = ck(raw); if (!k) return;
    const cur = aliases.get(k);
    if (cur && PRIORITY[cur.country] <= PRIORITY[entry.country]) return; // keep higher priority
    aliases.set(k, entry);
  };
  for (const a of admin1) {
    put(a.name, { level: "state", country: a.country_code, state: a.state_code });
    if (a.country_code === "US") put(`${a.name} state`, { level: "state", country: a.country_code, state: a.state_code });
    if (a.state_code.length >= 2) put(a.state_code, { level: "state", country: a.country_code, state: a.state_code });
  }
  // DC special-cases per spec: every DC variation -> District of Columbia, never WA
  for (const v of ["washington dc", "washington d c", "washington, d.c.", "dc", "district of columbia"]) {
    aliases.set(ck(v), { level: "state", country: "US", state: "DC" });
  }
  aliases.set(ck("washington state"), { level: "state", country: "US", state: "WA" });
  // country variants
  const countryAliases = {
    US: ["USA", "United States", "United States of America", "US", "America", "U.S.", "U.S.A."],
    CA: ["Canada", "CAN"],
    AU: ["Australia", "AUS"],
    NZ: ["New Zealand", "NZL"],
    GB: ["United Kingdom", "UK", "Great Britain", "England", "Scotland", "Wales", "Northern Ireland", "GBR"],
    IE: ["Ireland", "IRL", "Republic of Ireland", "Eire"],
  };
  for (const [code, vars] of Object.entries(countryAliases)) {
    for (const v of vars) {
      const k = ck(v); if (!k) continue;
      if (!aliases.has(k)) aliases.set(k, { level: "country", country: code, state: null });
    }
  }
  const rows = [...aliases.entries()].filter(([, v]) => v !== null).map(([k, v]) => ({ k, ...v }));
  await pool.query(`
    INSERT INTO location_aliases (alias_key, level, country_code, state_code, source)
    SELECT unnest($1::text[]), unnest($2::text[]), unnest($3::text[]), unnest($4::text[]), 'reference'
    ON CONFLICT (alias_key) DO NOTHING
  `, [rows.map((r) => r.k), rows.map((r) => r.level), rows.map((r) => r.country), rows.map((r) => r.state)]);
  console.log(`  ${rows.length} aliases seeded`);
}

const stats = (await pool.query(`
  SELECT (SELECT count(*) FROM geo_admin1) regions,
         (SELECT count(*) FROM geo_locations) places,
         (SELECT count(*) FROM location_aliases) aliases`)).rows[0];
console.log(`done: regions=${stats.regions} places=${stats.places} aliases=${stats.aliases}`);
// sanity: the DC-vs-WA distinction
const dc = (await pool.query(`SELECT alias_key, state_code FROM location_aliases WHERE alias_key IN ('washingtondc','washington','wa','dc','districtofcolumbia','washingtonstate')`)).rows;
console.log("DC/WA sanity:", dc.map((r) => `${r.alias_key}->${r.state_code}`).join("  "));
await pool.end();
