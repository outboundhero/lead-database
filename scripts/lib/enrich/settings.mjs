// Run-time settings for the Clay tab's pipeline (enrich_settings, migrations
// 124 to 126 and 128): the switches and their client lists, the caps, how long
// paid answers are remembered, the people runs, the spend caps, the fit
// scorer, promotion and the gate, the LinkedIn sources and their starter
// keywords, and the model for each AI step, so a model is swapped without a
// deploy. The worker reads them through readSettings(),
// at most 30 seconds old; the routes read them fresh and pass the rows to
// settingsFrom().
//
// Every value is checked as it is read: one that isn't valid counts as unset
// and its default applies, except a model, which has no default once the
// models row holds its key (ai_web then refuses to guess: a missing setting is
// an error, never a fallback to some other model).
//
// Switches: every switch that spends money or reaches a send path has a client
// list (tags), which ships empty, so turning a switch on covers no client until
// a tag is added. flagOn(name, tag) says whether a switch is on for a client:
// on, and the client on its list. A sub-switch (ai_searches, auto_buy,
// linkedin_profile_reads) is on only when its parent switch is on for the client,
// and so are the LinkedIn sources (linkedin_companies needs company_pipeline,
// linkedin_people needs people_pipeline, migration 128).

const TTL_MS = 30_000;

export const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,60}$/;
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
/** A Luna model refuses "minimal" (research note 4.3): it is dropped from a Luna setting. */
const LUNA_MODEL = /luna/;

/**
 * One model setting per AI step: the twelve original Clay AI columns, then the
 * fit scorer. The key is the column's own key, except the personalisation
 * columns, whose keys repeat in two templates (people_claygent is P#60's
 * claygent, inbox_claygent G#48's, and so on).
 */
export const MODEL_SETTINGS = [
  "companys_website", // C#24
  "email_extraction_claygent", // C#31
  "email_extraction_claygent_2", // C#32
  "company_decision_maker_facilities_1_claygent", // C#41
  "company_decision_maker_facilities_2_claygent", // C#48
  "company_decision_maker_location_company_check", // C#50
  "company_decision_maker_ceo_claygent", // C#56
  "current_employer", // P#27
  "people_claygent", // P#60
  "people_question_ai", // P#61
  "inbox_claygent", // G#48
  "inbox_question_ai", // G#49
  "fit_score", // the fit scorer (phase 3), no original
];

/** The people tracks, in Spencer's order (D11): operations, then facility and office, then CEO or owner. */
export const TRACKS = ["operations", "facility_office", "ceo"];

/** Every switch flagOn() knows. The first four are the ones a template column can carry in config.flag. */
export const FLAGS = [
  "people_pipeline", "ai_searches", "linkedin_profile_reads", "personalisation",
  "company_pipeline", "auto_buy", "promotion", "fit_gate", "fit_scoring",
  "linkedin_sources", "linkedin_companies", "linkedin_people",
];

/** LinkedIn people runs buy at most this many people a company (D-P4-6): the newest Clay template's limit. */
export const PEOPLE_PER_COMPANY = 13;
/** The starter list's limits (enrich_settings.linkedin_starter_keywords, written by scripts/linkedin-seed.mjs). */
const STARTER_MAX = 2000;
const KEYWORD_MAX = 120;

const LUNA = "gpt-6-luna";

/** Deep-frozen, so no reader can change a default by accident. */
function frozen(v) {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) frozen(x);
    Object.freeze(v);
  }
  return v;
}

/**
 * What applies until the table says otherwise: the values migrations 124 to
 * 126 and 128 seed (126's fit settings and 128's LinkedIn ones included, so the
 * shape is the same before they are applied).
 */
export const SETTINGS_DEFAULTS = frozen({
  company_pipeline: {
    enabled: false,
    tags: [],
    max_pull_size: 1000,
    linkedin_profile_reads: false,
    inboxes_per_company: 5,
    min_balance: 500,
    memory_days: { website: 365, email: 90, nothing_found: 30 },
  },
  people_pipeline: {
    enabled: false,
    tags: [],
    auto_buy: false,
    ai_searches: false,
    ids_per_search: 50,
    pages_per_search: 5,
    tries_per_track: 1,
    max_people_per_run: 300,
    recheck_days: 90,
    skip_company_when_held: true,
    min_balance: 500,
  },
  personalisation: { enabled: false, tags: [], shared_text_ok: false },
  spend_caps: {
    reoon_checks_per_day: 1500,
    openai_usd_per_day: { pipeline: 20, fit: 25 },
    openai_prices: {
      "gpt-4o-mini": { in: 0.15, out: 0.6, search_tokens: 8000 },
      [LUNA]: { in: 0.1, out: 0.5 },
      web_search_call: 0.01,
    },
  },
  models: {
    companys_website: { model: LUNA, max_searches: 3 },
    email_extraction_claygent: { model: LUNA, max_searches: 2 },
    email_extraction_claygent_2: { model: LUNA, max_searches: 2 },
    company_decision_maker_facilities_1_claygent: { model: LUNA, max_searches: 2 },
    company_decision_maker_facilities_2_claygent: { model: LUNA, max_searches: 3 },
    company_decision_maker_location_company_check: { model: LUNA, max_searches: 1 },
    company_decision_maker_ceo_claygent: { model: LUNA, max_searches: 2 },
    current_employer: { model: LUNA, max_searches: 2 },
    people_claygent: { model: LUNA, max_searches: 2 },
    people_question_ai: { model: LUNA },
    inbox_claygent: { model: LUNA, max_searches: 3 },
    inbox_question_ai: { model: LUNA },
    fit_score: { model: LUNA, reasoning_effort: "low" },
  },
  /** Written by scripts/enrich-seed-originals.mjs from the originals; null until then (people runs refuse). */
  people_tracks: null,
  fit_rule: { prompt: null, version: null },
  fit_scoring: { enabled: false, batch_size: 25, calls_in_flight: 2 },
  promotion: {
    promote_to_leads: false,
    tags: [],
    min_fit_score: 2,
    batch_max: 1000,
    require_question: true,
    source_label: "Companies (AI Ark)",
  },
  fit_gate: { enabled: false, tags: [], threshold: 2, client_types: ["Cleaning", "Canada Cleaning"], require_scored: true },
  fit_gate_refresh: { pending: false, since: null },
  /** One switch for both LinkedIn sources, with its client list (D-P4-7), and the people a company (D-P4-6). */
  linkedin_sources: { enabled: false, tags: [], people_per_company: PEOPLE_PER_COMPANY },
  /** The excluded keywords of a client with no LinkedIn row (D-P4-5): empty until the seed writes them. */
  linkedin_starter_keywords: { items: [], version: null, source: null, sha256: null, seeded_at: null },
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const wholeIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const numberIn = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
const bool = (v, d) => (typeof v === "boolean" ? v : d);
const whole = (v, lo, hi, d) => (wholeIn(v, lo, hi) ? v : d);
const amount = (v, lo, hi, d) => (numberIn(v, lo, hi) ? v : d);
const objectOr = (v) => (isObject(v) ? v : {});

/** A text setting: trimmed, at most max characters, else null. */
function textOrNull(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t && t.length <= max ? t : null;
}

/** A client tag as client_tags holds it: trimmed, upper case. */
export function normTag(tag) {
  return String(tag ?? "").trim().toUpperCase();
}

/** A switch's client list: tags upper case, once each. "*" is kept only where a switch allows it (fit_gate). */
function tagsOf(v, { star = false } = {}) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const t of v) {
    if (typeof t !== "string") continue;
    const tag = normTag(t);
    if (!tag || tag.length > 64 || out.includes(tag)) continue;
    if (tag === "*" && !star) continue;
    out.push(tag);
    if (out.length >= 2000) break;
  }
  return out;
}

/** One model setting checked: { model, reasoning_effort?, max_searches? }, or null when it isn't usable. */
export function cleanModelSetting(v) {
  if (!isObject(v) || typeof v.model !== "string" || !MODEL_ID.test(v.model)) return null;
  const out = { model: v.model };
  const effort = v.reasoning_effort;
  if (typeof effort === "string" && REASONING_EFFORTS.includes(effort) && !(effort === "minimal" && LUNA_MODEL.test(v.model))) {
    out.reasoning_effort = effort;
  }
  if (wholeIn(v.max_searches, 1, 5)) out.max_searches = v.max_searches;
  return out;
}

/**
 * The prices the OpenAI caps count, dollars per 1M tokens (in, out) and per
 * web search call. A stored entry replaces the default for its model; a model
 * with no valid entry keeps the default, so the caps never count a known model
 * as free.
 */
function pricesOf(v) {
  const d = SETTINGS_DEFAULTS.spend_caps.openai_prices;
  const stored = objectOr(v);
  const out = { web_search_call: amount(stored.web_search_call, 0, 1, d.web_search_call) };
  const models = new Set([...Object.keys(d), ...Object.keys(stored)].filter((k) => k !== "web_search_call"));
  for (const m of models) {
    if (!MODEL_ID.test(m)) continue;
    const s = stored[m];
    if (isObject(s) && numberIn(s.in, 0, 1000) && numberIn(s.out, 0, 1000)) {
      out[m] = { in: s.in, out: s.out, ...(wholeIn(s.search_tokens, 0, 1_000_000) ? { search_tokens: s.search_tokens } : {}) };
    } else if (d[m]) {
      out[m] = { ...d[m] };
    }
  }
  return out;
}

/**
 * The starter list of excluded keywords (enrich_settings.linkedin_starter_keywords)
 * as the LinkedIn seed wrote it: the items trimmed, once each (case aside), at
 * most 120 characters each and 2,000 in all; anything malformed reads as not
 * loaded (no items). The resolver (scripts/lib/aiark/linkedin-settings.mjs)
 * and settingsFrom() share this reading.
 *
 * @param {unknown} v
 * @returns {{ items: string[], version: number | null, source: string | null, sha256: string | null, seeded_at: string | null }}
 */
export function starterFrom(v) {
  const s = objectOr(v);
  const items = [];
  const seen = new Set();
  for (const x of Array.isArray(s.items) ? s.items : []) {
    if (typeof x !== "string") continue;
    const t = x.replace(/\s+/g, " ").trim();
    if (!t || t.length > KEYWORD_MAX || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    items.push(t);
    if (items.length >= STARTER_MAX) break;
  }
  return {
    items,
    version: wholeIn(s.version, 1, 1_000_000) ? s.version : null,
    source: textOrNull(s.source, 300),
    sha256: typeof s.sha256 === "string" && /^[0-9a-f]{64}$/.test(s.sha256) ? s.sha256 : null,
    seeded_at: textOrNull(s.seeded_at, 64),
  };
}

/** people_tracks as the seed wrote it, or null when it is missing or malformed (people runs then refuse). */
function tracksOf(v) {
  if (!isObject(v) || !Array.isArray(v.order)) return null;
  const order = v.order.filter((t) => TRACKS.includes(t));
  if (order.length !== TRACKS.length || new Set(order).size !== TRACKS.length) return null;
  const out = { order };
  for (const t of TRACKS) {
    const x = v[t];
    if (!isObject(x) || !Array.isArray(x.phrases)) return null;
    const phrases = x.phrases.filter((p) => typeof p === "string" && p.trim()).map((p) => p.trim());
    if (!phrases.length) return null;
    out[t] = { phrases, from: Array.isArray(x.from) ? x.from.filter((f) => typeof f === "string") : [] };
  }
  return out;
}

/**
 * @typedef {{ model: string, reasoning_effort?: string, max_searches?: number }} ModelSetting
 * @typedef {{ in: number, out: number, search_tokens?: number }} ModelPrice
 * @typedef {{ order: string[], operations: { phrases: string[], from: string[] },
 *             facility_office: { phrases: string[], from: string[] }, ceo: { phrases: string[], from: string[] } }} PeopleTracks
 * @typedef {{ variant?: string, clientType?: string }} FlagContext
 *   variant: the originals variant the client's tables compile from ("default" or the client's own);
 *   clientType: client_tags.client_type, for fit_gate
 * @typedef {{
 *   company_pipeline: { enabled: boolean, tags: string[], max_pull_size: number, linkedin_profile_reads: boolean,
 *                       inboxes_per_company: number, min_balance: number,
 *                       memory_days: { website: number, email: number, nothing_found: number } },
 *   people_pipeline: { enabled: boolean, tags: string[], auto_buy: boolean, ai_searches: boolean, ids_per_search: number,
 *                      pages_per_search: number, tries_per_track: number, max_people_per_run: number, recheck_days: number,
 *                      skip_company_when_held: boolean, min_balance: number },
 *   personalisation: { enabled: boolean, tags: string[], shared_text_ok: boolean },
 *   spend_caps: { reoon_checks_per_day: number, openai_usd_per_day: { pipeline: number, fit: number },
 *                 openai_prices: Record<string, any> },
 *   models: Record<string, ModelSetting | null>,
 *   people_tracks: PeopleTracks | null,
 *   fit_rule: { prompt: string | null, version: string | null },
 *   fit_scoring: { enabled: boolean, batch_size: number, calls_in_flight: number },
 *   promotion: { promote_to_leads: boolean, tags: string[], min_fit_score: number, batch_max: number,
 *                require_question: boolean, source_label: string },
 *   fit_gate: { enabled: boolean, tags: string[], threshold: number, client_types: string[], require_scored: boolean },
 *   fit_gate_refresh: { pending: boolean, since: string | null },
 *   linkedin_sources: { enabled: boolean, tags: string[], people_per_company: number },
 *   linkedin_starter_keywords: { items: string[], version: number | null, source: string | null, sha256: string | null, seeded_at: string | null },
 *   flagOn: (name: string, tag: string, ctx?: FlagContext) => boolean,
 * }} PipelineSettings
 *   spend_caps.openai_prices: { web_search_call: number, [model]: ModelPrice }
 */

/**
 * The settings as stored (rows: [{ key, value }]) laid over the defaults.
 * Exported for the Companies tab's routes and the tests.
 *
 * @param {Array<{ key: string, value: any }> | null | undefined} rows
 * @returns {PipelineSettings}
 */
export function settingsFrom(rows) {
  const byKey = new Map((rows ?? []).map((r) => [r.key, r.value]));
  const D = SETTINGS_DEFAULTS;

  const cp = objectOr(byKey.get("company_pipeline"));
  const days = objectOr(cp.memory_days);
  const company_pipeline = {
    enabled: bool(cp.enabled, D.company_pipeline.enabled),
    tags: tagsOf(cp.tags),
    max_pull_size: whole(cp.max_pull_size, 1, 10_000, D.company_pipeline.max_pull_size),
    linkedin_profile_reads: bool(cp.linkedin_profile_reads, D.company_pipeline.linkedin_profile_reads),
    inboxes_per_company: whole(cp.inboxes_per_company, 1, 30, D.company_pipeline.inboxes_per_company),
    min_balance: amount(cp.min_balance, 0, 1_000_000, D.company_pipeline.min_balance),
    memory_days: Object.fromEntries(
      Object.entries(D.company_pipeline.memory_days).map(([k, v]) => [k, whole(days[k], 1, 3650, v)])
    ),
  };

  const pp = objectOr(byKey.get("people_pipeline"));
  const dp = D.people_pipeline;
  const people_pipeline = {
    enabled: bool(pp.enabled, dp.enabled),
    tags: tagsOf(pp.tags),
    auto_buy: bool(pp.auto_buy, dp.auto_buy),
    ai_searches: bool(pp.ai_searches, dp.ai_searches),
    ids_per_search: whole(pp.ids_per_search, 1, 300, dp.ids_per_search),
    pages_per_search: whole(pp.pages_per_search, 1, 20, dp.pages_per_search),
    tries_per_track: whole(pp.tries_per_track, 1, 10, dp.tries_per_track),
    max_people_per_run: whole(pp.max_people_per_run, 1, 10_000, dp.max_people_per_run),
    recheck_days: whole(pp.recheck_days, 1, 365, dp.recheck_days),
    skip_company_when_held: bool(pp.skip_company_when_held, dp.skip_company_when_held),
    min_balance: amount(pp.min_balance, 0, 1_000_000, dp.min_balance),
  };

  const ps = objectOr(byKey.get("personalisation"));
  const personalisation = {
    enabled: bool(ps.enabled, D.personalisation.enabled),
    tags: tagsOf(ps.tags),
    shared_text_ok: bool(ps.shared_text_ok, D.personalisation.shared_text_ok),
  };

  const sc = objectOr(byKey.get("spend_caps"));
  const usd = objectOr(sc.openai_usd_per_day);
  const spend_caps = {
    reoon_checks_per_day: whole(sc.reoon_checks_per_day, 0, 100_000, D.spend_caps.reoon_checks_per_day),
    openai_usd_per_day: {
      pipeline: amount(usd.pipeline, 0, 10_000, D.spend_caps.openai_usd_per_day.pipeline),
      fit: amount(usd.fit, 0, 10_000, D.spend_caps.openai_usd_per_day.fit),
    },
    openai_prices: pricesOf(sc.openai_prices),
  };

  // A stored models row is taken as it is, key by key: a model set to null, or
  // to something that isn't a model id, is unset, and ai_web says so. A key the
  // row doesn't hold takes its default.
  const storedModels = byKey.get("models");
  /** @type {Record<string, ModelSetting | null>} */
  const models = {};
  for (const k of MODEL_SETTINGS) {
    models[k] = isObject(storedModels) && k in storedModels ? cleanModelSetting(storedModels[k]) : cleanModelSetting(D.models[k]);
  }

  const fr = objectOr(byKey.get("fit_rule"));
  const fit_rule = { prompt: textOrNull(fr.prompt, 20_000), version: textOrNull(fr.version, 40) };

  const fs = objectOr(byKey.get("fit_scoring"));
  const fit_scoring = {
    enabled: bool(fs.enabled, D.fit_scoring.enabled),
    batch_size: whole(fs.batch_size, 1, 50, D.fit_scoring.batch_size),
    calls_in_flight: whole(fs.calls_in_flight, 1, 8, D.fit_scoring.calls_in_flight),
  };

  const pr = objectOr(byKey.get("promotion"));
  const promotion = {
    promote_to_leads: bool(pr.promote_to_leads, D.promotion.promote_to_leads),
    tags: tagsOf(pr.tags),
    min_fit_score: whole(pr.min_fit_score, 1, 5, D.promotion.min_fit_score),
    batch_max: whole(pr.batch_max, 1, 2000, D.promotion.batch_max),
    require_question: bool(pr.require_question, D.promotion.require_question),
    source_label: textOrNull(pr.source_label, 80) ?? D.promotion.source_label,
  };

  const fg = objectOr(byKey.get("fit_gate"));
  const types = Array.isArray(fg.client_types)
    ? [...new Set(fg.client_types.filter((t) => typeof t === "string" && t.trim()).map((t) => t.trim()))]
    : null;
  const fit_gate = {
    enabled: bool(fg.enabled, D.fit_gate.enabled),
    tags: tagsOf(fg.tags, { star: true }),
    threshold: whole(fg.threshold, 1, 5, D.fit_gate.threshold),
    client_types: types ?? [...D.fit_gate.client_types],
    require_scored: bool(fg.require_scored, D.fit_gate.require_scored),
  };

  const rf = objectOr(byKey.get("fit_gate_refresh"));
  const fit_gate_refresh = { pending: bool(rf.pending, false), since: textOrNull(rf.since, 64) };

  const ls = objectOr(byKey.get("linkedin_sources"));
  const linkedin_sources = {
    enabled: bool(ls.enabled, D.linkedin_sources.enabled),
    tags: tagsOf(ls.tags),
    people_per_company: whole(ls.people_per_company, 1, 100, D.linkedin_sources.people_per_company),
  };

  const settings = {
    company_pipeline,
    people_pipeline,
    personalisation,
    spend_caps,
    models,
    people_tracks: tracksOf(byKey.get("people_tracks")),
    fit_rule,
    fit_scoring,
    promotion,
    fit_gate,
    fit_gate_refresh,
    linkedin_sources,
    linkedin_starter_keywords: starterFrom(byKey.get("linkedin_starter_keywords")),
    /** @type {(name: string, tag: string, ctx?: FlagContext) => boolean} */
    flagOn: (name, tag, ctx) => flagOn(settings, name, tag, ctx),
  };
  return settings;
}

/**
 * Is a switch on for this client? On, and the client on its list.
 *   company_pipeline        enabled, tag on company_pipeline.tags (pulls)
 *   linkedin_profile_reads  company_pipeline on for the client, and linkedin_profile_reads (C#50, P#27)
 *   people_pipeline         enabled, tag on people_pipeline.tags
 *   ai_searches             people_pipeline on for the client, and ai_searches (C#41, C#48, C#50, C#56)
 *   auto_buy                people_pipeline on for the client, and auto_buy
 *   personalisation         enabled, tag on personalisation.tags, and the client's own originals
 *                           loaded (ctx.variant other than "default") unless shared_text_ok.
 *                           Without ctx.variant the client counts as on the default variant.
 *   promotion               promote_to_leads, tag on promotion.tags
 *   fit_gate                enabled, tag (or "*") on fit_gate.tags, and ctx.clientType on
 *                           fit_gate.client_types; false without ctx.clientType. The SQL
 *                           fn_fit_gate_applies(tag) (migration 126) is what the gate itself reads.
 *   fit_scoring             enabled (no client list: scores are shared by every client)
 *   linkedin_sources        enabled, tag on linkedin_sources.tags (the one LinkedIn switch, D-P4-7)
 *   linkedin_companies      company_pipeline and linkedin_sources both on for the client (LinkedIn company pulls)
 *   linkedin_people         people_pipeline and linkedin_sources both on for the client (LinkedIn people runs)
 * An unknown name throws, so a typo can't read as "off" silently.
 *
 * @param {Omit<PipelineSettings, "flagOn"> | PipelineSettings} settings  settingsFrom()'s value
 * @param {string} name
 * @param {string} tag
 * @param {FlagContext} [ctx]
 * @returns {boolean}
 */
export function flagOn(settings, name, tag, ctx = {}) {
  const t = normTag(tag);
  const listed = (tags) => Array.isArray(tags) && tags.includes(t);
  const s = settings;
  switch (name) {
    case "company_pipeline":
      return Boolean(t) && s.company_pipeline.enabled === true && listed(s.company_pipeline.tags);
    case "linkedin_profile_reads":
      return flagOn(s, "company_pipeline", t) && s.company_pipeline.linkedin_profile_reads === true;
    case "people_pipeline":
      return Boolean(t) && s.people_pipeline.enabled === true && listed(s.people_pipeline.tags);
    case "ai_searches":
      return flagOn(s, "people_pipeline", t) && s.people_pipeline.ai_searches === true;
    case "auto_buy":
      return flagOn(s, "people_pipeline", t) && s.people_pipeline.auto_buy === true;
    case "personalisation": {
      if (!(Boolean(t) && s.personalisation.enabled === true && listed(s.personalisation.tags))) return false;
      const variant = ctx?.variant ?? "default";
      return variant !== "default" || s.personalisation.shared_text_ok === true;
    }
    case "promotion":
      return Boolean(t) && s.promotion.promote_to_leads === true && listed(s.promotion.tags);
    case "fit_gate":
      return (
        Boolean(t) &&
        s.fit_gate.enabled === true &&
        (listed(s.fit_gate.tags) || s.fit_gate.tags.includes("*")) &&
        typeof ctx?.clientType === "string" &&
        s.fit_gate.client_types.includes(ctx.clientType)
      );
    case "fit_scoring":
      return s.fit_scoring.enabled === true;
    case "linkedin_sources":
      // Fail closed on a settings object made before 128 (no linkedin_sources key).
      return Boolean(t) && s.linkedin_sources?.enabled === true && listed(s.linkedin_sources?.tags);
    case "linkedin_companies":
      return flagOn(s, "company_pipeline", t) && flagOn(s, "linkedin_sources", t);
    case "linkedin_people":
      return flagOn(s, "people_pipeline", t) && flagOn(s, "linkedin_sources", t);
    default:
      throw new Error(`Unknown switch "${name}"`);
  }
}

let cache = null; // { at, value }

/**
 * The settings, read from enrich_settings at most every 30 seconds. Before
 * migration 124 is applied (no such table) the defaults apply, which keep the
 * pipeline switched off.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ maxAgeMs?: number }} [opts]
 * @returns {Promise<PipelineSettings>}
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
