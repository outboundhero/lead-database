// Pushes wait for scoring, and the push-time check (2B.7). Shipped OFF: all of
// it acts only while the fit gate applies to the batch's client
// (fn_fit_gate_applies: the gate on, the client's type listed, its tag on
// fit_gate.tags) and fit_gate.require_scored is true. Otherwise a push is
// exactly as it was.
//
//   - A gated client's push is queued in 'scoring' (the push-batch route and
//     scripts/queue-repush.mts ask scoringStatusFor). The push-worker gathers
//     'pending' batches only, so it never sees it.
//   - advanceScoringBatch (the enrich-worker's fit loop) pages the batch's
//     candidate leads with the gather's own conditions, queues every company
//     with no score at priority 1, and sets the batch to 'pending' once they
//     are all scored or unscorable, fenced on status = 'scoring' so a cancel
//     wins. An owner or admin can release it unscored (releaseScoringBatch);
//     the push-time check still skips the unscored companies then.
//   - The push-time check (scripts/push-worker.mjs, its per-tag final gate):
//     the same per-tag statement also says which leads' company has no score
//     under any of its keys, or no key at all; those items are skipped and
//     their companies queued at priority 1.
//
// Plain JavaScript, so the push-worker, the enrich-worker, the routes and the
// tests share it.

import { randomUUID } from "node:crypto";
import { enqueueCompanies } from "./fit-score.mjs";
import { keysFromRow, leadFitKeySql } from "./fit-keys.mjs";

/** The push-worker's base gate (push-worker.mjs ELIGIBLE), the same text. */
export const ELIGIBLE =
  `l.email is not null and l.email <> '' and l.is_bounced = false ` +
  `and (l.validation_status in ('valid','catch_all') or l.validation_status is null)`;

/** How many leads a page of a waiting push holds (the push-worker's GATHER_CHUNK). */
export const SCORING_PAGE = 5000;
/** A waiting push keeps the keys it queued, up to this many, to count "N of M companies scored". */
export const SCORING_KEYS_MAX = 50_000;
const CLAIM_STALE_MIN = 15;

/** The reasons a push item is skipped by the push-time check. */
export const FIT_SKIP = Object.freeze({
  unscored: "company not scored yet",
  nokey: "no company key to score",
});

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 */

/** undefined_function or undefined_table: migration 126 or 127 is not applied, so the gate cannot be on. */
const notApplied = (e) => e?.code === "42883" || e?.code === "42P01";

/**
 * Does the push-time check apply to this client? The gate applies to it and
 * require_scored is on. False when migration 126 is not applied (the gate
 * cannot be on then).
 *
 * @param {Db} db
 * @param {string | null | undefined} tag
 * @returns {Promise<boolean>}
 */
export async function fitCheckOn(db, tag) {
  if (!tag) return false;
  try {
    const { rows } = await db.query(
      `SELECT public.fn_fit_gate_applies($1)
              AND coalesce((public.fn_fit_gate_settings()->>'require_scored')::boolean, true) AS on`,
      [tag]
    );
    return rows[0]?.on === true;
  } catch (e) {
    if (notApplied(e)) return false;
    throw e;
  }
}

/**
 * The status a new push batch of this client starts in: 'scoring' while the
 * push-time check applies to it, else 'pending' (exactly as before).
 *
 * @param {Db} db
 * @param {string | null | undefined} tag
 * @returns {Promise<"scoring" | "pending">}
 */
export async function scoringStatusFor(db, tag) {
  return (await fitCheckOn(db, tag)) ? "scoring" : "pending";
}

/**
 * Is the gate switched on (fit_gate.enabled), for any client? The closures
 * that have no client (tagless pushes, the legacy push route, exports) read
 * this. False when migration 126 is not applied.
 *
 * @param {Db} db
 * @returns {Promise<boolean>}
 */
export async function gateEnabled(db) {
  try {
    const { rows } = await db.query(`SELECT coalesce((public.fn_fit_gate_settings()->>'enabled')::boolean, false) AS on`);
    return rows[0]?.on === true;
  } catch (e) {
    if (notApplied(e)) return false;
    throw e;
  }
}

/**
 * The push-worker's per-tag statement. With fitCheck false it is exactly the
 * statement the push-worker ran before (only the ids that pass the client's
 * conditions). With it, every lead id passing the conditions also says
 * whether its company has a score: fit is 'nokey' (no key at all), 'unscored'
 * (no key of it in company_fit_keys) or null (scored).
 *
 * @param {string} where  the client's conditions joined with " and "
 * @param {boolean} fitCheck
 * @returns {string}
 */
export function eligibilitySql(where, fitCheck) {
  if (!fitCheck) return `select l.id from leads l where l.id = any($1::uuid[]) and ${where}`;
  const k = leadFitKeySql("l");
  return `select x.id,
                 case when x.ek is null and x.wk is null and x.nk is null then 'nokey'
                      when not exists (select 1 from company_fit_keys k
                                        where (k.key_kind = 'domain' and k.key in (x.ek, x.wk))
                                           or (k.key_kind = 'name' and k.key = x.nk)) then 'unscored'
                 end as fit
            from (select l.id, ${k.email_key} as ek, ${k.website_key} as wk, ${k.name_key} as nk
                    from leads l where l.id = any($1::uuid[]) and ${where}) x`;
}

/**
 * Queues the companies of these leads for the scorer, those not scored yet,
 * with their facts (name, domain, place, industry, size and up to 5 titles of
 * their leads) and their aliases. Leads with no key are left out.
 *
 * @param {Db} db
 * @param {string[]} leadIds
 * @param {{ priority?: number, source?: string }} [opts]
 * @returns {Promise<{ keys: Array<{ key_kind: string, key: string }>, queued: number, nokey: number }>}
 */
export async function enqueueLeadCompanies(db, leadIds, { priority = 1, source = "push" } = {}) {
  const ids = [...new Set(leadIds ?? [])];
  if (!ids.length) return { keys: [], queued: 0, nokey: 0 };
  const k = leadFitKeySql("l");
  const { rows } = await db.query(
    `SELECT l.id, l.company, l.city, coalesce(l.state_code, l.state) AS state, l.domain, l.title,
            coalesce(l.general_industry, l.category) AS industry, l.company_size,
            ${k.email_key} AS email_key, ${k.website_key} AS website_key, ${k.name_key} AS name_key
       FROM leads l WHERE l.id = ANY($1::uuid[])`,
    [ids]
  );
  const byKey = new Map();
  let nokey = 0;
  for (const r of rows) {
    const key = keysFromRow(r);
    if (!key) {
      nokey++;
      continue;
    }
    const id = `${key.key_kind}:${key.key}`;
    const c = byKey.get(id) ?? { key_kind: key.key_kind, key: key.key, aliases: [], titles: new Set(), facts: null };
    c.aliases.push(...key.aliases);
    if (r.title) c.titles.add(r.title);
    c.facts ??= {
      name: r.company, domain: r.email_key ?? r.website_key ?? r.domain, city: r.city, state: r.state,
      industry: r.industry, employees: r.company_size == null ? "" : String(r.company_size),
    };
    byKey.set(id, c);
  }
  const items = [...byKey.values()].map((c) => ({
    key_kind: c.key_kind, key: c.key, aliases: c.aliases, priority, source,
    facts: { ...c.facts, titles: [...c.titles].slice(0, 5) },
  }));
  const { queued } = await enqueueCompanies(db, items, { skip: "unscored" });
  return { keys: items.map((i) => ({ key_kind: i.key_kind, key: i.key })), queued, nokey };
}

/** The WHERE of a batch's candidate leads, as the push-worker's gather builds it, plus the client's conditions. */
async function candidateWhere(db, batch) {
  const parts = [];
  if (batch.selected_ids?.length) {
    parts.push(`l.id = any($SEL::uuid[])`);
  } else {
    const { rows: [c] } = await db.query(`select fn_lead_filter_conditions($1::jsonb) as conds`, [JSON.stringify(batch.filters ?? {})]);
    parts.push(...(c?.conds ?? []));
  }
  parts.push(ELIGIBLE);
  if (batch.client_tag) {
    const { rows: [e] } = await db.query(`select fn_client_eligibility_conditions($1) as conds`, [batch.client_tag]);
    parts.push(...(e?.conds ?? []));
  }
  return parts.join(" and ");
}

/** How many of these keys have a score now (any key in company_fit_keys). */
async function countScored(db, keys) {
  if (!keys.length) return 0;
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM jsonb_to_recordset($1::jsonb) AS x(key_kind text, key text)
      WHERE EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.key_kind = x.key_kind AND k.key = x.key)`,
    [JSON.stringify(keys)]
  );
  return r.n;
}

/**
 * One step of one push waiting in 'scoring' (2B.7): a page of its candidate
 * leads (5,000, by l.id), their unscored companies queued at priority 1; when
 * the pages are done, the batch goes to 'pending' as soon as every company it
 * queued has a score (scored or unscorable), fenced on status = 'scoring' so a
 * cancel wins. Returns the batch id it worked, or null.
 *
 * @param {{ pool: Db, log?: (m: string) => void }} p
 * @returns {Promise<string | null>}
 */
export async function advanceScoringBatch({ pool, log = () => {} }) {
  const token = randomUUID();
  let batch;
  try {
    ({ rows: [batch] } = await pool.query(
      `UPDATE push_batches b SET fit_claim_token = $1, fit_claimed_at = now()
        WHERE b.id = (
          SELECT g.id FROM push_batches g
           WHERE g.status = 'scoring'
             AND (g.fit_claim_token IS NULL OR g.fit_claimed_at < now() - make_interval(mins => $2))
           ORDER BY g.created_at
           LIMIT 1
             FOR UPDATE SKIP LOCKED)
        RETURNING b.*`,
      [token, CLAIM_STALE_MIN]
    ));
  } catch (e) {
    if (notApplied(e) || e?.code === "42703") return null; // 127 not applied: no batch can be scoring
    throw e;
  }
  if (!batch) return null;
  const cursor = batch.fit_cursor && typeof batch.fit_cursor === "object" ? batch.fit_cursor : {};
  const keys = Array.isArray(cursor.keys) ? cursor.keys : [];
  const letGo = () =>
    pool.query(`UPDATE push_batches SET fit_claim_token = NULL WHERE id = $1 AND fit_claim_token = $2`, [batch.id, token]);
  try {
    if (cursor.done !== true) {
      const where = await candidateWhere(pool, batch);
      const params = [];
      let sql = `select l.id from leads l where ${where.replace("$SEL", "$1")}`;
      if (batch.selected_ids?.length) params.push(batch.selected_ids);
      if (cursor.last_id) {
        params.push(cursor.last_id);
        sql += ` and l.id > $${params.length}`;
      }
      params.push(SCORING_PAGE);
      sql += ` order by l.id limit $${params.length}`;
      const { rows: page } = await pool.query(sql, params);
      const ids = page.map((r) => r.id);
      const got = await enqueueLeadCompanies(pool, ids, { priority: 1, source: "push" });
      const known = new Set(keys.map((k) => `${k.key_kind}:${k.key}`));
      const unscored = [];
      // Only the companies still without a score count toward this push's total.
      if (got.keys.length) {
        const { rows: open } = await pool.query(
          `SELECT x.key_kind, x.key FROM jsonb_to_recordset($1::jsonb) AS x(key_kind text, key text)
            WHERE NOT EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.key_kind = x.key_kind AND k.key = x.key)`,
          [JSON.stringify(got.keys)]
        );
        for (const k of open) if (!known.has(`${k.key_kind}:${k.key}`)) unscored.push({ key_kind: k.key_kind, key: k.key });
      }
      const capped = cursor.capped === true || keys.length + unscored.length > SCORING_KEYS_MAX;
      const next = {
        done: page.length < SCORING_PAGE,
        last_id: ids.length ? ids[ids.length - 1] : cursor.last_id ?? null,
        capped,
        keys: capped ? [] : [...keys, ...unscored],
        leads: Number(cursor.leads ?? 0) + ids.length,
        nokey: Number(cursor.nokey ?? 0) + got.nokey,
      };
      await pool.query(
        `UPDATE push_batches SET fit_cursor = $3::jsonb, fit_total = coalesce(fit_total, 0) + $4,
                fit_claim_token = NULL
          WHERE id = $1 AND fit_claim_token = $2 AND status = 'scoring'`,
        [batch.id, token, JSON.stringify(next), unscored.length]
      );
      return batch.id;
    }
    // Every page has been read: wait until each company it queued has a score.
    const total = Number(batch.fit_total ?? 0);
    let scored;
    let open;
    if (cursor.capped === true) {
      const { rows: [q] } = await pool.query(`SELECT EXISTS (SELECT 1 FROM company_fit_queue WHERE priority = 1) AS busy`);
      open = q.busy;
      scored = open ? Number(batch.fit_scored ?? 0) : total;
    } else {
      scored = await countScored(pool, keys);
      open = scored < keys.length;
    }
    if (open) {
      await pool.query(
        `UPDATE push_batches SET fit_scored = $3, fit_claim_token = NULL WHERE id = $1 AND fit_claim_token = $2`,
        [batch.id, token, scored]
      );
      return null; // nothing done that needs the loop to hurry
    }
    const { rowCount } = await pool.query(
      `UPDATE push_batches SET status = 'pending', fit_scored = $3, fit_claim_token = NULL
        WHERE id = $1 AND fit_claim_token = $2 AND status = 'scoring'`,
      [batch.id, token, scored]
    );
    if (rowCount) log(`fit: push ${batch.id.slice(0, 8)} (${batch.client_tag}): its ${total} companies are scored; it is pending again`);
    return batch.id;
  } catch (e) {
    await letGo().catch(() => {});
    throw e;
  }
}

/**
 * An owner or admin lets a waiting push go unscored. It goes to 'pending',
 * fenced on 'scoring' (a cancel wins); the push-time check still skips its
 * unscored companies. Returns whether it was released.
 *
 * @param {Db} db
 * @param {{ batchId: string, userId: string | null }} p
 */
export async function releaseScoringBatch(db, { batchId, userId }) {
  const { rowCount } = await db.query(
    `UPDATE push_batches SET status = 'pending', fit_released_by = $2, fit_claim_token = NULL
      WHERE id = $1 AND status = 'scoring'`,
    [batchId, userId]
  );
  return rowCount > 0;
}
