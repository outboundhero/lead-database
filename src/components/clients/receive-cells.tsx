"use client";

import { Check } from "lucide-react";
import type { ClientRow } from "@/app/api/clients/route";

// The Clients page's receive cells (migration 132): the churn date beside
// Status, the Groups tab mark beside the routing badge, and the sharing pool
// with why a client cannot receive shared leads or top-up pulls. The reason
// is fn_client_receive_block's, read by GET /api/clients.

/** A YYYY-MM-DD day as "Dec 31, 2026", read as a calendar day (no time zone shift). */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return day;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: "UTC", year: "numeric", month: "short", day: "numeric",
  });
}

/** The churn cell under the Status badge: a date, a non-answer, or a cell the sync cannot read. Nothing for a blank cell. */
export function ChurnLine({ c }: { c: ClientRow }) {
  if (c.churn_cell_state === "date" && c.churn_date) {
    const blocks = c.receive_block?.startsWith("churn date") ?? false;
    return (
      <div
        className={`mt-1 whitespace-nowrap text-xs font-medium ${blocks ? "text-destructive" : "text-muted-foreground"}`}
        title={blocks
          ? "Churn date from the Groups tab, within 15 days or past: this client gets no shared leads and no top-up pulls."
          : "Churn date from the Groups tab. Shared leads and top-up pulls stop 15 days before it."}
      >
        churns {dayLabel(c.churn_date)}
      </div>
    );
  }
  if (c.churn_cell_state === "non_answer") {
    return (
      <div className="mt-1 text-xs font-medium text-muted-foreground" title="The Groups tab says this, which is not a date: no churn date counts.">
        churn date: {c.churn_cell}
      </div>
    );
  }
  if (c.churn_cell_state === "unreadable") {
    return (
      <div
        className="mt-1 text-xs font-medium text-destructive"
        title="The sync reads a date cell or M/D/YYYY text. Until the cell on the Groups tab is fixed, this client gets no shared leads and no top-up pulls."
      >
        churn cell unreadable: &ldquo;{c.churn_cell}&rdquo;
      </div>
    );
  }
  return null;
}

/** "Groups tab" when the tab listed the client at the last good read. */
export function GroupsTabMark({ c }: { c: ClientRow }) {
  if (!c.on_groups_tab) return null;
  return (
    <div
      className="mt-1 flex items-center gap-1 whitespace-nowrap text-xs font-medium text-[var(--success)]"
      title={`Listed on the Groups tab at the last read${c.groups_tab_read_at ? ` (${new Date(c.groups_tab_read_at).toLocaleString()})` : ""}.`}
    >
      <Check className="size-3" /> Groups tab
    </div>
  );
}

/** The sharing pool (or "isolated"), then "can receive" or "cannot receive: reason". */
export function ReceiveCell({ c }: { c: ClientRow }) {
  return (
    <div className="space-y-0.5">
      <div
        className={`text-xs font-medium ${c.pool ? "" : "text-muted-foreground"}`}
        title={c.pool
          ? `Shares only inside the "${c.pool}" pool: its imports are checked against the pool's other clients, and it receives from them.`
          : "Isolated: it never receives a shared lead, and its imports are never shared."}
      >
        {c.pool ? `pool: ${c.pool}` : "isolated"}
      </div>
      {c.receive_block ? (
        <div
          className={`text-xs font-medium ${c.churned ? "text-muted-foreground" : "text-destructive"}`}
          title="Shared leads, top-up pulls and share pushes skip this client until this is fixed."
        >
          cannot receive: {c.receive_block}
        </div>
      ) : (
        <div className="text-xs font-medium text-[var(--success)]" title="Shared leads and top-up pulls may reach this client.">
          can receive
        </div>
      )}
    </div>
  );
}
