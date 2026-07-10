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

import crypto from "node:crypto";
import pg from "pg";

const DRY = process.argv.includes("--dry-run");
const MERGE = process.argv.includes("--merge");

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
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 403) {
    throw new Error(
      "403 from Google Sheets — share the sheet with the service account email (Viewer is enough)."
    );
  }
  if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function main() {
  const saB64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  const sheetId = process.env.TAXONOMY_SHEET_ID;
  if (!saB64 || !sheetId) {
    console.error("GOOGLE_SERVICE_ACCOUNT_B64 and TAXONOMY_SHEET_ID must be set.");
    process.exit(1);
  }
  // Some service-account blobs carry RAW newlines inside the private_key
  // string (invalid JSON). Parse as-is first; on failure, escape them.
  const rawJson = Buffer.from(saB64, "base64").toString("utf8").trim();
  let sa;
  try {
    sa = JSON.parse(rawJson);
  } catch {
    sa = JSON.parse(rawJson.replace(/\r/g, "").replace(/\n/g, "\\n"));
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
    const keywords = [...new Set(
      cells
        .filter((c) => c.toLowerCase() !== tab.trim().toLowerCase())
        .filter((c) => !/^(keywords?|category|categories)$/i.test(c))
        .map((c) => c.toLowerCase())
    )];
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
  if (!MERGE) {
    await client.query("DELETE FROM lead_categories WHERE name <> ALL($1::text[])", [categories.map((c) => c.name)]);
  }
  for (const c of categories) {
    await client.query(
      `INSERT INTO lead_categories (name, keywords)
       VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET keywords = EXCLUDED.keywords`,
      [c.name, c.keywords]
    );
  }
  const { rows } = await client.query("SELECT count(*)::int AS n, sum(array_length(keywords,1))::int AS kw FROM lead_categories");
  console.log(`\nsynced: ${rows[0].n} categories, ${rows[0].kw} keywords total`);
  await client.end();
}

main().catch((err) => {
  console.error("sync failed:", err.message);
  process.exit(1);
});
