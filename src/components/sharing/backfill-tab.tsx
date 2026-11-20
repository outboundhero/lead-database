"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, RefreshCw, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { fmtCount, when } from "@/lib/sharing/labels";
import type { BackfillClient, BackfillPreview, BackfillRun, BackfillView } from "@/lib/sharing/types";

// The Sharing page's "Backfill" tab: the database backfill (migration 138).
// Each hourly firing of the backfill-worker finds leads already in the
// database that fit a listed client and were never sent, shared or tagged for
// it, and queues them as shares (one share job a firing, on the Jobs tab, where
// an admin can undo it). This tab shows the switch and the caps in force, each
// listed client with its places and how far each place's pass has read, its
// shares today against the day cap and its backfill shares by push state, a
// Preview per client (read only: what the next firing would do), and the
// newest runs. Managers view it; the settings sheet (Companies tab) edits it.

const REASON_WORDS: Record<string, string> = {
  filtered_inbox: "general inbox on the Clay filter",
  already_sent: "already sent",
  in_flight: "being pushed",
  already_shared: "offered before",
  other_pool: "another pool's lead",
  untagged_off: "untagged (off)",
  same_install: "same sending setup",
};
const CAP_WORDS: Record<string, string> = {
  run: "the client's cap a firing",
  day: "the client's cap a day",
  run_total: "the firing's cap",
  time: "the time limit",
};
const STATE_WORDS: Record<string, string> = { running: "Running", done: "Done", stopped: "Stopped", error: "Error" };
const STOP_WORDS: Record<string, string> = { time: "time limit", run_cap: "the firing's cap", switched_off: "switched off" };
const PASS_WORDS: Record<string, string> = {
  new: "first look",
  continue: "carries on",
  rules: "new pass (rules changed)",
  recheck: "new pass (read again)",
  done: "done, read again later",
};

function Pill({ tone = "plain", children, title }: { tone?: "plain" | "warn" | "good" | "bad"; children: React.ReactNode; title?: string }) {
  const cls = {
    plain: "bg-muted text-foreground",
    warn: "bg-[var(--warning)]/15 text-[var(--warning)]",
    good: "bg-[var(--success)]/15 text-[var(--success)]",
    bad: "bg-destructive/12 text-destructive",
  }[tone];
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[12px] font-medium", cls)}>
      {children}
    </span>
  );
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function reasonLine(counts: Record<string, unknown>): string {
  return Object.keys(REASON_WORDS)
    .filter((k) => num(counts[k]) > 0)
    .map((k) => `${fmtCount(num(counts[k]))} ${REASON_WORDS[k]}`)
    .join(" · ");
}

function PreviewPanel({ p, onClose }: { p: BackfillPreview; onClose: () => void }) {
  const counts = p.counts ?? {};
  return (
    <div className="space-y-2 rounded-xl bg-muted/50 p-3 text-[12.5px]">
      <div className="flex items-start gap-2">
        <p className="flex-1 font-medium">
          Preview of {p.tag}: what the next {p.mode === "apply" ? "" : "apply "}firing would do (read only, nothing written)
        </p>
        <Button size="icon-xs" variant="ghost" onClick={onClose} aria-label="Close the preview">
          <X />
        </Button>
      </div>
      {p.skip ? (
        <p className="text-destructive">It would be skipped: {p.skip}.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {fmtCount(num(counts.would_share))} lead{num(counts.would_share) === 1 ? "" : "s"} would be shared ({fmtCount(num(counts.checked))} checked,{" "}
            {fmtCount(num(counts.fits))} fit its rules) · already shared to it today {fmtCount(p.today ?? 0)} of {fmtCount(p.caps?.perClientDay ?? 0)}
            {p.capped ? ` · stopped by ${CAP_WORDS[p.capped] ?? p.capped}` : ""}
            {p.pushList === false ? " · not on the push list: an apply firing skips it until it is" : ""}
            {p.onList === false ? " · not on the backfill list" : ""}
          </p>
          {reasonLine(counts) && <p className="text-muted-foreground">Not shared: {reasonLine(counts)}</p>}
          <div className="divide-y divide-border/50 rounded-lg bg-card">
            {(p.places ?? []).map((pl) => (
              <div key={pl.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-36 font-medium">{pl.label}</span>
                {pl.low && <Pill tone="warn">low</Pill>}
                <span className="text-muted-foreground">{PASS_WORDS[pl.pass] ?? pl.pass}</span>
                {pl.pass !== "done" ? (
                  <span className="text-muted-foreground">
                    {pl.windowsRead} window{pl.windowsRead === 1 ? "" : "s"} read
                    {pl.windows ? ` from ${(pl.nextWindow ?? 0) + 1} of ${pl.windows}` : ""} · {fmtCount(pl.checked)} checked · {fmtCount(pl.fits)} fit ·{" "}
                    <span className="font-medium text-foreground">{fmtCount(pl.shares)} would be shared</span>
                    {reasonLine(pl.reasons) ? ` · ${reasonLine(pl.reasons)}` : ""}
                    {pl.capped ? ` · stopped by ${CAP_WORDS[pl.capped] ?? pl.capped}` : ""}
                  </span>
                ) : (
                  <span className="text-muted-foreground">pass done {when(pl.passDoneAt)}</span>
                )}
              </div>
            ))}
          </div>
          {(p.unresolved ?? []).length > 0 && (
            <p className="text-muted-foreground">Never read (the geo reference does not know them): {(p.unresolved ?? []).join(", ")}</p>
          )}
        </>
      )}
    </div>
  );
}

function ClientRow({ c, perDay }: { c: BackfillClient; perDay: number }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<BackfillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`/api/sharing/backfill?preview=${encodeURIComponent(c.tag)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not preview the backfill");
      setPreview(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not preview the backfill");
    } finally {
      setBusy(false);
    }
  };
  const shares = Object.entries(c.backfillShares)
    .map(([k, n]) => `${fmtCount(n)} ${k === "none" ? "not queued" : k}`)
    .join(" · ");
  return (
    <div className="border-b last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-[13px]">
        <button type="button" className="flex min-w-36 items-center gap-1 font-semibold" onClick={() => setOpen(!open)} disabled={!c.places.length}>
          {c.places.length ? open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" /> : <span className="w-3.5" />}
          {c.tag}
        </button>
        {!c.isClient ? (
          <Pill tone="bad">not a client</Pill>
        ) : (
          <>
            <Pill tone={c.pool ? "plain" : "bad"}>{c.pool ? `${c.pool} pool` : "isolated"}</Pill>
            <Pill tone={c.receiveBlock ? "bad" : "good"}>{c.receiveBlock ? `cannot receive: ${c.receiveBlock}` : "can receive"}</Pill>
            <Pill tone={c.onPushList ? "good" : "warn"} title="Overlap sharing's push list: an apply firing writes shares only for a client on it.">
              {c.onPushList ? "on the push list" : "not on the push list"}
            </Pill>
            {c.lowPlaces > 0 && <Pill tone="warn">{c.lowPlaces} low place{c.lowPlaces === 1 ? "" : "s"} (minimum {fmtCount(c.minimum)})</Pill>}
          </>
        )}
        <span className="text-[12px] text-muted-foreground">
          shared today {fmtCount(c.sharedToday)} of {fmtCount(perDay)}
          {shares ? ` · backfill shares: ${shares}` : ""}
        </span>
        {c.isClient && (
          <Button size="xs" variant="outline" className="ml-auto" onClick={runPreview} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Search />} Preview
          </Button>
        )}
      </div>
      {error && <p className="px-3 pb-2 text-[12.5px] text-destructive">{error}</p>}
      {preview && (
        <div className="px-3 pb-3">
          <PreviewPanel p={preview} onClose={() => setPreview(null)} />
        </div>
      )}
      {open && (
        <div className="space-y-1 px-9 pb-3 text-[12.5px]">
          {c.places.map((p) => (
            <p key={p.key} className="text-muted-foreground">
              <span className="font-medium text-foreground">{p.label}</span>
              {p.low ? " (low)" : ""} · {p.available == null ? "not in the stored coverage" : `${fmtCount(p.available)} available`} ·{" "}
              {p.windows == null
                ? "not read yet"
                : p.passDoneAt
                  ? `pass done ${when(p.passDoneAt)}, ${fmtCount(p.shared ?? 0)} shared in it`
                  : `${p.windowsRead} of ${p.windows} window${p.windows === 1 ? "" : "s"} read, ${fmtCount(p.shared ?? 0)} shared so far`}
            </p>
          ))}
          {c.unresolved.length > 0 && <p className="text-muted-foreground">Never read (the geo reference does not know them): {c.unresolved.join(", ")}</p>}
        </div>
      )}
    </div>
  );
}

function runLine(r: BackfillRun): string {
  const t = r.totals ?? {};
  const shared = r.mode === "apply" ? `${fmtCount(num(t.shared))} shared` : `${fmtCount(num(t.would_share))} would be shared`;
  return `${fmtCount(num(t.served))} client${num(t.served) === 1 ? "" : "s"} served · ${shared} · ${fmtCount(num(t.checked))} checked` +
    `${num(t.skipped) ? ` · ${fmtCount(num(t.skipped))} skipped` : ""}${num(t.errors) ? ` · ${fmtCount(num(t.errors))} failed` : ""}`;
}

export function BackfillTab() {
  const [data, setData] = useState<BackfillView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/sharing/backfill");
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Could not load the database backfill");
      setData(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the database backfill");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const sw = data?.switch;
  return (
    <div className="space-y-3">
      {data && !data.ready && (
        <p className="rounded-2xl bg-[var(--warning)]/12 p-4 text-[13px]">The database backfill is not set up in this database yet (migration 138).</p>
      )}
      {sw && !sw.enabled && (
        <p className="rounded-2xl bg-muted/60 p-4 text-[13px] leading-relaxed">
          <span className="font-semibold">The database backfill is off.</span> Nothing is read or shared. Each firing would find leads already in the
          database that fit a listed client (untagged, or of another client of its pool) and queue them for its Active or Draft campaigns, as shares.
          An admin switches it on, with its clients, in the Companies tab&apos;s settings; a client also needs overlap sharing&apos;s push list.
        </p>
      )}
      {sw?.enabled && (
        <p className="text-[12.5px] text-muted-foreground">
          On for {fmtCount(sw.tags.length)} client{sw.tags.length === 1 ? "" : "s"} · {sw.mode === "apply" ? "apply: shares are written and pushed" : "preview: each firing only counts"}
          {sw.untagged ? " · untagged leads too" : " · only leads of other clients of the pool"}
        </p>
      )}
      {sw && (
        <p className="text-[12.5px] text-muted-foreground">
          Caps: {fmtCount(sw.perClientFiring)} a client a firing and {fmtCount(sw.perClientDay)} a client a day (overlap sharing&apos;s, every source
          counted), {fmtCount(sw.perFiring)} a firing, {sw.maxMinutes} minutes a firing. A place is read again {sw.recheckDays} day
          {sw.recheckDays === 1 ? "" : "s"} after its last pass, or at once when the client&apos;s rules change.
        </p>
      )}
      {data?.warning && (
        <p className="flex gap-2 rounded-2xl bg-[var(--warning)]/12 p-4 text-[13px] leading-relaxed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
          {data.warning}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={load} aria-label="Reload" disabled={loading}>
          {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        </Button>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
      </div>

      {data?.ready && (
        <div className="overflow-hidden rounded-2xl bg-card shadow-ios">
          {data.clients.length === 0 ? (
            <p className="p-4 text-[13px] text-muted-foreground">No client is on the backfill list.</p>
          ) : (
            data.clients.map((c) => <ClientRow key={c.tag} c={c} perDay={sw?.perClientDay ?? 0} />)
          )}
        </div>
      )}

      {data?.ready && (
        <div className="space-y-1">
          <p className="text-[13px] font-semibold">Newest firings</p>
          {data.runs.length === 0 && <p className="text-[12.5px] text-muted-foreground">No firing yet.</p>}
          {data.runs.map((r) => (
            <p key={r.id} className="text-[12.5px] text-muted-foreground">
              <span className="font-medium text-foreground">{when(r.startedAt)}</span> · {r.mode} · {STATE_WORDS[r.state] ?? r.state}
              {r.stopReason ? ` (${STOP_WORDS[r.stopReason] ?? r.stopReason})` : ""} · {runLine(r)}
              {r.lastError ? ` · ${r.lastError}` : ""}
              {r.batchId && (
                <>
                  {" · "}
                  <Link href={`/leads/sharing?job=${encodeURIComponent(r.batchId)}`} className="text-primary hover:opacity-80">
                    its share job
                  </Link>
                </>
              )}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
