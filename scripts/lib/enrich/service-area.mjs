// A client's service area: its area in words, for prompts. The People and
// General pipeline tables run it as the column service_area ("Service Area"),
// which a prompt reads as {{Service Area}} (the client_variable action,
// client-checks.mjs), and the Clay tab's Location tab and GET/PUT
// /api/clients/location show and edit it (migration 139).
//
// serviceAreaFor() is the one place the value is chosen, in this order:
//   1. the client's own value, the client_variables row "service_area" (typed
//      on the Clay tab: source manual);
//   2. else the onboarding sheet's places text (client_targeting.sheet_raw
//      ->> 'locations', what the sheet sync last read), trimmed, at most 600
//      characters; a cell that gives no answer ("N/A", "Already Provided" ...,
//      targeting-answers.mjs) is skipped, as the sync skips it;
//   3. else a short label made from the client's places (include_locations):
//      the first 12 cities as "City, ST", then the distinct state codes;
//   4. else nothing ("").
// Pure: no database, no network. The route and the pipeline action read the
// two rows and call it.

import { isNonAnswer } from "../targeting-answers.mjs";

/** The variable's name in client_variables, and the pipeline column's key. */
export const SERVICE_AREA = "service_area";
/** The longest value a client may type: client_variables.value's limit. */
export const SERVICE_AREA_MAX = 5_000;
/** The onboarding sheet's text is cut to this many characters. */
export const SHEET_TEXT_MAX = 600;
/** The places label names this many cities at most. */
export const LABEL_CITIES = 12;

/** Lone UTF-16 halves made U+FFFD: Postgres refuses them, and a prompt can't use them. */
const wellFormed = (s) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�");

/**
 * Text as a service area keeps it: no NUL, well formed, line ends as "\n",
 * spaces at line ends and more than one empty line dropped, trimmed. Anything
 * but text (or a number) is "".
 *
 * @param {unknown} v
 * @returns {string}
 */
export function cleanServiceArea(v) {
  if (typeof v !== "string" && typeof v !== "number") return "";
  return wellFormed(String(v))
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** At most `max` characters, cut after a word when there is one near the end, never inside a UTF-16 pair. */
function cap(s, max) {
  if (s.length <= max) return s;
  let cut = s.slice(0, max);
  const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"), cut.lastIndexOf(","), cut.lastIndexOf(";"));
  if (at >= max - 60) cut = cut.slice(0, at);
  return wellFormed(cut).replace(/[\s,;:]+$/, "");
}

/** A jsonb value as stored, or as text that holds one. */
function parsed(v) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

/**
 * The onboarding sheet's places text (sheet_raw.locations), as a service area
 * uses it: cleaned, at most 600 characters, "" when there is none or the cell
 * gives no answer.
 *
 * @param {unknown} sheetRaw  client_targeting.sheet_raw
 * @returns {string}
 */
export function sheetAreaText(sheetRaw) {
  const raw = parsed(sheetRaw);
  const cell = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.locations : null;
  const t = cleanServiceArea(cell);
  if (!t || isNonAnswer(t)) return "";
  return cap(t, SHEET_TEXT_MAX);
}

const word = (v) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim() : "");

/**
 * A short label of the client's places: the first 12 cities as "City, ST"
 * (with how many more there are), then the distinct state codes in brackets;
 * the state codes alone when no place names a city; the countries when no
 * place names a state; "" for none.
 *
 * @param {unknown} includeLocations  client_targeting.include_locations
 * @returns {string}
 */
export function placesLabel(includeLocations) {
  const list = parsed(includeLocations);
  if (!Array.isArray(list)) return "";
  /** @type {string[]} */
  const states = [];
  /** @type {string[]} */
  const cities = [];
  /** @type {string[]} */
  const countries = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const country = word(e.country).toUpperCase();
    const state = word(e.state).toUpperCase();
    const city = word(e.city);
    if (country && !countries.includes(country)) countries.push(country);
    if (state && !states.includes(state)) states.push(state);
    if (city && state && !cities.includes(`${city}, ${state}`)) cities.push(`${city}, ${state}`);
  }
  if (!states.length) return countries.join(", ");
  if (!cities.length) return states.join(", ");
  const shown = cities.slice(0, LABEL_CITIES);
  const more = cities.length - shown.length;
  return `${shown.join("; ")}${more > 0 ? ` and ${more} more` : ""} (${states.join(", ")})`;
}

/**
 * The service area the pipeline uses for a client, and where it comes from.
 * `from` is "variable" (the client_variables row; `source` then says who wrote
 * it: manual, sheet or scraper), "sheet" (the onboarding sheet's text),
 * "places" (the label of its places) or "none" (value "").
 *
 * @param {{ sheet_raw?: unknown, include_locations?: unknown } | null | undefined} targetingRow  client_targeting, or null
 * @param {{ value?: unknown, source?: unknown } | null | undefined} variableRow  the client_variables row "service_area", or null
 * @returns {{ value: string, from: "variable" | "sheet" | "places" | "none", source: string | null }}
 */
export function serviceAreaFor(targetingRow, variableRow) {
  const own = cleanServiceArea(variableRow?.value);
  if (own) return { value: own, from: "variable", source: typeof variableRow?.source === "string" ? variableRow.source : null };
  const sheet = sheetAreaText(targetingRow?.sheet_raw);
  if (sheet) return { value: sheet, from: "sheet", source: null };
  const label = placesLabel(targetingRow?.include_locations);
  if (label) return { value: label, from: "places", source: null };
  return { value: "", from: "none", source: null };
}
