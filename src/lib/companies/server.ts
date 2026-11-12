import type { PoolClient } from "pg";
import { buildCompanyRequests } from "../../../scripts/lib/aiark/company-filters.mjs";
import { bareDomain } from "../../../scripts/lib/enrich/domain.mjs";
import { geo, modes, peopleOrDefaults } from "@/lib/aiark/server";
import type { RowStatus, WorkerState } from "@/lib/enrich/types";
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
  type ListSort,
  type ModelStep,
  type PipelineSettings,
  type PipelineView,
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
const intIn = (v: unknown, lo: number, hi: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
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

const SETTING_KEYS = ["company_pipeline", "models"];
/** aiark_company_runs.size_requested takes at most 10,000. */
export const PULL_SIZE_LIMIT = 10_000;
const MAX_CHECKS = 5;
const MAX_SEARCHES = 5;
// Used only when a stored value is missing or unusable: the values migration 124 seeds.
const FALLBACK_MAX_PULL = 1_000;
const FALLBACK_CHECKS = 3;
const FALLBACK_CAPS: Record<ModelStep, number> = { website_search: 2, email_search_first: 3, email_search_second: 2 };
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{1,60}$/;

/**
 * The settings as stored, read fresh inside the caller's transaction. The
 * worker reads them through scripts/lib/enrich/settings.mjs with a 30 s cache;
 * here the switch must take effect the moment it is saved. A missing row reads
 * as switched off.
 */
export async function readPipelineSettings(c: PoolClient, { lock = false } = {}): Promise<SettingsState> {
  const { rows } = await c.query<{ key: string; value: unknown; version: string }>(
    `SELECT key, value, updated_at::text AS version
       FROM enrich_settings WHERE key = ANY($1::text[]) ORDER BY key${lock ? " FOR UPDATE" : ""}`,
    [SETTING_KEYS]
  );
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { value: normalizeSettings(stored), version: rows.map((r) => `${r.key}@${r.version}`).join(";") };
}

export function normalizeSettings(stored: Record<string, unknown>): PipelineSettings {
  const cp = obj(stored.company_pipeline);
  return {
    company_pipeline: {
      ...cp,
      enabled: cp.enabled === true,
      max_pull_size: intIn(cp.max_pull_size, 1, PULL_SIZE_LIMIT) ?? FALLBACK_MAX_PULL,
      email_checks_per_company: intIn(cp.email_checks_per_company, 1, MAX_CHECKS) ?? FALLBACK_CHECKS,
    },
    models: { ...obj(stored.models) } as PipelineSettings["models"],
  };
}

export function pipelineView(s: PipelineSettings): PipelineView {
  const searchCaps = {} as Record<ModelStep, number>;
  for (const { key } of MODEL_STEPS) searchCaps[key] = intIn(obj(s.models[key]).max_searches, 1, MAX_SEARCHES) ?? FALLBACK_CAPS[key];
  return {
    enabled: s.company_pipeline.enabled,
    maxPullSize: s.company_pipeline.max_pull_size,
    checksPerCompany: s.company_pipeline.email_checks_per_company,
    searchCaps,
  };
}

/**
 * Checks the settings sheet's edits and merges them into what is stored: keys
 * the sheet doesn't edit (memory_days, fit_score …) are kept. Returns the new
 * settings, or the errors; `changes` says what changed, for the audit log.
 */
export function cleanSettingsInput(
  input: unknown,
  current: PipelineSettings
): { value: PipelineSettings | null; errors: string[]; changes: string[] } {
  const errors: string[] = [];
  const body = obj(input);
  const cp = obj(body.company_pipeline);
  const modelsIn = obj(body.models);

  if (typeof cp.enabled !== "boolean") errors.push("The switch must be on or off.");
  const maxPull = intIn(cp.max_pull_size, 1, PULL_SIZE_LIMIT);
  if (maxPull === null) errors.push(`The largest pull must be a whole number from 1 to ${fmt(PULL_SIZE_LIMIT)}.`);
  const checks = intIn(cp.email_checks_per_company, 1, MAX_CHECKS);
  if (checks === null) errors.push(`Email checks per company must be a whole number from 1 to ${MAX_CHECKS}.`);

  const steps: { key: ModelStep; label: string; model: string; effort: Effort | null; searches: number }[] = [];
  for (const { key, label } of MODEL_STEPS) {
    const m = obj(modelsIn[key]);
    const model = typeof m.model === "string" ? m.model.trim() : "";
    const rawEffort = m.reasoning_effort;
    const effort = rawEffort === null || rawEffort === undefined || rawEffort === "" ? null : rawEffort;
    const searches = intIn(m.max_searches, 1, MAX_SEARCHES);
    let ok = true;
    if (!MODEL_ID.test(model)) {
      errors.push(`${label}: the model id must be 2 to 61 characters of lower-case letters, digits, dots and dashes, starting with a letter or digit.`);
      ok = false;
    }
    if (effort !== null && !(EFFORTS as readonly unknown[]).includes(effort)) {
      errors.push(`${label}: the reasoning effort must be one of ${EFFORTS.join(", ")}, or not sent.`);
      ok = false;
    }
    if (searches === null) {
      errors.push(`${label}: the most searches must be a whole number from 1 to ${MAX_SEARCHES}.`);
      ok = false;
    }
    if (ok) steps.push({ key, label, model, effort: effort as Effort | null, searches: searches! });
  }
  if (errors.length) return { value: null, errors, changes: [] };

  const changes: string[] = [];
  const was = current.company_pipeline;
  if (was.enabled !== cp.enabled) changes.push(cp.enabled ? "company pulls switched on" : "company pulls switched off");
  if (was.max_pull_size !== maxPull) changes.push(`largest pull ${fmt(was.max_pull_size)} to ${fmt(maxPull!)}`);
  if (was.email_checks_per_company !== checks) changes.push(`email checks per company ${was.email_checks_per_company} to ${checks}`);

  const models: Record<string, unknown> = { ...current.models };
  for (const s of steps) {
    const before = obj(current.models[s.key]);
    const next: Record<string, unknown> = { ...before, model: s.model, max_searches: s.searches };
    if (s.effort) next.reasoning_effort = s.effort;
    else delete next.reasoning_effort;
    models[s.key] = next;
    const name = s.label.toLowerCase();
    if (text(before.model) !== s.model) changes.push(`${name} model ${text(before.model) || "(none)"} to ${s.model}`);
    if ((before.reasoning_effort ?? null) !== s.effort) {
      changes.push(`${name} reasoning effort ${text(before.reasoning_effort) || "not sent"} to ${s.effort ?? "not sent"}`);
    }
    if (before.max_searches !== s.searches) changes.push(`${name} searches ${text(before.max_searches) || "(none)"} to ${s.searches}`);
  }

  return {
    value: {
      company_pipeline: { ...was, enabled: cp.enabled as boolean, max_pull_size: maxPull!, email_checks_per_company: checks! },
      models: models as PipelineSettings["models"],
    },
    errors,
    changes,
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

/** The client's Companies table on the Clay tab, made on its first pull. */
export async function templateTableOf(c: PoolClient, tag: string) {
  const { rows } = await c.query<{ id: string; row_count: number }>(
    `SELECT id, row_count FROM enrich_tables
      WHERE client_tag = $1 AND kind = 'companies' AND template IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [tag]
  );
  return rows[0] ?? null;
}

/** The counts strip: listed companies, every outcome, and the rows still being worked. */
export async function countsFor(c: PoolClient, tag: string): Promise<CompanyCounts> {
  const table = await templateTableOf(c, tag);
  const { rows: outcomes } = await c.query<{ outcome: string; n: number }>(
    `SELECT outcome, count(*)::int AS n FROM enrich_companies WHERE client_tag = $1 GROUP BY 1`,
    [tag]
  );
  const { rows: [listed] } = await c.query<{ total: number; held: number; valid: number; catch_all: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE held)::int AS held,
            count(*) FILTER (WHERE NOT held AND email_status = 'valid')::int AS valid,
            count(*) FILTER (WHERE NOT held AND email_status = 'catch_all')::int AS catch_all
       FROM enrich_companies WHERE client_tag = $1 AND listed`,
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
    listed: { total: listed?.total ?? 0, valid: listed?.valid ?? 0, catchAll: listed?.catch_all ?? 0, held: listed?.held ?? 0 },
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
}

// found_key is ISO 8601 in UTC whatever the session's DateStyle and TimeZone, so it reads back exactly.
const PAGE_FIELDS = `e.row_id, e.table_id, e.company, e.domain, e.website, e.city, e.state, e.country, e.address, e.phone,
  e.industry, e.employees, e.general_email, e.email_status, e.held, e.found_by, e.email_kind, e.source, e.found_at,
  to_char(e.found_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS found_key, lower(e.company) AS name_key`;

type PageRow = Omit<CompanyRow, "row_id" | "linkedin" | "run" | "found_at"> & {
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
      } satisfies CompanyRow;
    }),
    next,
    ...(states ? { states } : {}),
  };
}
