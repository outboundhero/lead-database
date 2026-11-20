"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Copy, Loader2, MapPin, Play, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasPermission } from "@/lib/context/role-context";
import type { TopupClient, TopupFreeFirst, TopupHandRun, TopupPull, TopupView } from "@/app/api/topup/types";

// The Sharing page's "Low places" tab: the weekly top-up (migration 135).
// Each Active client of the covered types with its places under its minimum
// of good leads (from the newest weekly pass), what the pass did about them,
// the run it started, and its tag count beside, so a big client with low
// places reads clearly. Pulls waiting to start can be counted and started
// here (managers); "Run now" asks for a pass at once (admins). No props: the
// tab reads the viewer's role itself.
//
// "Free first" (plan 2.4): leads already in the database that a place fix
// would count for a client's low cities, as the pass counted them, with a
// link to the Locations page's Unresolved queue. AI Ark runs started by hand
// for clients that cannot receive (plan 2.7) are listed read only: the top-up
// cancels only its own runs.

const fmt = (n: number | null | undefined) => (n == null ? "?" : Math.round(n).toLocaleString("en-US"));
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "never");
const UNRESOLVED_QUEUE = "/locations?tab=unresolved";

/** A state key "US|IL" as words: the code, with its country when it is not the US. */
const stateWords = (key: string) => {
  const [country, state] = key.split("|");
  return state ? (country === "US" ? state : `${state} (${country})`) : key;
};
/** partial plus unresolved, null when neither was counted. */
const freeFirstSum = (f: TopupFreeFirst) => (f.partial == null && f.unresolved == null ? null : (f.partial ?? 0) + (f.unresolved ?? 0));
function freeFirstWords(f: TopupFreeFirst) {
  const partial = f.partial == null ? "not counted" : fmt(f.partial);
  const states = f.states.length
    ? f.states.map((s) => `${stateWords(s.key)} (${s.partial == null ? "not counted" : fmt(s.partial)})`).join(", ")
    : "its states";
  const unresolved = f.unresolved == null ? "not counted" : fmt(f.unresolved);
  const cities = f.unresolved == null ? "not counted" : f.cities.length ? f.cities.map((c) => `${c.label} (${fmt(c.unresolved)})`).join(", ") : "none";
  return {
    partial: `${partial} leads in ${states} whose city text the geo reference did not match (they count for no city place today, and the Locations page cannot fix them yet)`,
    unresolved: `${unresolved} unresolved leads whose place text names one of these cities (some may be a same-named city elsewhere): ${cities}`,
  };
}

const ACTION_WORDS: Record<string, string> = {
  none: "Nothing to do",
  prepared: "Pull prepared",
  started: "Pull started",
  budget: "Waiting for the weekly budget",
  pulls_per_day: "Waiting: the day's pulls have started",
  run_active: "Waiting: a run is going",
  not_on_pull_list: "Not on the top-up pull list",
  pull_mode_off: "Pulls are off",
  cannot_receive: "Cannot receive",
  no_people_filters: "No saved people filters",
  blocked: "Blocked",
  error: "Error",
};
const KIND_WORDS: Record<string, string> = {
  all_ok: "Every place has enough",
  no_places: "No places in its rules",
  no_rules: "No rules",
  not_covered: "Not covered",
};

async function send(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j;
}

function Pill({ tone = "plain", children, title }: { tone?: "plain" | "warn" | "good" | "bad"; children: React.ReactNode; title?: string }) {
  const cls = {
    plain: "bg-muted text-foreground",
    warn: "bg-[var(--warning)]/15 text-[var(--warning)]",
    good: "bg-[var(--success)]/15 text-[var(--success)]",
    bad: "bg-destructive/12 text-destructive",
  }[tone];
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium", cls)}>
      {children}
    </span>
  );
}

function copyPlaces(c: TopupClient) {
  const text = c.places
    .filter((p) => p.kind === "low")
    .map((p) => `${p.place?.city ?? p.place?.state ?? p.place?.country ?? p.label}${p.place?.city && p.place?.state ? `, ${p.place.state}` : ""}\t${p.available ?? 0}\t${p.minimum ?? ""}`)
    .join("\n");
  navigator.clipboard.writeText(text).then(
    () => toast.success(`Copied ${c.tag}'s low places`),
    () => toast.error("Your browser blocked the clipboard")
  );
}

function ClientRow({ c }: { c: TopupClient }) {
  const [open, setOpen] = useState(false);
  const low = c.places.filter((p) => p.kind === "low");
  const unknown = c.places.filter((p) => p.kind === "unresolved");
  const tone = c.receiveBlock ? "bad" : c.action === "started" ? "good" : c.action === "none" ? "plain" : "warn";
  const free = c.freeFirst ?? null;
  const freeSum = free ? freeFirstSum(free) : null;
  const freeText = free ? freeFirstWords(free) : null;
  return (
    <div className="border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-[13px]">
        <button type="button" className="flex min-w-36 items-center gap-1 font-semibold" onClick={() => setOpen(!open)} disabled={!c.places.length}>
          {c.places.length ? open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" /> : <span className="w-3.5" />}
          {c.tag}
        </button>
        <span className="min-w-28 text-[12px] text-muted-foreground">{c.clientType || "no type"}</span>
        {c.kind ? (
          <Pill tone={c.kind === "all_ok" ? "good" : "plain"} title={c.reason ?? undefined}>{KIND_WORDS[c.kind] ?? c.kind}</Pill>
        ) : (
          <Pill tone="warn">
            <MapPin className="size-3" />
            {low.length} low{unknown.length ? `, ${unknown.length} unknown` : ""} (minimum {fmt(c.minimum)})
          </Pill>
        )}
        {c.receiveBlock && <Pill tone="bad">cannot receive: {c.receiveBlock}</Pill>}
        {!c.kind && <Pill tone={tone} title={c.reason ?? undefined}>{ACTION_WORDS[c.action] ?? c.action}</Pill>}
        {free && freeText && (freeSum == null || freeSum > 0) && (
          <Pill tone="plain" title={`${freeText.partial}; ${freeText.unresolved}.`}>
            Free first: {freeSum == null ? "not counted" : fmt(freeSum)}
          </Pill>
        )}
        {c.runId && (
          <Link href={`/leads/ai-ark?client=${encodeURIComponent(c.tag)}`} className="text-[12px] font-medium text-primary hover:underline">
            Run {c.runId.slice(0, 8)}
          </Link>
        )}
        <span className="ml-auto text-[12px] text-muted-foreground" title="Leads carrying the client's tag (a tag count, not coverage)">
          {fmt(c.tagLeads)} tagged, {fmt(c.tagContactable)} contactable
        </span>
        {low.length > 0 && (
          <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px]" onClick={() => copyPlaces(c)}>
            <Copy className="mr-1 size-3" /> Copy list
          </Button>
        )}
      </div>
      {open && c.places.length > 0 && (
        <div className="space-y-1 px-9 pb-3 text-[12px]">
          {c.reason && <p className="text-muted-foreground">{c.reason}</p>}
          {free && freeText && (
            <p className="text-muted-foreground">
              {free.partial === 0 && free.unresolved === 0
                ? "Free first: none waiting for a place fix."
                : `Free first: ${freeText.partial}; ${freeText.unresolved}. `}
              {!(free.partial === 0 && free.unresolved === 0) && (
                <Link href={UNRESOLVED_QUEUE} className="font-medium text-primary hover:underline">
                  Locations page, Unresolved queue
                </Link>
              )}
            </p>
          )}
          {c.places.map((p) => (
            <div key={`${p.kind}|${p.placeKey}`} className="flex gap-3">
              <span className="w-56 truncate">{p.label}</span>
              {p.kind === "low" ? (
                <span className="tabular-nums">
                  {fmt(p.available)} of {fmt(p.minimum)}
                </span>
              ) : (
                <span className="text-destructive">not in the geo reference: fix the name in the rules</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PullRow({ p, view, onDone }: { p: TopupPull; view: TopupView; onDone: () => void }) {
  const canStart = useHasPermission("manager");
  const mode = view.modes?.live.ready ? "live" : view.modes?.demo.ready ? "demo" : null;
  const [busy, setBusy] = useState<"count" | "start" | null>(null);
  const [count, setCount] = useState<{ total: number; credits: number } | null>(
    p.matchCount != null && p.countedAt ? { total: p.matchCount, credits: p.countCredits } : null
  );
  const used = view.clientBudget[p.tag];

  const doCount = async () => {
    if (!mode) return;
    setBusy("count");
    try {
      const j = await send("/api/aiark/count", { tag: p.tag, mode, topupPullId: p.id });
      setCount({ total: j.total, credits: j.credits });
      toast.success(`${p.tag}: ${fmt(j.total)} people match (${j.credits} credits)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The count failed");
    } finally {
      setBusy(null);
    }
  };
  const doStart = async () => {
    if (!mode || !count) return;
    if (!window.confirm(`Start a ${mode} AI Ark pull of up to ${fmt(p.size)} people for ${p.tag} in ${p.labels.length} places? It may spend up to ${fmt(p.brake)} credits.`)) return;
    setBusy("start");
    try {
      await send("/api/aiark/runs", {
        tag: p.tag, mode, strategy: "single", size: p.size, matchCount: count.total,
        peopleVersion: p.peopleVersion, rulesVersion: p.rulesVersion, topupPullId: p.id,
      });
      toast.success(`${p.tag}: the pull is queued`);
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The pull did not start");
      onDone();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2.5 text-[13px] last:border-b-0">
      <span className="min-w-24 font-semibold">{p.tag}</span>
      <span className="min-w-0 flex-1 truncate text-[12px]" title={p.labels.join("; ")}>
        {p.labels.slice(0, 3).join("; ")}
        {p.labels.length > 3 ? ` and ${p.labels.length - 3} more` : ""}
      </span>
      <span className="text-[12px] tabular-nums">{fmt(p.size)} people, up to {fmt(p.brake)} credits</span>
      <Pill tone="plain">{p.mode === "auto" ? "auto" : "prepared"}</Pill>
      {used && (
        <span className="text-[12px] text-muted-foreground">
          {p.tag} this week: {fmt(used.used)} used, {fmt(used.reserved)} held
        </span>
      )}
      {count && <span className="text-[12px] tabular-nums">{fmt(count.total)} match ({fmt(p.countCredits || count.credits)} credits counted)</span>}
      {p.note && <span className="w-full pl-0 text-[12px] text-muted-foreground">{p.note}</span>}
      {canStart && (
        <div className="ml-auto flex gap-1.5">
          <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]" disabled={!mode || busy !== null} onClick={doCount}
            title={mode ? `Count in ${mode} mode: 1 credit a search` : "No AI Ark mode is ready on this server"}>
            {busy === "count" ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Search className="mr-1 size-3" />} Count
          </Button>
          <Button size="sm" className="h-7 px-2 text-[12px]" disabled={!mode || !count || busy !== null} onClick={doStart}
            title={count ? "Start the pull" : "Count first"}>
            {busy === "start" ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Play className="mr-1 size-3" />} Start
          </Button>
        </div>
      )}
    </div>
  );
}

/** One AI Ark run someone started by hand for a client that cannot receive now. Read only. */
function HandRunRow({ r }: { r: TopupHandRun }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b px-3 py-2.5 text-[13px] last:border-b-0">
      <span className="min-w-24 font-semibold">{r.tag}</span>
      <Link href={`/leads/ai-ark?client=${encodeURIComponent(r.tag)}`} className="text-[12px] font-medium text-primary hover:underline">
        Run {r.id.slice(0, 8)}
      </Link>
      <Pill tone={r.status === "running" ? "warn" : "plain"}>{r.status}</Pill>
      <span className="text-[12px] text-muted-foreground">{r.mode}</span>
      <span className="text-[12px] text-muted-foreground">
        started by {r.startedBy ?? "nobody recorded"} {when(r.createdAt)}
      </span>
      <span className="text-[12px] tabular-nums">{fmt(r.size)} people</span>
      <span className="text-[12px] tabular-nums">
        {r.creditsUsed.toLocaleString("en-US", { maximumFractionDigits: 1 })} credits used
      </span>
      <Pill tone="bad">cannot receive: {r.reason}</Pill>
    </div>
  );
}

export function LowPlacesTab() {
  const canView = useHasPermission("manager");
  const isAdmin = useHasPermission("admin");
  const [view, setView] = useState<TopupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [onlyLow, setOnlyLow] = useState(true);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/topup");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load the low places");
      setView(j as TopupView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the low places");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  const clients = useMemo(() => {
    const q = query.trim().toUpperCase();
    return (view?.clients ?? []).filter((c) => (!q || c.tag.includes(q)) && (!onlyLow || c.places.length > 0 || c.receiveBlock));
  }, [view, query, onlyLow]);

  if (!canView) return null;
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!view) return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading the low places</p>;
  if (!view.ready) return <p className="text-sm text-muted-foreground">The weekly top-up is not installed yet (migration 135).</p>;

  const s = view.settings;
  const runNow = async () => {
    setAsking(true);
    try {
      const j = await send("/api/topup/run", {});
      toast.success(j.note ?? "A pass was asked for");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not ask for a pass");
    } finally {
      setAsking(false);
    }
  };
  const pass = view.pass;
  const handRuns = view.handRuns ?? [];

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border bg-card p-4 text-[13px]">
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={s?.enabled ? "good" : "plain"}>Weekly top-up {s?.enabled ? "on" : "off"}</Pill>
          <Pill tone="plain">Pulls: {s?.pullMode ?? "off"}</Pill>
          <span className="text-muted-foreground">
            Covers {s?.clientTypes.join(", ") || "no type"}; default minimum {fmt(s?.defaultMinimum)} good leads a place.
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button variant="ghost" size="sm" className="h-8 text-[12px]" onClick={load} disabled={loading}>
              <RefreshCw className={cn("mr-1 size-3", loading && "animate-spin")} /> Reload
            </Button>
            {isAdmin && (
              <Button size="sm" className="h-8 text-[12px]" onClick={runNow} disabled={asking || !s?.enabled || pass?.state === "requested" || pass?.state === "running"}
                title={s?.enabled ? "Ask for a pass at the next hourly firing" : "Switch the weekly top-up on first"}>
                Run now
              </Button>
            )}
          </div>
        </div>
        {view.budget && (
          <p className="mt-2 text-muted-foreground">
            AI Ark credits in the last 7 days: {fmt(view.budget.used)} used and {fmt(view.budget.reserved)} held for runs going, of{" "}
            {fmt(view.budget.weekly)} (at most {fmt(view.budget.clientWeekly)} for one client). {fmt(view.budget.pullsToday)} of{" "}
            {fmt(view.budget.pullsPerDay)} top-up pulls started today (UTC).
          </p>
        )}
        <p className="mt-1 text-muted-foreground">
          {pass
            ? `Newest pass: ${pass.state}${pass.state === "running" ? ` (${pass.clientsDone} clients done)` : ""}, asked ${when(pass.requestedAt)}${
                pass.requestedByName ? ` by ${pass.requestedByName}` : pass.trigger === "schedule" ? " by the schedule" : ""
              }${pass.finishedAt ? `, finished ${when(pass.finishedAt)}` : ""}.`
            : "No pass has run yet."}
          {view.lastDone && pass?.id !== view.lastDone.id ? ` The last finished pass ended ${when(view.lastDone.finishedAt)}.` : ""}
          {pass?.lastError ? ` Last error: ${pass.lastError}` : ""}
        </p>
        {view.freeFirst?.unresolvedTotal != null && (
          <p className="mt-1 text-muted-foreground">
            Leads anywhere whose place text the location cron could not read: {fmt(view.freeFirst.unresolvedTotal)} (at the pass). Fixing
            place text costs nothing:{" "}
            <Link href={UNRESOLVED_QUEUE} className="font-medium text-primary hover:underline">
              Locations page, Unresolved queue
            </Link>
          </p>
        )}
      </div>

      {view.pulls.length > 0 && (
        <div className="rounded-2xl border bg-card">
          <p className="border-b px-3 py-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            Pulls waiting to start ({view.pulls.length})
          </p>
          {view.pulls.map((p) => (
            <PullRow key={p.id} p={p} view={view} onDone={load} />
          ))}
        </div>
      )}

      {handRuns.length > 0 && (
        <div className="rounded-2xl border bg-card">
          <div className="border-b px-3 py-2">
            <p className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
              AI Ark runs started by hand for clients that cannot receive ({handRuns.length})
            </p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              The weekly top-up cancels only its own runs. These were started by hand, so they keep going: cancel one on the AI Ark tab if it
              should stop.
            </p>
          </div>
          {handRuns.map((r) => (
            <HandRunRow key={r.id} r={r} />
          ))}
        </div>
      )}

      <div className="rounded-2xl border bg-card">
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Client tag" className="h-8 w-40 text-[13px]" />
          <label className="flex items-center gap-1.5 text-[12px]">
            <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
            Only clients with low places or that cannot receive
          </label>
          <span className="ml-auto text-[12px] text-muted-foreground">{clients.length} of {view.clients.length} clients</span>
        </div>
        {clients.length === 0 ? (
          <p className="px-3 py-4 text-[13px] text-muted-foreground">{pass ? "Nothing to show." : "The first pass has not run."}</p>
        ) : (
          clients.map((c) => <ClientRow key={c.tag} c={c} />)
        )}
      </div>
    </div>
  );
}
