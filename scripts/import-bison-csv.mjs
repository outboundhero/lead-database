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
import { parse } from "csv-parse/sync";
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
  if (cv.city) lead.city = cv.city;
  if (cv.state) lead.state = normalizeState(cv.state) ?? cv.state;
  if (cv.domain) lead.domain = cv.domain;
  if (cv.address) lead.address = cv.address;
  if (cv.question) lead.question = cv.question;
  if (cv["company phone"]) lead.company_phone = cv["company phone"];
  if (cv["google maps url"]) lead.google_maps_url = cv["google maps url"];
  const ca = get("created_at"), ua = get("updated_at");
  if (ca) lead.created_at = ca;
  if (ua) lead.updated_at = ua;
  lead.source = "Email Bison";
  // Always set is_bounced explicitly — PostgREST bulk upsert unions keys across a
  // chunk and writes NULL (not DEFAULT) for rows missing the key, which would
  // violate the NOT NULL constraint when any row in the chunk is bounced.
  lead.is_bounced = bounces > 0;
  if (bounces > 0) { lead.bounce_source = "emailbison_csv"; lead.bounced_at = new Date().toISOString(); }
  lead.email_type = detectEmailType({ email, first_name: fn, last_name: ln, job_title: ti });
  return lead;
}

// ── run ──────────────────────────────────────────────────────────────────
const raw = readFileSync(file, "utf8");
const rows = parse(raw, { skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
const headers = rows[0];
const idx = {}; headers.forEach((h, i) => { idx[h.trim().toLowerCase()] = i; });
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

let upserted = 0, errors = 0;
for (let i = 0; i < unique.length; i += CHUNK) {
  const chunk = unique.slice(i, i + CHUNK);
  const { error } = await supabase.from("leads").upsert(chunk, { onConflict: "email" });
  if (error) { errors += chunk.length; console.error(`  chunk ${i}: ${error.message}`); }
  else upserted += chunk.length;
  process.stdout.write(`\r  upserted ${upserted}/${unique.length}  (errors ${errors})`);
}
console.log(`\nDone. Upserted ${upserted}, errors ${errors}.`);
