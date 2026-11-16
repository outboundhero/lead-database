"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Info, Loader2, Play, Search, Square, Table2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import type { EmployeeBand, RunMode } from "@/lib/aiark/types";
import type { CompaniesSetup, CompanyCountResult, CompanyRun, CompanyRunStatus, CompanyWorker, ModelPrice, PipelineView } from "@/lib/companies/types";
import type { LinkedinPlanView, PullSource } from "@/lib/linkedin/types";

// The Companies tab's pull side: what AI Ark will be asked for the client, its
// company filters (read-only: they are saved on the AI Ark tab), the count and
// the pull, and the client's pulls. Every figure on cost comes from the design's
// prices (AI Ark 0.1 credit a company; web searches and Reoon checks below).
// A pull searches either the client's rules (AI Ark) or its LinkedIn search
// (migration 128: its own places and keywords, edited on the AI Ark tab).

export const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");
export const cr = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bandText = (b: EmployeeBand) => (b.end ? `${fmt(b.start ?? 1)} to ${fmt(b.end)}` : `${fmt(b.start ?? 1)}+`);

const PER_COMPANY = 0.1; // AI Ark credits per company returned
// The worst case of a company's paid steps, from the settings: the website
// search and the two email searches, each at its model's prices and its most
// tool calls, and the Reoon checks (AI Ark's own email, then each general
// inbox written). Assumptions, kept high: a call's prompt and answer at 2,000
// and 1,000 tokens (reasoning included), 8,000 tokens of search content a
// search where the price gives none, and a Reoon check at instant-credit
// prices, the dearest.
const CALL_TOKENS_IN = 2_000;
const CALL_TOKENS_OUT = 1_000;
const SEARCH_TOKENS = 8_000;
const CHECK_USD = 0.0012;

/** Where a pull stops itself: ceil(size × 0.125) + searches + 2 credits. */
export const brake = (size: number, searches: number) => Math.ceil(size * 0.125) + Math.max(1, searches) + 2;

/** A model's prices, or the dearest held when it has none (as the daily caps count it). */
function priceOf(prices: PipelineView["prices"], model: string | null): ModelPrice {
  const known = Object.entries(prices)
    .filter(([k, v]) => k !== "web_search_call" && v && typeof v === "object")
    .map(([, v]) => v as ModelPrice);
  const p = model ? prices[model] : null;
  if (p && typeof p === "object") return p;
  return {
    in: Math.max(0, ...known.map((v) => v.in)),
    out: Math.max(0, ...known.map((v) => v.out)),
    search_tokens: Math.max(0, ...known.map((v) => v.search_tokens ?? 0)),
  };
}

/** The most a company's website and email searches and its Reoon checks could cost, at the settings' models and caps. */
export function worstPerCompany(p: PipelineView) {
  const perSearch = typeof p.prices.web_search_call === "number" ? p.prices.web_search_call : 0.01;
  let usd = 0;
  for (const s of p.steps) {
    const pr = priceOf(p.prices, s.model);
    const searchTokens = pr.search_tokens || SEARCH_TOKENS;
    usd += s.searches * (perSearch + (searchTokens * pr.in) / 1e6) + (CALL_TOKENS_IN * pr.in + CALL_TOKENS_OUT * pr.out) / 1e6;
  }
  return usd + (1 + p.inboxesPerCompany) * CHECK_USD;
}

export const RUN_STATUS: Record<CompanyRunStatus, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "bg-muted text-muted-foreground" },
  running: { label: "Pulling", cls: "bg-primary/12 text-primary" },
  done: { label: "Done", cls: "bg-[var(--success)]/15 text-[var(--success)]" },
  stopped: { label: "Stopped", cls: "bg-[var(--warning)]/15 text-[var(--warning)]" },
  error: { label: "Failed", cls: "bg-destructive/12 text-destructive" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
};

export const isActive = (r: CompanyRun) => r.status === "queued" || r.status === "running";

// ── Small layout parts, shared by the tab ───────────────────────────────────

export function Card({ title, sub, right, children, className }: { title: string; sub?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-2xl bg-card p-4 shadow-ios", className)}>
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {sub && <p className="text-[12px] text-muted-foreground">{sub}</p>}
        </div>
        {right && <div className="ml-auto shrink-0">{right}</div>}
      </div>
      {children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

// ── The source: AI Ark or LinkedIn ──────────────────────────────────────────

/**
 * Why the client's LinkedIn search of this kind can't be used here, or null:
 * the switch, its client list, the pipeline it needs, and the worker.
 */
export function linkedinWhyNot(li: LinkedinPlanView | null | undefined, tag: string, worker: CompanyWorker | null): string | null {
  if (!li) return "The LinkedIn search could not be read";
  if (!li.switch.enabled) return "LinkedIn searches are off (an admin can switch them on in the settings)";
  if (!li.switch.onList) return `${tag} is not on the LinkedIn searches' client list (an admin can add it in the settings)`;
  if (li.kind === "companies" && !li.switch.companies) return "Company pulls are off for this client, and a LinkedIn company search needs them";
  if (li.kind === "people" && !li.switch.people) return "People runs are off for this client, and a LinkedIn people search needs them";
  if (!worker?.linkedin) return "The worker that is running doesn't do LinkedIn searches yet";
  return null;
}

/** AI Ark (the client's rules) or LinkedIn (its LinkedIn search); LinkedIn is disabled, with its reason, when it can't be used. */
export function SourcePicker({ value, onChange, linkedinWhy }: { value: PullSource; onChange: (v: PullSource) => void; linkedinWhy: string | null }) {
  const option = (v: PullSource, label: string, disabled: boolean, title?: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={value === v}
      disabled={disabled}
      title={title}
      onClick={() => onChange(v)}
      className={cn(
        "inline-flex h-7 flex-1 items-center justify-center rounded-[10px] px-3 text-[12px] font-medium transition-all",
        value === v ? "bg-card text-foreground shadow-[0_2px_6px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.06)]" : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground"
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div role="tablist" className="inline-flex h-8 w-[220px] items-center rounded-xl bg-[oklch(0.92_0.004_264)] p-0.5 dark:bg-[oklch(0.22_0.005_264)]">
        {option("ai_ark", "AI Ark", false)}
        {option("linkedin", "LinkedIn", Boolean(linkedinWhy) && value !== "linkedin", linkedinWhy ?? undefined)}
      </div>
      {linkedinWhy && <span className="text-[12px] text-muted-foreground">LinkedIn: {linkedinWhy}.</span>}
    </div>
  );
}

/**
 * The client's LinkedIn search as the Companies tab shows it: its places (the
 * ones its sending rules allow are searched), its keywords (the ones AI Ark's
 * request can't hold are checked after the pull), the searches, and what stops
 * it. Its places and keywords are edited on the AI Ark tab.
 */
export function LinkedinPlanBox({ tag, plan }: { tag: string; plan: LinkedinPlanView }) {
  const k = plan.keywords;
  return (
    <div className="space-y-2 rounded-xl border border-border/70 p-3 text-[13px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">LinkedIn {plan.kind === "people" ? "people" : "company"} search</span>
        <span className="text-[12px] text-muted-foreground">
          {plan.searches} search{plan.searches === 1 ? "" : "es"}
          {plan.from === "row" ? ", this client's own places and keywords" : ", its rules' places and the starter keywords (no LinkedIn settings of its own yet)"}
        </span>
        <Button size="xs" variant="outline" className="ml-auto" asChild>
          <Link href={`/leads/ai-ark?client=${encodeURIComponent(tag)}`}>Edit on the AI Ark tab</Link>
        </Button>
      </div>
      {plan.blockers.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          {plan.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      <Row label="Places">
        {fmt(plan.placesSent)} searched
        {plan.notSearched ? (
          <span className="block text-[12px] text-[var(--warning)]">
            {fmt(plan.notSearched)} not searched: outside the client&apos;s sending rules (adding them to its rules brings them in)
          </span>
        ) : null}
        {plan.narrowed ? (
          <span className="block text-[12px] text-muted-foreground">
            {fmt(plan.narrowed)} state{plan.narrowed === 1 ? "" : "s"} or countr{plan.narrowed === 1 ? "y" : "ies"} searched as the rules&apos; places inside {plan.narrowed === 1 ? "it" : "them"}
          </span>
        ) : null}
        {plan.unplaced ? <span className="block text-[12px] text-muted-foreground">{fmt(plan.unplaced)} Clay values not placed (never searched)</span> : null}
      </Row>
      <Row label="Places left out">{plan.excludedPlaces ? fmt(plan.excludedPlaces) : "none"}</Row>
      <Row label="Keywords">
        {fmt(k.union)} left out, {fmt(k.sent)} phrases sent
        {k.checkedAfter ? <span className="block text-[12px] text-muted-foreground">{fmt(k.checkedAfter)} checked after the pull (AI Ark limit)</span> : null}
      </Row>
      <Row label="Filters">the standard titles, sizes, industries and company types, the same for every client</Row>
      {(plan.notes.length > 0 || plan.pullBlockers.length > 0) && (
        <ul className="space-y-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {plan.pullBlockers.map((n) => (
            <li key={n} className="flex gap-2 text-[var(--warning)]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {n}
            </li>
          ))}
          {plan.notes.map((n) => (
            <li key={n} className="flex gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" /> {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── What AI Ark will be asked ───────────────────────────────────────────────

export function PlanCard({ tag, setup }: { tag: string; setup: CompaniesSetup }) {
  const [showBody, setShowBody] = useState(false);
  const plan = setup.plan;
  if (!plan) return null;
  const r = plan.report;
  const places = { total: r.locations?.total ?? 0, examples: r.locations?.examples ?? [] };
  const dropped = r.locations?.dropped ?? [];
  const types = r.excludeCompanyTypes ?? [];
  return (
    <Card
      title="What AI Ark will be asked"
      sub={plan.searches ? `${plan.searches} search${plan.searches === 1 ? "" : "es"}, one for each group of places` : undefined}
    >
      {!setup.targeting && (
        <p className="mb-3 text-[13px] text-destructive">
          {tag} has no targeting rules yet. Add its locations and exclusions on the{" "}
          <Link className="font-medium underline" href="/clients">
            Clients page
          </Link>{" "}
          (Rules), or sync the sheet.
        </p>
      )}
      {plan.blockers.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          {plan.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {setup.targeting && (
        <div className="space-y-2 text-[13px]">
          <Row label="Places">
            {fmt(places.total)} place{places.total === 1 ? "" : "s"}
            {places.examples.length > 0 && (
              <span className="text-muted-foreground">
                : {places.examples.slice(0, 4).join(" · ")}
                {places.total > 4 ? " …" : ""}
              </span>
            )}
            {dropped.length > 0 && (
              <span className="block text-[12px] text-[var(--warning)]">
                {fmt(dropped.length)} {dropped.length === 1 ? "entry" : "entries"} left out (see the notes below)
              </span>
            )}
          </Row>
          <Row label="Places left out">
            {r.excludeLocations?.total
              ? `${fmt(r.excludeLocations.sent)}${r.excludeLocations.sent < r.excludeLocations.total ? ` of ${fmt(r.excludeLocations.total)}` : ""} sent`
              : "none"}
          </Row>
          <Row label="Exclusion terms">
            {r.excludeTerms?.total ? (
              <>
                {fmt(r.excludeTerms.sent)} of {fmt(r.excludeTerms.total)} sent
                {r.excludeTerms.standard ? ` (${fmt(r.excludeTerms.standard)} standard)` : ""}
                {r.excludeTerms.sent < r.excludeTerms.total && (
                  <span className="text-[var(--warning)]">; every company is checked against all of them after the pull</span>
                )}
              </>
            ) : (
              "none"
            )}
          </Row>
          <Row label="Company size">{r.bands?.length ? r.bands.map(bandText).join(", ") : "any"}</Row>
          <Row label="Industries">
            {r.industries ? `in ${fmt(r.industries)}` : "any"}
            {r.excludeIndustries ? `, ${fmt(r.excludeIndustries)} left out` : ""}
          </Row>
          <Row label="Company types">
            {types.length ? `no ${types.map((t) => t.replace(/_/g, " ").toLowerCase()).join(" or ")} companies` : "any"}
          </Row>
        </div>
      )}
      {(plan.notes.length > 0 || (plan.pullBlockers.length > 0 && !plan.blockers.length)) && (
        <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {plan.pullBlockers.map((n) => (
            <li key={n} className="flex gap-2 text-[var(--warning)]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {n}
            </li>
          ))}
          {plan.notes.map((n) => (
            <li key={n} className="flex gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" /> {n}
            </li>
          ))}
        </ul>
      )}
      {plan.example && (
        <div className="mt-3">
          <button type="button" onClick={() => setShowBody((v) => !v)} className="flex items-center gap-1 text-[12px] font-medium text-primary">
            <ChevronDown className={cn("size-3.5 transition-transform", showBody && "rotate-180")} />
            {showBody ? "Hide" : "Show"} the request{plan.searches > 1 ? " (first search)" : ""}
          </button>
          {showBody && (
            <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-muted p-3 text-[12px] leading-snug">{JSON.stringify(plan.example, null, 2)}</pre>
          )}
        </div>
      )}
      {setup.targeting && (
        <p className="mt-3 text-[12px] text-muted-foreground">
          Places and exclusions come from the client sheet, last changed{" "}
          {new Date(setup.targeting.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. Edit them on the{" "}
          <Link className="underline" href="/clients">
            Clients page
          </Link>
          .
        </p>
      )}
    </Card>
  );
}

// ── Company filters (read-only) ─────────────────────────────────────────────

export function FiltersCard({ tag, setup }: { tag: string; setup: CompaniesSetup }) {
  const f = setup.filters;
  const where = f.saved
    ? `Saved on the AI Ark tab${f.updatedAt ? ` on ${new Date(f.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}` : ""}.`
    : f.defaultsFrom === "cleaning"
      ? "The standard filters for cleaning clients: nothing is saved for this client yet."
      : "Nothing saved for this client: any size, any industry.";
  const list = (xs: string[]) => (xs.length > 6 ? `${xs.slice(0, 6).join(", ")} and ${fmt(xs.length - 6)} more` : xs.join(", "));
  return (
    <Card
      title="Company filters"
      sub={where}
      right={
        <Button size="xs" variant="outline" asChild>
          <Link href={`/leads/ai-ark?client=${encodeURIComponent(tag)}`}>Edit on the AI Ark tab</Link>
        </Button>
      }
    >
      <div className="space-y-2 text-[13px]">
        <Row label="Company size">{f.value.employee_bands.length ? f.value.employee_bands.map(bandText).join(", ") : "any"}</Row>
        <Row label="Industries">{f.value.industries.length ? list(f.value.industries) : "any"}</Row>
        <Row label="Left out">{f.value.exclude_industries.length ? list(f.value.exclude_industries) : "none"}</Row>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">
        The same size and industries go into the client&apos;s people pulls. Job titles, seniority and departments are for people only.
      </p>
    </Card>
  );
}

// ── Count and pull ──────────────────────────────────────────────────────────

type HeldCount = CompanyCountResult & { key: string };

export function PullCard({
  tag,
  setup,
  runs,
  onStarted,
  onReload,
}: {
  tag: string;
  setup: CompaniesSetup;
  runs: CompanyRun[];
  onStarted: (run: CompanyRun) => void;
  /** The rules or filters changed on the server: load them again. */
  onReload: () => void;
}) {
  const { modes, pipeline, worker, plan } = setup;
  const li = setup.linkedin;
  const [mode, setMode] = useState<RunMode>(() => (modes.demo.ready ? "demo" : "live"));
  const [source, setSource] = useState<PullSource>("ai_ark");
  const [count, setCount] = useState<HeldCount | null>(null);
  const [counting, setCounting] = useState(false);
  const [size, setSize] = useState(() => Math.min(100, pipeline.maxPullSize));
  const [starting, setStarting] = useState(false);

  // Keep the chosen source while it works; otherwise whichever is ready.
  useEffect(() => {
    setMode((m) => (modes[m].ready ? m : modes.demo.ready ? "demo" : "live"));
  }, [modes]);

  // LinkedIn while it can be used for this client; back to AI Ark when it can't any more.
  const liWhy = linkedinWhyNot(li, tag, worker);
  useEffect(() => {
    if (liWhy) setSource("ai_ark");
  }, [liWhy]);
  const linkedin = source === "linkedin" && li ? li : null;

  const versions = { rules: setup.targeting?.version ?? null, filters: setup.filters.version, linkedin: li?.version ?? null };
  // A count only counts for the client, mode, source and the versions it was made for.
  const countNow =
    count &&
    count.key === `${tag}|${mode}|${source}` &&
    (linkedin ? count.linkedinVersion === versions.linkedin : count.rulesVersion === versions.rules && count.filtersVersion === versions.filters)
      ? count
      : null;
  const searches = (linkedin ? linkedin.searches : plan?.searches) ?? 0;
  const blockers = (linkedin ? linkedin.blockers : plan?.blockers) ?? [];
  const pullBlockers = (linkedin ? linkedin.pullBlockers : plan?.pullBlockers) ?? [];
  const activeHere = runs.find((r) => isActive(r) && r.client_tag === tag);
  const ceiling = brake(size, searches);
  const worst = worstPerCompany(pipeline) * (Number.isFinite(size) ? Math.max(0, size) : 0);
  // 5 example companies on the first search, 1 on each other: 0.1 credit each.
  const countCost = PER_COMPANY * 5 + PER_COMPANY * Math.max(0, searches - 1);
  const canCount = pipeline.enabled && modes[mode].ready && !blockers.length && searches > 0 && !(source === "linkedin" && liWhy);

  const pullWhyNot =
    !pipeline.enabled ? "Company pulls are off" :
    pipeline.onList === false ? `${tag} is not on the company pulls' client list (an admin can add it in the settings)` :
    source === "linkedin" && liWhy ? liWhy :
    !modes[mode].ready ? modes[mode].why ?? "Not available" :
    !worker?.online ? "The service that runs pulls is off. Counting works" :
    !worker.companyRuns ? "The worker that is running doesn't do company pulls yet. Counting works" :
    blockers.length ? (linkedin ? "Fix what is listed under the LinkedIn company search" : "Fix what is listed under “What AI Ark will be asked”") :
    pullBlockers.length ? pullBlockers[0] :
    activeHere ? "This client already has a pull going" :
    !Number.isInteger(size) || size < 1 || size > pipeline.maxPullSize ? `Pull between 1 and ${fmt(pipeline.maxPullSize)} companies` :
    !countNow ? "Count the matches first: a pull starts after a count of these rules and filters" :
    null;

  const runCount = async () => {
    const key = `${tag}|${mode}|${source}`;
    setCounting(true);
    try {
      const res = await fetch("/api/companies/count", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          linkedin
            ? { tag, mode, source: "linkedin", linkedinVersion: versions.linkedin }
            : { tag, mode, rulesVersion: versions.rules, filtersVersion: versions.filters }
        ),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j.changed) onReload();
        throw new Error(j.error ?? "The count failed");
      }
      setCount({ ...j, key });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCounting(false);
    }
  };

  const start = async () => {
    if (!countNow) return;
    const which = linkedin ? "LinkedIn " : "";
    const what =
      mode === "demo"
        ? `a DEMO ${which}pull of ${fmt(size)} companies for ${tag}? They are made up, and nothing is bought from AI Ark.`
        : `a LIVE ${which}pull of ${fmt(size)} companies for ${tag}? About ${cr(size * PER_COMPANY)} AI Ark credits; the pull stops itself before passing ${fmt(ceiling)}. Website and email searches and email checks add at most about ${usd(worst)}.`;
    if (!window.confirm(`Start ${what}`)) return;
    setStarting(true);
    try {
      const res = await fetch("/api/companies/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          linkedin
            ? { tag, mode, size, matchCount: countNow.total, source: "linkedin", linkedinVersion: versions.linkedin }
            : { tag, mode, size, matchCount: countNow.total, rulesVersion: versions.rules, filtersVersion: versions.filters }
        ),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j.changed) {
          onReload();
          throw new Error(`${j.error ?? "Something changed since this page loaded."} The page now shows them as they are: count again, then start.`);
        }
        throw new Error(j.error ?? "Could not start the pull");
      }
      onStarted(j.run);
      toast.success("Pull queued. The worker picks it up in a few seconds.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const presets = [100, 500, 1000, 5000, 10000].filter((n) => n <= pipeline.maxPullSize);
  const left = setup.credits[mode];

  return (
    <Card
      title="Pull companies"
      sub="Each company AI Ark returns is added to the client's Companies table, enriched there, and listed below once a general email is found."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-20 text-[12.5px] text-muted-foreground">From</span>
          <IosSegmentedControl
            size="sm"
            className="w-[220px]"
            value={mode}
            onChange={(v) => {
              setMode(v);
              setCount(null);
            }}
            options={[{ value: "live", label: "AI Ark" }, ...(modes.demo.ready ? [{ value: "demo" as RunMode, label: "Demo" }] : [])]}
          />
          {mode === "live" && !modes.live.ready && <span className="text-[12px] text-[var(--warning)]">{modes.live.why}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="w-20 text-[12.5px] text-muted-foreground">Search</span>
          <SourcePicker
            value={source}
            onChange={(v) => {
              setSource(v);
              setCount(null);
            }}
            linkedinWhy={liWhy}
          />
        </div>
        {linkedin && <LinkedinPlanBox tag={tag} plan={linkedin} />}

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={runCount} variant="outline" disabled={counting || !canCount}>
            {counting ? <Loader2 className="animate-spin" /> : <Search />} Count matches
            <span className="text-[12px] text-muted-foreground">
              (up to {cr(countCost)} credit{countCost === 1 ? "" : "s"}
              {mode === "demo" ? ", demo" : ""})
            </span>
          </Button>
        </div>
        {countNow && <CountView count={countNow} />}

        <div className="flex flex-wrap items-center gap-3">
          <span className="w-20 text-[12.5px] text-muted-foreground">How many</span>
          <Input
            type="number"
            min={1}
            max={pipeline.maxPullSize}
            value={Number.isFinite(size) ? size : ""}
            onChange={(e) => setSize(Math.floor(Number(e.target.value)))}
            className="h-9 w-28 rounded-full text-[13px] tabular-nums"
            aria-label="Companies to pull"
          />
          {presets.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setSize(n)}
              className={cn("rounded-full px-3 py-1.5 text-[12px] font-medium", size === n ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent")}
            >
              {fmt(n)}
            </button>
          ))}
          <span className="text-[12px] text-muted-foreground">at most {fmt(pipeline.maxPullSize)} a pull for now</span>
        </div>

        <div className="space-y-1 rounded-xl bg-muted/60 px-3 py-2 text-[12.5px] leading-relaxed">
          {mode === "demo" ? (
            <p>
              About <b>{cr(size * PER_COMPANY)}</b> demo credits (made up: nothing is bought).
            </p>
          ) : (
            <p>
              <b>AI Ark:</b> about <b>{cr(size * PER_COMPANY)}</b> credits (0.1 a company). The pull stops itself before passing {fmt(ceiling)}. Companies
              an earlier pull bought for any client are copied in free when {linkedin ? "their head office is" : "they are"} in this client&apos;s places.
            </p>
          )}
          <p>
            <b>Searches and checks:</b> at most about <b>{usd(worst)}</b>, if every company took the website search and both email searches at their
            most tool calls, and a Reoon check for AI Ark&apos;s email and for each of up to {fmt(pipeline.inboxesPerCompany)} general inboxes. Companies
            outside the client&apos;s area, excluded, or already in the database cost nothing more. The day&apos;s spend caps hold the rest for the next day.
          </p>
          {left?.credits != null && (
            <p className="text-muted-foreground">
              {cr(left.credits)} AI Ark credits left{mode === "demo" ? " on the demo account" : ""}.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={start} disabled={!!pullWhyNot || starting} title={pullWhyNot ?? undefined}>
            {starting ? <Loader2 className="animate-spin" /> : <Play />} {mode === "demo" ? "Start demo pull" : "Start pull"}
          </Button>
        </div>
        {pullWhyNot && <p className="-mt-2 text-[12px] text-muted-foreground">{pullWhyNot}.</p>}
      </div>
    </Card>
  );
}

function CountView({ count }: { count: CompanyCountResult }) {
  return (
    <div className="rounded-xl border border-border/70 p-3">
      <p className="text-[13.5px]">
        <b className="text-[17px] tabular-nums">{fmt(count.total)}</b> companies match{count.mode === "demo" ? " (demo)" : ""}
        <span className="text-[12px] text-muted-foreground">
          {" "}
          · {cr(count.credits)} AI Ark credit{count.credits === 1 ? "" : "s"} used
          {count.perSearch.length > 1 ? ` · ${count.perSearch.map(fmt).join(" + ")}` : ""}
        </span>
      </p>
      <p className="mt-0.5 text-[12px] text-muted-foreground">
        {count.perSearch.length > 1 ? "Searches are added up, so a company with offices in two groups of places counts twice. " : ""}
        Includes companies bought before; a pull leaves them out or copies them in free.
      </p>
      {count.sample.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[520px] text-[12px]">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Company</th>
                <th className="py-1 pr-2 font-medium">Website</th>
                <th className="py-1 pr-2 font-medium">Head office</th>
                <th className="py-1 pr-2 font-medium">Employees</th>
                <th className="py-1 font-medium">Industry</th>
              </tr>
            </thead>
            <tbody>
              {count.sample.map((s, i) => (
                <tr key={i} className="border-t border-border/50 align-top">
                  <td className="py-1 pr-2">{s.name}</td>
                  <td className="py-1 pr-2">{s.domain ?? "not given"}</td>
                  <td className="py-1 pr-2">{s.place ?? "not given"}</td>
                  <td className="py-1 pr-2 tabular-nums">{s.employees ?? "not given"}</td>
                  <td className="py-1">{s.industry ?? "not given"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-1.5 text-[12px] text-muted-foreground">Examples only: they are not kept, so a pull may buy them again.</p>
    </div>
  );
}

// ── The client's pulls ──────────────────────────────────────────────────────

export function PullsCard({ tag, runs, onCancel }: { tag: string; runs: CompanyRun[]; onCancel: (run: CompanyRun) => void }) {
  return (
    <Card title="Pulls" sub={`${tag}'s 10 newest company pulls`}>
      {runs.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No company pulls for {tag} yet.</p>
      ) : (
        <div className="divide-y divide-border/60">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} onCancel={() => onCancel(r)} />
          ))}
        </div>
      )}
    </Card>
  );
}

function RunRow({ run, onCancel }: { run: CompanyRun; onCancel: () => void }) {
  const st = RUN_STATUS[run.status] ?? { label: run.status, cls: "bg-muted text-muted-foreground" };
  const pct = run.size_requested ? Math.min(100, Math.round((run.pulled / run.size_requested) * 100)) : 0;
  const when = new Date(run.started_at ?? run.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const parts = [
    `${fmt(run.pulled)} of ${fmt(run.size_requested)} pulled`,
    run.from_registry ? `${fmt(run.from_registry)} copied free` : "",
    run.bought_before ? `${fmt(run.bought_before)} bought before and paid again` : "",
    `${cr(run.credits_used)} credits`,
    run.match_count != null ? `${fmt(run.match_count)} matched at the count` : "",
  ].filter(Boolean);
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-semibold", st.cls)}>
          {run.status === "running" && <Loader2 className="mr-1 inline size-3 animate-spin" />}
          {st.label}
        </span>
        <span className="text-[13px] font-medium">
          {fmt(run.size_requested)} companies
          {run.source === "linkedin" && <span className="ml-1 rounded-full bg-primary/12 px-1.5 text-[12px] text-primary">LinkedIn</span>}
          {run.mode === "demo" && <span className="ml-1 rounded-full bg-muted px-1.5 text-[12px] text-muted-foreground">demo</span>}
        </span>
        <span className="text-[12px] text-muted-foreground">
          {run.started_at ? "Started" : "Queued"} {when}
          {run.created_by_name ? ` by ${run.created_by_name}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {run.table_id && (
            <Link href={`/leads/clay?t=${run.table_id}`} className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-[12px] font-medium hover:bg-accent">
              <Table2 className="size-3.5" /> Open table
            </Link>
          )}
          {isActive(run) && (
            <Button size="xs" variant="outline" className="text-destructive" onClick={onCancel}>
              <Square className="size-3" /> Cancel
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all", run.status === "error" ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-[12px] tabular-nums text-muted-foreground">{parts.join(" · ")}</p>
      {(run.stop_reason || run.last_error) && (
        <p className={cn("mt-1 text-[12px]", run.status === "error" ? "text-destructive" : "text-muted-foreground")}>
          {[run.stop_reason, run.last_error].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}
