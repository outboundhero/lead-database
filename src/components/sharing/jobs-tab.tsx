"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BACKFILL_ORIGIN_TAG, fmtCount, JOB_STATE_LABEL, originLabel, OUTCOME_LABEL, OUTCOME_ORDER, when } from "@/lib/sharing/labels";
import type { JobsAnswer, ShareJob, ShareJobState } from "@/lib/sharing/types";
import { JobDetail } from "./job-detail";

// The Sharing page's Jobs tab: one row per finished import the share step
// found (share_jobs), newest first: its source and client, its state ("no lead
// list" and "waited the limit" included), the new leads checked and the ones
// still waiting for a place, and per receiving client the counts by outcome.
// A row opens the job (JobDetail). A database backfill firing's job (138) reads
// "Database backfill" where an import shows its file, its origin "the database
// (backfill)"; the source filter lists only those (their origin is DATABASE).

const ALL = "__all";
/** The source filter: every job, or only the database backfill's (origin DATABASE, so the jobs route's origin filter finds them). */
const BACKFILL = "backfill";
const STATE_VARIANT: Record<ShareJobState, "success" | "warning" | "destructive" | "secondary" | "tinted" | "outline"> = {
  waiting: "secondary",
  deciding: "secondary",
  previewed: "tinted",
  applied: "success",
  skipped: "outline",
  no_lead_list: "warning",
  error: "destructive",
  undone: "outline",
};

function receiverCounts(job: ShareJob): string {
  const parts: string[] = [];
  for (const [tag, c] of Object.entries(job.counts ?? {})) {
    const bits = OUTCOME_ORDER.filter((k) => c[k]).map((k) => `${fmtCount(c[k])} ${OUTCOME_LABEL[k].toLowerCase()}`);
    parts.push(`${tag}: ${bits.length ? bits.join(", ") : `${fmtCount(c.fits ?? 0)} fit`}`);
  }
  return parts.join(" · ");
}

export function JobsTab({ isAdmin, openJob, onOpenJob }: { isAdmin: boolean; openJob: string | null; onOpenJob: (id: string | null) => void }) {
  const [state, setState] = useState<string>(ALL);
  const [source, setSource] = useState<string>(ALL);
  const [data, setData] = useState<JobsAnswer | null>(null);
  const [more, setMore] = useState<ShareJob[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (before: string | null = null) => {
      setLoading(true);
      setError(null);
      try {
        const q = new URLSearchParams({ limit: "50" });
        if (state !== ALL) q.set("state", state);
        if (source === BACKFILL) q.set("origin", BACKFILL_ORIGIN_TAG);
        if (before) q.set("before", before);
        const r = await fetch(`/api/sharing/jobs?${q}`);
        const j = (await r.json()) as JobsAnswer & { error?: string };
        if (!r.ok) throw new Error(j.error ?? "Could not load the share jobs");
        if (before) setMore((m) => [...m, ...j.jobs]);
        else {
          setData(j);
          setMore([]);
        }
        setNext(j.next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the share jobs");
      } finally {
        setLoading(false);
      }
    },
    [state, source]
  );
  useEffect(() => {
    load();
  }, [load]);

  const jobs = [...(data?.jobs ?? []), ...more];
  const sw = data?.switch;
  return (
    <div className="space-y-3">
      {data && !data.ready && (
        <p className="rounded-2xl bg-[var(--warning)]/12 p-4 text-[13px]">Sharing is not set up in this database yet (migration 134).</p>
      )}
      {data?.ready && sw && !sw.enabled && (
        <p className="rounded-2xl bg-muted/60 p-4 text-[13px] leading-relaxed">
          <span className="font-semibold">Sharing is off.</span> No import is checked and nothing is shared. An admin switches it on, with its
          clients, in the Companies tab&apos;s settings.
        </p>
      )}
      {data?.ready && sw?.enabled && (
        <p className="text-[12.5px] text-muted-foreground">
          On for {fmtCount(sw.tags.length)} client{sw.tags.length === 1 ? "" : "s"} · {sw.mode === "apply" ? "applies on its own" : "preview: an admin applies"} ·{" "}
          {sw.push_tags.length ? `pushed automatically for ${sw.push_tags.join(", ")}` : "nothing pushed automatically"}
          {sw.since ? ` · imports since ${when(sw.since)}` : ""}
        </p>
      )}
      {data?.ready && (!data.worker || !data.worker.sharing) && (
        <p className="flex gap-2 rounded-2xl bg-[var(--warning)]/12 p-4 text-[13px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          {data.worker
            ? "The enrichment worker running now does not run the share step (it predates this build), so no import is shared until the new worker is deployed."
            : "No enrichment worker has run yet, so no import is shared."}
        </p>
      )}
      {data && data.waitedLimit > 0 && (
        <p className="flex gap-2 rounded-2xl bg-destructive/10 p-4 text-[13px] leading-relaxed text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          {fmtCount(data.waitedLimit)} import{data.waitedLimit === 1 ? "" : "s"} this week waited the place limit: no location run finished after
          {data.waitedLimit === 1 ? " it" : " them"} in time. Check that the location run is going.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Select value={state} onValueChange={setState}>
          <SelectTrigger size="sm" className="h-9 w-48 rounded-full text-[13px]" aria-label="State">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every state</SelectItem>
            {(Object.keys(JOB_STATE_LABEL) as ShareJobState[]).map((s) => (
              <SelectItem key={s} value={s}>
                {JOB_STATE_LABEL[s]}
                {data?.byState[s] ? ` (${fmtCount(data.byState[s])})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={source} onValueChange={setSource}>
          <SelectTrigger size="sm" className="h-9 w-48 rounded-full text-[13px]" aria-label="Source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Every source</SelectItem>
            <SelectItem value={BACKFILL}>Database backfill</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={() => load()} aria-label="Reload" disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
      </div>

      {error && <p className="text-[13px] text-destructive">{error}</p>}
      {openJob && <JobDetail batchId={openJob} isAdmin={isAdmin} onClose={() => onOpenJob(null)} onChanged={() => load()} />}

      <div className="overflow-hidden rounded-2xl bg-card shadow-ios">
        {jobs.length === 0 && data && (
          <p className="p-4 text-[13px] text-muted-foreground">{data.ready ? "No share job yet." : "Nothing to show."}</p>
        )}
        {jobs.map((j) => (
          <button
            key={j.batch_id}
            type="button"
            onClick={() => onOpenJob(j.batch_id)}
            className={cn(
              "flex w-full flex-col gap-1 border-b border-border/50 px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-muted/40",
              openJob === j.batch_id && "bg-primary/8"
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="max-w-[320px] truncate text-[13.5px] font-medium">
                {j.kind === "backfill" ? "Database backfill" : j.filename ?? j.source_label ?? "Import"}
              </span>
              <span className="text-[12.5px] text-muted-foreground">{j.origin_tag ? originLabel(j.origin_tag) : "no client"}</span>
              <Badge variant={STATE_VARIANT[j.state]}>{JOB_STATE_LABEL[j.state]}</Badge>
              {j.place_wait_hit_at && <Badge variant="destructive">Waited the limit</Badge>}
              {j.receivers_over_cap.length > 0 && <Badge variant="warning">Over a cap: {j.receivers_over_cap.join(", ")}</Badge>}
              {j.topup && <Badge variant="outline">Top-up</Badge>}
              <span className="ml-auto text-[12px] text-muted-foreground">{when(j.created_at)}</span>
            </div>
            <p className="text-[12.5px] text-muted-foreground">
              {j.reason_text
                ? j.reason_text
                : j.kind === "backfill"
                  ? `${fmtCount(j.new_leads)} lead${j.new_leads === 1 ? "" : "s"} already in the database shared`
                  : `${fmtCount(j.new_leads)} new lead${j.new_leads === 1 ? "" : "s"} checked${j.leads_no_place ? `, ${fmtCount(j.leads_no_place)} waiting for a place` : ""}`}
              {receiverCounts(j) ? ` · ${receiverCounts(j)}` : ""}
            </p>
          </button>
        ))}
      </div>
      {next && (
        <Button size="sm" variant="outline" onClick={() => load(next)} disabled={loading}>
          More
        </Button>
      )}
    </div>
  );
}
