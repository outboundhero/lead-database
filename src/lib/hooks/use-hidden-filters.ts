"use client";

import { useCallback, useEffect, useState } from "react";

// Persists the set of filter-chip keys the user has chosen to hide from the
// filter bar. Hidden chips don't render but can always be un-hidden from the
// "Manage filters" control. Stored as a JSON string[] in localStorage so the
// preference survives reloads. Hiding a chip is purely cosmetic — it never
// clears the underlying filter value.
const STORAGE_KEY = "outboundhero.hiddenFilters";

// One-time cleanup stamp. On 2026-08-19 the Category / Subcategory /
// Additional-SEO chips were merged into the single "Category" chip, which is
// keyed `categorySearch`. Anyone who had hidden that chip — or who still has the
// three dead keys stored — would otherwise never see the merged field, which is
// precisely the "I can't see the feature" problem this change set out to fix.
// So we un-hide it once and drop the retired keys, then stamp so it never
// re-runs and the user's later choices are respected.
const MIGRATION_KEY = "outboundhero.hiddenFilters.mergedCategory";
const RETIRED_KEYS = ["category", "subcategory", "additionalCategory"];

// Second one-time cleanup, 2026-08-20: the "Keywords" chip was retired (its job
// is done by the Category chip, which spans company + industries + overview
// since migration 077). Needs its OWN stamp — anyone who already ran the
// merged-category cleanup above carries that stamp, so reusing it would skip
// this entirely and leave a dead "keywords" key in their stored list forever.
const KEYWORDS_MIGRATION_KEY = "outboundhero.hiddenFilters.retiredKeywords";
const KEYWORDS_RETIRED_KEYS = ["keywords"];

function readStored(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    let values = Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];

    if (!window.localStorage.getItem(MIGRATION_KEY)) {
      const cleaned = values.filter(
        (v) => v !== "categorySearch" && !RETIRED_KEYS.includes(v)
      );
      if (cleaned.length !== values.length) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
        values = cleaned;
      }
      window.localStorage.setItem(MIGRATION_KEY, "1");
    }

    if (!window.localStorage.getItem(KEYWORDS_MIGRATION_KEY)) {
      const cleaned = values.filter((v) => !KEYWORDS_RETIRED_KEYS.includes(v));
      if (cleaned.length !== values.length) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
        values = cleaned;
      }
      window.localStorage.setItem(KEYWORDS_MIGRATION_KEY, "1");
    }
    return values;
  } catch {
    return [];
  }
}

export interface HiddenFilters {
  hidden: Set<string>;
  isHidden: (key: string) => boolean;
  hide: (key: string) => void;
  unhide: (key: string) => void;
  toggle: (key: string) => void;
  clear: () => void;
}

export function useHiddenFilters(): HiddenFilters {
  // Start empty so server and first client render match (avoids hydration
  // mismatch), then hydrate from localStorage on mount.
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const stored = readStored();
    if (stored.length > 0) setHidden(new Set(stored));
  }, []);

  const persist = useCallback((next: Set<string>) => {
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* storage full / disabled — keep the in-memory set only */
      }
    }
  }, []);

  const hide = useCallback((key: string) => {
    setHidden((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      persist(next);
      return next;
    });
  }, [persist]);

  const unhide = useCallback((key: string) => {
    setHidden((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      persist(next);
      return next;
    });
  }, [persist]);

  const toggle = useCallback((key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      persist(next);
      return next;
    });
  }, [persist]);

  const clear = useCallback(() => {
    setHidden(() => {
      const next = new Set<string>();
      persist(next);
      return next;
    });
  }, [persist]);

  const isHidden = useCallback((key: string) => hidden.has(key), [hidden]);

  return { hidden, isHidden, hide, unhide, toggle, clear };
}
