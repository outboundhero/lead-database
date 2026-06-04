"use client";

import { Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { RangeFilter } from "@/types/filters";

interface FilterRangeProps {
  buckets: readonly string[];
  value: RangeFilter;
  onChange: (value: RangeFilter) => void;
  showUnknownToggle?: boolean;
  showCustomRange?: boolean;
}

export function FilterRange({
  buckets,
  value,
  onChange,
  showUnknownToggle = true,
  showCustomRange = false,
}: FilterRangeProps) {
  const hasCustomRange = value.customMin != null || value.customMax != null;

  function toggleBucket(bucket: string) {
    const updated = value.buckets.includes(bucket)
      ? value.buckets.filter((b) => b !== bucket)
      : [...value.buckets, bucket];
    // Clear custom range when using buckets
    onChange({ ...value, buckets: updated, customMin: null, customMax: null });
  }

  function toggleUnknown() {
    onChange({ ...value, includeUnknown: !value.includeUnknown });
  }

  function setCustomMin(val: string) {
    const num = val === "" ? null : parseInt(val, 10);
    // Clear buckets when using custom range
    onChange({ ...value, customMin: num, buckets: [] });
  }

  function setCustomMax(val: string) {
    const num = val === "" ? null : parseInt(val, 10);
    onChange({ ...value, customMax: num, buckets: [] });
  }

  return (
    <div className="space-y-1">
      {showCustomRange && (
        <div className="space-y-1 pb-2 mb-1 border-b border-muted-foreground/20">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Custom Range</span>
          <div className="flex items-center gap-1.5">
            <Input
              type="number"
              placeholder="Min"
              value={value.customMin ?? ""}
              onChange={(e) => setCustomMin(e.target.value)}
              className="h-7 text-xs w-20"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="number"
              placeholder="Max"
              value={value.customMax ?? ""}
              onChange={(e) => setCustomMax(e.target.value)}
              className="h-7 text-xs w-20"
            />
          </div>
        </div>
      )}

      {(!hasCustomRange || !showCustomRange) && buckets.map((bucket) => {
        const isActive = value.buckets.includes(bucket);
        return (
          <button
            key={bucket}
            onClick={() => toggleBucket(bucket)}
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50 ${
              isActive ? "bg-muted" : ""
            }`}
          >
            <div
              className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                isActive
                  ? "bg-primary border-primary text-primary-foreground"
                  : "border-muted-foreground/30"
              }`}
            >
              {isActive && <Check className="h-2.5 w-2.5" />}
            </div>
            <span>{bucket}</span>
          </button>
        );
      })}
      {showUnknownToggle && (
        <button
          onClick={toggleUnknown}
          className={`flex w-full items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/50 ${
            value.includeUnknown ? "bg-muted" : ""
          }`}
        >
          <div
            className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
              value.includeUnknown
                ? "bg-primary border-primary text-primary-foreground"
                : "border-muted-foreground/30"
            }`}
          >
            {value.includeUnknown && <Check className="h-2.5 w-2.5" />}
          </div>
          <span className="italic text-muted-foreground">Include Unknown</span>
        </button>
      )}
    </div>
  );
}
