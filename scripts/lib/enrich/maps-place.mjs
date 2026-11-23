// One Google Maps place from a GMaps Scraper app chunk, as a row of the
// client's Companies (pipeline) table (template companies_v2, migration 129):
// its input cells (placeInputs) and its row key (placeRowKey). Plain
// JavaScript, so the intake route and the tests share it.
//
// The places are DataForSEO Google Maps items (the "advanced" postback), which
// the scraper app passes on unchanged. Read here: type, title, place_id, cid,
// url, domain, phone, category, and address_info's address (the street), city,
// region (the state, usually its full name), zip and country_code (two
// letters). The street, zip and country code names come from DataForSEO's
// public docs: no code in the three repos reads them. The chunk's extra block
// gives what the scrape searched: city, state and category.
//
// A place's row key is its place id. A place Google sent without one keeps
// its cid (Google's other id for it, digits only) and is keyed by that
// instead (the cid fallback), so it is stored once all the same. A Google
// Maps ad (type maps_paid_item) is never keyed by a cid: DataForSEO gives an
// ad a name, a rating, at most a website, and no place id, cid or address, so
// an ad is skipped, and the delivery counts how many of its skipped places
// were ads (src/lib/enrich/gmaps.ts mapsDelivery, meta.skipped_ads).
//
// The place becomes one office, the head office, in the shape officesOf()
// gives an AI Ark company (scripts/lib/aiark/company-filters.mjs), so the
// client's area check places it as it places an AI Ark office.
//
// The chunk's extra block may also carry a location filter (migration 139,
// optional and versioned): what the scrape was limited to. parseLocationFilter()
// reads it leniently and never throws; the intake keeps it on the delivery's
// source (meta) and on each place as the hidden input location_filter. It
// filters nothing: whether it should replace the client's places or narrow
// them is a later decision.

import { bareDomain } from "./domain.mjs";
import { normTag } from "./settings.mjs";

/** The Source input of a Maps row, as the Companies tab shows it. */
export const MAPS_SOURCE = "Google Maps";
/** A Maps row's key is this, then the place id: it never meets an AI Ark row's "aiark:" key. */
export const MAPS_KEY_PREFIX = "maps:";
/** A Maps row keyed by its cid (Google sent no place id) has this, then the cid. A place id never starts with "cid:". */
export const MAPS_CID_KEY_PREFIX = `${MAPS_KEY_PREFIX}cid:`;
/** A place id longer than this is refused: the row key sits in a unique index. */
export const PLACE_ID_MAX = 1000;
/** DataForSEO's type for a Google Maps ad: a name and a rating, no place id, cid or address. Never keyed by a cid. */
export const MAPS_AD_TYPE = "maps_paid_item";

/** Text, white space made single and trimmed; an object or a missing value is "". */
const text = (v) =>
  v == null || typeof v === "object" ? "" : String(v).replace(/\u0000/g, "").replace(/\s+/g, " ").trim();

const objectOr = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

/** Is the item a Google Maps ad (DataForSEO's maps_paid_item)? */
export function isMapsAd(item) {
  return text(objectOr(item).type) === MAPS_AD_TYPE;
}

/**
 * Google's cid as text: 1 to 30 digits (DataForSEO sends it as text, 17 to 20
 * digits seen), or a whole number short enough to be exact. Anything else is "".
 *
 * @param {unknown} v
 * @returns {string}
 */
export function cidText(v) {
  const t = typeof v === "number" ? (Number.isSafeInteger(v) && v >= 0 ? String(v) : "") : text(v);
  return /^\d{1,30}$/.test(t) ? t : "";
}

/**
 * A place's row key: "maps:" and its place id; else, when the place id is
 * missing, not text or over PLACE_ID_MAX characters, "maps:cid:" and its cid
 * (cidText); else null (the place is then skipped and counted). placeInputs()
 * gives no cid for an ad, so an ad's key is its place id or nothing.
 *
 * @param {unknown} placeId
 * @param {unknown} [cid]
 * @returns {string | null}
 */
export function placeRowKey(placeId, cid = undefined) {
  const id = text(placeId);
  if (id && id.length <= PLACE_ID_MAX) return `${MAPS_KEY_PREFIX}${id}`;
  const c = cidText(cid);
  return c ? `${MAPS_CID_KEY_PREFIX}${c}` : null;
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

// ── The location filter (migration 139) ─────────────────────────────────────

/** The filter's only version so far. */
export const LOCATION_FILTER_VERSION = 1;
/** Each list keeps at most this many entries (the rest are left out, with a note). */
export const LOCATION_FILTER_MAX_ITEMS = 500;
/** A filter longer than this once cleaned (compact JSON) is not kept: it must fit a row's cell (5,000 characters). */
export const LOCATION_FILTER_MAX_CHARS = 4_000;
const NOTE_MAX = 200;
const KNOWN_KEYS = ["version", "name", "countries", "include", "exclude", "zips", "radius", "text"];

/** Lone UTF-16 halves made U+FFFD, as gmaps.ts does for the meta: Postgres refuses them inside jsonb. */
const wellFormed = (s) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");

/** Text or a number, as the meta keeps text: no NUL, white space made single, trimmed, at most `max` characters, well formed. Null for anything else. */
function filterText(v, max) {
  if (typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v))) return null;
  return wellFormed(String(v).replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, max));
}

/** A bad shape: thrown inside parseLocationFilter, caught there, and never past it. */
class BadShape extends Error {}

/** One place: { country (two letters), state?, city? }, as client_targeting holds them. */
function filterEntry(e, where) {
  if (!e || typeof e !== "object" || Array.isArray(e)) throw new BadShape(`${where} holds something that is not a place`);
  const country = filterText(e.country, 10)?.toUpperCase() ?? "";
  if (!/^[A-Z]{2}$/.test(country)) throw new BadShape(`${where} has a place with no two-letter country`);
  /** @type {{ country: string, state?: string, city?: string }} */
  const out = { country };
  const state = filterText(e.state, 60);
  const city = filterText(e.city, 100);
  if (state) out.state = state;
  if (city) out.city = city;
  return out;
}

/** A list as sent: at most LOCATION_FILTER_MAX_ITEMS entries kept, a note when more came. */
function capped(list, where, notes) {
  if (!Array.isArray(list)) throw new BadShape(`${where} is not a list`);
  if (list.length > LOCATION_FILTER_MAX_ITEMS) notes.push(`${where}: the first ${LOCATION_FILTER_MAX_ITEMS} of ${list.length.toLocaleString("en-US")} kept`);
  return list.slice(0, LOCATION_FILTER_MAX_ITEMS);
}

function filterRadius(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new BadShape("radius is not an object");
  const miles = typeof r.miles === "number" ? r.miles : typeof r.miles === "string" && r.miles.trim() ? Number(r.miles) : NaN;
  if (!Number.isFinite(miles) || miles <= 0 || miles > 1_000) throw new BadShape("radius.miles is not a number of miles from 0 to 1,000");
  const c = r.center;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new BadShape("radius.center is not an object");
  if (typeof c.lat === "number" || typeof c.lng === "number") {
    const { lat, lng } = c;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new BadShape("radius.center has a latitude or longitude that is not one");
    }
    return { miles, center: { lat, lng } };
  }
  /** @type {{ city?: string, state?: string, country?: string }} */
  const center = {};
  const city = filterText(c.city, 100);
  const state = filterText(c.state, 60);
  const country = filterText(c.country, 10)?.toUpperCase();
  if (city) center.city = city;
  if (state) center.state = state;
  if (country) {
    if (!/^[A-Z]{2}$/.test(country)) throw new BadShape("radius.center.country is not a two-letter country");
    center.country = country;
  }
  if (!Object.keys(center).length) throw new BadShape("radius.center names no place");
  return { miles, center };
}

/**
 * The chunk's location filter (extra.location_filter), cleaned, or null with a
 * note saying why it is not kept. It never throws, and a filter never refuses
 * a chunk. Accepted (version 1):
 *   { version: 1, name?, countries?: [ISO2], include?: Entry[], exclude?: Entry[],
 *     zips?: string[], radius?: { miles, center: {city?, state?, country?} | {lat, lng} }, text? }
 * where Entry is { country, state?, city? } as client_targeting holds them.
 * Only those keys are kept (any other is left out, with a note); text is
 * cleaned as the meta's is (no NUL, single spaces, well formed); each list
 * keeps its first 500 entries (with a note). An unknown version, a known key
 * of the wrong shape, or a filter longer than 4,000 characters once cleaned
 * gives filter null and a note. Nothing sent (undefined or null): both null.
 *
 * @param {unknown} raw
 * @returns {{ filter: Record<string, any> | null, note: string | null }}
 */
export function parseLocationFilter(raw) {
  const done = (filter, notes) => ({ filter, note: notes.length ? notes.join("; ").slice(0, NOTE_MAX) : null });
  try {
    if (raw === undefined || raw === null) return { filter: null, note: null };
    if (typeof raw !== "object" || Array.isArray(raw)) return done(null, ["location_filter is not an object (not kept)"]);
    const version = typeof raw.version === "number" ? raw.version : typeof raw.version === "string" && raw.version.trim() ? Number(raw.version) : NaN;
    if (version !== LOCATION_FILTER_VERSION) {
      const said = filterText(raw.version, 20);
      return done(null, [`location_filter version ${said ? `"${said}"` : "missing"}: only version ${LOCATION_FILTER_VERSION} is read (not kept)`]);
    }
    /** @type {string[]} */
    const notes = [];
    /** @type {Record<string, any>} */
    const out = { version: LOCATION_FILTER_VERSION };
    if (raw.name != null) {
      const name = filterText(raw.name, 120);
      if (name === null) throw new BadShape("name is not text");
      if (name) out.name = name;
    }
    if (raw.countries != null) {
      out.countries = [...new Set(capped(raw.countries, "countries", notes).map((c) => {
        const code = filterText(c, 10)?.toUpperCase() ?? "";
        if (!/^[A-Z]{2}$/.test(code)) throw new BadShape("countries holds something that is not a two-letter country");
        return code;
      }))];
    }
    for (const k of ["include", "exclude"]) {
      if (raw[k] == null) continue;
      const seen = new Set();
      out[k] = capped(raw[k], k, notes)
        .map((e) => filterEntry(e, k))
        .filter((e) => {
          const key = `${e.country}|${(e.state ?? "").toLowerCase()}|${(e.city ?? "").toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    }
    if (raw.zips != null) {
      out.zips = [...new Set(capped(raw.zips, "zips", notes).map((z) => {
        const zip = filterText(z, 20);
        if (!zip) throw new BadShape("zips holds something that is not a zip code");
        return zip;
      }))];
    }
    if (raw.radius != null) out.radius = filterRadius(raw.radius);
    if (raw.text != null) {
      const t = filterText(raw.text, 1_000);
      if (t === null) throw new BadShape("text is not text");
      if (t) out.text = t;
    }
    const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.includes(k));
    if (unknown.length) {
      const names = unknown.slice(0, 5).map((k) => filterText(k, 30) || "?").join(", ");
      notes.push(`left out: ${names}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ""}`);
    }
    const size = JSON.stringify(out).length;
    if (size > LOCATION_FILTER_MAX_CHARS) {
      return done(null, [`location_filter is ${size.toLocaleString("en-US")} characters once cleaned, ${LOCATION_FILTER_MAX_CHARS.toLocaleString("en-US")} at most (not kept)`]);
    }
    return done(out, notes);
  } catch (e) {
    return done(null, [e instanceof BadShape ? `location_filter: ${e.message} (not kept)` : "location_filter could not be read (not kept)"]);
  }
}

/**
 * What the scraper app's Test is told about a location filter it sent at the
 * top level: whether it would be kept, its version (the one sent when it is a
 * number, else null) and the note.
 *
 * @param {unknown} raw
 * @returns {{ accepted: boolean, version: number | null, note: string | null }}
 */
export function locationFilterEcho(raw) {
  const { filter, note } = parseLocationFilter(raw);
  if (filter) return { accepted: true, version: filter.version, note };
  const sent = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {any} */ (raw).version : undefined;
  return {
    accepted: false,
    version: typeof sent === "number" && Number.isFinite(sent) ? sent : null,
    note: note ?? "No location filter was sent",
  };
}

/**
 * A delivery's location filter in short, for the Clay tab's Recent deliveries:
 * its version and how many entries each list holds, or only the note. Null
 * when the delivery carried none.
 *
 * @param {unknown} filter  enrich_sources.meta.location_filter
 * @param {unknown} note    enrich_sources.meta.location_filter_note
 * @returns {{ version: number | null, countries: number, include: number, exclude: number, zips: number, radius: boolean, text: boolean, note: string | null } | null}
 */
export function locationFilterSummary(filter, note) {
  const f = filter && typeof filter === "object" && !Array.isArray(filter) ? /** @type {Record<string, any>} */ (filter) : null;
  const n = typeof note === "string" && note ? note : null;
  if (!f && !n) return null;
  const count = (k) => (Array.isArray(f?.[k]) ? f[k].length : 0);
  return {
    version: typeof f?.version === "number" ? f.version : null,
    countries: count("countries"),
    include: count("include"),
    exclude: count("exclude"),
    zips: count("zips"),
    radius: Boolean(f?.radius),
    text: Boolean(f?.text),
    note: n,
  };
}

/**
 * The input cells of one place, every value text, empty ones left out:
 *   company        the place's title
 *   place_id       Google's place id (C#6)
 *   cid            Google's cid (cidText; hidden), the row's key when there is no place id; never on an ad
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
 *   location_filter  the chunk's location filter, cleaned (parseLocationFilter), as compact JSON
 *                    (hidden; at most 4,000 characters); left out when the chunk has none or it was not kept
 * Every key is one of COMPANY_INPUT_KEYS_V2 (company-template-v2.mjs).
 *
 * @param {unknown} item   one Maps item from postbackData.tasks[].result[].items[]
 * @param {unknown} extra  the chunk's extra block (may be null)
 * @param {string} tag     the inbound URL's client tag
 * @param {Record<string, any> | null} [filter]  the chunk's filter as parseLocationFilter() kept it
 *   (the intake reads it once a chunk); left out, it is read from extra.location_filter here
 * @returns {Record<string, string>}
 */
export function placeInputs(item, extra, tag, filter = undefined) {
  const it = objectOr(item);
  const ex = objectOr(extra);
  const a = objectOr(it.address_info);
  const office = placeOffice(it);
  const kept = filter === undefined ? parseLocationFilter(ex.location_filter).filter : filter;
  const out = {
    company: text(it.title),
    place_id: text(it.place_id),
    cid: isMapsAd(it) ? "" : cidText(it.cid),
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
    location_filter: kept ? JSON.stringify(kept) : "",
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}
