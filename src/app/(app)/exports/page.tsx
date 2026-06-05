"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { ExportJob } from "@/types/database";
import { useHasPermission } from "@/lib/context/role-context";
import { AccessDenied } from "@/components/layout/access-denied";

function formatFilterSummary(filtersUsed: Record<string, unknown> | null): string {
  if (!filtersUsed) return "—";
  const parts: string[] = [];
  if (filtersUsed.fullName) parts.push(`Name: "${filtersUsed.fullName}"`);
  if (filtersUsed.companyName) parts.push(`Company: "${filtersUsed.companyName}"`);
  if (filtersUsed.keyword) parts.push(`Keyword: "${filtersUsed.keyword}"`);
  const source = filtersUsed.source as { include?: string[] } | undefined;
  if (source?.include?.length) parts.push(`Source: ${source.include.join(", ")}`);
  const seniority = filtersUsed.seniority as { include?: string[] } | undefined;
  if (seniority?.include?.length) parts.push(`Seniority: ${seniority.include.join(", ")}`);
  const industry = filtersUsed.generalIndustry as { include?: string[] } | undefined;
  if (industry?.include?.length) parts.push(`Industry: ${industry.include.join(", ")}`);
  const location = filtersUsed.location as { city?: string; country?: { include?: string[] } } | undefined;
  if (location?.city) parts.push(`City: ${location.city}`);
  if (location?.country?.include?.length) parts.push(`Country: ${location.country.include.join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "All leads";
}

export default function ExportsPage() {
  const canView = useHasPermission("manager");
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [loading, setLoading] = useState(true);

  const loadExports = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const { data } = await supabase
      .from("export_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);
    if (data) setExports(data as ExportJob[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    loadExports();
    // Auto-refresh every 5s while any job is processing
    const interval = setInterval(() => {
      setExports((prev) => {
        const hasProcessing = prev.some((j) => j.status === "processing");
        if (hasProcessing) loadExports();
        return prev;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [loadExports]);

  async function handleCancel(job: ExportJob) {
    const supabase = createClient();
    const { error } = await supabase
      .from("export_jobs")
      .update({ status: "cancelled" })
      .eq("id", job.id);
    if (error) {
      toast.error("Failed to cancel export");
    } else {
      toast.success("Export cancelled");
      loadExports();
    }
  }

  async function handleRedownload(job: ExportJob) {
    if (!job.filters_used || !job.column_selection) return;
    const { _meta, ...filters } = job.filters_used as Record<string, unknown>;
    const meta = (_meta ?? {}) as { rangeFrom?: number | null; rangeTo?: number | null; limit?: number | null };
    const toastId = toast.loading("Starting re-export...");
    try {
      // Re-export used to bypass /api/exports/log entirely, which meant it
      // skipped the queue cap and could pile on top of running exports.
      // Now route through log first (with the same 429-retry-as-Queued-toast
      // pattern as the main Export button), then call stream with the new
      // jobId so the queue limit and live status updates apply.
      let logRes: Response | null = null;
      const MAX_QUEUE_WAIT_MS = 10 * 60 * 1000;
      const QUEUE_POLL_MS = 10000;
      const queueStart = Date.now();
      while (Date.now() - queueStart < MAX_QUEUE_WAIT_MS) {
        logRes = await fetch("/api/exports/log", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filters,
            columnSelection: job.column_selection,
            rangeFrom: meta.rangeFrom ?? undefined,
            rangeTo: meta.rangeTo ?? undefined,
            limit: meta.limit ?? undefined,
            action: "start",
          }),
        });
        if (logRes.ok) break;
        if (logRes.status !== 429) break;
        const waited = Math.round((Date.now() - queueStart) / 1000);
        toast.loading(`Queued — waiting for an open slot (${waited}s)...`, { id: toastId });
        await new Promise((r) => setTimeout(r, QUEUE_POLL_MS));
      }
      if (!logRes || !logRes.ok) {
        toast.dismiss(toastId);
        toast.error(
          logRes?.status === 429
            ? "Queue still full after 10 minutes. Please try again later."
            : "Re-export failed to start"
        );
        return;
      }
      const { jobId: exportJobId } = await logRes.json();

      const res = await fetch("/api/exports/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filters,
          columnSelection: job.column_selection,
          rangeFrom: meta.rangeFrom ?? undefined,
          rangeTo: meta.rangeTo ?? undefined,
          limit: meta.limit ?? undefined,
          jobId: exportJobId,
        }),
      });
      if (!res.ok) {
        toast.dismiss(toastId);
        toast.error("Re-export failed");
        return;
      }
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          totalBytes += value.length;
        }
      }
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
      toast.success(`Download complete! (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`, { id: toastId });
    } catch {
      toast.dismiss(toastId);
      toast.error("Re-export failed");
    }
  }

  async function handleDownload(job: ExportJob) {
    if (!job.file_path) return;
    try {
      const res = await fetch(
        `/api/exports/download?file=${encodeURIComponent(job.file_path)}`
      );
      const data = await res.json();
      if (!res.ok || !data.url) {
        toast.error(data.error ?? "Failed to generate download link");
        return;
      }
      window.open(data.url, "_blank");
    } catch {
      toast.error("Failed to generate download link");
    }
  }

  if (!canView) return <AccessDenied />;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Exports</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Recent exports from your filter views
          </p>
        </div>
        <Button variant="tinted" size="sm" onClick={loadExports} disabled={loading}>
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} strokeWidth={2} />
          Refresh
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-[17px]">Export history</CardTitle>
        </CardHeader>
        <CardContent>
          {exports.length === 0 && !loading ? (
            <p className="py-8 text-center text-[14px] text-muted-foreground">
              No exports yet. Use the Export button on the Leads page to create one.
            </p>
          ) : (
            <div className="-mx-6 -mb-6 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Filters</TableHead>
                    <TableHead>Rows</TableHead>
                    <TableHead>Cols</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exports.map((job) => {
                    const meta = job.filters_used?._meta as
                      | { exported_by?: string; export_type?: string }
                      | undefined;
                    const exportType = meta?.export_type ?? "filtered";
                    const exportedBy = meta?.exported_by ?? "—";
                    const filterSummary =
                      exportType === "selected"
                        ? `${job.selected_ids?.length ?? 0} selected IDs`
                        : formatFilterSummary(job.filters_used);

                    return (
                      <TableRow key={job.id}>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {new Date(job.created_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="max-w-[140px] truncate">
                          {exportedBy}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="capitalize">
                            {exportType}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-[240px] truncate text-muted-foreground">
                          {filterSummary}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {job.row_count?.toLocaleString() ?? "—"}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {job.column_selection?.length ?? "—"}
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">
                          {(job as ExportJob & { duration_seconds?: number }).duration_seconds
                            ? `${Math.floor((job as ExportJob & { duration_seconds?: number }).duration_seconds! / 60)}m ${(job as ExportJob & { duration_seconds?: number }).duration_seconds! % 60}s`
                            : job.status === "processing"
                            ? `${Math.round((Date.now() - new Date(job.created_at).getTime()) / 1000)}s…`
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              job.status === "complete"
                                ? "success"
                                : job.status === "error" || (job.status as string) === "cancelled"
                                ? "destructive"
                                : "warning"
                            }
                          >
                            {job.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="flex gap-1">
                          {job.status === "processing" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:bg-destructive/10"
                              onClick={() => handleCancel(job)}
                            >
                              Cancel
                            </Button>
                          )}
                          {job.status === "complete" && job.file_path && (
                            <Button
                              variant="tinted"
                              size="sm"
                              onClick={() => handleDownload(job)}
                            >
                              <Download className="size-3.5" strokeWidth={2} />
                              Download
                            </Button>
                          )}
                          {job.status === "complete" && !job.file_path && job.filters_used && (
                            <Button
                              variant="tinted"
                              size="sm"
                              onClick={() => handleRedownload(job)}
                            >
                              <Download className="size-3.5" strokeWidth={2} />
                              Re-export
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
