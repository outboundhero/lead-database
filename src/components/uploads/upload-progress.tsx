"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import type { UploadBatch } from "@/types/database";

interface UploadProgressProps {
  batchId: string;
  onDone: () => void;
}

export function UploadProgress({ batchId, onDone }: UploadProgressProps) {
  const [batch, setBatch] = useState<UploadBatch | null>(null);

  useEffect(() => {
    const supabase = createClient();
    let interval: ReturnType<typeof setInterval>;

    async function poll() {
      const { data } = await supabase
        .from("upload_batches")
        .select("*")
        .eq("id", batchId)
        .single();
      if (data) {
        setBatch(data as UploadBatch);
        if (data.status === "complete" || data.status === "error") {
          clearInterval(interval);
        }
      }
    }

    poll();
    interval = setInterval(poll, 2000);
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

  return (
    <div className="space-y-4">
      {/* Progress bar */}
      <div>
        <div className="flex justify-between text-xs mb-1">
          <span>
            {isComplete ? "Upload complete" : isError ? "Upload failed" : "Processing..."}
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-300 ${
              isError ? "bg-destructive" : isComplete ? "bg-green-500" : "bg-primary"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border p-2">
          <span className="text-muted-foreground">Processed</span>
          <p className="font-medium">{processed.toLocaleString()} / {total.toLocaleString()}</p>
        </div>
        <div className="rounded border p-2">
          <span className="text-muted-foreground">Skipped</span>
          <p className="font-medium">{batch.skipped_rows.toLocaleString()}</p>
        </div>
        <div className="rounded border p-2">
          <span className="text-muted-foreground">Merged</span>
          <p className="font-medium">{batch.merged_rows.toLocaleString()}</p>
        </div>
        <div className="rounded border p-2">
          <span className="text-muted-foreground">Replaced</span>
          <p className="font-medium">{batch.replaced_rows.toLocaleString()}</p>
        </div>
      </div>

      {/* Status icon */}
      <div className="flex items-center gap-2">
        {isComplete && (
          <>
            <CheckCircle2 className="h-5 w-5 text-green-500" />
            <span className="text-sm text-green-600">Upload completed successfully</span>
          </>
        )}
        {isError && (
          <>
            <AlertCircle className="h-5 w-5 text-destructive" />
            <span className="text-sm text-destructive">Upload encountered errors</span>
          </>
        )}
        {!isComplete && !isError && (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {(isComplete || isError) && (
        <Button onClick={onDone}>Upload Another</Button>
      )}
    </div>
  );
}
