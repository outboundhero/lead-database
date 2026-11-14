#!/usr/bin/env node
// Loads the original Clay columns into enrich_originals (2A.1): the three
// tables the Clay CLI exported (Companies 68 columns, People 88, General
// inboxes 76). The pipeline's templates are compiled from them when a client's
// tables are made, so no prompt or list from the Clay tables reaches this
// public repo (D1). Keep the export files out of git.
//
//   node scripts/enrich-seed-originals.mjs --companies <file> --people <file> --inboxes <file>
//        [--variant default] [--tracks <file>] [--dry]
//
// --variant  "default" (every client), or a client's own variant (its tag in
//            lower case, other characters as "_") once its own tables are
//            exported (D15). Only "default" writes enrich_settings.people_tracks.
// --tracks   a JSON file of the people tracks to store instead of the ones
//            derived from the originals; each phrase is checked against its
//            cited column, as derived ones are.
// --dry      everything, inside a transaction that is rolled back.
//
// It refuses a layout other than the originals' (counts and each column's
// name), records each file's sha256, and prints counts, unknown references
// and model differences: never a prompt, a list or a column name.

import os from "node:os";
import { readFileSync } from "node:fs";
import pg from "pg";
import dotenv from "dotenv";
import { readExport, seedOriginals } from "./lib/enrich/seed-originals.mjs";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const DRY = args.includes("--dry");
const files = { companies: flag("companies"), people: flag("people"), inboxes: flag("inboxes") };
const variant = flag("variant") ?? "default";
const tracksFile = flag("tracks");

if (!files.companies || !files.people || !files.inboxes) {
  console.error("usage: node scripts/enrich-seed-originals.mjs --companies <file> --people <file> --inboxes <file> [--variant default] [--tracks <file>] [--dry]");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

let exports;
let tracks = null;
try {
  exports = { companies: readExport(files.companies), people: readExport(files.people), inboxes: readExport(files.inboxes) };
  if (tracksFile) tracks = JSON.parse(readFileSync(tracksFile, "utf8"));
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const local = ["127.0.0.1", "localhost"].includes(url.hostname);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
const c = await pool.connect();
let code = 0;
try {
  await c.query("BEGIN");
  await c.query("SET LOCAL lock_timeout = '5s'");
  const out = await seedOriginals(c, { exports, variant, seededBy: `${os.userInfo().username}@${os.hostname()}`, tracks });
  await c.query(DRY ? "ROLLBACK" : "COMMIT");
  console.log(`${DRY ? "Dry run (nothing kept)" : "Loaded"}: variant ${out.variant}, companies ${out.counts.companies}, people ${out.counts.people}, inboxes ${out.counts.inboxes} (${out.replaced} rows replaced)`);
  for (const k of ["companies", "people", "inboxes"]) console.log(`  ${k}: sha256 ${exports[k].sha256}`);
  console.log(`  unknown references: ${out.unknown.length ? out.unknown.map((u) => `${u.from} (${u.ids})`).join(", ") : "none"}`);
  console.log(`  people tracks: ${Object.entries(out.tracks.phrases).map(([t, n]) => `${t} ${n}`).join(", ")}${out.tracks.stored ? " (stored in people_tracks)" : " (not stored: only the default variant writes people_tracks)"}`);
  if (out.models.length) {
    console.log("  models that differ from the originals' (settings are never changed here):");
    for (const m of out.models) console.log(`    ${m.from} ${m.setting}: the original ${m.original ?? "(none)"}, the setting ${m.current ?? "(unset)"}`);
  }
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(e.message);
  code = 1;
} finally {
  c.release();
  await pool.end();
}
process.exit(code);
