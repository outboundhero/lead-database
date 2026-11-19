"use client";

import { AlertTriangle } from "lucide-react";

// The Clients page's Groups tab notice (migration 132). Only the Groups tab
// holds churn dates, so a client it does not list could never be stopped 15
// days before it churns: such a client receives no shared leads and no top-up
// pulls. This lists the Active (or Healthy) clients the tab did not list at the
// last good read, or says the tab has not been read yet.

export function ReceiveNotice({
  receiveRule,
  groupsTabReadAt,
  missingFromTab,
}: {
  /** Migration 132 is in the database. */
  receiveRule: boolean;
  groupsTabReadAt: string | null;
  missingFromTab: string[];
}) {
  if (!receiveRule) return null;
  if (!groupsTabReadAt) {
    return (
      <div className="flex gap-2 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-[13px]">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
        <div>
          <p className="font-medium">The Groups tab has not been read since churn dates were added.</p>
          <p className="mt-0.5 text-muted-foreground">
            Until a sync reads it, no client can receive shared leads or top-up pulls. Press Sync groups or Sync with
            sheet, or wait for the 6-hourly sync.
          </p>
        </div>
      </div>
    );
  }
  if (missingFromTab.length === 0) return null;
  const n = missingFromTab.length;
  return (
    <div className="flex gap-2 rounded-xl border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-[13px]">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <div className="min-w-0">
        <p className="font-medium">
          {n} active client{n === 1 ? " is" : "s are"} not on the Groups tab
        </p>
        <p className="mt-0.5 text-muted-foreground">
          Only the Groups tab holds churn dates, so {n === 1 ? "this client gets" : "these clients get"} no shared leads
          and no top-up pulls until {n === 1 ? "it is" : "they are"} added there. Last read{" "}
          {new Date(groupsTabReadAt).toLocaleString()}.
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {missingFromTab.map((t) => (
            <span key={t} className="rounded-md bg-background px-1.5 py-0.5 text-xs font-medium">{t}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
