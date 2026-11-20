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
import { cleanCompetitorTerms, COMPETITORS_FALLBACK } from "./competitors.mjs";
import { placeString } from "./geo.mjs";

export { loadGeo } from "./geo.mjs";

export const SENIORITY = ["founder", "owner", "partner", "c_suite", "vp", "director", "head", "manager", "senior", "mid_level", "entry", "intern"];
export const TITLE_MODES = ["SMART", "WORD", "STRICT"];
export const MAX_REQUESTS = 50; // aiark_runs.requests (and aiark_company_runs.requests) holds at most 50 bodies
const MAX_BANDS = 20;

// AI Ark refuses a request as too large at a limit its docs don't state, and the
// bytes sent don't decide it: live on 2026-11-05 it took 9,905 bytes and refused
// 8,502. Places and repeated keyword sources seem to weigh more. So no list goes
// past what it held in a request AI Ark accepted (110 titles, 180 titles left out,
// 40 places, 64 people keywords, 116 company keywords on 3 sources), less a margin
// for the exclusion list ids an export adds. Sizes are the JSON list in bytes.
const TITLES_BYTES = 2_000;
const EXCLUDE_TITLES_BYTES = 2_540;
export const PLACES_BYTES = 950;
export const COMPANY_TERMS_BYTES = 1_900;

/** Said whenever size bands go out, on people and company searches alike. */
export const BANDS_NOTE =
  "AI Ark's company size filter takes ranges only, with no way to ask for companies whose size it doesn't know, so they are probably left out.";

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

export const VALUE_MAX = 120;

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

/** The size of a value as JSON, in bytes: what AI Ark's request limit counts. */
export const bytes = (v) => new TextEncoder().encode(JSON.stringify(v)).length;
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
export function pack(values, capacity) {
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
 * The company part of a search (AI Ark's `account`), shared by people searches
 * (buildRequests) and company searches (buildCompanyRequests in
 * company-filters.mjs), so both send the same company filters: size bands,
 * industries to include (WORD) and leave out (exact catalog values, STRICT),
 * a cleaning client's company types, and the exclusion terms as company
 * keywords. The keys keep the order AI Ark has always been sent: employeeSize,
 * industries, type, keyword.
 *
 * The excluded keywords, once each (case aside), and the order they get room
 * in the search (COMPANY_TERMS_BYTES and AI Ark's 300 values):
 *   1. a cleaning client's standard keywords (cleaning-filters.mjs), always;
 *   2. the built-in competitors list (competitors.mjs, `competitors`: the
 *      database's list, read by the caller; the 069 seed when none is given),
 *      in its own order, each as room allows;
 *   3. the client's own terms, broadest first, until one does not fit.
 * A phrase that covers listed ones (a sheet term "cleaning" covers "cleaning
 * company") takes the place of the first group it covers. The union is checked
 * again after every pull that keeps it (filters.keywords: client_exclusions,
 * and before buying in a one-at-a-time pull), so a term the search can't hold
 * is "checked after the pull", never dropped.
 *
 * `filters` holds employee_bands, industries and exclude_industries (a whole
 * people-filters object is fine; nothing else is read).
 */
export function accountFilters({ targeting, filters, cleaning = false, competitors = undefined }) {
  const p = { ...EMPTY_PEOPLE_FILTERS, ...(filters ?? {}) };
  const clientTerms = Array.isArray(targeting?.exclude_terms) ? targeting.exclude_terms.map(clean).filter(Boolean) : [];
  const standardTerms = cleaning ? CLEANING_EXCLUDE_KEYWORDS : [];
  const listUsed = cleaning ? competitors ?? COMPETITORS_FALLBACK : null;
  const listAll = listUsed ? cleanCompetitorTerms(listUsed.terms) : [];
  const standardKeys = new Set(standardTerms.map((t) => t.toLowerCase()));
  const ownKeys = new Set(clientTerms.map((t) => t.toLowerCase()));
  // The list's terms that are not standard keywords; listAdded: nor the client's own either.
  const listTerms = listAll.filter((t) => !standardKeys.has(t.toLowerCase()));
  const listAdded = listTerms.filter((t) => !ownKeys.has(t.toLowerCase()));
  const terms = [...new Map([...standardTerms, ...listTerms, ...clientTerms].map((t) => [t.toLowerCase(), t])).values()];
  const standardWords = standardTerms.map(wordsOf);
  const listWords = listTerms.map(wordsOf);
  const covers = (t, group) => group.some((w) => holds(wordsOf(t), w));
  const merged = condensePhrases(terms);
  const standardGroup = merged.filter((t) => covers(t, standardWords));
  const listGroup = merged.filter((t) => !covers(t, standardWords) && covers(t, listWords));
  const ownGroup = merged
    .filter((t) => !covers(t, standardWords) && !covers(t, listWords))
    .sort((a, b) => wordsOf(a).length - wordsOf(b).length || a.length - b.length);
  const companyTerms = [...standardGroup];
  const fits = (t) => companyTerms.length < ARRAY_MAX && bytes([...companyTerms, t]) <= COMPANY_TERMS_BYTES;
  for (const t of listGroup) if (fits(t)) companyTerms.push(t);
  for (const t of ownGroup) {
    if (!fits(t)) break;
    companyTerms.push(t);
  }

  const tooLong = [];
  const bands = (Array.isArray(p.employee_bands) ? p.employee_bands : []).slice(0, MAX_BANDS);
  const industries = list(p.industries, { lower: true, tooLong }).slice(0, ARRAY_MAX);
  const excludeIndustries = list(p.exclude_industries, { lower: true, tooLong }).slice(0, ARRAY_MAX);

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
  if (cleaning) account.type = { any: { exclude: [...CLEANING_EXCLUDE_COMPANY_TYPES] } };
  if (companyTerms.length) {
    account.keyword = { any: { exclude: { sources: asWords(COMPANY_SOURCES), content: companyTerms } } };
  }

  const sentWords = companyTerms.map(wordsOf);
  const checkedAfter = terms.filter((t) => !sentWords.some((w) => holds(w, wordsOf(t))));
  const termsCovered = terms.length - checkedAfter.length;
  return {
    account, terms, merged, companyTerms, termsCovered, checkedAfter, standardTerms, clientTerms, list: listUsed, listAll, listTerms, listAdded,
    bands, industries, excludeIndustries, tooLong,
  };
}

/**
 * What a pull keeps of its excluded keywords (filters.keywords), for the
 * checks after the pull: the whole union (standard, the competitors list, the
 * client's own), the phrases AI Ark was sent, the terms no sent phrase covers,
 * and the list it used. Null when no standard keywords went (the search then
 * holds only the client's own terms, which the Outcome re-checks as before).
 *
 * @param {ReturnType<typeof accountFilters>} acct
 */
export function keywordsRecord(acct) {
  if (!acct.list) return null;
  return {
    union: [...acct.terms],
    sent: [...acct.companyTerms],
    checked_after: [...acct.checkedAfter],
    in_search: acct.termsCovered,
    standard: acct.standardTerms.length,
    own: acct.clientTerms.length,
    list: {
      name: acct.list.name,
      from: acct.list.from,
      id: acct.list.id ?? null,
      updated_at: acct.list.updatedAt ?? null,
      terms: acct.listAll.length,
      added: acct.listAdded.length,
    },
  };
}

/** The terms a run keeps for the checks after its pull (filters.keywords.union), lower case; empty when it keeps none. */
export function keywordsOfRun(run) {
  const union = run?.filters?.keywords?.union;
  return Array.isArray(union) ? [...new Set(union.map((s) => clean(s).toLowerCase()).filter(Boolean))] : [];
}

/**
 * The note for a search that can't hold every excluded term, with the
 * competitors list in it: how many it holds, of which kinds, and that the
 * rest are checked after the pull (`after` says how, for people or companies).
 * Starts as the note for a client's own terms does ("AI Ark's limits leave
 * room for"), which the LinkedIn sources replace with their own.
 */
export function listTermsNote(acct, after) {
  const parts = [
    `${fmtN(acct.standardTerms.length)} standard`,
    `${fmtN(acct.listAdded.length)} from the competitors list`,
    `${fmtN(acct.terms.length - acct.standardTerms.length - acct.listAdded.length)} this client's own`,
  ];
  return (
    `AI Ark's limits leave room for ${fmtN(acct.termsCovered)} of the ${fmtN(acct.terms.length)} excluded terms (${parts.join(", ")}) in the search. ` +
    `The other ${fmtN(acct.checkedAfter.length)} are checked after the pull, as whole words, ${after}`
  );
}

const fmtN = (n) => Number(n).toLocaleString("en-US");

/**
 * The AI Ark filter bodies for a client: one per group of titles × group of
 * places, each within what AI Ark is known to take. The exclusions go in every
 * search. A cleaning client's standard filters always go; the built-in
 * competitors list (`competitors`, competitors.mjs) and then its own exclusion
 * terms go as room allows, at company level only (accountFilters). `keywords`
 * is what a pull keeps for the checks after it (keywordsRecord), or null.
 *
 * @returns {{ requests: object[], report: object, notes: string[], blockers: string[], pullBlockers: string[], keywords: object | null }}
 */
export function buildRequests({ targeting, people, geo, cleaning = false, competitors = undefined }) {
  const notes = [];
  const blockers = [];
  const pullBlockers = [];
  const p = { ...EMPTY_PEOPLE_FILTERS, ...(people ?? {}) };

  if (!targeting) {
    blockers.push("This client has no targeting rules yet. Add its locations and exclusions on the Clients page (Rules) or sync the sheet.");
    return { requests: [], report: { locations: { total: 0, sent: 0, requests: 0, examples: [], dropped: [] } }, notes, blockers, pullBlockers, keywords: null };
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

  // The company part (size, industries, company types, keywords) is shared with company searches.
  const acct = accountFilters({ targeting, filters: p, cleaning, competitors });
  const { terms, merged, standardTerms, clientTerms, bands, industries, excludeIndustries, termsCovered } = acct;
  // The people keywords (headline, summary) stay the standard ones: the competitors list is company keywords.
  const peopleTerms = condensePhrases(standardTerms);
  if (acct.list?.note) notes.push(acct.list.note);
  if (clientTerms.length) {
    notes.push(`AI Ark matches excluded words as whole words; the lead database matches them anywhere in the text ("bar" also drops "Barbershop"). That stricter check runs after the pull.`);
  }

  const tooLong = [];
  const titles = list(p.titles, { tooLong }).slice(0, ARRAY_MAX);
  const excludeTitles = list(p.exclude_titles, { tooLong }).slice(0, ARRAY_MAX);
  const seniority = list(p.seniority, { lower: true, tooLong }).filter((s) => SENIORITY.includes(s));
  const departments = list(p.departments, { lower: true, tooLong }).slice(0, ARRAY_MAX);
  if (bands.length) notes.push(BANDS_NOTE);
  tooLong.push(...acct.tooLong);
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
  const accountBase = acct.account;

  const body = (titleGroup, placeGroup) => {
    return {
      contact: {
        // latest: the person's main job. `current` also matches any side role: in the
        // 2026-11-05 live test, 15 of 100 had a main title on no list that way.
        ...(titleGroup.length || excludeTitlesSent.length
          ? {
              experience: {
                latest: {
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

  if (titles.length > titlesSent.length || excludeTitles.length > excludeTitlesSent.length || terms.length > merged.length) {
    notes.push(`Shorter phrases stand in for longer ones ("facility" also finds "facility manager"), which keeps the request small and changes nobody's match.`);
  }
  if (requests.length > 1) {
    notes.push(`AI Ark limits how much one request can hold, so this goes out as ${requests.length} searches (${titleGroups.length} ${titleGroups.length === 1 ? "group" : "groups"} of job titles × ${placeGroups.length} ${placeGroups.length === 1 ? "group" : "groups"} of places), and a count costs 1 credit for each. Counts are added up, so someone matching titles in two groups is counted twice; a pull leaves out people it has already bought.`);
  }
  if (termsCovered < terms.length) {
    notes.push(
      acct.list
        ? listTermsNote(acct, "on each person's company: a one-at-a-time pull skips such a person before buying their email; an export job's people are paid for when it returns them, and then excluded.")
        : `AI Ark's limits leave room for ${termsCovered} of this client's ${terms.length} exclusion terms in the search. The others are checked after the pull, when the person is already paid for.`
    );
  }

  return {
    requests,
    report: {
      locations: { total: uniq.length, sent: uniq.length, requests: requests.length, examples: uniq.slice(0, 6), dropped },
      excludeLocations: { total: placesOut.length, sent: excludePlaces.length },
      excludeTerms: {
        total: terms.length, sent: termsCovered, standard: standardTerms.length,
        ...(acct.list ? { list: acct.listAdded.length, checkedAfter: acct.checkedAfter.length } : {}),
      },
      ...(acct.list ? { competitors: { name: acct.list.name, from: acct.list.from, terms: acct.listAll.length, added: acct.listAdded.length } } : {}),
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
    keywords: keywordsRecord(acct),
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
