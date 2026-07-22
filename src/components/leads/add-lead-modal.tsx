"use client";

import { Fragment, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

interface AddLeadModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

// Grouped to mirror the leads table's own columns. `section` starts a labeled
// block in the form.
const FIELDS: { key: string; label: string; placeholder: string; required?: boolean; section?: string }[] = [
  // Person
  { key: "first_name", label: "First Name", placeholder: "John", section: "Person" },
  { key: "last_name", label: "Last Name", placeholder: "Doe" },
  { key: "email", label: "Email", placeholder: "john@example.com", required: true },
  { key: "title", label: "Title", placeholder: "Site Manager" },
  { key: "seniority", label: "Seniority", placeholder: "Manager" },
  { key: "person_linkedin", label: "Person LinkedIn", placeholder: "linkedin.com/in/…" },
  // Company
  { key: "company", label: "Company", placeholder: "Acme Inc", section: "Company" },
  { key: "domain", label: "Domain", placeholder: "acme.com" },
  { key: "website", label: "Website", placeholder: "https://acme.com" },
  { key: "company_phone", label: "Company Phone", placeholder: "+1 555 0100" },
  { key: "company_linkedin", label: "Company LinkedIn", placeholder: "linkedin.com/company/…" },
  { key: "general_industry", label: "General Industry", placeholder: "Facilities Services" },
  { key: "specific_industry", label: "Specific Industry", placeholder: "Commercial Cleaning" },
  { key: "company_size", label: "Company Size", placeholder: "50" },
  { key: "annual_revenue", label: "Annual Revenue", placeholder: "5000000" },
  { key: "company_overview", label: "Company Overview", placeholder: "Short description…" },
  // Category (Bison / Clay enrichment)
  { key: "category", label: "Category", placeholder: "Janitorial", section: "Category" },
  { key: "subcategory", label: "Subcategory", placeholder: "Commercial Cleaning" },
  { key: "additional_category", label: "Additional Category", placeholder: "Facility Services" },
  // Location
  { key: "city", label: "City", placeholder: "Austin", section: "Location" },
  { key: "state", label: "State", placeholder: "TX" },
  { key: "country", label: "Country", placeholder: "United States" },
  { key: "postal_code", label: "Postal Code", placeholder: "78701" },
  { key: "street", label: "Street", placeholder: "123 Main St" },
  { key: "address", label: "Address", placeholder: "123 Main St, Austin, TX 78701" },
  { key: "google_maps_url", label: "Google Maps URL", placeholder: "https://maps.google.com/…" },
  // Meta
  { key: "esp", label: "Email Service Provider", placeholder: "Google", section: "Other" },
  { key: "source", label: "Source", placeholder: "Email Bison" },
  { key: "tags", label: "Tags (comma-separated)", placeholder: "OH, Outlook" },
  { key: "question", label: "Personalization Question", placeholder: "How do you keep your space clean?" },
  { key: "notes", label: "Notes", placeholder: "Any notes…" },
];

export function AddLeadModal({ open, onClose, onCreated }: AddLeadModalProps) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  function update(key: string, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit() {
    if (!form.email?.trim()) {
      toast.error("Email is required");
      return;
    }
    setSaving(true);
    const supabase = createClient();
    const payload: Record<string, unknown> = {};
    for (const f of FIELDS) {
      const val = form[f.key]?.trim();
      if (!val) continue;
      if (f.key === "company_size") {
        const n = parseInt(val.replace(/[,$\s]/g, ""), 10);
        if (!isNaN(n) && n > 0) payload[f.key] = n;
      } else if (f.key === "annual_revenue") {
        const n = parseFloat(val.replace(/[$,\s]/g, ""));
        if (!isNaN(n) && n > 0) payload[f.key] = n;
      } else if (f.key === "technologies") {
        payload[f.key] = val.split(",").map((t: string) => t.trim()).filter(Boolean);
      } else {
        payload[f.key] = val;
      }
    }
    // Auto-generate domain from email
    if (payload.email && typeof payload.email === "string" && payload.email.includes("@")) {
      payload.domain = payload.email.split("@")[1].toLowerCase();
    }
    // A manually-entered category is authoritative — mark it so the Clay/keyword
    // enrichment never overwrites it.
    if (payload.category) {
      payload.category_source = "manual";
      payload.category_confidence = 1;
      payload.categorized_at = new Date().toISOString();
    }
    const { data: inserted, error } = await supabase
      .from("leads")
      .insert(payload)
      .select("id")
      .single();
    if (error) {
      toast.error(error.message);
    } else {
      if (inserted) {
        await supabase.from("lead_history").insert({
          lead_id: inserted.id,
          event_type: "created",
          notes: "Manually added via Add Lead form",
        });
      }
      toast.success("Lead added successfully");
      setForm({});
      onCreated?.();
      onClose();
    }
    setSaving(false);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add lead</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {FIELDS.map((f) => (
            <Fragment key={f.key}>
              {f.section && (
                <p className="col-span-2 mt-1 border-b border-border/50 px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {f.section}
                </p>
              )}
              <div className={`space-y-1 ${f.key === "company_overview" ? "col-span-2" : ""}`}>
                <label className="block px-1 text-[12px] font-medium text-muted-foreground">
                  {f.label}
                  {f.required && <span className="ml-0.5 text-destructive">*</span>}
                </label>
                <Input
                  placeholder={f.placeholder}
                  value={form[f.key] ?? ""}
                  onChange={(e) => update(f.key, e.target.value)}
                  className="h-10 text-[14px]"
                />
              </div>
            </Fragment>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? "Adding…" : "Add lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
