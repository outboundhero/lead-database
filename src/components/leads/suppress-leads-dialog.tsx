"use client";

import * as React from "react";
import { Ban, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";

// Suppress = never contact this address again, for any client, ever.
//
// Distinct from deleting, and the distinction is the point: the Bison sync adds
// addresses Bison holds that we do not, so a deleted lead comes back on the next
// run and goes into a campaign again. Suppression is recorded against the
// ADDRESS and survives deletion, so it cannot be undone by a sync.

export function SuppressLeadsDialog({
  open,
  onClose,
  ids,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  /** Selected lead ids — resolved to addresses server-side. */
  ids: string[];
  onDone?: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [alsoDelete, setAlsoDelete] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) { setReason(""); setAlsoDelete(false); }
  }, [open]);

  if (!open) return null;

  async function submit() {
    setBusy(true);
    try {
      const res = await fetch("/api/leads/suppress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids, reason: reason.trim() || null, delete: alsoDelete }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Couldn't suppress");
      toast.success(d.message ?? `${d.suppressed} address(es) suppressed`);
      onDone?.();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't suppress");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-2">
          <h2 className="flex items-center gap-2 text-[17px] font-semibold">
            <Ban className="size-4 text-destructive" />
            Never contact {ids.length.toLocaleString()} lead{ids.length === 1 ? "" : "s"}
          </h2>
          <button type="button" onClick={onClose} className="rounded-full p-1 hover:bg-muted" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <p className="mt-2 text-[13px] text-muted-foreground">
          These addresses will be hidden from the database and blocked from every client campaign,
          permanently. <span className="font-medium text-foreground">They stay blocked even if Bison
          still holds them</span> — the next sync will not add them back.
        </p>

        <label className="mt-4 block text-[12px] font-medium">Reason (optional)</label>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. complained, competitor, personal contact"
          className="mt-1 h-9 text-sm"
        />

        <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-xl bg-muted/50 p-3 text-[13px]">
          <Checkbox checked={alsoDelete} onCheckedChange={(v) => setAlsoDelete(v === true)} className="mt-0.5" />
          <span>
            Also delete the lead rows
            <span className="block text-[12px] text-muted-foreground">
              The suppression is kept either way, so deleting does not let them return.
            </span>
          </span>
        </label>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="destructive" size="sm" onClick={submit} disabled={busy || ids.length === 0}>
            {busy ? <><Loader2 className="mr-1 size-3 animate-spin" /> Suppressing…</> : "Never contact"}
          </Button>
        </div>
      </div>
    </div>
  );
}
