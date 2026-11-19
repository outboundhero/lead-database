// The weekly top-up's flag pass (migration 135, plan 2.1 to 2.3).
//
// A pass runs when the last finished one is 7 or more days old, or when
// someone pressed "Run now" (a "requested" pass). It visits every client whose
// status is Active or Healthy, in tag order, and writes topup_flags:
//
//   - a client of a type weekly_topup.client_types covers gets one row per
//     low place (kind "low": fewer good leads than its minimum) and per place
//     the geo reference does not know (kind "unresolved": never bought for;
//     the place name needs fixing), or one row saying why there is none
//     ("all_ok", "no_places", "no_rules");
//   - any other client gets one "not_covered" row, so nobody drops out unseen.
//
// Every row carries fn_client_receive_block() at pass time (132): flags are
// free, so a client that cannot receive is still flagged, with the reason.
// Only pulls need it to be empty (scripts/lib/topup/pulls.mjs).
//
// Coverage comes from client_location_coverage when that row is newer than
// the client's rules, younger than 24 hours and counted with the general
// inbox filter in force now; otherwise it is computed again (and stored).
//
// A pass carries on across hourly firings: each client is written in one
// transaction with its name added to topup_passes.clients_done, so a firing
// that stops (its time is up, or it crashed) leaves the next one to go on
// from there.

import { placeKeyOf } from "../aiark/company-filters.mjs";
import { cityKey } from "../aiark/geo.mjs";
import { computeCoverage, coverageSettings, minimumOf, storeCoverage, wholeMinimum } from "../coverage.mjs";
import { COVERAGE_MAX_AGE_HOURS, TOPUP_PASS_EVERY_DAYS } from "../overlap-topup.mjs";
import { inTx, preparePull } from "./pulls.mjs";

/** After a pass that failed, a scheduled one waits this long before it tries again (Run now does not wait). */
export const ERROR_RETRY_HOURS = 6;
/** A client whose flags fail this many firings in a row is left out of the pass (named in counts.failed_tries). */
export const FAILED_TRIES = 2;
/** A pass still open this long ends as an error. */
export const PASS_GIVE_UP_DAYS = 3;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {Db & { connect: () => Promise<Db & { release: () => void }> }} DbPool
 */

/** The key of a place on its flag: placeKeyOf(), or for an entry it cannot key (a city with no state) its parts. */
export function flagKeyOf(entry) {
  return placeKeyOf(entry) ?? `${String(entry?.country ?? "").toUpperCase()}|-|${cityKey(entry?.city ?? "")}`;
}

/**
 * The open pass (requested or running), or a new scheduled one when it is
 * due: the last finished pass is TOPUP_PASS_EVERY_DAYS or more days old (or
 * there is none) and no pass failed in the last ERROR_RETRY_HOURS.
 *
 * @param {Db} db
 * @returns {Promise<any | null>} the pass to work on, or null when none is due
 */
export async function duePass(db) {
  // A pass that could not finish in PASS_GIVE_UP_DAYS ends as an error, so a new one can start.
  await db.query(
    `UPDATE topup_passes
        SET state = 'error', finished_at = now(),
            last_error = left(coalesce(last_error || ' ', '') || format('Gave up: not finished after %s days.', $1::int), 1000)
      WHERE state IN ('requested', 'running') AND coalesce(started_at, requested_at) < now() - make_interval(days => $1)`,
    [PASS_GIVE_UP_DAYS]
  );
  const { rows: open } = await db.query(`SELECT * FROM topup_passes WHERE state IN ('requested', 'running') LIMIT 1`);
  if (open[0]) return open[0];
  const { rows: [last] } = await db.query(
    `SELECT (SELECT max(finished_at) FROM topup_passes WHERE state = 'done') > now() - make_interval(days => $1) AS recent_done,
            (SELECT max(coalesce(finished_at, updated_at)) FROM topup_passes WHERE state = 'error') > now() - make_interval(hours => $2) AS recent_error`,
    [TOPUP_PASS_EVERY_DAYS, ERROR_RETRY_HOURS]
  );
  if (last.recent_done || last.recent_error) return null;
  const { rows } = await db.query(
    `INSERT INTO topup_passes (state, trigger) VALUES ('requested', 'schedule') ON CONFLICT DO NOTHING RETURNING *`
  );
  if (rows[0]) return rows[0];
  const { rows: again } = await db.query(`SELECT * FROM topup_passes WHERE state IN ('requested', 'running') LIMIT 1`);
  return again[0] ?? null;
}

/**
 * A requested pass becomes running, with the settings it runs with. Pulls an
 * older pass prepared and nobody started are expired: this pass replaces them.
 *
 * @param {Db} db
 * @param {any} pass
 * @param {any} settings  settingsFrom()'s value
 */
export async function beginPass(db, pass, settings) {
  if (pass.state === "running") return pass;
  const { rows: [p] } = await db.query(
    `UPDATE topup_passes SET state = 'running', started_at = coalesce(started_at, now()), settings = $2::jsonb
      WHERE id = $1 AND state = 'requested' RETURNING *`,
    [pass.id, JSON.stringify(settings.weekly_topup)]
  );
  await db.query(
    `UPDATE topup_pulls SET state = 'expired', note = 'A newer weekly pass replaced it before it started.'
      WHERE state = 'prepared' AND pass_id IS DISTINCT FROM $1`,
    [pass.id]
  );
  return p ?? pass;
}

/**
 * The clients a pass visits: status Active or Healthy (trimmed, any case),
 * with their rules, own minimum and stored coverage.
 *
 * @param {Db} db
 * @param {{ tagPrefix?: string | null }} [opts]  tests only: just the tags starting so
 */
export async function passClients(db, { tagPrefix = null } = {}) {
  const { rows } = await db.query(
    `SELECT ct.tag, ct.name, ct.client_type, ct.status,
            t.client_tag IS NOT NULL AS has_rules, t.include_locations, t.min_leads_per_place,
            c.payload AS coverage,
            (c.computed_at IS NOT NULL AND c.computed_at > t.updated_at
             AND c.computed_at > now() - make_interval(hours => $2)) AS coverage_fresh
       FROM client_tags ct
       LEFT JOIN client_targeting t ON t.client_tag = ct.tag
       LEFT JOIN client_location_coverage c ON c.client_tag = ct.tag
      WHERE lower(btrim(coalesce(ct.status, ''))) IN ('active', 'healthy')
        AND ($1::text IS NULL OR starts_with(ct.tag, $1))
      ORDER BY ct.tag`,
    [tagPrefix, COVERAGE_MAX_AGE_HOURS]
  );
  return rows;
}

/**
 * One client's flags for a pass, and its pull when it gets one. Coverage may
 * be computed here (its own transaction); the flags, the pull and the pass's
 * progress are then written in one transaction.
 *
 * @param {DbPool} pool
 * @param {{ pass: any, client: any, settings: any, geo: any, cov: { defaultMinimum: number, pattern: string | null, patternSha256: string | null } }} opts
 * @returns {Promise<{ kinds: Record<string, number>, action: string }>}
 */
export async function flagClient(pool, { pass, client, settings, geo, cov }) {
  const tag = client.tag;
  const clientType = client.client_type ?? null;
  const { rows: [rb] } = await pool.query(`SELECT public.fn_client_receive_block($1) AS block`, [tag]);
  const block = rb?.block ?? null;
  const covered = settings.flagOn("weekly_topup", tag, { clientType: clientType ?? undefined });
  const minimum = minimumOf({ own: wholeMinimum(client.min_leads_per_place), defaultMinimum: cov.defaultMinimum }).minimum;

  /** @type {any[]} */
  const rows = [];
  /** @type {Array<{ entry: any, available: number }>} */
  let buyable = [];
  const entries = Array.isArray(client.include_locations) ? client.include_locations : [];
  if (!covered) {
    rows.push({ kind: "not_covered", reason: `Not covered: the weekly top-up does not cover client type ${clientType?.trim() || "(none)"}.` });
  } else if (!client.has_rules) {
    rows.push({ kind: "no_rules", reason: "No rules: add the client's places and exclusions (Rules, or the onboarding sheet)." });
  } else if (entries.length === 0) {
    rows.push({ kind: "no_places", reason: "No places: the client's rules list no include locations." });
  } else {
    const sha12 = cov.patternSha256 ? cov.patternSha256.slice(0, 12) : null;
    const stored = client.coverage;
    let locations;
    if (client.coverage_fresh && stored && Array.isArray(stored.locations) && (stored.generalInboxFilter ?? null) === sha12) {
      locations = stored.locations;
    } else {
      const { payload, total, ms } = await computeCoverage(pool, {
        tag, entries, threshold: minimum, pattern: cov.pattern, patternSha256: cov.patternSha256,
      });
      await storeCoverage(pool, { tag, threshold: minimum, total, payload, ms });
      locations = payload.locations;
    }
    // Each coverage row is one of the client's entries (same order of fields): find it back by its key.
    const byKey = new Map(entries.map((e) => [flagKeyOf(e), e]));
    for (const l of [...locations].sort((a, b) => a.available - b.available)) {
      if (l.available >= minimum) continue;
      const place = { country: l.country, state: l.state ?? null, city: l.city ?? null };
      const key = flagKeyOf(place);
      if (!l.resolved) {
        rows.push({ kind: "unresolved", key, label: l.label, place, available: l.available, resolved: false,
          reason: "The geo reference does not know this place, so it matches no lead: fix its name in the client's rules. Never bought for." });
        continue;
      }
      rows.push({ kind: "low", key, label: l.label, place, available: l.available, resolved: true });
      const entry = byKey.get(key);
      if (entry) buyable.push({ entry, available: l.available });
    }
    if (!rows.length) rows.push({ kind: "all_ok", reason: `Every place has at least ${minimum.toLocaleString("en-US")} good leads.` });
  }
  // A place listed twice in the rules is flagged once.
  const seen = new Set();
  const flags = rows.filter((r) => {
    const k = `${r.kind}|${r.key ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  buyable = buyable.filter((b, i) => buyable.findIndex((x) => flagKeyOf(x.entry) === flagKeyOf(b.entry)) === i);

  return inTx(pool, async (c) => {
    // A pass that carries on rewrites a client it had half done.
    await c.query(`DELETE FROM topup_flags WHERE pass_id = $1 AND client_tag = $2`, [pass.id, tag]);
    let action = "none";
    let reason = null;
    let pull = null;
    if (buyable.length) {
      if (block) {
        action = "cannot_receive";
        reason = `Cannot receive: ${block}. Flagged only, no pull.`;
      } else {
        const r = await preparePull(c, { passId: pass.id, client: { tag, client_type: clientType }, settings, low: buyable, minimum, geo });
        action = r.action;
        reason = r.reason;
        pull = r.pull;
      }
    }
    for (const f of flags) {
      const isLow = f.kind === "low";
      await c.query(
        `INSERT INTO topup_flags (pass_id, client_tag, kind, place_key, label, place, available, minimum, resolved, receive_block,
                                  action, pull_id, run_id, reason)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          pass.id, tag, f.kind, f.key ?? null, f.label ?? null, f.place ? JSON.stringify(f.place) : null,
          f.available ?? null, f.kind === "not_covered" || f.kind === "no_rules" || f.kind === "no_places" ? null : minimum,
          f.resolved ?? null, block,
          isLow ? action : "none",
          isLow ? pull?.id ?? null : null,
          isLow ? pull?.run_id ?? null : null,
          isLow ? reason : f.reason ?? null,
        ]
      );
    }
    await c.query(
      `UPDATE topup_passes SET clients_done = array_append(clients_done, $2) WHERE id = $1 AND NOT ($2 = ANY (clients_done))`,
      [pass.id, tag]
    );
    const kinds = {};
    for (const f of flags) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    return { kinds, action };
  });
}

/**
 * The pass's counts, from its flags: clients by kind, places by kind, and
 * what was done for low places.
 *
 * @param {Db} db
 * @param {string} passId
 */
export async function passCounts(db, passId) {
  const { rows: [r] } = await db.query(
    `SELECT count(DISTINCT client_tag)::int AS clients,
            count(DISTINCT client_tag) FILTER (WHERE kind IN ('low', 'unresolved'))::int AS clients_low,
            count(*) FILTER (WHERE kind = 'low')::int AS low_places,
            count(*) FILTER (WHERE kind = 'unresolved')::int AS unresolved_places,
            count(*) FILTER (WHERE kind = 'all_ok')::int AS all_ok,
            count(*) FILTER (WHERE kind = 'no_places')::int AS no_places,
            count(*) FILTER (WHERE kind = 'no_rules')::int AS no_rules,
            count(*) FILTER (WHERE kind = 'not_covered')::int AS not_covered,
            count(DISTINCT client_tag) FILTER (WHERE receive_block IS NOT NULL)::int AS cannot_receive,
            count(DISTINCT pull_id)::int AS pulls
       FROM topup_flags WHERE pass_id = $1`,
    [passId]
  );
  return r;
}

/**
 * Works the open or due pass until every client is done or `deadline`
 * passes. Returns the pass as it was left, or null when none was due.
 *
 * @param {DbPool} pool
 * @param {{ settings: any, geo: any, deadline?: number, log?: (m: string) => void, tagPrefix?: string | null }} opts
 */
export async function runPass(pool, { settings, geo, deadline = Infinity, log = () => {}, tagPrefix = null }) {
  if (!settings.weekly_topup.enabled) return null;
  let pass = await duePass(pool);
  if (!pass) return null;
  pass = await inTx(pool, (c) => beginPass(c, pass, settings));
  const cov = await coverageSettings(pool);
  const clients = await passClients(pool, { tagPrefix });
  const done = new Set(pass.clients_done ?? []);
  let left = 0;
  for (const client of clients) {
    if (done.has(client.tag)) continue;
    if (Date.now() > deadline) {
      left++;
      continue;
    }
    try {
      await flagClient(pool, { pass, client, settings, geo, cov });
    } catch (e) {
      // Tried again at the next firing; after FAILED_TRIES the pass goes on
      // without the client (no flags), and its counts name it.
      const msg = String(/** @type {any} */ (e)?.message ?? e).slice(0, 300);
      const tries = Number(pass.counts?.failed_tries?.[client.tag] ?? 0) + 1;
      log(`top-up pass: ${client.tag} failed (try ${tries} of ${FAILED_TRIES}): ${msg}`);
      await pool.query(
        `UPDATE topup_passes
            SET last_error = $2,
                counts = jsonb_set(counts, '{failed_tries}', coalesce(counts->'failed_tries', '{}'::jsonb) || jsonb_build_object($3::text, $4::int)),
                clients_done = CASE WHEN $4 >= $5 AND NOT ($3 = ANY (clients_done)) THEN array_append(clients_done, $3) ELSE clients_done END
          WHERE id = $1`,
        [pass.id, `${client.tag}: ${msg}`, client.tag, tries, FAILED_TRIES]
      ).catch(() => {});
      if (tries < FAILED_TRIES) left++;
    }
  }
  if (left > 0) {
    log(`top-up pass ${String(pass.id).slice(0, 8)}: ${clients.length - left} of ${clients.length} clients done, the rest next firing`);
    const { rows: [p] } = await pool.query(`SELECT * FROM topup_passes WHERE id = $1`, [pass.id]);
    return p;
  }
  const counts = await passCounts(pool, pass.id);
  const { rows: [p] } = await pool.query(
    `UPDATE topup_passes SET state = 'done', finished_at = now(),
            counts = $2::jsonb || CASE WHEN counts ? 'failed_tries' THEN jsonb_build_object('failed_tries', counts->'failed_tries') ELSE '{}'::jsonb END
      WHERE id = $1 AND state = 'running' RETURNING *`,
    [pass.id, JSON.stringify(counts)]
  );
  log(`top-up pass ${String(pass.id).slice(0, 8)}: done, ${counts.clients} clients, ${counts.low_places} low places, ${counts.pulls} pulls`);
  return p ?? pass;
}
