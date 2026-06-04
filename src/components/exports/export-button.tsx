"use client";

import { useState } from "react";
import { Download, Loader2, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ColumnSelector } from "./column-selector";
import { toast } from "sonner";
import type { FilterState } from "@/types/filters";

interface ExportButtonProps {
  filters: FilterState;
  totalCount: number;
  selectedIds?: string[];
}

export function ExportButton({ filters, totalCount, selectedIds = [] }: ExportButtonProps) {
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [exportType, setExportType] = useState<"filtered" | "selected">("filtered");
  const [exporting, setExporting] = useState(false);

  function openSelector(type: "filtered" | "selected") {
    setExportType(type);
    setSelectorOpen(true);
  }

  async function handleExport(columns: string[], limit: number | null, rangeFrom?: number, rangeTo?: number) {
    setSelectorOpen(false);
    setExporting(true);

    try {
      if (exportType === "selected" && selectedIds.length > 0) {
        // Use background job for selected IDs (needs ID-based query)
        const res = await fetch("/api/exports/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filters, columnSelection: columns, selectedIds, limit, rangeFrom, rangeTo }),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error ?? "Export failed");
        }
        toast.success("Export started. Check the Exports page for your download.");
      } else {
        // Stream download directly — fast, no storage needed
        const toastId = toast.loading("Preparing export...");

        // Log export start and get jobId. If the server is at capacity (429),
        // retry every 10s while showing "Queued..." so the user just waits
        // instead of seeing a hard error. Cap at ~10 min total so we don't
        // retry forever on a stuck queue.
        let logRes: Response | null = null;
        const MAX_QUEUE_WAIT_MS = 10 * 60 * 1000;
        const QUEUE_POLL_MS = 10000;
        const queueStart = Date.now();
        while (Date.now() - queueStart < MAX_QUEUE_WAIT_MS) {
          logRes = await fetch("/api/exports/log", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filters, columnSelection: columns, limit, rangeFrom, rangeTo, action: "start" }),
          });
          if (logRes.ok) break;
          if (logRes.status !== 429) break;
          const waited = Math.round((Date.now() - queueStart) / 1000);
          toast.loading(`Queued — waiting for an open slot (${waited}s)...`, { id: toastId });
          await new Promise((r) => setTimeout(r, QUEUE_POLL_MS));
        }
        if (!logRes || !logRes.ok) {
          toast.dismiss(toastId);
          const msg = logRes?.status === 429
            ? "Queue still full after 10 minutes. Please try again later."
            : "Export failed to start";
          throw new Error(msg);
        }
        const { jobId: exportJobId } = await logRes.json();

        const res = await fetch("/api/exports/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filters, columnSelection: columns, limit, rangeFrom, rangeTo, jobId: exportJobId }),
        });

        if (!res.ok) {
          const text = await res.text();
          toast.dismiss(toastId);
          throw new Error(text || "Export failed");
        }

        // Stream and track progress
        const reader = res.body?.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            totalBytes += value.length;
            const mb = (totalBytes / 1024 / 1024).toFixed(1);
            toast.loading(`Downloading... ${mb} MB`, { id: toastId });
          }
        }

        // Combine chunks and trigger download
        const blob = new Blob(chunks as BlobPart[], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");
        a.download = `export_${timestamp}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Server logs the accurate row count — no client-side counting needed
        toast.success(`Download complete! (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`, { id: toastId });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const hasSelection = selectedIds.length > 0;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={exporting || totalCount === 0}
          >
            {exporting ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Download className="h-4 w-4 mr-1" />
            )}
            Export
            {hasSelection && (
              <span className="ml-1 text-xs opacity-70">· {selectedIds.length} selected</span>
            )}
            <ChevronDown className="h-3 w-3 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {hasSelection && (
            <>
              <DropdownMenuItem onClick={() => openSelector("selected")}>
                Export Selected ({selectedIds.length.toLocaleString()} leads)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            onClick={() => openSelector("filtered")}
            disabled={totalCount === 0}
          >
            Export Filtered ({totalCount.toLocaleString()} leads)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ColumnSelector
        open={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        onConfirm={handleExport}
        totalCount={exportType === "selected" ? selectedIds.length : totalCount}
        exportType={exportType}
      />
    </>
  );
}
