"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Lock, RotateCcw, Save } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { TagInput } from "@/components/ui/ios/tag-input";
import { cn } from "@/lib/utils";
import { useHasPermission } from "@/lib/context/role-context";
import { entryLabel, parseEntry, samePlaces, TARGET_COUNTRIES, type LocationEntry } from "@/lib/clients/targeting-validate";
import type { LocationView, ServiceAreaFrom } from "@/lib/clients/location-server";
import type { LocationSaveView } from "@/app/api/clients/location/route";

// The Clay tab's Client setup, Location (migration 139): a client's places, as
// the Clients page's Rules dialog edits them (countries, include and exclude
// places, "City, ST"), whether they are kept from the onboarding-sheet sync
// (edited by hand) with "Follow the sheet again", the sheet's places text (read
// only), and the service area prompts read as {{Service Area}}: the client's
// own text, else the sheet's text, else a label of its places. Loaded fresh
// for each client; Save sends the version back and a 409 loads it again.
// Managers read, admins save (GET and PUT /api/clients/location).

type Form = { countries: string[]; include: LocationEntry[]; exclude: LocationEntry[]; serviceArea: string };

const formOf = (v: LocationView): Form => ({
  countries: [...v.countries],
  include: [...v.includeLocations],
  exclude: [...v.excludeLocations],
  serviceArea: v.serviceArea.value ?? "",
});

const placesDirty = (f: Form, v: LocationView) =>
  !samePlaces(
    { countries: f.countries, include_locations: f.include, exclude_locations: f.exclude },
    { countries: v.countries, include_locations: v.includeLocations, exclude_locations: v.excludeLocations }
  );
const areaDirty = (f: Form, v: LocationView) => f.serviceArea.trim() !== (v.serviceArea.value ?? "").trim();

const FROM_TEXT: Record<ServiceAreaFrom, string> = {
  variable: "typed here",
  sheet: "the onboarding sheet's places text (nothing typed here)",
  places: "a label of the client's places (nothing typed here, no places text in the sheet)",
  none: "nothing yet: prompts get an empty text",
};

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null);

async function send(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; j: Record<string, unknown> }> {
  const res = await fetch("/api/clients/location", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, j };
}

export function LocationTab({ tag }: { tag: string }) {
  const canEdit = useHasPermission("admin");
  const [view, setView] = useState<LocationView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<"save" | "unlock" | null>(null);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoadError(null);
    try {
      const res = await fetch(`/api/clients/location?tag=${encodeURIComponent(tag)}`, { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (mine !== seq.current) return;
      if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : "Could not load the client's places");
      setView(j as LocationView);
      setForm(formOf(j as LocationView));
      setErrors([]);
    } catch (e) {
      if (mine !== seq.current) return;
      setLoadError(e instanceof Error ? e.message : "Could not load the client's places");
    }
  }, [tag]);

  useEffect(() => {
    setView(null);
    setForm(null);
    load();
  }, [load]);

  const dirtyPlaces = Boolean(view && form && placesDirty(form, view));
  const dirtyArea = Boolean(view && form && areaDirty(form, view));
  const dirty = dirtyPlaces || dirtyArea;

  // The browser asks before the tab is closed or reloaded with edits not saved.
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);

  /** A save's answer: the new view, a reload on 409, or the reasons on 400. */
  const settle = (r: { ok: boolean; status: number; j: Record<string, unknown> }) => {
    if (r.ok) {
      const next = r.j as unknown as LocationSaveView;
      setView(next);
      setForm(formOf(next));
      setErrors([]);
      return next;
    }
    if (r.status === 409 && r.j.changed) {
      toast.warning("Someone changed this client's places or service area since they were loaded: loaded again. Make your change once more.");
      load();
      return null;
    }
    const list = Array.isArray(r.j.errors) ? r.j.errors.map(String) : [typeof r.j.error === "string" ? r.j.error : "Could not save"];
    setErrors(list);
    toast.error(list[0]);
    return null;
  };

  const save = async () => {
    if (!view || !form || !dirty) return;
    setBusy("save");
    try {
      const body: Record<string, unknown> = { tag, version: view.version };
      if (dirtyPlaces) Object.assign(body, { countries: form.countries, includeLocations: form.include, excludeLocations: form.exclude });
      if (dirtyArea) body.serviceArea = form.serviceArea.trim() ? form.serviceArea : null;
      const next = settle(await send(body));
      if (next) {
        const did = [
          next.saved.places ? "places saved and kept from the onboarding sheet sync" : null,
          next.saved.serviceArea === "saved" ? "service area saved" : null,
          next.saved.serviceArea === "removed" ? "service area removed" : null,
        ].filter(Boolean);
        toast.success(did.length ? `${tag}: ${did.join(", ")}.` : "Nothing changed.");
      }
    } catch {
      toast.error("Could not save: the request did not reach the server");
    } finally {
      setBusy(null);
    }
  };

  const followSheet = async () => {
    if (!view) return;
    if (!window.confirm(`Hand ${tag}'s places back to the onboarding sheet? The next sheet sync replaces them with what the sheet says.`)) return;
    setBusy("unlock");
    try {
      const next = settle(await send({ tag, version: view.version, unlock: true }));
      if (next) toast.success(`${tag}'s places follow the onboarding sheet again: the next sync applies it.`);
    } catch {
      toast.error("Could not reach the server");
    } finally {
      setBusy(null);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-2 py-6 text-center text-[13px]">
        <p className="text-destructive">{loadError}</p>
        <Button size="xs" variant="outline" onClick={load}>Try again</Button>
      </div>
    );
  }
  if (!view || !form) {
    return (
      <p className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading {tag}&apos;s places…
      </p>
    );
  }

  const typed = form.serviceArea.trim();
  const preview = typed ? { value: typed, from: "variable" as ServiceAreaFrom } : view.serviceArea.fallback;
  const fromText = preview.from === "variable" && !dirtyArea && view.serviceArea.source && view.serviceArea.source !== "manual"
    ? `set by the ${view.serviceArea.source === "scraper" ? "scraper" : "onboarding sheet"}`
    : FROM_TEXT[preview.from];
  const chips = (list: LocationEntry[]) =>
    list.length ? (
      <div className="flex flex-wrap gap-1">
        {list.map((e) => (
          <span key={entryLabel(e)} className="rounded-full bg-muted px-2 py-0.5 text-[12px]">{entryLabel(e)}</span>
        ))}
      </div>
    ) : (
      <p className="text-[12px] text-muted-foreground">None</p>
    );

  return (
    <div className="space-y-4">
      {view.locked ? (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--warning)]/10 px-3 py-2 text-[12.5px]">
          <Lock className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            Places edited by hand{view.lockedAt ? ` on ${day(view.lockedAt)}` : ""}{view.lockedBy ? ` by ${view.lockedBy}` : ""}: the
            onboarding sheet no longer changes them.
          </span>
          {canEdit && (
            <Button size="xs" variant="outline" onClick={followSheet} disabled={busy !== null || dirty} title={dirty ? "Save or undo your changes first" : undefined}>
              {busy === "unlock" ? <Loader2 className="animate-spin" /> : null} Follow the sheet again
            </Button>
          )}
        </div>
      ) : (
        <p className="rounded-xl bg-muted px-3 py-2 text-[12px] text-muted-foreground">
          {view.hasRules ? "The onboarding sheet sync may change these places when the client's sheet row changes. " : "No rules saved for this client yet. "}
          Saving changed places keeps them from the sheet sync until someone follows the sheet again.
        </p>
      )}

      <section className="space-y-1.5">
        <h3 className="text-[13px] font-semibold">Countries</h3>
        <div className="flex flex-wrap gap-1.5">
          {TARGET_COUNTRIES.map((c) => {
            const on = form.countries.includes(c.code);
            return (
              <button
                key={c.code}
                type="button"
                disabled={!canEdit}
                onClick={() => setForm({ ...form, countries: on ? form.countries.filter((x) => x !== c.code) : [...form.countries, c.code] })}
                className={cn(
                  "rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-default",
                  on ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-accent"
                )}
              >
                {c.label}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[13px] font-semibold">Include places</h3>
        {canEdit ? (
          <TagInput
            values={form.include.map(entryLabel)}
            placeholder='"Washington", "Spokane, WA", "Canada": Enter to add'
            splitOn={null}
            onChange={(arr) => setForm({ ...form, include: arr.map(parseEntry) })}
          />
        ) : (
          chips(form.include)
        )}
        <p className="text-[12px] text-muted-foreground">Empty means the whole of the countries above.</p>
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[13px] font-semibold">Exclude places</h3>
        {canEdit ? (
          <TagInput
            values={form.exclude.map(entryLabel)}
            placeholder='e.g. "Spokane, WA": overrides any included place'
            splitOn={null}
            onChange={(arr) => setForm({ ...form, exclude: arr.map(parseEntry) })}
          />
        ) : (
          chips(form.exclude)
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[13px] font-semibold">The onboarding sheet&apos;s places text</h3>
        {view.sheet.locations ? (
          <div className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-xl bg-muted/60 px-3 py-2 text-[12px]">{view.sheet.locations}</div>
        ) : (
          <p className="text-[12px] text-muted-foreground">None read from the sheet{view.locked ? "" : " (or the next sync reads it again)"}.</p>
        )}
        {view.sheet.syncedAt && <p className="text-[12px] text-muted-foreground">Last synced {day(view.sheet.syncedAt)}. Read only: change it in the sheet.</p>}
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[13px] font-semibold">Service area (for prompts)</h3>
        <p className="text-[12px] text-muted-foreground">
          The client&apos;s area in words. Prompts read it as {"{{Service Area}}"}: what is typed here, else the sheet&apos;s places
          text, else a label of the places above. A change reaches the rows worked after it.
        </p>
        <textarea
          className="h-24 w-full rounded-xl bg-card p-3 text-[13px] outline-none ring-1 ring-border focus-visible:ring-[3px] focus-visible:ring-ring/40"
          value={form.serviceArea}
          onChange={(e) => setForm({ ...form, serviceArea: e.target.value })}
          placeholder="e.g. the greater Springfield area and the towns around it"
          maxLength={5_000}
          readOnly={!canEdit}
        />
        <div className="space-y-1 rounded-xl bg-muted/60 px-3 py-2 text-[12px]">
          <p>
            <span className="font-medium">Prompts get:</span>{" "}
            {preview.value ? <span className="whitespace-pre-wrap">{preview.value}</span> : <span className="text-muted-foreground">(empty)</span>}
          </p>
          <p className="text-muted-foreground">From {fromText}.</p>
        </div>
        {canEdit && typed && (
          <Button size="xs" variant="outline" onClick={() => setForm({ ...form, serviceArea: "" })}>
            Use the sheet&apos;s text
          </Button>
        )}
      </section>

      {errors.length > 0 && (
        <ul className="space-y-0.5 rounded-xl bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button size="sm" onClick={save} disabled={!dirty || busy !== null}>
            {busy === "save" ? <Loader2 className="animate-spin" /> : <Save />} Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => { setForm(formOf(view)); setErrors([]); }} disabled={!dirty || busy !== null}>
            <RotateCcw /> Undo changes
          </Button>
          {dirtyPlaces && <span className="text-[12px] text-muted-foreground">Saving changed places keeps them from the onboarding sheet sync.</span>}
        </div>
      ) : (
        <p className="border-t pt-3 text-[12px] text-muted-foreground">Only admins can change a client&apos;s places and service area.</p>
      )}
    </div>
  );
}
