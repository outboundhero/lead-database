"use client";

import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { FilterState } from "@/types/filters";

// Above this many rows we require the operator to type DELETE to confirm.
const TYPED_CONFIRM_THRESHOLD = 1000;

interface DeleteLeadsDialogProps {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
  // "ids"      → delete the explicitly selected rows
  // "filtered" → delete every lead matching the active filters
  mode: "ids" | "filtered";
  ids: string[];
  filters: FilterState;
  // Best-guess count shown immediately (selection length, or approximate
  // filtered total). For the filtered path we fetch an exact count on open.
  approxCount: number;
  isApproximate?: boolean;
}

export function DeleteLeadsDialog({
  open,
  onClose,
  onDeleted,
  mode,
  ids,
  filters,
  approxCount,
  isApproximate = false,
}: DeleteLeadsDialogProps) {
  const [loading, setLoading] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [exactCount, setExactCount] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);

  // For the "ids" path the count is exactly the number of selected rows. For
  // "filtered" we ask the server for an exact count (totalCount is approximate).
  useEffect(() => {
    if (!open) return;
    setConfirmText("");
    if (mode === "ids") {
      setExactCount(ids.length);
      return;
    }
    let cancelled = false;
    setExactCount(null);
    setCounting(true);
    (async () => {
      try {
        const res = await fetch("/api/admin/bulk-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filters, preview: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (!cancelled) setExactCount(data.estimatedCount ?? 0);
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Failed to count leads");
        }
      } finally {
        if (!cancelled) setCounting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  const displayCount = exactCount ?? approxCount;
  const needsTypedConfirm = displayCount >= TYPED_CONFIRM_THRESHOLD;
  const confirmed = !needsTypedConfirm || confirmText.trim() === "DELETE";

  async function handleDelete() {
    if (!confirmed || loading) return;
    setLoading(true);
    const toastId = toast.loading("Deleting leads…");
    try {
      const body =
        mode === "ids" ? { ids } : { filters };
      const res = await fetch("/api/admin/bulk-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Deleted ${Number(data.deleted).toLocaleString()} leads`, { id: toastId });
      onDeleted();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed", { id: toastId });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && !loading) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            Delete Leads
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border border-destructive/20 bg-destructive/10 p-3 flex items-start gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <div className="text-[13px]">
              <p className="font-medium text-destructive">This permanently deletes leads from the database.</p>
              <p className="mt-1 text-muted-foreground">
                {counting ? (
                  <span className="inline-flex items-center gap-1">
                    <Loader2 className="h-3 w-3 animate-spin" /> Counting exact total…
                  </span>
                ) : (
                  <>
                    <strong className="text-foreground">
                      {mode === "filtered" && exactCount === null && isApproximate ? "~" : ""}
                      {displayCount.toLocaleString()}
                    </strong>{" "}
                    {displayCount === 1 ? "lead" : "leads"}{" "}
                    {mode === "ids" ? "selected" : "matching the current filters"} will be removed. This cannot be undone.
                  </>
                )}
              </p>
            </div>
          </div>

          {needsTypedConfirm && (
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Type <strong>DELETE</strong> to confirm deleting {displayCount.toLocaleString()} leads:
              </label>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="DELETE"
                className="h-9 text-xs"
                autoFocus
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={loading || counting || !confirmed || displayCount === 0}
          >
            {loading && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            Delete{displayCount > 0 ? ` ${displayCount.toLocaleString()}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
