"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { FilterGroup } from "./filter-group";
import { FilterText } from "./filter-text";
import { FilterMultiSelect } from "./filter-multi-select";
import { FilterRange } from "./filter-range";
import type { FilterState, IncludeExclude, RangeFilter } from "@/types/filters";
import { countActiveFilters } from "@/types/filters";
import {
  LEAD_SOURCES,
  COMPANY_SIZE_BUCKETS,
  REVENUE_BUCKETS,
  ESP_VALUES,
  SENIORITY_LEVELS,
  SENIORITY_LABELS,
} from "@/lib/filters/constants";

interface FilterSidebarProps {
  filters: FilterState;
  onTextChange: (field: "fullName" | "companyName" | "keyword", value: string) => void;
  onIncludeExcludeChange: (field: string, value: IncludeExclude) => void;
  onRangeChange: (field: "companySize" | "revenue", value: RangeFilter) => void;
  onLocationCountryChange: (value: IncludeExclude) => void;
  onLocationStateChange: (value: IncludeExclude) => void;
  onLocationCityChange: (value: string) => void;
  onFilterOperatorChange: (value: "AND" | "OR") => void;
  onReset: () => void;
}

export function FilterSidebar({
  filters,
  onTextChange,
  onIncludeExcludeChange,
  onRangeChange,
  onLocationCountryChange,
  onLocationStateChange,
  onLocationCityChange,
  onFilterOperatorChange,
  onReset,
}: FilterSidebarProps) {
  const activeCount = countActiveFilters(filters);
  const op = filters.filterOperator ?? "AND";

  return (
    <div className="w-64 shrink-0 border-r overflow-y-auto h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Filters</span>
          {activeCount > 0 && (
            <Badge variant="secondary" className="h-5 px-1.5 text-xs">
              {activeCount}
            </Badge>
          )}
        </div>
        {activeCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1"
            onClick={onReset}
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </Button>
        )}
      </div>

      {/* Global AND / OR toggle between fields */}
      <div className="px-3 py-2 border-b bg-muted/30">
        <p className="text-[10px] text-muted-foreground mb-1.5 uppercase tracking-wide font-medium">
          Match between fields
        </p>
        <div className="flex items-center border rounded overflow-hidden w-fit">
          <button
            type="button"
            onClick={() => onFilterOperatorChange("AND")}
            className={`px-3 py-1 text-xs font-semibold transition-colors ${
              op === "AND"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            AND
          </button>
          <button
            type="button"
            onClick={() => onFilterOperatorChange("OR")}
            className={`px-3 py-1 text-xs font-semibold transition-colors ${
              op === "OR"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            OR
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          {op === "AND"
            ? "All selected filters must match"
            : "Any selected filter can match"}
        </p>
      </div>

      {/* Full Name */}
      <FilterGroup title="Full Name" activeCount={filters.fullName ? 1 : 0} defaultOpen>
        <FilterText
          placeholder="Search name..."
          value={filters.fullName}
          onChange={(v) => onTextChange("fullName", v)}
        />
      </FilterGroup>

      {/* Company Name */}
      <FilterGroup title="Company" activeCount={filters.companyName ? 1 : 0} defaultOpen>
        <FilterText
          placeholder="Search company..."
          value={filters.companyName}
          onChange={(v) => onTextChange("companyName", v)}
        />
      </FilterGroup>

      {/* Source */}
      <FilterGroup
        title="Source"
        activeCount={filters.source.include.length + filters.source.exclude.length}
      >
        <FilterMultiSelect
          options={LEAD_SOURCES}
          value={filters.source}
          onChange={(v) => onIncludeExcludeChange("source", v)}
        />
      </FilterGroup>

      {/* Seniority */}
      <FilterGroup
        title="Seniority"
        activeCount={filters.seniority.include.length + filters.seniority.exclude.length}
      >
        <FilterMultiSelect
          options={SENIORITY_LEVELS}
          labels={SENIORITY_LABELS}
          value={filters.seniority}
          onChange={(v) => onIncludeExcludeChange("seniority", v)}
        />
      </FilterGroup>

      {/* General Industry */}
      <FilterGroup
        title="General Industry"
        activeCount={
          filters.generalIndustry.include.length + filters.generalIndustry.exclude.length
        }
      >
        <FilterMultiSelect
          options={[]}
          value={filters.generalIndustry}
          onChange={(v) => onIncludeExcludeChange("generalIndustry", v)}
          searchable
        />
      </FilterGroup>

      {/* Specific Industry */}
      <FilterGroup
        title="Specific Industry"
        activeCount={
          filters.specificIndustry.include.length + filters.specificIndustry.exclude.length
        }
      >
        <FilterMultiSelect
          options={[]}
          value={filters.specificIndustry}
          onChange={(v) => onIncludeExcludeChange("specificIndustry", v)}
          searchable
        />
      </FilterGroup>

      {/* Company Size */}
      <FilterGroup
        title="Company Size"
        activeCount={
          filters.companySize.buckets.length + (filters.companySize.includeUnknown ? 1 : 0)
        }
      >
        <FilterRange
          buckets={COMPANY_SIZE_BUCKETS}
          value={filters.companySize}
          onChange={(v) => onRangeChange("companySize", v)}
        />
      </FilterGroup>

      {/* Revenue */}
      <FilterGroup
        title="Revenue"
        activeCount={
          filters.revenue.buckets.length + (filters.revenue.includeUnknown ? 1 : 0)
        }
      >
        <FilterRange
          buckets={REVENUE_BUCKETS}
          value={filters.revenue}
          onChange={(v) => onRangeChange("revenue", v)}
        />
      </FilterGroup>

      {/* ESP */}
      <FilterGroup
        title="ESP"
        activeCount={filters.esp.include.length + filters.esp.exclude.length}
      >
        <FilterMultiSelect
          options={ESP_VALUES}
          value={filters.esp}
          onChange={(v) => onIncludeExcludeChange("esp", v)}
        />
      </FilterGroup>

      {/* Location */}
      <FilterGroup
        title="Location"
        activeCount={
          filters.location.country.include.length +
          filters.location.country.exclude.length +
          filters.location.state.include.length +
          filters.location.state.exclude.length +
          (filters.location.city ? 1 : 0)
        }
      >
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground">City</label>
          <FilterText
            placeholder="Search city..."
            value={filters.location.city}
            onChange={onLocationCityChange}
          />
        </div>
      </FilterGroup>

      {/* Keywords */}
      <FilterGroup title="Keywords" activeCount={filters.keyword ? 1 : 0}>
        <FilterText
          placeholder="Search keywords..."
          value={filters.keyword}
          onChange={(v) => onTextChange("keyword", v)}
        />
      </FilterGroup>
    </div>
  );
}
