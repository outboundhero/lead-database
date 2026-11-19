"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, Loader2, RefreshCw, Search, Square } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useHasPermission } from "@/lib/context/role-context";
import type { NeverContactRun, NeverContactView } from "@/app/api/never-contact-inboxes/types";

// The Sharing page's "General inboxes" tab (migration 136). General inboxes
// the client's Clay General inboxes filter matches (the kinds of inbox its
// Clay table never writes to) are marked never contact. Whether the filter is
// loaded (never the filter itself), the switch and the daily pace, the newest
// dry run's count with a sample for each part of the filter, and the apply.
// Managers see it; admins run a dry run, apply an approved one and stop an
// apply. No props: the panel reads the viewer's role itself.

const fmt = (n: number | null | undefined) => (n == null ? "?" : Math.round(n).toLocaleString("en-US"));
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "never");

async function send(url: string, body?: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j;
}

function Pill({ tone = "plain", children }: { tone?: "plain" | "warn" | "good" | "bad"; children: React.ReactNode }) {
  const cls = {
    plain: "bg-muted text-foreground",
    warn: "bg-[var(--warning)]/15 text-[var(--warning)]",
    good: "bg-[var(--success)]/15 text-[var(--success)]",
    bad: "bg-destructive/12 text-destructive",
  }[tone];
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium", cls)}>{children}</span>;
}

function DryRun({ run }: { run: NeverContactRun }) {
  const parts = run.sample?.parts ?? [];
  return (
    <div className="space-y-2">
      <p className="text-[13px]">
        <span className="font-semibold tabular-nums">{fmt(run.counted)}</span> general inboxes match and are not on the never-contact list
        (leads created up to {when(run.bound_at)}; counted {when(run.created_at)}
        {run.created_by_name ? ` by ${run.created_by_name}` : ""}, filter {run.sha12}).
      </p>
      {parts.length > 0 && (
        <div className="max-h-80 overflow-y-auto rounded-xl border">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 bg-muted text-left text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 font-medium">Part of the filter</th>
                <th className="px-2 py-1.5 text-right font-medium">Matches</th>
                <th className="px-2 py-1.5 font-medium">Sample</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="px-2 py-1.5 font-mono">{p.part}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{fmt(p.count)}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">{p.sample.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[12px] text-muted-foreground">An address can match more than one part, so the parts add up to more than the count.</p>
    </div>
  );
}

export function NeverContactInboxesPanel() {
  const canView = useHasPermission("manager");
  const isAdmin = useHasPermission("admin");
  const [view, setView] = useState<NeverContactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"dry" | "apply" | "stop" | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/never-contact-inboxes");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load the general inboxes check");
      setView(j as NeverContactView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the general inboxes check");
    }
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  if (!canView) return null;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!view) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading</p>;
  if (!view.ready) return <p className="text-sm text-muted-foreground">Never-contact inboxes are not installed yet (migration 136).</p>;

  const act = async (what: "dry" | "apply" | "stop", fn: () => Promise<unknown>, done: string) => {
    setBusy(what);
    try {
      await fn();
      toast.success(done);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "That did not work");
    } finally {
      setBusy(null);
      load();
    }
  };
  const dry = view.latestDryRun;
  const live = view.live;
  const runDry = () => act("dry", () => send("/api/never-contact-inboxes/dry-run"), "The dry run is done");
  const apply = () => {
    if (!dry) return;
    const ok = window.confirm(
      `Mark never contact the ${fmt(dry.counted)} general inboxes this dry run counted? Only do this once the owner has approved the count. ` +
        `At most ${fmt(view.rowsPerDay)} a day go on the never-contact list, their leads are flagged, and Bison unsubscribes them on every install, ` +
        `which cannot be undone in Bison. Newly imported general inboxes the filter matches are then marked too, while the switch is on.`
    );
    if (ok) act("apply", () => send("/api/never-contact-inboxes/apply", { dryRunId: dry.id }), "The apply is recorded; the topup-worker works it hourly");
  };
  const stop = () => {
    if (window.confirm("Stop the apply? Addresses already marked stay on the never-contact list.")) {
      act("stop", () => send("/api/never-contact-inboxes/stop"), "The apply is stopped");
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-2xl border bg-card p-4 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={view.loaded ? "good" : "warn"}>{view.loaded ? "Clay filter loaded" : "Clay filter not loaded"}</Pill>
          <Pill tone={view.on ? "good" : "plain"}>{view.enabled ? (view.on ? "Switched on" : "On, but no filter") : "Switched off"}</Pill>
          <Button variant="ghost" size="sm" className="ml-auto h-8 text-[12px]" onClick={load}>
            <RefreshCw className="mr-1 size-3" /> Reload
          </Button>
        </div>
        {view.loaded ? (
          <p className="text-muted-foreground">
            Read from the Clay originals ({view.source}) {when(view.readAt)}: {view.parts} parts, sha256 {view.sha12}.
          </p>
        ) : (
          <p className="text-muted-foreground">
            The filter is read from the client&apos;s Clay originals by the seed (node scripts/never-contact-inboxes.mjs --seed). Until then
            nothing is marked and coverage counts every general inbox.
          </p>
        )}
        <p className="text-muted-foreground">
          Only leads whose email type is general are ever looked at. At most {fmt(view.rowsPerDay)} addresses a day (UTC), {fmt(view.chunkRows)} at a
          time. Marked today: {fmt(view.today)}; in all: {fmt(view.total)}. The weekly top-up&apos;s good-lead counts leave these inboxes out whether
          or not they have been marked.
        </p>
        {!view.enabled && (
          <p className="text-muted-foreground">Switch it on in the Companies settings once a dry run&apos;s count is approved; nothing is marked while it is off.</p>
        )}
      </div>

      {live && (
        <div className="space-y-1 rounded-2xl border bg-card p-4 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="warn">{live.state === "running" ? "Applying the counted backlog" : "Following new imports"}</Pill>
            <span className="text-muted-foreground">started {when(live.started_at)}{live.created_by_name ? ` by ${live.created_by_name}` : ""}</span>
            {isAdmin && (
              <Button variant="outline" size="sm" className="ml-auto h-8 text-[12px]" onClick={stop} disabled={busy !== null}>
                <Square className="mr-1 size-3" /> Stop
              </Button>
            )}
          </div>
          <p>
            {fmt(live.suppressed)} of {fmt(live.counted)} counted marked never contact, {fmt(live.leads_flagged)} leads flagged,{" "}
            {fmt(live.bison_queued)} Bison unsubscribes queued. Swept up to leads created {when(live.cursor_created_at)}.
          </p>
          {!view.on && <p className="text-[var(--warning)]">Paused: the switch is off (or no filter is loaded).</p>}
        </div>
      )}

      <div className="space-y-3 rounded-2xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Dry run</p>
          {isAdmin && (
            <div className="ml-auto flex gap-1.5">
              <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={runDry} disabled={!view.loaded || busy !== null}>
                {busy === "dry" ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Search className="mr-1 size-3" />} Count now
              </Button>
              <Button size="sm" className="h-8 text-[12px]" onClick={apply}
                disabled={!dry?.can_apply || !view.on || Boolean(live) || busy !== null}
                title={!view.on ? "Switch it on first" : live ? "An apply is going" : dry?.can_apply ? "Apply this count" : "Count again: a dry run must be of this filter and under 24 hours old"}>
                <Ban className="mr-1 size-3" /> Apply this count
              </Button>
            </div>
          )}
        </div>
        {dry ? <DryRun run={dry} /> : <p className="text-[13px] text-muted-foreground">No dry run yet.</p>}
      </div>

      {view.runs.length > 0 && (
        <div className="rounded-2xl border bg-card">
          <p className="border-b px-3 py-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">Recent runs</p>
          {view.runs.map((r) => (
            <div key={r.id} className="flex flex-wrap gap-x-3 border-b px-3 py-2 text-[12px] last:border-b-0">
              <span className="w-20 font-medium">{r.kind === "dry_run" ? "Dry run" : "Apply"}</span>
              <span className="w-20">{r.state}</span>
              <span className="w-40 text-muted-foreground">{when(r.created_at)}</span>
              <span className="tabular-nums">
                {r.kind === "dry_run" ? `${fmt(r.counted)} counted` : `${fmt(r.suppressed)} marked of ${fmt(r.counted)}`}
              </span>
              {r.last_error && <span className="text-destructive">{r.last_error}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
