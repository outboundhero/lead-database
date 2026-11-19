import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { ensureClientTables, isTablesRefusal } from "@/lib/enrich/gmaps";
import { ACCEPTED_NAMES_MAX, checkName, inboundUrl, makeToken, maskedInboundUrl, normName, siteOrigin } from "@/lib/enrich/inbound";
import { workerState } from "@/lib/enrich/queries";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";

// The Clay tab's Inbound URLs (migration 129): each client's own address for
// the GMaps Scraper app's chunks, POST /api/enrich/intake/<token>.
//
// GET  ?tag=  every client in client_tags, Active first (or the one asked
//      for), each with its live URL masked, when it was made, last used and
//      last tested, its last refusal, the scraper app names accepted for it,
//      whether the client is on the Company pulls switch, and how many of its
//      places are held. A URL whose tag the sheet sync has removed is listed
//      too, so it can still be revoked. Also: whether the site address is set
//      (no full URL can be shown without it) and whether the worker releases
//      held places (held_release).
// POST { action, tag, name? }
//      create       makes the client's three pipeline tables (as a first pull
//                   does) and its URL. 409 when it has one already, or when
//                   the tables can't be made.
//      rotate       revokes the live URL and makes a new one with the same
//                   accepted names, in one transaction. The old URL answers
//                   404 at once.
//      revoke       the live URL answers 404 from now on.
//      reveal       the full URL of the live one.
//      accept_name  a scraper app name the URL takes besides its tag (at most 20).
//      drop_name    takes one back.
// The full URL is NEXT_PUBLIC_SITE_URL, the path and the token, never the
// request's origin; without the site address create, rotate and reveal are
// refused (409). Tokens are made here only. Manager and up. Each change
// writes one audit line naming the tag, never a token or a URL.

export const dynamic = "force-dynamic";

/** One client's live inbound URL, as the Clay tab shows it: never the token. */
export interface InboundUrlView {
  /** The site address, the path and the token's first 6 characters, then "…". */
  masked: string;
  created_at: string;
  /** The last stored delivery (written at most once a minute). */
  last_used_at: string | null;
  last_test_at: string | null;
  /** The client name the scraper app's Test sent, if any (it sends none today). */
  last_test_name: string | null;
  /** Whether that name fits the URL; null when the Test sent none. */
  last_test_fits: boolean | null;
  last_refused_at: string | null;
  /** Why, in plain words. */
  last_refused: string | null;
  /** The client name of the last chunk refused for its name. */
  refused_name: string | null;
  /** That name fits now (it was accepted since). */
  refused_fits_now: boolean;
  accepted_names: string[];
}

export interface InboundClient {
  tag: string;
  name: string | null;
  status: string | null;
  /** In client_tags; false for a live URL whose tag the sheet sync removed. */
  listed: boolean;
  url: InboundUrlView | null;
  /** The client's Companies (pipeline) table, where its places land. */
  table_id: string | null;
  /** Places waiting in that table until the client is switched on. */
  held: number;
  /** On the Company pulls switch (fn_enrich_company_switch_on): its held places are released. */
  switched_on: boolean;
  /** Has targeting rules: without them its places stop at the area check. */
  has_rules: boolean;
}

export interface InboundList {
  clients: InboundClient[];
  /** NEXT_PUBLIC_SITE_URL is set, so full URLs can be shown. */
  site: boolean;
  /** The worker's last heartbeat, and whether it releases held places. Null when no worker has run. */
  worker: { online: boolean; releases: boolean } | null;
}

const ACTIONS = ["create", "rotate", "revoke", "reveal", "accept_name", "drop_name"] as const;
type Action = (typeof ACTIONS)[number];
const NO_SITE = "The site address (NEXT_PUBLIC_SITE_URL) is not set, so no inbound URL can be shown. Nothing was changed.";
const LIVE = `client_tag = $1 AND target = 'companies' AND revoked_at IS NULL`;

type Row = {
  tag: string;
  name: string | null;
  status: string | null;
  listed: boolean;
  token: string | null;
  created_at: string | null;
  last_used_at: string | null;
  last_test_at: string | null;
  last_test_name: string | null;
  last_refused_at: string | null;
  last_refused: string | null;
  refused_name: string | null;
  accepted_names: string[] | null;
  table_id: string | null;
  held: number;
  switched_on: boolean;
  has_rules: boolean;
};

function view(r: Row): InboundClient {
  const accepted = r.accepted_names ?? [];
  return {
    tag: r.tag,
    name: r.name,
    status: r.status,
    listed: r.listed,
    url: r.token
      ? {
          masked: maskedInboundUrl(r.token),
          created_at: r.created_at!,
          last_used_at: r.last_used_at,
          last_test_at: r.last_test_at,
          last_test_name: r.last_test_name,
          last_test_fits: r.last_test_name ? checkName(r.last_test_name, r.tag, accepted).ok : null,
          last_refused_at: r.last_refused_at,
          last_refused: r.last_refused,
          refused_name: r.refused_name,
          refused_fits_now: r.refused_name ? checkName(r.refused_name, r.tag, accepted).ok : false,
          accepted_names: accepted,
        }
      : null,
    table_id: r.table_id,
    held: r.held,
    switched_on: r.switched_on === true,
    has_rules: r.has_rules === true,
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const asked = req.nextUrl.searchParams.get("tag");
  const only = asked === null ? null : cleanTag(asked);
  if (only !== null && !TAG_RE.test(only)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx<InboundList>(
      async (c) => {
        const { rows } = await c.query<Row>(
          `WITH tags AS (
             SELECT ct.tag, ct.name, ct.status, true AS listed FROM client_tags ct
              WHERE $1::text IS NULL OR ct.tag = $1
             UNION ALL
             SELECT DISTINCT u.client_tag, NULL, NULL, false FROM enrich_inbound_urls u
              WHERE u.revoked_at IS NULL AND ($1::text IS NULL OR u.client_tag = $1)
                AND NOT EXISTS (SELECT 1 FROM client_tags ct WHERE ct.tag = u.client_tag)
           )
           SELECT t.tag, t.name, t.status, t.listed,
                  u.token, u.created_at, u.last_used_at, u.last_test_at, u.last_test_name,
                  u.last_refused_at, u.last_refused, u.refused_name, u.accepted_names,
                  p.id AS table_id,
                  CASE WHEN p.id IS NULL THEN 0
                       ELSE (SELECT count(*)::int FROM enrich_rows r WHERE r.table_id = p.id AND r.run_status = 'held') END AS held,
                  public.fn_enrich_company_switch_on(t.tag) AS switched_on,
                  EXISTS (SELECT 1 FROM client_targeting g WHERE g.client_tag = t.tag) AS has_rules
             FROM tags t
             LEFT JOIN enrich_inbound_urls u ON u.client_tag = t.tag AND u.target = 'companies' AND u.revoked_at IS NULL
             LEFT JOIN enrich_tables p ON p.client_tag = t.tag AND p.kind = 'companies' AND p.template = 'companies_v2'
            ORDER BY t.status = 'Active' DESC NULLS LAST, u.id IS NULL, t.tag`,
          [only]
        );
        const worker = await workerState(c);
        const caps = worker?.info?.capabilities;
        return {
          clients: rows.map(view),
          site: siteOrigin() !== null,
          worker: worker ? { online: worker.online, releases: Array.isArray(caps) && caps.includes("held_release") } : null,
        };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("enrich/inbound GET:", err);
    return NextResponse.json({ error: "Could not load the inbound URLs" }, { status: 500 });
  }
}

type Done = { status: number; error?: string; body?: Record<string, unknown>; audit?: string };

async function liveUrl(c: PoolClient, tag: string) {
  const { rows } = await c.query<{ id: string; token: string; accepted_names: string[] }>(
    `SELECT id, token, accepted_names FROM enrich_inbound_urls WHERE ${LIVE} FOR UPDATE`,
    [tag]
  );
  return rows[0] ?? null;
}

async function act(c: PoolClient, action: Action, tag: string, rawName: unknown, actor: string): Promise<Done> {
  switch (action) {
    case "create": {
      const { rows: [client] } = await c.query(`SELECT tag FROM client_tags WHERE tag = $1`, [tag]);
      if (!client) return { status: 404, error: `${tag} is not in the client list.` };
      if (await liveUrl(c, tag)) return { status: 409, error: `${tag} already has an inbound URL. Rotate it to get a new one.` };
      // The client's tables first, as a first pull makes them (free: no provider is called).
      const tables = await ensureClientTables(c, tag);
      const token = makeToken();
      await c.query(`INSERT INTO enrich_inbound_urls (client_tag, target, token, created_by) VALUES ($1, 'companies', $2, $3)`, [tag, token, actor]);
      const { rows: [rules] } = await c.query<{ has: boolean }>(`SELECT EXISTS (SELECT 1 FROM client_targeting WHERE client_tag = $1) AS has`, [tag]);
      return {
        status: 201,
        body: {
          tag,
          url: inboundUrl(token),
          masked: maskedInboundUrl(token),
          table_id: tables.companies,
          warning: rules?.has ? null : `${tag} has no targeting rules, so its places will stop at the area check until it has some.`,
        },
        audit: `Inbound URL created for ${tag}`,
      };
    }
    case "rotate": {
      const old = await liveUrl(c, tag);
      if (!old) return { status: 404, error: `${tag} has no inbound URL to rotate.` };
      await c.query(`UPDATE enrich_inbound_urls SET revoked_at = now(), revoked_by = $2 WHERE id = $1`, [old.id, actor]);
      const token = makeToken();
      const { rows: [fresh] } = await c.query<{ id: string }>(
        `INSERT INTO enrich_inbound_urls (client_tag, target, token, accepted_names, created_by) VALUES ($1, 'companies', $2, $3, $4) RETURNING id`,
        [tag, token, old.accepted_names ?? [], actor]
      );
      await c.query(`UPDATE enrich_inbound_urls SET replaced_by = $2 WHERE id = $1`, [old.id, fresh.id]);
      return { status: 200, body: { tag, url: inboundUrl(token), masked: maskedInboundUrl(token) }, audit: `Inbound URL rotated for ${tag}` };
    }
    case "revoke": {
      const { rowCount } = await c.query(`UPDATE enrich_inbound_urls SET revoked_at = now(), revoked_by = $2 WHERE ${LIVE}`, [tag, actor]);
      if (!rowCount) return { status: 404, error: `${tag} has no inbound URL to revoke.` };
      return { status: 200, body: { tag, revoked: true }, audit: `Inbound URL revoked for ${tag}` };
    }
    case "reveal": {
      const live = await liveUrl(c, tag);
      if (!live) return { status: 404, error: `${tag} has no inbound URL.` };
      const url = inboundUrl(live.token);
      if (!url) return { status: 409, error: NO_SITE };
      return { status: 200, body: { tag, url } };
    }
    case "accept_name":
    case "drop_name": {
      const name = normName(rawName);
      if (!name) return { status: 400, error: "name is required" };
      const live = await liveUrl(c, tag);
      if (!live) return { status: 404, error: `${tag} has no inbound URL.` };
      const names = live.accepted_names ?? [];
      if (action === "accept_name") {
        if (names.includes(name)) return { status: 200, body: { tag, accepted_names: names } };
        if (names.length >= ACCEPTED_NAMES_MAX) {
          return { status: 409, error: `At most ${ACCEPTED_NAMES_MAX} names can be accepted for one URL. Remove one first.` };
        }
        const { rows: [u] } = await c.query<{ accepted_names: string[] }>(
          `UPDATE enrich_inbound_urls SET accepted_names = array_append(accepted_names, $2) WHERE id = $1 RETURNING accepted_names`,
          [live.id, name]
        );
        return { status: 200, body: { tag, accepted_names: u.accepted_names }, audit: `Scraper app name "${name}" accepted for ${tag}'s inbound URL` };
      }
      if (!names.includes(name)) return { status: 404, error: "That name is not accepted for this URL." };
      const { rows: [u] } = await c.query<{ accepted_names: string[] }>(
        `UPDATE enrich_inbound_urls SET accepted_names = array_remove(accepted_names, $2) WHERE id = $1 RETURNING accepted_names`,
        [live.id, name]
      );
      return { status: 200, body: { tag, accepted_names: u.accepted_names }, audit: `Scraper app name "${name}" no longer accepted for ${tag}'s inbound URL` };
    }
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const action = (ACTIONS as readonly unknown[]).includes(body?.action) ? (body.action as Action) : null;
  if (!action) return NextResponse.json({ error: `action must be one of ${ACTIONS.join(", ")}` }, { status: 400 });
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  if ((action === "create" || action === "rotate" || action === "reveal") && !siteOrigin()) {
    return NextResponse.json({ error: NO_SITE }, { status: 409 });
  }
  try {
    const out = await withTx((c) => act(c, action, tag, body.name, auth.user.id), { timeoutMs: 20_000 });
    if (out.error) return NextResponse.json({ error: out.error }, { status: out.status });
    if (out.audit) await logAudit({ action: "enrich_inbound_url", performedBy: auth.user.id, details: out.audit });
    return NextResponse.json(out.body ?? {}, { status: out.status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (isTablesRefusal(err)) {
      const error = err.name === "OriginalsMissing" ? "The Clay originals are not loaded, so the client's tables can't be made. Nothing was changed." : err.message;
      return NextResponse.json({ error }, { status: 409 });
    }
    const e = err as { code?: string; constraint?: string };
    if (e?.code === "23505" && e.constraint === "enrich_inbound_urls_live_uniq") {
      return NextResponse.json({ error: `${tag} already has an inbound URL. Rotate it to get a new one.` }, { status: 409 });
    }
    console.error("enrich/inbound POST:", action, tag, e?.code ?? "", err instanceof Error ? err.message : "");
    return NextResponse.json({ error: "Could not change the inbound URL" }, { status: 500 });
  }
}
