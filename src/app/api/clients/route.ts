import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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
}

// GET /api/clients — every client tag with its instance mapping + cached stats.
export async function GET() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const [{ data: tags, error: e1 }, { data: stats, error: e2 }] = await Promise.all([
    admin.from("client_tags").select("tag, name, owner, status, group_no, b2b_instance, b2c_instance, source"),
    admin.from("client_stats").select("*"),
  ]);
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

  const statById = new Map((stats ?? []).map((s) => [s.tag as string, s]));
  const refreshedAt = (stats ?? []).reduce<string | null>(
    (acc, s) => (s.refreshed_at && (!acc || s.refreshed_at > acc) ? (s.refreshed_at as string) : acc),
    null,
  );

  const rows: ClientRow[] = (tags ?? []).map((t) => {
    const s = statById.get(t.tag as string);
    const status = (t.status as string | null) ?? null;
    return {
      tag: t.tag as string,
      name: (t.name as string | null) ?? null,
      owner: (t.owner as string | null) ?? null,
      status,
      churned: typeof status === "string" && status.toLowerCase().includes("churn"),
      group_no: (t.group_no as number | null) ?? null,
      b2b_instance: (t.b2b_instance as string | null) ?? null,
      b2c_instance: (t.b2c_instance as string | null) ?? null,
      sendable: !!t.b2b_instance || !!t.b2c_instance,
      source: (t.source as string | null) ?? null,
      leads: (s?.leads as number) ?? 0,
      categorized: (s?.categorized as number) ?? 0,
      bounced: (s?.bounced as number) ?? 0,
      contactable: (s?.contactable as number) ?? 0,
      personal: (s?.personal as number) ?? 0,
      business: (s?.business as number) ?? 0,
    };
  });
  rows.sort((a, b) => b.leads - a.leads || a.tag.localeCompare(b.tag));

  return NextResponse.json({ clients: rows, refreshedAt });
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
