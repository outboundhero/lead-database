// Shapes shared by the Clay tab's routes and its page.

export type CellStatus = "done" | "empty" | "skipped" | "error" | "needs_key" | "running";
export type RowStatus = "queued" | "running" | "done" | "waiting" | "error";
export const ROW_STATUSES: RowStatus[] = ["queued", "running", "done", "waiting", "error"];

export interface EnrichColumn {
  key: string;
  name: string;
  position: number;
  kind: "input" | "formula" | "waterfall" | "action";
  action: string | null;
  formula: string | null;
  waterfall: string[] | null;
  inputs: Record<string, string>;
  config: Record<string, unknown>;
  run_if: string | null;
  data_type: "text" | "boolean" | "url" | "json" | "number";
  description: string | null;
  provider: string | null;
  needs_env: string[];
  phase: number;
  hidden: boolean;
  clay_field_id: string | null;
}

export interface EnrichTableSummary {
  id: string;
  client_tag: string;
  client_name: string | null;
  /** ai_ark: one table per AI Ark run (the AI Ark tab), several per client. */
  kind: "companies" | "people" | "inboxes" | "ai_ark";
  name: string;
  row_count: number;
  is_paused: boolean;
  updated_at: string;
  created_at?: string;
  /** AI Ark tables only: the run that fills the table. */
  run?: {
    id: string;
    status: string;
    mode: "live" | "demo";
    strategy: "single" | "export";
    pulled: number;
    size: number;
    created_at: string;
  } | null;
}

export interface WorkerState {
  id: string;
  last_seen: string;
  started_at: string | null;
  seconds_ago: number;
  online: boolean;
  info: {
    concurrency?: number;
    in_flight?: number;
    processed?: number;
    calls?: number;
    failed?: number;
    keys?: Record<string, boolean>;
    stopped?: boolean;
  };
}

export interface SourceSummary {
  id: string;
  kind: string;
  label: string | null;
  received: number;
  created: number;
  duplicates: number;
  skipped: number;
  created_at: string;
}

/** Per column: cell counts by status, plus "true" / "false" for boolean cells. */
export type ColumnCounts = Partial<Record<CellStatus | "true" | "false", number>>;

export interface TableDetail {
  table: EnrichTableSummary & { source_note: string | null };
  columns: EnrichColumn[];
  counts: Record<string, ColumnCounts>;
  statuses: Partial<Record<RowStatus, number>>;
  sources: SourceSummary[];
  keyCounts: Record<string, number>;
  worker: WorkerState | null;
}

export interface GridCell {
  s: CellStatus;
  d: string | null;
  n: string | null;
  v?: string | number | boolean | null;
}

export interface GridRow {
  id: number;
  row_key: string;
  run_status: RowStatus;
  last_error: string | null;
  created_at: string;
  reference: Record<string, string> | null;
  cells: Record<string, GridCell>;
}

export interface RowsPage {
  rows: GridRow[];
  total: number;
  page: number;
  size: number;
}

export interface CellRun {
  id: number;
  status: string;
  provider: string | null;
  request: unknown;
  response: unknown;
  error: string | null;
  http_status: number | null;
  duration_ms: number | null;
  started_at: string;
  finished_at: string;
}

export interface CellDetail {
  column: EnrichColumn;
  cell: {
    status: CellStatus;
    value: unknown;
    display: string | null;
    note: string | null;
    runs: number;
    updated_at: string;
  } | null;
  row: {
    id: number;
    /** An AI Ark person's "Name · Company", a company row's name, or the row's key. */
    title: string;
    run_status: RowStatus;
    last_error: string | null;
    created_at: string;
    source_label: string | null;
    reference: string | null;
  };
  /** The current values of the cells this column reads. */
  reads: { key: string; name: string; display: string | null; status: CellStatus | null }[];
  runs: CellRun[];
  columnNames: Record<string, string>;
}

/** A formula with its {{key}} references shown as Clay's {{Column Name}}. */
export function withNames(text: string | null | undefined, names: Record<string, string>): string {
  return String(text ?? "").replace(/\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g, (_, k: string) => `{{${names[k] ?? k}}}`);
}
