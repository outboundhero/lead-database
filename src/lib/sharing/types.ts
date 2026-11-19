// What the Sharing page's routes answer (src/app/api/sharing/), shared by the
// routes and the page. The tables are share_jobs and lead_shares (migration
// 134); their states and outcomes are named in scripts/lib/overlap-topup.mjs.

export type ShareJobState = "waiting" | "deciding" | "previewed" | "applied" | "skipped" | "no_lead_list" | "error" | "undone";
export type ShareOutcome =
  | "shared"
  | "own_topup"
  | "filtered_inbox"
  | "already_sent"
  | "in_flight"
  | "already_shared"
  | "already_tagged"
  | "same_install"
  | "also_fits";
export type SharePushState = "queued" | "pushed" | "held" | "dropped";

/** share_jobs.counts: per receiver, the leads checked, the ones that fit, and each outcome. */
export type JobCounts = Record<string, Record<string, number>>;

export interface ShareJob {
  batch_id: string;
  /** The import: its file name, or the label of an AI Ark add or promotion. */
  filename: string | null;
  source_label: string | null;
  inserted_rows: number | null;
  origin_tag: string | null;
  origin_pool: string | null;
  state: ShareJobState;
  reason: string | null;
  /** The skipped reason in plain words. */
  reason_text: string | null;
  topup: boolean;
  mode: "preview" | "apply" | null;
  batch_done_at: string;
  place_wait_until: string | null;
  /** Set when the job decided at the place wait limit: shown as a red notice. */
  place_wait_hit_at: string | null;
  new_leads: number;
  leads_no_place: number;
  receivers: string[];
  receivers_done: string[];
  receivers_applied: string[];
  receivers_over_cap: string[];
  counts: JobCounts;
  attempts: number;
  next_try_at: string | null;
  recheck_until: string | null;
  last_error: string | null;
  created_at: string;
  decided_at: string | null;
  applied_at: string | null;
  undone_at: string | null;
}

/** The worker running now, as the Sharing page needs it. */
export interface SharingWorker {
  online: boolean;
  secondsAgo: number;
  /** It runs the share step (the "sharing" capability). */
  sharing: boolean;
}

/** The overlap_sharing switch as the page shows it. */
export interface SharingSwitch {
  enabled: boolean;
  mode: "preview" | "apply";
  since: string | null;
  tags: string[];
  push_tags: string[];
  write_tags: boolean;
  held_retry_days: number;
}

export interface JobsAnswer {
  /** False before migration 134 is applied: nothing else is filled. */
  ready: boolean;
  jobs: ShareJob[];
  /** Where the next page starts (pass it as before); null when there is none. */
  next: string | null;
  byState: Partial<Record<ShareJobState, number>>;
  /** Jobs that decided at the place wait limit in the last 7 days. */
  waitedLimit: number;
  worker: SharingWorker | null;
  switch: SharingSwitch;
}

export interface ShareRowView {
  id: string;
  lead_id: string;
  email: string | null;
  company: string | null;
  city: string | null;
  state: string | null;
  matched_place: string | null;
  outcome: ShareOutcome;
  applied_at: string | null;
  push_state: SharePushState | null;
  push_note: string | null;
  push_batch_id: string | null;
  tag_added: boolean;
  undone_at: string | null;
}

export interface JobReceiver {
  tag: string;
  /** fn_client_receive_block now: null when it can receive. */
  receiveBlock: string | null;
  onPushList: boolean;
  overCap: boolean;
  applied: boolean;
  /** Rows by outcome, and the applied, undone and tagged ones. */
  outcomes: Partial<Record<ShareOutcome, number>>;
  appliedRows: number;
  undoneRows: number;
  taggedRows: number;
  push: Partial<Record<SharePushState, number>>;
  /** Up to 20 rows, shares first. */
  sample: ShareRowView[];
}

export interface JobPushBatch {
  id: string;
  receiver: string;
  status: string;
  total: number | null;
  sent: number;
  created_at: string;
  source: string | null;
}

export interface JobAnswer {
  job: ShareJob;
  /** The counts the decide step stored (share_jobs.counts) beside the rows written. */
  receivers: JobReceiver[];
  pushBatches: JobPushBatch[];
  switch: SharingSwitch;
}

export interface SharingClient {
  tag: string;
  name: string | null;
  status: string | null;
  client_type: string | null;
  group_no: number | null;
  /** The sharing pool, or null when the client is isolated. */
  pool: string | null;
  receiveBlock: string | null;
  onList: boolean;
  onPushList: boolean;
  shared7d: number;
}

export interface ClientsAnswer {
  ready: boolean;
  clients: SharingClient[];
  pools: Record<string, string[]>;
  isolatedSuffixes: string[];
}

export interface HeldGroup {
  receiver: string;
  note: string | null;
  rows: number;
  oldest: string | null;
  lastTry: string | null;
  /** True while the daily retry still covers the group's oldest row. */
  retried: boolean;
}

export interface NoPlaceGroup {
  city: string;
  state: string;
  country: string;
  status: string;
  leads: number;
}

export interface MirrorInstall {
  install: string;
  group: number;
  side: "b2b" | "b2c";
  /** The Bison mirror holds at least one lead of this install. */
  covered: boolean;
  lastSync: string | null;
}

export interface HeldAnswer {
  ready: boolean;
  held: HeldGroup[];
  queued: Array<{ receiver: string; rows: number; oldest: string | null }>;
  noPlace: NoPlaceGroup[];
  mirror: MirrorInstall[];
  heldRetryDays: number;
}

/** The Uploads page's badge, per batch. */
export interface BatchShareBadge {
  state: ShareJobState;
  reason: string | null;
  /** Receivers with applied, live shares. */
  sharedTo: number;
  /** Receivers with shares not applied yet (a preview). */
  previewTo: number;
}

export interface LeadShare {
  id: string;
  batch_id: string;
  filename: string | null;
  source_label: string | null;
  origin_tag: string;
  receiver_tag: string;
  outcome: ShareOutcome;
  matched_place: string | null;
  decided_at: string;
  applied_at: string | null;
  push_state: SharePushState | null;
  push_note: string | null;
  pushed_at: string | null;
  push_batch_id: string | null;
  tag_added: boolean;
  undone_at: string | null;
}

/** POST /api/sharing/push/auto and each receiver of POST /api/sharing/push. */
export interface SharePushAnswer {
  receiver: string;
  /** Rows put into push batches this call. */
  pushed: number;
  batches: string[];
  /** Rows held this call, with the reason in note. */
  held: number;
  /** Rows dropped this call (already in the picked campaigns, or the lead is gone). */
  dropped: number;
  /** Rows of the receiver still queued after the call. */
  left: number;
  note: string | null;
}

/** The answer of a share push that did nothing because sharing is off or the campaign search failed. */
export interface SharePushRefusal {
  error: string;
  /** Rows left as they were. */
  kept: number;
}
