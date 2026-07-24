#!/usr/bin/env node
import "dotenv/config";

/**
 * Repair city display casing. clean-city-column.mjs step 5 built its canonical
 * map preferring zips.csv, whose names are sentence-case ("San francisco") —
 * this pass re-canonicalizes using us_cities.csv + world-cities.csv (proper
 * title case), with a title-case fallback for values not in either.
 *
 * Only changes display casing: guarded by a letters-only-key equality check,
 * so it can never change WHICH city a row points to.
 *
 * Usage: node --env-file=.env.local scripts/fix-city-casing.mjs [--dry-run]
 */

import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "geo");
const DRY = process.argv.includes("--dry-run");
const ck = (s) => String(s).toLowerCase().replace(/[^a-z]/g, "");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));

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

// canonical display names, proper-case sources only
const canon = new Map();
{
  const rows = parseCsv(fs.readFileSync(path.join(DIR, "us_cities.csv"), "utf8")); rows.shift();
  for (const r of rows) { const k = ck(r[3]); if (k && !canon.has(k)) canon.set(k, String(r[3]).trim()); }
}
{
  const rows = parseCsv(fs.readFileSync(path.join(DIR, "world-cities.csv"), "utf8")); rows.shift();
  for (const r of rows) { const k = ck(r[0]); if (k && !canon.has(k)) canon.set(k, String(r[0]).trim()); }
}
console.log(`canonical names: ${canon.size}`);

const SMALL = new Set(["of", "the", "on", "at", "by", "de", "la", "du", "des", "van", "von", "and"]);
function titleCase(s) {
  return s.split(/\s+/).map((w, i) =>
    (i > 0 && SMALL.has(w.toLowerCase())) ? w.toLowerCase()
      : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
  ).join(" ");
}

const distinct = (await pool.query(`SELECT city, count(*) n FROM leads WHERE city IS NOT NULL GROUP BY city`)).rows;

// Only DAMAGED values are candidates: a lowercase-start word ("San francisco")
// or ALL CAPS. Properly-cased values ("McLean", "LaGrange") are never touched,
// even when the reference spells them differently.
const damaged = (c) => /(^| )[a-z]/.test(c) || (c === c.toUpperCase() && /[A-Z]/.test(c));

// Group DB variants by letters-only key; prefer the most common proper variant
// already in our data as the repair target, before falling back to the reference.
const groups = new Map();
for (const r of distinct) {
  const c = String(r.city).trim(); if (!c) continue;
  const k = ck(c); if (!k) continue;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push({ value: c, raw: r.city, n: Number(r.n) });
}

const fixes = [];
for (const [k, vars] of groups) {
  const bad = vars.filter((v) => damaged(v.value));
  if (!bad.length) continue;
  const proper = vars.filter((v) => !damaged(v.value)).sort((a, b) => b.n - a.n);
  let target = proper[0]?.value ?? canon.get(k);
  if (!target) {
    const c = bad[0].value;
    if (/^[A-Za-z ]+$/.test(c)) target = titleCase(c); else continue;
  }
  if (ck(target) !== k) continue; // safety: same city, display only
  for (const v of bad) if (v.value !== target) fixes.push({ from: v.raw, to: target, n: v.n });
}
fixes.sort((a, b) => b.n - a.n);
console.log(`values to fix: ${fixes.length} (${fixes.reduce((a, b) => a + b.n, 0)} rows)`);
console.log("top:", fixes.slice(0, 12).map((f) => `${JSON.stringify(f.from)}->${JSON.stringify(f.to)} x${f.n}`).join("  "));

if (DRY) { console.log("--dry-run: no writes"); await pool.end(); process.exit(0); }

let done = 0;
for (const f of fixes) {
  await pool.query(`UPDATE leads SET city = $2 WHERE city = $1`, [f.from, f.to]);
  done++;
  if (done % 100 === 0) process.stdout.write(`\r  ${done}/${fixes.length}`);
}
console.log(`\napplied ${done} value rewrites`);

const check = (await pool.query(`SELECT count(*) n FROM leads WHERE city ~ '(^| )[a-z]'`)).rows[0];
console.log(`verify: rows with lowercase-start words remaining: ${check.n}`);
await pool.end();
