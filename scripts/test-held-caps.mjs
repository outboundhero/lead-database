#!/usr/bin/env node
// Held Google Maps rows and the daily caps of the email finders and Enrichley
// (migration 129): the worker's side of the per-client inbound URLs.
// LOCAL DATABASE ONLY: two made-up clients (IBTEST_HA, IBTEST_HB) with their
// rules and the made-up Clay originals as their own variant, their pipeline
// tables and rows, and made-up places under .ibtest.example. For the run it
// also writes the company_pipeline switch and today's spend; both are put
// back at the end, and everything else it made is removed. No other test's
// tags are touched.
//
//   node --env-file=.env.local scripts/test-held-caps.mjs
//
// Stop the enrichment worker first, and don't start it for this: the worker's
// own statements run here instead (its claim inside a transaction that is
// rolled back, the release and the sweeps as exported). Migration 129 must be
// in the local database.
//
// Nothing here reaches a network: fetch answers OpenAI, Reoon, the email
// finders, Enrichley and the made-up websites from stubs, and refuses and
// counts any other address. No paid key is read from the environment; the
// keys here are made up.
//
//   H. held rows: stored held, never claimed, the guard, the switch check
//      against flagOn(), the release, a client switched off meanwhile, and
//      switched off again
//   M. Maps rows in the Companies (pipeline) template: the seven inputs, the
//      office check by the place's own city and state, the Companies tab's
//      source, a place worked after its release
//   V. the daily caps of Findymail, Prospeo, Anymail Finder and Enrichley: no
//      cap set, a cap of 2, steps that send nothing, the ledger, and the
//      hourly sweep the next day
//   W. the worker offers held_release and runs it beside the stale sweep

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checker, dropPaidKeys, inTx, installNet, localDatabaseUrl, routeLoader, seedFixtureVariant, WORKER_SQL, workRow } from "./fixtures/test-support.mjs";
import { HELD_REFUSED, releaseHeldRows } from "./lib/enrich/held.mjs";
import { ensurePipelineTables, variantName } from "./lib/enrich/templates.mjs";
import { COMPANY_MAPS_INPUT_KEYS } from "./lib/enrich/company-template-v2.mjs";
import { MAPS_SOURCE, placeInputs, placeRowKey } from "./lib/enrich/maps-place.mjs";
import { COMPANY_ACTIONS, requeueRowsForHeldKeys, requeueWaitingTemplateRows, resetCompanyActions } from "./lib/enrich/company-actions.mjs";
import { resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { companySummaryV2 } from "./lib/enrich/project-company.mjs";
import { absentKeyNote, KEYED_STEPS, OPTIONAL_KEYS, PIPELINE_ACTIONS } from "./lib/enrich/pipeline-actions.mjs";
import { CAP_NOT_SET, CAP_REACHED, spendAllowed, spentToday, takeVendorCall, VENDOR_SPEND_KINDS, vendorKind } from "./lib/enrich/spend.mjs";
import { settingsFrom, VENDOR_CAP_KEYS, VENDOR_CAP_LABELS } from "./lib/enrich/settings.mjs";
import { runRow } from "./lib/enrich/engine.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

const HA = "IBTEST_HA"; // switched on during the run
const HB = "IBTEST_HB"; // stays off, except for the paused-table check
const TAGS = [HA, HB];
const VARIANTS = TAGS.map(variantName);
const RUN = randomUUID().slice(0, 6);
const HOST = "ibtest.example";
const dom = (slug) => `${slug}-${RUN}.${HOST}`;
const at = (slug, local) => `${local}@${dom(slug)}`;
const KEYS = { OPENAI_API_KEY: "made-up-openai", ENRICH_REOON_API_KEY: "made-up-reoon" };
const VENDOR_KEYS = { FINDYMAIL_API_KEY: "made-up-fm", PROSPEO_API_KEY: "made-up-pr", ANYMAIL_FINDER_API_KEY: "made-up-am", ENRICHLEY_API_KEY: "made-up-en" };
/** net.calls' name for each vendor cap. */
const NET_NAME = { findymail: "findymail", prospeo: "prospeo", anymail_finder: "anymail", enrichley: "enrichley" };
const TODAY = `(now() AT TIME ZONE 'utc')::date`;
const tables = {};

// ── Settings: the stored rows with some keys replaced (what runRow gets) ────

let BASE_ROWS = [];
const settingsWith = (over = {}) =>
  settingsFrom(BASE_ROWS.filter((r) => !(r.key in over)).concat(Object.entries(over).map(([key, value]) => ({ key, value }))));
/** Spend caps with room for OpenAI and Reoon; vendor caps as given (left out: not set, 0). */
const caps = (vendor = null) => ({
  reoon_checks_per_day: 100_000,
  openai_usd_per_day: { pipeline: 10_000, fit: 10_000 },
  ...(vendor ? { vendor_calls_per_day: vendor } : {}),
});
const each = (n) => Object.fromEntries(VENDOR_CAP_KEYS.map((k) => [k, n]));

/** The company_pipeline row as it was before the run ({ exists, value, updated_by }), put back at the end. */
let switchBefore = null;
const switchBase = () => (switchBefore?.value && typeof switchBefore.value === "object" ? switchBefore.value : {});
async function setSwitch(over) {
  await pool.query(
    `INSERT INTO enrich_settings (key, value) VALUES ('company_pipeline', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ ...switchBase(), ...over })]
  );
}

/** Today's counts of the four vendor kinds. */
async function ledger() {
  const rows = await all(`SELECT kind, used FROM enrich_spend_daily WHERE day = ${TODAY} AND kind = ANY($1::text[])`, [[...VENDOR_SPEND_KINDS]]);
  return Object.fromEntries(VENDOR_SPEND_KINDS.map((k) => [k, Number(rows.find((r) => r.kind === k)?.used ?? 0)]));
}

// ── Clients, places, deliveries ─────────────────────────────────────────────

async function addClient(t) {
  await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, NULL)`, [t, `Held caps test ${t.slice(-2)}`]);
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
     VALUES ($1, '{US}', $2, '[]', '{}', false, now())`,
    [t, JSON.stringify([{ city: "Springfield", state: "IL", country: "US" }])]
  );
  await seedFixtureVariant(pool, t);
  tables[t] = await inTx(pool, (c) => ensurePipelineTables(c, t));
}

let seq = 0;
/** A made-up Google Maps item, shaped as the Maps provider's advanced postback writes one (maps-place.mjs reads it). */
function place(slug, title, { city = "Springfield", region = "Illinois", street = "100 Main Street", zip = "62701", address = true, placeId } = {}) {
  return {
    type: "maps_search",
    title: `${title} ${RUN}`,
    place_id: placeId === undefined ? `ibtest-${RUN}-${++seq}` : placeId,
    url: `https://www.${dom(slug)}/`,
    domain: `www.${dom(slug)}`,
    phone: "+1 217-555-0100",
    category: "Dentist",
    ...(address ? { address_info: { address: street, city, zip, region, country_code: "US" } } : {}),
  };
}
/** What a chunk says the scrape searched. */
const EXTRA = { city: "Springfield", state: "IL", category: "dentist" };

/** insert-rows.ts, compiled by the test loader (the intake's own insert). */
let insertRows = null;

/** A chunk's places into a client's Companies (pipeline) table, as the intake writes them: held by default. */
async function deliver(t, items, { runStatus = "held" } = {}) {
  const tableId = tables[t].companies;
  const inputKeys = (await all(`SELECT key FROM enrich_columns WHERE table_id = $1 AND kind = 'input'`, [tableId])).map((r) => r.key);
  return inTx(pool, (c) =>
    insertRows(c, {
      tableId,
      inputKeys,
      rows: items.map((it) => ({ inputs: placeInputs(it, EXTRA, t) })),
      runStatus,
      rowKey: (i) => placeRowKey(i.place_id, i.cid),
      source: { kind: "maps", externalId: `ibtest-${RUN}-chunk-${++seq}`, label: "Held caps test", meta: {} },
    })
  );
}

const rowsOf = async (t) =>
  (await all(
    `SELECT id, row_key, run_status, attempts, next_run_at <= now() AS due, last_error FROM enrich_rows WHERE table_id = $1 ORDER BY id`,
    [tables[t].companies]
  )).map((r) => ({ ...r, id: Number(r.id) }));
const rowOf = async (t, item) => (await rowsOf(t)).find((r) => r.row_key === `maps:${item.place_id}`);
const statusOf = async (id) => (await one(`SELECT run_status FROM enrich_rows WHERE id = $1`, [id]))?.run_status ?? null;
const cellsOf = async (id) => Object.fromEntries((await all(`SELECT column_key, value FROM enrich_cells WHERE row_id = $1`, [id])).map((c) => [c.column_key, c.value]));

/** The worker's claim, inside a transaction that is rolled back: the row ids it would take now. */
async function claimNow() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return (await c.query(WORKER_SQL.claim, [randomUUID(), 100_000, ["companies_v1"]])).rows.map((r) => Number(r.id));
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

/** A statement's refusal ({ code, message }), or null when it went through. */
async function refusal(sql, params) {
  try {
    await pool.query(sql, params);
    return null;
  } catch (e) {
    return { code: e.code, message: e.message };
  }
}

// ── H. Held rows ────────────────────────────────────────────────────────────

async function partH() {
  section("H1. A chunk's places arrive held");
  const north = place("north", "Northgate Dental");
  const lake = place("lake", "Lakeside Dental", { city: "Bismarck", region: "North Dakota", street: "300 Lake Road", zip: "58501" });
  const corner = place("corner", "Corner Dental", { address: false });
  const noId = place("noid", "No Id Dental", { placeId: "" });
  const ra = await deliver(HA, [north, lake, corner, noId]);
  const rb = await deliver(HB, [place("bee1", "Beeline Dental"), place("bee2", "Beeline Dental Two")]);
  const ha = await rowsOf(HA);
  check("stored as held rows, keyed maps:<place id>; a place with no place id is skipped and counted",
    ra.created === 3 && ra.skipped === 1 && rb.created === 2 && ha.length === 3 && ha.every((r) => r.run_status === "held") &&
      JSON.stringify(ha.map((r) => r.row_key).sort()) === JSON.stringify([north, lake, corner].map((p) => `maps:${p.place_id}`).sort()),
    JSON.stringify({ ra, rb, ha }));
  const cells = await cellsOf((await rowOf(HA, north)).id);
  check("... with the place's inputs: its id, the source Google Maps, the client's tag, the place as its one office, and what was searched",
    cells.place_id === north.place_id && cells.source === MAPS_SOURCE && cells.client_tag === HA && cells.company === north.title &&
      JSON.parse(cells.offices ?? "[]")[0]?.city === "Springfield" && cells.office_count === "1" && cells.actual_state === "Illinois" &&
      cells.call_city === "Springfield" && cells.domain === dom("north"),
    JSON.stringify(cells));
  const src = await one(`SELECT kind, received, created, skipped FROM enrich_sources WHERE table_id = $1 ORDER BY created_at DESC LIMIT 1`, [tables[HA].companies]);
  check("... and one Maps delivery recorded with its counts", src?.kind === "maps" && src.received === 4 && src.created === 3 && src.skipped === 1, JSON.stringify(src));

  section("H2. The worker's claim never takes a held row");
  await deliver(HB, [place("ctrl", "Control Dental")], { runStatus: "queued" });
  const hb = await rowsOf(HB);
  const controlId = hb.find((r) => r.run_status === "queued")?.id;
  const heldIds = [...(await rowsOf(HA)), ...hb].filter((r) => r.run_status === "held").map((r) => r.id);
  const claimed = await claimNow();
  check("its claim statement (rolled back) takes a queued row and none of the 5 held rows",
    Boolean(controlId) && claimed.includes(controlId) && heldIds.length === 5 && heldIds.every((id) => !claimed.includes(id)),
    JSON.stringify({ controlId, heldIds, claimed: claimed.length }));

  section("H3. The guard: nothing else starts a held row while its client is off");
  const heldA = (await rowOf(HA, north)).id;
  const direct = await refusal(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [heldA]);
  check("a direct UPDATE to queued is refused with 23514, saying why", direct?.code === HELD_REFUSED && /stays held/.test(direct.message) && /company_pipeline/.test(direct.message), JSON.stringify(direct));
  const byId = await refusal(`UPDATE enrich_rows SET run_status = 'running', claim_token = gen_random_uuid(), claimed_at = now() WHERE id = $1`, [heldA]);
  check("... and so is a claim by its id", byId?.code === HELD_REFUSED, JSON.stringify(byId));
  const bulk = await refusal(`UPDATE enrich_rows SET run_status = 'queued', attempts = 7 WHERE table_id = $1 AND run_status <> 'running'`, [tables[HB].companies]);
  const ctrl = await one(`SELECT run_status, attempts FROM enrich_rows WHERE id = $1`, [controlId]);
  check("a bulk requeue that doesn't leave held rows out fails as a whole: the queued row in it is unchanged too",
    bulk?.code === HELD_REFUSED && ctrl?.run_status === "queued" && ctrl.attempts === 0, JSON.stringify({ bulk, ctrl }));
  const other = await refusal(`UPDATE enrich_rows SET search_text = search_text || ' ibtest', attempts = 1 WHERE id = $1`, [heldA]);
  const afterOther = await one(`SELECT run_status, attempts FROM enrich_rows WHERE id = $1`, [heldA]);
  check("changing another column of a held row is allowed, and it stays held", other === null && afterOther.run_status === "held" && afterOther.attempts === 1, JSON.stringify({ other, afterOther }));
  const gone = place("gone", "Gone Dental");
  await deliver(HA, [gone]);
  const goneId = (await rowOf(HA, gone))?.id;
  const del = await refusal(`DELETE FROM enrich_rows WHERE id = $1`, [goneId]);
  check("deleting a held row is allowed", Boolean(goneId) && del === null && !(await rowOf(HA, gone)), JSON.stringify(del));
  const others = await one(
    `SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id
      WHERE t.template IS NOT NULL AND r.run_status IN ('waiting', 'done') AND NOT (t.client_tag = ANY($1::text[]))`,
    [TAGS]
  );
  if (others.n) {
    check("no other client's template rows waiting or done (the hourly sweeps would queue them too)", false, `${others.n} rows`);
  } else {
    resetCompanyActions();
    const waiting = await requeueWaitingTemplateRows(pool, KEYS, { settings: settingsWith({ spend_caps: caps() }) });
    const keyed = await requeueRowsForHeldKeys(pool, VENDOR_KEYS, { keys: OPTIONAL_KEYS, noteOf: absentKeyNote });
    const still = [...(await rowsOf(HA)), ...(await rowsOf(HB))].filter((r) => r.run_status === "held").length;
    check("the hourly sweeps run beside held rows and leave them held", waiting.queued === 0 && keyed.queued === 0 && still === 5, JSON.stringify({ waiting, keyed, still }));
  }

  section("H4. The switch check reads the settings exactly as flagOn(\"company_pipeline\") does");
  const CASES = [
    ["enabled false", { enabled: false, tags: [HA] }, HA, false],
    ["the tag missing", { enabled: true, tags: [HB] }, HA, false],
    ["a lower-case tag in the list (settingsFrom upper-cases it)", { enabled: true, tags: [HA.toLowerCase()] }, HA, true],
    ["tags not a list", { enabled: true, tags: HA }, HA, false],
    ["enabled as the text \"true\"", { enabled: "true", tags: [HA] }, HA, false],
    ["listed", { enabled: true, tags: [HA] }, HA, true],
    ["asked in lower case, with spaces", { enabled: true, tags: [HA] }, `  ${HA.toLowerCase()} `, true],
    ["padded, among items that are not text", { enabled: true, tags: [7, null, ` ${HA}\t`] }, HA, true],
    ["only \"*\" listed", { enabled: true, tags: ["*"] }, HA, false],
    ["asked for \"*\"", { enabled: true, tags: ["*", HA] }, "*", false],
    ["asked for nothing", { enabled: true, tags: [HA] }, "", false],
    ["enabled missing", { tags: [HA] }, HA, false],
    ["enabled as 1", { enabled: 1, tags: [HA] }, HA, false],
    ["an empty list", { enabled: true, tags: [] }, HA, false],
    ["no value (null)", null, HA, false],
    ["a list, not an object", [HA], HA, false],
  ];
  const results = [];
  for (const [name, value, tag, expected] of CASES) {
    const js = settingsFrom([{ key: "company_pipeline", value }]).flagOn("company_pipeline", tag);
    const sql = (await one(`SELECT public.fn_enrich_switch_value_on($1::jsonb, $2) AS on`, [JSON.stringify(value), tag])).on;
    results.push({ name, js, sql, expected });
  }
  const differ = results.filter((r) => r.js !== r.sql || r.js !== r.expected);
  check(`fn_enrich_switch_value_on and flagOn agree on all ${CASES.length} settings cases, each as expected`, differ.length === 0, JSON.stringify(differ));
  const plan5 = results.slice(0, 5);
  check("... the plan's five: enabled false, the tag missing, tags not a list and enabled as \"true\" are off; a lower-case tag in the list is on in both",
    plan5.map((r) => r.sql).join() === "false,false,true,false,false" && plan5.every((r) => r.sql === r.js), JSON.stringify(plan5));
  await setSwitch({ enabled: true, tags: [HA] });
  const stored = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
  const live = await one(`SELECT public.fn_enrich_company_switch_on($1) AS a, public.fn_enrich_company_switch_on($2) AS b`, [HA, HB]);
  check("fn_enrich_company_switch_on reads the stored switch: on for the listed client, off for the other, as flagOn reads the same row",
    live.a === true && live.b === false && stored.flagOn("company_pipeline", HA) === true && stored.flagOn("company_pipeline", HB) === false, JSON.stringify(live));

  section("H5. The release: only clients on the switch, oldest first, in pages");
  await setSwitch({ enabled: false, tags: [] });
  const none = await releaseHeldRows(pool);
  check("every client off: nothing is released", none.released === 0 && (await rowsOf(HA)).every((r) => r.run_status === "held"), JSON.stringify(none));
  await setSwitch({ enabled: true, tags: [HA] });
  const first = await releaseHeldRows(pool, { pageSize: 2, maxPages: 1 });
  const afterFirst = await rowsOf(HA);
  check("the client switched on: one page of 2, the oldest first",
    first.released === 2 && first.tables === 1 && first.refused === 0 && afterFirst.map((r) => r.run_status).join() === "queued,queued,held",
    JSON.stringify({ first, afterFirst }));
  const rest = await releaseHeldRows(pool);
  const afterAll = await rowsOf(HA);
  check("... then the rest: every row queued, due now, with its attempts and error cleared; the guard let them through",
    rest.released === 1 && afterAll.length === 3 && afterAll.every((r) => r.run_status === "queued" && r.due && r.attempts === 0 && r.last_error === null),
    JSON.stringify({ rest, afterAll }));
  check("the other client, still off, keeps its rows held", (await rowsOf(HB)).filter((r) => r.run_status === "held").length === 2);
  const claimedNow = await claimNow();
  check("the worker's claim now takes the released rows", afterAll.every((r) => claimedNow.includes(r.id)));
  const hbHeld = (await rowsOf(HB)).filter((r) => r.run_status === "held").map((r) => r.id);
  await pool.query(`UPDATE enrich_tables SET is_paused = true WHERE id = $1`, [tables[HB].companies]);
  await setSwitch({ enabled: true, tags: [HA, HB] });
  const paused = await releaseHeldRows(pool);
  const hbAfter = (await rowsOf(HB)).filter((r) => hbHeld.includes(r.id));
  const claimedPaused = await claimNow();
  await pool.query(`UPDATE enrich_tables SET is_paused = false WHERE id = $1`, [tables[HB].companies]);
  check("a paused table's rows are released too, and the claim still skips them while it is paused",
    hbHeld.length === 2 && paused.released === 2 && hbAfter.length === 2 && hbAfter.every((r) => r.run_status === "queued" && !claimedPaused.includes(r.id)),
    JSON.stringify({ paused, hbAfter }));

  section("H6. Switched off before the release, and switched off again");
  const late = [place("late1", "Late Dental"), place("late2", "Late Dental Two")];
  await deliver(HA, late);
  const lateIds = async () => (await rowsOf(HA)).filter((r) => late.some((p) => r.row_key === `maps:${p.place_id}`));
  check("places for a client already on still arrive held: only the worker releases", (await lateIds()).length === 2 && (await lateIds()).every((r) => r.run_status === "held"));
  let flipped = false;
  const flipping = {
    query: async (sql, params) => {
      const r = await pool.query(sql, params);
      if (!flipped && /FROM enrich_tables t/.test(sql)) {
        flipped = true;
        await setSwitch({ enabled: false, tags: [HA, HB] });
      }
      return r;
    },
  };
  const meanwhile = await releaseHeldRows(flipping);
  check("switched off between the pick of its table and the release: the guard refuses the page (23514), caught; nothing released",
    flipped && meanwhile.released === 0 && meanwhile.refused === 1 && (await lateIds()).every((r) => r.run_status === "held"),
    JSON.stringify(meanwhile));
  const again = await releaseHeldRows(pool);
  const released = afterAll.map((r) => r.id);
  check("switched off again: new places stay held, and the rows released before are not put back",
    again.released === 0 && (await lateIds()).every((r) => r.run_status === "held") && (await rowsOf(HA)).filter((r) => released.includes(r.id)).every((r) => r.run_status === "queued"),
    JSON.stringify(again));
  const direct2 = await refusal(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [(await lateIds())[0]?.id]);
  check("... and the guard refuses a direct release again", direct2?.code === HELD_REFUSED, JSON.stringify(direct2));
  return { north, lake, corner, controlRow: controlId };
}

// ── M. Maps rows in the Companies (pipeline) template ───────────────────────

async function partM(h) {
  section("M1. The template's Maps inputs");
  const cols = await all(
    `SELECT key, kind, provider, hidden, data_type FROM enrich_columns WHERE table_id = $1 AND key = ANY($2::text[]) ORDER BY position`,
    [tables[HA].companies, [...COMPANY_MAPS_INPUT_KEYS]]
  );
  check("the eight Maps inputs, each from Google Maps; Place id shown, the other seven (the cid among them) hidden; the location filter is JSON (139)",
    cols.length === 8 && cols.some((c) => c.key === "cid") && cols.every((c) => c.kind === "input" && c.provider === "Google Maps") &&
      cols.find((c) => c.key === "place_id")?.hidden === false && cols.filter((c) => c.key !== "place_id").every((c) => c.hidden === true) &&
      cols.find((c) => c.key === "location_filter")?.data_type === "json",
    JSON.stringify(cols));
  const shared = await all(`SELECT key, provider FROM enrich_columns WHERE table_id = $1 AND key = ANY($2::text[])`, [tables[HA].companies, ["company", "website", "domain", "offices", "source", "client_tag"]]);
  check("... and the inputs both sources write name AI Ark or Google Maps", shared.length === 6 && shared.every((c) => c.provider === "AI Ark or Google Maps"), JSON.stringify(shared));
  const officeCol = await one(`SELECT action, inputs FROM enrich_columns WHERE table_id = $1 AND key = 'office'`, [tables[HA].companies]);
  check("the office step reads the place id and the cid",
    officeCol?.action === "client_office" && officeCol.inputs?.place_id === "{{place_id}}" && officeCol.inputs?.cid === "{{cid}}", JSON.stringify(officeCol));

  section("M2. The office check places a place by its own city and state");
  resetClientChecks();
  const office = (inputs) => COMPANY_ACTIONS.client_office.run({ inputs, table: { client_tag: HA }, row: { next_run_at: new Date() }, db: pool });
  const officeOf = (item, extra = EXTRA) => {
    const i = placeInputs(item, extra, HA);
    return office({ offices: i.offices, place_id: i.place_id });
  };
  const inside = await officeOf(place("in", "Inside Dental"));
  check("inside: a place in Springfield, Illinois matches the client's Springfield, IL",
    inside.display === "Inside" && inside.value.inside === true && inside.value.hq === true && inside.value.office?.city === "Springfield" &&
      inside.value.office.state === "IL" && inside.value.office.country === "US" && /^The place is in the client's area: Matches the client's place /.test(inside.note),
    JSON.stringify(inside));
  const away = await officeOf(place("away", "Away Dental", { city: "Bismarck", region: "North Dakota" }), { city: "Springfield", state: "IL", category: "dentist" });
  check("outside: a place in Bismarck is outside, whatever city the scrape searched",
    away.display === "Outside" && away.value.inside === false && away.value.office?.state === "ND" && /^The place is not in the client's area: /.test(away.note),
    JSON.stringify(away));
  const nowhere = await officeOf(place("noaddr", "Nowhere Dental", { address: false }));
  check("no address: Can't tell, worded for the place", nowhere.display === "Can't tell" && nowhere.note === "Google Maps gave no address for this place, so the lead database couldn't place it", JSON.stringify(nowhere));
  const stateless = await officeOf(place("nostate", "Stateless Dental", { city: "Nowhereville Ibtest", region: "" }));
  check("no state and a city that settles none: Can't tell, naming Google Maps and the place, never AI Ark or a person",
    stateless.display === "Can't tell" && /^Can't tell whether the place is in the client's area: Google Maps gave no state /.test(stateless.note) && / couldn't place it$/.test(stateless.note) && !/AI Ark|person/.test(stateless.note),
    stateless.note);
  const byCid = placeInputs({ ...place("bycid", "Cid Dental", { address: false }), place_id: undefined, cid: "4130409598588254484" }, EXTRA, HA);
  const cidNowhere = await office({ offices: byCid.offices, place_id: byCid.place_id, cid: byCid.cid });
  check("a place kept by its cid (no place id) is a Google Maps row too: worded for the place",
    !byCid.place_id && byCid.cid === "4130409598588254484" && cidNowhere.display === "Can't tell" &&
      cidNowhere.note === "Google Maps gave no address for this place, so the lead database couldn't place it",
    JSON.stringify(cidNowhere));
  const aiark = await office({ offices: JSON.stringify([{ street: "1 Main Street", city: "Springfield", state: "Illinois", country: "United States", postal_code: "62701", hq: true }]) });
  const aiarkNone = await office({ offices: "" });
  check("an AI Ark row keeps its own wording",
    /^The head office is in the client's area: .*\. 1 office is inside, of 1\.$/.test(aiark.note) && aiarkNone.note === "AI Ark gave no office for this company, so the lead database couldn't place it",
    JSON.stringify([aiark.note, aiarkNone.note]));

  section("M3. Released places worked: the company side, and the Companies tab says Google Maps");
  const S0 = settingsWith({ spend_caps: caps() });
  const { north, lake, corner } = h;
  const northId = (await rowOf(HA, north)).id;
  net.openai.set(`C31|${north.title}`, { company_emails_found: `${at("north", "office")}, ${at("north", "contact")}` });
  net.reoon.set(at("north", "office"), "safe");
  net.reoon.set(at("north", "contact"), "catch_all");
  const w = await workRow(pool, net, northId, { env: KEYS, settings: S0 });
  check("the office is the place, inside: Springfield, IL",
    w.status === "done" && w.values.office?.inside === true && w.values.use_city === "Springfield" && w.values.use_state === "IL" && /^The place is in the client's area/.test(w.cell("office")?.note ?? ""),
    JSON.stringify({ status: w.status, office: w.values.office, note: w.cell("office")?.note }));
  check("... its domain spares the website search, and the email search asks about the place by its name",
    w.cell("companys_website")?.status === "skipped" && w.values.use_domain === dom("north") && net.asked.some((x) => x.marker === "C31" && x.who === north.title),
    JSON.stringify({ c24: w.cell("companys_website")?.status, domain: w.values.use_domain }));
  const inboxes = await all(`SELECT id FROM enrich_rows WHERE table_id = $1 AND starts_with(row_key, $2) ORDER BY id`, [tables[HA].inboxes, `w:${northId}:`]);
  check("... and C#36 writes its two addresses as rows of the General table", inboxes.length === 2, `${inboxes.length} rows`);
  const summary = await one(`SELECT source, aiark_id, company, domain, city, state FROM enrich_companies WHERE row_id = $1`, [northId]);
  check("the Companies tab's summary says Google Maps, with the place's name, domain, city and state",
    summary?.source === "Google Maps" && summary.aiark_id === null && summary.company === north.title && summary.domain === dom("north") &&
      summary.city === "Springfield" && summary.state === "IL" && companySummaryV2(w.values).source === MAPS_SOURCE,
    JSON.stringify(summary));
  const envE = { ...KEYS, ENRICHLEY_API_KEY: VENDOR_KEYS.ENRICHLEY_API_KEY };
  const worked = {};
  for (const r of inboxes) {
    const x = await workRow(pool, net, Number(r.id), { env: envE, settings: S0 });
    worked[x.values.general_email] = { ...x, id: Number(r.id) };
  }
  const safe = worked[at("north", "office")];
  const catchAll = worked[at("north", "contact")];
  const listedNow = await one(`SELECT listed, source FROM enrich_companies WHERE row_id = $1`, [northId]);
  check("Reoon safe: Approved, and the place is listed on the Companies tab as Google Maps",
    safe?.values.inbox_outcome === "Approved" && listedNow?.listed === true && listedNow.source === "Google Maps", JSON.stringify({ outcome: safe?.values.inbox_outcome, listedNow }));
  check("Reoon catch_all with Enrichley's key held and no cap set: G#41 waits with no call, and the row waits",
    catchAll?.cell("enrichly_validation")?.status === "needs_key" && catchAll.cell("enrichly_validation").note === CAP_NOT_SET.enrichley_calls &&
      catchAll.status === "waiting" && catchAll.paid.enrichley === 0,
    JSON.stringify({ cell: catchAll?.cell("enrichly_validation"), status: catchAll?.status }));
  const lw = await workRow(pool, net, (await rowOf(HA, lake)).id, { env: KEYS, settings: S0 });
  const cw = await workRow(pool, net, (await rowOf(HA, corner)).id, { env: KEYS, settings: S0 });
  check("a place outside the area, and one with no address, finish free: Outside the client's area, nothing paid",
    lw.status === "done" && cw.status === "done" && lw.values.company_outcome === "Outside the client's area" && cw.values.company_outcome === "Outside the client's area" &&
      lw.paid.openai + lw.paid.reoon + lw.paid.probe + cw.paid.openai + cw.paid.reoon + cw.paid.probe === 0,
    JSON.stringify({ lake: [lw.status, lw.values.company_outcome, lw.paid], corner: [cw.status, cw.values.company_outcome, cw.paid] }));
  return { waitingInbox: catchAll?.id ?? null, waitingEmail: at("north", "contact") };
}

// ── V. The daily caps of the email finders and Enrichley ────────────────────

const PERSON = () => ({ full_name: "Fiona Findy", company_domain: dom("finder") });
const LINKEDIN = () => `https://linkedin.${HOST}/in/fiona-${RUN}`;
const STEP_INPUTS = () => ({
  findymail_find_work_email: PERSON(),
  findymail_find_work_email_from_linkedin: { profile_url: LINKEDIN() },
  prospeo_find_work_email: PERSON(),
  prospeo_linkedin_email_search: { personal_linkedin_url: LINKEDIN() },
  anymail_finder: { method: "POST", url: "https://api.anymailfinder.com/v5.1/ibtest/person", body: JSON.stringify({ full_name: "Fiona Findy", domain: dom("finder") }) },
  enrichley_verify_email: { email: at("finder", "fiona") },
});
let colSeq = 0;
/** One keyed step run as the engine runs it (pipeline-actions.mjs), with a column of its own. */
const step = (action, settings, { env = VENDOR_KEYS, inputs = STEP_INPUTS()[action], row = { id: 0 }, column = null } = {}) =>
  PIPELINE_ACTIONS[action].run({ inputs, config: {}, row, table: { client_tag: HA }, column: column ?? { key: `zz_${action}_${++colSeq}` }, db: pool, env, settings });
const vendorCalls = () => Object.fromEntries(VENDOR_CAP_KEYS.map((k) => [k, net.calls[NET_NAME[k]]]));

async function partV(m) {
  section("V1. No daily cap set (0, the default): every keyed step waits, with no call and nothing counted");
  const S0 = settingsWith({ spend_caps: caps() });
  check("the notes, as the cells and the sweep show them",
    VENDOR_CAP_KEYS.every((k) => CAP_NOT_SET[vendorKind(k)] === `No daily cap is set for ${VENDOR_CAP_LABELS[k]} yet (Companies settings)`) &&
      CAP_REACHED.findymail_calls === "Today's Findymail calls are used up" && CAP_REACHED.prospeo_calls === "Today's Prospeo calls are used up" &&
      CAP_REACHED.anymail_finder_calls === "Today's Anymail Finder calls are used up" && CAP_REACHED.enrichley_calls === "Today's Enrichley checks are used up");
  const led0 = await ledger();
  const calls0 = vendorCalls();
  const outs = {};
  for (const action of Object.keys(STEP_INPUTS())) outs[action] = await step(action, S0);
  const wrong = Object.entries(outs).filter(([a, o]) => !(o.status === "needs_key" && o.note === CAP_NOT_SET[vendorKind(KEYED_STEPS[a].cap)]));
  check("each of the six keyed steps waits: No daily cap is set for its vendor", wrong.length === 0, JSON.stringify(wrong));
  check("... no vendor was called and the ledger is unchanged",
    JSON.stringify(vendorCalls()) === JSON.stringify(calls0) && JSON.stringify(await ledger()) === JSON.stringify(led0),
    JSON.stringify({ calls: vendorCalls(), ledger: await ledger() }));

  section("V2. A cap of 2 calls a day: the third call waits, and the counts land in enrich_spend_daily");
  const S2 = settingsWith({ spend_caps: caps(Object.fromEntries(VENDOR_CAP_KEYS.map((k) => [k, led0[vendorKind(k)] + 2]))) });
  const RUNS = {
    findymail: ["findymail_find_work_email", "findymail_find_work_email_from_linkedin", "findymail_find_work_email"],
    prospeo: ["prospeo_find_work_email", "prospeo_linkedin_email_search", "prospeo_find_work_email"],
    anymail_finder: ["anymail_finder", "anymail_finder", "anymail_finder"],
    enrichley: ["enrichley_verify_email", "enrichley_verify_email", "enrichley_verify_email"],
  };
  check("each keyed step counts under its vendor's cap (KEYED_STEPS.cap)", Object.values(RUNS).flat().every((a) => Object.keys(RUNS).includes(KEYED_STEPS[a].cap)) && Object.keys(KEYED_STEPS).length === 6);
  for (const [vendor, actions] of Object.entries(RUNS)) {
    const before = net.calls[NET_NAME[vendor]];
    const res = [];
    for (const a of actions) res.push(await step(a, S2));
    const sent = net.calls[NET_NAME[vendor]] - before;
    const kind = vendorKind(vendor);
    check(`${VENDOR_CAP_LABELS[vendor]}: two calls go out${vendor === "findymail" || vendor === "prospeo" ? " (its two steps share the cap)" : ""}, the third waits with no call`,
      sent === 2 && res[0].status !== "needs_key" && res[1].status !== "needs_key" && res[2].status === "needs_key" && res[2].note === CAP_REACHED[kind],
      JSON.stringify({ sent, res: res.map((r) => [r.status, r.note]) }));
  }
  const led2 = await ledger();
  check("enrich_spend_daily holds 2 more calls of each vendor today, under <vendor>_calls",
    VENDOR_SPEND_KINDS.every((k) => led2[k] === led0[k] + 2), JSON.stringify({ led0, led2 }));
  const spent = await spentToday(pool);
  check("spentToday() (the worker's heartbeat spend_today) gives the four counts beside Reoon's and OpenAI's",
    VENDOR_SPEND_KINDS.every((k) => spent[k] === led2[k]) && typeof spent.reoon_checks === "number" && typeof spent.openai_usd_pipeline === "number", JSON.stringify(spent));
  const usedUp = await spendAllowed(pool, "findymail_calls", S2);
  const notSet = await spendAllowed(pool, "findymail_calls", S0);
  const reoonZero = await spendAllowed(pool, "reoon_checks", settingsWith({ spend_caps: { ...caps(), reoon_checks_per_day: 0 } }));
  check("spendAllowed: used up at the cap, not set at 0; Reoon's share at 0 still reads as used up",
    !usedUp.ok && usedUp.why === CAP_REACHED.findymail_calls && !notSet.ok && notSet.why === CAP_NOT_SET.findymail_calls && !reoonZero.ok && reoonZero.why === CAP_REACHED.reoon_checks,
    JSON.stringify({ usedUp, notSet, reoonZero }));

  section("V3. A step that sends nothing takes no call");
  const roomy = settingsWith({ spend_caps: caps(each(100_000)) });
  const led3 = await ledger();
  const calls3 = vendorCalls();
  const noKey = await step("findymail_find_work_email", roomy, { env: {} });
  const noInput = await step("enrichley_verify_email", roomy, { inputs: { email: "" } });
  const noName = await step("prospeo_find_work_email", roomy, { inputs: { full_name: "", company_domain: dom("finder") } });
  const elsewhere = await step("anymail_finder", roomy, { inputs: { ...STEP_INPUTS().anymail_finder, url: `https://elsewhere.${HOST}/person` } });
  const lostRow = (await rowsOf(HB))[0].id;
  await pool.query(
    `INSERT INTO enrich_cell_runs (row_id, column_key, status, provider, error, http_status, started_at)
     VALUES ($1, 'zz_lost', 'error', 'Prospeo', 'timed out', NULL, now()), ($1, 'zz_lost', 'error', 'Prospeo', 'timed out', NULL, now())`,
    [lostRow]
  );
  const lost = await step("prospeo_find_work_email", roomy, { row: { id: lostRow }, column: { key: "zz_lost" } });
  check("no key (skipped), no input, a host that isn't the vendor's, and two sends already lost: no call, nothing counted",
    noKey.status === "skipped" && noKey.note === absentKeyNote("FINDYMAIL_API_KEY") && noInput.status === "empty" && noName.status === "empty" &&
      elsewhere.status === "error" && lost.status === "error" && /Sent 2 times with no answer/.test(lost.note ?? "") &&
      JSON.stringify(vendorCalls()) === JSON.stringify(calls3) && JSON.stringify(await ledger()) === JSON.stringify(led3),
    JSON.stringify({ noKey, noInput, noName, elsewhere: elsewhere.note, lost: lost.note }));
  const memEmail = at("memory", "kept");
  const memCol = {
    key: "zz_enrichley_memory", name: "Enrichley (memory check)", kind: "action", action: "enrichley_verify_email", phase: 1, position: 1,
    inputs: { email: JSON.stringify(memEmail), memory_key: JSON.stringify(memEmail) },
    config: { memory: "enrichley_verify_email_v1", memory_days: "email", key_env: "ENRICHLEY_API_KEY" }, needs_env: [],
  };
  const runMem = () => runRow({ row: { id: 0, created_at: new Date() }, table: { client_tag: HA, template: "inboxes_v1" }, columns: [memCol], cells: new Map(), env: VENDOR_KEYS, db: pool, settings: roomy });
  const e0 = net.calls.enrichley;
  const l0 = (await ledger()).enrichley_calls;
  const firstMem = await runMem();
  const e1 = net.calls.enrichley;
  const l1 = (await ledger()).enrichley_calls;
  const secondMem = await runMem();
  check("an answer already held (the shared memory) makes no call and counts nothing; the first, paid one counted once",
    firstMem.calls === 1 && e1 - e0 === 1 && l1 - l0 === 1 && secondMem.calls === 0 && net.calls.enrichley === e1 && (await ledger()).enrichley_calls === l1,
    JSON.stringify({ first: firstMem.calls, second: secondMem.calls, calls: [e0, e1, net.calls.enrichley], ledger: [l0, l1] }));
  const baseP = (await ledger()).prospeo_calls;
  const tight = settingsWith({ spend_caps: caps({ ...each(100_000), prospeo: baseP + 3 }) });
  const takes = await Promise.all(Array.from({ length: 10 }, () => takeVendorCall(pool, "prospeo", tight)));
  check("ten takes at once with 3 calls left: exactly 3 are given",
    takes.filter((x) => x === "ok").length === 3 && takes.filter((x) => x === "used_up").length === 7 && (await ledger()).prospeo_calls === baseP + 3,
    JSON.stringify(takes));
  const ledZ = await ledger();
  check("... and with no cap set a take writes nothing", (await takeVendorCall(pool, "enrichley", S0)) === "not_set" && JSON.stringify(await ledger()) === JSON.stringify(ledZ));

  section("V4. The waiting row is queued again by the hourly sweep once the cap allows it: the next day");
  const others = await one(
    `SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id
      WHERE t.template IS NOT NULL AND r.run_status = 'waiting' AND NOT (t.client_tag = ANY($1::text[]))`,
    [TAGS]
  );
  if (others.n || !m.waitingInbox) {
    check("no other client's template rows waiting (the sweep would queue them too), and the waiting inbox row from M3", false, JSON.stringify({ others: others.n, row: m.waitingInbox }));
    return;
  }
  const env = { ...KEYS, ENRICHLEY_API_KEY: VENDOR_KEYS.ENRICHLEY_API_KEY };
  const wid = m.waitingInbox;
  resetCompanyActions();
  const sweepNotSet = await requeueWaitingTemplateRows(pool, env, { settings: S0 });
  check("no cap set: the sweep leaves it waiting, and says why", sweepNotSet.queued === 0 && sweepNotSet.why === CAP_NOT_SET.enrichley_calls && (await statusOf(wid)) === "waiting", JSON.stringify(sweepNotSet));
  const usedToday = (await ledger()).enrichley_calls;
  const capAt = settingsWith({ spend_caps: caps({ ...each(0), enrichley: Math.max(1, usedToday) }) });
  if (!usedToday) await takeVendorCall(pool, "enrichley", capAt);
  const sweepUsedUp = await requeueWaitingTemplateRows(pool, env, { settings: capAt });
  check("today's checks used up: still waiting, Today's Enrichley checks are used up",
    sweepUsedUp.queued === 0 && sweepUsedUp.why === CAP_REACHED.enrichley_calls && (await statusOf(wid)) === "waiting", JSON.stringify(sweepUsedUp));
  // The next UTC day: today's count becomes yesterday's.
  await pool.query(
    `WITH t AS (DELETE FROM enrich_spend_daily WHERE day = ${TODAY} AND kind = 'enrichley_calls' RETURNING used)
     INSERT INTO enrich_spend_daily AS s (day, kind, used, updated_at)
     SELECT ${TODAY} - 1, 'enrichley_calls', used, now() FROM t
     ON CONFLICT (day, kind) DO UPDATE SET used = s.used + EXCLUDED.used, updated_at = now()`
  );
  const nextDayNotSet = await requeueWaitingTemplateRows(pool, env, { settings: S0 });
  check("the next day, a cap of 0 still never clears", nextDayNotSet.queued === 0 && nextDayNotSet.why === CAP_NOT_SET.enrichley_calls && (await statusOf(wid)) === "waiting", JSON.stringify(nextDayNotSet));
  const nextDay = await requeueWaitingTemplateRows(pool, env, { settings: capAt });
  check("the next day with a cap set: the same sweep queues it", nextDay.queued === 1 && (await statusOf(wid)) === "queued", JSON.stringify(nextDay));
  net.vendors.enrichley.set(m.waitingEmail, { valid: true, result: "catch_all_validated" });
  const e2 = net.calls.enrichley;
  const redo = await workRow(pool, net, wid, { env, settings: capAt });
  check("... worked again: G#41 makes its one call, counted under the new day, and Enrichley's answer decides",
    net.calls.enrichley - e2 === 1 && redo.cell("enrichly_validation")?.status === "done" && (await ledger()).enrichley_calls === 1 &&
      redo.values.inbox_outcome === "Approved" && redo.status === "done" && redo.paid.reoon === 0,
    JSON.stringify({ calls: net.calls.enrichley - e2, cell: redo.cell("enrichly_validation"), outcome: redo.values.inbox_outcome, status: redo.status }));
}

// ── W. The worker ───────────────────────────────────────────────────────────

function partW() {
  section("W. The worker offers held_release and releases beside its stale sweep");
  const ws = readFileSync(new URL("./enrich-worker.mjs", import.meta.url), "utf8");
  check("held_release is in its capabilities (the Clay tab warns without it)", /const CAPABILITIES = \[[^\]]*"held_release"/.test(ws));
  check("its 60-second block releases held rows right after reclaimStale, and a failure there is logged, never thrown",
    /if \(Date\.now\(\) - lastSweep > 60_000\) \{\s*await reclaimStale\(\);\s*await releaseHeld\(\);/.test(ws) &&
      /async function releaseHeld\(\) \{\s*try \{\s*const \{ released, tables, refused \} = await releaseHeldRows\(housekeepingPool\);[\s\S]*?\} catch \(e\) \{/.test(ws));
}

// ── Run ─────────────────────────────────────────────────────────────────────

let spendBefore = null;

async function cleanup() {
  const tbl = (await all(`SELECT id FROM enrich_tables WHERE client_tag = ANY($1::text[])`, [TAGS])).map((r) => r.id);
  await pool.query(`DELETE FROM enrich_memory WHERE client_tag = ANY($1::text[]) OR table_id = ANY($2::uuid[]) OR key LIKE $3`, [TAGS, tbl, `%.${HOST}%`]);
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tbl]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tbl]);
  await pool.query(`DELETE FROM enrich_originals WHERE variant = ANY($1::text[])`, [VARIANTS]);
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[])`, [TAGS]);
  if (switchBefore) {
    if (switchBefore.exists) {
      await pool.query(`UPDATE enrich_settings SET value = $1::jsonb, updated_by = $2 WHERE key = 'company_pipeline'`, [JSON.stringify(switchBefore.value), switchBefore.updated_by]);
    } else {
      await pool.query(`DELETE FROM enrich_settings WHERE key = 'company_pipeline'`);
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
  const ready = await one(
    `SELECT to_regclass('public.enrich_inbound_urls') IS NOT NULL AS urls, to_regprocedure('public.fn_enrich_company_switch_on(text)') IS NOT NULL AS fn,
            EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_enrich_rows_release_guard') AS guard`
  );
  if (!ready.urls || !ready.fn || !ready.guard) throw new Error("migration 129 is not in this database");
  await cleanup();
  const sw = await one(`SELECT value, updated_by FROM enrich_settings WHERE key = 'company_pipeline'`);
  switchBefore = { exists: Boolean(sw), value: sw?.value ?? null, updated_by: sw?.updated_by ?? null };
  spendBefore = await all(`SELECT day::text AS day, kind, used::text AS used, updated_at FROM enrich_spend_daily ORDER BY day, kind`);
  BASE_ROWS = await all(`SELECT key, value FROM enrich_settings`);
  // The release acts on every client switched on, so the run stops unless no other client is on the list.
  const heldElsewhere = await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE run_status = 'held'`);
  const listed = settingsFrom(BASE_ROWS).company_pipeline.tags;
  check("before the run: no held row anywhere, and no client on the company_pipeline switch's list in this database",
    heldElsewhere.n === 0 && listed.length === 0, JSON.stringify({ held: heldElsewhere.n, tags: listed }));
  if (heldElsewhere.n || listed.length) throw new Error("not run: another client is on the switch or holds held rows here");
  ({ insertRows } = await routeLoader(randomUUID()).srcModule("lib/enrich/insert-rows.ts"));
  for (const t of TAGS) await addClient(t);
  resetClientChecks();
  resetCompanyActions();
  const h = await partH();
  const m = await partM(h);
  await partV(m);
  partW();
  check("nothing tried to reach any other address", net.calls.refused === 0, `${net.calls.refused} refused`);
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[])) AS clients,
            (SELECT count(*)::int FROM enrich_tables WHERE client_tag = ANY($1::text[])) AS tables,
            (SELECT count(*)::int FROM enrich_originals WHERE variant = ANY($2::text[])) AS originals,
            (SELECT count(*)::int FROM enrich_memory WHERE client_tag = ANY($1::text[])) AS memory,
            (SELECT count(*)::int FROM email_validations WHERE email LIKE $3) AS validations,
            (SELECT count(*)::int FROM client_targeting WHERE client_tag = ANY($1::text[])) AS targeting`,
    [TAGS, VARIANTS, `%.${HOST}`]
  );
  const sw = await one(`SELECT value FROM enrich_settings WHERE key = 'company_pipeline'`);
  const switchBack = !switchBefore || (switchBefore.exists ? JSON.stringify(sw?.value) === JSON.stringify(switchBefore.value) : !sw);
  const spendBack = !spendBefore || JSON.stringify(await spendNow()) === JSON.stringify(spendBefore.map(({ day, kind, used }) => ({ day, kind, used })));
  const clean = Object.values(left).every((n) => n === 0) && switchBack && spendBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, switchBack, spendBack })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
