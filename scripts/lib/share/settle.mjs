// The share step's settle part (overlap sharing): share and top-up pushes that
// ended give every share row they took its end state, so no row stays
// "pushed" behind a push that never sent its lead.
//
// A share push (src/lib/sharing/push.ts) marks its rows pushed with its batch.
// The batch ends complete (every item sent, failed or skipped, or nothing
// gathered), cancelled (by the push worker's receive check or empty list, by
// an undo, or by an operator on the Exports page) or in error (a gather that
// failed, a key Bison refused). Once it has ended, with no item pushing and,
// when cancelled, none pending, each of its rows still pushed gets, by
// settleOutcome():
//   - its item sent: it stays pushed;
//   - undone: dropped "undone";
//   - no item in a batch that was gathered (the gather left the lead out):
//     dropped "no_lead", "already_sent" or "not_eligible";
//   - skipped as ineligible, or refused by Bison: dropped "not_eligible" or
//     "bison_refused";
//   - in a cancelled batch: held with the cancel's reason. A cancel on the
//     Exports page is held with held_since NULL, so the daily held retry never
//     takes it; "Push shared" with held does;
//   - failed, skipped for any other reason, or in a batch in error: held with
//     a note in plain words, tried again daily for held_retry_days.
// Then the batch is stamped push_options.sharesSettledAt and never looked at
// again. push_batch_id and pushed_at stay on every row (the job detail still
// lists the push the row was in).
//
// The share step runs it each round (step.mjs): at most
// SETTLE_BATCHES_PER_ROUND batches, and no new batch once SETTLE_MS has
// passed. Each batch is one transaction under
// pg_try_advisory_xact_lock(hashtext('share-settle:' || id)), so two workers
// (a deploy) never settle one batch twice; its rows are locked before the
// batch row, as the undo locks them (jobs.mjs), so the two cannot deadlock.
// Notes are generic on purpose: the Held tab groups rows by note, and raw item
// and batch errors can carry a lead's email. The raw errors stay on the batch
// and its items (the Exports page).

import { inTx, isUnready, read } from "./db.mjs";
import { SHARE_PUSH_SOURCES } from "../overlap-topup.mjs";

/** The push_batches.push_options key that marks a share or top-up push as settled (its value: when, ISO). */
export const SETTLED_KEY = "sharesSettledAt";
/** The held note of a share whose push an operator cancelled on the Exports page: never retried by itself. */
export const OPERATOR_CANCEL_NOTE = "push cancelled on the Exports page";
/** The held note of a share whose own lead failed in its push. */
export const ITEM_FAILED_NOTE = "push failed for this lead";
/** Ended pushes settled at most a round; the rest the next round. */
export const SETTLE_BATCHES_PER_ROUND = 20;
/** No new batch is started once this long has passed in a round. */
export const SETTLE_MS = 15_000;

const ENDED = ["complete", "cancelled", "error"];
const CANCELLED = "Cancelled: ";
const CANNOT_RECEIVE = /^Cancelled: \S+ cannot receive \((.+)\)$/s;

/**
 * The held note for a push-time skip (push_items.error of a skipped item), in plain words.
 *
 * @param {string | null | undefined} error
 * @returns {string}
 */
export function skipNote(error) {
  const e = typeof error === "string" ? error : "";
  if (/^company not scored yet/.test(e)) return "not sent: company not scored yet (fit gate)";
  if (/^no company key to score/.test(e)) return "not sent: no company key to score (fit gate)";
  if (/^refusing to push/.test(e)) return "not sent: the client's B2B and B2C installs are not set";
  if (/^no \S+ campaign on this batch|^no campaign for the "/.test(e)) return "not sent: no campaign for its side or mail provider";
  if (/^batch cancelled/.test(e)) return "not sent: its push was cancelled";
  return "not sent: skipped by the push worker";
}

/**
 * The held note for a batch in error (push_batches.error), in plain words, never the raw text.
 *
 * @param {string | null | undefined} error
 * @returns {string}
 */
export function batchErrorNote(error) {
  const e = typeof error === "string" ? error : "";
  if (/-> 40[13]\b|no API key for instance/.test(e)) return "push failed: Bison refused the key";
  if (/^gather failed/.test(e)) return "push failed: the gather failed";
  return "push failed: the push stopped with an error";
}

/**
 * @typedef {{ status: "complete" | "cancelled" | "error", error: string | null, gathered: boolean }} EndedBatch
 *   gathered: push_batches.total IS NOT NULL
 * @typedef {{ status: "pending" | "pushing" | "sent" | "failed" | "skipped", error: string | null }} BatchItem
 * @typedef {{ undone: boolean, leadGone: boolean, sentElsewhere: boolean }} SettleRow
 * @typedef {{ keep: true } | { state: "held", note: string, retry: boolean } | { state: "dropped", note: string }} SettleOutcome
 */

/**
 * The end state of one applied share row whose push batch ended, by the first
 * rule that applies (the order matters). Pure.
 *
 * @param {EndedBatch} batch
 * @param {BatchItem | null} item  the row's push_items row in that batch
 * @param {SettleRow} row
 * @returns {SettleOutcome}
 */
export function settleOutcome(batch, item, row) {
  // 1. Sent: it reached its campaigns.
  if (item?.status === "sent") return { keep: true };
  // 2. Undone on the Sharing page.
  if (row.undone) return { state: "dropped", note: "undone" };
  // 3. The gather left it out.
  if (!item && batch.gathered) {
    return { state: "dropped", note: row.leadGone ? "no_lead" : row.sentElsewhere ? "already_sent" : "not_eligible" };
  }
  const itemError = typeof item?.error === "string" ? item.error : "";
  // 4 and 5. Skips a retry cannot change.
  if (item?.status === "skipped" && itemError.startsWith("ineligible per client targeting")) return { state: "dropped", note: "not_eligible" };
  if (item?.status === "skipped" && itemError.startsWith("Bison refused all target campaigns")) return { state: "dropped", note: "bison_refused" };
  // 6. A cancelled batch: the worker's receive check, an empty list or an undo say why; anything else is an operator's cancel.
  if (batch.status === "cancelled") {
    const e = typeof batch.error === "string" ? batch.error : "";
    const m = CANNOT_RECEIVE.exec(e);
    if (m) return { state: "held", note: `cannot receive: ${m[1]}`, retry: true };
    if (e.startsWith(CANCELLED)) return { state: "held", note: `push cancelled: ${e.slice(CANCELLED.length)}`, retry: true };
    return { state: "held", note: OPERATOR_CANCEL_NOTE, retry: false };
  }
  // 7 and 8. The lead's own push failed, or was skipped for a reason that may clear.
  if (item?.status === "failed") return { state: "held", note: ITEM_FAILED_NOTE, retry: true };
  if (item?.status === "skipped") return { state: "held", note: skipNote(item.error), retry: true };
  // 9. The batch stopped with an error before the lead was pushed.
  if (batch.status === "error" && (item?.status === "pending" || (!item && !batch.gathered))) {
    return { state: "held", note: batchErrorNote(batch.error), retry: true };
  }
  // 10. Nothing else can reach here for a batch the settle takes; left pushed.
  return { keep: true };
}

/** Ended share and top-up pushes not settled yet, oldest first. $1 the sources, $2 how many. */
export const SETTLE_CANDIDATES_SQL = `SELECT b.id
  FROM push_batches b
 WHERE b.status IN ('complete', 'cancelled', 'error')
   AND coalesce(b.push_options ->> 'source', '') = ANY($1::text[])
   AND NOT (coalesce(b.push_options, '{}'::jsonb) ? '${SETTLED_KEY}')
   AND NOT EXISTS (SELECT 1 FROM push_items i WHERE i.batch_id = b.id AND i.status = 'pushing')
   AND (b.status <> 'cancelled'
        OR NOT EXISTS (SELECT 1 FROM push_items i WHERE i.batch_id = b.id AND i.status = 'pending'))
 ORDER BY b.created_at, b.id
 LIMIT $2`;

/** One batch as the settle reads it again under its lock. $1 the batch. */
const BATCH_SQL = `SELECT b.client_tag, b.status, b.error, b.total IS NOT NULL AS gathered,
       coalesce(b.push_options, '{}'::jsonb) ? '${SETTLED_KEY}' AS settled,
       EXISTS (SELECT 1 FROM push_items i WHERE i.batch_id = b.id AND i.status = 'pushing') AS pushing,
       EXISTS (SELECT 1 FROM push_items i WHERE i.batch_id = b.id AND i.status = 'pending') AS pending
  FROM push_batches b WHERE b.id = $1`;

/**
 * The batch's rows still pushed, with their item in it, locked. Anchored on
 * the batch's own ids (lead_shares_lead_idx); items by their key. $1 the
 * batch, $2 its client, $3 whether it was gathered. The cast on the ids'
 * subquery is needed: without it "= ANY ((SELECT ...))" stays a row
 * subquery (uuid = uuid[]). Exported for the EXPLAIN check of
 * scripts/test-share-gaps.mjs.
 */
export const SETTLE_ROWS_SQL = `SELECT s.id::text AS id, s.lead_id, s.undone_at IS NOT NULL AS undone, i.status AS item_status, i.error AS item_error,
       CASE WHEN i.lead_id IS NULL AND $3::boolean THEN NOT EXISTS (
              SELECT 1 FROM leads l WHERE l.id = s.lead_id AND l.email IS NOT NULL AND l.email <> '') END AS lead_gone,
       CASE WHEN i.lead_id IS NULL AND $3::boolean THEN EXISTS (
              SELECT 1 FROM push_items pi JOIN push_batches pb ON pb.id = pi.batch_id
               WHERE pi.lead_id = s.lead_id AND pi.status = 'sent' AND pb.client_tag = $2 AND pi.batch_id <> $1) END AS sent_elsewhere
  FROM lead_shares s
  LEFT JOIN push_items i ON i.batch_id = $1 AND i.lead_id = s.lead_id
 WHERE s.lead_id = ANY ((SELECT selected_ids FROM push_batches WHERE id = $1)::uuid[])
   AND s.receiver_tag = $2 AND s.push_batch_id = $1 AND s.push_state = 'pushed'
   FOR UPDATE OF s`;

// One statement per (state, note, retry) group; each only moves rows still pushed.
const HOLD_SQL = `UPDATE lead_shares SET push_state = 'held', push_note = $2, held_since = coalesce(held_since, now()), held_at = now()
  WHERE id = ANY($1::bigint[]) AND push_state = 'pushed'`;
const HOLD_MANUAL_SQL = `UPDATE lead_shares SET push_state = 'held', push_note = $2, held_since = NULL, held_at = now()
  WHERE id = ANY($1::bigint[]) AND push_state = 'pushed'`;
const DROP_SQL = `UPDATE lead_shares SET push_state = 'dropped', push_note = $2 WHERE id = ANY($1::bigint[]) AND push_state = 'pushed'`;
const STAMP_SQL = `UPDATE push_batches SET push_options = coalesce(push_options, '{}'::jsonb) || jsonb_build_object('${SETTLED_KEY}', now())
  WHERE id = $1`;

/**
 * Settles one ended batch in one transaction. Null when another settle holds
 * it, or it is settled already or not ready (something still pushing, or a
 * cancelled batch with items still pending).
 *
 * @param {import("./db.mjs").Pool} pool
 * @param {string} id
 * @param {(line: string) => void} log
 * @returns {Promise<{ kept: number, held: number, dropped: number } | null>}
 */
async function settleBatch(pool, id, log) {
  return inTx(pool, async (c) => {
    const { rows: [lock] } = await c.query(`SELECT pg_try_advisory_xact_lock(hashtext('share-settle:' || $1::text)) AS got`, [id]);
    if (!lock?.got) return null;
    const { rows: [b] } = await c.query(BATCH_SQL, [id]);
    if (!b || !ENDED.includes(b.status) || b.settled || b.pushing || (b.status === "cancelled" && b.pending)) return null;
    const batch = { status: b.status, error: b.error ?? null, gathered: b.gathered === true };
    const { rows } = await c.query(SETTLE_ROWS_SQL, [id, b.client_tag, batch.gathered]);
    /** @type {Map<string, { state: "held" | "dropped", note: string, retry: boolean, ids: string[] }>} */
    const groups = new Map();
    let sent = 0;
    let odd = 0;
    for (const r of rows) {
      const o = settleOutcome(batch, r.item_status ? { status: r.item_status, error: r.item_error ?? null } : null, {
        undone: r.undone === true,
        leadGone: r.lead_gone === true,
        sentElsewhere: r.sent_elsewhere === true,
      });
      if ("keep" in o) {
        if (r.item_status === "sent") sent++;
        else odd++;
        continue;
      }
      const retry = o.state === "held" ? o.retry : false;
      const key = `${o.state}|${retry}|${o.note}`;
      const g = groups.get(key);
      if (g) g.ids.push(r.id);
      else groups.set(key, { state: o.state, note: o.note, retry, ids: [r.id] });
    }
    let held = 0;
    let dropped = 0;
    for (const g of groups.values()) {
      const sql = g.state === "dropped" ? DROP_SQL : g.retry ? HOLD_SQL : HOLD_MANUAL_SQL;
      const { rowCount } = await c.query(sql, [g.ids, g.note]);
      if (g.state === "dropped") dropped += rowCount ?? 0;
      else held += rowCount ?? 0;
    }
    await c.query(STAMP_SQL, [id]);
    const name = `share push ${String(id).slice(0, 8)} (${b.client_tag ?? "no client"}, ${b.status})`;
    if (held || dropped) log(`overlap sharing: ${name}: ${held} held, ${dropped} dropped, ${sent} sent`);
    if (odd) log(`overlap sharing: ${name}: ${odd} share(s) left pushed with an item that is neither sent nor ended; see the batch on the Exports page`);
    return { kept: sent + odd, held, dropped };
  });
}

/**
 * Settles share and top-up pushes that ended (complete, cancelled, error) and
 * are not stamped settled, oldest first: at most maxBatches, and no new batch
 * once maxMs has passed (the first is always taken). Never throws for one
 * batch: a failed batch is logged and left for the next round. A missing
 * migration (42P01, 42703, 42883) is thrown on, as the step's other parts do.
 *
 * @param {import("./db.mjs").Pool} pool
 * @param {{ log?: (line: string) => void, maxBatches?: number, maxMs?: number }} [opts]
 * @returns {Promise<{ batches: number, kept: number, held: number, dropped: number }>}
 */
export async function settleEndedPushes(pool, { log = () => {}, maxBatches = SETTLE_BATCHES_PER_ROUND, maxMs = SETTLE_MS } = {}) {
  const out = { batches: 0, kept: 0, held: 0, dropped: 0 };
  const { rows } = await read(pool, SETTLE_CANDIDATES_SQL, [[...SHARE_PUSH_SOURCES], maxBatches]);
  const started = Date.now();
  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && Date.now() - started >= maxMs) break;
    const id = String(rows[i].id);
    try {
      const r = await settleBatch(pool, id, log);
      if (!r) continue;
      out.batches++;
      out.kept += r.kept;
      out.held += r.held;
      out.dropped += r.dropped;
    } catch (e) {
      if (isUnready(e)) throw e;
      log(`overlap sharing: share push ${id.slice(0, 8)} could not be settled, tried again next round: ${/** @type {Error} */ (e)?.message ?? e}`);
    }
  }
  return out;
}
