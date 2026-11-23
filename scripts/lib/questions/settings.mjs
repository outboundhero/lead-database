// The question_variables switch and its limits (139), read from
// enrich_settings. Standalone on purpose: the push-worker imports it, and it
// must not change scripts/lib/enrich/settings.mjs, which the push-worker
// already loads.
//
// Semantics, as every other switch: the feature runs for a client only when
// enabled is true AND the client's tag is listed. A missing row or table (139
// not applied yet) reads as the defaults, i.e. off.

/** Mirrors the row 139 seeds. */
export const QUESTION_SETTINGS_DEFAULTS = Object.freeze({
  enabled: false,
  tags: Object.freeze([]),
  max_words: 16,
  research_model: null,
  question_model: null,
  max_searches: 2,
  usd_per_day: 10,
  concurrency: 4,
});

function intIn(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
}

function numIn(v, lo, hi, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
}

function modelOrNull(v) {
  return typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(v.trim()) ? v.trim() : null;
}

/**
 * A stored value made safe to use: unknown keys dropped, bad values replaced by the defaults.
 * @param {unknown} value the enrich_settings value (jsonb), or anything
 */
export function questionSettingsFrom(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const d = QUESTION_SETTINGS_DEFAULTS;
  const tags = Array.isArray(v.tags)
    ? [...new Set(v.tags.filter((t) => typeof t === "string").map((t) => t.trim().toUpperCase()).filter(Boolean))]
    : [];
  return {
    enabled: v.enabled === true,
    tags,
    max_words: intIn(v.max_words, 4, 40, d.max_words),
    research_model: modelOrNull(v.research_model),
    question_model: modelOrNull(v.question_model),
    max_searches: intIn(v.max_searches, 0, 5, d.max_searches),
    usd_per_day: numIn(v.usd_per_day, 0, 500, d.usd_per_day),
    concurrency: intIn(v.concurrency, 1, 16, d.concurrency),
  };
}

/**
 * Whether question variables are on for this client.
 * @param {ReturnType<typeof questionSettingsFrom>} settings
 * @param {string | null | undefined} tag
 */
export function questionSwitchOn(settings, tag) {
  const t = String(tag ?? "").trim().toUpperCase();
  return Boolean(settings?.enabled) && t !== "" && Array.isArray(settings?.tags) && settings.tags.includes(t);
}

/**
 * Reads the setting. Works before 139 is applied (missing table or row = defaults).
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 */
export async function loadQuestionSettings(db) {
  try {
    const { rows } = await db.query("SELECT value FROM enrich_settings WHERE key = 'question_variables'");
    return questionSettingsFrom(rows[0]?.value);
  } catch (e) {
    if (e && typeof e === "object" && (e.code === "42P01" || e.code === "42703")) return questionSettingsFrom(null);
    throw e;
  }
}
