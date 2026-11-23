#!/usr/bin/env node
// Deep checks for fit scoring, promotion, the gate, the review list and
// removal (phase 3, migrations 126 and 127). LOCAL DATABASE ONLY: it makes
// made-up clients (tags starting FTTEST_), made-up users, leads, Email Bison
// copy rows, push batches, template tables, contacts and scores, and removes
// all of it at the end (and any left by a run that was cut off).
//
//   node --env-file=.env.local scripts/test-fit.mjs
//
// Stop the enrichment worker first, and run it under the shared local-database
// lock when other suites share the database. Migrations 125 to 127 must be in.
//
// Nothing here reaches a network. fetch is replaced for the whole run: OpenAI
// and the made-up Bison installs answer from stubs, the local Supabase API
// (127.0.0.1) answers for real, and any other address is refused and counted.
// No paid key is read from the environment, and EMAILBISON_KEYS holds made-up
// tokens for two made-up installs. The removal worker and the re-push script
// run as child processes with the same stubs.
//
// The routes run for real through a small loader that compiles their
// TypeScript, with stand-ins only for: the session (requireRole and the
// Supabase server client: a made-up user with a role), the audit log, the
// worker's heartbeat, Next's after() (its callbacks are awaited), the shared
// pg pool (local, no TLS), and the fit settings read (readFitSettings: the
// stored rows with the test's in-memory changes on top). That last one is why
// no rule is ever written to the database here: the scorer is given a made-up
// rule in memory only, and promotion runs with none (since 2026-11-20 it needs
// no fit rule, model, gate or score). The gate is switched on in the database
// for the route checks, and promotion through the Companies settings sheet's
// route (both restored at the end, with every row a sheet save writes, and on
// the next run if a run is cut off); the SQL gate checks run inside a
// rolled-back transaction.
//
// What it checks (the design's section 8.4), plus "switches off means no
// change": with every switch as shipped, nothing moves, the eligibility and
// export functions return exactly what their old bodies (093, 050) return for
// every local client, pushes start 'pending' as before, exports are unchanged,
// and the AI Ark tab's tables and its auto-add list are as they were.

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bareDomain } from "./lib/enrich/domain.mjs";
import {
  companyFitKey, fitDomainKey, fitNameKey, FIT_ACTIONS, keysFromRow, leadFitKeySql, loadFitExclusions,
} from "./lib/enrich/fit-keys.mjs";
import {
  buildFitRequest, enqueueCompanies, FIT_ANSWER_SCHEMA, FIT_FORMAT_TEXT, fitLoopOnce, fitLoopStatus, inputsHash, parseFitAnswer,
  refreshBlockedOnce, resetFitLoop, WAITING_FOR_RULE, writeScores,
} from "./lib/enrich/fit-score.mjs";
import {
  advanceScoringBatch, eligibilitySql, enqueueLeadCompanies, FIT_SKIP, fitCheckOn, gateEnabled, scoringStatusFor,
} from "./lib/enrich/fit-push.mjs";
import { advanceBackfill, buildReview, estimateUsd, liveCampaignsFor, reviewCampaignsFor } from "./lib/enrich/fit-backfill.mjs";
import { fallbackOf, HOLD, inboxLeadRow, personLeadRow, promoteDue, promotionAllowed, REFUSED_BRAND, withoutFallback } from "./lib/enrich/promote.mjs";
import { normalizeCompanyName, normalizePhoneNumber, TOOL_STANDIN_ACTIONS } from "./lib/enrich/tool-standins.mjs";
import { CANNOT_CONFIRM, confirmDryRun, finishRows, heldRows, liveCheck, recordDryRun, rowsSha } from "./lib/bison/fit-removal.mjs";
import { openAiCost, spentToday } from "./lib/enrich/spend.mjs";
import { settingsFrom } from "./lib/enrich/settings.mjs";
import { compileTemplates, ensureTable } from "./lib/enrich/templates.mjs";
import { originalRows, originalsMap } from "./lib/enrich/seed-originals.mjs";
import { fixtureSeedExports } from "./fixtures/clay-originals/fixtures.mjs";
import { ACTIONS } from "./lib/enrich/actions.mjs";
import { contactSummary } from "./lib/enrich/project-contacts.mjs";
import { PIPELINE_ACTIONS } from "./lib/enrich/pipeline-actions.mjs";
import { pullsToAdd } from "./lib/aiark/add.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
const API = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!API || !["127.0.0.1", "localhost"].includes(new URL(API).hostname)) {
  console.error("Refusing to run: NEXT_PUBLIC_SUPABASE_URL must be the local Supabase API.");
  process.exit(1);
}
// No paid key reaches anything here, whatever the shell holds.
const PAID_KEYS = [
  "OPENAI_API_KEY", "ENRICH_REOON_API_KEY", "REOON_API_KEY", "FINDEMAIL_API_KEY", "ANTHROPIC_API_KEY",
  "AIARK_API_KEY", "AIARK_WEBHOOK_URL", "AIARK_AUTO_ADD_URL", "AIARK_AUTO_ADD_KEY", "FINDYMAIL_API_KEY", "PROSPEO_API_KEY",
  "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY", "EMAILBISON_API_KEY", "EMAILBISON_BASE_URL", "EMAILBISON_KEYS",
];
for (const k of PAID_KEYS) delete process.env[k];

const PREFIX = "FTTEST_";
const RUN = randomUUID().slice(0, 6);
const HOST = "fttest.example"; // every made-up domain ends with it
const dom = (slug) => `${slug}-${RUN}.${HOST}`;
const B2B = `b2b.${HOST}`;
const B2C = `b2c.${HOST}`;
process.env.EMAILBISON_KEYS = JSON.stringify({ [B2B]: "fttest-made-up-b2b", [B2C]: "fttest-made-up-b2c" });
const TAG_A = `${PREFIX}A`; // Cleaning, with targeting rules
const TAG_B = `${PREFIX}B`; // Cleaning, no targeting rules
const TAG_O = `${PREFIX}O`; // not a type the gate lists
const SRC = `fttest source ${RUN}`; // leads.source of the made-up leads, for filtered exports
const RULE = "FTTEST made-up rule, never the real one: score each company as the test says.";
const FAKE_OPENAI = { OPENAI_API_KEY: "fttest-made-up-openai" };

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` : ${detail}` : ""}`);
}
const section = (s) => console.log(`\n${s}`);
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── No network ───────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const LOCAL_API_HOST = new URL(API).host;
const net = {
  openai: [], // request bodies
  plan: new Map(), // company name or domain -> { score, home, reason, omit }
  reverse: false, // answer the ids in reverse order
  fail: [], // { status, body } answered before the normal answers
  bison: [], // { method, host, path }
  deletes: [], // DELETE bodies
  campaigns: {}, // install -> [{ id, name, status }]
  liveLeads: {}, // install -> { bison lead id -> answer }
  dns: [], // hosts asked for MX records
  refused: 0,
  local: 0,
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fitAnswer(body) {
  const at = body.input.indexOf("Companies:\n");
  const list = JSON.parse(body.input.slice(at + "Companies:\n".length));
  const results = [];
  for (const c of list) {
    const plan = net.plan.get(c.domain) ?? net.plan.get(c.name) ?? { score: 3 };
    if (plan.omit) continue;
    results.push({ id: c.id, score: plan.score === undefined ? 3 : plan.score, home_office: plan.home ?? false, reason: plan.reason ?? `Made-up reason for ${c.name ?? c.domain}` });
  }
  if (net.reverse) results.reverse();
  return json(200, {
    output: [{ type: "reasoning" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify({ results }) }] }],
    usage: { input_tokens: 1000, output_tokens: 200 },
  });
}

function bisonAnswer(u, init) {
  const method = (init.method ?? "GET").toUpperCase();
  net.bison.push({ method, host: u.hostname, path: u.pathname });
  const camps = net.campaigns[u.hostname] ?? [];
  if (method === "GET" && u.pathname === "/api/campaigns") {
    const term = (u.searchParams.get("search") ?? "").toLowerCase();
    return json(200, { data: camps.filter((c) => c.name.toLowerCase().includes(term)), links: { next: null } });
  }
  let m = /^\/api\/campaigns\/(\d+)$/.exec(u.pathname);
  if (method === "GET" && m) {
    const c = camps.find((x) => String(x.id) === m[1]);
    return c ? json(200, { data: c }) : json(404, { message: "not found" });
  }
  m = /^\/api\/leads\/(\d+)$/.exec(u.pathname);
  if (method === "GET" && m) {
    const a = net.liveLeads[u.hostname]?.[m[1]];
    return a ? json(200, a) : json(404, { message: "not found" });
  }
  m = /^\/api\/campaigns\/(\d+)\/leads$/.exec(u.pathname);
  if (method === "DELETE" && m) {
    net.deletes.push({ host: u.hostname, campaign: m[1], body: JSON.parse(init.body) });
    return json(200, { data: { removed: true } });
  }
  return json(404, { message: "no such made-up endpoint" });
}

globalThis.fetch = async (input, init = {}) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(href);
  if (u.host === LOCAL_API_HOST) {
    net.local++;
    return realFetch(input, init);
  }
  if (u.hostname === "api.openai.com") {
    const body = JSON.parse(init.body);
    net.openai.push(body);
    const f = net.fail.shift();
    if (f) return json(f.status, f.body ?? { error: { message: "made-up failure" } });
    return fitAnswer(body);
  }
  if (u.hostname === B2B || u.hostname === B2C) return bisonAnswer(u, init);
  if (u.hostname === "dns.google.com" || u.hostname === "dns.google") {
    net.dns.push(u.hostname);
    return json(200, { Status: 0, Answer: [{ type: 15, data: `10 mx.${HOST}.` }] });
  }
  net.refused++;
  throw Object.assign(new TypeError("fetch failed: test-fit allows no network"), { cause: { code: "ECONNREFUSED" } });
};

// The child processes (the removal worker, the re-push script) get the same
// Bison stub, its plan read from a file, its DELETEs written to another.
const PLAN_FILE = join(tmpdir(), `fttest-bison-plan-${RUN}.json`);
const LOG_FILE = join(tmpdir(), `fttest-bison-log-${RUN}.jsonl`);
const CHILD_PRELOAD = `
import { readFileSync, appendFileSync } from "node:fs";
const plan = () => JSON.parse(readFileSync(process.env.FIT_TEST_BISON_PLAN, "utf8"));
const out = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const p = plan();
  const method = (init.method ?? "GET").toUpperCase();
  if (!p.hosts.includes(u.hostname)) throw Object.assign(new TypeError("fetch failed: no network in test-fit"), { cause: { code: "ECONNREFUSED" } });
  appendFileSync(process.env.FIT_TEST_BISON_LOG, JSON.stringify({ method, host: u.hostname, path: u.pathname, body: init.body ?? null }) + "\\n");
  let m = /^\\/api\\/leads\\/(\\d+)$/.exec(u.pathname);
  if (method === "GET" && m) { const a = p.leads?.[u.hostname]?.[m[1]]; return a ? out(200, a) : out(404, { message: "not found" }); }
  m = /^\\/api\\/campaigns\\/(\\d+)$/.exec(u.pathname);
  if (method === "GET" && m) { const c = (p.campaigns?.[u.hostname] ?? []).find((x) => String(x.id) === m[1]); return c ? out(200, { data: c }) : out(404, {}); }
  m = /^\\/api\\/campaigns\\/(\\d+)\\/leads$/.exec(u.pathname);
  if (method === "DELETE" && m) return out(200, { data: { removed: true } });
  return out(404, {});
};`;
const writePlan = (p) => writeFileSync(PLAN_FILE, JSON.stringify({ hosts: [B2B, B2C], ...p }));
const readLog = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function runChild(args, { strip = false } = {}) {
  const r = spawnSync(
    process.execPath,
    [...(strip ? ["--experimental-strip-types", "--no-warnings"] : []), "--import", `data:text/javascript,${encodeURIComponent(CHILD_PRELOAD)}`, ...args],
    { env: { ...process.env, FIT_TEST_BISON_PLAN: PLAN_FILE, FIT_TEST_BISON_LOG: LOG_FILE }, encoding: "utf8", timeout: 120_000 }
  );
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ── The routes' TypeScript, compiled as it is imported ──────────────────────

const require = createRequire(import.meta.url);
const pgUrl = pathToFileURL(require.resolve("pg")).href;
const fitTsUrl = new URL("../src/lib/companies/fit.ts", import.meta.url).href;
const settingsUrl = new URL("./lib/enrich/settings.mjs", import.meta.url).href;
const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}
export function after(fn) { globalThis.__fitTest.after.push(Promise.resolve().then(fn)); }`,
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
import { createHash, timingSafeEqual } from "node:crypto";
export async function requireRole(min) {
  const t = globalThis.__fitTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}
export function intakeKeyStatus(authorization, configured) {
  const expected = configured?.trim() ?? "";
  if (expected.length < 32) return "not_configured";
  const m = /^Bearer[ \\t]+(\\S+)[ \\t]*$/i.exec(authorization?.trim() ?? "");
  if (!m) return "unauthorized";
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? "ok" : "unauthorized";
}`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__fitTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__fitTest.worker; }`,
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => {
    const t = globalThis.__fitTest;
    return { data: { user: t.role ? { id: t.userId, email: "fttest-user@${HOST}" } : null } };
  } } };
}`,
  "@/lib/db/pool": `import pg from "${pgUrl}";
let p = null;
export function getPool() {
  if (!p) { p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }); globalThis.__fitTest.pools.push(p); }
  return p;
}`,
  "@/lib/companies/fit": `import { settingsFrom } from "${settingsUrl}";
export * from "${fitTsUrl}";
export async function readFitSettings(c) {
  const { rows } = await c.query("SELECT key, value FROM enrich_settings");
  const extra = globalThis.__fitTest.settingsRows ?? [];
  return settingsFrom([...rows.filter((r) => !extra.some((e) => e.key === r.key)), ...extra]);
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
  data: { typescript: pathToFileURL(require.resolve("typescript")).href, src: new URL("../src/", import.meta.url).href, stubs: STUBS },
});

const T = (globalThis.__fitTest = { role: null, userId: null, audits: [], worker: null, after: [], pools: [], settingsRows: [] });
const route = (p) => import(new URL(`../src/app/api/${p}/route.ts`, import.meta.url).href);
const srcModule = (p) => import(new URL(`../src/${p}`, import.meta.url).href);
const USERS = {};
const as = (role) => {
  T.role = role;
  T.userId = role ? USERS[role] : null;
};
async function call(handler, { body, query, headers } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const ac = new AbortController();
  const req = { json: async () => body, nextUrl: new URL(`http://fit.test/api${qs}`), headers: new Headers(headers ?? {}), signal: ac.signal };
  const res = await handler(req);
  if (res instanceof Response) return { status: res.status, raw: res };
  return { status: res.status, body: res.body };
}
async function drainAfter() {
  while (T.after.length) await T.after.shift();
}
const heartbeat = ({ fit = true } = {}) => ({
  id: "fit-test",
  last_seen: new Date().toISOString(),
  started_at: new Date().toISOString(),
  seconds_ago: 2,
  online: true,
  info: { capabilities: ["company_runs", ...(fit ? ["fit_scoring"] : [])], keys: {}, fit: { state: "idle", why: null } },
});

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 8 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const created = { exportJobs: [] };

/** Every row this suite (or a run of it that was cut off) made, removed. */
async function cleanup() {
  const users = (await all(`SELECT id FROM auth.users WHERE email LIKE 'fttest-%@${HOST}'`)).map((r) => r.id);
  await pool.query(`DELETE FROM bison_campaign_removals WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM fit_removal_dry_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM fit_review_items WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM fit_backfill_runs WHERE starts_with(client_tag, $1) OR created_by = ANY($2::uuid[])`, [PREFIX, users]);
  await pool.query(`DELETE FROM company_fit_queue WHERE key LIKE '%fttest%'`);
  await pool.query(`DELETE FROM company_fit_keys WHERE key LIKE '%fttest%' OR fit_key LIKE '%fttest%'`);
  await pool.query(`DELETE FROM company_fit WHERE key LIKE '%fttest%'`);
  await pool.query(
    `DELETE FROM push_items WHERE batch_id IN (SELECT id FROM push_batches WHERE starts_with(client_tag, $1) OR created_by = ANY($2::uuid[]))`,
    [PREFIX, users]
  );
  await pool.query(`DELETE FROM push_batches WHERE starts_with(client_tag, $1) OR created_by = ANY($2::uuid[])`, [PREFIX, users]);
  await pool.query(`DELETE FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM upload_batches WHERE filename LIKE $1`, [`%${PREFIX}%`]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1 OR email LIKE 'fttest-%@gmail.com'`, [`%${HOST}`]);
  await pool.query(`DELETE FROM bison_leads WHERE instance_url LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM suppressed_emails WHERE email LIKE $1`, [`%${HOST}`]);
  const jobs = (await all(`SELECT id FROM export_jobs WHERE requested_by = ANY($1::uuid[])`, [users])).map((r) => r.id);
  if (jobs.length) {
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(API, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: files } = await admin.storage.from("csv-exports").list("", { limit: 1000, search: "export_" });
    const mine = (files ?? []).map((f) => f.name).filter((n) => jobs.some((j) => n.includes(j)));
    if (mine.length) await admin.storage.from("csv-exports").remove(mine);
    await pool.query(`DELETE FROM export_jobs WHERE id = ANY($1::uuid[])`, [jobs]);
  }
  await pool.query(`DELETE FROM audit_logs WHERE performed_by = ANY($1::text[])`, [users.map(String)]);
  await pool.query(`DELETE FROM worker_locks WHERE starts_with(key, 'bison-campaign-removal-worker')`);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM user_profiles WHERE id = ANY($1::uuid[])`, [users]);
  await pool.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]);
}

/** The counts that must not move while every switch is off (the AI Ark tab's tables among them). */
async function counts() {
  const q = async (sql) => Number((await one(sql)).n);
  const out = {};
  for (const t of [
    "leads", "push_batches", "push_items", "upload_batches", "bison_campaign_removals", "bison_leads", "aiark_runs", "aiark_people",
    "aiark_companies", "aiark_company_runs", "aiark_people_runs", "enrich_rows", "enrich_cells", "enrich_contacts", "enrich_companies",
    "company_fit", "company_fit_keys", "company_fit_queue", "fit_backfill_runs", "fit_review_items", "fit_removal_dry_runs", "suppressed_emails",
  ]) {
    out[t] = await q(`SELECT count(*)::bigint AS n FROM ${t}`);
  }
  out.settings = (await all(`SELECT key, value FROM enrich_settings ORDER BY key`)).map((r) => `${r.key}=${JSON.stringify(r.value)}`).join("|");
  return out;
}

// The settings this suite changes in the database, as they stood, put back at the end.
const SHIPPED_GATE = { enabled: false, tags: [], threshold: 2, client_types: ["Cleaning", "Canada Cleaning"], require_scored: true };
const SHIPPED_PROMOTION = { promote_to_leads: false, tags: [], min_fit_score: 2, batch_max: 1000, require_question: true, source_label: "Companies (AI Ark)" };
// The rows a save of the Companies tab's settings sheet may write: section E switches promotion on through it.
const SHEET_ROWS = [
  "company_pipeline", "people_pipeline", "personalisation", "spend_caps", "models", "linkedin_sources", "overlap_sharing", "weekly_topup",
  "never_contact_inboxes",
];
let snapshot = null;
async function setSetting(key, value) {
  await pool.query(`UPDATE enrich_settings SET value = $2::jsonb, updated_at = now() WHERE key = $1`, [key, JSON.stringify(value)]);
}
const gateOn = (tags, extra = {}) => setSetting("fit_gate", { ...snapshot.fit_gate, enabled: true, tags, ...extra });
const gateOff = () => setSetting("fit_gate", snapshot.fit_gate);
async function restoreSettings() {
  if (!snapshot) return;
  for (const k of SHEET_ROWS) {
    if (snapshot.sheet[k] === undefined) await pool.query(`DELETE FROM enrich_settings WHERE key = $1`, [k]);
    else await setSetting(k, snapshot.sheet[k]);
  }
  for (const k of ["fit_gate", "fit_gate_refresh", "fit_scoring", "fit_rule", "promotion"]) await setSetting(k, snapshot[k]);
  await pool.query(
    `UPDATE enrich_settings SET value = jsonb_set(value, '{fit_score}', $1::jsonb) WHERE key = 'models'`,
    [JSON.stringify(snapshot.fit_score ?? null)]
  );
  // Today's fit spend as it was: the scorer's made-up calls are not left counted.
  if (snapshot.spendFit == null) {
    await pool.query(`DELETE FROM enrich_spend_daily WHERE day = (now() AT TIME ZONE 'utc')::date AND kind = 'openai_usd_fit'`);
  } else {
    await pool.query(`UPDATE enrich_spend_daily SET used = $1 WHERE day = (now() AT TIME ZONE 'utc')::date AND kind = 'openai_usd_fit'`, [snapshot.spendFit]);
  }
}

/** The stored settings with the given keys replaced, as the worker and the routes would read them. */
async function settingsWith(over = {}) {
  const rows = await all(`SELECT key, value FROM enrich_settings`);
  const extra = Object.entries(over).map(([key, value]) => ({ key, value }));
  return settingsFrom([...rows.filter((r) => !(r.key in over)), ...extra]);
}
const SCORING_ON = (o = {}) => ({ fit_scoring: { enabled: true, batch_size: 3, calls_in_flight: 2, ...o } });
const WITH_RULE = (version = "fttest-1") => ({ fit_rule: { prompt: RULE, version } });

// ── Fixtures ────────────────────────────────────────────────────────────────

async function addLead(cols) {
  const keys = Object.keys(cols);
  const { rows: [r] } = await pool.query(
    `INSERT INTO leads (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    Object.values(cols)
  );
  return r.id;
}
async function addRow(tableId, key, cells = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO enrich_rows (table_id, row_key, run_status, finished_at) VALUES ($1, $2, 'done', now()) RETURNING id`,
    [tableId, key]
  );
  const id = Number(r.id);
  for (const [k, v] of Object.entries(cells)) {
    await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) VALUES ($1, $2, $3, 'done', $4::jsonb)`, [id, k, tableId, JSON.stringify(v)]);
  }
  return id;
}
async function addCompany(tables, tag, { slug, name, city = "Springfield", state = "IL", listed = true, passes = true, industry = "Commercial cleaning", cells = {} }) {
  const row = await addRow(tables.companies, `aiark:${slug}-${RUN}`, { description: `Made-up description of ${name}`, company_type: "Private", ...cells });
  await pool.query(
    `INSERT INTO enrich_companies (row_id, table_id, client_tag, source, company, domain, city, state, industry, employees, passes, listed,
                                   found_at, template, outcome, never_contact, company_key)
     VALUES ($1, $2, $3, 'ai_ark', $4, $5, $6, $7, $8, '11-50', $9, $10, CASE WHEN $10 THEN now() END, 'companies_v2', 'Has a general email', false, $11)`,
    [row, tables.companies, tag, name, slug ? dom(slug) : null, city, state, industry, passes, listed, slug ? `${dom(slug)}|${state}|${city}` : null]
  );
  return row;
}
async function addContact(tables, tag, companyRow, { kind, email, cells, verdict = "approved", usable = true, held = false, question = true, outcome }) {
  const table = kind === "general" ? tables.inboxes : tables.people;
  const row = await addRow(table, `w:${companyRow}:${email}`, { ...cells, company_row: String(companyRow) });
  await pool.query(
    `INSERT INTO enrich_contacts (row_id, company_row_id, table_id, client_tag, kind, email, verdict, usable, held, has_question, outcome, full_name, title)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [row, companyRow, table, tag, kind, email, verdict, usable, held, question, outcome ?? (kind === "general" ? "Approved" : "Approved email"),
     cells.full_name ?? null, cells.title ?? null]
  );
  return row;
}
/** A made-up score, written as the scorer writes it (source campaigns unless given). */
async function score(key_kind, key, s, { aliases = [], status = "scored", source = "campaigns" } = {}) {
  await writeScores(pool, [{ key_kind, key, score: status === "unscorable" ? null : s, home_office: false, reason: `made-up ${s}`, status, inputs_hash: null, source, aliases }], {
    model: "gpt-6-luna", ruleVersion: "fttest-1",
  });
}
const fitOf = async (key_kind, key) => one(`SELECT * FROM company_fit WHERE key_kind = $1 AND key = $2`, [key_kind, key]);
const keyOf = async (key_kind, key) => one(`SELECT * FROM company_fit_keys WHERE key_kind = $1 AND key = $2`, [key_kind, key]);

// ── Start ───────────────────────────────────────────────────────────────────

let exitCode = 0;
let before = null;
try {
  await cleanup();
  // A run cut off while the gate was on leaves it covering only test clients: put it back.
  const g = (await one(`SELECT value FROM enrich_settings WHERE key = 'fit_gate'`))?.value;
  if (g && Array.isArray(g.tags) && g.tags.length && g.tags.every((t) => String(t).startsWith(PREFIX))) await setSetting("fit_gate", SHIPPED_GATE);
  // So does one cut off while section E had promotion switched on for test clients.
  const pv = (await one(`SELECT value FROM enrich_settings WHERE key = 'promotion'`))?.value;
  if (pv && Array.isArray(pv.tags) && pv.tags.length && pv.tags.every((t) => String(t).startsWith(PREFIX))) await setSetting("promotion", SHIPPED_PROMOTION);
  const foreign = await one(
    `SELECT (SELECT count(*) FROM company_fit WHERE key NOT LIKE '%fttest%')::int AS fit,
            (SELECT count(*) FROM company_fit_queue WHERE key NOT LIKE '%fttest%')::int AS queue,
            (SELECT count(*) FROM fit_backfill_runs)::int AS runs,
            (SELECT count(*) FROM enrich_companies WHERE passes AND fit_key IS NULL AND NOT starts_with(client_tag, $1))::int AS pipeline,
            (SELECT count(*) FROM push_batches WHERE status = 'scoring')::int AS scoring`,
    [PREFIX]
  );
  if (foreign.fit || foreign.queue || foreign.runs || foreign.pipeline || foreign.scoring) {
    throw new Error(`the local database holds fit rows this suite did not make (${JSON.stringify(foreign)}): it would work them, so it stops`);
  }
  const st = Object.fromEntries((await all(`SELECT key, value FROM enrich_settings`)).map((r) => [r.key, r.value]));
  snapshot = {
    fit_gate: st.fit_gate, fit_gate_refresh: st.fit_gate_refresh, fit_scoring: st.fit_scoring, fit_rule: st.fit_rule, promotion: st.promotion,
    fit_score: st.models?.fit_score ?? null,
    sheet: Object.fromEntries(SHEET_ROWS.map((k) => [k, st[k]])),
    spendFit: (await one(`SELECT (SELECT used FROM enrich_spend_daily WHERE day = (now() AT TIME ZONE 'utc')::date AND kind = 'openai_usd_fit') AS n`)).n,
  };

  // ── 0. Shipped off: nothing moves ─────────────────────────────────────────
  section("0. Shipped off: nothing moves");
  const shipped = await settingsWith();
  check(
    "as shipped: scoring off, no rule, promotion off with no client, the gate off with no client, Luna at low effort for fit_score",
    !shipped.fit_scoring.enabled && shipped.fit_rule.prompt === null && shipped.fit_rule.version === null && !shipped.promotion.promote_to_leads &&
      shipped.promotion.tags.length === 0 && !shipped.fit_gate.enabled && shipped.fit_gate.tags.length === 0 &&
      shipped.models.fit_score?.model === "gpt-6-luna" && shipped.models.fit_score?.reasoning_effort === "low" &&
      shipped.promotion.require_question === true && same(shipped.fit_gate.client_types, ["Cleaning", "Canada Cleaning"]),
    JSON.stringify({ scoring: shipped.fit_scoring, rule: shipped.fit_rule, promotion: shipped.promotion, gate: shipped.fit_gate })
  );
  before = await counts();
  const addsBefore = JSON.stringify(await pullsToAdd(pool));
  resetFitLoop();
  const idle = [
    await advanceScoringBatch({ pool }),
    await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: shipped }),
    await refreshBlockedOnce(pool),
    await advanceBackfill({ pool, settings: shipped }),
    await promoteDue(pool, shipped),
  ];
  check("the fit loop's four steps and the promotion trigger do nothing", same(idle, [null, 0, 0, null, []]) && net.openai.length === 0, JSON.stringify(idle));
  check("the scorer says why: scoring is off", fitLoopStatus().why === "Scoring is off", fitLoopStatus().why);
  check("nothing moved: leads, pushes, uploads, removals, the AI Ark tab's tables, the pipeline's, the settings", same(await counts(), before));
  check("the AI Ark tab's auto-add list is the same", JSON.stringify(await pullsToAdd(pool)) === addsBefore);
  check("the gate reads off for every local client, and every new push starts pending", !(await gateEnabled(pool)) &&
    (await all(`SELECT tag FROM client_tags`)).length > 0 &&
    (await one(`SELECT count(*) FILTER (WHERE public.fn_fit_gate_applies(tag))::int AS n FROM client_tags`)).n === 0 &&
    (await scoringStatusFor(pool, (await one(`SELECT tag FROM client_tags LIMIT 1`)).tag)) === "pending");

  // ── A. Keys ───────────────────────────────────────────────────────────────
  section("A. Keys: the SQL and JavaScript rules agree");
  const EX = await loadFitExclusions(pool);
  check("free-mail and platform domains are loaded", EX.freemail.has("gmail.com") && EX.excluded.has("facebook.com") && EX.excluded.has("yelp.com"));
  const site = dom("acme");
  const cases = [
    ["free mail with a website", "jo@gmail.com", `https://www.${site}/contact`],
    ["a scheme", null, `http://${site}`],
    ["www.", null, `www.${site}`],
    ["www2. and upper case", null, `WWW2.${site.toUpperCase()}`],
    ["a path, a query and a fragment", null, `${site}/about?x=1#top`],
    ["a port", null, `https://${site}:8443/`],
    ["a trailing dot", null, `${site}.`],
    ["dot-less", null, "acme"],
    ["dot-less with www.", null, "www.acme"],
    ["localhost", null, "localhost"],
    ["localhost with a scheme and a port", null, "http://localhost:3000"],
    ["a platform page", "jo@gmail.com", "facebook.com/acme"],
    ["a platform page with a scheme", null, "https://www.facebook.com/acme"],
    ["a directory page", null, "yelp.com/biz/acme"],
    ["an address given as the website", null, `office@${site}`],
    ["the email's own domain wins", `office@${dom("acme-services")}`, site],
    ["an upper-case email", `Jo@${site.toUpperCase()}`, null],
    ["nothing", null, null],
    ["empty text", "", ""],
  ];
  for (const [name, email, website] of cases) {
    const r = await one(`SELECT public.fn_bare_domain($2) AS b, public.fn_fit_domain_key($1, $2) AS k`, [email, website]);
    const jsB = bareDomain(website);
    const jsK = fitDomainKey(email, website, EX);
    check(`keys agree: ${name}`, (r.b ?? null) === (jsB ?? null) && (r.k ?? null) === (jsK ?? null), JSON.stringify({ sql: r, js: { b: jsB, k: jsK } }));
  }
  check("no key from acme, www.acme, localhost or a Facebook page",
    [bareDomain("acme"), bareDomain("www.acme"), bareDomain("localhost"), fitDomainKey("jo@gmail.com", "facebook.com/acme", EX)].every((v) => v === null));
  const names = [["Acme Fttest", "Springfield", "il"], ["  Acme Fttest  ", " ", "IL"], ["", "Springfield", "IL"], ["Acme Fttest", "Springfield", ""], [null, null, null], ["Acme Fttest", null, "tx"]];
  for (const [c, city, s] of names) {
    const r = await one(`SELECT public.fn_fit_name_key($1, $2, $3) AS k`, [c, city, s]);
    check(`name keys agree: ${JSON.stringify([c, city, s])}`, (r.k ?? null) === fitNameKey(c, city, s), JSON.stringify({ sql: r.k, js: fitNameKey(c, city, s) }));
  }
  const composite = [
    { email: "jo@gmail.com", website: `www.${site}`, company: "Acme Fttest", city: "Springfield", stateCode: "IL" },
    { email: `office@${dom("acme-services")}`, website: site, company: "Acme Fttest", city: "Springfield", stateCode: "IL" },
    { email: "jo@gmail.com", website: "facebook.com/acme", company: "Acme Fttest", city: "Springfield", stateCode: "IL" },
    { email: "jo@gmail.com", website: null, company: "Acme Fttest", city: null, stateCode: null },
  ];
  for (const f of composite) {
    const r = await one(
      `SELECT public.fn_fit_domain_ok(nullif(split_part(coalesce($1, ''), '@', 2), '')) AS email_key, public.fn_fit_domain_ok($2) AS website_key,
              public.fn_fit_name_key($3, $4, $5) AS name_key`,
      [f.email, f.website, f.company, f.city, f.stateCode]
    );
    check(`companyFitKey and the SQL keys agree: ${f.email} / ${f.website}`, same(keysFromRow(r), companyFitKey(f, EX)), JSON.stringify({ sql: keysFromRow(r), js: companyFitKey(f, EX) }));
  }
  const lk = leadFitKeySql("l");
  check("leadFitKeySql reads the lead's email, website and name, and refuses a bad alias", lk.email_key.includes("l.email") && lk.website_key.includes("l.domain") &&
    lk.name_key.includes("l.state_code") && leadFitKeySql("x; drop").email_key.includes("l.email"));

  // ── Fixtures: clients, users, tables ──────────────────────────────────────
  for (const [t, type] of [[TAG_A, "Cleaning"], [TAG_B, "Cleaning"], [TAG_O, "Non-Cleaning"]]) {
    await pool.query(`INSERT INTO client_tags (tag, name, client_type, b2b_instance, b2c_instance) VALUES ($1, $2, $3, $4, $5)`, [
      t, `Fit test ${t.slice(PREFIX.length)}`, type, B2B, B2C,
    ]);
  }
  await pool.query(`INSERT INTO client_targeting (client_tag, countries) VALUES ($1, '{US}')`, [TAG_A]);
  for (const role of ["owner", "admin", "manager", "viewer"]) {
    const id = randomUUID();
    const email = `fttest-${role}-${RUN}@${HOST}`;
    await pool.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
    await pool.query(`INSERT INTO user_profiles (id, email, full_name, role, is_active) VALUES ($1, $2, $3, $4, true)`, [id, email, `Fit test ${role}`, role]);
    USERS[role] = id;
  }
  const tablesA = {
    companies: (await ensureTable(pool, TAG_A, "companies")).id,
    inboxes: (await ensureTable(pool, TAG_A, "inboxes")).id,
    people: (await ensureTable(pool, TAG_A, "people")).id,
  };
  T.worker = heartbeat();

  // ── B. The scorer ─────────────────────────────────────────────────────────
  section("B. The scorer (OpenAI stubbed)");
  resetFitLoop();
  const q1 = await enqueueCompanies(pool, [{ key_kind: "domain", key: dom("idle"), facts: { name: "Idle Fttest" }, priority: 3, source: "campaigns" }]);
  for (const [why, settings, env] of [
    [WAITING_FOR_RULE, await settingsWith(SCORING_ON()), FAKE_OPENAI],
    ["Scoring is off", await settingsWith(WITH_RULE()), FAKE_OPENAI],
    ["Needs OPENAI_API_KEY on the worker", await settingsWith({ ...SCORING_ON(), ...WITH_RULE() }), {}],
    ["No model is set for fit_score", await settingsWith({ ...SCORING_ON(), ...WITH_RULE(), models: { ...(await settingsWith()).models, fit_score: null } }), FAKE_OPENAI],
  ]) {
    const n = await fitLoopOnce({ pool, env, settings });
    check(`idle, and says so: ${why}`, n === 0 && fitLoopStatus().why === why && net.openai.length === 0, `${n} ${fitLoopStatus().why}`);
  }
  check("an idle scorer leaves the queue alone", q1.queued === 1 && (await one(`SELECT count(*)::int AS n FROM company_fit_queue WHERE claim_token IS NULL AND key = $1`, [dom("idle")])).n === 1);
  await pool.query(`DELETE FROM company_fit_queue WHERE key = $1`, [dom("idle")]);

  const S1 = await settingsWith({ ...SCORING_ON(), ...WITH_RULE() });
  const batch = Array.from({ length: 7 }, (_, i) => ({ key_kind: "domain", key: dom(`batch${i}`), facts: { name: `Batch Fttest ${i}`, domain: dom(`batch${i}`) }, priority: 3, source: "campaigns" }));
  batch.forEach((b, i) => net.plan.set(b.key, { score: (i % 5) + 1, home: i === 2, reason: `Made-up reason ${i}` }));
  await enqueueCompanies(pool, batch);
  net.reverse = true;
  const spentBefore = (await spentToday(pool)).openai_usd_fit;
  const n1 = await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  const n2 = await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  net.reverse = false;
  const sizes = net.openai.map((b) => JSON.parse(b.input.slice(b.input.indexOf("Companies:\n") + 11)).length);
  check("batches of batch_size, two calls at once: 3 + 3, then 1", n1 === 6 && n2 === 1 && same(sizes, [3, 3, 1]), JSON.stringify({ n1, n2, sizes }));
  const b0 = net.openai[0];
  check("the request: the rule verbatim, our format part, the companies with ids, Luna at low effort, a strict schema, no tools",
    b0.model === "gpt-6-luna" && b0.reasoning?.effort === "low" && b0.instructions === RULE && b0.input.startsWith(FIT_FORMAT_TEXT) &&
      b0.text?.format?.type === "json_schema" && b0.text.format.strict === true && same(b0.text.format.schema, FIT_ANSWER_SCHEMA) && !("tools" in b0) &&
      same(JSON.parse(b0.input.slice(b0.input.indexOf("Companies:\n") + 11)).map((c) => c.id), ["1", "2", "3"]) &&
      same(buildFitRequest({ prompt: RULE, model: "gpt-6-luna", effort: "low", companies: JSON.parse(b0.input.slice(b0.input.indexOf("Companies:\n") + 11)) }), b0),
    JSON.stringify(b0).slice(0, 400));
  check("our format part says nothing about what a good fit is", !/good fit|bad fit|cleaning|home office is/i.test(FIT_FORMAT_TEXT));
  const got = await all(`SELECT key, score, home_office, reason, status, model, rule_version, source FROM company_fit WHERE key LIKE $1 ORDER BY key`, [`batch%-${RUN}.${HOST}`]);
  check("answers in another order still land on the right company", got.length === 7 && got.every((r) => {
    const i = Number(/batch(\d)/.exec(r.key)[1]);
    return r.score === (i % 5) + 1 && r.home_office === (i === 2) && r.reason === `Made-up reason ${i}` && r.status === "scored" &&
      r.model === "gpt-6-luna" && r.rule_version === "fttest-1" && r.source === "campaigns";
  }), JSON.stringify(got.slice(0, 2)));
  const blockedBatch = await all(`SELECT key, blocked FROM company_fit WHERE key LIKE $1 AND blocked`, [`batch%-${RUN}.${HOST}`]);
  check("scores under the threshold (2) are blocked, by the trigger", blockedBatch.length === got.filter((r) => r.score < 2).length && blockedBatch.length === 2);
  const unit = openAiCost({ model: "gpt-6-luna", usage: { input_tokens: 1000, output_tokens: 200 } }, S1.spend_caps.openai_prices).usd;
  const spentAfter = (await spentToday(pool)).openai_usd_fit;
  check("each answered call is counted against today's fit cap", Math.abs(spentAfter - spentBefore - 3 * unit) < 1e-6, `${spentBefore} -> ${spentAfter}, unit ${unit}`);
  check("parseFitAnswer: every id once, whole scores 1 to 5 or null, reasons cut to 300", (() => {
    const p = parseFitAnswer({ output_text: JSON.stringify({ results: [
      { id: "1", score: 2, home_office: true, reason: "x".repeat(400) }, { id: "2", score: 6, home_office: false, reason: "" },
      { id: "3", score: 2.5, home_office: null, reason: "" }, { id: "4", score: null, home_office: null, reason: "can't tell" },
      { id: "5", score: 1, home_office: false, reason: "" }, { id: "5", score: 1, home_office: false, reason: "" }, { id: "9", score: 1, home_office: false, reason: "" },
    ] }) }, ["1", "2", "3", "4", "5", "6"]);
    return same(p.bad, ["2", "3", "5", "6"]) && p.ok.length === 2 && p.ok[0].reason.length === 300 && p.ok[1].score === null;
  })());

  // A missing id: tried alone, then unscorable.
  resetFitLoop();
  net.openai.length = 0;
  const miss = [0, 1, 2].map((i) => ({ key_kind: "domain", key: dom(`miss${i}`), facts: { name: `Miss Fttest ${i}`, domain: dom(`miss${i}`) }, priority: 3, source: "campaigns" }));
  net.plan.set(dom("miss1"), { omit: true });
  await enqueueCompanies(pool, miss);
  for (let i = 0; i < 3; i++) await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  const missSizes = net.openai.map((b) => JSON.parse(b.input.slice(b.input.indexOf("Companies:\n") + 11)).length);
  const m1 = await fitOf("domain", dom("miss1"));
  check("a company missing from the answer is tried again on its own, then written unscorable after 3 tries",
    same(missSizes, [3, 1, 1]) && m1?.status === "unscorable" && m1.score === null && /3 tries/.test(m1.reason ?? "") && m1.blocked === true &&
      (await fitOf("domain", dom("miss0")))?.status === "scored" && !(await one(`SELECT 1 AS x FROM company_fit_queue WHERE key = $1`, [dom("miss1")])),
    JSON.stringify({ missSizes, m1 }));

  // A manual score is never replaced; unchanged inputs skip the call; a new rule version scores again.
  net.openai.length = 0;
  await pool.query(
    `INSERT INTO company_fit (key_kind, key, score, home_office, reason, status, source, scored_by) VALUES ('domain', $1, 5, false, 'set by hand', 'manual', 'manual', $2)`,
    [dom("manual"), USERS.admin]
  );
  await enqueueCompanies(pool, [{ key_kind: "domain", key: dom("manual"), facts: { name: "Manual Fttest" }, priority: 3, source: "campaigns" }]);
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  const kept = await fitOf("domain", dom("manual"));
  const overWrite = await writeScores(pool, [{ key_kind: "domain", key: dom("manual"), score: 1, home_office: true, reason: "x", status: "scored", inputs_hash: null, source: "campaigns" }], { model: "gpt-6-luna", ruleVersion: "fttest-1" });
  const kept2 = await fitOf("domain", dom("manual"));
  check("a manual score is never sent, and never replaced by a re-score", net.openai.length === 0 && kept.score === 5 && kept.status === "manual" && overWrite === 0 && kept2.score === 5 && kept2.status === "manual");
  // The batch's first company again, with the same facts: no call.
  const reusedBefore = fitLoopStatus().reused;
  const hash0 = inputsHash({ facts: { name: "Batch Fttest 0", domain: dom("batch0") }, ruleVersion: "fttest-1", model: "gpt-6-luna" });
  const stored0 = await fitOf("domain", dom("batch0"));
  await enqueueCompanies(pool, [batch[0]]);
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  check("an unchanged input hash (facts, rule version, model) skips the call", stored0.inputs_hash === hash0 && net.openai.length === 0 && fitLoopStatus().reused === reusedBefore + 1 &&
    !(await one(`SELECT 1 AS x FROM company_fit_queue WHERE key = $1`, [dom("batch0")])));
  await enqueueCompanies(pool, [batch[0]]);
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: await settingsWith({ ...SCORING_ON(), ...WITH_RULE("fttest-2") }) });
  check("a new rule version scores it again, and the score keeps its version", net.openai.length === 1 && (await fitOf("domain", dom("batch0"))).rule_version === "fttest-2");

  // The daily fit cap.
  net.openai.length = 0;
  resetFitLoop();
  await enqueueCompanies(pool, [{ key_kind: "domain", key: dom("capped"), facts: { name: "Capped Fttest" }, priority: 3, source: "campaigns" }]);
  const capS = await settingsWith({ ...SCORING_ON(), ...WITH_RULE(), spend_caps: { ...(await settingsWith()).spend_caps, openai_usd_per_day: { pipeline: 20, fit: 0 } } });
  const nCap = await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: capS });
  check("past the daily fit cap the scorer waits, with no call and nothing claimed", nCap === 0 && net.openai.length === 0 && fitLoopStatus().state === "waiting" &&
    /cap for fit scoring/.test(fitLoopStatus().why ?? "") && (await one(`SELECT count(*)::int AS n FROM company_fit_queue WHERE key = $1 AND claim_token IS NULL`, [dom("capped")])).n === 1,
    JSON.stringify(fitLoopStatus()));

  // Billing stops the loop until scoring is switched off and on again.
  resetFitLoop();
  net.fail.push({ status: 429, body: { error: { code: "insufficient_quota", message: "made-up quota" } } });
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  const stopped = fitLoopStatus();
  const callsAtStop = net.openai.length;
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  check("a billing refusal stops the loop and says so; it is not retried", stopped.billing_stopped && stopped.state === "stopped" && /billing/.test(stopped.why ?? "") &&
    net.openai.length === callsAtStop && (await one(`SELECT count(*)::int AS n FROM company_fit_queue WHERE key = $1 AND claim_token IS NULL`, [dom("capped")])).n === 1);
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: await settingsWith(WITH_RULE()) });
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  check("switched off and on again, it scores again", !fitLoopStatus().billing_stopped && (await fitOf("domain", dom("capped")))?.status === "scored");

  // Pipeline companies: their key, their aliases, the score copied onto the row.
  resetFitLoop();
  net.openai.length = 0;
  const acmeRow = await addCompany(tablesA, TAG_A, { slug: "acme", name: "Acme Fttest", cells: { held_people: { count: 1, titles: ["Facilities Manager"] } } });
  await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `office@${dom("acme-services")}`, cells: {}, question: true });
  await addContact(tablesA, TAG_A, acmeRow, { kind: "person", email: `pat@${dom("acme-people")}`, cells: {}, question: true });
  const keyless = await addCompany(tablesA, TAG_A, { slug: null, name: "Keyless Fttest", state: null, city: null });
  net.plan.set(dom("acme"), { score: 3, home: false, reason: "Made-up: a fit" });
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  const acmeE = await one(`SELECT fit_score, home_office, fit_reason, fit_key_kind, fit_key, fit_scored_at FROM enrich_companies WHERE row_id = $1`, [acmeRow]);
  const acmeQ = net.openai.at(-1);
  const sentFacts = acmeQ ? JSON.parse(acmeQ.input.slice(acmeQ.input.indexOf("Companies:\n") + 11)).find((c) => c.domain === dom("acme")) : null;
  check("a pipeline company that passes is keyed, queued, scored, and its row shows the score", acmeE.fit_key_kind === "domain" && acmeE.fit_key === dom("acme") &&
    acmeE.fit_score === 3 && acmeE.home_office === false && acmeE.fit_reason === "Made-up: a fit" && acmeE.fit_scored_at !== null, JSON.stringify(acmeE));
  check("its facts: name, domain, place, industry, size, AI Ark's description and type, the titles held", sentFacts?.name === "Acme Fttest" && sentFacts.state === "IL" &&
    sentFacts.city === "Springfield" && sentFacts.industry === "Commercial cleaning" && sentFacts.employees === "11-50" && /Made-up description/.test(sentFacts.description) &&
    sentFacts.company_type === "Private" && same(sentFacts.titles, ["Facilities Manager"]), JSON.stringify(sentFacts));
  const aliasRows = await all(`SELECT key_kind, key, fit_kind, fit_key, blocked FROM company_fit_keys WHERE fit_key = $1 ORDER BY key_kind, key`, [dom("acme")]);
  check("aliases for its contacts' email domains and its name key point at its score", ["acme-services", "acme-people"].every((s) => aliasRows.some((a) => a.key === dom(s))) &&
    aliasRows.some((a) => a.key_kind === "name" && a.key === "acme fttest|springfield|IL") && aliasRows.some((a) => a.key === dom("acme") && a.fit_key === dom("acme")),
    JSON.stringify(aliasRows));
  check("a pipeline company with no key at all is marked so and never asked again", /No key to score/.test((await one(`SELECT fit_reason FROM enrich_companies WHERE row_id = $1`, [keyless])).fit_reason ?? ""));
  const lookup = await FIT_ACTIONS.fit_lookup.run({ inputs: { domain: dom("acme"), company: "Acme Fttest", city: "Springfield", state: "IL" }, config: { show: "score" }, db: pool });
  const lookupHome = await FIT_ACTIONS.fit_lookup.run({ inputs: { domain: null, company: "Acme Fttest", city: "Springfield", state: "IL" }, config: { show: "home_office" }, db: pool });
  const lookupNone = await FIT_ACTIONS.fit_lookup.run({ inputs: { domain: dom("nobody"), company: "Nobody Fttest", city: "X", state: "IL" }, config: {}, db: pool });
  check("fit_lookup shows the shared score on a row (by domain, else by name), free and never cached", FIT_ACTIONS.fit_lookup.cache === false &&
    lookup.status === "done" && lookup.value.score === 3 && lookup.display === "3 of 5" && lookupHome.status === "done" && lookupHome.display === "No" &&
    lookupNone.status === "empty", JSON.stringify({ lookup, lookupHome, lookupNone }).slice(0, 300));

  // A threshold change: the refresh is marked pending, worked in batches, cleared at 0.
  const { PUT: gatePut, GET: gateGet } = await route("fit/gate");
  as("manager");
  check("the gate's setting is owner and admin only", (await call(gateGet)).status === 403 && (await call(gatePut, { body: { threshold: 3 } })).status === 403);
  as("admin");
  const viewG = await call(gateGet);
  check("the gate as an admin sees it: off, no client, threshold 2", viewG.status === 200 && viewG.body.enabled === false && viewG.body.tags.length === 0 && viewG.body.threshold === 2 &&
    viewG.body.known_types.includes("Cleaning"));
  const badG = await call(gatePut, { body: { tags: ["FTTEST_NOPE_X"] } });
  check("an unknown client tag is refused", badG.status === 400 && /Not client tags/.test(badG.body.error));
  const putG = await call(gatePut, { body: { threshold: 4 } });
  const refreshAfterPut = (await one(`SELECT value FROM enrich_settings WHERE key = 'fit_gate_refresh'`)).value;
  check("a threshold change is saved, logged and marks the refresh pending", putG.status === 200 && putG.body.gate.threshold === 4 && refreshAfterPut.pending === true &&
    T.audits.some((a) => a.action === "fit_gate" && /threshold 2 to 4/.test(a.details)));
  const stale = (await one(`SELECT count(*)::int AS n FROM company_fit WHERE key LIKE '%fttest%' AND blocked IS DISTINCT FROM (score < 4 OR status = 'unscorable')`)).n;
  const step1 = (await one(`SELECT public.fn_fit_refresh_blocked(1) AS n`)).n;
  const n3 = await refreshBlockedOnce(pool);
  const refreshDone = (await one(`SELECT value FROM enrich_settings WHERE key = 'fit_gate_refresh'`)).value;
  const stale2 = (await one(`SELECT count(*)::int AS n FROM company_fit WHERE key LIKE '%fttest%' AND blocked IS DISTINCT FROM (score < 4 OR status = 'unscorable')`)).n;
  check("the refresh works in batches (one row with a batch of 1), then clears pending at 0", stale > 1 && step1 === 1 && n3 === stale - 1 && refreshDone.pending === false && stale2 === 0,
    JSON.stringify({ stale, step1, n3, refreshDone, stale2 }));
  check("aliases follow their score's blocked flag", (await one(`SELECT count(*)::int AS n FROM company_fit_keys k JOIN company_fit f ON f.key_kind = k.fit_kind AND f.key = k.fit_key WHERE k.blocked IS DISTINCT FROM f.blocked`)).n === 0);
  await call(gatePut, { body: { threshold: 2 } });
  while (await refreshBlockedOnce(pool)) { /* back to 2 */ }

  // ── E. Promotion ──────────────────────────────────────────────────────────
  section("E. Promotion into leads (switch off as shipped)");
  // Fallback words of the template's columns, made up here (the originals' come from enrich_originals).
  const FALLBACK = { use_city: "FT-local", use_state: "FT-area", use_address: "FT-no-address", use_phone_number: "FT-there", use_google_maps_url: "FT-no-maps" };
  for (const t of [tablesA.inboxes, tablesA.people]) {
    let pos = 1;
    for (const [k, word] of Object.entries(FALLBACK)) {
      const isWaterfall = k === "use_state";
      await pool.query(
        `INSERT INTO enrich_columns (table_id, key, name, position, kind, formula, waterfall, data_type, phase)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'text', 1)`,
        [t, k, `Fit test ${k}`, pos++, isWaterfall ? "waterfall" : "formula", isWaterfall ? null : `{{${k.replace(/^use_/, "")}}} || ${JSON.stringify(word)}`,
         isWaterfall ? JSON.stringify([{ formula: "{{state}}" }, JSON.stringify(word)]) : null]
      );
    }
  }
  check("fallbackOf reads a column's own fallback word (formula and waterfall), and drops only that word",
    fallbackOf({ kind: "formula", formula: '{{city}} || "FT-local"' }) === "FT-local" &&
      fallbackOf({ kind: "waterfall", waterfall: [{ formula: "{{state}}" }, '"FT-area"'] }) === "FT-area" &&
      fallbackOf({ kind: "formula", formula: "{{city}}" }) === null && withoutFallback("FT-local", "FT-local") === "" && withoutFallback("Chicago", "FT-local") === "Chicago");
  const inboxCells = (email, over = {}) => ({
    general_email: email, use_first_name: "Acme Fttest Team", use_last_name: "(General Email)", normalized_company_name: "Acme Fttest",
    company: "Acme Fttest LLC", use_city: "FT-local", use_state: "IL", use_address: "1 Made-up St", use_domain: dom("acme"),
    use_phone_number: "FT-there", use_google_maps_url: "https://maps.fttest.example/1", question: "Made-up question for the inbox?",
    exclusion_large_company_check: true, reoon_stamp_of_approval: true, ...over,
  });
  const personCells = (email, over = {}) => ({
    use_work_email: email, email, use_first_name: "Pat", use_last_name: "Fttest", full_name: "Pat Fttest", title: "Facilities Manager",
    normalized_company_name: "Acme Fttest", company: "Acme Fttest LLC", use_city: "Springfield", use_state: "IL", use_address: "FT-no-address",
    use_domain: dom("acme"), use_phone_number: "(312) 555-0100", use_google_maps_url: "FT-no-maps", person_linkedin_url: "https://linkedin.fttest.example/in/pat",
    question: "Made-up question for Pat?", seniority: "Manager", person_country: "US", exclusion_large_company_check: true, reoon_stamp_of_approval: true, ...over,
  });
  // Pure rows.
  const ib = inboxLeadRow(inboxCells(`Info@${dom("acme")}`), { fallbacks: FALLBACK, industry: "Commercial cleaning" });
  check("an inbox lead from the original columns: lower-case address, the team name, (General Email), general, no fallback words, the question",
    ib.hold === null && ib.refuse === null && ib.lead.email === `info@${dom("acme")}` && ib.lead.first_name === "Acme Fttest Team" &&
      ib.lead.last_name === "(General Email)" && ib.lead.email_type === "general" && ib.lead.company === "Acme Fttest" && ib.lead.city === "" &&
      ib.lead.company_phone === "" && ib.lead.state === "IL" && ib.lead.question === "Made-up question for the inbox?" && ib.lead.validation_status === "valid" &&
      ib.lead.source === "Companies (AI Ark)" && ib.lead.general_industry === "Commercial cleaning" && ib.row.length === 19, JSON.stringify(ib.lead));
  const pr = personLeadRow(personCells(`pat@${dom("acme")}`), { fallbacks: FALLBACK, industry: "Commercial cleaning" });
  check("a person lead from the original columns: P#55's address, names, title, LinkedIn, seniority and country, no fallback words",
    pr.hold === null && pr.lead.first_name === "Pat" && pr.lead.last_name === "Fttest" && pr.lead.title === "Facilities Manager" && pr.lead.address === "" &&
      pr.lead.google_maps_url === "" && pr.lead.company_phone === "(312) 555-0100" && pr.lead.person_linkedin.endsWith("/in/pat") && pr.lead.seniority === "Manager" &&
      pr.lead.country === "US" && pr.lead.email_type === "", JSON.stringify(pr.lead));
  check("held back: a masked name, an inbox first name with undefined, anything Reoon did not approve; refused: the brand list",
    personLeadRow(personCells("a@x.fttest.example", { use_last_name: "Ba***e" })).hold === HOLD.masked &&
      inboxLeadRow(inboxCells("a@x.fttest.example", { use_first_name: "undefined Team" })).hold === HOLD.first_name &&
      inboxLeadRow(inboxCells("a@x.fttest.example", { reoon_stamp_of_approval: false })).hold === HOLD.validation &&
      personLeadRow(personCells("finder@x.fttest.example", { email: "other@x.fttest.example" })).hold === HOLD.validation &&
      inboxLeadRow(inboxCells("a@x.fttest.example", { exclusion_large_company_check: false })).refuse === REFUSED_BRAND);

  // Contacts of the promotion fixtures (acme is scored 3; low is scored 1, so blocked; one company's contact sits on a blocked
  // domain; plain has no score and no key, as every company has while fit scoring is off).
  const lowRow = await addCompany(tablesA, TAG_A, { slug: "lowfit", name: "Lowfit Fttest" });
  await score("domain", dom("lowfit"), 1, { source: "pipeline" });
  await pool.query(`UPDATE enrich_companies SET fit_key_kind = 'domain', fit_key = $2 WHERE row_id = $1`, [lowRow, dom("lowfit")]);
  const aliasRow = await addCompany(tablesA, TAG_A, { slug: "fine", name: "Fine Fttest" });
  await score("domain", dom("fine"), 4, { source: "pipeline" });
  await score("domain", dom("badmail"), 1);
  await pool.query(`UPDATE enrich_companies SET fit_key_kind = 'domain', fit_key = $2 WHERE row_id = $1`, [aliasRow, dom("fine")]);
  const plainRow = await addCompany(tablesA, TAG_A, { slug: "plain", name: "Plain Fttest" });
  const existing = await addLead({ email: `known@${dom("acme")}`, company: "Already Fttest", source: "earlier upload" });
  const C = {
    i1: await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `info@${dom("acme")}`, cells: inboxCells(`info@${dom("acme")}`) }),
    i2: await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `sales@${dom("acme")}`, cells: inboxCells(`sales@${dom("acme")}`, { question: null }), question: false }),
    i3: await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `team@${dom("acme")}`, cells: inboxCells(`team@${dom("acme")}`, { use_first_name: "undefined Team" }) }),
    i4: await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `hello@${dom("acme")}`, cells: inboxCells(`hello@${dom("acme")}`, { reoon_stamp_of_approval: false }) }),
    i5: await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `brand@${dom("acme")}`, cells: inboxCells(`brand@${dom("acme")}`, { exclusion_large_company_check: false }) }),
    i6: await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `held@${dom("acme")}`, cells: inboxCells(`held@${dom("acme")}`), held: true }),
    i7: await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `known@${dom("acme")}`, cells: inboxCells(`known@${dom("acme")}`) }),
    i8: await addContact(tablesA, TAG_A, acmeRow, { kind: "general", email: `office@${dom("acme-svc")}`, cells: inboxCells(`office@${dom("acme-svc")}`) }),
    p1: await addContact(tablesA, TAG_A, acmeRow, { kind: "person", email: `pat@${dom("acme")}`, cells: personCells(`pat@${dom("acme")}`) }),
    p2: await addContact(tablesA, TAG_A, acmeRow, { kind: "person", email: `masked@${dom("acme")}`, cells: personCells(`masked@${dom("acme")}`, { use_last_name: "Ba***e" }) }),
    p3: await addContact(tablesA, TAG_A, acmeRow, { kind: "person", email: `far@${dom("acme")}`, cells: personCells(`far@${dom("acme")}`), outcome: "Outside the client's area" }),
    l1: await addContact(tablesA, TAG_A, lowRow, { kind: "general", email: `info@${dom("lowfit")}`, cells: inboxCells(`info@${dom("lowfit")}`) }),
    b1: await addContact(tablesA, TAG_A, aliasRow, { kind: "general", email: `info@${dom("badmail")}`, cells: inboxCells(`info@${dom("badmail")}`) }),
    u1: await addContact(tablesA, TAG_A, plainRow, { kind: "general", email: `info@${dom("plain")}`, cells: inboxCells(`info@${dom("plain")}`) }),
    u2: await addContact(tablesA, TAG_A, plainRow, {
      kind: "person", email: `lee@${dom("plain")}`, cells: personCells(`lee@${dom("plain")}`, { use_first_name: "Lee", full_name: "Lee Fttest" }),
    }),
  };
  const PROMO_ON = { promotion: { ...snapshot.promotion, promote_to_leads: true, tags: [TAG_A] } };
  const { POST: promotePost } = await route("companies/promote");
  const { POST: promoteAuto } = await route("companies/promote/auto");
  const sheetRoute = await route("companies/settings");
  const { GET: panelGet } = await route("fit/state");
  const { settingsInputOf } = await srcModule("lib/companies/server.ts");
  const leadsBefore = Number((await one(`SELECT count(*)::int AS n FROM leads`)).n);
  as("viewer");
  check("promotion is manager and up", (await call(promotePost, { body: { tag: TAG_A } })).status === 403);
  as("manager");
  T.settingsRows = [];
  const r0 = await call(promotePost, { body: { tag: TAG_A } });
  check("refused while promotion is off (as shipped), saying where it is switched on", r0.status === 409 && /off for this client/.test(r0.body.error) &&
    /Companies tab's settings/.test(r0.body.error), JSON.stringify(r0.body));
  T.settingsRows = [{ key: "promotion", value: { ...PROMO_ON.promotion, tags: [TAG_B] } }];
  const rNot = await call(promotePost, { body: { tag: TAG_A } });
  check("refused for a client not on its list", rNot.status === 409 && /not on its list/.test(rNot.body.error));
  T.settingsRows = [];
  check("nothing was added by a refused round", Number((await one(`SELECT count(*)::int AS n FROM leads`)).n) === leadsBefore);
  const promoS = (promotion, extra = []) => settingsFrom([{ key: "promotion", value: promotion }, ...extra]);
  check("promotionAllowed asks for the switch and the client list only: no fit rule, model, gate or score",
    promotionAllowed(promoS({ promote_to_leads: true, tags: [TAG_A] }, [{ key: "models", value: { fit_score: null } }]), TAG_A).ok === true &&
      promotionAllowed(promoS({ promote_to_leads: true, tags: [TAG_A], min_fit_score: 5 }), TAG_A).ok === true &&
      !promotionAllowed(promoS({ promote_to_leads: false, tags: [TAG_A] }), TAG_A).ok && !promotionAllowed(promoS({ promote_to_leads: true, tags: [TAG_B] }), TAG_A).ok &&
      !(await gateEnabled(pool)) && (await settingsWith()).fit_rule.prompt === null);

  // The switch and its client list on the Companies tab's settings sheet: admin only, checked, merged over the stored row,
  // versioned and logged, as the other pipeline switches.
  as("manager");
  check("the settings sheet is admin only (403)", (await call(sheetRoute.GET)).status === 403 && (await call(sheetRoute.PUT, { body: {} })).status === 403);
  as("admin");
  const sheet = await call(sheetRoute.GET);
  const sv = sheet.body?.value?.promotion;
  check("the sheet shows promotion as shipped: off, no client, a question required, its source label (min_fit_score is not shown)",
    sheet.status === 200 && sv?.promote_to_leads === false && same(sv.tags, []) && sv.require_question === true && sv.source_label === "Companies (AI Ark)" &&
      !("min_fit_score" in sv) && same(settingsInputOf(sheet.body.value).promotion, { promote_to_leads: false, tags: [], auto_push: false }) &&
      /promotion@/.test(sheet.body.version),
    JSON.stringify({ sv, version: sheet.body?.version }));
  const sheetEdit = (body, f) => {
    const x = structuredClone(settingsInputOf(body.value));
    f(x);
    return { body: { version: body.version, ...x } };
  };
  for (const [label, f, re] of [
    ["a client list with something that is not a tag", (x) => { x.promotion.tags = ["not a tag!"]; }, /Promotion into leads: not a tag! is not a client tag/],
    ["a switch that is not on or off", (x) => { x.promotion.promote_to_leads = "yes"; }, /Promotion into leads must be on or off/],
    ["not the block's shape", (x) => { x.promotion = [1]; }, /Promotion into leads: must be the switch/],
  ]) {
    const bad = await call(sheetRoute.PUT, sheetEdit(sheet.body, f));
    check(`the sheet refuses ${label} (400)`, bad.status === 400 && re.test(bad.body.error ?? ""), `${bad.status} ${bad.body.error ?? ""}`);
  }
  const promoRow = async () => one(`SELECT value, updated_at::text AS at FROM enrich_settings WHERE key = 'promotion'`);
  const pr0 = await promoRow();
  const unchanged = await call(sheetRoute.PUT, sheetEdit(sheet.body, () => {}));
  const leftOut = await call(sheetRoute.PUT, sheetEdit(sheet.body, (x) => { delete x.promotion; }));
  check("the sheet sent back unchanged, or without promotion (an older sheet), writes nothing to its row",
    unchanged.status === 200 && unchanged.body.changes.length === 0 && leftOut.status === 200 && leftOut.body.changes.length === 0 && (await promoRow()).at === pr0.at,
    JSON.stringify({ unchanged: unchanged.body.changes, leftOut: leftOut.body.changes }));
  const audits0 = T.audits.length;
  const sheetNow = await call(sheetRoute.GET);
  const on = await call(sheetRoute.PUT, sheetEdit(sheetNow.body, (x) => { x.promotion = { promote_to_leads: true, tags: [` ${TAG_A.toLowerCase()} `, TAG_A] }; }));
  const prOn = await promoRow();
  check("switched on for the client on the sheet: each change listed and logged, and the version moves",
    on.status === 200 && same(on.body.changes, ["promotion into leads off to on", `promotion's clients no client to ${TAG_A}`]) &&
      T.audits.slice(audits0).some((a) => a.action === "enrich_settings" && a.details.includes("promotion into leads off to on")) &&
      on.body.version !== sheetNow.body.version && on.body.value.promotion.promote_to_leads === true,
    JSON.stringify(on.body.changes ?? on.body));
  check("... the tag upper case, once; the rest of the row kept as stored (batch size, the question, the label, min_fit_score)",
    prOn.value.promote_to_leads === true && same(prOn.value.tags, [TAG_A]) && prOn.value.batch_max === pr0.value.batch_max &&
      prOn.value.require_question === pr0.value.require_question && prOn.value.source_label === pr0.value.source_label &&
      prOn.value.min_fit_score === pr0.value.min_fit_score && prOn.at !== pr0.at, JSON.stringify(prOn.value));
  check("... the worker reads it on for the client, and a save over the older version is refused (409)",
    settingsFrom(await all(`SELECT key, value FROM enrich_settings`)).flagOn("promotion", TAG_A) && (await call(sheetRoute.PUT, sheetEdit(sheetNow.body, () => {}))).status === 409);
  // min_fit_score is kept but not read: at 5, acme (scored 3) is still promoted below.
  await pool.query(`UPDATE enrich_settings SET value = value || '{"min_fit_score": 5}'::jsonb WHERE key = 'promotion'`);

  // The fit panel: promotion on for the client, with no rule, scoring off and the gate not covering it. Ready is the query's
  // count, before the row checks: inboxes B's (no address), i1, i3, i4, i5, i7, i8 and u1 (i2 lacks a question; i6 is held;
  // l1 and b1 are blocked); people B's, p1, p2 and u2 (p3 is outside the area).
  as("manager");
  const panel = await call(panelGet, { query: { tag: TAG_A } });
  const pc = panel.body?.promotion?.counts;
  check("the fit panel: promotion on for the client and nothing blocking it, though there is no rule and the gate does not cover it",
    panel.status === 200 && panel.body.promotion.on_for_client === true && panel.body.promotion.blocked_why === null && panel.body.gate.covers_client === false &&
      panel.body.rule.set === false && !("min_fit_score" in panel.body.promotion) && pc?.general.ready === 8 && pc.general.no_question === 1 &&
      pc.person.ready === 4 && pc.person.no_question === 0,
    JSON.stringify(panel.body?.promotion));

  // A round: promotion on from the sheet, the gate off for the client, no rule, no model, min_fit_score 5.
  T.settingsRows = [{ key: "models", value: { ...(await settingsWith()).models, fit_score: null } }];
  const rGo = await call(promotePost, { body: { tag: TAG_A } });
  await drainAfter();
  const states = Object.fromEntries((await all(`SELECT row_id, promote_state, lead_id FROM enrich_contacts WHERE client_tag = $1`, [TAG_A])).map((r) => [Number(r.row_id), r]));
  check("a round with no fit rule, model, gate or score: inboxes and people each one upload batch, those held back left for later",
    rGo.status === 202 && rGo.body.batches?.length === 2 && rGo.body.adding === 5, JSON.stringify(rGo.body));
  check("added: acme's approved inboxes and person (scored 3, under min_fit_score 5), and both of the company with no score; the address already a lead settled 'Already in the database'",
    states[C.i1].promote_state === "added" && states[C.i8].promote_state === "added" && states[C.p1].promote_state === "added" &&
      states[C.u1].promote_state === "added" && states[C.u2].promote_state === "added" &&
      states[C.i7].promote_state === "in_database" && states[C.i7].lead_id === existing, JSON.stringify([states[C.i1], states[C.p1], states[C.u1], states[C.u2], states[C.i7]]));
  check("held back: no question, an undefined first name, not Reoon's approval, a masked name, held, outside the area, a company scored under the threshold, a blocked domain",
    [C.i2, C.i3, C.i4, C.i6, C.p2, C.p3, C.l1, C.b1].every((id) => states[id].promote_state === null) && states[C.i5].promote_state === "refused",
    JSON.stringify([C.i2, C.i3, C.i4, C.i5, C.i6, C.p2, C.p3, C.l1, C.b1].map((id) => states[id].promote_state)));
  check("the company with no score gets no key, no score and no alias from its promoted leads",
    !(await fitOf("domain", dom("plain"))) && !(await keyOf("domain", dom("plain"))) &&
      (await one(`SELECT fit_key FROM enrich_companies WHERE row_id = $1`, [plainRow])).fit_key === null &&
      (await one(`SELECT lead_id FROM enrich_contacts WHERE row_id = $1`, [C.u1])).lead_id === (await one(`SELECT id FROM leads WHERE email = $1`, [`info@${dom("plain")}`]))?.id);
  const li = await one(`SELECT * FROM leads WHERE email = $1`, [`info@${dom("acme")}`]);
  const lp = await one(`SELECT * FROM leads WHERE email = $1`, [`pat@${dom("acme")}`]);
  check("the inbox lead, through the import engine: fields from the original columns, no fallback words, the question, tagged, the pipeline's label",
    li && li.first_name === "Acme Fttest Team" && li.last_name === "(General Email)" && li.email_type === "general" && li.company === "Acme Fttest" &&
      li.city === null && li.company_phone === null && li.question === "Made-up question for the inbox?" && li.source === "Companies (AI Ark)" &&
      li.validation_status === "valid" && String(li.tags ?? "").includes(TAG_A) && li.general_industry === "Commercial cleaning",
    JSON.stringify(li && { first: li.first_name, last: li.last_name, type: li.email_type, city: li.city, phone: li.company_phone, tags: li.tags, src: li.source }));
  check("the person lead: title, LinkedIn, seniority, country, no address or Maps fallback", lp && lp.title === "Facilities Manager" && lp.person_linkedin?.endsWith("/in/pat") &&
    lp.seniority === "Manager" && lp.address === null && lp.google_maps_url === null && lp.question === "Made-up question for Pat?", JSON.stringify(lp && { t: lp.title, a: lp.address }));
  const cell = await one(`SELECT status, value, display FROM enrich_cells WHERE row_id = $1 AND column_key = 'add_to_database'`, [C.i1]);
  const ub = await all(`SELECT status, source_label, inserted_rows FROM upload_batches WHERE id IN (SELECT batch_id FROM enrich_contacts WHERE row_id = ANY($1::bigint[]))`, [[C.i1, C.i8, C.p1]]);
  const heldCell = await one(`SELECT status, value, display FROM enrich_cells WHERE row_id = $1 AND column_key = 'add_to_database'`, [C.i3]);
  check("each contact's add_to_database cell says what happened, and the upload batches are complete", cell?.status === "done" && cell.value.added === true && cell.value.lead_id === li.id &&
    ub.length === 2 && ub.every((b) => b.status === "complete" && b.source_label === "Companies (AI Ark)") && ub.reduce((n, b) => n + b.inserted_rows, 0) === 5 &&
    heldCell?.status === "skipped" && heldCell.display === "Held back" && heldCell.value.why === HOLD.first_name, JSON.stringify({ cell, ub, heldCell }));
  check("the promotion is in the audit log", T.audits.some((a) => a.action === "company_promote" && a.details.startsWith(TAG_A)));
  const rAgain = await call(promotePost, { body: { tag: TAG_A } });
  await drainAfter();
  check("a second round makes no second lead", rAgain.status === 202 && rAgain.body.adding === 0 &&
    Number((await one(`SELECT count(*)::int AS n FROM leads WHERE email = $1`, [`info@${dom("acme")}`])).n) === 1, JSON.stringify(rAgain.body));
  // The lead's keys became aliases of acme's score.
  check("a promoted contact's address on a new domain becomes an alias of its company's score", (await keyOf("domain", dom("acme-svc")))?.fit_key === dom("acme"));
  // The worker's trigger reads the stored settings: promotion on from the sheet, no rule.
  check("held-back contacts don't make the worker start rounds; a contact whose row is worked again does (no rule needed)", same(await promoteDue(pool, await settingsWith()), []));
  await pool.query(`UPDATE enrich_cells SET value = '"Acme Fttest Team"'::jsonb WHERE row_id = $1 AND column_key = 'use_first_name'`, [C.i3]);
  await pool.query(`UPDATE enrich_contacts SET updated_at = now() WHERE row_id = $1`, [C.i3]);
  const dueNow = await promoteDue(pool, await settingsWith());
  // The worker's trigger.
  const AUTO_KEY = "fttest-auto-key-0123456789abcdef0123";
  const rA0 = await call(promoteAuto, { body: { tag: TAG_A }, headers: { authorization: `Bearer ${AUTO_KEY}` } });
  process.env.AIARK_AUTO_ADD_KEY = AUTO_KEY;
  const rA1 = await call(promoteAuto, { body: { tag: TAG_A }, headers: { authorization: "Bearer not-it" } });
  const rA2 = await call(promoteAuto, { body: { tag: TAG_A }, headers: { authorization: `Bearer ${AUTO_KEY}` } });
  await drainAfter();
  delete process.env.AIARK_AUTO_ADD_KEY;
  check("the worker's route: off without its key, 401 with a wrong one, the same round with the right one (the re-worked contact added)",
    same(dueNow, [TAG_A]) && rA0.status === 503 && rA1.status === 401 && rA2.status === 202 && rA2.body.adding === 1 &&
      (await one(`SELECT promote_state FROM enrich_contacts WHERE row_id = $1`, [C.i3])).promote_state === "added", JSON.stringify({ dueNow, rA2: rA2.body }));
  check("then nothing is due for the client", same(await promoteDue(pool, await settingsWith()), []));
  T.settingsRows = [];
  // Promotion back as it stood; the company with no score left out of the later sections' scoring (as a company with no key is);
  // the gate on for the client, for the alias checks below.
  await setSetting("promotion", snapshot.promotion);
  await pool.query(`UPDATE enrich_companies SET fit_scored_at = now(), fit_reason = 'Made-up: left unscored by test-fit' WHERE row_id = $1`, [plainRow]);
  await gateOn([TAG_A]);

  // ── C. Aliases (8.4 item 3) ───────────────────────────────────────────────
  section("C. Aliases: a re-score reaches a promoted lead on another domain");
  const servicesLead = (await one(`SELECT id FROM leads WHERE email = $1`, [`office@${dom("acme-svc")}`])).id;
  const elig = async (tag, id) => {
    const { rows: [e] } = await pool.query(`SELECT fn_client_eligibility_conditions($1) AS c`, [tag]);
    const { rows } = await pool.query(`SELECT l.id FROM leads l WHERE l.id = $1 AND ${e.c.join(" AND ")}`, [id]);
    return rows.length === 1;
  };
  const in3 = await elig(TAG_A, servicesLead);
  await score("domain", dom("acme"), 1, { source: "pipeline" });
  const out1 = await elig(TAG_A, servicesLead);
  const fitL = await one(`SELECT * FROM public.fn_fit_for_leads($1::uuid[])`, [[servicesLead]]);
  check("acme scored 3, its contact promoted on another domain: the lead passes; re-scored to 1: the gate excludes it", in3 === true && out1 === false &&
    fitL.score === 1 && fitL.blocked === true, JSON.stringify({ in3, out1, fitL }));
  check("the pipeline row follows the re-score", (await one(`SELECT fit_score FROM enrich_companies WHERE row_id = $1`, [acmeRow])).fit_score === 1);
  await score("domain", dom("acme"), 3, { source: "pipeline" });
  await gateOff();

  // ── F. The gate in SQL (inside a rolled-back transaction) ─────────────────
  section("F. The gate in SQL (rolled back)");
  const m093 = source("supabase/migrations/093_client_exclusions_contains.sql");
  const m050 = source("supabase/migrations/050_review_remediation.sql");
  const bodyOf = (text, sig) => {
    const at = text.indexOf(`CREATE OR REPLACE FUNCTION public.${sig}`);
    const open = text.indexOf("AS $function$", at);
    const close = text.indexOf("$function$", open + "AS $function$".length);
    return text.slice(at, close + "$function$".length);
  };
  const eligBefore = bodyOf(m093, "fn_client_eligibility_conditions(p_tag text)").replace("public.fn_client_eligibility_conditions(", "pg_temp.fit_test_elig_before(");
  const exportBefore = bodyOf(m050, "fn_export_leads(").replace("public.fn_export_leads(", "pg_temp.fit_test_export_before(").replace(" SECURITY DEFINER\n", "\n");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query(eligBefore);
    await tx.query(exportBefore);
    const tags = `SELECT tag FROM client_tags UNION SELECT client_tag FROM client_targeting`;
    const diff = async () =>
      (await tx.query(`SELECT t.tag FROM (${tags}) t WHERE public.fn_client_eligibility_conditions(t.tag) IS DISTINCT FROM pg_temp.fit_test_elig_before(t.tag) ORDER BY 1`)).rows.map((r) => r.tag);
    const nTags = (await tx.query(`SELECT count(*)::int AS n FROM (${tags}) t`)).rows[0].n;
    const setGate = (v) => tx.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'fit_gate'`, [JSON.stringify(v)]);
    check(`off: every client's conditions are exactly the 093 body's (${nTags} clients)`, nTags > 100 && (await diff()).length === 0);
    // Made-up leads and scores, inside the transaction.
    const ins = async (cols) => {
      const k = Object.keys(cols);
      return (await tx.query(`INSERT INTO leads (${k.join(", ")}) VALUES (${k.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`, Object.values(cols))).rows[0].id;
    };
    const base = { country_code: "US", source: SRC };
    const L = {
      email: await ins({ ...base, email: `jo@${dom("gx-alias")}`, company: "Gx Fttest", domain: null }),
      website: await ins({ ...base, email: `fttest-gx-${RUN}@gmail.com`, company: "Gw Fttest", domain: `https://www.${dom("gx-site")}/x` }),
      name: await ins({ ...base, email: `fttest-gn-${RUN}@gmail.com`, company: "Gn Fttest", city: "Springfield", state_code: "IL" }),
      good: await ins({ ...base, email: `jo@${dom("gx-good")}`, company: "Good Fttest", domain: dom("gx-good") }),
      platform: await ins({ ...base, email: `fttest-gp-${RUN}@gmail.com`, company: "Gp Fttest", domain: "facebook.com/gp-fttest" }),
    };
    const sc = (kk, k, s, aliases = []) => writeScores(tx, [{ key_kind: kk, key: k, score: s, home_office: s === 1, reason: "made-up", status: "scored", inputs_hash: null, source: "campaigns", aliases }], { model: "gpt-6-luna", ruleVersion: "fttest-1" });
    await sc("domain", dom("gx-site"), 1, [{ key_kind: "domain", key: dom("gx-alias") }]);
    await sc("name", "gn fttest|springfield|IL", 1);
    await sc("domain", dom("gx-good"), 4);
    const ids = Object.values(L);
    const allowed = async (tag) => {
      const c = (await tx.query(`SELECT fn_client_eligibility_conditions($1) AS c`, [tag])).rows[0].c;
      return (await tx.query(`SELECT l.id FROM leads l WHERE l.id = ANY($1::uuid[]) AND ${c.join(" AND ")}`, [ids])).rows.map((r) => r.id);
    };
    const pf = { source: { include: [SRC], exclude: [], includeUnknown: false, selectUnknown: false } };
    const exp = async (fn, f) => ((await tx.query(`SELECT ${fn}($1::jsonb, NULL, 100, 0) AS d`, [JSON.stringify(f)])).rows[0].d.data ?? []).map((r) => r.id).sort();
    check("off: fn_export_leads returns exactly the 050 body's rows", same(await exp("public.fn_export_leads", pf), await exp("pg_temp.fit_test_export_before", pf)) &&
      (await exp("public.fn_export_leads", pf)).length === 5);
    check("off: every made-up lead is eligible for a covered type's client", (await allowed(TAG_A)).length === 5);
    await setGate({ ...SHIPPED_GATE, enabled: true, tags: [] });
    check("on with no client listed: no client's conditions change", (await diff()).length === 0);
    await setGate({ ...SHIPPED_GATE, enabled: true, tags: [TAG_A, TAG_O] });
    const d1 = await diff();
    const condA = (await tx.query(`SELECT fn_client_eligibility_conditions($1) AS c, pg_temp.fit_test_elig_before($1) AS b, public.fn_fit_condition() AS f`, [TAG_A])).rows[0];
    const condB = (await tx.query(`SELECT fn_client_eligibility_conditions($1) AS c, public.fn_fit_condition() AS f`, [TAG_B])).rows[0];
    check("on for one client: only it gets the condition (a listed client of another type does not)", same(d1, [TAG_A]) && same(condA.c, [...condA.b, condA.f]), JSON.stringify(d1));
    check("a client not on the list does not get it", !condB.c.includes(condB.f));
    await setGate({ ...SHIPPED_GATE, enabled: true, tags: [TAG_B] });
    const condB2 = (await tx.query(`SELECT fn_client_eligibility_conditions($1) AS c, public.fn_fit_condition() AS f`, [TAG_B])).rows[0];
    check("the no-targeting branch: the global gate and the fit condition", same(condB2.c, ["(l.location_status IS DISTINCT FROM 'unsupported')", condB2.f]));
    await setGate({ ...SHIPPED_GATE, enabled: true, tags: ["*"] });
    const dStar = await diff();
    const typed = (await tx.query(`SELECT t.tag FROM (${tags}) t JOIN client_tags ct ON ct.tag = t.tag WHERE ct.client_type IN ('Cleaning', 'Canada Cleaning') ORDER BY 1`)).rows.map((r) => r.tag);
    check(`"*": every client of the listed types gets it (${typed.length}), and no other`, same(dStar, typed) && !dStar.includes(TAG_O), `${dStar.length} vs ${typed.length}`);
    await setGate({ ...SHIPPED_GATE, enabled: true, tags: [TAG_A] });
    const allowedOn = await allowed(TAG_A);
    check("a blocked email domain, website domain and name key each keep their leads out; a score of 4 and a platform page stay in",
      same([...allowedOn].sort(), [L.good, L.platform].sort()), JSON.stringify({ allowedOn, L }));
    const ff = Object.fromEntries((await tx.query(`SELECT * FROM public.fn_fit_for_leads($1::uuid[])`, [ids])).rows.map((r) => [r.lead_id, r]));
    check("fn_fit_for_leads gives each lead's score, home-office flag and blocked flag", ff[L.email].score === 1 && ff[L.email].blocked && ff[L.website].blocked &&
      ff[L.name].blocked && ff[L.good].score === 4 && !ff[L.good].blocked && ff[L.platform].score === null && !ff[L.platform].blocked && ff[L.email].home_office === true,
      JSON.stringify(ff));
    check("exports leave out bad fits while the gate is on, and keep them with includeBadFits", same(await exp("public.fn_export_leads", pf), [L.good, L.platform].sort()) &&
      (await exp("public.fn_export_leads", { ...pf, includeBadFits: true })).length === 5);
    await sc("domain", dom("gx-site"), 2, [{ key_kind: "domain", key: dom("gx-alias") }]);
    await sc("name", "gn fttest|springfield|IL", 2);
    check("re-scored to 2, they are let in (the aliases follow at once)", (await allowed(TAG_A)).length === 5);
    await tx.query(`UPDATE enrich_settings SET value = jsonb_set(value, '{require_scored}', 'false') WHERE key = 'fit_gate'`);
    await writeScores(tx, [{ key_kind: "domain", key: dom("gx-good"), score: null, home_office: null, reason: "x", status: "unscorable", inputs_hash: null, source: "campaigns" }], { model: "m", ruleVersion: "v" });
    const letIn = (await allowed(TAG_A)).includes(L.good);
    await tx.query(`UPDATE enrich_settings SET value = jsonb_set(value, '{require_scored}', 'true') WHERE key = 'fit_gate'`);
    const refreshed = (await tx.query(`SELECT public.fn_fit_refresh_blocked() AS n`)).rows[0].n;
    check("an unscorable company is blocked only while require_scored is on", letIn && refreshed >= 1 && !(await allowed(TAG_A)).includes(L.good));
    const refused = await tx.query(`SELECT public.fn_queue_fit_removals($1, '{}'::bigint[])`, [TAG_B]).then(() => false, (e) => /does not cover/.test(e.message));
    check("fn_queue_fit_removals refuses a client the gate does not cover", refused);
  } finally {
    await tx.query("ROLLBACK").catch(() => {});
    tx.release();
  }
  check("the rolled-back checks left the gate off", !(await gateEnabled(pool)) && !(await fitCheckOn(pool, TAG_A)));

  // ── G. Export routes ──────────────────────────────────────────────────────
  section("G. Export routes");
  const { POST: streamPost } = await route("exports/stream");
  const { POST: processPost } = await route("exports/process");
  const EL = {
    bad: await addLead({ email: `jo@${dom("ex-bad")}`, company: "Exbad Fttest", domain: dom("ex-bad"), country_code: "US", source: SRC }),
    site: await addLead({ email: `fttest-exs-${RUN}@gmail.com`, company: "Exsite Fttest", domain: `www.${dom("ex-bad")}`, country_code: "US", source: SRC }),
    good: await addLead({ email: `jo@${dom("ex-good")}`, company: "Exgood Fttest", domain: dom("ex-good"), country_code: "US", source: SRC }),
    none: await addLead({ email: `jo@${dom("ex-none")}`, company: "Exnone Fttest", domain: dom("ex-none"), country_code: "US", source: SRC }),
  };
  await score("domain", dom("ex-bad"), 1);
  await score("domain", dom("ex-good"), 4);
  const exIds = Object.values(EL);
  const FILTERS = { source: { include: [SRC], exclude: [] } };
  const COLS = ["email", "company"];
  const csv = async (res) => {
    const text = await new Response(res.raw.body.pipeThrough(new DecompressionStream("gzip"))).text();
    const lines = text.trim().split("\n");
    return { header: lines[0], rows: lines.slice(1) };
  };
  const streamAs = async (role, body) => {
    as(role);
    return csv(await call(streamPost, { body: { filters: FILTERS, columnSelection: COLS, ...body } }));
  };
  const s0 = await streamAs("manager", { selectedIds: exIds });
  const f0 = await streamAs("manager", {});
  check("gate off: a selected-row export is exactly as before (no fit columns, every lead)", s0.header === "email,company" && s0.rows.length === 4, JSON.stringify(s0));
  check("gate off: a filtered export has every lead", f0.header === "email,company" && f0.rows.length === 4, JSON.stringify(f0));
  await gateOn([TAG_A]);
  const s1 = await streamAs("manager", { selectedIds: exIds });
  const s2 = await streamAs("manager", { selectedIds: exIds, includeBadFits: true });
  const s3 = await streamAs("admin", { selectedIds: exIds, includeBadFits: true });
  const f1 = await streamAs("manager", {});
  const f2 = await streamAs("manager", { includeBadFits: true });
  const f3 = await streamAs("owner", { includeBadFits: true });
  check("gate on: selected rows leave out the blocked leads and end with Fit score and Home office",
    s1.header === "email,company,Fit score,Home office" && s1.rows.length === 2 && s1.rows.some((r) => r === `jo@${dom("ex-good")},Exgood Fttest,4,No`) &&
      s1.rows.some((r) => r === `jo@${dom("ex-none")},Exnone Fttest,,`), JSON.stringify(s1));
  check("a manager's includeBadFits is ignored; an admin's keeps them in", s2.rows.length === 2 && s3.rows.length === 4 && s3.rows.some((r) => r.endsWith(",1,No")));
  check("gate on: filtered exports leave out bad fits; only an owner or admin gets them with includeBadFits",
    f1.rows.length === 2 && f2.rows.length === 2 && f3.rows.length === 4 && f1.header === "email,company", JSON.stringify({ f1: f1.rows.length, f2: f2.rows.length, f3: f3.rows.length }));
  // The legacy export path (storage), selected rows.
  const runProcess = async (role, body) => {
    as(role);
    const r = await call(processPost, { body: { filters: FILTERS, columnSelection: COLS, ...body } });
    if (r.status !== 200) return { status: r.status };
    created.exportJobs.push(r.body.jobId);
    for (let i = 0; i < 80; i++) {
      const j = await one(`SELECT status FROM export_jobs WHERE id = $1`, [r.body.jobId]);
      if (j.status !== "processing") break;
      await sleep(250);
    }
    const { createClient } = await import("@supabase/supabase-js");
    const admin = createClient(API, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data, error } = await admin.storage.from("csv-exports").download(`export_${r.body.jobId}.csv`);
    if (!data) return { status: 0, error: error?.message ?? "no file", job: await one(`SELECT status, error_message FROM export_jobs WHERE id = $1`, [r.body.jobId]) };
    const lines = (await data.text()).trim().split("\n");
    return { status: 200, header: lines[0], rows: lines.slice(1) };
  };
  const p1 = await runProcess("manager", { selectedIds: exIds });
  const p2 = await runProcess("admin", { selectedIds: exIds, includeBadFits: true });
  await gateOff();
  const p0 = await runProcess("manager", { selectedIds: exIds });
  check("the legacy export: with the gate on, blocked rows out and the fit columns at the end; an admin may keep them; off, as before",
    p1.header === "email,company,Fit score,Home office" && p1.rows.length === 2 && p2.rows.length === 4 && p0.header === "email,company" && p0.rows.length === 4,
    JSON.stringify({ p1, p2: p2.rows?.length, p0 }));
  const { includeBadFitsFor, withBadFits } = await srcModule("lib/exports/fit-columns.ts");
  const { buildRpcFilters } = await srcModule("lib/filters/build-rpc-filters.ts");
  const { normalizeFilterState } = await srcModule("types/filters.ts");
  const built = buildRpcFilters(normalizeFilterState({ ...FILTERS, includeBadFits: true }));
  check("includeBadFits never rides in on the filter state; it is added after buildRpcFilters, for an owner or admin only",
    !("includeBadFits" in built) && includeBadFitsFor(true, "owner") && includeBadFitsFor(true, "admin") && !includeBadFitsFor(true, "manager") &&
      !includeBadFitsFor("true", "admin") && withBadFits({ ...built, includeBadFits: true }, false).includeBadFits === undefined &&
      withBadFits(built, true).includeBadFits === true);

  // ── H. Pushes ─────────────────────────────────────────────────────────────
  section("H. Pushes: waiting for scoring, and the push-time check");
  const { POST: batchPost } = await route("bison/push-batch");
  const { POST: cancelPost } = await route("bison/push-batches/cancel");
  const { POST: releasePost } = await route("bison/push-batches/release");
  const { GET: batchesGet } = await route("bison/push-batches");
  const { POST: legacyPush } = await route("bison/push");
  const PT = {
    scored: await addLead({ email: `jo@${dom("pt-scored")}`, company: "Ptscored Fttest", domain: dom("pt-scored"), country_code: "US", source: SRC, validation_status: "valid" }),
    unscored: await addLead({ email: `jo@${dom("pt-new")}`, company: "Ptnew Fttest", domain: dom("pt-new"), country_code: "US", source: SRC, validation_status: "valid" }),
    nokey: await addLead({ email: `fttest-ptn-${RUN}@gmail.com`, company: "Ptnokey Fttest", country_code: "US", source: SRC, validation_status: "valid" }),
  };
  await score("domain", dom("pt-scored"), 4);
  const camp = [{ id: 701, name: `${TAG_A}: Main`, instance_url: B2B }];
  const pushBody = (extra = {}) => ({ campaigns: camp, selectedIds: Object.values(PT), ...extra });
  as("manager");
  const h0 = await call(batchPost, { body: pushBody({ clientTag: TAG_A }) });
  const h0b = await call(batchPost, { body: pushBody() });
  const st0 = (await one(`SELECT status FROM push_batches WHERE id = $1`, [h0.body.batchId]))?.status;
  check("gate off: a push starts 'pending' with the answer as before, and a tagless one too", h0.status === 200 && same(Object.keys(h0.body).sort(), ["batchId", "queued"]) &&
    st0 === "pending" && h0b.status === 200 && (await one(`SELECT status FROM push_batches WHERE id = $1`, [h0b.body.batchId])).status === "pending", JSON.stringify(h0.body));
  await pool.query(`DELETE FROM push_batches WHERE id = ANY($1::uuid[])`, [[h0.body.batchId, h0b.body.batchId]]);
  const lg0 = await call(legacyPush, { body: {} });
  await gateOn([TAG_A]);
  const lg1 = await call(legacyPush, { body: {} });
  check("the legacy push route: unchanged with the gate off (it goes on to its own checks), 410 while the gate is on", lg0.status === 400 && lg1.status === 410, `${lg0.status} ${lg1.status}`);
  const h1 = await call(batchPost, { body: pushBody() });
  check("gate on: a tagless push is refused", h1.status === 409 && /must name its client/.test(h1.body.error));
  const h2 = await call(batchPost, { body: pushBody({ clientTag: TAG_A }) });
  const wb = await one(`SELECT * FROM push_batches WHERE id = $1`, [h2.body.batchId]);
  const h3 = await call(batchPost, { body: pushBody({ clientTag: TAG_B }) });
  check("a gated client's push waits in 'scoring'; another client's starts pending", h2.status === 200 && h2.body.waitsForScoring === true && wb.status === "scoring" &&
    (await one(`SELECT status FROM push_batches WHERE id = $1`, [h3.body.batchId])).status === "pending", JSON.stringify(h2.body));
  await pool.query(`DELETE FROM push_batches WHERE id = $1`, [h3.body.batchId]);
  const h4 = await call(batchPost, { body: pushBody({ clientTag: TAG_A }) });
  check("the double-push guard counts a push waiting for scoring", h4.status === 409 && h4.body.duplicateOf?.id === wb.id && /waiting for fit scoring/.test(h4.body.error), JSON.stringify(h4.body));
  // The fit loop moves it on only when every company is scored.
  await pool.query(`DELETE FROM company_fit_queue WHERE key LIKE '%fttest%'`);
  const adv1 = await advanceScoringBatch({ pool });
  const wb1 = await one(`SELECT status, fit_total, fit_scored, fit_cursor FROM push_batches WHERE id = $1`, [wb.id]);
  const queued1 = await all(`SELECT key, priority, source FROM company_fit_queue WHERE key LIKE '%fttest%'`);
  check("the fit loop pages the push's leads and queues its unscored companies at priority 1", adv1 === wb.id && wb1.status === "scoring" && wb1.fit_total === 1 &&
    queued1.length === 1 && queued1[0].key === dom("pt-new") && queued1[0].priority === 1 && queued1[0].source === "push" && wb1.fit_cursor.done === true && wb1.fit_cursor.nokey === 1,
    JSON.stringify({ wb1, queued1 }));
  await advanceScoringBatch({ pool });
  check("it stays 'scoring' while a company waits", (await one(`SELECT status, fit_scored FROM push_batches WHERE id = $1`, [wb.id])).status === "scoring");
  as("viewer");
  const list = await call(batchesGet, { query: { limit: "20" } });
  const mine = list.body.batches.find((b) => b.id === wb.id);
  check("the batches panel's list carries N of M companies scored", mine?.status === "scoring" && mine.fit_total === 1 && mine.fit_scored === 0, JSON.stringify(mine));
  resetFitLoop();
  await fitLoopOnce({ pool, env: FAKE_OPENAI, settings: S1 });
  await advanceScoringBatch({ pool });
  check("once every company is scored, it is pending again (and the push-worker can gather it)",
    (await one(`SELECT status, fit_scored FROM push_batches WHERE id = $1`, [wb.id])).status === "pending" && (await fitOf("domain", dom("pt-new")))?.status === "scored");
  // A cancel during scoring wins.
  as("manager");
  const h5 = await call(batchPost, { body: pushBody({ clientTag: TAG_A, force: true }) });
  const c5 = await call(cancelPost, { body: { batchId: h5.body.batchId } });
  await advanceScoringBatch({ pool });
  check("a cancel during scoring wins", c5.status === 200 && (await one(`SELECT status FROM push_batches WHERE id = $1`, [h5.body.batchId])).status === "cancelled");
  // Release by an owner or admin, logged.
  const h6 = await call(batchPost, { body: pushBody({ clientTag: TAG_A, force: true }) });
  const r6m = await call(releasePost, { body: { batchId: h6.body.batchId } });
  as("admin");
  const r6 = await call(releasePost, { body: { batchId: h6.body.batchId } });
  const r6b = await call(releasePost, { body: { batchId: h6.body.batchId } });
  const rel = await one(`SELECT status, fit_released_by FROM push_batches WHERE id = $1`, [h6.body.batchId]);
  check("an owner or admin can release a waiting push; it is logged, and a manager can't", r6m.status === 403 && r6.status === 200 && rel.status === "pending" &&
    rel.fit_released_by === USERS.admin && r6b.status === 409 && T.audits.some((a) => a.action === "bison_push_batch_released" && a.details.includes(h6.body.batchId)));
  // A filtered push is scored over its own window only, as the gather will take it.
  const srcFilters = buildRpcFilters(normalizeFilterState(FILTERS));
  const windowed = async (cols) => {
    const id = (await one(
      `INSERT INTO push_batches (campaigns, filters, client_tag, status, max_leads, range_from, range_to)
       VALUES ($1::jsonb, $2::jsonb, $3, 'scoring', $4, $5, $6) RETURNING id`,
      [JSON.stringify(camp), JSON.stringify(srcFilters), TAG_B, cols.max ?? null, cols.from ?? null, cols.to ?? null]
    )).id;
    for (let i = 0; i < 5; i++) {
      const c = (await one(`SELECT fit_cursor FROM push_batches WHERE id = $1`, [id])).fit_cursor;
      if (c?.done) break;
      await advanceScoringBatch({ pool });
    }
    const out = (await one(`SELECT fit_cursor FROM push_batches WHERE id = $1`, [id])).fit_cursor;
    await pool.query(`DELETE FROM push_batches WHERE id = $1`, [id]);
    return out;
  };
  const allSrc = Number((await one(`SELECT count(*)::int AS n FROM leads WHERE source = $1`, [SRC])).n);
  const wMax = await windowed({ max: 1 });
  const wRange = await windowed({ from: 2, to: 3 });
  const wAll = await windowed({});
  check("a filtered push waiting for scoring reads only its own window (max_leads, or range_from to range_to)",
    wMax?.done === true && wMax.leads === 1 && wRange?.done === true && wRange.leads === 2 && wAll?.done === true && wAll.leads === allSrc && allSrc > 3,
    JSON.stringify({ wMax, wRange, wAll, allSrc }));
  // The push-time check.
  const where = (await one(`SELECT fn_client_eligibility_conditions($1) AS c`, [TAG_A])).c.join(" and ");
  await pool.query(`DELETE FROM company_fit WHERE key = $1`, [dom("pt-new")]);
  const onRows = Object.fromEntries((await all(eligibilitySql(where, true), [Object.values(PT)])).map((r) => [r.id, r.fit]));
  check("the push-time check: a scored lead passes, an unscored lead and a lead with no key are flagged", (await fitCheckOn(pool, TAG_A)) &&
    onRows[PT.scored] === null && onRows[PT.unscored] === "unscored" && onRows[PT.nokey] === "nokey", JSON.stringify(onRows));
  await pool.query(`DELETE FROM company_fit_queue WHERE key LIKE '%fttest%'`);
  const eq = await enqueueLeadCompanies(pool, [PT.unscored, PT.nokey], { priority: 1, source: "push" });
  check("their companies are queued at priority 1 (a lead with no key has none to queue)", eq.queued === 1 && eq.nokey === 1 &&
    (await one(`SELECT priority FROM company_fit_queue WHERE key = $1`, [dom("pt-new")]))?.priority === 1);
  check("the skip reasons are the design's", FIT_SKIP.unscored === "company not scored yet" && FIT_SKIP.nokey === "no company key to score");
  await gateOff();
  check("with the gate off for the client, the per-tag statement is exactly today's", !(await fitCheckOn(pool, TAG_A)) &&
    eligibilitySql(where, false) === `select l.id from leads l where l.id = any($1::uuid[]) and ${where}`);
  const pw = source("scripts/push-worker.mjs");
  check("the push-worker runs the check only through fitCheckOn, and skips with the two reasons", pw.includes("eligibilitySql(where, fitCheck)") &&
    pw.includes("FIT_SKIP.nokey") && pw.includes("FIT_SKIP.unscored") && pw.includes("await fitCheckOn(pool, tag)"));
  // The re-push script.
  const rpLead = await addLead({ email: `rp@${dom("rp")}`, company: "Rp Fttest", domain: dom("rp"), country_code: "US", source: SRC });
  const pb0 = (await one(
    `INSERT INTO push_batches (campaigns, client_tag, status, sent, created_at)
     VALUES ($1::jsonb, $2, 'complete', 1, now() - interval '1 hour') RETURNING id`,
    [JSON.stringify([{ id: "901", instance_url: B2B, side: "b2b", name: `${TAG_A}: Main b2b` }, { id: "902", instance_url: B2C, side: "b2c", name: `${TAG_A}: Main b2c` }]), TAG_A]
  )).id;
  await pool.query(`INSERT INTO push_items (batch_id, lead_id, email, status, target_campaigns, attached_ids) VALUES ($1, $2, $3, 'sent', $4::jsonb, '{902}')`, [
    pb0, rpLead, `rp@${dom("rp")}`, JSON.stringify([{ id: "902", instance_url: B2C }]),
  ]);
  writePlan({ campaigns: { [B2B]: [{ id: 901, name: `${TAG_A}: Main b2b`, status: "active" }, { id: 701, name: `${TAG_A}: Main`, status: "active" }] } });
  const repush = () => runChild([fileURLToPath(new URL("./queue-repush.mts", import.meta.url)), `--tag=${TAG_A}`], { strip: true });
  const rp0 = repush();
  const rpBatch0 = await one(`SELECT id, status FROM push_batches WHERE client_tag = $1 AND email_side = 'b2b' ORDER BY created_at DESC LIMIT 1`, [TAG_A]);
  await pool.query(`DELETE FROM push_batches WHERE id = $1`, [rpBatch0?.id ?? null]);
  await gateOn([TAG_A]);
  const rp1 = repush();
  const rpBatch1 = await one(`SELECT id, status FROM push_batches WHERE client_tag = $1 AND email_side = 'b2b' ORDER BY created_at DESC LIMIT 1`, [TAG_A]);
  await gateOff();
  check("the re-push script: 'pending' with the gate off, 'scoring' for a gated client", rp0.status === 0 && rpBatch0?.status === "pending" && rp1.status === 0 &&
    rpBatch1?.status === "scoring" && /waits for fit scoring/.test(rp1.out), (rp0.out + rp1.out).slice(-600));
  await pool.query(`DELETE FROM push_batches WHERE id = $1`, [rpBatch1?.id ?? null]);

  // ── I. The scoring run and the review list ────────────────────────────────
  section("I. Scoring every company in the Email Bison copy, and the review list");
  const { GET: runGet, POST: runPost } = await route("fit/scoring-run");
  const { POST: buildPost } = await route("fit/review/build");
  const { GET: reviewGet } = await route("fit/review");
  const { POST: decidePost } = await route("fit/review/decide");
  const { POST: queuePost } = await route("fit/review/queue");
  await pool.query(`DELETE FROM company_fit_queue WHERE key LIKE '%fttest%'`);
  // The copy: members of several clients' campaigns, the same company on both installs.
  const member = async (inst, id, email, campaigns, extra = {}) => {
    await pool.query(
      `INSERT INTO bison_leads (instance_url, bison_id, email, company, cv_domain, campaigns, campaign_ids, replies, synced_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::bigint[], $8, now() - interval '40 days')`,
      [inst, id, email, extra.company ?? null, extra.domain ?? null, JSON.stringify(campaigns), campaigns.map((c) => Number(c.campaign_id)), extra.replies ?? 0]
    );
  };
  const cm = (id, o = {}) => ({ campaign_id: id, status: "active", replies: 0, interested: false, emails_sent: 2, ...o });
  // Review fixtures on B2B: blocked company X (score 1), Y fine (4), Z blocked now, fine by queue time.
  await score("domain", dom("rx"), 1);
  await score("domain", dom("ry"), 4);
  await score("domain", dom("rz"), 1);
  await member(B2B, 1001, `m1@${dom("rx")}`, [cm(901)]);
  await member(B2B, 1002, `m2@${dom("rx")}`, [cm(901, { replies: 1, status: "replied" })]);
  await member(B2B, 1003, `m3@${dom("rx")}`, [cm(903, { interested: true })]);
  await member(B2B, 1004, `m4@${dom("rx")}`, [cm(901), cm(904)]);
  await member(B2B, 1005, `m5@${dom("ry")}`, [cm(901)]);
  await member(B2B, 1006, `m6@${dom("rz")}`, [cm(903)]);
  await member(B2B, 1007, `m7@${dom("rx")}`, [cm(905)]);
  // Other clients' and unmapped campaigns, for the scoring run.
  await member(B2C, 2001, `a@${dom("copy1")}`, [cm(8001)], { company: "Copyone Fttest" });
  await member(B2B, 2002, `b@${dom("copy1")}`, [cm(8002)], { company: "Copyone Fttest" });
  await member(B2C, 2003, `c@${dom("copy2")}`, [cm(8003)], { company: "Copytwo Fttest" });
  await member(B2C, 2004, `fttest-cp-${RUN}@gmail.com`, [cm(8003)], { company: "Copythree Fttest", domain: dom("copy3") });
  await member(B2C, 2005, `fttest-cn-${RUN}@gmail.com`, [], { company: "Notin Fttest" });
  net.campaigns[B2B] = [
    { id: 901, name: `${TAG_A}: Main b2b`, status: "active" },
    { id: 903, name: `${TAG_A} Second`, status: "paused" },
    { id: 904, name: `${TAG_A} Nurture`, status: "active" },
    { id: 905, name: `${TAG_A}: Old`, status: "archived" },
    { id: 906, name: "Legacy list", status: "active" },
    { id: 907, name: `${TAG_B}: Main`, status: "active" },
  ];
  net.campaigns[B2C] = [{ id: 902, name: `${TAG_A}: Main b2c`, status: "completed" }];
  await pool.query(`INSERT INTO push_batches (campaigns, client_tag, status) VALUES ($1::jsonb, $2, 'complete')`, [
    JSON.stringify([{ id: "906", instance_url: B2B, name: "Legacy list" }]), TAG_A,
  ]);
  as("manager");
  check("the scoring run is owner and admin only", (await call(runGet)).status === 403 && (await call(runPost, { body: { confirm: true } })).status === 403);
  as("admin");
  T.settingsRows = [];
  const est = await call(runGet);
  check("the estimate: companies in the copy and the pipeline's, calls, dollars and days at the fit cap", est.status === 200 && est.body.estimate.exact === true &&
    est.body.estimate.companies >= 6 && est.body.estimate.calls === Math.ceil(est.body.estimate.companies / 25) && typeof est.body.estimate.usd === "number" &&
    est.body.estimate.cap === 25 && est.body.idle_reason === "Scoring is off", JSON.stringify(est.body.estimate));
  check("the estimate's arithmetic", (() => {
    const e = estimateUsd({ companies: 4_360_000, batchSize: 25, promptChars: 4000, price: { in: 0.1, out: 0.5 } });
    return e.calls === 174_400 && e.usd > 100 && e.usd < 600;
  })());
  check("a run needs a confirmation", (await call(runPost, { body: {} })).status === 400);
  const rOff = await call(runPost, { body: { confirm: true } });
  T.settingsRows = [{ key: "fit_scoring", value: SCORING_ON().fit_scoring }, { key: "fit_rule", value: WITH_RULE().fit_rule }];
  T.worker = heartbeat({ fit: false });
  const rOld = await call(runPost, { body: { confirm: true } });
  T.worker = heartbeat();
  const rRun = await call(runPost, { body: { confirm: true } });
  const rTwice = await call(runPost, { body: { confirm: true } });
  check("refused while scoring is off, and while the worker can't score; started once confirmed; one at a time",
    rOff.status === 409 && /Scoring is off/.test(rOff.body.error) && rOld.status === 409 && /Deploy the latest worker/.test(rOld.body.error) && rRun.status === 201 &&
      rTwice.status === 409, JSON.stringify([rOff.body, rOld.body, rRun.body, rTwice.body]));
  const runId = rRun.body.run.id;
  for (let i = 0; i < 20; i++) {
    await pool.query(`UPDATE fit_backfill_runs SET progress = progress - 'next_at' WHERE id = $1`, [runId]);
    const s = await advanceBackfill({ pool, settings: await settingsWith({ ...SCORING_ON(), ...WITH_RULE() }) });
    const r = await one(`SELECT status FROM fit_backfill_runs WHERE id = $1`, [runId]);
    if (!s || r.status === "scoring") break;
  }
  const runRow = await one(`SELECT * FROM fit_backfill_runs WHERE id = $1`, [runId]);
  const q3 = await all(`SELECT key_kind, key, priority, source FROM company_fit_queue WHERE key LIKE '%fttest%' ORDER BY key`);
  check("every company in the copy is queued once at priority 3, whatever its client; scored ones are left out",
    runRow.status === "scoring" && q3.some((r) => r.key === dom("copy1")) && q3.filter((r) => r.key === dom("copy1")).length === 1 && q3.some((r) => r.key === dom("copy2")) &&
      q3.some((r) => r.key === dom("copy3")) && !q3.some((r) => r.key === dom("rx")) && q3.every((r) => r.priority === 3) && !q3.some((r) => /notin/.test(r.key)),
    JSON.stringify({ status: runRow.status, q3 }));
  await pool.query(`DELETE FROM company_fit_queue WHERE key LIKE '%fttest%'`);
  await pool.query(`UPDATE fit_backfill_runs SET progress = progress - 'next_at' WHERE id = $1`, [runId]);
  await advanceBackfill({ pool, settings: await settingsWith({ ...SCORING_ON(), ...WITH_RULE() }) });
  check("the run is done once its queue has drained", (await one(`SELECT status FROM fit_backfill_runs WHERE id = $1`, [runId])).status === "done");
  // The review list.
  const live = await liveCampaignsFor(TAG_A, process.env, globalThis.fetch);
  const rc = await reviewCampaignsFor(pool, TAG_A, live);
  const camps = Object.fromEntries(rc.campaigns.map((c) => [`${c.instance_url}#${c.campaign_id}`, c]));
  check("review campaigns: push history and live names, only those that can still send, never Nurture",
    camps[`${B2B}#901`]?.from === "push_history" && camps[`${B2B}#906`]?.from === "push_history" && camps[`${B2B}#903`]?.from === "live_name" &&
      !camps[`${B2B}#904`] && !camps[`${B2B}#905`] && !camps[`${B2C}#902`] && !camps[`${B2B}#907`] && same(live.nurture[B2B], ["904"]) && rc.campaigns.length === 3,
    JSON.stringify(rc));
  as("viewer");
  check("building a review is manager and up", (await call(buildPost, { body: { tag: TAG_A } })).status === 403);
  as("manager");
  T.settingsRows = [];
  const bOff = await call(buildPost, { body: { tag: TAG_A } });
  T.settingsRows = [{ key: "fit_scoring", value: SCORING_ON().fit_scoring }];
  const bGo = await call(buildPost, { body: { tag: TAG_A } });
  const bTwice = await call(buildPost, { body: { tag: TAG_A } });
  check("the build is refused while scoring is off, started otherwise, one at a time", bOff.status === 409 && bGo.status === 201 && bGo.body.campaigns === 3 && bTwice.status === 409,
    JSON.stringify([bOff.body, bGo.body, bTwice.body]));
  const built2 = await buildReview(pool, bGo.body.run.id, { pageSize: 2 });
  const items = await all(`SELECT * FROM fit_review_items WHERE client_tag = $1 ORDER BY campaign_id, key`, [TAG_A]);
  const rleads = await all(`SELECT l.* FROM fit_review_leads l JOIN fit_review_items i ON i.id = l.item_id WHERE i.client_tag = $1 ORDER BY bison_lead_id`, [TAG_A]);
  const byLead = Object.fromEntries(rleads.map((l) => [Number(l.bison_lead_id), l]));
  check("items for blocked companies only, one per campaign and company, rows chosen by install and campaign ids (in pages)",
    built2.items === 3 && items.every((i) => [dom("rx"), dom("rz")].includes(i.key)) && items.some((i) => i.campaign_id === "901" && i.key === dom("rx")) &&
      items.some((i) => i.campaign_id === "903" && i.key === dom("rx")) && items.some((i) => i.campaign_id === "903" && i.key === dom("rz")) && !byLead[1005] && !byLead[1007],
    JSON.stringify(items.map((i) => [i.campaign_id, i.key, i.leads])));
  const i901 = items.find((i) => i.campaign_id === "901");
  check("each item's counts: leads, sent, replied, interested, removable, the oldest sync date; nurture leads flagged",
    i901.leads === 3 && i901.replied === 1 && i901.removable === 1 && i901.emails_sent === 6 && i901.oldest_sync !== null && byLead[1004].in_nurture === true &&
      byLead[1002].replied === true && byLead[1003].interested === true && i901.campaign_from === "push_history" && i901.score === 1, JSON.stringify(i901));
  as("manager");
  const page1 = await call(reviewGet, { query: { tag: TAG_A } });
  check("the review list's page: items, totals, campaigns, the gate's cover, the build", page1.status === 200 && page1.body.items.length === 3 &&
    page1.body.summary.pending === 3 && page1.body.gate_covers === false && page1.body.build?.status === "done" && page1.body.campaigns.length === 2, JSON.stringify(page1.body.summary));
  const d1 = await call(decidePost, { body: { tag: TAG_A, bulk: "under_2_no_replies", decision: "approved" } });
  const d2 = await call(decidePost, { body: { tag: TAG_A, ids: [Number(i901.id)], decision: "approved" } });
  const d3 = await call(decidePost, { body: { tag: TAG_A, ids: [Number(i901.id)], decision: "approved" } });
  const decided = await all(`SELECT id, key, campaign_id, decision, decided_by FROM fit_review_items WHERE client_tag = $1`, [TAG_A]);
  const approvedKeys = decided.filter((x) => x.decision === "approved").map((x) => `${x.campaign_id}|${x.key}`).sort();
  check("approve in bulk (all under 2 with no replies or interest) and per item, recorded by name", d1.status === 200 && d1.body.changed === 1 &&
    d2.body.changed === 1 && d3.body.changed === 0 && same(approvedKeys, [`901|${dom("rx")}`, `903|${dom("rz")}`]) &&
    decided.every((x) => x.decision !== "approved" || x.decided_by === USERS.manager), JSON.stringify({ d1: d1.body, d2: d2.body, decided }));
  // Queue: refused while the gate does not cover the client.
  const approvedIds = decided.filter((x) => x.decision === "approved").map((x) => Number(x.id));
  check("queueing removals is owner and admin only", (await call(queuePost, { body: { tag: TAG_A, ids: approvedIds } })).status === 403);
  as("admin");
  const qOff = await call(queuePost, { body: { tag: TAG_A, ids: approvedIds } });
  check("queueing is refused while the gate does not cover the client", qOff.status === 409 && /does not cover/.test(qOff.body.error));
  await gateOn([TAG_A]);
  await score("domain", dom("rz"), 3); // no longer blocked by queue time
  const qOn = await call(queuePost, { body: { tag: TAG_A, ids: approvedIds } });
  const held = await all(`SELECT bison_lead_id, status, reason FROM bison_campaign_removals WHERE client_tag = $1 ORDER BY bison_lead_id`, [TAG_A]);
  check("queued as 'fit_held': never a replier, an interested lead, a nurture lead, or a company no longer blocked", qOn.status === 200 &&
    same(held.map((h) => Number(h.bison_lead_id)), [1001]) && held.every((h) => h.status === "fit_held" && h.reason === "fit") &&
    /--dry-run/.test(qOn.body.next.dry_run), JSON.stringify({ body: qOn.body, held }));

  // ── J. Removal, only by a person ──────────────────────────────────────────
  section("J. Removal: dry run, confirmed run, the live check failing closed");
  const lcd = (o = {}) => ({ data: { id: 1, overall_stats: { replies: 0 }, lead_campaign_data: [{ campaign_id: 901, replies: 0, interested: false }], ...o } });
  check("the live check removes only when every campaign shows no reply and no interest, this campaign among them",
    liveCheck(lcd(), 901).remove === true && liveCheck(lcd(), "901").remove === true);
  check("missing lead_campaign_data, a missing count or flag, a missing own count, another campaign: cannot confirm",
    [liveCheck({ data: { overall_stats: { replies: 0 } } }, 901), liveCheck(lcd({ lead_campaign_data: null }), 901),
      liveCheck(lcd({ lead_campaign_data: [{ campaign_id: 901, interested: false }] }), 901), liveCheck(lcd({ overall_stats: {} }), 901),
      liveCheck(lcd(), 999), liveCheck(null, 901), liveCheck([], 901)].every((v) => !v.remove && !v.confirmed && v.why.startsWith(CANNOT_CONFIRM)));
  check("a reply or interest anywhere: skipped", (() => {
    const a = liveCheck(lcd({ lead_campaign_data: [{ campaign_id: 901, replies: 0, interested: false }, { campaign_id: 77, replies: 2, interested: false }] }), 901);
    const b = liveCheck(lcd({ lead_campaign_data: [{ campaign_id: 901, replies: 0, interested: true }] }), 901);
    const c = liveCheck(lcd({ overall_stats: { replies: 1 } }), 901);
    return !a.remove && a.why === "replied" && !b.remove && b.why === "interested" && !c.remove && c.confirmed;
  })());
  // More held rows: a replier (live) and one Bison can't show.
  const addHeld = async (lead, email) => (await one(
    `INSERT INTO bison_campaign_removals (client_tag, instance_url, campaign_id, bison_lead_id, email, reason, status)
     VALUES ($1, $2, '901', $3, $4, 'fit', 'fit_held') RETURNING id`, [TAG_A, B2B, lead, email])).id;
  await addHeld(1101, `r1@${dom("rx")}`);
  await addHeld(1102, `r2@${dom("rx")}`);
  const misroute = (await one(
    `INSERT INTO bison_campaign_removals (client_tag, instance_url, campaign_id, bison_lead_id, email, reason, status)
     VALUES ($1, $2, '950', 1200, $3, 'misroute', 'pending') RETURNING id`, [TAG_A, B2B, `mr@${dom("rx")}`])).id;
  const blocked = await pool.query(`UPDATE bison_campaign_removals SET status = 'pending' WHERE client_tag = $1 AND reason = 'fit'`, [TAG_A]).then(() => false, () => true);
  check("a fit row can never be 'pending' (a CHECK forbids it)", blocked);
  const plan = {
    leads: { [B2B]: {
      1001: lcd({ id: 1001 }),
      1101: lcd({ id: 1101, lead_campaign_data: [{ campaign_id: 901, replies: 3, interested: false }] }),
      1102: { data: { id: 1102, overall_stats: { replies: 0 } } },
    } },
  };
  writePlan(plan);
  rmSync(LOG_FILE, { force: true });
  const worker = (args) => runChild([fileURLToPath(new URL("./bison-campaign-removal-worker.mjs", import.meta.url)), "--pace=0", "--watchdog=0", ...args]);
  const w0 = worker([]);
  check("the removal worker without --reason exits 1", w0.status === 1 && /--reason is required/.test(w0.out), w0.out.slice(-300));
  const fitBefore = await all(`SELECT id, status, attempts FROM bison_campaign_removals WHERE client_tag = $1 AND reason = 'fit' ORDER BY id`, [TAG_A]);
  const wm = worker(["--reason=misroute", `--tag=${TAG_A}`]);
  const fitAfterMisroute = await all(`SELECT id, status, attempts FROM bison_campaign_removals WHERE client_tag = $1 AND reason = 'fit' ORDER BY id`, [TAG_A]);
  check("a misroute run (the local connection, no TLS) works its own row and never touches fit_held rows", wm.status === 0 && same(fitBefore, fitAfterMisroute) &&
    (await one(`SELECT status FROM bison_campaign_removals WHERE id = $1`, [misroute])).status === "done" &&
    readLog().every((l) => !(l.method === "GET" && /\/api\/leads\//.test(l.path))), wm.out.slice(-400));
  rmSync(LOG_FILE, { force: true });
  const wNoConfirm = worker(["--reason=fit", `--tag=${TAG_A}`]);
  check("a real fit run without --confirm is refused", wNoConfirm.status === 1 && /dry run|naming one/.test(wNoConfirm.out));
  const wDry = worker(["--reason=fit", `--tag=${TAG_A}`, "--lanes=3", "--dry-run"]);
  const dryId = /dry run id: ([0-9a-f-]{36})/.exec(wDry.out)?.[1];
  const dry = dryId ? await one(`SELECT * FROM fit_removal_dry_runs WHERE id = $1`, [dryId]) : null;
  const afterDry = await all(`SELECT id, status FROM bison_campaign_removals WHERE client_tag = $1 AND reason = 'fit' ORDER BY id`, [TAG_A]);
  check("a dry run reads each lead live, writes a record (would remove 1, skip 1, cannot confirm 1) and marks nothing",
    wDry.status === 0 && dry && dry.would_remove === 1 && dry.would_skip === 1 && dry.cannot_confirm === 1 && dry.row_ids.length === 3 && !dry.used_at &&
      afterDry.every((r) => r.status === "fit_held") && readLog().filter((l) => l.method === "GET").length === 3 && !readLog().some((l) => l.method === "DELETE") &&
      /one lane/.test(wDry.out), wDry.out.slice(-500));
  // Stale, used and mismatched dry runs are refused; a good one is used once.
  const oldId = await recordDryRun(pool, { tag: TAG_A, rows: await heldRows(pool, { tag: TAG_A }), counts: { remove: 0, skip: 0, cannot: 0 } });
  await pool.query(`UPDATE fit_removal_dry_runs SET created_at = now() - interval '25 hours' WHERE id = $1`, [oldId]);
  const wStale = worker(["--reason=fit", `--tag=${TAG_A}`, `--confirm=${oldId}`]);
  const wOther = worker(["--reason=fit", `--tag=${TAG_B}`, `--confirm=${dryId}`]);
  const wInst = worker(["--reason=fit", `--tag=${TAG_A}`, `--instance=${B2B}`, `--confirm=${dryId}`]);
  const extra = await addHeld(1103, `r3@${dom("rx")}`);
  const wChanged = worker(["--reason=fit", `--tag=${TAG_A}`, `--confirm=${dryId}`]);
  await pool.query(`DELETE FROM bison_campaign_removals WHERE id = $1`, [extra]);
  check("a stale dry run, another client's, another install's, or one whose rows changed is refused", wStale.status === 1 && /24 hours/.test(wStale.out) &&
    wOther.status === 1 && wInst.status === 1 && wChanged.status === 1 && /changed since/.test(wChanged.out), [wStale.out, wOther.out, wInst.out, wChanged.out].map((o) => o.slice(-160)).join(" | "));
  rmSync(LOG_FILE, { force: true });
  const wReal = worker(["--reason=fit", `--tag=${TAG_A}`, `--confirm=${dryId}`]);
  const finalRows = Object.fromEntries((await all(`SELECT bison_lead_id, status, last_error, dry_run_id FROM bison_campaign_removals WHERE client_tag = $1 AND reason = 'fit'`, [TAG_A])).map((r) => [Number(r.bison_lead_id), r]));
  const log = readLog();
  check("the confirmed run reads each lead live again, removes only the all-zero lead, skips the replier and the one it can't confirm",
    wReal.status === 0 && finalRows[1001].status === "done" && finalRows[1101].status === "skipped" && finalRows[1101].last_error === "replied" &&
      finalRows[1102].status === "skipped" && finalRows[1102].last_error.startsWith(CANNOT_CONFIRM) && finalRows[1001].dry_run_id === dryId &&
      log.filter((l) => l.method === "GET").length === 3 && log.filter((l) => l.method === "DELETE").length === 1 &&
      same(JSON.parse(log.find((l) => l.method === "DELETE").body), { lead_ids: [1001] }), wReal.out.slice(-500));
  const wUsed = worker(["--reason=fit", `--tag=${TAG_A}`, `--confirm=${dryId}`]);
  check("a dry run is used once", wUsed.status === 1 && /used already/.test(wUsed.out));
  const cc = await pool.connect();
  const notId = await confirmDryRun(cc, { id: "not-an-id", tag: TAG_A });
  cc.release();
  check("rowsSha is order-free, and confirmDryRun refuses a non-id", rowsSha([3, 1, 2]) === rowsSha([1, 2, 3]) && !notId.ok);
  check("finishRows writes only rows still held", (await finishRows(pool, [{ id: Number(misroute), status: "done" }])) === 0);
  await gateOff();

  // ── D. Personalisation, the tool stand-ins ────────────────────────────────
  section("D. Personalisation (switched off) and the tool stand-ins");
  const P = (v) => settingsFrom([{ key: "personalisation", value: v }]);
  check("personalisation is off by default", !(await settingsWith()).flagOn("personalisation", TAG_A, { variant: "default" }));
  check("on for a client with no own variant and shared_text_ok false: still off; its own variant or shared_text_ok turns it on",
    !P({ enabled: true, tags: [TAG_A], shared_text_ok: false }).flagOn("personalisation", TAG_A, { variant: "default" }) &&
      !P({ enabled: true, tags: [TAG_A], shared_text_ok: false }).flagOn("personalisation", TAG_A) &&
      P({ enabled: true, tags: [TAG_A], shared_text_ok: false }).flagOn("personalisation", TAG_A, { variant: "fttest_a" }) &&
      P({ enabled: true, tags: [TAG_A], shared_text_ok: true }).flagOn("personalisation", TAG_A, { variant: "default" }) &&
      !P({ enabled: true, tags: [TAG_B], shared_text_ok: true }).flagOn("personalisation", TAG_A, { variant: "default" }));
  check("has_question is written from the question cell", contactSummary("general", { question: "Made-up?" }, {}).has_question === true &&
    contactSummary("general", { question: "" }, {}).has_question === false);
  // The compiled columns, from the made-up exports (scripts/fixtures/clay-originals): P#58, P#61 and G#49 as the templates build them.
  const fx = compileTemplates(originalsMap(originalRows(fixtureSeedExports())), { settings: null });
  const p58 = fx.people.find((c) => c.key === "email_provider_check_api");
  const p61 = fx.people.find((c) => c.key === "question_ai");
  const g49 = fx.inboxes.find((c) => c.key === "question_ai");
  const dnsBefore = net.dns.length;
  const refusedBefore = net.refused;
  // dns_mx sends the compiled column's own URL (P#58: "https://dns.google.com/resolve?type=MX&name=" + the email domain).
  const mx = await PIPELINE_ACTIONS.dns_mx.run({ inputs: { url: `https://dns.google.com/resolve?type=MX&name=${dom("acme")}` }, config: {}, db: pool, env: {} });
  const elsewhere = await PIPELINE_ACTIONS.dns_mx.run({ inputs: { url: `https://dns.${HOST}/resolve?type=MX&name=${dom("acme")}` }, config: {}, db: pool, env: {} });
  check("P#58 calls only Google's public DNS", p58?.action === "dns_mx" && /^"https:\/\/dns\.google\.com\//.test(p58?.inputs?.url ?? "") &&
    (p58?.config?.flag ?? []).includes("personalisation") && mx.status === "done" && elsewhere.status === "error" &&
    net.dns.length === dnsBefore + 1 && net.dns.every((h) => h === "dns.google.com") && net.refused === refusedBefore,
    JSON.stringify({ action: p58?.action, mx: mx.status, elsewhere: elsewhere.status, dns: net.dns.slice(dnsBefore), refused: net.refused - refusedBefore }));
  const openaiBefore = net.openai.length;
  // Two made-up answers (this stub answers fit batches only), taken back if not used; no database: no spend counted.
  const asked = [];
  const failBefore = net.fail.length;
  for (const c of [p61, g49]) {
    net.fail.push({ status: 200, body: { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ response: "Made-up question?" }) }] }], usage: { input_tokens: 10, output_tokens: 5 } } });
    asked.push(await ACTIONS.ai_web.run({ inputs: { prompt: "[made-up] one question" }, config: c?.config ?? {}, env: FAKE_OPENAI, settings: settingsFrom([]), db: null, row: { id: 0 }, column: c }));
  }
  net.fail.splice(failBefore);
  const sentAi = net.openai.slice(openaiBefore);
  check("P#61 and G#49 send their table examples as instructions: two requests, each with the examples' text as its instructions and the prompt as its input",
    [p61, g49].every((c) => c?.action === "ai_web" && typeof c.config?.table_examples === "string" && c.config.examples_count === 1 && typeof c.config.examples_text === "string" && (c.config?.flag ?? []).includes("personalisation")) &&
      sentAi.length === 2 && sentAi.every((b, i) => b.instructions === [p61, g49][i].config.examples_text && b.input === "[made-up] one question") &&
      asked.every((r) => r.status === "done" && r.value?.response === "Made-up question?" && r.run?.request?.examples === 1),
    JSON.stringify(asked.map((r) => [r.status, r.note])));
  check("the stand-ins: a tidy company name in title case, a North American number, and nothing else",
    normalizeCompanyName({ companyName: "  acme FTTEST cleaning, ", titleCase: true }) === "Acme Fttest Cleaning" &&
      normalizeCompanyName({ companyName: "acme 24/7 & sons", titleCase: true }) === "Acme 24/7 & Sons" &&
      normalizeCompanyName({ companyName: "the HQ of acme", titleCase: true }) === "The HQ of Acme" &&
      normalizePhoneNumber({ phoneNumber: "+1 (312) 555-0100" })?.national === "(312) 555-0100" && normalizePhoneNumber({ phoneNumber: "12345" }) === null);
  const standinRun = await TOOL_STANDIN_ACTIONS.normalize_company_name.run({ inputs: { companyName: "acme fttest", titleCase: true } });
  check("a stand-in's value says it is one", standinRun.value.stand_in === true && standinRun.value.normalized_name === "Acme Fttest" && /stand-in/.test(standinRun.note));
  const templates = ["company-template-v2.mjs", "inbox-template.mjs", "people-template.mjs"].map((f) => source(`scripts/lib/enrich/${f}`)).join("\n");
  check("shipped off: no template column uses a stand-in", !/action:\s*"normalize_(company_name|phone_number)"/.test(templates));

  // ── Wiring: the worker, the middleware ────────────────────────────────────
  section("Wiring: the worker's fit loop and the middleware");
  const ew = source("scripts/enrich-worker.mjs");
  check("the enrich-worker offers fit_scoring and runs the fit loop beside the AI Ark loop, in the design's order",
    ew.includes(`CAPABILITIES.push("fit_scoring")`) && /advanceScoringBatch[\s\S]*fitLoopOnce[\s\S]*refreshBlockedOnce[\s\S]*advanceBackfill/.test(ew.slice(ew.indexOf("async function fitTick"))) &&
      /const fits = fitLoop\(\);/.test(ew) && /await runs;[\s\S]*await fits;[\s\S]*await pool\.end\(\)/.test(ew));
  check("its promotion trigger asks the web app, at most one round per client every 10 minutes", /PROMOTE_EVERY_MS = 10 \* 60_000/.test(ew) &&
    /promoteDue\(pool, settings\)/.test(ew) && /requestPromote\(promoteAuto, tag\)/.test(ew));
  check("the worker's promotion route is outside the session middleware, as the AI Ark auto-add is", /api\/aiark\/add\/auto\|api\/companies\/promote\/auto\|/.test(source("src/middleware.ts")));

  // ── The fit routes: roles, the settings, manual scores, the panel ─────────
  section("Routes: roles, the scoring settings, manual scores, the panel");
  const { GET: stateGet } = await route("fit/state");
  const { GET: setGet, PUT: setPut } = await route("fit/settings");
  const { POST: scorePost } = await route("fit/score");
  T.settingsRows = [];
  as("viewer");
  check("the fit panel is manager and up", (await call(stateGet, { query: { tag: TAG_A } })).status === 403 && (await call(reviewGet, { query: { tag: TAG_A } })).status === 403);
  as("manager");
  const stateM = await call(stateGet, { query: { tag: TAG_A } });
  check("the panel: no rule (never its text), scoring off and why, the model, the queue, the gate not covering, today's fit spend",
    stateM.status === 200 && stateM.body.rule.set === false && !("prompt" in stateM.body.rule) && stateM.body.idle_reason === "Scoring is off" &&
      stateM.body.model?.model === "gpt-6-luna" && stateM.body.gate.covers_client === false && stateM.body.promotion.on_for_client === false &&
      typeof stateM.body.spend.used === "number" && stateM.body.spend.cap === 25 && stateM.body.worker?.fit_scoring === true && stateM.body.scores.total > 0,
    JSON.stringify(stateM.body).slice(0, 400));
  check("the scoring settings and manual scores are admin only", (await call(setGet)).status === 403 && (await call(setPut, { body: {} })).status === 403 &&
    (await call(scorePost, { body: {} })).status === 403);
  as("admin");
  const sg = await call(setGet);
  check("the settings as stored: no rule, scoring off, 25 a call, 2 at once, Luna at low effort", sg.status === 200 && sg.body.rule.prompt === null &&
    sg.body.scoring.enabled === false && sg.body.scoring.batch_size === 25 && sg.body.scoring.calls_in_flight === 2 && sg.body.model.reasoning_effort === "low");
  const bad = [
    [{ rule: { prompt: "made-up", version: null } }, /version/],
    [{ rule: { prompt: "x".repeat(20_001), version: "v" } }, /at most 20,000/],
    [{ scoring: { batch_size: 0 } }, /1 to 50/],
    [{ scoring: { calls_in_flight: 9 } }, /1 to 8/],
    [{ model: { model: "NOT A MODEL" } }, /model id/],
    [{ model: { model: "gpt-6-luna", reasoning_effort: "minimal" } }, /not accepted/],
  ];
  let allRefused = true;
  for (const [body, re] of bad) {
    const r = await call(setPut, { body });
    if (!(r.status === 400 && re.test(r.body.error))) allRefused = false;
  }
  const rulesAfter = (await one(`SELECT value FROM enrich_settings WHERE key = 'fit_rule'`)).value;
  check("bad settings are refused, and no rule was written", allRefused && rulesAfter.prompt === null);
  const { cleanFitSettings } = await srcModule("lib/companies/fit.ts");
  const cur = await settingsWith();
  const cr1 = cleanFitSettings({ rule: { prompt: "A made-up rule", version: "v1" } }, cur);
  const cr2 = cleanFitSettings({ rule: { prompt: "Another made-up rule", version: "v1" } }, await settingsWith({ fit_rule: { prompt: "A made-up rule", version: "v1" } }));
  check("a rule's version is required, and must change with its text (checked without saving)", cr1.errors.length === 0 && cr1.value.fit_rule?.version === "v1" &&
    cr2.errors.length === 1 && /must change too/.test(cr2.errors[0]));
  const sp = await call(setPut, { body: { scoring: { batch_size: 24 } } });
  const spBack = await call(setPut, { body: { scoring: { batch_size: 25 } } });
  check("a valid change is saved and logged; the switch stays off", sp.status === 200 && sp.body.settings.scoring.batch_size === 24 && spBack.body.settings.scoring.batch_size === 25 &&
    !spBack.body.settings.scoring.enabled && T.audits.some((a) => a.action === "fit_settings" && /companies a call 25 to 24/.test(a.details)));
  const ms1 = await call(scorePost, { body: { key_kind: "domain", key: `https://www.${dom("manual2").toUpperCase()}/about`, score: 1, home_office: true, reason: "set by a person" } });
  const ms2 = await call(scorePost, { body: { key_kind: "domain", key: "gmail.com", score: 3 } });
  const ms3 = await call(scorePost, { body: { key_kind: "name", key: "Manual Fttest|Springfield|il", score: 4 } });
  const ms4 = await call(scorePost, { body: { key_kind: "name", key: "x|y", score: 4 } });
  const ms5 = await call(scorePost, { body: { key_kind: "domain", key: dom("manual2"), score: 9 } });
  const man = await fitOf("domain", dom("manual2"));
  check("a manual score: its bare domain, 'manual', blocked under 2, logged; free mail, a bad name key and a bad score refused",
    ms1.status === 200 && man?.status === "manual" && man.scored_by === USERS.admin && man.blocked === true && ms2.status === 400 && ms3.status === 200 &&
      (await fitOf("name", "manual fttest|springfield|IL"))?.score === 4 && ms4.status === 400 && ms5.status === 400 &&
      T.audits.some((a) => a.action === "fit_manual_score"), JSON.stringify([ms1.body, ms2.body, ms4.body]));
  await score("domain", dom("manual2"), 5);
  check("a manual score set by a person survives the scorer's writes", (await fitOf("domain", dom("manual2"))).score === 1);
} catch (e) {
  failed++;
  exitCode = 1;
  console.log(`  FAIL the suite stopped: ${e?.stack ?? e}`);
} finally {
  try {
    await drainAfter();
  } catch {
    /* the import's own errors are its batch's */
  }
  try {
    await restoreSettings();
    await cleanup();
    rmSync(PLAN_FILE, { force: true });
    rmSync(LOG_FILE, { force: true });
  } catch (e) {
    failed++;
    console.log(`  FAIL cleanup: ${e?.message ?? e}`);
  }
}

section("After: everything made is removed, and nothing else moved");
try {
  const after = await counts();
  if (before) {
    const moved = Object.keys(before).filter((k) => before[k] !== after[k]);
    check("before and after: leads, pushes, uploads, removals, the copy, the AI Ark tab's tables, the pipeline's, the fit tables and the settings are as they were",
      moved.length === 0, moved.map((k) => `${k}: ${String(before[k]).slice(0, 80)} -> ${String(after[k]).slice(0, 80)}`).join("; "));
  }
  check("no test row is left", Number((await one(`SELECT
      (SELECT count(*) FROM leads WHERE email LIKE '%${HOST}' OR email LIKE 'fttest-%@gmail.com')
    + (SELECT count(*) FROM push_batches WHERE starts_with(client_tag, '${PREFIX}'))
    + (SELECT count(*) FROM company_fit WHERE key LIKE '%fttest%')
    + (SELECT count(*) FROM enrich_tables WHERE starts_with(client_tag, '${PREFIX}'))
    + (SELECT count(*) FROM client_tags WHERE starts_with(tag, '${PREFIX}')) AS n`)).n) === 0);
  check("the fit settings are as they were, the gate off", !(await gateEnabled(pool)) && (await one(`SELECT value FROM enrich_settings WHERE key = 'fit_rule'`)).value.prompt === null &&
    after.settings.length > 0);
  check("no request left this machine", net.refused === 0, `${net.refused} refused`);
} catch (e) {
  failed++;
  console.log(`  FAIL ${e?.message ?? e}`);
}
for (const p of T.pools) await p.end().catch(() => {});
await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed || exitCode ? 1 : 0);
