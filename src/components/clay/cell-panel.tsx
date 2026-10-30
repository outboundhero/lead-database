"use client";

import { useEffect, useState } from "react";
import { Loader2, Play, RotateCcw } from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { withNames, type CellDetail, type CellStatus } from "@/lib/enrich/types";
import { ColumnIcon, KIND_LABEL } from "./clay-cell";

// The panel a cell click opens: what the cell holds and why — Clay's formula
// or run condition for the column (with column names, as Clay shows them), the
// values it read, the client's own Clay value when one was imported, and every
// provider call made for it.

const STATUS: Record<CellStatus, { label: string; variant: "success" | "secondary" | "warning" | "destructive" | "tinted" }> = {
  done: { label: "Has a value", variant: "success" },
  empty: { label: "No result", variant: "secondary" },
  skipped: { label: "Run condition not met", variant: "secondary" },
  error: { label: "Error", variant: "destructive" },
  needs_key: { label: "Needs key", variant: "warning" },
  running: { label: "Running", variant: "tinted" },
};

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-1.5", className)}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Code({ text, limit = 700 }: { text: string; limit?: number }) {
  const [open, setOpen] = useState(false);
  const long = text.length > limit;
  return (
    <div className="rounded-xl bg-muted/70 p-2.5">
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">
        {open || !long ? text : `${text.slice(0, limit)}…`}
      </pre>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-[11px] font-medium text-primary">
          {open ? "Show less" : `Show all ${text.length.toLocaleString("en-US")} characters`}
        </button>
      )}
    </div>
  );
}

const pretty = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

export function CellPanel({
  target,
  onClose,
  onRun,
  canRun,
}: {
  target: { row: number; col: string } | null;
  onClose: () => void;
  onRun: (rowId: number, column: string | null) => Promise<void>;
  canRun: boolean;
}) {
  const [detail, setDetail] = useState<CellDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cell" | "row" | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!target) return;
    const ctl = new AbortController();
    setError(null);
    fetch(`/api/enrich/cell?row=${target.row}&col=${encodeURIComponent(target.col)}`, { signal: ctl.signal })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load the cell");
        setDetail(j);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => ctl.abort();
  }, [target, tick]);

  // While the row is being worked on, refresh the panel with it.
  useEffect(() => {
    if (!target || !detail || (detail.row.run_status !== "queued" && detail.row.run_status !== "running")) return;
    const t = setTimeout(() => setTick((n) => n + 1), 2_500);
    return () => clearTimeout(t);
  }, [target, detail]);

  const shown = detail && target && detail.column.key === target.col && detail.row.id === target.row ? detail : null;
  const col = shown?.column;
  const names = shown?.columnNames ?? {};
  const status = shown?.cell?.status;

  const run = async (scope: "cell" | "row") => {
    if (!shown) return;
    setBusy(scope);
    try {
      await onRun(shown.row.id, scope === "cell" ? shown.column.key : null);
      setTick((n) => n + 1);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="gap-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border/60 pr-12">
          <SheetTitle className="flex items-center gap-2">
            {col && <ColumnIcon col={col} className="size-4" />}
            <span className="truncate">{col?.name ?? "Cell"}</span>
          </SheetTitle>
          <SheetDescription>
            {col
              ? [
                  KIND_LABEL[col.kind],
                  col.provider && col.provider !== KIND_LABEL[col.kind] ? col.provider : null,
                  shown?.row.title,
                  shown?.row.source_label ? `from ${shown.row.source_label}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : error ?? "Loading…"}
          </SheetDescription>
        </SheetHeader>

        {!shown ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            {error ? <span className="text-destructive">{error}</span> : <Loader2 className="size-5 animate-spin" />}
          </div>
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <Section title="Value">
              <div className="flex flex-wrap items-center gap-2">
                {status ? (
                  <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>
                ) : col!.phase > 1 ? (
                  <Badge variant="secondary">Phase {col!.phase} — not built yet</Badge>
                ) : (
                  <Badge variant="secondary">{shown.row.run_status === "done" ? "Not set" : "Queued"}</Badge>
                )}
                {shown.cell && shown.cell.runs > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {shown.cell.runs} provider call{shown.cell.runs === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {shown.cell?.value !== null && shown.cell?.value !== undefined && <Code text={pretty(shown.cell.value)} limit={1500} />}
              {shown.cell?.note && <p className="text-[12.5px] text-muted-foreground">{shown.cell.note}</p>}
              {shown.row.last_error && shown.row.run_status !== "done" && (
                <p className="text-[12.5px] text-destructive">Row: {shown.row.last_error}</p>
              )}
            </Section>

            {shown.row.reference !== null && shown.row.reference !== undefined && (
              <Section title="Clay had">
                <Code text={shown.row.reference || "(empty)"} limit={600} />
              </Section>
            )}

            {col!.description && (
              <Section title="What this column does">
                <p className="text-[13px] leading-relaxed">{col!.description}</p>
              </Section>
            )}

            {shown.reads.length > 0 && (
              <Section title="Reads">
                <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
                  {shown.reads.map((r) => (
                    <div key={r.key} className="flex items-baseline gap-3 px-2.5 py-1.5 text-[12px]">
                      <span className="w-40 shrink-0 truncate text-muted-foreground">{r.name}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {r.status === "done" ? r.display : <span className="italic text-muted-foreground">{r.status === "skipped" ? "Run condition not met" : r.status ?? "empty"}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {col!.run_if && (
              <Section title={col!.clay_field_id ? "Run condition (Clay's, verbatim)" : "Run condition"}>
                <Code text={withNames(col!.run_if, names)} />
              </Section>
            )}
            {col!.formula && (
              <Section title={col!.clay_field_id ? "Formula (Clay's, verbatim)" : "Formula"}>
                <Code text={withNames(col!.formula, names)} />
              </Section>
            )}
            {col!.waterfall && (
              <Section title={`Waterfall — first non-empty of ${col!.waterfall.length} steps`}>
                <div className="space-y-1.5">
                  {col!.waterfall.map((s, i) => (
                    <div key={i} className="flex gap-2">
                      <span className="mt-2.5 w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{i + 1}</span>
                      <div className="min-w-0 flex-1">
                        <Code text={withNames(s, names)} limit={300} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            {col!.kind === "action" && Object.keys(col!.inputs ?? {}).length > 0 && (
              <Section title="Inputs">
                {Object.entries(col!.inputs).map(([k, v]) => (
                  <div key={k} className="space-y-1">
                    <span className="text-[11px] font-medium">{k}</span>
                    <Code text={withNames(v, names)} limit={400} />
                  </div>
                ))}
              </Section>
            )}

            {shown.runs.length > 0 && (
              <Section title="Provider calls">
                <div className="space-y-2">
                  {shown.runs.map((r) => (
                    <details key={r.id} className="rounded-xl border border-border/60 px-2.5 py-1.5 text-[12px]">
                      <summary className="flex cursor-pointer items-center gap-2">
                        <span className={cn("font-medium", r.status === "error" ? "text-destructive" : r.status === "done" ? "text-[var(--success)]" : "text-muted-foreground")}>
                          {r.status}
                        </span>
                        <span className="text-muted-foreground">
                          {r.provider}
                          {r.http_status ? ` · HTTP ${r.http_status}` : ""}
                          {r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)}s` : ""}
                        </span>
                        <span className="ml-auto text-[11px] text-muted-foreground">{new Date(r.started_at).toLocaleString()}</span>
                      </summary>
                      <div className="mt-2 space-y-2">
                        {r.error && <p className="text-destructive">{r.error}</p>}
                        <Code text={pretty({ request: r.request, response: r.response })} limit={1200} />
                      </div>
                    </details>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}

        {shown && canRun && col!.phase === 1 && (
          <div className="flex gap-2 border-t border-border/60 p-3">
            {col!.kind !== "input" && (
              <Button size="sm" variant="tinted" disabled={!!busy || shown.row.run_status === "running"} onClick={() => run("cell")}>
                {busy === "cell" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                Re-run this cell
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={!!busy || shown.row.run_status === "running"} onClick={() => run("row")}>
              {busy === "row" ? <Loader2 className="animate-spin" /> : <Play />}
              Re-run row
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
