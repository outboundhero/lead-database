#!/usr/bin/env node
// Seeds each client's LinkedIn places and excluded keywords (client_linkedin_settings)
// and the shared starter keyword list from the normalized Clay copy (D-P4-4,
// D-P4-5). The file holds client data: keep it OUT of this repo (the script
// refuses a file or a report inside it).
//
//   node --env-file=.env.local scripts/linkedin-seed.mjs --file <normalized.json> [--apply]
//        [--only TAG,TAG] [--report <file outside the repo>]
//
// Without --apply it is a dry run: it reads the database (the geo reference,
// the clients, their rules) and prints what it would write, writing nothing.
// --apply   writes, in one transaction: the starter list, then one row per
//           client and kind. A row a person has saved is never overwritten;
//           a row that already holds exactly this is left alone (no log
//           entry); every write is logged with the file's sha256 and who ran it.
// --only    these clients only (the starter list is written all the same).
// --report  also writes the report to this file (outside the repo).
//
// It refuses a layout other than normalized.json version 3 with its
// seed_picks block, records the file's sha256, never touches client_targeting
// or the linkedin_sources switch and its client list, and prints counts and
// tags, never a place or a keyword.

import os from "node:os";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { loadGeo } from "./lib/aiark/geo.mjs";
import { applySeed, isInside, planSeed, readSeedFile } from "./lib/aiark/linkedin-seed.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const APPLY = args.includes("--apply");
const file = flag("file");
const reportFile = flag("report");
const only = flag("only") ? flag("only").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : null;

if (!file) {
  console.error("usage: node scripts/linkedin-seed.mjs --file <normalized.json outside the repo> [--apply] [--only TAG,TAG] [--report <file outside the repo>]");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
if (reportFile) {
  const dir = path.dirname(path.resolve(reportFile));
  try {
    if (isInside(dir, REPO)) {
      console.error("The report holds client tags: write it outside the repository.");
      process.exit(1);
    }
  } catch {
    console.error(`The report's folder does not exist: ${dir}`);
    process.exit(1);
  }
}

let seed;
try {
  seed = readSeedFile(file, { repoRoot: REPO });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

const url = new URL(process.env.DATABASE_URL);
const local = ["127.0.0.1", "localhost"].includes(url.hostname);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
const c = await pool.connect();
const lines = [];
const say = (s) => {
  lines.push(s);
  console.log(s);
};
let code = 0;
try {
  await c.query(APPLY ? "BEGIN" : "BEGIN READ ONLY");
  await c.query("SET LOCAL lock_timeout = '5s'");
  const plan = await planSeed(c, seed, { only });
  say(`${APPLY ? "Seeding" : "Dry run (nothing written)"}: ${seed.clients.length} clients in the file, sha256 ${seed.sha256}`);
  say(`  rows planned: ${plan.rows.length} (${plan.rows.filter((r) => r.kind === "people").length} people, ${plan.rows.filter((r) => r.kind === "companies").length} companies)`);
  say(`  starter list: ${plan.starter.items.length} keywords, version ${plan.starter.version}`);
  for (const s of plan.skipped) say(`  skipped ${s.tag}: ${s.why}`);
  for (const r of plan.rows) {
    const v = r.value;
    say(`  ${r.tag} ${r.kind}: ${v.include_locations.length} places, ${v.exclude_locations.length} left out, ${v.unplaced.length} unplaced, ${v.exclude_keywords.length} keywords${v.copied_from ? `, copied from ${v.copied_from}` : ""}${v.flags?.length ? ` [${v.flags.join(", ")}]` : ""}`);
  }
  if (APPLY) {
    const out = await applySeed(c, plan, { sha256: seed.sha256, seededBy: `${os.userInfo().username}@${os.hostname()}`, geo: await loadGeoInOrder(c) });
    await c.query("COMMIT");
    say(`Written: starter list ${out.starter.status}; rows ${summary(out.rows)}`);
    for (const r of out.rows.filter((x) => x.status === "refused")) say(`  refused ${r.tag} ${r.kind}: ${(r.errors ?? []).join("; ")}`);
  } else {
    await c.query("ROLLBACK");
  }
} catch (e) {
  await c.query("ROLLBACK").catch(() => {});
  console.error(e.message);
  code = 1;
} finally {
  c.release();
  await pool.end();
}
if (reportFile && lines.length) writeFileSync(reportFile, `${lines.join("\n")}\n`);
process.exit(code);

function summary(rows) {
  const n = new Map();
  for (const r of rows) n.set(r.status, (n.get(r.status) ?? 0) + 1);
  return [...n].map(([k, v]) => `${k} ${v}`).join(", ") || "none";
}

/** loadGeo's three reads one after another (pg 9 refuses parallel queries on one client). */
async function loadGeoInOrder(db) {
  const serial = { query: (() => { let p = Promise.resolve(); return (sql, params) => (p = p.then(() => db.query(sql, params))); })() };
  return loadGeo(serial);
}
