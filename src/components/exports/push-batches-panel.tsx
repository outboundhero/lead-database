"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface PushBatchCampaign {
  id: number | string;
  name?: string;
  instance_url?: string;
  workspace_name?: string;
}

interface PushBatch {
  id: string;
  campaigns: PushBatchCampaign[];
  total: number | null;
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  status: string;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  client_tag?: string | null;
  email_side?: string | null;
}

interface CampaignTotals {
  totals: { id: number | string; name: string; bucket: string | null; leads: number }[];
  skippedNoBucketCampaign: number;
}

const ACTIVE_STATUSES = new Set(["pending", "gathering", "processing"]);

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Queued Bison pushes — polls while any batch is still active. */
export function PushBatchesPanel() {
  const [batches, setBatches] = useState<PushBatch[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [totalsFor, setTotalsFor] = useState<string | null>(null);
  const [totals, setTotals] = useState<CampaignTotals | null>(null);

  const loadBatches = useCallback(async () => {
    try {
      const res = await fetch("/api/bison/push-batches?limit=20");
      if (!res.ok) { setFetchFailed(true); return; }
      const data = await res.json();
      if (Array.isArray(data.batches)) setBatches(data.batches);
      setFetchFailed(false);
    } catch {
      // Keep a slow retry alive — a failed FIRST fetch must not hide an
      // in-flight batch's progress until remount.
      setFetchFailed(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  // Poll every 4s while a batch is still pending/gathering/processing, and
  // every 10s after a failed fetch (auto-recovery); cleared once settled.
  const hasActive = batches.some((b) => ACTIVE_STATUSES.has(b.status));
  useEffect(() => {
    if (!hasActive && !fetchFailed) return;
    const interval = setInterval(loadBatches, fetchFailed ? 10000 : 4000);
    return () => clearInterval(interval);
  }, [hasActive, fetchFailed, loadBatches]);

  async function handleCancel(batchId: string) {
    setCancellingId(batchId);
    try {
      const res = await fetch("/api/bison/push-batches/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? "Failed to cancel push");
      } else {
        toast.success("Push cancelled");
      }
      loadBatches();
    } catch {
      toast.error("Failed to cancel push");
    } finally {
      setCancellingId(null);
    }
  }

  async function handleRetry(batchId: string) {
    setRetryingId(batchId);
    try {
      const res = await fetch("/api/bison/push-batches/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(data.error ?? "Failed to retry");
      else toast.success(`${data.requeued.toLocaleString()} failed contacts requeued`);
      loadBatches();
    } catch {
      toast.error("Failed to retry");
    } finally {
      setRetryingId(null);
    }
  }

  async function toggleTotals(batchId: string) {
    if (totalsFor === batchId) { setTotalsFor(null); setTotals(null); return; }
    setTotalsFor(batchId);
    setTotals(null);
    try {
      const res = await fetch(`/api/bison/push-batches/campaign-totals?batchId=${batchId}`);
      if (res.ok) setTotals(await res.json());
    } catch { /* leave loading state */ }
  }

  // No card at all until the first fetch resolves — and none for users who
  // have never queued a push.
  if (!loaded || batches.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-[17px]">Bison pushes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {batches.map((batch) => {
          const campaignNames = (batch.campaigns ?? [])
            .map((c) => c.name ?? `Campaign ${c.id}`)
            .join(", ");
          const total = batch.total ?? 0;
          const pct = total > 0 ? Math.min(100, Math.round((batch.processed / total) * 100)) : 0;
          const active = ACTIVE_STATUSES.has(batch.status);
          return (
            <div key={batch.id} className="rounded-xl border p-3">
              <div className="flex items-center gap-2">
                {batch.client_tag && (
                  <Badge variant="secondary" className="shrink-0">
                    {batch.client_tag}
                    {batch.email_side ? ` · ${batch.email_side}` : ""}
                  </Badge>
                )}
                <p className="min-w-0 flex-1 truncate text-[13px] font-medium" title={campaignNames}>
                  {campaignNames || "—"}
                </p>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {relativeTime(batch.created_at)}
                </span>
                <Badge
                  variant={
                    batch.status === "complete"
                      ? "success"
                      : batch.status === "error" || batch.status === "cancelled"
                      ? "destructive"
                      : "warning"
                  }
                >
                  {batch.status}
                </Badge>
                {active && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10"
                    disabled={cancellingId === batch.id}
                    onClick={() => handleCancel(batch.id)}
                  >
                    Cancel
                  </Button>
                )}
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] tabular-nums text-muted-foreground">
                <span>
                  {batch.processed.toLocaleString()}/
                  {batch.total != null ? batch.total.toLocaleString() : "…"} processed
                </span>
                <span>{batch.sent.toLocaleString()} sent</span>
                <span>{batch.failed.toLocaleString()} failed</span>
                <span>{batch.skipped.toLocaleString()} skipped</span>
                <button
                  type="button"
                  onClick={() => toggleTotals(batch.id)}
                  className="font-medium text-primary hover:underline"
                >
                  {totalsFor === batch.id ? "Hide totals" : "Routing totals"}
                </button>
                {!active && batch.failed > 0 && (
                  <button
                    type="button"
                    disabled={retryingId === batch.id}
                    onClick={() => handleRetry(batch.id)}
                    className="font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    {retryingId === batch.id ? "Retrying…" : `Retry ${batch.failed.toLocaleString()} failed`}
                  </button>
                )}
              </div>
              {totalsFor === batch.id && (
                <div className="mt-1.5 rounded-lg bg-muted/50 p-2">
                  {totals ? (
                    <>
                      {totals.totals.map((t) => (
                        <p key={String(t.id)} className="text-[11px] tabular-nums">
                          <span className="font-medium">{t.leads.toLocaleString()}</span> →{" "}
                          {t.name}
                          {t.bucket ? (
                            <span className="text-muted-foreground"> ({t.bucket === "default" ? "google + custom" : t.bucket})</span>
                          ) : null}
                        </p>
                      ))}
                      {totals.skippedNoBucketCampaign > 0 && (
                        <p className="text-[11px] text-muted-foreground">
                          {totals.skippedNoBucketCampaign.toLocaleString()} skipped — no campaign for their bucket
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">Loading totals…</p>
                  )}
                </div>
              )}
              {batch.error && (
                <p className="mt-1 text-[12px] text-destructive">{batch.error}</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
