"use client";

import { useState } from "react";
import { X, ExternalLink, Mail, Phone, Building2, MapPin, Trash2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
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
    <div className="flex justify-between items-start gap-2 py-1">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-right truncate hover:underline flex items-center gap-1"
        >
          {value}
          <ExternalLink className="h-3 w-3 shrink-0" />
        </a>
      ) : (
        <span className="text-xs text-right truncate">{value}</span>
      )}
    </div>
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

  const location = [lead.city, lead.state, lead.country]
    .filter(Boolean)
    .join(", ");

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="w-[700px] sm:w-[800px] max-w-[90vw] sm:max-w-[800px] overflow-y-auto p-6">
        <SheetHeader>
          <div className="flex items-start justify-between gap-4 pr-8">
            <div>
              <SheetTitle className="text-left">{fullName}</SheetTitle>
              {lead.job_title && (
                <p className="text-sm text-muted-foreground">{(() => {
                  const raw = lead.job_title;
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

        <div className="mt-4 space-y-4">
          {/* Contact */}
          <section>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Contact
            </h4>
            <div className="space-y-0.5">
              <DetailRow
                label="Email"
                value={lead.email}
                href={`mailto:${lead.email}`}
              />
              <DetailRow label="Phone" value={lead.phone} />
              <DetailRow
                label="LinkedIn"
                value={lead.person_linkedin ? "Profile" : null}
                href={lead.person_linkedin ?? undefined}
              />
            </div>
          </section>

          <Separator />

          {/* Company */}
          <section>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Company
            </h4>
            <div className="space-y-0.5">
              <DetailRow label="Company" value={lead.company_name_raw} />
              <DetailRow
                label="Website"
                value={lead.website}
                href={
                  lead.website
                    ? lead.website.startsWith("http")
                      ? lead.website
                      : `https://${lead.website}`
                    : undefined
                }
              />
              <DetailRow label="Size" value={lead.company_size != null ? lead.company_size.toLocaleString() : null} />
              <DetailRow label="Revenue" value={lead.annual_revenue != null ? (lead.annual_revenue >= 1e9 ? `$${(lead.annual_revenue / 1e9).toFixed(1)}B` : lead.annual_revenue >= 1e6 ? `$${(lead.annual_revenue / 1e6).toFixed(1)}M` : `$${lead.annual_revenue.toLocaleString()}`) : null} />
              <DetailRow
                label="Company LinkedIn"
                value={lead.company_linkedin ? "Profile" : null}
                href={lead.company_linkedin ?? undefined}
              />
              <DetailRow label="Domain" value={lead.domain} />
            </div>
          </section>

          <Separator />

          {/* Classification */}
          <section>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              Classification
            </h4>
            <div className="space-y-0.5">
              <DetailRow label="Seniority" value={lead.seniority} />
              <DetailRow label="General Industry" value={lead.general_industry} />
              <DetailRow label="Specific Industry" value={lead.specific_industry} />
              <DetailRow label="ESP" value={lead.esp} />
              <DetailRow label="Source" value={lead.source} />
              <DetailRow label="Status" value={lead.status} />
            </div>
          </section>

          {/* Keywords */}
          {lead.keywords && (
            <>
              <Separator />
              <section>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
                  Keywords
                </h4>
                <p className="text-xs text-muted-foreground">{lead.keywords}</p>
              </section>
            </>
          )}

          {/* Company Overview */}
          {lead.company_overview && (
            <>
              <Separator />
              <section>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
                  Company Overview
                </h4>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {lead.company_overview}
                </p>
              </section>
            </>
          )}

          {/* Location */}
          {location && (
            <>
              <Separator />
              <section>
                <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
                  Location
                </h4>
                <div className="flex items-center gap-1.5 text-xs">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                  {location}
                </div>
              </section>
            </>
          )}

          <Separator />

          {/* History */}
          <section>
            <h4 className="text-xs font-semibold uppercase text-muted-foreground mb-2">
              History
            </h4>
            <LeadHistory leadId={lead.id} />
          </section>

          {/* Metadata */}
          <Separator />
          <section className="pb-4">
            <div className="space-y-0.5">
              <DetailRow label="ID" value={lead.id} />
              <DetailRow
                label="Created"
                value={new Date(lead.created_at).toLocaleDateString()}
              />
              <DetailRow
                label="Updated"
                value={new Date(lead.updated_at).toLocaleDateString()}
              />
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
