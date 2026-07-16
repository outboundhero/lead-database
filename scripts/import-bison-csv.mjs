#!/usr/bin/env node
import "dotenv/config";

/**
 * Bulk-import an Email Bison CSV export into the leads table.
 *
 * Mirrors src/lib/uploads/parse-bison.ts exactly. Use this for large imports
 * (the in-app uploader does per-row existence checks and is slow past a few
 * thousand rows). Upserts on email so re-running is safe.
 *
 * Usage:
 *   node scripts/import-bison-csv.mjs ~/Downloads/outboundclean_leads_2026-06-12.csv
 *   node scripts/import-bison-csv.mjs <file> --limit=100      # test slice
 *   node scripts/import-bison-csv.mjs <file> --dry-run        # parse only
 */

import { readFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
if (!file) { console.error("Usage: node scripts/import-bison-csv.mjs <file>"); process.exit(1); }
const getOpt = (n, d) => { const a = args.find((x) => x.startsWith(`--${n}=`)); return a ? Number(a.split("=")[1]) : d; };
const LIMIT = getOpt("limit", Infinity);
const DRY = args.includes("--dry-run");
// --fresh-table: skip the per-chunk merge reads when the leads table is known
// empty (first import). NEVER use on a table that already has enriched rows.
const FRESH = args.includes("--fresh-table");
const CHUNK = 500;

// ── parser (mirrors parse-bison.ts) ──────────────────────────────────────
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
  if (!email) return null;
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
  const iu = get("instance_url"); if (iu) lead.instance_url = iu;
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
  // Source uses "there"/"null"/"n/a" as placeholders for missing values — filter them.
  const clean = (v) => { if(!v) return undefined; const low=v.trim().toLowerCase(); return (!v.trim()||low==="there"||low==="null"||low==="n/a"||low==="none")?undefined:v.trim(); };
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
  // Bison-native category enrichment (mirrors src/lib/uploads/parse-bison.ts)
  const pick = (...keys) => { for (const k of keys) { const v = clean(cv[k]); if (v) return v; } return undefined; };
  const cvCategory = pick("category", "business category");
  const cvSubcategory = pick("subcategory", "sub category", "sub_category");
  const cvAdditional = pick("additional category", "additional_category", "additional categories");
  if (cvCategory) { lead.category = cvCategory; lead.category_source = "bison"; lead.category_confidence = 1; lead.categorized_at = new Date().toISOString(); }
  if (cvSubcategory) lead.subcategory = cvSubcategory;
  if (cvAdditional) lead.additional_category = cvAdditional;
  const ca = get("created_at"), ua = get("updated_at");
  if (ca) lead.created_at = ca;
  if (ua) lead.updated_at = ua;
  lead.source = "Email Bison";
  lead.is_bounced = bounces > 0;
  if (bounces > 0) { lead.bounce_source = "emailbison_csv"; lead.bounced_at = new Date().toISOString(); }
  lead.email_type = detectEmailType({ email, first_name: fn, last_name: ln, job_title: ti });
  return lead;
}

// ── merge-safe upsert shape ──────────────────────────────────────────────
// PostgREST bulk upsert builds columns= from the UNION of keys across the
// chunk and writes NULL for rows missing a key — so a sparse row next to a
// rich row would NULL-out the rich columns on existing leads. Defense: every
// row is padded to the SAME key set (template below), and values for keys the
// CSV doesn't provide are back-filled from the existing DB row so an upsert
// can never erase prior enrichment.
const MERGE_COLS = [
  "first_name", "last_name", "title", "company", "notes",
  "bison_lead_id", "workspace_id", "workspace_name", "instance_url", "bison_status",
  "tags", "esp", "city", "state", "domain", "address", "postal_code", "street",
  "question", "company_phone", "google_maps_url",
  "category", "subcategory", "additional_category",
  "category_source", "category_confidence", "categorized_at",
  "created_at", "updated_at", "bounce_source", "bounced_at",
];
// Never in the payload: bounce_type, bounce_checked_at, validation_* — the
// importer has no business writing those, and absent keys are never touched.

function mergeWithExisting(lead, existing) {
  const out = {
    email: lead.email,
    emails_sent: lead.emails_sent, opens: lead.opens, replies: lead.replies,
    unique_replies: lead.unique_replies, unique_opens: lead.unique_opens,
    bounces: lead.bounces, source: lead.source, email_type: lead.email_type,
  };
  for (const k of MERGE_COLS) out[k] = lead[k] ?? existing?.[k] ?? null;

  // created_at: the original row's timestamp is history — never regress it.
  // For brand-new leads an explicit NULL would suppress the column default,
  // so synthesize the timestamps instead.
  if (existing?.created_at) out.created_at = existing.created_at;
  else if (!out.created_at) out.created_at = new Date().toISOString();
  if (!out.updated_at) out.updated_at = out.created_at;

  // Category: 'manual' assignments outrank a CSV re-import; otherwise a CSV
  // category (bison source) wins, else the existing bundle survives via ??.
  if (existing?.category && existing.category_source === "manual") {
    out.category = existing.category;
    out.subcategory = existing.subcategory ?? null;
    out.additional_category = existing.additional_category ?? null;
    out.category_source = existing.category_source;
    out.category_confidence = existing.category_confidence ?? null;
    out.categorized_at = existing.categorized_at ?? null;
  }

  // is_bounced: never downgrade (mirrors src/app/api/uploads/process/route.ts).
  // Exception: bounce-worker recoveries (bounce_type='sender', is_bounced=false)
  // stay recovered — the CSV bounce counter is the SAME bounce the worker
  // already classified as sender-side, not a new event.
  const recovered = existing && existing.is_bounced === false && existing.bounce_type === "sender";
  if (recovered) {
    out.is_bounced = false;
    out.bounce_source = existing.bounce_source ?? null;
    out.bounced_at = existing.bounced_at ?? null;
  } else {
    out.is_bounced = (existing?.is_bounced ?? false) || lead.is_bounced;
    // Keep the ORIGINAL bounce timestamp/source — resetting bounced_at on every
    // re-import forces bounce-worker to re-check the entire bounced backlog.
    if (existing?.bounced_at) { out.bounced_at = existing.bounced_at; out.bounce_source = existing.bounce_source ?? out.bounce_source; }
  }
  return out;
}

async function fetchExisting(emails) {
  const found = new Map();
  const SEL = "email,is_bounced,bounce_type," + MERGE_COLS.join(",");
  // Sub-batch the IN() list — 500 emails in one GET query string overflows URL limits.
  for (let i = 0; i < emails.length; i += 150) {
    const slice = emails.slice(i, i + 150);
    const { data, error } = await supabase.from("leads").select(SEL).in("email", slice);
    if (error) throw new Error(`existing-rows fetch failed: ${error.message}`);
    for (const row of data ?? []) found.set(row.email, row);
  }
  return found;
}

// ── run ──────────────────────────────────────────────────────────────────
const raw = readFileSync(file, "utf8");
const PARSE_OPTS = { skip_empty_lines: true, relax_quotes: true, relax_column_count: true };

// Streaming parse: emits each complete record as it goes, so a file truncated
// mid-record (cut off mid-download) yields every record BEFORE the bad tail
// instead of failing the whole file. The old line-number recovery was wrong:
// csv-parse reports the line at EOF, not where the dangling quote opened, and
// a truncated quoted field swallows every following line into one record.
async function parseRecovering(text) {
  const { parse: parseStream } = await import("csv-parse");
  const records = [];
  await new Promise((resolve, reject) => {
    const parser = parseStream(PARSE_OPTS);
    const drain = () => { let r; try { while ((r = parser.read()) !== null) records.push(r); } catch { /* buffer already errored */ } };
    parser.on("readable", drain);
    parser.on("error", (err) => {
      drain(); // flush records parsed before the error
      if (err.code === "CSV_QUOTE_NOT_CLOSED" || err.code === "CSV_RECORD_INCONSISTENT_FIELDS_LENGTH") {
        console.warn(`WARNING: ${file} is truncated/corrupt at the tail (${err.code}) — keeping the ${records.length} complete records parsed before the error.`);
        resolve();
      } else reject(err);
    });
    parser.on("end", resolve);
    parser.write(text);
    parser.end();
  });
  return records;
}
let rows = await parseRecovering(raw);
if (rows.length === 0) { console.error("No parseable records in file — aborting."); process.exit(1); }
const headers = rows[0];
const idx = {}; headers.forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });

// A file truncated mid-line OUTSIDE a quoted field parses without error but
// leaves a final short/partial record — drop it rather than import a
// truncated field value. Also drop any record shorter than the header row
// (relax_column_count lets them through silently).
if (!raw.endsWith("\n") && rows.length > 1 && rows[rows.length - 1].length < headers.length) {
  console.warn(`WARNING: dropping final partial record (file does not end with a newline).`);
  rows = rows.slice(0, -1);
}
const shortRows = rows.slice(1).filter((r) => r.length < headers.length).length;
if (shortRows > 0) console.warn(`WARNING: ${shortRows} records have fewer columns than the header (damaged rows) — importing with missing fields treated as empty.`);
console.log(`Headers: ${headers.length} cols. Data rows: ${rows.length - 1}`);

const dataRows = rows.slice(1, LIMIT === Infinity ? undefined : LIMIT + 1);
const leads = [];
let skipped = 0;
for (const r of dataRows) { const l = normalizeBisonRow(r, idx); if (l) leads.push(l); else skipped++; }

// Dedup within the file by email (keep last) so upsert doesn't choke on dup keys
const byEmail = new Map();
for (const l of leads) byEmail.set(l.email, l);
const unique = [...byEmail.values()];

const generalCount = unique.filter((l) => l.email_type === "general").length;
const bouncedCount = unique.filter((l) => l.is_bounced).length;
const espCount = unique.filter((l) => l.esp).length;
console.log(`Parsed ${leads.length} (skipped ${skipped} no-email). Unique emails: ${unique.length}`);
console.log(`  email_type: ${generalCount} general / ${unique.length - generalCount} personal`);
console.log(`  esp derived from tags: ${espCount}`);
console.log(`  bounced (bounces>0): ${bouncedCount}`);
console.log(`  sample:`, JSON.stringify(unique[0], null, 2));

if (DRY) { console.log("\n--dry-run: no DB writes."); process.exit(0); }

let upserted = 0, errors = 0, merged = 0;
for (let i = 0; i < unique.length; i += CHUNK) {
  const chunk = unique.slice(i, i + CHUNK);
  // Merge against existing rows so re-imports can never NULL-out enrichment
  // (see mergeWithExisting). --fresh-table skips the reads on a known-empty table.
  let existing = new Map();
  if (!FRESH) {
    try { existing = await fetchExisting(chunk.map((l) => l.email)); }
    catch (err) { console.error(`\n  chunk ${i}: ${err.message} — SKIPPING chunk (refusing to upsert without merge data)`); errors += chunk.length; continue; }
  }
  merged += existing.size;
  const payload = chunk.map((l) => mergeWithExisting(l, existing.get(l.email)));
  const { error } = await supabase.from("leads").upsert(payload, { onConflict: "email" });
  if (error) { errors += chunk.length; console.error(`  chunk ${i}: ${error.message}`); }
  else upserted += chunk.length;
  process.stdout.write(`\r  upserted ${upserted}/${unique.length}  (merged ${merged}, errors ${errors})`);
}
console.log(`\nDone. Upserted ${upserted} (${merged} merged with existing rows), errors ${errors}.`);

// Keep the companies table + category cache in sync (name+city+state identity;
// seeds company categories from Bison-provided lead categories). Propagation is
// batched — loop until a round propagates nothing.
const PROPAGATE_BATCH = 200000;
for (;;) {
  const { data: sync, error: syncErr } = await supabase.rpc("fn_sync_companies", { p_propagate_limit: PROPAGATE_BATCH });
  if (syncErr) { console.error("fn_sync_companies failed:", syncErr.message); break; }
  const s = sync[0];
  console.log(`companies sync: inserted=${s.companies_inserted} seeded=${s.companies_seeded} propagated=${s.leads_propagated}`);
  if ((s.leads_propagated ?? 0) < PROPAGATE_BATCH) break;
}
