#!/usr/bin/env node
import "dotenv/config";

/**
 * Two-pass merge:
 * Pass 1: Find emails not in DB → save to clay_new_leads.csv
 * Pass 2: Batch upsert existing leads (only first_name, last_name, job_title)
 *
 * Speed: ~1,500-2,000 rows/s
 */

import { createReadStream, createWriteStream, writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const FILE = process.env.HOME + "/Downloads/clay_deduped.csv";
const NEW_LEADS_FILE = process.env.HOME + "/Downloads/clay_new_leads.csv";
const BATCH_SIZE = 500;

async function pass1() {
  console.log("═══ PASS 1: Finding new leads (not in DB) ═══");
  const startTime = Date.now();
  let total = 0;
  let existing = 0;
  let newLeads = 0;
  let batch = [];
  let headerWritten = false;
  const newLeadsStream = createWriteStream(NEW_LEADS_FILE);
  const newEmailSet = new Set();

  async function checkBatch() {
    if (batch.length === 0) return;
    const emails = batch.map((r) => r.email);

    const { data, error } = await supabase
      .from("leads")
      .select("email")
      .in("email", emails);

    if (error) {
      console.error(`  ❌ Fetch error: ${error.message}`);
      return;
    }

    const existingSet = new Set((data || []).map((r) => r.email));

    for (const row of batch) {
      if (existingSet.has(row.email)) {
        existing++;
      } else {
        // Write full row to new leads CSV
        if (!headerWritten) {
          const headers = Object.keys(row.raw);
          newLeadsStream.write(headers.map(h => `"${h}"`).join(",") + "\n");
          headerWritten = true;
        }
        const values = Object.values(row.raw).map(v => {
          const s = String(v || "");
          return s.includes(",") || s.includes('"') || s.includes("\n")
            ? `"${s.replace(/"/g, '""')}"` : s;
        });
        newLeadsStream.write(values.join(",") + "\n");
        newLeads++;
        newEmailSet.add(row.email);
      }
    }
  }

  const parser = createReadStream(FILE).pipe(
    parse({ columns: true, skip_empty_lines: true, relax_column_count: true, relax_quotes: true })
  );

  for await (const row of parser) {
    const email = (row.email || "").trim().toLowerCase();
    if (!email) continue;

    batch.push({ email, raw: row });

    if (batch.length >= BATCH_SIZE) {
      await checkBatch();
      total += batch.length;
      batch = [];

      if (total % 50000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(total / ((Date.now() - startTime) / 1000));
        console.log(`  ✅ ${total.toLocaleString()} checked | ${existing.toLocaleString()} existing | ${newLeads.toLocaleString()} new | ${elapsed}s | ${rate} rows/s`);
      }
    }
  }

  if (batch.length > 0) {
    await checkBatch();
    total += batch.length;
  }

  newLeadsStream.end();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Pass 1 done in ${elapsed}s`);
  console.log(`  Existing: ${existing.toLocaleString()}`);
  console.log(`  New leads saved: ${newLeads.toLocaleString()} → ${NEW_LEADS_FILE}`);
  return { existing, newLeads, newLeadEmails: newEmailSet };
}

async function pass2(newLeadEmails) {
  console.log("\n═══ PASS 2: Batch upsert EXISTING leads only (override first_name, last_name, job_title) ═══");
  const startTime = Date.now();
  let total = 0;
  let errors = 0;
  let skipped = 0;
  let skippedNew = 0;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await supabase.from("leads").upsert(batch, {
        onConflict: "email",
        ignoreDuplicates: false,
      });
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

    // Skip new leads — they'll be uploaded separately later
    if (newLeadEmails.has(email)) {
      skippedNew++;
      continue;
    }

    const firstName = (row.first_name || "").trim() || null;
    const lastName = (row.last_name || "").trim() || null;
    const jobTitle = (row.job_title || "").trim() || null;

    if (!firstName && !lastName && !jobTitle) {
      skipped++;
      continue;
    }

    batch.push({ email, first_name: firstName, last_name: lastName, job_title: jobTitle });

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
      total += batch.length;
      batch = [];

      if (total % 10000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(total / ((Date.now() - startTime) / 1000));
        console.log(`  ✅ ${total.toLocaleString()} upserted | ${errors} errors | ${skipped} no data | ${skippedNew} new skipped | ${elapsed}s | ${rate} rows/s`);
      }
    }
  }

  if (batch.length > 0) {
    await flushBatch();
    total += batch.length;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Pass 2 done in ${elapsed}s`);
  console.log(`  Upserted: ${total.toLocaleString()}`);
  console.log(`  Errors: ${errors.toLocaleString()}`);
  console.log(`  Skipped (no name data): ${skipped.toLocaleString()}`);
  console.log(`  Skipped (new leads): ${skippedNew.toLocaleString()}`);
}

async function main() {
  const startTime = Date.now();

  const { newLeads, newLeadEmails } = await pass1();

  await pass2(newLeadEmails);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n════════════════════════════════════`);
  console.log(`✅ All done in ${elapsed}s`);
  console.log(`   New leads CSV: ${NEW_LEADS_FILE} (${newLeads.toLocaleString()} leads)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
