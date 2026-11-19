// The names and small rules that overlap sharing, the weekly top-up, churn
// dates and never-contact inboxes share (migrations 132 to 136), in one place
// so the worker steps, the web routes and the pages read them the same way.
// Plain JavaScript with no imports: the enrich-worker, the topup-worker, the
// scripts and the Next.js routes all load it.
//
// What is here:
//   - churnCellOf(): what a Groups tab churn cell says (132's
//     churn_cell_state), mergeChurnCells() for a tag listed twice, and
//     groupsTabRecord(), the argument of fn_client_groups_tab_record().
//   - the states and outcomes of share_jobs and lead_shares (134), the push
//     sources of share and top-up pushes, the capability the enrich-worker
//     reports, and the address and key of the automatic share push.
//   - how a top-up run is marked (aiark_runs.filters.topup) and read back.
//   - the never-contact reason and the general inbox conditions (136).
//   - the starting numbers the plan sets (chunks, paces, ages).
// Settings and switches are in scripts/lib/enrich/settings.mjs.

// ── Churn dates (132) ───────────────────────────────────────────────────────

/** What a churn cell says: client_tags.churn_cell_state. */
export const CHURN_STATES = Object.freeze(["date", "empty", "non_answer", "unreadable"]);

/** Cells that say there is no churn date: dashes (any kind, repeated), N/A, NA, none. */
const CHURN_NON_ANSWER = /^(?:-+|\u2013+|\u2014+|n\s*\/\s*a|na|none)$/i;
/** Google Sheets day numbers (days since 1899-12-30) from 2000-01-01 to 2100-12-31, the range 132 takes. */
const SERIAL_MIN = 36526;
const SERIAL_MAX = 73415;
const DAY_MS = 86_400_000;
const CELL_MAX = 200;

/**
 * @typedef {{ state: "date" | "empty" | "non_answer" | "unreadable", date: string | null, cell: string | null }} ChurnCell
 *   date: YYYY-MM-DD, only with the state "date"; cell: the cell as read, for display (at most 200 characters).
 */

/**
 * What one Groups tab churn cell says. Read the tab with valueRenderOption
 * UNFORMATTED_VALUE and dateTimeRenderOption SERIAL_NUMBER: a date cell then
 * comes as a day number, whatever the sheet's display format.
 *   - a day number from 2000-01-01 to 2100-12-31: that date (a fraction of a day is dropped);
 *   - text in M/D/YYYY (one or two digits for the month and the day), a real calendar date in those years: that date;
 *   - nothing, or only spaces: empty;
 *   - dashes, "N/A", "NA" or "none", in any case: non_answer (no date, and listed as such);
 *   - anything else ("TBD", "12/31", "2026-12-31", a number out of range, true): unreadable, which blocks the client.
 *
 * @param {unknown} value
 * @returns {ChurnCell}
 */
export function churnCellOf(value) {
  if (value === null || value === undefined) return { state: "empty", date: null, cell: null };
  if (typeof value === "number") {
    const cell = String(value).slice(0, CELL_MAX);
    if (!Number.isFinite(value)) return { state: "unreadable", date: null, cell };
    const days = Math.floor(value);
    if (days < SERIAL_MIN || days > SERIAL_MAX) return { state: "unreadable", date: null, cell };
    return { state: "date", date: new Date(Date.UTC(1899, 11, 30) + days * DAY_MS).toISOString().slice(0, 10), cell };
  }
  if (typeof value !== "string") return { state: "unreadable", date: null, cell: String(value).slice(0, CELL_MAX) };
  const s = value.replace(/\s+/g, " ").trim();
  if (!s) return { state: "empty", date: null, cell: null };
  const cell = s.slice(0, CELL_MAX);
  if (CHURN_NON_ANSWER.test(s)) return { state: "non_answer", date: null, cell };
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (year >= 2000 && year <= 2100 && d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day) {
      return { state: "date", date: d.toISOString().slice(0, 10), cell };
    }
  }
  return { state: "unreadable", date: null, cell };
}

/**
 * One tag listed twice on the Groups tab: an unreadable cell wins (it blocks),
 * then the earlier date, then any date, then a non-answer, then empty.
 *
 * @param {ChurnCell | null | undefined} a
 * @param {ChurnCell | null | undefined} b
 * @returns {ChurnCell | null}
 */
export function mergeChurnCells(a, b) {
  if (!a) return b ?? null;
  if (!b) return a;
  if (a.state === "date" && b.state === "date") return /** @type {string} */ (a.date) <= /** @type {string} */ (b.date) ? a : b;
  for (const state of ["unreadable", "date", "non_answer"]) {
    if (a.state === state) return a;
    if (b.state === state) return b;
  }
  return a;
}

/**
 * The argument of fn_client_groups_tab_record() (132) for one good read: one
 * entry per listed tag (tags as the parser cleaned them, once each).
 *
 * @param {Map<string, ChurnCell> | Iterable<[string, ChurnCell]>} cells  tag to its (merged) churn cell
 * @returns {string}  JSON text, for a jsonb parameter
 */
export function groupsTabRecord(cells) {
  const out = [];
  for (const [tag, c] of cells) {
    out.push({
      tag,
      churn_cell_state: c.state,
      churn_date: c.state === "date" ? c.date : null,
      churn_cell: c.cell ?? null,
    });
  }
  return JSON.stringify(out);
}

/** How many days ahead a churn date blocks a client (fn_client_receive_block_of, 132). */
export const CHURN_GUARD_DAYS = 15;

// ── Overlap sharing (133, 134) ──────────────────────────────────────────────

/** share_jobs.state. */
export const SHARE_JOB_STATES = Object.freeze(["waiting", "deciding", "previewed", "applied", "skipped", "no_lead_list", "error", "undone"]);

/**
 * share_jobs.reason of a skipped job. The first four are routeTagOf()'s
 * answers (scripts/lib/enrich/upload-people.mjs) for the batch's add_tags.
 */
export const SHARE_SKIP_REASONS = Object.freeze({
  before: "the import's tags are unknown (made before migration 130)",
  no_tag: "the import stamped no tag",
  not_client: "none of the import's tags is a client",
  several: "the import names more than one client",
  origin_not_on_list: "its client is not on the sharing list",
  origin_isolated: "its client is in no sharing pool",
  no_new_leads: "the import added no new lead",
});

/** lead_shares.outcome. The first two are shares; the rest say why a fitting lead was not shared. */
export const SHARE_OUTCOMES = Object.freeze([
  "shared", "own_topup", "filtered_inbox", "already_sent", "in_flight", "already_shared", "already_tagged", "same_install", "also_fits",
]);
export const SHARING_OUTCOMES = Object.freeze(["shared", "own_topup"]);
/** lead_shares.push_state: null until queued. */
export const SHARE_PUSH_STATES = Object.freeze(["queued", "pushed", "held", "dropped"]);

/** push_batches.push_options.source of a share push and of a top-up push (own_topup rows). */
export const PUSH_SOURCE_SHARE = "share";
export const PUSH_SOURCE_TOPUP = "topup";
export const SHARE_PUSH_SOURCES = Object.freeze([PUSH_SOURCE_SHARE, PUSH_SOURCE_TOPUP]);

/** Is this push batch a share or top-up push (push_batches.push_options)? */
export function isSharePush(pushOptions) {
  return Boolean(pushOptions) && SHARE_PUSH_SOURCES.includes(/** @type {any} */ (pushOptions).source);
}

/** The enrich-worker's capability for the share step (enrich_worker_state.capabilities). */
export const SHARING_CAPABILITY = "sharing";

/** cron_runs.name of the location backfill (133). */
export const CRON_LOCATION_BACKFILL = "location_backfill";

/** The automatic share push route, its key and its address (the web app's origin). */
export const SHARE_PUSH_PATH = "/api/sharing/push/auto";
export const SHARE_PUSH_KEY_MIN = 32;

/**
 * Where the enrich-worker asks for share pushes: SHARE_PUSH_URL (the web app's
 * origin), else the origin of AIARK_AUTO_ADD_URL; and SHARE_PUSH_KEY, its own
 * key (at least 32 characters, never AIARK_AUTO_ADD_KEY), so sharing never
 * turns on AI Ark adds. Null when either is missing: shares stay queued.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ url: string, key: string } | null}
 */
export function sharePushConfig(env = process.env) {
  const base = String(env?.SHARE_PUSH_URL ?? "").trim() || String(env?.AIARK_AUTO_ADD_URL ?? "").trim();
  const key = String(env?.SHARE_PUSH_KEY ?? "").trim();
  if (!base || key.length < SHARE_PUSH_KEY_MIN) return null;
  try {
    return { url: new URL(SHARE_PUSH_PATH, base).toString(), key };
  } catch {
    return null;
  }
}

/** Starting numbers from the plan (not measured; change them here only through the integrator). */
export const SHARE_CHUNK = 2000; // ids per fit statement and per apply transaction (fn_share_rule_fits takes at most 2,000)
export const SHARE_DISCOVER_MAX = 50; // batches looked at a round
export const DEAD_BATCH_HOURS = 3; // a batch left "processing" this long counts as finished
export const TAG_ROWS_PER_MINUTE = 2000; // the tag writer's pace, beside overlap_sharing.tag_rows_per_day
export const LEAD_LIST_PRUNE_DAYS = 30; // upload_batch_leads rows go this long after their job is done
export const SHARE_ROW_PRUNE_DAYS = 90; // lead_shares rows that are not shares go this long after they were decided
export const PUSH_BATCH_MAX_IDS = 25000; // ids per share push batch (scripts/queue-repush.mts)
export const SHARE_JOB_MAX_TRIES = 6; // tries before a job shows "error"

// ── The weekly top-up (135) ─────────────────────────────────────────────────

/** The key of aiark_runs.filters that marks a top-up run: filters.topup = { pass, pull, places }. */
export const TOPUP_FILTER_KEY = "topup";

/** Is this AI Ark run a top-up run (aiark_runs.filters)? SQL: filters ? 'topup'. */
export function isTopupRunFilters(filters) {
  return Boolean(filters) && typeof filters === "object" && !Array.isArray(filters) && TOPUP_FILTER_KEY in filters
    && Boolean(/** @type {any} */ (filters)[TOPUP_FILTER_KEY]);
}

/** topup_flags.kind and topup_flags.action. */
export const TOPUP_FLAG_KINDS = Object.freeze(["low", "unresolved", "no_places", "no_rules", "not_covered", "all_ok"]);
export const TOPUP_FLAG_ACTIONS = Object.freeze([
  "none", "prepared", "started", "budget", "pulls_per_day", "run_active", "not_on_pull_list", "pull_mode_off", "cannot_receive",
  "no_people_filters", "blocked", "error",
]);
export const COVERAGE_MAX_AGE_HOURS = 24; // a stored coverage row older than this, or older than the rules, is computed again
export const TOPUP_PASS_EVERY_DAYS = 7;
export const TOPUP_LOCK_KEY = "topup-worker"; // worker_locks.key

// ── Never-contact inboxes (136) ─────────────────────────────────────────────

/** suppressed_emails.reason of a general inbox on the Clay General inboxes filter. */
export const NEVER_CONTACT_REASON = "clay_general_filter";

/**
 * SQL: the lead on alias `alias` is a general inbox the filter matches. `ref`
 * is the bind parameter that holds the pattern (settings.mjs
 * inboxPatternOf(), never null here), for example "$2".
 */
export function generalInboxMatchSql(alias = "l", ref = "$1") {
  return `(${alias}.email_type = 'general' AND ${alias}.email ~* ${ref})`;
}

/**
 * SQL: the lead on alias `alias` is NOT a general inbox the filter matches,
 * true for a personal or untyped address and for one with no email. Add it
 * only when the filter is loaded; with none loaded nothing is left out.
 */
export function generalInboxExclusionSql(alias = "l", ref = "$1") {
  return `NOT (${alias}.email_type IS NOT DISTINCT FROM 'general' AND coalesce(${alias}.email ~* ${ref}, false))`;
}

/** The same test in JavaScript, for samples and checks: a JavaScript /pattern/i, as the Clay column runs it. */
export function generalInboxMatches(pattern, email, emailType) {
  return emailType === "general" && typeof email === "string" && new RegExp(pattern, "i").test(email);
}
