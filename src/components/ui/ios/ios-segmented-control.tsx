"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// iOS segmented control — pill background, white selected segment with subtle shadow
// Usage:
//   <IosSegmentedControl
//     value={x} onChange={setX}
//     options={[{value:'personal', label:'Personal'}, {value:'general', label:'General'}]}
//   />

interface IosSegmentedControlOption<T extends string> {
  value: T;
  label: React.ReactNode;
}

interface IosSegmentedControlProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: IosSegmentedControlOption<T>[];
  size?: "sm" | "md";
  className?: string;
  fullWidth?: boolean;
}

export function IosSegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
  fullWidth = false,
}: IosSegmentedControlProps<T>) {
  const heights = size === "sm" ? "h-8" : "h-10";
  const textSize = size === "sm" ? "text-xs" : "text-[13px]";
  return (
    <div
      role="tablist"
      className={cn(
        "relative inline-flex items-center rounded-xl bg-[oklch(0.92_0.004_264)] p-0.5 dark:bg-[oklch(0.22_0.005_264)]",
        heights,
        fullWidth && "w-full",
        className
      )}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative z-10 inline-flex flex-1 cursor-pointer items-center justify-center rounded-[10px] px-3 font-medium transition-all duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40",
              textSize,
              selected
                ? "bg-card text-foreground shadow-[0_2px_6px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
