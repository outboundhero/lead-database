#!/usr/bin/env node
import "dotenv/config";

/**
 * Backfill leads.state for rows where state IS NULL but city is a real,
 * unambiguous city — the audit-approved "cityCol-unique" method only:
 * the city must map to exactly ONE state in the reference data AND that
 * (city -> state) pair must appear >=2x among our own clean rows.
 *
 * Tagged raw_data.state_source='city-backfill' (reversible: state was NULL).
 *
 * Usage: node --env-file=.env.local scripts/backfill-state-from-city.mjs [--dry-run]
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
const CA_NAME2CODE = {
  alberta:"AB","british columbia":"BC",manitoba:"MB","new brunswick":"NB",
  "newfoundland and labrador":"NL","nova scotia":"NS","northwest territories":"NT",
  nunavut:"NU",ontario:"ON","prince edward island":"PE",quebec:"QC","québec":"QC",
  saskatchewan:"SK",yukon:"YT",
};
const norm = (s) => String(s).toLowerCase().replace(/[.'’]/g, "").replace(/\s+/g, " ").trim();
const ck = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");

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
const cityStates = new Map();
const addCity = (city, code) => {
  const k = ck(city); if (!k || !VALID.has(code)) return;
  if (!cityStates.has(k)) cityStates.set(k, new Set());
  cityStates.get(k).add(code);
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

console.log("building corroboration map from clean rows...");
const cleanDist = new Map();
{
  const CH = 100000; let off = 0;
  for (;;) {
    const rs = (await q(`
      SELECT state st, city FROM leads
      WHERE state IS NOT NULL AND city IS NOT NULL AND btrim(city) <> ''
      ORDER BY id LIMIT ${CH} OFFSET ${off}`)).rows;
    if (!rs.length) break;
    for (const r of rs) {
      const k = ck(r.city); if (!k) continue;
      if (!cleanDist.has(k)) cleanDist.set(k, new Map());
      const m = cleanDist.get(k); m.set(r.st, (m.get(r.st) || 0) + 1);
    }
    off += CH; process.stdout.write(`\r  scanned ${off}`);
  }
  console.log("");
}

// candidates: state NULL, city present
const rows = (await q(`
  SELECT id, city FROM leads
  WHERE state IS NULL AND city IS NOT NULL AND btrim(city) <> ''
`)).rows;
console.log(`state-NULL rows with city: ${rows.length}`);

const ups = []; const byCity = {};
for (const r of rows) {
  const k = ck(r.city);
  const m = cityStates.get(k);
  if (!m || m.size !== 1) continue;                       // must be unambiguous
  const code = [...m][0];
  const d = cleanDist.get(k);
  if (!d || (d.get(code) || 0) < 2) continue;             // must be corroborated by our own data
  ups.push({ id: r.id, code });
  byCity[`${r.city}->${code}`] = (byCity[`${r.city}->${code}`] || 0) + 1;
}
console.log(`backfillable: ${ups.length}`);
console.log("top:", Object.entries(byCity).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} x${v}`).join("  "));

if (DRY) { console.log("--dry-run: no writes"); await pool.end(); process.exit(0); }

const CHUNK = 2000; let done = 0;
for (let i = 0; i < ups.length; i += CHUNK) {
  const c = ups.slice(i, i + CHUNK);
  await q(`
    UPDATE leads l SET
      state = v.code,
      raw_data = coalesce(l.raw_data,'{}'::jsonb) || '{"state_source":"city-backfill"}'::jsonb
    FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) code) v
    WHERE l.id = v.id AND l.state IS NULL
  `, [c.map((u) => u.id), c.map((u) => u.code)]);
  done += c.length;
  process.stdout.write(`\r  updated ${done}/${ups.length}`);
}
console.log("");

const after = await q(`SELECT count(state) n, count(DISTINCT state) d FROM leads`);
console.log(`verify: populated states=${after.rows[0].n} distinct=${after.rows[0].d}`);
await pool.end();
