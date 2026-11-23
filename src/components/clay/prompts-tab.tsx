"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Info, Loader2, RotateCcw, Save, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { IosSegmentedControl } from "@/components/ui/ios/ios-segmented-control";
import { useHasPermission } from "@/lib/context/role-context";
import { cn } from "@/lib/utils";
import type { PromptColumnView, PromptKind, PromptsSaved, PromptsView } from "@/app/api/enrich/prompts/route";

// The Prompts tab of the Clay tab's Client setup sheet (migration 139): a
// client's own text for its four personalisation AI steps, People research
// (P#60) and question AI (P#61), General research (G#48) and question AI
// (G#49). Each step's card shows whose text runs (edited, the client's own
// Clay text, or the default's), the text with {{Column}} placeholders (the
// chips insert them at the cursor), the Clay original read only, Save, and
// Reset to Clay original. The server writes the expression the pipeline
// runs; the text is never taken as one (GET/PUT/DELETE /api/enrich/prompts).
// Loaded fresh on open; a save sends the step's version back, and a 409
// loads the tab again keeping the text typed. Unsaved text asks before the
// tab is closed or reloaded. Managers read, admins save.

export interface PromptFocus {
  kind: PromptKind;
  position: number;
}

/** The research and question steps by kind and column key: what "Edit prompt" in the grid opens. */
const PROMPT_STEPS: Record<PromptKind, Record<string, number>> = {
  people: { claygent: 60, question_ai: 61 },
  inboxes: { claygent: 48, question_ai: 49 },
};
const KIND_OF_TEMPLATE: Record<string, PromptKind> = { people_v1: "people", inboxes_v1: "inboxes" };

/** The step a pipeline table's column is, as the sheet's focus; null for any other column or table. */
export function promptFocusOf(template: string | null | undefined, key: string): PromptFocus | null {
  const kind = template ? KIND_OF_TEMPLATE[template] : undefined;
  const position = kind ? PROMPT_STEPS[kind][key] : undefined;
  return kind && position ? { kind, position } : null;
}

const KIND_LABEL: Record<PromptKind, string> = { people: "People", inboxes: "General" };
const LETTER: Record<PromptKind, string> = { people: "P", inboxes: "G" };
const ROLE_LABEL: Record<PromptColumnView["role"], string> = { research: "Research", question: "Question AI" };
const idOf = (c: { kind: PromptKind; position: number }) => `${c.kind}:${c.position}`;
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) : null;
const SHARED = "“Shared personalisation text”";

export function PromptsTab({
  tag,
  focus = null,
  onSaved,
  onDirtyChange,
}: {
  tag: string;
  /** The step to open on (the grid's "Edit prompt"). */
  focus?: PromptFocus | null;
  /** After a save or a reset that changed something. */
  onSaved?: () => void;
  /** Whether the tab holds text not saved yet (the sheet asks before leaving). */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const canEdit = useHasPermission("admin");
  const [view, setView] = useState<PromptsView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<PromptKind>(focus?.kind ?? "people");
  const [focusId, setFocusId] = useState<string | null>(focus ? idOf(focus) : null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  /** Text typed that a reload keeps (after a 409), by step. */
  const keep = useRef<Record<string, string>>({});

  useEffect(() => {
    const ctl = new AbortController();
    fetch(`/api/enrich/prompts?tag=${encodeURIComponent(tag)}`, { signal: ctl.signal, cache: "no-store" })
      .then(async (res) => {
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : "Could not load the prompts");
        const v = j as PromptsView;
        const kept = keep.current;
        keep.current = {};
        setView(v);
        setDrafts(Object.fromEntries(v.columns.map((c) => [idOf(c), kept[idOf(c)] ?? c.text ?? ""])));
        setLoadError(null);
      })
      .catch((e) => {
        if ((e as Error)?.name !== "AbortError") setLoadError(e instanceof Error ? e.message : "Could not load the prompts");
      });
    return () => ctl.abort();
  }, [tag, reloads]);

  const dirtyIds = view ? view.columns.filter((c) => (drafts[idOf(c)] ?? "") !== (c.text ?? "")).map(idOf) : [];
  const dirty = dirtyIds.length > 0;

  // The browser asks before the page is closed or reloaded with text not saved.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const reload = (keepText: Record<string, string> = {}) => {
    keep.current = keepText;
    setReloads((n) => n + 1);
  };

  const send = async (c: PromptColumnView, method: "PUT" | "DELETE") => {
    const id = idOf(c);
    const text = drafts[id] ?? "";
    setBusy(id);
    setErrors((e) => ({ ...e, [id]: [] }));
    try {
      const res = await fetch("/api/enrich/prompts", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag, kind: c.kind, position: c.position, version: c.version, ...(method === "PUT" ? { text } : {}) }),
      });
      const j = await res.json().catch(() => ({}));
      const label = `${KIND_LABEL[c.kind]} ${ROLE_LABEL[c.role]}`;
      if (!res.ok) {
        if (j.changed) {
          toast.error(`${label} was changed by someone else since this tab loaded it`, {
            description: method === "PUT" ? "It has been loaded again with your text kept in the box: save again to replace theirs." : "It has been loaded again: check it before resetting.",
          });
          reload(method === "PUT" ? { [id]: text } : {});
          return;
        }
        if (Array.isArray(j.errors) && j.errors.length) setErrors((e) => ({ ...e, [id]: j.errors as string[] }));
        toast.error(typeof j.error === "string" ? j.error : method === "PUT" ? "Could not save the prompt" : "Could not reset the prompt");
        return;
      }
      const saved = j as PromptsSaved;
      const next = saved.columns.find((x) => idOf(x) === id);
      setView(saved);
      setDrafts((d) => ({ ...d, [id]: next?.text ?? "" }));
      if (!saved.saved) {
        toast.success("Nothing changed");
        return;
      }
      toast.success(method === "PUT" ? `${label} saved for ${tag}` : `${label} is the Clay original again for ${tag}`, {
        description: saved.recompiled ? "The client's tables run it from their next rows. Rows already worked keep their answers." : saved.note ?? undefined,
      });
      onSaved?.();
    } catch {
      toast.error(method === "PUT" ? "Could not save the prompt: no answer from the server" : "Could not reset the prompt: no answer from the server");
    } finally {
      setBusy(null);
    }
  };

  const reset = (c: PromptColumnView) => {
    const lost = dirtyIds.includes(idOf(c)) ? " The text typed here and not saved is lost too." : "";
    if (!window.confirm(`Reset ${KIND_LABEL[c.kind]} ${ROLE_LABEL[c.role]} for ${tag} to the Clay original? The edit is deleted, and the client's tables run the Clay text again.${lost}`)) return;
    void send(c, "DELETE");
  };

  if (loadError && !view) {
    return (
      <div className="space-y-2 py-6 text-center text-[13px]">
        <p className="text-destructive">{loadError}</p>
        <Button size="sm" variant="outline" onClick={() => reload()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="flex justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const cols = view.columns.filter((c) => c.kind === kind);
  const ps = view.personalisation;
  const status = !ps.enabled
    ? `Personalisation is off: nothing here runs until it is on, with ${tag} on its list (Companies tab, Settings).`
    : !ps.listed
      ? `Personalisation is on, but ${tag} is not on its list: nothing here runs for ${tag} yet (Companies tab, Settings).`
      : `Personalisation is on for ${tag}.`;
  const defaults = cols.filter((c) => c.source === "default");
  const whose = ps.sharedTextOk
    ? null
    : defaults.length === 2
      ? `Both ${KIND_LABEL[kind]} steps run the default's text, which runs for ${tag} only with ${SHARED} on. Saving a step's text here makes it ${tag}'s own.`
      : defaults.length === 1
        ? defaults[0].role === "question"
          ? `Question AI still runs the default's text, which runs for ${tag} only with ${SHARED} on: with it off, the research is paid for and no question is written. Edit Question AI too.`
          : `Research still runs the default's text, which runs for ${tag} only with ${SHARED} on: with it off, neither step runs (Question AI reads the research). Edit Research too.`
        : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <IosSegmentedControl
          size="sm"
          value={kind}
          onChange={(k) => {
            setKind(k);
            setFocusId(null);
          }}
          options={(["people", "inboxes"] as PromptKind[]).map((k) => ({
            value: k,
            label: `${KIND_LABEL[k]}${view.columns.some((c) => c.kind === k && dirtyIds.includes(idOf(c))) ? " •" : ""}`,
          }))}
        />
        <p className={cn("text-[12.5px]", ps.enabled && ps.listed ? "text-muted-foreground" : "text-[var(--warning)]")}>{status}</p>
      </div>
      {whose && (
        <p className="flex items-start gap-2 rounded-xl bg-[var(--warning)]/10 px-3 py-2 text-[12.5px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
          <span>{whose}</span>
        </p>
      )}
      {!canEdit && <p className="text-[12.5px] text-muted-foreground">Only an admin can change prompts; this is the text as it runs now.</p>}
      {cols.map((c) => (
        <StepCard
          key={idOf(c)}
          col={c}
          draft={drafts[idOf(c)] ?? ""}
          onDraft={(t) => {
            setDrafts((d) => ({ ...d, [idOf(c)]: t }));
            setErrors((e) => (e[idOf(c)]?.length ? { ...e, [idOf(c)]: [] } : e));
          }}
          errors={errors[idOf(c)] ?? []}
          canEdit={canEdit}
          dirty={dirtyIds.includes(idOf(c))}
          busy={busy === idOf(c)}
          locked={busy !== null}
          autoFocus={focusId === idOf(c)}
          onSave={() => void send(c, "PUT")}
          onReset={() => reset(c)}
        />
      ))}
    </div>
  );
}

function SourceBadge({ col }: { col: PromptColumnView }) {
  const cls = "text-[12px] normal-case tracking-normal";
  if (col.source === "edited") {
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant="tinted" className={cls}>
          Edited
        </Badge>
        <span className="text-[12px] text-muted-foreground">
          by {col.updatedBy ?? "someone"}
          {col.updatedAt ? ` · ${when(col.updatedAt)}` : ""}
        </span>
      </span>
    );
  }
  if (col.source === "client") {
    return (
      <Badge variant="success" className={cls}>
        Client&apos;s own Clay text
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className={cls}>
      Default text
    </Badge>
  );
}

function StepCard({
  col,
  draft,
  onDraft,
  errors,
  canEdit,
  dirty,
  busy,
  locked,
  autoFocus,
  onSave,
  onReset,
}: {
  col: PromptColumnView;
  draft: string;
  onDraft: (text: string) => void;
  errors: string[];
  canEdit: boolean;
  dirty: boolean;
  busy: boolean;
  locked: boolean;
  autoFocus: boolean;
  onSave: () => void;
  onReset: () => void;
}) {
  const card = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [find, setFind] = useState("");

  useEffect(() => {
    if (!autoFocus) return;
    card.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    box.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  // Each column, then each of its fields ({{Name.field}}).
  const tokens = col.placeholders.flatMap((p) => [{ text: p.name, field: false }, ...(p.fields ?? []).map((f) => ({ text: `${p.name}.${f}`, field: true }))]);
  const term = find.trim().toLowerCase();
  const shown = term ? tokens.filter((t) => t.text.toLowerCase().includes(term)) : tokens;

  /** Puts a placeholder where the cursor is (or over the selection), then puts the cursor after it. */
  const insert = (name: string) => {
    const token = `{{${name}}}`;
    const el = box.current;
    const start = el ? el.selectionStart : draft.length;
    const end = el ? el.selectionEnd : draft.length;
    onDraft(draft.slice(0, start) + token + draft.slice(end));
    requestAnimationFrame(() => {
      const b = box.current;
      if (!b) return;
      b.focus();
      b.setSelectionRange(start + token.length, start + token.length);
    });
  };

  return (
    <div ref={card} className="scroll-mt-2 space-y-3 rounded-2xl bg-muted/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">{ROLE_LABEL[col.role]}</p>
          <p className="truncate text-[12px] text-muted-foreground">
            {LETTER[col.kind]}#{col.position} · {col.name}
          </p>
        </div>
        <SourceBadge col={col} />
      </div>

      {col.problem && (
        <p className="flex items-start gap-2 text-[12.5px] text-[var(--warning)]">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{col.problem}</span>
        </p>
      )}
      {col.source !== "edited" && col.text === null && (
        <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>
            The Clay original can&apos;t be shown as text{col.originalReason ? ` (${col.originalReason})` : ""}. It still runs as it is.
            {canEdit ? " Write a new text below to replace it with this client's own." : ""}
          </span>
        </p>
      )}

      <textarea
        ref={box}
        value={draft}
        onChange={(e) => onDraft(e.target.value)}
        readOnly={!canEdit}
        spellCheck={false}
        aria-label={`${KIND_LABEL[col.kind]} ${ROLE_LABEL[col.role]} prompt`}
        placeholder={canEdit ? "Write the prompt. Put a column in with {{Column name}}, or click one below." : ""}
        maxLength={40_000}
        className="block h-56 min-h-32 w-full resize-y rounded-xl bg-card p-3 text-[13px] leading-relaxed outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
        <span>{draft.length.toLocaleString("en-US")} characters</span>
        {dirty && <span className="font-medium text-[var(--warning)]">Not saved</span>}
      </div>
      {errors.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-[12.5px] text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {canEdit && tokens.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-medium">Columns this step can read</span>
            <div className="relative ml-auto w-48">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a column" className="h-8 rounded-full pl-7 text-[12px]" />
            </div>
          </div>
          <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
            {shown.map((t, i) => (
              <button
                key={`${i}:${t.text}`}
                type="button"
                title={`Insert {{${t.text}}} at the cursor`}
                onClick={() => insert(t.text)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors",
                  t.field ? "bg-card text-foreground shadow-ios hover:bg-muted" : "bg-primary/10 text-primary hover:bg-primary/15"
                )}
              >
                {t.text}
              </button>
            ))}
            {shown.length === 0 && <span className="text-[12px] text-muted-foreground">No column matches.</span>}
          </div>
        </div>
      )}

      <div>
        <button type="button" onClick={() => setShowOriginal((o) => !o)} className="flex items-center gap-1 text-[12.5px] font-medium text-primary">
          {showOriginal ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          Clay original
        </button>
        {showOriginal && (
          <pre className="mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-card p-3 font-mono text-[12px] leading-relaxed">
            {col.originalText ?? `It can't be shown as text${col.originalReason ? `: ${col.originalReason}` : ""}.`}
          </pre>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onSave} disabled={!dirty || locked || !draft.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
          {col.source === "edited" && (
            <Button size="sm" variant="outline" onClick={onReset} disabled={locked}>
              <RotateCcw /> Reset to Clay original
            </Button>
          )}
        </div>
      )}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Rows already worked keep their answers. To write them again with this text, use &ldquo;Re-run this column for every row&rdquo; in the column&apos;s menu on the
        grid: that pays OpenAI again for every row.
      </p>
    </div>
  );
}
