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
import { mainCampaignsOnly } from "@/lib/bison/campaigns";
import type { FilterState } from "@/types/filters";
import { suggestBucketFromName } from "@/lib/bison/esp-bucket";

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

// (routing helpers use suggestBucketFromName from src/lib/bison/esp-bucket)

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

// ESP routing (client req #9): each side can either route leads across three
// bucket campaigns by email provider, or send everyone to a single campaign.
type BucketKey = "outlook" | "seg" | "default";
const BUCKETS: { key: BucketKey; label: string; hint: string }[] = [
  { key: "outlook", label: "Outlook", hint: "Microsoft / Outlook mailboxes" },
  { key: "seg", label: "Security gateways", hint: "Mimecast, Proofpoint, Barracuda…" },
  { key: "default", label: "Google + Custom", hint: "Google, custom servers, everything else" },
];
interface SideChoice {
  mode: "route" | "single";
  single: string; // campaign id or SKIP
  buckets: Record<BucketKey, string>; // campaign id or SKIP per bucket
}
const emptyChoice = (): SideChoice => ({
  mode: "single",
  single: SKIP,
  buckets: { outlook: SKIP, seg: SKIP, default: SKIP },
});

// Pre-fill from campaign names; routing turns on automatically when at least
// two buckets have a recognizable campaign ("…Outlook…", "…SEGs…", "…Google…").
function seedChoice(side: PreviewSide): SideChoice {
  const sendable = mainCampaignsOnly(side.campaigns);
  const buckets: Record<BucketKey, string> = { outlook: SKIP, seg: SKIP, default: SKIP };
  for (const c of sendable) {
    const b = suggestBucketFromName(c.name);
    if (b && buckets[b] === SKIP) buckets[b] = String(c.id);
  }
  const matched = (Object.keys(buckets) as BucketKey[]).filter((k) => buckets[k] !== SKIP).length;
  if (side.count > 0 && matched >= 2) return { mode: "route", single: SKIP, buckets };
  return {
    mode: "single",
    single: side.count > 0 && side.suggested ? String(side.suggested.id) : SKIP,
    buckets,
  };
}

function choiceSends(side: PreviewSide, choice: SideChoice): boolean {
  if (side.count === 0) return false;
  if (choice.mode === "single") return choice.single !== SKIP;
  return (Object.keys(choice.buckets) as BucketKey[]).some((k) => choice.buckets[k] !== SKIP);
}

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

  // Step 3 — campaign choices per side (routing or single campaign)
  const [b2bChoice, setB2bChoice] = useState<SideChoice>(emptyChoice());
  const [b2cChoice, setB2cChoice] = useState<SideChoice>(emptyChoice());

  // Step 3 — export amount + per-tag accounting (client req #8)
  const [amountChoice, setAmountChoice] = useState<string>("full");
  const [amountOther, setAmountOther] = useState("");
  const [optIncludePushed, setOptIncludePushed] = useState(false);
  const [optOnlyNew, setOptOnlyNew] = useState(false);
  const [optRetryFailed, setOptRetryFailed] = useState(false);
  const [stats, setStats] = useState<{
    matching: number; alreadyPushed: number; notPushed: number;
    newSinceLast: number; failedForTag: number; lastExportAt: string | null;
  } | null>(null);
  const maxLeads =
    amountChoice === "full" ? undefined :
    amountChoice === "other" ? (parseInt(amountOther, 10) > 0 ? parseInt(amountOther, 10) : undefined) :
    parseInt(amountChoice, 10);

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
    setB2bChoice(emptyChoice());
    setB2cChoice(emptyChoice());
    setTagsAttempted(false);
    setAmountChoice("full");
    setAmountOther("");
    setOptIncludePushed(false);
    setOptOnlyNew(false);
    setOptRetryFailed(false);
    setStats(null);
  }, [open]);

  // Per-tag push accounting, fetched when the campaign step opens.
  useEffect(() => {
    if (step !== 3 || !preview) return;
    setStats(null);
    fetch("/api/bison/push-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientTag: preview.clientTag,
        selectedIds: usingSelection ? selectedIds : undefined,
        filters: usingSelection ? undefined : filters,
      }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setStats(d))
      .catch(() => {}); // stats are informative — sending works without them
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, preview?.clientTag]);

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
        // Seed choices — routing auto-enables when the side has recognizable
        // Outlook/SEG/Google campaigns; otherwise fall back to the suggestion.
        setB2bChoice(seedChoice(d.b2b));
        setB2cChoice(seedChoice(d.b2c));
      })
      .catch((e) => setPreviewError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPreviewLoading(false));
  }

  function goToPreview() {
    if (!selectedTag) return;
    setStep(2);
    runPreview(selectedTag);
  }

  function findCampaign(side: PreviewSide, id: string): PreviewCampaign | null {
    if (id === SKIP) return null;
    return side.campaigns.find((c) => String(c.id) === id) ?? null;
  }

  // The campaigns a side's choice resolves to (with routing buckets attached).
  function chosenCampaigns(side: PreviewSide, choice: SideChoice) {
    if (choice.mode === "single") {
      const c = findCampaign(side, choice.single);
      return c ? [{ campaign: c, bucket: undefined as BucketKey | undefined }] : [];
    }
    return (Object.keys(choice.buckets) as BucketKey[])
      .map((k) => ({ campaign: findCampaign(side, choice.buckets[k]), bucket: k as BucketKey | undefined }))
      .filter((x): x is { campaign: PreviewCampaign; bucket: BucketKey } => !!x.campaign);
  }

  const b2bSends = !!preview && choiceSends(preview.b2b, b2bChoice);
  const b2cSends = !!preview && choiceSends(preview.b2c, b2cChoice);
  const canConfirm = b2bSends || b2cSends;

  async function queueSide(
    side: "b2b" | "b2c",
    sideData: PreviewSide,
    choice: SideChoice,
    force = false
  ): Promise<void> {
    const res = await fetch("/api/bison/push-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        campaigns: chosenCampaigns(sideData, choice).map(({ campaign, bucket }) => ({
          id: campaign.id,
          name: campaign.name,
          instance_url: sideData.instance,
          workspace_name: campaign.workspace_name,
          ...(choice.mode === "route" && bucket ? { bucket } : {}),
        })),
        selectedIds: usingSelection ? selectedIds : undefined,
        filters: usingSelection ? undefined : filters,
        clientTag: preview!.clientTag,
        emailSide: side,
        maxLeads,
        pushOptions: {
          includeAlreadyPushed: optIncludePushed,
          onlyNewSinceLast: optOnlyNew,
          retryFailed: optRetryFailed,
        },
        force,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Double-push guard — surface the server's explanation and let the user
      // decide (this is the exact accident that pushed CWSJ-OS twice).
      if (window.confirm(`${data.error ?? "A recent push for this client already exists."}`)) {
        return queueSide(side, sideData, choice, true);
      }
      throw Object.assign(new Error(`${side} push skipped — already pushed recently`), { skipped: true });
    }
    if (!res.ok) throw new Error(data.error ?? `Failed to queue ${side} push`);
  }

  async function handleConfirm() {
    if (!preview || !canConfirm) return;
    setConfirming(true);
    const toastId = toast.loading("Queuing Bison pushes…");
    // Queue sequentially so a second-side failure isn't misreported as a total
    // failure when the first side already queued.
    const queued: string[] = [];
    const skipped: string[] = [];
    const trySide = async (label: string, fn: () => Promise<void>) => {
      try { await fn(); return true; }
      catch (e) {
        if ((e as { skipped?: boolean }).skipped) { skipped.push(label); return false; }
        throw e;
      }
    };
    try {
      if (b2bSends && await trySide("business", () => queueSide("b2b", preview.b2b, b2bChoice))) {
        queued.push(`${preview.b2b.count.toLocaleString()} business`);
      }
      if (b2cSends && await trySide("personal", () => queueSide("b2c", preview.b2c, b2cChoice))) {
        queued.push(`${preview.b2c.count.toLocaleString()} personal`);
      }
      if (queued.length) {
        toast.success(
          `Queued ${queued.join(" + ")} leads for ${preview.clientTag}${skipped.length ? ` (${skipped.join(", ")} skipped — recent push exists)` : ""} — progress on the Exports page`,
          { id: toastId }
        );
      } else {
        toast.info(`Nothing queued — ${skipped.join(", ")} already pushed recently`, { id: toastId });
      }
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

        {/* ── Step 3: pick a campaign per side + amount & history ── */}
        {step === 3 && preview && (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
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

            {/* Per-tag accounting (req #8): what's been pushed before */}
            <div className="rounded-xl border p-3">
              <p className="mb-1 text-[12px] font-medium">Export history — {preview.clientTag}</p>
              {stats ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                  <span className="text-muted-foreground">Matching contacts</span>
                  <span className="text-right font-medium tabular-nums">{stats.matching.toLocaleString()}</span>
                  <span className="text-muted-foreground">Already pushed for {preview.clientTag}</span>
                  <span className="text-right font-medium tabular-nums">{stats.alreadyPushed.toLocaleString()}</span>
                  <span className="text-muted-foreground">Not yet pushed</span>
                  <span className="text-right font-medium tabular-nums">{stats.notPushed.toLocaleString()}</span>
                  <span className="text-muted-foreground">New since last export{stats.lastExportAt ? ` (${new Date(stats.lastExportAt).toLocaleDateString()})` : ""}</span>
                  <span className="text-right font-medium tabular-nums">{stats.newSinceLast.toLocaleString()}</span>
                  {stats.failedForTag > 0 && (
                    <>
                      <span className="text-muted-foreground">Previously failed (retryable)</span>
                      <span className="text-right font-medium tabular-nums">{stats.failedForTag.toLocaleString()}</span>
                    </>
                  )}
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">Loading push history…</p>
              )}
              <div className="mt-2 space-y-1.5">
                <label className="flex items-center gap-2 text-[11px]">
                  <input type="checkbox" checked={optIncludePushed} onChange={(e) => setOptIncludePushed(e.target.checked)} />
                  Include contacts already pushed for this client
                </label>
                <label className="flex items-center gap-2 text-[11px]">
                  <input type="checkbox" checked={optOnlyNew} onChange={(e) => setOptOnlyNew(e.target.checked)} />
                  Only contacts added since the last export
                </label>
                <label className="flex items-center gap-2 text-[11px]">
                  <input type="checkbox" checked={optRetryFailed} onChange={(e) => setOptRetryFailed(e.target.checked)} />
                  Retry contacts that previously failed
                </label>
              </div>
            </div>

            {/* Export amount (req #8) */}
            <div>
              <p className="mb-1 text-[12px] font-medium">Export amount</p>
              <div className="flex items-center gap-2">
                <Select value={amountChoice} onValueChange={setAmountChoice}>
                  <SelectTrigger className="h-9 w-full text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {["5000", "7500", "10000", "12500"].map((v) => (
                      <SelectItem key={v} value={v} className="text-[13px]">
                        {parseInt(v, 10).toLocaleString()} leads
                      </SelectItem>
                    ))}
                    <SelectItem value="full" className="text-[13px]">Full remaining list</SelectItem>
                    <SelectItem value="other" className="text-[13px]">Other…</SelectItem>
                  </SelectContent>
                </Select>
                {amountChoice === "other" && (
                  <Input
                    type="number"
                    min={1}
                    placeholder="Amount"
                    value={amountOther}
                    onChange={(e) => setAmountOther(e.target.value)}
                    className="h-9 w-28 text-[13px]"
                  />
                )}
              </div>
              {maxLeads != null && (
                <p className="mt-1 px-1 text-[10px] text-muted-foreground">
                  Applied per side — up to {maxLeads.toLocaleString()} business + {maxLeads.toLocaleString()} personal.
                </p>
              )}
            </div>

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
              <span className="font-medium text-foreground">{preview.clientTag}</span>
              {selectedTag?.group_no ? <> · destination group {selectedTag.group_no}</> : null}
              {" · "}
              <span className="font-medium text-foreground">
                {((b2bSends ? preview.b2b.count : 0) + (b2cSends ? preview.b2c.count : 0)).toLocaleString()}
              </span>{" "}
              leads total:
            </p>
            {b2bSends ? (
              <SummaryRow
                count={preview.b2b.count}
                kind="business"
                choice={b2bChoice}
                campaigns={chosenCampaigns(preview.b2b, b2bChoice)}
                instance={preview.b2b.instance}
              />
            ) : (
              <p className="text-xs text-muted-foreground">Business (B2B): not sending.</p>
            )}
            {b2cSends ? (
              <SummaryRow
                count={preview.b2c.count}
                kind="personal"
                choice={b2cChoice}
                campaigns={chosenCampaigns(preview.b2c, b2cChoice)}
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
  value: SideChoice;
  onChange: (v: SideChoice) => void;
}) {
  const disabled = side.count === 0;
  // Nurture campaigns are ALWAYS excluded (client rule 2026-08-20: the database
  // only ever sends to main campaigns). This was previously a default with a
  // "show nurture campaigns" escape hatch; the escape hatch is gone, and
  // /api/bison/push-batch now rejects them server-side regardless.
  const sendable = mainCampaignsOnly(side.campaigns);
  const hidden = side.campaigns.length - sendable.length;

  const campaignSelect = (val: string, set: (id: string) => void, skipLabel: string) => (
    <Select value={val} onValueChange={set}>
      <SelectTrigger className="h-9 w-full text-[13px]">
        <SelectValue placeholder="Pick a campaign" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={SKIP} className="text-[13px]">{skipLabel}</SelectItem>
        {sendable.map((c) => (
          <SelectItem key={String(c.id)} value={String(c.id)} className="text-[13px]">
            {c.name ?? `Campaign ${c.id}`}
            {side.suggested && String(side.suggested.id) === String(c.id) ? "  (suggested)" : ""}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        <span className="text-[11px] text-muted-foreground">
          {side.count.toLocaleString()} lead{side.count === 1 ? "" : "s"} · {side.instance}
        </span>
        {!disabled && side.campaigns.length > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...value, mode: value.mode === "route" ? "single" : "route" })}
            className="ml-auto text-[11px] font-medium text-primary hover:underline"
          >
            {value.mode === "route" ? "Use one campaign" : "Route by email provider"}
          </button>
        )}
      </div>
      {disabled ? (
        <p className="text-[11px] text-muted-foreground">No leads on this side — nothing to send.</p>
      ) : side.campaigns.length === 0 ? (
        <p className="text-[11px] text-destructive">
          No campaigns on {side.instance}
          {side.error ? ` (${side.error})` : ""}.
        </p>
      ) : value.mode === "route" ? (
        <div className="space-y-2">
          {BUCKETS.map((b) => (
            <div key={b.key}>
              <p className="mb-0.5 px-1 text-[11px] font-medium text-muted-foreground">
                {b.label} <span className="font-normal">— {b.hint}</span>
              </p>
              {campaignSelect(
                value.buckets[b.key],
                (id) => onChange({ ...value, buckets: { ...value.buckets, [b.key]: id } }),
                "— Skip these leads —"
              )}
            </div>
          ))}
          <p className="px-1 text-[10px] text-muted-foreground">
            Each lead goes ONLY to the campaign matching its email provider. Leads whose bucket is skipped are not sent.
          </p>
        </div>
      ) : (
        campaignSelect(value.single, (id) => onChange({ ...value, single: id }), "— Don't send this side —")
      )}
      {hidden > 0 && (
        <p className="mt-1 text-[10px] text-muted-foreground" title="Nurture campaigns are populated from replies inside Bison, never from a push out of here.">
          {hidden} nurture campaign{hidden === 1 ? "" : "s"} not shown — leads only go to main campaigns
        </p>
      )}
    </div>
  );
}

function SummaryRow({
  count,
  kind,
  choice,
  campaigns,
  instance,
}: {
  count: number;
  kind: string;
  choice: SideChoice;
  campaigns: { campaign: PreviewCampaign; bucket?: BucketKey }[];
  instance: string;
}) {
  const bucketLabel = (k?: BucketKey) => BUCKETS.find((b) => b.key === k)?.label ?? "";
  return (
    <div className="rounded-xl border p-3">
      {choice.mode === "route" ? (
        <>
          <p className="text-[13px]">
            <span className="font-semibold tabular-nums">{count.toLocaleString()}</span> {kind} leads,
            routed by email provider:
          </p>
          <ul className="mt-1 space-y-0.5">
            {campaigns.map(({ campaign, bucket }) => (
              <li key={String(campaign.id)} className="text-[12px]">
                <span className="text-muted-foreground">{bucketLabel(bucket)} →</span>{" "}
                <span className="font-medium">{campaign.name ?? `Campaign ${campaign.id}`}</span>
              </li>
            ))}
          </ul>
          {(Object.keys(choice.buckets) as BucketKey[]).filter((k) => choice.buckets[k] === SKIP).length > 0 && (
            <p className="mt-1 text-[10px] text-amber-600">
              {(Object.keys(choice.buckets) as BucketKey[])
                .filter((k) => choice.buckets[k] === SKIP)
                .map((k) => bucketLabel(k))
                .join(", ")}{" "}
              leads will be skipped (no campaign chosen).
            </p>
          )}
        </>
      ) : (
        <p className="text-[13px]">
          <span className="font-semibold tabular-nums">{count.toLocaleString()}</span> {kind} leads →{" "}
          <span className="font-medium">{campaigns[0]?.campaign.name ?? "?"}</span>
        </p>
      )}
      <p className="mt-0.5 text-[11px] text-muted-foreground">{instance}</p>
    </div>
  );
}
