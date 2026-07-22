"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import type { FilterState } from "@/types/filters";

// ── Send to Email Bison — the split-aware push wizard ──
// A caller (leads page) opens this with the current filters + totalCount and an
// optional selectedIds set. The wizard:
//   1. picks a client tag (which maps to a B2B + B2C Bison instance),
//   2. previews the EXACT business-vs-personal split (server-computed),
//   3. picks a campaign per side (pre-filled with a smart suggestion),
//   4. reconfirms, then queues TWO push-batches (one per side).
// Progress is shown by the existing PushBatchesPanel — this dialog polls nothing.

interface ClientTagRow {
  tag: string;
  group_no: number | null;
  b2b_instance: string | null;
  b2c_instance: string | null;
  owner: string | null;
  status: string | null;
  churned: boolean;
  sendable: boolean; // has an instance pair; roster-only churned clients don't
}

interface PreviewCampaign {
  id: number | string;
  name?: string;
  instance_url?: string;
  workspace_name?: string;
}

interface PreviewSide {
  instance: string;
  count: number;
  campaigns: PreviewCampaign[];
  suggested: PreviewCampaign | null;
  error?: string;
}

interface SendPreview {
  clientTag: string;
  b2b: PreviewSide;
  b2c: PreviewSide;
}

const SKIP = "__skip__";

interface SendToBisonWizardProps {
  open: boolean;
  onClose: () => void;
  filters: FilterState;
  totalCount: number;
  selectedIds?: string[];
}

export function SendToBisonWizard({
  open,
  onClose,
  filters,
  totalCount,
  selectedIds = [],
}: SendToBisonWizardProps) {
  const usingSelection = selectedIds.length > 0;

  const [step, setStep] = useState(1);

  // Step 1 — client tags
  const [tags, setTags] = useState<ClientTagRow[]>([]);
  const [tagsLoading, setTagsLoading] = useState(false);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [tagsAttempted, setTagsAttempted] = useState(false);
  const [tagSearch, setTagSearch] = useState("");
  const [selectedTag, setSelectedTag] = useState<ClientTagRow | null>(null);

  // Step 2 — split preview
  const [preview, setPreview] = useState<SendPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Step 3 — campaign choices (campaign id as string, or SKIP)
  const [b2bChoice, setB2bChoice] = useState<string>(SKIP);
  const [b2cChoice, setB2cChoice] = useState<string>(SKIP);

  const [confirming, setConfirming] = useState(false);

  const loadTags = useCallback(() => {
    setTagsAttempted(true);
    setTagsLoading(true);
    setTagsError(null);
    fetch("/api/bison/client-tags")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setTags(Array.isArray(d.tags) ? d.tags : []))
      .catch((e) => setTagsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setTagsLoading(false));
  }, []);

  // Reset everything on each open; load tags once.
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setTagSearch("");
    setSelectedTag(null);
    setPreview(null);
    setPreviewError(null);
    setB2bChoice(SKIP);
    setB2cChoice(SKIP);
    setTagsAttempted(false);
  }, [open]);

  useEffect(() => {
    if (open && !tagsAttempted && !tagsLoading) loadTags();
  }, [open, tagsAttempted, tagsLoading, loadTags]);

  const filteredTags = useMemo(() => {
    const q = tagSearch.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter(
      (t) =>
        t.tag.toLowerCase().includes(q) ||
        (t.owner ?? "").toLowerCase().includes(q)
    );
  }, [tags, tagSearch]);

  function runPreview(tag: ClientTagRow) {
    setPreviewLoading(true);
    setPreviewError(null);
    setPreview(null);
    fetch("/api/bison/send-preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientTag: tag.tag,
        selectedIds: usingSelection ? selectedIds : undefined,
        filters: usingSelection ? undefined : filters,
      }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((d: SendPreview) => {
        setPreview(d);
        // Seed choices from the suggestion; skip a side that has no leads.
        setB2bChoice(d.b2b.count > 0 && d.b2b.suggested ? String(d.b2b.suggested.id) : SKIP);
        setB2cChoice(d.b2c.count > 0 && d.b2c.suggested ? String(d.b2c.suggested.id) : SKIP);
      })
      .catch((e) => setPreviewError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPreviewLoading(false));
  }

  function goToPreview() {
    if (!selectedTag) return;
    setStep(2);
    runPreview(selectedTag);
  }

  function findCampaign(side: PreviewSide, choice: string): PreviewCampaign | null {
    if (choice === SKIP) return null;
    return side.campaigns.find((c) => String(c.id) === choice) ?? null;
  }

  const b2bCampaign = preview ? findCampaign(preview.b2b, b2bChoice) : null;
  const b2cCampaign = preview ? findCampaign(preview.b2c, b2cChoice) : null;

  // A side sends only when it has leads AND a campaign chosen.
  const b2bSends = !!preview && preview.b2b.count > 0 && !!b2bCampaign;
  const b2cSends = !!preview && preview.b2c.count > 0 && !!b2cCampaign;
  const canConfirm = b2bSends || b2cSends;

  async function queueSide(
    side: "b2b" | "b2c",
    sideData: PreviewSide,
    campaign: PreviewCampaign
  ): Promise<void> {
    const res = await fetch("/api/bison/push-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaigns: [
          {
            id: campaign.id,
            name: campaign.name,
            instance_url: sideData.instance,
            workspace_name: campaign.workspace_name,
          },
        ],
        selectedIds: usingSelection ? selectedIds : undefined,
        filters: usingSelection ? undefined : filters,
        clientTag: preview!.clientTag,
        emailSide: side,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Failed to queue ${side} push`);
  }

  async function handleConfirm() {
    if (!preview || !canConfirm) return;
    setConfirming(true);
    const toastId = toast.loading("Queuing Bison pushes…");
    // Queue sequentially so a second-side failure isn't misreported as a total
    // failure when the first side already queued.
    const queued: string[] = [];
    try {
      if (b2bSends && b2bCampaign) { await queueSide("b2b", preview.b2b, b2bCampaign); queued.push(`${preview.b2b.count.toLocaleString()} business`); }
      if (b2cSends && b2cCampaign) { await queueSide("b2c", preview.b2c, b2cCampaign); queued.push(`${preview.b2c.count.toLocaleString()} personal`); }
      toast.success(
        `Queued ${queued.join(" + ")} leads for ${preview.clientTag} — progress on the Exports page`,
        { id: toastId }
      );
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to queue pushes";
      toast.error(
        queued.length ? `Queued ${queued.join(" + ")}, but the other side failed: ${msg}` : msg,
        { id: toastId }
      );
    } finally {
      setConfirming(false);
    }
  }

  const sourceLabel = usingSelection
    ? `${selectedIds.length.toLocaleString()} selected leads`
    : `${totalCount.toLocaleString()} filtered leads`;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send to Email Bison</DialogTitle>
        </DialogHeader>
        <p className="-mt-1 text-xs text-muted-foreground">
          Step {step} of 4 · {sourceLabel}
        </p>

        {/* ── Step 1: pick a client tag ── */}
        {step === 1 && (
          <div className="space-y-2">
            <Input
              placeholder="Search client tag or owner…"
              value={tagSearch}
              onChange={(e) => setTagSearch(e.target.value)}
              className="h-8 text-xs"
            />
            {tagsLoading ? (
              <p className="text-xs text-muted-foreground">Loading client tags…</p>
            ) : tagsError ? (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-xs text-destructive">Couldn&apos;t load tags: {tagsError}</p>
                <Button variant="outline" size="sm" className="h-7 shrink-0 text-xs" onClick={loadTags}>
                  Retry
                </Button>
              </div>
            ) : filteredTags.length === 0 ? (
              <p className="text-xs text-muted-foreground">No client tags found.</p>
            ) : (
              <div className="max-h-[45vh] space-y-1 overflow-y-auto rounded-md border p-1">
                {filteredTags.map((t) => {
                  const active = selectedTag?.tag === t.tag;
                  // Only clients with an instance mapping can be sent to; churned
                  // roster-only tags have no campaigns to route to.
                  const disabled = !t.sendable;
                  return (
                    <button
                      key={t.tag}
                      type="button"
                      disabled={disabled}
                      title={disabled ? "No Bison instance mapping — add this client to the groups sheet to enable sending." : undefined}
                      onClick={() => !disabled && setSelectedTag(t)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors ${
                        disabled
                          ? "cursor-not-allowed opacity-45"
                          : active
                          ? "bg-primary/10 ring-1 ring-primary/40"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <span className="font-medium">{t.tag}</span>
                      {t.owner && <span className="text-muted-foreground">· {t.owner}</span>}
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {t.group_no ? `grp ${t.group_no}` : "unmapped"}
                      </span>
                      {t.churned && (
                        <Badge variant="destructive" className="shrink-0">
                          Churned
                        </Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── Step 2: split preview ── */}
        {step === 2 && (
          <div className="space-y-3">
            {previewLoading ? (
              <p className="text-xs text-muted-foreground">Computing business vs personal split…</p>
            ) : previewError ? (
              <div className="flex items-center gap-2">
                <p className="flex-1 text-xs text-destructive">Preview failed: {previewError}</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => selectedTag && runPreview(selectedTag)}
                >
                  Retry
                </Button>
              </div>
            ) : preview ? (
              <>
                <p className="text-xs text-muted-foreground">
                  Client <span className="font-medium text-foreground">{preview.clientTag}</span> —
                  leads split by email domain:
                </p>
                <SplitCard label="Business (B2B)" side={preview.b2b} />
                <SplitCard label="Personal (B2C)" side={preview.b2c} />
                {preview.b2b.count === 0 && preview.b2c.count === 0 && (
                  <p className="text-xs text-destructive">
                    No eligible leads to send for this selection.
                  </p>
                )}
              </>
            ) : null}
          </div>
        )}

        {/* ── Step 3: pick a campaign per side ── */}
        {step === 3 && preview && (
          <div className="space-y-4">
            <CampaignPicker
              label="Business (B2B)"
              side={preview.b2b}
              value={b2bChoice}
              onChange={setB2bChoice}
            />
            <CampaignPicker
              label="Personal (B2C)"
              side={preview.b2c}
              value={b2cChoice}
              onChange={setB2cChoice}
            />
            {!canConfirm && (
              <p className="text-[11px] text-destructive">
                Pick a campaign for at least one side with leads.
              </p>
            )}
          </div>
        )}

        {/* ── Step 4: reconfirm ── */}
        {step === 4 && preview && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Confirm the push for client{" "}
              <span className="font-medium text-foreground">{preview.clientTag}</span>:
            </p>
            {b2bSends && b2bCampaign ? (
              <SummaryRow
                count={preview.b2b.count}
                kind="business"
                campaignName={b2bCampaign.name ?? `Campaign ${b2bCampaign.id}`}
                instance={preview.b2b.instance}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Business (B2B): not sending.</p>
            )}
            {b2cSends && b2cCampaign ? (
              <SummaryRow
                count={preview.b2c.count}
                kind="personal"
                campaignName={b2cCampaign.name ?? `Campaign ${b2cCampaign.id}`}
                instance={preview.b2c.instance}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Personal (B2C): not sending.</p>
            )}
            <p className="text-[10px] text-muted-foreground">
              Two background push batches are queued (one per side). Progress shows on the Exports page.
            </p>
          </div>
        )}

        <DialogFooter className="flex-row justify-between gap-2 sm:justify-between">
          <Button
            variant="outline"
            onClick={() => (step === 1 ? onClose() : setStep(step - 1))}
            disabled={confirming}
          >
            {step === 1 ? "Cancel" : "Back"}
          </Button>
          {step === 1 && (
            <Button onClick={goToPreview} disabled={!selectedTag}>
              Next
            </Button>
          )}
          {step === 2 && (
            <Button
              onClick={() => setStep(3)}
              disabled={
                previewLoading ||
                !!previewError ||
                !preview ||
                (preview.b2b.count === 0 && preview.b2c.count === 0)
              }
            >
              Next
            </Button>
          )}
          {step === 3 && (
            <Button onClick={() => setStep(4)} disabled={!canConfirm}>
              Review
            </Button>
          )}
          {step === 4 && (
            <Button onClick={handleConfirm} disabled={confirming || !canConfirm}>
              {confirming ? "Queuing…" : "Queue pushes"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SplitCard({ label, side }: { label: string; side: PreviewSide }) {
  return (
    <div className="rounded-xl border p-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="ml-auto text-[15px] font-semibold tabular-nums">
          {side.count.toLocaleString()}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        {side.instance}
        {side.error ? ` · campaigns unavailable: ${side.error}` : ""}
      </p>
    </div>
  );
}

function CampaignPicker({
  label,
  side,
  value,
  onChange,
}: {
  label: string;
  side: PreviewSide;
  value: string;
  onChange: (v: string) => void;
}) {
  const disabled = side.count === 0;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-[11px] text-muted-foreground">
          {side.count.toLocaleString()} lead{side.count === 1 ? "" : "s"} · {side.instance}
        </span>
      </div>
      {disabled ? (
        <p className="text-[11px] text-muted-foreground">No leads on this side — nothing to send.</p>
      ) : side.campaigns.length === 0 ? (
        <p className="text-[11px] text-destructive">
          No campaigns on {side.instance}
          {side.error ? ` (${side.error})` : ""}.
        </p>
      ) : (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="h-9 w-full text-[13px]">
            <SelectValue placeholder="Pick a campaign" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SKIP} className="text-[13px]">
              — Don&apos;t send this side —
            </SelectItem>
            {side.campaigns.map((c) => (
              <SelectItem key={String(c.id)} value={String(c.id)} className="text-[13px]">
                {c.name ?? `Campaign ${c.id}`}
                {side.suggested && String(side.suggested.id) === String(c.id) ? "  (suggested)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function SummaryRow({
  count,
  kind,
  campaignName,
  instance,
}: {
  count: number;
  kind: string;
  campaignName: string;
  instance: string;
}) {
  return (
    <div className="rounded-xl border p-3">
      <p className="text-[13px]">
        <span className="font-semibold tabular-nums">{count.toLocaleString()}</span> {kind} leads →{" "}
        <span className="font-medium">{campaignName}</span>
      </p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">{instance}</p>
    </div>
  );
}
