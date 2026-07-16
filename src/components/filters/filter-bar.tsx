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
import type {
  FilterState,
  IncludeExclude,
  RangeFilter,
  KeywordFilter,
  EmailTypeFilter,
} from "@/types/filters";
import { countActiveFilters } from "@/types/filters";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { TagInput } from "@/components/ui/ios/tag-input";
import {
  COMPANY_SIZE_BUCKETS,
  REVENUE_BUCKETS,
  SENIORITY_LABELS,
} from "@/lib/filters/constants";
import { createClient } from "@/lib/supabase/client";

interface FilterBarProps {
  filters: FilterState;
  onTextChange: (field: "fullName" | "companyName", value: string) => void;
  onIncludeExcludeChange: (field: string, value: IncludeExclude) => void;
  onRangeChange: (field: "companySize" | "revenue", value: RangeFilter) => void;
  onLocationCountryChange: (value: IncludeExclude) => void;
  onLocationStateChange: (value: IncludeExclude) => void;
  onLocationCityChange: (value: string) => void;
  onFilterOperatorChange: (value: "AND" | "OR") => void;
  onToggleFlag: (field: "excludeEmptyName" | "excludeEmptyCompany" | "excludeEmptyOverview", value: boolean) => void;
  onKeywordChange: (value: KeywordFilter) => void;
  onEmailTypeChange: (value: EmailTypeFilter) => void;
  onIncludeBouncedChange: (value: boolean) => void;
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
  onKeywordChange,
  onEmailTypeChange,
  onIncludeBouncedChange,
  onLoadPreset,
  onReset,
}: FilterBarProps) {
  // Derive 3-way segmented control value from the {personal, general} pair
  const emailTypeValue: "personal" | "general" | "both" =
    filters.emailType.personal && filters.emailType.general
      ? "both"
      : filters.emailType.personal
      ? "personal"
      : "general";

  const handleEmailTypeChange = (v: "personal" | "general" | "both") => {
    if (v === "both") onEmailTypeChange({ personal: true, general: true });
    else if (v === "personal") onEmailTypeChange({ personal: true, general: false });
    else onEmailTypeChange({ personal: false, general: true });
  };

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
  const [categoryValues, setCategoryValues] = useState<string[]>([]);
  const [subcategoryValues, setSubcategoryValues] = useState<string[]>([]);

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
      case "title": setJobTitles(values); break;
      case "source": setSources(values); break;
      case "seniority": setSeniorities(values); break;
      case "esp": setEspValues([...new Set(values)]); break;
      case "category": setCategoryValues(values); break;
      case "subcategory": setSubcategoryValues(values); break;
    }
  }, []);

  // Live search: when user types in searchable filters, query DB for matching values
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const liveSearch = useCallback(async (col: string, term: string) => {
    if (!term || term.length < 2) {
      // Cancel any pending search so it can't overwrite the restored full list
      clearTimeout(searchTimeoutRef.current);
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
        case "title": setJobTitles(values); break;
        case "source": setSources(values); break;
        case "seniority": setSeniorities(values); break;
        case "esp": setEspValues([...new Set(values)]); break;
        case "category": setCategoryValues(values); break;
        case "subcategory": setSubcategoryValues(values); break;
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
        <FilterChip label="Company" activeCount={(filters.companyName ? 1 : 0) + (filters.excludeEmptyCompany ? 1 : 0)}>
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

        {/* Job Title — proper multi-select with standardized titles from DB */}
        <FilterChip
          label="Title"
          activeCount={filters.jobTitle.include.length + filters.jobTitle.exclude.length + (filters.jobTitle.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("title")}
        >
          <FilterMultiSelect
            options={jobTitles}
            value={filters.jobTitle}
            onChange={(v) => onIncludeExcludeChange("jobTitle", v)}
            searchable
            onSearch={(term) => liveSearch("title", term)}
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

        {/* Keywords — include + exclude, multi-field across company name / industries / overview */}
        <FilterChip
          label="Keywords"
          activeCount={filters.keyword.include.length + filters.keyword.exclude.length}
        >
          <div className="space-y-3">
            <div>
              <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Include
              </label>
              <TagInput
                values={filters.keyword.include}
                placeholder="e.g. cleaning, plumbing"
                onChange={(arr) =>
                  onKeywordChange({ ...filters.keyword, include: arr })
                }
              />
            </div>
            <div>
              <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Exclude
              </label>
              <TagInput
                values={filters.keyword.exclude}
                placeholder="e.g. restaurant"
                onChange={(arr) =>
                  onKeywordChange({ ...filters.keyword, exclude: arr })
                }
              />
            </div>
            <p className="px-1 text-[11px] text-muted-foreground">
              Matched against company name.
            </p>
          </div>
        </FilterChip>

        {/* Email type — Personal vs General vs Both (segmented control) */}
        <FilterChip
          label="Email Type"
          activeCount={filters.emailType.personal && filters.emailType.general ? 0 : 1}
        >
          <div className="space-y-3">
            <IosSegmentedControl
              fullWidth
              value={emailTypeValue}
              onChange={handleEmailTypeChange}
              options={[
                { value: "personal", label: "Personal" },
                { value: "general", label: "General" },
                { value: "both", label: "Both" },
              ]}
            />
            <p className="px-1 text-[11px] text-muted-foreground">
              <span className="font-medium text-foreground">Personal</span> = decision-maker;{" "}
              <span className="font-medium text-foreground">General</span> = role-based / shared inbox.
            </p>
          </div>
        </FilterChip>

        {/* Undeliverable leads: hard/policy bounces are hidden by default.
            Sender-side bounces (our inbox's fault) are auto-restored to
            contactable by the bounce worker, so they aren't affected. */}
        <FilterChip
          label="Bounced"
          activeCount={filters.includeBounced ? 1 : 0}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium">Include undeliverable</p>
              <p className="text-[12px] text-muted-foreground">
                Show leads whose email hard-bounced (invalid address or blocked
                by the recipient&apos;s policy). Bounces caused by our own sending
                inbox are restored automatically and stay visible. Exports always
                exclude undeliverable leads.
              </p>
            </div>
            <IosToggle
              checked={!!filters.includeBounced}
              onCheckedChange={onIncludeBouncedChange}
            />
          </div>
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

        {/* Category — populated by the categorize worker (lead_categories taxonomy) */}
        <FilterChip
          label="Category"
          activeCount={filters.category.include.length + filters.category.exclude.length + (filters.category.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("category")}
        >
          <FilterMultiSelect
            options={categoryValues}
            value={filters.category}
            onChange={(v) => onIncludeExcludeChange("category", v)}
          />
        </FilterChip>

        {/* Subcategory — Bison-enriched, second-level category */}
        <FilterChip
          label="Subcategory"
          activeCount={filters.subcategory.include.length + filters.subcategory.exclude.length + (filters.subcategory.includeUnknown ? 1 : 0)}
          onOpen={() => loadDistinctFor("subcategory")}
        >
          <FilterMultiSelect
            options={subcategoryValues}
            value={filters.subcategory}
            onChange={(v) => onIncludeExcludeChange("subcategory", v)}
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
