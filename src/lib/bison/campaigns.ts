// The single definition of "is this a Nurture campaign?".
//
// This test used to be copy-pasted as an inline /nurture/i in five places
// (send-preview, the wizard twice, the export popup twice), which is exactly how
// the rule drifts — one of those copies tested an already-lowercased string with
// a case-SENSITIVE /nurture/, so "Nurture" slipped through it.
//
// Client rule (2026-08-20): the database only ever sends to MAIN campaigns.
// Nurture campaigns are populated from replies inside Bison, never from a push
// out of here, so they are excluded from every campaign picker AND rejected by
// the push API. UI filtering alone is not a boundary; the API is.
//
// Nurture-ness is inferred from the NAME because Bison exposes no campaign type
// and we persist no flag. A campaign renamed after a push is not retroactively
// reclassified — see the note in CLAUDE.md.

/** Case-insensitive, matches "nurture" anywhere in the name. */
export function isNurtureCampaign(name: unknown): boolean {
  return /nurture/i.test(String(name ?? ""));
}

/** Everything that may legitimately receive a push. */
export function mainCampaignsOnly<T extends { name?: unknown }>(campaigns: T[]): T[] {
  return campaigns.filter((c) => !isNurtureCampaign(c.name));
}
