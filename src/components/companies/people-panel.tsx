"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Loader2, Play, ShoppingCart, Square, Table2, Users } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import type { RunMode } from "@/lib/aiark/types";
import {
  ACTIVE_PEOPLE_RUN_STATUSES,
  TRACK_LABELS,
  TRACKS,
  type CompaniesSetup,
  type PeopleRun,
  type PeopleRunStatus,
  type PeopleSetup,
} from "@/lib/companies/types";
import { Card, cr, fmt, Row } from "./pull-panel";
import { CandidatesList } from "./candidates-list";

// The Companies tab's people side (phase 2): the people at a client's
// pipeline companies, from AI Ark. A run Looks first (People Preview by
// company id, 1 credit a page), screens everyone for free (the database, their
// own place, the client's exclusions, the track) and picks one person a track
// at each company; then, on a first run, it waits for a manager's Buy (Export
// Single per pick, 1 credit with an email). The tracks and their phrases come
// from the Clay originals; the excluded titles are the AI Ark tab's.

/** Export Single's price for a person with no email: 0 by AI Ark's docs, not yet seen live, so the estimate allows this. */
const MISS = 0.5;
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const PEOPLE_RUN_STATUS: Record<PeopleRunStatus, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "bg-muted text-muted-foreground" },
  running: { label: "Working", cls: "bg-primary/12 text-primary" },
  looked: { label: "Waiting for Buy", cls: "bg-[var(--warning)]/15 text-[var(--warning)]" },
  done: { label: "Done", cls: "bg-[var(--success)]/15 text-[var(--success)]" },
  stopped: { label: "Stopped", cls: "bg-[var(--warning)]/15 text-[var(--warning)]" },
  error: { label: "Failed", cls: "bg-destructive/12 text-destructive" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
};

export const isPeopleActive = (r: PeopleRun) => ACTIVE_PEOPLE_RUN_STATUSES.includes(r.status);
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** How many a Look looked at, found held, found outside and picked: what it found, before anything is bought. */
export function lookSummary(r: PeopleRun) {
  const v = r.verdicts;
  const held = (v.held ?? 0) + (v.never_contact ?? 0) + (v.bounced ?? 0);
  return `${fmt(r.looked)} looked at, ${fmt(held)} held, ${fmt(v.outside ?? 0)} outside, ${fmt(r.picked)} picked`;
}

/** What else a run's Look found: titles per track, batches past the page cap, companies left for the next run. */
function lookNotes(r: PeopleRun): string[] {
  const out: string[] = [];
  if (r.looked) out.push(`Titles per track: ${TRACKS.map((t) => `${TRACK_LABELS[t].toLowerCase()} ${fmt(r.tracks?.[t] ?? 0)}`).join(", ")}.`);
  if (r.capped_batches) out.push(`More people than a search may look at in ${fmt(r.capped_batches)} batch${r.capped_batches === 1 ? "" : "es"}: the rest were not looked at.`);
  if (r.more_companies) out.push("More companies were ready than one run takes: the next run takes the rest.");
  if (r.lost_answers) out.push(`${fmt(r.lost_answers)} AI Ark answer${r.lost_answers === 1 ? " was" : "s were"} lost, each counted at 1 credit.`);
  return out;
}

function Phrases({ phrases }: { phrases: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? phrases : phrases.slice(0, 8);
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((p) => (
        <span key={p} className="rounded-full bg-muted px-2 py-0.5 text-[12px]">
          {p}
        </span>
      ))}
      {phrases.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="rounded-full px-2 py-0.5 text-[12px] font-medium text-primary hover:underline">
          +{phrases.length - shown.length} more
        </button>
      )}
    </span>
  );
}

export function PeoplePanel({
  tag,
  setup,
  people,
  runs,
  onStarted,
  onChanged,
  onReload,
}: {
  tag: string;
  setup: CompaniesSetup;
  people: PeopleSetup | null;
  runs: PeopleRun[];
  onStarted: (run: PeopleRun) => void;
  /** A run changed on the server (Buy, Cancel): read the runs again. */
  onChanged: () => void;
  onReload: () => void;
}) {
  const { modes, worker } = setup;
  const [mode, setMode] = useState<RunMode>(() => (modes.demo.ready ? "demo" : "live"));
  const [maxPeople, setMaxPeople] = useState<number>(() => Math.min(30, people?.plan.settings.max_people_per_run ?? 30));
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [showCandidates, setShowCandidates] = useState<string | null>(null);

  useEffect(() => {
    setMode((m) => (modes[m].ready ? m : modes.demo.ready ? "demo" : "live"));
  }, [modes]);

  if (!people) {
    return (
      <Card title="People at these companies">
        <div className="flex min-h-[80px] items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      </Card>
    );
  }
  const plan = people.plan;
  const e = plan.estimate;
  const current = runs.find((r) => r.client_tag === tag && isPeopleActive(r)) ?? null;
  const max = plan.settings.max_people_per_run;
  const startWhyNot =
    plan.blockers[0] ??
    (!modes[mode].ready ? modes[mode].why ?? "Not available" :
    !worker?.online ? "The service that runs people runs is off" :
    !worker.peopleRuns ? "The worker that is running doesn't do people runs yet" :
    current ? "This client already has a people run going" :
    !Number.isInteger(maxPeople) || maxPeople < 1 || maxPeople > max ? `Buy between 1 and ${fmt(max)} people` :
    null);

  const start = async () => {
    const what =
      mode === "demo"
        ? `a DEMO people run for ${tag}? The people are made up, and nothing is bought from AI Ark.`
        : `a LIVE people run for ${tag}? The Look costs at least ${fmt(e.lookMin)} and at most ${fmt(e.lookMax)} AI Ark credits. Nothing is bought until you click Buy.`;
    if (!window.confirm(`Start ${what}`)) return;
    setStarting(true);
    try {
      const res = await fetch("/api/companies/people/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, mode, source: "ai_ark", maxPeople }),
      });
      const j = await res.json();
      if (!res.ok) {
        onReload();
        throw new Error(j.error ?? "Could not start the people run");
      }
      onStarted(j.run);
      toast.success("People run queued. The worker starts the Look in a few seconds.");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const act = async (run: PeopleRun, what: "buy" | "cancel") => {
    const ask =
      what === "buy"
        ? `Buy for this run? ${fmt(Math.min(run.picked, run.max_people))} people picked: at most ${fmt(Math.min(run.picked, run.max_people))} credits, plus ${MISS} a miss if a miss is charged (not yet seen live).`
        : "Cancel this people run? Nothing new is bought. Everyone bought or copied so far stays in the client's People table and is still worked.";
    if (!window.confirm(ask)) return;
    setBusy(run.id);
    try {
      const res = await fetch(`/api/companies/people/runs/${what}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: run.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Could not ${what === "buy" ? "approve the Buy" : "cancel the run"}`);
      toast.success(what === "buy" ? "Buy approved. The worker buys the picks next." : "People run cancelled");
      onChanged();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const tables = plan.tables;
  return (
    <Card
      title="People at these companies"
      sub="One person a track at each company, from AI Ark: operations, then facility and office, then CEO or owner. Each email is checked as the originals check it."
      right={
        <span className={cn("rounded-full px-2.5 py-1 text-[12px] font-medium", plan.on ? "bg-[var(--success)]/15 text-[var(--success)]" : "bg-muted text-muted-foreground")}>
          {plan.on ? "On for this client" : !plan.switchOn ? "People runs off" : "Not on the list"}
        </span>
      }
    >
      <div className="space-y-4 text-[13px]">
        {plan.blockers.length > 0 && (
          <ul className="space-y-1 rounded-xl bg-[var(--warning)]/12 px-3 py-2 text-[12.5px]">
            {plan.blockers.map((b) => (
              <li key={b} className="flex gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" /> {b}
              </li>
            ))}
          </ul>
        )}

        <div className="space-y-2">
          <Row label="Companies">
            <b>{fmt(plan.companies.eligible)}</b> ready for a run
            <span className="block text-[12px] text-muted-foreground">
              {fmt(plan.companies.passing)} pass the client&apos;s rules; {fmt(plan.companies.held)} skipped because someone usable is already held
              {plan.companies.looked ? `; ${fmt(plan.companies.looked)} looked at in the last ${plan.settings.recheck_days} days` : ""}
              {plan.companies.notChecked ? `; ${fmt(plan.companies.notChecked)} not checked against the database yet` : ""}
              {plan.companies.noId ? `; ${fmt(plan.companies.noId)} with no AI Ark id` : ""}.
            </span>
          </Row>
          <Row label="Tracks">
            {plan.tracks ? (
              <span className="flex flex-col gap-1.5">
                {plan.tracks.map((t) => (
                  <span key={t.track} className="block" title={t.from.length ? `From the originals: ${t.from.join(", ")}` : undefined}>
                    <span className="mr-1 font-medium">{t.label}:</span>
                    <Phrases phrases={t.phrases} />
                  </span>
                ))}
                <span className="text-[12px] text-muted-foreground">Read only: the phrases come from the original role steps. A title holding one, as whole words, belongs to that track.</span>
              </span>
            ) : (
              <span className="text-[var(--warning)]">Not loaded: the Clay originals&apos; seed writes them.</span>
            )}
          </Row>
          <Row label="Titles left out">
            {plan.excludedTitles.titles.length ? (
              <span>
                {fmt(plan.excludedTitles.titles.length)} {plan.excludedTitles.from === "cleaning" ? "(the cleaning defaults)" : "(saved for this client)"}
              </span>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}{" "}
            <Link className="font-medium text-primary hover:underline" href={`/leads/ai-ark?client=${encodeURIComponent(tag)}`}>
              Edit on the AI Ark tab
            </Link>
          </Row>
        </div>

        <div className="space-y-1 rounded-xl bg-muted/60 px-3 py-2 text-[12.5px] leading-relaxed">
          <p>
            <b>Look:</b> at least {fmt(e.lookMin)} credit{e.lookMin === 1 ? "" : "s"} ({fmt(e.searches)} search{e.searches === 1 ? "" : "es"} of {fmt(plan.settings.ids_per_search)} companies, one page each), at most {fmt(e.lookMax)} (every search to {fmt(plan.settings.pages_per_search)} pages).
          </p>
          <p>
            <b>Buy:</b> at most {fmt(Math.min(e.buyMax, maxPeople || 0))} people (one a track, 3 a company, at most {fmt(maxPeople || 0)} this run): 1 credit each with an email, plus {MISS} a miss if a miss is charged (not yet seen live).
          </p>
          {plan.aiSearches && (
            <p>
              <b>AI searches:</b> on, at most about {usd(e.aiSearchUsd)} of OpenAI for these companies, against today&apos;s cap of {usd(people.spend.openaiPipeline.cap)} ({usd(people.spend.openaiPipeline.used)} used).
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <IosSegmentedControl
            size="sm"
            className="w-[200px]"
            value={mode}
            onChange={setMode}
            options={[{ value: "live", label: "AI Ark" }, ...(modes.demo.ready ? [{ value: "demo" as RunMode, label: "Demo" }] : [])]}
          />
          <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            Most people
            <Input
              type="number"
              min={1}
              max={max}
              value={Number.isFinite(maxPeople) ? maxPeople : ""}
              onChange={(ev) => setMaxPeople(Math.floor(Number(ev.target.value)))}
              className="h-9 w-24 rounded-full text-[13px] tabular-nums"
              aria-label="Most people to buy"
            />
          </label>
          <Button onClick={start} disabled={!!startWhyNot || starting} title={startWhyNot ?? undefined}>
            {starting ? <Loader2 className="animate-spin" /> : <Play />} {mode === "demo" ? "Start demo Look" : "Start Look"}
          </Button>
        </div>
        {startWhyNot && <p className="-mt-2 text-[12px] text-muted-foreground">{startWhyNot}.</p>}

        {current && (
          <div className="space-y-2 rounded-xl border border-border/70 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", PEOPLE_RUN_STATUS[current.status].cls)}>{PEOPLE_RUN_STATUS[current.status].label}</span>
              <span className="text-[12.5px]">{lookSummary(current)}</span>
              {current.mode === "demo" && <span className="text-[12px] text-muted-foreground">demo</span>}
            </div>
            {lookNotes(current).map((n) => (
              <p key={n} className="text-[12px] text-muted-foreground">
                {n}
              </p>
            ))}
            {current.status === "looked" && (
              <p className="text-[12.5px]">
                Buying the picks costs at most <b>{fmt(Math.min(current.picked, current.max_people))}</b> credits, plus {MISS} a miss if a miss is charged (not yet seen live).
                {current.copied ? ` ${fmt(current.copied)} bought before are already copied in free.` : ""}
              </p>
            )}
            {current.status !== "looked" && current.bought > 0 && (
              <p className="text-[12.5px] text-muted-foreground">
                {fmt(current.bought)} bought ({fmt(current.with_email)} with an email), {fmt(current.settled)} of {fmt(current.companies)} companies settled.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {current.status === "looked" && (
                <Button size="sm" onClick={() => act(current, "buy")} disabled={busy === current.id}>
                  {busy === current.id ? <Loader2 className="animate-spin" /> : <ShoppingCart />} Buy
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => act(current, "cancel")} disabled={busy === current.id}>
                <Square /> Cancel
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowCandidates((s) => (s === current.id ? null : current.id))}>
                <Users /> {showCandidates === current.id ? "Hide the people seen" : "The people seen"} <ChevronDown className={cn("transition-transform", showCandidates === current.id && "rotate-180")} />
              </Button>
              {tables.people && (
                <Link href={`/leads/clay?t=${tables.people}`} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium hover:bg-accent">
                  <Table2 className="size-3.5" /> People table
                </Link>
              )}
            </div>
            {showCandidates === current.id && <CandidatesList runId={current.id} />}
          </div>
        )}

        <PeopleRunsList runs={runs.filter((r) => r.id !== current?.id)} onShow={(id) => setShowCandidates((s) => (s === id ? null : id))} shown={showCandidates} />
      </div>
    </Card>
  );
}

const PILL_OK = "flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[12px] font-medium shadow-ios";
const PILL_WARN = "flex items-center gap-1.5 rounded-full bg-[var(--warning)]/15 px-3 py-1.5 text-[12px] font-medium text-[var(--warning)]";
const dollars = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

/**
 * The pipeline's state for the client on screen: the Clay originals loaded,
 * the people runs' switch for this client, and today's spend against the
 * daily caps (UTC day).
 */
export function PipelinePills({ people }: { people: PeopleSetup | null }) {
  if (!people) return null;
  const o = people.originals;
  const plan = people.plan;
  const s = people.spend;
  const own = o.client?.complete ? ` (its own: ${fmt(o.client.total)})` : "";
  return (
    <>
      <span
        className={o.default.complete ? PILL_OK : PILL_WARN}
        title={
          o.default.complete
            ? `The pipeline's templates compile from these.${o.client ? ` This client's own export: ${fmt(o.client.total)} columns${o.client.complete ? "" : " (incomplete, so the shared set is used)"}.` : " This client has no export of its own, so the shared set is used."}`
            : "Pulls and people runs are refused until the Clay originals are loaded (scripts/enrich-seed-originals.mjs)."
        }
      >
        <Table2 className="size-3.5" /> Clay originals loaded: {fmt(o.default.total)}
        {own}
      </span>
      <span
        className={plan.on ? PILL_OK : PILL_WARN}
        title={plan.on ? "People runs are on for this client." : !plan.switchOn ? "People runs are off for every client." : "People runs are on, but this client is not on their list."}
      >
        <Users className="size-3.5" /> People runs {plan.on ? "on" : !plan.switchOn ? "off" : "not on for this client"}
      </span>
      <span
        className={s.reoon.used >= s.reoon.cap || s.openaiPipeline.used >= s.openaiPipeline.cap ? PILL_WARN : PILL_OK}
        title={`Today (UTC): ${fmt(s.reoon.used)} of the pipeline's ${fmt(s.reoon.cap)} Reoon checks; ${dollars(s.openaiPipeline.used)} of ${dollars(s.openaiPipeline.cap)} of OpenAI for the pipeline's AI steps; ${dollars(s.openaiFit.used)} of ${dollars(s.openaiFit.cap)} for fit scoring. Past a cap, those steps wait for the next day.`}
      >
        Today: {fmt(s.reoon.used)}/{fmt(s.reoon.cap)} Reoon · {dollars(s.openaiPipeline.used)}/{dollars(s.openaiPipeline.cap)} OpenAI
      </span>
    </>
  );
}

/**
 * The steps that wait for a key: each vendor, the original columns it holds
 * back, and whether the worker holds its key. A keyed step without its key is
 * skipped ("Needs <KEY> (not held)") and never makes a row wait.
 */
export function KeysList({ people }: { people: PeopleSetup | null }) {
  if (!people) return null;
  const waiting = people.keys.filter((k) => k.held !== true);
  if (!waiting.length) return null;
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5 rounded-2xl bg-card px-4 py-3 text-[12.5px] shadow-ios">
      <span className="font-medium">Steps waiting for keys:</span>
      {waiting.map((k) => (
        <span
          key={k.key}
          className="flex items-center gap-1 text-muted-foreground"
          title={
            k.built
              ? `${k.key} on the enrichment worker turns these on. Until then they show "Needs ${k.key} (not held)", are read as empty, and rows don't wait for them.${k.held === null ? " The worker does not say whether it holds this key." : ""}`
              : `Not built: no key for ${k.vendor} is held, and its place is filled another way.`
          }
        >
          <span className="font-medium text-foreground">{k.vendor}</span> ({k.holds}){k.built ? "" : ", not built"}
        </span>
      ))}
    </div>
  );
}

function PeopleRunsList({ runs, onShow, shown }: { runs: PeopleRun[]; onShow: (id: string) => void; shown: string | null }) {
  if (!runs.length) return null;
  return (
    <div>
      <p className="mb-1 text-[12px] font-medium text-muted-foreground">Earlier people runs</p>
      <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
        {runs.map((r) => (
          <li key={r.id} className="space-y-1 px-3 py-2 text-[12.5px]">
            <div className="flex flex-wrap items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", PEOPLE_RUN_STATUS[r.status].cls)}>{PEOPLE_RUN_STATUS[r.status].label}</span>
              <span>{when(r.created_at)}</span>
              <span className="text-muted-foreground">
                {lookSummary(r)}; {fmt(r.bought)} bought, {fmt(r.with_email)} with an email, {fmt(r.copied)} copied free; {cr(r.credits_used)} credits
                {r.mode === "demo" ? " (demo)" : ""}
              </span>
              <button type="button" onClick={() => onShow(r.id)} className="ml-auto text-[12px] font-medium text-primary hover:underline">
                {shown === r.id ? "Hide" : "People seen"}
              </button>
            </div>
            {(r.stop_reason || r.last_error) && (
              <p className={cn("text-[12px]", r.status === "error" ? "text-destructive" : "text-muted-foreground")}>{[r.stop_reason, r.last_error].filter(Boolean).join(" · ")}</p>
            )}
            {shown === r.id && <CandidatesList runId={r.id} />}
          </li>
        ))}
      </ul>
    </div>
  );
}
