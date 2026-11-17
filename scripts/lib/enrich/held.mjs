// Held rows (migration 129). Google Maps places that arrive through a
// client's inbound URL are stored in the client's Companies (pipeline) table
// (companies_v2) as 'held' rows. The worker claims queued rows only, so a held
// row is never worked and costs nothing.
//
// Once a minute the worker releases them (releaseHeldRows): held rows become
// queued, oldest first, in pages, and only in the tables of clients the
// company_pipeline switch is on for. The database decides that itself
// (fn_enrich_company_switch_on, which reads enrich_settings exactly as
// flagOn("company_pipeline", tag) does), so the worker's settings, up to 30
// seconds old, play no part.
//
// The guard trigger (trg_enrich_rows_release_guard) refuses any change from
// held while the client is off, whatever code sends it, with SQLSTATE 23514.
// A client switched off between the pick of its table and the release makes
// that page fail as a whole: nothing more is released for that table this
// round, and the next round leaves it alone.
//
// Switching a client off later: new places arrive held again; rows already
// released are not put back (decision 2).

import { COMPANY_TEMPLATE_V2 } from "./company-template-v2.mjs";

/** The guard's SQLSTATE: the client is not (or no longer) on the company_pipeline switch. */
export const HELD_REFUSED = "23514";

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 */

// The Companies (pipeline) tables with a held row whose client is switched on,
// the table with the oldest held row first (enrich_rows_held_idx).
const TABLES = `
  SELECT t.id, t.client_tag
    FROM enrich_tables t
   WHERE t.template = $1
     AND EXISTS (SELECT 1 FROM enrich_rows r WHERE r.table_id = t.id AND r.run_status = 'held')
     AND public.fn_enrich_company_switch_on(t.client_tag)
   ORDER BY (SELECT min(r.id) FROM enrich_rows r WHERE r.table_id = t.id AND r.run_status = 'held'), t.id`;

// One page of a table's held rows, oldest first; rows another worker is
// releasing at the same moment are skipped, not waited for. The page is
// picked once (MATERIALIZED): as "id IN (SELECT ... LIMIT ... FOR UPDATE SKIP
// LOCKED)" the planner may run the pick again for each row, and since the
// rows this statement already released are skipped as locked, every run
// moves on to the next ones and the page grows past its size (seen locally).
const RELEASE_PAGE = `
  WITH page AS MATERIALIZED (
    SELECT id FROM enrich_rows
     WHERE table_id = $1 AND run_status = 'held'
     ORDER BY id
     LIMIT $2
       FOR UPDATE SKIP LOCKED
  )
  UPDATE enrich_rows r
     SET run_status = 'queued', next_run_at = now(), attempts = 0, last_error = NULL, updated_at = now()
    FROM page
   WHERE r.id = page.id AND r.table_id = $1 AND r.run_status = 'held'`;

/**
 * Releases held rows for the clients on the company_pipeline switch: in pages
 * of pageSize, oldest first, at most maxPages pages in all per call (the rest
 * waits for the next minute). Each page is its own statement, so give it a
 * pool: inside a transaction the guard's refusal would abort the transaction.
 *
 * @param {Db} db
 * @param {{ pageSize?: number, maxPages?: number }} [opts]
 * @returns {Promise<{ released: number, tables: number, refused: number }>}
 *   released: rows now queued; tables: tables that had rows released;
 *   refused: tables whose client was switched off before its page ran (nothing released there)
 */
export async function releaseHeldRows(db, { pageSize = 5000, maxPages = 20 } = {}) {
  const size = Math.max(1, Math.min(50_000, Math.trunc(Number(pageSize)) || 5000));
  const budget = Math.max(1, Math.trunc(Number(maxPages)) || 20);
  const { rows: tables } = await db.query(TABLES, [COMPANY_TEMPLATE_V2]);
  let released = 0;
  let pages = 0;
  let refused = 0;
  let touched = 0;
  for (const t of tables) {
    if (pages >= budget) break;
    let fromThis = 0;
    while (pages < budget) {
      pages++;
      let n = 0;
      try {
        n = (await db.query(RELEASE_PAGE, [t.id, size])).rowCount ?? 0;
      } catch (e) {
        if (/** @type {{ code?: string }} */ (e)?.code !== HELD_REFUSED) throw e;
        refused++;
        break;
      }
      fromThis += n;
      if (n < size) break;
    }
    if (fromThis) touched++;
    released += fromThis;
  }
  return { released, tables: touched, refused };
}
