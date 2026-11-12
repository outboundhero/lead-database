// Run-time settings for the Clay tab's company pipeline (enrich_settings,
// migration 124): the on/off switch, the caps, how long paid answers are
// remembered, and the model for each AI step, so a model is swapped without a
// deploy. The worker and the Companies tab read them through readSettings(),
// at most 30 seconds old.
//
// Every value is checked as it is read: one that isn't valid counts as unset
// and its default applies, except a model, which has no default once the
// models row exists (ai_web then refuses to guess: a missing setting is an
// error, never a fallback to some other model).

const TTL_MS = 30_000;

export const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,60}$/;
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
export const MODEL_SETTINGS = ["website_search", "email_search_first", "email_search_second", "fit_score"];

/** What applies until the table says otherwise. The same values migration 124 seeds. */
export const SETTINGS_DEFAULTS = Object.freeze({
  company_pipeline: {
    enabled: false,
    max_pull_size: 1000,
    email_checks_per_company: 3,
    memory_days: { website: 365, email: 90, nothing_found: 30 },
  },
  models: {
    website_search: { model: "gpt-4o-mini", max_searches: 2 },
    email_search_first: { model: "gpt-5-nano", reasoning_effort: "low", max_searches: 3 },
    email_search_second: { model: "gpt-4o-mini", max_searches: 2 },
    fit_score: null,
  },
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const wholeIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

/** One model setting checked: { model, reasoning_effort?, max_searches? }, or null when it isn't usable. */
export function cleanModelSetting(v) {
  if (!isObject(v) || typeof v.model !== "string" || !MODEL_ID.test(v.model)) return null;
  const out = { model: v.model };
  if (typeof v.reasoning_effort === "string" && REASONING_EFFORTS.includes(v.reasoning_effort)) out.reasoning_effort = v.reasoning_effort;
  if (wholeIn(v.max_searches, 1, 5)) out.max_searches = v.max_searches;
  return out;
}

/**
 * The settings as stored (rows: [{ key, value }]) laid over the defaults.
 * Exported for the Companies tab's settings route and the tests.
 */
export function settingsFrom(rows) {
  const byKey = new Map((rows ?? []).map((r) => [r.key, r.value]));
  const d = SETTINGS_DEFAULTS.company_pipeline;
  const cp = isObject(byKey.get("company_pipeline")) ? byKey.get("company_pipeline") : {};
  const days = isObject(cp.memory_days) ? cp.memory_days : {};
  const company_pipeline = {
    enabled: typeof cp.enabled === "boolean" ? cp.enabled : d.enabled,
    max_pull_size: wholeIn(cp.max_pull_size, 1, 10_000) ? cp.max_pull_size : d.max_pull_size,
    email_checks_per_company: wholeIn(cp.email_checks_per_company, 1, 5) ? cp.email_checks_per_company : d.email_checks_per_company,
    memory_days: Object.fromEntries(
      Object.entries(d.memory_days).map(([k, v]) => [k, wholeIn(days[k], 1, 3650) ? days[k] : v])
    ),
  };
  // A stored models row is taken as it is, key by key: a model set to null, or
  // to something that isn't a model id, is unset, and ai_web says so.
  const storedModels = byKey.get("models");
  const models = {};
  for (const k of MODEL_SETTINGS) {
    models[k] = isObject(storedModels)
      ? (k in storedModels ? cleanModelSetting(storedModels[k]) : cleanModelSetting(SETTINGS_DEFAULTS.models[k]))
      : cleanModelSetting(SETTINGS_DEFAULTS.models[k]);
  }
  return { company_pipeline, models };
}

let cache = null; // { at, value }

/**
 * The settings, read from enrich_settings at most every 30 seconds. Before
 * migration 124 is applied (no such table) the defaults apply, which keep the
 * pipeline switched off.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ maxAgeMs?: number }} [opts]
 */
export async function readSettings(db, { maxAgeMs = TTL_MS } = {}) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.value;
  let rows = [];
  try {
    ({ rows } = await db.query(`SELECT key, value FROM enrich_settings`));
  } catch (e) {
    if (e?.code !== "42P01") throw e; // undefined_table: migration 124 not applied yet
  }
  const value = settingsFrom(rows);
  cache = { at: Date.now(), value };
  return value;
}

/** For tests, and after the settings route saves: the next read goes to the database. */
export function resetSettingsCache() {
  cache = null;
}
