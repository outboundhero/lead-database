import type { FilterState } from "@/types/filters";
import type { Lead } from "@/types/database";
import { expandTitleAliases } from "./title-aliases";

export interface FilterResult {
  data: Lead[];
  totalCount: number;
}

const U = "__UNKNOWN__";

function stripUnknown(ie: { include: string[]; exclude: string[]; includeUnknown?: boolean }) {
  const includeHas = ie.include.includes(U);
  const excludeHas = ie.exclude.includes(U);
  return {
    include: ie.include.filter((v) => v !== U),
    exclude: ie.exclude.filter((v) => v !== U),
    // includeUnknown (RPC flag): true = exclude nulls — from checkbox OR exclude selection
    includeUnknown: ie.includeUnknown || excludeHas,
    // selectUnknown: true = include null/empty rows in results
    selectUnknown: includeHas,
  };
}

export function buildRpcFilters(filters: FilterState) {
  const jobTitle = stripUnknown(filters.jobTitle);
  const generalIndustry = stripUnknown(filters.generalIndustry);
  const specificIndustry = stripUnknown(filters.specificIndustry);
  const source = stripUnknown(filters.source);
  const seniority = stripUnknown(filters.seniority);
  const espRaw = stripUnknown(filters.esp);
  const company = stripUnknown(filters.company ?? { include: [], exclude: [] });
  const category = stripUnknown(filters.category);
  const subcategory = stripUnknown(filters.subcategory);
  const additionalCategory = stripUnknown(filters.additionalCategory ?? { include: [], exclude: [] });
  const country = stripUnknown(filters.location.country);
  const state = stripUnknown(filters.location.state);
  const city = filters.location.city;
  // Legacy callers may still hand us a plain-string city.
  const cityInclude = typeof city === "string" ? (city ? [city] : []) : city?.include ?? [];
  const cityExclude = typeof city === "string" ? [] : city?.exclude ?? [];

  return {
    // Expand selected titles via alias map so "CEO" also matches "Chief Executive
    // Officer", "c.e.o.", etc. See title-aliases.ts.
    jobTitle: {
      include: expandTitleAliases(jobTitle.include),
      exclude: expandTitleAliases(jobTitle.exclude),
      includeUnknown: jobTitle.includeUnknown,
      selectUnknown: jobTitle.selectUnknown,
    },
    generalIndustry: { include: generalIndustry.include, exclude: generalIndustry.exclude, includeUnknown: generalIndustry.includeUnknown, selectUnknown: generalIndustry.selectUnknown },
    specificIndustry: { include: specificIndustry.include, exclude: specificIndustry.exclude, includeUnknown: specificIndustry.includeUnknown, selectUnknown: specificIndustry.selectUnknown },
    source: { include: source.include, exclude: source.exclude, includeUnknown: source.includeUnknown, selectUnknown: source.selectUnknown },
    seniority: { include: seniority.include, exclude: seniority.exclude, includeUnknown: seniority.includeUnknown, selectUnknown: seniority.selectUnknown },
    esp: {
      include: espRaw.include.flatMap((v: string) => v === "Microsoft / Outlook" ? ["Microsoft", "Outlook"] : [v]),
      exclude: espRaw.exclude.flatMap((v: string) => v === "Microsoft / Outlook" ? ["Microsoft", "Outlook"] : [v]),
      includeUnknown: espRaw.includeUnknown, selectUnknown: espRaw.selectUnknown,
    },
    company: { include: company.include, exclude: company.exclude, includeUnknown: company.includeUnknown, selectUnknown: company.selectUnknown },
    category: { include: category.include, exclude: category.exclude, includeUnknown: category.includeUnknown, selectUnknown: category.selectUnknown },
    subcategory: { include: subcategory.include, exclude: subcategory.exclude, includeUnknown: subcategory.includeUnknown, selectUnknown: subcategory.selectUnknown },
    additionalCategory: { include: additionalCategory.include, exclude: additionalCategory.exclude, includeUnknown: additionalCategory.includeUnknown, selectUnknown: additionalCategory.selectUnknown },
    tags: { include: filters.tags?.include ?? [], exclude: filters.tags?.exclude ?? [] },
    location: {
      country: { include: country.include, exclude: country.exclude, includeUnknown: country.includeUnknown, selectUnknown: country.selectUnknown },
      state: { include: state.include, exclude: state.exclude, includeUnknown: state.includeUnknown, selectUnknown: state.selectUnknown },
      // New shape: {include, exclude} arrays. The RPC also still accepts the
      // legacy plain-string form for old stored batch filters.
      city: { include: cityInclude, exclude: cityExclude },
    },
    companySize: { buckets: filters.companySize?.buckets || [], includeUnknown: filters.companySize?.includeUnknown || false, customMin: filters.companySize?.customMin ?? null, customMax: filters.companySize?.customMax ?? null },
    revenue: { buckets: filters.revenue?.buckets || [], includeUnknown: filters.revenue?.includeUnknown || false },
    fullName: filters.fullName || "",
    companyName: filters.companyName || "",
    keyword: {
      include: filters.keyword?.include ?? [],
      exclude: filters.keyword?.exclude ?? [],
      matchMode: filters.keyword?.matchMode === "exact" ? "exact" : "contains",
    },
    emailContains: {
      include: filters.emailContains?.include ?? [],
      exclude: filters.emailContains?.exclude ?? [],
    },
    categorySearch: {
      include: filters.categorySearch?.include ?? [],
      exclude: filters.categorySearch?.exclude ?? [],
      matchMode: filters.categorySearch?.matchMode === "exact" ? "exact" : "contains",
    },
    customTags: {
      include: filters.customTags?.include ?? [],
      exclude: filters.customTags?.exclude ?? [],
    },
    website: {
      include: filters.website?.include ?? [],
      exclude: filters.website?.exclude ?? [],
    },
    globalSearch: (filters.globalSearch ?? "").trim(),
    emailType: {
      personal: filters.emailType?.personal ?? true,
      general: filters.emailType?.general ?? true,
    },
    includeBounced: !!filters.includeBounced,
    excludeEmptyName: filters.excludeEmptyName || false,
    excludeEmptyCompany: filters.excludeEmptyCompany || false,
    excludeEmptyOverview: filters.excludeEmptyOverview || false,
    filterOperator: filters.filterOperator || "AND",
  };
}
