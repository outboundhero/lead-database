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
 * Usage: node --env-file=.env.local scripts/backfill-lead-locations.mjs [--dry-run] [--all]
 */

import pg from "pg";

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
const ck = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

// ── reference into memory ──
console.log("loading reference...");
const countries = new Map(); // code -> display
for (const r of (await q(`SELECT code, display_name FROM supported_countries WHERE enabled`)).rows) {
  countries.set(r.code, r.display_name);
}
const admin1ByCode = new Map();  // `${country}|${state_code}` -> {admin1, name}
const stateCodeCountry = new Map(); // state_code -> [countries] (collision-aware)
for (const r of (await q(`SELECT country_code, admin1_code, name, state_code FROM geo_admin1`)).rows) {
  admin1ByCode.set(`${r.country_code}|${r.state_code}`, { admin1: r.admin1_code, name: r.name });
  if (!stateCodeCountry.has(r.state_code)) stateCodeCountry.set(r.state_code, []);
  stateCodeCountry.get(r.state_code).push(r.country_code);
}
const geo = new Map(); // `${city_key}|${country}|${admin1}` -> {id, city, pop}
const geoByKey = new Map(); // city_key -> [{id, country, admin1, city, pop}] (for stateless lookup)
{
  const CH = 50000; let off = 0;
  for (;;) {
    const rs = (await q(`SELECT geoname_id, city, city_key, country_code, admin1_code, population
                         FROM geo_locations ORDER BY geoname_id LIMIT ${CH} OFFSET ${off}`)).rows;
    if (!rs.length) break;
    for (const r of rs) {
      const k = `${r.city_key}|${r.country_code}|${r.admin1_code}`;
      const cur = geo.get(k);
      if (!cur || Number(r.population) > cur.pop) geo.set(k, { id: Number(r.geoname_id), city: r.city, pop: Number(r.population) });
      if (!geoByKey.has(r.city_key)) geoByKey.set(r.city_key, []);
      geoByKey.get(r.city_key).push({ id: Number(r.geoname_id), country: r.country_code, admin1: r.admin1_code, city: r.city, pop: Number(r.population) });
    }
    off += CH; process.stdout.write(`\r  geo rows: ${off}`);
  }
  console.log(`\n  lookup keys: ${geo.size}`);
}

// US-state-code priority: a lead's 2-letter code could be US or CA/AU (WA!).
// Existing DB codes came from the US+CA normalization, so US wins, then CA.
function countryForStateCode(code) {
  const cands = stateCodeCountry.get(code) ?? [];
  for (const pref of ["US", "CA", "AU", "NZ", "GB", "IE"]) if (cands.includes(pref)) return pref;
  return null;
}

const counts = { resolved: 0, partial: 0, cityMiss: 0, statelessResolved: 0, unresolved: 0 };
const updates = [];
async function flush(force = false) {
  if (!updates.length || (!force && updates.length < 2000)) return;
  const b = updates.splice(0, updates.length);
  if (DRY) return;
  await q(`
    UPDATE leads l SET
      state = v.state_name, state_code = v.state_code,
      country = v.country_disp, country_code = v.country_code,
      city = COALESCE(v.city_disp, l.city),
      location_id = v.loc_id, location_status = v.status,
      location_source = COALESCE(l.raw_data->>'state_source', 'source')
    FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) state_name, unnest($3::text[]) state_code,
                 unnest($4::text[]) country_disp, unnest($5::text[]) country_code,
                 unnest($6::text[]) city_disp, unnest($7::bigint[]) loc_id, unnest($8::text[]) status) v
    WHERE l.id = v.id
  `, [b.map((u) => u.id), b.map((u) => u.stateName), b.map((u) => u.stateCode),
      b.map((u) => u.countryDisp), b.map((u) => u.countryCode),
      b.map((u) => u.cityDisp ?? null), b.map((u) => u.locId ?? null), b.map((u) => u.status)]);
}

// ── pass 1: leads with a state code ──
console.log("pass 1: leads with state...");
{
  let lastId = "00000000-0000-0000-0000-000000000000"; let seen = 0;
  const cond = ALL ? "" : "AND l.state_code IS NULL";
  for (;;) {
    const rs = (await q(`
      SELECT id, city, state FROM leads l
      WHERE state IS NOT NULL AND length(btrim(state)) = 2 ${cond} AND id > $1
      ORDER BY id LIMIT 5000`, [lastId])).rows;
    if (!rs.length) break;
    for (const r of rs) {
      lastId = r.id;
      const code = r.state.trim().toUpperCase();
      const country = countryForStateCode(code);
      if (!country) { counts.unresolved++; updates.push({ id: r.id, stateName: null, stateCode: null, countryDisp: null, countryCode: null, status: "unresolved" }); continue; }
      const a1 = admin1ByCode.get(`${country}|${code}`);
      if (!a1) { counts.unresolved++; continue; }
      const base = { id: r.id, stateName: a1.name, stateCode: code, countryDisp: countries.get(country), countryCode: country };
      if (r.city && r.city.trim()) {
        const hit = geo.get(`${ck(r.city)}|${country}|${a1.admin1}`);
        if (hit) { updates.push({ ...base, cityDisp: hit.city, locId: hit.id, status: "resolved" }); counts.resolved++; }
        else { updates.push({ ...base, status: "partial" }); counts.partial++; counts.cityMiss++; }
      } else {
        updates.push({ ...base, status: "partial" }); counts.partial++;
      }
    }
    seen += rs.length;
    await flush();
    process.stdout.write(`\r  scanned ${seen}  resolved=${counts.resolved} partial=${counts.partial}`);
  }
  await flush(true);
  console.log("");
}

// ── pass 1b: leads whose state is a FULL NAME ("Illinois", "Ontario") ──
// Bison's custom_variables write full state names, and the 3-day import plus
// the custom-vars backfill copy them in verbatim — so this cohort refills
// forever and pass 1 (2-letter codes only) never touches it. Resolution is by
// geo_admin1.name with the same country priority as codes.
//
// Text that matches NO state name (the old junk: "North America", "your area")
// is left EXACTLY as it is — not marked unresolved, because unresolved leads
// are hidden from browse and campaigns, and silently hiding ~50k
// currently-visible leads is not this pass's call to make.
console.log("pass 1b: full state names...");
{
  const admin1ByName = new Map(); // lower(name) -> {country, code, name}
  for (const pref of ["US", "CA", "AU", "NZ", "GB", "IE"]) {
    for (const [k, v] of admin1ByCode) {
      const [country] = k.split("|");
      if (country !== pref) continue;
      const key = v.name.toLowerCase();
      if (!admin1ByName.has(key)) admin1ByName.set(key, { country, code: k.split("|")[1], name: v.name });
    }
  }
  let lastId = "00000000-0000-0000-0000-000000000000"; let seen = 0;
  const cond = ALL ? "" : "AND l.state_code IS NULL";
  for (;;) {
    const rs = (await q(`
      SELECT id, city, state FROM leads l
      WHERE state IS NOT NULL AND length(btrim(state)) > 2 ${cond} AND id > $1
      ORDER BY id LIMIT 5000`, [lastId])).rows;
    if (!rs.length) break;
    for (const r of rs) {
      lastId = r.id;
      const hit = admin1ByName.get(r.state.trim().toLowerCase());
      if (!hit) continue; // junk or foreign — leave untouched
      const a1 = admin1ByCode.get(`${hit.country}|${hit.code}`);
      if (!a1) continue;
      const base = { id: r.id, stateName: a1.name, stateCode: hit.code, countryDisp: countries.get(hit.country), countryCode: hit.country };
      if (r.city && r.city.trim()) {
        const g = geo.get(`${ck(r.city)}|${hit.country}|${a1.admin1}`);
        if (g) { updates.push({ ...base, cityDisp: g.city, locId: g.id, status: "resolved" }); counts.resolved++; }
        else { updates.push({ ...base, status: "partial" }); counts.partial++; counts.cityMiss++; }
      } else {
        updates.push({ ...base, status: "partial" }); counts.partial++;
      }
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
    SELECT id, city FROM leads
    WHERE state IS NULL AND city IS NOT NULL AND btrim(city) <> ''
      ${ALL ? "" : "AND location_status IS NULL"}`)).rows;
  console.log(`  candidates: ${rs.length}`);
  for (const r of rs) {
    const list = geoByKey.get(ck(r.city)) ?? [];
    // unique = one (country, admin1) with meaningful population dominance
    const spots = new Map();
    for (const g of list) spots.set(`${g.country}|${g.admin1}`, g);
    if (spots.size === 1) {
      const g = [...spots.values()][0];
      const a1 = [...admin1ByCode.entries()].find(([k, v]) => k.startsWith(g.country + "|") && v.admin1 === g.admin1);
      if (a1) {
        updates.push({ id: r.id, stateName: a1[1].name, stateCode: a1[0].split("|")[1], countryDisp: countries.get(g.country), countryCode: g.country, cityDisp: g.city, locId: g.id, status: "resolved" });
        counts.statelessResolved++;
        continue;
      }
    }
    updates.push({ id: r.id, stateName: null, stateCode: null, countryDisp: null, countryCode: null, status: "unresolved" });
    counts.unresolved++;
  }
  await flush(true);
}

// ── pass 3: review-flagged leads with no resolution -> unresolved queue ──
if (!DRY) {
  const r = await q(`
    UPDATE leads SET location_status = 'unresolved'
    WHERE location_status IS NULL AND state IS NULL
      AND (raw_data ? 'location_review' OR raw_data ? 'state_pre_clean')`);
  counts.unresolved += r.rowCount;
}

console.log(`done: resolved=${counts.resolved} partial=${counts.partial} (city-miss=${counts.cityMiss})`
  + ` stateless-resolved=${counts.statelessResolved} unresolved=${counts.unresolved}`);
if (!DRY) {
  const after = (await q(`
    SELECT location_status, count(*) n FROM leads GROUP BY 1 ORDER BY 2 DESC`)).rows;
  console.log("status:", after.map((r) => `${r.location_status ?? "none"}=${r.n}`).join("  "));
}
await pool.end();
