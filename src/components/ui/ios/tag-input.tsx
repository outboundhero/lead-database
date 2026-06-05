"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface TagInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  maxTags?: number;
}

// iOS-style tag input — type a value, press Enter or comma to add a chip.
// Backspace on empty input removes the last chip.
export function TagInput({ values, onChange, placeholder, maxTags = 50 }: TagInputProps) {
  const [draft, setDraft] = React.useState("");

  function commit(raw: string) {
    const v = raw.trim();
    if (!v) return;
    if (values.length >= maxTags) return;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  }

  function remove(idx: number) {
    onChange(values.filter((_, i) => i !== idx));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      e.preventDefault();
      remove(values.length - 1);
    }
  }

  return (
    <div className="space-y-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((tag, i) => (
            <Badge key={`${tag}-${i}`} variant="tinted" className="gap-1 pr-1">
              <span className="normal-case">{tag}</span>
              <button
                type="button"
                onClick={() => remove(i)}
                className="flex size-3.5 items-center justify-center rounded-full hover:bg-primary/20"
                aria-label={`Remove ${tag}`}
              >
                <X className="size-2.5" strokeWidth={2.5} />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => commit(draft)}
        placeholder={placeholder ?? "Type and press Enter…"}
      />
    </div>
  );
}
