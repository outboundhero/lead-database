// One firing of the topup-worker (scripts/topup-worker.mjs, an hourly Railway
// cron), as steps the worker and the tests call:
//
//   (a) cancelBlockedRuns  queued or running top-up runs (aiark_runs.filters
//                          ? 'topup') of clients that can no longer receive
//                          are cancelled, with the reason as stop_reason. A
//                          cancel already stops new paid calls
//                          (scripts/lib/aiark/runs.mjs). Runs someone started
//                          by hand are never touched.
//   (b) runPass            the weekly flag pass, when weekly_topup is on and a
//                          pass is due or was asked for (pass.mjs).
//   (c) startWaitingPulls  auto mode: pulls waiting to start, within the budget
//                          and pulls_per_day (pulls.mjs).
//   (d) never-contact      the live apply of never-contact inboxes, while that
//                          switch is on and the filter is loaded
//                          (scripts/lib/never-contact-inboxes.mjs).
//
// With every switch off a firing reads the settings and writes nothing, apart
// from (a), which only ever acts on top-up runs, and none exist until pulls
// are switched on.

import { loadGeo } from "../aiark/filters.mjs";
import { TOPUP_LOCK_KEY } from "../overlap-topup.mjs";
import { sweep } from "../never-contact-inboxes.mjs";
import { runPass } from "./pass.mjs";
import { readTopupSettings, startWaitingPulls } from "./pulls.mjs";

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {Db & { connect: () => Promise<Db & { release: () => void }> }} DbPool
 */

/**
 * Cancels the top-up runs of clients that can no longer receive
 * (fn_client_receive_block, 132). As the AI Ark tab's Cancel does: a run
 * holding an export AI Ark has taken stays open until the worker has read it.
 *
 * @param {Db} db
 * @param {{ tagPrefix?: string | null, log?: (m: string) => void }} [opts]
 * @returns {Promise<Array<{ id: string, client_tag: string, block: string }>>}
 */
export async function cancelBlockedRuns(db, { tagPrefix = null, log = () => {} } = {}) {
  const { rows } = await db.query(
    `WITH b AS (
       SELECT q.id, public.fn_client_receive_block(q.client_tag) AS block
         FROM aiark_runs q
        WHERE q.filters ? 'topup' AND q.status IN ('queued', 'running')
          AND ($1::text IS NULL OR starts_with(q.client_tag, $1))
     )
     UPDATE aiark_runs r
        SET status = 'cancelled',
            stop_reason = format('Cancelled by the weekly top-up: %s can no longer get top-up leads (%s).', r.client_tag, b.block),
            finished_at = CASE WHEN jsonb_typeof(r.progress->'job') = 'object' THEN r.finished_at ELSE now() END
       FROM b
      WHERE r.id = b.id AND b.block IS NOT NULL AND r.status IN ('queued', 'running')
      RETURNING r.id, r.client_tag, r.source_id, r.pulled, b.block`,
    [tagPrefix]
  );
  for (const r of rows) {
    if (r.source_id) await db.query(`UPDATE enrich_sources SET received = $2, created = $2 WHERE id = $1`, [r.source_id, r.pulled]);
    log(`top-up: cancelled run ${String(r.id).slice(0, 8)} of ${r.client_tag}: ${r.block}`);
  }
  return rows.map(({ id, client_tag, block }) => ({ id, client_tag, block }));
}

/**
 * The worker's lease: a worker_locks row under TOPUP_LOCK_KEY for 55 minutes
 * (not an advisory lock: DATABASE_URL is the transaction pooler, where session
 * locks stick to whichever backend). True when this owner holds it now.
 *
 * @param {Db} db
 * @param {string} owner  a random id for this firing
 */
export async function acquireLease(db, owner) {
  const { rows } = await db.query(
    `insert into worker_locks (key, owner, locked_until) values ($1, $2, now() + interval '55 minutes')
     on conflict (key) do update set owner = excluded.owner, locked_until = excluded.locked_until
       where worker_locks.locked_until < now()
     returning owner`,
    [TOPUP_LOCK_KEY, owner]
  );
  return rows.length > 0;
}

/** Gives the lease back (only this owner's). */
export async function releaseLease(db, owner) {
  await db.query("delete from worker_locks where key = $1 and owner = $2", [TOPUP_LOCK_KEY, owner]);
}

/** Are the top-up tables there (migration 135)? */
export async function topupReady(db) {
  const { rows: [r] } = await db.query(
    `SELECT to_regclass('public.topup_passes') IS NOT NULL AND to_regprocedure('public.fn_client_receive_block(text)') IS NOT NULL AS ok`
  );
  return r.ok === true;
}

/** Is the never-contact inboxes writer there (migration 136)? */
export async function neverContactReady(db) {
  const { rows: [r] } = await db.query(
    `SELECT to_regclass('public.never_contact_inbox_runs') IS NOT NULL
            AND to_regprocedure('public.fn_suppress_general_inboxes(uuid[], text, uuid, uuid, text)') IS NOT NULL AS ok`
  );
  return r.ok === true;
}

/**
 * One firing: steps (a) to (d) in order, each within `deadline`.
 *
 * @param {DbPool} pool
 * @param {{ deadline: number, mode?: "live" | "demo", log?: (m: string) => void, tagPrefix?: string | null,
 *           sweepMs?: number, workerOnline?: (db: any) => Promise<boolean> }} opts
 *   mode: the AI Ark mode of the pulls it starts (live in production); sweepMs: the most the never-contact step may take
 */
export async function topupOnce(pool, { deadline, mode = "live", log = () => {}, tagPrefix = null, sweepMs = 15 * 60_000, workerOnline }) {
  const out = { ready: false, cancelled: 0, pass: null, pulls: null, neverContact: null };
  if (!(await topupReady(pool))) {
    log("the top-up tables are not there (migration 135): nothing to do");
    return out;
  }
  out.ready = true;
  const settings = await readTopupSettings(pool);
  out.cancelled = (await cancelBlockedRuns(pool, { tagPrefix, log })).length;
  const wt = settings.weekly_topup;
  if (wt.enabled) {
    const geo = await loadGeo(pool);
    const pass = await runPass(pool, { settings, geo, deadline, log, tagPrefix });
    out.pass = pass ? { id: pass.id, state: pass.state } : null;
    if (wt.pull_mode === "auto" && Date.now() < deadline) {
      out.pulls = await startWaitingPulls(pool, { settings, mode, geo, log, deadline, tagPrefix, ...(workerOnline ? { workerOnline } : {}) });
    }
  }
  if (settings.flagOn("never_contact_inboxes", "") && (await neverContactReady(pool)) && Date.now() < deadline) {
    out.neverContact = await sweep(pool, { deadline: Math.min(deadline, Date.now() + sweepMs), log });
  }
  return out;
}
