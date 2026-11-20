"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { age, fmtCount, pushNoteText, when } from "@/lib/sharing/labels";
import type { HeldAnswer } from "@/lib/sharing/types";
import { PushSharedDialog } from "./push-shared-dialog";

// The Sharing page's Held tab (plan 1.11): the shares waiting to be pushed and
// the held ones by client and reason with their age (the pick is tried again
// once a day for held_retry_days, then they stay held until "Push shared";
// shares of a push cancelled on the Exports page are never tried again by
// themselves), the push timer's refused asks as the running worker reports
// them, the leads of recent imports that still have no usable place (by the
// place text they carry: fixing it on the Locations page lets them be
// shared), and which Bison installs the lead mirror covers.

export function HeldTab({ isAdmin }: { isAdmin: boolean }) {
  const [data, setData] = useState<HeldAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pushFor, setPushFor] = useState<{ receiver: string; held: boolean } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/sharing/held");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not load the held shares");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the held shares");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <p className="text-[13px] text-destructive">{error}</p>;
  if (!data) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (!data.ready) return <p className="rounded-2xl bg-[var(--warning)]/12 p-4 text-[13px]">Sharing is not set up in this database yet (migration 134).</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <p className="text-[13.5px] font-semibold">Held and queued shares</p>
        <Button size="icon-xs" variant="ghost" onClick={load} aria-label="Reload">
          <RefreshCw />
        </Button>
      </div>
      {data.held.length === 0 && data.queued.length === 0 && <p className="text-[12.5px] text-muted-foreground">Nothing is held or waiting.</p>}
      {data.queued.length > 0 && (
        <p className="text-[12.5px] text-muted-foreground">
          Waiting for the next push round: {data.queued.map((x) => `${x.receiver} ${fmtCount(x.rows)} (oldest ${age(x.oldest)})`).join(" · ")}
        </p>
      )}
      {data.refusals.length > 0 && (
        <div className="space-y-1 rounded-2xl bg-[var(--warning)]/12 p-3">
          <p className="text-[13px] font-semibold">Pushes refused</p>
          {data.refusals.map((r) => (
            <p key={r.receiver} className="text-[12.5px]">
              <span className="font-medium">{r.receiver}</span>: the last push was refused {age(r.at) || "0 minutes"} ago ({r.status ?? "no answer"}):{" "}
              {r.error}
              {r.kept !== null ? ` ${fmtCount(r.kept)} shares stay queued.` : ""}
              {r.retryHeld ? " (held shares tried again)" : ""}
            </p>
          ))}
          <p className="text-[12px] text-muted-foreground">
            {data.worker && !data.worker.online ? "The worker is offline; this is what it reported last. " : ""}
            Kept by the running worker: cleared by the next push for that client that goes through. A worker restart forgets it until the
            next try.
          </p>
        </div>
      )}
      {data.held.length > 0 && (
        <div className="overflow-x-auto rounded-2xl bg-card shadow-ios">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client</TableHead>
                <TableHead>Why held</TableHead>
                <TableHead>Shares</TableHead>
                <TableHead>Held for</TableHead>
                <TableHead>Last try</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.held.map((h) => (
                <TableRow key={`${h.receiver}|${h.note ?? ""}`}>
                  <TableCell className="font-medium">{h.receiver}</TableCell>
                  <TableCell className="max-w-[360px] whitespace-normal">{pushNoteText(h.note)}</TableCell>
                  <TableCell className="tabular-nums">{fmtCount(h.rows)}</TableCell>
                  <TableCell>
                    {age(h.oldest)}
                    {h.manual ? (
                      <Badge variant="outline" className="ml-2">
                        Not retried: Push shared sends them
                      </Badge>
                    ) : (
                      !h.retried && (
                        <Badge variant="outline" className="ml-2">
                          No longer retried
                        </Badge>
                      )
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{when(h.lastTry)}</TableCell>
                  <TableCell>
                    {isAdmin && (
                      <Button size="xs" variant="outline" onClick={() => setPushFor({ receiver: h.receiver, held: true })}>
                        <Send /> Push shared
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <p className="text-[12px] text-muted-foreground">
        Held shares are tried again once a day for {data.heldRetryDays} days, then they stay held until Push shared. Shares of a push cancelled on
        the Exports page are never tried again by themselves.
      </p>

      <p className="pt-2 text-[13.5px] font-semibold">Leads with no usable place</p>
      <p className="text-[12.5px] text-muted-foreground">
        New leads of the last 30 days&apos; imports whose place is still unknown are never shared. They are looked at again once a day for a while;
        fixing their place text on the Locations page lets them be shared.
      </p>
      {data.noPlace.length === 0 ? (
        <p className="text-[12.5px] text-muted-foreground">None.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl bg-card shadow-ios">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>City</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Country</TableHead>
                <TableHead>Location status</TableHead>
                <TableHead>Leads</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.noPlace.map((p, i) => (
                <TableRow key={i}>
                  <TableCell>{p.city || <span className="text-muted-foreground">(blank)</span>}</TableCell>
                  <TableCell>{p.state || <span className="text-muted-foreground">(blank)</span>}</TableCell>
                  <TableCell>{p.country || <span className="text-muted-foreground">(blank)</span>}</TableCell>
                  <TableCell>{p.status}</TableCell>
                  <TableCell className="tabular-nums">{fmtCount(p.leads)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <p className="pt-2 text-[13.5px] font-semibold">The Bison lead mirror</p>
      <p className="text-[12.5px] text-muted-foreground">
        A share push leaves out leads the mirror shows already in the picked campaigns. On an install the mirror does not cover, that check
        cannot be made, and the mirror is stale for older leads.
      </p>
      <ul className="space-y-1 text-[12.5px]">
        {data.mirror.map((m) => (
          <li key={m.install} className={m.covered ? undefined : "text-[var(--warning)]"}>
            {m.install} (group {m.group}, {m.side.toUpperCase()}): {m.covered ? `covered${m.lastSync ? `, last synced ${when(m.lastSync)}` : ""}` : "not covered"}
          </li>
        ))}
      </ul>
      <PushSharedDialog target={pushFor} onClose={() => setPushFor(null)} onDone={load} />
    </div>
  );
}
