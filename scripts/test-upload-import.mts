// Rehearse a CSV import on REAL rows through the real engine, then roll it all
// back — nothing is written. Prints every field that would be stored, so a
// mapping can be verified row by row before a live upload (client SOP: test
// ~10 contacts first, confirm no scrambling, then import in bulk).
//
//   npx tsx --env-file=.env.local scripts/test-upload-import.mts <file.csv> [--rows=10] [--emails=a@x.com,b@y.com] [--strategy=merge|skip|replace] [--override=city,state] [--commit]
//
// Row selection: the first N rows that have an email, plus up to 2 rows without
// one (to exercise the holdback path), plus any --emails found in the file (to
// exercise merge / additional-location paths against existing leads).
// --commit performs the import for real (still limited to the selected rows) —
// use it for the client's 10-contact live test.
import fs from "node:fs";
import { parse } from "csv-parse/sync";
import { Pool } from "pg";
import { importRows } from "../src/lib/uploads/import-rows";
import { autoMatchField } from "../src/lib/uploads/constants";
import type { FieldMapping } from "../src/lib/uploads/normalize-row";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const flag = (n: string) => { const h = args.find((a) => a === `--${n}` || a.startsWith(`--${n}=`)); return h ? (h.includes("=") ? h.slice(h.indexOf("=") + 1) : "true") : undefined; };
if (!file) { console.error("usage: test-upload-import.mts <file.csv> [--rows=10] [--emails=...] [--commit]"); process.exit(1); }
const N = Number(flag("rows") ?? 10);
const wanted = (flag("emails") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const COMMIT = flag("commit") === "true";
const TWICE = flag("twice") === "true";   // dry run only: run the lead chunks a second time — must change nothing
const STRATEGY = (flag("strategy") ?? "merge") as "skip" | "merge" | "replace";
const OVERRIDE = (flag("override") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const TAGS = (flag("tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean);   // client tag(s) stamped on every row
if (!["skip", "merge", "replace"].includes(STRATEGY)) { console.error("--strategy must be skip|merge|replace"); process.exit(1); }

// The client's mapping (confirmed 2026-09-18), keyed by the file's REAL headers.
const CLIENT_MAPPING: Record<string, string> = {
  "First Name": "first_name", "Last Name": "last_name", "Title": "title", "Email Business": "email",
  "Location": "address", "State": "state", "City": "city", "Company Name": "company", "Company Industry": "category",
  "Company Description": "subcategory", "Company SEO Description": "additional_category",
  "Company Website": "domain", "Company Primary Phone": "company_phone",
};

const all = parse(fs.readFileSync(file, "utf8"), { skip_empty_lines: true, relax_quotes: true, relax_column_count: true, bom: true }) as string[][];
const headers = all[0];
const mapping: FieldMapping = {};
headers.forEach((h, i) => { const k = CLIENT_MAPPING[h] ?? null; if (k) mapping[i] = k; });
const unmapped = headers.filter((h) => !CLIENT_MAPPING[h]);
console.log("mapping:", Object.entries(mapping).map(([i, k]) => `${headers[Number(i)]} -> ${k}`).join(" | "));
console.log("skipped columns:", unmapped.join(", "));
const auto = headers.map((h) => autoMatchField(h)); console.log("(auto-match would give:", headers.map((h, i) => auto[i] ? `${h}->${auto[i]}` : null).filter(Boolean).join(", "), ")");

const ei = headers.indexOf("Email Business");
const rows: string[][] = [];
let withEmail = 0, without = 0;
for (const r of all.slice(1)) {
  const e = (r[ei] ?? "").trim().toLowerCase();
  if (wanted.includes(e)) { rows.push(r); continue; }
  if (e && withEmail < N) { rows.push(r); withEmail++; }
  else if (!e && without < 2) { rows.push(r); without++; }
  if (withEmail >= N && without >= 2 && wanted.every((w) => rows.some((x) => (x[ei] ?? "").trim().toLowerCase() === w))) break;
}
console.log(`selected ${rows.length} rows (${withEmail} with email, ${without} without, ${wanted.length} requested)\n`);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: { rejectUnauthorized: false } });
const client0 = await pool.connect();
const { rows: [b] } = await client0.query(
  `insert into upload_batches (filename, total_rows, status, duplicate_strategy, source_headers, batch_type) values ($1, $2, 'processing', $4, $3, 'leads') returning id`,
  [`TEST ${file.split("/").pop()}`, rows.length, JSON.stringify(headers), STRATEGY]
);
console.log(`strategy: ${STRATEGY}${OVERRIDE.length ? ` (override ${OVERRIDE.join(", ")})` : ""}${TAGS.length ? ` | tags added: ${TAGS.join(",")}` : ""}`);
client0.release();
const batchId = b.id as string;

const inspect = async (c: import("pg").PoolClient, passes: import("../src/lib/uploads/import-rows").ImportCounters[] = []) => {
  passes.forEach((p, i) => console.log(`pass ${i + 1}:`, JSON.stringify(p)));
  const emails = rows.map((r) => (r[ei] ?? "").trim().toLowerCase()).filter(Boolean);
  const { rows: leads } = await c.query(
    `select l.id, l.email, l.first_name, l.last_name, l.title, l.company, l.city, l.state, l.address, l.tags, l.updated_at, l.domain, l.company_phone, l.esp, l.email_type,
            l.category, left(l.subcategory, 60) as subcategory, length(l.subcategory) as sub_len, left(l.additional_category, 60) as additional_category, l.category_source,
            (select string_agg(t.title, ' / ' order by t.title) from lead_job_titles t where t.lead_id = l.id) as job_titles,
            (select json_agg(json_build_object('city', ll.city_text, 'state', ll.state_text, 'code', ll.state_code)) from lead_locations ll where ll.lead_id = l.id) as extra_locations,
            l.alt_location_text
       from leads l where l.email = any($1::text[]) order by l.email`, [emails]);
  console.log("══ LEADS AS THEY WOULD BE STORED");
  for (const l of leads) {
    console.log(`\n  ${l.email}`);
    for (const k of ["first_name","last_name","title","job_titles","company","city","state","extra_locations","address","tags","updated_at","domain","company_phone","esp","email_type","category","category_source","subcategory","sub_len","additional_category"]) {
      const v = l[k]; if (v == null) continue;
      console.log(`     ${k.padEnd(20)} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  }
  const { rows: hb } = await c.query(`select seq, row_index, raw from upload_holdbacks where batch_id = $1 order by seq`, [batchId]);
  console.log(`\n══ HOLDBACKS (no email): ${hb.length}`);
  for (const h of hb) console.log(`   seq ${h.seq} file-row ${h.row_index}:`, (h.raw as string[]).slice(0, 8).map((v) => JSON.stringify(v.slice(0, 22))).join(", "), "…");
};

const counters = await importRows(pool, rows, {
  batchId, filename: file.split("/").pop()!, headers, fieldMapping: mapping, duplicateStrategy: STRATEGY, overrideFields: OVERRIDE, addTags: TAGS,
  chunkSize: 2000,
  ...(COMMIT ? {} : { dryRun: { inspect, passes: TWICE ? 2 : 1 } }),
});
if (COMMIT) { const c = await pool.connect(); try { await inspect(c); } finally { c.release(); } }
console.log("\n══ COUNTERS", JSON.stringify(counters, null, 0));
const c2 = await pool.connect();
if (COMMIT) {
  await c2.query(`update upload_batches set status='complete', processed_rows=$2, inserted_rows=$3, merged_rows=$4, no_email_rows=$5, in_file_duplicates=$6, locations_added=$7, esp_detected=$8, error_rows=$9, replaced_rows=$10, skipped_rows=$11, error_log=$12, completed_at=now() where id=$1`,
    [batchId, counters.processed, counters.inserted, counters.merged, counters.no_email, counters.in_file_duplicates, counters.locations_added, counters.esp_detected, counters.errors, counters.replaced, counters.skipped, counters.error_log.length ? JSON.stringify(counters.error_log) : null]);
  console.log("COMMITTED. batch:", batchId);
} else {
  await c2.query(`delete from upload_batches where id = $1`, [batchId]);
  console.log("DRY RUN — everything rolled back, test batch removed.");
}
c2.release();
await pool.end();
