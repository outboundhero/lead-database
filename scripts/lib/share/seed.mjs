// The one-off seed for imports made before their batch could list its leads
// (plan 1.9, the first live test): scripts/share-seed.mjs runs it.
//
// seedPlan() reads, writes nothing. For each named batch it takes the leads
// created inside the batch's window (its created_at to its completed_at) that
// carry the origin's tag (exact, comma bounded, any case): the new leads that
// import made. When no lead falls in two batches' windows, each batch's count
// must be its inserted_rows, and each batch gets its own list and job. When
// the windows overlap (files imported at the same time), the leads of all the
// windows together must be the batches' inserted_rows added up, and they are
// listed under the first batch named, which gets the one job. Any other
// difference stops the plan: nothing may be written.
//
// seedWrite() writes, in one transaction, only what the plan says: the leads
// into upload_batch_leads (outcome new) and the share job(s), forced to
// preview (mode preview, state waiting). The share step then waits for places
// and decides each job like any other; it never applies a preview job by
// itself. Nothing else is written: no lead, no tag, no push.

import { clientPool, flagOn, normTag } from "../enrich/settings.mjs";
import { DEAD_BATCH_HOURS } from "../overlap-topup.mjs";
import { inTx, isUuid, read, tagTestSql } from "./db.mjs";
import { PLACED } from "./decide.mjs";
import { settingsNow } from "./jobs.mjs";

/**
 * @typedef {import("./db.mjs").Pool} Pool
 * @typedef {{ id: string, filename: string | null, status: string, created_at: Date, completed_at: Date | null,
 *             inserted_rows: number, done_at: Date, ids: string[], placed: number }} SeedBatch
 * @typedef {{ origin: string, pool: string | null, onList: boolean, batches: SeedBatch[], found: number, distinct: number,
 *             expected: number, together: boolean, writes: Array<{ batchId: string, doneAt: Date, ids: string[] }>,
 *             problems: string[], ok: boolean }} SeedPlan
 *   together: the windows overlap, so every lead goes to the first batch's one job
 */

/**
 * @param {Pool} pool
 * @param {{ tag: string, batchIds: string[] }} p
 * @returns {Promise<SeedPlan>}
 */
export async function seedPlan(pool, { tag, batchIds }) {
  const origin = normTag(tag);
  const problems = [];
  const empty = { origin, pool: null, onList: false, batches: [], found: 0, distinct: 0, expected: 0, together: false, writes: [] };
  if (!origin) problems.push("no origin tag given (--tag)");
  const ids = [...new Set(batchIds ?? [])];
  if (!ids.length) problems.push("no batch given (--batch)");
  for (const id of ids) if (!isUuid(id)) problems.push(`${id} is not a batch id`);
  if (problems.length) return { ...empty, problems, ok: false };

  const settings = await settingsNow(pool);
  const { rows: [client] } = await read(pool, `SELECT tag, client_type FROM client_tags WHERE tag = $1`, [origin]);
  if (!client) problems.push(`${origin} is not a client tag`);
  const { rows: found } = await read(
    pool,
    `SELECT b.id, b.filename, b.status, b.batch_type, b.field_mapping IS NOT NULL AS mapped, b.created_at, b.completed_at,
            coalesce(b.inserted_rows, 0)::int AS inserted_rows,
            coalesce(b.completed_at, CASE WHEN b.status = 'processing' THEN b.created_at + make_interval(hours => $2) ELSE now() END) AS done_at,
            (b.status IN ('complete', 'error') OR (b.status = 'processing' AND b.created_at < now() - make_interval(hours => $2))) AS finished,
            (SELECT s.state FROM share_jobs s WHERE s.batch_id = b.id) AS job,
            (SELECT count(*) FROM upload_batch_leads u WHERE u.batch_id = b.id)::int AS listed
       FROM upload_batches b WHERE b.id = ANY($1::uuid[])`,
    [ids, DEAD_BATCH_HOURS]
  );
  const byId = new Map(found.map((b) => [b.id, b]));
  /** @type {SeedBatch[]} */
  const batches = [];
  for (const id of ids) {
    const b = byId.get(id);
    if (!b) {
      problems.push(`batch ${id} does not exist`);
      continue;
    }
    if (b.batch_type !== "leads" || !b.mapped) problems.push(`batch ${id} is not a leads import with a field mapping`);
    if (!b.finished) problems.push(`batch ${id} has not finished (${b.status})`);
    if (b.job) problems.push(`batch ${id} has a share job already (${b.job})`);
    if (b.listed) problems.push(`batch ${id} lists ${b.listed} lead(s) already`);
    // The new leads of this import: made inside its window, with the origin's tag.
    const { rows } = await read(
      pool,
      `SELECT l.id, coalesce(${PLACED}, false) AS placed FROM public.leads l
        WHERE l.created_at >= $1::timestamptz AND l.created_at <= $2::timestamptz AND ${tagTestSql("l", "$3")}`,
      [b.created_at, b.done_at, origin]
    );
    batches.push({
      id, filename: b.filename, status: b.status, created_at: b.created_at, completed_at: b.completed_at, inserted_rows: b.inserted_rows,
      done_at: b.done_at, ids: rows.map((r) => r.id), placed: rows.filter((r) => r.placed).length,
    });
  }
  const foundN = batches.reduce((s, b) => s + b.ids.length, 0);
  const all = [...new Set(batches.flatMap((b) => b.ids))];
  const expected = batches.reduce((s, b) => s + b.inserted_rows, 0);
  const together = all.length !== foundN;
  let writes = [];
  if (together) {
    if (all.length !== expected) problems.push(`the windows overlap: ${all.length} lead(s) found in all of them, but the batches inserted ${expected}`);
    const first = batches[0];
    if (first) writes = [{ batchId: first.id, doneAt: new Date(Math.max(...batches.map((b) => new Date(b.done_at).getTime()))), ids: all }];
  } else {
    for (const b of batches) {
      if (b.ids.length !== b.inserted_rows) problems.push(`batch ${b.id}: ${b.ids.length} lead(s) found, but it inserted ${b.inserted_rows}`);
    }
    writes = batches.map((b) => ({ batchId: b.id, doneAt: b.done_at, ids: b.ids }));
  }
  return {
    origin,
    pool: client ? clientPool(settings, origin, client.client_type) : null,
    onList: flagOn(settings, "overlap_sharing", origin),
    batches, found: foundN, distinct: all.length, expected, together, writes, problems,
    ok: problems.length === 0 && batches.length > 0,
  };
}

/**
 * Writes a good plan: the leads into upload_batch_leads (outcome new) and the
 * share job(s), forced to preview. One transaction; nothing else.
 *
 * @param {Pool} pool
 * @param {SeedPlan} plan
 * @returns {Promise<{ listed: number, jobs: number }>}
 */
export async function seedWrite(pool, plan) {
  if (!plan.ok) throw new Error(`the plan is not good: ${plan.problems.join("; ")}`);
  const settings = await settingsNow(pool);
  return inTx(pool, async (c) => {
    let listed = 0;
    let jobs = 0;
    for (const w of plan.writes) {
      const { rowCount: n } = await c.query(
        `INSERT INTO upload_batch_leads (batch_id, lead_id, outcome) SELECT $1, unnest($2::uuid[]), 'new' ON CONFLICT DO NOTHING`,
        [w.batchId, w.ids]
      );
      listed += n ?? 0;
      const { rowCount: j } = await c.query(
        `INSERT INTO share_jobs (batch_id, origin_tag, origin_pool, state, mode, batch_done_at, place_wait_until, new_leads)
         VALUES ($1, $2, $3, 'waiting', 'preview', $4::timestamptz, $4::timestamptz + make_interval(mins => $5), $6)
         ON CONFLICT (batch_id) DO NOTHING`,
        [w.batchId, plan.origin, plan.pool, w.doneAt, settings.overlap_sharing.wait_location_minutes, w.ids.length]
      );
      jobs += j ?? 0;
    }
    return { listed, jobs };
  }, { timeout: "120s" });
}
