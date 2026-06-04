"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { IncludeExclude } from "@/types/filters";

interface FilterMultiSelectProps {
  options: readonly string[];
  labels?: Record<string, string>;
  value: IncludeExclude;
  onChange: (value: IncludeExclude) => void;
  searchable?: boolean;
  onSearch?: (term: string) => void;
}

export function FilterMultiSelect({
  options,
  labels,
  value,
  onChange,
  searchable = false,
  onSearch,
}: FilterMultiSelectProps) {
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<"include" | "exclude">("include");

  const filteredOptions = searchable && !onSearch
    ? options.filter((opt) =>
        (labels?.[opt] ?? opt).toLowerCase().includes(search.toLowerCase())
      )
    : searchable && onSearch && search.length >= 2
      ? options // options are already filtered by live search
      : options;

  function resetSearch() {
    setSearch("");
    if (onSearch) onSearch("");
  }

  function toggleOption(option: string) {
    const currentList = mode === "include" ? value.include : value.exclude;
    const otherList = mode === "include" ? value.exclude : value.include;

    if (currentList.includes(option)) {
      const updated = currentList.filter((v) => v !== option);
      const otherCount = mode === "include" ? value.exclude.length : value.include.length;
      // Reset search when all selections are removed
      if (updated.length === 0 && otherCount === 0) resetSearch();
      onChange(
        mode === "include"
          ? { ...value, include: updated }
          : { ...value, exclude: updated }
      );
    } else {
      const cleanedOther = otherList.filter((v) => v !== option);
      const updated = [...currentList, option];
      onChange(
        mode === "include"
          ? { ...value, include: updated, exclude: cleanedOther }
          : { ...value, include: cleanedOther, exclude: updated }
      );
    }
  }

  function selectAll() {
    if (mode === "include") {
      onChange({ ...value, include: [...options], exclude: [] });
    } else {
      onChange({ ...value, exclude: [...options], include: [] });
    }
  }

  function clearAll() {
    setSearch("");
    if (onSearch) onSearch("");
    onChange({ include: [], exclude: [], operator: value.operator ?? "OR", includeUnknown: false });
  }

  const hasActive = value.include.length > 0 || value.exclude.length > 0 || !!value.includeUnknown;
  const op = value.operator ?? "OR";

  return (
    <div className="space-y-2">
      {/* Include / Exclude mode + OR/AND toggle */}
      <div className="flex items-center gap-1 flex-wrap">
        <Button
          variant={mode === "include" ? "default" : "ghost"}
          size="sm"
          className="h-6 text-xs px-2"
          onClick={() => setMode("include")}
        >
          Include
        </Button>
        <Button
          variant={mode === "exclude" ? "destructive" : "ghost"}
          size="sm"
          className="h-6 text-xs px-2"
          onClick={() => setMode("exclude")}
        >
          Exclude
        </Button>

        {/* Per-field OR / AND for the include list */}
        {value.include.length > 0 && (
          <div className="flex items-center gap-0.5 ml-auto border rounded overflow-hidden">
            <button
              type="button"
              onClick={() => onChange({ ...value, operator: "OR" })}
              className={`h-5 px-1.5 text-[10px] font-medium transition-colors ${
                op === "OR"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              OR
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...value, operator: "AND" })}
              className={`h-5 px-1.5 text-[10px] font-medium transition-colors ${
                op === "AND"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              AND
            </button>
          </div>
        )}

        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs px-2"
          onClick={selectAll}
        >
          All
        </Button>
        {hasActive && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs px-2"
            onClick={clearAll}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Active selections */}
      {hasActive && (
        <div className="flex flex-wrap gap-1">
          {value.include.length > 0 && (
            <div className="flex flex-wrap gap-1 w-full">
              {value.include.length > 1 && (
                <span className="text-[10px] text-muted-foreground self-center w-full">
                  {op}
                </span>
              )}
              {value.include.map((v) => (
                <Badge key={`inc-${v}`} variant="default" className="text-xs gap-1">
                  {v === "__UNKNOWN__" ? "Unknown / Empty" : (labels?.[v] ?? v)}
                  <button
                    type="button"
                    className="ml-0.5 rounded-full hover:bg-primary-foreground/20"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      const updated = value.include.filter((x) => x !== v);
                      if (updated.length === 0 && value.exclude.length === 0) resetSearch();
                      onChange({ ...value, include: updated });
                    }}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          {value.exclude.map((v) => (
            <Badge
              key={`exc-${v}`}
              variant="destructive"
              className="text-xs gap-1"
            >
              {v === "__UNKNOWN__" ? "Unknown / Empty" : (labels?.[v] ?? v)}
              <button
                type="button"
                className="ml-0.5 rounded-full hover:bg-destructive-foreground/20"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const updated = value.exclude.filter((x) => x !== v);
                  if (updated.length === 0 && value.include.length === 0) resetSearch();
                  onChange({ ...value, exclude: updated });
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {searchable && (
        <Input
          placeholder="Search..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            if (onSearch) onSearch(e.target.value);
          }}
          className="h-7 text-xs"
        />
      )}

      {/* Unknown / Empty — pinned at top, selectable like any value */}
      {(() => {
        const UNKNOWN_KEY = "__UNKNOWN__";
        const isIncluded = value.include.includes(UNKNOWN_KEY);
        const isExcluded = value.exclude.includes(UNKNOWN_KEY);
        const isActive =
          (mode === "include" && isIncluded) ||
          (mode === "exclude" && isExcluded);

        return (
          <button
            onClick={() => toggleOption(UNKNOWN_KEY)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50 ${
              isActive ? "bg-muted" : ""
            }`}
          >
            <div
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                isActive
                  ? mode === "include"
                    ? "bg-primary border-primary text-primary-foreground"
                    : "bg-destructive border-destructive text-destructive-foreground"
                  : "border-muted-foreground/30"
              }`}
            >
              {isActive && <Check className="h-2.5 w-2.5" />}
            </div>
            <span className="truncate italic">Unknown / Empty</span>
          </button>
        );
      })()}

      {/* Exclude Unknown / Empty checkbox */}
      <label className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50 cursor-pointer border border-dashed border-muted-foreground/30">
        <input
          type="checkbox"
          checked={!!value.includeUnknown}
          onChange={() => onChange({ ...value, includeUnknown: !value.includeUnknown })}
          className="rounded"
        />
        <span className="text-muted-foreground">Exclude Unknown / Empty</span>
      </label>

      <div className="max-h-40 overflow-y-auto space-y-0.5">
        {filteredOptions.map((option) => {
          const isIncluded = value.include.includes(option);
          const isExcluded = value.exclude.includes(option);
          const isActive =
            (mode === "include" && isIncluded) ||
            (mode === "exclude" && isExcluded);

          return (
            <button
              key={option}
              onClick={() => toggleOption(option)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50 ${
                isActive ? "bg-muted" : ""
              }`}
            >
              <div
                className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                  isActive
                    ? mode === "include"
                      ? "bg-primary border-primary text-primary-foreground"
                      : "bg-destructive border-destructive text-destructive-foreground"
                    : "border-muted-foreground/30"
                }`}
              >
                {isActive && <Check className="h-2.5 w-2.5" />}
              </div>
              <span className="truncate">{labels?.[option] ?? option}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
