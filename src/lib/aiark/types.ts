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
  /** standard: how many of them are the cleaning clients' standard keywords. */
  excludeTerms?: { total: number; sent: number; standard?: number };
  /** Keywords left out at the people level too (cleaning clients). */
  peopleKeywords?: number;
  excludeCompanyTypes?: string[];
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
  /** Cancelled, but still reading the export AI Ark was already paid for. */
  finishing: boolean;
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
  /** version: the rules' updated_at as text, sent back with a pull. */
  targeting: { updatedAt: string; version: string; places: number; excludeTerms: number; commercialCleaning: boolean } | null;
  /** version: the saved filters' updated_at as text (null when nothing is saved), sent back with a save or a pull. */
  people: { saved: boolean; updatedAt: string | null; version: string | null; defaultsFrom: "cleaning" | null; value: PeopleFilters };
  plan: AiArkPlan;
  runs: AiArkRun[];
  credits: Partial<Record<RunMode, { credits: number | null; error: string | null }>>;
  worker: { online: boolean; secondsAgo: number | null } | null;
  suggestions: { departments: string[]; industries: string[]; seniority: string[] };
}

/** GET /api/aiark/add: where a run's people stand with "Add to the database". */
export interface AddState {
  run: { id: string; mode: RunMode; finished: boolean };
  /** Ready to add and not added yet, including anyone an earlier add could not store. */
  ready: number;
  added: number;
  /** Skipped: already a lead, in the Email Bison copy or on the never-contact list. */
  skipped: number;
  adding: number;
  /** The import could not store them; the next add tries again. */
  failed: number;
}

export interface CountResult {
  mode: RunMode;
  total: number;
  perSearch: number[];
  credits: number;
  sample: { name: string; title: string | null; company: string | null; place: string | null }[];
  /** The rules' version the count searched with (null: the client had no rules). */
  rulesVersion: string | null;
}
