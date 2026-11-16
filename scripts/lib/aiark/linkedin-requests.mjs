// What AI Ark is asked for a client's LinkedIn searches (design 2C, D-P4-1 to
// D-P4-3): the same request builders as the AI Ark tab and the Companies tab
// (buildRequests, buildCompanyRequests), fed what the resolver gives
// (linkedin-settings.mjs) instead of the client's database rules:
//
//   places          the client's own LinkedIn places for the kind, or for a
//                   client with no row its rules' places read live, narrowed
//                   to the client's sending rules (narrowPlaces, override O2):
//                   nothing outside the area the send gate allows is searched;
//                   people searches filter on the person's place, company
//                   searches on any office (head offices are judged after the pull)
//   excluded words  the standard keywords, then the client's own for the kind,
//                   on the company's name, industry and description, as far as
//                   AI Ark's limit allows; every keyword of the union, sent or
//                   not, is checked after the pull (override O1): the rest are
//                   "checked after the pull (AI Ark limit)". The client's sheet
//                   exclusion terms are not sent here: they are checked after
//                   the pull too, as for every row
//   filters         the standard ones (titles, excluded titles, sizes,
//                   excluded industries, company types) for every client, or
//                   its saved AI Ark people filters; cleaning always on
//
// Excluded places go in every search with no way to split them, so a list
// over what one search may hold is a blocker, never cut.
//
// Registers the "linkedin" people source (by area).
//
// Plain JavaScript: the routes, the worker and the tests share it.

import { ARRAY_MAX } from "./client.mjs";
import { buildRequests, bytes, PLACES_BYTES } from "./filters.mjs";
import { buildCompanyRequests, pickCompanyFilters } from "./company-filters.mjs";
import { placeString } from "./geo.mjs";
import { CHECKED_AFTER, NOT_SEARCHED_FIX } from "./linkedin-settings.mjs";
import { registerPeopleSource } from "./people-requests.mjs";

/** Excluded places go in every search: at most this many bytes of them (an include group's budget). */
export const EXCLUDE_PLACES_BYTES = PLACES_BYTES;

/** What the LinkedIn sources are called wherever they are written or shown. */
export const LINKEDIN_LABELS = Object.freeze({
  source: "LinkedIn",
  companyPull: "LinkedIn company pull (AI Ark)", // enrich_sources.label of the rows a LinkedIn pull bought
  peopleRun: "LinkedIn people run (AI Ark)", // enrich_sources.label of the People rows a LinkedIn run bought
  companyRows: "LinkedIn companies (AI Ark)", // the company row's source input, a LinkedIn pull's rows (design 2C.1)
  personCompanies: "LinkedIn people (AI Ark)", // the source of a LinkedIn person's company brought in (design 2C.2)
  projection: "LinkedIn (AI Ark)", // enrich_companies.source of a LinkedIn row
});

// The AI Ark tab's notes that say something untrue of a LinkedIn search: the
// offices note (a LinkedIn pull keeps head offices), the whole-word and limit
// notes (replaced by LinkedIn's own), and the rules blocker.
const DROPPED_NOTES = ["AI Ark finds a company when any of its offices", "AI Ark matches excluded words as whole words", "AI Ark's limits leave room for"];
const RULES_BLOCKER = "The client's rules have no locations";

const fmt = (n) => Number(n).toLocaleString("en-US");

/**
 * The made-up rules a LinkedIn search is built from: the places the resolver
 * searches (the client's own, narrowed to its sending rules) and the client's
 * own keywords in client_targeting's shape. Pass the same object to
 * createCompanyRun (as `targeting`), so the free registry copy matches the
 * places AI Ark is asked for.
 *
 * @param {import("./linkedin-settings.mjs").EffectiveLinkedin} effective
 * @returns {{ include_locations: object[], exclude_locations: object[], exclude_terms: string[], commercial_cleaning: false }}
 */
export function linkedinTargeting(effective) {
  const search = searchOf(effective);
  return {
    include_locations: search.include,
    exclude_locations: search.exclude,
    exclude_terms: effective.own.exclude_keywords,
    commercial_cleaning: false,
  };
}

/** The places searched (the resolver's narrowing); an effective view from before override O2 searches its own lists. */
function searchOf(effective) {
  return effective.search ?? { include: effective.own.include_locations, exclude: effective.own.exclude_locations, notSearched: [], replaced: [], narrowed: false, rulePlaces: 0 };
}

/** The keywords AI Ark's request could not take (override O1's name, or the Day 0 one). */
const checkedAfterOf = (k) => k.checkedAfter ?? k.notApplied ?? [];

/** The excluded places as AI Ark is sent them, and a blocker when they can't go in one search. */
function excludedPlaces(effective, geo) {
  const sent = [...new Set(searchOf(effective).exclude.map((e) => placeString(e, geo).value).filter(Boolean))];
  const blockers = [];
  if (sent.length > ARRAY_MAX || bytes(sent) > EXCLUDE_PLACES_BYTES) {
    blockers.push(
      `This client's ${fmt(sent.length)} LinkedIn places to leave out are more than one AI Ark search can hold (${fmt(EXCLUDE_PLACES_BYTES)} bytes, ${ARRAY_MAX} places), and they go in every search. Shorten them on the AI Ark tab.`
    );
  }
  return { sent, blockers };
}

/** What both kinds add to the builder's answer: LinkedIn's own notes, blockers and report. */
function linkedinParts(effective, built, kind, geo) {
  const ex = excludedPlaces(effective, geo);
  const search = searchOf(effective);
  const where = effective.from === "row" ? `${effective.tag}'s LinkedIn ${kind} settings` : `${effective.tag}'s database rules (it has no LinkedIn ${kind} settings of its own)`;
  // Places the sending rules left out entirely: the resolver's blocker says so; the builder's "no places" would mislead.
  const narrowedAway = effective.own.include_locations.length > 0 && search.include.length === 0;
  const blockers = [
    ...effective.blockers,
    ...built.blockers
      .filter((b) => !(narrowedAway && b.startsWith(RULES_BLOCKER)))
      .map((b) => (b.startsWith(RULES_BLOCKER) ? `${where} hold no places, so AI Ark would search everywhere. Add places on the AI Ark tab (LinkedIn settings).` : b)),
    ...ex.blockers,
  ];
  const notes = built.notes.filter((n) => !DROPPED_NOTES.some((d) => n.startsWith(d)));
  const k = effective.keywords;
  const after = checkedAfterOf(k);
  const where2 = kind === "people" ? "on each person's company at the Look, and on the company's full record after a Buy" : "on each company's name, industry and description";
  if (after.length) {
    notes.push(
      `${fmt(after.length)} of the ${fmt(k.union.length)} excluded keywords are ${CHECKED_AFTER}: AI Ark's request has room for the standard ${fmt(k.standard.length)} and ${fmt(k.union.length - k.standard.length - after.length)} of this client's own. Every keyword is checked after the pull ${where2}, and a match is Excluded before anything more is spent on it.`
    );
  }
  notes.push(
    `AI Ark matches the excluded keywords it is sent as whole words in a company's name, industry and description. After the pull all ${fmt(k.union.length)} are checked again ${where2}, anywhere in the name and industry and as whole words in the description, as the client's sheet exclusion terms are.`
  );
  if (search.notSearched.length) {
    notes.push(`${fmt(search.notSearched.length)} of this client's LinkedIn places are ${search.notSearched.every((x) => x.why === search.notSearched[0].why) ? search.notSearched[0].why : "not searched: outside the client's sending rules"}. ${NOT_SEARCHED_FIX}`);
  }
  if (search.replaced.length) {
    const by = search.replaced.reduce((n, r) => n + r.by.length, 0);
    notes.push(`${fmt(search.replaced.length)} state or country ${search.replaced.length === 1 ? "place is" : "places are"} searched only where the client's sending rules reach inside ${search.replaced.length === 1 ? "it" : "them"} (${fmt(by)} ${by === 1 ? "place" : "places"} of the rules). ${NOT_SEARCHED_FIX}`);
  }
  if (kind === "companies") {
    notes.push("AI Ark finds a company when any of its offices is in one of these places. A LinkedIn pull keeps only companies whose head office is in the client's area: the others are paid for and marked Outside (head office).");
  }
  const report = {
    ...built.report,
    linkedin: {
      kind,
      from: effective.from,
      version: effective.version,
      filtersFrom: effective.filters.from,
      places: {
        include: effective.own.include_locations.length, sent: search.include.length, exclude: effective.own.exclude_locations.length,
        unplaced: effective.own.unplaced.length, outsideRules: effective.outsideRules.length, notSearched: search.notSearched.length,
        replaced: search.replaced.length, narrowed: search.narrowed,
      },
      notSearched: search.notSearched,
      replaced: search.replaced,
      excludePlacesSent: ex.sent.length,
      keywords: { standard: k.standard.length, own: k.own.length, union: k.union.length, sent: k.sent.length, checkedAfter: after, notApplied: after },
    },
  };
  return { requests: blockers.length ? [] : built.requests, report, notes, blockers, pullBlockers: built.pullBlockers };
}

/**
 * The Company Search bodies of a client's LinkedIn company pull: one per
 * group of places, as buildCompanyRequests makes them, with the resolver's
 * places, keywords and company filters, and cleaning on.
 *
 * @param {{ effective: import("./linkedin-settings.mjs").EffectiveLinkedin, geo: object }} opts  effective.kind "companies"
 * @returns {{ requests: object[], report: object, notes: string[], blockers: string[], pullBlockers: string[], targeting: ReturnType<typeof linkedinTargeting> }}
 */
export function linkedinCompanyRequests({ effective, geo }) {
  if (effective?.kind !== "companies") throw new Error("linkedinCompanyRequests needs the resolver's companies settings");
  const targeting = linkedinTargeting(effective);
  const built = buildCompanyRequests({ targeting, filters: pickCompanyFilters(effective.filters.value), geo, cleaning: true });
  return { ...linkedinParts(effective, built, "companies", geo), targeting };
}

/**
 * The People Preview bodies of a client's LinkedIn people search: one per
 * group of titles x group of places, as buildRequests makes them, with the
 * resolver's places (the person's own place), keywords and people filters,
 * and cleaning on. A Look pages through each body.
 *
 * @param {{ effective: import("./linkedin-settings.mjs").EffectiveLinkedin, geo: object }} opts  effective.kind "people"
 * @returns {{ requests: object[], report: object, notes: string[], blockers: string[], pullBlockers: string[], targeting: ReturnType<typeof linkedinTargeting> }}
 */
export function linkedinPeopleRequests({ effective, geo }) {
  if (effective?.kind !== "people") throw new Error("linkedinPeopleRequests needs the resolver's people settings");
  const targeting = linkedinTargeting(effective);
  const built = buildRequests({ targeting, people: effective.filters.value, geo, cleaning: true });
  return { ...linkedinParts(effective, built, "people", geo), targeting };
}

/**
 * What a LinkedIn pull or run keeps of its settings in its own `filters`
 * (filters.linkedin), so the run shows what it was asked whatever is edited
 * later: the places searched (narrowed to the sending rules) and those not
 * searched with why (override O2), the keywords sent and those checked after
 * the pull, and the whole union the after-pull check reads (override O1).
 *
 * @param {import("./linkedin-settings.mjs").EffectiveLinkedin} effective
 */
export function linkedinRunFilters(effective) {
  const row = effective.row;
  const search = searchOf(effective);
  return {
    kind: effective.kind,
    from: effective.from,
    version: effective.version,
    filters_from: effective.filters.from,
    places: search.include,
    places_not_searched: search.notSearched,
    places_replaced: search.replaced,
    exclude_places: search.exclude,
    outside_rules: effective.outsideRules,
    keywords: { own: effective.keywords.own, union: effective.keywords.union, sent: effective.keywords.sent, checked_after: checkedAfterOf(effective.keywords) },
    starter_version: effective.from === "rules_and_starter" ? effective.starter.version : null,
    provenance: row
      ? { source: row.source, copied_from: row.copied_from, clay_source_id: row.clay_source_id, clay_campaign: row.clay_campaign,
          clay_set_up_at: row.clay_set_up_at, seeded_at: row.seeded_at, updated_at: row.updated_at }
      : null,
  };
}

registerPeopleSource("linkedin", { label: LINKEDIN_LABELS.source, look: "by_area", requests: (ctx) => linkedinPeopleRequests(ctx) });
