// Which of a client's campaigns the export popup ticks for the operator.
//
// Client request (2026-11-18): with a client selected, the popup should open
// with that client's campaigns already ticked, so a push is one click. A push
// sends every lead to every ticked campaign (the worker then routes by install
// and ESP bucket), so a wrong tick sends leads somewhere wrong. The rule ticks
// ALL of the client's campaigns or NONE, and says why when it ticks none:
//
//   - the campaign is the client's: its name is "TAG: …" (exactly that tag,
//     then a colon — all 332 campaign names ever pushed to follow it, measured
//     2026-11-18). A bare prefix is not enough: "JPC" would take JPCA's,
//     JPC&A's and five other clients' campaigns.
//   - not a Nurture campaign, not archived (neither can receive a push).
//   - on the client's own installs when it has them saved; otherwise every
//     install must be in ONE Bison group, as the push route requires.
//   - at most one campaign per install and ESP bucket. Two (a client's March
//     set and its June set, both "Outlook" on one install) would each get the
//     same leads, and Bison refuses a lead already in another sequence on that
//     install. Which one is meant is the operator's call, so nothing is ticked.
//     A campaign whose name names no bucket counts as "Google + Custom", which
//     is how the push worker routes it.
//
// Pure, no React — scripts/test-campaign-autopick.mts covers it.

import { isNurtureCampaign } from "./campaigns";
import { isArchivedCampaign, type CampaignMetaLike } from "./campaign-meta";
import { suggestBucketFromName, type EspBucket } from "./esp-bucket";

export interface PickableCampaign extends CampaignMetaLike {
  name?: string;
  instance_url?: string;
}

export interface ClientInstalls {
  b2b_instance?: string | null;
  b2c_instance?: string | null;
}

export interface AutoPick<C> {
  /** The campaigns to tick: all of the client's, or none. */
  picked: C[];
  /** Why nothing was ticked (null when `picked` is non-empty). */
  blocked: string | null;
}

// Each install's Bison group. A copy of BISON_GROUPS in scripts/lib/bison-groups.mjs
// (browser code does not import from scripts/); test-campaign-autopick.mts fails
// when the two differ.
export const INSTALL_GROUP: Readonly<Record<string, number>> = {
  "app.outboundhero.co": 1,
  "personal.cleaningoutbound.com": 1,
  "app.facilityreach.com": 2,
  "personal.outboundclean.com": 2,
};

// As operators name the campaigns ("SEGs", "Outlook", "Google + Custom").
const BUCKET_NAMES: Record<EspBucket, string> = { seg: "SEG", outlook: "Outlook", default: "Google + Custom" };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const domain = (v: unknown) =>
  String(v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

/** The campaign is named for this client: "TAG: …" (case and spaces before the colon ignored). */
export function isClientCampaign(name: unknown, tag: string): boolean {
  const t = tag.trim();
  if (!t) return false;
  return new RegExp("^\\s*" + escapeRegex(t) + "\\s*:", "i").test(String(name ?? ""));
}

export function autoPickCampaigns<C extends PickableCampaign>(
  campaigns: C[],
  tag: string,
  installs?: ClientInstalls | null,
): AutoPick<C> {
  const none = (blocked: string): AutoPick<C> => ({ picked: [], blocked });

  let own = campaigns.filter(
    (c) => isClientCampaign(c.name, tag) && !isNurtureCampaign(c.name) && !isArchivedCampaign(c),
  );
  if (own.length === 0) return none(`no campaign is named "${tag}: …"`);

  const saved = [installs?.b2b_instance, installs?.b2c_instance].map(domain).filter(Boolean);
  if (saved.length > 0) {
    own = own.filter((c) => saved.includes(domain(c.instance_url)));
    if (own.length === 0) return none(`none of ${tag}'s campaigns are on its installs (${saved.join(", ")})`);
  } else {
    // 0 = an install in no group.
    const groups = new Set(own.map((c) => INSTALL_GROUP[domain(c.instance_url)] ?? 0));
    if (groups.size !== 1 || groups.has(0)) return none(`${tag}'s campaigns are not all on one Bison group's installs`);
  }

  const slots = new Map<string, C[]>();
  for (const c of own) {
    const key = `${domain(c.instance_url)}|${suggestBucketFromName(c.name) ?? "default"}`;
    slots.set(key, [...(slots.get(key) ?? []), c]);
  }
  const clashes = [...slots.entries()].filter(([, cs]) => cs.length > 1);
  if (clashes.length > 0) {
    const [key, cs] = clashes[0];
    const [inst, bucket] = key.split("|") as [string, EspBucket];
    const more = clashes.length > 1 ? ` (and ${clashes.length - 1} more like it)` : "";
    return none(`${cs.length} ${BUCKET_NAMES[bucket]} campaigns on ${inst}${more}, so tick the ones to use`);
  }

  return { picked: own, blocked: null };
}
