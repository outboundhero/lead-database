#!/usr/bin/env node
// Deep checks for the Companies tab and its pipeline (migrations 124 and 125).
// LOCAL DATABASE ONLY: it makes made-up clients (tags starting CPTEST_) with
// their rules, each with the made-up Clay originals as its own variant
// (scripts/fixtures/clay-originals), a few made-up leads, Email Bison copy rows
// and never-contact rows, demo pulls, template tables and their rows, and
// removes all of it at the end.
//
//   node --env-file=.env.local scripts/test-companies.mjs
//
// Stop the enrichment worker first: it would race this script for the pulls
// and the rows. Migrations 124 and 125 must be in the local database.
//
// Nothing here reaches a network. AI Ark answers through the demo transport,
// which takes test faults. fetch is replaced for the whole run: OpenAI, Reoon
// and the website checks answer from a stub, and any other address is refused
// and counted. No paid key is read from the environment. The Companies tab's
// routes run for real: a small loader compiles their TypeScript, with
// stand-ins only for the session (requireRole), the audit log and the
// worker's heartbeat.
//
// What it checks (phase 1's design section 8.1, moved to companies_v2; the
// compiled steps themselves are checked by scripts/test-pipeline-v2.mjs):
//   A. no database: the request builder, people requests unchanged, Company
//      Search through a fake transport, lists, a company's input cells, place
//      keys, phase 1's own steps gone, Reoon's verdicts, the companies_v2
//      template, ai_web's request
//   B. demo pulls: the pull and count routes and their refusals, a pull to its
//      size, no company bought twice (within a client, and copied free to
//      another), a crash and a lost claim, cancel, AI Ark's errors, lost pages,
//      the spending brake, the 10,000 cap, the shared list budget, demo
//      companies kept out of live pulls
//   C. template rows end to end: the office, exclusions, a held inbox, the
//      website, the general email through its inbox rows, shared memory,
//      missing keys and Reoon credits, errors, a model swap, and the real worker
//   D. the tab's data: the projection, keyset paging over 2,500 companies, the
//      counts, deletes, nothing written to leads
//   E. shared code: the Maps intake, CSV imports, the tables list, settings

import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAiArk } from "./lib/aiark/client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./lib/aiark/demo.mjs";
import { buildRequests, CLEANING_DEFAULTS, loadGeo } from "./lib/aiark/filters.mjs";
import { CLEANING_EXCLUDE_KEYWORDS } from "./lib/aiark/cleaning-filters.mjs";
import {
  buildCompanyRequests, companyFiltersFor, companyMatch, companyPlaceKeys, companySpendCeiling, hasWords, matchesCompanyFilters,
  officesOf, placeKeyOf, resolveOffice,
} from "./lib/aiark/company-filters.mjs";
import { advanceOneCompanyRun, createCompanyRun, ensureTemplateTable, pageSizeAt } from "./lib/aiark/company-runs.mjs";
import { createRun, listsMadeToday } from "./lib/aiark/runs.mjs";
import { pullsToAdd } from "./lib/aiark/add.mjs";
import { ACTIONS } from "./lib/enrich/actions.mjs";
import { CLIENT_ACTIONS, resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { mapReoonStatus, requeueWaitingTemplateRows, resetCompanyActions } from "./lib/enrich/company-actions.mjs";
import * as companyTemplate from "./lib/enrich/company-template.mjs";
import { COMPANY_SEARCH_KEYS, companyInputs, DIRECTORY_BLOCKLIST, JUNK_DOMAINS, JUNK_LOCAL_PARTS, ROLE_PREFIX_SOURCE, SOURCE_BOUGHT } from "./lib/enrich/company-template.mjs";
import { COMPANY_ABSENT_KEYS, COMPANY_COLUMNS_V2, LISTED_OUTCOMES_V2 } from "./lib/enrich/company-template-v2.mjs";
import { INBOX_COLUMNS } from "./lib/enrich/inbox-template.mjs";
import { PEOPLE_COLUMNS } from "./lib/enrich/people-template.mjs";
import { emailsIn } from "./lib/enrich/pipeline-actions.mjs";
import { compileTemplates } from "./lib/enrich/templates.mjs";
import { originalRows, originalsMap } from "./lib/enrich/seed-originals.mjs";
import { runRow } from "./lib/enrich/engine.mjs";
import { refs } from "./lib/enrich/formula.mjs";
import { MODEL_SETTINGS, resetSettingsCache, settingsFrom } from "./lib/enrich/settings.mjs";
import { fixtureSeedExports } from "./fixtures/clay-originals/fixtures.mjs";
import { reoonAnswer, seedFixtureVariant, WORKER_PRELOAD, workRow } from "./fixtures/test-support.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
// No paid key reaches anything here, whatever the shell holds.
const PAID_KEYS = [
  "OPENAI_API_KEY", "ENRICH_REOON_API_KEY", "REOON_API_KEY", "CLEARBIT_API_KEY", "FINDEMAIL_API_KEY", "ANTHROPIC_API_KEY",
  "AIARK_API_KEY", "AIARK_WEBHOOK_URL", "AIARK_AUTO_ADD_URL", "AIARK_AUTO_ADD_KEY",
  "FINDYMAIL_API_KEY", "PROSPEO_API_KEY", "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY", "ICYPEAS_API_KEY",
];
for (const k of PAID_KEYS) delete process.env[k];
process.env.AIARK_DEMO = "1";
process.env.AIARK_DEMO_LATENCY_MS = "0";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` : ${detail}` : ""}`);
}
const section = (s) => console.log(`\n${s}`);
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));
const sorted = (o) => JSON.stringify(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b))));
// The three pipeline templates compiled from the made-up originals, as each test client's tables are.
const COMPILED = compileTemplates(originalsMap(originalRows(fixtureSeedExports())));

// ── No network: OpenAI, Reoon and websites answer from here ─────────────────

const net = {
  calls: { openai: 0, reoon: 0, balance: 0, probe: 0, refused: 0 },
  bodies: [], // OpenAI request bodies
  verified: [], // addresses Reoon was asked about
  dead: new Set(), // hosts whose website doesn't answer
  answers: new Map(), // company name -> { website, first, second }: what C#24, C#31 and C#32 find
  verdicts: new Map(), // address -> Reoon's status word (invalid when not set)
  balance: { daily: 400, instant: 0 },
  openaiFail: [], // HTTP statuses OpenAI answers before its normal answers
};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "api.openai.com") {
    net.calls.openai++;
    const body = JSON.parse(init.body);
    net.bodies.push(body);
    const fail = net.openaiFail.shift();
    if (fail) return json(fail, { error: { message: "made-up failure" } });
    // The made-up originals' prompts start "[fx:<column>] business=<name>;".
    const m = /\[fx:(\w+)\] \w+=([^;]*);/.exec(body.input ?? "");
    const plan = net.answers.get(m?.[2]?.trim() ?? "") ?? {};
    const found = { C24: plan.website, C31: plan.first, C32: plan.second }[m?.[1] ?? ""];
    const fields = body.text?.format?.schema?.required ?? [];
    const answer = Object.fromEntries(fields.map((f, i) => [f, i === 0 && found ? found : "N/A"]));
    return json(200, {
      output: [{ type: "web_search_call" }, { type: "web_search_call" }, { type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }],
      usage: { input_tokens: 900, output_tokens: 40 },
    });
  }
  if (u.hostname === "emailverifier.reoon.com") {
    if (u.pathname.includes("check-account-balance")) {
      net.calls.balance++;
      return json(200, { status: "success", remaining_daily_credits: net.balance.daily, remaining_instant_credits: net.balance.instant });
    }
    if (u.pathname.endsWith("/verify")) {
      net.calls.reoon++;
      const email = u.searchParams.get("email");
      net.verified.push(email);
      return json(200, reoonAnswer(email, net.verdicts.get(email) ?? "invalid"));
    }
  }
  if (u.hostname.endsWith(".example")) {
    net.calls.probe++;
    if (net.dead.has(u.hostname.replace(/^www\./, ""))) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
    return new Response("<html></html>", { status: 200 });
  }
  net.calls.refused++;
  throw Object.assign(new TypeError("fetch failed: test-companies allows no network"), { cause: { code: "ECONNREFUSED" } });
};

// The real worker gets the same rule (WORKER_PRELOAD): websites under .example answer, nothing else does.

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
  const t = globalThis.__companiesTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}
export function intakeKeyStatus(authorization) {
  return authorization === "Bearer " + globalThis.__companiesTest.intakeKey ? "ok" : "unauthorized";
}`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__companiesTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__companiesTest.worker; }`,
};
const HOOKS = `import { existsSync, readFileSync } from "node:fs";
let ts;
let src;
let stubs = {};
export async function initialize(data) {
  // Set first: importing typescript below passes through resolve() too.
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
const T = (globalThis.__companiesTest = { role: "manager", userId: randomUUID(), audits: [], worker: null, intakeKey: "companies-test-intake" });
const srcModule = (p) => import(new URL(`../src/${p}`, import.meta.url).href);
const route = (p) => srcModule(`app/api/${p}/route.ts`);

/** One route call, as Next.js would make it. */
async function call(handler, { body, query, headers } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const req = { json: async () => body, nextUrl: new URL(`http://companies.test/api${qs}`), headers: new Headers(headers ?? {}) };
  const res = await handler(req);
  return { status: res.status, body: res.body };
}

/** A worker heartbeat as workerState() returns it. */
const heartbeat = ({ online = true, companyRuns = true } = {}) => ({
  id: "companies-test",
  last_seen: new Date().toISOString(),
  started_at: new Date().toISOString(),
  seconds_ago: online ? 2 : 600,
  online,
  info: { capabilities: companyRuns ? ["company_runs", "pipeline_v2"] : [], keys: { OPENAI_API_KEY: false, ENRICH_REOON_API_KEY: false }, reoon: null },
});

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const fastWait = async () => {};
const quiet = () => {};

const PREFIX = "CPTEST_";
const RUN = randomUUID().slice(0, 6);
const TEST_HOST = "cptest.example"; // every made-up address and website here ends with it
const dom = (slug) => `${slug}-${RUN}.${TEST_HOST}`;
const SUPPRESS_REASON = "companies test";
const WORKER_ID = "companies-test";
const KEYS = { OPENAI_API_KEY: "made-up-openai", ENRICH_REOON_API_KEY: "made-up-reoon" };
const tag = (s) => `${PREFIX}${s}`;
const IL = (city) => ({ city, state: "IL", country: "US" });
const created = { leads: 0 };
let GEO;

async function addClient(t, { type = null, places, exclude = [], terms = [], cleaning = false, filters = null }) {
  await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, $3)`, [t, `Companies test ${t.slice(PREFIX.length)}`, type]);
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
     VALUES ($1, '{US}', $2, $3, $4, $5, now())`,
    [t, JSON.stringify(places), JSON.stringify(exclude), terms, cleaning]
  );
  if (filters) {
    await pool.query(
      `INSERT INTO client_people_filters (client_tag, employee_bands, industries, exclude_industries) VALUES ($1, $2, $3, $4)`,
      [t, JSON.stringify(filters.employee_bands ?? []), filters.industries ?? [], filters.exclude_industries ?? []]
    );
  }
  await seedFixtureVariant(pool, t); // the made-up Clay originals, as the client's own variant
}

/** A pull as the route makes one, inside one transaction (requests from the client's own rules unless given). */
async function newRun(t, { mode = "demo", size, requests = null } = {}) {
  const client = await one(`SELECT client_type FROM client_tags WHERE tag = $1`, [t]);
  const targeting = await one(`SELECT * FROM client_targeting WHERE client_tag = $1`, [t]);
  const saved = await one(`SELECT employee_bands, industries, exclude_industries FROM client_people_filters WHERE client_tag = $1`, [t]);
  const f = companyFiltersFor(saved ?? null, client?.client_type ?? null);
  const built = buildCompanyRequests({ targeting, filters: f.value, geo: GEO, cleaning: client?.client_type === "Cleaning" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const run = await createCompanyRun(c, { tag: t, mode, size, filters: { company: f.value, report: built.report }, requests: requests ?? built.requests, matchCount: 1 });
    await c.query("COMMIT");
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
const step = (clientFor, extra = {}) => advanceOneCompanyRun({ pool, env: { AIARK_DEMO: "1" }, clientFor, log: quiet, ...extra });
const runOf = (id) => one(`SELECT * FROM aiark_company_runs WHERE id = $1`, [id]);
const due = (id) => pool.query(`UPDATE aiark_company_runs SET next_run_at = now() WHERE id = $1`, [id]);
async function drive(id, clientFor, extra = {}, limit = 400) {
  for (let i = 0; i < limit; i++) {
    if (TERMINAL.has((await runOf(id)).status)) return (await runOf(id)).status;
    if (!(await step(clientFor, extra))) await due(id);
  }
  throw new Error(`pull ${id} did not finish`);
}
/** Ends every test pull still going, so the next check's slices don't pick it up. */
const settle = () =>
  pool.query(
    `UPDATE aiark_company_runs SET status = 'cancelled', finished_at = coalesce(finished_at, now()), claim_token = NULL
      WHERE starts_with(client_tag, $1) AND status IN ('queued', 'running')`,
    [PREFIX]
  );
const rowsIn = async (tableId) => (await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = $1`, [tableId])).n;
const repeatedKeys = async (tableId) =>
  (await one(`SELECT count(*)::int AS n FROM (SELECT row_key FROM enrich_rows WHERE table_id = $1 GROUP BY 1 HAVING count(*) > 1) d`, [tableId])).n;
const boughtBy = async (runId) => new Set((await all(`SELECT company_id FROM aiark_companies WHERE run_id = $1`, [runId])).map((r) => r.company_id));

// ── A. No database ──────────────────────────────────────────────────────────

// buildRequests (people) before the accountFilters() refactor, at main ccf0331:
// the sha256 of its whole answer for three made-up fixtures, with a small geo.
const A2_GEO = {
  stateName: new Map([["US|NY", "New York"], ["US|CT", "Connecticut"], ["US|IL", "Illinois"], ["US|OH", "Ohio"]]),
  stateCode: new Map([["US|new york", "NY"], ["US|ny", "NY"], ["US|connecticut", "CT"], ["US|ct", "CT"], ["US|illinois", "IL"], ["US|il", "IL"], ["US|ohio", "OH"], ["US|oh", "OH"]]),
  countryName: new Map([["US", "United States"]]),
  countryCode: new Map([["unitedstates", "US"], ["us", "US"], ["usa", "US"]]),
};
const A2_FIXTURES = [
  {
    hash: "cd26fd1ed42dcfac882cad4443c0925caae1aa9d4d4bca2bcae01c0b65ad94f3",
    targeting: { include_locations: [{ city: "Armonk", state: "NY", country: "US" }, { state: "CT", country: "US" }, { country: "US" }, { city: "Nowhere" }], exclude_locations: [{ city: "Bedford", state: "NY", country: "US" }], exclude_terms: ["bar", "cafe", "janitorial", "law firm"], commercial_cleaning: true },
    people: "cleaning",
    cleaning: true,
  },
  {
    hash: "3a6a738f2328cd1ecbdaa1bad4fa5496c799ae580c9d45a433bcaffb908707ea",
    targeting: { include_locations: Array.from({ length: 310 }, (_, i) => ({ city: `Town${i}`, state: "NY", country: "US" })), exclude_terms: Array.from({ length: 320 }, (_, i) => `term${i}`) },
    people: { titles: ["Owner", "Office Manager", "Facility Manager"], title_mode: "WORD", exclude_titles: ["intern", "sales"], seniority: ["owner", "director"], departments: ["operations"], employee_bands: [{ start: 11, end: 50 }, { start: 1001 }], industries: ["Dental", "real estate"], exclude_industries: ["legal services", "x".repeat(130)] },
    cleaning: false,
  },
  {
    hash: "2bb8e476f206ad92ac3f3df0614c324e46113bb22539fd3a05e235598a4abf99",
    targeting: { include_locations: [{ city: "Springfield", state: "IL", country: "US" }, { city: "Peoria", state: "IL", country: "US" }], exclude_locations: [{ city: "Normal", state: "IL", country: "US" }], exclude_terms: Array.from({ length: 120 }, (_, i) => `client exclusion phrase number ${i}`), commercial_cleaning: true },
    people: { titles: ["Owner"], title_mode: "SMART", employee_bands: [{ start: 8, end: 6800 }], exclude_industries: ["janitorial service"] },
    cleaning: true,
  },
];

// The company in AI Ark's own Company Search example (docs, read 2026-11-13),
// trimmed, its phone made up: a state written "nj - new jersey", no country, a
// scheme on link.domain, and a headcount outside its band.
const DOCS_COMPANY = {
  id: "4446fca0-f6b2-5c42-7783-92f7a1eeac7f",
  summary: { name: "Jet", legal_name: "Jet.com, Inc", type: "PUBLIC_COMPANY", industry: "retail", staff: { total: 1537, range: { start: 5001, end: 10000 } } },
  link: { website: "http://www.walmart.com", domain: "http://www.jet.com", linkedin: "https://www.linkedin.com/company/jet-com" },
  contact: { email: "help@jet.com", phone: { raw: "(555) 010-0199", sanitized: "5550100199" } },
  location: {
    headquarter: { state: "nj - new jersey", city: "hoboken", street: "221 river street", postal_code: "07030" },
    locations: [{ state: "nj - new jersey", city: "hoboken", street: "221 river street", postal_code: "07030" }],
  },
  last_updated: "2026-02-17",
};

/** A fake AI Ark answering in order; the token is made up and must never show in an error. */
function fakeAiArk(answers) {
  const sent = [];
  const transport = async (req) => {
    sent.push(req);
    const a = answers.shift();
    if (a instanceof Error) throw a;
    return { status: a.status, headers: new Headers(a.headers ?? {}), text: JSON.stringify(a.json ?? {}) };
  };
  return { client: createAiArk({ token: "made-up-token-ab12", transport, wait: fastWait }), sent };
}
const failure = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};

async function partA(geo) {
  section("A1. What AI Ark is asked for companies");
  const t = { include_locations: [IL("Springfield"), { state: "NY", country: "US" }, { country: "US" }, { city: "Nowhere" }], exclude_locations: [IL("Normal")], exclude_terms: ["janitorial", "bar", "home-based business"] };
  const r = buildCompanyRequests({ targeting: t, filters: companyFiltersFor(null, "Cleaning").value, geo, cleaning: true });
  const acc = r.requests[0]?.account;
  check("places go as City, State, a state or a country; excluded places too", JSON.stringify(acc?.location?.any) === JSON.stringify({ include: ["Springfield, Illinois", "New York", "United States"], exclude: ["Normal, Illinois"] }), JSON.stringify(acc?.location));
  check("an entry that can't be placed is reported, not sent", r.report.locations.dropped.length === 1 && r.notes.some((n) => n.includes("left out")));
  check("a cleaning client with nothing saved: 8 to 6,800 employees, 13 industries left out (STRICT), its company types left out",
    JSON.stringify(acc?.employeeSize) === '{"type":"RANGE","range":[{"start":8,"end":6800}]}' && acc.industries?.any?.exclude?.mode === "STRICT" && acc.industries.any.exclude.content.length === 13 && acc.type?.any?.exclude?.join() === "GOVERNMENT_AGENCY,SELF_EMPLOYED");
  check("excluded words on NAME, INDUSTRY and DESCRIPTION, in WORD mode", acc?.keyword?.any?.exclude?.sources?.map((s) => `${s.source}:${s.mode}`).join() === "NAME:WORD,INDUSTRY:WORD,DESCRIPTION:WORD");
  check("no job titles, seniority or departments", !JSON.stringify(r.requests).includes("experience") && !r.requests.some((q) => q.contact));
  const saved = buildCompanyRequests({ targeting: t, filters: { employee_bands: [{ start: 11, end: 50 }], industries: ["dental"], exclude_industries: ["legal services"] }, geo, cleaning: false });
  const sa = saved.requests[0]?.account;
  check("saved size bands; industries in WORD mode, those left out in STRICT; no company types for other clients",
    JSON.stringify(sa?.employeeSize?.range) === '[{"start":11,"end":50}]' && sa.industries.any.include.mode === "WORD" && sa.industries.any.exclude.mode === "STRICT" && !sa.type);
  const many = buildCompanyRequests({
    targeting: { include_locations: Array.from({ length: 400 }, (_, i) => ({ city: `Town${i}`, state: "NY", country: "US" })), exclude_terms: Array.from({ length: 320 }, (_, i) => `client term ${i}`) },
    filters: null, geo, cleaning: true,
  });
  const groups = many.requests.map((q) => q.account.location.any.include);
  check("place groups within 950 bytes and 300 values, none lost or repeated", many.requests.length > 1 && groups.every((g) => bytes(g) <= 950 && g.length <= 300) && new Set(groups.flat()).size === 400 && groups.flat().length === 400);
  const kw = many.requests[0].account.keyword.any.exclude.content;
  const uncovered = CLEANING_EXCLUDE_KEYWORDS.filter((k) => !kw.some((x) => hasWords(k, x)));
  check("the standard keywords are never cut; client terms stop at 1,900 bytes, with a note", uncovered.length === 0 && bytes(kw) <= 1900 && many.notes.some((n) => n.includes("room for")), `${bytes(kw)} bytes, ${uncovered.length} standard keywords uncovered`);
  check("blocker: no rules", buildCompanyRequests({ targeting: null, geo }).blockers.length === 1);
  const noPlaces = buildCompanyRequests({ targeting: { include_locations: [], exclude_locations: [{ state: "NY", country: "US" }] }, geo });
  check("blocker: no places, so no search is ever made of exclusions alone", noPlaces.blockers.length === 1 && noPlaces.requests.length === 0);
  const huge = buildCompanyRequests({ targeting: { include_locations: Array.from({ length: 3000 }, (_, i) => ({ city: `Somewhere Long Town Name ${i}`, state: "NY", country: "US" })) }, geo });
  check("blocker: more than 50 searches", huge.blockers.length === 1 && /more than one pull/.test(huge.blockers[0]) && huge.requests.length === 0);
  check("every search has places to include", [...r.requests, ...many.requests].every((q) => q.account.location.any.include.length > 0));
  check("the brake: a 100-company pull with 1 search stops at 16 credits", companySpendCeiling(100, 1) === 16);

  section("A2. People requests send the same bytes as before the refactor");
  for (const [i, f] of A2_FIXTURES.entries()) {
    const out = buildRequests({ targeting: f.targeting, people: f.people === "cleaning" ? CLEANING_DEFAULTS : f.people, geo: A2_GEO, cleaning: f.cleaning });
    const hash = createHash("sha256").update(JSON.stringify(out)).digest("hex");
    check(`fixture ${i + 1}: buildRequests' answer matches the snapshot taken at main`, hash === f.hash, hash);
  }

  section("A3. Company Search through a fake transport");
  {
    const { client, sent } = fakeAiArk([{ status: 200, json: { content: [{ id: "a" }, { id: "b" }], totalElements: 7 }, headers: { "X-Credit": "-0.2" } }]);
    const p = await client.companySearch({ account: {} }, { page: 2, size: 2, lists: ["L1"] });
    const body = JSON.parse(sent[0].body);
    check("200: the companies, the total, X-Credit, company_id lists, page and size", p.content.length === 2 && p.totalElements === 7 && p.credits === 0.2 && sent[0].url.endsWith("/v1/companies") && JSON.stringify(body.lists) === '{"company_id":{"exclude":["L1"]}}' && body.page === 2 && body.size === 2);
  }
  check("200 empty: no matches, nothing charged", (await fakeAiArk([{ status: 200, json: { content: [], totalElements: 0 } }]).client.companySearch({}, {})).credits === 0);
  check("404: no matches", (await fakeAiArk([{ status: 404, json: { status: 404, error: "data not found" } }]).client.companySearch({}, {})).content.length === 0);
  check("400 too large: an error, with AI Ark's message kept", /request size must less/.test((await failure(() => fakeAiArk([{ status: 400, json: { status: 400, error: "request size must less or equal to {0,number} bytes" } }]).client.companySearch({}, {})))?.message ?? ""));
  const e401 = await failure(() => fakeAiArk([{ status: 401, json: {} }]).client.companySearch({}, {}));
  const e403 = await failure(() => fakeAiArk([{ status: 403, json: {} }]).client.companySearch({}, {}));
  const e402 = await failure(() => fakeAiArk([{ status: 402, json: {} }]).client.companySearch({}, {}));
  check("401 and 403: the key; 402: out of credits", e401?.kind === "key" && e403?.kind === "key" && e402?.kind === "credits");
  {
    const { client, sent } = fakeAiArk([{ status: 429, json: { message: "API rate limit exceeded" }, headers: { "retry-after": "2" } }, { status: 200, json: { content: [{ id: "a" }] } }]);
    check("429 with Retry-After, then success", (await client.companySearch({}, {})).content.length === 1 && sent.length === 2);
  }
  {
    const { client, sent } = fakeAiArk([{ status: 503, json: {} }, { status: 200, json: { content: [] } }]);
    check("5xx: not tried again (a repeat could pay twice)", (await failure(() => client.companySearch({}, {})))?.kind === "server" && sent.length === 1);
    const lost = fakeAiArk([Object.assign(new TypeError("fetch failed made-up-token-ab12"), { cause: { code: "ECONNRESET" } }), { status: 200, json: { content: [] } }]);
    const e = await failure(() => lost.client.companySearch({}, {}));
    check("no answer at all: not tried again, and the key never shows in the error", e?.kind === "network" && lost.sent.length === 1 && !e.message.includes("made-up-token-ab12"));
  }
  check("an answer with no list of companies is a failed read", (await failure(() => fakeAiArk([{ status: 200, json: { totalElements: 3 } }]).client.companySearch({}, {})))?.kind === "server");
  check("X-Credit missing: 0.1 a company", (await fakeAiArk([{ status: 200, json: { content: [{ id: "a" }, { id: "b" }, { id: "c" }] } }]).client.companySearch({}, {})).credits === 0.3);
  check("X-Credit not a number: 0.1 a company", (await fakeAiArk([{ status: 200, json: { content: [{ id: "a" }] }, headers: { "X-Credit": "n/a" } }]).client.companySearch({}, {})).credits === 0.1);

  section("A4. Exclusion lists by type");
  {
    const { client, sent } = fakeAiArk([{ status: 200, json: { id: "L" } }, { status: 200, json: { id: "M" } }]);
    await client.createList(["x"], "company_id");
    await client.createList(["y"]);
    check("createList sends company_id when asked; the people call still sends people_id", JSON.parse(sent[0].body).type === "company_id" && JSON.parse(sent[1].body).type === "people_id");
  }

  section("A5. A company's input cells");
  const ji = companyInputs(DOCS_COMPANY);
  check("the docs' example: the domain without its scheme, the headcount outside its band, every value text",
    ji.domain === "jet.com" && ji.employees === "1,537 (5,001–10,000)" && ji.aiark_email === "help@jet.com" && Object.values(ji).every((v) => typeof v === "string"), JSON.stringify({ d: ji.domain, e: ji.employees }));
  const jo = JSON.parse(ji.offices);
  check("the docs' example: its head office listed once (AI Ark repeats it among the offices), first", jo.length === 1 && jo[0].hq === true && jo[0].state === "nj - new jersey", ji.offices);
  const jr = resolveOffice(jo[0], geo);
  check("the docs' example: \"nj - new jersey\" with no country is New Jersey, US", jr.country === "US" && jr.state === "NJ" && jr.city === "hoboken", JSON.stringify(jr));
  // The company inside the docs' People Search example: "Madison, Wi", no state.
  const madison = {
    id: "v", summary: { name: "Example Cleaning", staff: { total: 113, range: { start: 11, end: 50 } } }, link: { domain: "example-madison.example" },
    location: { headquarter: { continent: "North America", country: "United States", city: "Madison, Wi" }, locations: [{ continent: "North America", country: "United States", city: "Madison, Wi" }] },
  };
  const mo = officesOf(madison);
  check("\"Madison, Wi\" with no state: city Madison, state Wisconsin", mo.length === 1 && mo[0].city === "Madison" && resolveOffice(mo[0], geo).state === "WI", JSON.stringify(mo));
  const big = { id: "x", location: { headquarter: { city: "A", state: "Ohio", country: "United States" }, locations: Array.from({ length: 40 }, (_, i) => ({ city: `B${i}`, state: "Ohio", country: "United States" })) } };
  const bigInputs = companyInputs(big);
  check("offices without repeats, head office first, at most 25", JSON.parse(bigInputs.offices).length === 25 && JSON.parse(bigInputs.offices)[0].hq === true && bigInputs.office_count === "41");

  section("A6. Place keys");
  const entries = [IL("Springfield"), { state: "IL", country: "US" }, { country: "US" }];
  const keys = companyPlaceKeys({ location: { headquarter: { city: "springfield", state: "il - illinois" } } }, geo);
  check("an office's keys and a client entry's key agree, for a city, a state and a country", entries.every((e) => keys.includes(placeKeyOf(e))), JSON.stringify({ keys, entries: entries.map(placeKeyOf) }));
  const match = companyMatch({ targeting: { include_locations: [IL("Springfield")], exclude_locations: [IL("Normal")] }, request: r.requests[0], geo });
  const rec = (location, summary = {}) => ({ id: "c", summary: { name: "Northgate Dental Group", industry: "dental", type: "PRIVATELY_HELD", staff: { total: 20, range: { start: 11, end: 50 } }, ...summary }, industries: ["dental"], location });
  check("the free copy takes a company with its head office in the place", matchesCompanyFilters(rec({ headquarter: { city: "Springfield", state: "Illinois", country: "United States" } }), match, geo));
  check("... or a branch in it", matchesCompanyFilters(rec({ headquarter: { city: "Bismarck", state: "North Dakota", country: "United States" }, locations: [{ city: "Springfield", state: "IL", country: "United States" }] }), match, geo));
  check("... but not one with no office there", !matchesCompanyFilters(rec({ headquarter: { city: "Peoria", state: "Illinois", country: "United States" } }), match, geo));
  check("... nor one with an office in an excluded place", !matchesCompanyFilters(rec({ headquarter: { city: "Springfield", state: "Illinois" }, locations: [{ city: "Normal", state: "IL" }] }), match, geo));
  check("... nor a government agency, for a cleaning client", !matchesCompanyFilters(rec({ headquarter: { city: "Springfield", state: "Illinois" } }, { type: "GOVERNMENT_AGENCY" }), match, geo));
  check("... nor one whose name holds an excluded word", !matchesCompanyFilters(rec({ headquarter: { city: "Springfield", state: "Illinois" } }, { name: "Springfield Janitorial" }), match, geo));

  section("A7. Phase 1's own steps are gone");
  check("no pick_emails or verify_emails action, and no v1 columns or prompts in company-template.mjs",
    !("pick_emails" in ACTIONS) && !("verify_emails" in ACTIONS) && ["COMPANY_COLUMNS", "PROMPTS", "WEBSITE_PROMPT", "EMAIL_PROMPT_FIRST", "EMAIL_PROMPT_SECOND", "COMPANY_TEMPLATE"].every((k) => !(k in companyTemplate)));
  check("phase 1's three model settings and its checks per company are not read", !MODEL_SETTINGS.some((k) => ["website_search", "email_search_first", "email_search_second"].includes(k)) && !("email_checks_per_company" in settingsFrom([]).company_pipeline));
  check("C#34's stand-in pulls the addresses out of free text, lower case, once each, in order, and no URL",
    JSON.stringify(emailsIn("Write to OFFICE@acme.example, or info@acme.example; office@acme.example. https://www.acme.example/contact")) === JSON.stringify(["office@acme.example", "info@acme.example"]));

  section("A8. Reoon's verdicts");
  const vw = source("scripts/validation-worker.mjs");
  const mapStatus = new Function(`${/function mapStatus\(native\) \{[\s\S]*?\n\}/.exec(vw)[0]}; return mapStatus;`)();
  const natives = ["safe", "valid", "role_account", "catch_all", "invalid", "disposable", "spamtrap", "disabled", "inbox_full", "unknown", "", "weird", "SAFE"];
  check("every Reoon word maps as mapStatus in validation-worker.mjs maps it", natives.every((n) => mapStatus(n) === mapReoonStatus(n)));
  const fakeDb = (known = []) => ({ query: async (sql) => ({ rows: sql.includes("FROM email_validations") ? known : [] }) });
  resetCompanyActions();
  const noKey = await ACTIONS.reoon_verify.run({ inputs: { email: "ok@a8.cptest.example" }, env: {}, db: fakeDb(), settings: settingsFrom([]) });
  const reused = await ACTIONS.reoon_verify.run({ inputs: { email: "gone@a8.cptest.example" }, env: {}, db: fakeDb([{ native_status: "invalid", validated_at: new Date() }]), settings: settingsFrom([]) });
  check("no key: the cell waits; a final rejection already held is reused for free, key or not",
    noKey.status === "needs_key" && /ENRICH_REOON_API_KEY/.test(noKey.note) && reused.status === "done" && reused.value.status === "invalid" && /Reused/.test(reused.note) && net.calls.reoon === 0,
    JSON.stringify({ noKey, reused }));

  section("A9. The companies_v2 template, compiled from the made-up originals");
  const COLS = COMPILED.companies;
  const keySet = new Set(COLS.map((c) => c.key));
  const exprs = (c) => [c.formula, c.run_if, ...(c.waterfall ?? []), ...Object.values(c.inputs ?? {})].filter(Boolean);
  const absent = new Set([...COMPANY_ABSENT_KEYS, "created_at"]);
  check("the three templates compile, and order() finds no loop", COLS.length > 40 && COMPILED.inboxes.length > 30 && COMPILED.people.length > 50);
  check("every action is in ACTIONS", Object.values(COMPILED).flat().filter((c) => c.kind === "action").every((c) => ACTIONS[c.action]));
  check("every {{key}} is a column, or one the template declares absent", COLS.every((c) => exprs(c).every((x) => [...refs(x)].every((k) => keySet.has(k) || absent.has(k)))));
  const byKey = new Map(COLS.map((c) => [c.key, c]));
  const reaches = (key, seen = new Set()) => {
    if (key === "passes_filters" || key === "master_filter") return true;
    if (seen.has(key)) return false;
    seen.add(key);
    const c = byKey.get(key);
    return c ? [...refs(c.run_if ?? "")].some((k) => reaches(k, seen)) : false;
  };
  const paid = COLS.filter((c) => c.phase === 1 && (c.action === "ai_web" || c.action === "reoon_verify"));
  check("every paid column's run condition needs the client's rules (the Master Filter or passes_filters), directly or through the column it reads", paid.length === 8 && paid.every((c) => reaches(c.key)), paid.filter((c) => !reaches(c.key)).map((c) => c.key).join());
  check("ROLE_PREFIX_SOURCE is ROLE_PREFIXES in detect-email-type.ts", source("src/lib/uploads/detect-email-type.ts").includes(`/${ROLE_PREFIX_SOURCE}/i`));
  const shipped = JSON.stringify({ COMPANY_COLUMNS_V2, INBOX_COLUMNS, PEOPLE_COLUMNS, DIRECTORY_BLOCKLIST, JUNK_LOCAL_PARTS, JUNK_DOMAINS });
  const clients = await all(`SELECT tag, name FROM client_tags WHERE NOT starts_with(tag, $1)`, [PREFIX]);
  const names = [...new Set(clients.flatMap((c) => [c.tag, c.name]).filter((s) => typeof s === "string" && s.trim().length >= 3).map((s) => s.trim().toLowerCase()))];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = names.filter((n) => new RegExp(`(^|[^a-z0-9])${esc(n)}($|[^a-z0-9])`, "i").test(shipped));
  check(`the template modules and lists name none of the ${clients.length} local clients`, named.length === 0, `${named.length} client tags or names found (not printed)`);
  check("nothing in them is shaped like a key", !/sk-[A-Za-z0-9_-]{20,}|Bearer [A-Za-z0-9._-]{24,}|key=[A-Za-z0-9]{20,}/.test(shipped));

  section("A10. ai_web's request (C#24, compiled from the made-up originals)");
  const c24 = { ...COLS.find((c) => c.key === "companys_website"), run_if: null, position: 99 };
  const cols = [
    ...["company", "use_city", "use_state", "use_address", "category", "sub_category", "company_linkedin_url"].map((key, i) => ({ key, kind: "input", position: i, phase: 1 })),
    c24,
  ];
  const cellsOf = () => new Map([
    ["company", { status: "done", value: "A10 Dental" }],
    ["use_city", { status: "done", value: "Springfield" }],
    ["use_state", { status: "done", value: "IL" }],
  ]);
  const memoryDb = { query: async () => ({ rows: [] }) }; // no answer remembered, and nothing kept
  const ask = async (settings) => {
    const out = { body: null, run: null, hash: null, cell: null };
    const sentBefore = net.bodies.length;
    const res = await runRow({
      row: { id: 1, created_at: new Date() }, table: { client_tag: tag("A10"), template: "companies_v2" }, columns: cols, cells: cellsOf(),
      env: KEYS, db: memoryDb, settings,
      hooks: { changed: (k, c) => k === "companys_website" && Object.assign(out, { hash: c.input_hash, cell: c }), ran: (x) => (out.run = x) },
    });
    out.body = net.bodies.length > sentBefore ? net.bodies.at(-1) : null;
    return { ...out, res };
  };
  const s1 = settingsFrom([{ key: "models", value: { companys_website: { model: "gpt-4o-mini", max_searches: 2 } } }]);
  const s2 = settingsFrom([{ key: "models", value: { companys_website: { model: "gpt-5-nano", reasoning_effort: "low", max_searches: 3 } } }]);
  const a = await ask(s1);
  const b1 = a.body;
  check("the model comes from the setting; the web_search tool with no user location (the originals send none), max_tool_calls, no reasoning",
    b1?.model === "gpt-4o-mini" && JSON.stringify(b1.tools) === '[{"type":"web_search"}]' && b1.max_tool_calls === 2 && !b1.reasoning && b1.input.includes("business=A10 Dental;"), JSON.stringify(b1)?.slice(0, 300));
  check("the number of searches is kept with the usage", a.run?.response?.web_searches === 2 && a.run.response.usage.input_tokens === 900, JSON.stringify(a.run?.response));
  const b = await ask(s2);
  check("reasoning is sent only when the setting has it", b.body?.model === "gpt-5-nano" && b.body.reasoning?.effort === "low" && b.body.max_tool_calls === 3);
  check("swapping the model changes the model, not the cell's input hash", a.hash && a.hash === b.hash, `${a.hash} / ${b.hash}`);
  const missing = await ask(settingsFrom([{ key: "models", value: { companys_website: null } }]));
  check("a missing model setting is an error, never another model", missing.res.errors === 1 && !missing.body && /No model is set/.test(missing.cell?.note ?? ""));
  check("page sizes divide the offset they start at", pageSizeAt(0, 37) === 37 && pageSizeAt(300, 37) === 30 && pageSizeAt(330, 7) === 6 && pageSizeAt(9797, 2) === 1);
}

// ── B. Demo pulls ───────────────────────────────────────────────────────────

const A = tag("A"); // cleaning, Springfield and Peoria: the routes, a first and a second pull
const B = tag("B"); // Springfield, saved size band: copies at no charge
const C = tag("C"); // a crash, then the brake
const D = tag("D"); // a claim lost mid-slice
const E = tag("E"); // the 10,000 cap, lowered
const E2 = tag("E2"); // the cap with no lists left
const F = tag("F"); // cancel, errors, lost pages
const K = tag("K"); // the shared list budget, live pulls

async function partB(routes) {
  const { setup, count, runs, cancel } = routes;
  await addClient(A, { type: "Cleaning", places: [IL("Springfield"), IL("Peoria")], terms: ["bar"], cleaning: true });
  await addClient(B, { places: [IL("Springfield")], filters: { employee_bands: [{ start: 11, end: 50 }] } });
  await addClient(C, { places: [IL("Decatur"), IL("Champaign"), IL("Rockford")] });
  await addClient(D, { places: [IL("Joliet"), IL("Elgin")] });
  await addClient(E, { places: [IL("Aurora"), IL("Naperville")] });
  await addClient(E2, { places: [IL("Evanston")] });
  await addClient(F, { places: [IL("Waukegan"), IL("Cicero")] });
  await addClient(K, { places: [IL("Skokie")] });
  resetClientChecks();
  T.worker = heartbeat();

  section("B1. The pull route: a first pull makes the table, a source and a run");
  const versions = async (t) => {
    const s = await call(setup.GET, { query: { tag: t } });
    return { rulesVersion: s.body?.targeting?.version ?? null, filtersVersion: s.body?.filters?.version ?? null, setup: s };
  };
  let v = await versions(A);
  check("the setup route: rules, company filters (a cleaning client's defaults), one search, the worker", v.setup.status === 200 && v.setup.body.plan?.searches === 1 && v.setup.body.filters.defaultsFrom === "cleaning" && v.setup.body.worker?.companyRuns === true && v.setup.body.pipeline.enabled === true, JSON.stringify(v.setup.body?.plan?.blockers ?? v.setup.body));
  const counted = await call(count.POST, { body: { tag: A, mode: "demo", ...v } });
  const c = counted.body;
  check("the count: the matches, per search, the credits, 5 example companies", counted.status === 200 && c.total > 0 && c.perSearch.length === 1 && c.total === c.perSearch[0] && c.sample.length === Math.min(5, c.total) && c.credits === Math.round(Math.min(5, c.total) * 10) / 100, JSON.stringify(c).slice(0, 300));
  const pullBody = (over = {}) => ({ tag: A, mode: "demo", size: 40, matchCount: c.total, rulesVersion: v.rulesVersion, filtersVersion: v.filtersVersion, ...over });
  check("no count, no pull (409)", (await call(runs.POST, { body: pullBody({ matchCount: undefined }) })).status === 409);
  check("a size over the largest pull in the settings: 400", (await call(runs.POST, { body: pullBody({ size: 1001 }) })).status === 400);
  T.worker = heartbeat({ online: false });
  check("worker offline: 409", (await call(runs.POST, { body: pullBody() })).status === 409);
  T.worker = heartbeat({ companyRuns: false });
  check("a worker that doesn't do company pulls: 409", (await call(runs.POST, { body: pullBody() })).status === 409);
  T.worker = heartbeat();
  T.role = "viewer";
  check("viewers can't count or pull (403)", (await call(count.POST, { body: { tag: A, mode: "demo", ...v } })).status === 403 && (await call(runs.POST, { body: pullBody() })).status === 403);
  T.role = "manager";
  await setPipeline(false);
  check("pulls switched off: the count and the pull are refused (409)", (await call(count.POST, { body: { tag: A, mode: "demo", ...v } })).status === 409 && (await call(runs.POST, { body: pullBody() })).status === 409);
  await pool.query(`UPDATE enrich_settings SET value = value || '{"enabled": true, "tags": []}'::jsonb WHERE key = 'company_pipeline'`);
  const notListedCount = await call(count.POST, { body: { tag: A, mode: "demo", ...v } });
  const notListedPull = await call(runs.POST, { body: pullBody() });
  check("pulls on, but the client not on their client list: the count and the pull are refused (409)",
    notListedCount.status === 409 && /client list/.test(notListedCount.body?.error ?? "") && notListedPull.status === 409 && /client list/.test(notListedPull.body?.error ?? ""));
  await setPipeline(true);
  const first = await call(runs.POST, { body: pullBody() });
  const run1 = first.body?.run;
  check("the pull is queued (201)", first.status === 201 && run1?.status === "queued" && run1.size_requested === 40, JSON.stringify(first.body).slice(0, 300));
  const table = await one(`SELECT kind, template, name FROM enrich_tables WHERE id = $1`, [run1?.table_id]);
  const sources = await all(`SELECT kind, meta->>'run_id' AS run FROM enrich_sources WHERE table_id = $1 ORDER BY kind`, [run1?.table_id]);
  const three = await all(`SELECT kind, template, name FROM enrich_tables WHERE client_tag = $1 ORDER BY kind`, [A]);
  check("its table is the client's Companies template table (companies_v2), made with its General inboxes and People tables",
    table?.kind === "companies" && table.template === "companies_v2" && table.name === "Companies (pipeline)" && three.map((x) => x.template).join() === "companies_v2,inboxes_v1,people_v1", JSON.stringify(three));
  check("a source for what it buys and one for what it copies free", sources.map((s) => `${s.kind}:${s.run === run1?.id}`).join() === "ai_ark:true,registry:true", JSON.stringify(sources));
  check("a second pull while one is going: 409", (await call(runs.POST, { body: pullBody() })).status === 409);
  check("the pull is in the audit log; a demo count writes none, as on the AI Ark tab", !T.audits.some((x) => x.action === "companies_count") && T.audits.some((x) => x.action === "companies_run"), JSON.stringify(T.audits.map((x) => x.action)));

  section("B2. A rules change after the count");
  await pool.query(`UPDATE client_targeting SET exclude_terms = exclude_terms || '{cptest term}', updated_at = now() WHERE client_tag = $1`, [A]);
  resetClientChecks();
  const stale = await call(count.POST, { body: { tag: A, mode: "demo", ...v } });
  check("the count answers 409 with changed, and spends nothing", stale.status === 409 && stale.body.changed === true);

  section("B3. A pull to its size");
  const txA = createDemoTransport({});
  const st1 = await drive(run1.id, demoClient(txA));
  const r1 = await runOf(run1.id);
  const tableA = r1.table_id;
  const cells = await one(`SELECT count(DISTINCT c.row_id)::int AS rows, count(*)::int AS cells FROM enrich_cells c JOIN enrich_rows r ON r.id = c.row_id WHERE r.table_id = $1`, [tableA]);
  const registered = await one(`SELECT count(*)::int AS n FROM aiark_companies WHERE run_id = $1`, [run1.id]);
  const src = await one(`SELECT received, created FROM enrich_sources WHERE id = $1`, [r1.source_id]);
  check("done at its size", st1 === "done" && r1.pulled === 40, `${st1} ${r1.pulled} ${r1.stop_reason ?? ""}`);
  check("rows, input cells, the registry and the counters agree", (await rowsIn(tableA)) === 40 && cells.rows === 40 && cells.cells >= 40 * 8 && registered.n === 40 && r1.progress.bought === 40 && r1.bought_before === 0, JSON.stringify({ cells, registered: registered.n, bought: r1.progress.bought }));
  check("credits are 0.1 a company returned, as AI Ark charged them", Number(r1.credits_used) === 4 && txA.state.charged === 4, `${r1.credits_used} vs ${txA.state.charged}`);
  check("the sources count what came in", src.received === 40 && src.created === 40, JSON.stringify(src));
  check("the balance before and after is recorded", r1.credits_before != null && r1.credits_after != null);

  section("B4. A second pull for the same client");
  check("a pull with the rules it was counted for, after they changed: 409", (await call(runs.POST, { body: pullBody() })).status === 409);
  v = await versions(A);
  const recount = await call(count.POST, { body: { tag: A, mode: "demo", ...v } });
  const second = await call(runs.POST, { body: pullBody({ matchCount: recount.body?.total, ...v }) });
  const run2 = second.body?.run;
  check("the second pull reuses the client's table", second.status === 201 && run2?.table_id === tableA);
  const colCount = await one(`SELECT count(*)::int AS n, count(DISTINCT key)::int AS k FROM enrich_columns WHERE table_id = $1`, [tableA]);
  check("its columns were brought up to date, not added twice", colCount.n === COMPILED.companies.length && colCount.k === colCount.n, JSON.stringify(colCount));
  await drive(run2.id, demoClient(txA));
  const r2 = await runOf(run2.id);
  const firstBought = await boughtBy(run1.id);
  const overlap = [...(await boughtBy(run2.id))].filter((id) => firstBought.has(id)).length;
  check("it buys none of the first pull's companies", r2.bought_before === 0 && overlap === 0 && (await repeatedKeys(tableA)) === 0 && r2.progress.excluded >= 40, JSON.stringify({ before: r2.bought_before, overlap, excluded: r2.progress.excluded }));
  check("... and pays only for what it bought", Number(r2.credits_used) === Math.round((r2.progress.bought ?? 0) * 10) / 100);

  section("B5. Another client sharing a place: copied at no charge");
  const vB = await versions(B);
  const countB = await call(count.POST, { body: { tag: B, mode: "demo", ...vB } });
  const pullB = await call(runs.POST, { body: { tag: B, mode: "demo", size: 300, matchCount: countB.body?.total ?? 0, ...vB } });
  const runB = pullB.body?.run;
  await drive(runB.id, demoClient(createDemoTransport({})));
  const rb = await runOf(runB.id);
  const copied = await all(
    `SELECT c.record, c.company_id FROM enrich_rows r JOIN aiark_companies c ON 'aiark:' || c.company_id = r.row_key
      WHERE r.table_id = $1 AND r.source_id = $2`,
    [rb.table_id, rb.registry_source_id]
  );
  const copyMatch = rb.filters.copy;
  const fromA = new Set([...firstBought, ...(await boughtBy(run2.id))]);
  check("A's companies in Springfield that fit B's size band are copied", rb.from_registry > 0 && copied.length === rb.from_registry && copied.every((x) => fromA.has(x.company_id)), JSON.stringify({ copied: rb.from_registry }));
  check("every copy has an office in B's places and passes B's filters", copied.every((x) => companyPlaceKeys(x.record, GEO).includes("US|IL|springfield") && matchesCompanyFilters(x.record, copyMatch, GEO)));
  check("copies cost nothing: the credits are what B bought", Number(rb.credits_used) === Math.round((rb.progress.bought ?? 0) * 10) / 100, JSON.stringify({ used: rb.credits_used, bought: rb.progress.bought, copied: rb.from_registry }));
  // B's lists leave out the registry companies with an office in B's places. One
  // AI Ark matched to the place but whose offices the lead database places
  // elsewhere is in neither the copy nor the lists, so it can be paid for again
  // (0.1 credit) and is then "Outside the client's area". Nothing else can be.
  const again = await all(
    `SELECT c.place_keys FROM enrich_rows r JOIN enrich_cells p ON p.row_id = r.id AND p.column_key = 'pulled_before'
       JOIN aiark_companies c ON 'aiark:' || c.company_id = r.row_key
      WHERE r.table_id = $1 AND r.source_id = $2`,
    [rb.table_id, rb.source_id]
  );
  check("a company bought again is only one with no office in B's places", again.length === rb.bought_before && again.every((x) => !x.place_keys.some((k) => copyMatch.include.includes(k))), JSON.stringify({ before: rb.bought_before, again: again.length }));
  await settle();

  section("B6. A crash before a page is written, and a claim lost mid-slice");
  {
    const tx = createDemoTransport({ companiesPerPlace: 80 });
    const cf = demoClient(tx);
    const run = await newRun(C, { size: 100 });
    await step(cf); // the registry copy
    await step(cf); // the lists
    let fails = 4; // the write and its 3 retries
    const crashing = {
      query: (sql, params) => {
        if (sql.includes("WITH st AS") && fails-- > 0) return Promise.reject(new Error("Connection terminated unexpectedly"));
        return pool.query(sql, params);
      },
    };
    const calls0 = tx.state.companyCalls;
    await advanceOneCompanyRun({ pool: crashing, env: { AIARK_DEMO: "1" }, clientFor: cf, log: quiet });
    const mid = await runOf(run.id);
    await due(run.id);
    const st = await drive(run.id, cf);
    const end = await runOf(run.id);
    check("the page bought but never written is bought again on resume, once", mid.pulled === 0 && mid.attempts === 1 && tx.state.companyCalls - calls0 === 2, `${mid.pulled} ${mid.attempts} ${tx.state.companyCalls - calls0}`);
    check("... and its companies go in once", st === "done" && end.pulled === 100 && (await rowsIn(end.table_id)) === 100 && (await repeatedKeys(end.table_id)) === 0);
  }
  {
    const tx = createDemoTransport({ companiesPerPlace: 80 });
    const cf = demoClient(tx);
    const run = await newRun(D, { size: 300 });
    await step(cf);
    await step(cf);
    let stolen = false;
    const thief = {
      query: async (sql, params) => {
        if (!stolen && sql.includes("WITH st AS")) {
          stolen = true; // another worker takes the pull just as this one writes
          await pool.query(`UPDATE aiark_company_runs SET claim_token = gen_random_uuid(), claimed_at = now() - interval '11 minutes' WHERE id = $1`, [run.id]);
        }
        return pool.query(sql, params);
      },
    };
    const calls0 = tx.state.companyCalls;
    await advanceOneCompanyRun({ pool: thief, env: { AIARK_DEMO: "1" }, clientFor: cf, log: quiet });
    const st = await drive(run.id, cf);
    const end = await runOf(run.id);
    check("a claim lost mid-slice: the page is written anyway (it is paid for), the resume repeats at most that page",
      st === "done" && tx.state.companyCalls - calls0 <= 3 && end.pulled === 160 && (await rowsIn(end.table_id)) === 160 && (await repeatedKeys(end.table_id)) === 0,
      JSON.stringify({ st, calls: tx.state.companyCalls - calls0, pulled: end.pulled, rows: await rowsIn(end.table_id) }));
  }

  section("B7. Cancel");
  {
    const tx = createDemoTransport({ companiesPerPlace: 80 });
    const queued = await newRun(F, { size: 50 });
    const res = await call(cancel.POST, { body: { id: queued.id } });
    const worked = await step(demoClient(tx));
    const q = await runOf(queued.id);
    check("cancelled while queued: never claimed, nothing bought", res.status === 200 && worked === null && tx.state.companyCalls === 0 && q.status === "cancelled" && q.finished_at);
    check("a pull that isn't going can't be cancelled (409)", (await call(cancel.POST, { body: { id: queued.id } })).status === 409);
    const run = await newRun(F, { size: 300 });
    const cf = demoClient(tx);
    for (let i = 0; i < 3; i++) await step(cf); // copy, lists, one page
    const calls = tx.state.companyCalls;
    await call(cancel.POST, { body: { id: run.id } });
    await due(run.id);
    await step(cf);
    const m = await runOf(run.id);
    const s = await one(`SELECT received, created FROM enrich_sources WHERE id = $1`, [m.source_id]);
    check("cancelled mid-run: no paid call after it, and it stays cancelled", calls === 1 && tx.state.companyCalls === calls && m.status === "cancelled" && m.pulled === 100, `${calls} ${tx.state.companyCalls} ${m.status} ${m.pulled}`);
    check("its source counts what AI Ark returned and what was new", s.received === 100 && s.created === 100, JSON.stringify(s));
  }

  section("B8. AI Ark's errors and lost answers");
  for (const [status, want] of [[402, "stopped"], [401, "error"], [400, "error"], [429, "done"]]) {
    const tx = createDemoTransport({ companiesPerPlace: 80, faults: { companyAnswers: status === 429 ? [429, 429] : [status] } });
    const run = await newRun(F, { size: 10 });
    const st = await drive(run.id, demoClient(tx));
    const x = await runOf(run.id);
    const why = { 402: "out of credits", 401: "the key, an error", 400: "AI Ark's message, nothing charged", 429: "waits, then carries on" }[status];
    check(`${status}: ${why}`, st === want && (status === 429 ? x.pulled === 10 : Number(x.credits_used) === 0) && (status !== 400 || /request size/.test(x.last_error ?? "")), `${st} ${x.last_error ?? x.stop_reason ?? ""} ${x.credits_used}`);
  }
  {
    const tx = createDemoTransport({ companiesPerPlace: 80, faults: { companyAnswers: [{ status: 500, charge: true }, 0, 503] } });
    const run = await newRun(F, { size: 1000 });
    const st = await drive(run.id, demoClient(tx));
    const l = await runOf(run.id);
    check("3 lost answers in a row stop the pull, each counted against the brake at full price",
      st === "stopped" && l.progress.lost_pages === 3 && Number(l.progress.lost_credits) === 30 && /lost 3 times/.test(l.stop_reason ?? ""), JSON.stringify({ st, lost: l.progress.lost_pages, credits: l.progress.lost_credits, why: l.stop_reason }));
  }
  await settle();

  section("B9. The spending brake");
  {
    // AI Ark ignoring the lists: every page holds companies the client already has.
    const tx = createDemoTransport({ companiesPerPlace: 80, faults: { ignoreLists: true } });
    const run = await newRun(C, { size: 100 });
    const st = await drive(run.id, demoClient(tx));
    const x = await runOf(run.id);
    check("pages of companies already held stop at the ceiling", st === "stopped" && /spending brake/.test(x.stop_reason ?? "") && x.pulled === 0 && Number(x.credits_used) <= companySpendCeiling(100, 1) && x.bought_before === 100,
      JSON.stringify({ st, pulled: x.pulled, used: x.credits_used, before: x.bought_before }));
  }

  section("B10. AI Ark's 10,000-record cap (lowered)");
  {
    const tx = createDemoTransport({ companiesPerPlace: 80, faults: { searchCap: 60 } });
    const run = await newRun(E, { size: 400 });
    const st = await drive(run.id, demoClient(tx), { searchCap: 60 });
    const x = await runOf(run.id);
    check("at the cap the search makes its lists again and starts over, with nothing bought twice",
      st === "done" && x.stop_reason === "No more matches" && x.pulled === 160 && x.bought_before === 0 && (await repeatedKeys(x.table_id)) === 0 && Number(x.progress.restarts?.["0"]) >= 2,
      JSON.stringify({ st, pulled: x.pulled, restarts: x.progress.restarts, why: x.stop_reason }));
  }
  {
    const tx = createDemoTransport({ companiesPerPlace: 80, faults: { searchCap: 50 } });
    const run = await newRun(E2, { size: 300 });
    await pool.query(`UPDATE aiark_company_runs SET progress = jsonb_build_object('lists_log', (SELECT jsonb_agg(now()) FROM generate_series(1, 45))) WHERE id = $1`, [run.id]);
    const st = await drive(run.id, demoClient(tx), { searchCap: 50 });
    const x = await runOf(run.id);
    check("with no lists left today it moves on and records the cap", st === "done" && JSON.stringify(x.progress.capped) === "[0]" && /10,000/.test(x.stop_reason ?? "") && x.pulled === 50, JSON.stringify({ st, capped: x.progress.capped, why: x.stop_reason }));
    await pool.query(`UPDATE aiark_company_runs SET progress = progress - 'lists_log' WHERE id = $1`, [run.id]);
  }

  section("B11. People runs and company pulls share the day's 50 lists");
  {
    const cf = demoClient(createDemoTransport({ companiesPerPlace: 80 }));
    const firstK = await newRun(K, { size: 30 });
    await drive(firstK.id, cf);
    const people = await createRun(pool, {
      tag: K, mode: "demo", strategy: "single", size: 10, filters: {},
      requests: [{ contact: { location: { any: { include: ["Skokie, Illinois"] } }, experience: { latest: { title: { any: { include: { mode: "WORD", content: ["Office Manager"] } } } } } } }],
    });
    await pool.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [people.id]);
    const base = await listsMadeToday(pool, "demo");
    const logOf = (n) => JSON.stringify(Array(n).fill(new Date().toISOString()));
    await pool.query(`UPDATE aiark_runs SET progress = jsonb_set(progress, '{lists_log}', $2::jsonb) WHERE id = $1`, [people.id, logOf(20)]);
    await pool.query(`UPDATE aiark_company_runs SET progress = jsonb_set(progress, '{lists_log}', $2::jsonb) WHERE id = $1`, [firstK.id, logOf(25)]);
    const made = await listsMadeToday(pool, "demo");
    check("lists made today count both kinds of run", made - base === 45, `${base} -> ${made}`);
    const tx = createDemoTransport({ companiesPerPlace: 80 });
    const secondK = await newRun(K, { size: 30 });
    await step(demoClient(tx)); // copy
    await step(demoClient(tx)); // lists
    const x = await runOf(secondK.id);
    check("with the budget spent by people runs, a company pull makes no list and says why", tx.state.listsMade === 0 && x.progress.lists_short === true && /shared with people pulls/.test(x.progress.lists_note ?? ""), JSON.stringify({ made: tx.state.listsMade, note: x.progress.lists_note }));
    await settle();
    await pool.query(`UPDATE aiark_runs SET progress = progress - 'lists_log' WHERE id = $1`, [people.id]);
    await pool.query(`UPDATE aiark_company_runs SET progress = progress - 'lists_log' WHERE starts_with(client_tag, $1)`, [PREFIX]);
  }

  section("B12. Demo companies never reach a live pull");
  {
    const keys = companyPlaceKeys({ location: { headquarter: { city: "Skokie", state: "Illinois", country: "United States" } } }, GEO);
    await pool.query(
      `INSERT INTO aiark_companies (company_id, demo, name, place_keys, record) VALUES ($1, true, 'Made-up Demo Company', $2, $3)`,
      [`cptest-demo-${RUN}`, keys, JSON.stringify({ summary: { name: "Made-up Demo Company" }, location: { headquarter: { city: "Skokie", state: "Illinois", country: "United States" } } })]
    );
    const tx = createDemoTransport({ companiesPerPlace: 80 });
    const live = await newRun(K, { mode: "live", size: 30 });
    await step(demoClient(tx)); // copy
    await step(demoClient(tx)); // lists
    const x = await runOf(live.id);
    const heldDemo = await one(`SELECT count(*)::int AS n FROM aiark_companies WHERE demo AND place_keys && $1::text[]`, [keys]);
    check("a live pull copies none of the demo companies in its places and lists none", heldDemo.n > 1 && x.from_registry === 0 && tx.state.listsMade === 0 && Number(x.progress.excluded ?? 0) === 0, JSON.stringify({ demo: heldDemo.n, copied: x.from_registry, lists: tx.state.listsMade }));
    await settle();
  }

  section("B13. AI Ark's balance under the pipeline's minimum");
  {
    resetSettingsCache();
    const floor = settingsFrom(await all(`SELECT key, value FROM enrich_settings`)).company_pipeline.min_balance;
    const tx = createDemoTransport({ companiesPerPlace: 80, balance: Math.max(0, floor - 1) });
    const run = await newRun(F, { size: 30 });
    const st = await drive(run.id, demoClient(tx));
    const x = await runOf(run.id);
    check("a pull stops before a page is bought while the balance (read free) is under company_pipeline.min_balance",
      floor > 0 && st === "stopped" && tx.state.companyCalls === 0 && x.pulled === 0 && /under the pipeline's minimum/.test(x.stop_reason ?? ""),
      JSON.stringify({ floor, st, calls: tx.state.companyCalls, why: x.stop_reason }));
    await settle();
  }
}

/** Company pulls on or off, with every test client on their client list (company_pipeline.tags). */
async function setPipeline(enabled) {
  const tags = ["A", "B", "C", "D", "E", "E2", "F", "K", "G", "H", "W", "I", "J"].map(tag);
  await pool.query(
    `UPDATE enrich_settings SET value = value || jsonb_build_object('enabled', $1::boolean, 'tags', $2::jsonb) WHERE key = 'company_pipeline'`,
    [enabled, JSON.stringify(tags)]
  );
}

// ── C. Template rows end to end (companies_v2, on the made-up originals) ────
// scripts/test-pipeline-v2.mjs checks every compiled step. Here: phase 1's own
// checks kept in companies_v2 (the office, the client's rules, a held inbox),
// listing through the inbox rows, shared memory, missing keys and Reoon's
// credits, errors, a model swap, and the real worker.

const G = tag("G"); // the rows here
const H = tag("H"); // a second client with the same places: shared answers
const W = tag("W"); // the real worker's rows

const SPRINGFIELD = { street: "100 Main Street", city: "Springfield", state: "Illinois", country: "United States", postal_code: "62701" };
const PEORIA = { street: "200 Oak Avenue", city: "Peoria", state: "IL", country: "United States", postal_code: "61602" };
const BISMARCK = { street: "300 Lake Road", city: "Bismarck", state: "North Dakota", country: "United States", postal_code: "58501" };
const NO_STATE = { street: "400 Mill Street", city: "Cptestville", country: "United States" };

let seq = 0;
/** A made-up AI Ark company record. website/domain: "auto" for its own made-up site, a string, or null for none. */
function company(slug, name, { hq = SPRINGFIELD, branches = [], website = "auto", domain = "auto", email = null, industry = "dental" } = {}) {
  const d = dom(slug);
  const id = `cptest-${RUN}-${++seq}`;
  const site = website === "auto" ? `https://www.${d}` : website;
  return {
    id,
    summary: { name, industry, type: "PRIVATELY_HELD", staff: { total: 20, range: { start: 11, end: 50 } }, description: `${name} is a made-up business for the company pipeline tests.` },
    link: { ...(site ? { website: site } : {}), ...(domain === "auto" ? { domain: d } : domain ? { domain } : {}), linkedin: `https://linkedin.${TEST_HOST}/company/${slug}` },
    contact: { ...(email ? { email } : {}), phone: { raw: "(217) 555-0100", sanitized: "2175550100" } },
    location: { headquarter: hq, locations: [hq, ...branches] },
    industries: [industry],
    last_updated: "2026-10-01",
  };
}
const at = (slug, local) => `${local}@${dom(slug)}`;
const pipelineTables = {};

/** A company row as a bought page writes it: the row and its input cells (the table's own tag too), queued. */
async function addRow(tableId, record, clientTag) {
  const inputs = { ...companyInputs(record, { source: SOURCE_BOUGHT }), client_tag: clientTag };
  const search = COMPANY_SEARCH_KEYS.map((k) => inputs[k]).filter(Boolean).join(" ").toLowerCase();
  const { rows: [r] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, search_text) VALUES ($1, $2, $3) RETURNING id`, [tableId, `aiark:${record.id}`, search]);
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
     SELECT $1, kv.key, $2, 'done', to_jsonb(kv.value), left(kv.value, 300) FROM jsonb_each_text($3::jsonb) AS kv`,
    [r.id, tableId, JSON.stringify(inputs)]
  );
  return Number(r.id);
}

/** One pass of the worker's row loop over one row (test-support.mjs workRow: processRow's statements and its projection by template). */
const work = (rowId, { env = KEYS, settings } = {}) => workRow(pool, net, rowId, { env, settings });
/** Works the queued rows of a client's three tables (the inbox rows a company's write-to made). */
async function drainTag(t, opts) {
  const ids = Object.values(pipelineTables[t] ?? {});
  const out = [];
  for (let round = 0; round < 6; round++) {
    const queued = await all(`SELECT id FROM enrich_rows WHERE table_id = ANY($1::uuid[]) AND run_status = 'queued' AND next_run_at <= now() ORDER BY id`, [ids]);
    if (!queued.length) break;
    for (const q of queued) out.push(await work(Number(q.id), opts));
  }
  return out;
}
const summaryOf = (rowId) => one(`SELECT * FROM enrich_companies WHERE row_id = $1`, [rowId]);
const plan = (record, answers) => net.answers.set(record.summary.name, answers);
const verdicts = (map) => Object.entries(map).forEach(([e, s]) => net.verdicts.set(e, s));
const paidOf = (w, followers = []) => [w, ...followers].reduce((p, x) => ({ openai: p.openai + x.paid.openai, reoon: p.reoon + x.paid.reoon, probes: p.probes + x.paid.probe }), { openai: 0, reoon: 0, probes: 0 });

async function partC() {
  await addClient(G, { places: [IL("Springfield"), IL("Peoria")], terms: ["janitorial"] });
  await addClient(H, { places: [IL("Springfield"), IL("Peoria")] });
  resetClientChecks();
  resetCompanyActions();
  for (const t of [G, H]) pipelineTables[t] = (await ensureTemplateTable(pool, t)).tables;
  const tG = pipelineTables[G].companies;
  const tH = pipelineTables[H].companies;
  const stored = await all(`SELECT key, value FROM enrich_settings`);
  const HIGH = { key: "spend_caps", value: { reoon_checks_per_day: 100_000, openai_usd_per_day: { pipeline: 10_000, fit: 10_000 } } };
  const SETTINGS = settingsFrom([...stored.filter((r) => r.key !== "spend_caps"), HIGH]);
  const rows = {};
  const add = async (label, record, { t = G, settings = SETTINGS, env = KEYS } = {}) => {
    const rowId = await addRow(pipelineTables[t].companies, record, t);
    const w = await work(rowId, { settings, env });
    const followers = await drainTag(t, { settings, env });
    rows[label] = { rowId, record };
    return { rowId, w, followers, paid: paidOf(w, followers), s: await summaryOf(rowId) };
  };

  section("C1. The office in the client's area");
  const s1 = company("s1", "Harborview Dental S1");
  plan(s1, { first: at("s1", "office") });
  verdicts({ [at("s1", "office")]: "safe" });
  const c1 = await add("s1", s1);
  check("head office inside: it is the office used", c1.w.values.office?.inside === true && c1.w.values.office.hq === true && c1.w.values.use_state === "IL" && c1.w.values.use_city === "Springfield");
  const s2 = company("s2", "Harborview Dental S2", { hq: BISMARCK, branches: [PEORIA], email: at("s2", "contact") });
  plan(s2, { first: "N/A", second: at("s2", "info") });
  verdicts({ [at("s2", "info")]: "safe" });
  const c2 = await add("s2", s2);
  check("head office outside, a branch inside: the branch is used", c2.w.values.office?.inside === true && c2.w.values.office.hq === false && c2.w.values.use_city === "Peoria");
  const c3 = await add("s3", company("s3", "Harborview Dental S3", { hq: BISMARCK }));
  check("no office inside: Outside", c3.w.cell("office")?.display === "Outside" && c3.s.outcome === "Outside the client's area" && !c3.s.listed);
  const c4 = await add("s4", company("s4", "Harborview Dental S4", { hq: NO_STATE }));
  check("no state: Can't tell, and not listed", c4.w.cell("office")?.display === "Can't tell" && c4.s.outcome === "Outside the client's area" && !c4.s.listed);
  check("... nothing paid and no website checked for a company outside", c3.paid.openai + c3.paid.reoon + c3.paid.probes + c4.paid.openai + c4.paid.reoon + c4.paid.probes === 0);
  const area = async (o) => (await CLIENT_ACTIONS.client_area.run({ inputs: { city: o.city, state: o.state, country: o.country }, table: { client_tag: G }, row: {}, db: pool })).display;
  check("each answer agrees with client_area on the same office", (await area(SPRINGFIELD)) === "Inside" && (await area(PEORIA)) === "Inside" && (await area(BISMARCK)) === "Outside" && (await area(NO_STATE)) === "Can't tell");

  section("C2. Excluded by the client's rules");
  const c5 = await add("s5", company("s5", "Riverbend Janitorial S5"));
  check("Excluded by the client's rules, with no paid call and no website checked", c5.s.outcome === "Excluded by the client's rules" && !c5.s.listed && c5.paid.openai + c5.paid.reoon + c5.paid.probes === 0);

  section("C3. An inbox the database already holds");
  const lead = async (email, extra = {}) => {
    const cols = { email, company: "Companies test lead", ...extra };
    await pool.query(`INSERT INTO leads (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(cols));
    created.leads++;
  };
  await lead(at("s6", "info"));
  const c6 = await add("s6", company("s6", "Harborview Dental S6"));
  check("a role address at the domain in leads: its inbox row is Already in the database, nothing searched or checked",
    c6.s.outcome === "Already in the database" && c6.s.listed && c6.s.held && c6.s.found_by === "database" && c6.s.general_email === at("s6", "info") && c6.paid.openai + c6.paid.reoon === 0,
    JSON.stringify({ outcome: c6.s?.outcome, paid: c6.paid }));
  await pool.query(`INSERT INTO bison_leads (instance_url, bison_id, email) VALUES ($1, 1, $2)`, [TEST_HOST, at("s7", "info").toUpperCase()]);
  const c7 = await add("s7", company("s7", "Harborview Dental S7"));
  check("... only in the Email Bison copy: the same", c7.s.outcome === "Already in the database" && c7.s.listed && c7.w.values.held_email?.in_bison === true && c7.paid.openai + c7.paid.reoon === 0);
  await lead(`frontline.desk@${dom("s7b-mail")}`, { email_type: "general", city: "Springfield", state: "IL" });
  await pool.query(`UPDATE leads SET company = $2 WHERE email = $1`, [`frontline.desk@${dom("s7b-mail")}`, "Harborview Dental S7b"]);
  const c7b = await add("s7b", company("s7b", "Harborview Dental S7b"));
  check("... a general-inbox lead at the same company, city and state: the same", c7b.s.outcome === "Already in the database" && c7b.w.values.held_email?.matched_on === "general inbox at the company", JSON.stringify(c7b.w.values.held_email));
  await lead(at("s8", "info"), { is_bounced: true, bounce_type: "hard" });
  const s8 = company("s8", "Harborview Dental S8");
  plan(s8, { first: `${at("s8", "info")}, ${at("s8", "office")}` });
  verdicts({ [at("s8", "office")]: "safe" });
  const c8 = await add("s8", s8);
  check("bounced: searched anyway; the bounced address is Bounced and never checked, the other one listed",
    c8.s.outcome === "Has a general email" && c8.s.general_email === at("s8", "office") && !net.verified.includes(at("s8", "info")) &&
      (await one(`SELECT outcome FROM enrich_contacts WHERE company_row_id = $1 AND email = $2`, [c8.rowId, at("s8", "info")]))?.outcome === "Bounced");
  await pool.query(`INSERT INTO suppressed_emails (email, reason) VALUES ($1, $2)`, [at("s9", "office"), SUPPRESS_REASON]);
  const c9 = await add("s9", company("s9", "Harborview Dental S9"));
  check("never contact: that outcome, with nothing paid", c9.s.outcome === "On the never-contact list" && !c9.s.listed && c9.paid.openai + c9.paid.reoon === 0);

  section("C4. The website and the general email");
  check("AI Ark's site works: no website search, one email search, the site as use_website", c1.w.cell("companys_website")?.status === "skipped" && c1.paid.openai === 1 && c1.s.website === dom("s1") && c1.s.found_by === "claygent_1" && c1.s.listed);
  const s11 = company("s11", "Harborview Dental S11", { website: null, domain: null });
  plan(s11, { website: `https://www.${dom("s11")}`, first: at("s11", "office") });
  verdicts({ [at("s11", "office")]: "safe" });
  const c11 = await add("s11", s11);
  check("no website from AI Ark: one paid search, its answer checked, then the email search", c11.w.cell("companys_website")?.status === "done" && c11.w.cell("check_if_url_is_valid")?.value?.valid === true && c11.s.domain === dom("s11") && c11.s.listed && c11.paid.openai === 2);
  check("the first search finds nothing usable (N/A): the second runs", c2.s.found_by === "claygent_2" && c2.s.listed && c2.paid.openai === 2);
  check("... and AI Ark's email at a branch is not checked: it is the head office's", c2.w.cell("aiark_email_reoon")?.status === "skipped" && !net.verified.includes(at("s2", "contact")));
  const s14 = company("s14", "Harborview Dental S14", { email: at("s14", "info") });
  verdicts({ [at("s14", "info")]: "safe" });
  const c14 = await add("s14", s14);
  check("AI Ark's email at the head office: checked and used, with no search and one Reoon call", c14.s.found_by === "aiark" && c14.s.general_email === at("s14", "info") && c14.paid.openai === 0 && c14.paid.reoon === 1, JSON.stringify(c14.paid));
  const s15 = company("s15", "Harborview Dental S15");
  plan(s15, { first: `${at("s15", "alpha")}, ${at("s15", "beta")}` });
  const c15 = await add("s15", s15);
  check("every address rejected: not listed, its own outcome General emails sent to checks", c15.s.outcome === "General emails sent to checks" && !c15.s.listed && c15.paid.reoon === 2);
  const s16 = company("s16", "Harborview Dental S16");
  plan(s16, { first: at("s16", "frontdesk") });
  verdicts({ [at("s16", "frontdesk")]: "catch_all" });
  const c16 = await add("s16", s16);
  check("catch-all: waiting for Enrichley, counted, and not listed", !c16.s.listed && c16.s.general_waiting === 1);

  section("C5. Shared memory of paid answers");
  const h1 = await add("h1", { ...s1, id: `cptest-${RUN}-h1` }, { t: H });
  check("another client's row for the same company and office: 0 OpenAI calls, 0 Reoon checks", h1.s.listed && h1.paid.openai === 0 && h1.paid.reoon === 0 && /^Reused: found for CPTEST_G/.test(h1.w.cell("email_extraction_claygent")?.note ?? ""), h1.w.cell("email_extraction_claygent")?.note);
  const h11 = await add("h11", { ...s11, id: `cptest-${RUN}-h11` }, { t: H });
  check("... the website search too", h11.s.listed && h11.paid.openai === 0 && h11.w.cell("companys_website")?.note?.startsWith("Reused"));
  await pool.query(`UPDATE enrich_memory SET expires_at = now() - interval '1 second' WHERE row_id = $1`, [rows.s2.rowId]);
  const h2 = await add("h2", { ...s2, id: `cptest-${RUN}-h2` }, { t: H });
  check("expired memory pays again", h2.s.listed && h2.paid.openai === 2, `${h2.paid.openai} calls`);
  const s1Found = (await summaryOf(rows.s1.rowId)).found_at;
  await pool.query(`UPDATE enrich_rows SET run_force = '{email_extraction_claygent}', run_status = 'queued' WHERE id = $1`, [rows.s1.rowId]);
  const forced = await work(rows.s1.rowId, { settings: SETTINGS });
  check("a forced re-run pays again", forced.paid.openai === 1 && forced.paid.reoon === 0 && forced.status === "done");

  section("C6. Missing keys and Reoon's credits");
  const s20 = company("s20", "Harborview Dental S20");
  plan(s20, { first: at("s20", "office") });
  verdicts({ [at("s20", "office")]: "safe" });
  const c20 = await add("s20", s20, { env: { ENRICH_REOON_API_KEY: KEYS.ENRICH_REOON_API_KEY } });
  check("no OpenAI key: the paid cell says so, the row waits, and so does its outcome",
    c20.w.cell("email_extraction_claygent")?.status === "needs_key" && c20.w.status === "waiting" && c20.s.outcome === "Waiting for a key" && !c20.s.listed && c20.paid.openai === 0);
  check("... and the second search doesn't run while the first waits", c20.w.cell("email_extraction_claygent_2")?.status === "needs_key");
  net.balance = { daily: 0, instant: 0 };
  resetCompanyActions();
  const s21 = company("s21", "Harborview Dental S21", { email: at("s21", "info") });
  verdicts({ [at("s21", "info")]: "safe" });
  const c21 = await add("s21", s21);
  check("Reoon's daily credits used up: the row waits, nothing is checked and nothing searched", c21.w.status === "waiting" && c21.paid.reoon === 0 && c21.paid.openai === 0 && c21.s.outcome === "Waiting for a key");
  net.balance = { daily: 400, instant: 5 };
  resetCompanyActions();
  const s22 = company("s22", "Harborview Dental S22", { email: at("s22", "info") });
  verdicts({ [at("s22", "info")]: "safe" });
  const c22 = await add("s22", s22);
  check("instant credits on the account: the row waits, nothing is checked", c22.w.status === "waiting" && c22.paid.reoon === 0 && /instant credits/.test(c22.w.cell("aiark_email_reoon")?.note ?? ""));
  const otherWaiting = await one(`SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id WHERE t.template IS NOT NULL AND r.run_status = 'waiting' AND NOT starts_with(t.client_tag, $1)`, [PREFIX]);
  if (otherWaiting.n) {
    check("no other client's template rows waiting (the sweep would queue them too)", false, `${otherWaiting.n} rows`);
  } else {
    resetCompanyActions();
    const noOpenAi = await requeueWaitingTemplateRows(pool, { ENRICH_REOON_API_KEY: KEYS.ENRICH_REOON_API_KEY }, { settings: SETTINGS });
    resetCompanyActions();
    const instant = await requeueWaitingTemplateRows(pool, KEYS, { settings: SETTINGS });
    net.balance = { daily: 400, instant: 0 };
    resetCompanyActions();
    const ready = await requeueWaitingTemplateRows(pool, KEYS, { settings: SETTINGS });
    const queued = await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE id = ANY($1::bigint[]) AND run_status = 'queued'`, [[c20.rowId, c21.rowId, c22.rowId]]);
    check("the hourly sweep leaves a row waiting while its own reason holds: no OpenAI key, or Reoon's instant credits",
      noOpenAi.queued === 0 && noOpenAi.waiting === 3 && instant.queued === 1 && /instant/.test(instant.why ?? ""), JSON.stringify({ noOpenAi, instant }));
    check("... and queues each once its reason has cleared", ready.queued === 2 && queued.n === 3, JSON.stringify(ready));
    const again = [];
    for (const r of [c20, c21, c22]) {
      const w = await work(r.rowId, { settings: SETTINGS });
      await drainTag(G, { settings: SETTINGS });
      again.push({ status: w.status, listed: (await summaryOf(r.rowId))?.listed });
    }
    check("... then they finish and are listed", again.every((x) => x.status === "done" && x.listed), JSON.stringify(again));
  }

  section("C7. Errors");
  const s23 = company("s23", "Harborview Dental S23");
  plan(s23, { first: at("s23", "office") });
  verdicts({ [at("s23", "office")]: "safe" });
  net.openaiFail = [500];
  const c23 = await add("s23", s23);
  check("an OpenAI 500: sent once, the row queued again with backoff, never read as nothing found",
    c23.w.paid.openai === 1 && c23.w.cell("email_extraction_claygent")?.status === "error" && c23.w.status === "queued" && !c23.s && c23.w.values.company_outcome === undefined, `${c23.w.paid.openai} ${c23.w.status}`);
  check("a run condition that reads a failed cell errors, so the second search isn't paid for",
    c23.w.cell("email_extraction_claygent_2")?.status === "error" && /Run condition not worked out/.test(c23.w.cell("email_extraction_claygent_2")?.note ?? ""));
  const retry = await work(c23.rowId, { settings: SETTINGS });
  await drainTag(G, { settings: SETTINGS });
  check("... and the next try finishes it", retry.status === "done" && (await summaryOf(c23.rowId))?.listed === true);

  section("C8. A model swap");
  const swapped = settingsFrom([...stored.filter((r) => !["spend_caps", "models"].includes(r.key)), HIGH, { key: "models", value: { ...stored.find((r) => r.key === "models")?.value, email_extraction_claygent: { model: "gpt-6-luna-test", max_searches: 2 } } }]);
  const s24 = company("s24", "Harborview Dental S24");
  plan(s24, { first: at("s24", "office") });
  verdicts({ [at("s24", "office")]: "safe" });
  const sentBefore = net.bodies.length;
  const c24 = await add("s24", s24, { settings: swapped });
  check("a changed models.email_extraction_claygent reaches new rows", c24.s.listed && net.bodies.slice(sentBefore).some((b) => b.model === "gpt-6-luna-test"));
  await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [rows.s16.rowId]);
  const redo = await work(rows.s16.rowId, { settings: swapped });
  check("... and done cells are not paid for again", redo.status === "done" && redo.paid.openai === 0 && redo.paid.reoon === 0);

  section("C9. The real worker, draining its queue with no paid keys");
  await realWorker();
  return { tG, tH, rows, s1Found, SETTINGS };
}

async function realWorker() {
  const others = await one(
    `SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id
      WHERE r.run_status IN ('queued', 'running') AND NOT starts_with(t.client_tag, $1)`,
    [PREFIX]
  );
  const pulls = await one(
    `SELECT (SELECT count(*) FROM aiark_runs WHERE status IN ('queued', 'running'))::int
          + (SELECT count(*) FROM aiark_company_runs WHERE status IN ('queued', 'running'))::int AS n`
  );
  if (others.n || pulls.n) {
    check("no other queued rows or pulls (the worker would work them too)", false, `${others.n} rows, ${pulls.n} pulls`);
    return;
  }
  await addClient(W, { places: [IL("Springfield")] });
  resetClientChecks();
  pipelineTables[W] = (await ensureTemplateTable(pool, W)).tables;
  const tW = pipelineTables[W].companies;
  const inside = await addRow(tW, company("w1", "Lakeshore Clinic W1"), W);
  const outside = await addRow(tW, company("w2", "Lakeshore Clinic W2", { hq: BISMARCK }), W);
  // Only W's rows may be worked: the other test tables are paused meanwhile.
  await pool.query(`UPDATE enrich_tables SET is_paused = true WHERE starts_with(client_tag, $1) AND NOT (id = ANY($2::uuid[]))`, [PREFIX, Object.values(pipelineTables[W])]);
  const env = { ...process.env, ENRICH_ONCE: "1", ENRICH_POLL_MS: "200", ENRICH_WORKER_ID: WORKER_ID };
  for (const k of PAID_KEYS) delete env[k];
  const worker = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(WORKER_PRELOAD)}`, fileURLToPath(new URL("./enrich-worker.mjs", import.meta.url))], {
    env, encoding: "utf8", timeout: 180_000,
  });
  await pool.query(`UPDATE enrich_tables SET is_paused = false WHERE starts_with(client_tag, $1)`, [PREFIX]);
  check("the worker drained its queue and exited", worker.status === 0, (worker.stderr || worker.stdout || String(worker.error ?? "")).slice(-400));
  const st = Object.fromEntries((await all(`SELECT id, run_status FROM enrich_rows WHERE table_id = $1`, [tW])).map((r) => [Number(r.id), r.run_status]));
  const inS = await summaryOf(inside);
  const outS = await summaryOf(outside);
  check("a row with paid steps waits for the keys, and the tab says so", st[inside] === "waiting" && inS?.outcome === "Waiting for a key" && inS.listed === false, JSON.stringify({ st: st[inside], outcome: inS?.outcome }));
  check("a row outside the area finishes free, summarised and not listed", st[outside] === "done" && outS?.outcome === "Outside the client's area" && outS.listed === false);
  const beat = await one(`SELECT info FROM enrich_worker_state WHERE id = $1`, [WORKER_ID]);
  check("its heartbeat offers company pulls and the pipeline's originals, and says which keys are missing",
    beat?.info?.capabilities?.includes("company_runs") && beat.info.capabilities.includes("pipeline_v2") && beat.info.keys?.ENRICH_REOON_API_KEY === false && "reoon" in beat.info &&
      beat.info.aiark?.company_slices === 0 && beat.info.optional_keys?.FINDYMAIL_API_KEY === false && typeof beat.info.originals?.default?.total === "number" && typeof beat.info.spend_today?.reoon_checks === "number",
    JSON.stringify(beat?.info ?? null).slice(0, 400));
}

// ── D. The tab's data ───────────────────────────────────────────────────────

const I = tag("I"); // 2,500 listed companies, for paging

async function partD(routes, c) {
  const { runs, list, rows: rowsRoute } = routes;
  const { tG, rows, s1Found, SETTINGS } = c;

  section("D1. The projection");
  const counts = await one(
    `SELECT (SELECT count(*)::int FROM enrich_companies WHERE table_id = $1) AS projected,
            (SELECT count(*)::int FROM enrich_rows WHERE table_id = $1 AND run_status IN ('done', 'waiting', 'error')) AS finished,
            (SELECT count(*)::int FROM enrich_companies WHERE table_id = $1 AND listed AND NOT (outcome = ANY($2::text[]))) AS wrongly_listed,
            (SELECT count(*)::int FROM enrich_companies WHERE table_id = $1 AND NOT listed AND outcome = ANY($2::text[])) AS wrongly_hidden`,
    [tG, LISTED_OUTCOMES_V2]
  );
  check("one summary per finished template row", counts.projected === counts.finished && counts.projected >= 15, JSON.stringify(counts));
  check("listed only with a listing outcome (General and people emails, Has a general email, Has people emails, Already in the database)", counts.wrongly_listed === 0 && counts.wrongly_hidden === 0);
  const s1Now = await summaryOf(rows.s1.rowId);
  check("found_at is set once: working the row again keeps it", s1Now.listed && new Date(s1Now.found_at).getTime() === new Date(s1Found).getTime());
  const twin = { ...company("s1", "Harborview Dental S1"), id: `cptest-${RUN}-twin` }; // a different AI Ark id, the same company and office
  const twinRow = await addRow(tG, twin, G);
  const t = await work(twinRow, { settings: SETTINGS });
  const followers = await drainTag(G, { settings: SETTINGS });
  const ts = await summaryOf(twinRow);
  const tp = paidOf(t, followers);
  check("the same domain and office are listed once: the second is Listed under another row, and cost nothing",
    ts.outcome === "Listed under another row" && !ts.listed && tp.openai === 0 && tp.reoon === 0, JSON.stringify({ outcome: ts.outcome, paid: tp }));

  section("D2. Keyset paging over 2,500 companies");
  await addClient(I, { places: [IL("Springfield")] });
  const tI = (await ensureTemplateTable(pool, I)).id;
  await pool.query(
    `WITH r AS (
       INSERT INTO enrich_rows (table_id, row_key, run_status)
       SELECT $1, 'aiark:cptest-page-' || g, 'done' FROM generate_series(1, 2500) g
       RETURNING id, substring(row_key FROM 'cptest-page-([0-9]+)')::int AS n)
     INSERT INTO enrich_companies (row_id, table_id, client_tag, source, company, domain, city, state, general_email, email_status, held,
                                   found_by, email_kind, outcome, listed, company_key, search_text, found_at)
     SELECT r.id, $1, $2, 'AI Ark',
            CASE WHEN r.n % 50 = 0 THEN NULL ELSE (ARRAY['Maple', 'birch', 'Cedar', 'oak', 'Aspen'])[1 + r.n % 5] || ' Company ' || (r.n % 400) END,
            'page' || r.n || '.' || $3, 'Town' || (r.n % 7), (ARRAY['IL', 'NY', 'OH', 'TX'])[1 + r.n % 4],
            'info@page' || r.n || '.' || $3,
            CASE WHEN r.n % 7 = 0 THEN NULL WHEN r.n % 3 = 0 THEN 'catch_all' ELSE 'valid' END,
            r.n % 7 = 0,
            CASE WHEN r.n % 7 = 0 THEN 'database' ELSE (ARRAY['aiark', 'search_1', 'search_2'])[1 + r.n % 3] END,
            'general',
            CASE WHEN r.n % 7 = 0 THEN 'Already in the database' ELSE 'Has a general email' END,
            true,
            'page' || r.n || '.' || $3 || '|IL|town',
            lower(coalesce((ARRAY['Maple', 'birch', 'Cedar', 'oak', 'Aspen'])[1 + r.n % 5], '') || ' page' || r.n || ' info@page' || r.n),
            timestamptz '2026-11-01 00:00:00+00' + (r.n / 3) * interval '1 microsecond'
       FROM r`,
    [tI, I, TEST_HOST]
  );
  const filters = [{}, { state: "IL" }, { status: "valid" }, { found: "search_1" }, { hideHeld: "1" }, { q: "maple" }, { state: "NY", status: "catch_all", hideHeld: "1" }];
  const expected = async (f, sort) => {
    const where = ["client_tag = $1", "listed"];
    const params = [I];
    const add = (sql, v) => {
      params.push(v);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (f.state) add("state = ?", f.state);
    if (f.status) add("email_status = ?", f.status);
    if (f.found) add("found_by = ?", f.found);
    if (f.hideHeld) where.push("NOT held");
    if (f.q) add("search_text LIKE ?", `%${f.q}%`);
    const by = sort === "name" ? "lower(company), row_id" : "found_at DESC, row_id DESC";
    return (await all(`SELECT row_id FROM enrich_companies WHERE ${where.join(" AND ")} ORDER BY ${by}`, params)).map((r) => Number(r.row_id));
  };
  const pageAll = async (query) => {
    const ids = [];
    let after = null;
    let firstStates = null;
    for (let i = 0; i < 400; i++) {
      const res = await call(list.GET, { query: { tag: I, ...query, ...(after ? { after } : {}) } });
      if (res.status !== 200) throw new Error(`the list answered ${res.status}: ${JSON.stringify(res.body)}`);
      if (i === 0) firstStates = res.body.states ?? null;
      ids.push(...res.body.rows.map((r) => r.row_id));
      if (!res.body.next) return { ids, firstStates };
      after = res.body.next;
    }
    throw new Error("too many pages");
  };
  let combos = 0;
  let wrong = [];
  for (const sort of ["newest", "name"]) {
    for (const size of ["50", "100", "200"]) {
      const want = await expected({}, sort);
      const got = await pageAll({ sort, size });
      combos++;
      if (JSON.stringify(got.ids) !== JSON.stringify(want)) wrong.push(`${sort}/${size}: ${got.ids.length} of ${want.length}`);
      if (size === "50" && !(got.firstStates?.length === 4)) wrong.push(`${sort}: states on the first page`);
    }
    for (const f of filters.slice(1)) {
      const want = await expected(f, sort);
      const got = await pageAll({ sort, size: "50", ...f });
      combos++;
      if (JSON.stringify(got.ids) !== JSON.stringify(want)) wrong.push(`${sort} ${JSON.stringify(f)}: ${got.ids.length} of ${want.length}`);
    }
  }
  check(`every row exactly once, in order, for both sorts, every filter and each page size (${combos} walks)`, wrong.length === 0, wrong.slice(0, 4).join("; "));
  const wrongSort = await call(list.GET, { query: { tag: I, sort: "name", after: Buffer.from(JSON.stringify(["t", "2026-11-01T00:00:00.000000Z", 5])).toString("base64url") } });
  check("a cursor from the other order is refused (400)", wrongSort.status === 400);
  const listSql = /export async function listCompanies[\s\S]*?\n}\n/.exec(source("src/lib/companies/server.ts"))?.[0] ?? "";
  check("the list's SQL has no OFFSET", listSql.length > 0 && !/\bOFFSET\b/i.test(listSql));

  section("D3. The counts");
  const got = await call(runs.GET, { query: { tag: G } });
  const outcomes = Object.fromEntries((await all(`SELECT outcome, count(*)::int AS n FROM enrich_companies WHERE client_tag = $1 GROUP BY 1`, [G])).map((r) => [r.outcome, r.n]));
  const byStatus = Object.fromEntries((await all(`SELECT run_status, count(*)::int AS n FROM enrich_rows WHERE table_id = $1 GROUP BY 1`, [tG])).map((r) => [r.run_status, r.n]));
  // Listed companies by what each shows (disjoint): a new general and a new person email, one of them, or only held ones.
  const listed = await one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE general_emails > 0 AND NOT held AND people_emails > 0)::int AS both,
            count(*) FILTER (WHERE general_emails > 0 AND NOT held AND people_emails = 0)::int AS general,
            count(*) FILTER (WHERE NOT (general_emails > 0 AND NOT held) AND people_emails > 0)::int AS people,
            count(*) FILTER (WHERE NOT (general_emails > 0 AND NOT held) AND people_emails = 0)::int AS held
       FROM enrich_companies WHERE client_tag = $1 AND listed`,
    [G]
  );
  const k = got.body?.counts;
  check("the counts by outcome match the rows", got.status === 200 && sorted(k?.outcomes) === sorted(outcomes), `${sorted(k?.outcomes)} vs ${sorted(outcomes)}`);
  check("... and the listed ones by what they show, and the rows by status",
    k?.listed.total === listed.total && k.listed.both === listed.both && k.listed.general === listed.general && k.listed.people === listed.people &&
      k.listed.held === listed.held && k.listed.both + k.listed.general + k.listed.people + k.listed.held === k.listed.total &&
      sorted(k.rows) === sorted(byStatus) && k.tableId === tG,
    JSON.stringify({ got: k?.listed, want: listed }));

  section("D4. Deletes");
  const victim = rows.s14.rowId;
  T.role = "admin";
  const del = await call(rowsRoute.DELETE, { body: { table: tG, ids: [victim] } });
  T.role = "manager";
  const after = await call(runs.GET, { query: { tag: G } });
  check("deleting a row in the Clay section takes it off the tab", del.status === 200 && del.body.deleted === 1 && !(await summaryOf(victim)) && after.body.counts.listed.total === listed.total - 1);

  section("D5. Nothing reaches the lead database");
  const leadCount = await one(`SELECT count(*)::int AS n FROM leads`);
  const pushCount = await one(`SELECT count(*)::int AS n FROM push_items`);
  check("leads and push_items: only the test's own made-up leads were added", leadCount.n === baseline.leads + created.leads && pushCount.n === baseline.push, JSON.stringify({ leads: leadCount.n, base: baseline.leads, ours: created.leads, push: pushCount.n }));
  const toAdd = await pullsToAdd(pool, 200);
  const companyRuns = new Set((await all(`SELECT id FROM aiark_company_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id));
  check("pullsToAdd() never returns a company pull", toAdd.every((r) => !companyRuns.has(r.id) && !String(r.client_tag).startsWith(PREFIX)));
  const writers = [
    "src/app/api/companies/setup/route.ts", "src/app/api/companies/count/route.ts", "src/app/api/companies/runs/route.ts",
    "src/app/api/companies/runs/cancel/route.ts", "src/app/api/companies/list/route.ts", "src/app/api/companies/settings/route.ts",
    "src/lib/companies/server.ts", "scripts/lib/aiark/company-runs.mjs", "scripts/lib/aiark/company-filters.mjs",
    "scripts/lib/enrich/company-actions.mjs", "scripts/lib/enrich/company-template.mjs", "scripts/lib/enrich/project-company.mjs",
    "scripts/lib/enrich/company-template-v2.mjs", "scripts/lib/enrich/inbox-template.mjs", "scripts/lib/enrich/people-template.mjs",
    "scripts/lib/enrich/templates.mjs", "scripts/lib/enrich/compile-original.mjs", "scripts/lib/enrich/pipeline-actions.mjs",
    "scripts/lib/enrich/email-vendors.mjs", "scripts/lib/enrich/project-contacts.mjs", "scripts/lib/enrich/seed-originals.mjs",
    "scripts/lib/enrich/spend.mjs", "scripts/enrich-seed-originals.mjs",
  ].filter((f) => /\b(INSERT INTO|UPDATE|DELETE FROM)\s+leads\b|from\(["']leads["']\)/i.test(source(f)));
  check("no new route or module writes leads", writers.length === 0, writers.join(", "));
}

// ── E. Shared code ──────────────────────────────────────────────────────────

const J = tag("J"); // a hand-seeded Companies table beside a template table

async function partE(routes, c) {
  const { intake, rows: rowsRoute, tables, settings } = routes;
  const { tG } = c;
  await addClient(J, { places: [IL("Springfield")] });
  const { rows: [hand] } = await pool.query(`INSERT INTO enrich_tables (client_tag, kind, name) VALUES ($1, 'companies', 'Companies (hand-seeded test)') RETURNING id`, [J]);
  await pool.query(`INSERT INTO enrich_columns (table_id, key, name, position, kind) VALUES ($1, 'company', 'Company', 1, 'input'), ($1, 'place_id', 'Place id', 2, 'input')`, [hand.id]);
  const tJ = (await ensureTemplateTable(pool, J)).id;

  section("E1. The Maps intake");
  const postback = {
    extra: { city: "Springfield", state: "IL", category: "dentist" },
    postbackData: { tasks: [{ result: [{ items: [{ title: "Intake Test Dental", place_id: `cptest-place-${RUN}`, url: `https://www.${dom("intake")}`, domain: dom("intake"), address: "1 Main Street, Springfield, IL", phone: "(217) 555-0101", category: "Dentist", address_info: { city: "Springfield", region: "Illinois" } }] }] }] },
  };
  const headers = (t) => ({ authorization: `Bearer ${T.intakeKey}`, "x-client-tag": t });
  const gRows = await rowsIn(tG);
  const toJ = await call(intake.POST, { body: postback, headers: headers(J) });
  check("Maps places go to the hand-seeded Companies table, never the template table", toJ.status === 200 && toJ.body.table === hand.id && (await rowsIn(hand.id)) === 1 && (await rowsIn(tJ)) === 0, JSON.stringify(toJ.body));
  const toG = await call(intake.POST, { body: postback, headers: headers(G) });
  check("a client with only a template table has no table for them (404)", toG.status === 404 && (await rowsIn(tG)) === gRows);

  section("E2. CSV imports");
  const csv = (table) => call(rowsRoute.POST, { body: { table, label: "test.csv", rows: [{ inputs: { company: "CSV Test Dental" }, reference: "1" }] } });
  const refused = await csv(tG);
  check("a CSV into a template table is refused (409)", refused.status === 409 && (await rowsIn(tG)) === gRows);
  check("... and still taken by a hand-seeded table", (await csv(hand.id)).status === 200 && (await rowsIn(hand.id)) === 2);

  section("E3. The Clay section's table list");
  const listed = await call(tables.GET);
  const ours = (listed.body?.tables ?? []).filter((x) => x.client_tag === J);
  check("the client's Companies template table comes before its hand-seeded one, then its People and General inboxes tables, each once",
    listed.status === 200 && ours.length === 4 && ours[0].id === tJ && ours[0].template === "companies_v2" && ours[1].id === hand.id && ours[1].template === null &&
      ours[2].template === "people_v1" && ours[3].template === "inboxes_v1" && (listed.body.tables ?? []).filter((x) => x.id === tG).length === 1,
    JSON.stringify(ours.map((x) => x.template)));

  section("E4. The settings route");
  T.role = "manager";
  check("managers can't read the settings (403)", (await call(settings.GET)).status === 403);
  T.role = "admin";
  const now = await call(settings.GET);
  // The sheet's own body: what the settings route answered, in the shape the sheet sends back (phases 2 and 3).
  const { settingsInputOf } = await srcModule("lib/companies/server.ts");
  const input = settingsInputOf(now.body.value);
  const edit = (f = () => {}) => {
    const x = structuredClone(input);
    f(x);
    return { version: now.body.version, ...x };
  };
  check("a bad model id is refused (400)", (await call(settings.PUT, { body: edit((x) => { x.models.companys_website = { model: "GPT 4!", reasoning_effort: null, max_searches: 2 }; }) })).status === 400);
  const saved = await call(settings.PUT, { body: edit((x) => { x.company_pipeline.enabled = true; x.company_pipeline.max_pull_size = 500; }) });
  const stored = await all(`SELECT key, value FROM enrich_settings ORDER BY key`);
  const read = settingsFrom(stored);
  const cp = stored.find((r) => r.key === "company_pipeline")?.value;
  const models = stored.find((r) => r.key === "models")?.value;
  check("a save keeps what the sheet doesn't edit (memory_days, fit_score)", saved.status === 200 && cp?.memory_days?.website === 365 && "fit_score" in models && T.audits.some((x) => x.action === "enrich_settings"), JSON.stringify({ status: saved.status, cp }));
  check("... and the worker reads what was saved", read.company_pipeline.max_pull_size === 500 && read.company_pipeline.enabled === true);
  check("a save over a newer version is refused (409)", (await call(settings.PUT, { body: edit() })).status === 409);
  T.role = "manager";
}

// ── Run ─────────────────────────────────────────────────────────────────────

const baseline = { leads: 0, push: 0, registry: 0 };
let originalSettings = null;
let spendBefore = null;

async function cleanup() {
  await pool.query(`UPDATE enrich_tables SET is_paused = false WHERE starts_with(client_tag, $1)`, [PREFIX]);
  const runs = (await all(`SELECT id FROM aiark_company_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  await pool.query(`DELETE FROM aiark_companies WHERE run_id = ANY($1::uuid[]) OR starts_with(company_id, 'cptest-')`, [runs]);
  await pool.query(`DELETE FROM aiark_company_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  const tables = (await all(`SELECT id FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  await pool.query(`DELETE FROM enrich_memory WHERE starts_with(client_tag, $1) OR table_id = ANY($2::uuid[])`, [PREFIX, tables]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tables]).catch(() => {});
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1`, [`%.${TEST_HOST}`]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${TEST_HOST}`]);
  await pool.query(`DELETE FROM bison_leads WHERE instance_url = $1`, [TEST_HOST]);
  await pool.query(`DELETE FROM suppressed_emails WHERE reason = $1 OR email LIKE $2`, [SUPPRESS_REASON, `%.${TEST_HOST}`]);
  await pool.query(`DELETE FROM client_people_filters WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM enrich_worker_state WHERE id = $1`, [WORKER_ID]);
  await pool.query(`DELETE FROM enrich_originals WHERE starts_with(variant, 'cptest')`);
  if (spendBefore) {
    await pool.query(`DELETE FROM enrich_spend_daily WHERE NOT ((day::text || kind) = ANY($1::text[]))`, [spendBefore.map((r) => `${r.day}${r.kind}`)]);
    for (const r of spendBefore) await pool.query(`UPDATE enrich_spend_daily SET used = $3 WHERE day::text = $1 AND kind = $2`, [r.day, r.kind, r.used]);
  }
  if (originalSettings) {
    for (const r of originalSettings) await pool.query(`UPDATE enrich_settings SET value = $2 WHERE key = $1`, [r.key, JSON.stringify(r.value)]);
  }
}

const ready = await one(`SELECT to_regclass('public.aiark_company_runs') IS NOT NULL AND to_regclass('public.enrich_originals') IS NOT NULL AS ok`);
if (!ready.ok) {
  console.error("Refusing to run: migrations 124 and 125 are not in this database.");
  await pool.end();
  process.exit(1);
}
const busy = await one(`SELECT count(*)::int AS n FROM aiark_company_runs WHERE status IN ('queued', 'running') AND NOT starts_with(client_tag, $1)`, [PREFIX]);
if (busy.n) {
  console.error(`Refusing to run: ${busy.n} company pull(s) are queued or running in this database. Let them finish or cancel them first.`);
  await pool.end();
  process.exit(1);
}
const t0 = Date.now();
let enrichDb = null;
try {
  await cleanup(); // anything an interrupted run left behind
  originalSettings = await all(`SELECT key, value FROM enrich_settings WHERE key IN ('company_pipeline', 'models', 'people_pipeline', 'personalisation', 'spend_caps') ORDER BY key`);
  spendBefore = await all(`SELECT day::text AS day, kind, used::text AS used FROM enrich_spend_daily`);
  Object.assign(baseline, {
    leads: (await one(`SELECT count(*)::int AS n FROM leads`)).n,
    push: (await one(`SELECT count(*)::int AS n FROM push_items`)).n,
    registry: (await one(`SELECT count(*)::int AS n FROM aiark_companies`)).n,
  });
  GEO = await loadGeo(pool);
  await partA(GEO);
  enrichDb = await srcModule("lib/enrich/db.ts");
  const routes = {
    setup: await route("companies/setup"),
    count: await route("companies/count"),
    runs: await route("companies/runs"),
    cancel: await route("companies/runs/cancel"),
    list: await route("companies/list"),
    settings: await route("companies/settings"),
    rows: await route("enrich/rows"),
    tables: await route("enrich/tables"),
    intake: await route("enrich/intake"),
  };
  await setPipeline(true);
  await partB(routes);
  const c = await partC();
  await partD(routes, c);
  await partE(routes, c);
  check("nothing tried to reach any other address", net.calls.refused === 0, `${net.calls.refused} refused`);
} catch (e) {
  failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const leftover = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE starts_with(tag, $1)) AS clients,
            (SELECT count(*)::int FROM client_targeting WHERE starts_with(client_tag, $1)) AS rules,
            (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1)) AS tables,
            (SELECT count(*)::int FROM aiark_company_runs WHERE starts_with(client_tag, $1)) AS pulls,
            (SELECT count(*)::int FROM aiark_runs WHERE starts_with(client_tag, $1)) AS people_runs,
            (SELECT count(*)::int FROM aiark_companies) - $3 AS registry,
            (SELECT count(*)::int FROM enrich_memory WHERE starts_with(client_tag, $1)) AS memory,
            (SELECT count(*)::int FROM email_validations WHERE email LIKE $2) AS validations,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2) AS leads,
            (SELECT count(*)::int FROM suppressed_emails WHERE email LIKE $2) AS never_contact,
            (SELECT count(*)::int FROM bison_leads WHERE instance_url = $4) AS bison,
            (SELECT count(*)::int FROM enrich_worker_state WHERE id = $5) AS heartbeat,
            (SELECT count(*)::int FROM enrich_originals WHERE starts_with(variant, 'cptest')) AS originals`,
    [PREFIX, `%.${TEST_HOST}`, baseline.registry, TEST_HOST, WORKER_ID]
  );
  const settingsBack = originalSettings
    ? JSON.stringify(await all(`SELECT key, value FROM enrich_settings WHERE key IN ('company_pipeline', 'models', 'people_pipeline', 'personalisation', 'spend_caps') ORDER BY key`)) === JSON.stringify(originalSettings)
    : true;
  const clean = Object.values(leftover).every((n) => n === 0) && settingsBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...leftover, settingsBack })}`}`);
  console.log(`${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await enrichDb?.enrichPool().end().catch(() => {});
  await pool.end();
  process.exit(failed || !clean ? 1 : 0);
}
