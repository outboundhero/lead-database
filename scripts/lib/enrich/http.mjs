// HTTP for the Clay tab's actions (actions.mjs, pipeline-actions.mjs,
// email-vendors.mjs): JSON over fetch, never throwing for an HTTP status, and
// the rule that a paid request with no answer is sent at most twice.
//
// A paid call is made once per attempt (tries: 1). The row-level retry of the
// worker (scripts/enrich-worker.mjs) handles a lost answer, with its backoff.
// A request that timed out may still have been billed, so a cell is sent at
// most twice with no answer (counted from enrich_cell_runs), then it ends in an
// error until a person re-runs it.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RESPONSE_CAP = 32_000;

/** A provider answer cut down to what enrich_cell_runs keeps. */
export function capped(value) {
  if (value == null) return null;
  const s = JSON.stringify(value);
  return s.length <= RESPONSE_CAP ? value : { truncated: true, head: s.slice(0, RESPONSE_CAP) };
}

/**
 * JSON over HTTP, retrying 429s, 5xx and network errors `tries` times (3 by
 * default; paid calls pass 1). Never throws for an HTTP status: the caller
 * decides what a status means. The error text holds no request URL.
 *
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, timeoutMs?: number, tries?: number }} [opts]
 * @returns {Promise<{ ok: boolean, status: number, json: any, error: string | null, headers?: Headers | null }>}
 */
export async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 30_000, tries = 3 } = {}) {
  let last = { ok: false, status: 0, json: null, error: "no attempt", headers: null };
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      const raw = await res.text();
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* not JSON */
      }
      last = { ok: res.ok, status: res.status, json, error: res.ok ? null : `HTTP ${res.status}: ${raw.slice(0, 200)}`, headers: res.headers };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      last = { ok: false, status: 0, json: null, error: timeout ? `timed out after ${timeoutMs / 1000}s` : e?.cause?.code || e?.message || "request failed", headers: null };
    }
    if (attempt < tries) await sleep(2_000 * attempt);
  }
  return last;
}

export const retryableStatus = (s) => s === 0 || s === 429 || s >= 500;

/** How many sends a paid cell may make with no answer before it stops. */
export const MAX_LOST_SENDS = 2;

/**
 * The sends of one cell that got no answer at all (no HTTP status: a timeout
 * or a dropped connection) since its last answered run.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> } | null | undefined} db
 * @param {{ id?: number | string } | null | undefined} row
 * @param {{ key?: string } | null | undefined} column
 * @returns {Promise<number>}
 */
export async function lostSends(db, row, column) {
  if (!db || row?.id == null || !column?.key) return 0;
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM enrich_cell_runs r
      WHERE r.row_id = $1 AND r.column_key = $2 AND r.status = 'error' AND coalesce(r.http_status, 0) = 0
        AND r.id > coalesce((SELECT max(d.id) FROM enrich_cell_runs d
                              WHERE d.row_id = $1 AND d.column_key = $2 AND d.status IN ('done', 'empty')), 0)`,
    [row.id, column.key]
  );
  return Number(rows?.[0]?.n ?? 0);
}

/** A forced re-run (run_force holds the column, or "*") may send again. */
export const forcedFor = (row, column) => Array.isArray(row?.run_force) && row.run_force.some((k) => k === "*" || k === column?.key);

/**
 * Refuses a paid send when this cell was already sent twice with no answer,
 * unless a person forced it again. Returns the cell to write, or null to go on.
 */
export async function lostSendGuard({ db, row, column }) {
  if (forcedFor(row, column)) return null;
  let n = 0;
  try {
    n = await lostSends(db, row, column);
  } catch {
    n = 0; // a test or a fake db without the table: no history to read
  }
  if (n < MAX_LOST_SENDS) return null;
  return {
    status: "error",
    note: `Sent ${n} times with no answer, so it is not sent again: a request that timed out may still be billed. Re-run the cell to send it once more.`,
    retryable: false,
  };
}
