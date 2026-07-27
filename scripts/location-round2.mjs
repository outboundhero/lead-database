#!/usr/bin/env node
import "dotenv/config";

/**
 * Location cleanup round 2 (after clean-state-column / clean-city-column):
 *
 *  1. address/street evidence — parse "…, City, ST 12345" and "City, StateName"
 *     out of the address/street columns for leads missing state (and fill
 *     city/postal when those are empty too). ZIP must agree with the parsed
 *     state (authoritative zips.csv) or the parse is rejected.
 *  2. ZIP backfills — state-null leads with a valid US ZIP get the ZIP's
 *     state (city-consistency-checked); city-null leads with state+ZIP get
 *     the ZIP's primary place name.
 *  3. misspelling pass — (city,state) pairs unknown to the reference get a
 *     Levenshtein<=2 match against reference cities OF THAT STATE
 *     ("Pheonix, AZ" -> "Phoenix"). Unique winner only.
 *  4. review flags — leads still state-null that carry stashed location junk
 *     get raw_data.location_review=true so they're queryable for manual review.
 *
 * All changes stash originals in raw_data (state_pre_clean / city_pre_clean
 * untouched if already present) and tag their source. Idempotent.
 *
 * Usage: node --env-file=.env.local scripts/location-round2.mjs [--dry-run]
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "geo");
const DRY = process.argv.includes("--dry-run");

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
};
const norm = (s) => String(s).toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();
// accent-fold BEFORE stripping non-letters so "José" -> "jose", not "jos"
const ck = (s) => String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const titleCase = (s) => s.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));
async function q(text, params, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(text, params); }
    catch (err) {
      const transient = /ECONNRESET|termin|timeout|socket|EPIPE|server closed/i.test(err.message || "");
      if (!transient || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

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

console.log("loading reference data...");
const zip5 = new Map(), zip5City = new Map(), cityStates = new Map();
const addCity = (city, code) => {
  const k = ck(city); if (!k || !VALID.has(code)) return;
  if (!cityStates.has(k)) cityStates.set(k, new Set());
  cityStates.get(k).add(code);
};
{
  const rows = parseCsv(fs.readFileSync(path.join(DIR, "zips.csv"), "utf8")); rows.shift();
  for (const r of rows) {
    const abbr = r[2], zip = (r[3] || "").trim().padStart(5, "0"), city = r[5];
    if (abbr && zip.length === 5) { zip5.set(zip, abbr); if (city) zip5City.set(zip, city); }
    if (city && abbr) addCity(city, abbr);
  }
}
{
  const rows = parseCsv(fs.readFileSync(path.join(DIR, "us_cities.csv"), "utf8")); rows.shift();
  for (const r of rows) addCity(r[3], r[1]);
}
// canonical display per (citykey): prefer us_cities.csv spelling
const canon = new Map();
{
  const rows = parseCsv(fs.readFileSync(path.join(DIR, "us_cities.csv"), "utf8")); rows.shift();
  for (const r of rows) { const k = ck(r[3]); if (k && !canon.has(k)) canon.set(k, String(r[3]).trim()); }
}
console.log(`  zip5=${zip5.size} cities=${cityStates.size}`);

// "…, City, ST 12345[-1234]" (street prefix optional)
const ADDR_RE = /(?:^|,)\s*([A-Za-z][A-Za-z .'’-]{1,40}?),?\s+([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/;
// "City, StateName" (no street/zip)
const CITY_STATENAME_RE = /^\s*([A-Za-z][A-Za-z .'’-]{1,40}?),\s*([A-Za-z ]{4,25})\s*$/;

function parseAddress(text) {
  if (!text) return null;
  const t = String(text).trim();
  let m = t.match(ADDR_RE);
  if (m) {
    const [, city, st, zip] = m;
    if (!VALID.has(st)) return null;
    if (zip5.has(zip) && zip5.get(zip) !== st) return null; // ZIP must agree
    return { city: city.trim(), state: st, postal: zip };
  }
  m = t.match(CITY_STATENAME_RE);
  if (m) {
    const code = US_NAME2CODE[norm(m[2])];
    if (!code) return null;
    return { city: m[1].trim(), state: code, postal: null };
  }
  return null;
}

// Damerau-Levenshtein (adjacent transposition counts as 1: "pheonix"->"phoenix")
function damerau(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// Expand leading direction/saint/mount abbreviations: "S. Euclid" -> "south euclid",
// "St Ann" -> "saint ann", "Ft Worth" -> "fort worth" (returns citykey space).
const ABBREV = { s: "south", n: "north", e: "east", w: "west", st: "saint", mt: "mount", ft: "fort", mtn: "mountain" };
function expandAbbrev(raw) {
  const words = String(raw).toLowerCase().replace(/[.’']/g, "").split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const first = ABBREV[words[0]];
  if (!first) return null;
  const name = [first, ...words.slice(1)].join(" ");
  return { key: ck(name), name };
}
// Strip a trailing ", XX" / ", us(a)" state suffix: "Kaysville, UT" -> "Kaysville"
function stripStateSuffix(raw) {
  const m = String(raw).match(/^(.*?),\s*(?:[A-Za-z]{2}|usa?)\s*$/i);
  return m ? m[1].trim() : null;
}

const counts = { addr: 0, zipState: 0, zipCity: 0, misspell: 0, flagged: 0 };
const updates = []; // {id, state?, city?, postal?, src}

// ── 1+2. state-null leads: address parse, then ZIP ──
{
  const rows = (await q(`
    SELECT id, city, postal_code, address, street
    FROM leads
    WHERE state IS NULL AND (
      postal_code ~ '^\\d{5}(-\\d{4})?$'
      OR (address IS NOT NULL AND btrim(address) <> '')
      OR (street IS NOT NULL AND btrim(street) <> '')
    )`)).rows;
  console.log(`state-null leads with address/street/ZIP evidence: ${rows.length}`);
  for (const r of rows) {
    const parsed = parseAddress(r.address) ?? parseAddress(r.street);
    if (parsed) {
      const u = { id: r.id, state: parsed.state, src: "address" };
      if ((!r.city || !r.city.trim()) && parsed.city) u.city = canon.get(ck(parsed.city)) ?? titleCase(parsed.city);
      if ((!r.postal_code || !r.postal_code.trim()) && parsed.postal) u.postal = parsed.postal;
      updates.push(u); counts.addr++;
      continue;
    }
    const zm = (r.postal_code || "").match(/^(\d{5})/);
    if (zm && zip5.has(zm[1])) {
      const st = zip5.get(zm[1]);
      const kc = r.city ? ck(r.city) : "";
      if (kc) { const m = cityStates.get(kc); if (m && !m.has(st)) continue; } // conflict -> skip
      updates.push({ id: r.id, state: st, src: "zip" }); counts.zipState++;
    }
  }
}

// ── 2b. city-null leads with state+ZIP: fill city from the ZIP's place name ──
{
  const rows = (await q(`
    SELECT id, state, postal_code FROM leads
    WHERE city IS NULL AND state IS NOT NULL AND postal_code ~ '^\\d{5}(-\\d{4})?$'`)).rows;
  for (const r of rows) {
    const zip = r.postal_code.slice(0, 5);
    if (zip5.get(zip) !== r.state) continue;      // ZIP must belong to the stored state
    const place = zip5City.get(zip);
    if (place) { updates.push({ id: r.id, city: canon.get(ck(place)) ?? titleCase(place), src: "zip-city" }); counts.zipCity++; }
  }
}

// ── 3. misspelling pass on distinct unknown (city,state) pairs ──
{
  const pairs = (await q(`
    SELECT city, state, count(*) n FROM leads
    WHERE city IS NOT NULL AND btrim(city) <> '' AND state IS NOT NULL
    GROUP BY 1, 2`)).rows;
  // reference cities grouped by state for candidate search
  const byState = new Map();
  for (const [k, states] of cityStates) for (const st of states) {
    if (!byState.has(st)) byState.set(st, []);
    byState.get(st).push(k);
  }
  const fixes = [];
  const display = (key, fallbackRaw) => canon.get(key) ?? titleCase(fallbackRaw);
  for (const p of pairs) {
    const k = ck(p.city);
    if (k.length < 5) continue;
    const m = cityStates.get(k);
    if (m && m.has(p.state)) {
      // valid pair, but maybe accent/suffix display variance — leave as-is
      continue;
    }
    if (m) continue;                              // real city, other state — round-1 territory, skip

    // Tier 1: trailing state suffix ("Kaysville, UT")
    const stripped = stripStateSuffix(p.city);
    if (stripped) {
      const sk = ck(stripped);
      if (cityStates.get(sk)?.has(p.state)) {
        fixes.push({ from: p.city, state: p.state, to: display(sk, stripped), n: Number(p.n), how: "suffix" });
        continue;
      }
    }
    // Tier 2: abbreviation expansion ("St Ann" -> "Saint Ann", "S. Euclid" -> "South Euclid")
    const ex = expandAbbrev(p.city);
    if (ex && cityStates.get(ex.key)?.has(p.state)) {
      fixes.push({ from: p.city, state: p.state, to: display(ex.key, ex.name), n: Number(p.n), how: "abbrev" });
      continue;
    }
    if (ex && cityStates.has(ex.key)) continue;   // expands to a real city of ANOTHER state — don't touch
    // Tier 3: accent-fold made k already canonical? (ck now folds accents, so
    // "San José" hits the valid-pair branch above; nothing to do here)
    // Tier 4: single-typo match (Damerau distance 1, unique winner)
    const cands = byState.get(p.state) ?? [];
    let best = null, ties = 0;
    for (const c of cands) {
      if (damerau(k, c, 1) === 1) { if (best && c !== best) ties++; else { best = c; ties = 1; } }
    }
    if (best && ties === 1) {
      fixes.push({ from: p.city, state: p.state, to: display(best, best), n: Number(p.n), how: "typo" });
    }
  }
  const realFixes = fixes.filter((f) => f.to !== f.from);
  fixes.length = 0; fixes.push(...realFixes);
  console.log(`misspelled (city,state) pairs fixable: ${fixes.length} (${fixes.reduce((a, b) => a + b.n, 0)} rows)`);
  console.log("  samples:", fixes.slice(0, 14).map((f) => `${f.from}[${f.state}]->${f.to}(${f.how}) x${f.n}`).join("  "));
  if (!DRY) {
    for (const f of fixes) {
      const r = await q(`
        UPDATE leads SET city = $3,
          raw_data = coalesce(raw_data,'{}'::jsonb)
                     || jsonb_build_object('city_pre_clean', coalesce(raw_data->>'city_pre_clean', city), 'city_source', 'misspell-fix')
        WHERE city = $1 AND state = $2`, [f.from, f.state, f.to]);
      counts.misspell += r.rowCount;
    }
  } else {
    counts.misspell = fixes.reduce((a, b) => a + b.n, 0);
  }
}

console.log(`\nplanned: address=${counts.addr} zip-state=${counts.zipState} zip-city=${counts.zipCity} misspell=${counts.misspell}`);
if (DRY) { console.log("--dry-run: no writes"); await pool.end(); process.exit(0); }

// apply the state/city/postal updates
const CHUNK = 2000;
for (let i = 0; i < updates.length; i += CHUNK) {
  const c = updates.slice(i, i + CHUNK);
  await q(`
    UPDATE leads l SET
      state = coalesce(v.st, l.state),
      city = coalesce(v.ct, l.city),
      postal_code = coalesce(v.pc, l.postal_code),
      raw_data = coalesce(l.raw_data,'{}'::jsonb) || jsonb_build_object('state_source', v.src)
    FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) st, unnest($3::text[]) ct,
                 unnest($4::text[]) pc, unnest($5::text[]) src) v
    WHERE l.id = v.id
  `, [c.map((u) => u.id), c.map((u) => u.state ?? null), c.map((u) => u.city ?? null),
      c.map((u) => u.postal ?? null), c.map((u) => u.src)]);
  process.stdout.write(`\r  applied ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
}
console.log("");

// ── 4. flag remaining unresolved for review ──
{
  const r = await q(`
    UPDATE leads SET raw_data = raw_data || '{"location_review":true}'::jsonb
    WHERE state IS NULL AND raw_data ? 'state_pre_clean' AND NOT (raw_data ? 'location_review')`);
  counts.flagged = r.rowCount;
}

const after = (await q(`
  SELECT count(state) states, count(city) cities,
         count(*) FILTER (WHERE raw_data ? 'location_review') review
  FROM leads`)).rows[0];
console.log(`done: address=${counts.addr} zip-state=${counts.zipState} zip-city=${counts.zipCity} misspell=${counts.misspell} review-flagged=${counts.flagged}`);
console.log(`after: states=${after.states} cities=${after.cities} review-queue=${after.review}`);
await pool.end();
