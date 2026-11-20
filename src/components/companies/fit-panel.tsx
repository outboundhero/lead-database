"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Gauge, Loader2, RefreshCw, Send, ShieldCheck, SlidersHorizontal, Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHasPermission } from "@/lib/context/role-context";
import type { FitGateView, FitKeyKind, FitRun, FitSettingsView, FitState, ScoreEstimate } from "@/lib/companies/fit-types";

// The fit panel (phase 3): what the scorer is doing and why, the gate, and
// promotion of the client's approved pipeline emails into leads. Managers see
// it and can press "Promote now" (only while promotion covers the client).
// Admins edit the scoring settings and score a company by hand; owners and
// admins edit the gate. Everything ships off: no rule, scoring off, promotion
// off and the gate off, each covering no client. Promotion needs no fit score
// (fit scoring is kept for v2); its switch is on the Companies settings sheet.

const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PRIORITY: Record<number, string> = { 1: "pushes waiting", 2: "pipeline companies", 3: "campaigns and re-scores" };

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-1.5 text-[13px]">
      <span className="w-40 shrink-0 text-[12px] font-medium text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

export function FitPanel({ tag }: { tag: string | null }) {
  const canView = useHasPermission("manager");
  const isAdmin = useHasPermission("admin");
  const [state, setState] = useState<FitState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<"settings" | "gate" | "score" | null>(null);
  const [promoting, setPromoting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/fit/state${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load fit scoring");
      setState(j as FitState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load fit scoring");
    }
  }, [tag]);

  useEffect(() => {
    if (canView) load();
  }, [canView, load]);

  if (!canView) return null;

  const promote = async () => {
    if (!tag) return;
    if (!window.confirm(`Promote ${tag}'s approved pipeline emails into the lead database now? Duplicates are skipped, never merged.`)) return;
    setPromoting(true);
    try {
      const j = await send("/api/companies/promote", "POST", { tag });
      toast.success(`Promotion started: ${fmt(j.adding)} to add, ${fmt(j.settled)} already in the database`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start promotion");
    } finally {
      setPromoting(false);
    }
  };

  return (
    <section className="rounded-2xl bg-card p-4 shadow-ios">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <Gauge className="size-4.5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-tight">Fit scoring</h2>
          <p className="text-[12px] text-muted-foreground">
            One 1 to 5 score per company, shared by every client, by the fit rule. Nothing under the threshold can be sent for a client the gate covers.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {isAdmin && (
            <Button size="sm" variant={open === "settings" ? "tinted" : "outline"} onClick={() => setOpen(open === "settings" ? null : "settings")}>
              <SlidersHorizontal /> Scoring settings
            </Button>
          )}
          {isAdmin && (
            <Button size="sm" variant={open === "gate" ? "tinted" : "outline"} onClick={() => setOpen(open === "gate" ? null : "gate")}>
              <ShieldCheck /> Gate
            </Button>
          )}
          {isAdmin && (
            <Button size="sm" variant={open === "score" ? "tinted" : "outline"} onClick={() => setOpen(open === "score" ? null : "score")}>
              <Star /> Score by hand
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={load} aria-label="Reload fit scoring">
            <RefreshCw />
          </Button>
        </div>
      </div>

      {error && <p className="rounded-xl bg-destructive/10 p-3 text-[13px] text-destructive">{error}</p>}
      {!state && !error && (
        <div className="flex min-h-[80px] items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      )}

      {state && (
        <div className="divide-y divide-border/60">
          <Line label="Rule">
            {state.rule.set ? (
              <span>The fit rule, version {state.rule.version ?? "(none)"}</span>
            ) : (
              <Pill tone="warn">Waiting for the fit rule</Pill>
            )}
          </Line>
          <Line label="Scorer">
            <span className="flex flex-wrap items-center gap-2">
              <Pill tone={state.scoring.enabled ? "good" : "plain"}>{state.scoring.enabled ? "Scoring on" : "Scoring off"}</Pill>
              <span>
                {state.model ? `${state.model.model}${state.model.reasoning_effort ? `, reasoning ${state.model.reasoning_effort}` : ""}` : "No model set"} ·{" "}
                {state.scoring.batch_size} companies a call, {state.scoring.calls_in_flight} at once
              </span>
              {state.idle_reason && <span className="text-muted-foreground">Idle: {state.idle_reason}</span>}
              {!state.idle_reason && state.worker?.why && <span className="text-muted-foreground">{state.worker.why}</span>}
            </span>
          </Line>
          <Line label="Worker">
            {!state.worker ? (
              <Pill tone="warn">No worker has run yet</Pill>
            ) : !state.worker.online ? (
              <Pill tone="warn">Worker not running</Pill>
            ) : !state.worker.fit_scoring ? (
              <Pill tone="warn" title="Deploy the latest enrichment worker">
                <AlertTriangle className="size-3" /> The worker running is older than fit scoring
              </Pill>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <Pill>{state.worker.state ?? "idle"}</Pill>
                {state.worker.last_error && (
                  <span className="text-destructive" title={state.worker.last_error_at ?? undefined}>
                    Last error: {state.worker.last_error}
                  </span>
                )}
              </span>
            )}
          </Line>
          <Line label="Waiting to be scored">
            {state.queue.length === 0 ? (
              <span className="text-muted-foreground">Nothing queued</span>
            ) : (
              <span className="flex flex-wrap gap-2">
                {state.queue.map((q) => (
                  <Pill key={q.priority} title={`Priority ${q.priority}`}>
                    {fmt(q.waiting + q.claimed)} {PRIORITY[q.priority] ?? `priority ${q.priority}`}
                  </Pill>
                ))}
              </span>
            )}
          </Line>
          <Line label="Scores held">
            <span>
              {state.scores.approx ? "about " : ""}
              {fmt(state.scores.total)} companies, {fmt(state.scores.blocked)} blocked
              {state.scores.manual != null && `, ${fmt(state.scores.manual)} set by hand`}
              {state.scores.unscorable != null && `, ${fmt(state.scores.unscorable)} could not be scored`}
            </span>
            {state.refresh_pending && (
              <Pill tone="warn" title="The gate's threshold changed: blocked flags are being brought up to date">
                Refresh pending
              </Pill>
            )}
          </Line>
          <Line label="Today's fit spend">
            <span className={cn(state.spend.used >= state.spend.cap && "font-semibold text-destructive")}>
              {usd(state.spend.used)} of {usd(state.spend.cap)} a day
            </span>
          </Line>
          <Line label="Gate">
            <span className="flex flex-wrap items-center gap-2">
              <Pill tone={state.gate.enabled ? "good" : "plain"}>{state.gate.enabled ? "On" : "Off"}</Pill>
              <span>
                blocks under {state.gate.threshold}
                {state.gate.require_scored ? ", and companies not scored yet" : ""}; for {state.gate.client_types.join(", ") || "no client type"};{" "}
                {state.gate.tags.includes("*") ? "every client of those types" : `${fmt(state.gate.tags.length)} client(s) listed`}
              </span>
              {tag && state.gate.covers_client !== null && (
                <Pill tone={state.gate.covers_client ? "good" : "plain"}>{state.gate.covers_client ? `Covers ${tag}` : `Does not cover ${tag}`}</Pill>
              )}
            </span>
          </Line>
          <Line label="Into leads">
            <span className="flex flex-wrap items-center gap-2">
              <Pill tone={state.promotion.enabled ? "good" : "plain"}>{state.promotion.enabled ? "Promotion on" : "Promotion off"}</Pill>
              <span>
                approved emails{state.promotion.require_question ? " with a question" : ""}, no fit score needed, source &quot;{state.promotion.source_label}&quot;;
                switched on {isAdmin ? "in Settings" : "by an admin"}
              </span>
              {tag && state.promotion.counts && (
                <span>
                  {tag}: {fmt(state.promotion.counts.general.ready + state.promotion.counts.person.ready)} ready (
                  {fmt(state.promotion.counts.general.ready)} inboxes, {fmt(state.promotion.counts.person.ready)} people)
                  {state.promotion.require_question &&
                    `, ${fmt(state.promotion.counts.general.no_question + state.promotion.counts.person.no_question)} held back for lack of a question`}
                </span>
              )}
              {tag && state.promotion.blocked_why && <span className="text-muted-foreground">{state.promotion.blocked_why}</span>}
              {tag && state.promotion.on_for_client && !state.promotion.blocked_why && (
                <Button size="xs" variant="tinted" disabled={promoting} onClick={promote}>
                  {promoting ? <Loader2 className="animate-spin" /> : <Send />} Promote now
                </Button>
              )}
            </span>
          </Line>
        </div>
      )}

      {isAdmin && open === "settings" && <SettingsForm onSaved={load} />}
      {isAdmin && open === "gate" && <GateForm onSaved={load} />}
      {isAdmin && open === "score" && <ManualScoreForm onSaved={load} />}
    </section>
  );
}

// ── The scoring settings (admin) ────────────────────────────────────────────

function SettingsForm({ onSaved }: { onSaved: () => void }) {
  const [view, setView] = useState<FitSettingsView | null>(null);
  const [prompt, setPrompt] = useState("");
  const [version, setVersion] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [size, setSize] = useState("25");
  const [flight, setFlight] = useState("2");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const v = (await send("/api/fit/settings", "GET")) as FitSettingsView;
        setView(v);
        setPrompt(v.rule.prompt ?? "");
        setVersion(v.rule.version ?? "");
        setEnabled(v.scoring.enabled);
        setSize(String(v.scoring.batch_size));
        setFlight(String(v.scoring.calls_in_flight));
        setModel(v.model?.model ?? "");
        setEffort(v.model?.reasoning_effort ?? "");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load the scoring settings");
      }
    })();
  }, []);

  if (!view) return <p className="mt-3 text-[13px] text-muted-foreground">Loading the settings...</p>;

  const save = async () => {
    const body: Record<string, unknown> = {
      scoring: { enabled, batch_size: Number(size), calls_in_flight: Number(flight) },
      model: { model: model.trim(), ...(effort ? { reasoning_effort: effort } : {}) },
    };
    const ruleChanged = (prompt.trim() || null) !== view.rule.prompt || (version.trim() || null) !== view.rule.version;
    if (ruleChanged) {
      if (!window.confirm("Save this as the fit rule? Scores keep the rule version they were made under; a scoring run re-scores after a change.")) return;
      body.rule = { prompt: prompt.trim() || null, version: version.trim() || null };
    }
    setSaving(true);
    try {
      const j = await send("/api/fit/settings", "PUT", body);
      toast.success(j.changes?.length ? `Saved: ${j.changes.join("; ")}` : "Nothing changed");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded-xl bg-muted/40 p-3">
      <p className="text-[12px] text-muted-foreground">
        The rule is the agency&apos;s own, pasted here as written: it is sent to the model as it is, with a fixed format part that says nothing about what a good fit is. Give it a new
        version whenever the text changes.
      </p>
      <label className="block text-[12px] font-medium">
        Rule
        <textarea
          className="mt-1 h-40 w-full rounded-xl bg-card p-3 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Waiting for the fit rule"
          maxLength={20_000}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="text-[12px] font-medium">
          Rule version
          <Input className="mt-1 h-9" value={version} onChange={(e) => setVersion(e.target.value)} maxLength={40} placeholder="for example 2026-11-20" />
        </label>
        <label className="text-[12px] font-medium">
          Model
          <Input className="mt-1 h-9" value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <label className="text-[12px] font-medium">
          Reasoning effort
          <select className="mt-1 h-9 w-full rounded-xl bg-card px-3 text-[13px]" value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">not sent</option>
            {view.efforts.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] font-medium">
          Companies a call (1 to 50)
          <Input className="mt-1 h-9" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value)} />
        </label>
        <label className="text-[12px] font-medium">
          Calls at once (1 to 8)
          <Input className="mt-1 h-9" inputMode="numeric" value={flight} onChange={(e) => setFlight(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 self-end pb-2 text-[13px] font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Scoring on
        </label>
      </div>
      <Button size="sm" disabled={saving} onClick={save}>
        {saving && <Loader2 className="animate-spin" />} Save
      </Button>
    </div>
  );
}

// ── The gate (owner and admin) ──────────────────────────────────────────────

function GateForm({ onSaved }: { onSaved: () => void }) {
  const [view, setView] = useState<FitGateView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [tags, setTags] = useState("");
  const [threshold, setThreshold] = useState("2");
  const [types, setTypes] = useState<string[]>([]);
  const [requireScored, setRequireScored] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const v = (await send("/api/fit/gate", "GET")) as FitGateView;
        setView(v);
        setEnabled(v.enabled);
        setTags(v.tags.join(", "));
        setThreshold(String(v.threshold));
        setTypes(v.client_types);
        setRequireScored(v.require_scored);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Could not load the gate");
      }
    })();
  }, []);

  if (!view) return <p className="mt-3 text-[13px] text-muted-foreground">Loading the gate...</p>;

  const save = async () => {
    const list = tags.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (enabled && !view.enabled && !window.confirm("Switch the fit gate on? For each client on its list, companies scored under the threshold can no longer be pushed or exported. Run the client's EXPLAIN on production first.")) {
      return;
    }
    setSaving(true);
    try {
      const j = await send("/api/fit/gate", "PUT", {
        enabled, tags: list, threshold: Number(threshold), client_types: types, require_scored: requireScored,
      });
      toast.success(j.changes?.length ? `Saved: ${j.changes.join("; ")}` : "Nothing changed");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the gate");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded-xl bg-muted/40 p-3">
      <p className="text-[12px] text-muted-foreground">
        The gate goes on one client at a time. With it off, or for a client not on its list, every push, count and export is exactly as it was. Each change is in the audit log and
        brings the blocked flags up to date in the background.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-[12px] font-medium sm:col-span-2">
          Clients (tags, separated by commas; * means every client of the types below)
          <Input className="mt-1 h-9" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="no client yet" />
        </label>
        <label className="text-[12px] font-medium">
          Block companies scored under (1 to 5)
          <Input className="mt-1 h-9" inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </label>
        <div className="text-[12px] font-medium">
          Client types it covers
          <div className="mt-1 flex flex-wrap gap-2">
            {[...new Set([...view.known_types, ...types])].map((t) => (
              <label key={t} className="flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[12px]">
                <input type="checkbox" checked={types.includes(t)} onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))} />
                {t}
              </label>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <input type="checkbox" checked={requireScored} onChange={(e) => setRequireScored(e.target.checked)} /> Also hold back companies not scored yet
        </label>
        <label className="flex items-center gap-2 text-[13px] font-medium">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Gate on
        </label>
      </div>
      {view.refresh.pending && <p className="text-[12px] text-[var(--warning)]">A refresh of the blocked flags is pending since {view.refresh.since ?? "a moment ago"}.</p>}
      <Button size="sm" disabled={saving} onClick={save}>
        {saving && <Loader2 className="animate-spin" />} Save the gate
      </Button>
    </div>
  );
}

// ── A manual score (admin) ──────────────────────────────────────────────────

function ManualScoreForm({ onSaved }: { onSaved: () => void }) {
  const [kind, setKind] = useState<FitKeyKind>("domain");
  const [key, setKey] = useState("");
  const [score, setScore] = useState("1");
  const [home, setHome] = useState<"" | "yes" | "no">("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const j = await send("/api/fit/score", "POST", {
        key_kind: kind, key: key.trim(), score: Number(score), home_office: home === "" ? null : home === "yes", reason: reason.trim() || null,
      });
      toast.success(`Saved: ${j.saved.key} is ${j.saved.score} of 5${j.saved.blocked ? ", blocked by the gate's threshold" : ""}`);
      setKey("");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the score");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 space-y-3 rounded-xl bg-muted/40 p-3">
      <p className="text-[12px] text-muted-foreground">
        A score set by hand is never replaced by the scorer, and reaches every key the company&apos;s leads show at once.
      </p>
      <div className="grid gap-3 sm:grid-cols-[140px_minmax(0,1fr)_100px]">
        <label className="text-[12px] font-medium">
          Key
          <select className="mt-1 h-9 w-full rounded-xl bg-card px-3 text-[13px]" value={kind} onChange={(e) => setKind(e.target.value as FitKeyKind)}>
            <option value="domain">Domain</option>
            <option value="name">Name, city, state</option>
          </select>
        </label>
        <label className="text-[12px] font-medium">
          {kind === "domain" ? "The company's domain (a website or address works)" : "company|city|ST"}
          <Input className="mt-1 h-9" value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <label className="text-[12px] font-medium">
          Score
          <select className="mt-1 h-9 w-full rounded-xl bg-card px-3 text-[13px]" value={score} onChange={(e) => setScore(e.target.value)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[12px] font-medium">
          Home office
          <select className="mt-1 h-9 w-full rounded-xl bg-card px-3 text-[13px]" value={home} onChange={(e) => setHome(e.target.value as "" | "yes" | "no")}>
            <option value="">not said</option>
            <option value="yes">likely</option>
            <option value="no">no</option>
          </select>
        </label>
        <label className="text-[12px] font-medium sm:col-span-2">
          Reason
          <Input className="mt-1 h-9" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </label>
      </div>
      <Button size="sm" disabled={saving || !key.trim()} onClick={save}>
        {saving && <Loader2 className="animate-spin" />} Save the score
      </Button>
    </div>
  );
}

// ── Scoring the companies already in campaigns (owner and admin) ────────────

interface RunView {
  estimate: ScoreEstimate;
  idle_reason: string | null;
  runs: FitRun[];
}

/**
 * The scoring run over every company in the Email Bison copy (and the
 * pipeline's companies not scored under the current rule and model): its
 * estimate first, then a confirmation, then its progress. Also the re-score
 * after the rule or the model changed.
 */
export function ScoringRunPanel() {
  const isAdmin = useHasPermission("admin");
  const [view, setView] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setView((await send("/api/fit/scoring-run", "GET")) as RunView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not work out the estimate");
    }
  }, []);

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin, load]);

  const going = view?.runs.some((r) => ["queued", "collecting", "scoring"].includes(r.status)) ?? false;
  useEffect(() => {
    if (!going) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [going, load]);

  if (!isAdmin) return null;
  const e = view?.estimate;

  const start = async () => {
    if (!e) return;
    const text =
      `Score about ${fmt(e.companies)} companies (${fmt(e.campaigns)} in campaigns, ${fmt(e.pipeline)} from the pipeline)? ` +
      `About ${fmt(e.calls)} calls and ${usd(e.usd)} at ${e.model ?? "the fit model"}` +
      (e.days_at_cap != null ? `, about ${e.days_at_cap} day(s) at the ${usd(e.cap)} daily fit cap.` : ".");
    if (!window.confirm(text)) return;
    setStarting(true);
    try {
      await send("/api/fit/scoring-run", "POST", { confirm: true });
      toast.success("Scoring run started");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start the scoring run");
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="rounded-2xl bg-card p-4 shadow-ios">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-tight">Score the companies already in campaigns</h2>
          <p className="text-[12px] text-muted-foreground">
            Every company in the Email Bison copy, whatever client its campaign belongs to, from the fields we hold (no web lookups). Paced, and paused while a push gathers.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} aria-label="Reload the estimate">
          <RefreshCw />
        </Button>
      </div>
      {error && <p className="rounded-xl bg-destructive/10 p-3 text-[13px] text-destructive">{error}</p>}
      {e && (
        <div className="space-y-2 text-[13px]">
          <p>
            About <span className="font-semibold">{fmt(e.companies)}</span> companies to score ({fmt(e.campaigns)} in campaigns{e.exact ? "" : ", estimated from the copy's size"},{" "}
            {fmt(e.pipeline)} from the pipeline): about {fmt(e.calls)} calls, <span className="font-semibold">{usd(e.usd)}</span>
            {e.days_at_cap != null && <>, about {e.days_at_cap} day(s) at the {usd(e.cap)} daily fit cap</>}.
          </p>
          {view?.idle_reason && <p className="text-[12px] text-[var(--warning)]">Can&apos;t start yet: {view.idle_reason}.</p>}
          <Button size="sm" disabled={starting || going || Boolean(view?.idle_reason)} onClick={start}>
            {starting && <Loader2 className="animate-spin" />} {going ? "A scoring run is going" : "Start the scoring run"}
          </Button>
        </div>
      )}
      {view && view.runs.length > 0 && (
        <div className="mt-3 space-y-1 text-[12px]">
          {view.runs.map((r) => (
            <p key={r.id} className="text-muted-foreground">
              {new Date(r.created_at).toLocaleString("en-US")}: <span className="font-medium text-foreground">{r.status}</span>, {fmt(r.leads_seen)} leads read,{" "}
              {fmt(r.companies)} companies, {fmt(r.queued)} queued{r.created_by_name ? `, by ${r.created_by_name}` : ""}
              {r.last_error ? `; last error: ${r.last_error}` : ""}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
