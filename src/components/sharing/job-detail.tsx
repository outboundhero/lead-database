"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, Loader2, RotateCcw, Send, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { age, fmtCount, JOB_STATE_LABEL, OUTCOME_LABEL, OUTCOME_ORDER, PUSH_STATE_LABEL, pushNoteText, when } from "@/lib/sharing/labels";
import type { JobAnswer, JobReceiver, ShareOutcome } from "@/lib/sharing/types";
import { PushSharedDialog } from "./push-shared-dialog";

// One share job on the Sharing page: per receiving client its outcomes, push
// states and a sample of rows, the push batches its shares went into (how
// each ended, in words, and whether the share step has settled it), and the
// admin's buttons: Apply (a confirm shows what changed since the preview),
// Undo, Retry and Push shared. The work is the share step's own; this only
// asks for it.

type Preview = { receivers: Array<{ tag: string; before: Record<string, number>; now: Record<string, number>; overCap: boolean }> };
/** The push batch states the share step settles (its shares not sent get their end state). */
const ENDED_PUSH = ["complete", "cancelled", "error"];
type Confirm = { kind: "apply" | "undo"; receiver: string | null; preview?: Preview | null };

const outcomeLine = (o: Partial<Record<ShareOutcome, number>>) =>
  OUTCOME_ORDER.filter((k) => o[k])
    .map((k) => `${OUTCOME_LABEL[k]} ${fmtCount(o[k])}`)
    .join(" · ");

function ReceiverCard({ r, onApply, onUndo, onPush, canAct, jobState }: {
  r: JobReceiver;
  onApply: () => void;
  onUndo: () => void;
  onPush: () => void;
  canAct: boolean;
  jobState: string;
}) {
  const shares = (r.outcomes.shared ?? 0) + (r.outcomes.own_topup ?? 0);
  const live = r.appliedRows - r.undoneRows;
  return (
    <div className="space-y-2 rounded-2xl bg-card p-3 shadow-ios">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold">{r.tag}</span>
        {r.applied && <Badge variant="success">Applied</Badge>}
        {r.overCap && <Badge variant="warning">Over a cap</Badge>}
        {r.onPushList ? <Badge variant="tinted">Pushed automatically</Badge> : <Badge variant="outline">Not on the push list</Badge>}
        {r.receiveBlock && <Badge variant="destructive">Cannot receive: {r.receiveBlock}</Badge>}
        {canAct && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            {shares > 0 && !r.applied && ["previewed", "applied"].includes(jobState) && (
              <Button size="xs" onClick={onApply}>
                <CheckCircle2 /> Apply
              </Button>
            )}
            {live > 0 && (
              <Button size="xs" variant="outline" onClick={onPush}>
                <Send /> Push shared
              </Button>
            )}
            {(r.appliedRows > r.undoneRows || shares > 0) && jobState !== "undone" && (
              <Button size="xs" variant="outline" onClick={onUndo}>
                <Undo2 /> Undo
              </Button>
            )}
          </div>
        )}
      </div>
      <p className="text-[12.5px] text-muted-foreground">{outcomeLine(r.outcomes) || "No lead of this import fits this client."}</p>
      {(Object.keys(r.push).length > 0 || r.taggedRows > 0) && (
        <p className="text-[12.5px] text-muted-foreground">
          {Object.entries(r.push)
            .map(([k, n]) => `${PUSH_STATE_LABEL[k as keyof typeof PUSH_STATE_LABEL]} ${fmtCount(n)}`)
            .join(" · ")}
          {r.taggedRows ? ` · Tag written on ${fmtCount(r.taggedRows)}` : ""}
          {r.undoneRows ? ` · Undone ${fmtCount(r.undoneRows)}` : ""}
        </p>
      )}
      {r.sample.length > 0 && (
        <div className="-mx-3 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>City</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Matched place</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Push</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {r.sample.map((s) => (
                <TableRow key={s.id} className={s.undone_at ? "opacity-50" : undefined}>
                  <TableCell className="max-w-[220px] truncate font-medium">{s.email ?? "(lead gone)"}</TableCell>
                  <TableCell className="max-w-[180px] truncate">{s.company ?? ""}</TableCell>
                  <TableCell>{s.city ?? ""}</TableCell>
                  <TableCell>{s.state ?? ""}</TableCell>
                  <TableCell>{s.matched_place ?? ""}</TableCell>
                  <TableCell>{OUTCOME_LABEL[s.outcome] ?? s.outcome}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {s.push_state ? PUSH_STATE_LABEL[s.push_state] : s.applied_at ? "Not queued" : ""}
                    {s.push_note ? `: ${pushNoteText(s.push_note)}` : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

export function JobDetail({ batchId, isAdmin, onClose, onChanged }: { batchId: string; isAdmin: boolean; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<JobAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [pushTarget, setPushTarget] = useState<{ batchId: string; receiver?: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/sharing/job?id=${encodeURIComponent(batchId)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not load the share job");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the share job");
    }
  }, [batchId]);
  useEffect(() => {
    load();
  }, [load]);

  const post = async (path: string, body: Record<string, unknown>) => {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? "The request failed");
    return j;
  };

  const askApply = async (receiver: string | null) => {
    setBusy(true);
    try {
      const preview = (await post("/api/sharing/apply", { batchId, receiver, preview: true })) as Preview;
      setConfirm({ kind: "apply", receiver, preview });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not decide the job again");
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "apply") {
        const out = await post("/api/sharing/apply", { batchId, receiver: confirm.receiver });
        const n = Object.values((out.applied ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
        toast.success(`Applied ${fmtCount(n)} share${n === 1 ? "" : "s"}`);
      } else {
        const out = await post("/api/sharing/undo", { batchId, receiver: confirm.receiver });
        toast.success(
          `Undone ${fmtCount(out.undone)}. ${out.pushedLeads ? `${fmtCount(out.pushedLeads)} already pushed stay in their campaigns.` : ""}`
        );
      }
      setConfirm(null);
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The request failed");
    } finally {
      setBusy(false);
    }
  };
  const retry = async () => {
    setBusy(true);
    try {
      const out = await post("/api/sharing/retry", { batchId });
      toast.success(`Sent round again (${JOB_STATE_LABEL[out.state as keyof typeof JOB_STATE_LABEL] ?? out.state})`);
      await load();
      onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not retry the job");
    } finally {
      setBusy(false);
    }
  };

  const job = data?.job;
  return (
    <div className="space-y-3 rounded-2xl bg-muted/40 p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold">{job ? job.filename ?? job.source_label ?? "Import" : "Share job"}</p>
          {job && (
            <p className="text-[12.5px] text-muted-foreground">
              From {job.origin_tag ?? "no client"}
              {job.origin_pool ? ` (${job.origin_pool} pool)` : ""} · {JOB_STATE_LABEL[job.state]}
              {job.reason_text ? `: ${job.reason_text}` : ""} · {fmtCount(job.new_leads)} new lead{job.new_leads === 1 ? "" : "s"}
              {job.leads_no_place ? ` · ${fmtCount(job.leads_no_place)} without a usable place` : ""}
              {job.topup ? " · a top-up pull" : ""} · imported {when(job.batch_done_at)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {job && (
            <Button size="xs" variant="outline" asChild>
              <a href={`/api/sharing/csv?id=${encodeURIComponent(batchId)}`}>
                <Download /> CSV
              </a>
            </Button>
          )}
          {isAdmin && job && ["previewed", "applied"].includes(job.state) && job.receivers.length > 1 && (
            <Button size="xs" onClick={() => askApply(null)} disabled={busy}>
              <CheckCircle2 /> Apply all
            </Button>
          )}
          {isAdmin && job && job.state === "error" && (
            <Button size="xs" variant="outline" onClick={retry} disabled={busy}>
              <RotateCcw /> Retry
            </Button>
          )}
          {isAdmin && job && ["previewed", "applied"].includes(job.state) && (
            <Button size="xs" variant="outline" onClick={() => setConfirm({ kind: "undo", receiver: null })} disabled={busy}>
              <Undo2 /> Undo all
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close the job">
            <X />
          </Button>
        </div>
      </div>

      {error && <p className="text-[13px] text-destructive">{error}</p>}
      {!data && !error && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      {job?.place_wait_hit_at && (
        <p className="flex gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          This import waited the place limit ({when(job.place_wait_hit_at)}): no location run finished after it in time, so it was decided with
          the places known then. Check that the location run is going.
        </p>
      )}
      {job?.last_error && (
        <p className="rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          Last error ({job.attempts} tr{job.attempts === 1 ? "y" : "ies"}): {job.last_error}
        </p>
      )}
      {job?.state === "no_lead_list" && (
        <p className="rounded-xl bg-[var(--warning)]/12 px-3 py-2 text-[12.5px]">
          This import added leads but kept no list of them: it ran from an old copy of the app, or while sharing was off. Its leads are not shared.
        </p>
      )}

      {data?.receivers.map((r) => (
        <ReceiverCard
          key={r.tag}
          r={r}
          jobState={data.job.state}
          canAct={isAdmin}
          onApply={() => askApply(r.tag)}
          onUndo={() => setConfirm({ kind: "undo", receiver: r.tag })}
          onPush={() => setPushTarget({ batchId, receiver: r.tag })}
        />
      ))}
      {data && data.receivers.length === 0 && job && !["skipped", "no_lead_list"].includes(job.state) && (
        <p className="text-[12.5px] text-muted-foreground">No receiving client yet.</p>
      )}

      {data && data.pushBatches.length > 0 && (
        <div className="space-y-1">
          <p className="text-[12.5px] font-medium">Push batches (Exports page)</p>
          {data.pushBatches.map((b) => (
            <p key={b.id} className="text-[12.5px] text-muted-foreground">
              {b.receiver} · {b.source === "topup" ? "own top-up" : "shares"} · {b.status}
              {b.endNote ? ` · ${b.endNote}` : ""} · {fmtCount(b.sent)} of {fmtCount(b.total)} sent · queued {age(b.created_at)} ago
              {ENDED_PUSH.includes(b.status)
                ? b.settled
                  ? " · settled"
                  : " · not settled yet: its leads that were not sent get their end state at the next share round"
                : ""}
            </p>
          ))}
        </div>
      )}

      <Dialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirm?.kind === "apply" ? "Apply the shares" : "Undo the shares"}</DialogTitle>
            <DialogDescription>
              {confirm?.kind === "apply"
                ? "The job is decided again with each client's current rules. The shares are logged as applied, and queued for push for clients on the push list."
                : "The shares are marked undone, pushes not gathered yet are cancelled, and tags written are taken off, paced. Leads already pushed stay in their campaigns."}
              {confirm?.receiver ? ` Only ${confirm.receiver}.` : " Every receiving client of this job."}
            </DialogDescription>
          </DialogHeader>
          {confirm?.kind === "apply" && confirm.preview && (
            <div className="space-y-1 text-[12.5px]">
              {confirm.preview.receivers.map((r) => (
                <p key={r.tag}>
                  <span className="font-semibold">{r.tag}</span>: shared {fmtCount(r.before.shared ?? 0)} at the preview, {fmtCount(r.now.shared ?? 0)} now
                  {r.overCap ? " (over a cap: applying it is your call)" : ""}
                </p>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button size="sm" variant={confirm?.kind === "undo" ? "destructive" : "default"} onClick={run} disabled={busy}>
              {busy && <Loader2 className="animate-spin" />} {confirm?.kind === "apply" ? "Apply" : "Undo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <PushSharedDialog
        target={pushTarget}
        onClose={() => setPushTarget(null)}
        onDone={() => {
          load();
          onChanged();
        }}
      />
    </div>
  );
}
