// Each client's own LinkedIn places and excluded keywords (migration 128), and
// the one resolver every LinkedIn search, the AI Ark tab's LinkedIn editor and
// the seed script read (D-P4-1 to D-P4-5).
//
//   Shared by every client: the standard filters (cleaning-filters.mjs) for job
//   titles, excluded titles, excluded industries, employee bands and excluded
//   company types, whatever the client's type; or the client's own saved AI
//   Ark people filters (client_people_filters) when it has them, here and on
//   the AI Ark tab alike (filtersFor in standard-filters.mjs, scope "linkedin").
//   The standard keywords and company types always go.
//   The client's own, per kind (people, companies): places to include and to
//   exclude, Clay values the seed could not place (shown, never searched), and
//   excluded keywords (client_linkedin_settings).
//   A client with no row: its database rules' places (client_targeting, read
//   live) and the starter keywords (enrich_settings.linkedin_starter_keywords).
//   Its first save creates its own row from exactly what the page showed.
//
// Keywords sent (D-P4-3): the standard keywords first, then the built-in
// competitors list (competitors.mjs, read with the other parts), then the
// client's own for the kind, once each (case aside), on a company's name,
// industry and description, as far as AI Ark's request limit allows
// (accountFilters in filters.mjs: 1,900 bytes and 300 values). Every keyword is
// enforced: the whole union (standard, the list and own) is checked after the
// pull, free, before anything is spent on a record or a row is listed (company
// rows: client_exclusions with the run's keywords; people: at the Look and again
// after a Buy). Those AI Ark's request could not take are shown as "checked
// after the pull (AI Ark limit)".
//
// Places searched (the sending rules, override O2): the client's own include
// places narrowed to its database rules (client_targeting.include_locations),
// so nothing is paid for outside the area the send gate allows: an entry the
// rules cover is kept, a state or country entry the rules don't cover is
// replaced by the rules' entries inside it, a city entry they don't cover is
// left out, and so is an entry the rules exclude. A client whose rules hold no
// include places is not narrowed. The stored lists never change; what is left
// out is listed as "not searched: outside the client's sending rules".
//
// Places are client_targeting's format ({country, state, city} codes, the geo
// reference's city spelling with accents folded), so placeString() sends them
// and placeKeyOf() keys them. A typed place is checked the way the Clients
// page's Rules dialog checks one (a supported country, a state by code or
// name, a city of that state in the geo reference, "St." tried as "Saint"
// and so on); anything else is refused with its reason, never stored.
//
// Every save and every seed write is logged in client_linkedin_settings_log
// with the lists before and after, in the transaction that writes the row.
//
// Plain JavaScript: the routes, the worker, the seed script and the tests share it.

import { accountFilters, cleanPeopleFilters, VALUE_MAX } from "./filters.mjs";
import { placeKeyOf } from "./company-filters.mjs";
import { readCompetitors } from "./competitors.mjs";
import { cityKey, entryKey, findState, placeString } from "./geo.mjs";
import { filtersFor } from "./standard-filters.mjs";
import { normTag, starterFrom } from "../enrich/settings.mjs";

/** @typedef {"people" | "companies"} LinkedinKind */
/** @typedef {{ country: string, state?: string, city?: string }} PlaceEntry */
/**
 * A Clay value the seed could not place: shown on the AI Ark tab with why and
 * the places it may mean (a person applies a suggestion), never searched.
 * @typedef {{ side: "include" | "exclude", field: string, value: string, why: string, suggestions: PlaceEntry[] }} UnplacedValue
 */
/**
 * The lists a manager edits, per kind.
 * @typedef {{ include_locations: PlaceEntry[], exclude_locations: PlaceEntry[], unplaced: UnplacedValue[], exclude_keywords: string[] }} LinkedinOwn
 */
/**
 * A client_linkedin_settings row as read (version = updated_at as text).
 * @typedef {LinkedinOwn & { client_tag: string, kind: LinkedinKind, notes: string[], flags: string[], source: "clay" | "manual",
 *   copied_from: LinkedinKind | null, clay_source_id: string | null, clay_campaign: string | null, clay_set_up_at: string | null,
 *   clay_fingerprint: string | null, seed_sha256: string | null, seeded_at: string | null, updated_by: string | null,
 *   created_at: string, updated_at: string, version: string }} LinkedinRow
 */
/**
 * The starter keywords as read, with their row's version (updated_at as text).
 * @typedef {{ items: string[], version: number | null, source: string | null, sha256: string | null, seeded_at: string | null,
 *   updatedAt: string | null, loaded: boolean }} Starter
 */
/**
 * What a LinkedIn search of a client and kind uses, and where each part came from.
 * @typedef {{
 *   tag: string, kind: LinkedinKind,
 *   from: "row" | "rules_and_starter",
 *   own: LinkedinOwn,
 *   filters: { value: Record<string, any>, from: "saved" | "cleaning" },
 *   cleaning: true,
 *   keywords: { standard: string[], list: { name: string, from: "database" | "fallback", terms: number, added: string[] },
 *     own: string[], union: string[], sent: string[], checkedAfter: string[] },
 *   competitors: import("./competitors.mjs").Competitors | undefined,
 *   search: PlacesSearched,
 *   outsideRules: PlaceEntry[],
 *   row: LinkedinRow | null,
 *   starter: { loaded: boolean, items: number, version: number | null },
 *   blockers: string[],
 *   versions: { own: string, filters: string | null, rules: string | null },
 *   version: string,
 * }} EffectiveLinkedin
 *   own: the client's own lists as stored (the row's, or derived for a client with no row: rules places, starter keywords);
 *   filters.from "cleaning": the standard filters (never "none" on LinkedIn);
 *   keywords.checkedAfter: keywords of the union AI Ark's request could not take: "checked after the pull (AI Ark limit)";
 *   keywords.list: the built-in competitors list (added: its terms the union holds beside the standard and own ones);
 *   competitors: the list as read (readCompetitors), which the request builders leave out too (the 069 seed when undefined);
 *   search: the places a search sends, narrowed to the client's sending rules (narrowPlaces), and what was left out;
 *   outsideRules: own include places the client's database area (client_targeting) does not cover (each is either
 *     replaced by the rules' places inside it or not searched: see search);
 *   versions.own: what a save must send back; versions.rules: the rules' version, which the places searched depend on;
 *   version: own, the rules (for a client with its own row) and the saved filters: what a count, pull or run compares
 */
/**
 * The places a LinkedIn search sends, narrowed to the client's sending rules (override O2).
 * @typedef {{ include: PlaceEntry[], exclude: PlaceEntry[], notSearched: Array<{ entry: PlaceEntry, why: string }>,
 *   replaced: Array<{ entry: PlaceEntry, by: PlaceEntry[] }>, narrowed: boolean, rulePlaces: number }} PlacesSearched
 *   include: the places sent (de-duplicated, in order); exclude: the client's own places left out, sent as stored;
 *   notSearched: own include places left out, with why; replaced: own state or country places the rules don't cover,
 *   and the rules' places inside each that are searched instead; narrowed: false when the rules hold no include places
 */

export const LINKEDIN_KINDS = Object.freeze(["people", "companies"]);
/** At most this many places a list, unplaced values and keywords a kind (the editor and the seed). */
export const PLACES_MAX = 2000;
export const UNPLACED_MAX = 1000;
export const KEYWORDS_MAX = 1000;
const TEXT_MAX = 300;

/** The row flags the seed may set, in plain words for the AI Ark tab. Unknown codes are shown as they are. */
export const LINKEDIN_FLAGS = Object.freeze({
  review: "Held for review: Clay's search left out the client's own cities, so this kind took the other kind's places",
  company_list: "Clay looked only inside a list of companies; seeded as a search of the area",
  whole_countries: "The places are whole countries",
  include_style: "Clay's search named what to find (industries, keywords or seniority), which is not carried over",
  unconfirmed_match: "The Clay tag's match to this client is not confirmed",
  campaigns_not_seeded: "The client's other Clay campaigns were not seeded (see the notes)",
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fmtN = (n) => Number(n).toLocaleString("en-US");
const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
/** Accents folded, lower case, spaces collapsed: how geo.mjs keys state and country names. */
const fold = (v) => clean(v).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
/** Accents folded, case kept: the city spelling stored (the send gate keys a city without folding). */
const asciiFold = (v) => clean(v).normalize("NFD").replace(/\p{Mn}/gu, "");

/** One place entry with its keys in order and empty parts dropped. */
export function canonEntry(e) {
  const country = clean(e?.country).toUpperCase();
  const state = clean(e?.state).toUpperCase();
  const city = clean(e?.city);
  return { country, ...(state ? { state } : {}), ...(city ? { city } : {}) };
}

const entriesOf = (v) => (Array.isArray(v) ? v.filter(isObject).map(canonEntry) : []);
const textsOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** The lists of a row, or of anything shaped like one, in their stored form. */
export function ownOf(x) {
  return {
    include_locations: entriesOf(x?.include_locations),
    exclude_locations: entriesOf(x?.exclude_locations),
    unplaced: Array.isArray(x?.unplaced) ? x.unplaced.filter(isObject).map(unplacedOf) : [],
    exclude_keywords: textsOf(x?.exclude_keywords),
  };
}

function unplacedOf(u) {
  return {
    side: u.side === "exclude" ? "exclude" : "include",
    field: clean(u.field).slice(0, 60),
    value: clean(u.value).slice(0, TEXT_MAX),
    why: clean(u.why).slice(0, TEXT_MAX),
    suggestions: entriesOf(u.suggestions).slice(0, 20),
  };
}

/** Do two sets of lists hold the same values in the same order? */
export function sameOwn(a, b) {
  return JSON.stringify(ownOf(a)) === JSON.stringify(ownOf(b));
}

// ── Keywords (D-P4-3) ───────────────────────────────────────────────────────

/** How a keyword AI Ark's request could not take is shown, everywhere (override O1). */
export const CHECKED_AFTER = "checked after the pull (AI Ark limit)";
/** How a place the sending rules leave out is shown, everywhere (override O2). */
export const NOT_SEARCHED = "not searched: outside the client's sending rules";
export const NOT_SEARCHED_EXCLUDED = "not searched: the client's sending rules leave this place out";
/** What brings a place left out back in. */
export const NOT_SEARCHED_FIX = "Adding them to the client's rules (Clients page or onboarding sheet) brings them in.";

/**
 * The excluded keywords a LinkedIn search sends: the standard ones, then the
 * built-in competitors list, then the client's own for the kind, each not
 * already among them (case aside), as far as AI Ark's limit allows. A sent
 * phrase covers every listed keyword that holds its words in order
 * ("cleaning" covers "cleaning services"), so a covered keyword counts as
 * sent. Every keyword of the union, sent or not, is checked after the pull;
 * the ones AI Ark's request could not take are checkedAfter.
 *
 * @param {string[]} own  the client's own excluded keywords for the kind
 * @param {import("./competitors.mjs").Competitors} [competitors]  readCompetitors()'s value (the 069 seed when left out)
 * @returns {{ standard: string[], list: { name: string, from: "database" | "fallback", terms: number, added: string[] },
 *             own: string[], union: string[], sent: string[], checkedAfter: string[] }}
 *   union: standard first, then the list's new terms, then the client's own new ones (what the after-pull check
 *   reads); sent: what AI Ark is asked (condensed); checkedAfter: keywords of the union no sent phrase covers
 */
export function keywordsFor(own, competitors = undefined) {
  const a = accountFilters({ targeting: { exclude_terms: Array.isArray(own) ? own : [] }, filters: null, cleaning: true, competitors });
  return {
    standard: [...a.standardTerms],
    list: { name: a.list.name, from: a.list.from, terms: a.listAll.length, added: [...a.listAdded] },
    own: [...a.clientTerms],
    union: [...a.terms],
    sent: [...a.companyTerms],
    checkedAfter: [...a.checkedAfter],
  };
}

// ── Places ──────────────────────────────────────────────────────────────────

/** The text the AI Ark tab shows for an entry: what AI Ark is sent ("Spokane, Washington", "Ontario", "United States"). */
export function placeText(entry, geo) {
  const r = placeString(entry, geo);
  return r.value ?? JSON.stringify(canonEntry(entry));
}

/**
 * A typed place as an entry (codes), or why it can't be one. "City, State",
 * "State" or "Country", or "City, State, Country"; a state by name or code,
 * a country by name, code or alias. The city is checked later, against the
 * geo reference (checkPlaces). Pure: geo is loadGeo()'s maps.
 *
 * @param {string} text
 * @param {object} geo
 * @returns {{ entry: PlaceEntry } | { why: string }}
 */
export function placeFromText(text, geo) {
  const parts = clean(text).split(",").map((p) => p.trim()).filter(Boolean);
  const countryOf = (s) => geo.countryCode.get(cityKey(s)) ?? null;
  const stateIn = (country, s) => geo.stateCode.get(`${country}|${fold(s)}`) ?? null;
  if (!parts.length) return { why: "empty" };
  if (parts.length > 3) return { why: "write a place as City, State or State or Country" };
  if (parts.length === 3) {
    const country = countryOf(parts[2]);
    if (!country) return { why: `"${parts[2]}" is not a supported country` };
    const state = stateIn(country, parts[1]);
    if (!state) return { why: `"${parts[1]}" is not a state of ${country}` };
    return { entry: { country, state, city: parts[0] } };
  }
  if (parts.length === 2) {
    const country = countryOf(parts[1]);
    if (country) {
      const state = stateIn(country, parts[0]);
      if (state) return { entry: { country, state } };
      return { why: `"${parts[0]}" is not a state of ${country}; a city needs its state ("City, State")` };
    }
    const found = findState(geo, parts[1]);
    if (!found) return { why: `"${parts[1]}" is not a state or a country` };
    return { entry: { country: found.country, state: found.state, city: parts[0] } };
  }
  const country = countryOf(parts[0]);
  if (country) return { entry: { country } };
  const found = findState(geo, parts[0]);
  if (found) return { entry: { country: found.country, state: found.state } };
  return { why: `"${parts[0]}" is not a state or a country; a city needs its state ("City, State")` };
}

// "St." is "Saint" in the geo reference, and a trailing " City" may be dropped
// ("Suisun City"). Tried only after the name as written misses, as the Rules
// dialog's check does (src/app/api/clients/targeting/route.ts).
function cityVariants(city) {
  const out = [];
  const abbr = [[/^st\.?\s+/i, "Saint "], [/^ste\.?\s+/i, "Sainte "], [/^ft\.?\s+/i, "Fort "], [/^mt\.?\s+/i, "Mount "]];
  for (const [re, full] of abbr) if (re.test(city)) out.push(city.replace(re, full));
  if (/\s+city$/i.test(city)) out.push(city.replace(/\s+city$/i, ""));
  return out;
}

/**
 * Checks place entries against the geo reference, all at once: the country
 * supported and enabled, the state a code (or name) of that country, a city
 * of that state (the name as written, then its variants). Returns the entries
 * in their stored form (codes; the city in the geo reference's spelling of its
 * most populous match, accents folded) and the reason for each one refused.
 * Repeats are dropped (by place key). With `verify` the entries are kept as
 * given and only refused ones are reported (the seed, whose spelling is its own).
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {Array<PlaceEntry | { entry: PlaceEntry, label: string }>} entries
 * @param {object} geo  loadGeo()'s maps
 * @param {{ verify?: boolean, label?: (e: PlaceEntry, i: number) => string }} [opts]
 * @returns {Promise<{ entries: PlaceEntry[], errors: string[] }>}
 */
export async function checkPlaces(db, entries, geo, { verify = false, label = (e) => placeText(e, geo) } = {}) {
  const errors = [];
  const { rows: countries } = await db.query(`SELECT code FROM supported_countries WHERE enabled`);
  const enabled = new Set(countries.map((r) => String(r.code).toUpperCase()));
  const list = (entries ?? []).map((e) => canonEntry(e));
  const out = list.map(() => null);
  const cities = [];
  list.forEach((e, i) => {
    if (!e.country) return errors.push(`${label(e, i)}: no country`);
    if (!enabled.has(e.country)) return errors.push(`${label(e, i)}: ${e.country} is not a supported country`);
    if (e.state) {
      const code = geo.stateCode.get(`${e.country}|${fold(e.state)}`);
      if (!code) return errors.push(`${label(e, i)}: ${e.state} is not a state of ${e.country}`);
      e.state = code;
    }
    if (e.city && !e.state) return errors.push(`${label(e, i)}: a city needs its state`);
    if (!e.city) {
      out[i] = e;
      return;
    }
    cities.push({ i, e, tries: [e.city, ...cityVariants(e.city)] });
  });
  // One query per round: the name as written, then the first variant, and so on.
  let open = cities;
  for (let round = 0; open.length && round < 3; round++) {
    const asked = open.filter((c) => c.tries[round] !== undefined);
    if (!asked.length) break;
    const { rows } = await db.query(
      `SELECT DISTINCT ON (x.i) x.i, g.city
         FROM unnest($1::int[], $2::text[], $3::text[], $4::text[]) AS x(i, country, state, key)
         JOIN geo_admin1 a ON a.country_code = x.country AND a.state_code = x.state
         JOIN geo_locations g ON g.country_code = a.country_code AND g.admin1_code = a.admin1_code AND g.city_key = x.key
        ORDER BY x.i, g.population DESC NULLS LAST`,
      [asked.map((c) => c.i), asked.map((c) => c.e.country), asked.map((c) => c.e.state), asked.map((c) => cityKey(c.tries[round]))]
    );
    const hit = new Map(rows.map((r) => [Number(r.i), r.city]));
    for (const c of asked) {
      if (!hit.has(c.i)) continue;
      const name = asciiFold(hit.get(c.i));
      const key = cityKey(c.tries[round]);
      out[c.i] = verify ? c.e : { ...c.e, city: entryKey(name) === key ? name : asciiFold(c.tries[round]) };
    }
    open = open.filter((c) => !hit.has(c.i));
  }
  for (const c of cities) if (!out[c.i]) errors.push(`${label(c.e, c.i)}: ${c.e.city} is not a known place in ${c.e.state}, ${c.e.country}`);
  const seen = new Set();
  const kept = [];
  for (const e of out) {
    if (!e) continue;
    const k = placeKeyOf(e) ?? JSON.stringify(e);
    if (seen.has(k)) continue;
    seen.add(k);
    kept.push(e);
  }
  return { entries: kept, errors };
}

/** Does a set of place keys hold an entry: its own key, its state's or its country's? */
function holdsPlace(keys, e) {
  const k = placeKeyOf(e);
  if (!k) return false;
  const [country, state] = k.split("|");
  return keys.has(k) || Boolean(state && keys.has(`${country}|${state}`)) || keys.has(country);
}

/**
 * The client's own include places its database area does not cover: an entry
 * is covered when the rules' include places hold it, its state or its country
 * (by place key). Under the sending rules (narrowPlaces) none of them is
 * searched as it stands: a city is left out, a state or country is replaced by
 * the rules' places inside it.
 *
 * @param {PlaceEntry[]} entries
 * @param {{ include_locations?: PlaceEntry[] } | null} targeting  client_targeting's row
 * @returns {PlaceEntry[]}
 */
export function outsideRules(entries, targeting) {
  const keys = new Set(entriesOf(targeting?.include_locations).map(placeKeyOf).filter(Boolean));
  return entriesOf(entries).filter((e) => !placeKeyOf(e) || !holdsPlace(keys, e));
}

/**
 * The places a LinkedIn search sends (override O2): the client's own include
 * places narrowed to its sending rules (client_targeting.include_locations),
 * so no record is paid for outside the area the send gate allows.
 *   - an entry the rules cover (they hold its key, its state's or its country's) is kept;
 *   - a state or country entry they don't cover is replaced by the rules' entries inside it;
 *   - a city entry they don't cover is left out;
 *   - an entry the rules' exclude_locations hold is left out.
 * De-duplicated (by place key), in a stable order. A client whose rules hold no
 * include places (no row, or an empty list) is not narrowed: its send gate does
 * not limit places. The own lists are never changed. Pure.
 *
 * @param {PlaceEntry[]} entries  the client's own include places
 * @param {{ include_locations?: PlaceEntry[], exclude_locations?: PlaceEntry[] } | null} targeting  client_targeting's row
 * @param {{ exclude?: PlaceEntry[] }} [opts]  exclude: the client's own places to leave out, sent as they are
 * @returns {PlacesSearched}
 */
export function narrowPlaces(entries, targeting, { exclude = [] } = {}) {
  const own = entriesOf(entries);
  const rules = entriesOf(targeting?.include_locations).filter((e) => placeKeyOf(e));
  const out = { include: [], exclude: entriesOf(exclude), notSearched: [], replaced: [], narrowed: rules.length > 0, rulePlaces: rules.length };
  const seen = new Set();
  const send = (e) => {
    const k = placeKeyOf(e) ?? JSON.stringify(e);
    if (seen.has(k)) return;
    seen.add(k);
    out.include.push(e);
  };
  if (!rules.length) {
    for (const e of own) send(e);
    return out;
  }
  const ruleKeys = new Set(rules.map(placeKeyOf));
  const ruleOut = new Set(entriesOf(targeting?.exclude_locations).map(placeKeyOf).filter(Boolean));
  const leftOut = (e) => ruleOut.size > 0 && holdsPlace(ruleOut, e);
  for (const e of own) {
    if (!placeKeyOf(e)) {
      out.notSearched.push({ entry: e, why: NOT_SEARCHED });
      continue;
    }
    if (leftOut(e)) {
      out.notSearched.push({ entry: e, why: NOT_SEARCHED_EXCLUDED });
      continue;
    }
    if (holdsPlace(ruleKeys, e)) {
      send(e);
      continue;
    }
    if (!e.city) {
      const inside = rules.filter((r) => r.country === e.country && (!e.state || r.state === e.state) && !leftOut(r));
      if (inside.length) {
        out.replaced.push({ entry: e, by: inside });
        for (const r of inside) send(r);
        continue;
      }
    }
    out.notSearched.push({ entry: e, why: NOT_SEARCHED });
  }
  return out;
}

// ── Checking what a manager or the seed sends ───────────────────────────────

/**
 * The editable lists as sent, checked for shape and limits (places are
 * resolved separately: checkPlaces). All four lists are required, so a save
 * never empties a list by leaving it out. Places may be typed text
 * ("Spokane, Washington") or entries; keywords are trimmed, once each (case
 * aside, the first spelling kept), at most VALUE_MAX characters.
 *
 * @param {unknown} input  { include_locations, exclude_locations, unplaced, exclude_keywords }
 * @returns {{ value: { include_locations: Array<string | PlaceEntry>, exclude_locations: Array<string | PlaceEntry>,
 *             unplaced: UnplacedValue[], exclude_keywords: string[] }, errors: string[] }}
 */
export function cleanOwnInput(input) {
  const errors = [];
  const v = isObject(input) ? input : {};
  const places = (raw, label) => {
    if (!Array.isArray(raw)) {
      errors.push(`${label}: must be a list`);
      return [];
    }
    const out = [];
    for (const x of raw) {
      if (typeof x === "string") {
        const t = clean(x);
        if (!t) continue;
        if (t.length > TEXT_MAX) errors.push(`${label}: "${t.slice(0, 40)}..." is over ${TEXT_MAX} characters`);
        else out.push(t);
      } else if (isObject(x)) out.push(canonEntry(x));
      else errors.push(`${label}: ${JSON.stringify(x)?.slice(0, 40)} is not a place`);
    }
    if (out.length > PLACES_MAX) errors.push(`${label}: at most ${PLACES_MAX.toLocaleString("en-US")} places (${out.length.toLocaleString("en-US")} given)`);
    return out;
  };
  const include_locations = places(v.include_locations, "Places");
  const exclude_locations = places(v.exclude_locations, "Places left out");

  const exclude_keywords = [];
  const seen = new Set();
  if (!Array.isArray(v.exclude_keywords)) errors.push("Excluded keywords: must be a list");
  for (const x of Array.isArray(v.exclude_keywords) ? v.exclude_keywords : []) {
    if (typeof x !== "string") {
      errors.push(`Excluded keywords: ${JSON.stringify(x)?.slice(0, 40)} is not text`);
      continue;
    }
    const t = clean(x);
    if (!t || seen.has(t.toLowerCase())) continue;
    if (t.length > VALUE_MAX) {
      errors.push(`Excluded keywords: "${t.slice(0, 40)}..." is over ${VALUE_MAX} characters`);
      continue;
    }
    seen.add(t.toLowerCase());
    exclude_keywords.push(t);
  }
  if (exclude_keywords.length > KEYWORDS_MAX) errors.push(`Excluded keywords: at most ${KEYWORDS_MAX.toLocaleString("en-US")} (${exclude_keywords.length.toLocaleString("en-US")} given)`);

  if (!Array.isArray(v.unplaced)) errors.push("Unplaced values: must be a list");
  const unplaced = (Array.isArray(v.unplaced) ? v.unplaced : []).filter(isObject).map(unplacedOf).filter((u) => u.value);
  if (unplaced.length > UNPLACED_MAX) errors.push(`Unplaced values: at most ${UNPLACED_MAX.toLocaleString("en-US")}`);
  return { value: { include_locations, exclude_locations, unplaced, exclude_keywords }, errors };
}

// ── The resolver (pure) ─────────────────────────────────────────────────────

/** The version a save must send back: the row's, or (no row) the rules' and the starter list's. */
export function ownVersionOf({ row, targeting, starter }) {
  if (row) return `row:${row.version}`;
  return `rules:${targeting?.version ?? "none"}|starter:${starter?.updatedAt ?? "none"}`;
}

/** What a client with no row searches: its rules' places (live) and the starter keywords. */
export function derivedOwn(targeting, starter) {
  return {
    include_locations: entriesOf(targeting?.include_locations),
    exclude_locations: entriesOf(targeting?.exclude_locations),
    unplaced: [],
    exclude_keywords: [...(starter?.items ?? [])],
  };
}

/**
 * What a LinkedIn search of this client and kind uses (no database: the
 * caller reads the parts). See EffectiveLinkedin.
 *
 * @param {{ tag: string, kind: LinkedinKind, row: LinkedinRow | null, targeting: object | null, starter: Starter | null,
 *           saved: Record<string, any> | null, clientType?: string | null,
 *           competitors?: import("./competitors.mjs").Competitors }} parts
 *   targeting: client_targeting's row with version (updated_at as text), or null;
 *   saved: client_people_filters' row with version, or null;
 *   competitors: the built-in competitors list (readCompetitors); left out, the 069 seed
 * @returns {EffectiveLinkedin}
 */
export function resolveLinkedin({ tag, kind, row, targeting, starter, saved, clientType = null, competitors = undefined }) {
  if (!LINKEDIN_KINDS.includes(kind)) throw new Error(`kind must be people or companies, not "${kind}"`);
  const t = normTag(tag);
  const blockers = [];
  const own = row ? ownOf(row) : derivedOwn(targeting, starter);
  if (!row && !starter?.loaded) {
    blockers.push(`${t} has no LinkedIn ${kind} settings of its own, and the starter keyword list is not loaded yet (the LinkedIn seed writes it), so its search would leave out nothing beyond the standard keywords. Save this client's own keywords on the AI Ark tab, or load the starter list first.`);
  }
  const search = narrowPlaces(own.include_locations, targeting, { exclude: own.exclude_locations });
  if (own.include_locations.length && !search.include.length) {
    blockers.push(`None of ${t}'s ${fmtN(own.include_locations.length)} LinkedIn ${kind} places is inside its sending rules, so nothing would be searched. ${NOT_SEARCHED_FIX} Or change the LinkedIn places on the AI Ark tab.`);
  }
  const savedValue = saved ? Object.fromEntries(Object.entries(saved).filter(([k]) => k !== "version" && k !== "updated_at")) : null;
  const f = filtersFor(savedValue, { clientType, scope: "linkedin" });
  const filters = { value: f.from === "saved" ? cleanPeopleFilters(f.value).value : f.value, from: f.from === "saved" ? "saved" : "cleaning" };
  const versions = {
    own: ownVersionOf({ row, targeting, starter }),
    filters: saved ? String(saved.version ?? "") || null : null,
    rules: targeting ? String(targeting.version ?? "") || null : null,
  };
  // A client with its own row searches its places narrowed to its rules, so a change of the rules is a change of the plan.
  const rulesPart = row ? `|rules:${versions.rules ?? "none"}` : "";
  return {
    tag: t,
    kind,
    from: row ? "row" : "rules_and_starter",
    own,
    filters,
    cleaning: true,
    keywords: keywordsFor(own.exclude_keywords, competitors),
    competitors,
    search,
    outsideRules: outsideRules(own.include_locations, targeting),
    row: row ?? null,
    starter: { loaded: Boolean(starter?.loaded), items: starter?.items?.length ?? 0, version: starter?.version ?? null },
    blockers,
    versions,
    version: `${versions.own}${rulesPart}|filters:${versions.filters ?? "none"}`,
  };
}

// ── Reading (database) ──────────────────────────────────────────────────────

const ROW_FIELDS = `client_tag, kind, include_locations, exclude_locations, unplaced, exclude_keywords, notes, flags, source, copied_from,
  clay_source_id, clay_campaign, clay_set_up_at, clay_fingerprint, seed_sha256, seeded_at, updated_by, created_at, updated_at,
  updated_at::text AS version`;

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {string} tag
 * @param {LinkedinKind} kind
 * @param {{ lock?: boolean }} [opts]
 * @returns {Promise<LinkedinRow | null>}
 */
export async function readLinkedinRow(db, tag, kind, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT ${ROW_FIELDS} FROM client_linkedin_settings WHERE client_tag = $1 AND kind = $2${lock ? " FOR UPDATE" : ""}`,
    [normTag(tag), kind]
  );
  return rows[0] ?? null;
}

/** The client's database rules, read live, with their version. */
export async function readTargeting(db, tag) {
  const { rows } = await db.query(
    `SELECT include_locations, exclude_locations, exclude_terms, countries, updated_at::text AS version
       FROM client_targeting WHERE client_tag = $1`,
    [normTag(tag)]
  );
  return rows[0] ?? null;
}

/** The client's saved AI Ark people filters, with their version, or null. */
export async function readSavedFilters(db, tag) {
  const { rows } = await db.query(
    `SELECT titles, title_mode, exclude_titles, seniority, departments, employee_bands, industries, exclude_industries,
            updated_at::text AS version
       FROM client_people_filters WHERE client_tag = $1`,
    [normTag(tag)]
  );
  return rows[0] ?? null;
}

/** @returns {Promise<Starter>} */
export async function readStarter(db) {
  const { rows } = await db.query(`SELECT value, updated_at::text AS version FROM enrich_settings WHERE key = 'linkedin_starter_keywords'`);
  const s = starterFrom(rows[0]?.value);
  return { ...s, updatedAt: rows[0]?.version ?? null, loaded: s.items.length > 0 };
}

/**
 * The resolver with its parts read live: the row, the client's type, its
 * rules, its saved filters and the starter list.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ tag: string, kind: LinkedinKind }} opts
 * @returns {Promise<EffectiveLinkedin & { client: { tag: string, name: string | null, client_type: string | null, status: string | null } | null }>}
 */
export async function linkedinSettingsFor(db, { tag, kind }) {
  const t = normTag(tag);
  const { rows: [client] } = await db.query(`SELECT tag, name, client_type, status FROM client_tags WHERE tag = $1`, [t]);
  const row = await readLinkedinRow(db, t, kind);
  const targeting = await readTargeting(db, t);
  const saved = await readSavedFilters(db, t);
  const starter = await readStarter(db);
  const competitors = await readCompetitors(db);
  return { ...resolveLinkedin({ tag: t, kind, row, targeting, starter, saved, clientType: client?.client_type ?? null, competitors }), client: client ?? null };
}

/**
 * A client's newest log entries for a kind, for the AI Ark tab: who, when,
 * and the counts before and after (the lists themselves stay in the table).
 *
 * @returns {Promise<Array<{ id: number, action: "save" | "seed", at: string, by: string | null, by_name: string | null,
 *   seeded_by: string | null, before: Record<string, number> | null, after: Record<string, number> }>>}
 */
export async function logFor(db, { tag, kind, limit = 10 }) {
  const { rows } = await db.query(
    `SELECT l.id, l.action, l.changed_at AS at, l.changed_by AS by, up.full_name AS by_name, l.seeded_by, l.before, l.after
       FROM client_linkedin_settings_log l LEFT JOIN user_profiles up ON up.id = l.changed_by
      WHERE l.client_tag = $1 AND l.kind = $2
      ORDER BY l.changed_at DESC, l.id DESC LIMIT $3`,
    [normTag(tag), kind, Math.max(1, Math.min(100, Number(limit) || 10))]
  );
  const counts = (x) =>
    x ? { places: entriesOf(x.include_locations).length, excluded_places: entriesOf(x.exclude_locations).length,
          unplaced: Array.isArray(x.unplaced) ? x.unplaced.length : 0, keywords: textsOf(x.exclude_keywords).length } : null;
  return rows.map((r) => ({ id: Number(r.id), action: r.action, at: r.at, by: r.by, by_name: r.by_name, seeded_by: r.seeded_by, before: counts(r.before), after: counts(r.after) }));
}

// ── Writing (database, inside the caller's transaction) ─────────────────────

const lockTag = (db, tag) => db.query(`SELECT pg_advisory_xact_lock(hashtext('linkedin-settings:' || $1))`, [tag]);

/** Places as sent (text or entries) resolved to stored entries; each refusal named. */
async function resolvePlaces(db, geo, places, label, errors) {
  const entries = [];
  const labels = [];
  for (const p of places) {
    if (typeof p === "string") {
      const r = placeFromText(p, geo);
      if ("why" in r) errors.push(`${label}: ${p}: ${r.why}`);
      else {
        entries.push(r.entry);
        labels.push(p);
      }
    } else {
      entries.push(p);
      labels.push(placeText(p, geo));
    }
  }
  const checked = await checkPlaces(db, entries, geo, { label: (_e, i) => `${label}: ${labels[i]}` });
  errors.push(...checked.errors);
  return checked.entries;
}

/**
 * A manager's save on the AI Ark tab (D-P4-2): the client's own lists for one
 * kind. Inside the caller's transaction: the client must exist (404); a lock
 * per client covers two first saves at once; the version the page loaded must
 * still be current (409, nothing saved); places are resolved and checked, and
 * keywords cleaned (400 with each reason); an unplaced value can be kept or
 * removed, never added. The row is written as source 'manual' (its Clay
 * columns kept) and the log gets who, when, the lists before (for a client
 * with no row: what the page showed, its rules' places and the starter list)
 * and after. A save that changes nothing on an existing row writes nothing.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ tag: string, kind: LinkedinKind, input: unknown, version: string | null, userId: string, geo: object }} opts
 * @returns {Promise<{ status: 200, saved: boolean, unchanged: boolean, row: LinkedinRow, version: string }
 *   | { status: 400 | 404 | 409, error: string, errors?: string[], changed?: boolean }>}
 */
export async function saveLinkedinSettings(db, { tag, kind, input, version, userId, geo }) {
  const t = normTag(tag);
  if (!LINKEDIN_KINDS.includes(kind)) return { status: 400, error: "kind must be people or companies" };
  if (!userId) return { status: 400, error: "A save needs the person who makes it" };
  const shape = cleanOwnInput(input);
  if (shape.errors.length) return { status: 400, error: shape.errors.join(" · "), errors: shape.errors };
  const { rows: known } = await db.query(`SELECT 1 FROM client_tags WHERE tag = $1`, [t]);
  if (!known.length) return { status: 404, error: `${t} is not a client` };
  await lockTag(db, t);
  const row = await readLinkedinRow(db, t, kind, { lock: true });
  const targeting = row ? null : await readTargeting(db, t);
  const starter = row ? null : await readStarter(db);
  const current = ownVersionOf({ row, targeting, starter });
  if (current !== version) {
    return {
      status: 409,
      changed: true,
      error: `${t}'s LinkedIn ${kind} settings changed since this page loaded them (in another tab, by someone else, by the seed, or in the client's rules). Reload to see them; nothing was saved.`,
    };
  }
  const errors = [];
  const include = await resolvePlaces(db, geo, shape.value.include_locations, "Places", errors);
  const exclude = await resolvePlaces(db, geo, shape.value.exclude_locations, "Places left out", errors);
  const stored = row ? ownOf(row).unplaced : [];
  const keyU = (u) => `${u.side}|${u.field}|${u.value}`;
  const sent = new Set(shape.value.unplaced.map(keyU));
  const storedKeys = new Set(stored.map(keyU));
  const added = shape.value.unplaced.filter((u) => !storedKeys.has(keyU(u)));
  if (added.length) errors.push(`Unplaced values can be kept or removed, not added: ${added.slice(0, 3).map((u) => `"${u.value}"`).join(", ")}`);
  if (errors.length) return { status: 400, error: errors.slice(0, 20).join(" · "), errors };

  const after = { include_locations: include, exclude_locations: exclude, unplaced: stored.filter((u) => sent.has(keyU(u))), exclude_keywords: shape.value.exclude_keywords };
  const before = row ? ownOf(row) : derivedOwn(targeting, starter);
  if (row && sameOwn(before, after)) return { status: 200, saved: false, unchanged: true, row, version: current };
  const { rows: [saved] } = await db.query(
    `INSERT INTO client_linkedin_settings (client_tag, kind, include_locations, exclude_locations, unplaced, exclude_keywords, source, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)
     ON CONFLICT (client_tag, kind) DO UPDATE
       SET include_locations = EXCLUDED.include_locations, exclude_locations = EXCLUDED.exclude_locations, unplaced = EXCLUDED.unplaced,
           exclude_keywords = EXCLUDED.exclude_keywords, source = 'manual', updated_by = EXCLUDED.updated_by
     RETURNING ${ROW_FIELDS}`,
    [t, kind, JSON.stringify(after.include_locations), JSON.stringify(after.exclude_locations), JSON.stringify(after.unplaced), after.exclude_keywords, userId]
  );
  await db.query(
    `INSERT INTO client_linkedin_settings_log (client_tag, kind, action, changed_by, before, after) VALUES ($1, $2, 'save', $3, $4, $5)`,
    [t, kind, userId, JSON.stringify({ from: row ? "row" : "rules_and_starter", ...before }), JSON.stringify({ from: "row", ...after })]
  );
  return { status: 200, saved: true, unchanged: false, row: saved, version: ownVersionOf({ row: saved }) };
}

/**
 * The seed's write of one client and kind (D-P4-4): never over a row a person
 * saved (source 'manual'), nothing when the row already holds exactly this,
 * else the row (source 'clay') and a log entry, in the caller's transaction.
 * The places must already be in their stored form: each is checked against
 * the geo reference and a row with a place that isn't one is refused.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ tag: string, kind: LinkedinKind, value: LinkedinOwn & { notes?: string[], flags?: string[], copied_from?: LinkedinKind | null },
 *           provenance: { clay_source_id?: string | null, clay_campaign?: string | null, clay_set_up_at?: string | null, clay_fingerprint?: string | null },
 *           sha256: string, seededBy: string, geo: object }} opts
 * @returns {Promise<{ status: "written" | "replaced" | "unchanged" | "kept_manual" | "no_client" | "refused", errors?: string[] }>}
 */
export async function seedLinkedinRow(db, { tag, kind, value, provenance = {}, sha256, seededBy, geo }) {
  const t = normTag(tag);
  if (!LINKEDIN_KINDS.includes(kind)) return { status: "refused", errors: [`kind must be people or companies, not "${kind}"`] };
  if (!/^[0-9a-f]{64}$/.test(String(sha256 ?? ""))) return { status: "refused", errors: ["the seed file's sha256 is missing"] };
  if (!seededBy) return { status: "refused", errors: ["who ran the seed is missing"] };
  const own = ownOf(value);
  const shape = cleanOwnInput({ ...own, unplaced: own.unplaced });
  const errors = [...shape.errors];
  for (const [label, list] of [["include", own.include_locations], ["exclude", own.exclude_locations]]) {
    const checked = await checkPlaces(db, list, geo, { verify: true, label: (e) => `${t} ${kind} ${label} ${JSON.stringify(e)}` });
    errors.push(...checked.errors);
  }
  if (errors.length) return { status: "refused", errors };
  const { rows: known } = await db.query(`SELECT 1 FROM client_tags WHERE tag = $1`, [t]);
  if (!known.length) return { status: "no_client" };
  await lockTag(db, t);
  const row = await readLinkedinRow(db, t, kind, { lock: true });
  if (row?.source === "manual") return { status: "kept_manual" };
  const extra = {
    notes: textsOf(value?.notes),
    flags: textsOf(value?.flags),
    copied_from: LINKEDIN_KINDS.includes(value?.copied_from) ? value.copied_from : null,
    clay_source_id: provenance.clay_source_id ?? null,
    clay_campaign: provenance.clay_campaign ?? null,
    clay_set_up_at: provenance.clay_set_up_at ?? null,
    clay_fingerprint: provenance.clay_fingerprint ?? null,
  };
  if (row) {
    const sameExtra =
      JSON.stringify([row.notes, row.flags, row.copied_from, row.clay_source_id, row.clay_campaign, row.clay_fingerprint]) ===
        JSON.stringify([extra.notes, extra.flags, extra.copied_from, extra.clay_source_id, extra.clay_campaign, extra.clay_fingerprint]) &&
      (row.clay_set_up_at === null) === (extra.clay_set_up_at === null) &&
      (row.clay_set_up_at === null || new Date(row.clay_set_up_at).getTime() === new Date(extra.clay_set_up_at).getTime());
    if (sameExtra && sameOwn(row, own)) return { status: "unchanged" };
  }
  await db.query(
    `INSERT INTO client_linkedin_settings (client_tag, kind, include_locations, exclude_locations, unplaced, exclude_keywords, notes, flags,
                                           source, copied_from, clay_source_id, clay_campaign, clay_set_up_at, clay_fingerprint, seed_sha256,
                                           seeded_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'clay', $9, $10, $11, $12, $13, $14, now(), NULL)
     ON CONFLICT (client_tag, kind) DO UPDATE
       SET include_locations = EXCLUDED.include_locations, exclude_locations = EXCLUDED.exclude_locations, unplaced = EXCLUDED.unplaced,
           exclude_keywords = EXCLUDED.exclude_keywords, notes = EXCLUDED.notes, flags = EXCLUDED.flags, source = 'clay',
           copied_from = EXCLUDED.copied_from, clay_source_id = EXCLUDED.clay_source_id, clay_campaign = EXCLUDED.clay_campaign,
           clay_set_up_at = EXCLUDED.clay_set_up_at, clay_fingerprint = EXCLUDED.clay_fingerprint, seed_sha256 = EXCLUDED.seed_sha256,
           seeded_at = now(), updated_by = NULL`,
    [t, kind, JSON.stringify(own.include_locations), JSON.stringify(own.exclude_locations), JSON.stringify(own.unplaced), own.exclude_keywords,
     extra.notes, extra.flags, extra.copied_from, extra.clay_source_id, extra.clay_campaign, extra.clay_set_up_at, extra.clay_fingerprint, sha256]
  );
  await db.query(
    `INSERT INTO client_linkedin_settings_log (client_tag, kind, action, seeded_by, seed_sha256, before, after) VALUES ($1, $2, 'seed', $3, $4, $5, $6)`,
    [t, kind, seededBy, sha256, row ? JSON.stringify({ from: "row", ...ownOf(row) }) : null, JSON.stringify({ from: "row", ...own, ...extra })]
  );
  return { status: row ? "replaced" : "written" };
}

/**
 * The seed's write of the starter keywords (D-P4-5): once, versioned; nothing
 * when the stored list is already this one.
 *
 * @returns {Promise<{ status: "written" | "unchanged", count: number }>}
 */
export async function writeStarter(db, { items, version, source, sha256 }) {
  const value = starterFrom({ items, version, source, sha256, seeded_at: new Date().toISOString() });
  const current = await readStarter(db);
  if (current.loaded && JSON.stringify(current.items) === JSON.stringify(value.items) && current.version === value.version && current.sha256 === value.sha256) {
    return { status: "unchanged", count: value.items.length };
  }
  await db.query(
    `INSERT INTO enrich_settings (key, value, updated_at) VALUES ('linkedin_starter_keywords', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(value)]
  );
  return { status: "written", count: value.items.length };
}
