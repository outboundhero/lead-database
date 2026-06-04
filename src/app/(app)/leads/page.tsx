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
import { ArrowUpDown } from "lucide-react";
import type { Lead } from "@/types/database";

const SORT_OPTIONS = [
  { label: "Name (A → Z)", sortBy: "first_name", sortDir: "asc" as const },
  { label: "Name (Z → A)", sortBy: "first_name", sortDir: "desc" as const },
  { label: "Company (A → Z)", sortBy: "company_name_raw", sortDir: "asc" as const },
  { label: "Company (Z → A)", sortBy: "company_name_raw", sortDir: "desc" as const },
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
  const selectedIds = Object.keys(rowSelection).filter((k) => rowSelection[k]);

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
    }
    prevFilterFingerprint.current = fingerprint;
  }, [debouncedFilters]);

  return (
    <div className="flex flex-col h-[calc(100vh-7.5rem)]">
      {/* Filter bar below search */}
      <div className="-mx-4 -mt-4">
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
          onLoadPreset={loadPreset}
          onReset={resetFilters}
        />
      </div>

      {/* Header */}
      <div className="flex items-center justify-between py-3">
        <h1 className="text-lg font-semibold">Leads</h1>
        <div className="flex items-center gap-3">
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs text-muted-foreground cursor-pointer"
            value={`${filters.sortBy}:${filters.sortDir}`}
            onChange={(e) => {
              const [sortBy, sortDir] = e.target.value.split(":");
              setSort(sortBy, sortDir as "asc" | "desc");
            }}
          >
            <option value="created_at:desc" disabled>Sort by...</option>
            {SORT_OPTIONS.map((opt) => (
              <option key={`${opt.sortBy}:${opt.sortDir}`} value={`${opt.sortBy}:${opt.sortDir}`}>
                {opt.label}
              </option>
            ))}
          </select>
          <span
            className="text-xs text-muted-foreground"
            title={isApproximate ? "Approximate count (planner estimate, ±5%)" : undefined}
          >
            {isApproximate ? "~" : ""}{totalCount.toLocaleString()} total
          </span>
          <ExportButton filters={filters} totalCount={totalCount} selectedIds={selectedIds} />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0">
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
          onRowSelectionChange={setRowSelection}
        />
      </div>

      <LeadDetailPanel
        lead={selectedLead}
        open={selectedLead !== null}
        onClose={() => setSelectedLead(null)}
        onDeleted={() => { setSelectedLead(null); fetchLeads(); }}
      />
    </div>
  );
}
