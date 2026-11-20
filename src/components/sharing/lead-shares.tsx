"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { originLabel, OUTCOME_LABEL, PUSH_STATE_LABEL, pushNoteText, when } from "@/lib/sharing/labels";
import type { LeadShare } from "@/lib/sharing/types";

// The lead detail panel's shares (GET /api/sharing/lead): each time an import
// carrying this lead was checked against another client, from which client to
// which, the outcome, and whether it was applied, pushed or undone. Renders
// nothing when the lead has none; wrap puts the list in the panel's section.
// A database backfill share (138) comes from "the database (backfill)".

export function LeadShares({ leadId, wrap }: { leadId: string; wrap: (body: React.ReactNode) => React.ReactNode }) {
  // Kept with the lead they belong to, so another lead's shares never show while this one's load.
  const [loaded, setLoaded] = useState<{ leadId: string; shares: LeadShare[] } | null>(null);
  useEffect(() => {
    let gone = false;
    fetch(`/api/sharing/lead?id=${encodeURIComponent(leadId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => !gone && setLoaded({ leadId, shares: Array.isArray(j?.shares) ? j.shares : [] }))
      .catch(() => !gone && setLoaded({ leadId, shares: [] }));
    return () => {
      gone = true;
    };
  }, [leadId]);
  const shares = loaded?.leadId === leadId ? loaded.shares : null;
  if (!shares || shares.length === 0) return null;
  return wrap(
    <div className="space-y-2 px-4 py-3">
      {shares.map((s) => (
        <div key={s.id} className={s.undone_at ? "opacity-50" : undefined}>
          <p className="text-[13px] font-medium">
            {originLabel(s.origin_tag)} to {s.receiver_tag}: {OUTCOME_LABEL[s.outcome] ?? s.outcome}
            {s.matched_place ? ` (${s.matched_place})` : ""}
          </p>
          <p className="text-[12px] text-muted-foreground">
            {s.undone_at
              ? `Undone ${when(s.undone_at)}`
              : s.applied_at
                ? `Applied ${when(s.applied_at)}${s.push_state ? `, ${PUSH_STATE_LABEL[s.push_state].toLowerCase()}${s.push_note ? `: ${pushNoteText(s.push_note)}` : ""}` : ""}${s.tag_added ? ", tag written" : ""}`
                : `Decided ${when(s.decided_at)}, not applied`}
            {" · "}
            <Link href={`/leads/sharing?job=${encodeURIComponent(s.batch_id)}`} className="text-primary hover:opacity-80">
              {s.filename ?? s.source_label ?? "the import"}
            </Link>
          </p>
        </div>
      ))}
    </div>
  );
}
