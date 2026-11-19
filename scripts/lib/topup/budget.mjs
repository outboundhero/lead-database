// The weekly top-up's AI Ark budget (migration 135, plan 2.5), in credits over
// the last 7 days, in all and for one client:
//
//   used      credits_used of top-up runs (aiark_runs.filters ? 'topup')
//             created in the window, plus the credits of top-up counts made in
//             it (topup_pulls.count_credits, by counted_at);
//   reserved  for each top-up run still queued or running (or cancelled and
//             still reading an export it paid for), its brake
//             (topup_pulls.brake, else the run's own spending brake) minus
//             what it has used.
//
// A new pull starts only if used + reserved + its own brake (+ 1 a search when
// it counts) stays within weekly_credits and client_weekly_credits. Each run
// holds its worst case, and the brake is checked before every paid call
// (scripts/lib/aiark/runs.mjs), so no run can take the total past the budget.
//
// Runs of both modes count: demo runs only exist where AIARK_DEMO=1 (tests and
// local work), never beside live ones in production.

export { brakeFor } from "../aiark/runs.mjs";

/** The advisory lock every budget check that may start a pull or a count holds (pg_advisory_xact_lock(hashtext(...))). */
export const TOPUP_BUDGET_LOCK = "topup-budget";

/**
 * @typedef {{ used: number, reserved: number, clientUsed: number, clientReserved: number }} TopupBudget
 */

/**
 * Credits used and held in the last 7 days, in all and for `tag` (0 for both when no tag).
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ tag?: string | null }} [opts]
 * @returns {Promise<TopupBudget>}
 */
export async function topupBudget(db, { tag = null } = {}) {
  const { rows: [r] } = await db.query(
    `WITH runs AS (
       SELECT r.client_tag, r.credits_used::float8 AS used, r.created_at,
              (r.status IN ('queued', 'running')
               OR (r.status = 'cancelled' AND r.finished_at IS NULL AND jsonb_typeof(r.progress->'job') = 'object')) AS going,
              coalesce(p.brake::float8,
                       ceil(r.size_requested * 1.25) + 5 * jsonb_array_length(r.requests) + 10)::float8 AS brake
         FROM aiark_runs r
         LEFT JOIN topup_pulls p ON p.run_id = r.id
        WHERE r.filters ? 'topup'
     ), counts AS (
       SELECT client_tag, count_credits::float8 AS credits
         FROM topup_pulls
        WHERE counted_at > now() - interval '7 days' AND count_credits > 0
     )
     SELECT
       coalesce((SELECT sum(used) FROM runs WHERE created_at > now() - interval '7 days'), 0)
         + coalesce((SELECT sum(credits) FROM counts), 0) AS used,
       coalesce((SELECT sum(greatest(brake - used, 0)) FROM runs WHERE going), 0) AS reserved,
       coalesce((SELECT sum(used) FROM runs WHERE created_at > now() - interval '7 days' AND client_tag = $1), 0)
         + coalesce((SELECT sum(credits) FROM counts WHERE client_tag = $1), 0) AS client_used,
       coalesce((SELECT sum(greatest(brake - used, 0)) FROM runs WHERE going AND client_tag = $1), 0) AS client_reserved`,
    [tag]
  );
  return {
    used: Number(r.used),
    reserved: Number(r.reserved),
    clientUsed: Number(r.client_used),
    clientReserved: Number(r.client_reserved),
  };
}

/**
 * Does `extra` more credits fit inside both budgets?
 *
 * @param {TopupBudget} b
 * @param {{ weekly: number, clientWeekly: number, extra: number }} opts
 */
export function budgetAllows(b, { weekly, clientWeekly, extra }) {
  return b.used + b.reserved + extra <= weekly && b.clientUsed + b.clientReserved + extra <= clientWeekly;
}

/**
 * Top-up pulls started since the UTC day began (weekly_topup.pulls_per_day).
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @returns {Promise<number>}
 */
export async function pullsStartedToday(db) {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM topup_pulls
      WHERE started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`
  );
  return r.n;
}
