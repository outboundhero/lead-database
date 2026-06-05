"use client";

import { useCallback, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FilterText } from "./filter-text";
import { FilterMultiSelect } from "./filter-multi-select";
import { FilterRange } from "./filter-range";
import { FilterPresets } from "./filter-presets";
import type { FilterState, IncludeExclude, RangeFilter } from "@/types/filters";
import { countActiveFilters } from "@/types/filters";
import {
  COMPANY_SIZE_BUCKETS,
  REVENUE_BUCKETS,
  SENIORITY_LABELS,
} from "@/lib/filters/constants";
import { createClient } from "@/lib/supabase/client";

interface FilterBarProps {
  filters: FilterState;
  onTextChange: (field: "fullName" | "companyName" | "keyword", value: string) => void;
  onIncludeExcludeChange: (field: string, value: IncludeExclude) => void;
  onRangeChange: (field: "companySize" | "revenue", value: RangeFilter) => void;
  onLocationCountryChange: (value: IncludeExclude) => void;
  onLocationStateChange: (value: IncludeExclude) => void;
  onLocationCityChange: (value: string) => void;
  onFilterOperatorChange: (value: "AND" | "OR") => void;
  onToggleFlag: (field: "excludeEmptyName" | "excludeEmptyCompany" | "excludeEmptyOverview", value: boolean) => void;
  onLoadPreset?: (filters: FilterState) => void;
  onReset: () => void;
}

function FilterChip({
  label,
  activeCount,
  children,
  onOpen,
}: {
  label: string;
  activeCount: number;
  children: React.ReactNode;
  onOpen?: () => void;
}) {
  const active = activeCount > 0;
  return (
    <Popover onOpenChange={(open) => { if (open && onOpen) onOpen(); }}>
      <PopoverTrigger asChild>
        <button
          className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all active:scale-[0.97] ${
            active
              ? "bg-primary/12 text-primary"
              : "bg-muted text-foreground hover:bg-accent"
          }`}
        >
          {label}
          {active && (
            <Badge variant="tinted" className="h-4 min-w-4 rounded-full px-1.5 text-[10px]">
              {activeCount}
            </Badge>
          )}
          <ChevronDown className="size-3 opacity-60" strokeWidth={2.25} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        {children}
      </PopoverContent>
    </Popover>
  );
}

export function FilterBar({
  filters,
  onTextChange,
  onIncludeExcludeChange,
  onRangeChange,
  onLocationCountryChange,
  onLocationStateChange,
  onLocationCityChange,
  onFilterOperatorChange,
  onToggleFlag,
  onLoadPreset,
  onReset,
}: FilterBarProps) {
  const activeCount = countActiveFilters(filters);
  const op = filters.filterOperator ?? "AND";

  // Dynamic options loaded from DB
  const [generalIndustries, setGeneralIndustries] = useState<string[]>([]);
  const [specificIndustries, setSpecificIndustries] = useState<string[]>([]);
  const [countries, setCountries] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [seniorities, setSeniorities] = useState<string[]>([]);
  const [espValues, setEspValues] = useState<string[]>([]);

  // Lazy-load distinct values only when a dropdown is opened (not on page load).
  // Uses cached values from filter_options_cache table.
  const loadedRef = useRef<Set<string>>(new Set());

  const loadDistinctFor = useCallback(async (col: string) => {
    if (loadedRef.current.has(col)) return;
    loadedRef.current.add(col);

    // Specific industry has 400K+ values — skip preload, search-only
    if (col === "specific_industry") return;

    const supabase = createClient();
    const { data } = await supabase.rpc("distinct_values", { col_name: col });
    if (!data) return;
    let values = data as string[];

    // Deduplicate case-insensitively (keep first occurrence's casing)
    if (["general_industry", "specific_industry", "country", "state"].includes(col)) {
      const seen = new Map<string, string>();
      for (const v of values) {
        const key = v.toLowerCase();
        if (!seen.has(key)) seen.set(key, v);
      }
      values = [...seen.values()];
    }

    switch (col) {
      case "general_industry": setGeneralIndustries(values); break;
      case "specific_industry": setSpecificIndustries(values); break;
      case "country": setCountries(values); break;
      case "state": setStates(values); break;
      case "job_title": setJobTitles(values); break;
      case "source": setSources(values); break;
      case "seniority": setSeniorities(values); break;
      case "esp": setEspValues([...new Set(values)]); break;
    }
  }, []);

  // Live search: when user types in searchable filters, query DB for matching values
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const liveSearch = useCallback(async (col: string, term: string) => {
    if (!term || term.length < 2) {
      // Reset to cached values
      loadedRef.current.delete(col);
      loadDistinctFor(col);
      return;
    }
    clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(async () => {
      const supabase = createClient();
      const { data } = await supabase.rpc("search_column_values", {
        col_name: col,
        search_term: term,
        max_results: 50,
      });
      if (!data) return;
      const values = data as string[];
      // Mark as not loaded so next popover open reloads the full list
      loadedRef.current.delete(col);
      switch (col) {
        case "general_industry": setGeneralIndustries(values); break;
        case "specific_industry": setSpecificIndustries(values); break;
        case "country": setCountries(values); break;
        case "state": setStates(values); break;
        case "job_title": setJobTitles(values); break;
        case "source": setSources(values); break;
        case "seniority": setSeniorities(values); break;
        case "esp": setEspValues([...new Set(values)]); break;
      }
    }, 300);
  }, [loadDistinctFor]);

  return (
    <div className="ios-frost sticky top-0 z-20 space-y-2 border-b border-border/40 px-6 py-3">
      {/* Chips row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* AND/OR — iOS segmented control */}
        <div className="mr-1 inline-flex h-8 items-center rounded-full bg-muted p-0.5">
          {(["AND", "OR"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => onFilterOperatorChange(value)}
              className={`rounded-full px-3 text-[12px] font-semibold transition-all ${
                op === value
                  ? "bg-card text-foreground shadow-[0_2px_6px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {value}
            </button>
          ))}
        </div>

        {/* Enter Name */}
        <FilterChip label="Enter Name" activeCount={(filters.fullName ? 1 : 0) + (filters.excludeEmptyName ? 1 : 0)}>
          <FilterText
            placeholder="Search name..."
            value={filters.fullName}
            onChange={(v) => onTextChange("fullName", v)}
          />
          <label className="flex items-center gap-2 mt-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={filters.excludeEmptyName}
              onChange={() => onToggleFlag("excludeEmptyName", !filters.excludeEmptyName)}
              className="rounded"
            />
            <span className="text-muted-foreground">Exclude leads without names</span>
          </label>
        </FilterChip>

        {/* Source — dynamic from DB */}
        <FilterChip
          label="Source"
          activeCount={filters.source.include.length + filters.source.exclude.length + (filters.source.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("source")}
        >
          <FilterMultiSelect
            options={sources}
            value={filters.source}
            onChange={(v) => onIncludeExcludeChange("source", v)}
          />
        </FilterChip>

        {/* Company Name */}
        <FilterChip label="Company Name" activeCount={(filters.companyName ? 1 : 0) + (filters.excludeEmptyCompany ? 1 : 0)}>
          <FilterText
            placeholder="Search company..."
            value={filters.companyName}
            onChange={(v) => onTextChange("companyName", v)}
          />
          <label className="flex items-center gap-2 mt-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={filters.excludeEmptyCompany}
              onChange={() => onToggleFlag("excludeEmptyCompany", !filters.excludeEmptyCompany)}
              className="rounded"
            />
            <span className="text-muted-foreground">Exclude leads without company</span>
          </label>
        </FilterChip>

        {/* Company Description */}
        <FilterChip label="Company Description" activeCount={filters.excludeEmptyOverview ? 1 : 0}>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={filters.excludeEmptyOverview}
              onChange={() => onToggleFlag("excludeEmptyOverview", !filters.excludeEmptyOverview)}
              className="rounded"
            />
            <span className="text-muted-foreground">Only leads with company description</span>
          </label>
        </FilterChip>

        {/* General Industry — dynamic from DB */}
        <FilterChip
          label="General Industry"
          activeCount={filters.generalIndustry.include.length + filters.generalIndustry.exclude.length + (filters.generalIndustry.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("general_industry")}
        >
          <FilterMultiSelect
            options={generalIndustries}
            value={filters.generalIndustry}
            onChange={(v) => onIncludeExcludeChange("generalIndustry", v)}
            searchable
            onSearch={(term) => liveSearch("general_industry", term)}
          />
        </FilterChip>

        {/* Specific Industry — dynamic from DB */}
        <FilterChip
          label="Specific Industry"
          activeCount={filters.specificIndustry.include.length + filters.specificIndustry.exclude.length + (filters.specificIndustry.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("specific_industry")}
        >
          <FilterMultiSelect
            options={specificIndustries}
            value={filters.specificIndustry}
            onChange={(v) => onIncludeExcludeChange("specificIndustry", v)}
            searchable
            onSearch={(term) => liveSearch("specific_industry", term)}
          />
        </FilterChip>

        {/* Job Title — proper multi-select with standardized titles from DB */}
        <FilterChip
          label="Job Title"
          activeCount={filters.jobTitle.include.length + filters.jobTitle.exclude.length + (filters.jobTitle.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("job_title")}
        >
          <FilterMultiSelect
            options={jobTitles}
            value={filters.jobTitle}
            onChange={(v) => onIncludeExcludeChange("jobTitle", v)}
            searchable
            onSearch={(term) => liveSearch("job_title", term)}
          />
        </FilterChip>

        {/* Seniority — dynamic from DB */}
        <FilterChip
          label="Seniority"
          activeCount={filters.seniority.include.length + filters.seniority.exclude.length + (filters.seniority.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("seniority")}
        >
          <FilterMultiSelect
            options={seniorities}
            labels={SENIORITY_LABELS}
            value={filters.seniority}
            onChange={(v) => onIncludeExcludeChange("seniority", v)}
          />
        </FilterChip>

        {/* Company Size */}
        <FilterChip
          label="Company Size"
          activeCount={filters.companySize.buckets.length + (filters.companySize.includeUnknown ? 1 : 0) + (filters.companySize.customMin != null || filters.companySize.customMax != null ? 1 : 0)}
        >
          <FilterRange
            buckets={COMPANY_SIZE_BUCKETS}
            value={filters.companySize}
            onChange={(v) => onRangeChange("companySize", v)}
            showCustomRange
          />
        </FilterChip>

        {/* Country — dynamic from DB */}
        <FilterChip
          label="Country"
          activeCount={filters.location.country.include.length + filters.location.country.exclude.length + (filters.location.country.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("country")}
        >
          <FilterMultiSelect
            options={countries}
            value={filters.location.country}
            onChange={onLocationCountryChange}
            searchable
            onSearch={(term) => liveSearch("country", term)}
          />
        </FilterChip>

        {/* City */}
        <FilterChip label="City" activeCount={filters.location.city ? 1 : 0}>
          <FilterText
            placeholder="Search city..."
            value={filters.location.city}
            onChange={onLocationCityChange}
          />
        </FilterChip>

        {/* State — dynamic from DB */}
        <FilterChip
          label="State"
          activeCount={filters.location.state.include.length + filters.location.state.exclude.length + (filters.location.state.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("state")}
        >
          <FilterMultiSelect
            options={states}
            value={filters.location.state}
            onChange={onLocationStateChange}
            searchable
            onSearch={(term) => liveSearch("state", term)}
          />
        </FilterChip>

        {/* Annual Revenue */}
        <FilterChip
          label="Annual Revenue"
          activeCount={filters.revenue.buckets.length + (filters.revenue.includeUnknown ? 1 : 0)}
        >
          <FilterRange
            buckets={REVENUE_BUCKETS}
            value={filters.revenue}
            onChange={(v) => onRangeChange("revenue", v)}
          />
        </FilterChip>

        {/* Keywords */}
        <FilterChip label="Keywords" activeCount={filters.keyword ? 1 : 0}>
          <FilterText
            placeholder="Search keywords..."
            value={filters.keyword}
            onChange={(v) => onTextChange("keyword", v)}
          />
        </FilterChip>

        {/* ESP — dynamic from DB */}
        <FilterChip
          label="Email Service Provider"
          activeCount={filters.esp.include.length + filters.esp.exclude.length + (filters.esp.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("esp")}
        >
          <FilterMultiSelect
            options={espValues}
            value={filters.esp}
            onChange={(v) => onIncludeExcludeChange("esp", v)}
          />
        </FilterChip>

        {/* Presets */}
        {onLoadPreset && (
          <FilterPresets currentFilters={filters} onLoadPreset={onLoadPreset} />
        )}

        {/* Reset */}
        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-destructive hover:bg-destructive/10"
            onClick={onReset}
          >
            <RotateCcw className="size-3.5" strokeWidth={2} />
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}
