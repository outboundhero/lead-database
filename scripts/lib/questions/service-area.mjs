// A client's service area in words, for the {{Service Area}} placeholder of
// question variable prompts (139).
//
// TODO(integration): this is a stand-in for W2's serviceAreaFor(targetingRow,
// variableRow) in scripts/lib/enrich/service-area.mjs, written to the same
// precedence while both builds are apart. Once W2's file is merged, make
// serviceAreaOf call it (or replace its callers with it) so the pipeline and
// the question writer can never disagree, and keep loadServiceArea as the
// question writer's reader.
//
// The precedence (the value the pipeline uses):
//   1. the client's own value: client_variables row "service_area";
//   2. else the onboarding sheet's places text, client_targeting.sheet_raw ->>
//      'locations', trimmed, at most 600 characters;
//   3. else a short label from client_targeting.include_locations: the
//      distinct state codes, then the first 12 cities as "City, ST".

export const SERVICE_AREA_VARIABLE = "service_area";
export const SHEET_TEXT_MAX = 600;
export const LABEL_CITIES = 12;

const text = (v) => (v == null ? "" : String(v).trim());

/**
 * @param {{ sheet_raw?: { locations?: unknown } | null, include_locations?: unknown } | null | undefined} targetingRow
 * @param {{ value?: unknown } | null | undefined} variableRow  the client's client_variables row named service_area
 * @returns {string} "" when the client has none of the three
 */
export function serviceAreaOf(targetingRow, variableRow) {
  const own = text(variableRow?.value);
  if (own) return own;
  const sheet = text(targetingRow?.sheet_raw?.locations);
  if (sheet) return sheet.slice(0, SHEET_TEXT_MAX).trim();
  const places = Array.isArray(targetingRow?.include_locations) ? targetingRow.include_locations : [];
  const states = [];
  const cities = [];
  for (const p of places) {
    const state = text(p?.state).toUpperCase();
    if (state && !states.includes(state)) states.push(state);
    const city = text(p?.city);
    if (!city || cities.length >= LABEL_CITIES) continue;
    const label = state ? `${city}, ${state}` : city;
    if (!cities.includes(label)) cities.push(label);
  }
  return [states.join(", "), cities.join("; ")].filter(Boolean).join(": ");
}

// What a database without migration 139 (or 064) answers: no client_variables table.
const UNREADY = new Set(["42P01", "42703"]);

/**
 * Reads the client's two rows and gives its service area. A database without
 * client_variables (139 not applied) reads the targeting row alone.
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {string} tag
 * @returns {Promise<string>}
 */
export async function loadServiceArea(db, tag) {
  const { rows: [targeting] } = await db.query(
    `SELECT sheet_raw, include_locations FROM client_targeting WHERE client_tag = $1`,
    [tag]
  );
  let variable = null;
  try {
    ({ rows: [variable] } = await db.query(
      `SELECT value FROM client_variables WHERE client_tag = $1 AND name = $2`,
      [tag, SERVICE_AREA_VARIABLE]
    ));
  } catch (e) {
    if (!UNREADY.has(/** @type {{ code?: string }} */ (e)?.code)) throw e;
  }
  return serviceAreaOf(targeting ?? null, variable ?? null);
}
