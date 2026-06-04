#!/usr/bin/env node
import "dotenv/config";

/**
 * Import leads_final_merged.csv into Supabase.
 * Fast bulk insert — no duplicate checking (table is empty).
 */

import { createReadStream } from "fs";
import { createClient } from "@supabase/supabase-js";
import { parse } from "csv-parse";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const FILE = process.env.HOME + "/Downloads/leads_clean.csv";
const BATCH_SIZE = 500;

function parseNum(v) {
  if (!v) return null;
  const cleaned = v.replace(/[,$\s]/g, "").trim();
  const n = Number(cleaned);
  return isNaN(n) || n <= 0 ? null : n;
}

function parseTech(v) {
  if (!v || v === "[]" || v === '[""]') return null;
  try {
    const arr = JSON.parse(v);
    if (Array.isArray(arr) && arr.length > 0) {
      return arr.filter((t) => typeof t === "string" && t.trim());
    }
  } catch {
    return null;
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

const COUNTRY_MAP = {
  "us": "United States", "usa": "United States", "u.s.": "United States",
  "u.s.a.": "United States", "united states": "United States",
  "united states of america": "United States",
  "uk": "United Kingdom", "u.k.": "United Kingdom", "united kingdom": "United Kingdom",
  "great britain": "United Kingdom", "england": "United Kingdom",
  "ca": "Canada", "canada": "Canada",
  "au": "Australia", "aus": "Australia", "australia": "Australia",
};

function normalizeCountry(v) {
  if (!v) return null;
  const t = v.trim();
  if (!t) return null;
  return COUNTRY_MAP[t.toLowerCase()] || t;
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
    seniority: (row.seniority || "").trim() || null,
    company_name: (row.company_name || "").trim() || null,
    company_size: parseNum(row.company_size) || parseNum(row.num_employees) || null,
    annual_revenue: parseNum(row.annual_revenue) || null,
    general_industry: (row.general_industry || row.industry || "").trim() || null,
    specific_industry: (row.specific_industry || row.Specific_Industry || "").trim() || null,
    phone: (row.phone || row.phone_number || "").trim() || null,
    esp: (row.esp || row.email_service_provider || "").trim() || null,
    source: (row.source || "").trim() || null,
    status: (row.status || "").trim() || "new",
    country: normalizeCountry(row.country),
    state: (row.state || "").trim() || null,
    city: (row.city || "").trim() || null,
    website: (row.website || "").trim() || null,
    domain: domainFromEmail(email),
    person_linkedin: (row.person_linkedin || "").trim() || null,
    company_linkedin: (row.company_linkedin || "").trim() || null,
    technologies: parseTech(row.technologies),
    keywords: parseKeywords(row.keywords),
    company_overview: (row.company_overview || row.company_description || row.seo_description || "").trim() || null,
    created_at: (row.created_at || "").trim() || new Date().toISOString(),
    updated_at: (row.updated_at || "").trim() || new Date().toISOString(),
  };
}

async function main() {
  const startTime = Date.now();
  let total = 0;
  let errors = 0;
  let skipped = 0;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await supabase.from("leads").insert(batch);
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
    const mapped = mapRow(row);
    if (!mapped) {
      skipped++;
      continue;
    }

    batch.push(mapped);

    if (batch.length >= BATCH_SIZE) {
      await flushBatch();
      total += batch.length;
      batch = [];

      if (total % 10000 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = Math.round(total / ((Date.now() - startTime) / 1000));
        console.log(`  ✅ ${total.toLocaleString()} inserted | ${errors} errors | ${elapsed}s | ${rate} rows/s`);
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
  console.log(`   Inserted: ${total.toLocaleString()}`);
  console.log(`   Errors: ${errors.toLocaleString()}`);
  console.log(`   Skipped: ${skipped.toLocaleString()}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
