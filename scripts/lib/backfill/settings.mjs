// The database backfill's names and its switch (migration 138):
// enrich_settings.database_backfill, read here on its own and never through
// scripts/lib/enrich/settings.mjs, which the push-worker imports and this
// build leaves as it is. Plain JavaScript with no imports: the
// backfill-worker, the share actions and the web app's routes load it.
//
// The switch ships off: enabled false, no client listed, mode preview. A
// client on the list also needs overlap sharing's push list
// (flagOn(settings, "share_push", tag)) for its shares to be written, since
// they are pushed by the share push like any other share.

/** lead_shares.origin_tag and share_jobs.origin_tag of a backfill share: a valid tag text that is no client. */
export const BACKFILL_ORIGIN = "DATABASE";
/** upload_batches.batch_type of a firing's batch (138): never an upload, kept off the Uploads page. */
export const BACKFILL_BATCH_TYPE = "backfill";
/** share_jobs.kind of a firing's job (138). */
export const BACKFILL_JOB_KIND = "backfill";
/** worker_locks.key of the backfill-worker's lease. */
export const BACKFILL_LOCK_KEY = "backfill-worker";
/** upload_batches.source_label of a firing's batch: what the Jobs tab shows where an import shows its file. */
export const BACKFILL_SOURCE_LABEL = "Database backfill";
/** The enrich_settings key. */
export const BACKFILL_SETTING_KEY = "database_backfill";

/** The setting as 138 seeds it. */
export const BACKFILL_DEFAULTS = Object.freeze({
  enabled: false,
  tags: Object.freeze([]),
  mode: "preview",
  max_per_run: 5000,
  max_minutes: 40,
  recheck_days: 7,
  untagged: true,
});

/** The whole-number fields and their ranges (a value out of its range reads as its default, and a save refuses it). */
export const BACKFILL_RANGES = Object.freeze({
  max_per_run: Object.freeze([1, 50_000]),
  max_minutes: Object.freeze([5, 50]),
  recheck_days: Object.freeze([1, 90]),
});

/** What a save calls each field, in its error. */
const LABELS = {
  max_per_run: "Most shares a backfill firing writes",
  max_minutes: "Minutes a backfill firing works",
  recheck_days: "Days before a place is read again",
};

const TAG_TEXT = /^[A-Z0-9][A-Z0-9_&-]{0,63}$/;
const TAGS_MAX = 2000;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const wholeIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const fmt = (n) => Number(n).toLocaleString("en-US");

/** A client tag as client_tags holds it: trimmed, upper case. */
export function backfillTag(tag) {
  return String(tag ?? "").trim().toUpperCase();
}

/**
 * @typedef {{ enabled: boolean, tags: string[], mode: "preview" | "apply", max_per_run: number, max_minutes: number,
 *             recheck_days: number, untagged: boolean }} DatabaseBackfill
 */

/** The client list as stored: tags trimmed, upper case, once each, at most 64 characters, never "*". */
function tagsOf(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    if (typeof t !== "string") continue;
    const tag = backfillTag(t);
    if (!tag || tag === "*" || tag.length > 64 || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

/**
 * The database_backfill setting as stored, read field by field: a field
 * missing, of the wrong type or out of its range takes its default; tags are
 * trimmed, upper case and once each; a mode other than "apply" is "preview".
 *
 * @param {Array<{ key: string, value: unknown }> | unknown} rows  enrich_settings rows (or the value itself)
 * @returns {DatabaseBackfill}
 */
export function backfillFrom(rows) {
  const raw = Array.isArray(rows) ? rows.find((r) => r && r.key === BACKFILL_SETTING_KEY)?.value : rows;
  const v = isObject(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const D = BACKFILL_DEFAULTS;
  const R = BACKFILL_RANGES;
  return {
    enabled: v.enabled === true,
    tags: tagsOf(v.tags),
    mode: v.mode === "apply" ? "apply" : "preview",
    max_per_run: wholeIn(v.max_per_run, R.max_per_run[0], R.max_per_run[1]) ? /** @type {number} */ (v.max_per_run) : D.max_per_run,
    max_minutes: wholeIn(v.max_minutes, R.max_minutes[0], R.max_minutes[1]) ? /** @type {number} */ (v.max_minutes) : D.max_minutes,
    recheck_days: wholeIn(v.recheck_days, R.recheck_days[0], R.recheck_days[1]) ? /** @type {number} */ (v.recheck_days) : D.recheck_days,
    untagged: typeof v.untagged === "boolean" ? v.untagged : D.untagged,
  };
}

/**
 * Is the backfill on for this client: switched on, and the client listed.
 *
 * @param {Partial<DatabaseBackfill> | null | undefined} bf  as backfillFrom gives it
 * @param {unknown} tag
 */
export function backfillOn(bf, tag) {
  const t = backfillTag(tag);
  return Boolean(t) && bf?.enabled === true && Array.isArray(bf.tags) && bf.tags.includes(t);
}

/**
 * The settings sheet's save of database_backfill checked: anything out of
 * range or of the wrong type is refused with its reason, never quietly
 * replaced. A field the input leaves out keeps its value in `previous` (the
 * row as read before this save), else its default.
 *
 * @param {unknown} input
 * @param {{ previous?: Partial<DatabaseBackfill> | null }} [opts]
 * @returns {{ value: DatabaseBackfill | null, error: string | null, errors: string[] }}
 */
export function cleanDatabaseBackfill(input, { previous = null } = {}) {
  if (!isObject(input)) {
    const errors = ["Database backfill: must be the switch and its settings."];
    return { value: null, error: errors[0], errors };
  }
  const v = /** @type {Record<string, unknown>} */ (input);
  const before = backfillFrom(isObject(previous) ? previous : {});
  const pick = (k) => (v[k] === undefined ? before[k] : v[k]);
  const errors = [];

  const enabled = pick("enabled");
  if (typeof enabled !== "boolean") errors.push("The database backfill must be on or off.");
  const untagged = pick("untagged");
  if (typeof untagged !== "boolean") errors.push("Taking untagged leads must be on or off.");
  const mode = pick("mode");
  if (mode !== "preview" && mode !== "apply") errors.push("The database backfill's mode must be preview or apply.");

  const rawTags = pick("tags");
  const tags = [];
  if (!Array.isArray(rawTags)) {
    errors.push("Database backfill: the client list must be a list of tags.");
  } else {
    const bad = [];
    for (const x of rawTags) {
      const t = typeof x === "string" ? backfillTag(x) : "";
      if (!t) continue;
      if (!TAG_TEXT.test(t)) bad.push(String(x).slice(0, 40));
      else if (!tags.includes(t)) tags.push(t);
    }
    if (bad.length) errors.push(`Database backfill: ${bad.slice(0, 5).join(", ")} ${bad.length === 1 ? "is not a client tag" : "are not client tags"}.`);
    if (tags.length > TAGS_MAX) errors.push(`Database backfill: at most ${fmt(TAGS_MAX)} clients.`);
  }

  /** @type {Record<string, number>} */
  const nums = {};
  for (const k of /** @type {Array<keyof typeof BACKFILL_RANGES>} */ (["max_per_run", "max_minutes", "recheck_days"])) {
    const [lo, hi] = BACKFILL_RANGES[k];
    const n = pick(k);
    if (!wholeIn(n, lo, hi)) {
      errors.push(`${LABELS[k]} must be a whole number from ${fmt(lo)} to ${fmt(hi)}.`);
      nums[k] = lo;
    } else {
      nums[k] = /** @type {number} */ (n);
    }
  }
  if (errors.length) return { value: null, error: errors.join(" "), errors };
  return {
    value: {
      enabled: /** @type {boolean} */ (enabled),
      tags,
      mode: /** @type {"preview" | "apply"} */ (mode),
      max_per_run: nums.max_per_run,
      max_minutes: nums.max_minutes,
      recheck_days: nums.recheck_days,
      untagged: /** @type {boolean} */ (untagged),
    },
    error: null,
    errors,
  };
}
