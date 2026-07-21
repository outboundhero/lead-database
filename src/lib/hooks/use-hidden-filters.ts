"use client";

import { useCallback, useEffect, useState } from "react";

// Persists the set of filter-chip keys the user has chosen to hide from the
// filter bar. Hidden chips don't render but can always be un-hidden from the
// "Manage filters" control. Stored as a JSON string[] in localStorage so the
// preference survives reloads. Hiding a chip is purely cosmetic — it never
// clears the underlying filter value.
const STORAGE_KEY = "outboundhero.hiddenFilters";

function readStored(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
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
