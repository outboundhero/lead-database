"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Plus, Save } from "lucide-react";
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
  VENDOR_CAPS,
  type DatabaseBackfillSettings,
  type Effort,
  type ModelStep,
  type OverlapSharingSettings,
  type PipelineSettings,
  type PromotionInput,
  type QuestionVariablesInput,
  type SettingsInput,
  type SettingsState,
  type VendorCapKey,
  type WeeklyTopupSettings,
} from "@/lib/companies/types";
import type { SharingClient } from "@/lib/sharing/types";

// The pipeline's settings (enrich_settings), admins only: company pulls, people
// runs, the LinkedIn searches, personalisation and promotion into leads (with
// the push of the leads it adds into the clients' campaigns, migration 140),
// each switch with its client list (an empty list covers no client), their caps,
// the daily spend caps (OpenAI, Reoon, and the calls of each email finder and
// Enrichley), and for each original Clay AI step its model, reasoning effort
// and most searches. Saved through PUT /api/companies/settings; the worker
// reads them every 30 s, so a model is swapped with no deploy. Promotion needs
// no fit score: fit scoring and the gate (kept for v2, off) have their own
// panel, which also shows promotion's counts and Promote now; each client's
// LinkedIn places and keywords are edited on the AI Ark tab.
//
// Also overlap sharing, the weekly top-up and never-contact inboxes
// (migrations 134 to 136), each shipped off: the switch and its client list,
// the sharing pools and the push list, the top-up's types and budget, and the
// never-contact pace. The Clay General inboxes filter is shown as loaded or
// not, never as text. Their work is on the Sharing page (/leads/sharing).
// And the database backfill (migration 138, shipped off): the switch, its
// clients, preview or apply, the shares a firing may write, its minutes, the
// days before a place is read again, and untagged leads; its Backfill tab is
// on the Sharing page.
// And question variables (migration 139, shipped off): the switch and its
// clients, the question writer's OpenAI dollars a day, a new variable's max
// words, the research's most searches, and the research and question models
// (empty: the pipeline's). Each client's variables are edited on the Clay
// tab (Client setup, Question variable); jobs start from the export popup.

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
    spend_caps: {
      reoon_checks_per_day: v.spend_caps.reoon_checks_per_day,
      openai_usd_per_day: { ...v.spend_caps.openai_usd_per_day },
      vendor_calls_per_day: { ...v.spend_caps.vendor_calls_per_day },
    },
    models,
    linkedin_sources: { ...v.linkedin_sources, tags: [...v.linkedin_sources.tags] },
    promotion: { promote_to_leads: v.promotion.promote_to_leads, tags: [...v.promotion.tags], auto_push: v.promotion.auto_push },
    overlap_sharing: {
      ...v.overlap_sharing,
      tags: [...v.overlap_sharing.tags],
      pools: Object.fromEntries(Object.entries(v.overlap_sharing.pools).map(([k, t]) => [k, [...t]])),
      isolated_tag_suffixes: [...v.overlap_sharing.isolated_tag_suffixes],
      push_tags: [...v.overlap_sharing.push_tags],
    },
    weekly_topup: { ...v.weekly_topup, client_types: [...v.weekly_topup.client_types], pull_tags: [...v.weekly_topup.pull_tags] },
    never_contact_inboxes: {
      enabled: v.never_contact_inboxes.enabled,
      rows_per_day: v.never_contact_inboxes.rows_per_day,
      chunk_rows: v.never_contact_inboxes.chunk_rows,
    },
    ...(v.database_backfill ? { database_backfill: { ...v.database_backfill, tags: [...v.database_backfill.tags] } } : {}),
    ...(v.question_variables
      ? {
          question_variables: {
            enabled: v.question_variables.enabled,
            tags: [...v.question_variables.tags],
            max_words: v.question_variables.max_words,
            research_model: v.question_variables.research_model,
            question_model: v.question_variables.question_model,
            max_searches: v.question_variables.max_searches,
            usd_per_day: v.question_variables.usd_per_day,
          },
        }
      : {}),
  };
}

const numberIn = (raw: string) => (raw.trim() === "" ? Number.NaN : Number(raw));
const tagsIn = (values: string[]) => [...new Set(values.map((v) => v.trim().toUpperCase()).filter(Boolean))];
/** Client types as typed: trimmed, once each in any case. */
const typesIn = (values: string[]) => {
  const out: string[] = [];
  for (const v of values.map((x) => x.trim()).filter(Boolean)) if (!out.some((y) => y.toLowerCase() === v.toLowerCase())) out.push(v);
  return out;
};

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

function Switch({ label, hint, checked, onChange, disabled }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <p className="text-[13.5px] font-medium">{label}</p>
        <p className="text-[12px] leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <IosToggle checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
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

/** Active for sharing: the receive rule's statuses (Active or Healthy, trimmed, any case). */
const isActive = (status: string | null) => ["active", "healthy"].includes((status ?? "").trim().toLowerCase());

/** "Add every active client of one type": reads the clients once (GET /api/sharing/clients) and adds a type's active ones. */
function AddActiveOfType({ onAdd }: { onAdd: (tags: string[]) => void }) {
  const [clients, setClients] = useState<SharingClient[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [type, setType] = useState("");
  useEffect(() => {
    let gone = false;
    fetch("/api/sharing/clients")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load the clients");
        if (!gone) setClients(Array.isArray(j.clients) ? j.clients : []);
      })
      .catch((e) => !gone && setFailed(e instanceof Error ? e.message : "Could not load the clients"));
    return () => {
      gone = true;
    };
  }, []);
  const types = [...new Set((clients ?? []).map((c) => (c.client_type ?? "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const matches = (clients ?? []).filter((c) => isActive(c.status) && (c.client_type ?? "").trim().toLowerCase() === type.toLowerCase());
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field
        label="Add every active client of one type"
        hint={failed ?? "Adds the clients of that type whose status is Active or Healthy to the list above. New clients never join by themselves."}
      >
        <Select value={type} onValueChange={setType} disabled={!clients}>
          <SelectTrigger size="sm" className="h-9 w-full rounded-full text-[13px]" aria-label="Client type to add">
            <SelectValue placeholder={clients ? "Pick a client type" : "Loading the clients"} />
          </SelectTrigger>
          <SelectContent>
            {types.map((t) => (
              <SelectItem key={t} value={t}>
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Button size="sm" variant="outline" className="mb-[22px]" disabled={!type || matches.length === 0} onClick={() => onAdd(matches.map((c) => c.tag))}>
        <Plus /> Add {matches.length || ""}
      </Button>
    </div>
  );
}

/** The sharing pools: a name (lower-case letters, digits and _) and its client types, one row each. */
function PoolsEditor({ pools, onChange }: { pools: Record<string, string[]>; onChange: (p: Record<string, string[]>) => void }) {
  const entries = Object.entries(pools);
  const rename = (from: string, to: string) => {
    const name = to.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
    if (!name || (name !== from && name in pools)) return;
    onChange(Object.fromEntries(entries.map(([k, v]) => (k === from ? [name, v] : [k, v]))));
  };
  return (
    <Field
      label="Sharing pools"
      hint="Clients share only inside their pool. A client whose type is in no pool is isolated: it never receives a share and its imports are never shared. A type may be in one pool only."
    >
      <div className="space-y-2">
        {entries.map(([name, types]) => (
          <div key={name} className="space-y-1 rounded-xl bg-background/60 p-2">
            <div className="flex items-center gap-2">
              <Input
                defaultValue={name}
                onBlur={(e) => rename(name, e.target.value)}
                className="h-8 w-40 rounded-full font-mono text-[12.5px]"
                aria-label={`Pool ${name}: name`}
              />
              <Button
                size="xs"
                variant="ghost"
                onClick={() => onChange(Object.fromEntries(entries.filter(([k]) => k !== name)))}
                aria-label={`Remove pool ${name}`}
              >
                Remove
              </Button>
            </div>
            <TagInput values={types} onChange={(v) => onChange({ ...pools, [name]: typesIn(v) })} placeholder="Add a client type" maxTags={20} />
          </div>
        ))}
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            let n = entries.length + 1;
            while (`pool_${n}` in pools) n++;
            onChange({ ...pools, [`pool_${n}`]: [] });
          }}
        >
          <Plus /> Add a pool
        </Button>
      </div>
    </Field>
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
  const setVendorCap = (k: VendorCapKey, v: number) =>
    setForm((f) =>
      f?.spend_caps.vendor_calls_per_day ? { ...f, spend_caps: { ...f.spend_caps, vendor_calls_per_day: { ...f.spend_caps.vendor_calls_per_day, [k]: v } } } : f
    );
  const setStep = <K extends keyof SettingsInput["models"][ModelStep]>(step: ModelStep, k: K, v: SettingsInput["models"][ModelStep][K]) =>
    setForm((f) => (f ? { ...f, models: { ...f.models, [step]: { ...f.models[step], [k]: v } } } : f));
  type LinkedinInput = NonNullable<SettingsInput["linkedin_sources"]>;
  const setLinkedin = <K extends keyof LinkedinInput>(k: K, v: LinkedinInput[K]) =>
    setForm((f) => (f?.linkedin_sources ? { ...f, linkedin_sources: { ...f.linkedin_sources, [k]: v } } : f));
  const setPromotion = <K extends keyof PromotionInput>(k: K, v: PromotionInput[K]) =>
    setForm((f) => (f?.promotion ? { ...f, promotion: { ...f.promotion, [k]: v } } : f));
  const setSharing = <K extends keyof OverlapSharingSettings>(k: K, v: OverlapSharingSettings[K]) =>
    setForm((f) => (f?.overlap_sharing ? { ...f, overlap_sharing: { ...f.overlap_sharing, [k]: v } } : f));
  const setTopup = <K extends keyof WeeklyTopupSettings>(k: K, v: WeeklyTopupSettings[K]) =>
    setForm((f) => (f?.weekly_topup ? { ...f, weekly_topup: { ...f.weekly_topup, [k]: v } } : f));
  type InboxesInput = NonNullable<SettingsInput["never_contact_inboxes"]>;
  const setInboxes = <K extends keyof InboxesInput>(k: K, v: InboxesInput[K]) =>
    setForm((f) => (f?.never_contact_inboxes ? { ...f, never_contact_inboxes: { ...f.never_contact_inboxes, [k]: v } } : f));
  const setBackfill = <K extends keyof DatabaseBackfillSettings>(k: K, v: DatabaseBackfillSettings[K]) =>
    setForm((f) => (f?.database_backfill ? { ...f, database_backfill: { ...f.database_backfill, [k]: v } } : f));
  const setQuestion = <K extends keyof QuestionVariablesInput>(k: K, v: QuestionVariablesInput[K]) =>
    setForm((f) => (f?.question_variables ? { ...f, question_variables: { ...f.question_variables, [k]: v } } : f));

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
  const ls = form?.linkedin_sources;
  const pr = form?.promotion;
  const prView = state?.value.promotion;
  const os = form?.overlap_sharing;
  const wt = form?.weekly_topup;
  const nc = form?.never_contact_inboxes;
  const ncFilter = state?.value.never_contact_inboxes?.filter;
  const db = form?.database_backfill;
  const qv = form?.question_variables;

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
                  hint={
                    cp.enabled
                      ? "On, for the clients listed below: managers can count and pull their companies, and the Google Maps places their inbound URL holds are worked."
                      : "Off: nothing can be counted or pulled, and Google Maps places from a client's inbound URL wait, held. A pull already going carries on until it is cancelled."
                  }
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
                  hint={
                    pp.enabled
                      ? "On, for the clients listed below: managers can look for the people at their companies and buy them. It also starts the no-email rows of those clients' uploads, held in their People tables, within the daily caps."
                      : "Off: no people run can start, and a run going stops before its next paid call. The no-email rows of uploads stay held in the People tables."
                  }
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

              {ls && (
                <Section>
                  <Switch
                    label="LinkedIn searches"
                    hint={
                      ls.enabled
                        ? "On, for the clients listed below: managers can pull their companies and look for their people through each client's LinkedIn search."
                        : "Off: no LinkedIn pull or people run can start. Each client's LinkedIn places and keywords can still be edited on the AI Ark tab."
                    }
                    checked={ls.enabled}
                    onChange={(v) => setLinkedin("enabled", v)}
                  />
                  <Clients label="LinkedIn searches" tags={ls.tags} onChange={(t) => setLinkedin("tags", t)} />
                  <div className="flex flex-wrap gap-3">
                    <NumberField
                      label="People a company"
                      hint="The most people one LinkedIn people run buys at one company, 1 to 100."
                      value={ls.people_per_company}
                      min={1}
                      max={100}
                      onChange={(n) => setLinkedin("people_per_company", n)}
                    />
                  </div>
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    A LinkedIn company search also needs company pulls on for the client; a LinkedIn people search needs people runs on.
                  </p>
                </Section>
              )}

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

              {pr && (
                <Section>
                  <Switch
                    label="Promotion into leads"
                    hint={
                      pr.promote_to_leads
                        ? "On, for the clients listed below: their approved general inboxes and people are added to the lead database (duplicates skipped, never merged), by the worker at most every 10 minutes, or at once with Promote now on the fit panel."
                        : "Off: nothing from the pipeline is added to the lead database. Contacts wait in the clients' Clay tables until it is on."
                    }
                    checked={pr.promote_to_leads}
                    onChange={(v) => setPromotion("promote_to_leads", v)}
                  />
                  <Switch
                    label="Push into campaigns"
                    hint={
                      pr.auto_push
                        ? "On, for the clients listed below: the leads promotion adds are pushed into each client's campaigns once the location backfill has placed them, forced, into the campaigns the export popup would pre-select. A client whose campaigns can't be picked keeps its new leads for a push from Leads, Export; the fit panel says why."
                        : "Off: promoted leads wait in Leads for a push from Leads, Export. Leads added while it is off are never pushed by it later."
                    }
                    checked={pr.auto_push}
                    onChange={(v) => setPromotion("auto_push", v)}
                  />
                  <Clients label="Promotion into leads" tags={pr.tags} onChange={(t) => setPromotion("tags", t)} />
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    No fit score is needed. Addresses approved by Reoon or Enrichley, or found by an email finder, are added, as in Clay; each lead&apos;s
                    validation status and source say which (source &quot;{prView?.source_label ?? "Companies (AI Ark)"}&quot;, with who found or approved the
                    address added).
                    {prView?.require_question ? " A question is required, so a contact without one waits too." : ""}
                  </p>
                </Section>
              )}

              {os && (
                <Section>
                  <Switch
                    label="Overlap sharing"
                    hint={
                      os.enabled
                        ? "On, for the clients listed below: each finished import's new leads are checked against the other listed clients of its pool, and every lead that fits one is shared to it. The Sharing page lists each import's shares."
                        : "Off: no import is checked and nothing is shared. Shares already applied stay as they are."
                    }
                    checked={os.enabled}
                    onChange={(v) => setSharing("enabled", v)}
                  />
                  <Clients label="Overlap sharing" tags={os.tags} onChange={(t) => setSharing("tags", t)} />
                  <AddActiveOfType onAdd={(tags) => setSharing("tags", tagsIn([...os.tags, ...tags]))} />
                  <Field
                    label="Mode"
                    hint="Preview: each import's shares wait on the Sharing page for an admin to apply them. Apply: they are applied on their own, unless a client is over a cap."
                  >
                    <Select value={os.mode} onValueChange={(v) => setSharing("mode", v === "apply" ? "apply" : "preview")}>
                      <SelectTrigger size="sm" className="h-9 w-full rounded-full text-[13px]" aria-label="Sharing mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="preview">Preview</SelectItem>
                        <SelectItem value="apply">Apply</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <PoolsEditor pools={os.pools} onChange={(p) => setSharing("pools", p)} />
                  <Field label="Isolated tag endings" hint="A client whose tag ends in one of these is isolated, whatever its type.">
                    <TagInput values={os.isolated_tag_suffixes} onChange={(v) => setSharing("isolated_tag_suffixes", tagsIn(v))} placeholder="Add an ending" maxTags={20} />
                  </Field>
                  <Field
                    label="Shares pushed automatically: clients"
                    hint="A listed client's applied shares go into its Active or Draft campaigns, picked as the export screen picks them, at most once every few minutes. Each must be on the sharing list. Adding a client here never pushes its older shares: Push shared on the Sharing page does."
                  >
                    <TagInput values={os.push_tags} onChange={(v) => setSharing("push_tags", tagsIn(v))} placeholder="Add a client tag" maxTags={2000} />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <NumberField label="Minutes between pushes" hint="A client's queued shares are pushed at most this often, 5 to 1,440." value={os.push_every_minutes} min={5} max={1440} onChange={(n) => setSharing("push_every_minutes", n)} />
                    <NumberField label="Most pushed from one import" hint="Above it, that client waits at preview for an admin, 1 to 25,000." value={os.push_max_per_job} min={1} max={25000} onChange={(n) => setSharing("push_max_per_job", n)} />
                    <NumberField label="Most pushed a day" hint="Shares pushed to one client a day (UTC), 1 to 100,000. Above it, it waits at preview." value={os.push_max_per_day} min={1} max={100000} onChange={(n) => setSharing("push_max_per_day", n)} />
                    <NumberField label="Days a held share is tried again" hint="Once a day, while it is younger than this, 0 to 30." value={os.held_retry_days} min={0} max={30} onChange={(n) => setSharing("held_retry_days", n)} />
                    <NumberField label="Minutes to wait for places" hint="An import waits for a location run after it, at most this long, 30 to 1,440." value={os.wait_location_minutes} min={30} max={1440} onChange={(n) => setSharing("wait_location_minutes", n)} />
                    <NumberField label="Days leads without a place are looked at again" hint="Once a day, 0 to 30." value={os.recheck_days} min={0} max={30} onChange={(n) => setSharing("recheck_days", n)} />
                  </div>
                  <Switch
                    label="Write the receiving client's tag on shared leads"
                    hint="Off: shares are recorded on the Sharing page only, and Bison still gets the tag from the push. On: the tag is written on each shared lead, paced. Every write rewrites a lead row, so keep it off unless the tag is needed."
                    checked={os.write_tags}
                    onChange={(v) => setSharing("write_tags", v)}
                  />
                  <div className="flex flex-wrap gap-3">
                    <NumberField label="Tags written a day" hint="Tags written and taken off by undo, a day (UTC), 0 to 200,000." value={os.tag_rows_per_day} min={0} max={200000} onChange={(n) => setSharing("tag_rows_per_day", n)} />
                    <Field label="Go-live time" hint="Imports before it are never shared. Empty: set to now when sharing is switched on.">
                      <Input
                        value={os.since ?? ""}
                        onChange={(e) => setSharing("since", e.target.value.trim() ? e.target.value : null)}
                        placeholder="Set when switched on"
                        className="h-9 rounded-full font-mono text-[12.5px]"
                        spellCheck={false}
                        aria-label="Sharing go-live time"
                      />
                    </Field>
                  </div>
                </Section>
              )}

              {wt && (
                <Section>
                  <Switch
                    label="Weekly top-up"
                    hint={
                      wt.enabled
                        ? "On: once a week every active client of the types below gets its places checked against its minimum, and the low ones are flagged on the Sharing page's Low places tab."
                        : "Off: no weekly pass runs and no place is flagged."
                    }
                    checked={wt.enabled}
                    onChange={(v) => setTopup("enabled", v)}
                  />
                  <Field label="Client types the pass covers" hint="Active clients of other types get one line saying they are not covered.">
                    <TagInput values={wt.client_types} onChange={(v) => setTopup("client_types", typesIn(v))} placeholder="Add a client type" maxTags={10} />
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <NumberField label="Default minimum" hint="Good leads a place should hold when the client has no minimum of its own, 1 to 100,000." value={wt.default_minimum} min={1} max={100000} onChange={(n) => setTopup("default_minimum", n)} />
                    <Field label="Top-up pulls" hint="Off: flags only. Prepare: a pull per client waits for a manager to start it. Auto: pulls start on their own, inside the budget.">
                      <Select value={wt.pull_mode} onValueChange={(v) => setTopup("pull_mode", v === "prepare" || v === "auto" ? v : "off")}>
                        <SelectTrigger size="sm" className="h-9 w-full rounded-full text-[13px]" aria-label="Top-up pulls">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off">Off</SelectItem>
                          <SelectItem value="prepare">Prepare</SelectItem>
                          <SelectItem value="auto">Auto</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <Clients label="Top-up pulls" tags={wt.pull_tags} onChange={(t) => setTopup("pull_tags", t)} />
                  <div className="flex flex-wrap gap-3">
                    <NumberField label="Credits a week" hint="AI Ark credits all top-up pulls may use over the last 7 days, 0 to 1,000,000. 0 allows no pull." value={wt.weekly_credits} min={0} max={1000000} onChange={(n) => setTopup("weekly_credits", n)} />
                    <NumberField label="Credits a week per client" hint="The same for one client, 0 to 1,000,000." value={wt.client_weekly_credits} min={0} max={1000000} onChange={(n) => setTopup("client_weekly_credits", n)} />
                    <NumberField label="Largest pull" hint="People one top-up pull may buy, 1 to 10,000." value={wt.max_pull_size} min={1} max={10000} onChange={(n) => setTopup("max_pull_size", n)} />
                    <NumberField label="New pulls a day" hint="Top-up pulls started a day (UTC), 0 to 4." value={wt.pulls_per_day} min={0} max={4} onChange={(n) => setTopup("pulls_per_day", n)} />
                  </div>
                </Section>
              )}

              {nc && (
                <Section>
                  <Switch
                    label="Never-contact inboxes"
                    hint={
                      !ncFilter?.loaded
                        ? "The Clay General inboxes filter is not loaded, so this cannot be switched on. Load it with the never-contact seed first."
                        : nc.enabled
                          ? "On: once an admin applies an approved dry run (Sharing page, General inboxes), the general inboxes the Clay filter matches are marked never contact, paced, and new imports' ones after them."
                          : "Off: nothing is marked never contact. The dry run on the Sharing page still counts what would be."
                    }
                    checked={nc.enabled}
                    onChange={(v) => setInboxes("enabled", v)}
                    disabled={!ncFilter?.loaded && !nc.enabled}
                  />
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    {ncFilter?.loaded
                      ? `Clay General inboxes filter loaded${ncFilter.source ? ` from ${ncFilter.source}` : ""}${ncFilter.read_at ? `, read ${new Date(ncFilter.read_at).toLocaleString()}` : ""}${ncFilter.sha12 ? `, sha256 starting ${ncFilter.sha12}` : ""}.`
                      : "Clay General inboxes filter: not loaded."}
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <NumberField label="Marked a day" hint="General inboxes marked never contact a day (UTC), 0 to 100,000." value={nc.rows_per_day} min={0} max={100000} onChange={(n) => setInboxes("rows_per_day", n)} />
                    <NumberField label="Marked in one step" hint="Leads looked at in one step, 1 to 2,000." value={nc.chunk_rows} min={1} max={2000} onChange={(n) => setInboxes("chunk_rows", n)} />
                  </div>
                </Section>
              )}

              {db && (
                <Section>
                  <Switch
                    label="Database backfill"
                    hint={
                      db.enabled
                        ? "On, for the clients listed below: every hour the backfill-worker finds leads already in the database that fit a client (its places and rules, never sent, shared or tagged for it), places under its minimum first, and queues them for its Active or Draft campaigns as shares. The Sharing page's Backfill tab shows each firing."
                        : "Off: no lead already in the database is looked at or shared. Shares a backfill queued before stay as they are."
                    }
                    checked={db.enabled}
                    onChange={(v) => setBackfill("enabled", v)}
                  />
                  <Clients label="Database backfill" tags={db.tags} onChange={(t) => setBackfill("tags", t)} />
                  <AddActiveOfType onAdd={(tags) => setBackfill("tags", tagsIn([...db.tags, ...tags]))} />
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    A listed client also needs overlap sharing&apos;s push list (above) for its shares to be written and pushed; in preview mode it is
                    counted either way. Its caps a firing and a day are overlap sharing&apos;s push caps.
                  </p>
                  <Field
                    label="Mode"
                    hint="Preview: each firing only counts what it would share (the Backfill tab shows it). Apply: the shares are written and queued for push."
                  >
                    <Select value={db.mode} onValueChange={(v) => setBackfill("mode", v === "apply" ? "apply" : "preview")}>
                      <SelectTrigger size="sm" className="h-9 w-full rounded-full text-[13px]" aria-label="Database backfill mode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="preview">Preview</SelectItem>
                        <SelectItem value="apply">Apply</SelectItem>
                      </SelectContent>
                    </Select>
                  </Field>
                  <div className="flex flex-wrap gap-3">
                    <NumberField label="Most shares a firing" hint="Shares one hourly firing may write for every client together, 1 to 50,000." value={db.max_per_run} min={1} max={50000} onChange={(n) => setBackfill("max_per_run", n)} />
                    <NumberField label="Minutes a firing works" hint="A firing stops reading after this, 5 to 50." value={db.max_minutes} min={5} max={50} onChange={(n) => setBackfill("max_minutes", n)} />
                    <NumberField label="Days before a place is read again" hint="After a place's leads were all read once, 1 to 90. A change of the client's rules reads it again at once." value={db.recheck_days} min={1} max={90} onChange={(n) => setBackfill("recheck_days", n)} />
                  </div>
                  <Switch
                    label="Untagged leads too"
                    hint="On: leads that carry no client's tag are taken, besides leads of other clients of the same pool. Off: only leads of other clients of the pool."
                    checked={db.untagged}
                    onChange={(v) => setBackfill("untagged", v)}
                  />
                </Section>
              )}

              {qv && (
                <Section>
                  <Switch
                    label="Question variables"
                    hint={
                      qv.enabled
                        ? "On, for the clients listed below: the export popup can write a client's own question variable (made on the Clay tab, Client setup) for the leads it pushes, a research call per company and a question per lead."
                        : "Off: no question job starts, and jobs already open wait, paused. Variables can still be made and edited."
                    }
                    checked={qv.enabled}
                    onChange={(v) => setQuestion("enabled", v)}
                  />
                  <Clients label="Question variables" tags={qv.tags} onChange={(t) => setQuestion("tags", t)} />
                  <div className="flex flex-wrap gap-3">
                    <NumberField
                      label="OpenAI dollars a day"
                      hint="The question writer's own budget (UTC day), apart from the pipeline's, 0 to 500. Past it, jobs wait, paused, for the next day."
                      value={qv.usd_per_day}
                      min={0}
                      max={500}
                      step={0.5}
                      onChange={(n) => setQuestion("usd_per_day", n)}
                    />
                    <NumberField label="Max words" hint="A new variable's starting max words, 4 to 40. Each variable keeps its own." value={qv.max_words} min={4} max={40} onChange={(n) => setQuestion("max_words", n)} />
                    <NumberField label="Most searches" hint="Web searches one company's research may make, 0 to 5. 0 sends no search." value={qv.max_searches} min={0} max={5} onChange={(n) => setQuestion("max_searches", n)} />
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Field label="Research model" hint="Empty: the pipeline's People research model (below).">
                      <Input
                        value={qv.research_model ?? ""}
                        onChange={(e) => setQuestion("research_model", e.target.value.trim() || null)}
                        placeholder="The pipeline's"
                        className="h-9 rounded-full font-mono text-[13px]"
                        spellCheck={false}
                        aria-label="Question variables research model"
                      />
                    </Field>
                    <Field label="Question model" hint="Empty: the pipeline's People question model (below).">
                      <Input
                        value={qv.question_model ?? ""}
                        onChange={(e) => setQuestion("question_model", e.target.value.trim() || null)}
                        placeholder="The pipeline's"
                        className="h-9 rounded-full font-mono text-[13px]"
                        spellCheck={false}
                        aria-label="Question variables question model"
                      />
                    </Field>
                  </div>
                </Section>
              )}

              <Section>
                <p className="text-[13.5px] font-medium">Spend caps a day (UTC)</p>
                <div className="flex flex-wrap gap-3">
                  <NumberField label="Reoon checks" hint="The pipeline's share of the shared Reoon account, 0 to 100,000. Past it, checks wait for the next day." value={form.spend_caps.reoon_checks_per_day} min={0} max={100000} onChange={(n) => setCaps("reoon_checks_per_day", n)} />
                  <NumberField label="OpenAI dollars, pipeline" hint="The company, inbox and people AI steps, 0 to 10,000." value={form.spend_caps.openai_usd_per_day.pipeline} min={0} max={10000} step={0.5} onChange={(n) => setCaps("pipeline", n)} />
                  <NumberField label="OpenAI dollars, fit scoring" hint="The scorer and its runs, 0 to 10,000." value={form.spend_caps.openai_usd_per_day.fit} min={0} max={10000} step={0.5} onChange={(n) => setCaps("fit", n)} />
                </div>
                {form.spend_caps.vendor_calls_per_day && (
                  <>
                    <p className="text-[12.5px] font-medium">Email finders and Enrichley: paid calls a day</p>
                    <div className="flex flex-wrap gap-3">
                      {VENDOR_CAPS.map((v) => (
                        <NumberField
                          key={v.key}
                          label={v.label}
                          hint={`${v.hint} 0 to 100,000.`}
                          value={form.spend_caps.vendor_calls_per_day![v.key]}
                          min={0}
                          max={100000}
                          onChange={(n) => setVendorCap(v.key, n)}
                        />
                      ))}
                    </div>
                    <p className="text-[12px] leading-relaxed text-muted-foreground">
                      0 means not set: that vendor gets no call, and its steps wait until a number is set, as when today&apos;s Reoon share is used up. Past a cap, its steps wait for the next day.
                    </p>
                  </>
                )}
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
