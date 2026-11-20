// Shapes the fit routes answer with (phase 3: fit scoring, promotion, the
// gate, the review list). Types only, so the client components can import
// them without pulling in the server code.

export type FitKeyKind = "domain" | "name";
export type PromoteKind = "general" | "person";
export type ReviewDecision = "pending" | "approved" | "rejected";

export interface FitModel {
  model: string;
  reasoning_effort?: string;
}

/** The scoring settings an admin edits (PUT /api/fit/settings). */
export interface FitSettingsView {
  rule: { prompt: string | null; version: string | null };
  scoring: { enabled: boolean; batch_size: number; calls_in_flight: number };
  model: FitModel | null;
  efforts: string[];
}

/** The gate an owner or admin edits (PUT /api/fit/gate). */
export interface FitGateView {
  enabled: boolean;
  tags: string[];
  threshold: number;
  client_types: string[];
  require_scored: boolean;
  refresh: { pending: boolean; since: string | null };
  /** Client types held in client_tags, for the picker. */
  known_types: string[];
}

/** What the fit panel shows (GET /api/fit/state). */
export interface FitState {
  rule: { set: boolean; version: string | null };
  model: FitModel | null;
  scoring: { enabled: boolean; batch_size: number; calls_in_flight: number };
  /** Why the scorer does nothing now, or null when it can score. */
  idle_reason: string | null;
  queue: { priority: number; waiting: number; claimed: number }[];
  refresh_pending: boolean;
  spend: { used: number; cap: number };
  worker: {
    online: boolean;
    fit_scoring: boolean;
    state: string | null;
    why: string | null;
    last_error: string | null;
    last_error_at: string | null;
  } | null;
  gate: {
    enabled: boolean;
    tags: string[];
    threshold: number;
    client_types: string[];
    require_scored: boolean;
    /** fn_fit_gate_applies(tag) for the client on screen. */
    covers_client: boolean | null;
  };
  /** On a large company_fit the total is the planner's estimate (approx) and manual and unscorable are not counted. */
  scores: { total: number; approx: boolean; blocked: number; manual: number | null; unscorable: number | null };
  /** Promotion into leads: its switch and client list (set on the Companies settings sheet). It needs no fit score. */
  promotion: {
    enabled: boolean;
    tags: string[];
    on_for_client: boolean | null;
    require_question: boolean;
    source_label: string;
    /** Why promotion can't run for the client now, or null. */
    blocked_why: string | null;
    counts: Record<PromoteKind, { ready: number; no_question: number }> | null;
  };
}

export interface ScoreEstimate {
  companies: number;
  campaigns: number;
  pipeline: number;
  calls: number;
  usd: number;
  days_at_cap: number | null;
  cap: number;
  exact: boolean;
  copy_rows: number;
  model: string | null;
  rule_version: string | null;
}

export interface FitRun {
  id: string;
  kind: "score" | "review";
  client_tag: string | null;
  status: string;
  leads_seen: number;
  companies: number;
  queued: number;
  items: number;
  last_error: string | null;
  created_at: string;
  finished_at: string | null;
  created_by_name: string | null;
  progress: Record<string, unknown>;
  estimate: Partial<ScoreEstimate> | null;
}

export interface ReviewItem {
  id: number;
  instance_url: string;
  campaign_id: string;
  campaign_name: string | null;
  campaign_status: string | null;
  campaign_from: "push_history" | "live_name" | null;
  key_kind: FitKeyKind;
  key: string;
  company: string | null;
  domain: string | null;
  city: string | null;
  state: string | null;
  score: number | null;
  home_office: boolean | null;
  reason: string | null;
  model: string | null;
  leads: number;
  emails_sent: number;
  replied: number;
  interested: number;
  removable: number;
  oldest_sync: string | null;
  decision: ReviewDecision;
  decided_by_name: string | null;
  decided_at: string | null;
  /** The company is still blocked now (the queue leaves out any that is not). */
  still_blocked: boolean;
}

export interface ReviewPage {
  items: ReviewItem[];
  next: number | null;
  summary: {
    items: number;
    pending: number;
    approved: number;
    rejected: number;
    leads: number;
    removable: number;
    oldest_sync: string | null;
  };
  campaigns: { instance_url: string; campaign_id: string; name: string | null; items: number }[];
  build: FitRun | null;
  gate_covers: boolean;
  removals: { held: number; done: number; skipped: number; failed: number };
  dry_runs: {
    id: string;
    created_at: string;
    used_at: string | null;
    would_remove: number;
    would_skip: number;
    cannot_confirm: number;
    rows: number;
  }[];
}
