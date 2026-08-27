"use client";

import { useEffect, useMemo, useState } from "react";
import { Ban, ExternalLink, Pencil, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LeadHistory } from "./lead-history";
import { SuppressLeadsDialog } from "./suppress-leads-dialog";
import { useRole, useHasPermission } from "@/lib/context/role-context";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type { Lead } from "@/types/database";

interface LeadDetailPanelProps {
  lead: Lead | null;
  open: boolean;
  onClose: () => void;
  onDeleted?: (id: string) => void;
  onUpdated?: (lead: Lead) => void;
}

// Fields the edit form exposes, in the order they appear in each section.
// Must stay a subset of EDITABLE_FIELDS in /api/leads/edit — the route rejects
// anything else, so a typo here fails loudly instead of silently writing.
type EditableKey =
  | "first_name" | "last_name" | "title" | "email"
  | "company" | "company_phone" | "domain" | "website"
  | "category" | "subcategory" | "additional_category"
  | "street" | "city" | "state" | "postal_code" | "address"
  | "notes" | "question" | "tags";

function DetailRow({
  label,
  value,
  href,
}: {
  label: string;
  value: string | null | undefined;
  href?: string;
}) {
  if (!value) return null;
  return (
    <div className="flex items-start justify-between gap-2 px-4 py-2.5 transition-colors hover:bg-muted/40">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 truncate text-right text-[13px] font-medium text-primary hover:opacity-80"
        >
          {value}
          <ExternalLink className="size-3 shrink-0" strokeWidth={2} />
        </a>
      ) : (
        <span className="truncate text-right text-[13px] font-medium">{value}</span>
      )}
    </div>
  );
}

// Editable counterpart of DetailRow — always rendered while editing, even when
// the value is empty, so blank fields can be filled in.
function EditRow({
  label,
  field,
  draft,
  onChange,
  placeholder,
  multiline,
}: {
  label: string;
  field: EditableKey;
  draft: Record<string, string>;
  onChange: (field: EditableKey, value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <label className="shrink-0 text-[13px] text-muted-foreground" htmlFor={`edit-${field}`}>
        {label}
      </label>
      {multiline ? (
        <textarea
          id={`edit-${field}`}
          value={draft[field] ?? ""}
          onChange={(e) => onChange(field, e.target.value)}
          placeholder={placeholder}
          rows={3}
          className="w-[65%] resize-y rounded-xl bg-background px-3 py-2 text-[13px] outline-none ring-1 ring-border focus:ring-2 focus:ring-ring/40"
        />
      ) : (
        <Input
          id={`edit-${field}`}
          value={draft[field] ?? ""}
          onChange={(e) => onChange(field, e.target.value)}
          placeholder={placeholder}
          className="h-8 w-[65%] text-[13px]"
        />
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h4 className="px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {title}
      </h4>
      <div className="overflow-hidden rounded-2xl bg-muted/40 [&>*:not(:first-child)]:border-t [&>*:not(:first-child)]:border-border/40">
        {children}
      </div>
    </section>
  );
}

function formatTitle(raw: string): string {
  let titles: string[] = [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      titles = JSON.parse(trimmed);
    } catch {
      titles = trimmed
        .slice(1, -1)
        .split(",")
        .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
    }
  } else {
    titles = [raw];
  }
  return titles
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) =>
      t
        .split(" ")
        .map((w) => (w === w.toUpperCase() && w.length <= 4 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
        .join(" ")
    )
    .join(", ");
}

export function LeadDetailPanel({
  lead,
  open,
  onClose,
  onDeleted,
  onUpdated,
}: LeadDetailPanelProps) {
  const role = useRole();
  const isOwner = role === "owner";
  const canEdit = useHasPermission("manager");
  const [deleting, setDeleting] = useState(false);
  const [suppressOpen, setSuppressOpen] = useState(false);

  // The panel keeps its own copy so a save is reflected immediately, whether or
  // not the parent list refetches.
  const [current, setCurrent] = useState<Lead | null>(lead);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [historyVersion, setHistoryVersion] = useState(0);

  useEffect(() => {
    setCurrent(lead);
    setEditing(false);
  }, [lead]);

  const fullName = useMemo(
    () => `${current?.first_name ?? ""} ${current?.last_name ?? ""}`.trim() || "Unknown",
    [current?.first_name, current?.last_name]
  );

  function startEditing() {
    if (!current) return;
    const l = current as unknown as Record<string, unknown>;
    const keys: EditableKey[] = [
      "first_name", "last_name", "title", "email",
      "company", "company_phone", "domain", "website",
      "category", "subcategory", "additional_category",
      "street", "city", "state", "postal_code", "address",
      "notes", "question", "tags",
    ];
    const next: Record<string, string> = {};
    for (const k of keys) next[k] = l[k] == null ? "" : String(l[k]);
    setDraft(next);
    setEditing(true);
  }

  function onFieldChange(field: EditableKey, value: string) {
    setDraft((d) => ({ ...d, [field]: value }));
  }

  async function handleSave() {
    if (!current) return;
    // Send only what actually changed — the route diffs again server-side, but
    // this keeps the payload (and the history note) honest.
    const l = current as unknown as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(draft)) {
      const before = l[key] == null ? "" : String(l[key]);
      if (before !== value) fields[key] = value;
    }
    if (Object.keys(fields).length === 0) {
      setEditing(false);
      toast.info("No changes to save");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/leads/edit", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: current.id, fields }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      setCurrent(data.lead as Lead);
      onUpdated?.(data.lead as Lead);
      setEditing(false);
      setHistoryVersion((v) => v + 1);
      const names = Object.keys(fields);
      toast.success(`Saved ${names.length} change${names.length === 1 ? "" : "s"}: ${names.join(", ")}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!current) return;
    setDeleting(true);
    const supabase = createClient();
    const { error } = await supabase.from("leads").delete().eq("id", current.id);
    setDeleting(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Lead deleted");
      onDeleted?.(current.id);
      onClose();
    }
  }

  if (!current) return null;

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-[700px] sm:w-[800px] max-w-[90vw] sm:max-w-[800px] overflow-y-auto p-6">
        <SheetHeader>
          <div className="flex items-start justify-between gap-4 pr-8">
            <div>
              <SheetTitle className="text-left">{fullName}</SheetTitle>
              {current.title && (
                <p className="text-sm text-muted-foreground">{formatTitle(current.title)}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {canEdit && !editing && (
                <Button variant="ghost" size="sm" className="h-8" onClick={startEditing}>
                  <Pencil className="h-4 w-4 mr-1" />
                  Edit
                </Button>
              )}
              {editing && (
                <>
                  <Button variant="ghost" size="sm" className="h-8" onClick={() => setEditing(false)} disabled={saving}>
                    Cancel
                  </Button>
                  <Button size="sm" className="h-8" onClick={handleSave} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </Button>
                </>
              )}
              {canEdit && !editing && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive h-8"
                  title="Never contact this address again — blocked from every client campaign, and the Bison sync cannot add it back"
                  onClick={() => setSuppressOpen(true)}
                >
                  <Ban className="h-4 w-4 mr-1" />
                  Never contact
                </Button>
              )}
              {isOwner && !editing && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive h-8"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  <Trash2 className="h-4 w-4 mr-1" />
                  {deleting ? "Deleting…" : "Delete"}
                </Button>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          {editing && (
            <p className="rounded-xl bg-primary/10 px-3 py-2 text-[12px] text-primary">
              Editing. Category changes are marked manual so enrichment never overwrites them;
              changing city or state re-runs location resolution for this lead. Every change is
              recorded in History below.
            </p>
          )}

          <Section title="Contact">
            {editing ? (
              <>
                <EditRow label="First name" field="first_name" draft={draft} onChange={onFieldChange} />
                <EditRow label="Last name" field="last_name" draft={draft} onChange={onFieldChange} />
                <EditRow label="Title" field="title" draft={draft} onChange={onFieldChange} />
                <EditRow label="Email" field="email" draft={draft} onChange={onFieldChange} placeholder="name@company.com" />
              </>
            ) : (
              <>
                <DetailRow label="Email" value={current.email} href={`mailto:${current.email}`} />
                <DetailRow label="Email type" value={current.email_type} />
                <DetailRow label="Source" value={current.source} />
              </>
            )}
          </Section>

          <Section title="Company">
            {editing ? (
              <>
                <EditRow label="Company" field="company" draft={draft} onChange={onFieldChange} />
                <EditRow label="Category" field="category" draft={draft} onChange={onFieldChange} />
                <EditRow label="Subcategory" field="subcategory" draft={draft} onChange={onFieldChange} />
                <EditRow label="Additional category" field="additional_category" draft={draft} onChange={onFieldChange} />
                <EditRow label="Company phone" field="company_phone" draft={draft} onChange={onFieldChange} />
                <EditRow label="Domain" field="domain" draft={draft} onChange={onFieldChange} />
                <EditRow label="Website" field="website" draft={draft} onChange={onFieldChange} />
              </>
            ) : (
              <>
                <DetailRow label="Company" value={current.company} />
                <DetailRow
                  label="Category"
                  value={
                    current.category
                      ? `${current.category}${current.category_source ? ` (${current.category_source}${current.category_confidence != null ? `, ${Math.round(current.category_confidence * 100)}%` : ""})` : ""}`
                      : null
                  }
                />
                <DetailRow label="Subcategory" value={current.subcategory} />
                <DetailRow label="Additional category" value={current.additional_category} />
                <DetailRow label="Company phone" value={current.company_phone} />
                <DetailRow label="Domain" value={current.domain} />
                <DetailRow
                  label="Google Maps"
                  value={current.google_maps_url ? "Open" : null}
                  href={current.google_maps_url ?? undefined}
                />
                <DetailRow label="ESP" value={current.esp} />
              </>
            )}
          </Section>

          <Section title="Location">
            {editing ? (
              <>
                <EditRow label="Street" field="street" draft={draft} onChange={onFieldChange} />
                <EditRow label="City" field="city" draft={draft} onChange={onFieldChange} />
                <EditRow label="State" field="state" draft={draft} onChange={onFieldChange} placeholder="TX or Texas" />
                <EditRow label="ZIP" field="postal_code" draft={draft} onChange={onFieldChange} />
                <EditRow label="Full address" field="address" draft={draft} onChange={onFieldChange} />
              </>
            ) : (
              <>
                <DetailRow label="Street" value={current.street} />
                <DetailRow label="City" value={current.city} />
                <DetailRow label="State" value={current.state} />
                <DetailRow label="ZIP" value={current.postal_code} />
                <DetailRow label="Full address" value={current.address} />
              </>
            )}
          </Section>

          {!editing && (
            <>
              <Section title="Deliverability">
                <DetailRow label="Validation" value={current.validation_status ?? "Not validated"} />
                <DetailRow label="Validated by" value={current.validation_provider} />
                <DetailRow
                  label="Validated at"
                  value={current.validated_at ? new Date(current.validated_at).toLocaleString() : null}
                />
                <DetailRow label="Bounced" value={current.is_bounced ? "Yes" : "No"} />
                <DetailRow label="Bounce source" value={current.bounce_source} />
                <DetailRow
                  label="Bounce type"
                  value={
                    current.bounce_type === "sender"
                      ? "Sender issue (still contactable)"
                      : current.bounce_type === "hard"
                        ? "Hard bounce (do not contact)"
                        : current.bounce_type === "unknown"
                          ? "Unknown (treated as hard)"
                          : current.bounce_type
                  }
                />
                <DetailRow label="Bounce reason" value={current.bounce_reason} />
              </Section>

              <Section title="Engagement (Email Bison)">
                <DetailRow label="Workspace" value={current.workspace_name} />
                <DetailRow label="Emails sent" value={current.emails_sent != null ? String(current.emails_sent) : null} />
                <DetailRow label="Opens" value={current.opens != null ? String(current.opens) : null} />
                <DetailRow label="Replies" value={current.replies != null ? String(current.replies) : null} />
                <DetailRow label="Bounces" value={current.bounces != null ? String(current.bounces) : null} />
              </Section>
            </>
          )}

          <Section title="Personalization question">
            {editing ? (
              <EditRow label="Question" field="question" draft={draft} onChange={onFieldChange} multiline />
            ) : current.question ? (
              <p className="px-4 py-3 text-[13px] leading-relaxed text-foreground">{current.question}</p>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted-foreground">—</p>
            )}
          </Section>

          <Section title="Notes">
            {editing ? (
              <EditRow label="Notes" field="notes" draft={draft} onChange={onFieldChange} multiline />
            ) : current.notes ? (
              <p className="px-4 py-3 text-[13px] leading-relaxed text-foreground">{current.notes}</p>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted-foreground">—</p>
            )}
          </Section>

          <Section title="Tags">
            {editing ? (
              <EditRow label="Tags" field="tags" draft={draft} onChange={onFieldChange} placeholder="comma,separated" />
            ) : current.tags ? (
              <p className="px-4 py-3 text-[13px] leading-relaxed text-foreground">{current.tags}</p>
            ) : (
              <p className="px-4 py-3 text-[13px] text-muted-foreground">—</p>
            )}
          </Section>

          <Section title="History">
            <div className="px-4 py-3">
              <LeadHistory key={`${current.id}-${historyVersion}`} leadId={current.id} />
            </div>
          </Section>

          <Section title="Metadata">
            <DetailRow label="ID" value={current.id} />
            <DetailRow label="Created" value={new Date(current.created_at).toLocaleDateString()} />
            <DetailRow label="Updated" value={new Date(current.updated_at).toLocaleDateString()} />
          </Section>

          <div className="h-4" />
        </div>
      </SheetContent>

      <SuppressLeadsDialog
        open={suppressOpen}
        onClose={() => setSuppressOpen(false)}
        ids={[current.id]}
        onDone={onClose}
      />
    </Sheet>
  );
}
