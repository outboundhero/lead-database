"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Linkedin, Loader2, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TRACK_LABELS, type Contact, type ContactsPage } from "@/lib/companies/types";

// One company's general inboxes and people (enrich_contacts), read in keyset
// pages of 50 from /api/companies/contacts: each with its email, its verdict
// and a link to its row in the Clay section, where every step's input, answer
// and cost can be read.

/** A contact's verdict as a pill: what the tab shows beside an email. */
export function verdictPill(c: Contact): { label: string; cls: string } {
  if (c.verdict === "held") return { label: "In the database", cls: "bg-primary/12 text-primary" };
  if (c.verdict === "approved") return { label: "Approved", cls: "bg-[var(--success)]/15 text-[var(--success)]" };
  if (c.verdict === "enrichley") return { label: "Waiting for Enrichley", cls: "bg-[var(--warning)]/15 text-[var(--warning)]" };
  if (c.verdict === "rejected") return { label: "Rejected", cls: "bg-destructive/12 text-destructive" };
  if (c.verdict === "never_contact") return { label: "Never contact", cls: "bg-destructive/12 text-destructive" };
  if (c.verdict === "bounced") return { label: "Bounced", cls: "bg-destructive/12 text-destructive" };
  if (c.kind === "person" && !c.email) return { label: c.stage === "no_email" ? "No email (AI Ark)" : "No email yet", cls: "bg-muted text-muted-foreground" };
  return { label: c.outcome || "Not checked", cls: "bg-muted text-muted-foreground" };
}

/** Only http and https links are drawn: the values come from AI Ark and web searches. */
function safeUrl(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

export const clayRowHref = (c: Contact) =>
  `/leads/clay?${new URLSearchParams({ t: c.table_id, q: (c.email || c.full_name || "").toLowerCase() }).toString()}`;

export function ContactLine({ c, compact = false }: { c: Contact; compact?: boolean }) {
  const pill = verdictPill(c);
  const linkedin = safeUrl(c.linkedin);
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5", !compact && "py-1")}>
      {c.kind === "person" && <span className="font-medium">{c.full_name || "(no name)"}</span>}
      {c.kind === "person" && c.title && <span className="text-muted-foreground">{c.title}</span>}
      {linkedin && (
        <a href={linkedin} target="_blank" rel="noopener noreferrer" aria-label={`${c.full_name ?? "This person"} on LinkedIn`} className="text-muted-foreground hover:text-primary">
          <Linkedin className="size-3.5" />
        </a>
      )}
      {c.email && <span className={cn(c.kind === "general" && "font-medium")}>{c.email}</span>}
      <span title={c.outcome} className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", pill.cls)}>
        {pill.label}
      </span>
      {!compact && c.track && <span className="text-[12px] text-muted-foreground">{TRACK_LABELS[c.track]}</span>}
    </div>
  );
}

export function ContactsList({ tag, row }: { tag: string; row: number }) {
  const [rows, setRows] = useState<Contact[]>([]);
  const [totals, setTotals] = useState<ContactsPage["totals"] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const qs = new URLSearchParams({ tag, row: String(row), ...(after ? { after } : {}) });
        const res = await fetch(`/api/companies/contacts?${qs}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Could not load the company's contacts");
        const page = j as ContactsPage;
        setRows((r) => (after ? [...r, ...page.rows] : page.rows));
        if (page.totals) setTotals(page.totals);
        setNext(page.next);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the company's contacts");
      } finally {
        setLoading(false);
      }
    },
    [tag, row]
  );

  useEffect(() => {
    load(null);
  }, [load]);

  const general = rows.filter((c) => c.kind === "general");
  const people = rows.filter((c) => c.kind === "person");
  const section = (title: string, list: Contact[], total: number | undefined) => (
    <div className="min-w-0 flex-1">
      <p className="mb-1 text-[12px] font-medium text-muted-foreground">
        {title} {total != null ? `(${total.toLocaleString("en-US")})` : ""}
      </p>
      {list.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">None yet.</p>
      ) : (
        <ul className="divide-y divide-border/40">
          {list.map((c) => (
            <li key={c.row_id} className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <ContactLine c={c} />
              </div>
              <Link
                href={clayRowHref(c)}
                title="Open this row in the Clay section: every step's input, answer and cost"
                className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-muted px-2 py-0.5 text-[12px] font-medium hover:bg-accent"
              >
                <Table2 className="size-3" /> Open in the Clay section
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <div className="space-y-2 rounded-xl bg-muted/40 p-3 text-[12.5px]">
      {error && <p className="text-destructive">{error}</p>}
      {loading && !rows.length ? (
        <div className="flex min-h-[60px] items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      ) : (
        <div className="flex flex-col gap-4 md:flex-row">
          {section("General inboxes", general, totals?.general)}
          {section("People", people, totals?.people)}
        </div>
      )}
      {next && (
        <Button size="sm" variant="outline" onClick={() => load(next)} disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : null} Load more
        </Button>
      )}
    </div>
  );
}
