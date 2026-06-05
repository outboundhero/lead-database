#!/usr/bin/env node
import "dotenv/config";

/**
 * Backfill leads.email_type for rows that don't have it set yet.
 *
 * Classifies each lead as 'general' (role-based / shared inbox) or 'personal'
 * using the same logic as src/lib/uploads/detect-email-type.ts.
 *
 * Idempotent: only updates rows where email_type IS NULL.
 *
 * Usage:
 *   node scripts/backfill-email-type.mjs           # backfill all NULLs
 *   node scripts/backfill-email-type.mjs --batch=5000
 *   node scripts/backfill-email-type.mjs --limit=10000
 *   node scripts/backfill-email-type.mjs --dry-run
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const args = process.argv.slice(2);
const getOpt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : def;
};
const hasFlag = (name) => args.includes(`--${name}`);

const BATCH = getOpt("batch", 10000);
const LIMIT = getOpt("limit", Infinity);
const DRY_RUN = hasFlag("dry-run");

const ROLE_PREFIXES =
  /^(info|contact|hello|sales|support|admin|team|office|marketing|noreply|no-?reply|mail|careers|hr|jobs|press|media|billing|accounts?|invoices?|enquir(?:y|ies)|inquir(?:y|ies)|hi|help|service|reception|frontdesk|orders|shop|store|web|webmaster|postmaster|abuse)@/i;
const GENERAL_PAREN = /\(general\)/i;

function classify({ email, first_name, last_name, job_title }) {
  if (GENERAL_PAREN.test(first_name ?? "")) return "general";
  if (GENERAL_PAREN.test(last_name ?? "")) return "general";
  if (GENERAL_PAREN.test(job_title ?? "")) return "general";
  if (email && ROLE_PREFIXES.test(email.trim())) return "general";
  return "personal";
}

let totalProcessed = 0;
let totalUpdated = 0;
let cursor = null;

console.log(`[backfill-email-type] batch=${BATCH} limit=${LIMIT === Infinity ? "all" : LIMIT} dry-run=${DRY_RUN}`);

while (totalProcessed < LIMIT) {
  const take = Math.min(BATCH, LIMIT - totalProcessed);
  let query = supabase
    .from("leads")
    .select("id, email, first_name, last_name, job_title")
    .is("email_type", null)
    .order("id", { ascending: true })
    .limit(take);

  if (cursor) query = query.gt("id", cursor);

  const { data, error } = await query;
  if (error) {
    console.error("Query failed:", error.message);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log("No more rows to backfill.");
    break;
  }

  // Group rows by classification so we can do 2 bulk updates per batch
  const generals = [];
  const personals = [];
  for (const row of data) {
    const kind = classify(row);
    if (kind === "general") generals.push(row.id);
    else personals.push(row.id);
  }

  if (!DRY_RUN) {
    if (generals.length > 0) {
      const { error: gErr } = await supabase
        .from("leads")
        .update({ email_type: "general" })
        .in("id", generals);
      if (gErr) console.error("Update (general) failed:", gErr.message);
    }
    if (personals.length > 0) {
      const { error: pErr } = await supabase
        .from("leads")
        .update({ email_type: "personal" })
        .in("id", personals);
      if (pErr) console.error("Update (personal) failed:", pErr.message);
    }
  }

  cursor = data[data.length - 1].id;
  totalProcessed += data.length;
  totalUpdated += generals.length + personals.length;
  console.log(
    `[${totalProcessed.toLocaleString()}] +${data.length} this batch — ${generals.length} general, ${personals.length} personal`,
  );
}

console.log(`\nDone. Processed ${totalProcessed.toLocaleString()} rows, updated ${totalUpdated.toLocaleString()}.`);
