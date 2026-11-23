"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Linkedin, Loader2, RefreshCw, Search, Table2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { Card, fmt } from "./pull-panel";
import { ContactLine, ContactsList } from "./contacts-list";
import { PAGE_SIZES, type CompaniesPage, type CompanyCounts, type CompanyRow, type FoundBy, type ListHas, type ListHome, type ListSort } from "@/lib/companies/types";

// The Companies tab's list side: the counts strip (listed companies by what
// lists them, the people and inboxes by verdict, and every other outcome as a
// count that opens those rows in the Clay section) and the list itself, read
// in keyset pages from /api/companies/list, so there is no row limit and a
// page costs the same however many companies a client has. Each company shows
// its general emails and up to 3 people; "all" opens every contact.

const ANY = "__any"; // a Select item can't have an empty value

const FOUND_LABEL: Record<FoundBy, string> = {
  database: "Database",
  aiark: "AI Ark",
  claygent_1: "First email search",
  claygent_2: "Second email search",
  search_1: "First search",
  search_2: "Second search",
};
/** The found-by values the filter offers (phase 1's two searches are only shown on old rows). */
const FOUND_FILTER: FoundBy[] = ["database", "aiark", "claygent_1", "claygent_2"];

// Outcomes (enrich_companies.outcome) not listed on the tab, in the order the
// strip shows them: the company row's own (company_outcome), then the
// projection's. Those the template works out open the Clay section on the
// row's own outcome cell; waiting and errors open it on the row status.
const NOT_LISTED: { outcome: string; label: string; status?: "waiting" | "error"; noLink?: boolean }[] = [
  { outcome: "Outside the client's area", label: "Outside the area" },
  { outcome: "Excluded by the client's rules", label: "Excluded by the rules" },
  { outcome: "A large company (brand list)", label: "A large company" },
  { outcome: "No inclusion keyword matched", label: "No inclusion keyword" },
  { outcome: "Stopped by the client's filters", label: "Stopped by the filters" },
  { outcome: "On the never-contact list", label: "Never contact" },
  { outcome: "General inbox already in the database", label: "Inbox already held" },
  { outcome: "People already in the database", label: "People already held" },
  { outcome: "General emails sent to checks", label: "Emails being checked" },
  { outcome: "No working website", label: "No working website" },
  { outcome: "No general email found", label: "No general email found" },
  { outcome: "Waiting for a key", label: "Waiting for a key", status: "waiting" },
  { outcome: "Error", label: "Errors", status: "error" },
  // Its cells say what the row it repeats says, so no filter singles it out.
  { outcome: "Listed under another row", label: "Same company as a listed row", noLink: true },
];
// What a listed company shows (the projection's words); phase 1's rows used the middle two.
const LISTED_OUTCOMES = ["General and people emails", "Has a general email", "Has people emails", "Already in the database"];

const PILL = {
  valid: "bg-[var(--success)]/15 text-[var(--success)]",
  catch_all: "bg-[var(--warning)]/15 text-[var(--warning)]",
  held: "bg-primary/12 text-primary",
  muted: "bg-muted text-muted-foreground",
  bad: "bg-destructive/12 text-destructive",
};

/** Phase 3: the shared fit score and the home-office flag, with the scorer's reason on hover. */
function FitLine({ row }: { row: CompanyRow }) {
  if (row.fit_score == null && row.home_office == null) {
    return <p className="mt-0.5 text-[12px] text-muted-foreground">Fit: not scored yet</p>;
  }
  const low = row.fit_score != null && row.fit_score < 2;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" title={row.fit_reason ?? undefined}>
      {row.fit_score != null && (
        <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", low ? PILL.bad : row.fit_score >= 4 ? PILL.valid : PILL.held)}>
          Fit {row.fit_score} of 5
        </span>
      )}
      {row.home_office === true && <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", PILL.catch_all)}>Likely a home office</span>}
    </div>
  );
}

/** A column filter the Clay section's grid reads from its address: the cell holds exactly this text. */
const cellIs = (col: string, value: string) => `${col}:is.${encodeURIComponent(value)}`;

function clayHref(tableId: string | null, params: Record<string, string>) {
  return tableId ? `/leads/clay?${new URLSearchParams({ t: tableId, ...params }).toString()}` : null;
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

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// ── Counts strip ────────────────────────────────────────────────────────────

function CountChip({ n, label, href, cls, title }: { n: number; label: string; href: string | null; cls: string; title?: string }) {
  const inner = (
    <>
      <span className="tabular-nums">{fmt(n)}</span> {label}
    </>
  );
  const base = cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium", cls);
  return href ? (
    <Link href={href} title={title ?? "Open these rows in the Clay section"} className={cn(base, "hover:opacity-80")}>
      {inner}
    </Link>
  ) : (
    <span className={base} title={title}>
      {inner}
    </span>
  );
}

export function CountsStrip({ counts }: { counts: CompanyCounts | null }) {
  if (!counts) return null;
  const t = counts.tableId;
  const pt = counts.peopleTableId;
  const it = counts.inboxTableId;
  const working = (counts.rows.queued ?? 0) + (counts.rows.running ?? 0);
  const known = new Set([...LISTED_OUTCOMES, ...NOT_LISTED.map((o) => o.outcome)]);
  const notListed = [
    ...NOT_LISTED.map((o) => ({
      ...o,
      n: counts.outcomes[o.outcome] ?? 0,
      href: o.noLink ? null : clayHref(t, o.status ? { status: o.status } : { f: cellIs("company_outcome", o.outcome) }),
    })),
    // An outcome this page doesn't know yet still shows.
    ...Object.entries(counts.outcomes)
      .filter(([o]) => !known.has(o))
      .map(([outcome, n]) => ({ outcome, label: outcome, n, href: clayHref(t, { f: cellIs("company_outcome", outcome) }) })),
  ].filter((o) => o.n > 0);
  const listed = counts.listed;
  const people = counts.people;
  const inboxes = counts.inboxes;
  const person = (outcome: string) => clayHref(pt, { f: cellIs("person_outcome", outcome) });
  const inbox = (outcome: string) => clayHref(it, { f: cellIs("inbox_outcome", outcome) });
  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-card p-4 shadow-ios md:flex-row">
      <div className="md:w-[300px] md:shrink-0">
        <p className="text-[12px] font-medium text-muted-foreground">Listed</p>
        <p className="text-[26px] font-semibold leading-tight tabular-nums">{fmt(listed.total)}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <CountChip n={listed.both} label="General and people emails" cls={PILL.valid} href={null} title="A new usable general email and at least one new usable person email" />
          <CountChip n={listed.general} label="Has a general email" cls={PILL.valid} href={null} title="A new usable general email, and no new person email" />
          <CountChip n={listed.people} label="Has people emails" cls={PILL.valid} href={null} title="New usable person emails, and no new general email" />
          <CountChip n={listed.held} label="Already in the database" cls={PILL.held} href={null} title="Every usable email of these companies is already a lead or in the Email Bison copy" />
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-3 md:border-l md:border-border/60 md:pl-4">
        <div>
          <p className="text-[12px] font-medium text-muted-foreground">People</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <CountChip n={people.looked} label="looked at" cls={PILL.muted} href={null} title="Everyone the people runs' Looks saw (1 credit a page of 100)" />
            <CountChip n={people.held} label="already held" cls={PILL.held} href={null} title="Seen by a Look and already in the database by name and company: not bought" />
            <CountChip n={people.bought} label="bought" cls={PILL.muted} href={pt ? `/leads/clay?t=${pt}` : null} title="Export Single calls made" />
            <CountChip n={people.approved} label="with an approved email" cls={PILL.valid} href={people.approved ? person("Approved email") : null} />
            <CountChip n={people.waiting} label="waiting for Enrichley" cls={PILL.catch_all} href={people.waiting ? person("Waiting for Enrichley") : null} />
            <CountChip n={people.noEmail} label="no email" cls={PILL.muted} href={people.noEmail ? person("No email (AI Ark found none)") : null} />
          </div>
        </div>
        <div>
          <p className="text-[12px] font-medium text-muted-foreground">General inboxes</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <CountChip n={inboxes.approved} label="approved" cls={PILL.valid} href={inboxes.approved ? inbox("Approved") : null} />
            <CountChip n={inboxes.waiting} label="waiting for Enrichley" cls={PILL.catch_all} href={inboxes.waiting ? inbox("Waiting for Enrichley") : null} />
            <CountChip n={inboxes.rejected} label="rejected" cls={PILL.bad} href={inboxes.rejected ? inbox("Rejected by Reoon") : null} />
          </div>
        </div>
        <div>
          <p className="text-[12px] font-medium text-muted-foreground">Not listed</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {notListed.map((o) => (
              <CountChip
                key={o.outcome}
                n={o.n}
                label={o.label}
                href={o.href}
                cls={o.outcome === "Error" ? PILL.bad : PILL.muted}
                title={o.href ? undefined : "These rows found the same company and office as a row already listed, so it is listed once"}
              />
            ))}
            {working > 0 && (
              <CountChip
                n={working}
                label="still being worked"
                cls="bg-primary/12 text-primary"
                href={clayHref(t, { status: counts.rows.queued ? "queued" : "running" })}
              />
            )}
            {notListed.length === 0 && working === 0 && <span className="text-[12.5px] text-muted-foreground">Nothing yet.</span>}
          </div>
        </div>
        {t && (
          <p className="text-[12px] text-muted-foreground">
            Each count opens those rows in the{" "}
            <Link className="underline" href={`/leads/clay?t=${t}`}>
              Clay section
            </Link>
            , where every step&apos;s input, answer and cost can be read. A company is listed once it has a usable general email or a usable person email.
          </p>
        )}
      </div>
    </section>
  );
}

// ── The list ────────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy the email"
      title="Copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1_500);
        } catch {
          toast.error("Could not copy the email");
        }
      }}
      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {done ? <Check className="size-3.5 text-[var(--success)]" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function CompanyLine({ row, tag }: { row: CompanyRow; tag: string }) {
  const [open, setOpen] = useState(false);
  const site = safeUrl(row.website) ?? safeUrl(row.domain);
  const linkedin = safeUrl(row.linkedin);
  const name = row.company || row.domain || "(no name)";
  const place = [row.city, row.state].filter(Boolean).join(", ");
  // Phase 1's rows have no contacts: their one general email and its Reoon status.
  const legacyPill = row.held
    ? { label: "In the database", cls: PILL.held }
    : row.email_status === "valid"
      ? { label: "Valid", cls: PILL.valid }
      : row.email_status === "catch_all"
        ? { label: "Catch-all", cls: PILL.catch_all }
        : null;
  const clay = clayHref(row.table_id, { q: (row.company || row.domain || "").toLowerCase() });
  const general = row.contacts.general;
  const people = row.contacts.people;
  const moreGeneral = Math.max(0, row.general_emails + row.general_waiting - general.length);
  const morePeople = Math.max(0, row.people_total - people.length);
  const more = moreGeneral + morePeople > 0;
  return (
    <Fragment>
      <tr className="border-b border-border/50 align-top last:border-0 hover:bg-muted/40">
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            {site ? (
              <a href={site} target="_blank" rel="noopener noreferrer" className="font-medium hover:text-primary hover:underline">
                {name}
              </a>
            ) : (
              <span className="font-medium">{name}</span>
            )}
            {linkedin && (
              <a href={linkedin} target="_blank" rel="noopener noreferrer" aria-label={`${name} on LinkedIn`} className="text-muted-foreground hover:text-primary">
                <Linkedin className="size-3.5" />
              </a>
            )}
          </div>
          {row.domain && <p className="text-[12px] text-muted-foreground">{row.domain}</p>}
          <p className="text-[12px] text-muted-foreground">{[place || row.country, row.industry].filter(Boolean).join(" · ")}</p>
          <FitLine row={row} />
        </td>
        <td className="px-3 py-2.5">
          {general.length ? (
            <div className="space-y-0.5">
              {general.map((c) => (
                <div key={c.row_id} className="flex items-center gap-0.5">
                  <ContactLine c={c} compact />
                  {c.email && <CopyButton text={c.email} />}
                </div>
              ))}
            </div>
          ) : row.general_email ? (
            <div>
              <div className="flex items-center gap-0.5">
                <span className="font-medium">{row.general_email}</span>
                <CopyButton text={row.general_email} />
              </div>
              {legacyPill && <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", legacyPill.cls)}>{legacyPill.label}</span>}
            </div>
          ) : (
            <span className="text-muted-foreground">none usable</span>
          )}
          {row.found_by && <p className="mt-0.5 text-[12px] text-muted-foreground">Found by {FOUND_LABEL[row.found_by] ?? row.found_by}</p>}
        </td>
        <td className="px-3 py-2.5">
          {people.length ? (
            <div className="space-y-1">
              {people.map((c) => (
                <ContactLine key={c.row_id} c={c} compact />
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">none yet</span>
          )}
          {more && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:underline">
              {open ? "Hide" : `All ${fmt(row.general_emails + row.general_waiting + row.people_total)}`} <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
            </button>
          )}
        </td>
        <td className="px-3 py-2.5 tabular-nums">{row.phone || <span className="text-muted-foreground">not given</span>}</td>
        <td className="px-3 py-2.5">
          <p>{row.run ? `Pull of ${day(row.run.created_at)}` : row.source}</p>
          <p className="text-[12px] text-muted-foreground">
            Listed {day(row.found_at)}
            {row.run?.copied ? " · copied free" : ""}
            {row.run?.mode === "demo" ? " · demo" : ""}
          </p>
        </td>
        <td className="px-3 py-2.5 text-right">
          <div className="flex flex-col items-end gap-1">
            {clay && (
              <Link
                href={clay}
                className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium hover:bg-accent"
                title="See every step for this company: its inputs, answers and costs"
              >
                <Table2 className="size-3.5" /> Open in the Clay section
              </Link>
            )}
            {!more && (general.length > 0 || people.length > 0) && (
              <button type="button" onClick={() => setOpen((o) => !o)} className="text-[12px] font-medium text-primary hover:underline">
                {open ? "Hide the contacts" : "The contacts"}
              </button>
            )}
          </div>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/50">
          <td colSpan={6} className="px-3 pb-3">
            <ContactsList tag={tag} row={row.row_id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function CompaniesTable({ tag, live, listedTotal }: { tag: string; live: boolean; listedTotal: number }) {
  const [sort, setSort] = useState<ListSort>("newest");
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [state, setState] = useState("");
  const [has, setHas] = useState<"" | ListHas>("");
  const [fitMin, setFitMin] = useState("");
  const [home, setHome] = useState<"" | ListHome>("");
  const [found, setFound] = useState<"" | FoundBy>("");
  const [hideHeld, setHideHeld] = useState(false);
  // The cursor each page visited was read with: the last one is the page on screen.
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [data, setData] = useState<CompaniesPage | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [states, setStates] = useState<{ state: string; n: number }[]>([]);
  const [tick, setTick] = useState(0);
  const req = useRef<AbortController | null>(null);
  const toFirst = () => setCursors([null]);

  // The search box is sent 300 ms after typing stops, and starts again from the first page.
  useEffect(() => {
    const now = q.trim();
    if (now === dq) return;
    const t = setTimeout(() => {
      setDq(now);
      setCursors([null]);
    }, 300);
    return () => clearTimeout(t);
  }, [q, dq]);

  const after = cursors[cursors.length - 1];
  const query = useMemo(() => {
    const sp = new URLSearchParams({ tag, sort, size: String(size) });
    if (after) sp.set("after", after);
    if (dq) sp.set("q", dq);
    if (state) sp.set("state", state);
    if (has) sp.set("has", has);
    if (fitMin) sp.set("fit", fitMin);
    if (home) sp.set("home", home);
    if (found) sp.set("found", found);
    if (hideHeld) sp.set("hideHeld", "1");
    return sp.toString();
  }, [tag, sort, size, after, dq, state, has, fitMin, home, found, hideHeld]);

  useEffect(() => {
    const ctl = new AbortController();
    req.current = ctl;
    const giveUp = setTimeout(() => ctl.abort(), 30_000);
    fetch(`/api/companies/list?${query}`, { signal: ctl.signal })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load the companies");
        return j as CompaniesPage;
      })
      .then((j) => {
        setData(j);
        setShown(query);
        setError(null);
        if (j.states) setStates(j.states);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setError(e?.message ?? "Could not load the companies");
      })
      .finally(() => {
        clearTimeout(giveUp);
        if (req.current === ctl) req.current = null;
      });
    return () => ctl.abort();
  }, [query, tick]);

  // While a pull or its rows are being worked, the first page is read again every 15 s.
  // Later pages stay as they are: new companies would shift them.
  const onFirst = cursors.length === 1;
  useEffect(() => {
    if (!live || !onFirst) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible" && !req.current) setTick((n) => n + 1);
    }, 15_000);
    return () => clearInterval(t);
  }, [live, onFirst]);

  const rows = data?.rows ?? [];
  const loading = shown !== query;
  const filtered = Boolean(dq || state || has || fitMin || home || found || hideHeld);
  const first = (cursors.length - 1) * size + 1;
  const stateOptions = state && !states.some((s) => s.state === state) ? [{ state, n: 0 }, ...states] : states;

  return (
    <Card
      title="Companies with emails"
      sub="Every company with a usable general email or a usable person email, held ones included. No row limit."
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search company, domain, email, city…"
            className="h-9 rounded-full pl-8 text-[13px]"
            aria-label="Search the companies"
          />
        </div>
        <Select
          value={state || ANY}
          onValueChange={(v) => {
            setState(v === ANY ? "" : v);
            toFirst();
          }}
        >
          <SelectTrigger size="sm" className="h-9 w-[180px] rounded-full text-[12.5px]" aria-label="State">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any state</SelectItem>
            {stateOptions.map((s) => (
              <SelectItem key={s.state} value={s.state}>
                {s.state}
                {s.n ? ` (${fmt(s.n)})` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={has || ANY}
          onValueChange={(v) => {
            setHas(v === ANY ? "" : (v as ListHas));
            toFirst();
          }}
        >
          <SelectTrigger size="sm" className="h-9 w-[190px] rounded-full text-[12.5px]" aria-label="Emails">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any emails</SelectItem>
            <SelectItem value="people">With people emails</SelectItem>
            <SelectItem value="general">With a general email</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={fitMin || ANY}
          onValueChange={(v) => {
            setFitMin(v === ANY ? "" : v);
            toFirst();
          }}
        >
          <SelectTrigger size="sm" className="h-9 w-[170px] rounded-full text-[12.5px]" aria-label="Fit score">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any fit score</SelectItem>
            {["2", "3", "4", "5"].map((n) => (
              <SelectItem key={n} value={n}>
                Fit score at least {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={home || ANY}
          onValueChange={(v) => {
            setHome(v === ANY ? "" : (v as ListHome));
            toFirst();
          }}
        >
          <SelectTrigger size="sm" className="h-9 w-[190px] rounded-full text-[12.5px]" aria-label="Home office">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Home office or not</SelectItem>
            <SelectItem value="yes">Likely a home office</SelectItem>
            <SelectItem value="no">Not a home office</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={found || ANY}
          onValueChange={(v) => {
            setFound(v === ANY ? "" : (v as FoundBy));
            toFirst();
          }}
        >
          <SelectTrigger size="sm" className="h-9 w-[170px] rounded-full text-[12.5px]" aria-label="Found by">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Found by any step</SelectItem>
            {FOUND_FILTER.map((k) => (
              <SelectItem key={k} value={k}>
                {FOUND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <IosToggle
            size="sm"
            checked={hideHeld}
            onCheckedChange={(v) => {
              setHideHeld(v);
              toFirst();
            }}
            aria-label="Hide companies already in the database"
          />
          Hide companies already in the database
        </label>
        <div className="ml-auto flex items-center gap-2">
          <IosSegmentedControl
            size="sm"
            className="w-[180px]"
            value={sort}
            onChange={(v) => {
              setSort(v);
              toFirst();
            }}
            options={[
              { value: "newest", label: "Newest" },
              { value: "name", label: "A to Z" },
            ]}
          />
          <Button size="sm" variant="outline" onClick={() => setTick((n) => n + 1)} aria-label="Refresh the list">
            <RefreshCw />
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          {error}{" "}
          <button type="button" className="font-semibold underline" onClick={() => setTick((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}

      <div className="relative overflow-x-auto rounded-xl border border-border/60">
        {!data && !error ? (
          <div className="flex min-h-[200px] items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <table className={cn("w-full min-w-[1180px] text-[12.5px] transition-opacity", loading && "opacity-60")}>
            <thead className="bg-muted/50 text-left text-[12px] text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-3 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">General emails</th>
                <th className="px-3 py-2 font-medium">People</th>
                <th className="px-3 py-2 font-medium">Phone</th>
                <th className="px-3 py-2 font-medium">From</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Clay section</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <CompanyLine key={r.row_id} row={r} tag={tag} />
              ))}
            </tbody>
          </table>
        )}
        {data && rows.length === 0 && (
          <div className="p-8 text-center text-[13px] text-muted-foreground">
            {filtered
              ? "No listed companies match these filters."
              : "No companies listed yet. A company shows here once a usable general email or person email is found for it."}
          </div>
        )}
      </div>

      {data && (rows.length > 0 || cursors.length > 1) && (
        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12.5px] text-muted-foreground">
          <span className="tabular-nums">
            {rows.length ? `${fmt(first)} to ${fmt(first + rows.length - 1)}` : "None"}
            {filtered ? " matching" : ` of ${fmt(listedTotal)}`}
          </span>
          <Select
            value={String(size)}
            onValueChange={(v) => {
              setSize(Number(v));
              toFirst();
            }}
          >
            <SelectTrigger size="sm" className="h-8 w-[140px] rounded-full text-[12.5px]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} per page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="outline"
              disabled={cursors.length <= 1}
              onClick={() => setCursors((c) => (c.length > 1 ? c.slice(0, -1) : c))}
              aria-label="Previous page"
            >
              <ChevronLeft />
            </Button>
            <span className="px-2 tabular-nums">Page {fmt(cursors.length)}</span>
            <Button
              size="icon-xs"
              variant="outline"
              disabled={!data.next || loading}
              onClick={() => data.next && setCursors((c) => [...c, data.next!])}
              aria-label="Next page"
            >
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
