import type { ShareJobState, ShareOutcome, SharePushState } from "./types";

// Plain words for the Sharing page. Browser code: no imports from scripts/.
// The values themselves are named in scripts/lib/overlap-topup.mjs.

export const JOB_STATE_LABEL: Record<ShareJobState, string> = {
  waiting: "Waiting for places",
  deciding: "Deciding",
  previewed: "Preview",
  applied: "Applied",
  skipped: "Skipped",
  no_lead_list: "No lead list",
  error: "Error",
  undone: "Undone",
};

export const OUTCOME_LABEL: Record<ShareOutcome, string> = {
  shared: "Shared",
  own_topup: "Own top-up",
  filtered_inbox: "General inbox on the Clay filter",
  already_sent: "Already sent",
  in_flight: "Being pushed",
  already_shared: "Already shared",
  already_tagged: "Already tagged",
  same_install: "Same sending setup",
  also_fits: "Another client of the group owns it",
};

/** The outcomes in the order the page lists them: shares first. */
export const OUTCOME_ORDER: ShareOutcome[] = [
  "shared", "own_topup", "filtered_inbox", "already_sent", "in_flight", "already_shared", "already_tagged", "same_install", "also_fits",
];

export const PUSH_STATE_LABEL: Record<SharePushState, string> = {
  queued: "Queued",
  pushed: "Pushed",
  held: "Held",
  dropped: "Dropped",
};

/** lead_shares.push_note codes of a dropped row, in words; a held row's note is already in words. */
const DROP_NOTES: Record<string, string> = {
  in_campaign: "already in this client's campaigns (the Bison mirror, or in sequence in its own live campaign)",
  undone: "the share was undone",
  no_lead: "the lead is gone or has no email",
  already_sent: "already sent to this client by another push",
  not_eligible: "not eligible when pushed (no email, bounced, not valid, or outside the client's rules then)",
  bison_refused: "Bison would not take it (bounced or unsubscribed there, or refused by Bison)",
};

export function pushNoteText(note: string | null | undefined): string {
  if (!note) return "";
  return DROP_NOTES[note] ?? note;
}

/** The origin of a database backfill share or job (BACKFILL_ORIGIN in scripts/lib/backfill/settings.mjs, migration 138). */
export const BACKFILL_ORIGIN_TAG = "DATABASE";

/** A share's or a job's origin in words: "the database (backfill)" for the backfill's marker, else the client's tag. */
export function originLabel(tag: string | null | undefined): string {
  if (!tag) return "";
  return tag === BACKFILL_ORIGIN_TAG ? "the database (backfill)" : tag;
}

export const fmtCount = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");

export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isFinite(d.getTime())
    ? d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";
}

/** "3 days", "5 hours", "12 minutes": how long ago. */
export function age(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}
