import type { PoolClient } from "pg";
import { buildCompanyRequests } from "../../../scripts/lib/aiark/company-filters.mjs";
import { bareDomain } from "../../../scripts/lib/enrich/domain.mjs";
import { MODEL_ID, normTag, settingsFrom } from "../../../scripts/lib/enrich/settings.mjs";
import { geo, modes, peopleOrDefaults } from "@/lib/aiark/server";
import type { RowStatus, WorkerState } from "@/lib/enrich/types";
import { contactsFor } from "./people";
import {
  EFFORTS,
  MODEL_STEPS,
  type CompaniesPage,
  type CompanyCountResult,
  type CompanyCounts,
  type CompanyFilters,
  type CompanyPlan,
  type CompanyPlanReport,
  type CompanyRow,
  type CompanyRun,
  type CompanyWorker,
  type Effort,
  type FoundBy,
  type ListHas,
  type ListSort,
  type ModelSetting,
  type ModelStep,
  type PipelineSettings,
  type PipelineView,
  type SettingsInput,
  type SettingsState,
} from "./types";

export {
  cleanTag,
  clientInfo,
  creditsLeft,
  geo,
  savedPeople,
  TAG_RE,
  targetingOf,
} from "@/lib/aiark/server";
// The pull's engine (the backend half of phase 1): createCompanyRun makes or
// updates the client's template Companies table, then the aiark_company_runs
// row the worker buys from.
export { createCompanyRun } from "../../../scripts/lib/aiark/company-runs.mjs";

// Server side of the Companies tab. The request builder and the run engine are
// shared with the worker (scripts/lib/aiark/company-*.mjs); the client's rules
// and company filters are read the way the AI Ark tab reads them
// (src/lib/aiark/server.ts). This file shapes them for the page, reads the
// settings, and lists the companies (keyset pages: no OFFSET, no row limit).

type Geo = Awaited<ReturnType<typeof geo>>;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown) => (v == null ? "" : String(v).trim());
const fmt = (n: number) => n.toLocaleString("en-US");

/** Live and demo only: company pulls have no export strategy. */
export function companyModes() {
  const m = modes();
  return { live: m.live, demo: m.demo };
}

// ── Company filters and the plan ────────────────────────────────────────────

/**
 * The company filters a pull uses: the size and industries saved on the AI
 * Ark tab, or a cleaning client's standard ones while nothing is saved. Job
 * titles, seniority and departments are people filters and are not used.
 */
export function companyFiltersFor(saved: Record<string, unknown> | null, clientType: string | null) {
  const p = peopleOrDefaults(saved, clientType);
  const value: CompanyFilters = {
    employee_bands: p.value.employee_bands,
    industries: p.value.industries,
    exclude_industries: p.value.exclude_industries,
  };
  return {
    saved: p.saved,
    updatedAt: p.updatedAt,
    version: p.version,
    defaultsFrom: (p.defaultsFrom === "cleaning" ? "cleaning" : null) as "cleaning" | null,
    value,
  };
}

/** What AI Ark would be asked for a client: one Company Search per group of places. */
export function companyPlan(
  targeting: Record<string, unknown> | null,
  filters: CompanyFilters,
  g: Geo,
  clientType: string | null
): CompanyPlan & { requests: object[] } {
  const built = buildCompanyRequests({ targeting, filters, geo: g, cleaning: clientType === "Cleaning" }) as {
    requests?: object[];
    report?: CompanyPlanReport;
    notes?: string[];
    blockers?: string[];
    pullBlockers?: string[];
  };
  const requests = Array.isArray(built.requests) ? built.requests : [];
  return {
    requests,
    searches: requests.length,
    report: built.report ?? { locations: { total: 0, sent: 0, requests: 0, examples: [], dropped: [] } },
    notes: built.notes ?? [],
    blockers: built.blockers ?? [],
    pullBlockers: built.pullBlockers ?? [],
    example: requests[0] ?? null,
  };
}

/** The plan as the page shows it: no request bodies beyond the first. */
export function companyPlanView(...args: Parameters<typeof companyPlan>): CompanyPlan {
  const p = companyPlan(...args);
  return { searches: p.searches, report: p.report, notes: p.notes, blockers: p.blockers, pullBlockers: p.pullBlockers, example: p.example };
}

// ── Settings (enrich_settings) ──────────────────────────────────────────────

/** The settings rows this tab reads and its sheet edits. */
const SETTING_KEYS = ["company_pipeline", "people_pipeline", "personalisation", "spend_caps", "models"];
/** aiark_company_runs.size_requested takes at most 10,000. */
export const PULL_SIZE_LIMIT = 10_000;
const MAX_SEARCHES = 5;
const TAGS_MAX = 2_000;
/** The company row's paid web steps the pull panel prices: the website search, then the two email searches. */
const PRICED_STEPS: ModelStep[] = ["companys_website", "email_extraction_claygent", "email_extraction_claygent_2"];

/**
 * The settings, read fresh inside the caller's transaction and checked the way
 * the worker checks them (scripts/lib/enrich/settings.mjs settingsFrom): an
 * invalid value takes its default, and a model the models row holds as null or
 * invalid is unset. The worker reads them with a 30 s cache; here a saved
 * switch must apply at once. A missing row reads as its default (switched off).
 */
export async function readPipelineSettings(c: PoolClient, { lock = false } = {}): Promise<SettingsState> {
  const { rows } = await c.query<{ key: string; value: unknown; version: string }>(
    `SELECT key, value, updated_at::text AS version
       FROM enrich_settings WHERE key = ANY($1::text[]) ORDER BY key${lock ? " FOR UPDATE" : ""}`,
    [SETTING_KEYS]
  );
  return { value: normalizeSettings(rows), version: rows.map((r) => `${r.key}@${r.version}`).join(";") };
}

/** The stored rows laid over the defaults, as the worker sees them (no functions: it goes to the page). */
export function normalizeSettings(rows: { key: string; value: unknown }[]): PipelineSettings {
  const s = settingsFrom(rows);
  return {
    company_pipeline: s.company_pipeline,
    people_pipeline: s.people_pipeline,
    personalisation: s.personalisation,
    spend_caps: s.spend_caps as PipelineSettings["spend_caps"],
    models: s.models as PipelineSettings["models"],
  };
}

/** What a manager's page needs from the settings: the switch, and what the pull's worst case is worked out from. */
export function pipelineView(s: PipelineSettings, tag: string | null = null): PipelineView {
  const t = tag ? normTag(tag) : null;
  return {
    enabled: s.company_pipeline.enabled,
    onList: t ? s.company_pipeline.tags.includes(t) : null,
    maxPullSize: s.company_pipeline.max_pull_size,
    steps: PRICED_STEPS.map((key) => ({ key, model: s.models[key]?.model ?? null, searches: s.models[key]?.max_searches ?? 1 })),
    inboxesPerCompany: s.company_pipeline.inboxes_per_company,
    prices: s.spend_caps.openai_prices,
  };
}

const wholeIn = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const amountIn = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
const TAG_TEXT = /^[A-Z0-9][A-Z0-9_&-]{0,63}$/;

/** A switch's client list as typed: tags upper case, once each. Errors name what was refused. */
function cleanTags(v: unknown, label: string, errors: string[]): string[] {
  if (!Array.isArray(v)) {
    errors.push(`${label}: the client list must be a list of tags.`);
    return [];
  }
  const out: string[] = [];
  const bad: string[] = [];
  for (const x of v) {
    const t = typeof x === "string" ? normTag(x) : "";
    if (!t) continue;
    if (!TAG_TEXT.test(t)) bad.push(String(x).slice(0, 40));
    else if (!out.includes(t)) out.push(t);
  }
  if (bad.length) errors.push(`${label}: ${bad.slice(0, 5).join(", ")} ${bad.length === 1 ? "is not a client tag" : "are not client tags"}.`);
  if (out.length > TAGS_MAX) errors.push(`${label}: at most ${fmt(TAGS_MAX)} clients.`);
  return out;
}

/** The sheet's model edits checked: a model id, a reasoning effort or none, and for a web step its most searches. */
function cleanModel(
  input: unknown,
  step: (typeof MODEL_STEPS)[number],
  errors: string[]
): { model: string; reasoning_effort: Effort | null; max_searches: number | null } | null {
  const m = obj(input);
  const model = typeof m.model === "string" ? m.model.trim() : "";
  const rawEffort = m.reasoning_effort;
  const effort = rawEffort === null || rawEffort === undefined || rawEffort === "" ? null : rawEffort;
  let ok = true;
  if (!MODEL_ID.test(model)) {
    errors.push(`${step.label}: the model id must be 2 to 61 characters of lower-case letters, digits, dots and dashes, starting with a letter or digit.`);
    ok = false;
  }
  if (effort !== null && !(EFFORTS as readonly unknown[]).includes(effort)) {
    errors.push(`${step.label}: the reasoning effort must be one of ${EFFORTS.join(", ")}, or not sent.`);
    ok = false;
  } else if (effort === "minimal" && /luna/.test(model)) {
    errors.push(`${step.label}: a Luna model refuses the "minimal" reasoning effort.`);
    ok = false;
  }
  let searches: number | null = null;
  if (step.tool === "web") {
    searches = wholeIn(m.max_searches, 1, MAX_SEARCHES);
    if (searches === null) {
      errors.push(`${step.label}: the most searches must be a whole number from 1 to ${MAX_SEARCHES}.`);
      ok = false;
    }
  }
  return ok ? { model, reasoning_effort: effort as Effort | null, max_searches: searches } : null;
}

type SettingsRows = { company_pipeline: Record<string, unknown>; people_pipeline: Record<string, unknown>; personalisation: Record<string, unknown>; spend_caps: Record<string, unknown>; models: Record<string, unknown> };

/**
 * Checks the settings sheet's edits (SettingsInput) and merges them into what
 * is stored: keys the sheet doesn't edit (memory_days, openai_prices,
 * fit_score, anything a later phase adds) are kept as stored. Returns the rows
 * to save, or the errors; `changes` says what changed, for the audit log.
 * Validation as phase 1: anything out of range is refused with its reason,
 * never quietly replaced.
 */
export function cleanSettingsInput(
  input: unknown,
  current: PipelineSettings,
  stored: Partial<SettingsRows> = {}
): { value: SettingsRows | null; errors: string[]; changes: string[] } {
  const errors: string[] = [];
  const body = obj(input);
  const cp = obj(body.company_pipeline);
  const pp = obj(body.people_pipeline);
  const ps = obj(body.personalisation);
  const sc = obj(body.spend_caps);
  const usd = obj(sc.openai_usd_per_day);
  const modelsIn = obj(body.models);
  const bool = (v: unknown, label: string) => {
    if (typeof v !== "boolean") errors.push(`${label} must be on or off.`);
    return v === true;
  };
  const whole = (v: unknown, lo: number, hi: number, label: string) => {
    const n = wholeIn(v, lo, hi);
    if (n === null) errors.push(`${label} must be a whole number from ${fmt(lo)} to ${fmt(hi)}.`);
    return n ?? lo;
  };
  const amount = (v: unknown, lo: number, hi: number, label: string) => {
    const n = amountIn(v, lo, hi);
    if (n === null) errors.push(`${label} must be a number from ${fmt(lo)} to ${fmt(hi)}.`);
    return n ?? lo;
  };

  const company = {
    enabled: bool(cp.enabled, "Company pulls"),
    tags: cleanTags(cp.tags, "Company pulls", errors),
    max_pull_size: whole(cp.max_pull_size, 1, PULL_SIZE_LIMIT, "The largest pull"),
    linkedin_profile_reads: bool(cp.linkedin_profile_reads, "LinkedIn profile reads"),
    inboxes_per_company: whole(cp.inboxes_per_company, 1, 30, "General inboxes per company"),
    min_balance: whole(cp.min_balance, 0, 1_000_000, "The company pulls' lowest AI Ark balance"),
  };
  const people = {
    enabled: bool(pp.enabled, "People runs"),
    tags: cleanTags(pp.tags, "People runs", errors),
    auto_buy: bool(pp.auto_buy, "Buy without a click"),
    ai_searches: bool(pp.ai_searches, "AI searches"),
    ids_per_search: whole(pp.ids_per_search, 1, 300, "Companies per search"),
    pages_per_search: whole(pp.pages_per_search, 1, 20, "Pages per search"),
    tries_per_track: whole(pp.tries_per_track, 1, 10, "Tries per track"),
    max_people_per_run: whole(pp.max_people_per_run, 1, 10_000, "The most people a run buys"),
    recheck_days: whole(pp.recheck_days, 1, 365, "Days before a company is looked at again"),
    skip_company_when_held: bool(pp.skip_company_when_held, "Skip a company where someone is held"),
    min_balance: whole(pp.min_balance, 0, 1_000_000, "The people runs' lowest AI Ark balance"),
  };
  const personal = {
    enabled: bool(ps.enabled, "Personalisation"),
    tags: cleanTags(ps.tags, "Personalisation", errors),
    shared_text_ok: bool(ps.shared_text_ok, "Shared personalisation text"),
  };
  const caps = {
    reoon_checks_per_day: whole(sc.reoon_checks_per_day, 0, 100_000, "Reoon checks a day"),
    openai_usd_per_day: {
      pipeline: amount(usd.pipeline, 0, 10_000, "OpenAI dollars a day for the pipeline"),
      fit: amount(usd.fit, 0, 10_000, "OpenAI dollars a day for fit scoring"),
    },
  };
  const steps = MODEL_STEPS.map((step) => ({ step, m: cleanModel(modelsIn[step.key], step, errors) }));
  if (errors.length) return { value: null, errors, changes: [] };

  const changes: string[] = [];
  const said = (on: boolean) => (on ? "on" : "off");
  const listText = (tags: string[]) => (tags.length ? tags.join(", ") : "no client");
  const diff = (label: string, was: unknown, now: unknown, show: (v: never) => string = (v) => String(v)) => {
    if (JSON.stringify(was) !== JSON.stringify(now)) changes.push(`${label} ${show(was as never)} to ${show(now as never)}`);
  };
  const c0 = current.company_pipeline;
  diff("company pulls", c0.enabled, company.enabled, said);
  diff("company pulls' clients", c0.tags, company.tags, listText);
  diff("largest pull", c0.max_pull_size, company.max_pull_size, fmt);
  diff("LinkedIn profile reads", c0.linkedin_profile_reads, company.linkedin_profile_reads, said);
  diff("general inboxes per company", c0.inboxes_per_company, company.inboxes_per_company);
  diff("company pulls' lowest balance", c0.min_balance, company.min_balance, fmt);
  const p0 = current.people_pipeline;
  diff("people runs", p0.enabled, people.enabled, said);
  diff("people runs' clients", p0.tags, people.tags, listText);
  diff("buy without a click", p0.auto_buy, people.auto_buy, said);
  diff("AI searches", p0.ai_searches, people.ai_searches, said);
  diff("companies per search", p0.ids_per_search, people.ids_per_search);
  diff("pages per search", p0.pages_per_search, people.pages_per_search);
  diff("tries per track", p0.tries_per_track, people.tries_per_track);
  diff("most people a run", p0.max_people_per_run, people.max_people_per_run, fmt);
  diff("days before a look again", p0.recheck_days, people.recheck_days);
  diff("skip a company where someone is held", p0.skip_company_when_held, people.skip_company_when_held, said);
  diff("people runs' lowest balance", p0.min_balance, people.min_balance, fmt);
  const s0 = current.personalisation;
  diff("personalisation", s0.enabled, personal.enabled, said);
  diff("personalisation's clients", s0.tags, personal.tags, listText);
  diff("shared personalisation text", s0.shared_text_ok, personal.shared_text_ok, said);
  const k0 = current.spend_caps;
  diff("Reoon checks a day", k0.reoon_checks_per_day, caps.reoon_checks_per_day, fmt);
  diff("OpenAI dollars a day (pipeline)", k0.openai_usd_per_day.pipeline, caps.openai_usd_per_day.pipeline);
  diff("OpenAI dollars a day (fit)", k0.openai_usd_per_day.fit, caps.openai_usd_per_day.fit);

  const storedModels = obj(stored.models);
  const models: Record<string, unknown> = { ...storedModels };
  for (const { step, m } of steps) {
    const before = (current.models[step.key] ?? null) as ModelSetting | null;
    const next: Record<string, unknown> = { model: m!.model };
    if (m!.reasoning_effort) next.reasoning_effort = m!.reasoning_effort;
    if (m!.max_searches !== null) next.max_searches = m!.max_searches;
    models[step.key] = next;
    const name = step.label.toLowerCase();
    if ((before?.model ?? null) !== m!.model) changes.push(`${name} model ${before?.model ?? "(unset)"} to ${m!.model}`);
    if ((before?.reasoning_effort ?? null) !== m!.reasoning_effort) {
      changes.push(`${name} reasoning effort ${before?.reasoning_effort ?? "not sent"} to ${m!.reasoning_effort ?? "not sent"}`);
    }
    if (step.tool === "web" && (before?.max_searches ?? null) !== m!.max_searches) {
      changes.push(`${name} searches ${before?.max_searches ?? "(none)"} to ${m!.max_searches}`);
    }
  }

  return {
    value: {
      company_pipeline: { ...obj(stored.company_pipeline), ...company },
      people_pipeline: { ...obj(stored.people_pipeline), ...people },
      personalisation: { ...obj(stored.personalisation), ...personal },
      spend_caps: { ...obj(stored.spend_caps), reoon_checks_per_day: caps.reoon_checks_per_day, openai_usd_per_day: { ...obj(obj(stored.spend_caps).openai_usd_per_day), ...caps.openai_usd_per_day } },
      models,
    },
    errors,
    changes,
  };
}

/** The settings rows as stored (raw), for a save that keeps what the sheet doesn't edit. */
export async function storedSettings(c: PoolClient): Promise<Partial<SettingsRows>> {
  const { rows } = await c.query<{ key: string; value: Record<string, unknown> }>(
    `SELECT key, value FROM enrich_settings WHERE key = ANY($1::text[])`,
    [SETTING_KEYS]
  );
  return Object.fromEntries(rows.map((r) => [r.key, obj(r.value)])) as Partial<SettingsRows>;
}

/** The edits the sheet would send for the settings as they are: what it starts from. */
export function settingsInputOf(v: PipelineSettings): SettingsInput {
  const models = {} as SettingsInput["models"];
  for (const step of MODEL_STEPS) {
    const m = v.models[step.key];
    models[step.key] = {
      model: m?.model ?? "",
      reasoning_effort: m?.reasoning_effort ?? null,
      max_searches: step.tool === "web" ? m?.max_searches ?? null : null,
    };
  }
  const cp = v.company_pipeline;
  return {
    company_pipeline: {
      enabled: cp.enabled, tags: cp.tags, max_pull_size: cp.max_pull_size, linkedin_profile_reads: cp.linkedin_profile_reads,
      inboxes_per_company: cp.inboxes_per_company, min_balance: cp.min_balance,
    },
    people_pipeline: { ...v.people_pipeline },
    personalisation: { ...v.personalisation },
    spend_caps: { reoon_checks_per_day: v.spend_caps.reoon_checks_per_day, openai_usd_per_day: { ...v.spend_caps.openai_usd_per_day } },
    models,
  };
}

// ── The worker ──────────────────────────────────────────────────────────────

/** The worker as the tab needs it. Never says what a key is, only whether it is set. */
export function workerView(w: WorkerState | null): CompanyWorker | null {
  if (!w) return null;
  const info = w.info ?? {};
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const r = info.reoon;
  return {
    online: w.online,
    secondsAgo: w.seconds_ago,
    companyRuns: Array.isArray(info.capabilities) && info.capabilities.includes("company_runs"),
    peopleRuns: Array.isArray(info.capabilities) && info.capabilities.includes("people_runs"),
    keys: info.keys ?? {},
    reoon: r && typeof r === "object"
      ? { daily: num(r.daily), instant: num(r.instant), readAt: typeof r.read_at === "string" ? r.read_at : null }
      : null,
  };
}

// ── Pulls and counts ────────────────────────────────────────────────────────

export const COMPANY_RUN_FIELDS = `r.id, r.client_tag, r.mode, r.status, r.size_requested, r.table_id,
  r.match_count::float8 AS match_count, r.pulled, r.from_registry, r.bought_before,
  r.credits_used::float8 AS credits_used, r.credits_before::float8 AS credits_before, r.credits_after::float8 AS credits_after,
  r.attempts, r.next_run_at, r.last_error, r.stop_reason, r.created_at, r.started_at, r.finished_at, r.updated_at,
  jsonb_array_length(r.requests) AS searches, up.full_name AS created_by_name`;

export async function companyRunsFor(c: PoolClient, tag: string, limit = 10): Promise<CompanyRun[]> {
  const { rows } = await c.query<CompanyRun>(
    `SELECT ${COMPANY_RUN_FIELDS}
       FROM aiark_company_runs r LEFT JOIN user_profiles up ON up.id = r.created_by
      WHERE r.client_tag = $1
      ORDER BY r.created_at DESC LIMIT $2`,
    [tag, limit]
  );
  return rows;
}

/** The client's Companies table on the Clay tab, made on its first pull: the pipeline's (companies_v2) first. */
export async function templateTableOf(c: PoolClient, tag: string) {
  const { rows } = await c.query<{ id: string; row_count: number }>(
    `SELECT id, row_count FROM enrich_tables
      WHERE client_tag = $1 AND kind = 'companies' AND template IS NOT NULL
      ORDER BY template = 'companies_v2' DESC, created_at DESC LIMIT 1`,
    [tag]
  );
  return rows[0] ?? null;
}

/** The client's pipeline template tables by kind (made by its first pull or people run). */
export async function pipelineTablesOf(c: PoolClient, tag: string) {
  const { rows } = await c.query<{ kind: string; id: string }>(
    `SELECT kind, id FROM enrich_tables
      WHERE client_tag = $1 AND template IN ('companies_v2', 'inboxes_v1', 'people_v1')`,
    [tag]
  );
  const by = new Map(rows.map((r) => [r.kind, r.id]));
  return { companies: by.get("companies") ?? null, inboxes: by.get("inboxes") ?? null, people: by.get("people") ?? null };
}

/** The counts strip: listed companies by what lists them, people and inboxes by verdict, every outcome, and the rows still being worked. */
export async function countsFor(c: PoolClient, tag: string): Promise<CompanyCounts> {
  const table = await templateTableOf(c, tag);
  const tables = await pipelineTablesOf(c, tag);
  const { rows: outcomes } = await c.query<{ outcome: string; n: number }>(
    `SELECT outcome, count(*)::int AS n FROM enrich_companies WHERE client_tag = $1 GROUP BY 1`,
    [tag]
  );
  const { rows: [listed] } = await c.query<{ total: number; general: number; people: number; both: number; held: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE general_emails > 0 AND people_emails + people_held = 0)::int AS general,
            count(*) FILTER (WHERE general_emails = 0 AND people_emails + people_held > 0)::int AS people,
            count(*) FILTER (WHERE general_emails > 0 AND people_emails + people_held > 0)::int AS both,
            count(*) FILTER (WHERE (held OR general_emails = 0) AND people_emails = 0)::int AS held
       FROM enrich_companies WHERE client_tag = $1 AND listed`,
    [tag]
  );
  const { rows: [contacts] } = await c.query<{
    p_rows: number; p_approved: number; p_waiting: number; p_no_email: number; g_rows: number; g_approved: number; g_waiting: number; g_rejected: number;
  }>(
    `SELECT count(*) FILTER (WHERE kind = 'person')::int AS p_rows,
            count(*) FILTER (WHERE kind = 'person' AND verdict = 'approved')::int AS p_approved,
            count(*) FILTER (WHERE kind = 'person' AND verdict = 'enrichley')::int AS p_waiting,
            count(*) FILTER (WHERE kind = 'person' AND (stage = 'no_email' OR outcome LIKE 'No email%'))::int AS p_no_email,
            count(*) FILTER (WHERE kind = 'general')::int AS g_rows,
            count(*) FILTER (WHERE kind = 'general' AND verdict = 'approved')::int AS g_approved,
            count(*) FILTER (WHERE kind = 'general' AND verdict = 'enrichley')::int AS g_waiting,
            count(*) FILTER (WHERE kind = 'general' AND verdict = 'rejected')::int AS g_rejected
       FROM enrich_contacts WHERE client_tag = $1`,
    [tag]
  );
  const { rows: [runs] } = await c.query<{ looked: number; held: number; bought: number }>(
    `SELECT coalesce(sum(r.looked), 0)::int AS looked, coalesce(sum(r.bought), 0)::int AS bought,
            (SELECT count(*)::int FROM aiark_people_candidates k JOIN aiark_people_runs q ON q.id = k.run_id
              WHERE q.client_tag = $1 AND k.verdict = 'held') AS held
       FROM aiark_people_runs r WHERE r.client_tag = $1`,
    [tag]
  );
  let rows: Partial<Record<RowStatus, number>> = {};
  if (table) {
    const { rows: st } = await c.query<{ run_status: RowStatus; n: number }>(
      `SELECT run_status, count(*)::int AS n FROM enrich_rows WHERE table_id = $1 GROUP BY 1`,
      [table.id]
    );
    rows = Object.fromEntries(st.map((r) => [r.run_status, r.n]));
  }
  return {
    tableId: table?.id ?? null,
    tableRows: table?.row_count ?? 0,
    inboxTableId: tables.inboxes,
    peopleTableId: tables.people,
    listed: { total: listed?.total ?? 0, general: listed?.general ?? 0, people: listed?.people ?? 0, both: listed?.both ?? 0, held: listed?.held ?? 0 },
    people: {
      looked: runs?.looked ?? 0, held: runs?.held ?? 0, bought: runs?.bought ?? 0, approved: contacts?.p_approved ?? 0,
      waiting: contacts?.p_waiting ?? 0, noEmail: contacts?.p_no_email ?? 0, rows: contacts?.p_rows ?? 0,
    },
    inboxes: { approved: contacts?.g_approved ?? 0, waiting: contacts?.g_waiting ?? 0, rejected: contacts?.g_rejected ?? 0, rows: contacts?.g_rows ?? 0 },
    outcomes: Object.fromEntries(outcomes.map((r) => [r.outcome, r.n])),
    rows,
  };
}

// ── The count's sample ──────────────────────────────────────────────────────

function staffText(staff: unknown) {
  const s = obj(staff);
  const total = Number(s.total);
  const range = obj(s.range);
  const start = Number(range.start);
  const end = Number(range.end);
  const band = Number.isFinite(start) && start > 0
    ? Number.isFinite(end) && end > 0 && end < 1_000_000 ? `${fmt(start)} to ${fmt(end)}` : `${fmt(start)}+`
    : "";
  if (Number.isFinite(total) && total > 0) return band ? `${fmt(total)} (${band})` : fmt(total);
  return band || null;
}

/** One sampled AI Ark company record, as the count shows it. Nothing is stored. */
export function companySample(record: unknown): CompanyCountResult["sample"][number] {
  const r = obj(record);
  const s = obj(r.summary);
  const link = obj(r.link);
  const hq = obj(obj(r.location).headquarter);
  return {
    name: text(s.name) || text(r.name) || "(no name)",
    domain: bareDomain(link.domain) ?? bareDomain(link.website) ?? null,
    place: [text(hq.city), text(hq.state)].filter(Boolean).join(", ") || text(hq.country) || null,
    employees: staffText(s.staff),
    industry: text(s.industry) || null,
  };
}

// ── The list: keyset pages, no OFFSET ───────────────────────────────────────

export type ListCursor = { sort: "newest"; key: string; id: number } | { sort: "name"; key: string | null; id: number };

// found_at to the microsecond, in UTC (PAGE_FIELDS' found_key): a JS Date would
// drop the microseconds, and a cursor a few microseconds early skips rows.
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function encodeCursor(cur: ListCursor): string {
  return Buffer.from(JSON.stringify([cur.sort === "newest" ? "t" : "n", cur.key, cur.id])).toString("base64url");
}

/** The cursor for `sort`, or null when it is not one this route made. */
export function decodeCursor(raw: string, sort: ListSort): ListCursor | null {
  if (!raw || raw.length > 2_000) return null;
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(v) || v.length !== 3) return null;
  const [kind, key, id] = v;
  if (!Number.isSafeInteger(id) || id < 1) return null;
  if (sort === "newest") {
    return kind === "t" && typeof key === "string" && CURSOR_TIME.test(key) ? { sort, key, id } : null;
  }
  return kind === "n" && (key === null || (typeof key === "string" && key.length <= 1_000)) ? { sort, key, id } : null;
}

export interface ListParams {
  tag: string;
  sort: ListSort;
  size: number;
  after: ListCursor | null;
  q: string;
  state: string | null;
  status: "valid" | "catch_all" | null;
  foundBy: FoundBy | null;
  hideHeld: boolean;
  /** Only companies with a usable person email, or with a usable general email. */
  has?: ListHas | null;
}

// found_key is ISO 8601 in UTC whatever the session's DateStyle and TimeZone, so it reads back exactly.
const PAGE_FIELDS = `e.row_id, e.table_id, e.company, e.domain, e.website, e.city, e.state, e.country, e.address, e.phone,
  e.industry, e.employees, e.general_email, e.email_status, e.held, e.found_by, e.email_kind, e.source, e.found_at,
  e.general_emails, e.general_waiting, e.people_emails, e.people_held, e.people_total,
  to_char(e.found_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS found_key, lower(e.company) AS name_key`;

type PageRow = Omit<CompanyRow, "row_id" | "linkedin" | "run" | "found_at" | "contacts"> & {
  row_id: string | number;
  found_at: Date | string;
  found_key: string;
  name_key: string | null;
};

/**
 * One page of a client's listed companies, newest first or A to Z. Each page
 * reads on from the last row of the one before (keyset, on the partial indexes
 * of migration 124), so its cost depends on the page size, not on how many
 * companies the client has. A to Z puts companies with no name last.
 */
export async function listCompanies(c: PoolClient, p: ListParams): Promise<CompaniesPage> {
  const params: unknown[] = [p.tag];
  const arg = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where = ["e.client_tag = $1", "e.listed"];
  if (p.state) where.push(`e.state = ${arg(p.state)}`);
  if (p.status) where.push(`e.email_status = ${arg(p.status)}`);
  if (p.foundBy) where.push(`e.found_by = ${arg(p.foundBy)}`);
  if (p.hideHeld) where.push("NOT e.held");
  if (p.has === "people") where.push("e.people_emails + e.people_held > 0");
  if (p.has === "general") where.push("e.general_emails > 0");
  if (p.q) where.push(`e.search_text LIKE ${arg(`%${p.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);

  const page = async (extra: ((a: (v: unknown) => string) => string) | null, order: string, limit: number) => {
    const ps = [...params];
    const a = (v: unknown) => {
      ps.push(v);
      return `$${ps.length}`;
    };
    const w = extra ? [...where, extra(a)] : where;
    const { rows } = await c.query<PageRow>(
      `SELECT ${PAGE_FIELDS} FROM enrich_companies e WHERE ${w.join(" AND ")} ORDER BY ${order} LIMIT ${a(limit)}`,
      ps
    );
    return rows;
  };

  const want = p.size + 1; // one more than the page: is there a next page?
  const after = p.after;
  let rows: PageRow[];
  if (p.sort === "newest") {
    rows = await page(
      after ? (a) => `(e.found_at, e.row_id) < (${a(after.key)}::timestamptz, ${a(after.id)}::bigint)` : null,
      "e.found_at DESC, e.row_id DESC",
      want
    );
  } else if (!after) {
    rows = await page(null, "lower(e.company), e.row_id", want);
  } else if (after.key !== null) {
    const key = after.key;
    rows = await page((a) => `(lower(e.company), e.row_id) > (${a(key)}::text, ${a(after.id)}::bigint)`, "lower(e.company), e.row_id", want);
    // The row comparison leaves out companies with no name; they follow every named one.
    if (rows.length < want) rows = rows.concat(await page(() => "lower(e.company) IS NULL", "e.row_id", want - rows.length));
  } else {
    rows = await page((a) => `lower(e.company) IS NULL AND e.row_id > ${a(after.id)}::bigint`, "e.row_id", want);
  }

  let next: string | null = null;
  if (rows.length > p.size) {
    rows = rows.slice(0, p.size);
    const last = rows[rows.length - 1];
    next = encodeCursor(
      p.sort === "newest"
        ? { sort: "newest", key: last.found_key, id: Number(last.row_id) }
        : { sort: "name", key: last.name_key, id: Number(last.row_id) }
    );
  }

  const ids = rows.map((r) => Number(r.row_id));
  type Extra = { row_id: string; linkedin: string | null; run_id: string | null; run_at: Date | null; run_mode: string | null; copied: boolean };
  const extras = new Map<number, Extra>();
  if (ids.length) {
    // The row's LinkedIn input, and the pull its row came from (bought, or copied free).
    const { rows: ex } = await c.query<Extra>(
      `SELECT r.id AS row_id, li.value #>> '{}' AS linkedin, cr.id AS run_id, cr.created_at AS run_at, cr.mode AS run_mode,
              coalesce(cr.registry_source_id = r.source_id, false) AS copied
         FROM enrich_rows r
         LEFT JOIN enrich_cells li ON li.row_id = r.id AND li.column_key = 'linkedin'
         LEFT JOIN aiark_company_runs cr ON cr.source_id = r.source_id OR cr.registry_source_id = r.source_id
        WHERE r.id = ANY($1::bigint[])`,
      [ids]
    );
    for (const x of ex) extras.set(Number(x.row_id), x);
  }

  // The first general emails and people of each company on the page (enrich_contacts), best first.
  const contacts = await contactsFor(c, { tag: p.tag, rowIds: ids });

  let states: CompaniesPage["states"];
  if (!after) {
    const { rows: st } = await c.query<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM enrich_companies
        WHERE client_tag = $1 AND listed AND coalesce(state, '') <> ''
        GROUP BY 1 ORDER BY 1 LIMIT 300`,
      [p.tag]
    );
    states = st;
  }

  return {
    rows: rows.map((r) => {
      const { found_key: _fk, name_key: _nk, ...rest } = r;
      void _fk;
      void _nk;
      const x = extras.get(Number(r.row_id));
      return {
        ...rest,
        row_id: Number(r.row_id),
        found_at: new Date(r.found_at).toISOString(),
        linkedin: x?.linkedin ?? null,
        run: x?.run_id
          ? { id: x.run_id, created_at: new Date(x.run_at!).toISOString(), mode: x.run_mode === "demo" ? "demo" : "live", copied: x.copied === true }
          : null,
        contacts: contacts.get(Number(r.row_id)) ?? { general: [], people: [] },
      } satisfies CompanyRow;
    }),
    next,
    ...(states ? { states } : {}),
  };
}
