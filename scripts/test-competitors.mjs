#!/usr/bin/env node
// Checks for the built-in competitors list in AI Ark searches (2026-11-21,
// scripts/lib/aiark/competitors.mjs). LOCAL DATABASE ONLY: it makes the
// made-up clients NKTEST_A (type Cleaning) and NKTEST_B (another type), their
// rules, demo pulls and a hand-made company pull, and removes all of it at the
// end. The built-in list itself is only changed inside transactions that are
// rolled back, so the database's own list is never touched.
//
//   node --env-file=.env.local scripts/test-competitors.mjs
//
// Stop the enrichment worker first: it would race this script for the pulls.
// No network: AI Ark answers through the demo transport.
//
// What it checks:
//   A. no database: the list cleaned, and its fallback (the 069 seed); the
//      union and its dedupe (case aside) against the standard keywords and the
//      client's own; the order terms get room in the search and the byte
//      budget; the people keywords and "Leave out industries" untouched; the
//      company search; the LinkedIn keywords; what a pull keeps; a client the
//      standard keywords don't apply to; the after-pull matcher on a term that
//      did not fit
//   B. the list read from the database (missing, present, edited, the named
//      one first, empty), and a pull's start reading it and keeping it, or
//      saying it fell back
//   C. a one-at-a-time demo pull: a term the search could not hold is caught
//      on the Preview, and nobody at such a company is bought
//   D. the Outcome's check (client_exclusions): an export pull's rows, a
//      company pull's rows (bought and copied free), rows from anything else,
//      and pulls that kept nothing, judged as before
//   E. the wiring: the routes, the top-up, the LinkedIn resolver, the tab

import pg from "pg";
import { readFileSync } from "node:fs";
import { createAiArk, personInputs } from "./lib/aiark/client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./lib/aiark/demo.mjs";
import {
  accountFilters, buildRequests, bytes, CLEANING_DEFAULTS, COMPANY_TERMS_BYTES, condensePhrases, EMPTY_PEOPLE_FILTERS, keywordsOfRun, loadGeo,
} from "./lib/aiark/filters.mjs";
import { CLEANING_EXCLUDE_INDUSTRIES, CLEANING_EXCLUDE_KEYWORDS } from "./lib/aiark/cleaning-filters.mjs";
import {
  cleanCompetitorTerms, COMPETITORS_FALLBACK, COMPETITORS_LIST_NAME, COMPETITORS_SEED, competitorsFrom, competitorsView, readCompetitors,
} from "./lib/aiark/competitors.mjs";
import { buildCompanyRequests } from "./lib/aiark/company-filters.mjs";
import { keywordsFor, resolveLinkedin } from "./lib/aiark/linkedin-settings.mjs";
import { linkedinCompanyRequests, linkedinRunFilters } from "./lib/aiark/linkedin-requests.mjs";
import { competitorsOf, planFor, startRun } from "./lib/aiark/start-run.mjs";
import { advanceOneRun, createRun } from "./lib/aiark/runs.mjs";
import { CLIENT_ACTIONS, companyKeywordHit, pullKeywordsOf, resetClientChecks } from "./lib/enrich/client-checks.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}
const section = (s) => console.log(`\n${s}`);

const PREFIX = "NKTEST_";
const A = "NKTEST_A"; // a cleaning client: the standard keywords and the list apply
const B = "NKTEST_B"; // any other type: neither does on the AI Ark tab
const PLACES = [
  { country: "US", state: "OH", city: "Dayton" },
  { country: "US", state: "OH", city: "Akron" },
  { country: "US", state: "OH", city: "Toledo" },
];
const OWN_TERMS = ["NKTEST Shared Term", "nktest own only"];
const lower = (xs) => xs.map((s) => String(s).toLowerCase());
const wordsIn = (x) => String(x).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const within = (a, b) => {
  for (let i = 0; i + a.length <= b.length; i++) if (a.every((w, j) => b[i + j] === w)) return true;
  return false;
};
/** Does a sent phrase cover `x` (AI Ark's WORD match: the phrase's words, in order, inside x's)? */
const coveredBy = (sent, x) => sent.some((k) => within(wordsIn(k), wordsIn(x)));
const peopleFilters = (title) => ({ ...EMPTY_PEOPLE_FILTERS, titles: [title], title_mode: "WORD" });

/** A made-up list as the database would give it. */
const madeUpList = (items, name = COMPETITORS_LIST_NAME) => competitorsFrom({ id: "00000000-0000-4000-8000-0000000000aa", name, items, updated_at: "2026-11-21 00:00:00+00" });

/**
 * A list too big for the search, all of whose fillers are shorter than its
 * last term, so nothing after the first filler that does not fit can fit:
 * "fitness club" (a word pair the demo's made-up companies use) is never sent.
 */
const FILLERS = Array.from({ length: 60 }, (_, i) => `nktestf${String(i).padStart(3, "0")}`);
const OVERFLOW = madeUpList([...FILLERS, "fitness club"]);

// ── A. No database (the geo reference is read once) ─────────────────────────

function partA(geo) {
  section("A1. The list as a search reads it");
  const raw = ["  NKTEST  Mop Crew ", "nktest mop crew", "", 7, "x".repeat(121), "NKTEST Floor Wax", null];
  check("trimmed, spaces collapsed, once each (case aside), none over 120 characters, in the list's order",
    JSON.stringify(cleanCompetitorTerms(raw)) === JSON.stringify(["NKTEST Mop Crew", "7", "NKTEST Floor Wax"]), JSON.stringify(cleanCompetitorTerms(raw)));
  const fromRow = competitorsFrom({ id: "x", name: COMPETITORS_LIST_NAME, items: raw, updated_at: new Date("2026-11-21T00:00:00Z") });
  check("a row gives the database's list with its name, id and time, and no note", fromRow.from === "database" && fromRow.name === COMPETITORS_LIST_NAME && fromRow.id === "x" &&
    fromRow.updatedAt === "2026-11-21T00:00:00.000Z" && fromRow.terms.length === 3 && fromRow.note === null);
  check("no row: the fallback, the 069 seed's 21 terms, and a note that says so",
    competitorsFrom(null) === COMPETITORS_FALLBACK && COMPETITORS_FALLBACK.from === "fallback" && COMPETITORS_FALLBACK.terms.length === 21 && COMPETITORS_SEED.length === 21 &&
      /missing from the database/.test(COMPETITORS_FALLBACK.note) && COMPETITORS_FALLBACK.note.includes(COMPETITORS_LIST_NAME));
  const seed069 = /'Janitorial & facility-service competitors', 'competitors',\s*ARRAY\[([^\]]*)\]/.exec(source("supabase/migrations/069_campaign_presets_and_lists.sql"))?.[1] ?? "";
  check("the fallback is exactly what migration 069 seeded", JSON.stringify([...seed069.matchAll(/'([^']*)'/g)].map((m) => m[1])) === JSON.stringify([...COMPETITORS_SEED]));
  const empty = competitorsFrom({ id: "y", name: COMPETITORS_LIST_NAME, items: ["", "  "] });
  check("a row with no usable term leaves nothing out, and says so", empty.from === "database" && empty.terms.length === 0 && /holds no terms/.test(empty.note));
  const view = competitorsView(madeUpList(["NKTEST a", "NKTEST b"]));
  check("what the tab shows: the name, the count, where it came from, and the Lists page", view.name === COMPETITORS_LIST_NAME && view.terms === 2 && view.from === "database" && view.editHref === "/lists");

  section("A2. The union, once each (case aside)");
  const list = madeUpList(["JANITORIAL", "nktest mop crew", "NKTEST Mop Crew", "nktest shared term", "Law Firm"]);
  const a = accountFilters({ targeting: { exclude_terms: OWN_TERMS }, filters: null, cleaning: true, competitors: list });
  const keys = lower(a.terms);
  check("the list's own repeat is dropped, and so are its standard keywords (janitorial, law firm)",
    a.listAll.length === 4 && JSON.stringify(a.listTerms) === JSON.stringify(["nktest mop crew", "nktest shared term"]), JSON.stringify(a.listTerms));
  check("a list term the client already has is not counted as added by the list", JSON.stringify(a.listAdded) === JSON.stringify(["nktest mop crew"]));
  check("the union: the standard keywords, then the list's new terms, then the client's own new ones, each once",
    a.terms.length === CLEANING_EXCLUDE_KEYWORDS.length + 3 && new Set(keys).size === keys.length &&
      lower(a.terms.slice(0, CLEANING_EXCLUDE_KEYWORDS.length)).join() === lower(CLEANING_EXCLUDE_KEYWORDS).join() &&
      JSON.stringify(lower(a.terms.slice(-3))) === JSON.stringify(["nktest mop crew", "nktest shared term", "nktest own only"]), JSON.stringify(a.terms.slice(-4)));
  check("small enough: every term goes into the search", a.checkedAfter.length === 0 && a.termsCovered === a.terms.length && a.terms.every((t) => coveredBy(a.companyTerms, t)));

  section("A3. Room in the search: the standard keywords, then the list, then the client's own");
  const own = ["nktest own", ...Array.from({ length: 40 }, (_, i) => `nktest own longer phrase ${i}`)];
  const o = accountFilters({ targeting: { exclude_terms: own }, filters: null, cleaning: true, competitors: OVERFLOW });
  check("what is sent stays within 1,900 bytes and 300 values", bytes(o.companyTerms) <= COMPANY_TERMS_BYTES && o.companyTerms.length <= 300, `${bytes(o.companyTerms)} bytes`);
  check("every standard keyword is in the search", CLEANING_EXCLUDE_KEYWORDS.every((t) => coveredBy(o.companyTerms, t)));
  const sentFillers = FILLERS.filter((t) => o.companyTerms.includes(t));
  check("the list goes next, in its own order, as far as it fits", sentFillers.length > 0 && sentFillers.length < FILLERS.length &&
    JSON.stringify(sentFillers) === JSON.stringify(FILLERS.slice(0, sentFillers.length)), `${sentFillers.length} of ${FILLERS.length}`);
  check("a list term that does not fit is checked after the pull, never dropped", o.checkedAfter.includes("fitness club") && !o.companyTerms.includes("fitness club") && o.terms.includes("fitness club"));
  check("the client's own terms get what is left, here nothing: all checked after the pull", own.every((t) => o.checkedAfter.includes(t)) && !o.companyTerms.some((t) => t.startsWith("nktest own")));
  check("in the search plus checked after is the whole union", o.termsCovered + o.checkedAfter.length === o.terms.length && o.checkedAfter.every((t) => !coveredBy(o.companyTerms, t)));
  // Fillers (13 bytes each in the list) up to 60 to 72 bytes short of the limit, then a 100-character term, then 4 more fillers.
  const n = Math.floor((COMPANY_TERMS_BYTES - bytes(condensePhrases(CLEANING_EXCLUDE_KEYWORDS)) - 60) / 13);
  const long = `nktest ${"x".repeat(93)}`;
  const gapList = madeUpList([...FILLERS.slice(0, n), long, ...FILLERS.slice(n, n + 4)]);
  const g = accountFilters({ targeting: { exclude_terms: [] }, filters: null, cleaning: true, competitors: gapList });
  check("one list term too long for the room left doesn't keep the shorter ones after it out",
    long.length === 100 && gapList.terms.length === n + 5 && !g.companyTerms.includes(long) && g.checkedAfter.includes(long) &&
      FILLERS.slice(0, n + 4).every((t) => g.companyTerms.includes(t)) && bytes(g.companyTerms) <= COMPANY_TERMS_BYTES, `${n} fillers, ${bytes(g.companyTerms)} bytes`);
  const roomy = accountFilters({ targeting: { exclude_terms: ["nktest bar", "nktest cafe"] }, filters: null, cleaning: true, competitors: madeUpList(["nktest mop crew"]) });
  check("with room, the client's own terms go after the list, broadest first", roomy.companyTerms.slice(-3).join() === "nktest mop crew,nktest bar,nktest cafe", roomy.companyTerms.slice(-3).join());
  const covering = accountFilters({ targeting: { exclude_terms: ["cleaning"] }, filters: null, cleaning: true, competitors: madeUpList(["nktest carpet cleaning crew", "window cleaning"]) });
  check("a phrase that covers listed terms stands in for them (a sheet's 'cleaning' covers the list's cleaning terms too)",
    covering.companyTerms.includes("cleaning") && !covering.companyTerms.includes("window cleaning") && !covering.companyTerms.includes("nktest carpet cleaning crew") &&
      covering.checkedAfter.length === 0);
  const seed = accountFilters({ targeting: { exclude_terms: [] }, filters: null, cleaning: true });
  check("today's numbers with the 069 seed: 76 standard and 17 new terms, all in the search", seed.list.from === "fallback" && seed.terms.length === 93 && seed.listAdded.length === 17 &&
    seed.checkedAfter.length === 0 && bytes(seed.companyTerms) <= COMPANY_TERMS_BYTES, `${seed.terms.length} terms, ${bytes(seed.companyTerms)} bytes`);

  section("A4. People searches: company keywords only, industries untouched, the plan says it all");
  const rules = { include_locations: PLACES, exclude_terms: OWN_TERMS, commercial_cleaning: true };
  const std = buildRequests({ targeting: rules, people: CLEANING_DEFAULTS, geo, cleaning: true, competitors: madeUpList(["nktest mop crew", "building maintenance"]) });
  const q = std.requests[0];
  check("the list's terms are company keywords (name, industry, description, as words)", q.account.keyword.any.exclude.content.includes("nktest mop crew") &&
    q.account.keyword.any.exclude.sources.map((s) => `${s.source}:${s.mode}`).join() === "NAME:WORD,INDUSTRY:WORD,DESCRIPTION:WORD");
  check("people keywords stay the standard ones: no list term in the headline or summary",
    JSON.stringify(q.contact.keyword.any.exclude.content) === JSON.stringify(condensePhrases(CLEANING_EXCLUDE_KEYWORDS)) && !coveredBy(q.contact.keyword.any.exclude.content, "building maintenance"));
  check("'Leave out industries' stays the exact catalog names, with no list term", q.account.industries.any.exclude.mode === "STRICT" &&
    JSON.stringify(q.account.industries.any.exclude.content) === JSON.stringify(CLEANING_EXCLUDE_INDUSTRIES));
  check("the report names the list and counts its terms beside the others",
    std.report.competitors?.name === COMPETITORS_LIST_NAME && std.report.competitors.from === "database" && std.report.competitors.terms === 2 && std.report.competitors.added === 2 &&
      std.report.excludeTerms.list === 2 && std.report.excludeTerms.standard === 76 && std.report.excludeTerms.checkedAfter === 0 && std.report.excludeTerms.total === 76 + 2 + 2);
  check("what a pull keeps: the union, what was sent, what is checked after, and the list",
    std.keywords.union.length === std.report.excludeTerms.total && std.keywords.in_search === std.keywords.union.length && std.keywords.checked_after.length === 0 &&
      JSON.stringify(std.keywords.sent) === JSON.stringify(q.account.keyword.any.exclude.content) && std.keywords.list.name === COMPETITORS_LIST_NAME &&
      std.keywords.list.from === "database" && std.keywords.list.terms === 2 && std.keywords.list.added === 2 && std.keywords.standard === 76 && std.keywords.own === 2);
  const cut = buildRequests({ targeting: rules, people: peopleFilters("NKTEST Office Manager"), geo, cleaning: true, competitors: OVERFLOW });
  check("a search that can't hold everything says how many, of which kinds, and that the rest are checked after the pull",
    cut.notes.some((n) => n.startsWith("AI Ark's limits leave room for") && n.includes("from the competitors list") && n.includes("are checked after the pull") && n.includes("before buying")) &&
      cut.report.excludeTerms.checkedAfter === cut.keywords.checked_after.length && cut.keywords.checked_after.includes("fitness club"));
  const fallback = buildRequests({ targeting: rules, people: peopleFilters("NKTEST Office Manager"), geo, cleaning: true });
  check("no list given: the 069 seed, and the plan's notes say so", fallback.report.competitors.from === "fallback" && fallback.notes.includes(COMPETITORS_FALLBACK.note) &&
    fallback.keywords.list.from === "fallback" && COMPETITORS_SEED.every((t) => fallback.keywords.union.some((u) => u.toLowerCase() === t.toLowerCase())));
  const other = buildRequests({ targeting: rules, people: peopleFilters("NKTEST Office Manager"), geo, cleaning: false, competitors: OVERFLOW });
  const before = buildRequests({ targeting: rules, people: peopleFilters("NKTEST Office Manager"), geo, cleaning: false });
  check("a client the standard keywords don't apply to: no list, nothing kept, the request as before",
    !other.report.competitors && other.keywords === null && JSON.stringify(other.requests) === JSON.stringify(before.requests) &&
      JSON.stringify([...other.requests[0].account.keyword.any.exclude.content].sort()) === JSON.stringify([...OWN_TERMS].sort()));

  section("A5. Company searches and the LinkedIn keywords");
  const co = buildCompanyRequests({ targeting: rules, filters: null, geo, cleaning: true, competitors: madeUpList(["nktest mop crew"]) });
  check("a company search leaves the list out too, and keeps it", co.requests[0].account.keyword.any.exclude.content.includes("nktest mop crew") &&
    co.report.competitors?.terms === 1 && co.keywords?.union.some((t) => t === "nktest mop crew") && co.keywords.list.added === 1);
  const coCut = buildCompanyRequests({ targeting: rules, filters: null, geo, cleaning: true, competitors: OVERFLOW });
  check("... within the budget, and says the rest are checked on each company after the pull", bytes(coCut.requests[0].account.keyword.any.exclude.content) <= COMPANY_TERMS_BYTES &&
    coCut.notes.some((n) => n.startsWith("AI Ark's limits leave room for") && n.includes("each company")) && coCut.keywords.checked_after.includes("fitness club"));
  const coOther = buildCompanyRequests({ targeting: rules, filters: null, geo, cleaning: false, competitors: OVERFLOW });
  check("... and a company search for any other client has none of it", !coOther.report.competitors && coOther.keywords === null);
  const k = keywordsFor(["nktest linkedin own"], madeUpList(["nktest mop crew", "janitorial"]));
  check("LinkedIn: the standard keywords, then the list's new terms, then the client's own",
    k.union.length === 76 + 2 && k.union.at(-2) === "nktest mop crew" && k.union.at(-1) === "nktest linkedin own" && k.list.name === COMPETITORS_LIST_NAME && k.list.terms === 2 &&
      JSON.stringify(k.list.added) === JSON.stringify(["nktest mop crew"]));
  const kCut = keywordsFor(["nktest linkedin own"], OVERFLOW);
  check("LinkedIn: a list term that does not fit is checked after the pull", kCut.checkedAfter.includes("fitness club") && kCut.checkedAfter.includes("nktest linkedin own") && !kCut.sent.includes("fitness club"));
  const starter = { items: ["nktest starter"], version: 1, source: "made up", sha256: null, seeded_at: null, updatedAt: "s", loaded: true };
  const eff = resolveLinkedin({ tag: "nktest_l", kind: "companies", row: null, targeting: { include_locations: PLACES, exclude_locations: [], version: "t" }, starter, saved: null, clientType: "Other", competitors: OVERFLOW });
  const lr = linkedinCompanyRequests({ effective: eff, geo });
  check("LinkedIn: the resolver carries the list to the request and to what the pull keeps",
    eff.competitors === OVERFLOW && lr.requests[0].account.keyword.any.exclude.content.includes(FILLERS[0]) && lr.report.linkedin.keywords.list === OVERFLOW.terms.length &&
      linkedinRunFilters(eff).keywords.list?.name === COMPETITORS_LIST_NAME && linkedinRunFilters(eff).keywords.union.includes("fitness club") &&
      linkedinRunFilters(eff).keywords.checked_after.includes("fitness club"));
  check("LinkedIn: the plan names the list in its own note, and drops the AI Ark tab's", lr.notes.some((n) => n.includes("new terms of the competitors list")) &&
    !lr.notes.some((n) => n.startsWith("AI Ark's limits leave room for")));

  section("A6. The after-pull matcher on a term the search could not hold");
  const kept = keywordsOfRun({ filters: { keywords: cut.keywords } });
  check("the kept keywords read back once each, lower case", kept.length === cut.keywords.union.length && kept.every((t) => t === t.toLowerCase()));
  check("caught as whole words in the name, the industry and the description", companyKeywordHit({ company: "Harborview Fitness Club" }, kept)?.term === "fitness club" &&
    companyKeywordHit({ company: "Acme", industry: "Fitness Club Operators" }, kept)?.label === "industry" &&
    companyKeywordHit({ company: "Acme", description: "We run a fitness club downtown." }, kept)?.label === "company description");
  check("never inside a longer word", companyKeywordHit({ company: "Fitness Clubhouse Partners", industry: "", description: "" }, ["fitness club"]) === null);
  check("a filler that did fit is caught the same way", companyKeywordHit({ company: `${FILLERS[0]} Holdings` }, kept)?.term === FILLERS[0]);
}

// ── B. The list read from the database ──────────────────────────────────────

/** Runs fn on one client inside a transaction that is always rolled back. */
async function rolledBack(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

async function partB(geo) {
  section("B1. readCompetitors (each step rolled back)");
  const listed = await all(`SELECT id FROM custom_lists WHERE kind = 'competitors' AND built_in`);
  console.log(`  (the database holds ${listed.length} built-in competitors ${listed.length === 1 ? "list" : "lists"}; none is changed for good)`);
  await rolledBack(async (c) => {
    await c.query(`DELETE FROM custom_lists WHERE kind = 'competitors' AND built_in`);
    const missing = await readCompetitors(c);
    check("no built-in competitors list: the fallback", missing === COMPETITORS_FALLBACK);
    await c.query(`INSERT INTO custom_lists (name, kind, items, description, built_in) VALUES ('NKTEST not built in', 'competitors', '{nktest other}', 'made up', false)`);
    check("a list that is not built in is never read", (await readCompetitors(c)) === COMPETITORS_FALLBACK);
    await c.query(`INSERT INTO custom_lists (name, kind, items, description, built_in) VALUES ($1, 'competitors', $2, 'made up', true)`,
      [COMPETITORS_LIST_NAME, [" NKTEST  Mop Crew ", "nktest mop crew", "NKTEST Floor Wax"]]);
    const present = await readCompetitors(c);
    check("the built-in list read: trimmed, once each, from the database, with its id and time",
      present.from === "database" && JSON.stringify(present.terms) === JSON.stringify(["NKTEST Mop Crew", "NKTEST Floor Wax"]) && present.name === COMPETITORS_LIST_NAME &&
        /^[0-9a-f-]{36}$/.test(present.id) && Boolean(present.updatedAt) && present.note === null);
    await c.query(`UPDATE custom_lists SET items = $2, updated_at = now() WHERE name = $1`, [COMPETITORS_LIST_NAME, ["NKTEST Mop Crew", "NKTEST Floor Wax", "NKTEST Grout Team"]]);
    check("an edit is read by the next call", (await readCompetitors(c)).terms.length === 3);
    await c.query(`INSERT INTO custom_lists (name, kind, items, description, built_in, updated_at) VALUES ('NKTEST second built in', 'competitors', '{nktest second}', 'made up', true, now() + interval '1 day')`);
    check("two built-in lists: the one with the built-in name first", (await readCompetitors(c)).name === COMPETITORS_LIST_NAME);
    await c.query(`UPDATE custom_lists SET items = '{}' WHERE name = $1`, [COMPETITORS_LIST_NAME]);
    const emptied = await readCompetitors(c);
    check("an emptied built-in list leaves nothing out, and says so", emptied.from === "database" && emptied.terms.length === 0 && /holds no terms/.test(emptied.note));
    check("competitorsOf: only for a client the standard keywords apply to", (await competitorsOf(c, "Cleaning"))?.name === COMPETITORS_LIST_NAME &&
      (await competitorsOf(c, "Canada Cleaning")) === undefined && (await competitorsOf(c, null)) === undefined);
  });
  check("the rollback left the database's lists as they were",
    JSON.stringify((await all(`SELECT id FROM custom_lists WHERE kind = 'competitors' AND built_in`)).map((r) => r.id)) === JSON.stringify(listed.map((r) => r.id)) &&
      (await one(`SELECT count(*)::int AS n FROM custom_lists WHERE starts_with(name, 'NKTEST')`)).n === 0);

  section("B2. A pull's start reads the list and keeps it (rolled back)");
  await rolledBack(async (c) => {
    await c.query(`DELETE FROM custom_lists WHERE kind = 'competitors' AND built_in`);
    await c.query(`INSERT INTO custom_lists (name, kind, items, description, built_in) VALUES ($1, 'competitors', $2, 'made up', true)`,
      [COMPETITORS_LIST_NAME, ["NKTEST Mop Crew", "janitorial", "NKTEST Shared Term"]]);
    const got = await startRun(c, { tag: A, mode: "demo", strategy: "single", size: 10, geo });
    const f = got.run?.filters;
    check("the run keeps the database's list: name, source, terms, and how many it added", Boolean(got.run) && f?.keywords?.list?.from === "database" &&
      f.keywords.list.name === COMPETITORS_LIST_NAME && f.keywords.list.terms === 3 && f.keywords.list.added === 1, JSON.stringify(got.error ?? f?.keywords?.list));
    check("... the whole union (standard, the list, its own terms), and what was sent", f.keywords.union.length === 76 + 1 + 2 &&
      f.keywords.union.some((t) => t.toLowerCase() === "nktest mop crew") && f.keywords.sent.includes("NKTEST Mop Crew") && f.keywords.in_search === f.keywords.union.length);
    check("... and its requests leave the list's terms out", got.run.requests.every((r) => r.account.keyword.any.exclude.content.includes("NKTEST Mop Crew")));
    check("... and the plan's report names the list", f.report.competitors?.name === COMPETITORS_LIST_NAME && f.report.competitors.terms === 3);
    await c.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [got.run.id]);
    await c.query(`DELETE FROM custom_lists WHERE kind = 'competitors' AND built_in`);
    const fell = await startRun(c, { tag: A, mode: "demo", strategy: "single", size: 10, geo });
    check("no built-in list: the run uses the 069 seed and its notes say so", fell.run?.filters?.keywords?.list?.from === "fallback" &&
      fell.run.filters.notes.includes(COMPETITORS_FALLBACK.note) && fell.run.filters.keywords.list.terms === 21, JSON.stringify(fell.error ?? fell.run?.filters?.keywords?.list));
    const otherType = await startRun(c, { tag: B, mode: "demo", strategy: "single", size: 10, geo });
    check("a client of another type keeps nothing (its search has no standard keywords)", Boolean(otherType.run) && !("keywords" in otherType.run.filters) &&
      !otherType.run.filters.report.competitors, JSON.stringify(otherType.error ?? null));
    const plan = planFor(await one(`SELECT * FROM client_targeting WHERE client_tag = $1`, [A]), peopleFilters("NKTEST Office Manager"), geo, "Cleaning", await readCompetitors(c));
    check("planFor (the tab's plan and the top-up's prepare) takes the list as read", plan.keywords?.list.from === "fallback" && plan.report.competitors?.from === "fallback");
  });
  check("nothing of the rolled-back starts is left", (await one(`SELECT count(*)::int AS n FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).n === 0);
}

// ── C. A one-at-a-time pull: caught before buying ───────────────────────────

const TERMINAL = new Set(["done", "stopped", "error", "cancelled"]);
const runs = [];

async function makeRun({ strategy, title, competitors = OVERFLOW, keep = true, size = 2000 }) {
  const geo = await loadGeo(pool);
  const targeting = await one(`SELECT * FROM client_targeting WHERE client_tag = $1`, [A]);
  const people = peopleFilters(title);
  const built = buildRequests({ targeting, people, geo, cleaning: true, competitors });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const run = await createRun(c, {
      tag: A, mode: "demo", strategy, size,
      filters: { people, report: built.report, notes: built.notes, ...(keep ? { keywords: built.keywords } : {}) },
      requests: built.requests,
    });
    await c.query("COMMIT");
    runs.push(run.id);
    return { run, built };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

/** Works the run to its end with the demo stand-in, `bought` collecting every person whose email was bought. */
async function drive(runId, transport) {
  const clientFor = async () => ({ client: createAiArk({ token: DEMO_TOKEN, transport, wait: async () => {}, rps: 5 }) });
  for (let i = 0; i < 400; i++) {
    const st = await one(`SELECT status FROM aiark_runs WHERE id = $1`, [runId]);
    if (TERMINAL.has(st.status)) return st.status;
    const worked = await advanceOneRun({ pool, env: { AIARK_DEMO: "1" }, clientFor, log: () => {} });
    if (!worked) await pool.query(`UPDATE aiark_runs SET next_run_at = now() WHERE id = $1 AND status IN ('queued', 'running')`, [runId]);
  }
  throw new Error(`run ${runId} did not finish`);
}

/** Everyone a search would show, page by page, from a stand-in of its own. */
async function population(request) {
  const probe = createAiArk({ token: DEMO_TOKEN, transport: createDemoTransport({}), wait: async () => {}, rps: 5 });
  const out = [];
  for (let page = 0; page < 50; page++) {
    const res = await probe.preview(request, { page, size: 100 });
    out.push(...res.content);
    if (res.content.length < 100 || (page + 1) * 100 >= res.totalElements) break;
  }
  return out;
}

const companyOf = (p) => {
  const f = personInputs(p);
  return { company: f.company ?? "", industry: f.company_industry ?? "", description: f.company_description ?? "" };
};

async function partC() {
  section("C1. One at a time: a term the search could not hold is caught on the Preview, before anything is bought");
  const { run, built } = await makeRun({ strategy: "single", title: "NKTEST Office Manager C" });
  check("the made-up list overflows: 'fitness club' is checked after the pull, not sent",
    built.keywords.checked_after.includes("fitness club") && !built.requests[0].account.keyword.any.exclude.content.includes("fitness club"));
  const everyone = await population(built.requests[0]);
  const atClubs = everyone.filter((p) => companyKeywordHit(companyOf(p), ["fitness club"]));
  check("AI Ark's (stand-in's) answer holds people at fitness clubs, as the search could not leave them out", atClubs.length > 0, `${atClubs.length} of ${everyone.length}`);
  const base = createDemoTransport({ jobMs: 0 });
  const bought = new Set();
  const transport = async (req) => {
    if (req.method === "POST" && req.url.endsWith("/v2/people/export/single")) bought.add(JSON.parse(req.body).id);
    return base(req);
  };
  const status = await drive(run.id, transport);
  const r = await one(`SELECT * FROM aiark_runs WHERE id = $1`, [run.id]);
  const companies = await all(`SELECT value #>> '{}' AS company FROM enrich_cells WHERE table_id = $1 AND column_key = 'company'`, [run.table_id]);
  check("the pull finished", status === "done", `${status} ${r.last_error ?? ""}`);
  check("nobody at a fitness club was bought", atClubs.every((p) => !bought.has(p.id)) && bought.size > 0, `${bought.size} bought`);
  check("nor written to the pull's table or the registry", !companies.some((x) => /fitness club/i.test(x.company)) &&
    (await one(`SELECT count(*)::int AS n FROM aiark_people WHERE person_id = ANY($1::text[])`, [atClubs.map((p) => p.id)])).n === 0);
  check("the run counts them (progress.keyword_skipped)", Number(r.progress.keyword_skipped) === atClubs.length, `${r.progress.keyword_skipped} vs ${atClubs.length}`);
  check("everyone else was pulled", r.pulled + Number(r.progress.keyword_skipped) + r.skipped_held === everyone.length, `${r.pulled} + ${r.progress.keyword_skipped} + ${r.skipped_held} of ${everyone.length}`);

  section("C2. A pull that kept nothing buys as before");
  const old = await makeRun({ strategy: "single", title: "NKTEST Office Manager C2", keep: false });
  const everyone2 = await population(old.built.requests[0]);
  const clubs2 = everyone2.filter((p) => companyKeywordHit(companyOf(p), ["fitness club"]));
  const base2 = createDemoTransport({ jobMs: 0 });
  const status2 = await drive(old.run.id, base2);
  const r2 = await one(`SELECT * FROM aiark_runs WHERE id = $1`, [old.run.id]);
  check("no keyword skip: everyone at a fitness club is pulled as before", status2 === "done" && !r2.progress.keyword_skipped && clubs2.length > 0 &&
    r2.pulled + r2.skipped_held === everyone2.length, `${r2.pulled} of ${everyone2.length}`);
}

// ── D. The Outcome's check ──────────────────────────────────────────────────

const exclusions = (inputs, table, row) => CLIENT_ACTIONS.client_exclusions.run({ inputs, table, row, db: pool });

async function partD() {
  section("D1. An export pull's rows: every kept keyword, sent or not, as whole words");
  const { run } = await makeRun({ strategy: "export", title: "NKTEST Office Manager D" });
  const status = await drive(run.id, createDemoTransport({ jobMs: 0 }));
  const rows = await all(
    `SELECT e.id, max(c.value #>> '{}') FILTER (WHERE c.column_key = 'company') AS company,
            max(c.value #>> '{}') FILTER (WHERE c.column_key = 'company_industry') AS industry,
            max(c.value #>> '{}') FILTER (WHERE c.column_key = 'company_description') AS description,
            max(c.value #>> '{}') FILTER (WHERE c.column_key = 'title') AS title
       FROM enrich_rows e JOIN enrich_cells c ON c.row_id = e.id
      WHERE e.table_id = $1 GROUP BY e.id`,
    [run.table_id]
  );
  const table = { id: run.table_id, client_tag: A, kind: "ai_ark" };
  const clubs = rows.filter((x) => /fitness club/i.test(x.company ?? ""));
  check("the export job paid for people at fitness clubs (the search could not leave them out)", status === "done" && clubs.length > 0, `${status}, ${clubs.length} of ${rows.length}`);
  resetClientChecks();
  const judged = [];
  for (const x of rows) judged.push({ x, r: await exclusions({ company: x.company, industry: x.industry, description: x.description, title: x.title }, table, { id: x.id }) });
  const hits = judged.filter((j) => j.r.status === "done");
  check("each of them is excluded, naming the keyword", clubs.length > 0 && clubs.every((x) => judged.find((j) => j.x.id === x.id)?.r.display === 'Excluded keyword "fitness club" in the company name'));
  check("nobody else is", hits.length === clubs.length, `${hits.length} vs ${clubs.length}`);
  const keptCount = (await one(`SELECT jsonb_array_length(filters -> 'keywords' -> 'union') AS n FROM aiark_runs WHERE id = $1`, [run.id])).n;
  check("the rest say how many of the pull's keywords they are clear of", judged.filter((j) => j.r.status === "empty").every((j) => j.r.note.includes(`and the pull's ${keptCount} excluded keywords`)), String(keptCount));
  check("the client's own terms still match first, the stricter way (anywhere in the name)", (await exclusions({ company: "XNKTEST SHARED TERMX Ltd" }, table, { id: rows[0].id })).display ===
    '"nktest shared term" in the company name');
  check("... and as whole words too, as the search would have matched them", (await exclusions({ company: "NKTEST-Shared-Term Co" }, table, { id: rows[0].id })).display ===
    'Excluded keyword "nktest shared term" in the company name');
  await pool.query(`UPDATE aiark_runs SET filters = filters - 'keywords' WHERE id = $1`, [run.id]);
  resetClientChecks();
  const after = await exclusions({ company: clubs[0]?.company ?? "Harborview Fitness Club" }, table, { id: clubs[0]?.id ?? rows[0].id });
  check("a pull that kept nothing (made before the list) is judged as before", after.status === "empty" && !/pull's/.test(after.note));
  check("a check with no table or row (a people run's screen) reads nothing", (await pullKeywordsOf(pool, { client_tag: A }, null)) === null &&
    (await exclusions({ company: "Harborview Fitness Club" }, { client_tag: A }, null)).status === "empty");

  section("D2. A company pull's rows, bought and copied free; rows from anything else");
  const geo = await loadGeo(pool);
  const targeting = await one(`SELECT * FROM client_targeting WHERE client_tag = $1`, [A]);
  const builtCo = buildCompanyRequests({ targeting, filters: null, geo, cleaning: true, competitors: OVERFLOW });
  check("the company pull's search could not hold 'fitness club'", builtCo.keywords.checked_after.includes("fitness club"));
  const { rows: [t] } = await pool.query(`INSERT INTO enrich_tables (client_tag, kind, name) VALUES ($1, 'companies', 'NKTEST companies') RETURNING id`, [A]);
  const runId = (await one(`SELECT gen_random_uuid() AS id`)).id;
  const src = async (kind, meta) => (await one(`INSERT INTO enrich_sources (table_id, kind, label, meta) VALUES ($1, $2, 'NKTEST', $3) RETURNING id`, [t.id, kind, JSON.stringify(meta)])).id;
  const bought = await src("ai_ark", { run_id: runId, mode: "demo", size: 10 });
  const copied = await src("registry", { run_id: runId, mode: "demo" });
  const csv = await src("csv", {});
  await pool.query(
    `INSERT INTO aiark_company_runs (id, client_tag, mode, status, size_requested, table_id, source_id, registry_source_id, filters, requests)
     VALUES ($1, $2, 'demo', 'done', 10, $3, $4, $5, $6, $7)`,
    [runId, A, t.id, bought, copied, JSON.stringify({ keywords: builtCo.keywords }), JSON.stringify(builtCo.requests)]
  );
  const row = async (sourceId, key) => (await one(`INSERT INTO enrich_rows (table_id, source_id, row_key) VALUES ($1, $2, $3) RETURNING id`, [t.id, sourceId, key])).id;
  const rBought = await row(bought, "nktest:1");
  const rCopied = await row(copied, "nktest:2");
  const rCsv = await row(csv, "nktest:3");
  const rNone = await row(null, "nktest:4");
  const tableCo = { id: t.id, client_tag: A, kind: "companies" };
  resetClientChecks();
  const club = { company: "Riverbend Fitness Club" };
  check("a bought row is excluded on a keyword its pull could not send", (await exclusions(club, tableCo, { id: rBought })).display === 'Excluded keyword "fitness club" in the company name');
  check("so is a row the pull copied free from the registry", (await exclusions(club, tableCo, { id: rCopied })).status === "done");
  check("a row from an upload or with no source is judged as before", (await exclusions(club, tableCo, { id: rCsv })).status === "empty" && (await exclusions(club, tableCo, { id: rNone })).status === "empty");
  check("a row of another table is never read through this one", (await pullKeywordsOf(pool, { id: run.table_id, kind: "ai_ark" }, { id: rBought })) === null);
  check("a People table's row is not read (its people were checked in their pull's table)", (await pullKeywordsOf(pool, { ...tableCo, kind: "people" }, { id: rBought })) === null);
  check("the kept union read back for the row, lower case", (await pullKeywordsOf(pool, tableCo, { id: rBought }))?.includes("fitness club") === true);
}

// ── E. The wiring ───────────────────────────────────────────────────────────

function partE() {
  section("E. The wiring");
  const runsRoute = source("src/app/api/companies/runs/route.ts");
  check("the company pull route keeps the plan's keywords on the pull", /keywords: p\.keywords/.test(runsRoute) && /competitorsFor\(c, client\.client_type/.test(runsRoute));
  for (const f of ["src/app/api/companies/count/route.ts", "src/app/api/companies/setup/route.ts", "src/app/api/aiark/count/route.ts", "src/app/api/aiark/setup/route.ts"]) {
    check(`${f} reads the list for the plan`, /competitorsFor\(c, client\??\.client_type/.test(source(f)));
  }
  check("the AI Ark setup answers the list for the tab", /competitors: competitorsListView\(competitors\)/.test(source("src/app/api/aiark/setup/route.ts")));
  check("the top-up's prepare and every run start read it (competitorsOf)", /planFor\(sub\.targeting, people\.value, geo, clientType, await competitorsOf\(db, clientType\)\)/.test(source("scripts/lib/topup/pulls.mjs")) &&
    /planFor\(use, people\.value, g, clientType, await competitorsOf\(db, clientType\)\)/.test(source("scripts/lib/aiark/start-run.mjs")));
  const linkedin = source("scripts/lib/aiark/linkedin-settings.mjs");
  check("the LinkedIn resolver reads it with its other parts", /const competitors = await readCompetitors\(db\);/.test(linkedin) && /competitors \}\), client: client \?\? null/.test(linkedin) &&
    /readCompetitors\(c\)/.test(source("src/lib/linkedin/server.ts")));
  const page = source("src/app/(app)/leads/ai-ark/page.tsx");
  const at = page.indexOf('label="Leave out industries"');
  check("the AI Ark tab shows the list right after 'Leave out industries', with a link to the Lists page",
    at > 0 && page.indexOf("<CompetitorsLine list={setup.competitors} />", at) - at < 600 && /href=\{list\.editHref\}/.test(page) && /keyword_skipped/.test(page));
  check("the run table's exclusions column says it checks the kept keywords", /every excluded keyword the pull kept/.test(source("scripts/lib/aiark/columns.mjs")));
  check("nothing here reads the push worker's files", !/push-worker|push-attach|push-side/.test(source("scripts/lib/aiark/competitors.mjs")));
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query(`DELETE FROM aiark_people WHERE run_id = ANY($1::uuid[])`, [runs]);
  await pool.query(`DELETE FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM aiark_company_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_people_filters WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM custom_lists WHERE starts_with(name, 'NKTEST')`);
}

async function setup() {
  for (const [tag, type] of [[A, "Cleaning"], [B, "Other"]]) {
    await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, $3)`, [tag, `Competitors test ${tag.slice(PREFIX.length)}`, type]);
    await pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
       VALUES ($1, '{US}', $2, '[]', $3, false, now())`,
      [tag, JSON.stringify(PLACES), OWN_TERMS]
    );
    await pool.query(
      `INSERT INTO client_people_filters (client_tag, titles, title_mode, exclude_titles, seniority, departments, employee_bands, industries, exclude_industries)
       VALUES ($1, '{NKTEST Office Manager}', 'WORD', '{}', '{}', '{}', '[]', '{}', '{}')`,
      [tag]
    );
  }
}

const busy = await one(`SELECT count(*)::int AS n FROM aiark_runs WHERE (status IN ('queued', 'running') OR (status = 'cancelled' AND finished_at IS NULL)) AND NOT starts_with(client_tag, $1)`, [PREFIX]);
if (busy.n) {
  console.error(`Refusing to run: ${busy.n} AI Ark pull(s) of real clients are going in this database; this script's worker steps would work them.`);
  await pool.end();
  process.exit(1);
}

try {
  await cleanup();
  await setup();
  const geo = await loadGeo(pool);
  partA(geo);
  await partB(geo);
  await partC();
  await partD();
  partE();
} catch (e) {
  failed++;
  console.error(`\n  FAIL  the script stopped: ${e?.stack ?? e}`);
} finally {
  await cleanup().catch((e) => console.error(`cleanup: ${e.message}`));
  const left = await one(
    `SELECT (SELECT count(*) FROM client_tags WHERE starts_with(tag, $1)) + (SELECT count(*) FROM aiark_runs WHERE starts_with(client_tag, $1))
          + (SELECT count(*) FROM enrich_tables WHERE starts_with(client_tag, $1)) + (SELECT count(*) FROM custom_lists WHERE starts_with(name, 'NKTEST')) AS n`,
    [PREFIX]
  );
  console.log(`\n${passed} passed, ${failed} failed${Number(left.n) ? `; ${left.n} test rows left behind` : "; cleaned up"}`);
  await pool.end();
  process.exitCode = failed || Number(left.n) ? 1 : 0;
}
