"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import {
  EFFORTS,
  MODEL_STEPS,
  type Effort,
  type ModelStep,
  type PipelineSettings,
  type SettingsInput,
  type SettingsState,
} from "@/lib/companies/types";

// The company pipeline's settings (enrich_settings), admins only: the switch,
// the largest pull, the paid email checks per company, and for each AI step
// the model, its reasoning effort and its most searches. Saved through
// PUT /api/companies/settings; the worker reads them every 30 s, so a model
// is swapped with no deploy.

const NOT_SENT = "__not_sent"; // a Select item can't have an empty value

function toInput(v: PipelineSettings): SettingsInput {
  const models = {} as SettingsInput["models"];
  for (const { key } of MODEL_STEPS) {
    const m = (v.models[key] ?? {}) as { model?: unknown; reasoning_effort?: unknown; max_searches?: unknown };
    models[key] = {
      model: typeof m.model === "string" ? m.model : "",
      reasoning_effort: (EFFORTS as readonly unknown[]).includes(m.reasoning_effort) ? (m.reasoning_effort as Effort) : null,
      max_searches: typeof m.max_searches === "number" ? m.max_searches : Number.NaN,
    };
  }
  const cp = v.company_pipeline;
  return {
    company_pipeline: { enabled: cp.enabled, max_pull_size: cp.max_pull_size, email_checks_per_company: cp.email_checks_per_company },
    models,
  };
}

const numberIn = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="mb-1 text-[12.5px] font-medium">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

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
  const setCp = <K extends keyof SettingsInput["company_pipeline"]>(k: K, v: SettingsInput["company_pipeline"][K]) =>
    setForm((f) => (f ? { ...f, company_pipeline: { ...f.company_pipeline, [k]: v } } : f));
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader className="pb-0">
          <SheetTitle>Company pipeline settings</SheetTitle>
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
          {!form ? (
            !loadError && (
              <div className="flex min-h-[200px] items-center justify-center text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            )
          ) : (
            <>
              <section className="space-y-3 rounded-2xl bg-muted/50 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[13.5px] font-medium">Company pulls</p>
                    <p className="text-[12px] leading-relaxed text-muted-foreground">
                      {form.company_pipeline.enabled
                        ? "On: managers can count and pull companies for any client."
                        : "Off: nothing can be counted or pulled. A pull already going carries on until it is cancelled."}
                    </p>
                  </div>
                  <IosToggle
                    checked={form.company_pipeline.enabled}
                    onCheckedChange={(v) => setCp("enabled", v)}
                    aria-label="Company pulls on"
                  />
                </div>
                <div className="flex flex-wrap gap-3">
                  <Field label="Largest pull" hint="Companies one pull may buy, 1 to 10,000. Raise it once a test has measured real costs.">
                    <Input
                      type="number"
                      min={1}
                      max={10000}
                      value={Number.isFinite(form.company_pipeline.max_pull_size) ? form.company_pipeline.max_pull_size : ""}
                      onChange={(e) => setCp("max_pull_size", numberIn(e.target.value))}
                      className="h-9 rounded-full text-[13px] tabular-nums"
                    />
                  </Field>
                  <Field label="Email checks per company" hint="Paid Reoon checks one company may use, 1 to 5.">
                    <Input
                      type="number"
                      min={1}
                      max={5}
                      value={Number.isFinite(form.company_pipeline.email_checks_per_company) ? form.company_pipeline.email_checks_per_company : ""}
                      onChange={(e) => setCp("email_checks_per_company", numberIn(e.target.value))}
                      className="h-9 rounded-full text-[13px] tabular-nums"
                    />
                  </Field>
                </div>
              </section>

              {MODEL_STEPS.map(({ key, label, hint }) => {
                const m = form.models[key];
                return (
                  <section key={key} className="space-y-3 rounded-2xl bg-muted/50 p-3">
                    <div>
                      <p className="text-[13.5px] font-medium">{label}</p>
                      <p className="text-[12px] text-muted-foreground">{hint}</p>
                    </div>
                    <Field label="Model" hint="As OpenAI names it, for example gpt-4o-mini.">
                      <Input
                        value={m.model}
                        onChange={(e) => setStep(key, "model", e.target.value.trim().toLowerCase())}
                        className="h-9 rounded-full font-mono text-[13px]"
                        spellCheck={false}
                        aria-label={`${label} model`}
                      />
                    </Field>
                    <div className="flex flex-wrap gap-3">
                      <Field label="Reasoning effort" hint="Sent only when set. Not every model takes every effort.">
                        <Select
                          value={m.reasoning_effort ?? NOT_SENT}
                          onValueChange={(v) => setStep(key, "reasoning_effort", v === NOT_SENT ? null : (v as Effort))}
                        >
                          <SelectTrigger size="sm" className="h-9 w-full rounded-full text-[13px]" aria-label={`${label} reasoning effort`}>
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
                      <Field label="Most searches" hint="Web searches one company may use, 1 to 5.">
                        <Input
                          type="number"
                          min={1}
                          max={5}
                          value={Number.isFinite(m.max_searches) ? m.max_searches : ""}
                          onChange={(e) => setStep(key, "max_searches", numberIn(e.target.value))}
                          className="h-9 rounded-full text-[13px] tabular-nums"
                          aria-label={`${label} most searches`}
                        />
                      </Field>
                    </div>
                  </section>
                );
              })}

              <p className="text-[12px] leading-relaxed text-muted-foreground">
                A new model applies to companies worked from then on. Answers already found are kept and not paid for again.
                {memory
                  ? ` Paid answers are reused across clients for ${[
                      memory.website != null ? `${memory.website} days (websites)` : "",
                      memory.email != null ? `${memory.email} days (emails)` : "",
                      memory.nothing_found != null ? `${memory.nothing_found} days (nothing found)` : "",
                    ]
                      .filter(Boolean)
                      .join(", ")}.`
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
