#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", override: true });

/**
 * Update ONLY company_name for EXISTING leads using direct pg connection.
 * - Reads CSV (email, company_name_clean)
 * - One UPDATE statement per batch via pg pool (bypasses REST API rate limits)
 * - Only updates existing leads — never creates new ones (UPDATE ... WHERE email = v.email)
 * - All other columns stay untouched (UPDATE only sets company_name)
 * - Failed batches are appended to a separate CSV for later retry
 *
 * Env vars:
 *   FILE         — path to input CSV (default: ~/Downloads/clean_company_names_full.csv)
 *   BATCH_SIZE   — rows per UPDATE statement (default: 500)
 *   LIMIT        — stop after processing N rows (for testing)
 */

import { createReadStream, appendFileSync, writeFileSync } from "fs";
import pg from "pg";
import { parse } from "csv-parse";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  ssl: { rejectUnauthorized: false },
});

const FILE = process.env.FILE || (process.env.HOME + "/Downloads/clean_company_names_full.csv");
const FAILURES_FILE = process.env.HOME + "/Downloads/clean_company_names_failures.csv";
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "500", 10);
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : Infinity;

// Initialize failures CSV with header (overwrite each run)
writeFileSync(FAILURES_FILE, "email,company_name_clean\n");

async function flushBatch(batch) {
  if (batch.length === 0) return { matched: 0, errored: 0 };

  // Build UPDATE leads SET company_name = v.company_name
  //        FROM (VALUES ($1, $2), ($3, $4), ...) AS v(email, company_name)
  //        WHERE leads.email = v.email
  const values = batch.flatMap((r) => [r.email, r.company_name]);
  const placeholders = batch.map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`).join(",");
  const sql = `
    UPDATE leads SET company_name = v.company_name
    FROM (VALUES ${placeholders}) AS v(email, company_name)
    WHERE leads.email = v.email
  `;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await pool.query(sql, values);
      return { matched: result.rowCount, errored: 0 };
    } catch (err) {
      if (attempt === 3) {
        // Append failures to CSV — quote both fields, escape internal quotes,
        // strip newlines (which would split rows when CSV is re-read)
        const csvEscape = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/[\r\n]+/g, " ")}"`;
        const lines = batch
          .map((r) => `${csvEscape(r.email)},${csvEscape(r.company_name)}`)
          .join("\n");
        appendFileSync(FAILURES_FILE, lines + "\n");
        console.error(`  ❌ Batch failed after 3 retries: ${err.message}`);
        return { matched: 0, errored: batch.length };
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  return { matched: 0, errored: batch.length };
}

async function main() {
  const startTime = Date.now();
  let total = 0;
  let matched = 0;
  let errors = 0;
  let skipped = 0;
  let batch = [];

  console.log(`📂 Input: ${FILE}`);
  console.log(`📂 Failures will be written to: ${FAILURES_FILE}`);
  console.log(`⚙️  Batch size: ${BATCH_SIZE}${LIMIT !== Infinity ? `, LIMIT: ${LIMIT}` : ""}`);
  console.log("");

  const parser = createReadStream(FILE).pipe(
    parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_records_with_error: true,
    })
  );

  for await (const row of parser) {
    const email = (row.email || "").trim().toLowerCase();
    if (!email) continue;

    const companyName = (row.company_name_clean || "").trim() || null;
    if (!companyName) {
      skipped++;
      continue;
    }

    batch.push({ email, company_name: companyName });

    if (total + batch.length >= LIMIT) {
      const r = await flushBatch(batch);
      total += batch.length;
      matched += r.matched;
      errors += r.errored;
      batch = [];
      console.log(`  🛑 LIMIT=${LIMIT} reached, stopping.`);
      break;
    }

    if (batch.length >= BATCH_SIZE) {
      const r = await flushBatch(batch);
      total += batch.length;
      matched += r.matched;
      errors += r.errored;
      batch = [];

      if (total % 10000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(total / ((Date.now() - startTime) / 1000));
        console.log(
          `  ✅ ${total.toLocaleString()} processed | ${matched.toLocaleString()} matched in DB | ${errors} errors | ${elapsed}s | ${rate} rows/s`
        );
      }
    }
  }

  if (batch.length > 0) {
    const r = await flushBatch(batch);
    total += batch.length;
    matched += r.matched;
    errors += r.errored;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n────────────────────────────────────`);
  console.log(`✅ Done in ${elapsed}s`);
  console.log(`   Processed: ${total.toLocaleString()}`);
  console.log(`   Matched in DB: ${matched.toLocaleString()}`);
  console.log(`   Not in DB: ${(total - matched - errors).toLocaleString()}`);
  console.log(`   No company name (skipped): ${skipped.toLocaleString()}`);
  console.log(`   Failed: ${errors.toLocaleString()} → ${FAILURES_FILE}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error("Fatal:", err);
  await pool.end();
  process.exit(1);
});
