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
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";

interface AddLeadModalProps {
  open: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

const FIELDS: { key: string; label: string; placeholder: string; required?: boolean }[] = [
  { key: "first_name", label: "First Name", placeholder: "John" },
  { key: "last_name", label: "Last Name", placeholder: "Doe" },
  { key: "email", label: "Email", placeholder: "john@example.com", required: true },
  { key: "phone", label: "Phone", placeholder: "+1 555 0100" },
  { key: "company_name_raw", label: "Company Name", placeholder: "Acme Inc" },
  { key: "job_title", label: "Job Title", placeholder: "VP of Sales" },
  { key: "general_industry", label: "General Industry", placeholder: "Technology" },
  { key: "specific_industry", label: "Specific Industry", placeholder: "SaaS" },
  { key: "company_size", label: "Company Size (employees)", placeholder: "150" },
  { key: "annual_revenue", label: "Annual Revenue ($)", placeholder: "5000000" },
  { key: "esp", label: "Email Service Provider", placeholder: "Google Workspace" },
  { key: "source", label: "Source", placeholder: "Apollo" },
  { key: "country", label: "Country", placeholder: "US" },
  { key: "city", label: "City", placeholder: "New York" },
  { key: "website", label: "Website", placeholder: "https://acme.com" },
  { key: "person_linkedin", label: "Personal LinkedIn", placeholder: "https://linkedin.com/in/..." },
  { key: "company_linkedin", label: "Company LinkedIn", placeholder: "https://linkedin.com/company/..." },
  { key: "company_overview", label: "Company Overview", placeholder: "Brief description..." },
  { key: "technologies", label: "Technologies", placeholder: "Gmail, WordPress, Cloudflare" },
  { key: "keywords", label: "Keywords", placeholder: "marketing, saas, b2b" },
  { key: "state", label: "State", placeholder: "California" },
  { key: "seniority", label: "Seniority", placeholder: "c_suite" },
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
            <div
              key={f.key}
              className={`space-y-1 ${f.key === "company_overview" ? "col-span-2" : ""}`}
            >
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
