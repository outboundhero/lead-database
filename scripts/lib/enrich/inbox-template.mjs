// The General template (enrich_tables.template = 'inboxes_v1',
// "General (pipeline)"): one row per general address the company row's
// C#36 wrote, as in Clay, compiled from the original Clay General
// table (G#n) in enrich_originals (2A.3).
//
// This public file holds keys, which original each column comes from, our own
// formulas and the REFS: no prompt and no list.
//
// Row key "w:<company row id>:<address, lower case>". C#36's write-to writes
// the input cells with its mapping verbatim (the keys below), plus our two
// link inputs, company_row and found_in.
//
// Enrichley (G#41) is a real step, run only while ENRICHLEY_API_KEY is on the
// worker: a role, catch-all or unknown address is checked by it then; without
// the key the step is skipped with "Needs ENRICHLEY_API_KEY (not held)", the
// outcome says "Waiting for Enrichley", and the row itself finishes (D6).
//
// G#14, G#16 and G#35 run our exact copies of Clay's normalize-company-name,
// extract-email-components and normalize-phone-number (clay-tools.mjs), with
// the originals' own inputs and run conditions: G#15, G#17, G#18 and G#36 read
// them as in Clay, and G#19 runs as an AI step on its own model setting
// (inbox_first_name_ai). A failure of G#19 is read as empty by the steps after
// it (on_error "empty"), so G#20 gives "<Company> Team" and the row finishes,
// as in Clay.

import { compileColumn, refMap } from "./compile-original.mjs";
import { CLAY_TOOL_ACTIONS, toolInputs } from "./clay-tools.mjs";

export const INBOX_TEMPLATE = "inboxes_v1";
export const INBOX_TABLE_NAME = "General (pipeline)";

/** found_in: where C#34 found the address. */
export const INBOX_FOUND_IN = Object.freeze(["database", "aiark", "claygent_1", "claygent_2"]);

/** Row key of an inbox row. */
export const inboxRowKey = (companyRowId, email) => `w:${companyRowId}:${String(email).trim().toLowerCase()}`;

/** REFS: our overrides on ORIGINAL_KEYS.inboxes (position to key). G#4's place is the database check. */
export const INBOX_REFS = Object.freeze({ 4: "in_database" });

/**
 * The input cells. C#36 writes the first twelve with its mapping verbatim
 * (each from the company row's column named); company_row and found_in are ours.
 *
 * @type {ReadonlyArray<{ key: string, from: string | null, description: string }>}
 */
export const INBOX_INPUTS = Object.freeze([
  { key: "general_email", from: "G#13", description: "The address, from C#34's item (object path \"value\")." },
  { key: "domain", from: "G#31", description: "C#29 use_domain." },
  { key: "website", from: "G#33", description: "C#26 use_website." },
  { key: "phone", from: "G#34", description: "C#67 phone." },
  { key: "state", from: "G#24", description: "C#8 use_state." },
  { key: "client_tag", from: "G#28", description: "C#9 client_tag: the table's own tag." },
  { key: "sub_category", from: "G#9", description: "C#65 sub_category." },
  { key: "category", from: "G#8", description: "C#64 category." },
  { key: "city", from: "G#22", description: "C#7 use_city." },
  { key: "company_address", from: "G#26", description: "C#59 use_address." },
  { key: "company", from: "G#12", description: "C#5 company." },
  { key: "additional_category", from: "G#10", description: "C#66: always empty." },
  { key: "company_row", from: null, description: "The company row's id (enrich_rows.id of the client's Companies (pipeline) table), as text." },
  { key: "found_in", from: null, description: "database, aiark, claygent_1 or claygent_2: where C#34 found the address (shown only)." },
]);

export const INBOX_INPUT_KEYS = Object.freeze(INBOX_INPUTS.map((c) => c.key));

/**
 * The computed columns, in order (see people-template.mjs for the fields).
 *
 * @type {ReadonlyArray<import("./compile-original.mjs").ColumnSpec & { formula?: string, note?: string }>}
 */
export const INBOX_COLUMNS = Object.freeze([
  {
    key: "in_database", from: "G#4", change: true, kind: "action", action: "lead_lookup", provider: "Lead database",
    inputs: { email: "{{general_email}}", verdict: "\"Valid\"" }, run_if: null,
    note: "The database check in DUPE CHECK's place: the address alone, in leads, the Email Bison copy and the never-contact list.",
  },
  { key: "safe_to_run", from: "G#5", change: true, kind: "formula", formula: "!{{in_database}}?.lead_id && !{{in_database}}?.in_bison && !{{in_database}}?.never_contact && !{{in_database}}?.bounced" },
  { key: "normalize_company_name", from: "G#14", kind: "action", action: "clay_normalize_company_name", provider: "Clay tool (exact copy)", note: "Clay's normalize-company-name, our exact copy (clay-tools.mjs). G#15 and G#20's second step read it." },
  { key: "normalized_company_name", from: "G#15", kind: "formula" },
  { key: "identify_email_type_and_extract_company_domain_from_email", from: "G#16", kind: "action", action: "clay_extract_email_components", provider: "Clay tool (exact copy)", note: "Clay's extract-email-components, our exact copy (clay-tools.mjs). G#17 and G#18 read it." },
  { key: "username", from: "G#17", kind: "formula" },
  { key: "guessed_name", from: "G#18", kind: "formula" },
  {
    key: "first_name_ai", from: "G#19", kind: "action", action: "ai_web", model_setting: "inbox_first_name_ai", tool: "none", on_error: "empty",
    note: "Clay's First Name AI; its table examples go with every request. G#20's first step reads it. When it fails, the steps after it read it as empty, so G#20 falls to \"<Company> Team\", as in Clay.",
  },
  { key: "use_first_name", from: "G#20", kind: "waterfall", note: "Falls to its last step, \"<Company> Team\", when G#19 gives no usable first name or fails (read as empty, as in Clay)." },
  { key: "use_last_name", from: "G#21", kind: "formula" },
  { key: "use_city", from: "G#23", kind: "formula" },
  { key: "use_state", from: "G#25", kind: "waterfall" },
  { key: "use_address", from: "G#27", kind: "waterfall" },
  { key: "google_maps_url", from: "G#29", kind: "formula" },
  { key: "use_google_maps_url", from: "G#30", kind: "waterfall" },
  { key: "use_domain", from: "G#32", kind: "waterfall" },
  { key: "normalize_phone_number", from: "G#35", kind: "action", action: "clay_normalize_phone_number", provider: "Clay tool (exact copy)", note: "Clay's normalize-phone-number, our exact copy (clay-tools.mjs). G#36 reads its national format." },
  { key: "use_phone_number", from: "G#36", kind: "waterfall" },
  { key: "exclusion_large_company_check", from: "G#37", kind: "formula" },
  { key: "qualified_general_email", from: "G#38", kind: "formula" },
  { key: "reoon_validation", from: "G#39", kind: "action", action: "reoon_verify" },
  { key: "reoon_stamp_of_approval", from: "G#40", kind: "formula" },
  { key: "enrichly_validation", from: "G#41", kind: "action", action: "enrichley_verify_email", key_env: "ENRICHLEY_API_KEY" },
  { key: "enrichly_stamp_of_approval", from: "G#42", kind: "formula" },
  { key: "result", from: "G#43", kind: "formula" },
  { key: "email_valid", from: "G#44", kind: "formula" },
  { key: "email_domain", from: "G#45", kind: "formula", flag: ["personalisation"] },
  { key: "email_host_lookup_google_dns", from: "G#46", kind: "action", action: "dns_mx", flag: ["personalisation"] },
  { key: "claygent", from: "G#48", kind: "action", action: "ai_web", model_setting: "inbox_claygent", tool: "web_search", flag: ["personalisation"] },
  { key: "question_ai", from: "G#49", kind: "action", action: "ai_web", model_setting: "inbox_question_ai", tool: "none", flag: ["personalisation"], note: "Its table examples go with every request." },
  { key: "question", from: "G#50", kind: "formula", flag: ["personalisation"] },
  { key: "inbox_outcome", from: null, kind: "formula" },
  { key: "add_to_database", from: null, kind: "action", action: "later", phase: 4, note: "Written only by promotion (phase 3); the engine never works it." },
]);

/** The inbox's outcome (ours): the first that applies. */
export const INBOX_OUTCOMES = Object.freeze([
  "On the never-contact list",
  "Bounced",
  "Already in the database",
  "Approved",
  "Rejected by Enrichley",
  "Waiting for Enrichley",
  "Rejected by Reoon",
  "Not checked: a large company",
  "Not checked: not a qualified address",
  "Not checked: a role or junk address",
]);

/**
 * inbox_outcome's formula. "Waiting for Enrichley" matches Reoon's status by
 * substring, as G#41's run condition does, and means the Enrichley key is not
 * held: with the key, G#41 has run and its answer decides.
 */
export const INBOX_OUTCOME_FORMULA = [
  `{{in_database}}?.never_contact ? "On the never-contact list"`,
  `: {{in_database}}?.bounced ? "Bounced"`,
  `: ({{in_database}}?.lead_id || {{in_database}}?.in_bison) ? "Already in the database"`,
  `: {{email_valid}} === true ? "Approved"`,
  `: {{enrichly_validation}} ? "Rejected by Enrichley"`,
  `: /catch_all|unknown|role_account/.test({{reoon_validation}}?.status ?? "") ? "Waiting for Enrichley"`,
  `: {{reoon_validation}} ? "Rejected by Reoon"`,
  `: {{exclusion_large_company_check}} === false ? "Not checked: a large company"`,
  `: {{qualified_general_email}} === false ? "Not checked: not a qualified address"`,
  `: "Not checked: a role or junk address"`,
].join("\n");

/** Names of our own columns (from: null). */
const OURS = {
  inbox_outcome: { name: "Outcome", formula: INBOX_OUTCOME_FORMULA, description: "The address's result. Approved and Already in the database count toward listing its company." },
  add_to_database: { name: "Added to the database", provider: "Promotion", description: "Written only by promotion (phase 3); the engine never works it." },
};

/**
 * The General template's enrich_columns rows, compiled from a
 * variant's originals: INBOX_INPUTS as input columns, then INBOX_COLUMNS
 * through compileColumn() with INBOX_REFS, and inbox_outcome from
 * INBOX_OUTCOME_FORMULA. A Clay tool column (CLAY_TOOL_ACTIONS) takes the
 * original's own inputs (toolInputs) and its run condition verbatim.
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @returns {Array<Record<string, any>>}
 */
export function inboxColumns(originals) {
  const own = refMap(originals, "inboxes", INBOX_REFS);
  const rows = [];
  for (const c of INBOX_INPUTS) {
    const spec = { key: c.key, kind: "input", description: c.description, hidden: c.key === "company_row", provider: c.from ? "Write to table" : "Pipeline" };
    rows.push(compileColumn(c.from ? { ...spec, from: c.from } : { ...spec, name: c.key === "company_row" ? "Company row" : "Found in" }, originals, { own }));
  }
  for (const spec of INBOX_COLUMNS) {
    if (!spec.from) {
      const o = OURS[spec.key] ?? {};
      rows.push(compileColumn({ ...spec, name: o.name ?? spec.key, formula: o.formula ?? spec.formula, provider: o.provider, description: o.description }, originals, { own }));
      continue;
    }
    const extra = spec.action && Object.hasOwn(CLAY_TOOL_ACTIONS, spec.action)
      ? { inputs: toolInputs(originals, spec.from, own, spec.action) }
      : {};
    rows.push(compileColumn({ ...spec, ...extra, description: spec.note }, originals, { own }));
  }
  return rows.map((r, i) => ({ ...r, position: i + 1 }));
}
