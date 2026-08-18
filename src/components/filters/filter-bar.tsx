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
  CustomTagsFilter,
  WebsiteFilter,
  RangeFilter,
  KeywordFilter,
  EmailTypeFilter,
  EmailContainsFilter,
  CategorySearchFilter,
  LocationTargetEntry,
  LocationTargetsFilter,
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
  onToggleFlag: (field: "excludeEmptyName" | "excludeEmptyCompany" | "excludeEmptyOverview" | "commercialCleaning", value: boolean) => void;
  onKeywordChange: (value: KeywordFilter) => void;
  onEmailTypeChange: (value: EmailTypeFilter) => void;
  onEmailContainsChange: (value: EmailContainsFilter) => void;
  onCategorySearchChange: (value: CategorySearchFilter) => void;
  onCustomTagsChange: (value: CustomTagsFilter) => void;
  onWebsiteChange: (value: WebsiteFilter) => void;
  onGlobalSearchChange: (value: string) => void;
  onIncludeBouncedChange: (value: boolean) => void;
  onLoadPreset?: (filters: FilterState) => void;
  // Fired when a client tag is SELECTED from the quick-pick list (not on
  // deselect, free typing, or preset load) — the leads page uses it to
  // auto-apply that client's targeting rules to the other filters.
  onClientTagSelected?: (tag: string) => void;
  onLocationTargetsChange?: (value: LocationTargetsFilter) => void;
  // onCategoryCascadeChange: removed with the merged Category chip (2026-08-19).
  // categoryCascade remains in FilterState + buildRpcFilters so old saved
  // searches still resolve; there is simply no UI to switch it on any more.
  onClientTagChange?: (tag: string | null) => void;
  onReset: () => void;
}

const TARGET_COUNTRY_LABELS: Record<string, string> = {
  US: "USA", CA: "Canada", AU: "Australia", NZ: "New Zealand", GB: "United Kingdom", IE: "Ireland",
};

const LIST_TARGET_LABEL: Record<string, string> = {
  titles: "Title exclude",
  keywords: "Keywords exclude",
  competitors: "Keywords exclude",
  domains: "Website exclude",
  gateways: "ESP exclude",
};

function targetEntryLabel(e: LocationTargetEntry): string {
  const country = TARGET_COUNTRY_LABELS[e.country] ?? e.country;
  if (e.city) return e.country === "US" ? `${e.city}, ${e.state}` : `${e.city}, ${e.state}, ${country}`;
  if (e.state) return e.country === "US" ? (STATE_NAMES[e.state] ?? e.state) : `${e.state}, ${country}`;
  return country;
}

// Tiny Contains/Exact toggle used beside Include/Exclude labels in the
// tag-input chips (per-side match modes, migration 062).
function SideModeToggle({
  value,
  onChange,
}: {
  value: "contains" | "exact";
  onChange: (v: "contains" | "exact") => void;
}) {
  return (
    <span className="ml-auto inline-flex items-center gap-0.5 rounded border overflow-hidden">
      {(["contains", "exact"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={`h-4.5 px-1.5 text-[10px] font-medium capitalize transition-colors ${
            value === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
          }`}
        >
          {m}
        </button>
      ))}
    </span>
  );
}

// Full display names for the State chip — DB stores 2-letter codes (post
// 2026-07 normalization), the dropdown shows "California (CA)".
const STATE_NAMES: Record<string, string> = {
  AL: "Alabama (AL)", AK: "Alaska (AK)", AZ: "Arizona (AZ)", AR: "Arkansas (AR)",
  CA: "California (CA)", CO: "Colorado (CO)", CT: "Connecticut (CT)", DE: "Delaware (DE)",
  FL: "Florida (FL)", GA: "Georgia (GA)", HI: "Hawaii (HI)", ID: "Idaho (ID)",
  IL: "Illinois (IL)", IN: "Indiana (IN)", IA: "Iowa (IA)", KS: "Kansas (KS)",
  KY: "Kentucky (KY)", LA: "Louisiana (LA)", ME: "Maine (ME)", MD: "Maryland (MD)",
  MA: "Massachusetts (MA)", MI: "Michigan (MI)", MN: "Minnesota (MN)", MS: "Mississippi (MS)",
  MO: "Missouri (MO)", MT: "Montana (MT)", NE: "Nebraska (NE)", NV: "Nevada (NV)",
  NH: "New Hampshire (NH)", NJ: "New Jersey (NJ)", NM: "New Mexico (NM)", NY: "New York (NY)",
  NC: "North Carolina (NC)", ND: "North Dakota (ND)", OH: "Ohio (OH)", OK: "Oklahoma (OK)",
  OR: "Oregon (OR)", PA: "Pennsylvania (PA)", RI: "Rhode Island (RI)", SC: "South Carolina (SC)",
  SD: "South Dakota (SD)", TN: "Tennessee (TN)", TX: "Texas (TX)", UT: "Utah (UT)",
  VT: "Vermont (VT)", VA: "Virginia (VA)", WA: "Washington (WA)", WV: "West Virginia (WV)",
  WI: "Wisconsin (WI)", WY: "Wyoming (WY)", DC: "Washington DC (DC)",
  PR: "Puerto Rico (PR)", GU: "Guam (GU)", VI: "U.S. Virgin Islands (VI)",
  AS: "American Samoa (AS)", MP: "Northern Mariana Islands (MP)",
  // Canada
  AB: "Alberta (AB)", BC: "British Columbia (BC)", MB: "Manitoba (MB)",
  NB: "New Brunswick (NB)", NL: "Newfoundland and Labrador (NL)", NS: "Nova Scotia (NS)",
  NT: "Northwest Territories (NT)", NU: "Nunavut (NU)", ON: "Ontario (ON)",
  PE: "Prince Edward Island (PE)", QC: "Quebec (QC)", SK: "Saskatchewan (SK)", YT: "Yukon (YT)",
};

// Every chip that can be hidden/unhidden via the "Manage filters" control.
// Order here is the order shown in the manage popover.
const HIDEABLE_CHIPS: { key: string; label: string }[] = [
  { key: "name", label: "Enter Name" },
  { key: "source", label: "Source" },
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "categorySearch", label: "Category" },
  { key: "keywords", label: "Keywords" },
  { key: "emailContains", label: "Email Contains" },
  { key: "website", label: "Website / Domain" },
  { key: "customTags", label: "Custom Tags" },
  { key: "emailType", label: "Email Type" },
  { key: "bounced", label: "Bounced" },
  { key: "esp", label: "Email Service Provider" },
  // category / subcategory / additionalCategory were removed here on 2026-08-19 —
  // the three chips are merged into "Category" above. Leaving them listed would
  // offer a toggle for chips that no longer render.
  { key: "tags", label: "Client Tags" },
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
  onCustomTagsChange,
  onWebsiteChange,
  onGlobalSearchChange,
  onIncludeBouncedChange,
  onLoadPreset,
  onClientTagSelected,
  onLocationTargetsChange,
  onClientTagChange,
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

  void onGlobalSearchChange; // global search bar removed; filter field kept for API compat

  // Dynamic options loaded from DB
  const [countries, setCountries] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [jobTitles, setJobTitles] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [espValues, setEspValues] = useState<string[]>([]);
  const [cityValues, setCityValues] = useState<string[]>([]);
  const [companyValues, setCompanyValues] = useState<string[]>([]);
  // The 36-name category taxonomy (lead_categories), used as quick-picks in the
  // merged Category chip. Deliberately NOT the distinct values from `leads` —
  // subcategory alone holds 478,631 distinct values and loading them is what
  // made the old dropdowns hang.
  const [taxonomy, setTaxonomy] = useState<string[]>([]);
  const taxonomyLoadedRef = useRef(false);
  // Per-option lead counts (state/city) from the filter_option_counts RPC.
  const [optionCounts, setOptionCounts] = useState<Record<string, Record<string, number>>>({});
  const [clientTagOptions, setClientTagOptions] = useState<string[]>([]);
  const [clientRoster, setClientRoster] = useState<
    { tag: string; status?: string | null; client_type?: string | null; churned?: boolean; contactable?: number | null }[]
  >([]);
  const [clientSearch, setClientSearch] = useState("");
  const [collapsed, setCollapsed] = useState(false);
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
      case "city": setCityValues(values); break;
      case "company": setCompanyValues(values); break;
    }
  }, []);

  const loadDistinctFor = useCallback(async (col: string) => {
    if (loadedRef.current.has(col)) return;
    loadedRef.current.add(col);

    // Company is unbounded (1.3M distinct) — search-only, no preload.
    // City is cached since the 2026-07 normalization (~4K clean values).
    if (col === "company") return;

    const supabase = createClient();
    const { data } = await supabase.rpc("distinct_values", { col_name: col });

    // State/City also carry per-option lead counts (shown in the dropdown).
    if (col === "state" || col === "city") {
      supabase.rpc("filter_option_counts", { col_name: col }).then(({ data: counts }) => {
        if (counts && typeof counts === "object") {
          setOptionCounts((prev) => ({ ...prev, [col]: counts as Record<string, number> }));
        }
      });
    }

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

  // 36 rows, read once per page — effectively instant. RLS on lead_categories
  // allows any authenticated session to SELECT.
  const loadTaxonomy = useCallback(async () => {
    if (taxonomyLoadedRef.current) return;
    taxonomyLoadedRef.current = true;
    try {
      const supabase = createClient();
      const { data } = await supabase.from("lead_categories").select("name").order("name");
      if (data) setTaxonomy((data as { name: string }[]).map((r) => r.name).filter(Boolean));
    } catch {
      taxonomyLoadedRef.current = false; // let the next open retry
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
      applyValues(col, values);
    }, 300);
  }, [loadDistinctFor, applyValues]);

  // Client roster for the Client dropdown — synced from the Client Tracker /
  // Onboarding sheets (tag, status, Cleaning/Non-Cleaning, contactable count).
  const clientTagsLoadedRef = useRef(false);
  const loadClientTags = useCallback(async (force = false) => {
    if (clientTagsLoadedRef.current && !force) return;
    clientTagsLoadedRef.current = true;
    try {
      const res = await fetch("/api/bison/client-tags");
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as {
        tags?: { tag: string; status?: string | null; client_type?: string | null; churned?: boolean; contactable?: number | null }[];
      };
      setClientRoster((json.tags ?? []).filter((t) => t?.tag));
      setClientTagOptions([...new Set((json.tags ?? []).map((t) => t?.tag).filter(Boolean) as string[])]);
    } catch {
      // One transient failure must not permanently blank the dropdown —
      // unlatch so the next open (or the Retry button) refetches.
      clientTagsLoadedRef.current = false;
    }
  }, []);

  const cityActive = filters.location.city.include.length + filters.location.city.exclude.length;
  const hiddenActiveCount = HIDEABLE_CHIPS.filter((c) => isHidden(c.key)).length;

  // Reusable exclusion lists (Lists page) — fetched lazily on chip open.
  const [termLists, setTermLists] = useState<
    { id: string; name: string; kind: string; items: string[] }[] | null
  >(null);
  const loadTermLists = useCallback(async () => {
    try {
      const res = await fetch("/api/lists");
      if (!res.ok) { setTermLists([]); return; }
      const d = await res.json();
      setTermLists(d.lists ?? []);
    } catch {
      setTermLists([]);
    }
  }, []);

  const mergeVals = (current: string[], added: string[]) => {
    const seen = new Set(current.map((s) => s.toLowerCase()));
    return [...current, ...added.filter((s) => !seen.has(s.toLowerCase()))];
  };

  function applyTermList(l: { name: string; kind: string; items: string[] }) {
    if (l.kind === "titles") {
      onIncludeExcludeChange("jobTitle", {
        ...filters.jobTitle,
        exclude: mergeVals(filters.jobTitle.exclude, l.items),
        excludeMode: "contains",
      });
    } else if (l.kind === "domains") {
      onWebsiteChange({ ...filters.website, exclude: mergeVals(filters.website.exclude, l.items) });
    } else if (l.kind === "gateways") {
      onIncludeExcludeChange("esp", { ...filters.esp, exclude: mergeVals(filters.esp.exclude, l.items) });
    } else {
      // keywords + competitors → whole-term keyword exclusion
      onKeywordChange({
        ...filters.keyword,
        exclude: mergeVals(filters.keyword.exclude, l.items),
        ...(filters.keyword.exclude.length === 0 ? { excludeMode: "exact" as const } : {}),
      });
    }
  }

  return (
    <div className="ios-frost sticky top-0 z-20 space-y-2 border-b border-border/40 px-6 py-3">
      {/* Collapse / expand the whole filter panel to reclaim table space */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[13px] font-semibold text-foreground hover:bg-muted"
        >
          <ChevronDown className={`size-4 transition-transform ${collapsed ? "-rotate-90" : ""}`} strokeWidth={2.25} />
          Filters
          {activeCount > 0 && (
            <Badge className="h-4 min-w-4 rounded-full border-0 bg-primary px-1.5 text-[10px] text-primary-foreground">
              {activeCount}
            </Badge>
          )}
        </button>
      </div>

      {!collapsed && (
      <>
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

        {/* Category — the MERGED field (2026-08-19). Replaces the three separate
            Category / Subcategory / Additional-SEO chips with one control that
            searches all three columns at once via categorySearch. Positioned
            immediately left of Company so the category+company cluster reads
            together. The three original filters still exist in FilterState and in
            fn_lead_filter_conditions, so saved searches, shared links and stored
            push-batch filters keep resolving unchanged. */}
        {!isHidden("categorySearch") && (
          <FilterChip
            label="Category"
            activeCount={filters.categorySearch.include.length + filters.categorySearch.exclude.length}
            onOpen={loadTaxonomy}
          >
            <div className="space-y-3">
              <p className="px-1 text-[10px] text-muted-foreground">
                Searches Category, Subcategory and Additional/SEO together, so
                &quot;dental&quot; finds a lead however it was labelled. Client-tag targeting
                fills this in automatically.
              </p>
              <div>
                <label className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Include
                  <SideModeToggle
                    value={filters.categorySearch.includeMode ?? (filters.categorySearch.matchMode === "exact" ? "exact" : "contains")}
                    onChange={(v) => onCategorySearchChange({ ...filters.categorySearch, includeMode: v })}
                  />
                </label>
                <TagInput
                  values={filters.categorySearch.include}
                  placeholder="e.g. dental, school, restaurant"
                  onChange={(arr) =>
                    onCategorySearchChange({ ...filters.categorySearch, include: arr })
                  }
                />
                {taxonomy.length > 0 && (
                  <div className="mt-2">
                    <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Quick pick
                    </p>
                    <div className="flex max-h-32 flex-wrap gap-1 overflow-y-auto pr-1">
                      {taxonomy.map((name) => {
                        const on = filters.categorySearch.include.some(
                          (v) => v.toLowerCase() === name.toLowerCase()
                        );
                        return (
                          <button
                            key={name}
                            type="button"
                            onClick={() =>
                              onCategorySearchChange({
                                ...filters.categorySearch,
                                include: on
                                  ? filters.categorySearch.include.filter(
                                      (v) => v.toLowerCase() !== name.toLowerCase()
                                    )
                                  : [...filters.categorySearch.include, name],
                              })
                            }
                            className={`rounded-full px-2 py-0.5 text-[11px] transition-colors ${
                              on
                                ? "bg-primary text-primary-foreground"
                                : "bg-muted text-foreground hover:bg-accent"
                            }`}
                          >
                            {name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <label className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Exclude
                  <SideModeToggle
                    value={filters.categorySearch.excludeMode ?? (filters.categorySearch.matchMode === "exact" ? "exact" : "contains")}
                    onChange={(v) => onCategorySearchChange({ ...filters.categorySearch, excludeMode: v })}
                  />
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
                Matches category, subcategory, or additional category.{" "}
                <span className="font-medium text-foreground">Exact</span> = whole-term;{" "}
                <span className="font-medium text-foreground">Contains</span> = substring. Each side has its own setting.
              </p>
            </div>
          </FilterChip>
        )}


        {/* Company — next to Additional/SEO so the industry+company cluster reads
            together (client req #3) */}
        {!isHidden("company") && (
          <FilterChip
            label="Company"
            activeCount={filters.company.include.length + filters.company.exclude.length + (filters.excludeEmptyCompany ? 1 : 0)}
            onOpen={() => loadDistinctFor("company")}
          >
            <FilterMultiSelect
              options={companyValues}
              value={filters.company}
              onChange={(v) => onIncludeExcludeChange("company", v)}
              searchable
              onSearch={(term) => liveSearch("company", term)}
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

        {/* Commercial Cleaning Client — excludes ~230 default non-buyer job titles */}
        <button
          type="button"
          onClick={() => onToggleFlag("commercialCleaning", !filters.commercialCleaning)}
          title="Excludes ~230 non-buyer job titles (IT, sales reps, legal, drivers, retail…). Leads without a title are kept. Edit the list on the Lists page ('Commercial cleaning titles')."
          className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-all active:scale-[0.97] ${
            filters.commercialCleaning
              ? "bg-primary text-primary-foreground shadow-sm"
              : "bg-muted text-foreground hover:bg-accent"
          }`}
        >
          Commercial Cleaning
          {filters.commercialCleaning && (
            <span className="rounded-full bg-primary-foreground/20 px-1.5 text-[10px]">~230 titles excluded</span>
          )}
        </button>

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
            <p className="mt-2 px-1 text-[10px] text-muted-foreground">
              Where the lead came from — which Bison instance export or upload batch added it.
            </p>
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
              counts={optionCounts.city}
              value={filters.location.city}
              onChange={onLocationCityChange}
              searchable
              onSearch={(term) => liveSearch("city", term)}
              defaultMode="contains"
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
              labels={STATE_NAMES}
              counts={optionCounts.state}
              value={filters.location.state}
              onChange={onLocationStateChange}
              searchable
            />
            {/* no onSearch: 60 options filter locally against full names,
                so typing "california" or "CA" both match */}
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
                <label className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Include
                  <SideModeToggle
                    value={filters.keyword.includeMode ?? keywordMode}
                    onChange={(v) => onKeywordChange({ ...filters.keyword, includeMode: v })}
                  />
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
                <label className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Exclude
                  <SideModeToggle
                    value={filters.keyword.excludeMode ?? keywordMode}
                    onChange={(v) => onKeywordChange({ ...filters.keyword, excludeMode: v })}
                  />
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
                <span className="font-medium text-foreground">Personal</span> = a named person&apos;s mailbox
                (jane@company.com) — decision-maker outreach;{" "}
                <span className="font-medium text-foreground">General</span> = shared/role inboxes
                (info@, office@, sales@). Detected at import from the address prefix.
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

        {/* Client — single-select roster dropdown (synced from the sheets).
            Selecting applies the client's targeting to the other filters;
            free-text tag matching lives in Custom Tags. */}
        {!isHidden("tags") && (
          <FilterChip
            label={filters.clientTag ? `Client: ${filters.clientTag}` : "Client"}
            activeCount={filters.clientTag ? 1 : 0}
            onOpen={loadClientTags}
          >
            <div className="space-y-2">
              <Input
                placeholder={`Search ${clientRoster.length || ""} clients…`}
                value={clientSearch}
                onChange={(e) => setClientSearch(e.target.value)}
                className="h-8 text-xs"
              />
              {filters.clientTag && (
                <button
                  type="button"
                  onClick={() => onClientTagChange?.(null)}
                  className="w-full rounded-lg bg-muted px-2 py-1.5 text-left text-[12px] hover:bg-accent"
                >
                  ✕ Clear client ({filters.clientTag})
                </button>
              )}
              <div className="max-h-64 space-y-0.5 overflow-y-auto">
                {clientRoster.length === 0 ? (
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
                  clientRoster
                    .filter((c) => !clientSearch.trim() || c.tag.toLowerCase().includes(clientSearch.trim().toLowerCase()))
                    .map((c) => {
                      const picked = filters.clientTag === c.tag;
                      return (
                        <button
                          key={c.tag}
                          type="button"
                          onClick={() => {
                            if (picked) {
                              onClientTagChange?.(null);
                            } else {
                              onClientTagChange?.(c.tag);
                              onClientTagSelected?.(c.tag);
                            }
                          }}
                          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors ${
                            picked ? "bg-primary/10 ring-1 ring-primary/40" : "hover:bg-muted/60"
                          }`}
                        >
                          <span className="font-medium">{c.tag}</span>
                          {c.client_type && (
                            <span className={`rounded-full px-1.5 text-[9px] ${c.client_type === "Cleaning" ? "bg-orange-500/15 text-orange-600" : "bg-sky-500/15 text-sky-600"}`}>
                              {c.client_type}
                            </span>
                          )}
                          {c.churned && <span className="rounded-full bg-destructive/10 px-1.5 text-[9px] text-destructive">churned</span>}
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
          </FilterChip>
        )}

        {/* Targeting — structured geo entries (client-targeting auto-apply).
            Only shown while entries exist; hand-editable per entry. */}
        {(filters.locationTargets.include.length > 0 || filters.locationTargets.exclude.length > 0) && (
          <FilterChip
            label="Targeting"
            activeCount={filters.locationTargets.include.length + filters.locationTargets.exclude.length}
          >
            <div className="space-y-3">
              {(["include", "exclude"] as const).map((side) =>
                filters.locationTargets[side].length > 0 ? (
                  <div key={side}>
                    <label className="mb-1 block px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {side === "include" ? "Locations (any of)" : "Excluded locations"}
                    </label>
                    <div className="flex max-h-48 flex-wrap gap-1 overflow-y-auto">
                      {filters.locationTargets[side].map((e, i) => (
                        <span
                          key={`${e.country}|${e.state ?? ""}|${e.city ?? ""}|${i}`}
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] ${
                            side === "include" ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"
                          }`}
                        >
                          {targetEntryLabel(e)}
                          <button
                            type="button"
                            onClick={() =>
                              onLocationTargetsChange?.({
                                ...filters.locationTargets,
                                [side]: filters.locationTargets[side].filter((_, j) => j !== i),
                              })
                            }
                            className="opacity-60 hover:opacity-100"
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null
              )}
              <div className="flex items-center justify-between px-1">
                <p className="text-[11px] text-muted-foreground">
                  From the client&apos;s targeting rules. State entries include the whole state.
                </p>
                <button
                  type="button"
                  onClick={() => onLocationTargetsChange?.({ include: [], exclude: [] })}
                  className="text-[11px] font-medium text-destructive hover:underline"
                >
                  Clear all
                </button>
              </div>
            </div>
          </FilterChip>
        )}

        {/* Lists — apply a reusable exclusion list (managed on the Lists page) */}
        <FilterChip label="Lists" activeCount={0} onOpen={loadTermLists}>
          <div className="space-y-1.5">
            {termLists === null ? (
              <p className="px-1 text-[11px] text-muted-foreground">Loading lists…</p>
            ) : termLists.length === 0 ? (
              <p className="px-1 text-[11px] text-muted-foreground">No lists yet — create them on the Lists page.</p>
            ) : (
              termLists.map((l) => (
                <div key={l.id} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-muted/50">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12px] font-medium">{l.name}</p>
                    <p className="text-[10px] text-muted-foreground">{l.items.length} items → {LIST_TARGET_LABEL[l.kind] ?? l.kind}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => applyTermList(l)}
                    className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/20"
                  >
                    Apply
                  </button>
                </div>
              ))
            )}
            <p className="px-1 text-[10px] text-muted-foreground">
              Applying adds the list&apos;s terms to the matching exclude filter. Edit lists on the Lists page.
            </p>
          </div>
        </FilterChip>

        {/* Custom Tags — free-text search on ANY lead tag (not just client tags) */}
        {!isHidden("customTags") && (
          <FilterChip
            label="Custom Tags"
            activeCount={filters.customTags.include.length + filters.customTags.exclude.length}
          >
            <div className="space-y-3">
              <div>
                <label className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Include
                  <SideModeToggle
                    value={filters.customTags.includeMode ?? "contains"}
                    onChange={(v) => onCustomTagsChange({ ...filters.customTags, includeMode: v })}
                  />
                </label>
                <TagInput
                  values={filters.customTags.include}
                  placeholder="Type a tag, press Enter"
                  onChange={(arr) => onCustomTagsChange({ ...filters.customTags, include: arr })}
                />
              </div>
              <div>
                <label className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Exclude
                  <SideModeToggle
                    value={filters.customTags.excludeMode ?? "contains"}
                    onChange={(v) => onCustomTagsChange({ ...filters.customTags, excludeMode: v })}
                  />
                </label>
                <TagInput
                  values={filters.customTags.exclude}
                  placeholder="Tag to exclude"
                  onChange={(arr) => onCustomTagsChange({ ...filters.customTags, exclude: arr })}
                />
              </div>
              <p className="px-1 text-[11px] text-muted-foreground">
                Free-text match on any lead tag (client tags, ESP tags, or your own).
              </p>
            </div>
          </FilterChip>
        )}

        {/* Website / Domain — matches website, domain, or the email's domain */}
        {!isHidden("website") && (
          <FilterChip
            label="Website / Domain"
            activeCount={filters.website.include.length + filters.website.exclude.length}
          >
            <div className="space-y-3">
              <div>
                <label className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Include
                  <SideModeToggle
                    value={filters.website.includeMode ?? "contains"}
                    onChange={(v) => onWebsiteChange({ ...filters.website, includeMode: v })}
                  />
                </label>
                <TagInput
                  values={filters.website.include}
                  placeholder="e.g. cleaning, .org"
                  onChange={(arr) => onWebsiteChange({ ...filters.website, include: arr })}
                />
              </div>
              <div>
                <label className="mb-1 flex items-center px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Exclude
                  <SideModeToggle
                    value={filters.website.excludeMode ?? "contains"}
                    onChange={(v) => onWebsiteChange({ ...filters.website, excludeMode: v })}
                  />
                </label>
                <TagInput
                  values={filters.website.exclude}
                  placeholder="e.g. weebly, squarespace"
                  onChange={(arr) => onWebsiteChange({ ...filters.website, exclude: arr })}
                />
              </div>
              <p className="px-1 text-[11px] text-muted-foreground">
                Matches the website, domain, or the domain from the email — works even
                where the domain field isn&apos;t filled.
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
      </>
      )}
    </div>
  );
}
