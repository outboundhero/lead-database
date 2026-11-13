// The Companies template, version 2 (enrich_tables.template = 'companies_v2',
// "Companies (pipeline)"): the only Companies template a pull uses. It keeps
// phase 1's inputs, client-rule checks and database checks (T#1 to T#26 of
// company-template.mjs) and compiles every other step from the
// original Clay Companies table (C#n) in enrich_originals (2A.2).
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

export const COMPANY_TEMPLATE_V2 = "companies_v2";
/** The same name as phase 1's table: a client with a companies_v1 table is refused until Akeesh decides (D24). */
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
  23: "clearbit", // no such column: empty (no key)
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
 * the table's own tag, written by the pull on every row.
 */
export const COMPANY_INPUT_KEYS_V2 = Object.freeze([
  "company", "aiark_id", "website", "domain", "linkedin", "phone", "aiark_email", "industry", "employees",
  "company_type", "description", "offices", "office_count", "aiark_updated", "pulled_before", "source", "client_tag",
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
  { key: "fit_score", from: null, kind: "action", action: "later", phase: 3, note: "Phase 3: becomes fit_lookup (Builder C), the shared score on the row." },
  { key: "home_office", from: null, kind: "action", action: "later", phase: 3, note: "Phase 3: becomes fit_lookup (Builder C)." },
]);

/**
 * The run-condition changes of D10, as exact replacements in the compiled
 * run_if (after the ids are rewritten to keys). The `find` texts are the
 * originals' finder clauses.
 *
 * TODO(A): fill `find` from the compiled originals and check each matches once
 * (applyChange); `replace` is ours and final.
 */
export const COMPANY_RUN_IF_CHANGES = Object.freeze({
  company_decision_maker_facilities_1_claygent: {
    in: "run_if",
    find: null,
    replace: "{{people_at_company}}?.tracks?.operations?.settled === true && !{{people_at_company}}?.tracks?.operations?.found && {{use_domain}} && {{check_if_url_is_valid}}?.valid",
    why: "The role finders are not built (D9): AI Ark's people per track take their place, and C#41 stays the fallback of its own track. C#37 ran only with Use Domain and a live URL, so those two gates stay.",
  },
  company_decision_maker_ceo_claygent: {
    in: "run_if",
    find: null,
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

/**
 * The Companies template's enrich_columns rows, compiled from a variant's
 * originals: COMPANY_INPUT_KEYS_V2 as inputs (phase 1's definitions plus
 * client_tag), then COMPANY_COLUMNS_V2: phase 1's T# columns as phase 1
 * defines them, the C# columns through compileColumn() with COMPANY_REFS and
 * the COMPANY_RUN_IF_CHANGES, the G#38 to G#40 instances with
 * AIARK_EMAIL_INSTANCE_REFS, and our own formulas as written here.
 *
 * TODO(A): build it (2A.2), moving T#1 to T#26 out of company-template.mjs
 * before its v1 columns and prompts are deleted.
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @returns {Array<Record<string, any>>}
 */
export function companyColumnsV2(originals) {
  throw new Error(`TODO(A): companyColumnsV2 is not built yet (${originals?.size ?? 0} originals)`);
}
