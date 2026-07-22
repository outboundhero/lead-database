"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { useHasPermission } from "@/lib/context/role-context";
import type { ClientRow } from "@/app/api/clients/route";

type Filter = "all" | "active" | "churned" | "mapped" | "unmapped";

export default function ClientsPage() {
  const canEdit = useHasPermission("admin");
  const canRefresh = useHasPermission("manager");
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingTag, setSavingTag] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/clients");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load clients");
      setClients(data.clients ?? []);
      setRefreshedAt(data.refreshedAt ?? null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load clients");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function refreshStats() {
    setRefreshing(true);
    const id = toast.loading("Recomputing client stats…");
    try {
      const res = await fetch("/api/clients/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Refresh failed");
      toast.success("Stats refreshed", { id });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed", { id });
    } finally {
      setRefreshing(false);
    }
  }

  async function patchClient(tag: string, body: Record<string, unknown>) {
    setSavingTag(tag);
    // Optimistic update.
    setClients((prev) => prev.map((c) => (c.tag === tag ? { ...c, ...deriveLocal(c, body) } : c)));
    try {
      const res = await fetch("/api/clients", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag, ...body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Update failed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Update failed");
      load(); // revert to server truth
    } finally {
      setSavingTag(null);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return clients.filter((c) => {
      if (filter === "active" && c.churned) return false;
      if (filter === "churned" && !c.churned) return false;
      if (filter === "mapped" && !c.sendable) return false;
      if (filter === "unmapped" && c.sendable) return false;
      if (!q) return true;
      return c.tag.toLowerCase().includes(q) || (c.name ?? "").toLowerCase().includes(q) || (c.owner ?? "").toLowerCase().includes(q);
    });
  }, [clients, search, filter]);

  const totals = useMemo(() => ({
    clients: clients.length,
    active: clients.filter((c) => !c.churned).length,
    leads: clients.reduce((n, c) => n + c.leads, 0),
    categorized: clients.reduce((n, c) => n + c.categorized, 0),
  }), [clients]);

  return (
    <div className="max-w-6xl space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[28px] font-semibold tracking-tight">Clients</h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Per-client data breakdown, health, and Bison routing. {totals.clients} clients · {totals.active} active ·{" "}
            {totals.leads.toLocaleString()} tagged leads
            {refreshedAt && <> · stats {new Date(refreshedAt).toLocaleString()}</>}
          </p>
        </div>
        {canRefresh && (
          <Button variant="outline" size="sm" onClick={refreshStats} disabled={refreshing} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh stats
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tag, name, owner…" className="h-8 w-64 pl-8 text-xs" />
        </div>
        <div className="inline-flex rounded-lg bg-muted p-0.5">
          {(["all", "active", "churned", "mapped", "unmapped"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-all ${filter === f ? "bg-background shadow-sm" : "text-muted-foreground"}`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs">Client</TableHead>
              <TableHead className="text-xs">Owner</TableHead>
              <TableHead className="text-right text-xs">Leads</TableHead>
              <TableHead className="text-right text-xs">Categorized</TableHead>
              <TableHead className="text-right text-xs">Contactable</TableHead>
              <TableHead className="text-right text-xs">B2B / B2C</TableHead>
              <TableHead className="text-xs">Routing</TableHead>
              <TableHead className="text-xs">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-xs text-muted-foreground">Loading…</TableCell></TableRow>
            ) : filtered.length === 0 ? (
              <TableRow><TableCell colSpan={8} className="py-8 text-center text-xs text-muted-foreground">No clients match.</TableCell></TableRow>
            ) : filtered.map((c) => {
              const pct = c.leads > 0 ? Math.round((c.categorized / c.leads) * 100) : 0;
              return (
                <TableRow key={c.tag} className={c.churned ? "opacity-60" : ""}>
                  <TableCell className="text-xs">
                    <div className="font-semibold">{c.tag}</div>
                    {c.name && <div className="text-[11px] text-muted-foreground">{c.name}</div>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{c.owner ?? "—"}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{c.leads.toLocaleString()}</TableCell>
                  <TableCell className="text-right text-xs tabular-nums">
                    {c.categorized.toLocaleString()}
                    <span className="ml-1 text-[10px] text-muted-foreground">{pct}%</span>
                  </TableCell>
                  <TableCell className="text-right text-xs tabular-nums">{c.contactable.toLocaleString()}</TableCell>
                  <TableCell className="text-right text-[11px] tabular-nums text-muted-foreground">
                    {c.business.toLocaleString()} / {c.personal.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs">
                    {c.sendable
                      ? <Badge variant="secondary" className="text-[10px]">grp {c.group_no ?? "?"}</Badge>
                      : <Badge variant="outline" className="text-[10px] text-muted-foreground">unmapped</Badge>}
                  </TableCell>
                  <TableCell className="text-xs">
                    {canEdit ? (
                      <button
                        type="button"
                        disabled={savingTag === c.tag}
                        onClick={() => patchClient(c.tag, { churned: !c.churned })}
                        className="disabled:opacity-50"
                        title="Toggle active / churned"
                      >
                        <Badge variant={c.churned ? "destructive" : "default"} className="cursor-pointer text-[10px]">
                          {c.churned ? "Churned" : "Active"}
                        </Badge>
                      </button>
                    ) : (
                      <Badge variant={c.churned ? "destructive" : "default"} className="text-[10px]">
                        {c.churned ? "Churned" : "Active"}
                      </Badge>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// Reflect a PATCH body onto a local row for optimistic UI.
function deriveLocal(c: ClientRow, body: Record<string, unknown>): Partial<ClientRow> {
  const out: Partial<ClientRow> = {};
  if (typeof body.churned === "boolean") {
    out.churned = body.churned;
    out.status = body.churned ? "Confirmed Churn" : "Healthy";
  }
  return out;
}
