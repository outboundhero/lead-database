// Shapes shared by the AI Ark tab's routes and its page.

export type RunMode = "live" | "demo";
export type RunStrategy = "single" | "export";
export type RunStatus = "queued" | "running" | "done" | "stopped" | "error" | "cancelled";
export const ACTIVE_STATUSES: RunStatus[] = ["queued", "running"];

export interface EmployeeBand {
  start?: number;
  end?: number;
}

/** A client's people filters (client_people_filters), as edited on the tab. */
export interface PeopleFilters {
  titles: string[];
  title_mode: "SMART" | "WORD" | "STRICT";
  exclude_titles: string[];
  seniority: string[];
  departments: string[];
  employee_bands: EmployeeBand[];
  industries: string[];
  exclude_industries: string[];
}

export interface Readiness {
  ready: boolean;
  why: string | null;
}

export interface AiArkModes {
  live: Readiness;
  demo: Readiness;
  /** The export strategy in live mode needs our public webhook address. */
  exportLive: Readiness;
}

export interface PlanReport {
  locations: { total: number; sent: number; requests: number; examples: string[]; dropped: { entry: unknown; why: string }[] };
  excludeLocations?: { total: number; sent: number };
  excludeTerms?: { total: number; sent: number };
  titles?: number;
  titleMode?: string;
  excludeTitles?: number;
  seniority?: string[];
  departments?: string[];
  bands?: EmployeeBand[];
  industries?: number;
  excludeIndustries?: number;
  commercialCleaning?: boolean;
}

/** What AI Ark would be asked for the filters on screen. */
export interface AiArkPlan {
  searches: number;
  report: PlanReport;
  notes: string[];
  /** Nothing can be counted or pulled until these are fixed. */
  blockers: string[];
  /** A count is fine; a pull is not. */
  pullBlockers: string[];
  /** The first search's filter body, exactly as it would be sent. */
  example: object | null;
}

export interface AiArkRun {
  id: string;
  client_tag: string;
  mode: RunMode;
  strategy: RunStrategy;
  status: RunStatus;
  size_requested: number;
  table_id: string | null;
  match_count: number | null;
  pulled: number;
  with_email: number;
  skipped_held: number;
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
  lists_note: string | null;
  excluded: number | null;
  job_state: string | null;
  created_by_name: string | null;
  /** People per outcome so far; only on a client's newest runs. */
  outcomes?: Record<string, number>;
}

export interface AiArkSetup {
  modes: AiArkModes;
  client: { tag: string; name: string | null; client_type: string | null; status: string | null } | null;
  targeting: { updatedAt: string; places: number; excludeTerms: number; commercialCleaning: boolean } | null;
  people: { saved: boolean; updatedAt: string | null; defaultsFrom: "cleaning" | null; value: PeopleFilters };
  plan: AiArkPlan;
  runs: AiArkRun[];
  credits: Partial<Record<RunMode, { credits: number | null; error: string | null }>>;
  worker: { online: boolean; secondsAgo: number | null } | null;
  suggestions: { departments: string[]; industries: string[]; seniority: string[] };
}

export interface CountResult {
  mode: RunMode;
  total: number;
  perSearch: number[];
  credits: number;
  sample: { name: string; title: string | null; company: string | null; place: string | null }[];
}
