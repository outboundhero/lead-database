"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// iOS toggle switch — pill track, white knob with shadow, iOS Green when on
// Usage: <IosToggle checked={x} onCheckedChange={setX} />
interface IosToggleProps {
  checked: boolean;
  onCheckedChange?: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
  "aria-label"?: string;
}

export function IosToggle({
  checked,
  onCheckedChange,
  disabled,
  className,
  size = "md",
  ...props
}: IosToggleProps) {
  const dims =
    size === "sm"
      ? { track: "h-6 w-10", knob: "size-5", translate: "translate-x-4" }
      : { track: "h-[31px] w-[51px]", knob: "size-[27px]", translate: "translate-x-5" };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange?.(!checked)}
      className={cn(
        "relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 ease-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
        dims.track,
        checked ? "bg-[var(--success)]" : "bg-[oklch(0.86_0.005_264)] dark:bg-[oklch(0.3_0.005_264)]",
        className
      )}
      {...props}
    >
      <span
        className={cn(
          "inline-block translate-x-0.5 transform rounded-full bg-white shadow-[0_2px_4px_rgba(0,0,0,0.15),0_3px_8px_rgba(0,0,0,0.08)] transition-transform duration-200 ease-out",
          dims.knob,
          checked && dims.translate
        )}
      />
    </button>
  );
}
