// What GET /api/topup answers: the Sharing page's Low places tab
// (src/components/sharing/low-places-tab.tsx).

import type { AiArkModes } from "@/lib/aiark/types";

export type TopupFlagKind = "low" | "unresolved" | "no_places" | "no_rules" | "not_covered" | "all_ok";

export interface TopupPlaceFlag {
  kind: "low" | "unresolved";
  label: string;
  placeKey: string;
  place: { country: string; state: string | null; city: string | null } | null;
  available: number | null;
  minimum: number | null;
}

/**
 * "Free first" for one client with low city places, counted at pass time
 * (topup_passes.counts.free_first): leads already in the database that a place
 * fix would count there, which costs nothing.
 */
export interface TopupFreeFirst {
  /** Contactable partial leads (city text the geo reference did not match) in the states of the client's low city places; null: not counted. */
  partial: number | null;
  /** Contactable unresolved leads whose place text names one of the client's low cities; null: not counted. */
  unresolved: number | null;
  states: Array<{ key: string; partial: number | null }>;
  cities: Array<{ label: string; unresolved: number }>;
}

/** One client in a pass: its low places, or the one row that says why it has none. */
export interface TopupClient {
  tag: string;
  name: string | null;
  clientType: string | null;
  status: string | null;
  /** fn_client_receive_block() at pass time: why it cannot receive, or null. */
  receiveBlock: string | null;
  minimum: number | null;
  /** The client-level row (all_ok, no_places, no_rules, not_covered), when it has no place rows. */
  kind: TopupFlagKind | null;
  places: TopupPlaceFlag[];
  /** What the pass did about the low places (topup_flags.action) and why. */
  action: string;
  reason: string | null;
  pullId: string | null;
  runId: string | null;
  /** client_stats: every lead carrying the tag, and the contactable ones (a tag count, not coverage). */
  tagLeads: number | null;
  tagContactable: number | null;
  /** Its free-first numbers in this pass; null when it has none (no low city place, or a pass from before free first). */
  freeFirst: TopupFreeFirst | null;
}

/** An AI Ark run started by hand (not a top-up run), queued or running for a client that cannot receive now. */
export interface TopupHandRun {
  id: string;
  tag: string;
  status: "queued" | "running";
  mode: "live" | "demo";
  strategy: "single" | "export";
  size: number;
  creditsUsed: number;
  pulled: number;
  createdAt: string;
  startedAt: string | null;
  /** Who started it: full name, else email; null when no user is recorded. */
  startedBy: string | null;
  /** fn_client_receive_block now. */
  reason: string;
}

export interface TopupPass {
  id: string;
  state: "requested" | "running" | "done" | "error";
  trigger: "schedule" | "button" | "manual";
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  clientsDone: number;
  counts: Record<string, unknown>;
  lastError: string | null;
  requestedByName: string | null;
}

/** A pull waiting to start (prepared), with what the AI Ark routes need to count and start it. */
export interface TopupPull {
  id: string;
  passId: string | null;
  tag: string;
  mode: "prepare" | "auto";
  places: Array<{ country: string; state?: string | null; city?: string | null }>;
  labels: string[];
  size: number;
  searches: number;
  brake: number;
  countCredits: number;
  matchCount: number | null;
  countedAt: string | null;
  note: string | null;
  createdAt: string;
  /** The client's rules and saved people filters versions now (POST /api/aiark/runs checks them). */
  rulesVersion: string | null;
  peopleVersion: string | null;
}

export interface TopupView {
  ready: boolean;
  settings: {
    enabled: boolean;
    clientTypes: string[];
    defaultMinimum: number;
    pullMode: "off" | "prepare" | "auto";
    pullTags: string[];
    weeklyCredits: number;
    clientWeeklyCredits: number;
    maxPullSize: number;
    pullsPerDay: number;
  } | null;
  /** The pass shown (the newest), and the last one that finished. */
  pass: TopupPass | null;
  lastDone: { id: string; finishedAt: string } | null;
  clients: TopupClient[];
  pulls: TopupPull[];
  budget: { used: number; reserved: number; weekly: number; clientWeekly: number; pullsToday: number; pullsPerDay: number } | null;
  /** Credits used and held in the last 7 days for each client with a pull waiting. */
  clientBudget: Record<string, { used: number; reserved: number }>;
  modes: AiArkModes | null;
  /** The shown pass's count of every unresolved lead and when it was taken; null for a pass from before free first. */
  freeFirst: { unresolvedTotal: number | null; at: string | null } | null;
  /** AI Ark runs started by hand for clients that cannot receive now, oldest first (live, whether or not the top-up is on). */
  handRuns: TopupHandRun[];
}
