#!/usr/bin/env node
import "dotenv/config";

/**
 * AI-resolve the Unresolved Location queue.
 *
 * Two passes, cheapest first:
 *
 *  PASS 1 — per VARIATION (one AI call covers every lead sharing the text).
 *    Classifies each distinct variation:
 *      state    -> "California" in the city field = US state-level
 *      city     -> unambiguous place ("Tulsa") = resolve outright
 *      foreign  -> "Bengaluru"/"London"/"Singapore" = unsupported, hidden
 *      junk     -> "false"/"local"/"--" = no location, clear it
 *      ambiguous-> "Springfield"/"Portland" = needs per-lead context (pass 2)
 *    Every non-junk verdict is validated against the geo reference and cached
 *    in location_aliases, so the same text never costs anything again.
 *
 *  PASS 2 — per LEAD, only for ambiguous variations: company name, domain,
 *    phone area code and address decide the state. Confident answers only.
 *
 * Nothing is guessed: anything unresolved after both passes stays in the queue.
 *
 * Usage: node --env-file=.env.local scripts/resolve-unresolved-locations.mjs
 *          [--dry-run] [--limit=N] [--skip-lead-pass]
 */

import pg from "pg";

const DRY = process.argv.includes("--dry-run");
const SKIP_LEADS = process.argv.includes("--skip-lead-pass");
const VERBOSE = process.argv.includes("--verbose");
const decisions = [];
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity;
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));
pool.on("connect", (c) => c.query("SET statement_timeout = 0").catch(() => {}));
async function q(text, params, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(text, params); }
    catch (err) {
      const transient = err.code === "XX000" || err.code === "40P01" ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|termin|timeout|socket|server closed|Internal error|:closed/i.test((err.message || "") + " " + (err.code || ""));
      if (!transient || attempt >= tries) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
const ck = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, "");

async function ai(system, user, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" },
          messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error.message);
      return JSON.parse(d.choices[0].message.content);
    } catch (e) {
      if (attempt >= tries) { console.warn(`  AI call failed: ${e.message}`); return null; }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// reference lookups
const countryDisp = new Map();
for (const r of (await q(`SELECT code, display_name FROM supported_countries WHERE enabled`)).rows) countryDisp.set(r.code, r.display_name);
const admin1 = new Map();     // `${country}|${state_code}` -> name
for (const r of (await q(`SELECT country_code, state_code, name FROM geo_admin1`)).rows) {
  if (!admin1.has(`${r.country_code}|${r.state_code}`)) admin1.set(`${r.country_code}|${r.state_code}`, r.name);
}
// How many distinct states does this city name exist in, across supported
// countries? The AI is confident about "Kansas City" (MO) and "Albany" (NY),
// but our own ZIP evidence proves those leads include Kansas City KS and
// Albany GA. So ambiguity is decided by the REFERENCE, not by the model:
// any name living in more than one state goes to the per-lead pass.
const ambiguityCache = new Map();
async function stateCount(city) {
  const k = ck(city);
  if (ambiguityCache.has(k)) return ambiguityCache.get(k);
  const r = await q(`
    SELECT count(DISTINCT (g.country_code, a.state_code))::int AS n
    FROM geo_locations g
    JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
    WHERE g.city_key = $1`, [k]);
  const n = r.rows[0]?.n ?? 0;
  ambiguityCache.set(k, n);
  return n;
}

async function lookupCity(city, stateCode, country) {
  const r = await q(`
    SELECT g.geoname_id, g.city FROM geo_locations g
    JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
    WHERE g.city_key = $1 AND g.country_code = $2 AND a.state_code = $3
    ORDER BY g.population DESC LIMIT 1`, [ck(city), country, stateCode]);
  return r.rows[0] ?? null;
}

const MATCH = `location_status = 'unresolved' AND
  COALESCE(NULLIF(btrim(city), ''), raw_data->>'city_pre_clean', raw_data->>'state_pre_clean', '(none)') = $1`;

async function applyResolution(variation, res) {
  // res: {kind, country, state_code, city, geoname_id}
  if (DRY) return 0;
  if (res.kind === "junk") {
    const r = await q(`UPDATE leads SET location_status = NULL, city = NULL,
        raw_data = coalesce(raw_data,'{}'::jsonb) || '{"location_review":false}'::jsonb
      WHERE ${MATCH}`, [variation]);
    return r.rowCount;
  }
  if (res.kind === "foreign") {
    const r = await q(`UPDATE leads SET location_status = 'unsupported'
      WHERE ${MATCH}`, [variation]);
    return r.rowCount;
  }
  // city/state resolution — cache the alias then apply
  await q(`
    INSERT INTO location_aliases (alias_key, level, country_code, state_code, geoname_id, source)
    VALUES (regexp_replace(lower($1), '[^a-z]', '', 'g'), $2, $3, $4, $5, 'ai')
    ON CONFLICT (alias_key) DO UPDATE SET level=EXCLUDED.level, country_code=EXCLUDED.country_code,
      state_code=EXCLUDED.state_code, geoname_id=EXCLUDED.geoname_id, source='ai'`,
    [variation, res.geoname_id ? "city" : "state", res.country, res.state_code ?? null, res.geoname_id ?? null]);
  const stateName = res.state_code ? admin1.get(`${res.country}|${res.state_code}`) ?? null : null;
  const r = await q(`
    UPDATE leads SET
      city = COALESCE($2, city), state = COALESCE($3, state), state_code = COALESCE($4, state_code),
      country = $5, country_code = $6, location_id = $7,
      location_status = $8, location_source = 'ai-queue'
    WHERE ${MATCH}`,
    [variation, res.city ?? null, stateName, res.state_code ?? null,
     countryDisp.get(res.country) ?? null, res.country, res.geoname_id ?? null,
     res.geoname_id ? "resolved" : "partial"]);
  return r.rowCount;
}

// ── PASS 1: variation level ──
const variations = (await q(`
  SELECT COALESCE(NULLIF(btrim(city), ''), raw_data->>'city_pre_clean', raw_data->>'state_pre_clean', '(none)') AS v,
         count(*)::int AS n
  FROM leads WHERE location_status = 'unresolved'
  GROUP BY 1 ORDER BY n DESC`)).rows.slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.log(`unresolved variations: ${variations.length} (${variations.reduce((a, b) => a + b.n, 0)} leads)`);

const SYS1 = `You classify raw location text from a B2B lead database. Supported countries ONLY: USA (US), Canada (CA), Australia (AU), New Zealand (NZ), United Kingdom (GB), Ireland (IE).

For each input string decide:
- "state": the text names a state/province/region (e.g. "California", "Ontario", "Victoria"). Give country + state_code.
- "city": the text names ONE clearly identifiable city/town in a supported country, unambiguous enough to pick its state confidently (e.g. "Tulsa" -> OK, "Milwaukee" -> WI). Give country + state_code + city.
- "ambiguous": a real place name that exists in several states and cannot be chosen without more context ("Springfield", "Portland", "Columbia").
- "foreign": a real place clearly OUTSIDE the six supported countries ("Bengaluru", "London", "Singapore", "Tijuana").
- "junk": not a location at all ("false", "local", "--", "your area", "undefined", numbers, sentences).
Metro/area phrasing ("Greater Eugene-Springfield Area", "Dallas-Fort Worth Metroplex") -> "city" with the primary city.

Respond JSON: {"results":[{"i":<index>,"kind":"state|city|ambiguous|foreign|junk","country":"US|CA|AU|NZ|GB|IE"|null,"state_code":string|null,"city":string|null}]} — every index exactly once.`;

const ambiguous = [];
let counts = { state: 0, city: 0, foreign: 0, junk: 0, ambiguous: 0, rejected: 0 };
let leadsTouched = 0;
{
  const BATCH = 40, CONC = 6;
  const batches = [];
  for (let i = 0; i < variations.length; i += BATCH) batches.push(variations.slice(i, i + BATCH));
  let done = 0;
  const queue = [...batches];
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const b = queue.shift(); if (!b) return;
      const out = await ai(SYS1, JSON.stringify(b.map((x, i) => ({ i, text: x.v }))));
      const byIdx = new Map((out?.results ?? []).map((r) => [r.i, r]));
      for (let i = 0; i < b.length; i++) {
        const r = byIdx.get(i); const item = b[i];
        if (!r) continue;
        if (r.kind === "ambiguous") { ambiguous.push(item); counts.ambiguous++; continue; }
        if (r.kind === "junk") { counts.junk++; leadsTouched += await applyResolution(item.v, { kind: "junk" }); continue; }
        if (r.kind === "foreign") { counts.foreign++; leadsTouched += await applyResolution(item.v, { kind: "foreign" }); continue; }
        if (!r.country || !countryDisp.has(r.country)) { counts.rejected++; continue; }
        if (r.kind === "state") {
          if (!r.state_code || !admin1.has(`${r.country}|${r.state_code}`)) { counts.rejected++; continue; }
          counts.state++;
          leadsTouched += await applyResolution(item.v, { kind: "state", country: r.country, state_code: r.state_code });
          continue;
        }
        if (r.kind === "city") {
          if (!r.city || !r.state_code) { counts.rejected++; continue; }
          // Reference-enforced ambiguity: a multi-state name is NEVER resolved
          // from the text alone, however confident the model sounds.
          if (await stateCount(r.city) > 1) { ambiguous.push(item); counts.ambiguous++; continue; }
          const g = await lookupCity(r.city, r.state_code, r.country);
          if (!g) { counts.rejected++; continue; }   // invented place -> reject
          counts.city++;
          if (VERBOSE) decisions.push(`${item.n.toString().padStart(5)} ${JSON.stringify(item.v).slice(0,32).padEnd(34)} -> ${g.city}, ${r.state_code}, ${r.country}`);
          leadsTouched += await applyResolution(item.v, { kind: "city", country: r.country, state_code: r.state_code, city: g.city, geoname_id: Number(g.geoname_id) });
        }
      }
      done++;
      process.stdout.write(`\r  pass1 ${done}/${batches.length} state=${counts.state} city=${counts.city} foreign=${counts.foreign} junk=${counts.junk} ambiguous=${counts.ambiguous} rejected=${counts.rejected}`);
    }
  }));
  console.log("");
}

// ── PASS 2: per-lead for ambiguous variations ──
let leadResolved = 0, leadUnknown = 0;
if (!SKIP_LEADS && ambiguous.length) {
  const SYS2 = `A lead database has leads whose city text is a real place name that exists in MULTIPLE US/Canada states, so the state is unknown. Using the company name, website/domain, phone and address, determine which state this lead's city is in.

Rules: answer ONLY when the evidence makes it clear (a phone area code, an address, a company known to be local, a domain naming the region). Otherwise UNKNOWN — never guess.
Supported countries: US, CA, AU, NZ, GB, IE.
Respond JSON: {"results":[{"i":<index>,"country":"US|CA|AU|NZ|GB|IE"|null,"state_code":string|null,"confidence":"high"|"low"}]} — every index exactly once.`;

  for (const v of ambiguous) {
    const leads = (await q(`
      SELECT id, city, company, domain, website, email, phone, company_phone, address, postal_code
      FROM leads WHERE ${MATCH}`, [v.v])).rows;
    if (!leads.length) continue;
    const BATCH = 25;
    for (let i = 0; i < leads.length; i += BATCH) {
      const b = leads.slice(i, i + BATCH);
      const out = await ai(SYS2, JSON.stringify(b.map((l, j) => ({
        i: j, city: v.v, company: l.company, domain: l.domain || l.website || (l.email || "").split("@")[1],
        phone: l.company_phone || l.phone, address: l.address, postal: l.postal_code,
      }))));
      const byIdx = new Map((out?.results ?? []).map((r) => [r.i, r]));
      const ups = [];
      for (let j = 0; j < b.length; j++) {
        const r = byIdx.get(j);
        if (!r || r.confidence !== "high" || !r.country || !r.state_code || !admin1.has(`${r.country}|${r.state_code}`)) { leadUnknown++; continue; }
        // The per-lead answer must still name a real place in that state.
        const g = await lookupCity(v.v, r.state_code, r.country);
        if (!g) { leadUnknown++; continue; }
        ups.push({ id: b[j].id, city: g.city, geoname_id: Number(g.geoname_id),
                   state_code: r.state_code, state: admin1.get(`${r.country}|${r.state_code}`),
                   country: r.country });
        leadResolved++;
      }
      if (ups.length && !DRY) {
        await q(`
          UPDATE leads l SET city = v.city, state = v.state, state_code = v.sc,
            country = v.cdisp, country_code = v.cc, location_id = v.gid,
            location_status = 'resolved', location_source = 'ai-queue-lead'
          FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) city, unnest($3::text[]) state,
                       unnest($4::text[]) sc, unnest($5::text[]) cdisp, unnest($6::text[]) cc,
                       unnest($7::bigint[]) gid) v
          WHERE l.id = v.id`,
          [ups.map((u) => u.id), ups.map((u) => u.city), ups.map((u) => u.state), ups.map((u) => u.state_code),
           ups.map((u) => countryDisp.get(u.country)), ups.map((u) => u.country), ups.map((u) => u.geoname_id)]);
      }
      process.stdout.write(`\r  pass2 resolved=${leadResolved} unknown=${leadUnknown}`);
    }
  }
  console.log("");
}

if (VERBOSE && decisions.length) {
  console.log("\n-- city decisions (leads, raw -> resolved) --");
  for (const d of decisions.sort((a, b) => parseInt(b) - parseInt(a)).slice(0, 40)) console.log(d);
}
console.log(`\ndone${DRY ? " [dry-run]" : ""}: variations state=${counts.state} city=${counts.city} foreign=${counts.foreign} junk=${counts.junk} rejected=${counts.rejected}`);
console.log(`leads touched by pass1=${leadsTouched}; pass2 resolved=${leadResolved} still-unknown=${leadUnknown}`);
if (!DRY) {
  const after = (await q(`SELECT count(*) n FROM leads WHERE location_status = 'unresolved'`)).rows[0];
  console.log(`queue remaining: ${after.n}`);
}
await pool.end();
