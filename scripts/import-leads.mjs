#!/usr/bin/env node
import "dotenv/config";

/**
 * Import leads from BSON-exported JSON (NDJSON) into Supabase.
 *
 * Usage:
 *   node scripts/import-leads.mjs /path/to/leads.json
 *
 * Options:
 *   --batch=N     Rows per upsert batch (default 500)
 *   --skip=N      Skip first N lines (for resuming)
 *   --limit=N     Stop after N rows imported
 *   --dry-run     Parse only, don't insert
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { createClient } from "@supabase/supabase-js";

// ── Config ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
if (!filePath) {
  console.error("Usage: node scripts/import-leads.mjs <path-to-json>");
  process.exit(1);
}

const getOpt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : def;
};
const BATCH_SIZE = getOpt("batch", 500);
const SKIP = getOpt("skip", 0);
const LIMIT = getOpt("limit", Infinity);
const DRY_RUN = args.includes("--dry-run");

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Extract a plain value from extended-JSON types like {$numberInt:"5"} */
function plain(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v.$numberInt) return v.$numberInt;
  if (v.$numberDouble) return v.$numberDouble;
  if (v.$numberLong) return v.$numberLong;
  if (v.$date) {
    const ms = v.$date.$numberLong ?? v.$date;
    return new Date(Number(ms)).toISOString();
  }
  return JSON.stringify(v);
}

function domainFromEmail(email) {
  if (!email || !email.includes("@")) return null;
  return email.split("@")[1].toLowerCase();
}

function mapRow(raw) {
  const email = (raw.email || "").trim().toLowerCase();
  if (!email) return null; // skip rows without email

  return {
    email,
    first_name: raw.first_name || null,
    last_name: raw.last_name || null,
    job_title: raw.job_title || null,
    seniority: raw.seniority || null,
    company_name: raw.company_name || null,
    company_size: plain(raw.company_size) || raw.num_employees || null,
    annual_revenue: plain(raw.annual_revenue) || null,
    general_industry: raw.industry || raw.industry_category || null,
    specific_industry: raw.Specific_Industry || null,
    phone: raw.phone_number || null,
    website: raw.website || null,
    person_linkedin: raw.person_linkedin || null,
    company_linkedin: raw.company_linkedin || null,
    source: raw.source || null,
    status: raw.status || "new",
    esp: raw.email_service_provider || null,
    city: raw.city || raw.location?.city || null,
    state: raw.state || raw.location?.state || null,
    country: raw.country || raw.location?.country || null,
    domain: domainFromEmail(email),
    company_overview: raw.company_description || raw.seo_description || null,
    keywords: Array.isArray(raw.keywords) && raw.keywords.length > 0
      ? raw.keywords.join(", ")
      : null,
    raw_data: raw.raw_data || null,
    created_at: plain(raw.created_at) || new Date().toISOString(),
    updated_at: plain(raw.updated_at) || new Date().toISOString(),
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📂 File:       ${filePath}`);
  console.log(`📦 Batch size: ${BATCH_SIZE}`);
  if (SKIP) console.log(`⏭️  Skipping:   ${SKIP} lines`);
  if (LIMIT < Infinity) console.log(`🔢 Limit:      ${LIMIT}`);
  if (DRY_RUN) console.log(`🧪 DRY RUN — no data will be inserted\n`);
  else console.log(`🚀 Starting import...\n`);

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let lineNum = 0;
  let imported = 0;
  let skippedEmpty = 0;
  let errors = 0;
  let batch = [];
  const startTime = Date.now();

  for await (const line of rl) {
    lineNum++;

    // Skip lines if resuming
    if (lineNum <= SKIP) continue;

    // Stop if limit reached
    if (imported >= LIMIT) break;

    // Parse JSON line
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      errors++;
      continue;
    }

    const row = mapRow(raw);
    if (!row) {
      skippedEmpty++;
      continue;
    }

    batch.push(row);

    if (batch.length >= BATCH_SIZE) {
      if (!DRY_RUN) {
        const ok = await upsertBatch(batch);
        if (ok) imported += batch.length;
        else errors += batch.length;
      } else {
        imported += batch.length;
      }
      batch = [];

      // Progress every 10K rows
      if (imported % 10000 < BATCH_SIZE) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (imported / (Date.now() - startTime) * 1000).toFixed(0);
        console.log(
          `  ✅ ${imported.toLocaleString()} imported | ${errors} errors | ${skippedEmpty} skipped | ${elapsed}s | ${rate} rows/s`
        );
      }
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    if (!DRY_RUN) {
      const ok = await upsertBatch(batch);
      if (ok) imported += batch.length;
      else errors += batch.length;
    } else {
      imported += batch.length;
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n────────────────────────────────────`);
  console.log(`✅ Done in ${totalTime}s`);
  console.log(`   Imported:  ${imported.toLocaleString()}`);
  console.log(`   Skipped:   ${skippedEmpty.toLocaleString()}`);
  console.log(`   Errors:    ${errors.toLocaleString()}`);
  console.log(`   Lines:     ${lineNum.toLocaleString()}`);
}

async function upsertBatch(rows, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const { error } = await supabase
      .from("leads")
      .upsert(rows, { onConflict: "email", ignoreDuplicates: false });

    if (!error) return true;

    console.error(
      `  ❌ Batch error (attempt ${attempt}/${retries}): ${error.message}`
    );

    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  return false;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
