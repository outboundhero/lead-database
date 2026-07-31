"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, MapPin, RotateCw, Sparkles, X, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { useHasPermission } from "@/lib/context/role-context";

type CountryRow = { code: string; display_name: string; leads: number };
type StateRow = { state_code: string; name: string; leads: number };
type CityRow = { city: string; state: string; state_code: string; country: string; country_code: string; leads: number };
type UnresolvedRow = { variation: string; leads: number };
type QueueLead = {
  id: string; email: string; first_name: string | null; last_name: string | null;
  company: string | null; title: string | null; website: string | null;
  phone: string | null; address: string | null; postal_code: string | null;
};
type Suggestion = {
  kind: string; country: string | null; state_code: string | null;
  city: string | null; reason: string; valid: boolean;
};

export default function LocationsPage() {
  const canResolve = useHasPermission("manager");
  const [tab, setTab] = useState<"browse" | "unresolved">("browse");

  // ── browse state ──
  const [country, setCountry] = useState<CountryRow | null>(null);
  const [state, setState] = useState<StateRow | null>(null);
  const [countries, setCountries] = useState<CountryRow[]>([]);
  const [states, setStates] = useState<StateRow[]>([]);
  const [cities, setCities] = useState<CityRow[]>([]);
  const [loading, setLoading] = useState(false);

  const loadBrowse = useCallback(async (c: CountryRow | null, s: StateRow | null) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (c) params.set("country", c.code);
      if (s) params.set("state", s.state_code);
      const res = await fetch(`/api/locations?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (data.level === "countries") setCountries(data.rows);
      else if (data.level === "states") setStates(data.rows);
      else setCities(data.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load locations");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadBrowse(null, null); }, [loadBrowse]);

  // ── unresolved state ──
  const [queue, setQueue] = useState<UnresolvedRow[]>([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [form, setForm] = useState({ city: "", state: "", country: "US" });
  const [saving, setSaving] = useState<string | null>(null);
  // Drill-down: the leads behind one variation, so you can SEE where it is.
  const [detail, setDetail] = useState<string | null>(null);
  const [detailRows, setDetailRows] = useState<QueueLead[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  async function openDetail(variation: string) {
    setDetail(variation); setDetailRows([]); setSuggestion(null); setDetailLoading(true);
    try {
      const res = await fetch(`/api/locations/unresolved/leads?variation=${encodeURIComponent(variation)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDetailRows(data.rows ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load leads");
    } finally {
      setDetailLoading(false);
    }
  }

  async function askAi(variation: string) {
    setSuggesting(true);
    try {
      const res = await fetch("/api/locations/unresolved/suggest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variation }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSuggestion(data.suggestion);
      // Pre-fill the resolve form with a usable proposal.
      if (data.suggestion?.valid && (data.suggestion.kind === "city" || data.suggestion.kind === "state")) {
        setForm({
          city: data.suggestion.city ?? "",
          state: data.suggestion.state_code ?? "",
          country: data.suggestion.country ?? "US",
        });
        setResolving(variation);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "AI suggestion failed");
    } finally {
      setSuggesting(false);
    }
  }

  const loadQueue = useCallback(async () => {
    setQueueLoading(true);
    try {
      const res = await fetch("/api/locations/unresolved");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setQueue(data.rows);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load queue");
    } finally {
      setQueueLoading(false);
    }
  }, []);

  useEffect(() => { if (tab === "unresolved") loadQueue(); }, [tab, loadQueue]);

  async function resolve(variation: string, discard = false) {
    setSaving(variation);
    try {
      const res = await fetch("/api/locations/unresolved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(discard
          ? { variation, action: "discard" }
          : { variation, country: form.country, state: form.state || undefined, city: form.city || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(discard
        ? `Discarded — ${data.updated} leads marked as no-location`
        : `Resolved ${data.updated} leads. Future imports with this variation resolve automatically.`);
      // Update in place — no refetch, so the scroll position survives.
      setQueue((prev) => prev.filter((r) => r.variation !== variation));
      setResolving(null);
      setSuggestion(null);
      if (detail === variation) setDetail(null);
      setForm({ city: "", state: "", country: "US" });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Resolve failed");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Locations</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Normalized geography across supported countries. City | State | Code | Country | Code.
          </p>
        </div>
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          {(["browse", "unresolved"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-all ${tab === t ? "bg-background shadow-sm" : "text-muted-foreground"}`}
            >
              {t === "unresolved" ? "Unresolved queue" : "Browse"}
            </button>
          ))}
        </div>
      </div>

      {tab === "browse" && (
        <>
          {/* breadcrumb */}
          <div className="flex items-center gap-1 text-[13px]">
            <button className={country ? "text-primary" : "font-medium"} onClick={() => { setCountry(null); setState(null); loadBrowse(null, null); }}>
              All countries
            </button>
            {country && (
              <>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                <button className={state ? "text-primary" : "font-medium"} onClick={() => { setState(null); loadBrowse(country, null); }}>
                  {country.display_name}
                </button>
              </>
            )}
            {state && (
              <>
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="font-medium">{state.name} ({state.state_code})</span>
              </>
            )}
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{!country ? "Country" : !state ? "State / Province / Region" : "City"}</TableHead>
                  {country && state && <TableHead className="text-xs">State</TableHead>}
                  {country && state && <TableHead className="text-xs">Country</TableHead>}
                  <TableHead className="text-right text-xs">Leads</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-xs text-muted-foreground">Loading…</TableCell></TableRow>
                ) : !country ? (
                  countries.map((c) => (
                    <TableRow key={c.code} className="cursor-pointer" onClick={() => { setCountry(c); loadBrowse(c, null); }}>
                      <TableCell className="text-[13px] font-medium">{c.display_name} <span className="text-muted-foreground">({c.code})</span></TableCell>
                      <TableCell className="text-right text-[13px] tabular-nums">{c.leads.toLocaleString()}</TableCell>
                    </TableRow>
                  ))
                ) : !state ? (
                  states.map((s) => (
                    <TableRow key={s.state_code} className="cursor-pointer" onClick={() => { setState(s); loadBrowse(country, s); }}>
                      <TableCell className="text-[13px] font-medium">{s.name} <span className="text-muted-foreground">({s.state_code})</span></TableCell>
                      <TableCell className="text-right text-[13px] tabular-nums">{s.leads.toLocaleString()}</TableCell>
                    </TableRow>
                  ))
                ) : cities.length === 0 ? (
                  <TableRow><TableCell colSpan={4} className="py-8 text-center text-xs text-muted-foreground">No leads with cities here yet.</TableCell></TableRow>
                ) : (
                  cities.map((c) => (
                    <TableRow key={c.city}>
                      <TableCell className="text-[13px]">{c.city}</TableCell>
                      <TableCell className="text-[13px] text-muted-foreground">{c.state} ({c.state_code})</TableCell>
                      <TableCell className="text-[13px] text-muted-foreground">{c.country} ({c.country_code})</TableCell>
                      <TableCell className="text-right text-[13px] tabular-nums">{c.leads.toLocaleString()}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {tab === "unresolved" && (
        <>
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-muted-foreground">
              Location text we couldn&apos;t confidently resolve. These leads are hidden from
              search and campaigns until resolved. Manual resolutions are remembered —
              future imports with the same text resolve automatically.
            </p>
            <Button variant="outline" size="sm" onClick={loadQueue} disabled={queueLoading} className="gap-2 shrink-0">
              <RotateCw className={`h-3.5 w-3.5 ${queueLoading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
          {suggestion && (
            <div className="rounded-xl border bg-muted/40 p-3 text-[13px]">
              <div className="flex items-start gap-2">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="flex-1">
                  <p className="font-medium">
                    AI: {suggestion.kind}
                    {suggestion.city ? ` — ${suggestion.city}, ${suggestion.state_code}, ${suggestion.country}` : ""}
                    {!suggestion.city && suggestion.state_code ? ` — ${suggestion.state_code}, ${suggestion.country}` : ""}
                    {!suggestion.valid && suggestion.kind !== "junk" && suggestion.kind !== "foreign" && (
                      <span className="ml-2 text-destructive">(not in the geo reference — rejected)</span>
                    )}
                  </p>
                  <p className="mt-0.5 text-[12px] text-muted-foreground">{suggestion.reason}</p>
                </div>
                <button onClick={() => setSuggestion(null)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {detail && (
            <div className="rounded-xl border">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <Building2 className="h-4 w-4 text-muted-foreground" />
                <p className="text-[13px] font-medium">
                  Leads with location &ldquo;<span className="font-mono">{detail}</span>&rdquo;
                  {detailRows.length > 0 && <span className="ml-1 text-muted-foreground">({detailRows.length} shown)</span>}
                </p>
                <button onClick={() => setDetail(null)} className="ml-auto text-muted-foreground hover:text-foreground">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto">
                {detailLoading ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">Loading leads…</p>
                ) : detailRows.length === 0 ? (
                  <p className="py-6 text-center text-xs text-muted-foreground">No leads found.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs">Company</TableHead>
                        <TableHead className="text-xs">Website</TableHead>
                        <TableHead className="text-xs">Phone</TableHead>
                        <TableHead className="text-xs">Address</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detailRows.map((l) => (
                        <TableRow key={l.id}>
                          <TableCell className="text-[12px]">{l.company ?? "—"}</TableCell>
                          <TableCell className="text-[12px]">
                            {l.website ? (
                              <a href={`https://${l.website.replace(/^https?:\/\//, "")}`} target="_blank" rel="noreferrer"
                                 className="text-primary underline-offset-2 hover:underline">
                                {l.website.replace(/^https?:\/\//, "")}
                              </a>
                            ) : "—"}
                          </TableCell>
                          <TableCell className="text-[12px] text-muted-foreground">{l.phone ?? "—"}</TableCell>
                          <TableCell className="text-[12px] text-muted-foreground">
                            {[l.address, l.postal_code].filter(Boolean).join(", ") || "—"}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </div>
          )}

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">Raw variation</TableHead>
                  <TableHead className="text-right text-xs">Leads</TableHead>
                  {canResolve && <TableHead className="text-xs w-[380px]">Resolve to</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {queueLoading ? (
                  <TableRow><TableCell colSpan={3} className="py-8 text-center text-xs text-muted-foreground">Loading…</TableCell></TableRow>
                ) : queue.length === 0 ? (
                  <TableRow><TableCell colSpan={3} className="py-8 text-center text-xs text-muted-foreground">Queue is empty 🎉</TableCell></TableRow>
                ) : queue.map((r) => (
                  <TableRow key={r.variation}>
                    <TableCell className="text-[13px]">
                      <button
                        className="font-mono text-primary underline-offset-2 hover:underline"
                        onClick={() => openDetail(r.variation)}
                        title="Show the leads with this location"
                      >
                        {r.variation}
                      </button>
                    </TableCell>
                    <TableCell className="text-right text-[13px] tabular-nums">{r.leads.toLocaleString()}</TableCell>
                    {canResolve && (
                      <TableCell>
                        {resolving === r.variation ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Input placeholder="City (optional)" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} className="h-7 w-32 text-xs" />
                            <Input placeholder="State code" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })} className="h-7 w-24 text-xs" />
                            <Input placeholder="US" value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} className="h-7 w-14 text-xs" />
                            <Button size="sm" className="h-7 text-xs" disabled={saving === r.variation} onClick={() => resolve(r.variation)}>
                              {saving === r.variation ? "Saving…" : "Save"}
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setResolving(null)}>Cancel</Button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => setResolving(r.variation)}>
                              <MapPin className="h-3 w-3" /> Resolve
                            </Button>
                            <Button
                              size="sm" variant="outline" className="h-7 gap-1 text-xs"
                              disabled={suggesting}
                              onClick={() => askAi(r.variation)}
                              title="Ask AI to identify this location from the leads' companies and websites"
                            >
                              <Sparkles className="h-3 w-3" /> AI
                            </Button>
                            <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground"
                              disabled={saving === r.variation}
                              onClick={() => resolve(r.variation, true)}>
                              Discard
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            Resolving writes a permanent alias — the system learns every fix.
          </Badge>
        </>
      )}
    </div>
  );
}
