#!/usr/bin/env node
// sync-taxonomy-from-sheet.mjs — mirror the category taxonomy from the client's
// Google Sheet into lead_categories.
//
// Sheet structure: each TAB's title is a category name; the tab's cells are
// that category's keywords. The sheet is the source of truth — by default the
// sync REPLACES the whole lead_categories table with what the sheet says
// (pass --merge to upsert without deleting categories missing from the sheet).
//
// Auth: Google service account (JWT -> access token, sheets.readonly scope).
// The sheet must be shared with the service account's client_email.
//
// Env:
//   GOOGLE_SERVICE_ACCOUNT_B64   base64 of the service-account JSON
//   TAXONOMY_SHEET_ID            the spreadsheet id
//   DATABASE_URL                 Supabase pooler
//
// Usage:
//   node scripts/sync-taxonomy-from-sheet.mjs             replace-sync
//   node scripts/sync-taxonomy-from-sheet.mjs --merge     upsert only
//   node scripts/sync-taxonomy-from-sheet.mjs --dry-run   print, no DB writes
//   node scripts/sync-taxonomy-from-sheet.mjs --no-prune  skip stale-category prune

import crypto from "node:crypto";
import pg from "pg";

const DRY = process.argv.includes("--dry-run");
const MERGE = process.argv.includes("--merge");
const PRUNE = !process.argv.includes("--no-prune");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = b64url(signer.sign(sa.private_key));
  const jwt = `${header}.${claims}.${signature}`;

  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function sheetsGet(token, path) {
  // Retry 429 (per-minute read quota) and 5xx with backoff before giving up.
  const backoffMs = [2000, 8000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) {
      throw new Error(
        "403 from Google Sheets — share the sheet with the service account email (Viewer is enough)."
      );
    }
    if ((res.status === 429 || res.status >= 500) && attempt < backoffMs.length) {
      console.warn(`  Sheets API HTTP ${res.status}, retrying in ${backoffMs[attempt] / 1000}s…`);
      await sleep(backoffMs[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

// Quality gate for keyword cells: sheets carry checkbox booleans, ids, URLs,
// and prose that would become live match tokens in categorize-worker.
function isQualityKeyword(c) {
  if (c.length < 2) return false; // single characters
  if (/^(true|false|yes|no)$/i.test(c)) return false; // checkbox/boolean cells
  if (/^[\d.,%$-]+$/.test(c)) return false; // pure numbers
  if (/^(https?:\/\/|www\.)/i.test(c)) return false; // URLs
  if (/\S+@\S+\.\S+/.test(c)) return false; // emails
  if (c.split(/\s+/).length > 6) return false; // sentences, not keywords
  return true;
}

async function main() {
  const saB64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  const sheetId = process.env.TAXONOMY_SHEET_ID;
  if (!saB64 || !sheetId) {
    console.error("GOOGLE_SERVICE_ACCOUNT_B64 and TAXONOMY_SHEET_ID must be set.");
    process.exit(1);
  }
  // Some service-account blobs carry RAW newlines inside the private_key
  // string (invalid JSON). Parse as-is first; on failure, escape newlines
  // inside the private_key value ONLY — pretty-printed JSON needs its
  // structural newlines left alone. PEM bodies never contain '"', so the
  // value span ends at the next quote followed by ',' or '}'.
  const rawJson = Buffer.from(saB64, "base64").toString("utf8").trim();
  let sa;
  try {
    sa = JSON.parse(rawJson);
  } catch {
    sa = JSON.parse(
      rawJson.replace(
        /("private_key"\s*:\s*")([\s\S]*?)("\s*[,}])/,
        (_, open, key, close) => open + key.replace(/\r/g, "").replace(/\n/g, "\\n") + close
      )
    );
  }
  console.log(`service account: ${sa.client_email}`);

  const token = await getAccessToken(sa);

  // Tab titles = category names
  const meta = await sheetsGet(token, `${sheetId}?fields=sheets.properties.title`);
  const tabs = (meta.sheets ?? []).map((s) => s.properties.title).filter(Boolean);
  if (tabs.length === 0) {
    console.error("No tabs found in the sheet.");
    process.exit(1);
  }
  console.log(`${tabs.length} tabs: ${tabs.slice(0, 8).join(", ")}${tabs.length > 8 ? ", …" : ""}`);

  // Each tab's cells = keywords
  const categories = [];
  for (const tab of tabs) {
    const range = encodeURIComponent(`'${tab.replace(/'/g, "''")}'`);
    const data = await sheetsGet(token, `${sheetId}/values/${range}`);
    const cells = (data.values ?? []).flat().map((v) => String(v).trim()).filter(Boolean);
    // Drop header-ish cells (the category name itself or "keyword(s)"/"category")
    const candidates = cells
      .filter((c) => c.toLowerCase() !== tab.trim().toLowerCase())
      .filter((c) => !/^(keywords?|category|categories)$/i.test(c))
      .map((c) => c.toLowerCase());
    const kept = candidates.filter(isQualityKeyword);
    if (kept.length < candidates.length) {
      console.log(`  ${tab.trim()}: dropped ${candidates.length - kept.length} junk cells (boolean/number/url/email/sentence)`);
    }
    const keywords = [...new Set(kept)];
    // Tab-name normalization: drop the "Category: " prefix (display noise) and
    // fold "(2)"/"(3)" continuation tabs into their base category — those are
    // keyword overflow tabs, not separate categories.
    const name = tab.trim().replace(/^category:\s*/i, "").replace(/\s*\(\d+\)$/, "").trim();
    const existing = categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.keywords = [...new Set([...existing.keywords, ...keywords])];
      console.log(`  ${tab.trim()} -> merged into ${existing.name} (now ${existing.keywords.length} keywords)`);
    } else {
      categories.push({ name, keywords });
      console.log(`  ${name}: ${keywords.length} keywords${keywords.length ? ` (e.g. ${keywords.slice(0, 4).join(", ")})` : " ⚠ EMPTY"}`);
    }
  }

  if (DRY) {
    console.log("\n--dry-run: no DB writes.");
    return;
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // Case-insensitive name matching: reuse the existing row's exact casing so a
  // case-only sheet edit updates in place instead of delete+reinsert (replace)
  // or a duplicate row (merge).
  const { rows: existingRows } = await client.query("SELECT name FROM lead_categories");
  const existingByLower = new Map(existingRows.map((r) => [r.name.toLowerCase(), r.name]));
  for (const c of categories) {
    c.name = existingByLower.get(c.name.toLowerCase()) ?? c.name;
  }

  // Upsert first, delete stale last — a mid-run crash leaves a superset of the
  // sheet's taxonomy, never a hole for the next categorize-worker run.
  for (const c of categories) {
    await client.query(
      `INSERT INTO lead_categories (name, keywords)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET keywords = EXCLUDED.keywords`,
      [c.name, c.keywords]
    );
  }
  if (!MERGE) {
    const del = await client.query(
      "DELETE FROM lead_categories WHERE lower(name) <> ALL($1::text[])",
      [categories.map((c) => c.name.toLowerCase())]
    );
    if (del.rowCount) console.log(`removed ${del.rowCount} categories no longer in the sheet`);

    // Prune orphaned assignments: categories deleted/renamed in the sheet
    // otherwise survive as plain text on companies/leads forever (worker only
    // touches category IS NULL rows). Only pipeline-written sources are reset —
    // 'manual' and 'bison' assignments are never touched.
    if (PRUNE) {
      const pruneCompanies = await client.query(
        `UPDATE companies c
            SET category = NULL, subcategory = NULL, additional_category = NULL,
                category_source = NULL, categorized_at = NULL
          WHERE c.category IS NOT NULL
            AND c.category_source IN ('keyword', 'ai')
            AND NOT EXISTS (SELECT 1 FROM lead_categories lc WHERE lower(lc.name) = lower(c.category))`
      );
      const pruneLeads = await client.query(
        `UPDATE leads l
            SET category = NULL, subcategory = NULL, additional_category = NULL,
                category_source = NULL, category_confidence = NULL, categorized_at = NULL
          WHERE l.category IS NOT NULL
            AND l.category_source IN ('keyword', 'ai')
            AND NOT EXISTS (SELECT 1 FROM lead_categories lc WHERE lower(lc.name) = lower(l.category))`
      );
      if (pruneCompanies.rowCount || pruneLeads.rowCount) {
        console.log(`pruned stale categories: ${pruneCompanies.rowCount} companies, ${pruneLeads.rowCount} leads`);
      }
    }
  }
  const { rows } = await client.query("SELECT count(*)::int AS n, sum(array_length(keywords,1))::int AS kw FROM lead_categories");
  console.log(`\nsynced: ${rows[0].n} categories, ${rows[0].kw} keywords total`);
  await client.end();
}

main().catch((err) => {
  console.error("sync failed:", err.message);
  process.exit(1);
});
