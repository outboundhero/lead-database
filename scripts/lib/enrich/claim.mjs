// The enrichment worker's claim (scripts/enrich-worker.mjs): which queued
// enrich_rows its free slots take next.
//
// In this order:
//   1. rows of AI Ark tab pulls (enrich_tables kind 'ai_ark'), oldest first:
//      quick database checks (the lead lookup, the area, the exclusions) whose
//      leads wait for them. Claimed oldest first across every table, a
//      10,000-person pull's rows once waited 2.5 hours behind thousands of
//      People rows;
//   2. the email checks: rows of the clients' General inboxes (pipeline)
//      tables (kind 'inboxes'). A general email becomes a lead only once its
//      check is done, and its row is made after its company's, so claimed
//      oldest first across every table the checks waited for the whole
//      company backlog: on 2026-11-25, 1,539 of one client's general emails
//      waited while its companies were worked, and only a few leads came out.
//      First, the leads come out while the companies are still being worked;
//   3. every other row (Companies, People, ...).
//
// Inside 2 and 3 the slots go to the tables in fair turns, so one client's big
// backlog never holds up another client's rows: claimed oldest first across
// every table, one client's company rows waited about 2 hours behind another
// client's scrape on 2026-11-25. A pass gives each table with due rows left up
// to ceil(slots left / those tables) of its oldest due rows (at least 1); when
// that is more rows than slots, earlier turns go first (every table's first
// row before any table's second), then older rows; slots still free after a
// pass go round again. One statement makes every pass at once: it numbers each
// table's oldest due rows 1, 2, 3 ... (their turns), takes the first n by turn
// and then age, and claims that many of each table's oldest due rows. That is
// what the passes take, in one round trip (the database is far from the
// worker).
//
// So a claim is up to three statements under one claim token, each taking
// what the ones before left of the free slots, FOR UPDATE SKIP LOCKED, the row
// marked running with the token and its attempt counted. The pull rows'
// statement is the claim as it was: it reads the queue in the order of the
// partial index enrich_rows_queue_idx (next_run_at, id WHERE run_status =
// 'queued', migration 122). The turns read each table's queue in the order of
// enrich_rows_table_queue_idx (table_id, next_run_at, id, the same rows,
// migration 142) and take the same rows without it, only slower;
// scripts/test-claim-order.mjs prints the plans. Two claims at once never wait
// for each other or take the same row: a turn passes the other claim's rows by
// and takes its table's next ones, and a table whose due rows the other claim
// holds gives fewer, its slots left to the next part or the next claim. As
// before, rows of a paused table or of a retired template's table
// (companies_v1, D24), held rows and rows not due yet are never claimed.

/** enrich_tables.kind of an AI Ark tab pull's table (scripts/lib/aiark/runs.mjs createRun). */
export const PULL_KIND = "ai_ark";

/** enrich_tables.kind of a client's General inboxes (pipeline) table: its rows are the email checks. */
export const EMAIL_CHECK_KIND = "inboxes";

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 */

/**
 * One claim, oldest first: up to $2 due queued rows of tables that are not
 * paused, pass `tableTest` and whose template is not one of $3, marked running
 * under the claim token $1.
 *
 * @param {string} tableTest
 */
const oldestFirst = (tableTest) => `UPDATE enrich_rows r
        SET run_status = 'running', claim_token = $1, claimed_at = now(), attempts = r.attempts + 1, updated_at = now()
      WHERE r.id IN (
        SELECT q.id FROM enrich_rows q
          JOIN enrich_tables t ON t.id = q.table_id AND NOT t.is_paused AND ${tableTest}
         WHERE q.run_status = 'queued' AND q.next_run_at <= now()
           AND (t.template IS NULL OR NOT (t.template = ANY($3::text[])))
         ORDER BY q.next_run_at, q.id
         LIMIT $2
           FOR UPDATE OF q SKIP LOCKED)
      RETURNING r.id, r.table_id, r.run_force, r.attempts, r.created_at, r.claim_token, r.next_run_at`;

/**
 * One claim in fair turns: up to $2 due queued rows of the same tables as
 * oldestFirst's, shared between those tables as the top of this file says,
 * marked and handed back as oldestFirst does.
 *
 * due: each table's oldest due rows, at most $2 (no table can take more),
 * numbered by turn, read without a lock. shares: how many of the first $2 by
 * turn, then age, are each table's. picked: that many of each table's oldest
 * due rows, locked, passing by rows another claim holds. It is MATERIALIZED so
 * the locked pick runs once: run again, SKIP LOCKED would pass by the rows
 * this statement just took and hand back more (held.mjs). Its ids reach the
 * UPDATE as one array, so the rows are updated by primary key: the planner
 * cannot know a turn's size, guesses a tenth of the table's queue, and with a
 * big backlog would join on a scan of the whole of enrich_rows instead.
 *
 * @param {string} tableTest
 */
const fairTurns = (tableTest) => `WITH due AS (
        SELECT c.table_id, c.next_run_at, c.id, c.turn
          FROM enrich_tables t
         CROSS JOIN LATERAL (
           SELECT q.table_id, q.next_run_at, q.id, row_number() OVER (ORDER BY q.next_run_at, q.id) AS turn
             FROM enrich_rows q
            WHERE q.table_id = t.id AND q.run_status = 'queued' AND q.next_run_at <= now()
            ORDER BY q.next_run_at, q.id
            LIMIT $2) c
         WHERE NOT t.is_paused AND ${tableTest}
           AND (t.template IS NULL OR NOT (t.template = ANY($3::text[])))
      ), shares AS (
        SELECT f.table_id, count(*) AS n
          FROM (SELECT d.table_id FROM due d ORDER BY d.turn, d.next_run_at, d.id LIMIT $2) f
         GROUP BY f.table_id
      ), picked AS MATERIALIZED (
        SELECT p.id FROM shares s
         CROSS JOIN LATERAL (
           SELECT q.id FROM enrich_rows q
            WHERE q.table_id = s.table_id AND q.run_status = 'queued' AND q.next_run_at <= now()
            ORDER BY q.next_run_at, q.id
            LIMIT s.n
              FOR UPDATE OF q SKIP LOCKED) p
      )
      UPDATE enrich_rows r
        SET run_status = 'running', claim_token = $1, claimed_at = now(), attempts = r.attempts + 1, updated_at = now()
      WHERE r.id = ANY (ARRAY(SELECT picked.id FROM picked))
      RETURNING r.id, r.table_id, r.run_force, r.attempts, r.created_at, r.claim_token, r.next_run_at`;

/** The claim's statements, in the order they run: pull rows, then the email checks, then every other table's. */
export const CLAIM_SQL = Object.freeze({
  pulls: oldestFirst(`t.kind = '${PULL_KIND}'`),
  inboxes: fairTurns(`t.kind = '${EMAIL_CHECK_KIND}'`),
  rest: fairTurns(`t.kind NOT IN ('${PULL_KIND}', '${EMAIL_CHECK_KIND}')`),
});

/** The order claimRows sends them in, and how its log names each. */
export const CLAIM_ORDER = Object.freeze(["pulls", "inboxes", "rest"]);
const PART_NAMES = { pulls: "AI Ark pull rows", inboxes: "email checks", rest: "rows of other tables" };

/**
 * Claims up to n queued rows under one claim token: AI Ark pull rows first,
 * oldest first, then the email checks (General inboxes rows), then the rest,
 * each of those two in fair turns between their tables; a part is asked only
 * for the slots the parts before it left. When a later part's statement fails
 * after rows were claimed, the failure is logged and the rows already claimed
 * are still handed back, so they are worked now instead of waiting in
 * 'running' for the stale sweep; the others are claimed on a later round. With
 * nothing claimed yet, the failure is thrown.
 *
 * @param {Db} db  the worker's pool
 * @param {number} n  free slots
 * @param {{ token: string, retired: string[], log?: (m: string) => void }} opts
 *   token: the claim token every claimed row gets; retired: templates whose tables are never claimed
 * @returns {Promise<any[]>} each claimed row's id, table_id, run_force, attempts, created_at, claim_token
 *   and next_run_at, in the parts' order (inside each part in no set order: the worker starts them all at once)
 */
export async function claimRows(db, n, { token, retired, log = console.error }) {
  if (!token || !Array.isArray(retired)) throw new TypeError("claimRows needs a claim token and the retired templates");
  if (!(n >= 1)) return [];
  const got = [];
  for (const part of CLAIM_ORDER) {
    if (got.length >= n) break;
    try {
      const { rows } = await db.query(CLAIM_SQL[part], [token, n - got.length, retired]);
      got.push(...rows);
    } catch (e) {
      if (!got.length) throw e;
      log(`claiming ${PART_NAMES[part]}: ${e instanceof Error ? e.message : String(e)} (the ${got.length} row(s) already claimed are worked now)`);
      return got;
    }
  }
  return got;
}
