"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RowSelectionState } from "@tanstack/react-table";
import { toast } from "sonner";
import type { FilterResult } from "@/lib/filters/build-rpc-filters";
import { useFilters, type TargetingPatch } from "@/lib/hooks/use-filters";
import type { LocationTargetEntry } from "@/types/filters";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { FilterBar } from "@/components/filters/filter-bar";
import { LeadTable } from "@/components/leads/lead-table";
import { LeadDetailPanel } from "@/components/leads/lead-detail-panel";
import { ExportButton } from "@/components/exports/export-button";
import { DeleteLeadsDialog } from "@/components/leads/delete-leads-dialog";
import { Button } from "@/components/ui/button";
import { ArrowUpDown, X, Trash2, Link2 } from "lucide-react";
import { useHasPermission } from "@/lib/context/role-context";
import { countActiveFilters } from "@/types/filters";
import type { Lead } from "@/types/database";

const SORT_OPTIONS = [
  { label: "Name (A → Z)", sortBy: "first_name", sortDir: "asc" as const },
  { label: "Name (Z → A)", sortBy: "first_name", sortDir: "desc" as const },
  { label: "Company (A → Z)", sortBy: "company", sortDir: "asc" as const },
  { label: "Company (Z → A)", sortBy: "company", sortDir: "desc" as const },
  { label: "Employees (Low → High)", sortBy: "company_size", sortDir: "asc" as const },
  { label: "Employees (High → Low)", sortBy: "company_size", sortDir: "desc" as const },
  { label: "Revenue (Low → High)", sortBy: "annual_revenue", sortDir: "asc" as const },
  { label: "Revenue (High → Low)", sortBy: "annual_revenue", sortDir: "desc" as const },
];

export default function LeadsPage() {
  const {
    filters,
    setText,
    setIncludeExclude,
    setRange,
    setLocationCountry,
    setLocationState,
    setLocationCity,
    setFilterOperator,
    toggleFlag,
    setKeyword,
    setEmailType,
    setEmailContains,
    setCategorySearch,
    setCustomTags,
    setWebsite,
    setGlobalSearch,
    setIncludeBounced,
    setPage,
    setPageSize,
    setSort,
    loadPreset,
    setLocationTargets,
    setCategoryCascade,
    setClientTag,
    applyClientTargeting,
    removeClientTargeting,
    resetFilters,
  } = useFilters();

  const debouncedFilters = useDebounce(filters, 300);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isApproximate, setIsApproximate] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // "Select all N filtered" mode — the whole filtered set is targeted, not just
  // the checked visible rows. Delete/actions resolve it server-side via filters.
  const [selectAllFiltered, setSelectAllFiltered] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);

  const canDelete = useHasPermission("admin");
  const activeFilterCount = countActiveFilters(filters);
  const allPageSelected = leads.length > 0 && leads.every((l) => rowSelection[l.id]);

  // Any manual selection change (checkbox / drag / shift) exits "all filtered".
  function handleSelectionChange(next: RowSelectionState) {
    setSelectAllFiltered(false);
    setRowSelection(next);
  }
  function selectAllFilteredNow() {
    const next: RowSelectionState = {};
    for (const l of leads) next[l.id] = true;
    setRowSelection(next);
    setSelectAllFiltered(true);
  }
  function clearSelection() {
    setRowSelection({});
    setSelectAllFiltered(false);
  }

  // A selection targets explicit ids; otherwise (all-filtered, or delete driven
  // purely by an active filter) we delete the whole filtered set server-side.
  const deleteMode: "ids" | "filtered" =
    !selectAllFiltered && selectedIds.length > 0 ? "ids" : "filtered";
  const deleteEnabled = selectedIds.length > 0 || selectAllFiltered || activeFilterCount > 0;

  // ── Client-targeting auto-apply ────────────────────────────────────────────
  // Selecting a client tag from the quick-pick list pulls that client's
  // targeting rules (synced from the onboarding sheet / Rules dialog) into the
  // other filters; deselecting removes exactly what was applied. Per-tag
  // patches let two selected clients share values without premature removal.
  const appliedRef = useRef<Map<string, TargetingPatch>>(new Map());
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const [availability, setAvailability] = useState<{ tag: string; available: number } | null>(null);
  const clientTypeRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    fetch("/api/bison/client-tags")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        for (const t of d?.tags ?? []) if (t?.tag && t?.client_type) clientTypeRef.current.set(t.tag, t.client_type);
      })
      .catch(() => {});
  }, []);

  // Low-availability popup (client req: warn when a client has <250 fresh leads).
  const [lowAvail, setLowAvail] = useState<{
    tag: string;
    available: number;
    targeting: {
      include_locations?: LocationTargetEntry[];
      include_industries?: string[];
      include_keywords?: string[];
      exclude_industries?: string[];
      exclude_keywords?: string[];
    } | null;
  } | null>(null);

  const handleClientTagSelected = useCallback(async (tag: string) => {
    if (appliedRef.current.has(tag)) return;
    try {
      // Targeting is fetched on its own: the availability count scans millions
      // of rows and must never be able to swallow the targeting apply (it did —
      // a slow/failed count left the filters empty on select).
      const tRes = await fetch(`/api/clients/targeting?tag=${encodeURIComponent(tag)}`);
      const { targeting } = tRes.ok
        ? ((await tRes.json()) as {
            targeting: {
              include_locations?: LocationTargetEntry[];
              exclude_locations?: LocationTargetEntry[];
              include_keywords?: string[];
              exclude_keywords?: string[];
              exclude_industries?: string[];
              include_industries?: string[];
            } | null;
          })
        : { targeting: null };
      const isCleaning = clientTypeRef.current.get(tag) === "Cleaning";
      // The patch records the client's FULL targeting (apply dedupes against
      // current state), so two selected clients sharing a value each claim it
      // and the removal refcount keeps it until both are deselected.
      const patch: TargetingPatch = {
        locations: {
          include: targeting?.include_locations ?? [],
          exclude: targeting?.exclude_locations ?? [],
        },
        categorySearchInclude: targeting?.include_keywords ?? [],
        keywordExclude: targeting?.exclude_keywords ?? [],
        categoryExclude: targeting?.exclude_industries ?? [],
        ...(isCleaning && !filtersRef.current.commercialCleaning ? { commercialCleaning: true } : {}),
      };
      const n =
        patch.locations.include.length + patch.locations.exclude.length +
        patch.categorySearchInclude.length + patch.keywordExclude.length +
        patch.categoryExclude.length + (patch.commercialCleaning ? 1 : 0);
      if (n > 0) {
        appliedRef.current.set(tag, patch);
        applyClientTargeting(patch);
        const bits = [
          patch.locations.include.length && `${patch.locations.include.length} locations → City/State filters`,
          patch.categorySearchInclude.length && `${patch.categorySearchInclude.length} category terms`,
          patch.categoryExclude.length && `${patch.categoryExclude.length} excluded industries`,
          patch.keywordExclude.length && `${patch.keywordExclude.length} excluded keywords`,
          patch.commercialCleaning && "Commercial Cleaning titles on",
        ].filter(Boolean).join(", ");
        toast.success(`${tag} targeting applied: ${bits}`);
      } else if (!targeting) {
        toast.info(`No targeting rules on file for ${tag} — filtering by tag only`);
      }
      // Availability afterwards, independently — informational only.
      fetch(`/api/clients/availability?tag=${encodeURIComponent(tag)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((a: { available: number } | null) => {
          if (!a) return;
          setAvailability({ tag, available: a.available });
          if (a.available < 250) setLowAvail({ tag, available: a.available, targeting: targeting ?? null });
        })
        .catch(() => {});
    } catch {
      /* targeting fetch failed — tag filter still applies */
    }
  }, [applyClientTargeting]);

  // Preset load / reset replace the whole filter state — earlier tags' patches
  // must be forgotten WITHOUT dispatching removals, or the observer below
  // would strip values that legitimately belong to the loaded preset.
  const handleLoadPreset = useCallback((f: Parameters<typeof loadPreset>[0]) => {
    appliedRef.current.clear();
    loadPreset(f);
  }, [loadPreset]);
  const handleReset = useCallback(() => {
    appliedRef.current.clear();
    resetFilters();
    // Also drop the shared-search id from the address bar. Without this the URL
    // keeps ?s=<id>, so a refresh silently re-applies the very search that was
    // just cleared. replaceState (not push) so Back doesn't bounce through a
    // reset that no longer matches the filters on screen.
    if (typeof window !== "undefined" && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [resetFilters]);

  // Removal is observed from state (covers pill re-click, TagInput ✕) rather
  // than hooked to a click handler.
  useEffect(() => {
    const selected = new Set(filters.clientTag ? [filters.clientTag] : []);
    for (const [tag, patch] of appliedRef.current) {
      if (selected.has(tag)) continue;
      appliedRef.current.delete(tag);
      // Keep any value another still-selected client also contributes.
      const others = [...appliedRef.current.values()];
      const entryKey = (e: LocationTargetEntry) => `${e.country}|${e.state ?? ""}|${e.city ?? ""}`;
      const othersHaveEntry = (e: LocationTargetEntry, side: "include" | "exclude") =>
        others.some((p) => p.locations[side].some((o) => entryKey(o) === entryKey(e)));
      const othersHave = (field: "categorySearchInclude" | "keywordExclude" | "categoryExclude", v: string) =>
        others.some((p) => p[field].some((o) => o.toLowerCase() === v.toLowerCase()));
      removeClientTargeting({
        locations: {
          include: patch.locations.include.filter((e) => !othersHaveEntry(e, "include")),
          exclude: patch.locations.exclude.filter((e) => !othersHaveEntry(e, "exclude")),
        },
        categorySearchInclude: patch.categorySearchInclude.filter((v) => !othersHave("categorySearchInclude", v)),
        keywordExclude: patch.keywordExclude.filter((v) => !othersHave("keywordExclude", v)),
        categoryExclude: patch.categoryExclude.filter((v) => !othersHave("categoryExclude", v)),
        ...(patch.commercialCleaning && !others.some((p) => p.commercialCleaning)
          ? { commercialCleaning: true } : {}),
      });
    }
  }, [filters.clientTag, removeClientTargeting]);

  // Restore a shared search (/leads?s=<id>) once on mount.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const id = new URLSearchParams(window.location.search).get("s");
    if (!id) return;
    fetch(`/api/shared-search?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Search link not found"))))
      .then((d) => {
        loadPreset(d.filters);
        toast.success("Shared search restored");
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't restore the shared search"));
  }, [loadPreset]);

  const [copyingLink, setCopyingLink] = useState(false);
  const copySearchLink = useCallback(async () => {
    setCopyingLink(true);
    try {
      const res = await fetch("/api/shared-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Failed to create link");
      const url = `${window.location.origin}/leads?s=${d.id}`;
      await navigator.clipboard.writeText(url);
      window.history.replaceState(null, "", `/leads?s=${d.id}`);
      toast.success("Search link copied — anyone on the team can open it");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to copy link");
    } finally {
      setCopyingLink(false);
    }
  }, [filters]);

  const fetchLeads = useCallback(async () => {
    setIsLoading(true);
    // Big searches can exceed the server's patience — abort at 100s with a
    // clear message instead of spinning forever, and KEEP the previous rows.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 100_000);
    try {
      const res = await fetch("/api/leads/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(debouncedFilters),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Filter request failed: ${res.status}`);
      const result: FilterResult & { isApproximate?: boolean } = await res.json();
      setLeads(result.data);
      setTotalCount(result.totalCount);
      setIsApproximate(result.isApproximate ?? false);
    } catch (err) {
      console.error("Filter query error:", err);
      if (err instanceof DOMException && err.name === "AbortError") {
        toast.error("This search is too heavy and timed out — remove a filter or two and try again. Showing the previous results.");
      } else {
        toast.error("Search failed — showing the previous results. Try adjusting the filters.");
      }
    } finally {
      clearTimeout(timer);
      setIsLoading(false);
    }
  }, [debouncedFilters]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  // Clear row selection whenever the filters or sort change (but not on pagination changes).
  // Otherwise selected IDs from a prior view leak into "Export Selected".
  const prevFilterFingerprint = useRef<string>("");
  useEffect(() => {
    const { page: _p, pageSize: _ps, ...rest } = debouncedFilters;
    void _p; void _ps;
    const fingerprint = JSON.stringify(rest);
    if (prevFilterFingerprint.current && prevFilterFingerprint.current !== fingerprint) {
      setRowSelection({});
      setSelectAllFiltered(false);
    }
    prevFilterFingerprint.current = fingerprint;
  }, [debouncedFilters]);

  return (
    <div className="flex h-[calc(100vh-7.5rem)] flex-col gap-4">
      {/* Filter bar */}
      <div className="-mx-6 -mt-6">
        <FilterBar
          filters={filters}
          onTextChange={setText}
          onIncludeExcludeChange={setIncludeExclude}
          onRangeChange={setRange}
          onLocationCountryChange={setLocationCountry}
          onLocationStateChange={setLocationState}
          onLocationCityChange={setLocationCity}
          onFilterOperatorChange={setFilterOperator}
          onToggleFlag={toggleFlag}
          onKeywordChange={setKeyword}
          onEmailTypeChange={setEmailType}
          onEmailContainsChange={setEmailContains}
          onCategorySearchChange={setCategorySearch}
          onCustomTagsChange={setCustomTags}
          onWebsiteChange={setWebsite}
          onGlobalSearchChange={setGlobalSearch}
          onIncludeBouncedChange={setIncludeBounced}
          onLoadPreset={handleLoadPreset}
          onClientTagSelected={handleClientTagSelected}
          onLocationTargetsChange={setLocationTargets}
          onClientTagChange={(t) => { setClientTag(t); if (!t) setAvailability(null); }}
          onReset={handleReset}
        />
      </div>

      {/* Header — iOS large title style */}
      <div className="flex items-end justify-between pb-1">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Leads</h1>
          <p
            className="mt-0.5 text-[13px] text-muted-foreground"
            title={isApproximate ? "Approximate count (planner estimate, ±5%)" : undefined}
          >
            {isApproximate ? "~" : ""}
            {totalCount.toLocaleString()} contacts
            {availability && availability.tag === filters.clientTag && (
              <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                {availability.available.toLocaleString()} available for {availability.tag}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <ArrowUpDown
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
              strokeWidth={1.75}
            />
            <select
              className="h-9 cursor-pointer appearance-none rounded-full bg-muted pr-4 pl-8 text-[13px] font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40"
              value={`${filters.sortBy}:${filters.sortDir}`}
              onChange={(e) => {
                const [sortBy, sortDir] = e.target.value.split(":");
                setSort(sortBy, sortDir as "asc" | "desc");
              }}
            >
              <option value="created_at:desc" disabled>
                Sort by…
              </option>
              {SORT_OPTIONS.map((opt) => (
                <option key={`${opt.sortBy}:${opt.sortDir}`} value={`${opt.sortBy}:${opt.sortDir}`}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {(selectedIds.length > 0 || selectAllFiltered) && (
            <>
              <span className="text-[13px] font-medium text-muted-foreground tabular-nums">
                {selectAllFiltered
                  ? `All ${(isApproximate ? "~" : "") + totalCount.toLocaleString()} selected`
                  : `${selectedIds.length} selected`}
              </span>
              {allPageSelected && !selectAllFiltered && totalCount > leads.length && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-primary"
                  onClick={selectAllFilteredNow}
                >
                  Select all {totalCount.toLocaleString()}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={clearSelection}
              >
                <X className="h-4 w-4 mr-1" />
                Deselect
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            disabled={copyingLink}
            onClick={copySearchLink}
            title="Copy a link that restores this exact search — reopen it later or send it to anyone on the team"
          >
            <Link2 className="h-4 w-4 mr-1" />
            {copyingLink ? "Copying…" : "Copy search link"}
          </Button>
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive disabled:opacity-40"
              disabled={!deleteEnabled}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Delete
            </Button>
          )}
          <ExportButton filters={filters} totalCount={totalCount} selectedIds={selectedIds} />
        </div>
      </div>

      {/* Table — wrapped in iOS card */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-ios">
        <LeadTable
          data={leads}
          totalCount={totalCount}
          page={filters.page}
          pageSize={filters.pageSize}
          isLoading={isLoading}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onRowClick={setSelectedLead}
          rowSelection={rowSelection}
          onRowSelectionChange={handleSelectionChange}
        />
      </div>

      {canDelete && (
        <DeleteLeadsDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          mode={deleteMode}
          ids={selectedIds}
          filters={filters}
          approxCount={deleteMode === "ids" ? selectedIds.length : totalCount}
          isApproximate={isApproximate}
          onDeleted={() => {
            clearSelection();
            fetchLeads();
          }}
        />
      )}

      {/* Low lead-availability warning — closable, informational */}
      {lowAvail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLowAvail(null)}>
          <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <h2 className="text-[17px] font-semibold">
                Low lead availability — {lowAvail.tag}
              </h2>
              <button type="button" onClick={() => setLowAvail(null)} className="rounded-full p-1 hover:bg-muted">
                <X className="size-4" />
              </button>
            </div>
            <p className="mt-2 text-[13px]">
              Only <span className="font-semibold tabular-nums">{lowAvail.available.toLocaleString()}</span> fresh
              leads match this client&apos;s targeting (eligible, contactable, never pushed for {lowAvail.tag}).
              <span className="font-medium"> New leads are needed.</span>
            </p>
            {lowAvail.targeting ? (
              <div className="mt-3 space-y-2 rounded-xl bg-muted/50 p-3 text-[12px]">
                {(lowAvail.targeting.include_locations?.length ?? 0) > 0 && (
                  <p><span className="font-medium">Locations:</span>{" "}
                    {lowAvail.targeting.include_locations!.slice(0, 12).map((e) => e.city ?? e.state ?? e.country).join(", ")}
                    {lowAvail.targeting.include_locations!.length > 12 ? ` +${lowAvail.targeting.include_locations!.length - 12} more` : ""}
                  </p>
                )}
                {(lowAvail.targeting.include_industries?.length ?? 0) > 0 && (
                  <p><span className="font-medium">Target industries:</span> {lowAvail.targeting.include_industries!.join(", ")}</p>
                )}
                {(lowAvail.targeting.include_keywords?.length ?? 0) > 0 && (
                  <p><span className="font-medium">Target keywords:</span> {lowAvail.targeting.include_keywords!.slice(0, 15).join(", ")}</p>
                )}
                {(lowAvail.targeting.exclude_industries?.length ?? 0) > 0 && (
                  <p><span className="font-medium">Excluded industries:</span> {lowAvail.targeting.exclude_industries!.join(", ")}</p>
                )}
                {(lowAvail.targeting.exclude_keywords?.length ?? 0) > 0 && (
                  <p className="text-muted-foreground"><span className="font-medium text-foreground">Excluded keywords:</span> {lowAvail.targeting.exclude_keywords!.slice(0, 15).join(", ")}{lowAvail.targeting.exclude_keywords!.length > 15 ? "…" : ""}</p>
                )}
              </div>
            ) : (
              <p className="mt-3 text-[12px] text-muted-foreground">No targeting rules on file for this client.</p>
            )}
            <div className="mt-4 flex justify-end">
              <Button size="sm" onClick={() => setLowAvail(null)}>Got it</Button>
            </div>
          </div>
        </div>
      )}

      <LeadDetailPanel
        lead={selectedLead}
        open={selectedLead !== null}
        onClose={() => setSelectedLead(null)}
        onDeleted={() => {
          setSelectedLead(null);
          fetchLeads();
        }}
      />
    </div>
  );
}
