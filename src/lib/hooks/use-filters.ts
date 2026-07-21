"use client";

import { useCallback, useMemo, useReducer } from "react";
import {
  type FilterState,
  type IncludeExclude,
  type KeywordFilter,
  type EmailTypeFilter,
  type EmailContainsFilter,
  type RangeFilter,
  DEFAULT_FILTER_STATE,
  normalizeFilterState,
} from "@/types/filters";

type FilterAction =
  | { type: "SET_TEXT"; field: "fullName" | "companyName"; value: string }
  | { type: "SET_INCLUDE_EXCLUDE"; field: string; value: IncludeExclude }
  | { type: "SET_RANGE"; field: "companySize" | "revenue"; value: RangeFilter }
  | { type: "SET_LOCATION_COUNTRY"; value: IncludeExclude }
  | { type: "SET_LOCATION_STATE"; value: IncludeExclude }
  | { type: "SET_LOCATION_CITY"; value: IncludeExclude }
  | { type: "SET_FILTER_OPERATOR"; value: "AND" | "OR" }
  | { type: "TOGGLE_FLAG"; field: "excludeEmptyName" | "excludeEmptyCompany" | "excludeEmptyOverview"; value: boolean }
  | { type: "SET_KEYWORD"; value: KeywordFilter }
  | { type: "SET_EMAIL_TYPE"; value: EmailTypeFilter }
  | { type: "SET_EMAIL_CONTAINS"; value: EmailContainsFilter }
  | { type: "SET_GLOBAL_SEARCH"; value: string }
  | { type: "SET_INCLUDE_BOUNCED"; value: boolean }
  | { type: "SET_PAGE"; value: number }
  | { type: "SET_PAGE_SIZE"; value: number }
  | { type: "SET_SORT"; sortBy: string; sortDir: "asc" | "desc" }
  | { type: "LOAD_PRESET"; filters: FilterState }
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

  const toggleFlag = useCallback((field: "excludeEmptyName" | "excludeEmptyCompany" | "excludeEmptyOverview", value: boolean) => {
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

  const setGlobalSearch = useCallback((value: string) => {
    dispatch({ type: "SET_GLOBAL_SEARCH", value });
  }, []);

  const setIncludeBounced = useCallback((value: boolean) => {
    dispatch({ type: "SET_INCLUDE_BOUNCED", value });
  }, []);

  const loadPreset = useCallback((filters: FilterState) => {
    dispatch({ type: "LOAD_PRESET", filters });
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
      setGlobalSearch,
      setIncludeBounced,
      setPage,
      setPageSize,
      setSort,
      loadPreset,
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
      setGlobalSearch,
      setIncludeBounced,
      setPage,
      setPageSize,
      setSort,
      loadPreset,
      resetFilters,
    ]
  );
}
