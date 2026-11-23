import { isNurtureCampaign } from "./campaigns";
import type { EspBucket } from "./esp-bucket";
import { normalizeDomain, type BisonInstance } from "./keys";
import type { PushSide } from "./push-stamp";
import { BISON_GROUPS, sideCampaignsByInstall } from "../../../scripts/lib/bison-groups.mjs";

// The checks of a queued Bison push that need no session, moved out of
// POST /api/bison/push-batch so the automatic push of promoted leads
// (src/lib/companies/promote-push.ts) meets every one of them, word for word,
// as an operator's push from the export popup does. The route keeps its
// session and role, its reads and writes, the question variable, the fit
// gate's status and the 24-hour double-push guard (a forced push skips it).

export const MAX_CAMPAIGNS = 10;
export const MAX_SELECTED_IDS = 100000;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PushBatchCampaign {
  id: number | string;
  name?: string;
  instance_url: string;
  workspace_name?: string;
  // ESP routing (client req #9): when any campaign in the batch carries a
  // bucket, each lead is attached ONLY to the campaign matching its email
  // provider — outlook (Microsoft/Outlook), seg (security gateways), default
  // (Google/custom/everything else). Bucket-less batches attach to all.
  bucket?: EspBucket;
  // WORKSPACE ROUTING: which of the client's two Bison installs this campaign
  // belongs to. Business emails are sent from the B2B install and personal
  // ones from the B2C install, so a lead must only attach to campaigns on its
  // own side. Absent = campaign is on neither of this client's instances, and
  // is left open to any lead.
  side?: PushSide;
  // Bison's status as the picker read it; only used to refuse "archived" at
  // queue time. Not stored on the batch.
  status?: string;
}

/** The client_targeting columns a batch keeps as its target_market: the rules as they were when it was queued. */
export const TARGET_MARKET_COLUMNS =
  "countries, include_locations, exclude_locations, exclude_industries, exclude_keywords, require_location, allow_inferred_location, commercial_cleaning";

/**
 * The campaigns a push names, checked as the route checks them: one to
 * MAX_CAMPAIGNS (every one gets every lead, so the fan-out is bounded), each
 * with an all-digits id, on one of the configured installs, not Nurture and
 * not archived. Returns them as a batch stores them (the install as a bare
 * domain, a bucket only when it is one of the three; a side sent by the caller
 * is dropped), or the first refusal.
 */
export function checkPushCampaigns(input: unknown, instances: BisonInstance[]): { campaigns: PushBatchCampaign[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "campaigns is required (at least one campaign)" };
  }
  if (input.length > MAX_CAMPAIGNS) {
    return { error: `Too many campaigns (${input.length}). Max ${MAX_CAMPAIGNS} per batch.` };
  }
  const campaigns: PushBatchCampaign[] = [];
  for (const c of input as Array<Record<string, unknown> | null>) {
    if (!c || typeof c !== "object" || c.id === undefined || c.id === null || c.id === "" || !/^\d+$/.test(String(c.id))) {
      return { error: "Every campaign needs an id" };
    }
    // Never send a Bison token to a host that isn't one of ours.
    const domain = typeof c.instance_url === "string" ? normalizeDomain(c.instance_url) : "";
    if (!domain || !instances.some((i) => i.domain === domain)) {
      return { error: `Unknown Bison instance "${c.instance_url}" — not one of the configured instances` };
    }
    // Only MAIN campaigns may be pushed to. The pickers already hide Nurture
    // campaigns, but a picker is not a boundary — this check is, and it is what
    // the API consumers hit directly.
    if (isNurtureCampaign(c.name)) {
      return { error: `"${String(c.name)}" is a Nurture campaign — leads are only ever pushed to main campaigns.` };
    }
    // An archived campaign cannot send. The pickers hide them, but a preset
    // saved before the campaign was archived still names it; the status rides
    // along from the picker's own Bison read so this can be refused here.
    if (typeof c.status === "string" && c.status.trim().toLowerCase() === "archived") {
      return { error: `"${String(c.name ?? c.id)}" is archived in Bison and cannot send — pick a live campaign.` };
    }
    campaigns.push({
      id: c.id as number | string,
      name: typeof c.name === "string" ? c.name : undefined,
      instance_url: domain,
      workspace_name: typeof c.workspace_name === "string" ? c.workspace_name : undefined,
      ...(c.bucket === "outlook" || c.bucket === "seg" || c.bucket === "default" ? { bucket: c.bucket } : {}),
    });
  }
  return { campaigns };
}

/** Why a push's selectedIds can't be taken (not a list, too many, not uuids), or null. Absent or empty is not an error here. */
export function selectedIdsError(selectedIds: unknown): string | null {
  if (selectedIds !== undefined && !Array.isArray(selectedIds)) return "selectedIds must be an array of lead ids";
  if (!Array.isArray(selectedIds) || selectedIds.length === 0) return null;
  if (selectedIds.length > MAX_SELECTED_IDS) return `Too many leads (${selectedIds.length}). Max ${MAX_SELECTED_IDS} per batch.`;
  if (!selectedIds.every((id) => typeof id === "string" && UUID_RE.test(id))) return "selectedIds must be uuid strings";
  return null;
}

/**
 * A BATCH ACROSS TWO INSTALLS MUST KNOW WHICH SIDE EACH CAMPAIGN IS.
 *
 * The worker refuses to guess (push-side.mjs): a lead in a two-install batch
 * whose campaigns carry no side would otherwise land in both workspaces, the
 * 2026-09-24 incident. On 2026-10-05 four exports (148,550 leads) were queued
 * for clients whose B2B/B2C install mapping had not been synced yet, gathered
 * in full, and then every lead was skipped — so this is settled before
 * anything is queued.
 *
 * Campaigns on the client's saved installs were sided by stampCampaigns. The
 * rest take their install's own side (an install never changes side), but
 * only when every install in the batch belongs to ONE group, so a business
 * lead can never reach B2B campaigns in both groups. Mutates the campaigns.
 * Returns the group the installs resolved (to save on the client after the
 * batch is queued), null when nothing needed resolving, or the refusal.
 */
export function sideAcrossInstalls(campaigns: PushBatchCampaign[], clientTag: string | null): { group: number | null } | { error: string } {
  const installs = new Set(campaigns.map((c) => c.instance_url));
  if (installs.size <= 1) return { group: null };
  if (!clientTag) {
    return {
      error:
        "These campaigns are on two Bison installs, so the leads must be split into B2B and B2C — " +
        "select the client (top bar) before exporting, or pick campaigns from one install only.",
    };
  }
  if (!campaigns.some((c) => !c.side)) return { group: null };
  const { group } = sideCampaignsByInstall(campaigns) as { group: number | null };
  if (group === null) {
    return {
      error:
        `These campaigns are on ${[...installs].join(", ")}, which are not the two installs of one Bison group, ` +
        `so the leads could not be split into B2B and B2C. Pick ${clientTag}'s campaigns from one group: ` +
        "OutboundHero + CleaningOutbound, or FacilityReach + OutboundClean.",
    };
  }
  return { group };
}

/**
 * The group a queued batch's installs resolved, when it differs from the one
 * saved on the client: saved afterwards so the client is mapped from then on
 * (Clients page, previews, single-install pushes). Null when there is nothing
 * to save.
 */
export function groupToSave(
  saved: { group: number | null; b2b: string; b2c: string } | null,
  resolvedGroup: number | null
): { group: number; b2b: string; b2c: string; previous: number | null } | null {
  if (resolvedGroup === null) return null;
  const pair = (BISON_GROUPS as Record<number, { b2b: string; b2c: string }>)[resolvedGroup];
  if (!pair) return null;
  const changed = !saved || saved.group !== resolvedGroup || saved.b2b !== pair.b2b || saved.b2c !== pair.b2c;
  return changed ? { group: resolvedGroup, b2b: pair.b2b, b2c: pair.b2c, previous: saved?.group ?? null } : null;
}
