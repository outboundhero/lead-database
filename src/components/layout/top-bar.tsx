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
      <header className="flex items-center h-14 border-b px-4 gap-4 shrink-0 bg-background">
        {/* Search bar */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search leads..."
            className="pl-9 h-9 text-sm"
          />
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setAddLeadOpen(true)}
          >
            <Plus className="h-4 w-4" />
            Add Lead
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
