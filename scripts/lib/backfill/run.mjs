// One firing of the database backfill (migration 138; contract 3.7 to 3.11),
// as the backfill-worker cron (scripts/backfill-worker.mjs) and the tests call
// it, and the read-only preview of one client for the Sharing page's Backfill
// tab.
//
// A firing, for each client on database_backfill.tags that may receive (in a
// sharing pool, able to receive, with places, under today's push cap and, in
// apply mode, on overlap sharing's push list), reads its places' leads a
// window at a time from its cursors, decides each window (decide.mjs) and, in
// apply mode, queues the fitting leads as shares of the firing's one share
// job: lead_shares rows with outcome shared, applied, push_state queued.
// The share step's push timer and the share push (src/lib/sharing/push.ts)
// take them from there, as they take any share. Nothing else is new.
//
//   Caps        a client a firing: overlap_sharing.push_max_per_job; a
//               client a UTC day: overlap_sharing.push_max_per_day, counted
//               as capCheck counts it (rows applied today with a push state,
//               every source), read again under the client's lock before each
//               write; a firing: database_backfill.max_per_run; and time:
//               max_minutes, each client at most max(60 s, time left / clients
//               left). A cap reached in a window writes only what it allows, in
//               id order, and leaves the window unpassed: the next firing reads
//               it again (what was written there is already_shared then).
//   Writes      per client per window, one transaction under
//               pg_advisory_xact_lock(hashtext('share-backfill:' || tag)), the
//               switch, the push list and the receive rule read again first.
//               The firing's first write makes its upload_batches row (type
//               backfill) and share_jobs row (kind backfill, origin DATABASE,
//               applied). A firing that shares nothing makes neither.
//   Preview     mode preview, or --preview: the same reading and deciding,
//               nothing written but the run row; cursors untouched.
//   The run     share_backfill_runs: made at the start, its counts per client
//               written after each client, closed done, stopped (time,
//               run_cap, switched_off) or error (one line, never an email).

import { clientPool, flagOn, settingsFrom } from "../enrich/settings.mjs";
import { minimumOf } from "../coverage.mjs";
import { inTx, read, UTC_DAY_START } from "../share/db.mjs";
import {
  BACKFILL_BATCH_TYPE, BACKFILL_JOB_KIND, BACKFILL_LOCK_KEY, BACKFILL_ORIGIN, BACKFILL_SOURCE_LABEL, backfillFrom, backfillOn, backfillTag,
} from "./settings.mjs";
import { cityIdsOf, coverageOf, cursorsOf, orderClients, orderPlaces, passOf, placesOf, readReceivers, servedAtOf, windowBounds, windowsFor } from "./places.mjs";
import { BACKFILL_REASONS, countPlace, decideWindow, readWindow, WINDOW_TIMEOUT } from "./decide.mjs";

/**
 * @typedef {import("../share/db.mjs").Pool} Pool
 * @typedef {import("../share/db.mjs").Db} Db
 * @typedef {import("./places.mjs").RankedPlace} RankedPlace
 * @typedef {import("./places.mjs").ReceiverRow} ReceiverRow
 * @typedef {"run" | "day" | "run_total" | "time"} Capped
 */

/** How long a firing's lease holds (the worker's watchdog ends it at 50 minutes). */
const LEASE_MINUTES = 55;
/** The least time a client gets, whatever is left of the firing. */
const CLIENT_MIN_MS = 60_000;
/** Each write transaction's limit. */
const WRITE_TIMEOUT = "60s";
/** How old the newest run may be while the backfill is on before the tab warns (hours). */
export const BACKFILL_STALE_HOURS = 2;

/** Rows of the receiver applied since the UTC day began with a push state, every source (capCheck, scripts/lib/share/jobs.mjs). */
export const DAY_COUNT_SQL = `SELECT count(*)::int AS n FROM lead_shares
  WHERE receiver_tag = $1 AND applied_at >= ${UTC_DAY_START} AND push_state IS NOT NULL`;

/** A Db whose every statement runs in a read-only transaction of its own. */
const reader = (pool) => ({ query: (sql, params = []) => read(pool, sql, params) });

/**
 * The room the three caps leave, and which one binds (the smallest; on a tie
 * the firing's cap, then the day's, then the client's a firing).
 *
 * @param {{ job: number, day: number, run: number }} left  what each cap leaves
 * @returns {{ room: number, cap: Capped }}
 */
export function roomOf(left) {
  const m = Math.min(left.job, left.day, left.run);
  return { room: Math.max(0, m), cap: m === left.run ? "run_total" : m === left.day ? "day" : "run" };
}

/** An error in one line, with anything shaped like an email taken out, at most 300 characters. */
export function oneLine(e) {
  const m = String(/** @type {Error} */ (e)?.message ?? e).replace(/\s+/g, " ").trim();
  return m.replace(/[^\s@<>"']+@[^\s@<>"']+/g, "<email>").slice(0, 300) || "unknown error";
}

/**
 * Is 138 there: both tables and share_jobs.kind.
 *
 * @param {Db} db
 * @returns {Promise<boolean>}
 */
export async function backfillReady(db) {
  const { rows: [r] } = await db.query(
    `SELECT to_regclass('public.share_backfill_runs') IS NOT NULL AND to_regclass('public.share_backfill_cursors') IS NOT NULL
            AND EXISTS (SELECT 1 FROM information_schema.columns
                         WHERE table_schema = 'public' AND table_name = 'share_jobs' AND column_name = 'kind') AS ok`
  );
  return r?.ok === true;
}

/**
 * The worker's lease: a worker_locks row under BACKFILL_LOCK_KEY for 55
 * minutes (not an advisory lock: DATABASE_URL is the transaction pooler), as
 * the topup-worker's (scripts/lib/topup/run.mjs). True when this owner holds it.
 *
 * @param {Db} db
 * @param {string} owner  a random id for this firing
 */
export async function acquireLease(db, owner) {
  const { rows } = await db.query(
    `INSERT INTO worker_locks (key, owner, locked_until) VALUES ($1, $2, now() + make_interval(mins => $3))
     ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, locked_until = EXCLUDED.locked_until
       WHERE worker_locks.locked_until < now()
     RETURNING owner`,
    [BACKFILL_LOCK_KEY, owner, LEASE_MINUTES]
  );
  return rows.length > 0;
}

/** Gives the lease back (only this owner's). */
export async function releaseLease(db, owner) {
  await db.query(`DELETE FROM worker_locks WHERE key = $1 AND owner = $2`, [BACKFILL_LOCK_KEY, owner]);
}

// ── What a firing reads first ──────────────────────────────────────────────

/** The settings as stored now (all rows: overlap_sharing, weekly_topup, never_contact_inboxes, database_backfill). */
async function readContext(pool) {
  const { rows } = await read(pool, `SELECT key, value FROM enrich_settings`);
  const settings = settingsFrom(rows);
  return { settings, bf: backfillFrom(rows), pattern: settings.never_contact_inboxes?.pattern ?? null };
}

/** Every client's type and Bison group, once a firing: whose leads a lead's tags name, and their pools. */
async function allClients(pool) {
  const { rows } = await read(pool, `SELECT tag, client_type, group_no FROM client_tags`);
  return new Map(rows.map((r) => [r.tag, { tag: r.tag, client_type: r.client_type ?? null, group_no: r.group_no ?? null }]));
}

/**
 * @typedef {{ tag: string, receiver: ReceiverRow | null, places: RankedPlace[], unresolved: Array<{ key: string, label: string }>,
 *             minimum: number, pool: string | null, pushList: boolean, onList: boolean, lowPlaces: number, servedAt: number | null }} ClientFacts
 */

/**
 * The listed clients as the firing serves them: their receive rule, pool,
 * places in reading order (with available and low from the stored coverage),
 * minimum, push list and when they were last served.
 *
 * @param {Pool} pool
 * @param {string[]} tags
 * @param {{ settings: any, bf: import("./settings.mjs").DatabaseBackfill }} ctx
 * @returns {Promise<{ facts: ClientFacts[], geoIds: Map<string, Set<string>> }>}
 */
export async function clientFacts(pool, tags, { settings, bf }) {
  const db = reader(pool);
  const receivers = await readReceivers(db, tags);
  const known = [...receivers.keys()];
  const geoIds = await cityIdsOf(db, known);
  const coverage = await coverageOf(db, known);
  const served = await servedAtOf(db, known);
  /** @type {ClientFacts[]} */
  const facts = tags.map((tag) => {
    const r = receivers.get(tag) ?? null;
    const { places, unresolved } = r ? placesOf(tag, r.include_locations, geoIds) : { places: [], unresolved: [] };
    const { minimum } = minimumOf({ own: r?.min_leads_per_place ?? null, defaultMinimum: settings.weekly_topup.default_minimum });
    const ranked = orderPlaces(places, coverage.get(tag), minimum);
    return {
      tag,
      receiver: r,
      places: ranked,
      unresolved,
      minimum,
      pool: r ? clientPool(settings, tag, r.client_type) : null,
      pushList: flagOn(settings, "share_push", tag),
      onList: backfillOn(bf, tag),
      lowPlaces: ranked.filter((p) => p.low).length,
      servedAt: served.get(tag) ?? null,
    };
  });
  return { facts, geoIds };
}

/**
 * Why a client is not served, in the order the firing asks (contract 3.3);
 * null when it is. In preview a client off the push list (or off the list,
 * for --tag) is still read: its counts say so.
 *
 * @param {ClientFacts} f
 * @param {{ mode: "preview" | "apply" }} opts
 */
export function skipOf(f, { mode }) {
  if (!f.receiver) return "not a client";
  if (mode === "apply" && !f.onList) return "not on the backfill list";
  if (f.receiver.block) return `cannot receive: ${f.receiver.block}`;
  if (!f.pool) return "isolated";
  if (mode === "apply" && !f.pushList) return "not on the push list";
  if (!f.places.length) return "no places";
  return null;
}

// ── Writing (apply mode) ───────────────────────────────────────────────────

/** A place's new pass, written in apply mode: windows from its leads now, counts reset. */
async function startPass(pool, { tag, place, windows, rows, rulesAt }) {
  await inTx(
    pool,
    (c) =>
      c.query(
        `INSERT INTO share_backfill_cursors (receiver_tag, place_key, windows, next_window, place_rows, rules_at, pass_started_at, pass_done_at,
                                             checked, fits, shared)
         VALUES ($1, $2, $3, 0, $4, $5::timestamptz, now(), NULL, 0, 0, 0)
         ON CONFLICT (receiver_tag, place_key) DO UPDATE
            SET windows = EXCLUDED.windows, next_window = 0, place_rows = EXCLUDED.place_rows, rules_at = EXCLUDED.rules_at,
                pass_started_at = now(), pass_done_at = NULL, checked = 0, fits = 0, shared = 0`,
        [tag, place.key, windows, rows, rulesAt]
      ),
    { timeout: WRITE_TIMEOUT }
  );
}

/** The firing's batch and job, made by its first write, inside that write's transaction. */
async function makeJob(c, { runId, originPool }) {
  const { rows: [b] } = await c.query(
    `INSERT INTO upload_batches (batch_type, status, source_label, total_rows, processed_rows, inserted_rows, created_at, completed_at)
     VALUES ($1, 'complete', $2, 0, 0, 0, now(), now()) RETURNING id`,
    [BACKFILL_BATCH_TYPE, BACKFILL_SOURCE_LABEL]
  );
  await c.query(
    `INSERT INTO share_jobs (batch_id, origin_tag, origin_pool, state, topup, mode, kind, batch_done_at, decided_at, applied_at, new_leads)
     VALUES ($1, $2, $3, 'applied', false, 'apply', $4, now(), now(), now(), 0)`,
    [b.id, BACKFILL_ORIGIN, originPool, BACKFILL_JOB_KIND]
  );
  if (runId) await c.query(`UPDATE share_backfill_runs SET batch_id = $2 WHERE id = $1`, [runId, b.id]);
  return /** @type {string} */ (b.id);
}

const INSERT_SHARES = `
  INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, matched_place, decided_at, applied_at, applied_by, push_state)
  SELECT $1, x.lead_id, $3, $2, 'shared', x.place, now(), now(), NULL, 'queued'
    FROM jsonb_to_recordset($4::jsonb) AS x(lead_id uuid, place jsonb)
   WHERE NOT EXISTS (SELECT 1 FROM lead_shares s WHERE s.lead_id = x.lead_id AND s.receiver_tag = $2)
  ON CONFLICT (batch_id, lead_id, receiver_tag) DO NOTHING
  RETURNING lead_id::text AS lead_id`;

/**
 * One window's write for one client (contract 3.8): under the client's lock
 * the switch, the push list and the receive rule are read again, the caps
 * worked out with today's count read again, as many shares written as they
 * allow (in id order), and the cursor moved on unless a cap stopped the
 * window. Answers what was written, or why nothing could be.
 *
 * @param {Pool} pool
 * @param {{ tag: string, place: RankedPlace, window: number, decision: import("./decide.mjs").WindowDecision,
 *           caps: { job: number, day: number, run: number }, clientShared: number, firing: Firing,
 *           countsWith: (written: number) => Record<string, unknown> }} p
 * @returns {Promise<{ written: string[], capped: Capped | null, created: string | null, stop: string | null, skip: string | null }>}
 */
async function writeWindow(pool, { tag, place, window, decision, caps, clientShared, firing, countsWith }) {
  return inTx(
    pool,
    async (c) => {
      const none = { written: [], capped: null, created: null, stop: null, skip: null };
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('share-backfill:' || $1))`, [tag]);
      const { rows: srows } = await c.query(`SELECT key, value FROM enrich_settings`);
      const settings = settingsFrom(srows);
      const bf = backfillFrom(srows);
      if (!bf.enabled || bf.mode !== "apply") return { ...none, stop: "switched_off" };
      if (!backfillOn(bf, tag)) return { ...none, skip: "taken off the backfill list" };
      if (!flagOn(settings, "share_push", tag)) return { ...none, skip: "not on the push list" };
      const { rows: [g] } = await c.query(`SELECT public.fn_client_receive_block($1) AS block`, [tag]);
      if (g?.block) return { ...none, skip: `cannot receive: ${g.block}` };

      let take = decision.shared;
      /** @type {Capped | null} */
      let capped = null;
      if (take.length) {
        const { rows: [t] } = await c.query(DAY_COUNT_SQL, [tag]);
        const left = roomOf({ job: caps.job - clientShared, day: caps.day - Number(t?.n ?? 0), run: caps.run - firing.shared });
        if (take.length > left.room) {
          capped = left.cap;
          take = take.slice(0, left.room);
        }
      }
      /** @type {string[]} */
      let written = [];
      let created = null;
      if (take.length) {
        let batchId = firing.batchId;
        if (!batchId) {
          batchId = await makeJob(c, { runId: firing.runId, originPool: firing.originPool });
          created = batchId;
        }
        const { rows } = await c.query(INSERT_SHARES, [batchId, tag, BACKFILL_ORIGIN, JSON.stringify(take.map((s) => ({ lead_id: s.id, place: s.place })))]);
        written = rows.map((r) => r.lead_id);
        if (written.length) {
          await c.query(
            `UPDATE share_jobs
                SET counts = jsonb_set(counts, ARRAY[$2::text], $3::jsonb, true),
                    new_leads = (SELECT count(DISTINCT s.lead_id)::int FROM lead_shares s WHERE s.batch_id = $1),
                    receivers = CASE WHEN $2 = ANY(receivers) THEN receivers ELSE array_append(receivers, $2::text) END,
                    receivers_done = CASE WHEN $2 = ANY(receivers_done) THEN receivers_done ELSE array_append(receivers_done, $2::text) END,
                    receivers_applied = CASE WHEN $2 = ANY(receivers_applied) THEN receivers_applied ELSE array_append(receivers_applied, $2::text) END
              WHERE batch_id = $1`,
            [batchId, tag, JSON.stringify(countsWith(written.length))]
          );
        }
      }
      // The cursor: passed (and the pass done after its last window) unless a cap stopped it.
      const { rowCount } = await c.query(
        capped
          ? `UPDATE share_backfill_cursors SET shared = shared + $4 WHERE receiver_tag = $1 AND place_key = $2 AND next_window = $3`
          : `UPDATE share_backfill_cursors
                SET next_window = next_window + 1, checked = checked + $5, fits = fits + $6, shared = shared + $4,
                    pass_done_at = CASE WHEN next_window + 1 >= windows THEN now() ELSE pass_done_at END
              WHERE receiver_tag = $1 AND place_key = $2 AND next_window = $3`,
        capped ? [tag, place.key, window, written.length] : [tag, place.key, window, written.length, decision.checked, decision.fits]
      );
      if (!rowCount) throw new Error(`the cursor of ${tag}'s place ${place.label} moved meanwhile`);
      return { written, capped, created, stop: null, skip: null };
    },
    { timeout: WRITE_TIMEOUT }
  );
}

// ── One client ─────────────────────────────────────────────────────────────

/**
 * @typedef {{ shared: number, batchId: string | null, runId: string | null, originPool: string | null, stop: string | null }} Firing
 * @typedef {{ key: string, label: string, kind: "city" | "state", low: boolean, available: number | null, pass: string,
 *             windows: number | null, nextWindow: number | null, windowsRead: number, passDoneAt: string | null,
 *             checked: number, fits: number, shares: number, reasons: Record<string, number>, capped: Capped | null }} PlaceDetail
 */

const iso = (v) => (v == null ? null : new Date(v).toISOString());
const zeroReasons = () => Object.fromEntries(BACKFILL_REASONS.map((k) => [k, 0]));

/**
 * Serves one client: its places in order, a window at a time from its
 * cursors, within the caps and the client's time. In apply mode it writes
 * (writeWindow); in preview it counts what would be written.
 *
 * @param {Pool} pool
 * @param {{ settings: any, bf: import("./settings.mjs").DatabaseBackfill, pattern: string | null, clients: Map<string, any>,
 *           geoIds: Map<string, Set<string>> }} ctx
 * @param {ClientFacts} f
 * @param {{ mode: "preview" | "apply", deadline: number, firing: Firing, now: () => number, timeoutFor?: () => string }} opts
 * @returns {Promise<{ counts: Record<string, any>, places: PlaceDetail[], today: number, capped: Capped | null }>}
 */
export async function serveClient(pool, ctx, f, { mode, deadline, firing, now, timeoutFor = () => WINDOW_TIMEOUT }) {
  const started = now();
  const tag = f.tag;
  const receiver = /** @type {ReceiverRow} */ (f.receiver);
  const os = ctx.settings.overlap_sharing;
  const caps = { job: os.push_max_per_job, day: os.push_max_per_day, run: ctx.bf.max_per_run };
  const shareKey = mode === "apply" ? "shared" : "would_share";
  /** @type {Record<string, any>} */
  const counts = {
    places: f.places.length, low_places: f.lowPlaces, unresolved_places: f.unresolved.length, windows: 0, checked: 0, fits: 0,
    [shareKey]: 0, ...zeroReasons(),
  };
  if (!f.pushList) counts.push_list = false;
  if (!f.onList) counts.on_list = false;
  /** @type {PlaceDetail[]} */
  const details = [];
  const { rows: [t] } = await read(pool, DAY_COUNT_SQL, [tag]);
  const today = Number(t?.n ?? 0);
  const finish = (capped) => {
    if (capped) counts.capped = capped;
    counts.ms = now() - started;
    return { counts, places: details, today, capped };
  };
  if (today >= caps.day) {
    counts.skipped = "day cap reached";
    return finish(null);
  }

  const cursors = await cursorsOf(reader(pool), tag, ctx.bf.recheck_days);
  if (mode === "apply") {
    // A place no longer on the client's list: its cursor goes.
    await inTx(pool, (c) =>
      c.query(`DELETE FROM share_backfill_cursors WHERE receiver_tag = $1 AND NOT (place_key = ANY($2::text[]))`, [tag, f.places.map((p) => p.key)])
    );
  }
  const dctx = { settings: ctx.settings, untagged: ctx.bf.untagged, clients: ctx.clients, pattern: ctx.pattern, geoIds: ctx.geoIds };
  const seen = new Set();
  let shared = 0; // this client, this firing
  /** @type {Capped | null} */
  let capped = null;

  places: for (const place of f.places) {
    const cur = cursors.get(place.key);
    const pass = passOf(cur);
    /** @type {PlaceDetail} */
    const d = {
      key: place.key, label: place.label, kind: place.kind, low: place.low, available: place.available, pass,
      windows: cur?.windows ?? null, nextWindow: cur ? cur.next_window : null, windowsRead: 0, passDoneAt: iso(cur?.pass_done_at),
      checked: 0, fits: 0, shares: 0, reasons: zeroReasons(), capped: null,
    };
    details.push(d);
    if (pass === "done") continue;
    if (now() >= deadline) {
      capped = d.capped = "time";
      break;
    }
    // No room left: the place is not started (no pass, no cursor) until a later firing.
    const room0 = roomOf({ job: caps.job - shared, day: caps.day - today - shared, run: caps.run - firing.shared });
    if (room0.room <= 0) {
      capped = d.capped = room0.cap;
      break;
    }
    let windows = /** @type {number} */ (cur?.windows ?? 1);
    let next = /** @type {number} */ (cur?.next_window ?? 0);
    if (pass !== "continue") {
      const rows = await countPlace(pool, place, { timeout: timeoutFor() });
      windows = windowsFor(rows);
      next = 0;
      if (mode === "apply") await startPass(pool, { tag, place, windows, rows, rulesAt: receiver.rules_at });
    }
    d.windows = windows;
    d.nextWindow = next;
    for (let w = next; w < windows; w++) {
      if (now() >= deadline) {
        capped = d.capped = "time";
        break places;
      }
      const left = roomOf({ job: caps.job - shared, day: caps.day - today - shared, run: caps.run - firing.shared });
      if (left.room <= 0) {
        capped = d.capped = left.cap;
        break places;
      }
      const rows = await readWindow(pool, { place, bounds: windowBounds(windows, w), receiver: tag, timeout: timeoutFor() });
      const decision = await decideWindow(pool, { receiver, rows, ctx: dctx, seen });
      counts.windows++;
      d.windowsRead++;
      counts.checked += decision.checked;
      counts.fits += decision.fits;
      d.checked += decision.checked;
      d.fits += decision.fits;
      for (const k of BACKFILL_REASONS) {
        counts[k] += decision.reasons[k] ?? 0;
        d.reasons[k] += decision.reasons[k] ?? 0;
      }
      /** @type {string[]} */
      let took = [];
      /** @type {Capped | null} */
      let cap = null;
      if (mode === "apply") {
        const r = await writeWindow(pool, {
          tag, place, window: w, decision, caps, clientShared: shared, firing,
          // share_jobs.counts[receiver]: { checked, fits, shared, <reason>: n } of this client in this firing.
          countsWith: (n) => {
            /** @type {Record<string, number>} */
            const o = { checked: counts.checked, fits: counts.fits, shared: counts.shared + n };
            for (const k of BACKFILL_REASONS) if (counts[k]) o[k] = counts[k];
            return o;
          },
        });
        if (r.created) firing.batchId = r.created;
        if (r.stop) {
          firing.stop = r.stop;
          break places;
        }
        if (r.skip) {
          counts.skipped = r.skip;
          break places;
        }
        took = r.written;
        cap = r.capped;
      } else {
        took = decision.shared.slice(0, left.room).map((s) => s.id);
        if (decision.shared.length > left.room) cap = left.cap;
      }
      for (const id of took) seen.add(id);
      shared += took.length;
      firing.shared += took.length;
      counts[shareKey] += took.length;
      d.shares += took.length;
      if (cap) {
        capped = d.capped = cap;
        break places;
      }
      if (w + 1 >= windows) d.passDoneAt = mode === "apply" ? new Date().toISOString() : null;
    }
  }
  return finish(capped);
}

// ── One firing ─────────────────────────────────────────────────────────────

const NUMERIC_TOTALS = ["places", "low_places", "unresolved_places", "windows", "checked", "fits", "shared", "would_share", ...BACKFILL_REASONS];

/** The run's totals over its clients' counts (a client the firing stopped before is not_reached). */
export function totalsOf(byClient) {
  /** @type {Record<string, number>} */
  const out = { clients: 0, served: 0, skipped: 0, not_reached: 0, capped: 0, errors: 0 };
  for (const k of NUMERIC_TOTALS) out[k] = 0;
  for (const c of Object.values(byClient)) {
    out.clients++;
    if (c.not_reached) out.not_reached++;
    else if (c.skipped) out.skipped++;
    else out.served++;
    if (c.capped) out.capped++;
    if (c.error) out.errors++;
    for (const k of NUMERIC_TOTALS) out[k] += Number(c[k]) || 0;
  }
  return out;
}

async function openRun(pool, mode, receivers) {
  const { rows: [r] } = await inTx(pool, (c) =>
    c.query(`INSERT INTO share_backfill_runs (mode, receivers) VALUES ($1, $2::text[]) RETURNING id`, [mode, receivers])
  );
  return /** @type {string} */ (r.id);
}

async function noteRun(pool, id, byClient) {
  await inTx(pool, (c) =>
    c.query(`UPDATE share_backfill_runs SET counts = $2::jsonb, totals = $3::jsonb WHERE id = $1`, [id, JSON.stringify(byClient), JSON.stringify(totalsOf(byClient))])
  );
}

async function closeRun(pool, id, { state, stopReason = null, byClient, error = null }) {
  await inTx(pool, (c) =>
    c.query(
      `UPDATE share_backfill_runs SET state = $2, stop_reason = $3, finished_at = now(), counts = $4::jsonb, totals = $5::jsonb, last_error = $6
        WHERE id = $1`,
      [id, state, stopReason, JSON.stringify(byClient), JSON.stringify(totalsOf(byClient)), error]
    )
  );
}

/** A client's line in the log: counts only, never a lead. */
function clientLine(tag, c, mode) {
  if (c.not_reached) return `backfill: ${tag} not reached (${c.not_reached})`;
  if (c.skipped) return `backfill: ${tag} skipped, ${c.skipped}`;
  if (c.error && c.checked === undefined) return `backfill: ${tag} failed: ${c.error}`;
  const n = mode === "apply" ? `${c.shared} shared` : `${c.would_share} would be shared`;
  return `backfill: ${tag} ${n} (${c.checked} checked, ${c.fits} fit) in ${c.windows} window(s) of ${c.places} place(s)` +
    `${c.capped ? `, stopped by the ${c.capped} cap` : ""}${c.error ? `, error: ${c.error}` : ""}`;
}

/**
 * One firing (contract 3.11).
 *
 * @param {Pool} pool
 * @param {{ deadline?: number, log?: (line: string) => void, preview?: boolean, tag?: string | null, now?: () => number }} [opts]
 *   deadline: when the worker must be done (the setting's max_minutes may end it sooner); preview: write only the run row;
 *   tag: only this client
 * @returns {Promise<{ ready: boolean, state: "not_ready" | "off" | "done" | "stopped" | "error", run: string | null,
 *                     totals: Record<string, number> | null, stopReason: string | null }>}
 */
export async function backfillOnce(pool, { deadline = Number.POSITIVE_INFINITY, log = () => {}, preview = false, tag = null, now = Date.now } = {}) {
  const started = now();
  if (!(await backfillReady(pool))) {
    log("backfill: the backfill tables are not there (migration 138): nothing to do");
    return { ready: false, state: "not_ready", run: null, totals: null, stopReason: null };
  }
  const ctx0 = await readContext(pool);
  const { settings, bf } = ctx0;
  if (!bf.enabled && !preview) {
    log("backfill: switched off (database_backfill.enabled is false): nothing to do");
    return { ready: true, state: "off", run: null, totals: null, stopReason: null };
  }
  const mode = preview || bf.mode !== "apply" ? "preview" : "apply";
  const end = Math.min(deadline, started + bf.max_minutes * 60_000);
  const wanted = tag ? [backfillTag(tag)].filter(Boolean) : bf.tags;
  const runId = await openRun(pool, mode, wanted);
  /** @type {Record<string, any>} */
  const byClient = {};
  try {
    const { rows: [clash] } = await read(pool, `SELECT EXISTS (SELECT 1 FROM client_tags WHERE tag = $1) AS taken`, [BACKFILL_ORIGIN]);
    if (clash?.taken) {
      await closeRun(pool, runId, { state: "error", byClient, error: `a client is tagged ${BACKFILL_ORIGIN}` });
      log(`backfill: a client is tagged ${BACKFILL_ORIGIN}, so the firing stopped: rename that client first`);
      return { ready: true, state: "error", run: runId, totals: totalsOf(byClient), stopReason: null };
    }
    const clients = await allClients(pool);
    const { facts, geoIds } = await clientFacts(pool, wanted, { settings, bf });
    const ctx = { ...ctx0, clients, geoIds };
    /** @type {ClientFacts[]} */
    const serve = [];
    for (const f of facts) {
      const why = skipOf(f, { mode });
      if (why) {
        byClient[f.tag] = { skipped: why };
        log(`backfill: ${f.tag} skipped, ${why}`);
      } else {
        serve.push(f);
      }
    }
    if (Object.keys(byClient).length) await noteRun(pool, runId, byClient);
    const order = orderClients(serve);
    /** @type {Firing} */
    const firing = { shared: 0, batchId: null, runId: mode === "apply" ? runId : null, originPool: order[0]?.pool ?? null, stop: null };
    let stopReason = null;
    let firstError = null;
    for (let i = 0; i < order.length; i++) {
      const f = order[i];
      if (now() >= end) {
        stopReason = "time";
        break;
      }
      if (firing.shared >= bf.max_per_run) {
        stopReason = "run_cap";
        break;
      }
      const left = end - now();
      const clientEnd = Math.min(end, now() + Math.max(CLIENT_MIN_MS, left / (order.length - i)));
      try {
        const res = await serveClient(pool, ctx, f, { mode, deadline: clientEnd, firing, now });
        byClient[f.tag] = res.counts;
        if (res.capped === "run_total") stopReason = "run_cap";
        else if (res.capped === "time" && now() >= end) stopReason = "time";
      } catch (e) {
        const line = oneLine(e);
        byClient[f.tag] = { ...(byClient[f.tag] ?? {}), error: line };
        firstError = firstError ?? `${f.tag}: ${line}`;
      }
      log(clientLine(f.tag, byClient[f.tag], mode));
      await noteRun(pool, runId, byClient);
      if (firing.stop) {
        stopReason = firing.stop;
        break;
      }
      if (stopReason) break;
    }
    if (stopReason) {
      // The clients the firing stopped before: the next firing serves them (the least recently served first).
      for (const f of order) if (!byClient[f.tag]) byClient[f.tag] = { not_reached: stopReason };
    }
    const state = stopReason ? "stopped" : "done";
    await closeRun(pool, runId, { state, stopReason, byClient, error: firstError });
    const totals = totalsOf(byClient);
    log(`backfill: ${mode} firing ${state}${stopReason ? ` (${stopReason})` : ""}: ${totals.served} client(s) served, ` +
      `${mode === "apply" ? `${totals.shared} shared` : `${totals.would_share} would be shared`}, ${totals.skipped} skipped` +
      `${firing.batchId ? `, job ${firing.batchId.slice(0, 8)}` : ""}`);
    return { ready: true, state, run: runId, totals, stopReason };
  } catch (e) {
    const line = oneLine(e);
    await closeRun(pool, runId, { state: "error", byClient, error: line }).catch(() => {});
    log(`backfill: the firing failed: ${line}`);
    return { ready: true, state: "error", run: runId, totals: totalsOf(byClient), stopReason: null };
  }
}

// ── The tab's preview ──────────────────────────────────────────────────────

/** A statement the preview's own budget stopped (statement_timeout). */
const isTimeout = (e) => /** @type {{ code?: string }} */ (e)?.code === "57014";

/**
 * One client, read only, no run row, from its cursors: per place what the
 * next apply firing would read and share (within today's caps), each reason,
 * and why the client would be skipped. Stops at budgetMs (timedOut).
 *
 * @param {Pool} pool
 * @param {{ tag: string, budgetMs?: number, now?: () => number }} opts
 */
export async function previewBackfill(pool, { tag, budgetMs = 25_000, now = Date.now }) {
  const started = now();
  const t = backfillTag(tag);
  if (!(await backfillReady(pool))) return { ready: false, tag: t };
  const ctx0 = await readContext(pool);
  const { settings, bf } = ctx0;
  const os = settings.overlap_sharing;
  const clients = await allClients(pool);
  const { facts, geoIds } = await clientFacts(pool, [t], { settings, bf });
  const f = facts[0];
  const base = {
    ready: true,
    tag: t,
    enabled: bf.enabled,
    mode: bf.mode,
    onList: f.onList,
    pushList: f.pushList,
    pool: f.pool,
    receiveBlock: f.receiver?.block ?? null,
    minimum: f.minimum,
    caps: { perClientFiring: os.push_max_per_job, perClientDay: os.push_max_per_day, perFiring: bf.max_per_run },
    unresolved: f.unresolved.map((u) => u.label),
    skip: skipOf(f, { mode: "preview" }),
    today: null,
    places: /** @type {PlaceDetail[]} */ ([]),
    counts: /** @type {Record<string, any> | null} */ (null),
    capped: /** @type {Capped | null} */ (null),
    timedOut: false,
    ms: 0,
  };
  if (base.skip) return { ...base, ms: now() - started };
  const deadline = started + budgetMs;
  const firing = { shared: 0, batchId: null, runId: null, originPool: null, stop: null };
  try {
    const res = await serveClient(pool, { ...ctx0, clients, geoIds }, f, {
      mode: "preview", deadline, firing, now, timeoutFor: () => `${Math.max(1000, Math.floor(deadline - now()))}ms`,
    });
    return {
      ...base, skip: res.counts.skipped ?? null, today: res.today, places: res.places, counts: res.counts, capped: res.capped,
      timedOut: res.capped === "time", ms: now() - started,
    };
  } catch (e) {
    if (isTimeout(e)) return { ...base, timedOut: true, ms: now() - started };
    throw e;
  }
}
