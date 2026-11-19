#!/usr/bin/env node
// An upload's no-email rows worked in the client's People table (migration
// 130): the worker's side. LOCAL DATABASE ONLY: two made-up clients
// (UPTEST_A, UPTEST_B) with their rules and the made-up Clay originals as
// their own variant, made-up uploads (file names starting "upenrich-") with
// their kept-back rows, made-up people and places under .uptest.example, and
// one made-up lead. For the run it also writes the company_pipeline and
// people_pipeline switches and today's spend; all three are put back at the
// end, and everything else it made is removed. No other test's tags are
// touched.
//
//   node --env-file=.env.local scripts/test-upload-enrich.mjs
//
// Stop the enrichment worker first, and don't start it for this: its own
// functions run here instead (the move, the two releases, the found-email
// pass), and its claim inside a transaction that is rolled back. Migrations
// 129 and 130 must be in the local database. The run refuses while any row is
// held, any client is on either switch's list, or any upload is in
// upload_people or waiting to be decided: the move and the releases act on
// every client.
//
// Nothing here reaches a network: fetch answers OpenAI, Reoon, Google's DNS,
// the email finders, Enrichley and made-up websites from stubs, and refuses
// and counts any other address; the web app's found-email route is a
// stand-in handed to the worker's request. No paid key is read from the
// environment; the keys here are made up.
//
//   M. the move: which uploads are decided and how, held rows with their
//      inputs, the source row, chunks and the progress mark, a repeat, a
//      deleted row not put back, a refusal and its retry, nothing claimed
//   R. the release: the guard per table template, people_pipeline only, the
//      open-rows limit, a client switched off meanwhile, never another
//      template, and Companies (Maps) rows as in test-held-caps
//   W. upload rows worked: the finders in order against stubbed vendors, only
//      inside the area and clear of the rules, Current Employer,
//      personalisation and Reoon never, caps at 0 waiting, rows with no email
//      found staying; an AI Ark row the same with and without the gates;
//      in_database's domain on both kinds of row; the local default originals
//      (their structure, and two rows worked in memory)
//   F. found emails: the worker's config, its request against stand-ins, the
//      hand-off once per found person with the right fields, a retry after
//      the web answers an error, a dead round's people asked for again
//   S. the worker's wiring, the folder script's insert, the Companies tab
//      never taking an upload row, nothing here writing leads

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checker, dropPaidKeys, inTx, installNet, localDatabaseUrl, routeLoader, seedFixtureVariant, WORKER_SQL, workRow } from "./fixtures/test-support.mjs";
import { fixtureSeedExports } from "./fixtures/clay-originals/fixtures.mjs";
import { originalRows, originalsMap } from "./lib/enrich/seed-originals.mjs";
import { compileColumn, loadOriginals, OriginalsMissing, refMap, runIfAnd } from "./lib/enrich/compile-original.mjs";
import { compileTemplates, RetiredV1Table, variantName } from "./lib/enrich/templates.mjs";
import { order } from "./lib/enrich/formula.mjs";
import { runRow, stable } from "./lib/enrich/engine.mjs";
import { settingsFrom, VENDOR_CAP_KEYS } from "./lib/enrich/settings.mjs";
import { CAP_NOT_SET, VENDOR_SPEND_KINDS, vendorKind } from "./lib/enrich/spend.mjs";
import { resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { resetCompanyActions } from "./lib/enrich/company-actions.mjs";
import { projectContact } from "./lib/enrich/project-contacts.mjs";
import { HELD_REFUSED, releaseHeldPeopleRows, releaseHeldRows } from "./lib/enrich/held.mjs";
import { PEOPLE_COLUMNS, PEOPLE_REFS } from "./lib/enrich/people-template.mjs";
import { MAPS_SOURCE, placeInputs, placeRowKey } from "./lib/enrich/maps-place.mjs";
import { moveUploadRows, tablesRefusalReason } from "./lib/enrich/upload-move.mjs";
import { askForFound, FOUND_AUTO_PATH, foundAutoConfig, foundDue, requestFound } from "./lib/enrich/upload-found.mjs";
import {
  ADD_COLUMN, APPROVED_OUTCOME, FOUND_EVERY_MS, FOUND_ROUND_MAX, FOUND_SOURCE_LABEL, FOUND_TAKE_SQL, NOT_UPLOAD_ROW, UPLOAD_AREA_GATED,
  UPLOAD_CAPABILITY, UPLOAD_NEVER, UPLOAD_SOURCE_KIND, UPLOAD_SPEND_GATE, WAIT_WHY, foundBatchFilename, foundImportLayout, foundImportRow,
  foundTags, parseUploadRowKey, peopleSearchText, uploadPeopleInputs, uploadSourceLabel,
} from "./lib/enrich/upload-people.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

const UA = "UPTEST_A"; // its uploads are moved, released and worked
const UB = "UPTEST_B"; // a retired companies_v1 table at first; off for most of the run
const TAGS = [UA, UB];
const VARIANTS = TAGS.map(variantName);
const RUN = randomUUID().slice(0, 6);
const HOST = "uptest.example";
const PREFIX = "upenrich-";
const FILE = `${PREFIX}${RUN}`;
const dom = (slug) => `${slug}-${RUN}.${HOST}`;
const at = (slug, local) => `${local}@${dom(slug)}`;
const SWITCHES = ["company_pipeline", "people_pipeline"];
const TODAY = `(now() AT TIME ZONE 'utc')::date`;
const BANNED = "uptestbanned"; // the made-up clients' one exclusion term
const KEYS = {
  OPENAI_API_KEY: "made-up-openai", ENRICH_REOON_API_KEY: "made-up-reoon", FINDYMAIL_API_KEY: "made-up-fm", PROSPEO_API_KEY: "made-up-pr",
  ANYMAIL_FINDER_API_KEY: "made-up-am", ENRICHLEY_API_KEY: "made-up-en",
};
/** net.calls' names of everything that costs or reaches a provider. */
const PAID = ["openai", "reoon", "dns", "findymail", "prospeo", "anymail", "enrichley"];
const CREATED = new Date("2026-11-18T00:00:00Z");
/** Each client's three pipeline tables ({ companies, inboxes, people }). */
const tables = {};

/** A statement's refusal ({ code, message }), or null when it went through. */
async function refusal(sql, params) {
  try {
    await pool.query(sql, params);
    return null;
  } catch (e) {
    return { code: e.code, message: e.message };
  }
}

// ── Switches, settings and today's spend ────────────────────────────────────

/** The two switches as they were before the run ({ key: { exists, value, updated_by } }), put back at the end. */
let switchesBefore = null;
async function setSwitch(key, value) {
  const base = switchesBefore?.[key]?.value && typeof switchesBefore[key].value === "object" ? switchesBefore[key].value : {};
  await pool.query(
    `INSERT INTO enrich_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify({ ...base, ...value })]
  );
}

let BASE_ROWS = [];
const stored = (key) => BASE_ROWS.find((r) => r.key === key)?.value ?? {};
/** The stored settings with some keys replaced: what a worked row gets (the database's rows stay as they are). */
const settingsWith = (over = {}) =>
  settingsFrom(BASE_ROWS.filter((r) => !(r.key in over)).concat(Object.entries(over).map(([key, value]) => ({ key, value }))));

/** Today's counts of the four vendor kinds. */
async function ledger() {
  const rows = await all(`SELECT kind, used FROM enrich_spend_daily WHERE day = ${TODAY} AND kind = ANY($1::text[])`, [[...VENDOR_SPEND_KINDS]]);
  return Object.fromEntries(VENDOR_SPEND_KINDS.map((k) => [k, Number(rows.find((r) => r.kind === k)?.used ?? 0)]));
}

/**
 * What the worker hands a row here: OpenAI and Reoon with room, each vendor's
 * calls with `room` left today (0: no cap set), and Current Employer (via
 * linkedin_profile_reads) and personalisation switched on for UA.
 */
async function workSettings({ room = 100 } = {}) {
  const led = await ledger();
  return settingsWith({
    spend_caps: {
      ...stored("spend_caps"), reoon_checks_per_day: 100_000, openai_usd_per_day: { pipeline: 10_000, fit: 10_000 },
      vendor_calls_per_day: Object.fromEntries(VENDOR_CAP_KEYS.map((k) => [k, room ? led[vendorKind(k)] + room : 0])),
    },
    company_pipeline: { ...stored("company_pipeline"), enabled: true, tags: [UA], linkedin_profile_reads: true },
    personalisation: { ...stored("personalisation"), enabled: true, tags: [UA] },
  });
}

// ── Clients, uploads, places ────────────────────────────────────────────────

async function addClient(t) {
  await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, NULL)`, [t, `Upload enrich test ${t.slice(-1)}`]);
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
     VALUES ($1, '{US}', $2, '[]', $3, false, now())`,
    [t, JSON.stringify([{ city: "Springfield", state: "IL", country: "US" }]), [BANNED]]
  );
  await seedFixtureVariant(pool, t);
}

const HEADERS = ["First Name", "Last Name", "Title", "Company", "Email", "City", "State", "Website", "LinkedIn", "Validation"];
const MAPPING = { 0: "first_name", 1: "last_name", 2: "title", 3: "company", 4: "email", 5: "city", 6: "state", 7: "domain", 8: "person_linkedin", 9: "validation_status" };
const COMPANY = `Acme Uptest ${RUN}`;
/** One uploaded row with no usable email ("N/A"), as the upload kept it back. */
const person = (first, last, { title = "Office Manager", company = COMPANY, city = "Springfield", state = "IL", site = dom("acme"), linkedin = "" } = {}) =>
  [first, last, title, company, "N/A", city, state, site ? `https://www.${site}/about` : "", linkedin, "invalid"];
const LEE_IN = `https://www.linkedin.com/in/lee-link-${RUN}`;
const MAIN = [
  person("Fiona", "Findy"), //                                           0 Findymail finds her
  person("Paul", "Prospect"), //                                         1 Prospeo finds him
  person("Amy", "Anymail"), //                                           2 Anymail Finder finds her, Enrichley checks it
  person("Lee", "Link", { site: "", linkedin: LEE_IN }), //              3 a LinkedIn link only: Prospeo by LinkedIn
  person("Nora", "Nofind"), //                                           4 nobody finds her
  person("Otto", "Outside", { city: "Bismarck", state: "ND" }), //       5 outside the client's area
  person("Bea", "Banned", { company: `Uptestbanned Supplies ${RUN}` }), // 6 the client's rules exclude her company
  person("Del", "Deleted"), //                                           7 deleted from the table after the copy
  person("Wes", "Waits"), //                                             8 worked while no vendor cap is set
  ["--", "N/A", "", "", "", "", "", "", "", ""], //                      9 nothing to search on
];

let fileSeq = 0;
/** A made-up upload batch with its kept-back rows (upload_holdbacks), as an import leaves them. tags null: made before 130. */
async function upload(label, { tags = [UA], status = "complete", rows = [], mapping = MAPPING, sourceLabel = null } = {}) {
  const filename = `${FILE}-${++fileSeq}-${label}.csv`;
  const { rows: [b] } = await pool.query(
    `INSERT INTO upload_batches (filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type, source_label,
                                 add_tags, override_fields, no_email_rows)
     VALUES ($1, $2, $3, 'merge', $4::jsonb, $5::jsonb, 'leads', $6, $7::text[], $8::text[], $9) RETURNING id`,
    [filename, rows.length, status, mapping ? JSON.stringify(mapping) : null, JSON.stringify(HEADERS), sourceLabel, tags, tags ? [] : null, rows.length]
  );
  for (const [seq, raw] of rows.entries()) {
    await pool.query(`INSERT INTO upload_holdbacks (batch_id, seq, row_index, raw) VALUES ($1, $2, $3, $4::jsonb)`, [b.id, seq, seq + 2, JSON.stringify(raw)]);
  }
  return { id: b.id, filename };
}

const upOf = (batchId) => one(`SELECT * FROM upload_people WHERE batch_id = $1`, [batchId]);
/** An upload's People rows, oldest first, with their seq. */
const rowsOf = async (tableId, batchId) =>
  (await all(`SELECT id, row_key, run_status, search_text, source_id FROM enrich_rows WHERE table_id = $1 AND starts_with(row_key, $2) ORDER BY id`, [tableId, `upload:${batchId}:`]))
    .map((r) => ({ ...r, id: Number(r.id), seq: parseUploadRowKey(r.row_key)?.seq ?? null }));
const statusOf = async (id) => (await one(`SELECT run_status FROM enrich_rows WHERE id = $1`, [id]))?.run_status ?? null;
const cellsOf = async (id) => Object.fromEntries((await all(`SELECT column_key, value FROM enrich_cells WHERE row_id = $1`, [id])).map((c) => [c.column_key, c.value]));
async function loadTables(t) {
  const rows = await all(`SELECT kind, id FROM enrich_tables WHERE client_tag = $1 AND template IS NOT NULL AND template <> 'companies_v1'`, [t]);
  tables[t] = Object.fromEntries(rows.map((r) => [r.kind, r.id]));
  return tables[t];
}

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

let placeSeq = 0;
/** A made-up Google Maps item, as the Maps provider's postback writes one. */
const place = (slug, title, { city = "Springfield", region = "Illinois" } = {}) => ({
  type: "maps_search", title: `${title} ${RUN}`, place_id: `uptest-${RUN}-${++placeSeq}`, url: `https://www.${dom(slug)}/`, domain: `www.${dom(slug)}`,
  phone: "+1 217-555-0100", category: "Dentist", address_info: { address: "100 Main Street", city, zip: "62701", region, country_code: "US" },
});
/** insert-rows.ts, compiled by the test loader (the intake's own insert). */
let insertRows = null;
/** A chunk's places into a client's Companies (pipeline) table, held, as the inbound URL's intake writes them. */
async function deliver(t, items) {
  const tableId = tables[t].companies;
  const inputKeys = (await all(`SELECT key FROM enrich_columns WHERE table_id = $1 AND kind = 'input'`, [tableId])).map((r) => r.key);
  return inTx(pool, (c) =>
    insertRows(c, {
      tableId, inputKeys, runStatus: "held", rowKey: (i) => placeRowKey(i.place_id),
      rows: items.map((it) => ({ inputs: placeInputs(it, { city: "Springfield", state: "IL", category: "dentist" }, t) })),
      source: { kind: "maps", externalId: `uptest-${RUN}-chunk-${++placeSeq}`, label: "Upload enrich test", meta: {} },
    })
  );
}
const mapsRowOf = async (t, item) => (await one(`SELECT id, run_status FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tables[t].companies, placeRowKey(item.place_id)])) ?? null;

// ── M. The move ─────────────────────────────────────────────────────────────

async function partM() {
  section("M1. Which uploads are decided, and how");
  const main = await upload("main", { tags: ["uptest_a", "Q4 list"], rows: MAIN });
  const noTag = await upload("notag", { tags: [], rows: [person("No", "Tag")] });
  const notClient = await upload("notclient", { tags: ["Q4 list"], rows: [person("Not", "Client")] });
  const several = await upload("several", { tags: ["UPTEST_A", " uptest_b "], rows: [person("Two", "Clients")] });
  const before = await upload("before", { tags: null, rows: [person("Old", "Upload")] });
  const busy = await upload("busy", { tags: ["Q4 list"], status: "processing", rows: [person("Still", "Importing")] });
  const empty = await upload("empty", { tags: [UA], rows: [] });
  const bison = await upload("bison", { tags: [UA], mapping: null, rows: [person("Bison", "Format")] });
  const round = await upload("round", { tags: [UA], sourceLabel: FOUND_SOURCE_LABEL, rows: [person("Found", "Round")] });
  const failed = await upload("failed", { tags: [UB], status: "error", rows: [person("Uma", "Ub"), person("Ulf", "Ub")] });
  // UB still has a retired companies_v1 table, so its pipeline tables can't be made yet (D24).
  await pool.query(`INSERT INTO enrich_tables (client_tag, kind, name, template) VALUES ($1, 'companies', 'Companies (pipeline)', 'companies_v1')`, [UB]);
  const uploads = { main, noTag, notClient, several, before, busy, empty, bison, round, failed };
  const stateOf = async () => {
    const out = {};
    for (const [k, b] of Object.entries(uploads)) {
      const p = await upOf(b.id);
      out[k] = p ? `${p.state}:${p.reason ?? ""}:${p.client_tag ?? ""}` : "none";
    }
    return out;
  };
  const r1 = await moveUploadRows(pool, { chunk: 4, maxChunks: 2 });
  const s1 = await stateOf();
  check("a finished upload with one client tag among its tags goes to that client (its other tags don't count); an upload that ended in error too",
    s1.main === `moving::${UA}` && s1.failed === `moving::${UB}`, JSON.stringify(s1));
  check("no tag, no client tag, two client tags: not sent, with the reason and no client",
    s1.noTag === "not_sent:no_tag:" && s1.notClient === "not_sent:not_client:" && s1.several === "not_sent:several:", JSON.stringify(s1));
  check("never decided by the worker: an upload made before 130 (its tags unknown), one still importing, one that kept nothing back, a Bison-format one and a batch of found emails",
    ["before", "busy", "empty", "bison", "round"].every((k) => s1[k] === "none"), JSON.stringify(s1));
  check("... the round says it decided 5 uploads, 3 of them not sent", r1.decided === 5 && r1.notSent === 3, JSON.stringify(r1));

  section("M2. The copy: held rows with their inputs, the source row, chunks and the progress mark");
  await loadTables(UA);
  const own = await all(`SELECT kind, template, source_note FROM enrich_tables WHERE client_tag = $1 ORDER BY kind`, [UA]);
  check("the client's three pipeline tables were made from its own originals before any of its rows went in",
    own.map((x) => `${x.kind}:${x.template}`).join() === "companies:companies_v2,inboxes:inboxes_v1,people:people_v1" && own.every((x) => x.source_note.includes(`(variant ${variantName(UA)})`)),
    JSON.stringify(own));
  const col = async (key) => one(`SELECT run_if, inputs FROM enrich_columns WHERE table_id = $1 AND key = $2`, [tables[UA].people, key]);
  const p46 = await col("find_work_email_findymail");
  const p27 = await col("current_employer");
  const p4 = await col("in_database");
  check("... and its People table carries the upload gates: the finders by area and rules, Current Employer never, in_database's own domain",
    p46.run_if.endsWith(`\n) && ${UPLOAD_SPEND_GATE}`) && p27.run_if.endsWith(`\n) && ${NOT_UPLOAD_ROW}`) &&
      p4.inputs.domain === `{{found_by}} === "upload" ? ({{lookup_company_data}}?.row?.use_domain || {{use_domain}}) : {{lookup_company_data}}?.row?.use_domain`,
    JSON.stringify({ p46: p46.run_if.slice(-120), p27: p27.run_if.slice(-60), domain: p4.inputs.domain }));
  let rows = await rowsOf(tables[UA].people, main.id);
  check("two chunks of 4 a round: the first 8 kept-back rows are People rows, held, keyed upload:<batch id>:<seq>, in seq order",
    r1.moved === 8 && r1.batches === 1 && r1.waiting === 0 && rows.length === 8 && rows.every((r) => r.run_status === "held") &&
      JSON.stringify(rows.map((r) => r.seq)) === "[0,1,2,3,4,5,6,7]" && rows.every((r) => r.row_key === `upload:${main.id}:${r.seq}`),
    JSON.stringify({ r1, rows: rows.map((r) => `${r.seq}:${r.run_status}`) }));
  const fiona = rows.find((r) => r.seq === 0);
  const want = uploadPeopleInputs({ raw: MAIN[0], fieldMapping: MAPPING, clientTag: UA, filename: main.filename });
  const got = await cellsOf(fiona.id);
  check("a row's cells are its People inputs, as text: the person, the company, the website's domain, the place, found_by upload, stage uploaded, the Source; no email",
    JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(want).sort()) && got.found_by === "upload" && got.stage === "uploaded" &&
      got.company_website === dom("acme") && got.written_full_name === "Fiona Findy" && !("email" in got),
    JSON.stringify(got));
  check("... and its search text is made of them", fiona.search_text === peopleSearchText(want), fiona.search_text);
  const src = await one(`SELECT * FROM enrich_sources WHERE table_id = $1 AND kind = $2 AND external_id = $3`, [tables[UA].people, UPLOAD_SOURCE_KIND, main.id]);
  check("one source row for the upload: kind upload, the batch id, \"Upload: <file>\", and its counts",
    src?.label === uploadSourceLabel(main.filename) && src.meta?.batch_id === main.id && src.created_by === null && src.received === 8 && src.created === 8 &&
      src.duplicates === 0 && rows.every((r) => r.source_id === src.id),
    JSON.stringify(src));
  let p = await upOf(main.id);
  check("upload_people: moving, next_seq 8 (how far the copy got), 8 rows moved, the People table and the source row",
    p.state === "moving" && p.next_seq === 8 && p.moved_rows === 8 && p.table_id === tables[UA].people && p.source_id === src.id && p.reason === null && p.moved_at === null,
    JSON.stringify(p));
  const fp = await upOf(failed.id);
  check("... the round's chunks were used up, so the other moving upload waits for the next one", fp.next_seq === 0 && fp.table_id === null && fp.reason === null);

  section("M3. A repeat copies nothing twice; a deleted row is not put back; the last chunk ends the copy");
  await pool.query(`UPDATE upload_people SET next_seq = 0 WHERE batch_id = $1`, [main.id]);
  const r2 = await moveUploadRows(pool, { chunk: 4, maxChunks: 2 });
  rows = await rowsOf(tables[UA].people, main.id);
  const src2 = await one(`SELECT received, created, duplicates FROM enrich_sources WHERE id = $1`, [src.id]);
  p = await upOf(main.id);
  check("the same 8 rows copied again (progress mark set back): nothing new, counted as duplicates, the mark back at 8",
    r2.moved === 0 && r2.decided === 0 && rows.length === 8 && src2.received === 16 && src2.created === 8 && src2.duplicates === 8 && p.next_seq === 8 && p.moved_rows === 8,
    JSON.stringify({ r2, src2, next: p.next_seq }));
  const del = rows.find((r) => r.seq === 7);
  await pool.query(`DELETE FROM enrich_rows WHERE id = $1`, [del.id]);
  const r3 = await moveUploadRows(pool, { chunk: 4, maxChunks: 3 });
  rows = await rowsOf(tables[UA].people, main.id);
  p = await upOf(main.id);
  check("the next round copies the last 2 rows and the upload is moved; the row deleted from the table is not put back",
    r3.moved === 2 && JSON.stringify(rows.map((r) => r.seq)) === "[0,1,2,3,4,5,6,8,9]" && p.state === "moved" && p.next_seq === 10 && p.moved_rows === 10 && p.moved_at !== null,
    JSON.stringify({ r3, seqs: rows.map((r) => r.seq), p }));
  const nineInputs = await cellsOf(rows.find((r) => r.seq === 9).id);
  check("a kept-back row with nothing but placeholders goes in too, with the row's own facts only",
    JSON.stringify(Object.keys(nineInputs).sort()) === JSON.stringify(["client_tag", "found_by", "source", "stage"]), JSON.stringify(nineInputs));

  section("M4. The client's tables can't be made: the upload waits with the reason, and is tried again");
  const fw = await upOf(failed.id);
  check("a client with a retired companies_v1 table: its upload stays moving, waiting (retired_v1), tried again in 10 minutes, nothing copied",
    r3.waiting === 1 && fw.state === "moving" && fw.reason === "retired_v1" && fw.table_id === null && new Date(fw.next_try_at).getTime() > Date.now() + 9 * 60_000 &&
      typeof WAIT_WHY.retired_v1 === "string" && (await one(`SELECT count(*)::int AS n FROM enrich_tables WHERE client_tag = $1`, [UB])).n === 1,
    JSON.stringify({ r3, fw }));
  check("the two refusals and their reasons: the originals not loaded, a retired companies_v1 table; anything else is no refusal",
    tablesRefusalReason(new OriginalsMissing("x", {})) === "originals_missing" && tablesRefusalReason(new RetiredV1Table(UB)) === "retired_v1" &&
      tablesRefusalReason(new Error("x")) === null && typeof WAIT_WHY.originals_missing === "string");
  const r4 = await moveUploadRows(pool);
  check("a round straight after has nothing due", r4.decided === 0 && r4.moved === 0 && r4.waiting === 0, JSON.stringify(r4));
  await pool.query(`UPDATE upload_batches SET status = 'complete' WHERE id = $1`, [busy.id]);
  const r5 = await moveUploadRows(pool);
  check("an upload is decided once its import is over (here: no client tag, not sent)", r5.decided === 1 && r5.notSent === 1 && (await upOf(busy.id))?.reason === "not_client", JSON.stringify(r5));
  await pool.query(`DELETE FROM enrich_tables WHERE client_tag = $1 AND template = 'companies_v1'`, [UB]);
  await pool.query(`UPDATE upload_people SET next_try_at = now() WHERE batch_id = $1`, [failed.id]);
  const r6 = await moveUploadRows(pool);
  await loadTables(UB);
  const fm = await upOf(failed.id);
  const ubRows = await rowsOf(tables[UB].people, failed.id);
  check("once the table is gone and the time has come: the client's tables are made, its 2 rows copied held, the reason cleared",
    r6.moved === 2 && r6.waiting === 0 && fm.state === "moved" && fm.reason === null && fm.table_id === tables[UB].people && ubRows.length === 2 && ubRows.every((r) => r.run_status === "held"),
    JSON.stringify({ r6, fm, ub: ubRows.length }));

  section("M5. Held rows are never claimed, and the move did nothing else");
  const ids = [...(await rowsOf(tables[UA].people, main.id)), ...ubRows].map((r) => r.id);
  const claimed = await claimNow();
  check("the worker's claim (rolled back) takes none of the 11 held upload rows", ids.length === 11 && ids.every((id) => !claimed.includes(id)), `${claimed.filter((id) => ids.includes(id)).length} claimed`);
  const queued = await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = ANY($1::uuid[]) AND run_status <> 'held'`, [[tables[UA].people, tables[UB].people]]);
  check("every row the move made is held: nothing queued, nothing worked", queued.n === 0, `${queued.n}`);
  return { main, failed };
}

// ── R. The release ──────────────────────────────────────────────────────────

async function partR({ main, failed }) {
  section("R1. The guard: each held row answers to its own table's switch");
  const north = place("north", "Northgate Dental");
  const lake = place("lake", "Lakeside Dental");
  const corner = place("corner", "Corner Dental");
  const d = await deliver(UA, [north, lake, corner]);
  const inbox = Number((await one(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, $2, 'held') RETURNING id`, [tables[UA].inboxes, `test:${RUN}:inbox`])).id);
  const people = await rowsOf(tables[UA].people, main.id);
  const bySeq = Object.fromEntries(people.map((r) => [r.seq, r.id]));
  const words = (r) => (r?.code === HELD_REFUSED ? r.message.replace(/^enrich row \d+ stays held: /, "") : `went through: ${JSON.stringify(r)}`);
  const said = {
    people: words(await refusal(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [bySeq[0]])),
    maps: await refusal(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [(await mapsRowOf(UA, north)).id]),
    inbox: words(await refusal(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [inbox])),
  };
  check("both switches off: an upload's People row stays held (23514) under people_pipeline, a Maps row under company_pipeline, an inbox row always",
    said.people === "its client is not on the people_pipeline switch" && said.maps?.code === HELD_REFUSED && /stays held/.test(said.maps.message) &&
      /company_pipeline/.test(said.maps.message) && said.inbox === "only a Companies (pipeline) or People (pipeline) row is ever released",
    JSON.stringify(said));
  const northCells = await cellsOf((await mapsRowOf(UA, north)).id);
  check("the Maps places arrived held through the intake's own insert, with their inputs (as in test-held-caps)",
    d.created === 3 && northCells.place_id === north.place_id && northCells.source === MAPS_SOURCE && northCells.client_tag === UA, JSON.stringify({ d, northCells }));

  section("R2. Released under people_pipeline only; Companies rows under company_pipeline only");
  const none = { people: await releaseHeldPeopleRows(pool), maps: await releaseHeldRows(pool) };
  check("both switches off: neither release takes anything", none.people.released === 0 && none.people.tables === 0 && none.maps.released === 0, JSON.stringify(none));
  await setSwitch("company_pipeline", { enabled: true, tags: [UA] });
  const pc = await releaseHeldPeopleRows(pool);
  const m1 = await releaseHeldRows(pool, { pageSize: 2, maxPages: 1 });
  const m2 = await releaseHeldRows(pool);
  const mapsNow = await all(`SELECT run_status FROM enrich_rows WHERE table_id = $1 ORDER BY id`, [tables[UA].companies]);
  const stillHeld = async () => (await all(`SELECT run_status FROM enrich_rows WHERE id = ANY($1::bigint[])`, [[...people.map((r) => r.id), inbox]])).every((r) => r.run_status === "held");
  check("company_pipeline on for the client: the People release takes nothing; the Maps release takes the places, a page of 2 then the rest, oldest first",
    pc.released === 0 && pc.tables === 0 && m1.released === 2 && m2.released === 1 && mapsNow.every((r) => r.run_status === "queued") && (await stillHeld()),
    JSON.stringify({ pc, m1, m2 }));
  await setSwitch("company_pipeline", { enabled: false, tags: [] });
  const late = place("late", "Late Dental");
  await deliver(UA, [late]);
  await setSwitch("people_pipeline", { enabled: true, tags: [UA] });
  const lateMaps = await releaseHeldRows(pool);
  const first = await releaseHeldPeopleRows(pool, { pageSize: 2, maxPages: 1 });
  const st = async () => Object.fromEntries((await rowsOf(tables[UA].people, main.id)).map((r) => [r.seq, r.run_status]));
  const s1 = await st();
  check("people_pipeline on for the client: a page of 2 of its upload rows, the oldest first; the other client's rows, a held Maps place and an inbox row stay held",
    lateMaps.released === 0 && first.released === 2 && first.tables === 1 && first.refused === 0 && first.full === 0 && s1[0] === "queued" && s1[1] === "queued" &&
      [2, 3, 4, 5, 6, 8, 9].every((q) => s1[q] === "held") && (await rowsOf(tables[UB].people, failed.id)).every((r) => r.run_status === "held") &&
      (await mapsRowOf(UA, late)).run_status === "held" && (await statusOf(inbox)) === "held",
    JSON.stringify({ lateMaps, first, s1 }));

  section("R3. At most RELEASE_OPEN_MAX rows of a People table queued, running or waiting");
  const lim1 = await releaseHeldPeopleRows(pool, { openMax: 4 });
  const lim2 = await releaseHeldPeopleRows(pool, { openMax: 4 });
  const s2 = await st();
  check("with 2 in work and room for 4: 2 more released, the oldest; then the table is full and the rest stay held",
    lim1.released === 2 && lim1.full === 1 && lim2.released === 0 && lim2.full === 1 && lim2.tables === 0 && s2[2] === "queued" && s2[3] === "queued" && s2[4] === "held",
    JSON.stringify({ lim1, lim2, s2 }));
  await pool.query(`UPDATE enrich_rows SET run_status = 'waiting' WHERE id = $1`, [bySeq[0]]);
  await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE id = $1`, [bySeq[1]]);
  const lim3 = await releaseHeldPeopleRows(pool, { openMax: 4 });
  const s3 = await st();
  check("a row done frees a place, a row waiting on a cap keeps its own: 1 more released", lim3.released === 1 && lim3.full === 1 && s3[4] === "queued" && s3[5] === "held", JSON.stringify({ lim3, s3 }));

  section("R4. A client switched off meanwhile");
  await setSwitch("people_pipeline", { enabled: true, tags: [UA, UB] });
  let flipped = false;
  const flipping = {
    query: async (sql, params) => {
      const r = await pool.query(sql, params);
      if (!flipped && /FROM enrich_tables t/.test(sql)) {
        flipped = true;
        await setSwitch("people_pipeline", { enabled: false, tags: [UA, UB] });
      }
      return r;
    },
  };
  const meanwhile = await releaseHeldPeopleRows(flipping);
  const s4 = await st();
  check("switched off between the pick of the tables and their pages: each page refused by the guard (23514), caught; nothing released",
    flipped && meanwhile.released === 0 && meanwhile.refused === 2 && [5, 6, 8, 9].every((q) => s4[q] === "held") &&
      (await rowsOf(tables[UB].people, failed.id)).every((r) => r.run_status === "held"),
    JSON.stringify({ meanwhile, s4 }));
  const offRelease = await releaseHeldPeopleRows(pool);
  const direct = await refusal(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [bySeq[5]]);
  check("switched off: nothing released, and the guard refuses a direct release, naming people_pipeline",
    offRelease.released === 0 && direct?.code === HELD_REFUSED && /people_pipeline/.test(direct.message), JSON.stringify({ offRelease, direct }));

  section("R5. Switched on again: the rest of both clients' rows, and never another template's");
  await setSwitch("people_pipeline", { enabled: true, tags: [UA, UB] });
  const rest = await releaseHeldPeopleRows(pool);
  const s5 = await st();
  check("both clients on: their held rows released (4 and 2), the tables not full",
    rest.released === 6 && rest.tables === 2 && rest.refused === 0 && rest.full === 0 && [5, 6, 8, 9].every((q) => s5[q] === "queued") &&
      (await rowsOf(tables[UB].people, failed.id)).every((r) => r.run_status === "queued"),
    JSON.stringify({ rest, s5 }));
  check("a held Maps place and a held inbox row are never released by the People release",
    (await mapsRowOf(UA, late)).run_status === "held" && (await statusOf(inbox)) === "held");
  const claimed = await claimNow();
  check("the worker's claim now takes the released People rows, and still not the held Maps place",
    [5, 6, 8, 9].every((q) => claimed.includes(bySeq[q])) && !claimed.includes(Number((await mapsRowOf(UA, late)).id)));
  await setSwitch("people_pipeline", { enabled: false, tags: [] });
  await pool.query(`DELETE FROM enrich_rows WHERE id = $1 OR id = $2`, [inbox, (await mapsRowOf(UA, late)).id]);
  return { bySeq };
}

// ── W. Upload rows worked ───────────────────────────────────────────────────

/** One row worked in memory by the given columns, as the worker would, forced (no answer reused): its cells, its calls, what was asked. */
async function runInMemory(columns, inputs, { tag = UA, variant = variantName(UA), env = KEYS, settings, row = {} }) {
  const stored = new Map(Object.entries(inputs).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, { status: "done", value: v }]));
  const cells = new Map(stored);
  const before = { ...net.calls };
  const reqs = net.requests.length;
  const asked = net.asked.length;
  const out = await runRow({
    row: { id: 0, created_at: CREATED, run_force: ["*"], next_run_at: new Date(), ...row },
    table: { id: null, client_tag: tag, template: "people_v1", variant, keyCounts: {} },
    columns, cells: stored, env, db: pool, settings, hooks: { changed: (k, c) => cells.set(k, c) },
  });
  const paid = Object.fromEntries(Object.keys(net.calls).map((k) => [k, net.calls[k] - before[k]]));
  return { ...out, cells, paid, requests: net.requests.slice(reqs), asked: net.asked.slice(asked) };
}
const spent = (paid) => PAID.reduce((n, k) => n + (paid[k] ?? 0), 0);
const uploadInputs = (raw, tag = UA) => uploadPeopleInputs({ raw, fieldMapping: MAPPING, clientTag: tag, filename: `${FILE}-memory.csv` });

/** The made-up originals' People columns with the upload gates taken out again: a check of what they add, and the columns as they were before 130. */
function withoutGates(columns) {
  const problems = [];
  const out = columns.map((c) => {
    const gate = UPLOAD_AREA_GATED.includes(c.key) ? UPLOAD_SPEND_GATE : UPLOAD_NEVER.includes(c.key) ? NOT_UPLOAD_ROW : null;
    const x = { ...c };
    if (gate) {
      const tail = `\n) && ${gate}`;
      if (!c.run_if?.startsWith("(") || !c.run_if.endsWith(tail)) problems.push(c.key);
      else x.run_if = c.run_if.slice(1, -tail.length);
    }
    if (c.key === "in_database") x.inputs = { ...c.inputs, domain: "{{lookup_company_data}}?.row?.use_domain" };
    return x;
  });
  return { columns: out, problems };
}

/**
 * Each gated column is its original's run condition, compiled exactly as
 * without the gate, then the gate: the keys of those that are not. Reads keys
 * only, so a failing check prints no original text.
 */
function gateProblems(originals, compiled) {
  const own = refMap(originals, "people", PEOPLE_REFS);
  const byKey = new Map(compiled.map((c) => [c.key, c]));
  const bad = [];
  for (const spec of PEOPLE_COLUMNS) {
    const gate = UPLOAD_AREA_GATED.includes(spec.key) ? UPLOAD_SPEND_GATE : UPLOAD_NEVER.includes(spec.key) ? NOT_UPLOAD_ROW : null;
    if (!gate) continue;
    const plain = compileColumn({ ...spec, changes: (spec.changes ?? []).filter((c) => c.and == null) }, originals, { own });
    if (byKey.get(spec.key)?.run_if !== runIfAnd(plain.run_if, gate)) bad.push(spec.key);
  }
  return bad;
}

async function partW({ bySeq }) {
  section("W1. Upload rows worked by the client's People table: the finders in order, only inside the area and clear of the rules");
  const S = await workSettings();
  net.vendors.findymail.set("Fiona Findy", at("acme", "fiona"));
  net.vendors.prospeo.set("Paul Prospect", at("acme", "paul"));
  net.vendors.anymail.set("Amy Anymail", { email: at("acme", "amy"), validation: "valid" });
  net.vendors.enrichley.set(at("acme", "amy"), { valid: true, result: "valid" });
  net.vendors.prospeo.set(LEE_IN, at("acme", "lee"));
  const led0 = await ledger();
  const w = {};
  for (const seq of [0, 1, 2, 3, 4, 5, 6, 9]) {
    const reqs = net.requests.length;
    const r = await workRow(pool, net, bySeq[seq], { env: KEYS, settings: S });
    w[seq] = { ...r, asked: net.requests.slice(reqs).map((x) => `${x.vendor}${x.body?.data?.linkedin_url || x.body?.linkedin_url ? " by LinkedIn" : ""}`) };
  }
  const brief = (r) => ({ status: r.status, outcome: r.values.person_outcome, email: r.values.use_work_email ?? null, asked: r.asked });
  const note = (r, k) => r.cell(k)?.note ?? `${r.cell(k)?.status}`;
  check("Findymail by name first: found, Approved email; Prospeo and Anymail Finder then don't run",
    w[0].status === "done" && w[0].values.person_outcome === APPROVED_OUTCOME && w[0].values.use_work_email === at("acme", "fiona") &&
      JSON.stringify(w[0].asked) === '["findymail"]' && note(w[0], "find_work_email_prospeo") === "Run condition not met",
    JSON.stringify(brief(w[0])));
  check("Findymail found none: Prospeo by name next, found", w[1].values.person_outcome === APPROVED_OUTCOME && w[1].values.use_work_email === at("acme", "paul") && JSON.stringify(w[1].asked) === '["findymail","prospeo"]', JSON.stringify(brief(w[1])));
  check("neither: Anymail Finder by name, and Enrichley on its address, in that order", w[2].values.person_outcome === APPROVED_OUTCOME && w[2].values.use_work_email === at("acme", "amy") &&
    JSON.stringify(w[2].asked) === '["findymail","prospeo","anymail","enrichley"]', JSON.stringify(brief(w[2])));
  check("a LinkedIn link and no website: Prospeo by LinkedIn; Findymail by LinkedIn never runs on an upload row (its condition needs the company row)",
    w[3].values.person_outcome === APPROVED_OUTCOME && w[3].values.use_work_email === at("acme", "lee") && JSON.stringify(w[3].asked) === '["prospeo by LinkedIn"]' &&
      note(w[3], "find_work_email_from_linkedin_url_findymail") === "Run condition not met" && note(w[3], "find_work_email_findymail") === "Run condition not met",
    JSON.stringify(brief(w[3])));
  check("nobody finds her: the three finders by name asked once each, and the row is done, No email yet, kept in the table",
    w[4].status === "done" && w[4].values.person_outcome === "No email yet" && JSON.stringify(w[4].asked) === '["findymail","prospeo","anymail"]' && (await statusOf(bySeq[4])) === "done",
    JSON.stringify(brief(w[4])));
  const finders = ["find_work_email_findymail", "find_work_email_prospeo", "find_work_email_anymail_finder", "find_work_email_and_enrich_person_from_linkedin_url"];
  check("outside the client's area: no finder runs, nothing is paid, Outside the client's area",
    w[5].values.person_outcome === "Outside the client's area" && w[5].asked.length === 0 && spent(w[5].paid) === 0 && finders.every((k) => note(w[5], k) === "Run condition not met"),
    JSON.stringify(brief(w[5])));
  check("a company the client's rules exclude: no finder runs, nothing is paid, Excluded by the client's rules",
    w[6].values.person_outcome === "Excluded by the client's rules" && w[6].asked.length === 0 && spent(w[6].paid) === 0 && finders.every((k) => note(w[6], k) === "Run condition not met"),
    JSON.stringify(brief(w[6])));
  check("a row with nothing to search on: no call, and no place to put it in the area", w[9].values.person_outcome === "Outside the client's area" && spent(w[9].paid) === 0, JSON.stringify(brief(w[9])));
  const all8 = [0, 1, 2, 3, 4, 5, 6, 9].map((q) => w[q]);
  check("Current Employer never runs on an upload row (its switch on, OpenAI's key held): Run condition not met; no OpenAI, Reoon or DNS call on any of them",
    all8.every((r) => note(r, "current_employer") === "Run condition not met" && note(r, "reoon_validation") === "Run condition not met" && !r.paid.openai && !r.paid.reoon && !r.paid.dns),
    JSON.stringify(all8.map((r) => [note(r, "current_employer"), note(r, "reoon_validation"), r.paid.openai, r.paid.reoon, r.paid.dns])));
  check("personalisation on for the client: its steps never run on an approved upload row either",
    [0, 1, 2, 3].every((q) => ["email_provider_check_api", "claygent", "question_ai"].every((k) => note(w[q], k) === "Run condition not met")),
    JSON.stringify([0, 1, 2, 3].map((q) => ["email_provider_check_api", "claygent", "question_ai"].map((k) => note(w[q], k)))));
  check("the Companies tab never takes an upload row: its summary is not written", all8.every((r) => r.projected?.written === false && r.projected.why === "An upload's row") &&
    (await one(`SELECT count(*)::int AS n FROM enrich_contacts WHERE row_id = ANY($1::bigint[])`, [Object.values(bySeq)])).n === 0);
  const led1 = await ledger();
  check("each call counted under its vendor's daily cap: Findymail 4, Prospeo 4, Anymail Finder 2, Enrichley 1",
    led1.findymail_calls - led0.findymail_calls === 4 && led1.prospeo_calls - led0.prospeo_calls === 4 && led1.anymail_finder_calls - led0.anymail_finder_calls === 2 &&
      led1.enrichley_calls - led0.enrichley_calls === 1, JSON.stringify({ led0, led1 }));

  section("W2. Caps at 0: an upload row waits, with no call");
  const S0 = await workSettings({ room: 0 });
  const ledZ = await ledger();
  const wes = await workRow(pool, net, bySeq[8], { env: KEYS, settings: S0 });
  check("no vendor cap set: Findymail waits with no call (No daily cap is set), and the row waits",
    wes.status === "waiting" && wes.cell("find_work_email_findymail")?.status === "needs_key" && wes.cell("find_work_email_findymail").note === CAP_NOT_SET.findymail_calls &&
      spent(wes.paid) === 0 && JSON.stringify(await ledger()) === JSON.stringify(ledZ) && (await statusOf(bySeq[8])) === "waiting",
    JSON.stringify({ status: wes.status, cell: wes.cell("find_work_email_findymail") }));

  section("W3. The gates, compiled from the made-up originals, change nothing for an AI Ark row");
  const fx = originalsMap(originalRows(fixtureSeedExports(), { variant: variantName(UA) }));
  const gated = order(compileTemplates(fx).people.map((c) => ({ ...c })));
  const bad = gateProblems(fx, gated);
  const plain = withoutGates(gated);
  check(`each of the ${UPLOAD_AREA_GATED.length + UPLOAD_NEVER.length} gated steps is its original's run condition, unchanged, and then its gate`, bad.length === 0 && plain.problems.length === 0, [...bad, ...plain.problems].join(", "));
  const pos = new Map(gated.map((c, i) => [c.key, i]));
  const early = UPLOAD_AREA_GATED.filter((k) => !(pos.get("in_area") < pos.get(k) && pos.get("rule_match") < pos.get(k)));
  check("in dependency order the area and the rules come before every step they gate", early.length === 0, early.join(", "));
  const aiark = (first, last, { email = "", stage = "bought" } = {}) => ({
    find_people_from_linkedin_company_url: {
      name: `${first} ${last}`, last_name: last, latest_experience_title: "Office Manager", latest_experience_company: "",
      url: `https://linkedin.${HOST}/in/${first.toLowerCase()}-${RUN}`, location_name: "Springfield, Illinois, United States", domain: dom("aiark"),
    },
    email, client_tag: UA, company_website: dom("aiark"), written_city: "Springfield", written_state: "IL", found_by: "aiark", stage, track: "operations", rank: "0",
    person_first_name: first, person_last_name: last, person_country: "US", person_aiark_id: `uptest-${first.toLowerCase()}-${RUN}`, source: "AI Ark people run",
  });
  net.reoon.set(at("aiark", "ada"), "safe");
  net.openai.set("P27|Ada Aiark", { company: `Aiark Co ${RUN}`, confidence: "high", reasoning: "", website: dom("aiark") });
  net.openai.set("P27|Abe Aiark", { company: `Aiark Co ${RUN}`, confidence: "high", reasoning: "", website: dom("aiark") });
  net.vendors.findymail.set("Abe Aiark", at("aiark", "abe"));
  const same = async (inputs) => {
    const a = await runInMemory(gated, inputs, { settings: S });
    const b = await runInMemory(plain.columns, inputs, { settings: S });
    const keys = [...new Set([...a.cells.keys(), ...b.cells.keys()])];
    const differ = keys.filter((k) => {
      const x = a.cells.get(k);
      const y = b.cells.get(k);
      return x?.status !== y?.status || stable(x?.value) !== stable(y?.value) || (x?.display ?? null) !== (y?.display ?? null) || (x?.note ?? null) !== (y?.note ?? null);
    });
    const calls = PAID.filter((k) => a.paid[k] !== b.paid[k]);
    const sorted = (list) => list.map((x) => JSON.stringify(x)).sort().join("\n");
    const sent = sorted(a.requests.map((r) => [r.vendor, r.path, r.body])) === sorted(b.requests.map((r) => [r.vendor, r.path, r.body])) && sorted(a.asked) === sorted(b.asked);
    return { a, b, differ, calls, sent };
  };
  const ada = await same(aiark("Ada", "Aiark", { email: at("aiark", "ada") }));
  check("an AI Ark person with an email: every cell, every call and every request the same with and without the gates (Reoon, Current Employer, personalisation all ran)",
    ada.differ.length === 0 && ada.calls.length === 0 && ada.sent && ada.a.paid.reoon === 1 && ada.a.paid.openai >= 2 && ada.a.paid.dns === 1 && ada.a.values.person_outcome === APPROVED_OUTCOME,
    JSON.stringify({ differ: ada.differ, calls: ada.calls, sent: ada.sent, paid: ada.a.paid, outcome: ada.a.values.person_outcome }));
  const abe = await same(aiark("Abe", "Aiark", { stage: "no_email" }));
  check("an AI Ark person with no email: the same, with Findymail finding him",
    abe.differ.length === 0 && abe.calls.length === 0 && abe.sent && abe.a.paid.findymail === 1 && abe.a.values.use_work_email === at("aiark", "abe"),
    JSON.stringify({ differ: abe.differ, calls: abe.calls, sent: abe.sent, paid: abe.a.paid }));
  net.vendors.findymail.set("Gail Gated", at("acme", "gail"));
  net.vendors.findymail.set("Olaf Outside", at("acme", "olaf"));
  const gail = uploadInputs(person("Gail", "Gated"));
  const olaf = uploadInputs(person("Olaf", "Outside", { city: "Bismarck", state: "ND" }));
  const gG = await runInMemory(gated, gail, { settings: S });
  const gP = await runInMemory(plain.columns, gail, { settings: S });
  const oG = await runInMemory(gated, olaf, { settings: S });
  const oP = await runInMemory(plain.columns, olaf, { settings: S });
  check("the gates are what stop the spend on an upload row: without them Current Employer and personalisation ran on an approved one, and Findymail on one outside the area",
    gG.paid.findymail === 1 && !gG.paid.openai && !gG.paid.dns && gP.paid.openai >= 1 && gP.paid.dns === 1 && spent(oG.paid) === 0 && oP.paid.findymail === 1,
    JSON.stringify({ gated: gG.paid, plain: gP.paid, outsideGated: oG.paid, outsidePlain: oP.paid }));

  section("W4. in_database's domain on both kinds of row");
  const HELD = dom("held");
  await pool.query(`INSERT INTO leads (email, first_name, last_name, company) VALUES ($1, 'Jane', 'Doe', 'Somewhere Else Uptest')`, [`jane.doe@${HELD}`]);
  const { rows: [co] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, $2, 'done') RETURNING id`, [tables[UA].companies, `test:${RUN}:company`]);
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) VALUES ($1, 'use_domain', $2, 'done', $3::jsonb), ($1, 'company', $2, 'done', $4::jsonb)`,
    [co.id, tables[UA].companies, JSON.stringify(HELD), JSON.stringify(`Held Co ${RUN}`)]
  );
  // Everything switched off and no key held: only the free checks run.
  const SW = settingsWith({});
  const jane = (over) => ({ ...aiark("Jane", "Doe"), company_website: HELD, written_company: `Held Co ${RUN}`, ...over });
  const asUpload = await runInMemory(gated, uploadInputs(person("Jane", "Doe", { company: `Held Co ${RUN}`, site: HELD })), { env: {}, settings: SW });
  const noCompany = await runInMemory(gated, jane({}), { env: {}, settings: SW });
  const withCompany = await runInMemory(gated, jane({ company_row: String(co.id) }), { env: {}, settings: SW });
  const found = (r) => ({ lead: Boolean(r.values.in_database?.lead_id), on: r.values.in_database?.matched_on ?? null, outcome: r.values.person_outcome });
  check("an upload row: its own website's domain, so the likely address finds the lead; Already in the database, no finder",
    found(asUpload).lead && found(asUpload).on === "likely address" && asUpload.values.person_outcome === "Already in the database" && asUpload.values.safe_to_run === false,
    JSON.stringify(found(asUpload)));
  check("an AI Ark row without a company row: no domain, exactly as before 130 (its own website not read)", !found(noCompany).lead && noCompany.values.safe_to_run === true, JSON.stringify(found(noCompany)));
  check("an AI Ark row with a company row: the company row's domain, as before 130", found(withCompany).lead && found(withCompany).on === "likely address", JSON.stringify(found(withCompany)));

  section("W5. The local default originals, by structure and in memory (no original text is printed)");
  let def = null;
  try {
    def = await loadOriginals(pool, "default");
  } catch (e) {
    if (!(e instanceof OriginalsMissing)) throw e;
  }
  check("the default originals are loaded in this database (test-people part C needs them too)", Boolean(def));
  if (def) {
    const dcols = order(compileTemplates(def).people.map((c) => ({ ...c })));
    const dbad = gateProblems(def, dcols);
    const dpos = new Map(dcols.map((c, i) => [c.key, i]));
    const dearly = UPLOAD_AREA_GATED.filter((k) => !(dpos.get("in_area") < dpos.get(k) && dpos.get("rule_match") < dpos.get(k)));
    check("compiled with the gates (no loop): each gated step its original's run condition then its gate, the area and the rules before them",
      dbad.length === 0 && dearly.length === 0, [...dbad, ...dearly].join(", "));
    const status = (r, keys) => Object.fromEntries(keys.map((k) => [k, r.cells.get(k)?.status ?? "none"]));
    const SHOW = ["in_area", "rule_match", "safe_to_run", "find_work_email_findymail", "find_work_email_prospeo", "use_work_email", "current_employer", "reoon_validation"];
    net.vendors.findymail.set("Dina Default", at("acme", "dina"));
    const inside = await runInMemory(dcols, uploadInputs(person("Dina", "Default"), UB), { tag: UB, variant: "default", settings: S });
    const outside = await runInMemory(dcols, uploadInputs(person("Dirk", "Default", { city: "Bismarck", state: "ND" }), UB), { tag: UB, variant: "default", settings: S });
    const fmReq = inside.requests.find((r) => r.vendor === "findymail");
    check("an upload row worked by them inside the area: no cell in error, Findymail asked once by name and domain, nothing else paid",
      inside.errors === 0 && inside.paid.findymail === 1 && spent(inside.paid) === 1 && fmReq?.body?.name === "Dina Default" && fmReq.body.domain === dom("acme"),
      JSON.stringify({ errors: [...inside.cells].filter(([, c]) => c.status === "error").map(([k]) => k), paid: inside.paid, status: status(inside, SHOW) }));
    check("... and outside it: no cell in error, nothing paid",
      outside.errors === 0 && spent(outside.paid) === 0 && outside.cells.get("in_area")?.value === false,
      JSON.stringify({ errors: [...outside.cells].filter(([, c]) => c.status === "error").map(([k]) => k), paid: outside.paid, status: status(outside, SHOW) }));
  }
}

// ── F. Found emails ─────────────────────────────────────────────────────────

const json = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: typeof body === "string" ? {} : { "content-type": "application/json" } });

async function partF({ main, bySeq }) {
  section("F1. The worker's config for the hand-off");
  const MADE_UP_KEY = `uptest-${"k".repeat(40)}`;
  const base = `https://web.${HOST}/some/path?x=1`;
  const cfg = foundAutoConfig({ AIARK_AUTO_ADD_URL: ` ${base} `, AIARK_AUTO_ADD_KEY: ` ${MADE_UP_KEY} ` });
  check("the auto-add address's origin and /api/uploads/found/auto, with the auto-add key",
    cfg?.url === `https://web.${HOST}${FOUND_AUTO_PATH}` && cfg.key === MADE_UP_KEY && FOUND_AUTO_PATH === "/api/uploads/found/auto", JSON.stringify(cfg));
  check("off without either, with a key under 32 characters, or with an address that is not one; off here (no key in this run's environment)",
    foundAutoConfig({}) === null && foundAutoConfig({ AIARK_AUTO_ADD_URL: base }) === null && foundAutoConfig({ AIARK_AUTO_ADD_KEY: MADE_UP_KEY }) === null &&
      foundAutoConfig({ AIARK_AUTO_ADD_URL: base, AIARK_AUTO_ADD_KEY: "k".repeat(31) }) === null && foundAutoConfig({ AIARK_AUTO_ADD_URL: "not an address", AIARK_AUTO_ADD_KEY: MADE_UP_KEY }) === null &&
      foundAutoConfig() === null);

  section("F2. Its request, against stand-ins: never throws");
  const seen = [];
  const answers = {
    taken: await requestFound(cfg, main.id, async (u, init) => { seen.push({ u, init }); return json(202, { batchId: null, adding: 0, settled: 0 }); }),
    busy: await requestFound(cfg, main.id, async () => json(409, { error: "A round of this upload is running" })),
    broken: await requestFound(cfg, main.id, async () => json(500, "<html>made-up failure</html>")),
    refused: await requestFound(cfg, main.id, async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); }),
    slow: await requestFound(cfg, main.id, async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }),
    nothing: await requestFound(cfg, main.id, async () => undefined),
    noConfig: await requestFound(null, main.id, async () => json(202, {})),
  };
  const r = seen[0];
  check("POST, JSON, the key as a Bearer token, the body { batch } only, and a time limit",
    r?.u === cfg.url && r.init.method === "POST" && r.init.headers.authorization === `Bearer ${MADE_UP_KEY}` && r.init.headers["content-type"] === "application/json" &&
      r.init.body === JSON.stringify({ batch: main.id }) && r.init.signal instanceof AbortSignal,
    JSON.stringify({ u: r?.u, method: r?.init?.method, body: r?.init?.body }));
  check("answers: taken, refused with the route's words, an error with none, no connection, no answer in time, nothing usable, no config: each comes back, none throws",
    answers.taken.ok && answers.taken.status === 202 && answers.taken.why === null &&
      !answers.busy.ok && answers.busy.status === 409 && answers.busy.why === "A round of this upload is running" &&
      !answers.broken.ok && answers.broken.status === 500 && answers.broken.why === "no reason given" &&
      !answers.refused.ok && answers.refused.status === null && answers.refused.why === "ECONNREFUSED" &&
      !answers.slow.ok && answers.slow.why === "no answer in time" && !answers.nothing.ok && !answers.noConfig.ok,
    JSON.stringify(answers));

  section("F3. The hand-off: asked once per upload, each found person taken once, with the right fields");
  const p = await upOf(main.id);
  const web = { mode: "error", requests: [], taken: new Map(), rounds: [] };
  // What the web app's round does first (src/lib/uploads/found.ts beginFound): take the people, make the round's batch, mark each person running.
  const takeRound = async (batchId) => {
    const up = await one(`SELECT u.filename, u.add_tags, p.table_id, p.source_id, p.client_tag FROM upload_batches u JOIN upload_people p ON p.batch_id = u.id WHERE u.id = $1`, [batchId]);
    const people = (await pool.query(FOUND_TAKE_SQL, [up.table_id, up.source_id, FOUND_ROUND_MAX, false])).rows;
    if (!people.length) return { round: null, people };
    const round = (await one(
      `INSERT INTO upload_batches (filename, total_rows, status, batch_type, source_label, source_batch_id, add_tags, override_fields)
       VALUES ($1, $2, 'processing', 'leads', $3, $4, $5, '{}') RETURNING id`,
      [foundBatchFilename(up.filename), people.length, FOUND_SOURCE_LABEL, batchId, foundTags(up.add_tags, up.client_tag)]
    )).id;
    for (const x of people) {
      await pool.query(
        `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) VALUES ($1, $2, $3, 'running', $4::jsonb)
         ON CONFLICT (row_id, column_key) DO UPDATE SET status = 'running', value = EXCLUDED.value`,
        [x.row_id, ADD_COLUMN, up.table_id, JSON.stringify({ batch_id: round })]
      );
    }
    return { round, people };
  };
  const finishRound = async (round) => {
    await pool.query(`UPDATE enrich_cells SET status = 'done', value = jsonb_build_object('added', true, 'batch_id', $2::text) WHERE column_key = $1 AND value->>'batch_id' = $2`, [ADD_COLUMN, round]);
    await pool.query(`UPDATE upload_batches SET status = 'complete', completed_at = now() WHERE id = $1`, [round]);
  };
  const webFetch = async (u, init) => {
    const body = JSON.parse(init.body);
    web.requests.push({ u, method: init.method, auth: init.headers.authorization, body });
    if (init.headers.authorization !== `Bearer ${MADE_UP_KEY}`) return json(401, { error: "Unauthorized" });
    if (web.mode === "error") return json(500, { error: "made-up failure" });
    const { round, people } = await takeRound(body.batch);
    for (const x of people) web.taken.set(Number(x.row_id), { n: (web.taken.get(Number(x.row_id))?.n ?? 0) + 1, email: x.email, row_key: x.row_key });
    if (round) web.rounds.push(round);
    return json(202, { batchId: round, adding: people.length, settled: 0 });
  };
  const t0 = Date.now();
  const askedAt = new Map();
  const lines = [];
  const tick = (minutes) => askForFound(pool, { config: cfg, askedAt, now: () => t0 + minutes * 60_000, fetchImpl: webFetch, log: (l) => lines.push(l) });
  const due0 = (await foundDue(pool)).filter((u) => u.batch_id === main.id);
  check("the upload with found people still to add is due, named with its client", due0.length === 1 && due0[0].client_tag === UA, JSON.stringify(due0));
  const addCells = async () => (await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE table_id = $1 AND column_key = $2`, [p.table_id, ADD_COLUMN])).n;
  const a1 = await tick(0);
  check("the web answers an error: one request, nothing marked, the upload still due",
    a1.length === 1 && a1[0].batch_id === main.id && !a1[0].ok && a1[0].status === 500 && a1[0].why === "made-up failure" && (await addCells()) === 0 &&
      (await foundDue(pool)).some((u) => u.batch_id === main.id) && web.requests[0]?.u === cfg.url && JSON.stringify(web.requests[0]?.body) === JSON.stringify({ batch: main.id }),
    JSON.stringify({ a1, req: web.requests[0] }));
  const a2 = await tick(1);
  check("a minute later: not asked again (at most once per upload every 10 minutes)", a2.length === 0 && web.requests.length === 1 && FOUND_EVERY_MS === 600_000, JSON.stringify(a2));
  web.mode = "ok";
  const a3 = await tick(10);
  const takenIds = [...web.taken.keys()].sort((x, y) => x - y);
  const approved = [0, 1, 2, 3].map((q) => bySeq[q]).sort((x, y) => x - y);
  check("10 minutes on: asked again, and the round takes the four approved people, each once",
    a3.length === 1 && a3[0].ok && a3[0].status === 202 && web.requests.length === 2 && JSON.stringify(takenIds) === JSON.stringify(approved) && [...web.taken.values()].every((x) => x.n === 1),
    JSON.stringify({ a3, takenIds, approved }));
  const layout = foundImportLayout(HEADERS, MAPPING);
  const fields = [...web.taken.values()].map((x) => {
    const { seq } = parseUploadRowKey(x.row_key);
    const row = foundImportRow(layout, MAIN[seq], x.email);
    return { seq, email: x.email, first: row[0], last: row[1], company: row[3], address: row[4], city: row[5], validation: row[9] };
  });
  const emails = { 0: at("acme", "fiona"), 1: at("acme", "paul"), 2: at("acme", "amy"), 3: at("acme", "lee") };
  check("each one handed over with their found address (lower case) and their own uploaded cells; the kept-back address's validation left blank",
    fields.length === 4 && fields.every((f) => f.email === emails[f.seq] && f.address === emails[f.seq] && f.first === MAIN[f.seq][0] && f.last === MAIN[f.seq][1] &&
      f.company === MAIN[f.seq][3] && f.city === MAIN[f.seq][5] && f.validation === ""),
    JSON.stringify(fields));
  check("... and the round is a batch of found emails under the upload, with its tags and the client's",
    web.rounds.length === 1 && (await one(`SELECT source_label, source_batch_id, add_tags FROM upload_batches WHERE id = $1`, [web.rounds[0]]))?.source_batch_id === main.id &&
      JSON.stringify((await one(`SELECT add_tags FROM upload_batches WHERE id = $1`, [web.rounds[0]])).add_tags) === JSON.stringify(["uptest_a", "Q4 list"]));
  const a4 = await tick(21);
  check("while the round is under way the upload is not due, so nothing is asked", a4.length === 0 && !(await foundDue(pool)).some((u) => u.batch_id === main.id) && web.requests.length === 2);
  await finishRound(web.rounds[0]);
  const a5 = await tick(32);
  check("once everyone is settled: not due, nothing asked", a5.length === 0 && !(await foundDue(pool)).some((u) => u.batch_id === main.id) && web.requests.length === 2);
  const rest = [4, 5, 6, 8, 9].map((q) => bySeq[q]);
  const restCells = await one(`SELECT count(*)::int AS n FROM enrich_cells WHERE column_key = $1 AND row_id = ANY($2::bigint[])`, [ADD_COLUMN, rest]);
  const restRows = await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE id = ANY($1::bigint[])`, [rest]);
  check("the people with no approved email were never taken and stay in the table as they are", rest.every((id) => !web.taken.has(id)) && restCells.n === 0 && restRows.n === 5);
  check("a log line for each request", lines.length === 2 && /^found emails of upload [0-9a-f]{8} \(UPTEST_A\): not started, 500: made-up failure$/.test(lines[0]) && /adding started$/.test(lines[1]), JSON.stringify(lines));

  section("F4. A round that died: its people are asked for again");
  const dead = (await one(
    `INSERT INTO upload_batches (filename, total_rows, status, batch_type, source_label, source_batch_id, created_at)
     VALUES ($1, 1, 'processing', 'leads', $2, $3, now() - interval '4 hours') RETURNING id`,
    [foundBatchFilename(main.filename), FOUND_SOURCE_LABEL, main.id]
  )).id;
  await pool.query(`UPDATE enrich_cells SET status = 'running', value = jsonb_build_object('batch_id', $3::text) WHERE row_id = $1 AND column_key = $2`, [bySeq[1], ADD_COLUMN, dead]);
  const dueDead = (await foundDue(pool)).some((u) => u.batch_id === main.id);
  const a6 = await tick(43);
  check("a person left running by a round over 3 hours old makes the upload due again; the next request takes that person again, and nobody else",
    dueDead && a6.length === 1 && a6[0].ok && web.taken.get(bySeq[1])?.n === 2 && [0, 2, 3].every((q) => web.taken.get(bySeq[q])?.n === 1),
    JSON.stringify({ dueDead, a6, taken: [...web.taken].map(([id, x]) => [id, x.n]) }));
}

// ── S. The worker's wiring, the folder script, nothing writing leads ────────

const source = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

async function partS() {
  section("S1. The worker");
  const ws = source("scripts/enrich-worker.mjs");
  check("it offers held_release and upload_people (UPLOAD_CAPABILITY)", /const CAPABILITIES = \[[^\]]*"held_release"[^\]]*UPLOAD_CAPABILITY\];/.test(ws) && UPLOAD_CAPABILITY === "upload_people");
  check("its 60-second block: the stale sweep, the Maps release, the move, the People release, in that order",
    /if \(Date\.now\(\) - lastSweep > 60_000\) \{\s*await reclaimStale\(\);\s*await releaseHeld\(\);\s*await moveUploads\(\);\s*await releaseHeldPeople\(\);\s*lastSweep = Date\.now\(\);/.test(ws));
  check("the move and the People release never throw, and say once that migration 130 is missing (42P01, 42703, 42883)",
    /const UPLOADS_UNREADY = new Set\(\["42P01", "42703", "42883"\]\);/.test(ws) &&
      /async function moveUploads\(\) \{\s*try \{[\s\S]*?await moveUploadRows\(pool, \{ settings, log \}\);[\s\S]*?\} catch \(e\) \{\s*if \(UPLOADS_UNREADY\.has\(e\?\.code\)\) \{\s*if \(!uploadsUnreadyLogged\)/.test(ws) &&
      /async function releaseHeldPeople\(\) \{\s*try \{\s*const \{ released, tables, refused, full \} = await releaseHeldPeopleRows\(pool\);[\s\S]*?\} catch \(e\) \{\s*if \(UPLOADS_UNREADY\.has\(e\?\.code\)\) \{\s*if \(!peopleUnreadyLogged\)/.test(ws));
  check("found emails: a timer every minute, not awaited, off without the auto-add address and key, with a busy flag and the per-upload record",
    /const foundAuto = foundAutoConfig\(env\);/.test(ws) && /async function addFoundEmails\(\) \{\s*if \(!foundAuto \|\| foundBusy\) return;\s*foundBusy = true;/.test(ws) &&
      /await askForFound\(pool, \{ config: foundAuto, askedAt: foundAskedAt, log \}\);/.test(ws) && /\} finally \{\s*foundBusy = false;/.test(ws) &&
      /if \(Date\.now\(\) - lastFound > FOUND_CHECK_MS\) \{\s*lastFound = Date\.now\(\);\s*addFoundEmails\(\);\s*\}/.test(ws) && /const FOUND_CHECK_MS = 60_000;/.test(ws));
  check("its heartbeat says whether found emails are added with no button", /upload_people: \{ found_auto: Boolean\(foundAuto\) \},/.test(ws));
  check("the shapes the other suites read are kept: writeCells, finish and claim (test-support), the AI Ark loop's exit", Boolean(WORKER_SQL.writeCells && WORKER_SQL.finish && WORKER_SQL.claim) &&
    /await runs;[\s\S]*await fits;[\s\S]*await pool\.end\(\)/.test(ws));

  section("S2. The folder script records the tag it stamps");
  const fs = source("scripts/import-csv-folder.mts");
  const m = /`(insert into upload_batches \(filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type, add_tags, override_fields\)\s*values \(\$1, \$2, 'processing', \$3, \$4, \$5, 'leads', \$6, '\{\}'\) returning id)`,\s*\[DRY \? `DRY \$\{name\}` : name, rows\.length, STRATEGY, JSON\.stringify\(mapping\), JSON\.stringify\(headers\), tag \? \[tag\] : \[\]\]/.exec(fs);
  check("its batch insert writes add_tags (the stamped tag, or none) and override_fields (none), dry runs too", Boolean(m));
  if (m) {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const run = async (tag) => (await c.query(`${m[1]}, add_tags, override_fields`, [`${FILE}-folder.csv`, 3, "merge", JSON.stringify(MAPPING), JSON.stringify(HEADERS), tag ? [tag] : []])).rows[0];
      const tagged = await run(UA);
      const untagged = await run(null);
      check("... and the statement works on this database: [the tag] and {} stored; no tag, an empty list",
        JSON.stringify(tagged.add_tags) === JSON.stringify([UA]) && JSON.stringify(tagged.override_fields) === "[]" && JSON.stringify(untagged.add_tags) === "[]",
        JSON.stringify({ tagged, untagged }));
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  }

  section("S3. Nothing here writes leads or reads the upload code");
  const files = ["scripts/lib/enrich/upload-move.mjs", "scripts/lib/enrich/upload-found.mjs", "scripts/lib/enrich/held.mjs", "scripts/lib/enrich/upload-people.mjs", "scripts/enrich-worker.mjs"];
  const bad = files.filter((f) => /\b(INSERT INTO|UPDATE|DELETE FROM)\s+leads\b|from\(["']leads["']\)/i.test(source(f)) || /from\s+["'][^"']*src\/lib\/uploads\//.test(source(f)));
  check("the move, the releases, the hand-off and the worker never write leads, and import nothing from src/lib/uploads", bad.length === 0, bad.join(", "));
  const pc = await projectContact(pool, {
    rowId: 0, claimToken: randomUUID(), tableId: tables[UA].people, clientTag: UA, kind: "person",
    values: { found_by: "upload", company_row: "12", person_outcome: APPROVED_OUTCOME, use_work_email: at("acme", "x") },
  });
  check("projectContact writes nothing for an upload's row, even one that names a company row", pc.written === false && pc.listed === null && pc.why === "An upload's row", JSON.stringify(pc));
}

// ── Run ─────────────────────────────────────────────────────────────────────

let spendBefore = null;
const baseline = { leads: 0 };

async function cleanup() {
  const tbl = (await all(`SELECT id FROM enrich_tables WHERE client_tag = ANY($1::text[])`, [TAGS])).map((r) => r.id);
  await pool.query(`DELETE FROM upload_batches WHERE filename LIKE $1`, [`%${PREFIX}%`]);
  await pool.query(`DELETE FROM enrich_memory WHERE client_tag = ANY($1::text[]) OR table_id = ANY($2::uuid[]) OR key LIKE $3`, [TAGS, tbl, `%.${HOST}%`]);
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tbl]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tbl]);
  await pool.query(`DELETE FROM enrich_originals WHERE variant = ANY($1::text[])`, [VARIANTS]);
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[])`, [TAGS]);
  if (switchesBefore) {
    for (const key of SWITCHES) {
      const b = switchesBefore[key];
      if (b.exists) await pool.query(`UPDATE enrich_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1`, [key, JSON.stringify(b.value), b.updated_by]);
      else await pool.query(`DELETE FROM enrich_settings WHERE key = $1`, [key]);
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
    `SELECT to_regprocedure('public.fn_enrich_company_switch_on(text)') IS NOT NULL AS m129,
            to_regclass('public.upload_people') IS NOT NULL AND to_regprocedure('public.fn_enrich_held_switch_on(uuid)') IS NOT NULL AS m130`
  );
  if (!ready.m129 || !ready.m130) throw new Error("migrations 129 and 130 are not both in this database");
  const worker = await one(`SELECT count(*)::int AS n FROM enrich_worker_state WHERE last_seen > now() - interval '30 seconds' AND NOT coalesce((info->>'stopped')::boolean, false)`);
  if (worker.n) throw new Error("an enrichment worker's heartbeat is fresh: stop it first");
  await cleanup();
  switchesBefore = {};
  for (const key of SWITCHES) {
    const s = await one(`SELECT value, updated_by FROM enrich_settings WHERE key = $1`, [key]);
    switchesBefore[key] = { exists: Boolean(s), value: s?.value ?? null, updated_by: s?.updated_by ?? null };
  }
  spendBefore = await all(`SELECT day::text AS day, kind, used::text AS used, updated_at FROM enrich_spend_daily ORDER BY day, kind`);
  BASE_ROWS = await all(`SELECT key, value FROM enrich_settings`);
  // The move and the releases act on every client and upload, so the run stops unless nothing else is in their way.
  const base = settingsFrom(BASE_ROWS);
  const others = await one(
    `SELECT (SELECT count(*)::int FROM enrich_rows WHERE run_status = 'held') AS held,
            (SELECT count(*)::int FROM upload_people) AS upload_people,
            (SELECT count(*)::int FROM upload_batches b
              WHERE b.batch_type = 'leads' AND b.source_label IS NULL AND b.field_mapping IS NOT NULL AND b.add_tags IS NOT NULL
                AND EXISTS (SELECT 1 FROM upload_holdbacks h WHERE h.batch_id = b.id)) AS uploads`
  );
  check("before the run: no held row anywhere, no client on the company_pipeline or people_pipeline list, no upload moving or waiting to be decided",
    others.held === 0 && others.upload_people === 0 && others.uploads === 0 && base.company_pipeline.tags.length === 0 && base.people_pipeline.tags.length === 0,
    JSON.stringify({ ...others, company: base.company_pipeline.tags, people: base.people_pipeline.tags }));
  if (others.held || others.upload_people || others.uploads || base.company_pipeline.tags.length || base.people_pipeline.tags.length) {
    throw new Error("not run: another client is on a switch, or held rows or uploads are in the way here");
  }
  baseline.leads = (await one(`SELECT count(*)::int AS n FROM leads`)).n;
  ({ insertRows } = await routeLoader(randomUUID()).srcModule("lib/enrich/insert-rows.ts"));
  for (const t of TAGS) await addClient(t);
  resetClientChecks();
  resetCompanyActions();
  const m = await partM();
  const r = await partR(m);
  await partW({ ...m, ...r });
  await partF({ ...m, ...r });
  await partS();
  const leadsNow = (await one(`SELECT count(*)::int AS n FROM leads`)).n;
  check("leads: only the one made-up lead this test wrote itself", leadsNow === baseline.leads + 1, `${leadsNow - baseline.leads} added`);
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
            (SELECT count(*)::int FROM upload_batches WHERE filename LIKE $3) AS batches,
            (SELECT count(*)::int FROM upload_people) AS upload_people,
            (SELECT count(*)::int FROM enrich_rows WHERE run_status = 'held') AS held,
            (SELECT count(*)::int FROM enrich_memory WHERE client_tag = ANY($1::text[])) AS memory,
            (SELECT count(*)::int FROM leads WHERE email LIKE $4) AS leads`,
    [TAGS, VARIANTS, `%${PREFIX}%`, `%.${HOST}`]
  );
  let switchesBack = true;
  if (switchesBefore) {
    for (const key of SWITCHES) {
      const s = await one(`SELECT value FROM enrich_settings WHERE key = $1`, [key]);
      const b = switchesBefore[key];
      if (b.exists ? JSON.stringify(s?.value) !== JSON.stringify(b.value) : Boolean(s)) switchesBack = false;
    }
  }
  const spendBack = !spendBefore || JSON.stringify(await spendNow()) === JSON.stringify(spendBefore.map(({ day, kind, used }) => ({ day, kind, used })));
  const clean = Object.values(left).every((n) => n === 0) && switchesBack && spendBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, switchesBack, spendBack })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
