// What GET /api/never-contact-inboxes answers: the Sharing page's General
// inboxes tab (src/components/sharing/never-contact-inboxes-panel.tsx).

export interface NeverContactPart {
  part: string;
  count: number;
  sample: string[];
}

export interface NeverContactRun {
  id: string;
  kind: "dry_run" | "apply";
  state: "done" | "running" | "following" | "stopped" | "error";
  sha12: string;
  dry_run_id: string | null;
  bound_at: string | null;
  counted: number | null;
  cursor_created_at: string | null;
  suppressed: number;
  leads_flagged: number;
  bison_queued: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  created_by_name: string | null;
  /** A finished dry run of the filter loaded now, at most 24 hours old. */
  can_apply: boolean;
  /** Only on the newest dry run. */
  sample?: { parts: NeverContactPart[] } | null;
}

export interface NeverContactView {
  ready: boolean;
  /** Whether the Clay General inboxes filter is loaded; the filter itself is never sent. */
  loaded: boolean;
  source: string | null;
  readAt: string | null;
  sha12: string | null;
  parts: number;
  enabled: boolean;
  /** Switched on and the filter loaded. */
  on: boolean;
  rowsPerDay: number;
  chunkRows: number;
  today: number;
  total: number;
  live: NeverContactRun | null;
  latestDryRun: NeverContactRun | null;
  runs: NeverContactRun[];
}
