// src/lib/filters/title-aliases.ts
var TITLE_ALIASES = {
  ceo: [
    "ceo",
    "c.e.o.",
    "c.e.o",
    "chief executive officer",
    "chief executive",
    "founder & ceo",
    "founder and ceo",
    "ceo & founder",
    "ceo and founder",
    "co-founder & ceo",
    "co-founder and ceo",
    "cofounder & ceo",
    "ceo / founder",
    "founder/ceo"
  ],
  owner: [
    "owner",
    "business owner",
    "owner/operator",
    "owner / operator",
    "sole proprietor",
    "proprietor",
    "owner & founder",
    "owner and founder",
    "owner-operator",
    "owner / president"
  ],
  president: [
    "president",
    "co-president",
    "vice president",
    "founder & president",
    "president & ceo",
    "president and ceo",
    "president/ceo"
  ],
  founder: [
    "founder",
    "co-founder",
    "cofounder",
    "co founder",
    "founding partner",
    "founder & president",
    "founder/owner"
  ],
  coo: [
    "coo",
    "c.o.o.",
    "c.o.o",
    "chief operating officer",
    "chief operations officer"
  ],
  cfo: [
    "cfo",
    "c.f.o.",
    "c.f.o",
    "chief financial officer",
    "vp finance",
    "vp of finance"
  ],
  cto: [
    "cto",
    "c.t.o.",
    "c.t.o",
    "chief technology officer",
    "chief technical officer"
  ],
  cmo: [
    "cmo",
    "c.m.o.",
    "chief marketing officer",
    "vp marketing",
    "vp of marketing"
  ],
  cio: [
    "cio",
    "c.i.o.",
    "chief information officer"
  ],
  vp: [
    "vp",
    "v.p.",
    "vice president",
    "vice-president"
  ],
  director: [
    "director",
    "dir",
    "managing director",
    "executive director"
  ],
  manager: [
    "manager",
    "mgr",
    "general manager",
    "operations manager"
  ]
};
function expandTitleAliases(titles) {
  const out = /* @__PURE__ */ new Set();
  for (const raw of titles) {
    const key = raw.trim().toLowerCase();
    const aliases = TITLE_ALIASES[key];
    if (aliases) {
      for (const a of aliases) out.add(a);
    } else {
      out.add(key);
    }
  }
  return Array.from(out);
}

// src/lib/filters/build-rpc-filters.ts
var U = "__UNKNOWN__";
function modes(f) {
  return {
    ...f?.includeMode ? { includeMode: f.includeMode } : {},
    ...f?.excludeMode ? { excludeMode: f.excludeMode } : {}
  };
}
function stripUnknown(ie2) {
  const includeHas = ie2.include.includes(U);
  const excludeHas = ie2.exclude.includes(U);
  return {
    include: ie2.include.filter((v) => v !== U),
    exclude: ie2.exclude.filter((v) => v !== U),
    // includeUnknown (RPC flag): true = exclude nulls — from checkbox OR exclude selection
    includeUnknown: ie2.includeUnknown || excludeHas,
    // selectUnknown: true = include null/empty rows in results
    selectUnknown: includeHas
  };
}
function buildRpcFilters(filters) {
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
  const cityInclude = typeof city === "string" ? city ? [city] : [] : city?.include ?? [];
  const cityExclude = typeof city === "string" ? [] : city?.exclude ?? [];
  return {
    // Expand selected titles via alias map so "CEO" also matches "Chief Executive
    // Officer", "c.e.o.", etc. See title-aliases.ts.
    jobTitle: {
      include: expandTitleAliases(jobTitle.include),
      exclude: expandTitleAliases(jobTitle.exclude),
      includeUnknown: jobTitle.includeUnknown,
      selectUnknown: jobTitle.selectUnknown,
      ...modes(filters.jobTitle)
    },
    generalIndustry: { include: generalIndustry.include, exclude: generalIndustry.exclude, includeUnknown: generalIndustry.includeUnknown, selectUnknown: generalIndustry.selectUnknown },
    specificIndustry: { include: specificIndustry.include, exclude: specificIndustry.exclude, includeUnknown: specificIndustry.includeUnknown, selectUnknown: specificIndustry.selectUnknown },
    source: { include: source.include, exclude: source.exclude, includeUnknown: source.includeUnknown, selectUnknown: source.selectUnknown },
    seniority: { include: seniority.include, exclude: seniority.exclude, includeUnknown: seniority.includeUnknown, selectUnknown: seniority.selectUnknown },
    esp: {
      include: espRaw.include.flatMap((v) => v === "Microsoft / Outlook" ? ["Microsoft", "Outlook"] : [v]),
      exclude: espRaw.exclude.flatMap((v) => v === "Microsoft / Outlook" ? ["Microsoft", "Outlook"] : [v]),
      includeUnknown: espRaw.includeUnknown,
      selectUnknown: espRaw.selectUnknown
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
      city: { include: cityInclude, exclude: cityExclude, ...typeof city === "object" && city ? modes(city) : {} }
    },
    // Structured geo targeting — only sent when non-empty so old payload
    // shapes stay byte-identical (the RPC skips the key entirely when absent).
    ...filters.locationTargets?.include?.length || filters.locationTargets?.exclude?.length ? { locationTargets: { include: filters.locationTargets.include, exclude: filters.locationTargets.exclude } } : {},
    companySize: { buckets: filters.companySize?.buckets || [], includeUnknown: filters.companySize?.includeUnknown || false, customMin: filters.companySize?.customMin ?? null, customMax: filters.companySize?.customMax ?? null },
    revenue: { buckets: filters.revenue?.buckets || [], includeUnknown: filters.revenue?.includeUnknown || false },
    fullName: filters.fullName || "",
    companyName: filters.companyName || "",
    keyword: {
      include: filters.keyword?.include ?? [],
      exclude: filters.keyword?.exclude ?? [],
      matchMode: filters.keyword?.matchMode === "exact" ? "exact" : "contains",
      ...modes(filters.keyword)
    },
    emailContains: {
      include: filters.emailContains?.include ?? [],
      exclude: filters.emailContains?.exclude ?? []
    },
    categorySearch: {
      include: filters.categorySearch?.include ?? [],
      exclude: filters.categorySearch?.exclude ?? [],
      matchMode: filters.categorySearch?.matchMode === "exact" ? "exact" : "contains",
      ...modes(filters.categorySearch)
    },
    customTags: {
      include: filters.customTags?.include ?? [],
      exclude: filters.customTags?.exclude ?? [],
      ...modes(filters.customTags)
    },
    website: {
      include: filters.website?.include ?? [],
      exclude: filters.website?.exclude ?? [],
      ...modes(filters.website)
    },
    globalSearch: (filters.globalSearch ?? "").trim(),
    emailType: {
      personal: filters.emailType?.personal ?? true,
      general: filters.emailType?.general ?? true
    },
    includeBounced: !!filters.includeBounced,
    commercialCleaning: !!filters.commercialCleaning,
    excludeEmptyName: filters.excludeEmptyName || false,
    excludeEmptyCompany: filters.excludeEmptyCompany || false,
    excludeEmptyOverview: filters.excludeEmptyOverview || false,
    filterOperator: filters.filterOperator || "AND"
  };
}

// src/types/filters.ts
function ie(operator = "OR") {
  return { include: [], exclude: [], operator };
}
var DEFAULT_FILTER_STATE = {
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
  location: {
    country: ie(),
    state: ie(),
    city: ie()
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
  page: 1,
  pageSize: 50,
  sortBy: "created_at",
  sortDir: "desc"
};
function sanitizeTargetEntries(v) {
  if (!Array.isArray(v)) return [];
  return v.filter(
    (e) => !!e && typeof e === "object" && typeof e.country === "string" && e.country.trim().length > 0
  );
}
function normalizeFilterState(partial) {
  const p = partial && typeof partial === "object" ? partial : {};
  const mode = (m) => m === "exact" || m === "contains" ? m : void 0;
  const mergeIE = (v, d2) => ({
    include: Array.isArray(v?.include) ? v.include : d2.include,
    exclude: Array.isArray(v?.exclude) ? v.exclude : d2.exclude,
    operator: v?.operator === "AND" ? "AND" : d2.operator,
    includeUnknown: typeof v?.includeUnknown === "boolean" ? v.includeUnknown : d2.includeUnknown,
    includeMode: mode(v?.includeMode),
    excludeMode: mode(v?.excludeMode)
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
      city: typeof p.location?.city === "string" ? { ...d.location.city, include: p.location.city ? [p.location.city] : [] } : mergeIE(p.location?.city, d.location.city)
    },
    locationTargets: {
      include: sanitizeTargetEntries(p.locationTargets?.include),
      exclude: sanitizeTargetEntries(p.locationTargets?.exclude)
    },
    companySize: { ...d.companySize, ...p.companySize ?? {} },
    revenue: { ...d.revenue, ...p.revenue ?? {} },
    keyword: {
      include: Array.isArray(p.keyword?.include) ? p.keyword.include : d.keyword.include,
      exclude: Array.isArray(p.keyword?.exclude) ? p.keyword.exclude : d.keyword.exclude,
      matchMode: p.keyword?.matchMode === "exact" ? "exact" : "contains",
      includeMode: mode(p.keyword?.includeMode),
      excludeMode: mode(p.keyword?.excludeMode)
    },
    emailContains: {
      include: Array.isArray(p.emailContains?.include) ? p.emailContains.include : d.emailContains.include,
      exclude: Array.isArray(p.emailContains?.exclude) ? p.emailContains.exclude : d.emailContains.exclude
    },
    categorySearch: {
      include: Array.isArray(p.categorySearch?.include) ? p.categorySearch.include : d.categorySearch.include,
      exclude: Array.isArray(p.categorySearch?.exclude) ? p.categorySearch.exclude : d.categorySearch.exclude,
      matchMode: p.categorySearch?.matchMode === "exact" ? "exact" : "contains",
      includeMode: mode(p.categorySearch?.includeMode),
      excludeMode: mode(p.categorySearch?.excludeMode)
    },
    customTags: {
      include: Array.isArray(p.customTags?.include) ? p.customTags.include : d.customTags.include,
      exclude: Array.isArray(p.customTags?.exclude) ? p.customTags.exclude : d.customTags.exclude,
      includeMode: mode(p.customTags?.includeMode),
      excludeMode: mode(p.customTags?.excludeMode)
    },
    website: {
      include: Array.isArray(p.website?.include) ? p.website.include : d.website.include,
      exclude: Array.isArray(p.website?.exclude) ? p.website.exclude : d.website.exclude,
      includeMode: mode(p.website?.includeMode),
      excludeMode: mode(p.website?.excludeMode)
    },
    globalSearch: typeof p.globalSearch === "string" ? p.globalSearch : d.globalSearch,
    emailType: { ...d.emailType, ...p.emailType ?? {} },
    commercialCleaning: p.commercialCleaning === true
  };
}
export {
  buildRpcFilters,
  normalizeFilterState
};
