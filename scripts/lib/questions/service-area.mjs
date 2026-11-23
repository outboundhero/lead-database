// A client's service area in words, for the {{Service Area}} placeholder of
// question variable prompts (139). It is the value the People and General
// pipeline tables' service_area column gives: serviceAreaFor() in
// scripts/lib/enrich/service-area.mjs is the one place it is chosen (the value
// typed on the Clay tab, else the onboarding sheet's places text, else a label
// of the client's places), so the pipeline and the question writer never
// disagree. loadServiceArea is the question writer's reader of the two rows.

import { SERVICE_AREA, serviceAreaFor } from "../enrich/service-area.mjs";

// What a database without migration 139 (or 064) answers: no client_variables table.
const UNREADY = new Set(["42P01", "42703"]);

/**
 * Reads the client's two rows and gives its service area (serviceAreaFor's
 * value; "" when the client has none). A database without client_variables
 * (139 not applied) reads the targeting row alone.
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
      `SELECT value, source FROM client_variables WHERE client_tag = $1 AND name = $2`,
      [tag, SERVICE_AREA]
    ));
  } catch (e) {
    if (!UNREADY.has(/** @type {{ code?: string }} */ (e)?.code)) throw e;
  }
  return serviceAreaFor(targeting ?? null, variable ?? null).value;
}
