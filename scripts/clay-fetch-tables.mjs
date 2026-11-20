#!/usr/bin/env node
// Reads clients' own Clay tables with the Clay CLI, read only (4.4), for the
// by-name seed of their originals (scripts/enrich-seed-originals.mjs
// --by-name --plan):
//
//   node scripts/clay-fetch-tables.mjs --ids <file> --out <dir> [--only TAG,TAG] [--pause-ms 300] [--retry-ms 1000]
//
// --ids       a list of { tag, workspace, company, people, general }: each client's Clay workspace
//             and the ids of its Companies, People and General tables (null when it has none)
// --out       a folder outside this repo (the tables hold client text): <out>/<variant>/companies.json,
//             people.json and inboxes.json, each the CLI's JSON as it answered, and <out>/plan.json,
//             [{ tag, variant, companies, people, inboxes, not_read? }] with the files' full paths
// --only      these tags only
// --pause-ms  the pause before each table (300)
// --retry-ms  the first wait after a rate limit, doubled each time, 5 tries (1000)
//
// Only two commands are ever run: `clay workspaces current` once at the start
// and `clay tables columns get <tableId>`, one table at a time. The CLI has one
// active workspace for every process on this machine, and this script never
// switches it: an entry of another workspace is not read ("not read here"). An
// answer from another workspace, or a "not found" after which the active
// workspace is another, stops the whole run with no plan written: someone
// else moved the pointer, and it is never moved back from here. A client whose
// tag gives no variant name, or one variant two tags share, is not read
// either; the seed refuses both. Prints counts only, never a tag or a name.

import path from "node:path";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { variantName } from "./lib/enrich/templates.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] ?? null : null;
};
const USAGE = "usage: node scripts/clay-fetch-tables.mjs --ids <file> --out <dir> [--only TAG,TAG] [--pause-ms 300] [--retry-ms 1000]";
const KINDS = Object.freeze([
  ["companies", "company"],
  ["people", "people"],
  ["inboxes", "general"],
]);
const RATE_LIMIT_TRIES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** One CLI call: its exit code, output, and the error JSON it wrote to stderr. */
function clay(cliArgs) {
  return new Promise((resolve) => {
    execFile("clay", cliArgs, { maxBuffer: 512 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      let error = null;
      try {
        error = JSON.parse(String(stderr || "").trim() || "null")?.error ?? null;
      } catch {
        error = null;
      }
      if (!err) return resolve({ code: 0, stdout, error });
      if (typeof err.code === "string") return resolve({ code: null, spawn: err.code, stdout: "", error });
      resolve({ code: typeof err.code === "number" ? err.code : 1, stdout: stdout ?? "", error });
    });
  });
}

/** The workspace every clay command runs against now, or null when it can't be read. */
async function currentWorkspace() {
  const r = await clay(["workspaces", "current"]);
  if (r.code !== 0) return null;
  try {
    const id = JSON.parse(r.stdout)?.workspace?.id;
    return id == null ? null : String(id);
  } catch {
    return null;
  }
}

class Stop extends Error {}

/**
 * The exports hold the clients' credentials as Clay answers them (API keys in
 * the HTTP columns' headers and query strings), so every folder is made mode
 * 0700 and every file mode 0600: readable by this user only.
 */
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}
function privateFile(file, text) {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600); // a file there before keeps its mode otherwise
}

const ids = flag("ids");
const out = flag("out");
const pauseMs = Math.max(0, Number(flag("pause-ms") ?? 300) || 0);
const retryMs = Math.max(0, Number(flag("retry-ms") ?? 1000) || 0);
const only = flag("only") ? new Set(String(flag("only")).split(",").map((t) => t.trim().toUpperCase()).filter(Boolean)) : null;

if (!ids || !out) {
  console.error(USAGE);
  process.exit(1);
}
if (insideRepo(out)) {
  console.error("--out is inside this repo: the Clay tables hold client text, so write them outside the repo");
  process.exit(1);
}
let entries;
try {
  entries = JSON.parse(readFileSync(ids, "utf8"));
  if (!Array.isArray(entries)) throw new Error(`${ids} is not a list`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
if (only) entries = entries.filter((e) => only.has(String(e?.tag ?? "").trim().toUpperCase()));

const active = await currentWorkspace();
if (!active) {
  console.error("The Clay CLI's active workspace can't be read (clay workspaces current), so nothing was read");
  process.exit(1);
}
console.log(`Active workspace ${active}: only its tables are read; the CLI is never switched here.`);
console.log("The files written hold the clients' credentials (API keys in the HTTP columns): keep them private (folders 0700, files 0600, never copied).");

const variants = entries.map((e) => variantName(String(e?.tag ?? "")));
const shared = new Map();
for (const v of variants) if (v) shared.set(v, (shared.get(v) ?? 0) + 1);

const totals = { entries: entries.length, read: 0, elsewhere: 0, unnamed: 0, tables: 0, failed: 0, retried: 0 };
let calls = 0;

/**
 * One table's columns, written as the CLI answered. Returns the file, or the
 * reason it was not read; throws Stop when the run must end.
 */
async function fetchTable(tableId, file) {
  for (let attempt = 0; ; attempt++) {
    if (calls++ > 0 && pauseMs) await sleep(pauseMs);
    const r = await clay(["tables", "columns", "get", String(tableId)]);
    if (r.spawn) throw new Stop(`The Clay CLI could not be run (${r.spawn})`);
    if (r.code === 0) {
      let body;
      try {
        body = JSON.parse(r.stdout);
      } catch {
        return { reason: "the answer is not JSON" };
      }
      const ws = body?.workspace?.id;
      if (ws != null && String(ws) !== active) throw new Stop(`A table answered from workspace ${ws}, not ${active}: the CLI's pointer was moved by someone else`);
      if (ws == null && (await currentWorkspace()) !== active) throw new Stop(`The CLI's active workspace is no longer ${active}: the pointer was moved by someone else`);
      if (!Array.isArray(body?.data)) return { reason: "the answer has no column list" };
      privateDir(path.resolve(out));
      privateDir(path.dirname(file));
      privateFile(file, r.stdout);
      return { file };
    }
    const code = r.error?.code ?? `exit ${r.code}`;
    if (r.code === 6 || code === "not_found") {
      if ((await currentWorkspace()) !== active) throw new Stop(`A table was not found and the CLI's active workspace is no longer ${active}: the pointer was moved by someone else`);
      return { reason: "not found" };
    }
    if (r.code === 3) throw new Stop(`The Clay CLI refused the credential (${code}): sign in again, then run this again`);
    if ((r.code === 4 || r.code === 5) && attempt < RATE_LIMIT_TRIES) {
      totals.retried++;
      const after = Number(r.error?.details?.retryAfter);
      await sleep(Math.max(Number.isFinite(after) ? after * 1000 : 0, retryMs * 2 ** attempt));
      continue;
    }
    return { reason: r.code === 4 ? "rate limited" : String(code) };
  }
}

const plan = [];
try {
  for (const [n, entry] of entries.entries()) {
    const tag = String(entry?.tag ?? "").trim();
    const v = variants[n];
    const item = { tag, variant: v, companies: null, people: null, inboxes: null };
    /** @type {Record<string, string>} */
    const notRead = {};
    const withIds = KINDS.filter(([, key]) => entry?.[key]);
    if (!v || (shared.get(v) ?? 0) > 1) {
      totals.unnamed++;
      for (const [kind] of withIds) notRead[kind] = v ? "its variant name is another client's too" : "its tag gives no variant name";
    } else if (String(entry?.workspace ?? "") !== active) {
      totals.elsewhere++;
      for (const [kind] of withIds) notRead[kind] = `not read here (workspace ${entry?.workspace ?? "unknown"})`;
    } else {
      for (const [kind, key] of withIds) {
        const got = await fetchTable(entry[key], path.resolve(out, v, `${kind}.json`));
        if (got.file) {
          item[kind] = got.file;
          totals.tables++;
        } else {
          notRead[kind] = got.reason;
          totals.failed++;
        }
      }
      totals.read++;
      if (totals.read % 10 === 0) console.log(`  ${totals.read} clients read (${totals.tables} tables)`);
    }
    if (Object.keys(notRead).length) item.not_read = notRead;
    plan.push(item);
  }
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(`Stopped: ${e.message}. No plan was written; run this again once the CLI points at workspace ${active} (it is never switched here).`);
  process.exit(2);
}

privateDir(path.resolve(out));
const planFile = path.resolve(out, "plan.json");
privateFile(planFile, `${JSON.stringify(plan, null, 2)}\n`);
console.log(
  `${totals.entries} clients: ${totals.read} read here (${totals.tables} tables, ${totals.failed} not read, ${totals.retried} retries), ` +
    `${totals.elsewhere} in another workspace (not read here), ${totals.unnamed} with no variant name of their own (not read).`
);
console.log(`Plan: ${planFile}`);
