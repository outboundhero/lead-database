#!/usr/bin/env node
// Overlap sharing, the worker side (migrations 133 and 134; plan 1.1 to 1.7,
// 1.9, 1.12, 1.13 and 2.6; scripts/lib/share/): the lead lists, discovery,
// the place wait, the fit, the receive rule, candidates and pools, every
// dedupe reason, the same group rule and owners, the Clay General inboxes
// stand-in filter, preview, apply, the paced tags, undo, the caps, own_topup,
// the Sharing page's actions, the worker's wiring, the push timer, the prune,
// the seed script and a scale smoke.
// LOCAL DATABASE ONLY: made-up clients SHTEST_*, made-up leads and uploads
// under .shtest.example, all removed at the end (and any left by a run that
// was cut off). It turns overlap_sharing on for its own clients only, seeds a
// made-up stand-in into never_contact_inboxes, and puts both settings and the
// location_backfill row of cron_runs back as they were.
//
//   node --env-file=.env.local scripts/test-sharing.mjs
//
// Run it under the shared local-database lock. Don't run the enrichment
// worker meanwhile: the share step is called here by import. Nothing reaches a
// network: fetch is refused except the push stub a check hands in, DNS is
// refused, and the import's mail provider lookup is a stub. No paid key is
// read. The location backfill script runs twice, as test-aiark runs it.
//
//   B. the objects are server-only; the SQL switch and pool rule agree with settings.mjs
//   C. lead lists through the real import (switch off, new, updated, skipped, dry run)
//   D. the batch's client and run (beginAdd, beginPromote, add-run.ts)
//   E. discovery: one job per batch, each skip reason, no_lead_list, since, the switch
//   F. the place wait through a real location run (cron_runs), the limit, the recheck
//   G. the fit and the receive rule's reasons
//   H. candidates: pools, the list, places
//   I. dedupe, the same group rule, owners, the stand-in filter
//   J. preview, apply, tags, undo
//   L. caps in apply mode
//   M. own_topup for a top-up batch
//   N. the actions' refusals and retry
//   O. the worker's wiring and a whole round
//   P. the push timer
//   R. the prune
//   S. the seed script
//   T. scale smoke: 2,000 leads, 90 clients, EXPLAIN anchored on the ids
//   Z. everything removed, the settings back

import pg from "pg";
import dns from "node:dns";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checker, dropPaidKeys, localDatabaseUrl } from "./fixtures/test-support.mjs";
import { clientPool, flagOn, settingsFrom } from "./lib/enrich/settings.mjs";
import { CRON_LOCATION_BACKFILL, SHARE_SKIP_REASONS, SHARING_CAPABILITY, TOPUP_FILTER_KEY } from "./lib/overlap-topup.mjs";
import { beginAdd } from "./lib/aiark/add.mjs";
import { candidateReceivers, jobLeads, jobLeadsSql, pickOwner, reasonsSql, receiversByTag } from "./lib/share/decide.mjs";
import { claimDue, decideJob, discoverJobs, recheckOne } from "./lib/share/jobs.mjs";
import { newUpkeepMemory, prune, pushTimer, writeTags } from "./lib/share/upkeep.mjs";
import { newShareMemory, shareRound } from "./lib/share/step.mjs";
import { applyShareJob, previewShareJob, retryShareJob, ShareActionError, undoShareJob } from "./lib/share/actions.mjs";
import { seedPlan, seedWrite } from "./lib/share/seed.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const out = checker();
const ok = (name, cond, detail) => out.check(name, Boolean(cond), detail);
const sec = (s) => out.section(s);

const RUN = randomUUID().slice(0, 6);
const HOST = "shtest.example";
const FILE = "shtest-"; // every made-up upload's file name starts with it
const T = (s) => `SHTEST_${s}`;
const mail = (who) => `${who}-${RUN}@${who.split("-")[0]}-co.${HOST}`;
const source = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The same object whatever its key order (jsonb gives keys back in its own order). */
const sorted = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sorted(o[k])])) : o);
const sameObj = (a, b) => same(sorted(a), sorted(b));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── No network ───────────────────────────────────────────────────────────────

const net = { refused: 0, dns: 0 };
globalThis.fetch = async () => {
  net.refused++;
  throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
};
for (const name of ["resolveMx", "resolve", "resolve4", "resolve6", "resolveAny", "lookup"]) {
  dns.promises[name] = async () => {
    net.dns++;
    throw Object.assign(new Error("DNS refused: this test allows no network"), { code: "ECONNREFUSED" });
  };
}

// ── The import's TypeScript, compiled as it is imported ─────────────────────

const require = createRequire(import.meta.url);
const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  // The import's mail provider lookup (src/lib/uploads/esp-lookup.ts): never asks DNS.
  "./esp-lookup": `export function domainOfEmail(email) {
  const at = email.lastIndexOf("@");
  return at < 0 ? null : email.slice(at + 1).trim().toLowerCase();
}
export async function lookupEspForDomains(domains) {
  const out = new Map();
  for (const d of domains) out.set(d, "Google");
  return out;
}`,
};
const HOOKS = `import { existsSync, readFileSync } from "node:fs";
let ts;
let src;
let stubs = {};
export async function initialize(data) {
  src = data.src;
  stubs = data.stubs;
  ts = (await import(data.typescript)).default;
}
const TS_FILE = /\\.tsx?$/;
function find(base) {
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const u = new URL(base + ext);
    if (existsSync(u)) return u.href;
  }
  return null;
}
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(stubs, specifier)) return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  let hit = null;
  if (specifier.startsWith("@/")) hit = find(new URL(specifier.slice(2), src).href);
  else if (/^\\.\\.?\\//.test(specifier) && TS_FILE.test(context.parentURL ?? "") && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
    hit = find(new URL(specifier, context.parentURL).href);
  }
  return hit ? { url: hit, shortCircuit: true } : next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("file:") && TS_FILE.test(url)) {
    const out = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      fileName: url,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, {
  data: { typescript: pathToFileURL(require.resolve("typescript")).href, src: SRC, stubs: STUBS },
});

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

const saved = { settings: new Map(), cron: null };
const myBatches = async () => (await all(`SELECT id FROM upload_batches WHERE filename LIKE $1`, [`${FILE}%`])).map((r) => r.id);

/** Every row this suite (or a run of it that was cut off) made, removed. */
async function cleanup() {
  const batches = await myBatches();
  const runs = (await all(`SELECT id FROM aiark_runs WHERE starts_with(client_tag, 'SHTEST_')`)).map((r) => r.id);
  await pool.query(`DELETE FROM push_items WHERE batch_id IN (SELECT id FROM push_batches WHERE starts_with(client_tag, 'SHTEST_'))`);
  await pool.query(`DELETE FROM push_batches WHERE starts_with(client_tag, 'SHTEST_')`);
  await pool.query(`DELETE FROM upload_batches WHERE id = ANY($1::uuid[])`, [batches]);
  await pool.query(`DELETE FROM aiark_runs WHERE id = ANY($1::uuid[])`, [runs]);
  await pool.query(`DELETE FROM enrich_tables WHERE starts_with(client_tag, 'SHTEST_')`);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM client_location_coverage WHERE starts_with(client_tag, 'SHTEST_')`);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, 'SHTEST_')`);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, 'SHTEST_')`);
}

async function saveState() {
  for (const key of ["overlap_sharing", "never_contact_inboxes"]) {
    saved.settings.set(key, (await one(`SELECT value, updated_by FROM enrich_settings WHERE key = $1`, [key])) ?? null);
  }
  saved.cron = (await one(`SELECT * FROM cron_runs WHERE name = $1`, [CRON_LOCATION_BACKFILL])) ?? null;
}

async function restoreState() {
  for (const [key, row] of saved.settings) {
    if (row) await pool.query(`UPDATE enrich_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1`, [key, JSON.stringify(row.value), row.updated_by]);
    else await pool.query(`DELETE FROM enrich_settings WHERE key = $1`, [key]);
  }
  if (saved.cron) {
    await pool.query(
      `INSERT INTO cron_runs (name, started_at, finished_at, finished_run_started_at, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (name) DO UPDATE SET started_at = $2, finished_at = $3, finished_run_started_at = $4, updated_at = $5`,
      [saved.cron.name, saved.cron.started_at, saved.cron.finished_at, saved.cron.finished_run_started_at, saved.cron.updated_at]
    );
  } else {
    await pool.query(`DELETE FROM cron_runs WHERE name = $1`, [CRON_LOCATION_BACKFILL]);
  }
}

/** The location run as cron_runs records it: started, and finished (the start of the run that finished). */
async function locationRun({ started, finished = started }) {
  await pool.query(
    `INSERT INTO cron_runs (name, started_at, finished_at, finished_run_started_at) VALUES ($1, $2, now(), $3)
     ON CONFLICT (name) DO UPDATE SET started_at = $2, finished_at = now(), finished_run_started_at = $3, updated_at = now()`,
    [CRON_LOCATION_BACKFILL, started, finished]
  );
}

// ── Made-up clients, settings, leads, batches ───────────────────────────────

const NV = (extra = {}) => ({ country: "US", state: "NV", ...extra });
async function client(s, { status = "Active", group = null, type = "Cleaning", onTab = true, churn = { state: "empty" }, places = [NV()],
  rules = true, exclude = [], requireLocation = true, tag = T(s) } = {}) {
  await pool.query(
    `INSERT INTO client_tags (tag, group_no, status, client_type, on_groups_tab, churn_cell_state, churn_date, churn_cell, groups_tab_read_at, name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)`,
    [tag, group, status, type, onTab, churn.state ?? null, churn.date ?? null, churn.cell ?? null, `made-up ${tag}`]
  );
  if (rules) {
    await pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_terms, require_location, notes)
       VALUES ($1, '{US}', $2::jsonb, $3::text[], $4, 'test-sharing: made up')`,
      [tag, JSON.stringify(places), exclude, requireLocation]
    );
  }
  return tag;
}

const SINCE = new Date(Date.now() - 5 * 3600_000).toISOString();
const PATTERN = "shtestbox@|shtest-dept"; // a made-up stand-in, never the Clay original
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
let LIST = [];
const BASE = () => ({
  enabled: true, tags: LIST, mode: "preview", pools: { cleaning: ["Cleaning", "Canada Cleaning"] }, isolated_tag_suffixes: ["-OS"],
  push_tags: [], push_every_minutes: 15, push_max_per_job: 1000, push_max_per_day: 2000, held_retry_days: 7, write_tags: false,
  tag_rows_per_day: 20000, since: SINCE, wait_location_minutes: 180, recheck_days: 7,
});
async function setSharing(patch = {}) {
  const value = { ...BASE(), ...patch };
  await pool.query(
    `INSERT INTO enrich_settings (key, value) VALUES ('overlap_sharing', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)]
  );
  return value;
}
async function setFilter(on) {
  const value = on
    ? { enabled: false, pattern: PATTERN, source: "test-sharing: made-up stand-in", sha256: sha(PATTERN), read_at: new Date().toISOString(), rows_per_day: 5000, chunk_rows: 500 }
    : { enabled: false, pattern: null, source: null, sha256: null, read_at: null, rows_per_day: 5000, chunk_rows: 500 };
  await pool.query(
    `INSERT INTO enrich_settings (key, value) VALUES ('never_contact_inboxes', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(value)]
  );
}
const settingsNowT = async () => settingsFrom(await all(`SELECT key, value FROM enrich_settings`));

const GEO = { reno: "5511077", sparks: "5512862", henderson: "5505411", provo: "5780026", boise: "5586437" };
/** A lead as the location backfill leaves it (placed), unless told otherwise. */
async function lead(who, { city = "Reno", state = "NV", country = "US", status = "resolved", geo = GEO[String(city).toLowerCase()] ?? null,
  tags = T("O"), type = "personal", company = `${who} Co`, validation = "valid", esp = null, bounced = false, email = mail(who), stateText = null } = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO leads (email, company, city, state, state_code, country, country_code, location_status, location_id, tags, email_type,
                        validation_status, esp, is_bounced)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::bigint, $10, $11, $12, $13, $14) RETURNING id`,
    [email, company, city, stateText ?? (status ? state : null), status ? state : null, country === "US" ? "USA" : country, status ? country : null,
      status, status === "resolved" ? geo : null, tags, type, validation, esp, bounced]
  );
  return r.id;
}

const MAPPING = { 0: "email", 1: "company", 2: "city", 3: "state" };
async function batch(slug, { tags = [T("O")], status = "complete", created = null, completed = "now", inserted = 0, mapping = MAPPING, run = null } = {}) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO upload_batches (filename, total_rows, status, duplicate_strategy, field_mapping, batch_type, add_tags, inserted_rows,
                                 created_at, completed_at, aiark_run_id)
     VALUES ($1, 1, $2, 'merge', $3::jsonb, 'leads', $4::text[], $5, coalesce($6::timestamptz, now()),
             CASE WHEN $7::text = 'now' THEN now() WHEN $7::text IS NULL THEN NULL ELSE $7::timestamptz END, $8) RETURNING id, created_at`,
    [`${FILE}${RUN}-${slug}.csv`, status, mapping ? JSON.stringify(mapping) : null, tags, inserted, created, completed, run]
  );
  return b.id;
}
async function list(batchId, ids, outcome = "new") {
  await pool.query(`INSERT INTO upload_batch_leads (batch_id, lead_id, outcome) SELECT $1, unnest($2::uuid[]), $3 ON CONFLICT DO NOTHING`, [batchId, ids, outcome]);
}
const job = (id) => one(`SELECT * FROM share_jobs WHERE batch_id = $1`, [id]);
const rowsOf = async (id) => new Map((await all(`SELECT lead_id, receiver_tag, outcome, matched_place, applied_at, push_state, tag_added, undone_at FROM lead_shares WHERE batch_id = $1`, [id])).map((r) => [`${r.lead_id}|${r.receiver_tag}`, r]));
/** Takes this job for deciding, as claimDue would, and decides it. */
async function decide(batchId, settings) {
  const { rows: [j] } = await pool.query(`UPDATE share_jobs SET state = 'deciding', next_try_at = now() + interval '10 minutes' WHERE batch_id = $1 RETURNING *`, [batchId]);
  return decideJob(pool, j, { settings });
}
/** A share job made as discovery makes it, waiting. */
async function waitingJob(batchId, { origin = T("O"), topup = false, mode = "preview", doneAgo = "1 hour" } = {}) {
  await pool.query(
    `INSERT INTO share_jobs (batch_id, origin_tag, origin_pool, state, topup, mode, batch_done_at, place_wait_until, new_leads)
     VALUES ($1, $2, 'cleaning', 'waiting', $3, $4, now() - $5::interval, now() - $5::interval + interval '180 minutes',
             (SELECT count(*) FROM upload_batch_leads WHERE batch_id = $1 AND outcome = 'new'))`,
    [batchId, origin, topup, mode, doneAgo]
  );
}
async function pushBatch(tag, { status = "pending", ids = null, items = [], source = null } = {}) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO push_batches (campaigns, client_tag, status, selected_ids, push_options) VALUES ('[]'::jsonb, $1, $2, $3::uuid[], $4::jsonb) RETURNING id`,
    [tag, status, ids, source ? JSON.stringify({ source, skipAlreadySent: true }) : null]
  );
  for (const [leadId, st] of items) {
    await pool.query(`INSERT INTO push_items (batch_id, lead_id, email, status) VALUES ($1, $2, 'x', $3)`, [b.id, leadId, st]);
  }
  return b.id;
}

// ── B. Objects ──────────────────────────────────────────────────────────────

async function partB() {
  sec("B. The objects are server-only; the SQL switch and the pool rule agree with settings.mjs");
  const tables = ["share_jobs", "lead_shares", "upload_batch_leads", "cron_runs"];
  const o = await one(
    `SELECT bool_and((SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)) AS rls,
            bool_or(has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || t, 'SELECT')) AS readable
       FROM unnest($1::text[]) t`,
    [tables]
  );
  ok("share_jobs, lead_shares, upload_batch_leads and cron_runs: RLS on, nothing for anon or authenticated", o.rls === true && o.readable === false, JSON.stringify(o));
  const fns = ["fn_share_fits(uuid[], text)", "fn_share_rule_fits(uuid[], text)", "fn_remove_tag(text, text)", "fn_client_pool_value(jsonb, text, text)",
    "fn_client_pool(text)", "fn_overlap_sharing_on(text)", "fn_client_receive_block(text)", "fn_client_can_receive(text)"];
  const f = await one(
    `SELECT bool_or(has_function_privilege('anon', 'public.' || f, 'EXECUTE') OR has_function_privilege('authenticated', 'public.' || f, 'EXECUTE')) AS callable
       FROM unnest($1::text[]) f`,
    [fns]
  );
  ok("the share functions are not callable by anon or authenticated", f.callable === false, JSON.stringify(f));

  const cases = [
    ["off", { enabled: false, tags: [T("O")] }, T("O")],
    ["on, listed", { enabled: true, tags: [T("O")] }, T("O")],
    ["on, listed in lower case, asked with spaces", { enabled: true, tags: [T("o")] }, ` ${T("O")} `],
    ["on, not listed", { enabled: true, tags: [T("B")] }, T("O")],
    ["enabled as text", { enabled: "true", tags: [T("O")] }, T("O")],
    ["tags not a list", { enabled: true, tags: T("O") }, T("O")],
    ["star", { enabled: true, tags: ["*"] }, T("O")],
    ["asked for nothing", { enabled: true, tags: [T("O")] }, ""],
  ];
  const bad = [];
  const c = await pool.connect();
  try {
    for (const [label, value, tag] of cases) {
      await c.query("BEGIN");
      await c.query(`INSERT INTO enrich_settings (key, value) VALUES ('overlap_sharing', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(value)]);
      const { rows: [r] } = await c.query(`SELECT public.fn_overlap_sharing_on($1) AS on`, [tag]);
      await c.query("ROLLBACK");
      const js = flagOn(settingsFrom([{ key: "overlap_sharing", value }]), "overlap_sharing", tag);
      if (r.on !== js) bad.push(`${label}: sql ${r.on} js ${js}`);
    }
  } finally {
    c.release();
  }
  ok(`fn_overlap_sharing_on agrees with flagOn("overlap_sharing") in ${cases.length} cases`, bad.length === 0, bad.join("; "));

  const poolCases = [];
  const valueSets = [{}, { pools: { cleaning: ["Cleaning", "Canada Cleaning"] }, isolated_tag_suffixes: ["-OS"] }, { pools: { zeta: ["Cleaning"], alpha: ["cleaning ", "Other"] } },
    { pools: {} }, { isolated_tag_suffixes: [] }, { pools: "x" }];
  for (const v of valueSets) {
    for (const [tag, type] of [[T("A"), "Cleaning"], [T("A"), " canada cleaning "], [T("A-OS"), "Cleaning"], [T("A"), "Non-Cleaning"], [T("A"), null], [T("A"), "Other"]]) {
      poolCases.push([v, tag, type]);
    }
  }
  const disagree = [];
  for (const [v, tag, type] of poolCases) {
    const { rows: [r] } = await pool.query(`SELECT public.fn_client_pool_value($1::jsonb, $2, $3) AS p`, [JSON.stringify(v), tag, type]);
    const js = clientPool(settingsFrom([{ key: "overlap_sharing", value: v }]), tag, type);
    if (r.p !== js) disagree.push(`${JSON.stringify(v)} ${tag} ${type}: sql ${r.p} js ${js}`);
  }
  ok(`fn_client_pool_value agrees with clientPool() in ${poolCases.length} cases`, disagree.length === 0, disagree.slice(0, 3).join("; "));
}

// ── C. Lead lists ───────────────────────────────────────────────────────────

let importer = null;
const HEADERS = ["Email", "Company", "City", "State"];
async function upload(slug, rows, { strategy = "merge", tags = [T("O")], dryRun = undefined } = {}) {
  const id = await batch(slug, { tags, status: "processing", completed: null });
  const counters = await importer.importRows(pool, rows, {
    batchId: id, filename: `${FILE}${RUN}-${slug}.csv`, headers: HEADERS, fieldMapping: MAPPING, duplicateStrategy: strategy, overrideFields: [],
    addTags: tags, dryRun,
  });
  await pool.query(`UPDATE upload_batches SET status = 'complete', inserted_rows = $2, merged_rows = $3, completed_at = now() WHERE id = $1`, [id, counters.inserted, counters.merged]);
  return { id, counters };
}
const listed = async (id) => (await all(`SELECT u.outcome, l.email FROM upload_batch_leads u JOIN leads l ON l.id = u.lead_id WHERE u.batch_id = $1 ORDER BY l.email`, [id]));

async function partC() {
  sec("C. Lead lists through the real import");
  importer = await import(new URL("lib/uploads/import-rows.ts", SRC).href);
  await setSharing({ enabled: false });
  ok("the switch off: leadListOn() says no", (await importer.leadListOn(pool)) === false);
  const off = await upload("list-off", [[mail("loff1"), "Off Co", "Reno", "NV"], [mail("loff2"), "Off Co", "Reno", "NV"]]);
  ok("the switch off: two new leads, no list", off.counters.inserted === 2 && (await listed(off.id)).length === 0);

  await setSharing({ enabled: true, tags: [] });
  ok("the switch on (even with no client listed): leadListOn() says yes", (await importer.leadListOn(pool)) === true);
  ok("a failing read means no list, never a failed import", (await importer.leadListOn({ query: async () => { throw Object.assign(new Error("boom"), { code: "42P01" }); } })) === false);
  const first = await upload("list-new", [[mail("lnew1"), "New Co", "Reno", "NV"], [mail("lnew2"), "New Co", "Reno", "NV"], [mail("lnew3"), "", "Reno", "NV"]]);
  const l1 = await listed(first.id);
  ok("new leads are listed, outcome new", first.counters.inserted === 3 && l1.length === 3 && l1.every((r) => r.outcome === "new"), JSON.stringify(l1));
  const second = await upload("list-merge", [
    [mail("lnew3"), "Filled Co", "Reno", "NV"], // a blank filled: updated
    [mail("lnew1"), "New Co", "Reno", "NV"], // nothing changes: not listed
    [mail("lnew4"), "Four Co", "Reno", "NV"], // new
    ["not an email", "No Co", "Reno", "NV"], // held back
  ]);
  const l2 = await listed(second.id);
  ok("a merge lists the changed lead as updated and the new one as new, not the unchanged one nor the held-back row",
    same(l2.map((r) => [r.email.split("-")[0], r.outcome]), [["lnew3", "updated"], ["lnew4", "new"]]), JSON.stringify(l2));
  const skip = await upload("list-skip", [[mail("lnew2"), "Other Co", "Reno", "NV"], [mail("lnew5"), "Five Co", "Reno", "NV"]], { strategy: "skip" });
  const l3 = await listed(skip.id);
  ok("under skip, a lead already there is not listed; the new one is", same(l3.map((r) => [r.email.split("-")[0], r.outcome]), [["lnew5", "new"]]), JSON.stringify(l3));
  let inside = null;
  const dry = await upload("list-dry", [[mail("ldry1"), "Dry Co", "Reno", "NV"]], {
    dryRun: { inspect: async (c) => { inside = (await c.query(`SELECT count(*)::int AS n FROM upload_batch_leads u JOIN upload_batches b ON b.id = u.batch_id WHERE b.filename LIKE $1`, [`%-list-dry.csv`])).rows[0].n; } },
  });
  ok("a dry run lists inside its transaction and leaves nothing", inside === 1 && (await listed(dry.id)).length === 0 &&
    !(await one(`SELECT 1 AS x FROM leads WHERE email = $1`, [mail("ldry1")])), `inside ${inside}`);
  ok("import-rows.ts lists in processChunk's own transaction, from ins and changed", /await listed\(ins\.map\(\(r\) => r\.id as string\), "new"\);/.test(source("src/lib/uploads/import-rows.ts")) &&
    /await listed\(changed\.map\(\(r\) => r\.id as string\), "updated"\);/.test(source("src/lib/uploads/import-rows.ts")));
}

// ── D. The batch's client and run ───────────────────────────────────────────

async function partD() {
  sec("D. The batch's client and run (beginAdd, beginPromote, add-run.ts)");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const { rows: [t] } = await c.query(`INSERT INTO enrich_tables (client_tag, kind, name) VALUES ($1, 'ai_ark', 'shtest add') RETURNING id`, [T("O")]);
    const { rows: [run] } = await c.query(
      `INSERT INTO aiark_runs (client_tag, mode, strategy, size_requested, table_id, filters, requests) VALUES ($1, 'live', 'single', 10, $2, $3::jsonb, '[{}]'::jsonb) RETURNING id`,
      [T("O"), t.id, JSON.stringify({ [TOPUP_FILTER_KEY]: { pass: null, pull: null, places: ["Reno, NV"] } })]
    );
    const addRow = async (key, email) => {
      const { rows: [r] } = await c.query(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, $2, 'done') RETURNING id`, [t.id, key]);
      await c.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) VALUES ($1, 'outcome', $2, 'done', '"Ready to add"'), ($1, 'email', $2, 'done', to_jsonb($3::text))`, [r.id, t.id, email]);
    };
    await addRow("a1", mail("add1"));
    const tagged = await beginAdd(c, { tableId: t.id, userId: null, filename: `${FILE}${RUN}-add.csv`, clientTag: ` ${T("o")} `, runId: run.id });
    const b1 = (await c.query(`SELECT add_tags, aiark_run_id FROM upload_batches WHERE id = $1`, [tagged.batchId])).rows[0];
    ok("beginAdd records the run's client tag (as normTag gives it) and the run", same(b1.add_tags, [T("O")]) && b1.aiark_run_id === run.id, JSON.stringify(b1));
    await c.query(`UPDATE upload_batches SET status = 'complete' WHERE id = $1`, [tagged.batchId]);
    await addRow("a2", mail("add2"));
    const plain = await beginAdd(c, { tableId: t.id, userId: null, filename: `${FILE}${RUN}-add2.csv` });
    const b2 = (await c.query(`SELECT add_tags, aiark_run_id FROM upload_batches WHERE id = $1`, [plain.batchId])).rows[0];
    ok("without them, both stay null, as before", b2.add_tags === null && b2.aiark_run_id === null, JSON.stringify(b2));
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
  const ar = source("src/lib/aiark/add-run.ts");
  ok("the AI Ark add hands beginAdd the run's client tag and id", /beginAdd\(c, \{ tableId: run\.table_id, userId, filename, clientTag: run\.client_tag, runId: run\.id \}\)/.test(ar));
  const pm = source("scripts/lib/enrich/promote.mjs");
  const m = /`(INSERT INTO upload_batches \(uploaded_by, filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type, source_label,\s*add_tags\)\s*VALUES \(\$1, \$2, \$3, 'processing', 'skip', \$4::jsonb, \$5::jsonb, 'leads', \$6, ARRAY\[\$7::text\]\)\s*RETURNING id, created_at)`,\s*\[\s*userId, filename, toAdd\.length,[\s\S]*?label,\s*tag,\s*\]/.exec(pm);
  ok("beginPromote's batch insert writes add_tags = ARRAY[tag]", Boolean(m));
  if (m) {
    const c2 = await pool.connect();
    try {
      await c2.query("BEGIN");
      const { rows: [r] } = await c2.query(m[1].replace("RETURNING id, created_at", "RETURNING add_tags"), [null, `${FILE}${RUN}-promote.csv`, 1, "{}", "[]", "Companies (AI Ark)", T("O")]);
      ok("... and the statement works on this database", same(r.add_tags, [T("O")]), JSON.stringify(r));
    } finally {
      await c2.query("ROLLBACK").catch(() => {});
      c2.release();
    }
  }
}

// ── E. Discovery ────────────────────────────────────────────────────────────

const B = {}; // batch ids by name
async function partE() {
  sec("E. Discovery");
  await setSharing({ enabled: true, tags: LIST, since: SINCE });
  const runTopup = (await one(
    `INSERT INTO aiark_runs (client_tag, mode, strategy, size_requested, filters, requests, status) VALUES ($1, 'live', 'single', 10, $2::jsonb, '[{}]'::jsonb, 'done') RETURNING id`,
    [T("O"), JSON.stringify({ [TOPUP_FILTER_KEY]: { pass: null, pull: null, places: ["NV (state-wide)"] } })]
  )).id;
  const runPlain = (await one(
    `INSERT INTO aiark_runs (client_tag, mode, strategy, size_requested, filters, requests, status) VALUES ($1, 'live', 'single', 10, '{}'::jsonb, '[{}]'::jsonb, 'done') RETURNING id`,
    [T("O")]
  )).id;
  const L = await lead("disc1");
  B.before = await batch("d-before", { created: new Date(Date.now() - 6 * 3600_000).toISOString(), inserted: 1 });
  await list(B.before, [L]);
  B.ok = await batch("d-ok", { inserted: 1, run: runPlain });
  await list(B.ok, [L]);
  B.topup = await batch("d-topup", { inserted: 1, run: runTopup });
  await list(B.topup, [L]);
  B.nolist = await batch("d-nolist", { inserted: 5 });
  B.nulltags = await batch("d-nulltags", { tags: null, inserted: 1 });
  B.notag = await batch("d-notag", { tags: [], inserted: 1 });
  B.notclient = await batch("d-notclient", { tags: ["SHTEST_NOT_A_CLIENT", "Q4 list"], inserted: 1 });
  B.several = await batch("d-several", { tags: [T("O"), T("B")], inserted: 1 });
  B.offlist = await batch("d-offlist", { tags: [T("H")], inserted: 1 });
  B.isolated = await batch("d-isolated", { tags: [T("F")], inserted: 1 });
  B.suffix = await batch("d-suffix", { tags: [T("G-OS")], inserted: 1 });
  B.updatedonly = await batch("d-updated", { inserted: 0 });
  await list(B.updatedonly, [L], "updated");
  B.nothing = await batch("d-nothing", { inserted: 0 });
  B.bison = await batch("d-bison", { mapping: null, inserted: 1 });
  B.live = await batch("d-live", { status: "processing", completed: null, inserted: 1 });
  B.dead = await batch("d-dead", { status: "processing", completed: null, created: new Date(Date.now() - 4 * 3600_000).toISOString(), inserted: 1 });
  await list(B.dead, [L]);

  const mine = await myBatches();
  const foreign = await one(`SELECT count(*)::int AS n FROM upload_batches WHERE created_at >= $1 AND NOT (id = ANY($2::uuid[])) AND batch_type = 'leads'`, [SINCE, mine]);
  ok("no other import in the window this test looks at (so no foreign batch gets a job)", foreign.n === 0, `${foreign.n} foreign`);
  if (foreign.n) throw new Error("foreign batches in the window: stopping before discovery touches them");

  ok("the switch off: nothing found", (await discoverJobs(pool, { settings: settingsFrom([{ key: "overlap_sharing", value: { ...BASE(), enabled: false } }]) })).found === 0);
  ok("no since: nothing found", (await discoverJobs(pool, { settings: settingsFrom([{ key: "overlap_sharing", value: { ...BASE(), since: null } }]) })).found === 0);
  ok("... and no job was made", (await one(`SELECT count(*)::int AS n FROM share_jobs WHERE batch_id = ANY($1::uuid[])`, [mine])).n === 0);
  const settings = await settingsNowT();
  const d1 = await discoverJobs(pool, { settings });
  const d2 = await discoverJobs(pool, { settings });
  ok("discovery gives each batch one job: a second pass finds nothing", d1.found > 0 && d2.found === 0, JSON.stringify({ d1, d2 }));
  const want = {
    before: null, ok: ["waiting", null], topup: ["waiting", null], nolist: ["no_lead_list", null], nulltags: ["skipped", "before"], notag: ["skipped", "no_tag"],
    notclient: ["skipped", "not_client"], several: ["skipped", "several"], offlist: ["skipped", "origin_not_on_list"], isolated: ["skipped", "origin_isolated"],
    suffix: ["skipped", "origin_isolated"], updatedonly: ["skipped", "no_new_leads"], nothing: ["skipped", "no_new_leads"], bison: null, live: null,
    dead: ["waiting", null],
  };
  for (const [name, w] of Object.entries(want)) {
    const j = await job(B[name]);
    if (!w) ok(`${name}: not looked at`, !j, JSON.stringify(j));
    else ok(`${name}: ${w[0]}${w[1] ? ` (${w[1]}: ${SHARE_SKIP_REASONS[w[1]]})` : ""}`, j?.state === w[0] && j?.reason === w[1], JSON.stringify(j && { state: j.state, reason: j.reason }));
  }
  const t = await job(B.topup);
  const o = await job(B.ok);
  ok("a top-up run's batch is marked topup; another AI Ark run's is not", t.topup === true && o.topup === false);
  ok("a waiting job: its origin, pool, mode, new leads and the wait limit (batch_done_at + wait_location_minutes)",
    o.origin_tag === T("O") && o.origin_pool === "cleaning" && o.mode === "preview" && o.new_leads === 1 &&
      new Date(o.place_wait_until).getTime() - new Date(o.batch_done_at).getTime() === 180 * 60_000);
  const dead = await job(B.dead);
  const deadBatch = await one(`SELECT created_at FROM upload_batches WHERE id = $1`, [B.dead]);
  ok("a batch left processing for 3 hours counts as finished at created_at + 3 hours", new Date(dead.batch_done_at).getTime() - new Date(deadBatch.created_at).getTime() === 3 * 3600_000);
  ok("skipped jobs name their origin when it is a client, none otherwise",
    (await job(B.offlist)).origin_tag === T("H") && (await job(B.notclient)).origin_tag === null);
  // The jobs made here are not decided further: out of the way of the next parts.
  await pool.query(`UPDATE share_jobs SET next_try_at = now() + interval '1 day' WHERE batch_id = ANY($1::uuid[])`, [mine]);
}

// ── F. The place wait ───────────────────────────────────────────────────────

async function partF() {
  sec("F. The place wait, through a real location run, the limit, the recheck");
  const settings = await settingsNowT();
  // Leads as an import leaves them: place text, no location fields yet.
  const ids = {
    reno: await lead("wait1", { status: null, city: "Reno", state: "NV", stateText: "NV" }),
    junk: await lead("wait2", { status: null, city: "Nowhere", state: "NV", stateText: "North America" }),
  };
  const id = await batch("e-wait", { inserted: 2 });
  await list(id, Object.values(ids));
  await waitingJob(id, { doneAgo: "1 minute" });
  await locationRun({ started: new Date(Date.now() - 3600_000).toISOString() });
  ok("a location run that started before the import finished does not free the job", (await claimDue(pool)) === null);

  const dry = spawnSync(process.execPath, [fileURLToPath(new URL("./backfill-lead-locations.mjs", import.meta.url)), "--dry-run"], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 240_000 });
  const afterDry = await one(`SELECT started_at FROM cron_runs WHERE name = $1`, [CRON_LOCATION_BACKFILL]);
  ok("the backfill's dry run records nothing in cron_runs", dry.status === 0 && new Date(afterDry.started_at).getTime() < Date.now() - 30 * 60_000, (dry.stderr || dry.stdout).slice(-300));
  const before = new Date();
  const real = spawnSync(process.execPath, [fileURLToPath(new URL("./backfill-lead-locations.mjs", import.meta.url))], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 240_000 });
  const cr = await one(`SELECT started_at, finished_at, finished_run_started_at FROM cron_runs WHERE name = $1`, [CRON_LOCATION_BACKFILL]);
  ok("a backfill run records its start and, finished, finished_run_started_at = its own start", real.status === 0 && new Date(cr.started_at) >= new Date(before.getTime() - 5000) &&
    cr.finished_run_started_at && new Date(cr.finished_run_started_at).getTime() === new Date(cr.started_at).getTime() && new Date(cr.finished_at) >= new Date(cr.started_at),
  JSON.stringify(cr) + (real.stderr || "").slice(-200));
  const placed = await one(`SELECT location_status, state_code, location_id::text AS location_id FROM leads WHERE id = $1`, [ids.reno]);
  const junk = await one(`SELECT location_status FROM leads WHERE id = $1`, [ids.junk]);
  ok("the run placed the Reno lead and left the junk state text at NULL (backfill-lead-locations.mjs pass 1b)", placed.location_status === "resolved" && placed.location_id === GEO.reno && junk.location_status === null, JSON.stringify({ placed, junk }));

  const taken = await claimDue(pool);
  ok("a location run that started after the import finished frees the job: it is taken, not at its limit", taken?.batch_id === id && taken.hit_now === false && taken.state === "deciding", JSON.stringify(taken && { b: taken.batch_id, hit: taken.hit_now }));
  const r = await decideJob(pool, taken, { settings });
  const j = await job(id);
  ok("the junk-state lead does not hold the job: decided, one lead with no usable place, a recheck tomorrow within the window",
    r === "decided" && j.state === "previewed" && j.leads_no_place === 1 && j.next_recheck_at && j.recheck_until &&
      Math.abs(new Date(j.next_recheck_at).getTime() - (new Date(j.decided_at).getTime() + 86_400_000)) < 120_000,
    JSON.stringify({ r, s: j.state, n: j.leads_no_place, next: j.next_recheck_at, until: j.recheck_until }));
  const rows = await rowsOf(id);
  ok("the placed lead was decided for B (Reno city) and C (state-wide, same group): B owns it",
    rows.get(`${ids.reno}|${T("B")}`)?.outcome === "shared" && rows.get(`${ids.reno}|${T("C")}`)?.outcome === "also_fits", JSON.stringify([...rows.values()].map((x) => [x.receiver_tag, x.outcome])));

  // The no-place lead gets its place later: the daily recheck decides it.
  await pool.query(`UPDATE leads SET state = 'NV', state_code = 'NV', country_code = 'US', location_status = 'resolved', location_id = $2::bigint WHERE id = $1`, [ids.junk, GEO.sparks]);
  await pool.query(`UPDATE share_jobs SET next_recheck_at = now() - interval '1 minute' WHERE batch_id = $1`, [id]);
  const re = await recheckOne(pool, { settings });
  const j2 = await job(id);
  const rows2 = await rowsOf(id);
  ok("the recheck picks up the lead that got its place: decided (Sparks: C only), no lead left without a place, no more rechecks",
    re?.looked === 1 && j2.leads_no_place === 0 && j2.next_recheck_at === null && rows2.get(`${ids.junk}|${T("C")}`)?.outcome === "shared" && !rows2.has(`${ids.junk}|${T("B")}`) &&
      j2.counts[T("C")]?.checked === 2, JSON.stringify({ re, n: j2.leads_no_place, next: j2.next_recheck_at, c: j2.counts[T("C")] }));

  // The limit: no location run passes the import, the job is taken at its limit with the notice.
  const id2 = await batch("e-limit", { inserted: 1 });
  await list(id2, [await lead("wait3")]);
  await waitingJob(id2, { doneAgo: "4 hours" });
  await locationRun({ started: new Date(Date.now() - 6 * 3600_000).toISOString() });
  const t2 = await claimDue(pool);
  ok("at its limit the job is taken, and place_wait_hit_at marks the red notice", t2?.batch_id === id2 && t2.hit_now === true && t2.place_wait_hit_at, JSON.stringify(t2 && { hit: t2.hit_now }));
  await decideJob(pool, t2, { settings });
  ok("... and decided with the places known now", (await job(id2)).state === "previewed");

  // An applied job whose daily look finds nothing new stays applied, with the admin who applied it.
  const id3 = await batch("e-applied", { inserted: 2 });
  await list(id3, [await lead("wait4"), await lead("wait5", { status: null, city: "Nowhere", state: null, stateText: "North America" })]);
  await waitingJob(id3);
  await decide(id3, settings);
  const admin = randomUUID();
  await applyShareJob(pool, { batchId: id3, userId: admin });
  await pool.query(`UPDATE share_jobs SET next_recheck_at = now() - interval '1 minute' WHERE batch_id = $1`, [id3]);
  const re3 = await recheckOne(pool, { settings });
  const j3 = await job(id3);
  ok("an applied job's daily look that finds nothing new: still applied, its applier and mode kept, the lead with no place still counted",
    re3?.batchId === id3 && re3.looked === 0 && j3.state === "applied" && j3.applied_by === admin && j3.mode === "preview" && j3.leads_no_place === 1 && j3.next_recheck_at !== null,
    JSON.stringify({ re3, s: j3.state, by: j3.applied_by, m: j3.mode, n: j3.leads_no_place }));
  // Undone, so the tag writer of part J sees only part I's shares.
  await undoShareJob(pool, { batchId: id3, userId: admin });
}

// ── G. Fit and the receive rule ─────────────────────────────────────────────

async function partG() {
  sec("G. The fit and the receive rule");
  const ids = {
    good: await lead("fit1"),
    mimecast: await lead("fit2", { esp: "Mimecast" }),
    bounced: await lead("fit3", { bounced: true }),
    invalid: await lead("fit4", { validation: "invalid" }),
    catchall: await lead("fit5", { validation: "catch_all" }),
    unvalidated: await lead("fit6", { validation: null }),
    noplace: await lead("fit7", { status: null, city: null, state: null }),
    partial: await lead("fit8", { status: "partial", city: "Smalltown", geo: null }),
    otherstate: await lead("fit9", { city: "Provo", state: "UT" }),
    suppressed: await lead("fit10"),
  };
  await pool.query(`UPDATE leads SET is_suppressed = true WHERE id = $1`, [ids.suppressed]);
  const list10 = Object.values(ids);
  const fits = async (tag, fn = "fn_share_fits") => new Set((await all(`SELECT lead_id FROM public.${fn}($1::uuid[], $2)`, [list10, tag])).map((r) => r.lead_id));
  const c = await fits(T("C"));
  const expect = new Set([ids.good, ids.catchall, ids.unvalidated, ids.partial]);
  ok("fn_share_fits(C): the rules plus the extras (an email, not bounced, not suppressed, valid or catch-all or unchecked, a usable place, not Mimecast)",
    same([...c].sort(), [...expect].sort()), JSON.stringify([...c].map((x) => Object.keys(ids).find((k) => ids[k] === x))));
  const conds = (await one(`SELECT array_to_string(fn_client_eligibility_conditions($1), ' AND ') AS w`, [T("C")])).w;
  const plain = new Set((await all(
    `SELECT l.id FROM leads l WHERE l.id = ANY($1::uuid[]) AND l.email IS NOT NULL AND l.email <> '' AND l.is_bounced = false AND l.is_suppressed = false
        AND (l.validation_status IN ('valid', 'catch_all') OR l.validation_status IS NULL)
        AND l.location_status IN ('resolved', 'partial') AND (l.esp IS NULL OR l.esp <> 'Mimecast') AND ${conds}`,
    [list10]
  )).map((r) => r.id));
  ok("... exactly fn_client_eligibility_conditions plus the extras", same([...c].sort(), [...plain].sort()));
  const looseRule = (await one(`SELECT array_to_string(fn_client_eligibility_conditions($1), ' AND ') AS w`, [T("O")])).w;
  const loose = await one(`SELECT count(*)::int AS n FROM leads l WHERE l.id = $1 AND ${looseRule}`, [ids.noplace]);
  ok("a lead with no place passes the push rule of a client with require_location false (O), but never fits it for sharing",
    loose.n === 1 && !(await fits(T("O"), "fn_share_rule_fits")).has(ids.noplace));

  const reasons = {
    [T("P")]: "status Paused", [T("NT")]: "not on the Groups tab", [T("CN")]: "churn date", [T("CP")]: "churn date", [T("CU")]: "churn cell unreadable",
    [T("NR")]: "no rules row", [T("NP")]: "no places", [T("CO")]: "a country-wide place", [T("NG")]: "no group",
  };
  const bad = [];
  for (const [tag, want] of Object.entries(reasons)) {
    const r = (await one(`SELECT public.fn_client_receive_block($1) AS b`, [tag])).b;
    const got = await fits(tag);
    if (!String(r ?? "").startsWith(want) || got.size) bad.push(`${tag}: ${r} (${got.size} fit)`);
  }
  ok(`the receive rule blocks with its reason, and fn_share_fits gives nothing: ${Object.values(reasons).length} cases`, bad.length === 0, bad.join("; "));
  ok("Healthy, a churn date beyond 15 days and a non-answer pass", (await one(`SELECT public.fn_client_can_receive($1) AND public.fn_client_can_receive($2) AND public.fn_client_can_receive($3) AS x`, [T("HE"), T("CL"), T("NA")])).x === true);
  // A cleared churn cell clears the block.
  await pool.query(`UPDATE client_tags SET churn_cell_state = 'empty', churn_date = NULL, churn_cell = NULL WHERE tag = $1`, [T("CN")]);
  ok("a churn cell cleared: the client can receive again", (await one(`SELECT public.fn_client_receive_block($1) AS b`, [T("CN")])).b === null);
  await pool.query(`UPDATE client_tags SET churn_cell_state = 'date', churn_date = (now() AT TIME ZONE 'utc')::date + 5, churn_cell = 'soon' WHERE tag = $1`, [T("CN")]);
}

// ── H. Candidates ───────────────────────────────────────────────────────────

async function partH() {
  sec("H. Candidates: the list, pools, the receive rule, places");
  const settings = await settingsNowT();
  const nv = [{ id: "x", country_code: "US", state_code: "NV", location_id: null }];
  const got = (await candidateReceivers(pool, { settings, originTag: T("O"), originPool: "cleaning", leads: nv })).map((r) => r.tag);
  ok("NV leads: the listed clients of the cleaning pool that can receive and name NV (B, C, D), never the origin",
    same(got, [T("B"), T("C"), T("D")]), JSON.stringify(got));
  ok("left out: another pool's and isolated clients (F Non-Cleaning, G-OS), a client off the list (H), one that cannot receive (P), one without NV (E)",
    ![T("F"), T("G-OS"), T("H"), T("P"), T("E")].some((t) => got.includes(t)));
  const ut = (await candidateReceivers(pool, { settings, originTag: T("O"), originPool: "cleaning", leads: [{ id: "y", country_code: "US", state_code: "UT", location_id: null }] })).map((r) => r.tag);
  ok("a Canada Cleaning client is in the cleaning pool: E for UT leads (with I and J)", ut.includes(T("E")) && ut.includes(T("I")) && ut.includes(T("J")), JSON.stringify(ut));
  const isolatedOrigin = await candidateReceivers(pool, { settings, originTag: T("F"), originPool: null, leads: nv });
  ok("an isolated origin has no candidates", isolatedOrigin.length === 0);
  const otherPool = settingsFrom([{ key: "overlap_sharing", value: { ...BASE(), pools: { cleaning: ["Cleaning"], canada: ["Canada Cleaning"] } } }]);
  const sep = (await candidateReceivers(pool, { settings: otherPool, originTag: T("O"), originPool: "cleaning", leads: [{ id: "y", country_code: "US", state_code: "UT", location_id: null }] })).map((r) => r.tag);
  ok("pools come from the settings: with Canada Cleaning in a pool of its own, E leaves the cleaning pool's candidates", !sep.includes(T("E")) && sep.includes(T("I")), JSON.stringify(sep));
}

// ── I. Dedupe, the same group rule, owners, the filter ──────────────────────

const H = {};
async function partI() {
  sec("I. Every dedupe reason, the same group rule, owners, the stand-in filter");
  await setFilter(true);
  const settings = await settingsNowT();
  ok("the stand-in filter is loaded (a made-up pattern, sha matching)", settings.never_contact_inboxes.pattern === PATTERN);
  const L = {
    reno: await lead("h-reno"),
    sparks: await lead("h-sparks", { city: "Sparks" }),
    sent: await lead("h-sent"),
    gathering: await lead("h-gathering"),
    pending: await lead("h-pending", { city: "Sparks" }),
    shared: await lead("h-shared", { city: "Sparks" }),
    tagged: await lead("h-tagged", { city: "Sparks", tags: `${T("O")}, ${T("c")} ,Outlook` }),
    near: await lead("h-near", { city: "Sparks", tags: `${T("O")},${T("CX")}` }),
    groupsent: await lead("h-groupsent", { city: "Sparks" }),
    grouplive: await lead("h-grouplive", { city: "Sparks" }),
    originfits: await lead("h-originfits", { city: "Henderson" }),
    originno: await lead("h-originno", { city: "Henderson", company: "Shtestvending Partners" }),
    inbox: await lead("h-inbox", { city: "Henderson", type: "general", email: `shtestbox@inbox-${RUN}.${HOST}` }),
    personal: await lead("h-personal", { city: "Henderson", type: "personal", email: `shtestbox@person-${RUN}.${HOST}` }),
    ut1: await lead("h-ut1", { city: "Provo", state: "UT" }),
    id1: await lead("h-id1", { city: "Boise", state: "ID" }),
  };
  Object.assign(H, L);
  // B (group 102) already sent h-sent; B gathers h-gathering; B has a pending item for h-pending in a processing batch.
  await pushBatch(T("B"), { status: "complete", items: [[L.sent, "sent"], [L.groupsent, "sent"]] });
  await pushBatch(T("B"), { status: "gathering", ids: [L.gathering] });
  await pushBatch(T("C"), { status: "processing", items: [[L.pending, "pending"]] });
  await pushBatch(T("B"), { status: "pending", ids: [L.grouplive] });
  await pushBatch(T("C"), { status: "cancelled", items: [[L.sparks, "pending"]] }); // a cancelled push's leftover item is not in flight
  // C got h-shared from an earlier job, applied.
  const earlier = await batch("h-earlier", { inserted: 1 });
  await list(earlier, [L.shared]);
  await pool.query(`INSERT INTO share_jobs (batch_id, origin_tag, state, batch_done_at, new_leads) VALUES ($1, $2, 'applied', now(), 1)`, [earlier, T("O")]);
  // Its tag was looked at already (tag_added_at), so the tag writer of part J leaves it out.
  await pool.query(`INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, applied_at, tag_added_at) VALUES ($1, $2, $3, $4, 'shared', now(), now())`,
    [earlier, L.shared, T("O"), T("C")]);
  // Coverage: J has fewer available leads in UT than I.
  await pool.query(
    `INSERT INTO client_location_coverage (client_tag, threshold, total_available, payload) VALUES
       ($1, 500, 900, '{"locations": [{"kind": "state", "country": "US", "state": "UT", "city": null, "available": 900}]}'),
       ($2, 500, 100, '{"locations": [{"kind": "state", "country": "US", "state": "UT", "city": null, "available": 100}]}')`,
    [T("I"), T("J")]
  );
  H.batch = await batch("h-job", { inserted: Object.keys(L).length });
  await list(H.batch, Object.values(L));
  await waitingJob(H.batch);
  const leadState = async () => (await one(
    `SELECT string_agg(id || ':' || coalesce(tags, '') || ':' || updated_at, '|' ORDER BY id) AS s FROM leads WHERE id = ANY($1::uuid[])`, [Object.values(L)])).s;
  const pushCount = async () => (await one(`SELECT count(*)::int AS n FROM push_batches`)).n;
  const before = { leads: await leadState(), pushes: await pushCount() };
  const r = await decide(H.batch, settings);
  ok("a preview decide writes nothing to leads (tags, updated_at) or push_batches", (await leadState()) === before.leads && (await pushCount()) === before.pushes);
  const j = await job(H.batch);
  const rows = await rowsOf(H.batch);
  const of = (k, tag) => rows.get(`${L[k]}|${T(tag)}`)?.outcome ?? null;
  ok("decided and previewed, with its receivers chosen once (B C D E I J KQ M), each done",
    r === "decided" && j.state === "previewed" && same(j.receivers, [T("B"), T("C"), T("D"), T("E"), T("I"), T("J"), T("KQ"), T("M")]) &&
      same([...j.receivers_done].sort(), [...j.receivers].sort()), JSON.stringify({ r, s: j.state, rec: j.receivers }));
  const want = [
    ["reno", "B", "shared", "B's list names Reno: B owns it"], ["reno", "C", "also_fits", "C (same group, state only) also fits"],
    ["sparks", "C", "shared", "Sparks: only C fits (B lists Reno only); a cancelled push's leftover item is not in flight"],
    ["sent", "B", "already_sent", "a push item sent for B"], ["sent", "C", "same_install", "sent for B, so C (same group) is same_install"],
    ["gathering", "B", "in_flight", "a B push still gathering holds it in selected_ids"], ["gathering", "C", "same_install", "... and C, same group, is same_install"],
    ["pending", "C", "in_flight", "a pending item of a C push being processed"],
    ["shared", "C", "already_shared", "an applied share to C from another job"],
    ["tagged", "C", "already_tagged", "the lead carries C's tag (spaces and case aside)"],
    ["near", "C", "shared", "a longer tag that starts with C's is not C's tag"],
    ["groupsent", "C", "same_install", "sent for B (same group) is same_install for C"],
    ["grouplive", "C", "same_install", "a B push still pending holds it: same_install for C"],
    ["originfits", "D", "same_install", "D is in the origin's group: a lead that fits the origin stays with the origin"],
    ["originno", "D", "shared", "a lead the origin's rules exclude goes to D"],
    ["inbox", "C", "filtered_inbox", "a general inbox the stand-in filter matches"], ["inbox", "D", "filtered_inbox", "... for every receiver"],
    ["personal", "C", "shared", "the same address shape on a personal lead is never filtered"],
    ["ut1", "J", "shared", "UT: J has fewer available leads there than I"], ["ut1", "I", "also_fits", "... so I also fits"], ["ut1", "E", "shared", "E (Canada Cleaning, its own group) gets it too"],
    ["id1", "KQ", "shared", "ID: no counts known, tag order: KQ before M"], ["id1", "M", "also_fits", "... M also fits"],
  ];
  for (const [k, tag, outcome, why] of want) ok(`${why}: ${k} to ${tag} is ${outcome}`, of(k, tag) === outcome, of(k, tag));
  const place = rows.get(`${L.reno}|${T("B")}`)?.matched_place;
  const cplace = rows.get(`${L.reno}|${T("C")}`)?.matched_place;
  ok("matched_place: B's Reno city entry, C's state entry", sameObj(place, { country: "US", state: "NV", city: "Reno", label: "Reno, NV" }) &&
    sameObj(cplace, { country: "US", state: "NV", city: null, label: "NV (state-wide)" }), JSON.stringify({ place, cplace }));
  ok("the counts per receiver: checked, fits and each outcome", j.counts[T("C")]?.checked === Object.keys(L).length && j.counts[T("B")]?.shared === 1 &&
    j.counts[T("C")]?.filtered_inbox === 1, JSON.stringify(j.counts[T("C")]));
  ok("nothing fits a lead out of every receiver's states: no row for H's leads to F, G-OS, H or P", ![...rows.values()].some((x) => [T("F"), T("G-OS"), T("H"), T("P")].includes(x.receiver_tag)));
  ok("pickOwner: the city first, then fewer available (unknown last), then tag order",
    pickOwner([{ tag: "B2", place: { city: null }, available: 1 }, { tag: "B3", place: { city: "X" }, available: 999 }]) === "B3" &&
    pickOwner([{ tag: "B2", place: null, available: null }, { tag: "B3", place: null, available: 5 }]) === "B3" &&
    pickOwner([{ tag: "B3", place: null, available: null }, { tag: "B2", place: null, available: null }]) === "B2");
  ok("the reasons statement uses the stand-in filter only when one is loaded", reasonsSql(true).includes("~*") && !reasonsSql(false).includes("$6"));
}

// ── J. Preview, apply, tags, undo ───────────────────────────────────────────

async function partJ() {
  sec("J. Preview writes only its rows; apply, the paced tags, undo");
  const id = H.batch;
  const countsBefore = await one(`SELECT (SELECT count(*) FROM push_batches)::int AS pb, (SELECT max(updated_at) FROM leads WHERE email LIKE $1) AS lu,
    (SELECT string_agg(coalesce(tags, ''), '|' ORDER BY id) FROM leads WHERE email LIKE $1) AS tags`, [`%.${HOST}`]);
  ok("none of the preview's rows is applied",
    (await one(`SELECT count(*)::int AS n FROM lead_shares WHERE batch_id = $1 AND applied_at IS NOT NULL`, [id])).n === 0);
  const userId = randomUUID();
  const pv = await previewShareJob(pool, { batchId: id, receiver: T("C") });
  ok("previewShareJob: before (stored) and now (decided again), no write", pv.receivers.length === 1 && pv.receivers[0].tag === T("C") &&
    pv.receivers[0].before.shared === pv.receivers[0].now.shared && pv.receivers[0].overCap === false, JSON.stringify(pv));
  // The rules change before the apply: C now excludes the Sparks company term, so its Sparks share goes.
  await pool.query(`UPDATE client_targeting SET exclude_terms = ARRAY['h-sparks Co'] WHERE client_tag = $1`, [T("C")]);
  const pv2 = await previewShareJob(pool, { batchId: id, receiver: T("C") });
  ok("preview shows the difference after a rule change (one share fewer for C)", pv2.receivers[0].now.shared === pv2.receivers[0].before.shared - 1, JSON.stringify(pv2.receivers[0]));
  const ap = await applyShareJob(pool, { batchId: id, receiver: T("C"), userId });
  const rows = await rowsOf(id);
  ok("apply decides again: the Sparks lead no longer fits C, its row is gone; the rest of C's shares are applied, nothing queued (C not on push_tags)",
    !rows.has(`${H.sparks}|${T("C")}`) && ap.applied[T("C")] === pv2.receivers[0].now.shared && ap.queued[T("C")] === 0 &&
      [...rows.values()].filter((x) => x.receiver_tag === T("C") && x.outcome === "shared").every((x) => x.applied_at && x.push_state === null),
    JSON.stringify(ap));
  const j1 = await job(id);
  ok("one receiver applied: the job stays previewed, C on receivers_applied", j1.state === "previewed" && j1.receivers_applied.includes(T("C")));
  const again = await applyShareJob(pool, { batchId: id, receiver: T("C"), userId });
  ok("a second apply changes nothing", again.applied[T("C")] === 0);
  const countsAfter = await one(`SELECT (SELECT count(*) FROM push_batches)::int AS pb, (SELECT string_agg(coalesce(tags, ''), '|' ORDER BY id) FROM leads WHERE email LIKE $1) AS tags`, [`%.${HOST}`]);
  ok("apply with write_tags off: no tag written, no push made", countsAfter.pb === countsBefore.pb && countsAfter.tags === countsBefore.tags);
  const off = await writeTags(pool, { settings: await settingsNowT(), memory: newUpkeepMemory() });
  ok("the tag writer does nothing while write_tags is off", off.added === 0 && off.removed === 0);

  // Tags on, paced: 2 a round, 3 a day.
  await setSharing({ write_tags: true, tag_rows_per_day: 3 });
  const mem = newUpkeepMemory();
  const toTag = (await all(`SELECT lead_id FROM lead_shares WHERE batch_id = $1 AND outcome = 'shared' AND applied_at IS NOT NULL ORDER BY lead_id`, [id])).map((r) => r.lead_id);
  const t1 = await writeTags(pool, { settings: await settingsNowT(), memory: mem, perRound: 2 });
  const t2 = await writeTags(pool, { settings: await settingsNowT(), memory: mem, perRound: 2 });
  const t3 = await writeTags(pool, { settings: await settingsNowT(), memory: mem, perRound: 2 });
  ok(`paced: 2, then 1 (the day's 3), then none (${toTag.length} to tag)`, t1.added === 2 && t2.added === 1 && t3.added === 0 && t3.left === 0, JSON.stringify({ t1, t2, t3 }));
  const tagged = await all(`SELECT l.tags, s.tag_added FROM lead_shares s JOIN leads l ON l.id = s.lead_id WHERE s.batch_id = $1 AND s.tag_added`, [id]);
  ok("each tag written is the exact client tag, added to the lead's own tags", tagged.length === 3 && tagged.every((x) => /(^|,)SHTEST_C(,|$)/.test(x.tags) && x.tags.includes(T("O"))), JSON.stringify(tagged));
  const hist = await one(`SELECT count(*)::int AS n FROM lead_history WHERE lead_id = ANY($1::uuid[]) AND notes LIKE 'Shared from ${T("O")} to ${T("C")}%'`, [toTag]);
  ok("a history row with each tag written", hist.n === 3);
  // A lead that got C's tag elsewhere before the writer came: no write, tag_added stays false.
  const rest = (await all(`SELECT lead_id FROM lead_shares WHERE batch_id = $1 AND outcome = 'shared' AND applied_at IS NOT NULL AND NOT tag_added AND receiver_tag = $2`, [id, T("C")])).map((r) => r.lead_id);
  await pool.query(`UPDATE leads SET tags = tags || ',' || $2 WHERE id = $1`, [rest[0], T("C")]);
  await setSharing({ write_tags: true, tag_rows_per_day: 20000 });
  const t4 = await writeTags(pool, { settings: await settingsNowT(), memory: newUpkeepMemory() });
  const r0 = await one(`SELECT tag_added, tag_added_at FROM lead_shares WHERE batch_id = $1 AND lead_id = $2 AND receiver_tag = $3`, [id, rest[0], T("C")]);
  ok("a lead that carries the tag already is looked at once and left alone (tag_added false)", r0.tag_added === false && r0.tag_added_at !== null && t4.added === rest.length - 1, JSON.stringify({ r0, t4 }));

  // Undo C: its shares undone, tags it wrote taken off (paced), the one it did not write kept.
  const und = await undoShareJob(pool, { batchId: id, receiver: T("C"), userId });
  ok("undo of one receiver: its live shares undone, the 3 tags it wrote to take off, nothing pushed", und.undone === 4 && und.tagsToRemove === 3 && und.pushedLeads === 0 && same(und.cancelledPushes, []), JSON.stringify(und));
  const j2 = await job(id);
  ok("... the job keeps its state, C leaves receivers_applied", j2.state === "previewed" && !j2.receivers_applied.includes(T("C")));
  const rm = await writeTags(pool, { settings: await settingsNowT(), memory: newUpkeepMemory() });
  const left = await all(`SELECT l.tags, s.tag_added FROM lead_shares s JOIN leads l ON l.id = s.lead_id WHERE s.batch_id = $1 AND s.receiver_tag = $2 AND s.outcome = 'shared'`, [id, T("C")]);
  const kept = await one(`SELECT tags FROM leads WHERE id = $1`, [rest[0]]);
  ok("undo takes off only the tags sharing wrote; the one already there stays", rm.removed === und.tagsToRemove && left.filter((x) => x.tag_added).every((x) => !/(^|,)SHTEST_C(,|$)/.test(x.tags ?? "")) &&
    /(^|,)SHTEST_C(,|$)/.test(kept.tags), JSON.stringify({ rm, kept }));
  await pool.query(`UPDATE client_targeting SET exclude_terms = '{}' WHERE client_tag = $1`, [T("C")]);
  await setSharing({});
  // Without the filter the inbox lead would be a share: preview says so (the setting is read fresh).
  await setFilter(false);
  const pv3 = await previewShareJob(pool, { batchId: id, receiver: T("D") });
  ok("with the filter unloaded, a fresh preview no longer counts a filtered inbox", !pv3.receivers[0].now.filtered_inbox && pv3.receivers[0].before.filtered_inbox === 1, JSON.stringify(pv3.receivers[0]));
}

// ── L. Caps ─────────────────────────────────────────────────────────────────

async function partL() {
  sec("L. Caps in apply mode: only for receivers whose shares are pushed");
  await setSharing({ mode: "apply", push_tags: [T("KQ")], push_max_per_job: 1, push_max_per_day: 2000 });
  const settings = await settingsNowT();
  const ids = [await lead("j-id1", { city: "Boise", state: "ID" }), await lead("j-id2", { city: "Boise", state: "ID" }), await lead("j-ut1", { city: "Provo", state: "UT" })];
  const id = await batch("j-job", { inserted: 3 });
  await list(id, ids);
  await waitingJob(id, { mode: "apply" });
  await decide(id, settings);
  const j = await job(id);
  const rows = await rowsOf(id);
  ok("KQ (on push_tags) with 2 shares over push_max_per_job 1: left at preview on receivers_over_cap", j.receivers_over_cap.includes(T("KQ")) &&
    [...rows.values()].filter((x) => x.receiver_tag === T("KQ") && x.outcome === "shared").every((x) => !x.applied_at), JSON.stringify(j.receivers_over_cap));
  ok("J and E (not on push_tags) are applied with no cap, push_state null", [...rows.values()].filter((x) => [T("J"), T("E")].includes(x.receiver_tag) && x.outcome === "shared").every((x) => x.applied_at && x.push_state === null) &&
    j.receivers_applied.includes(T("J")));
  ok("the job stays previewed for an admin", j.state === "previewed" && j.mode === "apply");
  const pv = await previewShareJob(pool, { batchId: id, receiver: T("KQ") });
  ok("the preview says KQ is over a cap", pv.receivers[0].overCap === true);
  const ap = await applyShareJob(pool, { batchId: id, receiver: T("KQ"), userId: randomUUID() });
  const j2 = await job(id);
  ok("an admin applies KQ over the cap: applied and queued, KQ off the over-cap list, the job applied", ap.applied[T("KQ")] === 2 && ap.queued[T("KQ")] === 2 &&
    !j2.receivers_over_cap.includes(T("KQ")) && j2.state === "applied" && j2.applied_by !== null, JSON.stringify({ ap, s: j2.state }));
  // The day cap: KQ has 2 shares to be pushed, applied today; with a day cap of 2, one more is over.
  await setSharing({ mode: "apply", push_tags: [T("KQ")], push_max_per_job: 1000, push_max_per_day: 2 });
  const id2 = await batch("j-job2", { inserted: 1 });
  await list(id2, [await lead("j-id3", { city: "Boise", state: "ID" })]);
  await waitingJob(id2, { mode: "apply" });
  await decide(id2, await settingsNowT());
  ok("over push_max_per_day with today's pushed shares: left at preview", (await job(id2)).receivers_over_cap.includes(T("KQ")));
  await setSharing({ mode: "apply", push_tags: [T("KQ")], push_max_per_day: 2000 });
  const id3 = await batch("j-job3", { inserted: 1 });
  await list(id3, [await lead("j-id4", { city: "Boise", state: "ID" })]);
  await waitingJob(id3, { mode: "apply" });
  await decide(id3, await settingsNowT());
  const j3 = await job(id3);
  const r3 = [...(await rowsOf(id3)).values()].find((x) => x.receiver_tag === T("KQ"));
  ok("within the caps: applied by the step (applied_by null) and queued", j3.state === "applied" && j3.applied_by === null && r3?.push_state === "queued", JSON.stringify({ s: j3.state, r3 }));
  // A job discovered in preview mode never applies itself, even once the setting says apply.
  const id4 = await batch("j-job4", { inserted: 1 });
  await list(id4, [await lead("j-id5", { city: "Boise", state: "ID" })]);
  await waitingJob(id4, { mode: "preview" });
  await decide(id4, await settingsNowT());
  ok("a job made in preview mode stays previewed though the setting is apply now (forced preview, as the seed's)", (await job(id4)).state === "previewed" && (await job(id4)).mode === "preview");
  await setSharing({});
}

// ── M. own_topup ────────────────────────────────────────────────────────────

async function partM() {
  sec("M. own_topup for a top-up batch");
  await setSharing({ push_tags: [T("O")] });
  const settings = await settingsNowT();
  const ids = [await lead("k-1", { city: "Henderson" }), await lead("k-2", { city: "Henderson", company: "Shtestvending Two" })];
  const id = await batch("k-topup", { inserted: 2 });
  await list(id, ids);
  await waitingJob(id, { topup: true });
  await decide(id, settings);
  const j = await job(id);
  const rows = await rowsOf(id);
  ok("the origin is a receiver of its own top-up job", j.receivers.includes(T("O")));
  ok("its fitting lead is own_topup, though the import stamped its tag (never already_tagged for the origin)",
    rows.get(`${ids[0]}|${T("O")}`)?.outcome === "own_topup", rows.get(`${ids[0]}|${T("O")}`)?.outcome);
  ok("a lead the origin's rules exclude is no own_topup row", !rows.has(`${ids[1]}|${T("O")}`));
  ok("D (the origin's group) still gets only what the origin cannot use", rows.get(`${ids[1]}|${T("D")}`)?.outcome === "shared" && rows.get(`${ids[0]}|${T("D")}`)?.outcome === "same_install");
  const ap = await applyShareJob(pool, { batchId: id, receiver: T("O"), userId: randomUUID() });
  ok("applied, own_topup is queued for the origin's push (the origin on push_tags)", ap.queued[T("O")] === 1 && rows.get(`${ids[0]}|${T("O")}`) && (await one(
    `SELECT push_state FROM lead_shares WHERE batch_id = $1 AND lead_id = $2 AND receiver_tag = $3`, [id, ids[0], T("O")])).push_state === "queued");
  const plain = await batch("k-plain", { inserted: 1 });
  await list(plain, [await lead("k-3", { city: "Henderson" })]);
  await waitingJob(plain);
  await decide(plain, settings);
  ok("a job that is no top-up has no own_topup row", !(await job(plain)).receivers.includes(T("O")));
  await setSharing({});
}

// ── N. Actions ──────────────────────────────────────────────────────────────

async function partN() {
  sec("N. The actions' refusals, retry and undo of a whole job");
  const u = randomUUID();
  const errs = async (p) => {
    try {
      await p;
      return null;
    } catch (e) {
      return e instanceof ShareActionError ? `${e.status}` : `other: ${e.message}`;
    }
  };
  ok("a bad id is 400, an unknown job 404", (await errs(previewShareJob(pool, { batchId: "nope" }))) === "400" && (await errs(applyShareJob(pool, { batchId: randomUUID(), userId: u }))) === "404");
  ok("a waiting job can't be previewed or applied: 409", (await errs(previewShareJob(pool, { batchId: B.ok }))) === "409");
  ok("a receiver that is not the job's: 404", (await errs(previewShareJob(pool, { batchId: H.batch, receiver: T("H") }))) === "404");
  ok("apply needs a user id", (await errs(applyShareJob(pool, { batchId: H.batch, userId: "x" }))) === "400");
  await setSharing({ enabled: false });
  ok("apply while sharing is off: 409", (await errs(applyShareJob(pool, { batchId: H.batch, userId: u }))) === "409");
  await setSharing({});
  // A receiver that can no longer receive is skipped, with the reason.
  await pool.query(`UPDATE client_tags SET status = 'Paused' WHERE tag = $1`, [T("M")]);
  const ap = await applyShareJob(pool, { batchId: H.batch, userId: u });
  ok("an apply skips a receiver that cannot receive, with the reason", ap.skipped[T("M")] === "cannot receive: status Paused", JSON.stringify(ap.skipped));
  await pool.query(`UPDATE client_tags SET status = 'Active' WHERE tag = $1`, [T("M")]);
  // Undo the whole job: a share push not gathered yet is cancelled; another job's share in it goes back to queued.
  const pb = await pushBatch(T("B"), { status: "pending", source: "share" });
  const bRow = await one(`SELECT lead_id FROM lead_shares WHERE batch_id = $1 AND receiver_tag = $2 AND outcome = 'shared' AND applied_at IS NOT NULL`, [H.batch, T("B")]);
  await pool.query(`UPDATE lead_shares SET push_state = 'pushed', push_batch_id = $3, pushed_at = now() WHERE batch_id = $1 AND lead_id = $2 AND receiver_tag = $4`, [H.batch, bRow.lead_id, pb, T("B")]);
  const otherJob = await batch("l-other", { inserted: 1 });
  const ol = await lead("l-other1");
  await list(otherJob, [ol]);
  await pool.query(`INSERT INTO share_jobs (batch_id, origin_tag, state, batch_done_at, new_leads) VALUES ($1, $2, 'applied', now(), 1)`, [otherJob, T("O")]);
  await pool.query(`INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, applied_at, push_state, push_batch_id, pushed_at) VALUES ($1, $2, $3, $4, 'shared', now(), 'pushed', $5, now())`, [otherJob, ol, T("O"), T("B"), pb]);
  const und = await undoShareJob(pool, { batchId: H.batch, userId: u });
  const pbAfter = await one(`SELECT status, error FROM push_batches WHERE id = $1`, [pb]);
  const otherRow = await one(`SELECT push_state, push_batch_id FROM lead_shares WHERE batch_id = $1`, [otherJob]);
  const mineRow = await one(`SELECT push_state, push_note, undone_at FROM lead_shares WHERE batch_id = $1 AND lead_id = $2 AND receiver_tag = $3`, [H.batch, bRow.lead_id, T("B")]);
  ok("undo of the whole job: the share push not gathered yet is cancelled and named", pbAfter.status === "cancelled" && same(und.cancelledPushes, [pb]) && und.pushedLeads === 0, JSON.stringify({ pbAfter, und }));
  ok("... the undone share in it is dropped (undone), the other job's share in it is queued again", mineRow.push_state === "dropped" && mineRow.push_note === "undone" && mineRow.undone_at &&
    otherRow.push_state === "queued" && otherRow.push_batch_id === null, JSON.stringify({ mineRow, otherRow }));
  ok("the job is undone", (await job(H.batch)).state === "undone" && (await errs(undoShareJob(pool, { batchId: H.batch, userId: u }))) === "409");
  // Retry: a job in error goes back to waiting; a previewed job that did not wait the limit can't.
  await pool.query(`UPDATE share_jobs SET state = 'error', attempts = 6, last_error = 'made up' WHERE batch_id = $1`, [B.ok]);
  const rt = await retryShareJob(pool, { batchId: B.ok, userId: u });
  const jr = await job(B.ok);
  ok("retry sends a job in error back to waiting, tries reset", rt.state === "waiting" && jr.state === "waiting" && jr.attempts === 0 && jr.last_error === null);
  const prev = await one(`SELECT batch_id FROM share_jobs WHERE state = 'previewed' AND place_wait_hit_at IS NULL AND batch_id = ANY($1::uuid[]) LIMIT 1`, [await myBatches()]);
  ok("a previewed job that did not wait its limit can't be retried: 409", (await errs(retryShareJob(pool, { batchId: prev.batch_id, userId: u }))) === "409");
  await pool.query(`UPDATE share_jobs SET next_try_at = now() + interval '1 day' WHERE batch_id = $1`, [B.ok]);
}

// ── O. The worker ───────────────────────────────────────────────────────────

async function partO() {
  sec("O. The worker's wiring, and whole rounds");
  const ws = source("scripts/enrich-worker.mjs");
  ok("it reports the sharing capability, pushed beside the others (the upload suites read the array's own text)",
    /CAPABILITIES\.push\(SHARING_CAPABILITY\);/.test(ws) && SHARING_CAPABILITY === "sharing" && /const CAPABILITIES = \[[^\]]*"held_release"[^\]]*UPLOAD_CAPABILITY\];/.test(ws));
  ok("its own pool: 2 connections, the 70 s query timeout, 30 s to connect",
    /const sharePool = new pg\.Pool\(\{[^}]*max: 2,[^}]*connectionTimeoutMillis: 30_000,[^}]*query_timeout: 70_000,/.test(ws));
  ok("every 60 s, not awaited, with a busy flag", /if \(Date\.now\(\) - lastShare > SHARE_EVERY_MS\) \{\s*lastShare = Date\.now\(\);\s*shareInFlight = shareStep\(\);\s*\}/.test(ws) &&
    /async function shareStep\(\) \{\s*if \(shareBusy\) return;\s*shareBusy = true;/.test(ws) && /\} finally \{\s*shareBusy = false;/.test(ws));
  ok("a missing migration is said once and the step stays idle", /if \(SHARE_UNREADY\.has\(e\?\.code\)\) \{\s*if \(!shareUnreadyLogged\)/.test(ws));
  ok("a stopping worker waits for the round in flight, then closes its pool, before the main pool",
    /await fits;[\s\S]*await shareInFlight;\s*await sharePool\.end\(\)[\s\S]*await pool\.end\(\)/.test(ws));
  ok("the 60-second block is as it was", /if \(Date\.now\(\) - lastSweep > 60_000\) \{\s*await reclaimStale\(\);\s*await releaseHeld\(\);\s*await moveUploads\(\);\s*await releaseHeldPeople\(\);\s*lastSweep = Date\.now\(\);/.test(ws));

  const untouched = { query: async () => { throw new Error("no statement may run"); }, connect: async () => { throw new Error("no connection may be taken"); } };
  const off = await shareRound(untouched, { settings: settingsFrom([]), memory: newShareMemory() });
  const noSince = await shareRound(untouched, { settings: settingsFrom([{ key: "overlap_sharing", value: { ...BASE(), since: null } }]), memory: newShareMemory() });
  ok("off, or on with no since, a round runs no statement at all", off.idle === true && noSince.idle === true);
  const missing = { query: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); },
    connect: async () => ({ query: async (sql) => { if (/^(BEGIN|SET|ROLLBACK)/.test(sql)) return { rows: [] }; throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); }, release() {} }) };
  let code = null;
  try {
    await shareRound(missing, { settings: await settingsNowT(), memory: newShareMemory() });
  } catch (e) {
    code = e.code;
  }
  ok("a missing migration (42P01) ends the round with that code, for the worker to say once", code === "42P01");

  // A whole round, as the worker runs it: a new import is found, waits, and is decided.
  const id = await batch("m-round", { inserted: 1 });
  await list(id, [await lead("m-1", { city: "Provo", state: "UT" })]);
  await locationRun({ started: new Date(Date.now() + 60_000).toISOString() });
  const lines = [];
  const r = await shareRound(pool, { settings: await settingsNowT(), memory: newShareMemory(), log: (l) => lines.push(l) });
  const j = await job(id);
  ok("a round: the import found, past the location run, decided and previewed", r.discovered >= 1 && j?.state === "previewed" && r.errors.length === 0, JSON.stringify({ r, s: j?.state, lines: lines.slice(0, 3) }));
}

// ── P. The push timer ───────────────────────────────────────────────────────

async function partP() {
  sec("P. The push timer");
  const settings = await settingsNowT();
  const calls = [];
  const stub = async (u, init) => {
    calls.push({ url: String(u), auth: init.headers.authorization, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ receiver: JSON.parse(init.body).receiver, pushed: 1, batches: ["x"], held: 0, dropped: 0, left: 0, note: null }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = { SHARE_PUSH_KEY: "k".repeat(40), SHARE_PUSH_URL: "https://web.shtest.example" };
  const mem = newUpkeepMemory();
  let clock = 1_000_000;
  const now = () => clock;
  const queued = await all(`SELECT DISTINCT receiver_tag FROM lead_shares WHERE push_state = 'queued' ORDER BY 1`);
  ok("there are queued shares (KQ's and O's, from parts L and M)", queued.length >= 1, JSON.stringify(queued));
  const lines = [];
  const none = await pushTimer(pool, { settings, memory: mem, env: {}, fetchImpl: stub, now, log: (l) => lines.push(l) });
  await pushTimer(pool, { settings, memory: mem, env: {}, fetchImpl: stub, now, log: (l) => lines.push(l) });
  ok("without the key and address: nothing asked, said once", none.length === 0 && calls.length === 0 && lines.length === 1 && /SHARE_PUSH_KEY/.test(lines[0]), JSON.stringify(lines));
  const first = await pushTimer(pool, { settings, memory: mem, env, fetchImpl: stub, now });
  ok("with them: one POST per receiver with queued shares, to the route, with the Bearer key",
    first.length === queued.length && calls.every((c) => c.url === "https://web.shtest.example/api/sharing/push/auto" && c.auth === `Bearer ${"k".repeat(40)}`) &&
      same(calls.map((c) => c.body).sort((a, b) => (a.receiver < b.receiver ? -1 : 1)), queued.map((q) => ({ receiver: q.receiver_tag }))), JSON.stringify(calls));
  clock += 10 * 60_000;
  ok("not again within push_every_minutes (15)", (await pushTimer(pool, { settings, memory: mem, env, fetchImpl: stub, now })).length === 0);
  clock += 6 * 60_000;
  ok("again after it", (await pushTimer(pool, { settings, memory: mem, env, fetchImpl: stub, now })).length === queued.length);
  // Held shares: tried again once a day while inside held_retry_days.
  const heldRow = await one(`SELECT id, receiver_tag FROM lead_shares WHERE push_state = 'queued' ORDER BY id LIMIT 1`);
  await pool.query(`UPDATE lead_shares SET push_state = 'held', push_note = 'no B2C campaign', held_since = now(), held_at = now() WHERE id = $1`, [heldRow.id]);
  calls.length = 0;
  const h1 = await pushTimer(pool, { settings, memory: mem, env, fetchImpl: stub, now });
  ok("held shares inside held_retry_days: asked again with retryHeld", h1.some((x) => x.retryHeld && x.receiver === heldRow.receiver_tag) && calls.some((c) => c.body.retryHeld === true));
  clock += 3600_000;
  calls.length = 0;
  await pushTimer(pool, { settings, memory: mem, env, fetchImpl: stub, now });
  ok("... once a day only", !calls.some((c) => c.body.retryHeld));
  await pool.query(`UPDATE lead_shares SET held_since = now() - interval '8 days' WHERE id = $1`, [heldRow.id]);
  clock += 2 * 86_400_000;
  calls.length = 0;
  await pushTimer(pool, { settings, memory: mem, env, fetchImpl: stub, now });
  ok("held past held_retry_days: no longer asked", !calls.some((c) => c.body.retryHeld));
}

// ── R. The prune ────────────────────────────────────────────────────────────

async function partR() {
  sec("R. The prune");
  const oldDone = await batch("o-old", { inserted: 1 });
  const ol = await lead("o-1");
  await list(oldDone, [ol]);
  await pool.query(`INSERT INTO share_jobs (batch_id, origin_tag, state, batch_done_at, decided_at, new_leads) VALUES ($1, $2, 'previewed', now() - interval '40 days', now() - interval '31 days', 1)`, [oldDone, T("O")]);
  await pool.query(`INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, decided_at) VALUES ($1, $2, $3, $4, 'also_fits', now() - interval '91 days'), ($1, $2, $3, $5, 'shared', now() - interval '91 days')`,
    [oldDone, ol, T("O"), T("C"), T("B")]);
  const waiting = await batch("o-waiting", { inserted: 1 });
  await list(waiting, [ol]);
  await pool.query(`INSERT INTO share_jobs (batch_id, origin_tag, state, batch_done_at, new_leads, created_at) VALUES ($1, $2, 'waiting', now() - interval '40 days', 1, now() - interval '40 days')`, [waiting, T("O")]);
  const mem = newUpkeepMemory();
  const p = await prune(pool, { memory: mem, force: true });
  ok("the list of a job decided 31 days ago goes; a waiting job's list stays", (await listed(oldDone)).length === 0 && (await listed(waiting)).length === 1, JSON.stringify(p));
  const left = await all(`SELECT outcome FROM lead_shares WHERE batch_id = $1`, [oldDone]);
  ok("a row that is no share, decided 91 days ago, goes; a share stays", same(left.map((x) => x.outcome), ["shared"]), JSON.stringify(left));
  ok("at most hourly", (await prune(pool, { memory: mem })) === null);
  await pool.query(`UPDATE share_jobs SET next_try_at = now() + interval '1 day' WHERE batch_id = $1`, [waiting]);
}

// ── S. The seed ─────────────────────────────────────────────────────────────

async function partS() {
  sec("S. The seed script");
  // Two old imports, made before their batches could list leads, in windows of their own.
  const t0 = new Date(Date.now() - 50 * 3600_000);
  const b1 = await batch("p-one", { created: t0.toISOString(), completed: new Date(t0.getTime() + 600_000).toISOString(), inserted: 2 });
  const b2 = await batch("p-two", { created: new Date(t0.getTime() + 3600_000).toISOString(), completed: new Date(t0.getTime() + 4200_000).toISOString(), inserted: 1 });
  const at = async (who, ms, tags = T("O")) => {
    const id = await lead(who, { tags });
    await pool.query(`UPDATE leads SET created_at = $2 WHERE id = $1`, [id, new Date(t0.getTime() + ms).toISOString()]);
    return id;
  };
  await at("p-1", 60_000);
  await at("p-2", 120_000, `Outlook,${T("o")}`);
  await at("p-3", 180_000, T("B")); // another client's lead in the same window: not O's
  await at("p-4", 3_700_000);
  const plan = await seedPlan(pool, { tag: T("O"), batchIds: [b1, b2] });
  ok("the plan: each batch's new leads beside its inserted rows, by its own window and the origin's tag", plan.ok && same(plan.batches.map((b) => b.ids.length), [2, 1]) && plan.found === 3 && plan.expected === 3 && !plan.together,
    JSON.stringify({ ok: plan.ok, p: plan.problems, n: plan.batches.map((b) => b.ids.length) }));
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("./share-seed.mjs", import.meta.url)), "--tag", T("O"), "--batch", b1, "--batch", b2],
    { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 60_000 });
  ok("the script is dry by default: it says what --write would write, and writes nothing", cli.status === 0 && /dry run: nothing was written/.test(cli.stdout) &&
    !(await job(b1)) && (await listed(b1)).length === 0, cli.stdout + cli.stderr);
  await pool.query(`UPDATE upload_batches SET inserted_rows = 5 WHERE id = $1`, [b2]);
  const badCli = spawnSync(process.execPath, [fileURLToPath(new URL("./share-seed.mjs", import.meta.url)), "--tag", T("O"), "--batch", b1, "--batch", b2, "--write"],
    { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 60_000 });
  ok("a count that differs from the inserted rows stops it, even with --write", badCli.status === 1 && /stop: batch .* 1 lead\(s\) found, but it inserted 5/.test(badCli.stdout) && !(await job(b1)), badCli.stdout);
  await pool.query(`UPDATE upload_batches SET inserted_rows = 1 WHERE id = $1`, [b2]);
  const good = await seedPlan(pool, { tag: T("O"), batchIds: [b1, b2] });
  const pushesBefore = (await one(`SELECT count(*)::int AS n FROM push_batches`)).n;
  const leadsBefore = await one(`SELECT max(updated_at) AS u, count(*)::int AS n FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  const w = await seedWrite(pool, good);
  const j1 = await job(b1);
  ok("--write: each batch's leads listed (new) and one share job per batch, forced to preview, waiting", w.listed === 3 && w.jobs === 2 && j1.state === "waiting" && j1.mode === "preview" &&
    j1.new_leads === 2 && (await listed(b1)).every((x) => x.outcome === "new"), JSON.stringify({ w, s: j1.state, m: j1.mode }));
  const leadsAfter = await one(`SELECT max(updated_at) AS u, count(*)::int AS n FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  ok("nothing else: no lead changed, no push", (await one(`SELECT count(*)::int AS n FROM push_batches`)).n === pushesBefore && same(leadsAfter, leadsBefore));
  const again = await seedPlan(pool, { tag: T("O"), batchIds: [b1] });
  ok("a batch seeded already is refused", !again.ok && again.problems.some((x) => /share job already/.test(x)));
  // Overlapping windows: all leads to the first batch's one job.
  const t1 = new Date(Date.now() - 30 * 3600_000);
  const b3 = await batch("p-three", { created: t1.toISOString(), completed: new Date(t1.getTime() + 600_000).toISOString(), inserted: 1 });
  const b4 = await batch("p-four", { created: t1.toISOString(), completed: new Date(t1.getTime() + 600_000).toISOString(), inserted: 1 });
  const x1 = await lead("p-5");
  const x2 = await lead("p-6");
  await pool.query(`UPDATE leads SET created_at = $2 WHERE id = ANY($1::uuid[])`, [[x1, x2], new Date(t1.getTime() + 60_000).toISOString()]);
  const ov = await seedPlan(pool, { tag: T("O"), batchIds: [b3, b4] });
  ok("overlapping windows: the leads of all windows against the inserted rows added up, all to the first batch's one job",
    ov.ok && ov.together && ov.writes.length === 1 && ov.writes[0].batchId === b3 && ov.writes[0].ids.length === 2, JSON.stringify({ ok: ov.ok, p: ov.problems, t: ov.together }));
  await pool.query(`UPDATE share_jobs SET next_try_at = now() + interval '1 day' WHERE batch_id = ANY($1::uuid[])`, [[b1, b2]]);
}

// ── T. Scale smoke ──────────────────────────────────────────────────────────

function planNodes(plan) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    out.push(n);
    for (const k of n.Plans ?? []) walk(k);
  };
  walk(plan[0].Plan);
  return out;
}

/**
 * The plan of a statement as the planner would make it on the production
 * table (9.8M leads): here leads holds a few thousand made-up rows, so a scan,
 * reading every placed lead in a place or status index's order, or a hash or
 * merge join over a whole index is cheaper, and the planner takes it. With
 * those small-table shortcuts off, the plan shows whether the statement is
 * served from the job's ids (an index condition on them); an unanchored
 * statement could not be. `bitmap`: only bitmap paths for a single-table
 * statement, so 2,000 key matches are read by page as Postgres reads them,
 * not priced as 2,000 random reads against a table this small.
 */
async function explain(sql, params, { bitmap = false } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const off = bitmap ? ["enable_seqscan", "enable_indexscan", "enable_indexonlyscan"] : ["enable_seqscan", "enable_bitmapscan", "enable_hashjoin", "enable_mergejoin"];
    for (const k of off) await c.query(`SET LOCAL ${k} = off`);
    const { rows: [r] } = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return planNodes(r["QUERY PLAN"]);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

async function partT() {
  sec("T. Scale smoke: 2,000 made-up leads against 90 made-up clients");
  const scale = [];
  for (let i = 1; i <= 90; i++) {
    const s = `S${String(i).padStart(2, "0")}`;
    const places = i % 3 === 0 ? [NV({ city: "Reno" }), NV({ city: "Sparks" })] : i % 3 === 1 ? [NV()] : [NV(), { country: "US", state: "UT" }];
    await client(s, { group: 1000 + Math.ceil(i / 2), places, requireLocation: true });
    scale.push(T(s));
  }
  LIST = [...LIST, ...scale];
  await setSharing({});
  const settings = await settingsNowT();
  const cities = ["Reno", "Sparks", "Henderson", "Carson City", "Elko"];
  const { rows: made } = await pool.query(
    `INSERT INTO leads (email, company, city, state, state_code, country, country_code, location_status, location_id, tags, email_type, validation_status)
     SELECT 'q' || g || '-' || $1 || '@q-co.' || $2, 'Scale Co ' || g, c.city, 'NV', 'NV', 'USA', 'US', 'resolved', c.geo::bigint, $3, 'personal', 'valid'
       FROM generate_series(1, 2000) g
       JOIN LATERAL (SELECT ($4::text[])[1 + (g % 5)] AS city, ($5::text[])[1 + (g % 5)] AS geo) c ON true
     RETURNING id`,
    [RUN, HOST, T("O"), cities, [GEO.reno, GEO.sparks, GEO.henderson, "5501344", "5703670"]]
  );
  const ids = made.map((r) => r.id);
  const id = await batch("q-scale", { inserted: ids.length });
  await list(id, ids);
  await waitingJob(id);
  const t0 = Date.now();
  const r = await decide(id, settings);
  const ms = Date.now() - t0;
  const j = await job(id);
  const n = await one(`SELECT count(*)::int AS rows, count(DISTINCT receiver_tag)::int AS receivers, count(*) FILTER (WHERE outcome = 'shared')::int AS shared,
                              count(*) FILTER (WHERE outcome = 'also_fits')::int AS also FROM lead_shares WHERE batch_id = $1`, [id]);
  const pairs = await one(`SELECT count(*)::int AS n FROM (SELECT s.lead_id, ct.group_no FROM lead_shares s JOIN client_tags ct ON ct.tag = s.receiver_tag
                             WHERE s.batch_id = $1 AND s.outcome = 'shared' GROUP BY 1, 2 HAVING count(*) > 1) x`, [id]);
  ok(`2,000 leads against the 90 clients decided in ${(ms / 1000).toFixed(1)} s: every scale client a receiver, each Bison group one owner a lead`,
    r === "decided" && j.receivers.filter((t) => t.startsWith(T("S"))).length === 90 && n.shared > 0 && n.also > 0 && pairs.n === 0, JSON.stringify({ r, ms, n, pairs }));
  ok("a round's worth of work: under a minute here", ms < 60_000, `${ms} ms`);

  // The production table holds millions of placed leads in the same places as a job's new ones, so
  // reading every placed lead (in a place or status index's order) is no shortcut there. 10,000
  // made-up placed leads in the same cities stand in for them here, and the statistics are
  // refreshed (the local table was empty when last looked at).
  await pool.query(
    `INSERT INTO leads (email, company, city, state, state_code, country, country_code, location_status, location_id, tags, email_type, validation_status)
     SELECT 'qf' || g || '-' || $1 || '@qf-co.' || $2, 'Filler Co ' || g, c.city, 'NV', 'NV', 'USA', 'US', 'resolved', c.geo::bigint, 'Outlook', 'personal', 'valid'
       FROM generate_series(1, 10000) g
       JOIN LATERAL (SELECT ($3::text[])[1 + (g % 5)] AS city, ($4::text[])[1 + (g % 5)] AS geo) c ON true`,
    [RUN, HOST, cities, [GEO.reno, GEO.sparks, GEO.henderson, "5501344", "5703670"]]
  );
  await pool.query(`ANALYZE public.leads, public.lead_shares, public.upload_batch_leads, public.push_items, public.push_batches`);
  // fn_share_rule_fits's statement (134), for a receiver with a state-wide place (S01) and one with city places (S03).
  const fitSqlOf = async (tag) => `SELECT l.id FROM public.leads l
      WHERE l.id = ANY ($1::uuid[])
        AND l.email IS NOT NULL AND l.email <> '' AND l.is_bounced = false AND l.is_suppressed = false
        AND (l.validation_status IN ('valid', 'catch_all') OR l.validation_status IS NULL)
        AND l.location_status IN ('resolved', 'partial')
        AND (l.esp IS NULL OR l.esp <> ALL (ARRAY['Mimecast']::text[]))
        AND ${(await one(`SELECT array_to_string(fn_client_eligibility_conditions($1), ' AND ') AS w`, [tag])).w}`;
  const big = new Set(["leads", "lead_shares", "push_items", "upload_batch_leads", "lead_history"]);
  const scans = (nodes) => nodes.filter((x) => x["Node Type"] === "Seq Scan" && big.has(x["Relation Name"])).map((x) => x["Relation Name"]);
  const usesPk = (nodes) => nodes.some((x) => x["Index Name"] === "leads_pkey" && /\bid\b/.test(x["Index Cond"] ?? ""));
  const fitPlan = await explain(await fitSqlOf(T("S01")), [ids], { bitmap: true });
  const show = (nodes) => JSON.stringify(nodes.map((x) => [x["Node Type"], x["Relation Name"], x["Index Name"], x["Index Cond"]]));
  ok("EXPLAIN of a receiver's fit statement (fn_share_rule_fits's text, 2,000 ids, a state-wide place): the primary key on the ids, never a scan of leads",
    usesPk(fitPlan) && scans(fitPlan).length === 0, show(fitPlan));
  const cityPlan = await explain(await fitSqlOf(T("S03")), [ids], { bitmap: true });
  ok("... and for a client with city places: never a scan, read by an index (the key on the ids, or its own cities' place index, bounded by its places)",
    scans(cityPlan).length === 0 && cityPlan.some((x) => ["leads_pkey", "idx_leads_location_id"].includes(x["Index Name"])), show(cityPlan));
  const reasonsPlan = await explain(reasonsSql(true), [ids, T("S03"), 1002, id, true, PATTERN]);
  const byIndex = (nodes, rel) => nodes.some((x) => x["Relation Name"] === rel && x["Index Name"]) && !nodes.some((x) => x["Relation Name"] === rel && !x["Index Name"]);
  ok("EXPLAIN of the reasons statement: the leads by key on the ids, push_items and lead_shares by an index, no scan of a big table",
    usesPk(reasonsPlan) && scans(reasonsPlan).length === 0 && byIndex(reasonsPlan, "push_items") && byIndex(reasonsPlan, "lead_shares"), show(reasonsPlan));
  const leadsPlan = await explain(jobLeadsSql(false), [id]);
  ok("EXPLAIN of reading a job's lead list: by the list's key and the leads' primary key", scans(leadsPlan).length === 0 && usesPk(leadsPlan) &&
    leadsPlan.some((x) => x["Index Name"] === "upload_batch_leads_pkey" && /batch_id/.test(x["Index Cond"] ?? "")), show(leadsPlan));
  const placed = (await jobLeads(pool, id)).placed;
  ok("the job's 2,000 leads read back with their places", placed.length === 2000);
  const recheckPlan = await explain(jobLeadsSql(true), [id, new Date(Date.now() - 86_400_000).toISOString()]);
  ok("EXPLAIN of a recheck's read: the same keys, and the job's share rows by their key", scans(recheckPlan).length === 0 && usesPk(recheckPlan), show(recheckPlan));
  ok("receiversByTag reads the 90 at once", (await receiversByTag(pool, scale, T("O"))).size === 90);
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function setup() {
  // The receivers and the other made-up clients of these checks.
  await client("O", { group: 101, places: [NV()], exclude: ["Shtestvending"], requireLocation: false });
  await client("B", { group: 102, places: [NV({ city: "Reno" })] });
  await client("C", { group: 102, places: [NV()] });
  await client("CX", { group: 110, places: [{ country: "US", state: "WY" }] });
  await client("D", { group: 101, places: [NV()] });
  await client("E", { group: 103, type: "Canada Cleaning", places: [{ country: "US", state: "UT" }] });
  await client("F", { group: 104, type: "Non-Cleaning", places: [NV()] });
  await client("G-OS", { group: 105, places: [NV()] });
  await client("H", { group: 106, places: [NV()] });
  await client("P", { group: 111, status: "Paused", places: [NV()] });
  await client("I", { group: 108, places: [{ country: "US", state: "UT" }] });
  await client("J", { group: 108, places: [{ country: "US", state: "UT" }] });
  await client("KQ", { group: 109, places: [{ country: "US", state: "ID" }] });
  await client("M", { group: 109, places: [{ country: "US", state: "ID" }] });
  // The receive rule's reasons.
  await client("NT", { group: 120, onTab: false });
  await client("CN", { group: 121, churn: { state: "date", date: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10), cell: "soon" } });
  await client("CP", { group: 122, churn: { state: "date", date: "2026-01-01", cell: "1/1/2026" } });
  await client("CU", { group: 123, churn: { state: "unreadable", cell: "TBD" } });
  await client("NR", { group: 124, rules: false });
  await client("NP", { group: 125, places: [] });
  await client("CO", { group: 126, places: [NV(), { country: "US" }] });
  await client("NG", { group: null });
  // These three can receive: their places are in a state no other check uses.
  const MT = [{ country: "US", state: "MT" }];
  await client("HE", { group: 127, status: " healthy ", places: MT });
  await client("CL", { group: 128, places: MT, churn: { state: "date", date: new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10), cell: "later" } });
  await client("NA", { group: 129, places: MT, churn: { state: "non_answer", cell: "N/A" } });
  LIST = ["O", "B", "C", "CX", "D", "E", "F", "G-OS", "P", "I", "J", "KQ", "M", "NT", "CN", "CP", "CU", "NR", "NP", "CO", "NG", "HE", "CL", "NA"].map(T);
}

const baseline = {};
async function counts() {
  return one(`SELECT (SELECT count(*) FROM leads WHERE email NOT LIKE $1)::int AS leads, (SELECT count(*) FROM push_batches WHERE NOT starts_with(coalesce(client_tag, ''), 'SHTEST_'))::int AS pushes,
                     (SELECT count(*) FROM share_jobs)::int AS jobs, (SELECT count(*) FROM lead_shares)::int AS shares, (SELECT count(*) FROM upload_batch_leads)::int AS lists,
                     (SELECT count(*) FROM client_tags WHERE NOT starts_with(tag, 'SHTEST_'))::int AS clients,
                     (SELECT count(*) FROM suppressed_emails)::int AS suppressed`, [`%.${HOST}`]);
}

let crashed = null;
try {
  await cleanup();
  const pre = await counts();
  Object.assign(baseline, pre);
  if (pre.jobs || pre.shares || pre.lists) {
    console.error(`Refusing to run: the local database holds share jobs, shares or lead lists that are not this suite's (${JSON.stringify(pre)}).`);
    process.exit(1);
  }
  await saveState();
  await setup();
  await partB();
  await partC();
  await partD();
  await partE();
  await partF();
  await partG();
  await partH();
  await partI();
  await partJ();
  await partL();
  await partM();
  await partN();
  await partO();
  await partP();
  await partR();
  await partS();
  await partT();
} catch (e) {
  crashed = e;
  ok("the suite ran to its end", false, e?.stack ?? e);
} finally {
  sec("Z. Everything removed, the settings back");
  try {
    await cleanup();
    await restoreState();
    const after = await counts();
    ok("nothing of this suite is left: no share job, share row or lead list, no made-up lead, client or push", after.jobs === 0 && after.shares === 0 && after.lists === 0 &&
      (await one(`SELECT count(*)::int AS n FROM leads WHERE email LIKE $1`, [`%.${HOST}`])).n === 0 && (await one(`SELECT count(*)::int AS n FROM client_tags WHERE starts_with(tag, 'SHTEST_')`)).n === 0,
    JSON.stringify(after));
    ok("nothing else moved: other leads, pushes, clients and the never-contact list as before", after.leads === baseline.leads && after.pushes === baseline.pushes &&
      after.clients === baseline.clients && after.suppressed === baseline.suppressed, JSON.stringify({ baseline, after }));
    const back = await all(`SELECT key, value FROM enrich_settings WHERE key IN ('overlap_sharing', 'never_contact_inboxes') ORDER BY key`);
    ok("overlap_sharing and never_contact_inboxes are as they were", back.every((r) => same(r.value, saved.settings.get(r.key)?.value)));
    ok("cron_runs' location_backfill row is as it was", same(await one(`SELECT * FROM cron_runs WHERE name = $1`, [CRON_LOCATION_BACKFILL]) ?? null, saved.cron));
    ok("nothing reached a network (no fetch, no DNS)", net.refused === 0 && net.dns === 0, JSON.stringify(net));
  } catch (e) {
    ok("the cleanup ran", false, e?.stack ?? e);
  }
  await pool.end();
  await sleep(10);
  console.log(`\n${out.passed} passed, ${out.failed} failed${crashed ? " (stopped early)" : ""}`);
  process.exit(out.failed ? 1 : 0);
}
