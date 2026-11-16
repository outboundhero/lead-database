// The one rule for a client's AI Ark people and company filters (D-P4-1): its
// own saved filters (client_people_filters, the AI Ark tab's "People filters")
// when it has them, else the standard filters (cleaning-filters.mjs), else none.
// Who gets the standard filters depends on the search:
//
//   scope "ai_ark"    the AI Ark tab, AI Ark company pulls and AI Ark people
//                     runs: a client whose client_tags.client_type is exactly
//                     "Cleaning" (as before migration 128, D-P4-7);
//   scope "linkedin"  the LinkedIn sources: every client, whatever its type.
//
// The same scope decides `cleaning`, which makes a search send the standard
// keywords and company types even when the client has saved its own filters.
// Every reader of "saved, else standard" goes through filtersFor(), so the
// rule is written once.
//
// Plain JavaScript: the routes, the worker and the tests share it.

import { CLEANING_DEFAULTS, EMPTY_PEOPLE_FILTERS } from "./filters.mjs";

/** @typedef {"ai_ark" | "linkedin"} FilterScope */

export const FILTER_SCOPES = Object.freeze(["ai_ark", "linkedin"]);

/** The scope a run's source searches with: "linkedin" for the LinkedIn sources, "ai_ark" for everything else. */
export const scopeOf = (source) => (source === "linkedin" ? "linkedin" : "ai_ark");

/**
 * Does a client get the standard filters, and the standard keywords and
 * company types, in this scope?
 *
 * @param {string | null | undefined} clientType  client_tags.client_type
 * @param {FilterScope} [scope]
 * @returns {boolean}
 */
export function standardFor(clientType, scope = "ai_ark") {
  if (scope === "linkedin") return true;
  return clientType === "Cleaning";
}

/**
 * A client's people filters (which hold its company filters too): its saved
 * row when there is one, else the standard filters when the scope gives them
 * to this client, else none. The saved row is handed back as it is; each
 * reader cleans or picks from it as it always has.
 *
 * @template {Record<string, unknown>} T
 * @param {T | null | undefined} saved  client_people_filters' row (or its values), or null
 * @param {{ clientType?: string | null, scope?: FilterScope }} [opts]
 * @returns {{ value: T | typeof CLEANING_DEFAULTS | typeof EMPTY_PEOPLE_FILTERS, from: "saved" | "cleaning" | "none", cleaning: boolean }}
 *   from: "cleaning" names the standard filters (cleaning-filters.mjs), as the AI Ark tab always has;
 *   cleaning: send the standard keywords and company types
 */
export function filtersFor(saved, { clientType = null, scope = "ai_ark" } = {}) {
  const cleaning = standardFor(clientType, scope);
  if (saved) return { value: saved, from: "saved", cleaning };
  return { value: cleaning ? CLEANING_DEFAULTS : EMPTY_PEOPLE_FILTERS, from: cleaning ? "cleaning" : "none", cleaning };
}
