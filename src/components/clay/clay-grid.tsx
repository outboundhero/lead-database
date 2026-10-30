"use client";

import { ArrowDown, ArrowUp, ChevronDown, Filter, Play, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ColumnCounts, EnrichColumn, GridRow } from "@/lib/enrich/types";
import { ClayCell, ColumnIcon, HeaderStats, KIND_LABEL } from "./clay-cell";

// The Clay-like grid: one row per company, one column per Clay column, sticky
// header and first column, a menu per column (sort, filter, re-run). Paging,
// sorting and filtering all happen on the server; this only draws one page.

export interface GridFilter {
  col: string;
  state: string;
}

export const FILTER_LABELS: Record<string, string> = {
  true: "Only true",
  false: "Only false",
  done: "Has a value",
  empty: "No result",
  skipped: "Run condition not met",
  error: "Errors",
  needs_key: "Needs key",
  none: "Not run yet",
};

const ROW_HEAD = 64; // checkbox + row number column

export function columnWidth(col: EnrichColumn): number {
  if (col.key === "company") return 230;
  if (col.data_type === "boolean") return 170;
  if (col.phase > 1) return 190;
  if (col.data_type === "url") return 220;
  if (col.kind === "action") return 190;
  if (col.key === "address") return 260;
  return 175;
}

interface ClayGridProps {
  columns: EnrichColumn[];
  rows: GridRow[];
  counts: Record<string, ColumnCounts>;
  rowCount: number;
  firstRowNumber: number;
  selected: Set<number>;
  onToggleRow: (id: number, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  activeCell: { row: number; col: string } | null;
  onCellClick: (row: number, col: string) => void;
  sort: { col: string; dir: "asc" | "desc" } | null;
  onSort: (sort: { col: string; dir: "asc" | "desc" } | null) => void;
  filters: GridFilter[];
  onFilter: (f: GridFilter) => void;
  onRunColumn: (col: EnrichColumn, only?: string) => void;
  canRun: boolean;
  loading: boolean;
}

export function ClayGrid(props: ClayGridProps) {
  const { columns, rows, selected } = props;
  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someOnPage = rows.some((r) => selected.has(r.id));
  const width = ROW_HEAD + columns.reduce((s, c) => s + columnWidth(c), 0);

  return (
    <table className="border-separate border-spacing-0 text-[12.5px]" style={{ width, tableLayout: "fixed" }}>
      <colgroup>
        <col style={{ width: ROW_HEAD }} />
        {columns.map((c) => (
          <col key={c.key} style={{ width: columnWidth(c) }} />
        ))}
      </colgroup>
      <thead>
        <tr>
          <th
            className="sticky left-0 top-0 z-30 border-b border-r border-border/70 bg-muted px-2 text-left align-middle"
            style={{ height: 52 }}
          >
            <Checkbox
              checked={allOnPage ? true : someOnPage ? "indeterminate" : false}
              onCheckedChange={(v) => props.onToggleAll(v === true)}
              aria-label="Select every row on this page"
            />
          </th>
          {columns.map((col, i) => (
            <HeaderCell key={col.key} col={col} sticky={i === 0} {...props} />
          ))}
        </tr>
      </thead>
      <tbody className={cn(props.loading && "opacity-70 transition-opacity")}>
        {rows.map((row, ri) => {
          const isSel = selected.has(row.id);
          return (
            <tr key={row.id} className="group">
              <td
                className={cn(
                  "sticky left-0 z-10 border-b border-r border-border/50 px-2 align-middle",
                  isSel ? "bg-accent" : "bg-card group-hover:bg-muted"
                )}
                style={{ height: 36 }}
              >
                <div className="flex items-center gap-2">
                  <Checkbox checked={isSel} onCheckedChange={(v) => props.onToggleRow(row.id, v === true)} aria-label={`Select row ${props.firstRowNumber + ri}`} />
                  <span className="tabular-nums text-[11px] text-muted-foreground">{props.firstRowNumber + ri}</span>
                </div>
              </td>
              {columns.map((col, i) => {
                const active = props.activeCell?.row === row.id && props.activeCell?.col === col.key;
                return (
                  <td
                    key={col.key}
                    onClick={() => props.onCellClick(row.id, col.key)}
                    className={cn(
                      "cursor-pointer border-b border-r border-border/50 px-2.5 align-middle",
                      i === 0 && "sticky z-10 font-medium",
                      i === 0 ? (isSel ? "bg-accent" : "bg-card group-hover:bg-muted") : isSel ? "bg-accent/60" : "group-hover:bg-muted/60",
                      active && "outline outline-2 -outline-offset-2 outline-primary"
                    )}
                    style={i === 0 ? { left: ROW_HEAD, height: 36 } : { height: 36 }}
                  >
                    <div className="min-w-0 overflow-hidden whitespace-nowrap">
                      <ClayCell col={col} cell={row.cells[col.key]} rowStatus={row.run_status} reference={row.reference?.[col.key]} />
                    </div>
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function HeaderCell({ col, sticky, counts, rowCount, sort, onSort, filters, onFilter, onRunColumn, canRun }: ClayGridProps & { col: EnrichColumn; sticky: boolean }) {
  const sorted = sort?.col === col.key ? sort.dir : null;
  const filtered = filters.some((f) => f.col === col.key);
  const states =
    col.phase > 1
      ? []
      : col.data_type === "boolean"
        ? ["true", "false", "error", "none"]
        : col.kind === "input"
          ? ["done", "none"]
          : col.kind === "action"
            ? ["done", "empty", "skipped", "needs_key", "error", "none"]
            : ["done", "empty", "error", "none"];
  return (
    <th
      className={cn(
        "top-0 border-b border-r border-border/70 bg-muted px-0 text-left align-top font-normal",
        sticky ? "sticky z-30" : "sticky z-20",
        col.phase > 1 && "bg-muted/70"
      )}
      style={sticky ? { left: ROW_HEAD } : undefined}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={col.description ?? col.name}
            className="flex h-[52px] w-full flex-col justify-center gap-0.5 px-2.5 text-left outline-none hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
          >
            <span className="flex w-full min-w-0 items-center gap-1.5">
              <ColumnIcon col={col} />
              <span className={cn("truncate text-[12.5px] font-semibold", col.phase > 1 && "text-muted-foreground")}>{col.name}</span>
              {sorted === "asc" && <ArrowUp className="size-3 shrink-0 text-primary" />}
              {sorted === "desc" && <ArrowDown className="size-3 shrink-0 text-primary" />}
              {filtered && <Filter className="size-3 shrink-0 text-primary" />}
              <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground/60" />
            </span>
            <span className="flex min-w-0 text-[10.5px] text-muted-foreground">
              <HeaderStats col={col} counts={counts[col.key]} rows={rowCount} />
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="space-y-1">
            <span className="flex items-center gap-1.5">
              <ColumnIcon col={col} />
              <span className="truncate">{col.name}</span>
            </span>
            <span className="block text-[11px] font-normal text-muted-foreground">
              {KIND_LABEL[col.kind]}
              {col.provider ? ` · ${col.provider}` : ""}
              {col.phase > 1 ? ` · Phase ${col.phase}` : ""}
            </span>
            {col.description && <span className="block text-[11px] font-normal leading-snug text-muted-foreground">{col.description}</span>}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onSort({ col: col.key, dir: "asc" })}>
            <ArrowUp className="size-3.5" /> Sort A → Z
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onSort({ col: col.key, dir: "desc" })}>
            <ArrowDown className="size-3.5" /> Sort Z → A
          </DropdownMenuItem>
          {sorted && <DropdownMenuItem onClick={() => onSort(null)}>Clear sort</DropdownMenuItem>}
          {states.length > 0 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Filter className="size-3.5" /> Filter rows
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {states.map((s) => (
                  <DropdownMenuItem key={s} onClick={() => onFilter({ col: col.key, state: s })}>
                    {FILTER_LABELS[s]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {canRun && col.kind !== "input" && col.phase === 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onRunColumn(col)}>
                <Play className="size-3.5" /> Re-run this column for every row
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRunColumn(col, "error")}>
                <RotateCcw className="size-3.5" /> Retry this column&apos;s errors
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </th>
  );
}
