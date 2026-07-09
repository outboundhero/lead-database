"use client";

import { useState } from "react";
import { ExternalLink, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { LeadHistory } from "./lead-history";
import { useRole } from "@/lib/context/role-context";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import type { Lead } from "@/types/database";

interface LeadDetailPanelProps {
  lead: Lead | null;
  open: boolean;
  onClose: () => void;
  onDeleted?: (id: string) => void;
}

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

export function LeadDetailPanel({
  lead,
  open,
  onClose,
  onDeleted,
}: LeadDetailPanelProps) {
  const role = useRole();
  const isOwner = role === "owner";
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!lead) return;
    setDeleting(true);
    const supabase = createClient();
    const { error } = await supabase.from("leads").delete().eq("id", lead.id);
    setDeleting(false);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success("Lead deleted");
      onDeleted?.(lead.id);
      onClose();
    }
  }

  if (!lead) return null;

  const fullName =
    `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim() || "Unknown";

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-[700px] sm:w-[800px] max-w-[90vw] sm:max-w-[800px] overflow-y-auto p-6">
        <SheetHeader>
          <div className="flex items-start justify-between gap-4 pr-8">
            <div>
              <SheetTitle className="text-left">{fullName}</SheetTitle>
              {lead.title && (
                <p className="text-sm text-muted-foreground">{(() => {
                  const raw = lead.title;
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
                    .map((t) => t.split(" ").map((w) => w === w.toUpperCase() && w.length <= 4 ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" "))
                    .join(", ");
                })()}</p>
              )}
            </div>
            {isOwner && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive shrink-0 h-8"
                onClick={handleDelete}
                disabled={deleting}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                {deleting ? "Deleting…" : "Delete"}
              </Button>
            )}
          </div>
        </SheetHeader>

        <div className="mt-4 space-y-5">
          <Section title="Contact">
            <DetailRow label="Email" value={lead.email} href={`mailto:${lead.email}`} />
            <DetailRow label="Email type" value={lead.email_type} />
            <DetailRow label="Source" value={lead.source} />
          </Section>

          <Section title="Company">
            <DetailRow label="Company" value={lead.company} />
            <DetailRow
              label="Category"
              value={
                lead.category
                  ? `${lead.category}${lead.category_source ? ` (${lead.category_source}${lead.category_confidence != null ? `, ${Math.round(lead.category_confidence * 100)}%` : ""})` : ""}`
                  : null
              }
            />
            <DetailRow label="Subcategory" value={lead.subcategory} />
            <DetailRow label="Additional category" value={lead.additional_category} />
            <DetailRow label="Company phone" value={lead.company_phone} />
            <DetailRow label="Domain" value={lead.domain} />
            <DetailRow
              label="Google Maps"
              value={lead.google_maps_url ? "Open" : null}
              href={lead.google_maps_url ?? undefined}
            />
            <DetailRow label="ESP" value={lead.esp} />
          </Section>

          <Section title="Location">
            <DetailRow label="Street" value={lead.street} />
            <DetailRow label="City" value={lead.city} />
            <DetailRow label="State" value={lead.state} />
            <DetailRow label="ZIP" value={lead.postal_code} />
            <DetailRow label="Full address" value={lead.address} />
          </Section>

          <Section title="Deliverability">
            <DetailRow label="Validation" value={lead.validation_status ?? "Not validated"} />
            <DetailRow label="Validated by" value={lead.validation_provider} />
            <DetailRow
              label="Validated at"
              value={lead.validated_at ? new Date(lead.validated_at).toLocaleString() : null}
            />
            <DetailRow label="Bounced" value={lead.is_bounced ? "Yes" : "No"} />
            <DetailRow label="Bounce source" value={lead.bounce_source} />
            <DetailRow
              label="Bounce type"
              value={
                lead.bounce_type === "sender"
                  ? "Sender issue (still contactable)"
                  : lead.bounce_type === "hard"
                    ? "Hard bounce (do not contact)"
                    : lead.bounce_type === "unknown"
                      ? "Unknown (treated as hard)"
                      : null
              }
            />
            <DetailRow label="Bounce reason" value={lead.bounce_reason} />
          </Section>

          <Section title="Engagement (Email Bison)">
            <DetailRow label="Workspace" value={lead.workspace_name} />
            <DetailRow label="Emails sent" value={lead.emails_sent != null ? String(lead.emails_sent) : null} />
            <DetailRow label="Opens" value={lead.opens != null ? String(lead.opens) : null} />
            <DetailRow label="Replies" value={lead.replies != null ? String(lead.replies) : null} />
            <DetailRow label="Bounces" value={lead.bounces != null ? String(lead.bounces) : null} />
          </Section>

          {lead.question && (
            <Section title="Personalization question">
              <p className="px-4 py-3 text-[13px] leading-relaxed text-foreground">
                {lead.question}
              </p>
            </Section>
          )}

          {lead.notes && (
            <Section title="Notes">
              <p className="px-4 py-3 text-[13px] leading-relaxed text-foreground">
                {lead.notes}
              </p>
            </Section>
          )}

          {lead.tags && (
            <Section title="Tags">
              <p className="px-4 py-3 text-[13px] leading-relaxed text-foreground">
                {lead.tags}
              </p>
            </Section>
          )}

          <Section title="History">
            <div className="px-4 py-3">
              <LeadHistory leadId={lead.id} />
            </div>
          </Section>

          <Section title="Metadata">
            <DetailRow label="ID" value={lead.id} />
            <DetailRow
              label="Created"
              value={new Date(lead.created_at).toLocaleDateString()}
            />
            <DetailRow
              label="Updated"
              value={new Date(lead.updated_at).toLocaleDateString()}
            />
          </Section>

          <div className="h-4" />
        </div>
      </SheetContent>
    </Sheet>
  );
}
