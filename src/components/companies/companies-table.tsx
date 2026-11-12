"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronLeft, ChevronRight, Copy, Linkedin, Loader2, RefreshCw, Search, Table2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { Card, fmt } from "./pull-panel";
import { PAGE_SIZES, type CompaniesPage, type CompanyCounts, type CompanyRow, type FoundBy, type ListSort } from "@/lib/companies/types";

// The Companies tab's list side: the counts strip (listed companies, and every
// other outcome as a count that opens those rows in the Clay section) and the
// list itself, read in keyset pages from /api/companies/list, so there is no
// row limit and a page costs the same however many companies a client has.

const ANY = "__any"; // a Select item can't have an empty value

const FOUND_LABEL: Record<FoundBy, string> = {
  database: "Database",
  aiark: "AI Ark",
  search_1: "First search",
  search_2: "Second search",
};

// Outcomes (enrich_companies.outcome) not listed on the tab, in the order the
// strip shows them. Those the template works out open the Clay section on the
// row's own Outcome value; waiting and errors open it on the row status.
const NOT_LISTED: { outcome: string; label: string; status?: "waiting" | "error"; noLink?: boolean }[] = [
  { outcome: "Outside the client's area", label: "Outside the area" },
  { outcome: "Excluded by the client's rules", label: "Excluded by the rules" },
  { outcome: "On the never-contact list", label: "Never contact" },
  { outcome: "No working website", label: "No working website" },
  { outcome: "No general email found", label: "No general email found" },
  { outcome: "Waiting for a key", label: "Waiting for a key", status: "waiting" },
  { outcome: "Error", label: "Errors", status: "error" },
  // Its cells say "Has a general email" like the row it repeats, so no filter singles it out.
  { outcome: "Listed under another row", label: "Same company as a listed row", noLink: true },
];
const LISTED_OUTCOMES = ["Has a general email", "Already in the database"];

const PILL = {
  valid: "bg-[var(--success)]/15 text-[var(--success)]",
  catch_all: "bg-[var(--warning)]/15 text-[var(--warning)]",
  held: "bg-primary/12 text-primary",
  muted: "bg-muted text-muted-foreground",
  bad: "bg-destructive/12 text-destructive",
};

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
  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-card p-4 shadow-ios md:flex-row">
      <div className="md:w-[300px] md:shrink-0">
        <p className="text-[12px] font-medium text-muted-foreground">Listed</p>
        <p className="text-[26px] font-semibold leading-tight tabular-nums">{fmt(listed.total)}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <CountChip n={listed.valid} label="Valid" cls={PILL.valid} href={listed.valid ? clayHref(t, { f: cellIs("email_verdict", "Valid") }) : null} />
          <CountChip n={listed.catchAll} label="Catch-all" cls={PILL.catch_all} href={listed.catchAll ? clayHref(t, { f: cellIs("email_verdict", "Catch-all") }) : null} />
          <CountChip
            n={listed.held}
            label="In the database"
            cls={PILL.held}
            href={listed.held ? clayHref(t, { f: cellIs("company_outcome", "Already in the database") }) : null}
          />
        </div>
      </div>
      <div className="min-w-0 flex-1 md:border-l md:border-border/60 md:pl-4">
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
        {t && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            Each count opens those rows in the{" "}
            <Link className="underline" href={`/leads/clay?t=${t}`}>
              Clay section
            </Link>
            , where every step&apos;s input, answer and cost can be read. Only companies with a usable general email are listed.
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

function CompanyLine({ row }: { row: CompanyRow }) {
  const site = safeUrl(row.website) ?? safeUrl(row.domain);
  const linkedin = safeUrl(row.linkedin);
  const name = row.company || row.domain || "(no name)";
  const place = [row.city, row.state].filter(Boolean).join(", ");
  const pill = row.held
    ? { label: "In the database", cls: PILL.held }
    : row.email_status === "valid"
      ? { label: "Valid", cls: PILL.valid }
      : row.email_status === "catch_all"
        ? { label: "Catch-all", cls: PILL.catch_all }
        : null;
  const clay = clayHref(row.table_id, { q: (row.company || row.domain || "").toLowerCase() });
  return (
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
      </td>
      <td className="px-3 py-2.5">
        {row.address && <p>{row.address}</p>}
        <p className={cn(row.address && "text-muted-foreground")}>{place || row.country || "not given"}</p>
      </td>
      <td className="px-3 py-2.5">
        {row.general_email ? (
          <div className="flex items-center gap-0.5">
            <span className="font-medium">{row.general_email}</span>
            <CopyButton text={row.general_email} />
          </div>
        ) : (
          <span className="text-muted-foreground">not given</span>
        )}
        <div className="mt-0.5 flex flex-wrap gap-1">
          {pill && <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", pill.cls)}>{pill.label}</span>}
          {row.email_kind && (
            <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", PILL.muted)}>{row.email_kind === "general" ? "General" : "Named"}</span>
          )}
        </div>
      </td>
      <td className="px-3 py-2.5">{row.found_by ? FOUND_LABEL[row.found_by] ?? row.found_by : "not given"}</td>
      <td className="px-3 py-2.5 tabular-nums">{row.phone || <span className="text-muted-foreground">not given</span>}</td>
      <td className="px-3 py-2.5">
        <p>{row.industry || <span className="text-muted-foreground">not given</span>}</p>
        {row.employees && <p className="text-[12px] text-muted-foreground">{row.employees} employees</p>}
      </td>
      <td className="px-3 py-2.5">
        <p>{row.run ? `Pull of ${day(row.run.created_at)}` : row.source}</p>
        <p className="text-[12px] text-muted-foreground">
          Listed {day(row.found_at)}
          {row.run?.copied ? " · copied free" : ""}
          {row.run?.mode === "demo" ? " · demo" : ""}
        </p>
      </td>
      <td className="px-3 py-2.5 text-right">
        {clay && (
          <Link
            href={clay}
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium hover:bg-accent"
            title="See every step for this company: its inputs, answers and costs"
          >
            <Table2 className="size-3.5" /> Open in the Clay section
          </Link>
        )}
      </td>
    </tr>
  );
}

export function CompaniesTable({ tag, live, listedTotal }: { tag: string; live: boolean; listedTotal: number }) {
  const [sort, setSort] = useState<ListSort>("newest");
  const [size, setSize] = useState<number>(PAGE_SIZES[0]);
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [state, setState] = useState("");
  const [status, setStatus] = useState<"" | "valid" | "catch_all">("");
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
    if (status) sp.set("status", status);
    if (found) sp.set("found", found);
    if (hideHeld) sp.set("hideHeld", "1");
    return sp.toString();
  }, [tag, sort, size, after, dq, state, status, found, hideHeld]);

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
  const filtered = Boolean(dq || state || status || found || hideHeld);
  const first = (cursors.length - 1) * size + 1;
  const stateOptions = state && !states.some((s) => s.state === state) ? [{ state, n: 0 }, ...states] : states;

  return (
    <Card
      title="Companies with a general email"
      sub="Every company we found a usable general email for, and those whose general inbox is already in the database. No row limit."
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
          value={status || ANY}
          onValueChange={(v) => {
            setStatus(v === ANY ? "" : (v as "valid" | "catch_all"));
            toFirst();
          }}
        >
          <SelectTrigger size="sm" className="h-9 w-[160px] rounded-full text-[12.5px]" aria-label="Email status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any email status</SelectItem>
            <SelectItem value="valid">Valid</SelectItem>
            <SelectItem value="catch_all">Catch-all</SelectItem>
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
            {(Object.keys(FOUND_LABEL) as FoundBy[]).map((k) => (
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
                <th className="px-3 py-2 font-medium">Office</th>
                <th className="px-3 py-2 font-medium">General email</th>
                <th className="px-3 py-2 font-medium">Found by</th>
                <th className="px-3 py-2 font-medium">Phone</th>
                <th className="px-3 py-2 font-medium">Industry</th>
                <th className="px-3 py-2 font-medium">From</th>
                <th className="px-3 py-2 font-medium">
                  <span className="sr-only">Clay section</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <CompanyLine key={r.row_id} row={r} />
              ))}
            </tbody>
          </table>
        )}
        {data && rows.length === 0 && (
          <div className="p-8 text-center text-[13px] text-muted-foreground">
            {filtered
              ? "No listed companies match these filters."
              : "No companies listed yet. A company shows here once its pull has found a usable general email for it."}
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
