// Per-place lead coverage for one client: for each of its include locations,
// how many good leads are still there for it (client_location_coverage,
// migration 096). One computation shared by the coverage refresh
// (scripts/refresh-location-coverage.mjs, on the client-sync cron), the
// Leads page's route (GET /api/clients/location-coverage) and the weekly
// top-up (scripts/topup-worker.mjs).
//
// "Available" in a place: the lead has an email, is not bounced, not on the
// never-contact list, its validation is valid, catch_all or not done yet, it
// fits the client's rules (fn_client_eligibility_conditions, 127), and it was
// never sent to this client. Leads of any tag count.
//
// Two things the client asked for (2026-11-20) live here too:
//   - a minimum per client: client_targeting.min_leads_per_place (135), else
//     weekly_topup.default_minimum (500). A place under it is low. A forced
//     number (the refresh's --threshold, the route's ?threshold=) wins.
//   - general inboxes the Clay General inboxes filter matches never count as
//     available (D-GOOD-LEAD), whether or not they have been marked never
//     contact yet. While no filter is loaded (never_contact_inboxes.pattern),
//     nothing changes.
//
// The scan: one grouped count over the client's eligible leads, cut first to
// the (country, state) pairs its entries name when every entry names a state
// (the state_code index: UJ went from over 180 s to 7.6 s with it).

import { settingsFrom } from "./enrich/settings.mjs";
import { generalInboxExclusionSql } from "./overlap-topup.mjs";

/** The minimum a client may set: a whole number in this range (135's CHECK). */
export const MINIMUM_RANGE = Object.freeze({ min: 1, max: 100_000 });
/** How long the refresh lets one client's scan run. The route uses less (a person is waiting). */
export const COVERAGE_TIMEOUT_MS = 160_000;

const ELIGIBLE =
  "l.email is not null and l.email <> '' and l.is_bounced = false and l.is_suppressed = false " +
  "and (l.validation_status in ('valid','catch_all') or l.validation_status is null)";
const esc = (v) => `'${String(v).replace(/'/g, "''")}'`;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 * @typedef {Db & { connect: () => Promise<Db & { release: () => void }> }} DbPool
 * @typedef {{ label: string, kind: "city" | "state", country: string, state: string | null, city: string | null,
 *             available: number, resolved: boolean }} CoverageRow
 */

/** A whole number from 1 to 100,000, else null. */
export function wholeMinimum(v) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= MINIMUM_RANGE.min && n <= MINIMUM_RANGE.max ? n : null;
}

/**
 * The minimum as the Rules dialog sends it: empty (null, "" or missing)
 * means the default; anything else must be a whole number from 1 to 100,000.
 *
 * @param {unknown} v
 * @returns {{ value: number | null, error: string | null }}
 */
export function cleanMinimum(v) {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return { value: null, error: null };
  const n = wholeMinimum(v);
  if (n === null) return { value: null, error: "The minimum of good leads a place must be a whole number from 1 to 100,000, or empty for the default." };
  return { value: n, error: null };
}

/**
 * The number a client's places are measured against.
 *
 * @param {{ forced?: number | null, own?: number | null, defaultMinimum: number }} opts
 * @returns {{ minimum: number, from: "forced" | "client" | "default" }}
 */
export function minimumOf({ forced = null, own = null, defaultMinimum }) {
  if (wholeMinimum(forced) !== null) return { minimum: /** @type {number} */ (forced), from: "forced" };
  if (wholeMinimum(own) !== null) return { minimum: /** @type {number} */ (own), from: "client" };
  return { minimum: defaultMinimum, from: "default" };
}

/**
 * What coverage reads from the settings: the default minimum and the general
 * inbox filter (null while not loaded). A database before 124 reads the defaults.
 *
 * @param {Db} db
 * @returns {Promise<{ defaultMinimum: number, pattern: string | null, patternSha256: string | null }>}
 */
export async function coverageSettings(db) {
  let rows = [];
  try {
    ({ rows } = await db.query(`SELECT key, value FROM enrich_settings WHERE key IN ('weekly_topup', 'never_contact_inboxes')`));
  } catch (e) {
    if (/** @type {any} */ (e)?.code !== "42P01") throw e;
  }
  const s = settingsFrom(rows);
  return {
    defaultMinimum: s.weekly_topup.default_minimum,
    pattern: s.never_contact_inboxes.pattern,
    patternSha256: s.never_contact_inboxes.pattern ? s.never_contact_inboxes.sha256 : null,
  };
}

/**
 * Is client_targeting.min_leads_per_place there (migration 135)? Readers fall
 * back to the default minimum without it.
 *
 * @param {Db} db
 * @returns {Promise<boolean>}
 */
export async function hasMinimumColumn(db) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'client_targeting' AND column_name = 'min_leads_per_place') AS ok`
  );
  return rows[0]?.ok === true;
}

/**
 * The client's places with their available leads, lowest first, and the low
 * ones (under `threshold`). One grouped scan in its own transaction.
 *
 * @param {DbPool} pool
 * @param {{ tag: string, entries: any[], threshold: number, pattern?: string | null, patternSha256?: string | null,
 *           timeoutMs?: number }} opts
 *   pattern: the loaded general inbox filter (coverageSettings), or null for none
 * @returns {Promise<{ payload: { tag: string, threshold: number, hasTargeting: true, totalAvailable: number,
 *           locations: CoverageRow[], low: CoverageRow[], computedAt: string, generalInboxFilter: string | null },
 *           total: number, ms: number }>}
 */
export async function computeCoverage(pool, { tag, entries, threshold, pattern = null, patternSha256 = null, timeoutMs = COVERAGE_TIMEOUT_MS }) {
  const started = Date.now();
  const { rows: eligRows } = await pool.query(`select fn_client_eligibility_conditions($1) as conds`, [tag]);
  /** @type {string[]} */
  const conds = eligRows[0]?.conds ?? [];
  const notPushed = `not exists (
    select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
    where pb.client_tag = $1 and pi.lead_id = l.id and pi.status = 'sent')`;
  // General inboxes on the Clay General inboxes filter are not good leads (D-GOOD-LEAD).
  const notFiltered = pattern ? generalInboxExclusionSql("l", "$2") : null;

  const everyEntryHasState = entries.every((e) => e.state);
  const stateCond = everyEntryHasState
    ? "(" + [...new Set(entries.map((e) => `${e.country}|${String(e.state).toUpperCase()}`))]
        .map((s) => { const [co, st] = s.split("|"); return `(l.country_code = ${esc(co)} and l.state_code = ${esc(st)})`; })
        .join(" or ") + ")"
    : null;
  const where = [stateCond, ELIGIBLE, ...conds, notPushed, notFiltered].filter(Boolean).join(" and ");

  const client = await pool.connect();
  /** @type {Array<{ country_code: string | null, state_code: string | null, location_id: string | null, n: number }>} */
  let agg;
  try {
    await client.query("begin");
    await client.query(`set local statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
    const res = await client.query(
      `select l.country_code, l.state_code, l.location_id, count(*)::int as n
         from leads l where ${where} group by 1, 2, 3`, pattern ? [tag, pattern] : [tag]);
    await client.query("commit");
    agg = res.rows;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally { client.release(); }

  const byLocation = new Map();
  const byState = new Map();
  let total = 0;
  for (const r of agg) {
    total += r.n;
    if (r.location_id != null) byLocation.set(String(r.location_id), (byLocation.get(String(r.location_id)) ?? 0) + r.n);
    const sk = `${r.country_code ?? ""}|${r.state_code ?? ""}`;
    byState.set(sk, (byState.get(sk) ?? 0) + r.n);
  }

  // Resolve all city entries to geoname ids in one round trip, matching
  // fn_location_entry_condition (city_key on the normalised name).
  const cityEntries = entries.filter((e) => e.city && e.state);
  const idsByIdx = new Map();
  if (cityEntries.length > 0) {
    const { rows } = await pool.query(
      `select e.idx::int as idx, array_agg(g.geoname_id::text) as ids
         from unnest($1::text[], $2::text[], $3::text[]) with ordinality as e(country, state, city, idx)
         join geo_admin1 a on a.country_code = e.country and a.state_code = upper(e.state)
         join geo_locations g on g.country_code = e.country and g.admin1_code = a.admin1_code
          and g.city_key = regexp_replace(lower(e.city), '[^a-z]', '', 'g')
        group by e.idx`,
      [cityEntries.map((e) => e.country), cityEntries.map((e) => e.state), cityEntries.map((e) => e.city)]);
    for (const r of rows) idsByIdx.set(Number(r.idx), r.ids ?? []);
  }

  let cityIdx = 0;
  /** @type {CoverageRow[]} */
  const locations = entries.map((e) => {
    if (e.city && e.state) {
      cityIdx += 1;
      const ids = idsByIdx.get(cityIdx) ?? [];
      return {
        label: `${e.city}, ${e.state}`, kind: /** @type {const} */ ("city"),
        country: e.country, state: e.state ?? null, city: e.city ?? null,
        available: ids.reduce((s, id) => s + (byLocation.get(id) ?? 0), 0),
        // An entry the geo reference doesn't know matches nothing at push time
        // either: shown apart, so it isn't read as "no leads here".
        resolved: ids.length > 0,
      };
    }
    const sk = `${e.country}|${String(e.state ?? "").toUpperCase()}`;
    return {
      label: e.state ? `${e.state} (state-wide)` : e.country, kind: /** @type {const} */ ("state"),
      country: e.country, state: e.state ?? null, city: null,
      available: e.state ? (byState.get(sk) ?? 0) : total,
      resolved: true,
    };
  });
  locations.sort((a, b) => a.available - b.available);
  return {
    payload: {
      tag, threshold, hasTargeting: true, totalAvailable: total,
      locations, low: locations.filter((l) => l.available < threshold),
      computedAt: new Date().toISOString(),
      // The first 12 of the filter's sha256 when general inboxes on it were left out, else null.
      generalInboxFilter: pattern && patternSha256 ? patternSha256.slice(0, 12) : null,
    },
    total,
    ms: Date.now() - started,
  };
}

/**
 * Stores one client's coverage (one row a client, overwritten).
 *
 * @param {Db} db
 * @param {{ tag: string, threshold: number, total: number, payload: object, ms?: number | null }} row
 */
export async function storeCoverage(db, { tag, threshold, total, payload, ms = null }) {
  await db.query(
    `insert into client_location_coverage (client_tag, threshold, total_available, payload, computed_at, compute_ms)
     values ($1, $2, $3, $4::jsonb, now(), $5)
     on conflict (client_tag) do update set
       threshold = excluded.threshold, total_available = excluded.total_available,
       payload = excluded.payload, computed_at = now(), compute_ms = excluded.compute_ms`,
    [tag, threshold, total, JSON.stringify(payload), ms]);
}
