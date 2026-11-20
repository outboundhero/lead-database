// Starting an AI Ark tab pull: the checks POST /api/aiark/runs has always made,
// in one function the route and the topup-worker both call, so a pull the
// weekly top-up starts on its own meets exactly the rules a manager's does.
//
//   - one run per client at a time (a cancelled run still reading the export
//     it paid for counts);
//   - a live pull only while the enrichment worker is online (a pull queued
//     with no worker would start spending the moment one appears);
//   - the client's saved people filters, else a cleaning client's standard
//     filters (filtersFor, scope "ai_ark"); with neither, nothing starts;
//   - the versions the tab loaded, when the caller has them;
//   - the plan's blockers.
//
// A cleaning client's search leaves out the built-in competitors list beside
// the standard keywords (competitors.mjs), read here when the run starts, so
// an edit on the Lists page applies to the next pull. The run keeps what it
// used in filters.keywords (keywordsRecord in filters.mjs): the whole union,
// which the Outcome (client_exclusions) and a one-at-a-time pull's buying
// (runs.mjs) check again after the pull.
//
// Two optional parts, both for the weekly top-up (migration 135):
//   - places: a list of the client's own include locations. The search then
//     covers only those places (a copy of the rules holding just them, the
//     exclusions kept). Each person is still checked against the client's
//     whole area after the pull.
//   - topupPullId: a prepared top-up pull of this client (topup_pulls). The
//     run is then marked filters.topup = { pass, pull, places }, and starts
//     only while the client is on the top-up pull list, can receive leads
//     (fn_client_receive_block, migration 132), fewer than pulls_per_day
//     top-up pulls started today (UTC), and its brake fits inside the weekly
//     budget, in all and for the client (scripts/lib/topup/budget.mjs).
//
// Plain JavaScript: the Next.js routes and the worker share it. Every query
// runs on the caller's client, inside the caller's transaction.

import { buildRequests, cleanPeopleFilters } from "./filters.mjs";
import { readCompetitors } from "./competitors.mjs";
import { filtersFor, standardFor } from "./standard-filters.mjs";
import { placeKeyOf } from "./company-filters.mjs";
import { brakeFor, createRun } from "./runs.mjs";
import { settingsFrom } from "../enrich/settings.mjs";
import { TOPUP_FILTER_KEY } from "../overlap-topup.mjs";
import { budgetAllows, pullsStartedToday, topupBudget, TOPUP_BUDGET_LOCK } from "../topup/budget.mjs";

/** The enrichment worker writes a heartbeat about every 10 s; 45 s of silence means it is down (src/lib/enrich/queries.ts). */
export const WORKER_ONLINE_WITHIN_S = 45;

/** Does the client have a run going? A cancelled run still reading the export it paid for counts. $1 = the tag. */
export const ACTIVE_RUN_SQL = `SELECT id, status FROM aiark_runs
            WHERE client_tag = $1
              AND (status IN ('queued', 'running')
                   OR (status = 'cancelled' AND finished_at IS NULL AND jsonb_typeof(progress->'job') = 'object'))
            LIMIT 1`;

const fmt = (n) => Math.round(Number(n)).toLocaleString("en-US");

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 */

/**
 * Is the enrichment worker online (the same rule as workerState() in src/lib/enrich/queries.ts)?
 * @param {Db} db
 * @returns {Promise<boolean>}
 */
export async function enrichWorkerOnline(db) {
  const { rows } = await db.query(
    `SELECT extract(epoch FROM now() - last_seen)::int AS seconds_ago, info FROM enrich_worker_state ORDER BY last_seen DESC LIMIT 1`
  );
  const w = rows[0];
  return Boolean(w) && w.seconds_ago <= WORKER_ONLINE_WITHIN_S && !w.info?.stopped;
}

/**
 * @param {Db} db
 * @param {string} tag
 * @returns {Promise<any>} { tag, name, client_type, status } or null
 */
export async function clientInfo(db, tag) {
  const { rows } = await db.query(`SELECT tag, name, client_type, status FROM client_tags WHERE tag = $1`, [tag]);
  return rows[0] ?? null;
}

// `version` is updated_at as text, exactly as Postgres prints it: the page
// hands it back with a save or a pull, and a different value means someone
// changed the row since the page loaded it. Compared as text, never as a Date
// (a Date drops the microseconds).

/**
 * @param {Db} db
 * @param {string} tag
 * @returns {Promise<any>} the rules row with `version`, or null
 */
export async function targetingOf(db, tag) {
  const { rows } = await db.query(
    `SELECT client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at,
            updated_at::text AS version
       FROM client_targeting WHERE client_tag = $1`,
    [tag]
  );
  return rows[0] ?? null;
}

/**
 * @param {Db} db
 * @param {string} tag
 * @param {{ lock?: boolean }} [opts]
 * @returns {Promise<any>} the saved people filters with `version`, or null
 */
export async function savedPeople(db, tag, { lock = false } = {}) {
  const { rows } = await db.query(
    `SELECT titles, title_mode, exclude_titles, seniority, departments, employee_bands, industries, exclude_industries,
            updated_at, updated_at::text AS version
       FROM client_people_filters WHERE client_tag = $1${lock ? " FOR UPDATE" : ""}`,
    [tag]
  );
  return rows[0] ?? null;
}

/**
 * The saved filters, or what applies until someone saves: the standard
 * filters for a cleaning client, nothing otherwise (filtersFor(), scope
 * "ai_ark"). from "none" means the client has neither, so a pull is blocked.
 *
 * @param {Record<string, unknown> | null} saved  savedPeople()'s row
 * @param {string | null} clientType
 * @returns {{ saved: boolean, updatedAt: string | null, version: string | null, defaultsFrom: "cleaning" | null,
 *             from: "saved" | "cleaning" | "none", value: any }}
 */
export function peopleFor(saved, clientType) {
  const { updated_at, version, ...stored } = saved ?? {};
  const r = filtersFor(saved ? stored : null, { clientType, scope: "ai_ark" });
  if (r.from === "saved") {
    return {
      saved: true,
      updatedAt: /** @type {string} */ (updated_at),
      version: /** @type {string} */ (version),
      defaultsFrom: null,
      from: "saved",
      value: cleanPeopleFilters(r.value).value,
    };
  }
  return { saved: false, updatedAt: null, version: null, defaultsFrom: r.from === "cleaning" ? "cleaning" : null, from: r.from, value: r.value };
}

/**
 * The built-in competitors list as stored now (readCompetitors), for a client
 * whose AI Ark tab searches send the standard keywords (a cleaning client);
 * undefined for any other, whose searches don't use it.
 *
 * @param {Db} db
 * @param {string | null} clientType
 * @returns {Promise<import("./competitors.mjs").Competitors | undefined>}
 */
export async function competitorsOf(db, clientType) {
  return standardFor(clientType, "ai_ark") ? readCompetitors(db) : undefined;
}

/**
 * What AI Ark would be asked: the request bodies, the report, notes and blockers,
 * and the excluded keywords a pull keeps (null for a client the standard
 * keywords don't apply to).
 *
 * @param {Record<string, unknown> | null} targeting
 * @param {object} people
 * @param {any} geo  loadGeo()'s value
 * @param {string | null} [clientType]
 * @param {import("./competitors.mjs").Competitors} [competitors]  readCompetitors()'s value (the 069 seed when left out)
 * @returns {{ requests: object[], searches: number, report: any, notes: string[], blockers: string[], pullBlockers: string[],
 *             example: object | null, keywords: object | null }}
 */
export function planFor(targeting, people, geo, clientType = null, competitors = undefined) {
  const built = buildRequests({ targeting, people, geo, cleaning: standardFor(clientType, "ai_ark"), competitors });
  return {
    requests: built.requests,
    searches: built.requests.length,
    report: built.report,
    notes: built.notes,
    blockers: built.blockers,
    pullBlockers: built.pullBlockers,
    example: built.requests[0] ?? null,
    keywords: built.keywords ?? null,
  };
}

/**
 * A place as the coverage popup and the Low places tab name it: "Tucson, AZ",
 * "AZ (state-wide)" or the country code.
 * @param {any} e  a client_targeting entry
 */
export function placeLabel(e) {
  if (e?.city && e?.state) return `${e.city}, ${e.state}`;
  if (e?.state) return `${e.state} (state-wide)`;
  return String(e?.country ?? "?");
}

/**
 * A copy of the rules holding only the given include places, each of which
 * must be one of the client's own (matched by placeKeyOf, so case and spacing
 * do not matter). Excluded places and terms are kept.
 *
 * @param {any} targeting  targetingOf()'s row
 * @param {unknown} places
 * @returns {{ targeting: any, entries: object[], labels: string[], error: null } | { error: string }}
 */
export function subsetTargeting(targeting, places) {
  if (!Array.isArray(places) || places.length === 0) return { error: "places must be a list of the client's own places." };
  if (places.length > 200) return { error: "At most 200 places in one pull." };
  /** @type {Map<string, object>} */
  const own = new Map();
  for (const e of Array.isArray(targeting?.include_locations) ? targeting.include_locations : []) {
    const k = placeKeyOf(e);
    if (k && !own.has(k)) own.set(k, e);
  }
  const entries = [];
  const seen = new Set();
  for (const p of places) {
    const k = p && typeof p === "object" ? placeKeyOf(p) : null;
    const hit = k ? own.get(k) : undefined;
    if (!k || !hit) return { error: `${placeLabel(p)} is not one of the client's places, so nothing was started.` };
    if (!seen.has(k)) {
      seen.add(k);
      entries.push(hit);
    }
  }
  return { targeting: { ...targeting, include_locations: entries }, entries, labels: entries.map(placeLabel), error: null };
}

/** Do two place lists name the same places (as sets, by placeKeyOf)? */
export function samePlaces(a, b) {
  const keys = (l) => new Set((Array.isArray(l) ? l : []).map((e) => placeKeyOf(e)).filter(Boolean));
  const x = keys(a);
  const y = keys(b);
  return x.size > 0 && x.size === y.size && [...x].every((k) => y.has(k));
}

/**
 * Why a client cannot get top-up pulls, or null when it can (the topup_pull
 * switch: the top-up on, pull mode prepare or auto, the client's type covered
 * and its tag on pull_tags).
 *
 * @param {any} settings  settingsFrom()'s value
 * @param {string} tag
 * @param {string | null} clientType
 * @returns {{ code: "topup_off" | "pull_mode_off" | "not_covered" | "not_on_pull_list", error: string } | null}
 */
export function topupPullRefusal(settings, tag, clientType) {
  const wt = settings.weekly_topup;
  if (settings.flagOn("topup_pull", tag, { clientType: clientType ?? undefined })) return null;
  if (!wt.enabled) return { code: "topup_off", error: "The weekly top-up is switched off, so nothing was started." };
  if (wt.pull_mode === "off") return { code: "pull_mode_off", error: "Top-up pulls are switched off (pull mode off), so nothing was started." };
  if (!settings.flagOn("weekly_topup", tag, { clientType: clientType ?? undefined })) {
    return { code: "not_covered", error: `The weekly top-up does not cover ${tag}'s client type (${clientType || "none"}), so nothing was started.` };
  }
  return { code: "not_on_pull_list", error: `${tag} is not on the top-up pull list, so nothing was started.` };
}

/**
 * Starts a pull, or says why not. `db` is a client inside the caller's
 * transaction; nothing is written unless a run is created.
 *
 * @param {Db} db
 * @param {{ tag: string, mode: "live" | "demo", strategy: "single" | "export", size: number, matchCount?: number | null,
 *           versions?: { people: string | null, rules: string | null } | null, places?: unknown, topupPullId?: string | null,
 *           createdBy?: string | null, geo: any, workerOnline?: (db: any) => Promise<boolean> }} opts
 *   versions: null skips the version check (the worker reads the current rows); geo: loadGeo()'s value, or a function giving it.
 * @returns {Promise<{ run: any, pull: any | null } | { status: number, error: string, code: string, changed?: boolean }>}
 */
export async function startRun(db, opts) {
  const {
    tag, mode, strategy, size, matchCount = null, versions = null, places = null, topupPullId = null, createdBy = null,
    geo, workerOnline = enrichWorkerOnline,
  } = opts;
  // Two clicks at once (or the worker and a click) must not start two runs for the client.
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('aiark-run:' || $1))`, [tag]);
  const { rows: active } = await db.query(ACTIVE_RUN_SQL, [tag]);
  if (active.length) {
    const error = active[0].status === "cancelled"
      ? `${tag}'s cancelled run is still reading the export it paid for. Start a new run once that finishes.`
      : `${tag} already has a run going. Cancel it or let it finish first.`;
    return { status: 409, error, code: "run_active" };
  }
  // A pull queued now would start spending the moment a worker appears.
  if (mode === "live" && !(await workerOnline(db))) {
    return { status: 409, error: "Pulls aren't switched on yet: the service that runs them is off, so nothing was started.", code: "worker_offline" };
  }
  const client = await clientInfo(db, tag);
  if (!client) return { status: 404, error: `${tag} is not a client`, code: "not_client" };
  const targeting = await targetingOf(db, tag);
  const saved = await savedPeople(db, tag);
  if (versions) {
    const peopleChanged = (saved?.version ?? null) !== versions.people;
    if (peopleChanged || (targeting?.version ?? null) !== versions.rules) {
      const what = peopleChanged ? "people filters" : "rules (locations and exclusions)";
      return { status: 409, error: `${tag}'s ${what} changed since this page loaded them, so nothing was started.`, changed: true, code: "changed" };
    }
  }
  const clientType = client.client_type ?? null;
  const people = peopleFor(saved, clientType);

  /** @type {any} */
  let pull = null;
  /** @type {any} */
  let settings = null;
  let wantPlaces = places;
  if (topupPullId) {
    const { rows } = await db.query(`SELECT * FROM topup_pulls WHERE id = $1 FOR UPDATE`, [topupPullId]);
    pull = rows[0] ?? null;
    if (!pull || pull.client_tag !== tag) return { status: 404, error: `That top-up pull is not one of ${tag}'s.`, code: "pull_missing" };
    if (pull.state !== "prepared") return { status: 409, error: `That top-up pull is ${pull.state}, not waiting to start.`, code: "pull_state" };
    if (strategy !== "single") return { status: 400, error: "A top-up pull runs one person at a time (strategy single).", code: "strategy" };
    if (size > pull.size) return { status: 400, error: `A top-up pull is at most its prepared size (${fmt(pull.size)} people).`, code: "size" };
    if (wantPlaces == null) wantPlaces = pull.places;
    else if (!samePlaces(wantPlaces, pull.places)) {
      return { status: 400, error: "These places are not the prepared top-up pull's, so nothing was started.", code: "places" };
    }
    const { rows: srows } = await db.query(`SELECT key, value FROM enrich_settings`);
    settings = settingsFrom(srows);
    const refused = topupPullRefusal(settings, tag, clientType);
    if (refused) return { status: 409, ...refused };
    const { rows: [rb] } = await db.query(`SELECT public.fn_client_receive_block($1) AS block`, [tag]);
    if (rb?.block) return { status: 409, error: `${tag} cannot get top-up leads (${rb.block}), so nothing was started.`, code: "cannot_receive" };
  }

  let use = targeting;
  /** @type {string[] | null} */
  let labels = null;
  if (wantPlaces != null && targeting) {
    const sub = subsetTargeting(targeting, wantPlaces);
    if (sub.error !== null) return { status: 400, error: sub.error, code: "places" };
    use = sub.targeting;
    labels = sub.labels;
  }
  const g = typeof geo === "function" ? await geo() : geo;
  const p = planFor(use, people.value, g, clientType, await competitorsOf(db, clientType));
  const blocked = [...p.blockers, ...p.pullBlockers];
  if (blocked.length) {
    return { status: 400, error: blocked.join(" "), code: people.from === "none" && p.pullBlockers.length ? "no_people_filters" : "blocked" };
  }

  let brake = null;
  if (pull) {
    // One budget check at a time, so two starts cannot both fit in the room left.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [TOPUP_BUDGET_LOCK]);
    const wt = settings.weekly_topup;
    const today = await pullsStartedToday(db);
    if (today >= wt.pulls_per_day) {
      return {
        status: 409,
        error: `${fmt(today)} top-up ${today === 1 ? "pull has" : "pulls have"} started today (the limit is ${fmt(wt.pulls_per_day)}), so nothing was started.`,
        code: "pulls_per_day",
      };
    }
    brake = brakeFor(size, p.requests.length);
    const b = await topupBudget(db, { tag });
    if (!budgetAllows(b, { weekly: wt.weekly_credits, clientWeekly: wt.client_weekly_credits, extra: brake })) {
      return {
        status: 409,
        error:
          `Starting this pull could pass the weekly top-up budget: ${fmt(b.used)} credits used and ${fmt(b.reserved)} held for runs going, ` +
          `of ${fmt(wt.weekly_credits)} (${tag}: ${fmt(b.clientUsed + b.clientReserved)} of ${fmt(wt.client_weekly_credits)}), ` +
          `and this pull may spend up to ${fmt(brake)}. Nothing was started.`,
        code: "budget",
      };
    }
  }

  const peopleUpdatedAt = saved?.updated_at ?? null;
  const run = await createRun(db, {
    tag,
    mode,
    strategy,
    size,
    filters: {
      people: people.value,
      people_updated_at: peopleUpdatedAt,
      targeting_updated_at: targeting?.updated_at ?? null,
      report: p.report,
      notes: p.notes,
      ...(p.keywords ? { keywords: p.keywords } : {}),
      ...(labels ? { places: labels } : {}),
      ...(pull ? { [TOPUP_FILTER_KEY]: { pass: pull.pass_id ?? null, pull: pull.id, places: labels ?? [] } } : {}),
    },
    requests: p.requests,
    matchCount,
    createdBy,
  });
  if (pull) {
    const { rows: [after] } = await db.query(
      `UPDATE topup_pulls SET state = 'started', run_id = $2, started_at = now(), started_by = $3, brake = $4, note = NULL
        WHERE id = $1 RETURNING *`,
      [pull.id, run.id, createdBy, brake]
    );
    await db.query(`UPDATE topup_flags SET action = 'started', run_id = $2, reason = NULL WHERE pull_id = $1`, [pull.id, run.id]);
    pull = after;
  }
  return { run, pull };
}
