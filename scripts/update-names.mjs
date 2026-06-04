#!/usr/bin/env node
import "dotenv/config";

/**
 * Update ONLY first_name and last_name for EXISTING leads.
 * - Reads enriched_names.csv (email, first_name, last_name)
 * - Batch checks which emails exist in Supabase
 * - Only updates existing leads — never creates new ones
 * - All other columns stay untouched
 */

import { createReadStream } from "fs";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const FILE = process.env.HOME + "/Downloads/enriched_names.csv";
const BATCH_SIZE = 500;

async function main() {
  const startTime = Date.now();
  let total = 0;
  let updated = 0;
  let notFound = 0;
  let errors = 0;
  let skipped = 0;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;

    const emails = batch.map((r) => r.email);

    // Check which emails exist
    const { data: existing, error: fetchErr } = await supabase
      .from("leads")
      .select("email")
      .in("email", emails);

    if (fetchErr) {
      console.error(`  ❌ Fetch error: ${fetchErr.message}`);
      errors += batch.length;
      return;
    }

    const existingSet = new Set((existing || []).map((r) => r.email));

    // Filter to only existing emails
    const toUpdate = batch.filter((r) => existingSet.has(r.email));
    notFound += batch.length - toUpdate.length;

    if (toUpdate.length === 0) return;

    // Upsert only existing leads
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await supabase.from("leads").upsert(toUpdate, {
        onConflict: "email",
        ignoreDuplicates: false,
      });
      if (!error) {
        updated += toUpdate.length;
        return;
      }
      if (attempt === 3) {
        console.error(`  ❌ Upsert error: ${error.message}`);
        errors += toUpdate.length;
      } else {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }

  const parser = createReadStream(FILE).pipe(
    parse({ columns: true, skip_empty_lines: true })
  );

  for await (const row of parser) {
    const email = (row.email || "").trim().toLowerCase();
    if (!email) continue;

    const firstName = (row.first_name || "").trim() || null;
    const lastName = (row.last_name || "").trim() || null;

    if (!firstName && !lastName) {
      skipped++;
      continue;
    }

    const entry = { email };
    if (firstName) entry.first_name = firstName;
    if (lastName) entry.last_name = lastName;

    batch.push(entry);

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
      total += batch.length;
      batch = [];

      if (total % 10000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(total / ((Date.now() - startTime) / 1000));
        console.log(`  ✅ ${total.toLocaleString()} processed | ${updated.toLocaleString()} updated | ${notFound.toLocaleString()} not in DB | ${errors} errors | ${elapsed}s | ${rate} rows/s`);
      }
    }
  }

  if (batch.length > 0) {
    await flushBatch();
    total += batch.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n────────────────────────────────────`);
  console.log(`✅ Done in ${elapsed}s`);
  console.log(`   Processed: ${total.toLocaleString()}`);
  console.log(`   Updated: ${updated.toLocaleString()}`);
  console.log(`   Not in DB (skipped): ${notFound.toLocaleString()}`);
  console.log(`   No names (skipped): ${skipped.toLocaleString()}`);
  console.log(`   Errors: ${errors.toLocaleString()}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
