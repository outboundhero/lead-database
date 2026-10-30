#!/usr/bin/env node
// Deep checks for the AI Ark tab. LOCAL DATABASE ONLY: it creates demo runs,
// adds a few temporary leads and never-contact rows, and removes all of it at
// the end.
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
//      no person bought twice (within and across runs), a crash mid-slice and
//      resume, cancel (queued and mid-slice), out of credits, a refused key,
//      a refunded / expired / still-processing / lost-answer export
//   C. every outcome the worker works out, against an oracle built from the
//      database's own functions (fn_regex_escape, fn_whole_term_regex,
//      fn_commercial_cleaning_condition, geo_admin1)

import pg from "pg";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AiArkError, createAiArk, personInputs } from "./lib/aiark/client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./lib/aiark/demo.mjs";
import { buildRequests, cleanPeopleFilters, CLEANING_DEFAULTS, EMPTY_PEOPLE_FILTERS, loadGeo } from "./lib/aiark/filters.mjs";
import { advanceOneRun, createRun } from "./lib/aiark/runs.mjs";
import { CLIENT_ACTIONS, resetClientChecks, wholeTermSource } from "./lib/enrich/client-checks.mjs";

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

const created = { runs: [], tables: [], emails: [] };

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
  const r = buildRequests({ targeting: t, people: CLEANING_DEFAULTS, geo });
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
  check("titles on the latest role, WORD include + WORD exclude", title?.include?.mode === "WORD" && title.include.content.length === CLEANING_DEFAULTS.titles.length && title.exclude.mode === "WORD");
  check("no pull blockers with titles", r.pullBlockers.length === 0 && r.blockers.length === 0);

  const many = { include_locations: Array.from({ length: 310 }, (_, i) => ({ city: `Town${i}`, state: "NY", country: "US" })), exclude_terms: Array.from({ length: 320 }, (_, i) => `term${i}`) };
  const r2 = buildRequests({ targeting: many, people: CLEANING_DEFAULTS, geo });
  check("310 places → 2 searches (300 + 10)", r2.requests.length === 2 && r2.requests[0].contact.location.any.include.length === 300 && r2.requests[1].contact.location.any.include.length === 10);
  check("320 exclusion terms → 300 sent, said so", r2.report.excludeTerms.sent === 300 && r2.report.excludeTerms.total === 320 && r2.notes.some((n) => n.includes("first 300 of 320")));
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
  check("processing email → PENDING", personInputs({ id: "x", email: { state: "PROCESSING", output: [] } }).email_status === "PENDING");
  check("not found email → no email cells", (() => {
    const x = personInputs({ id: "x", email: { state: "DONE", output: [{ found: false, status: "INVALID", subStatus: "MAILBOX_NOT_FOUND", domainType: "UNKNOWN" }] } });
    return !x.email && !x.email_status;
  })());
  check("staff → size text", personInputs({ id: "x", company: { summary: { staff: { total: 113, range: { start: 11, end: 50 } } } } }).company_size === "113 (11–50)");
  void withEmail;
}

// ── B. Runs against the database ────────────────────────────────────────────

const TERMINAL = new Set(["done", "stopped", "error", "cancelled"]);

async function newRun({ strategy = "single", size, people = CLEANING_DEFAULTS, mode = "demo" }) {
  const geo = await loadGeo(pool);
  const targeting = await one(`SELECT * FROM client_targeting WHERE client_tag = $1`, [TAG]);
  const built = buildRequests({ targeting, people, geo });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await createRun(client, { tag: TAG, mode, strategy, size, filters: { people, report: built.report }, requests: built.requests });
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

  for (const [label, opts, expect] of [
    ["refunded once → submitted again", { faults: { refundJobOnce: true } }, (p) => p.resubmits === 1],
    ["expired before reading → submitted again", { faults: { expireJobOnce: true } }, (p) => p.resubmits === 1],
  ]) {
    const tx = createDemoTransport({ jobMs: 100, ...opts });
    const run = await newRun({ strategy: "export", size: 120 });
    const st = await drive(run.id, demoClient(tx));
    const rr = await runRow(run.id);
    const ss = await tableStats(run.table_id, run.id);
    check(`export ${label}`, st === "done" && rr.pulled === 120 && ss.keys === 120 && expect(rr.progress), `${st} ${rr.pulled} ${JSON.stringify(rr.progress.resubmits)} ${rr.last_error ?? ""}`);
    check(`  … credits match what AI Ark kept`, Number(rr.credits_used) === tx.state.charged, `${rr.credits_used} vs ${tx.state.charged}`);
  }

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
      if (p.job?.done_at) break;
      await pool.query(`UPDATE aiark_runs SET next_run_at = now() WHERE id = $1`, [run.id]);
      await sleep(60);
    }
    await pool.query(
      `UPDATE aiark_runs SET next_run_at = now(),
              progress = jsonb_set(progress, '{job,done_at}', to_jsonb(to_char((now() - interval '11 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
        WHERE id = $1`,
      [run.id]
    );
    const st = await drive(run.id, demoClient(tx));
    const pend = await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key = 'email_status' AND value = '"PENDING"'::jsonb`, [run.table_id]);
    check("export still processing after 10 min → taken as is (PENDING rows)", st === "done" && pend.n > 0, `${st} pending ${pend.n}`);
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

  section("B8. Webhook address rules (live mode)");
  const { webhookFor } = await import("./lib/aiark/runs.mjs");
  check("no address → export unavailable", !webhookFor("live", {}).url);
  check("http refused", !webhookFor("live", { AIARK_WEBHOOK_URL: "http://x.example/api/aiark/webhook" }).url);
  check("localhost refused", !webhookFor("live", { AIARK_WEBHOOK_URL: "https://localhost:3000/api/aiark/webhook" }).url);
  check("someone else's address refused", !webhookFor("live", { AIARK_WEBHOOK_URL: "https://webhook.site/abc" }).url);
  check("this app's public https route accepted", webhookFor("live", { AIARK_WEBHOOK_URL: "https://app.example/api/aiark/webhook" }).url === "https://app.example/api/aiark/webhook");

  return { r1 };
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

  section("C3. Every outcome in a run, against the database's rules");
  // Three of run 1's people with a usable email get a history in the lead database.
  const { rows: usable } = await pool.query(
    `SELECT e.value #>> '{}' AS email
       FROM enrich_cells e JOIN enrich_cells s ON s.row_id = e.row_id AND s.column_key = 'email_status' AND s.value = '"VALID"'::jsonb
      WHERE e.table_id = $1 AND e.column_key = 'email' ORDER BY e.row_id LIMIT 3`,
    [r1.table_id]
  );
  const [inDb, never, bounced] = usable.map((r) => r.email);
  created.emails.push(inDb, never, bounced);
  await pool.query(`INSERT INTO leads (email, company) VALUES ($1, 'aiark test lead')`, [inDb]);
  await pool.query(`INSERT INTO leads (email, company, is_bounced, bounce_type) VALUES ($1, 'aiark test lead', true, 'hard')`, [bounced]);
  await pool.query(`INSERT INTO suppressed_emails (email, reason) VALUES ($1, 'aiark test')`, [never]);

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
    let expect;
    if (!usableEmail) expect = "No email";
    else {
      const o = await one(
        `WITH t AS (SELECT * FROM client_targeting WHERE client_tag = $1),
              pc AS (SELECT code FROM supported_countries WHERE lower(name) = lower($5))
         SELECT EXISTS (SELECT 1 FROM suppressed_emails WHERE email = $2) OR EXISTS (SELECT 1 FROM leads WHERE email = $2 AND is_suppressed) AS never,
                EXISTS (SELECT 1 FROM leads WHERE email = $2 AND is_bounced) AS bounced,
                EXISTS (SELECT 1 FROM leads WHERE email = $2) AS indb,
                EXISTS (SELECT 1 FROM t, jsonb_array_elements(t.include_locations) e
                         WHERE upper(e->>'country') = (SELECT code FROM pc)
                           AND (e->>'state' IS NULL OR upper(e->>'state') = (SELECT state_code FROM geo_admin1 g WHERE g.country_code = (SELECT code FROM pc) AND lower(g.name) = lower($4)))
                           AND (e->>'city' IS NULL OR regexp_replace(lower(e->>'city'), '[^a-z]', '', 'g') = regexp_replace(lower($3), '[^a-z]', '', 'g'))) AS inside,
                EXISTS (SELECT 1 FROM t, unnest(t.exclude_terms) term
                         WHERE $6 ~* fn_regex_escape(term) OR $7 ~* fn_regex_escape(term) OR $8 ~* fn_regex_escape(term)) AS excluded,
                (SELECT commercial_cleaning FROM t) AS cleaning`,
        [TAG, v.email, v.city ?? "", v.state ?? "", v.country ?? "", v.company ?? "", v.company_industry ?? "", v.company_description ?? ""]
      );
      const titleOut = o.cleaning ? (await one(`SELECT NOT (${cond}) AS out FROM (SELECT $1::text AS title) l`, [v.title ?? null])).out : false;
      expect = o.never ? "On the never-contact list"
        : o.bounced ? "Bounced"
        : o.indb ? "Already in the database"
        : !o.inside ? "Outside the client's area"
        : o.excluded || titleOut ? "Excluded by the client's rules"
        : "Ready to add";
    }
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
  for (const want of ["No email", "Outside the client's area", "Ready to add"]) {
    check(`the demo produced "${want}"`, (counts[want] ?? 0) > 0);
  }
  const later = await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key IN ('find_email', 'add_to_database')`, [r1.table_id]);
  check("later-phase columns are shown but never run", later.n === 0);
  const sample = people.find((p) => p.v?.full_name && !p.v.full_name.includes("***"));
  check("rows are searchable by name, title and email", sample && sample.search_text.includes(sample.v.full_name.toLowerCase()) && sample.search_text.includes(String(sample.v.title).toLowerCase()));

  const excl = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Bistro Holdings", title: "Owner" }, table: { client_tag: TAG }, db: pool });
  check("exclusion term anywhere in the company name", excl.status === "done" && /bistro/.test(excl.display));
  const sub = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Barbershop Supply", title: "Owner" }, table: { client_tag: TAG }, db: pool });
  check('"bar" catches "Barbershop" (contains, as the database does)', sub.status === "done" && /"bar"/.test(sub.display));
  const ttl = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Northgate Realty", title: "Senior Accountant" }, table: { client_tag: TAG }, db: pool });
  check("cleaning client: a cleaning-excluded title is caught", ttl.status === "done" && /Job title/.test(ttl.display), JSON.stringify(ttl));
  const clean = await CLIENT_ACTIONS.client_exclusions.run({ inputs: { company: "Northgate Realty", title: "Office Manager" }, table: { client_tag: TAG }, db: pool });
  check("a clear company and title → empty", clean.status === "empty");
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  if (created.emails.length) {
    await pool.query(`DELETE FROM leads WHERE email = ANY($1::text[]) AND company = 'aiark test lead'`, [created.emails]);
    await pool.query(`DELETE FROM suppressed_emails WHERE email = ANY($1::text[]) AND reason = 'aiark test'`, [created.emails]);
  }
  if (created.runs.length) {
    await pool.query(`DELETE FROM aiark_people WHERE run_id = ANY($1::uuid[])`, [created.runs]);
    await pool.query(`DELETE FROM aiark_runs WHERE id = ANY($1::uuid[])`, [created.runs]);
  }
  if (created.tables.length) {
    await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [created.tables]);
    await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [created.tables]).catch(() => {});
  }
}

const busy = await one(`SELECT count(*)::int AS n FROM aiark_runs WHERE status IN ('queued', 'running')`);
if (busy.n) {
  console.error(`Refusing to run: ${busy.n} AI Ark run(s) are queued or running in this database. Let them finish or cancel them first.`);
  await pool.end();
  process.exit(1);
}
const t0 = Date.now();
try {
  const geo = await loadGeo(pool);
  await partA(geo);
  const b = await partB();
  await partC(b);
} catch (e) {
  failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const leftover = await one(
    `SELECT (SELECT count(*)::int FROM leads WHERE company = 'aiark test lead') AS leads,
            (SELECT count(*)::int FROM suppressed_emails WHERE reason = 'aiark test') AS supp,
            (SELECT count(*)::int FROM enrich_tables WHERE id = ANY($1::uuid[])) AS tables`,
    [created.tables]
  );
  console.log(`\ncleaned up: ${leftover.leads + leftover.supp + leftover.tables === 0 ? "yes" : `NO ${JSON.stringify(leftover)}`}`);
  console.log(`${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(failed ? 1 : 0);
}
