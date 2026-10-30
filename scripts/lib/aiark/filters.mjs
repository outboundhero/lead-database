// What AI Ark is asked for a client: the client's rules (client_targeting —
// locations and exclusion terms, synced from the sheets) plus its people
// filters (client_people_filters — titles, seniority, departments, company
// size), turned into People Search filter bodies exactly as AI Ark documents
// them (docs.ai-ark.com, checked 2026-10-30).
//
// Nothing is dropped silently: every list that has to be cut says so in the
// report, and anything that blocks a count or a pull is a blocker.
//
// Plain JavaScript: the AI Ark tab's routes and the worker share it.

import { ARRAY_MAX } from "./client.mjs";
import { placeString } from "./geo.mjs";

export { loadGeo } from "./geo.mjs";

export const SENIORITY = ["founder", "owner", "partner", "c_suite", "vp", "director", "head", "manager", "senior", "mid_level", "entry", "intern"];
export const TITLE_MODES = ["SMART", "WORD", "STRICT"];
const MAX_REQUESTS = 50; // aiark_runs.requests holds at most 50 bodies (15,000 places)
const MAX_BANDS = 20;

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
 * A starting point for cleaning clients: the three role tracks used in Clay
 * (CEO / owner, operations, facility / office manager) and the titles its
 * agents were told to skip. Shown, not saved, until someone saves it.
 */
export const CLEANING_DEFAULTS = {
  titles: [
    "Owner", "Founder", "CEO", "Chief Executive Officer", "Company Owner", "Franchise Owner",
    "Chief Operating Officer", "Vice President of Operations", "Vice President of Facilities", "Facilities Director",
    "Head of Facilities", "Head of Facilities and Operations", "Facilities Manager", "Facility Manager",
    "Office Manager", "Workplace Manager", "Office Administrator", "Office Coordinator", "Operations Manager",
  ],
  title_mode: "WORD",
  exclude_titles: [
    "attorney", "legal", "lawyer", "human resources", "intern", "freelance", "recruiter", "talent",
    "sales", "business development", "accountant", "account manager", "account executive",
  ],
  seniority: [],
  departments: [],
  employee_bands: [],
  industries: [],
  exclude_industries: [],
};

export const EMPTY_PEOPLE_FILTERS = {
  titles: [], title_mode: "SMART", exclude_titles: [], seniority: [], departments: [], employee_bands: [], industries: [], exclude_industries: [],
};

const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

function list(v, { lower = false, max = 120 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(v) ? v : []) {
    let s = clean(raw);
    if (lower) s = s.toLowerCase();
    if (!s || s.length > max) continue;
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
  const titles = list(f.titles);
  const exclude_titles = list(f.exclude_titles);
  const title_mode = TITLE_MODES.includes(String(f.title_mode ?? "").toUpperCase()) ? String(f.title_mode).toUpperCase() : "SMART";
  const seniority = list(f.seniority, { lower: true });
  const badSeniority = seniority.filter((s) => !SENIORITY.includes(s));
  if (badSeniority.length) errors.push(`Unknown seniority: ${badSeniority.join(", ")} (AI Ark has ${SENIORITY.join(", ")})`);
  const departments = list(f.departments, { lower: true });
  const badDept = departments.filter((d) => !/^[a-z][a-z0-9_]*$/.test(d));
  if (badDept.length) errors.push(`Departments are AI Ark catalog values written like facility_administration: ${badDept.join(", ")}`);
  const industries = list(f.industries, { lower: true });
  const exclude_industries = list(f.exclude_industries, { lower: true });

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
export function buildRequests({ targeting, people, geo }) {
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

  const terms = Array.isArray(targeting.exclude_terms) ? targeting.exclude_terms.map(clean).filter(Boolean) : [];
  const termsSent = terms.slice(0, ARRAY_MAX);
  if (terms.length > ARRAY_MAX) {
    notes.push(`AI Ark takes ${ARRAY_MAX} exclusion terms per search: the first ${ARRAY_MAX} of ${terms.length} are sent, and all ${terms.length} are re-checked after the pull.`);
  }
  if (termsSent.length) {
    notes.push(`AI Ark matches excluded words as whole words; the lead database matches them anywhere in the text ("bar" also drops "Barbershop"). That stricter check runs after the pull.`);
  }

  const titles = list(p.titles).slice(0, ARRAY_MAX);
  const excludeTitles = list(p.exclude_titles).slice(0, ARRAY_MAX);
  const seniority = list(p.seniority, { lower: true }).filter((s) => SENIORITY.includes(s));
  const departments = list(p.departments, { lower: true }).slice(0, ARRAY_MAX);
  const bands = (Array.isArray(p.employee_bands) ? p.employee_bands : []).slice(0, MAX_BANDS);
  const industries = list(p.industries, { lower: true }).slice(0, ARRAY_MAX);
  const excludeIndustries = list(p.exclude_industries, { lower: true }).slice(0, ARRAY_MAX);
  const mode = TITLE_MODES.includes(p.title_mode) ? p.title_mode : "SMART";

  if (!titles.length && !seniority.length && !departments.length) {
    pullBlockers.push("Choose job titles, seniority or departments first — without them AI Ark returns everyone at the matching companies.");
  }

  const contactBase = {};
  if (titles.length || excludeTitles.length) {
    contactBase.experience = {
      latest: {
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

  const account = {};
  if (bands.length) account.employeeSize = { type: "RANGE", range: bands.map((b) => ({ ...b })) };
  if (industries.length || excludeIndustries.length) {
    account.industries = {
      any: {
        ...(industries.length ? { include: { mode: "WORD", content: industries } } : {}),
        ...(excludeIndustries.length ? { exclude: { mode: "WORD", content: excludeIndustries } } : {}),
      },
    };
  }
  if (termsSent.length) {
    account.keyword = {
      any: {
        exclude: {
          sources: [{ mode: "WORD", source: "NAME" }, { mode: "WORD", source: "INDUSTRY" }, { mode: "WORD", source: "DESCRIPTION" }],
          content: termsSent,
        },
      },
    };
  }

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
      excludeTerms: { total: terms.length, sent: termsSent.length },
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
