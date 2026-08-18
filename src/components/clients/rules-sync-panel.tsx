"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Sparkles, X } from "lucide-react";
import { toast } from "sonner";

// "Sync rules" — the AI half of client syncing, kept separate from "Sync groups"
// because it can cost money. Flow: preview what changed -> confirm -> queue a
// job. The work runs on the always-on targeting worker, so closing the tab does
// not interrupt it; this panel just polls the job row.

interface Job {
  id: string;
  status: string;
  client_tags: string[];
  total: number;
  processed: number;
  synced: number;
  failed: number;
  ai_calls: number;
  ai_cost_usd: string | number;
  phase: string | null;
  error: string | null;
  log: string[];
  created_at: string;
  completed_at: string | null;
  reverted_at: string | null;
  snapshot?: unknown[];
}

interface Preview {
  changed: string[];
  changedCount: number;
  totalInSheet: number;
  unmatched: number;
  estimatedCostUsd: number;
}

const ACTIVE = new Set(["pending", "running"]);
const DISMISSED_KEY = "outboundhero.dismissedRulesJobs";

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

// The button lives in the page header and the panel below it — two different
// places in the DOM — so they share one poller and one job through context
// rather than each mounting their own.
interface Ctx {
  job: Job | null;
  active: boolean;
  checking: boolean;
  checkChanges: () => void;
  dismiss: (id: string) => void;
  dismissed: Set<string>;
  revert: (id: string) => void;
  reverting: boolean;
}
const RulesSyncCtx = createContext<Ctx | null>(null);

export function RulesSyncProvider({ children }: { children: React.ReactNode }) {
  const [job, setJob] = useState<Job | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());

  useEffect(() => setDismissed(readDismissed()), []);

  const loadJob = useCallback(async () => {
    try {
      const res = await fetch("/api/clients/sync-rules");
      if (!res.ok) return;
      const data = await res.json();
      setJob((data.jobs ?? [])[0] ?? null);
    } catch { /* keep whatever we last had */ }
  }, []);

  useEffect(() => { loadJob(); }, [loadJob]);

  // Poll only while something is actually running.
  const active = job ? ACTIVE.has(job.status) : false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(loadJob, 3000);
    return () => clearInterval(t);
  }, [active, loadJob]);

  async function checkChanges() {
    setChecking(true);
    try {
      const res = await fetch("/api/clients/sync-rules?preview=1");
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Couldn't check the sheet"); return; }
      if (data.changedCount === 0) {
        toast.success("Everything is already up to date — no client's answers have changed.");
        return;
      }
      setPreview(data);
    } catch {
      toast.error("Couldn't check the sheet");
    } finally {
      setChecking(false);
    }
  }

  async function start() {
    if (!preview) return;
    setStarting(true);
    try {
      const res = await fetch("/api/clients/sync-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientTags: preview.changed }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Couldn't start the sync"); return; }
      toast.success(`Syncing ${data.queued} client(s) — you can close this tab, it keeps running.`);
      setPreview(null);
      loadJob();
    } catch {
      toast.error("Couldn't start the sync");
    } finally {
      setStarting(false);
    }
  }

  async function revert(id: string) {
    if (!window.confirm(
      "Put every client in this sync back to the rules they had before it ran?\n\n" +
      "Re-parsing isn't perfectly repeatable — the same answers can produce different " +
      "locations and exclusions — so this restores the exact previous values."
    )) return;
    setReverting(true);
    try {
      const res = await fetch("/api/clients/sync-rules/revert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: id }),
      });
      const data = await res.json();
      if (!res.ok) toast.error(data.error ?? "Revert failed");
      else toast.success(`Restored previous rules for ${data.restored} client(s)`);
      loadJob();
    } catch {
      toast.error("Revert failed");
    } finally {
      setReverting(false);
    }
  }

  function dismiss(id: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      try { window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next])); } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <RulesSyncCtx.Provider value={{ job, active, checking, checkChanges, dismiss, dismissed, revert, reverting }}>
      {children}

      {/* Confirm — nothing is spent until this is accepted. */}
      <Dialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Sync rules for {preview?.changedCount} client(s)?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-[13px]">
            <p className="text-muted-foreground">
              These clients changed their onboarding answers since the last sync. Their
              locations and exclusion lists will be rebuilt from what they wrote.
              The other {(preview?.totalInSheet ?? 0) - (preview?.changedCount ?? 0)} are
              unchanged and will be skipped at no cost.
            </p>
            <div className="max-h-40 overflow-y-auto rounded-lg bg-muted/50 p-2">
              <div className="flex flex-wrap gap-1">
                {preview?.changed.map((t) => (
                  <Badge key={t} variant="secondary">{t}</Badge>
                ))}
              </div>
            </div>
            <p className="text-muted-foreground">
              Estimated AI cost: <span className="font-medium text-foreground">
                ~${preview?.estimatedCostUsd.toFixed(2)}
              </span>. It runs on the server — you can close this tab.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)} disabled={starting}>Cancel</Button>
            <Button onClick={start} disabled={starting}>
              {starting ? "Starting…" : "Sync rules"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </RulesSyncCtx.Provider>
  );
}

/** The header button. */
export function RulesSyncButton({ canRun }: { canRun: boolean }) {
  const ctx = useContext(RulesSyncCtx);
  if (!ctx || !canRun) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      className="gap-2"
      onClick={ctx.checkChanges}
      disabled={ctx.checking || ctx.active}
      title="Re-reads each client's onboarding answers and rebuilds their locations and exclusions. Uses AI, so it shows you what changed and the cost before spending anything. Only clients whose answers changed are re-parsed."
    >
      <Sparkles className={`h-4 w-4 ${ctx.checking ? "animate-pulse" : ""}`} />
      {ctx.active ? "Syncing rules…" : ctx.checking ? "Checking…" : "Sync rules"}
    </Button>
  );
}

/** Live progress, rendered under the page header. */
export function RulesSyncPanel() {
  const ctx = useContext(RulesSyncCtx);
  if (!ctx) return null;
  const { job, active, dismiss, dismissed, revert, reverting } = ctx;
  const showPanel = job && (active || !dismissed.has(job.id));
  const pct = job && job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 0;
  return (
    <>
      {showPanel && job && (
        <div className="rounded-xl border p-3">
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium">
              Client rules sync — {job.client_tags?.length ?? 0} client(s)
            </p>
            <Badge
              variant={
                job.status === "complete" ? "success"
                  : job.status === "error" ? "destructive" : "warning"
              }
            >
              {job.status}
            </Badge>
            {!active && (
              <button
                type="button"
                onClick={() => dismiss(job.id)}
                aria-label="Dismiss"
                title="Dismiss — this won't show again"
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] tabular-nums text-muted-foreground">
            {job.phase && <span className="text-foreground">{job.phase}</span>}
            <span>{job.processed}/{job.total} steps</span>
            {job.synced > 0 && <span>{job.synced} saved</span>}
            {job.failed > 0 && (
              <span className="text-destructive" title="These kept their previous rules and will retry on the next sync.">
                {job.failed} partial
              </span>
            )}
            <span>{job.ai_calls} AI calls · ${Number(job.ai_cost_usd ?? 0).toFixed(2)}</span>
            {!active && job.synced > 0 && !job.reverted_at && (
              <button
                type="button"
                disabled={reverting}
                onClick={() => revert(job.id)}
                className="font-medium text-primary hover:underline disabled:opacity-50"
                title="Put every client in this sync back to the rules they had before it ran."
              >
                {reverting ? "Reverting…" : "Undo this sync"}
              </button>
            )}
            {job.reverted_at && <span className="italic">reverted</span>}
          </div>
          {job.error && <p className="mt-1 text-[12px] text-destructive">{job.error}</p>}
          {job.log?.length > 0 && (
            <div className="mt-1.5 max-h-32 overflow-y-auto rounded-lg bg-muted/50 p-2">
              {job.log.slice(-20).map((line, i) => (
                <p key={i} className="text-[11px] leading-snug text-muted-foreground">{line}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
