import { NextRequest, NextResponse } from "next/server";
import type { Pool } from "pg";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { clientPool, settingsFrom } from "../../../../scripts/lib/enrich/settings.mjs";

/** client_tags.churn_cell_state (migration 132): what the Groups tab churn cell says. */
export type ChurnCellState = "date" | "empty" | "non_answer" | "unreadable";

export interface ClientRow {
  tag: string;
  name: string | null;
  owner: string | null;
  status: string | null;
  churned: boolean;
  group_no: number | null;
  b2b_instance: string | null;
  b2c_instance: string | null;
  sendable: boolean;
  source: string | null;
  // stats (may be missing until the cache is refreshed)
  leads: number;
  categorized: number;
  bounced: number;
  contactable: number;
  personal: number;
  business: number;
  // The Groups tab at the last good read (migration 132). Null or false on a
  // database without 132 (receiveRule false in the answer).
  churn_date: string | null; // YYYY-MM-DD, set only when churn_cell_state is "date"
  churn_cell: string | null; // the cell as read, for display
  churn_cell_state: ChurnCellState | null; // null while the tab does not list the client
  on_groups_tab: boolean;
  groups_tab_read_at: string | null;
  /** Why the client cannot receive shared leads or top-up pulls (fn_client_receive_block); null when it can. */
  receive_block: string | null;
  /** Its sharing pool (clientPool, overlap_sharing settings); null = isolated. */
  pool: string | null;
  /** Low and unknown places in the latest finished top-up pass; null when no finished pass covers the client. */
  low_places: number | null;
  /** Leads shared to this client in the last 7 days (applied, not undone). */
  shared_7d: number;
}

export interface ClientsAnswer {
  clients: ClientRow[];
  refreshedAt: string | null;
  /** When the Groups tab was last read well; null before the first read. */
  groupsTabReadAt: string | null;
  /** Active or Healthy clients the Groups tab did not list at the last read: they cannot receive. */
  missingFromTab: string[];
  /** Migration 132 is in the database, so the churn and receive fields mean something. */
  receiveRule: boolean;
}

// The tables and the function the newer fields read, each optional, so the
// page works on a database without them (they only add fields).
const PRESENT_SQL = `SELECT to_regprocedure('public.fn_client_receive_block(text)') IS NOT NULL AS churn,
       to_regclass('public.enrich_settings') IS NOT NULL AS settings,
       to_regclass('public.topup_passes') IS NOT NULL AND to_regclass('public.topup_flags') IS NOT NULL AS topup,
       to_regclass('public.lead_shares') IS NOT NULL AS shares`;

// Low and unknown places per client in the latest finished top-up pass (135).
const LOW_PLACES_SQL = `WITH p AS (SELECT id FROM topup_passes WHERE state = 'done' ORDER BY finished_at DESC NULLS LAST LIMIT 1)
SELECT f.client_tag, count(*) FILTER (WHERE f.kind IN ('low', 'unresolved'))::int AS low_places
  FROM topup_flags f JOIN p ON p.id = f.pass_id GROUP BY 1`;

// Leads shared to each client in the last 7 days (134).
const SHARED_7D_SQL = `SELECT receiver_tag, count(*)::int AS shared_7d FROM lead_shares
 WHERE outcome = 'shared' AND applied_at > now() - interval '7 days' AND undone_at IS NULL GROUP BY 1`;

type TagRow = {
  tag: string; name: string | null; owner: string | null; status: string | null; group_no: number | null;
  b2b_instance: string | null; b2c_instance: string | null; source: string | null; client_type: string | null;
  active: boolean; churn_date: string | null; churn_cell: string | null; churn_cell_state: ChurnCellState | null;
  on_groups_tab: boolean | null; groups_tab_read_at: Date | null; receive_block: string | null;
};
type StatRow = {
  tag: string; leads: number; categorized: number; bounced: number; contactable: number; personal: number;
  business: number; refreshed_at: Date | null;
};

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Every client with its mapping, cached stats, and the receive fields (a route file exports only its handlers). */
async function readClients(pool: Pick<Pool, "query">): Promise<ClientsAnswer> {
  const { rows: [has] } = await pool.query<{ churn: boolean; settings: boolean; topup: boolean; shares: boolean }>(PRESENT_SQL);
  const none = { rows: [] as never[] };
  const [tags, stats, settingRows, low, shared] = await Promise.all([
    pool.query<TagRow>(
      `SELECT tag, name, owner, status, group_no, b2b_instance, b2c_instance, source, client_type,
              lower(btrim(coalesce(status, ''))) IN ('active', 'healthy') AS active,
              ${has.churn
                ? `to_char(churn_date, 'YYYY-MM-DD') AS churn_date, churn_cell, churn_cell_state, on_groups_tab,
                   groups_tab_read_at, fn_client_receive_block(tag) AS receive_block`
                : `NULL::text AS churn_date, NULL::text AS churn_cell, NULL::text AS churn_cell_state,
                   NULL::boolean AS on_groups_tab, NULL::timestamptz AS groups_tab_read_at, NULL::text AS receive_block`}
         FROM client_tags`
    ),
    // bigint counts as float8, so they come back as numbers (exact far past these sizes).
    pool.query<StatRow>(
      `SELECT tag, leads::float8 AS leads, categorized::float8 AS categorized, bounced::float8 AS bounced,
              contactable::float8 AS contactable, personal::float8 AS personal, business::float8 AS business, refreshed_at
         FROM client_stats`
    ),
    has.settings ? pool.query<{ key: string; value: unknown }>(`SELECT key, value FROM enrich_settings`) : none,
    has.topup ? pool.query<{ client_tag: string; low_places: number }>(LOW_PLACES_SQL) : none,
    has.shares ? pool.query<{ receiver_tag: string; shared_7d: number }>(SHARED_7D_SQL) : none,
  ]);

  const settings = settingsFrom(settingRows.rows);
  const statById = new Map(stats.rows.map((s) => [s.tag, s]));
  const lowBy = new Map(low.rows.map((r) => [r.client_tag, r.low_places]));
  const sharedBy = new Map(shared.rows.map((r) => [r.receiver_tag, r.shared_7d]));
  const refreshedAt = stats.rows.reduce<string | null>((acc, s) => {
    const at = iso(s.refreshed_at);
    return at && (!acc || at > acc) ? at : acc;
  }, null);

  const rows: ClientRow[] = tags.rows.map((t) => {
    const s = statById.get(t.tag);
    const status = t.status ?? null;
    return {
      tag: t.tag,
      name: t.name ?? null,
      owner: t.owner ?? null,
      status,
      churned: typeof status === "string" && status.toLowerCase().includes("churn"),
      group_no: t.group_no ?? null,
      b2b_instance: t.b2b_instance ?? null,
      b2c_instance: t.b2c_instance ?? null,
      sendable: !!t.b2b_instance || !!t.b2c_instance,
      source: t.source ?? null,
      leads: s?.leads ?? 0,
      categorized: s?.categorized ?? 0,
      bounced: s?.bounced ?? 0,
      contactable: s?.contactable ?? 0,
      personal: s?.personal ?? 0,
      business: s?.business ?? 0,
      churn_date: t.churn_date ?? null,
      churn_cell: t.churn_cell ?? null,
      churn_cell_state: t.churn_cell_state ?? null,
      on_groups_tab: t.on_groups_tab === true,
      groups_tab_read_at: iso(t.groups_tab_read_at),
      receive_block: t.receive_block ?? null,
      pool: clientPool(settings, t.tag, t.client_type),
      low_places: lowBy.get(t.tag) ?? null,
      shared_7d: sharedBy.get(t.tag) ?? 0,
    };
  });
  rows.sort((a, b) => b.leads - a.leads || a.tag.localeCompare(b.tag));

  const groupsTabReadAt = rows.reduce<string | null>(
    (acc, r) => (r.groups_tab_read_at && (!acc || r.groups_tab_read_at > acc) ? r.groups_tab_read_at : acc),
    null,
  );
  const missingFromTab = has.churn
    ? tags.rows.filter((t) => t.active && t.on_groups_tab !== true).map((t) => t.tag).sort()
    : [];
  return { clients: rows, refreshedAt, groupsTabReadAt, missingFromTab, receiveRule: has.churn };
}

// GET /api/clients: every client tag with its instance mapping and cached stats,
// and (migration 132 on) its churn date, whether the Groups tab lists it, why
// it cannot receive shared leads or top-up pulls, its sharing pool, its low
// places in the latest top-up pass and the leads shared to it in 7 days.
export async function GET() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    return NextResponse.json(await readClients(getPool()));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// PATCH /api/clients — edit a client's status / instance mapping (owner/admin).
export async function PATCH(req: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin.from("user_profiles").select("role").eq("id", user.id).single();
  if (!profile || !["owner", "admin"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden — owner/admin only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  if (!tag) return NextResponse.json({ error: "tag is required" }, { status: 400 });

  const update: Record<string, unknown> = {};
  // Churned toggle: the UI sends { churned: boolean }. We store a status string.
  if (typeof body.churned === "boolean") update.status = body.churned ? "Confirmed Churn" : "Healthy";
  if (typeof body.status === "string") update.status = body.status.trim() || null;
  if (typeof body.owner === "string") update.owner = body.owner.trim() || null;
  if (typeof body.name === "string") update.name = body.name.trim() || null;
  if ("group_no" in body) update.group_no = body.group_no === null ? null : Number(body.group_no) || null;
  if ("b2b_instance" in body) update.b2b_instance = body.b2b_instance ? String(body.b2b_instance).trim() : null;
  if ("b2c_instance" in body) update.b2c_instance = body.b2c_instance ? String(body.b2c_instance).trim() : null;
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No editable fields provided" }, { status: 400 });
  }

  const { data, error } = await admin.from("client_tags").update(update).eq("tag", tag).select().single();
  if (error) {
    if ((error as { code?: string }).code === "PGRST116") {
      return NextResponse.json({ error: "Client tag not found" }, { status: 404 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ client: data });
}
