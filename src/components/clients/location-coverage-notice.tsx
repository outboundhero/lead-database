"use client";

import * as React from "react";
import { MapPin, X, Copy, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

// Per-location lead coverage for the selected client.
//
// Opens by itself when the client changes and there are under-stocked areas,
// then DOES NOT disappear when dismissed: it collapses to a pill that reopens
// it. Closing a modal must not be the only chance an operator gets to see which
// places need scraping.
//
// Scope is the client's include (preferred) locations only — a place the client
// excludes needs no leads.

export interface CoverageRow {
  label: string;
  kind: "city" | "state";
  country: string;
  state: string | null;
  city: string | null;
  available: number;
  /** false = the geo reference doesn't know this place, so it matches nothing. */
  resolved: boolean;
}

export interface LocationCoverage {
  tag: string;
  threshold: number;
  hasTargeting: boolean;
  totalAvailable: number | null;
  locations: CoverageRow[];
  low: CoverageRow[];
}

export function LocationCoverageNotice({
  coverage,
  loading,
  error,
  onRefresh,
}: {
  coverage: LocationCoverage | null;
  loading: boolean;
  /** The check failed — say so. A silent failure looks exactly like "all
   *  locations are fine", which is how a timed-out scan hid the popup. */
  error?: string | null;
  onRefresh: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const shownFor = React.useRef<string | null>(null);

  // Auto-open once per client, not on every re-render or refresh.
  React.useEffect(() => {
    if (!coverage || coverage.low.length === 0) return;
    if (shownFor.current === coverage.tag) return;
    shownFor.current = coverage.tag;
    setOpen(true);
  }, [coverage]);

  if (loading && !coverage) {
    return (
      <div className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border bg-card px-3 py-2 text-xs shadow-lg">
        <Loader2 className="size-3 animate-spin" /> Checking location coverage…
      </div>
    );
  }
  if (error && !coverage) {
    return (
      <button
        type="button"
        onClick={onRefresh}
        className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive shadow-lg hover:bg-destructive/20"
      >
        <RefreshCw className="size-3" /> Location coverage check failed — retry
      </button>
    );
  }
  if (!coverage || coverage.low.length === 0) return null;

  const empty = coverage.low.filter((l) => l.available === 0 && l.resolved);
  const scarce = coverage.low.filter((l) => l.available > 0);
  const unknown = coverage.low.filter((l) => !l.resolved);

  const copyList = async () => {
    const text = coverage.low
      .filter((l) => l.resolved)
      .map((l) => `${l.city ?? l.state ?? l.country}${l.city && l.state ? `, ${l.state}` : ""}\t${l.available}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`Copied ${coverage.low.length} location(s) to the clipboard`);
    } catch {
      toast.error("Couldn't copy — your browser blocked clipboard access");
    }
  };

  return (
    <>
      {/* Persistent reopener — the notice survives being dismissed. */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          title={`${coverage.low.length} of ${coverage.locations.length} target locations are under ${coverage.threshold.toLocaleString()} leads`}
          className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-700 shadow-lg transition-colors hover:bg-amber-500/20 dark:text-amber-300"
        >
          <MapPin className="size-3.5" />
          {coverage.low.length} location{coverage.low.length === 1 ? "" : "s"} need leads
          <span className="text-amber-700/60 dark:text-amber-300/60">· {coverage.tag}</span>
        </button>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setOpen(false)}>
          <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2 border-b p-5 pb-3">
              <div>
                <h2 className="flex items-center gap-2 text-[17px] font-semibold">
                  <MapPin className="size-4 text-amber-600" />
                  Locations needing leads — {coverage.tag}
                </h2>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  {coverage.low.length} of {coverage.locations.length} target locations have fewer than{" "}
                  <span className="font-medium tabular-nums">{coverage.threshold.toLocaleString()}</span> fresh leads.
                  {coverage.totalAvailable != null && (
                    <> {coverage.totalAvailable.toLocaleString()} available in total.</>
                  )}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-full p-1 hover:bg-muted" aria-label="Close">
                <X className="size-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 pt-3 text-[13px]">
              {empty.length > 0 && (
                <Section
                  title={`No leads at all (${empty.length})`}
                  hint="Nothing in the database for these areas — scrape these first."
                  rows={empty}
                />
              )}
              {scarce.length > 0 && (
                <Section
                  title={`Below ${coverage.threshold.toLocaleString()} (${scarce.length})`}
                  hint="Some coverage, but not enough to sustain sending."
                  rows={scarce}
                />
              )}
              {unknown.length > 0 && (
                <Section
                  title={`Not in the geo reference (${unknown.length})`}
                  hint="These target entries match no known place, so they can never receive leads — the spelling likely needs fixing in the client's rules."
                  rows={unknown}
                />
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t p-4">
              <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={onRefresh} disabled={loading}>
                <RefreshCw className={`mr-1 size-3 ${loading ? "animate-spin" : ""}`} />
                Recheck
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" className="h-8 text-xs" onClick={copyList}>
                  <Copy className="mr-1 size-3" /> Copy list
                </Button>
                <Button size="sm" className="h-8 text-xs" onClick={() => setOpen(false)}>Close</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, hint, rows }: { title: string; hint: string; rows: CoverageRow[] }) {
  return (
    <div className="mb-4 last:mb-0">
      <p className="font-medium">{title}</p>
      <p className="mb-2 text-[12px] text-muted-foreground">{hint}</p>
      <div className="overflow-hidden rounded-xl border">
        {rows.map((r, i) => (
          <div
            key={`${r.label}-${i}`}
            className="flex items-center justify-between gap-3 border-b px-3 py-1.5 last:border-b-0 odd:bg-muted/30"
          >
            <span className="truncate">{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {r.resolved ? r.available.toLocaleString() : "—"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
