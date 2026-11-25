// The enrichment worker's claim (scripts/enrich-worker.mjs): which queued
// enrich_rows its free slots take next.
//
// Rows of AI Ark tab pulls (enrich_tables kind 'ai_ark') are claimed before
// any other row, however long the others have waited. A pull's rows are quick
// database checks (the lead lookup, the area, the exclusions), while a People
// row waits on the email finders, slow calls to outside services. Claimed
// oldest first across every table, a 10,000-person pull's rows once waited
// 2.5 hours behind thousands of People rows, and its leads reached the
// database hours late.
//
// So a claim is two statements under one claim token: up to n due rows of
// pull tables, then, when fewer came back, the rest from every other table.
// Each is the claim as it was (oldest first, FOR UPDATE SKIP LOCKED, the row
// marked running with the token and its attempt counted), so each can read
// the queue in the order of the partial index enrich_rows_queue_idx
// (next_run_at, id WHERE run_status = 'queued', migration 122);
// scripts/test-claim-order.mjs prints both plans. As before, rows of a paused
// table or of a retired template's table (companies_v1, D24), held rows and
// rows not due yet are never claimed.

/** enrich_tables.kind of an AI Ark tab pull's table (scripts/lib/aiark/runs.mjs createRun). */
export const PULL_KIND = "ai_ark";

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 */

/**
 * One claim: up to $2 due queued rows, oldest first, of tables that are not
 * paused, pass `tableTest` and whose template is not one of $3, marked running
 * under the claim token $1.
 *
 * @param {string} tableTest
 */
const claimStatement = (tableTest) => `UPDATE enrich_rows r
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

/** The claim's two statements, in the order they run: pull rows, then every other table's. */
export const CLAIM_SQL = Object.freeze({
  pulls: claimStatement(`t.kind = '${PULL_KIND}'`),
  rest: claimStatement(`t.kind <> '${PULL_KIND}'`),
});

/**
 * Claims up to n queued rows under one claim token: AI Ark pull rows first,
 * then the rest, each oldest first. When claiming the rest fails after pull
 * rows were claimed, the failure is logged and the pull rows are still handed
 * back, so they are worked now instead of waiting in 'running' for the stale
 * sweep; the rest are claimed on a later round.
 *
 * @param {Db} db  the worker's pool
 * @param {number} n  free slots
 * @param {{ token: string, retired: string[], log?: (m: string) => void }} opts
 *   token: the claim token every claimed row gets; retired: templates whose tables are never claimed
 * @returns {Promise<any[]>} each claimed row's id, table_id, run_force, attempts, created_at, claim_token
 *   and next_run_at, pull rows first (inside each part in no set order: the worker starts them all at once)
 */
export async function claimRows(db, n, { token, retired, log = console.error }) {
  if (!token || !Array.isArray(retired)) throw new TypeError("claimRows needs a claim token and the retired templates");
  if (!(n >= 1)) return [];
  const { rows: pulls } = await db.query(CLAIM_SQL.pulls, [token, n, retired]);
  if (pulls.length >= n) return pulls;
  try {
    const { rows: rest } = await db.query(CLAIM_SQL.rest, [token, n - pulls.length, retired]);
    return [...pulls, ...rest];
  } catch (e) {
    if (!pulls.length) throw e;
    log(`claiming rows of other tables: ${e instanceof Error ? e.message : String(e)} (the ${pulls.length} AI Ark pull row(s) claimed are worked now)`);
    return pulls;
  }
}
