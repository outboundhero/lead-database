"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, Info, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TagInput } from "@/components/ui/ios/tag-input";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import type {
  LinkedinCounts,
  LinkedinKind,
  LinkedinLogEntry,
  LinkedinOwnInput,
  LinkedinPreview,
  LinkedinSettingsCardProps,
  LinkedinSettingsResponse,
  LinkedinSettingsView,
  NarrowedPlace,
  PlaceView,
  UnplacedValue,
} from "@/lib/linkedin/types";

// The AI Ark tab's LinkedIn card (migration 128): each client's own places and
// excluded keywords for its LinkedIn people search and its LinkedIn company
// search, edited by a manager. Everything else a LinkedIn search sends is the
// same for every client (the standard filters), shown read only. Loads and
// saves through /api/aiark/linkedin-settings; every save is logged with the
// lists before and after. Editing works with the LinkedIn searches switched
// off: nothing here spends.
//
// What a search would send is shown as it is edited (a preview, 400 ms after
// the last change): the keywords AI Ark's request can't hold, which are
// checked after the pull instead, and the client's places outside its
// sending rules, which are not searched.

const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");
const day = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
const LONG_LIST = "max-h-44 overflow-y-auto"; // a client's lists run to hundreds of chips
// The shared TagInput draws its chips at 11px; here they are 12px at least.
const CHIPS_12 = "[&_[data-slot=badge]]:text-[12px]";
const KINDS: { value: LinkedinKind; label: string }[] = [
  { value: "people", label: "People search" },
  { value: "companies", label: "Company search" },
];

/** What a manager edits for one kind: places as text (as AI Ark is sent them), the unplaced values kept, keywords. */
interface Draft {
  places: string[];
  out: string[];
  keywords: string[];
  unplaced: string[];
}

const unplacedKey = (u: UnplacedValue) => `${u.side}|${u.field}|${u.value}`;
const draftOf = (v: LinkedinSettingsView): Draft => ({
  places: v.own.include_locations.map((p) => p.text),
  out: v.own.exclude_locations.map((p) => p.text),
  keywords: [...v.own.exclude_keywords],
  unplaced: v.own.unplaced.map(unplacedKey),
});
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

/** What a save sends: places left as loaded go back as their entries, new ones as typed. */
function valueOf(v: LinkedinSettingsView, d: Draft): LinkedinOwnInput {
  const inc = new Map(v.own.include_locations.map((p) => [p.text, p.entry]));
  const exc = new Map(v.own.exclude_locations.map((p) => [p.text, p.entry]));
  return {
    include_locations: d.places.map((t) => inc.get(t) ?? t),
    exclude_locations: d.out.map((t) => exc.get(t) ?? t),
    unplaced: v.own.unplaced.filter((u) => d.unplaced.includes(unplacedKey(u))).map((u) => ({ side: u.side, field: u.field, value: u.value, why: u.why, suggestions: u.suggestions })),
    exclude_keywords: d.keywords,
  };
}

/** A save's or a preview's reasons, under the field each names. */
function errorsByField(errors: string[]) {
  const out = { places: [] as string[], out: [] as string[], keywords: [] as string[], unplaced: [] as string[], other: [] as string[] };
  for (const e of errors) {
    if (e.startsWith("Places left out")) out.out.push(e);
    else if (e.startsWith("Places")) out.places.push(e);
    else if (e.startsWith("Excluded keywords")) out.keywords.push(e);
    else if (e.startsWith("Unplaced")) out.unplaced.push(e);
    else out.other.push(e);
  }
  return out;
}

// Edits not saved yet, per client and kind, kept while the page is open: a
// client switch unmounts this card, and its edits come back, unsaved, with
// that client (as the people filters' drafts do). A draft is kept only while
// the settings it was made on are still current.
const drafts = new Map<string, { version: string; draft: Draft }>();
const draftKey = (tag: string, kind: LinkedinKind) => `${tag}|${kind}`;

export function LinkedinSettingsCard({ tag, onSaved }: LinkedinSettingsCardProps) {
  const [data, setData] = useState<LinkedinSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<LinkedinKind>("people");
  const [forms, setForms] = useState<Partial<Record<LinkedinKind, Draft>>>({});
  const [previews, setPreviews] = useState<Partial<Record<LinkedinKind, LinkedinPreview & { key: string }>>>({});
  const [previewing, setPreviewing] = useState(false);
  const [saveErrors, setSaveErrors] = useState<Partial<Record<LinkedinKind, string[]>>>({});
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoadError(null);
    try {
      const res = await fetch(`/api/aiark/linkedin-settings?tag=${encodeURIComponent(tag)}`);
      const j = await res.json();
      if (mine !== seq.current) return;
      if (!res.ok) throw new Error(j.error ?? "Could not load the LinkedIn settings");
      const r = j as LinkedinSettingsResponse;
      const next: Partial<Record<LinkedinKind, Draft>> = {};
      for (const k of ["people", "companies"] as LinkedinKind[]) {
        const v = r[k];
        if (!v) continue;
        const held = drafts.get(draftKey(tag, k));
        if (held && held.version === v.version) next[k] = held.draft;
        else {
          drafts.delete(draftKey(tag, k));
          next[k] = draftOf(v);
        }
      }
      setData(r);
      setForms(next);
      setPreviews({});
      setSaveErrors({});
    } catch (e) {
      if (mine !== seq.current) return;
      setLoadError(e instanceof Error ? e.message : "Could not load the LinkedIn settings");
    }
  }, [tag]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const view = data?.[kind] ?? null;
  const form = forms[kind] ?? null;
  const dirtyOf = (k: LinkedinKind) => {
    const v = data?.[k];
    const f = forms[k];
    return Boolean(v && f && !sameDraft(f, draftOf(v)));
  };
  const dirty = dirtyOf(kind);
  const anyDirty = dirtyOf("people") || dirtyOf("companies");

  // Keep the edits per client and kind, so a client switch doesn't lose them.
  useEffect(() => {
    if (!data) return;
    for (const k of ["people", "companies"] as LinkedinKind[]) {
      const v = data[k];
      const f = forms[k];
      if (!v || !f) continue;
      if (sameDraft(f, draftOf(v))) drafts.delete(draftKey(tag, k));
      else drafts.set(draftKey(tag, k), { version: v.version, draft: f });
    }
  }, [data, forms, tag]);

  // The browser asks before the tab is closed or reloaded with edits not saved.
  useEffect(() => {
    if (!anyDirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [anyDirty]);

  // What a search would send for the lists on screen (no AI Ark call), 400 ms after the last edit.
  const previewKey = view && form && dirty ? JSON.stringify(valueOf(view, form)) : null;
  useEffect(() => {
    if (!view || !form || !previewKey) {
      setPreviewing(false);
      return;
    }
    if (previews[kind]?.key === previewKey) {
      setPreviewing(false); // back to lists already previewed while another preview was on its way
      return;
    }
    setPreviewing(true);
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/aiark/linkedin-settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tag, kind, value: JSON.parse(previewKey) }),
          signal: ctl.signal,
        });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Could not work out the LinkedIn search");
        setPreviews((p) => ({ ...p, [kind]: { ...(j as LinkedinPreview), key: previewKey } }));
      } catch (e) {
        if ((e as Error).name !== "AbortError") toast.error((e as Error).message);
      } finally {
        if (!ctl.signal.aborted) setPreviewing(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // previews is read only to skip a preview already made
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, kind, tag]);

  const setForm = (patch: Partial<Draft>) => {
    setForms((f) => (f[kind] ? { ...f, [kind]: { ...f[kind]!, ...patch } } : f));
    setSaveErrors((e) => (e[kind]?.length ? { ...e, [kind]: [] } : e)); // a refused save's reasons go once the lists change
  };

  const shown = dirty && previews[kind]?.key === previewKey ? previews[kind]! : null;
  const errors = errorsByField([...(shown?.errors ?? []), ...(saveErrors[kind] ?? [])]);
  const blockingErrors = shown?.errors.length ?? 0;
  // A client with no row of its own: its first save makes one from what is shown, changed or not.
  const canSave = Boolean(view && form) && (dirty || view?.from === "rules_and_starter") && !saving && !blockingErrors && !(dirty && previewing);

  const save = async () => {
    if (!view || !form) return;
    const k = kind;
    const sent = form;
    setSaving(true);
    setSaveErrors((e) => ({ ...e, [k]: [] }));
    try {
      const res = await fetch("/api/aiark/linkedin-settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, kind: k, value: valueOf(view, sent), version: view.version }),
      });
      const j = await res.json();
      if (!res.ok) {
        if (j.changed) {
          drafts.delete(draftKey(tag, k));
          await load();
        } else if (Array.isArray(j.errors)) setSaveErrors((e) => ({ ...e, [k]: j.errors }));
        throw new Error(j.error ?? "Could not save the LinkedIn settings");
      }
      const v = j.view as LinkedinSettingsView;
      setData((d) => (d ? { ...d, [k]: v } : d));
      // Edits made while the save was on its way stay on screen, as unsaved.
      setForms((f) => (f[k] === sent ? { ...f, [k]: draftOf(v) } : f));
      drafts.delete(draftKey(tag, k));
      toast.success(j.unchanged ? "Nothing changed" : `LinkedIn ${k === "people" ? "people" : "company"} search saved for ${tag}`);
      onSaved?.(v);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const undo = () => {
    if (!view) return;
    drafts.delete(draftKey(tag, kind));
    setForms((f) => ({ ...f, [kind]: draftOf(view) }));
    setSaveErrors((e) => ({ ...e, [kind]: [] }));
  };

  const sw = data?.switch;
  return (
    <section className="rounded-2xl bg-card p-4 shadow-ios">
      <div className="mb-3 flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold tracking-tight">LinkedIn searches</h2>
          <p className="text-[12px] text-muted-foreground">
            This client&apos;s own places and excluded keywords for its LinkedIn people search and company search. Everything else is the same for every
            client.
          </p>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {dirty && (
            <Button size="xs" variant="ghost" onClick={undo}>
              Undo changes
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={!canSave}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />} {view && !dirty && view.from === "row" ? "Saved" : "Save"}
          </Button>
        </div>
      </div>

      {loadError && (
        <div className="rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={load}>
            Try again
          </button>
        </div>
      )}
      {!data && !loadError && (
        <div className="flex min-h-[80px] items-center justify-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}

      {data && sw && (
        <div className="space-y-4 text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <IosSegmentedControl
              size="sm"
              className="w-[280px]"
              value={kind}
              onChange={setKind}
              options={KINDS.map((k) => ({ value: k.value, label: dirtyOf(k.value) ? `${k.label} (edited)` : k.label }))}
            />
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-[12px] font-medium",
                (kind === "people" ? sw.people : sw.companies) ? "bg-[var(--success)]/15 text-[var(--success)]" : "bg-muted text-muted-foreground"
              )}
              title={`At most ${fmt(sw.peoplePerCompany)} people a company on a LinkedIn people run (one setting for every client).`}
            >
              {!sw.enabled
                ? "LinkedIn searches off"
                : !sw.onList
                  ? "On, but not for this client"
                  : (kind === "people" ? sw.people : sw.companies)
                    ? "On for this client"
                    : kind === "people"
                      ? "On, but people runs are off for this client"
                      : "On, but company pulls are off for this client"}
            </span>
          </div>

          {view && form && (
            <KindEditor
              key={kind}
              view={view}
              form={form}
              setForm={setForm}
              shown={shown}
              previewing={dirty && previewing}
              errors={errors}
            />
          )}
        </div>
      )}
    </section>
  );
}

function KindEditor({
  view,
  form,
  setForm,
  shown,
  previewing,
  errors,
}: {
  view: LinkedinSettingsView;
  form: Draft;
  setForm: (patch: Partial<Draft>) => void;
  /** The preview of the lists on screen, when they differ from what is saved. */
  shown: LinkedinPreview | null;
  previewing: boolean;
  errors: ReturnType<typeof errorsByField>;
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  const p = view.provenance;
  const plan = shown?.plan ?? view.plan;
  const keywords = shown?.keywords ?? view.keywords;
  const notSearched = shown?.notSearched ?? view.notSearched;
  const narrowed = shown?.narrowed ?? view.narrowed;
  const placesSent = shown?.placesSent ?? view.placesSent;
  const removed = view.own.unplaced.filter((u) => !form.unplaced.includes(unplacedKey(u)));
  const kindWord = view.kind === "people" ? "people" : "company";

  const applySuggestion = (u: UnplacedValue, text: string) => {
    if (u.side === "exclude") {
      if (!form.out.includes(text)) setForm({ out: [...form.out, text] });
    } else if (!form.places.includes(text)) setForm({ places: [...form.places, text] });
  };

  return (
    <div className="space-y-4">
      <Provenance view={view} />
      {p.flags.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-[var(--warning)]/12 px-3 py-2 text-[12.5px]">
          {p.flags.map((f) => (
            <li key={f} className="flex gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" /> {p.flagWords[f] ?? f}
            </li>
          ))}
        </ul>
      )}
      {p.notes.length > 0 && (
        <div>
          <button type="button" onClick={() => setNotesOpen((v) => !v)} className="flex items-center gap-1 text-[12px] font-medium text-primary">
            <ChevronDown className={cn("size-3.5 transition-transform", notesOpen && "rotate-180")} />
            {notesOpen ? "Hide" : "Show"} how the seed read the Clay search ({fmt(p.notes.length)} note{p.notes.length === 1 ? "" : "s"})
          </button>
          {notesOpen && (
            <ul className={cn("mt-2 list-disc space-y-1 pl-5 text-[12px] leading-relaxed text-muted-foreground", LONG_LIST)}>
              {p.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Field
        label={`Places (${fmt(form.places.length)})`}
        hint={'As AI Ark is sent them: "City, State", "State" or "Country". A city is checked against the place reference when saved.'}
        errors={errors.places}
      >
        <div className={CHIPS_12}>
          <TagInput values={form.places} onChange={(v) => setForm({ places: v })} placeholder="City, State" maxTags={2000} splitOn={null} listClassName={LONG_LIST} />
        </div>
      </Field>
      <Field label={`Places left out (${fmt(form.out.length)})`} hint="Sent with every search: nobody there is found." errors={errors.out}>
        <div className={CHIPS_12}>
          <TagInput values={form.out} onChange={(v) => setForm({ out: v })} placeholder="Place to leave out" maxTags={2000} splitOn={null} listClassName={LONG_LIST} />
        </div>
      </Field>
      <Field
        label={`Excluded keywords (${fmt(form.keywords.length)})`}
        hint="Matched as whole words in a company's name, industry and description. The standard keywords go first, then these."
        errors={errors.keywords}
      >
        <div className={CHIPS_12}>
          <TagInput values={form.keywords} onChange={(v) => setForm({ keywords: v })} placeholder="Type a keyword, then Enter" maxTags={1000} listClassName={LONG_LIST} />
        </div>
      </Field>

      {view.own.unplaced.length > 0 && (
        <Field
          label={`Clay values not placed (${fmt(view.own.unplaced.length - removed.length)})`}
          hint="The seed could not turn these into places. They are never searched. Use a suggestion to add it to the places, or remove the value."
          errors={errors.unplaced}
        >
          <ul className={cn("space-y-1.5", LONG_LIST)}>
            {view.own.unplaced.map((u) => {
              const kept = form.unplaced.includes(unplacedKey(u));
              return (
                <li key={unplacedKey(u)} className={cn("rounded-xl border border-border/60 px-3 py-2 text-[12.5px]", !kept && "opacity-60")}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{u.value}</span>
                    <span className="text-[12px] text-muted-foreground">
                      {u.side === "exclude" ? "left out" : "included"} in Clay ({u.field.replace(/_/g, " ")})
                    </span>
                    <button
                      type="button"
                      className="ml-auto text-[12px] font-medium text-primary hover:underline"
                      onClick={() => setForm({ unplaced: kept ? form.unplaced.filter((k) => k !== unplacedKey(u)) : [...form.unplaced, unplacedKey(u)] })}
                    >
                      {kept ? "Remove" : "Keep"}
                    </button>
                  </div>
                  <p className="text-[12px] text-muted-foreground">{u.why}</p>
                  {kept && u.suggestionTexts.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-1">
                      <span className="text-[12px] text-muted-foreground">Use:</span>
                      {u.suggestionTexts.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => applySuggestion(u, t)}
                          className="rounded-full border border-dashed border-border px-2 py-0.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground"
                        >
                          + {t}
                        </button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Field>
      )}

      {errors.other.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
          {errors.other.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="space-y-3 rounded-xl bg-muted/50 p-3">
        <div className="flex items-center gap-2">
          <p className="text-[13px] font-medium">What a LinkedIn {kindWord} search sends</p>
          {previewing && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          {shown && <span className="text-[12px] text-muted-foreground">with the lists on screen</span>}
        </div>
        <p className="text-[12.5px]">
          {fmt(plan.searches)} search{plan.searches === 1 ? "" : "es"}, {fmt(placesSent.length)} place{placesSent.length === 1 ? "" : "s"} searched
          {view.kind === "people" ? " (the person's own place)" : " (any office; a LinkedIn pull keeps a company only when its head office is in the client's area)"}.
        </p>
        {plan.blockers.length > 0 && (
          <ul className="space-y-1 rounded-xl bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive">
            {plan.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        )}
        <NotSearched notSearched={notSearched} narrowed={narrowed} rules={view.rules} />
        <CheckedAfter keywords={keywords} />
        <Standard view={view} />
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

      <Log log={view.log} />
    </div>
  );
}

function Provenance({ view }: { view: LinkedinSettingsView }) {
  const p = view.provenance;
  if (view.from === "rules_and_starter") {
    return (
      <p className="rounded-xl bg-[var(--warning)]/12 px-3 py-2 text-[12.5px] leading-relaxed">
        No LinkedIn settings of its own yet: these are the client&apos;s rules places and the starter keywords
        {view.starter.loaded ? ` (${fmt(view.starter.items)}, version ${view.starter.version ?? "?"})` : " (not loaded yet)"}. Save to keep its own copy.
      </p>
    );
  }
  const clay = p.clay;
  const fromClay = clay ? `Clay search${clay.campaign ? ` "${clay.campaign}"` : ""}${clay.setUpAt ? `, set up ${day(clay.setUpAt)}` : ""}` : null;
  const copied = p.copiedFrom ? ` Copied from the client's ${p.copiedFrom === "people" ? "people" : "company"} search: it had no ${view.kind === "people" ? "people" : "company"} search in Clay.` : "";
  return (
    <p className="text-[12.5px] leading-relaxed text-muted-foreground">
      {p.source === "manual"
        ? `Saved${p.updatedBy ? ` by ${p.updatedBy}` : ""} on ${day(p.updatedAt)}.${fromClay ? ` First copied from the ${fromClay}.` : ""}`
        : `Copied from the ${fromClay ?? "Clay search"}${p.seededAt ? ` on ${day(p.seededAt)}` : ""}.${copied}`}
    </p>
  );
}

function NotSearched({ notSearched, narrowed, rules }: { notSearched: PlaceView[]; narrowed: NarrowedPlace[]; rules: LinkedinSettingsView["rules"] }) {
  if (!rules.places) {
    return (
      <p className="text-[12.5px] text-muted-foreground">
        The client&apos;s sending rules hold no places, so its LinkedIn places are searched as they are.
      </p>
    );
  }
  if (!notSearched.length && !narrowed.length) {
    return <p className="text-[12.5px] text-muted-foreground">Every place is inside the client&apos;s sending rules.</p>;
  }
  return (
    <div className="space-y-2">
      {notSearched.length > 0 && (
        <div>
          <p className="text-[12.5px] font-medium text-[var(--warning)]">
            Not searched: outside the client&apos;s sending rules ({fmt(notSearched.length)})
          </p>
          <PlaceChips places={notSearched} />
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            Nobody is looked for there, so nothing is paid for that could never be sent. Adding them to the client&apos;s rules (the{" "}
            <Link className="underline" href="/clients">
              Clients page
            </Link>{" "}
            or the onboarding sheet) brings them in. The client&apos;s own list here stays as it is.
          </p>
        </div>
      )}
      {narrowed.length > 0 && (
        <div>
          <p className="text-[12.5px] font-medium">Searched as the rules&apos; places inside them ({fmt(narrowed.length)})</p>
          <ul className="mt-1 space-y-1 text-[12px] text-muted-foreground">
            {narrowed.map((n) => (
              <li key={n.entry.text}>
                <span className="font-medium text-foreground">{n.entry.text}</span>: {n.into.slice(0, 6).map((x) => x.text).join(" · ")}
                {n.into.length > 6 ? ` and ${fmt(n.into.length - 6)} more` : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CheckedAfter({ keywords }: { keywords: LinkedinPreview["keywords"] }) {
  const n = keywords.checkedAfter.length;
  return (
    <div>
      <p className="text-[12.5px]">
        Keywords: {fmt(keywords.union)} left out, in {fmt(keywords.sent)} phrases sent to AI Ark
        {n ? "" : ", all of them in the request"}.
      </p>
      {n > 0 && (
        <div className="mt-1">
          <p className="text-[12.5px] font-medium">Checked after the pull (AI Ark limit) ({fmt(n)})</p>
          <div className={cn("mt-1 flex flex-wrap gap-1", LONG_LIST)}>
            {keywords.checkedAfter.map((k) => (
              <span key={k} className="rounded-full bg-card px-2 py-0.5 text-[12px]">
                {k}
              </span>
            ))}
          </div>
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            AI Ark&apos;s request can&apos;t hold these. Every company and person the search finds is checked against all of the client&apos;s keywords
            before anything more is spent on it or it is listed, and a match is left out.
          </p>
        </div>
      )}
    </div>
  );
}

function Standard({ view }: { view: LinkedinSettingsView }) {
  const [open, setOpen] = useState(false);
  const s = view.standard;
  const bands = s.bands.length ? s.bands.map((b) => (b.end ? `${fmt(b.start ?? 1)} to ${fmt(b.end)}` : `${fmt(b.start ?? 1)}+`)).join(", ") + " employees" : "any size";
  const types = s.companyTypes.map((t) => t.replace(/_/g, " ").toLowerCase()).join(" or ");
  return (
    <div>
      <p className="text-[12.5px] leading-relaxed">
        {s.from === "saved"
          ? "This client's own AI Ark people filters (above) replace the standard titles, sizes and industries: "
          : "Same for every client, the standard filters: "}
        {view.kind === "people" ? `${fmt(s.titles)} job titles (${s.titleMode.toLowerCase()} match), ${fmt(s.excludeTitles)} titles left out, ` : ""}
        {bands}, {fmt(s.excludeIndustries)} industries left out, no {types} companies, and {fmt(s.keywords.length)} standard keywords left out, sent first,
        then the {fmt(s.competitors.terms.length)} terms of the built-in list &ldquo;{s.competitors.name}&rdquo; (
        <Link href={s.competitors.editHref} className="underline">edit it on the Lists page</Link>).
        {s.from === "saved" ? " The standard keywords, the list and company types still go." : ""}
      </p>
      {s.competitors.note && <p className="mt-1 text-[12px] leading-relaxed text-[var(--warning)]">{s.competitors.note}</p>}
      <button type="button" onClick={() => setOpen((v) => !v)} className="mt-1 flex items-center gap-1 text-[12px] font-medium text-primary">
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {open ? "Hide" : "Show"} the lists
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {view.kind === "people" && <ChipList label="Job titles" items={s.filters.titles} />}
          {view.kind === "people" && <ChipList label="Titles left out" items={s.filters.exclude_titles} />}
          <ChipList label="Industries left out" items={s.filters.exclude_industries} />
          <ChipList label="Standard keywords" items={s.keywords} />
          <ChipList label={`Competitors list: ${s.competitors.name}`} items={s.competitors.terms} />
        </div>
      )}
    </div>
  );
}

function ChipList({ label, items }: { label: string; items: string[] }) {
  return (
    <div>
      <p className="text-[12px] font-medium text-muted-foreground">
        {label} ({fmt(items.length)})
      </p>
      <div className={cn("mt-1 flex flex-wrap gap-1", LONG_LIST)}>
        {items.map((x) => (
          <span key={x} className="rounded-full bg-card px-2 py-0.5 text-[12px]">
            {x}
          </span>
        ))}
      </div>
    </div>
  );
}

function PlaceChips({ places }: { places: PlaceView[] }) {
  return (
    <div className={cn("mt-1 flex flex-wrap gap-1", LONG_LIST)}>
      {places.map((p) => (
        <span key={p.text} className="rounded-full bg-[var(--warning)]/15 px-2 py-0.5 text-[12px]">
          {p.text}
        </span>
      ))}
    </div>
  );
}

const COUNT_WORDS: { key: keyof LinkedinCounts; label: string }[] = [
  { key: "places", label: "places" },
  { key: "excluded_places", label: "left out" },
  { key: "unplaced", label: "not placed" },
  { key: "keywords", label: "keywords" },
];

function Log({ log }: { log: LinkedinLogEntry[] }) {
  if (!log.length) return <p className="text-[12px] text-muted-foreground">No saves or seed writes yet.</p>;
  return (
    <div>
      <p className="mb-1 text-[12px] font-medium text-muted-foreground">Changes, newest first</p>
      <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
        {log.map((l) => (
          <li key={l.id} className="px-3 py-1.5 text-[12px]">
            <span className="font-medium">{l.action === "seed" ? "Copied from Clay" : `Saved${l.byName ? ` by ${l.byName}` : ""}`}</span>
            <span className="text-muted-foreground">
              {" "}
              on {day(l.at)}
              {l.action === "seed" && l.seededBy ? ` (seed run by ${l.seededBy})` : ""}:{" "}
              {COUNT_WORDS.map(({ key, label }) => (l.before && l.before[key] !== l.after[key] ? `${label} ${fmt(l.before[key])} to ${fmt(l.after[key])}` : `${label} ${fmt(l.after[key])}`)).join(", ")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Field({ label, hint, errors, children }: { label: string; hint?: string; errors?: string[]; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[12.5px] font-medium">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{hint}</p>}
      {errors && errors.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-[12px] text-destructive">
          {errors.slice(0, 20).map((e) => (
            <li key={e}>{e}</li>
          ))}
          {errors.length > 20 && <li>and {fmt(errors.length - 20)} more</li>}
        </ul>
      )}
    </div>
  );
}
