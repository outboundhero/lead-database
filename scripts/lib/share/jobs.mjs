// Share jobs (134): one per finished import batch the share step found, and
// what happens to it (contract 2.1 and 2.2; plan 1.1, 1.7, 1.9, 1.13).
//
//   discoverJobs()  finished leads batches made since overlap_sharing.since
//                   with no job yet get one: skipped (with the reason),
//                   no_lead_list, or waiting.
//   claimDue()      a waiting job whose import a location run has passed
//                   (cron_runs.location_backfill.finished_run_started_at
//                   later than batch_done_at), or that reached its wait limit
//                   (place_wait_hit_at, a red notice), or a deciding job whose
//                   lease ran out, is taken for deciding.
//   decideJob()     its receivers are chosen once and decided a Bison group at
//                   a time, one transaction per receiver (receivers_done), so a
//                   crash or a stop carries on where it left; then settleJob().
//   recheckJob()    once a day while recheck_until is ahead, the leads that had
//                   no usable place are decided if they have one now.
//   settleJob()     in apply mode (the job's and the setting's), applies each
//                   receiver within the push caps; then previewed or applied.
//   applyReceiver() marks one receiver's shares applied, in chunks of
//                   SHARE_CHUNK, one transaction each, and queues their push
//                   when the receiver is on push_tags.
//   undoJob(), retryJob(): the Sharing page's undo and retry.
// Errors back off (next_try_at) and, after SHARE_JOB_MAX_TRIES, the job shows
// "error" until an admin retries it.

import { clientPool, flagOn, normTag, settingsFrom } from "../enrich/settings.mjs";
import { routeTagOf } from "../enrich/upload-people.mjs";
import {
  CRON_LOCATION_BACKFILL, DEAD_BATCH_HOURS, isTopupRunFilters, SHARE_CHUNK, SHARE_DISCOVER_MAX, SHARE_JOB_MAX_TRIES, SHARE_PUSH_SOURCES,
} from "../overlap-topup.mjs";
import { inTx, isUnready, read, UTC_DAY_START } from "./db.mjs";
import { candidateReceivers, decideLeads, Fenced, jobLeads, receiversByTag, StopRound, writeReceiver } from "./decide.mjs";

/**
 * @typedef {import("./db.mjs").Pool} Pool
 * @typedef {import("../enrich/settings.mjs").PipelineSettings} PipelineSettings
 * @typedef {import("./decide.mjs").Receiver} Receiver
 */

/** How long a deciding job is held by the round that took it before another round may take it over. */
export const DECIDE_LEASE_MINUTES = 10;
/** How far back a recheck looks past its last look, so a place written just before it is never missed. */
const RECHECK_MARGIN_MINUTES = 10;
/** The outcomes that are shares (lead_shares.outcome). */
const SHARING = `('shared', 'own_topup')`;

/** The settings as stored now (never the worker's 30-second copy): the web actions and the seed read them fresh. */
export async function settingsNow(pool) {
  const { rows } = await read(pool, `SELECT key, value FROM enrich_settings`);
  return settingsFrom(rows);
}

/** One client's tag, type and Bison group; null when the tag is no client. */
export async function clientOf(pool, tag) {
  const { rows: [r] } = await read(pool, `SELECT tag, client_type, group_no FROM client_tags WHERE tag = $1`, [tag]);
  return r ?? null;
}

// ── Discovery ───────────────────────────────────────────────────────────────

const DISCOVER_SQL = `
  SELECT b.id, b.add_tags, b.inserted_rows, b.status, r.filters AS run_filters,
         coalesce(b.completed_at,
                  CASE WHEN b.status = 'processing' THEN b.created_at + make_interval(hours => $3) ELSE now() END) AS done_at,
         (SELECT count(*) FROM upload_batch_leads u WHERE u.batch_id = b.id)::int AS listed,
         (SELECT count(*) FROM upload_batch_leads u WHERE u.batch_id = b.id AND u.outcome = 'new')::int AS new_leads
    FROM upload_batches b
    LEFT JOIN aiark_runs r ON r.id = b.aiark_run_id
   WHERE b.batch_type = 'leads'
     AND b.field_mapping IS NOT NULL
     AND (b.status IN ('complete', 'error') OR (b.status = 'processing' AND b.created_at < now() - make_interval(hours => $3)))
     AND b.created_at >= $1::timestamptz
     AND NOT EXISTS (SELECT 1 FROM share_jobs s WHERE s.batch_id = b.id)
   ORDER BY b.created_at, b.id
   LIMIT $2`;

/**
 * What discovery makes of one batch: skipped with a reason (SHARE_SKIP_REASONS),
 * no_lead_list (rows inserted but no lead list: an old copy of the code, or
 * sharing was off), or waiting.
 *
 * @param {{ add_tags: string[] | null, inserted_rows: number | null, listed: number, new_leads: number }} b
 * @param {PipelineSettings} settings
 * @param {Map<string, string | null>} clients  tag -> client_type
 * @returns {{ state: string, reason: string | null, origin: string | null, pool: string | null }}
 */
export function discoveryOf(b, settings, clients) {
  const { tag, why } = routeTagOf(b.add_tags, clients.keys());
  if (!tag) return { state: "skipped", reason: why, origin: null, pool: null };
  if (!flagOn(settings, "overlap_sharing", tag)) return { state: "skipped", reason: "origin_not_on_list", origin: tag, pool: null };
  const pool = clientPool(settings, tag, clients.get(tag) ?? null);
  if (!pool) return { state: "skipped", reason: "origin_isolated", origin: tag, pool: null };
  if (!b.listed) {
    return Number(b.inserted_rows) > 0
      ? { state: "no_lead_list", reason: null, origin: tag, pool }
      : { state: "skipped", reason: "no_new_leads", origin: tag, pool };
  }
  if (!b.new_leads) return { state: "skipped", reason: "no_new_leads", origin: tag, pool };
  return { state: "waiting", reason: null, origin: tag, pool };
}

/**
 * Finds up to SHARE_DISCOVER_MAX finished leads batches made at or after
 * overlap_sharing.since with no share job, oldest first, and gives each its
 * job (ON CONFLICT DO NOTHING, so a batch is looked at once).
 *
 * @param {Pool} pool
 * @param {{ settings: PipelineSettings, limit?: number }} opts
 * @returns {Promise<{ found: number, waiting: number, skipped: number, noList: number }>}
 */
export async function discoverJobs(pool, { settings, limit = SHARE_DISCOVER_MAX }) {
  const os = settings.overlap_sharing;
  const out = { found: 0, waiting: 0, skipped: 0, noList: 0 };
  if (!os?.enabled || !os.since) return out;
  const { rows: batches } = await read(pool, DISCOVER_SQL, [os.since, limit, DEAD_BATCH_HOURS]);
  if (!batches.length) return out;
  const { rows: tags } = await read(pool, `SELECT tag, client_type FROM client_tags`);
  const clients = new Map(tags.map((t) => [t.tag, t.client_type]));
  for (const b of batches) {
    const d = discoveryOf(b, settings, clients);
    const { rowCount } = await inTx(pool, (c) =>
      c.query(
        `INSERT INTO share_jobs (batch_id, origin_tag, origin_pool, state, reason, topup, mode, batch_done_at, place_wait_until, new_leads)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $8::timestamptz + make_interval(mins => $9), $10)
         ON CONFLICT (batch_id) DO NOTHING`,
        [b.id, d.origin, d.pool, d.state, d.reason, isTopupRunFilters(b.run_filters), os.mode, b.done_at, os.wait_location_minutes, b.new_leads]
      )
    );
    if (!rowCount) continue;
    out.found++;
    if (d.state === "waiting") out.waiting++;
    else if (d.state === "no_lead_list") out.noList++;
    else out.skipped++;
  }
  return out;
}

// ── Taking a job ────────────────────────────────────────────────────────────

const LOCATION_RUN_PASSED = `EXISTS (SELECT 1 FROM cron_runs c WHERE c.name = $1 AND c.finished_run_started_at > j.batch_done_at)`;

/**
 * Takes one job to decide: a waiting job whose import a location run has
 * passed or that reached its wait limit, or a deciding job whose lease ran
 * out. It becomes deciding, held for DECIDE_LEASE_MINUTES; a job taken at its
 * limit gets place_wait_hit_at now (hitNow).
 *
 * @param {Pool} pool
 * @returns {Promise<(Record<string, any> & { hit_now: boolean }) | null>}
 */
export async function claimDue(pool) {
  const { rows: [job] } = await inTx(pool, (c) =>
    c.query(
      `WITH pick AS (
         SELECT j.batch_id FROM share_jobs j
          WHERE j.state IN ('waiting', 'deciding') AND j.next_try_at <= now()
            AND (j.state = 'deciding' OR now() >= j.place_wait_until OR ${LOCATION_RUN_PASSED})
          ORDER BY j.next_try_at, j.batch_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE share_jobs j
          SET state = 'deciding', next_try_at = now() + make_interval(mins => $2),
              place_wait_hit_at = CASE WHEN j.state = 'waiting' AND NOT ${LOCATION_RUN_PASSED} THEN now() ELSE j.place_wait_hit_at END
         FROM pick
        WHERE j.batch_id = pick.batch_id
       RETURNING j.*, (j.place_wait_hit_at IS NOT NULL AND j.place_wait_hit_at = now()) AS hit_now`,
      [CRON_LOCATION_BACKFILL, DECIDE_LEASE_MINUTES]
    )
  );
  return job ?? null;
}

/** A failed decide: tried again later (backoff), and "error" after SHARE_JOB_MAX_TRIES tries. */
async function failJob(pool, batchId, err) {
  await inTx(pool, (c) =>
    c.query(
      `UPDATE share_jobs
          SET attempts = attempts + 1, last_error = left($2, 500),
              next_try_at = now() + make_interval(mins => least(60, (2 ^ least(attempts, 6))::int)),
              state = CASE WHEN attempts + 1 >= $3 THEN 'error' ELSE state END
        WHERE batch_id = $1 AND state IN ('waiting', 'deciding')`,
      [batchId, String(/** @type {Error} */ (err)?.message ?? err), SHARE_JOB_MAX_TRIES]
    )
  );
}

/** A deciding job left for the next round (a stop, or the round's time is up): taken again at once. */
async function releaseJob(pool, batchId) {
  await inTx(pool, (c) => c.query(`UPDATE share_jobs SET next_try_at = now() WHERE batch_id = $1 AND state = 'deciding'`, [batchId]));
}

/** The job is not decided after all: its origin left the list or its pool since discovery. */
async function skipJob(pool, batchId, reason) {
  await inTx(pool, (c) =>
    c.query(`UPDATE share_jobs SET state = 'skipped', reason = $2, next_try_at = now() WHERE batch_id = $1 AND state = 'deciding'`, [batchId, reason])
  );
}

/**
 * The origin's check at decide time: still a client, on the sharing list and
 * in a pool. Null when it may be shared, else the skip reason.
 */
function originBlock(settings, origin) {
  if (!origin) return "not_client";
  if (!flagOn(settings, "overlap_sharing", origin.tag)) return "origin_not_on_list";
  if (!clientPool(settings, origin.tag, origin.client_type)) return "origin_isolated";
  return null;
}

/**
 * Why a receiver may not take shares from this origin (null when it may): off
 * the sharing list, isolated, or in another pool than the origin. The
 * receive rule itself is fn_share_fits's (132, 134).
 *
 * @param {PipelineSettings} settings
 * @param {Receiver | undefined} r
 * @param {{ tag: string, client_type: string | null }} origin
 * @returns {string | null}
 */
export function listBlock(settings, r, origin) {
  if (!r) return "not a client";
  if (!flagOn(settings, "overlap_sharing", r.tag)) return "not on the sharing list";
  if (r.isOrigin) return null;
  const pool = clientPool(settings, r.tag, r.client_type);
  if (!pool) return "isolated";
  if (pool !== clientPool(settings, origin.tag, origin.client_type)) return "in another pool";
  return null;
}

/**
 * Decides these receivers for these leads, a Bison group at a time, and stores
 * each receiver in its own transaction (writeReceiver). A receiver that may
 * not take shares from this origin now (listBlock) fits nothing: its rows not
 * applied for these leads go. Throws StopRound when `stop` says so between
 * groups.
 *
 * @param {Pool} pool
 * @param {{ batchId: string, origin: { tag: string, client_type: string | null, group_no: number | null },
 *           leads: import("./decide.mjs").Lead[], receivers: Receiver[], all: Receiver[], settings: PipelineSettings,
 *           states: string[], addChecked?: boolean, stop?: () => boolean, shouldStop?: () => boolean }} p
 *   receivers: decided now; all: every receiver of the job (the others' stored shares keep their leads)
 * @returns {Promise<string[]>}  the receivers stored
 */
export async function decideUnits(pool, { batchId, origin, leads, receivers, all, settings, states, addChecked = false, stop = () => false, shouldStop = () => false }) {
  const pattern = settings.never_contact_inboxes?.pattern ?? null;
  const ids = leads.map((l) => l.id);
  const stored = [];
  for (const unit of unitsOf(receivers)) {
    if (stop()) throw new StopRound();
    const now = new Set(unit.map((r) => r.tag));
    const others = all.filter((r) => !now.has(r.tag)).map((r) => ({ tag: r.tag, group_no: r.group_no }));
    const open = unit.filter((r) => !listBlock(settings, r, origin));
    const results = await decideLeads(pool, {
      batchId, origin: { tag: origin.tag, group_no: origin.group_no }, leads, receivers: open, others, pattern, shouldStop,
    });
    for (const r of unit) {
      if (!open.includes(r)) results.push({ tag: r.tag, decisions: new Map(), checked: ids.length, fits: 0 });
    }
    for (const result of results) {
      await writeReceiver(pool, { batchId, originTag: origin.tag, result, decidedIds: ids, states, addChecked });
      stored.push(result.tag);
    }
  }
  return stored;
}

/** The job's receivers that are units decided together: one per Bison group, the origin's own_topup alone, in tag order. */
export function unitsOf(receivers) {
  const sorted = [...receivers].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const units = [];
  const byGroup = new Map();
  for (const r of sorted) {
    if (r.isOrigin || r.group_no == null) {
      units.push([r]);
      continue;
    }
    if (!byGroup.has(r.group_no)) {
      byGroup.set(r.group_no, []);
      units.push(byGroup.get(r.group_no));
    }
    byGroup.get(r.group_no).push(r);
  }
  return units;
}

/**
 * Decides one taken job, a Bison group of receivers at a time, each receiver
 * stored in its own transaction; then settles it. Gives the job back for the
 * next round when the worker is stopping or the round's time is up.
 *
 * @param {Pool} pool
 * @param {Record<string, any>} job  as claimDue() returned it
 * @param {{ settings: PipelineSettings, deadline?: number, shouldStop?: () => boolean, log?: (line: string) => void }} opts
 * @returns {Promise<"decided" | "skipped" | "paused" | "failed" | "fenced">}
 */
export async function decideJob(pool, job, { settings, deadline = Infinity, shouldStop = () => false, log = () => {} }) {
  const batchId = job.batch_id;
  try {
    const origin = await clientOf(pool, job.origin_tag);
    const why = originBlock(settings, origin);
    if (why) {
      await skipJob(pool, batchId, why);
      log(`share job ${batchId.slice(0, 8)} (${job.origin_tag}): skipped, ${why}`);
      return "skipped";
    }
    const { rows: [{ now: readAt }] } = await read(pool, `SELECT now() AS now`);
    const { placed, noPlace } = await jobLeads(pool, batchId);
    let tags = job.receivers ?? [];
    if (!(job.receivers_done ?? []).length) {
      // Chosen once per decide: the clients that may receive now, beside any
      // the job already names (a retry decides those again too).
      const candidates = await candidateReceivers(pool, {
        settings, originTag: origin.tag, originPool: clientPool(settings, origin.tag, origin.client_type), leads: placed,
      });
      tags = [...new Set([...tags, ...candidates.map((r) => r.tag), ...(job.topup ? [origin.tag] : [])])].sort();
      await inTx(pool, (c) => c.query(`UPDATE share_jobs SET receivers = $2 WHERE batch_id = $1 AND state = 'deciding'`, [batchId, tags]));
    }
    const all = await receiversByTag(pool, tags, origin.tag);
    const done = new Set(job.receivers_done ?? []);
    const pending = [...all.values()].filter((r) => !done.has(r.tag));
    await decideUnits(pool, {
      batchId, origin, leads: placed, receivers: pending, all: [...all.values()], settings, states: ["deciding"],
      stop: () => shouldStop() || Date.now() > deadline, shouldStop,
    });
    await settleJob(pool, batchId, { settings, log, noPlace, readAt, first: true, states: ["deciding"] });
    return "decided";
  } catch (e) {
    if (e instanceof StopRound) {
      await releaseJob(pool, batchId).catch(() => {});
      return "paused";
    }
    if (e instanceof Fenced) return "fenced";
    if (isUnready(e)) throw e;
    log(`share job ${batchId.slice(0, 8)} (${job.origin_tag}): ${/** @type {Error} */ (e).message}`);
    await failJob(pool, batchId, e).catch(() => {});
    return "failed";
  }
}

// ── Applying ────────────────────────────────────────────────────────────────

/** Live shares of one receiver in one job not applied yet. */
async function openShares(db, batchId, receiver) {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM lead_shares
      WHERE batch_id = $1 AND receiver_tag = $2 AND outcome IN ${SHARING} AND applied_at IS NULL AND undone_at IS NULL`,
    [batchId, receiver]
  );
  return r.n;
}

/** Receivers of the job that still have live shares not applied. */
async function receiversOpen(db, batchId) {
  const { rows } = await db.query(
    `SELECT DISTINCT receiver_tag FROM lead_shares
      WHERE batch_id = $1 AND outcome IN ${SHARING} AND applied_at IS NULL AND undone_at IS NULL ORDER BY 1`,
    [batchId]
  );
  return rows.map((r) => r.receiver_tag);
}

/**
 * The push caps of one receiver (plan 1.8; only for a receiver whose shares
 * are pushed, A0 deviation 8): over push_max_per_job shares in this job, or
 * over push_max_per_day with the shares it got pushed since the UTC day began.
 *
 * @param {Pool | import("./db.mjs").Db} db
 * @param {{ batchId: string, receiver: string, settings: PipelineSettings, count?: number | null }} p
 * @returns {Promise<{ over: boolean, job: number, today: number, why: string | null }>}
 */
export async function capCheck(db, { batchId, receiver, settings, count = null }) {
  const os = settings.overlap_sharing;
  const job = count ?? (await openShares(db, batchId, receiver));
  const { rows: [t] } = await db.query(
    `SELECT count(*)::int AS n FROM lead_shares
      WHERE receiver_tag = $1 AND applied_at >= ${UTC_DAY_START} AND push_state IS NOT NULL`,
    [receiver]
  );
  const today = t.n;
  const why = job > os.push_max_per_job
    ? `${job} shares in this import, over the ${os.push_max_per_job} a job`
    : today + job > os.push_max_per_day
      ? `${today} pushed today and ${job} more, over the ${os.push_max_per_day} a day`
      : null;
  return { over: why != null, job, today, why };
}

/**
 * Applies one receiver's live shares in one job, in chunks of SHARE_CHUNK, one
 * transaction each: applied_at and applied_by (null when the step applied it
 * in apply mode), and push_state queued when `push` (the receiver on
 * push_tags; for own_topup, the origin). Each chunk locks the job first (it
 * must be in one of `states`) and asks fn_client_receive_block again. Then the
 * receiver is applied on the job and off its over-cap list.
 *
 * @param {Pool} pool
 * @param {{ batchId: string, receiver: string, userId?: string | null, push: boolean, states: string[] }} p
 * @returns {Promise<{ applied: number, queued: number, blocked: string | null }>}
 */
export async function applyReceiver(pool, { batchId, receiver, userId = null, push, states }) {
  let applied = 0;
  let queued = 0;
  for (;;) {
    const step = await inTx(pool, async (c) => {
      const { rows: [job] } = await c.query(`SELECT state FROM share_jobs WHERE batch_id = $1 FOR UPDATE`, [batchId]);
      if (!job) throw new Fenced("gone");
      if (!states.includes(job.state)) throw new Fenced(job.state);
      const { rows: [g] } = await c.query(`SELECT public.fn_client_receive_block($1) AS block`, [receiver]);
      if (g.block) return { blocked: g.block, n: 0, q: 0 };
      const { rows } = await c.query(
        `UPDATE lead_shares SET applied_at = now(), applied_by = $3, push_state = CASE WHEN $4::boolean THEN 'queued' END
          WHERE id IN (SELECT id FROM lead_shares
                        WHERE batch_id = $1 AND receiver_tag = $2 AND outcome IN ${SHARING} AND applied_at IS NULL AND undone_at IS NULL
                        ORDER BY id LIMIT $5)
         RETURNING push_state`,
        [batchId, receiver, userId, push, SHARE_CHUNK]
      );
      return { blocked: null, n: rows.length, q: rows.filter((r) => r.push_state === "queued").length };
    });
    if (step.blocked) return { applied, queued, blocked: step.blocked };
    applied += step.n;
    queued += step.q;
    if (step.n < SHARE_CHUNK) break;
  }
  await inTx(pool, (c) =>
    c.query(
      `UPDATE share_jobs
          SET receivers_applied = CASE WHEN $2 = ANY(receivers_applied) THEN receivers_applied ELSE array_append(receivers_applied, $2::text) END,
              receivers_over_cap = array_remove(receivers_over_cap, $2::text)
        WHERE batch_id = $1`,
      [batchId, receiver]
    )
  );
  return { applied, queued, blocked: null };
}

/**
 * Why one of a job's receivers may not be applied now (null when it may): off
 * the sharing list, in another pool than the origin, or unable to receive.
 *
 * @param {PipelineSettings} settings
 * @param {Receiver | undefined} r
 * @param {{ tag: string, client_type: string | null }} origin
 */
export function applyBlock(settings, r, origin) {
  const why = listBlock(settings, r, origin);
  if (why) return why;
  if (r?.block) return `cannot receive: ${r.block}`;
  return null;
}

/**
 * The end of a decide or a recheck. When both the job's mode and the
 * setting's are apply, each receiver with open shares is applied, unless its
 * shares would be pushed and it is over a cap (receivers_over_cap: an admin
 * applies it). Then the job is applied when no receiver has open shares in
 * apply mode, else previewed. The mode used is kept on the job, so a job
 * decided in preview mode never applies by itself later.
 *
 * @param {Pool} pool
 * @param {string} batchId
 * @param {{ settings: PipelineSettings, log?: (line: string) => void, noPlace: number, readAt: Date | string,
 *           first: boolean, states: string[] }} p  first: a decide (sets decided_at and the recheck window), else a recheck
 */
export async function settleJob(pool, batchId, { settings, log = () => {}, noPlace, readAt, first, states }) {
  const { rows: [job] } = await read(pool, `SELECT * FROM share_jobs WHERE batch_id = $1`, [batchId]);
  if (!job || !states.includes(job.state)) throw new Fenced(job?.state ?? "gone");
  const os = settings.overlap_sharing;
  const applyMode = job.mode === "apply" && os.mode === "apply";
  const overCap = new Set(job.receivers_over_cap ?? []);
  if (applyMode) {
    const origin = await clientOf(pool, job.origin_tag);
    const open = await receiversOpen(pool, batchId);
    const info = await receiversByTag(pool, open, job.origin_tag);
    for (const tag of open) {
      if (overCap.has(tag)) continue;
      const why = origin ? applyBlock(settings, info.get(tag), origin) : "not a client";
      if (why) {
        log(`share job ${batchId.slice(0, 8)}: ${tag} not applied, ${why}`);
        continue;
      }
      const push = flagOn(settings, "share_push", tag);
      if (push) {
        const cap = await capCheck(pool, { batchId, receiver: tag, settings });
        if (cap.over) {
          overCap.add(tag);
          await inTx(pool, (c) =>
            c.query(
              `UPDATE share_jobs SET receivers_over_cap = CASE WHEN $2 = ANY(receivers_over_cap) THEN receivers_over_cap ELSE array_append(receivers_over_cap, $2::text) END
                WHERE batch_id = $1`,
              [batchId, tag]
            )
          );
          log(`share job ${batchId.slice(0, 8)}: ${tag} left at preview for an admin, ${cap.why}`);
          continue;
        }
      }
      const r = await applyReceiver(pool, { batchId, receiver: tag, push, states });
      if (r.blocked) log(`share job ${batchId.slice(0, 8)}: ${tag} not applied, cannot receive: ${r.blocked}`);
    }
  }
  // Open shares wait for an admin: previewed. With none open, a job in apply
  // mode is applied, and so stays one an admin applied before a recheck; a job
  // decided in preview mode stops at previewed.
  const left = await receiversOpen(pool, batchId);
  const state = left.length ? "previewed" : applyMode || job.state === "applied" ? "applied" : "previewed";
  const recheck = Math.max(0, Number(os.recheck_days) || 0);
  await inTx(pool, async (c) => {
    const { rowCount } = await c.query(
      `UPDATE share_jobs
          SET mode = CASE WHEN $6::boolean THEN $4 ELSE mode END,
              leads_no_place = $5, attempts = 0, last_error = NULL, next_try_at = now(),
              decided_at = CASE WHEN $6::boolean THEN now() ELSE decided_at END,
              recheck_until = CASE WHEN NOT $6::boolean THEN recheck_until
                                   WHEN $5 > 0 AND $7 > 0 THEN now() + make_interval(days => $7) END,
              next_recheck_at = CASE WHEN $5 = 0 THEN NULL
                                     WHEN coalesce(CASE WHEN $6::boolean THEN now() + make_interval(days => $7) ELSE recheck_until END,
                                                   '-infinity') >= $8::timestamptz + interval '1 day'
                                       THEN $8::timestamptz + interval '1 day' END,
              applied_at = CASE WHEN $3 = 'applied' AND state <> 'applied' THEN now() ELSE applied_at END,
              applied_by = CASE WHEN $3 = 'applied' AND state <> 'applied' THEN NULL ELSE applied_by END,
              state = $3
        WHERE batch_id = $1 AND state = ANY($2::text[])`,
      [batchId, states, state, applyMode ? "apply" : "preview", noPlace, first, recheck, readAt]
    );
    if (!rowCount) throw new Fenced("changed");
  });
  return state;
}

// ── Rechecking leads that had no place ─────────────────────────────────────

/**
 * Takes one job whose next look at its no-place leads is due, and moves that
 * look a day on (or ends the looks when the window has closed).
 *
 * @param {Pool} pool
 * @returns {Promise<(Record<string, any> & { was: Date }) | null>}
 */
async function claimRecheck(pool) {
  const { rows: [job] } = await inTx(pool, (c) =>
    c.query(
      `WITH pick AS (
         SELECT batch_id, next_recheck_at AS was FROM share_jobs
          WHERE next_recheck_at <= now() AND state IN ('previewed', 'applied')
          ORDER BY next_recheck_at, batch_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE share_jobs j
          SET next_recheck_at = CASE WHEN j.recheck_until >= now() + interval '1 day' THEN now() + interval '1 day' END
         FROM pick
        WHERE j.batch_id = pick.batch_id
       RETURNING j.*, pick.was`
    )
  );
  return job ?? null;
}

/**
 * One daily look at a job's leads that had no usable place: those that have
 * one now (and no share row in this job) are decided against the clients that
 * may receive them now, and the job is settled again. leads_no_place says how
 * many still have none.
 *
 * @param {Pool} pool
 * @param {{ settings: PipelineSettings, shouldStop?: () => boolean, log?: (line: string) => void }} opts
 * @returns {Promise<{ batchId: string, looked: number } | null>}  null: no job due
 */
export async function recheckOne(pool, { settings, shouldStop = () => false, log = () => {} }) {
  const job = await claimRecheck(pool);
  if (!job) return null;
  const batchId = job.batch_id;
  try {
    const origin = await clientOf(pool, job.origin_tag);
    if (originBlock(settings, origin)) return { batchId, looked: 0 };
    const since = new Date(new Date(job.was).getTime() - 86_400_000 - RECHECK_MARGIN_MINUTES * 60_000);
    const { rows: [{ now: readAt }] } = await read(pool, `SELECT now() AS now`);
    const { placed, noPlace } = await jobLeads(pool, batchId, { changedSince: since });
    if (placed.length) {
      const candidates = await candidateReceivers(pool, {
        settings, originTag: origin.tag, originPool: clientPool(settings, origin.tag, origin.client_type), leads: placed,
      });
      const tags = [...candidates.map((r) => r.tag), ...(job.topup ? [origin.tag] : [])];
      const fresh = await receiversByTag(pool, tags, origin.tag);
      const all = await receiversByTag(pool, [...(job.receivers ?? []), ...tags], origin.tag);
      await decideUnits(pool, {
        batchId, origin, leads: placed, receivers: [...fresh.values()], all: [...all.values()], settings,
        states: ["previewed", "applied"], addChecked: true, stop: shouldStop, shouldStop,
      });
      log(`share job ${batchId.slice(0, 8)} (${origin.tag}): ${placed.length} lead(s) that had no place were decided`);
    }
    await settleJob(pool, batchId, { settings, log, noPlace, readAt, first: false, states: ["previewed", "applied"] });
    return { batchId, looked: placed.length };
  } catch (e) {
    if (e instanceof StopRound || e instanceof Fenced) return { batchId, looked: 0 };
    if (isUnready(e)) throw e;
    log(`share job ${batchId.slice(0, 8)}: the daily look at its leads with no place failed: ${/** @type {Error} */ (e).message}`);
    return { batchId, looked: 0 };
  }
}

// ── Undo and retry ──────────────────────────────────────────────────────────

/**
 * Undoes a job, or one receiver of it: its live shares are marked undone;
 * queued and held pushes become dropped (note "undone"); share pushes still
 * pending, scoring or gathering that hold an undone share are cancelled (a
 * cancel that lands mid-gather wins, push-worker.mjs:576-584), the undone
 * shares in them are dropped and the other shares in them go back to queued;
 * tags written stay until the paced tag writer removes them. The whole job
 * becomes undone; a receiver's undo leaves the state and takes the receiver
 * off receivers_applied.
 *
 * @param {Pool} pool
 * @param {{ batchId: string, receiver: string | null, userId: string }} p
 * @returns {Promise<{ batchId: string, undone: number, tagsToRemove: number, cancelledPushes: string[], pushedLeads: number }>}
 */
export async function undoJob(pool, { batchId, receiver, userId }) {
  return inTx(pool, async (c) => {
    const { rows: [job] } = await c.query(`SELECT state, receivers FROM share_jobs WHERE batch_id = $1 FOR UPDATE`, [batchId]);
    if (!job) throw Object.assign(new Error("No such share job."), { status: 404 });
    if (!["previewed", "applied"].includes(job.state)) {
      throw Object.assign(new Error(job.state === "undone" ? "This job is undone already." : `This job is ${job.state}; only a previewed or applied job can be undone.`), { status: 409 });
    }
    if (receiver && !(job.receivers ?? []).includes(receiver)) {
      throw Object.assign(new Error(`${receiver} is not a receiver of this job.`), { status: 404 });
    }
    const { rows } = await c.query(
      `WITH u AS (
         SELECT id, push_state AS was FROM lead_shares
          WHERE batch_id = $1 AND ($2::text IS NULL OR receiver_tag = $2) AND outcome IN ${SHARING} AND undone_at IS NULL
          FOR UPDATE
       )
       UPDATE lead_shares s
          SET undone_at = now(), undone_by = $3,
              push_state = CASE WHEN u.was IN ('queued', 'held') THEN 'dropped' ELSE s.push_state END,
              push_note = CASE WHEN u.was IN ('queued', 'held') THEN 'undone' ELSE s.push_note END
         FROM u
        WHERE s.id = u.id
       RETURNING s.id, s.push_state, s.push_batch_id, s.tag_added, s.tag_removed_at`,
      [batchId, receiver, userId]
    );
    const tagsToRemove = rows.filter((r) => r.tag_added && !r.tag_removed_at).length;
    const pushIds = [...new Set(rows.filter((r) => r.push_state === "pushed" && r.push_batch_id).map((r) => r.push_batch_id))];
    let cancelled = [];
    if (pushIds.length) {
      ({ rows: cancelled } = await c.query(
        `UPDATE push_batches SET status = 'cancelled', completed_at = now(), error = 'Cancelled: shares in it were undone on the Sharing page'
          WHERE id = ANY($1::uuid[]) AND status IN ('pending', 'scoring', 'gathering') AND push_options ->> 'source' = ANY($2::text[])
         RETURNING id`,
        [pushIds, [...SHARE_PUSH_SOURCES]]
      ));
    }
    const cancelledIds = cancelled.map((r) => r.id);
    if (cancelledIds.length) {
      await c.query(
        `UPDATE lead_shares SET push_state = 'dropped', push_note = 'undone'
          WHERE push_batch_id = ANY($1::uuid[]) AND push_state = 'pushed' AND undone_at IS NOT NULL`,
        [cancelledIds]
      );
      await c.query(
        `UPDATE lead_shares SET push_state = 'queued', push_batch_id = NULL, pushed_at = NULL
          WHERE push_batch_id = ANY($1::uuid[]) AND push_state = 'pushed' AND undone_at IS NULL`,
        [cancelledIds]
      );
    }
    const gone = new Set(cancelledIds);
    const pushedLeads = rows.filter((r) => r.push_state === "pushed" && !gone.has(r.push_batch_id)).length;
    if (receiver) {
      await c.query(
        `UPDATE share_jobs SET receivers_applied = array_remove(receivers_applied, $2::text), receivers_over_cap = array_remove(receivers_over_cap, $2::text)
          WHERE batch_id = $1`,
        [batchId, receiver]
      );
    } else {
      await c.query(
        `UPDATE share_jobs SET state = 'undone', undone_at = now(), undone_by = $2, next_recheck_at = NULL WHERE batch_id = $1`,
        [batchId, userId]
      );
    }
    return { batchId, undone: rows.length, tagsToRemove, cancelledPushes: cancelledIds, pushedLeads };
  });
}

/**
 * Sends a job round again: a job in error, or one decided at its place wait
 * limit, goes back to waiting with a fresh limit, its receivers decided again
 * (its applied shares never change).
 *
 * @param {Pool} pool
 * @param {{ batchId: string, settings: PipelineSettings }} p
 * @returns {Promise<{ batchId: string, state: string }>}
 */
export async function retryJob(pool, { batchId, settings }) {
  return inTx(pool, async (c) => {
    const { rows: [job] } = await c.query(`SELECT state, place_wait_hit_at FROM share_jobs WHERE batch_id = $1 FOR UPDATE`, [batchId]);
    if (!job) throw Object.assign(new Error("No such share job."), { status: 404 });
    const waited = job.place_wait_hit_at != null && ["previewed", "applied"].includes(job.state);
    if (job.state !== "error" && !waited) {
      throw Object.assign(new Error(`This job is ${job.state}; only a job in error, or one that waited the place limit, can be sent round again.`), { status: 409 });
    }
    await c.query(
      `UPDATE share_jobs
          SET state = 'waiting', attempts = 0, last_error = NULL, next_try_at = now(), receivers_done = '{}',
              place_wait_hit_at = NULL, place_wait_until = now() + make_interval(mins => $2)
        WHERE batch_id = $1`,
      [batchId, settings.overlap_sharing.wait_location_minutes]
    );
    return { batchId, state: "waiting" };
  });
}

/** The receiver as the job knows it: trimmed and upper case, or null for every receiver. */
export function receiverOf(v) {
  if (v == null || v === "") return null;
  const t = normTag(v);
  return t || null;
}
