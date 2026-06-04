"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, HelpCircle } from "lucide-react";

interface StatRow {
  field: string;
  unknown_count: number;
  pct: number;
}

interface StatsData {
  total_leads: number;
  fields_tracked: number;
  generated_at: string;
  stats: StatRow[];
}

interface UnknownStatsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function UnknownStatsDialog({ open, onClose }: UnknownStatsDialogProps) {
  const [data, setData] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadStats() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/unknown-stats");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stats");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && !loading) {
      setData(null);
      loadStats();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="h-5 w-5" />
            Unknown Lead Stats
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            Counts for unknown (null or empty) values by field
          </p>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {error && (
          <div className="text-sm text-destructive text-center py-8">{error}</div>
        )}

        {data && (
          <div className="space-y-4">
            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border p-3">
                <p className="text-[10px] text-muted-foreground">Total Leads</p>
                <p className="text-lg font-bold">{data.total_leads.toLocaleString()}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-[10px] text-muted-foreground">Fields Tracked</p>
                <p className="text-lg font-bold">{data.fields_tracked}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-[10px] text-muted-foreground">Generated At</p>
                <p className="text-xs font-medium mt-1">
                  {new Date(data.generated_at).toLocaleString()}
                </p>
              </div>
            </div>

            {/* Stats table */}
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left px-3 py-2 text-xs font-medium">Field</th>
                    <th className="text-right px-3 py-2 text-xs font-medium">Unknown Leads</th>
                    <th className="text-right px-3 py-2 text-xs font-medium">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stats.map((row) => (
                    <tr key={row.field} className="border-b last:border-0">
                      <td className="px-3 py-2 text-xs">{row.field}</td>
                      <td className="px-3 py-2 text-xs text-right font-medium">
                        {row.unknown_count.toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-xs text-right">
                        <span
                          className={`${
                            row.pct > 50
                              ? "text-red-500"
                              : row.pct > 25
                              ? "text-amber-500"
                              : "text-green-500"
                          }`}
                        >
                          {row.pct}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[10px] text-muted-foreground">
              Unknown = null or empty string. Technologies also counts empty arrays.
            </p>

            <div className="flex justify-end">
              <Button variant="outline" size="sm" onClick={loadStats} disabled={loading}>
                {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Refresh
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
