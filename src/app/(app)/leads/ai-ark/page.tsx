"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronDown, Info, Loader2, Play, RefreshCw, Save, Search, Square, Table2, UserSearch } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagInput } from "@/components/ui/ios/tag-input";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import { AccessDenied } from "@/components/layout/access-denied";
import { useHasPermission } from "@/lib/context/role-context";
import { ClientSelector } from "@/components/filters/client-selector";
import type { AiArkPlan, AiArkRun, AiArkSetup, CountResult, EmployeeBand, PeopleFilters, RunMode, RunStatus, RunStrategy } from "@/lib/aiark/types";

// The AI Ark tab: pick a client, check what AI Ark would be asked (the
// client's locations and exclusions from its rules, plus people filters saved
// here), count, and pull. Each pull becomes a table on the Clay tab, where the
// enrichment worker works out every person's outcome. Nothing on this page
// adds anyone to the lead database.

const BANDS: { label: string; start: number; end?: number }[] = [
  { label: "1–10", start: 1, end: 10 },
  { label: "11–50", start: 11, end: 50 },
  { label: "51–200", start: 51, end: 200 },
  { label: "201–500", start: 201, end: 500 },
  { label: "501–1,000", start: 501, end: 1000 },
  { label: "1,001–5,000", start: 1001, end: 5000 },
  { label: "5,001–10,000", start: 5001, end: 10000 },
  { label: "10,001+", start: 10001 },
];

const SENIORITY_LABEL: Record<string, string> = {
  founder: "Founder", owner: "Owner", partner: "Partner", c_suite: "C-suite", vp: "VP", director: "Director",
  head: "Head", manager: "Manager", senior: "Senior", mid_level: "Mid-level", entry: "Entry", intern: "Intern",
};

const STATUS: Record<RunStatus, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "bg-muted text-muted-foreground" },
  running: { label: "Pulling", cls: "bg-primary/12 text-primary" },
  done: { label: "Done", cls: "bg-[var(--success)]/15 text-[var(--success)]" },
  stopped: { label: "Stopped", cls: "bg-[var(--warning)]/15 text-[var(--warning)]" },
  error: { label: "Failed", cls: "bg-destructive/12 text-destructive" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
};

// The Outcome column's answers (scripts/lib/aiark/columns.mjs), best first.
const OUTCOMES: { key: string; cls: string }[] = [
  { key: "Ready to add", cls: "bg-[var(--success)]/15 text-[var(--success)]" },
  { key: "Already in the database", cls: "bg-muted text-muted-foreground" },
  { key: "Bought in an earlier run", cls: "bg-muted text-muted-foreground" },
  { key: "No email", cls: "bg-muted text-muted-foreground" },
  { key: "Outside the client's area", cls: "bg-[var(--warning)]/15 text-[var(--warning)]" },
  { key: "Excluded by the client's rules", cls: "bg-[var(--warning)]/15 text-[var(--warning)]" },
  { key: "Bounced", cls: "bg-destructive/12 text-destructive" },
  { key: "On the never-contact list", cls: "bg-destructive/12 text-destructive" },
];

const EMAIL_RATE = 0.6; // assumed share of people with a valid email, for estimates
const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");
const cr = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const isActive = (r: AiArkRun) => r.status === "queued" || r.status === "running";
const bandKey = (b: EmployeeBand) => `${b.start ?? ""}-${b.end ?? ""}`;

/** The same arithmetic as estimateCredits in scripts/lib/aiark/filters.mjs. */
function estimate(strategy: RunStrategy, size: number, searches: number) {
  const n = Math.max(0, Math.floor(size));
  if (strategy === "export") return { low: n * 0.5, expected: Math.round(n * (0.5 + 0.5 * EMAIL_RATE)), high: n };
  const pages = Math.ceil(n / 100) + Math.max(0, searches - 1);
  return { low: pages, expected: pages + Math.round(n * EMAIL_RATE), high: pages + n };
}

export default function AiArkPage() {
  return (
    <Suspense fallback={null}>
      <AiArkTab />
    </Suspense>
  );
}

function AiArkTab() {
  const canView = useHasPermission("manager");
  const router = useRouter();
  const tag = useSearchParams().get("client")?.toUpperCase() ?? null;
  const [setup, setSetup] = useState<AiArkSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<PeopleFilters | null>(null);
  const [saved, setSaved] = useState<PeopleFilters | null>(null);
  const [plan, setPlan] = useState<AiArkPlan | null>(null);
  const [planErrors, setPlanErrors] = useState<string[]>([]);
  const [planning, setPlanning] = useState(false);
  const [saving, setSaving] = useState(false);
  const [count, setCount] = useState<CountResult | null>(null);
  const [counting, setCounting] = useState(false);
  const [runs, setRuns] = useState<AiArkRun[]>([]);
  const [mode, setMode] = useState<RunMode>("demo");
  const [strategy, setStrategy] = useState<RunStrategy>("single");
  const [size, setSize] = useState(500);
  const [starting, setStarting] = useState(false);
  const [showBody, setShowBody] = useState(false);
  const planFor = useRef<string>("");

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(`/api/aiark/setup${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load the AI Ark tab");
      const s = j as AiArkSetup;
      setSetup(s);
      setRuns(s.runs);
      setForm(s.people.value);
      setSaved(s.people.saved ? s.people.value : null);
      setPlan(s.plan);
      setPlanErrors([]);
      planFor.current = JSON.stringify(s.people.value);
      // Keep the chosen source while it works; otherwise whichever is ready (demo first when both are).
      setMode((m) => (s.modes[m].ready ? m : s.modes.demo.ready ? "demo" : "live"));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the AI Ark tab");
    }
  }, [tag]);

  /** Balance, runs and worker only — never the filters being edited. */
  const refreshQuietly = useCallback(async () => {
    try {
      const res = await fetch(`/api/aiark/setup${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
      if (!res.ok) return;
      const s = (await res.json()) as AiArkSetup;
      setSetup((prev) => (prev ? { ...prev, credits: s.credits, worker: s.worker, modes: s.modes } : prev));
      setRuns(s.runs);
    } catch {
      /* the next poll tries again */
    }
  }, [tag]);

  useEffect(() => {
    if (!canView) return;
    setSetup(null);
    setCount(null);
    load();
  }, [canView, load]);

  // What AI Ark would be asked, for the filters on screen (no AI Ark call).
  useEffect(() => {
    if (!tag || !form) return;
    const key = JSON.stringify(form);
    if (key === planFor.current) return;
    setPlanning(true);
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/aiark/setup", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tag, filters: form }),
          signal: ctl.signal,
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Could not work out the plan");
        planFor.current = key;
        setPlan(j.plan);
        setPlanErrors(j.errors ?? []);
        setCount(null);
      } catch (e) {
        if ((e as Error).name !== "AbortError") toast.error((e as Error).message);
      } finally {
        setPlanning(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [tag, form]);

  // Runs: every 2.5 s while one is going, else every 20 s. When one ends, the balance is re-read.
  const anyActive = runs.some(isActive);
  const wasActive = useRef(false);
  useEffect(() => {
    if (!setup) return;
    if (wasActive.current && !anyActive) refreshQuietly();
    wasActive.current = anyActive;
    const t = setTimeout(async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const res = await fetch(`/api/aiark/runs${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
        const j = await res.json();
        if (res.ok) setRuns(j.runs);
      } catch {
        /* the next tick tries again */
      }
    }, anyActive ? 2_500 : 20_000);
    return () => clearTimeout(t);
  }, [setup, runs, anyActive, tag, refreshQuietly]);

  if (!canView) return <AccessDenied />;

  const dirty = !!form && (!saved || !same(form, saved));
  const set = <K extends keyof PeopleFilters>(k: K, v: PeopleFilters[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!tag || !form) return;
    setSaving(true);
    try {
      const res = await fetch("/api/aiark/people-filters", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, filters: form }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not save");
      setForm(j.value);
      setSaved(j.value);
      setSetup((s) => (s ? { ...s, people: { saved: true, updatedAt: j.updatedAt, defaultsFrom: null, value: j.value } } : s));
      toast.success(`People filters saved for ${tag}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runCount = async () => {
    if (!tag || !form) return;
    setCounting(true);
    try {
      const res = await fetch("/api/aiark/count", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, mode, filters: form }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "The count failed");
      setCount(j);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCounting(false);
    }
  };

  const start = async () => {
    if (!tag) return;
    const est = estimate(strategy, size, plan?.searches ?? 1);
    const what = mode === "demo" ? "a DEMO pull (made-up people, nothing bought)" : `a LIVE pull — about ${cr(est.expected)} AI Ark credits, at most ${cr(est.high)}`;
    if (!window.confirm(`Start ${what} of ${fmt(size)} people for ${tag}?`)) return;
    setStarting(true);
    try {
      const res = await fetch("/api/aiark/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, mode, strategy, size, matchCount: count?.mode === mode ? count.total : null }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not start the pull");
      setRuns((rs) => [j.run, ...rs]);
      toast.success(setup?.worker?.online ? "Pull queued — the worker picks it up in a few seconds" : "Pull queued — start the enrichment worker to run it");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async (run: AiArkRun) => {
    const extra = run.strategy === "export" ? " An export job AI Ark has already accepted still finishes and is charged." : "";
    if (!window.confirm(`Cancel this pull? Everyone pulled so far stays in its table.${extra}`)) return;
    const res = await fetch("/api/aiark/runs/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: run.id }),
    });
    const j = await res.json();
    if (!res.ok) return toast.error(j.error ?? "Could not cancel");
    toast.success(j.note ?? "Pull cancelled");
    setRuns((rs) => rs.map((r) => (r.id === run.id ? { ...r, status: "cancelled" } : r)));
  };

  const modes = setup?.modes;
  const est = estimate(strategy, size, plan?.searches ?? 1);
  const blockers = [...(plan?.blockers ?? []), ...planErrors];
  const exportReady = mode === "demo" || !!modes?.exportLive.ready;
  const activeHere = runs.find((r) => isActive(r) && r.client_tag === tag);
  const pullWhyNot =
    !tag ? "Pick a client" :
    !modes?.[mode].ready ? modes?.[mode].why ?? "Not available" :
    blockers.length ? "Fix what is listed under “What AI Ark will be asked”" :
    plan?.pullBlockers.length ? plan.pullBlockers[0] :
    dirty ? "Save the people filters first — a pull always uses the saved filters" :
    strategy === "export" && !exportReady ? modes?.exportLive.why ?? "Export needs a webhook address" :
    activeHere ? "This client already has a pull going" :
    !Number.isInteger(size) || size < 1 || size > 10_000 ? "Pull between 1 and 10,000 people" :
    null;

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <UserSearch className="size-5" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">AI Ark</h1>
            <p className="text-[12.5px] text-muted-foreground">Pull people from AI Ark into the Clay tab — one table per pull</p>
          </div>
        </div>
        <div className="ml-2">
          <ClientSelector clientTag={tag} onChange={(t) => router.replace(t ? `/leads/ai-ark?client=${encodeURIComponent(t)}` : "/leads/ai-ark")} />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {setup && <ModePill setup={setup} />}
          {setup && !setup.worker?.online && (
            <span
              title="Pulls are worked by the enrichment worker. Start it with: npm run enrich-worker"
              className="flex items-center gap-1.5 rounded-full bg-[var(--warning)]/15 px-3 py-1.5 text-[12px] font-medium text-[var(--warning)]"
            >
              <AlertTriangle className="size-3.5" /> Worker not running
            </span>
          )}
          <Button size="sm" variant="outline" onClick={load} aria-label="Reload">
            <RefreshCw />
          </Button>
        </div>
      </div>

      {setup && !setup.modes.live.ready && setup.modes.demo.ready && (
        <div className="flex gap-3 rounded-2xl bg-primary/8 p-4 text-[13px] leading-relaxed">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p>
            <span className="font-semibold">Demo mode.</span> AI Ark isn&apos;t connected yet (no <code>AIARK_API_KEY</code>), so counts and pulls use
            made-up people from a stand-in that never leaves this machine — every web address ends in <code>.example</code> and nothing is bought.
            Live pulls switch on when the key is added to the web app and the worker.
          </p>
        </div>
      )}

      {loadError && (
        <div className="rounded-2xl bg-destructive/10 p-4 text-[13px] text-destructive">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {!setup && !loadError && (
        <div className="flex min-h-[200px] items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      )}

      {setup && !tag && (
        <div className="rounded-2xl bg-card p-10 text-center shadow-ios">
          <p className="text-[15px] font-semibold">Pick a client to start</p>
          <p className="mx-auto mt-1 max-w-lg text-[13px] text-muted-foreground">
            The client&apos;s locations and exclusions come from its rules (the client sheet). Job titles, seniority and company size are set here and
            saved per client.
          </p>
        </div>
      )}

      {setup && tag && form && plan && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <Card title="Client rules" sub={setup.client?.name ? `${tag} · ${setup.client.name}` : tag}>
              {!setup.targeting ? (
                <p className="text-[13px] text-destructive">
                  {tag} has no targeting rules yet. Add its locations and exclusions on the{" "}
                  <Link className="font-medium underline" href="/clients">
                    Clients page
                  </Link>{" "}
                  (Rules), or sync the sheet.
                </p>
              ) : (
                <div className="space-y-2.5 text-[13px]">
                  <Row label="Locations">
                    {fmt(setup.targeting.places)} places
                    {plan.report.locations.examples.length > 0 && (
                      <span className="text-muted-foreground"> — {plan.report.locations.examples.slice(0, 4).join(" · ")}{setup.targeting.places > 4 ? " …" : ""}</span>
                    )}
                  </Row>
                  <Row label="Exclusions">
                    {fmt(setup.targeting.excludeTerms)} terms
                    {plan.report.excludeTerms && plan.report.excludeTerms.sent < plan.report.excludeTerms.total && (
                      <span className="text-[var(--warning)]"> ({fmt(plan.report.excludeTerms.sent)} sent to AI Ark, all re-checked after)</span>
                    )}
                  </Row>
                  {setup.targeting.commercialCleaning && (
                    <Row label="Cleaning">Job titles on the cleaning title exclusions are re-checked after the pull</Row>
                  )}
                  <p className="text-[11.5px] text-muted-foreground">
                    From the client sheet, last changed {new Date(setup.targeting.updatedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.
                    Edit them on the <Link className="underline" href="/clients">Clients page</Link>.
                  </p>
                </div>
              )}
            </Card>

            <Card
              title="People filters"
              sub="Saved per client — the client sheets don't have these"
              right={
                <div className="flex items-center gap-2">
                  {dirty && saved && (
                    <Button size="xs" variant="ghost" onClick={() => setForm(saved)}>
                      Undo changes
                    </Button>
                  )}
                  <Button size="sm" onClick={save} disabled={!dirty || saving || planErrors.length > 0}>
                    {saving ? <Loader2 className="animate-spin" /> : <Save />} {saved && !dirty ? "Saved" : "Save"}
                  </Button>
                </div>
              }
            >
              {!setup.people.saved && (
                <p className="mb-3 rounded-xl bg-[var(--warning)]/12 px-3 py-2 text-[12.5px] leading-relaxed">
                  {setup.people.defaultsFrom === "cleaning"
                    ? "A starting point for cleaning clients: owner, operations and facility / office manager roles, and the titles to skip. Not saved yet — change anything, then Save."
                    : "Nothing saved for this client yet. Add job titles, seniority or departments, then Save."}
                </p>
              )}
              <div className="space-y-4">
                <Field label="Job titles" hint="Their current main role. Smart also finds related titles (“CEO” finds “Chief Executive Officer”); Word needs the words; Strict needs the exact title.">
                  <TagInput values={form.titles} onChange={(v) => set("titles", v)} placeholder="Office Manager, Facilities Director…" maxTags={300} />
                  <IosSegmentedControl
                    size="sm"
                    className="mt-2"
                    value={form.title_mode}
                    onChange={(v) => set("title_mode", v)}
                    options={[
                      { value: "SMART", label: "Smart" },
                      { value: "WORD", label: "Word" },
                      { value: "STRICT", label: "Strict" },
                    ]}
                  />
                </Field>
                <Field label="Leave out titles" hint="Matched as words: “sales” leaves out “Sales Manager”.">
                  <TagInput values={form.exclude_titles} onChange={(v) => set("exclude_titles", v)} placeholder="sales, recruiter…" maxTags={300} />
                </Field>
                <Field label="Seniority">
                  <Chips
                    options={setup.suggestions.seniority.map((s) => ({ value: s, label: SENIORITY_LABEL[s] ?? s }))}
                    values={form.seniority}
                    onChange={(v) => set("seniority", v)}
                  />
                </Field>
                <Field label="Departments" hint="AI Ark's own department names, written like facility_administration.">
                  <TagInput values={form.departments} onChange={(v) => set("departments", v)} placeholder="facility_administration…" maxTags={300} />
                  <Suggest values={form.departments} options={setup.suggestions.departments} onAdd={(v) => set("departments", [...form.departments, v])} />
                </Field>
                <Field label="Company size (employees)">
                  <Chips
                    options={BANDS.map((b) => ({ value: bandKey(b), label: b.label }))}
                    values={form.employee_bands.map(bandKey)}
                    onChange={(keys) =>
                      set(
                        "employee_bands",
                        keys.map((k) => {
                          const b = BANDS.find((x) => bandKey(x) === k) ?? form.employee_bands.find((x) => bandKey(x) === k)!;
                          return { start: b.start, ...(b.end ? { end: b.end } : {}) };
                        })
                      )
                    }
                  />
                  {form.employee_bands.length === 0 && <p className="mt-1 text-[11.5px] text-muted-foreground">Any size</p>}
                </Field>
                <Field label="Industries" hint="AI Ark's industry names (lower-case). Leave empty for any industry; the client's exclusions still apply.">
                  <TagInput values={form.industries} onChange={(v) => set("industries", v)} placeholder="facilities services…" maxTags={300} splitOn={null} />
                  <Suggest values={form.industries} options={setup.suggestions.industries} onAdd={(v) => set("industries", [...form.industries, v])} />
                </Field>
                <Field label="Leave out industries">
                  <TagInput values={form.exclude_industries} onChange={(v) => set("exclude_industries", v)} placeholder="restaurants…" maxTags={300} splitOn={null} />
                </Field>
                {planErrors.length > 0 && (
                  <ul className="space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
                    {planErrors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <Card
              title="What AI Ark will be asked"
              sub={plan.searches ? `${plan.searches} search${plan.searches === 1 ? "" : "es"}${dirty ? " · with the filters on screen" : ""}` : undefined}
              right={planning ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            >
              {blockers.length > 0 && (
                <ul className="mb-3 space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
                  {blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {plan.searches > 0 && (
                <div className="space-y-2 text-[13px]">
                  <Row label="People in">{fmt(plan.report.locations.total)} places</Row>
                  <Row label="Job titles">
                    {plan.report.titles ? `${fmt(plan.report.titles)} (${(plan.report.titleMode ?? "SMART").toLowerCase()} match)` : "any"}
                    {plan.report.excludeTitles ? `, ${fmt(plan.report.excludeTitles)} left out` : ""}
                  </Row>
                  <Row label="Seniority">{plan.report.seniority?.length ? plan.report.seniority.map((s) => SENIORITY_LABEL[s] ?? s).join(", ") : "any"}</Row>
                  <Row label="Departments">{plan.report.departments?.length ? plan.report.departments.join(", ") : "any"}</Row>
                  <Row label="Company size">{plan.report.bands?.length ? plan.report.bands.map((b) => `${fmt(b.start)}${b.end ? `–${fmt(b.end)}` : "+"}`).join(", ") : "any"}</Row>
                  <Row label="Companies">
                    leaving out {fmt(plan.report.excludeTerms?.sent)} exclusion term{plan.report.excludeTerms?.sent === 1 ? "" : "s"}
                    {plan.report.industries ? `, in ${fmt(plan.report.industries)} industries` : ""}
                  </Row>
                </div>
              )}
              {(plan.notes.length > 0 || (plan.pullBlockers.length > 0 && !blockers.length)) && (
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
                    <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-muted p-3 text-[11px] leading-snug">{JSON.stringify(plan.example, null, 2)}</pre>
                  )}
                </div>
              )}
            </Card>

            <Card
              title="Pull people"
              sub="Each pull becomes a table on the Clay tab, where every person's outcome is worked out"
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
                    options={[
                      { value: "live", label: "AI Ark" },
                      ...(modes?.demo.ready ? [{ value: "demo" as RunMode, label: "Demo" }] : []),
                    ]}
                  />
                  {mode === "live" && !modes?.live.ready && <span className="text-[12px] text-[var(--warning)]">{modes?.live.why}</span>}
                </div>
                <div className="flex flex-wrap items-start gap-3">
                  <span className="mt-1.5 w-20 text-[12.5px] text-muted-foreground">How</span>
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <IosSegmentedControl
                      size="sm"
                      className="w-[260px]"
                      value={strategy}
                      onChange={setStrategy}
                      options={[
                        { value: "single", label: "One at a time" },
                        { value: "export", label: "Export job" },
                      ]}
                    />
                    <p className="text-[12px] leading-relaxed text-muted-foreground">
                      {strategy === "single"
                        ? "Pages through the matches (1 credit per 100), then gets each new person's email — 1 credit only when one is found. People without an email cost nothing, but keep a masked last name."
                        : "AI Ark exports everyone in one job: 0.5 credits a person plus 0.5 for each email found. Full names and company websites even without an email."}
                      {strategy === "export" && !exportReady && <span className="block text-[var(--warning)]">{modes?.exportLive.why}</span>}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="w-20 text-[12.5px] text-muted-foreground">How many</span>
                  <Input
                    type="number"
                    min={1}
                    max={10000}
                    value={Number.isFinite(size) ? size : ""}
                    onChange={(e) => setSize(Math.floor(Number(e.target.value)))}
                    className="h-9 w-28 rounded-full text-[13px] tabular-nums"
                  />
                  {[100, 500, 1000, 5000].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setSize(n)}
                      className={cn("rounded-full px-3 py-1.5 text-[12px] font-medium", size === n ? "bg-primary text-primary-foreground" : "bg-muted hover:bg-accent")}
                    >
                      {fmt(n)}
                    </button>
                  ))}
                </div>
                <div className="rounded-xl bg-muted/60 px-3 py-2 text-[12.5px] leading-relaxed">
                  {mode === "demo" ? (
                    <>About <b>{cr(est.expected)}</b> demo credits (made up — nothing is bought).</>
                  ) : (
                    <>
                      About <b>{cr(est.expected)}</b> AI Ark credits — at least {cr(est.low)}, at most {cr(est.high)} if everyone has an email.
                    </>
                  )}{" "}
                  <span className="text-muted-foreground">Assumes 6 in 10 people have an email. Nobody already bought is bought again.</span>
                  {setup.credits[mode]?.credits != null && (
                    <span className="block text-muted-foreground">{cr(setup.credits[mode]!.credits)} credits left{mode === "demo" ? " on the demo account" : ""}.</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={runCount} variant="outline" disabled={counting || !modes?.[mode].ready || blockers.length > 0}>
                    {counting ? <Loader2 className="animate-spin" /> : <Search />} Count matches
                    <span className="text-[11.5px] text-muted-foreground">
                      ({plan.searches || 1} credit{(plan.searches || 1) === 1 ? "" : "s"}{mode === "demo" ? ", demo" : ""})
                    </span>
                  </Button>
                  <Button onClick={start} disabled={!!pullWhyNot || starting} title={pullWhyNot ?? undefined}>
                    {starting ? <Loader2 className="animate-spin" /> : <Play />} {mode === "demo" ? "Start demo pull" : "Start pull"}
                  </Button>
                </div>
                {pullWhyNot && tag && <p className="-mt-2 text-[12px] text-muted-foreground">{pullWhyNot}.</p>}
                {count && <CountView count={count} />}
              </div>
            </Card>

            <Card title="Pulls" sub={`${tag}'s AI Ark runs, newest first`}>
              {runs.length === 0 ? (
                <p className="text-[13px] text-muted-foreground">No pulls for {tag} yet.</p>
              ) : (
                <div className="divide-y divide-border/60">
                  {runs.map((r) => (
                    <RunRow key={r.id} run={r} onCancel={() => cancel(r)} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

function ModePill({ setup }: { setup: AiArkSetup }) {
  const live = setup.credits.live;
  if (setup.modes.live.ready) {
    return (
      <span
        title={live?.error ?? "AI Ark credits left (read just now)"}
        className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[12px] font-medium shadow-ios"
      >
        <span className={cn("size-2 rounded-full", live?.error ? "bg-destructive" : "bg-[var(--success)]")} />
        {live?.error ? "AI Ark not answering" : `AI Ark · ${cr(live?.credits)} credits`}
      </span>
    );
  }
  return (
    <span
      title={setup.modes.live.why ?? undefined}
      className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[12px] font-medium shadow-ios"
    >
      <span className="size-2 rounded-full bg-muted-foreground/50" />
      {setup.modes.demo.ready ? `Demo mode · ${cr(setup.credits.demo?.credits)} demo credits` : "AI Ark needs a key"}
    </span>
  );
}

function CountView({ count }: { count: CountResult }) {
  return (
    <div className="rounded-xl border border-border/70 p-3">
      <p className="text-[13.5px]">
        <b className="text-[17px] tabular-nums">{fmt(count.total)}</b> people match{count.mode === "demo" ? " (demo)" : ""}
        <span className="text-[12px] text-muted-foreground">
          {" "}
          · {count.credits} credit{count.credits === 1 ? "" : "s"} used{count.perSearch.length > 1 ? ` · ${count.perSearch.map(fmt).join(" + ")}` : ""}
        </span>
      </p>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">Includes people bought before; a pull leaves them out.</p>
      {count.sample.length > 0 && (
        <table className="mt-2 w-full text-[12px]">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 font-medium">Name</th>
              <th className="py-1 font-medium">Title</th>
              <th className="py-1 font-medium">Company</th>
              <th className="py-1 font-medium">Place</th>
            </tr>
          </thead>
          <tbody>
            {count.sample.map((p, i) => (
              <tr key={i} className="border-t border-border/50">
                <td className="py-1 pr-2">{p.name}</td>
                <td className="py-1 pr-2">{p.title ?? "—"}</td>
                <td className="py-1 pr-2">{p.company ?? "—"}</td>
                <td className="py-1">{p.place ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="mt-1.5 text-[11px] text-muted-foreground">A preview: AI Ark hides last names and emails until a person is pulled.</p>
    </div>
  );
}

function RunRow({ run, onCancel }: { run: AiArkRun; onCancel: () => void }) {
  const st = STATUS[run.status];
  const pct = run.size_requested ? Math.min(100, Math.round((run.pulled / run.size_requested) * 100)) : 0;
  const when = new Date(run.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const waiting = run.strategy === "export" && run.status === "running" && run.job_state && run.job_state !== "DONE";
  return (
    <div className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-semibold", st.cls)}>
          {run.status === "running" && <Loader2 className="mr-1 inline size-3 animate-spin" />}
          {st.label}
        </span>
        <span className="text-[13px] font-medium">
          {fmt(run.size_requested)} people · {run.strategy === "single" ? "one at a time" : "export job"}
          {run.mode === "demo" && <span className="ml-1 rounded-full bg-muted px-1.5 text-[10.5px] text-muted-foreground">demo</span>}
        </span>
        <span className="text-[12px] text-muted-foreground">
          {when}
          {run.created_by_name ? ` · ${run.created_by_name}` : ""}
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
      <p className="mt-1.5 text-[12px] tabular-nums text-muted-foreground">
        {fmt(run.pulled)} of {fmt(run.size_requested)} pulled · {fmt(run.with_email)} with an email
        {run.skipped_held ? ` · ${fmt(run.skipped_held)} bought before, skipped` : ""} · {cr(run.credits_used)} credits
        {run.match_count != null ? ` · ${fmt(run.match_count)} matched at the count` : ""}
        {waiting ? " · AI Ark is preparing the export" : ""}
      </p>
      {run.outcomes && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {OUTCOMES.filter((o) => run.outcomes![o.key]).map((o) => (
            <span key={o.key} className={cn("rounded-full px-2 py-0.5 text-[11.5px] font-medium tabular-nums", o.cls)}>
              {fmt(run.outcomes![o.key])} {o.key}
            </span>
          ))}
        </div>
      )}
      {(run.stop_reason || run.last_error || run.lists_note) && (
        <p className={cn("mt-1 text-[12px]", run.status === "error" ? "text-destructive" : "text-muted-foreground")}>
          {[run.stop_reason, run.last_error, run.lists_note].filter(Boolean).join(" · ")}
        </p>
      )}
    </div>
  );
}

function Card({ title, sub, right, children }: { title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-card p-4 shadow-ios">
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

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[12.5px] font-medium">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Chips({ options, values, onChange }: { options: { value: string; label: string }[]; values: string[]; onChange: (v: string[]) => void }) {
  const extra = values.filter((v) => !options.some((o) => o.value === v));
  return (
    <div className="flex flex-wrap gap-1.5">
      {[...options, ...extra.map((v) => ({ value: v, label: v }))].map((o) => {
        const on = values.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(on ? values.filter((v) => v !== o.value) : [...values, o.value])}
            className={cn(
              "rounded-full px-3 py-1 text-[12px] font-medium transition-colors",
              on ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-accent"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Suggest({ values, options, onAdd }: { values: string[]; options: string[]; onAdd: (v: string) => void }) {
  const left = useMemo(() => options.filter((o) => !values.includes(o)), [options, values]);
  if (!left.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-muted-foreground">Add:</span>
      {left.map((o) => (
        <button key={o} type="button" onClick={() => onAdd(o)} className="rounded-full border border-dashed border-border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground">
          + {o}
        </button>
      ))}
    </div>
  );
}
