"use client";

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { fmtCount } from "@/lib/sharing/labels";

// "Push shared" (POST /api/sharing/push): first a dry run that counts what it
// would queue, named in the confirm; then it queues those shares and pushes
// them at once. Admin only (the route checks it too).

type Target = { batchId?: string; receiver?: string; held?: boolean };
type DryRun = { enabled: boolean; queue: Record<string, number>; notOnPushList: Record<string, number> };

const list = (m: Record<string, number>) =>
  Object.entries(m)
    .map(([t, n]) => `${t} (${fmtCount(n)})`)
    .join(", ");

export function PushSharedDialog({ target, onClose, onDone }: { target: Target | null; onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>{target && <PushSharedBody key={JSON.stringify(target)} target={target} onClose={onClose} onDone={onDone} />}</DialogContent>
    </Dialog>
  );
}

/** The dialog's body, made fresh for each target (its dry run is that target's). */
function PushSharedBody({ target, onClose, onDone }: { target: Target; onClose: () => void; onDone: () => void }) {
  const [dry, setDry] = useState<DryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let gone = false;
    fetch("/api/sharing/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...target, dryRun: true }),
    })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not count the shares");
        if (!gone) setDry(j);
      })
      .catch((e) => !gone && setError(e instanceof Error ? e.message : "Could not count the shares"));
    return () => {
      gone = true;
    };
  }, [target]);

  const total = dry ? Object.values(dry.queue).reduce((a, b) => a + b, 0) : 0;
  const push = async () => {
    setBusy(true);
    try {
      const r = await fetch("/api/sharing/push", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not push the shares");
      const results = (j.results ?? []) as Array<{ receiver: string; pushed?: number; held?: number; error?: string; note?: string | null }>;
      const pushed = results.reduce((a, x) => a + (x.pushed ?? 0), 0);
      const held = results.reduce((a, x) => a + (x.held ?? 0), 0);
      const failed = results.filter((x) => x.error);
      if (failed.length) toast.error(`${failed.map((x) => `${x.receiver}: ${x.error}`).join(" ")} Those shares stay queued.`);
      toast.success(`Queued ${fmtCount(total)}: ${fmtCount(pushed)} pushed, ${fmtCount(held)} held.`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not push the shares");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Push shared leads</DialogTitle>
        <DialogDescription>
          Applied shares that were never pushed{target.held ? ", and held ones," : ""} go into each client&apos;s Active or Draft campaigns,
          picked as the export screen picks them. Only clients on the push list take part.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-2 text-[13px] leading-relaxed">
        {error && <p className="text-destructive">{error}</p>}
        {!dry && !error && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        {dry && !dry.enabled && <p className="text-destructive">Sharing is switched off, so nothing can be pushed.</p>}
        {dry && total > 0 && <p>To push: {list(dry.queue)}.</p>}
        {dry && total === 0 && <p>Nothing to push.</p>}
        {dry && Object.keys(dry.notOnPushList).length > 0 && (
          <p className="text-muted-foreground">Left as they are, not on the push list: {list(dry.notOnPushList)}.</p>
        )}
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" onClick={push} disabled={busy || !dry || !dry.enabled || total === 0}>
          {busy ? <Loader2 className="animate-spin" /> : <Send />} Push {total ? fmtCount(total) : ""}
        </Button>
      </DialogFooter>
    </>
  );
}
