#!/usr/bin/env node
import "dotenv/config";

/**
 * Clean the leads.city column (runs AFTER clean-state-column.mjs + ai-state-pass.mjs).
 *
 * Steps:
 *   1. junk strip     — placeholders / digit-heavy / overlong city values -> NULL
 *   2. shift repair   — rows whose state field held the real city (state_pre_clean)
 *                       and whose city holds a street address -> move city back
 *   3. pair adjudication — every (city,state) pair that is unknown to the reference
 *                       or mismatched gets ONE 4o-mini verdict per pair:
 *                       real (keep) / wrong (per-lead fix) / metro (rewrite to
 *                       primary city) / foreign (keep if stateless) / junk (null)
 *   4. per-lead fix   — leads in "wrong" pairs: AI corrects city from company
 *                       evidence or nulls it
 *   5. casing         — canonical case from reference ("MIAMI" -> "Miami")
 *
 * Every changed row stashes the original in raw_data.city_pre_clean.
 *
 * Usage: node --env-file=.env.local scripts/clean-city-column.mjs [--dry-run]
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "geo");
const DRY = process.argv.includes("--dry-run");
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

const US_CODES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR","GU","VI","AS","MP"];
const CA_CODES = ["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"];
const VALID = new Set([...US_CODES, ...CA_CODES]);
const CA_NAME2CODE = {
  alberta:"AB","british columbia":"BC",manitoba:"MB","new brunswick":"NB",
  "newfoundland and labrador":"NL","nova scotia":"NS","northwest territories":"NT",
  nunavut:"NU",ontario:"ON","prince edward island":"PE",quebec:"QC","québec":"QC",
  saskatchewan:"SK",yukon:"YT",
};
const norm = (s) => String(s).toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();
const ck = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");
const JUNK_CITY = /^(your area|n\/?a|null|none|unknown|false|true|local|remote|city|usa|united states|america|[-\/#.,\s\d()+@]*)$/i;

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

// cityStates: citykey -> Set(codes) ; canon: citykey -> display name
console.log("loading reference data...");
const cityStates = new Map(), canon = new Map();
const addCity = (city, code) => {
  const k = ck(city); if (!k) return;
  if (code && VALID.has(code)) { if (!cityStates.has(k)) cityStates.set(k, new Set()); cityStates.get(k).add(code); }
  if (!canon.has(k)) canon.set(k, String(city).trim());
};
{
  const rows = parseCsv(fs.readFileSync(path.join(DIR, "zips.csv"), "utf8")); rows.shift();
  for (const r of rows) if (r[5] && r[2]) addCity(r[5], r[2]);
}
{
  const rows = parseCsv(fs.readFileSync(path.join(DIR, "us_cities.csv"), "utf8")); rows.shift();
  for (const r of rows) addCity(r[3], r[1]);
}
{
  const rows = parseCsv(fs.readFileSync(path.join(DIR, "world-cities.csv"), "utf8")); rows.shift();
  for (const r of rows) if (r[1] === "Canada") { const code = CA_NAME2CODE[norm(r[2])]; if (code) addCity(r[0], code); }
}
console.log(`  cities=${cityStates.size}`);

async function openai(system, user, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return JSON.parse(data.choices[0].message.content);
    } catch (err) {
      if (attempt >= tries) { console.warn(`  AI call failed: ${err.message}`); return null; }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function applyUpdates(updates, label) {
  // updates: {id, city: string|null}  — null means clear the field
  if (!updates.length) return;
  if (DRY) { console.log(`  [dry] would update ${updates.length} rows (${label})`); return; }
  const CHUNK = 2000;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const c = updates.slice(i, i + CHUNK);
    await q(`
      UPDATE leads l SET
        city = v.new_city,
        raw_data = coalesce(l.raw_data,'{}'::jsonb)
                   || jsonb_build_object('city_pre_clean', l.city)
      FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) new_city) v
      WHERE l.id = v.id
    `, [c.map((u) => u.id), c.map((u) => u.city)]);
  }
  console.log(`  updated ${updates.length} rows (${label})`);
}

// ---------- step 1: junk strip ----------
console.log("\n[1/5] junk city values");
const junkRows = (await q(`
  SELECT id, city FROM leads
  WHERE city IS NOT NULL AND (
    city ~ '^[\\s\\d\\-/#.,()+@]*$'
    OR length(city) > 40
    OR lower(btrim(city)) IN ('your area','n/a','na','null','none','unknown','false','true','local','remote','city','usa','united states','america')
  )`)).rows;
console.log(`  found ${junkRows.length}`);
await applyUpdates(junkRows.map((r) => ({ id: r.id, city: null })), "junk->null");

// ---------- step 2: shifted-city repair ----------
console.log("\n[2/5] shifted-city repair (state field held the real city)");
const shifted = (await q(`
  SELECT id, state, city, raw_data->>'state_pre_clean' pre
  FROM leads
  WHERE raw_data ? 'state_pre_clean' AND state IS NOT NULL
    AND raw_data->>'state_pre_clean' IS NOT NULL
`)).rows;
const shiftFix = [];
for (const r of shifted) {
  const k = ck(r.pre || "");
  if (!k || k.length < 3) continue;
  const states = cityStates.get(k);
  if (!states || !states.has(r.state)) continue;            // pre-clean value must be a city OF the current state
  const curCity = (r.city || "").trim();
  const curBad = !curCity || /\d|@/.test(curCity) || (!cityStates.has(ck(curCity)) && curCity.length > 0 && !/^[A-Za-z\s.'-]+$/.test(curCity));
  const alreadySame = ck(curCity) === k;
  if (curBad && !alreadySame) shiftFix.push({ id: r.id, city: canon.get(k) || r.pre.trim() });
}
console.log(`  found ${shiftFix.length}`);
await applyUpdates(shiftFix, "shift-repair");

// ---------- step 3: pair adjudication ----------
console.log("\n[3/5] (city,state) pair adjudication");
const pairs = (await q(`
  SELECT city, state, count(*) n FROM leads
  WHERE city IS NOT NULL AND btrim(city) <> ''
  GROUP BY city, state
`)).rows;
const suspect = [];
for (const p of pairs) {
  const c = String(p.city).trim();
  if (JUNK_CITY.test(c) || c.length > 40) continue;          // handled in step 1
  const k = ck(c); const m = cityStates.get(k);
  if (m && p.state && m.has(p.state)) continue;              // valid pair
  if (m && !p.state) continue;                               // known city, stateless — fine
  suspect.push({ city: c, state: p.state, n: Number(p.n) });
}
console.log(`  suspect pairs: ${suspect.length} (${suspect.reduce((a, b) => a + b.n, 0)} rows)`);

const PAIR_SYS = `You validate (city, region) pairs from a US/Canada sales-lead database. region is a 2-letter US state / Canadian province code, or null.

For each pair, verdict:
- "real": city is a real city/town/CDP/neighborhood/suburb IN that region (or, when region is null, a real US/Canada place). Small places count — be generous with legitimate small towns.
- "wrong": a real place name, but NOT in that region (e.g. "San Francisco, UT").
- "metro": a metro/region description like "Miami-Fort Lauderdale Area" — set primary_city to the main city.
- "foreign": a real city outside the US/Canada (e.g. "Bonn", "Riyadh").
- "junk": not a place name at all (street addresses, sentences, gibberish).

Respond JSON: {"results":[{"i":<index>,"verdict":"real|wrong|metro|foreign|junk","primary_city":string|null}]} — every index exactly once.`;

const verdicts = new Map(); // "city|state" -> {verdict, primary_city}
{
  const BATCH = 40; const batches = [];
  for (let i = 0; i < suspect.length; i += BATCH) batches.push(suspect.slice(i, i + BATCH));
  let doneB = 0;
  const CONC = 6;
  const queue = [...batches];
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const b = queue.shift(); if (!b) return;
      const out = await openai(PAIR_SYS, JSON.stringify(b.map((p, i) => ({ i, city: p.city, region: p.state }))));
      if (out?.results) {
        for (const r of out.results) {
          const p = b[r.i]; if (!p) continue;
          verdicts.set(`${p.city}|${p.state ?? ""}`, { verdict: r.verdict, primary: r.primary_city });
        }
      }
      doneB++; process.stdout.write(`\r  adjudicated ${doneB}/${batches.length} batches`);
    }
  }));
  console.log("");
}
const vCount = {};
for (const v of verdicts.values()) vCount[v.verdict] = (vCount[v.verdict] || 0) + 1;
console.log(`  verdicts: ${JSON.stringify(vCount)}`);
{ // audit trail: every pair decision, reviewable after the run
  const lines = ["verdict\tcity\tstate\trows\tprimary_city"];
  for (const p of suspect) {
    const v = verdicts.get(`${p.city}|${p.state ?? ""}`);
    lines.push(`${v?.verdict ?? "NO-VERDICT"}\t${p.city}\t${p.state ?? ""}\t${p.n}\t${v?.primary ?? ""}`);
  }
  fs.writeFileSync(path.join(DIR, "city-pair-verdicts.tsv"), lines.join("\n"));
  console.log(`  decisions logged -> data/geo/city-pair-verdicts.tsv`);
}

// metro pairs -> rewrite to primary city; junk pairs -> null; foreign+state-set or wrong -> per-lead fix
const metroFix = [], junkPairNull = [], wrongPairs = [];
for (const p of suspect) {
  const v = verdicts.get(`${p.city}|${p.state ?? ""}`); if (!v) continue;
  if (v.verdict === "metro" && v.primary) metroFix.push({ ...p, primary: v.primary });
  else if (v.verdict === "junk") junkPairNull.push(p);
  else if (v.verdict === "wrong" || (v.verdict === "foreign" && p.state)) wrongPairs.push(p);
  // "real" and stateless "foreign" -> keep
}
console.log(`  metro=${metroFix.length}pairs  junk=${junkPairNull.length}pairs  wrong(per-lead fix)=${wrongPairs.length}pairs/${wrongPairs.reduce((a, b) => a + b.n, 0)}rows`);

for (const grp of [{ list: metroFix, mk: (p) => p.primary, label: "metro->primary" }, { list: junkPairNull, mk: () => null, label: "junk-pair->null" }]) {
  const ups = [];
  for (const p of grp.list) {
    const rows = (await q(`SELECT id FROM leads WHERE city = $1 AND state IS NOT DISTINCT FROM $2`, [p.city, p.state])).rows;
    for (const r of rows) ups.push({ id: r.id, city: grp.mk(p) });
  }
  await applyUpdates(ups, grp.label);
}

// ---------- step 4: per-lead fix for wrong pairs ----------
console.log("\n[4/5] per-lead city fix (wrong pairs)");
const LEAD_SYS = `A lead database has rows where the city field is WRONG for the lead's (trusted) state. Using the company name and email domain, give the lead's real city IN that state.
Rules: answer only when confident (well-known company location, or domain clearly maps to a local business). Otherwise UNKNOWN — never guess.
Respond JSON: {"results":[{"i":<index>,"city":string|"UNKNOWN"}]} — every index exactly once.`;
{
  const leads = [];
  for (const p of wrongPairs) {
    const rows = (await q(`SELECT id, city, state, company, email FROM leads WHERE city = $1 AND state IS NOT DISTINCT FROM $2`, [p.city, p.state])).rows;
    leads.push(...rows);
  }
  console.log(`  leads to fix: ${leads.length}`);
  const BATCH = 25, CONC = 6; const batches = [];
  for (let i = 0; i < leads.length; i += BATCH) batches.push(leads.slice(i, i + BATCH));
  const ups = []; let fixed = 0, cleared = 0, doneB = 0;
  const queue = [...batches];
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const b = queue.shift(); if (!b) return;
      const out = await openai(LEAD_SYS, JSON.stringify(b.map((l, i) => ({
        i, wrong_city: l.city, state: l.state, company: l.company,
        email_domain: (l.email || "").split("@")[1] || null,
      }))));
      const byIdx = new Map((out?.results || []).map((r) => [r.i, r]));
      for (let i = 0; i < b.length; i++) {
        const r = byIdx.get(i);
        if (r && typeof r.city === "string" && r.city !== "UNKNOWN" && r.city.trim()) { ups.push({ id: b[i].id, city: r.city.trim() }); fixed++; }
        else { ups.push({ id: b[i].id, city: null }); cleared++; }   // wrong city + no better answer -> null beats pollution
      }
      doneB++; process.stdout.write(`\r  fixed batches ${doneB}/${batches.length} (corrected=${fixed} cleared=${cleared})`);
    }
  }));
  console.log("");
  await applyUpdates(ups, "wrong-pair per-lead");
}

// ---------- step 5: casing normalization ----------
console.log("\n[5/5] casing normalization");
const distinctCities = (await q(`SELECT city, count(*) n FROM leads WHERE city IS NOT NULL GROUP BY city`)).rows;
const caseFix = [];
for (const r of distinctCities) {
  const c = String(r.city);
  const k = ck(c); const disp = canon.get(k);
  if (!disp) continue;
  const collapse = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
  if (c !== disp && collapse(c) === collapse(disp)) caseFix.push({ from: c, to: disp, n: Number(r.n) });
}
console.log(`  values needing case fix: ${caseFix.length} (${caseFix.reduce((a, b) => a + b.n, 0)} rows)`);
if (!DRY) {
  for (const f of caseFix) {
    await q(`UPDATE leads SET city = $2 WHERE city = $1`, [f.from, f.to]);
  }
  console.log("  applied");
}

// ---------- verify ----------
const shape = (await q(`
  SELECT count(city) has_city,
         count(*) FILTER (WHERE city ~ '[0-9@]') junky,
         count(DISTINCT city) distinct_city
  FROM leads`)).rows[0];
console.log(`\nverify: populated=${shape.has_city} junky=${shape.junky} distinct=${shape.distinct_city}`);
await pool.end();
