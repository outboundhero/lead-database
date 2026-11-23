// Question jobs (139): the enrich-worker's step that writes a question
// variable for the leads a person is about to push (scripts/enrich-worker.mjs
// calls questionStep once per loop, not awaited, with a busy flag).
//
// One open job at a time per step, oldest first (paused jobs last, each looked
// at again at most once a minute). The job is claimed with a claim token; a
// claim older than 10 minutes is stale and any worker takes the job over. The
// token is given back at the end of every step, so the next step (of this
// worker or another) claims afresh.
//
// A job goes queued -> gathering -> running -> done, or paused, error or
// cancelled:
//   - before anything, the variable must exist and not be archived, and
//     question variables must be on for the job's client (questionSwitchOn);
//     otherwise the job is paused, with the reason as its note, and resumes by
//     itself once the reason is gone (a resumed job carries on where it was);
//   - gathering snapshots the leads (gather.mjs gatherJob), free; a gather cut
//     short is run again from the start (its inserts are idempotent);
//   - running works one slice per step: up to concurrency * 5 items are
//     claimed (pending ones, or working ones whose claim is over 10 minutes
//     old), and written `concurrency` at a time (writer.mjs writeLead). Before
//     a slice the worker needs OPENAI_API_KEY, a research and a question model,
//     a research prompt and today's budget; the writer checks the budget again
//     before every call. Anything that stops a slice (the budget, a key or
//     billing refusal) puts its unwritten items back to pending, with the try
//     not counted, and pauses the job with the reason;
//   - a lead whose answer was lost (no answer, a 429 or a 5xx, an answer that
//     isn't valid JSON) is tried again in a later slice, 3 tries in all; then
//     its value row is an error with the reason;
//   - a cancelled job's items are left as they are; a slice under way finishes
//     the lead it is on and stops.

import { randomUUID } from "node:crypto";
import { readSettings } from "../enrich/settings.mjs";
import { loadQuestionSettings, questionSwitchOn } from "./settings.mjs";
import { COMPANY_KEY_SQL, gatherJob, inTx } from "./gather.mjs";
import { loadServiceArea } from "./service-area.mjs";
import { budgetAllows, NOTES, questionModelOf, researchModelOf, storeValue, writeLead } from "./writer.mjs";
import { copyTag } from "./names.mjs";

/** What the worker's heartbeat says when it runs question jobs; the routes refuse a job without it. */
export { QUESTION_JOBS_CAPABILITY } from "./capability.mjs";
export const STALE_MINUTES = 10;
export const PAUSED_RECHECK_SECONDS = 60;
export const MAX_ATTEMPTS = 3;
export const OPEN_STATUSES = Object.freeze(["queued", "gathering", "running", "paused"]);

// Errors a gather may meet under load and get past on its next try: a
// statement timeout, a dropped connection, a deadlock, a serialization
// failure, too many connections.
const TRANSIENT = /^(57014|08\w{3}|40001|40P01|53\w{3})$/;

/**
 * @typedef {import("./gather.mjs").Db} Db
 * @typedef {{ connect: () => Promise<Db & { release: () => void }>, query: Db["query"] }} Pool
 * @typedef {{ fetch?: typeof fetch, env?: Record<string, string | undefined>, log?: (m: string) => void, now?: () => number,
 *   shouldStop?: () => boolean }} StepDeps
 */

/**
 * Claims the next open job: oldest first, paused ones after the others and at
 * most once a minute, a claim older than STALE_MINUTES taken over.
 * @param {Db} db
 * @param {string} token
 */
export async function claimJob(db, token) {
  const { rows: [job] } = await db.query(
    `UPDATE question_jobs j
        SET claim_token = $1, claimed_at = now()
      WHERE j.id = (
        SELECT q.id FROM question_jobs q
         WHERE q.status IN ('queued', 'gathering', 'running', 'paused')
           AND (q.claim_token IS NULL OR q.claimed_at < now() - make_interval(mins => $2))
           AND (q.status <> 'paused' OR q.claimed_at IS NULL OR q.claimed_at < now() - make_interval(secs => $3))
         ORDER BY (q.status = 'paused'), q.created_at, q.id
         LIMIT 1
           FOR UPDATE SKIP LOCKED)
      RETURNING j.*`,
    [token, STALE_MINUTES, PAUSED_RECHECK_SECONDS]
  );
  return job ?? null;
}

/** Gives the claim back (fenced on the token: a job taken over meanwhile is left alone). */
export async function releaseJob(db, jobId, token) {
  await db.query(`UPDATE question_jobs SET claim_token = NULL WHERE id = $1 AND claim_token = $2`, [jobId, token]);
}

/** Sets a claimed job's status, fenced on the claim and on the statuses it may come from. */
async function setJob(db, job, token, status, { from, note = null, error = null, started = false, done = false } = {}) {
  const { rowCount } = await db.query(
    `UPDATE question_jobs
        SET status = $3, note = $4, error = $5,
            started_at = CASE WHEN $6::boolean THEN coalesce(started_at, now()) ELSE started_at END,
            completed_at = CASE WHEN $7::boolean THEN now() ELSE completed_at END
      WHERE id = $1 AND claim_token = $2 AND status = ANY($8::text[])`,
    [job.id, token, status, note, error, started, done, from ?? OPEN_STATUSES]
  );
  if (rowCount) Object.assign(job, { status, note, error });
  return rowCount > 0;
}

/** Pauses a claimed job with its reason (the note), unless a person cancelled it meanwhile. */
const pause = (db, job, token, note) => setJob(db, job, token, "paused", { note });

/** Adds an item's outcome to the job's counters. */
async function count(db, jobId, { done = 0, failed = 0, skipped = 0, researched = 0, usd = 0 }) {
  if (!done && !failed && !skipped && !researched && !usd) return;
  await db.query(
    `UPDATE question_jobs
        SET done = done + $2, failed = failed + $3, skipped = skipped + $4, researched = researched + $5,
            spend_usd = spend_usd + $6::numeric
      WHERE id = $1`,
    [jobId, done, failed, skipped, researched, String(Math.max(0, usd))]
  );
}

/** Claims a slice of the job's items: pending ones, or working ones whose claim is stale. */
export async function claimItems(db, jobId, token, n) {
  const { rows } = await db.query(
    `UPDATE question_job_items i
        SET status = 'working', claim_token = $2, claimed_at = now(), attempts = i.attempts + 1
      WHERE (i.job_id, i.lead_id) IN (
        SELECT q.job_id, q.lead_id FROM question_job_items q
         WHERE q.job_id = $1
           AND (q.status = 'pending' OR (q.status = 'working' AND q.claimed_at < now() - make_interval(mins => $4)))
         LIMIT $3
           FOR UPDATE SKIP LOCKED)
      RETURNING i.lead_id, i.attempts`,
    [jobId, token, n, STALE_MINUTES]
  );
  return rows;
}

/** An item's end, fenced on its claim. "pending" gives it back without counting the try. */
async function settleItem(db, jobId, leadId, token, status) {
  await db.query(
    `UPDATE question_job_items
        SET status = $4, claim_token = NULL,
            attempts = CASE WHEN $4 = 'pending' THEN greatest(attempts - 1, 0) ELSE attempts END
      WHERE job_id = $1 AND lead_id = $2 AND claim_token = $3`,
    [jobId, leadId, token, status]
  );
}

/** Marks a running job done once no item is left to write. */
async function finishIfDone(db, job, token) {
  const { rowCount } = await db.query(
    `UPDATE question_jobs j
        SET status = 'done', completed_at = now(), note = NULL
      WHERE j.id = $1 AND j.claim_token = $2 AND j.status = 'running'
        AND NOT EXISTS (SELECT 1 FROM question_job_items i WHERE i.job_id = j.id AND i.status IN ('pending', 'working'))`,
    [job.id, token]
  );
  if (rowCount) job.status = "done";
  return rowCount > 0;
}

async function runPool(list, limit, fn) {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (next < list.length) await fn(list[next++]);
  });
  await Promise.all(lanes);
}

/**
 * One step: claims the next open job and gathers it, or writes one slice of
 * it. Never leaves a claim behind. Answers whether it worked (gathered or
 * wrote something), so the worker can wait a little when it didn't.
 * @param {Pool} pool
 * @param {StepDeps} [deps]
 * @returns {Promise<{ worked: boolean, jobId: string | null, status?: string, note?: string | null, written?: number }>}
 */
export async function questionStep(pool, deps = {}) {
  const d = {
    fetch: deps.fetch ?? globalThis.fetch,
    env: deps.env ?? process.env,
    log: deps.log ?? (() => {}),
    now: deps.now ?? Date.now,
    shouldStop: deps.shouldStop ?? (() => false),
  };
  const token = randomUUID();
  const job = await claimJob(pool, token);
  if (!job) return { worked: false, jobId: null };
  try {
    const worked = await stepJob(pool, job, token, d);
    return { worked: worked.worked, written: worked.written ?? 0, jobId: job.id, status: job.status, note: job.note ?? null };
  } finally {
    await releaseJob(pool, job.id, token).catch((e) => d.log(`question job ${job.id}: could not give back its claim: ${e.message}`));
  }
}

async function stepJob(pool, job, token, d) {
  const { rows: [variable] } = await pool.query(`SELECT * FROM question_variables WHERE id = $1`, [job.variable_id]);
  if (!variable) {
    await setJob(pool, job, token, "error", { error: "Its variable no longer exists", done: true });
    return { worked: false };
  }
  const qs = await loadQuestionSettings(pool);
  const blocked = variable.archived_at
    ? NOTES.archived(variable.name)
    : !questionSwitchOn(qs, job.client_tag)
      ? NOTES.switchOff(job.client_tag)
      : null;
  if (blocked) {
    if (job.status !== "paused" || job.note !== blocked) await pause(pool, job, token, blocked);
    return { worked: false };
  }

  if (job.status === "paused") {
    // A job that was gathered carries on writing; one that wasn't gathers again from the start.
    const next = Number(job.total) > 0 ? "running" : "gathering";
    if (next === "running") {
      const why = await sliceBlocker(pool, variable, qs, d);
      if (why) {
        if (job.note !== why) await pause(pool, job, token, why);
        return { worked: false };
      }
    }
    if (!(await setJob(pool, job, token, next, { from: ["paused"] }))) return { worked: false };
    d.log(`question job ${job.id} (${job.client_tag}, ${copyTag(variable.name)}): resumed`);
  }

  if (job.status === "queued" || job.status === "gathering") return gather(pool, job, token, variable, d);
  if (job.status === "running") return slice(pool, job, token, variable, qs, d);
  return { worked: false };
}

/** Why a slice can't start now, or null. */
async function sliceBlocker(pool, variable, qs, d) {
  if (!String(d.env.OPENAI_API_KEY ?? "").trim()) return NOTES.noKey;
  const settings = await readSettings(pool);
  if (!researchModelOf(qs, settings) || !questionModelOf(qs, settings)) return NOTES.noModel;
  if (!String(variable.research_prompt ?? "").trim()) return NOTES.noResearchPrompt(variable.name);
  if (!(await budgetAllows(pool, qs)).ok) return NOTES.budget;
  return null;
}

async function gather(pool, job, token, variable, d) {
  if (!(await setJob(pool, job, token, "gathering", { from: ["queued", "gathering"], started: true }))) return { worked: false };
  const t0 = d.now();
  let g;
  try {
    g = await gatherJob(pool, job, variable, { shouldStop: d.shouldStop });
  } catch (e) {
    const err = /** @type {any} */ (e);
    const msg = String(err?.message ?? err).split("\n")[0].slice(0, 300);
    if (TRANSIENT.test(String(err?.code ?? ""))) {
      await setJob(pool, job, token, "gathering", { from: ["gathering"], note: `Gathering is tried again: ${msg}` });
      d.log(`question job ${job.id}: gather failed, tried again next step: ${msg}`);
    } else {
      await setJob(pool, job, token, "error", { from: ["gathering"], error: `Gathering failed: ${msg}`, done: true });
      d.log(`question job ${job.id}: gather failed: ${msg}`);
    }
    return { worked: true };
  }
  if (g.stopped) return { worked: true };
  const { rows: [r] } = await inTx(pool, (c) =>
    c.query(
      `UPDATE question_jobs j
          SET total = s.total, companies = s.companies,
              status = CASE WHEN s.total = 0 THEN 'done' ELSE 'running' END,
              completed_at = CASE WHEN s.total = 0 THEN now() ELSE NULL END,
              note = CASE WHEN s.total > 0 THEN NULL
                          WHEN $3::int = 0 THEN 'The selection holds no lead a push would send'
                          ELSE 'Every lead of the selection already has a current value' END
         FROM (SELECT count(*)::int AS total, count(DISTINCT ${COMPANY_KEY_SQL})::int AS companies
                 FROM question_job_items i LEFT JOIN leads l ON l.id = i.lead_id
                WHERE i.job_id = $1) s
        WHERE j.id = $1 AND j.claim_token = $2 AND j.status = 'gathering'
        RETURNING j.status, j.total, j.companies, j.note`,
      [job.id, token, g.seen]
    )
  );
  if (r) Object.assign(job, r);
  d.log(`question job ${job.id} (${job.client_tag}, ${copyTag(variable.name)}): gathered ${r?.total ?? 0} lead(s) of ${g.seen} in the selection, ` +
    `${r?.companies ?? 0} companies (${Math.round((d.now() - t0) / 100) / 10}s)`);
  return { worked: true };
}

async function slice(pool, job, token, variable, qs, d) {
  const why = await sliceBlocker(pool, variable, qs, d);
  if (why) {
    await pause(pool, job, token, why);
    return { worked: false };
  }
  const settings = await readSettings(pool);
  const itemToken = randomUUID();
  const items = await claimItems(pool, job.id, itemToken, Math.max(1, qs.concurrency) * 5);
  if (!items.length) {
    await finishIfDone(pool, job, token);
    return { worked: false };
  }
  const ids = items.map((i) => i.lead_id);
  const { rows: leadRows } = await pool.query(
    `SELECT l.id, l.email, l.email_type, l.first_name, l.title, l.company, l.domain, l.city, l.state,
            l.category, l.subcategory, l.additional_category, ${COMPANY_KEY_SQL} AS company_key
       FROM leads l WHERE l.id = ANY($1::uuid[])`,
    [ids]
  );
  const leads = new Map(leadRows.map((l) => [l.id, l]));
  const { rows: valueRows } = await pool.query(
    `SELECT lead_id, status, prompt_version FROM lead_question_values WHERE variable_id = $1 AND lead_id = ANY($2::uuid[])`,
    [variable.id, ids]
  );
  const existing = new Map(valueRows.map((v) => [v.lead_id, v]));
  const serviceArea = await loadServiceArea(pool, job.client_tag);
  const memo = new Map();
  const deps = { db: pool, fetch: d.fetch, env: d.env, log: d.log, now: d.now };
  let stopNote = null;
  let closed = false;
  let written = 0;

  await runPool(items, Math.max(1, qs.concurrency), async (item) => {
    try {
      if (stopNote || closed || d.shouldStop()) {
        await settleItem(pool, job.id, item.lead_id, itemToken, "pending");
        return;
      }
      const { rows: [now] } = await pool.query(`SELECT status FROM question_jobs WHERE id = $1`, [job.id]);
      if (now?.status !== "running") {
        closed = true; // cancelled (or paused by another worker): this slice stops here
        await settleItem(pool, job.id, item.lead_id, itemToken, "pending");
        return;
      }
      const out = await writeLead(deps, {
        job, variable, lead: leads.get(item.lead_id), existing: existing.get(item.lead_id), qs, settings, serviceArea, memo,
      });
      const usd = Number(out.cost) || 0;
      if (out.kind === "stop") {
        stopNote = stopNote ?? out.note;
        await settleItem(pool, job.id, item.lead_id, itemToken, "pending");
        await count(pool, job.id, { researched: out.researched, usd });
        return;
      }
      if (out.kind === "failed") {
        if (out.again && Number(item.attempts) < MAX_ATTEMPTS) {
          // The try counts: the lead is worked again in a later slice.
          await pool.query(
            `UPDATE question_job_items SET status = 'pending', claim_token = NULL WHERE job_id = $1 AND lead_id = $2 AND claim_token = $3`,
            [job.id, item.lead_id, itemToken]
          );
          await count(pool, job.id, { researched: out.researched, usd });
          return;
        }
        await storeValue(pool, out.row);
        await settleItem(pool, job.id, item.lead_id, itemToken, "error");
        await count(pool, job.id, { failed: 1, researched: out.researched, usd });
        return;
      }
      if (out.row) await storeValue(pool, out.row);
      await settleItem(pool, job.id, item.lead_id, itemToken, out.kind);
      if (out.kind === "done") written++;
      await count(pool, job.id, {
        done: out.kind === "done" ? 1 : 0,
        failed: out.kind === "error" ? 1 : 0,
        skipped: out.kind === "skipped" ? 1 : 0,
        researched: out.researched,
        usd,
      });
    } catch (e) {
      // A database error on one lead: its claim goes stale and a later slice takes it again.
      d.log(`question job ${job.id}: lead ${item.lead_id}: ${/** @type {Error} */ (e).message}`);
    }
  });

  if (stopNote) {
    await pause(pool, job, token, stopNote);
    d.log(`question job ${job.id} (${job.client_tag}): paused, ${stopNote}`);
  } else if (!closed) {
    await finishIfDone(pool, job, token);
  }
  return { worked: true, written };
}
