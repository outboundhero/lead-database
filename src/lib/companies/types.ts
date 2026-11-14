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

// ── Settings (enrich_settings, migrations 124 and 125) ──────────────────────

/** The original Clay AI steps, one model setting each (enrich_settings.models), in the templates' order. */
export type ModelStep =
  | "companys_website"
  | "email_extraction_claygent"
  | "email_extraction_claygent_2"
  | "company_decision_maker_facilities_1_claygent"
  | "company_decision_maker_facilities_2_claygent"
  | "company_decision_maker_location_company_check"
  | "company_decision_maker_ceo_claygent"
  | "current_employer"
  | "people_claygent"
  | "people_question_ai"
  | "inbox_claygent"
  | "inbox_question_ai";

/** tool: "web" for the Claygent steps (they get the web search tool and a cap on tool calls), "none" for the plain AI steps. */
export const MODEL_STEPS: { key: ModelStep; label: string; hint: string; tool: "web" | "none"; table: "Companies" | "People" | "General inboxes" }[] = [
  { key: "companys_website", label: "Company's website", hint: "Finds the website when AI Ark gave no domain.", tool: "web", table: "Companies" },
  { key: "email_extraction_claygent", label: "Email search, first", hint: "Looks for the office's general emails on its website.", tool: "web", table: "Companies" },
  { key: "email_extraction_claygent_2", label: "Email search, second", hint: "Runs when the first search found nothing usable.", tool: "web", table: "Companies" },
  { key: "company_decision_maker_facilities_1_claygent", label: "Decision maker: operations", hint: "AI search for the operations track, only when AI Ark found nobody (AI searches switch).", tool: "web", table: "Companies" },
  { key: "company_decision_maker_facilities_2_claygent", label: "Decision maker: facility and office", hint: "AI search for the facility and office track (AI searches switch).", tool: "web", table: "Companies" },
  { key: "company_decision_maker_location_company_check", label: "Decision maker: location check", hint: "Reads a LinkedIn profile (LinkedIn profile reads switch).", tool: "web", table: "Companies" },
  { key: "company_decision_maker_ceo_claygent", label: "Decision maker: CEO or owner", hint: "AI search for the CEO or owner track, only when AI Ark found nobody (AI searches switch).", tool: "web", table: "Companies" },
  { key: "current_employer", label: "Current employer", hint: "Reads a person's LinkedIn profile (LinkedIn profile reads switch).", tool: "web", table: "People" },
  { key: "people_claygent", label: "Personalisation research (people)", hint: "Personalisation switch.", tool: "web", table: "People" },
  { key: "people_question_ai", label: "Personalisation question (people)", hint: "Personalisation switch. No web search.", tool: "none", table: "People" },
  { key: "inbox_claygent", label: "Personalisation research (inboxes)", hint: "Personalisation switch.", tool: "web", table: "General inboxes" },
  { key: "inbox_question_ai", label: "Personalisation question (inboxes)", hint: "Personalisation switch. No web search.", tool: "none", table: "General inboxes" },
];

/** The reasoning efforts the settings sheet takes. Left out, none is sent. A Luna model refuses "minimal". */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ModelSetting {
  model: string;
  /** Sent to OpenAI only when set. */
  reasoning_effort?: Effort;
  /** Sent as max_tool_calls for a step with the web search tool. */
  max_searches?: number;
}

export interface ModelPrice {
  in: number;
  out: number;
  search_tokens?: number;
}

/** The pipeline's settings as the worker reads them (scripts/lib/enrich/settings.mjs settingsFrom), the parts this tab shows. */
export interface PipelineSettings {
  company_pipeline: {
    enabled: boolean;
    tags: string[];
    max_pull_size: number;
    linkedin_profile_reads: boolean;
    inboxes_per_company: number;
    min_balance: number;
    /** How long paid answers are reused, in days. Not edited on the sheet. */
    memory_days: { website: number; email: number; nothing_found: number };
  };
  people_pipeline: {
    enabled: boolean;
    tags: string[];
    auto_buy: boolean;
    ai_searches: boolean;
    ids_per_search: number;
    pages_per_search: number;
    tries_per_track: number;
    max_people_per_run: number;
    recheck_days: number;
    skip_company_when_held: boolean;
    min_balance: number;
  };
  personalisation: { enabled: boolean; tags: string[]; shared_text_ok: boolean };
  spend_caps: {
    reoon_checks_per_day: number;
    openai_usd_per_day: { pipeline: number; fit: number };
    /** Dollars per 1M tokens per model, and web_search_call per search. Not edited on the sheet. */
    openai_prices: Record<string, ModelPrice | number>;
  };
  /** One entry per AI step; fit_score (phase 3) is kept as stored. Null: the step is unset and does not run. */
  models: Record<ModelStep, ModelSetting | null> & Record<string, ModelSetting | null>;
}

/** The settings as stored, and their version (sent back with a save). */
export interface SettingsState {
  value: PipelineSettings;
  version: string;
}

/** One model step as the pull panel prices it. */
export interface PricedStep {
  key: ModelStep;
  model: string | null;
  searches: number;
}

/** What every manager sees of the settings: the switches, and what the estimates are worked out from. */
export interface PipelineView {
  /** Company pulls switched on (for the clients on their list). */
  enabled: boolean;
  /** The client on the screen is on company_pipeline.tags (null when no client is picked). */
  onList: boolean | null;
  maxPullSize: number;
  /** The company row's paid web steps: the website search and the two email searches, at their tool-call caps. */
  steps: PricedStep[];
  inboxesPerCompany: number;
  prices: Record<string, ModelPrice | number>;
}

/** The edits the settings sheet sends (PUT /api/companies/settings). */
export interface SettingsInput {
  company_pipeline: {
    enabled: boolean;
    tags: string[];
    max_pull_size: number;
    linkedin_profile_reads: boolean;
    inboxes_per_company: number;
    min_balance: number;
  };
  people_pipeline: PipelineSettings["people_pipeline"];
  personalisation: PipelineSettings["personalisation"];
  spend_caps: { reoon_checks_per_day: number; openai_usd_per_day: { pipeline: number; fit: number } };
  models: Record<ModelStep, { model: string; reasoning_effort: Effort | null; max_searches: number | null }>;
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
  /** The worker advertises people_runs: without it nothing works a people run. */
  peopleRuns: boolean;
  /** Provider keys the worker holds (names only). */
  keys: Record<string, boolean>;
  /** The last Reoon balance the worker read for the pipeline's checks. */
  reoon: { daily: number | null; instant: number | null; readAt: string | null } | null;
}

export interface CompanyCounts {
  /** The client's Companies table on the Clay tab (made on its first pull). */
  tableId: string | null;
  tableRows: number;
  /** The client's General inboxes and People tables (pipeline templates), when made. */
  inboxTableId: string | null;
  peopleTableId: string | null;
  /**
   * Shown on the tab: companies with a usable general or person email. general / people / both: by what
   * makes them listed; held: every usable email is already in the database.
   */
  listed: { total: number; general: number; people: number; both: number; held: number };
  /** The people runs' people: looked at (candidates), held in the database, bought, and the People rows by verdict. */
  people: { looked: number; held: number; bought: number; approved: number; waiting: number; noEmail: number; rows: number };
  /** The General inboxes rows by verdict. */
  inboxes: { approved: number; waiting: number; rejected: number; rows: number };
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
/** Where the first general email was found: the database, AI Ark, the first or second email search (search_1/2 are phase 1's). */
export type FoundBy = "database" | "aiark" | "claygent_1" | "claygent_2" | "search_1" | "search_2";
export const FOUND_BY: FoundBy[] = ["database", "aiark", "claygent_1", "claygent_2", "search_1", "search_2"];
export const PAGE_SIZES = [50, 100, 200] as const;
/** The list's "has" filter: companies with a usable person email, or with a usable general email. */
export type ListHas = "people" | "general";

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
  /** Usable general emails, general emails waiting for Enrichley, usable new person emails, held person emails, all People rows. */
  general_emails: number;
  general_waiting: number;
  people_emails: number;
  people_held: number;
  people_total: number;
  /** Up to 3 general emails and up to 3 people, best first; the rest open in the contacts list. */
  contacts: { general: Contact[]; people: Contact[] };
}

export interface CompaniesPage {
  rows: CompanyRow[];
  /** The cursor for the next page, or null on the last one. */
  next: string | null;
  /** First page only: the states the client's listed companies are in. */
  states?: { state: string; n: number }[];
}

// ── Contacts (enrich_contacts, migration 125) ───────────────────────────────

export type ContactVerdict = "approved" | "enrichley" | "rejected" | "unchecked" | "held" | "never_contact" | "bounced";
export type Track = "operations" | "facility_office" | "ceo";
export const TRACKS: Track[] = ["operations", "facility_office", "ceo"];
export const TRACK_LABELS: Record<Track, string> = { operations: "Operations", facility_office: "Facility and office", ceo: "CEO or owner" };

/** One General inboxes row or People row of a company, as the tab lists it. */
export interface Contact {
  row_id: number;
  table_id: string;
  kind: "general" | "person";
  email: string | null;
  verdict: ContactVerdict | null;
  usable: boolean;
  held: boolean;
  full_name: string | null;
  title: string | null;
  linkedin: string | null;
  track: Track | null;
  /** inbox: database, aiark, claygent_1, claygent_2; person: aiark, facilities_1, facilities_2, ceo */
  found_by: string | null;
  stage: "bought" | "no_email" | "copied" | "found" | null;
  outcome: string;
  city: string | null;
  state: string | null;
}

export interface ContactsPage {
  rows: Contact[];
  /** The cursor for the next page, or null on the last one. */
  next: string | null;
  /** First page only: how many of each kind the company has. */
  totals?: { general: number; people: number };
}

// ── People runs (aiark_people_runs, migration 125) ──────────────────────────

export type PeopleRunStatus = "queued" | "running" | "looked" | "done" | "stopped" | "error" | "cancelled";
export const ACTIVE_PEOPLE_RUN_STATUSES: PeopleRunStatus[] = ["queued", "running", "looked"];
export type CandidateVerdict = "candidate" | "held" | "never_contact" | "bounced" | "outside" | "excluded" | "no_track" | "bought_before";
export type CandidatePick = "none" | "picked" | "reserve" | "bought" | "no_email" | "lost";

export interface PeopleRun {
  id: string;
  client_tag: string;
  mode: RunMode;
  source: string;
  status: PeopleRunStatus;
  max_people: number;
  companies: number;
  batches: number;
  /** Preview pages bought. */
  pages: number;
  /** People the Look saw (candidates). */
  looked: number;
  /** People rows copied free from the registry. */
  copied: number;
  picked: number;
  /** Export Single calls made. */
  bought: number;
  with_email: number;
  /** Companies skipped: someone usable already held there. */
  skipped_held: number;
  lost_answers: number;
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
  buy_approved_at: string | null;
  created_by_name: string | null;
  buy_approved_by_name: string | null;
  /** The candidates by screen verdict. */
  verdicts: Partial<Record<CandidateVerdict, number>>;
  /** Companies settled so far. */
  settled: number;
  /** Where the run stops itself, in credits. */
  ceiling: number;
  /** More companies were ready than one run takes. */
  more_companies: boolean;
}

export interface PeopleTrackView {
  track: Track;
  label: string;
  phrases: string[];
  /** Where the phrases come from in the originals (C#n). */
  from: string[];
}

export interface PeoplePlan {
  /** People runs switched on, and this client on their list. */
  on: boolean;
  switchOn: boolean;
  onList: boolean;
  autoBuy: boolean;
  aiSearches: boolean;
  /** Null: the tracks are not loaded (the originals' seed writes them), so no run can start. */
  tracks: PeopleTrackView[] | null;
  excludedTitles: { titles: string[]; from: "saved" | "cleaning" | "none" };
  /** The client's pipeline tables, when made. */
  tables: { companies: string | null; inboxes: string | null; people: string | null };
  companies: { passing: number; eligible: number; held: number; notChecked: number; looked: number; noId: number };
  settings: PipelineSettings["people_pipeline"];
  estimate: {
    /** Searches a Look starts with: one per batch of ids (more if a batch is refused as too large). */
    searches: number;
    /** At least this many credits (one page a search), at most lookMax (every search to its page cap). */
    lookMin: number;
    lookMax: number;
    /** At most this many people bought (3 a company, capped by the run's most people), 1 credit each with an email. */
    buyMax: number;
    /** The worst case of the AI searches' OpenAI dollars for these companies, when they are switched on. */
    aiSearchUsd: number;
  };
  /** Why a run can't start, as far as the page can tell (the route checks again). */
  blockers: string[];
}

export interface PeopleSetup {
  plan: PeoplePlan;
  runs: PeopleRun[];
  /** The Clay originals loaded in the database: the default set, and the client's own when it has one. */
  originals: { default: { total: number; complete: boolean }; client: { variant: string; total: number; complete: boolean } | null };
  /** Today's spend against the caps (UTC day). */
  spend: { reoon: { used: number; cap: number }; openaiPipeline: { used: number; cap: number }; openaiFit: { used: number; cap: number } };
  /** Steps that wait for a key we may not hold, and whether the worker holds it (null: the worker does not say). */
  keys: { key: string; vendor: string; holds: string; held: boolean | null; built: boolean }[];
}

export interface Candidate {
  person_id: string;
  company_row_id: number;
  company: string | null;
  first_name: string | null;
  /** Masked by the Preview ("Ba***e"). */
  last_name: string | null;
  title: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  seniority: string | null;
  track: Track | null;
  rank: number | null;
  verdict: CandidateVerdict;
  pick: CandidatePick;
  row_id: number | null;
}

export interface CandidatesPage {
  rows: Candidate[];
  next: string | null;
}
