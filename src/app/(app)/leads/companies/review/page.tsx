"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ShieldAlert } from "lucide-react";
import { AccessDenied } from "@/components/layout/access-denied";
import { useHasPermission } from "@/lib/context/role-context";
import { ClientSelector } from "@/components/filters/client-selector";
import { FitPanel, ScoringRunPanel } from "@/components/companies/fit-panel";
import { ReviewTable } from "@/components/companies/review-table";

// The review page (phase 3): fit scoring's state and the gate, the scoring of
// the companies already in campaigns (owners and admins), and one client's
// review list of bad fits in its campaigns, approved or kept by a person and
// removed only by a person, after a dry run. Manager and up.

export default function FitReviewPage() {
  return (
    <Suspense fallback={null}>
      <FitReview />
    </Suspense>
  );
}

function FitReview() {
  const canView = useHasPermission("manager");
  const router = useRouter();
  const tag = useSearchParams().get("client")?.toUpperCase() ?? null;
  if (!canView) return <AccessDenied />;
  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <ShieldAlert className="size-5" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Fit review</h1>
            <p className="text-[12.5px] text-muted-foreground">Fit scores, the gate, and bad fits already in each client&apos;s campaigns</p>
          </div>
        </div>
        <div className="ml-2">
          <ClientSelector
            clientTag={tag}
            onChange={(t) => router.replace(t ? `/leads/companies/review?client=${encodeURIComponent(t)}` : "/leads/companies/review")}
          />
        </div>
        <Link
          href={tag ? `/leads/companies?client=${encodeURIComponent(tag)}` : "/leads/companies"}
          className="ml-auto flex items-center gap-1.5 text-[13px] font-medium text-primary"
        >
          <ArrowLeft className="size-4" /> Companies
        </Link>
      </div>
      <FitPanel key={tag ?? "none"} tag={tag} />
      <ScoringRunPanel />
      {tag ? (
        <ReviewTable key={tag} tag={tag} />
      ) : (
        <div className="rounded-2xl bg-card p-10 text-center shadow-ios">
          <p className="text-[15px] font-semibold">Pick a client to see its review list</p>
          <p className="mx-auto mt-1 max-w-lg text-[13px] text-muted-foreground">
            The list shows the blocked companies in the client&apos;s campaigns, with their leads, replies and the date the Email Bison copy last read them.
          </p>
        </div>
      )}
    </div>
  );
}
