#!/usr/bin/env node
import "dotenv/config";

/**
 * Fast bulk import of Email Bison full-instance CSV exports (update existing
 * by email + insert new). Port of import-bison-csv.mjs's parser + merge
 * semantics onto the pg pool (streaming parse, UNNEST upserts) — built for
 * the multi-GB per-instance exports (~9M rows total vs HTTP's days).
 *
 * Geo-era additions over the original merge rules:
 *   - rows already normalized by the location system (location_status
 *     resolved/partial) KEEP their city/state — a raw re-import never
 *     clobbers normalized display values or desyncs location_id
 *   - Clay-enriched categories are protected like manual ones (the paid
 *     enrichment outranks a re-imported Bison custom variable)
 * New/unlocated rows take the CSV location (state normalized to a code) and
 * the location-worker resolves them to entities on its next run.
 *
 * Usage:
 *   node --env-file=.env.local scripts/import-bison-drive.mjs <file.csv> --instance=app.outboundhero.co [--dry-run] [--limit=N]
 */

import fs from "fs";
import pg from "pg";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const instance = (args.find((a) => a.startsWith("--instance=")) || "").split("=")[1];
if (!file || !instance) {
  console.error("Usage: import-bison-drive.mjs <file.csv> --instance=<domain>");
  process.exit(1);
}
const DRY = args.includes("--dry-run");
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) || "").split("=")[1]) || Infinity;
const CHUNK = 1400;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));
async function q(text, params, tries = 5) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(text, params); }
    catch (err) {
      // 40P01 deadlock / 40001 serialization: parallel importers touching
      // overlapping emails — always worth retrying.
      // Retry deadlocks (40P01), serialization (40001), and every pooler/network
      // drop. NB "ETIMEDOUT" does NOT contain the substring "timeout" — that
      // gap is what killed the first two runs.
      const transient = err.code === "40P01" || err.code === "40001" || err.code === "XX000" ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|termin|timeout|socket|server closed|Internal error|:closed|Connection terminated|deadlock/i.test(err.message || "") ||
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|termin|timeout|socket|server closed|Internal error|:closed|Connection terminated|deadlock/i.test(String(err.code || ""));
      if (!transient || attempt >= tries) throw err;
      console.warn(`  transient DB error (${attempt}/${tries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// ── parser (ported verbatim from import-bison-csv.mjs) ──
const ROLE_PREFIXES = /^(info|contact|hello|sales|support|admin|team|office|marketing|noreply|no-?reply|mail|careers|hr|jobs|press|media|billing|accounts?|invoices?|enquir(?:y|ies)|inquir(?:y|ies)|hi|help|service|reception|frontdesk|orders|shop|store|web|webmaster|postmaster|abuse)@/i;
const GENERAL_PAREN = /\(\s*general[^)]*\)/i;
function detectEmailType({ email, first_name, last_name, job_title }) {
  if (GENERAL_PAREN.test(first_name ?? "")) return "general";
  if (GENERAL_PAREN.test(last_name ?? "")) return "general";
  if (GENERAL_PAREN.test(job_title ?? "")) return "general";
  if (email && ROLE_PREFIXES.test(email.trim())) return "general";
  return "personal";
}
const US_STATES = { alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV","new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA","west virginia":"WV",wisconsin:"WI",wyoming:"WY","district of columbia":"DC",dc:"DC" };
const CA_PROV = { alberta:"AB","british columbia":"BC",manitoba:"MB","new brunswick":"NB","newfoundland and labrador":"NL",newfoundland:"NL","nova scotia":"NS",ontario:"ON","prince edward island":"PE",pei:"PE",quebec:"QC","québec":"QC",saskatchewan:"SK",yukon:"YT","northwest territories":"NT",nunavut:"NU" };
const VALID_CODES = new Set([...Object.values(US_STATES), ...Object.values(CA_PROV)]);
function normalizeState(raw) {
  const t = (raw ?? "").trim(); if (!t) return null;
  if (t.length === 2 && VALID_CODES.has(t.toUpperCase())) return t.toUpperCase();
  const l = t.toLowerCase(); return US_STATES[l] ?? CA_PROV[l] ?? null;
}
const ESP_TAGS = { outlook:"Microsoft",microsoft:"Microsoft","office 365":"Microsoft",google:"Google","google workspace":"Google",gmail:"Google",yahoo:"Yahoo","custom mail server":"Custom",zoho:"Zoho",proofpoint:"Proofpoint",mimecast:"Mimecast",barracuda:"Barracuda" };
const pInt0 = (v) => { const n = parseInt((v ?? "").trim(), 10); return isNaN(n) ? 0 : n; };
function parseCV(raw) {
  const out = {}; if (!raw || !raw.trim()) return out;
  try { const arr = JSON.parse(raw); if (!Array.isArray(arr)) return out;
    for (const it of arr) if (it && typeof it.name === "string" && typeof it.value === "string") out[it.name.trim().toLowerCase()] = it.value.trim();
  } catch {} return out;
}
function normalizeBisonRow(row, idx) {
  const get = (n) => { const i = idx[n]; return i === undefined ? undefined : (row[i] ?? "").trim(); };
  const email = get("email")?.toLowerCase();
  if (!email || !email.includes("@")) return null;
  const lead = { email };
  const fn = get("first_name"), ln = get("last_name"), ti = get("title"), co = get("company"), no = get("notes");
  if (fn) lead.first_name = fn;
  if (ln) lead.last_name = ln;
  if (ti) lead.title = ti;
  if (co) lead.company = co;
  if (no) lead.notes = no;
  const bid = parseInt((get("lead id") ?? "").trim(), 10); if (!isNaN(bid)) lead.bison_lead_id = bid;
  const wid = parseInt((get("workspace id") ?? "").trim(), 10); if (!isNaN(wid)) lead.workspace_id = wid;
  const wn = get("workspace name"); if (wn) lead.workspace_name = wn;
  lead.instance_url = instance;
  const bs = get("status"); if (bs) lead.bison_status = bs;
  lead.emails_sent = pInt0(get("emails_sent"));
  lead.opens = pInt0(get("opens"));
  lead.replies = pInt0(get("replies"));
  lead.unique_replies = pInt0(get("unique_replies"));
  lead.unique_opens = pInt0(get("unique_opens"));
  const bounces = pInt0(get("bounces")); lead.bounces = bounces;
  const tags = get("comma separated tags");
  if (tags) { lead.tags = tags; for (const t of tags.split(",").map((s) => s.trim().toLowerCase())) { if (ESP_TAGS[t]) { lead.esp = ESP_TAGS[t]; break; } } }
  const cv = parseCV(get("custom_variables"));
  const clean = (v) => { if (!v) return undefined; const low = v.trim().toLowerCase(); return (!v.trim() || low === "there" || low === "null" || low === "n/a" || low === "none") ? undefined : v.trim(); };
  if (clean(cv.city)) lead.city = cv.city;
  if (clean(cv.state)) lead.state = normalizeState(cv.state) ?? cv.state;
  if (clean(cv.domain)) lead.domain = cv.domain;
  if (clean(cv.address)) {
    lead.address = cv.address;
    const addr = cv.address.trim();
    const zip = addr.match(/\b\d{5}(?:-\d{4})?\b/);
    if (zip) lead.postal_code = zip[0];
    if (/^\s*\d/.test(addr)) lead.street = addr.split(",")[0].trim();
  }
  if (clean(cv.question)) lead.question = cv.question;
  if (clean(cv["company phone"])) lead.company_phone = cv["company phone"];
  if (clean(cv["google maps url"])) lead.google_maps_url = cv["google maps url"];
  const pick = (...keys) => { for (const k of keys) { const v = clean(cv[k]); if (v) return v; } return undefined; };
  const cvCategory = pick("category", "business category");
  const cvSubcategory = pick("subcategory", "sub category", "sub_category");
  const cvAdditional = pick("additional category", "additional_category", "additional categories");
  if (cvCategory) { lead.category = cvCategory; lead.category_source = "bison"; lead.category_confidence = 1; lead.categorized_at = new Date().toISOString(); }
  if (cvSubcategory) lead.subcategory = cvSubcategory;
  if (cvAdditional) lead.additional_category = cvAdditional;
  // Timestamps: a single unparseable value used to abort the entire file
  // (22007). Keep only values Postgres will accept.
  const ts = (v) => {
    if (!v) return undefined;
    const d = new Date(v);
    return isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  const ca = ts(get("created_at")), ua = ts(get("updated_at"));
  if (ca) lead.created_at = ca;
  if (ua) lead.updated_at = ua;
  lead.source = "Email Bison";
  lead.is_bounced = bounces > 0;
  if (bounces > 0) { lead.bounce_source = "emailbison_csv"; lead.bounced_at = new Date().toISOString(); }
  lead.email_type = detectEmailType({ email, first_name: fn, last_name: ln, job_title: ti });
  return lead;
}

// ── merge (ported; + geo/clay protection) ──
const MERGE_COLS = [
  "first_name", "last_name", "title", "company", "notes",
  "bison_lead_id", "workspace_id", "workspace_name", "instance_url", "bison_status",
  "tags", "esp", "city", "state", "domain", "address", "postal_code", "street",
  "question", "company_phone", "google_maps_url",
  "category", "subcategory", "additional_category",
  "category_source", "category_confidence", "categorized_at",
  "created_at", "updated_at", "bounce_source", "bounced_at",
];
function mergeWithExisting(lead, existing) {
  const out = {
    email: lead.email,
    emails_sent: lead.emails_sent, opens: lead.opens, replies: lead.replies,
    unique_replies: lead.unique_replies, unique_opens: lead.unique_opens,
    bounces: lead.bounces, source: lead.source, email_type: lead.email_type,
  };
  for (const k of MERGE_COLS) out[k] = lead[k] ?? existing?.[k] ?? null;

  if (existing?.created_at) out.created_at = existing.created_at;
  else if (!out.created_at) out.created_at = new Date().toISOString();
  if (!out.updated_at) out.updated_at = out.created_at;

  // Category: manual AND clay assignments outrank a CSV re-import.
  if (existing?.category && (existing.category_source === "manual" || existing.category_source === "clay")) {
    out.category = existing.category;
    out.subcategory = existing.subcategory ?? null;
    out.additional_category = existing.additional_category ?? null;
    out.category_source = existing.category_source;
    out.category_confidence = existing.category_confidence ?? null;
    out.categorized_at = existing.categorized_at ?? null;
  }

  // Location: normalized rows keep their display values — raw CSV never wins.
  if (existing && (existing.location_status === "resolved" || existing.location_status === "partial")) {
    out.city = existing.city;
    out.state = existing.state;
  }

  // is_bounced: never downgrade; sender/gateway recoveries stay recovered.
  const recovered = existing && existing.is_bounced === false &&
    (existing.bounce_type === "sender" || existing.bounce_type === "gateway");
  if (recovered) {
    out.is_bounced = false;
    out.bounce_source = existing.bounce_source ?? null;
    out.bounced_at = existing.bounced_at ?? null;
  } else {
    out.is_bounced = (existing?.is_bounced ?? false) || lead.is_bounced;
    if (existing?.bounced_at) { out.bounced_at = existing.bounced_at; out.bounce_source = existing.bounce_source ?? out.bounce_source; }
  }
  return out;
}

// ── upsert plumbing ──
const COLS = [
  "email", ...MERGE_COLS,
  "emails_sent", "opens", "replies", "bounces", "unique_replies", "unique_opens",
  "source", "email_type", "is_bounced",
];
const CASTS = {
  bison_lead_id: "bigint", workspace_id: "bigint", category_confidence: "numeric",
  created_at: "timestamptz", updated_at: "timestamptz", categorized_at: "timestamptz",
  bounced_at: "timestamptz",
  emails_sent: "int", opens: "int", replies: "int", bounces: "int",
  unique_replies: "int", unique_opens: "int", is_bounced: "boolean",
};
const UPSERT_SQL = `
  INSERT INTO leads (${COLS.join(", ")})
  SELECT ${COLS.map((c, i) => `unnest($${i + 1}::${CASTS[c] ?? "text"}[])`).join(", ")}
  ON CONFLICT (email) DO UPDATE SET
    ${COLS.filter((c) => c !== "email").map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`;

async function fetchExisting(emails) {
  const { rows } = await q(`
    SELECT email, is_bounced, bounce_type, location_status, ${MERGE_COLS.join(", ")}
    FROM leads WHERE email = ANY($1::text[])`, [emails]);
  return new Map(rows.map((r) => [r.email, r]));
}

async function upsertBatch(leads) {
  // last-in-batch wins for duplicate emails inside one file chunk
  const dedup = new Map(leads.map((l) => [l.email, l]));
  // Sorted so every parallel importer acquires row locks in the SAME order.
  const emails = [...dedup.keys()].sort();
  const existing = await fetchExisting(emails);
  const merged = emails.map((e) => mergeWithExisting(dedup.get(e), existing.get(e)));
  if (DRY) return { updated: [...existing.keys()].length, inserted: emails.length - existing.size };
  for (let i = 0; i < merged.length; i += CHUNK) {
    const b = merged.slice(i, i + CHUNK);
    await q(UPSERT_SQL, COLS.map((c) => b.map((r) => r[c] ?? null)));
  }
  return { updated: existing.size, inserted: emails.length - existing.size };
}

// ── streaming run ──
const { parse: parseStream } = await import("csv-parse");
console.log(`importing ${file} -> instance ${instance}${DRY ? " [dry-run]" : ""}`);
const t0 = Date.now();
let headers = null, idx = null;
let batch = [], seen = 0, updated = 0, inserted = 0, skipped = 0;

const parser = fs.createReadStream(file).pipe(parseStream({
  skip_empty_lines: true, relax_quotes: true, relax_column_count: true,
}));
async function flush() {
  if (!batch.length) return;
  const b = batch; batch = [];
  const r = await upsertBatch(b);
  updated += r.updated; inserted += r.inserted;
  const rate = Math.round(seen / ((Date.now() - t0) / 1000));
  process.stdout.write(`\r  rows=${seen} updated=${updated} inserted=${inserted} skipped=${skipped} (${rate}/s)`);
}
try {
  for await (const row of parser) {
    if (!headers) {
      headers = row; idx = {};
      headers.forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
      continue;
    }
    seen++;
    if (seen > LIMIT) break;
    const lead = normalizeBisonRow(row, idx);
    if (!lead) { skipped++; continue; }
    batch.push(lead);
    if (batch.length >= 5000) await flush();
  }
  await flush();
} catch (err) {
  await flush().catch(() => {});
  const csvTruncation = typeof err.code === "string" && err.code.startsWith("CSV_");
  if (csvTruncation) {
    console.warn(`\nWARNING: ${file} is truncated at the tail (${err.code}) — kept every complete record before it.`);
  } else {
    // DB/other failure: the file is NOT fully imported. Exit non-zero so the
    // runner reports it instead of logging a false success.
    console.error(`\nFAILED ${file} after ${seen} rows: ${err.code ?? ""} ${err.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}
console.log(`\ndone ${file}: rows=${seen} updated=${updated} inserted=${inserted} skipped=${skipped} in ${Math.round((Date.now() - t0) / 60000)}m`);
await pool.end();
