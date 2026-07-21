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
import { ColumnSelector, type BisonCampaign, type ExportDestination } from "./column-selector";
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

  async function handleExport(
    columns: string[],
    limit: number | null,
    rangeFrom: number | undefined,
    rangeTo: number | undefined,
    destination: ExportDestination = "csv",
    campaigns: BisonCampaign[] = [],
  ) {
    setSelectorOpen(false);
    setExporting(true);

    const isSelected = exportType === "selected" && selectedIds.length > 0;

    // ── Queue a background push into one or more Bison campaigns ──
    // The push-worker gathers the leads and creates/attaches them per instance;
    // progress lives in the "Bison pushes" panel on the Exports page.
    if (destination === "bison" && campaigns.length > 0) {
      const campaignLabel = campaigns.length === 1
        ? campaigns[0].name ?? `Campaign ${campaigns[0].id}`
        : `${campaigns.length} campaigns`;
      const toastId = toast.loading(`Queuing push to ${campaignLabel}…`);
      // A selected-rows push never sends the range fields (the route 400s on
      // selectedIds+range rather than guessing intent). On the filters path a
      // lone "To" acts as a max-leads cap server-side.
      try {
        const res = await fetch("/api/bison/push-batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            campaigns: campaigns.map((c) => ({
              id: c.id,
              name: c.name,
              instance_url: c.instance_url,
              workspace_name: c.workspace_name,
            })),
            selectedIds: isSelected ? selectedIds : undefined,
            filters: isSelected ? undefined : filters,
            // Both bounds -> a range; a lone "To" -> a max-leads cap. Never
            // send a lone bound as a range key — the route rejects that pair.
            ...(!isSelected && rangeFrom && rangeTo
              ? { rangeFrom, rangeTo }
              : !isSelected && rangeTo
              ? { maxLeads: rangeTo }
              : {}),
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Failed to queue push");
        const leadsLabel = isSelected
          ? `${selectedIds.length.toLocaleString()} selected leads`
          : rangeFrom && rangeTo
          ? `leads ${rangeFrom.toLocaleString()}–${rangeTo.toLocaleString()}`
          : rangeTo
          ? `up to ${rangeTo.toLocaleString()} leads`
          : `${totalCount.toLocaleString()} filtered leads`;
        toast.success(
          `Queued push of ${leadsLabel} to ${campaignLabel} — progress on the Exports page`,
          { id: toastId }
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to queue push", { id: toastId });
      } finally {
        setExporting(false);
      }
      return;
    }

    // Both Selected and Filtered exports stream directly to the browser — the
    // old background/storage job for Selected never reliably completed.
    // toastId lives outside the try so the catch can replace the loading toast.
    const toastId = toast.loading("Preparing export...");
    try {
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
          body: JSON.stringify({ filters, columnSelection: columns, limit, rangeFrom, rangeTo, selectedIds: isSelected ? selectedIds : undefined, action: "start" }),
        });
        if (logRes.ok) break;
        if (logRes.status !== 429) break;
        const waited = Math.round((Date.now() - queueStart) / 1000);
        toast.loading(`Queued — waiting for an open slot (${waited}s)...`, { id: toastId });
        await new Promise((r) => setTimeout(r, QUEUE_POLL_MS));
      }
      if (!logRes || !logRes.ok) {
        const msg = logRes?.status === 429
          ? "Queue still full after 10 minutes. Please try again later."
          : "Export failed to start";
        throw new Error(msg);
      }
      const { jobId: exportJobId } = await logRes.json();

      const res = await fetch("/api/exports/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filters, columnSelection: columns, limit, rangeFrom, rangeTo, jobId: exportJobId, selectedIds: isSelected ? selectedIds : undefined }),
      });

      if (!res.ok) {
        const text = await res.text();
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed", { id: toastId });
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
