"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { IosToggle } from "@/components/ui/ios/ios-toggle";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtCount } from "@/lib/sharing/labels";
import type { ClientsAnswer } from "@/lib/sharing/types";

// The Sharing page's Clients tab: each client's sharing pool or "isolated",
// whether it can receive and why not (fn_client_receive_block: status, group,
// the Groups tab, the churn date, its rules), whether it is on the sharing
// list and the push list, and what it took in the last 7 days.

const isActive = (status: string | null) => ["active", "healthy"].includes((status ?? "").trim().toLowerCase());

export function ClientsTab() {
  const [data, setData] = useState<ClientsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeOnly, setActiveOnly] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    let gone = false;
    fetch("/api/sharing/clients")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load the clients");
        if (!gone) setData(j);
      })
      .catch((e) => !gone && setError(e instanceof Error ? e.message : "Could not load the clients"));
    return () => {
      gone = true;
    };
  }, []);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.clients ?? []).filter(
      (c) =>
        (!activeOnly || isActive(c.status)) &&
        (!term || c.tag.toLowerCase().includes(term) || (c.name ?? "").toLowerCase().includes(term) || (c.client_type ?? "").toLowerCase().includes(term))
    );
  }, [data, activeOnly, q]);

  if (error) return <p className="text-[13px] text-destructive">{error}</p>;
  if (!data) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (!data.ready) return <p className="rounded-2xl bg-[var(--warning)]/12 p-4 text-[13px]">Sharing is not set up in this database yet (migration 134).</p>;

  return (
    <div className="space-y-3">
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">
        Pools:{" "}
        {Object.entries(data.pools)
          .map(([k, v]) => `${k} (${v.join(", ")})`)
          .join("; ") || "none, so every client is isolated"}
        . Tags ending in {data.isolatedSuffixes.join(", ") || "nothing"} are isolated. An isolated client never receives a share and its imports
        are never shared.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a client" className="h-9 w-56 rounded-full pl-8 text-[13px]" />
        </div>
        <label className="flex items-center gap-2 text-[12.5px]">
          <IosToggle size="sm" checked={activeOnly} onCheckedChange={setActiveOnly} aria-label="Active clients only" />
          Active and Healthy only
        </label>
        <span className="text-[12.5px] text-muted-foreground">{fmtCount(rows.length)} shown</span>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-card shadow-ios">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Pool</TableHead>
              <TableHead>Receives</TableHead>
              <TableHead>Lists</TableHead>
              <TableHead>Shared in, 7 days</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((c) => (
              <TableRow key={c.tag}>
                <TableCell>
                  <span className="font-medium">{c.tag}</span>
                  {c.name && <span className="ml-2 text-[12px] text-muted-foreground">{c.name}</span>}
                </TableCell>
                <TableCell>{c.status ?? ""}</TableCell>
                <TableCell>{c.client_type ?? ""}</TableCell>
                <TableCell>{c.pool ?? <span className="text-muted-foreground">isolated</span>}</TableCell>
                <TableCell>
                  {c.receiveBlock ? <span className="text-destructive">cannot receive: {c.receiveBlock}</span> : <Badge variant="success">Can receive</Badge>}
                </TableCell>
                <TableCell className="space-x-1">
                  {c.onList && <Badge variant="tinted">Sharing</Badge>}
                  {c.onPushList && <Badge variant="tinted">Pushed</Badge>}
                </TableCell>
                <TableCell className="tabular-nums">{fmtCount(c.shared7d)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
