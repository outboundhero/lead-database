#!/usr/bin/env node
// sync-client-targeting-from-sheet.mjs — parse the onboarding sheet's targeting
// columns into client_targeting with AI (ported from gmaps-UI's sync.ts).
//
// Sheet (ONBOARDING_SHEET_ID, tab gid 581954884 "Onboarding Form Responses"):
//   col A = Client Abbreviation (client_tag, may be "&"-joined compounds)
//   col L = Target industries & keywords        -> read, but NO LONGER STORED.
//           (2026-08-18) include_industries / include_keywords are always written
//           empty by client request. The text is still sent to the taxonomy pass
//           so an "include" category can never also land in exclude_industries.
//           Set the include side by hand in the Rules dialog if it's ever wanted.
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

// --serve: stay up, claim queued targeting_sync_jobs rows and run them, so the
// Clients page can start a sync that survives the browser tab closing. One job
// at a time; a job names the client tags to re-parse (empty = whatever changed).
const SERVE = process.argv.includes("--serve");
const POLL_MS = Number(process.env.TARGETING_POLL_MS) || 5000;

// Progress for the row the UI polls. All writes are best-effort — losing a
// progress update must never abort a sync that is otherwise working.
const JOB = { id: null, total: 0, processed: 0, synced: 0, failed: 0, pool: null };
async function jobSet(fields) {
  if (!JOB.id || !JOB.pool) return;
  const keys = Object.keys(fields);
  if (!keys.length) return;
  try {
    await JOB.pool.query(
      `update targeting_sync_jobs set ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`,
      [JOB.id, ...keys.map((k) => fields[k])]
    );
  } catch (e) { console.warn(`  (progress update failed: ${e.message})`); }
}
async function jobStep(n = 1) {
  JOB.processed += n;
  await jobSet({ processed: JOB.processed, ai_calls: usage.calls, ai_cost_usd: usage.cost.toFixed(4) });
}
async function jobLog(line) {
  if (!JOB.id || !JOB.pool) return;
  try {
    await JOB.pool.query(`update targeting_sync_jobs set log = array_append(log, $2) where id = $1`, [JOB.id, line]);
  } catch { /* best effort */ }
}

const SHEET_ID = process.env.ONBOARDING_SHEET_ID || "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const TAB_GID = 581954884;
// Two model tiers: the client's verbatim location/exclusion prompts were
// written for ChatGPT (GPT-4o-class) — 4o-mini repetition-loops on them and
// prunes explicit city lists. Taxonomy matching + include phrases stay on mini.
const MODEL = "gpt-4o-mini";
const TEXT_MODEL = process.env.TARGETING_TEXT_MODEL || "gpt-4o";

// A cleaning company must never be pitched to another cleaning company. Applied
// to every client whose Client Tracker type is "Cleaning" (col F), on top of
// whatever the sheet's own exclusion column says.
//
// Kept in code, not in the database: this sync REWRITES exclude_terms from the
// sheet on every run (the cron is every six hours) and the sheet has no column
// for these, so a row edited directly in the database would lose them silently.
//
// Matched whole-word and plural-tolerant like every other exclusion, so
// "cleaning" catches "Cleaning", "cleanings" and "ABC Cleaning Co" — see
// fn_whole_term_regex.
const CLEANING_INDUSTRY_EXCLUSIONS = [
  "cleaning", "janitorial", "custodial", "janitors", "janitor", "cleaners",
  "building services", "building maintenance", "building solutions",
  "facility services", "facilities services",
  "facility maintenance", "facilities maintenance",
  "facility solutions", "facilities solutions",
  "facility cleaning", "facilities cleaning",
  "commercial cleaning", "commercial janitorial", "commercial maintenance",
  "property maintenance", "property services",
];
const PRICES = { "gpt-4o-mini": [0.15 / 1e6, 0.6 / 1e6], "gpt-4o": [2.5 / 1e6, 10 / 1e6] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usage = { cost: 0, calls: 0 };
const addUsage = (model, json) => {
  const [pin, pout] = PRICES[model] ?? PRICES["gpt-4o-mini"];
  usage.cost += (json.usage?.prompt_tokens ?? 0) * pin + (json.usage?.completion_tokens ?? 0) * pout;
  usage.calls++;
};

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
    addUsage(MODEL, json);
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
      const err = new Error("truncated");
      err.truncated = true;
      throw err;
    }
    try { return JSON.parse(choice?.message?.content ?? "{}"); } catch { return {}; }
  }
}

// Plain-text completion (the client's prompts specify non-JSON output) —
// same retry/backoff/truncation semantics as aiJson.
async function aiText(user, { maxTokens = 8000, model = TEXT_MODEL } = {}) {
  const backoffMs = [2000, 8000, 30000];
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, temperature: 0, max_tokens: maxTokens,
          messages: [{ role: "user", content: user }],
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
    addUsage(model, json);
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
      // Callers can salvage the partial text (a truncated comma list is still
      // usable) — gpt-4o-mini sometimes repetition-loops on list prompts.
      const err = new Error("truncated");
      err.truncated = true;
      err.content = choice?.message?.content ?? "";
      throw err;
    }
    return choice?.message?.content ?? "";
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

// The location + exclusion prompts below are the client's own (Spencer,
// 2026-08-04), used VERBATIM — they are field-tested. Our only additions are
// outside the prompt: the [INSERT] slot is filled with the raw sheet cell, the
// plain-text output is parsed ("state: city, city" lines / one comma list),
// and every parsed entry is still validated against the geo reference before
// storage — nothing unvalidated is ever written.
const CLIENT_LOCATION_PROMPT = `Create an accurate, comprehensive inclusion-location list for commercial cleaning and janitorial lead targeting.

Service area:
[INSERT SERVICE AREA]

Rules:

1. Include every specifically named location.

2. Apply buffers based on the input:
- ZIP codes: 1–3 miles around the combined ZIP boundaries
- cities or towns: 3–5 miles around their combined municipal boundaries or developed commercial areas
- counties: include the full counties plus a 3–5-mile buffer
- mileage radius: use the stated radius without an additional buffer unless requested

3. For ZIP codes, include all cities, towns, boroughs, villages, census-designated places, and commonly used postal communities physically represented by the ZIPs. Do not rely only on the primary USPS city.

4. Include nearby locations only when their developed or commercial areas fall within the applicable buffer or form a continuous developed area with the core territory.

5. Do not add locations merely because they are in the same county, metro area, postal area, or broader region.

6. Exclude subdivisions, obscure rural localities, neighborhoods not commonly used as business locations, duplicates, misspellings, and locations clearly outside the territory.

7. When multiple locations are provided, evaluate their combined service area.

8. Keep specifically named locations even when they fall outside a stated radius.

9. Support multiple states and place each state on a separate line.

10. Include ALL cities, towns, and commonly recognized communities within the service area and buffers — small towns, census-designated places, and unincorporated communities too, not just well-known cities. Measure buffers from municipal boundaries or developed commercial areas, not city centers.

11. Format:
- lowercase
- alphabetical within each state
- no quotation marks
- no duplicates
- full state name followed by a colon
- comma-separated locations

Example — service area "Midland, Texas, and Odessa Texas. 45 mile radius of Odessa covering Big Spring, Andrews, Monahan" returns:
texas: andrews, big spring, coahoma, crane, gardendale, goldsmith, kermit, midland, monahans, odessa, penwell, pyote, stanton, west odessa, wickett, wink

Return only the final list:

state one: city, city, town
state two: city, city, town`;

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

const CLIENT_EXCLUSION_PROMPT = `Create a comprehensive, normalized, comma-separated list of industry and business-type exclusion keywords for commercial cleaning and janitorial lead targeting.

The client does not want to target:
[INSERT EXCLUDED INDUSTRIES OR BUSINESS TYPES]

Requirements:

1. Include the main industry term, common singular and plural variations, alternate spellings, commonly used business categories, and closely related business types.

2. Focus on terms that would realistically appear in:
- company names
- business descriptions
- industry classifications
- Google business categories
- LinkedIn company industries
- lead databases
- website descriptions

3. Use industry and business-type keywords only. Do not add phrases involving cleaning services unless the excluded industry itself is a cleaning company.

4. Keep the list comprehensive, but do not include broad terms that could exclude otherwise qualified businesses.

5. Do not include unrelated industries merely because they sometimes operate alongside an excluded industry.

6. Do not include job titles, employee roles, services offered by vendors, or equipment terms unless specifically requested.

7. Normalize obvious duplicates, but retain meaningful variations when databases may treat them differently.

8. Use lowercase.

9. Do not use quotation marks.

10. Return only one comma-separated list. Do not include an introduction, explanation, headings, bullets, or notes.

Example input:
salons, residential, bakeries, hair salons, barbershops

The output should include accurate related categories such as:
salon, salons, beauty salon, hair salon, hair studio, hairdresser, barber, barbershop, barber shop, nail salon, residential, residential property, apartment complex, condominium, homeowners association, bakery, bakeries, bake shop, pastry shop, cake shop, wholesale bakery

Do not automatically include categories that may still be acceptable unless they are clearly covered by the client's exclusion request.`;

// INCLUDE_KEYWORDS_PROMPT was removed 2026-08-18: include_keywords is no longer
// derived from the sheet (see the write phase). Recover it from git history if
// the include side is ever reinstated.


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

// State names come back WITHOUT a country (the client's prompt emits bare
// "massachusetts:") — resolve name/code to (country, state_code) with the
// same country priority the alias loader uses.
const stateResolveCache = new Map();
async function resolveState(pool, raw) {
  const key = raw.trim().toLowerCase();
  if (stateResolveCache.has(key)) return stateResolveCache.get(key);
  const { rows } = await pool.query(
    `SELECT country_code, state_code FROM geo_admin1
     WHERE LOWER(name) = $1 OR state_code = UPPER($2)
     ORDER BY array_position(ARRAY['US','CA','AU','NZ','GB','IE'], country_code) LIMIT 1`,
    [key, raw.trim()]);
  const out = rows[0] ?? null;
  stateResolveCache.set(key, out);
  return out;
}

async function validateLocations(pool, tag, entries) {
  const valid = [];
  const dropped = [];
  const seen = new Set();
  for (const e of entries ?? []) {
    let country = String(e?.country ?? "").trim().toUpperCase();
    const state = String(e?.state ?? "").trim();
    const city = String(e?.city ?? "").trim();
    if (!country && state) {
      const resolved = await resolveState(pool, state);
      if (!resolved) { dropped.push({ tag, entry: e, reason: `unknown state "${state}"` }); continue; }
      country = resolved.country_code;
    }
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

// Parse one client's location cell through the client's verbatim prompt.
// Output format is "state: city, city, town" lines (their rule 15/16); a bare
// "state:" line counts as a state-level entry. Splits and retries the halves
// when the response is truncated OR when the model returns zero entries for a
// clearly list-like cell (gpt-4o-mini deterministically gives up on 100+-city
// lists rather than emit the huge output — observed live, temp 0).
function parseLocationLines(text) {
  const entries = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*([a-z][a-z .'-]{1,40}?)\s*:\s*(.*)$/i);
    if (!m) continue;
    const stateName = m[1].trim();
    const cities = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    if (!cities.length) entries.push({ state: stateName });
    else for (const city of cities) entries.push({ state: stateName, city });
  }
  return entries;
}

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
    const text = await aiText(
      CLIENT_LOCATION_PROMPT.replace("[INSERT SERVICE AREA]", rawText));
    const locations = parseLocationLines(text);
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

async function main(job = null) {
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
    const { rows: tagRows } = await pool.query(`SELECT tag, client_type FROM client_tags`);
    const knownTags = new Set(tagRows.map((r) => r.tag));
    // Cleaning clients must not be sold to their own industry. These terms are
    // appended to every cleaning client's exclusions HERE rather than written
    // straight to the database, because this sync rewrites exclude_terms from
    // the sheet every six hours — a database-only edit would silently vanish on
    // the next run. The sheet has no column for them, so the code is the source.
    const cleaningTags = new Set(tagRows.filter((r) => r.client_type === "Cleaning").map((r) => r.tag));
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
    let changed = clients.filter((c) => FORCE || JSON.stringify(existingByTag.get(c.tag)?.sheet_raw ?? null) !== JSON.stringify(rawOf(c)));
    // A job may name specific tags (what the operator confirmed in the preview);
    // an empty list means "whatever is currently changed".
    if (job?.client_tags?.length) {
      const want = new Set(job.client_tags.map((t) => String(t).toUpperCase()));
      changed = clients.filter((c) => want.has(c.tag));
    }
    console.log(`${changed.length} changed, ${clients.length - changed.length} unchanged (skipped).`);
    if (job) {
      // 2 slow AI passes per client (locations, exclusions) + 1 write step.
      JOB.total = changed.length * 2 + 1;
      await jobSet({ total: JOB.total, phase: `Parsing ${changed.length} client(s)` });
    }

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
      } finally {
        await jobStep();
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

    // Pass C: exclusion keyword expansion — the client's verbatim prompt, one
    // call per client (its [INSERT] slot is single-client), output is one
    // comma-separated list. Failure keeps existing values, never [].
    const exclInput = changed.filter((c) => c.exclusion);
    const exclRes = { out: {}, failed: new Set() };
    await mapConcurrent(exclInput, 4, async (c) => {
      try {
        let text;
        try {
          text = await aiText(
            CLIENT_EXCLUSION_PROMPT.replace("[INSERT EXCLUDED INDUSTRIES OR BUSINESS TYPES]", c.exclusion),
            { maxTokens: 3000 });
        } catch (err) {
          // Repetition-looped output hits max_tokens; the partial comma list is
          // fine once deduped — drop the final (possibly cut-off) item.
          if (!err.truncated || !err.content) throw err;
          text = err.content.replace(/,[^,]*$/, "");
        }
        // Their rule 10: one comma-separated list, no prose. Take the longest
        // comma-bearing line in case the model adds a stray blank/label line.
        const line = text.split("\n").map((s) => s.trim()).filter(Boolean)
          .sort((a, b) => b.length - a.length)[0] ?? "";
        const keywords = line.split(",").map((s) => s.trim()).filter(Boolean);
        if (!keywords.length) throw new Error("empty exclusion list from model");
        exclRes.out[c.tag] = keywords;
      } catch (err) {
        exclRes.failed.add(c.tag);
        console.error(`  ${c.tag}: exclusion expansion failed — ${err.message} (keeping existing values)`);
      } finally {
        await jobStep();
      }
    });

    // Pass D (include search phrases) was REMOVED 2026-08-18 by client request:
    // include_keywords / include_industries are now always empty, set by hand in
    // the Rules dialog if wanted at all. They never gated pushes — include_keywords
    // only pre-filled the Category search filter when a client was selected. This
    // also drops ~1 AI call per changed client per run.

    const cleanList = (tag, kind, list, max = 200) => {
      const cleaned = [...new Set((Array.isArray(list) ? list : []).map((s) => String(s).trim().toLowerCase()).filter((s) => s && s.length <= 60))];
      if (cleaned.length > max) console.warn(`  ${tag}: ${kind} truncated ${cleaned.length} -> ${max}`);
      return cleaned.slice(0, max);
    };

    // Write — one transaction. Per client, a field is only overwritten when its
    // pass succeeded; sheet_raw advances ONLY when every relevant pass
    // succeeded, so partially-failed clients are re-parsed on the next run.
    // Snapshot what we are about to overwrite so the whole job can be reverted.
    // Re-parsing is not deterministic — the same sheet text can yield materially
    // different locations/exclusions — so an undo is not optional.
    if (JOB.id && JOB.pool) {
      try {
        const tags = changed.map((c) => c.tag);
        const { rows: snap } = await pool.query(
          `select * from client_targeting where client_tag = any($1::text[])`, [tags]);
        await JOB.pool.query(`update targeting_sync_jobs set snapshot = $2::jsonb where id = $1`,
          [JOB.id, JSON.stringify(snap)]);
        console.log(`  snapshot: ${snap.length} client row(s) saved for revert`);
      } catch (e) {
        throw new Error(`could not snapshot current rules (refusing to overwrite): ${e.message}`);
      }
    }

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

        const locs = locFail ? (ex?.include_locations ?? []) : (hasLoc ? locByTag.get(c.tag) : []);
        const cats = bFail ? null : (catRes.out[c.tag] ?? {});
        // The model's INCLUDE list is still requested and used HERE ONLY, to
        // guarantee a category is never both included and excluded. It is no
        // longer stored — include_industries/include_keywords are written empty
        // (client request 2026-08-18); set them by hand in the Rules dialog if needed.
        const aiInclude = cats ? canonCats(cats.include) : [];
        const exclInd = cats ? canonCats(cats.exclude).filter((n) => !aiInclude.includes(n)) : (ex?.exclude_industries ?? []);
        const exclKw = cFail ? (ex?.exclude_keywords ?? []) : cleanList(c.tag, "exclude_keywords", exclRes.out[c.tag]);
        const derived = [...new Set(locs.map((l) => l.country))];
        const countries = derived.length ? derived : (ex?.countries?.length ? ex.countries : ["US"]);
        const allOk = !locFail && !bFail && !cFail;
        const sheetRaw = allOk ? rawOf(c) : (ex?.sheet_raw ?? null);
        if (!allOk) partial.push(c.tag);

        await client.query(
          // commercial_cleaning is set ON INSERT ONLY, from the client's type in
          // the Client Tracker (col F): cleaning clients exclude the
          // commercial-cleaning title list by default (client rule 2026-08-25).
          // It is deliberately ABSENT from the DO UPDATE list below — the sheet
          // has no column for it, so a re-sync must never undo a manual toggle.
          `INSERT INTO client_targeting (client_tag, countries, include_locations, include_industries, include_keywords,
                                         exclude_industries, exclude_keywords, exclude_terms, include_terms,
                                         sheet_raw, sheet_synced_at, source, updated_at, commercial_cleaning)
           VALUES ($1, $2::text[], $3::jsonb, $4::text[], $5::text[], $6::text[], $7::text[], $9::text[], '{}',
                   $8::jsonb, now(), 'sheet', now(),
                   coalesce((SELECT ct.client_type = 'Cleaning' FROM client_tags ct WHERE ct.tag = $1), false))
           ON CONFLICT (client_tag) DO UPDATE SET
             countries = $2::text[],
             include_locations = $3::jsonb,
             include_industries = $4::text[],
             include_keywords = $5::text[],
             exclude_industries = $6::text[],
             exclude_keywords = $7::text[],
             exclude_terms = $9::text[],
             include_terms = '{}',
             sheet_raw = $8::jsonb,
             sheet_synced_at = now(),
             source = 'sheet',
             updated_at = now()`,
          // $4 / $5 are always '{}' now — include_industries / include_keywords
          // are never populated from the sheet.
          // $9 exclude_terms: the merged list migrations 078/079 made THE list
          // the send logic reads. The legacy $6/$7 columns are still written so
          // 079 stays rollback-able; drop them once that's no longer needed.
          [c.tag, countries, JSON.stringify(locs), [], [], exclInd, exclKw,
           sheetRaw === null ? null : JSON.stringify(sheetRaw),
           [...new Set([
             ...exclInd, ...exclKw,
             // Cleaning clients also exclude their own industry (2026-08-27).
             ...(cleaningTags.has(c.tag) ? CLEANING_INDUSTRY_EXCLUSIONS : []),
           ].map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort()]
        );
        written++;
        const line = `${c.tag}: ${locFail ? "locations kept" : `${locs.length} locations`}, ${exclInd.length} excl-cats, ${exclKw.length} excl-keywords${allOk ? "" : "  [PARTIAL — will retry next run]"}`;
        console.log(`  ${line}`);
        await jobLog(line);
      }
      await client.query("commit");
      await jobSet({ synced: written, failed: partial.length, phase: "Saved" });
      await jobStep();
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
    console.log(`\nsynced ${written} clients | ${usage.calls} AI calls ≈ $${usage.cost.toFixed(2)} (${MODEL} + ${TEXT_MODEL})`);
  } finally {
    await pool.end();
  }
}

// One job at a time, claimed with FOR UPDATE SKIP LOCKED so a second worker (or
// an overlapping deploy) can never run the same job twice.
async function serve() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  pool.on("error", (e) => console.error("pg idle-client error:", e.message)); // never kill the loop
  JOB.pool = pool;
  let shuttingDown = false;
  process.on("SIGTERM", () => { shuttingDown = true; console.log("SIGTERM — finishing current job, then exiting"); });

  console.log(`targeting-worker up — polling every ${POLL_MS}ms`);
  while (!shuttingDown) {
    let job = null;
    try {
      ({ rows: [job] } = await pool.query(
        `update targeting_sync_jobs
            set status = 'running', started_at = coalesce(started_at, now()), phase = 'Reading the onboarding sheet'
          where id = (select id from targeting_sync_jobs where status = 'pending'
                       order by created_at limit 1 for update skip locked)
          returning *`));
    } catch (e) {
      console.error("claim failed:", e.message);
    }
    if (!job) { await sleep(POLL_MS); continue; }

    console.log(`\n=== job ${job.id} (${job.client_tags?.length || "all changed"} client(s)) ===`);
    JOB.id = job.id; JOB.processed = 0; JOB.total = 0;
    usage.calls = 0; usage.cost = 0;
    try {
      await main(job);
      await pool.query(
        `update targeting_sync_jobs
            set status = 'complete', completed_at = now(), phase = 'Done',
                processed = greatest(processed, total), ai_calls = $2, ai_cost_usd = $3
          where id = $1`,
        [job.id, usage.calls, usage.cost.toFixed(4)]);
      console.log(`=== job ${job.id} complete — ${usage.calls} AI calls ≈ $${usage.cost.toFixed(2)} ===`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await pool.query(
        `update targeting_sync_jobs set status = 'error', completed_at = now(), error = $2,
                ai_calls = $3, ai_cost_usd = $4 where id = $1`,
        [job.id, msg.slice(0, 500), usage.calls, usage.cost.toFixed(4)]).catch(() => {});
      console.error(`=== job ${job.id} FAILED: ${msg} ===`);
    }
    JOB.id = null;
  }
  await pool.end();
  console.log("targeting-worker stopped");
}

const entry = SERVE ? serve() : main();
entry.catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
