#!/usr/bin/env node
// The automatic push of promoted leads into the client's campaigns (migration
// 140): the switch (promotion.auto_push), the queue at the settle, the wait for
// places, the push through the worker's route (src/lib/companies/promote-push.ts)
// with the push route's own checks (src/lib/bison/push-batch-core.ts), the
// worker's ask (scripts/lib/enrich/promote-push.mjs), the settings sheet and the
// fit panel.
//
// LOCAL DATABASE ONLY: made-up clients APTEST_A to APTEST_D with the made-up
// Clay originals as their own variants, made-up contacts and leads under
// .aptest.example (and made-up aptest-... freemail addresses for the B2C side),
// a made-up question variable and made-up push batches; all removed at the end
// (and any left by a run that was cut off). It switches promotion and its push
// on for its own clients only, question variables on for APTEST_D, and moves
// the location run's record (cron_runs); each is put back as it was.
//
//   node --env-file=.env.local scripts/test-auto-push.mjs
//
// Migration 140 must be in the local database. Stop the enrichment worker
// first, and run it under the shared local-database lock: the promotion rounds
// run here as the worker asks for them, and the location run's record is the
// one the share step reads.
//
// Nothing reaches a network: the Email Bison installs are two made-up hosts
// (*.aptest.example) with made-up keys, whose campaign search a stand-in fetch
// answers; any other address is refused and counted, DNS is refused, and the
// import's mail provider lookup is a stand-in. No paid key is read. The routes
// run for real through a small loader that compiles their TypeScript, with
// stand-ins only for the session, the audit log helper, the worker's
// heartbeat, Next's after() (its callbacks run when the test says), the shared
// pg pool and the mail provider lookup. The Bearer key check is the real one.
//
//   S. the switch: its default, flagOn, the settings sheet
//   O. switched off: a round queues nothing, the push refuses, nothing later
//   A. switched on: the queue at the settle, the wait for places (a round's
//      batches together, the wait limit), one forced batch with the popup's
//      campaigns for exactly the new leads, the cells and the audit, a second
//      ask, a second round, a round still importing, the worker's gather
//   B. no campaign named for the client: every lead held with the reason
//   C. B2B campaigns only: the B2C lead held, the B2B one pushed
//   D. the client's question variable: held
//   E. errors: no Bison keys, a campaign search error, the route's key and body
//   W. the worker: the ask, its address, the log line, the wiring
//   P. the fit panel
//   N. nothing reached the network, everything removed

import pg from "pg";
import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { checker, dropPaidKeys, inTx, localDatabaseUrl, seedFixtureVariant } from "./fixtures/test-support.mjs";
import { ensurePipelineTables, lockPipelineTables, variantName } from "./lib/enrich/templates.mjs";
import { FLAGS, flagOn, SETTINGS_DEFAULTS, settingsFrom } from "./lib/enrich/settings.mjs";
import { finishPromote, notePush, PUSH_NOTE, QUEUED_SENTENCE } from "./lib/enrich/promote.mjs";
import {
  PROMOTE_PUSH_PATH, PROMOTE_PUSH_SOURCE, PROMOTION_PUSH_CAPABILITY, promotePushConfig, PUSH_ASK_EVERY_MS, PUSH_COLUMNS, PUSH_WAIT_MINUTES,
  pushColumnsReady, pushDue, pushLogLine, pushWaiting, readyRows, requestPromotePush, waitingWhy,
} from "./lib/enrich/promote-push.mjs";
import { CRON_LOCATION_BACKFILL, isSharePush } from "./lib/overlap-topup.mjs";
import { BISON_GROUPS } from "./lib/bison-groups.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
for (const k of ["EMAILBISON_API_KEY", "EMAILBISON_BASE_URL", "EMAILBISON_KEYS", "PUSH_INSTANCE", "PUSH_SPAN_ONLY"]) delete process.env[k];
const counts = checker();
const { check, section } = counts;
for (const name of ["resolveMx", "resolve", "resolve4", "resolve6", "resolveAny", "lookup"]) {
  dns.promises[name] = async () => {
    throw Object.assign(new Error("DNS refused: this test allows no network"), { code: "ECONNREFUSED" });
  };
}

const PREFIX = "APTEST_";
const A = `${PREFIX}A`; // campaigns on both installs: the happy path
const B = `${PREFIX}B`; // no campaign named for it (one named for APTEST_BX)
const C = `${PREFIX}C`; // campaigns on the B2B install only
const D = `${PREFIX}D`; // sends a question variable on its pushes
const TAGS = [A, B, C, D];
const VARIANTS = TAGS.map(variantName);
const RUN = randomUUID().slice(0, 6);
const HOST = "aptest.example";
const B2B = `b2b.${HOST}`; // made-up installs: no real Bison host is ever named here
const B2C = `b2c.${HOST}`;
const INSTALL_KEYS = { [B2B]: "aptest-made-up-key-b2b", [B2C]: "aptest-made-up-key-b2c" };
const AUTO_KEY = "aptest-made-up-auto-add-key-0123456789abcdef"; // 44 characters
const dom = (slug) => `${slug}-${RUN}.${HOST}`;
const biz = (who, slug = "acme") => `${who}-${RUN}@${dom(slug)}`;
const free = (who) => `aptest-${who}-${RUN}@gmail.com`;
const VAR_NAME = `aptest-d question ${RUN}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs) => [...xs].sort();

// ── No network: a made-up Bison campaign search ─────────────────────────────

const net = { refused: 0, searches: [], plan: {}, fail: {} };
const camp = (id, name, status = "active") => ({ id, name, status, created_at: "2026-11-01T00:00:00Z", total_leads: 10 });
net.plan[B2B] = [
  camp(901, `${A}: Outlook`), camp(902, `${A}: Google + Custom`), camp(903, `${C}: Main`), camp(904, `${PREFIX}BX: Main`),
  camp(905, `${D}: Google + Custom`), camp(906, `${A}: Old Outlook [Nurture]`),
];
net.plan[B2C] = [camp(911, `${A}: Google + Custom`), camp(915, `${D}: Google + Custom`), camp(916, `${A}: Archived one`, "archived")];
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if ([B2B, B2C].includes(u.hostname) && u.pathname === "/api/campaigns") {
    net.searches.push({ host: u.hostname, term: u.searchParams.get("search"), auth: init.headers?.Authorization ?? null });
    const status = net.fail[u.hostname];
    if (status) return new Response(JSON.stringify({ error: "made-up failure" }), { status });
    const term = (u.searchParams.get("search") ?? "").toLowerCase();
    const rows = (net.plan[u.hostname] ?? []).filter((c) => String(c.name).toLowerCase().includes(term));
    return new Response(JSON.stringify({ data: rows, links: { next: null } }), { status: 200, headers: { "content-type": "application/json" } });
  }
  net.refused++;
  throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
};
process.env.EMAILBISON_KEYS = JSON.stringify(INSTALL_KEYS);
process.env.AIARK_AUTO_ADD_KEY = AUTO_KEY;

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ── The routes' TypeScript, compiled as it is imported ──────────────────────

const require = createRequire(import.meta.url);
const pgUrl = pathToFileURL(require.resolve("pg")).href;
const SRC = new URL("../src/", import.meta.url).href;
const authTsUrl = new URL("lib/enrich/auth.ts", SRC).href;
const pushMjsUrl = new URL("./lib/enrich/promote-push.mjs", import.meta.url).href;
const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}
export function after(fn) { globalThis.__apTest.after.push(fn); }`,
  // The session stand-in; the Bearer key check is the real one.
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
export { intakeKeyStatus } from "${authTsUrl}";
export async function requireRole(min) {
  const t = globalThis.__apTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}`,
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => ({ data: { user: null } }) } };
}`,
  "@/lib/supabase/admin": `export function createAdminClient() { throw new Error("the auto push test has no admin client"); }`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__apTest.audits.push(entry); }`,
  // The settings route's import of the push module: the real one, with its catalog check able to say "not applied".
  "../../../../../scripts/lib/enrich/promote-push.mjs": `export * from "${pushMjsUrl}";
import { pushColumnsReady as real } from "${pushMjsUrl}";
export async function pushColumnsReady(db) { return globalThis.__apTest.columnsMissing ? false : real(db); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__apTest.worker; }`,
  "@/lib/db/pool": `import pg from "${pgUrl}";
let p = null;
export function getPool() {
  if (!p) { p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }); globalThis.__apTest.pools.push(p); }
  return p;
}`,
  // The import's mail provider lookup (src/lib/uploads/esp-lookup.ts): never asking DNS; a "mimecast" domain is Mimecast.
  "./esp-lookup": `export function domainOfEmail(email) {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.includes(".") ? d : null;
}
export async function lookupEspForDomains(domains) {
  const out = new Map();
  for (const d of domains) out.set(d, d.includes("mimecast") ? "Mimecast" : "Google");
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
const T = (globalThis.__apTest = { role: null, userId: randomUUID(), audits: [], worker: null, after: [], pools: [] });
const srcModule = (p) => import(new URL(p, SRC).href);
const route = (p) => srcModule(`app/api/${p}/route.ts`);
async function call(handler, { body, query, headers } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const req = { json: async () => body, nextUrl: new URL(`http://auto-push.test/api${qs}`), headers: new Headers(headers ?? {}) };
  const res = await handler(req);
  return { status: res.status, body: res.body, headers: res.headers };
}
/** Runs the after() callbacks the routes left, in order, as Next does once the answer is sent. */
async function drainAfter() {
  while (T.after.length) await T.after.shift()();
}
const bearer = (k = AUTO_KEY) => ({ authorization: `Bearer ${k}` });

// ── Settings and the location run's record ──────────────────────────────────

const SWITCHES = ["promotion", "question_variables"];
let switchesBefore = null;
let cronBefore;
async function setSwitch(key, value) {
  const base = switchesBefore?.[key]?.value ?? {};
  await pool.query(
    `INSERT INTO enrich_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify({ ...base, ...value })]
  );
}
const settingsNow = async () => settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
/** The location run's record: a run that started now and finished, or one long ago (nothing placed since). */
async function locationRun(at) {
  await pool.query(
    `INSERT INTO cron_runs (name, started_at, finished_at, finished_run_started_at, updated_at) VALUES ($1, $2, $2, $2, now())
     ON CONFLICT (name) DO UPDATE SET started_at = EXCLUDED.started_at, finished_at = EXCLUDED.finished_at,
            finished_run_started_at = EXCLUDED.finished_run_started_at, updated_at = now()`,
    [CRON_LOCATION_BACKFILL, at]
  );
}
// now() in the statement itself: a time read into JavaScript loses its microseconds, and could fall before a batch's end.
const ranNow = () => pool.query(
  `INSERT INTO cron_runs (name, started_at, finished_at, finished_run_started_at, updated_at) VALUES ($1, now(), now(), now(), now())
   ON CONFLICT (name) DO UPDATE SET started_at = now(), finished_at = now(), finished_run_started_at = now(), updated_at = now()`,
  [CRON_LOCATION_BACKFILL]
);
const ranLongAgo = () => locationRun(new Date(Date.now() - 30 * 86_400_000));

// ── The clients' rows ───────────────────────────────────────────────────────

/** A row with done cells (values as stored). */
async function addRow(tableId, key, cells = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO enrich_rows (table_id, row_key, run_status, finished_at) VALUES ($1, $2, 'done', now()) RETURNING id`,
    [tableId, key]
  );
  const id = Number(r.id);
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
     SELECT $1, kv.key, $2, 'done', kv.value, left(CASE WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}' ELSE kv.value::text END, 300)
       FROM jsonb_each($3::jsonb) AS kv`,
    [id, tableId, JSON.stringify(cells)]
  );
  return id;
}

/** A client's pipeline tables and one listed company, as the worker leaves them. */
async function setupClient(tag) {
  const tables = await inTx(pool, async (c) => {
    await lockPipelineTables(c, tag);
    return ensurePipelineTables(c, tag, { settings: await settingsNow() });
  });
  const companyRow = await addRow(tables.companies, `aiark:aptest-company-${tag}-${RUN}`, { company: "Acme Aptest LLC", use_domain: dom(tag.toLowerCase()) });
  await pool.query(
    `INSERT INTO enrich_companies (row_id, table_id, client_tag, source, company, domain, city, state, industry, passes, listed, found_at, template, outcome, never_contact, company_key)
     VALUES ($1, $2, $3, 'ai_ark', 'Acme Aptest LLC', $4, 'Springfield', 'IL', 'Commercial cleaning', true, true, now(), 'companies_v2', 'General and people emails', false, $5)`,
    [companyRow, tables.companies, tag, dom(tag.toLowerCase()), `${dom(tag.toLowerCase())}|IL|springfield`]
  );
  return { tag, tables, companyRow };
}

const common = (tag) => ({
  normalized_company_name: "Acme Aptest", company: "Acme Aptest LLC", use_city: "Springfield", use_state: "IL", use_domain: dom(tag.toLowerCase()),
  question: "Made-up question for the round?", exclusion_large_company_check: true,
});
const inboxCells = (tag, email) => ({
  general_email: email, use_first_name: "Acme Aptest Team", use_last_name: "(General Email)", ...common(tag), reoon_stamp_of_approval: true,
});
const personCells = (tag, email, first) => ({
  use_work_email: email, use_first_name: first, use_last_name: "Aptestson", full_name: `${first} Aptestson`, title: "Office Manager", seniority: "manager",
  person_country: "US", ...common(tag), email, reoon_stamp_of_approval: true,
});
/** A contact as the worker leaves it: its row and cells, and its enrich_contacts summary (approved, usable, with a question). */
async function contact(client, kind, email, first = "Pat") {
  const table = kind === "general" ? client.tables.inboxes : client.tables.people;
  const cells = kind === "general" ? inboxCells(client.tag, email) : personCells(client.tag, email, first);
  const row = await addRow(table, `w:${client.companyRow}:${email}`, { ...cells, company_row: String(client.companyRow) });
  await pool.query(
    `INSERT INTO enrich_contacts (row_id, company_row_id, table_id, client_tag, kind, email, verdict, usable, held, has_question, outcome, full_name, title)
     VALUES ($1, $2, $3, $4, $5, $6, 'approved', true, false, true, $7, $8, $9)`,
    [row, client.companyRow, table, client.tag, kind, email, kind === "general" ? "Approved" : "Approved email", cells.full_name ?? null, cells.title ?? null]
  );
  return row;
}
const stateOf = (row) => one(
  `SELECT promote_state, lead_id::text AS lead_id, batch_id::text AS batch_id, auto_push_state, auto_push_note, auto_push_batch_id::text AS auto_push_batch_id, auto_push_at
     FROM enrich_contacts WHERE row_id = $1`,
  [row]
);
const cellOf = (row) => one(`SELECT status, value, display, note FROM enrich_cells WHERE row_id = $1 AND column_key = 'add_to_database'`, [row]);
const promoteBatches = (tag) => all(
  `SELECT id::text AS id, campaigns, filters, target_market, selected_ids::text[] AS selected_ids, range_from, range_to, max_leads, client_tag, email_side,
          push_options, status, created_by, question_variable_id
     FROM push_batches WHERE client_tag = $1 AND push_options->>'source' = $2 ORDER BY created_at`,
  [tag, PROMOTE_PUSH_SOURCE]
);
const leadIdOf = async (row) => (await stateOf(row))?.lead_id ?? null;

// ── S. The switch ───────────────────────────────────────────────────────────

async function partS() {
  section("S. The switch: its default, flagOn, the settings sheet");
  check("it ships off: the default and a settings row without it read auto_push false",
    SETTINGS_DEFAULTS.promotion.auto_push === false && settingsFrom([]).promotion.auto_push === false &&
      settingsFrom([{ key: "promotion", value: { promote_to_leads: true, tags: [A] } }]).promotion.auto_push === false);
  check("a value that is not on or off reads as off", settingsFrom([{ key: "promotion", value: { auto_push: "yes" } }]).promotion.auto_push === false);
  const s = (value) => settingsFrom([{ key: "promotion", value }]);
  check("flagOn promotion_push: promotion on, the client listed and auto_push on; any one missing is off",
    FLAGS.includes("promotion_push") &&
      flagOn(s({ promote_to_leads: true, tags: [A], auto_push: true }), "promotion_push", A) &&
      flagOn(s({ promote_to_leads: true, tags: [A], auto_push: true }), "promotion_push", A.toLowerCase()) &&
      !flagOn(s({ promote_to_leads: true, tags: [A], auto_push: false }), "promotion_push", A) &&
      !flagOn(s({ promote_to_leads: true, tags: [B], auto_push: true }), "promotion_push", A) &&
      !flagOn(s({ promote_to_leads: false, tags: [A], auto_push: true }), "promotion_push", A) &&
      !flagOn({ promotion: { promote_to_leads: true, tags: [A] } }, "promotion_push", A));
  check("migration 140's four columns are what the code waits for",
    same([...PUSH_COLUMNS], ["auto_push_state", "auto_push_note", "auto_push_batch_id", "auto_push_at"]) && (await pushColumnsReady(pool)) === true &&
      (await pushColumnsReady({ query: async () => ({ rows: [{ n: 3 }] }) })) === false);

  const sheet = await route("companies/settings");
  const { settingsInputOf } = await srcModule("lib/companies/server.ts");
  T.role = "manager";
  check("the settings sheet is admin only (403)", (await call(sheet.PUT, { body: {} })).status === 403);
  T.role = "admin";
  const now = await call(sheet.GET);
  check("the sheet shows the push as shipped: off, and sends it back", now.status === 200 && now.body.value.promotion.auto_push === false &&
    settingsInputOf(now.body.value).promotion.auto_push === false, JSON.stringify(now.body?.value?.promotion));
  const edit = (body, f) => {
    const x = structuredClone(settingsInputOf(body.value));
    f(x);
    return { body: { version: body.version, ...x } };
  };
  const bad = await call(sheet.PUT, edit(now.body, (x) => { x.promotion.auto_push = "yes"; }));
  check("a push switch that is not on or off is refused (400)", bad.status === 400 && /Pushing promoted leads into campaigns must be on or off/.test(bad.body.error ?? ""),
    `${bad.status} ${bad.body?.error}`);
  const audits0 = T.audits.length;
  const row0 = await one(`SELECT value FROM enrich_settings WHERE key = 'promotion'`);
  const on = await call(sheet.PUT, edit(now.body, (x) => { x.promotion.auto_push = true; }));
  const row1 = await one(`SELECT value FROM enrich_settings WHERE key = 'promotion'`);
  check("switched on on the sheet: the change listed and logged, the rest of the row kept as stored",
    on.status === 200 && same(on.body.changes, ["pushing promoted leads into campaigns off to on"]) &&
      T.audits.slice(audits0).some((a) => a.action === "enrich_settings" && a.details.includes("pushing promoted leads into campaigns off to on")) &&
      row1.value.auto_push === true && row1.value.batch_max === (row0?.value?.batch_max ?? 1000) && same(row1.value.tags, row0?.value?.tags ?? []) &&
      row1.value.promote_to_leads === (row0?.value?.promote_to_leads ?? false),
    JSON.stringify({ status: on.status, changes: on.body?.changes, row1 }));
  const now2 = await call(sheet.GET);
  const older = await call(sheet.PUT, edit(now2.body, (x) => { delete x.promotion.auto_push; x.promotion.promote_to_leads = !x.promotion.promote_to_leads; }));
  const row2 = await one(`SELECT value FROM enrich_settings WHERE key = 'promotion'`);
  check("an older sheet (no auto_push in its body) keeps what is stored", older.status === 200 && row2.value.auto_push === true &&
    !older.body.changes.some((c) => c.includes("pushing")), JSON.stringify(older.body?.changes ?? older.body));
  const now3 = await call(sheet.GET);
  const off = await call(sheet.PUT, edit(now3.body, (x) => { x.promotion.auto_push = false; x.promotion.promote_to_leads = row0?.value?.promote_to_leads ?? false; }));
  check("... and it switches off again", off.status === 200 && (await one(`SELECT value FROM enrich_settings WHERE key = 'promotion'`)).value.auto_push === false,
    JSON.stringify(off.body?.changes ?? off.body));
  T.columnsMissing = true;
  const now4 = await call(sheet.GET);
  const missing = await call(sheet.PUT, edit(now4.body, (x) => { x.promotion.auto_push = true; }));
  T.columnsMissing = false;
  check("the sheet refuses to switch it on while migration 140 is not applied (400), and writes nothing",
    missing.status === 400 && /needs migration 140/.test(missing.body.error ?? "") &&
      (await one(`SELECT value FROM enrich_settings WHERE key = 'promotion'`)).value.auto_push === false,
    JSON.stringify(missing.body));
  T.role = null;
}

// ── O. Switched off ─────────────────────────────────────────────────────────

async function partO(ctx) {
  section("O. Switched off: a round queues nothing, the push refuses");
  await setSwitch("promotion", { promote_to_leads: true, tags: TAGS, auto_push: false });
  ctx.off1 = await contact(ctx.A, "general", biz("off1"));
  const r = await call(ctx.promoteAuto, { body: { tag: A }, headers: bearer() });
  await drainAfter();
  const st = await stateOf(ctx.off1);
  check("a round while the push is off adds the lead and queues nothing", r.status === 202 && r.body.adding === 1 && st.promote_state === "added" &&
    st.auto_push_state === null && st.lead_id, JSON.stringify({ r: r.body, st }));
  const cell = await cellOf(ctx.off1);
  check("... its cell says Added, with no push sentence", cell?.display === "Added" && !cell.note.includes(PUSH_NOTE.queued) && !("push" in (cell.value ?? {})),
    JSON.stringify(cell));
  const p = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  check("the push route refuses while it is off (409), keeping what is queued", p.status === 409 && /automatic push is off for APTEST_A/.test(p.body.error ?? ""),
    JSON.stringify(p));
  check("... no push batch, and the worker finds nothing due", (await promoteBatches(A)).length === 0 && same(await pushDue(pool, await settingsNow()), []));
}

// ── A. Switched on ──────────────────────────────────────────────────────────

async function partA(ctx) {
  section("A1. Switched on: the queue at the settle");
  await setSwitch("promotion", { promote_to_leads: true, tags: TAGS, auto_push: true });
  await ranLongAgo();
  // A lead that is in the database already, before the round.
  const oldEmail = biz("old");
  await pool.query(`INSERT INTO leads (email, first_name, source, tags) VALUES ($1, 'Old', 'Made-up earlier import', $2)`, [oldEmail, `${PREFIX}OTHER`]);
  const c = {
    a1: await contact(ctx.A, "general", biz("info")),
    a2: await contact(ctx.A, "general", free("office")),
    a3: await contact(ctx.A, "person", biz("pat"), "Pat"),
    aMime: await contact(ctx.A, "general", biz("hello", "mimecastco")),
    aOld: await contact(ctx.A, "general", oldEmail),
  };
  ctx.a = c;
  const r1 = await call(ctx.promoteAuto, { body: { tag: A }, headers: bearer() });
  await drainAfter();
  const st = {};
  for (const [k, row] of Object.entries(c)) st[k] = await stateOf(row);
  check("the round: four new leads, one already in the database", r1.status === 202 && r1.body.adding === 4 && r1.body.settled === 1 && r1.body.batches?.length === 2,
    JSON.stringify(r1.body));
  check("each lead the round made is queued; the one that was there first is not",
    ["a1", "a2", "a3", "aMime"].every((k) => st[k].promote_state === "added" && st[k].auto_push_state === "queued" && st[k].auto_push_at) &&
      st.aOld.promote_state === "in_database" && st.aOld.auto_push_state === null,
    JSON.stringify(st));
  check("a lead added while the push was off stays unqueued", (await stateOf(ctx.off1)).auto_push_state === null);
  const cell = await cellOf(c.a1);
  check("an added contact's cell: Added, the note ending with the queued sentence, value.push queued",
    cell?.display === "Added" && cell.note.endsWith(QUEUED_SENTENCE) && cell.value?.push === "queued" && cell.value?.added === true, JSON.stringify(cell));
  check("the audit says the round's new leads were queued", T.audits.some((a) => a.action === "company_promote" && a.details.startsWith(A) &&
    a.details.includes("queued for the automatic push")));
  const mime = await one(`SELECT esp FROM leads WHERE id = $1`, [st.aMime.lead_id]);
  check("(the made-up mail provider lookup made the mimecast domain's lead a Mimecast one)", mime?.esp === "Mimecast", JSON.stringify(mime));
  ctx.lead = {};
  for (const k of ["a1", "a2", "a3", "aMime"]) ctx.lead[k] = st[k].lead_id;

  section("A2. The wait for places");
  const w0 = await pushWaiting(pool, A);
  check("before a location run has passed the round: 4 queued, none ready, all waiting for places",
    w0.queued === 4 && w0.ready === 0 && w0.unplaced === 4 && !w0.round_running && /location backfill/.test(waitingWhy(w0) ?? ""), JSON.stringify(w0));
  check("... nothing is ready and the worker asks for nothing", (await readyRows(pool, { tag: A })).length === 0 && same(await pushDue(pool, await settingsNow()), []));
  const p0 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  check("an ask now pushes nothing and says why (200)", p0.status === 200 && p0.body.batch === null && p0.body.pushed === 0 && p0.body.waiting === 4 &&
    /location backfill/.test(p0.body.note ?? ""), JSON.stringify(p0.body));
  check("... and reads no campaign", net.searches.length === 0);
  // The round's two batches (inboxes, then people) wait for the later one: a run that started between them places neither.
  const bs = await all(
    `SELECT id, created_at, completed_at FROM upload_batches WHERE id IN (SELECT batch_id FROM enrich_contacts WHERE row_id = ANY($1::bigint[])) ORDER BY completed_at`,
    [[c.a1, c.a3]]
  );
  check("(the round made two batches in one transaction: one created_at, two completed_at)", bs.length === 2 &&
    new Date(bs[0].created_at).getTime() === new Date(bs[1].created_at).getTime() && bs[0].completed_at < bs[1].completed_at, JSON.stringify(bs));
  await locationRun(new Date(new Date(bs[0].completed_at).getTime() + 1));
  const wMid = await pushWaiting(pool, A);
  check("a location run that started between the round's two batches places none of its leads", wMid.ready === 0 && wMid.unplaced === 4, JSON.stringify(wMid));
  await ranNow();
  const w1 = await pushWaiting(pool, A);
  check("once a run that started after the round has finished: all 4 ready", w1.queued === 4 && w1.ready === 4 && waitingWhy(w1) === null, JSON.stringify(w1));
  check("... and the worker asks for the client", same(await pushDue(pool, await settingsNow()), [A]));

  section("A3. The push: one forced batch, the popup's campaigns, exactly the new leads");
  // A push of the client in the last 24 hours, with no email side: the route's guard would refuse an unforced push now.
  await pool.query(
    `INSERT INTO push_batches (campaigns, selected_ids, client_tag, status, push_options) VALUES ('[]'::jsonb, ARRAY[gen_random_uuid()], $1, 'complete', '{"includeAlreadyPushed": false}'::jsonb)`,
    [A]
  );
  const auditsBefore = (await one(`SELECT count(*)::int AS n FROM audit_logs WHERE strpos(details, $1) > 0`, [A])).n;
  const p1 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  const batches = await promoteBatches(A);
  const b = batches[0];
  check("the ask queues ONE batch: 3 leads pushed, the Mimecast one held", p1.status === 200 && p1.body.pushed === 3 && p1.body.held === 1 &&
    p1.body.dropped === 0 && p1.body.campaigns === 3 && batches.length === 1 && p1.body.batch === b?.id && /Mimecast/.test(p1.body.held_why ?? ""),
    JSON.stringify(p1.body));
  check("... a push the route's 24-hour guard would refuse unforced goes in: forced", Boolean(b) && b.push_options?.force === true);
  check("its leads are exactly the round's new leads (not the earlier one, not the one that was there first, not the Mimecast one)",
    same(sorted(b?.selected_ids ?? []), sorted([ctx.lead.a1, ctx.lead.a2, ctx.lead.a3])), JSON.stringify(b?.selected_ids));
  check("its push options: source promote, skipAlreadySent, forced, nothing included again",
    same(b?.push_options, { force: true, source: PROMOTE_PUSH_SOURCE, retryFailed: false, skipAlreadySent: true, onlyNewSinceLast: false, includeAlreadyPushed: false }) ||
      same(Object.entries(b?.push_options ?? {}).sort(), Object.entries({ includeAlreadyPushed: false, onlyNewSinceLast: false, retryFailed: false, source: "promote", skipAlreadySent: true, force: true }).sort()),
    JSON.stringify(b?.push_options));
  check("as an Exports push by ids: the client's tag, no email side, no filters, no range, no creator, pending, no question variable",
    b?.client_tag === A && b.email_side === null && b.filters === null && b.range_from === null && b.range_to === null && b.max_leads === null &&
      b.created_by === null && b.status === "pending" && b.question_variable_id === null, JSON.stringify(b));
  const byId = Object.fromEntries((b?.campaigns ?? []).map((x) => [String(x.id), x]));
  check("its campaigns: the popup's pick (every APTEST_A campaign, not Nurture, not archived, not another client's), stamped as the route stamps them",
    same(sorted(Object.keys(byId)), ["901", "902", "911"]) &&
      byId["901"].instance_url === B2B && byId["901"].side === "b2b" && byId["901"].bucket === "outlook" && byId["901"].name === `${A}: Outlook` &&
      byId["902"].side === "b2b" && byId["902"].bucket === "default" && byId["911"].instance_url === B2C && byId["911"].side === "b2c" &&
      byId["911"].bucket === "default" && !("status" in byId["901"]),
    JSON.stringify(b?.campaigns));
  const tm = await one(`SELECT countries, require_location FROM client_targeting WHERE client_tag = $1`, [A]);
  check("its target market is the client's rules as they were", same(b?.target_market?.countries, tm.countries) && b.target_market.require_location === tm.require_location,
    JSON.stringify(b?.target_market));
  check("the campaign search was the popup's: the client's tag on each install, with that install's key",
    net.searches.length === 2 && net.searches.every((s) => s.term === A && s.auth === `Bearer ${INSTALL_KEYS[s.host]}`), JSON.stringify(net.searches));
  const st2 = {};
  for (const [k, row] of Object.entries(c)) st2[k] = await stateOf(row);
  check("the pushed contacts are marked with the batch; the Mimecast one held with its reason; the others untouched",
    ["a1", "a2", "a3"].every((k) => st2[k].auto_push_state === "pushed" && st2[k].auto_push_batch_id === b.id && st2[k].auto_push_note === null) &&
      st2.aMime.auto_push_state === "held" && /Mimecast address/.test(st2.aMime.auto_push_note ?? "") && st2.aMime.auto_push_batch_id === null &&
      st2.aOld.auto_push_state === null && (await stateOf(ctx.off1)).auto_push_state === null,
    JSON.stringify(st2));
  const cPushed = await cellOf(c.a1);
  const cHeld = await cellOf(c.aMime);
  check("the cells say so: pushed with the batch, held with the reason and where to push it; still Added",
    cPushed.display === "Added" && cPushed.note.includes(`${PUSH_NOTE.pushed}: push batch ${b.id}`) && !cPushed.note.includes(PUSH_NOTE.queued) &&
      cPushed.value.push === "pushed" && cPushed.value.push_batch_id === b.id &&
      cHeld.display === "Added" && cHeld.note.includes(`${PUSH_NOTE.held}: a Mimecast address`) && cHeld.note.endsWith("Push it from Leads, Export.") &&
      cHeld.value.push === "held",
    JSON.stringify({ cPushed, cHeld }));
  const audits = await all(`SELECT action, performed_by, details FROM audit_logs WHERE strpos(details, $1) > 0 ORDER BY created_at`, [A]);
  check("the audit log has the queued batch (as the push route words it) and the held lead",
    audits.length === auditsBefore + 2 && audits.some((x) => x.action === "bison_push_batch_queued" && x.performed_by === null && x.details.includes(b.id) &&
      x.details.includes("automatic push of 3 leads")) &&
      audits.some((x) => x.action === "promotion_push_held" && x.details.startsWith(`${A}: 1 promoted lead not pushed`) && /Mimecast/.test(x.details)),
    JSON.stringify(audits));
  ctx.batchA1 = b.id;

  section("A4. Never twice");
  const searches = net.searches.length;
  const p2 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  check("a second ask pushes nothing and reads no campaign", p2.status === 200 && p2.body.batch === null && p2.body.pushed === 0 && p2.body.note === "nothing to push" &&
    net.searches.length === searches && (await promoteBatches(A)).length === 1, JSON.stringify(p2.body));
  check("the worker finds nothing due for the client", same(await pushDue(pool, await settingsNow()), []));
  const settled = await one(`SELECT b.id::text AS id, b.created_at FROM upload_batches b JOIN enrich_contacts c ON c.batch_id = b.id WHERE c.row_id = $1`, [c.a1]);
  const again = await finishPromote(pool, {
    batchId: settled.id, batchAt: new Date(settled.created_at).toISOString(), contacts: [{ row_id: c.a1, table_id: ctx.A.tables.inboxes, email: biz("info") }],
    queuePush: true,
  });
  check("a retried settle of the same batch changes nothing (fenced on running): the contact stays pushed",
    again.added === 0 && again.queued === 0 && (await stateOf(c.a1)).auto_push_state === "pushed", JSON.stringify(again));

  // The worker's gather over the batch, as written in scripts/push-worker.mjs, rolled back: exactly the three leads.
  const pw = source("scripts/push-worker.mjs");
  const piece = (name) => {
    const m = new RegExp(`const ${name} =\\s*((?:\`[^\`]*\`\\s*\\+?\\s*)+);`).exec(pw);
    return m ? [...m[1].matchAll(/`([^`]*)`/g)].map((x) => x[1]).join("") : null;
  };
  const ELIGIBLE = piece("ELIGIBLE");
  const NOT_SENT = piece("NOT_SENT_FOR_CLIENT");
  const gatherSrc = /async function gatherCycle\(\) \{([\s\S]*?)\n\}/.exec(pw)?.[1] ?? "";
  check("(the worker's gather statements are where this test reads them)", Boolean(ELIGIBLE && NOT_SENT) &&
    gatherSrc.includes("`select l.id, l.email from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE}${skipSent ? ` and ${NOT_SENT_FOR_CLIENT}` : \"\"}`"));
  const g = await pool.connect();
  try {
    await g.query("BEGIN");
    const got = (await g.query(
      `select l.id::text AS id from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE} and ${NOT_SENT}`,
      [b.selected_ids, b.client_tag, b.id]
    )).rows.map((x) => x.id);
    check("the push worker gathers exactly the three new leads (skipAlreadySent on), and treats the batch as no share push",
      same(sorted(got), sorted(b.selected_ids)) && isSharePush(b.push_options) === false, JSON.stringify(got));
  } finally {
    await g.query("ROLLBACK").catch(() => {});
    g.release();
  }

  section("A5. A second round: only its own new lead");
  c.a4 = await contact(ctx.A, "general", biz("sales"));
  c.aRace = await contact(ctx.A, "general", biz("race"));
  const r2 = await call(ctx.promoteAuto, { body: { tag: A }, headers: bearer() });
  // Another import adds one of the round's addresses before the round's own import runs (the after() callbacks).
  await pool.query(`INSERT INTO leads (email, source) VALUES ($1, 'Made-up other import')`, [biz("race")]);
  await drainAfter();
  const sRace = await stateOf(c.aRace);
  check("the second round adds the one new contact and queues it", r2.status === 202 && r2.body.adding === 2 && (await stateOf(c.a4)).auto_push_state === "queued",
    JSON.stringify(r2.body));
  check("a lead that reached the database while the round ran is settled there first and never queued",
    sRace.promote_state === "in_database" && sRace.auto_push_state === null && sRace.lead_id, JSON.stringify(sRace));
  await ranNow();
  // A round of the client still importing: nothing of the client is taken until it has finished.
  const live = await one(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type, source_label, add_tags)
     VALUES (NULL, $1, 1, 'processing', 'skip', '{}'::jsonb, '[]'::jsonb, 'leads', 'Companies (AI Ark)', ARRAY[$2::text]) RETURNING id::text AS id`,
    [`Companies pipeline · ${A} · made-up live round ${RUN}`, A]
  );
  c.aLive = await contact(ctx.A, "general", biz("live"));
  await pool.query(`UPDATE enrich_contacts SET promote_state = 'running', batch_id = $2 WHERE row_id = $1`, [c.aLive, live.id]);
  const wLive = await pushWaiting(pool, A);
  check("while a round of the client is still importing, nothing is ready, and it says why",
    wLive.round_running && wLive.ready === 0 && wLive.queued === 1 && /still importing/.test(waitingWhy(wLive) ?? "") && (await readyRows(pool, { tag: A })).length === 0,
    JSON.stringify(wLive));
  await pool.query(`UPDATE upload_batches SET status = 'complete', completed_at = now() WHERE id = $1`, [live.id]);
  await pool.query(`UPDATE enrich_contacts SET promote_state = 'not_added', promoted_at = now() WHERE row_id = $1`, [c.aLive]);
  check("once it has finished, the earlier round's lead is ready again", (await pushWaiting(pool, A)).ready === 1);

  section("E1. Errors before the batch: no Bison keys, a campaign search error");
  delete process.env.EMAILBISON_KEYS;
  const e1 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  process.env.EMAILBISON_KEYS = JSON.stringify(INSTALL_KEYS);
  check("no Bison keys: 409, the lead stays queued", e1.status === 409 && /No Bison keys/.test(e1.body.error ?? "") && e1.body.kept === 1 &&
    (await stateOf(c.a4)).auto_push_state === "queued", JSON.stringify(e1));
  net.fail[B2C] = 500;
  const e2 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  delete net.fail[B2C];
  check("a campaign search that reported an error (one install failed): 409, nothing pushed, the lead stays queued",
    e2.status === 409 && /campaign search for APTEST_A reported an error/.test(e2.body.error ?? "") && e2.body.error.includes(B2C) &&
      (await stateOf(c.a4)).auto_push_state === "queued" && (await promoteBatches(A)).length === 1,
    JSON.stringify(e2));
  const p3 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  const after3 = await promoteBatches(A);
  check("the next ask pushes the second round's lead alone, in a batch of its own; the first batch is as it was",
    p3.status === 200 && p3.body.pushed === 1 && after3.length === 2 && same(after3[1].selected_ids, [await leadIdOf(c.a4)]) &&
      same(sorted(after3[0].selected_ids), sorted([ctx.lead.a1, ctx.lead.a2, ctx.lead.a3])) && after3[0].id === ctx.batchA1,
    JSON.stringify({ p3: p3.body, batches: after3.map((x) => x.selected_ids) }));

  section("A6. The wait limit");
  c.a5 = await contact(ctx.A, "general", biz("hello"));
  await call(ctx.promoteAuto, { body: { tag: A }, headers: bearer() });
  await drainAfter();
  await ranLongAgo();
  check("a round no location run has passed waits", (await pushWaiting(pool, A)).ready === 0 && (await stateOf(c.a5)).auto_push_state === "queued");
  await pool.query(
    `UPDATE upload_batches SET completed_at = completed_at - make_interval(mins => $2) WHERE id = (SELECT batch_id FROM enrich_contacts WHERE row_id = $1)`,
    [c.a5, PUSH_WAIT_MINUTES + 1]
  );
  check(`... until ${PUSH_WAIT_MINUTES} minutes after its round finished: then it goes anyway`, (await pushWaiting(pool, A)).ready === 1);
  const p4 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  check("... in a batch of its own", p4.status === 200 && p4.body.pushed === 1 && (await promoteBatches(A)).length === 3 &&
    (await stateOf(c.a5)).auto_push_state === "pushed", JSON.stringify(p4.body));

  section("A7. Dropped: a lead gone, a lead already in one of the client's pushes; never an empty batch");
  c.a6 = await contact(ctx.A, "general", biz("gone"));
  c.a7 = await contact(ctx.A, "general", biz("manual"));
  await call(ctx.promoteAuto, { body: { tag: A }, headers: bearer() });
  await drainAfter();
  await ranNow();
  const gone = await leadIdOf(c.a6);
  const manual = await leadIdOf(c.a7);
  await pool.query(`DELETE FROM leads WHERE id = $1`, [gone]);
  // An operator's push of the lead for the client, waiting (scoring: no push worker ever gathers it).
  const op = await one(
    `INSERT INTO push_batches (campaigns, selected_ids, client_tag, status) VALUES ('[]'::jsonb, ARRAY[$1::uuid], $2, 'scoring') RETURNING id::text AS id`,
    [manual, A]
  );
  const p5 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  const s6 = await stateOf(c.a6);
  const s7 = await stateOf(c.a7);
  check("both dropped with their reasons, and no batch at all (an empty id list is never inserted)",
    p5.status === 200 && p5.body.dropped === 2 && p5.body.pushed === 0 && p5.body.batch === null && (await promoteBatches(A)).length === 3 &&
      s6.auto_push_state === "dropped" && s6.auto_push_note === "the lead is gone or has no email" &&
      s7.auto_push_state === "dropped" && s7.auto_push_note === `it is in ${A}'s push batch ${op.id} already`,
    JSON.stringify({ p5: p5.body, s6, s7 }));
  check("... and the audit log has each reason", (await all(`SELECT 1 FROM audit_logs WHERE action = 'promotion_push_dropped' AND details LIKE $1`, [`${A}:%`])).length === 2);

  c.a8 = await contact(ctx.A, "general", biz("twice"));
  await call(ctx.promoteAuto, { body: { tag: A }, headers: bearer() });
  await drainAfter();
  await ranNow();
  const { pushPromoted } = await srcModule("lib/companies/promote-push.ts");
  let arrived = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  // Both asks read the campaigns, and neither goes on until both have: they then race for the client's leads.
  const reader = async (tag) => {
    if (++arrived === 2) release();
    await gate;
    return { data: [...net.plan[B2B], ...net.plan[B2C]].filter((cp) => cp.name.startsWith(`${tag}:`)).map((cp) => ({ ...cp, instance_url: cp.id < 910 ? B2B : B2C })), errors: [] };
  };
  const settledBoth = await Promise.allSettled([pushPromoted(pool, { tag: A, readCampaigns: reader }), pushPromoted(pool, { tag: A, readCampaigns: reader })]);
  const [x, y] = settledBoth.map((o) => (o.status === "fulfilled" ? o.value : { status: 500, body: { pushed: 0, error: String(o.reason) } }));
  const twice = await promoteBatches(A);
  const a8Lead = await leadIdOf(c.a8);
  const withA8 = twice.filter((bb) => bb.selected_ids.includes(a8Lead));
  check("two asks at once: one batch, the other finds nothing (the client's lock and the fenced mark)",
    x.status === 200 && y.status === 200 && x.body.pushed + y.body.pushed === 1 && twice.length === 4 && withA8.length === 1 &&
      (await stateOf(c.a8)).auto_push_state === "pushed",
    JSON.stringify({ x: x.body, y: y.body, batches: twice.length }));
  await ranNow();
}

// ── B. No campaign named for the client ─────────────────────────────────────

async function partB(ctx) {
  section("B. No campaign named for the client: every lead held, with the reason");
  const b1 = await contact(ctx.B, "general", biz("info", "bco"));
  const b2 = await contact(ctx.B, "general", free("bfront"));
  const r = await call(ctx.promoteAuto, { body: { tag: B }, headers: bearer() });
  await drainAfter();
  await ranNow();
  const p = await call(ctx.pushAuto, { body: { tag: B }, headers: bearer() });
  const why = `no campaign is named "${B}: …"`;
  check("nothing is picked (a campaign named for APTEST_BX is not the client's): no batch, both leads held with the popup's reason",
    r.status === 202 && p.status === 200 && p.body.batch === null && p.body.pushed === 0 && p.body.held === 2 && (p.body.held_why ?? "").includes(why) &&
      (await promoteBatches(B)).length === 0 && (await all(`SELECT 1 FROM push_batches WHERE client_tag = $1`, [B])).length === 0,
    JSON.stringify(p.body));
  const s1 = await stateOf(b1);
  const s2 = await stateOf(b2);
  check("each contact records it: held, the reason, no batch", [s1, s2].every((s) => s.auto_push_state === "held" && s.auto_push_note.includes(why) &&
    s.auto_push_note.includes("export popup") && s.auto_push_batch_id === null), JSON.stringify({ s1, s2 }));
  const cell = await cellOf(b1);
  check("... its cell says why and where to push it", cell.note.includes(`${PUSH_NOTE.held}: no campaign could be picked as the export popup picks them`) &&
    cell.note.endsWith("Push it from Leads, Export."), JSON.stringify(cell));
  const audit = await one(`SELECT action, details FROM audit_logs WHERE action = 'promotion_push_held' AND details LIKE $1`, [`${B}:%`]);
  check("... and the audit log has it once", audit?.details === `${B}: 2 promoted leads not pushed into its campaigns: no campaign could be picked as the export popup picks them: ${why}`,
    JSON.stringify(audit));
  const again = await call(ctx.pushAuto, { body: { tag: B }, headers: bearer() });
  check("held leads are never taken again (left for a push from Leads, Export)", again.status === 200 && again.body.held === 0 &&
    again.body.note === "nothing to push" && (await readyRows(pool, { tag: B })).length === 0, JSON.stringify(again.body));
  ctx.bHeld = [b1, b2];
}

// ── C. B2B campaigns only ───────────────────────────────────────────────────

async function partC(ctx) {
  section("C. B2B campaigns only: a lead goes only to its own side");
  const c1 = await contact(ctx.C, "general", biz("info", "cco"));
  const c2 = await contact(ctx.C, "general", free("cfront"));
  await call(ctx.promoteAuto, { body: { tag: C }, headers: bearer() });
  await drainAfter();
  await ranNow();
  const p = await call(ctx.pushAuto, { body: { tag: C }, headers: bearer() });
  const [batch] = await promoteBatches(C);
  check("the business inbox is pushed to the B2B campaign; the freemail one held: no B2C campaign",
    p.status === 200 && p.body.pushed === 1 && p.body.held === 1 && /no B2C campaign of APTEST_C was picked/.test(p.body.held_why ?? "") &&
      same(batch?.selected_ids, [await leadIdOf(c1)]) && same(batch.campaigns.map((x) => [x.id, x.side, x.instance_url]), [[903, "b2b", B2B]]) &&
      !("bucket" in batch.campaigns[0]),
    JSON.stringify({ p: p.body, batch }));
  check("... the freemail contact held with that reason", (await stateOf(c2)).auto_push_state === "held" &&
    /no B2C campaign/.test((await stateOf(c2)).auto_push_note ?? ""));
}

// ── D. The client's question variable ───────────────────────────────────────

async function partD(ctx) {
  section("D. A client whose pushes send a question variable: held");
  const v = await one(`INSERT INTO question_variables (name, created_for_tag) VALUES ($1, $2) RETURNING id::text AS id`, [VAR_NAME, D]);
  await pool.query(`INSERT INTO client_question_settings (client_tag, variable_id) VALUES ($1, $2)`, [D, v.id]);
  await setSwitch("question_variables", { enabled: true, tags: [D] });
  const d1 = await contact(ctx.D, "general", biz("info", "dco"));
  await call(ctx.promoteAuto, { body: { tag: D }, headers: bearer() });
  await drainAfter();
  await ranNow();
  const p = await call(ctx.pushAuto, { body: { tag: D }, headers: bearer() });
  check("its new leads have no value written for the variable, so none is pushed: held, naming it",
    p.status === 200 && p.body.held === 1 && p.body.batch === null && (p.body.held_why ?? "").includes(`{${VAR_NAME.toUpperCase()}}`) &&
      (await stateOf(d1)).auto_push_state === "held" && (await promoteBatches(D)).length === 0,
    JSON.stringify(p.body));
  await setSwitch("question_variables", { enabled: switchesBefore.question_variables.value?.enabled ?? false, tags: switchesBefore.question_variables.value?.tags ?? [] });
}

// ── E. The route's key and body ─────────────────────────────────────────────

async function partE(ctx) {
  section("E2. POST /api/companies/promote/auto/push: the key and the body");
  delete process.env.AIARK_AUTO_ADD_KEY;
  const r0 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer() });
  process.env.AIARK_AUTO_ADD_KEY = "too-short";
  const rShort = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer("too-short") });
  process.env.AIARK_AUTO_ADD_KEY = AUTO_KEY;
  check("no AIARK_AUTO_ADD_KEY, or one under 32 characters: 503", r0.status === 503 && rShort.status === 503);
  const r1 = await call(ctx.pushAuto, { body: { tag: A }, headers: bearer("aptest-wrong-key-aptest-wrong-key-xx") });
  check("a wrong key: 401 with WWW-Authenticate: Bearer", r1.status === 401 && r1.headers?.["WWW-Authenticate"] === "Bearer");
  check("no Bearer at all: 401", (await call(ctx.pushAuto, { body: { tag: A } })).status === 401);
  check("a tag that is not a client tag: 400", (await call(ctx.pushAuto, { body: { tag: "not a tag!" }, headers: bearer() })).status === 400 &&
    (await call(ctx.pushAuto, { body: {}, headers: bearer() })).status === 400 && (await call(ctx.pushAuto, { body: null, headers: bearer() })).status === 400);
  check("a lower-case tag is the client's", (await call(ctx.pushAuto, { body: { tag: A.toLowerCase() }, headers: bearer() })).body?.tag === A);
  check("the route is under the path the middleware leaves to its Bearer key", PROMOTE_PUSH_PATH === "/api/companies/promote/auto/push" &&
    source("src/middleware.ts").includes("api/companies/promote/auto|"));
  check("the push route's 24-hour guard leaves automatic pushes out, as it leaves shares out",
    source("src/app/api/bison/push-batch/route.ts").includes("`not in ('share', 'topup', '${PROMOTE_PUSH_SOURCE}')`"));
}

// ── W. The worker ───────────────────────────────────────────────────────────

async function partW() {
  section("W. The worker: the ask, its address, the log line, the wiring");
  check("its address is the auto-add address's origin with the same key, at least 32 characters",
    promotePushConfig({ AIARK_AUTO_ADD_URL: "https://web.aptest.example/api/aiark/add/auto", AIARK_AUTO_ADD_KEY: AUTO_KEY })?.url === `https://web.aptest.example${PROMOTE_PUSH_PATH}` &&
      promotePushConfig({ AIARK_AUTO_ADD_URL: "https://web.aptest.example", AIARK_AUTO_ADD_KEY: "short" }) === null &&
      promotePushConfig({ AIARK_AUTO_ADD_URL: "", AIARK_AUTO_ADD_KEY: AUTO_KEY }) === null &&
      promotePushConfig({ AIARK_AUTO_ADD_URL: "not a url", AIARK_AUTO_ADD_KEY: AUTO_KEY }) === null);
  const sent = [];
  const config = { url: `https://web.aptest.example${PROMOTE_PUSH_PATH}`, key: AUTO_KEY };
  const answer = (status, body) => async (u, init) => {
    sent.push({ u, init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const ok = await requestPromotePush(config, A, answer(200, { tag: A, pushed: 3, batch: "made-up-batch", held: 1, held_why: "a Mimecast address" }));
  const req = sent[0];
  check("the ask: a POST of {tag} with the Bearer key and a timeout", req.u === config.url && req.init.method === "POST" &&
    req.init.headers.authorization === `Bearer ${AUTO_KEY}` && JSON.parse(req.init.body).tag === A && req.init.signal instanceof AbortSignal && ok.ok && ok.body.pushed === 3);
  const no = await requestPromotePush(config, A, answer(409, { error: "The automatic push is off for APTEST_A" }));
  const lost = await requestPromotePush(config, A, async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  check("a refusal and a lost answer come back as reasons, never thrown", !no.ok && no.status === 409 && /off for APTEST_A/.test(no.why) &&
    !lost.ok && lost.status === null && lost.why === "ECONNREFUSED");
  check("the log line says what happened", pushLogLine(A, ok) === `push for ${A}: 3 lead(s) in push batch made-up-batch, 1 held (a Mimecast address)` &&
    pushLogLine(A, no).startsWith(`push for ${A}: not pushed, 409:`) && pushLogLine(A, { ok: true, body: { note: "nothing to push" } }) === `push for ${A}: nothing to push`);
  const ws = source("scripts/enrich-worker.mjs");
  check("the worker asks on the promotion minute, not awaited, with a busy flag of its own and at most once every 2 minutes a client",
    /if \(Date\.now\(\) - lastPromote > PROMOTE_CHECK_MS\) \{\s*lastPromote = Date\.now\(\);\s*promoteWaiting\(\);\s*pushPromoted\(\);\s*\}/.test(ws) &&
      /async function pushPromoted\(\) \{\s*if \(!promotePush \|\| pushBusy\) return;\s*pushBusy = true;/.test(ws) &&
      ws.includes("for (const tag of await pushDue(pool, settings))") && ws.includes("requestPromotePush(promotePush, tag)") &&
      PUSH_ASK_EVERY_MS === 2 * 60_000 && ws.includes("CAPABILITIES.push(PROMOTION_PUSH_CAPABILITY);") && PROMOTION_PUSH_CAPABILITY === "promotion_push");
  check("... and its promotion ask: at most one round per client every 2 minutes", /PROMOTE_EVERY_MS = 2 \* 60_000/.test(ws) && /promoteDue\(pool, settings\)/.test(ws) &&
    /requestPromote\(promoteAuto, tag\)/.test(ws));
  const { groupToSave, sideAcrossInstalls, checkPushCampaigns, selectedIdsError } = await srcModule("lib/bison/push-batch-core.ts");
  const g1 = BISON_GROUPS[1];
  check("the shared core: the group to save only when it changes, the side rule, the checks' words",
    same(groupToSave(null, 1), { group: 1, b2b: g1.b2b, b2c: g1.b2c, previous: null }) && groupToSave({ group: 1, b2b: g1.b2b, b2c: g1.b2c }, 1) === null &&
      groupToSave({ group: 2, b2b: "x", b2c: "y" }, null) === null &&
      "error" in sideAcrossInstalls([{ id: 1, instance_url: B2B }, { id: 2, instance_url: B2C }], null) &&
      same(sideAcrossInstalls([{ id: 1, instance_url: B2B, side: "b2b" }, { id: 2, instance_url: B2C, side: "b2c" }], A), { group: null }) &&
      checkPushCampaigns([], []).error === "campaigns is required (at least one campaign)" &&
      /Nurture campaign/.test(checkPushCampaigns([{ id: 1, name: "X: a [Nurture]", instance_url: B2B }], [{ domain: B2B, key: "k" }]).error ?? "") &&
      selectedIdsError(["not-a-uuid"]) === "selectedIds must be uuid strings" && selectedIdsError(undefined) === null);
  check("the note helper replaces the push sentence, never stacks them", notePush(notePush("Added.", QUEUED_SENTENCE), `${PUSH_NOTE.pushed}: x.`) === `Added. ${PUSH_NOTE.pushed}: x.`);
}

// ── P. The fit panel ────────────────────────────────────────────────────────

async function partP() {
  section("P. The fit panel: the push's counts and its last held reason");
  const { GET } = await route("fit/state");
  T.role = "manager";
  T.worker = { id: "aptest", online: true, seconds_ago: 2, info: { capabilities: ["fit_scoring", PROMOTION_PUSH_CAPABILITY] } };
  const a = await call(GET, { query: { tag: A } });
  const pa = a.body?.promotion;
  check("A: the push on for the client, 6 pushed, 1 held (Mimecast), 2 dropped, nothing queued, the worker pushes",
    a.status === 200 && pa.auto_push === true && pa.push_on_for_client === true && pa.push_ready === true && pa.push?.pushed === 6 && pa.push.held === 1 &&
      pa.push.queued === 0 && pa.push.dropped === 2 && pa.push.last_pushed_at && /Mimecast/.test(pa.push.last_held?.note ?? "") && a.body.worker.promotion_push === true,
    JSON.stringify(pa));
  const b = await call(GET, { query: { tag: B } });
  check("B: 2 held, the reason shown", b.status === 200 && b.body.promotion.push?.held === 2 && b.body.promotion.push.pushed === 0 &&
    (b.body.promotion.push.last_held?.note ?? "").includes(`no campaign is named "${B}: …"`), JSON.stringify(b.body?.promotion));
  T.worker = { id: "aptest", online: true, seconds_ago: 2, info: { capabilities: ["fit_scoring"] } };
  const old = await call(GET, { query: { tag: A } });
  check("an older worker reads as one that does not push", old.body.worker.promotion_push === false);
  T.role = null;
  T.worker = null;
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  const tbl = (await all(`SELECT id FROM enrich_tables WHERE client_tag = ANY($1::text[])`, [TAGS])).map((r) => r.id);
  await pool.query(`DELETE FROM push_batches WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM upload_batches WHERE strpos(filename, $1) > 0`, [PREFIX]);
  await pool.query(`DELETE FROM enrich_memory WHERE client_tag = ANY($1::text[]) OR table_id = ANY($2::uuid[])`, [TAGS, tbl]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tbl]);
  // After the tables: deleting their cells writes their counters' deltas.
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tbl]);
  await pool.query(`DELETE FROM enrich_originals WHERE variant = ANY($1::text[])`, [VARIANTS]);
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1 OR email LIKE 'aptest-%@gmail.com'`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1 OR email LIKE 'aptest-%@gmail.com'`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM audit_logs WHERE strpos(details, $1) > 0`, [PREFIX]);
  await pool.query(`DELETE FROM client_question_settings WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM question_variables WHERE name LIKE 'aptest-%'`);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[])`, [TAGS]);
  if (switchesBefore) {
    for (const key of SWITCHES) {
      const b = switchesBefore[key];
      if (b.exists) await pool.query(`UPDATE enrich_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1`, [key, JSON.stringify(b.value), b.updated_by]);
      else await pool.query(`DELETE FROM enrich_settings WHERE key = $1`, [key]);
    }
  }
  if (cronBefore !== undefined) {
    if (cronBefore) {
      await pool.query(
        `UPDATE cron_runs SET started_at = $2, finished_at = $3, finished_run_started_at = $4, updated_at = $5 WHERE name = $1`,
        [CRON_LOCATION_BACKFILL, cronBefore.started_at, cronBefore.finished_at, cronBefore.finished_run_started_at, cronBefore.updated_at]
      );
    } else {
      await pool.query(`DELETE FROM cron_runs WHERE name = $1`, [CRON_LOCATION_BACKFILL]);
    }
  }
}

const t0 = Date.now();
try {
  if (!(await pushColumnsReady(pool))) throw new Error("migration 140 is not in this database");
  const worker = await one(`SELECT count(*)::int AS n FROM enrich_worker_state WHERE last_seen > now() - interval '30 seconds' AND NOT coalesce((info->>'stopped')::boolean, false)`);
  if (worker.n) throw new Error("an enrichment worker's heartbeat is fresh: stop it first");
  // A run that was cut off may have left its clients on the lists; they are its own, so they go first.
  await cleanup();
  switchesBefore = {};
  for (const key of SWITCHES) {
    const s = await one(`SELECT value, updated_by FROM enrich_settings WHERE key = $1`, [key]);
    const value = s?.value ?? null;
    if (value && Array.isArray(value.tags)) value.tags = value.tags.filter((t) => !String(t).startsWith(PREFIX));
    switchesBefore[key] = { exists: Boolean(s), value, updated_by: s?.updated_by ?? null };
  }
  cronBefore = await one(`SELECT started_at, finished_at, finished_run_started_at, updated_at FROM cron_runs WHERE name = $1`, [CRON_LOCATION_BACKFILL]);
  const base = await settingsNow();
  const busy = base.promotion.tags.filter((t) => !t.startsWith(PREFIX));
  check("before the run: no other client on promotion's list", busy.length === 0, JSON.stringify(busy));
  if (busy.length) throw new Error("not run: another client is on promotion's list here");
  for (const t of TAGS) {
    await pool.query(`INSERT INTO client_tags (tag, name, client_type, b2b_instance, b2c_instance) VALUES ($1, $2, NULL, $3, $4)`,
      [t, `Auto push test ${t.slice(-1)}`, B2B, B2C]);
    await pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, require_location, updated_at)
       VALUES ($1, '{US}', '[]', '[]', '{}', false, true, now())`,
      [t]
    );
    await seedFixtureVariant(pool, t);
  }
  const ctx = {
    promoteAuto: (await route("companies/promote/auto")).POST,
    pushAuto: (await route("companies/promote/auto/push")).POST,
  };
  for (const t of TAGS) ctx[t.slice(-1)] = await setupClient(t);
  await partS();
  await partO(ctx);
  await partA(ctx);
  await partB(ctx);
  await partC(ctx);
  await partD(ctx);
  await partE(ctx);
  await partW();
  await partP();
  section("N. The network");
  check("nothing tried to reach any other address", net.refused === 0, `${net.refused} refused`);
} catch (e) {
  counts.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[])) AS clients,
            (SELECT count(*)::int FROM enrich_tables WHERE client_tag = ANY($1::text[])) AS tables,
            (SELECT count(*)::int FROM enrich_contacts WHERE client_tag = ANY($1::text[])) AS contacts,
            (SELECT count(*)::int FROM push_batches WHERE client_tag = ANY($1::text[])) AS pushes,
            (SELECT count(*)::int FROM upload_batches WHERE strpos(filename, $2) > 0) AS batches,
            (SELECT count(*)::int FROM enrich_originals WHERE variant = ANY($3::text[])) AS originals,
            (SELECT count(*)::int FROM audit_logs WHERE strpos(details, $2) > 0) AS audits,
            (SELECT count(*)::int FROM leads WHERE email LIKE $4 OR email LIKE 'aptest-%@gmail.com') AS leads,
            (SELECT count(*)::int FROM question_variables WHERE name LIKE 'aptest-%') AS variables`,
    [TAGS, PREFIX, VARIANTS, `%.${HOST}`]
  );
  let switchesBack = true;
  if (switchesBefore) {
    for (const key of SWITCHES) {
      const s = await one(`SELECT value FROM enrich_settings WHERE key = $1`, [key]);
      const b = switchesBefore[key];
      if (b.exists ? JSON.stringify(s?.value) !== JSON.stringify(b.value) : Boolean(s)) switchesBack = false;
    }
  }
  const cronNow = await one(`SELECT started_at, finished_at, finished_run_started_at, updated_at FROM cron_runs WHERE name = $1`, [CRON_LOCATION_BACKFILL]);
  const cronBack = cronBefore === undefined || JSON.stringify(cronNow) === JSON.stringify(cronBefore);
  const clean = Object.values(left).every((n) => n === 0) && switchesBack && cronBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, switchesBack, cronBack })}`}`);
  console.log(`${counts.passed} passed, ${counts.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const p of T.pools) await p.end().catch(() => {});
  await pool.end();
  process.exit(counts.failed || !clean ? 1 : 0);
}
