#!/usr/bin/env node
import "dotenv/config";

/**
 * Bulk upload clay_deduped.csv into clay_staging table.
 * No duplicate checking — just fast inserts.
 *
 * Usage:
 *   node scripts/upload-to-staging.mjs
 */

import { createReadStream } from "fs";
import { createInterface } from "readline";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const FILE = process.env.HOME + "/Downloads/clay_deduped.csv";
const BATCH_SIZE = 500;

async function main() {
  const startTime = Date.now();
  let total = 0;
  let errors = 0;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await supabase.from("clay_staging").upsert(batch, { onConflict: "email", ignoreDuplicates: true });
      if (!error) return;
      if (attempt === 3) {
        console.error(`  ❌ Batch error: ${error.message}`);
        errors += batch.length;
      } else {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  const parser = createReadStream(FILE).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true })
  );

  for await (const row of parser) {
    const email = (row.email || "").trim().toLowerCase();
    if (!email) continue;

    batch.push({
      email,
      first_name: (row.first_name || "").trim() || null,
      last_name: (row.last_name || "").trim() || null,
      job_title: (row.job_title || "").trim() || null,
      company_name: (row.company_name || "").trim() || null,
      company_size: (row.company_size || "").trim() || null,
      num_employees: (row.num_employees || "").trim() || null,
      annual_revenue: (row.annual_revenue || "").trim() || null,
      industry: (row.industry || "").trim() || null,
      specific_industry: (row.specific_industry || "").trim() || null,
      phone_number: (row.phone_number || "").trim() || null,
      email_service_provider: (row.email_service_provider || "").trim() || null,
      seniority: (row.seniority || "").trim() || null,
      source: (row.source || "").trim() || null,
      country: (row.country || "").trim() || null,
      state: (row.state || "").trim() || null,
      city: (row.city || "").trim() || null,
      person_linkedin: (row.person_linkedin || "").trim() || null,
      company_linkedin: (row.company_linkedin || "").trim() || null,
      technologies: (row.technologies || "").trim() || null,
      keywords: (row.keywords || "").trim() || null,
      company_description: (row.company_description || "").trim() || null,
      domain: (row.domain || "").trim() || null,
    });

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
      total += batch.length;
      batch = [];

      if (total % 10000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(total / ((Date.now() - startTime) / 1000));
        console.log(`  ✅ ${total.toLocaleString()} uploaded | ${errors} errors | ${elapsed}s | ${rate} rows/s`);
      }
    }
  }

  // Final batch
  if (batch.length > 0) {
    await flushBatch();
    total += batch.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n────────────────────────────────────`);
  console.log(`✅ Done in ${elapsed}s`);
  console.log(`   Uploaded: ${total.toLocaleString()}`);
  console.log(`   Errors: ${errors.toLocaleString()}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
