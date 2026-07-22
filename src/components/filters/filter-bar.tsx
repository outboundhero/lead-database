"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, RotateCcw, Search, SlidersHorizontal, Eye, EyeOff, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FilterText } from "./filter-text";
import { FilterMultiSelect } from "./filter-multi-select";
import { FilterPresets } from "./filter-presets";
import type {
  FilterState,
  IncludeExclude,
  RangeFilter,
  KeywordFilter,
  EmailTypeFilter,
  EmailContainsFilter,
  CategorySearchFilter,
} from "@/types/filters";
import { countActiveFilters } from "@/types/filters";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { TagInput } from "@/components/ui/ios/tag-input";
import { useHiddenFilters } from "@/lib/hooks/use-hidden-filters";
import { createClient } from "@/lib/supabase/client";

interface FilterBarProps {
  filters: FilterState;
  onTextChange: (field: "fullName" | "companyName", value: string) => void;
  onIncludeExcludeChange: (field: string, value: IncludeExclude) => void;
  onRangeChange: (field: "companySize" | "revenue", value: RangeFilter) => void;
  onLocationCountryChange: (value: IncludeExclude) => void;
  onLocationStateChange: (value: IncludeExclude) => void;
  onLocationCityChange: (value: IncludeExclude) => void;
  onFilterOperatorChange: (value: "AND" | "OR") => void;
  onToggleFlag: (field: "excludeEmptyName" | "excludeEmptyCompany" | "excludeEmptyOverview", value: boolean) => void;
  onKeywordChange: (value: KeywordFilter) => void;
  onEmailTypeChange: (value: EmailTypeFilter) => void;
  onEmailContainsChange: (value: EmailContainsFilter) => void;
  onCategorySearchChange: (value: CategorySearchFilter) => void;
  onGlobalSearchChange: (value: string) => void;
  onIncludeBouncedChange: (value: boolean) => void;
  onLoadPreset?: (filters: FilterState) => void;
  onReset: () => void;
}

// Every chip that can be hidden/unhidden via the "Manage filters" control.
// Order here is the order shown in the manage popover.
const HIDEABLE_CHIPS: { key: string; label: string }[] = [
  { key: "name", label: "Enter Name" },
  { key: "source", label: "Source" },
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "keywords", label: "Keywords" },
  { key: "emailContains", label: "Email Contains" },
  { key: "categorySearch", label: "Category Search" },
  { key: "emailType", label: "Email Type" },
  { key: "bounced", label: "Bounced" },
  { key: "esp", label: "Email Service Provider" },
  { key: "category", label: "Category" },
  { key: "subcategory", label: "Subcategory" },
  { key: "additionalCategory", label: "Additional Category" },
  { key: "tags", label: "Tags" },
];

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
              ? "bg-primary text-primary-foreground shadow-[0_2px_8px_rgba(0,122,255,0.28)]"
              : "bg-muted text-foreground hover:bg-accent"
          }`}
        >
          {label}
          {active && (
            <Badge className="h-4 min-w-4 rounded-full border-0 bg-white/25 px-1.5 text-[10px] text-primary-foreground">
              {activeCount}
            </Badge>
          )}
          <ChevronDown
            className={`size-3 ${active ? "opacity-80" : "opacity-60"}`}
            strokeWidth={2.25}
          />
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
  onEmailContainsChange,
  onCategorySearchChange,
  onGlobalSearchChange,
  onIncludeBouncedChange,
  onLoadPreset,
  onReset,
}: FilterBarProps) {
  void onLocationCountryChange;
  const { isHidden, toggle } = useHiddenFilters();

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

  const keywordMode: "contains" | "exact" = filters.keyword.matchMode === "exact" ? "exact" : "contains";

  const activeCount = countActiveFilters(filters);
  const op = filters.filterOperator ?? "AND";

  // Global search — debounced local draft so keystrokes don't thrash the
  // whole filter state (the page also debounces the fetch).
  const [globalDraft, setGlobalDraft] = useState(filters.globalSearch);
  const lastEmittedGlobal = useRef(filters.globalSearch);
  const globalTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    // Sync from external changes (reset / preset load) without clobbering typing.
    if (filters.globalSearch !== lastEmittedGlobal.current) {
      lastEmittedGlobal.current = filters.globalSearch;
      setGlobalDraft(filters.globalSearch);
    }
  }, [filters.globalSearch]);
  const handleGlobalChange = (v: string) => {
    setGlobalDraft(v);
    clearTimeout(globalTimer.current);
    globalTimer.current = setTimeout(() => {
      lastEmittedGlobal.current = v;
      onGlobalSearchChange(v);
    }, 300);
  };

  // Dynamic options loaded from DB
  const [countries, setCountries] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [espValues, setEspValues] = useState<string[]>([]);
  const [categoryValues, setCategoryValues] = useState<string[]>([]);
  const [subcategoryValues, setSubcategoryValues] = useState<string[]>([]);
  const [additionalCategoryValues, setAdditionalCategoryValues] = useState<string[]>([]);
  const [cityValues, setCityValues] = useState<string[]>([]);
  const [clientTagOptions, setClientTagOptions] = useState<string[]>([]);
  void countries;

  // Lazy-load distinct values only when a dropdown is opened (not on page load).
  // Uses cached values from filter_options_cache table.
  const loadedRef = useRef<Set<string>>(new Set());

  const applyValues = useCallback((col: string, values: string[]) => {
    switch (col) {
      case "country": setCountries(values); break;
      case "state": setStates(values); break;
      case "title": setJobTitles(values); break;
      case "source": setSources(values); break;
      case "esp": setEspValues([...new Set(values)]); break;
      case "category": setCategoryValues(values); break;
      case "subcategory": setSubcategoryValues(values); break;
      case "additional_category": setAdditionalCategoryValues(values); break;
      case "city": setCityValues(values); break;
    }
  }, []);

  const loadDistinctFor = useCallback(async (col: string) => {
    if (loadedRef.current.has(col)) return;
    loadedRef.current.add(col);

    // City is unbounded (100K+ distinct) — search-only, no preload.
    if (col === "city") return;

    const supabase = createClient();
    const { data } = await supabase.rpc("distinct_values", { col_name: col });
    if (!data) return;
    let values = data as string[];

    // Deduplicate case-insensitively (keep first occurrence's casing)
    if (["country", "state"].includes(col)) {
      const seen = new Map<string, string>();
      for (const v of values) {
        const key = v.toLowerCase();
        if (!seen.has(key)) seen.set(key, v);
      }
      values = [...seen.values()];
    }

    applyValues(col, values);
  }, [applyValues]);

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
      applyValues(col, values);
    }, 300);
  }, [loadDistinctFor, applyValues]);

  // Client tags for the Tags chip's quick-pick list. Fetched from the Bison
  // client-tags proxy; falls back silently to free-typing only if unavailable.
  const clientTagsLoadedRef = useRef(false);
  const loadClientTags = useCallback(async () => {
    if (clientTagsLoadedRef.current) return;
    clientTagsLoadedRef.current = true;
    try {
      const res = await fetch("/api/bison/client-tags");
      if (!res.ok) return;
      const json = (await res.json()) as { tags?: { tag: string }[] };
      const tags = (json.tags ?? [])
        .map((t) => t?.tag)
        .filter((t): t is string => typeof t === "string" && t.length > 0);
      setClientTagOptions([...new Set(tags)]);
    } catch {
      /* proxy not ready — free typing still works */
    }
  }, []);

  const cityActive = filters.location.city.include.length + filters.location.city.exclude.length;
  const hiddenActiveCount = HIDEABLE_CHIPS.filter((c) => isHidden(c.key)).length;

  return (
    <div className="ios-frost sticky top-0 z-20 space-y-2 border-b border-border/40 px-6 py-3">
      {/* Global search */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          strokeWidth={1.75}
        />
        <Input
          placeholder="Search everything — email, company, name, domain, category… (comma-separated)"
          value={globalDraft}
          onChange={(e) => handleGlobalChange(e.target.value)}
          className="h-9 pl-9 pr-9"
        />
        {globalDraft && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => handleGlobalChange("")}
            className="absolute top-1/2 right-2.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <X className="size-3.5" strokeWidth={2.25} />
          </button>
        )}
      </div>

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
        {!isHidden("name") && (
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
        )}

        {/* Source — dynamic from DB */}
        {!isHidden("source") && (
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
        )}

        {/* Company Name */}
        {!isHidden("company") && (
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
        )}

        {/* Job Title — proper multi-select with standardized titles from DB */}
        {!isHidden("title") && (
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
        )}

        {/* City — now include/exclude (search-only, unbounded distinct) */}
        {!isHidden("city") && (
          <FilterChip
            label="City"
            activeCount={cityActive}
            onOpen={() => loadDistinctFor("city")}
          >
            <FilterMultiSelect
              options={cityValues}
              value={filters.location.city}
              onChange={onLocationCityChange}
              searchable
              onSearch={(term) => liveSearch("city", term)}
            />
          </FilterChip>
        )}

        {/* State — dynamic from DB */}
        {!isHidden("state") && (
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
        )}

        {/* Keywords — include + exclude, with a Contains vs Exact match toggle */}
        {!isHidden("keywords") && (
          <FilterChip
            label="Keywords"
            activeCount={filters.keyword.include.length + filters.keyword.exclude.length}
          >
            <div className="space-y-3">
              <div>
                <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Match mode
                </label>
                <IosSegmentedControl
                  fullWidth
                  value={keywordMode}
                  onChange={(v: "contains" | "exact") =>
                    onKeywordChange({ ...filters.keyword, matchMode: v })
                  }
                  options={[
                    { value: "contains", label: "Contains" },
                    { value: "exact", label: "Exact terms" },
                  ]}
                />
                <p
                  className="mt-1.5 px-1 text-[11px] text-muted-foreground"
                  title={
                    "Exact = whole-term matching. “dry cleaner” won’t match a bare “cleaner”, " +
                    "but “house” still catches “housecleaning” (word-start). " +
                    "Contains = loose substring anywhere in company / industries / overview."
                  }
                >
                  <span className="font-medium text-foreground">Exact</span> = whole-term (
                  <span className="italic">dry cleaner</span> won&apos;t match bare{" "}
                  <span className="italic">cleaner</span>; <span className="italic">house</span> matches{" "}
                  <span className="italic">housecleaning</span>).{" "}
                  <span className="font-medium text-foreground">Contains</span> = loose substring.
                </p>
              </div>
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
            </div>
          </FilterChip>
        )}

        {/* Email contains — free-text include/exclude on email + domain */}
        {!isHidden("emailContains") && (
          <FilterChip
            label="Email Contains"
            activeCount={filters.emailContains.include.length + filters.emailContains.exclude.length}
          >
            <div className="space-y-3">
              <div>
                <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Include
                </label>
                <TagInput
                  values={filters.emailContains.include}
                  placeholder="e.g. walmart.com, .gov"
                  onChange={(arr) =>
                    onEmailContainsChange({ ...filters.emailContains, include: arr })
                  }
                />
              </div>
              <div>
                <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Exclude
                </label>
                <TagInput
                  values={filters.emailContains.exclude}
                  placeholder="e.g. weebly.com"
                  onChange={(arr) =>
                    onEmailContainsChange({ ...filters.emailContains, exclude: arr })
                  }
                />
              </div>
              <p className="px-1 text-[11px] text-muted-foreground">
                Substring match against the lead&apos;s email address / domain.
              </p>
            </div>
          </FilterChip>
        )}

        {/* Category Search — type a term, Enter; matches category/subcategory/additional */}
        {!isHidden("categorySearch") && (
          <FilterChip
            label="Category Search"
            activeCount={filters.categorySearch.include.length + filters.categorySearch.exclude.length}
          >
            <div className="space-y-3">
              <div>
                <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Include
                </label>
                <TagInput
                  values={filters.categorySearch.include}
                  placeholder="e.g. dry, school, restaurant"
                  onChange={(arr) =>
                    onCategorySearchChange({ ...filters.categorySearch, include: arr })
                  }
                />
              </div>
              <div>
                <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Exclude
                </label>
                <TagInput
                  values={filters.categorySearch.exclude}
                  placeholder="e.g. pre, mobile"
                  onChange={(arr) =>
                    onCategorySearchChange({ ...filters.categorySearch, exclude: arr })
                  }
                />
              </div>
              <p className="px-1 text-[11px] text-muted-foreground">
                Type a term and press Enter — matches anywhere in category,
                subcategory, or additional category (e.g. &quot;dry&quot; finds all dry cleaners).
              </p>
            </div>
          </FilterChip>
        )}

        {/* Email type — Personal vs General vs Both (segmented control) */}
        {!isHidden("emailType") && (
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
        )}

        {/* Undeliverable leads: hard/policy bounces are hidden by default.
            Sender-side bounces (our inbox's fault) are auto-restored to
            contactable by the bounce worker, so they aren't affected. */}
        {!isHidden("bounced") && (
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
        )}

        {/* ESP — dynamic from DB */}
        {!isHidden("esp") && (
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
        )}

        {/* Category — populated by the categorize worker (lead_categories taxonomy) */}
        {!isHidden("category") && (
          <FilterChip
            label="Category"
            activeCount={filters.category.include.length + filters.category.exclude.length + (filters.category.includeUnknown ? 1 : 0)}
            onOpen={() => loadDistinctFor("category")}
          >
            <FilterMultiSelect
              options={categoryValues}
              value={filters.category}
              onChange={(v) => onIncludeExcludeChange("category", v)}
              searchable
              onSearch={(term) => liveSearch("category", term)}
            />
          </FilterChip>
        )}

        {/* Subcategory — Bison-enriched, second-level category */}
        {!isHidden("subcategory") && (
          <FilterChip
            label="Subcategory"
            activeCount={filters.subcategory.include.length + filters.subcategory.exclude.length + (filters.subcategory.includeUnknown ? 1 : 0)}
            onOpen={() => loadDistinctFor("subcategory")}
          >
            <FilterMultiSelect
              options={subcategoryValues}
              value={filters.subcategory}
              onChange={(v) => onIncludeExcludeChange("subcategory", v)}
              searchable
              onSearch={(term) => liveSearch("subcategory", term)}
            />
          </FilterChip>
        )}

        {/* Additional Category — third-level Bison personalization variable */}
        {!isHidden("additionalCategory") && (
          <FilterChip
            label="Additional Category"
            activeCount={filters.additionalCategory.include.length + filters.additionalCategory.exclude.length + (filters.additionalCategory.includeUnknown ? 1 : 0)}
            onOpen={() => loadDistinctFor("additional_category")}
          >
            <FilterMultiSelect
              options={additionalCategoryValues}
              value={filters.additionalCategory}
              onChange={(v) => onIncludeExcludeChange("additionalCategory", v)}
              searchable
              onSearch={(term) => liveSearch("additional_category", term)}
            />
          </FilterChip>
        )}

        {/* Tags — client tags (substring, server-side) + free typing */}
        {!isHidden("tags") && (
          <FilterChip
            label="Tags"
            activeCount={filters.tags.include.length + filters.tags.exclude.length}
            onOpen={loadClientTags}
          >
            <div className="space-y-3">
              <div>
                <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Include
                </label>
                <TagInput
                  values={filters.tags.include}
                  placeholder="Type a tag, press Enter"
                  onChange={(arr) =>
                    onIncludeExcludeChange("tags", { ...filters.tags, include: arr })
                  }
                />
              </div>
              <div>
                <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Exclude
                </label>
                <TagInput
                  values={filters.tags.exclude}
                  placeholder="Tag to exclude"
                  onChange={(arr) =>
                    onIncludeExcludeChange("tags", { ...filters.tags, exclude: arr })
                  }
                />
              </div>
              {clientTagOptions.length > 0 && (
                <div>
                  <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Client tags
                  </label>
                  <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto">
                    {clientTagOptions.map((tag) => {
                      const picked = filters.tags.include.includes(tag);
                      return (
                        <button
                          key={tag}
                          type="button"
                          onClick={() =>
                            onIncludeExcludeChange("tags", {
                              ...filters.tags,
                              include: picked
                                ? filters.tags.include.filter((t) => t !== tag)
                                : [...filters.tags.include, tag],
                            })
                          }
                          className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                            picked
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-foreground hover:bg-accent"
                          }`}
                        >
                          {tag}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className="px-1 text-[11px] text-muted-foreground">
                Substring match against the lead&apos;s tags.
              </p>
            </div>
          </FilterChip>
        )}

        {/* Manage filters — hide / unhide chips */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              className="inline-flex h-8 items-center gap-1.5 rounded-full bg-muted px-3.5 text-[13px] font-medium text-foreground transition-all hover:bg-accent active:scale-[0.97]"
              title="Show or hide filter chips"
            >
              <SlidersHorizontal className="size-3.5 opacity-70" strokeWidth={2} />
              Manage
              {hiddenActiveCount > 0 && (
                <Badge variant="tinted" className="h-4 min-w-4 rounded-full px-1.5 text-[10px]">
                  {hiddenActiveCount}
                </Badge>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56">
            <p className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Show / hide filters
            </p>
            <div className="max-h-72 space-y-0.5 overflow-y-auto">
              {HIDEABLE_CHIPS.map((chip) => {
                const hidden = isHidden(chip.key);
                return (
                  <button
                    key={chip.key}
                    type="button"
                    onClick={() => toggle(chip.key)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-muted/60"
                  >
                    <span className={hidden ? "text-muted-foreground line-through" : "text-foreground"}>
                      {chip.label}
                    </span>
                    {hidden ? (
                      <EyeOff className="size-3.5 text-muted-foreground" strokeWidth={2} />
                    ) : (
                      <Eye className="size-3.5 text-primary" strokeWidth={2} />
                    )}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>

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
