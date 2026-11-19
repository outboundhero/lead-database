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
//
// People rows (migration 130): an upload's no-email rows are copied into the
// client's People (pipeline) table (people_v1) as held rows (upload-move.mjs).
// releaseHeldPeopleRows releases them the same way, under the people_pipeline
// switch (fn_enrich_people_switch_on), and only while the table has fewer than
// RELEASE_OPEN_MAX rows queued, running or waiting: a big upload never fills
// the worker's queue, and rows waiting on a daily cap hold the rest back. The
// guard (130) answers per table: a Companies row to company_pipeline, a People
// row to people_pipeline, a row of any other table never. Each release is its
// own query, so a database without 130 (42883) still releases Maps rows.

import { COMPANY_TEMPLATE_V2 } from "./company-template-v2.mjs";
import { PEOPLE_TEMPLATE } from "./people-template.mjs";
import { RELEASE_OPEN_MAX, RELEASE_PAGE as PEOPLE_PAGE_SIZE } from "./upload-people.mjs";

/** The guard's SQLSTATE: the client is not (or no longer) on its table's switch (company_pipeline, or people_pipeline for a People row). */
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

// ── People (pipeline) rows (130) ────────────────────────────────────────────

// The People (pipeline) tables with a held row whose client is on the
// people_pipeline switch, the table with the oldest held row first.
const PEOPLE_TABLES = `
  SELECT t.id, t.client_tag
    FROM enrich_tables t
   WHERE t.template = $1
     AND EXISTS (SELECT 1 FROM enrich_rows r WHERE r.table_id = t.id AND r.run_status = 'held')
     AND public.fn_enrich_people_switch_on(t.client_tag)
   ORDER BY (SELECT min(r.id) FROM enrich_rows r WHERE r.table_id = t.id AND r.run_status = 'held'), t.id`;

// A table's rows in work or waiting (enrich_rows_status_idx), counted no further than $2.
const OPEN_ROWS = `
  SELECT count(*)::int AS n
    FROM (SELECT 1 FROM enrich_rows WHERE table_id = $1 AND run_status IN ('queued', 'running', 'waiting') LIMIT $2) x`;

const HAS_HELD = `SELECT EXISTS (SELECT 1 FROM enrich_rows WHERE table_id = $1 AND run_status = 'held') AS held`;

/**
 * Releases held People (pipeline) rows for the clients on the people_pipeline
 * switch: the oldest held row first, in pages, while the table has fewer than
 * openMax rows queued, running or waiting (each page at most the room left).
 * At most maxPages pages in all per call. A client switched off before its
 * page runs makes the guard refuse the page (23514): counted in refused, and
 * that table is left this round. Rows of any other template are never
 * touched. Each page is its own statement, so give it a pool.
 *
 * @param {Db} db  a pool (each page is its own statement)
 * @param {{ pageSize?: number, maxPages?: number, openMax?: number }} [opts]  defaults RELEASE_PAGE, 20, RELEASE_OPEN_MAX
 * @returns {Promise<{ released: number, tables: number, refused: number, full: number }>}
 *   full: tables with held rows left held because RELEASE_OPEN_MAX rows are queued, running or waiting there
 */
export async function releaseHeldPeopleRows(db, { pageSize = PEOPLE_PAGE_SIZE, maxPages = 20, openMax = RELEASE_OPEN_MAX } = {}) {
  const size = Math.max(1, Math.min(50_000, Math.trunc(Number(pageSize)) || PEOPLE_PAGE_SIZE));
  const budget = Math.max(1, Math.trunc(Number(maxPages)) || 20);
  const most = Math.max(1, Math.trunc(Number(openMax)) || RELEASE_OPEN_MAX);
  const { rows: tables } = await db.query(PEOPLE_TABLES, [PEOPLE_TEMPLATE]);
  let released = 0;
  let pages = 0;
  let refused = 0;
  let touched = 0;
  let full = 0;
  for (const t of tables) {
    if (pages >= budget) break;
    const { rows: [open] } = await db.query(OPEN_ROWS, [t.id, most]);
    let room = most - Number(open?.n ?? 0);
    let fromThis = 0;
    let stopped = false;
    while (room > 0 && pages < budget) {
      pages++;
      const want = Math.min(size, room);
      let n = 0;
      try {
        n = (await db.query(RELEASE_PAGE, [t.id, want])).rowCount ?? 0;
      } catch (e) {
        if (/** @type {{ code?: string }} */ (e)?.code !== HELD_REFUSED) throw e;
        refused++;
        stopped = true;
        break;
      }
      fromThis += n;
      room -= n;
      if (n < want) {
        stopped = true; // no more held rows (or the rest is being released by another worker)
        break;
      }
    }
    if (fromThis) touched++;
    released += fromThis;
    if (!stopped && room <= 0 && (await db.query(HAS_HELD, [t.id])).rows[0]?.held === true) full++;
  }
  return { released, tables: touched, refused, full };
}
