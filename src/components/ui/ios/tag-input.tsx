"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

// Comma, semicolon, newline, or tab. Tab means a row of spreadsheet cells can be
// pasted straight in.
export const LIST_SEPARATORS = /[,;\n\t]+/;

interface TagInputProps {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  maxTags?: number;
  /**
   * Pattern a committed value is SPLIT on, so typing or pasting
   * "restaurant, restaurants, eatery" yields three chips. Defaults to
   * LIST_SEPARATORS, which is what every term/keyword/tag field wants.
   *
   * Pass `null` for fields where a comma is part of the value itself:
   * location entries like "Spokane, WA" must stay ONE chip (the targeting
   * dialog parses them into {country, state, city}), so splitting them would
   * break client targeting.
   */
  splitOn?: RegExp | null;
}

// iOS-style tag input. Enter or a separator adds a chip; Backspace on an empty
// input removes the last one.
export function TagInput({
  values,
  onChange,
  placeholder,
  maxTags = 500,
  splitOn = LIST_SEPARATORS,
}: TagInputProps) {
  const [draft, setDraft] = React.useState("");

  // Splits when `splitOn` is set, de-dupes case-insensitively against what's
  // already there AND within the pasted batch, and appends in ONE onChange so a
  // 50-item paste doesn't trigger 50 re-renders.
  function commit(raw: string) {
    const pieces = splitOn ? raw.split(splitOn) : [raw];
    const seen = new Set(values.map((v) => v.trim().toLowerCase()));
    const additions: string[] = [];
    for (const piece of pieces) {
      const v = piece.trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      additions.push(v);
    }
    setDraft("");
    if (additions.length === 0) return;

    // Previously the overflow was dropped silently, which lost data on save.
    const room = Math.max(0, maxTags - values.length);
    const kept = additions.slice(0, room);
    if (kept.length < additions.length) {
      toast.warning(
        `Limit is ${maxTags} entries — ${additions.length - kept.length} not added.`
      );
    }
    if (kept.length > 0) onChange([...values, ...kept]);
  }

  function remove(idx: number) {
    onChange(values.filter((_, i) => i !== idx));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit(draft);
    } else if (e.key === "," && splitOn) {
      // Only a shortcut for splittable fields. For location fields the comma
      // must be typeable, so "Spokane, WA" can be entered by hand.
      e.preventDefault();
      commit(draft);
    } else if (e.key === "Backspace" && draft === "" && values.length > 0) {
      e.preventDefault();
      remove(values.length - 1);
    }
  }

  // Paste never fires keydown per character, so a pasted comma list would
  // otherwise land as one giant chip — that is how a single 588-character
  // "restaurant, restaurants, eatery, …" entry ended up stored.
  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    if (!splitOn) return;
    const text = e.clipboardData.getData("text");
    if (!text || !splitOn.test(text)) return;
    e.preventDefault();
    commit(draft + text);
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
        onPaste={onPaste}
        onBlur={() => commit(draft)}
        placeholder={placeholder ?? "Type and press Enter…"}
      />
    </div>
  );
}
