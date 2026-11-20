#!/usr/bin/env node
// Clay-like promotion of found emails, and AI Ark pulls' people with no email
// sent to the email finders (2026-11-21). LOCAL DATABASE ONLY: two made-up
// clients, PRTEST_A (promotion) and PRTEST_B (pulls), each with the made-up
// Clay originals as its own variant, made-up contacts, AI Ark runs, People
// rows and leads under .prtest.example, all removed at the end (and any left
// by a run that was cut off). For the run it switches promotion on for
// PRTEST_A and people_pipeline on for PRTEST_B, and the finders' calls go to
// today's spend; those settings rows and the day's spend are put back at the
// end. No other client is touched.
//
//   node --env-file=.env.local scripts/test-found-emails.mjs
//
// Stop the enrichment worker first, and don't start it for this: the copy,
// the release and the hand-back run here as the worker would run them. Run it
// under the shared local-database lock when other suites share the database.
// It refuses to run while a client is on the company_pipeline,
// people_pipeline, personalisation or promotion lists, or while any row is
// held: the release acts on every client.
//
// Nothing here reaches a network: fetch answers OpenAI, Reoon, Google's DNS,
// the email finders and Enrichley from stubs and refuses and counts any other
// address, DNS is refused, and the import's mail provider lookup is a stub.
// No paid key is read; the keys here are made up. The routes run for real
// through a small loader that compiles their TypeScript, with stand-ins only
// for the session, the audit log, the worker's heartbeat, Next's after() (its
// callbacks are run when the test says), the shared pg pool and the mail
// provider lookup.
//
//   A. the verdicts and the lead rows (pure)
//   B. promotion end to end: the promote route and the real import
//   C. the copy: which runs and rows, the held People rows, the cells, a
//      repeat, a deleted row, a refusal, runs never taken
//   D. the People release, the hand-back and the AI Ark add through the real import
//   E. the wiring: the worker, the screens, the AI Ark add as before

import pg from "pg";
import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { checker, dropPaidKeys, inTx, installNet, localDatabaseUrl, seedFixtureVariant, workRow } from "./fixtures/test-support.mjs";
import { OriginalsMissing } from "./lib/enrich/compile-original.mjs";
import { ensurePipelineTables, lockPipelineTables, variantName } from "./lib/enrich/templates.mjs";
import { settingsFrom, VENDOR_CAP_KEYS } from "./lib/enrich/settings.mjs";
import { vendorKind, VENDOR_SPEND_KINDS } from "./lib/enrich/spend.mjs";
import { resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { resetCompanyActions } from "./lib/enrich/company-actions.mjs";
import { releaseHeldPeopleRows } from "./lib/enrich/held.mjs";
import { aiarkPersonRowKey } from "./lib/enrich/people-template.mjs";
import { enrichleyStatus, inboxVerdict, personVerdict, VERDICT_CELLS, verdictSource } from "./lib/enrich/email-verdict.mjs";
import { HOLD, inboxLeadRow, personLeadRow, PROMOTE_CELLS, PROMOTE_COLUMNS, PROMOTE_SOURCE } from "./lib/enrich/promote.mjs";
import {
  copyPullNoEmail, FIND_EMAIL_COLUMN, handBackFound, PULL_CELLS, PULL_NO_EMAIL_CAPABILITY, pullPeopleInputs, pullSourceLabel,
} from "./lib/enrich/pull-no-email.mjs";
import { addState, ADD_INPUT_KEYS, emailFound, IMPORT_COLUMNS, importRow, rowSource, SOURCE } from "./lib/aiark/add.mjs";
import { RUN_COLUMNS } from "./lib/aiark/columns.mjs";
import { createRun } from "./lib/aiark/runs.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;
for (const name of ["resolveMx", "resolve", "resolve4", "resolve6", "resolveAny", "lookup"]) {
  dns.promises[name] = async () => {
    throw Object.assign(new Error("DNS refused: this test allows no network"), { code: "ECONNREFUSED" });
  };
}

const PREFIX = "PRTEST_";
const TA = `${PREFIX}A`; // promotion
const TB = `${PREFIX}B`; // pulls
const TAGS = [TA, TB];
const VARIANTS = TAGS.map(variantName);
const RUN = randomUUID().slice(0, 6);
const HOST = "prtest.example"; // every made-up address and domain ends with it
const dom = (slug) => `${slug}-${RUN}.${HOST}`;
const at = (local, slug = "acme") => `${local}-${RUN}@${dom(slug)}`;
const pid = (n) => `prtest-${RUN}-${n}`; // a made-up AI Ark person id
const SWITCHES = ["promotion", "people_pipeline"];
const TODAY = `(now() AT TIME ZONE 'utc')::date`;
const BANNED = "prtestbanned"; // PRTEST_B's one exclusion term
const KEYS = { FINDYMAIL_API_KEY: "made-up-fm", PROSPEO_API_KEY: "made-up-pr", ANYMAIL_FINDER_API_KEY: "made-up-am", ENRICHLEY_API_KEY: "made-up-en" };

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** JSON with every object's keys sorted: jsonb keeps no key order. */
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

// ── The routes' TypeScript, compiled as it is imported ──────────────────────

const require = createRequire(import.meta.url);
const pgUrl = pathToFileURL(require.resolve("pg")).href;
const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}
export function after(fn) { globalThis.__prTest.after.push(fn); }`,
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
export async function requireRole(min) {
  const t = globalThis.__prTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}
export function intakeKeyStatus() { return "unauthorized"; }`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__prTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__prTest.worker; }`,
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => ({ data: { user: null } }) } };
}`,
  "@/lib/db/pool": `import pg from "${pgUrl}";
let p = null;
export function getPool() {
  if (!p) { p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }); globalThis.__prTest.pools.push(p); }
  return p;
}`,
  // The import's mail provider lookup (src/lib/uploads/esp-lookup.ts): never asking DNS.
  "./esp-lookup": `export function domainOfEmail(email) {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.includes(".") ? d : null;
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
const T = (globalThis.__prTest = { role: null, userId: null, audits: [], worker: null, after: [], pools: [] });
const route = (p) => import(new URL(`app/api/${p}/route.ts`, SRC).href);
async function call(handler, { body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const req = { json: async () => body, nextUrl: new URL(`http://found-emails.test/api${qs}`), headers: new Headers() };
  const res = await handler(req);
  return { status: res.status, body: res.body };
}
/** Runs the after() callbacks the routes left, in order, as Next does once the answer is sent. */
async function drainAfter() {
  while (T.after.length) await T.after.shift()();
}

// ── Settings and today's spend ──────────────────────────────────────────────

/** The two switches as they were before the run, put back at the end. */
let switchesBefore = null;
let spendBefore = null;
let BASE_ROWS = [];
const stored = (key) => BASE_ROWS.find((r) => r.key === key)?.value ?? {};
async function setSwitch(key, value) {
  await pool.query(
    `INSERT INTO enrich_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify({ ...stored(key), ...value })]
  );
}
/** The stored settings with some keys replaced: what a worked row gets (the database's rows stay as they are). */
const settingsWith = (over = {}) =>
  settingsFrom(BASE_ROWS.filter((r) => !(r.key in over)).concat(Object.entries(over).map(([key, value]) => ({ key, value }))));
async function ledger() {
  const rows = await all(`SELECT kind, used FROM enrich_spend_daily WHERE day = ${TODAY} AND kind = ANY($1::text[])`, [[...VENDOR_SPEND_KINDS]]);
  return Object.fromEntries(VENDOR_SPEND_KINDS.map((k) => [k, Number(rows.find((r) => r.kind === k)?.used ?? 0)]));
}
/** What the worker hands a People row here: room for each vendor's calls today, every other switch as stored (off). */
async function workSettings() {
  const led = await ledger();
  return settingsWith({
    spend_caps: { ...stored("spend_caps"), vendor_calls_per_day: Object.fromEntries(VENDOR_CAP_KEYS.map((k) => [k, led[vendorKind(k)] + 100])) },
  });
}

// ── Rows ────────────────────────────────────────────────────────────────────

/** A row with done cells (values as stored: text, booleans or vendor answers). */
async function addRow(tableId, key, cells = {}, { status = "done", sourceId = null } = {}) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO enrich_rows (table_id, source_id, row_key, run_status, finished_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [tableId, sourceId, key, status]
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
const cellOf = (rowId, key) => one(`SELECT status, value, display, note FROM enrich_cells WHERE row_id = $1 AND column_key = $2`, [rowId, key]);
const cellsOf = async (rowId) => Object.fromEntries((await all(`SELECT column_key, value FROM enrich_cells WHERE row_id = $1`, [rowId])).map((c) => [c.column_key, c.value]));
const statusOf = async (rowId) => (await one(`SELECT run_status FROM enrich_rows WHERE id = $1`, [rowId]))?.run_status ?? null;
const leadOf = (email) => one(`SELECT email, source, validation_status, question, tags FROM leads WHERE email = $1`, [email]);
const pipelineTables = async (tag) => (await all(`SELECT kind, id FROM enrich_tables WHERE client_tag = $1 AND template IS NOT NULL`, [tag]));
const progressOf = async (runId) => (await one(`SELECT progress -> 'no_email' AS p FROM aiark_runs WHERE id = $1`, [runId]))?.p ?? null;

// ── A. Verdicts (pure) ──────────────────────────────────────────────────────

function partA() {
  section("A1. A person's verdict, every source of P#55 in its order");
  const addr = "pat.lee@acme.prtest.example";
  const base = { use_work_email: addr };
  const fm = { email: addr, contact: { name: "Pat Lee", domain: "acme.prtest.example", email: addr } };
  const rows = [
    ["P#46 Findymail by name", { find_work_email_findymail: fm }, ["findymail", "findymail", null], "found by Findymail"],
    ["P#47 Prospeo by name, VERIFIED", { find_work_email_prospeo: { email: addr, status: "VERIFIED", person: {} } }, ["prospeo", "prospeo", "valid"], "found by Prospeo"],
    ["P#47 Prospeo, verified in lower case", { find_work_email_prospeo: { email: addr, status: "verified" } }, ["prospeo", "prospeo", "valid"], "found by Prospeo"],
    ["P#47 Prospeo, another status", { find_work_email_prospeo: { email: addr, status: "CATCH_ALL" } }, ["prospeo", "prospeo", null], "found by Prospeo"],
    ["P#47 Prospeo, no status", { find_work_email_prospeo: { email: addr, status: null } }, ["prospeo", "prospeo", null], "found by Prospeo"],
    ["P#48 Anymail Finder, its own valid", { find_work_email_anymail_finder: { results: { email: addr, validation: "VALID" } } }, ["anymail_finder", "anymail_finder", "valid"], "found by Anymail Finder"],
    ["P#49 Enrichley on Anymail Finder's address, ok",
      { find_work_email_anymail_finder: { results: { email: addr, validation: "risky" } }, validate_email_anymail_finder_find_work_email: { email: addr, valid: true, result: "ok" } },
      ["anymail_finder", "enrichley", "valid"], "found by Anymail Finder, approved by Enrichley"],
    ["P#49 Enrichley, catch_all_validated", { validate_email_anymail_finder_find_work_email: { email: addr, valid: true, result: "catch_all_validated" } },
      ["anymail_finder", "enrichley", "catch_all"], "found by Anymail Finder, approved by Enrichley"],
    ["P#9 approved by Reoon (P#12)", { email: addr, reoon_stamp_of_approval: true }, [null, "reoon", "valid"], ""],
    ["P#9 approved by Enrichley (P#14, P#13 catch_all)", { email: addr, enrichly_stamp_of_approval: true, enrichly_validation: { email: addr, valid: true, result: "catch_all" } },
      [null, "enrichley", "catch_all"], "approved by Enrichley"],
    ["P#9 approved by Enrichley (P#13 ok)", { email: addr, enrichly_stamp_of_approval: true, enrichly_validation: { email: addr, valid: true, result: "ok" } },
      [null, "enrichley", "valid"], "approved by Enrichley"],
    ["P#51 Findymail by LinkedIn", { find_work_email_from_linkedin_url_findymail: fm }, ["findymail", "findymail", null], "found by Findymail"],
    ["P#52 Prospeo by LinkedIn, VERIFIED", { find_work_email_and_enrich_person_from_linkedin_url: { full_name: "Pat Lee", email: { email: addr, status: "VERIFIED", revealed: true } } },
      ["prospeo", "prospeo", "valid"], "found by Prospeo"],
    ["P#52 Prospeo by LinkedIn, unverified", { find_work_email_and_enrich_person_from_linkedin_url: { email: { email: addr, status: "UNVERIFIED" } } }, ["prospeo", "prospeo", null], "found by Prospeo"],
    ["P#54 Enrichley on Anymail Finder's LinkedIn address", { validate_email_anymail_finder_from_linkedin: { email: addr, valid: true, result: "ok" } },
      ["anymail_finder", "enrichley", "valid"], "found by Anymail Finder, approved by Enrichley"],
  ];
  for (const [name, cells, [found, approved, status], words] of rows) {
    const v = personVerdict({ ...base, ...cells });
    check(`${name}: ${found ?? "nobody"} found, ${approved} approved, status ${status ?? "none"}, source "${words}"`,
      v?.address === addr && v.found_by === found && v.approved_by === approved && v.status === status && verdictSource(v) === words, JSON.stringify(v));
    const only = Object.fromEntries(Object.entries({ ...base, ...cells }).filter(([k]) => VERDICT_CELLS.person.includes(k)));
    check(`... VERDICT_CELLS.person holds every cell it read`, same(personVerdict(only), v));
  }
  check("P#55's order: Findymail's answer before Reoon's approval of the same address", personVerdict({ ...base, find_work_email_findymail: fm, email: addr, reoon_stamp_of_approval: true })?.found_by === "findymail");
  check("... Reoon's approval of AI Ark's address before Findymail by LinkedIn", personVerdict({ ...base, email: addr, reoon_stamp_of_approval: true, find_work_email_from_linkedin_url_findymail: fm })?.approved_by === "reoon");
  check("trimmed and in any case: a source's address matches the promoted one", personVerdict({ use_work_email: ` ${addr.toUpperCase()} `, find_work_email_findymail: { email: addr } })?.address === addr &&
    personVerdict({ use_work_email: addr, find_work_email_findymail: { email: ` ${addr.toUpperCase()}` } })?.found_by === "findymail");

  section("A2. Untraceable: held back (null)");
  const other = "someone.else@acme.prtest.example";
  const none = [
    ["no address", { find_work_email_findymail: fm }],
    ["a finder's answer for another address", { ...base, find_work_email_findymail: { email: other } }],
    ["Reoon approved AI Ark's other address", { ...base, email: other, reoon_stamp_of_approval: true }],
    ["Reoon's check said no", { ...base, email: addr, reoon_stamp_of_approval: false }],
    ["Anymail Finder's own answer not valid, and no Enrichley check", { ...base, find_work_email_anymail_finder: { results: { email: addr, validation: "risky" } } }],
    ["Enrichley said not valid", { ...base, validate_email_anymail_finder_find_work_email: { email: addr, valid: false, result: "invalid" } }],
    ["a finder's answer as text, not its object", { ...base, find_work_email_findymail: addr }],
    ["Reoon's stamp as the word true", { ...base, email: addr, reoon_stamp_of_approval: "true" }],
    ["Enrichley's valid as the word true", { ...base, validate_email_anymail_finder_find_work_email: { email: addr, valid: "true" } }],
    ["an address as a number", { use_work_email: 12, find_work_email_findymail: { email: 12 } }],
  ];
  for (const [name, cells] of none) check(`${name}: null`, personVerdict(cells) === null, JSON.stringify(personVerdict(cells)));
  check("no cells at all: null", personVerdict(null) === null && inboxVerdict(undefined) === null);

  section("A3. An inbox's verdict, Enrichley's status, the source words");
  const g = "info@acme.prtest.example";
  check("Reoon's stamp (G#40): reoon, valid, source unchanged", same(inboxVerdict({ general_email: ` ${g} `, reoon_stamp_of_approval: true }), { address: g, found_by: null, approved_by: "reoon", status: "valid" }) &&
    verdictSource(inboxVerdict({ general_email: g, reoon_stamp_of_approval: true })) === "");
  const ge = inboxVerdict({ general_email: g, reoon_stamp_of_approval: false, enrichly_stamp_of_approval: true, enrichly_validation: { valid: true, result: "catch_all_validated" } });
  check("Enrichley's stamp (G#42): enrichley, catch_all (G#41), approved by Enrichley", same(ge, { address: g, found_by: null, approved_by: "enrichley", status: "catch_all" }) && verdictSource(ge) === "approved by Enrichley");
  check("neither stamp, or no address: null", inboxVerdict({ general_email: g, reoon_stamp_of_approval: false }) === null && inboxVerdict({ reoon_stamp_of_approval: true }) === null);
  check("enrichleyStatus: catch_all_validated and catch_all are catch_all, ok is valid, not valid or not an answer is null",
    enrichleyStatus({ valid: true, result: "catch_all_validated" }) === "catch_all" && enrichleyStatus({ valid: true, result: "catch_all" }) === "catch_all" &&
      enrichleyStatus({ valid: true, result: "ok" }) === "valid" && enrichleyStatus({ valid: true }) === "valid" && enrichleyStatus({ valid: false, result: "ok" }) === null &&
      enrichleyStatus(null) === null && enrichleyStatus("ok") === null && enrichleyStatus({ valid: "true", result: "ok" }) === null);
  check("verdictSource: nothing for no verdict; a finder approving its own address is named once",
    verdictSource(null) === "" && verdictSource({ address: g, found_by: "findymail", approved_by: "findymail", status: null }) === "found by Findymail");
  check("VERDICT_CELLS: the inbox's four; promotion reads them all", same([...VERDICT_CELLS.general], ["general_email", "reoon_stamp_of_approval", "enrichly_stamp_of_approval", "enrichly_validation"]) &&
    VERDICT_CELLS.general.every((k) => PROMOTE_CELLS.general.includes(k)) && VERDICT_CELLS.person.every((k) => PROMOTE_CELLS.person.includes(k)) &&
    new Set(PROMOTE_CELLS.person).size === PROMOTE_CELLS.person.length);

  section("A4. The lead rows promotion builds");
  const inboxCells = (over = {}) => ({
    general_email: g, use_first_name: "Acme Prtest Team", use_last_name: "(General Email)", normalized_company_name: "Acme Prtest", company: "Acme Prtest LLC",
    use_city: "Springfield", use_state: "IL", question: "Made-up question?", exclusion_large_company_check: true, ...over,
  });
  const personCells = (over = {}) => ({
    use_work_email: addr, use_first_name: "Pat", use_last_name: "Lee", full_name: "Pat Lee", title: "Office Manager", company: "Acme Prtest LLC",
    question: "Made-up question?", exclusion_large_company_check: true, ...over,
  });
  const reoonInbox = inboxLeadRow(inboxCells({ reoon_stamp_of_approval: true }));
  check("a Reoon-approved inbox: valid, the label alone (exactly as before)", reoonInbox.hold === null && reoonInbox.lead.validation_status === "valid" && reoonInbox.lead.source === PROMOTE_SOURCE);
  const reoonPerson = personLeadRow(personCells({ email: addr, reoon_stamp_of_approval: true }));
  check("a Reoon-approved person: valid, the label alone (exactly as before)", reoonPerson.hold === null && reoonPerson.lead.validation_status === "valid" && reoonPerson.lead.source === PROMOTE_SOURCE);
  const enInbox = inboxLeadRow(inboxCells({ enrichly_stamp_of_approval: true, enrichly_validation: { valid: true, result: "catch_all" } }), { label: "Made-up label" });
  check("an Enrichley-approved inbox: catch_all, the label then \"approved by Enrichley\"", enInbox.hold === null && enInbox.lead.validation_status === "catch_all" &&
    enInbox.lead.source === "Made-up label, approved by Enrichley");
  const fmPerson = personLeadRow(personCells({ find_work_email_findymail: fm }));
  check("a person Findymail found: no status (the import writes NULL), \"found by Findymail\"", fmPerson.hold === null && fmPerson.lead.validation_status === "" &&
    fmPerson.lead.source === `${PROMOTE_SOURCE}, found by Findymail`);
  const vs = Object.fromEntries(PROMOTE_COLUMNS.map(([, k], i) => [k, fmPerson.row[i]]));
  check("... the import row carries both", vs.validation_status === "" && vs.source === `${PROMOTE_SOURCE}, found by Findymail`);
  check("held back with the new words: untraceable; the first name holds undefined",
    personLeadRow(personCells({ email: other, reoon_stamp_of_approval: true })).hold === HOLD.validation &&
      inboxLeadRow(inboxCells({ reoon_stamp_of_approval: false })).hold === HOLD.validation &&
      inboxLeadRow(inboxCells({ reoon_stamp_of_approval: true, use_first_name: "undefined Team" })).hold === HOLD.first_name &&
      HOLD.validation === "No approval this address can be traced to (Reoon, Enrichley or an email finder's own answer)" &&
      HOLD.first_name === "The first name holds \"undefined\": the company-name step (G#14) has not given a name");

  section("A5. A pull's person as People inputs, the Source");
  const created = new Date("2026-11-20T23:30:00Z");
  check("pullSourceLabel: the pull's UTC day", pullSourceLabel({ created_at: created }) === "AI Ark pull 2026-11-20: no email" && pullSourceLabel({ created_at: "2026-11-21T01:00:00Z" }) === "AI Ark pull 2026-11-21: no email" &&
    pullSourceLabel(null).startsWith("AI Ark pull"));
  const inputs = pullPeopleInputs({
    full_name: "Pat Lee", first_name: "Pat", last_name: "Lee", title: "Office Manager", seniority: "manager", department: "Operations", company: "Acme Prtest",
    domain: "https://www.Acme.prtest.example/about", city: "Springfield", state: "Illinois", country: "United States", linkedin: "https://linkedin.prtest.example/in/pat",
    aiark_id: "p-1", email_status: "", email_domain_type: "", pulled_before: "", email: "", company_industry: "Facilities",
  }, { tag: " prtest_b ", label: "AI Ark pull 2026-11-20: no email" });
  check("the inputs: the source object, the tag, the domain as the website, the place written and the person's own, found_by aiark, stage no_email; no company row or email",
    same(inputs, {
      find_people_from_linkedin_company_url: {
        name: "Pat Lee", last_name: "Lee", latest_experience_title: "Office Manager", latest_experience_company: "Acme Prtest", url: "https://linkedin.prtest.example/in/pat",
        location_name: "Springfield, Illinois, United States", domain: "acme.prtest.example",
      },
      client_tag: "PRTEST_B", company_website: "acme.prtest.example", written_city: "Springfield", written_state: "Illinois", person_aiark_id: "p-1", found_by: "aiark", stage: "no_email",
      person_first_name: "Pat", person_last_name: "Lee", seniority: "manager", department: "Operations", person_city: "Springfield", person_state: "Illinois",
      person_country: "United States", source: "AI Ark pull 2026-11-20: no email",
    }), JSON.stringify(inputs));
  check("a name from first and last when the full name is missing; the source object kept whole when empty",
    pullPeopleInputs({ first_name: "Pat", last_name: "Lee" }, { tag: TB, label: "x" }).find_people_from_linkedin_company_url.name === "Pat Lee" &&
      same(pullPeopleInputs({}, { tag: TB, label: "x" }).find_people_from_linkedin_company_url, { name: "", last_name: "", latest_experience_title: "", latest_experience_company: "", url: "", location_name: "", domain: "" }));
  check("PULL_CELLS are inputs of every run table", PULL_CELLS.every((k) => RUN_COLUMNS.some((c) => c.key === k && c.kind === "input")));
}

// ── B. Promotion end to end ─────────────────────────────────────────────────

async function partB() {
  section("B. Promotion through the promote route and the real import");
  const tables = await inTx(pool, async (c) => {
    await lockPipelineTables(c, TA);
    return ensurePipelineTables(c, TA, { settings: settingsWith() });
  });
  const companyRow = await addRow(tables.companies, `aiark:prtest-company-${RUN}`, { company: "Acme Prtest LLC", use_domain: dom("acme") });
  await pool.query(
    `INSERT INTO enrich_companies (row_id, table_id, client_tag, source, company, domain, city, state, industry, passes, listed, found_at, template, outcome, never_contact, company_key)
     VALUES ($1, $2, $3, 'ai_ark', 'Acme Prtest LLC', $4, 'Springfield', 'IL', 'Commercial cleaning', true, true, now(), 'companies_v2', 'General and people emails', false, $5)`,
    [companyRow, tables.companies, TA, dom("acme"), `${dom("acme")}|IL|springfield`]
  );
  const common = {
    normalized_company_name: "Acme Prtest", company: "Acme Prtest LLC", use_city: "Springfield", use_state: "IL", use_domain: dom("acme"),
    question: "Made-up question for the round?", exclusion_large_company_check: true,
  };
  const inbox = (email, over) => ({ general_email: email, use_first_name: "Acme Prtest Team", use_last_name: "(General Email)", ...common, ...over });
  const person = (email, first, over) => ({
    use_work_email: email, use_first_name: first, use_last_name: "Prtestson", full_name: `${first} Prtestson`, title: "Office Manager", seniority: "manager",
    person_country: "US", ...common, ...over,
  });
  /** A contact as the worker leaves it: its row and cells, and its enrich_contacts summary (approved, usable, with a question). */
  const contact = async (kind, email, cells) => {
    const table = kind === "general" ? tables.inboxes : tables.people;
    const row = await addRow(table, `w:${companyRow}:${email}`, { ...cells, company_row: String(companyRow) });
    await pool.query(
      `INSERT INTO enrich_contacts (row_id, company_row_id, table_id, client_tag, kind, email, verdict, usable, held, has_question, outcome, full_name, title)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved', true, false, true, $7, $8, $9)`,
      [row, companyRow, table, TA, kind, email, kind === "general" ? "Approved" : "Approved email", cells.full_name ?? null, cells.title ?? null]
    );
    return row;
  };
  const E = {
    reoon: at("reo"), enrichley: at("office"), findymail: at("fiona"), anymail: at("amy"), prospeo: at("paula"), untraced: at("ursula"),
  };
  const C = {
    reoon: await contact("person", E.reoon, person(E.reoon, "Rita", { email: E.reoon, reoon_stamp_of_approval: true })),
    enrichley: await contact("general", E.enrichley, inbox(E.enrichley, {
      reoon_stamp_of_approval: false, enrichly_stamp_of_approval: true, enrichly_validation: { email: E.enrichley, valid: true, result: "catch_all_validated" },
    })),
    findymail: await contact("person", E.findymail, person(E.findymail, "Fiona", { find_work_email_findymail: { email: E.findymail, contact: { email: E.findymail } } })),
    anymail: await contact("person", E.anymail, person(E.anymail, "Amy", {
      find_work_email_anymail_finder: { success: true, results: { email: E.anymail, validation: "risky" } },
      validate_email_anymail_finder_find_work_email: { email: E.anymail, valid: true, result: "ok" },
    })),
    prospeo: await contact("person", E.prospeo, person(E.prospeo, "Paula", { find_work_email_prospeo: { email: E.prospeo, status: "VERIFIED", person: {} } })),
    untraced: await contact("person", E.untraced, person(E.untraced, "Ursula", { email: at("other"), reoon_stamp_of_approval: true })),
  };
  await setSwitch("promotion", { promote_to_leads: true, tags: [TA] });
  const { POST: promote } = await route("companies/promote");
  T.role = "manager";
  const r1 = await call(promote, { body: { tag: TA } });
  await drainAfter();
  check("a round: one inbox and four people taken, the untraceable person held back with the new words",
    r1.status === 202 && r1.body.adding === 5 && r1.body.batches?.length === 2 && r1.body.held?.[HOLD.validation] === 1 && Object.keys(r1.body.held).length === 1,
    JSON.stringify(r1.body));
  const states = Object.fromEntries((await all(`SELECT row_id, promote_state FROM enrich_contacts WHERE client_tag = $1`, [TA])).map((r) => [Number(r.row_id), r.promote_state]));
  check("every taken contact settles Added, though its source differs from the batch's label (finishPromote compares each contact's own)",
    ["reoon", "enrichley", "findymail", "anymail", "prospeo"].every((k) => states[C[k]] === "added") && states[C.untraced] === null, JSON.stringify(states));
  const L = {};
  for (const k of Object.keys(E)) L[k] = await leadOf(E[k]);
  console.log(`    leads made: ${Object.entries(L).map(([k, l]) => `${k}: ${l ? `source "${l.source}", status ${l.validation_status ?? "NULL"}` : "none"}`).join("; ")}`);
  check("Reoon's person: source and status exactly as before", L.reoon?.source === PROMOTE_SOURCE && L.reoon.validation_status === "valid", JSON.stringify(L.reoon));
  check("Enrichley's inbox: catch_all, \", approved by Enrichley\"", L.enrichley?.source === `${PROMOTE_SOURCE}, approved by Enrichley` && L.enrichley.validation_status === "catch_all", JSON.stringify(L.enrichley));
  check("Findymail's person: no status (NULL), \", found by Findymail\"", L.findymail?.source === `${PROMOTE_SOURCE}, found by Findymail` && L.findymail.validation_status === null, JSON.stringify(L.findymail));
  check("Anymail Finder's person Enrichley approved: valid, \", found by Anymail Finder, approved by Enrichley\"",
    L.anymail?.source === `${PROMOTE_SOURCE}, found by Anymail Finder, approved by Enrichley` && L.anymail.validation_status === "valid", JSON.stringify(L.anymail));
  check("Prospeo's VERIFIED person: valid, \", found by Prospeo\"", L.prospeo?.source === `${PROMOTE_SOURCE}, found by Prospeo` && L.prospeo.validation_status === "valid", JSON.stringify(L.prospeo));
  check("the untraceable address made no lead", L.untraced == null);
  check("each lead carries the question and the client's tag", ["reoon", "enrichley", "findymail", "anymail", "prospeo"].every((k) => L[k]?.question === "Made-up question for the round?" && String(L[k].tags ?? "").includes(TA)));
  const added = await cellOf(C.findymail, "add_to_database");
  check("an added contact's cell: Added, its note naming its own source", added?.status === "done" && added.display === "Added" && added.value.added === true &&
    added.note === `Added to the lead database with source ${PROMOTE_SOURCE}, found by Findymail, tagged with the client.`, JSON.stringify(added));
  const heldCell = await cellOf(C.untraced, "add_to_database");
  check("the untraceable contact's cell: Held back, with the new words", heldCell?.status === "skipped" && heldCell.display === "Held back" && heldCell.value.why === HOLD.validation &&
    heldCell.note.includes(HOLD.validation), JSON.stringify(heldCell));
  const batches = await all(`SELECT status, source_label, inserted_rows FROM upload_batches WHERE id IN (SELECT batch_id FROM enrich_contacts WHERE client_tag = $1 AND batch_id IS NOT NULL)`, [TA]);
  check("the two batches are complete, the pipeline's label on each, five leads inserted", batches.length === 2 && batches.every((b) => b.status === "complete" && b.source_label === PROMOTE_SOURCE) &&
    batches.reduce((n, b) => n + b.inserted_rows, 0) === 5, JSON.stringify(batches));
  const leads1 = (await one(`SELECT count(*)::int AS n FROM leads WHERE email LIKE $1`, [`%.${HOST}`])).n;
  const r2 = await call(promote, { body: { tag: TA } });
  await drainAfter();
  const leads2 = (await one(`SELECT count(*)::int AS n FROM leads WHERE email LIKE $1`, [`%.${HOST}`])).n;
  check("a second round adds nothing (the untraceable person held back again)", r2.status === 202 && r2.body.adding === 0 && leads2 === leads1 && r2.body.held?.[HOLD.validation] === 1,
    JSON.stringify(r2.body));
  check("the rounds are in the audit log", T.audits.filter((a) => a.action === "company_promote" && a.details.startsWith(TA)).length === 2);
  await setSwitch("promotion", { promote_to_leads: switchesBefore.promotion.value?.promote_to_leads ?? false, tags: switchesBefore.promotion.value?.tags ?? [] });
}

// ── C. The copy ─────────────────────────────────────────────────────────────

/** A made-up AI Ark run of PRTEST_B with its own table (RUN_COLUMNS), as the run route makes it; finished unless told. */
async function newRun({ mode = "live", status = "done", finished = true } = {}) {
  const run = await inTx(pool, (c) => createRun(c, { tag: TB, mode, strategy: "export", size: 10, filters: {}, requests: [{}] }));
  await pool.query(`UPDATE aiark_runs SET status = $2, finished_at = CASE WHEN $3::boolean THEN now() END WHERE id = $1`, [run.id, status, finished]);
  return (await one(`SELECT * FROM aiark_runs WHERE id = $1`, [run.id]));
}
/** A pull row as a run leaves it, worked: AI Ark's inputs, the verdict and the Outcome. */
async function pullRow(run, n, { outcome = "No email", id = pid(n), first, last = "Prtestson", email = "", status = "", domainType = "", company = `Acme Prtest ${RUN}` } = {}) {
  const verdict = email ? (status === "VALID" ? (domainType === "CATCH_ALL" ? "Catch-all" : "Valid") : "Invalid") : status === "PENDING" ? "Pending" : "Not found";
  const cells = {
    full_name: `${first} ${last}`, first_name: first, last_name: last, title: "Office Manager", seniority: "manager", department: "Operations", company,
    domain: dom("acme"), company_industry: "Facilities Services", city: "Springfield", state: "Illinois", country: "United States",
    linkedin: `https://linkedin.${HOST}/in/${first.toLowerCase()}-${RUN}`, ...(id ? { aiark_id: id } : {}),
    ...(email ? { email } : {}), ...(status ? { email_status: status } : {}), ...(domainType ? { email_domain_type: domainType } : {}),
    email_verdict: verdict, outcome,
  };
  return addRow(run.table_id, `prtest:${RUN}:${n}`, cells, { sourceId: run.source_id });
}

async function partC() {
  section("C1. Off People runs: nothing copied, no table made");
  const R1 = await newRun();
  const P = {
    n1: await pullRow(R1, "n1", { first: "Nell" }), //                       its People row is deleted later
    n2: await pullRow(R1, "n2", { first: "Nia" }), //                        Findymail finds her
    ra: await pullRow(R1, "ra", { first: "Rae", outcome: "Ready to add", email: at("rae"), status: "VALID", domainType: "SMTP" }),
    pe: await pullRow(R1, "pe", { first: "Pem", outcome: "Email still being checked", status: "PENDING" }),
    n3: await pullRow(R1, "n3", { first: "Noor" }), //                       nobody finds her
    nk: await pullRow(R1, "nk", { first: "Kit" }), //                        another run bought her: her People row is followed
    ni: await pullRow(R1, "ni", { first: "Ivo", id: null }), //              no AI Ark id
  };
  // The registry rows a pull leaves (emailFound writes the found address there).
  for (const k of ["n2", "nk"]) {
    await pool.query(`INSERT INTO aiark_people (person_id, run_id, row_id) VALUES ($1, $2, $3)`, [pid(k), R1.id, P[k]]);
  }
  const leads0 = (await one(`SELECT count(*)::int AS n FROM leads`)).n;
  const calls0 = JSON.stringify(net.calls);
  const off = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [R1.id] });
  check("PRTEST_B off People runs: the run is not taken, nothing is copied, no pipeline table is made",
    same(off, { runs: 0, copied: 0, already: 0, waiting: 0 }) && (await pipelineTables(TB)).length === 0 &&
      (await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key = $2`, [R1.table_id, FIND_EMAIL_COLUMN])).n === 0 &&
      (await progressOf(R1.id)) === null, JSON.stringify(off));
  check("the run's state: five people with no email, none sent", same(await addState(pool, R1.table_id), { ready: 1, added: 0, skipped: 0, adding: 0, failed: 0, pipeline: 5, sent: 0 }),
    JSON.stringify(await addState(pool, R1.table_id)));

  section("C2. On: the client's tables made, the people with no email copied held");
  await setSwitch("people_pipeline", { enabled: true, tags: [TB] });
  const first = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [R1.id], chunk: 3, maxChunks: 1 });
  const tables = Object.fromEntries((await pipelineTables(TB)).map((t) => [t.kind, t.id]));
  check("one chunk of three: the client's three pipeline tables made, three People rows copied", same(first, { runs: 1, copied: 3, already: 0, waiting: 0 }) &&
    Boolean(tables.people && tables.companies && tables.inboxes), JSON.stringify({ first, tables }));
  const peopleRow = async (k) => one(`SELECT id, run_status, source_id, search_text FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tables.people, aiarkPersonRowKey(pid(k))]);
  const Q = { n1: await peopleRow("n1"), n2: await peopleRow("n2"), n3: await peopleRow("n3") };
  check("the first three people with no email, in id order, held", ["n1", "n2", "n3"].every((k) => Q[k]?.run_status === "held"), JSON.stringify(Q));
  const label = pullSourceLabel(R1);
  const inputKeys = new Set((await all(`SELECT key FROM enrich_columns WHERE table_id = $1 AND kind = 'input'`, [tables.people])).map((r) => r.key));
  const pullCells = Object.fromEntries((await all(`SELECT column_key, value #>> '{}' AS v FROM enrich_cells WHERE row_id = $1`, [P.n2])).map((c) => [c.column_key, c.v]));
  const want = Object.fromEntries(Object.entries(pullPeopleInputs(pullCells, { tag: TB, label })).filter(([k]) => inputKeys.has(k)));
  const got = await cellsOf(Q.n2.id);
  check("a copied row's cells are its People inputs (input columns only): the source object as an object, no company row, no email",
    same(Object.keys(got).sort(), Object.keys(want).sort()) && Object.keys(want).every((k) => canon(got[k]) === canon(want[k])) && !("company_row" in got) && !("email" in got) &&
      typeof got.find_people_from_linkedin_company_url === "object" && got.found_by === "aiark" && got.stage === "no_email" && got.source === label,
    JSON.stringify({ got, want }));
  check("... and its search text, as people runs make it", Q.n2.search_text === `nia prtestson office manager acme prtest ${RUN.toLowerCase()} springfield illinois`, Q.n2.search_text);
  const src = await one(`SELECT kind, external_id, label, received, created, duplicates, meta FROM enrich_sources WHERE id = $1`, [Q.n1.source_id]);
  check("one source row for the run and People table: ai_ark, pull:<run id>, the pull's label, counts", src?.kind === "ai_ark" && src.external_id === `pull:${R1.id}` &&
    src.label === label && src.received === 3 && src.created === 3 && src.duplicates === 0 && src.meta.run_id === R1.id && Q.n2.source_id === Q.n1.source_id, JSON.stringify(src));
  const sent = await cellOf(P.n1, FIND_EMAIL_COLUMN);
  check("the pull row's find_email cell: sent, with its People row", sent?.status === "done" && sent.value.state === "sent" && sent.value.people_table_id === tables.people &&
    sent.value.people_row_id === Number(Q.n1.id) && Boolean(sent.value.at) && sent.display === "Sent to the People table" &&
    sent.note === "Copied to the client's People (pipeline) table, where the email finders look for an address.", JSON.stringify(sent));
  check("not sent: Ready to add, Email still being checked, and the rest of the run not reached yet",
    (await Promise.all(["ra", "pe", "nk", "ni"].map((k) => cellOf(P[k], FIND_EMAIL_COLUMN)))).every((c) => !c));
  const p1 = await progressOf(R1.id);
  check("progress.no_email: copying, 3 copied, 3 open", p1?.state === "copying" && p1.copied === 3 && p1.already === 0 && p1.open === 3 && Boolean(p1.at), JSON.stringify(p1));
  check("nothing queued, paid or added: the pull's rows done, no lead written, no network call", (await one(`SELECT count(*)::int AS n FROM leads`)).n === leads0 &&
    JSON.stringify(net.calls) === calls0 && (await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = $1 AND run_status <> 'done'`, [R1.table_id])).n === 0);
  check("the run's state: five with no email, three sent to the People table", (await addState(pool, R1.table_id)).sent === 3);

  // The held row as the Clay tab shows it.
  T.role = "manager";
  const { GET: cellGet } = await route("enrich/cell");
  const cr = await call(cellGet, { query: { row: String(Q.n1.id), col: "source" } });
  check("the cell route: a held People row from a pull says where it came from (the cell panel's pull note reads it)",
    cr.status === 200 && cr.body.row.run_status === "held" && cr.body.row.template === "people_v1" && cr.body.row.source_label === label && label.startsWith("AI Ark pull"),
    JSON.stringify(cr.body?.row));

  section("C3. The rest: a person another run bought is followed; no AI Ark id is not copied; done");
  // Another run bought Kit since: her People row, done, with an address Anymail Finder found and Enrichley approved, and promotion's cell.
  const kitMail = at("kit");
  const kit = await addRow(tables.people, aiarkPersonRowKey(pid("nk")), {
    found_by: "aiark", stage: "bought", source: "AI Ark people run", person_outcome: "Approved email", use_work_email: kitMail,
    find_work_email_anymail_finder: { success: true, results: { email: kitMail, validation: "risky" } },
    validate_email_anymail_finder_find_work_email: { email: kitMail, valid: true, result: "catch_all" },
  });
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display, note) VALUES ($1, 'add_to_database', $2, 'skipped', $3::jsonb, 'Held back', 'Made up: promotion held it back')`,
    [kit, tables.people, JSON.stringify({ added: false, reason: "held_back", why: "made up", email: kitMail })]
  );
  const second = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [R1.id], chunk: 3, maxChunks: 5 });
  check("the second call: Kit followed, Ivo not copied, the run done", same(second, { runs: 1, copied: 0, already: 1, waiting: 0 }), JSON.stringify(second));
  const kc = await cellOf(P.nk, FIND_EMAIL_COLUMN);
  check("Kit: In the People table already, following the row another run made", kc?.value.state === "sent" && kc.value.people_row_id === kit && kc.display === "In the People table already" &&
    kc.note.includes("followed"), JSON.stringify(kc));
  const ic = await cellOf(P.ni, FIND_EMAIL_COLUMN);
  check("Ivo: No AI Ark id, never copied", ic?.status === "empty" && ic.value.state === "no_id" && ic.display === "No AI Ark id", JSON.stringify(ic));
  const p2 = await progressOf(R1.id);
  const src2 = await one(`SELECT received, created, duplicates FROM enrich_sources WHERE id = $1`, [Q.n1.source_id]);
  check("progress: done, 3 copied, 1 followed, 4 open; the source row counts 4 received, 3 created, 1 duplicate",
    p2?.state === "done" && p2.copied === 3 && p2.already === 1 && p2.open === 4 && src2.received === 4 && src2.created === 3 && src2.duplicates === 1, JSON.stringify({ p2, src2 }));
  const third = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [R1.id] });
  check("a third call copies nothing: the run is done", same(third, { runs: 0, copied: 0, already: 0, waiting: 0 }), JSON.stringify(third));

  section("C4. A deleted People row is not put back");
  await pool.query(`DELETE FROM enrich_rows WHERE id = $1`, [Q.n1.id]);
  await pool.query(`UPDATE aiark_runs SET progress = jsonb_set(progress, '{no_email,state}', '"copying"') WHERE id = $1`, [R1.id]);
  const again = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [R1.id] });
  check("taken again (made to look unfinished), it copies nobody: Nell's find_email cell keeps her out", again.copied === 0 && again.already === 0 && !(await peopleRow("n1")) &&
    (await progressOf(R1.id))?.state === "done", JSON.stringify(again));

  section("C5. Runs that wait, runs never taken, a cancelled run");
  const R2 = await newRun();
  const w1 = await pullRow(R2, "w1", { first: "Wyn" });
  const refuse = async () => {
    throw new OriginalsMissing("prtest_b", {});
  };
  const waits = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [R2.id], ensureTables: refuse });
  const p3 = await progressOf(R2.id);
  check("a client whose tables can't be made now: the run waits 10 minutes with the reason, nothing copied",
    same(waits, { runs: 0, copied: 0, already: 0, waiting: 1 }) && p3?.state === "waiting" && p3.reason === "originals_missing" &&
      new Date(p3.next_try_at).getTime() > Date.now() + 9 * 60_000 && !(await cellOf(w1, FIND_EMAIL_COLUMN)) && !(await peopleRow("w1")), JSON.stringify({ waits, p3 }));
  const soon = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [R2.id] });
  check("... and is not taken again before then", same(soon, { runs: 0, copied: 0, already: 0, waiting: 0 }));
  await pool.query(`UPDATE aiark_runs SET progress = jsonb_set(progress, '{no_email,next_try_at}', to_jsonb(now() - interval '1 minute')) WHERE id = $1`, [R2.id]);
  const later = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [R2.id] });
  check("... after it, with the tables in reach, it is copied", later.copied === 1 && (await peopleRow("w1"))?.run_status === "held" && (await progressOf(R2.id))?.state === "done", JSON.stringify(later));

  const demo = await newRun({ mode: "demo" });
  const d1 = await pullRow(demo, "d1", { first: "Dee" });
  const open = await newRun({ status: "running", finished: false });
  const o1 = await pullRow(open, "o1", { first: "Oda" });
  const busy = await newRun();
  const b1 = await pullRow(busy, "b1", { first: "Bo" });
  await addRow(busy.table_id, `prtest:${RUN}:b2`, { full_name: "Bea Prtestson", outcome: "No email" }, { status: "queued", sourceId: busy.source_id });
  const never = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [demo.id, open.id, busy.id] });
  check("never taken: a demo run, a run not finished, a run with a row still queued",
    same(never, { runs: 0, copied: 0, already: 0, waiting: 0 }) && !(await cellOf(d1, FIND_EMAIL_COLUMN)) && !(await cellOf(o1, FIND_EMAIL_COLUMN)) && !(await cellOf(b1, FIND_EMAIL_COLUMN)),
    JSON.stringify(never));
  const claimed = await newRun();
  const k1 = await pullRow(claimed, "k1", { first: "Kai" });
  await pool.query(`UPDATE aiark_runs SET claim_token = gen_random_uuid(), claimed_at = now() WHERE id = $1`, [claimed.id]);
  check("... nor one the run engine still holds (a cancel finishes it while a slice may be writing)",
    same(await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [claimed.id] }), { runs: 0, copied: 0, already: 0, waiting: 0 }) && !(await cellOf(k1, FIND_EMAIL_COLUMN)));
  const cancelled = await newRun({ status: "cancelled" });
  const c1 = await pullRow(cancelled, "c1", { first: "Cy" });
  const c2 = await pullRow(cancelled, "c2", { first: "Cass" });
  const c3 = await pullRow(cancelled, "c3", { first: "Cole" });
  const cx = await copyPullNoEmail(pool, { settings: settingsWith(), runIds: [cancelled.id] });
  const heldC = await Promise.all(["c1", "c2", "c3"].map(async (k) => (await peopleRow(k))?.run_status));
  check("a cancelled pull that finished is copied too (decision 11)", cx.copied === 3 && heldC.every((s) => s === "held"), JSON.stringify({ cx, heldC }));
  const anyOther = await one(
    `SELECT count(*)::int AS n FROM enrich_tables WHERE template IS NOT NULL AND NOT starts_with(client_tag, $1) AND created_at > now() - interval '1 hour'`, [PREFIX]
  );
  check("no other client got a pipeline table from the copy", anyOther.n === 0);
  return { R1, P, tables, kit, kitMail, R2, w1, cancelled, c1, c2, c3 };
}

// ── D. The release, the hand-back and the add ───────────────────────────────

async function partD({ R1, P, tables, kit, kitMail, R2, w1, cancelled, c1, c2, c3 }) {
  section("D1. The People release queues the copied rows (people_pipeline on for PRTEST_B)");
  const rel = await releaseHeldPeopleRows(pool);
  const peopleRow = async (k) => one(`SELECT id, run_status FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tables.people, aiarkPersonRowKey(pid(k))]);
  const Q = {
    n2: await peopleRow("n2"), n3: await peopleRow("n3"), w1: await peopleRow("w1"), c1: await peopleRow("c1"), c2: await peopleRow("c2"), c3: await peopleRow("c3"),
  };
  check("released: the six held rows queued", rel.released === 6 && Object.values(Q).every((q) => q?.run_status === "queued"), JSON.stringify({ rel, Q }));

  section("D2. Worked against the stubbed finders");
  const S = await workSettings();
  const nia = at("nia");
  net.vendors.findymail.set("Nia Prtestson", nia);
  net.vendors.findymail.set("Cy Prtestson", at("cy"));
  net.vendors.findymail.set("Cass Prtestson", at("cass"));
  const wN2 = await workRow(pool, net, Number(Q.n2.id), { env: KEYS, settings: S });
  check("Nia: Findymail finds her, Approved email, nothing written to enrich_contacts (no company row)",
    wN2.status === "done" && wN2.values.person_outcome === "Approved email" && wN2.values.use_work_email === nia && wN2.paid.findymail === 1 && wN2.projected?.written === false,
    JSON.stringify({ status: wN2.status, outcome: wN2.values.person_outcome, email: wN2.values.use_work_email, paid: wN2.paid, projected: wN2.projected }));
  const wN3 = await workRow(pool, net, Number(Q.n3.id), { env: KEYS, settings: S });
  check("Noor: nobody finds her: No email (AI Ark found none)", wN3.status === "done" && wN3.values.person_outcome === "No email (AI Ark found none)",
    JSON.stringify({ status: wN3.status, outcome: wN3.values.person_outcome }));
  // The question personalisation would write on Nia's row (its switch stays off here).
  await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display) VALUES ($1, 'question', $2, 'done', '"Made-up question for Nia?"', 'Made-up question for Nia?')
                    ON CONFLICT (row_id, column_key) DO UPDATE SET status = 'done', value = EXCLUDED.value, display = EXCLUDED.display`, [Q.n2.id, tables.people]);

  section("D3. The hand-back");
  const hb = await handBackFound(pool, { runIds: [R1.id] });
  check("two found (Nia, Kit), two closed (Noor, Nell's deleted row)", same(hb, { found: 2, closed: 2 }), JSON.stringify(hb));
  const fN2 = await cellOf(P.n2, FIND_EMAIL_COLUMN);
  check("Nia's find_email cell: found by Findymail, with the address", fN2?.value.state === "found" && fN2.value.email === nia && fN2.value.found_by === "findymail" &&
    fN2.value.approved_by === "findymail" && fN2.value.status === null && fN2.value.people_row_id === Number(Q.n2.id) && fN2.display === "Found by Findymail", JSON.stringify(fN2));
  const pullN2 = await cellsOf(P.n2);
  check("Nia's pull row takes the address and is queued: VALID, SMTP, who found it, the question (no status claimed: no cell)",
    (await statusOf(P.n2)) === "queued" && pullN2.email === nia && pullN2.email_status === "VALID" && pullN2.email_domain_type === "SMTP" &&
      pullN2.email_found_source === "found by Findymail" && !("email_found_status" in pullN2) && pullN2.question === "Made-up question for Nia?", JSON.stringify(pullN2));
  const addN2 = await cellOf(Q.n2.id, "add_to_database");
  check("Nia's People row: Sent to the AI Ark pull", addN2?.status === "done" && addN2.display === "Sent to the AI Ark pull" && addN2.value.reason === "aiark_pull" &&
    addN2.value.pull_row_id === P.n2 && addN2.value.pull_table_id === R1.table_id && addN2.value.email === nia && addN2.value.added === false, JSON.stringify(addN2));
  const pullNK = await cellsOf(P.nk);
  check("Kit (followed): found by Anymail Finder, approved by Enrichley, catch_all, CATCH_ALL", (await cellOf(P.nk, FIND_EMAIL_COLUMN))?.display === "Found by Anymail Finder" &&
    pullNK.email === kitMail && pullNK.email_domain_type === "CATCH_ALL" && pullNK.email_found_source === "found by Anymail Finder, approved by Enrichley" &&
    pullNK.email_found_status === "catch_all" && (await statusOf(P.nk)) === "queued", JSON.stringify(pullNK));
  check("... her People row keeps promotion's cell", (await cellOf(kit, "add_to_database"))?.display === "Held back");
  const fN3 = await cellOf(P.n3, FIND_EMAIL_COLUMN);
  check("Noor: closed with the People table's Outcome", fN3?.value.state === "closed" && fN3.display === "People table: No email (AI Ark found none)" && (await statusOf(P.n3)) === "done", JSON.stringify(fN3));
  const fN1 = await cellOf(P.n1, FIND_EMAIL_COLUMN);
  check("Nell: Removed from the People table", fN1?.value.state === "gone" && fN1.display === "Removed from the People table", JSON.stringify(fN1));
  const reg = await all(`SELECT person_id, email, email_status FROM aiark_people WHERE person_id = ANY($1::text[]) ORDER BY person_id`, [[pid("n2"), pid("nk")]]);
  check("the AI Ark registry takes the found addresses as VALID, as emailFound always wrote them", reg.length === 2 && reg.every((r) => r.email_status === "VALID") &&
    reg.some((r) => r.email === nia) && reg.some((r) => r.email === kitMail), JSON.stringify(reg));
  check("open recounted: none left for the run", (await progressOf(R1.id))?.open === 0);
  check("a second hand-back finds nothing to do", same(await handBackFound(pool, { runIds: [R1.id] }), { found: 0, closed: 0 }));

  section("D4. Turns: rows with no answer never take the place of rows with one; every run gets its turn");
  net.vendors.findymail.set("Cole Prtestson", at("cole"));
  net.vendors.findymail.set("Wyn Prtestson", at("wyn"));
  const wC2 = await workRow(pool, net, Number(Q.c2.id), { env: KEYS, settings: S });
  check("Cass found by Findymail; Cy's and Cole's People rows still queued", wC2.values.person_outcome === "Approved email" && (await statusOf(Q.c1.id)) === "queued" &&
    (await statusOf(Q.c3.id)) === "queued");
  const turn1 = await handBackFound(pool, { runIds: [R2.id, cancelled.id], runs: 1, limit: 1 });
  const turn2 = await handBackFound(pool, { runIds: [R2.id, cancelled.id], runs: 1, limit: 1 });
  check("one run a turn: first the older run (nothing to hand back yet: Wyn's row is queued), then the other, where Cass is handed back past Cy's queued row",
    same(turn1, { found: 0, closed: 0 }) && same(turn2, { found: 1, closed: 0 }) && (await cellOf(c2, FIND_EMAIL_COLUMN))?.display === "Found by Findymail" &&
      (await cellOf(c1, FIND_EMAIL_COLUMN))?.value.state === "sent" && (await progressOf(R2.id))?.open === 1 && Boolean((await progressOf(R2.id))?.checked_at),
    JSON.stringify({ turn1, turn2 }));

  section("D5. The pull's row being worked waits; one that changed closes; two workers hand back once");
  const wC1 = await workRow(pool, net, Number(Q.c1.id), { env: KEYS, settings: S });
  const wC3 = await workRow(pool, net, Number(Q.c3.id), { env: KEYS, settings: S });
  check("Cy and Cole found by Findymail", wC1.values.person_outcome === "Approved email" && wC3.values.person_outcome === "Approved email");
  await pool.query(`UPDATE enrich_rows SET run_status = 'running' WHERE id = $1`, [c1]);
  await pool.query(`UPDATE enrich_cells SET value = '"Ready to add"' WHERE row_id = $1 AND column_key = 'outcome'`, [c3]);
  const hb2 = await handBackFound(pool, { runIds: [cancelled.id] });
  check("Cy's pull row is running: left for the next minute; Cole's no longer says No email: The pull's row changed",
    same(hb2, { found: 0, closed: 1 }) && (await cellOf(c1, FIND_EMAIL_COLUMN))?.value.state === "sent" &&
      (await cellOf(c3, FIND_EMAIL_COLUMN))?.display === "The pull's row changed" && !(await cellOf(c3, "email")), JSON.stringify(hb2));
  await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE id = $1`, [c1]);
  const hb3 = await handBackFound(pool, { runIds: [cancelled.id] });
  check("... once it is not: handed back", same(hb3, { found: 1, closed: 0 }) && (await cellOf(c1, FIND_EMAIL_COLUMN))?.display === "Found by Findymail", JSON.stringify(hb3));
  const wW1 = await workRow(pool, net, Number(Q.w1.id), { env: KEYS, settings: S });
  const twice = await Promise.all([handBackFound(pool, { runIds: [R2.id] }), handBackFound(pool, { runIds: [R2.id] })]);
  check("two hand-backs at once: Wyn's address handed back once", wW1.values.person_outcome === "Approved email" && twice[0].found + twice[1].found === 1 &&
    (await cellOf(w1, FIND_EMAIL_COLUMN))?.value.state === "found" && (await progressOf(R2.id))?.open === 0, JSON.stringify(twice));

  section("D6. The pull's rows worked again, then the AI Ark add through the real import");
  for (const k of ["n2", "nk"]) {
    const w = await workRow(pool, net, P[k], { env: {}, settings: S });
    check(`${k === "n2" ? "Nia" : "Kit"}'s pull row: Ready to add`, w.status === "done" && w.values.outcome === "Ready to add", JSON.stringify({ status: w.status, outcome: w.values.outcome, verdict: w.values.email_verdict }));
  }
  const st = await addState(pool, R1.table_id);
  check("the run's state: three to add, three with no email, two of them sent to the People table", st.ready === 3 && st.pipeline === 3 && st.sent === 2, JSON.stringify(st));
  const { POST: addPost } = await route("aiark/add");
  T.role = "manager";
  const r = await call(addPost, { body: { run: R1.id } });
  await drainAfter();
  check("the add: three people", r.status === 202 && r.body.adding === 3 && r.body.skipped === 0, JSON.stringify(r.body));
  const ln = await leadOf(nia);
  const lk = await leadOf(kitMail);
  const lr = await leadOf(at("rae"));
  console.log(`    leads made by the add: Nia source "${ln?.source}", status ${ln?.validation_status ?? "NULL"}; Kit source "${lk?.source}", status ${lk?.validation_status ?? "NULL"}; Rae source "${lr?.source}", status ${lr?.validation_status ?? "NULL"}`);
  check("Nia's lead: source \"AI Ark, found by Findymail\", NULL status, her question, the client's tag",
    ln?.source === `${SOURCE}, found by Findymail` && ln.validation_status === null && ln.question === "Made-up question for Nia?" && String(ln.tags ?? "").includes(TB), JSON.stringify(ln));
  check("Kit's lead: \"AI Ark, found by Anymail Finder, approved by Enrichley\", catch_all", lk?.source === `${SOURCE}, found by Anymail Finder, approved by Enrichley` && lk.validation_status === "catch_all",
    JSON.stringify(lk));
  check("Rae's lead (an address AI Ark gave): exactly as before, AI Ark and valid, no question", lr?.source === SOURCE && lr.validation_status === "valid" && lr.question === null, JSON.stringify(lr));
  const aN2 = await cellOf(P.n2, "add_to_database");
  check("each settles Added, the note naming the person's own source", aN2?.display === "Added" && aN2.value.added === true &&
    aN2.note === `Added to the lead database with source ${SOURCE}, found by Findymail, tagged with the client.` &&
    (await cellOf(P.nk, "add_to_database"))?.display === "Added" && (await cellOf(P.ra, "add_to_database"))?.note === "Added to the lead database with source AI Ark, tagged with the client.",
    JSON.stringify(aN2));
  check("the run's state after: all three added", (await addState(pool, R1.table_id)).added === 3);
}

// ── E. The wiring ───────────────────────────────────────────────────────────

function partE() {
  section("E. The worker, the screens, the AI Ark add as before");
  const ws = source("scripts/enrich-worker.mjs");
  check("the worker's 60-second block: the stale sweep, the Maps release, the uploads' move, the pulls' copy, the People release, the hand-back",
    /if \(Date\.now\(\) - lastSweep > 60_000\) \{\s*await reclaimStale\(\);\s*await releaseHeld\(\);\s*await moveUploads\(\);\s*await copyPulls\(\);\s*await releaseHeldPeople\(\);\s*await handBackPulls\(\);\s*lastSweep = Date\.now\(\);/.test(ws));
  check("it pushes the capability beside the new steps, the array's own text unchanged",
    /CAPABILITIES\.push\(PULL_NO_EMAIL_CAPABILITY\);/.test(ws) && PULL_NO_EMAIL_CAPABILITY === "pull_no_email" &&
      /const CAPABILITIES = \["company_runs", "pipeline_v2", "people_runs", "linkedin_sources", "held_release", UPLOAD_CAPABILITY\];/.test(ws));
  check("both steps never throw, and say once that migration 130 is missing (42P01, 42703, 42883)",
    /async function copyPulls\(\) \{\s*try \{[\s\S]*?await copyPullNoEmail\(pool, \{ settings, log \}\);[\s\S]*?\} catch \(e\) \{\s*if \(UPLOADS_UNREADY\.has\(e\?\.code\)\) \{\s*if \(!pullsUnreadyLogged\)/.test(ws) &&
      /async function handBackPulls\(\) \{\s*try \{\s*const \{ found, closed \} = await handBackFound\(pool, \{ log \}\);[\s\S]*?\} catch \(e\) \{\s*if \(UPLOADS_UNREADY\.has\(e\?\.code\)\) \{\s*if \(!handBackUnreadyLogged\)/.test(ws));
  const panel = source("src/components/clay/cell-panel.tsx");
  check("the cell panel: a held row from a pull gets its own note; the upload note and heldNote(shown.row.template) are kept",
    panel.includes("Held: a person an AI Ark pull bought with no email. The worker starts it while its client is on People runs, at most 2,000 rows of this table at a time; nothing runs or is spent on it until then.") &&
      /startsWith\("AI Ark pull"\)/.test(panel) && /heldNote\(shown\.row\.template\)/.test(panel) && panel.includes("Held: a no-email row of an upload. It is worked once its client is on People runs"));
  const page = source("src/app/(app)/leads/clay/page.tsx");
  check("the Clay tab's add bar: how many with no email went to the People table, or not yet",
    page.includes("state.pipeline ? `${fmt(state.pipeline)} no email${state.sent ? ` (${fmt(state.sent)} sent to the People table)` : \", not sent yet\"}` : \"\""));
  check("AddState has sent", /\n {2}sent: number;\n/.test(source("src/lib/aiark/types.ts")));
  const find = RUN_COLUMNS.find((c) => c.key === FIND_EMAIL_COLUMN);
  check("find_email: the new description, its run condition and phase as before", find.run_if === `{{outcome}} === "No email"` && find.phase === 3 && find.action === "later" &&
    find.description.startsWith("People whose Outcome is No email are copied to the client's People (pipeline) table once the client is on People runs"));
  const sheet = source("src/components/companies/settings-sheet.tsx");
  check("the settings sheet says how promotion marks found and approved addresses", sheet.includes("Addresses approved by Reoon or Enrichley, or found by an email finder, are added, as in Clay") &&
    !sheet.includes("waits for now"));
  // An add with no address found in the People table imports exactly as before.
  const c = { email: "pat@acme.prtest.example", full_name: "Pat Lee", title: "Owner", company: "Acme", domain: "acme.prtest.example", city: "Springfield", state: "Illinois",
    country: "United States", email_verdict: "Catch-all" };
  const row = importRow(c);
  const atCol = (k) => IMPORT_COLUMNS.findIndex(([, f]) => f === k);
  check("an add with no email_found_source: validation from AI Ark's check, source AI Ark, no question", row[atCol("validation_status")] === "catch_all" &&
    importRow({ ...c, email_verdict: "Valid" })[atCol("validation_status")] === "valid" && row[atCol("source")] === SOURCE && row[atCol("question")] === "" && rowSource(c) === SOURCE);
  const f = importRow({ ...c, email_found_source: "found by Findymail", email_found_status: "", question: "Q?" });
  check("with it: the found verdict (empty: NULL), the source with who found it, the question", f[atCol("validation_status")] === "" && f[atCol("source")] === `${SOURCE}, found by Findymail` &&
    f[atCol("question")] === "Q?" && importRow({ ...c, email_found_source: "x", email_found_status: "catch_all" })[atCol("validation_status")] === "catch_all");
  check("the add reads the three new cells; Question is an import column", ["email_found_source", "email_found_status", "question"].every((k) => ADD_INPUT_KEYS.includes(k)) &&
    atCol("question") === IMPORT_COLUMNS.length - 1);
}

// ── emailFound's extra cells, on their own ─────────────────────────────────

async function partF({ R1 }) {
  section("F. emailFound's extra cells");
  const row = await pullRow(R1, "f1", { first: "Fay" });
  const ok = await emailFound(pool, { rowId: row, email: ` Fay-${RUN}@Acme.prtest.example `, extra: { email_found_source: " found by Prospeo ", email_found_status: "", question: null, email: "not-this" } });
  const cells = await cellsOf(row);
  check("only the extra cells that are not empty, trimmed; the three it always writes are never replaced", ok && cells.email === `fay-${RUN}@acme.prtest.example` &&
    cells.email_found_source === "found by Prospeo" && !("email_found_status" in cells) && !("question" in cells) && cells.email_status === "VALID", JSON.stringify(cells));
  const plain = await pullRow(R1, "f2", { first: "Flo" });
  const before = Object.keys(await cellsOf(plain)).sort();
  const ok2 = await emailFound(pool, { rowId: plain, email: `flo-${RUN}@acme.prtest.example`, status: "VALID", domainType: "CATCH_ALL" });
  const after = Object.keys(await cellsOf(plain)).sort();
  check("without extra, exactly as before: the address, its status and the mailbox type, nothing else", ok2 &&
    same(after, [...new Set([...before, "email", "email_status", "email_domain_type"])].sort()) && (await cellOf(plain, "email_domain_type"))?.value === "CATCH_ALL",
    JSON.stringify({ before, after }));
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  const tbl = (await all(`SELECT id FROM enrich_tables WHERE client_tag = ANY($1::text[])`, [TAGS])).map((r) => r.id);
  await pool.query(`DELETE FROM upload_batches WHERE strpos(filename, $1) > 0`, [PREFIX]);
  await pool.query(`DELETE FROM enrich_memory WHERE client_tag = ANY($1::text[]) OR table_id = ANY($2::uuid[]) OR key LIKE $3`, [TAGS, tbl, `%${HOST}%`]);
  await pool.query(`DELETE FROM aiark_people WHERE starts_with(person_id, 'prtest-')`);
  await pool.query(`DELETE FROM aiark_runs WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tbl]);
  // After the tables: deleting their cells writes their counters' deltas.
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tbl]);
  await pool.query(`DELETE FROM enrich_originals WHERE variant = ANY($1::text[])`, [VARIANTS]);
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[])`, [TAGS]);
  if (switchesBefore) {
    for (const key of SWITCHES) {
      const b = switchesBefore[key];
      if (b.exists) await pool.query(`UPDATE enrich_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1`, [key, JSON.stringify(b.value), b.updated_by]);
      else await pool.query(`DELETE FROM enrich_settings WHERE key = $1`, [key]);
    }
  }
  if (spendBefore) {
    await pool.query(`DELETE FROM enrich_spend_daily WHERE NOT ((day::text || '|' || kind) = ANY($1::text[]))`, [spendBefore.map((r) => `${r.day}|${r.kind}`)]);
    for (const r of spendBefore) {
      await pool.query(
        `INSERT INTO enrich_spend_daily (day, kind, used, updated_at) VALUES ($1::date, $2, $3::numeric, $4)
         ON CONFLICT (day, kind) DO UPDATE SET used = EXCLUDED.used, updated_at = EXCLUDED.updated_at`,
        [r.day, r.kind, r.used, r.updated_at]
      );
    }
  }
}

const spendNow = () => all(`SELECT day::text AS day, kind, used::text AS used FROM enrich_spend_daily ORDER BY day, kind`);
const t0 = Date.now();
try {
  const ready = await one(`SELECT to_regprocedure('public.fn_enrich_people_switch_on(text)') IS NOT NULL AS m130`);
  if (!ready.m130) throw new Error("migration 130 is not in this database");
  const worker = await one(`SELECT count(*)::int AS n FROM enrich_worker_state WHERE last_seen > now() - interval '30 seconds' AND NOT coalesce((info->>'stopped')::boolean, false)`);
  if (worker.n) throw new Error("an enrichment worker's heartbeat is fresh: stop it first");
  await cleanup();
  switchesBefore = {};
  for (const key of SWITCHES) {
    const s = await one(`SELECT value, updated_by FROM enrich_settings WHERE key = $1`, [key]);
    switchesBefore[key] = { exists: Boolean(s), value: s?.value ?? null, updated_by: s?.updated_by ?? null };
  }
  spendBefore = await all(`SELECT day::text AS day, kind, used::text AS used, updated_at FROM enrich_spend_daily ORDER BY day, kind`);
  BASE_ROWS = await all(`SELECT key, value FROM enrich_settings`);
  // The release and the copy act on every client, so the run stops unless nothing else is in their way.
  const base = settingsFrom(BASE_ROWS);
  const held = (await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE run_status = 'held'`)).n;
  const lists = { company_pipeline: base.company_pipeline.tags, people_pipeline: base.people_pipeline.tags, personalisation: base.personalisation.tags, promotion: base.promotion.tags };
  const busy = Object.values(lists).some((t) => t.length);
  check("before the run: no held row anywhere, no client on the company_pipeline, people_pipeline, personalisation or promotion list",
    held === 0 && !busy, JSON.stringify({ held, ...lists }));
  if (held || busy) throw new Error("not run: a client is on a switch's list, or held rows are in the way here");
  for (const t of TAGS) {
    await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, NULL)`, [t, `Found emails test ${t.slice(-1)}`]);
    await pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
       VALUES ($1, '{US}', $2, '[]', $3, false, now())`,
      [t, JSON.stringify([{ city: "Springfield", state: "IL", country: "US" }]), [BANNED]]
    );
    await seedFixtureVariant(pool, t);
  }
  resetClientChecks();
  resetCompanyActions();
  partA();
  await partB();
  const c = await partC();
  await partD(c);
  partE();
  await partF(c);
  check("nothing tried to reach any other address", net.calls.refused === 0, `${net.calls.refused} refused`);
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[])) AS clients,
            (SELECT count(*)::int FROM enrich_tables WHERE client_tag = ANY($1::text[])) AS tables,
            (SELECT count(*)::int FROM aiark_runs WHERE client_tag = ANY($1::text[])) AS runs,
            (SELECT count(*)::int FROM aiark_people WHERE starts_with(person_id, 'prtest-')) AS registry,
            (SELECT count(*)::int FROM enrich_originals WHERE variant = ANY($2::text[])) AS originals,
            (SELECT count(*)::int FROM upload_batches WHERE strpos(filename, $3) > 0) AS batches,
            (SELECT count(*)::int FROM enrich_rows WHERE run_status = 'held') AS held,
            (SELECT count(*)::int FROM enrich_memory WHERE client_tag = ANY($1::text[])) AS memory,
            (SELECT count(*)::int FROM leads WHERE email LIKE $4) AS leads`,
    [TAGS, VARIANTS, PREFIX, `%.${HOST}`]
  );
  let switchesBack = true;
  if (switchesBefore) {
    for (const key of SWITCHES) {
      const s = await one(`SELECT value FROM enrich_settings WHERE key = $1`, [key]);
      const b = switchesBefore[key];
      if (b.exists ? JSON.stringify(s?.value) !== JSON.stringify(b.value) : Boolean(s)) switchesBack = false;
    }
  }
  const spendBack = !spendBefore || JSON.stringify(await spendNow()) === JSON.stringify(spendBefore.map(({ day, kind, used }) => ({ day, kind, used })));
  const clean = Object.values(left).every((n) => n === 0) && switchesBack && spendBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, switchesBack, spendBack })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const p of T.pools) await p.end().catch(() => {});
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
