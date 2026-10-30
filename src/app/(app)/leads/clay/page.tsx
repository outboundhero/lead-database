"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  KeyRound,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Table2,
  Trash2,
  Upload,
  UserSearch,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { AccessDenied } from "@/components/layout/access-denied";
import { useHasPermission } from "@/lib/context/role-context";
import { ClayGrid, FILTER_LABELS, type GridFilter } from "@/components/clay/clay-grid";
import { CellPanel } from "@/components/clay/cell-panel";
import { ImportDialog } from "@/components/clay/import-dialog";
import type { EnrichColumn, EnrichTableSummary, RowsPage, RowStatus, TableDetail, WorkerState } from "@/lib/enrich/types";

// The Clay tab: a client's Clay tables, rebuilt inside the lead database.
// Columns are the client's own Clay columns (formulas and run conditions
// copied verbatim); the enrichment worker (npm run enrich-worker) fills the
// cells. Everything on screen is read from Postgres — nothing here calls a
// provider.

const KIND_TABS: { kind: EnrichTableSummary["kind"]; label: string }[] = [
  { kind: "companies", label: "Companies" },
  { kind: "people", label: "People" },
  { kind: "inboxes", label: "General inboxes" },
  { kind: "ai_ark", label: "AI Ark runs" },
];

const RUN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Pulling",
  done: "Done",
  stopped: "Stopped",
  error: "Failed",
  cancelled: "Cancelled",
};

/** One AI Ark run table, as the run picker shows it. */
function runLabel(t: EnrichTableSummary) {
  const r = t.run;
  if (!r) return t.name;
  const when = new Date(r.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${when} · ${fmt(r.pulled)} of ${fmt(r.size)} · ${RUN_STATUS_LABEL[r.status] ?? r.status}${r.mode === "demo" ? " · demo" : ""}`;
}

const STATUS_PILLS: { value: RowStatus | ""; label: string }[] = [
  { value: "", label: "All rows" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "done", label: "Done" },
  { value: "waiting", label: "Waiting on a key" },
  { value: "error", label: "Errors" },
];

const KEY_LABELS: Record<string, string> = { OPENAI_API_KEY: "OpenAI", CLEARBIT_API_KEY: "Clearbit" };

// Where an empty table's rows will come from, as in Clay's workbook: Maps
// places land in Companies, and the Companies steps write the people and inboxes.
const EMPTY_NOTE: Record<EnrichTableSummary["kind"], (tag: string) => string> = {
  companies: (tag) =>
    `Rows arrive from the GMaps Scraper once ${tag} is switched to "Database" or "Both" there, or from a CSV — for example the client's Clay table exported as CSV, which also lets every cell be compared with Clay's own result.`,
  people: () =>
    "In Clay, the Companies table writes up to four decision-makers per company into this table. Those steps are built in Phase 2; until then the columns are here so the whole table can be seen.",
  inboxes: () =>
    "In Clay, the Companies table writes each company's general inboxes (info@, office@ …) into this table. Those steps are built in Phase 2; until then the columns are here so the whole table can be seen.",
  ai_ark: () =>
    "People appear here as the run pulls them from AI Ark, and each one's outcome is worked out as they land. A queued run starts as soon as the enrichment worker picks it up.",
};
const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");

export default function ClayPage() {
  return (
    <Suspense fallback={null}>
      <ClayTab />
    </Suspense>
  );
}

function ClayTab() {
  const canView = useHasPermission("manager");
  const router = useRouter();
  const tableId = useSearchParams().get("t");
  const [tables, setTables] = useState<EnrichTableSummary[] | null>(null);
  const [worker, setWorker] = useState<WorkerState | null>(null);

  const loadTables = useCallback(() => {
    fetch("/api/enrich/tables")
      .then((r) => r.json())
      .then((j) => {
        setTables(j.tables ?? []);
        setWorker(j.worker ?? null);
      })
      .catch(() => setTables([]));
  }, []);

  useEffect(() => {
    if (canView) loadTables();
  }, [canView, loadTables]);

  useEffect(() => {
    if (!tables?.length || (tableId && tables.some((t) => t.id === tableId))) return;
    const first = tables.find((t) => t.kind === "companies") ?? tables[0];
    router.replace(`/leads/clay?t=${first.id}`);
  }, [tables, tableId, router]);

  const table = tables?.find((t) => t.id === tableId) ?? null;

  // While the open AI Ark run is still pulling, keep its progress in the run picker current.
  const pulling = table?.run && (table.run.status === "queued" || table.run.status === "running");
  useEffect(() => {
    if (!pulling) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") loadTables();
    }, 4_000);
    return () => clearInterval(t);
  }, [pulling, loadTables]);
  const clients = useMemo(() => {
    const seen = new Map<string, EnrichTableSummary>();
    for (const t of tables ?? []) if (!seen.has(t.client_tag)) seen.set(t.client_tag, t);
    return [...seen.values()];
  }, [tables]);
  // The client's AI Ark run tables, newest first (the route's order).
  const runTables = useMemo(
    () => (tables ?? []).filter((t) => t.kind === "ai_ark" && t.client_tag === table?.client_tag),
    [tables, table?.client_tag]
  );

  if (!canView) return <AccessDenied />;

  const missingKeys = Object.entries(worker?.info.keys ?? {})
    .filter(([, set]) => !set)
    .map(([k]) => KEY_LABELS[k] ?? k);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <Table2 className="size-5" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Clay</h1>
            <p className="text-[12.5px] text-muted-foreground">Clay&apos;s enrichment steps, run inside the lead database</p>
          </div>
        </div>
        {clients.length > 0 && (
          <Select
            value={table?.client_tag ?? ""}
            onValueChange={(tag) => {
              const t = tables?.find((x) => x.client_tag === tag && x.kind === "companies") ?? tables?.find((x) => x.client_tag === tag);
              if (t) router.replace(`/leads/clay?t=${t.id}`);
            }}
          >
            <SelectTrigger className="ml-2 h-9 w-[260px] rounded-full">
              <SelectValue placeholder="Choose a client" />
            </SelectTrigger>
            <SelectContent>
              {clients.map((t) => (
                <SelectItem key={t.client_tag} value={t.client_tag}>
                  {t.client_tag}
                  {t.client_name ? ` — ${t.client_name}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-2">
          <WorkerPill worker={worker} />
          {worker?.online &&
            missingKeys.map((k) => (
              <span
                key={k}
                title={`The worker has no ${k} key, so the ${k} columns show "Needs key" and their rows wait. Add the key to the worker's environment, then use Run → rows waiting on a key.`}
                className="flex items-center gap-1 rounded-full bg-[var(--warning)]/15 px-2.5 py-1 text-[11.5px] font-medium text-[var(--warning)]"
              >
                <KeyRound className="size-3" /> No {k} key
              </span>
            ))}
        </div>
      </div>

      {tables && tables.length === 0 && (
        <div className="rounded-2xl bg-card p-10 text-center shadow-ios">
          <p className="text-[15px] font-semibold">No Clay tables yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            A client&apos;s table is loaded from its Clay columns with <code>node scripts/enrich-seed-table.mjs &lt;spec.json&gt;</code>.
          </p>
        </div>
      )}

      {table && (
        <>
          <div className="flex items-center gap-1 border-b border-border/60">
            {KIND_TABS.map(({ kind, label }) => {
              // AI Ark: one table per run, newest first — the tab opens the newest.
              const runs = kind === "ai_ark" ? runTables : null;
              const t = runs ? runs[0] : tables?.find((x) => x.client_tag === table.client_tag && x.kind === kind);
              const active = runs ? table.kind === "ai_ark" : t?.id === table.id;
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={!t}
                  onClick={() => t && !active && router.replace(`/leads/clay?t=${t.id}`)}
                  title={t ? undefined : runs ? "No AI Ark runs yet: start one on the AI Ark tab" : "Built in Phase 2"}
                  className={cn(
                    "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition-colors",
                    active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                    !t && "cursor-not-allowed opacity-50 hover:text-muted-foreground"
                  )}
                >
                  {label}
                  {runs ? (
                    <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{runs.length ? fmt(runs.length) : "none"}</span>
                  ) : t ? (
                    <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{fmt(t.row_count)}</span>
                  ) : (
                    <span className="rounded-full bg-muted px-1.5 text-[10px] text-muted-foreground">Phase 2</span>
                  )}
                </button>
              );
            })}
            {table.kind === "ai_ark" && (
              <div className="mb-1 ml-auto flex items-center gap-2">
                <Select value={table.id} onValueChange={(id) => router.replace(`/leads/clay?t=${id}`)}>
                  <SelectTrigger className="h-8 w-[340px] rounded-full text-[12.5px]" aria-label="AI Ark run">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {runTables.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {runLabel(t)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={() => router.push(`/leads/ai-ark?client=${encodeURIComponent(table.client_tag)}`)}>
                  <UserSearch /> AI Ark tab
                </Button>
              </div>
            )}
          </div>
          {/* keyed: switching tables starts every filter, page and selection afresh */}
          <TableView key={table.id} table={table} onWorker={setWorker} onRowsChanged={loadTables} />
        </>
      )}
    </div>
  );
}

function TableView({
  table,
  onWorker,
  onRowsChanged,
}: {
  table: EnrichTableSummary;
  onWorker: (w: WorkerState | null) => void;
  onRowsChanged: () => void;
}) {
  const canDelete = useHasPermission("admin");
  // An AI Ark run's table: its rows come from AI Ark, never from a CSV.
  const isRun = table.kind === "ai_ark";
  const [detail, setDetail] = useState<TableDetail | null>(null);
  const [page, setPage] = useState<RowsPage | null>(null);
  const [shownQuery, setShownQuery] = useState<string | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const [size, setSize] = useState(50);
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [status, setStatus] = useState<RowStatus | "">("");
  const [filters, setFilters] = useState<GridFilter[]>([]);
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [showLater, setShowLater] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [openCell, setOpenCell] = useState<{ row: number; col: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setDq(q.trim());
      setPageNo(1);
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  // Columns, header counts, row totals and the worker's heartbeat.
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/enrich/table?id=${table.id}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((j: TableDetail & { error?: string }) => {
        if (j.error) throw new Error(j.error);
        setDetail(j);
        onWorker(j.worker);
      })
      .catch((e) => {
        if (e.name !== "AbortError") toast.error(e.message ?? "Could not load the table");
      });
    return () => ctl.abort();
  }, [table.id, onWorker, tick]);

  // One page of rows, filtered, searched and sorted by the server.
  const query = useMemo(() => {
    const sp = new URLSearchParams({ table: table.id, page: String(pageNo), size: String(size) });
    if (dq) sp.set("q", dq);
    if (status) sp.set("status", status);
    if (filters.length) sp.set("f", filters.map((f) => `${f.col}:${f.state}`).join(","));
    if (sort) sp.set("sort", `${sort.col}:${sort.dir}`);
    return sp.toString();
  }, [table.id, pageNo, size, dq, status, filters, sort]);

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/enrich/rows?${query}`, { signal: ctl.signal })
      .then((r) => r.json())
      .then((j: RowsPage & { error?: string }) => {
        if (j.error) throw new Error(j.error);
        setPage(j);
        setShownQuery(query);
      })
      .catch((e) => {
        if (e.name !== "AbortError") toast.error(e.message ?? "Could not load rows");
      });
    return () => ctl.abort();
  }, [query, tick]);

  // Live updates: every 2.5 s while rows are queued or running, else every 10 s.
  const busy = (detail?.statuses.queued ?? 0) + (detail?.statuses.running ?? 0) > 0;
  useEffect(() => {
    const t = setTimeout(() => {
      if (document.visibilityState === "visible") setTick((n) => n + 1);
    }, busy ? 2_500 : 10_000);
    return () => clearTimeout(t);
  }, [busy, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const run = useCallback(
    async (body: Record<string, unknown>, success?: (queued: number) => string) => {
      const res = await fetch("/api/enrich/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ table: table.id, ...body }),
      });
      const j = await res.json();
      if (!res.ok) {
        toast.error(j.error ?? "Could not queue the rows");
        return;
      }
      toast.success(
        (success?.(j.queued) ?? `${fmt(j.queued)} row${j.queued === 1 ? "" : "s"} queued`) +
          (j.skippedRunning ? ` (${fmt(j.skippedRunning)} running now were left alone)` : "")
      );
      refresh();
    },
    [table.id, refresh]
  );

  const removeSelected = async () => {
    if (!selected.size) return;
    if (!window.confirm(`Delete ${selected.size} row${selected.size === 1 ? "" : "s"} from this table? Their cells go too.`)) return;
    const res = await fetch("/api/enrich/rows", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ table: table.id, ids: [...selected] }),
    });
    const j = await res.json();
    if (!res.ok) return toast.error(j.error ?? "Delete failed");
    toast.success(`${fmt(j.deleted)} rows deleted`);
    setSelected(new Set());
    onRowsChanged();
    refresh();
  };

  const visible = (detail?.columns ?? []).filter((c) => !c.hidden);
  const laterCount = visible.filter((c) => c.phase > 1).length;
  // A table with nothing built yet always shows its columns: hiding them would leave nothing.
  const canHideLater = laterCount > 0 && laterCount < visible.length;
  const columns: EnrichColumn[] = visible.filter((c) => showLater || !canHideLater || c.phase === 1);
  const rowCount = detail?.table.row_count ?? table.row_count;
  const total = page?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const nameOf = (key: string) => detail?.columns.find((c) => c.key === key)?.name ?? key;
  const loadingRows = shownQuery !== query;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={isRun ? "Search name, title, company, email…" : "Search name, address, website…"}
            className="h-9 rounded-full pl-8 text-[13px]"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {STATUS_PILLS.map((p) => {
            const n = p.value ? detail?.statuses[p.value] ?? 0 : rowCount;
            if (p.value && !n && status !== p.value) return null;
            return (
              <button
                key={p.value || "all"}
                type="button"
                onClick={() => {
                  setStatus(p.value);
                  setPageNo(1);
                }}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                  status === p.value ? "bg-primary text-primary-foreground" : "bg-card text-foreground shadow-ios hover:bg-muted"
                )}
              >
                {p.value === "running" && n > 0 && <Loader2 className="size-3 animate-spin" />}
                {p.label}
                <span className={cn("tabular-nums", status === p.value ? "opacity-80" : "text-muted-foreground")}>{fmt(n)}</span>
              </button>
            );
          })}
        </div>
        {filters.map((f) => (
          <span key={`${f.col}:${f.state}`} className="flex items-center gap-1 rounded-full bg-primary/12 py-1 pl-3 pr-1.5 text-[12px] font-medium text-primary">
            {nameOf(f.col)}: {FILTER_LABELS[f.state] ?? f.state}
            <button
              type="button"
              aria-label="Remove filter"
              onClick={() => {
                setFilters((fs) => fs.filter((x) => x !== f));
                setPageNo(1);
              }}
              className="rounded-full p-0.5 hover:bg-primary/15"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        <div className="ml-auto flex items-center gap-2">
          {canHideLater && (
            <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              <IosToggle size="sm" checked={showLater} onCheckedChange={setShowLater} aria-label="Show steps from later phases" />
              Later steps ({laterCount})
            </label>
          )}
          <Button size="sm" variant="outline" onClick={refresh} aria-label="Refresh">
            <RefreshCw />
          </Button>
          {!isRun && (
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
              <Upload /> Import CSV
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm">
                <Play /> Run
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
                Rows go back to the worker. Paid answers are reused when their inputs have not changed.
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!selected.size} onClick={() => run({ scope: "rows", rows: [...selected] })}>
                <Play className="size-3.5" /> Run selected rows ({fmt(selected.size)})
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!detail?.statuses.error} onClick={() => run({ scope: "errors" })}>
                <RotateCcw className="size-3.5" /> Retry rows with errors ({fmt(detail?.statuses.error)})
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!detail?.statuses.waiting} onClick={() => run({ scope: "waiting" })}>
                <KeyRound className="size-3.5" /> Run rows waiting on a key ({fmt(detail?.statuses.waiting)})
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!rowCount}
                onClick={() => {
                  if (window.confirm(`Re-run all ${fmt(rowCount)} rows? Formulas are recomputed; paid answers whose inputs are unchanged are reused.`)) {
                    run({ scope: "all" });
                  }
                }}
              >
                <RefreshCw className="size-3.5" /> Re-run the whole table
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canDelete && selected.size > 0 && (
            <Button size="sm" variant="outline" className="text-destructive" onClick={removeSelected}>
              <Trash2 /> Delete {fmt(selected.size)}
            </Button>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-auto rounded-2xl bg-card shadow-ios">
        {!detail || !page ? (
          <div className="flex h-full min-h-[300px] items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            <ClayGrid
              columns={columns}
              rows={page.rows}
              counts={detail.counts}
              rowCount={rowCount}
              firstRowNumber={(page.page - 1) * page.size + 1}
              selected={selected}
              onToggleRow={(id, on) =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (on) n.add(id);
                  else n.delete(id);
                  return n;
                })
              }
              onToggleAll={(on) =>
                setSelected((s) => {
                  const n = new Set(s);
                  for (const r of page.rows) {
                    if (on) n.add(r.id);
                    else n.delete(r.id);
                  }
                  return n;
                })
              }
              activeCell={openCell}
              onCellClick={(row, col) => setOpenCell({ row, col })}
              sort={sort}
              onSort={(s) => {
                setSort(s);
                setPageNo(1);
              }}
              filters={filters}
              onFilter={(f) => {
                setFilters((fs) => [...fs.filter((x) => x.col !== f.col), f]);
                setPageNo(1);
              }}
              onRunColumn={(col, only) =>
                run(
                  { scope: "column", column: col.key, only },
                  (n) => `${col.name}: ${fmt(n)} row${n === 1 ? "" : "s"} queued${only ? " (errors only)" : ""}`
                )
              }
              canRun
              loading={loadingRows}
            />
            {page.rows.length === 0 && rowCount > 0 && (
              <div className="p-10 text-center text-[13px] text-muted-foreground">No rows match these filters.</div>
            )}
            {rowCount === 0 && (
              <div className="sticky left-0 flex max-w-[calc(100vw-22rem)] flex-col items-center gap-3 p-10 text-center">
                <p className="text-[15px] font-semibold">No rows yet</p>
                <p className="max-w-lg text-[13px] leading-relaxed text-muted-foreground">{EMPTY_NOTE[table.kind](table.client_tag)}</p>
                {!isRun && (
                  <Button size="sm" variant="outline" onClick={() => setImportOpen(true)}>
                    <Upload /> Import CSV
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {page && rowCount > 0 && (
        <div className="flex items-center gap-3 text-[12.5px] text-muted-foreground">
          <span>
            {total ? `${fmt((page.page - 1) * page.size + 1)}–${fmt(Math.min(total, page.page * page.size))} of ${fmt(total)}` : "0"} rows
            {total !== rowCount && ` (${fmt(rowCount)} in the table)`}
          </span>
          <Select
            value={String(size)}
            onValueChange={(v) => {
              setSize(Number(v));
              setPageNo(1);
            }}
          >
            <SelectTrigger className="h-8 w-[140px] rounded-full text-[12.5px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[50, 100, 200].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} per page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-1">
            <Button size="icon-xs" variant="outline" disabled={pageNo <= 1} onClick={() => setPageNo((p) => p - 1)} aria-label="Previous page">
              <ChevronLeft />
            </Button>
            <span className="px-2 tabular-nums">
              Page {fmt(pageNo)} of {fmt(pages)}
            </span>
            <Button size="icon-xs" variant="outline" disabled={pageNo >= pages} onClick={() => setPageNo((p) => p + 1)} aria-label="Next page">
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}

      <CellPanel
        target={openCell}
        onClose={() => setOpenCell(null)}
        canRun
        onRun={(rowId, column) =>
          run({ scope: "rows", rows: [rowId], column, force: true }, () =>
            column ? `${nameOf(column)} queued for this row` : "Row queued — every step runs again"
          )
        }
      />
      {detail && (
        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          tableId={table.id}
          tableLabel={`${table.client_tag} · ${table.name}`}
          columns={detail.columns}
          onDone={() => {
            onRowsChanged();
            refresh();
          }}
        />
      )}
    </>
  );
}

function WorkerPill({ worker }: { worker: WorkerState | null }) {
  if (!worker) {
    return (
      <span
        title="No enrichment worker has run yet. Start one with: npm run enrich-worker"
        className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[12px] font-medium shadow-ios"
      >
        <span className="size-2 rounded-full bg-muted-foreground/50" /> Worker never started
      </span>
    );
  }
  const info = worker.info;
  return (
    <span
      title={
        worker.online
          ? `Last heartbeat ${worker.seconds_ago}s ago · ${info.processed ?? 0} rows done · ${info.calls ?? 0} provider calls since it started`
          : `No heartbeat for ${worker.seconds_ago}s. Start it with: npm run enrich-worker`
      }
      className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[12px] font-medium shadow-ios"
    >
      <span className={cn("size-2 rounded-full", worker.online ? "bg-[var(--success)]" : "bg-destructive")} />
      {worker.online ? `Worker running${info.in_flight ? ` · ${info.in_flight} in flight` : ""}` : "Worker offline"}
    </span>
  );
}
