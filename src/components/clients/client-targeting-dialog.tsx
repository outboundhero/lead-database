"use client";

import { useEffect, useState } from "react";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TagInput } from "@/components/ui/ios/tag-input";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { toast } from "sonner";

// Per-client targeting rules editor. Location entries are typed naturally —
// "Spokane, WA" (city), "Washington" or "WA" (state), "Canada" (country) —
// and validated against the geo reference on save; unknown places are
// rejected, never stored. Explicit exclusions override broader inclusions.

const COUNTRIES = [
  { code: "US", label: "USA" },
  { code: "CA", label: "Canada" },
  { code: "AU", label: "Australia" },
  { code: "NZ", label: "New Zealand" },
  { code: "GB", label: "United Kingdom" },
  { code: "IE", label: "Ireland" },
];
const COUNTRY_WORDS: Record<string, string> = {
  usa: "US", us: "US", "united states": "US", america: "US",
  canada: "CA", australia: "AU", "new zealand": "NZ",
  "united kingdom": "GB", uk: "GB", ireland: "IE",
};

type Entry = { country: string; state?: string; city?: string };

// "Spokane, WA" -> {US, WA, Spokane}; "Washington" -> {US, state}; "Canada" -> country
function parseEntry(raw: string): Entry {
  const t = raw.trim();
  const asCountry = COUNTRY_WORDS[t.toLowerCase()];
  if (asCountry) return { country: asCountry };
  const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // "City, ST" or "City, ST, Country"
    const country = parts[2] ? COUNTRY_WORDS[parts[2].toLowerCase()] ?? parts[2].toUpperCase() : "US";
    return { country, state: parts[1], city: parts[0] };
  }
  return { country: "US", state: t }; // bare state name/code (server validates)
}
function entryLabel(e: Entry): string {
  if (e.city) return `${e.city}, ${e.state}${e.country !== "US" ? `, ${e.country}` : ""}`;
  if (e.state) return `${e.state}${e.country !== "US" ? `, ${e.country}` : ""}`;
  return COUNTRIES.find((c) => c.code === e.country)?.label ?? e.country;
}

interface Props {
  tag: string | null;
  onClose: () => void;
}

export function ClientTargetingDialog({ tag, onClose }: Props) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [countries, setCountries] = useState<string[]>(["US"]);
  const [include, setInclude] = useState<Entry[]>([]);
  const [exclude, setExclude] = useState<Entry[]>([]);
  const [industries, setIndustries] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [requireLocation, setRequireLocation] = useState(false);
  const [allowInferred, setAllowInferred] = useState(true);
  const [commercialCleaning, setCommercialCleaning] = useState(false);

  useEffect(() => {
    if (!tag) return;
    setLoading(true);
    fetch(`/api/clients/targeting?tag=${encodeURIComponent(tag)}`)
      .then((r) => r.json())
      .then((d) => {
        const t = d.targeting;
        if (!t) { // fresh config defaults
          setCountries(["US"]); setInclude([]); setExclude([]);
          setIndustries([]); setKeywords([]);
          setRequireLocation(false); setAllowInferred(true); setCommercialCleaning(false);
          return;
        }
        setCountries(t.countries ?? ["US"]);
        setInclude(t.include_locations ?? []);
        setExclude(t.exclude_locations ?? []);
        setIndustries(t.exclude_industries ?? []);
        setKeywords(t.exclude_keywords ?? []);
        setRequireLocation(!!t.require_location);
        setAllowInferred(t.allow_inferred_location !== false);
        setCommercialCleaning(!!t.commercial_cleaning);
      })
      .catch(() => toast.error("Failed to load targeting"))
      .finally(() => setLoading(false));
  }, [tag]);

  async function save() {
    if (!tag) return;
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
          exclude_industries: industries,
          exclude_keywords: keywords,
          require_location: requireLocation,
          allow_inferred_location: allowInferred,
          commercial_cleaning: commercialCleaning,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Targeting saved for ${tag}. Applies to previews and every future push.`);
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
                onChange={(arr) => setInclude(arr.map(parseEntry))}
              />
              <p className="mt-1 px-1 text-[10px] text-muted-foreground">Empty = the whole targeted country list.</p>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Exclude locations</p>
              <TagInput
                values={exclude.map(entryLabel)}
                placeholder='e.g. "Spokane, WA" — overrides any inclusion'
                onChange={(arr) => setExclude(arr.map(parseEntry))}
              />
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Exclude industries</p>
              <TagInput values={industries} placeholder="Exact industry/category names" onChange={setIndustries} />
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Exclude keywords</p>
              <TagInput values={keywords} placeholder="Whole-word match on company/categories" onChange={setKeywords} />
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
