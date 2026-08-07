"use client";

import { useCallback, useMemo, useReducer } from "react";
import {
  type FilterState,
  type IncludeExclude,
  type KeywordFilter,
  type EmailTypeFilter,
  type EmailContainsFilter,
  type CategorySearchFilter,
  type CustomTagsFilter,
  type WebsiteFilter,
  type RangeFilter,
  type LocationTargetEntry,
  type LocationTargetsFilter,
  DEFAULT_FILTER_STATE,
  normalizeFilterState,
} from "@/types/filters";

// Everything one client tag's targeting rules contribute to the filters —
// applied as a unit on tag select and removed as a unit on deselect.
// Locations flatten into the State/City filters directly (client decision
// 2026-08-06): city entries -> location.city.include (exact), state-level
// entries -> location.state.include.
export interface TargetingPatch {
  locations: LocationTargetsFilter;
  categorySearchInclude: string[]; // include phrases -> categorySearch.include (contains)
  keywordExclude: string[];        // exclude keywords -> keyword.exclude (whole-term exact)
  categoryExclude: string[];       // exclude industries -> category.exclude (exact)
  commercialCleaning?: boolean;    // Cleaning clients auto-enable the CC toggle
}

const entryCities = (entries: LocationTargetEntry[]) =>
  entries.filter((e) => e.city).map((e) => e.city as string);
const entryStates = (entries: LocationTargetEntry[]) =>
  entries.filter((e) => !e.city && e.state).map((e) => e.state as string);

const targetKey = (e: LocationTargetEntry) => `${e.country}|${e.state ?? ""}|${e.city ?? ""}`;

function mergeEntries(current: LocationTargetEntry[], added: LocationTargetEntry[]) {
  const seen = new Set(current.map(targetKey));
  return [...current, ...added.filter((e) => !seen.has(targetKey(e)))];
}

function removeEntries(current: LocationTargetEntry[], removed: LocationTargetEntry[]) {
  const drop = new Set(removed.map(targetKey));
  return current.filter((e) => !drop.has(targetKey(e)));
}

const mergeStrings = (current: string[], added: string[]) => {
  const seen = new Set(current.map((s) => s.toLowerCase()));
  return [...current, ...added.filter((s) => !seen.has(s.toLowerCase()))];
};

const removeStrings = (current: string[], removed: string[]) => {
  const drop = new Set(removed.map((s) => s.toLowerCase()));
  return current.filter((s) => !drop.has(s.toLowerCase()));
};

type FilterAction =
  | { type: "SET_TEXT"; field: "fullName" | "companyName"; value: string }
  | { type: "SET_INCLUDE_EXCLUDE"; field: string; value: IncludeExclude }
  | { type: "SET_RANGE"; field: "companySize" | "revenue"; value: RangeFilter }
  | { type: "SET_LOCATION_COUNTRY"; value: IncludeExclude }
  | { type: "SET_LOCATION_STATE"; value: IncludeExclude }
  | { type: "SET_LOCATION_CITY"; value: IncludeExclude }
  | { type: "SET_FILTER_OPERATOR"; value: "AND" | "OR" }
  | { type: "TOGGLE_FLAG"; field: "excludeEmptyName" | "excludeEmptyCompany" | "excludeEmptyOverview" | "commercialCleaning"; value: boolean }
  | { type: "SET_KEYWORD"; value: KeywordFilter }
  | { type: "SET_EMAIL_TYPE"; value: EmailTypeFilter }
  | { type: "SET_EMAIL_CONTAINS"; value: EmailContainsFilter }
  | { type: "SET_CATEGORY_SEARCH"; value: CategorySearchFilter }
  | { type: "SET_CUSTOM_TAGS"; value: CustomTagsFilter }
  | { type: "SET_WEBSITE"; value: WebsiteFilter }
  | { type: "SET_GLOBAL_SEARCH"; value: string }
  | { type: "SET_INCLUDE_BOUNCED"; value: boolean }
  | { type: "SET_PAGE"; value: number }
  | { type: "SET_PAGE_SIZE"; value: number }
  | { type: "SET_SORT"; sortBy: string; sortDir: "asc" | "desc" }
  | { type: "LOAD_PRESET"; filters: FilterState }
  | { type: "SET_LOCATION_TARGETS"; value: LocationTargetsFilter }
  | { type: "SET_CATEGORY_CASCADE"; value: { enabled: boolean; includeCompany: boolean } }
  | { type: "SET_CLIENT_TAG"; value: string | null }
  | { type: "APPLY_CLIENT_TARGETING"; patch: TargetingPatch }
  | { type: "REMOVE_CLIENT_TARGETING"; patch: TargetingPatch }
  | { type: "RESET" };

function filterReducer(state: FilterState, action: FilterAction): FilterState {
  switch (action.type) {
    case "SET_TEXT":
      return { ...state, [action.field]: action.value, page: 1 };
    case "SET_INCLUDE_EXCLUDE":
      return { ...state, [action.field]: action.value, page: 1 };
    case "SET_RANGE":
      return { ...state, [action.field]: action.value, page: 1 };
    case "SET_LOCATION_COUNTRY":
      return { ...state, location: { ...state.location, country: action.value }, page: 1 };
    case "SET_LOCATION_STATE":
      return { ...state, location: { ...state.location, state: action.value }, page: 1 };
    case "SET_LOCATION_CITY":
      return { ...state, location: { ...state.location, city: action.value }, page: 1 };
    case "SET_FILTER_OPERATOR":
      return { ...state, filterOperator: action.value, page: 1 };
    case "TOGGLE_FLAG":
      return { ...state, [action.field]: action.value, page: 1 };
    case "SET_KEYWORD":
      return { ...state, keyword: action.value, page: 1 };
    case "SET_EMAIL_TYPE":
      return { ...state, emailType: action.value, page: 1 };
    case "SET_EMAIL_CONTAINS":
      return { ...state, emailContains: action.value, page: 1 };
    case "SET_CATEGORY_SEARCH":
      return { ...state, categorySearch: action.value, page: 1 };
    case "SET_CUSTOM_TAGS":
      return { ...state, customTags: action.value, page: 1 };
    case "SET_WEBSITE":
      return { ...state, website: action.value, page: 1 };
    case "SET_GLOBAL_SEARCH":
      return { ...state, globalSearch: action.value, page: 1 };
    case "SET_INCLUDE_BOUNCED":
      return { ...state, includeBounced: action.value, page: 1 };
    case "SET_PAGE":
      return { ...state, page: action.value };
    case "SET_PAGE_SIZE":
      return { ...state, pageSize: action.value, page: 1 };
    case "SET_SORT":
      return { ...state, sortBy: action.sortBy, sortDir: action.sortDir, page: 1 };
    case "LOAD_PRESET":
      // Stored presets may predate newer FilterState keys — merge onto defaults
      return { ...normalizeFilterState(action.filters), page: 1 };
    case "SET_LOCATION_TARGETS":
      return { ...state, locationTargets: action.value, page: 1 };
    case "SET_CATEGORY_CASCADE":
      return { ...state, categoryCascade: action.value, page: 1 };
    case "SET_CLIENT_TAG":
      // Selecting a client scopes settings/exports — it must NOT filter leads
      // by the tag (client req #1), or a search only ever returns leads that
      // were already pushed for that client.
      return { ...state, clientTag: action.value, page: 1 };
    case "APPLY_CLIENT_TARGETING":
      return {
        ...state,
        location: {
          ...state.location,
          city: {
            ...state.location.city,
            include: mergeStrings(state.location.city.include, entryCities(action.patch.locations.include)),
            exclude: mergeStrings(state.location.city.exclude, entryCities(action.patch.locations.exclude)),
            // Exact whole-city matching (sheet cities are geo-validated names).
            ...(entryCities(action.patch.locations.include).length && state.location.city.include.length === 0
              ? { includeMode: "exact" as const } : {}),
          },
          state: {
            ...state.location.state,
            include: mergeStrings(state.location.state.include, entryStates(action.patch.locations.include)),
            exclude: mergeStrings(state.location.state.exclude, entryStates(action.patch.locations.exclude)),
          },
        },
        ...(action.patch.commercialCleaning ? { commercialCleaning: true } : {}),
        // Side-wide match modes are only set when the side was EMPTY — flipping
        // the mode under a user's pre-existing terms would silently change what
        // those terms match.
        categorySearch: {
          ...state.categorySearch,
          include: mergeStrings(state.categorySearch.include, action.patch.categorySearchInclude),
          ...(action.patch.categorySearchInclude.length && state.categorySearch.include.length === 0
            ? { includeMode: "contains" as const } : {}),
        },
        keyword: {
          ...state.keyword,
          exclude: mergeStrings(state.keyword.exclude, action.patch.keywordExclude),
          // Whole-term matching so "retail" doesn't nuke "Retail Solutions Corp" by substring accident.
          ...(action.patch.keywordExclude.length && state.keyword.exclude.length === 0
            ? { excludeMode: "exact" as const } : {}),
        },
        category: {
          ...state.category,
          exclude: mergeStrings(state.category.exclude, action.patch.categoryExclude),
        },
        page: 1,
      };
    case "REMOVE_CLIENT_TARGETING":
      return {
        ...state,
        location: {
          ...state.location,
          city: {
            ...state.location.city,
            include: removeStrings(state.location.city.include, entryCities(action.patch.locations.include)),
            exclude: removeStrings(state.location.city.exclude, entryCities(action.patch.locations.exclude)),
          },
          state: {
            ...state.location.state,
            include: removeStrings(state.location.state.include, entryStates(action.patch.locations.include)),
            exclude: removeStrings(state.location.state.exclude, entryStates(action.patch.locations.exclude)),
          },
        },
        ...(action.patch.commercialCleaning ? { commercialCleaning: false } : {}),
        categorySearch: {
          ...state.categorySearch,
          include: removeStrings(state.categorySearch.include, action.patch.categorySearchInclude),
        },
        keyword: {
          ...state.keyword,
          exclude: removeStrings(state.keyword.exclude, action.patch.keywordExclude),
        },
        category: {
          ...state.category,
          exclude: removeStrings(state.category.exclude, action.patch.categoryExclude),
        },
        page: 1,
      };
    case "RESET":
      return DEFAULT_FILTER_STATE;
    default:
      return state;
  }
}

export function useFilters() {
  const [filters, dispatch] = useReducer(filterReducer, DEFAULT_FILTER_STATE);

  const setText = useCallback(
    (field: "fullName" | "companyName", value: string) => {
      dispatch({ type: "SET_TEXT", field, value });
    },
    []
  );

  const setIncludeExclude = useCallback(
    (field: string, value: IncludeExclude) => {
      dispatch({ type: "SET_INCLUDE_EXCLUDE", field, value });
    },
    []
  );

  const setRange = useCallback(
    (field: "companySize" | "revenue", value: RangeFilter) => {
      dispatch({ type: "SET_RANGE", field, value });
    },
    []
  );

  const setLocationCountry = useCallback((value: IncludeExclude) => {
    dispatch({ type: "SET_LOCATION_COUNTRY", value });
  }, []);

  const setLocationState = useCallback((value: IncludeExclude) => {
    dispatch({ type: "SET_LOCATION_STATE", value });
  }, []);

  const setLocationCity = useCallback((value: IncludeExclude) => {
    dispatch({ type: "SET_LOCATION_CITY", value });
  }, []);

  const setPage = useCallback((value: number) => {
    dispatch({ type: "SET_PAGE", value });
  }, []);

  const setPageSize = useCallback((value: number) => {
    dispatch({ type: "SET_PAGE_SIZE", value });
  }, []);

  const setSort = useCallback((sortBy: string, sortDir: "asc" | "desc") => {
    dispatch({ type: "SET_SORT", sortBy, sortDir });
  }, []);

  const setFilterOperator = useCallback((value: "AND" | "OR") => {
    dispatch({ type: "SET_FILTER_OPERATOR", value });
  }, []);

  const toggleFlag = useCallback((field: "excludeEmptyName" | "excludeEmptyCompany" | "excludeEmptyOverview" | "commercialCleaning", value: boolean) => {
    dispatch({ type: "TOGGLE_FLAG", field, value });
  }, []);

  const setKeyword = useCallback((value: KeywordFilter) => {
    dispatch({ type: "SET_KEYWORD", value });
  }, []);

  const setEmailType = useCallback((value: EmailTypeFilter) => {
    dispatch({ type: "SET_EMAIL_TYPE", value });
  }, []);

  const setEmailContains = useCallback((value: EmailContainsFilter) => {
    dispatch({ type: "SET_EMAIL_CONTAINS", value });
  }, []);
  const setCategorySearch = useCallback((value: CategorySearchFilter) => {
    dispatch({ type: "SET_CATEGORY_SEARCH", value });
  }, []);
  const setCustomTags = useCallback((value: CustomTagsFilter) => {
    dispatch({ type: "SET_CUSTOM_TAGS", value });
  }, []);
  const setWebsite = useCallback((value: WebsiteFilter) => {
    dispatch({ type: "SET_WEBSITE", value });
  }, []);

  const setGlobalSearch = useCallback((value: string) => {
    dispatch({ type: "SET_GLOBAL_SEARCH", value });
  }, []);

  const setIncludeBounced = useCallback((value: boolean) => {
    dispatch({ type: "SET_INCLUDE_BOUNCED", value });
  }, []);

  const loadPreset = useCallback((filters: FilterState) => {
    dispatch({ type: "LOAD_PRESET", filters });
  }, []);

  const setLocationTargets = useCallback((value: LocationTargetsFilter) => {
    dispatch({ type: "SET_LOCATION_TARGETS", value });
  }, []);

  const setCategoryCascade = useCallback((value: { enabled: boolean; includeCompany: boolean }) => {
    dispatch({ type: "SET_CATEGORY_CASCADE", value });
  }, []);

  const setClientTag = useCallback((value: string | null) => {
    dispatch({ type: "SET_CLIENT_TAG", value });
  }, []);

  const applyClientTargeting = useCallback((patch: TargetingPatch) => {
    dispatch({ type: "APPLY_CLIENT_TARGETING", patch });
  }, []);

  const removeClientTargeting = useCallback((patch: TargetingPatch) => {
    dispatch({ type: "REMOVE_CLIENT_TARGETING", patch });
  }, []);

  const resetFilters = useCallback(() => {
    dispatch({ type: "RESET" });
  }, []);

  return useMemo(
    () => ({
      filters,
      setText,
      setIncludeExclude,
      setRange,
      setLocationCountry,
      setLocationState,
      setLocationCity,
      setFilterOperator,
      toggleFlag,
      setKeyword,
      setEmailType,
      setEmailContains,
      setCategorySearch,
      setCustomTags,
      setWebsite,
      setGlobalSearch,
      setIncludeBounced,
      setPage,
      setPageSize,
      setSort,
      loadPreset,
      setLocationTargets,
      setCategoryCascade,
      setClientTag,
      applyClientTargeting,
      removeClientTargeting,
      resetFilters,
    }),
    [
      filters,
      setText,
      setIncludeExclude,
      setRange,
      setLocationCountry,
      setLocationState,
      setLocationCity,
      setFilterOperator,
      toggleFlag,
      setKeyword,
      setEmailType,
      setEmailContains,
      setCategorySearch,
      setCustomTags,
      setWebsite,
      setGlobalSearch,
      setIncludeBounced,
      setPage,
      setPageSize,
      setSort,
      loadPreset,
      setLocationTargets,
      setCategoryCascade,
      setClientTag,
      applyClientTargeting,
      removeClientTargeting,
      resetFilters,
    ]
  );
}
