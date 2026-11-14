#!/usr/bin/env node
// End-to-end checks for the pipeline's templates on the made-up originals
// (design 8.2): company rows, their General inboxes rows and People rows,
// worked as the enrichment worker works them, with OpenAI, Reoon, Google's
// DNS, the email finders, Enrichley and the websites answering from stubs.
// LOCAL DATABASE ONLY: made-up clients (tags starting PVTEST_), their tables,
// a few made-up leads and never-contact rows, removed at the end.
//
//   node --env-file=.env.local scripts/test-pipeline-v2.mjs
//
// Stop the enrichment worker first. No paid key is read from the environment;
// the keys here are made up, and fetch refuses every address but the stubs'.
//
//   C. company rows end to end: filters, the database first, the website, the
//      first general email, the email searches, inbox rows, strict rules, caps
//      and the sweep, the people side, a second pass, ai_web's requests, quirks
//   D. projections and listing
//   E. the email finders and Enrichley, by their keys
//   F. personalisation, switched off and on

import pg from "pg";
import { randomUUID } from "node:crypto";
import { checker, dropPaidKeys, installNet, localDatabaseUrl, seedFixtureVariant, WORKER_SQL, workRow } from "./fixtures/test-support.mjs";
import { FIXTURE_MARKER } from "./fixtures/clay-originals/fixtures.mjs";
import { ensurePipelineTables } from "./lib/enrich/templates.mjs";
import { companyInputs, SOURCE_BOUGHT } from "./lib/enrich/company-template.mjs";
import { sourceObject } from "./lib/enrich/people-template.mjs";
import { contactSummary } from "./lib/enrich/project-contacts.mjs";
import { resetClientChecks } from "./lib/enrich/client-checks.mjs";
import { requeueRowsForHeldKeys, requeueWaitingTemplateRows, resetCompanyActions } from "./lib/enrich/company-actions.mjs";
import { absentKeyNote, OPTIONAL_KEYS } from "./lib/enrich/pipeline-actions.mjs";
import { runRow } from "./lib/enrich/engine.mjs";
import { settingsFrom } from "./lib/enrich/settings.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

const PREFIX = "PVTEST_";
const RUN = randomUUID().slice(0, 6);
const HOST = "pvtest.example";
const dom = (slug) => `${slug}-${RUN}.${HOST}`;
const at = (slug, local) => `${local}@${dom(slug)}`;
const tag = (s) => `${PREFIX}${s}`;
const SUPPRESS_REASON = "pipeline v2 test";
const A = tag("A"); // company steps only, Springfield and Peoria, "janitorial" excluded
const B = tag("B"); // the same places: shared answers
const P = tag("P"); // people on, AI searches on
const Q = tag("Q"); // people on, AI searches off
const KEYS = { OPENAI_API_KEY: "made-up-openai-key", ENRICH_REOON_API_KEY: "made-up-reoon-key" };
const FINDER_KEYS = {
  FINDYMAIL_API_KEY: "made-up-findymail-0001", PROSPEO_API_KEY: "made-up-prospeo-0002",
  ANYMAIL_FINDER_API_KEY: "made-up-anymail-0003", ENRICHLEY_API_KEY: "made-up-enrichley-0004",
};
const IL = (city) => ({ city, state: "IL", country: "US" });
const SPRINGFIELD = { street: "100 Main Street", city: "Springfield", state: "Illinois", country: "United States", postal_code: "62701" };
const PEORIA = { street: "200 Oak Avenue", city: "Peoria", state: "IL", country: "United States", postal_code: "61602" };
const BISMARCK = { street: "300 Lake Road", city: "Bismarck", state: "North Dakota", country: "United States", postal_code: "58501" };
const created = { leads: 0 };
const tables = {};

async function addClient(t, { places, terms = [] }) {
  await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, NULL)`, [t, `Pipeline test ${t.slice(PREFIX.length)}`]);
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
     VALUES ($1, '{US}', $2, '[]', $3, false, now())`,
    [t, JSON.stringify(places), terms]
  );
  await seedFixtureVariant(pool, t);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    tables[t] = await ensurePipelineTables(c, t);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}

let seq = 0;
/** A made-up AI Ark company. website/domain: "auto" for its own made-up site, a string, or null for none. */
function company(slug, name, { hq = SPRINGFIELD, branches = [], website = "auto", domain = "auto", email = null, industry = "dental", description = null } = {}) {
  const d = dom(slug);
  const site = website === "auto" ? `https://www.${d}` : website;
  return {
    id: `pvtest-${RUN}-${++seq}`,
    summary: { name: `${name} ${RUN}`, industry, type: "PRIVATELY_HELD", staff: { total: 20, range: { start: 11, end: 50 } }, description: description ?? `${name} is a made-up business for the pipeline tests.` },
    link: { ...(site ? { website: site } : {}), ...(domain === "auto" ? { domain: d } : domain ? { domain } : {}), linkedin: `https://linkedin.${HOST}/company/${slug}-${RUN}` },
    contact: { ...(email ? { email } : {}), phone: { raw: "(217) 555-0100", sanitized: "2175550100" } },
    location: { headquarter: hq, locations: [hq, ...branches] },
    industries: [industry],
    last_updated: "2026-10-01",
  };
}
const nameOf = (record) => record.summary.name;

/** A company row as a bought page writes it: its input cells, the table's own tag, queued. */
async function addCompanyRow(t, record) {
  const inputs = { ...companyInputs(record, { source: SOURCE_BOUGHT }), client_tag: t };
  const { rows: [r] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, search_text) VALUES ($1, $2, '') RETURNING id`, [tables[t].companies, `aiark:${record.id}`]);
  await pool.query(
    `INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
     SELECT $1, kv.key, $2, 'done', to_jsonb(kv.value), left(kv.value, 300) FROM jsonb_each_text($3::jsonb) AS kv`,
    [r.id, tables[t].companies, JSON.stringify(inputs)]
  );
  return Number(r.id);
}

/** A People row as a people run writes it: input cells only (the source object as JSON). */
async function addPersonRow(t, { companyRowId, key, person, email = "", stage = "bought", track = "operations", website, city = "Springfield", state = "IL" }) {
  const src = sourceObject(person);
  const inputs = {
    find_people_from_linkedin_company_url: src, email, client_tag: t, company_website: website, written_city: city, written_state: state,
    company_row: String(companyRowId), person_aiark_id: key, found_by: "aiark", stage, track, rank: "0",
    person_first_name: person.profile?.first_name ?? "", person_last_name: person.profile?.last_name ?? "", person_country: "US", source: "AI Ark people run",
  };
  const { rows: [r] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, search_text) VALUES ($1, $2, '') RETURNING id`, [tables[t].people, `aiark:${key}`]);
  for (const [k, v] of Object.entries(inputs)) {
    if (v === "" || v == null) continue;
    await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) VALUES ($1, $2, $3, 'done', $4::jsonb)`, [r.id, k, tables[t].people, JSON.stringify(v)]);
  }
  return Number(r.id);
}
const madeUpPerson = (first, last, record, { linkedin = true, title = "Office Manager" } = {}) => ({
  profile: { first_name: first, last_name: last, full_name: `${first} ${last}`, title },
  company: { summary: { name: nameOf(record) }, link: { domain: record.link.domain } },
  link: linkedin ? { linkedin: `https://linkedin.${HOST}/in/${first.toLowerCase()}-${RUN}` } : {},
  location: { city: "Springfield", state: "Illinois", country: "United States" },
});

const BASE_ROWS = [];
/** The stored settings with some keys replaced: what runRow gets (the database's rows stay as they are). */
function settingsWith(over = {}) {
  const rows = BASE_ROWS.filter((r) => !(r.key in over)).concat(Object.entries(over).map(([key, value]) => ({ key, value })));
  return settingsFrom(rows);
}
const HIGH_CAPS = { reoon_checks_per_day: 100_000, openai_usd_per_day: { pipeline: 10_000, fit: 10_000 } };
let SA;
let SP;
let SQ;
const settingsFor = (t) => (t === P ? SP : t === Q ? SQ : SA);

const work = (rowId, { env = KEYS, settings = SA } = {}) => workRow(pool, net, rowId, { env, settings });
/** Works every queued row of a client's three tables (inbox and People rows a write-to made), until none is left. */
async function drain(t, { env = KEYS, settings = settingsFor(t) } = {}) {
  const ids = [tables[t].companies, tables[t].inboxes, tables[t].people];
  const done = [];
  for (let round = 0; round < 8; round++) {
    const queued = await all(`SELECT id FROM enrich_rows WHERE table_id = ANY($1::uuid[]) AND run_status = 'queued' ORDER BY id`, [ids]);
    if (!queued.length) break;
    for (const q of queued) done.push(await work(Number(q.id), { env, settings }));
  }
  return done;
}
/** A company row added, worked, and its inbox and People rows worked too. */
async function runCompany(t, record, { env = KEYS, settings = settingsFor(t) } = {}) {
  const rowId = await addCompanyRow(t, record);
  const w = await work(rowId, { env, settings });
  const followers = await drain(t, { env, settings });
  return { rowId, w, followers, s: await summaryOf(rowId), inboxes: await inboxesOf(t, rowId), cells: await cellsOf(rowId) };
}
const summaryOf = (rowId) => one(`SELECT * FROM enrich_companies WHERE row_id = $1`, [rowId]);
const cellsOf = async (rowId) => Object.fromEntries((await all(`SELECT column_key, status, value, note FROM enrich_cells WHERE row_id = $1`, [rowId])).map((c) => [c.column_key, c]));
const inboxesOf = async (t, companyRowId) =>
  Promise.all(
    (await all(`SELECT id, run_status FROM enrich_rows WHERE table_id = $1 AND starts_with(row_key, $2) ORDER BY id`, [tables[t].inboxes, `w:${companyRowId}:`])).map(async (r) => ({
      id: Number(r.id), status: r.run_status, cells: await cellsOf(r.id), contact: await one(`SELECT * FROM enrich_contacts WHERE row_id = $1`, [r.id]),
    }))
  );
const valueOf = (cells, k) => (cells[k]?.status === "done" ? cells[k].value : undefined);
const plan = (marker, record, answer) => net.openai.set(`${marker}|${nameOf(record)}`, answer);
const reoon = (map) => Object.entries(map).forEach(([e, s]) => net.reoon.set(e, s));
async function lead(email, extra = {}) {
  const cols = { email, company: "Pipeline test lead", ...extra };
  await pool.query(`INSERT INTO leads (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(cols));
  created.leads++;
}
const openaiFor = (marker, record) => net.asked.filter((x) => x.marker === marker && x.who === nameOf(record)).length;

// ── C. Company rows end to end ──────────────────────────────────────────────

async function partC() {
  section("C1. The client's rules, the brand list and the Master Filter");
  const brand = company("brand", "Brand Outlet", { domain: "shop.megamart.example", website: "https://shop.megamart.example" });
  const c1 = await runCompany(A, brand);
  const skipped = (cells, k) => cells[k]?.status === "skipped";
  check("C#16's brand list stops a brand: its outcome, and not listed", valueOf(c1.cells, "exclusion_large_company_check") === false && c1.s.outcome === "A large company (brand list)" && !c1.s.listed && c1.s.passes === false, c1.s?.outcome);
  check("... and every paid step's condition then fails: nothing searched, checked or probed",
    ["companys_website", "email_extraction_claygent", "email_extraction_claygent_2", "aiark_email_reoon", "check_if_url_is_valid"].every((k) => skipped(c1.cells, k)) && c1.w.paid.openai + c1.w.paid.reoon + c1.w.paid.probe === 0);
  const masterFormula = (await one(`SELECT formula FROM enrich_columns WHERE table_id = $1 AND key = 'master_filter'`, [tables[A].companies])).formula;
  check("the Master Filter's job-row clause reads a source the pipeline never fills, so it never passes through it", masterFormula.includes("{{imported_jobs}}?.company_name") && valueOf(c1.cells, "master_filter") === false);
  const inDescription = company("descr", "Corner Supplies", { description: "We resell bigbox.example gear to offices." });
  const c1b = await runCompany(A, inDescription);
  check("quirk 11: a brand domain inside the description (read as the sub-category) stops the company too", c1b.s.outcome === "A large company (brand list)" && c1b.w.paid.openai === 0);
  const excluded = await runCompany(A, company("janitor", "Riverbend Janitorial"));
  check("the client's own exclusions (C#14's place) stop a company, with nothing paid", excluded.s.outcome === "Excluded by the client's rules" && valueOf(excluded.cells, "exclusion_keywords_filter") === false && excluded.w.paid.openai + excluded.w.paid.reoon + excluded.w.paid.probe === 0);
  const outside = await runCompany(A, company("away", "Lakeside Dental Away", { hq: BISMARCK }));
  check("outside the client's places (C#15's place): its outcome, nothing paid", outside.s.outcome === "Outside the client's area" && valueOf(outside.cells, "service_area_check") === false && outside.w.paid.openai + outside.w.paid.probe === 0);

  section("C2. The database first (D28)");
  const heldCo = company("heldp", "Harborview Dental Held");
  await lead(`jane@${dom("heldp")}`, { company: nameOf(heldCo), email_type: "personal", state: "IL", first_name: "Jane", last_name: "Held", title: "Office Manager" });
  plan("C31", heldCo, { company_emails_found: at("heldp", "info") });
  const c2 = await runCompany(P, heldCo);
  const hp = valueOf(c2.cells, "held_people");
  check("a usable named lead at the company and state: held_people counts it, with its title", hp?.count === 1 && JSON.stringify(hp.titles) === '["Office Manager"]', JSON.stringify(hp));
  check("... SAFE TO RUN is false, and C#31, C#32 and C#48 don't run (AI searches on)",
    valueOf(c2.cells, "safe_to_run") === false && ["email_extraction_claygent", "email_extraction_claygent_2", "company_decision_maker_facilities_2_claygent"].every((k) => c2.cells[k]?.status === "skipped" && c2.cells[k].note === "Run condition not met") && c2.w.paid.openai === 0,
    JSON.stringify(Object.fromEntries(["email_extraction_claygent", "company_decision_maker_facilities_2_claygent"].map((k) => [k, c2.cells[k]?.note]))));
  check("... its outcome: People already in the database", c2.s.outcome === "People already in the database");
  const heldA = company("helda", "Harborview Dental Held A");
  await lead(`john@${dom("helda")}`, { company: nameOf(heldA), email_type: "personal", state: "IL", first_name: "John", last_name: "Held" });
  const c2b = await runCompany(A, heldA);
  check("held_people runs with people switched off for the client", c2b.cells.held_people?.status === "done" && valueOf(c2b.cells, "held_people")?.count === 1 && c2b.cells.people_at_company?.note === "Switched off: people_pipeline");

  section("C3. The website (D5)");
  const withDomain = company("site1", "Northgate Dental Site");
  plan("C31", withDomain, { company_emails_found: at("site1", "office") });
  reoon({ [at("site1", "office")]: "safe" });
  const c3a = await runCompany(A, withDomain);
  check("AI Ark gave a domain: no website search, the site checked for free", c3a.cells.companys_website?.status === "skipped" && openaiFor("C24", withDomain) === 0 && valueOf(c3a.cells, "check_if_url_is_valid")?.valid === true && valueOf(c3a.cells, "use_domain") === dom("site1"));
  check("use_domain is text, the bare domain", typeof valueOf(c3a.cells, "use_domain") === "string" && c3a.s.domain === dom("site1"));
  const noDomain = company("site2", "Northgate Dental Found", { website: null, domain: null });
  plan("C24", noDomain, { response: `https://www.${dom("site2")}` });
  plan("C31", noDomain, { company_emails_found: "N/A" });
  const c3b = await runCompany(A, noDomain);
  check("no domain: one website search, its answer checked by C#27, then C#28 and C#29",
    openaiFor("C24", noDomain) === 1 && valueOf(c3b.cells, "company_website_response") === `https://www.${dom("site2")}` && valueOf(c3b.cells, "check_if_url_is_valid")?.valid === true && valueOf(c3b.cells, "use_domain") === dom("site2"),
    JSON.stringify({ calls: openaiFor("C24", noDomain), domain: valueOf(c3b.cells, "use_domain") }));
  const listing = company("site3", "Northgate Dental Listing", { website: null, domain: null });
  plan("C24", listing, { response: `https://listings.example/biz/site3-${RUN}` });
  const c3c = await runCompany(A, listing);
  check("a blocklisted answer is dropped by C#26: no website, no email search", !valueOf(c3c.cells, "use_website") && c3c.s.outcome === "No working website" && openaiFor("C31", listing) === 0);
  const na = company("site4", "Northgate Dental Unknown", { website: null, domain: null });
  plan("C24", na, { response: "N/A" });
  const c3d = await runCompany(A, na);
  check("an N/A answer stays N/A through C#25, C#26 and C#29", valueOf(c3d.cells, "company_website_response") === "N/A" && valueOf(c3d.cells, "use_website") === "N/A" && valueOf(c3d.cells, "use_domain") === "N/A");
  check("... C#31 needs a valid URL and doesn't run; C#32 then runs, as in Clay", c3d.cells.email_extraction_claygent?.status === "skipped" && openaiFor("C32", na) === 1 && c3d.s.outcome === "No working website", c3d.s?.outcome);

  section("C4. The first general email, in Icypeas' place (D8)");
  const heldInbox = company("hinbox", "Harborview Dental Inbox");
  await lead(at("hinbox", "info"));
  const c4a = await runCompany(A, heldInbox);
  const first = valueOf(c4a.cells, "first_general_email");
  check("a held inbox fills it, and C#31 and C#32 don't run", first?.source === "database" && first.emails?.[0]?.email === at("hinbox", "info") && openaiFor("C31", heldInbox) + openaiFor("C32", heldInbox) === 0, JSON.stringify(first));
  check("... C#34 and C#36 write it as an inbox row, found in the database, which is Already in the database with no Reoon call",
    c4a.inboxes.length === 1 && c4a.inboxes[0].contact?.found_by === "database" && valueOf(c4a.inboxes[0].cells, "inbox_outcome") === "Already in the database" && c4a.inboxes[0].cells.reoon_validation?.status === "skipped" && c4a.followers.every((f) => f.paid.reoon === 0),
    JSON.stringify(c4a.inboxes.map((x) => valueOf(x.cells, "inbox_outcome"))));
  check("... and the company is listed as Already in the database", (await summaryOf(c4a.rowId)).listed === true && (await summaryOf(c4a.rowId)).outcome === "Already in the database");
  const aiEmail = company("aimail", "Harborview Dental Mail", { email: at("aimail", "office") });
  reoon({ [at("aimail", "office")]: "safe" });
  const reoonBefore = net.calls.reoon;
  const c4b = await runCompany(A, aiEmail);
  const firstB = valueOf(c4b.cells, "first_general_email");
  check("AI Ark's head-office email, approved by G#40's rule, fills it", valueOf(c4b.cells, "aiark_email_approved") === true && firstB?.source === "aiark" && openaiFor("C31", aiEmail) === 0, JSON.stringify(firstB));
  check("... its inbox row is Approved, and the reoon_v1 memory makes its check free: one Reoon call in all",
    c4b.inboxes.length === 1 && valueOf(c4b.inboxes[0].cells, "inbox_outcome") === "Approved" && net.calls.reoon - reoonBefore === 1 && /^Reused/.test(c4b.inboxes[0].cells.reoon_validation?.note ?? ""),
    `${net.calls.reoon - reoonBefore} calls; ${c4b.inboxes[0]?.cells.reoon_validation?.note}`);
  check("... and the company is listed with a general email", (await summaryOf(c4b.rowId)).outcome === "Has a general email" && (await summaryOf(c4b.rowId)).general_email === at("aimail", "office"));
  const branchEmail = company("brmail", "Harborview Dental Branch", { hq: BISMARCK, branches: [PEORIA], email: at("brmail", "office") });
  plan("C31", branchEmail, { company_emails_found: "N/A" });
  const c4br = await runCompany(A, branchEmail);
  check("not at the head office: AI Ark's email isn't checked (it is the head office's)", c4br.cells.aiark_email_reoon?.status === "skipped" && !net.verified.includes(at("brmail", "office")));
  const roleEmail = company("rolemail", "Harborview Dental Role", { email: at("rolemail", "info") });
  reoon({ [at("rolemail", "info")]: "role_account" });
  plan("C31", roleEmail, { company_emails_found: at("rolemail", "frontdesk") });
  const c4c = await runCompany(A, roleEmail);
  check("Reoon role_account for it: it doesn't fill the place, and C#31 runs", valueOf(c4c.cells, "aiark_email_approved") === false && !valueOf(c4c.cells, "first_general_email") && openaiFor("C31", roleEmail) === 1);

  section("C5. The email searches");
  const deadSite = company("dead", "Harborview Dental Dead");
  net.dead.add(dom("dead"));
  plan("C32", deadSite, { company_emails_found: at("dead", "hello") });
  const c5a = await runCompany(A, deadSite);
  check("C#31 runs only with a live URL", valueOf(c5a.cells, "check_if_url_is_valid")?.valid === false && c5a.cells.email_extraction_claygent?.status === "skipped");
  check("quirk 5: C#32 has no URL check, so it runs for a dead site, as in Clay", openaiFor("C32", deadSite) === 1 && c5a.inboxes.length === 1 && c5a.inboxes[0].contact?.found_by === "claygent_2");
  const junk = company("junk", "Harborview Dental Junk");
  plan("C31", junk, { company_emails_found: "none found" });
  plan("C32", junk, { company_emails_found: at("junk", "office") });
  const c5b = await runCompany(A, junk);
  check("C#32 runs after a junk C#31 answer", openaiFor("C31", junk) === 1 && openaiFor("C32", junk) === 1 && c5b.inboxes.length === 1);
  const mixed = company("mixed", "Harborview Dental Mixed");
  plan("C31", mixed, { company_emails_found: `${at("mixed", "info")}, https://www.${dom("mixed")}/contact, ${at("mixed", "sales")}` });
  const c5c = await runCompany(A, mixed);
  const found = valueOf(c5c.cells, "extract_urls_and_emails_from_text")?.urlsAndEmails ?? [];
  check("C#34 pulls the addresses out, emails only, each tagged with where it was found",
    JSON.stringify(found.map((x) => [x.type, x.value, x.found_in])) === JSON.stringify([["email", at("mixed", "info"), "claygent_1"], ["email", at("mixed", "sales"), "claygent_1"]]), JSON.stringify(found));
  check("... and C#36 writes one inbox row each, with C#36's mapping", c5c.inboxes.length === 2 && valueOf(c5c.inboxes[0].cells, "client_tag") === A && valueOf(c5c.inboxes[0].cells, "domain") === dom("mixed") && valueOf(c5c.inboxes[0].cells, "city") === "Springfield" && valueOf(c5c.inboxes[0].cells, "company_row") === String(c5c.rowId));
  await pool.query(`UPDATE enrich_rows SET run_status = 'queued', run_force = '{general_email_write_to}' WHERE id = $1`, [c5c.rowId]);
  const again = await work(c5c.rowId);
  check("written idempotently: a forced write again makes no new row", (await inboxesOf(A, c5c.rowId)).length === 2 && valueOf(await cellsOf(c5c.rowId), "general_email_write_to")?.written === 2 && again.paid.openai === 0);
  const many = company("many", "Harborview Dental Many");
  const seven = ["a1", "a2", "a3", "a4", "a5", "a6", "a7"].map((l) => at("many", l));
  plan("C31", many, { company_emails_found: seven.join(", ") });
  const c5d = await runCompany(A, many);
  const wt = valueOf(c5d.cells, "general_email_write_to");
  check("inboxes_per_company stops at 5, the first five in order, and counts the rest",
    wt?.written === 5 && wt.capped === 2 && JSON.stringify(c5d.inboxes.map((x) => valueOf(x.cells, "general_email"))) === JSON.stringify(seven.slice(0, 5)), JSON.stringify(wt));

  section("C6. Inbox rows");
  const statuses = company("verdicts", "Harborview Dental Verdicts");
  const addrs = { ok: at("verdicts", "office"), role: at("verdicts", "info"), catchall: at("verdicts", "contact"), unknown: at("verdicts", "front"), bad: at("verdicts", "gone") };
  reoon({ [addrs.ok]: "safe", [addrs.role]: "role_account", [addrs.catchall]: "catch_all", [addrs.unknown]: "unknown", [addrs.bad]: "invalid" });
  plan("C31", statuses, { company_emails_found: Object.values(addrs).join(", ") });
  const c6 = await runCompany(A, statuses);
  const outcomeOf = (email) => {
    const x = c6.inboxes.find((i) => valueOf(i.cells, "general_email") === email);
    return { outcome: x && valueOf(x.cells, "inbox_outcome"), status: x?.status, contact: x?.contact };
  };
  check("Reoon \"safe\" with all three flags: Approved, usable", outcomeOf(addrs.ok).outcome === "Approved" && outcomeOf(addrs.ok).contact?.usable === true && outcomeOf(addrs.ok).contact.verdict === "approved");
  check("role_account, catch_all and unknown: Waiting for Enrichley, and the row ends done, not waiting",
    [addrs.role, addrs.catchall, addrs.unknown].every((e) => outcomeOf(e).outcome === "Waiting for Enrichley" && outcomeOf(e).status === "done" && outcomeOf(e).contact?.verdict === "enrichley" && outcomeOf(e).contact.usable === false),
    JSON.stringify([addrs.role, addrs.catchall, addrs.unknown].map(outcomeOf)));
  const enrichleyCell = c6.inboxes.find((i) => valueOf(i.cells, "general_email") === addrs.role)?.cells.enrichly_validation;
  check("... G#41 shows the key it needs, with no call", enrichleyCell?.status === "skipped" && enrichleyCell.note === absentKeyNote("ENRICHLEY_API_KEY") && net.calls.enrichley === 0);
  check("invalid: Rejected by Reoon", outcomeOf(addrs.bad).outcome === "Rejected by Reoon" && outcomeOf(addrs.bad).contact?.verdict === "rejected");
  check("the company is listed once, with its one approved address", (await summaryOf(c6.rowId)).listed && (await summaryOf(c6.rowId)).general_emails === 1 && (await summaryOf(c6.rowId)).general_waiting === 3);
  const skipCo = company("skip", "Harborview Dental Skip");
  await pool.query(`INSERT INTO email_validations (email, status, native_status, provider, validated_at) VALUES ($1, 'invalid', 'invalid', 'reoon', now())`, [at("skip", "billing")]);
  plan("C31", skipCo, { company_emails_found: `${at("skip", "careers")}, dean@college-${RUN}.edu, ${at("skip", "billing")}` });
  const before6 = net.calls.reoon;
  const c6b = await runCompany(A, skipCo);
  const ob = (email) => valueOf(c6b.inboxes.find((i) => valueOf(i.cells, "general_email") === email)?.cells ?? {}, "inbox_outcome");
  check("G#38 skips a junk address with no call", ob(at("skip", "careers")) === "Not checked: not a qualified address");
  check("G#39's regex skips another with no call (its \\.edu)", ob(`dean@college-${RUN}.edu`) === "Not checked: a role or junk address");
  check("a final rejection held in email_validations makes no call", ob(at("skip", "billing")) === "Rejected by Reoon" && net.calls.reoon === before6, `${net.calls.reoon - before6} calls`);
  const shared = company("verdicts", "Harborview Dental Verdicts");
  plan("C31", shared, { company_emails_found: addrs.ok });
  const before6c = net.calls.reoon;
  const c6c = await runCompany(B, { ...shared, id: `pvtest-${RUN}-b-${++seq}` });
  const okB = c6c.inboxes.find((i) => valueOf(i.cells, "general_email") === addrs.ok);
  check("another client's row for the same company and office reuses the search (the same prompt), and its addresses' checks (reoon_v1)",
    c6c.inboxes.length === 5 && valueOf(okB?.cells ?? {}, "inbox_outcome") === "Approved" && net.calls.reoon === before6c && /^Reused: found for PVTEST_A/.test(c6c.cells.email_extraction_claygent?.note ?? "") && /^Reused/.test(okB?.cells.reoon_validation?.note ?? ""),
    `${net.calls.reoon - before6c} Reoon calls; ${c6c.cells.email_extraction_claygent?.note}`);

  section("C7. Strict rules, Reoon's credits, the daily caps and the sweep");
  const others = await one(
    `SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id
      WHERE t.template IS NOT NULL AND r.run_status = 'waiting' AND NOT starts_with(t.client_tag, $1)`,
    [PREFIX]
  );
  const waitCo = company("waits", "Harborview Dental Waits");
  const waitAddrs = ["w1", "w2", "w3"].map((l) => at("waits", l));
  plan("C31", waitCo, { company_emails_found: waitAddrs.join(", ") });
  waitAddrs.forEach((e) => net.reoon.set(e, "safe"));
  const cw = await runCompany(A, waitCo, { env: { OPENAI_API_KEY: KEYS.OPENAI_API_KEY } });
  const waitRows = cw.inboxes;
  check("no Reoon key: G#39 waits, the inbox row waits, and its contact says so",
    waitRows.length === 3 && waitRows.every((x) => x.status === "waiting" && x.cells.reoon_validation?.status === "needs_key" && x.contact?.outcome === "Waiting for a key" && x.contact.usable === false),
    JSON.stringify(waitRows.map((x) => [x.status, x.cells.reoon_validation?.note])));
  resetCompanyActions();
  net.balance = { daily: 0, instant: 0 };
  await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [waitRows[0].id]);
  const noDaily = await work(waitRows[0].id);
  check("Reoon's daily credits used up: it waits, nothing checked", noDaily.status === "waiting" && /daily credits are used up/.test(noDaily.cell("reoon_validation")?.note ?? "") && noDaily.paid.reoon === 0);
  resetCompanyActions();
  net.balance = { daily: 400, instant: 7 };
  await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [waitRows[1].id]);
  const instant = await work(waitRows[1].id);
  check("instant credits on the account: it waits, nothing checked", instant.status === "waiting" && /instant credits/.test(instant.cell("reoon_validation")?.note ?? "") && instant.paid.reoon === 0);
  resetCompanyActions();
  net.balance = { daily: 400, instant: 0 };
  const noShare = settingsWith({ spend_caps: { ...HIGH_CAPS, reoon_checks_per_day: 0 } });
  await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [waitRows[2].id]);
  const shareUsed = await work(waitRows[2].id, { settings: noShare });
  check("the pipeline's own daily share used up: it waits, nothing checked", shareUsed.status === "waiting" && shareUsed.cell("reoon_validation")?.note === "Today's Reoon share is used up" && shareUsed.paid.reoon === 0, shareUsed.cell("reoon_validation")?.note);
  if (others.n) {
    check("no other client's template rows waiting (the sweep would queue them too)", false, `${others.n} rows`);
  } else {
    resetCompanyActions();
    const noKey = await requeueWaitingTemplateRows(pool, { OPENAI_API_KEY: KEYS.OPENAI_API_KEY }, { settings: SA, pageSize: 2 });
    resetCompanyActions();
    net.balance = { daily: 400, instant: 3 };
    const stillInstant = await requeueWaitingTemplateRows(pool, KEYS, { settings: SA, pageSize: 2 });
    resetCompanyActions();
    net.balance = { daily: 400, instant: 0 };
    const capFull = await requeueWaitingTemplateRows(pool, KEYS, { settings: noShare, pageSize: 2 });
    resetCompanyActions();
    const ready = await requeueWaitingTemplateRows(pool, KEYS, { settings: SA, pageSize: 2 });
    check("the sweep leaves rows waiting while their reason holds: no Reoon key, instant credits",
      noKey.queued === 0 && noKey.waiting === 3 && /Needs ENRICH_REOON_API_KEY/.test(noKey.why ?? "") && stillInstant.queued === 0 && /instant/.test(stillInstant.why ?? ""),
      JSON.stringify({ noKey, stillInstant }));
    check("... queues only the rows whose own reason cleared, in pages: the share used up keeps its row",
      capFull.queued === 2 && capFull.waiting === 1 && capFull.why === "Today's Reoon share is used up" && ready.queued === 1 &&
        (await all(`SELECT id FROM enrich_rows WHERE id = ANY($1::bigint[]) AND run_status = 'queued'`, [waitRows.map((x) => x.id)])).length === 3,
      JSON.stringify({ capFull, ready }));
    await drain(A);
    const after = await inboxesOf(A, cw.rowId);
    check("... then they finish, and their company is listed", after.every((x) => x.status === "done" && valueOf(x.cells, "inbox_outcome") === "Approved") && (await summaryOf(cw.rowId)).listed === true);
  }
  const openaiCap = company("capped", "Harborview Dental Capped");
  const capped = await runCompany(A, openaiCap, { settings: settingsWith({ spend_caps: { ...HIGH_CAPS, openai_usd_per_day: { pipeline: 0, fit: 0 } } }) });
  check("the day's OpenAI cap makes the paid cell wait, with no call, and the tab says why",
    capped.cells.email_extraction_claygent?.status === "needs_key" && capped.cells.email_extraction_claygent.note === "Today's OpenAI cap for the pipeline is reached" && capped.w.status === "waiting" && openaiFor("C31", openaiCap) === 0 && capped.s.outcome === "Waiting for a key");
  check("... and C#32, which reads it, waits too rather than read nothing found", capped.cells.email_extraction_claygent_2?.status === "needs_key");

  section("C8. The people side");
  const pplOff = c3a; // client A: people switched off
  const offKeys = ["people_at_company", "company_decision_maker_facilities_1_claygent", "person_2_name_check", "person_2_facilities_1_write_to", "company_decision_maker_facilities_2_claygent", "company_decision_maker_location_company_check", "person_1_ceo_write_to"];
  check("people off: people_at_company and C#41 to C#58 are Switched off, nothing paid", offKeys.every((k) => pplOff.cells[k]?.status === "skipped" && pplOff.cells[k].note === "Switched off: people_pipeline") && pplOff.w.paid.openai === 1);
  const qCo = company("qco", "Lakeview Office Q");
  plan("C31", qCo, { company_emails_found: "N/A" });
  const cq = await runCompany(Q, qCo);
  check("people on, AI searches off: people_at_company runs; C#41, C#48, C#50 and C#56 are Switched off",
    cq.cells.people_at_company?.status === "done" && ["company_decision_maker_facilities_1_claygent", "company_decision_maker_facilities_2_claygent", "company_decision_maker_location_company_check", "company_decision_maker_ceo_claygent"].every((k) => cq.cells[k]?.note === "Switched off: ai_searches") && openaiFor("C48", qCo) === 0,
    JSON.stringify(Object.fromEntries(["people_at_company", "company_decision_maker_facilities_2_claygent"].map((k) => [k, cq.cells[k]?.note ?? cq.cells[k]?.status]))));
  const pAt = valueOf(cq.cells, "people_at_company");
  check("... its value: nobody looked yet, every track open", pAt?.looked === false && pAt.settled === false && pAt.sources?.ai_ark === "not_looked" && pAt.tracks.operations.settled === false && pAt.total === 0, JSON.stringify(pAt));
  // AI searches on, first pass.
  const pCo = company("pco", "Lakeview Office P");
  plan("C31", pCo, { company_emails_found: "N/A" });
  plan("C48", pCo, { Person_3_Full_Name: `Wanda Wrangler`, Person_3_Title: "Office Wrangler", Person_3_LinkedIn_URL: `https://linkedin.${HOST}/in/wanda-${RUN}` });
  const cp = await runCompany(P, pCo);
  check("AI searches on: C#48 runs on the first pass for a company not held with a live site", openaiFor("C48", pCo) === 1 && cp.cells.company_decision_maker_facilities_2_claygent?.status === "done");
  check("... C#41 and C#56 wait for their track to settle", cp.cells.company_decision_maker_facilities_1_claygent?.note === "Run condition not met" && cp.cells.company_decision_maker_ceo_claygent?.note === "Run condition not met" && openaiFor("C41", pCo) + openaiFor("C56", pCo) === 0);
  check("C#50 is Switched off while linkedin_profile_reads is off, so C#51 writes nobody with a profile link",
    cp.cells.company_decision_maker_location_company_check?.note === "Switched off: linkedin_profile_reads" && cp.cells.person_3_facilities_2_write_to?.status === "skipped" && openaiFor("C50", pCo) === 0);
  const pCo2 = company("pco2", "Lakeview Office P2");
  plan("C31", pCo2, { company_emails_found: "N/A" });
  plan("C48", pCo2, { Person_3_Full_Name: "Fred Keeper", Person_3_Title: "Facility Keeper", Person_3_LinkedIn_URL: "" });
  const cp2 = await runCompany(P, pCo2);
  const fred = await one(`SELECT id FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tables[P].people, `w:${cp2.rowId}:person_3_facilities_2_write_to`]);
  const fredCells = fred ? await cellsOf(fred.id) : {};
  check("... and does write one with no profile link, with C#51's mapping, as found_by facilities_2 on the facility track",
    fred && valueOf(fredCells, "written_full_name") === "Fred Keeper" && valueOf(fredCells, "found_by") === "facilities_2" && valueOf(fredCells, "track") === "facility_office" && valueOf(fredCells, "stage") === "found" && valueOf(fredCells, "written_city") === "Springfield" && valueOf(fredCells, "client_tag") === P,
    JSON.stringify(Object.fromEntries(Object.entries(fredCells).map(([k, v]) => [k, v.value]))));
  check("... that person has no email yet, and never makes the company listed", valueOf(fredCells, "person_outcome") === "No email yet" && (await summaryOf(cp2.rowId)).listed === false);
  // A people run settles the operations and CEO tracks with nobody found.
  const settle = async (rowId, { found = [] } = {}) => {
    const { rows: [run] } = await pool.query(`INSERT INTO aiark_people_runs (client_tag, mode, status, max_people, filters, finished_at) VALUES ($1, 'demo', 'done', 10, '{}', now()) RETURNING id`, [P]);
    await pool.query(
      `INSERT INTO aiark_people_run_companies (run_id, company_row_id, company_id, batch, state, tracks, settled_at)
       VALUES ($1, $2, $3, 0, 'settled', $4, now())`,
      [run.id, rowId, `pvtest-company-${rowId}`, JSON.stringify({ operations: { tried: 1, found: 0, settled: true }, facility_office: { tried: 1, found: 0, settled: true }, ceo: { tried: 1, found: 0, settled: true } })]
    );
    for (const f of found) {
      const personRow = await addPersonRow(P, { companyRowId: rowId, key: `pvtest-found-${RUN}-${++seq}`, person: madeUpPerson("Cathy", "Catchall", pCo), email: f.email, track: f.track, website: `https://www.${dom("pco")}` });
      await pool.query(
        `INSERT INTO enrich_contacts (row_id, company_row_id, table_id, client_tag, kind, email, verdict, usable, track, found_by, stage, outcome)
         VALUES ($1, $2, $3, $4, 'person', $5, 'enrichley', false, $6, 'aiark', 'bought', 'Waiting for Enrichley')`,
        [personRow, rowId, tables[P].people, P, f.email, f.track]
      );
      await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE id = $1`, [personRow]);
    }
    await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [rowId]);
  };
  plan("C41", pCo, { Person_2_Full_Name: "Olive Operator", Person_2_Title: "Marketing Intern", Person_2_LinkedIn_URL: `https://linkedin.${HOST}/in/olive-${RUN}` });
  plan("C56", pCo, { Person_1_Full_Name: "Gadget Bot Owner", Person_1_Title: "Owner", Person_1_LinkedIn_URL: "" });
  await settle(cp.rowId);
  const openai0 = net.calls.openai;
  const second = await work(cp.rowId, { settings: SP });
  await drain(P);
  const pAt2 = valueOf(await cellsOf(cp.rowId), "people_at_company");
  check("once the tracks settle with nobody found: people_at_company says so", pAt2?.settled === true && pAt2.looked === true && pAt2.sources.ai_ark === "settled" && pAt2.tracks.operations.found === false, JSON.stringify(pAt2));
  check("... C#41 runs for the operations track (the site is live), and C#56 for the CEO track", openaiFor("C41", pCo) === 1 && openaiFor("C56", pCo) === 1 && second.cell("company_decision_maker_facilities_1_claygent")?.status === "done");
  check("... its cell shows Clay's first answer field (the name)", second.cell("company_decision_maker_facilities_1_claygent")?.display === "Olive Operator", second.cell("company_decision_maker_facilities_1_claygent")?.display);
  check("... while C#48's answer is reused: the second pass pays only for the two new searches", net.calls.openai - openai0 === 2 && openaiFor("C48", pCo) === 1, `${net.calls.openai - openai0} calls`);
  const olive = await one(`SELECT id FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tables[P].people, `w:${cp.rowId}:person_2_facilities_1_write_to`]);
  const gadget = await one(`SELECT id FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tables[P].people, `w:${cp.rowId}:person_1_ceo_write_to`]);
  const oliveCells = olive ? await cellsOf(olive.id) : {};
  check("quirk 3: C#43's \"||\" clause writes an intern its title filter would drop, with C#43's mapping",
    olive && valueOf(oliveCells, "written_title") === "Marketing Intern" && valueOf(oliveCells, "written_full_name") === "Olive Operator" && valueOf(oliveCells, "found_by") === "facilities_1" && valueOf(oliveCells, "track") === "operations" && valueOf(oliveCells, "full_name") === "Olive Operator",
    JSON.stringify(Object.fromEntries(Object.entries(oliveCells).map(([k, v]) => [k, v.value]))));
  check("quirk 2: C#58 checks Person_2 fields, so a CEO whose name its filter would drop is written", Boolean(gadget) && valueOf(await cellsOf(gadget.id), "written_full_name") === "Gadget Bot Owner");
  const c51 = (await one(`SELECT run_if FROM enrich_columns WHERE table_id = $1 AND key = 'person_3_facilities_2_write_to'`, [tables[P].companies])).run_if;
  check("quirk 2: C#51 reads C#41's title", c51.includes(`{{company_decision_maker_facilities_1_claygent}}?.["Person_2_Title"]`));
  const pCo3 = company("pco3", "Lakeview Office P3");
  plan("C31", pCo3, { company_emails_found: "N/A" });
  plan("C48", pCo3, { Person_3_Full_Name: "N/A" });
  const cp3 = await runCompany(P, pCo3);
  await settle(cp3.rowId, { found: [{ email: at("pco3", "cathy"), track: "ceo" }] });
  const third = await work(cp3.rowId, { settings: SP });
  const pAt3 = third.values.people_at_company;
  check("a person of the track waiting for Enrichley counts as found: C#56 doesn't run, C#41 does",
    pAt3?.tracks.ceo.found === true && pAt3.tracks.operations.found === false && third.cell("company_decision_maker_ceo_claygent")?.note === "Run condition not met" && openaiFor("C41", pCo3) === 1 && openaiFor("C56", pCo3) === 0,
    JSON.stringify(pAt3?.tracks));

  section("C9. A second pass makes no repeat paid call");
  for (const r of [c3a, c5c, c6, c4b]) await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [r.rowId]);
  const before9 = { ...net.calls };
  const redo = await drain(A);
  check("the same rows worked again: no OpenAI, Reoon or probe call, nothing written twice",
    redo.length === 4 && net.calls.openai === before9.openai && net.calls.reoon === before9.reoon && net.calls.probe === before9.probe && redo.every((x) => x.status === "done") && (await inboxesOf(A, c5c.rowId)).length === 2,
    JSON.stringify({ worked: redo.length, openai: net.calls.openai - before9.openai, reoon: net.calls.reoon - before9.reoon }));

  section("C10. ai_web's requests");
  const c41Body = net.bodies.find((x) => /\[fx:C41\]/.test(x?.input ?? ""));
  const props = c41Body?.text?.format?.schema;
  check("the answer schema: Clay's fields in order, all required, nothing else", props?.required?.join() === "Person_2_Full_Name,confidence,reasoning,Person_2_Title,Person_2_LinkedIn_URL" && props.additionalProperties === false && c41Body.text.format.strict === true,
    JSON.stringify(c41Body?.text).slice(0, 500));
  check("the model from its setting (gpt-6-luna), the web search tool with no location, max_tool_calls from it, no reasoning effort",
    c41Body?.model === "gpt-6-luna" && JSON.stringify(c41Body.tools) === '[{"type":"web_search"}]' && c41Body.max_tool_calls === 2 && !("reasoning" in c41Body),
    JSON.stringify({ model: c41Body?.model, tools: c41Body?.tools, max: c41Body?.max_tool_calls }));
  const c24Body = net.bodies.find((x) => /\[fx:C24\]/.test(x?.input ?? ""));
  check("C#24 asks with its own cap of 3 tool calls", c24Body?.max_tool_calls === 3);
  const noTool = await runRow({
    row: { id: 0, created_at: new Date() }, table: { client_tag: A, template: "companies_v2" }, cells: new Map(), env: KEYS, db: null, settings: SA,
    columns: [{ key: "zz_q", name: "zz", kind: "action", action: "ai_web", phase: 1, position: 1, inputs: { prompt: '"[fx:ZZ] business=nobody; Write one question."' }, config: { model_setting: "inbox_question_ai", tool: "none", answer: { response: { type: "string", description: "" } }, user_location: false, keep_na: true } }],
  });
  const zz = net.bodies.at(-1);
  check("a use-ai column sends no tool and no tool cap", noTool.calls === 1 && !("tools" in zz) && !("max_tool_calls" in zz) && zz.model === "gpt-6-luna");
  const effort = settingsWith({ spend_caps: HIGH_CAPS, models: { ...BASE_ROWS.find((r) => r.key === "models")?.value, inbox_question_ai: { model: "gpt-6-luna", reasoning_effort: "low" } } });
  await runRow({
    row: { id: 0, created_at: new Date() }, table: { client_tag: A, template: "companies_v2" }, cells: new Map(), env: KEYS, db: null, settings: effort,
    columns: [{ key: "zz_q", name: "zz", kind: "action", action: "ai_web", phase: 1, position: 1, inputs: { prompt: '"[fx:ZZ] business=nobody; Again."' }, config: { model_setting: "inbox_question_ai", tool: "none", answer: { response: { type: "string", description: "" } }, user_location: false, keep_na: true } }],
  });
  check("... and a reasoning effort only when its setting has one", net.bodies.at(-1)?.reasoning?.effort === "low");
  // One send per attempt; a third send with no answer refused.
  const lostCo = company("lost", "Harborview Dental Lost", { website: null, domain: null });
  const lostRow = await addCompanyRow(A, lostCo);
  net.openaiFail = [0];
  const l1 = await work(lostRow);
  net.openaiFail = [0];
  const l2 = await work(lostRow);
  const l3 = await work(lostRow);
  check("an OpenAI answer lost: sent once per attempt, the row tried again later",
    l1.status === "queued" && l2.status === "queued" && l1.paid.openai === 1 && l2.paid.openai === 1 && l1.cell("companys_website")?.status === "error",
    JSON.stringify([l1.status, l2.status, l1.paid.openai, l2.paid.openai]));
  check("... and after two sends with no answer it is not sent again (it may have been billed)", l3.paid.openai === 0 && l3.status === "error" && /Sent 2 times with no answer/.test(l3.cell("companys_website")?.note ?? ""), l3.cell("companys_website")?.note);
  const billCo = company("bill", "Harborview Dental Billing");
  net.openaiFail = [{ status: 429, body: { error: { code: "insufficient_quota", message: "made up" } } }];
  const bill = await runCompany(A, billCo);
  check("a billing 429 is never sent again: one call, the row in error", bill.w.paid.openai === 1 && bill.w.status === "error" && /billing \(insufficient_quota\)/.test(bill.cells.email_extraction_claygent?.note ?? ""), bill.cells.email_extraction_claygent?.note);
  const searchCo = company("search", "Harborview Dental Searches");
  plan("C31", searchCo, { company_emails_found: "N/A" });
  net.searchItems = [{ type: "web_search_call" }, { type: "web_search_call", action: { type: "open_page" } }, { type: "web_search_call", action: { type: "search" } }];
  const searchRun = await runCompany(A, searchCo);
  net.searchItems = null;
  const runRec = await one(`SELECT response FROM enrich_cell_runs WHERE row_id = $1 AND column_key = 'email_extraction_claygent' ORDER BY id DESC LIMIT 1`, [searchRun.rowId]);
  check("a web_search_call with no action counts as a search, an open_page does not", runRec?.response?.web_searches === 2, JSON.stringify(runRec?.response));
  check("... and the call's cost is counted from its usage", typeof runRec?.response?.cost_usd === "number" && runRec.response.cost_usd > 0);
  const mem = await one(`SELECT key FROM enrich_memory WHERE kind = 'companys_website_v1' AND row_id = $1`, [c3b.rowId]);
  check("a remembered AI answer is keyed by the model and the prompt, hashed (enrich_memory's key)", /^sha256:[0-9a-f]{64}$/.test(mem?.key ?? ""), mem?.key);
  const twoOffices = company("offices", "Harborview Dental Offices", { website: null, domain: null });
  const officeB = { ...twoOffices, id: `pvtest-${RUN}-o-${++seq}`, location: { headquarter: PEORIA, locations: [PEORIA] } };
  await runCompany(A, twoOffices);
  await runCompany(A, officeB);
  check("two offices of one company each pay for C#24 (its prompt names the office)", openaiFor("C24", twoOffices) === 2);
  const swapped = settingsWith({ spend_caps: HIGH_CAPS, models: { ...BASE_ROWS.find((r) => r.key === "models")?.value, companys_website: { model: "gpt-6-luna-test", max_searches: 3 } } });
  const swapB = await runCompany(B, { ...noDomain, id: `pvtest-${RUN}-s-${++seq}` }, { settings: swapped });
  const sameB = await runCompany(B, { ...listing, id: `pvtest-${RUN}-t-${++seq}` });
  check("another client's row for the same office reuses the answer with the same model, and pays again with another",
    openaiFor("C24", noDomain) === 2 && net.bodies.some((x) => x?.model === "gpt-6-luna-test") && /^Reused/.test(sameB.cells.companys_website?.note ?? "") && swapB.cells.companys_website?.status === "done",
    JSON.stringify({ calls: openaiFor("C24", noDomain), note: sameB.cells.companys_website?.note }));

  section("C11. Quirks, verbatim");
  const canada = await runCompany(A, company("maple", "Maple Dental", { domain: `maple-${RUN}.ca`, website: `https://www.maple-${RUN}.ca` }));
  check("quirk 6: \".ca\" in C#26's list drops a Canadian website", !valueOf(canada.cells, "use_website") && canada.s.outcome === "No working website" && net.calls.refused === 0);
  check("quirk 10: C#24 joins the city and the state with no space", /place=SpringfieldIL;/.test(c24Body?.input ?? ""), (c24Body?.input ?? "").slice(0, 160));
  const heldNoDomain = company("held2", "Harborview Dental Held Two", { website: null, domain: null });
  await lead(`kate@${dom("held2")}`, { company: nameOf(heldNoDomain), email_type: "personal", state: "IL", first_name: "Kate", last_name: "Held" });
  const q15 = await runCompany(A, heldNoDomain);
  check("quirk 15: C#24 has no SAFE TO RUN clause, so a held company still pays for its website search", valueOf(q15.cells, "safe_to_run") === false && openaiFor("C24", heldNoDomain) === 1);
  const p8 = (await one(`SELECT run_if FROM enrich_columns WHERE table_id = $1 AND key = 'lookup_company_data'`, [tables[A].people])).run_if;
  check("quirk 14: P#8's run condition keeps its single \"|\"", p8 === "!!{{full_name}} | !!{{company_website}}", p8);
  return { c3a, c4a, c4b, c5a, c6, cp, cp2, pCo };
}

// ── D. Projections and listing ──────────────────────────────────────────────

async function partD(c) {
  section("D1. enrich_contacts");
  const inboxRows = await all(`SELECT r.id FROM enrich_rows r WHERE r.table_id = ANY($1::uuid[]) AND r.run_status IN ('done', 'waiting', 'error')`, [[tables[A].inboxes, tables[B].inboxes]]);
  const contacts = await all(`SELECT row_id FROM enrich_contacts WHERE kind = 'general' AND row_id = ANY($1::bigint[])`, [inboxRows.map((r) => r.id)]);
  check("one summary per finished inbox row", inboxRows.length > 10 && contacts.length === inboxRows.length, `${contacts.length} of ${inboxRows.length}`);
  const s = contactSummary("person", { person_outcome: "Approved email", use_work_email: "A@B.example", question: "how do you ...?", track: "ceo", stage: "bought", company_row: "12", rank: "2" });
  check("a contact's verdict, usable and has_question from its row's values", s.verdict === "approved" && s.usable && s.has_question && s.email === "a@b.example" && s.company_row_id === 12 && s.rank === 2);

  section("D2. Listing");
  const listedOf = async (rowId) => (await summaryOf(rowId))?.listed === true;
  const peopleOnly = company("ponly", "Lakeview People Only");
  plan("C31", peopleOnly, { company_emails_found: "N/A" });
  const po = await runCompany(P, peopleOnly);
  check("no usable email: not listed", (await summaryOf(po.rowId)).listed === false && (await summaryOf(po.rowId)).outcome === "No general email found");
  net.reoon.set(at("ponly", "pat"), "safe");
  const pat = await addPersonRow(P, { companyRowId: po.rowId, key: `pvtest-pat-${RUN}`, person: madeUpPerson("Pat", "Person", peopleOnly), email: at("ponly", "pat"), website: valueOf(po.cells, "use_website") });
  const patW = await work(pat, { settings: SP });
  const patC = await one(`SELECT * FROM enrich_contacts WHERE row_id = $1`, [pat]);
  check("a bought person's email checked by P#11 to P#56: Approved email, usable", patW.values.person_outcome === "Approved email" && patC?.usable === true && patC.verdict === "approved" && patC.email === at("ponly", "pat") && patC.track === "operations" && patC.found_by === "aiark", JSON.stringify({ outcome: patW.values.person_outcome, contact: patC }));
  check("people only: listed, with people emails", (await listedOf(po.rowId)) && (await summaryOf(po.rowId)).outcome === "Has people emails" && (await summaryOf(po.rowId)).people_emails === 1);
  check("the People row's lead fields come from the company row (P#8's record)", patW.values.company === nameOf(peopleOnly) && patW.values.use_domain === dom("ponly") && patW.values.category === "dental" && patW.values.use_address === "100 Main Street, Springfield, IL 62701", JSON.stringify({ company: patW.values.company, domain: patW.values.use_domain, address: patW.values.use_address }));
  check("a general email only: listed (C4)", (await listedOf(c.c4b.rowId)) && (await summaryOf(c.c4b.rowId)).outcome === "Has a general email");
  net.reoon.set(at("aimail", "mia"), "safe");
  const mia = await addPersonRow(A, { companyRowId: c.c4b.rowId, key: `pvtest-mia-${RUN}`, person: madeUpPerson("Mia", "Both", { summary: { name: `Harborview Dental Mail ${RUN}` }, link: { domain: dom("aimail") } }), email: at("aimail", "mia"), website: `https://www.${dom("aimail")}` });
  await work(mia);
  check("both: listed, with general and people emails", (await summaryOf(c.c4b.rowId)).outcome === "General and people emails");
  check("held only: listed as Already in the database (C4)", (await summaryOf(c.c4a.rowId)).outcome === "Already in the database" && (await listedOf(c.c4a.rowId)));
  const waitingCo = company("wco", "Lakeview Waiting");
  const wco = await runCompany(P, waitingCo, { env: { ENRICH_REOON_API_KEY: KEYS.ENRICH_REOON_API_KEY } });
  check("a company row waiting on a key: Waiting for a key, not listed", wco.w.status === "waiting" && (await summaryOf(wco.rowId)).outcome === "Waiting for a key" && !(await listedOf(wco.rowId)));
  net.reoon.set(at("wco", "wes"), "safe");
  const wes = await addPersonRow(P, { companyRowId: wco.rowId, key: `pvtest-wes-${RUN}`, person: madeUpPerson("Wes", "Waits", waitingCo), email: at("wco", "wes"), website: `https://www.${dom("wco")}` });
  await work(wes, { settings: SP });
  check("... with an approved person: listed (its passes cells are known)", await listedOf(wco.rowId), (await summaryOf(wco.rowId))?.outcome);
  const twin = { ...company("aimail", "Harborview Dental Mail Twin", { email: at("aimail", "office") }) };
  const tw = await runCompany(A, twin);
  check("the same company and office twice: listed once, the second Listed under another row, at no cost",
    !(await listedOf(tw.rowId)) && (await summaryOf(tw.rowId)).outcome === "Listed under another row" && tw.w.paid.reoon + tw.followers.reduce((n, f) => n + f.paid.reoon, 0) === 0,
    (await summaryOf(tw.rowId))?.outcome);

  section("D3. People and inbox rows are never projected as companies; v1 rows are never worked");
  const wrong = await one(`SELECT count(*)::int AS n FROM enrich_companies WHERE table_id = ANY($1::uuid[])`, [Object.values(tables).flatMap((x) => [x.inboxes, x.people])]);
  const peopleRows = await all(`SELECT id FROM enrich_rows WHERE table_id = ANY($1::uuid[]) AND run_status IN ('done', 'waiting', 'error')`, [Object.values(tables).map((x) => x.people)]);
  const peopleContacts = await one(`SELECT count(*)::int AS n FROM enrich_contacts WHERE row_id = ANY($1::bigint[]) AND kind = 'person'`, [peopleRows.map((r) => r.id)]);
  check("no inbox or People row in enrich_companies; every finished People row in enrich_contacts", wrong.n === 0 && peopleRows.length > 3 && peopleContacts.n === peopleRows.length, JSON.stringify({ wrong: wrong.n, people: peopleRows.length, contacts: peopleContacts.n }));
  const v1Tag = tag("V1");
  await pool.query(`INSERT INTO client_tags (tag, name) VALUES ($1, 'Pipeline test V1')`, [v1Tag]);
  const { rows: [v1] } = await pool.query(`INSERT INTO enrich_tables (client_tag, kind, name, template) VALUES ($1, 'companies', 'Companies (pipeline)', 'companies_v1') RETURNING id`, [v1Tag]);
  const { rows: [v1row] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, 'aiark:pvtest-v1', 'queued') RETURNING id`, [v1.id]);
  const cl = await pool.connect();
  let claimed = [];
  try {
    await cl.query("BEGIN");
    claimed = (await cl.query(WORKER_SQL.claim, [randomUUID(), 100_000, ["companies_v1"]])).rows.map((r) => Number(r.id));
  } finally {
    await cl.query("ROLLBACK");
    cl.release();
  }
  check("the worker's claim never takes a row of a companies_v1 table", !claimed.includes(Number(v1row.id)) && (await one(`SELECT run_status FROM enrich_rows WHERE id = $1`, [v1row.id])).run_status === "queued");

  section("D5. Nothing reaches the lead database");
  const leadCount = await one(`SELECT count(*)::int AS n FROM leads`);
  const pushCount = await one(`SELECT count(*)::int AS n FROM push_items`);
  check("leads and push_items: only the test's own made-up leads were added", leadCount.n === baseline.leads + created.leads && pushCount.n === baseline.push, JSON.stringify({ leads: leadCount.n, base: baseline.leads, ours: created.leads }));
}

// ── E. The email finders and Enrichley ──────────────────────────────────────

async function partE() {
  const finderCo = company("finder", "Lakeview Finders");
  plan("C31", finderCo, { company_emails_found: "N/A" });
  const fc = await runCompany(P, finderCo);
  const site = valueOf(fc.cells, "use_website");
  const person = (first, last, opts) => madeUpPerson(first, last, finderCo, opts);
  const addNoEmail = (first, last, opts = {}) => addPersonRow(P, { companyRowId: fc.rowId, key: `pvtest-${first.toLowerCase()}-${RUN}`, person: person(first, last, opts), stage: "no_email", website: opts.website === undefined ? site : opts.website });

  section("E1. Without their keys");
  const nora = await addNoEmail("Nora", "Nokey");
  const n1 = await work(nora, { settings: SP });
  const needs = (k) => n1.cell(k)?.status === "skipped" ? n1.cell(k).note : `${n1.cell(k)?.status}: ${n1.cell(k)?.note}`;
  check("each finder shows the key it needs, in the originals' order",
    needs("find_work_email_findymail") === absentKeyNote("FINDYMAIL_API_KEY") && needs("find_work_email_prospeo") === absentKeyNote("PROSPEO_API_KEY") &&
      needs("find_work_email_anymail_finder") === absentKeyNote("ANYMAIL_FINDER_API_KEY") && needs("find_work_email_from_linkedin_url_findymail") === absentKeyNote("FINDYMAIL_API_KEY") &&
      needs("find_work_email_and_enrich_person_from_linkedin_url") === absentKeyNote("PROSPEO_API_KEY") && needs("find_work_email_from_linkedin_url_anymail_finder") === absentKeyNote("ANYMAIL_FINDER_API_KEY"),
    JSON.stringify(["find_work_email_findymail", "find_work_email_prospeo", "find_work_email_anymail_finder", "find_work_email_from_linkedin_url_findymail"].map(needs)));
  check("... and never makes the row wait: it ends done, No email, with no call and no run record",
    n1.status === "done" && n1.values.person_outcome === "No email (AI Ark found none)" && n1.calls === 0 && ["findymail", "prospeo", "anymail", "enrichley"].every((v) => net.calls[v] === 0) && n1.runs.length === 0,
    JSON.stringify({ status: n1.status, outcome: n1.values.person_outcome, calls: n1.calls }));
  check("the Anymail checks that read nothing don't run", n1.cell("validate_email_anymail_finder_find_work_email")?.note === "Run condition not met" && n1.cell("validate_email_anymail_finder_from_linkedin")?.note === "Run condition not met");

  section("E2. With their keys (made up), against stubbed vendors");
  const fiona = await addNoEmail("Fiona", "Findy");
  net.vendors.findymail.set(`Fiona Findy`, `fiona@${dom("finder")}`);
  const f1 = await work(fiona, { env: { ...KEYS, FINDYMAIL_API_KEY: FINDER_KEYS.FINDYMAIL_API_KEY }, settings: SP });
  const fReq = net.requests.find((x) => x.vendor === "findymail");
  check("Findymail by name and domain: its request, and its answer read as the original reads it (.email)",
    fReq?.path === "/api/search/name" && fReq.auth === `Bearer ${FINDER_KEYS.FINDYMAIL_API_KEY}` && fReq.body?.name === "Fiona Findy" && fReq.body.domain === dom("finder") && f1.values.find_work_email_findymail?.email === `fiona@${dom("finder")}`,
    JSON.stringify({ req: { ...fReq, auth: fReq?.auth ? "set" : null }, value: f1.values.find_work_email_findymail }));
  check("... into Valid Work Email and Use Work Email, approved with no Reoon check, as in the original",
    f1.values.valid_work_email === `fiona@${dom("finder")}` && f1.values.use_work_email === `fiona@${dom("finder")}` && f1.values.person_outcome === "Approved email" && !net.verified.includes(`fiona@${dom("finder")}`) && f1.cell("find_work_email_prospeo")?.note === "Run condition not met");
  check("... and the company is listed with a person's email", (await summaryOf(fc.rowId)).outcome === "Has people emails");
  await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [fiona]);
  const findyCalls = net.calls.findymail;
  await work(fiona, { env: { ...KEYS, FINDYMAIL_API_KEY: FINDER_KEYS.FINDYMAIL_API_KEY }, settings: SP });
  check("a second pass makes no repeat call (the cell's cache)", net.calls.findymail === findyCalls);
  const paul = await addNoEmail("Paul", "Prospect");
  net.vendors.prospeo.set("Paul Prospect", `paul@${dom("finder")}`);
  const p1 = await work(paul, { env: { ...KEYS, PROSPEO_API_KEY: FINDER_KEYS.PROSPEO_API_KEY }, settings: SP });
  const pReq = net.requests.find((x) => x.vendor === "prospeo");
  check("Prospeo after Findymail found nothing (its key absent here): .email filled from Enrich Person",
    pReq?.path === "/enrich-person" && pReq.auth === FINDER_KEYS.PROSPEO_API_KEY && pReq.body?.data?.full_name === "Paul Prospect" && pReq.body.data.company_website === dom("finder") && pReq.body.only_verified_email === true &&
      p1.values.find_work_email_prospeo?.email === `paul@${dom("finder")}` && p1.values.use_work_email === `paul@${dom("finder")}`,
    JSON.stringify({ body: pReq?.body, value: p1.values.find_work_email_prospeo }));
  const amy = await addNoEmail("Amy", "Anymail");
  net.vendors.anymail.set("Amy Anymail", { email: `amy@${dom("finder")}`, validation: "valid" });
  const a1 = await work(amy, { env: { ...KEYS, ANYMAIL_FINDER_API_KEY: FINDER_KEYS.ANYMAIL_FINDER_API_KEY }, settings: SP });
  const aReq = net.requests.find((x) => x.vendor === "anymail");
  check("Anymail Finder: the original's request as compiled, the Authorization header the key itself",
    aReq?.path === "/v5.1/fixture/person" && aReq.auth === FINDER_KEYS.ANYMAIL_FINDER_API_KEY && aReq.body?.full_name === "Amy Anymail" && aReq.body.domain === dom("finder") && aReq.body.company_name === nameOf(finderCo),
    JSON.stringify({ path: aReq?.path, body: aReq?.body }));
  check("... its answer kept as sent: P#50 reads results.email when results.validation is valid; P#49 shows the Enrichley key it needs",
    a1.values.valid_work_email === `amy@${dom("finder")}` && a1.values.use_work_email === `amy@${dom("finder")}` && a1.cell("validate_email_anymail_finder_find_work_email")?.note === absentKeyNote("ENRICHLEY_API_KEY"));
  const una = await addNoEmail("Una", "Unknown");
  net.vendors.anymail.set("Una Unknown", { email: `una@${dom("finder")}`, validation: "unknown" });
  net.vendors.enrichley.set(`una@${dom("finder")}`, { valid: true, result: "catch_all_validated" });
  const u1 = await work(una, { env: { ...KEYS, ANYMAIL_FINDER_API_KEY: FINDER_KEYS.ANYMAIL_FINDER_API_KEY, ENRICHLEY_API_KEY: FINDER_KEYS.ENRICHLEY_API_KEY }, settings: SP });
  const eReq = net.requests.find((x) => x.vendor === "enrichley");
  check("an Anymail address not valid: Enrichley (P#49) checks it, and its answer (.valid, .email) decides",
    eReq?.path === "/api/v1/validate-single-email" && eReq.auth === FINDER_KEYS.ENRICHLEY_API_KEY && eReq.body?.email === `una@${dom("finder")}` && u1.values.validate_email_anymail_finder_find_work_email?.valid === true && u1.values.valid_work_email === `una@${dom("finder")}`,
    JSON.stringify({ value: u1.values.validate_email_anymail_finder_find_work_email, valid: u1.values.valid_work_email }));
  const lena = await addNoEmail("Lena", "Linked", { website: null });
  net.vendors.findymail.set(`https://linkedin.${HOST}/in/lena-${RUN}`, `lena@${dom("finder")}`);
  const l1 = await work(lena, { env: { ...KEYS, FINDYMAIL_API_KEY: FINDER_KEYS.FINDYMAIL_API_KEY }, settings: SP });
  const lReq = net.requests.filter((x) => x.vendor === "findymail").at(-1);
  check("no domain for the name search: Findymail by LinkedIn URL (P#51), read as .email into Use Work Email",
    lReq?.path === "/api/search/business-profile" && lReq.body?.linkedin_url === `https://linkedin.${HOST}/in/lena-${RUN}` && l1.cell("find_work_email_findymail")?.note === "Run condition not met" && l1.values.use_work_email === `lena@${dom("finder")}`,
    JSON.stringify({ path: lReq?.path, use: l1.values.use_work_email, p46: l1.cell("find_work_email_findymail")?.note }));
  net.vendorFail.findymail = 401;
  const rex = await addNoEmail("Rex", "Refused");
  const r1 = await work(rex, { env: { ...KEYS, FINDYMAIL_API_KEY: FINDER_KEYS.FINDYMAIL_API_KEY }, settings: SP });
  check("a vendor refusing the key: an error that is not tried again, naming the key but never its value",
    r1.cell("find_work_email_findymail")?.status === "error" && r1.cell("find_work_email_findymail").note === "Findymail refused FINDYMAIL_API_KEY (HTTP 401)" && r1.status === "error");

  section("E3. Enrichley on general and personal addresses (G#41, P#13)");
  const enCo = company("enrich", "Harborview Dental Enrichley");
  reoon({ [at("enrich", "info")]: "role_account", [at("enrich", "contact")]: "catch_all" });
  net.vendors.enrichley.set(at("enrich", "info"), { valid: true, result: "ok" });
  net.vendors.enrichley.set(at("enrich", "contact"), { valid: false, result: "invalid" });
  plan("C31", enCo, { company_emails_found: `${at("enrich", "info")}, ${at("enrich", "contact")}` });
  const ec = await runCompany(A, enCo, { env: { ...KEYS, ENRICHLEY_API_KEY: FINDER_KEYS.ENRICHLEY_API_KEY } });
  const eo = (email) => valueOf(ec.inboxes.find((i) => valueOf(i.cells, "general_email") === email)?.cells ?? {}, "inbox_outcome");
  check("role_account, then Enrichley valid: Approved (G#42, G#44)", eo(at("enrich", "info")) === "Approved");
  check("catch_all, then Enrichley not valid: Rejected by Enrichley", eo(at("enrich", "contact")) === "Rejected by Enrichley");
  check("... and the result field (G#43) is Enrichley's", valueOf(ec.inboxes.find((i) => valueOf(i.cells, "general_email") === at("enrich", "contact"))?.cells ?? {}, "result") === "invalid");
  net.reoon.set(at("finder", "carla"), "catch_all");
  net.vendors.enrichley.set(at("finder", "carla"), { valid: true, result: "catch_all_validated" });
  const carla = await addPersonRow(P, { companyRowId: fc.rowId, key: `pvtest-carla-${RUN}`, person: person("Carla", "Catch"), email: at("finder", "carla"), website: site });
  const c1 = await work(carla, { env: { ...KEYS, ENRICHLEY_API_KEY: FINDER_KEYS.ENRICHLEY_API_KEY }, settings: SP });
  check("a person's catch-all email: P#13 checks it, P#14 approves it, P#15 takes it", c1.values.enrichly_stamp_of_approval === true && c1.values.final_validated_email === at("finder", "carla") && c1.values.person_outcome === "Approved email");
  const carlaNoKey = await addPersonRow(P, { companyRowId: fc.rowId, key: `pvtest-carl-${RUN}`, person: person("Carl", "Catch"), email: at("finder", "carl"), website: site });
  net.reoon.set(at("finder", "carl"), "catch_all");
  const cn = await work(carlaNoKey, { settings: SP });
  check("... without the key: Waiting for Enrichley, and the row ends done", cn.values.person_outcome === "Waiting for Enrichley" && cn.status === "done" && cn.cell("enrichly_validation")?.note === absentKeyNote("ENRICHLEY_API_KEY"));

  section("E4. The keys stay out of every cell and run record, and their rows come back when a key is set");
  const leaked = await one(
    `SELECT count(*)::int AS n FROM (
       SELECT value::text || coalesce(note, '') AS t FROM enrich_cells WHERE table_id = ANY($1::uuid[])
       UNION ALL
       SELECT coalesce(request::text, '') || coalesce(response::text, '') || coalesce(error, '') FROM enrich_cell_runs r JOIN enrich_rows x ON x.id = r.row_id WHERE x.table_id = ANY($1::uuid[])
     ) s WHERE ${Object.values(FINDER_KEYS).map((_, i) => `strpos(s.t, $${i + 2}) > 0`).join(" OR ")}`,
    [Object.values(tables).flatMap((x) => [x.companies, x.inboxes, x.people]), ...Object.values(FINDER_KEYS)]
  );
  check("no made-up key in any cell or run record", leaked.n === 0, `${leaked.n} found`);
  const elsewhere = await one(
    `SELECT count(*)::int AS n FROM enrich_cells c JOIN enrich_tables t ON t.id = c.table_id
      WHERE t.template IS NOT NULL AND c.status = 'skipped' AND c.note = ANY($1::text[]) AND NOT starts_with(t.client_tag, $2)`,
    [OPTIONAL_KEYS.map(absentKeyNote), PREFIX]
  );
  if (elsewhere.n) {
    check("no other client's rows wait on a key (the re-queue would take them too)", false, `${elsewhere.n} cells`);
  } else {
    const none = await requeueRowsForHeldKeys(pool, {}, { keys: OPTIONAL_KEYS, noteOf: absentKeyNote });
    const withFindy = await requeueRowsForHeldKeys(pool, { FINDYMAIL_API_KEY: FINDER_KEYS.FINDYMAIL_API_KEY }, { keys: OPTIONAL_KEYS, noteOf: absentKeyNote, pageSize: 2 });
    const noraNow = await one(`SELECT run_status FROM enrich_rows WHERE id = $1`, [nora]);
    check("with no key held, nothing is queued again; with Findymail's set, the rows its steps skipped are",
      none.queued === 0 && withFindy.queued >= 2 && noraNow.run_status === "queued" && JSON.stringify(withFindy.keys) === '["FINDYMAIL_API_KEY"]',
      JSON.stringify({ none, withFindy, nora: noraNow.run_status }));
    net.vendors.findymail.set("Nora Nokey", `nora@${dom("finder")}`);
    const n2 = await work(nora, { env: { ...KEYS, FINDYMAIL_API_KEY: FINDER_KEYS.FINDYMAIL_API_KEY }, settings: SP });
    check("... and then the step runs", n2.values.use_work_email === `nora@${dom("finder")}` && n2.values.person_outcome === "Approved email");
    await pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE table_id = ANY($1::uuid[]) AND run_status = 'queued'`, [Object.values(tables).flatMap((x) => [x.companies, x.inboxes, x.people])]);
  }
}

// ── F. Personalisation ──────────────────────────────────────────────────────

async function partF() {
  section("F. Personalisation (P#57 to P#62, G#45 to G#50): compiled, switched off");
  const pzCo = company("pz", "Harborview Dental Personal");
  net.reoon.set(at("pz", "office"), "safe");
  plan("C31", pzCo, { company_emails_found: at("pz", "office") });
  const off = await runCompany(A, pzCo);
  const inbox = off.inboxes[0];
  check("off: the question steps are Switched off, nothing called", ["email_domain", "email_host_lookup_google_dns", "claygent", "question_ai", "question"].every((k) => inbox?.cells[k]?.note === "Switched off: personalisation") && net.calls.dns === 0);
  const on = settingsWith({ spend_caps: HIGH_CAPS, personalisation: { enabled: true, tags: [A], shared_text_ok: false } });
  await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [inbox.id]);
  const w = await work(inbox.id, { settings: on });
  check("on for a client with its own originals: the MX lookup calls Google's DNS only, the summary search runs",
    w.cell("email_host_lookup_google_dns")?.status === "done" && net.calls.dns === 1 && w.cell("claygent")?.status === "done" && net.calls.refused === 0);
  check("... and the question waits for Clay's table examples (D38): no question is written", /table examples/.test(w.cell("question_ai")?.note ?? "") && !w.values.question && (await one(`SELECT has_question FROM enrich_contacts WHERE row_id = $1`, [inbox.id])).has_question === false);
  const shared = settingsWith({ spend_caps: HIGH_CAPS, personalisation: { enabled: true, tags: [A], shared_text_ok: false } });
  const def = await runRow({
    row: { id: 0, created_at: new Date() }, table: { client_tag: A, template: "inboxes_v1", variant: "default" }, cells: new Map(), env: KEYS, db: null, settings: shared,
    columns: [{ key: "email_domain", name: "Email Domain", kind: "formula", formula: '"x"', config: { flag: ["personalisation"] }, phase: 1, position: 1 }],
  });
  check("... while a client on the default originals stays off unless shared_text_ok", def.values.email_domain === undefined);
}

// ── Run ─────────────────────────────────────────────────────────────────────

const baseline = { leads: 0, push: 0 };
let spendBefore = null;

async function cleanup() {
  const tbl = (await all(`SELECT id FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  await pool.query(`DELETE FROM aiark_people_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM enrich_memory WHERE starts_with(client_tag, $1) OR table_id = ANY($2::uuid[])`, [PREFIX, tbl]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tbl]);
  await pool.query(`DELETE FROM enrich_originals WHERE starts_with(variant, 'pvtest')`);
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM suppressed_emails WHERE reason = $1 OR email LIKE $2`, [SUPPRESS_REASON, `%.${HOST}`]);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, $1)`, [PREFIX]);
  if (spendBefore) {
    await pool.query(`DELETE FROM enrich_spend_daily WHERE NOT ((day::text || kind) = ANY($1::text[]))`, [spendBefore.map((r) => `${r.day}${r.kind}`)]);
    for (const r of spendBefore) await pool.query(`UPDATE enrich_spend_daily SET used = $3 WHERE day::text = $1 AND kind = $2`, [r.day, r.kind, r.used]);
  }
}

const t0 = Date.now();
try {
  const ready = await one(`SELECT to_regclass('public.enrich_contacts') IS NOT NULL AS ok`);
  if (!ready.ok) throw new Error("migration 125 is not in this database");
  await cleanup();
  spendBefore = await all(`SELECT day::text AS day, kind, used::text AS used FROM enrich_spend_daily`);
  Object.assign(baseline, { leads: (await one(`SELECT count(*)::int AS n FROM leads`)).n, push: (await one(`SELECT count(*)::int AS n FROM push_items`)).n });
  BASE_ROWS.push(...(await all(`SELECT key, value FROM enrich_settings`)));
  SA = settingsWith({ spend_caps: HIGH_CAPS });
  SQ = settingsWith({ spend_caps: HIGH_CAPS, people_pipeline: { enabled: true, tags: [P, Q], ai_searches: false } });
  SP = settingsWith({ spend_caps: HIGH_CAPS, people_pipeline: { enabled: true, tags: [P, Q], ai_searches: true } });
  for (const t of [A, B]) await addClient(t, { places: [IL("Springfield"), IL("Peoria")], terms: ["janitorial"] });
  for (const t of [P, Q]) await addClient(t, { places: [IL("Springfield")] });
  resetClientChecks();
  resetCompanyActions();
  check("the made-up originals compile into each client's tables", Object.values(tables).every((x) => x.variant.startsWith("pvtest")) && (await one(`SELECT count(*)::int AS n FROM enrich_columns WHERE table_id = $1 AND inputs->>'prompt' LIKE $2`, [tables[A].companies, `%${FIXTURE_MARKER}%`])).n > 0);
  const c = await partC();
  await partD(c);
  await partE();
  await partF();
  check("nothing tried to reach any other address", net.calls.refused === 0, `${net.calls.refused} refused`);
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE starts_with(tag, $1)) AS clients,
            (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1)) AS tables,
            (SELECT count(*)::int FROM enrich_originals WHERE starts_with(variant, 'pvtest')) AS originals,
            (SELECT count(*)::int FROM enrich_memory WHERE starts_with(client_tag, $1)) AS memory,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2) AS leads,
            (SELECT count(*)::int FROM email_validations WHERE email LIKE $2) AS validations,
            (SELECT count(*)::int FROM aiark_people_runs WHERE starts_with(client_tag, $1)) AS people_runs`,
    [PREFIX, `%.${HOST}`]
  );
  const spendBack = spendBefore ? JSON.stringify(await all(`SELECT day::text AS day, kind, used::text AS used FROM enrich_spend_daily`)) === JSON.stringify(spendBefore) : true;
  const clean = Object.values(left).every((n) => n === 0) && spendBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, spendBack })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
