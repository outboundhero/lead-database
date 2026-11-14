"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { TagInput } from "@/components/ui/ios/tag-input";
import {
  EFFORTS,
  MODEL_STEPS,
  type Effort,
  type ModelStep,
  type PipelineSettings,
  type SettingsInput,
  type SettingsState,
} from "@/lib/companies/types";

// The pipeline's settings (enrich_settings), admins only: company pulls, people
// runs and personalisation, each switch with its client list (an empty list
// covers no client), their caps, the daily spend caps, and for each original
// Clay AI step its model, reasoning effort and most searches. Saved through
// PUT /api/companies/settings; the worker reads them every 30 s, so a model
// is swapped with no deploy. Fit scoring, promotion and the gate have their
// own panel.

const NOT_SENT = "__not_sent"; // a Select item can't have an empty value

function toInput(v: PipelineSettings): SettingsInput {
  const models = {} as SettingsInput["models"];
  for (const step of MODEL_STEPS) {
    const m = v.models[step.key];
    models[step.key] = {
      model: m?.model ?? "",
      reasoning_effort: m?.reasoning_effort ?? null,
      max_searches: step.tool === "web" ? m?.max_searches ?? Number.NaN : null,
    };
  }
  const cp = v.company_pipeline;
  return {
    company_pipeline: {
      enabled: cp.enabled, tags: [...cp.tags], max_pull_size: cp.max_pull_size, linkedin_profile_reads: cp.linkedin_profile_reads,
      inboxes_per_company: cp.inboxes_per_company, min_balance: cp.min_balance,
    },
    people_pipeline: { ...v.people_pipeline, tags: [...v.people_pipeline.tags] },
    personalisation: { ...v.personalisation, tags: [...v.personalisation.tags] },
    spend_caps: { reoon_checks_per_day: v.spend_caps.reoon_checks_per_day, openai_usd_per_day: { ...v.spend_caps.openai_usd_per_day } },
    models,
  };
}

const numberIn = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));
const tagsIn = (values: string[]) => [...new Set(values.map((v) => v.trim().toUpperCase()).filter(Boolean))];

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1 basis-[180px]">
      <p className="mb-1 text-[12.5px] font-medium">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

function NumberField({ label, hint, value, onChange, min, max, step }: { label: string; hint?: string; value: number; onChange: (n: number) => void; min: number; max: number; step?: number }) {
  return (
    <Field label={label} hint={hint}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(numberIn(e.target.value))}
        className="h-9 rounded-full text-[13px] tabular-nums"
        aria-label={label}
      />
    </Field>
  );
}

function Switch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-[13.5px] font-medium">{label}</p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <IosToggle checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function Clients({ label, tags, onChange }: { label: string; tags: string[]; onChange: (t: string[]) => void }) {
  return (
    <Field
      label={`${label}: clients`}
      hint={tags.length ? `Covers ${tags.length} client${tags.length === 1 ? "" : "s"} while switched on.` : "No client: switched on, it still covers nobody."}
    >
      <TagInput values={tags} onChange={(v) => onChange(tagsIn(v))} placeholder="Add a client tag" maxTags={2000} />
    </Field>
  );
}

const Section = ({ children }: { children: React.ReactNode }) => <section className="space-y-3 rounded-2xl bg-muted/50 p-3">{children}</section>;

export function SettingsSheet({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (s: SettingsState) => void;
}) {
  const [state, setState] = useState<SettingsState | null>(null);
  const [form, setForm] = useState<SettingsInput | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/companies/settings");
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? "Could not load the settings");
      setState(j);
      setForm(toInput(j.value));
      setErrors([]);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the settings");
    }
  }, []);

  // Read fresh every time the sheet opens, so it never edits values someone has changed since.
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const dirty = !!form && !!state && JSON.stringify(form) !== JSON.stringify(toInput(state.value));
  const set = <S extends "company_pipeline" | "people_pipeline" | "personalisation", Key extends keyof SettingsInput[S]>(section: S, k: Key, v: SettingsInput[S][Key]) =>
    setForm((f) => (f ? { ...f, [section]: { ...f[section], [k]: v } } : f));
  const setCaps = (k: "reoon_checks_per_day" | "pipeline" | "fit", v: number) =>
    setForm((f) =>
      f
        ? {
            ...f,
            spend_caps:
              k === "reoon_checks_per_day"
                ? { ...f.spend_caps, reoon_checks_per_day: v }
                : { ...f.spend_caps, openai_usd_per_day: { ...f.spend_caps.openai_usd_per_day, [k]: v } },
          }
        : f
    );
  const setStep = <K extends keyof SettingsInput["models"][ModelStep]>(step: ModelStep, k: K, v: SettingsInput["models"][ModelStep][K]) =>
    setForm((f) => (f ? { ...f, models: { ...f.models, [step]: { ...f.models[step], [k]: v } } } : f));

  const save = async () => {
    if (!form || !state) return;
    setSaving(true);
    setErrors([]);
    try {
      const res = await fetch("/api/companies/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: state.version, ...form }),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j.changed) await load();
        else if (Array.isArray(j.errors)) setErrors(j.errors);
        throw new Error(j.error ?? "Could not save the settings");
      }
      const saved: SettingsState = { value: j.value, version: j.version };
      setState(saved);
      setForm(toInput(saved.value));
      onSaved(saved);
      if (j.changes?.length) {
        toast.success("Settings saved. The worker uses them within 30 seconds.");
        onOpenChange(false);
      } else {
        toast.success("Nothing changed");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the settings");
    } finally {
      setSaving(false);
    }
  };

  const memory = state?.value.company_pipeline.memory_days;
  const cp = form?.company_pipeline;
  const pp = form?.people_pipeline;
  const ps = form?.personalisation;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-xl">
        <SheetHeader className="pb-0">
          <SheetTitle>Pipeline settings</SheetTitle>
          <SheetDescription>For every client. The worker reads these every 30 seconds, so a change needs no deploy.</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-2">
          {loadError && (
            <div className="rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
              {loadError}{" "}
              <button type="button" className="font-semibold underline" onClick={load}>
                Try again
              </button>
            </div>
          )}
          {!form || !cp || !pp || !ps ? (
            !loadError && (
              <div className="flex min-h-[200px] items-center justify-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            )
          ) : (
            <>
              <Section>
                <Switch
                  label="Company pulls"
                  hint={cp.enabled ? "On, for the clients listed below: managers can count and pull their companies." : "Off: nothing can be counted or pulled. A pull already going carries on until it is cancelled."}
                  checked={cp.enabled}
                  onChange={(v) => set("company_pipeline", "enabled", v)}
                />
                <Clients label="Company pulls" tags={cp.tags} onChange={(t) => set("company_pipeline", "tags", t)} />
                <div className="flex flex-wrap gap-3">
                  <NumberField label="Largest pull" hint="Companies one pull may buy, 1 to 10,000." value={cp.max_pull_size} min={1} max={10000} onChange={(n) => set("company_pipeline", "max_pull_size", n)} />
                  <NumberField label="General inboxes per company" hint="Addresses the email searches' finds are written as, 1 to 30. The rest are counted, not checked." value={cp.inboxes_per_company} min={1} max={30} onChange={(n) => set("company_pipeline", "inboxes_per_company", n)} />
                  <NumberField label="Lowest AI Ark balance" hint="A pull stops before going under it (credits)." value={cp.min_balance} min={0} max={1000000} onChange={(n) => set("company_pipeline", "min_balance", n)} />
                </div>
                <Switch
                  label="LinkedIn profile reads"
                  hint="Two steps read a LinkedIn profile: the location check of the AI-search people and the current employer. Keep this off until LinkedIn's terms are signed off in writing."
                  checked={cp.linkedin_profile_reads}
                  onChange={(v) => set("company_pipeline", "linkedin_profile_reads", v)}
                />
                {cp.linkedin_profile_reads && (
                  <p className="flex gap-2 rounded-xl bg-[var(--warning)]/12 px-3 py-2 text-[12px] leading-relaxed">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
                    LinkedIn&apos;s terms forbid automated reading of its pages. Switch this on only with a written sign-off.
                  </p>
                )}
              </Section>

              <Section>
                <Switch
                  label="People runs"
                  hint={pp.enabled ? "On, for the clients listed below: managers can look for the people at their companies and buy them." : "Off: no people run can start, and a run going stops before its next paid call."}
                  checked={pp.enabled}
                  onChange={(v) => set("people_pipeline", "enabled", v)}
                />
                <Clients label="People runs" tags={pp.tags} onChange={(t) => set("people_pipeline", "tags", t)} />
                <Switch
                  label="Buy without a click"
                  hint="Off: after a Look a run waits for a manager to click Buy, so the credits are seen first. Keep it off until the first runs show the find rate."
                  checked={pp.auto_buy}
                  onChange={(v) => set("people_pipeline", "auto_buy", v)}
                />
                <Switch
                  label="AI searches for decision makers"
                  hint="The original web searches for a track where AI Ark found nobody. Their people get no email until a finder key is held, so they cost OpenAI dollars with little to show yet."
                  checked={pp.ai_searches}
                  onChange={(v) => set("people_pipeline", "ai_searches", v)}
                />
                <Switch
                  label="Skip a company where someone is held"
                  hint="On: a company with a usable named lead already in the database, or one the Look finds held, is not bought for."
                  checked={pp.skip_company_when_held}
                  onChange={(v) => set("people_pipeline", "skip_company_when_held", v)}
                />
                <div className="flex flex-wrap gap-3">
                  <NumberField label="Companies per search" hint="AI Ark company ids in one Look, 1 to 300. Halved by itself when AI Ark says the request is too large." value={pp.ids_per_search} min={1} max={300} onChange={(n) => set("people_pipeline", "ids_per_search", n)} />
                  <NumberField label="Pages per search" hint="Preview pages of 100 one search may look at (1 credit each), 1 to 20." value={pp.pages_per_search} min={1} max={20} onChange={(n) => set("people_pipeline", "pages_per_search", n)} />
                  <NumberField label="Tries per track" hint="People one track may buy when the one before had no email, 1 to 10. Keep 1 until a Buy shows a miss is free." value={pp.tries_per_track} min={1} max={10} onChange={(n) => set("people_pipeline", "tries_per_track", n)} />
                  <NumberField label="Most people a run" hint="People one run may buy, 1 to 10,000." value={pp.max_people_per_run} min={1} max={10000} onChange={(n) => set("people_pipeline", "max_people_per_run", n)} />
                  <NumberField label="Days before a look again" hint="A company settled this recently is left out of the next run, 1 to 365." value={pp.recheck_days} min={1} max={365} onChange={(n) => set("people_pipeline", "recheck_days", n)} />
                  <NumberField label="Lowest AI Ark balance" hint="A run stops before going under it (credits)." value={pp.min_balance} min={0} max={1000000} onChange={(n) => set("people_pipeline", "min_balance", n)} />
                </div>
              </Section>

              <Section>
                <Switch
                  label="Personalisation"
                  hint="The original question steps for each contact (phase 3), for the clients listed below."
                  checked={ps.enabled}
                  onChange={(v) => set("personalisation", "enabled", v)}
                />
                <Clients label="Personalisation" tags={ps.tags} onChange={(t) => set("personalisation", "tags", t)} />
                <Switch
                  label="Shared personalisation text"
                  hint="Off: a client runs these steps only with its own Clay originals loaded, since the prompts hold one client's own service text. On: every listed client uses the shared text (needs the agency's OK)."
                  checked={ps.shared_text_ok}
                  onChange={(v) => set("personalisation", "shared_text_ok", v)}
                />
              </Section>

              <Section>
                <p className="text-[13.5px] font-medium">Spend caps a day (UTC)</p>
                <div className="flex flex-wrap gap-3">
                  <NumberField label="Reoon checks" hint="The pipeline's share of the shared Reoon account, 0 to 100,000. Past it, checks wait for the next day." value={form.spend_caps.reoon_checks_per_day} min={0} max={100000} onChange={(n) => setCaps("reoon_checks_per_day", n)} />
                  <NumberField label="OpenAI dollars, pipeline" hint="The company, inbox and people AI steps, 0 to 10,000." value={form.spend_caps.openai_usd_per_day.pipeline} min={0} max={10000} step={0.5} onChange={(n) => setCaps("pipeline", n)} />
                  <NumberField label="OpenAI dollars, fit scoring" hint="The scorer and its runs, 0 to 10,000." value={form.spend_caps.openai_usd_per_day.fit} min={0} max={10000} step={0.5} onChange={(n) => setCaps("fit", n)} />
                </div>
              </Section>

              {MODEL_STEPS.map((step) => {
                const m = form.models[step.key];
                return (
                  <Section key={step.key}>
                    <div>
                      <p className="text-[13.5px] font-medium">{step.label}</p>
                      <p className="text-[12px] text-muted-foreground">
                        {step.table} table. {step.hint}
                      </p>
                    </div>
                    <Field label="Model" hint="As OpenAI names it, for example gpt-6-luna.">
                      <Input
                        value={m.model}
                        onChange={(e) => setStep(step.key, "model", e.target.value.trim().toLowerCase())}
                        className="h-9 rounded-full font-mono text-[13px]"
                        spellCheck={false}
                        aria-label={`${step.label} model`}
                      />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      <Field label="Reasoning effort" hint="Sent only when set. A Luna model refuses minimal.">
                        <Select
                          value={m.reasoning_effort ?? NOT_SENT}
                          onValueChange={(v) => setStep(step.key, "reasoning_effort", v === NOT_SENT ? null : (v as Effort))}
                        >
                          <SelectTrigger size="sm" className="h-9 w-full rounded-full text-[13px]" aria-label={`${step.label} reasoning effort`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={NOT_SENT}>Not sent</SelectItem>
                            {EFFORTS.map((e) => (
                              <SelectItem key={e} value={e}>
                                {e}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </Field>
                      {step.tool === "web" ? (
                        <NumberField
                          label="Most searches"
                          hint="Web tool calls one answer may make, 1 to 5. Never below the steps the prompt names."
                          value={m.max_searches ?? Number.NaN}
                          min={1}
                          max={5}
                          onChange={(n) => setStep(step.key, "max_searches", n)}
                        />
                      ) : (
                        <Field label="Most searches" hint="This step has no web search.">
                          <p className="h-9 px-3 py-2 text-[13px] text-muted-foreground">None</p>
                        </Field>
                      )}
                    </div>
                  </Section>
                );
              })}

              <p className="text-[12px] leading-relaxed text-muted-foreground">
                A new model applies to rows worked from then on. Answers already found are kept and not paid for again.
                {memory
                  ? ` Paid answers are reused across clients for ${memory.website} days (websites), ${memory.email} days (emails) and ${memory.nothing_found} days (nothing found).`
                  : ""}
              </p>

              {errors.length > 0 && (
                <ul className="space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border/60">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving || !form}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
