"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";

// The client roster picker. Lived as a chip in the filter bar until 2026-08-20;
// it now sits in the top bar beside the search box, because picking a client is
// how you START a piece of work rather than one filter among twenty.
//
// It is deliberately self-contained (own roster fetch, own search box) so it can
// be rendered anywhere. The leads page portals it into the top bar — see the
// `#topbar-slot` note in top-bar.tsx.
//
// NOTE: selecting a client does NOT filter by tag. It applies that client's
// sheet targeting to the OTHER filters (locations, categories, exclusions), so
// newly imported untagged leads still appear. `clientTag` is not part of
// buildRpcFilters at all.

export interface ClientRosterEntry {
  tag: string;
  status?: string | null;
  client_type?: string | null;
  churned?: boolean;
  contactable?: number | null;
}

export function ClientSelector({
  clientTag,
  onChange,
  onSelected,
  onRosterLoaded,
}: {
  clientTag?: string | null;
  /** Set or clear the selected tag. */
  onChange: (tag: string | null) => void;
  /** Fired only on a NEW selection — this is what applies the client's targeting. */
  onSelected?: (tag: string) => void;
  /** Lets the page reuse this fetch instead of making its own. */
  onRosterLoaded?: (roster: ClientRosterEntry[]) => void;
}) {
  const [roster, setRoster] = useState<ClientRosterEntry[]>([]);
  const [search, setSearch] = useState("");
  const loadedRef = useRef(false);

  const loadClientTags = useCallback(async (force = false) => {
    if (loadedRef.current && !force) return;
    loadedRef.current = true;
    try {
      const res = await fetch("/api/bison/client-tags");
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { tags?: ClientRosterEntry[] };
      const tags = (json.tags ?? []).filter((t) => t?.tag);
      setRoster(tags);
      onRosterLoaded?.(tags);
    } catch {
      // One transient failure must not permanently blank the dropdown —
      // unlatch so the next open (or the Retry button) refetches.
      loadedRef.current = false;
    }
  }, [onRosterLoaded]);

  const active = !!clientTag;
  const q = search.trim().toLowerCase();

  return (
    <Popover onOpenChange={(open) => { if (open) loadClientTags(); }}>
      <PopoverTrigger asChild>
        <button
          className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition-all active:scale-[0.97] ${
            active
              ? "bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(0,122,255,0.28)]"
              : "bg-muted text-foreground hover:bg-accent"
          }`}
          title="Pick a client to apply its targeting rules to the filters"
        >
          <Users className="size-3.5" strokeWidth={2} />
          {clientTag ? `Client: ${clientTag}` : "Client"}
          <ChevronDown className={`size-3 ${active ? "opacity-80" : "opacity-60"}`} strokeWidth={2.25} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="space-y-2">
          <Input
            placeholder={`Search ${roster.length || ""} clients…`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs"
          />
          {clientTag && (
            <button
              type="button"
              onClick={() => onChange(null)}
              className="w-full rounded-lg bg-muted px-2 py-1.5 text-left text-[12px] hover:bg-accent"
            >
              ✕ Clear client ({clientTag})
            </button>
          )}
          <div className="max-h-64 space-y-0.5 overflow-y-auto">
            {roster.length === 0 ? (
              <div className="space-y-1 px-1 py-2">
                <p className="text-[11px] text-muted-foreground">Loading clients…</p>
                <button
                  type="button"
                  onClick={() => loadClientTags(true)}
                  className="text-[11px] font-medium text-primary hover:underline"
                >
                  Not loading? Retry
                </button>
              </div>
            ) : (
              roster
                .filter((c) => !q || c.tag.toLowerCase().includes(q))
                .map((c) => {
                  const picked = clientTag === c.tag;
                  return (
                    <button
                      key={c.tag}
                      type="button"
                      onClick={() => {
                        if (picked) {
                          onChange(null);
                        } else {
                          // ORDER MATTERS: set the tag first, then fire the
                          // selection hook — the targeting apply reads the tag.
                          onChange(c.tag);
                          onSelected?.(c.tag);
                        }
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${
                        picked ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted/60"
                      }`}
                    >
                      <span className="font-medium">{c.tag}</span>
                      {c.client_type && (
                        <span
                          className={`rounded-full px-1.5 text-[9px] ${
                            c.client_type === "Cleaning"
                              ? "bg-orange-500/15 text-orange-600"
                              : "bg-sky-500/15 text-sky-600"
                          }`}
                        >
                          {c.client_type}
                        </span>
                      )}
                      {c.churned && (
                        <span className="rounded-full bg-destructive/10 px-1.5 text-[9px] text-destructive">
                          churned
                        </span>
                      )}
                      <span
                        className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground"
                        title="Leads already pushed/tagged for this client (cached). Availability for a NEW send is shown when you select the client."
                      >
                        {c.contactable != null && c.contactable > 0 ? c.contactable.toLocaleString() : ""}
                      </span>
                    </button>
                  );
                })
            )}
          </div>
          <p className="px-1 text-[10px] text-muted-foreground">
            Picking a client applies its sheet targeting (locations, categories,
            exclusions) to the filters — it does NOT filter by the tag, so new
            untagged leads still show. Available-to-send count appears on select.
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
