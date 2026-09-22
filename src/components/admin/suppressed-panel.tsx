"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, ChevronDown, ChevronRight, Loader2, RotateCcw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";

// Never-contact list, grouped by reason, with one-click reactivation.
//
// Reasons are free text typed by whoever suppressed the address ("UK / AU",
// ".IN", "Out of USA" / "out of USA"), so the server folds them
// case-insensitively and shows the most common spelling — the same key is what
// "Restore all" sends back.
//
// Restoring lifts the block AND sets leads.is_suppressed = false, so the lead
// is live again. An address whose lead row was deleted at suppression time has
// nothing to bring back; the count says so rather than pretending.

interface Group { key: string; label: string; total: number; withLead: number; firstAt: string; lastAt: string }
interface Row { email: string; reason: string | null; notes: string | null; suppressed_by_name: string | null; created_at: string; lead_exists: boolean }

const PAGE = 100;

export function SuppressedPanel({ canRestore }: { canRestore: boolean }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/leads/suppress?group=reason");
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Couldn't load");
      setGroups(d.groups ?? []);
      setTotal(d.total ?? 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load the never-contact list");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { loadGroups(); }, [loadGroups]);

  const loadRows = useCallback(async (key: string, search: string) => {
    setRowsLoading(true);
    setPicked(new Set());
    try {
      const p = new URLSearchParams({ reason: key, limit: String(PAGE) });
      if (search.trim()) p.set("q", search.trim());
      const r = await fetch(`/api/leads/suppress?${p}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Couldn't load");
      setRows(d.suppressed ?? []);
      setRowsTotal(d.total ?? 0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't load addresses");
    } finally { setRowsLoading(false); }
  }, []);

  function toggleGroup(key: string) {
    if (openKey === key) { setOpenKey(null); setRows([]); return; }
    setOpenKey(key);
    setQ("");
    loadRows(key, "");
  }

  async function restore(body: Record<string, unknown>, what: string) {
    if (!canRestore) return;
    setBusy(true);
    try {
      const r = await fetch("/api/leads/suppress", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Couldn't restore");
      toast.success(d.message ?? `${what} restored`);
      await loadGroups();
      if (openKey) await loadRows(openKey, q);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't restore");
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2 text-[17px]">
            <Ban className="size-4 text-destructive" strokeWidth={1.75} />
            Never contact
          </CardTitle>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {total.toLocaleString()} address{total === 1 ? "" : "es"} blocked from every campaign, grouped by reason.
            {canRestore
              ? " Restoring lifts the block and makes the lead active again."
              : " Only an admin or owner can restore an address."}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadGroups} disabled={loading || busy}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : "Refresh"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <p className="text-[14px] text-muted-foreground">Loading…</p>
        ) : groups.length === 0 ? (
          <p className="text-[14px] text-muted-foreground">Nothing is suppressed.</p>
        ) : (
          groups.map((g) => {
            const open = openKey === g.key;
            return (
              <div key={g.key} className="rounded-xl border">
                <div className="flex items-center gap-2 p-3">
                  <button
                    type="button"
                    className="flex flex-1 items-center gap-2 text-left"
                    onClick={() => toggleGroup(g.key)}
                  >
                    {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
                    <span className="text-[14px] font-medium">{g.label}</span>
                    <span className="text-[13px] tabular-nums text-muted-foreground">
                      {g.total.toLocaleString()} address{g.total === 1 ? "" : "es"}
                      {g.withLead < g.total && ` · ${(g.total - g.withLead).toLocaleString()} with no lead row`}
                    </span>
                  </button>
                  {canRestore && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-primary"
                      disabled={busy}
                      title={`Lift the block on all ${g.total.toLocaleString()} and make those leads active again`}
                      onClick={() => {
                        if (!confirm(`Restore all ${g.total.toLocaleString()} addresses suppressed as "${g.label}"?\n\nThey become contactable again in every campaign.`)) return;
                        restore({ reason: g.key }, `"${g.label}"`);
                      }}
                    >
                      <RotateCcw className="size-3.5 mr-1" />
                      Restore all
                    </Button>
                  )}
                </div>

                {open && (
                  <div className="border-t p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          value={q}
                          onChange={(e) => setQ(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter") loadRows(g.key, q); }}
                          placeholder="Search an address in this group…"
                          className="h-8 pl-7 text-xs"
                        />
                      </div>
                      <Button variant="outline" size="sm" onClick={() => loadRows(g.key, q)} disabled={rowsLoading}>
                        Search
                      </Button>
                      {canRestore && picked.size > 0 && (
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => restore({ emails: [...picked] }, `${picked.size} address${picked.size === 1 ? "" : "es"}`)}
                        >
                          <RotateCcw className="size-3.5 mr-1" />
                          Restore {picked.size}
                        </Button>
                      )}
                    </div>

                    {rowsLoading ? (
                      <p className="text-[13px] text-muted-foreground">Loading…</p>
                    ) : rows.length === 0 ? (
                      <p className="text-[13px] text-muted-foreground">No addresses match.</p>
                    ) : (
                      <>
                        <div className="max-h-80 overflow-y-auto rounded-lg border">
                          {rows.map((r) => (
                            <label
                              key={r.email}
                              className="flex items-center gap-2 border-b px-2 py-1.5 text-xs last:border-b-0 hover:bg-muted/40"
                            >
                              {canRestore && (
                                <input
                                  type="checkbox"
                                  className="rounded"
                                  checked={picked.has(r.email)}
                                  onChange={() => setPicked((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(r.email)) next.delete(r.email); else next.add(r.email);
                                    return next;
                                  })}
                                />
                              )}
                              <span className="flex-1 truncate font-mono">{r.email}</span>
                              {!r.lead_exists && (
                                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                  lead deleted
                                </span>
                              )}
                              <span className="shrink-0 text-[11px] text-muted-foreground">
                                {r.suppressed_by_name ?? "—"} · {new Date(r.created_at).toLocaleDateString()}
                              </span>
                            </label>
                          ))}
                        </div>
                        {rowsTotal > rows.length && (
                          <p className="text-[11px] text-muted-foreground">
                            Showing {rows.length} of {rowsTotal.toLocaleString()} — search to narrow, or use Restore all.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
