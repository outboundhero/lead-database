// AI Ark runs someone started by hand (on the AI Ark tab: no filters.topup)
// that are still queued or running for a client that cannot receive now
// (fn_client_receive_block, 132). The weekly top-up's hourly cancel touches
// only its own runs (run.mjs, step a), so these keep going and keep buying;
// the Low places tab lists them (plan 2.7) so someone can cancel one on the
// AI Ark tab. Read only.
//
// Cheap: only queued or running runs (a handful; aiark_runs_queue_idx), one
// receive check each. Runs of the Companies pipeline (aiark_company_runs,
// aiark_people_runs) are not listed: plan 2.7 is about aiark_runs.

/** @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db */

/** $1 a tag prefix (tests only) or null, $2 the most rows. */
export const HAND_RUNS_SQL = `SELECT r.id, r.client_tag, r.status, r.mode, r.strategy, r.size_requested, r.credits_used::float8 AS credits_used, r.pulled,
       r.created_at, r.started_at, coalesce(nullif(btrim(up.full_name), ''), up.email) AS started_by, b.block
  FROM aiark_runs r
  CROSS JOIN LATERAL (SELECT public.fn_client_receive_block(r.client_tag) AS block) b
  LEFT JOIN user_profiles up ON up.id = r.created_by
 WHERE r.status IN ('queued', 'running') AND NOT (r.filters ? 'topup') AND b.block IS NOT NULL
   AND ($1::text IS NULL OR starts_with(r.client_tag, $1))
 ORDER BY r.created_at, r.id
 LIMIT $2`;

/**
 * AI Ark runs someone started by hand (not filters.topup) that are queued or
 * running for a client fn_client_receive_block blocks now, oldest first. Read only.
 *
 * @param {Db} db
 * @param {{ tagPrefix?: string | null, limit?: number }} [opts]  tagPrefix: tests only
 * @returns {Promise<Array<{ id: string, client_tag: string, status: "queued" | "running", mode: "live" | "demo",
 *                            strategy: "single" | "export", size_requested: number, credits_used: number, pulled: number,
 *                            created_at: Date, started_at: Date | null, started_by: string | null, block: string }>>}
 */
export async function handRunsBlocked(db, { tagPrefix = null, limit = 200 } = {}) {
  const most = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 200;
  const { rows } = await db.query(HAND_RUNS_SQL, [tagPrefix, most]);
  return rows;
}
