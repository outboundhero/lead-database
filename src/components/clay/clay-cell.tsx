"use client";

import {
  AlertTriangle,
  ArrowRightToLine,
  Ban,
  Building2,
  Check,
  Clock,
  Globe,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  Mail,
  MapPin,
  ScanSearch,
  Sigma,
  Sparkles,
  UserSearch,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ColumnCounts, EnrichColumn, GridCell, RowStatus } from "@/lib/enrich/types";

// How one Clay-tab cell and column header look. The states follow Clay's own:
// a value, "Run condition not met", no result, an error, plus two of ours —
// "Needs key" (the worker has no key for that provider yet) and later-phase
// columns that are shown but not built.

export function ColumnIcon({ col, className }: { col: EnrichColumn; className?: string }) {
  const cls = cn("size-3.5 shrink-0", className);
  if (col.kind === "input") return <MapPin className={cn(cls, "text-[oklch(0.62_0.19_25)]")} strokeWidth={2} />;
  if (col.kind === "formula") return <Sigma className={cn(cls, "text-[oklch(0.52_0.21_290)]")} strokeWidth={2} />;
  if (col.kind === "waterfall") return <Layers className={cn(cls, "text-[oklch(0.6_0.2_310)]")} strokeWidth={2} />;
  const name = col.name.toLowerCase();
  switch (col.action) {
    case "check_url":
      return <Globe className={cn(cls, "text-[oklch(0.6_0.16_200)]")} strokeWidth={2} />;
    case "normalize_url":
      return <Link2 className={cn(cls, "text-[oklch(0.6_0.16_200)]")} strokeWidth={2} />;
    case "lookup_key":
      return <ScanSearch className={cn(cls, "text-[oklch(0.7_0.17_160)]")} strokeWidth={2} />;
    case "domain_from_name":
      return <Building2 className={cn(cls, "text-[oklch(0.78_0.175_65)]")} strokeWidth={2} />;
    case "ai_web":
      return <Sparkles className={cn(cls, "text-primary")} strokeWidth={2} />;
    case "lead_lookup":
      return <ScanSearch className={cn(cls, "text-[oklch(0.7_0.17_160)]")} strokeWidth={2} />;
    case "client_area":
      return <MapPin className={cn(cls, "text-[oklch(0.7_0.17_160)]")} strokeWidth={2} />;
    case "client_exclusions":
      return <Ban className={cn(cls, "text-[oklch(0.7_0.17_160)]")} strokeWidth={2} />;
  }
  if (name.includes("write to")) return <ArrowRightToLine className={cn(cls, "text-muted-foreground")} strokeWidth={2} />;
  if (name.includes("claygent") || name.includes("location/company")) return <Sparkles className={cn(cls, "text-muted-foreground")} strokeWidth={2} />;
  if (name.includes("email") || name.includes("findymail") || name.includes("anymail") || name.includes("icypeas"))
    return <Mail className={cn(cls, "text-muted-foreground")} strokeWidth={2} />;
  if (name.includes("name check")) return <Sigma className={cn(cls, "text-muted-foreground")} strokeWidth={2} />;
  return <UserSearch className={cn(cls, "text-muted-foreground")} strokeWidth={2} />;
}

export const KIND_LABEL: Record<EnrichColumn["kind"], string> = {
  input: "Input",
  formula: "Formula",
  waterfall: "Waterfall",
  action: "Enrichment",
};

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");

/** The small count line under a column name. */
export function HeaderStats({ col, counts, rows }: { col: EnrichColumn; counts?: ColumnCounts; rows: number }) {
  if (col.phase > 1) return <span className="text-muted-foreground/60">Phase {col.phase} · not built yet</span>;
  const c = counts ?? {};
  const parts: React.ReactNode[] = [];
  if (col.data_type === "boolean") {
    if (c.true) parts.push(<span key="t" className="text-[var(--success)]">✓ {fmt(c.true)}</span>);
    if (c.false) parts.push(<span key="f" className="text-destructive/80">✕ {fmt(c.false)}</span>);
  } else if (col.kind === "input") {
    parts.push(<span key="d">{fmt(c.done)} of {fmt(rows)}</span>);
  } else {
    if (c.done) parts.push(<span key="d" className="text-[var(--success)]">{fmt(c.done)} found</span>);
    if (c.empty && col.kind === "action") parts.push(<span key="e">{fmt(c.empty)} none</span>);
    if (c.skipped) parts.push(<span key="s">{fmt(c.skipped)} skipped</span>);
  }
  if (c.needs_key) parts.push(<span key="k" className="text-[var(--warning)]">{fmt(c.needs_key)} need key</span>);
  if (c.error) parts.push(<span key="x" className="text-destructive">{fmt(c.error)} error{c.error === 1 ? "" : "s"}</span>);
  if (c.running) parts.push(<span key="r" className="text-primary">{fmt(c.running)} running</span>);
  if (!parts.length) return <span className="text-muted-foreground/60">{rows ? "—" : "No rows"}</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate">
      {parts.flatMap((p, i) => (i ? [<span key={`sep${i}`} className="text-muted-foreground/40">·</span>, p] : [p]))}
    </span>
  );
}

/** true / false when the cell can be compared with the client's own Clay value; null when it cannot. */
export function sameAsClay(col: EnrichColumn, cell: GridCell | undefined, reference: string | undefined): boolean | null {
  if (reference === undefined || reference === null || col.kind === "action" || col.phase > 1) return null;
  const ref = String(reference).trim().toLowerCase();
  if (col.data_type === "boolean") {
    if (ref !== "true" && ref !== "false") return null;
    return cell?.s === "done" && String(cell.v) === ref;
  }
  const ours = cell?.s === "done" ? String(cell.v ?? cell.d ?? "").trim().toLowerCase() : "";
  return ours === ref;
}

function Muted({ icon: Icon, children, spin, className }: { icon?: typeof Clock; children: React.ReactNode; spin?: boolean; className?: string }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1 text-muted-foreground", className)}>
      {Icon && <Icon className={cn("size-3 shrink-0", spin && "animate-spin")} strokeWidth={2} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

export function ClayCell({
  col,
  cell,
  rowStatus,
  reference,
}: {
  col: EnrichColumn;
  cell: GridCell | undefined;
  rowStatus: RowStatus;
  reference?: string;
}) {
  if (col.phase > 1) return <span className="text-[11px] italic text-muted-foreground/40">Phase {col.phase}</span>;
  if (!cell) {
    if (rowStatus === "queued") return <Muted icon={Clock} className="opacity-60">Queued</Muted>;
    if (rowStatus === "running") return <Muted icon={Loader2} spin className="text-primary">Running</Muted>;
    return <span className="text-muted-foreground/40">—</span>;
  }
  const stale = (rowStatus === "queued" || rowStatus === "running") && cell.s !== "running";
  const clay = sameAsClay(col, cell, reference);
  return (
    <span className={cn("relative flex min-w-0 items-center", stale && "opacity-55")}>
      <CellValue col={col} cell={cell} />
      {clay === false && (
        <span
          title={`Differs from Clay — Clay had: ${reference || "(empty)"}`}
          className="absolute -right-1.5 -top-1 size-1.5 rounded-full bg-[var(--warning)]"
        />
      )}
    </span>
  );
}

function CellValue({ col, cell }: { col: EnrichColumn; cell: GridCell }) {
  switch (cell.s) {
    case "running":
      return <Muted icon={Loader2} spin className="text-primary">Running…</Muted>;
    case "skipped":
      return <Muted icon={Ban} className="opacity-70">Run condition not met</Muted>;
    case "needs_key":
      return <Muted icon={KeyRound} className="text-[var(--warning)]">Needs key</Muted>;
    case "error":
      return <Muted icon={AlertTriangle} className="text-destructive">{cell.n ? `Error · ${cell.n}` : "Error"}</Muted>;
    case "empty":
      return col.kind === "action" ? <Muted className="italic opacity-70">No result</Muted> : <span />;
  }
  if (cell.v === true || cell.v === false) {
    // An action may word its answer ("Inside", "Can't tell"); a formula's stays true / false.
    const word = cell.d && cell.d !== "true" && cell.d !== "false" ? cell.d : String(cell.v);
    return cell.v ? (
      <span className="flex items-center gap-1 font-medium text-[var(--success)]">
        <Check className="size-3.5" strokeWidth={2.5} />
        {word}
      </span>
    ) : (
      <span className="flex items-center gap-1 font-medium text-destructive/85">
        <X className="size-3.5" strokeWidth={2.5} />
        {word}
      </span>
    );
  }
  if (col.action === "check_url") {
    const ok = cell.d === "Valid";
    return (
      <span className={cn("flex items-center gap-1.5 font-medium", ok ? "text-[var(--success)]" : "text-destructive/85")}>
        <span className={cn("size-1.5 rounded-full", ok ? "bg-[var(--success)]" : "bg-destructive")} />
        {cell.d}
      </span>
    );
  }
  if (col.action === "lookup_key") return <span className="font-medium text-[var(--warning)]">{cell.d}</span>;
  const text = cell.d ?? "";
  const looksLikeUrl = col.data_type === "url" || /^https?:\/\//i.test(text);
  return <span className={cn("truncate", looksLikeUrl && "text-primary")}>{text}</span>;
}
