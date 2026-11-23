"use client";

import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import { useClientRoster } from "@/lib/clients/roster";
import { cn } from "@/lib/utils";
import { PromptsTab, type PromptFocus } from "./prompts-tab";
import { LocationTab } from "./location-tab";
import { QuestionVariableTab } from "./question-variable-tab";

// The Clay tab's Client setup sheet: one client's own prompts for its
// personalisation steps, its places, and its question variable, as three
// tabs. Any client can be picked (the shared client list, not only clients
// with Clay tables). The page opens it from "Client setup", from a column's
// "Edit prompt" (with that step in focus), and from the address
// /leads/clay?setup=TAG&tab=prompts|location|question. Its body is mounted
// only while it is open, so every open loads fresh. Text not saved asks
// before the sheet closes or another client or tab is picked.

export type SetupTab = "prompts" | "location" | "question";
export const SETUP_TABS: SetupTab[] = ["prompts", "location", "question"];
export const isSetupTab = (v: unknown): v is SetupTab => SETUP_TABS.includes(v as SetupTab);

const TAB_OPTIONS: { value: SetupTab; label: string }[] = [
  { value: "prompts", label: "Prompts" },
  { value: "location", label: "Location" },
  { value: "question", label: "Question variable" },
];
const LEAVE = "Leave without saving? The prompt text typed here and not saved is lost.";

export function ClientSetupSheet({
  open,
  onOpenChange,
  initialTag,
  initialTab = "prompts",
  focus = null,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The client it opens on (the open table's), or none. */
  initialTag?: string | null;
  initialTab?: SetupTab;
  /** The prompt step to open on, for initialTag. */
  focus?: PromptFocus | null;
  /** After a change was saved: the page reads its tables again. */
  onSaved?: () => void;
}) {
  const dirty = useRef(false);
  const setDirty = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);
  const mayLeave = useCallback(() => !dirty.current || window.confirm(LEAVE), []);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o && !mayLeave()) return;
        if (!o) dirty.current = false;
        onOpenChange(o);
      }}
    >
      <SheetContent className="gap-0 sm:max-w-3xl">
        <SheetHeader className="border-b border-border/60 pr-12">
          <SheetTitle className="flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-primary" /> Client setup
          </SheetTitle>
          <SheetDescription className="text-[13px]">
            A client&apos;s own text for its personalisation steps, its places and its question variable.
          </SheetDescription>
        </SheetHeader>
        {open && (
          <SetupBody initialTag={initialTag ?? null} initialTab={initialTab} focus={focus} onSaved={onSaved} onDirtyChange={setDirty} mayLeave={mayLeave} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function SetupBody({
  initialTag,
  initialTab,
  focus,
  onSaved,
  onDirtyChange,
  mayLeave,
}: {
  initialTag: string | null;
  initialTab: SetupTab;
  focus: PromptFocus | null;
  onSaved?: () => void;
  onDirtyChange: (dirty: boolean) => void;
  mayLeave: () => boolean;
}) {
  const [tag, setTag] = useState<string | null>(initialTag);
  const [tab, setTab] = useState<SetupTab>(initialTab);
  // The focus is for the client the sheet opened on; another client opens on its first step.
  const [focusFor, setFocusFor] = useState<string | null>(focus ? initialTag : null);

  const pick = (t: string) => {
    if (t === tag || !mayLeave()) return;
    onDirtyChange(false);
    setTag(t);
    setFocusFor(null);
  };
  const switchTab = (t: SetupTab) => {
    if (t === tab || !mayLeave()) return;
    onDirtyChange(false);
    setTab(t);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3">
        <ClientPicker tag={tag} onPick={pick} />
        <IosSegmentedControl size="sm" className="ml-auto" value={tab} onChange={switchTab} options={TAB_OPTIONS} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!tag ? (
          <p className="py-10 text-center text-[13px] text-muted-foreground">Choose a client to see its setup.</p>
        ) : tab === "prompts" ? (
          <PromptsTab key={tag} tag={tag} focus={focusFor === tag ? focus : null} onSaved={onSaved} onDirtyChange={onDirtyChange} />
        ) : tab === "location" ? (
          <LocationTab key={tag} tag={tag} />
        ) : (
          <QuestionVariableTab key={tag} tag={tag} />
        )}
      </div>
    </div>
  );
}

/** Any client of the shared client list (src/lib/clients/roster.ts), searched by tag or name. */
function ClientPicker({ tag, onPick }: { tag: string | null; onPick: (tag: string) => void }) {
  const { clients, refresh, error } = useClientRoster();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const all = clients ?? [];
  const term = q.trim().toLowerCase();
  const shown = term ? all.filter((c) => c.tag.toLowerCase().includes(term) || (c.name ?? "").toLowerCase().includes(term)) : all;
  const current = all.find((c) => c.tag === tag);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) refresh();
      }}
    >
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="max-w-[360px]" aria-label="Client">
          <span className="truncate">{tag ? `${tag}${current?.name ? ` · ${current.name}` : ""}` : "Choose a client"}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${all.length ? `${all.length} ` : ""}clients`} className="h-9 text-[13px]" />
        <div className="mt-2 max-h-72 space-y-0.5 overflow-y-auto">
          {clients === null ? (
            <div className="space-y-1 px-1 py-2 text-[12px] text-muted-foreground">
              <p>{error ? "Could not load the clients" : "Loading clients…"}</p>
              <button type="button" onClick={() => refresh(true)} className="font-medium text-primary hover:underline">
                Retry
              </button>
            </div>
          ) : shown.length === 0 ? (
            <p className="px-1 py-2 text-[12px] text-muted-foreground">{all.length ? "No client matches" : "No clients"}</p>
          ) : (
            shown.map((c) => (
              <button
                key={c.tag}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(c.tag);
                }}
                className={cn("flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] hover:bg-muted", c.tag === tag && "bg-primary/10")}
              >
                <span className="shrink-0 font-medium">{c.tag}</span>
                {c.name && <span className={cn("min-w-0 truncate text-[12px]", c.churned ? "text-muted-foreground/70" : "text-muted-foreground")}>{c.name}</span>}
                {c.churned && <span className="ml-auto shrink-0 text-[12px] text-muted-foreground">churned</span>}
                {c.tag === tag && <Check className={cn("size-3.5 shrink-0 text-primary", !c.churned && "ml-auto")} />}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
