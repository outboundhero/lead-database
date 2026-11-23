#!/usr/bin/env node
// Checks for a client's location values (migration 139): places edited by
// hand are locked against the onboarding-sheet sync, the Clay tab's location
// route, the service area (a client variable the People and General tables
// run as {{Service Area}}) and the sync's write. LOCAL DATABASE ONLY: it makes
// made-up clients XQ2A to XQ2E with made-up rules (real US place names from
// the geo reference), a made-up originals variant (the fixtures), and removes
// all of it at the end.
//
//   node --env-file=.env.local scripts/test-client-location.mjs
//
// Migration 139 must be in the local database. Nothing here reaches a network:
// fetch is replaced, OpenAI's chat answers come from a stub (the sync's three
// passes), every other address is refused and counted. The routes run for real
// through the TypeScript loader (scripts/fixtures/test-support.mjs), with
// stand-ins for the session, the audit log and the Supabase clients the
// targeting route's GET uses (its GET is not run here).
//
//   P. serviceAreaFor: the client's own value, else the sheet's places text
//      (600 characters at most, a non-answer skipped), else a label of the
//      places, else nothing
//   C. the compiled templates: the Service Area column in People and General,
//      before the personalisation steps; the Companies location_filter input
//   E. the client_variable action through runRow with the database: empty for
//      a client with nothing, the sheet's text, the typed value, the 30-second
//      cache and a re-run reading again, no call and no spend
//   L. GET/PUT /api/clients/location: roles, shape, 404 and 400, a stale
//      version (409), every validation reason, the lock on changed places and
//      its log, an unchanged save, the service area saved and removed, unlock
//      with changed places refused, a client's first rules row
//   T. PUT /api/clients/targeting (the Rules dialog): roles, the lock only when
//      places or countries change, its log, the minimum kept, validation
//   S. the sheet sync's write (syncSheetClients, OpenAI stubbed): locked places
//      kept, other clients' places from the sheet, a lock taken while the run
//      worked, the dry run, Follow the sheet again, and the next sync applying
//      the sheet
//   A. the audit lines: counts only, never a place or the service area

import pg from "pg";
import { randomUUID } from "node:crypto";
import { checker, dropPaidKeys, localDatabaseUrl, ROUTE_STUBS, routeLoader, seedFixtureVariant } from "./fixtures/test-support.mjs";
import { cleanServiceArea, LABEL_CITIES, placesLabel, SERVICE_AREA, serviceAreaFor, sheetAreaText } from "./lib/enrich/service-area.mjs";
import { CLIENT_ACTIONS, resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { runRow } from "./lib/enrich/engine.mjs";
import { order } from "./lib/enrich/formula.mjs";
import { loadOriginals } from "./lib/enrich/compile-original.mjs";
import { compileTemplates, variantName } from "./lib/enrich/templates.mjs";
import { PEOPLE_COLUMNS, SERVICE_AREA_COLUMN } from "./lib/enrich/people-template.mjs";
import { INBOX_COLUMNS } from "./lib/enrich/inbox-template.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const count = checker();
const { check, section } = count;

const TAGS = ["XQ2A", "XQ2B", "XQ2C", "XQ2D", "XQ2E"];
const [A, B, C, D, E] = TAGS;
const NOT_A_CLIENT = "XQ2Z";
const VARIANT = variantName(A);
const USER = randomUUID();
const SHEET_A = { target: "Offices", exclusion: "No bars", locations: "Springfield, Illinois and 20 miles around" };
const SHEET_OLD = { target: "Offices", exclusion: "No bars", locations: "Springfield, Illinois" };
const SPRINGFIELD = { country: "US", state: "IL", city: "Springfield" };
const PLACE_WORDS = /Springfield|Chicago|Peoria|Decatur|Naperville|Xqnowhere|towns around|changed area/i;

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const norm = (v) =>
  Array.isArray(v) ? v.map(norm) : v && typeof v === "object" && !(v instanceof Date) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

const rowOf = (tag) => one(`SELECT *, updated_at::text AS v FROM client_targeting WHERE client_tag = $1`, [tag]);
const logsOf = (tag) => all(`SELECT action, before, after, by_user FROM client_targeting_log WHERE client_tag = $1 ORDER BY id`, [tag]);
const varOf = (tag, name = SERVICE_AREA) => one(`SELECT * FROM client_variables WHERE client_tag = $1 AND name = $2`, [tag, name]);
const varLogsOf = (tag) => all(`SELECT name, action, before_value, after_value, source, by_user FROM client_variables_log WHERE client_tag = $1 ORDER BY id`, [tag]);

// ── The network: OpenAI's chat answers for the sheet sync, nothing else ─────

const ai = { calls: { location: 0, categories: 0, exclusion: 0 }, locationAsked: [], refused: 0, onLocation: null };
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "api.openai.com" && u.pathname === "/v1/chat/completions") {
    const body = JSON.parse(String(init.body ?? "{}"));
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    let content;
    if (msgs[0]?.role === "system") {
      ai.calls.categories++;
      const tags = [...String(msgs[1]?.content ?? "").matchAll(/^([A-Z0-9_&-]+):$/gm)].map((m) => m[1]);
      content = JSON.stringify(Object.fromEntries(tags.map((t) => [t, { include: [], exclude: [] }])));
    } else if (String(msgs[0]?.content ?? "").includes("inclusion-location list")) {
      ai.calls.location++;
      ai.locationAsked.push(String(msgs[0].content));
      await ai.onLocation?.(String(msgs[0].content));
      content = "illinois: decatur, peoria";
    } else {
      ai.calls.exclusion++;
      content = "restaurant, restaurants, xq2 diner";
    }
    return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  ai.refused++;
  throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
};

/** What fn printed (console.log, warn and error), as one text. */
async function captured(fn) {
  const lines = [];
  const was = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, was);
  }
  return lines.join("\n");
}

// ── The routes ──────────────────────────────────────────────────────────────
// The targeting route's GET reads through the Supabase clients; only its PUT
// (requireRole and withTx) runs here, so they are stand-ins that refuse.
ROUTE_STUBS["@/lib/supabase/server"] = `export async function createClient() { throw new Error("no session client in this test"); }`;
ROUTE_STUBS["@/lib/supabase/admin"] = `export function createAdminClient() { throw new Error("no service client in this test"); }`;
const { T, route, srcModule, call } = routeLoader(USER);
let R = null;
const getLoc = (tag) => call(R.location.GET, { query: { tag } });
const putLoc = (body) => call(R.location.PUT, { body });
const putRules = (body) => call(R.targeting.PUT, { body });
const versionOf = async (tag) => (await getLoc(tag)).body.version;

// ── Setup and cleanup ───────────────────────────────────────────────────────

async function cleanup() {
  await pool.query(`DELETE FROM client_targeting_log WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_variables_log WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_variables WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM enrich_originals WHERE variant = $1`, [VARIANT]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[])`, [TAGS]);
}

async function setup() {
  await pool.query(
    `INSERT INTO client_tags (tag, name, status, client_type)
     SELECT t, 'Location test ' || right(t, 1), 'Active', CASE WHEN t = $2 THEN 'Cleaning' ELSE 'Non-Cleaning' END FROM unnest($1::text[]) t`,
    [TAGS, B]
  );
  const rules = async (tag, sheet, extra = "") =>
    pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, source, sheet_raw, sheet_synced_at, updated_at${extra ? ", min_leads_per_place" : ""})
       VALUES ($1, '{US}', $2::jsonb, '[]', '{bar}', $3, $4::jsonb, $5, now()${extra ? ", 300" : ""})`,
      [tag, JSON.stringify([SPRINGFIELD]), sheet ? "sheet" : "manual", sheet ? JSON.stringify(sheet) : null, sheet ? new Date(Date.now() - 86_400_000) : null]
    );
  await rules(A, SHEET_A);
  await rules(C, SHEET_OLD);
  await rules(D, SHEET_OLD);
  await rules(E, null, "min");
  await seedFixtureVariant(pool, A); // the made-up Clay originals, for the compiled templates (C)
}

// ── P. serviceAreaFor ───────────────────────────────────────────────────────

function partP() {
  section("P. The service area: the client's own value, else the sheet's places text, else a label of the places");
  const T1 = { sheet_raw: { target: "x", exclusion: "y", locations: "  Springfield, Illinois\r\nand 20 miles around  " }, include_locations: [SPRINGFIELD] };
  check("1. the client's own value wins, cleaned, with who wrote it",
    same(serviceAreaFor(T1, { value: " The Springfield area\r\n", source: "manual" }), { value: "The Springfield area", from: "variable", source: "manual" }));
  check("2. else the onboarding sheet's places text, trimmed (line ends as \\n)",
    same(serviceAreaFor(T1, null), { value: "Springfield, Illinois\nand 20 miles around", from: "sheet", source: null }));
  check("... an own value of only spaces counts as none", serviceAreaFor(T1, { value: "  \n ", source: "manual" }).from === "sheet");
  const long = Array.from({ length: 120 }, (_, i) => `Xqtown${i}`).join(", ");
  const cut = sheetAreaText({ locations: long });
  check("... at most 600 characters, cut after a word", cut.length <= 600 && cut.length > 540 && long.startsWith(cut) && /Xqtown\d+$/.test(cut), `${cut.length}: ${cut.slice(-30)}`);
  const pair = sheetAreaText({ locations: `${"a".repeat(599)}\u{1F600}b` });
  check("... never half of a UTF-16 pair", pair.length <= 600 && !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(pair));
  check("... a sheet cell that gives no answer is skipped",
    ["Already Provided", "N/A", " none ", "-"].every((cell) => serviceAreaFor({ ...T1, sheet_raw: { locations: cell } }, null).from === "places"));
  check("3. else a label of the places: cities as City, ST, then the states",
    same(serviceAreaFor({ sheet_raw: null, include_locations: [SPRINGFIELD, { country: "US", state: "IL", city: "Decatur" }, { country: "US", state: "MO" }] }, null),
      { value: "Springfield, IL; Decatur, IL (IL, MO)", from: "places", source: null }));
  const many = Array.from({ length: LABEL_CITIES + 3 }, (_, i) => ({ country: "US", state: "IL", city: `Xqtown ${i + 1}` }));
  const want = `${many.slice(0, LABEL_CITIES).map((e) => `${e.city}, IL`).join("; ")} and 3 more (IL)`;
  check(`... the first ${LABEL_CITIES} cities and how many more`, placesLabel(many) === want, placesLabel(many));
  check("... the states alone when no place names a city, the countries alone when none names a state",
    placesLabel([{ country: "US", state: "IL" }, { country: "US", state: "MO" }]) === "IL, MO" && placesLabel([{ country: "US" }, { country: "CA" }]) === "US, CA");
  check("4. else nothing", same(serviceAreaFor(null, null), { value: "", from: "none", source: null }) &&
    same(serviceAreaFor({ sheet_raw: { locations: "" }, include_locations: [] }, undefined), { value: "", from: "none", source: null }));
  check("text kept clean: no NUL, line ends as \\n, at most one empty line, trimmed; a number as text; anything else empty",
    cleanServiceArea("a\u0000b\r\n\r\n\r\n\r\nc  ") === "ab\n\nc" && cleanServiceArea(5) === "5" && cleanServiceArea({}) === "" && cleanServiceArea(null) === "");
  check("stored values read as text too: a jsonb null sheet_raw, places as JSON text",
    serviceAreaFor({ sheet_raw: "null", include_locations: '[{"country":"US","state":"IL"}]' }, null).value === "IL");
}

// ── C. The compiled templates ───────────────────────────────────────────────

async function partC() {
  section("C. The compiled templates: Service Area in People and General, the Companies location_filter input");
  const compiled = compileTemplates(await loadOriginals(pool, VARIANT));
  for (const kind of ["people", "inboxes"]) {
    const cols = compiled[kind];
    const sa = cols.find((c) => c.key === "service_area");
    const at = (k) => cols.findIndex((c) => c.key === k);
    check(`${kind}: the Service Area column, ours: the client_variable action, free, no switch, no key, no input`,
      sa?.name === "Service Area" && sa.kind === "action" && sa.action === "client_variable" && sa.provider === "Client variables" && sa.data_type === "text" &&
        same(sa.config, { name: "service_area" }) && same(sa.inputs, {}) && sa.run_if === null && sa.phase === 1 && !sa.config.flag &&
        sa.needs_env.length === 0 && sa.clay_field_id === null && sa.hidden === false,
      JSON.stringify(sa));
    check(`${kind}: ... before the personalisation steps`,
      at("service_area") > 0 && at("service_area") < at("email_domain") && at("service_area") < at("claygent") && at("service_area") < at("question_ai"));
    const reading = cols.map((c) => (c.key === "claygent" ? { ...c, inputs: { ...c.inputs, prompt: `${c.inputs.prompt} + Clay.formatForAIPrompt({{service_area}})` } } : c));
    const moved = [...reading.filter((c) => c.key !== "service_area"), reading.find((c) => c.key === "service_area")];
    const ordered = order(moved).map((c) => c.key);
    check(`${kind}: ... a prompt that reads {{service_area}} runs after it, wherever it sits`, ordered.indexOf("service_area") < ordered.indexOf("claygent"));
  }
  check("one spec for both templates", PEOPLE_COLUMNS.includes(SERVICE_AREA_COLUMN) && INBOX_COLUMNS.includes(SERVICE_AREA_COLUMN));
  const lf = compiled.companies.find((c) => c.key === "location_filter");
  check("companies: the location_filter input, hidden, from Google Maps, JSON",
    lf?.kind === "input" && lf.hidden === true && lf.provider === "Google Maps" && lf.data_type === "json", JSON.stringify(lf));
}

// ── E. The client_variable action ───────────────────────────────────────────

const SA_COL = { key: "service_area", name: "Service Area", kind: "action", action: "client_variable", inputs: {}, config: { name: SERVICE_AREA }, run_if: null, phase: 1, position: 2 };
const PROMPT_COL = { key: "prompt_text", name: "Prompt", kind: "formula", formula: '"Visit " + Clay.formatForAIPrompt({{service_area}}) + "."', phase: 1, position: 1 };

/** One row worked by the engine with the database: the service area, then a prompt that reads it. */
async function work(tag, since) {
  const changed = new Map();
  const ran = [];
  const res = await runRow({
    row: { id: 1, created_at: new Date(), run_force: [], next_run_at: since },
    table: { id: randomUUID(), client_tag: tag, template: "people_v1", variant: "default", keyCounts: {} },
    columns: order([PROMPT_COL, SA_COL]),
    cells: new Map(),
    env: {},
    db: pool,
    hooks: { changed: (k, c) => changed.set(k, c), ran: (r) => ran.push(r) },
  });
  return { res, cell: changed.get("service_area"), prompt: res.values.prompt_text, ran };
}

/** The database's clock: a row's next_run_at is the database's time, and the cache compares it with the time of its read. */
const dbNow = async () => (await one(`SELECT clock_timestamp() AS t`)).t;

const spendToday = async () => JSON.stringify(await all(`SELECT * FROM enrich_spend_daily WHERE day = current_date ORDER BY kind`));

async function partE() {
  section("E. The client_variable action through runRow, with the database");
  resetClientChecks();
  const spend = await spendToday();
  const b = await work(B, await dbNow());
  check("a client with no rules and no variable: empty, never an error; the prompt reads it as empty text",
    b.cell?.status === "empty" && /No service area/.test(b.cell.note ?? "") && b.res.errors === 0 && b.prompt === "Visit .", JSON.stringify(b.cell));
  const a = await work(A, await dbNow());
  check("a client with the sheet's places text only: that text, and where it comes from",
    a.cell?.status === "done" && a.cell.value === SHEET_A.locations && /onboarding sheet/.test(a.cell.note ?? "") && a.prompt === `Visit ${SHEET_A.locations}.`,
    JSON.stringify(a.cell));
  check("free: no provider call, no run record, no spend", a.res.calls === 0 && b.res.calls === 0 && a.ran.length === 0 && b.ran.length === 0 && (await spendToday()) === spend);
  const other = async (tag) => CLIENT_ACTIONS.client_variable.run({ table: { client_tag: tag }, row: { next_run_at: await dbNow() }, db: pool, config: { name: "xq2_note" } });
  const o1 = await other(A);
  await pool.query(`INSERT INTO client_variables (client_tag, name, value, source) VALUES ($1, 'xq2_note', 'Xq2 note value', 'manual')`, [A]);
  const o2 = await other(A);
  await pool.query(`DELETE FROM client_variables WHERE client_tag = $1 AND name = 'xq2_note'`, [A]);
  check("another name reads its own row: empty, then its value", o1.status === "empty" && o2.status === "done" && o2.value === "Xq2 note value", JSON.stringify([o1, o2]));
}

/** E, again: the typed value, the 30-second cache, and a re-run reading again. Runs while A has its own service area. */
async function partE2(typed) {
  section("E2. The action with the client's own value, the cache and a re-run");
  resetClientChecks();
  const r1 = await work(A, await dbNow());
  await pool.query(`UPDATE client_variables SET value = 'Xq2 changed area' WHERE client_tag = $1 AND name = $2`, [A, SERVICE_AREA]);
  const r2 = await work(A, new Date(0)); // a row queued long ago: the read of under 30 s ago serves
  const r3 = await work(A, await dbNow()); // a row queued again now (a re-run): read again
  check("the typed value, noted as typed on the Clay tab", r1.cell?.value === typed && /typed on the Clay tab/.test(r1.cell.note ?? "") && r1.prompt === `Visit ${typed}.`, JSON.stringify(r1.cell));
  check("cached for 30 seconds, never older than the row's queueing: a re-run reads the change", r2.cell?.value === typed && r3.cell?.value === "Xq2 changed area");
}

// ── L. The location route ───────────────────────────────────────────────────

async function partL() {
  section("L. GET/PUT /api/clients/location");
  T.role = "viewer";
  const g1 = await getLoc(A);
  T.role = null;
  const g2 = await getLoc(A);
  T.role = "manager";
  const g3 = await getLoc(A);
  const p1 = await putLoc({ tag: A, version: g3.body?.version, serviceArea: "Xq2 manager" });
  check("roles: a viewer 403, no session 401, a manager reads (200) and can't save (403)",
    g1.status === 403 && g2.status === 401 && g3.status === 200 && p1.status === 403 && !(await varOf(A)));
  const v = g3.body;
  check("the shape: tag, rules, places, the lock, the sheet's text and the service area, a version",
    same(Object.keys(v).sort(), ["countries", "excludeLocations", "hasRules", "includeLocations", "locked", "lockedAt", "lockedBy", "serviceArea", "sheet", "tag", "version"]) &&
      same(Object.keys(v.serviceArea).sort(), ["effective", "fallback", "from", "source", "updatedAt", "value"]) && same(Object.keys(v.sheet).sort(), ["locations", "syncedAt"]),
    JSON.stringify(v));
  check("... the client's places, not locked, the sheet's text, the service area from the sheet",
    v.tag === A && v.hasRules === true && same(v.countries, ["US"]) && same(v.includeLocations, [SPRINGFIELD]) && same(v.excludeLocations, []) &&
      v.locked === false && v.lockedAt === null && v.lockedBy === null && v.sheet.locations === SHEET_A.locations && typeof v.sheet.syncedAt === "string" &&
      v.serviceArea.value === null && v.serviceArea.source === null && v.serviceArea.effective === SHEET_A.locations && v.serviceArea.from === "sheet" &&
      same(v.serviceArea.fallback, { value: SHEET_A.locations, from: "sheet" }) && /\|/.test(v.version),
    JSON.stringify(v));
  const notTag = await getLoc("not a tag!");
  const notClient = await getLoc(NOT_A_CLIENT);
  check("a tag that is not one: 400; a tag that is no client: 404", notTag.status === 400 && notClient.status === 404);

  T.role = "admin";
  const noVersion = await putLoc({ tag: A, serviceArea: "x" });
  const notObject = await putLoc([A]);
  const unknownClient = await putLoc({ tag: NOT_A_CLIENT, version: "-|-", serviceArea: "x" });
  check("PUT: no version 400, a body that is not an object 400, no such client 404",
    noVersion.status === 400 && notObject.status === 400 && unknownClient.status === 404 && /version/.test(noVersion.body.error ?? ""));
  const stale = await putLoc({ tag: A, version: "2000-01-01 00:00:00+00|-", serviceArea: "Xq2 stale" });
  check("a version that is not the stored one: 409 with changed, nothing written", stale.status === 409 && stale.body.changed === true && !(await varOf(A)), JSON.stringify(stale.body));

  const v0 = await versionOf(A);
  const bad = await putLoc({
    tag: A, version: v0, countries: ["US", "XX"], includeLocations: [{ country: "US", state: "IL", city: "Xqnowhere" }, "Atlantis, ZZ"],
    excludeLocations: "Peoria, IL", serviceArea: 42, unlock: "yes",
  });
  const reasons = bad.body?.errors ?? [];
  check("every reason at once: 400 with each (an unknown country, city and state, a list that is none, a service area that is not text, unlock not true)",
    bad.status === 400 && reasons.length === 6 && reasons.includes('unsupported country "XX"') &&
      reasons.includes('include location: "Xqnowhere" is not a known place in IL, US') && reasons.includes('include location: unknown state "ZZ" in US') &&
      reasons.includes("excludeLocations must be a list") && reasons.includes("serviceArea must be text, or null to remove it") && reasons.includes("unlock can only be true") &&
      bad.body.error === reasons[0],
    JSON.stringify(bad.body));
  const tooLong = await putLoc({ tag: A, version: v0, serviceArea: "x".repeat(5_001) });
  check("a service area over 5,000 characters: 400", tooLong.status === 400 && /5,000 at most/.test(tooLong.body.error ?? ""), JSON.stringify(tooLong.body));
  check("... and nothing was written by either", (await versionOf(A)) === v0 && (await logsOf(A)).length === 0);

  const audits0 = T.audits.length;
  const saved = await putLoc({ tag: A, version: v0, includeLocations: [{ country: "us", state: "Illinois", city: "springfield" }, "Chicago, IL"], excludeLocations: ["Peoria, IL"] });
  const rowA = await rowOf(A);
  const chicago = { country: "US", state: "IL", city: "Chicago" };
  const peoria = { country: "US", state: "IL", city: "Peoria" };
  check("changed places: saved in the geo reference's spelling, locked by the admin, with the time",
    saved.status === 200 && saved.body.saved?.places === true && saved.body.locked === true && typeof saved.body.lockedAt === "string" &&
      rowA.locations_locked === true && rowA.locations_locked_by === USER && rowA.locations_locked_at instanceof Date &&
      same(rowA.include_locations, [SPRINGFIELD, chicago]) && same(rowA.exclude_locations, [peoria]) && same(rowA.countries, ["US"]),
    JSON.stringify({ body: saved.body, rowA }));
  const logA = await logsOf(A);
  check("... one save in the log: places and countries before and after, nothing else",
    logA.length === 1 && logA[0].action === "save" && logA[0].by_user === USER &&
      same(Object.keys(logA[0].before).sort(), ["countries", "exclude_locations", "include_locations"]) && same(Object.keys(logA[0].after).sort(), ["countries", "exclude_locations", "include_locations"]) &&
      same(logA[0].before.include_locations, [SPRINGFIELD]) && same(logA[0].after.include_locations, [SPRINGFIELD, chicago]) && same(logA[0].after.exclude_locations, [peoria]),
    JSON.stringify(logA));
  check("... the rest of the rules as they were: the terms, the sheet's text, its source",
    same(rowA.exclude_terms, ["bar"]) && rowA.source === "sheet" && same(rowA.sheet_raw, SHEET_A));
  check("... one audit line, counts only", T.audits.length === audits0 + 1 && T.audits.at(-1).action === "client_location" &&
    /2 in, 1 out, 1 countries/.test(T.audits.at(-1).details) && !PLACE_WORDS.test(T.audits.at(-1).details), JSON.stringify(T.audits.at(-1)));

  const v2 = saved.body.version;
  const again = await putLoc({ tag: A, version: v2, countries: ["us"], includeLocations: [chicago, { ...SPRINGFIELD, city: "SPRINGFIELD" }], excludeLocations: [peoria] });
  check("the same places again (another order and spelling): nothing saved, no log, no audit line, the same version",
    again.status === 200 && again.body.saved?.places === false && again.body.version === v2 && (await logsOf(A)).length === 1 && T.audits.length === audits0 + 1,
    JSON.stringify(again.body?.saved));

  const typed = "The Springfield area\nand the towns around it";
  const sa = await putLoc({ tag: A, version: v2, serviceArea: "  The Springfield area\r\nand the towns around it  " });
  const varA = await varOf(A);
  check("a service area: saved cleaned, by the admin, as typed by hand (manual)",
    sa.status === 200 && sa.body.saved?.serviceArea === "saved" && sa.body.saved.places === false && varA?.value === typed && varA.source === "manual" && varA.updated_by === USER,
    JSON.stringify({ body: sa.body?.saved, varA }));
  check("... the view: its own value, what prompts get and from where, and what they would get without it",
    sa.body.serviceArea.value === typed && sa.body.serviceArea.effective === typed && sa.body.serviceArea.from === "variable" && sa.body.serviceArea.source === "manual" &&
      same(sa.body.serviceArea.fallback, { value: SHEET_A.locations, from: "sheet" }) && typeof sa.body.serviceArea.updatedAt === "string",
    JSON.stringify(sa.body.serviceArea));
  const vl = await varLogsOf(A);
  check("... logged with before and after; the audit line has its length, never the text",
    vl.length === 1 && same(vl[0], { name: SERVICE_AREA, action: "save", before_value: null, after_value: typed, source: "manual", by_user: USER }) &&
      T.audits.at(-1).details === `${A}: service area saved (${typed.length} characters)`,
    JSON.stringify({ vl, audit: T.audits.at(-1) }));

  await partE2(typed);

  section("L, continued");
  const v3 = await versionOf(A); // E2 changed the value behind the route's back
  const rm = await putLoc({ tag: A, version: v3, serviceArea: null });
  check("null removes it: logged with the value it had; prompts get the sheet's text again",
    rm.status === 200 && rm.body.saved?.serviceArea === "removed" && !(await varOf(A)) && rm.body.serviceArea.from === "sheet" && rm.body.serviceArea.value === null &&
      same((await varLogsOf(A)).at(-1), { name: SERVICE_AREA, action: "delete", before_value: "Xq2 changed area", after_value: null, source: "manual", by_user: USER }),
    JSON.stringify(rm.body?.serviceArea));
  const rm2 = await putLoc({ tag: A, version: rm.body.version, serviceArea: "   " });
  check("... an empty one removes nothing more", rm2.status === 200 && rm2.body.saved?.serviceArea === null && (await varLogsOf(A)).length === 2);

  const both = await putLoc({ tag: A, version: rm2.body.version, unlock: true, includeLocations: ["Naperville, IL"] });
  check("unlock with changed places: 400, still locked, places as they were",
    both.status === 400 && /not both/.test(both.body.error ?? "") && (await rowOf(A)).locations_locked === true && same((await rowOf(A)).include_locations, [SPRINGFIELD, chicago]));

  const vb = (await getLoc(B)).body;
  check("a client with no rules: the default places, not locked, no service area",
    vb.hasRules === false && same(vb.countries, ["US"]) && vb.includeLocations.length === 0 && vb.locked === false && vb.serviceArea.from === "none" && vb.serviceArea.effective === "" && vb.sheet.locations === null,
    JSON.stringify(vb));
  const onlyArea = await putLoc({ tag: B, version: vb.version, serviceArea: null });
  check("... saving no change makes no rules row", onlyArea.status === 200 && !(await rowOf(B)));
  const mk = await putLoc({ tag: B, version: vb.version, includeLocations: ["Decatur, IL"] });
  const rowB = await rowOf(B);
  const decatur = { country: "US", state: "IL", city: "Decatur" };
  check("... its first places make its rules row: locked, the commercial-cleaning exclusions on (a cleaning client), logged with no before",
    mk.status === 200 && rowB?.locations_locked === true && rowB.commercial_cleaning === true && same(rowB.include_locations, [decatur]) && same(rowB.countries, ["US"]) &&
      (await logsOf(B))[0]?.before === null && mk.body.hasRules === true,
    JSON.stringify({ body: mk.body, rowB }));
  check("... and its service area is now a label of its places", mk.body.serviceArea.from === "places" && mk.body.serviceArea.effective === "Decatur, IL (IL)");
  resetClientChecks();
  const bp = await work(B, await dbNow());
  check("... which the action gives too", bp.cell?.value === "Decatur, IL (IL)" && /Made from the client's places/.test(bp.cell.note ?? ""), JSON.stringify(bp.cell));
}

// ── T. The Rules dialog's save ──────────────────────────────────────────────

async function partT() {
  section("T. PUT /api/clients/targeting: changed places lock, logged; the rest as before");
  const base = {
    client_tag: E, countries: ["US"], include_locations: [SPRINGFIELD], exclude_locations: [], include_terms: [], exclude_terms: ["Bar", " pub "],
    require_location: true, allow_inferred_location: true, commercial_cleaning: false,
  };
  T.role = "manager";
  const m = await putRules(base);
  T.role = "admin";
  const unknown = await putRules({ ...base, client_tag: NOT_A_CLIENT });
  check("a manager gets 403; an unknown client 400", m.status === 403 && unknown.status === 400 && /Unknown client tag/.test(unknown.body.error ?? ""));

  const auditsBefore = T.audits.length;
  const t1 = await putRules(base);
  const e1 = await rowOf(E);
  check("the same places with new terms: saved, not locked, no log; terms cleaned; the minimum kept when not sent",
    t1.status === 200 && t1.body.ok === true && t1.body.locked === false && e1.locations_locked === false && (await logsOf(E)).length === 0 &&
      same(e1.exclude_terms, ["bar", "pub"]) && e1.min_leads_per_place === 300 && e1.require_location === true,
    JSON.stringify({ body: t1.body, e1 }));
  const decatur = { country: "US", state: "IL", city: "Decatur" };
  const t2 = await putRules({ ...base, include_locations: [{ country: "US", state: "Illinois", city: "decatur" }], min_leads_per_place: 250 });
  const e2 = await rowOf(E);
  const logE = await logsOf(E);
  check("changed places: saved in canonical form and locked by the admin; logged with before and after",
    t2.status === 200 && t2.body.locked === true && e2.locations_locked === true && e2.locations_locked_by === USER && e2.locations_locked_at instanceof Date &&
      same(e2.include_locations, [decatur]) && e2.min_leads_per_place === 250 && logE.length === 1 && logE[0].action === "save" &&
      same(logE[0].before.include_locations, [SPRINGFIELD]) && same(logE[0].after.include_locations, [decatur]),
    JSON.stringify({ body: t2.body, e2, logE }));
  const t3 = await putRules({ ...base, include_locations: [decatur], countries: ["US", "CA"], min_leads_per_place: null });
  const e3 = await rowOf(E);
  check("countries changed alone lock and log too; an empty minimum clears it",
    t3.status === 200 && t3.body.locked === true && (await logsOf(E)).length === 2 && same(e3.countries, ["US", "CA"]) && e3.min_leads_per_place === null,
    JSON.stringify(t3.body));
  const t4 = await putRules({ ...base, include_locations: [{ country: "US", state: "IL", city: "Xqnowhere" }] });
  const t5 = await putRules({ ...base, countries: ["US", "XX"], include_locations: [decatur] });
  check("an unknown place or an unsupported country: 400 with the reason, nothing saved",
    t4.status === 400 && t4.body.error === 'include location: "Xqnowhere" is not a known place in IL, US' && t5.status === 400 && t5.body.error === 'unsupported country "XX"' &&
      same((await rowOf(E)).countries, ["US", "CA"]) && (await logsOf(E)).length === 2,
    JSON.stringify([t4.body, t5.body]));
  const lines = T.audits.slice(auditsBefore);
  check("one audit line a save, counts only (never a place or a term)",
    lines.length === 3 && lines.every((a) => a.action === "client_targeting" && /places in/.test(a.details) && !PLACE_WORDS.test(a.details) && !/\bbar\b|\bpub\b/.test(a.details)) &&
      /places kept from the sheet sync/.test(lines[1].details) && !/kept/.test(lines[0].details),
    JSON.stringify(lines));
}

// ── S. The sheet sync ───────────────────────────────────────────────────────

const sheetRow = (tag, run) => ({ tag, target: "Offices and clinics", exclusion: "No restaurants", locations: `Decatur and Peoria, Illinois (${tag}, ${run})` });
const rawOf = (r) => ({ target: r.target, exclusion: r.exclusion, locations: r.locations });

async function partS() {
  section("S. The sheet sync's write (OpenAI stubbed): places edited by hand are kept");
  const { syncSheetClients } = await import("./sync-client-targeting-from-sheet.mjs");
  dropPaidKeys(); // the script reads .env.local when imported
  const sheet = new Map([A, C, D].map((t) => [t, sheetRow(t, "s1")]));
  const before = { [A]: await rowOf(A), [C]: await rowOf(C), [D]: await rowOf(D) };
  const decatur = { country: "US", state: "IL", city: "Decatur" };
  const peoria = { country: "US", state: "IL", city: "Peoria" };

  // A lock taken while the run works: D is locked the moment its places are asked for.
  ai.onLocation = async (text) => {
    if (text.includes(`(${D}, `)) await pool.query(`UPDATE client_targeting SET locations_locked = true, locations_locked_at = now() WHERE client_tag = $1`, [D]);
  };
  const out1 = await captured(() => syncSheetClients(pool, sheet));
  ai.onLocation = null;
  const [a1, c1, d1] = [await rowOf(A), await rowOf(C), await rowOf(D)];
  check("the places pass asked about the two clients not locked, never the locked one",
    ai.calls.location === 2 && !ai.locationAsked.some((t) => t.includes(`(${A}, `)) && ai.locationAsked.some((t) => t.includes(`(${C}, `)),
    JSON.stringify(ai.calls));
  check("a locked client keeps its places and countries exactly as edited by hand",
    a1.locations_locked === true && same(a1.include_locations, before[A].include_locations) && same(a1.exclude_locations, before[A].exclude_locations) && same(a1.countries, before[A].countries),
    JSON.stringify(a1.include_locations));
  check("... its terms, the sheet's text and the sync time are written as for any client",
    same(a1.exclude_terms, ["restaurant", "restaurants", "xq2 diner"]) && same(a1.sheet_raw, rawOf(sheet.get(A))) && a1.source === "sheet" &&
      a1.sheet_synced_at.getTime() > before[A].sheet_synced_at.getTime(),
    JSON.stringify({ terms: a1.exclude_terms, raw: a1.sheet_raw }));
  check("... and its line says so", out1.includes(`${A}: places kept (edited by hand), 0 excl-cats, 3 excl-keywords`), out1);
  check("a client not locked gets the sheet's places", same(c1.include_locations, [decatur, peoria]) && same(c1.countries, ["US"]) && c1.locations_locked === false && out1.includes(`${C}: 2 locations`), out1);
  check("a client locked while the run worked keeps its places all the same (checked again as the row is written)",
    d1.locations_locked === true && same(d1.include_locations, before[D].include_locations) && out1.includes(`${D}: places kept (edited by hand)`) &&
      same(d1.exclude_terms, ["restaurant", "restaurants", "xq2 diner"]),
    out1);
  check("the summary names each client whose places were kept", out1.includes(`2 client(s): places kept (edited by hand): ${A}, ${D}`), out1);

  const calls = JSON.stringify(ai.calls);
  const vA = (await rowOf(A)).v;
  const dry = await captured(() => syncSheetClients(pool, sheet, { dry: true, force: true }));
  check("a dry run marks the locked clients, asks no AI and writes nothing",
    dry.includes("[places kept (edited by hand)]") && dry.includes(`2 changed client(s): places kept (edited by hand): ${A}, ${D}`) &&
      JSON.stringify(ai.calls) === calls && (await rowOf(A)).v === vA,
    dry);

  section("S2. Follow the sheet again, then the next sync");
  const un = await putLoc({ tag: A, version: await versionOf(A), unlock: true });
  const a2 = await rowOf(A);
  check("unlock: not locked any more, the sheet's places text forgotten (the rest of its text kept), the places as they were until the next sync",
    un.status === 200 && un.body.saved?.unlocked === true && un.body.locked === false && a2.locations_locked === false && a2.locations_locked_by === null &&
      a2.locations_locked_at === null && same(a2.sheet_raw, { target: sheet.get(A).target, exclusion: sheet.get(A).exclusion }) &&
      same(a2.include_locations, a1.include_locations) && un.body.sheet.locations === null,
    JSON.stringify({ body: un.body?.saved, raw: a2.sheet_raw }));
  const logA = (await logsOf(A)).at(-1);
  check("... logged as unlock, with the places as they stood", logA?.action === "unlock" && same(logA.before, logA.after) && same(logA.before.include_locations, a1.include_locations));
  const un2 = await putLoc({ tag: A, version: un.body.version, unlock: true });
  check("... unlocking again does nothing", un2.status === 200 && un2.body.saved?.unlocked === false && (await logsOf(A)).length === 2);
  const asked = ai.calls.location;
  const out2 = await captured(() => syncSheetClients(pool, sheet));
  const a3 = await rowOf(A);
  check("the next sync reads the unlocked client's places from the sheet, though its sheet row did not change",
    ai.calls.location === asked + 1 && ai.locationAsked.at(-1).includes(`(${A}, `) && same(a3.include_locations, [decatur, peoria]) && a3.locations_locked === false &&
      same(a3.sheet_raw, rawOf(sheet.get(A))) && out2.includes(`${A}: 2 locations`),
    out2);
  check("... and only that client was parsed again", !out2.includes(`${C}:`) && !out2.includes(`${D}:`) && /1 changed, 2 unchanged/.test(out2), out2);
  check("nothing tried to reach any other address", ai.refused === 0);
}

// ── A. The audit lines ──────────────────────────────────────────────────────

function partA() {
  section("A. The audit lines of the run");
  check(`every line (${T.audits.length}) has counts and lengths only: never a place or a service area`,
    T.audits.length >= 8 && T.audits.every((a) => typeof a.details === "string" && !PLACE_WORDS.test(a.details) && a.performedBy === USER),
    JSON.stringify(T.audits));
  check("... the unlock is in it", T.audits.some((a) => a.details === `${A}: places follow the onboarding sheet again`));
}

// ── Run ─────────────────────────────────────────────────────────────────────

const t0 = Date.now();
let enrichDb = null;
try {
  const ready = await one(`SELECT to_regclass('public.client_variables') IS NOT NULL AND to_regclass('public.client_targeting_log') IS NOT NULL AS ok`);
  if (!ready.ok) throw new Error("migration 139 is not in this database");
  const taken = await all(`SELECT tag FROM client_tags WHERE tag LIKE 'XQ2%' AND NOT (tag = ANY($1::text[]))`, [TAGS]);
  if (taken.length) throw new Error(`client tags starting XQ2 exist that this test did not make: ${taken.length}`);
  await cleanup(); // anything an interrupted run left behind
  await setup();
  enrichDb = await srcModule("lib/enrich/db.ts");
  R = { location: await route("clients/location"), targeting: await route("clients/targeting") };
  partP();
  await partC();
  await partE();
  await partL();
  await partT();
  await partS();
  partA();
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[])) AS clients,
            (SELECT count(*)::int FROM client_targeting WHERE client_tag = ANY($1::text[])) AS rules,
            (SELECT count(*)::int FROM client_targeting_log WHERE client_tag = ANY($1::text[])) AS rule_logs,
            (SELECT count(*)::int FROM client_variables WHERE client_tag = ANY($1::text[])) AS variables,
            (SELECT count(*)::int FROM client_variables_log WHERE client_tag = ANY($1::text[])) AS variable_logs,
            (SELECT count(*)::int FROM enrich_originals WHERE variant = $2) AS originals`,
    [TAGS, VARIANT]
  );
  const clean = Object.values(left).every((n) => n === 0);
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify(left)}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await enrichDb?.enrichPool().end().catch(() => {});
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
