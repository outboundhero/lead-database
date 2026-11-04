#!/usr/bin/env node
// Deep checks for the AI Ark tab. LOCAL DATABASE ONLY: it creates demo runs,
// adds a few temporary leads, never-contact rows, Email Bison copy rows, made-up
// clients and a cleaning title, runs the location resolver over its own leads,
// and removes all of it at the end.
//
//   AIARK_TEST_TAG=<client tag> node --env-file=.env.local scripts/test-aiark.mjs
//
// The client must be a cleaning client (commercial_cleaning on) whose
// exclude_terms hold "bistro" and "bar" and whose first include_locations entry
// has a city, state and country.
//
// Stop the enrichment worker first — it would race this script for the runs.
//
// What it checks:
//   A. the filter mapper, the AI Ark client's error mapping (every documented
//      status), the person normaliser — no database
//   B. demo runs end to end against the database: single and export pulls,
//      no person bought twice (within and across runs, and a single run beside
//      another run's export), a crash mid-slice and resume, cancel (queued,
//      mid-slice, and with an export out), out of credits, a refused key, a
//      refunded / expired / still-processing / lost-answer export, a paid job
//      held through errors, exclusion lists, adoption, person writes (and
//      writes whose answer is lost), the spending brake, lost single answers,
//      a run that gets past an error
//   C. every outcome the worker works out, against an oracle built from the
//      database's own functions (fn_regex_escape, fn_whole_term_regex,
//      fn_commercial_cleaning_condition, geo_admin1), then each client rule
//      against the real thing: made-up clients and people go through the import's
//      own code, the location resolver script and fn_client_eligibility_conditions
//   D. "Add to the database": the import rows, who an add takes, skips and settles
//      (the import itself is the Uploads page's engine, stood in for here), which
//      finished pulls the worker sends on, and the way back from the pipeline
//   E. the standard filters for cleaning clients in the request AI Ark gets, with
//      a client's sheet terms added, within what AI Ark is known to accept, and
//      that they stay out of the database's rules

import pg from "pg";
import ts from "typescript";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AiArkError, clip, createAiArk, personInputs } from "./lib/aiark/client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./lib/aiark/demo.mjs";
import { buildRequests, cleanPeopleFilters, CLEANING_DEFAULTS, condensePhrases, EMPTY_PEOPLE_FILTERS, loadGeo } from "./lib/aiark/filters.mjs";
import { CLEANING_EXCLUDE_KEYWORDS } from "./lib/aiark/cleaning-filters.mjs";
import { RUN_COLUMNS } from "./lib/aiark/columns.mjs";
import { addState, autoAddConfig, beginAdd, emailFound, EXTRA_FIELDS, finishAdd, headcount, IMPORT_COLUMNS, importRow, names, pullsToAdd, requestAdd } from "./lib/aiark/add.mjs";
import { cityKey, findState } from "./lib/aiark/geo.mjs";
import { advanceOneRun, aiArkFor, createRun, runDue, webhookFor } from "./lib/aiark/runs.mjs";
import { CLIENT_ACTIONS, likelyAddresses, resetClientChecks, wholeTermSource } from "./lib/enrich/client-checks.mjs";
import { runRow as engineRow } from "./lib/enrich/engine.mjs";
import { order } from "./lib/enrich/formula.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
const TAG = (process.env.AIARK_TEST_TAG ?? "").trim().toUpperCase();
if (!TAG) {
  console.error("Set AIARK_TEST_TAG to a cleaning client with locations whose exclusion terms hold bistro and bar.");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 6 });
const fastWait = async () => {};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` — ${detail}` : ""}`);
}
const section = (s) => console.log(`\n${s}`);
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const created = { runs: [], tables: [], emails: [], batches: [] };
// What the rule checks in section C add, all removed by dropRuleData.
const TEST_DOMAIN = "aiark-test.example";
const RULE_PREFIX = "ABCTEST_";
const TEST_TITLE = "aiark test title";
// The filters the runs here use: short, so the demo's made-up people are predictable.
const TEST_PEOPLE = {
  ...EMPTY_PEOPLE_FILTERS,
  titles: [
    "Owner", "Founder", "CEO", "Chief Executive Officer", "Company Owner", "Franchise Owner",
    "Chief Operating Officer", "Vice President of Operations", "Vice President of Facilities", "Facilities Director",
    "Head of Facilities", "Head of Facilities and Operations", "Facilities Manager", "Facility Manager",
    "Office Manager", "Workplace Manager", "Office Administrator", "Office Coordinator", "Operations Manager",
  ],
  title_mode: "WORD",
  exclude_titles: [
    "attorney", "legal", "lawyer", "human resources", "intern", "freelance", "recruiter", "talent",
    "sales", "business development", "accountant", "account manager", "account executive",
  ],
};

// ── A. No database ──────────────────────────────────────────────────────────

async function partA(geo) {
  section("A1. Filter mapper");
  const t = {
    include_locations: [
      { city: "Armonk", state: "NY", country: "US" },
      { state: "CT", country: "US" },
      { country: "US" },
      { city: "Nowhere" },
      { city: "Y", state: "ZZ", country: "US" },
    ],
    exclude_locations: [{ city: "Bedford", state: "NY", country: "US" }],
    exclude_terms: ["bar", "cafe"],
    commercial_cleaning: true,
  };
  const r = buildRequests({ targeting: t, people: TEST_PEOPLE, geo });
  const loc = r.requests[0]?.contact?.location?.any;
  check("one request for 3 usable places", r.requests.length === 1 && loc?.include?.length === 3, JSON.stringify(loc));
  check("city+state, state and country strings", JSON.stringify(loc?.include) === JSON.stringify(["Armonk, New York", "Connecticut", "United States"]), JSON.stringify(loc?.include));
  check("excluded place sent", JSON.stringify(loc?.exclude) === JSON.stringify(["Bedford, New York"]));
  check("2 unusable entries reported, not sent", r.report.locations.dropped.length === 2 && r.notes.some((n) => n.includes("left out")));
  check("city/state wording note", r.notes.some((n) => n.includes('"City, State"')));
  const kw = r.requests[0]?.account?.keyword?.any?.exclude;
  check("exclusion terms as WORD company keywords on NAME/INDUSTRY/DESCRIPTION",
    JSON.stringify(kw?.content) === '["bar","cafe"]' && kw.sources.map((s) => `${s.source}:${s.mode}`).join() === "NAME:WORD,INDUSTRY:WORD,DESCRIPTION:WORD");
  const title = r.requests[0]?.contact?.experience?.latest?.title?.any;
  check("titles on the main current job, WORD include + WORD exclude", title?.include?.mode === "WORD" && JSON.stringify(title.include.content) === JSON.stringify(condensePhrases(TEST_PEOPLE.titles)) && title.exclude.mode === "WORD");
  check("no pull blockers with titles", r.pullBlockers.length === 0 && r.blockers.length === 0);

  const many = { include_locations: Array.from({ length: 310 }, (_, i) => ({ city: `Town${i}`, state: "NY", country: "US" })), exclude_terms: Array.from({ length: 320 }, (_, i) => `term${i}`) };
  const r2 = buildRequests({ targeting: many, people: TEST_PEOPLE, geo });
  const placesIn = r2.requests.map((q) => q.contact.location.any.include);
  check("310 places split across searches, each within the size AI Ark took, none lost or repeated", r2.requests.length > 1 && placesIn.every((g) => Buffer.byteLength(JSON.stringify(g)) <= 950) && new Set(placesIn.flat()).size === 310 && placesIn.flat().length === 310);
  check("320 exclusion terms → as many as fit, said so", r2.report.excludeTerms.total === 320 && r2.report.excludeTerms.sent < 320 && r2.report.excludeTerms.sent > 150 && Buffer.byteLength(JSON.stringify(r2.requests[0].account.keyword.any.exclude.content)) <= 1900 && r2.notes.some((n) => n.includes("are checked after the pull")));
  check("no targeting → blocker", buildRequests({ targeting: null, people: CLEANING_DEFAULTS, geo }).blockers.length === 1);
  check("no locations → blocker, no requests", (() => { const x = buildRequests({ targeting: { include_locations: [] }, people: CLEANING_DEFAULTS, geo }); return x.blockers.length === 1 && x.requests.length === 0; })());
  check("no titles/seniority/departments → pull blocker", buildRequests({ targeting: t, people: EMPTY_PEOPLE_FILTERS, geo }).pullBlockers.length === 1);
  const bands = buildRequests({ targeting: t, people: { ...CLEANING_DEFAULTS, employee_bands: [{ start: 11, end: 50 }, { start: 1001 }] }, geo });
  check("company size bands as a RANGE", JSON.stringify(bands.requests[0].account.employeeSize) === '{"type":"RANGE","range":[{"start":11,"end":50},{"start":1001}]}');

  const c = cleanPeopleFilters({
    titles: ["  Office   Manager ", "office manager", "Owner"],
    seniority: ["owner", "boss"],
    departments: ["facility_administration", "Facility Admin"],
    employee_bands: [{ start: 50, end: 10 }, { start: "11", end: "50" }],
    title_mode: "strict",
  });
  check("people filters: dedupe + trim titles", JSON.stringify(c.value.titles) === '["Office Manager","Owner"]');
  check("people filters: 3 refusals (seniority, department, band)", c.errors.length === 3, c.errors.join(" | "));
  check("people filters: mode upper-cased, good band kept", c.value.title_mode === "STRICT" && JSON.stringify(c.value.employee_bands) === '[{"start":11,"end":50}]');
  const long = "x".repeat(121);
  const over = cleanPeopleFilters({ titles: ["Owner", long], exclude_industries: [`y${long}`] });
  check("a value over 120 characters is refused, not dropped silently", over.errors.length === 1 && /Over 120 characters/.test(over.errors[0]) && JSON.stringify(over.value.titles) === '["Owner"]', over.errors.join(" | "));
  check("  … and the plan says so if one reaches it", buildRequests({ targeting: t, people: { ...CLEANING_DEFAULTS, titles: ["Owner", long] }, geo }).notes.some((n) => n.includes("over 120 characters")));

  section("A2. AI Ark client: every documented answer");
  const scripted = (seq) => {
    let i = 0;
    const t2 = async (req) => {
      t2.calls.push(req);
      const s = seq[Math.min(i++, seq.length - 1)];
      if (s instanceof Error) throw s;
      return { status: s.status, headers: new Headers(s.headers ?? {}), text: s.json === undefined ? s.text ?? "" : JSON.stringify(s.json) };
    };
    t2.calls = [];
    return t2;
  };
  const SECRET = "SECRET-TOKEN-123";
  const mk = (seq) => {
    const transport = scripted(seq);
    return { c: createAiArk({ token: SECRET, transport, wait: fastWait, rps: 5 }), transport };
  };
  const fails = async (fn) => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e;
    }
  };
  {
    const { c: cl } = mk([{ status: 200, json: { total: 5 } }]);
    check("credits 200 → total", (await cl.credits()) === 5);
  }
  for (const [status, json, kind] of [
    [401, { message: "No API key found in request" }, "key"],
    [402, { status: 402, error: "not enough balance" }, "credits"],
    [403, { status: 403, error: "forbidden" }, "key"],
    [501, { message: "SOCIAL_MEDIA_FOLLOWER_PLATFORM_NOT_SUPPORTED" }, "unsupported"],
    [400, { timestamp: "x", status: 400, error: "bad filter", path: "" }, "bad_request"],
  ]) {
    const { c: cl } = mk([{ status, json }]);
    const e = await fails(() => cl.credits());
    check(`${status} → ${kind}`, e instanceof AiArkError && e.kind === kind && !e.message.includes(SECRET), e?.message);
  }
  {
    const { c: cl, transport } = mk([{ status: 429, json: { message: "API rate limit exceeded" } }, { status: 429, json: {} }, { status: 200, json: { total: 9 } }]);
    check("429, 429, 200 → waits and succeeds", (await cl.credits()) === 9 && transport.calls.length === 3);
  }
  {
    const { c: cl, transport } = mk([{ status: 429, json: {} }]);
    const e = await fails(() => cl.credits());
    check("429 seven times → rate", e?.kind === "rate" && transport.calls.length === 7, `${e?.kind} after ${transport.calls.length}`);
  }
  {
    const { c: cl, transport } = mk([{ status: 500, json: { status: 500, error: "unexpected error" } }]);
    const e = await fails(() => cl.credits());
    check("500 → retried 3 times → server", e?.kind === "server" && transport.calls.length === 3, `${e?.kind} after ${transport.calls.length}`);
  }
  {
    const { c: cl, transport } = mk([{ status: 500, json: { status: 500, error: "unexpected error" } }]);
    const e = await fails(() => cl.exportStart({}, { size: 10, webhook: "https://x.example/api/aiark/webhook" }));
    check("export start 500 → NOT retried (could buy twice)", e?.kind === "server" && transport.calls.length === 1);
  }
  {
    const { c: cl, transport } = mk([new TypeError("fetch failed")]);
    const e = await fails(() => cl.exportStart({}, { size: 10, webhook: "https://x.example/api/aiark/webhook" }));
    check("export start lost answer → NOT retried, network", e?.kind === "network" && transport.calls.length === 1);
  }
  {
    const { c: cl, transport } = mk([{ status: 429, json: {} }, { status: 200, json: { trackId: "t-1", state: "PENDING" } }]);
    const r3 = await cl.exportStart({}, { size: 10, webhook: "https://x.example/api/aiark/webhook" });
    check("export start 429 → retried (refused before processing)", r3.trackId === "t-1" && transport.calls.length === 2);
  }
  {
    const { c: cl, transport } = mk([new TypeError("fetch failed")]);
    const e = await fails(() => cl.preview({}, {}));
    check("preview network error → 3 tries → network", e?.kind === "network" && transport.calls.length === 3);
  }
  {
    const { c: cl } = mk([{ status: 404, json: { timestamp: "x", status: 404, error: "data not found", path: "" } }]);
    const r4 = await cl.preview({ contact: {} }, {});
    check("preview 404 → empty page", r4.content.length === 0 && r4.totalElements === 0);
  }
  {
    const { c: cl, transport } = mk([{ status: 200, json: { content: [{ id: "a" }], totalElements: 1, totalPages: 1 } }]);
    await cl.preview({ contact: { location: { any: { include: ["X"] } } } }, { page: 2, size: 100, lists: ["L1", "L2"] });
    const body = JSON.parse(transport.calls[0].body);
    check("preview body: filters + lists.people_id.exclude + page/size", body.page === 2 && body.size === 100 && JSON.stringify(body.lists) === '{"people_id":{"exclude":["L1","L2"]}}' && body.contact.location.any.include[0] === "X");
    check("X-TOKEN header carries the key", transport.calls[0].headers["X-TOKEN"] === SECRET && transport.calls[0].url.startsWith("https://api.ai-ark.com/api/developer-portal/v1/people/preview"));
  }
  {
    const { c: cl } = mk([{ status: 404, json: { status: 404, error: "track id expired or not found" } }]);
    check("statistics 404 → expired", (await fails(() => cl.exportStatus("t")))?.kind === "expired");
  }
  {
    const { c: cl } = mk([{ status: 403, json: { status: 4031013, error: "this request was automatically refunded …" } }]);
    const e = await fails(() => cl.exportStatus("t"));
    check("statistics 403 4031013 → refunded", e?.kind === "refunded" && e.code === 4031013);
  }
  {
    const { c: cl } = mk([{ status: 403, json: { status: 4031014, error: "this request was automatically refunded …" } }]);
    check("results 403 4031014 → refunded", (await fails(() => cl.exportResults("t", {})))?.kind === "refunded");
  }
  {
    const { c: cl } = mk([{ status: 403, json: { status: 403, error: "account restricted" } }]);
    check("a 403 on a track id with no refund code → key, not refunded", (await fails(() => cl.exportStatus("t")))?.kind === "key");
  }
  {
    const { c: cl } = mk([{ status: 409, json: { status: 409, error: "track id in progress" } }]);
    check("results 409 → not_ready", (await fails(() => cl.exportResults("t", {})))?.kind === "not_ready");
  }
  {
    const { c: cl } = mk([{ status: 400, json: { status: 400, error: "too many pending requests" } }]);
    check("400 too many pending → pending_cap", (await fails(() => cl.exportStart({}, { size: 1, webhook: "https://x" })))?.kind === "pending_cap");
  }
  {
    const { c: cl } = mk([{ status: 400, json: { status: 400, error: "terms_lookup_list_values_limit_exceeded 10000" } }]);
    check("lists 400 → list_limit", (await fails(() => cl.createList(["a"])))?.kind === "list_limit");
  }
  {
    const { c: cl } = mk([{ status: 200, json: { status: 200, error: null, data: { id: "p1" } }, headers: { "X-Credit": "-1.0" } }]);
    const r5 = await cl.exportSingle("p1");
    check("single v2 found → person, 1 credit from X-Credit", r5.found && r5.person.id === "p1" && r5.credits === 1);
  }
  {
    const { c: cl } = mk([{ status: 200, json: { status: 404, error: { status: 404, error: "no email found" }, data: null } }]);
    const r6 = await cl.exportSingle("p1");
    check("single v2 no email → not found, 0 credits", !r6.found && r6.reason === "no_email" && r6.credits === 0);
  }
  {
    const { c: cl } = mk([{ status: 200, json: { status: 404, error: { status: 404, error: "person not found" }, data: null } }]);
    check("single v2 person not found", (await cl.exportSingle("p1")).reason === "not_found");
  }
  {
    const { c: cl } = mk([{ status: 200, json: { content: [{ id: "a" }], totalPages: 3, totalElements: 250, last: false } }]);
    const r7 = await cl.exportResults("t", { page: 0 });
    check("results page envelope", r7.content.length === 1 && r7.totalPages === 3 && r7.last === false);
  }
  for (const [label, answer] of [
    ["a cut-off body", { status: 200, text: '{"content":[{"id":"a"' }],
    ["an empty body", { status: 200, text: "" }],
    ["a body with no list", { status: 200, json: {} }],
  ]) {
    check(`preview: ${label} → a failed read, not an empty page`, (await fails(() => mk([answer]).c.preview({}, {})))?.kind === "server");
    check(`results: ${label} → a failed read, not an empty page`, (await fails(() => mk([answer]).c.exportResults("t", {})))?.kind === "server");
  }
  {
    const empty = { status: 200, json: { content: [], totalElements: 0, totalPages: 0, last: true } };
    check("a real empty page still passes, on both", (await mk([empty]).c.preview({}, {})).content.length === 0 && (await mk([empty]).c.exportResults("t", {})).last === true);
  }
  {
    const { c: cl, transport } = mk([{ status: 500, json: { status: 500, error: "unexpected error" } }]);
    const e = await fails(() => cl.exportSingle("p1"));
    check("single 500 → NOT retried (each try can be charged)", e?.kind === "server" && transport.calls.length === 1, `${e?.kind} after ${transport.calls.length}`);
    check("single gets 90 seconds to answer", transport.calls[0].timeoutMs === 90_000, String(transport.calls[0].timeoutMs));
  }
  {
    const { c: cl, transport } = mk([new TypeError("fetch failed")]);
    const e = await fails(() => cl.exportSingle("p1"));
    check("single lost answer → NOT retried, network", e?.kind === "network" && transport.calls.length === 1);
  }
  {
    const { c: cl, transport } = mk([{ status: 429, json: {} }, { status: 200, json: { status: 200, error: null, data: { id: "p1" } } }]);
    check("single 429 → retried (refused before processing)", (await cl.exportSingle("p1")).found && transport.calls.length === 2);
  }
  {
    const { c: cl } = mk([{ status: 404, json: { timestamp: "x", status: 404, error: "data not found", path: "" } }]);
    const r8 = await cl.exportStart({}, { size: 10, webhook: "https://x.example/api/aiark/webhook" });
    check("export start 404 → empty, no job", r8.empty === true && !r8.trackId);
  }
  {
    const { c: cl, transport } = mk([{ status: 200, json: { content: [{ trackId: "t" }] } }]);
    const subs = await cl.exportSubmissions({ page: 2, size: 100, fullyRefunded: true });
    const q = new URL(transport.calls[0].url).searchParams;
    check("submissions: page, size, sort and the refunded filter", subs.length === 1 && q.get("page") === "2" && q.get("size") === "100" && q.get("sort") === "created,desc" && q.get("fullyRefunded") === "true", transport.calls[0].url);
  }
  for (const [label, answer] of [
    ["a 404", { status: 404, json: { timestamp: "x", status: 404, error: "data not found", path: "" } }],
    ["a cut-off body", { status: 200, text: '{"content":[{"trackId":"t"' }],
    ["a body with no list", { status: 200, json: {} }],
  ]) {
    check(`submissions: ${label} → a failed read, never "no exports" (that could post one again)`, (await fails(() => mk([answer]).c.exportSubmissions({})))?.kind === "server");
  }
  check("submissions: a real empty list still passes", (await mk([{ status: 200, json: { content: [] } }]).c.exportSubmissions({})).length === 0);
  {
    const { c: cl } = mk([new TypeError(`Headers.append: "first ${SECRET}" is an invalid header value.`)]);
    const e = await fails(() => cl.credits());
    check("an error quoting the key never reaches the message", e?.kind === "network" && !e.message.includes(SECRET), e?.message);
  }
  {
    const { c: cl } = mk([Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })]);
    check("a network error's code is kept", /ECONNRESET/.test((await fails(() => cl.credits()))?.message ?? ""));
  }

  section("A3. What AI Ark returned → cells");
  const demo = createDemoTransport({});
  const dc = createAiArk({ token: DEMO_TOKEN, transport: demo, wait: fastWait });
  const page = await dc.preview({ contact: { location: { any: { include: ["Armonk, New York"] } }, experience: { latest: { title: { any: { include: { mode: "WORD", content: ["Office Manager"] } } } } } } }, { size: 100 });
  const item = page.content[0];
  const pin = personInputs(item);
  check("preview item: masked last name, no email, id kept", /\*\*\*/.test(pin.full_name) && !pin.email && pin.aiark_id === item.id);
  check("demo preview answered 1 credit", demo.state.charged === 1);
  const withEmail = page.content.map((x) => x.id).find(Boolean);
  let fullFound = null;
  for (const x of page.content) {
    const got = await dc.exportSingle(x.id);
    if (got.found) {
      fullFound = got;
      break;
    }
  }
  const fin = personInputs(fullFound.person);
  check("single export: full name, VALID email, .example domain, LinkedIn on linkedin.example",
    !/\*\*\*/.test(fin.full_name) && fin.email_status === "VALID" && fin.email.endsWith(".example") && fin.domain.endsWith(".example") && fin.linkedin.startsWith("https://linkedin.example/"), JSON.stringify(fin));
  check("a metro area reads as its state", personInputs({ id: "x", location: { city: "Springfield", state: "Illinois Metropolitan Area", country: "United States" } }).state === "Illinois" && personInputs({ id: "x", location: { state: "Illinois" } }).state === "Illinois");
  check("processing email → PENDING", personInputs({ id: "x", email: { state: "PROCESSING", output: [] } }).email_status === "PENDING");
  check("not found email → no email cells", (() => {
    const x = personInputs({ id: "x", email: { state: "DONE", output: [{ found: false, status: "INVALID", subStatus: "MAILBOX_NOT_FOUND", domainType: "UNKNOWN" }] } });
    return !x.email && !x.email_status;
  })());
  check("staff → size text", personInputs({ id: "x", company: { summary: { staff: { total: 113, range: { start: 11, end: 50 } } } } }).company_size === "113 (11–50)");
  void withEmail;
  {
    const cutEmoji = personInputs({ id: "x", company: { summary: { description: `${"x".repeat(4_999)}\u{1F600} and more` } } }).company_description;
    check("a description cut at 5,000 never splits an emoji in two", cutEmoji.length === 4_999 && cutEmoji.isWellFormed(), String(cutEmoji.length));
    check("a lone half of an emoji, as AI Ark may send it, becomes U+FFFD", clip("Owner \uD83D", 100) === "Owner \u{FFFD}" && clip("\uDE00x", 100) === "\u{FFFD}x");
  }

  {
    const tx = createDemoTransport({ jobMs: 0, faults: { refundJobOnce: true } });
    const cl = createAiArk({ token: DEMO_TOKEN, transport: tx, wait: fastWait });
    const { trackId } = await cl.exportStart({ contact: { location: { any: { include: ["Dayton, Ohio"] } } } }, { size: 5, webhook: "https://x.example/api/aiark/webhook" });
    const e = await fails(() => cl.exportStatus(trackId));
    const again = await fails(() => cl.exportResults(trackId, {}));
    check("the stand-in's refund carries AI Ark's real code, each time it is asked", e?.kind === "refunded" && e.code === 4031013 && again?.kind === "refunded" && again.code === 4031013, `${e?.kind} ${e?.code} ${again?.kind}`);
    const listed = await cl.exportSubmissions({ fullyRefunded: true });
    check("  … and lists the job as refunded", listed.length === 1 && listed[0].trackId === trackId && listed[0].fullyRefunded === true);
  }

  section("A4. The key and the rate");
  const live = (env, rps) => aiArkFor("live", { env, db: pool, rps });
  check("no key → no client", (await live({})).client === null);
  const broken = await live({ AIARK_API_KEY: "first-line\nSECRET-REST-OF-KEY" });
  check("a key with a line break inside is refused, and not quoted", broken.client === null && /line break/.test(broken.why) && !broken.why.includes("SECRET"), broken.why);
  check("a trailing newline is trimmed", Boolean((await live({ AIARK_API_KEY: "a-key\n" })).client));
  check("the worker's rate: 4 a second, or AIARK_RPS", (await live({ AIARK_API_KEY: "a-key" })).client.stats.gapMs === 250 && (await live({ AIARK_API_KEY: "a-key", AIARK_RPS: "2" })).client.stats.gapMs === 500);
  check("a caller's rate wins over AIARK_RPS", (await live({ AIARK_API_KEY: "a-key", AIARK_RPS: "4" }, 1)).client.stats.gapMs === 1000);
  const server = source("src/lib/aiark/server.ts");
  check("the web app asks for 1 a second unless AIARK_RPS_WEB says otherwise", /env\.AIARK_RPS_WEB && Number\.isFinite\(rps\) \? rps : 1/.test(server) && !/export \{[^}]*aiArkFor[^}]*\} from/.test(server));
}

// ── B. Runs against the database ────────────────────────────────────────────

const TERMINAL = new Set(["done", "stopped", "error", "cancelled"]);

let searches = 0;
/** A search of its own: a title no other test asks for gives made-up people no other test has bought. */
const search = (places = ["Dayton, Ohio"]) => ({
  contact: {
    location: { any: { include: places } },
    experience: { latest: { title: { any: { include: { mode: "WORD", content: [`Office Manager ${++searches}`] } } } } },
  },
});
const SEVERAL_PLACES = ["Dayton, Ohio", "Akron, Ohio", "Toledo, Ohio", "Canton, Ohio", "Parma, Ohio"];

async function newRun({ strategy = "single", size, people = TEST_PEOPLE, mode = "demo", requests = null }) {
  // Every run here starts with the day's list budget unused; spendLists uses it up.
  await pool.query(`UPDATE aiark_runs SET progress = progress - 'lists_log' WHERE id = ANY($1::uuid[])`, [created.runs]);
  const geo = await loadGeo(pool);
  const targeting = await one(`SELECT * FROM client_targeting WHERE client_tag = $1`, [TAG]);
  const built = buildRequests({ targeting, people, geo });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await createRun(client, { tag: TAG, mode, strategy, size, filters: { people, report: built.report }, requests: requests ?? built.requests });
    await client.query("COMMIT");
    created.runs.push(run.id);
    created.tables.push(run.table_id);
    return run;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

const demoClient = (transport, token = DEMO_TOKEN) => async () => ({ client: createAiArk({ token, transport, wait: fastWait, rps: 5 }) });

async function drive(runId, clientFor, { limit = 600 } = {}) {
  for (let i = 0; i < limit; i++) {
    const st = await one(`SELECT status FROM aiark_runs WHERE id = $1`, [runId]);
    if (TERMINAL.has(st.status)) return st.status;
    const worked = await advanceOneRun({ pool, env: { AIARK_DEMO: "1" }, clientFor, log: () => {} });
    if (!worked) await pool.query(`UPDATE aiark_runs SET next_run_at = now() WHERE id = $1 AND status IN ('queued', 'running')`, [runId]);
  }
  throw new Error(`run ${runId} did not finish`);
}

const runRow = (id) => one(`SELECT * FROM aiark_runs WHERE id = $1`, [id]);
const step = (clientFor, extra = {}) => advanceOneRun({ pool, env: { AIARK_DEMO: "1" }, clientFor, log: () => {}, ...extra });
const due = (id) => pool.query(`UPDATE aiark_runs SET next_run_at = now() WHERE id = $1`, [id]);

/** A cancelled run goes on reading its job; finished_at says when it is really over. */
async function driveFinished(id, clientFor, { limit = 300 } = {}) {
  for (let i = 0; i < limit; i++) {
    if ((await runRow(id)).finished_at) return;
    if (!(await step(clientFor))) await due(id);
  }
  throw new Error(`run ${id} did not finish`);
}
/** Ends a run a test has finished with, so the next test's slices don't pick it up. */
const settle = (id) => pool.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now(), claim_token = NULL WHERE id = $1 AND finished_at IS NULL`, [id]);
const setProgress = (id, patch) => pool.query(`UPDATE aiark_runs SET next_run_at = now(), progress = progress || $2::jsonb WHERE id = $1`, [id, JSON.stringify(patch)]);
const spendLists = (id, n = 45) => setProgress(id, { lists_log: Array(n).fill(new Date().toISOString()) });
const backdateJob = (id, field, ago) =>
  pool.query(
    `UPDATE aiark_runs SET next_run_at = now(),
            progress = jsonb_set(progress, ARRAY['job', $2::text], to_jsonb(to_char((now() - $3::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
      WHERE id = $1`,
    [id, field, ago]
  );
/** A submission whose answer was lost, moved back in time: when it was sent and when the answer was lost. */
const lostAgo = async (id, ago) => {
  await backdateJob(id, "submitting_at", ago);
  await backdateJob(id, "lost_at", ago);
};
/** People in the registry with no run, so a list has to cover them. */
const holdPeople = (n) => pool.query(`INSERT INTO aiark_people (person_id, demo) SELECT 'aiark-test-' || gen_random_uuid(), true FROM generate_series(1, $1)`, [n]);
const dropHeldPeople = () => pool.query(`DELETE FROM aiark_people WHERE person_id LIKE 'aiark-test-%'`);

// What the routes really send, read from their files.
const cancelSql = /`(UPDATE aiark_runs[\s\S]*?)`/.exec(source("src/app/api/aiark/runs/cancel/route.ts"))[1];
const cancelRoute = (id) => one(cancelSql, [id]);
const activeSql = /`(SELECT id, status FROM aiark_runs[\s\S]*?)`/.exec(source("src/app/api/aiark/runs/route.ts"))[1];

// Scripted answers over the stand-in.
const ans = (status, json) => ({ status, headers: new Headers(), text: JSON.stringify(json) });
const overlay = (tx, fn) => async (req) => (await fn(req)) ?? tx(req);
const isPost = (req) => req.method === "POST" && req.url.endsWith("/v1/people/export");
const PENDING = ans(200, { statistics: { total: 0, found: 0 }, state: "PENDING" });
const flaky = (match, times) => ({
  query: async (sql, params) => {
    if (times > 0 && match(sql, params)) {
      times--;
      throw new Error("Connection terminated unexpectedly");
    }
    return pool.query(sql, params);
  },
});
/** A statement that commits, and whose answer is then lost on the way back. */
const answerLost = (match, times = 1) => ({
  query: async (sql, params) => {
    const res = await pool.query(sql, params);
    if (times > 0 && match(sql, params)) {
      times--;
      throw new Error("Connection terminated unexpectedly");
    }
    return res;
  },
});
async function tableStats(tableId, runId) {
  return one(
    `SELECT (SELECT count(*)::int FROM enrich_rows WHERE table_id = $1) AS rows,
            (SELECT count(DISTINCT row_key)::int FROM enrich_rows WHERE table_id = $1) AS keys,
            (SELECT count(*)::int FROM aiark_people WHERE run_id = $2) AS registered,
            (SELECT count(*)::int FROM enrich_cells WHERE table_id = $1 AND column_key = 'email_status' AND value = '"VALID"'::jsonb) AS valid`,
    [tableId, runId]
  );
}
const personIds = async (tableId) =>
  new Set((await pool.query(`SELECT value #>> '{}' AS id FROM enrich_cells WHERE table_id = $1 AND column_key = 'aiark_id'`, [tableId])).rows.map((r) => r.id));

let pendingTable = null;

async function partB() {
  section("B1. Single pull, end to end (demo)");
  const transport = createDemoTransport({ jobMs: 150 });
  const cf = demoClient(transport);
  // Demo people already bought by earlier demo runs in this database (kept: only this script's runs are removed).
  const { held: heldAtStart } = await one(`SELECT count(*)::int AS held FROM aiark_people WHERE demo`);
  const r1 = await newRun({ size: 120 });
  const status1 = await drive(r1.id, cf);
  const a = await runRow(r1.id);
  const s1 = await tableStats(r1.table_id, r1.id);
  check("run done, 120 pulled", status1 === "done" && a.pulled === 120, `${status1} ${a.pulled} ${a.last_error ?? ""}`);
  check("120 rows, 120 distinct people, 120 registered", s1.rows === 120 && s1.keys === 120 && s1.registered === 120, JSON.stringify(s1));
  check("credits on the run = credits AI Ark charged", Number(a.credits_used) === transport.state.charged, `${a.credits_used} vs ${transport.state.charged}`);
  check("with_email = rows with a VALID email", a.with_email === s1.valid, `${a.with_email} vs ${s1.valid}`);
  check("credits before/after recorded", a.credits_before != null && a.credits_after != null && Number(a.credits_before) - Number(a.credits_after) === Number(a.credits_used));
  check("lists made only for people already held", Array.isArray(a.progress.lists) && a.progress.lists.length === (heldAtStart ? 1 : 0) && a.progress.excluded === heldAtStart, `${a.progress.lists?.length} lists, ${a.progress.excluded} of ${heldAtStart}`);

  section("B2. Second run, same filters: nobody bought twice");
  const r2 = await newRun({ size: 120 });
  const status2 = await drive(r2.id, cf);
  const b = await runRow(r2.id);
  const ids1 = await personIds(r1.table_id);
  const ids2 = await personIds(r2.table_id);
  check("run done, 120 pulled", status2 === "done" && b.pulled === 120);
  check("an exclusion list covers everyone already bought", b.progress.lists.length === 1 && b.progress.excluded === heldAtStart + 120, `${b.progress.lists.length} lists, ${b.progress.excluded}`);
  check("no person in both runs", [...ids2].filter((x) => ids1.has(x)).length === 0);
  const dup = await one(`SELECT count(*)::int AS n FROM (SELECT person_id FROM aiark_people GROUP BY 1 HAVING count(*) > 1) d`);
  check("registry has no duplicate person", dup.n === 0);

  section("B3. Crash mid-slice, then resume");
  let gate = null;
  let hungCalls = 0;
  const hanging = async (req) => {
    if (req.url.includes("/export/single")) {
      hungCalls++;
      if (hungCalls === 11) {
        await new Promise((res) => { gate = res; });
      }
    }
    return transport(req);
  };
  const r3 = await newRun({ size: 60 });
  const charged0 = transport.state.charged;
  const stuck = advanceOneRun({ pool, env: { AIARK_DEMO: "1" }, clientFor: demoClient(hanging), log: () => {} });
  for (let i = 0; i < 200 && !gate; i++) await sleep(20);
  const mid = await runRow(r3.id);
  check("slice stuck after 10 people (the 11th call never answered)", gate !== null && mid.pulled === 10, `pulled ${mid.pulled}`);
  await pool.query(`UPDATE aiark_runs SET claimed_at = now() - interval '11 minutes' WHERE id = $1`, [r3.id]); // the lease runs out
  const status3 = await drive(r3.id, cf);
  gate(); // the old slice wakes up: its write must be refused
  await stuck;
  const c3 = await runRow(r3.id);
  const s3 = await tableStats(r3.table_id, r3.id);
  check("resumed run done, exactly 60 pulled", status3 === "done" && c3.pulled === 60, `${status3} ${c3.pulled}`);
  check("60 rows, all distinct, 60 registered", s3.rows === 60 && s3.keys === 60 && s3.registered === 60, JSON.stringify(s3));
  check("credits counted for every paid call (the stuck one too)", Number(c3.credits_used) === transport.state.charged - charged0, `${c3.credits_used} vs ${transport.state.charged - charged0}`);

  section("B4. Cancel");
  const r4q = await newRun({ size: 50 });
  await pool.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [r4q.id]);
  const claimedQ = await advanceOneRun({ pool, env: {}, clientFor: cf, log: () => {} });
  check("a cancelled queued run is never claimed", claimedQ === null && (await runRow(r4q.id)).pulled === 0);
  let singles = 0;
  const r4 = await newRun({ size: 150 });
  const cancelling = async (req) => {
    if (req.url.includes("/export/single") && ++singles === 6) {
      await pool.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [r4.id]);
    }
    return transport(req);
  };
  await advanceOneRun({ pool, env: {}, clientFor: demoClient(cancelling), log: () => {} });
  const d = await runRow(r4.id);
  check("cancelled mid-slice: stopped after the person in flight", d.status === "cancelled" && d.pulled === 6 && d.claim_token === null, `${d.status} ${d.pulled}`);
  check("cancelled run is not claimed again", (await advanceOneRun({ pool, env: {}, clientFor: cf, log: () => {} })) === null);
  await cancelExports();

  section("B5. Out of credits");
  const poor = createDemoTransport({ balance: 25 });
  const r5 = await newRun({ size: 200 });
  const status5 = await drive(r5.id, demoClient(poor));
  const e5 = await runRow(r5.id);
  check("stopped with the reason", status5 === "stopped" && /ran out of credits/.test(e5.stop_reason ?? ""), `${status5} ${e5.stop_reason}`);
  check("never spent more than it had", Number(e5.credits_used) <= 25 && e5.pulled > 0 && e5.pulled < 200, `${e5.credits_used} credits, ${e5.pulled} pulled`);

  section("B6. A refused key");
  const r6 = await newRun({ size: 10 });
  const status6 = await drive(r6.id, demoClient(transport, "wrong-key"));
  const f6 = await runRow(r6.id);
  check("error: AI Ark refused the key", status6 === "error" && /refused the key/.test(f6.last_error ?? "") && f6.pulled === 0, `${status6} ${f6.last_error}`);

  section("B7. Export pull (async job), end to end");
  const ex = createDemoTransport({ jobMs: 150 });
  const r7 = await newRun({ strategy: "export", size: 250 });
  const status7 = await drive(r7.id, demoClient(ex));
  const g = await runRow(r7.id);
  const s7 = await tableStats(r7.table_id, r7.id);
  check("export run done, 250 pulled, 250 rows / registered", status7 === "done" && g.pulled === 250 && s7.rows === 250 && s7.registered === 250, `${status7} ${g.pulled} ${JSON.stringify(s7)} ${g.last_error ?? ""}`);
  check("credits = 0.5 a person + 0.5 a valid email = what AI Ark charged", Number(g.credits_used) === 0.5 * 250 + 0.5 * s7.valid && Number(g.credits_used) === ex.state.charged, `${g.credits_used} vs ${0.5 * 250 + 0.5 * s7.valid} vs ${ex.state.charged}`);
  const masked = await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key = 'full_name' AND value #>> '{}' LIKE '%***%'`, [r7.table_id]);
  check("export rows carry full names (nothing masked)", masked.n === 0);

  for (const [label, faults] of [
    ["refunded before reading → submitted again", { refundJobOnce: true }],
    ["refunded after DONE → submitted again", { refundAtReadOnce: true }],
    ["gone (404) and listed as refunded → submitted again", { expireRefundedOnce: true }],
  ]) {
    const tx = createDemoTransport({ jobMs: 100, faults });
    let posts = 0;
    const run = await newRun({ strategy: "export", size: 120 });
    const st = await drive(run.id, demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; })));
    const rr = await runRow(run.id);
    const ss = await tableStats(run.table_id, run.id);
    check(`export ${label}`, st === "done" && rr.pulled === 120 && ss.keys === 120 && posts === 2 && /refunded|no longer has/.test(rr.progress.last_refund ?? ""), `${st} ${rr.pulled} posts ${posts} ${rr.last_error ?? ""}`);
    check(`  … credits match what AI Ark kept`, Number(rr.credits_used) === tx.state.charged, `${rr.credits_used} vs ${tx.state.charged}`);
    check(`  … the count of refunds clears once a job is read`, rr.progress.resubmits === 0, String(rr.progress.resubmits));
  }
  await expiredExports();

  {
    const tx = createDemoTransport({ jobMs: 50, processingMs: 400 });
    const run = await newRun({ strategy: "export", size: 100 });
    const st = await drive(run.id, async (m) => {
      await sleep(120);
      return demoClient(tx)(m);
    });
    const pend = await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key = 'email_status' AND value = '"PENDING"'::jsonb`, [run.table_id]);
    check("export with emails still processing → waited and re-read (no PENDING rows)", st === "done" && pend.n === 0, `${st} pending ${pend.n}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 50, processingMs: 3_600_000 });
    const run = await newRun({ strategy: "export", size: 100 });
    for (let i = 0; i < 20; i++) {
      await advanceOneRun({ pool, env: {}, clientFor: demoClient(tx), log: () => {} });
      const p = (await runRow(run.id)).progress;
      if (p.job?.page_wait_since) break;
      await pool.query(`UPDATE aiark_runs SET next_run_at = now() WHERE id = $1`, [run.id]);
      await sleep(60);
    }
    const waiting = await runRow(run.id);
    check("a page with emails still processing waits, 30 s apart, with nothing written", waiting.pulled === 0 && Boolean(waiting.progress.job?.page_wait_since) && new Date(waiting.next_run_at) - Date.now() > 20_000, `${waiting.pulled} ${waiting.next_run_at}`);
    await backdateJob(run.id, "page_wait_since", "119 minutes");
    await step(demoClient(tx));
    check("  … still waiting just under 2 hours", (await runRow(run.id)).pulled === 0);
    await backdateJob(run.id, "page_wait_since", "121 minutes");
    const st = await drive(run.id, demoClient(tx));
    const pend = await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key = 'email_status' AND value = '"PENDING"'::jsonb`, [run.table_id]);
    check("  … taken as is after 2 hours (PENDING rows)", st === "done" && pend.n > 0, `${st} pending ${pend.n}`);
    pendingTable = run.table_id;
  }
  {
    const tx = createDemoTransport({ jobMs: 0, processingMs: 3_600_000 });
    const run = await newRun({ strategy: "export", size: 200, requests: [search(SEVERAL_PLACES)] });
    const cf2 = demoClient(tx);
    for (let i = 0; i < 6 && !(await runRow(run.id)).progress.job?.page_wait_since; i++) {
      await step(cf2);
      await due(run.id);
    }
    await backdateJob(run.id, "page_wait_since", "121 minutes");
    await step(cf2); // page 0 is written
    await due(run.id);
    await step(cf2); // page 1 starts its own wait
    const j = (await runRow(run.id)).progress.job;
    check("the wait is per page: the next page gets its own 2 hours", j?.page === 1 && Date.now() - Date.parse(j.page_wait_since) < 60_000, JSON.stringify(j));
    await backdateJob(run.id, "submitted_at", "12 hours");
    const st = await drive(run.id, cf2);
    check("  … and past the job's 11 hours no page waits: the rest is read, not lost", st === "done" && (await runRow(run.id)).pulled === 200, st);
  }
  {
    const tx = createDemoTransport({ jobMs: 80 });
    let dropped = false;
    const lossy = async (req) => {
      const res = await tx(req);
      if (!dropped && req.method === "POST" && req.url.endsWith("/v1/people/export")) {
        dropped = true;
        throw new TypeError("fetch failed: socket hang up"); // AI Ark took the job; we never heard
      }
      return res;
    };
    const run = await newRun({ strategy: "export", size: 90 });
    const st = await drive(run.id, demoClient(lossy));
    const rr = await runRow(run.id);
    const jobs = (await createAiArk({ token: DEMO_TOKEN, transport: tx, wait: fastWait }).exportSubmissions({ size: 25 })).length;
    check("export whose answer was lost → adopted, not submitted twice", st === "done" && rr.pulled === 90 && jobs === 1 && rr.progress.job == null, `${st} pulled ${rr.pulled} jobs ${jobs}`);
    check("  … charged once", Number(rr.credits_used) === tx.state.charged, `${rr.credits_used} vs ${tx.state.charged}`);
  }
  await exportLoops();

  section("B8. Webhook address rules (live mode)");
  const site = { NEXT_PUBLIC_SITE_URL: "https://app.example" };
  const ours = "https://app.example/api/aiark/webhook";
  check("no address → export unavailable", !webhookFor("live", {}).url);
  check("http refused", !webhookFor("live", { AIARK_WEBHOOK_URL: "http://x.example/api/aiark/webhook" }).url);
  check("localhost refused", !webhookFor("live", { AIARK_WEBHOOK_URL: "https://localhost:3000/api/aiark/webhook" }).url);
  check("a wrong path refused", !webhookFor("live", { ...site, AIARK_WEBHOOK_URL: "https://app.example/abc" }).url);
  check("someone else's host refused, right path or not", !webhookFor("live", { ...site, AIARK_WEBHOOK_URL: "https://someone-else.example/api/aiark/webhook" }).url);
  check("this app's public https route accepted", webhookFor("live", { ...site, AIARK_WEBHOOK_URL: ours }).url === ours);
  check("a site address with no scheme still compares", webhookFor("live", { NEXT_PUBLIC_SITE_URL: "app.example", AIARK_WEBHOOK_URL: ours }).url === ours);
  check("with no site address the host can't be checked", webhookFor("live", { AIARK_WEBHOOK_URL: ours }).url === ours);

  await heldJobs();
  await lists();
  await adoption();
  await writes();
  await brake();
  await lostAnswers();
  await recovered();

  const left = await one(`SELECT count(*)::int AS n FROM aiark_runs WHERE id = ANY($1::uuid[]) AND finished_at IS NULL`, [created.runs]);
  check("every run here has ended", left.n === 0, `${left.n} still open`);
  return { r1 };
}

// ── B, continued: the cases that need a run in a particular state ───────────

/** B4. Cancel means no new paid calls, and everything already paid for still gets read. */
async function cancelExports() {
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    let open = false;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) posts++;
      if (!open && req.url.includes("/statistics")) return PENDING;
    }));
    const run = await newRun({ strategy: "export", size: 5000, requests: [search(), search()] });
    await step(cf); // AI Ark takes the job
    const said = await cancelRoute(run.id);
    const c1 = await runRow(run.id);
    check("cancel with an export out: cancelled, not finished, job kept", said?.holds_job === true && c1.status === "cancelled" && c1.finished_at === null && Boolean(c1.progress.job?.track_id), JSON.stringify(said));
    await due(run.id);
    check("  … it still counts as work for a worker draining the queue", (await runDue(pool)) === true);
    check("  … the worker still claims it and leaves it cancelled", (await step(cf)) === run.id && (await runRow(run.id)).status === "cancelled");
    check("  … and a new run for the client has to wait for it", (await pool.query(activeSql, [TAG])).rows[0]?.status === "cancelled");
    open = true;
    await driveFinished(run.id, cf);
    const c2 = await runRow(run.id);
    const s = await tableStats(run.table_id, run.id);
    check("  … read to the end: every paid person in the table and the registry", c2.status === "cancelled" && c2.pulled > 0 && s.rows === c2.pulled && s.registered === c2.pulled && c2.progress.job === null, `${c2.status} ${c2.pulled} ${JSON.stringify(s)}`);
    check("  … its price recorded", Number(c2.credits_used) === tx.state.charged && tx.state.charged > 0, `${c2.credits_used} vs ${tx.state.charged}`);
    check("  … and no new job for the next location group", posts === 1, `${posts} posts`);
    check("  … then it is left alone, and a new run can start", (await step(cf)) === null && (await pool.query(activeSql, [TAG])).rows.length === 0);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let reads = 0;
    let id = null;
    const cf = demoClient(overlay(tx, async (req) => {
      if (req.url.includes("/inquiries") && ++reads === 2) await cancelRoute(id);
    }));
    const run = await newRun({ strategy: "export", size: 5000, requests: [search(SEVERAL_PLACES)] });
    id = run.id;
    await driveFinished(id, cf);
    const c = await runRow(id);
    const s = await tableStats(run.table_id, id);
    check("cancel part-way through reading: the rest is still read", reads > 2 && c.status === "cancelled" && Number(c.credits_used) === 0.5 * c.pulled + 0.5 * s.valid, `${reads} reads, ${c.status}, ${c.credits_used} for ${c.pulled}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; }));
    const run = await newRun({ strategy: "export", size: 100, requests: [search()] });
    const racing = {
      query: async (sql, params) => {
        if (sql.startsWith("UPDATE aiark_runs SET progress") && params[2]?.job?.submitting_at) await cancelRoute(run.id);
        return pool.query(sql, params);
      },
    };
    await step(cf, { pool: racing });
    const c = await runRow(run.id);
    check("a cancel landing just before the export goes out: nothing is posted", posts === 0 && c.status === "cancelled" && c.finished_at !== null && c.progress.job === null, `${posts} posts, ${c.status}, ${JSON.stringify(c.progress.job)}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let said = null;
    let id = null;
    const cf = demoClient(overlay(tx, async (req) => { if (isPost(req)) said = await cancelRoute(id); }));
    const run = await newRun({ strategy: "export", size: 5000, requests: [search(), search()] });
    id = run.id;
    await driveFinished(id, cf);
    const c = await runRow(id);
    check("a cancel while the export is on its way: the job is read all the same", said?.holds_job === true && said.track_id === null && c.status === "cancelled" && c.pulled > 0 && Number(c.credits_used) === tx.state.charged, `${JSON.stringify(said)} ${c.pulled}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0, faults: { refundAtReadOnce: true } });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; }));
    const run = await newRun({ strategy: "export", size: 100, requests: [search()] });
    await step(cf);
    await cancelRoute(run.id);
    await driveFinished(run.id, cf);
    const c = await runRow(run.id);
    check("a cancelled run whose job is refunded buys nothing new", posts === 1 && c.status === "cancelled" && Number(c.credits_used) === 0 && tx.state.charged === 0, `${posts} posts, ${c.credits_used} credits`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) {
        posts++;
        throw new TypeError("fetch failed");
      }
    }));
    const run = await newRun({ strategy: "export", size: 100, requests: [search()] });
    await step(cf);
    await cancelRoute(run.id);
    await lostAgo(run.id, "3 minutes");
    await driveFinished(run.id, cf);
    const c = await runRow(run.id);
    check("a cancelled run whose export never reached AI Ark ends without posting again", posts === 1 && c.status === "cancelled" && c.progress.job === null, `${posts} posts, ${JSON.stringify(c.progress.job)}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0, faults: { expireJobOnce: true } });
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 100, requests: [search()] });
    await step(cf);
    await cancelRoute(run.id);
    await driveFinished(run.id, cf);
    const c = await runRow(run.id);
    const track = c.progress.job?.track_id;
    check("a cancelled run whose paid job then can't be read ends as failed, not as a plain cancel", c.status === "error" && Boolean(track) && c.last_error.includes(track) && Number(c.credits_used) === tx.state.charged, `${c.status} ${c.last_error}`);
  }
  {
    // What the Clay tab and the AI Ark tab are told about a cancelled run, read with their own SQL.
    const tablesSql = /`(SELECT t\.id, t\.client_tag[\s\S]*?)`/.exec(source("src/app/api/enrich/tables/route.ts"))[1];
    const fields = /RUN_FIELDS = `([\s\S]*?)`/.exec(source("src/lib/aiark/server.ts"))[1];
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    const shown = async () => ({
      clay: (await one(`SELECT x.run FROM (${tablesSql}) x WHERE x.id = $1`, [run.table_id])).run.finishing,
      aiArk: (await one(`SELECT ${fields} FROM aiark_runs r LEFT JOIN user_profiles up ON up.id = r.created_by WHERE r.id = $1`, [run.id])).finishing,
    });
    await pool.query(`UPDATE aiark_runs SET status = 'cancelled', progress = progress || '{"job": {"track_id": "held"}}' WHERE id = $1`, [run.id]);
    const holding = await shown();
    // The job is read and cleared, and the finish that sets finished_at never ran (a crash, a lost connection).
    await pool.query(`UPDATE aiark_runs SET progress = progress || '{"job": null}' WHERE id = $1`, [run.id]);
    const read = await shown();
    check("the Clay tab shows a cancelled run as finishing only while it holds its paid job, as the AI Ark tab does", holding.clay === true && holding.aiArk === true && read.clay === false && !read.aiArk, `${JSON.stringify(holding)} ${JSON.stringify(read)}`);
    await settle(run.id);
  }
}

/** B7. A 404 on a held job never buys anything by itself: only a refund AI Ark lists does. */
async function expiredExports() {
  {
    const tx = createDemoTransport({ jobMs: 0, faults: { expireJobOnce: true } });
    let posts = 0;
    const run = await newRun({ strategy: "export", size: 120, requests: [search(SEVERAL_PLACES)] });
    const st = await drive(run.id, demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; })));
    const rr = await runRow(run.id);
    const track = rr.progress.job?.track_id;
    check("export gone with no refund → error naming the job, not bought again", st === "error" && posts === 1 && Boolean(track) && rr.last_error.includes(track) && /0 of its 120 people/.test(rr.last_error), `${st} posts ${posts} ${rr.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(overlay(tx, (req) =>
      req.url.includes("/inquiries") && new URL(req.url).searchParams.get("page") === "1" ? ans(404, { status: 404, error: "track id expired or not found", path: "" }) : undefined));
    const run = await newRun({ strategy: "export", size: 150, requests: [search(SEVERAL_PLACES)] });
    const st = await drive(run.id, cf);
    const rr = await runRow(run.id);
    check("  … part-way through reading, it says how many were read", st === "error" && /100 of its 150 people/.test(rr.last_error), `${st} ${rr.last_error}`);
  }
  const lookup = async (pageOf) => {
    const tx = createDemoTransport({ jobMs: 0, faults: { expireJobOnce: true } });
    const asked = [];
    let posts = 0;
    const run = await newRun({ strategy: "export", size: 50, requests: [search(SEVERAL_PLACES)] });
    const cf = demoClient(overlay(tx, async (req) => {
      if (isPost(req)) posts++;
      const u = new URL(req.url);
      if (u.pathname.endsWith("/submissions") && u.searchParams.get("fullyRefunded") === "true") {
        const page = Number(u.searchParams.get("page"));
        asked.push(page);
        return ans(200, { content: pageOf(page, (await runRow(run.id)).progress.job.track_id) });
      }
    }));
    return { st: await drive(run.id, cf), asked: asked.join(), posts };
  };
  const recent = (page) => Array.from({ length: 100 }, (_, i) => ({ trackId: `other-${page}-${i}`, fullyRefunded: true, created: new Date().toISOString() }));
  const found = await lookup((page, track) => (page === 3 ? [...recent(page).slice(1), { trackId: track, fullyRefunded: true, created: new Date().toISOString() }] : recent(page)));
  check("the refund lookup pages back until it finds the job", found.st === "done" && found.asked === "0,1,2,3" && found.posts === 2, JSON.stringify(found));
  const old = await lookup((page) => (page === 1 ? recent(page).map((s) => ({ ...s, created: new Date(Date.now() - 2 * 3600_000).toISOString() })) : recent(page)));
  check("  … stops at submissions older than the job", old.st === "error" && old.asked === "0,1" && old.posts === 1, JSON.stringify(old));
  const far = await lookup((page) => recent(page));
  check("  … and never reads more than 5 pages", far.st === "error" && far.asked === "0,1,2,3,4" && far.posts === 1, JSON.stringify(far));
  const unrefunded = await lookup((page, track) => [{ trackId: track, fullyRefunded: false, created: new Date().toISOString() }]);
  check("  … and goes by the row's own flag, so an unrefunded job is never bought again", unrefunded.st === "error" && unrefunded.posts === 1, JSON.stringify(unrefunded));
  {
    const tx = createDemoTransport({ jobMs: 0, faults: { expireJobOnce: true } });
    let posts = 0;
    let lookups = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) posts++;
      if (req.url.includes("/submissions") && ++lookups === 1) return ans(404, { timestamp: "x", status: 404, error: "data not found", path: "" });
    }));
    const run = await newRun({ strategy: "export", size: 50, requests: [search(SEVERAL_PLACES)] });
    await step(cf);
    await due(run.id);
    await step(cf);
    const a = await runRow(run.id);
    check("  … a lookup that can't be read holds the job: it neither ends the run nor buys again", a.status === "running" && Boolean(a.progress.job?.track_id) && a.attempts === 1 && posts === 1, `${a.status} ${a.attempts} posts ${posts} ${a.last_error}`);
    const st = await drive(run.id, cf);
    check("  … and the next lookup decides", st === "error" && posts === 1 && lookups === 2, `${st} posts ${posts} lookups ${lookups}`);
  }
}

/** B7. Loops that could pay or run for ever, and the writes around a job's price. */
async function exportLoops() {
  {
    const tx = createDemoTransport({ jobMs: 0, faults: { ignoreLists: true } });
    let posts = 0;
    let refunded = false;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) posts++;
      if (!refunded && req.url.includes("/inquiries") && new URL(req.url).searchParams.get("page") === "1") {
        refunded = true;
        return ans(403, { status: 4031013, error: "this request was automatically refunded" });
      }
    }));
    const run = await newRun({ strategy: "export", size: 150, requests: [search(SEVERAL_PLACES)] });
    const st = await drive(run.id, cf, { limit: 120 });
    const rr = await runRow(run.id);
    check("a job that adds nobody uses the location group up, so the buying stops", st === "done" && rr.stop_reason === "No more matches" && posts === 2 && rr.pulled === 100, `${st} ${rr.stop_reason} posts ${posts} pulled ${rr.pulled}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) {
        posts++;
        return ans(404, { timestamp: "x", status: 404, error: "data not found", path: "" });
      }
    }));
    const run = await newRun({ strategy: "export", size: 100, requests: [search(), search(), search()] });
    const st = await drive(run.id, cf, { limit: 60 });
    const rr = await runRow(run.id);
    check("export 404 (no matches): each location group tried once, then the run ends", st === "done" && posts === 3 && rr.progress.chunk === 3 && rr.progress.job === null && rr.stop_reason === "No more matches" && rr.pulled === 0, `${st} posts ${posts} chunk ${rr.progress.chunk} ${rr.stop_reason}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) {
        posts++;
        return ans(500, { status: 500, error: "unexpected error" });
      }
    }));
    const run = await newRun({ strategy: "export", size: 100, requests: [search()] });
    await step(cf);
    await due(run.id);
    await step(cf); // nothing at AI Ark yet, and the two minutes are not up
    const looking = await runRow(run.id);
    check("waiting to see whether a failed export reached AI Ark keeps the count of tries and the error", looking.attempts === 1 && /500/.test(looking.last_error ?? "") && posts === 1 && Boolean(looking.progress.job), `${looking.attempts} ${looking.last_error} posts ${posts}`);
    for (let i = 0; i < 20 && !TERMINAL.has((await runRow(run.id)).status); i++) {
      await lostAgo(run.id, "3 minutes");
      await step(cf);
    }
    const rr = await runRow(run.id);
    check("an export that keeps answering 500 ends after 6 tries, each one looked for first", rr.status === "error" && posts === 6 && /Gave up after 6 tries/.test(rr.last_error ?? ""), `${rr.status} posts ${posts} ${rr.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(overlay(tx, (req) => (req.url.includes("/inquiries") ? ans(409, { status: 409, error: "track id in progress", path: "" }) : undefined)));
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    for (let i = 0; i < 6; i++) {
      await step(cf);
      await due(run.id);
    }
    const a = await runRow(run.id);
    check("DONE but results answer 409: it keeps waiting, charged once", a.status === "running" && a.progress.job?.charged === true && Number(a.credits_used) === tx.state.charged, `${a.status} ${a.credits_used} vs ${tx.state.charged}`);
    await backdateJob(run.id, "submitted_at", "12 hours");
    for (let i = 0; i < 3 && (await runRow(run.id)).status === "running"; i++) {
      await step(cf);
      await due(run.id);
    }
    const b = await runRow(run.id);
    check("  … until the 11-hour limit, which names the job", b.status === "error" && b.last_error.includes(a.progress.job.track_id) && /not read/.test(b.last_error) && Number(b.credits_used) === tx.state.charged, `${b.status} ${b.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let cut = true;
    const cf = demoClient(overlay(tx, (req) => {
      if (cut && req.url.includes("/inquiries")) {
        cut = false;
        return { status: 200, headers: new Headers(), text: '{"content":[{"id":"a"' };
      }
    }));
    const run = await newRun({ strategy: "export", size: 60, requests: [search()] });
    const st = await drive(run.id, cf);
    const rr = await runRow(run.id);
    check("a cut-off results page is read again, not taken as the end of the job", st === "done" && rr.pulled === 60 && Number(rr.credits_used) === tx.state.charged, `${st} ${rr.pulled} ${rr.credits_used} vs ${tx.state.charged}`);
  }
  {
    const tx = createDemoTransport({});
    let cut = true;
    const cf = demoClient(overlay(tx, (req) => {
      if (cut && req.url.endsWith("/people/preview")) {
        cut = false;
        return { status: 200, headers: new Headers(), text: "" };
      }
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    const st = await drive(run.id, cf);
    const rr = await runRow(run.id);
    check("a cut-off Preview page is read again, not taken as no more matches", st === "done" && rr.pulled === 20 && rr.stop_reason === null, `${st} ${rr.pulled} ${rr.stop_reason}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 60, requests: [search()] });
    await step(cf);
    await due(run.id);
    await step(cf, { pool: flaky((sql) => sql.includes("credits_used = credits_used + $3, progress = $4"), 1) });
    const a = await runRow(run.id);
    check("the job's price fails to save: the job is not marked as charged", a.progress.job?.charged !== true && Number(a.credits_used) === 0 && a.attempts === 1, `${JSON.stringify(a.progress.job)} ${a.credits_used}`);
    const st = await drive(run.id, cf);
    const b = await runRow(run.id);
    check("  … and the next slice records it, once", st === "done" && Number(b.credits_used) === tx.state.charged && tx.state.charged > 0, `${st} ${b.credits_used} vs ${tx.state.charged}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 60, requests: [search()] });
    await step(cf);
    await due(run.id);
    await step(cf, { pool: answerLost((sql) => sql.includes("credits_used = credits_used + $3, progress = $4")) });
    const a = await runRow(run.id);
    check("the job's price is saved but the answer is lost: what was saved stays, not the copy before it", a.progress.job?.charged === true && Number(a.credits_used) === tx.state.charged && a.attempts === 1, `${JSON.stringify(a.progress.job)} ${a.credits_used} vs ${tx.state.charged}`);
    const st = await drive(run.id, cf);
    check("  … and the job is priced once", st === "done" && Number((await runRow(run.id)).credits_used) === tx.state.charged, st);
  }
  {
    const tx = createDemoTransport({ jobMs: 0, faults: { refundAtReadOnce: true } });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; }));
    const run = await newRun({ strategy: "export", size: 60, requests: [search()] });
    await step(cf);
    await due(run.id);
    await step(cf, { pool: answerLost((sql) => sql.includes("credits_used = credits_used - $3")) });
    const a = await runRow(run.id);
    check("a refund is saved but the answer is lost: the refunded job is not kept to be refunded again", a.progress.job === null && a.progress.resubmits === 1 && Number(a.credits_used) === 0, `${JSON.stringify(a.progress.job)} ${a.credits_used}`);
    const st = await drive(run.id, cf);
    const b = await runRow(run.id);
    check("  … its price comes off once", st === "done" && posts === 2 && Number(b.credits_used) === tx.state.charged, `${st} posts ${posts} ${b.credits_used} vs ${tx.state.charged}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let reads = 0;
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 60, requests: [search()] });
    await step(cf);
    await due(run.id);
    // The price is saved and its answer lost, and the read back fails too.
    const unreadable = {
      query: async (sql, params) => {
        if (sql.startsWith("SELECT progress, pulled")) {
          reads++;
          throw new Error("Connection terminated unexpectedly");
        }
        const res = await pool.query(sql, params);
        if (sql.includes("credits_used = credits_used + $3, progress = $4")) throw new Error("Connection terminated unexpectedly");
        return res;
      },
    };
    await step(cf, { pool: unreadable });
    const a = await runRow(run.id);
    check("  … and when the run can't even be read back, it is left to its lease, nothing written over it", reads === 1 && a.claim_token !== null && a.progress.job?.charged === true && Number(a.credits_used) === tx.state.charged, `${reads} ${a.claim_token} ${JSON.stringify(a.progress.job)}`);
    await pool.query(`UPDATE aiark_runs SET claimed_at = now() - interval '11 minutes', next_run_at = now() WHERE id = $1`, [run.id]);
    const st = await drive(run.id, cf);
    check("  … then read once the lease runs out, priced once", st === "done" && Number((await runRow(run.id)).credits_used) === tx.state.charged, st);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    let open = false;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) posts++;
      if (!open && req.url.includes("/statistics")) return PENDING;
    }));
    const body = search();
    const a = await newRun({ strategy: "export", size: 30, requests: [body] });
    await step(cf);
    const b = await newRun({ strategy: "export", size: 30, requests: [body] });
    await step(cf);
    const w = await runRow(b.id);
    check("a second export run waits while another run's job is unread: no lists, no attempt counted", posts === 1 && w.status === "running" && !w.progress.lists && w.attempts === 0 && new Date(w.next_run_at) - Date.now() > 20_000, `${posts} posts, ${JSON.stringify(w.progress)}`);
    open = true;
    await due(a.id);
    await drive(a.id, cf);
    await due(b.id);
    const st = await drive(b.id, cf);
    const [idsA, idsB] = [await personIds(a.table_id), await personIds(b.table_id)];
    check("  … then goes out leaving out the people the first job brought in", st === "done" && posts === 2 && idsB.size === 30 && [...idsB].filter((x) => idsA.has(x)).length === 0, `${st} posts ${posts} ${idsB.size}`);
  }
  // A single run for another client with the same search, while an export job is unread.
  const nobodyTwice = async (exp, single, tx) => {
    const [idsE, idsS] = [await personIds(exp.table_id), await personIds(single.table_id)];
    const again = await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key = 'pulled_before'`, [exp.table_id]);
    const [e, s] = [await runRow(exp.id), await runRow(single.id)];
    return {
      ok: idsS.size > 0 && [...idsS].filter((x) => idsE.has(x)).length === 0 && again.n === 0 && Number(e.credits_used) + Number(s.credits_used) === tx.state.charged,
      detail: `${idsS.size} single, ${[...idsS].filter((x) => idsE.has(x)).length} in both, ${again.n} bought before, ${Number(e.credits_used) + Number(s.credits_used)} vs ${tx.state.charged}`,
    };
  };
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let open = false;
    let previews = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (req.url.endsWith("/people/preview")) previews++;
      if (!open && req.url.includes("/statistics")) return PENDING;
    }));
    const body = search();
    const a = await newRun({ strategy: "export", size: 30, requests: [body] });
    await step(cf); // the export goes out
    const b = await newRun({ size: 30, requests: [body] });
    await step(cf);
    const w = await runRow(b.id);
    check("a single run waits while another run's export job is unread: no lists, no Preview, no attempt counted", previews === 0 && w.status === "running" && !w.progress.lists && w.attempts === 0 && new Date(w.next_run_at) - Date.now() > 20_000, `${previews} previews, ${JSON.stringify(w.progress)}`);
    open = true;
    await due(a.id);
    await drive(a.id, cf);
    await due(b.id);
    const st = await drive(b.id, cf);
    const out = await nobodyTwice(a, b, tx);
    check("  … then buys none of the people the job brought in: nobody is paid for twice", st === "done" && out.ok, `${st} ${out.detail}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let open = false;
    const cf = demoClient(overlay(tx, (req) => (!open && req.url.includes("/statistics") ? PENDING : undefined)));
    const body = search(SEVERAL_PLACES);
    const b = await newRun({ size: 150, requests: [body] });
    await step(cf); // the single run's first page
    const a = await newRun({ strategy: "export", size: 100, requests: [body] });
    await pool.query(`UPDATE aiark_runs SET next_run_at = now() + interval '1 minute' WHERE id = $1`, [b.id]);
    await step(cf); // the export goes out between two of the single run's slices
    await due(b.id);
    const before = await runRow(b.id);
    await step(cf);
    const w = await runRow(b.id);
    check("  … and a single run already going waits once another run's export goes out", Boolean((await runRow(a.id)).progress.job?.track_id) && before.pulled > 0 && w.pulled === before.pulled && w.attempts === 0 && new Date(w.next_run_at) - Date.now() > 20_000, `${before.pulled} → ${w.pulled}`);
    open = true;
    await due(a.id);
    await drive(a.id, cf);
    await due(b.id);
    const st = await drive(b.id, cf);
    const out = await nobodyTwice(a, b, tx);
    check("  … then carries on past the job's people: nobody is paid for twice", st === "done" && out.ok, `${st} ${out.detail}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) posts++;
      if (req.url.includes("/statistics")) return ans(403, { status: 4031013, error: "this request was automatically refunded" });
    }));
    const run = await newRun({ strategy: "export", size: 60, requests: [search()] });
    const st = await drive(run.id, cf);
    const rr = await runRow(run.id);
    check("four refunds in a row end the run, with no job left behind", st === "error" && posts === 4 && /4 times/.test(rr.last_error ?? "") && rr.progress.job === null, `${st} posts ${posts} ${rr.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const run = await newRun({ strategy: "export", size: 5000, requests: [search(), search()] });
    await setProgress(run.id, { resubmits: 3 });
    const st = await drive(run.id, demoClient(tx));
    check("the limit on refunds is per job, not per run: a read job clears the count", st === "done" && (await runRow(run.id)).progress.resubmits === 0, st);
  }
}

/** B9. While AI Ark holds a job of ours, nothing but its own answer ends the run. */
async function heldJobs() {
  section("B9. A paid job is never abandoned");
  for (const [label, fault, why] of [
    ["5xx", ans(500, { status: 500, error: "unexpected error" }), /500/],
    ["a refused key (401)", ans(401, { message: "No API key found in request" }), /refused the key/],
    ["a 403 that is not a refund", ans(403, { status: 403, error: "account restricted" }), /refused the key/],
  ]) {
    const tx = createDemoTransport({ jobMs: 0 });
    let down = false;
    const cf = demoClient(overlay(tx, (req) => (down && req.url.includes("/statistics") ? fault : undefined)));
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    await step(cf);
    down = true;
    for (let i = 0; i < 8; i++) {
      await due(run.id);
      await step(cf);
    }
    const a = await runRow(run.id);
    check(`${label} on a paid job: eight tries, still running, job kept, error kept`, a.status === "running" && a.attempts === 8 && Boolean(a.progress.job?.track_id) && why.test(a.last_error ?? ""), `${a.status} ${a.attempts} ${a.last_error}`);
    const wait = new Date(a.next_run_at) - Date.now(); // the database's clock and this one differ by a moment
    check("  … backing off, 15 minutes at most", wait > 14 * 60_000 && wait < 15 * 60_000 + 2_000, `${Math.round(wait / 1000)} s`);
    down = false;
    const st = await drive(run.id, cf);
    const b = await runRow(run.id);
    check("  … and when AI Ark is back, it is read, with no error left on the finished run", st === "done" && b.pulled === 30 && Number(b.credits_used) === tx.state.charged && b.last_error === null, `${st} ${b.pulled} ${b.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    await step(cf);
    await due(run.id);
    await step(async () => ({ client: null, why: "Needs AIARK_API_KEY" }));
    const a = await runRow(run.id);
    check("a worker with no key holds the job instead of ending the run", a.status === "running" && a.attempts === 1 && a.last_error === "Needs AIARK_API_KEY" && Boolean(a.progress.job?.track_id) && new Date(a.next_run_at) > new Date(), `${a.status} ${a.last_error}`);
    const st = await drive(run.id, cf);
    check("  … and one with the key reads it", st === "done" && (await runRow(run.id)).pulled === 30, st);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let down = false;
    const cf = demoClient(overlay(tx, (req) => (down && req.url.includes("/inquiries") ? ans(500, { status: 500, error: "unexpected error" }) : undefined)));
    const run = await newRun({ strategy: "export", size: 150, requests: [search(SEVERAL_PLACES)] });
    await step(cf);
    await due(run.id);
    await step(cf); // page 0
    await due(run.id);
    down = true;
    for (let i = 0; i < 8; i++) {
      await step(cf);
      await due(run.id);
    }
    const a = await runRow(run.id);
    down = false;
    const st = await drive(run.id, cf);
    check("an outage part-way through reading holds the job too, and the rest is read", a.status === "running" && a.pulled === 100 && st === "done" && (await runRow(run.id)).pulled === 150, `${a.status} ${a.pulled} ${st}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 150, requests: [search(SEVERAL_PLACES)] });
    await step(cf);
    await due(run.id);
    await step(cf); // page 0
    await pool.query(`UPDATE aiark_runs SET pulled = 150, next_run_at = now() WHERE id = $1`, [run.id]);
    await step(cf);
    const r = await runRow(run.id);
    check("a job in hand is read to its end even if the count says the run is full", r.status === "done" && r.progress.job === null, `${r.status} ${JSON.stringify(r.progress.job)}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(overlay(tx, (req) => (req.url.includes("/statistics") ? ans(500, { status: 500, error: "unexpected error" }) : undefined)));
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    await step(cf);
    await backdateJob(run.id, "submitted_at", "10 hours 59 minutes");
    await step(cf);
    const a = await runRow(run.id);
    await backdateJob(run.id, "submitted_at", "11 hours 1 minute");
    await step(cf);
    const b = await runRow(run.id);
    const track = b.progress.job?.track_id;
    check("an outage past 11 hours ends the run, naming the job and saying nobody was read", a.status === "running" && b.status === "error" && Boolean(track) && b.last_error.includes(track) && /not read/.test(b.last_error), `${a.status} ${b.status} ${b.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let down = false;
    const cf = demoClient(overlay(tx, (req) => (down && req.url.includes("/inquiries") ? ans(500, { status: 500, error: "unexpected error" }) : undefined)));
    const run = await newRun({ strategy: "export", size: 150, requests: [search(SEVERAL_PLACES)] });
    await step(cf);
    await due(run.id);
    await step(cf); // DONE, and page 0
    down = true;
    await backdateJob(run.id, "submitted_at", "12 hours");
    await step(cf);
    const a = await runRow(run.id);
    check("a blip past 11 hours on a job AI Ark has delivered: the pages left are not thrown away", a.status === "running" && a.attempts === 1 && a.pulled === 100, `${a.status} ${a.attempts} ${a.pulled}`);
    for (let i = 0; i < 8 && (await runRow(run.id)).status === "running"; i++) {
      await due(run.id);
      await step(cf);
    }
    const b = await runRow(run.id);
    check("  … but an outage there still ends, naming the job and the page", b.status === "error" && b.attempts === 5 && b.last_error.includes(b.progress.job.track_id) && /not read past page 1/.test(b.last_error), `${b.status} ${b.attempts} ${b.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(overlay(tx, (req) => (req.url.includes("/statistics") ? PENDING : undefined)));
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    await step(cf);
    await backdateJob(run.id, "submitted_at", "4 hours");
    await step(cf);
    const a = await runRow(run.id);
    await backdateJob(run.id, "submitted_at", "12 hours");
    await step(cf);
    const b = await runRow(run.id);
    check("a job still pending at 4 hours is waited for; past 11 hours the run ends", a.status === "running" && a.attempts === 0 && b.status === "error" && b.last_error.includes(b.progress.job.track_id), `${a.status} ${b.status} ${b.last_error}`);
    check("  … no message promises a refund", !/refund/i.test(b.last_error ?? ""), b.last_error);
  }
}

/** B10. The list budget is what runs out, so lists are reused and never traded for fewer. */
async function lists() {
  section("B10. Exclusion lists");
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let made = 0;
    let first = null;
    const cf = demoClient(overlay(tx, (req) => { if (req.url.endsWith("/v1/lists")) made++; }));
    const run = await newRun({ strategy: "export", size: 5000, requests: [search(), search(), search()] });
    await step(cf);
    first = (await runRow(run.id)).progress.lists[0];
    await due(run.id);
    const st = await drive(run.id, cf);
    const r = await runRow(run.id);
    check("three jobs: one list for the people held, then one more each for the new ones", st === "done" && made === 3 && r.progress.lists.length === 3 && r.progress.lists[0] === first && r.progress.lists_log.length === 3, `${st} ${made} made, ${r.progress.lists.length} held`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; }));
    const run = await newRun({ strategy: "export", size: 50, requests: [search()] });
    await spendLists(run.id);
    const st = await drive(run.id, cf);
    const r = await runRow(run.id);
    check("no list budget and people held: the export does not post", st === "stopped" && posts === 0 && Number(r.credits_used) === 0, `${st} posts ${posts}`);
    check("  … and the reason says the budget ran out and a later run can carry on", /day's exclusion list budget ran out/.test(r.stop_reason ?? "") && /later run can carry on/.test(r.stop_reason ?? ""), r.stop_reason);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; }));
    const run = await newRun({ strategy: "export", size: 5000, requests: [search(), search()] });
    for (let i = 0; i < 10 && (await runRow(run.id)).progress.chunk !== 1; i++) {
      await due(run.id);
      await step(cf);
    }
    const before = (await runRow(run.id)).progress.lists;
    await spendLists(run.id);
    const st = await drive(run.id, cf);
    const r = await runRow(run.id);
    check("the budget gone part-way: the run's lists are kept, and nothing posts without the new people", st === "stopped" && posts === 1 && before.length === 1 && JSON.stringify(r.progress.lists) === JSON.stringify(before), `${st} posts ${posts} ${JSON.stringify(r.progress.lists)}`);
  }
  {
    const tx = createDemoTransport({});
    const run = await newRun({ size: 20, requests: [search()] });
    await spendLists(run.id);
    const st = await drive(run.id, demoClient(tx));
    const r = await runRow(run.id);
    check("no list budget on a single run: it carries on, with a note", st === "done" && r.pulled === 20 && r.progress.lists.length === 0 && /Not enough exclusion lists/.test(r.progress.lists_note ?? ""), `${st} ${r.pulled} ${r.progress.lists_note}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    const { n } = await one(`SELECT count(*)::int AS n FROM aiark_people WHERE demo`);
    await setProgress(run.id, { lists: Array.from({ length: 10 }, (_, i) => `full-${i}`), excluded: n, lists_at: new Date().toISOString(), lists_through: new Date().toISOString() });
    await sleep(5);
    await holdPeople(1);
    await step(cf);
    const r = await runRow(run.id);
    check("new people and all 10 lists in use: a full rebuild", r.progress.lists.length === 1 && !r.progress.lists[0].startsWith("full-") && r.progress.excluded === n + 1, `${r.progress.lists} ${r.progress.excluded} of ${n + 1}`);
    await dropHeldPeople();
    await due(run.id);
    await drive(run.id, cf);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; }));
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    await setProgress(run.id, { lists: Array.from({ length: 10 }, (_, i) => `full-${i}`), excluded: 1_000_000, lists_at: new Date().toISOString(), lists_through: new Date().toISOString() });
    await spendLists(run.id);
    await sleep(5);
    await holdPeople(1);
    const st = await drive(run.id, cf);
    check("lists that look full but miss the newest people, and no budget: the export does not post", st === "stopped" && posts === 0, `${st} posts ${posts}`);
    await dropHeldPeople();
  }
  await holdPeople(25_000);
  const { n: held } = await one(`SELECT count(*)::int AS n FROM aiark_people WHERE demo`);
  const needed = Math.ceil(held / 10_000);
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let calls = 0;
    let broke = 0;
    let id = null;
    let savedByList2 = null;
    const cf = demoClient(overlay(tx, async (req) => {
      if (!req.url.endsWith("/v1/lists")) return;
      calls++;
      if (calls === 2) savedByList2 = (await runRow(id)).progress.lists_new?.ids.length;
      if (calls >= 3 && broke < 3) {
        broke++;
        return ans(500, { status: 500, error: "unexpected error" });
      }
    }));
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    id = run.id;
    await step(cf);
    const a = await runRow(run.id);
    check("each list is saved as it is made, before the next is asked for", savedByList2 === 1, String(savedByList2));
    check("a list failing part-way: the ones made are saved, and nothing is posted", a.attempts === 1 && a.progress.lists_new?.ids.length === 2 && a.progress.lists_log.length === 2 && !a.progress.job, JSON.stringify(a.progress.lists_new?.ids.length));
    await due(run.id);
    await step(cf);
    const b = await runRow(run.id);
    check("  … and the retry carries on instead of making them again", tx.state.listsMade === needed && b.progress.lists.length === needed && b.progress.excluded === held && b.progress.lists_log.length === needed && !b.progress.lists_new, `${tx.state.listsMade} made of ${needed}, ${b.progress.lists?.length} held`);
    await due(run.id);
    await drive(run.id, cf);
  }
  for (const strategy of ["export", "single"]) {
    const tx = createDemoTransport({ jobMs: 0 });
    let calls = 0;
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) posts++;
      if (req.url.endsWith("/v1/lists") && ++calls === 2) return ans(400, { status: 400, error: "daily list quota exceeded", path: "" });
    }));
    const run = await newRun({ strategy, size: 20, requests: [search()] });
    const st = await drive(run.id, cf);
    const r = await runRow(run.id);
    const expected = strategy === "export" ? st === "stopped" && posts === 0 : st === "done" && r.pulled === 20;
    check(`a list refused outright: ${strategy === "export" ? "the export does not post" : "a single run carries on"}, and says why`, expected && r.progress.lists.length === 1 && r.progress.excluded === 10_000 && /refused an exclusion list/.test(r.progress.lists_note ?? ""), `${st} posts ${posts} ${r.progress.lists_note}`);
  }
  {
    const tx = createDemoTransport({});
    const run = await newRun({ size: 20, requests: [search()] });
    const lists = ["kept-1", "kept-2", "kept-3"];
    await setProgress(run.id, { lists, excluded: 30_000, lists_at: new Date(Date.now() - 23.5 * 3600_000).toISOString() });
    await spendLists(run.id, 44);
    await step(demoClient(tx));
    const r = await runRow(run.id);
    check("lists past 23 hours are not replaced by fewer while they still work", JSON.stringify(r.progress.lists) === JSON.stringify(lists) && r.progress.excluded === 30_000, JSON.stringify(r.progress.lists));
    await settle(run.id);
  }
  {
    const tx = createDemoTransport({});
    let calls = 0;
    const cf = demoClient(overlay(tx, (req) => (req.url.endsWith("/v1/lists") && ++calls === 2 ? ans(400, { status: 400, error: "daily list quota exceeded", path: "" }) : undefined)));
    const run = await newRun({ size: 20, requests: [search()] });
    const lists = ["kept-1", "kept-2"];
    await setProgress(run.id, { lists, excluded: 20_000, lists_at: new Date(Date.now() - 23.5 * 3600_000).toISOString() });
    await step(cf);
    const r = await runRow(run.id);
    check("  … nor by a rebuild cut short at fewer", calls === 2 && JSON.stringify(r.progress.lists) === JSON.stringify(lists) && r.progress.excluded === 20_000, `${calls} ${JSON.stringify(r.progress.lists)}`);
    await settle(run.id);
  }
  {
    const tx = createDemoTransport({});
    const run = await newRun({ size: 20, requests: [search()] });
    await setProgress(run.id, { lists: ["dead-1"], excluded: 10_000, lists_at: new Date(Date.now() - 25 * 3600_000).toISOString() });
    await spendLists(run.id);
    const bodies = [];
    await step(demoClient(overlay(tx, (req) => { if (req.url.endsWith("/people/preview")) bodies.push(JSON.parse(req.body)); })));
    const r = await runRow(run.id);
    check("lists past 24 hours are gone, so they are not sent", r.progress.lists.length === 0 && r.progress.excluded === 0 && !bodies[0]?.lists, JSON.stringify(bodies[0]?.lists));
    await settle(run.id);
  }
  await dropHeldPeople();
  {
    const tx = createDemoTransport({});
    const pages = [];
    const cf = demoClient(overlay(tx, (req) => { if (req.url.endsWith("/people/preview")) pages.push(JSON.parse(req.body).page); }));
    const run = await newRun({ size: 300, requests: [search(SEVERAL_PLACES)] });
    await step(cf);
    await due(run.id);
    await step(cf);
    await setProgress(run.id, { lists_at: new Date(Date.now() - 23.5 * 3600_000).toISOString() });
    await step(cf);
    check("a single run's lists are refreshed part-way: paging starts over, nobody is skipped", pages.join() === "0,1,0", pages.join());
    await due(run.id);
    await drive(run.id, cf);
    const r = await runRow(run.id);
    const s = await tableStats(run.table_id, run.id);
    check("  … and nobody is bought twice", s.keys === r.pulled && r.pulled === 300, `${s.keys} of ${r.pulled}`);
  }
}

/** B11. An export whose answer was lost is taken back only when it can only be ours. */
async function adoption() {
  section("B11. Adopting a lost export");
  const mine = (o) => ({ requestSize: 40, fullyRefunded: false, ...o });
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 5000, requests: [search(), search()] });
    await step(cf);
    const a = await runRow(run.id);
    check("a job's track id is remembered the moment it is known", a.progress.track_ids?.length === 1 && a.progress.track_ids[0] === a.progress.job?.track_id, JSON.stringify(a.progress.track_ids));
    await due(run.id);
    await drive(run.id, cf);
    const b = await runRow(run.id);
    check("  … and stays after the job is read, so no run can adopt it later", b.progress.job === null && b.progress.track_ids?.length === 2 && b.progress.track_ids[0] === a.progress.track_ids[0], JSON.stringify(b.progress.track_ids));
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    let subs = [];
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) {
        posts++;
        throw new TypeError("fetch failed");
      }
      if (req.url.includes("/submissions")) return ans(200, { content: subs });
    }));
    const other = await newRun({ strategy: "export", size: 40, requests: [search()] });
    await pool.query(`UPDATE aiark_runs SET status = 'done', finished_at = now(), progress = '{"track_ids": ["read-by-another-run"], "job": {"track_id": "held-by-another-run"}}' WHERE id = $1`, [other.id]);
    const run = await newRun({ strategy: "export", size: 40, requests: [search()] });
    await step(cf);
    await due(run.id);
    await lostAgo(run.id, "3 minutes");
    const at = Date.parse((await runRow(run.id)).progress.job.submitting_at);
    const iso = (ms) => new Date(at + ms).toISOString();
    subs = [
      mine({ trackId: "read-by-another-run", created: iso(0) }),
      mine({ trackId: "held-by-another-run", created: iso(0) }),
      mine({ trackId: "refunded", created: iso(0), fullyRefunded: true }),
      mine({ trackId: "wrong-size", created: iso(0), requestSize: 41 }),
      mine({ trackId: "too-early", created: iso(-125_000) }),
      mine({ trackId: "too-late", created: iso(125_000) }),
    ];
    await step(cf);
    const r = await runRow(run.id);
    check("nothing that could be someone else's is adopted: it posts again", posts === 2 && !r.progress.track_ids && !r.progress.job?.track_id, `${posts} posts, ${JSON.stringify(r.progress.job)}`);
    await settle(run.id);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    let subs = [];
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) {
        posts++;
        throw new TypeError("fetch failed");
      }
      if (req.url.includes("/submissions")) return ans(200, { content: subs });
    }));
    const run = await newRun({ strategy: "export", size: 40, requests: [search()] });
    await step(cf);
    await due(run.id);
    const at = (await runRow(run.id)).progress.job.submitting_at;
    subs = [mine({ trackId: "candidate-one", created: at }), mine({ trackId: "candidate-two", created: at })];
    await step(cf);
    const r = await runRow(run.id);
    check("two jobs that could be ours: the run stops and names them, for an operator", r.status === "stopped" && posts === 1 && /candidate-one/.test(r.stop_reason ?? "") && /candidate-two/.test(r.stop_reason ?? ""), `${r.status} ${r.stop_reason}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let subs = [];
    const cf = demoClient(overlay(tx, (req) => {
      if (isPost(req)) throw new TypeError("fetch failed");
      if (req.url.includes("/submissions")) return ans(200, { content: subs });
    }));
    const run = await newRun({ strategy: "export", size: 40, requests: [search()] });
    await step(cf);
    const at = (await runRow(run.id)).progress.job.submitting_at;
    subs = [mine({ trackId: "candidate-three", created: at }), mine({ trackId: "candidate-four", created: at })];
    await cancelRoute(run.id);
    await due(run.id);
    await step(cf);
    const r = await runRow(run.id);
    check("  … a cancelled run stays cancelled, and still records why", r.status === "cancelled" && r.finished_at !== null && /candidate-three/.test(r.stop_reason ?? ""), `${r.status} ${r.stop_reason}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let dropped = false;
    let down = true;
    const cf = demoClient(overlay(tx, async (req) => {
      if (isPost(req) && !dropped) {
        dropped = true;
        await tx(req);
        throw new TypeError("fetch failed");
      }
      if (down && req.url.includes("/submissions")) return ans(500, { status: 500, error: "unexpected error" });
    }));
    const run = await newRun({ strategy: "export", size: 40, requests: [search()] });
    await step(cf);
    for (let i = 0; i < 8; i++) {
      await due(run.id);
      await step(cf);
    }
    const a = await runRow(run.id);
    check("AI Ark down while looking for a lost export: the run waits, it may be paid for", a.status === "running" && a.attempts === 9 && !a.progress.job?.track_id && Boolean(a.progress.job), `${a.status} ${a.attempts}`);
    down = false;
    const st = await drive(run.id, cf);
    const b = await runRow(run.id);
    check("  … and finds it once AI Ark is back", st === "done" && b.pulled === 40 && Number(b.credits_used) === tx.state.charged, `${st} ${b.pulled} ${b.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let dropped = false;
    let open = false;
    const cf = demoClient(overlay(tx, async (req) => {
      if (isPost(req) && !dropped) {
        dropped = true;
        await tx(req); // AI Ark takes it; the answer never arrives
        throw new TypeError("fetch failed");
      }
      if (!open && req.url.includes("/statistics")) return PENDING;
    }));
    const run = await newRun({ strategy: "export", size: 40, requests: [search()] });
    await step(cf);
    await due(run.id);
    await step(cf);
    const a = await runRow(run.id);
    check("the one job that can only be ours is adopted, and remembered", a.progress.job?.adopted === true && a.progress.track_ids?.length === 1 && a.progress.track_ids[0] === a.progress.job.track_id && Boolean(a.progress.job.submitted_at), JSON.stringify(a.progress.job));
    open = true;
    await due(run.id);
    await drive(run.id, cf);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    let open = false;
    const cf = demoClient(overlay(tx, async (req) => {
      if (isPost(req) && ++posts === 1) {
        await tx(req); // AI Ark takes it; the answer never arrives
        throw new TypeError("fetch failed");
      }
      if (!open && req.url.includes("/statistics")) return PENDING;
    }));
    const run = await newRun({ strategy: "export", size: 40, requests: [search()] });
    await step(cf);
    // The POST first waited out five minutes of 429s, so AI Ark took it five minutes after it was sent.
    await backdateJob(run.id, "submitting_at", "5 minutes");
    await step(cf);
    const a = await runRow(run.id);
    check("a POST that waited out 429s before AI Ark took it, then lost its answer: its job is still found and adopted", posts === 1 && a.progress.job?.adopted === true && Boolean(a.progress.job.track_id), `${posts} posts ${JSON.stringify(a.progress.job)}`);
    open = true;
    await due(run.id);
    const st = await drive(run.id, cf);
    check("  … and read, with nothing posted again", st === "done" && posts === 1 && Number((await runRow(run.id)).credits_used) === tx.state.charged, `${st} posts ${posts}`);
  }
  for (const [label, bad] of [
    ["404", ans(404, { timestamp: "x", status: 404, error: "data not found", path: "" })],
    ["an answer with no list", ans(200, {})],
  ]) {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, async (req) => {
      if (isPost(req)) {
        posts++;
        await tx(req); // AI Ark takes it; the answer never arrives
        throw new TypeError("fetch failed");
      }
      if (req.url.includes("/submissions")) return bad;
    }));
    const run = await newRun({ strategy: "export", size: 40, requests: [search()] });
    await step(cf);
    await lostAgo(run.id, "3 minutes");
    await step(cf);
    const a = await runRow(run.id);
    check(`the list of exports answers ${label} once the window has passed: the job is held and nothing is posted again`, posts === 1 && a.status === "running" && Boolean(a.progress.job) && !a.progress.job.track_id && /could not be read/.test(a.last_error ?? ""), `${posts} posts ${a.status} ${a.last_error}`);
    await settle(run.id);
  }
}

/** B12. A paid answer is in memory only until it is written. */
async function writes() {
  section("B12. Person writes");
  const worker = source("scripts/enrich-worker.mjs");
  check("the worker tells a slice when it is shutting down", /advanceOneRun\(\{[^}]*shouldStop: \(\) => shuttingDown/.test(worker));
  check("a slice in flight keeps a draining worker from exiting under it", /aiark\.idle = false;\s*try \{\s*worked = await advanceOneRun/.test(worker));
  check("a stopping worker closes its database pool only after the AI Ark slice in flight is done, with no deadline", /await runs;[\s\S]*await pool\.end\(\)/.test(worker) && !/Promise\.race\(\[runs/.test(worker));
  {
    const tx = createDemoTransport({});
    let singles = 0;
    let balance = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (req.url.includes("/export/single")) singles++;
      if (req.url.endsWith("/payments/credits")) balance++;
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    await step(cf, { shouldStop: () => singles >= 20 });
    const r = await runRow(run.id);
    check("a run that ends while its worker is stopping doesn't wait for the closing balance", r.status === "done" && r.credits_after === null && balance === 1, `${r.status} ${r.credits_after} ${balance} balance reads`);
  }
  {
    const tx = createDemoTransport({});
    const run = await newRun({ size: 20, requests: [search()] });
    await step(demoClient(tx), { pool: answerLost((sql) => sql.includes("INSERT INTO aiark_people")) });
    const r = await runRow(run.id);
    const s = await tableStats(run.table_id, run.id);
    check("a person's write is saved but its answer lost: the retry counts them once, and the run stops at its size", r.pulled === 20 && s.rows === 20 && Number(r.credits_used) === tx.state.charged, `${r.pulled} ${JSON.stringify(s)} ${r.credits_used} vs ${tx.state.charged}`);
    await due(run.id);
    await drive(run.id, demoClient(tx));
  }
  for (const strategy of ["single", "export"]) {
    const tx = createDemoTransport({ jobMs: 0 });
    let poisoned = null;
    const poison = (p) => ({
      ...p,
      profile: { ...p.profile, title: "Owner \uD83D" },
      company: { ...p.company, summary: { ...p.company.summary, description: `${"x".repeat(4_999)}\u{1F600} and more` } },
    });
    const cf = demoClient(overlay(tx, async (req) => {
      if (poisoned || !(req.url.includes("/export/single") || req.url.includes("/inquiries"))) return;
      const res = await tx(req);
      const j = JSON.parse(res.text);
      if (j.status === 200 && j.data) j.data = poison(j.data);
      else if (j.content?.length) j.content[0] = poison(j.content[0]);
      else return res;
      poisoned = (j.data ?? j.content[0]).id;
      return { ...res, text: JSON.stringify(j) };
    }));
    const run = await newRun({ strategy, size: 30, requests: [search()] });
    for (let i = 0; i < 20 && !TERMINAL.has((await runRow(run.id)).status); i++) {
      await due(run.id);
      await step(cf);
    }
    const r = await runRow(run.id);
    const cells = await one(
      `SELECT max(length(c.value #>> '{}')) FILTER (WHERE c.column_key = 'company_description') AS description,
              max(c.value #>> '{}') FILTER (WHERE c.column_key = 'title') AS title
         FROM enrich_cells c JOIN enrich_rows w ON w.id = c.row_id WHERE w.table_id = $1 AND w.row_key = $2`,
      [run.table_id, `aiark:${poisoned}`]
    );
    check(`${strategy}: text Postgres can't take as AI Ark sent it (an emoji cut in two, half of one) is written all the same, holding nothing up`, r.status === "done" && r.pulled === 30 && r.attempts === 0 && cells?.description === 4_999 && cells.title === "Owner \u{FFFD}", `${r.status} ${r.pulled} ${r.attempts} ${JSON.stringify(cells)} ${r.last_error}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let refused = null;
    const cf = demoClient(overlay(tx, async (req) => {
      if (refused || !req.url.includes("/inquiries")) return;
      const res = await tx(req);
      const j = JSON.parse(res.text);
      if (!j.content?.length) return res;
      j.content[0] = { ...j.content[0], profile: { ...j.content[0].profile, title: "Gérante" } };
      refused = j.content[0].id;
      return { ...res, text: JSON.stringify(j) };
    }));
    // Postgres refuses that title (SQLSTATE class 22) every time it is sent.
    const refusing = {
      query: async (sql, params) => {
        if (sql.includes("INSERT INTO aiark_people") && String(params[6]).includes("Gérante")) {
          throw Object.assign(new Error("invalid input syntax for type json"), { code: "22P02" });
        }
        return pool.query(sql, params);
      },
    };
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    await step(cf);
    await due(run.id);
    await step(cf, { pool: refusing });
    const r = await runRow(run.id);
    const got = await one(
      `SELECT count(*)::int AS registered,
              (SELECT count(*)::int FROM enrich_cells c JOIN enrich_rows w ON w.id = c.row_id
                WHERE w.table_id = $3 AND w.row_key = 'aiark:' || $1 AND c.column_key = 'title') AS titles
         FROM aiark_people WHERE person_id = $1 AND run_id = $2 AND row_id IS NOT NULL`,
      [refused, run.id, run.table_id]
    );
    check("a value Postgres refuses every time (SQLSTATE class 22): the person goes in without it, and the paid job is not held", r.status === "done" && r.pulled === 30 && r.attempts === 0 && got.registered === 1 && got.titles === 0, `${r.status} ${r.pulled} ${r.attempts} ${JSON.stringify(got)}`);
  }
  {
    const tx = createDemoTransport({});
    let n = 0;
    const held = "2026-01-01T00:00:00.000Z";
    let id = null;
    const cf = demoClient(overlay(tx, async (req) => {
      if (req.url.includes("/export/single") && ++n === 4) {
        await pool.query(`UPDATE aiark_runs SET claim_token = gen_random_uuid(), claimed_at = $2 WHERE id = $1`, [id, held]);
      }
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    id = run.id;
    await step(cf);
    const r = await runRow(id);
    const s = await tableStats(run.table_id, id);
    const lost = await one(`SELECT count(*)::int AS n FROM aiark_people WHERE run_id = $1 AND row_id IS NULL`, [id]);
    check("a claim lost at a person's write: the paid person is still in the table", s.rows === 4 && s.registered === 4 && lost.n === 0, `${JSON.stringify(s)} ${lost.n}`);
    check("  … the slice stops, and the new holder's lease is left alone", new Date(r.claimed_at).toISOString() === held, String(r.claimed_at));
    await pool.query(`UPDATE aiark_runs SET claim_token = NULL, claimed_at = NULL WHERE id = $1`, [id]);
    const st = await drive(id, demoClient(tx));
    const e = await runRow(id);
    const s2 = await tableStats(run.table_id, id);
    check("  … and the run finishes with everyone in both", st === "done" && e.pulled === 20 && s2.rows === 20 && s2.registered === 20, `${st} ${JSON.stringify(s2)}`);
  }
  {
    const tx = createDemoTransport({});
    let n = 0;
    let fresh = null;
    let id = null;
    const cf = demoClient(overlay(tx, async (req) => {
      if (!req.url.includes("/export/single")) return;
      n++;
      if (n === 2) await pool.query(`UPDATE aiark_runs SET claimed_at = now() - interval '9 minutes' WHERE id = $1`, [id]);
      if (n === 3) fresh = await one(`SELECT now() - claimed_at < interval '1 minute' AS yes FROM aiark_runs WHERE id = $1`, [id]);
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    id = run.id;
    await step(cf);
    check("a person's write renews the lease", fresh?.yes === true, JSON.stringify(fresh));
    await due(id);
    await drive(id, demoClient(tx));
  }
  {
    const tx = createDemoTransport({});
    let fresh = null;
    let id = null;
    const cf = demoClient(overlay(tx, async (req) => {
      if (req.url.endsWith("/people/preview")) await pool.query(`UPDATE aiark_runs SET claimed_at = now() - interval '9 minutes' WHERE id = $1`, [id]);
      if (req.url.includes("/export/single") && !fresh) fresh = await one(`SELECT now() - claimed_at < interval '1 minute' AS yes FROM aiark_runs WHERE id = $1`, [id]);
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    id = run.id;
    await step(cf);
    check("a Preview credit renews the lease", fresh?.yes === true, JSON.stringify(fresh));
    await due(id);
    await drive(id, demoClient(tx));
  }
  {
    const tx = createDemoTransport({});
    const held = "2026-01-01T00:00:00.000Z";
    let id = null;
    const cf = demoClient(overlay(tx, async (req) => {
      if (req.url.endsWith("/people/preview")) await pool.query(`UPDATE aiark_runs SET claim_token = gen_random_uuid(), claimed_at = $2 WHERE id = $1`, [id, held]);
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    id = run.id;
    await step(cf);
    check("  … but not another worker's", new Date((await runRow(id)).claimed_at).toISOString() === held && (await runRow(id)).pulled === 0);
    await settle(id);
  }
  {
    const tx = createDemoTransport({});
    const run = await newRun({ size: 20, requests: [search()] });
    await step(demoClient(tx), { pool: flaky((sql) => sql.includes("INSERT INTO aiark_people"), 3) });
    const r = await runRow(run.id);
    check("a person's write that fails is tried again: three failures lose nobody", r.pulled === 20 && r.attempts === 0 && Number(r.credits_used) === tx.state.charged, `${r.pulled} ${r.attempts} ${r.credits_used} vs ${tx.state.charged}`);
    await due(run.id);
    await drive(run.id, demoClient(tx));
  }
  {
    const tx = createDemoTransport({});
    let singles = 0;
    const cf = demoClient(overlay(tx, (req) => { if (req.url.includes("/export/single")) singles++; }));
    const run = await newRun({ size: 60, requests: [search(SEVERAL_PLACES)] });
    await step(cf, { shouldStop: () => singles >= 3 });
    const a = await runRow(run.id);
    check("told to stop between people: the run is let go at once, nobody half done", singles === 3 && a.pulled === 3 && a.claim_token === null && new Date(a.next_run_at) - Date.now() < 2_000 && a.status === "running" && (a.progress.page ?? 0) === 0, `${singles} ${a.pulled} ${a.claim_token}`);
    const st = await drive(run.id, cf);
    const s = await tableStats(run.table_id, run.id);
    check("  … and the next worker carries on, buying nobody twice", st === "done" && s.keys === 60 && singles === 60, `${st} ${s.keys} ${singles}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let stop = false;
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 150, requests: [search(SEVERAL_PLACES)] });
    await step(cf);
    await due(run.id);
    await step(cf, { shouldStop: () => stop || !(stop = true) });
    const a = await runRow(run.id);
    check("told to stop part-way through a job's page: the job is kept for the next worker", a.claim_token === null && Boolean(a.progress.job?.track_id) && a.pulled < 100, `${a.claim_token} ${a.pulled}`);
    const st = await drive(run.id, cf);
    check("  … and read from there", st === "done" && (await runRow(run.id)).pulled === 150, st);
  }
}

/** B13. Not a client budget: a stop for a run that keeps paying without gaining people. */
async function brake() {
  section("B13. The spending brake");
  const credits = (id, n) => pool.query(`UPDATE aiark_runs SET credits_used = $2 WHERE id = $1`, [id, n]);
  {
    const tx = createDemoTransport({});
    const run = await newRun({ size: 10, requests: [search()] });
    await credits(run.id, 28); // 13 + 5 + 10
    const st = await drive(run.id, demoClient(tx));
    const r = await runRow(run.id);
    check("a run at its ceiling stops before spending more", st === "stopped" && r.pulled === 0 && tx.state.charged === 0 && /spending brake/.test(r.stop_reason ?? ""), `${st} ${r.stop_reason}`);
  }
  {
    const tx = createDemoTransport({});
    const run = await newRun({ size: 10, requests: [search()] });
    await credits(run.id, 27);
    const st = await drive(run.id, demoClient(tx));
    const r = await runRow(run.id);
    check("  … one credit under it, a slice still runs: its Preview page, and nothing past the limit", st === "stopped" && tx.state.charged === 1 && Number(r.credits_used) === 28, `${st} ${tx.state.charged} ${r.credits_used}`);
  }
  {
    const tx = createDemoTransport({});
    const run = await newRun({ size: 100, requests: [search(SEVERAL_PLACES)] });
    await credits(run.id, 130); // 125 + 5 + 10 = 140
    const st = await drive(run.id, demoClient(tx));
    const r = await runRow(run.id);
    check("a single run's brake holds inside a page: it stops before a call that could pass the limit", st === "stopped" && Number(r.credits_used) === 140 && tx.state.charged === 10 && r.pulled < 100 && /spending brake/.test(r.stop_reason ?? ""), `${st} ${r.credits_used} charged ${tx.state.charged} pulled ${r.pulled}`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    let posts = 0;
    const cf = demoClient(overlay(tx, (req) => { if (isPost(req)) posts++; }));
    const run = await newRun({ strategy: "export", size: 100, requests: [search()] });
    await credits(run.id, 41); // 125 + 5 + 10 = 140, and the job could cost 100
    const st = await drive(run.id, cf);
    const r = await runRow(run.id);
    check("an export that could pass the ceiling is not posted", st === "stopped" && posts === 0 && /spending brake/.test(r.stop_reason ?? ""), `${st} posts ${posts}`);
    const run2 = await newRun({ strategy: "export", size: 100, requests: [search()] });
    await credits(run2.id, 40);
    await drive(run2.id, cf);
    check("  … one that fits is", posts === 1, `${posts} posts`);
  }
  {
    const tx = createDemoTransport({ jobMs: 0 });
    const cf = demoClient(tx);
    const run = await newRun({ strategy: "export", size: 30, requests: [search()] });
    await step(cf);
    await credits(run.id, 500);
    await due(run.id);
    const st = await drive(run.id, cf);
    check("a job already paid for is read whatever the spend: reading is free", st === "done" && (await runRow(run.id)).pulled === 30, st);
  }
}

/** B14. Export Single can be charged on an answer that never arrives. */
async function lostAnswers() {
  section("B14. Export Single: a lost answer");
  for (const [label, fault] of [
    ["a timeout", () => { throw new TypeError("fetch failed"); }],
    ["a 500", () => ans(500, { status: 500, error: "unexpected error" })],
  ]) {
    const tx = createDemoTransport({});
    let singles = 0;
    let previews = 0;
    let lostId = null;
    const cf = demoClient(overlay(tx, (req) => {
      if (req.url.endsWith("/people/preview")) previews++;
      if (req.url.includes("/export/single") && ++singles === 3) {
        lostId = JSON.parse(req.body).id;
        return fault();
      }
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    const st = await drive(run.id, cf);
    const r = await runRow(run.id);
    const reg = await one(`SELECT count(*)::int AS n FROM aiark_people WHERE person_id = $1`, [lostId]);
    check(`${label} on one person: that person is skipped, left unregistered and counted`, st === "done" && r.pulled === 20 && reg.n === 0 && r.progress.lost_answers === 1 && r.attempts === 0, `${st} ${r.pulled} ${reg.n} ${r.progress.lost_answers}`);
    check("  … the call is not repeated and the page is not paid for again", previews === 1 && singles === 21, `${previews} previews, ${singles} singles`);
  }
  {
    const tx = createDemoTransport({});
    let singles = 0;
    let down = true;
    const cf = demoClient(overlay(tx, (req) => {
      if (req.url.includes("/export/single") && down && ++singles >= 2) throw new TypeError("fetch failed");
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    await step(cf);
    const a = await runRow(run.id);
    check("five lost in a row: an outage, so the run backs off instead of walking the page", singles === 6 && a.attempts === 1 && a.pulled === 1 && a.progress.lost_answers === 5 && new Date(a.next_run_at) > new Date() && (a.progress.page ?? 0) === 0, `${singles} singles, ${a.attempts} ${a.pulled} ${a.progress.lost_answers}`);
    down = false;
    const st = await drive(run.id, cf);
    check("  … and carries on when AI Ark is back", st === "done" && (await runRow(run.id)).pulled === 20, st);
  }
  {
    const tx = createDemoTransport({});
    let singles = 0;
    const cf = demoClient(overlay(tx, (req) => {
      if (req.url.includes("/export/single") && ++singles % 2 === 0 && singles <= 12) throw new TypeError("fetch failed");
    }));
    const run = await newRun({ size: 20, requests: [search()] });
    await step(cf);
    const a = await runRow(run.id);
    check("six lost, but never five in a row: no back-off", a.attempts === 0 && a.progress.lost_answers === 6 && a.pulled === 20, `${a.attempts} ${a.progress.lost_answers} ${a.pulled}`);
    await due(run.id);
    await drive(run.id, cf);
  }
}

/** B15. An error a run got past is not shown on it once it has finished. */
async function recovered() {
  section("B15. A run that gets past an error");
  const tx = createDemoTransport({});
  let failing = 3;
  const cf = demoClient(overlay(tx, (req) => (req.url.endsWith("/people/preview") && failing-- > 0 ? ans(500, { status: 500, error: "unexpected error" }) : undefined)));
  const run = await newRun({ size: 20, requests: [search()] });
  await step(cf);
  const a = await runRow(run.id);
  await due(run.id);
  await step(cf); // the next slice finishes the run
  const b = await runRow(run.id);
  check("an error, then a slice that finishes the run: it ends done, with no error left on it", /500/.test(a.last_error ?? "") && b.status === "done" && b.pulled === 20 && b.last_error === null, `${a.last_error} → ${b.status} ${b.last_error}`);
}

// ── C. Outcomes against the database's own rules ────────────────────────────

async function partC({ r1 }) {
  section("C1. Cleaning title rule: JavaScript = Postgres (fn_whole_term_regex)");
  const { rows: terms } = await pool.query(`SELECT term FROM commercial_cleaning_excluded_titles ORDER BY term`);
  const samples = [];
  for (const { term } of terms) {
    for (const s of [term, `${term}s`, `Senior ${term}`, `${term} II`, `x${term}`, `${term}x`, term.toUpperCase(), term.replace(/ /g, "  "), `${term}-lead`]) {
      samples.push([term, s]);
    }
  }
  const { rows: pgRes } = await pool.query(
    `SELECT t, s, s ~* fn_whole_term_regex(t) AS hit FROM unnest($1::text[], $2::text[]) AS x(t, s)`,
    [samples.map((x) => x[0]), samples.map((x) => x[1])]
  );
  const mism = pgRes.filter((r) => new RegExp(wholeTermSource(r.t), "iu").test(r.s) !== r.hit);
  check(`${samples.length} title/term pairs agree`, mism.length === 0, mism.slice(0, 5).map((m) => `${m.t} | ${m.s} pg=${m.hit}`).join("; "));

  section("C2. Area rule cases");
  resetClientChecks();
  const area = (city, state, country) => CLIENT_ACTIONS.client_area.run({ inputs: { city, state, country }, table: { client_tag: TAG }, db: pool });
  const t = await one(`SELECT include_locations FROM client_targeting WHERE client_tag = $1`, [TAG]);
  const first = t.include_locations[0];
  const stName = (await one(`SELECT name FROM geo_admin1 WHERE country_code = $1 AND state_code = $2`, [first.country, first.state])).name;
  check(`"${first.city}, ${stName}" is inside`, (await area(first.city, stName, "United States")).value === true);
  check("state as a code works too", (await area(first.city, first.state, "United States")).value === true);
  check("punctuation/case differences ignored", (await area(first.city.toUpperCase().replace(/-/g, " "), stName, "United States")).value === true);
  check("same city name, wrong state → outside", (await area(first.city, "Missouri", "United States")).value === false);
  check("Springfield, Missouri → outside", (await area("Springfield", "Missouri", "United States")).value === false);
  const metro = await area("Greater New York City Area", "", "United States");
  check("a metro with no state → can't tell (false)", metro.value === false && metro.display === "Can't tell");
  check("another country → outside", (await area("Toronto", "Ontario", "Canada")).value === false);
  const solo = await one(
    `SELECT e->>'city' AS city FROM client_targeting t, jsonb_array_elements(t.include_locations) e
      WHERE t.client_tag = $1
        AND (SELECT count(DISTINCT (g.country_code, g.admin1_code)) FROM geo_locations g
              WHERE g.city_key = regexp_replace(lower(e->>'city'), '[^a-z]', '', 'g')) = 1
      LIMIT 1`,
    [TAG]
  );
  if (solo) check(`"${solo.city}", which one state holds, is inside with no state given`, (await area(solo.city, "", "United States")).value === true);

  section("C3. Every outcome in a run, against the database's rules");
  // Four of run 1's people with a usable email get a history in the lead database.
  const { rows: usable } = await pool.query(
    `SELECT e.value #>> '{}' AS email
       FROM enrich_cells e JOIN enrich_cells s ON s.row_id = e.row_id AND s.column_key = 'email_status' AND s.value = '"VALID"'::jsonb
      WHERE e.table_id = $1 AND e.column_key = 'email' ORDER BY e.row_id LIMIT 4`,
    [r1.table_id]
  );
  const [inDb, never, bounced, inCopy] = usable.map((r) => r.email);
  created.emails.push(inDb, never, bounced);
  await pool.query(`INSERT INTO leads (email, company) VALUES ($1, 'aiark test lead')`, [inDb]);
  await pool.query(`INSERT INTO leads (email, company, is_bounced, bounce_type) VALUES ($1, 'aiark test lead', true, 'hard')`, [bounced]);
  await pool.query(`INSERT INTO suppressed_emails (email, reason) VALUES ($1, 'aiark test')`, [never]);
  await pool.query(`INSERT INTO bison_leads (instance_url, bison_id, email) VALUES ($1, 1, $2)`, [TEST_DOMAIN, inCopy.toUpperCase()]);

  // The real worker, drain-and-exit, works out every queued row's outcome.
  const others = await one(
    `SELECT count(*)::int AS n FROM enrich_rows WHERE run_status IN ('queued', 'running') AND NOT (table_id = ANY($1::uuid[]))`,
    [created.tables]
  );
  if (others.n) {
    check("no other queued rows (the worker would work them too)", false, `${others.n} queued rows in other tables`);
    return;
  }
  const worker = spawnSync(process.execPath, [fileURLToPath(new URL("./enrich-worker.mjs", import.meta.url))], {
    env: { ...process.env, ENRICH_ONCE: "1", ENRICH_POLL_MS: "500", ENRICH_CONCURRENCY: "8", ENRICH_WORKER_ID: "aiark-test" },
    encoding: "utf8",
    timeout: 300_000,
  });
  check("worker drained and exited", worker.status === 0, (worker.stderr || worker.stdout).slice(-400));
  const left = await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = ANY($1::uuid[]) AND run_status <> 'done'`, [created.tables]);
  check("every run row done", left.n === 0, `${left.n} not done`);

  const cond = (await one(`SELECT fn_commercial_cleaning_condition() AS c`)).c;
  const { rows: people } = await pool.query(
    `SELECT r.id, r.search_text,
            jsonb_object_agg(c.column_key, c.value) FILTER (WHERE c.value IS NOT NULL) AS v,
            jsonb_object_agg(c.column_key, c.display) FILTER (WHERE c.display IS NOT NULL) AS d
       FROM enrich_rows r JOIN enrich_cells c ON c.row_id = r.id
      WHERE r.table_id = $1 GROUP BY r.id ORDER BY r.id`,
    [r1.table_id]
  );
  const counts = {};
  let wrong = 0;
  const wrongs = [];
  for (const p of people) {
    const v = p.v ?? {};
    const usableEmail = v.email && v.email_status === "VALID";
    const o = await one(
      `WITH t AS (SELECT * FROM client_targeting WHERE client_tag = $1),
            pc AS (SELECT code FROM supported_countries WHERE lower(name) = lower($5))
       SELECT EXISTS (SELECT 1 FROM suppressed_emails WHERE email = $2) OR EXISTS (SELECT 1 FROM leads WHERE email = $2 AND is_suppressed) AS never,
              EXISTS (SELECT 1 FROM leads WHERE email = $2 AND is_bounced) AS bounced,
              EXISTS (SELECT 1 FROM leads WHERE email = $2) OR EXISTS (SELECT 1 FROM bison_leads WHERE lower(email) = $2) AS indb,
              EXISTS (SELECT 1 FROM t, jsonb_array_elements(t.include_locations) e
                       WHERE upper(e->>'country') = (SELECT code FROM pc)
                         AND (e->>'state' IS NULL OR upper(e->>'state') = (SELECT state_code FROM geo_admin1 g WHERE g.country_code = (SELECT code FROM pc) AND lower(g.name) = lower($4)))
                         AND (e->>'city' IS NULL OR regexp_replace(lower(e->>'city'), '[^a-z]', '', 'g') = regexp_replace(lower($3), '[^a-z]', '', 'g'))) AS inside,
              EXISTS (SELECT 1 FROM t, unnest(t.exclude_terms) term
                       WHERE $6 ~* fn_regex_escape(term) OR $7 ~* fn_regex_escape(term) OR $8 ~* fn_whole_term_regex(term)) AS excluded,
              (SELECT commercial_cleaning FROM t) AS cleaning`,
      [TAG, v.email ?? "", v.city ?? "", v.state ?? "", v.country ?? "", v.company ?? "", v.company_industry ?? "", v.company_description ?? ""]
    );
    const titleOut = o.cleaning ? (await one(`SELECT NOT (${cond}) AS out FROM (SELECT $1::text AS title) l`, [v.title ?? null])).out : false;
    // The demo's names match no test lead: C9 checks the look-up by name.
    const expect = o.never ? "On the never-contact list"
      : o.bounced ? "Bounced"
      : o.indb ? "Already in the database"
      : !o.inside ? "Outside the client's area"
      : o.excluded || titleOut ? "Excluded by the client's rules"
      : !usableEmail ? "No email"
      : "Ready to add";
    counts[v.outcome] = (counts[v.outcome] ?? 0) + 1;
    if (v.outcome !== expect) {
      wrong++;
      if (wrongs.length < 5) wrongs.push(`${v.full_name}: got ${v.outcome}, expected ${expect}`);
    }
  }
  check(`all ${people.length} outcomes match the database's rules`, wrong === 0, wrongs.join("; "));
  console.log(`        outcomes: ${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(" · ")}`);
  const byEmail = (e) => people.find((p) => p.v?.email === e)?.v?.outcome;
  check("the lead already in the database", byEmail(inDb) === "Already in the database");
  check("the never-contact address", byEmail(never) === "On the never-contact list");
  check("the bounced lead", byEmail(bounced) === "Bounced");
  check("the address only in the copy of Email Bison", byEmail(inCopy) === "Already in the database");
  for (const want of ["No email", "Outside the client's area", "Ready to add"]) {
    check(`the demo produced "${want}"`, (counts[want] ?? 0) > 0);
  }
  const later = await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key IN ('find_email', 'add_to_database')`, [r1.table_id]);
  check("later-phase columns are shown but never run", later.n === 0);
  const sample = people.find((p) => p.v?.full_name && !p.v.full_name.includes("***"));
  check("rows are searchable by name, title and email", sample && sample.search_text.includes(sample.v.full_name.toLowerCase()) && sample.search_text.includes(String(sample.v.title).toLowerCase()));

  const { rows: pendingRows } = await pool.query(
    `SELECT v.value #>> '{}' AS verdict, o.value #>> '{}' AS outcome
       FROM enrich_cells s
       JOIN enrich_cells v ON v.row_id = s.row_id AND v.column_key = 'email_verdict'
       JOIN enrich_cells o ON o.row_id = s.row_id AND o.column_key = 'outcome'
      WHERE s.table_id = $1 AND s.column_key = 'email_status' AND s.value = '"PENDING"'::jsonb`,
    [pendingTable]
  );
  check("people whose email is still being checked have their own outcome, not No email", pendingRows.length > 0 && pendingRows.every((r) => r.verdict === "Pending" && r.outcome === "Email still being checked"), JSON.stringify(pendingRows.slice(0, 2)));

  const fields = /RUN_FIELDS = `([\s\S]*?)`/.exec(source("src/lib/aiark/server.ts"))[1];
  await pool.query(`UPDATE aiark_runs SET match_count = 3134 WHERE id = $1`, [r1.id]);
  const shown = await one(`SELECT ${fields} FROM aiark_runs r LEFT JOIN user_profiles up ON up.id = r.created_by WHERE r.id = $1`, [r1.id]);
  check("match_count reaches the tab as a number", shown.match_count === 3134, `${typeof shown.match_count} ${shown.match_count}`);
  check("the webhook answers 200 with an empty body, as AI Ark's docs ask", /new NextResponse\(null, \{ status: 200 \}\)/.test(source("src/app/api/aiark/webhook/route.ts")));

  const excl = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Bistro Holdings", title: "Owner" }, table: { client_tag: TAG }, db: pool });
  check("exclusion term anywhere in the company name", excl.status === "done" && /bistro/.test(excl.display));
  const sub = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Barbershop Supply", title: "Owner" }, table: { client_tag: TAG }, db: pool });
  check('"bar" catches "Barbershop" (contains, as the database does)', sub.status === "done" && /"bar"/.test(sub.display));
  const ttl = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Northgate Realty", title: "Senior Accountant" }, table: { client_tag: TAG }, db: pool });
  check("cleaning client: a cleaning-excluded title is caught", ttl.status === "done" && /Job title/.test(ttl.display), JSON.stringify(ttl));
  const clean = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Northgate Realty", title: "Office Manager" }, table: { client_tag: TAG }, db: pool });
  check("a clear company and title → empty", clean.status === "empty");
}

// ── C, continued: each rule against what the database really does ───────────

async function dropRuleData() {
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
  await pool.query(`DELETE FROM bison_leads WHERE instance_url = $1`, [TEST_DOMAIN]);
  await pool.query(`DELETE FROM suppressed_emails WHERE email LIKE $1`, [`%@${TEST_DOMAIN}`]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag LIKE $1`, [`${RULE_PREFIX}%`]);
  await pool.query(`DELETE FROM commercial_cleaning_excluded_titles WHERE term = $1`, [TEST_TITLE]);
}

/** A made-up client. Its rows are removed at the end of the run. */
async function rule(name, { countries = ["US"], include = [], exclude = [], terms = [], cleaning = false } = {}) {
  const tag = `${RULE_PREFIX}${name}`;
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, require_location)
     VALUES ($1, $2, $3, $4, $5, $6, true)`,
    [tag, countries, JSON.stringify(include), JSON.stringify(exclude), terms, cleaning]
  );
  return tag;
}

/** The import's own state rule and tables, so these checks can't drift from it. */
async function importGeography() {
  const js = ts.transpileModule(source("src/lib/uploads/geography.ts"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(`${js}\nexport { US_STATES, CA_PROVINCES };`)}`);
}

/** The import's own company rule. */
const cleanCompanyName = new Function(
  "raw",
  /export function cleanCompanyName\(raw: string\): string \| undefined \{\n([\s\S]*?)\n\}/.exec(source("src/lib/uploads/normalize-row.ts"))[1]
);

/** What the send gate says about the test leads for a client: email -> true/false. */
async function gateFor(tag) {
  const { conds } = await one(`SELECT fn_client_eligibility_conditions($1) AS conds`, [tag]);
  const { rows } = await pool.query(`SELECT l.email, (${conds.join(" AND ")}) IS TRUE AS ok FROM leads l WHERE l.email LIKE $1`, [`%@${TEST_DOMAIN}`]);
  return new Map(rows.map((r) => [r.email, r.ok]));
}

/** One pass of the real engine over the real run columns. */
const runColumns = () => order(RUN_COLUMNS.map((c) => ({ ...c })));
async function workRow(columns, tag, inputs, { db = pool, row = {}, stored = [] } = {}) {
  const cells = new Map(stored);
  for (const [k, v] of Object.entries(inputs)) cells.set(k, { status: "done", value: v, display: String(v), note: null, input_hash: null });
  const out = new Map();
  const result = await engineRow({
    row: { id: 1, created_at: new Date(), run_force: null, ...row },
    table: { client_tag: tag, keyCounts: {} },
    columns,
    cells,
    env: {},
    db,
    hooks: { changed: (k, c) => out.set(k, c) },
  });
  return { ...result, out, cell: (k) => out.get(k) };
}

async function areaAgainstGate(geo) {
  section("C4. Area rule: JavaScript = the real location resolver + the real send gate");
  const waiting = await one(
    `SELECT count(*)::int AS n FROM leads WHERE state_code IS NULL AND (city IS NOT NULL OR state IS NOT NULL) AND email NOT LIKE $1`,
    [`%@${TEST_DOMAIN}`]
  );
  if (waiting.n) {
    check("no other leads waiting for the location resolver (it would work them too)", false, `${waiting.n} leads`);
    return;
  }
  const { normalizeStateValue, US_STATES, CA_PROVINCES } = await importGeography();
  const US = "United States";
  const places = [
    { country: "US", state: "WA", city: "Seattle" },
    { country: "US", state: "MN", city: "Saint Paul" },
    { country: "US", state: "FL", city: "St. Petersburg" },
    { country: "US", state: "DC", city: "Washington" },
    { country: "CA", state: "QC", city: "Laval" },
    { country: "CA", state: "NL", city: "Gander" },
    { country: "CA", state: "PE", city: "Charlottetown" },
    { country: "CA", state: "BC", city: "Vancouver" },
    { country: "CA", state: "MB", city: "Ile des Chênes" },
  ];
  const clients = {
    "city entries": await rule("PLACES", { countries: ["US", "CA"], include: places }),
    "state entries": await rule("STATES", { countries: ["US", "CA"], include: [{ country: "US", state: "WA" }, { country: "CA", state: "QC" }] }),
    "a country-only entry": await rule("COUNTRY", { include: [{ country: "US" }] }),
    "no places": await rule("NOPLACES", { countries: ["US", "CA"] }),
    "no countries": await rule("NOCOUNTRY", { countries: [], include: [{ country: "US" }] }),
    "a state excluded": await rule("EXSTATE", { countries: ["CA"], include: [{ country: "CA" }], exclude: [{ country: "CA", state: "QC" }] }),
    "a city excluded": await rule("EXCITY", { include: [{ country: "US" }], exclude: [{ country: "US", state: "WA", city: "Seattle" }] }),
    "an accented city excluded": await rule("EXACCENT", { countries: ["CA"], include: [{ country: "CA" }], exclude: [{ country: "CA", state: "QC", city: "Montréal" }] }),
  };
  const P = {
    places: clients["city entries"],
    country: clients["a country-only entry"],
    none: clients["no places"],
    nocountry: clients["no countries"],
    exstate: clients["a state excluded"],
    exaccent: clients["an accented city excluded"],
  };
  const people = [
    // A state gives the country, however the country is spelled.
    { city: "Seattle", state: "Washington", country: US },
    { city: "Seattle", state: "WA", country: US },
    { city: "Seattle", state: "washington", country: "usa" },
    { city: "Seattle", state: "Washington", country: "" },
    { city: "Seattle", state: "Washington", country: "U.S.A." },
    { city: "Seattle", state: "Washington", country: "America" },
    // No state: only a city exactly one state holds places the person.
    { city: "Seattle", state: "", country: US },
    { city: "Seattle", state: "", country: "" },
    { city: "Laval", state: "", country: "Canada" },
    { city: "Vancouver", state: "", country: "Canada" },
    { city: "Vancouver", state: "British Columbia", country: "Canada" },
    { city: "Springfield", state: "", country: US },
    { city: "Springfield", state: "Missouri", country: US },
    { city: "Greater Seattle Area", state: "", country: US },
    { city: "Greater Seattle Area", state: "Washington", country: US },
    { city: "", state: "Washington", country: US },
    { city: "", state: "", country: US },
    { city: "", state: "", country: "" },
    // Saint/St, Fort/Ft and Mount/Mt: the resolver takes the text as it is.
    { city: "Saint Paul", state: "Minnesota", country: US },
    { city: "St. Paul", state: "Minnesota", country: US },
    { city: "St. Petersburg", state: "Florida", country: US },
    { city: "Saint Petersburg", state: "Florida", country: US },
    // Spellings only the import knows.
    { city: "Laval", state: "Québec", country: "Canada" },
    { city: "Laval", state: "QUÉBEC", country: "Canada" },
    { city: "Laval", state: "Quebec", country: "Canada" },
    { city: "Laval", state: "QC", country: "Canada" },
    { city: "Gander", state: "Newfoundland", country: "Canada" },
    { city: "Gander", state: "Newfoundland and Labrador", country: "Canada" },
    { city: "Charlottetown", state: "PEI", country: "Canada" },
    { city: "Washington", state: "Washington, D.C.", country: US },
    { city: "Washington", state: "District of Columbia", country: US },
    // Accents: folded for a person, not for a client's entry.
    { city: "Lavál", state: "Quebec", country: "Canada" },
    { city: "Ile des Chênes", state: "Manitoba", country: "Canada" },
    { city: "Ile des Chenes", state: "Manitoba", country: "Canada" },
    { city: "Île-des-Chênes", state: "Manitoba", country: "Canada" },
    { city: "Montréal", state: "Québec", country: "Canada" },
    { city: "Montreal", state: "Quebec", country: "Canada" },
    // States nobody knows.
    { city: "San Juan", state: "Puerto Rico", country: US },
  ];
  // The resolver never reads the country, so here the gate would take someone
  // AI Ark puts elsewhere. These are refused on purpose.
  const elsewhere = [
    { city: "Seattle", state: "Washington", country: "Germany" },
    { city: "Seattle", state: "Washington", country: "Canada" },
    { city: "Seattle", state: "", country: "Canada" },
  ];
  const email = (kind, i) => `${kind}${i}@${TEST_DOMAIN}`;
  const asLeads = (kind, list) => list.map((p, i) => [email(kind, i), p.city || null, p.state ? normalizeStateValue(p.state) ?? p.state : null, p.country || null]);
  for (const row of [...asLeads("area", people), ...asLeads("elsewhere", elsewhere)]) {
    await pool.query(`INSERT INTO leads (email, company, city, state, country) VALUES ($1, 'aiark test lead', $2, $3, $4)`, row);
  }
  const resolver = spawnSync(process.execPath, [fileURLToPath(new URL("./backfill-lead-locations.mjs", import.meta.url))], {
    env: process.env,
    encoding: "utf8",
    timeout: 120_000,
  });
  check("the location resolver ran over them", resolver.status === 0, (resolver.stderr || resolver.stdout).slice(-400));

  resetClientChecks();
  const area = (tag, inputs) => CLIENT_ACTIONS.client_area.run({ inputs, table: { client_tag: tag }, db: pool });
  for (const [name, tag] of Object.entries(clients)) {
    const gate = await gateFor(tag);
    const wrong = [];
    let inside = 0;
    for (const [i, p] of people.entries()) {
      const js = await area(tag, p);
      if (js.value === true) inside++;
      if ((js.value === true) !== gate.get(email("area", i))) wrong.push(`${JSON.stringify(p)} js=${js.display} gate=${gate.get(email("area", i))}`);
    }
    check(`${name}: ${people.length} people, the gate's answer every time (${inside} inside)`, wrong.length === 0, wrong.slice(0, 3).join("; "));
  }
  const gate = await gateFor(P.places);
  for (const [i, p] of elsewhere.entries()) {
    const js = await area(P.places, p);
    check(`${JSON.stringify(p)}: refused, though the gate would take them`, js.value === false && gate.get(email("elsewhere", i)) === true, `${js.display} gate=${gate.get(email("elsewhere", i))}`);
  }

  const shows = async (tag, inputs) => (await area(tag, inputs)).display;
  check("no state, a city one state holds → placed by the city", (await shows(P.places, { city: "Seattle", country: US })) === "Inside");
  check("no state, no country, the same city → placed by the city", (await shows(P.places, { city: "Seattle" })) === "Inside");
  check("no country → the state gives it", (await shows(P.places, { city: "Seattle", state: "Washington" })) === "Inside");
  for (const spelled of ["U.S.A.", "USA", "America", "United States of America"]) {
    check(`the country spelled "${spelled}"`, (await shows(P.places, { city: "Seattle", state: "Washington", country: spelled })) === "Inside");
  }
  check("a city in two countries stays can't tell, even for a client with one of them", (await shows(P.places, { city: "Vancouver", country: "Canada" })) === "Can't tell");
  check("a city in many states stays can't tell", (await shows(P.places, { city: "Springfield", country: US })) === "Can't tell");
  check('"St. Paul" is not the client\'s "Saint Paul"', (await shows(P.places, { city: "St. Paul", state: "Minnesota", country: US })) === "Outside");
  check('"Saint Petersburg" is not the client\'s "St. Petersburg"', (await shows(P.places, { city: "Saint Petersburg", state: "Florida", country: US })) === "Outside");
  const accented = await area(P.places, { city: "Ile des Chenes", state: "Manitoba", country: "Canada" });
  check("an accented entry matches nobody, and the note says why", accented.value === false && /accent/.test(accented.note), accented.note);
  check("an accented exclusion excludes nobody", (await shows(P.exaccent, { city: "Montreal", state: "Quebec", country: "Canada" })) === "Inside");
  check("a state exclusion sees Québec", /excludes/.test((await area(P.exstate, { city: "Laval", state: "Québec", country: "Canada" })).note));
  check("a country-only entry, a metro with no state → can't tell", (await shows(P.country, { city: "Greater Seattle Area", country: US })) === "Can't tell");
  check("a country-only entry, nothing but a country → can't tell", (await shows(P.country, { country: US })) === "Can't tell");
  check("a country-only entry, a known state → inside", (await shows(P.country, { city: "Greater Seattle Area", state: "Washington", country: US })) === "Inside");
  check("no places, no state → can't tell", (await shows(P.none, { country: US })) === "Can't tell");
  check("no places, a known state → inside", (await shows(P.none, { state: "Washington", country: US })) === "Inside");
  const noCountry = await area(P.nocountry, { city: "Seattle", state: "Washington", country: US });
  check("an empty country list allows no country", noCountry.value === false && /no countries/.test(noCountry.note), noCountry.note);

  const spellings = Object.entries({ ...US_STATES, ...CA_PROVINCES });
  const unknown = spellings.filter(([s, code]) => findState(geo, s)?.state !== code || findState(geo, s.toUpperCase())?.state !== code);
  check(`all ${spellings.length} of the import's state spellings are known`, unknown.length === 0, unknown.slice(0, 5).join("; "));
  check('"WA" is the US state, in the resolver\'s order', findState(geo, "WA")?.country === "US");
  check('"Western Australia" is not', findState(geo, "Western Australia")?.country === "AU");
  const ck = new Function("s", `return ${/^const ck = \(s\) => (.+);$/m.exec(source("scripts/backfill-lead-locations.mjs"))[1]};`);
  const cities = [...new Set(people.map((p) => p.city).filter(Boolean))];
  check(`cityKey is the resolver's key for all ${cities.length} of these places`, cities.every((c) => cityKey(c) === ck(c)));
}

async function failedChecks() {
  section("C5. A check that fails is never read as nothing found");
  resetClientChecks();
  const tag = await rule("FAILS", { include: [{ country: "US", state: "WA", city: "Seattle" }], terms: ["bistro"] });
  const columns = runColumns();
  const person = {
    full_name: "Pat Example", title: "Office Manager", company: "Northgate Realty", company_industry: "real estate",
    city: "Seattle", state: "Washington", country: "United States", email: `pat@${TEST_DOMAIN}`,
    email_status: "VALID", email_domain_type: "SMTP", aiark_id: "abc",
  };
  const failing = (pattern) => ({
    query: async (sql, params) => {
      if (pattern.test(sql)) throw new Error("Connection terminated unexpectedly");
      return pool.query(sql, params);
    },
  });

  const fine = await workRow(columns, tag, person);
  check("with every check answering: Ready to add", fine.cell("outcome").value === "Ready to add" && fine.errors === 0, JSON.stringify(fine.cell("outcome")));

  await pool.query(`INSERT INTO suppressed_emails (email, reason) VALUES ($1, 'aiark test')`, [person.email]);
  const lookup = await workRow(columns, tag, person, { db: failing(/bison_leads/) });
  check("the address check fails → Outcome is an error, not Ready to add", lookup.cell("in_database").status === "error" && lookup.cell("outcome").status === "error" && lookup.cell("outcome").value === null, JSON.stringify(lookup.cell("outcome")));
  check("the Outcome cell names the failed column", /Lead database/.test(lookup.cell("outcome").note), lookup.cell("outcome").note);
  check("the row is still retried", /Lead database/.test(lookup.retryable ?? ""), String(lookup.retryable));
  const after = await workRow(columns, tag, person, { stored: [...lookup.out] });
  check("the retry works it out", after.cell("outcome").value === "On the never-contact list" && after.errors === 0, JSON.stringify(after.cell("outcome")));
  await pool.query(`DELETE FROM suppressed_emails WHERE email = $1`, [person.email]);

  resetClientChecks();
  const rules = await workRow(columns, tag, { ...person, city: "Springfield", state: "Missouri", company: "Harbor Bistro" }, { db: failing(/client_targeting/) });
  check("the rules can't be read → both checks and Outcome are errors", rules.cell("in_area").status === "error" && rules.cell("rule_match").status === "error" && rules.cell("outcome").status === "error");
  check("the Outcome cell names both", /Inside the client's area/.test(rules.cell("outcome").note) && /Client exclusions/.test(rules.cell("outcome").note), rules.cell("outcome").note);
  const noEmail = Object.fromEntries(Object.entries(person).filter(([k]) => k !== "email" && k !== "email_status"));
  resetClientChecks();
  const blind = await workRow(columns, tag, noEmail, { db: failing(/client_targeting/) });
  check("no email and the rules can't be read → an error, retried, not sent to the pipeline", blind.cell("outcome").status === "error" && /Inside the client's area/.test(blind.retryable ?? ""), JSON.stringify(blind.cell("outcome")));
  resetClientChecks();
  for (const pattern of [/bison_leads/, /ILIKE/]) {
    const lost = await workRow(columns, tag, { ...noEmail, first_name: "Pat", last_name: "Example", domain: TEST_DOMAIN }, { db: failing(pattern) });
    check(`no email and the database check fails (${pattern.source}) → an error, retried, not sent to the pipeline`, lost.cell("in_database").status === "error" && lost.cell("outcome").status === "error" && /Lead database/.test(lost.retryable ?? ""), JSON.stringify(lost.cell("outcome")));
  }
  for (const [label, inputs, want] of [
    ["an email AI Ark was still checking", { ...noEmail, email_status: "PENDING" }, "Email still being checked"],
    ["bought in an earlier run", { ...person, pulled_before: "Bought 2026-01-01" }, "Bought in an earlier run"],
  ]) {
    resetClientChecks();
    const row = await workRow(columns, tag, inputs, { db: failing(/client_targeting/) });
    check(`the rules can't be read, and the Outcome doesn't need them (${label}): "${want}"`, row.cell("in_area").status === "error" && row.cell("outcome").value === want, JSON.stringify(row.cell("outcome")));
  }

  resetClientChecks();
  const none = await workRow(columns, `${RULE_PREFIX}NO_SUCH_CLIENT`, person);
  check("no rules for the client → an error Outcome, with no retry", none.cell("outcome").status === "error" && none.retryable === null, JSON.stringify(none.cell("outcome")));

  // Beside the run columns: a chain of formulas, and a waterfall.
  const chain = order([
    { key: "email", name: "Email", kind: "input", position: 1, phase: 1 },
    { key: "dupe", name: "Dupe check", kind: "action", action: "lead_lookup", inputs: { email: "{{email}}" }, position: 2, phase: 1 },
    { key: "safe", name: "Safe to run", kind: "formula", formula: "!{{dupe}}", position: 3, phase: 1 },
    { key: "next", name: "Next step", kind: "formula", formula: `{{safe}} ? "go" : "stop"`, position: 4, phase: 1 },
    { key: "free", name: "Unrelated", kind: "formula", formula: `{{email}} ? "yes" : "no"`, position: 5, phase: 1 },
    { key: "fall", name: "Fallback", kind: "waterfall", waterfall: ["{{dupe}}", `"fallback"`], position: 6, phase: 1 },
    {
      key: "guarded", name: "Guarded", kind: "formula", position: 7, phase: 1,
      formula: `(() => { try { return {{dupe}} ? "in" : "out"; } catch { return "caught"; } })()`,
    },
    { key: "branch", name: "Branch", kind: "formula", formula: `{{email}} ? "has email" : {{dupe}}`, position: 8, phase: 1 },
  ]);
  const chained = await workRow(chain, tag, { email: person.email }, { db: failing(/bison_leads/) });
  check("a formula over a failed check is an error, not a confident true", chained.cell("safe").status === "error" && /Dupe check/.test(chained.cell("safe").note));
  check("so is a formula over that formula", chained.cell("next").status === "error" && /Safe to run/.test(chained.cell("next").note));
  check("a formula that doesn't read it is untouched", chained.cell("free").value === "yes");
  check("a waterfall works as it did", chained.cell("fall").value === "fallback");
  check("a formula that would catch its own error still can't hide the failed read", chained.cell("guarded").status === "error" && /Dupe check/.test(chained.cell("guarded").note), JSON.stringify(chained.cell("guarded")));
  check("a formula whose branch never reaches the failed check keeps its answer", chained.cell("branch").value === "has email", JSON.stringify(chained.cell("branch")));
}

async function companyText() {
  section("C6. The company text: what the gate will hold, not what AI Ark sent");
  resetClientChecks();
  const tag = await rule("TERMS", { terms: ["commercial cleaning", "fast food"] });
  const raw = ["Acme | Commercial Cleaning", "Fast  Food Express", "Commercial Cleaning | Acme", "| Fast  Food", "Acme   Holdings", "Acme"];
  const email = (i) => `company${i}@${TEST_DOMAIN}`;
  for (const [i, company] of raw.entries()) {
    await pool.query(
      `INSERT INTO leads (email, company, city, state, state_code, country_code, location_status) VALUES ($1, $2, 'Seattle', 'Washington', 'WA', 'US', 'partial')`,
      [email(i), cleanCompanyName(company)]
    );
  }
  const gate = await gateFor(tag);
  const answers = [];
  for (const [i, company] of raw.entries()) {
    const js = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company }, table: { client_tag: tag }, db: pool });
    answers.push(js.status === "empty");
    check(`"${company}": ${gate.get(email(i)) ? "clear" : "excluded"}, as the gate says`, (js.status === "empty") === gate.get(email(i)), JSON.stringify(js));
  }
  check("both answers came up", answers.includes(true) && answers.includes(false));
  check('"Acme | Commercial Cleaning" is judged as "Acme"', answers[0] === true);
  check('"Fast  Food Express" is judged with one space', answers[1] === false);

  // The words that caught 13 of 100 people in the live test: none is a word for "pub" or "bar".
  const short = await rule("SHORTTERMS", { terms: ["pub", "bar", "fast food"] });
  const excluded = (inputs) => CLIENT_ACTIONS.client_exclusions.run({ inputs, table: { client_tag: short }, db: pool });
  for (const description of ["A publicly traded company", "Removing barriers to care", "Bariatric surgery", "Barney's", "We embark on projects"]) {
    const r = await excluded({ company: "Northgate Realty", description });
    check(`description "${description}" is clear: the term is inside a longer word`, r.status === "empty", JSON.stringify(r));
  }
  for (const [description, term] of [["A family pub", "pub"], ["Sports bars and grills", "bar"], ["PUB & GRILL", "pub"], ["The bar, downtown", "bar"], ["Fast  food chain", "fast food"]]) {
    const r = await excluded({ company: "Northgate Realty", description });
    check(`description "${description}" is excluded: "${term}" is a word in it`, r.status === "done" && r.display === `"${term}" in the company description`, JSON.stringify(r));
  }
  const inName = await excluded({ company: "Republic Holdings", description: "A property company" });
  check("in the company name the term still matches inside a word: the send gate would refuse it", inName.status === "done" && /company name/.test(inName.display), JSON.stringify(inName));
  const inIndustry = await excluded({ company: "Northgate Realty", industry: "Public Safety" });
  check("so it does in the industry", inIndustry.status === "done" && /industry/.test(inIndustry.display), JSON.stringify(inIndustry));
}

async function ruleChanges() {
  section("C7. A rule changed just before a re-run");
  resetClientChecks();
  const tag = await rule("RERUN", { include: [{ country: "US" }], terms: ["alpha"], cleaning: true });
  const columns = runColumns();
  let reads = 0;
  const db = {
    query: (sql, params) => {
      if (/client_targeting/.test(sql)) reads++;
      return pool.query(sql, params);
    },
  };
  const person = {
    title: "Office Manager", company: "Beta Cleaners", city: "Seattle", state: "Washington", country: "United States",
    email: `rerun@${TEST_DOMAIN}`, email_status: "VALID", email_domain_type: "SMTP", aiark_id: "abc",
  };
  const outcome = async (row, over = {}) => (await workRow(columns, tag, { ...person, ...over }, { db, row })).cell("outcome").value;
  check("before the change: Ready to add", (await outcome()) === "Ready to add");
  await pool.query(`UPDATE client_targeting SET exclude_terms = '{beta}' WHERE client_tag = $1`, [tag]);
  const before = reads;
  check("a row queued before that read keeps the cached rules for now", (await outcome({ next_run_at: new Date(Date.now() - 60_000) })) === "Ready to add" && reads === before, String(reads - before));
  const click = (await one(`SELECT now() AS t`)).t;
  check("a re-run after the change sees it", (await outcome({ next_run_at: click })) === "Excluded by the client's rules");
  check("for one extra read", reads === before + 1, String(reads - before));
  check("and the rest of that re-run reuses it", (await outcome({ next_run_at: click })) === "Excluded by the client's rules" && reads === before + 1, String(reads - before));
  // Worked alone, as client_area usually refreshes the rules first in a row.
  await pool.query(`UPDATE client_targeting SET exclude_terms = '{gamma}' WHERE client_tag = $1`, [tag]);
  const alone = await CLIENT_ACTIONS.client_exclusions.run({
    inputs: { company: "Gamma Cleaners" },
    table: { client_tag: tag },
    row: { next_run_at: (await one(`SELECT now() AS t`)).t },
    db,
  });
  check("the exclusion check reads the new rule by itself", alone.status === "done" && /gamma/.test(alone.display), JSON.stringify(alone));
  await pool.query(`UPDATE client_targeting SET exclude_terms = '{beta}' WHERE client_tag = $1`, [tag]);
  resetClientChecks();

  const titled = { company: "Gamma Partners", title: "Aiark Test Title" };
  check("a title not on the cleaning list yet: Ready to add", (await outcome({ next_run_at: new Date(Date.now() - 60_000) }, titled)) === "Ready to add");
  await pool.query(`INSERT INTO commercial_cleaning_excluded_titles (term) VALUES ($1)`, [TEST_TITLE]);
  const again = (await one(`SELECT now() AS t`)).t;
  check("a re-run sees a cleaning title saved before the click", (await outcome({ next_run_at: again }, titled)) === "Excluded by the client's rules");
  check("the worker hands each row its next_run_at", /RETURNING[^`]*\bnext_run_at\b/.test(source("scripts/enrich-worker.mjs")));
}

async function emailBisonCopy() {
  section("C8. The copy of Email Bison");
  const email = `copy@${TEST_DOMAIN}`;
  const lookup = (e) => CLIENT_ACTIONS.lead_lookup.run({ inputs: { email: e }, db: pool });
  const miss = await lookup(email);
  check("an address nobody holds → empty", miss.status === "empty", JSON.stringify(miss));
  await pool.query(`INSERT INTO bison_leads (instance_url, bison_id, email) VALUES ($1, 2, $2)`, [TEST_DOMAIN, `Copy@${TEST_DOMAIN}`]);
  const hit = await lookup(email);
  check("an address only in the copy counts, whatever its case", hit.status === "done" && hit.value.in_bison === true && hit.value.lead_id === null && hit.value.never_contact === false, JSON.stringify(hit));
  await pool.query(`INSERT INTO bison_leads (instance_url, bison_id, email) VALUES ($1, 3, $2)`, [TEST_DOMAIN, email]);
  const twice = await lookup(email);
  check("two installs holding it are one answer", twice.status === "done" && twice.value.in_bison === true, JSON.stringify(twice));
  await pool.query(`INSERT INTO suppressed_emails (email, reason) VALUES ($1, 'aiark test')`, [email]);
  const never = await lookup(email);
  check("the never-contact list still comes first", never.display === "Never contact" && never.value.never_contact === true, JSON.stringify(never));
  await pool.query(`DELETE FROM suppressed_emails WHERE email = $1`, [email]);
  await pool.query(`INSERT INTO leads (email, company) VALUES ($1, 'aiark test lead')`, [email]);
  const both = await lookup(email);
  check("in both: the lead", both.display === "In the database" && Boolean(both.value.lead_id) && both.value.in_bison === true, JSON.stringify(both));
  const idx = await one(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'bison_leads' AND indexdef ILIKE '%lower(email)%'`);
  check("an index serves the lookup", idx.n > 0);
}

async function beforeThePipeline() {
  section("C9. Before the pipeline: is this person with no email already held?");
  resetClientChecks();
  const tag = await rule("HELD", { include: [{ city: "Dayton", state: "OH", country: "US" }], terms: ["bistro"] });
  const columns = runColumns();
  const d = TEST_DOMAIN;
  const person = { full_name: "Pat Example", first_name: "Pat", last_name: "Example", title: "Office Manager", company: "Northgate Realty", domain: d, city: "Dayton", state: "Ohio", country: "United States", aiark_id: "abc" };
  const work = (over = {}, opts = {}) => workRow(columns, tag, Object.fromEntries(Object.entries({ ...person, ...over }).filter(([, v]) => v !== undefined)), opts);
  const outcome = async (over) => (await work(over)).cell("outcome").value;
  const lead = (email, fields = {}) => {
    const row = { email, company: "aiark test lead", first_name: "Pat", last_name: "Example", ...fields };
    const keys = Object.keys(row);
    return pool.query(`INSERT INTO leads (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(row));
  };
  const reset = async () => {
    await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%@${d}`]);
    await pool.query(`DELETE FROM bison_leads WHERE instance_url = $1`, [d]);
    await pool.query(`DELETE FROM suppressed_emails WHERE email LIKE $1`, [`%@${d}`]);
  };
  await reset();

  const guesses = likelyAddresses("Pat", "Example", d);
  check("13 likely addresses, the three commonest among them", guesses.length === 13 && [`pat@${d}`, `pexample@${d}`, `pat.example@${d}`].every((x) => guesses.includes(x)), guesses.join());
  check("accents, case and punctuation don't count", likelyAddresses("José", "O'Brien-Díaz", "WWW.Acme.Example").includes("jose.obriendiaz@acme.example"));
  check("no domain, or a free-mail one, no guess: john.smith@gmail.com is many people", !likelyAddresses("Pat", "Example", "").length && !likelyAddresses("Pat", "Example", "Gmail.com").length && !likelyAddresses("Pat", "", d).length && !likelyAddresses("李", "王", d).length);

  check("nobody holds them: No email, in the pipeline", (await outcome()) === "No email");
  const missing = await work();
  check("and the cell says why", missing.cell("in_database").status === "empty" && /no usable email/.test(missing.cell("in_database").note), JSON.stringify(missing.cell("in_database")));

  const notFound = [];
  for (const address of guesses) {
    await lead(address);
    const r = await work();
    const v = r.cell("in_database").value;
    if (r.cell("outcome").value !== "Already in the database" || v?.matched_on !== "likely address" || v?.address !== address || !v?.lead_id) notFound.push(address);
    await reset();
  }
  check("a lead at any of the 13, under the same name: Already in the database", notFound.length === 0, notFound.join());

  await lead(`pexample@${d}`, { first_name: "Priya" });
  check("the same address under another first name is someone else: No email", (await outcome()) === "No email");
  await reset();
  await lead(`pat@${d}`, { last_name: "Other" });
  check("under another last name, the same", (await outcome()) === "No email");
  await reset();
  await lead(`pat.example@${d}`, { last_name: null });
  check("the row has no last name, the first agrees: held", (await outcome()) === "Already in the database");
  await reset();
  await lead(`pat.example@${d}`, { first_name: null, last_name: null });
  check("the row has no name at all: nothing confirms it", (await outcome()) === "No email");
  await reset();
  await lead(`jose.diaz@${d}`, { first_name: "JOSE", last_name: "Diaz" });
  check("accents and case don't hide the name", (await outcome({ first_name: "José", last_name: "Díaz", full_name: "José Díaz" })) === "Already in the database");
  await reset();

  await pool.query(`INSERT INTO bison_leads (instance_url, bison_id, email, first_name, last_name) VALUES ($1, 11, $2, 'Pat', 'Example')`, [d, `Pat.Example@${d}`.toUpperCase()]);
  const copy = await work();
  check("only in the copy of Email Bison, same name: held", copy.cell("outcome").value === "Already in the database" && copy.cell("in_database").value.in_bison === true && copy.cell("in_database").value.lead_id === null, JSON.stringify(copy.cell("in_database")));
  await reset();
  await pool.query(`INSERT INTO bison_leads (instance_url, bison_id, email, first_name, last_name) VALUES ($1, 13, $2, 'Priya', 'Example')`, [d, `pexample@${d}`]);
  check("in the copy under another name: No email", (await outcome()) === "No email");
  await reset();

  await lead(`pat.example@${d}`, { is_bounced: true, bounce_type: "hard" });
  check("the matched lead bounced: Bounced", (await outcome()) === "Bounced");
  await reset();
  await lead(`pat.example@${d}`, { is_suppressed: true });
  check("the matched lead is marked never contact: on the list", (await outcome()) === "On the never-contact list");
  await reset();
  await lead(`pat.example@${d}`);
  await pool.query(`INSERT INTO suppressed_emails (email, reason) VALUES ($1, 'aiark test')`, [`pat.example@${d}`]);
  check("the matched address is on the list: on the list", (await outcome()) === "On the never-contact list");
  await reset();
  await lead(`pat@${d}`);
  await lead(`pat.example@${d}`, { is_bounced: true });
  await lead(`pexample@${d}`, { is_suppressed: true });
  check("three addresses for one name: the strongest answer", (await outcome()) === "On the never-contact list");
  await reset();
  await pool.query(`INSERT INTO suppressed_emails (email, reason) VALUES ($1, 'aiark test')`, [`pexample@${d}`]);
  check("a guess only on the never-contact list has no name to check: the pipeline may run, the address check stops it", (await outcome()) === "No email");
  await reset();

  await lead(`someone@${d}`, { company: "Northgate Realty" });
  const sameCompany = await work({ domain: undefined });
  check("no domain, same name and company: held", sameCompany.cell("outcome").value === "Already in the database" && sameCompany.cell("in_database").value.matched_on === "name and company", JSON.stringify(sameCompany.cell("in_database")));
  check("the company's case doesn't count", (await outcome({ domain: undefined, company: "NORTHGATE realty" })) === "Already in the database");
  check('the first "|" part is the company', (await outcome({ domain: undefined, company: " Northgate  Realty | Property Management" })) === "Already in the database");
  check("no first and last name cells: the full name is split", (await outcome({ domain: undefined, first_name: undefined, last_name: undefined })) === "Already in the database");
  check("a different domain doesn't stop the name match", (await outcome({ domain: "other.example" })) === "Already in the database");
  check("another company: No email", (await outcome({ domain: undefined, company: "Northgate Realty Group" })) === "No email");
  check("another first name: No email", (await outcome({ domain: undefined, first_name: "Priya" })) === "No email");
  check("another last name: No email", (await outcome({ domain: undefined, last_name: "Sample" })) === "No email");
  check("no company and no domain: nothing to go on", (await outcome({ domain: undefined, company: undefined })) === "No email");
  check("only a first name: nothing to go on", (await outcome({ domain: undefined, last_name: undefined, full_name: "Pat" })) === "No email");

  check('a masked last name fits by its letters ("Ex***e")', (await outcome({ domain: undefined, last_name: "Ex***e", full_name: "Pat Ex***e" })) === "Already in the database");
  check('a short mask fits too ("E***")', (await outcome({ domain: undefined, last_name: "E***", full_name: "Pat E***" })) === "Already in the database");
  check('a mask that doesn\'t fit: No email ("Sm***h")', (await outcome({ domain: undefined, last_name: "Sm***h", full_name: "Pat Sm***h" })) === "No email");
  check("a mask with no letters says nothing", (await outcome({ domain: undefined, last_name: "***", full_name: "Pat ***" })) === "No email");
  let asked = 0;
  const counting = { query: (sql, params) => { if (/unnest\(\$1::text\[\]\) AS e/.test(sql)) asked++; return pool.query(sql, params); } };
  check("a masked last name makes no address guesses, even with a domain", (await work({ last_name: "Ex***e", full_name: "Pat Ex***e" }, { db: counting })).cell("outcome").value === "Already in the database" && asked === 0, String(asked));
  await reset();

  await lead(`someone@${d}`, { company: "100xxClean" });
  check("% and _ in a company are plain text", (await outcome({ domain: undefined, company: "100%_Clean" })) === "No email");
  await reset();
  await lead(`someone@${d}`, { company: "Northgate Realty" });
  check("and in a last name", (await outcome({ domain: undefined, last_name: "Ex_mple" })) === "No email" && (await outcome({ domain: undefined, last_name: "%" })) === "No email");
  await reset();

  const usable = { email: `new@${d}`, email_status: "VALID", email_domain_type: "SMTP" };
  await lead(`pat.example@${d}`);
  await lead(`someone@${d}`, { company: "Northgate Realty" });
  check("a usable address nobody holds is looked up by that address alone: Ready to add", (await outcome(usable)) === "Ready to add");
  check("a catch-all address the same", (await outcome({ ...usable, email_domain_type: "CATCH_ALL" })) === "Ready to add");
  const invalid = { email: `dead@${d}`, email_status: "INVALID (MAILBOX_NOT_FOUND)", email_domain_type: "UNKNOWN" };
  check("an address AI Ark rejected is no use: looked for by name", (await outcome(invalid)) === "Already in the database");
  await reset();
  check("an address AI Ark rejected, nobody holds it, no name match: No email", (await outcome(invalid)) === "No email");
  await lead(`dead@${d}`, { first_name: "Someone", last_name: "Else" });
  const rejected = await work(invalid);
  check("the rejected address is itself held: already in the database, by address", rejected.cell("outcome").value === "Already in the database" && !rejected.cell("in_database").value.matched_on, JSON.stringify(rejected.cell("in_database")));
  await reset();

  await lead(`pat.example@${d}`);
  let looked = 0;
  const watching = { query: (sql, params) => { if (/\bleads\b/.test(sql)) looked++; return pool.query(sql, params); } };
  const pending = await work({ email_status: "PENDING" }, { db: watching });
  check("AI Ark still checking: not looked up, and the Outcome says so", pending.cell("in_database").status === "skipped" && pending.cell("outcome").value === "Email still being checked" && looked === 0, String(looked));
  const before = await work({ pulled_before: "Bought 2026-01-01" });
  check("bought in an earlier run is said first", before.cell("outcome").value === "Bought in an earlier run");
  await reset();
  check("bought in an earlier run, no email: not sent to the pipeline twice", (await outcome({ pulled_before: "Bought 2026-01-01" })) === "Bought in an earlier run");
  check("no email, outside the client's area: no finder would be paid for someone refused anyway", (await outcome({ city: "Springfield", state: "Missouri" })) === "Outside the client's area");
  check("no email, excluded by the client's rules: the same", (await outcome({ company: "Harbor Bistro" })) === "Excluded by the client's rules");

  const find = RUN_COLUMNS.find((c) => c.key === "find_email");
  check("the email-finding step takes only the Outcome No email", find.run_if === `{{outcome}} === "No email"` && find.phase === 3);
  const engineFind = order(RUN_COLUMNS.map((c) => (c.key === "find_email" ? { ...c, action: "client_exclusions", phase: 1 } : { ...c })));
  const stepped = (await workRow(engineFind, tag, person)).cell("find_email");
  await lead(`pat.example@${d}`);
  const held = (await workRow(engineFind, tag, person)).cell("find_email");
  check("run for real, the step runs for someone new and is skipped for someone held", stepped.status !== "skipped" && held.status === "skipped", JSON.stringify([stepped, held]));
  await reset();

  // Through the real lookups, a person held comes out of the pipeline's count.
  const run = await newRun({ size: 2 });
  const { source_id } = await one(`SELECT source_id FROM aiark_runs WHERE id = $1`, [run.id]);
  const seat = async (n, outcomeCell) => {
    const { id } = await one(`INSERT INTO enrich_rows (table_id, source_id, row_key, run_status) VALUES ($1, $2, $3, 'done') RETURNING id`, [run.table_id, source_id, `aiark:held-${n}`]);
    await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display) VALUES ($1, 'outcome', $2, 'done', to_jsonb($3::text), $3)`, [id, run.table_id, outcomeCell]);
    return Number(id);
  };
  const newcomer = await seat(1, (await work()).cell("outcome").value);
  await lead(`pat.example@${d}`);
  const heldRow = await seat(2, (await work()).cell("outcome").value);
  const state = await addState(pool, run.table_id);
  check("the pipeline counts the newcomer, not the person held", state.pipeline === 1, JSON.stringify(state));
  check("emailFound takes the newcomer", await emailFound(pool, { rowId: newcomer, email: `found-held@${d}` }));
  check("and refuses the person held: they never went to the pipeline", !(await emailFound(pool, { rowId: heldRow, email: `found-held2@${d}` })));
  await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE table_id = $1`, [run.table_id]);
  await pool.query(`UPDATE aiark_runs SET status = 'done', finished_at = now() WHERE id = $1`, [run.id]);
  await reset();

  const indexes = await one(`SELECT count(*)::int AS n FROM pg_indexes WHERE tablename = 'leads' AND indexdef ILIKE '%gin_trgm_ops%' AND indexdef ILIKE '%(company %'`);
  check("a trigram index on the company serves the name look-up", indexes.n > 0);
  resetClientChecks();
}

// ── D. Add to the database ──────────────────────────────────────────────────

async function addToDatabase() {
  section("D1. The import rows");
  const row = importRow({
    email: `pat@${TEST_DOMAIN}`, first_name: "Mary Ann", last_name: "Smith", full_name: "Mary Ann Smith", title: "Office Manager",
    company: "Acme Cleaning", domain: "acme.example", city: "Dayton", state: "Ohio", country: "United States",
    linkedin: "https://linkedin.example/in/pat", company_industry: "Facilities Services", company_description: "We clean offices",
    company_size: "1,234 (1,001–5,000)", email_verdict: "Catch-all",
  });
  const at = (k) => IMPORT_COLUMNS.findIndex(([, f]) => f === k);
  check("one value per import column", row.length === IMPORT_COLUMNS.length);
  check("AI Ark's own first and last name", row[at("first_name")] === "Mary Ann" && row[at("last_name")] === "Smith", JSON.stringify(row));
  check("without them, the full name splits at its first space", JSON.stringify(names({ full_name: " Mary  Ann Smith " })) === '["Mary","Ann Smith"]');
  check("employees only when AI Ark gave a headcount", headcount("1,234 (1,001–5,000)") === "1234" && headcount("1,001–5,000") === "" && headcount("5,001+") === "" && headcount(undefined) === "");
  check("a catch-all address goes in as catch_all, a valid one as valid", row[at("validation_status")] === "catch_all" && importRow({ email: "a@b.example", email_verdict: "Valid" })[at("validation_status")] === "valid");
  check("the industry goes to general_industry, with source AI Ark",
    row[at("general_industry")] === "Facilities Services" && row[at("source")] === "AI Ark" && row[at("person_linkedin")].endsWith("/in/pat"));
  check("the company description stays out of the lead, in the pull's table", !row.includes("We clean offices") && !IMPORT_COLUMNS.some(([h, k]) => /description/i.test(h) || k === "specific_industry" || k === "company_overview") && RUN_COLUMNS.some((c) => c.key === "company_description"));
  check("every extra field is an import column", EXTRA_FIELDS.every((k) => at(k) >= 0));
  const { d: gate } = await one(`SELECT pg_get_functiondef('fn_client_eligibility_conditions'::regproc) AS d`);
  check("the send gate looks for exclusion terms in the industry", /l\.general_industry/.test(gate));
  check("and a push doesn't send it to Email Bison", !/general_industry/.test(source("scripts/push-worker.mjs") + source("src/lib/bison/push-leads.ts")));
  const { d: leadsFilter } = await one(`SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p WHERE p.proname = 'fn_lead_filter_conditions' LIMIT 1`);
  check("why not on the lead: the gate reads specific_industry, the Leads page's exclusion filter company_overview too", /l\.specific_industry/.test(gate) && /l\.company_overview/.test(leadsFilter));

  section("D2. Who an add takes, skips and settles");
  const run = await newRun({ size: 5 });
  await pool.query(`UPDATE aiark_runs SET status = 'done', finished_at = now() WHERE id = $1`, [run.id]);
  const { source_id } = await one(`SELECT source_id FROM aiark_runs WHERE id = $1`, [run.id]);
  const email = (n) => `add${n}@${TEST_DOMAIN}`;
  const ids = {};
  for (const [n, outcome = "Ready to add"] of [[1], [2], [3], [4], [5, "No email"], [6], [7]]) {
    const { id } = await one(`INSERT INTO enrich_rows (table_id, source_id, row_key, run_status) VALUES ($1, $2, $3, 'done') RETURNING id`, [run.table_id, source_id, `aiark:add-${n}`]);
    ids[n] = Number(id);
    const cells = { email: email(n), full_name: `Pat Example${n}`, title: "Office Manager", company: "aiark test lead", email_verdict: "Valid", outcome };
    await pool.query(
      `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
       SELECT $1, k, $2, 'done', to_jsonb(v), left(v, 300) FROM jsonb_each_text($3::jsonb) AS t(k, v)`,
      [id, run.table_id, JSON.stringify(cells)]
    );
  }
  // Since their outcomes were worked out: 2 became a lead, 3 went on the never-contact list, 4 reached the Email Bison copy.
  await pool.query(`INSERT INTO leads (email, company) VALUES ($1, 'aiark test lead')`, [email(2)]);
  await pool.query(`INSERT INTO suppressed_emails (email, reason) VALUES ($1, 'aiark test')`, [email(3)]);
  await pool.query(`INSERT INTO bison_leads (instance_url, bison_id, email) VALUES ($1, 21, $2)`, [TEST_DOMAIN, email(4).toUpperCase()]);

  const state = async () => JSON.stringify(await addState(pool, run.table_id));
  const counts = (ready, added, skipped, adding, failed) => JSON.stringify({ ready, added, skipped, adding, failed, pipeline: 1 });
  const begin = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await beginAdd(c, { tableId: run.table_id, userId: null, filename: "aiark test add" });
      await c.query("COMMIT");
      if (out.batchId) created.batches.push(out.batchId);
      return out;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  };
  const cell = (n) => one(`SELECT status, value, display FROM enrich_cells WHERE row_id = $1 AND column_key = 'add_to_database'`, [ids[n]]);

  check("before: the six Ready to add, nobody else", (await state()) === counts(6, 0, 0, 0, 0), await state());
  const first = await begin();
  check("an add takes three and skips three at once", !first.busy && first.people.length === 3 && first.rows.length === 3 && first.skipped === 3, JSON.stringify(first.people));
  const [c2, c3, c4] = await Promise.all([2, 3, 4].map(cell));
  check("a lead since: Already in the database, with its lead", c2.status === "done" && c2.display === "Already in the database" && c2.value.reason === "lead" && Boolean(c2.value.lead_id), JSON.stringify(c2));
  check("never contact since: On the never-contact list", c3.status === "done" && c3.display === "On the never-contact list" && c3.value.reason === "never_contact", JSON.stringify(c3));
  check("in the Email Bison copy since, whatever its case: Already in the database", c4.status === "done" && c4.value.reason === "bison", JSON.stringify(c4));
  check("a person who isn't Ready to add is left alone", !(await cell(5)));
  const marks = await Promise.all([1, 6, 7].map(cell));
  check("the rest read as being added by the batch", marks.every((m) => m.status === "running" && m.value.batch_id === first.batchId), JSON.stringify(marks));
  const batch = await one(`SELECT status, duplicate_strategy, total_rows, batch_type, source_label FROM upload_batches WHERE id = $1`, [first.batchId]);
  check("the batch is an upload that skips duplicates", batch.status === "processing" && batch.duplicate_strategy === "skip" && batch.total_rows === 3 && batch.batch_type === "leads" && batch.source_label === "AI Ark", JSON.stringify(batch));
  check("a second add while one is under way is refused", (await begin()).busy === true);
  check("while adding: three adding, nobody ready", (await state()) === counts(0, 0, 3, 3, 0), await state());

  // What the import leaves behind, stood in for: 1 becomes a lead, someone else adds 7 first, 6 can't be stored.
  await pool.query(`INSERT INTO leads (email, company, source) VALUES ($1, 'aiark test lead', 'AI Ark')`, [email(1)]);
  await pool.query(`INSERT INTO leads (email, company, source) VALUES ($1, 'aiark test lead', 'upload')`, [email(7)]);
  await finishAdd(pool, { tableId: run.table_id, batchId: first.batchId, batchAt: first.batchAt, people: first.people });
  const [a1, a6, a7] = await Promise.all([1, 6, 7].map(cell));
  check("a new lead reads Added, with its lead", a1.status === "done" && a1.display === "Added" && a1.value.added === true && Boolean(a1.value.lead_id), JSON.stringify(a1));
  check("a lead someone else added first reads Already in the database", a7.status === "done" && a7.value.added === false && a7.display === "Already in the database", JSON.stringify(a7));
  check("a person the import could not store is an error", a6.status === "error" && a6.display === "Not added", JSON.stringify(a6));
  check("after: one added, four skipped, one not stored and ready again", (await state()) === counts(1, 1, 4, 0, 1), await state());

  const second = await begin();
  check("the next add takes only the person not stored", Boolean(second.batchId) && second.people.length === 1 && second.people[0].row_id === ids[6] && second.skipped === 0, JSON.stringify(second.people));
  await finishAdd(pool, { tableId: run.table_id, batchId: first.batchId, batchAt: first.batchAt, people: first.people });
  check("an older batch's finish leaves a newer add's cell alone", (await cell(6)).value.batch_id === second.batchId && (await cell(6)).status === "running");
  await pool.query(`UPDATE upload_batches SET created_at = now() - interval '4 hours' WHERE id = $1`, [second.batchId]);
  check("an add whose batch died with the server is ready again", (await state()) === counts(1, 1, 4, 0, 0), await state());
  const third = await begin();
  check("and the next add takes it", !third.busy && third.people.length === 1 && third.people[0].row_id === ids[6]);
  await pool.query(`INSERT INTO leads (email, company, source) VALUES ($1, 'aiark test lead', 'AI Ark')`, [email(6)]);
  await finishAdd(pool, { tableId: run.table_id, batchId: third.batchId, batchAt: third.batchAt, people: third.people });
  check("then everyone is settled", (await state()) === counts(0, 2, 4, 0, 0), await state());
  const again = await begin();
  check("and another add finds nobody to add", !again.busy && !again.batchId && again.people.length === 0 && again.skipped === 0);
  check("a demo pull is never sent on by itself", !(await pullsToAdd(pool, 500)).some((x) => x.id === run.id));

  section("D3. Finished pulls go to the database by themselves, once switched on");
  const LONG_KEY = "k".repeat(32);
  check("off without both settings", autoAddConfig({}) === null && autoAddConfig({ AIARK_AUTO_ADD_URL: "https://x.example/a" }) === null && autoAddConfig({ AIARK_AUTO_ADD_KEY: LONG_KEY }) === null);
  check("off with a short key", autoAddConfig({ AIARK_AUTO_ADD_URL: "https://x.example/a", AIARK_AUTO_ADD_KEY: "short" }) === null);
  const config = autoAddConfig({ AIARK_AUTO_ADD_URL: " https://x.example/a ", AIARK_AUTO_ADD_KEY: ` ${LONG_KEY}\n` });
  check("on with both, trimmed", config?.url === "https://x.example/a" && config.key === LONG_KEY);
  let sent = null;
  const answered = await requestAdd(config, "run-1", async (url, init) => {
    sent = { url, method: init.method, auth: init.headers.authorization, body: init.body };
    return { ok: true, status: 202, json: async () => ({ adding: 3 }) };
  });
  check("asks the web app with the key and the run", answered.ok && sent.url === config.url && sent.method === "POST" && sent.auth === `Bearer ${LONG_KEY}` && sent.body === '{"run":"run-1"}', JSON.stringify(sent));
  const busyAnswer = await requestAdd(config, "run-1", async () => ({ ok: false, status: 409, json: async () => ({ error: "being added" }) }));
  check("a refusal comes back with its reason", !busyAnswer.ok && busyAnswer.status === 409 && busyAnswer.why === "being added");
  const lostAnswer = await requestAdd(config, "run-1", async () => { throw new Error("down"); });
  check("no answer doesn't throw, and the key isn't in the reason", !lostAnswer.ok && lostAnswer.status === null && !lostAnswer.why.includes(LONG_KEY));

  const pull = await newRun({ size: 5 });
  await pool.query(`UPDATE aiark_runs SET mode = 'live', status = 'done', finished_at = now() WHERE id = $1`, [pull.id]);
  const { source_id: pullSource } = await one(`SELECT source_id FROM aiark_runs WHERE id = $1`, [pull.id]);
  const person = async (n, outcome) => {
    const { id } = await one(`INSERT INTO enrich_rows (table_id, source_id, row_key, run_status) VALUES ($1, $2, $3, 'done') RETURNING id`, [pull.table_id, pullSource, `aiark:pull-${n}`]);
    await pool.query(
      `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
       SELECT $1, k, $2, 'done', to_jsonb(v), left(v, 300) FROM jsonb_each_text($3::jsonb) AS t(k, v)`,
      [id, pull.table_id, JSON.stringify({ outcome, ...(outcome === "No email" ? {} : { email: `pull${n}@${TEST_DOMAIN}` }), full_name: "Pat Example", email_status: outcome === "No email" ? "" : "VALID" })]
    );
    return Number(id);
  };
  const due = async () => (await pullsToAdd(pool, 500)).some((x) => x.id === pull.id);
  const hasEmail = await person(1, "Ready to add");
  const noEmail = await person(2, "No email");
  check("a finished live pull with someone Ready to add goes", await due());
  check("the pull's no-email person waits in the pipeline", (await addState(pool, pull.table_id)).pipeline === 1, JSON.stringify(await addState(pool, pull.table_id)));
  await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [noEmail]);
  check("not while a row is still being worked: one pull, one upload", !(await due()));
  await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE id = $1`, [noEmail]);
  await pool.query(`UPDATE aiark_runs SET status = 'cancelled' WHERE id = $1`, [pull.id]);
  check("a cancelled pull waits for the button", !(await due()));
  await pool.query(`UPDATE aiark_runs SET status = 'running', finished_at = NULL WHERE id = $1`, [pull.id]);
  check("an unfinished pull waits", !(await due()));
  await pool.query(`UPDATE aiark_runs SET status = 'stopped', finished_at = now() WHERE id = $1`, [pull.id]);
  check("a pull the brake stopped goes: its people are paid for", await due());

  const c = await pool.connect();
  let auto;
  try {
    await c.query("BEGIN");
    auto = await beginAdd(c, { tableId: pull.table_id, userId: null, filename: "aiark test auto add" });
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  created.batches.push(auto.batchId);
  check("an add takes the person with an email, not the one without", auto.people.length === 1 && auto.people[0].row_id === hasEmail, JSON.stringify(auto.people));
  check("nothing more to send while it runs", !(await due()));
  await pool.query(`UPDATE upload_batches SET created_at = now() - interval '4 hours' WHERE id = $1`, [auto.batchId]);
  check("an add that died with the server is sent again", await due());
  await pool.query(`UPDATE upload_batches SET created_at = now() WHERE id = $1`, [auto.batchId]);
  await finishAdd(pool, { tableId: pull.table_id, batchId: auto.batchId, batchAt: auto.batchAt, people: auto.people });
  check("someone the import couldn't store is left to the button: no endless retries", !(await due()) && (await one(`SELECT status FROM enrich_cells WHERE row_id = $1 AND column_key = 'add_to_database'`, [hasEmail])).status === "error");
  await pool.query(`INSERT INTO leads (email, company, source) VALUES ($1, 'aiark test lead', 'AI Ark')`, [`pull1@${TEST_DOMAIN}`]);
  await pool.query(`DELETE FROM enrich_cells WHERE row_id = $1 AND column_key = 'add_to_database'`, [hasEmail]);

  section("D4. From the pipeline to the database");
  check("no address, no change", !(await emailFound(pool, { rowId: noEmail, email: "  " })));
  check("someone who already has an email isn't touched", !(await emailFound(pool, { rowId: hasEmail, email: `other@${TEST_DOMAIN}` })));
  await pool.query(`UPDATE enrich_rows SET run_status = 'running' WHERE id = $1`, [noEmail]);
  check("a row being worked isn't touched", !(await emailFound(pool, { rowId: noEmail, email: `found@${TEST_DOMAIN}` })));
  await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE id = $1`, [noEmail]);
  await pool.query(`INSERT INTO aiark_people (person_id, demo, run_id, row_id) VALUES ($1, false, $2, $3)`, [`aiark-test-found-${pull.id}`, pull.id, noEmail]);
  check("an address found is taken", await emailFound(pool, { rowId: noEmail, email: ` Found@${TEST_DOMAIN} ` }));
  const cellOf = async (k) => (await one(`SELECT value #>> '{}' AS v FROM enrich_cells WHERE row_id = $1 AND column_key = $2`, [noEmail, k]))?.v;
  check("the person's email cells hold it, lower-cased", (await cellOf("email")) === `found@${TEST_DOMAIN}` && (await cellOf("email_status")) === "VALID" && (await cellOf("email_domain_type")) === "SMTP");
  const queued = await one(`SELECT run_status FROM enrich_rows WHERE id = $1`, [noEmail]);
  check("the row goes back to be worked", queued.run_status === "queued", JSON.stringify(queued));
  const held = await one(`SELECT email, email_status FROM aiark_people WHERE row_id = $1`, [noEmail]);
  check("what was bought records the address", held.email === `found@${TEST_DOMAIN}` && held.email_status === "VALID", JSON.stringify(held));
  check("while it is worked, nothing is sent", !(await due()) || (await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = $1 AND run_status = 'queued'`, [pull.table_id])).n === 0);
  const tag = await rule("PIPELINE", { include: [{ city: "Dayton", state: "OH", country: "US" }] });
  const worked = await workRow(runColumns(), tag, { email: `found@${TEST_DOMAIN}`, email_status: "VALID", email_domain_type: "SMTP", city: "Dayton", state: "Ohio", country: "United States", company: "Northgate Realty", title: "Office Manager", full_name: "Pat Example" });
  check("worked again, the same checks make the person Ready to add", worked.cell("outcome").value === "Ready to add", JSON.stringify(worked.cell("outcome")));
  await pool.query(`UPDATE enrich_cells SET value = to_jsonb('Ready to add'::text), display = 'Ready to add' WHERE row_id = $1 AND column_key = 'outcome'`, [noEmail]);
  await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE id = $1`, [noEmail]);
  check("and the finished pull goes to the database again", await due());
  await pool.query(`DELETE FROM aiark_people WHERE row_id = $1`, [noEmail]);
}

// ── E. The standard filters for cleaning clients ────────────────────────────

function cleaningFilters(geo) {
  section("E. The standard filters for cleaning clients");
  const rules = { include_locations: [{ city: "Armonk", state: "NY", country: "US" }], exclude_terms: ["Bar", "JANITORIAL", "cafe"], commercial_cleaning: true };
  const std = buildRequests({ targeting: rules, people: CLEANING_DEFAULTS, geo, cleaning: true });
  const { contact, account } = std.requests[0];
  const sourcesOf = (x) => x.sources.map((s) => `${s.source}:${s.mode}`).join();

  check("the supplied lists, whole", CLEANING_DEFAULTS.titles.length === 287 && CLEANING_DEFAULTS.exclude_titles.length === 265 && CLEANING_EXCLUDE_KEYWORDS.length === 76 && CLEANING_DEFAULTS.exclude_industries.length === 13);
  const saving = cleanPeopleFilters(CLEANING_DEFAULTS);
  check("a client can save them as its own copy, nothing refused or cut", saving.errors.length === 0 && saving.value.titles.length === 287 && saving.value.exclude_titles.length === 265 && saving.value.employee_bands.length === 1, saving.errors.join("; "));
  const wordsIn = (x) => String(x).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const within = (a, b) => {
    for (let i = 0; i + a.length <= b.length; i++) if (a.every((w, j) => b[i + j] === w)) return true;
    return false;
  };
  /** Every phrase still matches through what is sent, and nothing else was added. */
  const sameMatches = (phrases, sent) => phrases.every((x) => sent.some((k) => within(wordsIn(k), wordsIn(x)))) && sent.every((k) => phrases.some((x) => x.toLowerCase() === k.toLowerCase()));
  const titleOf = (q) => q.contact.experience.latest.title.any;
  const title = titleOf(std.requests[0]);
  check("titles on the main current job, as words", !contact.experience.current && title.include.mode === "WORD" && title.exclude.mode === "WORD");
  const titlesOut = std.requests.flatMap((q) => titleOf(q).include.content);
  check("every supplied title still matches through what goes out, each in one group", titlesOut.length === new Set(titlesOut).size && titlesOut.length < 287 && sameMatches(CLEANING_DEFAULTS.titles, titlesOut), String(titlesOut.length));
  check("every supplied title to leave out still matches, in every search", std.requests.every((q) => titleOf(q).exclude.content.length < 265 && sameMatches(CLEANING_DEFAULTS.exclude_titles, titleOf(q).exclude.content)));
  check("8–6,800 employees, and the plan says unknown sizes can't be asked for", JSON.stringify(account.employeeSize) === '{"type":"RANGE","range":[{"start":8,"end":6800}]}' && std.notes.some((n) => n.includes("doesn't know")));
  const inds = account.industries.any;
  check("13 industries left out as exact catalog values, none included", !inds.include && inds.exclude.mode === "STRICT" && inds.exclude.content.length === 13 && inds.exclude.content.every((v) => v === v.toLowerCase()));
  check("government agencies and the self-employed left out", JSON.stringify(account.type) === '{"any":{"exclude":["GOVERNMENT_AGENCY","SELF_EMPLOYED"]}}');
  const co = account.keyword.any.exclude;
  const ppl = contact.keyword.any.exclude;
  const coveredBy = (list, x) => list.some((k) => within(wordsIn(k), wordsIn(x)));
  check("company keywords: every standard one is covered, and the client's sheet terms are added", CLEANING_EXCLUDE_KEYWORDS.every((x) => coveredBy(co.content, x)) && co.content.includes("Bar") && co.content.includes("cafe"), JSON.stringify(co.content.slice(-6)));
  check("on the three company fields AI Ark accepted, as words", sourcesOf(co) === "NAME:WORD,INDUSTRY:WORD,DESCRIPTION:WORD", sourcesOf(co));
  check("people keywords: the standard list only, in headline and summary", CLEANING_EXCLUDE_KEYWORDS.every((x) => coveredBy(ppl.content, x)) && !ppl.content.includes("Bar") && !ppl.content.includes("cafe") && sourcesOf(ppl) === "HEADLINE:WORD,SUMMARY:WORD", sourcesOf(ppl));
  check("the plan reports all of it", std.report.excludeTerms.standard === 76 && std.report.excludeTerms.total === 78 && std.report.excludeTerms.sent === 78 && std.report.peopleKeywords === 76 && std.report.excludeCompanyTypes.length === 2, JSON.stringify(std.report.excludeTerms));

  // What AI Ark accepted live on 2026-11-05, list by list, in bytes.
  const ACCEPTED = { titles: 2203, excludeTitles: 2539, places: 958, people: 1317, company: 1939 };
  const size = (x) => Buffer.byteLength(JSON.stringify(x));
  const withinAccepted = (q) =>
    size(titleOf(q).include.content) <= ACCEPTED.titles && size(titleOf(q).exclude.content) <= ACCEPTED.excludeTitles && size(q.contact.location.any.include) <= ACCEPTED.places &&
    size(q.contact.keyword.any.exclude.content) <= ACCEPTED.people && size(q.account.keyword.any.exclude.content) <= ACCEPTED.company && q.account.keyword.any.exclude.sources.length === 3;
  check("no list goes past what AI Ark accepted", std.requests.every(withinAccepted));
  const manyPlaces = { ...rules, include_locations: Array.from({ length: 363 }, (_, i) => ({ state: "NY", country: "US", city: `Place Number ${i}` })) };
  const wide = buildRequests({ targeting: manyPlaces, people: CLEANING_DEFAULTS, geo, cleaning: true });
  const wideTitles = new Set(wide.requests.map((q) => titleOf(q).include.content.join()));
  const widePlaces = new Set(wide.requests.flatMap((q) => q.contact.location.any.include));
  check("363 places: every search fits, and every place goes out with every title group", wide.requests.length <= 50 && wide.requests.length > 2 && wide.requests.every(withinAccepted) && widePlaces.size === 363 && wide.requests.length === wideTitles.size * new Set(wide.requests.map((q) => q.contact.location.any.include.join())).size, String(wide.requests.length));
  check("and the plan says a count costs a credit per search", wide.notes.some((n) => n.includes(`${wide.requests.length} searches`)));
  const tooWide = buildRequests({ targeting: { ...rules, include_locations: Array.from({ length: 3000 }, (_, i) => ({ state: "NY", country: "US", city: `Place Number ${i}` })) }, people: CLEANING_DEFAULTS, geo, cleaning: true });
  check("too many searches for one run: blocked, nothing to send", tooWide.requests.length === 0 && tooWide.blockers.some((b) => b.includes("more than one run can send")));
  const longList = buildRequests({ targeting: rules, people: { ...CLEANING_DEFAULTS, exclude_titles: Array.from({ length: 280 }, (_, i) => `made up long title number ${i}`) }, geo, cleaning: true });
  check("a list of titles to leave out over the limit: blocked, it can't be split", longList.requests.length === 0 && longList.blockers.some((b) => b.includes("too long")));

  const crowded = { ...rules, exclude_terms: [...Array.from({ length: 318 }, (_, i) => `a much longer sheet phrase ${i}`), "pub", "tavern"] };
  const cut = buildRequests({ targeting: crowded, people: CLEANING_DEFAULTS, geo, cleaning: true });
  const cutCo = cut.requests[0].account.keyword.any.exclude.content;
  check("too many sheet terms: every standard keyword still goes, within the size, and it says so", CLEANING_EXCLUDE_KEYWORDS.every((x) => coveredBy(cutCo, x)) && size(cutCo) <= ACCEPTED.company && cut.report.excludeTerms.sent < cut.report.excludeTerms.total && cut.notes.some((n) => n.includes("are checked after the pull")));
  check("the broadest sheet terms go first", cutCo.includes("pub") && cutCo.includes("tavern"));
  const covered = buildRequests({ targeting: { ...rules, exclude_terms: ["cleaning", "cleaning services", "janitorial"] }, people: CLEANING_DEFAULTS, geo, cleaning: true });
  const coveredCo = covered.requests[0].account.keyword.any.exclude.content;
  check("a sheet term that covers standard keywords stands in for them, and is never the one cut", coveredCo.some((k) => k.toLowerCase() === "cleaning") && !coveredCo.some((k) => k.toLowerCase() === "cleaning services") && CLEANING_EXCLUDE_KEYWORDS.every((x) => coveredBy(coveredCo, x)));
  check("condensing keeps the shorter phrase and the order", JSON.stringify(condensePhrases(["facility manager", "owner", "Facility", "business owner", "front-desk", "front desk"])) === JSON.stringify(["owner", "Facility", "front-desk"]));

  const own = buildRequests({ targeting: rules, people: { ...EMPTY_PEOPLE_FILTERS, titles: ["Owner"] }, geo, cleaning: true });
  check("a client's saved filters replace titles and size; keywords and company types still apply",
    titleOf(own.requests[0]).include.content.length === 1 && !own.requests[0].account.employeeSize && CLEANING_EXCLUDE_KEYWORDS.every((x) => coveredBy(own.requests[0].account.keyword.any.exclude.content, x)) && Boolean(own.requests[0].contact.keyword) && Boolean(own.requests[0].account.type));

  const other = buildRequests({ targeting: rules, people: { ...EMPTY_PEOPLE_FILTERS, titles: ["Owner"] }, geo });
  const otherCo = other.requests[0].account.keyword.any.exclude;
  check("any other client gets none of it: only its own terms, on its company", other.requests.length === 1 && otherCo.content.length === 3 && sourcesOf(otherCo) === "NAME:WORD,INDUSTRY:WORD,DESCRIPTION:WORD" && !other.requests[0].contact.keyword && !other.requests[0].account.type && other.report.excludeTerms.standard === 0 && other.report.peopleKeywords === 0);

  const elsewhere = ["scripts/lib/enrich/client-checks.mjs", "scripts/lib/enrich/engine.mjs", "scripts/lib/aiark/add.mjs", "scripts/push-worker.mjs", "scripts/sync-client-targeting-from-sheet.mjs"];
  check("the lists are for AI Ark's search only: the database's rules, the Outcome, adding leads and pushes never read them", elsewhere.every((f) => !/cleaning-filters|CLEANING_(TITLES|EXCLUDE|DEFAULTS|EMPLOYEE)/.test(source(f))));
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  if (created.emails.length) {
    await pool.query(`DELETE FROM leads WHERE email = ANY($1::text[]) AND company = 'aiark test lead'`, [created.emails]);
    await pool.query(`DELETE FROM suppressed_emails WHERE email = ANY($1::text[]) AND reason = 'aiark test'`, [created.emails]);
  }
  await dropRuleData();
  await dropHeldPeople();
  if (created.runs.length) {
    await pool.query(`DELETE FROM aiark_people WHERE run_id = ANY($1::uuid[])`, [created.runs]);
    await pool.query(`DELETE FROM aiark_runs WHERE id = ANY($1::uuid[])`, [created.runs]);
  }
  if (created.tables.length) {
    await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [created.tables]);
    await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [created.tables]).catch(() => {});
  }
  if (created.batches.length) await pool.query(`DELETE FROM upload_batches WHERE id = ANY($1::uuid[])`, [created.batches]);
}

// A run still reading a paid export makes every other run of its mode wait, so it counts too.
const busy = await one(
  `SELECT count(*)::int AS n FROM aiark_runs
    WHERE status IN ('queued', 'running') OR (status = 'cancelled' AND finished_at IS NULL AND jsonb_typeof(progress->'job') = 'object')`
);
if (busy.n) {
  console.error(`Refusing to run: ${busy.n} AI Ark run(s) are queued, running or still reading a paid export in this database. Let them finish or cancel them first.`);
  await pool.end();
  process.exit(1);
}
const t0 = Date.now();
try {
  const geo = await loadGeo(pool);
  await partA(geo);
  const b = await partB();
  await dropRuleData();
  await partC(b);
  await areaAgainstGate(geo);
  await failedChecks();
  await companyText();
  await ruleChanges();
  await emailBisonCopy();
  await beforeThePipeline();
  await addToDatabase();
  cleaningFilters(geo);
} catch (e) {
  failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const leftover = await one(
    `SELECT (SELECT count(*)::int FROM leads WHERE company = 'aiark test lead') AS leads,
            (SELECT count(*)::int FROM suppressed_emails WHERE reason = 'aiark test') AS supp,
            (SELECT count(*)::int FROM enrich_tables WHERE id = ANY($1::uuid[])) AS tables,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2) AS rule_leads,
            (SELECT count(*)::int FROM bison_leads WHERE instance_url = $3) AS bison,
            (SELECT count(*)::int FROM client_targeting WHERE client_tag LIKE $4) AS rules,
            (SELECT count(*)::int FROM commercial_cleaning_excluded_titles WHERE term = $5) AS titles,
            (SELECT count(*)::int FROM upload_batches WHERE id = ANY($6::uuid[])) AS batches`,
    [created.tables, `%@${TEST_DOMAIN}`, TEST_DOMAIN, `${RULE_PREFIX}%`, TEST_TITLE, created.batches]
  );
  console.log(`\ncleaned up: ${Object.values(leftover).every((n) => n === 0) ? "yes" : `NO ${JSON.stringify(leftover)}`}`);
  console.log(`${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
