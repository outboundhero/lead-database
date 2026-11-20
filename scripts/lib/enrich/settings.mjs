// Run-time settings for the Clay tab's pipeline (enrich_settings, migrations
// 124 to 126, 128 and 129): the switches and their client lists, the caps, how
// long paid answers are remembered, the people runs, the spend caps (with the
// daily calls of the email finders and Enrichley, 129), the fit
// scorer, promotion and the gate (promotion needs no fit score: the scorer and
// the gate are kept for v2, off), the LinkedIn sources and their starter
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
//
// Overlap sharing, the weekly top-up and never-contact inboxes (migrations 134
// to 136) keep their settings here too: overlap_sharing (the switch, its
// client list, the sharing pools, the push switch and caps, the tag writes),
// weekly_topup (the flag pass, the minimum, the pulls and their budget) and
// never_contact_inboxes (the switch, the Clay General inboxes filter the seed
// read, the daily cap). clientPool() is the pool rule (SQL twin:
// fn_client_pool_value, 134) and inboxPatternOf() the "is the filter loaded"
// rule (SQL twin: fn_never_contact_inbox_pattern_value, 136). The cleanX()
// functions check the settings sheet's edits before a save.

import { createHash } from "node:crypto";

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
  "overlap_sharing", "share_push", "share_tag_writes", "weekly_topup", "topup_pull", "never_contact_inboxes",
];

/** A sharing pool's name (overlap_sharing.pools), as fn_client_pool_value() reads it (134). */
export const POOL_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** overlap_sharing.mode: preview stops a job at "previewed"; apply applies it unless a receiver is over a cap. */
export const SHARE_MODES = Object.freeze(["preview", "apply"]);
/** weekly_topup.pull_mode: off makes no pull; prepare writes pulls a manager starts; auto starts them within the budget. */
export const TOPUP_PULL_MODES = Object.freeze(["off", "prepare", "auto"]);
/**
 * The shape a never-contact inboxes pattern must have to be used: letters,
 * digits, @ _ . - and the escape \. only, alternatives joined by | and none
 * empty, so it reads the same in JavaScript and in Postgres and can never match
 * every address. As fn_never_contact_inbox_pattern_value() (136).
 */
export const INBOX_PATTERN_SHAPE = /^(?:[A-Za-z0-9@_.-]|\\\.)+(?:\|(?:[A-Za-z0-9@_.-]|\\\.)+)*$/;
export const INBOX_PATTERN_MAX = 4000;
/** A client tag as the settings sheet takes it (src/lib/companies/server.ts TAG_TEXT). */
const TAG_TEXT = /^[A-Z0-9][A-Z0-9_&-]{0,63}$/;
/** An isolated tag suffix as the settings sheet takes it, after trim and upper case. */
const SUFFIX_TEXT = /^[A-Z0-9_&-]{1,16}$/;

/** LinkedIn people runs buy at most this many people a company (D-P4-6): the newest Clay template's limit. */
export const PEOPLE_PER_COMPANY = 13;

/**
 * The paid email steps with a daily cap of calls (spend_caps.vendor_calls_per_day,
 * migration 129): the three email finders and Enrichley. Each paid call counts
 * one in enrich_spend_daily under the kind "<vendor>_calls" (spend.mjs). A cap
 * of 0, the default, allows no call: the step waits, as when Reoon's share is
 * used up, until an admin sets a number on the Companies tab's settings.
 */
export const VENDOR_CAP_KEYS = Object.freeze(["findymail", "prospeo", "anymail_finder", "enrichley"]);
/** Their names, as the settings sheet and the audit log say them. */
export const VENDOR_CAP_LABELS = Object.freeze({
  findymail: "Findymail",
  prospeo: "Prospeo",
  anymail_finder: "Anymail Finder",
  enrichley: "Enrichley",
});
/** The most calls a day a vendor cap takes (as reoon_checks_per_day). */
export const VENDOR_CALLS_MAX = 100_000;
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
 * 126, 128 and 134 to 136 seed (126's fit settings, 128's LinkedIn ones and
 * 134 to 136's sharing, top-up and never-contact ones included, so the shape
 * is the same before they are applied).
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
    /** Not set until an admin sets them: 0 allows no call (VENDOR_CAP_KEYS). */
    vendor_calls_per_day: { findymail: 0, prospeo: 0, anymail_finder: 0, enrichley: 0 },
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
  /**
   * Promotion into leads: the switch and its client list are set on the
   * Companies tab's settings sheet. No fit score is needed (2026-11-20: fit
   * scoring is kept for v2), so min_fit_score is kept as stored and not read.
   */
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
  /**
   * Overlap sharing (134): off, no client, preview only. Sharing happens only
   * inside a pool (clientPool). since: the go-live time; batches before it are
   * never looked at, and with none set the share step looks at nothing.
   */
  overlap_sharing: {
    enabled: false,
    tags: [],
    mode: "preview",
    pools: { cleaning: ["Cleaning", "Canada Cleaning"] },
    isolated_tag_suffixes: ["-OS"],
    push_tags: [],
    push_every_minutes: 15,
    push_max_per_job: 1000,
    push_max_per_day: 2000,
    held_retry_days: 7,
    write_tags: false,
    tag_rows_per_day: 20000,
    since: null,
    wait_location_minutes: 180,
    recheck_days: 7,
  },
  /** The weekly top-up (135): the flag pass off, no pulls; a budget of 25,000 credits a week in all and per client. */
  weekly_topup: {
    enabled: false,
    client_types: ["Cleaning", "Canada Cleaning"],
    default_minimum: 500,
    pull_mode: "off",
    pull_tags: [],
    weekly_credits: 25000,
    client_weekly_credits: 25000,
    max_pull_size: 1000,
    pulls_per_day: 3,
  },
  /** Never-contact inboxes (136): off; the filter is null until the seed reads it from the Clay originals. */
  never_contact_inboxes: {
    enabled: false,
    pattern: null,
    source: null,
    sha256: null,
    read_at: null,
    rows_per_day: 5000,
    chunk_rows: 500,
  },
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
 * The daily caps of the email finders and Enrichley as stored: each a whole
 * number of calls from 0 to VENDOR_CALLS_MAX. A missing or invalid one reads as
 * 0, so a vendor with no number set makes no call.
 *
 * @param {unknown} v  spend_caps.vendor_calls_per_day as stored
 * @returns {{ findymail: number, prospeo: number, anymail_finder: number, enrichley: number }}
 */
function vendorCapsOf(v) {
  const stored = objectOr(v);
  const d = SETTINGS_DEFAULTS.spend_caps.vendor_calls_per_day;
  return /** @type {any} */ (Object.fromEntries(VENDOR_CAP_KEYS.map((k) => [k, whole(stored[k], 0, VENDOR_CALLS_MAX, d[k])])));
}

/**
 * The settings sheet's vendor caps checked for a save (the save path of
 * PUT /api/companies/settings): an object with every key of VENDOR_CAP_KEYS,
 * each a whole number from 0 to VENDOR_CALLS_MAX. Anything else is refused
 * with its reason, never quietly replaced, as the route refuses every other
 * setting. 0 means no call is allowed.
 *
 * @param {unknown} input
 * @returns {{ value: { findymail: number, prospeo: number, anymail_finder: number, enrichley: number } | null, errors: string[] }}
 */
export function cleanVendorCaps(input) {
  if (!isObject(input)) {
    return { value: null, errors: ["Daily calls of the email finders and Enrichley: must be a number for each of them."] };
  }
  const v = /** @type {Record<string, unknown>} */ (input);
  const errors = [];
  /** @type {Record<string, number>} */
  const out = {};
  for (const k of VENDOR_CAP_KEYS) {
    if (wholeIn(v[k], 0, VENDOR_CALLS_MAX)) out[k] = /** @type {number} */ (v[k]);
    else errors.push(`${VENDOR_CAP_LABELS[k]} calls a day must be a whole number from 0 to ${VENDOR_CALLS_MAX.toLocaleString("en-US")}.`);
  }
  return errors.length ? { value: null, errors } : { value: /** @type {any} */ (out), errors };
}

// ── The settings sheet's edits for sharing, the top-up and never-contact inboxes ──
// Each cleanX(input) checks one row as the sheet sends it and answers
// { value, errors }: the row to merge over what is stored, or every reason it
// was refused. Nothing is quietly replaced, as PUT /api/companies/settings
// refuses every other setting.

const fmt = (n) => Number(n).toLocaleString("en-US");

/** The checks one cleanX() shares: each pushes its reason and returns a value of the right type. */
function checks(errors) {
  return {
    flag(v, label) {
      if (typeof v !== "boolean") errors.push(`${label} must be on or off.`);
      return v === true;
    },
    num(v, lo, hi, label) {
      if (wholeIn(v, lo, hi)) return /** @type {number} */ (v);
      errors.push(`${label} must be a whole number from ${fmt(lo)} to ${fmt(hi)}.`);
      return lo;
    },
    tags(v, label) {
      if (!Array.isArray(v)) {
        errors.push(`${label}: the client list must be a list of tags.`);
        return [];
      }
      const out = [];
      const bad = [];
      for (const x of v) {
        const t = typeof x === "string" ? normTag(x) : "";
        if (!t) continue;
        if (!TAG_TEXT.test(t)) bad.push(String(x).slice(0, 40));
        else if (!out.includes(t)) out.push(t);
      }
      if (bad.length) errors.push(`${label}: ${bad.slice(0, 5).join(", ")} ${bad.length === 1 ? "is not a client tag" : "are not client tags"}.`);
      if (out.length > 2000) errors.push(`${label}: at most 2,000 clients.`);
      return out;
    },
    types(v, label, { min = 0, max = 20 } = {}) {
      if (!Array.isArray(v)) {
        errors.push(`${label} must be a list of client types.`);
        return [];
      }
      const out = [];
      for (const x of v) {
        const t = typeof x === "string" ? x.trim() : "";
        if (!t || t.length > 60) {
          errors.push(`${label}: each client type must be 1 to 60 characters.`);
          return [];
        }
        if (!out.some((y) => normTag(y) === normTag(t))) out.push(t);
      }
      if (out.length < min || out.length > max) errors.push(`${label}: ${min ? `${min} to ${max}` : `at most ${max}`} client types.`);
      return out;
    },
  };
}

/**
 * The overlap_sharing row checked for a save. Switching sharing on with no
 * go-live time set starts it now: batches imported before then are never
 * shared. Every client on push_tags must be on tags too.
 *
 * @param {unknown} input
 * @param {{ previous?: Partial<OverlapSharing> | null, now?: Date }} [opts]  previous: the row as read before this save
 * @returns {{ value: OverlapSharing | null, errors: string[] }}
 */
export function cleanOverlapSharing(input, { previous = null, now = new Date() } = {}) {
  if (!isObject(input)) return { value: null, errors: ["Overlap sharing: must be the switch and its settings."] };
  const v = /** @type {Record<string, unknown>} */ (input);
  const errors = [];
  const c = checks(errors);
  const enabled = c.flag(v.enabled, "Overlap sharing");
  const tags = c.tags(v.tags, "Overlap sharing");
  if (!SHARE_MODES.includes(/** @type {any} */ (v.mode))) errors.push("Overlap sharing's mode must be preview or apply.");
  /** @type {Record<string, string[]>} */
  const pools = {};
  if (!isObject(v.pools)) {
    errors.push("Sharing pools: must be named lists of client types.");
  } else {
    const names = Object.keys(/** @type {object} */ (v.pools)).sort();
    if (names.length > 10) errors.push("Sharing pools: at most 10 pools.");
    const owner = new Map();
    for (const name of names) {
      if (!POOL_NAME.test(name)) {
        errors.push(`Sharing pools: "${name.slice(0, 40)}" is not a pool name (lower-case letters, digits and _, starting with a letter).`);
        continue;
      }
      const types = c.types(/** @type {Record<string, unknown>} */ (v.pools)[name], `Sharing pool ${name}`, { min: 1, max: 20 });
      for (const t of types) {
        const k = normTag(t);
        if (owner.has(k)) errors.push(`Sharing pools: the client type ${t} is in both ${owner.get(k)} and ${name}.`);
        else owner.set(k, name);
      }
      pools[name] = types;
    }
  }
  const suffixes = [];
  if (!Array.isArray(v.isolated_tag_suffixes)) {
    errors.push("Isolated tag endings: must be a list.");
  } else {
    for (const x of v.isolated_tag_suffixes) {
      const s = typeof x === "string" ? normTag(x) : "";
      if (!SUFFIX_TEXT.test(s)) errors.push(`Isolated tag endings: ${String(x).slice(0, 20) || "(blank)"} must be 1 to 16 letters, digits, _, & or -.`);
      else if (!suffixes.includes(s)) suffixes.push(s);
    }
    if (suffixes.length > 20) errors.push("Isolated tag endings: at most 20.");
  }
  const pushTags = c.tags(v.push_tags, "Pushed automatically");
  const off = pushTags.filter((t) => !tags.includes(t));
  if (off.length) errors.push(`Pushed automatically: ${off.slice(0, 5).join(", ")} must be on the sharing list too.`);
  let since = null;
  if (v.since !== null && v.since !== undefined && v.since !== "") {
    since = isoOrNull(v.since);
    if (!since) errors.push("Sharing's go-live time must be a date and time, or empty.");
  }
  if (enabled && !since && previous?.enabled !== true) since = now.toISOString();
  const value = {
    enabled,
    tags,
    mode: v.mode === "apply" ? "apply" : "preview",
    pools,
    isolated_tag_suffixes: suffixes,
    push_tags: pushTags,
    push_every_minutes: c.num(v.push_every_minutes, 5, 1440, "Minutes between a client's share pushes"),
    push_max_per_job: c.num(v.push_max_per_job, 1, 25_000, "Most shares pushed to a client from one import"),
    push_max_per_day: c.num(v.push_max_per_day, 1, 100_000, "Most shares pushed to a client a day"),
    held_retry_days: c.num(v.held_retry_days, 0, 30, "Days a held share is tried again"),
    write_tags: c.flag(v.write_tags, "Writing the receiving client's tag on shared leads"),
    tag_rows_per_day: c.num(v.tag_rows_per_day, 0, 200_000, "Tags written a day"),
    since,
    wait_location_minutes: c.num(v.wait_location_minutes, 30, 1440, "Minutes a share waits for places"),
    recheck_days: c.num(v.recheck_days, 0, 30, "Days leads with no usable place are looked at again"),
  };
  return errors.length ? { value: null, errors } : { value: /** @type {OverlapSharing} */ (value), errors };
}

/**
 * The weekly_topup row checked for a save.
 *
 * @param {unknown} input
 * @returns {{ value: WeeklyTopup | null, errors: string[] }}
 */
export function cleanWeeklyTopup(input) {
  if (!isObject(input)) return { value: null, errors: ["Weekly top-up: must be the switch and its settings."] };
  const v = /** @type {Record<string, unknown>} */ (input);
  const errors = [];
  const c = checks(errors);
  if (!TOPUP_PULL_MODES.includes(/** @type {any} */ (v.pull_mode))) errors.push("Top-up pulls must be off, prepare or auto.");
  const value = {
    enabled: c.flag(v.enabled, "The weekly top-up"),
    client_types: c.types(v.client_types, "The top-up's client types", { min: 1, max: 10 }),
    default_minimum: c.num(v.default_minimum, 1, 100_000, "The default minimum of good leads a place"),
    pull_mode: TOPUP_PULL_MODES.includes(/** @type {any} */ (v.pull_mode)) ? /** @type {WeeklyTopup["pull_mode"]} */ (v.pull_mode) : "off",
    pull_tags: c.tags(v.pull_tags, "Top-up pulls"),
    weekly_credits: c.num(v.weekly_credits, 0, 1_000_000, "AI Ark credits a week for top-up pulls"),
    client_weekly_credits: c.num(v.client_weekly_credits, 0, 1_000_000, "AI Ark credits a week for one client's top-up pulls"),
    max_pull_size: c.num(v.max_pull_size, 1, 10_000, "The largest top-up pull"),
    pulls_per_day: c.num(v.pulls_per_day, 0, 4, "New top-up pulls a day"),
  };
  return errors.length ? { value: null, errors } : { value, errors };
}

/**
 * The never_contact_inboxes row's editable part checked for a save: the
 * switch and the pace. The filter itself (pattern, source, sha256, read_at)
 * is written only by the seed and never taken from the sheet; the route keeps
 * it as stored. It can be switched on only while the filter is loaded.
 *
 * @param {unknown} input
 * @param {unknown} stored  the never_contact_inboxes value as stored
 * @returns {{ value: { enabled: boolean, rows_per_day: number, chunk_rows: number } | null, errors: string[] }}
 */
export function cleanNeverContactInboxes(input, stored) {
  if (!isObject(input)) return { value: null, errors: ["Never-contact inboxes: must be the switch and its pace."] };
  const v = /** @type {Record<string, unknown>} */ (input);
  const errors = [];
  const c = checks(errors);
  const value = {
    enabled: c.flag(v.enabled, "Never-contact inboxes"),
    rows_per_day: c.num(v.rows_per_day, 0, 100_000, "General inboxes marked never contact a day"),
    chunk_rows: c.num(v.chunk_rows, 1, 2000, "General inboxes marked in one step"),
  };
  if (value.enabled && inboxPatternOf(stored) === null) {
    errors.push("Never-contact inboxes: the Clay General inboxes filter is not loaded, so they cannot be switched on. Run the seed first.");
  }
  return errors.length ? { value: null, errors } : { value, errors };
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

/** A text value that is a date and time: its ISO form, else null. */
function isoOrNull(v) {
  if (typeof v !== "string" || !v.trim() || v.length > 64) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The sharing pools as stored: a name (POOL_NAME) for each list of client
 * types, the types trimmed (any case when matched). Not an object: the
 * default pools. An object holds only what is valid in it, maybe nothing
 * (then every client is isolated). As fn_client_pool_value() reads them (134).
 *
 * @param {unknown} v
 * @returns {Record<string, string[]>}
 */
function poolsOf(v) {
  if (!isObject(v)) return { cleaning: [...SETTINGS_DEFAULTS.overlap_sharing.pools.cleaning] };
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const name of Object.keys(v).sort()) {
    const list = /** @type {Record<string, unknown>} */ (v)[name];
    if (!POOL_NAME.test(name) || !Array.isArray(list)) continue;
    const types = [];
    for (const x of list) {
      if (typeof x !== "string") continue;
      const t = x.trim();
      if (t && !types.some((y) => normTag(y) === normTag(t))) types.push(t);
    }
    out[name] = types;
  }
  return out;
}

/** overlap_sharing.isolated_tag_suffixes as stored: trimmed, upper case, once each. Not a list: the default ["-OS"]. */
function suffixesOf(v) {
  if (!Array.isArray(v)) return [...SETTINGS_DEFAULTS.overlap_sharing.isolated_tag_suffixes];
  return [...new Set(v.filter((s) => typeof s === "string").map(normTag).filter(Boolean))];
}

/** A list of client types: trimmed, once each (any case). Not a list: null, so the caller's default applies. */
function typesOf(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t && !out.some((y) => normTag(y) === normTag(t))) out.push(t);
  }
  return out;
}

/** Is this client type on the list? Trimmed, in any case. */
export function typeListed(list, clientType) {
  const t = normTag(clientType);
  return Boolean(t) && Array.isArray(list) && list.some((x) => typeof x === "string" && normTag(x) === t);
}

/**
 * never_contact_inboxes.pattern when it can be used, else null ("not
 * loaded"): text of 1 to INBOX_PATTERN_MAX characters in INBOX_PATTERN_SHAPE
 * whose sha256 is the stored sha256. As fn_never_contact_inbox_pattern_value()
 * (136), so the page, the coverage count, the share step and the writer agree.
 *
 * @param {unknown} v  the never_contact_inboxes value as stored
 * @returns {string | null}
 */
export function inboxPatternOf(v) {
  if (!isObject(v)) return null;
  const s = /** @type {Record<string, unknown>} */ (v);
  if (typeof s.pattern !== "string" || typeof s.sha256 !== "string") return null;
  const p = s.pattern;
  if (p.length < 1 || p.length > INBOX_PATTERN_MAX || !INBOX_PATTERN_SHAPE.test(p)) return null;
  return sha256Hex(p) === s.sha256 ? p : null;
}

/**
 * The sharing pool of a client: null when it is isolated (it never receives a
 * share and its imports are never shared). A tag that ends in one of
 * overlap_sharing.isolated_tag_suffixes is isolated; otherwise the client's
 * type, trimmed and in any case, is looked for in each pool, the pools taken
 * by name in code point order, and the first pool that lists it is the one.
 * No type, or a type in no pool: isolated. The SQL twin is
 * fn_client_pool_value(settings, tag, type) (134).
 *
 * @param {Pick<PipelineSettings, "overlap_sharing"> | null | undefined} settings  settingsFrom()'s value
 * @param {string | null | undefined} tag
 * @param {string | null | undefined} clientType  client_tags.client_type
 * @returns {string | null}
 */
export function clientPool(settings, tag, clientType) {
  const os = settings?.overlap_sharing ?? {
    pools: poolsOf(undefined),
    isolated_tag_suffixes: suffixesOf(undefined),
  };
  const t = normTag(tag);
  if (!t) return null;
  if (os.isolated_tag_suffixes.some((s) => s && t.endsWith(s))) return null;
  const ty = normTag(clientType);
  if (!ty) return null;
  for (const name of Object.keys(os.pools).sort()) {
    if (os.pools[name].some((x) => normTag(x) === ty)) return name;
  }
  return null;
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
 *                 vendor_calls_per_day: { findymail: number, prospeo: number, anymail_finder: number, enrichley: number },
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
 *   overlap_sharing: OverlapSharing,
 *   weekly_topup: WeeklyTopup,
 *   never_contact_inboxes: NeverContactInboxes,
 *   flagOn: (name: string, tag: string, ctx?: FlagContext) => boolean,
 * }} PipelineSettings
 * @typedef {{ enabled: boolean, tags: string[], mode: "preview" | "apply", pools: Record<string, string[]>,
 *             isolated_tag_suffixes: string[], push_tags: string[], push_every_minutes: number, push_max_per_job: number,
 *             push_max_per_day: number, held_retry_days: number, write_tags: boolean, tag_rows_per_day: number,
 *             since: string | null, wait_location_minutes: number, recheck_days: number }} OverlapSharing
 * @typedef {{ enabled: boolean, client_types: string[], default_minimum: number, pull_mode: "off" | "prepare" | "auto",
 *             pull_tags: string[], weekly_credits: number, client_weekly_credits: number, max_pull_size: number,
 *             pulls_per_day: number }} WeeklyTopup
 * @typedef {{ enabled: boolean, pattern: string | null, source: string | null, sha256: string | null, read_at: string | null,
 *             rows_per_day: number, chunk_rows: number }} NeverContactInboxes
 *   pattern: null unless usable (inboxPatternOf); sha256 and source belong to it and are null with it.
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
    vendor_calls_per_day: vendorCapsOf(sc.vendor_calls_per_day),
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

  const os = objectOr(byKey.get("overlap_sharing"));
  const dos = D.overlap_sharing;
  /** @type {OverlapSharing} */
  const overlap_sharing = {
    enabled: bool(os.enabled, dos.enabled),
    tags: tagsOf(os.tags),
    mode: os.mode === "apply" ? "apply" : "preview",
    pools: poolsOf(os.pools),
    isolated_tag_suffixes: suffixesOf(os.isolated_tag_suffixes),
    push_tags: tagsOf(os.push_tags),
    push_every_minutes: whole(os.push_every_minutes, 5, 1440, dos.push_every_minutes),
    push_max_per_job: whole(os.push_max_per_job, 1, 25_000, dos.push_max_per_job),
    push_max_per_day: whole(os.push_max_per_day, 1, 100_000, dos.push_max_per_day),
    held_retry_days: whole(os.held_retry_days, 0, 30, dos.held_retry_days),
    write_tags: bool(os.write_tags, dos.write_tags),
    tag_rows_per_day: whole(os.tag_rows_per_day, 0, 200_000, dos.tag_rows_per_day),
    since: isoOrNull(os.since),
    wait_location_minutes: whole(os.wait_location_minutes, 30, 1440, dos.wait_location_minutes),
    recheck_days: whole(os.recheck_days, 0, 30, dos.recheck_days),
  };

  const wt = objectOr(byKey.get("weekly_topup"));
  const dwt = D.weekly_topup;
  /** @type {WeeklyTopup} */
  const weekly_topup = {
    enabled: bool(wt.enabled, dwt.enabled),
    client_types: typesOf(wt.client_types) ?? [...dwt.client_types],
    default_minimum: whole(wt.default_minimum, 1, 100_000, dwt.default_minimum),
    pull_mode: TOPUP_PULL_MODES.includes(wt.pull_mode) ? wt.pull_mode : "off",
    pull_tags: tagsOf(wt.pull_tags),
    weekly_credits: whole(wt.weekly_credits, 0, 1_000_000, dwt.weekly_credits),
    client_weekly_credits: whole(wt.client_weekly_credits, 0, 1_000_000, dwt.client_weekly_credits),
    max_pull_size: whole(wt.max_pull_size, 1, 10_000, dwt.max_pull_size),
    pulls_per_day: whole(wt.pulls_per_day, 0, 4, dwt.pulls_per_day),
  };

  const nc = objectOr(byKey.get("never_contact_inboxes"));
  const dnc = D.never_contact_inboxes;
  const pattern = inboxPatternOf(nc);
  /** @type {NeverContactInboxes} */
  const never_contact_inboxes = {
    enabled: bool(nc.enabled, dnc.enabled),
    pattern,
    source: pattern ? textOrNull(nc.source, 300) : null,
    sha256: pattern ? /** @type {string} */ (nc.sha256) : null,
    read_at: pattern ? isoOrNull(nc.read_at) : null,
    rows_per_day: whole(nc.rows_per_day, 0, 100_000, dnc.rows_per_day),
    chunk_rows: whole(nc.chunk_rows, 1, 2000, dnc.chunk_rows),
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
    overlap_sharing,
    weekly_topup,
    never_contact_inboxes,
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
 *   overlap_sharing         enabled, tag on overlap_sharing.tags (as a source and as a receiver);
 *                           SQL twin fn_overlap_sharing_on(tag) (134). Pools are clientPool()'s.
 *   share_push              overlap_sharing on for the client, and the tag on overlap_sharing.push_tags
 *                           (its applied shares, and own top-up leads, are pushed into its campaigns)
 *   share_tag_writes        overlap_sharing enabled and write_tags (no client list: the paced tag writer)
 *   weekly_topup            enabled, and ctx.clientType on weekly_topup.client_types (trimmed, any case);
 *                           false without ctx.clientType (the flag pass)
 *   topup_pull              weekly_topup on for the client, pull_mode prepare or auto, tag on pull_tags
 *   never_contact_inboxes   enabled, and the filter loaded (inboxPatternOf; no client list)
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
    // The five below fail closed on a settings object made before 134 to 136 (no such key).
    case "overlap_sharing":
      return Boolean(t) && s.overlap_sharing?.enabled === true && listed(s.overlap_sharing?.tags);
    case "share_push":
      return flagOn(s, "overlap_sharing", t) && listed(s.overlap_sharing?.push_tags);
    case "share_tag_writes":
      return s.overlap_sharing?.enabled === true && s.overlap_sharing?.write_tags === true;
    case "weekly_topup":
      return (
        s.weekly_topup?.enabled === true &&
        typeof ctx?.clientType === "string" &&
        typeListed(s.weekly_topup?.client_types, ctx.clientType)
      );
    case "topup_pull":
      return (
        Boolean(t) &&
        flagOn(s, "weekly_topup", t, ctx) &&
        (s.weekly_topup?.pull_mode === "prepare" || s.weekly_topup?.pull_mode === "auto") &&
        listed(s.weekly_topup?.pull_tags)
      );
    case "never_contact_inboxes":
      return s.never_contact_inboxes?.enabled === true && typeof s.never_contact_inboxes?.pattern === "string";
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
