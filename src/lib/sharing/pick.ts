import { autoPickCampaigns, isClientCampaign, type ClientInstalls, type PickableCampaign } from "@/lib/bison/campaign-autopick";
import { campaignStatus } from "@/lib/bison/campaign-meta";
import type { EspBucket } from "@/lib/bison/esp-bucket";
import { normalizeDomain } from "@/lib/bison/keys";
import { stampCampaigns, type PushSide } from "@/lib/bison/push-stamp";
import { sideCampaignsByInstall } from "../../../scripts/lib/bison-groups.mjs";

// Which of a receiving client's campaigns a share push goes into (plan 1.8).
// Pure, no database and no Bison: scripts/test-share-push.mjs covers it.
//
//   1. Only Active or Draft campaigns (the client decided 2026-09-29 that a
//      lead only ever goes into one of those; scripts/queue-repush.mts keeps
//      the same two), and that BEFORE the pick, so the one-per-slot rule only
//      sees campaigns that can take a lead.
//   2. autoPickCampaigns (src/lib/bison/campaign-autopick.ts), the export
//      popup's pre-selection: all of the client's campaigns or none, with the
//      reason when none.
//   3. Each picked campaign stamped with its bucket and side
//      (src/lib/bison/push-stamp.ts); a campaign off the client's saved
//      installs takes its install's fixed side (the picked installs are then
//      always in one group, autoPickCampaigns sees to that).
//   4. The picked campaigns by side. A lead goes only to campaigns on its own
//      side's install: the push holds a lead whose side has none ("no B2C
//      campaign"), so a freemail address never lands in a B2B campaign.

/** Bison statuses a share may go into. */
export const SHARE_CAMPAIGN_STATUSES: readonly string[] = ["active", "draft"];

/** A campaign as a share push batch stores it (push_batches.campaigns). */
export interface ShareCampaign {
  id: number | string;
  name?: string;
  instance_url: string;
  workspace_name?: string;
  bucket?: EspBucket;
  side?: PushSide;
}

export interface SharePick {
  /** The picked campaigns of each side, stamped; an empty list when that side has none. */
  bySide: Record<PushSide, ShareCampaign[]>;
  /** Why nothing was picked; null when something was. */
  blocked: string | null;
  /** The client's own campaigns left out before the pick for their status (paused, completed and the like). */
  notLive: number;
}

export function pickShareCampaigns(rows: Array<Record<string, unknown>>, receiver: string, installs: ClientInstalls | null | undefined): SharePick {
  const empty = (blocked: string, notLive = 0): SharePick => ({ bySide: { b2b: [], b2c: [] }, blocked, notLive });
  const usable = rows.filter(
    (r) => r && typeof r === "object" && /^\d+$/.test(String(r.id ?? "")) && typeof r.instance_url === "string" && r.instance_url
  ) as unknown as Array<PickableCampaign & { workspace_name?: unknown }>;
  const live = usable.filter((c) => SHARE_CAMPAIGN_STATUSES.includes(campaignStatus(c)));
  // The client's own campaigns (named "TAG: ...") left out for their status.
  const notLive = usable.filter((c) => !live.includes(c) && isClientCampaign(c.name, receiver)).length;
  const { picked, blocked } = autoPickCampaigns(live, receiver, installs);
  if (picked.length === 0) {
    const why = blocked ?? "no campaign was picked";
    const ownLive = live.some((c) => isClientCampaign(c.name, receiver));
    // Say so when the client's only campaigns are not Active or Draft.
    return empty(notLive > 0 && !ownLive ? `${why} (${notLive} of its campaigns are not Active or Draft)` : why, notLive);
  }
  const campaigns: ShareCampaign[] = picked.map((c) => ({
    id: c.id,
    ...(typeof c.name === "string" ? { name: c.name } : {}),
    instance_url: normalizeDomain(String(c.instance_url)),
    ...(typeof c.workspace_name === "string" ? { workspace_name: c.workspace_name } : {}),
  }));
  stampCampaigns(campaigns, installs ?? {});
  if (campaigns.some((c) => !c.side)) {
    const { group } = sideCampaignsByInstall(campaigns) as { group: number | null };
    if (group === null) return empty(`${receiver}'s picked campaigns are not on the two installs of one Bison group`, notLive);
  }
  return {
    bySide: { b2b: campaigns.filter((c) => c.side === "b2b"), b2c: campaigns.filter((c) => c.side === "b2c") },
    blocked: null,
    notLive,
  };
}
