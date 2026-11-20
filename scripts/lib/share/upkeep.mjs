// The share step's timers (contract 4.4): the automatic push of applied
// shares, the paced tag writer, and the prune.
//
//   pushTimer()   For each receiver with queued shares, at most once every
//                 push_every_minutes, the worker asks the web app to push them
//                 (POST /api/sharing/push/auto { receiver }, Bearer
//                 SHARE_PUSH_KEY): the campaign search and the pick run there
//                 (plan 1.8). Once a day per receiver with held shares still
//                 inside held_retry_days it asks again with retryHeld. Without
//                 the address and key (sharePushConfig) the shares stay queued
//                 and the step says so once. Each ask that fails (a 409, any
//                 other error, no answer) is kept per receiver in memory
//                 (pushRefusals(), for the worker's heartbeat and the Held
//                 tab) until a push for that receiver goes through or nothing
//                 waits for it any more.
//   writeTags()   While write_tags is on: applied, live shared rows get the
//                 receiver's tag on the lead (fn_merge_tags, the exact
//                 client_tags spelling, only where the lead lacks it), with a
//                 lead_history row, the lead and its share row in one
//                 transaction. Undone shares whose tag was written get it
//                 taken off (fn_remove_tag) the same way, whether or not
//                 write_tags is on. At most TAG_ROWS_PER_MINUTE a round and
//                 tag_rows_per_day a UTC day, adds and removals together.
//   prune()       At most hourly: lead lists of jobs finished more than
//                 LEAD_LIST_PRUNE_DAYS ago, and rows that are not shares
//                 decided more than SHARE_ROW_PRUNE_DAYS ago.

import { flagOn } from "../enrich/settings.mjs";
import { LEAD_LIST_PRUNE_DAYS, SHARE_ROW_PRUNE_DAYS, sharePushConfig, TAG_ROWS_PER_MINUTE } from "../overlap-topup.mjs";
import { inTx, read, tagTestSql, UTC_DAY_START } from "./db.mjs";

/**
 * @typedef {import("./db.mjs").Pool} Pool
 * @typedef {import("../enrich/settings.mjs").PipelineSettings} PipelineSettings
 * @typedef {{ receiver: string, at: string, status: number | null, error: string, kept: number | null, retryHeld: boolean }} PushRefusal
 *   The push timer's last failed ask for one receiving client: when (ISO), the answer's status (null: no answer), its error,
 *   how many shares it said stay as they were, and whether held shares were being tried again.
 * @typedef {{ pushedAt: Map<string, number>, heldAt: Map<string, number>, pushConfigSaid: boolean,
 *             tagDay: { day: string, used: number } | null, prunedAt: number, refusals: Map<string, PushRefusal> }} UpkeepMemory
 */

/** How long the push route may take: it reads the receiver's live campaigns from Email Bison. */
const PUSH_WAIT_MS = 120_000;
/** Receivers asked at most per round; the others are asked next round. */
const PUSH_ASKS_PER_ROUND = 10;
/** Refusals pushRefusals() gives at most. */
const REFUSALS_MAX = 200;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Rows deleted per prune statement. */
const PRUNE_CHUNK = 5000;

/** The timers' memory in the worker process: lost on a restart, so each timer then runs at once. */
export function newUpkeepMemory() {
  return { pushedAt: new Map(), heldAt: new Map(), pushConfigSaid: false, tagDay: null, prunedAt: 0, refusals: new Map() };
}

// ── Pushes ──────────────────────────────────────────────────────────────────

/**
 * Asks the web app to push one receiver's queued shares (contract 5.1). Never
 * throws: a refusal, an error or no answer in time comes back as { ok: false }.
 *
 * @param {{ url: string, key: string }} config
 * @param {{ receiver: string, retryHeld?: boolean }} body
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ ok: boolean, status: number | null, body: any, why: string | null }>}
 */
export async function requestSharePush(config, body, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(config.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUSH_WAIT_MS),
    });
    const json = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body: json, why: res.ok ? null : String(json?.error ?? "no reason given").slice(0, 300) };
  } catch (e) {
    const err = /** @type {{ name?: string, cause?: { code?: string }, message?: string }} */ (e);
    return { ok: false, status: null, body: null, why: String(err?.name === "TimeoutError" ? "no answer in time" : err?.cause?.code ?? err?.message ?? e).slice(0, 300) };
  }
}

/** A push answer in a line for the log. */
function pushLine(receiver, r, retryHeld) {
  const what = retryHeld ? "held shares tried again" : "queued shares";
  if (!r.ok) return `share push for ${receiver} (${what}): not done, ${r.status ?? "no answer"}: ${r.why}`;
  const b = r.body ?? {};
  return `share push for ${receiver} (${what}): ${b.pushed ?? 0} pushed in ${Array.isArray(b.batches) ? b.batches.length : 0} batch(es), ` +
    `${b.held ?? 0} held, ${b.dropped ?? 0} dropped, ${b.left ?? 0} still queued${b.note ? `: ${b.note}` : ""}`;
}

/**
 * One pass of the push timer.
 *
 * @param {Pool} pool
 * @param {{ settings: PipelineSettings, memory: UpkeepMemory, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *           now?: () => number, log?: (line: string) => void }} opts
 * @returns {Promise<Array<{ receiver: string, retryHeld: boolean, ok: boolean, status: number | null }>>}  the requests made
 */
export async function pushTimer(pool, { settings, memory, env = process.env, fetchImpl = fetch, now = Date.now, log = () => {} }) {
  const os = settings.overlap_sharing;
  const { rows: queued } = await read(pool, `SELECT DISTINCT receiver_tag FROM lead_shares WHERE push_state = 'queued' ORDER BY 1`);
  const { rows: held } = os.held_retry_days > 0
    ? await read(
        pool,
        `SELECT DISTINCT receiver_tag FROM lead_shares
          WHERE push_state = 'held' AND held_since > now() - make_interval(days => $1) ORDER BY 1`,
        [os.held_retry_days]
      )
    : { rows: [] };
  // A refusal is kept only while something still waits for that receiver.
  if (!(memory.refusals instanceof Map)) memory.refusals = new Map();
  const waiting = new Set([...queued, ...held].map((r) => r.receiver_tag));
  for (const receiver of [...memory.refusals.keys()]) if (!waiting.has(receiver)) memory.refusals.delete(receiver);
  if (!queued.length && !held.length) return [];
  const config = sharePushConfig(env);
  if (!config) {
    if (!memory.pushConfigSaid) {
      log("shared leads wait in the queue: SHARE_PUSH_KEY (32 characters or more) and the web address (SHARE_PUSH_URL or AIARK_AUTO_ADD_URL) are not both set on the worker");
    }
    memory.pushConfigSaid = true;
    return [];
  }
  memory.pushConfigSaid = false;
  const every = os.push_every_minutes * 60_000;
  const asks = [];
  for (const { receiver_tag: receiver } of queued) {
    if (now() - (memory.pushedAt.get(receiver) ?? -Infinity) < every) continue;
    asks.push({ receiver, retryHeld: false });
  }
  for (const { receiver_tag: receiver } of held) {
    if (now() - (memory.heldAt.get(receiver) ?? -Infinity) < DAY_MS) continue;
    asks.push({ receiver, retryHeld: true });
  }
  const made = [];
  for (const ask of asks.slice(0, PUSH_ASKS_PER_ROUND)) {
    (ask.retryHeld ? memory.heldAt : memory.pushedAt).set(ask.receiver, now());
    const r = await requestSharePush(config, ask.retryHeld ? { receiver: ask.receiver, retryHeld: true } : { receiver: ask.receiver }, fetchImpl);
    log(pushLine(ask.receiver, r, ask.retryHeld));
    if (r.ok) memory.refusals.delete(ask.receiver);
    else {
      memory.refusals.set(ask.receiver, {
        receiver: ask.receiver,
        at: new Date(now()).toISOString(),
        status: r.status,
        error: r.why ?? "no reason given",
        kept: Number.isInteger(r.body?.kept) ? r.body.kept : null,
        retryHeld: ask.retryHeld,
      });
    }
    made.push({ ...ask, ok: r.ok, status: r.status });
  }
  return made;
}

/**
 * The push timer's last failed ask per receiving client, sorted by receiver,
 * at most REFUSALS_MAX; [] for a memory without them.
 *
 * @param {Partial<UpkeepMemory> | null | undefined} memory
 * @returns {PushRefusal[]}
 */
export function pushRefusals(memory) {
  const refusals = memory?.refusals;
  if (!(refusals instanceof Map)) return [];
  return [...refusals.values()]
    .sort((a, b) => (a.receiver < b.receiver ? -1 : a.receiver > b.receiver ? 1 : 0))
    .slice(0, REFUSALS_MAX)
    .map((r) => ({ ...r }));
}

// ── Tags ────────────────────────────────────────────────────────────────────

const TODAY_SQL = `SELECT to_char((now() AT TIME ZONE 'utc')::date, 'YYYY-MM-DD') AS day`;

/**
 * Tags written and taken off today (UTC), counted once a day from the rows and
 * then kept in memory as the writer goes.
 */
async function tagsToday(pool, memory) {
  const { rows: [{ day }] } = await read(pool, TODAY_SQL);
  if (memory.tagDay?.day !== day) {
    const { rows: [r] } = await read(
      pool,
      `SELECT (count(*) FILTER (WHERE tag_added AND tag_added_at >= ${UTC_DAY_START})
             + count(*) FILTER (WHERE tag_removed_at >= ${UTC_DAY_START}))::int AS n
         FROM lead_shares
        WHERE tag_added_at >= ${UTC_DAY_START} OR tag_removed_at >= ${UTC_DAY_START}`
    );
    memory.tagDay = { day, used: r.n };
  }
  return memory.tagDay;
}

/**
 * Up to `limit` shares get their receiver's tag, one lead per share row in a
 * statement (a lead shared to two clients gets the second tag next time), in
 * one transaction. A lead that carries the tag already, or is gone, keeps its
 * row's tag_added false; every row taken gets tag_added_at, so it is not taken
 * again.
 */
async function addTags(pool, limit) {
  return inTx(pool, async (c) => {
    const { rows: [r] } = await c.query(
      `WITH todo AS (
         SELECT DISTINCT ON (s.lead_id) s.id, s.lead_id, s.origin_tag, ct.tag AS tag
           FROM lead_shares s
           LEFT JOIN client_tags ct ON ct.tag = s.receiver_tag
          WHERE s.outcome = 'shared' AND s.applied_at IS NOT NULL AND s.undone_at IS NULL AND NOT s.tag_added
            AND s.tag_added_at IS NULL
          ORDER BY s.lead_id, s.id
          LIMIT $1
       ), tagged AS (
         UPDATE public.leads l SET tags = public.fn_merge_tags(l.tags, t.tag)
           FROM todo t
          WHERE l.id = t.lead_id AND t.tag IS NOT NULL AND NOT ${tagTestSql("l", "t.tag")}
         RETURNING l.id
       ), h AS (
         INSERT INTO lead_history (lead_id, event_type, notes)
         SELECT t.lead_id, 'updated', 'Shared from ' || t.origin_tag || ' to ' || t.tag || ': tag ' || t.tag || ' added (overlap sharing)'
           FROM todo t JOIN tagged g ON g.id = t.lead_id
       ), marked AS (
         UPDATE lead_shares s SET tag_added = (s.lead_id IN (SELECT id FROM tagged)), tag_added_at = now()
           FROM todo t WHERE s.id = t.id
         RETURNING s.id
       )
       SELECT (SELECT count(*) FROM tagged)::int AS written, (SELECT count(*) FROM marked)::int AS taken`,
      [limit]
    );
    return r;
  });
}

/**
 * Up to `limit` undone shares whose tag was written get it taken off the lead
 * (fn_remove_tag, only where the lead holds it), with a lead_history row;
 * every row taken gets tag_removed_at.
 */
async function removeTags(pool, limit) {
  return inTx(pool, async (c) => {
    const { rows: [r] } = await c.query(
      `WITH todo AS (
         SELECT DISTINCT ON (s.lead_id) s.id, s.lead_id, s.origin_tag, s.receiver_tag AS tag
           FROM lead_shares s
          WHERE s.tag_added AND s.undone_at IS NOT NULL AND s.tag_removed_at IS NULL
          ORDER BY s.lead_id, s.id
          LIMIT $1
       ), untagged AS (
         UPDATE public.leads l SET tags = public.fn_remove_tag(l.tags, t.tag)
           FROM todo t
          WHERE l.id = t.lead_id AND public.fn_remove_tag(l.tags, t.tag) IS DISTINCT FROM l.tags
         RETURNING l.id
       ), h AS (
         INSERT INTO lead_history (lead_id, event_type, notes)
         SELECT t.lead_id, 'updated', 'Share from ' || t.origin_tag || ' to ' || t.tag || ' undone: tag ' || t.tag || ' removed (overlap sharing)'
           FROM todo t JOIN untagged u ON u.id = t.lead_id
       ), marked AS (
         UPDATE lead_shares s SET tag_removed_at = now() FROM todo t WHERE s.id = t.id RETURNING s.id
       )
       SELECT (SELECT count(*) FROM untagged)::int AS written, (SELECT count(*) FROM marked)::int AS taken`,
      [limit]
    );
    return r;
  });
}

/**
 * One round of the tag writer: removals first (an undo), then adds while
 * write_tags is on, within TAG_ROWS_PER_MINUTE and what is left of
 * tag_rows_per_day. Counts rows taken against the pace and tags written or
 * taken off against the day.
 *
 * @param {Pool} pool
 * @param {{ settings: PipelineSettings, memory: UpkeepMemory, perRound?: number }} opts
 * @returns {Promise<{ added: number, removed: number, left: number }>}  left: what today's cap still allows
 */
export async function writeTags(pool, { settings, memory, perRound = TAG_ROWS_PER_MINUTE }) {
  const out = { added: 0, removed: 0, left: 0 };
  const cap = settings.overlap_sharing.tag_rows_per_day;
  const { rows: [work] } = await read(
    pool,
    `SELECT EXISTS (SELECT 1 FROM lead_shares WHERE tag_added AND undone_at IS NOT NULL AND tag_removed_at IS NULL) AS undo,
            EXISTS (SELECT 1 FROM lead_shares
                     WHERE outcome = 'shared' AND applied_at IS NOT NULL AND undone_at IS NULL AND NOT tag_added AND tag_added_at IS NULL) AS add`
  );
  const adding = work.add && flagOn(settings, "share_tag_writes", "");
  if (!work.undo && !adding) return out;
  const day = await tagsToday(pool, memory);
  let pace = perRound;
  const room = () => Math.max(0, Math.min(pace, cap - day.used));
  while (work.undo && room() > 0) {
    const r = await removeTags(pool, room());
    pace -= r.taken;
    day.used += r.written;
    out.removed += r.written;
    if (r.taken === 0) break;
  }
  while (adding && room() > 0) {
    const r = await addTags(pool, room());
    pace -= r.taken;
    day.used += r.written;
    out.added += r.written;
    if (r.taken === 0) break;
  }
  out.left = Math.max(0, cap - day.used);
  return out;
}

// ── Prune ───────────────────────────────────────────────────────────────────

/**
 * At most hourly. Lead lists (upload_batch_leads) go LEAD_LIST_PRUNE_DAYS after
 * their job is done (skipped or with no list: made; decided: decided, applied
 * or undone, and no recheck still ahead), and those of batches that never got
 * a job; a job in error, waiting or deciding keeps its list. Rows that are not
 * shares go SHARE_ROW_PRUNE_DAYS after they were decided; share rows stay,
 * since dedupe and undo read them.
 *
 * @param {Pool} pool
 * @param {{ memory: UpkeepMemory, now?: () => number, force?: boolean }} opts
 * @returns {Promise<{ lists: number, rows: number } | null>}  null: not due
 */
export async function prune(pool, { memory, now = Date.now, force = false }) {
  if (!force && now() - memory.prunedAt < HOUR_MS) return null;
  memory.prunedAt = now();
  // Batches are few beside their lists: each is probed by the list's primary key.
  const { rows: old } = await read(
    pool,
    `SELECT b.id AS batch_id
       FROM upload_batches b
       LEFT JOIN share_jobs j ON j.batch_id = b.id
      WHERE EXISTS (SELECT 1 FROM upload_batch_leads u WHERE u.batch_id = b.id)
        AND CASE
              WHEN j.batch_id IS NULL THEN b.created_at < now() - make_interval(days => $1)
              WHEN j.state IN ('skipped', 'no_lead_list') THEN j.created_at < now() - make_interval(days => $1)
              WHEN j.state IN ('previewed', 'applied', 'undone')
                THEN coalesce(j.undone_at, j.applied_at, j.decided_at, j.created_at) < now() - make_interval(days => $1)
                     AND (j.recheck_until IS NULL OR j.recheck_until < now())
              ELSE false
            END`,
    [LEAD_LIST_PRUNE_DAYS]
  );
  let lists = 0;
  for (const { batch_id: id } of old) {
    const { rowCount } = await inTx(pool, (c) => c.query(`DELETE FROM upload_batch_leads WHERE batch_id = $1`, [id]));
    lists += rowCount ?? 0;
  }
  let rows = 0;
  for (;;) {
    const { rowCount } = await inTx(pool, (c) =>
      c.query(
        `DELETE FROM lead_shares WHERE id IN (
           SELECT id FROM lead_shares
            WHERE outcome NOT IN ('shared', 'own_topup') AND decided_at < now() - make_interval(days => $1)
            LIMIT $2)`,
        [SHARE_ROW_PRUNE_DAYS, PRUNE_CHUNK]
      )
    );
    rows += rowCount ?? 0;
    if ((rowCount ?? 0) < PRUNE_CHUNK) break;
  }
  return { lists, rows };
}
