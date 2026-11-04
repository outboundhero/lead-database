// What AI Ark is asked for a client: the client's rules (client_targeting —
// locations and exclusion terms, synced from the sheets) plus its people
// filters (client_people_filters — titles, seniority, departments, company
// size), turned into People Search filter bodies in the shapes AI Ark documents
// (docs.ai-ark.com, checked 2026-10-30). The one thing it does not document is
// a city with its state, so places go out as "City, State" on trust and every
// person is re-checked after the pull. A cleaning client's search starts from
// the standard filters in cleaning-filters.mjs, and its rules add to them.
//
// Nothing is dropped silently: a value that can't be used is refused when the
// filters are saved, every list that has to be cut says so in the report, and
// anything that blocks a count or a pull is a blocker.
//
// Plain JavaScript: the AI Ark tab's routes and the worker share it.

import { ARRAY_MAX } from "./client.mjs";
import {
  CLEANING_EMPLOYEE_BANDS,
  CLEANING_EXCLUDE_COMPANY_TYPES,
  CLEANING_EXCLUDE_INDUSTRIES,
  CLEANING_EXCLUDE_KEYWORDS,
  CLEANING_EXCLUDE_TITLES,
  CLEANING_TITLES,
} from "./cleaning-filters.mjs";
import { placeString } from "./geo.mjs";

export { loadGeo } from "./geo.mjs";

export const SENIORITY = ["founder", "owner", "partner", "c_suite", "vp", "director", "head", "manager", "senior", "mid_level", "entry", "intern"];
export const TITLE_MODES = ["SMART", "WORD", "STRICT"];
const MAX_REQUESTS = 50; // aiark_runs.requests holds at most 50 bodies
const MAX_BANDS = 20;

// AI Ark refuses a request as too large at a limit its docs don't state, and the
// bytes sent don't decide it: live on 2026-11-05 it took 9,905 bytes and refused
// 8,502. Places and repeated keyword sources seem to weigh more. So no list goes
// past what it held in a request AI Ark accepted (110 titles, 180 titles left out,
// 40 places, 64 people keywords, 116 company keywords on 3 sources), less a margin
// for the exclusion list ids an export adds. Sizes are the JSON list in bytes.
const TITLES_BYTES = 2_000;
const EXCLUDE_TITLES_BYTES = 2_540;
const PLACES_BYTES = 950;
const COMPANY_TERMS_BYTES = 1_900;

// Where excluded keywords are looked for. For companies: the fields the lead
// database checks a client's terms against (AI Ark refused the same request with
// all five of its sources). For people: the two that say what a person does now
// (a work history often names the janitorial vendors a facility manager has run).
const COMPANY_SOURCES = ["NAME", "INDUSTRY", "DESCRIPTION"];
const CLEANING_PEOPLE_SOURCES = ["HEADLINE", "SUMMARY"];
const asWords = (sources) => sources.map((source) => ({ mode: "WORD", source }));

/** Department-and-function values seen in AI Ark's catalog that suit facility buyers (checked 2026-10-30). */
export const DEPARTMENT_SUGGESTIONS = [
  "facility_administration", "office_management", "operations", "business_operations", "general_management",
  "executive_leadership_and_general_management", "real_estate_operations", "workplace_real_estate",
  "building_and_grounds_services", "purchasing", "property_management", "facilities_management", "healthcare_operations",
];

/** AI Ark industry values (its catalog spelling) near what cleaning clients sell to. */
export const INDUSTRY_SUGGESTIONS = [
  "facilities services", "property management", "commercial real estate", "hospitals and health care",
  "medical practices", "real estate", "leasing non-residential real estate", "education", "insurance",
];

/**
 * A cleaning client's people filters until someone saves its own: what the tab
 * shows and what a count or a pull uses (cleaning-filters.mjs).
 */
export const CLEANING_DEFAULTS = {
  titles: CLEANING_TITLES,
  title_mode: "WORD",
  exclude_titles: CLEANING_EXCLUDE_TITLES,
  seniority: [],
  departments: [],
  employee_bands: CLEANING_EMPLOYEE_BANDS,
  industries: [],
  exclude_industries: CLEANING_EXCLUDE_INDUSTRIES,
};

export const EMPTY_PEOPLE_FILTERS = {
  titles: [], title_mode: "SMART", exclude_titles: [], seniority: [], departments: [], employee_bands: [], industries: [], exclude_industries: [],
};

const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

const VALUE_MAX = 120;

/** Trimmed, de-duplicated values. One over VALUE_MAX goes into `tooLong`, for the caller to report. */
function list(v, { lower = false, tooLong = [] } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(v) ? v : []) {
    let s = clean(raw);
    if (lower) s = s.toLowerCase();
    if (!s) continue;
    if (s.length > VALUE_MAX) {
      tooLong.push(s);
      continue;
    }
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Checks people filters as typed on the tab. Returns { value, errors }:
 * value is what gets saved; errors say what was refused and why.
 */
export function cleanPeopleFilters(input) {
  const errors = [];
  const f = input && typeof input === "object" ? input : {};
  const tooLong = [];
  const titles = list(f.titles, { tooLong });
  const exclude_titles = list(f.exclude_titles, { tooLong });
  const title_mode = TITLE_MODES.includes(String(f.title_mode ?? "").toUpperCase()) ? String(f.title_mode).toUpperCase() : "SMART";
  const seniority = list(f.seniority, { lower: true, tooLong });
  const badSeniority = seniority.filter((s) => !SENIORITY.includes(s));
  if (badSeniority.length) errors.push(`Unknown seniority: ${badSeniority.join(", ")} (AI Ark has ${SENIORITY.join(", ")})`);
  const departments = list(f.departments, { lower: true, tooLong });
  const badDept = departments.filter((d) => !/^[a-z][a-z0-9_]*$/.test(d));
  if (badDept.length) errors.push(`Departments are AI Ark catalog values written like facility_administration: ${badDept.join(", ")}`);
  const industries = list(f.industries, { lower: true, tooLong });
  const exclude_industries = list(f.exclude_industries, { lower: true, tooLong });
  if (tooLong.length) errors.push(`Over ${VALUE_MAX} characters: ${tooLong.map((s) => `"${s.slice(0, 40)}…"`).join(", ")}`);

  const employee_bands = [];
  for (const b of Array.isArray(f.employee_bands) ? f.employee_bands : []) {
    const start = b?.start === "" || b?.start == null ? null : Number(b.start);
    const end = b?.end === "" || b?.end == null ? null : Number(b.end);
    const okNum = (n) => n === null || (Number.isInteger(n) && n >= 1 && n <= 10_000_000);
    if (!okNum(start) || !okNum(end) || (start === null && end === null) || (start !== null && end !== null && start > end)) {
      errors.push(`Company size band ${JSON.stringify(b)} is not a range of whole numbers`);
      continue;
    }
    employee_bands.push({ ...(start !== null ? { start } : {}), ...(end !== null ? { end } : {}) });
  }
  if (employee_bands.length > MAX_BANDS) errors.push(`At most ${MAX_BANDS} company size bands`);

  for (const [name, arr] of [["Job titles", titles], ["Excluded titles", exclude_titles], ["Departments", departments], ["Industries", industries], ["Excluded industries", exclude_industries]]) {
    if (arr.length > ARRAY_MAX) errors.push(`${name}: AI Ark takes at most ${ARRAY_MAX} values (${arr.length} given)`);
  }
  return {
    value: { titles, title_mode, exclude_titles, seniority: seniority.filter((s) => SENIORITY.includes(s)), departments, employee_bands, industries, exclude_industries },
    errors,
  };
}

const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
const wordsOf = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Does `outer` hold the words of `inner`, in order and side by side? */
function holds(inner, outer) {
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

/**
 * The phrases worth sending, in their order. A WORD match finds a phrase with
 * extra words around it, so a phrase holding a shorter listed one adds nothing
 * ("facility manager" beside "facility"), and leaving it out changes nobody's match.
 */
export function condensePhrases(phrases) {
  const items = phrases.map((s, i) => ({ s, i, w: wordsOf(s) })).filter((x) => x.w.length);
  const kept = [];
  for (const x of [...items].sort((a, b) => a.w.length - b.w.length || a.i - b.i)) {
    if (!kept.some((k) => holds(k.w, x.w))) kept.push(x);
  }
  return kept.sort((a, b) => a.i - b.i).map((x) => x.s);
}

/** Values split into lists of at most `capacity` bytes and AI Ark's 300 values. */
function pack(values, capacity) {
  const groups = [];
  let group = [];
  let used = 2;
  for (const v of values) {
    const n = bytes(v) + 1;
    if (group.length && (used + n > capacity || group.length >= ARRAY_MAX)) {
      groups.push(group);
      group = [];
      used = 2;
    }
    group.push(v);
    used += n;
  }
  groups.push(group);
  return groups;
}

/**
 * The AI Ark filter bodies for a client: one per group of titles × group of
 * places, each within what AI Ark is known to take. The exclusions go in every
 * search. A cleaning client's standard filters always go; its own exclusion
 * terms go as room allows, broadest first, at company level only.
 *
 * @returns {{ requests: object[], report: object, notes: string[], blockers: string[], pullBlockers: string[] }}
 */
export function buildRequests({ targeting, people, geo, cleaning = false }) {
  const notes = [];
  const blockers = [];
  const pullBlockers = [];
  const p = { ...EMPTY_PEOPLE_FILTERS, ...(people ?? {}) };

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
  if (uniq.some((s) => s.includes(","))) {
    notes.push(`Places are sent as "City, State". AI Ark's docs don't say how it reads a city with its state, so every person is re-checked against the client's area after the pull.`);
  }
  if (dropped.length) {
    notes.push(`${dropped.length} location ${dropped.length === 1 ? "entry was" : "entries were"} left out: ${dropped.slice(0, 3).map((d) => `${JSON.stringify(d.entry)} (${d.why})`).join("; ")}${dropped.length > 3 ? " …" : ""}`);
  }
  if (placesOut.length > ARRAY_MAX) notes.push(`Only the first ${ARRAY_MAX} of ${placesOut.length} excluded places are sent; all are re-checked after the pull.`);

  const clientTerms = Array.isArray(targeting.exclude_terms) ? targeting.exclude_terms.map(clean).filter(Boolean) : [];
  const standardTerms = cleaning ? CLEANING_EXCLUDE_KEYWORDS : [];
  const terms = [...new Map([...standardTerms, ...clientTerms].map((t) => [t.toLowerCase(), t])).values()];
  // What stands for a standard keyword (itself, or a sheet term that covers it)
  // goes first and stays, so only terms re-checked after the pull can be cut.
  const standardWords = standardTerms.map(wordsOf);
  const merged = condensePhrases(terms);
  const staysTerms = merged.filter((t) => standardWords.some((w) => holds(wordsOf(t), w)));
  const ownTerms = merged
    .filter((t) => !standardWords.some((w) => holds(wordsOf(t), w)))
    .sort((a, b) => wordsOf(a).length - wordsOf(b).length || a.length - b.length);
  const companyTerms = [...staysTerms];
  for (const t of ownTerms) {
    if (companyTerms.length >= ARRAY_MAX || bytes([...companyTerms, t]) > COMPANY_TERMS_BYTES) break;
    companyTerms.push(t);
  }
  const peopleTerms = condensePhrases(standardTerms);
  if (clientTerms.length) {
    notes.push(`AI Ark matches excluded words as whole words; the lead database matches them anywhere in the text ("bar" also drops "Barbershop"). That stricter check runs after the pull.`);
  }

  const tooLong = [];
  const titles = list(p.titles, { tooLong }).slice(0, ARRAY_MAX);
  const excludeTitles = list(p.exclude_titles, { tooLong }).slice(0, ARRAY_MAX);
  const seniority = list(p.seniority, { lower: true, tooLong }).filter((s) => SENIORITY.includes(s));
  const departments = list(p.departments, { lower: true, tooLong }).slice(0, ARRAY_MAX);
  const bands = (Array.isArray(p.employee_bands) ? p.employee_bands : []).slice(0, MAX_BANDS);
  if (bands.length) notes.push("AI Ark's company size filter takes ranges only, with no way to ask for companies whose size it doesn't know, so they are probably left out.");
  const industries = list(p.industries, { lower: true, tooLong }).slice(0, ARRAY_MAX);
  const excludeIndustries = list(p.exclude_industries, { lower: true, tooLong }).slice(0, ARRAY_MAX);
  if (tooLong.length) notes.push(`${tooLong.length} filter ${tooLong.length === 1 ? "value is" : "values are"} over ${VALUE_MAX} characters and left out.`);
  const mode = TITLE_MODES.includes(p.title_mode) ? p.title_mode : "SMART";

  if (!titles.length && !seniority.length && !departments.length) {
    pullBlockers.push("Choose job titles, seniority or departments first — without them AI Ark returns everyone at the matching companies.");
  }

  const titlesSent = mode === "WORD" ? condensePhrases(titles) : titles;
  const excludeTitlesSent = condensePhrases(excludeTitles);

  const contactBase = {};
  if (seniority.length) contactBase.seniority = { any: { include: seniority } };
  if (departments.length) contactBase.departmentAndFunction = { any: { include: departments } };
  if (peopleTerms.length) {
    contactBase.keyword = { any: { exclude: { sources: asWords(CLEANING_PEOPLE_SOURCES), content: peopleTerms } } };
  }
  const accountBase = {};
  if (bands.length) accountBase.employeeSize = { type: "RANGE", range: bands.map((b) => ({ ...b })) };
  if (industries.length || excludeIndustries.length) {
    // Excluded industries are exact catalog values: "real estate" must not also
    // leave out "commercial real estate", which nobody asked to lose.
    accountBase.industries = {
      any: {
        ...(industries.length ? { include: { mode: "WORD", content: industries } } : {}),
        ...(excludeIndustries.length ? { exclude: { mode: "STRICT", content: excludeIndustries } } : {}),
      },
    };
  }
  if (cleaning) accountBase.type = { any: { exclude: [...CLEANING_EXCLUDE_COMPANY_TYPES] } };

  if (companyTerms.length) {
    accountBase.keyword = { any: { exclude: { sources: asWords(COMPANY_SOURCES), content: companyTerms } } };
  }

  const body = (titleGroup, placeGroup) => {
    return {
      contact: {
        // current: all the person's active roles (latest is only the primary one).
        ...(titleGroup.length || excludeTitlesSent.length
          ? {
              experience: {
                current: {
                  title: {
                    any: {
                      ...(titleGroup.length ? { include: { mode, content: titleGroup } } : {}),
                      ...(excludeTitlesSent.length ? { exclude: { mode: "WORD", content: excludeTitlesSent } } : {}),
                    },
                  },
                },
              },
            }
          : {}),
        ...contactBase,
        location: { any: { include: placeGroup, ...(excludePlaces.length ? { exclude: excludePlaces } : {}) } },
      },
      ...(Object.keys(accountBase).length ? { account: accountBase } : {}),
    };
  };

  const titleGroups = pack(titlesSent, TITLES_BYTES);
  const placeGroups = pack(uniq, PLACES_BYTES);
  const searches = titleGroups.length * placeGroups.length;
  if (bytes(excludeTitlesSent) > EXCLUDE_TITLES_BYTES) {
    blockers.push(`The titles to leave out are too long for an AI Ark search. Shorten the list by about ${(bytes(excludeTitlesSent) - EXCLUDE_TITLES_BYTES).toLocaleString("en-US")} characters.`);
  }
  if (searches > MAX_REQUESTS) {
    blockers.push(`These job titles and ${uniq.length.toLocaleString("en-US")} places would take ${searches} searches, more than one run can send (${MAX_REQUESTS}). Shorten the job titles or the locations.`);
  }

  const requests = blockers.length ? [] : titleGroups.flatMap((t) => placeGroups.map((g) => body(t, g)));
  const sentWords = companyTerms.map(wordsOf);
  const termsCovered = terms.filter((t) => sentWords.some((w) => holds(w, wordsOf(t)))).length;

  if (titles.length > titlesSent.length || excludeTitles.length > excludeTitlesSent.length || terms.length > merged.length) {
    notes.push(`Shorter phrases stand in for longer ones ("facility" also finds "facility manager"), which keeps the request small and changes nobody's match.`);
  }
  if (requests.length > 1) {
    notes.push(`AI Ark limits how much one request can hold, so this goes out as ${requests.length} searches (${titleGroups.length} ${titleGroups.length === 1 ? "group" : "groups"} of job titles × ${placeGroups.length} ${placeGroups.length === 1 ? "group" : "groups"} of places), and a count costs 1 credit for each. Counts are added up, so someone matching titles in two groups is counted twice; a pull leaves out people it has already bought.`);
  }
  if (termsCovered < terms.length) {
    notes.push(`AI Ark's limits leave room for ${termsCovered} of this client's ${terms.length} exclusion terms in the search. The others are checked after the pull, when the person is already paid for.`);
  }

  return {
    requests,
    report: {
      locations: { total: uniq.length, sent: uniq.length, requests: requests.length, examples: uniq.slice(0, 6), dropped },
      excludeLocations: { total: placesOut.length, sent: excludePlaces.length },
      excludeTerms: { total: terms.length, sent: termsCovered, standard: standardTerms.length },
      peopleKeywords: standardTerms.length,
      excludeCompanyTypes: cleaning ? [...CLEANING_EXCLUDE_COMPANY_TYPES] : [],
      titles: titles.length,
      titleMode: mode,
      excludeTitles: excludeTitles.length,
      seniority,
      departments,
      bands,
      industries: industries.length,
      excludeIndustries: excludeIndustries.length,
      commercialCleaning: Boolean(targeting.commercial_cleaning),
    },
    notes,
    blockers,
    pullBlockers,
  };
}

/** Rough credit cost of a pull, for the tab. emailRate: the share of people with a valid email (assumed). */
export function estimateCredits({ strategy, size, requests = 1, emailRate = 0.6 }) {
  const n = Math.max(0, Math.floor(size));
  if (strategy === "export") {
    return { low: n * 0.5, expected: Math.round(n * (0.5 + 0.5 * emailRate)), high: n };
  }
  const pages = Math.ceil(n / 100) + Math.max(0, requests - 1);
  return { low: pages, expected: pages + Math.round(n * emailRate), high: pages + n };
}
