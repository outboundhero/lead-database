"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Database, Loader2, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

interface BackupResult {
  fileName: string;
  totalLeads: number;
  sizeBytes: number;
}

export function BackupSection() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BackupResult | null>(null);

  async function handleBackup() {
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch("/api/backups/trigger", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setResult(data);
      toast.success("Backup completed successfully");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setLoading(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Database className="h-4 w-4" />
          Database Backup
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Generate a full CSV backup of all leads and upload to Supabase Storage.
          Automatic backups run monthly via pg_cron.
        </p>

        <Button onClick={handleBackup} disabled={loading} size="sm">
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
              Generating backup...
            </>
          ) : (
            "Trigger Manual Backup"
          )}
        </Button>

        {result && (
          <div className="flex items-start gap-2 rounded border p-3">
            <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
            <div className="text-xs space-y-0.5">
              <p className="font-medium">{result.fileName}</p>
              <p className="text-muted-foreground">
                {result.totalLeads.toLocaleString()} leads — {formatBytes(result.sizeBytes)}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
