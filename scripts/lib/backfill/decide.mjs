// What the database backfill decides for one window of one place of one
// receiving client (migration 138; contract 3.6). Reads only; run.mjs writes.
//
//   1. Candidates (candidateSql): the place's contactable leads in the window
//      of lead ids, never one carrying the receiver's tag. A state place reads
//      by idx_leads_state_code, a city place by idx_leads_location_id, with
//      leads_pkey for the id range; no ORDER BY, no LIMIT: the window bounds
//      the work.
//   2. Fit: fn_share_fits(ids, receiver) (134), 2,000 ids a call: the
//      receiver's own rules, the share extras and the receive rule.
//   3. Pools, from the lead's tags (the ones that are client tags are its
//      owners): other_pool (an owner in another pool, isolated included);
//      untagged_off (no owner while database_backfill.untagged is off).
//   4. Why not (backfillReasonsSql), the first that applies, as sharing's
//      reasons read them (scripts/lib/share/decide.mjs reasonsSql):
//        filtered_inbox  a general inbox the loaded Clay filter matches
//        already_sent    a push item sent in a push for the receiver
//        in_flight       an item pending or pushing in a push being gathered
//                        or processed, or a live push's selected ids
//        already_shared  ANY lead_shares row of the lead for the receiver,
//                        whatever its outcome, push state or undo: a lead is
//                        offered to a client once, and an undo is final
//        same_install    the same push tests for another client of the
//                        receiver's Bison group, or a live share of the lead
//                        to one of them (any job)
//   5. The group owner rule (sharing's sameGroupRule): an owner in the
//      receiver's Bison group whose own rules the lead fits
//      (fn_share_rule_fits) keeps it back as same_install.
//   6. Else shared, with the receiver's include entry it matched (the city
//      entry when the lead's location_id is one of its ids, else the state
//      entry), as sharing stores it.

import { clientPool } from "../enrich/settings.mjs";
import { generalInboxMatchSql, SHARE_CHUNK } from "../overlap-topup.mjs";
import { fitsOf, matchPlace } from "../share/decide.mjs";
import { inTx, read, slices, tagTestSql } from "../share/db.mjs";

/**
 * @typedef {import("../share/db.mjs").Pool} Pool
 * @typedef {import("./places.mjs").Place} Place
 * @typedef {{ id: string, tags: string | null, country_code: string | null, state_code: string | null, location_id: string | null }} Candidate
 * @typedef {{ tag: string, client_type: string | null, group_no: number | null }} ClientRow
 * @typedef {{ country: string, state: string, city: string | null, label: string }} MatchedPlace
 */

/** The live states of a push batch that holds its leads in selected_ids before items exist (as decide.mjs). */
const LIVE_BATCH = `('pending', 'scoring', 'gathering')`;
/** The states of a push batch whose pending or pushing items are really in flight (as decide.mjs). */
const WORKING_BATCH = `('gathering', 'processing')`;

/** The limit of a window's candidate statement and of a place's count (contract 3.6). */
export const WINDOW_TIMEOUT = "120s";

/** Why a fitting lead is not shared: every outcome but shared, in the order the run's counts list them. */
export const BACKFILL_REASONS = Object.freeze([
  "filtered_inbox", "already_sent", "in_flight", "already_shared", "other_pool", "untagged_off", "same_install",
]);

/** The share extras of fn_share_rule_fits (134) and coverage's ELIGIBLE (scripts/lib/coverage.mjs), on the alias l. */
const CONTACTABLE = `l.email IS NOT NULL AND l.email <> '' AND l.is_bounced = false AND l.is_suppressed = false
   AND (l.validation_status IN ('valid', 'catch_all') OR l.validation_status IS NULL)
   AND l.location_status IN ('resolved', 'partial')
   AND (l.esp IS NULL OR l.esp <> 'Mimecast')`;

/**
 * The candidate statement of one window: three texts, one with both id
 * bounds, one with the lower bound only (the last window) and one with none
 * (a place read in one window), never "$n IS NULL OR ...".
 *
 * @param {{ city: boolean, bounds: "both" | "lower" | "none" }} shape
 * @returns {string}
 */
export function candidateSql({ city, bounds }) {
  let n = 0;
  const p = () => `$${++n}`;
  const place = city ? `l.location_id = ANY(${p()}::bigint[])` : `l.state_code = ${p()} AND l.country_code = ${p()}`;
  const lo = bounds === "none" ? "" : `\n   AND l.id >= ${p()}::uuid`;
  const hi = bounds === "both" ? ` AND l.id < ${p()}::uuid` : "";
  const tag = p();
  return `SELECT l.id::text AS id, l.tags, l.country_code, l.state_code, l.location_id::text AS location_id
  FROM public.leads l
 WHERE ${place}${lo}${hi}
   AND ${CONTACTABLE}
   AND NOT ${tagTestSql("l", tag)}`;
}

/**
 * The statement and parameters of one window of a place.
 *
 * @param {Place} place
 * @param {{ lo: string | null, hi: string | null }} b  windowBounds()
 * @param {string} receiver
 * @returns {{ sql: string, params: unknown[] }}
 */
export function windowStatement(place, b, receiver) {
  const bounds = b.lo == null ? "none" : b.hi == null ? "lower" : "both";
  const params = place.kind === "city" ? [place.ids] : [place.state, place.country];
  if (bounds !== "none") params.push(b.lo);
  if (bounds === "both") params.push(b.hi);
  params.push(receiver);
  return { sql: candidateSql({ city: place.kind === "city", bounds }), params };
}

/**
 * One window's candidates, in a read-only transaction of their own.
 *
 * @param {Pool} pool
 * @param {{ place: Place, bounds: { lo: string | null, hi: string | null }, receiver: string, timeout?: string }} p
 * @returns {Promise<Candidate[]>}
 */
export async function readWindow(pool, { place, bounds, receiver, timeout = WINDOW_TIMEOUT }) {
  const { sql, params } = windowStatement(place, bounds, receiver);
  const { rows } = await inTx(pool, (c) => c.query(sql, params), { readOnly: true, timeout });
  return rows;
}

/** The count a pass is cut into windows by: index only (idx_leads_location_id, idx_leads_state_code). */
export function placeRowsSql(kind) {
  return kind === "city"
    ? `SELECT count(*)::int AS n FROM public.leads WHERE location_id = ANY($1::bigint[])`
    : `SELECT count(*)::int AS n FROM public.leads WHERE state_code = $1`;
}

/**
 * The leads in a place now (a state place counts other countries' same code
 * too, which only makes its windows smaller).
 *
 * @param {Pool} pool
 * @param {Place} place
 * @param {{ timeout?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function countPlace(pool, place, { timeout = WINDOW_TIMEOUT } = {}) {
  const { rows } = await inTx(pool, (c) => c.query(placeRowsSql(place.kind), [place.kind === "city" ? place.ids : place.state]), {
    readOnly: true,
    timeout,
  });
  return Number(rows[0]?.n ?? 0);
}

/**
 * The client tags a lead carries: its owners. Tags are split on commas,
 * trimmed and upper cased; the ones that are no client (a mail provider, a
 * gone client) are not owners.
 *
 * @param {string | null | undefined} tags  leads.tags
 * @param {Map<string, ClientRow>} clients  every client by tag
 * @returns {string[]}
 */
export function ownersOf(tags, clients) {
  if (!tags) return [];
  const out = [];
  for (const part of String(tags).split(",")) {
    const t = part.trim().toUpperCase();
    if (t && clients.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * The first reason each lead is not shared to the receiver $2, before the
 * group owner rule; null when there is none. $1 the ids (at most 2,000), $3
 * the receiver's Bison group, $4 the Clay General inboxes filter (only in the
 * variant built with it). Anchored on the ids: push_items by lead (068),
 * push_batches by key or by tag (068), lead_shares by lead (134).
 *
 * @param {boolean} withFilter
 */
export function backfillReasonsSql(withFilter) {
  return `
  WITH f AS (SELECT DISTINCT unnest($1::uuid[]) AS id),
  live_mine AS (
    SELECT DISTINCT x.id
      FROM push_batches pb CROSS JOIN LATERAL unnest(pb.selected_ids) AS x(id)
     WHERE pb.client_tag = $2 AND pb.status IN ${LIVE_BATCH} AND x.id IN (SELECT id FROM f)
  ),
  live_group AS (
    SELECT DISTINCT x.id
      FROM push_batches pb
      JOIN client_tags ct ON ct.tag = pb.client_tag
      CROSS JOIN LATERAL unnest(pb.selected_ids) AS x(id)
     WHERE $3::int IS NOT NULL AND ct.group_no = $3::int AND pb.client_tag <> $2 AND pb.status IN ${LIVE_BATCH}
       AND x.id IN (SELECT id FROM f)
  )
  SELECT f.id::text AS lead_id,
         CASE
           ${withFilter ? `WHEN ${generalInboxMatchSql("l", "$4")} THEN 'filtered_inbox'` : ""}
           WHEN EXISTS (SELECT 1 FROM push_items pi JOIN push_batches pb ON pb.id = pi.batch_id
                         WHERE pi.lead_id = f.id AND pb.client_tag = $2 AND pi.status = 'sent') THEN 'already_sent'
           WHEN EXISTS (SELECT 1 FROM push_items pi JOIN push_batches pb ON pb.id = pi.batch_id
                         WHERE pi.lead_id = f.id AND pb.client_tag = $2 AND pi.status IN ('pending', 'pushing')
                           AND pb.status IN ${WORKING_BATCH})
             OR f.id IN (SELECT id FROM live_mine) THEN 'in_flight'
           WHEN EXISTS (SELECT 1 FROM lead_shares s WHERE s.lead_id = f.id AND s.receiver_tag = $2) THEN 'already_shared'
           WHEN $3::int IS NOT NULL
                AND (EXISTS (SELECT 1 FROM push_items pi JOIN push_batches pb ON pb.id = pi.batch_id
                               JOIN client_tags ct ON ct.tag = pb.client_tag
                              WHERE pi.lead_id = f.id AND ct.group_no = $3::int AND pb.client_tag <> $2
                                AND (pi.status = 'sent' OR (pi.status IN ('pending', 'pushing') AND pb.status IN ${WORKING_BATCH})))
                     OR f.id IN (SELECT id FROM live_group)
                     OR EXISTS (SELECT 1 FROM lead_shares s JOIN client_tags ct ON ct.tag = s.receiver_tag
                                 WHERE s.lead_id = f.id AND s.receiver_tag <> $2 AND ct.group_no = $3::int
                                   AND s.outcome IN ('shared', 'own_topup') AND s.undone_at IS NULL
                                   AND (s.push_state IS NULL OR s.push_state <> 'dropped'))) THEN 'same_install'
         END AS reason
    FROM f
    JOIN public.leads l ON l.id = f.id`;
}

/**
 * The reasons of these leads for the receiver, SHARE_CHUNK ids a statement.
 *
 * @param {Pool} pool
 * @param {{ ids: string[], receiver: string, groupNo: number | null, pattern?: string | null }} p
 * @returns {Promise<Map<string, string | null>>}
 */
export async function reasonsOf(pool, { ids, receiver, groupNo, pattern = null }) {
  const sql = backfillReasonsSql(Boolean(pattern));
  const out = new Map();
  for (const part of slices(ids, SHARE_CHUNK)) {
    const params = [part, receiver, groupNo];
    if (pattern) params.push(pattern);
    const { rows } = await read(pool, sql, params);
    for (const r of rows) out.set(r.lead_id, r.reason ?? null);
  }
  return out;
}

/**
 * The group owner rule (sharing's sameGroupRule for a lead with owners): the
 * leads one of whose owners is in the receiver's Bison group (not the
 * receiver) and fits that owner's own rules (fn_share_rule_fits, without the
 * receive rule, as sharing reads it).
 *
 * @param {Pool} pool
 * @param {{ leads: Array<{ id: string, owners: string[] }>, receiver: string, groupNo: number | null, clients: Map<string, ClientRow> }} p
 * @returns {Promise<Set<string>>}
 */
export async function groupOwnerHeld(pool, { leads, receiver, groupNo, clients }) {
  const held = new Set();
  if (groupNo == null) return held;
  /** @type {Map<string, string[]>} */
  const byOwner = new Map();
  for (const l of leads) {
    for (const o of l.owners) {
      if (o === receiver || clients.get(o)?.group_no !== groupNo) continue;
      if (!byOwner.has(o)) byOwner.set(o, []);
      byOwner.get(o).push(l.id);
    }
  }
  for (const [owner, ids] of [...byOwner].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const fits = await fitsOf(pool, ids.filter((id) => !held.has(id)), owner, { receive: false });
    for (const id of fits) held.add(id);
  }
  return held;
}

/**
 * @typedef {{ tag: string, client_type: string | null, group_no: number | null, include_locations: any[] }} Receiver
 * @typedef {{ settings: import("../enrich/settings.mjs").PipelineSettings, untagged: boolean, clients: Map<string, ClientRow>,
 *             pattern: string | null, geoIds: Map<string, Set<string>> }} DecideContext
 * @typedef {{ checked: number, fits: number, shared: Array<{ id: string, place: MatchedPlace | null }>,
 *             reasons: Record<string, number> }} WindowDecision
 */

/**
 * Decides one window's candidates for one receiver. `seen` holds the leads
 * already shared (or, in preview, already counted as shares) to this receiver
 * in this firing: they are already_shared, so a lead found in two places is
 * counted once. The shares come back in id order.
 *
 * @param {Pool} pool
 * @param {{ receiver: Receiver, rows: Candidate[], ctx: DecideContext, seen?: Set<string> }} p
 * @returns {Promise<WindowDecision>}
 */
export async function decideWindow(pool, { receiver, rows, ctx, seen = new Set() }) {
  /** @type {Record<string, number>} */
  const reasons = Object.fromEntries(BACKFILL_REASONS.map((k) => [k, 0]));
  const out = { checked: rows.length, fits: 0, shared: /** @type {Array<{ id: string, place: MatchedPlace | null }>} */ ([]), reasons };
  if (!rows.length) return out;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const fit = await fitsOf(pool, [...byId.keys()], receiver.tag);
  out.fits = fit.size;
  if (!fit.size) return out;

  // Pools, from the lead's owners.
  const pool0 = clientPool(ctx.settings, receiver.tag, receiver.client_type);
  /** @type {Array<{ id: string, owners: string[] }>} */
  const open = [];
  for (const id of fit) {
    const owners = ownersOf(byId.get(id)?.tags, ctx.clients);
    if (owners.some((o) => clientPool(ctx.settings, o, ctx.clients.get(o)?.client_type ?? null) !== pool0)) reasons.other_pool++;
    else if (!owners.length && !ctx.untagged) reasons.untagged_off++;
    else open.push({ id, owners });
  }

  // Why not, from the database; then the leads this firing took already.
  const why = await reasonsOf(pool, { ids: open.map((l) => l.id), receiver: receiver.tag, groupNo: receiver.group_no, pattern: ctx.pattern });
  const left = [];
  for (const l of open) {
    const r = why.get(l.id) ?? (seen.has(l.id) ? "already_shared" : null);
    if (r) reasons[r] = (reasons[r] ?? 0) + 1;
    else left.push(l);
  }

  // The group owner rule, for leads with owners.
  const held = await groupOwnerHeld(pool, {
    leads: left.filter((l) => l.owners.length), receiver: receiver.tag, groupNo: receiver.group_no, clients: ctx.clients,
  });
  for (const l of left) {
    if (held.has(l.id)) {
      reasons.same_install++;
      continue;
    }
    const lead = /** @type {Candidate} */ (byId.get(l.id));
    out.shared.push({ id: l.id, place: matchPlace({ ...receiver, block: null, isOrigin: false }, lead, ctx.geoIds) });
  }
  out.shared.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
