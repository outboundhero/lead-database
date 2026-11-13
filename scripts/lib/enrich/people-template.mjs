// The People template (enrich_tables.template = 'people_v1', "People (pipeline)"):
// one row per person at a pipeline company, compiled from the
// original Clay People table (P#n) in enrich_originals (2A.4).
//
// This public file holds keys, which original each column comes from, our own
// formulas and the REFS: no prompt and no list. compile-original.mjs compiles
// the rest from the database.
//
// Who writes People rows:
//   - AI Ark people runs (people-runs.mjs): a person bought (stage bought or
//     no_email), or a person another run already bought, copied free with their
//     email (stage copied). Row key "aiark:<person id>".
//   - The AI searches' write-tos on the company row (C#43, C#51, C#58): row key
//     "w:<company row id>:<writer column key>", stage found, no email until a
//     finder finds one.
// Each writer writes input cells only (PEOPLE_INPUTS); every other column is
// worked by the engine.
//
// The email finders (P#46 to P#54) and Enrichley (P#13 and the finder checks
// P#49, P#54) are real steps, each run only while its key is on the worker
// (config.key_env, pipeline-actions.mjs KEYED_STEPS); without it the step is
// skipped with "Needs <KEY> (not held)", read as empty, and the row never waits.

import { TRACKS } from "./settings.mjs";
import { bareDomain } from "./domain.mjs";

export { TRACKS };
export const PEOPLE_TEMPLATE = "people_v1";
export const PEOPLE_TABLE_NAME = "People (pipeline)";

/** stage: how the row came. */
export const PEOPLE_STAGES = Object.freeze(["bought", "no_email", "copied", "found"]);
/** found_by: who found the person. */
export const PEOPLE_FOUND_BY = Object.freeze(["aiark", "facilities_1", "facilities_2", "ceo"]);
/** The AI searches' write-to columns on the company row, the writer each one is, and its track. */
export const PEOPLE_WRITERS = Object.freeze({
  person_2_facilities_1_write_to: { found_by: "facilities_1", track: "operations" }, // C#43, from C#41
  person_3_facilities_2_write_to: { found_by: "facilities_2", track: "facility_office" }, // C#51, from C#48
  person_1_ceo_write_to: { found_by: "ceo", track: "ceo" }, // C#58, from C#56
});

/** Row keys: an AI Ark person is one row however they came; a write-to's person is one row per company and writer. */
export const aiarkPersonRowKey = (personId) => `aiark:${String(personId).trim()}`;
export const writtenPersonRowKey = (companyRowId, writerKey) => `w:${companyRowId}:${writerKey}`;

/** REFS: our overrides on ORIGINAL_KEYS.people (position to key). P#4's place is the database check. */
export const PEOPLE_REFS = Object.freeze({ 4: "in_database" });

/**
 * People columns that are formulas in the originals but that the write-tos
 * fill (D30): each gets a hidden input written_<key>, and the column becomes
 * a waterfall, the written value first, then the original formula verbatim.
 * P#17, P#20, P#22, P#28, P#31, P#33, P#34, P#43, P#44, P#45.
 */
export const PEOPLE_WRITTEN_KEYS = Object.freeze([
  "company_phone_number", "city", "state", "company", "company_address", "category", "sub_category",
  "full_name", "title", "person_linkedin_url",
]);
export const writtenKey = (key) => `written_${key}`;

/**
 * The input cells a writer may write. Every value is text, except the source
 * object (P#1), which is a JSON object (the originals read it as
 * {{find_people_from_linkedin_company_url}}.name, so it must not be a string).
 *
 * @type {ReadonlyArray<{ key: string, from: string | null, description: string }>}
 */
export const PEOPLE_INPUTS = Object.freeze([
  { key: "find_people_from_linkedin_company_url", from: "P#1", description: "The person source object the originals read, built from AI Ark's record by sourceObject(): { name, last_name, latest_experience_title, latest_experience_company, url, location_name, domain }. A JSON object, not text. Written by AI Ark people runs; empty for write-to people." },
  { key: "email", from: "P#9", description: "The person's email, lower case: AI Ark's (Export Single, or the registry's on a copy). Empty for a person bought with no email and for write-to people." },
  { key: "client_tag", from: "P#26", description: "The table's own tag (the write-tos' mapping writes it too, and must match)." },
  { key: "additional_category", from: "P#35", description: "Always empty: no source fills it." },
  { key: "company_website", from: "P#36", description: "The company row's use_website (C#26), as the write-tos write it. P#37 normalises it into P#38 use_domain." },
  ...PEOPLE_WRITTEN_KEYS.map((k) => ({
    key: writtenKey(k), from: null,
    description: `A value a writer gave ${k}: the write-tos map into it; AI Ark people runs write only written_city and written_state (the person's own place, D13).`,
  })),
  { key: "company_row", from: null, description: "The company row's id (enrich_rows.id of the client's Companies (pipeline) table), as text." },
  { key: "company_aiark_id", from: null, description: "AI Ark's company id." },
  { key: "person_aiark_id", from: null, description: "AI Ark's person id. Empty for write-to people." },
  { key: "found_by", from: null, description: "aiark, facilities_1, facilities_2 or ceo." },
  { key: "stage", from: null, description: "bought, no_email, copied or found." },
  { key: "track", from: null, description: "operations, facility_office or ceo: the candidate's track, or the writer's." },
  { key: "rank", from: null, description: "The candidate's rank in its track (the index of the first phrase its title holds), as text." },
  { key: "person_first_name", from: null, description: "AI Ark's first name." },
  { key: "person_last_name", from: null, description: "AI Ark's last name; a Preview's is masked (\"Ba***e\")." },
  { key: "seniority", from: null, description: "AI Ark's seniority." },
  { key: "department", from: null, description: "AI Ark's departments, up to 3, joined with \", \"." },
  { key: "person_city", from: null, description: "The person's own city, as AI Ark has it." },
  { key: "person_state", from: null, description: "The person's own state, as AI Ark has it." },
  { key: "person_country", from: null, description: "The person's own country, as AI Ark has it." },
  { key: "aiark_email_status", from: null, description: "AI Ark's own check of the email: VALID, INVALID (reason) or PENDING." },
  { key: "aiark_email_domain_type", from: null, description: "SMTP, CATCH_ALL or UNKNOWN, as AI Ark reports the mailbox." },
  { key: "pulled_before", from: null, description: "Filled when the person was bought before by another run (copies)." },
  { key: "source", from: null, description: "Where the row came from, shown on the Clay tab (\"AI Ark people run\", \"Copied from an earlier run (no charge)\", \"AI search (write-to)\")." },
]);

export const PEOPLE_INPUT_KEYS = Object.freeze(PEOPLE_INPUTS.map((c) => c.key));

/**
 * The computed columns, in order. kind and action are what each compiles to;
 * flag: switches (config.flag, settings.mjs flagOn); key_env: the key a keyed
 * step runs with (absent: skipped, never waits); written: a D30 waterfall.
 * Our own formulas are given here in full; every other column's text comes
 * from its original.
 *
 * @type {ReadonlyArray<import("./compile-original.mjs").ColumnSpec & { formula?: string, note?: string }>}
 */
export const PEOPLE_COLUMNS = Object.freeze([
  { key: "in_database", from: "P#4", change: true, kind: "action", action: "lead_lookup", note: "The AI Ark tab's check with explicit inputs (2A.4): email, verdict, first_name ({{first_name}}, P#39), last_name ({{person_last_name}}), full_name, company, domain ({{lookup_company_data}}?.row?.use_domain)." },
  { key: "in_area", from: null, kind: "action", action: "client_area", note: "On {{city}}, {{state}} (P#20, P#22) and {{person_country}} (D13)." },
  { key: "rule_match", from: null, kind: "action", action: "client_exclusions", note: "The company, its industry and description, and the title (cleaning clients)." },
  { key: "safe_to_run", from: "P#5", change: true, kind: "formula", formula: "!{{in_database}}?.lead_id && !{{in_database}}?.in_bison && !{{in_database}}?.never_contact && !{{in_database}}?.bounced" },
  { key: "check", from: "P#7", kind: "waterfall" },
  { key: "lookup_company_data", from: "P#8", change: true, kind: "action", action: "lookup_company_data", note: "The company row by {{company_row}}, run condition verbatim (pipeline-actions.mjs)." },
  { key: "exclusion_large_company_check", from: "P#10", kind: "formula" },
  { key: "reoon_validation", from: "P#11", kind: "action", action: "reoon_verify" },
  { key: "reoon_stamp_of_approval", from: "P#12", kind: "formula" },
  { key: "enrichly_validation", from: "P#13", kind: "action", action: "enrichley_verify_email", key_env: "ENRICHLEY_API_KEY" },
  { key: "enrichly_stamp_of_approval", from: "P#14", kind: "formula" },
  { key: "final_validated_email", from: "P#15", kind: "waterfall" },
  { key: "push_to_email_waterfall", from: "P#16", kind: "formula" },
  { key: "company_phone_number", from: "P#17", kind: "waterfall", written: true },
  { key: "normalize_phone_number", from: "P#18", kind: "action", action: "waiting", note: "Clay's normalize-phone-number: waiting for the original (D38); a stand-in only with Akeesh's OK." },
  { key: "use_phone_number", from: "P#19", kind: "waterfall" },
  { key: "city", from: "P#20", kind: "waterfall", written: true },
  { key: "use_city", from: "P#21", kind: "formula" },
  { key: "state", from: "P#22", kind: "waterfall", written: true },
  { key: "use_state", from: "P#23", kind: "formula" },
  { key: "google_maps_url", from: "P#24", kind: "formula" },
  { key: "use_google_maps_url", from: "P#25", kind: "waterfall" },
  { key: "current_employer", from: "P#27", kind: "action", action: "ai_web", model_setting: "current_employer", tool: "web_search", flag: ["linkedin_profile_reads"] },
  { key: "company", from: "P#28", kind: "waterfall", written: true },
  { key: "normalize_company_name", from: "P#29", kind: "action", action: "waiting", note: "Clay's normalize-company-name: waiting for the original (D38)." },
  { key: "normalized_company_name", from: "P#30", kind: "formula" },
  { key: "company_address", from: "P#31", kind: "waterfall", written: true },
  { key: "use_address", from: "P#32", kind: "waterfall" },
  { key: "category", from: "P#33", kind: "waterfall", written: true },
  { key: "sub_category", from: "P#34", kind: "waterfall", written: true },
  { key: "normalize_a_domain", from: "P#37", kind: "action", action: "normalize_url" },
  { key: "use_domain", from: "P#38", kind: "formula" },
  { key: "first_name", from: "P#39", kind: "formula" },
  { key: "use_first_name", from: "P#41", kind: "formula" },
  { key: "use_last_name", from: "P#42", kind: "formula" },
  { key: "full_name", from: "P#43", kind: "waterfall", written: true },
  { key: "title", from: "P#44", kind: "waterfall", written: true },
  { key: "person_linkedin_url", from: "P#45", kind: "waterfall", written: true },
  { key: "find_work_email_findymail", from: "P#46", kind: "action", action: "findymail_find_work_email", key_env: "FINDYMAIL_API_KEY" },
  { key: "find_work_email_prospeo", from: "P#47", kind: "action", action: "prospeo_find_work_email", key_env: "PROSPEO_API_KEY" },
  { key: "find_work_email_anymail_finder", from: "P#48", kind: "action", action: "anymail_finder", key_env: "ANYMAIL_FINDER_API_KEY" },
  { key: "validate_email_anymail_finder_find_work_email", from: "P#49", kind: "action", action: "enrichley_verify_email", key_env: "ENRICHLEY_API_KEY" },
  { key: "valid_work_email", from: "P#50", kind: "waterfall" },
  { key: "find_work_email_from_linkedin_url_findymail", from: "P#51", kind: "action", action: "findymail_find_work_email_from_linkedin", key_env: "FINDYMAIL_API_KEY" },
  { key: "find_work_email_and_enrich_person_from_linkedin_url", from: "P#52", kind: "action", action: "prospeo_linkedin_email_search", key_env: "PROSPEO_API_KEY" },
  { key: "find_work_email_from_linkedin_url_anymail_finder", from: "P#53", kind: "action", action: "anymail_finder", key_env: "ANYMAIL_FINDER_API_KEY" },
  { key: "validate_email_anymail_finder_from_linkedin", from: "P#54", kind: "action", action: "enrichley_verify_email", key_env: "ENRICHLEY_API_KEY" },
  { key: "use_work_email", from: "P#55", kind: "waterfall" },
  { key: "qualified_work_email", from: "P#56", kind: "formula" },
  { key: "email_domain", from: "P#57", kind: "formula", flag: ["personalisation"] },
  { key: "email_provider_check_api", from: "P#58", kind: "action", action: "dns_mx", flag: ["personalisation"] },
  { key: "claygent", from: "P#60", kind: "action", action: "ai_web", model_setting: "people_claygent", tool: "web_search", flag: ["personalisation"] },
  { key: "question_ai", from: "P#61", kind: "action", action: "ai_web", model_setting: "people_question_ai", tool: "none", flag: ["personalisation"], note: "Its 5 table examples are kept as exported; it does not run until Clay's way of sending them is known (0.4 item 4, D38)." },
  { key: "question", from: "P#62", kind: "formula", flag: ["personalisation"] },
  { key: "person_outcome", from: null, kind: "formula" },
  { key: "add_to_database", from: null, kind: "action", action: "later", phase: 4, note: "Written only by promotion (phase 3); the engine never works it." },
]);

/** The person's outcome (ours): the first that applies. */
export const PERSON_OUTCOMES = Object.freeze([
  "On the never-contact list",
  "Bounced",
  "Already in the database",
  "Outside the client's area",
  "Excluded by the client's rules",
  "Approved email",
  "Not usable: a role or junk address",
  "Rejected by Enrichley",
  "Waiting for Enrichley",
  "Rejected by Reoon",
  "Not checked: a role or junk address",
  "No email (AI Ark found none)",
  "No email yet",
]);

/**
 * person_outcome's formula. "Waiting for Enrichley" tests Reoon's status the
 * way P#13's own run condition does (an exact match, where G#41 matches by
 * substring) and means the Enrichley key is not held: with the key, P#13 has
 * run and its answer decides. "No email yet": a person with no address from
 * AI Ark or any finder (the finders run only with their keys).
 */
export const PERSON_OUTCOME_FORMULA = [
  `{{in_database}}?.never_contact ? "On the never-contact list"`,
  `: {{in_database}}?.bounced ? "Bounced"`,
  `: ({{in_database}}?.lead_id || {{in_database}}?.in_bison) ? "Already in the database"`,
  `: {{in_area}} === false ? "Outside the client's area"`,
  `: {{rule_match}} ? "Excluded by the client's rules"`,
  `: {{qualified_work_email}} === true ? "Approved email"`,
  `: {{use_work_email}} ? "Not usable: a role or junk address"`,
  `: {{enrichly_validation}} ? "Rejected by Enrichley"`,
  `: /^(?:role_account|catch_all|unknown)$/.test({{reoon_validation}}?.status ?? "") ? "Waiting for Enrichley"`,
  `: {{reoon_validation}} ? "Rejected by Reoon"`,
  `: {{email}} ? "Not checked: a role or junk address"`,
  `: {{stage}} === "no_email" ? "No email (AI Ark found none)"`,
  `: "No email yet"`,
].join("\n");

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

/**
 * @typedef {{ name: string, last_name: string, latest_experience_title: string, latest_experience_company: string,
 *             url: string, location_name: string, domain: string }} PersonSource
 */

/**
 * The person source object (P#1's place) from an AI Ark person record: an
 * Export Single answer's data, a registry record, or a Preview item (whose
 * last name is masked). The same field paths as personInputs() in
 * scripts/lib/aiark/client.mjs. Every field is text, "" when AI Ark has none.
 *
 * @param {Record<string, any> | null | undefined} p
 * @returns {PersonSource}
 */
export function sourceObject(p) {
  const prof = p?.profile ?? p?.summary ?? {};
  const co = p?.company ?? {};
  const cs = co.summary ?? {};
  const loc = p?.location ?? {};
  const state = text(loc.state).replace(/\s+metropolitan area$/i, "");
  return {
    name: text(prof.full_name) || [text(prof.first_name), text(prof.last_name)].filter(Boolean).join(" "),
    last_name: text(prof.last_name),
    latest_experience_title: text(prof.title),
    latest_experience_company: text(cs.name ?? co.name),
    url: text(p?.link?.linkedin),
    location_name: [text(loc.city), state, text(loc.country)].filter(Boolean).join(", "),
    domain: bareDomain(co.link?.domain) ?? bareDomain(co.link?.website) ?? "",
  };
}

/**
 * The People template's enrich_columns rows, compiled from a variant's
 * originals: PEOPLE_INPUTS as input columns, then PEOPLE_COLUMNS through
 * compileColumn() with PEOPLE_REFS, the D30 waterfalls for PEOPLE_WRITTEN_KEYS
 * and person_outcome from PERSON_OUTCOME_FORMULA.
 *
 * TODO(A): build it (2A.4, 2B.4). `tracks` is settings.people_tracks, for the
 * column descriptions only.
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @param {import("./settings.mjs").PeopleTracks | null} [tracks]
 * @returns {Array<Record<string, any>>}
 */
export function peopleColumns(originals, tracks = null) {
  throw new Error(`TODO(A): peopleColumns is not built yet (${originals?.size ?? 0} originals, tracks ${tracks ? "set" : "not set"})`);
}
