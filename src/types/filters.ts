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
