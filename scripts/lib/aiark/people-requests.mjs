// What AI Ark is asked for the people at a pipeline's companies (people runs,
// people-runs.mjs): People Preview by company id, one body per batch of ids
// (and per group of titles, should the tracks' phrases ever outgrow one).
//
//   contact.company.latest.any.include        the batch's AI Ark company ids
//                                             (latest: the person's main role)
//   contact.experience.latest.title.any       the three tracks' phrases (WORD),
//                                             and the client's excluded titles
//                                             (WORD), each list condensed as the
//                                             AI Ark tab condenses its own
//   contact.keyword.any.exclude               a cleaning client's people keywords
//                                             on HEADLINE and SUMMARY
//
// No account, places or lists: the companies were judged by the company pull,
// each person's own place is judged after the Look (client_area, free), and
// the registry check per page leaves out people already bought.
//
// The tracks' phrases come from the originals through the database
// (enrich_settings.people_tracks, written by the seed script), never from this
// file: the repo is public.
//
// A people source is registered by name (registerPeopleSource). This file
// registers "ai_ark"; a later source registers its own.
//
// Plain JavaScript: the worker, the routes and the tests share it.

import { bytes, condensePhrases, pack } from "./filters.mjs";
import { CLEANING_EXCLUDE_KEYWORDS, CLEANING_EXCLUDE_TITLES } from "./cleaning-filters.mjs";

/** Company ids per search to start with (AI Ark's own cap is 300 per array; the request size binds first). */
export const IDS_PER_SEARCH = 50;
// The same limits the AI Ark tab keeps to (filters.mjs): what one request held when AI Ark took it.
const TITLES_BYTES = 2_000;
const EXCLUDE_TITLES_BYTES = 2_540;
const PEOPLE_KEYWORD_SOURCES = ["HEADLINE", "SUMMARY"];

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const wordsOf = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Does `outer` hold the words of `inner`, in order and side by side (AI Ark's WORD mode)? */
function holds(inner, outer) {
  if (!inner.length) return false;
  for (let i = 0; i + inner.length <= outer.length; i++) {
    if (inner.every((w, j) => outer[i + j] === w)) return true;
  }
  return false;
}

/**
 * @typedef {{ phrases: string[], from?: string[] }} TrackPhrases
 * @typedef {{ order: string[], operations: TrackPhrases, facility_office: TrackPhrases, ceo: TrackPhrases }} PeopleTracks
 */

/**
 * The track a job title belongs to, and its rank there: the tracks are tried
 * in their order (the agreed one: operations, then facility and office, then CEO or
 * owner), and the rank is the index of the first of the track's phrases the
 * title holds, as whole words in order (AI Ark's WORD match). Null when the
 * title holds none of them.
 *
 * @param {string | null | undefined} title
 * @param {PeopleTracks | null | undefined} tracks
 * @returns {{ track: string, rank: number } | null}
 */
export function trackOf(title, tracks) {
  const t = wordsOf(text(title));
  if (!t.length || !tracks || !Array.isArray(tracks.order)) return null;
  for (const track of tracks.order) {
    const phrases = Array.isArray(tracks[track]?.phrases) ? tracks[track].phrases : [];
    for (let i = 0; i < phrases.length; i++) {
      if (holds(wordsOf(phrases[i]), t)) return { track, rank: i };
    }
  }
  return null;
}

/** Every track's phrases, in the tracks' order, once each (case aside). */
export function trackPhrases(tracks) {
  const out = [];
  const seen = new Set();
  for (const track of Array.isArray(tracks?.order) ? tracks.order : []) {
    for (const p of Array.isArray(tracks[track]?.phrases) ? tracks[track].phrases : []) {
      const s = text(p);
      if (s && !seen.has(s.toLowerCase())) {
        seen.add(s.toLowerCase());
        out.push(s);
      }
    }
  }
  return out;
}

/**
 * The excluded titles a client's people searches use: its saved ones (the AI
 * Ark tab's people filters), else a cleaning client's standard ones, else none.
 *
 * @param {{ exclude_titles?: string[] } | null | undefined} saved  client_people_filters' row, or null
 * @param {string | null | undefined} clientType  client_tags.client_type
 * @returns {{ titles: string[], from: "saved" | "cleaning" | "none" }}
 */
export function excludedTitlesFor(saved, clientType) {
  if (saved) {
    const titles = (Array.isArray(saved.exclude_titles) ? saved.exclude_titles : []).map(text).filter(Boolean);
    return { titles, from: "saved" };
  }
  if (clientType === "Cleaning") return { titles: [...CLEANING_EXCLUDE_TITLES], from: "cleaning" };
  return { titles: [], from: "none" };
}

/**
 * People Preview bodies for the people at a set of companies: the ids in
 * batches of `idsPerSearch`, each batch once per group of titles. `page` and
 * `size` are added by the client when it sends one.
 *
 * @param {{ companyIds: string[], tracks: PeopleTracks, excludeTitles?: string[], cleaning?: boolean,
 *           idsPerSearch?: number }} opts
 * @returns {{ bodies: object[], batches: { ids: string[], bodies: object[] }[], titles: string[],
 *             excludeTitles: string[], keywords: string[], notes: string[], blockers: string[] }}
 */
export function buildPeopleAtCompanies({ companyIds, tracks, excludeTitles = [], cleaning = false, idsPerSearch = IDS_PER_SEARCH }) {
  const notes = [];
  const blockers = [];
  const ids = [...new Set((companyIds ?? []).map(text).filter(Boolean))];
  const phrases = trackPhrases(tracks);
  if (!phrases.length) blockers.push("The people tracks have no phrases: the Clay originals' seed writes them (enrich_settings.people_tracks).");
  if (!ids.length) blockers.push("No company ids to look at.");
  const titles = condensePhrases(phrases);
  const excluded = condensePhrases([...new Set((excludeTitles ?? []).map(text).filter(Boolean))]);
  if (bytes(excluded) > EXCLUDE_TITLES_BYTES) {
    blockers.push(`The titles to leave out are too long for an AI Ark search. Shorten the list by about ${(bytes(excluded) - EXCLUDE_TITLES_BYTES).toLocaleString("en-US")} characters.`);
  }
  const keywords = cleaning ? condensePhrases(CLEANING_EXCLUDE_KEYWORDS) : [];
  if (titles.length < phrases.length) {
    notes.push(`Shorter phrases stand in for longer ones ("facility" also finds "facility manager"), which keeps the request small and changes nobody's match.`);
  }
  const size = Math.max(1, Math.min(300, Math.floor(Number(idsPerSearch) || IDS_PER_SEARCH)));
  const titleGroups = pack(titles, TITLES_BYTES);
  if (titleGroups.length > 1) notes.push(`The tracks' phrases go out as ${titleGroups.length} groups, so each batch of companies is ${titleGroups.length} searches.`);

  const body = (batchIds, group) => ({
    contact: {
      company: { latest: { any: { include: batchIds } } },
      experience: {
        latest: {
          title: {
            any: {
              include: { mode: "WORD", content: group },
              ...(excluded.length ? { exclude: { mode: "WORD", content: excluded } } : {}),
            },
          },
        },
      },
      ...(keywords.length
        ? { keyword: { any: { exclude: { sources: PEOPLE_KEYWORD_SOURCES.map((source) => ({ mode: "WORD", source })), content: keywords } } } }
        : {}),
    },
  });

  const batches = [];
  if (!blockers.length) {
    for (let i = 0; i < ids.length; i += size) {
      const batchIds = ids.slice(i, i + size);
      batches.push({ ids: batchIds, bodies: titleGroups.map((g) => body(batchIds, g)) });
    }
  }
  return { bodies: batches.flatMap((b) => b.bodies), batches, titles, excludeTitles: excluded, keywords, notes, blockers };
}

// ── People sources ──────────────────────────────────────────────────────────

/** @type {Map<string, { requests: (ctx: any) => ReturnType<typeof buildPeopleAtCompanies>, label?: string }>} */
const SOURCES = new Map();

/**
 * Registers a people source: `impl.requests(ctx)` answers what buildPeopleAtCompanies
 * answers, for the run's batch of companies. A name registered again is replaced.
 *
 * @param {string} source
 * @param {{ requests: (ctx: any) => ReturnType<typeof buildPeopleAtCompanies>, label?: string }} impl
 */
export function registerPeopleSource(source, impl) {
  if (!/^[a-z][a-z0-9_]*$/.test(String(source ?? ""))) throw new Error(`A people source needs a plain name, not "${source}"`);
  if (typeof impl?.requests !== "function") throw new Error(`People source "${source}" has no requests()`);
  SOURCES.set(source, impl);
}

/** The people sources registered, by name. */
export const peopleSources = () => [...SOURCES.keys()];

/**
 * The requests a people source makes for one batch of companies.
 *
 * @param {string} source
 * @param {{ companyIds: string[], tracks: PeopleTracks, excludeTitles?: string[], cleaning?: boolean, idsPerSearch?: number }} ctx
 */
export function peopleRequestsFor(source, ctx) {
  const impl = SOURCES.get(source);
  if (!impl) throw new Error(`No people source "${source}" is registered`);
  return impl.requests(ctx);
}

registerPeopleSource("ai_ark", { label: "AI Ark", requests: (ctx) => buildPeopleAtCompanies(ctx) });
