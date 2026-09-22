"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RowSelectionState } from "@tanstack/react-table";
import { toast } from "sonner";
import type { FilterResult } from "@/lib/filters/build-rpc-filters";
import { useFilters, type TargetingPatch } from "@/lib/hooks/use-filters";
import type { LocationTargetEntry } from "@/types/filters";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { FilterBar } from "@/components/filters/filter-bar";
import { ClientSelector, type ClientRosterEntry } from "@/components/filters/client-selector";
import { LeadTable } from "@/components/leads/lead-table";
import { LeadDetailPanel } from "@/components/leads/lead-detail-panel";
import { ExportButton } from "@/components/exports/export-button";
import { DeleteLeadsDialog } from "@/components/leads/delete-leads-dialog";
import { SuppressLeadsDialog } from "@/components/leads/suppress-leads-dialog";
import { Button } from "@/components/ui/button";
import { ArrowUpDown, X, Trash2, Link2, Ban } from "lucide-react";
import { useHasPermission } from "@/lib/context/role-context";
import { countActiveFilters, needsClientTargeting, EXCLUDE_IDS_MAX } from "@/types/filters";
import { LocationCoverageNotice, type LocationCoverage } from "@/components/clients/location-coverage-notice";
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
    setEmailType,
    setEmailContains,
    setCategorySearch,
    setCustomTags,
    setWebsite,
    setEmailSuffix,
    setDomainSuffix,
    setGlobalSearch,
    setIncludeBounced,
    setPage,
    setPageSize,
    setSort,
    setColumnFilter,
    loadPreset,
    setLocationTargets,
    setCategoryCascade,
    setClientTag,
    applyClientTargeting,
    removeClientTargeting,
    resetFilters,
  } = useFilters();

  const debouncedFilters = useDebounce(filters, 300);

  // The portal target lives in the app-shell TopBar, which is not in this tree.
  // It only exists after the first client render, so hold off one tick.
  const [topbarSlot, setTopbarSlot] = useState<Element | null>(null);
  useEffect(() => { setTopbarSlot(document.getElementById("topbar-slot")); }, []);

  // "Main Campaigns" column: which of the rows on screen have already gone to a
  // main (non-Nurture) campaign for the selected client. Fetched SEPARATELY from
  // the leads themselves so it can never delay the table — the column shows a
  // placeholder until it lands.
  const [pushedIds, setPushedIds] = useState<Set<string>>(new Set());
  const [pushedLoaded, setPushedLoaded] = useState(false);
  const pushReqSeq = useRef(0);

  // The 300ms debounce window is a hole: `filters` has already changed but the
  // fetch has not started, so isLoading is still false and the PREVIOUS query's
  // rows and count render as if they answered the new filters. Selecting a
  // client showed "7,422,696 contacts" over unfiltered Alabama rows before
  // flipping to 59,527. Treat "filters differ from the ones we fetched" as busy.
  const filtersSettled =
    JSON.stringify(filters) === JSON.stringify(debouncedFilters);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isApproximate, setIsApproximate] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedLead, setSelectedLead] = useState<Lead | null>(null);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  // "Select all N filtered" mode — the whole filtered set is targeted, not just
  // the checked visible rows. Delete/actions resolve it server-side via filters.
  const [selectAllFiltered, setSelectAllFiltered] = useState(false);
  // Rows unchecked OUT of a select-all. The selection is then "everything
  // matching the filters, minus these", which is what every action is given
  // (fn_lead_filter_conditions honours `excludeIds`, migration 114) — so the
  // count in the toolbar, the export and a delete cannot disagree.
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());
  const excludedRef = useRef(excludedIds);
  excludedRef.current = excludedIds;
  const atCapRef = useRef(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [suppressOpen, setSuppressOpen] = useState(false);
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);

  const canDelete = useHasPermission("admin");
  const activeFilterCount = countActiveFilters(filters);
  const allPageSelected = leads.length > 0 && leads.every((l) => rowSelection[l.id]);

  // Any manual selection change (checkbox / drag / shift) exits "all filtered".
  function handleSelectionChange(next: RowSelectionState) {
    setSelectAllFiltered(false);
    setExcludedIds(new Set());
    setRowSelection(next);
  }
  function selectAllFilteredNow() {
    const next: RowSelectionState = {};
    for (const l of leads) next[l.id] = true;
    setRowSelection(next);
    setExcludedIds(new Set());
    setSelectAllFiltered(true);
  }
  function clearSelection() {
    setRowSelection({});
    setExcludedIds(new Set());
    setSelectAllFiltered(false);
  }
  // Unchecking a row inside a select-all records an exclusion instead of
  // collapsing to "the ids this page happens to know", which would silently
  // shrink a 42,000-lead selection to the ~100 rows on screen.
  const toggleExcluded = useCallback((id: string, excluded: boolean) => {
    // The cap check and its toast stay OUT of the updater — an updater must be
    // pure (React may call it twice), and a toast fired from inside it would
    // double up.
    if (excluded && excludedRef.current.size >= EXCLUDE_IDS_MAX && !excludedRef.current.has(id)) {
      atCapRef.current = true;
      return;
    }
    setExcludedIds((prev) => {
      const next = new Set(prev);
      if (excluded) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  // Telling the operator about the cap is a side effect, so it happens in an
  // effect rather than in the callback (which the compiler must be free to
  // memoize) or the updater (which must be pure).
  useEffect(() => {
    if (!atCapRef.current) return;
    atCapRef.current = false;
    toast.error(`You can uncheck at most ${EXCLUDE_IDS_MAX.toLocaleString()} rows — narrow the filters instead`);
  });

  // What the actions actually target. Kept OUT of `filters` itself so a saved
  // search or shared link never carries someone's unchecked rows.
  const excludeIdList = useMemo(() => [...excludedIds], [excludedIds]);
  const actionFilters = useMemo(
    () => (selectAllFiltered && excludeIdList.length ? { ...filters, excludeIds: excludeIdList } : filters),
    [filters, selectAllFiltered, excludeIdList]
  );
  const selectedCount = selectAllFiltered
    ? Math.max(0, totalCount - excludedIds.size)
    : selectedIds.length;

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
  // The patch is stored with the targeting row's `updated_at`: rules edited in
  // the Rules dialog (or by the sheet sync) while this page is open MUST replace
  // what was applied. Keeping the first version is not just stale — a client
  // export then runs without the cities added since, i.e. out of territory
  // (2026-09-21: JPCA's 105 cities were saved 16:14, an export at 16:40 still
  // carried only the category terms, scanned all 9M leads and timed out).
  const appliedRef = useRef<Map<string, { patch: TargetingPatch; version: string | null }>>(new Map());
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // Cleaning vs Non-Cleaning per tag, used to auto-enable the Commercial
  // Cleaning toggle. Filled from the roster the ClientSelector already fetches
  // rather than issuing a second identical /api/bison/client-tags request.
  const clientTypeRef = useRef<Map<string, string>>(new Map());
  const handleRosterLoaded = useCallback((roster: ClientRosterEntry[]) => {
    for (const t of roster) if (t?.tag && t?.client_type) clientTypeRef.current.set(t.tag, t.client_type);
  }, []);

  // Per-location coverage for the selected client (include/preferred locations
  // only). Survives dismissal as a pill — see LocationCoverageNotice.
  const [coverage, setCoverage] = useState<LocationCoverage | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);

  // Low-availability popup (client req: warn when a client has <250 fresh leads).
  const [lowAvail, setLowAvail] = useState<{
    tag: string;
    available: number;
    targeting: {
      include_locations?: LocationTargetEntry[];
      include_industries?: string[];
      include_keywords?: string[];
      include_terms?: string[];
      exclude_industries?: string[];
      exclude_keywords?: string[];
    } | null;
  } | null>(null);

  const handleClientTagSelected = useCallback(async (tag: string) => {
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
              include_terms?: string[];
              exclude_keywords?: string[];
              exclude_industries?: string[];
              exclude_terms?: string[];
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
        // include_terms is the merged list (migrations 078/079); fall back to the
        // legacy column so nothing breaks if a row predates the migration.
        categorySearchInclude: targeting?.include_terms ?? targeting?.include_keywords ?? [],
        // One merged list now drives both sides. exclude_terms goes to the
        // Category chip's exclude (it spans company + industry too); the legacy
        // columns are the fallback for rows written before migration 078.
        keywordExclude: [],
        categorySearchExclude:
          targeting?.exclude_terms ??
          [...new Set([...(targeting?.exclude_industries ?? []), ...(targeting?.exclude_keywords ?? [])])],
        ...(isCleaning && !filtersRef.current.commercialCleaning ? { commercialCleaning: true } : {}),
      };
      // Nothing to do when the rules have not changed since they were applied —
      // this also keeps the expensive coverage/availability scans below from
      // re-running on every focus re-check.
      const version = (targeting as { updated_at?: string } | null)?.updated_at ?? null;
      const prev = appliedRef.current.get(tag);
      if (prev && prev.version === version) return;
      if (prev) {
        // Rules changed: take the OLD values back out first. Applying over them
        // merges the two sets, so cities dropped from the client's list would
        // keep filtering.
        appliedRef.current.delete(tag);
        removeClientTargeting(prev.patch);
      }

      const n =
        patch.locations.include.length + patch.locations.exclude.length +
        patch.categorySearchInclude.length + patch.keywordExclude.length +
        patch.categorySearchExclude.length + (patch.commercialCleaning ? 1 : 0);
      if (n > 0) {
        appliedRef.current.set(tag, { patch, version });
        applyClientTargeting(patch);
        const bits = [
          patch.locations.include.length && `${patch.locations.include.length} locations → Targeting chip (city+state paired)`,
          patch.categorySearchInclude.length && `${patch.categorySearchInclude.length} category terms`,
          patch.categorySearchExclude.length && `${patch.categorySearchExclude.length} excluded terms`,
          patch.commercialCleaning && "Commercial Cleaning titles on",
        ].filter(Boolean).join(", ");
        toast.success(`${tag} targeting ${prev ? "updated" : "applied"}: ${bits}`);
      } else if (!targeting) {
        toast.info(`No targeting rules on file for ${tag} — filtering by tag only`);
      }
      // Per-location coverage: which of the client's PREFERRED areas are short
      // of leads. Fetched in the background and never awaited — it is a grouped
      // scan of the client's eligible set (13-30s measured), so blocking the
      // client switch on it would freeze the page.
      setCoverage(null);
      setCoverageLoading(true);
      setCoverageError(null);
      fetch(`/api/clients/location-coverage?tag=${encodeURIComponent(tag)}&threshold=500`)
        .then(async (r) => {
          const d = await r.json().catch(() => null);
          if (!r.ok || d?.error) throw new Error(d?.error ?? `HTTP ${r.status}`);
          if (d?.hasTargeting) setCoverage(d as LocationCoverage);
        })
        // A failed check must be VISIBLE — swallowed, it looks identical to
        // "every location has plenty", which is how a timeout hid UJ's popup.
        .catch((e) => setCoverageError(e instanceof Error ? e.message : "check failed"))
        .finally(() => setCoverageLoading(false));

      // Availability afterwards, independently — informational only.
      fetch(`/api/clients/availability?tag=${encodeURIComponent(tag)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((a: { available: number | null } | null) => {
          // available is null when the client has no location targeting (no
          // precomputed coverage row) — no popup; `null < 250` would be true.
          if (!a || typeof a.available !== "number") return;
          // The "N available for TAG" badge was removed 2026-08-20 (client
          // request). The count is still fetched because the low-availability
          // warning below depends on it.
          if (a.available < 250) setLowAvail({ tag, available: a.available, targeting: targeting ?? null });
        })
        .catch(() => {});
    } catch {
      /* targeting fetch failed — tag filter still applies */
    }
  }, [applyClientTargeting, removeClientTargeting]);

  // Rules edited in another tab (or re-synced from the sheet) reach this page
  // when it regains focus. Only for a tag THIS page applied: a preset/shared
  // link clears appliedRef on purpose, and re-applying would add targeting the
  // saved search deliberately did not have. Unchanged rules cost one small
  // request and return above, before the coverage/availability scans.
  useEffect(() => {
    const tag = filters.clientTag;
    if (!tag) return;
    const recheck = () => {
      if (document.visibilityState === "visible" && appliedRef.current.has(tag)) void handleClientTagSelected(tag);
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [filters.clientTag, handleClientTagSelected]);

  // Preset load / reset replace the whole filter state — earlier tags' patches
  // must be forgotten WITHOUT dispatching removals, or the observer below
  // would strip values that legitimately belong to the loaded preset.
  // A saved search or shared link that NAMES a client must carry that client's
  // territory. Without it the query has nothing selective to narrow on: it
  // scans all ~9M leads — timing out on export — and any rows it did return
  // would be outside the client's area. Applied only when the search carries no
  // targeting of its own, so a hand-narrowed subset of a client's cities is
  // left exactly as it was saved.
  // (2026-09-21: shared search babb4aff… held clientTag JPCA, 107 category
  // exclusions and zero locations — the export off it died on the timeout.)
  const applyMissingTargeting = useCallback((f: Parameters<typeof loadPreset>[0]) => {
    const tag = needsClientTargeting(f);
    if (tag) void handleClientTagSelected(tag);
  }, [handleClientTagSelected]);

  const handleLoadPreset = useCallback((f: Parameters<typeof loadPreset>[0]) => {
    appliedRef.current.clear();
    loadPreset(f);
    applyMissingTargeting(f);
  }, [loadPreset, applyMissingTargeting]);
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
    for (const [tag, entry] of appliedRef.current) {
      if (selected.has(tag)) continue;
      const patch = entry.patch;
      appliedRef.current.delete(tag);
      // Keep any value another still-selected client also contributes.
      const others = [...appliedRef.current.values()].map((e) => e.patch);
      const entryKey = (e: LocationTargetEntry) => `${e.country}|${e.state ?? ""}|${e.city ?? ""}`;
      const othersHaveEntry = (e: LocationTargetEntry, side: "include" | "exclude") =>
        others.some((p) => p.locations[side].some((o) => entryKey(o) === entryKey(e)));
      const othersHave = (field: "categorySearchInclude" | "keywordExclude" | "categorySearchExclude", v: string) =>
        others.some((p) => p[field].some((o: string) => o.toLowerCase() === v.toLowerCase()));
      removeClientTargeting({
        locations: {
          include: patch.locations.include.filter((e) => !othersHaveEntry(e, "include")),
          exclude: patch.locations.exclude.filter((e) => !othersHaveEntry(e, "exclude")),
        },
        categorySearchInclude: patch.categorySearchInclude.filter((v) => !othersHave("categorySearchInclude", v)),
        keywordExclude: patch.keywordExclude.filter((v) => !othersHave("keywordExclude", v)),
        categorySearchExclude: patch.categorySearchExclude.filter((v) => !othersHave("categorySearchExclude", v)),
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
        applyMissingTargeting(d.filters);
        toast.success("Shared search restored");
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Couldn't restore the shared search"));
  }, [loadPreset, applyMissingTargeting]);

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

  // Monotonic request id. Without it a SLOW request can land after a FAST one
  // fired later and overwrite correct results with stale ones — e.g. the
  // unfiltered load resolving after the client-filtered load.
  const reqSeq = useRef(0);

  useEffect(() => {
    const tag = filters.clientTag;
    const ids = leads.map((l) => l.id);
    if (!tag || ids.length === 0) {
      setPushedIds(new Set());
      setPushedLoaded(!!tag); // no client selected -> column is hidden anyway
      return;
    }
    const myReq = ++pushReqSeq.current;
    setPushedLoaded(false);
    fetch("/api/leads/push-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadIds: ids, clientTag: tag }),
    })
      .then((r) => (r.ok ? r.json() : { pushed: [] }))
      .then((d: { pushed?: string[] }) => {
        if (myReq !== pushReqSeq.current) return; // superseded by a newer page
        setPushedIds(new Set(d.pushed ?? []));
        setPushedLoaded(true);
      })
      .catch(() => {
        if (myReq !== pushReqSeq.current) return;
        setPushedIds(new Set());
        setPushedLoaded(true); // informational column; fail quietly as "—"
      });
  }, [leads, filters.clientTag]);

  const fetchLeads = useCallback(async () => {
    const myReq = ++reqSeq.current;
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
      if (myReq !== reqSeq.current) return; // superseded — drop it
      setLeads(result.data);
      setTotalCount(result.totalCount);
      setIsApproximate(result.isApproximate ?? false);
    } catch (err) {
      if (myReq !== reqSeq.current) return; // superseded — its abort is expected
      console.error("Filter query error:", err);
      if (err instanceof DOMException && err.name === "AbortError") {
        toast.error("This search is too heavy and timed out — remove a filter or two and try again. Showing the previous results.");
      } else {
        toast.error("Search failed — showing the previous results. Try adjusting the filters.");
      }
    } finally {
      clearTimeout(timer);
      if (myReq === reqSeq.current) setIsLoading(false);
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
      {/* The Client selector paints into the app-shell top bar, beside the
          search box, but stays part of THIS component's tree so it keeps access
          to the filter state and the targeting callbacks. */}
      {topbarSlot &&
        createPortal(
          <ClientSelector
            clientTag={filters.clientTag}
            onChange={(t) => { setClientTag(t); if (!t) { setLowAvail(null); setCoverage(null); } }}
            onSelected={handleClientTagSelected}
            onRosterLoaded={handleRosterLoaded}
          />,
          topbarSlot
        )}

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
          onEmailTypeChange={setEmailType}
          onEmailContainsChange={setEmailContains}
          onCategorySearchChange={setCategorySearch}
          onCustomTagsChange={setCustomTags}
          onWebsiteChange={setWebsite}
          onEmailSuffixChange={setEmailSuffix}
          onDomainSuffixChange={setDomainSuffix}
          onGlobalSearchChange={setGlobalSearch}
          onIncludeBouncedChange={setIncludeBounced}
          onLoadPreset={handleLoadPreset}
          onLocationTargetsChange={setLocationTargets}
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
            {/* While a query is in flight the PREVIOUS count is meaningless —
                showing it made a heavy filter look like it had not applied at
                all (the header sat on the unfiltered 7,395,814 for minutes).
                Show that we are counting instead. */}
            {isLoading || !filtersSettled
              ? "Counting…"
              : `${isApproximate ? "~" : ""}${totalCount.toLocaleString()} contacts`}
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
                  ? excludedIds.size > 0
                    ? `${(isApproximate ? "~" : "") + selectedCount.toLocaleString()} selected · ${excludedIds.size.toLocaleString()} unchecked`
                    : `All ${(isApproximate ? "~" : "") + totalCount.toLocaleString()} selected`
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
              disabled={selectedCount === 0}
              title={
                selectedCount === 0
                  ? "Select leads to block them from every campaign"
                  : `Never contact ${selectedCount.toLocaleString()} address${selectedCount === 1 ? "" : "es"} — survives the Bison sync`
              }
              onClick={() => setSuppressOpen(true)}
            >
              <Ban className="h-4 w-4 mr-1" />
              Never contact
            </Button>
          )}
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
          {/* In select-all mode the export must take the FILTERED path (with any
              unchecked rows excluded server-side), not the ~100 ids this page
              happens to hold — that mismatch is what showed "· 100 selected"
              next to "All 340 selected". */}
          <ExportButton
            filters={actionFilters}
            totalCount={selectedCount}
            selectedIds={selectAllFiltered ? [] : selectedIds}
          />
        </div>
      </div>

      {/* Table — wrapped in iOS card */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl bg-card shadow-ios">
        <LeadTable
          data={leads}
          totalCount={totalCount}
          page={filters.page}
          pageSize={filters.pageSize}
          /* debounce window counts as busy — see filtersSettled */
          isLoading={isLoading || !filtersSettled}
          pushedLeadIds={pushedIds}
          pushedLoaded={pushedLoaded}
          showMainCampaigns={!!filters.clientTag}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          onRowClick={setSelectedLead}
          rowSelection={rowSelection}
          onRowSelectionChange={handleSelectionChange}
          allFilteredSelected={selectAllFiltered}
          excludedIds={excludedIds}
          onToggleExcluded={toggleExcluded}
          columnControls={{
            sortBy: filters.sortBy,
            sortDir: filters.sortDir,
            setSort,
            columnFilters: filters.columnFilters ?? {},
            setColumnFilter,
            filters,
          }}
        />
      </div>

      {canDelete && (
        <>
        <SuppressLeadsDialog
          open={suppressOpen}
          onClose={() => setSuppressOpen(false)}
          ids={selectedIds}
          /* Select-all: the server resolves the same filters the table ran
             (minus unchecked rows) instead of the ~100 ids this page holds. */
          filters={selectAllFiltered ? actionFilters : null}
          count={selectedCount}
          onDone={() => { clearSelection(); fetchLeads(); }}
        />

        <DeleteLeadsDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          mode={deleteMode}
          ids={selectedIds}
          filters={actionFilters}
          approxCount={deleteMode === "ids" ? selectedIds.length : selectedCount}
          isApproximate={isApproximate}
          onDeleted={() => {
            clearSelection();
            fetchLeads();
          }}
        />
        </>
      )}

      {/* Which of this client's preferred locations are short of leads.
          Dismissing it leaves a pill that reopens it — see the component. */}
      <LocationCoverageNotice
        coverage={coverage}
        loading={coverageLoading}
        error={coverageError}
        onRefresh={() => {
          if (!coverage) return;
          setCoverageLoading(true);
          setCoverageError(null);
          const tag = coverage?.tag ?? filters.clientTag;
          if (!tag) { setCoverageLoading(false); return; }
          fetch(`/api/clients/location-coverage?tag=${encodeURIComponent(tag)}&threshold=${coverage?.threshold ?? 500}&fresh=1`)
            .then(async (r) => {
              const d = await r.json().catch(() => null);
              if (!r.ok || d?.error) throw new Error(d?.error ?? `HTTP ${r.status}`);
              if (d?.hasTargeting) setCoverage(d as LocationCoverage);
            })
            .catch((e) => setCoverageError(e instanceof Error ? e.message : "check failed"))
            .finally(() => setCoverageLoading(false));
        }}
      />

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
                {((lowAvail.targeting.include_terms ?? lowAvail.targeting.include_keywords)?.length ?? 0) > 0 && (
                  <p><span className="font-medium">Target keywords:</span> {(lowAvail.targeting.include_terms ?? lowAvail.targeting.include_keywords)!.slice(0, 15).join(", ")}</p>
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
        onUpdated={(updated) => {
          // Patch the row in place so the table reflects the edit without
          // re-running the (expensive) filter query.
          setLeads((rows) => rows.map((r) => (r.id === updated.id ? updated : r)));
          setSelectedLead(updated);
        }}
      />
    </div>
  );
}
