// Import exact cost line items from a JSON file into the costing feed — the way
// invoice lines (subscriptions, usage billed on an invoice, taxes, credits) get
// in when the provider has no billing API we can read.
//
//   node --env-file=.env.local scripts/costing-import.mjs <file.json>             # full check, nothing kept
//   node --env-file=.env.local scripts/costing-import.mjs <file.json> --commit    # write
//     --backfill   allow lines dated more than 33 days ago (ReplyRouter's daily pull
//                  re-reads only the last 35 days, so its NEXT pull may already miss
//                  them — ask it for a one-off pull of that range)
//     --correct    allow changing a line that is already final (a deliberate correction)
//
// File: { "invoices": [ { "vendor": "example-vendor", "id": "INV-0001", "date": "2026-10-03",
//                         "currency": "USD", "total": "100.00", "url": "…" } ],
//         "items":    [ <spec v1.0 line items> ] }
// Every amount is a decimal STRING exactly as billed. Each item with source
// "invoice" names an invoice listed here, is dated the invoice day, is in its
// currency, and the invoice's lines (this file + any already stored) add up
// EXACTLY to its total — checked here and again by the database at commit.
// Re-importing the same file changes nothing.
//
// ⚠ The repo is PUBLIC: an invoice file inside it is refused unless git ignores
// it (costing-invoices/ is ignored) — keep invoice files outside the repo.
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fromUnits, toUnits, upsertInvoices, upsertItems, validateBatch, validateInvoice } from "./lib/costing-store.mjs";

const ORIGIN = "invoice-import";
const REPULL_DAYS = 35;
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const COMMIT = args.includes("--commit"), BACKFILL = args.includes("--backfill"), CORRECT = args.includes("--correct");
if (!file) { console.error("usage: costing-import.mjs <file.json> [--commit] [--backfill] [--correct]"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }

// realpath resolves symlinks; "inside the repo" is then decided by folder
// identity (device + inode), not by path text — macOS reaches one folder by
// several spellings (letter case, /System/Volumes/Data/…).
let filePath;
try { filePath = realpathSync.native(resolve(file)); } catch { console.error(`cannot read ${file}`); process.exit(1); }
const repoRoot = realpathSync.native(fileURLToPath(new URL("..", import.meta.url)));
const root = statSync(repoRoot);
let inRepo = null; // the file's path inside the repo, if it is in it
for (let dir = dirname(filePath); ; dir = dirname(dir)) {
  const s = statSync(dir);
  if (s.dev === root.dev && s.ino === root.ino) { inRepo = relative(dir, filePath); break; }
  if (dirname(dir) === dir) break;
}
if (inRepo !== null && spawnSync("git", ["-C", repoRoot, "check-ignore", "-q", "--", inRepo]).status !== 0) {
  console.error(`${file} is inside the repo, which is PUBLIC, and git does not ignore it.\n` +
    "Keep invoice files outside the repo (or in its git-ignored costing-invoices/ folder). Nothing read.");
  process.exit(1);
}

// A money figure written as a JSON number is rejected by validation (the spec
// requires strings), so plain JSON.parse cannot lose precision on anything kept.
const doc = JSON.parse(readFileSync(filePath, "utf8"));
const items = Array.isArray(doc) ? doc : doc.items ?? [];
const invoices = Array.isArray(doc) ? [] : doc.invoices ?? [];

const problems = validateBatch(items);
const key = (vendor, id) => `${vendor}\u0000${id}`;
const invMap = new Map();
invoices.forEach((inv, i) => {
  for (const m of validateInvoice(inv)) problems.push(`invoices[${i}]: ${m}`);
  if (inv && typeof inv === "object") {
    if (invMap.has(key(inv.vendor, inv.id))) problems.push(`invoices[${i}]: ${inv.vendor}/${inv.id} is listed twice`);
    invMap.set(key(inv.vendor, inv.id), inv);
  }
});
for (const it of items) {
  if (it?.source !== "invoice" || !it.invoice?.id) continue;
  const inv = invMap.get(key(it.vendor, it.invoice.id));
  if (!inv) { problems.push(`${it.id}: invoice ${it.vendor}/${it.invoice.id} is not listed in "invoices" (its total is needed)`); continue; }
  if (it.date !== inv.date) problems.push(`${it.id}: dated ${it.date}, but its invoice is dated ${inv.date} (invoice lines carry the charge day)`);
  if (it.currency !== inv.currency) problems.push(`${it.id}: in ${it.currency}, but its invoice is in ${inv.currency}`);
}
// ReplyRouter re-pulls "the last 35 days" daily, at a time we do not know. Read
// inclusively, tomorrow's pull starts at today − 33, so anything older may never
// be pulled again (today's pull may already have run).
const now = new Date();
const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (REPULL_DAYS - 2) * 86_400_000)
  .toISOString().slice(0, 10);
const old = items.filter((it) => typeof it?.date === "string" && it.date < cutoff);
if (old.length && !BACKFILL) {
  problems.push(`${old.length} item(s) dated before ${cutoff}: ReplyRouter's daily pull re-reads only the last ${REPULL_DAYS} days, ` +
    `so its next pull may not include them. Re-run with --backfill and ask ReplyRouter for a one-off pull of that range.`);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '60s'");
  if (CORRECT) await client.query("SET LOCAL costing.allow_final_edit = 'on'");

  // Each invoice: lines in this file + lines already stored for it (not in this file) = total, exactly.
  const fileIds = new Set(items.map((i) => i?.id));
  for (const inv of invMap.values()) {
    const { rows: stored } = await client.query(
      `SELECT id, amount::text AS amount FROM cost_line_items WHERE vendor = $1 AND source = 'invoice' AND invoice->>'id' = $2`,
      [inv.vendor, inv.id]);
    // Only source "invoice" lines count, exactly as the database's check counts them.
    const lines = [...items.filter((it) => it?.source === "invoice" && it?.vendor === inv.vendor && it?.invoice?.id === inv.id),
      ...stored.filter((r) => !fileIds.has(r.id))];
    let sum = 0n, ok = true;
    for (const l of lines) { try { sum += toUnits(l.amount); } catch { ok = false; } }
    let total = null; try { total = toUnits(inv.total); } catch { /* reported above */ }
    if (ok && total !== null && sum !== total) problems.push(`invoice ${inv.vendor}/${inv.id}: lines add up to ${fromUnits(sum)}, the invoice total is ${inv.total}`);
    console.log(`invoice ${inv.vendor}/${inv.id} (${inv.date}): ${lines.length} line(s), total ${inv.total} ${inv.currency}${stored.length ? ` — ${stored.length} already stored` : ""}`);
  }
  const byCur = new Map();
  for (const it of items) { try { byCur.set(it.currency, (byCur.get(it.currency) ?? 0n) + toUnits(it.amount)); } catch { /* reported above */ } }
  console.log(`${items.length} item(s): ${[...byCur].map(([c, u]) => `${fromUnits(u)} ${c}`).join(", ") || "none"}`);

  if (problems.length) {
    console.error(`\n${problems.length} problem(s) — nothing written:\n  ${problems.join("\n  ")}`);
    await client.query("ROLLBACK");
    process.exitCode = 1;
  } else {
    // Write, then run the database's own deferred checks now — a dry run proves
    // the commit would succeed, then throws the writes away.
    const written = await upsertInvoices(client, [...invMap.values()]);
    const r = await upsertItems(client, items, ORIGIN);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    if (COMMIT) {
      await client.query("COMMIT");
      console.log(`written: ${written} invoice header(s); items ${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged`);
    } else {
      await client.query("ROLLBACK");
      console.log(`check passed (database checks included): would write ${written} invoice header(s); items ${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged. Re-run with --commit to keep it.`);
    }
  }
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error(`nothing written: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
