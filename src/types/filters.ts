export type MatchMode = "contains" | "exact";

export interface IncludeExclude {
  include: string[];
  exclude: string[];
  operator: "OR" | "AND"; // within the include list: OR = match any, AND = match all
  includeUnknown?: boolean; // include leads where this field is null/empty
  // Per-side match settings (migration 062). Defaults preserve old behavior:
  // dropdown fields = exact, city/tags/keyword-style fields = contains.
  includeMode?: MatchMode;
  excludeMode?: MatchMode;
}

export interface RangeFilter {
  buckets: string[];
  includeUnknown: boolean;
  customMin?: number | null;
  customMax?: number | null;
}

export interface LocationFilter {
  country: IncludeExclude;
  state: IncludeExclude;
  city: IncludeExclude; // was a plain string — normalizeFilterState migrates old payloads
}

// Structured geo targeting (migration 062 `locationTargets` + 066
// fn_location_entry_condition): state-level entries omit city, and include
// entries OR together — "all of WA plus Miami, FL" is expressible, unlike the
// flat state/city filters which AND. state is a state_code; city matches by
// geoname id (exact place, no cross-state name collisions). Populated by
// client-tag auto-apply; editable via the Targeting chip.
export interface LocationTargetEntry {
  country: string;
  state?: string;
  city?: string;
}

export interface LocationTargetsFilter {
  include: LocationTargetEntry[];
  exclude: LocationTargetEntry[];
}

// New for OutboundHero — IncludeExclude shape for the keyword filter (was a plain string).
// matchMode 'exact' = whole-term matching (word-boundaried, plural-tolerant:
// "dry cleaner" matches only the full phrase — NOT everything containing
// "cleaner"; "house" still catches "housecleaning" via word-start) across
// company, domain/website, category, subcategory, additional_category.
// 'contains' = legacy substring across company/industries/overview.
export interface KeywordFilter {
  include: string[];
  exclude: string[];
  matchMode?: "contains" | "exact"; // legacy single mode (fallback for both sides)
  includeMode?: MatchMode;
  excludeMode?: MatchMode;
}

// Email/domain substring search (weebly.com, .gov, walmart.com …).
export interface EmailContainsFilter {
  include: string[];
  exclude: string[];
}

// Category contains-search: type a term -> ILIKE match across category /
// subcategory / additional_category (include = OR, exclude removes matches).
export interface CategorySearchFilter {
  include: string[];
  exclude: string[];
  matchMode?: "contains" | "exact"; // legacy single mode (fallback for both sides)
  includeMode?: MatchMode;
  excludeMode?: MatchMode;
}

// Free-text tag search (any lead tag) + website/domain search.
export interface CustomTagsFilter { include: string[]; exclude: string[]; includeMode?: MatchMode; excludeMode?: MatchMode; }
export interface WebsiteFilter { include: string[]; exclude: string[]; includeMode?: MatchMode; excludeMode?: MatchMode; }

// New for OutboundHero — email type segmented control. Default: both true.
export interface EmailTypeFilter {
  personal: boolean;
  general: boolean;
}

export interface FilterState {
  // Global logic between fields
  filterOperator: "AND" | "OR";

  // Text search
  fullName: string;
  excludeEmptyName: boolean;
  companyName: string;
  excludeEmptyCompany: boolean;
  excludeEmptyOverview: boolean;

  // Multi-select with include/exclude
  source: IncludeExclude;
  jobTitle: IncludeExclude;
  seniority: IncludeExclude;
  generalIndustry: IncludeExclude;
  specificIndustry: IncludeExclude;
  esp: IncludeExclude;
  company: IncludeExclude;  // searchable exact-match dropdown (include/exclude)
  category: IncludeExclude;
  subcategory: IncludeExclude;
  additionalCategory: IncludeExclude;
  tags: IncludeExclude;                 // Bison tags (client tags etc.), substring match

  // Selected client (client req #1: "client tags control settings and export
  // history — they don't need to be a lead filter"). Drives targeting
  // auto-apply, export scoping/dedupe and push routing; it is deliberately NOT
  // translated into a leads.tags filter, so a client's search still sees
  // untagged leads (the ones a push is about to tag).
  clientTag?: string | null;

  // Category cascade (client req 2026-08-06): values picked in the Category
  // filter also apply to Subcategory + Additional/SEO (same contains/exact
  // mode); includeCompany extends excludes to the company name too.
  categoryCascade?: { enabled: boolean; includeCompany: boolean };

  // Location
  location: LocationFilter;
  locationTargets: LocationTargetsFilter;

  // Range
  companySize: RangeFilter;
  revenue: RangeFilter;

  // Keyword (now include + exclude, multi-field ILIKE across company_name,
  // general_industry, specific_industry, company_overview)
  keyword: KeywordFilter;
  emailContains: EmailContainsFilter;
  categorySearch: CategorySearchFilter;
  customTags: CustomTagsFilter;
  website: WebsiteFilter;

  // One-box search: comma-separated terms OR'd across email, company,
  // first/last name, domain, category, subcategory.
  globalSearch: string;

  // OutboundHero additions
  emailType: EmailTypeFilter;          // default both true → no filter
  includeBounced?: boolean;             // admin-only override; default false → hide bounced
  // Commercial cleaning client: exclude ~230 default job titles (whole-word).
  commercialCleaning?: boolean;

  // Spreadsheet-style per-column header filters: { state: ["Nevada","Utah"] }.
  // The array is a KEEP-list of ticked values, so an absent or empty entry
  // means "no constraint on this column" — never "match nothing". '__BLANK__'
  // is the sentinel for rows with no value. Handled by fn_lead_filter_conditions
  // (migration 088), which also whitelists the permitted column names.
  columnFilters: Record<string, string[]>;

  // Pagination
  page: number;
  pageSize: number;
  sortBy: string;
  sortDir: "asc" | "desc";
}

function ie(operator: "OR" | "AND" = "OR"): IncludeExclude {
  return { include: [], exclude: [], operator };
}

export const DEFAULT_FILTER_STATE: FilterState = {
  filterOperator: "AND",
  fullName: "",
  excludeEmptyName: false,
  companyName: "",
  excludeEmptyCompany: false,
  excludeEmptyOverview: false,
  source: ie(),
  jobTitle: ie(),
  seniority: ie(),
  generalIndustry: ie(),
  specificIndustry: ie(),
  esp: ie(),
  company: ie(),
  category: ie(),
  subcategory: ie(),
  additionalCategory: ie(),
  tags: ie(),
  clientTag: null,
  categoryCascade: { enabled: false, includeCompany: false },
  location: {
    country: ie(),
    state: ie(),
    city: ie(),
  },
  locationTargets: { include: [], exclude: [] },
  companySize: { buckets: [], includeUnknown: false },
  revenue: { buckets: [], includeUnknown: false },
  keyword: { include: [], exclude: [], matchMode: "contains" },
  emailContains: { include: [], exclude: [] },
  categorySearch: { include: [], exclude: [], matchMode: "contains" },
  customTags: { include: [], exclude: [] },
  website: { include: [], exclude: [] },
  globalSearch: "",
  emailType: { personal: true, general: true },
  includeBounced: false,
  commercialCleaning: false,
  columnFilters: {},
  page: 1,
  pageSize: 50,
  sortBy: "created_at",
  sortDir: "desc",
};

function sanitizeTargetEntries(v: unknown): LocationTargetEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e): e is LocationTargetEntry =>
      !!e && typeof e === "object" && typeof (e as LocationTargetEntry).country === "string" &&
      (e as LocationTargetEntry).country.trim().length > 0
  );
}

// Deep-merge a possibly-stale/partial FilterState (old saved presets, old
// client payloads, URL state) onto DEFAULT_FILTER_STATE so fields added after
// the state was saved (e.g. category/subcategory) are always present. Every
// consumer of externally-sourced filters (preset load, /api/exports/stream,
// /api/bison/push, /api/leads/filter) must pass through this.
export function normalizeFilterState(partial: unknown): FilterState {
  const p = (partial && typeof partial === "object" ? partial : {}) as Partial<FilterState>;
  const mode = (m: unknown): MatchMode | undefined =>
    m === "exact" || m === "contains" ? m : undefined;
  const mergeIE = (v: Partial<IncludeExclude> | undefined, d: IncludeExclude): IncludeExclude => ({
    include: Array.isArray(v?.include) ? v.include : d.include,
    exclude: Array.isArray(v?.exclude) ? v.exclude : d.exclude,
    operator: v?.operator === "AND" ? "AND" : d.operator,
    includeUnknown: typeof v?.includeUnknown === "boolean" ? v.includeUnknown : d.includeUnknown,
    includeMode: mode(v?.includeMode),
    excludeMode: mode(v?.excludeMode),
  });
  const d = DEFAULT_FILTER_STATE;
  return {
    ...d,
    ...p,
    source: mergeIE(p.source, d.source),
    jobTitle: mergeIE(p.jobTitle, d.jobTitle),
    seniority: mergeIE(p.seniority, d.seniority),
    generalIndustry: mergeIE(p.generalIndustry, d.generalIndustry),
    specificIndustry: mergeIE(p.specificIndustry, d.specificIndustry),
    esp: mergeIE(p.esp, d.esp),
    company: mergeIE(p.company, d.company),
    category: mergeIE(p.category, d.category),
    subcategory: mergeIE(p.subcategory, d.subcategory),
    additionalCategory: mergeIE(p.additionalCategory, d.additionalCategory),
    tags: mergeIE(p.tags, d.tags),
    location: {
      country: mergeIE(p.location?.country, d.location.country),
      state: mergeIE(p.location?.state, d.location.state),
      // Legacy payloads stored city as a plain string — fold it into include[].
      city: typeof (p.location as { city?: unknown } | undefined)?.city === "string"
        ? { ...d.location.city, include: (p.location!.city as unknown as string) ? [p.location!.city as unknown as string] : [] }
        : mergeIE(p.location?.city as Partial<IncludeExclude> | undefined, d.location.city),
    },
    clientTag: typeof p.clientTag === "string" && p.clientTag.trim() ? p.clientTag.trim() : null,
    categoryCascade: {
      enabled: p.categoryCascade?.enabled === true,
      includeCompany: p.categoryCascade?.includeCompany === true,
    },
    locationTargets: {
      include: sanitizeTargetEntries(p.locationTargets?.include),
      exclude: sanitizeTargetEntries(p.locationTargets?.exclude),
    },
    companySize: { ...d.companySize, ...(p.companySize ?? {}) },
    revenue: { ...d.revenue, ...(p.revenue ?? {}) },
    keyword: {
      include: Array.isArray(p.keyword?.include) ? p.keyword.include : d.keyword.include,
      exclude: Array.isArray(p.keyword?.exclude) ? p.keyword.exclude : d.keyword.exclude,
      matchMode: p.keyword?.matchMode === "exact" ? "exact" : "contains",
      includeMode: mode(p.keyword?.includeMode),
      excludeMode: mode(p.keyword?.excludeMode),
    },
    emailContains: {
      include: Array.isArray(p.emailContains?.include) ? p.emailContains.include : d.emailContains.include,
      exclude: Array.isArray(p.emailContains?.exclude) ? p.emailContains.exclude : d.emailContains.exclude,
    },
    categorySearch: {
      include: Array.isArray(p.categorySearch?.include) ? p.categorySearch.include : d.categorySearch.include,
      exclude: Array.isArray(p.categorySearch?.exclude) ? p.categorySearch.exclude : d.categorySearch.exclude,
      matchMode: p.categorySearch?.matchMode === "exact" ? "exact" : "contains",
      includeMode: mode(p.categorySearch?.includeMode),
      excludeMode: mode(p.categorySearch?.excludeMode),
    },
    customTags: {
      include: Array.isArray(p.customTags?.include) ? p.customTags.include : d.customTags.include,
      exclude: Array.isArray(p.customTags?.exclude) ? p.customTags.exclude : d.customTags.exclude,
      includeMode: mode(p.customTags?.includeMode),
      excludeMode: mode(p.customTags?.excludeMode),
    },
    website: {
      include: Array.isArray(p.website?.include) ? p.website.include : d.website.include,
      exclude: Array.isArray(p.website?.exclude) ? p.website.exclude : d.website.exclude,
      includeMode: mode(p.website?.includeMode),
      excludeMode: mode(p.website?.excludeMode),
    },
    globalSearch: typeof p.globalSearch === "string" ? p.globalSearch : d.globalSearch,
    emailType: { ...d.emailType, ...(p.emailType ?? {}) },
    commercialCleaning: p.commercialCleaning === true,
    // Keep only string arrays with at least one value: an empty array is not a
    // constraint, so carrying it forward would just be noise in saved presets.
    columnFilters: sanitizeColumnFilters(p.columnFilters),
  };
}

function sanitizeColumnFilters(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [col, values] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(values)) continue;
    const clean = values.filter((x): x is string => typeof x === "string");
    if (clean.length > 0) out[col] = clean;
  }
  return out;
}

export function countActiveFilters(filters: FilterState): number {
  let count = 0;
  if (filters.fullName || filters.excludeEmptyName) count++;
  if (filters.companyName || filters.excludeEmptyCompany) count++;
  if (filters.excludeEmptyOverview) count++;
  if (filters.source.include.length || filters.source.exclude.length || filters.source.includeUnknown) count++;
  if (filters.jobTitle.include.length || filters.jobTitle.exclude.length || filters.jobTitle.includeUnknown) count++;
  if (filters.seniority.include.length || filters.seniority.exclude.length || filters.seniority.includeUnknown) count++;
  if (filters.generalIndustry.include.length || filters.generalIndustry.exclude.length || filters.generalIndustry.includeUnknown) count++;
  if (filters.specificIndustry.include.length || filters.specificIndustry.exclude.length || filters.specificIndustry.includeUnknown) count++;
  if (filters.esp.include.length || filters.esp.exclude.length || filters.esp.includeUnknown) count++;
  if (filters.company.include.length || filters.company.exclude.length || filters.company.includeUnknown) count++;
  if (filters.category.include.length || filters.category.exclude.length || filters.category.includeUnknown) count++;
  if (filters.subcategory.include.length || filters.subcategory.exclude.length || filters.subcategory.includeUnknown) count++;
  if (filters.additionalCategory.include.length || filters.additionalCategory.exclude.length || filters.additionalCategory.includeUnknown) count++;
  if (filters.tags.include.length || filters.tags.exclude.length) count++;
  if (filters.location.country.include.length || filters.location.country.exclude.length || filters.location.country.includeUnknown) count++;
  if (filters.location.state.include.length || filters.location.state.exclude.length || filters.location.state.includeUnknown) count++;
  if (filters.location.city.include.length || filters.location.city.exclude.length) count++;
  if (filters.locationTargets.include.length || filters.locationTargets.exclude.length) count++;
  if (filters.companySize.buckets.length || filters.companySize.includeUnknown || filters.companySize.customMin || filters.companySize.customMax) count++;
  if (filters.revenue.buckets.length || filters.revenue.includeUnknown) count++;
  if (filters.keyword.include.length || filters.keyword.exclude.length) count++;
  if (filters.emailContains.include.length || filters.emailContains.exclude.length) count++;
  if (filters.categorySearch.include.length || filters.categorySearch.exclude.length) count++;
  if (filters.customTags.include.length || filters.customTags.exclude.length) count++;
  if (filters.website.include.length || filters.website.exclude.length) count++;
  if (filters.globalSearch.trim()) count++;
  // emailType counts as active only when not both selected (i.e. user has restricted)
  if (!(filters.emailType.personal && filters.emailType.general)) count++;
  if (filters.includeBounced) count++;
  if (filters.commercialCleaning) count++;
  // One per constrained column, so the badge reflects header filters too —
  // otherwise a table narrowed from its headers looks unfiltered.
  count += Object.values(filters.columnFilters ?? {}).filter((v) => v.length > 0).length;
  return count;
}
