#!/usr/bin/env node
import "dotenv/config";

/**
 * Normalize the leads.state column to valid US/Canada 2-letter codes.
 *
 * Deterministic, audit-approved methods only (adversarially verified 2026-07-24):
 *   - in-string evidence: full state name, "Name (XX)", trailing ", XX[, US]",
 *     "XX 12345", delimited name part, leading-anchored name (skipped when the
 *     value is itself a known city — "Kansas City" stays untouched)
 *   - authoritative ZIP5 -> state with city-consistency check
 *   - unique-city misfiled as state (corroborated >=2x by our own clean rows)
 *   - city-column recovery ONLY when the junk value is a pure placeholder or a
 *     word-fragment of the city itself ("Francisco" + "San Francisco")
 *
 * Everything else -> NULL. Ambiguous-but-recoverable rows are tagged
 * raw_data.state_ai_candidate=true for the AI pass. Every changed row keeps its
 * original value in raw_data.state_pre_clean (fully reversible).
 *
 * Reference data (fetched 2026-07-24, cached in data/geo/):
 *   zips.csv (ZIP5->state+city), us_cities.csv, us-cities-top-1k.csv (population),
 *   world-cities.csv (Canada provinces + foreign-region veto list)
 *
 * Usage: node --env-file=.env.local scripts/clean-state-column.mjs [--dry-run]
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "geo");
const DRY = process.argv.includes("--dry-run");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));
async function q(text, params, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(text, params); }
    catch (err) {
      const transient = /ECONNRESET|termin|timeout|socket|EPIPE|server closed/i.test(err.message || "");
      if (!transient || attempt >= tries) throw err;
      console.warn(`  transient DB error (${attempt}/${tries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

// ---------- reference data ----------
const US_CODES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR","GU","VI","AS","MP"];
const CA_CODES = ["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"];
const VALID = new Set([...US_CODES, ...CA_CODES]);

const US_NAME2CODE = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",
  connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",
  illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",
  maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",
  mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",
  pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA",
  "west virginia":"WV",wisconsin:"WI",wyoming:"WY","district of columbia":"DC",
  "washington dc":"DC","washington d c":"DC","puerto rico":"PR",guam:"GU",
  "us virgin islands":"VI","virgin islands":"VI","american samoa":"AS",
};
const CA_NAME2CODE = {
  alberta:"AB","british columbia":"BC",manitoba:"MB","new brunswick":"NB",
  "newfoundland and labrador":"NL","newfoundland & labrador":"NL",newfoundland:"NL",
  "nova scotia":"NS","northwest territories":"NT",nunavut:"NU",ontario:"ON",
  "prince edward island":"PE",pei:"PE",quebec:"QC","québec":"QC",saskatchewan:"SK",yukon:"YT",
};
const NAME2CODE = { ...US_NAME2CODE, ...CA_NAME2CODE };
const NAMES_DESC = Object.keys(NAME2CODE).sort((a, b) => b.length - a.length);

const norm = (s) => String(s).toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();
const ck = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");
const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[-_.'’]/g, " ").replace(/\s+/g, " ").trim();

const FOREIGN_KW = /\b(governorate|province|prefecture|pradesh|oblast|krai|voivodeship|emirate|departamento|distrito|england|scotland|wales|ireland|australia|zealand|baja)\b/i;
const PLACEHOLDER = /^(false|true|null|na|n\/?a|none|undefined|unknown|remote|your area|local|usa?|united states|america|north america|[-\/#.,\s\d()+]*)$/i;

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const rows = [];
  for (const line of lines) {
    const out = []; let cur = "", inq = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inq) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inq = false; } else cur += c; }
      else { if (c === '"') inq = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
    }
    out.push(cur); rows.push(out);
  }
  return rows;
}

function buildRefs() {
  const cityStates = new Map(), zip5 = new Map(), zip5City = new Map(), cityPop = new Map();
  const majorCityTokens = new Set(), foreignCities = new Set(), foreignRegions = new Set();
  const addCity = (city, code) => {
    const k = ck(city); if (!k || !VALID.has(code)) return;
    if (!cityStates.has(k)) cityStates.set(k, new Map());
    const m = cityStates.get(k); m.set(code, (m.get(code) || 0) + 1);
  };
  { // ZIP5 -> state + city
    const rows = parseCsv(fs.readFileSync(path.join(DIR, "zips.csv"), "utf8")); rows.shift();
    for (const r of rows) {
      const abbr = r[2], zip = (r[3] || "").trim().padStart(5, "0"), city = r[5];
      if (abbr && zip.length === 5) { zip5.set(zip, abbr); if (city) zip5City.set(zip, ck(city)); }
      if (city && abbr) addCity(city, abbr);
    }
  }
  { // US cities
    const rows = parseCsv(fs.readFileSync(path.join(DIR, "us_cities.csv"), "utf8")); rows.shift();
    for (const r of rows) addCity(r[3], r[1]);
  }
  { // top-1k cities with population
    const rows = parseCsv(fs.readFileSync(path.join(DIR, "us-cities-top-1k.csv"), "utf8")); rows.shift();
    for (const r of rows) {
      const code = US_NAME2CODE[norm(r[1])], pop = Number(r[2]) || 0;
      if (!code) continue; const k = ck(r[0]); if (!k) continue;
      if (!cityPop.has(k)) cityPop.set(k, new Map());
      cityPop.get(k).set(code, Math.max(cityPop.get(k).get(code) || 0, pop));
      addCity(r[0], code);
      const words = String(r[0]).split(/\s+/).filter(Boolean);
      if (words.length > 1) for (const w of words) { const t = ck(w); if (t.length >= 3) majorCityTokens.add(t); }
    }
  }
  { // world cities: Canada provinces + foreign veto lists
    const rows = parseCsv(fs.readFileSync(path.join(DIR, "world-cities.csv"), "utf8")); rows.shift();
    for (const r of rows) {
      const name = r[0], country = r[1], sub = r[2];
      if (country === "Canada") { const code = CA_NAME2CODE[norm(sub)]; if (code) addCity(name, code); }
      else if (country !== "United States") {
        const k = ck(name); if (k) foreignCities.add(k);
        if (sub) foreignRegions.add(fold(sub));
        if (country) foreignRegions.add(fold(country));
      }
    }
  }
  for (const nm of Object.keys(NAME2CODE)) foreignRegions.delete(fold(nm));
  const foreignRegionsLong = [...foreignRegions].filter((s) => s.length >= 6);
  return { cityStates, zip5, zip5City, cityPop, foreignCities, foreignRegions, foreignRegionsLong, majorCityTokens };
}

console.log("loading reference data...");
const refs = buildRefs();
console.log(`  cities=${refs.cityStates.size} zip5=${refs.zip5.size} foreignRegions=${refs.foreignRegions.size}`);

// ---------- clean-data corroboration map ----------
console.log("building corroboration map from clean rows...");
const cleanDist = new Map();
{
  const CH = 100000; let off = 0, n = 0;
  for (;;) {
    const rs = (await q(`
      SELECT upper(btrim(state)) st, city FROM leads
      WHERE state IS NOT NULL AND length(btrim(state))=2 AND upper(btrim(state)) = ANY($1::text[])
        AND city IS NOT NULL AND btrim(city) <> ''
      ORDER BY id LIMIT ${CH} OFFSET ${off}`, [[...VALID]])).rows;
    if (!rs.length) break;
    for (const r of rs) {
      const k = ck(r.city); if (!k) continue;
      if (!cleanDist.has(k)) cleanDist.set(k, new Map());
      const m = cleanDist.get(k); m.set(r.st, (m.get(r.st) || 0) + 1);
    }
    n += rs.length; off += CH; process.stdout.write(`\r  scanned ${n}`);
  }
  console.log(`\n  corroboration keys: ${cleanDist.size}`);
}

function corroborated(k, code) { const d = cleanDist.get(k); return !!d && (d.get(code) || 0) >= 2; }
function cityUnique(k) {
  const m = refs.cityStates.get(k); if (!m || m.size !== 1) return null;
  const code = [...m.keys()][0];
  return corroborated(k, code) ? code : null;
}
function cityKnown(k) { return refs.cityStates.has(k); }
function popGated(k, margin = 2.0) {
  const m = refs.cityStates.get(k); if (!m || m.size < 2) return null;
  const pm = refs.cityPop.get(k); if (!pm || !pm.size) return null;
  const s = [...pm.entries()].sort((a, b) => b[1] - a[1]); const [c1, p1] = s[0]; const p2 = s[1] ? s[1][1] : 0;
  if (!(p1 > 0 && (p2 === 0 || p1 / Math.max(p2, 1) >= margin))) return null;
  if (!corroborated(k, c1)) return null;
  const d = cleanDist.get(k);
  { let tot = 0, c = 0; for (const [st, n] of d) { tot += n; if (st === c1) c = n; } if (tot >= 5 && c / tot < 0.8) return null; }
  return c1;
}
function zipRecover(r) {
  const pc = (r.postal_code || "").trim(); const m = pc.match(/^(\d{5})(?:-\d{4})?$/); if (!m) return null;
  const st = refs.zip5.get(m[1]); if (!st) return null;
  const kc = r.city ? ck(r.city) : "";
  if (kc) {
    const cm = refs.cityStates.get(kc);
    if (cm) { if (!cm.has(st)) return { conflict: true }; }
    else { const zc = refs.zip5City.get(m[1]); if (zc && zc !== kc) return { conflict: true }; }
  }
  return { code: st };
}

function resolve(r) {
  const raw = String(r.state).trim();
  const n = norm(raw);
  if (NAME2CODE[n]) return { code: NAME2CODE[n], how: "name" };
  let m;
  if ((m = raw.match(/\(([A-Z]{2})\)/)) && VALID.has(m[1])) return { code: m[1], how: "paren-code" };
  if (!cityKnown(ck(raw))) {
    for (const nm of NAMES_DESC) { if (nm.length >= 4 && n.startsWith(nm + " ")) return { code: NAME2CODE[nm], how: "name-leading" }; }
  }
  if ((m = raw.match(/,\s*([A-Z]{2})\s*(?:,\s*(?:US|USA|United States))?\s*$/)) && VALID.has(m[1]) && m[1] !== "US") return { code: m[1], how: "code-trailing" };
  if ((m = raw.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/)) && VALID.has(m[1])) return { code: m[1], how: "code-zip" };
  if (/[,|/]/.test(raw)) {
    const parts = raw.split(/[,|/]+/).map((p) => p.trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) { const c = NAME2CODE[norm(parts[i])]; if (c) return { code: c, how: "name-part" }; }
  }

  // foreign veto — never guess a US state for a lead whose state field says elsewhere
  const f = fold(raw);
  if (refs.foreignRegions.has(f) || FOREIGN_KW.test(raw)) return { code: null, how: "foreign-region" };
  if (f.length >= 6) {
    for (const fr of refs.foreignRegionsLong) { if (f.length > fr.length && f.includes(fr)) return { code: null, how: "foreign-region" }; }
  }

  if (r.city) { // truncation repair: "San" + "Francisco"
    const combo = ck(r.city + raw);
    const u = cityUnique(combo) ?? popGated(combo);
    if (u) return { code: u, how: "split-city" };
  }
  const zr = zipRecover(r);
  if (zr?.code) return { code: zr.code, how: "zip" };
  const zipConflict = !!zr?.conflict;

  const kraw = ck(raw);
  const fragment = refs.majorCityTokens.has(kraw);
  const foreignCity = refs.foreignCities.has(kraw);
  if (!fragment && !foreignCity) {
    const u = cityUnique(kraw); if (u) return { code: u, how: "stateCity-unique" };
    if (popGated(kraw)) return { code: null, how: "ai-candidate" };
  }
  if (r.city && !zipConflict) {
    const kc = ck(r.city);
    const cityWords = String(r.city).toLowerCase().split(/[^a-z]+/).filter(Boolean);
    const noSignal = PLACEHOLDER.test(raw);
    const fragOfCity = kraw.length >= 3 && cityWords.includes(kraw);
    if (noSignal || fragOfCity) {
      const u = cityUnique(kc);
      if (u) return { code: u, how: fragOfCity ? "cityFrag-unique" : "cityCol-unique" };
      if (popGated(kc)) return { code: null, how: "ai-candidate" };
    } else if (cityKnown(kc) || refs.foreignCities.has(kc)) {
      return { code: null, how: "ai-candidate" };
    }
  }
  if (foreignCity) return { code: null, how: "foreign-city" };
  if (zipConflict) return { code: null, how: "zip-conflict" };
  if (fragment) return { code: null, how: "fragment" };
  if (cityKnown(kraw)) return { code: null, how: "ai-candidate" };
  return { code: null, how: "junk" };
}

// ---------- execute ----------
// 1. case/whitespace normalization of already-valid codes
const caseFix = await q(`
  SELECT count(*) n FROM leads
  WHERE state IS NOT NULL AND length(btrim(state))=2
    AND upper(btrim(state)) = ANY($1::text[]) AND state <> upper(btrim(state))`, [[...VALID]]);
console.log(`\ncase/whitespace fixes needed: ${caseFix.rows[0].n}`);
if (!DRY && Number(caseFix.rows[0].n) > 0) {
  await q(`
    UPDATE leads SET state = upper(btrim(state))
    WHERE state IS NOT NULL AND length(btrim(state))=2
      AND upper(btrim(state)) = ANY($1::text[]) AND state <> upper(btrim(state))`, [[...VALID]]);
  console.log("  applied");
}

// 2. junk rows: resolve + batched update
const junk = (await q(`
  SELECT id, state, city, postal_code FROM leads
  WHERE state IS NOT NULL AND btrim(state) <> ''
    AND NOT (length(btrim(state))=2 AND upper(btrim(state)) = ANY($1::text[]))
`, [[...VALID]])).rows;
console.log(`junk-state rows: ${junk.length}`);

const plan = [];
const byHow = {};
for (const r of junk) {
  const res = resolve(r);
  byHow[res.how] = (byHow[res.how] || 0) + 1;
  plan.push({ id: r.id, old: String(r.state), code: res.code, ai: res.how === "ai-candidate" });
}
console.log("resolution:", Object.entries(byHow).sort((a, b) => b[1] - a[1]).map(([h, c]) => `${h}=${c}`).join(" "));
const nFix = plan.filter((p) => p.code).length, nAi = plan.filter((p) => p.ai).length;
console.log(`fix=${nFix}  null+ai-tag=${nAi}  null=${plan.length - nFix - nAi}`);

if (DRY) { console.log("\n--dry-run: no writes"); await pool.end(); process.exit(0); }

const CHUNK = 2000; let done = 0;
for (let i = 0; i < plan.length; i += CHUNK) {
  const c = plan.slice(i, i + CHUNK);
  await q(`
    UPDATE leads l SET
      state = v.new_state,
      raw_data = coalesce(l.raw_data,'{}'::jsonb)
                 || jsonb_build_object('state_pre_clean', v.old_state)
                 || CASE WHEN v.ai THEN '{"state_ai_candidate":true}'::jsonb ELSE '{}'::jsonb END
    FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) new_state,
                 unnest($3::text[]) old_state, unnest($4::bool[]) ai) v
    WHERE l.id = v.id
  `, [c.map((p) => p.id), c.map((p) => p.code), c.map((p) => p.old), c.map((p) => p.ai)]);
  done += c.length;
  process.stdout.write(`\r  updated ${done}/${plan.length}`);
}
console.log("\n");

// 3. verify
const after = await q(`
  SELECT count(DISTINCT state) d, count(state) n FROM leads WHERE state IS NOT NULL`);
const bad = await q(`
  SELECT count(*) n FROM leads
  WHERE state IS NOT NULL AND NOT (length(state)=2 AND state = ANY($1::text[]))`, [[...VALID]]);
console.log(`verify: distinct states=${after.rows[0].d}  populated=${after.rows[0].n}  invalid remaining=${bad.rows[0].n}`);
await pool.end();
