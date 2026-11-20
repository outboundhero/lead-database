// Bison lead-sync runs (migration 131, 2026-11-20): the regular 3-day slot, the
// top bar's "Sync now" request, and the run log the top bar shows.
//
// Used by scripts/bison-sync-cron.mjs (the bison-sync cron, every 30 minutes)
// and src/app/api/bison/sync/route.ts (the top-bar panel). Every DB helper takes
// `q(sql, params) -> rows`, so the cron, the route and the test pass their own.
// Tested by scripts/test-bison-sync-runs.mts.

const DAY_MS = 86_400_000;

// The regular slot, kept from the old cron `0 3 */3 * *`: 03:00 UTC on days
// 1, 4, 7 … 31 of every month (7 PM PST the evening before).
export function lastSlotAtOrBefore(now) {
  const t = new Date(now);
  let d = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), 3));
  if (d > t) d = new Date(d.getTime() - DAY_MS);
  while ((d.getUTCDate() - 1) % 3 !== 0) d = new Date(d.getTime() - DAY_MS);
  return d;
}

/**
 * What one 30-minute check should do:
 *   "button"   — a "Sync now" request is waiting
 *   "schedule" — no run has started since the last regular slot
 *   null       — nothing (most checks)
 * A failed run counts as having run: the slot is not retried every 30 minutes;
 * the top bar shows the failure and "Sync now" re-runs it.
 */
export function decide({ now, requested, lastStartedAt }) {
  if (requested) return "button";
  if (!lastStartedAt || new Date(lastStartedAt) < lastSlotAtOrBefore(now)) return "schedule";
  return null;
}

/**
 * Read scripts/sync-bison-leads.mjs's output: its closing "done: N rows fetched,
 * M new lead(s) added" line, and any "shard N failed" lines with the install they
 * were printed under — a slice that still failed after its retries. (Since
 * 2026-11-20 such a slice holds the install's watermark below it, so the next
 * run fetches it; it is recorded so a repeat failure is visible.)
 */
export function parseSyncOutput(text) {
  const num = (s) => Number(String(s).replace(/,/g, ""));
  const m = String(text).match(/done: ([\d,]+) rows fetched, ([\d,]+) new lead\(s\)/);
  const failures = [];
  let install = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h = line.match(/^=== (\S+) /);
    if (h) install = h[1];
    const f = line.match(/shard (\d+) failed: (.*)$/);
    if (f) failures.push(`${install ?? "?"} shard ${f[1]}: ${f[2].trim().slice(0, 120)}`);
  }
  return { rowsFetched: m ? num(m[1]) : null, newLeads: m ? num(m[2]) : null, failures };
}

// ── run log (bison_sync_runs) ─────────────────────────────────────────────
// At most one 'requested' and one 'running' row exist at a time (two partial
// unique indexes), which is also what keeps two syncs from overlapping.
export const STALE_MINUTES = 10;
const RUN_COLS = "id, status, trigger, requested_by, requested_at, started_at, heartbeat_at, finished_at, rows_fetched, new_leads, error";
const isUniqueViolation = (e) => e && e.code === "23505";

/** A 'running' row with no heartbeat for STALE_MINUTES (process killed or redeployed) becomes 'failed'. */
export async function failStale(q) {
  return q(
    `update bison_sync_runs
        set status = 'failed', finished_at = now(),
            error = concat_ws(' · ', error, 'interrupted: no heartbeat for ${STALE_MINUTES} minutes')
      where status = 'running' and coalesce(heartbeat_at, started_at) < now() - interval '${STALE_MINUTES} minutes'
      returning id`
  );
}

/** The waiting request or running sync, if any. */
export async function activeRun(q) {
  const rows = await q(
    `select ${RUN_COLS} from bison_sync_runs where status in ('requested', 'running')
      order by (status = 'running') desc, requested_at limit 1`
  );
  return rows[0] ?? null;
}

/** "Sync now": record a request unless one is already waiting or running. */
export async function requestSync(q, requestedBy) {
  const existing = await activeRun(q);
  if (existing) return { created: false, run: existing };
  try {
    const rows = await q(
      `insert into bison_sync_runs (trigger, status, requested_by) values ('button', 'requested', $1) returning ${RUN_COLS}`,
      [requestedBy ?? null]
    );
    return { created: true, run: rows[0] };
  } catch (e) {
    if (isUniqueViolation(e)) return { created: false, run: await activeRun(q) };   // two presses at once
    throw e;
  }
}

/** What the top bar shows: the waiting/running run, the last finished one, and the last watermark write (fallback). */
export async function syncStatus(q) {
  const active = await activeRun(q);
  const last = (await q(
    `select ${RUN_COLS} from bison_sync_runs where status in ('done', 'failed')
      order by coalesce(finished_at, started_at, requested_at) desc limit 1`
  ))[0] ?? null;
  const wm = (await q(`select max(updated_at) as at from bison_sync_state where shard = -1`))[0];
  return { active, last, watermarkAt: wm?.at ?? null };
}

/** When the latest run started; before any run was recorded, when an install's watermark last moved. */
export async function lastStartedAt(q) {
  const r = (await q(`select max(started_at) as at from bison_sync_runs`))[0];
  if (r?.at) return r.at;
  const w = (await q(`select max(updated_at) as at from bison_sync_state where shard = -1`))[0];
  return w?.at ?? null;
}

/** Start a run: the waiting request ('button') or a new row ('schedule' / 'manual'). null when another run is already going. */
export async function claimRun(q, trigger) {
  try {
    if (trigger === "button") {
      const rows = await q(
        `update bison_sync_runs set status = 'running', started_at = now(), heartbeat_at = now()
          where id = (select id from bison_sync_runs where status = 'requested' order by requested_at limit 1)
          returning id`
      );
      return rows[0]?.id ?? null;
    }
    const rows = await q(
      `insert into bison_sync_runs (trigger, status, started_at, heartbeat_at) values ($1, 'running', now(), now()) returning id`,
      [trigger]
    );
    return rows[0].id;
  } catch (e) {
    if (isUniqueViolation(e)) return null;
    throw e;
  }
}

export async function heartbeat(q, id) {
  await q(`update bison_sync_runs set heartbeat_at = now() where id = $1 and status = 'running'`, [id]);
}

export async function finishRun(q, id, { ok, rowsFetched, newLeads, error }) {
  await q(
    `update bison_sync_runs
        set status = $2, finished_at = now(), heartbeat_at = now(), rows_fetched = $3, new_leads = $4, error = $5
      where id = $1`,
    [id, ok ? "done" : "failed", rowsFetched ?? null, newLeads ?? null, error ?? null]
  );
}
