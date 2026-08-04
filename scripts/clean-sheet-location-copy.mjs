#!/usr/bin/env node
// One-off (user request 2026-08-05): produce a LOCAL cleaned copy of the
// onboarding sheet. Reads the downloaded CSV, runs every row's column-O
// "Inclusion locations" text through the client's INCLUSION LOCATION PROMPT
// verbatim on gpt-4o-mini, and inserts the output as a NEW column P
// ("Cleaned Inclusion Locations (AI)") — raw O kept, old P+ shifted right.
// The live Google Sheet is never touched.
//
// Usage: node scripts/clean-sheet-location-copy.mjs <in.csv> <out.csv>

import fs from "node:fs";
import { parse } from "csv-parse/sync";

for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
}

const [inPath, outPath] = process.argv.slice(2);
if (!inPath || !outPath) { console.error("usage: clean-sheet-location-copy.mjs <in.csv> <out.csv>"); process.exit(1); }

const MODEL = "gpt-4o-mini"; // per user: cheap model
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0, cost = 0;

// The client's prompt, verbatim (same text the targeting sync uses).
const PROMPT = fs
  .readFileSync(new URL("./sync-client-targeting-from-sheet.mjs", import.meta.url), "utf8")
  .match(/const CLIENT_LOCATION_PROMPT = `([\s\S]*?)`;/)[1];

async function aiText(user, maxTokens = 8000) {
  const backoff = [2000, 8000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: maxTokens, messages: [{ role: "user", content: user }] }),
    }).catch((e) => { if (attempt < backoff.length) return null; throw e; });
    if (!res) { await sleep(backoff[attempt]); continue; }
    if ((res.status === 429 || res.status >= 500) && attempt < backoff.length) { await sleep(backoff[attempt]); continue; }
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}`);
    const json = await res.json();
    calls++;
    cost += (json.usage?.prompt_tokens ?? 0) * 0.15e-6 + (json.usage?.completion_tokens ?? 0) * 0.6e-6;
    return json.choices?.[0]?.message?.content ?? "";
  }
}

// "state: a, b" lines -> Map(state -> Set(cities)); bare "state:" allowed.
function parseLines(text) {
  const map = new Map();
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*([a-z][a-z .'-]{1,40}?)\s*:\s*(.*)$/i);
    if (!m) continue;
    const state = m[1].trim().toLowerCase();
    if (!map.has(state)) map.set(state, new Set());
    for (const c of m[2].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) map.get(state).add(c);
  }
  return map;
}

const formatMap = (map) =>
  [...map.keys()].sort().map((st) => {
    const cities = [...map.get(st)].sort();
    return cities.length ? `${st}: ${cities.join(", ")}` : `${st}:`;
  }).join("\n");

// gpt-4o-mini gives up on 100+-city cells (returns nothing) — split on line
// boundaries and merge the halves, exactly like the targeting sync does.
async function cleanCell(raw, depth = 0) {
  const text = await aiText(PROMPT.replace("[INSERT STATES, COUNTIES, CITIES, TOWNS, ZIP CODES, OR METRO AREAS]", raw));
  const map = parseLines(text);
  const segments = raw.split(/\n|,/).filter((s) => s.trim()).length;
  if (map.size === 0 && segments >= 5 && depth < 5) {
    const lines = raw.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    let parts;
    if (lines.length >= 2) {
      const mid = Math.ceil(lines.length / 2);
      parts = [lines.slice(0, mid).join("\n"), lines.slice(mid).join("\n")];
    } else {
      const m = raw.match(/^\s*([^,:]{1,40}):\s*([\s\S]*)$/);
      const prefix = m ? `${m[1]}: ` : "";
      const items = (m ? m[2] : raw).split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length < 2) return formatMap(map);
      const mid = Math.ceil(items.length / 2);
      parts = [prefix + items.slice(0, mid).join(", "), prefix + items.slice(mid).join(", ")];
    }
    const merged = new Map();
    for (const p of parts) {
      for (const [st, cities] of parseLines(await cleanCell(p, depth + 1))) {
        if (!merged.has(st)) merged.set(st, new Set());
        for (const c of cities) merged.get(st).add(c);
      }
    }
    return formatMap(merged);
  }
  return formatMap(map);
}

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const rows = parse(fs.readFileSync(inPath, "utf8"), { relax_column_count: true });
const header = rows[0];
const O = header.findIndex((h) => String(h).toLowerCase().includes("inclusion locations"));
if (O < 0) { console.error("Couldn't find the Inclusion locations column"); process.exit(1); }
console.log(`rows: ${rows.length - 1}, locations column: ${String.fromCharCode(65 + O)} — inserting cleaned column after it`);

const out = [[...header.slice(0, O + 1), "Cleaned Inclusion Locations (AI)", ...header.slice(O + 1)]];
let done = 0;
const width = 6; // concurrent AI calls
const dataRows = rows.slice(1);
const cleaned = new Array(dataRows.length).fill("");
let next = 0;
await Promise.all(Array.from({ length: width }, async () => {
  while (next < dataRows.length) {
    const i = next++;
    const raw = String(dataRows[i][O] ?? "").trim();
    if (raw) {
      try { cleaned[i] = await cleanCell(raw); }
      catch (e) { cleaned[i] = `(cleaning failed: ${e.message})`; }
    }
    if (++done % 25 === 0) console.log(`  ${done}/${dataRows.length} rows…`);
  }
}));
for (let i = 0; i < dataRows.length; i++) {
  const r = dataRows[i];
  out.push([...r.slice(0, O + 1), cleaned[i], ...r.slice(O + 1)]);
}
fs.writeFileSync(outPath, out.map((r) => r.map(csvCell).join(",")).join("\n"));
console.log(`wrote ${outPath} | ${calls} AI calls ≈ $${cost.toFixed(3)}`);
