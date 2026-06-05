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
