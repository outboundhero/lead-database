"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Info, KeyRound, Loader2, MailCheck, RefreshCw, Settings2, Store } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { AccessDenied } from "@/components/layout/access-denied";
import { useHasPermission } from "@/lib/context/role-context";
import { ClientSelector } from "@/components/filters/client-selector";
import { cr, FiltersCard, fmt, isActive, PlanCard, PullCard, PullsCard } from "@/components/companies/pull-panel";
import { CompaniesTable, CountsStrip } from "@/components/companies/companies-table";
import { SettingsSheet } from "@/components/companies/settings-sheet";
import type { CompaniesSetup, CompanyCounts, CompanyRun, CompanyWorker } from "@/lib/companies/types";

// The Companies tab: pick a client, see what AI Ark will be asked for its
// companies (its places and exclusions from its rules, its size and industries
// from the AI Ark tab), count, and pull. The enrichment worker buys the
// companies into the client's Companies table on the Clay tab and works each
// one there (area, exclusions, website, the office's general email, Reoon). A
// company is listed here only once a usable general email is found, or when its
// general inbox is already in the database. Nothing here writes leads.

const KEY_LABELS: Record<string, string> = { OPENAI_API_KEY: "OpenAI", ENRICH_REOON_API_KEY: "Reoon" };

export default function CompaniesPage() {
  return (
    <Suspense fallback={null}>
      <CompaniesTab />
    </Suspense>
  );
}

function CompaniesTab() {
  const canView = useHasPermission("manager");
  const isAdmin = useHasPermission("admin");
  const router = useRouter();
  const tag = useSearchParams().get("client")?.toUpperCase() ?? null;
  const [setup, setSetup] = useState<CompaniesSetup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runs, setRuns] = useState<CompanyRun[]>([]);
  const [counts, setCounts] = useState<CompanyCounts | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A response is used only if it still belongs to the client on screen.
  const loadSeq = useRef(0);
  const tagRef = useRef(tag);
  useEffect(() => {
    tagRef.current = tag;
  }, [tag]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoadError(null);
    try {
      const res = await fetch(`/api/companies/setup${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
      const j = await res.json();
      if (seq !== loadSeq.current) return;
      if (!res.ok) throw new Error(j.error ?? "Could not load the Companies tab");
      const s = j as CompaniesSetup;
      setSetup(s);
      setRuns(s.runs);
      setCounts(s.counts);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLoadError(e instanceof Error ? e.message : "Could not load the Companies tab");
    }
  }, [tag]);

  /** The balance, the worker and the settings only: the pulls and counts are the poll's. */
  const refreshQuietly = useCallback(async () => {
    try {
      const res = await fetch(`/api/companies/setup${tag ? `?tag=${encodeURIComponent(tag)}` : ""}`);
      if (!res.ok) return;
      const s = (await res.json()) as CompaniesSetup;
      if (tag !== tagRef.current) return;
      setSetup((prev) => (prev ? { ...prev, credits: s.credits, worker: s.worker, modes: s.modes, pipeline: s.pipeline, settings: s.settings } : prev));
    } catch {
      /* the next poll tries again */
    }
  }, [tag]);

  useEffect(() => {
    if (!canView) return;
    setSetup(null);
    setRuns([]);
    setCounts(null);
    load();
  }, [canView, load]);

  // Pulls, counts, the worker and the switch: every 5 s while a pull or its
  // rows are being worked, else every 20 s, and at once when the page is shown
  // again. A hidden page skips a tick but keeps the timer; a tick also skips
  // while the last request is on its way, and one that hangs is given up after 30 s.
  const working = (counts?.rows.queued ?? 0) + (counts?.rows.running ?? 0) > 0;
  const busy = runs.some(isActive) || working;
  const loaded = setup !== null;
  useEffect(() => {
    if (!loaded || !tag) return;
    let ctl: AbortController | null = null;
    const tick = async () => {
      if (ctl || document.visibilityState !== "visible") return;
      const mine = new AbortController();
      ctl = mine;
      const giveUp = setTimeout(() => mine.abort(), 30_000);
      try {
        const res = await fetch(`/api/companies/runs?tag=${encodeURIComponent(tag)}`, { signal: mine.signal });
        const j = await res.json();
        if (!res.ok || mine.signal.aborted || tag !== tagRef.current) return;
        setRuns(j.runs);
        setCounts(j.counts);
        setSetup((s) => (s ? { ...s, worker: j.worker, pipeline: j.pipeline } : s));
      } catch {
        /* aborted, or the next tick tries again */
      } finally {
        clearTimeout(giveUp);
        if (ctl === mine) ctl = null;
      }
    };
    const timer = setInterval(tick, busy ? 5_000 : 20_000);
    const onShow = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onShow);
      ctl?.abort();
    };
  }, [loaded, tag, busy]);

  // When a pull ends, the balance is read again.
  const anyActive = runs.some(isActive);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !anyActive) refreshQuietly();
    wasActive.current = anyActive;
  }, [anyActive, refreshQuietly]);

  if (!canView) return <AccessDenied />;

  const cancel = async (run: CompanyRun) => {
    if (!window.confirm("Cancel this pull? Nothing new is bought. Every company pulled so far stays in the client's table and is still worked.")) return;
    try {
      const res = await fetch("/api/companies/runs/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: run.id }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Could not cancel the pull");
      toast.success("Pull cancelled");
      setRuns((rs) => rs.map((r) => (r.id === run.id ? { ...r, status: "cancelled" } : r)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not cancel the pull");
    }
  };

  return (
    <div className="flex flex-col gap-4 pb-10">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <Store className="size-5" strokeWidth={1.75} />
          </div>
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight">Companies</h1>
            <p className="text-[12.5px] text-muted-foreground">Companies from AI Ark for each client, listed once we find a general email</p>
          </div>
        </div>
        <div className="ml-2">
          <ClientSelector
            clientTag={tag}
            onChange={(t) => router.replace(t ? `/leads/companies?client=${encodeURIComponent(t)}` : "/leads/companies")}
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {setup && <BalancePill setup={setup} />}
          {setup && <WorkerPills worker={setup.worker} />}
          {isAdmin && (
            <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              <Settings2 /> Settings
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={load} aria-label="Reload">
            <RefreshCw />
          </Button>
        </div>
      </div>

      {setup && !setup.pipeline.enabled && (
        <div className="flex gap-3 rounded-2xl bg-[var(--warning)]/12 p-4 text-[13px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          <p>
            <span className="font-semibold">Company pulls are off.</span> Nothing can be counted or pulled for any client until they are switched on
            {isAdmin ? " in Settings." : " by an admin."}
          </p>
        </div>
      )}

      {setup && !setup.modes.live.ready && setup.modes.demo.ready && (
        <div className="flex gap-3 rounded-2xl bg-primary/8 p-4 text-[13px] leading-relaxed">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" />
          <p>
            <span className="font-semibold">Demo mode.</span> AI Ark isn&apos;t connected yet (no <code>AIARK_API_KEY</code>), so counts and pulls use
            made-up companies from a stand-in that never leaves this machine. Every web address ends in <code>.example</code> and nothing is bought.
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
            A pull asks AI Ark for companies in the client&apos;s places, leaving out its exclusions (both from its rules), at the company size and
            industries saved on the AI Ark tab. Each company is then checked and its general email looked for; only companies with one are listed.
          </p>
        </div>
      )}

      {setup && tag && (
        <>
          <CountsStrip counts={counts} />
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <PlanCard tag={tag} setup={setup} />
              <FiltersCard tag={tag} setup={setup} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              {/* keyed: a count belongs to one client */}
              <PullCard
                key={tag}
                tag={tag}
                setup={setup}
                runs={runs}
                onStarted={(run) => {
                  if (run.client_tag === tagRef.current) setRuns((rs) => [run, ...rs.filter((r) => r.id !== run.id)]);
                }}
                onReload={load}
              />
              <PullsCard tag={tag} runs={runs} onCancel={cancel} />
            </div>
          </div>
          <CompaniesTable key={tag} tag={tag} live={busy} listedTotal={counts?.listed.total ?? 0} />
        </>
      )}

      {isAdmin && <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} onSaved={() => refreshQuietly()} />}
    </div>
  );
}

function BalancePill({ setup }: { setup: CompaniesSetup }) {
  const live = setup.credits.live;
  if (setup.modes.live.ready) {
    return (
      <span
        title={live?.error ?? "AI Ark credits left (read when the page loaded or the last pull ended)"}
        className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[12px] font-medium shadow-ios"
      >
        <span className={cn("size-2 rounded-full", live?.error ? "bg-destructive" : "bg-[var(--success)]")} />
        {live?.error ? "AI Ark not answering" : `AI Ark · ${cr(live?.credits)} credits`}
      </span>
    );
  }
  return (
    <span title={setup.modes.live.why ?? undefined} className="flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[12px] font-medium shadow-ios">
      <span className="size-2 rounded-full bg-muted-foreground/50" />
      {setup.modes.demo.ready ? `Demo mode · ${cr(setup.credits.demo?.credits)} demo credits` : "AI Ark needs a key"}
    </span>
  );
}

const ago = (iso: string | null) => {
  if (!iso) return "";
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return min < 1 ? "just now" : min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

/** The worker, the keys it is missing, and the Reoon checks it can still make today. */
function WorkerPills({ worker }: { worker: CompanyWorker | null }) {
  const warn = "flex items-center gap-1.5 rounded-full bg-[var(--warning)]/15 px-3 py-1.5 text-[12px] font-medium text-[var(--warning)]";
  const plain = "flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-[12px] font-medium shadow-ios";
  if (!worker) {
    return (
      <span title="No enrichment worker has run yet. Start one with: npm run enrich-worker" className={warn}>
        <AlertTriangle className="size-3.5" /> Worker never started
      </span>
    );
  }
  if (!worker.online) {
    return (
      <span title={`No heartbeat for ${fmt(worker.secondsAgo)} s. Pulls and enrichment are worked by the enrichment worker.`} className={warn}>
        <AlertTriangle className="size-3.5" /> Worker not running
      </span>
    );
  }
  const missing = Object.keys(KEY_LABELS).filter((k) => worker.keys[k] === false);
  const reoon = worker.reoon;
  return (
    <>
      {!worker.companyRuns && (
        <span title="The worker running now is older than company pulls. Deploy the latest worker." className={warn}>
          <AlertTriangle className="size-3.5" /> Worker doesn&apos;t do company pulls yet
        </span>
      )}
      {missing.map((k) => (
        <span
          key={k}
          title={`The worker has no ${KEY_LABELS[k]} key, so those steps wait as "Needs key" and their companies are not listed until it is added.`}
          className={warn}
        >
          <KeyRound className="size-3" /> No {KEY_LABELS[k]} key
        </span>
      ))}
      {reoon && reoon.instant != null && reoon.instant !== 0 ? (
        <span
          title="The pipeline's Reoon account may spend daily credits only. While it holds instant credits, email checks wait."
          className={warn}
        >
          <MailCheck className="size-3.5" /> Reoon holds instant credits: checks wait
        </span>
      ) : reoon && reoon.daily != null ? (
        <span title={`Reoon balance read by the worker ${ago(reoon.readAt)}`} className={plain}>
          <MailCheck className="size-3.5 text-muted-foreground" /> {fmt(reoon.daily)} Reoon checks left today
        </span>
      ) : null}
    </>
  );
}
