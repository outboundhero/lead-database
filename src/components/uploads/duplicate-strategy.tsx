"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

type Strategy = "skip" | "merge" | "replace";

interface DuplicateStrategyProps {
  value: Strategy;
  onChange: (strategy: Strategy) => void;
  overrideFields: string[];
  onOverrideFieldsChange: (fields: string[]) => void;
  mappedFields: string[];
  onConfirm: () => void;
  onBack: () => void;
}

const PROTECTED_FIELDS = ["general_industry", "seniority", "source", "website", "domain"];

const FIELD_LABELS: Record<string, string> = {
  first_name: "First Name",
  last_name: "Last Name",
  job_title: "Job Title",
  company_name_raw: "Company Name",
  company_size: "Company Size",
  annual_revenue: "Annual Revenue",
  general_industry: "General Industry",
  specific_industry: "Specific Industry",
  phone: "Phone",
  esp: "ESP",
  seniority: "Seniority",
  source: "Source",
  country: "Country",
  state: "State",
  city: "City",
  website: "Website",
  domain: "Domain",
  person_linkedin: "Person LinkedIn",
  company_linkedin: "Company LinkedIn",
  technologies: "Technologies",
  keywords: "Keywords",
  company_overview: "Company Overview",
};

const STRATEGIES: { value: Strategy; label: string; description: string }[] = [
  {
    value: "skip",
    label: "Skip Duplicates",
    description:
      "If a lead with the same email already exists, skip the new row entirely.",
  },
  {
    value: "merge",
    label: "Merge (Fill Blanks)",
    description:
      "Keep existing data, only fill in fields that are currently empty.",
  },
  {
    value: "replace",
    label: "Replace (Select Fields to Override)",
    description:
      "Choose which fields to overwrite. Unchecked fields are left untouched.",
  },
];

export function DuplicateStrategy({
  value,
  onChange,
  overrideFields,
  onOverrideFieldsChange,
  mappedFields,
  onConfirm,
  onBack,
}: DuplicateStrategyProps) {
  // Fields available for override = mapped fields minus email
  const availableFields = mappedFields.filter(
    (f) => f !== "email" && FIELD_LABELS[f]
  );

  function toggleField(field: string) {
    if (overrideFields.includes(field)) {
      onOverrideFieldsChange(overrideFields.filter((f) => f !== field));
    } else {
      onOverrideFieldsChange([...overrideFields, field]);
    }
  }

  function selectAll() {
    onOverrideFieldsChange(availableFields.filter((f) => !PROTECTED_FIELDS.includes(f)));
  }

  function clearAll() {
    onOverrideFieldsChange([]);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        How should we handle rows where the email already exists in the database?
      </p>
      <div className="space-y-2">
        {STRATEGIES.map((s) => (
          <button
            key={s.value}
            onClick={() => onChange(s.value)}
            className={`w-full text-left rounded-lg border p-3 transition-colors ${
              value === s.value
                ? "border-primary bg-primary/5"
                : "border-border hover:border-muted-foreground/50"
            }`}
          >
            <p className="text-sm font-medium">{s.label}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {s.description}
            </p>
          </button>
        ))}
      </div>

      {value === "replace" && (
        <div className="border rounded-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Select fields to override:</p>
            <div className="flex gap-2">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={selectAll}
              >
                Select All
              </button>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:underline"
                onClick={clearAll}
              >
                Clear
              </button>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-0.5">
            {availableFields.map((field) => {
              const isProtected = PROTECTED_FIELDS.includes(field);
              const isChecked = overrideFields.includes(field);
              return (
                <button
                  key={field}
                  onClick={() => toggleField(field)}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted/50 ${
                    isChecked ? "bg-muted" : ""
                  }`}
                >
                  <div
                    className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border ${
                      isChecked
                        ? "bg-primary border-primary text-primary-foreground"
                        : "border-muted-foreground/30"
                    }`}
                  >
                    {isChecked && <Check className="h-2.5 w-2.5" />}
                  </div>
                  <span className="truncate">
                    {FIELD_LABELS[field] || field}
                  </span>
                  {isProtected && (
                    <span className="text-[10px] text-amber-500 ml-auto">
                      ⚠ protected
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {overrideFields.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {overrideFields.length} field{overrideFields.length > 1 ? "s" : ""} will be overwritten for existing leads.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button
          onClick={onConfirm}
          disabled={value === "replace" && overrideFields.length === 0}
        >
          Start Upload
        </Button>
      </div>
    </div>
  );
}
