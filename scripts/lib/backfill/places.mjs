// Who the database backfill serves and where it reads (migration 138;
// contract 3.3 to 3.5). Plain JavaScript: the backfill-worker and the web
// app's Backfill tab load it.
//
//   Receivers   the clients on database_backfill.tags, with their type,
//               Bison group, receive rule (fn_client_receive_block, 132),
//               include entries, rules time and minimum (135).
//   Places      each include entry with a city and a state is a city place
//               (its geoname ids resolved as fn_location_entry_condition
//               resolves them; none: unresolved, never read); one with a
//               state and no city is a state place. Keys "US|AZ|tucson" and
//               "US|AZ", as the top-up keys them (the city reduced to letters).
//   Order       places under the client's minimum first, fewest available
//               first (the client's stored coverage), then the rest, fewest
//               first, then places with no coverage in entry order. Clients
//               with a low place first, then the least recently served, then
//               tag order.
//   Windows     a place's leads are read a window of lead ids at a time: the
//               uuid space cut by the first byte, so no statement reads more
//               than about WINDOW_ROWS of the place's leads.
//   Cursors     share_backfill_cursors: per client and place, the pass's
//               windows and the next one to read.

import { cityKey } from "../aiark/geo.mjs";
import { hasMinimumColumn } from "../coverage.mjs";

/** Leads per window a pass aims at. */
export const WINDOW_ROWS = 25_000;
/** A place with at most this many leads is read in one window, with no id bounds. */
export const ONE_WINDOW_ROWS = 50_000;
/** At most this many windows (the first byte of the id). */
export const WINDOWS_MAX = 256;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {{ key: string, kind: "city" | "state", country: string, state: string, city: string | null, label: string,
 *             ids: string[] | null, entry: number }} Place
 *   ids: the city's geoname ids (null for a state place); entry: the 1-based index of its include entry
 * @typedef {Place & { available: number | null, low: boolean }} RankedPlace
 * @typedef {{ tag: string, client_type: string | null, group_no: number | null, block: string | null, include_locations: any[],
 *             rules_at: string | null, min_leads_per_place: number | null }} ReceiverRow
 */

/**
 * The windows a place's pass is cut into: one for at most ONE_WINDOW_ROWS
 * leads, else the smallest power of two that leaves at most WINDOW_ROWS a
 * window, and at most WINDOWS_MAX.
 *
 * @param {number | null | undefined} rows
 * @returns {number}
 */
export function windowsFor(rows) {
  const n = Number(rows);
  if (!Number.isFinite(n) || n <= ONE_WINDOW_ROWS) return 1;
  let w = 2;
  while (w < WINDOWS_MAX && n / w > WINDOW_ROWS) w *= 2;
  return w;
}

const hex2 = (n) => n.toString(16).padStart(2, "0");
const UUID_TAIL = "000000-0000-0000-0000-000000000000";

/**
 * The id bounds of window i of w (w a power of two from 1 to 256): lo
 * inclusive, hi exclusive; hi null for the last window; both null when the
 * place is one window (no id bounds at all).
 *
 * @param {number} w
 * @param {number} i
 * @returns {{ lo: string | null, hi: string | null }}
 */
export function windowBounds(w, i) {
  if (!Number.isInteger(w) || w < 1 || w > WINDOWS_MAX || WINDOWS_MAX % w !== 0) throw new Error(`windowBounds: ${w} windows is not a power of two from 1 to ${WINDOWS_MAX}`);
  if (!Number.isInteger(i) || i < 0 || i >= w) throw new Error(`windowBounds: window ${i} of ${w} does not exist`);
  if (w === 1) return { lo: null, hi: null };
  const step = WINDOWS_MAX / w;
  return { lo: hex2(i * step) + UUID_TAIL, hi: i + 1 < w ? hex2((i + 1) * step) + UUID_TAIL : null };
}

const trim = (v) => (typeof v === "string" ? v.trim() : "");

/**
 * A place's key: "<COUNTRY>|<STATE>|<city reduced to letters>" for a city,
 * "<COUNTRY>|<STATE>" for a state (placeKeyOf in scripts/lib/aiark/company-filters.mjs).
 *
 * @param {{ country?: unknown, state?: unknown, city?: unknown }} p
 * @returns {string}
 */
export function placeKey(p) {
  const country = trim(p?.country).toUpperCase();
  const state = trim(p?.state).toUpperCase();
  const city = cityKey(p?.city ?? "");
  return city ? `${country}|${state}|${city}` : `${country}|${state}`;
}

/**
 * The geoname ids of each city entry of these clients' include lists, keyed
 * "<tag>|<1-based entry index>", resolved exactly as
 * fn_location_entry_condition (066) resolves them (the same statement as
 * scripts/lib/share/decide.mjs, so matchPlace() reads them the same way).
 *
 * @param {Db} db
 * @param {string[]} tags
 * @returns {Promise<Map<string, Set<string>>>}
 */
export async function cityIdsOf(db, tags) {
  if (!tags.length) return new Map();
  const { rows } = await db.query(
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

/**
 * A client's places from its include entries: city places with their geoname
 * ids, state places, and the city entries the geo reference does not know
 * (never read). An entry with no state (country-wide: the receive rule
 * refuses the client), a duplicate place or a malformed entry is left out.
 *
 * @param {string} tag
 * @param {unknown} entries  client_targeting.include_locations
 * @param {Map<string, Set<string>>} ids  cityIdsOf()
 * @returns {{ places: Place[], unresolved: Array<{ key: string, label: string, entry: number }> }}
 */
export function placesOf(tag, entries, ids) {
  /** @type {Place[]} */
  const places = [];
  const unresolved = [];
  const seen = new Set();
  const list = Array.isArray(entries) ? entries : [];
  list.forEach((e, i) => {
    if (!e || typeof e !== "object") return;
    const country = trim(e.country).toUpperCase();
    const state = trim(e.state).toUpperCase();
    const city = trim(e.city);
    if (!country || !state) return;
    const key = placeKey({ country, state, city });
    if (seen.has(key)) return;
    seen.add(key);
    if (city) {
      const found = ids.get(`${tag}|${i + 1}`);
      if (!found || !found.size) {
        unresolved.push({ key, label: `${city}, ${state}`, entry: i + 1 });
        return;
      }
      places.push({ key, kind: "city", country, state, city, label: `${city}, ${state}`, ids: [...found].sort(), entry: i + 1 });
    } else {
      places.push({ key, kind: "state", country, state, city: null, label: `${state} (state-wide)`, ids: null, entry: i + 1 });
    }
  });
  return { places, unresolved };
}

/**
 * Available leads per place of each client, from its stored coverage
 * (client_location_coverage.payload.locations, migration 096): tag -> key ->
 * available.
 *
 * @param {Db} db
 * @param {string[]} tags
 * @returns {Promise<Map<string, Map<string, number>>>}
 */
export async function coverageOf(db, tags) {
  if (!tags.length) return new Map();
  const { rows } = await db.query(
    `SELECT client_tag, payload -> 'locations' AS locations FROM client_location_coverage WHERE client_tag = ANY($1::text[])`,
    [tags]
  );
  const out = new Map();
  for (const r of rows) {
    const m = new Map();
    for (const loc of Array.isArray(r.locations) ? r.locations : []) {
      if (!loc || typeof loc !== "object" || typeof loc.available !== "number" || !trim(loc.state)) continue;
      const key = placeKey({ country: loc.country, state: loc.state, city: loc.kind === "city" ? loc.city : null });
      if (!m.has(key)) m.set(key, loc.available);
    }
    out.set(r.client_tag, m);
  }
  return out;
}

/**
 * A client's places in the order the backfill reads them: under the minimum
 * first, fewest available first; then the rest, fewest first; then the places
 * the stored coverage does not count, in entry order.
 *
 * @param {Place[]} places
 * @param {Map<string, number> | null | undefined} coverage  key -> available
 * @param {number} minimum
 * @returns {RankedPlace[]}
 */
export function orderPlaces(places, coverage, minimum) {
  const ranked = places.map((p) => {
    const available = coverage?.has(p.key) ? /** @type {number} */ (coverage.get(p.key)) : null;
    return { ...p, available, low: available != null && available < minimum };
  });
  const band = (p) => (p.available == null ? 2 : p.low ? 0 : 1);
  return ranked.sort((a, b) => {
    const ba = band(a);
    const bb = band(b);
    if (ba !== bb) return ba - bb;
    if (ba < 2 && a.available !== b.available) return /** @type {number} */ (a.available) - /** @type {number} */ (b.available);
    return a.entry - b.entry;
  });
}

/**
 * The order clients are served in: those with a low place first, then the
 * least recently served (never served first), then tag order.
 *
 * @template {{ tag: string, lowPlaces: number, servedAt: number | null }} C
 * @param {C[]} clients
 * @returns {C[]}
 */
export function orderClients(clients) {
  return [...clients].sort((a, b) => {
    const la = a.lowPlaces > 0 ? 0 : 1;
    const lb = b.lowPlaces > 0 ? 0 : 1;
    if (la !== lb) return la - lb;
    const sa = a.servedAt ?? Number.NEGATIVE_INFINITY;
    const sb = b.servedAt ?? Number.NEGATIVE_INFINITY;
    if (sa !== sb) return sa - sb;
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
  });
}

/**
 * The listed clients as receivers (contract 3.3): type, Bison group, why they
 * cannot receive (null when they can), include entries, the rules' time as
 * text (full precision, so a cursor stores it exactly) and their own minimum
 * (135; null before it). A tag that is no client is not in the answer.
 *
 * @param {Db} db
 * @param {string[]} tags
 * @returns {Promise<Map<string, ReceiverRow>>}
 */
export async function readReceivers(db, tags) {
  if (!tags.length) return new Map();
  const withMinimum = await hasMinimumColumn(db);
  const { rows } = await db.query(
    `SELECT ct.tag, ct.client_type, ct.group_no, public.fn_client_receive_block(ct.tag) AS block,
            coalesce(t.include_locations, '[]'::jsonb) AS include_locations, t.updated_at::text AS rules_at,
            ${withMinimum ? "t.min_leads_per_place" : "NULL::int"} AS min_leads_per_place
       FROM client_tags ct
       LEFT JOIN client_targeting t ON t.client_tag = ct.tag
      WHERE ct.tag = ANY($1::text[])
      ORDER BY ct.tag`,
    [tags]
  );
  return new Map(
    rows.map((r) => [
      r.tag,
      {
        tag: r.tag,
        client_type: r.client_type ?? null,
        group_no: r.group_no ?? null,
        block: r.block ?? null,
        include_locations: Array.isArray(r.include_locations) ? r.include_locations : [],
        rules_at: r.rules_at ?? null,
        min_leads_per_place: r.min_leads_per_place == null ? null : Number(r.min_leads_per_place),
      },
    ])
  );
}

/**
 * When each client was last served: the newest updated_at of its cursors (ms),
 * absent for a client never served.
 *
 * @param {Db} db
 * @param {string[]} tags
 * @returns {Promise<Map<string, number>>}
 */
export async function servedAtOf(db, tags) {
  if (!tags.length) return new Map();
  const { rows } = await db.query(
    `SELECT receiver_tag, max(updated_at) AS served_at FROM share_backfill_cursors WHERE receiver_tag = ANY($1::text[]) GROUP BY 1`,
    [tags]
  );
  return new Map(rows.map((r) => [r.receiver_tag, new Date(r.served_at).getTime()]));
}

/**
 * @typedef {{ place_key: string, windows: number, next_window: number, place_rows: number | null, pass_started_at: Date | string,
 *             pass_done_at: Date | string | null, checked: number, fits: number, shared: number, updated_at: Date | string,
 *             rules_changed: boolean, recheck_due: boolean }} CursorRow
 */

/**
 * One client's cursors by place key, with whether its rules changed since the
 * pass began (client_targeting.updated_at later than rules_at) and whether a
 * done pass is older than recheck_days, both worked out in SQL so a
 * timestamp's microseconds are never lost.
 *
 * @param {Db} db
 * @param {string} tag
 * @param {number} recheckDays
 * @returns {Promise<Map<string, CursorRow>>}
 */
export async function cursorsOf(db, tag, recheckDays) {
  const { rows } = await db.query(
    `SELECT c.place_key, c.windows, c.next_window, c.place_rows, c.pass_started_at, c.pass_done_at,
            c.checked::int AS checked, c.fits::int AS fits, c.shared::int AS shared, c.updated_at,
            (t.updated_at IS NOT NULL AND (c.rules_at IS NULL OR t.updated_at > c.rules_at)) AS rules_changed,
            (c.pass_done_at IS NOT NULL AND c.pass_done_at < now() - make_interval(days => $2::int)) AS recheck_due
       FROM share_backfill_cursors c
       LEFT JOIN client_targeting t ON t.client_tag = c.receiver_tag
      WHERE c.receiver_tag = $1`,
    [tag, recheckDays]
  );
  return new Map(rows.map((r) => [r.place_key, r]));
}

/**
 * Where a place's pass stands: "new" (no cursor), "rules" (the rules changed:
 * a new pass), "recheck" (done, and older than recheck_days: a new pass),
 * "done" (done and fresh: nothing to read), or "continue" at next_window.
 *
 * @param {CursorRow | null | undefined} cursor
 * @returns {"new" | "rules" | "recheck" | "done" | "continue"}
 */
export function passOf(cursor) {
  if (!cursor) return "new";
  if (cursor.rules_changed) return "rules";
  if (cursor.next_window >= cursor.windows) return cursor.recheck_due ? "recheck" : "done";
  return "continue";
}
