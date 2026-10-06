// What a campaign picker shows beside a campaign's name, and how it orders
// the list: status, creation date, lead count.
//
// Why this exists (2026-10-06): both pickers showed the NAME only. A client
// whose B2C install was set up in June got a second set of campaigns with the
// same names as the March B2B set ("JPCA: Google + Custom (Cleaning Client)"
// twice on app.outboundhero.co, one active with 60,916 leads and one draft
// with 2,918), and the operator had no way to tell them apart. Bison already
// sends status, created_at and total_leads on every campaign row; the routes
// passed them through; nothing displayed them.
//
// Pure functions, no React — scripts/test-campaign-meta.mts covers them.

export interface CampaignMetaLike {
  id: number | string;
  name?: unknown;
  status?: unknown;
  created_at?: unknown;
  total_leads?: unknown;
}

/** Bison's campaign statuses as it spells them, lower-cased. */
export type CampaignStatus =
  | "active"
  | "launching"
  | "draft"
  | "paused"
  | "completed"
  | "archived"
  | "unknown";

const KNOWN: ReadonlySet<string> = new Set([
  "active", "launching", "draft", "paused", "completed", "archived",
]);

/** Normalised status; "unknown" when Bison sent nothing recognisable. */
export function campaignStatus(c: CampaignMetaLike): CampaignStatus {
  const s = String(c.status ?? "").trim().toLowerCase();
  return (KNOWN.has(s) ? s : "unknown") as CampaignStatus;
}

/** Archived campaigns cannot send and are hidden from pickers by default. */
export function isArchivedCampaign(c: CampaignMetaLike): boolean {
  return campaignStatus(c) === "archived";
}

/** The campaign is live (sending or about to). Everything else is parked. */
export function isLiveCampaign(c: CampaignMetaLike): boolean {
  const s = campaignStatus(c);
  return s === "active" || s === "launching";
}

/** Creation time, or null when Bison sent nothing parseable. */
export function campaignCreatedAt(c: CampaignMetaLike): Date | null {
  if (typeof c.created_at !== "string" || !c.created_at) return null;
  const t = Date.parse(c.created_at);
  return Number.isFinite(t) ? new Date(t) : null;
}

/** Lead count, or null when absent. */
export function campaignLeadCount(c: CampaignMetaLike): number | null {
  const n = Number(c.total_leads);
  return c.total_leads == null || !Number.isFinite(n) ? null : n;
}

// Rendered in UTC so a date never shifts by a day between an operator in the
// US and one in India, and so tests are deterministic.
const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
});

/** "9 Jun 2026", or "" when there is no date. */
export function formatCampaignDate(c: CampaignMetaLike): string {
  const d = campaignCreatedAt(c);
  return d ? DATE_FMT.format(d) : "";
}

/** "Draft" / "Active" / … — capitalised for display. */
export function campaignStatusLabel(c: CampaignMetaLike): string {
  const s = campaignStatus(c);
  return s === "unknown" ? "Status unknown" : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Newest first by creation date; campaigns without a date go last, ordered by
 * id descending (Bison ids only ever grow, so a bigger id is a newer campaign).
 */
export function byNewestCampaign(a: CampaignMetaLike, b: CampaignMetaLike): number {
  const at = campaignCreatedAt(a)?.getTime();
  const bt = campaignCreatedAt(b)?.getTime();
  if (at != null && bt != null && at !== bt) return bt - at;
  if (at != null && bt == null) return -1;
  if (at == null && bt != null) return 1;
  return Number(b.id) - Number(a.id);
}

/**
 * One line for places that can only show text (a <select> option):
 * "Draft · 9 Jun 2026 · 2,918 leads". Parts that are unknown are left out.
 */
export function describeCampaign(c: CampaignMetaLike): string {
  const parts: string[] = [];
  const status = campaignStatus(c);
  if (status !== "unknown") parts.push(campaignStatusLabel(c));
  const date = formatCampaignDate(c);
  if (date) parts.push(date);
  const n = campaignLeadCount(c);
  if (n != null) parts.push(`${n.toLocaleString("en-US")} lead${n === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
