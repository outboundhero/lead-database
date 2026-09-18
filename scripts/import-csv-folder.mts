// Import every CSV in a folder through the real engine (src/lib/uploads/
// import-rows.ts) with the client's confirmed mapping, one file after another,
// exactly as the Uploads page would (one upload_batches row per file, live
// counters, holdbacks for rows without an email). Used for the 2026-09-18
// "Database Uploads 9-15-26" delivery (20 files, 2 byte-identical copies).
//
//   npx tsx --env-file=.env.local scripts/import-csv-folder.mts <folder> [--strategy=merge] [--dry] [--only=1,3] [--files=a.csv,b.csv] [--tag-from-filename | --tag=JPDET]
//
// --dry runs each file inside one rolled-back transaction (nothing written).
// --only=… limits to the given 1-based positions in the sorted file list;
// --files=… to the named files. --tag-from-filename stamps the leading
// client code of each file name ("JPDET 1.csv" → JPDET) on every row of that
// file, --tag=X stamps X on every file; either way the tag must exist in
// client_tags (client decision 2026-09-18: the file name says who the list was
// sourced for). Byte-identical duplicate files are skipped. A file whose header
// row lacks the email column is skipped with an error line. NUL bytes are
// stripped as the upload route does.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parse } from "csv-parse/sync";
import { Pool } from "pg";
import { importRows, type ImportCounters } from "../src/lib/uploads/import-rows";
import type { FieldMapping } from "../src/lib/uploads/normalize-row";

const args = process.argv.slice(2);
const folder = args.find((a) => !a.startsWith("--"));
// Exact flag match: `--tag` must not pick up `--tag-from-filename`.
const flag = (n: string) => { const h = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); return h ? (h.includes("=") ? h.slice(h.indexOf("=") + 1) : "true") : undefined; };
if (!folder) { console.error("usage: import-csv-folder.mts <folder> [--strategy=merge] [--dry] [--only=1,3]"); process.exit(1); }
const STRATEGY = (flag("strategy") ?? "merge") as "skip" | "merge" | "replace";
const DRY = flag("dry") === "true";
const ONLY = new Set((flag("only") ?? "").split(",").map((s) => parseInt(s, 10)).filter((n) => n > 0));
const FILES = new Set((flag("files") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const TAG_FROM_FILENAME = flag("tag-from-filename") === "true";
const TAG = flag("tag")?.trim() || null;
const tagOf = (name: string): string | null => TAG ?? (TAG_FROM_FILENAME ? (name.match(/^([A-Za-z]{3,10})(?=[\s._-]|\.csv$)/i)?.[1]?.toUpperCase() ?? null) : null);

// Client mapping, confirmed 2026-09-18 (Location → address per the client).
const CLIENT_MAPPING: Record<string, string> = {
  "First Name": "first_name", "Last Name": "last_name", "Title": "title", "Email Business": "email",
  "Location": "address", "State": "state", "City": "city", "Company Name": "company", "Company Industry": "category",
  "Company Description": "subcategory", "Company SEO Description": "additional_category",
  "Company Website": "domain", "Company Primary Phone": "company_phone",
};

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".csv")).sort(natural).map((f) => path.join(folder, f));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
pool.on("error", (e) => console.error("[pool]", e.message));
const seen = new Map<string, string>();
const totals: ImportCounters = { processed: 0, inserted: 0, merged: 0, replaced: 0, skipped: 0, no_email: 0, in_file_duplicates: 0, locations_added: 0, esp_detected: 0, errors: 0, error_log: [] };
const t0 = Date.now();
const stamp = () => `[${new Date().toISOString().slice(11, 19)} +${Math.round((Date.now() - t0) / 1000)}s]`;

// Every tag we are about to stamp must be a known client tag — a typo in a file
// name must not invent a client.
const knownTags = new Set<string>();
if (TAG || TAG_FROM_FILENAME) {
  const c = await pool.connect();
  try { for (const r of (await c.query(`select upper(tag) t from client_tags`)).rows) knownTags.add(r.t as string); } finally { c.release(); }
  const wanted = new Map<string, string | null>(files.map((f) => [path.basename(f), tagOf(path.basename(f))]));
  const bad = [...wanted].filter(([n, t]) => (!ONLY.size || ONLY.has(files.findIndex((f) => path.basename(f) === n) + 1)) && (!FILES.size || FILES.has(n)) && (!t || !knownTags.has(t)));
  if (bad.length) { console.error("Refusing: no known client tag for " + bad.map(([n, t]) => `${n} (${t ?? "none"})`).join(", ")); await pool.end(); process.exit(1); }
}

for (let i = 0; i < files.length; i++) {
  const file = files[i], name = path.basename(file);
  if (ONLY.size && !ONLY.has(i + 1)) continue;
  if (FILES.size && !FILES.has(name)) continue;
  const tag = tagOf(name);
  const bytes = fs.readFileSync(file);
  const md5 = crypto.createHash("md5").update(bytes).digest("hex");
  if (seen.has(md5)) { console.log(`${stamp()} ${i + 1}. ${name}: SKIPPED — byte-identical to ${seen.get(md5)}`); continue; }
  seen.set(md5, name);
  const text = bytes.toString("utf8").split("\0").join("");
  const all = parse(text, { skip_empty_lines: true, relax_quotes: true, relax_column_count: true, bom: true }) as string[][];
  const headers = all[0] ?? [], rows = all.slice(1);
  const mapping: FieldMapping = {};
  headers.forEach((h, idx) => { const k = CLIENT_MAPPING[h.trim()]; if (k) mapping[idx] = k; });
  const mapped = new Set(Object.values(mapping));
  if (!mapped.has("email") || rows.length === 0) { console.log(`${stamp()} ${i + 1}. ${name}: SKIPPED — ${rows.length} rows, mapped fields: ${[...mapped].join(",") || "none"} (no email column)`); continue; }
  const missing = Object.keys(CLIENT_MAPPING).filter((h) => !headers.includes(h));
  console.log(`${stamp()} ${i + 1}. ${name}: ${rows.length.toLocaleString()} rows, ${mapped.size} fields mapped${tag ? `, tag ${tag}` : ""}${missing.length ? `, header(s) not in file: ${missing.join(", ")}` : ""}${DRY ? " [DRY]" : ""}`);

  const c0 = await pool.connect();
  const { rows: [b] } = await c0.query(
    `insert into upload_batches (filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type)
     values ($1, $2, 'processing', $3, $4, $5, 'leads') returning id`,
    [DRY ? `DRY ${name}` : name, rows.length, STRATEGY, JSON.stringify(mapping), JSON.stringify(headers)]
  );
  c0.release();
  const batchId = b.id as string;
  const write = async (c: ImportCounters, status?: "complete" | "error") => {
    const cl = await pool.connect();
    try {
      await cl.query(
        `update upload_batches set processed_rows=$2, inserted_rows=$3, merged_rows=$4, replaced_rows=$5, skipped_rows=$6, no_email_rows=$7, in_file_duplicates=$8,
                locations_added=$9, esp_detected=$10, error_rows=$11, error_log=$12${status ? `, status='${status}', completed_at=now()` : ""} where id=$1`,
        [batchId, c.processed, c.inserted, c.merged, c.replaced, c.skipped, c.no_email, c.in_file_duplicates, c.locations_added, c.esp_detected, c.errors, c.error_log.length ? JSON.stringify(c.error_log) : null]
      );
    } finally { cl.release(); }
  };
  try {
    const counters = await importRows(pool, rows, {
      batchId, filename: name, headers, fieldMapping: mapping, duplicateStrategy: STRATEGY, overrideFields: [],
      addTags: tag ? [tag] : [],
      onProgress: (c) => write(c),
      ...(DRY ? { dryRun: { inspect: async () => {} } } : {}),
    });
    if (DRY) { const cl = await pool.connect(); await cl.query(`delete from upload_batches where id=$1`, [batchId]); cl.release(); }
    else await write(counters, counters.errors > 0 && counters.inserted + counters.merged + counters.replaced + counters.skipped === 0 ? "error" : "complete");
    for (const k of Object.keys(totals) as Array<keyof ImportCounters>) if (k !== "error_log") (totals[k] as number) += counters[k] as number;
    totals.error_log.push(...counters.error_log.map((e) => `${name}: ${e}`));
    console.log(`${stamp()}    → new ${counters.inserted.toLocaleString()} | merged ${counters.merged.toLocaleString()} | locations +${counters.locations_added.toLocaleString()} | no-email ${counters.no_email.toLocaleString()} | in-file dups ${counters.in_file_duplicates.toLocaleString()} | esp ${counters.esp_detected.toLocaleString()} | errors ${counters.errors}${counters.error_log.length ? `\n      ${counters.error_log.join("\n      ")}` : ""}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${stamp()}    → FAILED: ${msg}`);
    totals.error_log.push(`${name}: FAILED ${msg}`);
    if (!DRY) { const cl = await pool.connect(); await cl.query(`update upload_batches set status='error', error_log=$2, completed_at=now() where id=$1`, [batchId, JSON.stringify([msg])]); cl.release(); }
  }
}
console.log(`\n${stamp()} TOTAL: new ${totals.inserted.toLocaleString()} | merged ${totals.merged.toLocaleString()} | locations +${totals.locations_added.toLocaleString()} | no-email ${totals.no_email.toLocaleString()} | in-file dups ${totals.in_file_duplicates.toLocaleString()} | esp ${totals.esp_detected.toLocaleString()} | errors ${totals.errors}`);
if (totals.error_log.length) console.log("ERRORS:\n  " + totals.error_log.join("\n  "));
console.log("DONE");
await pool.end();
