"use client";

import { useEffect } from "react";
import { getRosterState, refreshRoster, ROSTER_REFOCUS_MS, setRosterOwner } from "@/lib/clients/roster";

/**
 * Loads the client list as the app opens, so the first client dropdown opened shows it at once
 * (src/lib/clients/roster.ts): the signed-in user's stored list first, then a fetch in the background
 * when it is over a minute old. When the tab comes back after ROSTER_REFOCUS_MS, it refreshes again.
 * Rendered once by the app layout; renders nothing.
 */
export function ClientRosterPrefetch({ userId }: { userId: string }) {
  useEffect(() => {
    setRosterOwner(userId);
    void refreshRoster();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const { fetchedAt } = getRosterState();
      if (fetchedAt === null || Date.now() - fetchedAt > ROSTER_REFOCUS_MS) void refreshRoster();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [userId]);
  return null;
}
