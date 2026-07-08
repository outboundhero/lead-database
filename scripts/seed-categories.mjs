#!/usr/bin/env node
// seed-categories.mjs — load the category/keyword taxonomy into lead_categories.
//
// Usage:
//   node scripts/seed-categories.mjs taxonomy.json            upsert categories
//   node scripts/seed-categories.mjs taxonomy.json --replace  wipe table first
//   node scripts/seed-categories.mjs --list                   show current taxonomy
//
// taxonomy.json accepts either shape:
//   [{ "name": "Plumbing", "keywords": ["plumber", "plumbing"], "description": "..." }, ...]
// or a simple map:
//   { "Plumbing": ["plumber", "plumbing"], "Dental": ["dentist", "dental"], ... }
//
// Env: DATABASE_URL (Supabase pooler)

import fs from "node:fs";
import pg from "pg";

const args = process.argv.slice(2);

function normalize(raw) {
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed.map((c) => ({
      name: String(c.name ?? "").trim(),
      keywords: (c.keywords ?? []).map((k) => String(k).trim().toLowerCase()).filter(Boolean),
      description: c.description ? String(c.description) : null,
    }));
  }
  return Object.entries(parsed).map(([name, keywords]) => ({
    name: name.trim(),
    keywords: (Array.isArray(keywords) ? keywords : []).map((k) => String(k).trim().toLowerCase()).filter(Boolean),
    description: null,
  }));
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  if (args.includes("--list")) {
    const { rows } = await client.query(
      "SELECT name, keywords, description FROM lead_categories ORDER BY name"
    );
    if (rows.length === 0) console.log("(no categories seeded yet)");
    for (const r of rows) {
      console.log(`${r.name}  [${r.keywords.join(", ")}]${r.description ? ` — ${r.description}` : ""}`);
    }
    await client.end();
    return;
  }

  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("Usage: node scripts/seed-categories.mjs <taxonomy.json> [--replace] | --list");
    process.exit(1);
  }

  const categories = normalize(fs.readFileSync(file, "utf8")).filter((c) => c.name);
  if (categories.length === 0) {
    console.error("No categories found in file.");
    process.exit(1);
  }

  if (args.includes("--replace")) {
    await client.query("DELETE FROM lead_categories");
    console.log("cleared existing taxonomy");
  }

  for (const c of categories) {
    await client.query(
      `INSERT INTO lead_categories (name, keywords, description)
       VALUES ($1, $2, $3)
       ON CONFLICT (name) DO UPDATE
         SET keywords = EXCLUDED.keywords,
             description = COALESCE(EXCLUDED.description, lead_categories.description)`,
      [c.name, c.keywords, c.description]
    );
  }
  console.log(`seeded ${categories.length} categories`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
