// Promoted leads into the client's campaigns (migration 140): switch
// promotion.auto_push, for the clients on promotion.tags (flagOn
// "promotion_push"), set on the Companies tab's settings sheet. Ships off.
// Clay's General table pushed each approved inbox straight into the client's
// Email Bison campaigns; this does the same for the leads promotion adds.
//
//   1. Queued at the settle. finishPromote (promote.mjs) marks each contact
//      it settles 'added' (a lead this round created) auto_push_state 'queued'
//      while the switch is on, in the same fenced statement, so a contact is
//      queued once. A contact whose lead was there first (in_database,
//      in_bison, never_contact) is never queued, and neither is one settled
//      while the switch was off: nothing older is pushed unasked.
//   2. Ready once placed. The push worker checks the client's targeting again
//      at push time, where require_location needs a country: a lead pushed
//      before its place is known is skipped there as "ineligible per client
//      targeting at push time". The import leaves a lead's place to the
//      location job, so promotion places a batch's new leads itself with that
//      job's own code right after the settle, before the batch's final status
//      (placeAdded, promote.mjs; ../lead-places.mjs). A round is ready once
//      nothing is left for the job to write for any of its leads (each placed,
//      or one the job leaves as it is: no place text, or a state text naming
//      no state, so one unplaceable lead never holds a round), or as before: a
//      location run that started after the round finished (cron_runs, as the
//      share step waits), or PUSH_WAIT_MINUTES. A placement that failed leaves
//      the round to those two. A round's leads go together: nothing is taken
//      while a round of the client is still importing, and the two batches of
//      a round (made in one transaction, so with one created_at) wait for the
//      later of the two.
//   3. Pushed by the web app. The enrich-worker asks POST
//      /api/companies/promote/auto/push (Bearer AIARK_AUTO_ADD_KEY, the
//      promotion round's own address and key) for a client with ready leads,
//      at most once every PUSH_ASK_EVERY_MS. The route reads the client's
//      campaigns live, picks them as the export popup does and queues one
//      push batch for exactly those leads (src/lib/companies/promote-push.ts).
//
// Each contact's push is kept in enrich_contacts: auto_push_state (queued,
// pushed, held, dropped), auto_push_note (why it was held or dropped),
// auto_push_batch_id and auto_push_at; its add_to_database cell's note says
// the same.

import { flagOn } from "./settings.mjs";
import { CRON_LOCATION_BACKFILL, PUSH_BATCH_MAX_IDS } from "../overlap-topup.mjs";
import { leftToPlaceSql } from "../lead-places.mjs";
import { ADD_COLUMN, notePush, PROMOTE_STALE_HOURS } from "./promote.mjs";

/** push_batches.push_options.source of a promotion push. Not a share source: the worker treats it as any batch. */
export const PROMOTE_PUSH_SOURCE = "promote";
/** enrich_contacts.auto_push_state (migration 140); null for a contact that was never queued. */
export const PUSH_STATES = Object.freeze(["queued", "pushed", "held", "dropped"]);
/** The columns 140 adds; the code reads none of them until all four exist. */
export const PUSH_COLUMNS = Object.freeze(["auto_push_state", "auto_push_note", "auto_push_batch_id", "auto_push_at"]);
/** A round whose leads are not all placed waits this long for the location backfill, then goes anyway (the share step's default wait). */
export const PUSH_WAIT_MINUTES = 180;
/** The worker asks for a client's push at most this often. */
export const PUSH_ASK_EVERY_MS = 2 * 60_000;
/** The enrich-worker's capability for the push asks (enrich_worker_state.capabilities). */
export const PROMOTION_PUSH_CAPABILITY = "promotion_push";
/** The route the worker asks. Under api/companies/promote/auto, so outside the session middleware. */
export const PROMOTE_PUSH_PATH = "/api/companies/promote/auto/push";
/** At most this many leads go into one push batch (the share push's limit); the rest wait for the next ask. */
export const PUSH_MAX_LEADS = PUSH_BATCH_MAX_IDS;
const AUTO_KEY_MIN = 32;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {import("./settings.mjs").PipelineSettings} PipelineSettings
 */

/**
 * Are migration 140's columns in this database? A catalog read, so it never
 * aborts the caller's transaction the way a missing column would.
 *
 * @param {Db} db
 * @returns {Promise<boolean>}
 */
export async function pushColumnsReady(db) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM pg_attribute
      WHERE attrelid = to_regclass('public.enrich_contacts') AND attname = ANY($1::text[]) AND NOT attisdropped`,
    [[...PUSH_COLUMNS]]
  );
  return (rows[0]?.n ?? 0) === PUSH_COLUMNS.length;
}

// A client's queued contacts, each with its round: the upload batch's
// created_at (the two batches of a round are made in one transaction), whether
// every batch of that round is finished, when the last one finished, and
// whether every lead of the round is placed (nothing left for the location
// job to write: leftToPlaceSql). A contact whose batch row is gone counts as
// a round of its own that finished when it was queued; one whose lead is gone
// counts as placed (the push drops it). $1 the tag.
const QUEUED_CTE = `
  q AS (
    SELECT c.row_id, c.table_id, c.lead_id,
           coalesce(b.created_at, c.auto_push_at) AS round_at,
           CASE WHEN b.id IS NULL THEN true ELSE b.status IN ('complete', 'error') AND b.completed_at IS NOT NULL END AS finished,
           coalesce(b.completed_at, CASE WHEN b.id IS NULL THEN c.auto_push_at END) AS done_at,
           NOT EXISTS (SELECT 1 FROM leads l WHERE l.id = c.lead_id AND ${leftToPlaceSql("l")}) AS placed
      FROM enrich_contacts c
      LEFT JOIN upload_batches b ON b.id = c.batch_id
     WHERE c.client_tag = $1 AND c.auto_push_state = 'queued'
  ),
  r AS (
    SELECT round_at, bool_and(finished) AS finished, max(done_at) AS done_at, bool_and(placed) AS placed FROM q GROUP BY round_at
  ),
  location_run AS (
    SELECT max(finished_run_started_at) AS run_at FROM cron_runs WHERE name = $2
  ),
  live AS (
    SELECT EXISTS (
      SELECT 1 FROM enrich_contacts x JOIN upload_batches lb ON lb.id = x.batch_id
       WHERE x.client_tag = $1 AND x.usable AND x.promote_state = 'running'
         AND lb.status = 'processing' AND lb.created_at > now() - make_interval(hours => $4)
    ) AS running
  )`;

/**
 * Whether a round's leads may go: finished, and placed (by the promotion itself, or by anything since), or a
 * location run started after it finished, or waited out. $3 the wait in minutes.
 */
const ROUND_READY = `(r.finished AND (r.placed OR r.done_at < (SELECT run_at FROM location_run) OR r.done_at < now() - make_interval(mins => $3)))`;

/** The queued contacts that may be pushed now, oldest round first. $5 the limit. */
const READY_SQL = `
  WITH ${QUEUED_CTE}
  SELECT q.row_id, q.table_id, q.lead_id
    FROM q JOIN r ON r.round_at IS NOT DISTINCT FROM q.round_at
   WHERE ${ROUND_READY} AND NOT (SELECT running FROM live)
   ORDER BY q.round_at, q.row_id
   LIMIT $5`;

/** A client's queued contacts in numbers: all, ready now, and why the rest wait. */
const WAITING_SQL = `
  WITH ${QUEUED_CTE}
  SELECT count(*)::int AS queued,
         count(*) FILTER (WHERE ${ROUND_READY} AND NOT (SELECT running FROM live))::int AS ready,
         count(*) FILTER (WHERE NOT r.finished)::int AS importing,
         count(*) FILTER (WHERE r.finished AND NOT ${ROUND_READY})::int AS unplaced,
         (SELECT running FROM live) AS round_running,
         min(q.round_at) FILTER (WHERE r.finished AND NOT ${ROUND_READY}) AS oldest_unplaced
    FROM q JOIN r ON r.round_at IS NOT DISTINCT FROM q.round_at`;

const params = (tag, limit) => [tag, CRON_LOCATION_BACKFILL, PUSH_WAIT_MINUTES, PROMOTE_STALE_HOURS, ...(limit == null ? [] : [limit])];

/**
 * The client's queued contacts that may be pushed now (row_id, table_id,
 * lead_id), at most `limit`. Inside a transaction, `lock` takes them FOR
 * UPDATE, so two pushes of one client can never take the same contact.
 *
 * @param {Db} db
 * @param {{ tag: string, limit?: number, lock?: boolean }} p
 * @returns {Promise<Array<{ row_id: number, table_id: string, lead_id: string | null }>>}
 */
export async function readyRows(db, { tag, limit = PUSH_MAX_LEADS, lock = false }) {
  const { rows } = await db.query(
    lock
      ? `SELECT c.row_id, c.table_id, c.lead_id FROM enrich_contacts c
          WHERE c.row_id IN (SELECT x.row_id FROM (${READY_SQL}) x) AND c.auto_push_state = 'queued'
          ORDER BY c.row_id FOR UPDATE OF c`
      : READY_SQL,
    params(tag, Math.max(1, Math.min(limit, PUSH_MAX_LEADS)))
  );
  return rows.map((r) => ({ row_id: Number(r.row_id), table_id: String(r.table_id), lead_id: r.lead_id == null ? null : String(r.lead_id) }));
}

/**
 * A client's queued contacts in numbers, for the fit panel and the push
 * route's answer: queued, ready now, still importing (their round is not
 * finished), unplaced (waiting for the location backfill), whether a round is
 * running, and when the oldest unplaced round began.
 *
 * @param {Db} db
 * @param {string} tag
 */
export async function pushWaiting(db, tag) {
  const { rows: [w] } = await db.query(WAITING_SQL, params(tag));
  return {
    queued: w?.queued ?? 0,
    ready: w?.ready ?? 0,
    importing: w?.importing ?? 0,
    unplaced: w?.unplaced ?? 0,
    round_running: w?.round_running === true,
    oldest_unplaced: w?.oldest_unplaced instanceof Date ? w.oldest_unplaced.toISOString() : w?.oldest_unplaced ?? null,
  };
}

/** Why a client's queued leads are not pushed yet, in words, or null when some are ready. */
export function waitingWhy(w) {
  if (!w || w.queued === 0 || w.ready > 0) return null;
  if (w.round_running || w.importing > 0) return "a promotion round of the client is still importing";
  if (w.unplaced > 0) return `waiting for the location backfill to place them (at most ${PUSH_WAIT_MINUTES} minutes after their round)`;
  return null;
}

/**
 * The add_to_database cells of these contacts, with the push's outcome:
 * value.push and value.push_batch_id, and the note's push sentence replaced.
 * The display ("Added") is left as it is.
 *
 * @param {Db} db
 * @param {Array<{ row_id: number, state: string, batch_id?: string | null, sentence: string }>} items
 */
export async function notePushCells(db, items) {
  if (!items.length) return;
  const { rows } = await db.query(
    `SELECT row_id, note FROM enrich_cells WHERE row_id = ANY($1::bigint[]) AND column_key = $2`,
    [items.map((i) => i.row_id), ADD_COLUMN]
  );
  const notes = new Map(rows.map((r) => [Number(r.row_id), r.note]));
  await db.query(
    `UPDATE enrich_cells c
        SET value = coalesce(c.value, '{}'::jsonb) || jsonb_build_object('push', x.state, 'push_batch_id', x.batch_id),
            note = x.note, updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, state text, batch_id uuid, note text)
      WHERE c.row_id = x.row_id AND c.column_key = $2`,
    [
      JSON.stringify(items.map((i) => ({ row_id: i.row_id, state: i.state, batch_id: i.batch_id ?? null, note: notePush(notes.get(i.row_id), i.sentence) }))),
      ADD_COLUMN,
    ]
  );
}

// ── The worker's ask ────────────────────────────────────────────────────────

/**
 * The clients whose promoted leads may be pushed now: on promotion's list
 * with the push switch on, and with at least one ready contact.
 *
 * @param {Db} db
 * @param {PipelineSettings} settings
 * @returns {Promise<string[]>}
 */
export async function pushDue(db, settings) {
  if (!settings?.promotion?.promote_to_leads || !settings.promotion.auto_push) return [];
  const out = [];
  for (const tag of settings.promotion.tags) {
    if (!flagOn(settings, "promotion_push", tag)) continue;
    if ((await readyRows(db, { tag, limit: 1 })).length) out.push(tag);
  }
  return out;
}

/** Where the worker asks for a push: the auto-add address's origin and the same key (AIARK_AUTO_ADD_URL, AIARK_AUTO_ADD_KEY). */
export function promotePushConfig(env = process.env) {
  const base = String(env.AIARK_AUTO_ADD_URL ?? "").trim();
  const key = String(env.AIARK_AUTO_ADD_KEY ?? "").trim();
  if (!base || key.length < AUTO_KEY_MIN) return null;
  try {
    return { url: new URL(PROMOTE_PUSH_PATH, base).toString(), key };
  } catch {
    return null;
  }
}

/**
 * Asks the web app to push one client's ready leads (the campaign pick and
 * the push batch are TypeScript the worker can't load). Never throws. The
 * route reads the client's campaigns live, which can take a minute an install.
 *
 * @param {{ url: string, key: string }} config
 * @param {string} tag
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, status: number | null, body: Record<string, any> | null, why: string | null }>}
 */
export async function requestPromotePush(config, tag, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` },
      body: JSON.stringify({ tag }),
      signal: AbortSignal.timeout(150_000),
    });
    const json = await res.json().catch(() => null);
    return {
      ok: res.ok,
      status: res.status,
      body: json && typeof json === "object" ? json : null,
      why: res.ok ? null : String(json?.error ?? "no reason given").slice(0, 300),
    };
  } catch (e) {
    return { ok: false, status: null, body: null, why: String(e?.name === "TimeoutError" ? "no answer in time" : e?.cause?.code ?? e?.message ?? e).slice(0, 300) };
  }
}

/** One log line for a push answer. */
export function pushLogLine(tag, r) {
  if (!r.ok) return `push for ${tag}: not pushed, ${r.status ?? "no answer"}: ${r.why}`;
  const b = r.body ?? {};
  const parts = [];
  if (b.batch) parts.push(`${b.pushed ?? 0} lead(s) in push batch ${b.batch}`);
  if (b.held) parts.push(`${b.held} held${b.held_why ? ` (${b.held_why})` : ""}`);
  if (b.dropped) parts.push(`${b.dropped} dropped`);
  if (!parts.length) parts.push(b.note ? String(b.note) : "nothing to push");
  return `push for ${tag}: ${parts.join(", ")}`;
}
