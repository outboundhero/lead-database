#!/usr/bin/env node
import "dotenv/config";

/**
 * Import per-client Clay category CSVs into the leads table.
 *
 * Input is a FOLDER of CSVs, ONE PER CLIENT. The FILENAME (minus extension) is
 * the client tag — e.g. "OH.csv" -> tag "OH".
 *
 * For each row in each file:
 *   - Match to an existing lead by lead id when a column holds one of our UUIDs,
 *     otherwise by email (lowercased). Unmatched rows are counted + skipped.
 *   - For matched leads, set category / subcategory / additional_category from
 *     the CSV (header names are matched liberally) with:
 *       category_source   = 'clay'  (see CHECK note below)
 *       category_confidence = 1
 *       categorized_at    = now()
 *     A lead whose category_source = 'manual' is NEVER overwritten (its category
 *     bundle is left untouched — it still gets the client tag).
 *   - Append the client tag (the filename) to leads.tags (comma-joined,
 *     de-duplicated case-insensitively).
 *
 * category_source CHECK: the live constraint (leads_category_source_check) only
 * allows keyword|ai|manual|bison. Until the ALTER in contract_notes is applied,
 * this script auto-detects that 'clay' is rejected and falls back to writing
 * category_source = 'bison' (an allowed value) so imports still succeed. Once the
 * ALTER lands it writes 'clay' automatically — no code change needed.
 *
 * Usage:
 *   node scripts/import-clay-categories.mjs <folder>
 *   node scripts/import-clay-categories.mjs <folder> --dry-run
 *   node scripts/import-clay-categories.mjs <folder> --tag-only-if-matched
 *
 * Flags:
 *   --dry-run              Parse + match only; no DB writes.
 *   --tag-only-if-matched  Tag-only pass: for matched leads, ONLY append the
 *                          client tag; do NOT write any category fields.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, extname, basename } from "path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--"));
if (!folder) {
  console.error("Usage: node scripts/import-clay-categories.mjs <folder> [--dry-run] [--tag-only-if-matched]");
  process.exit(1);
}
const DRY = args.includes("--dry-run");
const TAG_ONLY = args.includes("--tag-only-if-matched");
const CHUNK = 500;
const FALLBACK_SOURCE = "bison"; // allowed by the current CHECK; see header

// ── header + row helpers ─────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clean = (v) => {
  if (v == null) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  const low = t.toLowerCase();
  return low === "null" || low === "n/a" || low === "none" ? undefined : t;
};

// Column groups (liberal about header naming; matched case-insensitively).
const ID_HEADERS = ["id", "lead_id", "lead id", "uuid", "lead uuid", "lead_uuid"];
const EMAIL_HEADERS = ["email", "email address", "email_address", "work email", "work_email"];
const CATEGORY_HEADERS = ["category", "business category", "business_category"];
const SUBCATEGORY_HEADERS = ["subcategory", "sub category", "sub_category"];
const ADDITIONAL_HEADERS = ["additional category", "additional_category", "additional categories", "additional_categories"];

function buildIndex(headers) {
  const idx = {};
  headers.forEach((h, i) => { idx[String(h).trim().toLowerCase()] = i; });
  const first = (names) => { for (const n of names) if (idx[n] !== undefined) return idx[n]; return undefined; };
  return {
    idCols: ID_HEADERS.map((n) => idx[n]).filter((i) => i !== undefined),
    emailCol: first(EMAIL_HEADERS),
    categoryCol: first(CATEGORY_HEADERS),
    subcategoryCol: first(SUBCATEGORY_HEADERS),
    additionalCol: first(ADDITIONAL_HEADERS),
    allCols: headers.length,
  };
}

// Extract match key (uuid preferred) + category values for one row.
function normalizeRow(row, ix) {
  // Only a value in an EXPLICIT id column counts as our lead id — never scan the
  // whole row (Clay CSVs carry Clay's own record uuids in arbitrary columns,
  // which would mis-match). Email is always kept as the primary/fallback key.
  let leadId;
  for (const c of ix.idCols) {
    const v = clean(row[c]);
    if (v && UUID_RE.test(v)) { leadId = v.toLowerCase(); break; }
  }
  const email = ix.emailCol !== undefined ? clean(row[ix.emailCol])?.toLowerCase() : undefined;
  if (!leadId && !email) return null; // nothing to match on

  const category = ix.categoryCol !== undefined ? clean(row[ix.categoryCol]) : undefined;
  const subcategory = ix.subcategoryCol !== undefined ? clean(row[ix.subcategoryCol]) : undefined;
  const additional = ix.additionalCol !== undefined ? clean(row[ix.additionalCol]) : undefined;
  return { leadId, email, category, subcategory, additional };
}

// Merge a client tag into an existing comma-joined tags string (case-insensitive
// de-dup; preserves existing casing/order). Returns null if already present.
function appendTag(existingTags, tag) {
  const parts = (existingTags ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const lowered = new Set(parts.map((p) => p.toLowerCase()));
  if (lowered.has(tag.toLowerCase())) return null;
  parts.push(tag);
  return parts.join(",");
}

// ── streaming CSV parse w/ truncation recovery (mirrors import-bison-csv.mjs) ─
const PARSE_OPTS = { skip_empty_lines: true, relax_quotes: true, relax_column_count: true };
async function parseRecovering(text, label) {
  const { parse: parseStream } = await import("csv-parse");
  const records = [];
  await new Promise((resolve, reject) => {
    const parser = parseStream(PARSE_OPTS);
    const drain = () => { let r; try { while ((r = parser.read()) !== null) records.push(r); } catch { /* buffer already errored */ } };
    parser.on("readable", drain);
    parser.on("error", (err) => {
      drain();
      if (err.code === "CSV_QUOTE_NOT_CLOSED" || err.code === "CSV_RECORD_INCONSISTENT_FIELDS_LENGTH") {
        console.warn(`WARNING: ${label} is truncated/corrupt at the tail (${err.code}) — keeping the ${records.length} complete records parsed before the error.`);
        resolve();
      } else reject(err);
    });
    parser.on("end", resolve);
    parser.write(text);
    parser.end();
  });
  return records;
}

// ── resolve the category_source value against the live CHECK constraint ──────
async function resolveSource() {
  if (!process.env.DATABASE_URL) {
    console.warn("No DATABASE_URL — cannot probe category_source CHECK; assuming 'clay' is allowed.");
    return { source: "clay", fallback: false };
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='leads'::regclass AND conname='leads_category_source_check'"
    );
    const def = rows[0]?.def ?? "";
    if (!def || def.includes("'clay'")) return { source: "clay", fallback: false };
    console.warn(
      `NOTE: leads_category_source_check does NOT allow 'clay' yet — writing category_source='${FALLBACK_SOURCE}' instead.\n` +
      `      Apply the ALTER in this script's header/contract_notes to enable 'clay'.`
    );
    return { source: FALLBACK_SOURCE, fallback: true };
  } catch (e) {
    console.warn(`constraint probe failed (${e.message}); assuming 'clay' is allowed.`);
    return { source: "clay", fallback: false };
  } finally {
    await pool.end();
  }
}

// ── per-chunk: fetch existing leads, compute + apply targeted updates ────────
async function fetchExisting(chunk) {
  const byId = new Map();   // id -> row
  const byEmail = new Map(); // email -> row
  const ids = [...new Set(chunk.filter((r) => r.leadId).map((r) => r.leadId))];
  // Fetch emails for ALL rows that carry one (not just id-less rows) so a lead
  // id that doesn't resolve can still match by email.
  const emails = [...new Set(chunk.filter((r) => r.email).map((r) => r.email))];
  const SEL = "id,email,category,subcategory,additional_category,category_source,tags";
  for (let i = 0; i < ids.length; i += 150) {
    const slice = ids.slice(i, i + 150);
    const { data, error } = await supabase.from("leads").select(SEL).in("id", slice);
    if (error) throw new Error(`existing-by-id fetch failed: ${error.message}`);
    for (const row of data ?? []) byId.set(row.id, row);
  }
  for (let i = 0; i < emails.length; i += 150) {
    const slice = emails.slice(i, i + 150);
    const { data, error } = await supabase.from("leads").select(SEL).in("email", slice);
    if (error) throw new Error(`existing-by-email fetch failed: ${error.message}`);
    for (const row of data ?? []) byEmail.set(row.email, row);
  }
  return { byId, byEmail };
}

async function main() {
  // Resolve the folder + client-tagged CSV files.
  let st;
  try { st = statSync(folder); } catch { console.error(`Folder not found: ${folder}`); process.exit(1); }
  if (!st.isDirectory()) { console.error(`Not a folder: ${folder}`); process.exit(1); }
  const files = readdirSync(folder).filter((f) => extname(f).toLowerCase() === ".csv").sort();
  if (files.length === 0) { console.error(`No .csv files in ${folder}`); process.exit(1); }

  const { source: CATEGORY_SOURCE, fallback } = DRY
    ? { source: "clay", fallback: false }
    : await resolveSource();

  console.log(`Folder: ${folder}`);
  console.log(`Files: ${files.length}  |  mode: ${DRY ? "DRY-RUN" : "WRITE"}${TAG_ONLY ? " (tag-only)" : ""}  |  category_source: ${CATEGORY_SOURCE}${fallback ? " (fallback)" : ""}`);

  let totMatched = 0, totSkipped = 0, totCategorized = 0, totManualProtected = 0, totTagged = 0, totErrors = 0;

  for (const file of files) {
    const tag = basename(file, extname(file)).trim();
    if (!tag) { console.warn(`Skipping file with empty tag: ${file}`); continue; }
    const path = join(folder, file);
    const raw = readFileSync(path, "utf8");
    const rows = await parseRecovering(raw, file);
    if (rows.length < 2) { console.warn(`  ${file}: no data rows — skipping.`); continue; }
    const headers = rows[0];
    const ix = buildIndex(headers);
    if (ix.emailCol === undefined && ix.idCols.length === 0) {
      console.warn(`  ${file}: no id or email column found — skipping (headers: ${headers.join(", ")}).`);
      continue;
    }

    // Normalize + dedup within-file by match key (keep last).
    const byKey = new Map();
    let noKey = 0;
    for (const r of rows.slice(1)) {
      const n = normalizeRow(r, ix);
      if (!n) { noKey++; continue; }
      byKey.set(n.leadId ? `id:${n.leadId}` : `em:${n.email}`, n);
    }
    const recs = [...byKey.values()];
    console.log(`  ${file}  tag="${tag}"  rows=${rows.length - 1}  usable=${recs.length}${noKey ? `  (no-key ${noKey})` : ""}`);

    let fMatched = 0, fSkipped = 0, fCat = 0, fManual = 0, fTag = 0, fErr = 0;
    for (let i = 0; i < recs.length; i += CHUNK) {
      const chunk = recs.slice(i, i + CHUNK);
      let existing;
      try { existing = await fetchExisting(chunk); }
      catch (err) { console.error(`    chunk ${i}: ${err.message} — skipping chunk.`); fErr += chunk.length; continue; }

      for (const rec of chunk) {
        const ex = (rec.leadId && existing.byId.get(rec.leadId)) || (rec.email && existing.byEmail.get(rec.email));
        if (!ex) { fSkipped++; continue; }
        fMatched++;

        const update = {};
        // Category (skipped in tag-only mode, and never over a manual lead).
        const wantsCategory = !TAG_ONLY && (rec.category || rec.subcategory || rec.additional);
        if (wantsCategory) {
          if (ex.category_source === "manual") {
            fManual++;
          } else {
            // Only write fields that actually CHANGE (avoids rewriting identical
            // data + bumping categorized_at on reruns).
            if (rec.category && rec.category !== ex.category) update.category = rec.category;
            if (rec.subcategory && rec.subcategory !== ex.subcategory) update.subcategory = rec.subcategory;
            if (rec.additional && rec.additional !== ex.additional_category) update.additional_category = rec.additional;
            // Stamp clay provenance only when clay actually supplies a CATEGORY —
            // a row with only a subcategory must not relabel an existing bison
            // category as clay.
            if (rec.category && rec.category !== ex.category) {
              update.category_source = CATEGORY_SOURCE;
              update.category_confidence = 1;
              update.categorized_at = new Date().toISOString();
            }
            if (Object.keys(update).length > 0) fCat++;
          }
        }
        // Tag append (always attempted for matched leads).
        const newTags = appendTag(ex.tags, tag);
        if (newTags !== null) { update.tags = newTags; fTag++; }

        if (Object.keys(update).length === 0) continue; // already tagged + nothing to categorize
        if (DRY) continue;
        const { error } = await supabase.from("leads").update(update).eq("id", ex.id);
        if (error) { fErr++; console.error(`    update ${ex.id}: ${error.message}`); }
      }
      process.stdout.write(`\r    ${file}: matched ${fMatched}, skipped ${fSkipped}, categorized ${fCat}, tagged ${fTag}, errors ${fErr}`);
    }
    process.stdout.write("\n");
    totMatched += fMatched; totSkipped += fSkipped; totCategorized += fCat;
    totManualProtected += fManual; totTagged += fTag; totErrors += fErr;
  }

  console.log("\n─────────────────────────────────────");
  console.log(`Matched leads:        ${totMatched}`);
  console.log(`Categorized (clay):   ${totCategorized}`);
  console.log(`Manual-protected:     ${totManualProtected}`);
  console.log(`Tags appended:        ${totTagged}`);
  console.log(`Unmatched (skipped):  ${totSkipped}`);
  console.log(`Errors:               ${totErrors}`);

  if (DRY) { console.log("\n--dry-run: no DB writes."); return; }

  // Keep the companies table + category cache in sync (best-effort).
  const PROPAGATE_BATCH = 200000;
  try {
    for (;;) {
      const { data: sync, error: syncErr } = await supabase.rpc("fn_sync_companies", { p_propagate_limit: PROPAGATE_BATCH });
      if (syncErr) { console.error("fn_sync_companies failed:", syncErr.message); break; }
      const s = sync?.[0] ?? {};
      console.log(`companies sync: inserted=${s.companies_inserted} seeded=${s.companies_seeded} propagated=${s.leads_propagated}`);
      if ((s.leads_propagated ?? 0) < PROPAGATE_BATCH) break;
    }
  } catch (e) {
    console.error("fn_sync_companies error (best-effort, ignored):", e.message);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
