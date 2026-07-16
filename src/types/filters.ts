export interface IncludeExclude {
  include: string[];
  exclude: string[];
  operator: "OR" | "AND"; // within the include list: OR = match any, AND = match all
  includeUnknown?: boolean; // include leads where this field is null/empty
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
  city: string;
}

// New for OutboundHero — IncludeExclude shape for the keyword filter (was a plain string).
export interface KeywordFilter {
  include: string[];
  exclude: string[];
}

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
  category: IncludeExclude;
  subcategory: IncludeExclude;

  // Location
  location: LocationFilter;

  // Range
  companySize: RangeFilter;
  revenue: RangeFilter;

  // Keyword (now include + exclude, multi-field ILIKE across company_name,
  // general_industry, specific_industry, company_overview)
  keyword: KeywordFilter;

  // OutboundHero additions
  emailType: EmailTypeFilter;          // default both true → no filter
  includeBounced?: boolean;             // admin-only override; default false → hide bounced

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
  category: ie(),
  subcategory: ie(),
  location: {
    country: ie(),
    state: ie(),
    city: "",
  },
  companySize: { buckets: [], includeUnknown: false },
  revenue: { buckets: [], includeUnknown: false },
  keyword: { include: [], exclude: [] },
  emailType: { personal: true, general: true },
  includeBounced: false,
  page: 1,
  pageSize: 50,
  sortBy: "created_at",
  sortDir: "desc",
};

// Deep-merge a possibly-stale/partial FilterState (old saved presets, old
// client payloads, URL state) onto DEFAULT_FILTER_STATE so fields added after
// the state was saved (e.g. category/subcategory) are always present. Every
// consumer of externally-sourced filters (preset load, /api/exports/stream,
// /api/bison/push, /api/leads/filter) must pass through this.
export function normalizeFilterState(partial: unknown): FilterState {
  const p = (partial && typeof partial === "object" ? partial : {}) as Partial<FilterState>;
  const mergeIE = (v: Partial<IncludeExclude> | undefined, d: IncludeExclude): IncludeExclude => ({
    include: Array.isArray(v?.include) ? v.include : d.include,
    exclude: Array.isArray(v?.exclude) ? v.exclude : d.exclude,
    operator: v?.operator === "AND" ? "AND" : d.operator,
    includeUnknown: typeof v?.includeUnknown === "boolean" ? v.includeUnknown : d.includeUnknown,
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
    category: mergeIE(p.category, d.category),
    subcategory: mergeIE(p.subcategory, d.subcategory),
    location: {
      country: mergeIE(p.location?.country, d.location.country),
      state: mergeIE(p.location?.state, d.location.state),
      city: typeof p.location?.city === "string" ? p.location.city : d.location.city,
    },
    companySize: { ...d.companySize, ...(p.companySize ?? {}) },
    revenue: { ...d.revenue, ...(p.revenue ?? {}) },
    keyword: {
      include: Array.isArray(p.keyword?.include) ? p.keyword.include : d.keyword.include,
      exclude: Array.isArray(p.keyword?.exclude) ? p.keyword.exclude : d.keyword.exclude,
    },
    emailType: { ...d.emailType, ...(p.emailType ?? {}) },
  };
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
  if (filters.category.include.length || filters.category.exclude.length || filters.category.includeUnknown) count++;
  if (filters.subcategory.include.length || filters.subcategory.exclude.length || filters.subcategory.includeUnknown) count++;
  if (filters.location.country.include.length || filters.location.country.exclude.length || filters.location.country.includeUnknown) count++;
  if (filters.location.state.include.length || filters.location.state.exclude.length || filters.location.state.includeUnknown) count++;
  if (filters.location.city) count++;
  if (filters.companySize.buckets.length || filters.companySize.includeUnknown || filters.companySize.customMin || filters.companySize.customMax) count++;
  if (filters.revenue.buckets.length || filters.revenue.includeUnknown) count++;
  if (filters.keyword.include.length || filters.keyword.exclude.length) count++;
  // emailType counts as active only when not both selected (i.e. user has restricted)
  if (!(filters.emailType.personal && filters.emailType.general)) count++;
  if (filters.includeBounced) count++;
  return count;
}
