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
