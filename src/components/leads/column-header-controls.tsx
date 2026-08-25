"use client";

import * as React from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Filter, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { FilterState } from "@/types/filters";

// Header controls for the leads table: sorting and the spreadsheet-style value
// filter. Both are SERVER-side over the whole filtered set.
//
// Sorting used to be TanStack's getSortedRowModel() over the ~50 rows already
// loaded, so "sort by state" only reordered the current page and the first row
// of page 2 could easily sort before the last row of page 1. The table now runs
// manualSorting and the header drives the same p_sort_by the RPC already took.

export const BLANK = "__BLANK__";

// Columns with no useful value picker: near-unique per row.
const NOT_FILTERABLE = new Set(["first_name", "last_name", "email", "main_campaigns"]);

export interface ColumnControls {
  sortBy: string;
  sortDir: "asc" | "desc";
  setSort: (column: string, dir: "asc" | "desc") => void;
  columnFilters: Record<string, string[]>;
  setColumnFilter: (column: string, values: string[]) => void;
  /** Current filters, so a dropdown offers only reachable values. */
  filters: FilterState;
}

const Ctx = React.createContext<ColumnControls | null>(null);
export const ColumnControlsProvider = Ctx.Provider;

interface ValueRow { value: string; count: number }

export function SortHeader({ column, label }: { column: { id: string }; label: string }) {
  const ctx = React.useContext(Ctx);
  const id = column.id;
  const active = ctx?.sortBy === id;
  const dir = active ? ctx?.sortDir : undefined;

  return (
    <div className="flex items-center gap-0.5">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-3 h-8 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        onClick={() => ctx?.setSort(id, active && dir === "asc" ? "desc" : "asc")}
        title={`Sort every matching lead by ${label}`}
      >
        {label}
        {dir === "asc" ? (
          <ArrowUp className="ml-1 size-3" strokeWidth={2.5} />
        ) : dir === "desc" ? (
          <ArrowDown className="ml-1 size-3" strokeWidth={2.5} />
        ) : (
          <ArrowUpDown className="ml-1 size-3 opacity-50" strokeWidth={2} />
        )}
      </Button>
      {!NOT_FILTERABLE.has(id) && <ColumnFilterButton column={id} label={label} />}
    </div>
  );
}

function ColumnFilterButton({ column, label }: { column: string; label: string }) {
  const ctx = React.useContext(Ctx);
  const applied = ctx?.columnFilters?.[column] ?? [];
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [rows, setRows] = React.useState<ValueRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [distinctTotal, setDistinctTotal] = React.useState(0);
  const [sampled, setSampled] = React.useState(false);
  const [picked, setPicked] = React.useState<Set<string>>(new Set());

  // The list is COMPLETE when the scan wasn't capped and every distinct value
  // came back. That decides the interaction model below.
  const complete = !sampled && distinctTotal > 0 && rows.length >= distinctTotal;

  const load = React.useCallback(
    async (term: string) => {
      if (!ctx) return;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/leads/column-values", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filters: ctx.filters, column, search: term }),
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error ?? "Couldn't load values");
        setRows(d.values ?? []);
        setDistinctTotal(d.distinctTotal ?? 0);
        setSampled(!!d.sampled);
        const isComplete = !d.sampled && (d.values ?? []).length >= (d.distinctTotal ?? 0);
        // Already-applied selection wins. Otherwise: a COMPLETE list starts
        // fully ticked, so unticking one value reads as "hide this" like a
        // spreadsheet. A PARTIAL list starts empty — starting it "all ticked"
        // would imply the unlisted values are ticked too, and applying would
        // silently drop every value that didn't fit in the top 200.
        setPicked(new Set(applied.length ? applied : isComplete ? (d.values ?? []).map((v: ValueRow) => v.value) : []));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't load values");
        setRows([]);
      } finally {
        setLoading(false);
      }
    },
    // `applied` is read at call time; adding it here would refetch on every apply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctx, column]
  );

  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => load(search), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [open, search, load]);

  const toggle = (v: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });

  function apply() {
    // Every value ticked on a complete list == no constraint. Storing all 153
    // states would filter nothing while making the table look filtered.
    const all = rows.map((r) => r.value);
    const keep = complete && all.every((v) => picked.has(v)) ? [] : [...picked];
    ctx?.setColumnFilter(column, keep);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Filter by ${label}`}
          title={applied.length ? `${label}: ${applied.length} value(s) kept` : `Filter by ${label}`}
          className={`grid size-5 shrink-0 place-items-center rounded transition-colors hover:bg-muted ${
            applied.length ? "text-primary" : "text-muted-foreground/50"
          }`}
        >
          <Filter className="size-3" strokeWidth={2.5} fill={applied.length ? "currentColor" : "none"} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b p-2">
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${label.toLowerCase()}…`}
            className="h-8 text-xs"
          />
        </div>

        {loading ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Loading values…
          </div>
        ) : error ? (
          <p className="p-4 text-xs text-destructive">{error}</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">No values in the current view.</p>
        ) : (
          <>
            <div className="flex items-center justify-between border-b px-2 py-1.5 text-[11px]">
              <button className="text-primary hover:underline" onClick={() => setPicked(new Set(rows.map((r) => r.value)))}>
                Select all
              </button>
              <button className="text-primary hover:underline" onClick={() => setPicked(new Set())}>
                Clear
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto p-1">
              {rows.map((r) => (
                <label
                  key={r.value}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/60"
                >
                  <Checkbox checked={picked.has(r.value)} onCheckedChange={() => toggle(r.value)} />
                  <span className="flex-1 truncate">
                    {r.value === BLANK ? <span className="italic text-muted-foreground">(blank)</span> : r.value}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{r.count.toLocaleString()}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {/* Never let a capped list look like the whole story. */}
        {!loading && !error && rows.length > 0 && !complete && (
          <p className="border-t px-3 py-1.5 text-[10px] leading-snug text-muted-foreground">
            Showing the {rows.length.toLocaleString()} most common of{" "}
            {distinctTotal.toLocaleString()}
            {sampled ? "+" : ""} values{sampled ? ", counted from a sample of this view" : ""}. Only ticked
            values are kept — search to find others.
          </p>
        )}

        <div className="flex items-center justify-between gap-2 border-t p-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            disabled={!applied.length}
            onClick={() => { ctx?.setColumnFilter(column, []); setOpen(false); }}
          >
            Remove filter
          </Button>
          <Button size="sm" className="h-7 text-xs" onClick={apply} disabled={loading || !!error}>
            Apply
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
