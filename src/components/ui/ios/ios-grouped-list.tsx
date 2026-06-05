"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";

// iOS grouped list — card with rounded outer corners only on first/last cells,
// inset hairline separators between cells (offset by leading icon padding).
// Use IosGroupedList as the wrapper, IosListCell for each row.

interface IosGroupedListProps extends React.HTMLAttributes<HTMLDivElement> {
  footer?: React.ReactNode;
  header?: React.ReactNode;
}

export function IosGroupedList({
  className,
  children,
  header,
  footer,
  ...props
}: IosGroupedListProps) {
  return (
    <div className={cn("space-y-1.5", className)} {...props}>
      {header && (
        <div className="px-4 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {header}
        </div>
      )}
      <div className="overflow-hidden rounded-2xl bg-card shadow-ios">
        {children}
      </div>
      {footer && (
        <div className="px-4 text-[12px] text-muted-foreground">{footer}</div>
      )}
    </div>
  );
}

interface IosListCellProps extends React.ComponentProps<"button"> {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  subtitle?: React.ReactNode;
  active?: boolean;
  showChevron?: boolean;
  asDiv?: boolean;
}

export function IosListCell({
  leading,
  trailing,
  subtitle,
  active,
  showChevron,
  asDiv,
  className,
  children,
  ...props
}: IosListCellProps) {
  const inner = (
    <>
      {leading && (
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/80",
            "[&_svg]:size-[18px]"
          )}
        >
          {leading}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-left text-[15px] font-medium leading-tight">
        {children}
        {subtitle && (
          <span className="mt-0.5 block truncate text-[13px] font-normal text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
      {trailing && (
        <span className="ml-2 flex shrink-0 items-center gap-2 text-[14px] text-muted-foreground">
          {trailing}
        </span>
      )}
      {showChevron && (
        <ChevronRight className="ml-1 size-4 shrink-0 text-muted-foreground/60" />
      )}
    </>
  );

  const sharedCls = cn(
    "group/cell relative flex w-full items-center gap-3 px-4 py-3 text-foreground transition-colors",
    "first:rounded-t-2xl last:rounded-b-2xl",
    // Hairline separator at top of every cell except the first — inset by leading icon (28px) + gap (12px) + cell px (16px) = ~56px when icon present
    "[&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:left-4 [&:not(:first-child)]:before:right-0 [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:h-px [&:not(:first-child)]:before:bg-border [&:has(>span:first-child:not(:empty))]:before:left-[60px]",
    active && "bg-accent text-primary",
    !asDiv && "hover:bg-muted/60 active:bg-muted",
    className
  );

  if (asDiv) {
    return (
      <div className={sharedCls}>{inner}</div>
    );
  }
  return (
    <button type="button" className={sharedCls} {...props}>
      {inner}
    </button>
  );
}
