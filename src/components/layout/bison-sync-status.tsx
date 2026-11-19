"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

// Top-bar Bison sync panel (2026-11-20): when new Bison leads were last pulled
// in, and "Sync now". The button records a request; the bison-sync cron checks
// every 30 minutes and runs it (GET/POST /api/bison/sync). Times are Pacific —
// PST, or PDT in summer — as the team reads them.

interface Run {
  id: number | string;   // bigserial: pg returns it as a string
  status: "requested" | "running" | "done" | "failed";
  trigger: "button" | "schedule" | "manual";
  requested_by: string | null;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  rows_fetched: string | number | null;
  new_leads: string | number | null;
  error: string | null;
}
interface SyncStatus { active: Run | null; last: Run | null; watermarkAt: string | null }

const PT_DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const PT_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit", timeZoneName: "short",
});
const when = (s: string | null | undefined) => (s ? PT_DATE.format(new Date(s)) : "—");
const at = (s: string | null | undefined) => (s ? PT_TIME.format(new Date(s)) : "—");
const n = (v: string | number | null | undefined) => Number(v ?? 0).toLocaleString();
const TRIGGER: Record<Run["trigger"], string> = { button: "Sync now", schedule: "every-3-days schedule", manual: "run by hand" };

function describe(s: SyncStatus | null): { text: string; detail: string } {
  if (!s) return { text: "Last Bison sync: …", detail: "" };
  const { active, last } = s;
  if (active?.status === "running") {
    return {
      text: `Bison sync running · started ${at(active.started_at ?? active.requested_at)}`,
      detail: `Started by ${TRIGGER[active.trigger]}${active.requested_by ? ` (${active.requested_by})` : ""}.`,
    };
  }
  if (active?.status === "requested") {
    return {
      text: `Bison sync requested ${at(active.requested_at)} · starts within 30 min`,
      detail: `Requested by ${active.requested_by ?? "someone"}. The sync job checks every 30 minutes.`,
    };
  }
  if (last) {
    const lines = [
      `${TRIGGER[last.trigger]}${last.requested_by ? ` (${last.requested_by})` : ""}`,
      `Started ${when(last.started_at)}, finished ${when(last.finished_at)}`,
      last.rows_fetched != null ? `${n(last.rows_fetched)} Bison leads fetched, ${n(last.new_leads)} new to the database` : "",
      last.error ?? "",
    ].filter(Boolean);
    if (last.status === "failed") return { text: `Last Bison sync failed · ${when(last.finished_at ?? last.started_at)}`, detail: lines.join("\n") };
    return {
      text: `Last Bison sync: ${when(last.finished_at)} · ${n(last.new_leads)} new leads${last.error ? " · with errors" : ""}`,
      detail: lines.join("\n"),
    };
  }
  if (s.watermarkAt) return { text: `Last Bison sync: ${when(s.watermarkAt)}`, detail: "" };
  return { text: "No Bison sync recorded yet", detail: "" };
}

export function BisonSyncStatus() {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/bison/sync", { cache: "no-store" });
      if (r.ok) setStatus(await r.json());
    } catch {
      /* keep showing the last answer */
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  const syncNow = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/bison/sync", { method: "POST" });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error ?? `HTTP ${r.status}`);
      if (d?.created) toast.success("Bison sync requested — it starts within 30 minutes.");
      else if (d?.run?.status === "running") toast.info("A Bison sync is already running.");
      else toast.info("A Bison sync is already requested — it starts within 30 minutes.");
      await load();
    } catch (e) {
      toast.error(`Could not request a Bison sync: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const { text, detail } = describe(status);
  const active = status?.active ?? null;
  return (
    <div className="flex items-center gap-2" title={detail || undefined}>
      <span className="hidden text-[12px] font-medium whitespace-nowrap text-muted-foreground tabular-nums lg:inline">
        {text}
      </span>
      <Button
        size="sm"
        variant="outline"
        onClick={syncNow}
        disabled={busy || !!active}
        title="Pull in the leads added to Bison since the last sync (starts within 30 minutes)"
      >
        {active?.status === "running" || busy
          ? <Loader2 className="size-4 animate-spin" strokeWidth={2} />
          : <RefreshCw className="size-4" strokeWidth={2} />}
        Sync now
      </Button>
    </div>
  );
}
