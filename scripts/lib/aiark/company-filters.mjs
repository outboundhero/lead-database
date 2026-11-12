// What AI Ark's Company Search is asked for a client (the Companies tab), and
// how a company already bought is matched against a client's places and
// company filters without asking AI Ark again (the free registry copy in
// company-runs.mjs).
//
// The request reuses the people search's parts (filters.mjs): the places go
// out the same way ("City, State", a state or a country, packed into groups AI
// Ark is known to take), and the company filters are the same accountFilters()
// people searches send, so both kinds of pull ask for the same companies. There
// are no job titles: one search per group of places.
//
// AI Ark finds a company when ANY of its offices is in a place, not only its
// head office (docs, 2026-11-13), and a "City, State" place is not documented,
// so every row re-checks its offices against the client's area (client_office).
//
// Place keys: 'US', 'US|IL' and 'US|IL|springfield' (a city reduced to letters,
// cityKey in geo.mjs). The registry (aiark_companies.place_keys) holds the keys
// of a company's head office and every other office; a client's entry has one
// key. A company is in a client's places when an office key equals an entry key.
//
// Plain JavaScript: the Companies tab's routes and the worker share it.

import { ARRAY_MAX, COMPANY_PRICE } from "./client.mjs";
import {
  accountFilters,
  BANDS_NOTE,
  bytes,
  CLEANING_DEFAULTS,
  EMPTY_PEOPLE_FILTERS,
  MAX_REQUESTS,
  pack,
  PLACES_BYTES,
  VALUE_MAX,
} from "./filters.mjs";
import { cityKey, findState, placeString } from "./geo.mjs";

export const OFFICES_MAX = 25; // offices kept on a row, head office first
const KEY_OFFICES_MAX = 200; // offices whose place keys the registry keeps

const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const wordsOf = (s) => String(s ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Does `text` hold the words of `phrase`, in order and side by side (AI Ark's WORD match)? */
export function hasWords(text, phrase) {
  const inner = wordsOf(phrase);
  const outer = wordsOf(text);
  if (!inner.length) return false;
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

// ── Company filters ─────────────────────────────────────────────────────────

/** The filters a company search reads. They live in client_people_filters, beside the people filters. */
export const COMPANY_FILTER_KEYS = ["employee_bands", "industries", "exclude_industries"];

export const EMPTY_COMPANY_FILTERS = { employee_bands: [], industries: [], exclude_industries: [] };

/** A cleaning client's company filters until someone saves its own: 8 to 6,800 employees and the 13 standard industries left out. */
export const CLEANING_COMPANY_DEFAULTS = {
  employee_bands: CLEANING_DEFAULTS.employee_bands,
  industries: CLEANING_DEFAULTS.industries,
  exclude_industries: CLEANING_DEFAULTS.exclude_industries,
};

/** The company filters out of a people-filters object (saved, or the defaults). */
export function pickCompanyFilters(filters) {
  const f = { ...EMPTY_PEOPLE_FILTERS, ...(filters ?? {}) };
  return Object.fromEntries(COMPANY_FILTER_KEYS.map((k) => [k, Array.isArray(f[k]) ? f[k] : []]));
}

/**
 * A client's company filters: its saved client_people_filters row, else a
 * cleaning client's defaults, else none. `saved` is the row or null.
 */
export function companyFiltersFor(saved, clientType) {
  if (saved) return { saved: true, defaultsFrom: null, value: pickCompanyFilters(saved) };
  const cleaning = clientType === "Cleaning";
  return { saved: false, defaultsFrom: cleaning ? "cleaning" : null, value: cleaning ? { ...CLEANING_COMPANY_DEFAULTS } : { ...EMPTY_COMPANY_FILTERS } };
}

// ── The request ─────────────────────────────────────────────────────────────

/**
 * The Company Search bodies for a client: one per group of places, each with
 * the excluded places and the company filters. Nothing is counted or pulled
 * with a blocker: no rules, no places (AI Ark would search everywhere, and a
 * search of exclusions alone is one AI Ark refuses), or more searches than a
 * pull can hold.
 *
 * @param {{ targeting: object | null, filters?: object | null, geo: object, cleaning?: boolean }} opts
 *   filters: employee_bands, industries and exclude_industries (a whole people-filters object is fine)
 * @returns {{ requests: object[], report: object, notes: string[], blockers: string[], pullBlockers: string[] }}
 */
export function buildCompanyRequests({ targeting, filters = null, geo, cleaning = false }) {
  const notes = [];
  const blockers = [];
  const pullBlockers = [];

  if (!targeting) {
    blockers.push("This client has no targeting rules yet. Add its locations and exclusions on the Clients page (Rules) or sync the sheet.");
    return { requests: [], report: { locations: { total: 0, sent: 0, requests: 0, examples: [], dropped: [] } }, notes, blockers, pullBlockers };
  }

  const placesIn = [];
  const dropped = [];
  for (const e of Array.isArray(targeting.include_locations) ? targeting.include_locations : []) {
    const r = placeString(e, geo);
    if (r.value) placesIn.push(r.value);
    else dropped.push({ entry: e, why: r.why });
  }
  const uniq = [...new Set(placesIn)];
  const placesOut = [];
  for (const e of Array.isArray(targeting.exclude_locations) ? targeting.exclude_locations : []) {
    const r = placeString(e, geo);
    if (r.value) placesOut.push(r.value);
    else dropped.push({ entry: e, why: r.why, exclude: true });
  }
  const excludePlaces = [...new Set(placesOut)].slice(0, ARRAY_MAX);

  if (!uniq.length) blockers.push("The client's rules have no locations, so AI Ark would search everywhere. Add locations first.");
  if (uniq.length) {
    notes.push("AI Ark finds a company when any of its offices is in one of these places, not only its head office. Each company's offices are checked against the client's area after the pull, and the office inside it is the one used.");
  }
  if (uniq.some((s) => s.includes(","))) {
    notes.push(`Places are sent as "City, State". AI Ark's docs don't say how it reads a city with its state, so every company is re-checked against the client's area after the pull.`);
  }
  if (dropped.length) {
    notes.push(`${dropped.length} location ${dropped.length === 1 ? "entry was" : "entries were"} left out: ${dropped.slice(0, 3).map((d) => `${JSON.stringify(d.entry)} (${d.why})`).join("; ")}${dropped.length > 3 ? " …" : ""}`);
  }
  if (placesOut.length > ARRAY_MAX) notes.push(`Only the first ${ARRAY_MAX} of ${placesOut.length} excluded places are sent; all are re-checked after the pull.`);

  const acct = accountFilters({ targeting, filters: pickCompanyFilters(filters), cleaning });
  if (acct.clientTerms.length) {
    notes.push(`AI Ark matches excluded words as whole words; the lead database matches them anywhere in the text ("bar" also drops "Barbershop"). That stricter check runs after the pull.`);
  }
  if (acct.bands.length) notes.push(BANDS_NOTE);
  if (acct.tooLong.length) {
    notes.push(`${acct.tooLong.length} filter ${acct.tooLong.length === 1 ? "value is" : "values are"} over ${VALUE_MAX} characters and left out.`);
  }

  const placeGroups = pack(uniq, PLACES_BYTES);
  if (placeGroups.length > MAX_REQUESTS) {
    blockers.push(`These ${uniq.length.toLocaleString("en-US")} places would take ${placeGroups.length} searches, more than one pull can send (${MAX_REQUESTS}). Shorten the locations.`);
  }
  const requests = blockers.length
    ? []
    : placeGroups.map((g) => ({
        account: {
          location: { any: { include: g, ...(excludePlaces.length ? { exclude: excludePlaces } : {}) } },
          ...acct.account,
        },
      }));

  if (acct.terms.length > acct.merged.length) {
    notes.push(`Shorter phrases stand in for longer ones ("cleaning" also finds "cleaning services"), which keeps the request small and changes no company's match.`);
  }
  if (requests.length > 1) {
    notes.push(`AI Ark limits how much one request can hold, so this goes out as ${requests.length} searches, one for each group of places. Counts are added up, so a company with offices in two groups is counted twice; a pull leaves out the companies it has already bought.`);
  }
  if (acct.termsCovered < acct.terms.length) {
    notes.push(`AI Ark's limits leave room for ${acct.termsCovered} of this client's ${acct.terms.length} exclusion terms in the search. The others are checked after the pull, when the company is already paid for (${COMPANY_PRICE} credit).`);
  }

  return {
    requests,
    report: {
      locations: { total: uniq.length, sent: uniq.length, requests: requests.length, examples: uniq.slice(0, 6), dropped },
      excludeLocations: { total: placesOut.length, sent: excludePlaces.length },
      excludeTerms: { total: acct.terms.length, sent: acct.termsCovered, standard: acct.standardTerms.length },
      excludeCompanyTypes: acct.account.type?.any?.exclude ?? [],
      bands: acct.bands,
      industries: acct.industries.length,
      excludeIndustries: acct.excludeIndustries.length,
      industryValues: acct.industries,
      excludeIndustryValues: acct.excludeIndustries,
      requestBytes: requests.length ? Math.max(...requests.map(bytes)) : 0,
      commercialCleaning: Boolean(targeting.commercial_cleaning),
    },
    notes,
    blockers,
    pullBlockers,
  };
}

// ── Spend ───────────────────────────────────────────────────────────────────

/**
 * Where a company pull stops itself: its size at 0.1 credit, a quarter on top,
 * and room for each search. A 100-company pull with 1 search stops at 16.
 */
export function companySpendCeiling(size, searches) {
  return Math.ceil(Number(size) * 0.125) + Math.max(1, Number(searches) || 1) + 2;
}

/** Dollars per company for the searches and checks (design section 7): typical when listed, and the worst case. */
export const COMPANY_COST_USD = { typicalLow: 0.014, typicalHigh: 0.028, worst: 0.085 };

/** The pull form's estimate: AI Ark credits, the brake, and the OpenAI and Reoon dollars at worst. */
export function estimateCompanyPull({ size, searches = 1 }) {
  const n = Math.max(0, Math.floor(Number(size) || 0));
  return {
    credits: Math.round(n * COMPANY_PRICE * 10) / 10,
    brake: companySpendCeiling(n, searches),
    usdTypical: [Math.round(n * COMPANY_COST_USD.typicalLow * 100) / 100, Math.round(n * COMPANY_COST_USD.typicalHigh * 100) / 100],
    usdWorst: Math.round(n * COMPANY_COST_USD.worst * 100) / 100,
  };
}

// ── Offices and place keys ──────────────────────────────────────────────────

/**
 * A company's offices as AI Ark lists them, head office first, each
 * { street, city, state, country, postal_code, hq? } as text, the same office
 * listed twice (AI Ark repeats the head office among its locations) kept once.
 * A city written "Madison, Wi" with no state becomes city "Madison", state "Wi".
 * A state such as "nj - new jersey" is kept as it is: resolveOffice tries both halves.
 */
export function officesOf(record) {
  const loc = record?.location ?? {};
  const raw = [
    loc.headquarter && typeof loc.headquarter === "object" ? { ...loc.headquarter, hq: true } : null,
    ...(Array.isArray(loc.locations) ? loc.locations : []),
  ].filter((o) => o && typeof o === "object");
  const out = [];
  const seen = new Set();
  for (const o of raw) {
    let city = clean(o.city);
    let state = clean(o.state);
    const country = clean(o.country);
    if (!state && city.includes(",")) {
      const at = city.lastIndexOf(",");
      state = city.slice(at + 1).trim();
      city = city.slice(0, at).trim();
    }
    const office = { street: clean(o.street), city, state, country, postal_code: clean(o.postal_code) };
    if (!office.street && !office.city && !office.state && !office.country) continue;
    const key = [office.street, office.city, office.state, office.country, office.postal_code].join("|").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(o.hq ? { ...office, hq: true } : office);
  }
  return out;
}

/** "nj - new jersey" -> ["nj", "new jersey"]; anything else -> [itself]. */
export function stateHalves(state) {
  const s = clean(state);
  if (!s) return [];
  const parts = s.split(/\s+-\s+/).map((x) => x.trim()).filter(Boolean);
  return parts.length > 1 ? parts : [s];
}

/**
 * One office as codes, the way the location resolver places a lead: the state
 * (either half of "nj - new jersey") decides, and the country only rules a
 * state out. No state: just the country, if AI Ark gave one we know.
 * @returns {{ country: string | null, state: string | null, city: string | null }}
 */
export function resolveOffice(office, geo) {
  const said = clean(office?.country) ? geo.countryCode.get(cityKey(office.country)) ?? null : null;
  const found = stateHalves(office?.state).map((h) => findState(geo, h)).find(Boolean) ?? null;
  const place = found && (!said || found.country === said) ? found : null;
  return { country: place?.country ?? said, state: place?.state ?? null, city: cityKey(office?.city) || null };
}

/** The place keys of one resolved office. */
export function officeKeys(resolved) {
  const { country, state, city } = resolved ?? {};
  if (!country) return [];
  if (!state) return [country];
  return city ? [country, `${country}|${state}`, `${country}|${state}|${city}`] : [country, `${country}|${state}`];
}

/** The place key of one client_targeting entry ({city, state, country} codes), or null. */
export function placeKeyOf(entry) {
  const country = clean(entry?.country).toUpperCase();
  const state = clean(entry?.state).toUpperCase();
  const city = cityKey(entry?.city);
  if (!country) return null;
  if (!state) return city ? null : country;
  return city ? `${country}|${state}|${city}` : `${country}|${state}`;
}

/** Every place key of a company's offices, for aiark_companies.place_keys. */
export function companyPlaceKeys(record, geo) {
  const keys = new Set();
  for (const o of officesOf(record).slice(0, KEY_OFFICES_MAX)) for (const k of officeKeys(resolveOffice(o, geo))) keys.add(k);
  return [...keys];
}

// ── The registry copy ───────────────────────────────────────────────────────

/**
 * What a company must match to be copied into a client's table: the client's
 * places as keys (only entries AI Ark was sent), and the company filters
 * exactly as the pull's request sent them. Made when the pull is created and
 * kept on the run (filters.copy).
 */
export function companyMatch({ targeting, request, geo }) {
  const keysOf = (entries) => [
    ...new Set((Array.isArray(entries) ? entries : []).filter((e) => placeString(e, geo).value).map(placeKeyOf).filter(Boolean)),
  ];
  const a = request?.account ?? {};
  const contentOf = (x) => (Array.isArray(x) ? x : Array.isArray(x?.content) ? x.content : []);
  return {
    include: keysOf(targeting?.include_locations),
    exclude: keysOf(targeting?.exclude_locations).slice(0, ARRAY_MAX),
    bands: Array.isArray(a.employeeSize?.range) ? a.employeeSize.range : [],
    industries: contentOf(a.industries?.any?.include).map((s) => String(s).toLowerCase()),
    exclude_industries: contentOf(a.industries?.any?.exclude).map((s) => String(s).toLowerCase()),
    exclude_types: contentOf(a.type?.any?.exclude).map((s) => String(s).toUpperCase()),
    terms: contentOf(a.keyword?.any?.exclude).map(String),
  };
}

/** A company's industries, lower case: its main one and the list. */
function industriesOf(record) {
  const all = [record?.summary?.industry, ...(Array.isArray(record?.industries) ? record.industries : [])];
  return [...new Set(all.map((s) => clean(s).toLowerCase()).filter(Boolean))];
}

/**
 * Is the company inside the bands? AI Ark's docs don't say whether it reads the
 * headcount or the band, and they disagree in its own examples, so either one counts.
 */
function inBands(staff, bands) {
  const fits = (n) => bands.some((b) => (b.start == null || n >= Number(b.start)) && (b.end == null || n <= Number(b.end)));
  const total = Number(staff?.total);
  if (Number.isFinite(total) && total > 0 && fits(total)) return true;
  const start = Number(staff?.range?.start);
  const end = Number(staff?.range?.end);
  if (!Number.isFinite(start) || start <= 0) return false;
  return bands.some((b) => (b.end == null || start <= Number(b.end)) && (b.start == null || !Number.isFinite(end) || end >= Number(b.start)));
}

/**
 * Would this pull's search return the company? Some office in one of the
 * client's places and none in a place it excludes (AI Ark's "any"), then the
 * company filters as AI Ark applies them: size bands, industries to include
 * (whole words) and to leave out (exact values), company types left out, and
 * the excluded terms as whole words in the name, industries or description.
 *
 * @param {object} record  an AI Ark company record (trimmed or not)
 * @param {ReturnType<typeof companyMatch>} match
 * @param {object} geo     loadGeo()'s maps
 */
export function matchesCompanyFilters(record, match, geo) {
  if (!record || !match) return false;
  const include = new Set(match.include ?? []);
  const exclude = new Set(match.exclude ?? []);
  const offices = officesOf(record).slice(0, KEY_OFFICES_MAX).map((o) => officeKeys(resolveOffice(o, geo)));
  if (!offices.some((keys) => keys.some((k) => include.has(k)))) return false;
  if (exclude.size && offices.some((keys) => keys.some((k) => exclude.has(k)))) return false;

  if (match.bands?.length && !inBands(record.summary?.staff, match.bands)) return false;
  const industries = industriesOf(record);
  if (match.industries?.length && !match.industries.some((want) => industries.some((x) => hasWords(x, want)))) return false;
  if (match.exclude_industries?.length && industries.some((x) => match.exclude_industries.includes(x))) return false;
  const type = clean(record.summary?.type).toUpperCase();
  if (type && match.exclude_types?.includes(type)) return false;
  if (match.terms?.length) {
    const fields = [clean(record.summary?.name), ...industries, clean(record.summary?.description)].filter(Boolean);
    if (match.terms.some((t) => fields.some((f) => hasWords(f, t)))) return false;
  }
  return true;
}
