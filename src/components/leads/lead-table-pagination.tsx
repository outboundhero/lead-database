"use client";

import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface LeadTablePaginationProps {
  page: number;
  pageSize: number;
  totalCount: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function LeadTablePagination({
  page,
  pageSize,
  totalCount,
  onPageChange,
  onPageSizeChange,
}: LeadTablePaginationProps) {
  const totalPages = Math.ceil(totalCount / pageSize);
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);

  return (
    <div className="ios-frost flex items-center justify-between border-t border-border/40 px-4 py-3">
      <div className="text-[13px] text-muted-foreground">
        {totalCount === 0
          ? "No results"
          : `${from.toLocaleString()}–${to.toLocaleString()} of ${totalCount.toLocaleString()}`}
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-muted-foreground">Rows</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
          >
            <SelectTrigger className="h-8 w-[72px] text-[13px]" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[25, 50, 100].map((size) => (
                <SelectItem key={size} value={String(size)} className="text-[13px]">
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onPageChange(1)}
            disabled={page <= 1}
          >
            <ChevronsLeft className="size-4" strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
          >
            <ChevronLeft className="size-4" strokeWidth={2} />
          </Button>
          <span className="px-2 text-[13px] font-medium tabular-nums">
            {page} / {totalPages || 1}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
          >
            <ChevronRight className="size-4" strokeWidth={2} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onPageChange(totalPages)}
            disabled={page >= totalPages}
          >
            <ChevronsRight className="size-4" strokeWidth={2} />
          </Button>
        </div>
      </div>
    </div>
  );
}
