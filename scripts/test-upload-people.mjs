#!/usr/bin/env node
// An upload's no-email rows in the client's People table (migration 130).
// LOCAL DATABASE ONLY: made-up clients UPTEST_A and UPTEST_B, their pipeline
// tables, a made-up upload with its no-email rows, and made-up people under
// .uptest.example. For the run it also writes the company_pipeline and
// people_pipeline switches; both are put back at the end, and everything else
// it made is removed. No other test's tags are touched.
//
//   node --env-file=.env.local scripts/test-upload-people.mjs
//
// Stop the enrichment worker first, and don't start it for this. Migrations
// 129 and 130 must be in the local database. Nothing here reaches a network:
// fetch is replaced and refuses every address, the import runs with no mail
// provider lookup, and no paid key is read. The import's TypeScript runs for
// real through the TypeScript loader (scripts/fixtures/test-support.mjs).
//
//   A. the shared module (scripts/lib/enrich/upload-people.mjs), on its own:
//      which client an upload goes to, its tags, the row key, a kept-back row
//      as People inputs, a found person as an import row, and the same rules
//      as the TypeScript import
//   B. migration 130: its objects, the people switch check against flagOn(),
//      and the release guard for each kind of table
//   C. the found-email SQL: the People rows still to add, and the uploads
//      with some (the index it is built for)
//   D. the same import path: a found person through the real import engine,
//      next to the same row uploaded with that email (dry runs, rolled back)

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checker, dropPaidKeys, installNet, localDatabaseUrl, routeLoader } from "./fixtures/test-support.mjs";
import {
  ADD_COLUMN, ADDRESS_FIELDS, APPROVED_OUTCOME, BLANKISH_VALUES, FOUND_DUE_SQL, FOUND_SOURCE_LABEL, FOUND_TAKE_SQL,
  NOT_SENT_WHY, NOT_UPLOAD_ROW, UPLOAD_AREA_GATED, UPLOAD_FOUND_BY, UPLOAD_NEVER, UPLOAD_SOURCE_KIND, UPLOAD_SPEND_GATE,
  UPLOAD_STAGE, approvedCell, companyAsUploaded, foundBatchFilename, foundImportLayout, foundImportRow, foundTags,
  isUsableAddress, parseUploadRowKey, peopleSearchText, routeTagOf, uploadPeopleInputs, uploadRowKey, uploadSourceLabel,
} from "./lib/enrich/upload-people.mjs";
import { ensureTable } from "./lib/enrich/templates.mjs";
import { settingsFrom } from "./lib/enrich/settings.mjs";
import { PEOPLE_COLUMNS, PEOPLE_INPUT_KEYS } from "./lib/enrich/people-template.mjs";
import { companyAsHeld } from "./lib/enrich/client-checks.mjs";
import { HELD_REFUSED, releaseHeldRows } from "./lib/enrich/held.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

const UA = "UPTEST_A";
const UB = "UPTEST_B";
const TAGS = [UA, UB];
const RUN = randomUUID().slice(0, 6);
const HOST = "uptest.example";
const FILE_PREFIX = `uptest-${RUN}`;
const SWITCHES = ["company_pipeline", "people_pipeline"];

/** The TypeScript the checks compare with, compiled by the test loader. */
let TS = null;

/** A statement's refusal ({ code, message }), or null when it went through. */
async function refusal(sql, params) {
  try {
    await pool.query(sql, params);
    return null;
  } catch (e) {
    return { code: e.code, message: e.message };
  }
}

/** The two switches as they were before the run ({ key: { exists, value, updated_by } }), put back at the end. */
let switchesBefore = null;
async function setSwitch(key, value) {
  await pool.query(
    `INSERT INTO enrich_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, JSON.stringify({ ...(switchesBefore?.[key]?.value ?? {}), ...value })]
  );
}

// ── A. The shared module ────────────────────────────────────────────────────

const HEADERS = ["First Name", "Last Name", "Job Title", "Company Name", "Email", "City", "State", "Website", "LinkedIn", "Validation", "Provider", "Notes", "Second Title"];
const MAPPING = { 0: "first_name", 1: "last_name", 2: "title", 3: "company", 4: "email", 5: "city", 6: "state", 7: "domain", 8: "person_linkedin", 9: "validation_status", 10: "esp", 12: "title" };
const RAW = [
  "Jane", "Doe", "Office  Manager", "Acme Uptest | The best cleaning", "N/A", "Springfield", "Illinois",
  `https://www.acme-${RUN}.${HOST}/about?x=1`, "https://www.linkedin.com/in/jane-doe-uptest", "invalid", "Google", "kept", "--",
];

async function partA() {
  section("A1. Which client's People table an upload goes to");
  const clients = ["UPTEST_A", "UPTEST_B", " uptest_c "];
  const cases = [
    [null, { tag: null, why: "before" }],
    [[], { tag: null, why: "no_tag" }],
    [["  "], { tag: null, why: "no_tag" }],
    [["Q4 list"], { tag: null, why: "not_client" }],
    [["uptest_a", "Q4 list"], { tag: UA, why: null }],
    [["UPTEST_A", " uptest_a "], { tag: UA, why: null }],
    [["UPTEST_C"], { tag: "UPTEST_C", why: null }],
    [["UPTEST_A", "uptest_b"], { tag: null, why: "several" }],
  ];
  const got = cases.map(([tags, want]) => ({ tags, want, got: routeTagOf(tags, clients) }));
  const differ = got.filter((g) => JSON.stringify(g.got) !== JSON.stringify(g.want));
  check(`routeTagOf: the one client tag among the upload's tags, else why not (${cases.length} cases)`, differ.length === 0, JSON.stringify(differ));
  check("... and every not_sent reason has its words", ["no_tag", "not_client", "several"].every((k) => typeof NOT_SENT_WHY[k] === "string" && NOT_SENT_WHY[k].length > 20));
  check("foundTags: the upload's tags first, the client's tag added once, in any case",
    JSON.stringify(foundTags(["uptest_a", "Q4"], UA)) === JSON.stringify(["uptest_a", "Q4"]) &&
      JSON.stringify(foundTags([], UA)) === JSON.stringify([UA]) && JSON.stringify(foundTags(null, UA)) === JSON.stringify([UA]) &&
      JSON.stringify(foundTags([" Q4 ", "q4"], UB)) === JSON.stringify(["Q4", UB]));

  section("A2. The row key");
  const batch = randomUUID();
  const key = uploadRowKey(batch, 41);
  check("upload:<batch id>:<seq>, read back the same", key === `upload:${batch}:41` && JSON.stringify(parseUploadRowKey(key)) === JSON.stringify({ batchId: batch, seq: 41 }));
  const notKeys = [`aiark:${batch}`, `upload:${batch}`, `upload:not-a-uuid:1`, `upload:${batch}:01`, `upload:${batch}:-1`, `upload:${batch}:1.5`, `upload:${batch}:99999999999`, null];
  check("any other key reads as none", notKeys.every((k) => parseUploadRowKey(k) === null), JSON.stringify(notKeys.map(parseUploadRowKey)));
  let threw = 0;
  for (const bad of [[null, 1], [batch, -1], [batch, 1.5], [batch, "x"]]) {
    try {
      uploadRowKey(...bad);
    } catch {
      threw++;
    }
  }
  check("a key is never made without a batch id and a whole seq", threw === 4);

  section("A3. A kept-back row as a People row");
  const inputs = uploadPeopleInputs({ raw: RAW, fieldMapping: MAPPING, clientTag: " uptest_a ", filename: "  my  file.csv " });
  const want = {
    client_tag: UA, found_by: UPLOAD_FOUND_BY, stage: UPLOAD_STAGE, source: "Upload: my file.csv",
    person_first_name: "Jane", person_last_name: "Doe", written_full_name: "Jane Doe", written_title: "Office Manager",
    written_company: "Acme Uptest", company_website: `acme-${RUN}.${HOST}`, written_person_linkedin_url: "https://www.linkedin.com/in/jane-doe-uptest",
    written_city: "Springfield", written_state: "Illinois",
  };
  check("the person, the company and the place, the client's tag, found_by upload, stage uploaded, the Source",
    JSON.stringify(Object.entries(inputs).sort()) === JSON.stringify(Object.entries(want).sort()), JSON.stringify(inputs));
  check("... no email input (the row was kept back for its email), no empty cell, and only keys the People table has as inputs",
    !("email" in inputs) && Object.values(inputs).every((v) => typeof v === "string" && v.length > 0) && Object.keys(inputs).every((k) => PEOPLE_INPUT_KEYS.includes(k)),
    JSON.stringify(Object.keys(inputs).filter((k) => !PEOPLE_INPUT_KEYS.includes(k))));
  check("... a placeholder in the later title column leaves the first; a later real one wins, as normalizeRow reads them",
    uploadPeopleInputs({ raw: RAW.map((v, i) => (i === 12 ? "Head of Facilities" : v)), fieldMapping: MAPPING, clientTag: UA, filename: "f" }).written_title === "Head of Facilities");
  const sparse = uploadPeopleInputs({ raw: ["", "--", "", "", ""], fieldMapping: { 0: "first_name", 1: "last_name", 4: "email" }, clientTag: UA, filename: "" });
  check("a row with nothing but placeholders gives only the row's own facts", JSON.stringify(Object.keys(sparse).sort()) === JSON.stringify(["client_tag", "found_by", "source", "stage"]) && sparse.source === "Upload: a file", JSON.stringify(sparse));
  const extra = uploadPeopleInputs({
    raw: ["Ann", "Lee", "100 Main St", "+1 217 555 0100", "Cleaning", "Office cleaning", "acme.uptest.example"],
    fieldMapping: { 0: "first_name", 1: "last_name", 2: "address", 3: "company_phone", 4: "category", 5: "subcategory", 6: "domain" },
    clientTag: UB, filename: "x.csv",
  });
  check("the address, the company phone and the categories go to the People columns' written values",
    extra.written_company_address === "100 Main St" && extra.written_company_phone_number === "+1 217 555 0100" && extra.written_category === "Cleaning" &&
      extra.written_sub_category === "Office cleaning" && extra.company_website === "acme.uptest.example", JSON.stringify(extra));
  check("the search text is made of the name, title, company, website and place",
    peopleSearchText(inputs) === `jane doe office manager acme uptest acme-${RUN}.${HOST} springfield illinois`, peopleSearchText(inputs));
  check("uploadSourceLabel keeps the Source short and on one line", uploadSourceLabel("a\nb".repeat(400)).length <= 300 && !uploadSourceLabel("a\nb").includes("\n"));

  section("A4. A found person as an import row");
  const layout = foundImportLayout(HEADERS, MAPPING);
  const row = foundImportRow(layout, RAW, "  Jane.Doe@Acme.UPTEST.example ");
  check("the upload's headers and mapping, the found address (lower case) in the email column, the address's own facts blank",
    layout.width === HEADERS.length && !layout.appended && JSON.stringify(layout.emailIdx) === "[4]" && JSON.stringify(layout.clearIdx) === "[9,10]" &&
      row[4] === "jane.doe@acme.uptest.example" && row[9] === "" && row[10] === "" && row[0] === "Jane" && row[11] === "kept" && row.length === HEADERS.length,
    JSON.stringify({ layout, row }));
  const two = foundImportLayout(["E1", "E2", "Name"], { 0: "email", 1: "email", 2: "first_name" });
  check("every column mapped to email gets the address", JSON.stringify(foundImportRow(two, ["", "N/A", "Ann"], "a@b.uptest.example")) === JSON.stringify(["a@b.uptest.example", "a@b.uptest.example", "Ann"]));
  const none = foundImportLayout(["Name", "City"], { 0: "first_name", 1: "city" });
  const noneRow = foundImportRow(none, ["Ann"], "a@b.uptest.example");
  check("an upload that mapped no email column gets an Email column at the end; a short row is padded",
    none.appended && none.width === 3 && none.headers[2] === "Email" && none.fieldMapping[2] === "email" && JSON.stringify(noneRow) === JSON.stringify(["Ann", "", "a@b.uptest.example"]),
    JSON.stringify({ none, noneRow }));
  check("a row longer than the header row is cut to it, as the download cuts it",
    foundImportRow(foundImportLayout(["A"], { 0: "email" }), ["x", "extra", "more"], "a@b.uptest.example").length === 1);
  check("the fields that describe the kept-back address", JSON.stringify(ADDRESS_FIELDS) === JSON.stringify(["validation_status", "is_bounced", "esp", "email_type"]));
  const fname = foundBatchFilename(" my\tfile.csv ", new Date("2026-11-18T09:05:59Z"));
  check("a batch of found emails is named for its upload, with the time", fname === `${FOUND_SOURCE_LABEL} · my file.csv · 2026-11-18 09:05 UTC`, fname);

  section("A5. The same rules as the TypeScript import");
  const constants = await TS.constants;
  const normalize = await TS.normalize;
  const importer = await TS.importer;
  check("BLANKISH_VALUES is src/lib/uploads/constants.ts's list", JSON.stringify(BLANKISH_VALUES) === JSON.stringify(constants.BLANKISH_VALUES), JSON.stringify(constants.BLANKISH_VALUES));
  const addresses = ["a@b.co", " A@B.CO ", "N/A", "--", "none", "a@b", "a b@c.de", "@b.co", "a@b.co.", "x@y.z", "", "there", "jane.doe@acme.uptest.example"];
  const usable = addresses.map((e) => [e, isUsableAddress(e), importer.isImportableEmail(e.trim().toLowerCase())]);
  check(`isUsableAddress agrees with isImportableEmail on ${addresses.length} cells`, usable.every(([, a, b]) => a === b), JSON.stringify(usable.filter(([, a, b]) => a !== b)));
  const companies = ["Acme | Tagline", "  | Acme  Two |", "Plain", "", "   ", "A  B   C", "|"];
  const cut = companies.map((c) => [c, companyAsUploaded(c), normalize.cleanCompanyName(c) ?? "", companyAsHeld(c)]);
  check(`companyAsUploaded cuts a company as cleanCompanyName and the database check do (${companies.length} cases)`, cut.every(([, a, b, c]) => a === b && b === c), JSON.stringify(cut));

  section("A6. The People template's gates on upload rows");
  const byKey = new Map(PEOPLE_COLUMNS.map((c) => [c.key, c]));
  const paid = PEOPLE_COLUMNS.filter((c) => c.key_env || ["ai_web", "reoon_verify", "dns_mx"].includes(c.action)).map((c) => c.key);
  check("every column the gates name is a People action column", [...UPLOAD_AREA_GATED, ...UPLOAD_NEVER].every((k) => byKey.get(k)?.kind === "action"));
  check("every People step that can spend or reach a provider is gated: by area and rules, or never on an upload row",
    paid.every((k) => UPLOAD_AREA_GATED.includes(k) || UPLOAD_NEVER.includes(k)) && paid.length === UPLOAD_AREA_GATED.length + UPLOAD_NEVER.length,
    JSON.stringify(paid.filter((k) => !UPLOAD_AREA_GATED.includes(k) && !UPLOAD_NEVER.includes(k))));
  check("the gates read found_by, and the area gate reads the area and the rules only on an upload row",
    NOT_UPLOAD_ROW === `{{found_by}} !== "upload"` && UPLOAD_SPEND_GATE === `({{found_by}} !== "upload" || ({{in_area}} === true && !{{rule_match}}))`);
  const sql130 = readFileSync(new URL("../supabase/migrations/130_upload_people.sql", import.meta.url), "utf8");
  check("approvedCell() is exactly the approved-email index's terms", sql130.includes(`WHERE ${approvedCell("x").replace(/x\./g, "")};`), approvedCell("x"));
}

// ── B. Migration 130 ────────────────────────────────────────────────────────

const tables = {};
async function partB() {
  section("B1. What 130 made");
  const o = await one(`SELECT
      (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.upload_people'::regclass) AS rls,
      has_table_privilege('anon', 'public.upload_people', 'SELECT') OR has_table_privilege('authenticated', 'public.upload_people', 'SELECT') AS readable,
      has_function_privilege('anon', 'public.fn_enrich_people_switch_on(text)', 'EXECUTE') OR has_function_privilege('authenticated', 'public.fn_enrich_held_switch_on(uuid)', 'EXECUTE') AS callable,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'upload_batches'
         AND column_name IN ('add_tags', 'override_fields', 'source_batch_id')) AS batch_columns,
      (SELECT count(*)::int FROM upload_batches WHERE add_tags IS NOT NULL OR override_fields IS NOT NULL OR source_batch_id IS NOT NULL) AS batches_touched,
      (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'enrich_sources_kind_check') AS kinds`);
  check("upload_people is server-only (RLS on, nothing for anon or authenticated), and so are the two switch functions", o.rls === true && o.readable === false && o.callable === false, JSON.stringify(o));
  check("upload_batches has add_tags, override_fields and source_batch_id, empty on every batch made before", o.batch_columns === 3 && o.batches_touched === 0, JSON.stringify(o));
  check("enrich_sources takes the upload kind, beside the eight before", /'upload'/.test(o.kinds) && ["maps", "csv", "demo", "api", "ai_ark", "registry", "write_to", "linkedin"].every((k) => o.kinds.includes(`'${k}'`)), o.kinds);

  section("B2. The people switch check reads the settings exactly as flagOn(\"people_pipeline\") does");
  const CASES = [
    ["enabled false", { enabled: false, tags: [UA] }, UA, false],
    ["the tag missing", { enabled: true, tags: [UB] }, UA, false],
    ["a lower-case tag in the list", { enabled: true, tags: [UA.toLowerCase()] }, UA, true],
    ["tags not a list", { enabled: true, tags: UA }, UA, false],
    ["enabled as the text \"true\"", { enabled: "true", tags: [UA] }, UA, false],
    ["listed", { enabled: true, tags: [UA] }, UA, true],
    ["asked in lower case, with spaces", { enabled: true, tags: [UA] }, `  ${UA.toLowerCase()} `, true],
    ["padded, among items that are not text", { enabled: true, tags: [7, null, ` ${UA}\t`] }, UA, true],
    ["only \"*\" listed", { enabled: true, tags: ["*"] }, UA, false],
    ["asked for \"*\"", { enabled: true, tags: ["*", UA] }, "*", false],
    ["asked for nothing", { enabled: true, tags: [UA] }, "", false],
    ["no value (null)", null, UA, false],
    ["a list, not an object", [UA], UA, false],
  ];
  const results = [];
  for (const [name, value, tag, expected] of CASES) {
    const js = settingsFrom([{ key: "people_pipeline", value }]).flagOn("people_pipeline", tag);
    const sql = (await one(`SELECT public.fn_enrich_switch_value_on($1::jsonb, $2) AS on`, [JSON.stringify(value), tag])).on;
    results.push({ name, js, sql, expected });
  }
  const differ = results.filter((r) => r.js !== r.sql || r.js !== r.expected);
  check(`flagOn("people_pipeline") and the database agree on all ${CASES.length} cases, each as expected`, differ.length === 0, JSON.stringify(differ));
  await setSwitch("people_pipeline", { enabled: true, tags: [UA] });
  const stored = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
  const live = await one(`SELECT public.fn_enrich_people_switch_on($1) AS a, public.fn_enrich_people_switch_on($2) AS b, public.fn_enrich_company_switch_on($1) AS ca`, [UA, UB]);
  check("fn_enrich_people_switch_on reads the stored switch: on for the listed client, off for the other; company_pipeline stays off",
    live.a === true && live.b === false && live.ca === false && stored.flagOn("people_pipeline", UA) && !stored.flagOn("people_pipeline", UB), JSON.stringify(live));
  await setSwitch("people_pipeline", { enabled: false, tags: [] });

  section("B3. The guard: each kind of table answers to its own switch");
  for (const kind of ["companies", "people", "inboxes"]) tables[kind] = (await ensureTable(pool, UA, kind)).id;
  tables.peopleB = (await ensureTable(pool, UB, "people")).id;
  tables.seeded = (await one(`INSERT INTO enrich_tables (client_tag, kind, name, source_note) VALUES ($1, 'people', 'Hand-seeded test', 'test') RETURNING id`, [UA])).id;
  const held = {};
  for (const [name, id] of Object.entries(tables)) {
    held[name] = Number((await one(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, $2, 'held') RETURNING id`, [id, `test:${RUN}:${name}`])).id);
  }
  const release = (name) => refusal(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [held[name]]);
  const hold = (name) => pool.query(`UPDATE enrich_rows SET run_status = 'held' WHERE id = $1`, [held[name]]);
  const offAll = await Promise.all(Object.keys(held).map(async (n) => [n, await release(n)]));
  const said = Object.fromEntries(offAll.map(([n, r]) => [n, r?.code === HELD_REFUSED ? r.message.replace(/^enrich row \d+ stays held: /, "") : `went through (${JSON.stringify(r)})`]));
  check("both switches off: every held row stays held (23514), and the words name the switch of its table",
    said.companies === "its client is not on the company_pipeline switch" && said.people === "its client is not on the people_pipeline switch" &&
      said.peopleB === "its client is not on the people_pipeline switch" &&
      said.inboxes === "only a Companies (pipeline) or People (pipeline) row is ever released" && said.seeded === said.inboxes,
    JSON.stringify(said));
  await setSwitch("company_pipeline", { enabled: true, tags: [UA] });
  const companyOn = { companies: await release("companies"), people: await release("people"), inboxes: await release("inboxes"), seeded: await release("seeded") };
  check("company_pipeline on for the client: its Companies row is released; its People, inbox and hand-seeded rows stay held",
    companyOn.companies === null && companyOn.people?.code === HELD_REFUSED && /people_pipeline/.test(companyOn.people.message) &&
      companyOn.inboxes?.code === HELD_REFUSED && companyOn.seeded?.code === HELD_REFUSED, JSON.stringify(companyOn));
  await hold("companies");
  await setSwitch("company_pipeline", { enabled: false, tags: [] });
  await setSwitch("people_pipeline", { enabled: true, tags: [UA] });
  const peopleOn = { people: await release("people"), peopleB: await release("peopleB"), companies: await release("companies"), inboxes: await release("inboxes"), seeded: await release("seeded") };
  check("people_pipeline on for the client: its People row is released; the other client's People row and its own Companies row stay held",
    peopleOn.people === null && peopleOn.peopleB?.code === HELD_REFUSED && peopleOn.companies?.code === HELD_REFUSED && /company_pipeline/.test(peopleOn.companies.message) &&
      peopleOn.inboxes?.code === HELD_REFUSED && peopleOn.seeded?.code === HELD_REFUSED, JSON.stringify(peopleOn));
  await hold("people");
  await setSwitch("company_pipeline", { enabled: true, tags: [UA] });
  const bothOn = { inboxes: await release("inboxes"), seeded: await release("seeded") };
  check("both switches on: an inbox row and a hand-seeded table's row are still never released", bothOn.inboxes?.code === HELD_REFUSED && bothOn.seeded?.code === HELD_REFUSED, JSON.stringify(bothOn));
  await setSwitch("company_pipeline", { enabled: false, tags: [] });
  const moved = await refusal(`UPDATE enrich_rows SET table_id = $2, run_status = 'queued' WHERE id = $1`, [held.people, tables.companies]);
  check("a held People row moved into a Companies table and released at once needs that table's switch too (company_pipeline, off)",
    moved?.code === HELD_REFUSED && /company_pipeline/.test(moved.message), JSON.stringify(moved));
  const other = await refusal(`UPDATE enrich_rows SET search_text = 'uptest', attempts = 2 WHERE id = $1`, [held.people]);
  const del = await refusal(`DELETE FROM enrich_rows WHERE id = $1`, [held.seeded]);
  check("another column of a held row may change, and a held row may be deleted", other === null && del === null && (await one(`SELECT run_status FROM enrich_rows WHERE id = $1`, [held.people])).run_status === "held");
  await setSwitch("people_pipeline", { enabled: true, tags: [UA, UB] });
  await setSwitch("company_pipeline", { enabled: true, tags: [UA] });
  const rel = await releaseHeldRows(pool);
  const after = Object.fromEntries((await all(`SELECT id, run_status FROM enrich_rows WHERE id = ANY($1::bigint[])`, [Object.values(held)])).map((r) => [Number(r.id), r.run_status]));
  check("129's release (releaseHeldRows) still takes Companies (pipeline) rows only, both switches on",
    rel.released === 1 && after[held.companies] === "queued" && after[held.people] === "held" && after[held.peopleB] === "held" && after[held.inboxes] === "held",
    JSON.stringify({ rel, after }));
  await setSwitch("people_pipeline", { enabled: false, tags: [] });
  await setSwitch("company_pipeline", { enabled: false, tags: [] });
  await pool.query(`DELETE FROM enrich_rows WHERE id = ANY($1::bigint[])`, [Object.values(held)]);
}

// ── C. The found-email SQL ──────────────────────────────────────────────────

async function partC() {
  section("C1. The People rows of an upload still to add");
  const { rows: [batch] } = await pool.query(
    `INSERT INTO upload_batches (filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type, add_tags, override_fields)
     VALUES ($1, 9, 'complete', 'merge', $2::jsonb, $3::jsonb, 'leads', $4, '{}') RETURNING id`,
    [`${FILE_PREFIX}.csv`, JSON.stringify(MAPPING), JSON.stringify(HEADERS), [UA]]
  );
  const { rows: [source] } = await pool.query(
    `INSERT INTO enrich_sources (table_id, kind, external_id, label) VALUES ($1, $2, $3, $4) RETURNING id`,
    [tables.people, UPLOAD_SOURCE_KIND, batch.id, uploadSourceLabel(`${FILE_PREFIX}.csv`)]
  );
  await pool.query(
    `INSERT INTO upload_people (batch_id, state, client_tag, table_id, source_id, next_seq, moved_rows) VALUES ($1, 'moved', $2, $3, $4, 9, 9)`,
    [batch.id, UA, tables.people, source.id]
  );
  const foundBatch = async (status, hoursAgo) =>
    (await one(
      `INSERT INTO upload_batches (filename, total_rows, status, batch_type, source_label, source_batch_id, created_at)
       VALUES ($1, 1, $2, 'leads', $3, $4, now() - make_interval(hours => $5)) RETURNING id`,
      [`${FILE_PREFIX} found ${status} ${hoursAgo}`, status, FOUND_SOURCE_LABEL, batch.id, hoursAgo]
    )).id;
  const live = await foundBatch("processing", 0);
  const stale = await foundBatch("processing", 4);
  const finished = await foundBatch("complete", 0);
  // seq: [outcome, add_to_database cell, run status]
  const plan = [
    [APPROVED_OUTCOME, null, "done"],                                     // 0 due
    [APPROVED_OUTCOME, ["done", { added: true }], "done"],                // 1 settled
    [APPROVED_OUTCOME, ["running", { batch_id: live }], "done"],          // 2 a live round has it
    [APPROVED_OUTCOME, ["running", { batch_id: stale }], "done"],         // 3 its round died: due
    [APPROVED_OUTCOME, ["error", { batch_id: finished }], "done"],        // 4 not stored: the button only
    ["No email yet", null, "done"],                                       // 5 nothing found
    [APPROVED_OUTCOME, null, "queued"],                                   // 6 being worked again
    [APPROVED_OUTCOME, ["running", { batch_id: finished }], "waiting"],   // 7 its round finished without settling: due
    [APPROVED_OUTCOME, null, "done"],                                     // 8 due, but in another table (below)
  ];
  const ids = [];
  for (const [seq, [outcome, add, status]] of plan.entries()) {
    const table = seq === 8 ? tables.peopleB : tables.people;
    const { rows: [r] } = await pool.query(
      `INSERT INTO enrich_rows (table_id, source_id, row_key, run_status) VALUES ($1, $2, $3, $4) RETURNING id`,
      [table, seq === 8 ? null : source.id, uploadRowKey(batch.id, seq), status]
    );
    ids.push(Number(r.id));
    const cells = [["person_outcome", "done", outcome], ["use_work_email", "done", `  Person${seq}@Acme-${RUN}.${HOST} `]];
    if (add) cells.push([ADD_COLUMN, add[0], add[1]]);
    for (const [k, st, v] of cells) {
      await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) VALUES ($1, $2, $3, $4, $5::jsonb)`, [r.id, k, table, st, JSON.stringify(v)]);
    }
  }
  // An AI Ark person in the same table with an approved email: never an upload's.
  const { rows: [ai] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, $2, 'done') RETURNING id`, [tables.people, `aiark:uptest-${RUN}`]);
  await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) VALUES ($1, 'person_outcome', $2, 'done', $3::jsonb), ($1, 'use_work_email', $2, 'done', '"ai@x.uptest.example"')`, [ai.id, tables.people, JSON.stringify(APPROVED_OUTCOME)]);

  const take = async (limit, retry) => (await pool.query(FOUND_TAKE_SQL, [tables.people, source.id, limit, retry])).rows;
  const seqOf = (rows) => rows.map((r) => parseUploadRowKey(r.row_key)?.seq);
  const auto = await take(100, false);
  check("the worker's rounds take the approved people with no add cell, and those whose round died or finished without settling, oldest first",
    JSON.stringify(seqOf(auto)) === "[0,3,7]", JSON.stringify(seqOf(auto)));
  check("... each with its found address, trimmed and lower case, and its add cell's state",
    auto[0].email === `person0@acme-${RUN}.${HOST}` && auto[1].add_status === "running" && auto[1].add_batch === stale && auto[0].add_status === null, JSON.stringify(auto));
  check("the button also takes the people an earlier round could not store", JSON.stringify(seqOf(await take(100, true))) === "[0,3,4,7]");
  check("at most the number asked for", JSON.stringify(seqOf(await take(2, false))) === "[0,3]");

  section("C2. The uploads with a found person still to add");
  const due = async () => (await pool.query(FOUND_DUE_SQL, [100])).rows.filter((r) => r.batch_id === batch.id);
  const dueNow = await due();
  check("an upload with people still to add is not due while a round of its own is live...", dueNow.length === 0, JSON.stringify(dueNow));
  await pool.query(`UPDATE upload_batches SET status = 'complete' WHERE id = $1`, [live]);
  const dueAfter = await due();
  check("... and it is due once that round is over, named with its client", dueAfter.length === 1 && dueAfter[0].client_tag === UA, JSON.stringify(dueAfter));
  await pool.query(
    `UPDATE enrich_cells SET status = 'done', value = '{"added": true}'::jsonb WHERE column_key = $2 AND row_id = ANY($1::bigint[])`,
    [ids, ADD_COLUMN]
  );
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) SELECT id, $2, table_id, 'done', '{"added": true}'::jsonb
       FROM enrich_rows WHERE id = ANY($1::bigint[]) ON CONFLICT (row_id, column_key) DO NOTHING`,
    [ids, ADD_COLUMN]
  );
  check("an upload whose found people are all settled is not due", (await due()).length === 0);

  section("C3. The approved-email index");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL enable_seqscan = off");
    await c.query("SET LOCAL enable_bitmapscan = off");
    const plan1 = (await c.query(`EXPLAIN ${FOUND_TAKE_SQL}`, [tables.people, source.id, 100, false])).rows.map((r) => r["QUERY PLAN"]).join("\n");
    const plan2 = (await c.query(`EXPLAIN ${FOUND_DUE_SQL}`, [100])).rows.map((r) => r["QUERY PLAN"]).join("\n");
    check("both questions can use enrich_cells_approved_idx: their terms are the index's", /enrich_cells_approved_idx/.test(plan1) && /enrich_cells_approved_idx/.test(plan2), `${plan1}\n---\n${plan2}`);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

// ── D. The same import path ─────────────────────────────────────────────────

async function partD() {
  section("D1. A found person, and the same row uploaded with that email, become the same lead");
  const importer = await TS.importer;
  const tags = ["uptest_a", "Q4"];
  const cfg = { batchId: randomUUID(), filename: `${FILE_PREFIX}.csv`, headers: HEADERS, fieldMapping: MAPPING, duplicateStrategy: "merge", overrideFields: [], addTags: tags, detectEsp: false };
  const kept = await importer.prepareRows([RAW], cfg);
  check("the uploaded row has no usable email, so the upload keeps it back", kept.prepared.length === 0 && kept.holdbacks.length === 1 && kept.counters.no_email === 1);
  const address = `jane.doe@acme-${RUN}.${HOST}`;
  const layout = foundImportLayout(HEADERS, MAPPING);
  const foundCfg = { ...cfg, headers: layout.headers, fieldMapping: layout.fieldMapping, addTags: foundTags(tags, UA) };
  const found = await importer.prepareRows([foundImportRow(layout, RAW, address.toUpperCase())], foundCfg);
  const typed = RAW.map((v, i) => (i === 4 ? address : i === 9 || i === 10 ? "" : v));
  const control = await importer.prepareRows([typed], cfg);
  const leadOf = (p) => JSON.stringify(Object.entries(p.prepared[0]?.lead ?? {}).sort());
  check("the found person's lead is the uploaded row's lead with the address typed in: every field the same",
    found.prepared.length === 1 && control.prepared.length === 1 && leadOf(found) === leadOf(control), `${leadOf(found)}\n${leadOf(control)}`);
  const lead = found.prepared[0].lead;
  check("... the upload's tags (the client's tag once), the cut company, the bare domain, no validation status and no mail provider claimed",
    lead.tags === "uptest_a,Q4" && lead.company === "Acme Uptest" && lead.domain === `acme-${RUN}.${HOST}` && !("validation_status" in lead) && !("esp" in lead) &&
      lead.email === address && lead.title === "Office Manager" && lead.person_linkedin === RAW[8],
    JSON.stringify(lead));

  section("D2. Through the real import, rolled back");
  const seen = { before: 0, lead: null, history: 0, again: null };
  seen.before = (await one(`SELECT count(*)::int AS n FROM leads WHERE email = $1`, [address])).n;
  const counters = await importer.importRows(pool, [foundImportRow(layout, RAW, address)], {
    ...foundCfg,
    dryRun: {
      passes: 2,
      inspect: async (client, passes) => {
        seen.lead = (await client.query(`SELECT email, first_name, last_name, title, company, domain, city, state, tags, validation_status, esp, email_type, person_linkedin FROM leads WHERE email = $1`, [address])).rows[0] ?? null;
        seen.history = (await client.query(`SELECT count(*)::int AS n FROM lead_history h JOIN leads l ON l.id = h.lead_id WHERE l.email = $1 AND h.event_type = 'created'`, [address])).rows[0].n;
        seen.again = passes[1];
      },
    },
  });
  check("the import stores one new lead with the upload's fields, its tags and a 'created' history line",
    seen.before === 0 && counters && seen.lead?.first_name === "Jane" && seen.lead.state === "IL" && seen.lead.city === "Springfield" && seen.lead.tags === "uptest_a,Q4" &&
      seen.lead.validation_status === null && seen.history === 1 && ["personal", "general"].includes(seen.lead.email_type),
    JSON.stringify(seen));
  check("... and the same round again adds and merges nothing (merge is the upload's rule here)", seen.again?.inserted === 0 && seen.again?.merged === 0, JSON.stringify(seen.again));
  check("... and nothing stayed: it was a dry run", (await one(`SELECT count(*)::int AS n FROM leads WHERE email = $1`, [address])).n === 0);
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  const tbl = (await all(`SELECT id FROM enrich_tables WHERE client_tag = ANY($1::text[])`, [TAGS])).map((r) => r.id);
  await pool.query(`DELETE FROM upload_batches WHERE filename LIKE $1`, [`uptest-%`]);
  await pool.query(`DELETE FROM enrich_memory WHERE client_tag = ANY($1::text[]) OR table_id = ANY($2::uuid[]) OR key LIKE $3`, [TAGS, tbl, `%.${HOST}%`]);
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tbl]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tbl]);
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
}

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
  // The release and the guard act on every client switched on, so the run stops unless no other client is on either list.
  const base = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
  const heldElsewhere = await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE run_status = 'held'`);
  check("before the run: no held row anywhere, and no client on the company_pipeline or people_pipeline switch's list",
    heldElsewhere.n === 0 && base.company_pipeline.tags.length === 0 && base.people_pipeline.tags.length === 0,
    JSON.stringify({ held: heldElsewhere.n, company: base.company_pipeline.tags, people: base.people_pipeline.tags }));
  if (heldElsewhere.n || base.company_pipeline.tags.length || base.people_pipeline.tags.length) throw new Error("not run: another client is on a switch or holds held rows here");
  const { srcModule } = routeLoader(randomUUID());
  TS = {
    constants: srcModule("lib/uploads/constants.ts"),
    normalize: srcModule("lib/uploads/normalize-row.ts"),
    importer: srcModule("lib/uploads/import-rows.ts"),
  };
  for (const t of TAGS) await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, NULL)`, [t, `Upload people test ${t.slice(-1)}`]);
  await partA();
  await partB();
  await partC();
  await partD();
  check("nothing tried to reach any address", net.calls.refused === 0 && Object.values(net.calls).every((n) => n === 0), JSON.stringify(net.calls));
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[])) AS clients,
            (SELECT count(*)::int FROM enrich_tables WHERE client_tag = ANY($1::text[])) AS tables,
            (SELECT count(*)::int FROM upload_batches WHERE filename LIKE 'uptest-%') AS batches,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2) AS leads,
            (SELECT count(*)::int FROM enrich_rows WHERE row_key LIKE $3) AS rows`,
    [TAGS, `%.${HOST}`, `test:${RUN}:%`]
  );
  let switchesBack = true;
  if (switchesBefore) {
    for (const key of SWITCHES) {
      const s = await one(`SELECT value FROM enrich_settings WHERE key = $1`, [key]);
      const b = switchesBefore[key];
      if (b.exists ? JSON.stringify(s?.value) !== JSON.stringify(b.value) : Boolean(s)) switchesBack = false;
    }
  }
  const clean = Object.values(left).every((n) => n === 0) && switchesBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, switchesBack })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
