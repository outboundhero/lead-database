// What AI Ark is asked for a client's LinkedIn searches (design 2C, D-P4-1 to
// D-P4-3): the same request builders as the AI Ark tab and the Companies tab
// (buildRequests, buildCompanyRequests), fed what the resolver gives
// (linkedin-settings.mjs) instead of the client's database rules:
//
//   places          the client's own LinkedIn places for the kind, or for a
//                   client with no row its rules' places read live; people
//                   searches filter on the person's place, company searches on
//                   any office (head offices are judged after the pull)
//   excluded words  the standard keywords, then the client's own for the kind,
//                   on the company's name, industry and description; the rest
//                   "not applied (AI Ark limit)". The client's sheet exclusion
//                   terms are not sent here: they are checked after the pull,
//                   as for every row
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
// offices note (a LinkedIn pull keeps head offices), the "checked after the
// pull" notes (a LinkedIn keyword is not), and the rules blocker.
const DROPPED_NOTES = ["AI Ark finds a company when any of its offices", "AI Ark matches excluded words as whole words", "AI Ark's limits leave room for"];
const RULES_BLOCKER = "The client's rules have no locations";

const fmt = (n) => Number(n).toLocaleString("en-US");

/**
 * The made-up rules a LinkedIn search is built from: the resolver's places
 * and the client's own keywords in client_targeting's shape. Pass the same
 * object to createCompanyRun (as `targeting`), so the free registry copy
 * matches the places AI Ark is asked for.
 *
 * @param {import("./linkedin-settings.mjs").EffectiveLinkedin} effective
 * @returns {{ include_locations: object[], exclude_locations: object[], exclude_terms: string[], commercial_cleaning: false }}
 */
export function linkedinTargeting(effective) {
  return {
    include_locations: effective.own.include_locations,
    exclude_locations: effective.own.exclude_locations,
    exclude_terms: effective.own.exclude_keywords,
    commercial_cleaning: false,
  };
}

/** The excluded places as AI Ark is sent them, and a blocker when they can't go in one search. */
function excludedPlaces(effective, geo) {
  const sent = [...new Set(effective.own.exclude_locations.map((e) => placeString(e, geo).value).filter(Boolean))];
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
  const where = effective.from === "row" ? `${effective.tag}'s LinkedIn ${kind} settings` : `${effective.tag}'s database rules (it has no LinkedIn ${kind} settings of its own)`;
  const blockers = [
    ...effective.blockers,
    ...built.blockers.map((b) => (b.startsWith(RULES_BLOCKER) ? `${where} hold no places, so AI Ark would search everywhere. Add places on the AI Ark tab (LinkedIn settings).` : b)),
    ...ex.blockers,
  ];
  const notes = built.notes.filter((n) => !DROPPED_NOTES.some((d) => n.startsWith(d)));
  const k = effective.keywords;
  if (k.notApplied.length) {
    notes.push(
      `${fmt(k.notApplied.length)} of the ${fmt(k.union.length)} excluded keywords are not applied (AI Ark limit): AI Ark's limits leave room for the standard ${fmt(k.standard.length)} and ${fmt(k.union.length - k.standard.length - k.notApplied.length)} of this client's own. They are listed on the AI Ark tab and in the run, and are not checked after the pull.`
    );
  }
  if (effective.own.exclude_keywords.length) {
    notes.push(`Excluded keywords are matched as whole words in a company's name, industry and description. The client's database rules (its sheet's exclusion terms) are checked after the pull, as for every row.`);
  }
  if (effective.outsideRules.length) {
    notes.push(
      `${fmt(effective.outsideRules.length)} of these places are outside the client's database area (its rules on the Clients page): what is found only there is paid for, then marked outside the client's area, and is never sent. Add them to the client's rules, or take them out here.`
    );
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
      places: { include: effective.own.include_locations.length, exclude: effective.own.exclude_locations.length, unplaced: effective.own.unplaced.length, outsideRules: effective.outsideRules.length },
      excludePlacesSent: ex.sent.length,
      keywords: { standard: k.standard.length, own: k.own.length, union: k.union.length, sent: k.sent.length, notApplied: k.notApplied },
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
 * (filters.linkedin), so the run shows what it was asked, the keywords not
 * applied included (D-P4-3), whatever is edited later.
 *
 * @param {import("./linkedin-settings.mjs").EffectiveLinkedin} effective
 */
export function linkedinRunFilters(effective) {
  const row = effective.row;
  return {
    kind: effective.kind,
    from: effective.from,
    version: effective.version,
    filters_from: effective.filters.from,
    places: effective.own.include_locations,
    exclude_places: effective.own.exclude_locations,
    outside_rules: effective.outsideRules,
    keywords: { own: effective.keywords.own, sent: effective.keywords.sent, not_applied: effective.keywords.notApplied },
    starter_version: effective.from === "rules_and_starter" ? effective.starter.version : null,
    provenance: row
      ? { source: row.source, copied_from: row.copied_from, clay_source_id: row.clay_source_id, clay_campaign: row.clay_campaign,
          clay_set_up_at: row.clay_set_up_at, seeded_at: row.seeded_at, updated_at: row.updated_at }
      : null,
  };
}

registerPeopleSource("linkedin", { label: LINKEDIN_LABELS.source, look: "by_area", requests: (ctx) => linkedinPeopleRequests(ctx) });
