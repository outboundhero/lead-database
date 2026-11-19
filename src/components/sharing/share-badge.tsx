"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { BatchShareBadge } from "@/lib/sharing/types";

// The Uploads page's "Shared to N clients", per import batch that has a share
// job (GET /api/sharing/batches), linking to the job on the Sharing page. A
// batch with no job shows nothing; so does every batch when sharing is not set
// up or the reader is not a manager.

export function useShareBadges(ids: string[]): Record<string, BatchShareBadge> {
  const [badges, setBadges] = useState<Record<string, BatchShareBadge>>({});
  const key = ids.join(",");
  useEffect(() => {
    if (!key) return;
    let gone = false;
    fetch(`/api/sharing/batches?ids=${encodeURIComponent(key)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => !gone && j?.batches && setBadges(j.batches))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [key]);
  return badges;
}

export function ShareBadge({ batchId, badge }: { batchId: string; badge: BatchShareBadge | undefined }) {
  if (!badge) return null;
  const text =
    badge.sharedTo > 0
      ? `Shared to ${badge.sharedTo} client${badge.sharedTo === 1 ? "" : "s"}`
      : badge.previewTo > 0
        ? `Preview: ${badge.previewTo} client${badge.previewTo === 1 ? "" : "s"}`
        : badge.state === "waiting" || badge.state === "deciding"
          ? "Sharing: deciding"
          : badge.state === "no_lead_list"
            ? "Sharing: no lead list"
            : badge.state === "error"
              ? "Sharing: error"
              : "Shared to no client";
  return (
    <Link href={`/leads/sharing?job=${encodeURIComponent(batchId)}`} className="text-[12.5px] font-medium text-primary hover:opacity-80">
      {text}
    </Link>
  );
}
