"use client";

import { useState } from "react";
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

/** Fields visible in the leads table UI */
const VISIBLE_KEYS = new Set([
  "first_name",
  "last_name",
  "email",
  "source",
  "title",
  "company",
  "general_industry",
  "specific_industry",
  "phone",
  "company_size",
  "annual_revenue",
  "esp",
  "website",
]);

/** Fields only visible on export */
const EXPORT_ONLY_KEYS = new Set([
  "domain",
  "city",
  "state",
  "country",
  "company_overview",
  "person_linkedin",
  "company_linkedin",
  "tags",
  "notes",
  "question",
  "address",
  "company_phone",
  "google_maps_url",
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
  "phone",
  "source",
  "general_industry",
  "specific_industry",
  "company_size",
  "annual_revenue",
  "esp",
  "website",
];

interface ColumnSelectorProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (columns: string[], limit: number | null, rangeFrom?: number, rangeTo?: number) => void;
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
              onConfirm(Array.from(selected), limit && limit > 0 ? limit : null, from, to);
            }}
            disabled={selected.size === 0}
          >
            Export ({selected.size} columns)
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
