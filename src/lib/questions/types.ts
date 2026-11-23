// What the question variable routes answer (src/app/api/questions/*, migration
// 139): the shapes the Clay tab's Question variable tab and the export popup
// read. Type-only, so a page may import it.

/** One variable as a client's list shows it (GET /api/questions/variables). */
export interface VariableListItem {
  id: string;
  /** Lower case, as Bison stores it. */
  name: string;
  /** How campaign copy writes it: {ACME-OS QUESTION}. */
  copyTag: string;
  createdForTag: string | null;
  services: string;
  maxWords: number;
  promptVersion: number;
  archived: boolean;
  /** The clients whose pushes use it (client_question_settings). */
  usedBy: string[];
}

/** GET /api/questions/variables?tag=TAG, and the answer of PUT /api/questions/client. */
export interface VariablesView {
  tag: string;
  /** The client sells other services: its type is OS or its tag has an isolated ending (default "-OS"). */
  isOs: boolean;
  /** question_variables is on and lists the client. */
  switchOn: boolean;
  /** The worker running now writes question jobs (question_jobs in its heartbeat). */
  workerReady: boolean;
  /** null: the default {QUESTION}. */
  current: { variableId: string | null };
  variables: VariableListItem[];
}

/** One variable, all of it. */
export interface VariableDetail {
  id: string;
  name: string;
  copyTag: string;
  createdForTag: string | null;
  services: string;
  clientContext: string;
  researchPrompt: string;
  peoplePrompt: string;
  generalPrompt: string;
  maxWords: number;
  /** Bumped by every save: sent back with the next one. */
  version: number;
  /** Bumped by every save that changes what gets written: values of an older one are stale. */
  promptVersion: number;
  archived: boolean;
  updatedAt: string | null;
  /** The email of whoever saved it last, or null. */
  updatedBy: string | null;
}

/** GET /api/questions/variables/<id>, and the answer of every save. */
export interface VariableView {
  variable: VariableDetail;
  /** What each prompt may use, as {{Name}}: the research prompt, and the People and General question prompts. */
  placeholders: { research: string[]; question: string[] };
}

/** GET /api/questions/context?tag=TAG: the onboarding sheet's target answer, for "Fill from onboarding". */
export interface ContextView {
  target: string | null;
}

/** One of the client's Bison installs, read live. exists null: it could not be read (error says why). */
export interface BisonInstallView {
  install: string;
  side: "b2b" | "b2c";
  exists: boolean | null;
  error: string | null;
}

/** GET /api/questions/bison?tag=TAG&variableId=ID */
export interface BisonView {
  name: string;
  copyTag: string;
  installs: BisonInstallView[];
}

/** POST /api/questions/bison {tag, variableId}: made where it was missing. */
export interface BisonCreateResult {
  created: string[];
  existed: string[];
  failed: Array<{ install: string; error: string }>;
}

/** POST /api/questions/readiness {tag, variableId, selection} */
export interface ReadinessView {
  /** Leads the push would send for the selection. */
  selected: number;
  /** ... with a value of the variable's current prompt version. */
  withValue: number;
  /** ... with a value of an older prompt version (still sent, written again by a job). */
  stale: number;
  /** ... with no value at all. */
  missing: number;
  /** ... whose last try ended in an error or a skip. */
  errors: number;
  /** Companies of the leads to write with no current research. */
  companiesMissing: number;
  /** What a job would call: a research call a company, a question call a lead (a second only when an answer breaks the rules). */
  estimate: { researchCalls: number; questionCalls: number };
}

export type JobStatus = "queued" | "gathering" | "running" | "paused" | "done" | "error" | "cancelled";

/** The statuses of a job not finished yet. */
export const OPEN_JOB_STATUSES: readonly JobStatus[] = ["queued", "gathering", "running", "paused"];

/** One job (GET /api/questions/jobs?tag=TAG). */
export interface JobView {
  id: string;
  variableId: string;
  variableName: string;
  status: JobStatus;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  companies: number;
  researched: number;
  spendUsd: number;
  /** Why it waits (paused), in plain words. */
  note: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface JobsView {
  jobs: JobView[];
}

/** One written value, for review (GET /api/questions/values): never an email. */
export interface ValueView {
  company: string | null;
  title: string | null;
  value: string | null;
  status: string;
  note: string | null;
  generatedAt: string;
}

export interface ValuesView {
  values: ValueView[];
}

/** POST /api/questions/copy-check: whether each campaign's copy uses the variable, and the default {QUESTION}. */
export interface CopyCheckCampaign {
  instance_url: string;
  id: number;
  usesVariable: boolean;
  usesQuestion: boolean;
  error: string | null;
}

export interface CopyCheckView {
  campaigns: CopyCheckCampaign[];
}
