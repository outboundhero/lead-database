// Shapes shared by the AI Ark tab's routes and its page.

export type RunMode = "live" | "demo";
export type RunStrategy = "single" | "export";
export type RunStatus = "queued" | "running" | "done" | "stopped" | "error" | "cancelled";
export const ACTIVE_STATUSES: RunStatus[] = ["queued", "running"];

/**
 * The most people one pull may ask for. An export job above PART_SIZE runs as
 * parts of up to PART_SIZE, one after another, each its own run (start-run.mjs);
 * one at a time stays a single run.
 */
export const PULL_MAX: Record<RunStrategy, number> = { single: 10_000, export: 200_000 };
/** People per part of a large export pull: AI Ark's own limit for one export job (EXPORT_MAX in client.mjs). */
export const PART_SIZE = 10_000;

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
  /**
   * standard: how many of them are the cleaning clients' standard keywords; list: how many the built-in
   * competitors list adds beside those and the client's own; checkedAfter: how many the search can't hold
   * (checked after the pull). list and checkedAfter come with the competitors list (cleaning clients).
   */
  excludeTerms?: { total: number; sent: number; standard?: number; list?: number; checkedAfter?: number };
  /** The built-in competitors list the search leaves out (cleaning clients): terms in it, added beside the others. */
  competitors?: { name: string; from: "database" | "fallback"; terms: number; added: number };
  /** Standard keywords left out at the people level too (cleaning clients). */
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
  /** One at a time: people whose Preview company held an excluded keyword, skipped before their email was bought. */
  keyword_skipped: number | null;
  job_state: string | null;
  /**
   * A part of an export pull larger than PART_SIZE: which part (the first is
   * 1), the size the whole pull asked for, and how many people the parts before
   * this one pulled. Null for a pull that is a single run.
   */
  series?: { id: string; part: number; total: number; before: number } | null;
  /** AI Ark has taken (and charged for) the export this run holds now: cancelling can't undo it. */
  export_taken: boolean;
  /** How many people that export asked for. */
  job_size: number | null;
  created_by_name: string | null;
  /** People per outcome so far; only on a client's newest runs. */
  outcomes?: Record<string, number>;
  /** People from this run who became leads. */
  added?: number;
}

export interface AiArkSetup {
  modes: AiArkModes;
  client: { tag: string; name: string | null; client_type: string | null; status: string | null } | null;
  /** version: the rules' updated_at as text, sent back with a pull. */
  targeting: { updatedAt: string; version: string; places: number; excludeTerms: number; commercialCleaning: boolean } | null;
  /** version: the saved filters' updated_at as text (null when nothing is saved), sent back with a save or a pull. */
  people: { saved: boolean; updatedAt: string | null; version: string | null; defaultsFrom: "cleaning" | null; value: PeopleFilters };
  /** The built-in competitors list this client's searches leave out (cleaning clients), or null. */
  competitors: CompetitorsListView | null;
  plan: AiArkPlan;
  runs: AiArkRun[];
  credits: Partial<Record<RunMode, { credits: number | null; error: string | null }>>;
  worker: { online: boolean; secondsAgo: number | null } | null;
  suggestions: { departments: string[]; industries: string[]; seniority: string[] };
}

/** The built-in competitors list as the AI Ark tab shows it (competitorsView in scripts/lib/aiark/competitors.mjs). */
export interface CompetitorsListView {
  name: string;
  /** Terms in the list (trimmed, once each). */
  terms: number;
  /** fallback: the database has no such list, so the terms it was first made with are used. */
  from: "database" | "fallback";
  note: string | null;
  /** Where the list is edited (the Lists page). */
  editHref: string;
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
  /** No email: waiting for the email-finding steps. */
  pipeline: number;
  /** Of those, copied to the client's People (pipeline) table, where the email finders look for an address (their find_email cell says so). */
  sent: number;
}

export interface CountResult {
  mode: RunMode;
  total: number;
  perSearch: number[];
  credits: number;
  sample: { name: string; title: string | null; company: string | null; place: string | null }[];
  /** The rules' version the count searched with (null: the client had no rules). */
  rulesVersion: string | null;
  /**
   * People this client's AI Ark tab runs of this mode have bought: every pull
   * leaves them out (up to AI Ark's list limits), though the total includes
   * them. Null when it wasn't read: a count of only some of the client's
   * places, or the database didn't answer in time.
   */
  bought: number | null;
  /** total less bought, never below 0: roughly how many a pull could still buy. Null with bought. */
  aboutNew: number | null;
}
