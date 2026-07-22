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
// Bulk updates go through the pg pool — one statement per chunk instead of one
// HTTP round-trip per lead (the difference between hours and weeks at 2M rows).
const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, keepAlive: true, idleTimeoutMillis: 30000 })
  : null;
// An idle client's connection dropping emits 'error' on the pool; without this
// handler node-postgres crashes the whole process (this killed the first run).
pool?.on("error", (err) => console.warn(`  pool client error (ignored, will reconnect): ${err.message}`));

// Retry a query through the pool on transient connection errors.
async function poolQuery(text, params, tries = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      const transient = /ECONNRESET|termin|Connection terminated|timeout|socket|EPIPE|server closed/i.test(err.message || "");
      if (!transient || attempt >= tries) throw err;
      console.warn(`  transient DB error (attempt ${attempt}/${tries}): ${err.message} — retrying in ${attempt}s`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

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
// --skip-list=<path>: skip files whose basename is listed (resume after a crash).
const SKIP_FILES = (() => {
  const a = args.find((x) => x.startsWith("--skip-list="));
  if (!a) return null;
  try { return new Set(readFileSync(a.slice(12), "utf8").split(/\r?\n/).map((x) => x.trim()).filter(Boolean)); }
  catch { return null; }
})();
const CHUNK = 3000;
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
// Normalize the raw filename tag to the base CLIENT tag. Clay exports carry
// variant markers that are the SAME client: "(2)-IMC", "ABM-#2", "CCGCT-(2)",
// "FCS-(AI-ARK)", "CI-(Competitor-Clients-Pull)". SI_-<vertical> and Template
// are not clients.
// Clay filenames can't contain "&", so "&" clients are written with "and".
const TAG_ALIASES = { JPCANDA: "JPC&A" };
function normalizeTag(raw) {
  let t = raw;
  t = t.replace(/^\(\d+\)-/, "");        // leading split marker: (2)-IMC
  t = t.replace(/-\([^)]*\)/g, "");      // any -(...) : (2), (AI-ARK), (Competitor-Clients-Pull)
  t = t.replace(/-#\d+/g, "");           // -#2 batch marker
  t = t.replace(/^[-_]+|[-_]+$/g, "").trim().toUpperCase();
  return TAG_ALIASES[t] ?? t;
}
function parseFile(name) {
  const base = name.replace(/\.csv$/i, "");
  const m = base.match(FILE_RE);
  if (!m) return null;
  const type = /people/i.test(m[1]) ? "people" : "general";
  const tag = normalizeTag(m[2]);
  // Not a client: Find-people-Table, Template, or the SI_-<vertical> pulls.
  if (!tag || tag === "TABLE" || tag === "TEMPLATE" || tag.startsWith("SI_")) return { type, tag: null };
  return { type, tag };
}

// ── schema-aware column resolution ───────────────────────────────────────────
// Destination fields are the SAME for both types; only the source header differs.
// People files come in TWO schemas: newer clients (onboarded after ~2026-06-20)
// carry literal Category/Sub-Category/Additional Category columns (same as
// General); older People files use Industry / Company Short Description /
// Company SEO Description. Priority order handles both — the literal category
// columns win when present, else the older headers are used.
const MAP = {
  general: { email: ["general email", "email"], category: ["category"], subcategory: ["sub-category", "subcategory", "sub category"], additional: ["additional category", "additional-category", "additional_category"] },
  people: {
    email: ["use work email", "valid work email", "final validated email", "email"],
    category: ["category", "industry"],
    subcategory: ["sub-category", "subcategory", "sub category", "company short description"],
    additional: ["additional category", "additional-category", "additional_category", "company seo description"],
  },
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
// Some Clay cells leak raw LLM output: markdown ```json fences, backticks, and
// "category: <value>" key prefixes. Strip them down to the bare value.
function sanitizeCategory(v) {
  if (!v) return v;
  let t = String(v).replace(/```+\s*json/gi, "").replace(/```+/g, "").replace(/`/g, "");
  const m = t.match(/(?:additional[_ ]?category|sub[- ]?category|category)\s*:\s*([\s\S]+)/i);
  if (m) t = m[1];
  t = t.replace(/[{}\[\]"']/g, " ").replace(/\s+/g, " ").trim();
  return t || undefined;
}
function normalizeRow(row, ix) {
  const email = ix.emailCol !== undefined ? clean(row[ix.emailCol])?.toLowerCase() : undefined;
  if (!email) return null;
  return {
    email,
    category: ix.categoryCol !== undefined ? sanitizeCategory(clean(row[ix.categoryCol])) : undefined,
    subcategory: ix.subcategoryCol !== undefined ? sanitizeCategory(clean(row[ix.subcategoryCol])) : undefined,
    additional: ix.additionalCol !== undefined ? sanitizeCategory(clean(row[ix.additionalCol])) : undefined,
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
  if (!pool || emails.length === 0) return byEmail;
  // One indexed ANY() lookup per chunk via the pooler — far fewer, faster
  // round-trips than the Supabase REST layer's 150-row .in() batches.
  const { rows } = await poolQuery(
    `select id, email, category, subcategory, additional_category, category_source, tags
       from leads where email = any($1::text[])`,
    [emails]
  );
  for (const row of rows) byEmail.set(row.email, row);
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
    if (SKIP_FILES && SKIP_FILES.has(file)) { tot.skippedFiles++; continue; }

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

      // Compute final values client-side (we just fetched the current row), then
      // write the whole batch in ONE statement via unnest.
      const batch = []; // {id, category, subcategory, additional_category, category_source, category_confidence, categorized_at, tags}
      for (const rec of chunk) {
        const ex = existing.get(rec.email);
        if (!ex) { fUnmatched++; continue; }
        fMatched++;

        let changed = false;
        const fin = {
          id: ex.id,
          category: ex.category, subcategory: ex.subcategory,
          additional_category: ex.additional_category,
          category_source: ex.category_source, category_confidence: null,
          categorized_at: null, tags: ex.tags,
        };
        if (!TAG_ONLY && (rec.category || rec.subcategory || rec.additional)) {
          if (ex.category_source === "manual") {
            fManual++;
          } else {
            let catChanged = false;
            if (rec.category && rec.category !== ex.category) { fin.category = rec.category; catChanged = true; }
            if (rec.subcategory && rec.subcategory !== ex.subcategory) { fin.subcategory = rec.subcategory; changed = true; }
            if (rec.additional && rec.additional !== ex.additional_category) { fin.additional_category = rec.additional; changed = true; }
            if (catChanged) {
              fin.category_source = CATEGORY_SOURCE;
              fin.category_confidence = 1;
              fin.categorized_at = new Date().toISOString();
              changed = true;
            }
            if (changed) fCat++;
          }
        }
        const newTags = appendTag(ex.tags, meta.tag);
        if (newTags !== null) { fin.tags = newTags; fTag++; changed = true; }
        if (changed) batch.push(fin);
      }

      if (batch.length > 0 && !DRY) {
        if (!pool) { console.error("    DATABASE_URL required for bulk updates"); process.exit(1); }
        try {
          await poolQuery(
            `update leads l set
               category = v.category,
               subcategory = v.subcategory,
               additional_category = v.additional_category,
               category_source = v.category_source,
               category_confidence = coalesce(v.category_confidence::numeric, l.category_confidence),
               categorized_at = coalesce(v.categorized_at::timestamptz, l.categorized_at),
               tags = v.tags,
               updated_at = now()
             from (
               select * from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::numeric[], $7::timestamptz[], $8::text[])
                 as t(id, category, subcategory, additional_category, category_source, category_confidence, categorized_at, tags)
             ) v
             where l.id = v.id`,
            [
              batch.map((b) => b.id),
              batch.map((b) => b.category),
              batch.map((b) => b.subcategory),
              batch.map((b) => b.additional_category),
              batch.map((b) => b.category_source),
              batch.map((b) => b.category_confidence),
              batch.map((b) => b.categorized_at),
              batch.map((b) => b.tags),
            ]
          );
        } catch (err) {
          fErr += batch.length;
          console.error(`    bulk update failed (${batch.length} rows): ${err.message}`);
        }
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

main()
  .then(() => pool?.end())
  .catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
