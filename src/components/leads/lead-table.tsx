"use client";

import React from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
  type Updater,
} from "@tanstack/react-table";
import {
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { leadColumns } from "./lead-columns";
import { LeadTablePagination } from "./lead-table-pagination";
import type { Lead } from "@/types/database";

const checkboxColumn: ColumnDef<Lead> = {
  id: "select",
  header: ({ table }) => (
    <Checkbox
      checked={table.getIsAllPageRowsSelected()}
      onCheckedChange={(v: boolean | "indeterminate") => table.toggleAllPageRowsSelected(!!v)}
      aria-label="Select all"
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    />
  ),
  cell: ({ row }) => (
    <Checkbox
      checked={row.getIsSelected()}
      onCheckedChange={(v: boolean | "indeterminate") => row.toggleSelected(!!v)}
      aria-label="Select row"
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    />
  ),
  size: 40,
};

interface LeadTableProps {
  data: Lead[];
  totalCount: number;
  page: number;
  pageSize: number;
  isLoading: boolean;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onRowClick: (lead: Lead) => void;
  rowSelection: RowSelectionState;
  onRowSelectionChange: (selection: RowSelectionState) => void;
}

export function LeadTable({
  data,
  totalCount,
  page,
  pageSize,
  isLoading,
  onPageChange,
  onPageSizeChange,
  onRowClick,
  rowSelection,
  onRowSelectionChange,
}: LeadTableProps) {
  const allColumns = [checkboxColumn, ...leadColumns];
  const [sorting, setSorting] = React.useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns: allColumns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    enableRowSelection: true,
    getRowId: (row) => row.id,
    state: { rowSelection, sorting },
    onSortingChange: setSorting,
    onRowSelectionChange: (updater: Updater<RowSelectionState>) => {
      const next = typeof updater === "function" ? updater(rowSelection) : updater;
      onRowSelectionChange(next);
    },
    manualPagination: true,
    rowCount: totalCount,
  });

  const rows = table.getRowModel().rows;
  const rowIds = React.useMemo(() => rows.map((r) => r.id), [rows]);

  // Drag-to-select + shift-click range selection over the visible page rows.
  // - drag: mousedown a row, move over others → selects the contiguous range
  //   (selecting or deselecting based on the anchor row's initial state).
  // - shift+mousedown: selects the range between the last anchor and this row.
  // The per-row checkbox still toggles a single row on its own (it stops
  // propagation), and a plain click (no drag) opens the detail panel.
  const anchorRef = React.useRef<number | null>(null);
  const dragRef = React.useRef<{ start: number; selecting: boolean; moved: boolean } | null>(null);
  // When a drag or shift-select happens we must swallow the click that follows
  // so it doesn't also open the detail panel.
  const suppressClickRef = React.useRef(false);

  const applyRange = React.useCallback(
    (from: number, to: number, value: boolean) => {
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      const next: RowSelectionState = { ...rowSelection };
      for (let i = lo; i <= hi; i++) {
        const id = rowIds[i];
        if (id === undefined) continue;
        if (value) next[id] = true;
        else delete next[id];
      }
      onRowSelectionChange(next);
    },
    [rowSelection, rowIds, onRowSelectionChange]
  );

  React.useEffect(() => {
    function onUp() {
      if (dragRef.current?.moved) {
        suppressClickRef.current = true;
        // A same-target release fires its click synchronously (consuming the
        // flag); a cross-row drag produces NO click, so clear on the next tick
        // to avoid swallowing the user's next genuine click.
        setTimeout(() => { suppressClickRef.current = false; }, 0);
      }
      dragRef.current = null;
    }
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, []);

  function handleRowMouseDown(e: React.MouseEvent, index: number, isSelected: boolean) {
    if (e.button !== 0) return; // left button only
    if (e.shiftKey) {
      e.preventDefault(); // avoid native text selection
      const anchor = anchorRef.current ?? index;
      applyRange(anchor, index, true);
      anchorRef.current = index;
      suppressClickRef.current = true;
      return;
    }
    dragRef.current = { start: index, selecting: !isSelected, moved: false };
    anchorRef.current = index;
  }

  function handleRowMouseEnter(index: number) {
    const drag = dragRef.current;
    if (!drag) return;
    drag.moved = true;
    applyRange(drag.start, index, drag.selecting);
  }

  function handleRowClick(e: React.MouseEvent, lead: Lead) {
    // A drag or shift-select already consumed this interaction.
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (e.shiftKey) return;
    onRowClick(lead);
  }

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1 overflow-auto">
        <table className="w-full caption-bottom text-[14px]">
          <thead className="sticky top-0 z-20 bg-background shadow-[0_1px_0_0_var(--border)] [&_tr]:border-b [&_tr]:border-border/40">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="h-11 px-4 text-left align-middle text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap text-muted-foreground"
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <TableRow key={i}>
                  {allColumns.map((_, j) => (
                    <TableCell key={j} className="px-4 py-3">
                      <Skeleton className="h-4 w-full rounded-md" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={allColumns.length}
                  className="h-32 text-center text-[14px] text-muted-foreground"
                >
                  No leads found.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row, index) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? "selected" : undefined}
                  className="cursor-pointer select-none"
                  onMouseDown={(e) => handleRowMouseDown(e, index, row.getIsSelected())}
                  onMouseEnter={() => handleRowMouseEnter(index)}
                  onClick={(e) => handleRowClick(e, row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="px-4 py-3">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext()
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </table>
      </div>
      <LeadTablePagination
        page={page}
        pageSize={pageSize}
        totalCount={totalCount}
        onPageChange={onPageChange}
        onPageSizeChange={onPageSizeChange}
      />
    </div>
  );
}
