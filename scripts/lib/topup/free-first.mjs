// "Free first" for the weekly top-up (plan 2.4): before a client's low city
// places are bought for, how many leads the database already holds that could
// count there once their place text is fixed, which costs nothing.
//
//   partial     contactable leads with location_status 'partial' (a state,
//               but city text the geo reference did not match, so no
//               location_id) in the (country, state) of the client's low city
//               places. They count for no city place today. State-wide low
//               places get no partial count: partial leads already count
//               there.
//   unresolved  contactable unresolved leads (no state at all) whose place
//               text, as the Locations page's Unresolved queue shows it,
//               reduced to letters, is the key of one of the client's low
//               cities. Some may be a same-named city elsewhere.
//
// Contactable is coverage's ELIGIBLE (an email, not bounced, not suppressed,
// validation valid, catch_all or not done) and, while a General inboxes
// filter is loaded, not a general inbox it matches.
//
// The weekly pass counts these (scripts/lib/topup/pass.mjs) and stores them on
// the pass, topup_passes.counts.free_first; nothing is counted when the Low
// places tab loads. Each state and the unresolved map are counted at most once
// a firing, and a state counted in an earlier firing of the same pass is read
// back from the pass, not counted again. A statement that fails or runs past
// its time gives null ("not counted"), and the pass goes on.
//
// counts.free_first:
//   { "at": "<when unresolved_total was counted>", "unresolved_total": 0,
//     "states": { "US|IL": 0 },
//     "clients": { "<TAG>": { "partial": 0, "unresolved": 0,
//                             "states": [{ "key": "US|IL", "partial": 0 }],
//                             "cities": [{ "label": "<low city label>", "unresolved": 0 }] } } }

import { entryKey } from "../aiark/geo.mjs";
import { ELIGIBLE } from "../coverage.mjs";
import { generalInboxExclusionSql } from "../overlap-topup.mjs";

/** How long one count may run (SET LOCAL statement_timeout). */
export const FREE_FIRST_TIMEOUT_MS = 120_000;
/** At most this many low cities are listed per client (those with unresolved leads, most first). */
export const FREE_FIRST_CITIES = 10;

/** The Locations page's queue text (src/app/api/locations/unresolved/route.ts:20), lower-cased, letters only. */
export const UNRESOLVED_KEY_SQL =
  `regexp_replace(lower(coalesce(nullif(btrim(l.city), ''), l.raw_data->>'city_pre_clean', l.raw_data->>'state_pre_clean', '')), '[^a-z]', '', 'g')`;

/**
 * The partial count of one state: $1 country, $2 state, and $3 the filter
 * when one is loaded. Anchored on the state_code and location_status indexes;
 * the coalesce keeps the country index out of the choice.
 *
 * @param {boolean} withFilter
 */
export function partialCountSql(withFilter) {
  return `SELECT count(*)::int AS n FROM leads l
 WHERE l.state_code = $2 AND l.location_status = 'partial'
   AND coalesce(l.country_code, '') = $1
   AND l.location_id IS NULL AND btrim(coalesce(l.city, '')) <> ''
   AND ${ELIGIBLE}${withFilter ? `\n   AND ${generalInboxExclusionSql("l", "$3")}` : ""}`;
}

/**
 * The unresolved map, once a firing: contactable unresolved leads by the key
 * of their place text. $1 the filter when one is loaded.
 *
 * @param {boolean} withFilter
 */
export function unresolvedMapSql(withFilter) {
  return `SELECT ${UNRESOLVED_KEY_SQL} AS key, count(*)::int AS n FROM leads l
 WHERE l.location_status = 'unresolved' AND ${ELIGIBLE}${withFilter ? `\n   AND ${generalInboxExclusionSql("l", "$1")}` : ""}
 GROUP BY 1`;
}

/** Every unresolved lead, no filter: the size of the Locations page's queue. Once a pass. */
export const UNRESOLVED_TOTAL_SQL = `SELECT count(*)::int AS n FROM leads WHERE location_status = 'unresolved'`;

/** Puts one state's partial count on the pass ($1 pass, $2 "US|IL", $3 the count). */
const STORE_STATE_SQL = `UPDATE topup_passes
    SET counts = counts || jsonb_build_object('free_first', coalesce(counts->'free_first', '{}'::jsonb)
          || jsonb_build_object('states', coalesce(counts->'free_first'->'states', '{}'::jsonb) || jsonb_build_object($2::text, $3::int)))
  WHERE id = $1`;

/** Puts the unresolved total on the pass with the time it was counted ($1 pass, $2 the total). */
const STORE_TOTAL_SQL = `UPDATE topup_passes
    SET counts = counts || jsonb_build_object('free_first', coalesce(counts->'free_first', '{}'::jsonb)
          || jsonb_build_object('at', now(), 'unresolved_total', $2::int))
  WHERE id = $1`;

/**
 * UPDATE that puts one client's numbers on the pass ($1 pass, $2 tag, $3 the
 * numbers as JSON; null removes the client's entry). It merges, so the other
 * clients, the states and the total stay as they are.
 */
export const SET_CLIENT_SQL = `UPDATE topup_passes
   SET counts = counts || jsonb_build_object('free_first',
         coalesce(counts->'free_first', '{}'::jsonb) || jsonb_build_object('clients',
           CASE WHEN $3::jsonb IS NULL THEN coalesce(counts->'free_first'->'clients', '{}'::jsonb) - $2::text
                ELSE coalesce(counts->'free_first'->'clients', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb) END))
 WHERE id = $1`;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {Db & { connect: () => Promise<Db & { release: () => void }> }} DbPool
 * @typedef {{ partial: number | null, unresolved: number | null, states: Array<{ key: string, partial: number | null }>,
 *             cities: Array<{ label: string, unresolved: number }> }} FreeFirstNumbers
 * @typedef {{ partial: (stateKey: string) => Promise<number | null>, unresolvedMap: () => Promise<Map<string, number> | null>,
 *             forClient: (lowCityFlags: any[]) => Promise<FreeFirstNumbers> }} FreeFirstCounter
 */

/** "US|IL": a country code and a state code. */
const STATE_KEY = /^[A-Z]{2}\|[A-Z0-9]{1,8}$/;
const COUNT = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
const why = (e) => String(/** @type {any} */ (e)?.message ?? e).slice(0, 200);

/**
 * Rows of one read-only statement in its own transaction, under its own
 * statement timeout (SET LOCAL: never a session SET).
 *
 * @param {DbPool} pool
 * @param {string} sql
 * @param {unknown[]} params
 * @param {number} timeoutMs
 */
async function readIn(pool, sql, params, timeoutMs) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    await c.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
    const { rows } = await c.query(sql, params);
    await c.query("COMMIT");
    return rows;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * One firing's counter. Each state and the unresolved map are counted at most
 * once a firing; `known` (the pass's counts.free_first.states) seeds the
 * states an earlier firing of the same pass counted. Each state counted here
 * is stored on the pass at once, in its own short statement; a state that
 * could not be counted is not stored, so the next firing tries it again.
 * Nothing here throws.
 *
 * @param {DbPool} pool
 * @param {{ passId: string | null, pattern: string | null, known?: Record<string, unknown>, log?: (m: string) => void,
 *           timeoutMs?: number }} opts
 *   pattern: the loaded General inboxes filter (coverageSettings), or null for none
 * @returns {FreeFirstCounter}
 */
export function freeFirstCounter(pool, { passId, pattern, known = {}, log = () => {}, timeoutMs = FREE_FIRST_TIMEOUT_MS }) {
  const withFilter = typeof pattern === "string" && pattern !== "";
  /** @type {Map<string, Promise<number | null>>} */
  const states = new Map();
  for (const [k, v] of Object.entries(known && typeof known === "object" ? known : {})) {
    if (STATE_KEY.test(k) && COUNT(v) !== null) states.set(k, Promise.resolve(/** @type {number} */ (v)));
  }
  /** @type {Promise<Map<string, number> | null> | null} */
  let map = null;

  /** @param {string} key */
  async function countState(key) {
    const [country, state] = key.split("|");
    let n;
    try {
      const rows = await readIn(pool, partialCountSql(withFilter), withFilter ? [country, state, pattern] : [country, state], timeoutMs);
      n = Number(rows[0]?.n ?? 0);
    } catch (e) {
      log(`top-up free first: the partial leads of ${key} were not counted: ${why(e)}`);
      return null;
    }
    if (passId) {
      try {
        await pool.query(STORE_STATE_SQL, [passId, key, n]);
      } catch (e) {
        // Still used in this firing; the next firing counts it again.
        log(`top-up free first: the count of ${key} was not stored on the pass: ${why(e)}`);
      }
    }
    return n;
  }

  /** @param {string} key  "US|IL" */
  const partial = (key) => {
    if (!STATE_KEY.test(key)) return Promise.resolve(null);
    let p = states.get(key);
    if (!p) {
      p = countState(key);
      states.set(key, p);
    }
    return p;
  };

  const unresolvedMap = () => {
    if (!map) {
      map = (async () => {
        try {
          const rows = await readIn(pool, unresolvedMapSql(withFilter), withFilter ? [pattern] : [], timeoutMs);
          return new Map(rows.map((r) => [String(r.key), Number(r.n)]));
        } catch (e) {
          log(`top-up free first: the unresolved leads were not counted: ${why(e)}`);
          return null;
        }
      })();
    }
    return map;
  };

  /**
   * One client's numbers from its low city flags (kind "low", place.city and
   * place.state set): partial is null when any of its states could not be
   * counted; unresolved is the sum over its distinct city keys, null when the
   * map could not be counted; cities lists its low cities that have
   * unresolved leads, most first, at most FREE_FIRST_CITIES.
   *
   * @param {any[]} lowCityFlags
   * @returns {Promise<FreeFirstNumbers>}
   */
  const forClient = async (lowCityFlags) => {
    try {
      /** @type {Array<{ label: string, key: string }>} */
      const cities = [];
      const stateKeys = new Set();
      for (const f of Array.isArray(lowCityFlags) ? lowCityFlags : []) {
        const country = String(f?.place?.country ?? "").trim().toUpperCase();
        const state = String(f?.place?.state ?? "").trim().toUpperCase();
        const city = String(f?.place?.city ?? "").trim();
        if (!country || !state || !city) continue;
        stateKeys.add(`${country}|${state}`);
        cities.push({ label: String(f.label ?? `${city}, ${state}`), key: entryKey(city) });
      }
      /** @type {Array<{ key: string, partial: number | null }>} */
      const stateRows = [];
      for (const key of [...stateKeys].sort()) stateRows.push({ key, partial: await partial(key) });
      stateRows.sort((a, b) => (b.partial ?? -1) - (a.partial ?? -1) || a.key.localeCompare(b.key));
      const partialSum = stateRows.some((s) => s.partial === null) ? null : stateRows.reduce((s, x) => s + /** @type {number} */ (x.partial), 0);

      // A city whose name has no letters has an empty key, which names no city.
      const m = cities.length ? await unresolvedMap() : new Map();
      const of = (key) => (key && m ? m.get(key) ?? 0 : 0);
      const unresolved = m === null ? null : [...new Set(cities.map((c) => c.key))].reduce((s, key) => s + of(key), 0);
      const cityRows = m === null
        ? []
        : cities
            .map((c) => ({ label: c.label, unresolved: of(c.key) }))
            .filter((c) => c.unresolved > 0)
            .sort((a, b) => b.unresolved - a.unresolved || a.label.localeCompare(b.label))
            .slice(0, FREE_FIRST_CITIES);
      return { partial: partialSum, unresolved, states: stateRows, cities: cityRows };
    } catch (e) {
      log(`top-up free first: not counted: ${why(e)}`);
      return { partial: null, unresolved: null, states: [], cities: [] };
    }
  };

  return { partial, unresolvedMap, forClient };
}

/**
 * Counts every unresolved lead (no filter) and stores it on the pass with the
 * time it was counted, once a pass. Never throws: a count that fails stores
 * nothing, so the next firing tries again.
 *
 * @param {DbPool} pool
 * @param {string} passId
 * @param {{ log?: (m: string) => void, timeoutMs?: number }} [opts]
 * @returns {Promise<number | null>}
 */
export async function storeUnresolvedTotal(pool, passId, { log = () => {}, timeoutMs = FREE_FIRST_TIMEOUT_MS } = {}) {
  let n;
  try {
    const rows = await readIn(pool, UNRESOLVED_TOTAL_SQL, [], timeoutMs);
    n = Number(rows[0]?.n ?? 0);
  } catch (e) {
    log(`top-up free first: the unresolved total was not counted: ${why(e)}`);
    return null;
  }
  try {
    await pool.query(STORE_TOTAL_SQL, [passId, n]);
  } catch (e) {
    log(`top-up free first: the unresolved total was not stored on the pass: ${why(e)}`);
  }
  return n;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * What GET /api/topup shows of a pass's counts.free_first, checked: counts are
 * whole numbers from 0 or null, `at` and labels are strings, lists are lists;
 * anything else reads null, and a malformed list entry is left out.
 *
 * @param {unknown} counts  topup_passes.counts
 * @returns {{ top: { unresolvedTotal: number | null, at: string | null } | null,
 *             clientOf: (tag: string) => FreeFirstNumbers | null }}
 */
export function readFreeFirst(counts) {
  const ff = isObject(counts) && isObject(/** @type {any} */ (counts).free_first) ? /** @type {any} */ (counts).free_first : null;
  if (!ff) return { top: null, clientOf: () => null };
  const at = typeof ff.at === "string" && !Number.isNaN(Date.parse(ff.at)) ? ff.at : null;
  const clients = isObject(ff.clients) ? ff.clients : {};
  return {
    top: { unresolvedTotal: COUNT(ff.unresolved_total), at },
    clientOf: (tag) => {
      const c = Object.hasOwn(clients, tag) ? clients[tag] : null;
      if (!isObject(c)) return null;
      return {
        partial: COUNT(c.partial),
        unresolved: COUNT(c.unresolved),
        states: (Array.isArray(c.states) ? c.states : [])
          .filter((s) => isObject(s) && typeof s.key === "string")
          .map((s) => ({ key: s.key, partial: COUNT(s.partial) })),
        cities: (Array.isArray(c.cities) ? c.cities : [])
          .filter((x) => isObject(x) && typeof x.label === "string" && COUNT(x.unresolved) !== null)
          .map((x) => ({ label: x.label, unresolved: x.unresolved })),
      };
    },
  };
}
