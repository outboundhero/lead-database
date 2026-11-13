// Our key for every column of the three original Clay tables, by
// position (C#n, P#n, G#n: the column at position n of the Companies, People
// or General inboxes table, as the Clay CLI exports them: data[n - 1]).
//
// The keys are the older hand-seeded copy's (scripts/enrich-seed-table.mjs),
// and for the 12 columns that copy left out, the keys its formulas use. The
// templates (company-template-v2.mjs, inbox-template.mjs, people-template.mjs)
// compile each original column from enrich_originals under these keys, with
// their own overrides (REFS).
//
// This public file holds keys only: no Clay column name, prompt or list. The
// seed checks an export's layout against it by name: every key here is the
// slug of its Clay column name (slugKey), except the two positions in
// NAME_NOT_SLUG, which the seed does not check by name (neither is ever
// compiled). A column whose name doesn't give its key stops the seed.

/** How many columns each original table has. The seed refuses an export with another count. */
export const ORIGINAL_COUNTS = Object.freeze({ companies: 68, people: 88, inboxes: 76 });

/** The template kinds, as enrich_tables.kind and enrich_originals.template_kind hold them. */
export const ORIGINAL_KINDS = Object.freeze(["companies", "people", "inboxes"]);

/** Our key for each position: ORIGINAL_KEYS[kind][position]. */
export const ORIGINAL_KEYS = Object.freeze({
  companies: Object.freeze({
    1: "imported_companies", 2: "imported_jobs", 3: "apify_indeed_sources", 4: "comma_separated_cities",
    5: "company", 6: "place_id", 7: "use_city", 8: "use_state",
    9: "client_tag", 10: "check", 11: "dupe_check", 12: "dupe_check_2",
    13: "safe_to_run", 14: "exclusion_keywords_filter", 15: "service_area_check", 16: "exclusion_large_company_check",
    17: "master_filter", 18: "created_at", 19: "updated_at", 20: "company_linkedin_url",
    21: "website", 22: "domain", 23: "clearbit", 24: "companys_website",
    25: "company_website_response", 26: "use_website", 27: "check_if_url_is_valid", 28: "normalize_a_domain",
    29: "use_domain", 30: "icypeas_general_email_extraction", 31: "email_extraction_claygent", 32: "email_extraction_claygent_2",
    33: "general_email_variations_formula", 34: "extract_urls_and_emails_from_text", 35: "first_general_email_extracted", 36: "general_email_write_to",
    37: "findymail_domain_search_operations", 38: "findymail_domain_search_operations_write_to", 39: "anymail_operations", 40: "anymail_person_operations_write_to",
    41: "company_decision_maker_facilities_1_claygent", 42: "person_2_name_check", 43: "person_2_facilities_1_write_to", 44: "findymail_domain_search_facility_manager_office_manager",
    45: "findymail_domain_search_facility_manager_office_manager_write_to", 46: "anymail_facility_manager_office_manager", 47: "anymail_person_facility_manager_office_manager_write_to", 48: "company_decision_maker_facilities_2_claygent",
    49: "person_3_name_check", 50: "company_decision_maker_location_company_check", 51: "person_3_facilities_2_write_to", 52: "findymail_domain_search_ceo",
    53: "findymail_domain_search_ceo_write_to", 54: "anymail_ceo", 55: "anymail_person_ceo_write_to", 56: "company_decision_maker_ceo_claygent",
    57: "person_1_name_check", 58: "person_1_ceo_write_to", 59: "address", 60: "actual_city",
    61: "call_city", 62: "actual_state", 63: "call_state", 64: "category",
    65: "sub_category", 66: "additional_category", 67: "phone", 68: "call_category",
  }),
  people: Object.freeze({
    1: "find_people_from_linkedin_company_url", 2: "created_at", 3: "updated_at", 4: "dupe_check",
    5: "safe_to_run", 6: "duplicate_status", 7: "check", 8: "lookup_company_data",
    9: "email", 10: "exclusion_large_company_check", 11: "reoon_validation", 12: "reoon_stamp_of_approval",
    13: "enrichly_validation", 14: "enrichly_stamp_of_approval", 15: "final_validated_email", 16: "push_to_email_waterfall",
    17: "company_phone_number", 18: "normalize_phone_number", 19: "use_phone_number", 20: "city",
    21: "use_city", 22: "state", 23: "use_state", 24: "google_maps_url",
    25: "use_google_maps_url", 26: "client_tag", 27: "current_employer", 28: "company",
    29: "normalize_company_name", 30: "normalized_company_name", 31: "company_address", 32: "use_address",
    33: "category", 34: "sub_category", 35: "additional_category", 36: "company_website",
    37: "normalize_a_domain", 38: "use_domain", 39: "first_name", 40: "last_name",
    41: "use_first_name", 42: "use_last_name", 43: "full_name", 44: "title",
    45: "person_linkedin_url", 46: "find_work_email_findymail", 47: "find_work_email_prospeo", 48: "find_work_email_anymail_finder",
    49: "validate_email_anymail_finder_find_work_email", 50: "valid_work_email", 51: "find_work_email_from_linkedin_url_findymail", 52: "find_work_email_and_enrich_person_from_linkedin_url",
    53: "find_work_email_from_linkedin_url_anymail_finder", 54: "validate_email_anymail_finder_from_linkedin", 55: "use_work_email", 56: "qualified_work_email",
    57: "email_domain", 58: "email_provider_check_api", 59: "esp_check", 60: "claygent",
    61: "question_ai", 62: "question", 63: "email_type", 64: "email_host_lookup_emailguard",
    65: "email_host", 66: "create_or_update_lead_b2b_2", 67: "create_or_update_lead_b2b_2_retry", 68: "lead_id_b2b_2",
    69: "stop_eb_leads", 70: "get_tags", 71: "matching_tag_id", 72: "client_tag_id",
    73: "attach_tag_to_lead", 74: "eb_campaign_id_google_others", 75: "add_eb_lead_to_campaign_google_others", 76: "eb_campaign_id_outlook",
    77: "add_eb_lead_to_campaign_outlook", 78: "eb_campaign_id_segs", 79: "add_eb_lead_to_campaign_segs", 80: "create_or_update_lead_b2c_2",
    81: "create_or_update_lead_b2c_2_retry", 82: "lead_id_b2c_2", 83: "eb_campaign_id_easy_b2c_2", 84: "add_eb_lead_to_campaign_easy_b2c_2",
    85: "eb_campaign_id_medium_b2c_2", 86: "add_eb_lead_to_campaign_medium_b2c_2", 87: "eb_campaign_id_hard_b2c_2", 88: "add_eb_lead_to_campaign_hard_b2c_2",
  }),
  inboxes: Object.freeze({
    1: "created_at", 2: "updated_at", 3: "delete", 4: "dupe_check",
    5: "safe_to_run", 6: "duplicate_status", 7: "check", 8: "category",
    9: "sub_category", 10: "additional_category", 11: "first_name", 12: "company",
    13: "general_email", 14: "normalize_company_name", 15: "normalized_company_name", 16: "identify_email_type_and_extract_company_domain_from_email",
    17: "username", 18: "guessed_name", 19: "first_name_ai", 20: "use_first_name",
    21: "use_last_name", 22: "city", 23: "use_city", 24: "state",
    25: "use_state", 26: "company_address", 27: "use_address", 28: "client_tag",
    29: "google_maps_url", 30: "use_google_maps_url", 31: "domain", 32: "use_domain",
    33: "website", 34: "phone", 35: "normalize_phone_number", 36: "use_phone_number",
    37: "exclusion_large_company_check", 38: "qualified_general_email", 39: "reoon_validation", 40: "reoon_stamp_of_approval",
    41: "enrichly_validation", 42: "enrichly_stamp_of_approval", 43: "result", 44: "email_valid",
    45: "email_domain", 46: "email_host_lookup_google_dns", 47: "esp_check", 48: "claygent",
    49: "question_ai", 50: "question", 51: "email_type", 52: "email_host_lookup_emailguard",
    53: "email_host", 54: "create_or_update_lead_b2b_2", 55: "create_or_update_lead_b2b_2_retry", 56: "lead_id_b2b_2",
    57: "get_tags", 58: "matching_tag_id", 59: "client_tag_id", 60: "attach_tag_to_lead",
    61: "stop_lead", 62: "eb_campaign_id_google_others", 63: "add_eb_lead_to_campaign_google_others", 64: "eb_campaign_id_outlook",
    65: "add_eb_lead_to_campaign_outlook", 66: "eb_campaign_id_segs", 67: "add_eb_lead_to_campaign_segs", 68: "create_or_update_lead_b2c_2",
    69: "create_or_update_lead_b2c_2_retry", 70: "lead_id_b2c_2", 71: "eb_campaign_id_easy_b2c_2", 72: "add_eb_lead_to_campaign_easy_b2c_2",
    73: "eb_campaign_id_medium_b2c_2", 74: "add_eb_lead_to_campaign_medium_b2c_2", 75: "eb_campaign_id_hard_b2c_2", 76: "add_eb_lead_to_campaign_hard_b2c_2",
  }),
});

/** Positions whose key is not the slug of the Clay column's name (both NOT NEEDED, never compiled). */
export const NAME_NOT_SLUG = Object.freeze({ companies: Object.freeze([3, 4]), people: Object.freeze([]), inboxes: Object.freeze([]) });

/**
 * Our key for one original column, or null when the position is outside the table.
 *
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {number} position  1-based
 * @returns {string | null}
 */
export function keyFor(kind, position) {
  return ORIGINAL_KEYS[kind]?.[position] ?? null;
}

/**
 * A Clay column name as a key: lower case, apostrophes dropped, every other run
 * of characters that are not letters or digits made one underscore.
 *
 * @param {string} name
 * @returns {string}
 */
export function slugKey(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Does an exported column's name fit the key expected at its position? The
 * seed's layout check (2A.1): a client's table whose layout differs stops the
 * seed here.
 *
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {number} position
 * @param {string} name  the export's column name (never stored in this repo)
 * @returns {boolean}
 */
export function nameFits(kind, position, name) {
  const key = keyFor(kind, position);
  if (!key) return false;
  if (NAME_NOT_SLUG[kind]?.includes(position)) return true;
  return slugKey(name) === key;
}
