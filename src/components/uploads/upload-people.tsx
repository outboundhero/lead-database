"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, CirclePause, Database, Loader2, Send, Table2, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useHasPermission } from "@/lib/context/role-context";
import type { FoundRound, UploadPeopleList, UploadPeopleView } from "@/app/api/uploads/people/route";

// An upload's no-email rows in its client's People table (migration 130), on
// the Uploads page: where the rows went or why not, their People rows by
// status, the emails found and added, the worker's state, "Add the found
// emails now" (manager and up) and Send (admin) for an upload that was not
// sent. Read from GET /api/uploads/people, every 2.5 s while something moves
// and every 10 s otherwise, only while the page is visible (as the Clay tab).

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Something is moving: rows being worked, a round adding, or rows still to copy. */
const isBusy = (v: UploadPeopleView) =>
  v.rows.queued + v.rows.running > 0 || v.adding > 0 || v.state === "undecided" || v.state === "processing" || (v.state === "moving" && !v.reason);

/** People found but not added yet, and not in a round: who "Add the found emails now" would take. */
export const toAdd = (v: UploadPeopleView) => Math.max(0, v.found - v.added - v.already - v.adding - v.failed);

/** Polls where these uploads' no-email rows stand (at most 20 ids). */
export function useUploadPeople(ids: string[]) {
  const key = [...new Set(ids)].slice(0, 20).join(",");
  const [data, setData] = useState<UploadPeopleList | null>(null);
  const [tick, setTick] = useState(0);
  const inFlight = useRef(false);

  useEffect(() => {
    if (!key) return;
    let live = true;
    inFlight.current = true;
    fetch(`/api/uploads/people?batches=${key}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error);
        return j as UploadPeopleList;
      })
      .then((j) => {
        if (live) setData(j);
      })
      .catch(() => {})
      .finally(() => {
        inFlight.current = false;
      });
    return () => {
      live = false;
    };
  }, [key, tick]);

  const busy = useMemo(() => Object.values(data?.batches ?? {}).some(isBusy), [data]);
  useEffect(() => {
    if (!key) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && !inFlight.current) setTick((n) => n + 1);
    }, busy ? 2_500 : 10_000);
    return () => clearInterval(t);
  }, [key, busy]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data: key ? data : null, reload };
}

/** The worker's state, as a warning about upload rows, or null when all is well. */
export function workerWarning(worker: UploadPeopleList["worker"]): string | null {
  if (!worker) return "No enrichment worker has run yet, so the no-email rows are not copied or worked.";
  if (!worker.moves) {
    return "The worker running now does not copy upload rows or release held People rows (it predates this build). They wait until the new worker is deployed.";
  }
  if (!worker.online) return "The worker is offline, so nothing moves until it is back.";
  return null;
}

/** "Being worked", "held" and the rest, as one short line. */
function countsLine(v: UploadPeopleView): string {
  const worked = v.rows.queued + v.rows.running;
  return [
    v.rows.held ? `${fmt(v.rows.held)} held` : "",
    worked ? `${fmt(worked)} being worked` : "",
    v.rows.waiting ? `${fmt(v.rows.waiting)} waiting` : "",
    v.found ? `${fmt(v.found)} found` : "",
    v.added ? `${fmt(v.added)} added` : "",
    v.already ? `${fmt(v.already)} already in the database` : "",
    v.failed ? `${fmt(v.failed)} not added` : "",
    v.not_found ? `${fmt(v.not_found)} not found` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const STATE_LABEL: Record<UploadPeopleView["state"], string> = {
  moving: "Being copied",
  moved: "In the People table",
  not_sent: "Not sent",
  undecided: "Being sent",
  before: "Not sent (earlier upload)",
  none: "None",
  processing: "After the upload",
};

/** One upload's People table status, as the Upload history's column shows it. */
export function PeopleCell({ view, onSend }: { view: UploadPeopleView | undefined; onSend?: () => void }) {
  const canSend = useHasPermission("admin");
  if (!view) return <span className="text-muted-foreground">…</span>;
  if (view.state === "none") return <span className="text-muted-foreground">None</span>;
  const sendable = (view.state === "before" || view.state === "not_sent") && canSend && onSend;
  const line = view.state === "moving" || view.state === "moved" ? countsLine(view) : "";
  const last = view.rounds[0];
  return (
    <div className="max-w-[300px] space-y-0.5 text-xs" title={view.why ?? undefined}>
      <div className="flex flex-wrap items-center gap-1.5">
        {view.client_tag && <Badge variant="tinted">{view.client_tag}</Badge>}
        <span className={view.state === "not_sent" || view.state === "before" ? "text-muted-foreground" : "font-medium"}>{STATE_LABEL[view.state]}</span>
        {view.adding > 0 && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        {sendable && (
          <Button size="xs" variant="outline" onClick={onSend}>
            <Send /> Send
          </Button>
        )}
      </div>
      {line && <p className="text-muted-foreground">{line}</p>}
      {last && (
        <p className="text-muted-foreground">
          Last found emails {when(last.created_at)}: {roundLine(last)}
        </p>
      )}
    </div>
  );
}

function roundLine(r: FoundRound): string {
  const parts = [
    r.status === "processing" ? "adding now" : r.status === "error" ? "failed" : "",
    r.inserted ? `${fmt(r.inserted)} new` : "",
    r.merged ? `${fmt(r.merged)} merged` : "",
    r.replaced ? `${fmt(r.replaced)} replaced` : "",
    r.skipped ? `${fmt(r.skipped)} skipped` : "",
    r.errors ? `${fmt(r.errors)} errors` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "nothing new";
}

/**
 * The People box of the upload progress panel, once the upload is final:
 * where its no-email rows went or why not, the counts, the client's switch,
 * the worker's state, the rounds of found emails, "Add the found emails now"
 * and Send.
 */
export function PeopleBox({ batchId, filename }: { batchId: string; filename: string | null }) {
  const { data, reload } = useUploadPeople([batchId]);
  const canAdd = useHasPermission("manager");
  const canSend = useHasPermission("admin");
  const [adding, setAdding] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const view = data?.batches[batchId];
  if (!view || view.state === "none") return null;

  const tag = view.client_tag;
  const ready = (view.state === "moving" || view.state === "moved") && Boolean(view.table_id);
  const warning = ready || view.state === "undecided" ? workerWarning(data?.worker ?? null) : null;
  const pending = toAdd(view);

  const addNow = async () => {
    setAdding(true);
    try {
      const res = await fetch("/api/uploads/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "add_found", batch: batchId }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not start adding the found emails");
      const settled = j.settled ? `${fmt(j.settled)} settled without the import.` : undefined;
      toast.success(j.adding ? `Adding ${fmt(j.adding)} found emails to the lead database.` : "Nobody new to add", { description: settled });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start adding the found emails");
    } finally {
      setAdding(false);
      reload();
    }
  };

  const tile = (label: string, value: number, hint: string) => (
    <div className="rounded border p-2" title={hint}>
      <span className="text-muted-foreground">{label}</span>
      <p className="font-medium tabular-nums">{fmt(value)}</p>
    </div>
  );

  return (
    <div className="space-y-2 rounded-md border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="size-3.5 text-primary" />
        <span className="font-medium">People table</span>
        {tag && <Badge variant="tinted">{tag}</Badge>}
        {ready && (
          <Link href={`/leads/clay?t=${view.table_id}`} className="ml-auto flex items-center gap-1 font-medium text-primary hover:opacity-80">
            <Table2 className="size-3" /> Open it on the Clay tab
          </Link>
        )}
      </div>
      {view.why && <p className="leading-relaxed">{view.why}</p>}

      {ready && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {tile("In the People table", view.moved, "No-email rows copied into the client's People table")}
            {tile("Held", view.rows.held, "Waiting for the client's People runs switch, or for room in the table (2,000 rows at a time)")}
            {tile("Being worked", view.rows.queued + view.rows.running, "Queued or running: the email finders are looking")}
            {tile("Waiting", view.rows.waiting, "Waiting for a key or for a vendor's daily cap to have room")}
            {tile("Found", view.found, "An approved email was found")}
            {tile("Added", view.added, "Added to the lead database by this upload's own import")}
            {tile("Already in the database", view.already, "A lead with the found address was there; the upload's rule for duplicates applied to it")}
            {tile("Not found", view.not_found, "Worked to the end with no approved email")}
          </div>
          {view.failed > 0 && (
            <p className="text-destructive">
              {fmt(view.failed)} not added: the import could not store them, or their address or row could not be used. The cell on the Clay tab says which.
            </p>
          )}
          {tag && view.rows.held > 0 && (
            <p className="flex items-start gap-1.5 leading-relaxed text-muted-foreground">
              <CirclePause className="mt-0.5 size-3.5 shrink-0" />
              {view.switched_on
                ? `${tag} is on People runs, so the worker releases the held rows as the table has room, 2,000 at a time.`
                : `${tag} is not on People runs, so these rows stay held and nothing is spent on them. Switch it on in the Companies tab's settings (People runs, with ${tag} on its list).`}
            </p>
          )}
          {tag && !view.targeting && (
            <p className="flex items-start gap-1.5 leading-relaxed text-[var(--warning)]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {`${tag} has no targeting rules, so its upload rows stop at the area check and no email finder runs on them.`}
            </p>
          )}
        </>
      )}
      {warning && (
        <p className="flex items-start gap-1.5 leading-relaxed text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {warning}
        </p>
      )}
      {ready && data?.worker && (
        <p className="text-muted-foreground">
          {data.worker.found_auto
            ? "The worker adds found emails by itself, at most every 10 minutes."
            : "Found emails are added when someone presses Add the found emails now: automatic adding is off."}
        </p>
      )}
      {view.rounds.length > 0 && (
        <div className="space-y-0.5">
          <p className="font-medium text-muted-foreground">Found emails added</p>
          {view.rounds.map((r) => (
            <p key={r.id} className="tabular-nums text-muted-foreground">
              {when(r.created_at)}: {roundLine(r)}
            </p>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {ready && canAdd && (
          <Button
            size="xs"
            onClick={addNow}
            disabled={adding || view.adding > 0 || (pending === 0 && view.failed === 0)}
            title={view.adding > 0 ? "Adding now" : pending === 0 && view.failed === 0 ? "No found email is waiting to be added" : undefined}
          >
            {adding ? <Loader2 className="animate-spin" /> : <Database />} Add the found emails now
          </Button>
        )}
        {(view.state === "before" || view.state === "not_sent") && canSend && (
          <Button size="xs" variant="outline" onClick={() => setSendOpen(true)}>
            <Send /> Send to a client&apos;s People table
          </Button>
        )}
      </div>
      <SendDialog open={sendOpen} onOpenChange={setSendOpen} batchId={batchId} filename={filename} rows={view.kept_back} onSent={reload} />
    </div>
  );
}

type ClientOption = { tag: string; name: string | null; status: string | null };

/**
 * Send (admin): an upload made before uploads recorded their tags, or one the
 * worker did not send, goes to the People table of the client picked here.
 * Never from a file name. Its rows arrive held and cost nothing until the
 * client is on People runs.
 */
export function SendDialog({
  open,
  onOpenChange,
  batchId,
  filename,
  rows,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batchId: string;
  filename: string | null;
  rows: number;
  onSent: () => void;
}) {
  const [clients, setClients] = useState<ClientOption[] | null>(null);
  const [tag, setTag] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || clients) return;
    createClient()
      .from("client_tags")
      .select("tag, name, status")
      .order("tag")
      .then(({ data }) => {
        const list = (data ?? []) as ClientOption[];
        setClients([...list].sort((a, b) => Number(b.status === "Active") - Number(a.status === "Active") || a.tag.localeCompare(b.tag)));
      });
  }, [open, clients]);

  const send = async () => {
    if (!tag) return;
    setBusy(true);
    try {
      const res = await fetch("/api/uploads/people", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "send", batch: batchId, tag }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not send the rows");
      toast.success(`Sent to ${tag}'s People table`, { description: "The worker copies the rows within a minute. They stay held until the client is on People runs." });
      onOpenChange(false);
      onSent();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not send the rows");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send to a client&apos;s People table</DialogTitle>
          <DialogDescription>
            {`The ${fmt(rows)} no-email rows of ${filename ?? "this upload"} go to the People table of the client you pick, held: nothing runs or is spent on them until that client is on People runs. Emails found there are added as leads with the client's tag, by this upload's own rules. Pick the client the list was made for; the file name is never used.`}
          </DialogDescription>
        </DialogHeader>
        <Select value={tag} onValueChange={setTag}>
          <SelectTrigger className="w-full" aria-label="Client">
            <SelectValue placeholder={clients ? "Choose a client" : "Loading the clients…"} />
          </SelectTrigger>
          <SelectContent>
            {(clients ?? []).map((c) => (
              <SelectItem key={c.tag} value={c.tag}>
                {c.tag}
                {c.name ? ` · ${c.name}` : ""}
                {c.status && c.status !== "Active" ? ` (${c.status})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={send} disabled={!tag || busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Send />} Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
