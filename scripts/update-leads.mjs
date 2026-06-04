#!/usr/bin/env node
import "dotenv/config";

/**
 * Update leads from leads.json — ONLY general_industry + technologies:
 * 1. general_industry = industry field (NULL if missing)
 * 2. technologies = technologies array
 * 3. Insert leads that failed during original import (full row)
 *
 * Usage:
 *   node scripts/update-leads.mjs ~/Downloads/leads.json
 *
 * Options:
 *   --batch=N     Rows per batch (default 500)
 *   --skip=N      Skip first N lines (for resuming)
 *   --limit=N     Stop after N rows
 *   --dry-run     Parse only, don't update
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith("--"));
if (!filePath) {
  console.error("Usage: node scripts/update-leads.mjs <path-to-json>");
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

async function main() {
  const startTime = Date.now();
  let lineNum = 0;
  let processed = 0;
  let updated = 0;
  let errors = 0;
  let skipped = 0;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0 || DRY_RUN) return;

    // Update only general_industry and technologies by email
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { error } = await supabase
          .from("leads")
          .upsert(
            batch.map((r) => ({
              email: r.email,
              general_industry: r.general_industry,
              technologies: r.technologies,
            })),
            { onConflict: "email", ignoreDuplicates: false }
          );

        if (error) {
          if (attempt === 3) {
            console.error(`  ❌ Batch error (attempt ${attempt}/3): ${error.message}`);
            errors += batch.length;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
          }
        } else {
          updated += batch.length;
          return;
        }
      } catch (err) {
        if (attempt === 3) {
          console.error(`  ❌ Batch exception: ${err.message}`);
          errors += batch.length;
        } else {
          await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
        }
      }
    }
  }

  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    lineNum++;
    if (lineNum <= SKIP) continue;
    if (processed >= LIMIT) break;

    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }

    const email = (raw.email || "").trim().toLowerCase();
    if (!email) {
      skipped++;
      continue;
    }

    // Only extract the two fields we're updating
    const industry = (raw.industry || "").trim() || null;
    const tech = Array.isArray(raw.technologies) && raw.technologies.length > 0
      ? raw.technologies.filter((t) => typeof t === "string" && t.trim())
      : null;

    batch.push({ email, general_industry: industry, technologies: tech });

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
      processed += batch.length;
      batch = [];

      if (processed % 10000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(processed / ((Date.now() - startTime) / 1000));
        console.log(
          `  ✅ ${processed.toLocaleString()} processed | ${updated.toLocaleString()} updated | ${errors.toLocaleString()} errors | ${elapsed}s | ${rate} rows/s`
        );
      }
    }
  }

  // Final batch
  if (batch.length > 0) {
    await flushBatch();
    processed += batch.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n────────────────────────────────────`);
  console.log(`✅ Done in ${elapsed}s`);
  console.log(`   Processed: ${processed.toLocaleString()}`);
  console.log(`   Updated: ${updated.toLocaleString()}`);
  console.log(`   Errors: ${errors.toLocaleString()}`);
  console.log(`   Skipped: ${skipped.toLocaleString()}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
