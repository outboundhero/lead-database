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
  const country = stripUnknown(filters.location.country);
  const state = stripUnknown(filters.location.state);

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
    location: {
      country: { include: country.include, exclude: country.exclude, includeUnknown: country.includeUnknown, selectUnknown: country.selectUnknown },
      state: { include: state.include, exclude: state.exclude, includeUnknown: state.includeUnknown, selectUnknown: state.selectUnknown },
      city: filters.location.city || "",
    },
    companySize: { buckets: filters.companySize?.buckets || [], includeUnknown: filters.companySize?.includeUnknown || false, customMin: filters.companySize?.customMin ?? null, customMax: filters.companySize?.customMax ?? null },
    revenue: { buckets: filters.revenue?.buckets || [], includeUnknown: filters.revenue?.includeUnknown || false },
    fullName: filters.fullName || "",
    companyName: filters.companyName || "",
    keyword: filters.keyword || "",
    excludeEmptyName: filters.excludeEmptyName || false,
    excludeEmptyCompany: filters.excludeEmptyCompany || false,
    excludeEmptyOverview: filters.excludeEmptyOverview || false,
    filterOperator: filters.filterOperator || "AND",
  };
}
