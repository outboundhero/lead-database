"use client";

import { useState } from "react";
import { Search, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { AddLeadModal } from "@/components/leads/add-lead-modal";

export function TopBar() {
  const [addLeadOpen, setAddLeadOpen] = useState(false);

  return (
    <>
      <header className="ios-frost sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border/40 px-5">
        {/* iOS-style search bar */}
        <div className="relative max-w-md flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
            strokeWidth={1.75}
          />
          <Input
            placeholder="Search leads…"
            className="h-10 rounded-full pl-10 text-[14px]"
          />
        </div>

        {/* Slot for page-specific top-bar controls. The Leads page portals its
            Client selector in here (2026-08-20 — picking a client is how you
            start a piece of work, so it belongs beside the search box rather
            than buried among twenty filter chips).

            A portal rather than lifting state: TopBar renders in the app shell
            ABOVE <main>{children}</main>, so it is a sibling ancestor of the
            page and shares no state with it. useFilters lives inside LeadsPage.
            Portalling keeps the selector inside the page's React tree — so it
            still sees `filters` and the targeting callbacks with no provider —
            while painting it here. Lifting useFilters into a layout-level
            provider would touch every filter consumer for a cosmetic move. */}
        <div id="topbar-slot" className="flex items-center gap-2" />

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" onClick={() => setAddLeadOpen(true)}>
            <Plus className="size-4" strokeWidth={2.25} />
            Add lead
          </Button>
          <ThemeToggle />
        </div>
      </header>

      <AddLeadModal
        open={addLeadOpen}
        onClose={() => setAddLeadOpen(false)}
        onCreated={() => setAddLeadOpen(false)}
      />
    </>
  );
}
