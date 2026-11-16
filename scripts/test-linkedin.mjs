#!/usr/bin/env node
// Checks for the LinkedIn sources rebuilt on AI Ark (phase 4, migration 128).
// LOCAL DATABASE ONLY. Made-up clients (tags starting LITEST_), made-up places
// and keywords (cities named here are added to the geo reference inside a
// transaction that is rolled back) and .litest.example addresses; everything
// is removed at the end and every setting is put back as it was.
//
//   LITEST_TMP=<a folder outside the repo> node --env-file=.env.local scripts/test-linkedin.mjs
//
// Stop the enrichment worker first. Migrations 125 to 128 must be in the local
// database. Nothing here reaches a network: AI Ark answers only through the
// demo transport, and fetch is replaced for the whole run and refuses every
// address. The routes run through a small TypeScript loader with stand-ins for
// the session, the audit log and the worker's heartbeat (as test-people.mjs).
//
// What it checks:
//   A. no database: the one filter rule (D-P4-1), the settings and switches,
//      the keyword union and the AI Ark limit (D-P4-3), the resolver for a
//      client with and without its own row (D-P4-5), typed places, the
//      request builders, the people sources, the seed file's layout
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
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CLEANING_EXCLUDE_COMPANY_TYPES, CLEANING_EXCLUDE_KEYWORDS, CLEANING_EXCLUDE_TITLES, CLEANING_TITLES } from "./lib/aiark/cleaning-filters.mjs";
import { bytes, CLEANING_DEFAULTS, COMPANY_TERMS_BYTES, condensePhrases, EMPTY_PEOPLE_FILTERS, loadGeo } from "./lib/aiark/filters.mjs";
import { companyFiltersFor, companyHqKeys, companyPlaceKeys, hasWords } from "./lib/aiark/company-filters.mjs";
import { cityKey } from "./lib/aiark/geo.mjs";
import { excludedTitlesFor, peopleSourceInfo, peopleSources } from "./lib/aiark/people-requests.mjs";
import { filtersFor, scopeOf, standardFor } from "./lib/aiark/standard-filters.mjs";
import {
  checkPlaces, cleanOwnInput, keywordsFor, linkedinSettingsFor, logFor, outsideRules, ownVersionOf, placeFromText, placeText,
  readLinkedinRow, readStarter, resolveLinkedin, saveLinkedinSettings, seedLinkedinRow, writeStarter,
} from "./lib/aiark/linkedin-settings.mjs";
import { EXCLUDE_PLACES_BYTES, linkedinCompanyRequests, linkedinPeopleRequests, linkedinRunFilters, linkedinTargeting } from "./lib/aiark/linkedin-requests.mjs";
import { checkSeedLayout, readSeedFile, SeedLayoutError } from "./lib/aiark/linkedin-seed.mjs";
import { createPeopleRun, PeopleRunRefused } from "./lib/aiark/people-runs.mjs";
import { flagOn, FLAGS, PEOPLE_PER_COMPANY, settingsFrom, starterFrom } from "./lib/enrich/settings.mjs";

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
  check("over the limit: the rest listed as not applied, never dropped silently",
    many.notApplied.length > 0 && many.union.every((t) => many.notApplied.includes(t) || many.sent.some((s) => hasWords(t, s))), `${many.notApplied.length} not applied`);
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
  check("a row: its version, and the saved filters' version beside it", withRow.versions.own === "row:row-v1" && withRow.version === "row:row-v1|filters:saved-v1" && ownVersionOf({ row }) === "row:row-v1");
  check("places outside the client's database area are named", withRow.outsideRules.length === 1 && withRow.outsideRules[0].city === "Farville");
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
  check("the keywords not applied are listed in the report and a note, never as 'checked after the pull'",
    pr.report.linkedin.keywords.notApplied.length === people.keywords.notApplied.length && people.keywords.notApplied.length > 0 &&
      pr.notes.some((n) => /not applied \(AI Ark limit\)/.test(n)) && !pr.notes.some((n) => n.startsWith("AI Ark's limits leave room for")));
  check("the sheet's exclusion terms are not sent: the made-up rules are the resolver's", JSON.stringify(linkedinTargeting(people).exclude_terms) === JSON.stringify(people.own.exclude_keywords));
  const companies = resolveLinkedin({ tag: "LITEST_A", kind: "companies", row, targeting: rules, starter, saved: null, clientType: "Non-Cleaning" });
  const cr = linkedinCompanyRequests({ effective: companies, geo: GEO });
  check("a company search: any office in the places, the standard sizes, industries and company types",
    cr.requests.length === 1 && cr.requests[0].account.location.any.include.includes("Farville, Yonder Vale") && Boolean(cr.requests[0].account.employeeSize) &&
      Boolean(cr.requests[0].account.industries?.any?.exclude) && JSON.stringify(cr.requests[0].account.type.any.exclude) === JSON.stringify(CLEANING_EXCLUDE_COMPANY_TYPES));
  check("a company search says head offices are judged, and names the places outside the client's area",
    cr.notes.some((n) => /head office/.test(n)) && !cr.notes.some((n) => n.startsWith("AI Ark finds a company when any of its offices is in one of these places, not only")) && cr.notes.some((n) => /outside the client's database area/.test(n)));
  const empty = linkedinCompanyRequests({ effective: { ...companies, own: { ...companies.own, include_locations: [] } }, geo: GEO });
  check("no places: blocked in LinkedIn's words, nothing sent", empty.requests.length === 0 && empty.blockers.some((b) => /LinkedIn companies settings hold no places/.test(b)));
  const longOut = Array.from({ length: 80 }, (_, i) => place(`Quuxburg Number ${i}`));
  const tooMany = linkedinCompanyRequests({ effective: { ...companies, own: { ...companies.own, exclude_locations: longOut } }, geo: GEO });
  check("excluded places over what one search holds: blocked, never cut", tooMany.requests.length === 0 && tooMany.blockers.some((b) => /to leave out are more than one AI Ark search can hold/.test(b)) && bytes(longOut.map((e) => placeText(e, GEO))) > EXCLUDE_PLACES_BYTES);
  check("the starter list not loaded: blocked", linkedinPeopleRequests({ effective: { ...noStarter, kind: "people" }, geo: GEO }).requests.length === 0);
  const kept = linkedinRunFilters(people);
  check("what a run keeps: the places, the keywords sent and not applied, the version", kept.version === people.version && kept.keywords.not_applied.length === people.keywords.notApplied.length && kept.places.length === 2 && kept.kind === "people");
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

// ── C. Builder L1 ───────────────────────────────────────────────────────────

async function partC() {
  section("C. LinkedIn company pulls, people runs, the worker, the seed (Builder L1)");
  for (const name of [
    "C1 a LinkedIn company pull: source linkedin, kind linkedin, its label; the copy by head-office keys from the LinkedIn places (hq_keys filled for old rows)",
    "C2 rows get hq_only; client_office keeps head offices in the area; a branch-only match says Outside (head office)",
    "C3 a later AI Ark pull of the same company clears hq_only and queues the row again; a company is never written twice",
    "C4 the run's filters.linkedin keeps the places, the keywords sent and not applied, the version",
    "C5 a LinkedIn people run: Look by area (demo transport), candidates without a company row, no_company",
    "C6 the pick: at most linkedin_sources.people_per_company a company, usable contacts at the company counted",
    "C7 the Buy: Export Single, the company brought in (registry, else the person's own company record), the person linked to it",
    "C8 found_by linkedin, D13's place, P#27 behind linkedin_profile_reads",
    "C9 the worker's heartbeat lists linkedin_sources",
    "C10 the seed on a made-up normalized.json: the dry run writes nothing; --apply writes, then changes nothing; a person's save kept",
    "C11 guard rails, linkedin_sources off: the AI Ark tab, company pulls, people runs, pushes and exports exactly as before 128",
  ]) later(name, "Builder L1");
}

// ── R. Builder L2 ───────────────────────────────────────────────────────────

async function partR() {
  // Builder L2: the routes and what the page and the Companies tab show. Everything here is
  // committed through the routes, so it is removed again in the finally below (clients, rows,
  // runs, tables, the made-up cities and originals) and every setting is put back as it was.
  section("R. The routes (Builder L2)");
  const { seedFixtureVariant } = await import("./fixtures/test-support.mjs");
  const { LINKEDIN_FLAGS } = await import("./lib/aiark/linkedin-settings.mjs");
  const routes = {
    li: await route("aiark/linkedin-settings"),
    count: await route("companies/count"),
    runs: await route("companies/runs"),
    setup: await route("companies/setup"),
    settings: await route("companies/settings"),
    peopleRuns: await route("companies/people/runs"),
    peopleSetup: await route("companies/people/setup"),
  };
  const serverLib = await srcModule("lib/companies/server.ts");
  const heartbeat = ({ online = true, linkedin = true } = {}) => ({
    id: "litest", last_seen: new Date().toISOString(), started_at: new Date().toISOString(), seconds_ago: online ? 2 : 600, online,
    info: { capabilities: ["company_runs", "pipeline_v2", "people_runs", "fit_scoring", ...(linkedin ? ["linkedin_sources"] : [])], keys: {}, reoon: null },
  });
  const inTx = async (fn) => {
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
  };
  const settingsAtStart = await all(`SELECT key, value FROM enrich_settings ORDER BY key`);
  const stored = Object.fromEntries(settingsAtStart.map((r) => [r.key, r.value]));
  const setSetting = (key, value) => pool.query(`UPDATE enrich_settings SET value = $2 WHERE key = $1`, [key, JSON.stringify(value)]);
  const restoreSettings = async () => {
    for (const r of settingsAtStart) await setSetting(r.key, r.value);
  };
  /** The three switches as they were (the starter list written below stays). */
  const resetSwitches = async () => {
    for (const r of settingsAtStart) if (["company_pipeline", "people_pipeline", "linkedin_sources"].includes(r.key)) await setSetting(r.key, r.value);
  };
  /** Company pulls, people runs and the LinkedIn searches on or off, each with its client list. */
  const switches = async ({ cp = true, pp = true, ls = true, tags = [], lsTags = tags } = {}) => {
    await setSetting("company_pipeline", { ...stored.company_pipeline, enabled: cp, tags });
    await setSetting("people_pipeline", { ...stored.people_pipeline, enabled: pp, tags });
    await setSetting("linkedin_sources", { ...stored.linkedin_sources, enabled: ls, tags: lsTags });
  };
  const made = { geo: [], variants: [] };
  const tags = { norow: tagOf("R_NOROW"), row: tagOf("R_ROW"), norules: tagOf("R_NORULES"), empty: tagOf("R_EMPTY"), save: tagOf("R_SAVE") };
  const get = (query) => call(routes.li.GET, { query });
  const put = (body) => call(routes.li.PUT, { body });
  const preview = (body) => call(routes.li.POST, { body });
  try {
    // Made-up cities in a state that exists, so typed places resolve as they would in production.
    const st = await one(`SELECT country_code, admin1_code, state_code, name FROM geo_admin1 WHERE country_code = 'US' ORDER BY state_code LIMIT 1`);
    const CITY = { kept: "Quuxford", rule: "Zorbleton", out: "Vrillport" };
    let gid = 9_990_100_000;
    for (const [city, population] of [[CITY.kept, 500], [CITY.rule, 400], [CITY.out, 300]]) {
      await pool.query(
        `INSERT INTO geo_locations (geoname_id, city, city_key, country_code, admin1_code, population) VALUES ($1, $2, $3, $4, $5, $6)`,
        [gid, city, cityKey(city), st.country_code, st.admin1_code, population]
      );
      made.geo.push(gid++);
    }
    const at = (city) => place(city, st.state_code);
    const txt = (city) => (city ? `${city}, ${st.name}` : st.name);
    const geo = await loadGeo(pool);

    // A no-row client (its rules and the starter list), a seeded client (both kinds), a client with no
    // rules, one whose own places all lie outside its rules, and one for the saves.
    await makeClient(pool, tags.norow, { type: "OS", places: [at(CITY.kept), at(CITY.rule)], terms: ["quux sheet term"] });
    await makeClient(pool, tags.row, { type: "Cleaning", places: [at(CITY.kept), at(CITY.rule)] });
    await makeClient(pool, tags.norules, { type: "Cleaning", places: null });
    await makeClient(pool, tags.empty, { type: "Cleaning", places: [at(CITY.kept)] });
    await makeClient(pool, tags.save, { type: "OS", places: [at(CITY.kept)] });
    await writeStarter(pool, { items: ["quux diner", "quux kiosk"], version: 1, source: "made up", sha256: "a".repeat(64) });
    const seed = (tag, kind, value) =>
      inTx((c) =>
        seedLinkedinRow(c, {
          tag, kind, geo, sha256: "b".repeat(64), seededBy: "litest@host",
          value: { include_locations: [], exclude_locations: [], unplaced: [], exclude_keywords: [], notes: [], flags: [], copied_from: null, ...value },
          provenance: { clay_source_id: "t_litest", clay_campaign: "Made-up campaign", clay_set_up_at: "2026-07-01T00:00:00.000Z", clay_fingerprint: null },
        })
      );
    const rowPlaces = [at(CITY.kept), at(CITY.out), at(null)]; // a city the rules hold, one they don't, the whole state
    const seeded = [
      await seed(tags.row, "companies", {
        include_locations: rowPlaces, exclude_keywords: ownWords(120), flags: ["company_list"], notes: ["A made-up note."],
        unplaced: [{ side: "include", field: "cities", value: "Quux Heights", why: "made up: not a city of the listed state", suggestions: [at(CITY.kept)] }],
      }),
      await seed(tags.row, "people", { include_locations: rowPlaces, exclude_keywords: ["quuxable diner"] }),
      await seed(tags.norules, "companies", { include_locations: [at(CITY.out)], exclude_keywords: ["quuxable diner"] }),
      await seed(tags.empty, "companies", { include_locations: [at(CITY.out)], exclude_keywords: ["quuxable diner"] }),
    ];
    if (seeded.some((x) => x.status !== "written")) throw new Error(`R fixtures not seeded: ${JSON.stringify(seeded)}`);
    // O1 and O2 are the engine's (Builder L1): the checks that need them wait until its resolver has them.
    const probe = await linkedinSettingsFor(pool, { tag: tags.row, kind: "companies" });
    const o1 = Array.isArray(probe.keywords.checkedAfter);
    const o2 = Boolean(probe.area && Array.isArray(probe.area.notSearched) && Array.isArray(probe.area.sent));
    T.worker = heartbeat();

    section("R1. GET /api/aiark/linkedin-settings");
    await resetSwitches(); // as shipped: the LinkedIn searches off
    T.role = null;
    const unauth = await get({ tag: tags.norow });
    T.role = "viewer";
    const viewer = await get({ tag: tags.norow });
    T.role = "manager";
    check("below manager: 401 signed out, 403 for a viewer", unauth.status === 401 && viewer.status === 403);
    const nr = await get({ tag: tags.norow });
    const np = nr.body.people;
    check("a client with no row, the switch off: both kinds, its rules' places and the starter keywords",
      nr.status === 200 && nr.body.switch?.enabled === false && np?.from === "rules_and_starter" && nr.body.companies?.from === "rules_and_starter" &&
        JSON.stringify(np.own.include_locations.map((p) => p.text)) === JSON.stringify([txt(CITY.kept), txt(CITY.rule)]) &&
        JSON.stringify(np.own.exclude_keywords) === JSON.stringify(["quux diner", "quux kiosk"]),
      JSON.stringify(nr.body).slice(0, 400));
    check("... the standard filters, read only, for a client that is not Cleaning; a plan with no blocker",
      np.standard.from === "cleaning" && np.standard.titles > 0 && np.standard.excludeTitles > 0 && np.standard.companyTypes.length === 2 &&
        np.standard.keywords.length > 0 && np.plan.searches >= 1 && np.plan.blockers.length === 0 && np.starter.loaded === true, JSON.stringify(np.plan));
    check("... the version a save sends back, and the one a count or run sends back", typeof np.version === "string" && np.version.startsWith("rules:") && np.searchVersion.startsWith(np.version));
    const onlyPeople = await get({ tag: tags.norow, kind: "people" });
    check("kind=people: that kind only", onlyPeople.status === 200 && Boolean(onlyPeople.body.people) && !onlyPeople.body.companies);
    check("a bad kind or tag: 400; a tag that is no client: 404",
      (await get({ tag: tags.norow, kind: "jobs" })).status === 400 && (await get({ tag: "not a tag!" })).status === 400 && (await get({ tag: tagOf("R_NOBODY") })).status === 404);
    const rc = (await get({ tag: tags.row })).body.companies;
    check("a seeded row: its own lists, where they came from, the flags in plain words, the values not placed with their suggestions, the log",
      rc?.from === "row" && rc.provenance.source === "clay" && rc.provenance.clay?.campaign === "Made-up campaign" && rc.provenance.flagWords.company_list === LINKEDIN_FLAGS.company_list &&
        rc.provenance.notes[0] === "A made-up note." && rc.own.unplaced[0]?.suggestionTexts[0] === txt(CITY.kept) && rc.own.exclude_keywords.length === 120 &&
        rc.log[0]?.action === "seed" && rc.log[0].seededBy === "litest@host" && rc.log[0].after.keywords === 120 && rc.log[0].before === null,
      JSON.stringify(rc?.provenance));

    section("R2. PUT and the preview POST");
    const S = tags.save;
    const rowsOf = async (tag) => (await one(`SELECT count(*)::int AS n FROM client_linkedin_settings WHERE client_tag = $1`, [tag])).n;
    const logsOf = async (tag) => (await one(`SELECT count(*)::int AS n FROM client_linkedin_settings_log WHERE client_tag = $1`, [tag])).n;
    const loaded = (await get({ tag: S, kind: "people" })).body.people;
    const value = (o = {}) => ({ include_locations: [txt(CITY.kept), txt(CITY.rule)], exclude_locations: [], unplaced: [], exclude_keywords: ["quux diner", "Quux Kiosk", "quux zorbatorium"], ...o });
    T.role = "viewer";
    check("below manager: the save and the preview refused (403)",
      (await put({ tag: S, kind: "people", value: value(), version: loaded.version })).status === 403 && (await preview({ tag: S, kind: "people", value: value() })).status === 403);
    T.role = "manager";
    T.audits.length = 0;
    const pv = await preview({ tag: S, kind: "people", value: value({ include_locations: [txt(CITY.kept), `Nowhereville, ${st.name}`] }) });
    check("the preview: the plan and keywords of lists not saved, each refusal named, nothing written",
      pv.status === 200 && pv.body.plan.searches >= 1 && pv.body.errors.some((e) => /Nowhereville/.test(e)) && pv.body.keywords.union > 3 &&
        (await rowsOf(S)) === 0 && (await logsOf(S)) === 0, JSON.stringify(pv.body).slice(0, 300));
    const stale = await put({ tag: S, kind: "people", value: value(), version: "rules:old|starter:old" });
    check("a stale version: 409 with changed, nothing saved", stale.status === 409 && stale.body.changed === true && (await rowsOf(S)) === 0, JSON.stringify(stale.body));
    const badPlace = await put({ tag: S, kind: "people", value: value({ include_locations: [`Nowhereville, ${st.name}`] }), version: loaded.version });
    const badWord = await put({ tag: S, kind: "people", value: value({ exclude_keywords: ["x".repeat(121)] }), version: loaded.version });
    check("bad lists: 400 with each reason, nothing saved",
      badPlace.status === 400 && badPlace.body.errors?.some((e) => /Nowhereville/.test(e)) && badWord.status === 400 && /over 120 characters/.test(badWord.body.error) && (await rowsOf(S)) === 0,
      JSON.stringify([badPlace.body, badWord.body]).slice(0, 300));
    check("a tag that is no client: 404; no version: 400; a bad kind: 400",
      (await put({ tag: tagOf("R_NOBODY"), kind: "people", value: value(), version: "x" })).status === 404 && (await put({ tag: S, kind: "people", value: value() })).status === 400 &&
        (await put({ tag: S, kind: "jobs", value: value(), version: loaded.version })).status === 400);
    const first = await put({ tag: S, kind: "people", value: value(), version: loaded.version });
    check("the first save makes the client's own row from what was shown and edited",
      first.status === 200 && first.body.saved === true && first.body.view.from === "row" && first.body.view.provenance.source === "manual" &&
        first.body.view.own.exclude_keywords.length === 3 && (await rowsOf(S)) === 1 && (await logsOf(S)) === 1, JSON.stringify(first.body).slice(0, 300));
    const audit = T.audits.find((a) => a.action === "linkedin_settings");
    check("... one audit line, with counts only (no place, no keyword)",
      T.audits.length === 1 && Boolean(audit) && new RegExp(`^${S} people: 2 places, 0 left out, 0 unplaced, 3 keywords$`).test(audit.details) &&
        ![CITY.kept, CITY.rule, "quux", "kiosk"].some((w) => audit.details.toLowerCase().includes(w.toLowerCase())), JSON.stringify(T.audits));
    const same = await put({ tag: S, kind: "people", value: value(), version: first.body.view.version });
    check("a save that changes nothing: 200, nothing written or logged, no audit line",
      same.status === 200 && same.body.unchanged === true && same.body.saved === false && (await logsOf(S)) === 1 && T.audits.length === 1);
    const changed = await put({ tag: S, kind: "people", value: value({ exclude_keywords: ["quux diner"] }), version: first.body.view.version });
    const log0 = changed.body.view?.log?.[0];
    check("a change: logged, and the page's log shows the counts before and after",
      changed.status === 200 && changed.body.saved === true && log0?.action === "save" && log0.before.keywords === 3 && log0.after.keywords === 1 && (await logsOf(S)) === 2);
    check("... the other kind is untouched (its own row only when it is saved)", (await get({ tag: S, kind: "companies" })).body.companies.from === "rules_and_starter");
    const rp = (await get({ tag: tags.row, kind: "companies" })).body.companies;
    const addedUnplaced = await put({
      tag: tags.row, kind: "companies", version: rp.version,
      value: { include_locations: rp.own.include_locations.map((p) => p.entry), exclude_locations: [], exclude_keywords: rp.own.exclude_keywords,
        unplaced: [...rp.own.unplaced.map((u) => ({ side: u.side, field: u.field, value: u.value, why: u.why, suggestions: u.suggestions })), { side: "include", field: "cities", value: "Quux Made Up", why: "x", suggestions: [] }] },
    });
    check("a value not placed can be kept or removed, never added: 400", addedUnplaced.status === 400 && /kept or removed, not added/.test(addedUnplaced.body.error ?? ""), JSON.stringify(addedUnplaced.body));

    section("R3. LinkedIn counts and pulls: POST /api/companies/count and /runs with source linkedin");
    const R = tags.row;
    made.variants.push(await seedFixtureVariant(pool, R));
    const plan = async (tag = R) => (await call(routes.setup.GET, { query: { tag } })).body.linkedin;
    const count = (body, tag = R) => call(routes.count.POST, { body: { tag, mode: "demo", source: "linkedin", ...body } });
    const pull = (body) => call(routes.runs.POST, { body: { tag: R, mode: "demo", size: 5, matchCount: 10, source: "linkedin", ...body } });
    let li = await plan();
    await switches({ cp: true, pp: true, ls: false, tags: [R] });
    let r = await count({ linkedinVersion: li.version });
    check("LinkedIn searches off: 409, nothing counted", r.status === 409 && /LinkedIn searches are off/.test(r.body.error), JSON.stringify(r.body));
    r = await pull({ linkedinVersion: li.version });
    check("... and nothing pulled (409)", r.status === 409 && /LinkedIn searches are off/.test(r.body.error), JSON.stringify(r.body));
    await switches({ cp: false, pp: true, ls: true, tags: [R] });
    r = await count({ linkedinVersion: li.version });
    check("company pulls off: 409 (a LinkedIn company search needs them)", r.status === 409 && /Company pulls are off/.test(r.body.error));
    await switches({ cp: true, pp: true, ls: true, tags: [R], lsTags: [] });
    r = await count({ linkedinVersion: li.version });
    check("the client not on the LinkedIn searches' list: 409", r.status === 409 && /not on the LinkedIn searches' client list/.test(r.body.error));
    r = await pull({ linkedinVersion: li.version });
    check("... and its pull: 409", r.status === 409 && /not on the LinkedIn searches' client list/.test(r.body.error));
    await switches({ cp: true, pp: true, ls: true, tags: [R] });
    li = await plan();
    r = await count({ linkedinVersion: "row:old|filters:none" });
    check("its LinkedIn search changed since the page loaded it: 409 with changed", r.status === 409 && r.body.changed === true, JSON.stringify(r.body));
    check("a source that is not one: 400", (await count({ source: "clay" })).status === 400 && (await pull({ source: "clay" })).status === 400);
    r = await count({ linkedinVersion: li.version });
    check("the count: the LinkedIn search's companies (demo), with its source and the version it counted",
      r.status === 200 && r.body.source === "linkedin" && r.body.linkedinVersion === li.version && r.body.total > 0 && r.body.perSearch.length === li.searches, JSON.stringify(r.body).slice(0, 300));
    const aiark = await call(routes.count.POST, { body: { tag: R, mode: "demo" } });
    check("an AI Ark count's answer is as before 128 (no source, no LinkedIn version)", aiark.status === 200 && !("source" in aiark.body) && !("linkedinVersion" in aiark.body));
    T.worker = heartbeat({ linkedin: false });
    r = await pull({ linkedinVersion: li.version });
    check("a worker that doesn't do LinkedIn searches: 409", r.status === 409 && /doesn't do LinkedIn searches/.test(r.body.error), JSON.stringify(r.body));
    T.worker = heartbeat();
    const going = await one(`INSERT INTO aiark_company_runs (client_tag, mode, size_requested, filters, requests, source) VALUES ($1, 'demo', 1, '{}', '[{}]', 'ai_ark') RETURNING id`, [R]);
    r = await pull({ linkedinVersion: li.version });
    check("one pull per client, of either source: an AI Ark pull going refuses a LinkedIn one (409)", r.status === 409 && /already has a company pull going/.test(r.body.error));
    await pool.query(`DELETE FROM aiark_company_runs WHERE id = $1`, [going.id]);
    r = await pull({ linkedinVersion: "row:old|filters:none" });
    check("... a changed LinkedIn search: 409 with changed", r.status === 409 && r.body.changed === true);
    r = await pull({ linkedinVersion: li.version });
    if (r.status === 409 && /can't make LinkedIn company pulls yet/.test(r.body.error ?? "")) {
      check("an engine that can't make a LinkedIn pull: refused (409), nothing written", (await one(`SELECT count(*)::int AS n FROM aiark_company_runs WHERE client_tag = $1`, [R])).n === 0);
      later("the pull: 201, source linkedin, filters.linkedin with its version, listed with its source", "Builder L1: createCompanyRun's source and targeting");
      later("O1: the pull keeps keywords.sent and keywords.checked_after in filters.linkedin", "Builder L1");
    } else {
      const row = r.body.run ? await one(`SELECT source, filters FROM aiark_company_runs WHERE id = $1`, [r.body.run.id]) : null;
      check("the pull: 201, source linkedin, filters.linkedin with the version it was asked with",
        r.status === 201 && r.body.run.source === "linkedin" && row?.source === "linkedin" && row.filters.linkedin?.version === li.version && row.filters.linkedin_version === li.version,
        JSON.stringify(r.body).slice(0, 300));
      const listed = await call(routes.runs.GET, { query: { tag: R } });
      check("... the pulls list shows its source", listed.body.runs.some((x) => x.id === r.body.run?.id && x.source === "linkedin"));
      if (o1) {
        check("O1: the pull keeps keywords.sent and keywords.checked_after in filters.linkedin",
          Array.isArray(row?.filters.linkedin?.keywords?.sent) && Array.isArray(row?.filters.linkedin?.keywords?.checked_after) && row.filters.linkedin.keywords.checked_after.length > 0);
      } else later("O1: the pull keeps keywords.sent and keywords.checked_after in filters.linkedin", "Builder L1: O1 in linkedinRunFilters");
      const again = await pull({ linkedinVersion: li.version });
      check("... a second pull while it is queued: 409", again.status === 409 && /already has a company pull going/.test(again.body.error));
      await pool.query(`UPDATE aiark_company_runs SET status = 'cancelled', finished_at = now() WHERE client_tag = $1 AND status IN ('queued', 'running')`, [R]);
    }
    const sc0 = (await call(routes.setup.GET, { query: { tag: R } })).body;
    const ai = await call(routes.runs.POST, { body: { tag: R, mode: "demo", size: 5, matchCount: 10, rulesVersion: sc0.targeting.version, filtersVersion: sc0.filters.version } });
    check("a pull with no source is an AI Ark pull, as before 128", ai.status === 201 && ai.body.run.source === "ai_ark", JSON.stringify(ai.body).slice(0, 300));
    await pool.query(`UPDATE aiark_company_runs SET status = 'cancelled', finished_at = now() WHERE client_tag = $1 AND status IN ('queued', 'running')`, [R]);

    section("R4. LinkedIn people runs: POST /api/companies/people/runs with source linkedin (409s, not the 400 of before 128)");
    const pli = (await call(routes.peopleSetup.GET, { query: { tag: R } })).body.linkedin;
    const prun = (body) => call(routes.peopleRuns.POST, { body: { tag: R, mode: "demo", source: "linkedin", maxPeople: 5, linkedinVersion: pli.version, ...body } });
    await switches({ cp: true, pp: false, ls: true, tags: [R] });
    r = await prun({});
    check("people runs off: 409", r.status === 409 && /People runs are off/.test(r.body.error), JSON.stringify(r.body));
    await switches({ cp: true, pp: true, ls: true, tags: [], lsTags: [R] });
    r = await prun({});
    check("the client not on the people runs' list: 409", r.status === 409 && /not on the people runs' client list/.test(r.body.error));
    await switches({ cp: true, pp: true, ls: false, tags: [R] });
    r = await prun({});
    check("LinkedIn searches off: 409", r.status === 409 && /LinkedIn searches are off/.test(r.body.error));
    await switches({ cp: true, pp: true, ls: true, tags: [R], lsTags: [] });
    r = await prun({});
    check("the client not on the LinkedIn searches' list: 409", r.status === 409 && /not on the LinkedIn searches' client list/.test(r.body.error));
    await switches({ cp: true, pp: true, ls: true, tags: [R] });
    T.worker = heartbeat({ linkedin: false });
    r = await prun({});
    check("a worker that doesn't do LinkedIn searches: 409", r.status === 409 && /doesn't do LinkedIn searches/.test(r.body.error));
    T.worker = heartbeat();
    r = await prun({ linkedinVersion: "row:old|filters:none" });
    check("its LinkedIn search changed: 409 with changed", r.status === 409 && r.body.changed === true, JSON.stringify(r.body));
    const goingRun = await one(`INSERT INTO aiark_people_runs (client_tag, mode, max_people, filters, source) VALUES ($1, 'demo', 1, '{}', 'ai_ark') RETURNING id`, [R]);
    r = await prun({});
    check("a people run of either source going for the client: 409", r.status === 409 && /already has a people run going/.test(r.body.error));
    await pool.query(`DELETE FROM aiark_people_runs WHERE id = $1`, [goingRun.id]);
    try {
      process.env.AIARK_DEMO_CREDITS = "100";
      r = await prun({});
    } finally {
      delete process.env.AIARK_DEMO_CREDITS;
    }
    check("AI Ark's balance under the people runs' minimum: 409, read free", r.status === 409 && /under the people runs' minimum/.test(r.body.error), JSON.stringify(r.body));
    check("a source that is not one: still 400", (await prun({ source: "clay" })).status === 400);
    r = await prun({});
    if (r.status === 409 && /not built yet/.test(r.body.error ?? "")) {
      check("the engine without its by-area path refuses (409), nothing written", (await one(`SELECT count(*)::int AS n FROM aiark_people_runs WHERE client_tag = $1`, [R])).n === 0);
      later("a LinkedIn people run starts: 201, source linkedin, no Companies table or tracks needed first", "Builder L1: createPeopleRun's by-area path");
    } else {
      check("a LinkedIn people run starts: 201, source linkedin", r.status === 201 && r.body.run?.source === "linkedin", JSON.stringify(r.body).slice(0, 300));
    }

    section("R5. The settings sheet: linkedin_sources");
    await resetSwitches();
    T.role = "manager";
    check("managers can't read or save the settings (403)", (await call(routes.settings.GET)).status === 403);
    T.role = "admin";
    const got = await call(routes.settings.GET);
    const input = serverLib.settingsInputOf(got.body.value);
    const lsNow = got.body.value?.linkedin_sources;
    check("the settings carry the LinkedIn switch, its client list and the people a company",
      got.status === 200 && typeof lsNow?.enabled === "boolean" && Array.isArray(lsNow.tags) && Number.isInteger(lsNow.people_per_company) &&
        JSON.stringify(input.linkedin_sources) === JSON.stringify(lsNow), JSON.stringify(lsNow));
    const edit = (body, f) => {
      const x = structuredClone(serverLib.settingsInputOf(body.value));
      f(x);
      return { body: { version: body.version, ...x } };
    };
    for (const [label, f, re] of [
      ["people a company out of range: 400", (x) => { x.linkedin_sources.people_per_company = 0; }, /People a company \(LinkedIn people runs\) must be a whole number from 1 to 100/],
      ["a client list with something that is not a tag: 400", (x) => { x.linkedin_sources.tags = ["not a tag!"]; }, /LinkedIn searches: not a tag! is not a client tag/],
      ["a switch that is not on or off: 400", (x) => { x.linkedin_sources.enabled = "yes"; }, /LinkedIn searches must be on or off/],
      ["not the block's shape: 400", (x) => { x.linkedin_sources = [1]; }, /LinkedIn searches: must be the switch/],
    ]) {
      const bad = await call(routes.settings.PUT, edit(got.body, f));
      check(label, bad.status === 400 && re.test(bad.body.error ?? ""), `${bad.status} ${bad.body.error ?? ""}`);
    }
    const lsRow = async () => one(`SELECT value, updated_at::text AS at FROM enrich_settings WHERE key = 'linkedin_sources'`);
    const lsBefore = await lsRow();
    const keep = await call(routes.settings.PUT, edit(got.body, (x) => {
      delete x.linkedin_sources;
      x.people_pipeline.max_people_per_run = x.people_pipeline.max_people_per_run === 299 ? 298 : 299;
    }));
    const lsKept = await lsRow();
    check("a save without linkedin_sources keeps it as stored, not written",
      keep.status === 200 && keep.body.changes?.some((c) => c.startsWith("most people a run")) && JSON.stringify(lsKept.value) === JSON.stringify(lsBefore.value) && lsKept.at === lsBefore.at,
      JSON.stringify(keep.body.changes ?? keep.body));
    const now2 = await call(routes.settings.GET);
    const L = tagOf("R_SHEET");
    const ppc = now2.body.value.linkedin_sources.people_per_company === 8 ? 9 : 8;
    T.audits.length = 0;
    const saved = await call(routes.settings.PUT, edit(now2.body, (x) => {
      x.linkedin_sources = { enabled: true, tags: [` ${L.toLowerCase()} `, L], people_per_company: ppc };
    }));
    const lsSaved = (await lsRow()).value;
    check("a save of the LinkedIn block: each change listed, and logged",
      saved.status === 200 && saved.body.changes.includes("LinkedIn searches off to on") && saved.body.changes.includes(`LinkedIn searches' clients no client to ${L}`) &&
        saved.body.changes.includes(`people a company (LinkedIn) ${now2.body.value.linkedin_sources.people_per_company} to ${ppc}`) && T.audits.some((a) => a.action === "enrich_settings"),
      JSON.stringify(saved.body.changes ?? saved.body));
    check("... tags upper case, once each, and the worker reads it",
      lsSaved.enabled === true && JSON.stringify(lsSaved.tags) === JSON.stringify([L]) && lsSaved.people_per_company === ppc &&
        settingsFrom(await all(`SELECT key, value FROM enrich_settings`)).flagOn("linkedin_sources", L));
    T.role = "manager";
    await resetSwitches();

    section("R6. The setup routes' LinkedIn plans");
    T.worker = heartbeat();
    const sc = (await call(routes.setup.GET, { query: { tag: R } })).body;
    const eff = await linkedinSettingsFor(pool, { tag: R, kind: "companies" });
    check("GET /api/companies/setup: the LinkedIn company search, its switch (off), counts and version",
      sc.linkedin?.kind === "companies" && sc.linkedin.version === eff.version && sc.linkedin.from === "row" && sc.linkedin.switch.enabled === false &&
        sc.linkedin.places === 3 && sc.linkedin.unplaced === 1 && sc.linkedin.searches >= 1 && sc.linkedin.keywords.union === eff.keywords.union.length && sc.linkedin.keywords.checkedAfter > 0,
      JSON.stringify(sc.linkedin));
    check("... the worker's LinkedIn capability, and without it", sc.worker?.linkedin === true &&
      await (async () => {
        T.worker = heartbeat({ linkedin: false });
        const w = (await call(routes.setup.GET, { query: { tag: R } })).body.worker;
        T.worker = heartbeat();
        return w?.linkedin === false;
      })());
    check("... no client picked: no LinkedIn plan", (await call(routes.setup.GET)).body.linkedin === null);
    const ps = (await call(routes.peopleSetup.GET, { query: { tag: tags.norow } })).body;
    check("GET /api/companies/people/setup: the LinkedIn people search (a client with no row: rules and starter)",
      ps.linkedin?.kind === "people" && ps.linkedin.from === "rules_and_starter" && ps.linkedin.places === 2 && ps.linkedin.keywords.union >= 2 && ps.linkedin.searches >= 1,
      JSON.stringify(ps.linkedin));

    section("R7. O1 and O2 as the page and the routes show them");
    // How the page reads the engine's answer, on a made-up one (the made-up geo of part A): the
    // resolver's area (O2) and keywords.checkedAfter (O1), whatever Builder L1's engine has yet.
    const view = await srcModule("lib/linkedin/server.ts");
    const base = resolveLinkedin({
      tag: "LITEST_SIM", kind: "companies", targeting: { include_locations: [place("Quuxville"), place("Barville")], version: "r" }, saved: null, clientType: "OS",
      starter: { items: [], version: 1, updatedAt: "s", loaded: true }, row: { client_tag: "LITEST_SIM", kind: "companies", include_locations: [place("Quuxville"), place("Farville"), place(null)],
        exclude_locations: [], unplaced: [], exclude_keywords: ownWords(120), version: "v" },
    });
    const sim = view.areaView({ ...base, area: { sent: [place("Quuxville"), place("Barville")], notSearched: [place("Farville")] } }, GEO);
    check("the page reads O2 from the resolver's area: places sent, not searched, and the state searched as the rules' places inside it",
      JSON.stringify(sim.placesSent.map((p) => p.text)) === JSON.stringify(["Quuxville, Zedland", "Barville, Zedland"]) &&
        JSON.stringify(sim.notSearched.map((p) => p.text)) === JSON.stringify(["Farville, Zedland"]) &&
        sim.narrowed.length === 1 && sim.narrowed[0].entry.text === "Zedland" && sim.narrowed[0].into.length === 2, JSON.stringify(sim));
    const noArea = view.areaView(base, GEO);
    check("... an engine without O2 sends the own places as they are (nothing narrowed)", noArea.placesSent.length === 3 && noArea.narrowed.length === 0);
    check("the page reads O1's list from keywords.checkedAfter, and from notApplied before it",
      JSON.stringify(view.checkedAfterOf({ ...base, keywords: { ...base.keywords, checkedAfter: ["quux one"] } })) === JSON.stringify(["quux one"]) &&
        JSON.stringify(view.checkedAfterOf(base)) === JSON.stringify(base.keywords.notApplied ?? base.keywords.checkedAfter) && view.checkedAfterOf(base).length > 0);
    const rv = (await get({ tag: R, kind: "companies" })).body.companies;
    check("O1: the keywords AI Ark's request can't hold are listed, to be checked after the pull, none dropped",
      rv.keywords.checkedAfter.length > 0 && rv.keywords.union === CLEANING_EXCLUDE_KEYWORDS.length + 120 && rv.keywords.checkedAfter.every((k) => rv.own.exclude_keywords.includes(k)));
    if (o1) {
      const texts = [...rv.plan.notes, ...(await plan()).notes, ...(await preview({ tag: R, kind: "companies", value: { include_locations: rv.own.include_locations.map((p) => p.entry), exclude_locations: [], unplaced: [], exclude_keywords: rv.own.exclude_keywords } })).body.plan.notes];
      check("O1: nothing on the page or the Companies tab says 'not applied'", !texts.some((n) => /not applied/i.test(n)), texts.join(" | ").slice(0, 300));
    } else later("O1: nothing on the page or the Companies tab says 'not applied'", "Builder L1: O1's list and notes in the resolver and builders");
    if (o2) {
      check("O2: a city the rules cover is searched; the state they don't cover is searched as the rules' cities inside it",
        JSON.stringify(rv.placesSent.map((p) => p.text)) === JSON.stringify([txt(CITY.kept), txt(CITY.rule)]) && rv.narrowed.length === 1 && rv.narrowed[0].entry.text === txt(null) &&
          JSON.stringify(rv.narrowed[0].into.map((p) => p.text)) === JSON.stringify([txt(CITY.kept), txt(CITY.rule)]), JSON.stringify([rv.placesSent, rv.narrowed]));
      check("O2: a city outside the rules is not searched, and listed", JSON.stringify(rv.notSearched.map((p) => p.text)) === JSON.stringify([txt(CITY.out)]), JSON.stringify(rv.notSearched));
      const sp = await plan();
      check("O2: the Companies tab counts the same", sp.placesSent === 2 && sp.notSearched === 1 && sp.narrowed === 1 && sp.places === 3, JSON.stringify(sp));
      const nrv = (await get({ tag: tags.norules, kind: "companies" })).body.companies;
      check("O2: a client whose rules hold no places is not narrowed", nrv.rules.places === 0 && nrv.notSearched.length === 0 && nrv.placesSent.length === 1 && nrv.plan.blockers.length === 0);
      const ev = (await get({ tag: tags.empty, kind: "companies" })).body.companies;
      check("O2: nothing left inside the rules: blocked, with the reason, never a search without places",
        ev.placesSent.length === 0 && ev.notSearched.length === 1 && ev.plan.searches === 0 && ev.plan.blockers.length > 0, JSON.stringify(ev.plan));
      await switches({ cp: true, pp: true, ls: true, tags: [tags.empty] });
      const evc = await count({ linkedinVersion: ev.searchVersion }, tags.empty);
      check("... and its count: 400 with that reason, nothing counted", evc.status === 400 && evc.body.error === ev.plan.blockers.join(" "), JSON.stringify(evc.body));
      await resetSwitches();
    } else {
      for (const name of [
        "O2: a city the rules cover is searched; the state they don't cover is searched as the rules' cities inside it",
        "O2: a city outside the rules is not searched, and listed",
        "O2: the Companies tab counts the same",
        "O2: a client whose rules hold no places is not narrowed",
        "O2: nothing left inside the rules: blocked, with the reason (the count too)",
      ]) later(name, "Builder L1: O2's narrowing in the resolver (effective.area)");
    }
    const after = await all(`SELECT client_tag, kind, include_locations FROM client_linkedin_settings WHERE client_tag = ANY($1::text[]) ORDER BY client_tag, kind`, [[tags.row, tags.norules, tags.empty]]);
    // jsonb keeps its own key order, so entries are compared part by part, in list order.
    const canon = (list) => JSON.stringify(list.map((e) => [e.country, e.state ?? null, e.city ?? null]));
    check("the stored lists never change for a view, a count or a pull",
      after.length === 4 && after.filter((x) => x.client_tag === R).every((x) => canon(x.include_locations) === canon(rowPlaces)) &&
        after.filter((x) => x.client_tag !== R).every((x) => canon(x.include_locations) === canon([at(CITY.out)])), JSON.stringify(after));
  } finally {
    T.role = "manager";
    T.worker = null;
    delete process.env.AIARK_DEMO_CREDITS;
    const runIds = (await all(`SELECT id FROM aiark_company_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((x) => x.id);
    await pool.query(`DELETE FROM aiark_companies WHERE run_id = ANY($1::uuid[])`, [runIds]);
    await pool.query(`DELETE FROM aiark_company_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
    const peopleRunIds = (await all(`SELECT id FROM aiark_people_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((x) => x.id);
    await pool.query(`DELETE FROM aiark_people WHERE people_run_id = ANY($1::uuid[])`, [peopleRunIds]);
    await pool.query(`DELETE FROM aiark_people_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
    const tables = (await all(`SELECT id FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX])).map((x) => x.id);
    await pool.query(`DELETE FROM enrich_memory WHERE starts_with(client_tag, $1) OR table_id = ANY($2::uuid[])`, [PREFIX, tables]);
    await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
    await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tables]).catch(() => {});
    for (const v of made.variants) await pool.query(`DELETE FROM enrich_originals WHERE variant = $1`, [v]);
    await pool.query(`DELETE FROM geo_locations WHERE geoname_id = ANY($1::bigint[])`, [made.geo]);
    await restoreSettings();
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
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
const t0 = Date.now();
const settingsBefore = JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`));
try {
  await cleanup();
  partA();
  const geo = await loadGeo(pool);
  await partB(geo);
  await partC();
  await partR();
  section("Z. Nothing left the machine");
  check("nothing tried to reach any address", net.refused === 0, `${net.refused} refused`);
  check("no test address reached leads", (await one(`SELECT count(*)::int AS n FROM leads WHERE email LIKE $1`, [`%.${TEST_HOST}`])).n === 0);
} catch (e) {
  failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const leftover = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE starts_with(tag, $1)) AS clients,
            (SELECT count(*)::int FROM client_linkedin_settings WHERE starts_with(client_tag, $1)) AS rows,
            (SELECT count(*)::int FROM geo_locations WHERE geoname_id >= 9990000000) AS cities`,
    [PREFIX]
  );
  const settingsBack = JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`)) === settingsBefore;
  const clean = Object.values(leftover).every((n) => n === 0) && settingsBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...leftover, settingsBack })}`}`);
  console.log(`${passed} passed, ${failed} failed${pending ? `, ${pending} waiting for their builder` : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(failed || !clean ? 1 : 0);
}
