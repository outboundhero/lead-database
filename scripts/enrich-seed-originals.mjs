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
//
// The template client's current tables as the default, and each client's own
// personalisation as an overlay on it (2026-11-21; refreshDefault, seedPersonalisation
// and restoreBackup in seed-originals.mjs):
//
//   node scripts/enrich-seed-originals.mjs --refresh-default --companies <file> --people <file> --inboxes <file> --backup <file>
//        [--tracks <file>] [--dry] [--report <file>] [--base <variant>] [--into <variant>] [--personalisation --plan <plan.json>]
//   node scripts/enrich-seed-originals.mjs --restore-default <backup file> [--dry]
//   node scripts/enrich-seed-originals.mjs --personalisation --plan <plan.json> [--dry] [--report <file>] [--base <variant>]
//   node scripts/enrich-seed-originals.mjs --personalisation --variant <v> --people <file> --inboxes <file> [--dry] [--report <file>] [--base <variant>]
//
// --refresh-default  the default made from the template client's current tables, matched by
//            name (columns added since 11-14 at their extension positions). --backup is required
//            without --dry and refused inside this repo: the old rows and the stored people tracks
//            are written there (mode 0600, never over an existing file) before they are replaced.
//            --into another variant than default is for the tests (no tracks written).
// --restore-default  puts a backup back exactly, rows and people tracks, in one transaction.
// --personalisation  each client's own P#57 to P#62 and G#45 to G#50, matched by name and
//            re-pointed to the default's columns, stored as an overlay; a table that can't keep
//            its own runs the default's. With --refresh-default and --dry: one transaction, the
//            refresh then each client in a savepoint, all rolled back; without --dry the refresh
//            commits first, then each client in its own transaction.
// Prints counts only (never a prompt, list, column name or credential); --report writes the
// full JSON (mode 0600, refused inside this repo).

import os from "node:os";
import path from "node:path";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";
import { readExport, refreshDefault, restoreBackup, seedByName, seedOriginals, seedPersonalisation } from "./lib/enrich/seed-originals.mjs";
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

// ── The default refreshed, and each client's personalisation (2026-11-21) ───

const REFRESH_USAGE = [
  "usage: node scripts/enrich-seed-originals.mjs --refresh-default --companies <file> --people <file> --inboxes <file> --backup <file>",
  "            [--tracks <file>] [--dry] [--report <file>] [--base <variant>] [--into <variant>] [--personalisation --plan <plan.json>]",
  "       node scripts/enrich-seed-originals.mjs --restore-default <backup file> [--dry]",
  "       node scripts/enrich-seed-originals.mjs --personalisation --plan <plan.json> [--dry] [--report <file>] [--base <variant>]",
  "       node scripts/enrich-seed-originals.mjs --personalisation --variant <v> --people <file> --inboxes <file> [--dry] [--report <file>] [--base <variant>]",
].join("\n");

/** A file written with mode 0600 (the reports and backups hold client text). flag "wx": never over an existing file. */
function writePrivate(file, text, { exclusive = false } = {}) {
  writeFileSync(file, text, { mode: 0o600, flag: exclusive ? "wx" : "w" });
  chmodSync(file, 0o600); // an existing file keeps its mode otherwise
}

/** The clients of --personalisation: --plan's list, or the one client the flags name. */
function readPersonalisationPlan() {
  const planFile = flag("plan");
  if (planFile) {
    const list = JSON.parse(readFileSync(planFile, "utf8"));
    if (!Array.isArray(list)) throw new Error(`${planFile} is not a list of clients`);
    return { single: false, entries: list };
  }
  if (!flag("variant") || !files.people || !files.inboxes) throw new Error(REFRESH_USAGE);
  return { single: true, entries: [{ tag: null, variant: flag("variant"), companies: null, people: files.people, inboxes: files.inboxes }] };
}

const PERSONAL = [["people", "people"], ["inboxes", "general"]];
const checksOf = (x) => [...new Set((x?.checks ?? []).map((c) => c.check))];

/** One client's line: per table, own, the default's (why), the same as the default's, or not read. Never a name. */
function personalisationLine(label, v, out) {
  const head = `${label} variant ${v ?? "(none)"}: `;
  if (out.status === "not_read") return `${head}not read`;
  if (out.status !== "loaded") return `${head}${out.status} (${out.reasons.map((r) => r.check).join(", ")})`;
  const part = ([k, word]) => {
    const x = out.kinds[k];
    if (x.status === "own") return `${word} own (filled ${x.filled.length})`;
    if (x.status === "base") return `${word} the default's (${checksOf(x).join(", ")})`;
    if (x.status === "same") return `${word} same as the default's`;
    return `${word} not read`;
  };
  return `${head}${PERSONAL.map(part).join("; ")}`;
}

/** Which of the totals a client counts in. */
function personalisationGroup(out) {
  if (out.status === "not_read") return "not_read";
  if (out.status !== "loaded") return out.status;
  const p = out.kinds.people.status;
  const g = out.kinds.inboxes.status;
  if (p === "own" && g === "own") return "both";
  if (p === "own") return "people";
  if (g === "own") return "general";
  if (p === "not_read" && g === "not_read") return "not_read";
  if ([p, g].every((s) => s === "same" || s === "not_read")) return "same";
  return "default";
}

/** The refresh's line: counts only. */
function refreshLine(out) {
  const word = out.status === "refused" ? `refused (${[...new Set(out.reasons.map((r) => r.check))].join(", ")})` : DRY ? "would refresh" : "refreshed";
  const head = `${out.into}: ${word}`;
  if (!out.counts) return head;
  const label = { companies: "companies", people: "people", inboxes: "general" };
  const kinds = KINDS.map((k) => {
    const c = out.counts[k];
    return `${label[k]} ${c.total} (${c.canonical}${c.extensions.length ? ` + ${c.extensions.join(", ")}` : ""})`;
  });
  const sum = (key) => KINDS.reduce((n, k) => n + out.counts[k][key], 0);
  const redacted = KINDS.reduce((n, k) => n + (out.redacted?.[k] ?? 0), 0);
  const tracks = out.tracks
    ? `tracks ${["operations", "facility_office", "ceo"].map((t) => `${t} ${out.tracks.before?.[t] ?? "none"}->${out.tracks.after?.[t] ?? "refused"}`).join(", ")}`
    : "tracks not read";
  return [
    `${head}; ${kinds.join(", ")}`,
    `moved ${sum("moved")}, renamed ${sum("renamed")}, extra ${sum("extra")} (not stored)`,
    `credentials redacted ${redacted}`,
    `compile ${out.compile?.ok ? "ok" : "failed"}`,
    tracks,
    `models differing ${out.models.length} (settings unchanged)`,
  ].join("; ");
}

/** One client of --personalisation: the plan's checks, its People and General exports read, then seedPersonalisation. */
async function onePersonalisation(c, entry, v, { sameVariant, base, seededBy }) {
  const refused = (check, text) => ({ status: "refused", variant: v, kinds: null, stored: 0, replaced: 0, report: null, reasons: [{ check, text }] });
  if (!entry || typeof entry !== "object") return refused("variant", "Not a client entry");
  if (!v) return refused("variant", `${entry.tag ? "The tag" : "The entry"} gives no variant name`);
  if (v === "default") return refused("variant", "The default variant is never a client's personalisation");
  if (entry.tag && entry.variant && variantName(entry.tag) !== entry.variant) {
    return refused("variant", `The variant is not the tag's own (${variantName(entry.tag) ?? "none"}), so the pipeline would never read it`);
  }
  if (sameVariant > 1) return refused("variant", "Another client of the plan gives the same variant name");
  const notRead = PERSONAL.map(([k]) => [k, entry.not_read?.[k]]).filter(([, why]) => why);
  if (notRead.length) return { status: "not_read", variant: v, kinds: null, stored: 0, replaced: 0, report: null, reasons: notRead.map(([k, why]) => ({ check: "not_read", text: `${k}: ${why}` })) };
  /** @type {Record<string, any>} */
  const exports = {};
  for (const k of ["people", "inboxes"]) {
    if (entry[k] == null) continue;
    try {
      exports[k] = readExport(String(entry[k]));
    } catch (e) {
      return refused("exports", `${k}: ${e.message}`);
    }
  }
  return seedPersonalisation(c, { exports, variant: v, seededBy, base });
}

async function refreshAndPersonalise() {
  const doRefresh = args.includes("--refresh-default");
  const doPersonal = args.includes("--personalisation");
  const reportFile = flag("report");
  const backupFile = flag("backup");
  const base = flag("base") ?? "default";
  const into = flag("into") ?? "default";
  let refreshExports = null;
  let tracks = null;
  let plan = null;
  try {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    if (reportFile && insideRepo(reportFile)) throw new Error("--report is inside this repo: the report holds the clients' column names, so write it outside the repo");
    if (doRefresh) {
      if (!files.companies || !files.people || !files.inboxes) throw new Error(REFRESH_USAGE);
      if (doPersonal && !flag("plan")) throw new Error("--refresh-default goes with --personalisation --plan only (the other files are the template client's)");
      if (!DRY && !backupFile) throw new Error("--backup <file> is required without --dry: the old rows and the stored people tracks are written there before they are replaced");
      if (backupFile && insideRepo(backupFile)) throw new Error("--backup is inside this repo: the backup holds client text, so write it outside the repo");
      if (backupFile && !DRY && existsSync(backupFile)) throw new Error("--backup names a file that exists: give a new file (an older backup is never overwritten)");
      refreshExports = { companies: readExport(files.companies), people: readExport(files.people), inboxes: readExport(files.inboxes) };
      if (tracksFile) tracks = JSON.parse(readFileSync(tracksFile, "utf8"));
    }
    if (doPersonal) plan = readPersonalisationPlan();
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  // The clients' overlays go over the variant just refreshed (the default in production).
  const personalBase = doRefresh ? into : base;
  const variants = (plan?.entries ?? []).map((e) => (e?.variant ?? (e?.tag ? variantName(e.tag) : null)) || null);
  const counts = new Map();
  for (const v of variants) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);

  const local = ["127.0.0.1", "localhost"].includes(new URL(String(process.env.DATABASE_URL)).hostname);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
  const seededBy = `${os.userInfo().username}@${os.hostname()}`;
  let refreshed = null;
  const results = [];
  let failed = false;
  const c = await pool.connect();
  /** Each client in its own savepoint (a dry run's one transaction) or its own transaction. */
  const eachClient = async () => {
    for (const [n, entry] of plan.entries.entries()) {
      const v = variants[n];
      const label = plan.single ? "client" : String(entry?.tag ?? `entry ${n + 1}`);
      let out;
      await c.query(DRY ? "SAVEPOINT client" : "BEGIN");
      try {
        if (!DRY) await c.query("SET LOCAL lock_timeout = '5s'");
        out = await onePersonalisation(c, entry, v, { sameVariant: counts.get(v) ?? 0, base: personalBase, seededBy });
        await c.query(DRY ? "RELEASE SAVEPOINT client" : out.status === "loaded" ? "COMMIT" : "ROLLBACK");
      } catch (e) {
        await c.query(DRY ? "ROLLBACK TO SAVEPOINT client" : "ROLLBACK").catch(() => {});
        if (e instanceof OriginalsMissing) throw e; // the base: every client would fail the same way
        if (plan.single) console.error(e.message);
        out = { status: "error", variant: v, kinds: null, stored: 0, replaced: 0, report: null, reasons: [{ check: "error", text: String(e?.message ?? e).split("\n")[0] }] };
      }
      results.push({ tag: entry?.tag ?? null, variant: v, ...out });
      console.log(personalisationLine(label, v, out));
      if (out.status === "error") failed = true;
    }
  };
  const refresh = (beforeWrite) => refreshDefault(c, { exports: refreshExports, base, into, seededBy, tracks, beforeWrite });
  try {
    if (DRY) {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '5s'");
      try {
        if (doRefresh) {
          refreshed = await refresh(null);
          console.log(refreshLine(refreshed));
        }
        if (plan && (!refreshed || refreshed.status === "loaded")) await eachClient();
      } finally {
        await c.query("ROLLBACK").catch(() => {});
      }
    } else {
      if (doRefresh) {
        await c.query("BEGIN");
        try {
          await c.query("SET LOCAL lock_timeout = '5s'");
          refreshed = await refresh((backup) => writePrivate(String(backupFile), `${JSON.stringify(backup)}\n`, { exclusive: true }));
          await c.query(refreshed.status === "loaded" ? "COMMIT" : "ROLLBACK");
        } catch (e) {
          await c.query("ROLLBACK").catch(() => {});
          throw e;
        }
        console.log(refreshLine(refreshed));
        if (refreshed.status === "loaded") console.log(`Backup: ${backupFile} (the old rows of ${into}${into === "default" ? " and the stored people tracks" : ""})`);
      }
      if (plan && (!refreshed || refreshed.status === "loaded")) await eachClient();
    }
  } catch (e) {
    console.error(e instanceof OriginalsMissing ? `The base variant "${personalBase}" is not loaded, so no client was loaded: ${e.message}` : e.message);
    failed = true;
  } finally {
    c.release();
    await pool.end();
  }

  if (refreshed?.status === "refused") {
    for (const r of refreshed.reasons.slice(0, 20)) console.log(`  ${r.check}: ${r.text.replace(/ reads .*$/, " reads a column the template does not map")}`);
    failed = true;
  }
  if (plan && results.length) {
    const groups = {};
    for (const r of results) groups[personalisationGroup(r)] = (groups[personalisationGroup(r)] ?? 0) + 1;
    /** @type {Record<string, number>} */
    const byCheck = {};
    for (const r of results.filter((x) => personalisationGroup(x) === "default")) {
      for (const ch of new Set(PERSONAL.flatMap(([k]) => (r.kinds[k].status === "base" ? checksOf(r.kinds[k]) : [])))) byCheck[ch] = (byCheck[ch] ?? 0) + 1;
    }
    const checkWords = ["unmapped_column", "no_steps", "type", "compile", "examples", "credentials"].filter((k) => byCheck[k] || k !== "credentials").map((k) => `${k} ${byCheck[k] ?? 0}`).join(", ");
    console.log(
      `${plural(results.length, "client", "clients")}: own personalisation in both tables ${groups.both ?? 0}, People only ${groups.people ?? 0}, General only ${groups.general ?? 0}; ` +
        `the default's in both ${groups.default ?? 0} (by check: ${checkWords}); same as the default's ${groups.same ?? 0}; not read ${groups.not_read ?? 0}` +
        `${groups.refused ? `; refused ${groups.refused}` : ""}${groups.error ? `; errors ${groups.error}` : ""}${DRY ? "; dry run, nothing kept" : ""}`
    );
    const tables = PERSONAL.map(([k, word]) => {
      const loaded = results.filter((r) => r.status === "loaded");
      const of = (s) => loaded.filter((r) => r.kinds[k].status === s);
      /** @type {Record<string, number>} */
      const why = {};
      for (const r of of("base")) for (const ch of checksOf(r.kinds[k])) why[ch] = (why[ch] ?? 0) + 1;
      const whyWords = Object.entries(why).sort((a, b) => b[1] - a[1]).map(([ch, n]) => `${ch} ${n}`).join(", ");
      return `${word} own ${of("own").length}, the default's ${of("base").length}${whyWords ? ` (${whyWords})` : ""}, same ${of("same").length}, not read ${of("not_read").length + results.filter((r) => r.status === "not_read").length}`;
    });
    console.log(`Tables: ${tables.join("; ")}`);
  }
  if (reportFile) {
    const refresh = refreshed ? { ...refreshed, backup: refreshed.backup ? { at: refreshed.backup.at, variant: refreshed.backup.variant, rows: refreshed.backup.rows.length } : null } : null;
    writePrivate(reportFile, `${JSON.stringify({ at: new Date().toISOString(), base, into, dry: DRY, refresh, clients: results }, null, 2)}\n`);
    console.log(`Report: ${reportFile}`);
  }
  if (failed) return 1;
  return plan?.single && results.some((r) => r.status !== "loaded") ? 1 : 0;
}

/** --restore-default: a backup put back, rows and people tracks, in one transaction. */
async function restore() {
  const file = flag("restore-default");
  let backup;
  try {
    if (!file) throw new Error(REFRESH_USAGE);
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    backup = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const local = ["127.0.0.1", "localhost"].includes(new URL(String(process.env.DATABASE_URL)).hostname);
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ...(local ? {} : { ssl: { rejectUnauthorized: false } }) });
  const c = await pool.connect();
  let code = 0;
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '5s'");
    const out = await restoreBackup(c, backup);
    await c.query(DRY ? "ROLLBACK" : "COMMIT");
    console.log(`${DRY ? "Would restore" : "Restored"} variant ${out.variant}: ${out.rows} rows (${out.replaced} replaced); people tracks ${out.tracks}${DRY ? "; dry run, nothing kept" : ""}`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.error(e.message);
    code = 1;
  } finally {
    c.release();
    await pool.end();
  }
  return code;
}

// ── The exact layout (the default, and the tests' made-up clients) ──────────

if (args.includes("--restore-default")) process.exit(await restore());
if (args.includes("--refresh-default") || args.includes("--personalisation")) process.exit(await refreshAndPersonalise());
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
