#!/usr/bin/env node
// sync-client-targeting-from-sheet.mjs — parse the onboarding sheet's targeting
// columns into client_targeting with AI (ported from gmaps-UI's sync.ts).
//
// Sheet (ONBOARDING_SHEET_ID, tab gid 581954884 "Onboarding Form Responses"):
//   col A = Client Abbreviation (client_tag, may be "&"-joined compounds)
//   col L = Target industries & keywords        -> include_industries (taxonomy)
//                                                  + include_keywords (search phrases)
//   col M = Exclusion industries & keywords     -> exclude_industries (taxonomy)
//                                                  + exclude_keywords (whole-term)
//   col O = Inclusion locations (ZIPs/counties/ -> include_locations [{country,state,city}]
//           cities+states/radius prose)            validated against the geo reference
//
// Change detection: the verbatim L/M/O text is stored in client_targeting.sheet_raw;
// a client is re-parsed only when that text changes (or --force). Manual Rules-
// dialog edits therefore survive until the client's sheet row is edited.
// Never touched here: exclude_locations, require_location, allow_inferred_location,
// commercial_cleaning, notes.
//
// Env: GOOGLE_SERVICE_ACCOUNT_B64, DATABASE_URL, OPENAI_API_KEY,
//      ONBOARDING_SHEET_ID (defaults to the known onboarding sheet)
// Usage:
//   npm run sync-targeting                 # changed clients only
//   npm run sync-targeting -- --dry-run    # read + report, no AI, no writes
//   npm run sync-targeting -- --client JV  # one client (implies --force)
//   npm run sync-targeting -- --force      # re-parse everyone

import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";

// Load .env.local when present (local runs); Railway provides real env vars.
try {
  for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch { /* no .env.local — fine */ }

const DRY = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force") || process.argv.includes("--client");
const ONLY_CLIENT = (() => {
  const i = process.argv.indexOf("--client");
  return i >= 0 ? String(process.argv[i + 1] ?? "").trim().toUpperCase() : null;
})();

const SHEET_ID = process.env.ONBOARDING_SHEET_ID || "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const TAB_GID = 581954884;
const MODEL = "gpt-4o-mini";
const PRICE_IN = 0.15 / 1e6, PRICE_OUT = 0.6 / 1e6; // USD per token
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = { input: 0, output: 0, calls: 0 };

// ── Google Sheets auth (same pattern as sync-clients-from-sheet.mjs) ─────────

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function sheetsGet(token, path) {
  const backoffMs = [2000, 8000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) throw new Error("403 from Google Sheets — share the sheet with the service account email (Viewer is enough).");
    if ((res.status === 429 || res.status >= 500) && attempt < backoffMs.length) {
      console.warn(`  Sheets API HTTP ${res.status}, retrying in ${backoffMs[attempt] / 1000}s…`);
      await sleep(backoffMs[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

// ── Tag helpers (ported from gmaps-UI splitClientTag) ────────────────────────

const cleanTag = (v) => String(v ?? "").trim().toUpperCase();

// "DBSF & DBSNJ" / "JPAR / JPSWM" -> two tags; "K&LCS", "TM&VC" stay whole.
function splitClientTag(tag) {
  for (const sep of [" & ", " / ", " AND "]) {
    const idx = tag.indexOf(sep);
    if (idx === -1) continue;
    const left = tag.slice(0, idx).trim();
    const right = tag.slice(idx + sep.length).trim();
    if (left.length >= 3 && right.length >= 3) return [left, right];
  }
  return [tag];
}

// ── OpenAI (raw fetch like categorize-worker; retries + truncation-aware) ────

async function aiJson(system, user, { maxTokens = 8000 } = {}) {
  const backoffMs = [2000, 8000, 30000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL, temperature: 0, max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
    } catch (err) {
      if (attempt < backoffMs.length) { await sleep(backoffMs[attempt]); continue; }
      throw err;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < backoffMs.length) {
      await sleep(backoffMs[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const json = await res.json();
    usage.input += json.usage?.prompt_tokens ?? 0;
    usage.output += json.usage?.completion_tokens ?? 0;
    usage.calls++;
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
      const err = new Error("truncated");
      err.truncated = true;
      throw err;
    }
    try { return JSON.parse(choice?.message?.content ?? "{}"); } catch { return {}; }
  }
}

// Remap an AI result's keys onto the batch's tags: exact first, then
// case-insensitive, then a single-key/single-client fallback (models sometimes
// echo the placeholder key from the prompt instead of the actual tag).
function keyByTag(result, batch) {
  const out = {};
  const keys = Object.keys(result ?? {});
  const byLower = new Map(keys.map((k) => [k.trim().replace(/:+$/, "").toLowerCase(), k]));
  for (const c of batch) {
    const k = byLower.get(c.tag.toLowerCase());
    if (k !== undefined) out[c.tag] = result[k];
  }
  if (Object.keys(out).length === 0 && batch.length === 1 && keys.length === 1) {
    out[batch[0].tag] = result[keys[0]];
  }
  return out;
}

// Run fn over batches. Failure NEVER becomes an empty result: a batch that
// errors (or a client the model's response omitted) lands in `failed`, and the
// write phase keeps that client's existing DB values and leaves sheet_raw
// un-advanced so the next run retries. On truncation the batch is halved and
// retried (a single truncated item is marked failed, not fatal).
async function batchedAi(items, size, fn) {
  const out = {};
  const failed = new Set();
  const queue = [];
  for (let i = 0; i < items.length; i += size) queue.push(items.slice(i, i + size));
  while (queue.length) {
    const batch = queue.shift();
    let result;
    try {
      result = await fn(batch);
    } catch (err) {
      if (err.truncated && batch.length > 1) {
        const mid = Math.ceil(batch.length / 2);
        queue.unshift(batch.slice(0, mid), batch.slice(mid));
        continue;
      }
      for (const c of batch) failed.add(c.tag);
      console.error(`  AI batch failed [${batch.map((c) => c.tag).join(", ")}]: ${err.message} — keeping existing values`);
      continue;
    }
    const keyed = keyByTag(result, batch);
    for (const c of batch) {
      if (keyed[c.tag] !== undefined) out[c.tag] = keyed[c.tag];
      else {
        failed.add(c.tag);
        console.warn(`  ${c.tag}: missing from AI batch response — keeping existing values`);
      }
    }
    if (queue.length) await sleep(500);
  }
  return { out, failed };
}

// ── AI prompts (ported from gmaps-UI sync.ts, adapted to this schema) ────────

const LOCATION_PROMPT = `You extract location targeting from messy client-onboarding text.
Supported countries ONLY: US, CA, AU, NZ, GB, IE.

RULES:
1. Cities -> {"country":"US","state":"TX","city":"Houston"}. "state" is the standard
   state/province code (US "TX", Canada "ON", Australia "NSW"); for GB/IE/NZ use the
   region name. Preserve internal spaces ("King of Prussia").
2. ZIP/postal codes -> resolve each to its city. Deduplicate aggressively — many ZIPs
   collapse into one city.
3. A state-level entry {"country":"US","state":"FL"} (no city) is ONLY for text that
   targets an ENTIRE state: "Florida", "All of Texas", "statewide". NEVER collapse a
   list of counties or cities into a state-level entry — if the text enumerates
   specific cities, output EVERY listed city individually, even when there are 100+.
   Do NOT expand a whole-state entry into cities.
4. County names -> the cities and towns in that county (each as its own city entry).
5. "N miles around X" -> cities strictly within that radius, plus X itself.
6. Whole-country text ("All of USA", "United States", "nationwide", "All of
   Australia") -> ONE country-level entry {"country":"US"} (no state, no city).
   Vague non-location text -> skip (no entry).
7. No duplicate entries. Ignore contact names, emails, and delivery notes.

Return JSON only: {"locations":[{"country":"US","state":"TX","city":"Houston"},{"country":"US","state":"FL"}]}`;

const categoriesPrompt = (categoryNames) => `You match client industry preferences to categories from a fixed list.

AVAILABLE CATEGORIES:
${categoryNames.join("\n")}

RULES:
1. For each client you get INCLUDE text (industries they want) and EXCLUDE text (industries they don't want).
2. Match INCLUDE terms to ALL applicable categories. Be AGGRESSIVE with matching — one include term can match MULTIPLE categories:
   - "Medical offices / Healthcare" -> General Medical, Specialty Clinics, Specialty Medical Clinics, Ambulatory Surgical Centers, Urgent Care Centers, Pediatric Medical
   - "Office / Professional offices / CPAs / lawyers" -> Corporate Offices
   - "Daycares / Preschools / Schools / Universities" -> Education
   - "Banks / Credit Unions" -> Financial
   - "Gyms / Fitness" -> Fitness Centers & Gyms
   - "Vet / Animal" -> Veterinary
   - "Dental" -> Dental & Orthodontics
   - "Churches / Religious" -> Religious
   - "Buildings / Property Management / HOAs" -> Commercial Property Management
   - "Car dealerships" -> Dealerships
   - "Warehouses / industrial" -> Manufacturing, Shipping & Logistics
3. For the same client, match EXCLUDE terms to categories — but CONSERVATIVELY:
   only categories the EXCLUDE text explicitly names or clearly implies ("no health"
   implies the medical categories). A category absent from INCLUDE is NOT excluded —
   NEVER list a category merely because the client didn't ask for it. Exclusions block
   leads outright, so when in doubt leave it out. An excluded category must never
   also appear in "include".
4. Only return category names that EXACTLY match the list above. Ignore client-specific codes you cannot interpret.

Return JSON keyed by each client's tag EXACTLY as it appears before the colon in the input
(e.g. input "JV:\\nINCLUDE: ..." -> key "JV"):
{"JV":{"include":["Category 1"],"exclude":["Category 2"]}, ...}`;

const EXCLUDE_KEYWORDS_PROMPT = `You are generating exclusion keyword lists for commercial cleaning outbound campaigns. Each client has a raw exclusion string from their onboarding form.

Context: Input may be messy — comma lists, numbered lists, multi-line entries, slashes, parenthetical notes. Your job is to interpret, expand, and standardize into high-quality exclusion keyword lists. Keywords are whole-word matched (plural-tolerant) against company names and business-category labels.

Instructions:
1. For each client, take their input categories and expand into: synonyms, variations, related business types, common naming conventions (Google Maps, Yelp, etc.)
2. Infer intent: "retail" -> boutique, clothing store, strip mall; "restaurants" -> diner, bistro, fast food
3. Handle parenthetical notes: "bars (restaurants are fine)" -> exclude "bars" but NOT "restaurants"
4. Do NOT over-exclude categories that may contain good targets unless explicitly stated.
5. Matching is already plural-tolerant — no need for singular AND plural of the same word.
6. Lowercase everything, remove duplicates. Skip prose that is not an exclusion ("not completely against...").
7. Geographic restrictions (cities, states, counties, "nothing in downtown X") are handled
   by a separate system — NEVER emit place names as keywords; drop location-only phrases.

Return JSON keyed by each client's tag EXACTLY as it appears before the colon in the input
(e.g. input "JV: restaurants, bars" -> key "JV"):
{"JV":["keyword1","keyword2",...], ...}`;

const INCLUDE_KEYWORDS_PROMPT = `You turn a client's messy "target industries" text into clean search phrases. Each phrase is substring-matched (case-insensitive contains) against business-category labels like "Dental clinic", "Corporate office", "Executive coach", "Technology consultant", "Church", "Warehouse".

Instructions:
1. Extract EVERY distinct business type as a short lowercase phrase (1-3 words) —
   physical AND professional-services alike: "dental", "medical office", "church",
   "warehouse", "school", "car dealership", "coach", "consultant", "law firm", "software".
2. Prefer the STEM that catches variants: "dental" (catches dentist/dental clinic),
   "restaurant" (catches restaurants), "consultant" (catches technology consultants,
   DEI consultants), "coach" (catches executive coaches).
3. Conservative synonym expansion only when clearly implied: "religious institutions" -> "church", "temple", "mosque"; "medical" -> "clinic", "medical".
4. NEVER output generic words that match everything: "service", "services", "company", "business", "commercial", "office building" is fine but bare "building" is not.
5. Skip vague prose ("most other commercial spaces", "TBD").
6. Deduplicate; drop a phrase if another phrase is its substring.

Return JSON keyed by each client's tag EXACTLY as it appears before the colon in the input
(e.g. input "JV: dental offices, gyms" -> key "JV"):
{"JV":["phrase1","phrase2",...], ...}`;

// ── Geo validation (same SQL as /api/clients/targeting validateEntries) ──────

// GeoNames spells out abbreviations ("St. George" -> "Saint George",
// "Ft. Lauderdale" -> "Fort Lauderdale") and drops some suffixes ("Suisun
// City" -> "Suisun"). Tried in order ONLY after the exact key misses, so
// "Kansas City" never degrades to "Kansas".
function cityVariants(city) {
  const out = [];
  const abbr = [[/^st\.?\s+/i, "Saint "], [/^ste\.?\s+/i, "Sainte "], [/^ft\.?\s+/i, "Fort "], [/^mt\.?\s+/i, "Mount "]];
  for (const [re, full] of abbr) if (re.test(city)) out.push(city.replace(re, full));
  if (/\s+city$/i.test(city)) out.push(city.replace(/\s+city$/i, ""));
  return out;
}

// geo_locations.city_key is accent-FOLDED ("Montréal" -> "montreal") while the
// SQL regexp below merely strips non-letters ("montral") — fold in JS first.
const foldAccents = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

async function validateLocations(pool, tag, entries) {
  const valid = [];
  const dropped = [];
  const seen = new Set();
  for (const e of entries ?? []) {
    const country = String(e?.country ?? "").trim().toUpperCase();
    const state = String(e?.state ?? "").trim();
    const city = String(e?.city ?? "").trim();
    if (!country) { dropped.push({ tag, entry: e, reason: "missing country" }); continue; }
    const c = await pool.query(`SELECT 1 FROM supported_countries WHERE code = $1 AND enabled`, [country]);
    if (!c.rows.length) { dropped.push({ tag, entry: e, reason: `unsupported country ${country}` }); continue; }
    const out = { country };
    if (state) {
      const s = await pool.query(
        `SELECT state_code FROM geo_admin1
         WHERE country_code = $1 AND (state_code = $2 OR LOWER(name) = LOWER($3)) LIMIT 1`,
        [country, state.toUpperCase(), state]);
      if (!s.rows.length) { dropped.push({ tag, entry: e, reason: `unknown state "${state}" in ${country}` }); continue; }
      out.state = s.rows[0].state_code;
    }
    if (city) {
      if (!out.state) { dropped.push({ tag, entry: e, reason: `city "${city}" without state` }); continue; }
      let found = null;
      for (const candidate of [city, ...cityVariants(city)]) {
        const g = await pool.query(`
          SELECT g.city FROM geo_locations g
          JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
          WHERE g.country_code = $1 AND a.state_code = $2
            AND g.city_key = regexp_replace(lower($3), '[^a-z]', '', 'g')
          ORDER BY g.population DESC NULLS LAST LIMIT 1`,
          [country, out.state, foldAccents(candidate)]);
        if (g.rows.length) { found = g.rows[0].city; break; }
      }
      if (!found) { dropped.push({ tag, entry: e, reason: `"${city}" not a known place in ${out.state}, ${country}` }); continue; }
      out.city = found; // canonical DB casing
    }
    const key = `${out.country}|${out.state ?? ""}|${out.city ?? ""}`;
    if (!seen.has(key)) { seen.add(key); valid.push(out); }
  }
  return { valid, dropped };
}

// Parse one client's location cell. Splits and retries the halves when the
// response is truncated OR when the model returns zero entries for a clearly
// list-like cell (gpt-4o-mini deterministically gives up on 100+-city lists
// rather than emit the huge output — observed live, temp 0).
async function parseLocations(rawText, depth = 0) {
  // Halve on LINE boundaries first so "utah: a, b, …" groups keep their state
  // header; a single long line is comma-halved with its "header:" prefix
  // re-attached to both halves so no city loses its state context.
  const split = async () => {
    if (depth >= 6) return null;
    const lines = rawText.split(/\n+/).map((s) => s.trim()).filter(Boolean);
    let parts;
    if (lines.length >= 2) {
      const mid = Math.ceil(lines.length / 2);
      parts = [lines.slice(0, mid).join("\n"), lines.slice(mid).join("\n")];
    } else {
      const m = rawText.match(/^\s*([^,:]{1,40}):\s*([\s\S]*)$/);
      const prefix = m ? `${m[1]}: ` : "";
      const items = (m ? m[2] : rawText).split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length < 2) return null;
      const mid = Math.ceil(items.length / 2);
      parts = [prefix + items.slice(0, mid).join(", "), prefix + items.slice(mid).join(", ")];
    }
    const [a, b] = await Promise.all(parts.map((p) => parseLocations(p, depth + 1)));
    return [...a, ...b];
  };
  try {
    const out = await aiJson(LOCATION_PROMPT, rawText);
    const locations = out.locations ?? [];
    // ≥5 comma/newline segments but zero entries = the model bailed, not a
    // genuinely location-free cell. State headers ("utah: a, b, …") survive the
    // split because each half keeps its own prefix text.
    if (locations.length === 0 && rawText.split(/\n|,/).filter((s) => s.trim()).length >= 5) {
      const retried = await split();
      if (retried !== null) return retried;
    }
    return locations;
  } catch (err) {
    if (!err.truncated) throw err;
    const retried = await split();
    if (retried === null) throw new Error("location cell truncated and unsplittable");
    return retried;
  }
}

// Limit concurrency without extra deps.
async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const saB64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!saB64) { console.error("GOOGLE_SERVICE_ACCOUNT_B64 must be set."); process.exit(1); }
  if (!DRY && !process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY must be set."); process.exit(1); }

  const rawJson = Buffer.from(saB64, "base64").toString("utf8").trim();
  let sa;
  try {
    sa = JSON.parse(rawJson);
  } catch {
    sa = JSON.parse(rawJson.replace(/("private_key"\s*:\s*")([\s\S]*?)("\s*[,}])/, (_, open, key, close) =>
      open + key.replace(/\r/g, "").replace(/\n/g, "\\n") + close));
  }
  const token = await getAccessToken(sa);

  // Tab by gid — exact, survives renames.
  const meta = await sheetsGet(token, `${SHEET_ID}?fields=sheets.properties`);
  const tab = (meta.sheets ?? []).map((s) => s.properties).find((p) => p.sheetId === TAB_GID);
  if (!tab) { console.error(`No tab with gid ${TAB_GID} in sheet ${SHEET_ID}.`); process.exit(1); }
  console.log(`tab: "${tab.title}" (gid ${TAB_GID})`);

  const grid = await sheetsGet(token, `${SHEET_ID}/values/${encodeURIComponent(`'${tab.title.replace(/'/g, "''")}'!A1:R3000`)}`);
  const rows = grid.values ?? [];
  if (rows.length < 2) { console.error("Sheet read returned no data rows."); process.exit(1); }

  // Column discovery by header substring. Two headers contain "exclusion
  // industries" (M has data, N is empty) — pick the one with the most data.
  const header = rows[0].map((h) => String(h ?? "").toLowerCase());
  const findCol = (needle) => header.findIndex((h) => h.includes(needle));
  const dataCount = (i) => rows.slice(1).filter((r) => String(r[i] ?? "").trim()).length;
  const tagCol = findCol("client abbreviation");
  const targetCol = findCol("target industries");
  const locationsCol = findCol("inclusion locations");
  const exclusionCol = header
    .map((h, i) => (h.includes("exclusion industries") ? i : -1))
    .filter((i) => i >= 0)
    .sort((a, b) => dataCount(b) - dataCount(a))[0] ?? -1;
  if (tagCol < 0 || targetCol < 0 || exclusionCol < 0 || locationsCol < 0) {
    console.error(`Column discovery failed: tag=${tagCol} target=${targetCol} exclusion=${exclusionCol} locations=${locationsCol}`);
    process.exit(1);
  }
  const colLetter = (i) => (i < 26 ? String.fromCharCode(65 + i) : "A" + String.fromCharCode(65 + i - 26));
  console.log(`columns: tag=${colLetter(tagCol)} target=${colLetter(targetCol)} exclusion=${colLetter(exclusionCol)} locations=${colLetter(locationsCol)}`);

  // Rows -> per-tag raw cells. Compound tags share the row; later rows win
  // (form resubmissions append, latest is current).
  const sheetClients = new Map();
  for (const row of rows.slice(1)) {
    const rawTag = cleanTag(row[tagCol]);
    if (!rawTag) continue;
    for (const tag of splitClientTag(rawTag)) {
      sheetClients.set(tag, {
        tag,
        target: String(row[targetCol] ?? "").trim(),
        exclusion: String(row[exclusionCol] ?? "").trim(),
        locations: String(row[locationsCol] ?? "").trim(),
      });
    }
  }
  if (sheetClients.size === 0) { console.error("Refusing to sync: 0 client rows parsed."); process.exit(1); }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const { rows: tagRows } = await pool.query(`SELECT tag FROM client_tags`);
    const knownTags = new Set(tagRows.map((r) => r.tag));
    // Second-chance split for unspaced compounds ("TM&VC", "K&LCS"): only when
    // EVERY part is a known client tag — "JPC&A" stays whole because "A" isn't.
    for (const [tag, data] of [...sheetClients]) {
      if (knownTags.has(tag) || !tag.includes("&")) continue;
      const parts = tag.split("&").map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2 && parts.every((p) => knownTags.has(p))) {
        sheetClients.delete(tag);
        for (const p of parts) if (!sheetClients.has(p)) sheetClients.set(p, { ...data, tag: p });
      }
    }
    const unmatched = [...sheetClients.keys()].filter((t) => !knownTags.has(t));
    let clients = [...sheetClients.values()].filter((c) => knownTags.has(c.tag));
    console.log(`${sheetClients.size} sheet tags -> ${clients.length} matched in client_tags, ${unmatched.length} unmatched${unmatched.length ? `: ${unmatched.join(", ")}` : ""}`);

    if (ONLY_CLIENT) {
      clients = clients.filter((c) => c.tag === ONLY_CLIENT);
      if (!clients.length) { console.error(`--client ${ONLY_CLIENT}: not found among matched sheet tags.`); process.exit(1); }
    }

    // Change detection vs stored sheet_raw. Full rows are fetched so a failed
    // AI pass can fall back to the client's existing values instead of [].
    const { rows: existing } = await pool.query(
      `SELECT client_tag, countries, include_locations, include_industries, include_keywords,
              exclude_industries, exclude_keywords, sheet_raw FROM client_targeting`);
    const existingByTag = new Map(existing.map((r) => [r.client_tag, r]));
    const rawOf = (c) => ({ target: c.target, exclusion: c.exclusion, locations: c.locations });
    const changed = clients.filter((c) => FORCE || JSON.stringify(existingByTag.get(c.tag)?.sheet_raw ?? null) !== JSON.stringify(rawOf(c)));
    console.log(`${changed.length} changed, ${clients.length - changed.length} unchanged (skipped).`);

    if (DRY) {
      for (const c of changed.slice(0, 15)) {
        console.log(`\n=== ${c.tag} ===\n  L: ${c.target.slice(0, 150)}\n  M: ${c.exclusion.slice(0, 150)}\n  O: ${c.locations.slice(0, 200)}`);
      }
      if (changed.length > 15) console.log(`\n… and ${changed.length - 15} more changed clients.`);
      console.log("\n--dry-run: no AI calls, no DB writes.");
      return;
    }
    if (!changed.length) { console.log("Nothing to do."); return; }

    const { rows: catRows } = await pool.query(`SELECT name FROM lead_categories ORDER BY name`);
    const categoryNames = catRows.map((r) => r.name);
    const catByLower = new Map(categoryNames.map((n) => [n.toLowerCase(), n]));

    // Pass A: locations (one call per client, 4-wide) + geo validation.
    // A parse failure — or a parse whose entries ALL fail geo validation —
    // marks the client failed so its existing locations are kept.
    const allDropped = [];
    const locByTag = new Map();
    const locFailed = new Set();
    await mapConcurrent(changed.filter((c) => c.locations.trim().length > 0), 4, async (c) => {
      try {
        const raw = await parseLocations(c.locations);
        const { valid, dropped } = await validateLocations(pool, c.tag, raw);
        allDropped.push(...dropped);
        if (raw.length > 0 && valid.length === 0) {
          locFailed.add(c.tag);
          console.error(`  ${c.tag}: every parsed location failed geo validation — keeping existing locations`);
          return;
        }
        locByTag.set(c.tag, valid);
      } catch (err) {
        locFailed.add(c.tag);
        console.error(`  ${c.tag}: location parse failed — ${err.message} (keeping existing locations)`);
      }
    });

    // Pass B: taxonomy categories, include + exclude together (batches of 15).
    const catInput = changed.filter((c) => c.target || c.exclusion);
    const catRes = await batchedAi(catInput, 15, async (batch) => {
      const input = batch.map((c) => `${c.tag}:\nINCLUDE: ${c.target || "(none)"}\nEXCLUDE: ${c.exclusion || "(none)"}`).join("\n===\n");
      return aiJson(categoriesPrompt(categoryNames), input);
    });
    const canonCats = (list) =>
      [...new Set((Array.isArray(list) ? list : []).map((n) => catByLower.get(String(n).toLowerCase())).filter(Boolean))];

    // Pass C: exclusion keyword expansion (batches of 10). No comma-split
    // fallback: raw prose stored as whole-term keywords never matches anything
    // and reads as protection that isn't there — failure keeps existing values.
    const exclInput = changed.filter((c) => c.exclusion);
    const exclRes = await batchedAi(exclInput, 10, async (batch) => {
      const input = batch.map((c) => `${c.tag}: ${c.exclusion}`).join("\n---\n");
      return aiJson(EXCLUDE_KEYWORDS_PROMPT, input);
    });

    // Pass D: include search phrases (batches of 15).
    const inclInput = changed.filter((c) => c.target);
    const inclRes = await batchedAi(inclInput, 15, async (batch) => {
      const input = batch.map((c) => `${c.tag}: ${c.target}`).join("\n---\n");
      return aiJson(INCLUDE_KEYWORDS_PROMPT, input);
    });

    const cleanList = (tag, kind, list, max = 200) => {
      const cleaned = [...new Set((Array.isArray(list) ? list : []).map((s) => String(s).trim().toLowerCase()).filter((s) => s && s.length <= 60))];
      if (cleaned.length > max) console.warn(`  ${tag}: ${kind} truncated ${cleaned.length} -> ${max}`);
      return cleaned.slice(0, max);
    };

    // Write — one transaction. Per client, a field is only overwritten when its
    // pass succeeded; sheet_raw advances ONLY when every relevant pass
    // succeeded, so partially-failed clients are re-parsed on the next run.
    const client = await pool.connect();
    let written = 0;
    const partial = [];
    try {
      await client.query("begin");
      for (const c of changed) {
        const ex = existingByTag.get(c.tag);
        const hasLoc = c.locations.trim().length > 0;
        const locFail = hasLoc && (locFailed.has(c.tag) || !locByTag.has(c.tag));
        const bFail = (c.target || c.exclusion) && catRes.failed.has(c.tag);
        const cFail = c.exclusion && exclRes.failed.has(c.tag);
        const dFail = c.target && inclRes.failed.has(c.tag);

        const locs = locFail ? (ex?.include_locations ?? []) : (hasLoc ? locByTag.get(c.tag) : []);
        const cats = bFail ? null : (catRes.out[c.tag] ?? {});
        const inclInd = cats ? canonCats(cats.include) : (ex?.include_industries ?? []);
        const exclInd = cats ? canonCats(cats.exclude).filter((n) => !inclInd.includes(n)) : (ex?.exclude_industries ?? []);
        const exclKw = cFail ? (ex?.exclude_keywords ?? []) : cleanList(c.tag, "exclude_keywords", exclRes.out[c.tag]);
        const inclKw = dFail ? (ex?.include_keywords ?? []) : cleanList(c.tag, "include_keywords", inclRes.out[c.tag]);
        const derived = [...new Set(locs.map((l) => l.country))];
        const countries = derived.length ? derived : (ex?.countries?.length ? ex.countries : ["US"]);
        const allOk = !locFail && !bFail && !cFail && !dFail;
        const sheetRaw = allOk ? rawOf(c) : (ex?.sheet_raw ?? null);
        if (!allOk) partial.push(c.tag);

        await client.query(
          `INSERT INTO client_targeting (client_tag, countries, include_locations, include_industries, include_keywords,
                                         exclude_industries, exclude_keywords, sheet_raw, sheet_synced_at, source, updated_at)
           VALUES ($1, $2::text[], $3::jsonb, $4::text[], $5::text[], $6::text[], $7::text[], $8::jsonb, now(), 'sheet', now())
           ON CONFLICT (client_tag) DO UPDATE SET
             countries = $2::text[],
             include_locations = $3::jsonb,
             include_industries = $4::text[],
             include_keywords = $5::text[],
             exclude_industries = $6::text[],
             exclude_keywords = $7::text[],
             sheet_raw = $8::jsonb,
             sheet_synced_at = now(),
             source = 'sheet',
             updated_at = now()`,
          [c.tag, countries, JSON.stringify(locs), inclInd, inclKw, exclInd, exclKw,
           sheetRaw === null ? null : JSON.stringify(sheetRaw)]
        );
        written++;
        console.log(`  ${c.tag}: ${locFail ? "locations kept" : `${locs.length} locations`}, ${inclInd.length} incl-cats, ${inclKw.length} incl-phrases, ${exclInd.length} excl-cats, ${exclKw.length} excl-keywords${allOk ? "" : "  [PARTIAL — will retry next run]"}`);
      }
      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (partial.length) {
      console.warn(`\n${partial.length} clients had failed passes (existing values kept, will re-parse next run): ${partial.join(", ")}`);
    }

    if (allDropped.length) {
      console.log(`\ndropped ${allDropped.length} location entries:`);
      for (const d of allDropped.slice(0, 40)) console.log(`  ${d.tag}: ${JSON.stringify(d.entry)} — ${d.reason}`);
      if (allDropped.length > 40) console.log(`  … and ${allDropped.length - 40} more`);
    }
    const cost = usage.input * PRICE_IN + usage.output * PRICE_OUT;
    console.log(`\nsynced ${written} clients | ${usage.calls} AI calls, ${usage.input.toLocaleString()} in / ${usage.output.toLocaleString()} out tokens ≈ $${cost.toFixed(3)}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
