#!/usr/bin/env node
// Checks for the LinkedIn sources rebuilt on AI Ark (phase 4, migration 128).
// LOCAL DATABASE ONLY. Made-up clients (tags starting LITEST_), made-up places
// and keywords (cities named here are added to the geo reference: inside a
// transaction that is rolled back in part B, committed with geoname ids from
// 9,990,100,000 in part C) and .litest.example addresses; everything is removed
// at the end and every setting is put back as it was. It refuses to run while
// a company pull or people run that is not its own is queued or running.
//
//   LITEST_TMP=<a folder outside the repo> node --env-file=.env.local scripts/test-linkedin.mjs
//
// Stop the enrichment worker first. Migrations 125 to 128 must be in the local
// database. Nothing here reaches a network: AI Ark answers only through the
// demo transport, and fetch is replaced for the whole run and refuses every
// address (the worker spawned once in C9 gets the same rule). The routes run
// through a small TypeScript loader with stand-ins for the session, the audit
// log and the worker's heartbeat (as test-people.mjs).
//
// What it checks:
//   A. no database: the one filter rule (D-P4-1), the settings and switches,
//      the keyword union and the AI Ark limit (D-P4-3), the resolver for a
//      client with and without its own row (D-P4-5), typed places, the
//      request builders, the people sources, the seed file's layout; A9 to
//      A11 the overrides: places narrowed to the sending rules (O2), every
//      keyword checked after the pull (O1), the LinkedIn pick
//   B. against the database, inside transactions that are rolled back:
//      migration 128's objects and access, places checked against the geo
//      reference, a manager's save and its log (first save, 409, 400, kept
//      and removed unplaced values, nothing logged for no change), the seed's
//      writes (never over a person's save, nothing when unchanged), the
//      starter list, the resolver read live
//   C. (Builder L1) LinkedIn company pulls, LinkedIn people runs, the worker,
//      the seed's conversion and dry run on a made-up file, and the guard
//      rails: with linkedin_sources off, the AI Ark tab, company pulls, people
//      runs, pushes and exports behave exactly as before 128
//   R. (Builder L2) the routes and their refusals

import pg from "pg";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLEANING_EXCLUDE_COMPANY_TYPES, CLEANING_EXCLUDE_KEYWORDS, CLEANING_EXCLUDE_TITLES, CLEANING_TITLES } from "./lib/aiark/cleaning-filters.mjs";
import { bytes, CLEANING_DEFAULTS, COMPANY_TERMS_BYTES, condensePhrases, EMPTY_PEOPLE_FILTERS, loadGeo } from "./lib/aiark/filters.mjs";
import { buildCompanyRequests, companyFiltersFor, companyHqKeys, companyPlaceKeys, hasWords } from "./lib/aiark/company-filters.mjs";
import { createAiArk } from "./lib/aiark/client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./lib/aiark/demo.mjs";
import { excludedByAccount, makeCompany, officeInPlace } from "./lib/aiark/demo-companies.mjs";
import { advanceOneCompanyRun, createCompanyRun } from "./lib/aiark/company-runs.mjs";
import { pullsToAdd } from "./lib/aiark/add.mjs";
import { cityKey } from "./lib/aiark/geo.mjs";
import { excludedTitlesFor, peopleSourceInfo, peopleSources } from "./lib/aiark/people-requests.mjs";
import { filtersFor, scopeOf, standardFor } from "./lib/aiark/standard-filters.mjs";
import {
  canonEntry, checkPlaces, cleanOwnInput, keywordsFor, linkedinSettingsFor, logFor, narrowPlaces, NOT_SEARCHED, NOT_SEARCHED_EXCLUDED, NOT_SEARCHED_FIX, outsideRules,
  ownOf, ownVersionOf, placeFromText, placeText, readLinkedinRow, readStarter, resolveLinkedin, saveLinkedinSettings, seedLinkedinRow, writeStarter,
} from "./lib/aiark/linkedin-settings.mjs";
import {
  EXCLUDE_PLACES_BYTES, LINKEDIN_LABELS, linkedinCompanyRequests, linkedinPeopleRequests, linkedinRunFilters, linkedinTargeting,
} from "./lib/aiark/linkedin-requests.mjs";
import { bringCompanyIn, linkedinCompanyFor, pickArea } from "./lib/aiark/linkedin-people.mjs";
import { buildCityIndex, checkSeedLayout, convertPick, planSeed, readSeedFile, SeedLayoutError } from "./lib/aiark/linkedin-seed.mjs";
import { advanceOnePeopleRun, approveBuy, cancelPeopleRun, createPeopleRun, PeopleRunRefused, personRowCells } from "./lib/aiark/people-runs.mjs";
import { CLIENT_ACTIONS, companyTermHit, geoFor, resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { COMPANY_ACTIONS } from "./lib/enrich/company-actions.mjs";
import { companyInputs } from "./lib/enrich/company-template.mjs";
import { ensurePipelineTables } from "./lib/enrich/templates.mjs";
import { flagOn, FLAGS, PEOPLE_PER_COMPANY, settingsFrom, starterFrom } from "./lib/enrich/settings.mjs";
import { seedFixtureVariant, workRow } from "./fixtures/test-support.mjs";

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

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;
let pending = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` : ${detail}` : ""}`);
}
/** A check that runs once its builder's part is in this tree. */
function later(name, who) {
  pending++;
  console.log(`  ...  ${name} (${who})`);
}
const section = (s) => console.log(`\n${s}`);

// ── No network ──────────────────────────────────────────────────────────────

const net = { refused: 0 };
globalThis.fetch = async () => {
  net.refused++;
  throw Object.assign(new TypeError("fetch failed: test-linkedin allows no network"), { cause: { code: "ECONNREFUSED" } });
};

// ── The routes' TypeScript, compiled as it is imported (Builder L2's checks) ─
// "@/..." is src/, as in tsconfig. The session, the audit log and the worker's
// heartbeat are stand-ins the checks set through globalThis.__linkedinTest.

const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}`,
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
export async function requireRole(min) {
  const t = globalThis.__linkedinTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__linkedinTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__linkedinTest.worker; }`,
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
const T = (globalThis.__linkedinTest = { role: "manager", userId: randomUUID(), audits: [], worker: null });
const srcModule = (p) => import(new URL(`../src/${p}`, import.meta.url).href);
const route = (p) => srcModule(`app/api/${p}/route.ts`);

/** One route call, as Next.js would make it. */
async function call(handler, { body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const req = { json: async () => body, nextUrl: new URL(`http://linkedin.test/api${qs}`), headers: new Headers() };
  const res = await handler(req);
  return { status: res.status, body: res.body };
}

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

const PREFIX = "LITEST_";
const RUN = randomUUID().slice(0, 6).toUpperCase();
const TEST_HOST = "litest.example";
const tagOf = (s) => `${PREFIX}${s}_${RUN}`;
const WORKER_ID = `litest-worker-${RUN.toLowerCase()}`;
/** The spawned worker gets the same rule as this script: fetch refuses every address. */
const NO_NET_PRELOAD = `globalThis.fetch = async () => { throw Object.assign(new TypeError("fetch failed: test-linkedin allows no network"), { cause: { code: "ECONNREFUSED" } }); };`;

/** Runs fn inside a transaction that is always rolled back. */
async function rolledBack(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL lock_timeout = '5s'");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

// ── Made-up places ──────────────────────────────────────────────────────────
// Part A's geo is invented outright. Part B adds invented cities to the real
// geo reference, in a state that exists, inside a rolled-back transaction.

const fold = (v) => String(v ?? "").replace(/\s+/g, " ").trim().normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function madeUpGeo() {
  const states = [["US", "ZQ", "Zedland"], ["US", "YV", "Yonder Vale"], ["CA", "XK", "Xankshire"]];
  const countries = [["US", "United States"], ["CA", "Canada"]];
  const stateName = new Map();
  const stateCode = new Map();
  for (const [c, s, n] of states) {
    stateName.set(`${c}|${s}`, n);
    stateCode.set(`${c}|${fold(n)}`, s);
    stateCode.set(`${c}|${fold(s)}`, s);
  }
  const countryName = new Map();
  const countryCode = new Map();
  for (const [code, name] of countries) {
    countryName.set(code, name);
    countryCode.set(cityKey(name), code);
    countryCode.set(cityKey(code), code);
  }
  countryCode.set("usa", "US");
  return { stateName, stateCode, countryName, countryCode };
}
const GEO = madeUpGeo();
const place = (city, state = "ZQ", country = "US") => ({ country, state, ...(city ? { city } : {}) });
/** Made-up excluded keywords, none a standard one. */
const ownWords = (n, stem = "quuxable") => Array.from({ length: n }, (_, i) => `${stem} widget trade number ${i + 1}`);

// ── A. No database ──────────────────────────────────────────────────────────

function partA() {
  section("A1. One rule for saved, else standard filters (D-P4-1)");
  check("AI Ark scope: the standard filters for a Cleaning client only, as before 128",
    standardFor("Cleaning", "ai_ark") && !standardFor("Canada Cleaning", "ai_ark") && !standardFor("Non-Cleaning", "ai_ark") && !standardFor(null, "ai_ark"));
  check("LinkedIn scope: the standard filters for every client type, untyped included",
    ["Cleaning", "Canada Cleaning", "Non-Cleaning", "OS", null].every((t) => standardFor(t, "linkedin")));
  check("a source's scope: linkedin for linkedin, ai_ark for anything else", scopeOf("linkedin") === "linkedin" && scopeOf("ai_ark") === "ai_ark" && scopeOf(undefined) === "ai_ark");
  const savedRow = { ...EMPTY_PEOPLE_FILTERS, titles: ["Quux Wrangler"], exclude_titles: ["Quux Zorbler"] };
  const linkedSaved = filtersFor(savedRow, { clientType: "OS", scope: "linkedin" });
  check("a saved row wins in both scopes, and LinkedIn still sends the standard keywords and company types",
    filtersFor(savedRow, { clientType: "Cleaning" }).from === "saved" && linkedSaved.from === "saved" && linkedSaved.value === savedRow && linkedSaved.cleaning === true);
  check("nothing saved: the standard filters on LinkedIn whatever the type, none on the AI Ark tab for a non-Cleaning client",
    filtersFor(null, { clientType: "OS", scope: "linkedin" }).value === CLEANING_DEFAULTS && filtersFor(null, { clientType: "OS" }).value === EMPTY_PEOPLE_FILTERS && filtersFor(null, { clientType: "OS" }).from === "none");
  check("the AI Ark tab's company filters are as before 128",
    JSON.stringify(companyFiltersFor(null, "Cleaning")) === JSON.stringify({ saved: false, defaultsFrom: "cleaning", value: { employee_bands: CLEANING_DEFAULTS.employee_bands, industries: [], exclude_industries: CLEANING_DEFAULTS.exclude_industries } }) &&
      JSON.stringify(companyFiltersFor(null, "Non-Cleaning")) === JSON.stringify({ saved: false, defaultsFrom: null, value: { employee_bands: [], industries: [], exclude_industries: [] } }));
  check("people runs' excluded titles: as before 128 for AI Ark, the standard ones for every type on LinkedIn",
    JSON.stringify(excludedTitlesFor(null, "OS")) === JSON.stringify({ titles: [], from: "none" }) &&
      JSON.stringify(excludedTitlesFor(null, "OS", { scope: "linkedin" })) === JSON.stringify({ titles: CLEANING_EXCLUDE_TITLES, from: "cleaning" }) &&
      JSON.stringify(excludedTitlesFor({ exclude_titles: [" Quux Zorbler "] }, "OS", { scope: "linkedin" })) === JSON.stringify({ titles: ["Quux Zorbler"], from: "saved" }));

  section("A2. The switch, its client list and the starter list (D-P4-6, D-P4-7)");
  const off = settingsFrom([]);
  check("ships off: no client, 13 people a company, no starter keywords",
    off.linkedin_sources.enabled === false && off.linkedin_sources.tags.length === 0 && off.linkedin_sources.people_per_company === 13 && PEOPLE_PER_COMPANY === 13 &&
      off.linkedin_starter_keywords.items.length === 0 && off.linkedin_starter_keywords.version === null);
  check("the three LinkedIn switches are known names", ["linkedin_sources", "linkedin_companies", "linkedin_people"].every((f) => FLAGS.includes(f)));
  const A = "LITEST_ON";
  const rows = (ls, cp = true, pp = true) => settingsFrom([
    { key: "linkedin_sources", value: ls },
    { key: "company_pipeline", value: { enabled: cp, tags: [A] } },
    { key: "people_pipeline", value: { enabled: pp, tags: [A] } },
  ]);
  const on = rows({ enabled: true, tags: [A.toLowerCase(), A], people_per_company: 8 });
  check("on for a listed client (tags upper case, once), people a company read", on.flagOn("linkedin_sources", A) && on.linkedin_sources.tags.length === 1 && on.linkedin_sources.people_per_company === 8);
  check("each LinkedIn source needs its pipeline on for the client too",
    on.flagOn("linkedin_companies", A) && on.flagOn("linkedin_people", A) &&
      !rows({ enabled: true, tags: [A] }, false, true).flagOn("linkedin_companies", A) && !rows({ enabled: true, tags: [A] }, true, false).flagOn("linkedin_people", A));
  check("off, or the client not listed: off", !rows({ enabled: false, tags: [A] }).flagOn("linkedin_people", A) && !rows({ enabled: true, tags: [] }).flagOn("linkedin_companies", A));
  check("a settings object from before 128 reads as off", !flagOn({ ...off, linkedin_sources: undefined }, "linkedin_sources", A));
  check("people a company out of range: 13", rows({ enabled: true, tags: [A], people_per_company: 0 }).linkedin_sources.people_per_company === 13 && rows({ enabled: true, tags: [A], people_per_company: 101 }).linkedin_sources.people_per_company === 13);
  const st = starterFrom({ items: [" Quux Diner ", "quux diner", "", 7, "x".repeat(121), "Quux Kiosk"], version: 2, source: "made up", sha256: "f".repeat(64) });
  check("the starter list read: trimmed, once each, too long or not text left out", JSON.stringify(st.items) === JSON.stringify(["Quux Diner", "Quux Kiosk"]) && st.version === 2 && st.sha256 === "f".repeat(64));

  section("A3. Keywords sent: the standard ones first, then the client's own, within AI Ark's limit (D-P4-3)");
  const few = keywordsFor(["Quuxable Diner", "janitorial", "JANITORIAL services"]);
  check("standard first, then own new ones, once each (case aside)",
    few.union.length === CLEANING_EXCLUDE_KEYWORDS.length + 1 && few.union.slice(0, CLEANING_EXCLUDE_KEYWORDS.length).every((t, i) => t.toLowerCase() === CLEANING_EXCLUDE_KEYWORDS[i].toLowerCase()) && few.union.at(-1) === "Quuxable Diner");
  check("few own keywords: all applied", few.notApplied.length === 0 && few.sent.includes("Quuxable Diner"));
  const many = keywordsFor(ownWords(120));
  check("over the limit: the rest listed as checked after the pull, never dropped silently (O1)",
    many.checkedAfter.length > 0 && many.union.every((t) => many.checkedAfter.includes(t) || many.sent.some((s) => hasWords(t, s))) && many.notApplied === many.checkedAfter,
    `${many.checkedAfter.length} checked after`);
  check("every standard keyword is applied", CLEANING_EXCLUDE_KEYWORDS.every((t) => many.sent.some((s) => hasWords(t, s))));
  check("what is sent fits AI Ark's limit", bytes(many.sent) <= COMPANY_TERMS_BYTES && many.sent.length <= 300);
  check("the standard keywords alone fit, with room for the client's own", bytes(condensePhrases(CLEANING_EXCLUDE_KEYWORDS)) < COMPANY_TERMS_BYTES);

  section("A4. The resolver (D-P4-2, D-P4-5)");
  const rules = { include_locations: [place("Quuxville"), place("Barville")], exclude_locations: [], version: "rules-v1" };
  const starter = { items: ["quux diner", "quux kiosk"], version: 1, source: "made up", sha256: null, seeded_at: null, updatedAt: "starter-v1", loaded: true };
  const noRow = resolveLinkedin({ tag: "litest_a", kind: "people", row: null, targeting: rules, starter, saved: null, clientType: "OS" });
  check("no row: the rules' places read live and the starter keywords", noRow.from === "rules_and_starter" && noRow.own.include_locations.length === 2 && JSON.stringify(noRow.own.exclude_keywords) === JSON.stringify(starter.items) && noRow.tag === "LITEST_A");
  check("no row: the standard filters for a client that is not Cleaning", noRow.filters.from === "cleaning" && noRow.filters.value === CLEANING_DEFAULTS && noRow.cleaning === true);
  check("no row: the version covers the rules and the starter list", noRow.versions.own === "rules:rules-v1|starter:starter-v1" && noRow.version === "rules:rules-v1|starter:starter-v1|filters:none");
  const noStarter = resolveLinkedin({ tag: "LITEST_A", kind: "companies", row: null, targeting: rules, starter: { ...starter, items: [], loaded: false }, saved: null });
  check("no row and no starter list loaded: blocked", noStarter.blockers.length === 1 && /starter keyword list is not loaded/.test(noStarter.blockers[0]));
  const row = {
    client_tag: "LITEST_A", kind: "companies", include_locations: [place("Quuxville"), place("Farville", "YV")], exclude_locations: [place("Nearburg")],
    unplaced: [{ side: "include", field: "cities", value: "Quux Heights", why: "made up", suggestions: [place("Quuxville")] }],
    exclude_keywords: ["Quuxable Diner"], notes: [], flags: [], source: "clay", copied_from: null, version: "row-v1",
  };
  const withRow = resolveLinkedin({ tag: "LITEST_A", kind: "companies", row, targeting: rules, starter, saved: { ...EMPTY_PEOPLE_FILTERS, titles: ["Quux Wrangler"], version: "saved-v1" }, clientType: "Cleaning" });
  check("a row: its own lists, never the rules or the starter list", withRow.from === "row" && withRow.own.include_locations.length === 2 && JSON.stringify(withRow.own.exclude_keywords) === JSON.stringify(["Quuxable Diner"]) && withRow.own.unplaced.length === 1);
  check("a row: the saved AI Ark filters win, as on the AI Ark tab", withRow.filters.from === "saved" && JSON.stringify(withRow.filters.value.titles) === JSON.stringify(["Quux Wrangler"]));
  check("a row: its version, the rules' version (its places are narrowed to them) and the saved filters' version beside it",
    withRow.versions.own === "row:row-v1" && withRow.version === "row:row-v1|rules:rules-v1|filters:saved-v1" && ownVersionOf({ row }) === "row:row-v1" && withRow.versions.rules === "rules-v1");
  check("places outside the client's database area are named", withRow.outsideRules.length === 1 && withRow.outsideRules[0].city === "Farville");
  check("... and not searched (O2): the stored lists keep them",
    withRow.search.notSearched.length === 1 && withRow.search.notSearched[0].entry.city === "Farville" && /not searched: outside the client's sending rules/.test(withRow.search.notSearched[0].why) &&
      withRow.search.include.length === 1 && withRow.own.include_locations.length === 2);
  check("a state or country in the rules covers its cities", outsideRules([place("Farville", "YV")], { include_locations: [place(null, "YV")] }).length === 0 && outsideRules([place("Farville", "YV")], { include_locations: [{ country: "US" }] }).length === 0);
  let bad = 0;
  try {
    resolveLinkedin({ tag: "LITEST_A", kind: "jobs", row: null, targeting: null, starter, saved: null });
  } catch {
    bad++;
  }
  check("an unknown kind is refused", bad === 1);

  section("A5. Places as typed and shown");
  const parsed = ["Quuxville, Zedland", "Quuxville, ZQ, US", "Zedland", "Xankshire, Canada", "usa", "Quuxville", "Ottawa, Canada", "a, b, c, d"].map((t) => placeFromText(t, GEO));
  check("City, State; City, State, Country; a state; a province with its country; a country by alias",
    JSON.stringify(parsed.slice(0, 5).map((p) => p.entry)) === JSON.stringify([place("Quuxville"), place("Quuxville"), place(null), { country: "CA", state: "XK" }, { country: "US" }]));
  check("a city with no state, a city with only its country, too many parts: refused with why", parsed.slice(5).every((p) => typeof p.why === "string" && !p.entry));
  check("shown as AI Ark is sent it, and read back the same", placeText(place("Quuxville"), GEO) === "Quuxville, Zedland" && JSON.stringify(placeFromText(placeText(place("Quuxville"), GEO), GEO).entry) === JSON.stringify(place("Quuxville")));
  const shape = cleanOwnInput({ include_locations: ["Quuxville, Zedland", place("Barville")], exclude_locations: [], unplaced: [], exclude_keywords: [" Quux  Diner ", "quux diner", "x".repeat(121)] });
  check("a save's lists checked: keywords trimmed and once each; one over 120 characters refused", shape.errors.length === 1 && JSON.stringify(shape.value.exclude_keywords) === JSON.stringify(["Quux Diner"]));
  check("a save must send all four lists (none emptied by leaving it out)", cleanOwnInput({ include_locations: [] }).errors.length === 3);

  section("A6. The request builders");
  const people = resolveLinkedin({ tag: "LITEST_A", kind: "people", row: { ...row, kind: "people", exclude_keywords: ownWords(120) }, targeting: rules, starter, saved: null, clientType: "OS" });
  const pr = linkedinPeopleRequests({ effective: people, geo: GEO });
  const body = pr.requests[0];
  check("a people search: the person's own place, the standard titles and excluded titles, for a client that is not Cleaning",
    pr.requests.length >= 1 && body.contact.location.any.include.includes("Quuxville, Zedland") && body.contact.location.any.exclude.includes("Nearburg, Zedland") &&
      body.contact.experience.latest.title.any.include.content.length > 0 && body.contact.experience.latest.title.any.exclude.content.length === condensePhrases(CLEANING_EXCLUDE_TITLES).length,
    JSON.stringify(pr.blockers));
  check("people searches keep the standard titles in groups, as the AI Ark tab does", pr.requests.length % Math.max(1, Math.ceil(bytes(condensePhrases(CLEANING_TITLES)) / 2000)) === 0);
  check("the standard company types and keywords, and the client's own keywords on the company",
    JSON.stringify(body.account.type.any.exclude) === JSON.stringify(CLEANING_EXCLUDE_COMPANY_TYPES) && body.account.keyword.any.exclude.content.some((t) => t.startsWith("quuxable widget")) &&
      JSON.stringify(body.contact.keyword.any.exclude.content) === JSON.stringify(condensePhrases(CLEANING_EXCLUDE_KEYWORDS)));
  check("the keywords AI Ark's request can't take are listed in the report and a note as checked after the pull, never as 'not applied' (O1)",
    pr.report.linkedin.keywords.notApplied.length === people.keywords.notApplied.length && people.keywords.notApplied.length > 0 &&
      pr.notes.some((n) => /checked after the pull \(AI Ark limit\)/.test(n)) && !pr.notes.some((n) => /not applied/i.test(n)) && !pr.notes.some((n) => n.startsWith("AI Ark's limits leave room for")) &&
      JSON.stringify(pr.report.linkedin.keywords.checkedAfter) === JSON.stringify(people.keywords.checkedAfter));
  check("the sheet's exclusion terms are not sent: the made-up rules are the resolver's", JSON.stringify(linkedinTargeting(people).exclude_terms) === JSON.stringify(people.own.exclude_keywords));
  const companies = resolveLinkedin({ tag: "LITEST_A", kind: "companies", row, targeting: rules, starter, saved: null, clientType: "Non-Cleaning" });
  const cr = linkedinCompanyRequests({ effective: companies, geo: GEO });
  check("a company search: any office in the places, the standard sizes, industries and company types",
    cr.requests.length === 1 && cr.requests[0].account.location.any.include.includes("Quuxville, Zedland") && !cr.requests[0].account.location.any.include.includes("Farville, Yonder Vale") && Boolean(cr.requests[0].account.employeeSize) &&
      Boolean(cr.requests[0].account.industries?.any?.exclude) && JSON.stringify(cr.requests[0].account.type.any.exclude) === JSON.stringify(CLEANING_EXCLUDE_COMPANY_TYPES));
  check("a company search says head offices are judged, and names the places not searched, outside the client's sending rules (O2)",
    cr.notes.some((n) => /head office/.test(n)) && !cr.notes.some((n) => n.startsWith("AI Ark finds a company when any of its offices is in one of these places, not only")) &&
      cr.notes.some((n) => /not searched: outside the client's sending rules/.test(n) && /Clients page or onboarding sheet/.test(n)) && cr.report.linkedin.notSearched.length === 1);
  const empty = linkedinCompanyRequests({ effective: resolveLinkedin({ tag: "LITEST_A", kind: "companies", row: { ...row, include_locations: [] }, targeting: rules, starter, saved: null }), geo: GEO });
  check("no places: blocked in LinkedIn's words, nothing sent", empty.requests.length === 0 && empty.blockers.some((b) => /LinkedIn companies settings hold no places/.test(b)));
  const longOut = Array.from({ length: 80 }, (_, i) => place(`Quuxburg Number ${i}`));
  const tooMany = linkedinCompanyRequests({ effective: resolveLinkedin({ tag: "LITEST_A", kind: "companies", row: { ...row, exclude_locations: longOut }, targeting: rules, starter, saved: null }), geo: GEO });
  check("excluded places over what one search holds: blocked, never cut", tooMany.requests.length === 0 && tooMany.blockers.some((b) => /to leave out are more than one AI Ark search can hold/.test(b)) && bytes(longOut.map((e) => placeText(e, GEO))) > EXCLUDE_PLACES_BYTES);
  check("the starter list not loaded: blocked", linkedinPeopleRequests({ effective: { ...noStarter, kind: "people" }, geo: GEO }).requests.length === 0);
  const kept = linkedinRunFilters(people);
  check("what a run keeps: the places searched and those not, the keywords sent, checked after and the whole union, the version",
    kept.version === people.version && kept.keywords.checked_after.length === people.keywords.checkedAfter.length && kept.keywords.union.length === people.keywords.union.length &&
      !("not_applied" in kept.keywords) && kept.places.length === 1 && kept.places_not_searched.length === 1 && kept.kind === "people");
  let wrongKind = 0;
  try {
    linkedinCompanyRequests({ effective: people, geo: GEO });
  } catch {
    wrongKind++;
  }
  check("a builder refuses the other kind's settings", wrongKind === 1);

  const record = { location: { headquarter: { city: "Quuxville", state: "Zedland", country: "United States" }, locations: [{ city: "Farville", state: "YV", country: "US" }] } };
  check("a company's head-office keys (hq_keys) beside all its office keys",
    JSON.stringify(companyHqKeys(record, GEO)) === JSON.stringify(["US", "US|ZQ", "US|ZQ|quuxville"]) && companyPlaceKeys(record, GEO).includes("US|YV|farville") && companyHqKeys({ location: {} }, GEO).length === 0);

  section("A7. The people sources");
  check("ai_ark looks by company and linkedin by area", peopleSources().includes("linkedin") && peopleSourceInfo("ai_ark").look === "by_company" && peopleSourceInfo("linkedin").look === "by_area" && peopleSourceInfo("pptest_none") === null);

  section("A8. The seed file's layout");
  const madeUp = madeUpSeedFile();
  check("a made-up version 3 file with seed_picks fits", checkSeedLayout(madeUp).length === 0, checkSeedLayout(madeUp).join("; "));
  check("version 2 (no seed_picks) is refused, by name", checkSeedLayout({ ...madeUp, about: { version: 2 } }).some((e) => e.startsWith("about.version")));
  const broken = structuredClone(madeUp);
  delete broken.seed_picks.clients.LITEST_SEED.people.places.cities;
  broken.seed_picks.clients.LITEST_SEED.flags = ["not_a_flag"];
  const errs = checkSeedLayout(broken);
  check("a missing place field and an unknown flag are named by path", errs.some((e) => e.endsWith("people.places.cities: not a list of text")) && errs.some((e) => e.endsWith(".flags: not a list of known flags")));
  let inside = null;
  try {
    readSeedFile(path.join(REPO, "package.json"), { repoRoot: REPO });
  } catch (e) {
    inside = e;
  }
  check("a seed file inside the repo is refused", Boolean(inside) && /outside the repository/.test(inside.message));
  const dir = mkdtempSync(path.join(process.env.LITEST_TMP ?? os.tmpdir(), "litest-"));
  try {
    const f = path.join(dir, "normalized.json");
    writeFileSync(f, JSON.stringify(madeUp));
    const read = readSeedFile(f, { repoRoot: REPO });
    check("read outside the repo: its sha256, the starter list and the clients", /^[0-9a-f]{64}$/.test(read.sha256) && read.starter.items.length === 3 && read.clients.length === 1);
    writeFileSync(f, JSON.stringify({ ...madeUp, seed_picks: undefined }));
    let layout = null;
    try {
      readSeedFile(f, { repoRoot: REPO });
    } catch (e) {
      layout = e;
    }
    check("another layout is refused before anything is read further", layout instanceof SeedLayoutError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A made-up normalized.json version 3: one client, both kinds, invented places and keywords. */
function madeUpSeedFile() {
  const places = (o = {}) => ({ countries: [], states: [], states_exclude: [], cities: [], cities_exclude: [], free_text_places: [], free_text_places_exclude: [], ...o });
  const pick = (o = {}) => ({
    source_id: "t_made_up", clay_tag: "LITEST SEED", campaign: "Made-up campaign", set_up_at: "2026-07-01T00:00:00.000Z", status: "SUCCESS", records: 10,
    fingerprint: null, company_list: null, raw_location: false, include_style: [], places: places({ states: ["Zedland"], cities: ["Quuxville"] }),
    keywords_exclude: ["quuxable diner"], ...o,
  });
  return {
    about: { version: 3, what: "made up for test-linkedin" },
    lists: { "keywords_exclude.starter": { items: ["quux diner", "quux kiosk", "quux mall"], version: 1, source: "made up" } },
    seed_picks: { version: 1, rule: "made up", clients: { LITEST_SEED: { people: pick(), companies: pick({ source_id: "t_made_up_2" }), flags: ["company_list"], notes: [] } } },
  };
}

// ── B. Against the database (rolled back) ───────────────────────────────────

/** Invented cities added to the geo reference in a state that exists, for this transaction only. */
async function addMadeUpCities(c) {
  const { rows: [st] } = await c.query(`SELECT country_code, admin1_code, state_code, name FROM geo_admin1 WHERE country_code = 'US' ORDER BY state_code LIMIT 1`);
  const cities = [["Quuxville", 900], ["Saint Quuxbury", 50], ["Quuxbury", 10], ["Barville", 70]];
  let id = 9_990_000_000;
  for (const [city, population] of cities) {
    await c.query(
      `INSERT INTO geo_locations (geoname_id, city, city_key, country_code, admin1_code, population) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id++, city, cityKey(city), st.country_code, st.admin1_code, population]
    );
  }
  return { state: st.state_code, stateName: st.name };
}

async function makeClient(c, tag, { type = "Cleaning", places = [], terms = [] } = {}) {
  await c.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, $3)`, [tag, `LinkedIn test ${tag.slice(PREFIX.length)}`, type]);
  if (places) {
    await c.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, updated_at) VALUES ($1, '{US}', $2, '[]', $3, now())`,
      [tag, JSON.stringify(places), terms]
    );
  }
}

async function partB(geo) {
  section("B1. Migration 128");
  const objs = await one(
    `SELECT to_regclass('public.client_linkedin_settings') IS NOT NULL AS settings, to_regclass('public.client_linkedin_settings_log') IS NOT NULL AS log,
            (SELECT bool_and(relrowsecurity) FROM pg_class WHERE relname IN ('client_linkedin_settings', 'client_linkedin_settings_log')) AS rls,
            (SELECT count(*)::int FROM pg_policies WHERE tablename IN ('client_linkedin_settings', 'client_linkedin_settings_log')) AS policies,
            has_table_privilege('anon', 'public.client_linkedin_settings', 'SELECT') OR has_table_privilege('authenticated', 'public.client_linkedin_settings', 'SELECT')
              OR has_table_privilege('anon', 'public.client_linkedin_settings_log', 'SELECT') OR has_table_privilege('authenticated', 'public.client_linkedin_settings_log', 'SELECT') AS readable`
  );
  check("the settings and log tables: server-only (RLS on, no policy, nothing for anon or authenticated)", objs.settings && objs.log && objs.rls && objs.policies === 0 && !objs.readable, JSON.stringify(objs));
  const ls = (await one(`SELECT value FROM enrich_settings WHERE key = 'linkedin_sources'`))?.value;
  const stored = settingsFrom([{ key: "linkedin_sources", value: ls }]).linkedin_sources;
  check("the switch is stored as off, for no client, 13 people a company", Boolean(ls) && !stored.enabled && stored.tags.length === 0 && stored.people_per_company === 13, JSON.stringify(ls));
  check("the starter list is stored (empty until the seed writes it)", Boolean((await one(`SELECT 1 AS ok FROM enrich_settings WHERE key = 'linkedin_starter_keywords'`))?.ok));
  await rolledBack(async (c) => {
    await c.query(`INSERT INTO aiark_company_runs (client_tag, mode, size_requested, filters, requests, source) VALUES ($1, 'demo', 1, '{}', '[{}]', 'linkedin')`, [tagOf("SRC")]);
    let refused = 0;
    await c.query("SAVEPOINT s");
    await c.query(`INSERT INTO aiark_company_runs (client_tag, mode, size_requested, filters, requests, source) VALUES ($1, 'demo', 1, '{}', '[{}]', 'clay')`, [tagOf("SRC")]).catch(() => refused++);
    await c.query("ROLLBACK TO SAVEPOINT s");
    check("company pulls take the source linkedin, and nothing else new", refused === 1);
    const old = await c.query(`SELECT count(*)::int AS n FROM aiark_company_runs WHERE source <> 'ai_ark' AND client_tag <> $1`, [tagOf("SRC")]);
    check("every pull from before 128 reads as an AI Ark pull", old.rows[0].n === 0);
  });

  section("B2. Places checked against the geo reference");
  await rolledBack(async (c) => {
    const st = await addMadeUpCities(c);
    const typed = [place("quuxville", st.state), { country: "us", state: st.stateName, city: "St. Quuxbury" }, place("Quuxbury City", st.state), place("Nowhereville", st.state), { country: "ZZ" }, place("Quuxville", st.state)];
    const out = await checkPlaces(c, typed, geo);
    check("the geo reference's spelling, a state by name, St. as Saint, a trailing City dropped, repeats once",
      JSON.stringify(out.entries) === JSON.stringify([place("Quuxville", st.state), place("Saint Quuxbury", st.state), place("Quuxbury", st.state)]), JSON.stringify(out));
    check("an unknown city and an unsupported country refused, each with why", out.errors.length === 2 && out.errors.some((e) => /Nowhereville is not a known place/.test(e)) && out.errors.some((e) => /ZZ is not a supported country/.test(e)));
    const verify = await checkPlaces(c, [place("quuxville", st.state)], geo, { verify: true });
    check("the seed's check keeps its own spelling", verify.entries[0].city === "quuxville" && verify.errors.length === 0);
  });

  section("B3. A manager's save and its log (D-P4-2, D-P4-5)");
  await rolledBack(async (c) => {
    const st = await addMadeUpCities(c);
    const A = tagOf("SAVE");
    await makeClient(c, A, { type: "OS", places: [place("Quuxville", st.state)], terms: ["quux sheet term"] });
    await writeStarter(c, { items: ["quux diner", "quux kiosk"], version: 1, source: "made up", sha256: "a".repeat(64) });
    const loaded = await linkedinSettingsFor(c, { tag: A, kind: "people" });
    check("no row: the rules' places and the starter keywords, read live", loaded.from === "rules_and_starter" && loaded.own.include_locations.length === 1 && loaded.own.exclude_keywords.length === 2 && loaded.client?.client_type === "OS");
    const userId = randomUUID();
    const input = (o = {}) => ({ include_locations: ["Quuxville, " + st.stateName, "Barville, " + st.stateName], exclude_locations: [], unplaced: [], exclude_keywords: ["quux diner", "Quux Kiosk", "quux zorbatorium"], ...o });
    const stale = await saveLinkedinSettings(c, { tag: A, kind: "people", input: input(), version: "rules:old|starter:old", userId, geo });
    check("a stale version: 409, nothing saved", stale.status === 409 && stale.changed === true && !(await readLinkedinRow(c, A, "people")));
    const badPlace = await saveLinkedinSettings(c, { tag: A, kind: "people", input: input({ include_locations: ["Nowhereville, " + st.stateName] }), version: loaded.versions.own, userId, geo });
    check("a place that isn't one: 400 naming it, nothing saved", badPlace.status === 400 && /Nowhereville/.test(badPlace.error) && !(await readLinkedinRow(c, A, "people")));
    const first = await saveLinkedinSettings(c, { tag: A, kind: "people", input: input(), version: loaded.versions.own, userId, geo });
    const log1 = await c.query(`SELECT action, changed_by, before, after FROM client_linkedin_settings_log WHERE client_tag = $1`, [A]);
    check("the first save makes the client's own row (source manual) from what was shown and edited",
      first.status === 200 && first.saved && first.row.source === "manual" && first.row.include_locations.length === 2 && first.row.exclude_keywords.length === 3, JSON.stringify(first.error ?? ""));
    check("... and logs who, the lists before (the rules' places and the starter list) and after",
      log1.rows.length === 1 && log1.rows[0].action === "save" && log1.rows[0].changed_by === userId && log1.rows[0].before.from === "rules_and_starter" &&
        log1.rows[0].before.exclude_keywords.length === 2 && log1.rows[0].after.exclude_keywords.length === 3);
    const same = await saveLinkedinSettings(c, { tag: A, kind: "people", input: input(), version: first.version, userId, geo });
    check("a save that changes nothing: nothing written, nothing logged", same.status === 200 && same.unchanged && (await c.query(`SELECT count(*)::int AS n FROM client_linkedin_settings_log WHERE client_tag = $1`, [A])).rows[0].n === 1);
    const companiesView = await linkedinSettingsFor(c, { tag: A, kind: "companies" });
    const other = await saveLinkedinSettings(c, { tag: A, kind: "companies", input: input({ exclude_keywords: [] }), version: companiesView.versions.own, userId, geo });
    check("each kind is its own row", other.status === 200 && (await readLinkedinRow(c, A, "companies"))?.exclude_keywords.length === 0 && (await readLinkedinRow(c, A, "people"))?.exclude_keywords.length === 3);
    const seeded = await seedLinkedinRow(c, { tag: A, kind: "people", value: { include_locations: [place("Quuxville", st.state)], exclude_locations: [], unplaced: [], exclude_keywords: ["x"] }, sha256: "b".repeat(64), seededBy: "litest@host", geo });
    check("the seed never writes over a person's save", seeded.status === "kept_manual" && (await readLinkedinRow(c, A, "people"))?.exclude_keywords.length === 3);
    const log = await logFor(c, { tag: A, kind: "people" });
    check("the page's log: who and when, with counts only", log.length === 1 && log[0].action === "save" && log[0].after.keywords === 3 && log[0].before.keywords === 2);
  });

  section("B4. The seed's writes and the starter list (D-P4-4)");
  await rolledBack(async (c) => {
    const st = await addMadeUpCities(c);
    const S = tagOf("SEED");
    await makeClient(c, S, { places: [place("Quuxville", st.state)] });
    const value = {
      include_locations: [place("Quuxville", st.state), place("Barville", st.state)], exclude_locations: [],
      unplaced: [{ side: "include", field: "cities", value: "Quux Heights", why: "not a city of the listed state", suggestions: [place("Quuxville", st.state)] }],
      exclude_keywords: ["quuxable diner"], notes: ["made up"], flags: ["company_list"], copied_from: null,
    };
    const prov = { clay_source_id: "t_made_up", clay_campaign: "Made-up campaign", clay_set_up_at: "2026-07-01T00:00:00.000Z", clay_fingerprint: "fp" };
    const w1 = await seedLinkedinRow(c, { tag: S, kind: "companies", value, provenance: prov, sha256: "c".repeat(64), seededBy: "litest@host", geo });
    const r1 = await readLinkedinRow(c, S, "companies");
    check("written as the seed's (source clay), with where it came from and the file's sha256",
      w1.status === "written" && r1.source === "clay" && r1.clay_source_id === "t_made_up" && r1.seed_sha256 === "c".repeat(64) && r1.unplaced.length === 1 && r1.flags[0] === "company_list" && Boolean(r1.seeded_at));
    const w2 = await seedLinkedinRow(c, { tag: S, kind: "companies", value, provenance: prov, sha256: "d".repeat(64), seededBy: "litest@host", geo });
    check("the same again: unchanged, no new log entry", w2.status === "unchanged" && (await c.query(`SELECT count(*)::int AS n FROM client_linkedin_settings_log WHERE client_tag = $1`, [S])).rows[0].n === 1);
    const w3 = await seedLinkedinRow(c, { tag: S, kind: "companies", value: { ...value, exclude_keywords: ["quuxable diner", "quuxable kiosk"] }, provenance: prov, sha256: "d".repeat(64), seededBy: "litest@host", geo });
    const l3 = await c.query(`SELECT action, seeded_by, seed_sha256, before, after FROM client_linkedin_settings_log WHERE client_tag = $1 ORDER BY id`, [S]);
    check("a changed seed replaces its own row, logged with before and after", w3.status === "replaced" && l3.rows.length === 2 && l3.rows[1].before.exclude_keywords.length === 1 && l3.rows[1].after.exclude_keywords.length === 2 && l3.rows[1].seeded_by === "litest@host");
    const refused = await seedLinkedinRow(c, { tag: S, kind: "people", value: { ...value, include_locations: [place("Nowhereville", st.state)] }, provenance: prov, sha256: "d".repeat(64), seededBy: "litest@host", geo });
    check("a seeded place that isn't one: the row refused", refused.status === "refused" && !(await readLinkedinRow(c, S, "people")));
    check("no client_tags row: nothing written", (await seedLinkedinRow(c, { tag: tagOf("NOCLIENT"), kind: "people", value, provenance: prov, sha256: "d".repeat(64), seededBy: "x@y", geo })).status === "no_client");
    const s1 = await writeStarter(c, { items: ["quux diner"], version: 1, source: "made up", sha256: "e".repeat(64) });
    const s2 = await writeStarter(c, { items: ["quux diner"], version: 1, source: "made up", sha256: "e".repeat(64) });
    const read = await readStarter(c);
    check("the starter list: written once, then unchanged", s1.status === "written" && s2.status === "unchanged" && read.loaded && read.items[0] === "quux diner" && read.version === 1);
    const before = await c.query(`SELECT include_locations FROM client_targeting WHERE client_tag = $1`, [S]);
    check("the seed never touches the client's rules", before.rows[0].include_locations.length === 1);
  });

  section("B5. With linkedin_sources off nothing LinkedIn can start");
  await rolledBack(async (c) => {
    const A = tagOf("OFF");
    await makeClient(c, A, { places: [] });
    let refused = null;
    try {
      await createPeopleRun(c, { tag: A, mode: "demo", source: "linkedin", settings: settingsFrom([]) });
    } catch (e) {
      refused = e;
    }
    check("a LinkedIn people run is refused (not built until Builder L1's part, then by the switch)", refused instanceof PeopleRunRefused);
  });
}

// ── A9. The overrides, no database (O1, O2, O3) ─────────────────────────────

function partO3() {
  section("A9. O2: a LinkedIn search covers only places the client's sending rules allow");
  const QV = place("Quuxville");
  const B = place("Barville");
  const F = place("Farville");
  const Y = place("Yonderton", "YV");
  const rules = { include_locations: [QV, B, Y], exclude_locations: [] };
  const own = [QV, place(null, "YV"), F, place(null, "XK", "CA"), B];
  const n = narrowPlaces(own, rules);
  check("a city the rules cover is kept, in order", n.include[0].city === "Quuxville" && n.include.some((e) => e.city === "Barville"));
  check("a state entry the rules don't cover is replaced by the rules' cities inside it",
    n.replaced.length === 1 && n.replaced[0].entry.state === "YV" && !n.replaced[0].entry.city && JSON.stringify(n.replaced[0].by) === JSON.stringify([Y]) && n.include.some((e) => e.city === "Yonderton"));
  check("a city the rules don't cover is left out and listed, with what brings it in",
    n.notSearched.some((x) => x.entry.city === "Farville" && x.why === NOT_SEARCHED) && !n.include.some((e) => e.city === "Farville") && /Clients page or onboarding sheet/.test(NOT_SEARCHED_FIX));
  check("a state with no rules place inside is left out too", n.notSearched.some((x) => x.entry.state === "XK" && !x.entry.city));
  check("de-duplicated, stable order", JSON.stringify(n.include.map((e) => e.city)) === JSON.stringify(["Quuxville", "Yonderton", "Barville"]));
  const covered = narrowPlaces([place("Farville")], { include_locations: [place(null)] });
  check("a city inside a state the rules hold is kept", covered.include.length === 1 && !covered.notSearched.length);
  const country = narrowPlaces([{ country: "US" }], rules);
  check("a country entry is replaced by the rules' places inside it", country.include.length === 3 && country.replaced[0].by.length === 3);
  const excluded = narrowPlaces([QV, B], { include_locations: [place(null)], exclude_locations: [B] });
  check("an entry the rules exclude is left out", excluded.include.length === 1 && excluded.notSearched[0].why === NOT_SEARCHED_EXCLUDED);
  const none = narrowPlaces([QV, F], null);
  const empty = narrowPlaces([QV, F], { include_locations: [], exclude_locations: [] });
  check("a client whose rules hold no include places (no row, or none) is not narrowed",
    none.include.length === 2 && !none.narrowed && empty.include.length === 2 && !empty.notSearched.length);
  const starter = { items: ["quux diner"], version: 1, source: "made up", sha256: null, seeded_at: null, updatedAt: "s1", loaded: true };
  const row = { client_tag: "LITEST_N", kind: "people", include_locations: [F], exclude_locations: [], unplaced: [], exclude_keywords: ["quux diner"], notes: [], flags: [], source: "manual", copied_from: null, version: "r1" };
  const blocked = resolveLinkedin({ tag: "LITEST_N", kind: "people", row, targeting: { ...rules, version: "t1" }, starter, saved: null });
  const blockedReq = linkedinPeopleRequests({ effective: blocked, geo: GEO });
  check("narrowing that leaves no place blocks the search, with that reason; nothing is searched",
    blocked.blockers.some((b) => /None of LITEST_N's 1 LinkedIn people places is inside its sending rules/.test(b)) && blockedReq.requests.length === 0 &&
      !blockedReq.blockers.some((b) => /hold no places/.test(b)));
  check("the stored lists stay exactly as saved", JSON.stringify(blocked.own.include_locations) === JSON.stringify([F]) && blocked.search.include.length === 0);
  const ok = resolveLinkedin({ tag: "LITEST_N", kind: "people", row: { ...row, include_locations: [QV, F] }, targeting: { ...rules, version: "t1" }, starter, saved: null });
  const okReq = linkedinPeopleRequests({ effective: ok, geo: GEO });
  check("the request sends only the places searched, and lists those not searched",
    okReq.requests.every((b) => JSON.stringify(b.contact.location.any.include) === JSON.stringify(["Quuxville, Zedland"])) && okReq.report.linkedin.notSearched.length === 1 &&
      linkedinRunFilters(ok).places_not_searched[0].entry.city === "Farville" && okReq.notes.some((x) => /not searched: outside the client's sending rules/.test(x)));
  const otherRules = resolveLinkedin({ tag: "LITEST_N", kind: "people", row: { ...row, include_locations: [QV, F] }, targeting: { ...rules, version: "t2" }, starter, saved: null });
  check("a change of the rules changes the version a run compares", otherRules.version !== ok.version && otherRules.versions.own === ok.versions.own);

  section("A10. O1: every keyword enforced after the pull");
  const fillers = Array.from({ length: 60 }, (_, i) => `quuxfill${String(i).padStart(2, "0")}`);
  const k = keywordsFor([...fillers, "quux gadget emporium"]);
  check("a keyword over AI Ark's request limit is checked after the pull, and kept in the union", k.checkedAfter.includes("quux gadget emporium") && k.union.includes("quux gadget emporium") && !k.sent.includes("quux gadget emporium"));
  const unionLower = k.union.map((x) => x.toLowerCase());
  check("the after-pull matcher finds it as the sheet terms are found: anywhere in the name or industry, whole words in the description",
    companyTermHit({ company: "The Quux Gadget Emporium LLC", industry: "", description: "" }, unionLower)?.label === "company name" &&
      companyTermHit({ company: "Acme", industry: "", description: "We are the quux gadget emporium of the north." }, unionLower)?.label === "company description" &&
      companyTermHit({ company: "Acme", industry: "", description: "quux gadget emporiums" }, ["quux gadget emporium"])?.label === "company description" &&
      companyTermHit({ company: "Acme", industry: "", description: "megaquux gadget emporium" }, ["quux gadget emporium"]) === null);

  section("A11. The pick of a LinkedIn run (pure)");
  const cand = (id, company, seq, extra = {}) => ({ person_id: id, company_id: company, verdict: "candidate", track: null, rank: null, seq, ...extra });
  const rows = [
    cand("p1", "c1", 5), cand("p2", "c1", 1), cand("p3", "c1", 9, { track: "ceo", rank: 0 }), cand("p4", "c1", 2, { track: "operations", rank: 3 }),
    cand("p5", "c2", 0), cand("p6", "c2", 3), cand("p7", "c2", 4, { verdict: "bought_before", copy_ok: true }), cand("p8", "c2", 6, { verdict: "bought_before", copy_ok: false }),
    cand("p9", "c3", 7, { verdict: "outside" }), cand("p10", null, 8, { verdict: "no_company" }),
  ];
  const picks = pickArea(rows, { room: (c) => (c === "c1" ? 3 : 2), maxBuys: 100 });
  const of = (c) => picks.filter((x) => x.company_id === c).map((x) => x.person_id);
  check("track holders first (track order, then rank), then AI Ark's order", JSON.stringify(of("c1")) === JSON.stringify(["p4", "p3", "p2"]));
  check("at most the room a company has; a bought-before person with an email is picked to copy, one without never",
    JSON.stringify(of("c2")) === JSON.stringify(["p5", "p6"]) && !picks.some((x) => x.person_id === "p8"));
  check("every company's first before any second", JSON.stringify(picks.map((x) => x.person_id).slice(0, 2)) === JSON.stringify(["p5", "p4"]));
  check("outside, no-company and other verdicts are never picked", !picks.some((x) => ["p9", "p10"].includes(x.person_id)));
  const capped = pickArea(rows, { room: () => 13, maxBuys: 3 });
  check("at most max_people to buy; copies are free and not counted", capped.filter((x) => x.buy).length === 3 && capped.some((x) => x.person_id === "p7" && !x.buy));
  check("a company with no room left gets nobody", pickArea(rows, { room: (c) => (c === "c1" ? 0 : 2), maxBuys: 100 }).every((x) => x.company_id !== "c1"));
}

// ── C. Builder L1 ───────────────────────────────────────────────────────────

const C_GEO_IDS = 9_990_100_000; // invented cities committed for part C, removed at the end
const created = { pulls: [], runs: [] };
const quiet = () => {};
const noWait = async () => {};
const demoFor = (tx) => async () => ({ client: createAiArk({ token: DEMO_TOKEN, transport: tx, wait: noWait, rps: 5 }) });
/** A transport over the demo one that records every request body sent. */
const recording = (tx) => {
  const h = async (req) => {
    h.bodies.push({ path: new URL(req.url).pathname, body: req.body ? JSON.parse(req.body) : null });
    return tx(req);
  };
  h.bodies = [];
  h.state = tx.state;
  return h;
};
// Made-up tracks: generic words of the standard titles, never the originals' phrases.
const TRACKS_FIX = {
  order: ["operations", "facility_office", "ceo"],
  operations: { phrases: ["operations"], from: ["C#37"] },
  facility_office: { phrases: ["office"], from: ["C#44"] },
  ceo: { phrases: ["owner", "president"], from: ["C#52"] },
};
const FILLERS = Array.from({ length: 60 }, (_, i) => `quuxfill${String(i).padStart(2, "0")}`);
const settingsOn = ({ companies = [], people = [], linkedin = [], ppc = 13, peopleOver = {}, enabled = true } = {}) =>
  settingsFrom([
    { key: "company_pipeline", value: { enabled: true, tags: companies, min_balance: 0 } },
    { key: "people_pipeline", value: { enabled: true, tags: people, auto_buy: false, pages_per_search: 2, max_people_per_run: 300, min_balance: 0, ...peopleOver } },
    { key: "linkedin_sources", value: { enabled, tags: linkedin, people_per_company: ppc } },
    { key: "people_tracks", value: TRACKS_FIX },
  ]);

async function inPoolTx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** The invented cities part C searches, committed in a state that exists (no demo decoy lives there). */
async function addCommittedCities() {
  const states = await all(
    `SELECT country_code, admin1_code, state_code, name FROM geo_admin1 WHERE country_code = 'US' AND state_code NOT IN ('MO', 'ND', 'WY', 'AK', 'MT', 'IL') ORDER BY state_code LIMIT 2`
  );
  const [st, other] = states;
  const cities = [["Quuxville", 900], ["Barville", 70], ["Farville", 40], ["Zorburg", 30], ["Nearburg", 20], ["Saint Quuxbury", 15], ["Mount Quux", 12], ["Ploverton", 300], ["Quillby", 250]];
  let id = C_GEO_IDS;
  for (const [city, population] of cities) {
    await pool.query(`INSERT INTO geo_locations (geoname_id, city, city_key, country_code, admin1_code, population) VALUES ($1, $2, $3, $4, $5, $6)`, [
      id++, city, cityKey(city), st.country_code, st.admin1_code, population,
    ]);
  }
  await pool.query(`INSERT INTO geo_locations (geoname_id, city, city_key, country_code, admin1_code, population) VALUES ($1, 'Quuxville', 'quuxville', $2, $3, 5)`, [
    id++, other.country_code, other.admin1_code,
  ]);
  return { state: st.state_code, stateName: st.name, other: other.state_code, otherName: other.name };
}

async function addTestClient(tag, { type = "Cleaning", places = [], terms = [], variant = true } = {}) {
  await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, $3)`, [tag, `LinkedIn test ${tag.slice(PREFIX.length)}`, type]);
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
     VALUES ($1, '{US}', $2, '[]', $3, false, now())`,
    [tag, JSON.stringify(places), terms]
  );
  // The made-up Clay originals as the client's own variant, so its pipeline tables compile without the real ones.
  if (variant) await seedFixtureVariant(pool, tag);
}

async function newPull(tag, { requests, size, source = "ai_ark", targeting = null, filters = {} }) {
  const run = await inPoolTx((c) => createCompanyRun(c, { tag, mode: "demo", size, filters, requests, source, targeting }));
  created.pulls.push(run.id);
  return run;
}
const TERMINAL = new Set(["done", "stopped", "error", "cancelled"]);
async function drivePull(id, clientFor, limit = 400) {
  for (let i = 0; i < limit; i++) {
    const r = await one(`SELECT status FROM aiark_company_runs WHERE id = $1`, [id]);
    if (TERMINAL.has(r.status)) return r.status;
    const worked = await advanceOneCompanyRun({ pool, clientFor, log: quiet });
    if (!worked) await pool.query(`UPDATE aiark_company_runs SET next_run_at = now() WHERE id = $1`, [id]);
  }
  throw new Error(`company pull ${id} did not finish`);
}
async function newPeopleRun(tag, { settings, version = null, maxPeople = null }) {
  const run = await inPoolTx((c) => createPeopleRun(c, { tag, mode: "demo", source: "linkedin", maxPeople, createdBy: null, settings, version }));
  created.runs.push(run.id);
  return run;
}
async function drivePeople(id, clientFor, settings, until = new Set([...TERMINAL, "looked"]), limit = 600) {
  for (let i = 0; i < limit; i++) {
    const r = await one(`SELECT status FROM aiark_people_runs WHERE id = $1`, [id]);
    if (until.has(r.status)) return r.status;
    const worked = await advanceOnePeopleRun({ pool, clientFor, log: quiet, settings, maxBuysPerSlice: 10 });
    if (!worked) await pool.query(`UPDATE aiark_people_runs SET next_run_at = now() WHERE id = $1 AND status IN ('queued', 'running')`, [id]);
  }
  throw new Error(`people run ${id} did not get to ${[...until].join("/")}`);
}
const cellsOf = async (rowId) => Object.fromEntries((await all(`SELECT column_key, value FROM enrich_cells WHERE row_id = $1`, [rowId])).map((x) => [x.column_key, x.value]));
const rowsOfTable = (tableId) => all(`SELECT id, row_key, run_status FROM enrich_rows WHERE table_id = $1 ORDER BY id`, [tableId]);
const placeIn = (e, geoMaps) => placeText(e, geoMaps);
/** Place entries compared by value (jsonb keeps no key order). */
const sameEntries = (a, b) => JSON.stringify((a ?? []).map(canonEntry)) === JSON.stringify((b ?? []).map(canonEntry));
/** A Company Search record of the demo for a place, by index (makeCompany), as AI Ark would return it. */
const demoCompanies = (placeStr, n) => Array.from({ length: n }, (_, i) => makeCompany(placeStr, i));

async function partC() {
  const { geo } = await geoFor(pool);
  const g = await addCommittedCities();
  const QV = { country: "US", state: g.state, city: "Quuxville" };
  const B = { country: "US", state: g.state, city: "Barville" };
  const F = { country: "US", state: g.state, city: "Farville" };
  const Z = { country: "US", state: g.state, city: "Zorburg" };
  const P1 = { country: "US", state: g.state, city: "Ploverton" };
  const P2 = { country: "US", state: g.state, city: "Quillby" };
  const qText = placeIn(QV, geo);
  const bText = placeIn(B, geo);
  const zText = placeIn(Z, geo);
  const p1Text = placeIn(P1, geo);
  const p2Text = placeIn(P2, geo);
  const T_PULL = tagOf("PULL");
  const T_TABPULL = tagOf("AIARKPULL");
  const T_PAGE = tagOf("PAGE");
  const T_PEOPLE = tagOf("PEOPLE");
  const T_WORKER = tagOf("WORKER");
  await addTestClient(T_PULL, { type: "OS", places: [QV, B], terms: ["quuxsheetterm"] });
  await addTestClient(T_TABPULL, { type: "Cleaning", places: [QV, B] });
  await addTestClient(T_PAGE, { type: "Cleaning", places: [Z] });
  await addTestClient(T_PEOPLE, { type: "OS", places: [P1, P2], terms: ["quuxsheetterm"] });
  await addTestClient(T_WORKER, { type: "Cleaning", places: [QV] });
  resetClientChecks();
  const sha = "1".repeat(64);
  const seedRow = (tag, kind, value) => inPoolTx((c) => seedLinkedinRow(c, { tag, kind, value: { exclude_locations: [], unplaced: [], notes: [], flags: [], copied_from: null, ...value }, provenance: {}, sha256: sha, seededBy: "litest@host", geo }));

  // ── C1 to C4: a LinkedIn company pull ────────────────────────────────────
  section("C1. A LinkedIn company pull: its source, kind and label; the copy by head-office keys from the places searched");
  const tx = createDemoTransport({ companiesPerPlace: 12 });
  const laReq = buildCompanyRequests({ targeting: { include_locations: [QV, B], exclude_locations: [], exclude_terms: [] }, filters: CLEANING_DEFAULTS, geo, cleaning: true });
  const laRun = await newPull(T_TABPULL, { requests: laReq.requests, size: 8 });
  check("an AI Ark pull first fills the registry (the copy's source)", (await drivePull(laRun.id, demoFor(tx))) === "done");
  const laReg = await all(`SELECT company_id, hq_keys, place_keys FROM aiark_companies WHERE run_id = $1`, [laRun.id]);
  check("a bought page stores each company's head-office keys in the registry (hq_keys)", laReg.length > 0 && laReg.every((r) => Array.isArray(r.hq_keys)), `${laReg.length} registered`);
  const laRow = await one(`SELECT source, source_id, filters FROM aiark_company_runs WHERE id = $1`, [laRun.id]);
  const laSource = await one(`SELECT kind, label FROM enrich_sources WHERE id = $1`, [laRow.source_id]);
  const laLinkedinCells = await one(`SELECT count(*)::int AS n FROM enrich_cells c JOIN enrich_rows r ON r.id = c.row_id WHERE r.source_id = $1 AND c.column_key IN ('hq_only', 'linkedin_run')`, [laRow.source_id]);
  check("an AI Ark pull is as before: source ai_ark, kind ai_ark, no head-office copy, its rows without the LinkedIn inputs",
    laRow.source === "ai_ark" && laSource.kind === "ai_ark" && laSource.label.startsWith("AI Ark company pull") && !("hq" in laRow.filters.copy) && laLinkedinCells.n === 0);
  await pool.query(`UPDATE aiark_companies SET hq_keys = NULL WHERE run_id = $1`, [laRun.id]);

  // The keyword AI Ark's request can't take: the name of a company the LinkedIn search will return.
  const lcBase = { include_locations: [QV, B, F, { country: "US", state: g.other }], exclude_keywords: FILLERS };
  await seedRow(T_PULL, "companies", lcBase);
  let eff = await linkedinSettingsFor(pool, { tag: T_PULL, kind: "companies" });
  let built = linkedinCompanyRequests({ effective: eff, geo });
  const acct = built.requests[0]?.account ?? {};
  const inside = (c) => [qText, bText].some((p) => officeInPlace(c.location.headquarter, p));
  const pool12 = [...demoCompanies(qText, 12), ...demoCompanies(bText, 12)].filter((c) => !excludedByAccount(c, acct) && inside(c));
  const target = pool12.find((c) => c.summary.name.split(/\s+/).length >= 3 && !pool12.some((o) => o.id !== c.id && o.summary.name.toLowerCase().includes(c.summary.name.toLowerCase())));
  const nameKeyword = target ? target.summary.name.toLowerCase() : "quux never matching phrase";
  await pool.query(`DELETE FROM client_linkedin_settings_log WHERE client_tag = $1`, [T_PULL]);
  await pool.query(`DELETE FROM client_linkedin_settings WHERE client_tag = $1`, [T_PULL]);
  await seedRow(T_PULL, "companies", { ...lcBase, exclude_keywords: [...FILLERS, nameKeyword] });
  eff = await linkedinSettingsFor(pool, { tag: T_PULL, kind: "companies" });
  const sentBefore = JSON.stringify(acct.keyword?.any?.exclude?.content ?? []);
  built = linkedinCompanyRequests({ effective: eff, geo });
  check("the test's keyword is one AI Ark's request can't take (checked after the pull), and the request is the same without it",
    Boolean(target) && eff.keywords.checkedAfter.includes(nameKeyword) && !eff.keywords.sent.includes(nameKeyword) && JSON.stringify(built.requests[0].account.keyword.any.exclude.content) === sentBefore,
    target ? "" : "no demo company fits");
  check("O2: the pull searches only the places the sending rules allow; the others are listed, the stored lists unchanged",
    built.requests.length === 1 && JSON.stringify(built.requests[0].account.location.any.include) === JSON.stringify([qText, bText]) &&
      eff.search.notSearched.length === 2 && eff.own.include_locations.length === 4 && built.notes.some((x) => /not searched: outside the client's sending rules/.test(x)));
  let refusedNoTargeting = null;
  try {
    await inPoolTx((c) => createCompanyRun(c, { tag: T_PULL, mode: "demo", size: 5, filters: { linkedin: linkedinRunFilters(eff) }, requests: built.requests, source: "linkedin" }));
  } catch (e) {
    refusedNoTargeting = e;
  }
  let refusedNoKeywords = null;
  try {
    await inPoolTx((c) => createCompanyRun(c, { tag: T_PULL, mode: "demo", size: 5, filters: {}, requests: built.requests, source: "linkedin", targeting: built.targeting }));
  } catch (e) {
    refusedNoKeywords = e;
  }
  check("a LinkedIn pull is refused without the rules its search was built from, or without its keywords", /needs the rules/.test(refusedNoTargeting?.message ?? "") && /filters\.linkedin/.test(refusedNoKeywords?.message ?? ""));
  const lcTx = recording(tx);
  const lcRun = await newPull(T_PULL, { requests: built.requests, size: 60, source: "linkedin", targeting: built.targeting, filters: { linkedin: linkedinRunFilters(eff), notes: built.notes } });
  const lcStatus = await drivePull(lcRun.id, demoFor(lcTx));
  const lcRow = await one(`SELECT * FROM aiark_company_runs WHERE id = $1`, [lcRun.id]);
  const lcBought = await one(`SELECT kind, label FROM enrich_sources WHERE id = $1`, [lcRow.source_id]);
  check("the pull: source linkedin, its bought rows' source kind linkedin and label", lcStatus === "done" && lcRow.source === "linkedin" && lcBought.kind === "linkedin" && lcBought.label.startsWith(LINKEDIN_LABELS.companyPull), JSON.stringify({ lcStatus, err: lcRow.last_error }));
  check("O2: every Company Search it sent asked only for the places searched",
    lcTx.bodies.filter((x) => x.path.endsWith("/v1/companies")).every((x) => JSON.stringify(x.body.account.location.any.include) === JSON.stringify([qText, bText])) && lcTx.bodies.some((x) => x.path.endsWith("/v1/companies")));
  const lcRows = await all(
    `SELECT r.id, r.row_key, r.source_id, (SELECT value #>> '{}' FROM enrich_cells c WHERE c.row_id = r.id AND c.column_key = 'source') AS source,
            (SELECT value #>> '{}' FROM enrich_cells c WHERE c.row_id = r.id AND c.column_key = 'hq_only') AS hq_only,
            (SELECT value #>> '{}' FROM enrich_cells c WHERE c.row_id = r.id AND c.column_key = 'linkedin_run') AS linkedin_run
       FROM enrich_rows r WHERE r.table_id = $1`,
    [lcRow.table_id]
  );
  const copiedRows = lcRows.filter((r) => r.source_id === lcRow.registry_source_id);
  const boughtRows = lcRows.filter((r) => r.source_id === lcRow.source_id);
  check("copied rows: free from the registry, with the copied label, hq_only and the pull's id",
    copiedRows.length > 0 && copiedRows.every((r) => r.source === LINKEDIN_LABELS.companyRowsCopied && r.hq_only === "true" && r.linkedin_run === lcRun.id), `${copiedRows.length} copied`);
  check("bought rows: the LinkedIn companies label, hq_only and the pull's id",
    boughtRows.length > 0 && boughtRows.every((r) => r.source === LINKEDIN_LABELS.companyRows && r.hq_only === "true" && r.linkedin_run === lcRun.id), `${boughtRows.length} bought`);
  const refilled = await all(`SELECT company_id, hq_keys FROM aiark_companies WHERE run_id = $1`, [laRun.id]);
  check("the copy filled the head-office keys of registry rows that had none", refilled.every((r) => Array.isArray(r.hq_keys)), JSON.stringify(refilled.filter((r) => !r.hq_keys).length));
  const includeKeys = new Set(lcRow.filters.copy.include);
  const copiedIds = copiedRows.map((r) => r.row_key.slice(6));
  const copiedHq = await all(`SELECT company_id, hq_keys FROM aiark_companies WHERE company_id = ANY($1::text[])`, [copiedIds]);
  const branchOnly = refilled.filter((r) => !(r.hq_keys ?? []).some((k) => includeKeys.has(k)));
  check("the copy took only companies headquartered in the places (filters.copy.hq)",
    lcRow.filters.copy.hq === true && copiedHq.every((r) => (r.hq_keys ?? []).some((k) => includeKeys.has(k))) && branchOnly.every((r) => !copiedIds.includes(r.company_id)));

  section("C2. Head offices only: hq_only rows and client_office");
  const columns = await all(`SELECT key, inputs FROM enrich_columns WHERE table_id = $1 AND key IN ('office', 'rule_match', 'hq_only', 'linkedin_run')`, [lcRow.table_id]);
  const colOf = (k) => columns.find((x) => x.key === k);
  check("the template's office step reads hq_only and its exclusion step the pull's id", colOf("office")?.inputs?.hq_only === "{{hq_only}}" && colOf("rule_match")?.inputs?.linkedin_run === "{{linkedin_run}}" && Boolean(colOf("hq_only")) && Boolean(colOf("linkedin_run")));
  const office = (o, extra = {}) => ({ street: "1 Main Street", country: "United States", ...o, ...extra });
  const hqOut = office({ city: "Bismarck", state: "North Dakota" }, { hq: true });
  const branchIn = office({ city: "Quuxville", state: g.stateName });
  const hqIn = office({ city: "Barville", state: g.stateName }, { hq: true });
  const judge = (offices, hqOnly) => COMPANY_ACTIONS.client_office.run({ inputs: { offices: JSON.stringify(offices), ...(hqOnly ? { hq_only: "true" } : {}) }, table: { client_tag: T_PULL }, row: null, db: pool });
  const branchHq = await judge([hqOut, branchIn], true);
  const branchAny = await judge([hqOut, branchIn], false);
  const hqInside = await judge([hqIn, office({ city: "Bismarck", state: "North Dakota" })], true);
  const noHq = await judge([branchIn], true);
  check("a branch-only match on a LinkedIn row: Outside (head office), the branch counted in the note",
    branchHq.display === "Outside (head office)" && branchHq.value.inside === false && branchHq.value.offices_inside === 1 && /an AI Ark pull of the same company would count it/.test(branchHq.note), JSON.stringify(branchHq));
  check("the same company on any other row: inside, by its branch (as before 128)", branchAny.display === "Inside" && branchAny.value.inside === true && branchAny.value.hq === false);
  check("a head office in the area: inside, that office", hqInside.display === "Inside" && hqInside.value.hq === true && hqInside.value.office.city === "Barville");
  check("no head office listed: Can't tell", noHq.display === "Can't tell" && noHq.value.inside === false);
  const lcTable = lcRow.table_id;
  const fakeRec = {
    id: `litest-hqout-${RUN}`.toLowerCase(),
    summary: { name: `Quux Branch Works ${RUN}`, industry: "dental", type: "PRIVATELY_HELD", staff: { total: 20, range: { start: 11, end: 50 } }, description: "A made-up company for the head office check." },
    link: { domain: `branch-${RUN}.${TEST_HOST}`.toLowerCase() },
    location: { headquarter: hqOut, locations: [hqOut, branchIn] },
  };
  const { rows: [fake] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, search_text) VALUES ($1, $2, '') RETURNING id`, [lcTable, `aiark:${fakeRec.id}`]);
  const fakeInputs = { ...companyInputs(fakeRec, { source: LINKEDIN_LABELS.companyRows }), client_tag: T_PULL, hq_only: "true", linkedin_run: lcRun.id };
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display) SELECT $1, kv.key, $2, 'done', to_jsonb(kv.value), left(kv.value, 300) FROM jsonb_each_text($3::jsonb) AS kv`,
    [fake.id, lcTable, JSON.stringify(fakeInputs)]
  );
  const offSettings = settingsFrom([]);
  const fakeWork = await workRow(pool, { calls: {} }, Number(fake.id), { env: {}, settings: offSettings });
  check("a LinkedIn row worked: Outside (head office), the company Outside the client's area, nothing paid",
    fakeWork.cell("office")?.display === "Outside (head office)" && fakeWork.values.company_outcome === "Outside the client's area" && fakeWork.status === "done" && fakeWork.calls === 0,
    JSON.stringify({ office: fakeWork.cell("office")?.display, outcome: fakeWork.values.company_outcome, status: fakeWork.status }));

  section("C2b. O1: every keyword of a LinkedIn pull checked on its rows after the pull");
  const kwRows = [];
  for (const r of boughtRows.concat(copiedRows)) {
    const v = await cellsOf(r.id);
    if (String(v.company ?? "").toLowerCase().includes(nameKeyword)) kwRows.push({ id: r.id, v });
  }
  const anyKw = kwRows[0];
  const ex = anyKw
    ? await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: anyKw.v.company, industry: anyKw.v.industry, description: anyKw.v.description, linkedin_run: lcRun.id }, table: { client_tag: T_PULL }, row: null, db: pool })
    : null;
  check("a pulled company whose name holds a keyword AI Ark's request couldn't take is Excluded, naming the keyword",
    Boolean(anyKw) && ex?.status === "done" && ex.display === `LinkedIn keyword "${nameKeyword}" in the company name`, JSON.stringify({ found: kwRows.length, ex }));
  const kwWork = anyKw ? await workRow(pool, { calls: {} }, Number(anyKw.id), { env: {}, settings: offSettings }) : null;
  check("... worked end to end: Excluded by the client's rules, not passing, nothing paid and no website checked",
    kwWork?.values?.company_outcome === "Excluded by the client's rules" && kwWork.values.passes_filters === false && kwWork.calls === 0 && net.refused === 0,
    JSON.stringify({ outcome: kwWork?.values?.company_outcome, calls: kwWork?.calls }));
  const sheetOnly = anyKw ? await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: anyKw.v.company, industry: anyKw.v.industry, description: anyKw.v.description }, table: { client_tag: T_PULL }, row: null, db: pool }) : null;
  const blankRun = anyKw ? await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: anyKw.v.company, industry: anyKw.v.industry, description: anyKw.v.description, linkedin_run: "" }, table: { client_tag: T_PULL }, row: null, db: pool }) : null;
  check("the same company on a row no LinkedIn pull wrote is judged as before 128: clear, the sheet's terms only",
    sheetOnly?.status === "empty" && JSON.stringify(sheetOnly) === JSON.stringify(blankRun) && /^Clear of the client's 1 exclusion terms$/.test(sheetOnly.note), JSON.stringify(sheetOnly));
  const sheetHit = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Quuxsheetterm Holdings", industry: "", description: "", linkedin_run: lcRun.id }, table: { client_tag: T_PULL }, row: null, db: pool });
  check("the sheet's own terms still come first, worded as before", sheetHit.display === `"quuxsheetterm" in the company name` && /client's exclusion term/.test(sheetHit.note));

  section("C3. One row per company: a later AI Ark pull takes LinkedIn rows over");
  await pool.query(`UPDATE enrich_rows SET run_status = 'done', claim_token = NULL WHERE table_id = $1`, [lcTable]);
  const beforeKeys = (await rowsOfTable(lcTable)).map((r) => r.row_key);
  const lcAiReq = buildCompanyRequests({ targeting: { include_locations: [QV, B], exclude_locations: [], exclude_terms: ["quuxsheetterm"] }, filters: null, geo, cleaning: false });
  const lcAi = await newPull(T_PULL, { requests: lcAiReq.requests, size: 30 });
  await drivePull(lcAi.id, demoFor(tx));
  const afterRows = await rowsOfTable(lcTable);
  const stillHq = await all(`SELECT r.row_key FROM enrich_cells c JOIN enrich_rows r ON r.id = c.row_id WHERE c.table_id = $1 AND c.column_key IN ('hq_only', 'linkedin_run')`, [lcTable]);
  const lcAiRow = await one(`SELECT progress, pulled FROM aiark_company_runs WHERE id = $1`, [lcAi.id]);
  const requeued = afterRows.filter((r) => beforeKeys.includes(r.row_key) && r.run_status === "queued");
  const fakeKey = `aiark:${fakeRec.id}`;
  check("its copy takes over the LinkedIn rows of companies it would take (any office): hq_only and the pull's id cleared, the rows queued again",
    Number(lcAiRow.progress.taken_over ?? 0) > 0 && requeued.length >= Number(lcAiRow.progress.taken_over) && stillHq.some((r) => r.row_key === fakeKey) &&
      stillHq.length < lcRows.filter((r) => r.hq_only).length * 2,
    JSON.stringify({ taken: lcAiRow.progress.taken_over, requeued: requeued.length, left: stillHq.length }));
  check("a company is never written twice", new Set(afterRows.map((r) => r.row_key)).size === afterRows.length && afterRows.length === beforeKeys.length + Number(lcAiRow.pulled));
  // The bought page: a LinkedIn row the copy can't take (not in the registry) that AI Ark returns.
  const lxReq = buildCompanyRequests({ targeting: { include_locations: [Z], exclude_locations: [], exclude_terms: [] }, filters: CLEANING_DEFAULTS, geo, cleaning: true });
  const xRec = demoCompanies(zText, 12).find((c) => !excludedByAccount(c, lxReq.requests[0].account));
  const lxTable = (await inPoolTx((c) => ensurePipelineTables(c, T_PAGE))).companies;
  const { rows: [xRow] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, search_text, run_status) VALUES ($1, $2, '', 'done') RETURNING id`, [lxTable, `aiark:${xRec.id}`]);
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display) SELECT $1, kv.key, $2, 'done', to_jsonb(kv.value), left(kv.value, 300) FROM jsonb_each_text($3::jsonb) AS kv`,
    [xRow.id, lxTable, JSON.stringify({ ...companyInputs(xRec, { source: LINKEDIN_LABELS.companyRows }), client_tag: T_PAGE, hq_only: "true", linkedin_run: lcRun.id })]
  );
  const lxRun = await newPull(T_PAGE, { requests: lxReq.requests, size: 3 });
  await drivePull(lxRun.id, demoFor(createDemoTransport({ companiesPerPlace: 12 })));
  const xCells = await cellsOf(xRow.id);
  const xState = await one(`SELECT run_status FROM enrich_rows WHERE id = $1`, [xRow.id]);
  const lxRows = await rowsOfTable(lxTable);
  check("an AI Ark page returning a company a LinkedIn pull wrote clears hq_only and queues the row again; the company is written once",
    !("hq_only" in xCells) && !("linkedin_run" in xCells) && xState.run_status === "queued" && lxRows.filter((r) => r.row_key === `aiark:${xRec.id}`).length === 1, JSON.stringify({ keys: Object.keys(xCells).length, st: xState.run_status }));
  // A LinkedIn pull returning companies already there leaves them as they are.
  const lcAgain = await newPull(T_PULL, { requests: built.requests, size: 60, source: "linkedin", targeting: built.targeting, filters: { linkedin: linkedinRunFilters(eff) } });
  await drivePull(lcAgain.id, demoFor(createDemoTransport({ companiesPerPlace: 12, faults: { ignoreLists: true } })));
  const hqAfter = await all(`SELECT r.row_key FROM enrich_cells c JOIN enrich_rows r ON r.id = c.row_id WHERE c.table_id = $1 AND c.column_key = 'hq_only'`, [lcTable]);
  check("a LinkedIn pull returning a company already in the table leaves its row as it is", hqAfter.every((r) => !beforeKeys.includes(r.row_key) || stillHq.some((s) => s.row_key === r.row_key)));

  section("C4. What the pull keeps of its settings (filters.linkedin)");
  const fl = lcRow.filters.linkedin;
  check("the places searched and those not searched, with why",
    sameEntries(fl.places, [QV, B]) && fl.places_not_searched.length === 2 && fl.places_not_searched.every((x) => /not searched/.test(x.why)),
    JSON.stringify({ places: fl.places, not: fl.places_not_searched }));
  check("the keywords: the whole union the rows are checked against, those sent, those checked after the pull; the version",
    fl.keywords.union.includes(nameKeyword) && fl.keywords.checked_after.includes(nameKeyword) && !fl.keywords.sent.includes(nameKeyword) && !("not_applied" in fl.keywords) && fl.version === eff.version);

  // ── C5 to C8: a LinkedIn people run ──────────────────────────────────────
  section("C5. A LinkedIn people run: refusals, the Look by area");
  const areaN = 8;
  const ptx0 = createDemoTransport({ areaCompanies: areaN, faults: { previewWithoutDescription: true, noCompanyEvery: 20 } });
  const S = settingsOn({ companies: [], people: [T_PEOPLE], linkedin: [T_PEOPLE], ppc: 2 });
  const lpBase = { include_locations: [P1, P2, F], exclude_keywords: FILLERS };
  await seedRow(T_PEOPLE, "people", lpBase);
  let peff = await linkedinSettingsFor(pool, { tag: T_PEOPLE, kind: "people" });
  const pBuilt = linkedinPeopleRequests({ effective: peff, geo });
  const askTerms = (pBuilt.requests[0]?.account?.keyword?.any?.exclude?.content ?? []).map((t) => t.toLowerCase());
  const askInd = (pBuilt.requests[0]?.account?.industries?.any?.exclude?.content ?? []).map((t) => t.toLowerCase());
  const wordIn = (t, s) => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i").test(String(s ?? ""));
  const insideP = (c, p) => officeInPlace(c.location.headquarter, p);
  const fits = (c) => !askTerms.some((t) => wordIn(t, c.summary.name) || wordIn(t, c.summary.industry) || wordIn(t, c.summary.description)) && !askInd.includes(c.summary.industry.toLowerCase());
  const p1Cos = demoCompanies(p1Text, areaN).filter((c) => insideP(c, p1Text) && fits(c));
  const p2Cos = demoCompanies(p2Text, areaN).filter((c) => insideP(c, p2Text) && fits(c));
  // n3 (the registry's record, D13) and n4 (a contact already held) are in the first place; n1 and n2 anywhere else.
  const n3 = p1Cos[0];
  const n4 = p1Cos[1];
  const rest = [...p1Cos.slice(2), ...p2Cos];
  const [n1, n2] = rest;
  const distinct = [n1, n2, n3, n4].filter(Boolean);
  const lookKw = n1 ? n1.summary.name.toLowerCase() : "quux no company";
  const buyKw = n2 ? `${n2.summary.name.toLowerCase()} is a made-up` : "quux no company either";
  await pool.query(`DELETE FROM client_linkedin_settings_log WHERE client_tag = $1`, [T_PEOPLE]);
  await pool.query(`DELETE FROM client_linkedin_settings WHERE client_tag = $1`, [T_PEOPLE]);
  await seedRow(T_PEOPLE, "people", { ...lpBase, exclude_keywords: [...FILLERS, lookKw, buyKw] });
  peff = await linkedinSettingsFor(pool, { tag: T_PEOPLE, kind: "people" });
  check("the test's two keywords are ones AI Ark's request can't take", Boolean(n1 && n2 && n3 && n4) && peff.keywords.checkedAfter.includes(lookKw) && peff.keywords.checkedAfter.includes(buyKw), `${distinct.length} companies`);

  const off = settingsFrom([]);
  const refusal = async (opts) => {
    try {
      await newPeopleRun(T_PEOPLE, opts);
      return null;
    } catch (e) {
      return e;
    }
  };
  const r1 = await refusal({ settings: off });
  const r2 = await refusal({ settings: settingsOn({ people: [T_PEOPLE], linkedin: [] }) });
  const r3 = await refusal({ settings: settingsOn({ people: [T_PEOPLE], linkedin: [T_PEOPLE], enabled: false }) });
  const r4 = await refusal({ settings: S, version: "stale-version" });
  check("refused while off, the client not listed or LinkedIn off, each with its reason (409)",
    r1 instanceof PeopleRunRefused && /People runs are off/.test(r1.message) && r2 instanceof PeopleRunRefused && /LinkedIn searches' client list/.test(r2.message) &&
      r3 instanceof PeopleRunRefused && /LinkedIn searches are off/.test(r3.message) && r1.status === 409);
  check("refused when the settings changed since the page loaded them (changed)", r4 instanceof PeopleRunRefused && r4.changed === true);

  // A registry company (the bring-in reads it first) with its head office in another place of the area (D13).
  const regRec = {
    ...n3, summary: { ...n3.summary, name: `${n3.summary.name} Registry ${RUN}` },
    location: { headquarter: { city: "Quillby", state: g.stateName, country: "United States" }, locations: [{ city: "Ploverton", state: g.stateName, country: "United States" }] },
  };
  await pool.query(`INSERT INTO aiark_companies (company_id, demo, run_id, name, domain, place_keys, hq_keys, record) VALUES ($1, true, NULL, $2, $3, '{}', '{}', $4)
                    ON CONFLICT (company_id) DO UPDATE SET record = EXCLUDED.record, name = EXCLUDED.name`, [n3.id, regRec.summary.name, `registry-${RUN}.${TEST_HOST}`.toLowerCase(), JSON.stringify(regRec)]);
  created.registry = [n3.id];
  // A usable contact the client's People table already holds at n4: its room is one less.
  const lpTables = await inPoolTx((c) => ensurePipelineTables(c, T_PEOPLE));
  const { rows: [n4Row] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, search_text, run_status) VALUES ($1, $2, '', 'done') RETURNING id`, [lpTables.companies, `aiark:${n4.id}`]);
  const { rows: [heldPerson] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, search_text, run_status) VALUES ($1, $2, '', 'done') RETURNING id`, [lpTables.people, `aiark:litest-held-${RUN}`]);
  await pool.query(
    `INSERT INTO enrich_contacts (row_id, company_row_id, table_id, client_tag, kind, email, verdict, usable, outcome) VALUES ($1, $2, $3, $4, 'person', $5, 'approved', true, 'Approved email')`,
    [heldPerson.id, n4Row.id, lpTables.people, T_PEOPLE, `held.${RUN}@${TEST_HOST}`.toLowerCase()]
  );

  const ptx = recording(ptx0);
  const run1 = await newPeopleRun(T_PEOPLE, { settings: S, version: peff.version });
  const run1Src = await one(`SELECT kind, label FROM enrich_sources WHERE id = $1`, [run1.source_id]);
  check("the run: source linkedin, its People rows' source kind linkedin and label, one batch a search, no companies yet",
    run1.source === "linkedin" && run1Src.kind === "linkedin" && run1Src.label.startsWith(LINKEDIN_LABELS.peopleRun) && run1.batches === run1.filters.bodies.length && run1.companies === 0 &&
      sameEntries(run1.filters.linkedin.places, [P1, P2]) && run1.filters.people_per_company === 2,
    JSON.stringify({ source: run1.source, kind: run1Src.kind, batches: run1.batches, places: run1.filters.linkedin.places }));
  const r5 = await refusal({ settings: S, version: peff.version });
  check("one run per client, of any source", r5 instanceof PeopleRunRefused && /already has a people run going/.test(r5.message));
  const looked1 = await drivePeople(run1.id, demoFor(ptx), S);
  const run1Row = await one(`SELECT * FROM aiark_people_runs WHERE id = $1`, [run1.id]);
  const previews = ptx.bodies.filter((x) => x.path.endsWith("/v1/people/preview"));
  check("the Look waits for a Buy, after one Preview page a credit", looked1 === "looked" && Number(run1Row.pages) === previews.length && Number(run1Row.credits_used) === previews.length && previews.length > 0,
    JSON.stringify({ looked1, pages: run1Row.pages, calls: previews.length, err: run1Row.last_error }));
  check("O2: every Preview asked only for the places searched", previews.every((x) => JSON.stringify(x.body.contact.location.any.include) === JSON.stringify([p1Text, p2Text])));
  const cands = await all(`SELECT * FROM aiark_people_candidates WHERE run_id = $1`, [run1.id]);
  const byVerdict = (v) => cands.filter((c) => c.verdict === v);
  check("candidates: none has a company row yet; each has AI Ark's order", cands.length > 0 && cands.every((c) => c.company_row_id === null && c.seq !== null), `${cands.length}`);
  check("a person AI Ark gives no company: no_company, never picked", byVerdict("no_company").length > 0 && byVerdict("no_company").every((c) => c.company_id === null && c.pick === "none"));
  check("O2: a person outside the sending area (or at a company with no office there) is outside, never picked", byVerdict("outside").length > 0 && byVerdict("outside").every((c) => c.pick === "none"));
  const atN1 = cands.filter((c) => c.company_id === n1.id);
  check("O1: a person whose company's name holds a keyword AI Ark couldn't take is excluded at the Look, never picked",
    atN1.length > 0 && atN1.every((c) => ["excluded", "outside", "held", "never_contact", "bounced", "bought_before"].includes(c.verdict) && c.pick === "none") && atN1.some((c) => c.verdict === "excluded"),
    JSON.stringify(atN1.map((c) => c.verdict)));
  const kept = await all(`SELECT company_id, record FROM aiark_people_preview_companies WHERE run_id = $1`, [run1.id]);
  check("the Preview's company objects are kept for the run (offices, no domain)", kept.length > 0 && kept.every((k) => k.record.location && !k.record.link));

  section("C6. The pick");
  const picked = cands.filter((c) => c.pick === "picked");
  const perCo = new Map();
  for (const c of picked) perCo.set(c.company_id, (perCo.get(c.company_id) ?? 0) + 1);
  check("at most people_per_company a company, less its usable contacts already held", picked.length > 0 && [...perCo.entries()].every(([co, n]) => n <= (co === n4.id ? 1 : 2)) && (perCo.get(n4.id) ?? 0) <= 1,
    JSON.stringify([...perCo.entries()]));
  const orderOk = [...perCo.keys()].every((co) => {
    const pickable = cands.filter((c) => c.company_id === co && c.verdict === "candidate");
    const chosen = pickable.filter((c) => c.pick === "picked");
    const left = pickable.filter((c) => c.pick !== "picked");
    return !(left.some((c) => c.track) && chosen.some((c) => !c.track));
  });
  check("people with a track phrase are picked first", orderOk);
  check("only candidates (and bought-before people with an email) are picked; the run counts them", picked.every((c) => ["candidate", "bought_before"].includes(c.verdict)) && Number(run1Row.picked) === picked.length);

  section("C7. The Buy: Export Single, the company brought in, the person linked to it");
  await approveBuy(pool, { runId: run1.id });
  const done1 = await drivePeople(run1.id, demoFor(ptx), S, TERMINAL);
  const after1 = await all(`SELECT * FROM aiark_people_candidates WHERE run_id = $1 AND pick IN ('bought', 'no_email', 'lost')`, [run1.id]);
  const run1Done = await one(`SELECT * FROM aiark_people_runs WHERE id = $1`, [run1.id]);
  check("the run ends when its picks are bought", done1 === "done" && !(await all(`SELECT 1 FROM aiark_people_candidates WHERE run_id = $1 AND pick = 'picked'`, [run1.id])).length && Number(run1Done.bought) === after1.length,
    JSON.stringify({ done1, bought: run1Done.bought, err: run1Done.last_error, stop: run1Done.stop_reason }));
  const written = after1.filter((c) => c.row_id);
  const peopleCells = await Promise.all(written.map(async (c) => ({ c, v: await cellsOf(c.row_id) })));
  check("each bought person's People row: found_by linkedin, the LinkedIn label, linked to the company row the candidate names",
    written.length > 0 && peopleCells.every(({ c, v }) => v.found_by === "linkedin" && v.source === LINKEDIN_LABELS.peopleRun && v.company_row === String(c.company_row_id) && c.company_row_id !== null));
  const coRows = await all(`SELECT r.id, r.row_key FROM enrich_rows r WHERE r.table_id = $1`, [lpTables.companies]);
  const coKeys = new Set(coRows.map((r) => r.row_key));
  check("each written person's company is in the client's Companies table, one row per company", written.every((c) => coKeys.has(`aiark:${c.company_id}`)) && coKeys.size === coRows.length);
  const brought = await Promise.all(coRows.filter((r) => r.row_key !== `aiark:${n4.id}`).map(async (r) => ({ r, v: await cellsOf(r.id) })));
  check("a company brought in: the LinkedIn people label, judged on any office (no hq_only)", brought.length > 0 && brought.every(({ v }) => v.source === LINKEDIN_LABELS.personCompanies && !("hq_only" in v) && !("linkedin_run" in v)));
  const n3Row = brought.find(({ r }) => r.row_key === `aiark:${n3.id}`);
  check("from the registry first (free): the registry's record", n3Row?.v?.company === regRec.summary.name, JSON.stringify(n3Row?.v?.company ?? null));
  // A company first brought in for a person with no email comes from the Preview's object (no domain) and is reused as it is.
  check("else from the bought person's own company record, with its domain", brought.some(({ r, v }) => r.row_key !== `aiark:${n3.id}` && v.domain && v.website));
  const n2Bought = after1.filter((c) => c.company_id === n2.id && c.pick === "bought");
  check("O1: a bought person whose full company record holds a keyword (its description) ends Excluded: paid, registered, no row, the company not brought in",
    n2Bought.every((c) => c.verdict === "excluded" && c.row_id === null && c.company_row_id === null) &&
      (await all(`SELECT 1 FROM aiark_people WHERE person_id = ANY($1::text[]) AND people_run_id = $2`, [n2Bought.map((c) => c.person_id), run1.id])).length === n2Bought.length,
    JSON.stringify(n2Bought.map((c) => c.verdict)));
  const n2AnyFound = n2Bought.length > 0;
  if (!n2AnyFound) console.log("  (note: no bought person with an email at the description-keyword company this run; the unit check below covers it)");
  // The bring-in's order, unit by unit: registry, the person's record, the Preview's object.
  const fakeRun = { id: run1.id, mode: "demo", client_tag: T_PEOPLE, companies_table_id: lpTables.companies, filters: { company_source_id: run1.filters.company_source_id } };
  const fctx = { pool, run: fakeRun };
  const fromReg = await linkedinCompanyFor(fctx, { company_id: n3.id }, null);
  const personCo = { id: `litest-person-co-${RUN}`.toLowerCase(), summary: { name: "Quux Person Company" }, link: { domain: `person-co-${RUN}.${TEST_HOST}`.toLowerCase() } };
  const fromPerson = await linkedinCompanyFor(fctx, { company_id: personCo.id }, personCo);
  const prevId = kept.find((k) => ![n3.id].includes(k.company_id))?.company_id;
  const fromPreview = await linkedinCompanyFor(fctx, { company_id: prevId }, null);
  check("the company's record: the registry, else the person's own record, else the Preview's object (no domain)",
    fromReg.from === "registry" && fromPerson.from === "person" && fromPerson.record.link.domain && fromPreview.from === "preview" && !fromPreview.record.link);
  const b1 = await bringCompanyIn(pool, { run: fakeRun, record: { ...personCo, location: { headquarter: { city: "Ploverton", state: g.stateName, country: "United States" } } } });
  const b2 = await bringCompanyIn(pool, { run: fakeRun, record: personCo });
  const bCells = await cellsOf(b1.id);
  check("bringing a company in writes it once, with the LinkedIn people label and no hq_only; again reuses the row",
    b1.inserted && !b2.inserted && b1.id === b2.id && bCells.source === LINKEDIN_LABELS.personCompanies && !("hq_only" in bCells) && bCells.client_tag === T_PEOPLE);

  section("C8. found_by linkedin, D13's place, P#27 behind linkedin_profile_reads");
  const atN3 = peopleCells.filter(({ c }) => c.company_id === n3.id);
  check("D13: a LinkedIn person's written city and state are the office's in the client's area (head office first), not their own",
    atN3.length > 0 && atN3.every(({ v }) => v.written_city === "Quillby" && v.written_state === g.state && v.person_city === "Ploverton"),
    JSON.stringify(atN3.map(({ v }) => [v.written_city, v.person_city])));
  const other = peopleCells.find(({ c }) => c.company_id !== n3.id);
  check("... and where the office is the person's own place, that place", !other || (other.v.written_city && other.v.written_state === g.state));
  const p27 = await one(`SELECT config FROM enrich_columns WHERE table_id = $1 AND key = 'current_employer'`, [lpTables.people]);
  check("P#27 stays behind linkedin_profile_reads, off", JSON.stringify(p27?.config?.flag ?? null) === JSON.stringify(["linkedin_profile_reads"]) && !settingsFrom([]).flagOn("linkedin_profile_reads", T_PEOPLE));
  check("people runs of AI Ark keep found_by aiark and the person's own place", (() => {
    const cells = personRowCells({ tag: T_PEOPLE, company: { company_row_id: 1, company_id: "x", website: "" }, track: null, rank: null, person: { id: "p", profile: { first_name: "A" }, location: { city: "Ploverton", state: g.stateName } }, stage: "bought", source: "AI Ark people run" }).cells;
    return cells.found_by === "aiark" && cells.written_city === "Ploverton";
  })());

  section("C5b. Repeated Looks: lists of the people already looked at, and no budget, no Look");
  const spent = await one(
    `INSERT INTO aiark_company_runs (client_tag, mode, size_requested, filters, requests, status, progress, finished_at)
     VALUES ($1, 'demo', 1, '{}', '[{}]', 'done', $2, now()) RETURNING id`,
    [T_WORKER, JSON.stringify({ lists_log: Array.from({ length: 50 }, () => new Date().toISOString()) })]
  );
  created.pulls.push(spent.id);
  const run2 = await newPeopleRun(T_PEOPLE, { settings: S, version: peff.version });
  const st2 = await drivePeople(run2.id, demoFor(ptx), S);
  const run2Row = await one(`SELECT * FROM aiark_people_runs WHERE id = $1`, [run2.id]);
  check("with no list budget, a run whose client's LinkedIn runs already looked at people stops before paying for a page",
    st2 === "stopped" && Number(run2Row.pages) === 0 && Number(run2Row.credits_used) === 0 && /exclusion lists/.test(run2Row.stop_reason ?? ""), JSON.stringify({ st2, stop: run2Row.stop_reason }));
  await pool.query(`DELETE FROM aiark_company_runs WHERE id = $1`, [spent.id]);
  const ptx3 = recording(ptx0);
  const run3 = await newPeopleRun(T_PEOPLE, { settings: S, version: peff.version });
  await drivePeople(run3.id, demoFor(ptx3), S);
  const run3Row = await one(`SELECT * FROM aiark_people_runs WHERE id = $1`, [run3.id]);
  const seen1 = new Set(cands.map((c) => c.person_id));
  const cands3 = await all(`SELECT person_id FROM aiark_people_candidates WHERE run_id = $1`, [run3.id]);
  const prev3 = ptx3.bodies.filter((x) => x.path.endsWith("/v1/people/preview"));
  check("the next run's Look leaves out the people this client's LinkedIn runs already looked at (exclusion lists), within the daily budget",
    (run3Row.progress.lists ?? []).length > 0 && (run3Row.progress.lists_log ?? []).length === run3Row.progress.lists.length && prev3.every((x) => x.body.lists?.people_id?.exclude?.length) && cands3.every((c) => !seen1.has(c.person_id)),
    JSON.stringify({ lists: run3Row.progress.lists?.length, repeats: cands3.filter((c) => seen1.has(c.person_id)).length }));
  await cancelPeopleRun(pool, { runId: run3.id });

  section("C9. The worker");
  const lwEff = await (async () => {
    await seedRow(T_WORKER, "companies", { include_locations: [QV], exclude_keywords: ["quux worker word"] });
    return linkedinSettingsFor(pool, { tag: T_WORKER, kind: "companies" });
  })();
  const lwBuilt = linkedinCompanyRequests({ effective: lwEff, geo });
  const lwRun = await newPull(T_WORKER, { requests: lwBuilt.requests, size: 3, source: "linkedin", targeting: lwBuilt.targeting, filters: { linkedin: linkedinRunFilters(lwEff) } });
  await pool.query(`UPDATE enrich_tables SET is_paused = true WHERE starts_with(client_tag, $1)`, [PREFIX]);
  const env = { ...process.env, ENRICH_ONCE: "1", ENRICH_POLL_MS: "200", ENRICH_WORKER_ID: WORKER_ID, AIARK_DEMO: "1", AIARK_DEMO_LATENCY_MS: "0" };
  for (const key of PAID_KEYS) delete env[key];
  const worker = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(NO_NET_PRELOAD)}`, path.join(REPO, "scripts/enrich-worker.mjs")], { env, encoding: "utf8", timeout: 180_000 });
  await pool.query(`UPDATE enrich_tables SET is_paused = false WHERE starts_with(client_tag, $1)`, [PREFIX]);
  const beat = await one(`SELECT info FROM enrich_worker_state WHERE id = $1`, [WORKER_ID]);
  const lwAfter = await one(`SELECT status, pulled, last_error FROM aiark_company_runs WHERE id = $1`, [lwRun.id]);
  check("the worker's heartbeat offers linkedin_sources", worker.status === 0 && beat?.info?.capabilities?.includes("linkedin_sources"), (worker.stderr || "").slice(-300));
  check("... and works a LinkedIn pull with the company pulls' own loop", lwAfter.status === "done" && Number(lwAfter.pulled) > 0, JSON.stringify(lwAfter));

  await partC10(g);

  section("C11. Guard rails: linkedin_sources off");
  const stored = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
  check("the stored switch is off: no client can start a LinkedIn pull or run",
    !stored.linkedin_sources.enabled && [T_PULL, T_PEOPLE, T_TABPULL, T_PAGE, T_WORKER].every((t) => !stored.flagOn("linkedin_sources", t) && !stored.flagOn("linkedin_companies", t) && !stored.flagOn("linkedin_people", t)));
  const offRun = await refusal({ settings: stored });
  check("a LinkedIn people run is refused with it off", offRun instanceof PeopleRunRefused);
  const toAdd = await pullsToAdd(pool, 500);
  check("pullsToAdd() never returns a LinkedIn pull or run", toAdd.every((r) => !created.pulls.includes(r.id) && !created.runs.includes(r.id)));
}

/** C10: the seed's conversion on invented geo (pure), then the CLI on a made-up file against the local database. */
async function partC10(g) {
  section("C10. The seed: conversion (invented geo)");
  const ix = buildCityIndex({
    cities: [
      { country: "US", state: "ZQ", name: "Quuxville", pop: 900 }, { country: "US", state: "ZQ", name: "Barville", pop: 70 },
      { country: "US", state: "ZQ", name: "Saint Quuxbury", pop: 50 }, { country: "US", state: "ZQ", name: "Mount Quux", pop: 40 },
      { country: "US", state: "ZQ", name: "Nearburg", pop: 30 }, { country: "US", state: "YV", name: "Nearburg", pop: 300 },
      { country: "US", state: "YV", name: "Farville", pop: 60 }, { country: "US", state: "YV", name: "The Quux", pop: 10 },
      { country: "US", state: "YV", name: "Orbtown", pop: 20 }, { country: "US", state: "ZQ", name: "Zedland City", pop: 25 },
      { country: "CA", state: "XK", name: "Ile des Quux", pop: 12 }, { country: "US", state: "ZQ", name: "Kettleburg", pop: 15 },
    ],
    states: [{ country: "US", state: "ZQ", name: "Zedland" }, { country: "US", state: "YV", name: "Yonder Vale" }, { country: "CA", state: "XK", name: "Xankshire" }],
    countries: [{ code: "US", name: "United States", display_name: "USA" }, { code: "CA", name: "Canada", display_name: "Canada" }],
    aliases: [{ alias_key: "usa", country_code: "US" }],
  });
  const places = (o = {}) => ({ countries: [], states: [], states_exclude: [], cities: [], cities_exclude: [], free_text_places: [], free_text_places_exclude: [], ...o });
  const pickOf = (o = {}, kw = []) => ({
    source_id: "t_litest", clay_tag: "LITEST", campaign: null, set_up_at: "2026-07-01T00:00:00.000Z", status: "SUCCESS", records: 1, fingerprint: null,
    company_list: null, raw_location: false, include_style: [], places: places(o), keywords_exclude: kw,
  });
  const conv = (o, ctx = {}) => convertPick(pickOf(o), { kind: "people", cities: ix, other: null, rules: [], ...ctx });
  const a = conv({ states: ["Zedland", "Yonder Vale"], cities: ["Quuxville", "Farville", "St. Quuxbury", "Mt. Quux", "Kettleburg Township", "Nowhere Springs", "Greater Quuxville Area", "Quuxville-Barville", "Orbtown"] });
  const has = (list, city, state) => list.some((e) => e.city === city && e.state === state);
  check("cities placed in the listed state that has them, in the geo reference's spelling",
    has(a.include, "Quuxville", "ZQ") && has(a.include, "Farville", "YV") && has(a.include, "Saint Quuxbury", "ZQ") && has(a.include, "Mount Quux", "ZQ") && has(a.include, "Orbtown", "YV"));
  check("a trailing Township dropped only when the name is no city anywhere (noted)", has(a.include, "Kettleburg", "ZQ") && a.notes.some((n) => /Township/.test(n)));
  const why = (v) => a.unplaced.find((u) => u.value === v);
  check("unplaced with why and suggestions: a local name, a metro area, two cities joined",
    /nor anywhere else/.test(why("Nowhere Springs")?.why ?? "") && /metro area or region/.test(why("Greater Quuxville Area")?.why ?? "") && why("Greater Quuxville Area").suggestions.some((s) => s.city === "Quuxville") &&
      /two cities joined/.test(why("Quuxville-Barville")?.why ?? "") && why("Quuxville-Barville").suggestions.length >= 2);
  const multi = conv({ states: ["Zedland", "Yonder Vale"], cities: ["Nearburg"] });
  check("a name in several listed states: kept in each, noted, when nothing names one", has(multi.include, "Nearburg", "ZQ") && has(multi.include, "Nearburg", "YV") && multi.notes.some((n) => /nothing names one of them/.test(n)));
  const byRules = conv({ states: ["Zedland", "Yonder Vale"], cities: ["Nearburg"] }, { rules: [{ country: "US", state: "YV", city: "Nearburg" }] });
  check("... settled by the client's rules, the other entry set aside", has(byRules.include, "Nearburg", "YV") && !has(byRules.include, "Nearburg", "ZQ") && byRules.setAside.length === 1);
  const byOther = conv({ states: ["Zedland", "Yonder Vale"], cities: ["Nearburg"] }, { other: pickOf({ free_text_places: ["Nearburg Zedland"] }), rules: [{ country: "US", state: "YV", city: "Nearburg" }] });
  check("... settled by the other search first, which names it with its state", has(byOther.include, "Nearburg", "ZQ") && !has(byOther.include, "Nearburg", "YV"));
  const ft = conv({ free_text_places: ["Quuxville Zedland", "Farville, Yonder Vale", "Yonder Vale", "Canada", "Ile des Quux Xankshire"] });
  check("free text: City State, a whole state, a whole country, accents and provinces",
    has(ft.include, "Quuxville", "ZQ") && has(ft.include, "Farville", "YV") && ft.include.some((e) => e.state === "YV" && !e.city) && ft.include.some((e) => e.country === "CA" && !e.state) && has(ft.include, "Ile des Quux", "XK"));
  const named = conv({ states: ["Zedland"], free_text_places: ["Zedland", "Barville"] });
  check("a free-text state the states filter already lists is read as the city of that name there", has(named.include, "Zedland City", "ZQ") && has(named.include, "Barville", "ZQ"));
  const theVar = conv({ states: ["Yonder Vale"], cities: ["Quux"] });
  check("'The' added when the name as written is no city", has(theVar.include, "The Quux", "YV"));
  const countries = conv({ countries: ["United States"] });
  check("whole countries are flagged", countries.include.length === 1 && countries.flags.includes("whole_countries"));
  const excl = conv({ states: ["Zedland"], cities_exclude: ["Barville"], states_exclude: ["Yonder Vale"] });
  check("excluded places in the same format", has(excl.exclude, "Barville", "ZQ") && excl.exclude.some((e) => e.state === "YV" && !e.city));

  section("C10b. The plan: one kind copied, the review case, the flags");
  const stubDb = (tags, rules = {}) => ({
    async query(sql, params) {
      if (/FROM client_tags/.test(sql)) return { rows: params[0].filter((t) => tags.includes(t)).map((tag) => ({ tag })) };
      if (/FROM client_targeting/.test(sql)) return { rows: params[0].filter((t) => rules[t]).map((t) => ({ client_tag: t, include_locations: rules[t] })) };
      throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
    },
  });
  const file = {
    starter: { items: ["quux diner"], version: 1, source: "made up" },
    clients: [
      ["LITEST_P1", { people: { ...pickOf({ states: ["Zedland"], cities: ["Quuxville", "Barville"] }, ["Quux Kiosk", "quux kiosk", " quux mall "]), company_list: { size: 40 } }, companies: null }],
      ["LITEST_P2", {
        people: pickOf({ states: ["Zedland"], cities: ["Quuxville", "Barville"] }, ["quux one"]),
        companies: { ...pickOf({ states: ["Zedland"], cities_exclude: ["Quuxville", "Barville"] }, ["quux two"]), include_style: ["industries_include"] },
        flags: ["unconfirmed_match", "campaigns_not_seeded"],
        campaigns_not_seeded: [{ kind: "people", campaign: "Made-up older", clay_tag: "LITEST", source_id: "t_old", set_up_at: "2025-01-01T00:00:00.000Z", status: "SUCCESS", records: 3 }],
      }],
      ["LITEST_NOT_A_CLIENT", { people: pickOf({ countries: ["United States"] }), companies: null }],
    ],
  };
  const plan = await planSeed(stubDb(["LITEST_P1", "LITEST_P2"]), file, { cities: ix });
  const rowOf = (t, k) => plan.rows.find((r) => r.tag === t && r.kind === k);
  check("a client with one kind only: the other copies its places, unplaced values and keywords (copied_from)",
    rowOf("LITEST_P1", "companies")?.value.copied_from === "people" && rowOf("LITEST_P1", "companies").value.include_locations.length === 2 &&
      JSON.stringify(rowOf("LITEST_P1", "companies").value.exclude_keywords) === JSON.stringify(["Quux Kiosk", "quux mall"]));
  check("a people search Clay limited to a list of companies is seeded as an area search, flagged company_list",
    rowOf("LITEST_P1", "people").value.flags.includes("company_list") && !rowOf("LITEST_P1", "companies").value.flags.includes("company_list") && rowOf("LITEST_P1", "people").value.include_locations.length === 2);
  const review = rowOf("LITEST_P2", "companies");
  check("a search of whole states that left out the client's own cities takes the other kind's places, held for review",
    review.value.flags.includes("review") && review.value.include_locations.length === 2 && review.value.include_locations.every((e) => e.city) && JSON.stringify(review.value.exclude_keywords) === JSON.stringify(["quux two"]));
  check("include-style, unconfirmed and other campaigns flagged, the other campaign in the notes",
    review.value.flags.includes("include_style") && review.value.flags.includes("unconfirmed_match") && review.value.flags.includes("campaigns_not_seeded") && review.value.notes.some((n) => /Made-up older/.test(n)));
  check("a tag with no client_tags row is skipped, with why", plan.skipped.some((s) => s.tag === "LITEST_NOT_A_CLIENT" && /client_tags/.test(s.why)));

  section("C10c. The seed CLI on a made-up file (local database)");
  const S1 = tagOf("SEED1");
  const S2 = tagOf("SEED2");
  await addTestClient(S1, { places: [{ country: "US", state: g.state, city: "Quuxville" }], variant: false });
  await addTestClient(S2, { places: [], variant: false });
  const dir = mkdtempSync(path.join(process.env.LITEST_TMP ?? os.tmpdir(), "litest-seed-"));
  const starterBefore = await one(`SELECT value, updated_at FROM enrich_settings WHERE key = 'linkedin_starter_keywords'`);
  try {
    const v3 = {
      about: { version: 3, what: "made up for test-linkedin" },
      lists: { "keywords_exclude.starter": { items: ["quux diner", "quux kiosk"], version: 1, source: "made up" } },
      seed_picks: {
        version: 1, rule: "made up",
        clients: {
          [S1]: { people: pickOf({ states: [g.stateName], cities: ["Quuxville", "Barville", "St. Quuxbury", "Greater Quuxville Area"] }, ["quuxable diner"]), companies: null },
          [S2]: { people: null, companies: pickOf({ states: [g.stateName], cities: ["Farville"] }, []) },
        },
      },
    };
    const f = path.join(dir, "normalized.json");
    writeFileSync(f, JSON.stringify(v3));
    const cli = (...args) => spawnSync(process.execPath, ["--env-file=.env.local", "scripts/linkedin-seed.mjs", ...args], { cwd: REPO, encoding: "utf8", timeout: 120_000, env: { ...process.env } });
    const logCount = async () => (await one(`SELECT count(*)::int AS n FROM client_linkedin_settings_log WHERE client_tag = ANY($1::text[])`, [[S1, S2]])).n;
    const dry = cli("--file", f, "--only", `${S1},${S2}`, "--report", path.join(dir, "dry.txt"));
    check("the dry run plans and writes nothing", dry.status === 0 && /Dry run \(nothing written\)/.test(dry.stdout) && (await readLinkedinRow(pool, S1, "people")) === null && (await logCount()) === 0, dry.stderr.slice(-300));
    const apply1 = cli("--file", f, "--only", `${S1},${S2}`, "--apply");
    const rowP = await readLinkedinRow(pool, S1, "people");
    const rowC = await readLinkedinRow(pool, S1, "companies");
    check("--apply writes each client's rows, with what could not be placed and where they came from",
      apply1.status === 0 && rowP?.source === "clay" && rowP.include_locations.length === 3 && rowP.include_locations.some((e) => e.city === "Saint Quuxbury") && rowP.unplaced.length === 1 &&
        rowC?.copied_from === "people" && rowP.clay_source_id === "t_litest" && /^[0-9a-f]{64}$/.test(rowP.seed_sha256),
      `${apply1.stdout.slice(-300)} ${apply1.stderr.slice(-300)}`);
    const n1 = await logCount();
    const apply2 = cli("--file", f, "--only", `${S1},${S2}`, "--apply");
    check("a second --apply changes nothing and logs nothing", apply2.status === 0 && /unchanged/.test(apply2.stdout) && (await logCount()) === n1 && n1 === 4);
    const view = await linkedinSettingsFor(pool, { tag: S1, kind: "people" });
    const realGeo = (await geoFor(pool)).geo;
    const saved = await inPoolTx((c) => saveLinkedinSettings(c, { tag: S1, kind: "people", input: { ...ownOf(rowP), exclude_keywords: ["quux saved by hand"] }, version: view.versions.own, userId: randomUUID(), geo: realGeo }));
    if (saved.status !== 200) console.log(`  (the hand save answered ${saved.status}: ${saved.error})`);
    const apply3 = cli("--file", f, "--only", `${S1},${S2}`, "--apply");
    check("a person's save is kept by a later --apply", apply3.status === 0 && /kept_manual 1/.test(apply3.stdout) && JSON.stringify((await readLinkedinRow(pool, S1, "people")).exclude_keywords) === JSON.stringify(["quux saved by hand"]));
    const inRepo = cli("--file", path.join(REPO, "package.json"));
    const reportInRepo = cli("--file", f, "--report", path.join(REPO, "seed-report.txt"));
    writeFileSync(path.join(dir, "v2.json"), JSON.stringify({ ...v3, about: { version: 2 } }));
    const v2 = cli("--file", path.join(dir, "v2.json"));
    check("the CLI refuses a file or a report inside the repo, and another layout",
      inRepo.status !== 0 && /outside the repository/.test(inRepo.stderr) && reportInRepo.status !== 0 && /outside the repository/.test(reportInRepo.stderr) && v2.status !== 0 && /about\.version/.test(v2.stderr));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (starterBefore) await pool.query(`UPDATE enrich_settings SET value = $1, updated_at = $2 WHERE key = 'linkedin_starter_keywords'`, [JSON.stringify(starterBefore.value), starterBefore.updated_at]);
  }
}

// ── R. Builder L2 ───────────────────────────────────────────────────────────

async function partR() {
  section("R. The routes (Builder L2)");
  void call;
  void route;
  void T;
  for (const name of [
    "R1 GET /api/aiark/linkedin-settings: manager and up; both kinds; works with the switch off",
    "R2 PUT /api/aiark/linkedin-settings: 409 on a stale version, 400 with each reason, the log written, an audit line with counts only",
    "R3 POST /api/companies/count and /runs with source linkedin: 409 off, not listed, no linkedin_sources worker; versions from the resolver",
    "R4 POST /api/companies/people/runs with source linkedin: 409 while off (was 400 before 128)",
    "R5 the settings sheet: linkedin_sources switch, client list, people a company; a save without it keeps it",
  ]) later(name, "Builder L2");
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query(`UPDATE enrich_tables SET is_paused = false WHERE starts_with(client_tag, $1)`, [PREFIX]);
  const pulls = (await all(`SELECT id FROM aiark_company_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  const runs = (await all(`SELECT id FROM aiark_people_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  await pool.query(`DELETE FROM aiark_companies WHERE run_id = ANY($1::uuid[]) OR company_id = ANY($2::text[])`, [pulls, created.registry ?? []]);
  await pool.query(`DELETE FROM aiark_people WHERE people_run_id = ANY($1::uuid[])`, [runs]);
  await pool.query(`DELETE FROM aiark_people_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM aiark_company_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  const tables = (await all(`SELECT id FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  await pool.query(`DELETE FROM enrich_memory WHERE starts_with(client_tag, $1) OR table_id = ANY($2::uuid[])`, [PREFIX, tables]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM enrich_worker_state WHERE id = $1`, [WORKER_ID]);
  await pool.query(`DELETE FROM enrich_originals WHERE starts_with(variant, 'litest')`);
  await pool.query(`DELETE FROM geo_locations WHERE geoname_id >= 9990100000 AND geoname_id < 9990200000`);
  await pool.query(`DELETE FROM client_linkedin_settings_log WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_linkedin_settings WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, $1)`, [PREFIX]);
}

const ready = await one(
  `SELECT to_regclass('public.client_linkedin_settings') IS NOT NULL AND to_regclass('public.aiark_people_runs') IS NOT NULL AS ok`
);
if (!ready.ok) {
  console.error("Refusing to run: migrations 125 to 128 are not all in this database.");
  await pool.end();
  process.exit(1);
}
const busy = await one(
  `SELECT (SELECT count(*)::int FROM aiark_company_runs WHERE status IN ('queued', 'running') AND NOT starts_with(client_tag, $1))
        + (SELECT count(*)::int FROM aiark_people_runs WHERE status IN ('queued', 'running') AND NOT starts_with(client_tag, $1)) AS n`,
  [PREFIX]
);
if (busy.n) {
  console.error(`Refusing to run: ${busy.n} company pull(s) or people run(s) are queued or running in this database. Let them finish or cancel them first.`);
  await pool.end();
  process.exit(1);
}
const t0 = Date.now();
const settingsBefore = JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`));
const countsBefore = await one(`SELECT (SELECT count(*)::int FROM leads) AS leads, (SELECT count(*)::int FROM push_items) AS push_items, (SELECT count(*)::int FROM upload_batches) AS uploads`);
try {
  await cleanup();
  partA();
  partO3();
  const geo = await loadGeo(pool);
  await partB(geo);
  await partC();
  await partR();
  section("Z. Nothing left the machine, and the database's sends are as they were");
  check("nothing tried to reach any address", net.refused === 0, `${net.refused} refused`);
  check("no test address reached leads", (await one(`SELECT count(*)::int AS n FROM leads WHERE email LIKE $1`, [`%.${TEST_HOST}`])).n === 0);
  const countsAfter = await one(`SELECT (SELECT count(*)::int FROM leads) AS leads, (SELECT count(*)::int FROM push_items) AS push_items, (SELECT count(*)::int FROM upload_batches) AS uploads`);
  check("leads, push items and uploads did not move", JSON.stringify(countsAfter) === JSON.stringify(countsBefore), JSON.stringify({ countsBefore, countsAfter }));
} catch (e) {
  failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const leftover = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE starts_with(tag, $1)) AS clients,
            (SELECT count(*)::int FROM client_linkedin_settings WHERE starts_with(client_tag, $1)) AS rows,
            (SELECT count(*)::int FROM geo_locations WHERE geoname_id >= 9990000000) AS cities,
            (SELECT count(*)::int FROM aiark_company_runs WHERE starts_with(client_tag, $1)) AS pulls,
            (SELECT count(*)::int FROM aiark_people_runs WHERE starts_with(client_tag, $1)) AS runs,
            (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1)) AS tables,
            (SELECT count(*)::int FROM enrich_originals WHERE starts_with(variant, 'litest')) AS originals`,
    [PREFIX]
  );
  const settingsBack = JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`)) === settingsBefore;
  const clean = Object.values(leftover).every((n) => n === 0) && settingsBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...leftover, settingsBack })}`}`);
  console.log(`${passed} passed, ${failed} failed${pending ? `, ${pending} waiting for their builder` : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(failed || !clean ? 1 : 0);
}
