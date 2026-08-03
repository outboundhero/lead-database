import type { FilterState } from "@/types/filters";
import type { Lead } from "@/types/database";
import { expandTitleAliases } from "./title-aliases";

export interface FilterResult {
  data: Lead[];
  totalCount: number;
}

const U = "__UNKNOWN__";

// Per-side match modes (migration 062) — pass through only when set so old
// payload shapes stay byte-identical.
function modes(f?: { includeMode?: string; excludeMode?: string }) {
  return {
    ...(f?.includeMode ? { includeMode: f.includeMode } : {}),
    ...(f?.excludeMode ? { excludeMode: f.excludeMode } : {}),
  };
}

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
      ...modes(filters.jobTitle),
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
    company: { include: company.include, exclude: company.exclude, includeUnknown: company.includeUnknown, selectUnknown: company.selectUnknown, ...modes(filters.company) },
    category: { include: category.include, exclude: category.exclude, includeUnknown: category.includeUnknown, selectUnknown: category.selectUnknown, ...modes(filters.category) },
    subcategory: { include: subcategory.include, exclude: subcategory.exclude, includeUnknown: subcategory.includeUnknown, selectUnknown: subcategory.selectUnknown, ...modes(filters.subcategory) },
    additionalCategory: { include: additionalCategory.include, exclude: additionalCategory.exclude, includeUnknown: additionalCategory.includeUnknown, selectUnknown: additionalCategory.selectUnknown, ...modes(filters.additionalCategory) },
    tags: { include: filters.tags?.include ?? [], exclude: filters.tags?.exclude ?? [], ...modes(filters.tags) },
    location: {
      country: { include: country.include, exclude: country.exclude, includeUnknown: country.includeUnknown, selectUnknown: country.selectUnknown },
      state: { include: state.include, exclude: state.exclude, includeUnknown: state.includeUnknown, selectUnknown: state.selectUnknown, ...modes(filters.location.state) },
      // New shape: {include, exclude} arrays. The RPC also still accepts the
      // legacy plain-string form for old stored batch filters.
      city: { include: cityInclude, exclude: cityExclude, ...(typeof city === "object" && city ? modes(city) : {}) },
    },
    // Structured geo targeting — only sent when non-empty so old payload
    // shapes stay byte-identical (the RPC skips the key entirely when absent).
    ...((filters.locationTargets?.include?.length || filters.locationTargets?.exclude?.length)
      ? { locationTargets: { include: filters.locationTargets.include, exclude: filters.locationTargets.exclude } }
      : {}),
    companySize: { buckets: filters.companySize?.buckets || [], includeUnknown: filters.companySize?.includeUnknown || false, customMin: filters.companySize?.customMin ?? null, customMax: filters.companySize?.customMax ?? null },
    revenue: { buckets: filters.revenue?.buckets || [], includeUnknown: filters.revenue?.includeUnknown || false },
    fullName: filters.fullName || "",
    companyName: filters.companyName || "",
    keyword: {
      include: filters.keyword?.include ?? [],
      exclude: filters.keyword?.exclude ?? [],
      matchMode: filters.keyword?.matchMode === "exact" ? "exact" : "contains",
      ...modes(filters.keyword),
    },
    emailContains: {
      include: filters.emailContains?.include ?? [],
      exclude: filters.emailContains?.exclude ?? [],
    },
    categorySearch: {
      include: filters.categorySearch?.include ?? [],
      exclude: filters.categorySearch?.exclude ?? [],
      matchMode: filters.categorySearch?.matchMode === "exact" ? "exact" : "contains",
      ...modes(filters.categorySearch),
    },
    customTags: {
      include: filters.customTags?.include ?? [],
      exclude: filters.customTags?.exclude ?? [],
      ...modes(filters.customTags),
    },
    website: {
      include: filters.website?.include ?? [],
      exclude: filters.website?.exclude ?? [],
      ...modes(filters.website),
    },
    globalSearch: (filters.globalSearch ?? "").trim(),
    emailType: {
      personal: filters.emailType?.personal ?? true,
      general: filters.emailType?.general ?? true,
    },
    includeBounced: !!filters.includeBounced,
    commercialCleaning: !!filters.commercialCleaning,
    excludeEmptyName: filters.excludeEmptyName || false,
    excludeEmptyCompany: filters.excludeEmptyCompany || false,
    excludeEmptyOverview: filters.excludeEmptyOverview || false,
    filterOperator: filters.filterOperator || "AND",
  };
}
