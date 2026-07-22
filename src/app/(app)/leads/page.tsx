"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RowSelectionState } from "@tanstack/react-table";
import type { FilterResult } from "@/lib/filters/build-rpc-filters";
import { useFilters } from "@/lib/hooks/use-filters";
import { useDebounce } from "@/lib/hooks/use-debounce";
import { FilterBar } from "@/components/filters/filter-bar";
import { LeadTable } from "@/components/leads/lead-table";
import { LeadDetailPanel } from "@/components/leads/lead-detail-panel";
import { ExportButton } from "@/components/exports/export-button";
import { DeleteLeadsDialog } from "@/components/leads/delete-leads-dialog";
import { Button } from "@/components/ui/button";
import { ArrowUpDown, X, Trash2 } from "lucide-react";
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

  const fetchLeads = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch("/api/leads/filter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(debouncedFilters),
      });
      if (!res.ok) throw new Error(`Filter request failed: ${res.status}`);
      const result: FilterResult & { isApproximate?: boolean } = await res.json();
      setLeads(result.data);
      setTotalCount(result.totalCount);
      setIsApproximate(result.isApproximate ?? false);
    } catch (err) {
      console.error("Filter query error:", err);
      setLeads([]);
      setTotalCount(0);
      setIsApproximate(false);
    }
    setIsLoading(false);
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
          onLoadPreset={loadPreset}
          onReset={resetFilters}
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
