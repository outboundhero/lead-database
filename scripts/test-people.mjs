#!/usr/bin/env node
// Deep checks for the Companies tab's people runs (phase 2, design 8.3).
// LOCAL DATABASE ONLY: it makes made-up clients (tags starting PPTEST_) with
// their rules, pipeline tables and company rows, a few made-up leads and
// never-contact rows, registry entries and demo people runs, and removes all
// of it at the end. The people_pipeline setting is changed for the route
// checks and put back as it was.
//
//   node --env-file=.env.local scripts/test-people.mjs
//
// Stop the enrichment worker first: it would race this script for the runs
// and the rows. Migration 125 must be in the local database.
//
// Nothing here reaches a network. AI Ark answers through the demo transport
// (People Preview by company id, Export Single with and without an email),
// with test faults; fetch is replaced for the whole run and refuses every
// address. The tracks' phrases here are made up: the real ones come from the
// Clay originals through the database, never from this public repo. The
// routes run for real through a small TypeScript loader, with stand-ins only
// for the session, the audit log and the worker's heartbeat.
//
// What it checks:
//   A. no database: the request builder, trackOf, the excluded titles, the
//      people sources, the demo transport by company id, a People row's input
//      cells, the brake
//   B. against the database: eligible companies, starting a run, the Look and
//      its free screen, registry copies, a size refusal, empty pages, the page
//      cap, the lowest balance, the pick, the pause and the Buy (with and
//      without an email, reserves, a pick bought elsewhere since the Look),
//      settling and the company row queued again, the money brakes, one run
//      per client, cancel, a crash mid-slice, the AI Ark tab unchanged (D43),
//      the routes and their refusals, nothing written to leads
//   C. with Builder A's templates in place (ensurePipelineTables compiles):
//      the start route end to end and a bought person's email worked by the
//      compiled People template (Reoon stubbed)

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { AiArkError, createAiArk } from "./lib/aiark/client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./lib/aiark/demo.mjs";
import { makeCompanyPerson, peopleCountAt } from "./lib/aiark/demo-people.mjs";
import { CLEANING_EXCLUDE_KEYWORDS, CLEANING_EXCLUDE_TITLES } from "./lib/aiark/cleaning-filters.mjs";
import { condensePhrases, loadGeo } from "./lib/aiark/filters.mjs";
import {
  buildPeopleAtCompanies, excludedTitlesFor, IDS_PER_SEARCH, peopleRequestsFor, peopleSources, registerPeopleSource, trackOf, trackPhrases,
} from "./lib/aiark/people-requests.mjs";
import {
  activePeopleRun, advanceOnePeopleRun, approveBuy, cancelPeopleRun, createPeopleRun, eligibilityCounts, eligibleCompanies, MISS_ESTIMATE,
  peopleRunDue, peopleSpendCeiling, personRowCells, PeopleRunRefused,
} from "./lib/aiark/people-runs.mjs";
import { advanceOneRun, createRun } from "./lib/aiark/runs.mjs";
import { pullsToAdd } from "./lib/aiark/add.mjs";
import { resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { runRow } from "./lib/enrich/engine.mjs";
import { order } from "./lib/enrich/formula.mjs";
import { PIPELINE_ACTIONS } from "./lib/enrich/pipeline-actions.mjs";
import { projectContact, VERDICT_BY_OUTCOME } from "./lib/enrich/project-contacts.mjs";
import { PEOPLE_INPUT_KEYS, PERSON_OUTCOMES } from "./lib/enrich/people-template.mjs";
import { resetSettingsCache, settingsFrom } from "./lib/enrich/settings.mjs";
import { ensureTable, syncTemplateColumns } from "./lib/enrich/templates.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
// No paid key reaches anything here, whatever the shell holds.
const PAID_KEYS = [
  "OPENAI_API_KEY", "ENRICH_REOON_API_KEY", "REOON_API_KEY", "CLEARBIT_API_KEY", "FINDEMAIL_API_KEY", "ANTHROPIC_API_KEY",
  "AIARK_API_KEY", "AIARK_WEBHOOK_URL", "AIARK_AUTO_ADD_URL", "AIARK_AUTO_ADD_KEY",
  "FINDYMAIL_API_KEY", "PROSPEO_API_KEY", "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY",
];
for (const k of PAID_KEYS) delete process.env[k];
process.env.AIARK_DEMO = "1";
process.env.AIARK_DEMO_LATENCY_MS = "0";
delete process.env.AIARK_DEMO_CREDITS;

let passed = 0;
let failed = 0;
let pending = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` : ${detail}` : ""}`);
}
/** A check that can run only once Builder A's part is in this tree. */
function later(name, why) {
  pending++;
  console.log(`  ...  ${name} (${why})`);
}
const section = (s) => console.log(`\n${s}`);
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ── No network ──────────────────────────────────────────────────────────────

const net = { refused: 0, reoon: 0, verdicts: new Map() };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let reoonStub = false; // part C only: Reoon answers from here
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (reoonStub && u.hostname === "emailverifier.reoon.com") {
    if (u.pathname.includes("check-account-balance")) return json(200, { status: "success", remaining_daily_credits: 400, remaining_instant_credits: 0 });
    if (u.pathname.endsWith("/verify")) {
      net.reoon++;
      const email = u.searchParams.get("email");
      const status = net.verdicts.get(email) ?? "invalid";
      return json(200, { email, status, is_deliverable: status === "safe", is_safe_to_send: status === "safe", is_valid_syntax: true });
    }
  }
  net.refused++;
  throw Object.assign(new TypeError("fetch failed: test-people allows no network"), { cause: { code: "ECONNREFUSED" } });
};

// ── The routes' TypeScript, compiled as it is imported ──────────────────────
// "@/..." is src/, as in tsconfig. The session, the audit log and the
// worker's heartbeat are stand-ins the checks set through globalThis.

const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}`,
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
export async function requireRole(min) {
  const t = globalThis.__peopleTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__peopleTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__peopleTest.worker; }`,
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
const require = createRequire(import.meta.url);
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, {
  data: { typescript: pathToFileURL(require.resolve("typescript")).href, src: new URL("../src/", import.meta.url).href, stubs: STUBS },
});
const T = (globalThis.__peopleTest = { role: "manager", userId: randomUUID(), audits: [], worker: null });
const srcModule = (p) => import(new URL(`../src/${p}`, import.meta.url).href);
const route = (p) => srcModule(`app/api/${p}/route.ts`);

/** One route call, as Next.js would make it. */
async function call(handler, { body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const req = { json: async () => body, nextUrl: new URL(`http://people.test/api${qs}`), headers: new Headers() };
  const res = await handler(req);
  return { status: res.status, body: res.body };
}

/** A worker heartbeat as workerState() returns it. */
const heartbeat = ({ online = true, peopleRuns = true } = {}) => ({
  id: "people-test",
  last_seen: new Date().toISOString(),
  started_at: new Date().toISOString(),
  seconds_ago: online ? 2 : 600,
  online,
  info: { capabilities: ["company_runs", ...(peopleRuns ? ["people_runs"] : [])], keys: { OPENAI_API_KEY: false, ENRICH_REOON_API_KEY: false }, reoon: null },
});

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 8 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const fastWait = async () => {};
const quiet = () => {};

const PREFIX = "PPTEST_";
const RUN = randomUUID().slice(0, 6).toUpperCase();
const TEST_HOST = "pptest.example"; // every made-up address and website here ends with it
const SUPPRESS_REASON = "people test";
const tagOf = (s) => `${PREFIX}${s}_${RUN}`;
const A = tagOf("A"); // the main client
const C = tagOf("C"); // a cleaning client
const B2 = tagOf("B"); // a second client: tries per track, a lost answer, the brake
const MONEY = tagOf("MONEY"); // money and concurrency
const OFF = tagOf("OFF"); // not on the people runs' list
const V1 = tagOf("V1"); // a retired companies_v1 table
const NOTAB = tagOf("NOTAB"); // no pipeline Companies table
const TAB = tagOf("TAB"); // the AI Ark tab's runs (D43)
const created = { runs: [], tabRuns: [], tables: [], persons: new Set() };

// The tracks, made up: real phrases come from the originals through the database.
const TRACKS_FIX = {
  order: ["operations", "facility_office", "ceo"],
  operations: { phrases: ["Chief Widget Officer", "Head of Widget Operations"], from: ["C#37", "C#41"] },
  facility_office: { phrases: ["Widget Room Manager", "Widget Desk Coordinator"], from: ["C#44", "C#48"] },
  ceo: { phrases: ["Widget Founder", "Widget Owner"], from: ["C#52", "C#56"] },
};
const TITLES = condensePhrases(trackPhrases(TRACKS_FIX));
const EXCLUDE_TERM = "washfloor"; // the main client's exclusion term

/** The settings a run is worked with: people runs on for the given clients, the made-up tracks. */
function settingsFor(tags, over = {}) {
  return settingsFrom([
    {
      key: "people_pipeline",
      value: {
        enabled: true, tags, auto_buy: false, ai_searches: false, ids_per_search: 50, pages_per_search: 5, tries_per_track: 1,
        max_people_per_run: 300, recheck_days: 90, skip_company_when_held: true, min_balance: 500, ...over,
      },
    },
    { key: "people_tracks", value: TRACKS_FIX },
  ]);
}
const ON_TAGS = [A, C, B2, MONEY, V1, NOTAB];
let SETTINGS = settingsFor(ON_TAGS);

/** The three pipeline tables with no columns (ensureTable): what the runs need from them before Builder A's compile. */
const testTables = async (db, t) => ({
  companies: (await ensureTable(db, t, "companies")).id,
  inboxes: (await ensureTable(db, t, "inboxes")).id,
  people: (await ensureTable(db, t, "people")).id,
  variant: "default",
});

async function addClient(t, { type = null, places = [{ city: "Springfield", state: "IL", country: "US" }], terms = [], cleaning = false } = {}) {
  await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, $3)`, [t, `People test ${t.slice(PREFIX.length)}`, type]);
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
     VALUES ($1, '{US}', $2, '[]', $3, $4, now())`,
    [t, JSON.stringify(places), terms, cleaning]
  );
}

/** A Company Search record for a made-up company, as the demo transport keeps it. */
const companyRecord = (id, name, { city = "Springfield", state = "Illinois", domain = null } = {}) => ({
  id,
  summary: { name, industry: "widget services", description: `${name} is a made-up business for the people run tests.` },
  location: { headquarter: { city, state, country: "United States" } },
  link: { domain: domain ?? `${id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${TEST_HOST}` },
});

/** The facts a company's people carry, exactly as the demo transport makes them. */
const factsOf = (record) => createDemoTransport({ companies: [record] }).companyFacts(record.id);
/** The people the demo transport has at a company, in its order (no exclusions asked). */
const peopleAt = (record) => {
  const f = factsOf(record);
  return Array.from({ length: peopleCountAt(record.id) }, (_, i) => makeCompanyPerson(f, i, { titles: TITLES }));
};
const inside = (p) => p.city === "Springfield" && p.state === "Illinois";

/** A company id (and record) whose made-up people pass `ok`. */
function findCompany(label, name, ok, opts = {}) {
  for (let k = 0; k < 5_000; k++) {
    const rec = companyRecord(`pptest-${RUN}-${label}-${k}`.toLowerCase(), name, opts);
    const people = peopleAt(rec);
    if (ok(people)) return { record: rec, people };
  }
  throw new Error(`No made-up company fits "${label}"`);
}
const allTracked = (ps) => ps.every((p) => trackOf(p.title, TRACKS_FIX));
const normal = (min = 3) => (ps) => ps.length >= min && ps.every(inside) && allTracked(ps);
const threeTracks = (ps) => new Set(ps.map((p) => trackOf(p.title, TRACKS_FIX)?.track).filter(Boolean)).size === 3;
/** The person a pick takes in a track: the best rank, then the lowest id (the pick's own order). */
const bestOf = (ps, track) =>
  ps.map((p) => ({ p, t: trackOf(p.title, TRACKS_FIX) })).filter((x) => x.t?.track === track).sort((a, b) => a.t.rank - b.t.rank || (a.p.id < b.p.id ? -1 : 1))[0]?.p ?? null;

/** A company row in a client's pipeline Companies table, as the pull and the company row's steps leave it. */
async function addCompanyRow(t, tableId, { record, passes = true, neverContact = false, held = 0, aiark = true, outcome = "No general email found", heldCell = true }) {
  const name = record.summary.name;
  const domain = record.link.domain;
  const { rows: [r] } = await pool.query(
    `INSERT INTO enrich_rows (table_id, row_key, search_text, run_status) VALUES ($1, $2, $3, 'done') RETURNING id`,
    [tableId, aiark ? `aiark:${record.id}` : `csv:${record.id}`, name.toLowerCase()]
  );
  const rowId = Number(r.id);
  const cells = { company: name, use_domain: domain, use_website: `https://${domain}`, ...(aiark ? { aiark_id: record.id } : {}) };
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
     SELECT $1, kv.key, $2, 'done', to_jsonb(kv.value), left(kv.value, 300) FROM jsonb_each_text($3::jsonb) AS kv`,
    [rowId, tableId, JSON.stringify(cells)]
  );
  if (heldCell) {
    await pool.query(
      `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display) VALUES ($1, 'held_people', $2, 'done', $3, $4)`,
      [rowId, tableId, JSON.stringify({ count: held, titles: [] }), held ? `${held} held` : "None held"]
    );
  }
  await pool.query(
    `INSERT INTO enrich_companies (row_id, table_id, client_tag, source, aiark_id, company, domain, website, city, state, country, outcome,
                                   template, passes, never_contact)
     VALUES ($1, $2, $3, 'AI Ark', $4, $5, $6, $7, 'Springfield', 'IL', 'US', $8, 'companies_v2', $9, $10)`,
    [rowId, tableId, t, aiark ? record.id : null, name, domain, `https://${domain}`, outcome, passes, neverContact]
  );
  return rowId;
}

/** A lead with a person's name at their company: the screen finds it by name and company. */
async function leadFor(p, extra = {}) {
  const cols = { email: `${p.first}.${p.last}.${randomUUID().slice(0, 6)}@lead.${TEST_HOST}`.toLowerCase(), first_name: p.first, last_name: p.last, company: p.company, ...extra };
  await pool.query(`INSERT INTO leads (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(cols));
}

async function newPeopleRun(t, { mode = "demo", maxPeople = null, settings = SETTINGS, ensureTables = testTables } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const run = await createPeopleRun(c, { tag: t, mode, maxPeople, createdBy: null, settings, ensureTables });
    await c.query("COMMIT");
    created.runs.push(run.id);
    return run;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

const TERMINAL = new Set(["done", "stopped", "error", "cancelled"]);
const demoClient = (tx) => async () => ({ client: createAiArk({ token: DEMO_TOKEN, transport: tx, wait: fastWait, rps: 5 }) });
const runOf = (id) => one(`SELECT * FROM aiark_people_runs WHERE id = $1`, [id]);
const due = (id) => pool.query(`UPDATE aiark_people_runs SET next_run_at = now() WHERE id = $1 AND status IN ('queued', 'running')`, [id]);
const step = (clientFor, extra = {}) => advanceOnePeopleRun({ pool, env: { AIARK_DEMO: "1" }, clientFor, log: quiet, settings: SETTINGS, ...extra });
/** Works a run slice by slice until it reaches one of `until` (it is made due again whenever it waits). */
async function drive(id, clientFor, { until = new Set([...TERMINAL, "looked"]), limit = 500, extra = {}, onWait = null } = {}) {
  for (let i = 0; i < limit; i++) {
    const r = await runOf(id);
    if (until.has(r.status)) return r.status;
    const worked = await step(clientFor, extra);
    if (!worked) {
      if (onWait) await onWait();
      await due(id);
    }
  }
  throw new Error(`people run ${id} did not get to ${[...until].join("/")}`);
}
/** Ends every test run still going, so the next check's slices don't pick it up. */
const endTestRuns = () =>
  pool.query(
    `UPDATE aiark_people_runs SET status = 'cancelled', finished_at = coalesce(finished_at, now()), claim_token = NULL
      WHERE starts_with(client_tag, $1) AND status IN ('queued', 'running', 'looked')`,
    [PREFIX]
  );
const candidatesOf = (runId) => all(`SELECT * FROM aiark_people_candidates WHERE run_id = $1 ORDER BY company_row_id, person_id`, [runId]);
const rowsIn = async (tableId) => (await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = $1`, [tableId])).n;
const cellsOf = async (rowId) => Object.fromEntries((await all(`SELECT column_key, value FROM enrich_cells WHERE row_id = $1`, [rowId])).map((c) => [c.column_key, c.value]));

/**
 * The worker's part for one People row, as if the compiled template had
 * worked it: its outcome into enrich_contacts (projectContact, fenced on a
 * claim) and the row done.
 */
async function finishPersonRow(rowId, tag, outcome) {
  const { rows: [r] } = await pool.query(
    `UPDATE enrich_rows SET run_status = 'running', claim_token = gen_random_uuid(), claimed_at = now() WHERE id = $1 RETURNING claim_token, table_id`,
    [rowId]
  );
  const v = await cellsOf(rowId);
  const values = {
    ...v,
    person_outcome: outcome,
    use_work_email: outcome === "Approved email" ? v.email : "",
    full_name: v.find_people_from_linkedin_company_url?.name ?? "",
    title: v.find_people_from_linkedin_company_url?.latest_experience_title ?? "",
    city: v.written_city ?? "",
    state: v.written_state ?? "",
  };
  const out = await projectContact(pool, { rowId, claimToken: r.claim_token, tableId: r.table_id, clientTag: tag, kind: "person", values });
  await pool.query(`UPDATE enrich_rows SET run_status = 'done', claim_token = NULL, claimed_at = NULL, finished_at = now() WHERE id = $1`, [rowId]);
  return out;
}
/** Every People row of a table still queued, finished as the template would: approved with an email, no email without. */
async function finishPeopleRows(tableId, tag, { outcomeOf = null } = {}) {
  const rows = await all(`SELECT id FROM enrich_rows WHERE table_id = $1 AND run_status = 'queued' ORDER BY id`, [tableId]);
  for (const r of rows) {
    const v = await cellsOf(r.id);
    const outcome = outcomeOf?.(v) ?? (v.email ? "Approved email" : "No email (AI Ark found none)");
    await finishPersonRow(Number(r.id), tag, outcome);
  }
  return rows.length;
}

/** A transport over the demo one: `fn` may answer a request itself (return an answer), or let it through (undefined). */
const ans = (status, body, headers = {}) => ({ status, headers: new Headers({ "content-type": "application/json", ...headers }), text: JSON.stringify(body) });
const overlay = (tx, fn) => {
  const h = async (req) => (await fn(req)) ?? tx(req);
  h.state = tx.state;
  return h;
};
const isSingle = (req) => req.method === "POST" && req.url.endsWith("/v2/people/export/single");
const isPreview = (req) => req.method === "POST" && req.url.endsWith("/v1/people/preview");
/** Counts the calls of each kind a transport sees. */
function counted(tx) {
  const n = { preview: 0, single: 0, credits: 0 };
  const h = async (req) => {
    if (isPreview(req)) n.preview++;
    else if (isSingle(req)) n.single++;
    else if (req.url.includes("/payments/credits")) n.credits++;
    return tx(req);
  };
  h.state = tx.state;
  h.n = n;
  return h;
}

// ── A. No database ──────────────────────────────────────────────────────────

async function partA() {
  section("A1. What AI Ark is asked: people at the companies, by company id");
  const ids = Array.from({ length: 120 }, (_, i) => `co-${i}`);
  const b = buildPeopleAtCompanies({ companyIds: [...ids, "co-3"], tracks: TRACKS_FIX, excludeTitles: ["Intern", "Widget Intern", "Assistant"], cleaning: true, idsPerSearch: 50 });
  check("120 ids (one repeated) make 3 batches of 50, 50 and 20, one body each", b.batches.length === 3 && b.batches.map((x) => x.ids.length).join() === "50,50,20" && b.bodies.length === 3);
  check("each body names its batch's ids under contact.company.latest", b.batches.every((x) => JSON.stringify(x.bodies[0].contact.company.latest.any.include) === JSON.stringify(x.ids)));
  const t0 = b.bodies[0].contact.experience.latest.title.any;
  check("the tracks' phrases, in WORD mode", t0.include.mode === "WORD" && JSON.stringify(t0.include.content) === JSON.stringify(TITLES) && TITLES.length === 6);
  check("the excluded titles, WORD mode and condensed as the AI Ark tab condenses them", t0.exclude.mode === "WORD" && JSON.stringify(t0.exclude.content) === JSON.stringify(["Intern", "Assistant"]));
  const kw = b.bodies[0].contact.keyword?.any?.exclude;
  check("a cleaning client's people keywords on HEADLINE and SUMMARY", kw && JSON.stringify(kw.sources) === JSON.stringify([{ mode: "WORD", source: "HEADLINE" }, { mode: "WORD", source: "SUMMARY" }]) && JSON.stringify(kw.content) === JSON.stringify(condensePhrases(CLEANING_EXCLUDE_KEYWORDS)));
  check("no account, no places, no lists, and page and size are the client's to add", b.bodies.every((x) => !("account" in x) && !x.contact.location && !("lists" in x) && !("page" in x) && !("size" in x)));
  const plain = buildPeopleAtCompanies({ companyIds: ["co-1"], tracks: TRACKS_FIX });
  check("any other client: no keywords, no excluded titles", !plain.bodies[0].contact.keyword && !plain.bodies[0].contact.experience.latest.title.any.exclude);
  check("no tracks or no ids: refused with the reason, nothing to send", buildPeopleAtCompanies({ companyIds: ["x"], tracks: null }).blockers.length === 1 && buildPeopleAtCompanies({ companyIds: [], tracks: TRACKS_FIX }).bodies.length === 0);
  check("ids per search held to 1..300", buildPeopleAtCompanies({ companyIds: ids, tracks: TRACKS_FIX, idsPerSearch: 500 }).batches.length === 1 && buildPeopleAtCompanies({ companyIds: ids.slice(0, 3), tracks: TRACKS_FIX, idsPerSearch: 1 }).batches.length === 3);
  const long = buildPeopleAtCompanies({ companyIds: ["x"], tracks: TRACKS_FIX, excludeTitles: Array.from({ length: 200 }, (_, i) => `made up excluded title number ${i}`) });
  check("excluded titles over the size AI Ark takes: refused, nothing sent", long.bodies.length === 0 && long.blockers.some((x) => x.includes("too long")));
  check("about 6.5 KB with 50 ids at most", Buffer.byteLength(JSON.stringify(buildPeopleAtCompanies({ companyIds: Array.from({ length: 50 }, () => randomUUID()), tracks: TRACKS_FIX }).bodies[0])) < 6_500);
  check("50 ids a search to start with", IDS_PER_SEARCH === 50);

  section("A2. The track of a title, and its rank");
  check("a title holding a phrase as whole words, with a word before it", JSON.stringify(trackOf("Senior Widget Owner", TRACKS_FIX)) === JSON.stringify({ track: "ceo", rank: 1 }));
  check("tracks in their order: operations first", trackOf("Head of Widget Operations and Widget Owner", TRACKS_FIX)?.track === "operations");
  check("rank is the index of the first phrase the title holds", trackOf("Widget Desk Coordinator", TRACKS_FIX)?.rank === 1 && trackOf("Widget Room Manager", TRACKS_FIX)?.rank === 0);
  check("whole words only: ownership is not owner", trackOf("Widget Ownership Lead", TRACKS_FIX) === null);
  check("case and spacing do not matter", trackOf("  CHIEF   widget OFFICER ", TRACKS_FIX)?.track === "operations");
  check("no title or no tracks: none", trackOf("", TRACKS_FIX) === null && trackOf("Widget Owner", null) === null);

  section("A3. The excluded titles");
  check("the client's saved ones first", JSON.stringify(excludedTitlesFor({ exclude_titles: [" Intern ", ""] }, "Cleaning")) === JSON.stringify({ titles: ["Intern"], from: "saved" }));
  check("else a cleaning client's standard ones", JSON.stringify(excludedTitlesFor(null, "Cleaning")) === JSON.stringify({ titles: CLEANING_EXCLUDE_TITLES, from: "cleaning" }));
  check("else none", JSON.stringify(excludedTitlesFor(null, "Dental")) === JSON.stringify({ titles: [], from: "none" }));

  section("A4. People sources");
  check("ai_ark is registered", peopleSources().includes("ai_ark"));
  const ctx = { companyIds: ["a", "b"], tracks: TRACKS_FIX };
  check("ai_ark answers what buildPeopleAtCompanies answers", JSON.stringify(peopleRequestsFor("ai_ark", ctx)) === JSON.stringify(buildPeopleAtCompanies(ctx)));
  let threw = 0;
  for (const f of [() => registerPeopleSource("Bad Name", { requests: () => ({}) }), () => registerPeopleSource("pptest_x", {}), () => peopleRequestsFor("pptest_none", ctx)]) {
    try {
      f();
    } catch {
      threw++;
    }
  }
  check("a bad name, a source with no requests(), an unknown source: refused", threw === 3);
  registerPeopleSource("pptest_source", { requests: () => ({ bodies: [{ made: "up" }], batches: [], notes: [], blockers: [] }) });
  check("another source registers itself by name", peopleSources().includes("pptest_source") && peopleRequestsFor("pptest_source", ctx).bodies[0].made === "up");

  section("A5. The demo transport by company id (I8)");
  const coA = findCompany("a5a", "Ironwidget Works", normal(4));
  const coB = findCompany("a5b", "Brightwidget Supply", normal(3));
  const tx = createDemoTransport({ companies: [coA.record, coB.record], balance: 100 });
  const ai = createAiArk({ token: DEMO_TOKEN, transport: tx, wait: fastWait, rps: 5 });
  const body = buildPeopleAtCompanies({ companyIds: [coA.record.id, coB.record.id], tracks: TRACKS_FIX }).bodies[0];
  const page = await ai.preview(body, { page: 0, size: 100 });
  const expected = [...coA.people, ...coB.people];
  check("Preview answers the people at those companies, and only them", page.content.length === expected.length && page.content.every((p) => [coA.record.id, coB.record.id].includes(p.company.id)), `${page.content.length} vs ${expected.length}`);
  check("... in the generator's order, with the company's own name and the request's titles", page.content.every((p, i) => p.id === expected[i].id && p.company.summary.name === expected[i].company) && page.content.every((p) => trackOf(p.profile.title, TRACKS_FIX)));
  check("... last names masked, as AI Ark's Preview masks them", page.content.every((p) => p.profile.last_name.includes("***")));
  check("... the same people for the same ids, whoever asks", JSON.stringify((await createAiArk({ token: DEMO_TOKEN, transport: createDemoTransport({ companies: [coA.record, coB.record] }), wait: fastWait }).preview(body)).content.map((p) => p.id)) === JSON.stringify(page.content.map((p) => p.id)));
  check("a Preview page costs 1 credit", tx.state.charged === 1);
  const before = tx.state.charged;
  const singles = [];
  for (const p of page.content) singles.push(await ai.exportSingle(p.id));
  const withEmail = expected.filter((p) => p.email.found);
  check("Export Single: with an email, 1 credit and the full person; without, none", singles.filter((s) => s.found).length === withEmail.length && tx.state.charged - before === withEmail.length && singles.every((s, i) => (s.found ? s.credits === 1 && s.person.email.output[0].address === expected[i].email.address && !s.person.profile.last_name.includes("*") : s.credits === 0)));
  check("... both kinds appear among made-up people (about 1 in 4 has none)", (() => {
    let yes = 0;
    let no = 0;
    for (let k = 0; k < 40; k++) {
      for (const p of peopleAt(companyRecord(`pptest-mix-${k}`, "Mix Widgets"))) {
        if (p.email.found) yes++;
        else no++;
      }
    }
    return yes > 0 && no > 0;
  })());
  const ex = buildPeopleAtCompanies({ companyIds: [coA.record.id], tracks: TRACKS_FIX, excludeTitles: [coA.people[0].title] }).bodies[0];
  const exPage = await ai.preview(ex);
  check("titles the request leaves out are left out, as whole words", exPage.content.every((p) => !p.profile.title.toLowerCase().includes(coA.people[0].title.toLowerCase())) && exPage.content.length < coA.people.length);
  const faults = createDemoTransport({ companies: [coA.record], balance: 100, faults: { previewAnswers: [400, 402, 401, 404, { status: 429 }] } });
  const fa = createAiArk({ token: DEMO_TOKEN, transport: faults, wait: fastWait, rps: 5 });
  const kind = async (f) => {
    try {
      const r = await f();
      return r.content ? `page:${r.content.length}` : "ok";
    } catch (e) {
      return e instanceof AiArkError ? `${e.kind}${/request size/i.test(e.message) ? ":size" : ""}` : "other";
    }
  };
  const k1 = await kind(() => fa.preview(body));
  const k2 = await kind(() => fa.preview(body));
  const k3 = await kind(() => fa.preview(body));
  const k4 = await kind(() => fa.preview(body));
  const k5 = await kind(() => fa.preview(body));
  check("test faults: a size refusal, out of credits, the key, an empty page, then a 429 waited out", [k1, k2, k3, k4].join() === "bad_request:size,credits,key,page:0" && k5 === `page:${expected.length}`, [k1, k2, k3, k4, k5].join());
  check("... a refusal costs nothing", faults.state.charged === 1);
  check("more than 300 company ids: refused", (await kind(() => ai.preview({ contact: { company: { latest: { any: { include: Array.from({ length: 301 }, (_, i) => `x${i}`) } } } } }))) === "bad_request");

  section("A6. A People row's input cells");
  const p0 = page.content[0];
  const { cells, search } = personRowCells({
    tag: " pptest_x ", company: { company_row_id: 42, company_id: coA.record.id, website: `https://${coA.record.link.domain}` }, track: "ceo", rank: 1,
    person: p0, email: "Someone@Widget.Example", emailStatus: "VALID", domainType: "SMTP", stage: "bought", source: "AI Ark people run",
  });
  const so = cells.find_people_from_linkedin_company_url;
  check("the source object is a JSON object with exactly the originals' fields", so && typeof so === "object" && Object.keys(so).sort().join() === "domain,last_name,latest_experience_company,latest_experience_title,location_name,name,url");
  check("... built from AI Ark's record", so.latest_experience_title === p0.profile.title && so.latest_experience_company === p0.company.summary.name && so.last_name === p0.profile.last_name);
  check("every other cell is text, and only the People inputs are written", Object.entries(cells).every(([k, v]) => PEOPLE_INPUT_KEYS.includes(k) && (k === "find_people_from_linkedin_company_url" || typeof v === "string")));
  check("email lower case, the table's tag, the company row as text, the rank as text", cells.email === "someone@widget.example" && cells.client_tag === "PPTEST_X" && cells.company_row === "42" && cells.rank === "1" && cells.track === "ceo");
  check("the person's own place as the written city and state (D13)", cells.written_city === p0.location.city && cells.written_state === (p0.location.state ?? "") && cells.person_country === p0.location.country);
  check("the company's website from its row, found by aiark, the stage and source", cells.company_website === `https://${coA.record.link.domain}` && cells.found_by === "aiark" && cells.stage === "bought" && cells.source === "AI Ark people run");
  check("empty values are not written, and the search text is lower case", !Object.values(cells).some((v) => v === "") && search === search.toLowerCase() && search.includes(cells.email));

  section("A7. The brake");
  check("searches x pages a search + max people x 1.25 + 10", peopleSpendCeiling({ batches: 3, max_people: 30, filters: { pages_per_search: 5, bodies_per_batch: 1 } }) === 3 * 5 + 38 + 10);
  check("each batch counted once per group of titles", peopleSpendCeiling({ batches: 2, max_people: 1, filters: { pages_per_search: 4, bodies_per_batch: 2 } }) === 2 * 2 * 4 + 2 + 10);
  check("a miss is allowed for at 0.5 credits in the estimates", MISS_ESTIMATE === 0.5);
}

// ── B. Against the database ─────────────────────────────────────────────────

const world = {}; // what part B made, for the later parts

async function setUp() {
  await addClient(A, { terms: [EXCLUDE_TERM] });
  await addClient(C, { type: "Cleaning", cleaning: true });
  await addClient(B2);
  await addClient(MONEY);
  await addClient(OFF);
  await addClient(V1);
  await addClient(NOTAB);
  await addClient(TAB);
  resetClientChecks();
}

async function partB1() {
  section("B1. Eligible companies");
  const tA = await testTables(pool, A);
  world.tA = tA;
  created.tables.push(tA.companies, tA.inboxes, tA.people);
  const mk = (label, name, ok = normal(3), opts) => findCompany(label, name, ok, opts);
  const co = {
    ok1: mk("ok1", "Northwidget Partners"),
    held: mk("held", "Heldwidget Group"),
    nc: mk("nc", "Nevercall Widgets"),
    fail: mk("fail", "Outsidewidget Ltd"),
    noid: mk("noid", "Nowidget Id Co"),
    unchecked: mk("unchecked", "Uncheckedwidget Co"),
    oldlook: mk("oldlook", "Oldlookwidget Co"),
    newlook: mk("newlook", "Newlookwidget Co"),
  };
  const rows = {
    ok1: await addCompanyRow(A, tA.companies, { record: co.ok1.record }),
    held: await addCompanyRow(A, tA.companies, { record: co.held.record, held: 2 }),
    nc: await addCompanyRow(A, tA.companies, { record: co.nc.record, neverContact: true }),
    fail: await addCompanyRow(A, tA.companies, { record: co.fail.record, passes: false, outcome: "Outside the client's area" }),
    noid: await addCompanyRow(A, tA.companies, { record: co.noid.record, aiark: false }),
    unchecked: await addCompanyRow(A, tA.companies, { record: co.unchecked.record, heldCell: false }),
    oldlook: await addCompanyRow(A, tA.companies, { record: co.oldlook.record }),
    newlook: await addCompanyRow(A, tA.companies, { record: co.newlook.record }),
  };
  await pool.query(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, 'aiark:pptest-error-row', 'error')`, [tA.companies]);
  // An earlier run settled one company 100 days ago and another 5 days ago.
  const { rows: [old] } = await pool.query(
    `INSERT INTO aiark_people_runs (client_tag, mode, status, max_people, filters, companies, batches, finished_at)
     VALUES ($1, 'demo', 'done', 1, '{}', 2, 1, now()) RETURNING id`,
    [A]
  );
  created.runs.push(old.id);
  await pool.query(
    `INSERT INTO aiark_people_run_companies (run_id, company_row_id, company_id, batch, state, settled_at)
     VALUES ($1, $2, $3, 0, 'settled', now() - interval '100 days'), ($1, $4, $5, 0, 'settled', now() - interval '5 days')`,
    [old.id, rows.oldlook, co.oldlook.record.id, rows.newlook, co.newlook.record.id]
  );
  const el = await eligibleCompanies(pool, { tag: A, recheckDays: 90, tableId: tA.companies });
  const got = new Set(el.map((x) => x.company_row_id));
  check("passing, with an AI Ark id and nobody held: taken", got.has(rows.ok1) && el.find((x) => x.company_row_id === rows.ok1)?.company_id === co.ok1.record.id);
  check("someone usable held there (held_people), never contact, failing the rules, no AI Ark id, not checked: left out", ![rows.held, rows.nc, rows.fail, rows.noid, rows.unchecked].some((r) => got.has(r)));
  check("settled within recheck_days left out, settled before it taken again", !got.has(rows.newlook) && got.has(rows.oldlook));
  check("exactly those two", el.length === 2, JSON.stringify(el));
  const counts = await eligibilityCounts(pool, { tag: A, recheckDays: 90, tableId: tA.companies });
  check("the panel's counts say why", counts.eligible === 2 && counts.held === 1 && counts.notChecked === 1 && counts.looked === 1 && counts.noId === 1 && counts.passing === 6, JSON.stringify(counts));
  check("skip_company_when_held off takes the held company too", (await eligibleCompanies(pool, { tag: A, tableId: tA.companies, skipHeld: false })).some((x) => x.company_row_id === rows.held));
  check("a shorter recheck_days takes the company settled 5 days ago", (await eligibleCompanies(pool, { tag: A, recheckDays: 3, tableId: tA.companies })).some((x) => x.company_row_id === rows.newlook));
  check("another client's table is never read", (await eligibleCompanies(pool, { tag: C })).length === 0);
  // The old run's company entries are only for this check.
  await pool.query(`DELETE FROM aiark_people_run_companies WHERE run_id = $1`, [old.id]);
  await pool.query(`DELETE FROM enrich_rows WHERE id = ANY($1::bigint[])`, [Object.values(rows)]);
  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tA.companies]);
}

async function partB2() {
  section("B2. Starting a run");
  const tA = world.tA;
  let why = null;
  const refusedWith = async (t, opts) => {
    try {
      await newPeopleRun(t, opts);
      return null;
    } catch (e) {
      return e instanceof PeopleRunRefused ? e.message : `other: ${e.message}`;
    }
  };
  why = await refusedWith(OFF);
  check("a client not on people_pipeline.tags is refused", /not on the people runs' client list/.test(why ?? ""), why);
  why = await refusedWith(A, { settings: settingsFrom([{ key: "people_pipeline", value: { enabled: false, tags: [A] } }, { key: "people_tracks", value: TRACKS_FIX }]) });
  check("people runs off: refused", /People runs are off/.test(why ?? ""), why);
  why = await refusedWith(A, { settings: settingsFrom([{ key: "people_pipeline", value: { enabled: true, tags: [A] } }]) });
  check("no people tracks loaded: refused", /people tracks are not loaded/.test(why ?? ""), why);
  why = await refusedWith(A);
  check("no eligible company: refused, nothing written", /No company of .* is ready/.test(why ?? "") && (await one(`SELECT count(*)::int AS n FROM aiark_people_runs WHERE client_tag = $1 AND status = 'queued'`, [A])).n === 0, why);

  // The main client's companies for the Look: one each for every way the screen can go.
  const term = EXCLUDE_TERM.charAt(0).toUpperCase() + EXCLUDE_TERM.slice(1);
  const mk = (label, name, ok) => findCompany(label, name, ok);
  const two = (track) => (ps) => normal(3)(ps) && ps.filter((p) => trackOf(p.title, TRACKS_FIX).track === track).length >= 2;
  // Every track's best-ranked person has an email: all three are bought with one, so the company is listed.
  const bestHaveEmails = (ps) => ["operations", "facility_office", "ceo"].every((t) => bestOf(ps, t)?.email.found);
  const co = {
    p1: mk("p1", "Alpha Widget Partners", (ps) => normal(4)(ps) && threeTracks(ps) && bestHaveEmails(ps)),
    p2: mk("p2", "Beta Widget Partners", two("ceo")),
    held: mk("heldname", "Gamma Widget Partners", normal(3)),
    nc: mk("ncname", "Delta Widget Partners", normal(3)),
    bounced: mk("bounced", "Epsilon Widget Partners", normal(3)),
    out: mk("out", "Zeta Widget Partners", (ps) => ps.length >= 3 && allTracked(ps) && ps.some((p) => !inside(p)) && ps.some(inside)),
    excl: mk("excl", `${term} Widget Services`, normal(3)),
    notrack: mk("notrack", "Eta Widget Partners", (ps) => ps.length >= 3 && ps.every(inside) && ps.some((p) => !trackOf(p.title, TRACKS_FIX))),
    reg: mk("reg", "Theta Widget Partners", normal(3)),
    tabcopy: mk("tabcopy", "Iota Widget Partners", normal(3)),
    noemail: mk("noemail", "Kappa Widget Partners", normal(3)),
    empty: mk("empty", "Lambda Widget Partners", (ps) => ps.length === 0),
  };
  world.co = co;
  const rows = {};
  for (const [k, v] of Object.entries(co)) rows[k] = await addCompanyRow(A, tA.companies, { record: v.record });
  world.rows = rows;
  world.rowOf = (id) => Object.entries(co).find(([, v]) => v.record.id === id)?.[0];

  // The database and the registry, as the screen will meet them.
  await leadFor(co.held.people[0]);
  await leadFor(co.nc.people[0], { is_suppressed: true });
  await leadFor(co.bounced.people[0], { is_bounced: true, bounce_type: "hard" });
  const { rows: [other] } = await pool.query(
    `INSERT INTO aiark_people_runs (client_tag, mode, status, max_people, filters, finished_at) VALUES ($1, 'demo', 'done', 1, '{}', now()) RETURNING id`,
    [B2]
  );
  created.runs.push(other.id);
  world.otherRun = other.id;
  const tx0 = createDemoTransport({ companies: [co.reg.record] });
  const full = (await createAiArk({ token: DEMO_TOKEN, transport: tx0, wait: fastWait }).preview(buildPeopleAtCompanies({ companyIds: [co.reg.record.id], tracks: TRACKS_FIX }).bodies[0])).content[0];
  const regPerson = co.reg.people[0];
  const regRecord = { ...full, profile: { ...full.profile, last_name: regPerson.last, full_name: `${regPerson.first} ${regPerson.last}` }, email: { state: "DONE", output: [{ address: `reg.${RUN.toLowerCase()}@${TEST_HOST}`, status: "VALID", domainType: "SMTP" }] } };
  await pool.query(
    `INSERT INTO aiark_people (person_id, demo, run_id, row_id, email, email_status, company_id, record, people_run_id)
     VALUES ($1, true, NULL, NULL, $2, 'VALID', $3, $4, $5)`,
    [regPerson.id, `reg.${RUN.toLowerCase()}@${TEST_HOST}`, co.reg.record.id, JSON.stringify(regRecord), other.id]
  );
  // The AI Ark tab's purchase keeps no record: the tab row's own cells hold the full name.
  const { rows: [tabTable] } = await pool.query(
    `INSERT INTO enrich_tables (client_tag, kind, name, source_note) VALUES ($1, 'ai_ark', $2, 'people test') RETURNING id`,
    [TAB, `People test tab copy ${RUN}`]
  );
  created.tables.push(tabTable.id);
  const tabPerson = co.tabcopy.people[0];
  const { rows: [tabRow] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, $2, 'done') RETURNING id`, [tabTable.id, `aiark:${tabPerson.id}`]);
  const tabCells = { full_name: `${tabPerson.first} ${tabPerson.last}`, first_name: tabPerson.first, last_name: tabPerson.last, linkedin: `https://linkedin.example/in/${tabPerson.id.slice(0, 8)}`, title: tabPerson.title, email_domain_type: "SMTP" };
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
     SELECT $1, kv.key, $2, 'done', to_jsonb(kv.value), left(kv.value, 300) FROM jsonb_each_text($3::jsonb) AS kv`,
    [tabRow.id, tabTable.id, JSON.stringify(tabCells)]
  );
  await pool.query(
    `INSERT INTO aiark_people (person_id, demo, run_id, row_id, email, email_status) VALUES ($1, true, NULL, $2, $3, 'VALID')`,
    [tabPerson.id, tabRow.id, `tab.${RUN.toLowerCase()}@${TEST_HOST}`]
  );
  await pool.query(`INSERT INTO aiark_people (person_id, demo, run_id, people_run_id) VALUES ($1, true, NULL, $2)`, [co.noemail.people[0].id, other.id]);
  for (const p of [regPerson, tabPerson, co.noemail.people[0]]) created.persons.add(p.id);
  world.tabCells = tabCells;

  const run = await newPeopleRun(A, { maxPeople: 30 });
  world.run = run;
  const entries = await all(`SELECT * FROM aiark_people_run_companies WHERE run_id = $1`, [run.id]);
  check("the run is queued with its companies in one batch", run.status === "queued" && run.companies === Object.keys(co).length && run.batches === 1 && entries.length === Object.keys(co).length && entries.every((e) => e.batch === 0 && e.state === "waiting"));
  check("... its two sources on the People table: bought, and copied free", Boolean(run.source_id && run.registry_source_id) && run.people_table_id === tA.people && run.companies_table_id === tA.companies);
  check("... what was asked: tracks, excluded titles, the switches' values", run.filters.tracks.order.join() === TRACKS_FIX.order.join() && run.filters.exclude_titles_from === "none" && run.filters.ids_per_search === 50 && run.filters.pages_per_search === 5 && run.filters.tries_per_track === 1 && run.max_people === 30);
  why = await refusedWith(A);
  check("one run per client: a second is refused while the first is going", /already has a people run going/.test(why ?? ""), why);
  const cleaningRun = await (async () => {
    const tC = await testTables(pool, C);
    created.tables.push(tC.companies, tC.inboxes, tC.people);
    const cc = findCompany("cl", "Cleanwidget Co", normal(3));
    await addCompanyRow(C, tC.companies, { record: cc.record });
    return newPeopleRun(C);
  })();
  check("a cleaning client's run leaves out the cleaning titles and asks with the people keywords", cleaningRun.filters.cleaning === true && cleaningRun.filters.exclude_titles_from === "cleaning" && cleaningRun.filters.exclude_titles.length === CLEANING_EXCLUDE_TITLES.length);
  await cancelPeopleRun(pool, { runId: cleaningRun.id });

  // Two clicks at once: the lock lets one through.
  const tK = await testTables(pool, MONEY);
  created.tables.push(tK.companies, tK.inboxes, tK.people);
  world.tK = tK;
  const kco = findCompany("k1", "Kwidget Holdings", normal(3));
  await addCompanyRow(MONEY, tK.companies, { record: kco.record });
  const both = await Promise.allSettled([newPeopleRun(MONEY), newPeopleRun(MONEY)]);
  check("two starts at once for one client: one run, the other refused", both.filter((x) => x.status === "fulfilled").length === 1 && both.filter((x) => x.status === "rejected" && x.reason instanceof PeopleRunRefused).length === 1);
  await endTestRuns();
  await pool.query(`UPDATE aiark_people_runs SET status = 'queued', finished_at = NULL WHERE id = $1`, [run.id]);
}

async function partB3() {
  section("B3. The Look and its free screen");
  const { run, co, rows, tA } = world;
  const tx = counted(createDemoTransport({ companies: Object.values(co).map((v) => v.record), balance: 5_000 }));
  world.tx = tx;
  const cf = demoClient(tx);
  world.cf = cf;
  const status = await drive(run.id, cf);
  const r = await runOf(run.id);
  const cands = await candidatesOf(run.id);
  const seen = Object.values(co).reduce((n, v) => n + v.people.length, 0);
  check("the Look stops in looked, waiting for Buy (auto_buy off)", status === "looked" && r.progress.look_done === true, `${status} ${r.last_error ?? ""}`);
  check("everyone seen is a candidate, once", cands.length === seen && new Set(cands.map((c) => c.person_id)).size === seen && r.looked === seen, `${cands.length} vs ${seen}`);
  check("one Preview page for the batch: 1 credit", r.pages === 1 && Number(r.credits_used) === 1 && tx.state.charged === 1 && tx.n.preview === 1);
  check("no People row for candidates: only the copies", (await rowsIn(tA.people)) === 2);
  const byP = new Map(cands.map((c) => [c.person_id, c]));
  const v = (k, i = 0) => byP.get(co[k].people[i].id)?.verdict;
  check("a held lead with the name and company: held", v("held") === "held" && byP.get(co.held.people[0].id).held_lead_id != null);
  check("never contact and bounced, by name and company", v("nc") === "never_contact" && v("bounced") === "bounced");
  const outP = co.out.people.find((p) => !inside(p));
  check("someone whose own place is outside the client's area: outside", byP.get(outP.id)?.verdict === "outside");
  check("a company the client's rules exclude: every candidate there excluded", co.excl.people.every((p) => byP.get(p.id)?.verdict === "excluded"));
  const noTrack = co.notrack.people.find((p) => !trackOf(p.title, TRACKS_FIX));
  check("a title in no track: no_track", byP.get(noTrack.id)?.verdict === "no_track" && byP.get(noTrack.id)?.track === null);
  check("someone another run bought: bought_before", v("reg") === "bought_before" && v("tabcopy") === "bought_before" && v("noemail") === "bought_before");
  const c0 = byP.get(co.p1.people[0].id);
  const want = trackOf(co.p1.people[0].title, TRACKS_FIX);
  check("a candidate keeps track, rank, masked name, own place, seniority and company", c0.verdict === "candidate" && c0.track === want.track && c0.rank === want.rank && c0.last_name.includes("***") && c0.city === "Springfield" && c0.region === "Illinois" && c0.country === "United States" && c0.company_row_id === String(rows.p1) && c0.company_id === co.p1.record.id && Boolean(c0.seniority));
  const regRow = await one(`SELECT r.id, r.source_id FROM enrich_rows r WHERE r.table_id = $1 AND r.row_key = $2`, [tA.people, `aiark:${co.reg.people[0].id}`]);
  const regCells = regRow ? await cellsOf(regRow.id) : {};
  check("a registry person with an email is copied free as a People row (stage copied)", Boolean(regRow) && regRow.source_id === run.registry_source_id && regCells.stage === "copied" && regCells.email === `reg.${RUN.toLowerCase()}@${TEST_HOST}` && regCells.find_people_from_linkedin_company_url?.last_name === co.reg.people[0].last && /people run/.test(regCells.pulled_before ?? ""));
  const tabRow = await one(`SELECT id FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tA.people, `aiark:${co.tabcopy.people[0].id}`]);
  const tabCells = tabRow ? await cellsOf(tabRow.id) : {};
  check("a registry row with no record takes the tab row's name, LinkedIn URL and title: no masked name copied", Boolean(tabRow) && tabCells.person_last_name === world.tabCells.last_name && tabCells.find_people_from_linkedin_company_url?.name === world.tabCells.full_name && tabCells.find_people_from_linkedin_company_url?.url === world.tabCells.linkedin && !JSON.stringify(tabCells).includes("***"));
  check("a registry person with no email is not copied (D27)", !(await one(`SELECT 1 AS x FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tA.people, `aiark:${co.noemail.people[0].id}`])));
  check("the copies are counted and their candidates point at them", r.copied === 2 && byP.get(co.reg.people[0].id).row_id === String(regRow?.id) && byP.get(co.noemail.people[0].id).row_id === null);
  check("a company AI Ark has nobody at costs nothing more", !cands.some((c) => c.company_row_id === String(rows.empty)));
  const pageAgain = await (async () => {
    await pool.query(`UPDATE aiark_people_runs SET progress = progress - 'look_done' || '{"batch": 0, "body": 0, "page": 0}'::jsonb, status = 'queued', next_run_at = now() WHERE id = $1`, [run.id]);
    await step(cf);
    const n = (await candidatesOf(run.id)).length;
    await pool.query(`UPDATE aiark_people_runs SET progress = progress || '{"look_done": true, "batch": 1}'::jsonb, status = 'looked' WHERE id = $1`, [run.id]);
    return n;
  })();
  check("a page seen again writes nobody twice (ON CONFLICT)", pageAgain === seen && (await rowsIn(tA.people)) === 2);
  world.charged = tx.state.charged;
}

async function partB4() {
  section("B4. The pick");
  const { run, co, rows } = world;
  const cands = await candidatesOf(run.id);
  const entries = new Map((await all(`SELECT * FROM aiark_people_run_companies WHERE run_id = $1`, [run.id])).map((e) => [Number(e.company_row_id), e]));
  const picked = cands.filter((c) => c.pick === "picked");
  const per = new Map();
  for (const c of picked) per.set(`${c.company_row_id}|${c.track}`, (per.get(`${c.company_row_id}|${c.track}`) ?? 0) + 1);
  check("at most one pick per company and track", [...per.values()].every((n) => n === 1));
  const p1 = picked.filter((c) => Number(c.company_row_id) === rows.p1);
  check("a company with people in all three tracks: one picked in each", p1.length === 3 && new Set(p1.map((c) => c.track)).size === 3);
  check("the best-ranked candidate of the track is the one picked", p1.every((c) => c.person_id === bestOf(co.p1.people, c.track)?.id));
  check("a company where someone is held is skipped whole", entries.get(rows.held).state === "skipped_held" && entries.get(rows.held).settled_at && !cands.some((c) => Number(c.company_row_id) === rows.held && c.pick !== "none"));
  const regTrack = trackOf(co.reg.people[0].title, TRACKS_FIX).track;
  check("a track a registry copy covers is not bought again", !picked.some((c) => Number(c.company_row_id) === rows.reg && c.track === regTrack));
  const neTrack = trackOf(co.noemail.people[0].title, TRACKS_FIX).track;
  const neOthers = co.noemail.people.slice(1).filter((p) => trackOf(p.title, TRACKS_FIX).track === neTrack);
  check("... but one a no-email registry person is in still is", neOthers.length === 0 || picked.some((c) => Number(c.company_row_id) === rows.noemail && c.track === neTrack));
  check("no reserves while tries_per_track is 1", !cands.some((c) => c.pick === "reserve"));
  check("excluded, outside and no-track people are never picked", !cands.some((c) => c.pick !== "none" && c.verdict !== "candidate"));
  const r = await runOf(run.id);
  check("the run counts its picks and the companies skipped", r.picked === picked.length && r.skipped_held === 1);
  check("companies with a pick are 'picked', those without 'looked'", entries.get(rows.p1).state === "picked" && entries.get(rows.excl).state === "looked" && entries.get(rows.empty).state === "looked");
  check("the pause says what Buy costs at most: the picks", picked.length === r.picked && r.status === "looked" && !r.buy_approved_at);
  world.picked = picked;
}

async function partB5() {
  section("B5. The pause and the Buy");
  const { run, tA, tx, cf, picked } = world;
  const calls = tx.n.single;
  check("while looked, no slice buys anyone", (await step(cf)) === null && tx.n.single === calls && (await runOf(run.id)).status === "looked");
  check("peopleRunDue: nothing due while it waits for Buy", (await peopleRunDue(pool)) === false);
  const ok = await approveBuy(pool, { runId: run.id, userId: T.userId });
  const r1 = await runOf(run.id);
  check("Buy (approveBuy): queued again, with who and when", ok && r1.status === "queued" && r1.buy_approved_by === T.userId && r1.buy_approved_at);
  check("a second Buy is refused: the run is no longer looked", (await approveBuy(pool, { runId: run.id, userId: T.userId })) === null);
  check("peopleRunDue: due now", (await peopleRunDue(pool)) === true);
  const before = tx.state.charged;
  const st = await drive(run.id, cf, { until: new Set([...TERMINAL]), limit: 12, onWait: async () => {} }).catch(() => "waiting");
  const cands = await candidatesOf(run.id);
  const bought = cands.filter((c) => c.pick === "bought");
  const noEmail = cands.filter((c) => c.pick === "no_email");
  check("every pick bought with one Export Single each", bought.length + noEmail.length === picked.length && tx.n.single === picked.length, `${bought.length}+${noEmail.length} of ${picked.length}, ${tx.n.single} calls`);
  check("... 1 credit each with an email, none without", tx.state.charged - before === bought.length && Number((await runOf(run.id)).credits_used) === world.charged + bought.length);
  check("the run waits while the People rows are being worked", st === "waiting" && (await runOf(run.id)).status === "running");
  const rowsBought = await all(
    `SELECT r.id, r.run_status, r.source_id, r.row_key FROM enrich_rows r WHERE r.table_id = $1 AND r.source_id = $2 ORDER BY r.id`,
    [tA.people, run.source_id]
  );
  check("a People row for each person bought, queued for the template's steps", rowsBought.length === picked.length && rowsBought.every((x) => x.run_status === "queued"));
  const some = bought[0] ? await cellsOf(bought[0].row_id) : {};
  check("... with an email: stage bought, AI Ark's email and its check, the full name", some.stage === "bought" && /@/.test(some.email ?? "") && some.aiark_email_status === "VALID" && !String(some.person_last_name ?? "").includes("*"));
  const none = noEmail[0] ? await cellsOf(noEmail[0].row_id) : null;
  check("... with no email: stage no_email, no email cell (kept, D27)", noEmail.length === 0 || (none.stage === "no_email" && !none.email));
  const reg = await all(`SELECT * FROM aiark_people WHERE people_run_id = $1`, [run.id]);
  check("each one in the registry: the company, AI Ark's record, this run, no tab run", reg.length === picked.length && reg.every((x) => x.run_id === null && x.company_id && x.record && x.row_id));
  check("... the email of those that had one", reg.filter((x) => x.email).length === bought.length);
  const r2 = await runOf(run.id);
  check("the run's counters", r2.bought === picked.length && r2.with_email === bought.length);
  for (const x of reg) created.persons.add(x.person_id);
  world.bought = bought;
  world.noEmail = noEmail;
}

async function partB6() {
  section("B6. Settling, and the company row queued again");
  const { run, tA, cf, rows, co } = world;
  const finished = await finishPeopleRows(tA.people, A);
  check("the People rows finished (the template's part, stood in for here)", finished === world.picked.length + 2, String(finished));
  const st = await drive(run.id, cf, { until: TERMINAL, limit: 30 });
  const r = await runOf(run.id);
  const entries = new Map((await all(`SELECT * FROM aiark_people_run_companies WHERE run_id = $1`, [run.id])).map((e) => [Number(e.company_row_id), e]));
  check("every company settled, and the run done with the balance after", st === "done" && [...entries.values()].every((e) => ["settled", "skipped_held"].includes(e.state) && e.settled_at) && r.credits_after != null && r.finished_at, `${st} ${r.stop_reason ?? ""} ${r.last_error ?? ""}`);
  const p1 = entries.get(rows.p1);
  const found = new Set((await all(`SELECT track FROM enrich_contacts WHERE company_row_id = $1 AND kind = 'person' AND usable`, [rows.p1])).map((x) => x.track));
  check("each track's state recorded: tried, found and settled", ["operations", "facility_office", "ceo"].every((t) => p1.tracks[t]?.settled === true && p1.tracks[t].found === found.has(t) && p1.tracks[t].tried === 1) && p1.found === found.size);
  const requeued = await all(`SELECT id, run_status FROM enrich_rows WHERE id = ANY($1::bigint[])`, [Object.values(rows)]);
  check("the settled companies' rows are queued again (the second pass)", requeued.every((x) => x.run_status === "queued"), JSON.stringify(requeued.filter((x) => x.run_status !== "queued")));
  check("... and their people_settled_at stamped", (await one(`SELECT count(*)::int AS n FROM enrich_companies WHERE row_id = ANY($1::bigint[]) AND people_settled_at IS NOT NULL`, [Object.values(rows)])).n === Object.keys(rows).length);
  const pac = await PIPELINE_ACTIONS.people_at_company.run({ inputs: { held: 0 }, row: { id: rows.p1 }, db: pool });
  check("people_at_company reads the settled run: looked, settled, every track settled", pac.status === "done" && pac.value.looked && pac.value.settled && pac.value.sources.ai_ark === "settled" && ["operations", "facility_office", "ceo"].every((t) => pac.value.tracks[t].settled));
  check("... found from the contacts: approved emails count", ["operations", "facility_office", "ceo"].every((t) => pac.value.tracks[t].found === found.has(t)) && pac.value.usable === found.size);
  const heldPac = await PIPELINE_ACTIONS.people_at_company.run({ inputs: { held: 0 }, row: { id: rows.held }, db: pool });
  check("a company skipped because someone is held: skipped_held, every track found", heldPac.value.sources.ai_ark === "skipped_held" && heldPac.value.settled && Object.values(heldPac.value.tracks).every((x) => x.found));
  const listed = await one(`SELECT listed, people_emails FROM enrich_companies WHERE row_id = $1`, [rows.p1]);
  check("a company with an approved person email is listed, with people only (M5)", listed.listed === found.size > 0 && listed.people_emails === found.size);
  check("the sources got their counts", (await one(`SELECT received, created FROM enrich_sources WHERE id = $1`, [run.source_id])).created === world.picked.length && (await one(`SELECT created FROM enrich_sources WHERE id = $1`, [run.registry_source_id])).created === 2);
  check("a settled company is not eligible again within recheck_days", !(await eligibleCompanies(pool, { tag: A, tableId: tA.companies })).some((x) => x.company_row_id === rows.p1));
  const noTrackId = co.notrack.people.find((p) => !trackOf(p.title, TRACKS_FIX)).id;
  check("someone in no track is never bought, and their company still settles", entries.get(rows.notrack).state === "settled" && (await candidatesOf(run.id)).find((c) => c.person_id === noTrackId)?.pick === "none");
  // The second pass is worked by the template's own columns: here only that it is due.
  await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE id = ANY($1::bigint[])`, [Object.values(rows)]);
}

async function partB7() {
  section("B7. Tries per track, a no-email miss and its reserve, a pick bought elsewhere since the Look");
  const tB = await testTables(pool, B2);
  created.tables.push(tB.companies, tB.inboxes, tB.people);
  world.tB = tB;
  // A company with two people in one track: the first has no email, the second has one.
  const pair = findCompany("pair", "Muwidget Partners", (ps) => {
    if (!normal(2)(ps)) return false;
    const ceo = ps.map((p) => ({ p, t: trackOf(p.title, TRACKS_FIX) })).filter((x) => x.t.track === "ceo").sort((a, b) => a.t.rank - b.t.rank || (a.p.id < b.p.id ? -1 : 1));
    return ceo.length >= 2 && !ceo[0].p.email.found && ceo[1].p.email.found;
  });
  const elsewhere = findCompany("elsewhere", "Nuwidget Partners", (ps) => normal(1)(ps) && ps.length >= 1);
  const rowPair = await addCompanyRow(B2, tB.companies, { record: pair.record });
  const rowElse = await addCompanyRow(B2, tB.companies, { record: elsewhere.record });
  const settings = settingsFor(ON_TAGS, { tries_per_track: 2, auto_buy: true });
  const run = await newPeopleRun(B2, { settings });
  const tx = counted(createDemoTransport({ companies: [pair.record, elsewhere.record], balance: 5_000 }));
  const cf = demoClient(tx);
  // Look only: stop before the first Buy, then register one pick as bought by someone else.
  for (let i = 0; i < 20 && !(await runOf(run.id)).progress.look_done; i++) if (!(await step(cf, { settings }))) await due(run.id);
  const cands = await candidatesOf(run.id);
  const ceo = cands.filter((c) => Number(c.company_row_id) === rowPair && c.track === "ceo").sort((a, b) => a.rank - b.rank || (a.person_id < b.person_id ? -1 : 1));
  check("tries_per_track 2: the best picked, the next in reserve", ceo[0]?.pick === "picked" && ceo[1]?.pick === "reserve");
  const stolen = cands.find((c) => Number(c.company_row_id) === rowElse && c.pick === "picked");
  await pool.query(`INSERT INTO aiark_people (person_id, demo, run_id, email, email_status) VALUES ($1, true, NULL, $2, 'VALID')`, [stolen.person_id, `stolen.${RUN.toLowerCase()}@${TEST_HOST}`]);
  created.persons.add(stolen.person_id);
  const singles = tx.n.single;
  const st = await drive(run.id, cf, { until: TERMINAL, limit: 60, extra: { settings }, onWait: () => finishPeopleRows(tB.people, B2) });
  const after = await candidatesOf(run.id);
  const ceoAfter = after.filter((c) => Number(c.company_row_id) === rowPair && c.track === "ceo").sort((a, b) => a.rank - b.rank || (a.person_id < b.person_id ? -1 : 1));
  check("auto_buy on: no pause, the run buys and finishes", st === "done" && !(await runOf(run.id)).buy_approved_at, `${st} ${(await runOf(run.id)).last_error ?? ""}`);
  check("the first had no email: a no_email row, 0 credits, then the reserve bought", ceoAfter[0].pick === "no_email" && ceoAfter[1].pick === "bought" && Boolean(ceoAfter[0].row_id) && Boolean(ceoAfter[1].row_id));
  const s = after.find((c) => c.person_id === stolen.person_id);
  const sRow = await one(`SELECT id FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tB.people, `aiark:${stolen.person_id}`]);
  check("a pick someone else bought since the Look is copied free, never bought again", s.verdict === "bought_before" && s.pick === "none" && Boolean(sRow) && String(s.row_id) === String(sRow.id) && (await cellsOf(sRow.id)).stage === "copied");
  const r = await runOf(run.id);
  check("credits: the Look's page and one per email found, nothing for the miss or the copy", Number(r.credits_used) === tx.state.charged && tx.state.charged === 1 + after.filter((c) => c.pick === "bought").length && tx.n.single - singles === after.filter((c) => ["bought", "no_email"].includes(c.pick)).length);
  for (const x of await all(`SELECT person_id FROM aiark_people WHERE people_run_id = $1`, [run.id])) created.persons.add(x.person_id);
}

async function partB8() {
  section("B8. Money: the brake, lost answers, out of credits, the key, too fast");
  const tK = world.tK;
  const fresh = async (label) => {
    await endTestRuns();
    await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tK.companies]);
    const co = findCompany(label, `${label} Widget Co`, (ps) => normal(3)(ps) && ps.filter((p) => p.email.found).length >= 1);
    const row = await addCompanyRow(MONEY, tK.companies, { record: co.record });
    const run = await newPeopleRun(MONEY, { maxPeople: 5 });
    return { co, row, run };
  };
  // The brake: what is spent, lost answers at full price, may never pass the ceiling.
  const b = await fresh("brake");
  const ceiling = peopleSpendCeiling(b.run);
  await pool.query(`UPDATE aiark_people_runs SET credits_used = $2 WHERE id = $1`, [b.run.id, ceiling]);
  const txB = counted(createDemoTransport({ companies: [b.co.record], balance: 5_000 }));
  const stB = await drive(b.run.id, demoClient(txB), { until: TERMINAL });
  check("the brake stops the run before a call could pass it", stB === "stopped" && /spending brake/.test((await runOf(b.run.id)).stop_reason ?? "") && txB.n.preview === 0, `${stB}`);

  // Lost answers count at full price; 5 in a row back the run off.
  const l = await fresh("lost");
  await pool.query(`UPDATE aiark_people_runs SET max_people = 6 WHERE id = $1`, [l.run.id]);
  const txL0 = createDemoTransport({ companies: [l.co.record], balance: 5_000 });
  let lose = 0;
  const txL = counted(overlay(txL0, async (req) => {
    if (isSingle(req) && lose > 0) {
      lose--;
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    }
    return undefined;
  }));
  const cfL = demoClient(txL);
  await drive(l.run.id, cfL);
  await approveBuy(pool, { runId: l.run.id, userId: null });
  lose = 1;
  await step(cfL);
  const l1 = await runOf(l.run.id);
  const lostCand = (await candidatesOf(l.run.id)).find((c) => c.pick === "lost");
  check("a lost Export Single answer: counted at 1 credit, the person not bought again, left unregistered", l1.lost_answers === 1 && Number(l1.progress.lost_credits) === 1 && Boolean(lostCand) && !(await one(`SELECT 1 AS x FROM aiark_people WHERE person_id = $1`, [lostCand.person_id])));
  check("... and the brake counts it", peopleSpendCeiling(l1) > 0 && Number(l1.credits_used) + Number(l1.progress.lost_credits) >= 1);
  await endTestRuns();
  const m = await fresh("lost5");
  const many = findCompany("lost5b", "Lostfive Widget Co", (ps) => normal(3)(ps) && threeTracks(ps));
  await addCompanyRow(MONEY, tK.companies, { record: many.record });
  const twin = findCompany("lost5c", "Lostfive Twin Co", (ps) => normal(3)(ps) && threeTracks(ps));
  await addCompanyRow(MONEY, tK.companies, { record: twin.record });
  await pool.query(`DELETE FROM aiark_people_runs WHERE id = $1`, [m.run.id]);
  const m2 = await newPeopleRun(MONEY, { maxPeople: 20 });
  const txM0 = createDemoTransport({ companies: [m.co.record, many.record, twin.record], balance: 5_000 });
  const txM = counted(overlay(txM0, async (req) => (isSingle(req) ? Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })) : undefined)));
  const cfM = demoClient(txM);
  await drive(m2.id, cfM);
  await approveBuy(pool, { runId: m2.id, userId: null });
  await step(cfM);
  const mr = await runOf(m2.id);
  check("5 lost answers in a row: the run backs off, each counted", mr.status === "running" && mr.lost_answers === 5 && mr.attempts === 1 && new Date(mr.next_run_at) > new Date() && /did not answer/.test(mr.last_error ?? ""), JSON.stringify({ s: mr.status, l: mr.lost_answers, a: mr.attempts }));
  await endTestRuns();

  // Out of credits (402) stops; the key (401) errors; too fast (429) waits.
  const o = await fresh("credits");
  const txO = createDemoTransport({ companies: [o.co.record], balance: 5_000, faults: { previewAnswers: [402] } });
  check("402 on a Preview: stopped, out of credits", (await drive(o.run.id, demoClient(txO), { until: TERMINAL })) === "stopped" && /out of credits/.test((await runOf(o.run.id)).stop_reason ?? ""));
  const k = await fresh("key");
  const txK = createDemoTransport({ companies: [k.co.record], balance: 5_000, faults: { previewAnswers: [401] } });
  check("401 on a Preview: the run ends in error, about the key", (await drive(k.run.id, demoClient(txK), { until: TERMINAL })) === "error" && /key/.test((await runOf(k.run.id)).last_error ?? ""));
  const w = await fresh("wait");
  const txW = counted(createDemoTransport({ companies: [w.co.record], balance: 5_000, faults: { previewAnswers: [429, 429] } }));
  check("429: waited out (Retry-After), then the page is bought once", (await drive(w.run.id, demoClient(txW))) === "looked" && txW.n.preview === 3 && txW.state.charged === 1);
  await endTestRuns();
  const w7 = await fresh("wait7");
  const txW7 = createDemoTransport({ companies: [w7.co.record], balance: 5_000, faults: { previewAnswers: Array(7).fill(429) } });
  await step(demoClient(txW7));
  const w7r = await runOf(w7.run.id);
  check("429 that never ends: the run backs off and tries later, nothing charged", w7r.status === "running" && w7r.attempts === 1 && new Date(w7r.next_run_at) > new Date() && txW7.state.charged === 0);
  await endTestRuns();

  // 402 on an Export Single stops too.
  const e = await fresh("buy402");
  const txE0 = createDemoTransport({ companies: [e.co.record], balance: 5_000 });
  const txE = overlay(txE0, async (req) => (isSingle(req) ? ans(402, { status: 402, error: "not enough balance" }) : undefined));
  await drive(e.run.id, demoClient(txE));
  await approveBuy(pool, { runId: e.run.id, userId: null });
  check("402 on an Export Single: stopped, nobody written as bought", (await drive(e.run.id, demoClient(txE), { until: TERMINAL })) === "stopped" && (await one(`SELECT bought FROM aiark_people_runs WHERE id = $1`, [e.run.id])).bought === 0);

  // The lowest balance: read free before each paid call.
  const lb = await fresh("lowbal");
  const txLB = counted(createDemoTransport({ companies: [lb.co.record], balance: 500 }));
  check("a balance at the people runs' minimum: stopped before any page", (await drive(lb.run.id, demoClient(txLB), { until: TERMINAL })) === "stopped" && /minimum/.test((await runOf(lb.run.id)).stop_reason ?? "") && txLB.n.preview === 0 && txLB.n.credits >= 1);

  // People runs switched off for the client while a run is going: nothing more is bought.
  const sw = await fresh("switch");
  const txSW = counted(createDemoTransport({ companies: [sw.co.record], balance: 5_000 }));
  check("switched off for the client mid-run: stopped before its next paid call", (await drive(sw.run.id, demoClient(txSW), { until: TERMINAL, extra: { settings: settingsFor([A]) } })) === "stopped" && txSW.n.preview === 0);
}

async function partB9(routes) {
  section("B9. A size refusal, an empty page, the page cap");
  const tK = world.tK;
  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tK.companies]);
  const cos = [];
  for (let i = 0; i < 4; i++) cos.push(findCompany(`half${i}`, `Half${i} Widget Co`, normal(2)));
  for (const c of cos) await addCompanyRow(MONEY, tK.companies, { record: c.record });
  const run = await newPeopleRun(MONEY);
  const txH = counted(createDemoTransport({ companies: cos.map((c) => c.record), balance: 5_000, faults: { previewAnswers: [400] } }));
  const st = await drive(run.id, demoClient(txH));
  const r = await runOf(run.id);
  const batches = await all(`SELECT batch, count(*)::int AS n FROM aiark_people_run_companies WHERE run_id = $1 GROUP BY 1 ORDER BY 1`, [run.id]);
  check("a 400 'request size' refusal: the batch is halved and asked again, free", st === "looked" && r.batches === 2 && batches.map((b) => b.n).join() === "2,2" && r.progress.halvings === 1 && txH.state.charged === 2 && Number(r.credits_used) === 2, JSON.stringify({ st, b: r.batches, batches, ch: txH.state.charged }));
  check("... everyone at the 4 companies still seen", (await candidatesOf(run.id)).length === cos.reduce((n, c) => n + c.people.length, 0));
  await endTestRuns();

  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tK.companies]);
  const lone = findCompany("lone", "Lone Widget Co", normal(2));
  await addCompanyRow(MONEY, tK.companies, { record: lone.record });
  const run1 = await newPeopleRun(MONEY);
  const tx1 = createDemoTransport({ companies: [lone.record], balance: 5_000, faults: { previewAnswers: [400] } });
  check("one company refused as too large: the run ends in error with AI Ark's message", (await drive(run1.id, demoClient(tx1), { until: TERMINAL })) === "error" && /too large even for one company/.test((await runOf(run1.id)).last_error ?? ""));

  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tK.companies]);
  const e = findCompany("e404", "Empty Widget Co", normal(2));
  await addCompanyRow(MONEY, tK.companies, { record: e.record });
  const run2 = await newPeopleRun(MONEY);
  const tx2 = createDemoTransport({ companies: [e.record], balance: 5_000, faults: { previewAnswers: [404] } });
  const st2 = await drive(run2.id, demoClient(tx2));
  const r2 = await runOf(run2.id);
  check("404 (nobody there): the batch ends after that page, nobody seen", ["looked", "done"].includes(st2) && (await candidatesOf(run2.id)).length === 0 && r2.pages === 1, `${st2}`);
  await endTestRuns();
  if (st2 !== "done") await drive(run2.id, demoClient(tx2), { until: TERMINAL }).catch(() => {});

  // More than a page of people: pages_per_search caps the batch (R24).
  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tK.companies]);
  const crowd = [];
  for (let i = 0; i < 30; i++) crowd.push(findCompany(`crowd${i}`, `Crowd${i} Widget Co`, (ps) => ps.length >= 7 && ps.every(inside)));
  for (const c of crowd) await addCompanyRow(MONEY, tK.companies, { record: c.record });
  const capped = settingsFor(ON_TAGS, { pages_per_search: 2 });
  const run3 = await newPeopleRun(MONEY, { settings: capped });
  world.crowdRun = run3.id;
  const tx3 = counted(createDemoTransport({ companies: crowd.map((c) => c.record), balance: 5_000 }));
  await drive(run3.id, demoClient(tx3), { extra: { settings: capped } });
  const r3 = await runOf(run3.id);
  const people = crowd.reduce((n, c) => n + c.people.length, 0);
  check("more people than two pages, two pages a search: the rest are not looked at, and it is noted", people > 200 && tx3.n.preview === 2 && (await candidatesOf(run3.id)).length === 200 && JSON.stringify(r3.progress.capped) === "[0]" && Number(r3.credits_used) === 2, `${people} people, ${tx3.n.preview} pages`);
  const pages = [];
  const sizes = [];
  let after = null;
  for (let i = 0; i < 10; i++) {
    const pg = await call(routes.candidates.GET, { query: { id: run3.id, ...(after ? { after } : {}) } });
    pages.push(...(pg.body.rows ?? []));
    sizes.push(pg.body.rows?.length ?? -1);
    after = pg.body.next;
    if (!after) break;
  }
  const allC = await candidatesOf(run3.id);
  check("the run's candidates through their route: every one once, in pages of 100, with verdicts and picks", sizes.join() === "100,100" && pages.length === allC.length && new Set(pages.map((x) => x.person_id)).size === allC.length && pages.every((x) => x.verdict && x.pick), sizes.join());
  check("... a bad cursor: 400", (await call(routes.candidates.GET, { query: { id: run3.id, after: "nope" } })).status === 400);
  await endTestRuns();
}

async function partB10() {
  section("B10. One run per client, cancel, a crash mid-slice");
  const tK = world.tK;
  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tK.companies]);
  const co = findCompany("cancel", "Cancel Widget Co", (ps) => normal(3)(ps) && ps.some((p) => p.email.found));
  await addCompanyRow(MONEY, tK.companies, { record: co.record });
  const run = await newPeopleRun(MONEY);
  check("activePeopleRun finds it", (await activePeopleRun(pool, MONEY))?.id === run.id);
  const tx = counted(createDemoTransport({ companies: [co.record], balance: 5_000 }));
  const cf = demoClient(tx);
  await drive(run.id, cf);
  const c1 = await cancelPeopleRun(pool, { runId: run.id });
  const calls = { ...tx.n };
  for (let i = 0; i < 3; i++) await step(cf);
  check("cancel: no paid call after it, the run stays cancelled", c1 && (await runOf(run.id)).status === "cancelled" && tx.n.preview === calls.preview && tx.n.single === calls.single);
  check("cancel of a run that is not going: refused", (await cancelPeopleRun(pool, { runId: run.id })) === null);

  // Cancel seen mid-Buy, before the next Export Single.
  const run2 = await newPeopleRun(MONEY);
  await drive(run2.id, cf);
  await approveBuy(pool, { runId: run2.id, userId: null });
  let cancelled = false;
  const txC = counted(overlay(tx, async (req) => {
    if (isSingle(req) && !cancelled) {
      cancelled = true;
      await pool.query(`UPDATE aiark_people_runs SET status = 'cancelled' WHERE id = $1`, [run2.id]);
    }
    return undefined;
  }));
  await step(demoClient(txC));
  check("a cancel during a Buy: the call in flight is written, and no other is made", txC.n.single === 1 && (await runOf(run2.id)).status === "cancelled" && (await runOf(run2.id)).bought === 1);

  // A crash after a Preview page was bought and before it was written: that page is bought again on resume, its people go in once.
  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tK.companies]);
  const co2 = findCompany("crash", "Crash Widget Co", (ps) => normal(3)(ps) && ps.some((p) => p.email.found));
  await addCompanyRow(MONEY, tK.companies, { record: co2.record });
  const run3 = await newPeopleRun(MONEY);
  const tx3 = counted(createDemoTransport({ companies: [co2.record], balance: 5_000 }));
  const cf3 = demoClient(tx3);
  let failWrites = 8;
  const crashing = {
    query: async (sql, params) => {
      if (failWrites > 0 && sql.includes("INSERT INTO aiark_people_candidates")) {
        failWrites--;
        throw new Error("Connection terminated unexpectedly");
      }
      if (failWrites > 0 && sql.includes("SELECT progress, credits_used::float8 AS used, bought FROM aiark_people_runs")) {
        failWrites--;
        throw new Error("Connection terminated unexpectedly");
      }
      return pool.query(sql, params);
    },
    connect: () => pool.connect(),
  };
  await step(cf3, { pool: crashing });
  await pool.query(`UPDATE aiark_people_runs SET claimed_at = now() - interval '11 minutes' WHERE id = $1`, [run3.id]);
  failWrites = 0;
  await drive(run3.id, cf3);
  const r3 = await runOf(run3.id);
  check("a crash before a page's write: the page bought again on resume (1 credit lost), its people in once", tx3.n.preview === 2 && Number(r3.credits_used) === 1 && tx3.state.charged === 2 && (await candidatesOf(run3.id)).length === co2.people.length, JSON.stringify({ p: tx3.n.preview, used: r3.credits_used }));

  // A crash between an Export Single and its write: counted as lost, never bought twice.
  await approveBuy(pool, { runId: run3.id, userId: null });
  let failBuys = 9;
  const crashingBuy = {
    query: async (sql, params) => {
      if (failBuys > 0 && (sql.includes("INSERT INTO aiark_people (person_id, demo, run_id, row_id, email, email_status, company_id, record, people_run_id)") || sql.includes("SELECT progress, credits_used::float8 AS used, bought FROM aiark_people_runs"))) {
        failBuys--;
        throw new Error("Connection terminated unexpectedly");
      }
      return pool.query(sql, params);
    },
    connect: () => pool.connect(),
  };
  const singlesBefore = tx3.n.single;
  await step(cf3, { pool: crashingBuy, maxBuysPerSlice: 1 });
  const mid = await runOf(run3.id);
  const buying = mid.progress.buying?.person_id;
  await pool.query(`UPDATE aiark_people_runs SET claimed_at = now() - interval '11 minutes' WHERE id = $1`, [run3.id]);
  failBuys = 0;
  await step(cf3, { maxBuysPerSlice: 1 });
  const lostOne = (await candidatesOf(run3.id)).find((c) => c.person_id === buying);
  check("a crash between a buy and its write: that person counted as lost (1 credit), never bought twice", Boolean(buying) && tx3.n.single - singlesBefore === 2 && lostOne?.pick === "lost" && (await runOf(run3.id)).lost_answers === 1, JSON.stringify({ buying, singles: tx3.n.single - singlesBefore, pick: lostOne?.pick }));
  await endTestRuns();
}

async function partB11() {
  section("B11. The AI Ark tab is unchanged");
  const tabRunsBefore = (await one(`SELECT count(*)::int AS n FROM aiark_runs`)).n;
  check("pullsToAdd() reads only the AI Ark tab's runs", !/aiark_people_runs/.test(source("scripts/lib/aiark/add.mjs")) && (await pullsToAdd(pool, 50)).every((x) => !created.runs.includes(x.id)));
  check("the tab's run list and its 'already running' check read aiark_runs only", !/aiark_people_runs/.test(source("src/app/api/aiark/runs/route.ts") + source("scripts/lib/aiark/start-run.mjs")));

  // A tab export job of the same mode not yet read: the people run waits, buying nothing.
  const tK = world.tK;
  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tK.companies]);
  const co = findCompany("waitjob", "Waitjob Widget Co", normal(2));
  await addCompanyRow(MONEY, tK.companies, { record: co.record });
  const run = await newPeopleRun(MONEY);
  const c = await pool.connect();
  let job;
  try {
    await c.query("BEGIN");
    job = await createRun(c, { tag: TAB, mode: "demo", strategy: "export", size: 10, filters: {}, requests: [{ contact: { location: { any: { include: ["Dayton, Ohio"] } } } }] });
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  created.tabRuns.push(job.id);
  created.tables.push(job.table_id);
  await pool.query(`UPDATE aiark_runs SET status = 'running', progress = '{"job": {"track_id": "pptest"}}'::jsonb, next_run_at = now() + interval '1 hour' WHERE id = $1`, [job.id]);
  const tx = counted(createDemoTransport({ companies: [co.record], balance: 5_000 }));
  await step(demoClient(tx));
  const r = await runOf(run.id);
  check("a tab export job of the mode unread: the people run waits, no page bought, no attempt counted", tx.n.preview === 0 && r.attempts === 0 && new Date(r.next_run_at) > new Date() && r.status === "running");
  check("... and the tab's run is untouched", (await one(`SELECT status, progress FROM aiark_runs WHERE id = $1`, [job.id])).progress.job.track_id === "pptest");
  await pool.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now(), progress = '{}'::jsonb WHERE id = $1`, [job.id]);
  await endTestRuns();

  // D43: people only the pipeline bought are left out of the tab's lists, and a tab single run copies them free.
  const people = { contact: { location: { any: { include: ["Springfield, Illinois"] } }, experience: { latest: { title: { any: { include: { mode: "WORD", content: [`Widget Tester ${RUN}`] } } } } } } };
  const probe = createDemoTransport();
  const pai = createAiArk({ token: DEMO_TOKEN, transport: probe, wait: fastWait });
  const first = (await pai.preview(people, { page: 0, size: 100 })).content;
  const got = await pai.exportSingle(first[0].id);
  const pipelineEmail = `d43.${RUN.toLowerCase()}@${TEST_HOST}`;
  const pick = {
    preview: first[0],
    full: got.found ? got.person : { ...first[0], email: { state: "DONE", output: [{ address: pipelineEmail, status: "VALID", domainType: "SMTP" }] } },
  };
  await pool.query(
    `INSERT INTO aiark_people (person_id, demo, run_id, email, email_status, company_id, record, people_run_id) VALUES ($1, true, NULL, $2, 'VALID', $3, $4, $5)`,
    [pick.preview.id, pipelineEmail, pick.preview.company.id, JSON.stringify(pick.full), world.otherRun]
  );
  created.persons.add(pick.preview.id);
  const tabHeld = (await one(`SELECT count(*)::int AS n FROM aiark_people WHERE demo AND pulled_at < now() AND NOT (run_id IS NULL AND people_run_id IS NOT NULL)`)).n;
  const c2 = await pool.connect();
  let single;
  try {
    await c2.query("BEGIN");
    single = await createRun(c2, { tag: TAB, mode: "demo", strategy: "single", size: 3, filters: {}, requests: [people] });
    await c2.query("COMMIT");
  } finally {
    c2.release();
  }
  created.tabRuns.push(single.id);
  created.tables.push(single.table_id);
  const singleIds = [];
  const txT = counted(overlay(createDemoTransport(), async (req) => {
    if (isSingle(req)) singleIds.push(JSON.parse(req.body).id);
    return undefined;
  }));
  for (let i = 0; i < 40; i++) {
    const s = await one(`SELECT status FROM aiark_runs WHERE id = $1`, [single.id]);
    if (TERMINAL.has(s.status)) break;
    if (!(await advanceOneRun({ pool, env: { AIARK_DEMO: "1" }, clientFor: demoClient(txT), log: quiet }))) {
      await pool.query(`UPDATE aiark_runs SET next_run_at = now() WHERE id = $1`, [single.id]);
    }
  }
  const tr = await one(`SELECT * FROM aiark_runs WHERE id = $1`, [single.id]);
  const row = await one(`SELECT id FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [single.table_id, `aiark:${pick.preview.id}`]);
  const rowEmail = row ? (await cellsOf(row.id)).email : null;
  const reg = await one(`SELECT run_id, row_id, people_run_id, email FROM aiark_people WHERE person_id = $1`, [pick.preview.id]);
  const runsSrc = source("scripts/lib/aiark/runs.mjs");
  check("D43: the tab's exclusion lists leave out people only the pipeline bought", (tr.progress.excluded === tabHeld || tr.progress.lists_short === true) && (runsSrc.match(/AND \$\{TAB_HELD\}/g) ?? []).length === 3, `${tr.progress.excluded} vs ${tabHeld}`);
  check("D43: a tab single run meets such a person and adds them, with the registry's email", tr.status === "done" && Boolean(row) && rowEmail === pipelineEmail, `${tr.status} ${tr.last_error ?? ""} ${rowEmail}`);
  check("D43: copied free: no Export Single for them, and the run's credits are what AI Ark charged", !singleIds.includes(pick.preview.id) && Number(tr.credits_used) === txT.state.charged && tr.pulled === 3);
  check("D43: the registry row is now the tab run's, with its row (the way back from the pipeline finds it)", reg.run_id === single.id && String(reg.row_id) === String(row?.id) && reg.people_run_id === world.otherRun);
  const runsAfter = (await one(`SELECT count(*)::int AS n FROM aiark_runs`)).n;
  check("the tab's runs: only the two this check made", runsAfter === tabRunsBefore + 2);
}

async function partB12(routes) {
  section("B12. The routes");
  const { setup, runs, buy, cancel, candidates, contacts } = routes;
  const tA = world.tA;
  T.worker = heartbeat();
  T.role = "viewer";
  check("below manager: refused (403)", (await call(setup.GET, { query: { tag: A } })).status === 403 && (await call(runs.POST, { body: { tag: A, mode: "demo" } })).status === 403);
  T.role = "manager";
  const s = await call(setup.GET, { query: { tag: A } });
  check("the setup: plan, runs, originals, spend, keyed steps", s.status === 200 && s.body.plan && Array.isArray(s.body.runs) && s.body.originals?.default && s.body.spend?.reoon && Array.isArray(s.body.keys) && s.body.keys.some((k) => k.key === "ENRICHLEY_API_KEY") && s.body.worker?.peopleRuns === true, JSON.stringify(s.body).slice(0, 300));
  check("... a bad tag: 400", (await call(setup.GET, { query: { tag: "not a tag!" } })).status === 400);
  const list = await call(runs.GET, { query: { tag: A } });
  const mainRun = list.body.runs.find((x) => x.id === world.run.id);
  const mainCands = await candidatesOf(world.run.id);
  check("the runs list, newest first, with candidates by verdict and by track", list.status === 200 && list.body.runs[0]?.client_tag === A && Boolean(list.body.counts) &&
    mainRun && Object.values(mainRun.verdicts).reduce((a2, n) => a2 + n, 0) === mainCands.length &&
    Object.values(mainRun.tracks).reduce((a2, n) => a2 + n, 0) === mainCands.filter((c) => c.track).length && mainRun.capped_batches === 0 && mainRun.ceiling === peopleSpendCeiling(world.run));

  const post = (body) => call(runs.POST, { body: { tag: A, mode: "demo", ...body } });
  const stored = await one(`SELECT value FROM enrich_settings WHERE key = 'people_pipeline'`);
  const setPP = (v) => pool.query(`UPDATE enrich_settings SET value = $1 WHERE key = 'people_pipeline'`, [JSON.stringify({ ...(stored?.value ?? {}), ...v })]);
  await setPP({ enabled: false, tags: [] });
  let r = await post({});
  check("people runs off: 409", r.status === 409 && /People runs are off/.test(r.body.error));
  await setPP({ enabled: true, tags: [C] });
  r = await post({});
  check("the client not on the list: 409", r.status === 409 && /not on the people runs' client list/.test(r.body.error));
  await setPP({ enabled: true, tags: [A, MONEY, V1, NOTAB] });
  // source "linkedin" is a source since migration 128: its refusals are 409s, checked in test-linkedin.mjs part R.
  check("bad bodies: 400", (await post({ mode: "x" })).status === 400 && (await post({ source: "clay" })).status === 400 && (await post({ maxPeople: 0 })).status === 400 && (await post({ maxPeople: 999_999 })).status === 400);
  T.worker = heartbeat({ online: false });
  check("the worker offline: 409", (r = await post({})).status === 409 && /service that runs them is off/.test(r.body.error));
  T.worker = heartbeat({ peopleRuns: false });
  check("a worker without people_runs: 409", (r = await post({})).status === 409 && /doesn't do people runs/.test(r.body.error));
  T.worker = heartbeat();
  await endTestRuns();
  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [world.tK.companies]);
  const kco = findCompany("going", "Going Widget Co", normal(2));
  await addCompanyRow(MONEY, world.tK.companies, { record: kco.record });
  const going = await newPeopleRun(MONEY);
  r = await call(runs.POST, { body: { tag: MONEY, mode: "demo" } });
  check("a run going for the client: 409", r.status === 409 && /already has a people run going/.test(r.body.error), JSON.stringify(r.body));
  await cancelPeopleRun(pool, { runId: going.id });
  const NT = { tag: NOTAB };
  r = await call(runs.POST, { body: { ...NT, mode: "demo" } });
  check("no pipeline Companies table yet: 409", r.status === 409 && /no pipeline Companies table/.test(r.body.error));
  await pool.query(`INSERT INTO enrich_tables (client_tag, kind, name, template) VALUES ($1, 'companies', 'Companies (pipeline)', 'companies_v1')`, [V1]);
  created.tables.push((await one(`SELECT id FROM enrich_tables WHERE client_tag = $1`, [V1])).id);
  r = await call(runs.POST, { body: { tag: V1, mode: "demo" } });
  check("a retired companies_v1 table: 409", r.status === 409 && /companies_v1/.test(r.body.error));
  try {
    await pool.query(`UPDATE enrich_settings SET value = '{}'::jsonb WHERE key = 'people_tracks'`);
    if (!originalTracks) await pool.query(`INSERT INTO enrich_settings (key, value) VALUES ('people_tracks', '{}'::jsonb) ON CONFLICT (key) DO NOTHING`);
    r = await post({});
    check("the people tracks not loaded: 409", r.status === 409 && /people tracks are not loaded/.test(r.body.error));
    await pool.query(`UPDATE enrich_settings SET value = $1 WHERE key = 'people_tracks'`, [JSON.stringify(TRACKS_FIX)]);
    process.env.AIARK_DEMO_CREDITS = "100";
    r = await post({});
    check("AI Ark's balance under the people runs' minimum: 409, read free", r.status === 409 && /under the people runs' minimum/.test(r.body.error), JSON.stringify(r.body));
  } finally {
    delete process.env.AIARK_DEMO_CREDITS;
    await restoreTracks();
  }

  // Buy and cancel through their routes.
  const tB = world.tB;
  await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tB.companies]);
  const co = findCompany("route", "Route Widget Co", normal(3));
  await addCompanyRow(B2, tB.companies, { record: co.record });
  const run = await newPeopleRun(B2);
  const notLooked = await call(buy.POST, { body: { id: run.id } });
  check("Buy of a run that is not looked: 409", notLooked.status === 409);
  const tx = createDemoTransport({ companies: [co.record], balance: 5_000 });
  await drive(run.id, demoClient(tx));
  await setPP({ enabled: true, tags: [A] });
  check("Buy while people runs are off for its client: 409", (await call(buy.POST, { body: { id: run.id } })).status === 409);
  await setPP({ enabled: true, tags: [A, B2] });
  T.audits.length = 0;
  const bought = await call(buy.POST, { body: { id: run.id } });
  check("Buy of a looked run: queued, recorded with who clicked", bought.status === 200 && bought.body.run.status === "queued" && T.audits.some((a) => a.action === "companies_people_buy"));
  check("a bad id: 400", (await call(buy.POST, { body: { id: "x" } })).status === 400 && (await call(cancel.POST, { body: { id: "x" } })).status === 400);
  const cancelled = await call(cancel.POST, { body: { id: run.id } });
  check("Cancel: 200, then 409 for a run no longer going", cancelled.status === 200 && (await call(cancel.POST, { body: { id: run.id } })).status === 409 && T.audits.some((a) => a.action === "companies_people_run_cancel"));

  // A company's contacts, keyset (a run's candidates are paged in B9).
  void candidates;
  check("the contacts and candidates queries page by key, with no OFFSET", !/\bOFFSET\s+(\$\d+|\d+)/i.test(source("src/lib/companies/people.ts")) && /k\.row_id\) > \(\$4::int, \$5::bigint\)/.test(source("src/lib/companies/people.ts")));
  const rowP1 = world.rows.p1;
  const ct = await call(contacts.GET, { query: { tag: A, row: String(rowP1) } });
  const inDb = (await one(`SELECT count(*)::int AS n FROM enrich_contacts WHERE company_row_id = $1`, [rowP1])).n;
  check("a company's contacts: its people, with totals", ct.status === 200 && ct.body.rows.length === inDb && ct.body.totals.people === inDb && ct.body.rows.every((x) => x.kind === "person"));
  check("... a bad row: 400", (await call(contacts.GET, { query: { tag: A, row: "0" } })).status === 400);
  const listRoute = routes.list;
  const listed = await call(listRoute.GET, { query: { tag: A, has: "people" } });
  check("the companies list: 'with people emails' keeps companies with a usable person, each with up to 3 people", listed.status === 200 && listed.body.rows.length >= 1 && listed.body.rows.every((x) => x.people_emails + x.people_held > 0 && x.contacts.people.length <= 3 && x.contacts.people.length >= 1));
  void tA;
  await setPP({});
}

async function partB12b(routes) {
  section("B12b. The settings route: every switch with its client list, the people block, the twelve models, the caps");
  const SHEET_KEYS = ["company_pipeline", "people_pipeline", "personalisation", "spend_caps", "models"];
  const before = await all(`SELECT key, value FROM enrich_settings WHERE key = ANY($1::text[]) ORDER BY key`, [SHEET_KEYS]);
  const serverLib = await srcModule("lib/companies/server.ts");
  try {
    T.role = "manager";
    check("managers can't read or save the settings (403)", (await call(routes.settings.GET)).status === 403 && (await call(routes.settings.PUT, { body: {} })).status === 403);
    T.role = "admin";
    const got = await call(routes.settings.GET);
    const v = got.body?.value;
    const TWELVE = ["companys_website", "email_extraction_claygent", "email_extraction_claygent_2", "company_decision_maker_facilities_1_claygent",
      "company_decision_maker_facilities_2_claygent", "company_decision_maker_location_company_check", "company_decision_maker_ceo_claygent",
      "current_employer", "people_claygent", "people_question_ai", "inbox_claygent", "inbox_question_ai"];
    check("the settings as the worker reads them: the people block, personalisation, the caps and the twelve models",
      got.status === 200 && typeof v.people_pipeline.enabled === "boolean" && Array.isArray(v.people_pipeline.tags) && Number.isInteger(v.people_pipeline.ids_per_search) &&
        Array.isArray(v.personalisation.tags) && Number.isFinite(v.spend_caps.openai_usd_per_day.pipeline) && TWELVE.every((k) => k in v.models) &&
        JSON.stringify(serverLib.settingsInputOf(v).models.people_question_ai) === JSON.stringify({ model: v.models.people_question_ai?.model ?? "", reasoning_effort: v.models.people_question_ai?.reasoning_effort ?? null, max_searches: null }),
      JSON.stringify(v?.people_pipeline));
    const input = serverLib.settingsInputOf(v);
    const edit = (f) => {
      const x = structuredClone(input);
      f(x);
      return { body: { version: got.body.version, ...x } };
    };
    const refused = async (label, f, re) => {
      const r = await call(routes.settings.PUT, edit(f));
      check(label, r.status === 400 && re.test(r.body.error ?? ""), `${r.status} ${r.body.error ?? ""}`);
    };
    await refused("a client list with something that is not a tag: 400", (x) => { x.people_pipeline.tags = ["not a tag!"]; }, /not a client tag/);
    await refused("a number out of range: 400, never quietly replaced", (x) => { x.people_pipeline.ids_per_search = 0; }, /Companies per search must be a whole number from 1 to 300/);
    await refused("a Luna model with the minimal reasoning effort: 400", (x) => { x.models.people_claygent = { model: "gpt-6-luna", reasoning_effort: "minimal", max_searches: 2 }; }, /refuses the "minimal"/);
    await refused("a web step with no most searches: 400", (x) => { x.models.companys_website.max_searches = null; }, /most searches must be a whole number from 1 to 5/);
    await refused("a switch that is not on or off: 400", (x) => { x.personalisation.enabled = "yes"; }, /Personalisation must be on or off/);
    T.audits.length = 0;
    const saved = await call(routes.settings.PUT, edit((x) => {
      x.people_pipeline.max_people_per_run = 250;
      x.people_pipeline.tags = [" pptest_sheet_a ", "PPTEST_SHEET_A", "PPTEST_SHEET_B"];
      x.spend_caps.reoon_checks_per_day = 1200;
      x.models.current_employer = { model: "gpt-4o-mini", reasoning_effort: null, max_searches: 2 };
    }));
    const stored = Object.fromEntries((await all(`SELECT key, value FROM enrich_settings WHERE key = ANY($1::text[])`, [SHEET_KEYS])).map((r) => [r.key, r.value]));
    const was = Object.fromEntries(before.map((r) => [r.key, r.value]));
    check("a save: 200, each change listed and logged", saved.status === 200 && saved.body.changes.some((c) => c.includes("most people a run")) && T.audits.some((a2) => a2.action === "enrich_settings"), JSON.stringify(saved.body.changes ?? saved.body));
    check("... tags upper case, once each", JSON.stringify(stored.people_pipeline.tags) === JSON.stringify(["PPTEST_SHEET_A", "PPTEST_SHEET_B"]) && stored.people_pipeline.max_people_per_run === 250);
    check("... what the sheet doesn't edit is kept: memory days, the prices, fit_score", JSON.stringify(stored.company_pipeline.memory_days ?? null) === JSON.stringify(was.company_pipeline?.memory_days ?? null) &&
      JSON.stringify(stored.spend_caps.openai_prices ?? null) === JSON.stringify(was.spend_caps?.openai_prices ?? null) && ("fit_score" in (was.models ?? {}) ? JSON.stringify(stored.models.fit_score) === JSON.stringify(was.models.fit_score) : true));
    const read = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
    check("... and the worker reads what was saved", read.people_pipeline.max_people_per_run === 250 && read.spend_caps.reoon_checks_per_day === 1200 && read.models.current_employer.model === "gpt-4o-mini" && read.flagOn("people_pipeline", "PPTEST_SHEET_A") === read.people_pipeline.enabled);
    check("a save over a newer version is refused (409)", (await call(routes.settings.PUT, edit(() => {}))).status === 409);
  } finally {
    T.role = "manager";
    for (const r of before) await pool.query(`UPDATE enrich_settings SET value = $2 WHERE key = $1`, [r.key, JSON.stringify(r.value)]);
  }
}

async function partC(routes) {
  section("C. With Builder A's templates in place");
  const built = !/TODO\(A\)/.test(syncTemplateColumns.toString());
  if (!built) {
    later("the start route end to end: 201, the tables compiled, the run queued", "syncTemplateColumns is Builder A's and not built in this tree");
    later("a bought person worked by the compiled People template (Reoon stubbed): their inputs read, the address checked once, their contact written", "Builder A's People template");
    return;
  }
  const stored = await one(`SELECT value FROM enrich_settings WHERE key = 'people_pipeline'`);
  const tB = world.tB;
  try {
    await pool.query(`UPDATE enrich_settings SET value = $1 WHERE key = 'people_pipeline'`, [JSON.stringify({ ...(stored?.value ?? {}), enabled: true, tags: [B2] })]);
    if (!originalTracks) await pool.query(`INSERT INTO enrich_settings (key, value) VALUES ('people_tracks', $1) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(TRACKS_FIX)]);
    resetSettingsCache();
    T.worker = heartbeat();
    await endTestRuns();
    await pool.query(`DELETE FROM enrich_rows WHERE table_id = $1`, [tB.companies]);
    // Everyone at the company has a track and an email (the demo gives about 1 person in 4 none), so the
    // run always buys someone with an address to work. Picked by place alone, nobody bought had one in
    // about 1 run in 11, which failed the check below by chance.
    const co = findCompany("partc", "Partc Widget Co", (ps) => normal(2)(ps) && ps.every((p) => p.email.found));
    const rowId = await addCompanyRow(B2, tB.companies, { record: co.record });
    const r = await call(routes.runs.POST, { body: { tag: B2, mode: "demo", maxPeople: 5 } });
    const compiled = (await one(`SELECT count(*)::int AS n FROM enrich_columns WHERE table_id = $1`, [tB.people])).n;
    check("the start route: 201 with the run, the client's tables compiled from the originals", r.status === 201 && r.body.run?.status === "queued" && compiled > 0, JSON.stringify(r.body).slice(0, 300));
    if (!r.body.run) return;
    created.runs.push(r.body.run.id);

    // Look and Buy through the demo transport, then work one bought person with the compiled template.
    const tx = createDemoTransport({ companies: [co.record], balance: 5_000 });
    await drive(r.body.run.id, demoClient(tx));
    await approveBuy(pool, { runId: r.body.run.id, userId: null });
    await drive(r.body.run.id, demoClient(tx), { until: TERMINAL, limit: 6 }).catch(() => null);
    const people = await all(
      `SELECT r.id, r.created_at, r.run_force, r.next_run_at FROM enrich_rows r JOIN enrich_cells c ON c.row_id = r.id AND c.column_key = 'email'
        WHERE r.table_id = $1 AND r.run_status = 'queued' ORDER BY r.id LIMIT 1`,
      [tB.people]
    );
    if (!people.length) {
      check("a bought person with an email to work", false, "nobody with an email was bought");
      return;
    }
    const row = people[0];
    const email = (await cellsOf(row.id)).email;
    net.verdicts.set(email, "safe");
    reoonStub = true;
    const { rows: [table] } = await pool.query(`SELECT id, client_tag, kind, name, template FROM enrich_tables WHERE id = $1`, [tB.people]);
    table.keyCounts = {};
    const columns = order(await all(
      `SELECT key, name, position, kind, action, formula, waterfall, inputs, config, run_if, provider, needs_env, phase
         FROM enrich_columns WHERE table_id = $1 ORDER BY position`,
      [tB.people]
    ));
    const cells = new Map((await all(`SELECT column_key, status, value, display, note, input_hash FROM enrich_cells WHERE row_id = $1`, [row.id])).map((c) => [c.column_key, c]));
    const settings = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
    const before = net.reoon;
    const out = await runRow({ row, table, columns, cells, env: { ENRICH_REOON_API_KEY: "made-up-reoon" }, db: pool, settings });
    const { rows: [claim] } = await pool.query(
      `UPDATE enrich_rows SET run_status = 'running', claim_token = gen_random_uuid() WHERE id = $1 RETURNING claim_token`,
      [row.id]
    );
    await projectContact(pool, { rowId: row.id, claimToken: claim.claim_token, tableId: tB.people, clientTag: B2, kind: "person", values: out.values });
    const contact = await one(`SELECT * FROM enrich_contacts WHERE row_id = $1`, [row.id]);
    const own = await cellsOf(row.id);
    // The originals in this database decide the address's fate (the real ones read a made-up .example
    // address as junk); what is checked here is that the People row's inputs reach the template and
    // its outcome reaches enrich_contacts.
    const outcome = out.values.person_outcome;
    check(
      "a bought person worked by the compiled People template (Reoon stubbed): their inputs read, the address checked once, their contact written",
      PERSON_OUTCOMES.includes(outcome) && net.reoon - before === 1 && contact?.email === email && contact.outcome === outcome &&
        contact.verdict === (VERDICT_BY_OUTCOME.person[outcome] ?? null) && String(contact.company_row_id) === String(rowId) &&
        contact.stage === "bought" && contact.found_by === "aiark" && contact.track === own.track && String(contact.rank) === own.rank &&
        contact.full_name === own.find_people_from_linkedin_company_url?.name,
      JSON.stringify({ outcome, reoon: net.reoon - before, contact })
    );
    console.log(`        (this database's originals gave the made-up address: ${outcome})`);
  } finally {
    reoonStub = false;
    await pool.query(`UPDATE enrich_settings SET value = $1 WHERE key = 'people_pipeline'`, [JSON.stringify(stored?.value ?? {})]);
    await restoreTracks();
    resetSettingsCache();
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

const baseline = { leads: 0, push: 0 };
let originalPP = null;
let originalTracks = null;
let tracksRead = false;

/** people_tracks back as it was before this run (the route checks change it). */
async function restoreTracks() {
  if (!tracksRead) return;
  if (originalTracks) {
    await pool.query(
      `INSERT INTO enrich_settings (key, value) VALUES ('people_tracks', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [JSON.stringify(originalTracks.value)]
    );
  } else {
    await pool.query(`DELETE FROM enrich_settings WHERE key = 'people_tracks'`);
  }
}

async function cleanup() {
  const runs = (await all(`SELECT id FROM aiark_people_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  const seen = (await all(`SELECT DISTINCT person_id FROM aiark_people_candidates WHERE run_id = ANY($1::uuid[])`, [runs])).map((r) => r.person_id);
  const tabRuns = (await all(`SELECT id FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  // Registry rows first: deleting a run would leave them with no run, read as bought by the tab.
  await pool.query(
    `DELETE FROM aiark_people WHERE people_run_id = ANY($1::uuid[]) OR run_id = ANY($2::uuid[])
        OR (person_id = ANY($3::text[]) AND (run_id IS NULL OR run_id = ANY($2::uuid[])))`,
    [runs, tabRuns, [...new Set([...seen, ...created.persons])]]
  );
  await pool.query(`DELETE FROM aiark_people_runs WHERE id = ANY($1::uuid[])`, [runs]);
  await pool.query(`DELETE FROM aiark_runs WHERE id = ANY($1::uuid[])`, [tabRuns]);
  const tables = (await all(`SELECT id FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  await pool.query(`DELETE FROM enrich_memory WHERE starts_with(client_tag, $1) OR table_id = ANY($2::uuid[])`, [PREFIX, tables]).catch(() => {});
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tables]).catch(() => {});
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1`, [`%${TEST_HOST}`]).catch(() => {});
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${TEST_HOST}`]);
  await pool.query(`DELETE FROM suppressed_emails WHERE reason = $1 OR email LIKE $2`, [SUPPRESS_REASON, `%.${TEST_HOST}`]);
  await pool.query(`DELETE FROM client_people_filters WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, $1)`, [PREFIX]);
  if (originalPP) await pool.query(`UPDATE enrich_settings SET value = $1 WHERE key = 'people_pipeline'`, [JSON.stringify(originalPP.value)]);
  await restoreTracks();
}

const ready = await one(`SELECT to_regclass('public.aiark_people_runs') IS NOT NULL AND to_regclass('public.aiark_people_candidates') IS NOT NULL AS ok`);
if (!ready.ok) {
  console.error("Refusing to run: migration 125 is not in this database.");
  await pool.end();
  process.exit(1);
}
const busy = await one(
  `SELECT (SELECT count(*)::int FROM aiark_people_runs WHERE status IN ('queued', 'running') AND NOT starts_with(client_tag, $1)) AS people,
          (SELECT count(*)::int FROM aiark_runs WHERE (status IN ('queued', 'running') OR (status = 'cancelled' AND finished_at IS NULL AND jsonb_typeof(progress->'job') = 'object')) AND NOT starts_with(client_tag, $1)) AS tab`,
  [PREFIX]
);
if (busy.people || busy.tab) {
  console.error(`Refusing to run: ${busy.people} people run(s) and ${busy.tab} AI Ark tab run(s) are going in this database. Let them finish or cancel them first.`);
  await pool.end();
  process.exit(1);
}
const t0 = Date.now();
let enrichDb = null;
try {
  await cleanup(); // anything an interrupted run left behind
  originalPP = await one(`SELECT value FROM enrich_settings WHERE key = 'people_pipeline'`);
  originalTracks = await one(`SELECT value FROM enrich_settings WHERE key = 'people_tracks'`);
  tracksRead = true;
  baseline.leads = (await one(`SELECT count(*)::int AS n FROM leads`)).n;
  baseline.push = (await one(`SELECT count(*)::int AS n FROM push_items`)).n;
  await loadGeo(pool);
  await partA();
  await setUp();
  enrichDb = await srcModule("lib/enrich/db.ts");
  const routes = {
    setup: await route("companies/people/setup"),
    runs: await route("companies/people/runs"),
    buy: await route("companies/people/runs/buy"),
    cancel: await route("companies/people/runs/cancel"),
    candidates: await route("companies/people/runs/candidates"),
    contacts: await route("companies/contacts"),
    list: await route("companies/list"),
    settings: await route("companies/settings"),
  };
  await partB1();
  await partB2();
  await partB3();
  await partB4();
  await partB5();
  await partB6();
  await partB7();
  await partB8();
  await partB9(routes);
  await partB10();
  await partB11();
  await partB12(routes);
  await partB12b(routes);
  await partC(routes);
  section("B13. Nothing reaches leads or a push");
  const leadsNow = (await one(`SELECT count(*)::int AS n FROM leads WHERE email NOT LIKE $1`, [`%.${TEST_HOST}`])).n;
  check("no lead written, no push item", leadsNow === baseline.leads && (await one(`SELECT count(*)::int AS n FROM push_items`)).n === baseline.push);
  check("nothing tried to reach any address", net.refused === 0, `${net.refused} refused`);
} catch (e) {
  failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await endTestRuns().catch(() => {});
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const leftover = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE starts_with(tag, $1)) AS clients,
            (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1)) AS tables,
            (SELECT count(*)::int FROM aiark_people_runs WHERE starts_with(client_tag, $1)) AS runs,
            (SELECT count(*)::int FROM aiark_runs WHERE starts_with(client_tag, $1)) AS tab_runs,
            (SELECT count(*)::int FROM aiark_people WHERE person_id = ANY($3::text[])) AS registry,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2) AS leads`,
    [PREFIX, `%.${TEST_HOST}`, [...created.persons]]
  );
  const settingsBack =
    (originalPP ? JSON.stringify((await one(`SELECT value FROM enrich_settings WHERE key = 'people_pipeline'`))?.value) === JSON.stringify(originalPP.value) : true) &&
    JSON.stringify((await one(`SELECT value FROM enrich_settings WHERE key = 'people_tracks'`))?.value ?? null) === JSON.stringify(originalTracks?.value ?? null);
  const clean = Object.values(leftover).every((n) => n === 0) && settingsBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...leftover, settingsBack })}`}`);
  console.log(`${passed} passed, ${failed} failed${pending ? `, ${pending} waiting for Builder A` : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await enrichDb?.enrichPool().end().catch(() => {});
  await pool.end();
  process.exit(failed || !clean ? 1 : 0);
}
