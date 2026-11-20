// What Bison will do with one lead for one target campaign, decided BEFORE the
// attach call; the attach body; the spot check after it; the item's outcome.
// Used by scripts/push-worker.mjs, tested by scripts/test-push-attach.mts.
//
// Why (2026-11-20). POST /api/campaigns/{id}/leads/attach-leads answers 2xx for
// a chunk even when Bison quietly leaves leads out, and the worker marked the
// whole chunk attached. Measured on the 18 Nov pushes of nine new clients:
// ~284k of ~694k "sent" leads were not in their campaigns. Every missing lead
// in the live samples was either "in_sequence" in another campaign on the same
// install (Bison skips those unless the call sets allow_parallel_sending) or
// bounced. The Clay tables this push replaced send
// `"allow_parallel_sending": true` on this same call; the worker never did, and
// the client confirmed that clients sharing a service area must be able to mail
// the same leads. So the worker now:
//   - reads what Bison already holds for the lead (the per-lead lookup it does
//     anyway returns status and lead_campaign_data) and decides per campaign:
//       present  already in the target campaign: nothing to attach;
//       blocked  Bison will not add it, recorded with the reason;
//       attach   send it, `force` when it relies on parallel sending;
//   - sends allow_parallel_sending on the attach while it is on;
//   - spot-checks forced leads after a 2xx, and records what did not land.

// A lead with one of these statuses in the workspace is never added to any
// campaign (Bison's own 422: "previously bounced, or unsubscribed").
export const BLOCKING_LEAD_STATUSES = new Set(["bounced", "unsubscribed"]);

// A campaign in one of these states sends nothing more, so a lead "in_sequence"
// there is no live conflict, even for the same client. Anything else (draft,
// active, paused, launching, unknown…) may still send.
export const FINISHED_CAMPAIGN_STATUSES = new Set(["archived", "completed", "stopped", "deleted"]);

/** The client tag a campaign name starts with: "ABC: SEGs (Cleaning Client)" -> "ABC". null when there is none. */
export function campaignTag(name) {
  const m = /^\s*([^:]+?)\s*:/.exec(String(name ?? ""));
  return m ? m[1].trim().toUpperCase() : null;
}

const entriesOf = (bisonLead) =>
  Array.isArray(bisonLead?.lead_campaign_data) ? bisonLead.lead_campaign_data.filter((e) => e && typeof e === "object") : [];

/** Is the lead in this campaign, in any status? */
export function inCampaign(bisonLead, campaignId) {
  return entriesOf(bisonLead).some((e) => String(e.campaign_id) === String(campaignId));
}

/** Ids of the OTHER campaigns where the lead is "in_sequence" — the ones Bison checks before adding it. */
export function inSequenceElsewhere(bisonLead, campaignId) {
  return [...new Set(
    entriesOf(bisonLead)
      .filter((e) => e.status === "in_sequence" && String(e.campaign_id) !== String(campaignId))
      .map((e) => String(e.campaign_id))
  )];
}

const holderTags = (holders) =>
  [...new Set(holders.map((h) => campaignTag(h.name) ?? `#${h.id}`))].join(", ");

/**
 * One lead, one target campaign.
 *   bisonLead     the lead as Bison returned it (GET /api/leads/{id|email}),
 *                 or null for a lead this push has just created (no campaigns)
 *   campaignId    the target campaign
 *   clientTag     the batch's client tag
 *   campaignInfo  id -> { name, status } of a campaign on the same install, or
 *                 null when Bison no longer has it; called only for the ids
 *                 inSequenceElsewhere() returns
 *   force         allow_parallel_sending is on
 * Returns { action: "present" } | { action: "blocked", reason } |
 *         { action: "attach", force, holders? }.
 */
export function planTarget({ bisonLead, campaignId, clientTag, campaignInfo, force }) {
  if (!bisonLead) return { action: "attach", force: false };
  if (inCampaign(bisonLead, campaignId)) return { action: "present" };
  const status = String(bisonLead.status ?? "").trim().toLowerCase();
  if (BLOCKING_LEAD_STATUSES.has(status)) {
    return { action: "blocked", reason: `Bison: the lead is ${status} in this workspace` };
  }
  const busy = inSequenceElsewhere(bisonLead, campaignId);
  if (busy.length === 0) return { action: "attach", force: false };

  const tag = String(clientTag ?? "").trim().toUpperCase() || null;
  const holders = busy.map((id) => ({ id, ...(campaignInfo?.(id) ?? { name: null, status: null }) }));
  // Never force past the client's OWN campaign that can still send: that would
  // put one person in two of the same client's sequences (main and nurture, or
  // two ESP buckets) at once.
  const ownLive = tag
    ? holders.filter((h) => campaignTag(h.name) === tag
        && !FINISHED_CAMPAIGN_STATUSES.has(String(h.status ?? "").trim().toLowerCase()))
    : [];
  if (ownLive.length) {
    return { action: "blocked", reason: `already in sequence in this client's campaign "${ownLive[0].name}" (#${ownLive[0].id})` };
  }
  if (!force) {
    return { action: "blocked", reason: `Bison: in sequence in another campaign (${holderTags(holders)}) and parallel sending is off` };
  }
  return { action: "attach", force: true, holders: holderTags(holders) };
}

/** The attach-leads body (ids passed through as the worker has always sent them). */
export function attachBody(leadIds, force) {
  return force ? { lead_ids: leadIds, allow_parallel_sending: true } : { lead_ids: leadIds };
}

/**
 * After a 2xx attach: did the leads that relied on parallel sending land?
 * Reads `sample` of them; only when one of those is missing are the rest read.
 *   getLead(id) -> the Bison lead, null when Bison has no such lead, or
 *                  undefined when it could not be read (counted as landed: the
 *                  attach answered 2xx, and an unreadable lead is no evidence)
 * Returns { landed: Set, missing: Set, read, unreadable }.
 */
export async function verifyForced({ leadIds, campaignId, getLead, sample = 2 }) {
  const landed = new Set();
  const missing = new Set();
  let read = 0;
  let unreadable = 0;
  const check = async (id) => {
    const lead = await getLead(id);
    read++;
    if (lead === undefined) { unreadable++; landed.add(String(id)); return; }
    (lead && inCampaign(lead, campaignId) ? landed : missing).add(String(id));
  };
  const ids = leadIds.map(String);
  for (const id of ids.slice(0, sample)) await check(id);
  const rest = ids.slice(sample);
  if (missing.size === 0) {
    for (const id of rest) landed.add(id);
  } else {
    for (const id of rest) await check(id);
  }
  return { landed, missing, read, unreadable };
}

/**
 * The item's outcome once every target was attached, found present, or blocked.
 *   targets   [{ id }] the item's target campaigns
 *   attached  Set of campaign ids (string) in which the lead now is
 *   blocked   Map campaign id (string) -> reason
 * Returns { status: "sent" | "skipped", error } or null when a target is still
 * open (the caller retries the item).
 */
export function itemOutcome({ targets, attached, blocked }) {
  const ids = (targets ?? []).map((t) => String(t.id));
  if (ids.length === 0) return null;
  if (!ids.every((id) => attached.has(id) || blocked.has(id))) return null;
  const refused = ids.filter((id) => !attached.has(id) && blocked.has(id));
  const why = refused.map((id) => `#${id}: ${blocked.get(id)}`).join("; ");
  if (refused.length < ids.length) {
    return { status: "sent", error: refused.length ? `partial: not added to ${why}` : null };
  }
  return { status: "skipped", error: refused.length === 1 ? blocked.get(refused[0]) : why };
}
