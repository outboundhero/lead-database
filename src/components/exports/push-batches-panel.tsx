"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { X, RotateCcw } from "lucide-react";
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

interface ErrorGroup {
  reason: string;
  count: number;
  samples: string[];
}
interface BatchErrors {
  failed: ErrorGroup[];
  skipped: ErrorGroup[];
  retryableCount: number;
  notAcceptedCount: number;
}

const ACTIVE_STATUSES = new Set(["pending", "gathering", "processing"]);

// Dismissals persist per browser and are PERMANENT for finished pushes — the
// panel must never quietly re-appear once someone has cleared it. A push that
// is still running is never hidden, and a dismissed push that later goes back
// to 'processing' (because its errors were retried) re-appears on purpose.
const DISMISSED_KEY = "outboundhero.dismissedPushes";

function readDismissed(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

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
  const [retryingAll, setRetryingAll] = useState(false);
  const [totalsFor, setTotalsFor] = useState<string | null>(null);
  const [totals, setTotals] = useState<CampaignTotals | null>(null);
  const [errorsFor, setErrorsFor] = useState<string | null>(null);
  const [errors, setErrors] = useState<BatchErrors | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  // Hydrate after mount so server and first client render agree.
  useEffect(() => setDismissed(readDismissed()), []);

  const dismiss = useCallback((id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]));
      } catch { /* storage disabled — in-memory only for this session */ }
      return next;
    });
  }, []);

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

  // A running push is shown even if it was dismissed earlier.
  const visible = batches.filter((b) => ACTIVE_STATUSES.has(b.status) || !dismissed.has(b.id));

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
      if (!res.ok) toast.error(data.error ?? "Failed to cancel push");
      else toast.success("Push cancelled");
      loadBatches();
    } catch {
      toast.error("Failed to cancel push");
    } finally {
      setCancellingId(null);
    }
  }

  async function handleRetry(batchId: string | null) {
    const all = batchId === null;
    if (all) setRetryingAll(true); else setRetryingId(batchId);
    try {
      const res = await fetch("/api/bison/push-batches/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(all ? { all: true } : { batchId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) toast.error(data.error ?? "Failed to retry");
      else {
        toast.success(
          `${Number(data.requeued).toLocaleString()} contact(s) requeued` +
            (all && data.batches > 1 ? ` across ${data.batches} pushes` : "")
        );
        if (errorsFor) setErrorsFor(null);
      }
      loadBatches();
    } catch {
      toast.error("Failed to retry");
    } finally {
      setRetryingAll(false);
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

  async function toggleErrors(batchId: string) {
    if (errorsFor === batchId) { setErrorsFor(null); setErrors(null); return; }
    setErrorsFor(batchId);
    setErrors(null);
    try {
      const res = await fetch(`/api/bison/push-batches/errors?batchId=${batchId}`);
      if (res.ok) setErrors(await res.json());
      else toast.error("Couldn't load the details for this push");
    } catch {
      toast.error("Couldn't load the details for this push");
    }
  }

  // No card at all until the first fetch resolves, and none once everything
  // finished has been dismissed.
  if (!loaded || visible.length === 0) return null;

  const totalRetryable = visible.reduce((n, b) => n + (ACTIVE_STATUSES.has(b.status) ? 0 : b.failed), 0);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="text-[17px]">Bison pushes</CardTitle>
        {totalRetryable > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={retryingAll}
            onClick={() => handleRetry(null)}
            title="Requeues every contact that hit a genuine error, across all pushes. Contacts Bison refused are never retried."
          >
            <RotateCcw className={`h-3.5 w-3.5 ${retryingAll ? "animate-spin" : ""}`} />
            {retryingAll ? "Retrying…" : `Retry all errors (${totalRetryable.toLocaleString()})`}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {visible.map((batch) => {
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
                {active ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10"
                    disabled={cancellingId === batch.id}
                    onClick={() => handleCancel(batch.id)}
                  >
                    Cancel
                  </Button>
                ) : (
                  <button
                    type="button"
                    onClick={() => dismiss(batch.id)}
                    aria-label="Dismiss this push"
                    title="Dismiss — this push won't show again"
                    className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3.5" />
                  </button>
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
                <span className="text-foreground">{batch.sent.toLocaleString()} sent</span>
                {batch.failed > 0 && (
                  <span className="text-destructive">{batch.failed.toLocaleString()} errored</span>
                )}
                {batch.skipped > 0 && (
                  <span title="Bison refused these: already in another sequence, previously bounced there, or unsubscribed. Retrying can't succeed.">
                    {batch.skipped.toLocaleString()} not accepted
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => toggleTotals(batch.id)}
                  className="font-medium text-primary hover:underline"
                >
                  {totalsFor === batch.id ? "Hide totals" : "Routing totals"}
                </button>
                {(batch.failed > 0 || batch.skipped > 0) && (
                  <button
                    type="button"
                    onClick={() => toggleErrors(batch.id)}
                    className="font-medium text-primary hover:underline"
                  >
                    {errorsFor === batch.id ? "Hide details" : "Why?"}
                  </button>
                )}
                {!active && batch.failed > 0 && (
                  <button
                    type="button"
                    disabled={retryingId === batch.id || retryingAll}
                    onClick={() => handleRetry(batch.id)}
                    className="font-medium text-primary hover:underline disabled:opacity-50"
                  >
                    {retryingId === batch.id ? "Retrying…" : `Retry ${batch.failed.toLocaleString()} errored`}
                  </button>
                )}
              </div>

              {errorsFor === batch.id && (
                <div className="mt-1.5 space-y-2 rounded-lg bg-muted/50 p-2">
                  {!errors ? (
                    <p className="text-[11px] text-muted-foreground">Loading details…</p>
                  ) : (
                    <>
                      {errors.failed.length > 0 && (
                        <div>
                          <p className="mb-1 text-[11px] font-semibold text-destructive">
                            Errors — {errors.retryableCount.toLocaleString()} contact(s), can be retried
                          </p>
                          {errors.failed.map((g) => (
                            <p key={g.reason} className="text-[11px] leading-snug">
                              <span className="font-medium tabular-nums">{g.count.toLocaleString()}×</span>{" "}
                              {g.reason}
                              {g.samples.length > 0 && (
                                <span className="text-muted-foreground"> — e.g. {g.samples.slice(0, 3).join(", ")}</span>
                              )}
                            </p>
                          ))}
                        </div>
                      )}
                      {errors.skipped.length > 0 && (
                        <div>
                          <p className="mb-1 text-[11px] font-semibold text-muted-foreground">
                            Not accepted by Bison — {errors.notAcceptedCount.toLocaleString()} contact(s). Retrying won&apos;t help.
                          </p>
                          {errors.skipped.map((g) => (
                            <p key={g.reason} className="text-[11px] leading-snug text-muted-foreground">
                              <span className="font-medium tabular-nums">{g.count.toLocaleString()}×</span> {g.reason}
                            </p>
                          ))}
                        </div>
                      )}
                      {errors.failed.length === 0 && errors.skipped.length === 0 && (
                        <p className="text-[11px] text-muted-foreground">No per-contact detail recorded.</p>
                      )}
                    </>
                  )}
                </div>
              )}

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
