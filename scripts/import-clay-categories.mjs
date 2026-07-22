#!/usr/bin/env node
import "dotenv/config";

/**
 * Import per-client Clay CSVs (category enrichment) into the leads table.
 *
 * Input is a FOLDER of Clay exports. There are TWO file schemas; BOTH feed the
 * same three destination fields (this mirrors the client's Email Bison custom
 * variable mapping):
 *
 *   destination field      | General file column      | People file column
 *   -----------------------|--------------------------|---------------------------
 *   category               | Category                 | Industry
 *   subcategory            | Sub-Category             | Company Short Description
 *   additional_category    | Additional Category      | Company SEO Description
 *   email (match key)      | General Email            | Use Work Email
 *
 * File type + client tag come from the FILENAME:
 *   (Copy-of-)?(General|People)-<TAG>-Default-View-export-<digits>.csv
 *   e.g. "General-ABM-Default-View-export-178...csv" -> type=general, tag=ABM.
 *   -#2 / -(2) tag suffixes are stripped (same client, split export).
 *   "Find-people-Table-..." files carry no client tag and are skipped.
 *
 * Per matched lead (matched by EMAIL only — never EB Lead ID, which is a Bison
 * id, not our uuid):
 *   - set category / subcategory / additional_category from the file's columns,
 *     ONLY for values that differ; category_source='clay', confidence=1,
 *     categorized_at=now(). A lead with category_source='manual' is never
 *     overwritten. Provenance is stamped only when the CATEGORY itself changes.
 *   - append the client tag to leads.tags (comma-joined, case-insensitive dedup).
 *   Unmatched rows are counted + skipped.
 * After all files, fn_sync_companies() propagates categories company-wide.
 *
 * Usage:
 *   node scripts/import-clay-categories.mjs <folder>
 *   node scripts/import-clay-categories.mjs <folder> --dry-run
 *   node scripts/import-clay-categories.mjs <folder> --tag-only-if-matched
 *   node scripts/import-clay-categories.mjs <folder> --only=ABM,RFS   # subset of tags
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join, extname } from "path";
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
  console.error("Usage: node scripts/import-clay-categories.mjs <folder> [--dry-run] [--tag-only-if-matched] [--only=TAG,TAG]");
  process.exit(1);
}
const DRY = args.includes("--dry-run");
const TAG_ONLY = args.includes("--tag-only-if-matched");
const ONLY = (() => {
  const a = args.find((x) => x.startsWith("--only="));
  return a ? new Set(a.slice(7).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)) : null;
})();
const CHUNK = 500;
const FALLBACK_SOURCE = "bison"; // used only if the CHECK still rejects 'clay'

const clean = (v) => {
  if (v == null) return undefined;
  const t = String(v).trim();
  if (!t) return undefined;
  const low = t.toLowerCase();
  return low === "null" || low === "n/a" || low === "none" ? undefined : t;
};

// ── filename -> { type, tag } ────────────────────────────────────────────────
const FILE_RE = /^(?:copy-of-)?(general|people|find-people)-(.+?)-default-view-export-\d+$/i;
function parseFile(name) {
  const base = name.replace(/\.csv$/i, "");
  const m = base.match(FILE_RE);
  if (!m) return null;
  const type = /people/i.test(m[1]) ? "people" : "general";
  // strip -#2 / -(2) split-export suffixes, normalize spacing/casing
  const tag = m[2].replace(/-#\d+$/, "").replace(/-\(\d+\)$/, "").trim().toUpperCase();
  if (!tag || tag === "TABLE") return { type, tag: null }; // Find-people-Table etc.
  return { type, tag };
}

// ── schema-aware column resolution ───────────────────────────────────────────
// Destination fields are the SAME for both types; only the source header differs.
const MAP = {
  general: { email: ["general email", "email"], category: ["category"], subcategory: ["sub-category", "subcategory", "sub category"], additional: ["additional category", "additional-category", "additional_category"] },
  people: { email: ["use work email", "valid work email", "final validated email", "email"], category: ["industry"], subcategory: ["company short description"], additional: ["company seo description"] },
};
function buildIndex(headers, type) {
  const idx = {};
  headers.forEach((h, i) => { idx[String(h).trim().toLowerCase()] = i; });
  const first = (names) => { for (const n of names) if (idx[n] !== undefined) return idx[n]; return undefined; };
  const m = MAP[type];
  return {
    emailCol: first(m.email),
    categoryCol: first(m.category),
    subcategoryCol: first(m.subcategory),
    additionalCol: first(m.additional),
  };
}
function normalizeRow(row, ix) {
  const email = ix.emailCol !== undefined ? clean(row[ix.emailCol])?.toLowerCase() : undefined;
  if (!email) return null;
  return {
    email,
    category: ix.categoryCol !== undefined ? clean(row[ix.categoryCol]) : undefined,
    subcategory: ix.subcategoryCol !== undefined ? clean(row[ix.subcategoryCol]) : undefined,
    additional: ix.additionalCol !== undefined ? clean(row[ix.additionalCol]) : undefined,
  };
}

// Merge a client tag into a comma-joined tags string (case-insensitive dedup).
// Returns null if already present.
function appendTag(existingTags, tag) {
  const parts = (existingTags ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.some((p) => p.toLowerCase() === tag.toLowerCase())) return null;
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
    const drain = () => { let r; try { while ((r = parser.read()) !== null) records.push(r); } catch { /* buffer errored */ } };
    parser.on("readable", drain);
    parser.on("error", (err) => {
      drain();
      if (err.code === "CSV_QUOTE_NOT_CLOSED" || err.code === "CSV_RECORD_INCONSISTENT_FIELDS_LENGTH") {
        console.warn(`  WARNING: ${label} truncated at tail (${err.code}) — kept ${records.length} records.`);
        resolve();
      } else reject(err);
    });
    parser.on("end", resolve);
    parser.write(text);
    parser.end();
  });
  return records;
}

async function resolveSource() {
  if (!process.env.DATABASE_URL) return { source: "clay", fallback: false };
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const { rows } = await pool.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='leads'::regclass AND conname='leads_category_source_check'"
    );
    const def = rows[0]?.def ?? "";
    if (!def || def.includes("'clay'")) return { source: "clay", fallback: false };
    console.warn(`NOTE: category_source CHECK rejects 'clay' — writing '${FALLBACK_SOURCE}' instead.`);
    return { source: FALLBACK_SOURCE, fallback: true };
  } catch (e) {
    console.warn(`constraint probe failed (${e.message}); assuming 'clay' allowed.`);
    return { source: "clay", fallback: false };
  } finally {
    await pool.end();
  }
}

async function fetchExistingByEmail(emails) {
  const byEmail = new Map();
  const SEL = "id,email,category,subcategory,additional_category,category_source,tags";
  for (let i = 0; i < emails.length; i += 150) {
    const slice = emails.slice(i, i + 150);
    const { data, error } = await supabase.from("leads").select(SEL).in("email", slice);
    if (error) throw new Error(`existing fetch failed: ${error.message}`);
    for (const row of data ?? []) byEmail.set(row.email, row);
  }
  return byEmail;
}

async function main() {
  let st;
  try { st = statSync(folder); } catch { console.error(`Folder not found: ${folder}`); process.exit(1); }
  if (!st.isDirectory()) { console.error(`Not a folder: ${folder}`); process.exit(1); }
  const allFiles = readdirSync(folder).filter((f) => extname(f).toLowerCase() === ".csv").sort();
  if (allFiles.length === 0) { console.error(`No .csv files in ${folder}`); process.exit(1); }

  const { source: CATEGORY_SOURCE, fallback } = DRY ? { source: "clay", fallback: false } : await resolveSource();
  console.log(`Folder: ${folder}`);
  console.log(`Files: ${allFiles.length}  |  mode: ${DRY ? "DRY-RUN (no writes)" : "WRITE"}${TAG_ONLY ? " (tag-only)" : ""}  |  category_source: ${CATEGORY_SOURCE}${fallback ? " (fallback)" : ""}${ONLY ? `  |  only: ${[...ONLY].join(",")}` : ""}`);

  const tot = { files: 0, skippedFiles: 0, rows: 0, matched: 0, unmatched: 0, categorized: 0, manual: 0, tagged: 0, errors: 0 };
  const perTag = new Map();

  for (const file of allFiles) {
    const meta = parseFile(file);
    if (!meta) { console.warn(`  ? ${file}: unrecognized name — skipped.`); tot.skippedFiles++; continue; }
    if (!meta.tag) { tot.skippedFiles++; continue; } // Find-people-Table etc.
    if (ONLY && !ONLY.has(meta.tag)) continue;

    const raw = readFileSync(join(folder, file), "utf8");
    const rows = await parseRecovering(raw, file);
    if (rows.length < 2) { console.warn(`  ${file}: no data rows — skipped.`); tot.skippedFiles++; continue; }
    const ix = buildIndex(rows[0], meta.type);
    if (ix.emailCol === undefined) {
      console.warn(`  ${file} [${meta.type}]: no email column (${MAP[meta.type].email.join("/")}) — skipped.`);
      tot.skippedFiles++; continue;
    }
    const hasCat = ix.categoryCol !== undefined;

    // Normalize + dedup within-file by email (keep last).
    const byEmail = new Map();
    let noKey = 0;
    for (const r of rows.slice(1)) {
      const n = normalizeRow(r, ix);
      if (!n) { noKey++; continue; }
      byEmail.set(n.email, n);
    }
    const recs = [...byEmail.values()];
    tot.files++; tot.rows += rows.length - 1;

    let fMatched = 0, fUnmatched = 0, fCat = 0, fManual = 0, fTag = 0, fErr = 0;
    for (let i = 0; i < recs.length; i += CHUNK) {
      const chunk = recs.slice(i, i + CHUNK);
      let existing;
      try { existing = await fetchExistingByEmail([...new Set(chunk.map((r) => r.email))]); }
      catch (err) { console.error(`    chunk ${i}: ${err.message} — skipping chunk.`); fErr += chunk.length; continue; }

      for (const rec of chunk) {
        const ex = existing.get(rec.email);
        if (!ex) { fUnmatched++; continue; }
        fMatched++;

        const update = {};
        if (!TAG_ONLY && (rec.category || rec.subcategory || rec.additional)) {
          if (ex.category_source === "manual") {
            fManual++;
          } else {
            if (rec.category && rec.category !== ex.category) update.category = rec.category;
            if (rec.subcategory && rec.subcategory !== ex.subcategory) update.subcategory = rec.subcategory;
            if (rec.additional && rec.additional !== ex.additional_category) update.additional_category = rec.additional;
            // Stamp clay provenance only when the CATEGORY itself changes.
            if (rec.category && rec.category !== ex.category) {
              update.category_source = CATEGORY_SOURCE;
              update.category_confidence = 1;
              update.categorized_at = new Date().toISOString();
            }
            if (Object.keys(update).length > 0) fCat++;
          }
        }
        const newTags = appendTag(ex.tags, meta.tag);
        if (newTags !== null) { update.tags = newTags; fTag++; }

        if (Object.keys(update).length === 0) continue;
        if (DRY) continue;
        const { error } = await supabase.from("leads").update(update).eq("id", ex.id);
        if (error) { fErr++; console.error(`    update ${ex.id}: ${error.message}`); }
      }
      process.stdout.write(`\r  ${file} [${meta.type}] tag=${meta.tag}: matched ${fMatched}, unmatched ${fUnmatched}, categorized ${fCat}, tagged ${fTag}${fErr ? `, errors ${fErr}` : ""}`);
    }
    process.stdout.write("\n");
    if (!hasCat && !TAG_ONLY) console.warn(`    (no category column in this ${meta.type} file — tag-only for these rows)`);

    const agg = perTag.get(meta.tag) ?? { matched: 0, categorized: 0, tagged: 0 };
    agg.matched += fMatched; agg.categorized += fCat; agg.tagged += fTag;
    perTag.set(meta.tag, agg);
    tot.matched += fMatched; tot.unmatched += fUnmatched; tot.categorized += fCat;
    tot.manual += fManual; tot.tagged += fTag; tot.errors += fErr;
  }

  console.log("\n─────────────────────────────────────");
  console.log(`Files processed:      ${tot.files}  (skipped ${tot.skippedFiles})`);
  console.log(`Data rows:            ${tot.rows}`);
  console.log(`Matched leads:        ${tot.matched}`);
  console.log(`Unmatched (skipped):  ${tot.unmatched}`);
  console.log(`Categorized (clay):   ${tot.categorized}`);
  console.log(`Manual-protected:     ${tot.manual}`);
  console.log(`Tags appended:        ${tot.tagged}`);
  console.log(`Errors:               ${tot.errors}`);
  console.log(`Client tags touched:  ${perTag.size}`);

  if (!DRY && tot.categorized > 0) {
    console.log("\nPropagating company categories (fn_sync_companies)…");
    const { data, error } = await supabase.rpc("fn_sync_companies", { p_propagate_limit: 200000 });
    if (error) console.error("fn_sync_companies failed:", error.message);
    else console.log("  sync:", JSON.stringify(data?.[0] ?? data));
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
