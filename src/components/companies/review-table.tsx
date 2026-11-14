"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ClipboardList, Loader2, RefreshCw, Terminal, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useHasPermission } from "@/lib/context/role-context";
import type { ReviewDecision, ReviewItem, ReviewPage } from "@/lib/companies/fit-types";

// One client's review list: bad fits already in its campaigns, per campaign
// and company, from the Email Bison copy (stale for most rows: each item shows
// its oldest sync date). Managers build the list and approve or reject, each
// decision recorded by name. Owners and admins queue the approved for removal,
// which removes nothing by itself: a person runs the removal worker's dry run,
// then the real run naming it, and each lead is read live again first.

const fmt = (n: number | null | undefined) => (n ?? 0).toLocaleString("en-US");
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");

const DECISION: Record<ReviewDecision, { label: string; cls: string }> = {
  pending: { label: "Pending", cls: "bg-muted text-muted-foreground" },
  approved: { label: "Approved for removal", cls: "bg-destructive/12 text-destructive" },
  rejected: { label: "Kept", cls: "bg-[var(--success)]/15 text-[var(--success)]" },
};

async function send(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j;
}

export function ReviewTable({ tag }: { tag: string }) {
  const isAdmin = useHasPermission("admin");
  const [page, setPage] = useState<ReviewPage | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [campaign, setCampaign] = useState<string>("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (after = 0) => {
      setError(null);
      try {
        const q = new URLSearchParams({ tag, ...(campaign ? { campaign } : {}), ...(after ? { after: String(after) } : {}) });
        const res = await fetch(`/api/fit/review?${q}`);
        const j = await res.json();
        if (!res.ok) throw new Error(j.error ?? "Could not load the review list");
        const p = j as ReviewPage;
        setPage(p);
        setItems((prev) => (after ? [...prev, ...p.items] : p.items));
        if (!after) setSelected(new Set());
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the review list");
      }
    },
    [tag, campaign]
  );

  useEffect(() => {
    load();
  }, [load]);

  // While a build runs, look again every 5 seconds.
  const building = page?.build && ["queued", "building"].includes(page.build.status);
  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => load(), 5_000);
    return () => clearInterval(t);
  }, [building, load]);

  const approvedIds = useMemo(() => items.filter((i) => i.decision === "approved").map((i) => i.id), [items]);
  const lastDry = page?.dry_runs.find((d) => !d.used_at) ?? null;

  const build = async () => {
    setBusy(true);
    try {
      const j = await send("/api/fit/review/build", { tag });
      toast.success(`Building ${tag}'s review list over ${fmt(j.campaigns)} campaign(s)${j.errors?.length ? `; ${j.errors.length} could not be read` : ""}`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not start the build");
    } finally {
      setBusy(false);
    }
  };

  const decide = async (decision: ReviewDecision, ids: number[] | "bulk") => {
    setBusy(true);
    try {
      const body = ids === "bulk" ? { tag, bulk: "under_2_no_replies", decision } : { tag, ids, decision };
      const j = await send("/api/fit/review/decide", body);
      toast.success(`${fmt(j.changed)} item(s) ${decision === "approved" ? "approved" : decision === "rejected" ? "kept" : "reset"}`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the decision");
    } finally {
      setBusy(false);
    }
  };

  const queue = async () => {
    if (!approvedIds.length) return;
    if (!window.confirm(`Hold ${fmt(approvedIds.length)} approved item(s) for removal? Nothing is removed until someone runs the dry run and then the real run.`)) return;
    setBusy(true);
    try {
      const j = await send("/api/fit/review/queue", { tag, ids: approvedIds });
      toast.success(`${fmt(j.queued)} lead(s) held for removal. Next: the dry run.`);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not queue the removals");
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <section className="rounded-2xl bg-card p-4 shadow-ios">
      <div className="mb-3 flex flex-wrap items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <ClipboardList className="size-4.5" strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-tight">Bad fits in {tag}&apos;s campaigns</h2>
          <p className="text-[12px] text-muted-foreground">
            Campaigns from push history and from live names starting with {tag}; Nurture campaigns are never listed. Counts come from the Email Bison copy
            {page?.summary.oldest_sync ? `, read as early as ${day(page.summary.oldest_sync)}` : ""}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy || Boolean(building)} onClick={build}>
            {building ? <Loader2 className="animate-spin" /> : <RefreshCw />} {page?.build ? "Build again" : "Build the review list"}
          </Button>
        </div>
      </div>

      {error && <p className="mb-3 rounded-xl bg-destructive/10 p-3 text-[13px] text-destructive">{error}</p>}

      {page && (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="rounded-full bg-muted px-2.5 py-1 font-medium">{fmt(page.summary.items)} items</span>
            <span className="rounded-full bg-muted px-2.5 py-1 font-medium">{fmt(page.summary.pending)} pending</span>
            <span className="rounded-full bg-muted px-2.5 py-1 font-medium">{fmt(page.summary.approved)} approved</span>
            <span className="rounded-full bg-muted px-2.5 py-1 font-medium">{fmt(page.summary.rejected)} kept</span>
            <span className="rounded-full bg-muted px-2.5 py-1 font-medium">
              {fmt(page.summary.leads)} leads, {fmt(page.summary.removable)} removable
            </span>
            {page.build && (
              <span className="rounded-full bg-muted px-2.5 py-1 font-medium">
                Last build: {page.build.status}
                {page.build.finished_at ? `, ${day(page.build.finished_at)}` : ""}
                {page.build.created_by_name ? ` by ${page.build.created_by_name}` : ""}
              </span>
            )}
            <select
              className="ml-auto h-8 rounded-full bg-muted px-3 text-[12px] font-medium"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
              aria-label="Campaign"
            >
              <option value="">Every campaign</option>
              {page.campaigns.map((c) => (
                <option key={`${c.instance_url}|${c.campaign_id}`} value={`${c.instance_url}|${c.campaign_id}`}>
                  {c.name ?? `Campaign ${c.campaign_id}`} ({c.instance_url}, {fmt(c.items)})
                </option>
              ))}
            </select>
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            <Button size="sm" variant="tinted" disabled={busy || !selected.size} onClick={() => decide("approved", [...selected])}>
              <Check /> Approve {selected.size ? fmt(selected.size) : ""} for removal
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !selected.size} onClick={() => decide("rejected", [...selected])}>
              <X /> Keep {selected.size ? fmt(selected.size) : ""}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !page.summary.pending}
              onClick={() => {
                if (window.confirm("Approve every pending item scored under 2 with no reply and no interest?")) decide("approved", "bulk");
              }}
            >
              Approve all under 2 with no replies
            </Button>
            {isAdmin && (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || !approvedIds.length || !page.gate_covers}
                title={page.gate_covers ? undefined : `The gate must cover ${tag} first, so a removed lead can't be pushed straight back`}
                onClick={queue}
              >
                Queue {fmt(approvedIds.length)} approved for removal
              </Button>
            )}
          </div>
          {isAdmin && !page.gate_covers && (
            <p className="mb-3 text-[12px] text-muted-foreground">Queueing removals waits until the fit gate covers {tag}.</p>
          )}

          {items.length === 0 ? (
            <p className="rounded-xl bg-muted/40 p-6 text-center text-[13px] text-muted-foreground">
              {page.build ? "No blocked company in these campaigns." : "No review list yet. Build it to see the blocked companies in this client's campaigns."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-[13px]">
                <thead className="text-[12px] text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="w-8 py-2" />
                    <th className="py-2 font-medium">Campaign</th>
                    <th className="py-2 font-medium">Company</th>
                    <th className="py-2 font-medium">Score</th>
                    <th className="py-2 text-right font-medium">Leads</th>
                    <th className="py-2 text-right font-medium">Sent</th>
                    <th className="py-2 text-right font-medium">Replied</th>
                    <th className="py-2 text-right font-medium">Interested</th>
                    <th className="py-2 text-right font-medium">Removable</th>
                    <th className="py-2 font-medium">Copy read</th>
                    <th className="py-2 font-medium">Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className="border-b border-border/40 align-top">
                      <td className="py-2">
                        <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Select ${i.company ?? i.key}`} />
                      </td>
                      <td className="py-2">
                        <div className="font-medium">{i.campaign_name ?? `Campaign ${i.campaign_id}`}</div>
                        <div className="text-[12px] text-muted-foreground">
                          {i.instance_url} · {i.campaign_status ?? "status unknown"} · {i.campaign_from === "push_history" ? "push history" : "live name"}
                        </div>
                      </td>
                      <td className="py-2">
                        <div className="font-medium">{i.company ?? i.key}</div>
                        <div className="text-[12px] text-muted-foreground">
                          {[i.domain, [i.city, i.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
                        </div>
                      </td>
                      <td className="max-w-[260px] py-2">
                        <span className={cn("font-semibold", (i.score ?? 0) < 2 && "text-destructive")}>{i.score ?? "not scorable"}</span>
                        {i.home_office && <span className="ml-1.5 rounded-full bg-muted px-2 py-0.5 text-[12px]">home office</span>}
                        {!i.still_blocked && <span className="ml-1.5 rounded-full bg-[var(--success)]/15 px-2 py-0.5 text-[12px] text-[var(--success)]">no longer blocked</span>}
                        {i.reason && <div className="text-[12px] text-muted-foreground">{i.reason}</div>}
                      </td>
                      <td className="py-2 text-right tabular-nums">{fmt(i.leads)}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(i.emails_sent)}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(i.replied)}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(i.interested)}</td>
                      <td className="py-2 text-right tabular-nums">{fmt(i.removable)}</td>
                      <td className="py-2 text-[12px] text-muted-foreground">{day(i.oldest_sync)}</td>
                      <td className="py-2">
                        <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-medium", DECISION[i.decision].cls)}>{DECISION[i.decision].label}</span>
                        {i.decided_by_name && (
                          <div className="mt-0.5 text-[12px] text-muted-foreground">
                            {i.decided_by_name}, {day(i.decided_at)}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page.next && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="outline" onClick={() => load(page.next ?? 0)}>
                Load more
              </Button>
            </div>
          )}

          <div className="mt-4 rounded-xl bg-muted/40 p-3 text-[12px]">
            <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
              <Terminal className="size-3.5" /> Removal, by a person
            </div>
            <p className="text-muted-foreground">
              Held for removal: {fmt(page.removals.held)}; removed {fmt(page.removals.done)}, skipped {fmt(page.removals.skipped)}, failed {fmt(page.removals.failed)}. A
              lead is removed only when Bison shows, read live, no reply and no interest in any campaign; anything it can&apos;t confirm is skipped.
            </p>
            <p className="mt-2 font-medium">1. The dry run (reads each lead live, marks nothing):</p>
            <code className="block break-all rounded-lg bg-card p-2">node scripts/bison-campaign-removal-worker.mjs --reason=fit --tag={tag} --lanes=1 --dry-run</code>
            <p className="mt-2 font-medium">2. The real run, within 24 hours, naming the dry run:</p>
            <code className="block break-all rounded-lg bg-card p-2">
              node scripts/bison-campaign-removal-worker.mjs --reason=fit --tag={tag} --lanes=1 --confirm={lastDry ? lastDry.id : "<dry run id>"}
            </code>
            {lastDry && (
              <p className="mt-2 text-muted-foreground">
                Last dry run, {day(lastDry.created_at)}: would remove {fmt(lastDry.would_remove)}, skip {fmt(lastDry.would_skip)}, cannot confirm {fmt(lastDry.cannot_confirm)} of{" "}
                {fmt(lastDry.rows)}.
              </p>
            )}
          </div>
        </>
      )}
      {!page && !error && (
        <div className="flex min-h-[120px] items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      )}
    </section>
  );
}
