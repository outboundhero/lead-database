// The weekly top-up's AI Ark people pulls (migration 135, plan 2.4 and 2.5).
//
// A pass writes, for a client with low places, one pull limited to those
// places (topup_pulls): the places, the size (the leads missing in them, at
// most max_pull_size), the requests buildRequests() makes from a copy of the
// client's rules holding only those places (exclusions kept), and the brake.
//
//   pull_mode "prepare"  the pull waits as "prepared" for a manager to count
//                        and start it on the Sharing page's Low places tab
//                        (POST /api/aiark/count and /api/aiark/runs with
//                        topupPullId);
//   pull_mode "auto"     the topup-worker starts it, within the weekly budget
//                        and pulls_per_day, one run per client at a time. A
//                        pull that cannot start yet (budget, the day's pulls, a
//                        run going, the worker off) waits as "prepared" and is
//                        tried again each hour until the next pass replaces it.
//
// Starting goes through scripts/lib/aiark/start-run.mjs, the AI Ark run
// route's own checks, so a pull the worker starts meets the same rules as a
// manager's. Auto mode makes no count (match_count is only shown).

import { settingsFrom } from "../enrich/settings.mjs";
import { brakeFor } from "../aiark/runs.mjs";
import {
  enrichWorkerOnline, peopleFor, placeLabel, planFor, savedPeople, startRun, subsetTargeting, targetingOf, topupPullRefusal,
} from "../aiark/start-run.mjs";
import { budgetAllows, topupBudget, TOPUP_BUDGET_LOCK } from "./budget.mjs";

const fmt = (n) => Math.round(Number(n)).toLocaleString("en-US");

/** At most this many places in one pull (topup_pulls.places, 135). The lowest go first. */
export const PULL_PLACES_MAX = 200;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {Db & { connect: () => Promise<Db & { release: () => void }> }} DbPool
 */

/**
 * The settings as stored now (no cache: the worker and the routes act on the latest).
 * @param {Db} db
 */
export async function readTopupSettings(db) {
  const { rows } = await db.query(`SELECT key, value FROM enrich_settings`);
  return settingsFrom(rows);
}

/**
 * Runs fn on a client of its own inside a transaction.
 * @template T
 * @param {DbPool} pool
 * @param {(c: Db) => Promise<T>} fn
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function inTx(pool, fn, timeoutMs = 60_000) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.floor(timeoutMs))}`);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// ── Counting a prepared pull (POST /api/aiark/count with topupPullId) ──────

/**
 * The prepared pull a count is for, or why it cannot be counted: it must be
 * this client's and waiting to start, the client must be on the top-up pull
 * list and able to receive.
 *
 * @param {Db} db
 * @param {{ tag: string, pullId: string, clientType: string | null }} opts
 * @returns {Promise<any>} the pull row, or { status, error }
 */
export async function topupPullForCount(db, { tag, pullId, clientType }) {
  const { rows } = await db.query(`SELECT * FROM topup_pulls WHERE id = $1`, [pullId]);
  const pull = rows[0] ?? null;
  if (!pull || pull.client_tag !== tag) return { status: 404, error: `That top-up pull is not one of ${tag}'s.` };
  if (pull.state !== "prepared") return { status: 409, error: `That top-up pull is ${pull.state}, not waiting to start.` };
  const settings = await readTopupSettings(db);
  const refused = topupPullRefusal(settings, tag, clientType);
  if (refused) return { status: 409, error: refused.error.replace("nothing was started", "nothing was counted") };
  const { rows: [rb] } = await db.query(`SELECT public.fn_client_receive_block($1) AS block`, [tag]);
  if (rb?.block) return { status: 409, error: `${tag} cannot get top-up leads (${rb.block}), so nothing was counted.` };
  return pull;
}

/**
 * Does a count of `searches` credits, and then the pull's brake, fit the
 * weekly budget left? Holds the budget lock to the end of the transaction.
 *
 * @param {Db} db
 * @param {{ tag: string, pull: any, searches: number }} opts
 * @returns {Promise<{ ok: true } | { status: number, error: string }>}
 */
export async function topupCountFits(db, { tag, pull, searches }) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [TOPUP_BUDGET_LOCK]);
  const wt = (await readTopupSettings(db)).weekly_topup;
  const b = await topupBudget(db, { tag });
  const brake = brakeFor(pull.size, searches);
  if (!budgetAllows(b, { weekly: wt.weekly_credits, clientWeekly: wt.client_weekly_credits, extra: searches + brake })) {
    return {
      status: 409,
      error:
        `This count (${fmt(searches)} ${searches === 1 ? "credit" : "credits"}) and the pull after it (up to ${fmt(brake)}) could pass the weekly ` +
        `top-up budget: ${fmt(b.used)} used and ${fmt(b.reserved)} held of ${fmt(wt.weekly_credits)}. Nothing was counted.`,
    };
  }
  return { ok: true };
}

/**
 * Adds a count's credits to its pull, so the weekly budget counts them.
 *
 * @param {Db} db
 * @param {string} pullId
 * @param {{ credits: number, total: number | null }} count  total: null when the count stopped part way
 */
export async function recordTopupCount(db, pullId, { credits, total }) {
  await db.query(
    `UPDATE topup_pulls SET count_credits = count_credits + $2, counted_at = now(), match_count = coalesce($3, match_count) WHERE id = $1`,
    [pullId, credits, total]
  );
}

// ── Preparing a pull (the pass) ─────────────────────────────────────────────

/**
 * The pull for one client's low places, or why there is none. Writes the
 * topup_pulls row (state prepared, mode = pull_mode) on `db`, inside the
 * caller's transaction. One pull per client per pass.
 *
 * @param {Db} db
 * @param {{ passId: string, client: { tag: string, client_type: string | null }, settings: any,
 *           low: Array<{ entry: any, available: number }>, minimum: number, geo: any }} opts
 *   low: the client's low places the geo reference knows, lowest first, each with its own rules entry
 * @returns {Promise<{ action: string, reason: string | null, pull: any | null }>}
 */
export async function preparePull(db, { passId, client, settings, low, minimum, geo }) {
  const tag = client.tag;
  const clientType = client.client_type ?? null;
  const wt = settings.weekly_topup;
  if (wt.pull_mode === "off") return { action: "pull_mode_off", reason: "Top-up pulls are switched off (pull mode off).", pull: null };
  if (!settings.flagOn("topup_pull", tag, { clientType: clientType ?? undefined })) {
    return { action: "not_on_pull_list", reason: `${tag} is not on the top-up pull list.`, pull: null };
  }
  const people = peopleFor(await savedPeople(db, tag), clientType);
  if (people.from === "none") {
    return {
      action: "no_people_filters",
      reason: `${tag} has no saved AI Ark people filters, and only Cleaning clients get the standard ones. Save its filters on the AI Ark tab.`,
      pull: null,
    };
  }
  const picked = low.slice(0, PULL_PLACES_MAX);
  const targeting = await targetingOf(db, tag);
  const sub = subsetTargeting(targeting, picked.map((l) => l.entry));
  if (sub.error !== null) return { action: "blocked", reason: sub.error, pull: null };
  const p = planFor(sub.targeting, people.value, geo, clientType);
  const blocked = [...p.blockers, ...p.pullBlockers];
  if (blocked.length) return { action: "blocked", reason: blocked.join(" "), pull: null };
  const need = picked.reduce((s, l) => s + Math.max(0, minimum - l.available), 0);
  const size = Math.max(1, Math.min(need, wt.max_pull_size));
  const brake = brakeFor(size, p.requests.length);
  await db.query(
    `INSERT INTO topup_pulls (pass_id, client_tag, mode, state, places, size, requests, brake, note)
     VALUES ($1, $2, $3, 'prepared', $4::jsonb, $5, $6::jsonb, $7, $8)
     ON CONFLICT (pass_id, client_tag) WHERE pass_id IS NOT NULL DO NOTHING`,
    [
      passId, tag, wt.pull_mode, JSON.stringify(sub.entries), size, JSON.stringify(p.requests), brake,
      `${fmt(need)} good ${need === 1 ? "lead is" : "leads are"} missing in ${picked.length} ${picked.length === 1 ? "place" : "places"}` +
        (need > size ? `; this pull asks for ${fmt(size)} (the largest top-up pull)` : "") + ".",
    ]
  );
  const { rows: [pull] } = await db.query(`SELECT * FROM topup_pulls WHERE pass_id = $1 AND client_tag = $2`, [passId, tag]);
  // A pass that carries on after a crash finds the pull it already wrote, maybe started.
  if (pull?.state === "started") return { action: "started", reason: null, pull };
  return {
    action: "prepared",
    reason: wt.pull_mode === "prepare" ? "Prepared: a manager counts and starts it on the Low places tab." : "Waiting to start within the weekly budget.",
    pull,
  };
}

// ── Starting waiting pulls (auto mode, every hour) ──────────────────────────

/** start-run.mjs refusal code → topup_flags.action, and whether the pull waits (true) or is skipped. */
const REFUSAL = Object.freeze({
  run_active: ["run_active", true],
  worker_offline: ["blocked", true],
  pulls_per_day: ["pulls_per_day", true],
  budget: ["budget", true],
  cannot_receive: ["cannot_receive", false],
  not_on_pull_list: ["not_on_pull_list", false],
  pull_mode_off: ["pull_mode_off", false],
  topup_off: ["blocked", false],
  not_covered: ["blocked", false],
  no_people_filters: ["no_people_filters", false],
  blocked: ["blocked", false],
});

/**
 * Starts the auto pulls waiting to start, oldest first, within the budget and
 * pulls_per_day. Each start is its own transaction. Returns what happened.
 *
 * @param {DbPool} pool
 * @param {{ settings: any, mode: "live" | "demo", geo: any, log?: (m: string) => void, deadline?: number, tagPrefix?: string | null,
 *           workerOnline?: (db: any) => Promise<boolean> }} opts
 * @returns {Promise<{ started: number, waiting: number, skipped: number, errors: number }>}
 */
export async function startWaitingPulls(pool, { settings, mode, geo, log = () => {}, deadline = Infinity, tagPrefix = null, workerOnline = enrichWorkerOnline }) {
  const out = { started: 0, waiting: 0, skipped: 0, errors: 0 };
  const wt = settings.weekly_topup;
  if (!wt.enabled || wt.pull_mode !== "auto") return out;
  const { rows: pulls } = await pool.query(
    `SELECT p.* FROM topup_pulls p
      WHERE p.state = 'prepared' AND p.mode = 'auto' AND ($1::text IS NULL OR starts_with(p.client_tag, $1))
      ORDER BY p.created_at, p.id`,
    [tagPrefix]
  );
  let dayFull = false;
  for (const pull of pulls) {
    if (Date.now() > deadline) break;
    const tag = pull.client_tag;
    try {
      if (dayFull) {
        await notStarted(pool, pull, "pulls_per_day", true, "The day's top-up pulls have all started; it is tried again tomorrow.");
        out.waiting++;
        continue;
      }
      // The budget left may hold a smaller pull than prepared: ask for what fits.
      const b = await topupBudget(pool, { tag });
      const left = Math.min(wt.weekly_credits - b.used - b.reserved, wt.client_weekly_credits - b.clientUsed - b.clientReserved);
      const searches = Array.isArray(pull.requests) ? pull.requests.length : 1;
      const fits = Math.floor((left - 5 * searches - 10) / 1.25);
      const size = Math.min(pull.size, fits);
      if (size < 1) {
        await notStarted(pool, pull, "budget", true, `Waiting for the weekly budget: ${fmt(b.used)} used and ${fmt(b.reserved)} held of ${fmt(wt.weekly_credits)} credits.`);
        out.waiting++;
        continue;
      }
      const res = await inTx(pool, (c) =>
        startRun(c, {
          tag, mode, strategy: "single", size, matchCount: null, versions: null, places: pull.places, topupPullId: pull.id,
          createdBy: null, geo, workerOnline,
        })
      );
      if ("run" in res) {
        out.started++;
        log(`top-up: started a ${mode} pull of ${fmt(size)} people for ${tag} (run ${String(res.run.id).slice(0, 8)}, pull ${String(pull.id).slice(0, 8)})`);
        continue;
      }
      const [action, waits] = REFUSAL[/** @type {keyof typeof REFUSAL} */ (res.code)] ?? ["blocked", false];
      if (res.code === "pulls_per_day") dayFull = true;
      await notStarted(pool, pull, action, waits, res.error);
      if (waits) out.waiting++;
      else out.skipped++;
    } catch (e) {
      out.errors++;
      const msg = String(/** @type {any} */ (e)?.message ?? e).slice(0, 300);
      log(`top-up: could not start the pull for ${tag}: ${msg}`);
      await notStarted(pool, pull, "error", true, `Could not start: ${msg}`).catch(() => {});
    }
  }
  return out;
}

/** A pull that did not start: its note and its flags say why; it waits, or is skipped for this week. */
async function notStarted(db, pull, action, waits, why) {
  await db.query(
    `UPDATE topup_pulls SET note = $2, state = CASE WHEN $3 THEN state ELSE 'skipped' END WHERE id = $1 AND state = 'prepared'`,
    [pull.id, String(why).slice(0, 500), waits]
  );
  await db.query(`UPDATE topup_flags SET action = $2, reason = $3 WHERE pull_id = $1`, [pull.id, action, String(why).slice(0, 500)]);
}

/** The places of a pull as labels ("Tucson, AZ"), for logs and the tab. */
export function pullLabels(pull) {
  return (Array.isArray(pull?.places) ? pull.places : []).map(placeLabel);
}
