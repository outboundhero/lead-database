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
//
// A client's own tables, matched by column name (4.3; seedByName in
// seed-originals.mjs: moved, extra, missing and renamed columns, missing ones
// filled from the base variant, a client refused when a compiled column
// differs or the templates do not compile from it):
//
//   node scripts/enrich-seed-originals.mjs --by-name --variant <v> --companies <file> | --no-companies
//        --people <file> --inboxes <file> [--dry] [--report <file>] [--base <variant>]
//   node scripts/enrich-seed-originals.mjs --by-name --plan <plan.json> [--dry] [--report <file>] [--base <variant>]
//
// --plan     a list of clients, [{ tag, variant?, companies: <file> | null, people, inboxes,
//            not_read?: { <kind>: <reason> } }] (scripts/clay-fetch-tables.mjs writes one), each
//            loaded in its own transaction, so one refusal never stops the others. The variant is
//            the tag's (variantName); "default" is never loaded by name, and two clients giving
//            one variant are both refused. A client with a table not read is "not read".
// --base     the variant matched against and filling the gaps ("default"; the tests use their own).
// --report   the full report as JSON (column names, reasons, the first line of a compile
//            failure): client text, so it is refused inside this repo.
// Prints one line of counts per client, then totals: never a prompt, list or column name.
// Exit 0 once every client of a plan is decided (refusals included); a single client
// refused, or an error, exits 1.

import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";
import { readExport, seedByName, seedOriginals } from "./lib/enrich/seed-originals.mjs";
import { OriginalsMissing } from "./lib/enrich/compile-original.mjs";
import { variantName } from "./lib/enrich/templates.mjs";
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

// ── By name (4.3) ───────────────────────────────────────────────────────────

const BY_NAME_USAGE = [
  "usage: node scripts/enrich-seed-originals.mjs --by-name --variant <v> --companies <file> | --no-companies --people <file> --inboxes <file> [--dry] [--report <file>] [--base <variant>]",
  "       node scripts/enrich-seed-originals.mjs --by-name --plan <plan.json> [--dry] [--report <file>] [--base <variant>]",
].join("\n");

/** Is a path (existing or not) inside this repo? Symbolic links resolved, so /tmp and /private/tmp agree. */
function insideRepo(p) {
  const real = (q) => {
    let at = path.resolve(q);
    const rest = [];
    while (!existsSync(at)) {
      rest.unshift(path.basename(at));
      const up = path.dirname(at);
      if (up === at) break;
      at = up;
    }
    return path.join(realpathSync(at), ...rest);
  };
  const root = real(fileURLToPath(new URL("..", import.meta.url)));
  const target = real(p);
  return target === root || target.startsWith(root + path.sep);
}

/** The plan's clients: --plan's list, or the one client the flags name. */
function readPlan() {
  const planFile = flag("plan");
  if (planFile) {
    const list = JSON.parse(readFileSync(planFile, "utf8"));
    if (!Array.isArray(list)) throw new Error(`${planFile} is not a list of clients`);
    return { single: false, entries: list };
  }
  if (!flag("variant") || !files.people || !files.inboxes || (!files.companies && !args.includes("--no-companies"))) throw new Error(BY_NAME_USAGE);
  if (files.companies && args.includes("--no-companies")) throw new Error("Give --companies or --no-companies, not both");
  return { single: true, entries: [{ tag: null, variant: flag("variant"), companies: files.companies ?? null, people: files.people, inboxes: files.inboxes }] };
}

const KINDS = ["companies", "people", "inboxes"];
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** One client's line of counts: never a name. */
function line(label, v, out) {
  const head = `${label} variant ${v ?? "(none)"}: `;
  if (out.status === "not read") return `${head}not read`;
  const word = out.status === "refused" ? `refused (${plural(out.reasons.length, "reason", "reasons")})` : DRY ? "would load" : "loaded";
  if (!out.counts || !out.counts.people) return `${head}${word}`;
  const part = (k) => {
    const x = out.counts[k];
    const from = x.from_default ? (out.report?.compile?.companies_from_default === "did_not_compile" ? ", from the default: its own did not compile" : ", from the default") : "";
    return `${k} own ${x.own}/${x.total} (moved ${x.moved}, renamed ${x.renamed}, filled ${x.filled}${from})`;
  };
  return `${head}${word}; ${KINDS.map(part).join(", ")}; extra ${out.extra}; unknown ${out.unknown}`;
}

async function byName() {
  let plan;
  const reportFile = flag("report");
  const base = flag("base") ?? "default";
  try {
    if (reportFile && insideRepo(reportFile)) throw new Error("--report is inside this repo: the report holds the clients' column names, so write it outside the repo");
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    plan = readPlan();
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  // 1. The variant of each client: the tag's; never "default"; one variant, one client.
  const variants = plan.entries.map((e) => (e?.variant ?? (e?.tag ? variantName(e.tag) : null)) || null);
  const counts = new Map();
  for (const v of variants) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);

  const local = ["127.0.0.1", "localhost"].includes(new URL(String(process.env.DATABASE_URL)).hostname);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
  const seededBy = `${os.userInfo().username}@${os.hostname()}`;
  const results = [];
  let failed = false;
  try {
    for (const [n, entry] of plan.entries.entries()) {
      const v = variants[n];
      const label = plan.single ? "client" : String(entry?.tag ?? `entry ${n + 1}`);
      const result = await one(pool, entry, v, { sameVariant: counts.get(v) ?? 0, base, single: plan.single, seededBy });
      results.push({ tag: entry?.tag ?? null, variant: v, ...result });
      console.log(line(label, v, result));
      if (result.status === "error") failed = true;
    }
  } catch (e) {
    console.error(e instanceof OriginalsMissing ? `The base variant "${base}" is not loaded, so nothing was loaded by name: ${e.message}` : e.message);
    failed = true;
  } finally {
    await pool.end();
  }

  const by = (s) => results.filter((r) => r.status === s);
  const loaded = by("loaded");
  const fromDefault = loaded.filter((r) => r.counts?.companies?.from_default);
  const didNot = loaded.filter((r) => r.report?.compile?.companies_from_default === "did_not_compile");
  const checks = {};
  for (const r of by("refused")) for (const c of new Set(r.reasons.map((x) => x.check))) checks[c] = (checks[c] ?? 0) + 1;
  console.log(
    `Totals: ${plural(results.length, "client", "clients")}: ${DRY ? "would load" : "loaded"} ${loaded.length} (Companies from the default ${fromDefault.length}, ${didNot.length} of them because their own did not compile), ` +
      `refused ${by("refused").length}, not read ${by("not read").length}${by("error").length ? `, errors ${by("error").length}` : ""}${DRY ? "; dry run, nothing kept" : ""}`
  );
  if (Object.keys(checks).length) console.log(`Refused by check (clients): ${Object.entries(checks).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  if (reportFile) {
    writeFileSync(reportFile, `${JSON.stringify({ at: new Date().toISOString(), base, dry: DRY, clients: results }, null, 2)}\n`);
    console.log(`Report: ${reportFile}`);
  }
  if (failed) return 1;
  return plan.single && results.some((r) => r.status !== "loaded") ? 1 : 0;
}

/** One client: the variant checks, its exports read, then seedByName in a transaction of its own. */
async function one(pool, entry, v, { sameVariant, base, single, seededBy }) {
  const refused = (check, text) => ({ status: "refused", reasons: [{ check, text }], notes: [], counts: null, report: null });
  if (!entry || typeof entry !== "object") return refused("variant", "Not a client entry");
  if (!v) return refused("variant", `${entry.tag ? "The tag" : "The entry"} gives no variant name`);
  if (v === "default") return refused("variant", "The default variant is never loaded by name: it stays an exact-layout load (no --by-name)");
  if (entry.tag && entry.variant && variantName(entry.tag) !== entry.variant) {
    return refused("variant", `The variant is not the tag's own (${variantName(entry.tag) ?? "none"}), so the pipeline would never read it`);
  }
  if (sameVariant > 1) return refused("variant", "Another client of the plan gives the same variant name");
  const notRead = Object.entries(entry.not_read ?? {}).filter(([, why]) => why);
  if (notRead.length) return { status: "not read", reasons: notRead.map(([k, why]) => ({ check: "not_read", text: `${k}: ${why}` })), notes: [], counts: null, report: null };
  /** @type {Record<string, any>} */
  const exports = {};
  for (const k of KINDS) {
    if (entry[k] == null) {
      exports[k] = null;
      continue;
    }
    try {
      exports[k] = readExport(String(entry[k]));
    } catch (e) {
      return refused("exports", `${k}: ${e.message}`);
    }
  }
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '5s'");
    const out = await seedByName(c, { exports, variant: v, seededBy, base });
    await c.query(DRY || out.status !== "loaded" ? "ROLLBACK" : "COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    if (e instanceof OriginalsMissing) throw e; // the base: every client would fail the same way
    if (single) console.error(e.message);
    return { status: "error", reasons: [{ check: "error", text: String(e?.message ?? e).split("\n")[0] }], notes: [], counts: null, report: null };
  } finally {
    c.release();
  }
}

// ── The exact layout (the default, and the tests' made-up clients) ──────────

if (args.includes("--by-name")) process.exit(await byName());

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
