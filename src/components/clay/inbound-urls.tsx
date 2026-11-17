"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ban, Check, CirclePause, Copy, Eye, EyeOff, Loader2, Plus, RotateCw, Search, Table2, Webhook, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { InboundClient, InboundList } from "@/app/api/enrich/inbound/route";
import type { MapsDelivery } from "@/app/api/enrich/table/route";

// The Clay tab's Inbound URLs (migration 129): each client's own address for
// the GMaps Scraper app's chunks. The sheet lists every client, Active first,
// with its URL masked (Eye shows it until the sheet closes, Copy copies it),
// Rotate and Revoke behind a confirm, when it was made, last delivered to and
// last tested, its last refusal (with "Accept this name" when a chunk's client
// name did not fit), the names accepted for it, and whether the client is
// switched on, with its held places. A client with no URL gets Create. The
// strip sits above a Companies (pipeline) table: the client's URL, its held
// places and why, and the newest Maps deliveries.

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;

type Action = "create" | "rotate" | "revoke" | "reveal" | "accept_name" | "drop_name";

/** One change on the management route; throws its error text. */
async function inboundAction(action: Action, tag: string, name?: string): Promise<Record<string, unknown>> {
  const res = await fetch("/api/enrich/inbound", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, tag, name }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof j.error === "string" ? j.error : "Could not change the inbound URL");
  return j;
}

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error("Could not copy: your browser refused. Use Eye and copy it by hand.");
  }
}

const HOW_IT_WORKS =
  "Put a client's URL on its card in the GMaps Scraper app, click Test there, then check here that the Test shows on this client's row. Then remove the client's Clay URLs from the card. Places arrive held and cost nothing until the client is switched on (Company pulls, in the Companies tab's settings).";

/** The worker's state, as a warning about held places, or null when all is well. */
function workerWarning(worker: InboundList["worker"]): string | null {
  if (!worker) return "No enrichment worker has run yet, so held places stay held even for clients switched on.";
  if (!worker.releases) return "The worker running now does not release held places (it predates inbound URLs). They stay held until the new worker is deployed.";
  if (!worker.online) return "The worker is offline, so held places of clients switched on wait for it.";
  return null;
}

// ── The sheet ───────────────────────────────────────────────────────────────

export function InboundUrlsSheet({ open, onOpenChange, onChanged }: { open: boolean; onOpenChange: (open: boolean) => void; onChanged?: () => void }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-2xl">
        <SheetHeader className="pb-0">
          <SheetTitle className="flex items-center gap-2">
            <Webhook className="size-4 text-primary" /> Inbound URLs
          </SheetTitle>
          <SheetDescription>Each client&apos;s own address for the GMaps Scraper app&apos;s Google Maps places, into its Companies (pipeline) table.</SheetDescription>
        </SheetHeader>
        {/* Mounted only while open: a URL shown with Eye is forgotten when the sheet closes. */}
        {open && <InboundUrlsBody onChanged={onChanged} />}
      </SheetContent>
    </Sheet>
  );
}

function InboundUrlsBody({ onChanged }: { onChanged?: () => void }) {
  const [list, setList] = useState<InboundList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/enrich/inbound")
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "Could not load the inbound URLs");
        setList(j);
        setLoadError(null);
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : "Could not load the inbound URLs"));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const clients = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = list?.clients ?? [];
    return term ? all.filter((c) => c.tag.toLowerCase().includes(term) || (c.name ?? "").toLowerCase().includes(term)) : all;
  }, [list, q]);
  const withUrl = (list?.clients ?? []).filter((c) => c.url).length;
  const warning = list ? workerWarning(list.worker) : null;

  const run = async (c: InboundClient, action: Action, name?: string) => {
    setBusy(`${c.tag}:${action}`);
    try {
      const j = await inboundAction(action, c.tag, name);
      if (typeof j.url === "string") setShown((s) => ({ ...s, [c.tag]: j.url as string }));
      if (action === "create") {
        toast.success(`${c.tag}'s inbound URL is ready`, {
          description: typeof j.warning === "string" ? j.warning : "Copy it to the client's card in the GMaps Scraper app, click Test there, then check the Test shows here.",
        });
      } else if (action === "rotate") {
        toast.success(`${c.tag}'s inbound URL was replaced`, { description: "The old URL has stopped. Put the new one on the client's card in the GMaps Scraper app." });
      } else if (action === "revoke") {
        setShown((s) => {
          const next = { ...s };
          delete next[c.tag];
          return next;
        });
        toast.success(`${c.tag}'s inbound URL was revoked`);
      } else if (action === "accept_name") {
        toast.success(`"${name}" is accepted for ${c.tag}`, { description: "Its chunks are stored the next time the scraper app sends them." });
      } else if (action === "drop_name") {
        toast.success(`"${name}" is no longer accepted for ${c.tag}`);
      }
      if (action !== "reveal") {
        load();
        onChanged?.();
      }
      return j;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not change the inbound URL");
      return null;
    } finally {
      setBusy(null);
    }
  };

  const reveal = async (c: InboundClient) => shown[c.tag] ?? ((await run(c, "reveal"))?.url as string | undefined) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{HOW_IT_WORKS}</p>
      {list && !list.site && (
        <Note tone="warning">The site address (NEXT_PUBLIC_SITE_URL) is not set, so no URL can be made or shown.</Note>
      )}
      {warning && <Note tone="warning">{warning}</Note>}
      {loadError && (
        <Note tone="error">
          {loadError}{" "}
          <button type="button" className="font-semibold underline" onClick={load}>
            Try again
          </button>
        </Note>
      )}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client by tag or name" className="h-9 rounded-full pl-8 text-[13px]" />
        </div>
        {list && (
          <span className="shrink-0 text-[12px] text-muted-foreground">
            {fmt(list.clients.length)} clients, {fmt(withUrl)} with a URL
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {!list && !loadError && (
          <div className="flex min-h-[200px] items-center justify-center text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
        {list && clients.length === 0 && <p className="p-6 text-center text-[13px] text-muted-foreground">No client matches.</p>}
        {clients.map((c) => (
          <ClientCard
            key={c.tag}
            c={c}
            site={list?.site ?? false}
            url={shown[c.tag] ?? null}
            busy={busy?.startsWith(`${c.tag}:`) ? busy.slice(c.tag.length + 1) : null}
            onHide={() =>
              setShown((s) => {
                const next = { ...s };
                delete next[c.tag];
                return next;
              })
            }
            onReveal={() => reveal(c)}
            onRun={(action, name) => run(c, action, name)}
          />
        ))}
      </div>
    </div>
  );
}

function Note({ tone, children }: { tone: "warning" | "error" | "info"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-relaxed",
        tone === "warning" && "bg-[var(--warning)]/12",
        tone === "error" && "bg-destructive/10 text-destructive",
        tone === "info" && "bg-muted text-muted-foreground"
      )}
    >
      {tone !== "info" && <AlertTriangle className={cn("mt-0.5 size-3.5 shrink-0", tone === "warning" ? "text-[var(--warning)]" : "text-destructive")} />}
      <div>{children}</div>
    </div>
  );
}

/** "Switched on" or "Switched off: places wait, held", with the held count. */
function SwitchState({ c }: { c: InboundClient }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge variant={c.switched_on ? "success" : "secondary"}>{c.switched_on ? "Switched on" : "Switched off: places wait, held"}</Badge>
      {c.held > 0 && (
        <Badge variant="outline" className="gap-1">
          <CirclePause className="size-3" /> {fmt(c.held)} held
        </Badge>
      )}
    </span>
  );
}

function ClientCard({
  c,
  site,
  url,
  busy,
  onHide,
  onReveal,
  onRun,
}: {
  c: InboundClient;
  site: boolean;
  url: string | null;
  busy: string | null;
  onHide: () => void;
  onReveal: () => Promise<string | null>;
  onRun: (action: Action, name?: string) => Promise<unknown>;
}) {
  const u = c.url;
  const nameRefused = !!u?.refused_name && !u.refused_fits_now;
  return (
    <div className="space-y-2 rounded-2xl bg-muted/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-semibold">{c.tag}</span>
        {c.name && <span className="truncate text-[13px]">{c.name}</span>}
        {c.status && <span className="text-[12px] text-muted-foreground">{c.status}</span>}
        {!c.listed && <Badge variant="warning">Not in the client list any more</Badge>}
        <span className="ml-auto">
          <SwitchState c={c} />
        </span>
      </div>

      {u ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-card px-2 py-1.5 text-[12px]" title={url ?? undefined}>
              {url ?? u.masked}
            </code>
            {url ? (
              <Button size="icon-xs" variant="outline" aria-label="Hide the URL" title="Hide the URL" onClick={onHide}>
                <EyeOff />
              </Button>
            ) : (
              <Button size="icon-xs" variant="outline" aria-label="Show the URL" title="Show the URL" disabled={!site || busy === "reveal"} onClick={onReveal}>
                {busy === "reveal" ? <Loader2 className="animate-spin" /> : <Eye />}
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="outline"
              aria-label="Copy the URL"
              title="Copy the URL"
              disabled={!site || busy === "reveal"}
              onClick={async () => {
                const full = await onReveal();
                if (full) await copyText(full, `${c.tag}'s inbound URL`);
              }}
            >
              <Copy />
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!site || !!busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Rotate ${c.tag}'s inbound URL? The old URL stops at once: the scraper app disables it, and the client's chunks wait there until the new URL is on its card.`
                  )
                ) {
                  void onRun("rotate");
                }
              }}
            >
              {busy === "rotate" ? <Loader2 className="animate-spin" /> : <RotateCw />} Rotate
            </Button>
            <Button
              size="xs"
              variant="outline"
              className="text-destructive"
              disabled={!!busy}
              onClick={() => {
                if (
                  window.confirm(
                    `Revoke ${c.tag}'s inbound URL? It stops at once: the scraper app disables it, and the client's chunks wait there until a new URL is on its card.`
                  )
                ) {
                  void onRun("revoke");
                }
              }}
            >
              {busy === "revoke" ? <Loader2 className="animate-spin" /> : <Ban />} Revoke
            </Button>
          </div>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px]">
            <dt className="text-muted-foreground">Made</dt>
            <dd>{when(u.created_at)}</dd>
            <dt className="text-muted-foreground">Last delivery</dt>
            <dd>{when(u.last_used_at) ?? "None yet"}</dd>
            <dt className="text-muted-foreground">Last Test</dt>
            <dd>
              {u.last_test_at ? (
                <>
                  {when(u.last_test_at)}
                  {u.last_test_name ? (
                    <span className={cn("ml-1", u.last_test_fits ? "text-[var(--success)]" : "text-destructive")}>
                      ({u.last_test_name}: {u.last_test_fits ? "fits" : "does not fit this URL"})
                    </span>
                  ) : (
                    <span className="ml-1 text-muted-foreground">(no client name sent)</span>
                  )}
                </>
              ) : (
                "None yet"
              )}
            </dd>
            {u.last_refused_at && (
              <>
                <dt className="text-muted-foreground">Last refused</dt>
                <dd>
                  {when(u.last_refused_at)}: {u.last_refused}
                </dd>
              </>
            )}
          </dl>

          {u.refused_name && (
            <div className="flex flex-wrap items-center gap-2 text-[12px]">
              <span className="text-muted-foreground">Refused name:</span>
              <span className="font-medium">{u.refused_name}</span>
              {nameRefused ? (
                <Button
                  size="xs"
                  variant="tinted"
                  disabled={!!busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Accept "${u.refused_name}" for ${c.tag}'s inbound URL? Chunks with this client name are then stored in ${c.tag}'s Companies table. Accept it only if the scraper app's client "${u.refused_name}" really is ${c.tag}.`
                      )
                    ) {
                      void onRun("accept_name", u.refused_name!);
                    }
                  }}
                >
                  {busy === "accept_name" ? <Loader2 className="animate-spin" /> : <Check />} Accept this name
                </Button>
              ) : (
                <span className="text-[var(--success)]">accepted since</span>
              )}
            </div>
          )}

          {u.accepted_names.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="text-muted-foreground">Accepted names:</span>
              {u.accepted_names.map((n) => (
                <span key={n} className="flex items-center gap-1 rounded-full bg-card py-0.5 pl-2.5 pr-1 font-medium shadow-ios">
                  {n}
                  <button
                    type="button"
                    aria-label={`Stop accepting ${n}`}
                    disabled={!!busy}
                    className="rounded-full p-0.5 hover:bg-muted disabled:opacity-40"
                    onClick={() => {
                      if (window.confirm(`Stop accepting "${n}" for ${c.tag}'s inbound URL? Its chunks will wait in the scraper app again.`)) void onRun("drop_name", n);
                    }}
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-muted-foreground">No inbound URL.</span>
          <Button
            size="xs"
            variant="tinted"
            disabled={!site || !!busy || !c.listed}
            title={!c.listed ? "This tag is no longer in the client list" : undefined}
            onClick={() => {
              if (
                window.confirm(
                  `Create an inbound URL for ${c.tag}? This also makes its three pipeline tables on the Clay tab, at no cost. Its places will arrive held and wait until ${c.tag} is switched on.`
                )
              ) {
                void onRun("create");
              }
            }}
          >
            {busy === "create" ? <Loader2 className="animate-spin" /> : <Plus />} Create
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {!c.has_rules && (
          <span className="flex items-center gap-1 text-[var(--warning)]">
            <AlertTriangle className="size-3" /> No targeting rules: its places stop at the area check until it has some.
          </span>
        )}
        {c.table_id && (
          <Link href={`/leads/clay?t=${c.table_id}`} className="ml-auto flex items-center gap-1 font-medium text-primary hover:opacity-80">
            <Table2 className="size-3" /> Companies (pipeline) table
          </Link>
        )}
      </div>
    </div>
  );
}

// ── The strip above a Companies (pipeline) table ────────────────────────────

/**
 * The client's inbound URL (masked, Eye, Copy), its held places and why, and
 * the table's newest Google Maps deliveries. `held` and `deliveries` come with
 * the table's detail, so they follow its live updates; the URL is read again
 * when `refreshKey` changes (a change in the Inbound URLs sheet).
 */
export function InboundStrip({
  tag,
  held,
  deliveries,
  refreshKey,
  onOpenUrls,
}: {
  tag: string;
  held: number;
  deliveries: MapsDelivery[];
  refreshKey: number;
  onOpenUrls: () => void;
}) {
  const [client, setClient] = useState<InboundClient | null>(null);
  const [site, setSite] = useState(false);
  const [releases, setReleases] = useState(true);
  const [url, setUrl] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/enrich/inbound?tag=${encodeURIComponent(tag)}`)
      .then(async (r) => {
        const j = (await r.json()) as InboundList & { error?: string };
        if (!r.ok) throw new Error(j.error);
        if (!live) return;
        setClient(j.clients.find((c) => c.tag === tag) ?? null);
        setUrl(null); // a URL shown before may have been rotated since
        setSite(j.site);
        setReleases(j.worker?.releases === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tag, refreshKey]);

  const reveal = async () => {
    if (url) return url;
    setRevealing(true);
    try {
      const j = await inboundAction("reveal", tag);
      const full = typeof j.url === "string" ? j.url : null;
      setUrl(full);
      return full;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not show the URL");
      return null;
    } finally {
      setRevealing(false);
    }
  };

  const u = client?.url ?? null;
  const switchedOn = client?.switched_on === true;
  const why = !held
    ? null
    : !switchedOn
      ? `${fmt(held)} Google Maps place${held === 1 ? "" : "s"} held: ${tag} is switched off (Company pulls, in the Companies tab's settings). Nothing runs or is spent on them until it is switched on.`
      : releases
        ? `${fmt(held)} Google Maps place${held === 1 ? "" : "s"} held: ${tag} is switched on, so the worker starts them within a minute.`
        : `${fmt(held)} Google Maps place${held === 1 ? "" : "s"} held: ${tag} is switched on, but the worker running now does not release held places yet.`;

  return (
    <div className="space-y-2 rounded-2xl bg-card px-4 py-2.5 shadow-ios">
      <div className="flex flex-wrap items-center gap-2">
        <Webhook className="size-4 text-primary" />
        <span className="text-[13px] font-semibold">Inbound URL</span>
        {u ? (
          <>
            <code className="min-w-0 max-w-[460px] truncate rounded-lg bg-muted px-2 py-1 text-[12px]">{url ?? u.masked}</code>
            {url ? (
              <Button size="icon-xs" variant="outline" aria-label="Hide the URL" title="Hide the URL" onClick={() => setUrl(null)}>
                <EyeOff />
              </Button>
            ) : (
              <Button size="icon-xs" variant="outline" aria-label="Show the URL" title="Show the URL" disabled={!site || revealing} onClick={reveal}>
                {revealing ? <Loader2 className="animate-spin" /> : <Eye />}
              </Button>
            )}
            <Button
              size="icon-xs"
              variant="outline"
              aria-label="Copy the URL"
              title="Copy the URL"
              disabled={!site || revealing}
              onClick={async () => {
                const full = await reveal();
                if (full) await copyText(full, `${tag}'s inbound URL`);
              }}
            >
              <Copy />
            </Button>
            <span className="text-[12px] text-muted-foreground">Last delivery {when(u.last_used_at) ?? "none yet"}</span>
          </>
        ) : (
          <span className="text-[12.5px] text-muted-foreground">{client ? "None yet: create one in Inbound URLs." : "Loading…"}</span>
        )}
        <Button size="xs" variant="outline" className="ml-auto" onClick={onOpenUrls}>
          Inbound URLs
        </Button>
      </div>
      {why && (
        <p className="flex items-start gap-1.5 text-[12.5px] leading-relaxed text-muted-foreground">
          <CirclePause className="mt-0.5 size-3.5 shrink-0" /> {why}
        </p>
      )}
      {deliveries.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer select-none font-medium text-muted-foreground">Recent deliveries ({fmt(deliveries.length)})</summary>
          <table className="mt-1.5 w-full text-left tabular-nums">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-0.5 pr-3 font-medium">When</th>
                <th className="py-0.5 pr-3 font-medium">Search</th>
                <th className="py-0.5 pr-3 font-medium">Received</th>
                <th className="py-0.5 pr-3 font-medium">New</th>
                <th className="py-0.5 pr-3 font-medium">Already there</th>
                <th className="py-0.5 font-medium">Skipped</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} className="border-t border-border/50">
                  <td className="py-0.5 pr-3">{when(d.created_at)}</td>
                  <td className="max-w-[280px] truncate py-0.5 pr-3">{d.label ?? "Google Maps"}</td>
                  <td className="py-0.5 pr-3">{fmt(d.received)}</td>
                  <td className="py-0.5 pr-3">{fmt(d.created)}</td>
                  <td className="py-0.5 pr-3">{fmt(d.duplicates)}</td>
                  <td className="py-0.5">{fmt(d.skipped)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}
