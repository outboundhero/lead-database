// What the Sharing page's routes ask of the share step: preview a job again,
// apply it, undo it, retry it (contract 5.2). The routes check the role and
// write the audit row; these functions do the work.
//
// Each function takes a pg Pool (it runs its own transactions, and keeps no
// worker state) and answers a plain object, or throws ShareActionError with
// the HTTP status and the reason in plain words. receiver null means every
// receiver of the job.
//
//   previewShareJob  decides a decided job again with the current rules and
//                    says, per receiver, the counts stored at the last decide
//                    and the counts now (an applied or undone share keeps its
//                    outcome), and whether applying would pass a push cap.
//                    Writes nothing.
//   applyShareJob    decides again, stores the new decision, then marks the
//                    shares applied in chunks, queuing their push when the
//                    receiver is on push_tags. An admin may apply a receiver
//                    over a cap. A receiver that may not take shares now is
//                    skipped, with the reason.
//   undoShareJob     marks the job's (or one receiver's) shares undone, drops
//                    their queued and held pushes, cancels share pushes not
//                    gathered yet, and says how many tags the paced writer will
//                    take off and how many leads were pushed already (taking
//                    them out of campaigns is a separate step).
//   retryShareJob    sends a job in error, or one decided at its place wait
//                    limit, round again.

import { flagOn } from "../enrich/settings.mjs";
import { inTx, isUnready, isUuid, read } from "./db.mjs";
import { decideLeads, Fenced, jobLeads, receiversByTag } from "./decide.mjs";
import {
  applyBlock, applyReceiver, capCheck, clientOf, decideUnits, listBlock, receiverOf, retryJob, settingsNow, undoJob, unitsOf,
} from "./jobs.mjs";

export class ShareActionError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "ShareActionError";
    this.status = status;
  }
}

/** The states a job can be previewed, applied or undone in. */
const DECIDED = ["previewed", "applied"];

/** Any failure as a ShareActionError, or the error itself when it is unexpected (the route answers 500). */
function asActionError(e) {
  if (e instanceof ShareActionError) return e;
  const status = /** @type {{ status?: unknown }} */ (e)?.status;
  if (typeof status === "number") return new ShareActionError(status, /** @type {Error} */ (e).message);
  if (isUnready(e)) return new ShareActionError(503, "Sharing is not set up in this database yet (migrations 133 and 134 are not applied).");
  if (e instanceof Fenced) return new ShareActionError(409, `The job changed meanwhile (it is ${e.state} now). Look at it again.`);
  return e;
}

/** Runs an action, turning known failures into ShareActionError. */
async function action(fn) {
  try {
    return await fn();
  } catch (e) {
    throw asActionError(e);
  }
}

async function loadJob(pool, batchId) {
  if (!isUuid(batchId)) throw new ShareActionError(400, "batchId must be a uuid.");
  const { rows: [job] } = await read(pool, `SELECT * FROM share_jobs WHERE batch_id = $1`, [batchId]);
  if (!job) throw new ShareActionError(404, "No such share job.");
  return job;
}

function needDecided(job, verb) {
  if (DECIDED.includes(job.state)) return;
  const why = job.state === "waiting" || job.state === "deciding"
    ? "it is still being decided"
    : job.state === "undone" ? "it is undone" : job.state === "error" ? "it is in error (retry it first)" : `it is ${job.state}`;
  throw new ShareActionError(409, `This job can't be ${verb}: ${why}.`);
}

/** The receiver asked for, which must be one of the job's; null for every receiver. */
function pickReceiver(job, receiver) {
  const r = receiverOf(receiver);
  if (r && !(job.receivers ?? []).includes(r)) throw new ShareActionError(404, `${r} is not a receiver of this job.`);
  return r;
}

async function originOf(pool, job) {
  const origin = await clientOf(pool, job.origin_tag);
  if (!origin) throw new ShareActionError(409, `${job.origin_tag ?? "The job's client"} is no longer a client, so the job can't be decided again.`);
  return origin;
}

/**
 * Decides a decided job again with the current rules and says what changed
 * since the preview, for the Apply confirm. Writes nothing.
 * @param {unknown} pool
 * @param {{ batchId: string, receiver?: string | null }} opts
 * @returns {Promise<{ batchId: string, receivers: Array<{ tag: string, before: Record<string, number>, now: Record<string, number>, overCap: boolean }> }>}
 */
export async function previewShareJob(pool, opts) {
  const db = /** @type {import("./db.mjs").Pool} */ (pool);
  return action(async () => {
    const job = await loadJob(db, opts?.batchId);
    needDecided(job, "previewed");
    const r = pickReceiver(job, opts?.receiver);
    const settings = await settingsNow(db);
    const origin = await originOf(db, job);
    const { placed } = await jobLeads(db, job.batch_id);
    const all = await receiversByTag(db, job.receivers ?? [], origin.tag);
    const chosen = [...all.values()].filter((x) => !r || x.tag === r);
    const pattern = settings.never_contact_inboxes?.pattern ?? null;
    /** @type {Map<string, Map<string, { outcome: string }>>} */
    const fresh = new Map();
    for (const unit of unitsOf(chosen)) {
      const now = new Set(unit.map((x) => x.tag));
      const others = [...all.values()].filter((x) => !now.has(x.tag)).map((x) => ({ tag: x.tag, group_no: x.group_no }));
      const open = unit.filter((x) => !listBlock(settings, x, origin));
      const results = await decideLeads(db, { batchId: job.batch_id, origin, leads: placed, receivers: open, others, pattern });
      for (const res of results) fresh.set(res.tag, res.decisions);
      for (const x of unit) if (!fresh.has(x.tag)) fresh.set(x.tag, new Map());
    }
    const { rows: fixed } = chosen.length
      ? await read(
          db,
          `SELECT receiver_tag, lead_id, outcome FROM lead_shares
            WHERE batch_id = $1 AND receiver_tag = ANY($2::text[]) AND (applied_at IS NOT NULL OR undone_at IS NOT NULL)`,
          [job.batch_id, chosen.map((x) => x.tag)]
        )
      : { rows: [] };
    const out = [];
    for (const x of chosen) {
      const kept = new Map(fixed.filter((f) => f.receiver_tag === x.tag).map((f) => [f.lead_id, f.outcome]));
      const decisions = fresh.get(x.tag) ?? new Map();
      /** @type {Record<string, number>} */
      const now = { checked: placed.length, fits: 0 };
      let toApply = 0;
      for (const id of new Set([...kept.keys(), ...decisions.keys()])) {
        const outcome = kept.get(id) ?? decisions.get(id)?.outcome;
        if (!outcome) continue;
        now[outcome] = (now[outcome] ?? 0) + 1;
        now.fits++;
        if (!kept.has(id) && (outcome === "shared" || outcome === "own_topup")) toApply++;
      }
      const push = flagOn(settings, "share_push", x.tag);
      const overCap = push && toApply > 0 ? (await capCheck(db, { batchId: job.batch_id, receiver: x.tag, settings, count: toApply })).over : false;
      out.push({ tag: x.tag, before: job.counts?.[x.tag] ?? {}, now, overCap });
    }
    return { batchId: job.batch_id, receivers: out };
  });
}

/**
 * Applies a job (or one receiver of it) by hand: decides again, then logs the
 * shares as applied, in chunks; queues their push when the receiver is on
 * push_tags. An admin may apply a receiver over a cap.
 * @param {unknown} pool
 * @param {{ batchId: string, receiver?: string | null, userId: string }} opts
 * @returns {Promise<{ batchId: string, applied: Record<string, number>, queued: Record<string, number>, skipped: Record<string, string> }>}
 */
export async function applyShareJob(pool, opts) {
  const db = /** @type {import("./db.mjs").Pool} */ (pool);
  return action(async () => {
    if (!isUuid(opts?.userId)) throw new ShareActionError(400, "userId must be a uuid.");
    const job = await loadJob(db, opts.batchId);
    const settings = await settingsNow(db);
    if (!settings.overlap_sharing.enabled) throw new ShareActionError(409, "Sharing is switched off, so nothing was applied.");
    needDecided(job, "applied");
    const r = pickReceiver(job, opts.receiver);
    const origin = await originOf(db, job);
    const { placed } = await jobLeads(db, job.batch_id);
    const all = await receiversByTag(db, job.receivers ?? [], origin.tag);
    const chosen = [...all.values()].filter((x) => !r || x.tag === r);
    /** @type {Record<string, number>} */
    const applied = {};
    /** @type {Record<string, number>} */
    const queued = {};
    /** @type {Record<string, string>} */
    const skipped = {};
    for (const tag of r ? [r] : job.receivers ?? []) if (!all.has(tag)) skipped[tag] = "not a client";
    const open = [];
    for (const x of chosen) {
      const why = applyBlock(settings, x, origin);
      if (why) skipped[x.tag] = why;
      else open.push(x);
    }
    await decideUnits(db, { batchId: job.batch_id, origin, leads: placed, receivers: open, all: [...all.values()], settings, states: DECIDED });
    for (const x of open) {
      const res = await applyReceiver(db, {
        batchId: job.batch_id, receiver: x.tag, userId: opts.userId, push: flagOn(settings, "share_push", x.tag), states: DECIDED,
      });
      applied[x.tag] = res.applied;
      queued[x.tag] = res.queued;
      if (res.blocked) skipped[x.tag] = `cannot receive: ${res.blocked}`;
    }
    await inTx(db, (c) =>
      c.query(
        `UPDATE share_jobs j
            SET state = CASE WHEN o.n = 0 THEN 'applied' ELSE 'previewed' END,
                applied_at = CASE WHEN o.n = 0 THEN now() ELSE j.applied_at END,
                applied_by = CASE WHEN o.n = 0 THEN $2::uuid ELSE j.applied_by END
           FROM (SELECT count(*)::int AS n FROM lead_shares
                  WHERE batch_id = $1 AND outcome IN ('shared', 'own_topup') AND applied_at IS NULL AND undone_at IS NULL) o
          WHERE j.batch_id = $1 AND j.state IN ('previewed', 'applied')`,
        [job.batch_id, opts.userId]
      )
    );
    return { batchId: job.batch_id, applied, queued, skipped };
  });
}

/**
 * Undoes a job (or one receiver of it): marks its shares undone, takes off
 * the tags it wrote (paced), cancels its share pushes not gathered yet, and
 * says how many leads were already pushed (taking them out of campaigns is a
 * separate step).
 * @param {unknown} pool
 * @param {{ batchId: string, receiver?: string | null, userId: string }} opts
 * @returns {Promise<{ batchId: string, undone: number, tagsToRemove: number, cancelledPushes: string[], pushedLeads: number }>}
 */
export async function undoShareJob(pool, opts) {
  const db = /** @type {import("./db.mjs").Pool} */ (pool);
  return action(async () => {
    if (!isUuid(opts?.userId)) throw new ShareActionError(400, "userId must be a uuid.");
    const job = await loadJob(db, opts.batchId);
    const r = pickReceiver(job, opts.receiver);
    return undoJob(db, { batchId: job.batch_id, receiver: r, userId: opts.userId });
  });
}

/**
 * Sends a job in error, or one that waited the place limit, round again.
 * @param {unknown} pool
 * @param {{ batchId: string, userId: string }} opts
 * @returns {Promise<{ batchId: string, state: string }>}
 */
export async function retryShareJob(pool, opts) {
  const db = /** @type {import("./db.mjs").Pool} */ (pool);
  return action(async () => {
    if (!isUuid(opts?.userId)) throw new ShareActionError(400, "userId must be a uuid.");
    const job = await loadJob(db, opts.batchId);
    const settings = await settingsNow(db);
    return retryJob(db, { batchId: job.batch_id, settings });
  });
}
