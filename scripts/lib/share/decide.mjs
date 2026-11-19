// Which receivers a share job's new leads go to, and why a fitting lead is not
// shared when it is not (plan 1.3 to 1.6; contract sections 2.2 and 4).
//
// decideLeads() works on one job and a set of its new leads that have a
// usable place (location status resolved or partial):
//   1. Receivers. The job's own list, or new candidates (candidateReceivers):
//      clients on the sharing list other than the origin, in the origin's
//      pool (clientPool, settings.mjs), that can receive
//      (fn_client_can_receive, 132) and have an include entry in a (country,
//      state) of these leads. A top-up job also decides its origin as a
//      receiver (own_topup, plan 2.6).
//   2. Fit. fn_share_fits(ids, tag) (134), in chunks of SHARE_CHUNK ids: the
//      client's own push rules plus the share extras, only while it can
//      receive. Every statement is anchored on the ids.
//   3. Why not (REASONS_SQL), the first that applies, in this order:
//        filtered_inbox  a general inbox the loaded Clay filter matches
//        already_sent    a push item sent in a push for the receiver
//        in_flight       a push item pending or pushing in a live push for the
//                        receiver, or a push of the receiver still pending,
//                        scoring or gathering whose selected ids hold the lead
//        already_shared  an applied, live share of the lead to the receiver
//                        from another job
//        already_tagged  the lead carries the receiver's tag (exact, comma
//                        bounded, any case); never for the origin's own_topup,
//                        since its import stamped the origin's tag
//        same_install    the same tests for any other client of the
//                        receiver's Bison group (sent counts too), and, for a
//                        receiver in the origin's own group, a lead that fits
//                        the origin's own rules (sameGroupRule, plan 1.6)
//   4. Owners. Two receivers of one Bison group never both get a lead
//      (pickOwner): a receiver that already holds it (an applied share, or
//      the stored share of a receiver decided earlier) keeps it; else the one
//      whose list names the lead's city, then the one with fewer available
//      leads in that place (client_location_coverage), then tag order. The
//      others are also_fits.
//   5. Else shared (own_topup for the origin).
// writeReceiver() stores one receiver's rows in one transaction.

import { clientPool, flagOn, normTag } from "../enrich/settings.mjs";
import { generalInboxMatchSql, SHARE_CHUNK } from "../overlap-topup.mjs";
import { inTx, read, slices, tagTestSql } from "./db.mjs";

/**
 * @typedef {import("./db.mjs").Pool} Pool
 * @typedef {import("./db.mjs").Client} Client
 * @typedef {{ id: string, country_code: string | null, state_code: string | null, location_id: string | null }} Lead
 * @typedef {{ country: string, state: string, city: string | null, label: string }} Place
 * @typedef {{ tag: string, client_type: string | null, group_no: number | null, include_locations: any[],
 *             block: string | null, isOrigin: boolean }} Receiver
 * @typedef {{ outcome: string, place: Place | null }} Decision
 * @typedef {{ tag: string, decisions: Map<string, Decision>, checked: number, fits: number }} ReceiverResult
 */

/** Leads with a usable place: the share extras' place rule (fn_share_rule_fits, 134). */
export const PLACED = `l.location_status IN ('resolved', 'partial')`;

/** The live states of a push batch that holds its leads in selected_ids before items exist (052, push-worker.mjs:477-497). */
const LIVE_BATCH = `('pending', 'scoring', 'gathering')`;
/** The states of a push batch whose pending or pushing items are really in flight. */
const WORKING_BATCH = `('gathering', 'processing')`;

/**
 * The job's new leads (upload_batch_leads outcome new), with their place.
 * placed: leads with a usable place now; noPlace: the rest that still exist;
 * listed: rows the list holds. When the list is gone (pruned), the leads the
 * job's share rows name stand in for it.
 *
 * @param {Pool} pool
 * @param {string} batchId
 * @param {{ changedSince?: string | Date | null }} [opts]  recheck: only leads with no share row in this job, updated since then
 * @returns {Promise<{ placed: Lead[], noPlace: number, listed: number }>}
 */
export async function jobLeads(pool, batchId, { changedSince = null } = {}) {
  const recheck = changedSince != null;
  const { rows } = await read(pool, jobLeadsSql(recheck), recheck ? [batchId, changedSince] : [batchId]);
  let list = rows;
  if (!recheck && !rows.length) {
    ({ rows: list } = await read(
      pool,
      `SELECT s.lead_id AS id, l.id IS NOT NULL AS present, coalesce(${PLACED}, false) AS placed, true AS fresh,
              l.country_code, l.state_code, l.location_id::text AS location_id
         FROM (SELECT DISTINCT lead_id FROM lead_shares WHERE batch_id = $1) s
         LEFT JOIN public.leads l ON l.id = s.lead_id`,
      [batchId]
    ));
  }
  /** @type {Lead[]} */
  const placed = [];
  let noPlace = 0;
  for (const r of list) {
    if (!r.present) continue;
    if (!r.placed) noPlace++;
    else if (r.fresh) placed.push({ id: r.id, country_code: r.country_code, state_code: r.state_code, location_id: r.location_id });
  }
  return { placed, noPlace, listed: list.length };
}

/**
 * The job's new leads with their place: anchored on the job's list ($1, the
 * batch; its primary key) and each lead by its own key. A recheck ($2, the
 * last look) takes only leads with no share row in this job (no usable place
 * before, or no receiver) that changed since then: the location backfill's
 * update moves leads.updated_at (001, trg_leads_updated_at).
 *
 * @param {boolean} recheck
 */
export function jobLeadsSql(recheck) {
  return `SELECT u.lead_id AS id, l.id IS NOT NULL AS present, coalesce(${PLACED}, false) AS placed,
            ${recheck ? `coalesce(l.updated_at > $2::timestamptz, false)` : "true"} AS fresh,
            l.country_code, l.state_code, l.location_id::text AS location_id
       FROM upload_batch_leads u
       LEFT JOIN public.leads l ON l.id = u.lead_id
      WHERE u.batch_id = $1 AND u.outcome = 'new'
        ${recheck ? `AND NOT EXISTS (SELECT 1 FROM lead_shares s WHERE s.batch_id = u.batch_id AND s.lead_id = u.lead_id)` : ""}`;
}

/** The (country, state) keys of these leads, "US|NV". */
export function placeKeys(leads) {
  return [...new Set(leads.filter((l) => l.country_code && l.state_code).map((l) => `${l.country_code}|${String(l.state_code).toUpperCase()}`))];
}

const RECEIVER_SQL = `
  SELECT ct.tag, ct.client_type, ct.group_no, coalesce(t.include_locations, '[]'::jsonb) AS include_locations,
         public.fn_client_receive_block(ct.tag) AS block
    FROM client_tags ct
    LEFT JOIN client_targeting t ON t.client_tag = ct.tag
   WHERE ct.tag = ANY($1::text[])
   ORDER BY ct.tag`;

/**
 * Clients that may receive these leads: on the sharing list, not the origin,
 * in the origin's pool, able to receive, with an include entry in a
 * (country, state) of the leads. Matched as fn_location_entry_condition
 * (066) does: the country trimmed and exact, the state trimmed and upper case.
 *
 * @param {Pool} pool
 * @param {{ settings: import("../enrich/settings.mjs").PipelineSettings, originTag: string, originPool: string | null,
 *           leads: Lead[] }} p
 * @returns {Promise<Receiver[]>}
 */
export async function candidateReceivers(pool, { settings, originTag, originPool, leads }) {
  const keys = placeKeys(leads);
  const listed = (settings.overlap_sharing?.tags ?? []).filter((t) => t !== originTag);
  if (!keys.length || !listed.length || !originPool) return [];
  const { rows } = await read(
    pool,
    `SELECT ct.tag, ct.client_type, ct.group_no, t.include_locations, NULL::text AS block
       FROM client_tags ct
       JOIN client_targeting t ON t.client_tag = ct.tag
      WHERE ct.tag = ANY($1::text[])
        AND public.fn_client_can_receive(ct.tag)
        AND EXISTS (SELECT 1
                      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.include_locations) = 'array' THEN t.include_locations ELSE '[]'::jsonb END) AS e(entry)
                     WHERE jsonb_typeof(e.entry) = 'object'
                       AND (btrim(e.entry ->> 'country') || '|' || upper(btrim(e.entry ->> 'state'))) = ANY($2::text[]))
      ORDER BY ct.tag`,
    [listed, keys]
  );
  return rows
    .filter((r) => flagOn(settings, "overlap_sharing", r.tag) && clientPool(settings, r.tag, r.client_type) === originPool)
    .map((r) => ({ ...r, include_locations: Array.isArray(r.include_locations) ? r.include_locations : [], isOrigin: false }));
}

/**
 * Named clients as receivers (the job's stored list, or the origin), with their
 * group, type, places and why they cannot receive (null when they can).
 *
 * @param {Pool} pool
 * @param {string[]} tags
 * @param {string | null} originTag
 * @returns {Promise<Map<string, Receiver>>}
 */
export async function receiversByTag(pool, tags, originTag = null) {
  const want = [...new Set(tags.map(normTag).filter(Boolean))];
  if (!want.length) return new Map();
  const { rows } = await read(pool, RECEIVER_SQL, [want]);
  return new Map(rows.map((r) => [r.tag, {
    ...r, include_locations: Array.isArray(r.include_locations) ? r.include_locations : [], isOrigin: r.tag === originTag,
  }]));
}

// ── Places ──────────────────────────────────────────────────────────────────

/**
 * The geoname ids of each city entry of these clients' include lists, keyed
 * "<tag>|<1-based entry index>", resolved exactly as
 * fn_location_entry_condition (066) resolves them.
 */
async function cityIds(pool, tags) {
  if (!tags.length) return new Map();
  const { rows } = await read(
    pool,
    `SELECT x.tag, x.idx::int AS idx, array_agg(g.geoname_id::text) AS ids
       FROM (SELECT t.client_tag AS tag, e.entry, e.idx
               FROM client_targeting t
               CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.include_locations) = 'array'
                                                            THEN t.include_locations ELSE '[]'::jsonb END) WITH ORDINALITY AS e(entry, idx)
              WHERE t.client_tag = ANY($1::text[]) AND jsonb_typeof(e.entry) = 'object'
                AND nullif(btrim(e.entry ->> 'city'), '') IS NOT NULL AND nullif(btrim(e.entry ->> 'state'), '') IS NOT NULL
                AND nullif(btrim(e.entry ->> 'country'), '') IS NOT NULL) x
       JOIN geo_admin1 a ON a.country_code = btrim(x.entry ->> 'country') AND a.state_code = upper(btrim(x.entry ->> 'state'))
       JOIN geo_locations g ON g.country_code = a.country_code AND g.admin1_code = a.admin1_code
                           AND g.city_key = regexp_replace(lower(btrim(x.entry ->> 'city')), '[^a-z]', '', 'g')
      GROUP BY x.tag, x.idx`,
    [tags]
  );
  return new Map(rows.map((r) => [`${r.tag}|${r.idx}`, new Set(r.ids)]));
}

const trim = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * The receiver's include entry a lead matched: the city entry when the lead's
 * location_id is one of that city's geoname ids, else the state entry of its
 * (country, state); null when none (contract 2.2).
 *
 * @param {Receiver} r
 * @param {Lead} lead
 * @param {Map<string, Set<string>>} ids
 * @returns {Place | null}
 */
export function matchPlace(r, lead, ids) {
  const entries = r.include_locations;
  if (lead.location_id != null) {
    for (let i = 0; i < entries.length; i++) {
      const set = ids.get(`${r.tag}|${i + 1}`);
      if (set?.has(String(lead.location_id))) {
        const e = entries[i];
        const state = trim(e.state).toUpperCase();
        const city = trim(e.city);
        return { country: trim(e.country), state, city, label: `${city}, ${state}` };
      }
    }
  }
  for (const e of entries) {
    if (!e || typeof e !== "object" || trim(e.city)) continue;
    const country = trim(e.country);
    const state = trim(e.state).toUpperCase();
    if (country && state && country === lead.country_code && state === String(lead.state_code ?? "").toUpperCase()) {
      return { country, state, city: null, label: `${state} (state-wide)` };
    }
  }
  return null;
}

/** "<country>|<STATE>|<city in lower case>": the key a place and a coverage location share. */
const placeKey = (country, state, city) => `${trim(country)}|${trim(state).toUpperCase()}|${trim(city).toLowerCase()}`;

/** Available leads per place of each client, from its stored coverage row (096): tag -> key -> available. */
async function coverageOf(pool, tags) {
  if (!tags.length) return new Map();
  const { rows } = await read(pool, `SELECT client_tag, payload -> 'locations' AS locations FROM client_location_coverage WHERE client_tag = ANY($1::text[])`, [tags]);
  const out = new Map();
  for (const r of rows) {
    const m = new Map();
    for (const loc of Array.isArray(r.locations) ? r.locations : []) {
      if (!loc || typeof loc !== "object" || typeof loc.available !== "number") continue;
      m.set(placeKey(loc.country, loc.state, loc.kind === "city" ? loc.city : ""), loc.available);
    }
    out.set(r.client_tag, m);
  }
  return out;
}

// ── Fit and reasons ─────────────────────────────────────────────────────────

/**
 * Which of the ids fit this client: fn_share_fits (with the receive rule) or
 * fn_share_rule_fits (without it), one statement per SHARE_CHUNK ids.
 *
 * @param {Pool} pool
 * @param {string[]} ids
 * @param {string} tag
 * @param {{ receive?: boolean }} [opts]
 * @returns {Promise<Set<string>>}
 */
export async function fitsOf(pool, ids, tag, { receive = true } = {}) {
  const fn = receive ? "fn_share_fits" : "fn_share_rule_fits";
  const out = new Set();
  for (const part of slices(ids, SHARE_CHUNK)) {
    const { rows } = await read(pool, `SELECT f.lead_id FROM public.${fn}($1::uuid[], $2) AS f`, [part, tag]);
    for (const r of rows) out.add(r.lead_id);
  }
  return out;
}

/**
 * The first reason each fitting lead is not shared to the receiver $2, before
 * the same group rule and owners; null when there is none. $1 the fitting
 * ids, $3 the receiver's Bison group, $4 the job's batch, $5 whether the tag
 * test applies (not for the origin's own_topup), $6 the Clay General inboxes
 * filter (only in the variant built with it). Anchored on the ids: push_items
 * by lead (068), push_batches by tag (068) or by key, lead_shares by lead.
 *
 * @param {boolean} withFilter
 */
export function reasonsSql(withFilter) {
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
  SELECT f.id AS lead_id, l.country_code, l.state_code, l.location_id::text AS location_id,
         CASE
           ${withFilter ? `WHEN ${generalInboxMatchSql("l", "$6")} THEN 'filtered_inbox'` : ""}
           WHEN EXISTS (SELECT 1 FROM push_items pi JOIN push_batches pb ON pb.id = pi.batch_id
                         WHERE pi.lead_id = f.id AND pb.client_tag = $2 AND pi.status = 'sent') THEN 'already_sent'
           WHEN EXISTS (SELECT 1 FROM push_items pi JOIN push_batches pb ON pb.id = pi.batch_id
                         WHERE pi.lead_id = f.id AND pb.client_tag = $2 AND pi.status IN ('pending', 'pushing')
                           AND pb.status IN ${WORKING_BATCH})
             OR f.id IN (SELECT id FROM live_mine) THEN 'in_flight'
           WHEN EXISTS (SELECT 1 FROM lead_shares s
                         WHERE s.lead_id = f.id AND s.receiver_tag = $2 AND s.batch_id <> $4::uuid
                           AND s.outcome IN ('shared', 'own_topup') AND s.applied_at IS NOT NULL AND s.undone_at IS NULL) THEN 'already_shared'
           WHEN $5::boolean AND ${tagTestSql("l", "$2")} THEN 'already_tagged'
           WHEN $3::int IS NOT NULL
                AND (EXISTS (SELECT 1 FROM push_items pi JOIN push_batches pb ON pb.id = pi.batch_id
                               JOIN client_tags ct ON ct.tag = pb.client_tag
                              WHERE pi.lead_id = f.id AND ct.group_no = $3::int AND pb.client_tag <> $2
                                AND (pi.status = 'sent' OR (pi.status IN ('pending', 'pushing') AND pb.status IN ${WORKING_BATCH})))
                     OR f.id IN (SELECT id FROM live_group)) THEN 'same_install'
         END AS reason
    FROM f
    JOIN public.leads l ON l.id = f.id`;
}

/**
 * Same group as the origin (plan 1.6, kept in this one function so a different
 * answer from Nick is a small change): a receiver in the origin's own Bison
 * group gets only the leads the origin cannot use itself, those that do not
 * fit the origin's own rules (fn_share_rule_fits, without the receive rule:
 * the origin's routine pushes do not check it either). The others are
 * same_install, so they still show in the preview.
 *
 * @param {Receiver} r
 * @param {{ tag: string, group_no: number | null }} origin
 * @param {Set<string> | null} originFits
 * @param {string} leadId
 * @returns {boolean}  true: keep this lead back from r as same_install
 */
export function sameGroupRule(r, origin, originFits, leadId) {
  if (r.isOrigin || r.group_no == null || origin.group_no == null || r.group_no !== origin.group_no) return false;
  return Boolean(originFits?.has(leadId));
}

/**
 * The owner of one lead among receivers of one Bison group that would each
 * get it: the one whose list names the lead's city, then the one with fewer
 * available leads in that place (a place with no known count comes last),
 * then tag order.
 *
 * @param {Array<{ tag: string, place: Place | null, available: number | null }>} contenders
 * @returns {string}
 */
export function pickOwner(contenders) {
  const sorted = [...contenders].sort((a, b) => {
    const ca = a.place?.city ? 0 : 1;
    const cb = b.place?.city ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const va = a.available ?? Number.POSITIVE_INFINITY;
    const vb = b.available ?? Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
  });
  return sorted[0].tag;
}

/**
 * Decides these leads for these receivers: fit, the reasons, the same group
 * rule and owners. Reads only. `others` are the job's receivers not decided
 * now: their stored shares in this job keep the leads they hold.
 *
 * @param {Pool} pool
 * @param {{ batchId: string, origin: { tag: string, group_no: number | null }, leads: Lead[], receivers: Receiver[],
 *           others?: Array<{ tag: string, group_no: number | null }>, pattern?: string | null,
 *           shouldStop?: () => boolean }} p
 * @returns {Promise<ReceiverResult[]>}
 */
export async function decideLeads(pool, { batchId, origin, leads, receivers, others = [], pattern = null, shouldStop = () => false }) {
  const ids = leads.map((l) => l.id);
  const list = [...receivers].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  if (!ids.length || !list.length) return list.map((r) => ({ tag: r.tag, decisions: new Map(), checked: ids.length, fits: 0 }));

  const needOriginFits = list.some((r) => !r.isOrigin && r.group_no != null && r.group_no === origin.group_no);
  const originFits = needOriginFits ? await fitsOf(pool, ids, origin.tag, { receive: false }) : null;
  const geoIds = await cityIds(pool, list.map((r) => r.tag));
  const sql = reasonsSql(Boolean(pattern));

  /** @type {Map<string, Map<string, { reason: string | null, place: Place | null }>>} */
  const base = new Map();
  for (const r of list) {
    if (shouldStop()) throw new StopRound();
    const fit = [...(await fitsOf(pool, ids, r.tag))];
    const m = new Map();
    for (const part of slices(fit, SHARE_CHUNK)) {
      const params = [part, r.tag, r.group_no, batchId, !r.isOrigin];
      if (pattern) params.push(pattern);
      const { rows } = await read(pool, sql, params);
      for (const row of rows) {
        let reason = row.reason ?? null;
        if (reason == null && sameGroupRule(r, origin, originFits, row.lead_id)) reason = "same_install";
        m.set(row.lead_id, { reason, place: matchPlace(r, row, geoIds) });
      }
    }
    base.set(r.tag, m);
  }

  // Owners inside each Bison group (the origin's own_topup has no rival).
  const final = new Map(list.map((r) => [r.tag, new Map()]));
  const groups = new Map();
  for (const r of list) {
    if (r.isOrigin) continue;
    const g = r.group_no ?? `none:${r.tag}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const coverage = await coverageOf(pool, list.filter((r) => !r.isOrigin).map((r) => r.tag));
  for (const [g, members] of groups) {
    const now = new Set(members.map((r) => r.tag));
    const rivals = typeof g === "number" ? others.filter((o) => o.group_no === g && !now.has(o.tag)).map((o) => o.tag) : [];
    // Leads at least one member would get.
    const open = new Set();
    for (const r of members) for (const [id, d] of base.get(r.tag)) if (d.reason == null) open.add(id);
    /** @type {Map<string, string>} */
    const held = new Map();
    if (open.size && (members.length > 1 || rivals.length)) {
      for (const part of slices([...open], SHARE_CHUNK)) {
        const { rows } = await read(
          pool,
          `SELECT lead_id, receiver_tag FROM lead_shares
            WHERE batch_id = $1 AND receiver_tag = ANY($2::text[]) AND lead_id = ANY($4::uuid[])
              AND outcome = 'shared' AND undone_at IS NULL
              AND (applied_at IS NOT NULL OR NOT (receiver_tag = ANY($3::text[])))
            ORDER BY applied_at NULLS LAST, receiver_tag`,
          [batchId, [...now, ...rivals], [...now], part]
        );
        for (const row of rows) if (!held.has(row.lead_id)) held.set(row.lead_id, row.receiver_tag);
      }
    }
    for (const r of members) {
      for (const [id, d] of base.get(r.tag)) {
        if (d.reason != null) {
          final.get(r.tag).set(id, { outcome: d.reason, place: d.place });
          continue;
        }
        let owner = held.get(id) ?? null;
        if (!owner) {
          const contenders = members
            .filter((x) => base.get(x.tag).get(id)?.reason === null)
            .map((x) => {
              const place = base.get(x.tag).get(id).place;
              const available = place ? coverage.get(x.tag)?.get(placeKey(place.country, place.state, place.city ?? "")) ?? null : null;
              return { tag: x.tag, place, available };
            });
          owner = contenders.length > 1 ? pickOwner(contenders) : r.tag;
        }
        final.get(r.tag).set(id, { outcome: owner === r.tag ? "shared" : "also_fits", place: d.place });
      }
    }
  }
  for (const r of list) {
    if (!r.isOrigin) continue;
    for (const [id, d] of base.get(r.tag)) final.get(r.tag).set(id, { outcome: d.reason ?? "own_topup", place: d.place });
  }
  return list.map((r) => ({ tag: r.tag, decisions: final.get(r.tag), checked: ids.length, fits: base.get(r.tag).size }));
}

/** Thrown when the worker is stopping: the job is left as it is and taken up again later. */
export class StopRound extends Error {
  constructor() {
    super("stopping");
    this.name = "StopRound";
  }
}

/** Thrown when a job is no longer in a state this write may change (an admin undid it, or another round took it). */
export class Fenced extends Error {
  /** @param {string} state */
  constructor(state) {
    super(`the job is ${state} now`);
    this.name = "Fenced";
    this.state = state;
  }
}

/** Counts per outcome, with checked and fits: share_jobs.counts[receiver] (contract 2.1). */
function countsOf(rows, checked) {
  const out = { checked, fits: 0 };
  for (const r of rows) {
    out[r.outcome] = r.n;
    out.fits += r.n;
  }
  return out;
}

/**
 * Stores one receiver's decisions for the leads decided now, in one
 * transaction: rows of these leads that no longer fit are removed (only rows
 * not applied and not undone), the rest are upserted (an applied or undone row
 * is never changed), and the job's counts, receivers and receivers_done say
 * so. The job's row is locked first; it must be in one of `states`.
 *
 * @param {Pool} pool
 * @param {{ batchId: string, originTag: string, result: ReceiverResult, decidedIds: string[], states: string[],
 *           addChecked?: boolean }} p  addChecked: add this round's checked to the stored one (a recheck)
 * @returns {Promise<Record<string, number>>}  the receiver's counts
 */
export async function writeReceiver(pool, { batchId, originTag, result, decidedIds, states, addChecked = false }) {
  return inTx(pool, async (c) => {
    const { rows: [job] } = await c.query(`SELECT state, counts FROM share_jobs WHERE batch_id = $1 FOR UPDATE`, [batchId]);
    if (!job) throw new Fenced("gone");
    if (!states.includes(job.state)) throw new Fenced(job.state);
    const tag = result.tag;
    const decided = new Set(decidedIds);
    const { rows: open } = await c.query(
      `SELECT lead_id FROM lead_shares WHERE batch_id = $1 AND receiver_tag = $2 AND applied_at IS NULL AND undone_at IS NULL`,
      [batchId, tag]
    );
    const stale = open.map((r) => r.lead_id).filter((id) => decided.has(id) && !result.decisions.has(id));
    for (const part of slices(stale, SHARE_CHUNK)) {
      await c.query(
        `DELETE FROM lead_shares WHERE batch_id = $1 AND receiver_tag = $2 AND lead_id = ANY($3::uuid[]) AND applied_at IS NULL AND undone_at IS NULL`,
        [batchId, tag, part]
      );
    }
    const rows = [...result.decisions].map(([id, d]) => ({ lead_id: id, outcome: d.outcome, place: d.place }));
    for (const part of slices(rows, SHARE_CHUNK)) {
      await c.query(
        `INSERT INTO lead_shares AS s (batch_id, lead_id, origin_tag, receiver_tag, outcome, matched_place, decided_at)
         SELECT $1, x.lead_id, $2, $3, x.outcome, x.place, now()
           FROM jsonb_to_recordset($4::jsonb) AS x(lead_id uuid, outcome text, place jsonb)
         ON CONFLICT (batch_id, lead_id, receiver_tag) DO UPDATE
            SET outcome = EXCLUDED.outcome, matched_place = EXCLUDED.matched_place, decided_at = now()
          WHERE s.applied_at IS NULL AND s.undone_at IS NULL`,
        [batchId, originTag, tag, JSON.stringify(part)]
      );
    }
    const { rows: byOutcome } = await c.query(
      `SELECT outcome, count(*)::int AS n FROM lead_shares WHERE batch_id = $1 AND receiver_tag = $2 GROUP BY 1 ORDER BY 1`,
      [batchId, tag]
    );
    const before = Number(job.counts?.[tag]?.checked) || 0;
    const counts = countsOf(byOutcome, (addChecked ? before : 0) + result.checked);
    await c.query(
      `UPDATE share_jobs
          SET counts = jsonb_set(counts, ARRAY[$2::text], $3::jsonb, true),
              receivers = CASE WHEN $2 = ANY(receivers) THEN receivers ELSE array_append(receivers, $2::text) END,
              receivers_done = CASE WHEN $2 = ANY(receivers_done) THEN receivers_done ELSE array_append(receivers_done, $2::text) END
        WHERE batch_id = $1`,
      [batchId, tag, JSON.stringify(counts)]
    );
    return counts;
  });
}
