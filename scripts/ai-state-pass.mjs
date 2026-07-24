#!/usr/bin/env node
import "dotenv/config";

/**
 * AI pass over leads tagged raw_data.state_ai_candidate=true by
 * clean-state-column.mjs — rows whose junk state value referenced a real but
 * ambiguous city (Sacramento, York, "City"+defaulted-SF cohort, ...).
 *
 * gpt-4o-mini sees the original junk value + city + postal + company + email
 * domain and returns {state, city} ONLY when confident; otherwise UNKNOWN and
 * the row keeps state=NULL. City is corrected only when the current value is
 * inconsistent with the evidence (audit found cohorts with city defaulted to
 * "San Francisco" while the company is clearly elsewhere).
 *
 * Reversible: city changes stash the original in raw_data.city_pre_clean;
 * every processed row gets raw_data.state_ai_done=true (also the resume marker).
 *
 * Usage: node --env-file=.env.local scripts/ai-state-pass.mjs [--dry-run] [--limit=N]
 */

import pg from "pg";

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error("Missing OPENAI_API_KEY"); process.exit(1); }
const DRY = process.argv.includes("--dry-run");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || 0;

const US_CODES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR","GU","VI","AS","MP"];
const CA_CODES = ["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"];
const VALID = new Set([...US_CODES, ...CA_CODES]);

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

const SYSTEM = `You determine the US state or Canadian province for sales leads whose location data was corrupted.

For each lead you get: junk_state (the corrupted original state value), city, postal, company, email_domain.

Rules:
- Answer with a 2-letter US state or Canadian province code ONLY when the evidence makes the location clear (e.g. city+company match a known place, postal code decides it, the company is a well-known local business).
- The city field may itself be WRONG (some cohorts were defaulted to "San Francisco"). If company/domain clearly point elsewhere (e.g. a Utah-only company), trust the company and correct the city too.
- The junk_state value may be a truncated city name ("City" from "Salt Lake City") — use it as a hint.
- If the lead is clearly OUTSIDE the US/Canada, or evidence is thin or conflicting, answer UNKNOWN. Never guess.
- corrected_city: only set when the current city is clearly wrong AND you know the right one; otherwise null.

Respond with JSON: {"results":[{"i":<index>,"state":"XX"|"UNKNOWN","corrected_city":string|null,"confidence":"high"|"low"}]} — one entry per lead, every index exactly once.`;

async function askBatch(batch, tries = 5) {
  const user = JSON.stringify(batch.map((r, i) => ({
    i, junk_state: r.junk, city: r.city, postal: r.postal_code,
    company: r.company, email_domain: (r.email || "").split("@")[1] || null,
  })));
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini", temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }],
        }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      const out = JSON.parse(data.choices[0].message.content);
      return Array.isArray(out.results) ? out.results : [];
    } catch (err) {
      if (attempt >= tries) { console.warn(`  batch failed after ${tries}: ${err.message}`); return []; }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

// ---------- load candidates ----------
console.log("loading ai-candidate rows...");
const rows = (await q(`
  SELECT id, raw_data->>'state_pre_clean' junk, city, postal_code, company, email
  FROM leads
  WHERE state IS NULL
    AND raw_data ? 'state_ai_candidate'
    AND NOT (raw_data ? 'state_ai_done')
  ${LIMIT ? `LIMIT ${LIMIT}` : ""}
`)).rows;
console.log(`candidates to process: ${rows.length}`);
if (!rows.length) { await pool.end(); process.exit(0); }

// ---------- process in batches with limited concurrency ----------
const BATCH = 25, CONC = 8;
const batches = [];
for (let i = 0; i < rows.length; i += BATCH) batches.push(rows.slice(i, i + BATCH));

let resolved = 0, unknown = 0, cityFixes = 0, processed = 0;
const updates = []; // {id, state|null, city|null(newval), done:true}

async function worker(queue) {
  for (;;) {
    const batch = queue.shift();
    if (!batch) return;
    const results = await askBatch(batch);
    const byIdx = new Map(results.map((r) => [r.i, r]));
    for (let i = 0; i < batch.length; i++) {
      const r = byIdx.get(i);
      const lead = batch[i];
      let state = null, city = null;
      if (r && r.confidence === "high" && typeof r.state === "string" && VALID.has(r.state.toUpperCase())) {
        state = r.state.toUpperCase();
        if (r.corrected_city && typeof r.corrected_city === "string" && r.corrected_city.trim() && r.corrected_city.trim() !== (lead.city || "").trim()) {
          city = r.corrected_city.trim(); cityFixes++;
        }
        resolved++;
      } else unknown++;
      updates.push({ id: lead.id, state, city, oldCity: lead.city });
    }
    processed += batch.length;
    process.stdout.write(`\r  processed ${processed}/${rows.length}  resolved=${resolved} unknown=${unknown} cityFixes=${cityFixes}`);
  }
}
const queue = [...batches];
await Promise.all(Array.from({ length: CONC }, () => worker(queue)));
console.log("");

if (DRY) {
  console.log("--dry-run: no writes. Sample decisions:");
  for (const u of updates.slice(0, 20)) console.log(` ${u.state ?? "UNKNOWN"} city=${u.city ?? "-"} (was ${u.oldCity})`);
  await pool.end(); process.exit(0);
}

// ---------- write ----------
const CHUNK = 2000; let done = 0;
for (let i = 0; i < updates.length; i += CHUNK) {
  const c = updates.slice(i, i + CHUNK);
  await q(`
    UPDATE leads l SET
      state = coalesce(v.new_state, l.state),
      city  = coalesce(v.new_city, l.city),
      raw_data = coalesce(l.raw_data,'{}'::jsonb)
                 || '{"state_ai_done":true}'::jsonb
                 || CASE WHEN v.new_city IS NOT NULL
                    THEN jsonb_build_object('city_pre_clean', v.old_city, 'city_source', 'ai')
                    ELSE '{}'::jsonb END
                 || CASE WHEN v.new_state IS NOT NULL
                    THEN '{"state_source":"ai"}'::jsonb ELSE '{}'::jsonb END
    FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) new_state,
                 unnest($3::text[]) new_city, unnest($4::text[]) old_city) v
    WHERE l.id = v.id
  `, [c.map((u) => u.id), c.map((u) => u.state), c.map((u) => u.city), c.map((u) => u.oldCity)]);
  done += c.length;
  process.stdout.write(`\r  written ${done}/${updates.length}`);
}
console.log("");

const after = await q(`SELECT count(*) n FROM leads WHERE raw_data->>'state_source' = 'ai'`);
console.log(`\nAI pass complete: resolved=${resolved} (state written: ${after.rows[0].n}) unknown=${unknown} cityFixes=${cityFixes}`);
await pool.end();
