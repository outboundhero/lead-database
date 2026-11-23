"use client";

// The export popup's "Question variable" row (migration 139), inside the
// per-client panel of column-selector.tsx. It shows for every client, expanded
// and highlighted for OS clients (isOsClient: client type OS, or a tag ending
// "-OS"). The client's choice is saved per client (PUT /api/questions/client);
// with a variable chosen it shows how many of the leads this push covers have
// one written (POST /api/questions/readiness), starts and follows the job that
// writes the rest (/api/questions/jobs), blocks the push while an install lacks
// the variable (GET /api/questions/bison), and warns about campaigns whose copy
// does not use it (POST /api/questions/copy-check). The routes are W3's; their
// shapes are the build contract's. Nothing is written for a lead from here
// without the button, and with the switch off for the client nothing is sent.

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { copyTag, isOsClient } from "../../../scripts/lib/questions/names.mjs";
import type { BisonView, CopyCheckView, JobView, ReadinessView, VariablesView } from "@/lib/questions/types";

/** What the popup sends for the question variable, as this row last decided it. */
export interface QuestionChoice {
  /** The client the choice is for: a choice for another client is never sent. */
  tag: string | null;
  /** The variable to send, or null for the default {QUESTION} (nothing extra is sent). */
  variableId: string | null;
  copyTag: string | null;
  /** True only when the variable is sent: chosen, not archived, and the switch is on for the client. */
  send: boolean;
  /** Why the push must wait (shown and the confirm disabled), or null. */
  blocked: string | null;
}

export const NO_QUESTION_CHOICE: QuestionChoice = { tag: null, variableId: null, copyTag: null, send: false, blocked: null };

const DEFAULT_VALUE = "__default__";
const DEFAULT_COPY_TAG = "{QUESTION}";
const OPEN_JOB = new Set(["queued", "gathering", "running", "paused"]);
const POLL_MS = 4000;
const JOB_STATE: Record<string, string> = {
  queued: "Waiting for the worker",
  gathering: "Finding the leads",
  running: "Writing",
  paused: "Paused",
  done: "Done",
  error: "Stopped with an error",
  cancelled: "Cancelled",
};

// The answers of the /api/questions routes, as the routes declare them (type only).
type VariablesAnswer = VariablesView;
type Readiness = ReadinessView;
type QuestionJob = JobView;
type BisonCheck = BisonView;
type CopyCheck = CopyCheckView;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body?.error === "string" && body.error ? body.error : `HTTP ${res.status}`);
  return body as T;
}
const sendJson = (method: "POST" | "PUT", body: unknown, signal?: AbortSignal): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
  signal,
});

export interface QuestionVariableRowProps {
  /** The client the push is for (the popup's detected client). */
  tag: string;
  /** Its type in the client list (roster): "OS" makes it an OS client. */
  clientType: string | null;
  /** JSON of the push-batch body minus campaigns, force and the question variable (pushSelection). */
  selectionJson: string;
  /** The campaigns picked so far, for the copy check. */
  campaigns: Array<{ id: number | string; name?: string; instance_url?: string }>;
  onChange: (choice: QuestionChoice) => void;
}

export function QuestionVariableRow({ tag, clientType, selectionJson, campaigns, onChange }: QuestionVariableRowProps) {
  const [data, setData] = useState<VariablesAnswer | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [userExpanded, setUserExpanded] = useState(false);
  const [readiness, setReadiness] = useState<{ key: string; value: Readiness | null; error: string | null } | null>(null);
  const [jobs, setJobs] = useState<QuestionJob[]>([]);
  const [starting, setStarting] = useState(false);
  const [bison, setBison] = useState<{ variableId: string; value: BisonCheck | null; error: string | null } | null>(null);
  const [bisonChecking, setBisonChecking] = useState(false);
  const [copy, setCopy] = useState<{ key: string; value: CopyCheck | null; error: string | null } | null>(null);

  // ── The client's variables and its current choice: read fresh on every opening ──
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const d = await api<VariablesAnswer>(`/api/questions/variables?tag=${encodeURIComponent(tag)}`, { signal });
      setData(d);
      setLoadError(null);
      setChosen(d.current?.variableId ?? null);
    } catch (e) {
      if (!signal?.aborted) setLoadError(message(e));
    }
  }, [tag]);
  useEffect(() => {
    const ctl = new AbortController();
    void load(ctl.signal);
    return () => ctl.abort();
  }, [load]);

  const variables = useMemo(() => (Array.isArray(data?.variables) ? data.variables : []), [data]);
  const chosenVar = chosen ? variables.find((v) => v.id === chosen) ?? null : null;
  const X = chosenVar ? chosenVar.copyTag || copyTag(chosenVar.name) : null;
  const os = data && typeof data.isOs === "boolean" ? data.isOs : isOsClient({ tag, clientType });
  const expanded = os || chosen !== null || userExpanded;
  // A variable that would be sent: the checks below run only for one.
  const active = data?.switchOn === true && chosenVar !== null && !chosenVar.archived;

  // ── Jobs: the client's, read when a variable is active and every 4 s while one is open ──
  const loadJobs = useCallback(async (signal?: AbortSignal) => {
    try {
      const j = await api<{ jobs: QuestionJob[] }>(`/api/questions/jobs?tag=${encodeURIComponent(tag)}`, { signal });
      setJobs(Array.isArray(j.jobs) ? j.jobs : []);
    } catch {
      // Keep the last list; the next read tries again.
    }
  }, [tag]);
  useEffect(() => {
    if (!active) return;
    const ctl = new AbortController();
    void loadJobs(ctl.signal);
    return () => ctl.abort();
  }, [active, loadJobs]);
  const myJobs = useMemo(
    () => jobs.filter((j) => j.variableId === chosen).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    [jobs, chosen],
  );
  const openJob = myJobs.find((j) => OPEN_JOB.has(j.status)) ?? null;
  const lastJob = myJobs[0] ?? null;
  const openJobId = openJob?.id ?? null;
  useEffect(() => {
    if (!openJobId) return;
    const timer = setInterval(() => void loadJobs(), POLL_MS);
    return () => clearInterval(timer);
  }, [openJobId, loadJobs]);

  // ── Readiness: how many of this push's leads have the variable written ──
  // Counted again when the selection changes and when a job ends.
  const jobMark = lastJob ? `${lastJob.id}:${OPEN_JOB.has(lastJob.status) ? "open" : "closed"}` : "";
  const readinessKey = active ? `${chosen}|${jobMark}|${selectionJson}` : null;
  const count = useCallback(async (key: string, variableId: string, signal: AbortSignal) => {
    try {
      const r = await api<Readiness>("/api/questions/readiness",
        sendJson("POST", { tag, variableId, selection: JSON.parse(selectionJson) }, signal));
      setReadiness({ key, value: r, error: null });
    } catch (e) {
      if (!signal.aborted) setReadiness({ key, value: null, error: message(e) });
    }
  }, [tag, selectionJson]);
  useEffect(() => {
    if (!readinessKey || !chosen) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => void count(readinessKey, chosen, ctl.signal), 500);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [readinessKey, chosen, count]);
  const ready = readiness && readiness.key === readinessKey ? readiness : null;

  // ── Bison: the variable must exist on each of the client's installs ──
  const checkBison = useCallback(async (variableId: string, signal?: AbortSignal) => {
    try {
      const b = await api<BisonCheck>(
        `/api/questions/bison?tag=${encodeURIComponent(tag)}&variableId=${encodeURIComponent(variableId)}`, { signal });
      setBison({ variableId, value: b, error: null });
    } catch (e) {
      if (!signal?.aborted) setBison({ variableId, value: null, error: message(e) });
    }
  }, [tag]);
  useEffect(() => {
    if (!active || !chosen) return;
    const ctl = new AbortController();
    void checkBison(chosen, ctl.signal);
    return () => ctl.abort();
  }, [active, chosen, checkBison]);
  const bisonNow = bison && bison.variableId === chosen ? bison : null;
  const installs = bisonNow?.value?.installs ?? [];
  const missingOn = installs.filter((i) => i.exists === false).map((i) => i.install);
  const unknownOn = installs.filter((i) => i.exists === null || i.error);

  // ── Campaign copy: does each picked campaign use the variable? Warns only ──
  const campaignsJson = useMemo(
    () => JSON.stringify(campaigns.map((c) => ({ instance_url: c.instance_url ?? "", id: Number(c.id) }))),
    [campaigns],
  );
  const copyKey = active && campaigns.length > 0 ? `${chosen}|${campaignsJson}` : null;
  const checkCopy = useCallback(async (key: string, variableId: string, signal: AbortSignal) => {
    try {
      const c = await api<CopyCheck>("/api/questions/copy-check",
        sendJson("POST", { tag, variableId, campaigns: JSON.parse(campaignsJson) }, signal));
      setCopy({ key, value: c, error: null });
    } catch (e) {
      if (!signal.aborted) setCopy({ key, value: null, error: message(e) });
    }
  }, [tag, campaignsJson]);
  useEffect(() => {
    if (!copyKey || !chosen) return;
    const ctl = new AbortController();
    const timer = setTimeout(() => void checkCopy(copyKey, chosen, ctl.signal), 600);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [copyKey, chosen, checkCopy]);
  const copyNow = copy && copy.key === copyKey ? copy : null;
  const nameOf = useMemo(() => {
    const m = new Map(campaigns.map((c) => [`${c.instance_url ?? ""}#${c.id}`, c.name ?? `Campaign ${c.id}`]));
    return (instanceUrl: string, id: number) => m.get(`${instanceUrl}#${id}`) ?? `Campaign ${id}`;
  }, [campaigns]);

  // ── What the popup sends, told to it whenever it changes ──
  const blocked = active && X
    ? missingOn.length > 0 ? `Create ${X} in Bison first (missing on ${missingOn.join(", ")})` : null
    : data?.switchOn && chosenVar?.archived && X
    ? `${X} is archived: pick another variable or the default ${DEFAULT_COPY_TAG}`
    : null;
  useEffect(() => {
    onChange({ tag, variableId: active ? chosen : null, copyTag: active ? X : null, send: active, blocked });
  }, [onChange, tag, active, chosen, X, blocked]);
  useEffect(() => () => onChange(NO_QUESTION_CHOICE), [onChange]);

  // ── Actions ──
  const choose = async (value: string) => {
    const next = value === DEFAULT_VALUE ? null : value;
    if (next === chosen) return;
    const before = chosen;
    setChosen(next);
    setSaving(true);
    try {
      const d = await api<VariablesAnswer>("/api/questions/client", sendJson("PUT", { tag, variableId: next }));
      setData(d);
      setChosen(d.current?.variableId ?? null);
      const picked = next ? variables.find((v) => v.id === next) : null;
      toast.success(`${tag} now uses ${picked ? picked.copyTag || copyTag(picked.name) : `the default ${DEFAULT_COPY_TAG}`}`);
    } catch (e) {
      setChosen(before);
      toast.error(`Couldn't save ${tag}'s question: ${message(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const r = ready?.value ?? null;
  const toWrite = r ? (Number.isFinite(r.estimate?.questionCalls) ? n(r.estimate.questionCalls) : Math.max(0, n(r.selected) - n(r.withValue))) : 0;

  const startJob = async () => {
    if (!chosen || !X) return;
    setStarting(true);
    try {
      await api<{ jobId: string }>("/api/questions/jobs", sendJson("POST", { tag, variableId: chosen, selection: JSON.parse(selectionJson) }));
      toast.success(`Writing ${X} for ${toWrite.toLocaleString()} lead${toWrite === 1 ? "" : "s"}: progress shows here`);
      await loadJobs();
    } catch (e) {
      toast.error(`Couldn't start writing ${X}: ${message(e)}`);
    } finally {
      setStarting(false);
    }
  };

  const cancelJob = async (jobId: string) => {
    try {
      await api("/api/questions/jobs/cancel", sendJson("POST", { jobId }));
      toast.success("Stopped writing");
      await loadJobs();
    } catch (e) {
      toast.error(`Couldn't stop it: ${message(e)}`);
    }
  };

  const recheckBison = async () => {
    if (!chosen) return;
    setBisonChecking(true);
    try {
      await checkBison(chosen);
    } finally {
      setBisonChecking(false);
    }
  };

  const setupHref = `/leads/clay?setup=${encodeURIComponent(tag)}&tab=question`;
  const options = variables.filter((v) => !v.archived || v.id === chosen);

  return (
    <div
      className={`mt-2 rounded-lg p-2 text-xs ${os ? "border border-primary/40 bg-primary/5" : "border border-transparent"}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">Question variable</span>
        {os && (
          <Badge variant="tinted" className="text-xs normal-case tracking-normal">
            OS client
          </Badge>
        )}
        {!expanded && (
          <button
            type="button"
            onClick={() => setUserExpanded(true)}
            className="ml-auto font-medium text-primary hover:underline"
            title="Send a client's own question variable instead of the default one"
          >
            Default {DEFAULT_COPY_TAG} · change
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {loadError && !data ? (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-amber-700">
                Couldn&apos;t read {tag}&apos;s question variables ({loadError}). This push sends the default {DEFAULT_COPY_TAG}.
              </p>
              <Button variant="outline" size="xs" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : !data ? (
            <p className="text-muted-foreground">Reading {tag}&apos;s question variables…</p>
          ) : (
            <>
              <Select value={chosen ?? DEFAULT_VALUE} onValueChange={(v) => void choose(v)} disabled={saving}>
                <SelectTrigger size="sm" className="w-full text-xs" aria-label={`${tag}'s question variable`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VALUE} className="text-xs">
                    Default {DEFAULT_COPY_TAG}
                  </SelectItem>
                  {options.map((v) => (
                    <SelectItem key={v.id} value={v.id} className="text-xs">
                      {v.copyTag || copyTag(v.name)}
                      {v.archived ? " (archived)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {!data.switchOn && (
                <p className="text-muted-foreground">
                  Question variables are off for {tag} (turn them on under Companies tab, Settings).
                  {chosenVar ? ` ${X} is not sent: this push sends the default ${DEFAULT_COPY_TAG}.` : ""}
                </p>
              )}

              {data.switchOn && chosenVar?.archived && (
                <p className="text-destructive">{X} is archived: pick another variable or the default {DEFAULT_COPY_TAG}.</p>
              )}

              {active && X && (
                <>
                  {/* How many of this push's leads have it, and how many to write. */}
                  {!ready ? (
                    <p className="text-muted-foreground">Counting the leads that have {X}…</p>
                  ) : ready.error ? (
                    <p className="text-amber-700">Couldn&apos;t count the leads that have {X}: {ready.error}</p>
                  ) : r ? (
                    <p>
                      <span className="font-medium tabular-nums">{n(r.withValue).toLocaleString()}</span> of{" "}
                      <span className="tabular-nums">{n(r.selected).toLocaleString()}</span> leads have {X}
                      {" · "}
                      <span className="font-medium tabular-nums">{toWrite.toLocaleString()}</span> to write
                      {" "}(about <span className="tabular-nums">{n(r.companiesMissing).toLocaleString()}</span>{" "}
                      compan{n(r.companiesMissing) === 1 ? "y" : "ies"})
                      {n(r.stale) > 0 && (
                        <span className="text-muted-foreground"> · {n(r.stale).toLocaleString()} written from older prompts</span>
                      )}
                    </p>
                  ) : null}

                  {/* The job that writes it: started here, followed every 4 s while open. */}
                  {openJob ? (
                    <div className="rounded-md bg-background/70 p-1.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">
                          {JOB_STATE[openJob.status] ?? openJob.status} {X}
                        </span>
                        <span className="tabular-nums text-muted-foreground">
                          {n(openJob.done).toLocaleString()} of {n(openJob.total).toLocaleString()}
                          {n(openJob.failed) > 0 ? ` · ${n(openJob.failed).toLocaleString()} failed` : ""}
                          {n(openJob.skipped) > 0 ? ` · ${n(openJob.skipped).toLocaleString()} skipped` : ""}
                          {` · $${n(openJob.spendUsd).toFixed(2)}`}
                        </span>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="ml-auto text-destructive hover:bg-destructive/10"
                          onClick={() => void cancelJob(openJob.id)}
                        >
                          Cancel
                        </Button>
                      </div>
                      {openJob.note && <p className="mt-0.5 text-amber-700">{openJob.note}</p>}
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="tinted"
                        size="xs"
                        disabled={starting || !ready?.value || toWrite === 0 || data.workerReady === false}
                        onClick={() => void startJob()}
                        title="Writes the question for the leads of this push that have none yet (paid OpenAI calls, within the daily question budget)"
                      >
                        {starting ? "Starting…" : `Write ${X} for ${toWrite.toLocaleString()} lead${toWrite === 1 ? "" : "s"}`}
                      </Button>
                      {data.workerReady === false && (
                        <span className="text-muted-foreground">The enrichment worker can&apos;t write question variables yet.</span>
                      )}
                      {lastJob && !OPEN_JOB.has(lastJob.status) && (
                        <span className="text-muted-foreground">
                          Last write: {JOB_STATE[lastJob.status] ?? lastJob.status}, {n(lastJob.done).toLocaleString()} of{" "}
                          {n(lastJob.total).toLocaleString()}
                          {n(lastJob.failed) > 0 ? `, ${n(lastJob.failed).toLocaleString()} failed` : ""}
                          {lastJob.error ? ` (${lastJob.error})` : lastJob.note ? ` (${lastJob.note})` : ""}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Bison: blocks the push while an install lacks the variable. */}
                  {!bisonNow ? (
                    <p className="text-muted-foreground">Checking {X} in Bison…</p>
                  ) : bisonNow.error ? (
                    <p className="text-amber-700">Couldn&apos;t check {X} in Bison: {bisonNow.error}</p>
                  ) : missingOn.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-2 text-destructive">
                      <span>
                        Create {X} in Bison first: it is missing on {missingOn.join(", ")}.
                      </span>
                      <a href={setupHref} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">
                        Open the Clay tab
                      </a>
                      <button
                        type="button"
                        onClick={() => void recheckBison()}
                        disabled={bisonChecking}
                        className="inline-flex items-center gap-1 font-medium text-primary hover:underline disabled:opacity-50"
                      >
                        <RefreshCw className={`size-3 ${bisonChecking ? "animate-spin" : ""}`} />
                        Check again
                      </button>
                    </div>
                  ) : unknownOn.length > 0 ? (
                    <p className="text-amber-700">
                      Couldn&apos;t check {X} on {unknownOn.map((i) => `${i.install}${i.error ? ` (${i.error})` : ""}`).join(", ")}.
                    </p>
                  ) : installs.length > 0 ? (
                    <p className="text-muted-foreground">{X} is set up on {installs.map((i) => i.install).join(" and ")}.</p>
                  ) : null}

                  {/* Copy: warns, never blocks. */}
                  {copyNow?.error && <p className="text-amber-700">Couldn&apos;t check the campaigns&apos; copy: {copyNow.error}</p>}
                  {(copyNow?.value?.campaigns ?? []).map((c) =>
                    c.error ? (
                      <p key={`${c.instance_url}#${c.id}`} className="text-amber-700">
                        Couldn&apos;t read the copy of {nameOf(c.instance_url, c.id)}: {c.error}
                      </p>
                    ) : !c.usesVariable ? (
                      <p key={`${c.instance_url}#${c.id}`} className="text-amber-700">
                        {nameOf(c.instance_url, c.id)}&apos;s copy does not use {X}
                        {c.usesQuestion ? `: it still uses ${DEFAULT_COPY_TAG}` : ""}.
                      </p>
                    ) : null
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
