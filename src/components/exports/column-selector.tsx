"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LEAD_FIELDS } from "@/lib/uploads/constants";
import { toast } from "sonner";

interface BisonCampaign { id: number | string; name?: string; instance_url?: string; workspace_name?: string }
export type ExportDestination = "csv" | "bison";

/** Fields visible in the leads table UI */
const VISIBLE_KEYS = new Set([
  "first_name",
  "last_name",
  "email",
  "email_type",
  "source",
  "title",
  "company",
  "city",
  "state",
  "esp",
  "category",
  "subcategory",
  "validation_status",
]);

/** Fields only visible on export */
const EXPORT_ONLY_KEYS = new Set([
  "domain",
  "address",
  "street",
  "postal_code",
  "company_phone",
  "google_maps_url",
  "question",
  "notes",
  "tags",
  "additional_category",
  "category_source",
  "category_confidence",
  "is_bounced",
  "workspace_name",
  "emails_sent",
  "opens",
  "replies",
  "bounces",
  "created_at",
  "updated_at",
]);

const VISIBLE_FIELDS = LEAD_FIELDS.filter((f) => VISIBLE_KEYS.has(f.key));
const EXPORT_ONLY_FIELDS = LEAD_FIELDS.filter((f) => EXPORT_ONLY_KEYS.has(f.key));
const OTHER_FIELDS = LEAD_FIELDS.filter(
  (f) => !VISIBLE_KEYS.has(f.key) && !EXPORT_ONLY_KEYS.has(f.key)
);

const DEFAULT_COLUMNS = [
  "email",
  "first_name",
  "last_name",
  "title",
  "company",
  "city",
  "state",
  "source",
  "esp",
  "email_type",
  "domain",
];

interface ColumnSelectorProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (
    columns: string[],
    limit: number | null,
    rangeFrom: number | undefined,
    rangeTo: number | undefined,
    destination: ExportDestination,
    campaign: BisonCampaign | null,
  ) => void;
  totalCount?: number;
  exportType?: "filtered" | "selected";
}

export function ColumnSelector({
  open,
  onClose,
  onConfirm,
  totalCount,
  exportType = "filtered",
}: ColumnSelectorProps) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(DEFAULT_COLUMNS)
  );
  const [rangeFromStr, setRangeFromStr] = useState("");
  const [rangeToStr, setRangeToStr] = useState("");
  const [destination, setDestination] = useState<ExportDestination>("csv");
  const [campaigns, setCampaigns] = useState<BisonCampaign[]>([]);
  const [campaignId, setCampaignId] = useState<string>("");
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);

  // Load live Bison campaigns the first time the Bison destination is chosen.
  useEffect(() => {
    if (destination !== "bison" || campaigns.length > 0 || campaignsLoading) return;
    setCampaignsLoading(true);
    setCampaignsError(null);
    fetch("/api/bison/campaigns")
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => setCampaigns(Array.isArray(d.campaigns) ? d.campaigns : []))
      .catch((e) => setCampaignsError(e.message))
      .finally(() => setCampaignsLoading(false));
  }, [destination, campaigns.length, campaignsLoading]);

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAll() {
    setSelected(new Set(LEAD_FIELDS.map((f) => f.key)));
  }

  function deselectAll() {
    setSelected(new Set());
  }

  function FieldGroup({ title, fields }: { title: string; fields: typeof LEAD_FIELDS }) {
    if (fields.length === 0) return null;
    return (
      <div>
        <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1 px-1">
          {title}
        </p>
        <div className="grid grid-cols-2 gap-1">
          {fields.map((field) => (
            <label
              key={field.key}
              className="flex items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={selected.has(field.key)}
                onChange={() => toggle(field.key)}
                className="rounded"
              />
              {field.label}
            </label>
          ))}
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Select Export Columns</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-1">
          {exportType === "selected"
            ? `Exporting ${totalCount?.toLocaleString() ?? 0} selected leads`
            : `Exporting all ${totalCount?.toLocaleString() ?? 0} filtered leads`}
        </p>

        {/* Destination — download a CSV or push straight into a Bison campaign */}
        <div className="mb-1">
          <div className="inline-flex w-full rounded-lg bg-muted p-0.5">
            {(["csv", "bison"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDestination(d)}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-all ${
                  destination === d ? "bg-background shadow-sm" : "text-muted-foreground"
                }`}
              >
                {d === "csv" ? "Download CSV" : "Push to Bison campaign"}
              </button>
            ))}
          </div>
        </div>

        {destination === "bison" && (
          <div className="mb-2">
            <label className="text-xs text-muted-foreground mb-1 block">Bison campaign</label>
            {campaignsLoading ? (
              <p className="text-xs text-muted-foreground">Loading campaigns…</p>
            ) : campaignsError ? (
              <p className="text-xs text-destructive">Couldn&apos;t load campaigns: {campaignsError}</p>
            ) : (
              <select
                value={campaignId}
                onChange={(e) => setCampaignId(e.target.value)}
                className="h-8 w-full rounded-md border bg-background px-2 text-xs"
              >
                <option value="">Select a campaign…</option>
                {campaigns.map((c) => (
                  <option key={String(c.id)} value={String(c.id)}>
                    {c.name ?? `Campaign ${c.id}`}{c.workspace_name ? ` — ${c.workspace_name}` : ""}
                  </option>
                ))}
              </select>
            )}
            <p className="text-[10px] text-muted-foreground mt-1">
              Leads are created in Bison, then attached to this campaign. Column selection below is ignored for Bison pushes.
            </p>
          </div>
        )}
        <div className="flex gap-2 mb-2">
          <Button variant="outline" size="sm" className="text-xs" onClick={selectAll}>
            Select All
          </Button>
          <Button variant="outline" size="sm" className="text-xs" onClick={deselectAll}>
            Deselect All
          </Button>
        </div>
        <div className="mb-3">
          <label className="text-xs text-muted-foreground mb-1 block">
            Lead range to export
            {totalCount ? ` (${totalCount.toLocaleString()} available)` : ""}
          </label>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              placeholder="From (e.g. 1)"
              value={rangeFromStr}
              onChange={(e) => setRangeFromStr(e.target.value)}
              className="h-8 text-xs w-32"
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              type="number"
              min={1}
              placeholder={`To (e.g. ${totalCount?.toLocaleString() ?? "20000"})`}
              value={rangeToStr}
              onChange={(e) => setRangeToStr(e.target.value)}
              className="h-8 text-xs w-32"
            />
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">
            Leave blank to export all. Example: 1–20000, then 20001–40000.
          </p>
        </div>
        <div className="space-y-3 max-h-[50vh] overflow-y-auto">
          <FieldGroup title="Visible Fields" fields={VISIBLE_FIELDS} />
          <FieldGroup title="Additional Fields (export only)" fields={EXPORT_ONLY_FIELDS} />
          {OTHER_FIELDS.length > 0 && (
            <FieldGroup title="Other" fields={OTHER_FIELDS} />
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const from = rangeFromStr ? parseInt(rangeFromStr, 10) : undefined;
              const to = rangeToStr ? parseInt(rangeToStr, 10) : undefined;
              const limit = from && to ? to - from + 1 : to ? to : null;
              if (destination === "bison" && !campaignId) {
                toast.error("Pick a Bison campaign first");
                return;
              }
              const campaign = destination === "bison"
                ? campaigns.find((c) => String(c.id) === campaignId) ?? null
                : null;
              onConfirm(Array.from(selected), limit && limit > 0 ? limit : null, from, to, destination, campaign);
            }}
            disabled={destination === "csv" ? selected.size === 0 : !campaignId}
          >
            {destination === "csv" ? `Export (${selected.size} columns)` : "Push to Bison"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
