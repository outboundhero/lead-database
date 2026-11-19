"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Share2 } from "lucide-react";
import { AccessDenied } from "@/components/layout/access-denied";
import { useHasPermission } from "@/lib/context/role-context";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import { JobsTab } from "@/components/sharing/jobs-tab";
import { ClientsTab } from "@/components/sharing/clients-tab";
import { HeldTab } from "@/components/sharing/held-tab";
import { LowPlacesTab } from "@/components/sharing/low-places-tab";
import { NeverContactInboxesPanel } from "@/components/sharing/never-contact-inboxes-panel";

// The Sharing page (overlap sharing, plan 1.11; the weekly top-up and
// never-contact inboxes, plan section 2 and the 2026-11-20 answers). Managers
// view it; admins apply, undo, push and retry (the routes check the role).
//
//   Jobs             each finished import's share job: its state, counts per
//                    receiving client, the rows, the CSV and the buttons
//   Clients          each client's pool or "isolated", and why it cannot receive
//   Held             held and queued shares, leads with no usable place, the
//                    installs the Bison mirror covers
//   Low places       the weekly top-up's flags and pulls
//   General inboxes  the Clay General inboxes filter, its dry run and apply
//
// ?tab= picks a tab; ?job=<batch id> opens a job (the Uploads page links here).

const TABS = [
  { value: "jobs", label: "Jobs" },
  { value: "clients", label: "Clients" },
  { value: "held", label: "Held" },
  { value: "low", label: "Low places" },
  { value: "inboxes", label: "General inboxes" },
] as const;
type Tab = (typeof TABS)[number]["value"];

export default function SharingPage() {
  return (
    <Suspense fallback={null}>
      <Sharing />
    </Suspense>
  );
}

function Sharing() {
  const canView = useHasPermission("manager");
  const isAdmin = useHasPermission("admin");
  const router = useRouter();
  const params = useSearchParams();
  const job = params.get("job");
  const asked = params.get("tab");
  const tab: Tab = job ? "jobs" : TABS.some((t) => t.value === asked) ? (asked as Tab) : "jobs";

  const go = (next: { tab?: Tab; job?: string | null }) => {
    const q = new URLSearchParams();
    const t = next.tab ?? tab;
    if (t !== "jobs") q.set("tab", t);
    const j = next.job === undefined ? job : next.job;
    if (j && t === "jobs") q.set("job", j);
    router.replace(q.size ? `/leads/sharing?${q}` : "/leads/sharing");
  };

  if (!canView) return <AccessDenied />;
  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-2xl bg-primary/12 text-primary">
          <Share2 className="size-5" strokeWidth={1.75} />
        </div>
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Sharing</h1>
          <p className="text-[12.5px] text-muted-foreground">
            New leads of each import that fit another client of the same pool, the low places of each client, and the general inboxes on the Clay
            filter
          </p>
        </div>
      </div>
      <IosSegmentedControl value={tab} onChange={(t) => go({ tab: t, job: null })} options={[...TABS]} className="self-start" />
      {tab === "jobs" && <JobsTab isAdmin={isAdmin} openJob={job} onOpenJob={(id) => go({ tab: "jobs", job: id })} />}
      {tab === "clients" && <ClientsTab />}
      {tab === "held" && <HeldTab isAdmin={isAdmin} />}
      {tab === "low" && <LowPlacesTab />}
      {tab === "inboxes" && <NeverContactInboxesPanel />}
    </div>
  );
}
