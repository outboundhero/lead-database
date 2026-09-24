// Which workspace does a lead belong in, and which campaigns may it attach to?
//
// B2B vs B2C is decided by the ADDRESS DOMAIN: freemail (gmail/yahoo/aol/…) is
// B2C, a company domain is B2B. That is the definition the Leads filters and
// fn_lead_filter_conditions' emailSide branch use, and per the client
// (2026-09-24) it is the only correct one.
//
// Two defects this replaces, both found in the 2026-09-24 audit:
//
//  1. The worker chose the side with `lead.email_type === "personal"`, which
//     answers a different question — is this mailbox a PERSON (john@) or a ROLE
//     (info@)? Most business contacts are people, so 1,745,235 company
//     addresses were sent to B2C campaigns and 271,587 freemail addresses to
//     B2B campaigns (61.9% of everything pushed through a sided batch).
//
//  2. When a batch's campaigns carried no `side`, every campaign passed the
//     filter, so each lead attached on BOTH installs — 822,977 leads.
//
// Kept as pure functions so they can be tested without a database or Bison:
// scripts/test-push-side.mts.

/** 'b2c' when the address is on a freemail provider, otherwise 'b2b'. */
export function sideOfEmail(email, freemailDomains) {
  const domain = String(email ?? "").toLowerCase().trim().split("@")[1] ?? "";
  return freemailDomains.has(domain) ? "b2c" : "b2b";
}

/**
 * A campaign's own side: the wizard stamps it, otherwise it is derived from
 * which of the client's two installs the campaign lives on. null when neither
 * is known.
 */
export function sideOfCampaign(campaign, clientTag, instanceSide) {
  if (campaign?.side === "b2b" || campaign?.side === "b2c") return campaign.side;
  return instanceSide.get(`${clientTag}|${campaign?.instance_url}`) ?? null;
}

/**
 * The campaigns a lead may attach to.
 *
 * Returns { targets } or { refuse } — and it REFUSES rather than guessing when
 * the campaigns span two installs and any of them has no resolvable side.
 * Attaching to both workspaces is never an acceptable fallback: it puts the
 * same person in the client's B2B and B2C sequences at once.
 */
export function campaignsForLead({ campaigns, email, clientTag, freemailDomains, instanceSide }) {
  const all = campaigns ?? [];
  const instances = new Set(all.map((c) => c.instance_url ?? ""));
  const unresolved = all.filter((c) => sideOfCampaign(c, clientTag, instanceSide) === null);
  if (unresolved.length > 0 && instances.size > 1) {
    return {
      refuse:
        "campaigns span both workspaces but their B2B/B2C side cannot be determined " +
        `(${unresolved.map((c) => `${c.id}@${c.instance_url}`).join(", ")})`,
    };
  }
  const side = sideOfEmail(email, freemailDomains);
  // A single-install batch has nothing to split, so an unstamped campaign stays
  // open; a two-install batch was refused above.
  const targets = instances.size <= 1
    ? all
    : all.filter((c) => sideOfCampaign(c, clientTag, instanceSide) === side);
  return { targets, side };
}
