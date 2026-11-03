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
const MAX_REQUESTS = 50; // aiark_runs.requests holds at most 50 bodies (15,000 places)
const MAX_BANDS = 20;

// Where excluded keywords are looked for. A client's terms: the fields the lead
// database checks them against. A cleaning client's: every company field, and
// the two that say what a person does now (a work history often names the
// janitorial vendors a facility manager has run).
const RULE_SOURCES = ["NAME", "INDUSTRY", "DESCRIPTION"];
const CLEANING_COMPANY_SOURCES = ["NAME", "KEYWORD", "SEO", "DESCRIPTION", "INDUSTRY"];
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

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * The AI Ark filter bodies for a client: one per 300 places (AI Ark's limit
 * per list), each with the same people and company filters.
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
  const groups = chunks(uniq, ARRAY_MAX);
  if (groups.length > MAX_REQUESTS) {
    blockers.push(`${uniq.length.toLocaleString("en-US")} places is more than one run can send (${(MAX_REQUESTS * ARRAY_MAX).toLocaleString("en-US")}).`);
  }
  if (groups.length > 1) {
    notes.push(`The ${uniq.length.toLocaleString("en-US")} places go out as ${groups.length} searches of up to ${ARRAY_MAX} (AI Ark's limit per list); counts are added up.`);
  }
  if (uniq.some((s) => s.includes(","))) {
    notes.push(`Places are sent as "City, State". AI Ark's docs don't say how it reads a city with its state, so every person is re-checked against the client's area after the pull.`);
  }
  if (dropped.length) {
    notes.push(`${dropped.length} location ${dropped.length === 1 ? "entry was" : "entries were"} left out: ${dropped.slice(0, 3).map((d) => `${JSON.stringify(d.entry)} (${d.why})`).join("; ")}${dropped.length > 3 ? " …" : ""}`);
  }
  if (placesOut.length > ARRAY_MAX) notes.push(`Only the first ${ARRAY_MAX} of ${placesOut.length} excluded places are sent; all are re-checked after the pull.`);

  const clientTerms = Array.isArray(targeting.exclude_terms) ? targeting.exclude_terms.map(clean).filter(Boolean) : [];
  // The standard list comes first: a list over AI Ark's limit then only cuts
  // terms that are re-checked after the pull.
  const standardTerms = cleaning ? CLEANING_EXCLUDE_KEYWORDS : [];
  const terms = [...new Map([...standardTerms, ...clientTerms].map((t) => [t.toLowerCase(), t])).values()];
  const termsSent = terms.slice(0, ARRAY_MAX);
  if (terms.length > ARRAY_MAX) {
    notes.push(`AI Ark takes ${ARRAY_MAX} exclusion terms per search: the first ${ARRAY_MAX} of ${terms.length} are sent, and all of the client's own are re-checked after the pull.`);
  }
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

  const contactBase = {};
  if (titles.length || excludeTitles.length) {
    // current: all the person's active roles (latest is only the primary one).
    contactBase.experience = {
      current: {
        title: {
          any: {
            ...(titles.length ? { include: { mode, content: titles } } : {}),
            ...(excludeTitles.length ? { exclude: { mode: "WORD", content: excludeTitles } } : {}),
          },
        },
      },
    };
  }
  if (seniority.length) contactBase.seniority = { any: { include: seniority } };
  if (departments.length) contactBase.departmentAndFunction = { any: { include: departments } };
  if (cleaning && termsSent.length) {
    contactBase.keyword = { any: { exclude: { sources: asWords(CLEANING_PEOPLE_SOURCES), content: termsSent } } };
  }

  const account = {};
  if (bands.length) account.employeeSize = { type: "RANGE", range: bands.map((b) => ({ ...b })) };
  if (industries.length || excludeIndustries.length) {
    // Excluded industries are exact catalog values: "real estate" must not also
    // leave out "commercial real estate", which nobody asked to lose.
    account.industries = {
      any: {
        ...(industries.length ? { include: { mode: "WORD", content: industries } } : {}),
        ...(excludeIndustries.length ? { exclude: { mode: "STRICT", content: excludeIndustries } } : {}),
      },
    };
  }
  if (termsSent.length) {
    account.keyword = {
      any: {
        exclude: {
          sources: asWords(cleaning ? CLEANING_COMPANY_SOURCES : RULE_SOURCES),
          content: termsSent,
        },
      },
    };
  }
  if (cleaning) account.type = { any: { exclude: [...CLEANING_EXCLUDE_COMPANY_TYPES] } };

  const requests = blockers.length
    ? []
    : groups.map((g) => ({
        contact: { ...contactBase, location: { any: { include: g, ...(excludePlaces.length ? { exclude: excludePlaces } : {}) } } },
        ...(Object.keys(account).length ? { account } : {}),
      }));

  return {
    requests,
    report: {
      locations: { total: uniq.length, sent: uniq.length, requests: groups.length, examples: uniq.slice(0, 6), dropped },
      excludeLocations: { total: placesOut.length, sent: excludePlaces.length },
      excludeTerms: { total: terms.length, sent: termsSent.length, standard: standardTerms.length },
      peopleKeywords: cleaning ? termsSent.length : 0,
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
