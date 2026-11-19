// One Google Maps place from a GMaps Scraper app chunk, as a row of the
// client's Companies (pipeline) table (template companies_v2, migration 129):
// its input cells (placeInputs) and its row key (placeRowKey). Plain
// JavaScript, so the intake route and the tests share it.
//
// The places are DataForSEO Google Maps items (the "advanced" postback), which
// the scraper app passes on unchanged. Read here: title, place_id, url, domain,
// phone, category, and address_info's address (the street), city, region (the
// state, usually its full name), zip and country_code (two letters). The street,
// zip and country code names come from DataForSEO's public docs: no code in the
// three repos reads them. The chunk's extra block gives what the scrape
// searched: city, state and category.
//
// The place becomes one office, the head office, in the shape officesOf()
// gives an AI Ark company (scripts/lib/aiark/company-filters.mjs), so the
// client's area check places it as it places an AI Ark office.

import { bareDomain } from "./domain.mjs";
import { normTag } from "./settings.mjs";

/** The Source input of a Maps row, as the Companies tab shows it. */
export const MAPS_SOURCE = "Google Maps";
/** A Maps row's key is this, then the place id: it never meets an AI Ark row's "aiark:" key. */
export const MAPS_KEY_PREFIX = "maps:";
/** A place id longer than this is refused: the row key sits in a unique index. */
export const PLACE_ID_MAX = 1000;

/** Text, white space made single and trimmed; an object or a missing value is "". */
const text = (v) =>
  v == null || typeof v === "object" ? "" : String(v).replace(/\u0000/g, "").replace(/\s+/g, " ").trim();

const objectOr = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/**
 * A place's row key: "maps:" and its place id, or null when it has none (the
 * place is then skipped and counted) or one over PLACE_ID_MAX characters.
 *
 * @param {unknown} placeId
 * @returns {string | null}
 */
export function placeRowKey(placeId) {
  const id = text(placeId);
  return id && id.length <= PLACE_ID_MAX ? `${MAPS_KEY_PREFIX}${id}` : null;
}

/**
 * The place as one office, the head office: { street, city, state, country,
 * postal_code, hq: true }, each text as the provider wrote it. Null when the
 * place has no street, city, state or country.
 *
 * @param {unknown} item  one Maps item
 * @returns {{ street: string, city: string, state: string, country: string, postal_code: string, hq: true } | null}
 */
export function placeOffice(item) {
  const a = objectOr(objectOr(item).address_info);
  const office = {
    street: text(a.address),
    city: text(a.city),
    state: text(a.region),
    country: text(a.country_code),
    postal_code: text(a.zip),
  };
  if (!office.street && !office.city && !office.state && !office.country) return null;
  return { ...office, hq: true };
}

/**
 * The input cells of one place, every value text, empty ones left out:
 *   company        the place's title
 *   place_id       Google's place id (C#6)
 *   website        its website (url)
 *   domain         the bare domain of its domain, else of its website
 *   phone          its phone
 *   industry       its Maps category (C#64 reads it through C#1's industry)
 *   offices        a one-item JSON list: the place itself, as the head office
 *   office_count   "1" with an office
 *   source         "Google Maps"
 *   client_tag     the URL's client tag (C#9)
 *   actual_city    address_info.city (C#60)
 *   actual_state   address_info.region (C#62)
 *   call_city      the search's city, extra.city (C#61)
 *   call_state     the search's state, extra.state (C#63)
 *   call_category  the search's category, extra.category (C#68)
 * Every key is one of COMPANY_INPUT_KEYS_V2 (company-template-v2.mjs).
 *
 * @param {unknown} item   one Maps item from postbackData.tasks[].result[].items[]
 * @param {unknown} extra  the chunk's extra block (may be null)
 * @param {string} tag     the inbound URL's client tag
 * @returns {Record<string, string>}
 */
export function placeInputs(item, extra, tag) {
  const it = objectOr(item);
  const ex = objectOr(extra);
  const a = objectOr(it.address_info);
  const office = placeOffice(it);
  const out = {
    company: text(it.title),
    place_id: text(it.place_id),
    website: text(it.url),
    domain: bareDomain(text(it.domain)) ?? bareDomain(text(it.url)) ?? "",
    phone: text(it.phone),
    industry: text(it.category),
    offices: office ? JSON.stringify([office]) : "",
    office_count: office ? "1" : "",
    source: MAPS_SOURCE,
    client_tag: normTag(tag),
    actual_city: text(a.city),
    actual_state: text(a.region),
    call_city: text(ex.city),
    call_state: text(ex.state),
    call_category: text(ex.category),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}
