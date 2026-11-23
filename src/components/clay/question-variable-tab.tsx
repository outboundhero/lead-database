"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, Plus, RefreshCw, Save, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useHasPermission } from "@/lib/context/role-context";
import {
  OPEN_JOB_STATUSES,
  type BisonCreateResult,
  type BisonView,
  type ContextView,
  type JobView,
  type JobsView,
  type ValueView,
  type ValuesView,
  type VariableDetail,
  type VariablesView,
  type VariableView,
} from "@/lib/questions/types";
import { canonicalVariableName, copyTag, defaultVariableNameFor, variableNameError } from "../../../scripts/lib/questions/names.mjs";
import { placeholderErrors, QUESTION_PLACEHOLDERS, RESEARCH_PLACEHOLDERS } from "../../../scripts/lib/questions/render.mjs";

// The Clay tab's Client setup, "Question variable" (migration 139): which
// question a client's pushes use (the default {QUESTION} or a variable of its
// own, such as {ACME-OS QUESTION}), the variable's editor (name, services,
// client context, the research prompt, the People and General question
// prompts, max words), whether it exists on the client's Bison installs (and
// "Create in Bison"), the client's question jobs and the latest values written.
// Managers see everything and pick the client's question; admins make, edit
// and archive variables and make them in Bison. Jobs start from the export
// popup, where the selection is: there is no "write now" here.
//
// Loads fresh when opened (and per client: the tab is keyed by its tag), sends
// the variable's version back with a save, and reloads it on a 409. Unsaved
// edits are guarded (a confirm before another variable is opened, and the
// browser's own question before the page is left).

const DEFAULT = "__default";
const NONE = "__none";
const NEW = "new";

/** What the editor holds for one variable. name is only typed for a new one. */
interface Draft {
  name: string;
  services: string;
  clientContext: string;
  researchPrompt: string;
  peoplePrompt: string;
  generalPrompt: string;
  maxWords: number;
}

type PromptKey = "researchPrompt" | "peoplePrompt" | "generalPrompt";

const PROMPTS: ReadonlyArray<{ key: PromptKey; label: string; hint: string; placeholders: readonly string[] }> = [
  {
    key: "researchPrompt",
    label: "Research prompt",
    hint: "Asked once per company, with web search, and reused by every lead of that company. Its answer has three fields: company_summary, service_spaces and best_fit. It may only read what is the same for the whole company.",
    placeholders: RESEARCH_PLACEHOLDERS,
  },
  {
    key: "peoplePrompt",
    label: "People question prompt",
    hint: "Writes the question for a person's address. It may read the person and the research answer.",
    placeholders: QUESTION_PLACEHOLDERS,
  },
  {
    key: "generalPrompt",
    label: "General question prompt",
    hint: "Writes the question for a general inbox (an info@ or office@ address).",
    placeholders: QUESTION_PLACEHOLDERS,
  },
];

const TEXTAREA = "mt-1 w-full rounded-xl bg-card p-3 text-[13px] leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 read-only:opacity-80";
const CARD = "space-y-3 rounded-2xl bg-muted/50 p-3";

const draftOf = (v: VariableDetail): Draft => ({
  name: v.name,
  services: v.services,
  clientContext: v.clientContext,
  researchPrompt: v.researchPrompt,
  peoplePrompt: v.peoplePrompt,
  generalPrompt: v.generalPrompt,
  maxWords: v.maxWords,
});

const blankDraft = (tag: string): Draft => ({
  name: defaultVariableNameFor(tag),
  services: "",
  clientContext: "",
  researchPrompt: "",
  peoplePrompt: "",
  generalPrompt: "",
  maxWords: 16,
});

const sameDraft = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);
const money = (n: number) => `$${n.toFixed(2)}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
const fmt = (n: number) => n.toLocaleString("en-US");

const JOB_LABEL: Record<JobView["status"], string> = {
  queued: "Queued",
  gathering: "Gathering leads",
  running: "Writing",
  paused: "Paused",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
};

async function getJson<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: T & { error?: string; errors?: string[]; changed?: boolean } }> {
  const res = await fetch(url, init);
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    body = { error: `The server answered ${res.status}` };
  }
  return { ok: res.ok, status: res.status, body: body as T & { error?: string; errors?: string[]; changed?: boolean } };
}

const send = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/** The Question variable tab of the Clay tab's Client setup sheet. */
export function QuestionVariableTab({ tag }: { tag: string }) {
  // Keyed by the client, so a client switch starts the tab afresh.
  return <QuestionVariableEditor key={tag} tag={tag} />;
}

function QuestionVariableEditor({ tag }: { tag: string }) {
  const isAdmin = useHasPermission("admin");
  const [list, setList] = useState<VariablesView | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<VariableView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [base, setBase] = useState<Draft | null>(null);
  const [startFrom, setStartFrom] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [bison, setBison] = useState<BisonView | null>(null);
  const [bisonBusy, setBisonBusy] = useState(false);
  const [bisonError, setBisonError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [values, setValues] = useState<ValueView[] | null>(null);
  const areas = useRef<Partial<Record<PromptKey, HTMLTextAreaElement | null>>>({});

  const dirty = draft !== null && base !== null && !sameDraft(draft, base);
  const isNew = selected === NEW;
  const readOnly = !isAdmin;

  const loadList = useCallback(async (): Promise<VariablesView | null> => {
    try {
      const r = await getJson<VariablesView>(`/api/questions/variables?tag=${encodeURIComponent(tag)}`);
      if (!r.ok) throw new Error(r.body.error ?? "Could not load the question variables");
      setList(r.body);
      setListError(null);
      return r.body;
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Could not load the question variables");
      return null;
    }
  }, [tag]);

  const loadJobs = useCallback(async () => {
    try {
      const r = await getJson<JobsView>(`/api/questions/jobs?tag=${encodeURIComponent(tag)}`);
      if (r.ok) setJobs(r.body.jobs);
    } catch {
      /* the next poll tries again */
    }
  }, [tag]);

  const loadValues = useCallback(
    async (id: string) => {
      try {
        const r = await getJson<ValuesView>(`/api/questions/values?variableId=${id}&tag=${encodeURIComponent(tag)}&limit=20`);
        if (r.ok) setValues(r.body.values);
      } catch {
        setValues([]);
      }
    },
    [tag]
  );

  const loadBison = useCallback(
    async (id: string) => {
      setBisonBusy(true);
      try {
        const r = await getJson<BisonView>(`/api/questions/bison?tag=${encodeURIComponent(tag)}&variableId=${id}`);
        if (!r.ok) throw new Error(r.body.error ?? "Could not read Bison");
        setBison(r.body);
        setBisonError(null);
      } catch (e) {
        setBisonError(e instanceof Error ? e.message : "Could not read Bison");
      } finally {
        setBisonBusy(false);
      }
    },
    [tag]
  );

  /** Opens a variable (fresh from the server), a new one, or nothing. */
  const open = useCallback(
    async (id: string | null) => {
      setSelected(id);
      setErrors([]);
      setDetail(null);
      setBison(null);
      setBisonError(null);
      setValues(null);
      setStartFrom(null);
      if (id === NEW) {
        const blank = blankDraft(tag);
        setDraft(blank);
        setBase(blank);
        return;
      }
      setDraft(null);
      setBase(null);
      if (!id) return;
      const r = await getJson<VariableView>(`/api/questions/variables/${id}`);
      if (!r.ok) {
        toast.error(r.body.error ?? "Could not load the variable");
        return;
      }
      setDetail(r.body);
      setDraft(draftOf(r.body.variable));
      setBase(draftOf(r.body.variable));
      void loadBison(id);
      void loadValues(id);
    },
    [tag, loadBison, loadValues]
  );

  // First load: the list, the client's jobs, and the variable to show (the client's choice, else its own, else none).
  useEffect(() => {
    let gone = false;
    (async () => {
      const l = await loadList();
      void loadJobs();
      if (gone || !l) return;
      const own = l.variables.find((v) => v.createdForTag === tag && !v.archived);
      await open(l.current.variableId ?? own?.id ?? null);
    })();
    return () => {
      gone = true;
    };
  }, [loadList, loadJobs, open, tag]);

  // While a job is open its progress is read every 4 seconds.
  const hasOpenJob = (jobs ?? []).some((j) => OPEN_JOB_STATUSES.includes(j.status));
  useEffect(() => {
    if (!hasOpenJob) return;
    const t = setInterval(() => void loadJobs(), 4_000);
    return () => clearInterval(t);
  }, [hasOpenJob, loadJobs]);

  // The browser asks before the page is closed or reloaded with edits not saved.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);

  const pick = (id: string | null) => {
    if (dirty && !window.confirm("This variable has edits not saved. Leave them?")) return;
    void open(id);
  };

  const choose = async (value: string) => {
    const variableId = value === DEFAULT ? null : value;
    setChoosing(true);
    try {
      const r = await getJson<VariablesView>("/api/questions/client", send("PUT", { tag, variableId }));
      if (!r.ok) throw new Error(r.body.error ?? "Could not save the client's question");
      setList(r.body);
      const chosen = r.body.variables.find((v) => v.id === variableId);
      toast.success(`${tag}'s pushes use ${chosen ? chosen.copyTag : "the default {QUESTION}"}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the client's question");
    } finally {
      setChoosing(false);
    }
  };

  const insert = (key: PromptKey, name: string) => {
    if (!draft || readOnly) return;
    const el = areas.current[key];
    const cur = draft[key];
    const start = el?.selectionStart ?? cur.length;
    const end = el?.selectionEnd ?? cur.length;
    const token = `{{${name}}}`;
    setDraft({ ...draft, [key]: cur.slice(0, start) + token + cur.slice(end) });
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const fillFromOnboarding = async () => {
    if (!draft) return;
    const r = await getJson<ContextView>(`/api/questions/context?tag=${encodeURIComponent(tag)}`);
    if (!r.ok) {
      toast.error(r.body.error ?? "Could not read the onboarding answers");
      return;
    }
    const target = r.body.target;
    if (!target) {
      toast.info(`${tag}'s onboarding sheet has no answer about who it targets`);
      return;
    }
    if (draft.clientContext.trim() && !window.confirm("Replace the client context with the onboarding sheet's answer?")) return;
    setDraft({ ...draft, clientContext: target.slice(0, 6000) });
  };

  const copyFrom = async (id: string) => {
    if (!draft) return;
    if (id === NONE) {
      setStartFrom(null);
      return;
    }
    const r = await getJson<VariableView>(`/api/questions/variables/${id}`);
    if (!r.ok) {
      toast.error(r.body.error ?? "Could not load that variable");
      return;
    }
    const v = r.body.variable;
    setStartFrom(id);
    setDraft({ ...draft, services: v.services, clientContext: v.clientContext, researchPrompt: v.researchPrompt, peoplePrompt: v.peoplePrompt, generalPrompt: v.generalPrompt, maxWords: v.maxWords });
  };

  const save = async () => {
    if (!draft || !selected) return;
    setSaving(true);
    setErrors([]);
    try {
      const fields = {
        services: draft.services,
        clientContext: draft.clientContext,
        researchPrompt: draft.researchPrompt,
        peoplePrompt: draft.peoplePrompt,
        generalPrompt: draft.generalPrompt,
        maxWords: draft.maxWords,
      };
      const r = isNew
        ? await getJson<VariableView>("/api/questions/variables", send("POST", { tag, name: draft.name, ...(startFrom ? { copyFromId: startFrom } : {}), ...fields }))
        : await getJson<VariableView>(`/api/questions/variables/${selected}`, send("PUT", { version: detail?.variable.version, ...fields }));
      if (!r.ok) {
        if (r.status === 409 && r.body.changed && !isNew) {
          toast.error(r.body.error ?? "The variable changed since it was opened");
          await open(selected);
          return;
        }
        if (Array.isArray(r.body.errors)) setErrors(r.body.errors);
        throw new Error(r.body.error ?? "Could not save the variable");
      }
      const v = r.body.variable;
      setSelected(v.id);
      setDetail(r.body);
      setDraft(draftOf(v));
      setBase(draftOf(v));
      setStartFrom(null);
      toast.success(isNew ? `${v.copyTag} made. Pick it as ${tag}'s question above to use it in pushes.` : `${v.copyTag} saved`);
      await loadList();
      if (isNew) {
        void loadBison(v.id);
        void loadValues(v.id);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the variable");
    } finally {
      setSaving(false);
    }
  };

  const archive = async (archived: boolean) => {
    if (!detail) return;
    const v = detail.variable;
    if (archived && !window.confirm(`Archive ${v.copyTag}? A push can't send it while it is archived, and its open jobs wait. Its values are kept.`)) return;
    const r = await getJson<VariableView>(`/api/questions/variables/${v.id}/archive`, send("POST", { archived, version: v.version }));
    if (!r.ok) {
      toast.error(r.body.error ?? "Could not change the variable");
      if (r.status === 409) await open(v.id);
      return;
    }
    setDetail(r.body);
    toast.success(`${v.copyTag} ${archived ? "archived" : "restored"}`);
    await loadList();
  };

  const createInBison = async () => {
    if (!detail) return;
    setBisonBusy(true);
    try {
      const r = await getJson<BisonCreateResult>("/api/questions/bison", send("POST", { tag, variableId: detail.variable.id }));
      if (!r.ok) throw new Error(r.body.error ?? "Could not make the variable in Bison");
      const { created, existed, failed } = r.body;
      const parts = [
        created.length ? `made on ${created.join(", ")}` : "",
        existed.length ? `already on ${existed.join(", ")}` : "",
        failed.length ? `failed on ${failed.map((f) => `${f.install} (${f.error})`).join(", ")}` : "",
      ].filter(Boolean);
      (failed.length ? toast.error : toast.success)(`${detail.variable.copyTag}: ${parts.join("; ")}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not make the variable in Bison");
    } finally {
      setBisonBusy(false);
    }
    await loadBison(detail.variable.id);
  };

  const cancelJob = async (job: JobView) => {
    if (!window.confirm(`Stop writing ${copyTag(job.variableName)}? Values already written stay.`)) return;
    const r = await getJson<{ cancelled: boolean }>("/api/questions/jobs/cancel", send("POST", { jobId: job.id }));
    if (!r.ok) toast.error(r.body.error ?? "Could not cancel the job");
    else toast.success("Job cancelled");
    await loadJobs();
  };

  // ── What is shown ─────────────────────────────────────────────────────────

  if (listError && !list) {
    return (
      <div className="rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
        {listError}{" "}
        <button type="button" className="font-semibold underline" onClick={() => void loadList()}>
          Try again
        </button>
      </div>
    );
  }
  if (!list) {
    return (
      <div className="flex min-h-[160px] items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const current = list.current.variableId;
  const choices = list.variables.filter((v) => !v.archived || v.id === current);
  const variable = detail?.variable ?? null;
  const canonical = isNew && draft ? canonicalVariableName(draft.name) : "";
  const taken = isNew && canonical ? list.variables.some((v) => v.name === canonical) : false;
  const nameError = isNew && draft ? variableNameError(canonical) ?? (taken ? `${copyTag(canonical)} already exists: pick it from the list.` : null) : null;
  const promptErrors = draft ? PROMPTS.flatMap((p) => placeholderErrors(draft[p.key], p.placeholders).map((e) => `${p.label}: ${e}`)) : [];
  const missingInstalls = bison?.installs.filter((i) => i.exists === false) ?? [];
  const clientJobs = jobs ?? [];

  return (
    <div className="space-y-4">
      <section className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13.5px] font-medium">This client&apos;s question</p>
          {list.isOs && (
            <Badge variant="tinted" className="text-[12px]">
              OS client
            </Badge>
          )}
        </div>
        <Select value={current ?? DEFAULT} onValueChange={(v) => void choose(v)} disabled={choosing}>
          <SelectTrigger size="sm" className="h-9 w-full rounded-full text-[13px]" aria-label="This client's question">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT}>Default {"{QUESTION}"}</SelectItem>
            {choices.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.copyTag}
                {v.archived ? " (archived)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {list.switchOn
            ? `On for ${tag}: the export popup can write the chosen variable for the leads it pushes, and send it with them.`
            : `Off for ${tag} (turn on under Companies tab → Settings). Variables can still be made and edited; no job starts.`}
        </p>
        {!list.workerReady && (
          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-[var(--warning)]">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            The worker running doesn&apos;t write question variables (it is off, or older than this page), so no job can start yet.
          </p>
        )}
      </section>

      <section className={CARD}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 basis-[220px]">
            <p className="mb-1 text-[12.5px] font-medium">Variable</p>
            <Select value={selected ?? NONE} onValueChange={(v) => pick(v === NONE ? null : v)}>
              <SelectTrigger size="sm" className="h-9 w-full rounded-full text-[13px]" aria-label="Variable to edit">
                <SelectValue placeholder="Pick a variable" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>None open</SelectItem>
                {list.variables.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.copyTag}
                    {v.createdForTag && v.createdForTag !== tag ? ` (made for ${v.createdForTag})` : ""}
                    {v.archived ? " (archived)" : ""}
                  </SelectItem>
                ))}
                {isAdmin && <SelectItem value={NEW}>New variable…</SelectItem>}
              </SelectContent>
            </Select>
          </div>
          {isAdmin && !isNew && (
            <Button size="sm" variant="outline" onClick={() => pick(NEW)}>
              <Plus /> New variable
            </Button>
          )}
        </div>

        {!selected && (
          <p className="text-[12.5px] text-muted-foreground">
            {list.variables.length
              ? "Pick a variable to see or edit it."
              : isAdmin
                ? `No question variable yet. Make one for ${tag} with "New variable".`
                : "No question variable yet: an admin makes one."}
          </p>
        )}

        {selected && !draft && (
          <div className="flex min-h-[80px] items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}

        {draft && (
          <div className="space-y-3">
            {isNew ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-[12.5px] font-medium">
                  Name
                  <Input
                    className="mt-1 h-9 rounded-full text-[13px]"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    maxLength={80}
                    spellCheck={false}
                  />
                  <span className={`mt-1 block text-[12px] font-normal leading-relaxed ${nameError ? "text-destructive" : "text-muted-foreground"}`}>
                    {nameError ??
                      `Campaign copy writes it as ${copyTag(canonical)}. Bison keeps it lower case: letters, digits, spaces, dashes or underscores, up to 63. It can't change once made.`}
                  </span>
                </label>
                <div>
                  <p className="text-[12.5px] font-medium">Start from</p>
                  <Select value={startFrom ?? NONE} onValueChange={(v) => void copyFrom(v)}>
                    <SelectTrigger size="sm" className="mt-1 h-9 w-full rounded-full text-[13px]" aria-label="Start from another variable">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Nothing (empty)</SelectItem>
                      {list.variables.map((v) => (
                        <SelectItem key={v.id} value={v.id}>
                          {v.copyTag}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">Copies its services, context, prompts and max words into this one.</p>
                </div>
              </div>
            ) : (
              variable && (
                <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  <span className="font-mono text-[13px] font-semibold">{variable.copyTag}</span>
                  {variable.archived && (
                    <Badge variant="warning" className="text-[12px]">
                      Archived
                    </Badge>
                  )}
                  <span className="text-muted-foreground">
                    {variable.createdForTag ? `Made for ${variable.createdForTag}. ` : ""}
                    Prompt version {variable.promptVersion}
                    {variable.updatedAt ? `, saved ${when(variable.updatedAt)}${variable.updatedBy ? ` by ${variable.updatedBy}` : ""}` : ""}.
                  </span>
                </div>
              )
            )}

            <label className="block text-[12.5px] font-medium">
              Services
              <textarea
                className={`${TEXTAREA} h-20`}
                value={draft.services}
                onChange={(e) => setDraft({ ...draft, services: e.target.value })}
                readOnly={readOnly}
                maxLength={2000}
                placeholder="What the client sells, in a line or two: the prompts read it as {{Services}}"
              />
            </label>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12.5px] font-medium">Client context</p>
                {!readOnly && (
                  <Button size="xs" variant="ghost" onClick={() => void fillFromOnboarding()}>
                    Fill from onboarding
                  </Button>
                )}
              </div>
              <textarea
                className={`${TEXTAREA} h-28`}
                value={draft.clientContext}
                onChange={(e) => setDraft({ ...draft, clientContext: e.target.value })}
                readOnly={readOnly}
                maxLength={6000}
                placeholder="Who the client is and who it wants to reach: the prompts read it as {{Client Context}}"
                aria-label="Client context"
              />
            </div>

            {PROMPTS.map((p) => {
              const errs = placeholderErrors(draft[p.key], p.placeholders);
              return (
                <div key={p.key}>
                  <p className="text-[12.5px] font-medium">{p.label}</p>
                  <p className="text-[12px] leading-relaxed text-muted-foreground">{p.hint}</p>
                  <textarea
                    ref={(el) => {
                      areas.current[p.key] = el;
                    }}
                    className={`${TEXTAREA} h-40 font-mono text-[12.5px]`}
                    value={draft[p.key]}
                    onChange={(e) => setDraft({ ...draft, [p.key]: e.target.value })}
                    readOnly={readOnly}
                    maxLength={20000}
                    spellCheck={false}
                    aria-label={p.label}
                  />
                  {!readOnly && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {p.placeholders.map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => insert(p.key, name)}
                          className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[12px] text-primary hover:bg-primary/20"
                        >
                          {`{{${name}}}`}
                        </button>
                      ))}
                    </div>
                  )}
                  {errs.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[12px] text-destructive">
                      {errs.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}

            <label className="block w-40 text-[12.5px] font-medium">
              Max words
              <Input
                type="number"
                min={4}
                max={40}
                className="mt-1 h-9 rounded-full text-[13px] tabular-nums"
                value={Number.isFinite(draft.maxWords) ? draft.maxWords : ""}
                onChange={(e) => setDraft({ ...draft, maxWords: e.target.value.trim() === "" ? Number.NaN : Number(e.target.value) })}
                readOnly={readOnly}
              />
            </label>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              A question over this many words is asked for once more, then left unwritten. Long dashes and curly braces are taken out, and the first
              letter is written lower case, as Clay&apos;s question column does. Saving a change makes the values written before it stale: they are
              still sent, and a job writes them again.
            </p>

            {errors.length > 0 && (
              <ul className="space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
                {errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            )}

            {readOnly ? (
              <p className="text-[12px] text-muted-foreground">Only admins can make or change a variable.</p>
            ) : (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {!isNew && variable && (
                  <Button size="sm" variant="ghost" onClick={() => void archive(!variable.archived)}>
                    {variable.archived ? "Restore" : "Archive"}
                  </Button>
                )}
                {isNew && (
                  <Button size="sm" variant="ghost" onClick={() => pick(null)}>
                    Cancel
                  </Button>
                )}
                <Button size="sm" onClick={() => void save()} disabled={saving || !dirty || Boolean(nameError) || promptErrors.length > 0}>
                  {saving ? <Loader2 className="animate-spin" /> : <Save />} {isNew ? "Make variable" : "Save"}
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      {variable && (
        <section className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13.5px] font-medium">In Bison</p>
            <Button size="xs" variant="ghost" onClick={() => void loadBison(variable.id)} disabled={bisonBusy}>
              <RefreshCw className={bisonBusy ? "animate-spin" : ""} /> Check again
            </Button>
          </div>
          {bisonError && <p className="text-[12.5px] text-destructive">{bisonError}</p>}
          {bison && bison.installs.length === 0 && (
            <p className="text-[12.5px] text-muted-foreground">
              {tag} has no Bison installs saved yet: they are set by the client sheet or its first push.
            </p>
          )}
          {bison && bison.installs.length > 0 && (
            <ul className="space-y-1">
              {bison.installs.map((i) => (
                <li key={i.install} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                  {i.exists === true ? (
                    <Check className="size-3.5 text-[var(--success)]" />
                  ) : i.exists === false ? (
                    <X className="size-3.5 text-destructive" />
                  ) : (
                    <AlertTriangle className="size-3.5 text-[var(--warning)]" />
                  )}
                  <span className="font-mono">{i.install}</span>
                  <span className="text-muted-foreground">({i.side.toUpperCase()})</span>
                  <span className={i.exists === false ? "text-destructive" : "text-muted-foreground"}>
                    {i.exists === true ? `has ${bison.copyTag}` : i.exists === false ? `has no ${bison.copyTag}` : i.error}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {isAdmin && missingInstalls.length > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Bison refuses a lead whose push names a variable its install lacks, so make it before pushing.
              </p>
              <Button size="sm" onClick={() => void createInBison()} disabled={bisonBusy || variable.archived}>
                {bisonBusy ? <Loader2 className="animate-spin" /> : <Plus />} Create in Bison
              </Button>
            </div>
          )}
        </section>
      )}

      <section className={CARD}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[13.5px] font-medium">Jobs</p>
          <Button size="xs" variant="ghost" onClick={() => void loadJobs()}>
            <RefreshCw /> Refresh
          </Button>
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          Jobs start from the export popup (Leads page, Export, Push to Bison), where the selection is: a research call per company and a question
          per lead, under the day&apos;s budget.
        </p>
        {jobs === null ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : clientJobs.length === 0 ? (
          <p className="text-[12.5px] text-muted-foreground">No job for {tag} yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {clientJobs.map((j) => {
              const open = OPEN_JOB_STATUSES.includes(j.status);
              return (
                <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-[12.5px]">
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-semibold">{copyTag(j.variableName)}</span>
                      <Badge
                        variant={j.status === "done" ? "success" : j.status === "error" ? "destructive" : j.status === "paused" ? "warning" : "secondary"}
                        className="text-[12px]"
                      >
                        {JOB_LABEL[j.status]}
                      </Badge>
                      <span className="text-muted-foreground">{when(j.createdAt)}</span>
                    </div>
                    <p className="text-muted-foreground">
                      {fmt(j.done)} of {fmt(j.total)} written
                      {j.failed ? `, ${fmt(j.failed)} failed` : ""}
                      {j.skipped ? `, ${fmt(j.skipped)} skipped` : ""}, {fmt(j.researched)} of {fmt(j.companies)} companies researched, {money(j.spendUsd)}
                    </p>
                    {(j.note || j.error) && <p className={j.error ? "text-destructive" : "text-[var(--warning)]"}>{j.error ?? j.note}</p>}
                  </div>
                  {open && (
                    <Button size="xs" variant="outline" onClick={() => void cancelJob(j)}>
                      Cancel
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {variable && (
        <section className={CARD}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[13.5px] font-medium">Latest values of {variable.copyTag}</p>
            <Button size="xs" variant="ghost" onClick={() => void loadValues(variable.id)}>
              <RefreshCw /> Refresh
            </Button>
          </div>
          {values === null ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : values.length === 0 ? (
            <p className="text-[12.5px] text-muted-foreground">Nothing written for {tag} yet.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <table className="w-full text-left text-[12.5px]">
                <thead className="text-[12px] text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Company</th>
                    <th className="py-1 pr-2 font-medium">Title</th>
                    <th className="py-1 pr-2 font-medium">Question</th>
                    <th className="py-1 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {values.map((v, i) => (
                    <tr key={`${v.generatedAt}-${i}`} className="align-top">
                      <td className="py-1.5 pr-2">{v.company ?? ""}</td>
                      <td className="py-1.5 pr-2 text-muted-foreground">{v.title ?? ""}</td>
                      <td className="py-1.5 pr-2">{v.value ?? <span className="text-muted-foreground">{v.note ?? ""}</span>}</td>
                      <td className="py-1.5">{v.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
