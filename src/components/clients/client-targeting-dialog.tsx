"use client";

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagInput } from "@/components/ui/ios/tag-input";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { useHasPermission } from "@/lib/context/role-context";
import { entryLabel, parseEntry, TARGET_COUNTRIES as COUNTRIES, type LocationEntry as Entry } from "@/lib/clients/targeting-validate";
import { toast } from "sonner";

// Per-client targeting rules editor. Location entries are typed naturally —
// "Spokane, WA" (city), "Washington" or "WA" (state), "Canada" (country) —
// and validated against the geo reference on save; unknown places are
// rejected, never stored. Explicit exclusions override broader inclusions.
// Changed places are locked against the onboarding-sheet sync (migration 139):
// the dialog says so, and "Follow the sheet again" hands them back to it.

/** "Follow the sheet again": the places' lock comes off (PUT /api/clients/location {unlock}); the next sync applies the sheet. */
async function followSheet(tag: string): Promise<void> {
  const g = await fetch(`/api/clients/location?tag=${encodeURIComponent(tag)}`);
  const view = await g.json().catch(() => ({}));
  if (!g.ok) throw new Error(typeof view.error === "string" ? view.error : "Could not read the client's places");
  const res = await fetch("/api/clients/location", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tag, unlock: true, version: view.version }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : "Could not hand the places back to the sheet");
}

interface Props {
  tag: string | null;
  onClose: () => void;
}

export function ClientTargetingDialog({ tag, onClose }: Props) {
  const canEdit = useHasPermission("admin");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // The places' lock (migration 139): edited by hand, when and by whom; reload bumps to read the rules again.
  const [lock, setLock] = useState<{ at: string | null; by: string | null } | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const [reload, setReload] = useState(0);
  const [countries, setCountries] = useState<string[]>(["US"]);
  const [include, setInclude] = useState<Entry[]>([]);
  const [exclude, setExclude] = useState<Entry[]>([]);
  // Merged lists (migrations 078/079) — one Include box, one Exclude box.
  const [excludeTerms, setExcludeTerms] = useState<string[]>([]);
  const [includeTerms, setIncludeTerms] = useState<string[]>([]);
  const [requireLocation, setRequireLocation] = useState(false);
  const [allowInferred, setAllowInferred] = useState(true);
  const [commercialCleaning, setCommercialCleaning] = useState(false);
  const [sheetSyncedAt, setSheetSyncedAt] = useState<string | null>(null);
  // The client's minimum of good leads a place; empty means the default (weekly top-up, 500).
  const [minimum, setMinimum] = useState("");
  const [defaultMinimum, setDefaultMinimum] = useState<number | null>(null);

  useEffect(() => {
    if (!tag) return;
    setLoading(true);
    fetch(`/api/clients/targeting?tag=${encodeURIComponent(tag)}`)
      .then((r) => r.json())
      .then((d) => {
        const t = d.targeting;
        // Cleaning clients exclude the commercial-cleaning title list by
        // default (client rule 2026-08-25) — every existing cleaning client was
        // backfilled to match, so a brand-new one must not start out different.
        const isCleaning = d.client_type === "Cleaning";
        setDefaultMinimum(typeof d.default_min_leads_per_place === "number" ? d.default_min_leads_per_place : null);
        setMinimum(t && typeof t.min_leads_per_place === "number" ? String(t.min_leads_per_place) : "");
        setLock(t?.locations_locked ? { at: t.locations_locked_at ?? null, by: typeof d.locked_by_email === "string" ? d.locked_by_email : null } : null);
        if (!t) { // fresh config defaults
          setCountries(["US"]); setInclude([]); setExclude([]);
          setExcludeTerms([]); setIncludeTerms([]);
          setRequireLocation(false); setAllowInferred(true); setCommercialCleaning(isCleaning);
          setSheetSyncedAt(null);
          return;
        }
        setCountries(t.countries ?? ["US"]);
        setInclude(t.include_locations ?? []);
        setExclude(t.exclude_locations ?? []);
        setExcludeTerms(
          t.exclude_terms?.length
            ? t.exclude_terms
            : [...new Set([...(t.exclude_industries ?? []), ...(t.exclude_keywords ?? [])].map((x: string) => x.toLowerCase()))]
        );
        setIncludeTerms(
          t.include_terms?.length
            ? t.include_terms
            : [...new Set([...(t.include_industries ?? []), ...(t.include_keywords ?? [])].map((x: string) => x.toLowerCase()))]
        );
        setRequireLocation(!!t.require_location);
        setAllowInferred(t.allow_inferred_location !== false);
        setCommercialCleaning(!!t.commercial_cleaning);
        setSheetSyncedAt(t.source === "sheet" ? t.sheet_synced_at ?? null : null);
      })
      .catch(() => toast.error("Failed to load targeting"))
      .finally(() => setLoading(false));
  }, [tag, reload]);

  async function unlock() {
    if (!tag) return;
    if (!window.confirm(`Hand ${tag}'s places back to the onboarding sheet? The next sheet sync replaces them with what the sheet says. Changes not saved in this dialog are dropped.`)) return;
    setUnlocking(true);
    try {
      await followSheet(tag);
      toast.success(`${tag}'s places follow the onboarding sheet again: the next sync applies it.`);
      setReload((n) => n + 1);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not hand the places back to the sheet");
    } finally {
      setUnlocking(false);
    }
  }

  async function save() {
    if (!tag) return;
    const min = minimum.trim();
    const minValue = min === "" ? null : Number(min);
    if (minValue !== null && !(Number.isInteger(minValue) && minValue >= 1 && minValue <= 100_000)) {
      toast.error("The minimum of good leads a place must be a whole number from 1 to 100,000, or empty for the default.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/clients/targeting", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_tag: tag,
          countries,
          include_locations: include,
          exclude_locations: exclude,
          include_terms: includeTerms,
          exclude_terms: excludeTerms,
          require_location: requireLocation,
          allow_inferred_location: allowInferred,
          commercial_cleaning: commercialCleaning,
          min_leads_per_place: minValue,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(
        data.locked
          ? `Targeting saved for ${tag}. Its places are now kept from the onboarding sheet sync. Applies to previews and every future push.`
          : `Targeting saved for ${tag}. Applies to previews and every future push.`
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!tag} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Targeting — {tag}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <p className="py-6 text-center text-xs text-muted-foreground">Loading…</p>
        ) : (
          <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
            {lock ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--warning)]/10 px-3 py-2 text-[12px]">
                <span className="min-w-0 flex-1">
                  Places edited by hand{lock.at ? ` on ${new Date(lock.at).toLocaleDateString()}` : ""}{lock.by ? ` by ${lock.by}` : ""}: the
                  onboarding sheet no longer changes them.
                </span>
                {canEdit && (
                  <Button size="xs" variant="outline" onClick={unlock} disabled={unlocking || saving}>
                    {unlocking ? "Handing back…" : "Follow the sheet again"}
                  </Button>
                )}
              </div>
            ) : sheetSyncedAt ? (
              <div className="rounded-xl bg-muted px-3 py-2 text-[12px] text-muted-foreground">
                Synced from the onboarding sheet {new Date(sheetSyncedAt).toLocaleDateString()}.
                Places you change here are kept from the sheet sync after that; exclusion terms follow
                the sheet whenever its row changes.
              </div>
            ) : null}
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Countries</p>
              <div className="flex flex-wrap gap-1.5">
                {COUNTRIES.map((c) => {
                  const on = countries.includes(c.code);
                  return (
                    <button
                      key={c.code}
                      type="button"
                      onClick={() => setCountries(on ? countries.filter((x) => x !== c.code) : [...countries, c.code])}
                      className={`rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors ${on ? "bg-primary text-primary-foreground" : "bg-muted text-foreground hover:bg-accent"}`}
                    >
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Include locations</p>
              <TagInput
                values={include.map(entryLabel)}
                placeholder='"Washington", "Spokane, WA", "Canada" — Enter to add'
                // splitOn={null}: a comma is part of the value here ("Spokane, WA").
                splitOn={null}
                onChange={(arr) => setInclude(arr.map(parseEntry))}
              />
              <p className="mt-1 px-1 text-[12px] text-muted-foreground">
                Empty = the whole targeted country list. Saving changed places (or countries) keeps them from the
                onboarding sheet sync until you follow the sheet again.
              </p>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Exclude locations</p>
              <TagInput
                values={exclude.map(entryLabel)}
                placeholder='e.g. "Spokane, WA" — overrides any inclusion'
                splitOn={null}
                onChange={(arr) => setExclude(arr.map(parseEntry))}
              />
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Exclude terms</p>
              <TagInput
                values={excludeTerms}
                placeholder='e.g. restaurant, bar, retail — paste a comma list'
                onChange={setExcludeTerms}
              />
              <p className="mt-1 px-1 text-[10px] text-muted-foreground">
                Blocks these from every send. Matched as whole words (plural-tolerant, so
                &quot;restaurant&quot; also blocks &quot;Restaurants&quot;) across category, subcategory,
                additional category, company name and industry. It won&apos;t match inside another
                word — &quot;bar&quot; never blocks &quot;Barber&quot;.
              </p>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Include terms</p>
              <TagInput
                values={includeTerms}
                placeholder='Optional — e.g. dental, office'
                onChange={setIncludeTerms}
              />
              <p className="mt-1 px-1 text-[10px] text-muted-foreground">
                Optional and empty by default. These never block anyone — they only pre-fill the
                Category filter when you pick this client on the Leads page.
              </p>
            </div>

            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Minimum good leads a place</p>
              <Input
                type="number"
                inputMode="numeric"
                min={1}
                max={100000}
                step={1}
                value={minimum}
                placeholder={defaultMinimum != null ? `Default (${defaultMinimum.toLocaleString("en-US")})` : "Default"}
                onChange={(e) => setMinimum(e.target.value)}
                className="h-9 w-48 text-[13px]"
              />
              <p className="mt-1 px-1 text-[12px] text-muted-foreground">
                A place with fewer good leads than this shows as low on the Leads page and in the weekly top-up.
                Empty uses the default. The sheet sync never changes it.
              </p>
            </div>

            <div className="space-y-2.5 rounded-xl border p-3">
              <label className="flex items-center justify-between text-[13px]">
                <span>Require resolved location<span className="block text-[11px] text-muted-foreground">Off = unknown-location leads still qualify</span></span>
                <IosToggle checked={requireLocation} onCheckedChange={setRequireLocation} />
              </label>
              <label className="flex items-center justify-between text-[13px]">
                <span>Allow inferred locations<span className="block text-[11px] text-muted-foreground">Company-derived (propagation / area code / AI)</span></span>
                <IosToggle checked={allowInferred} onCheckedChange={setAllowInferred} />
              </label>
              <label className="flex items-center justify-between text-[13px]">
                <span>Commercial cleaning exclusions<span className="block text-[11px] text-muted-foreground">~230 non-buyer job titles</span></span>
                <IosToggle checked={commercialCleaning} onCheckedChange={setCommercialCleaning} />
              </label>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || loading}>{saving ? "Saving…" : "Save targeting"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
