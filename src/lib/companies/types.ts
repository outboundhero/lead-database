// Shapes shared by the Companies tab's routes and its page.

import type { EmployeeBand, Readiness, RunMode } from "@/lib/aiark/types";
import type { RowStatus } from "@/lib/enrich/types";

export type CompanyRunStatus = "queued" | "running" | "done" | "stopped" | "error" | "cancelled";
export const ACTIVE_RUN_STATUSES: CompanyRunStatus[] = ["queued", "running"];

/**
 * What a company pull asks AI Ark for besides the client's rules: the size and
 * industries saved on the AI Ark tab (client_people_filters), or a cleaning
 * client's standard ones while nothing is saved.
 */
export interface CompanyFilters {
  employee_bands: EmployeeBand[];
  industries: string[];
  exclude_industries: string[];
}

/** What AI Ark would be asked, as buildCompanyRequests reports it. */
export interface CompanyPlanReport {
  locations: {
    total: number;
    sent: number;
    requests: number;
    examples: string[];
    dropped: { entry: unknown; why: string; exclude?: boolean }[];
  };
  excludeLocations?: { total: number; sent: number };
  /** standard: how many of them are the cleaning clients' standard keywords. */
  excludeTerms?: { total: number; sent: number; standard?: number };
  excludeCompanyTypes?: string[];
  bands?: EmployeeBand[];
  industries?: number;
  excludeIndustries?: number;
  commercialCleaning?: boolean;
}

export interface CompanyPlan {
  /** One Company Search per group of places. */
  searches: number;
  report: CompanyPlanReport;
  notes: string[];
  /** Nothing can be counted or pulled until these are fixed. */
  blockers: string[];
  /** A count is fine; a pull is not. */
  pullBlockers: string[];
  /** The first search's body, exactly as it would be sent. */
  example: object | null;
}

// ── Settings (enrich_settings, migration 124) ───────────────────────────────

export type ModelStep = "website_search" | "email_search_first" | "email_search_second";

export const MODEL_STEPS: { key: ModelStep; label: string; hint: string }[] = [
  { key: "website_search", label: "Website search", hint: "Runs only when AI Ark gave no live website." },
  { key: "email_search_first", label: "First email search", hint: "Looks for the office's general email." },
  { key: "email_search_second", label: "Second email search", hint: "Runs only when the first found nothing usable." },
];

/** The reasoning efforts the settings sheet takes. Left out, none is sent. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelSetting {
  model: string;
  /** Sent to OpenAI only when set. */
  reasoning_effort?: Effort;
  max_searches: number;
}

export interface PipelineSettings {
  company_pipeline: {
    enabled: boolean;
    max_pull_size: number;
    email_checks_per_company: number;
    /** How long paid answers are reused, in days. Not edited on the sheet. */
    memory_days?: { website?: number; email?: number; nothing_found?: number };
    [k: string]: unknown;
  };
  /** One entry per AI step; fit_score (phase 3) and any other key are kept as stored. */
  models: Partial<Record<ModelStep, ModelSetting | null>> & Record<string, unknown>;
}

/** The settings as stored, and their version (sent back with a save). */
export interface SettingsState {
  value: PipelineSettings;
  version: string;
}

/** What every manager sees of the settings: the switch, and the caps behind the estimate. */
export interface PipelineView {
  enabled: boolean;
  maxPullSize: number;
  checksPerCompany: number;
  /** Most searches per company for each AI step. */
  searchCaps: Record<ModelStep, number>;
}

/** The edits the settings sheet sends (PUT /api/companies/settings). */
export interface SettingsInput {
  company_pipeline: { enabled: boolean; max_pull_size: number; email_checks_per_company: number };
  models: Record<ModelStep, { model: string; reasoning_effort: Effort | null; max_searches: number }>;
}

// ── Runs, worker and counts ─────────────────────────────────────────────────

export interface CompanyRun {
  id: string;
  client_tag: string;
  mode: RunMode;
  status: CompanyRunStatus;
  size_requested: number;
  table_id: string | null;
  match_count: number | null;
  /** New rows in the client's table, bought or copied. */
  pulled: number;
  /** Of those, copied free from companies an earlier pull bought. */
  from_registry: number;
  /** Returned and paid for again although an earlier pull had bought them. */
  bought_before: number;
  credits_used: number;
  credits_before: number | null;
  credits_after: number | null;
  attempts: number;
  next_run_at: string;
  last_error: string | null;
  stop_reason: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  searches: number;
  created_by_name: string | null;
}

export interface CompanyWorker {
  online: boolean;
  secondsAgo: number | null;
  /** The worker advertises company_runs in its heartbeat: without it nothing picks up a company pull. */
  companyRuns: boolean;
  /** Provider keys the worker holds (names only). */
  keys: Record<string, boolean>;
  /** The last Reoon balance the worker read for the pipeline's checks. */
  reoon: { daily: number | null; instant: number | null; readAt: string | null } | null;
}

export interface CompanyCounts {
  /** The client's Companies table on the Clay tab (made on its first pull). */
  tableId: string | null;
  tableRows: number;
  /** Shown on the tab: a general email (valid or catch-all), or an inbox already in the database. */
  listed: { total: number; valid: number; catchAll: number; held: number };
  /** Every worked company, by outcome (enrich_companies.outcome). */
  outcomes: Record<string, number>;
  /** The table's rows by status: queued and running ones are still being worked. */
  rows: Partial<Record<RowStatus, number>>;
}

export interface CompaniesSetup {
  modes: { live: Readiness; demo: Readiness };
  client: { tag: string; name: string | null; client_type: string | null; status: string | null } | null;
  /** version: the rules' updated_at as text, sent back with a count or a pull. */
  targeting: { updatedAt: string; version: string; places: number; excludePlaces: number; excludeTerms: number } | null;
  /** version: the saved filters' updated_at as text (null when nothing is saved), sent back with a count or a pull. */
  filters: { saved: boolean; updatedAt: string | null; version: string | null; defaultsFrom: "cleaning" | null; value: CompanyFilters };
  plan: CompanyPlan | null;
  runs: CompanyRun[];
  counts: CompanyCounts | null;
  worker: CompanyWorker | null;
  pipeline: PipelineView;
  credits: Partial<Record<RunMode, { credits: number | null; error: string | null }>>;
  /** Admins only. */
  settings?: SettingsState | null;
}

export interface CompanyCountResult {
  mode: RunMode;
  total: number;
  perSearch: number[];
  credits: number;
  sample: { name: string; domain: string | null; place: string | null; employees: string | null; industry: string | null }[];
  /** The versions the count searched with: a pull needs a count made for the versions on screen. */
  rulesVersion: string | null;
  filtersVersion: string | null;
}

// ── The list (GET /api/companies/list) ──────────────────────────────────────

export type ListSort = "newest" | "name";
export type FoundBy = "database" | "aiark" | "search_1" | "search_2";
export const FOUND_BY: FoundBy[] = ["database", "aiark", "search_1", "search_2"];
export const PAGE_SIZES = [50, 100, 200] as const;

export interface CompanyRow {
  row_id: number;
  table_id: string;
  company: string | null;
  domain: string | null;
  website: string | null;
  linkedin: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  address: string | null;
  phone: string | null;
  industry: string | null;
  employees: string | null;
  general_email: string | null;
  email_status: "valid" | "catch_all" | null;
  held: boolean;
  found_by: FoundBy | null;
  email_kind: "general" | "named" | null;
  source: string;
  found_at: string;
  /** The pull the row came from; copied: taken free from an earlier pull's companies. */
  run: { id: string; created_at: string; mode: RunMode; copied: boolean } | null;
}

export interface CompaniesPage {
  rows: CompanyRow[];
  /** The cursor for the next page, or null on the last one. */
  next: string | null;
  /** First page only: the states the client's listed companies are in. */
  states?: { state: string; n: number }[];
}
