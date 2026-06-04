"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface FilterGroupProps {
  title: string;
  activeCount?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}

export function FilterGroup({
  title,
  activeCount = 0,
  children,
  defaultOpen = false,
}: FilterGroupProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="border-b">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium hover:bg-muted/50"
      >
        <div className="flex items-center gap-2">
          {isOpen ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
          <span>{title}</span>
        </div>
        {activeCount > 0 && (
          <Badge variant="secondary" className="h-5 min-w-5 px-1.5 text-xs">
            {activeCount}
          </Badge>
        )}
      </button>
      {isOpen && <div className="px-3 pb-3 space-y-2">{children}</div>}
    </div>
  );
}
