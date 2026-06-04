#!/usr/bin/env node
import "dotenv/config";

/**
 * Merge Clay enriched CSV leads into Supabase (batch approach).
 * - Existing leads: only fill in empty fields (never overwrite)
 * - New leads: insert full row
 * - Normalizes country names
 * - Protects: general_industry, seniority, source, website, domain
 *
 * Usage:
 *   node scripts/merge-clay-leads.mjs
 *
 * Options:
 *   --skip=N      Skip first N rows (for resuming)
 *   --limit=N     Stop after N rows
 *   --dry-run     Parse only, don't update
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse/sync";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const FOLDER = join(process.env.HOME, "Downloads", "Clay Enriched leads export");
const BATCH_SIZE = 200;

const args = process.argv.slice(2);
const getOpt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : def;
};
const SKIP = getOpt("skip", 0);
const LIMIT = getOpt("limit", Infinity);
const DRY_RUN = args.includes("--dry-run");

// ── Country normalization ──────────────────────────────────────────────
const COUNTRY_MAP = {
  "us": "United States", "usa": "United States", "u.s.": "United States",
  "u.s.a.": "United States", "united states": "United States",
  "united states of america": "United States", "united states of america usa": "United States",
  "the united states": "United States", "the united states of america": "United States",
  "uk": "United Kingdom", "u.k.": "United Kingdom", "united kingdom": "United Kingdom",
  "great britain": "United Kingdom", "england": "United Kingdom", "britain": "United Kingdom",
  "ca": "Canada", "canada": "Canada",
  "au": "Australia", "aus": "Australia", "australia": "Australia",
};

function normalizeCountry(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return COUNTRY_MAP[trimmed.toLowerCase()] || trimmed;
}

function parseNum(v) {
  if (!v || typeof v !== "string") return null;
  const cleaned = v.replace(/[,$\s]/g, "").trim();
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

function parseTech(v) {
  if (!v || v === "[]" || v === '[""]') return null;
  try {
    const arr = JSON.parse(v);
    if (Array.isArray(arr) && arr.length > 0) {
      const filtered = arr.filter((t) => typeof t === "string" && t.trim());
      return filtered.length > 0 ? filtered : null;
    }
  } catch {
    const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.length > 0 ? parts : null;
  }
  return null;
}

function parseKeywords(v) {
  if (!v || v === "[]" || v === '[""]') return null;
  try {
    const arr = JSON.parse(v);
    if (Array.isArray(arr) && arr.length > 0) return arr.filter(Boolean).join(", ");
  } catch {
    return v.trim() || null;
  }
  return null;
}

function domainFromEmail(email) {
  if (!email || !email.includes("@")) return null;
  return email.split("@")[1].toLowerCase();
}

function mapRow(row) {
  const email = (row.email || "").trim().toLowerCase();
  if (!email) return null;

  return {
    email,
    first_name: (row.first_name || "").trim() || null,
    last_name: (row.last_name || "").trim() || null,
    job_title: (row.job_title || "").trim() || null,
    company_name: (row.company_name || "").trim() || null,
    company_size: parseNum(row.company_size) || parseNum(row.num_employees) || null,
    annual_revenue: parseNum(row.annual_revenue) || null,
    general_industry: (row.industry || "").trim() || null,
    specific_industry: (row["Specific Industry"] || "").trim() || null,
    phone: (row.phone_number || "").trim() || null,
    esp: (row.email_service_provider || "").trim() || null,
    seniority: (row.seniority || "").trim() || null,
    source: (row.source || "").trim() || null,
    country: normalizeCountry(row.country),
    state: (row.state || "").trim() || null,
    city: (row.city || "").trim() || null,
    website: null,
    domain: domainFromEmail(email),
    person_linkedin: (row.person_linkedin || "").trim() || null,
    company_linkedin: (row.company_linkedin || "").trim() || null,
    technologies: parseTech(row.technologies),
    keywords: parseKeywords(row.keywords),
    company_overview: (row.company_description || row["Company Description"] || "").trim() || null,
    status: "new",
  };
}

// ── Batch merge logic ──────────────────────────────────────────────────
async function processBatch(batch) {
  const emails = batch.map((r) => r.email);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;

  // Fetch all existing leads for this batch in one query
  const { data: existingLeads, error: fetchErr } = await supabase
    .from("leads")
    .select("id, email, first_name, last_name, job_title, company_name, company_size, annual_revenue, specific_industry, phone, esp, country, state, city, person_linkedin, company_linkedin, technologies, keywords, company_overview")
    .in("email", emails);

  if (fetchErr) {
    console.error(`  ❌ Fetch error: ${fetchErr.message}`);
    return { inserted: 0, updated: 0, skipped: 0, errors: batch.length };
  }

  const existingMap = new Map();
  for (const lead of (existingLeads || [])) {
    existingMap.set(lead.email, lead);
  }

  // Separate into updates and inserts
  const toUpdate = [];
  const toInsert = [];

  for (const clay of batch) {
    const existing = existingMap.get(clay.email);

    if (existing) {
      // Build updates — only fill empty fields
      const updates = {};
      if (!existing.first_name && clay.first_name) updates.first_name = clay.first_name;
      if (!existing.last_name && clay.last_name) updates.last_name = clay.last_name;
      if (!existing.job_title && clay.job_title) updates.job_title = clay.job_title;
      if (!existing.company_name && clay.company_name) updates.company_name = clay.company_name;
      if (!existing.company_size && clay.company_size) updates.company_size = clay.company_size;
      if (!existing.annual_revenue && clay.annual_revenue) updates.annual_revenue = clay.annual_revenue;
      if (!existing.specific_industry && clay.specific_industry) updates.specific_industry = clay.specific_industry;
      if (!existing.phone && clay.phone) updates.phone = clay.phone;
      if (!existing.esp && clay.esp) updates.esp = clay.esp;
      if (!existing.country && clay.country) updates.country = clay.country;
      if (!existing.state && clay.state) updates.state = clay.state;
      if (!existing.city && clay.city) updates.city = clay.city;
      if (!existing.person_linkedin && clay.person_linkedin) updates.person_linkedin = clay.person_linkedin;
      if (!existing.company_linkedin && clay.company_linkedin) updates.company_linkedin = clay.company_linkedin;
      if ((!existing.technologies || existing.technologies.length === 0) && clay.technologies) updates.technologies = clay.technologies;
      if (!existing.keywords && clay.keywords) updates.keywords = clay.keywords;
      if (!existing.company_overview && clay.company_overview) updates.company_overview = clay.company_overview;

      if (Object.keys(updates).length > 0) {
        updates.updated_at = new Date().toISOString();
        toUpdate.push({ id: existing.id, ...updates });
      } else {
        skipped++;
      }
    } else {
      // New lead
      toInsert.push({
        ...clay,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
  }

  // Batch update existing leads (one by one — Supabase doesn't support batch update by different IDs)
  for (const upd of toUpdate) {
    const { id, ...fields } = upd;
    const { error } = await supabase.from("leads").update(fields).eq("id", id);
    if (error) {
      errors++;
    } else {
      updated++;
    }
  }

  // Batch insert new leads
  if (toInsert.length > 0) {
    const { error } = await supabase.from("leads").insert(toInsert);
    if (error) {
      // Try one by one for insert failures (duplicate emails etc.)
      for (const row of toInsert) {
        const { error: singleErr } = await supabase.from("leads").insert(row);
        if (singleErr) {
          if (singleErr.code === "23505") skipped++; // duplicate
          else errors++;
        } else {
          inserted++;
        }
      }
    } else {
      inserted += toInsert.length;
    }
  }

  return { inserted, updated, skipped, errors };
}

// ── Main ───────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const csvFiles = readdirSync(FOLDER).filter((f) => f.endsWith(".csv")).sort();
  console.log(`Found ${csvFiles.length} CSV files in folder`);

  let totalProcessed = 0;
  let totalInserted = 0;
  let totalUpdated = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let globalRow = 0;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0 || DRY_RUN) return;
    const result = await processBatch(batch);
    totalInserted += result.inserted;
    totalUpdated += result.updated;
    totalSkipped += result.skipped;
    totalErrors += result.errors;
    batch = [];
  }

  for (const csvFile of csvFiles) {
    const filePath = join(FOLDER, csvFile);
    let rows;
    try {
      const content = readFileSync(filePath, "utf-8");
      rows = parse(content, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        relax_quotes: true,
      });
    } catch (err) {
      console.error(`  ❌ Parse error in ${csvFile}: ${err.message}`);
      continue;
    }

    for (const row of rows) {
      globalRow++;
      if (globalRow <= SKIP) continue;
      if (totalProcessed >= LIMIT) break;

      const mapped = mapRow(row);
      if (!mapped) {
        totalSkipped++;
        continue;
      }

      batch.push(mapped);
      totalProcessed++;

      if (batch.length >= BATCH_SIZE) {
        await flushBatch();

        if (totalProcessed % 2000 === 0) {
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rate = Math.round(totalProcessed / ((Date.now() - startTime) / 1000));
          console.log(
            `  ✅ ${totalProcessed.toLocaleString()} processed | ${totalInserted.toLocaleString()} new | ${totalUpdated.toLocaleString()} updated | ${totalSkipped.toLocaleString()} skipped | ${totalErrors.toLocaleString()} errors | ${elapsed}s | ${rate} rows/s`
          );
        }
      }
    }

    if (totalProcessed >= LIMIT) break;
  }

  // Final batch
  await flushBatch();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n────────────────────────────────────`);
  console.log(`✅ Done in ${elapsed}s`);
  console.log(`   Processed: ${totalProcessed.toLocaleString()}`);
  console.log(`   New leads inserted: ${totalInserted.toLocaleString()}`);
  console.log(`   Existing leads updated: ${totalUpdated.toLocaleString()}`);
  console.log(`   Skipped (no changes): ${totalSkipped.toLocaleString()}`);
  console.log(`   Errors: ${totalErrors.toLocaleString()}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
