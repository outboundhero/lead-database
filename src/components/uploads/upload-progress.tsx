"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertCircle, Loader2, Download } from "lucide-react";
import type { UploadBatch } from "@/types/database";
import { HOLDBACK_PART_SIZE } from "@/lib/uploads/constants";

interface UploadProgressProps {
  batchId: string;
  /** Shown as "Upload Another" once the batch is final; omit while more files are queued. */
  onDone?: () => void;
}

/** Download links for an upload's no-email rows, one per part (<50k rows each). */
export function HoldbackLinks({ batch, compact = false }: { batch: Pick<UploadBatch, "id" | "no_email_rows">; compact?: boolean }) {
  const n = batch.no_email_rows ?? 0;
  if (n <= 0) return null;
  const parts = Math.ceil(n / HOLDBACK_PART_SIZE);
  return (
    <span className={`inline-flex flex-wrap items-center gap-1 ${compact ? "" : "mt-1"}`}>
      {Array.from({ length: parts }, (_, p) => (
        <a
          key={p}
          href={`/api/uploads/holdbacks?batch=${batch.id}&part=${p}`}
          className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] hover:bg-muted"
          title={parts > 1 ? `Rows ${(p * HOLDBACK_PART_SIZE + 1).toLocaleString()}–${Math.min((p + 1) * HOLDBACK_PART_SIZE, n).toLocaleString()} of the no-email rows` : "All rows that had no email, exactly as uploaded"}
        >
          <Download className="h-3 w-3" />
          {parts > 1 ? `Part ${p + 1}/${parts}` : "No-email rows"}
        </a>
      ))}
    </span>
  );
}

export function UploadProgress({ batchId, onDone }: UploadProgressProps) {
  const [batch, setBatch] = useState<UploadBatch | null>(null);

  useEffect(() => {
    const supabase = createClient();
    async function poll() {
      const { data } = await supabase.from("upload_batches").select("*").eq("id", batchId).single();
      if (data) {
        setBatch(data as UploadBatch);
        if (data.status === "complete" || data.status === "error") clearInterval(interval);
      }
    }
    const interval = setInterval(poll, 2000);
    poll();
    return () => clearInterval(interval);
  }, [batchId]);

  if (!batch) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Starting upload...
      </div>
    );
  }

  const total = batch.total_rows ?? 0;
  const processed = batch.processed_rows;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
  const isComplete = batch.status === "complete";
  const isError = batch.status === "error";
  const errorLines = Array.isArray(batch.error_log) ? (batch.error_log as string[]) : [];

  const tile = (label: string, value: number | null | undefined, hint?: string) => (
    <div className="rounded border p-2" title={hint}>
      <span className="text-muted-foreground">{label}</span>
      <p className="font-medium tabular-nums">{(value ?? 0).toLocaleString()}</p>
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span>{isComplete ? "Upload complete" : isError ? "Upload failed" : "Processing..."}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${isError ? "bg-destructive" : isComplete ? "bg-green-500" : "bg-primary"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {tile("Processed", processed, `${processed.toLocaleString()} of ${total.toLocaleString()} rows`)}
        {tile("New leads", batch.inserted_rows, "Emails that did not exist yet")}
        {tile("Merged", batch.merged_rows, "Existing leads: blank fields filled in")}
        {tile("Replaced", batch.replaced_rows, "Existing leads: chosen fields overwritten")}
        {tile("Locations added", batch.locations_added, "Same person, different city/state — added as an extra location")}
        {tile("No email", batch.no_email_rows, "Empty or unusable email (e.g. 'N/A'); kept verbatim — download below")}
        {tile("Duplicate rows in file", batch.in_file_duplicates, "Same email appearing more than once in this file")}
        {tile("ESP detected", batch.esp_detected, "Mail provider found via MX lookup and stored")}
        {tile("Skipped", batch.skipped_rows, "Existing leads left untouched, no extra location added (Skip strategy)")}
        {tile("Errors", batch.error_rows, "Rows that failed to import")}
      </div>

      {batch.no_email_rows > 0 && (
        <div className="rounded-md border border-dashed p-3 text-xs">
          <p className="mb-1">
            <span className="font-medium">{batch.no_email_rows.toLocaleString()} rows had no usable email</span> and were not imported.
            They are kept exactly as uploaded — download, run your email waterfall, and re-upload.
          </p>
          <HoldbackLinks batch={batch} />
        </div>
      )}

      {errorLines.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
          <p className="mb-1 font-medium text-destructive">Errors</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {errorLines.slice(0, 5).map((e, i) => <li key={i} className="break-all">{e}</li>)}
            {errorLines.length > 5 && <li>… {errorLines.length - 5} more</li>}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2">
        {isComplete && (<><CheckCircle2 className="h-5 w-5 text-green-500" /><span className="text-sm text-green-600">Upload completed</span></>)}
        {isError && (<><AlertCircle className="h-5 w-5 text-destructive" /><span className="text-sm text-destructive">Upload failed</span></>)}
        {!isComplete && !isError && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {(isComplete || isError) && onDone && <Button onClick={onDone}>Upload Another</Button>}
    </div>
  );
}
