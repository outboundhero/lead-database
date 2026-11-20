// The Companies template, version 2 (enrich_tables.template = 'companies_v2',
// "Companies (pipeline)"): the only Companies template a pull uses. It keeps
// phase 1's inputs, client-rule checks and database checks (T#1 to T#26 of
// company-template.mjs) and compiles every other step from the
// original Clay Companies table (C#n) in enrich_originals (2A.2). Its rows
// come from AI Ark pulls and, since migration 129, from Google Maps places
// sent to the client's inbound URL (maps-place.mjs), which arrive held.
//
// This public file holds keys, which original each column comes from, our own
// formulas, the changes and the REFS: no prompt and no list.
//
// Order of work (the engine follows the dependencies): the office and the
// client's rules (phase 1), the brand check C#16 and the Master Filter C#17,
// the database check (held inbox, never contact, named people held: C#13 SAFE
// TO RUN), the website chain C#24 to C#29, the first general email (C#30's
// place: a held inbox, else AI Ark's email once Reoon approves it by G#40's
// rule), C#31 then C#32, C#34 and C#36 (each address its own General inboxes
// row), then the people side (people_at_company; with the AI searches on, C#41,
// C#48, C#50, C#56 and their write-tos).

import { compileColumn, instanceMap, refMap } from "./compile-original.mjs";
import { ORIGINAL_KEYS } from "./original-keys.mjs";
import { INBOX_INPUT_KEYS } from "./inbox-template.mjs";
import { PEOPLE_INPUT_KEYS, PEOPLE_REFS, PEOPLE_WRITERS, PEOPLE_WRITTEN_KEYS, writtenKey } from "./people-template.mjs";
import { INBOX_REFS } from "./inbox-template.mjs";

export const COMPANY_TEMPLATE_V2 = "companies_v2";
/** The same name as phase 1's table: a client with a companies_v1 table is refused until the owner decides (D24). */
export const COMPANY_TABLE_NAME_V2 = "Companies (pipeline)";
/** Row key of a company row, as phase 1 writes it (company-runs.mjs). */
export const companyRowKey = (aiarkId) => `aiark:${String(aiarkId).trim()}`;

/**
 * REFS: our overrides on ORIGINAL_KEYS.companies (position to key), where an
 * original's reference must read something else (2A.2).
 */
export const COMPANY_REFS = Object.freeze({
  1: "imported_companies", // our source object (C#1, CHANGE)
  2: "imported_jobs", // no such column: read as empty
  3: "apify_indeed_sources", // no such column: read as empty
  9: "client_tag", // the new input: the table's own tag
  13: "safe_to_run", // ours (D28)
  14: "exclusion_keywords_filter", // ours (D15, M2)
  15: "service_area_check", // ours
  21: "domain", // C#21 and C#22 read the source's domain first: AI Ark's domain
  22: "domain",
  23: "clearbit", // not used: reads empty
  30: "first_general_email", // C#30's place (D8)
  59: "use_address", // phase 1's office address
  66: "additional_category", // no such column: empty
});

/**
 * Keys an original may read that are no column of this template: they read as
 * empty, as when the Clay column did not run. The finder keys appear only in
 * the changes' find text (C#41, C#56).
 */
export const COMPANY_ABSENT_KEYS = Object.freeze([
  "imported_jobs", "apify_indeed_sources", "clearbit", "additional_category",
  "findymail_domain_search_operations", "anymail_operations", "findymail_domain_search_ceo", "anymail_ceo",
]);

/**
 * G#38, G#39 and G#40 compiled a second time onto the company row, to check
 * AI Ark's head-office email (D8): their own references (General inboxes
 * positions) read these company keys.
 */
export const AIARK_EMAIL_INSTANCE_REFS = Object.freeze({
  13: "aiark_email", // the address
  5: "safe_to_run", // C#30, whose place this fills, was gated by C#13
  37: "exclusion_large_company_check", // the company row's own C#16
  38: "aiark_email_qualified",
  39: "aiark_email_reoon",
  40: "aiark_email_approved",
});

/** What is appended to G#39's run condition on the company row (D8). */
export const AIARK_EMAIL_REOON_APPEND = " && {{passes_filters}} && !{{held_usable}} && {{office}}?.hq === true";

/**
 * The input cells a pull writes for each company: phase 1's T#1 to T#16
 * (companyInputs() in company-template.mjs, unchanged), plus client_tag (C#9),
 * the table's own tag, written by the pull on every row, and two a LinkedIn
 * pull writes on its own rows (migration 128): hq_only ("true": the office
 * check judges the head office alone) and linkedin_run (the pull's id: the
 * client's exclusion check also reads that pull's LinkedIn keywords). Both are
 * absent on every other row, which is judged as before 128.
 *
 * A Google Maps place from the client's inbound URL (migration 129) fills the
 * shared ones (company, website, domain, phone, industry, offices,
 * office_count, source, client_tag) and the six Maps inputs below, under the
 * originals' own keys (C#6, C#60, C#62, C#61, C#63 and C#68), so a compiled
 * original that reads one sees the place's value on a Maps row and nothing on
 * an AI Ark row (maps-place.mjs placeInputs).
 */
export const COMPANY_MAPS_INPUT_KEYS = Object.freeze([
  "place_id", "actual_city", "actual_state", "call_city", "call_state", "call_category",
]);

export const COMPANY_INPUT_KEYS_V2 = Object.freeze([
  "company", "aiark_id", "website", "domain", "linkedin", "phone", "aiark_email", "industry", "employees",
  "company_type", "description", "offices", "office_count", "aiark_updated", "pulled_before", "source", "client_tag",
  "hq_only", "linkedin_run",
  ...COMPANY_MAPS_INPUT_KEYS,
]);

/** The switches the people side carries (2A.2). */
const PEOPLE = ["people_pipeline"];
const AI_SEARCH = ["people_pipeline", "ai_searches"];

/**
 * The computed columns, in order. from: "C#n" (compiled from the original),
 * "G#n" (an instance of an inbox original, D8), "T#n" (phase 1's own column,
 * unchanged) or null (ours). Our own formulas are given in full.
 *
 * @type {ReadonlyArray<import("./compile-original.mjs").ColumnSpec & { formula?: string, note?: string, run_if?: string, inputs?: Record<string, string> }>}
 */
export const COMPANY_COLUMNS_V2 = Object.freeze([
  {
    key: "imported_companies", from: "C#1", change: true, kind: "formula",
    formula: "({ name: {{company}}, linkedin_url: {{linkedin}}, domain: {{domain}}, location: {{use_address}}, industry: {{industry}}, description: {{description}} })",
    note: "The object the originals read from Clay's company source, built from AI Ark.",
  },
  { key: "office", from: "T#17", kind: "action", action: "client_office" },
  { key: "use_city", from: "T#18", kind: "formula", note: "C#7's place." },
  { key: "use_state", from: "T#19", kind: "formula", note: "C#8's place: a state code." },
  { key: "use_address", from: "T#20", kind: "formula", note: "C#59's place." },
  { key: "in_area", from: "T#21", kind: "formula" },
  { key: "rule_match", from: "T#22", kind: "action", action: "client_exclusions" },
  { key: "exclusion_keywords_filter", from: "C#14", change: true, kind: "formula", formula: "!{{rule_match}}", note: "The client's own exclusion terms in C#14's place (D15)." },
  { key: "service_area_check", from: "C#15", change: true, kind: "formula", formula: "{{in_area}} === true" },
  { key: "company_linkedin_url", from: "C#20", kind: "formula" },
  { key: "category", from: "C#64", kind: "formula" },
  { key: "sub_category", from: "C#65", kind: "formula" },
  { key: "exclusion_large_company_check", from: "C#16", kind: "formula" },
  { key: "master_filter", from: "C#17", kind: "formula" },
  { key: "passes_filters", from: "T#23", change: true, kind: "formula", formula: "{{master_filter}} === true" },
  { key: "held_email", from: "T#24", kind: "action", action: "held_general_email" },
  { key: "held_usable", from: "T#25", kind: "formula" },
  { key: "never_contact", from: "T#26", kind: "formula" },
  {
    key: "held_people", from: null, kind: "action", action: "held_people",
    run_if: "{{passes_filters}} && !{{never_contact}}",
    inputs: { company: "{{company}}", state: "{{use_state}}", country: "{{office}}?.office?.country" },
    note: "No switch: the database is always checked first (D11, D28).",
  },
  { key: "safe_to_run", from: "C#13", change: true, kind: "formula", formula: "!{{never_contact}} && !({{held_people}}?.count > 0)" },
  { key: "companys_website", from: "C#24", kind: "action", action: "ai_web", model_setting: "companys_website", tool: "web_search" },
  { key: "company_website_response", from: "C#25", kind: "formula" },
  { key: "use_website", from: "C#26", kind: "waterfall" },
  { key: "check_if_url_is_valid", from: "C#27", kind: "action", action: "check_url" },
  { key: "normalize_a_domain", from: "C#28", kind: "action", action: "normalize_url" },
  { key: "use_domain", from: "C#29", kind: "waterfall", note: "Text (the bare domain), not phase 1's { normalizedUrl } object." },
  { key: "aiark_email_qualified", from: "G#38", kind: "formula", note: "G#38 on {{aiark_email}} (AIARK_EMAIL_INSTANCE_REFS)." },
  { key: "aiark_email_reoon", from: "G#39", change: true, kind: "action", action: "reoon_verify", note: "G#39's run condition with AIARK_EMAIL_REOON_APPEND appended." },
  { key: "aiark_email_approved", from: "G#40", kind: "formula" },
  {
    key: "first_general_email", from: "C#30", change: true, kind: "formula",
    formula: "{{held_usable}} ? { emails: [{ email: {{held_email}}?.email }], source: \"database\" } : {{aiark_email_approved}} === true ? { emails: [{ email: {{aiark_email}} }], source: \"aiark\" } : undefined",
    note: "Shaped like Icypeas' answer, so C#31, C#32 and C#34 read it verbatim (D8).",
  },
  { key: "email_extraction_claygent", from: "C#31", kind: "action", action: "ai_web", model_setting: "email_extraction_claygent", tool: "web_search" },
  { key: "email_extraction_claygent_2", from: "C#32", kind: "action", action: "ai_web", model_setting: "email_extraction_claygent_2", tool: "web_search" },
  { key: "extract_urls_and_emails_from_text", from: "C#34", change: true, kind: "action", action: "find_emails_in_text", note: "A named stand-in for Clay's tool (D38): emails only, each tagged with where it was found." },
  { key: "general_email_write_to", from: "C#36", kind: "action", action: "write_to_table", note: "Each address its own General inboxes row, mapping verbatim, at most company_pipeline.inboxes_per_company." },
  {
    key: "people_at_company", from: null, kind: "action", action: "people_at_company", flag: PEOPLE,
    run_if: "{{passes_filters}} && !{{never_contact}}",
    inputs: { held: "{{held_people}}?.count ?? 0" },
    note: "Never cached. Value in pipeline-actions.mjs (PeopleAtCompany).",
  },
  { key: "company_decision_maker_facilities_1_claygent", from: "C#41", change: true, kind: "action", action: "ai_web", model_setting: "company_decision_maker_facilities_1_claygent", tool: "web_search", flag: AI_SEARCH, note: "Run condition: the finder clauses replaced by the operations track settled with nobody found, with a live website (D10)." },
  { key: "person_2_name_check", from: "C#42", kind: "formula", flag: PEOPLE },
  { key: "person_2_facilities_1_write_to", from: "C#43", kind: "action", action: "write_to_table", flag: PEOPLE },
  { key: "company_decision_maker_facilities_2_claygent", from: "C#48", kind: "action", action: "ai_web", model_setting: "company_decision_maker_facilities_2_claygent", tool: "web_search", flag: AI_SEARCH },
  { key: "person_3_name_check", from: "C#49", kind: "formula", flag: PEOPLE },
  { key: "company_decision_maker_location_company_check", from: "C#50", kind: "action", action: "ai_web", model_setting: "company_decision_maker_location_company_check", tool: "web_search", flag: [...AI_SEARCH, "linkedin_profile_reads"] },
  { key: "person_3_facilities_2_write_to", from: "C#51", kind: "action", action: "write_to_table", flag: PEOPLE },
  { key: "company_decision_maker_ceo_claygent", from: "C#56", change: true, kind: "action", action: "ai_web", model_setting: "company_decision_maker_ceo_claygent", tool: "web_search", flag: AI_SEARCH, note: "Run condition: the finder clauses replaced by the CEO track settled with nobody found (D10)." },
  { key: "person_1_name_check", from: "C#57", kind: "formula", flag: PEOPLE },
  { key: "person_1_ceo_write_to", from: "C#58", kind: "action", action: "write_to_table", flag: PEOPLE },
  { key: "company_outcome", from: null, kind: "formula" },
  {
    key: "fit_score", from: null, kind: "action", action: "fit_lookup", provider: "Fit score (shared)",
    inputs: { domain: "{{use_domain}}", company: "{{company}}", city: "{{use_city}}", state: "{{use_state}}" },
    config: { show: "score" },
    note: "The shared fit score of this company (company_fit, one per company for every client), by its domain, else its name, city and state. Free and never cached: a score given later shows the next time the row is worked. Empty while the company is not scored.",
  },
  {
    key: "home_office", from: null, kind: "action", action: "fit_lookup", provider: "Fit score (shared)",
    inputs: { domain: "{{use_domain}}", company: "{{company}}", city: "{{use_city}}", state: "{{use_state}}" },
    config: { show: "home_office" },
    note: "The home-office flag beside the shared fit score (fit_lookup). Empty while the company is not scored.",
  },
]);

/**
 * The finder clauses of C#41 and C#56's run conditions, as they read once
 * compiled (built from our keys, so no text of the originals is held here).
 */
const operationsFinders = (fm, am) =>
  `!{{${fm}}}?.contacts?.[0]?.email && {{${fm}}} && !{{${am}}}?.result?.email && ({{${am}}} || !{{${am}}})`;
const ceoFinders = (fm, am) =>
  `((!{{${fm}}}?.contacts?.[0]?.email && {{${fm}}}) || !{{${fm}}}) && !{{${am}}}?.result?.email && ({{${am}}} || !{{${am}}})`;

/**
 * The run-condition changes of D10, as exact replacements in the compiled
 * run_if (after the ids are rewritten to keys). `find` is the originals'
 * finder clauses; the compiler refuses unless it occurs exactly once.
 */
export const COMPANY_RUN_IF_CHANGES = Object.freeze({
  company_decision_maker_facilities_1_claygent: {
    in: "run_if",
    find: operationsFinders(ORIGINAL_KEYS.companies[37], ORIGINAL_KEYS.companies[39]),
    replace: "{{people_at_company}}?.tracks?.operations?.settled === true && !{{people_at_company}}?.tracks?.operations?.found && {{use_domain}} && {{check_if_url_is_valid}}?.valid",
    why: "The role finders are not built (D9): AI Ark's people per track take their place, and C#41 stays the fallback of its own track. C#37 ran only with Use Domain and a live URL, so those two gates stay.",
  },
  company_decision_maker_ceo_claygent: {
    in: "run_if",
    find: ceoFinders(ORIGINAL_KEYS.companies[52], ORIGINAL_KEYS.companies[54]),
    replace: "{{people_at_company}}?.tracks?.ceo?.settled === true && !{{people_at_company}}?.tracks?.ceo?.found",
    why: "The role finders are not built (D9): AI Ark's people per track take their place, and C#56 stays the fallback of its own track. No website term: in Clay C#56 also ran when the CEO finder did not run.",
  },
});

/** The company's own result (ours), the first that applies. The projection adds what its inboxes and people found. */
export const COMPANY_OUTCOMES = Object.freeze([
  "Outside the client's area",
  "Excluded by the client's rules",
  "A large company (brand list)",
  "On the never-contact list",
  "General inbox already in the database",
  "People already in the database",
  "General emails sent to checks",
  "No working website",
  "No general email found",
]);

export const COMPANY_OUTCOME_FORMULA = [
  `!{{in_area}} ? "Outside the client's area"`,
  `: {{rule_match}} ? "Excluded by the client's rules"`,
  `: {{exclusion_large_company_check}} === false ? "A large company (brand list)"`,
  `: {{never_contact}} ? "On the never-contact list"`,
  `: {{held_usable}} ? "General inbox already in the database"`,
  `: {{held_people}}?.count > 0 ? "People already in the database"`,
  `: {{general_email_write_to}}?.written > 0 ? "General emails sent to checks"`,
  `: (!{{use_website}} || /^n\\/?a\\.?$/i.test(String({{use_website}}))) ? "No working website"`,
  `: "No general email found"`,
].join("\n");

/**
 * What enrich_companies.outcome shows: a listed company's, by what it has
 * (relist(), project-contacts.mjs); an unlisted one's own company_outcome,
 * or one of the projection's own words.
 */
export const LISTED_OUTCOMES_V2 = Object.freeze([
  "General and people emails",
  "Has a general email",
  "Has people emails",
  "Already in the database",
]);


// ── Phase 1's own columns, kept as they were (T#1 to T#26) ──────────────────
// Moved here from company-template.mjs, whose v1 columns and prompts are gone.
// The inputs a pull writes (companyInputs() in company-template.mjs fills them),
// the office and the client's rules, and the database checks. Each input names
// who writes it (provider): AI Ark pulls, Google Maps places from the client's
// inbound URL (maps-place.mjs), or both.

const AI_ARK = "AI Ark";
const MAPS = "Google Maps";
const BOTH = "AI Ark or Google Maps";

/** @type {Record<string, Record<string, any>>} */
const PHASE1 = {
  company: { name: "Company", kind: "input", provider: BOTH, description: "The company's name on AI Ark, or the place's name on Google Maps." },
  aiark_id: { name: "AI Ark id", kind: "input", provider: AI_ARK, description: "AI Ark's id for the company. No pull buys a company whose id is already held." },
  website: { name: "Website", kind: "input", provider: BOTH, data_type: "url", description: "AI Ark's website for the company, or the place's website on Google Maps." },
  domain: {
    name: "Domain", kind: "input", provider: BOTH, data_type: "url",
    description: "The bare domain of AI Ark's domain, or of its website. On a Google Maps row, of the place's domain, or of its website.",
  },
  linkedin: { name: "LinkedIn", kind: "input", provider: AI_ARK, data_type: "url" },
  phone: { name: "Phone", kind: "input", provider: BOTH },
  aiark_email: { name: "Email (AI Ark)", kind: "input", provider: AI_ARK, description: "The company email AI Ark lists. Reoon checks it by G#40's rule, only for the head office (D8)." },
  industry: {
    name: "Industry", kind: "input", provider: BOTH,
    description: "AI Ark's industry, or the place's category on Google Maps. C#64 (Category) reads it.",
  },
  employees: { name: "Employees", kind: "input", provider: AI_ARK, description: "AI Ark's headcount figure and band." },
  company_type: { name: "Company type", kind: "input", provider: AI_ARK, hidden: true },
  description: { name: "Description", kind: "input", provider: AI_ARK, hidden: true },
  offices: {
    name: "Offices", kind: "input", provider: BOTH, hidden: true,
    description: "The head office first, then the other offices AI Ark lists, at most 25, as AI Ark writes them. On a Google Maps row, the place itself, as the head office.",
  },
  office_count: { name: "Offices listed", kind: "input", provider: BOTH, hidden: true },
  aiark_updated: { name: "AI Ark updated", kind: "input", provider: AI_ARK, hidden: true, description: "When AI Ark last refreshed the record." },
  pulled_before: {
    name: "Bought before", kind: "input", provider: AI_ARK,
    description: "Filled when AI Ark returned a company an earlier pull had already bought (past its exclusion lists). It was paid for again and is written once.",
  },
  source: {
    name: "Source", kind: "input", provider: BOTH,
    description: "AI Ark pull: bought by the pull. Copied from an earlier pull: bought for any client before, inside this client's places, and copied for free. LinkedIn companies (AI Ark): bought or copied by a LinkedIn pull. LinkedIn people (AI Ark): the company of a person a LinkedIn people run bought. Google Maps: a place the GMaps Scraper app sent to the client's inbound URL.",
  },
  client_tag: { name: "Client tag", kind: "input", provider: BOTH, description: "The table's own client tag, written on every row by the pull or the inbound URL (C#9)." },
  hq_only: {
    name: "Head office only", kind: "input", provider: AI_ARK, hidden: true,
    description: "\"true\" on a LinkedIn pull's rows: only the head office counts for the client's area. Cleared when an AI Ark pull takes the company too, so any office in the area counts again.",
  },
  linkedin_run: {
    name: "LinkedIn pull", kind: "input", provider: AI_ARK, hidden: true,
    description: "The LinkedIn pull that wrote the row: its excluded keywords (the standard ones and the client's own, all of them, sent to AI Ark or not) are checked with the client's exclusion terms. Cleared with Head office only.",
  },
  place_id: {
    name: "Place id", kind: "input", provider: MAPS,
    description: "Google's id for the place, on a Google Maps row (C#6). The row's key is maps: and this id, so each place is stored once per client.",
  },
  actual_city: { name: "Actual city", kind: "input", provider: MAPS, hidden: true, description: "The place's own city on Google Maps (C#60)." },
  actual_state: {
    name: "Actual state", kind: "input", provider: MAPS, hidden: true,
    description: "The place's own state on Google Maps (C#62), as the Maps provider writes it: usually the full name, not a code.",
  },
  call_city: { name: "Searched city", kind: "input", provider: MAPS, hidden: true, description: "The city the scrape searched, from the scraper app's chunk (C#61)." },
  call_state: { name: "Searched state", kind: "input", provider: MAPS, hidden: true, description: "The state the scrape searched, from the scraper app's chunk (C#63)." },
  call_category: { name: "Searched category", kind: "input", provider: MAPS, hidden: true, description: "The category the scrape searched, from the scraper app's chunk (C#68)." },
  office: {
    name: "Office in the client's area", kind: "action", action: "client_office", data_type: "json", provider: "Client rules",
    inputs: { offices: "{{offices}}", hq_only: "{{hq_only}}", place_id: "{{place_id}}" },
    description: "Checks every office against the client's places and excluded places, exactly as the send gate would place a lead there. The head office when it is inside, else the first office inside. Outside: no office is. Can't tell: AI Ark gave no state the lead database could place. On a LinkedIn pull's row only the head office counts: Outside (head office) when it is not inside. On a Google Maps row (its place id is set) the place itself is the one office.",
  },
  use_city: { name: "City", kind: "formula", formula: "{{office}}?.office?.city", description: "The office's city (in C#7's place)." },
  use_state: { name: "State", kind: "formula", formula: "{{office}}?.office?.state", description: "The office's state, as a code (in C#8's place)." },
  use_address: {
    name: "Address", kind: "formula", hidden: true,
    formula: `[{{office}}?.office?.street, {{office}}?.office?.city, [{{office}}?.office?.state, {{office}}?.office?.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ") || undefined`,
    description: "The office's address (in C#59's place).",
  },
  in_area: { name: "Inside the client's area", kind: "formula", data_type: "boolean", formula: "{{office}}?.inside === true" },
  rule_match: {
    name: "Client exclusions", kind: "action", action: "client_exclusions", provider: "Client rules",
    inputs: { company: "{{company}}", industry: "{{industry}}", description: "{{description}}", linkedin_run: "{{linkedin_run}}" },
    description: "The client's exclusion terms: anywhere in the company name or industry, as the send gate matches them, and as whole words in the description. On a LinkedIn pull's row, the pull's excluded keywords too, as whole words in the name, industry and description, as AI Ark matches them.",
  },
  passes_filters: {
    name: "Passes the client's rules", kind: "formula", data_type: "boolean", formula: "{{master_filter}} === true",
    description: "Phase 1's key, now reading C#17's Master Filter: the client's places, C#16's brand list and the client's exclusions.",
  },
  held_email: {
    name: "General inbox in the database", kind: "action", action: "held_general_email", data_type: "json", provider: "Lead database",
    inputs: { domain: "{{domain}}", company: "{{company}}", city: "{{use_city}}", state: "{{use_state}}", country: "{{office}}?.office?.country" },
    run_if: "{{passes_filters}}",
    description: "Looks for this company's general inbox in the lead database, its copy of Email Bison and the never-contact list: 14 role addresses at its domain (info@, office@ ...), then general-inbox leads at the same company in the same city and state. Never contact stops the company. A bounced address is searched past, and never used.",
  },
  held_usable: {
    name: "Usable inbox held", kind: "formula", data_type: "boolean",
    formula: "Boolean({{held_email}}?.email) && !{{held_email}}?.bounced && !{{held_email}}?.never_contact",
  },
  never_contact: { name: "Never contact", kind: "formula", data_type: "boolean", formula: "{{held_email}}?.never_contact === true" },
};

/** Names and descriptions of our own columns (from: null). */
const OURS = {
  held_people: { name: "People held in the database", data_type: "json", provider: "Lead database" },
  people_at_company: { name: "People at the company", data_type: "json", provider: "AI Ark" },
  company_outcome: { name: "Outcome", data_type: "text", formula: COMPANY_OUTCOME_FORMULA, description: "The company's own result. The Companies tab shows what its inboxes and people found when it is listed." },
  fit_score: { name: "Fit score", data_type: "number", provider: "OpenAI" },
  home_office: { name: "Home office", data_type: "boolean", provider: "OpenAI" },
};

/** The cell a write-to fills in its target template: an input as itself, a D30 People column as written_<key>. */
export function writeToCell(kind, key) {
  if (kind === "inboxes") return INBOX_INPUT_KEYS.includes(key) ? key : null;
  if (kind === "people") {
    if (PEOPLE_INPUT_KEYS.includes(key)) return key;
    if (PEOPLE_WRITTEN_KEYS.includes(key)) return writtenKey(key);
  }
  return null;
}

/**
 * The Companies template's enrich_columns rows, compiled from a variant's
 * originals: COMPANY_INPUT_KEYS_V2 as inputs (phase 1's definitions plus
 * client_tag and the Maps inputs, each with the provider its definition
 * names), then COMPANY_COLUMNS_V2: phase 1's T# columns as phase 1
 * defines them, the C# columns through compileColumn() with COMPANY_REFS and
 * the COMPANY_RUN_IF_CHANGES, the G#38 to G#40 instances with
 * AIARK_EMAIL_INSTANCE_REFS, and our own formulas as written here.
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @returns {Array<Record<string, any>>}
 */
export function companyColumnsV2(originals) {
  const own = refMap(originals, "companies", COMPANY_REFS);
  const targets = { inboxes: refMap(originals, "inboxes", INBOX_REFS), people: refMap(originals, "people", PEOPLE_REFS) };
  const instance = instanceMap(originals, "inboxes", AIARK_EMAIL_INSTANCE_REFS);
  const rows = [];
  for (const key of COMPANY_INPUT_KEYS_V2) {
    const p = PHASE1[key];
    if (!p?.provider) throw new Error(`The input ${key} names no provider`);
    rows.push(compileColumn({ key, kind: "input", name: p.name, data_type: p.data_type ?? "text", description: p.description, hidden: p.hidden, provider: p.provider }, originals, { own }));
  }
  for (const spec of COMPANY_COLUMNS_V2) {
    if (String(spec.from ?? "").startsWith("T#")) {
      const p = PHASE1[spec.key];
      if (!p) throw new Error(`No phase 1 column ${spec.key}`);
      const merged = { ...p, ...spec, from: null, name: p.name, change: false };
      rows.push(compileColumn(merged, originals, { own }));
      continue;
    }
    if (!spec.from) {
      const o = OURS[spec.key] ?? {};
      rows.push(compileColumn({ ...spec, name: o.name ?? spec.key, data_type: o.data_type, provider: o.provider, formula: spec.formula ?? o.formula, description: o.description ?? spec.note }, originals, { own }));
      continue;
    }
    if (String(spec.from).startsWith("G#")) {
      const changes = spec.key === "aiark_email_reoon"
        ? [{ in: "run_if", append: AIARK_EMAIL_REOON_APPEND, why: "Checked on the company row only for a company that passes the client's rules, has no usable inbox held, and whose office in the area is the head office (D8)." }]
        : [];
      rows.push(compileColumn({ ...spec, changes, description: spec.note }, originals, { own: instance }));
      continue;
    }
    /** @type {any[]} */
    const changes = COMPANY_RUN_IF_CHANGES[spec.key] ? [COMPANY_RUN_IF_CHANGES[spec.key]] : [];
    const extra = {};
    if (spec.key === "companys_website") extra.memory_days = "website";
    if (spec.key === "extract_urls_and_emails_from_text") {
      extra.inputs = {
        sources: "({ first: {{first_general_email}}, claygent_1: {{email_extraction_claygent}}?.company_emails_found, claygent_2: {{email_extraction_claygent_2}}?.company_emails_found })",
      };
    }
    if (spec.action === "write_to_table" && PEOPLE_WRITERS[spec.key]) extra.config = { writer: { ...PEOPLE_WRITERS[spec.key] } };
    rows.push(compileColumn({ ...spec, ...extra, changes, description: spec.note }, originals, { own, targets, cellFor: writeToCell }));
  }
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}
