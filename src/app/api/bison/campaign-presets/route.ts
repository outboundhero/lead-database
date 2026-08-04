import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Campaign-selection presets (client req #7): named sets of campaign keys
// ("<instance_url>#<id>") shared by the whole team.
// GET → all presets; POST {name, campaignKeys} → upsert; DELETE {id} → remove.

export async function GET() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await createAdminClient()
    .from("campaign_presets")
    .select("id, name, campaign_keys, created_at")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ presets: data ?? [] });
}

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { name?: string; campaignKeys?: string[] };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const name = (body.name ?? "").trim();
  const keys = Array.isArray(body.campaignKeys)
    ? body.campaignKeys.filter((k) => typeof k === "string" && k.length > 0 && k.length < 200).slice(0, 200)
    : [];
  if (!name || name.length > 80) return NextResponse.json({ error: "Preset needs a name (max 80 chars)" }, { status: 400 });
  if (!keys.length) return NextResponse.json({ error: "Select at least one campaign first" }, { status: 400 });

  const { data, error } = await createAdminClient()
    .from("campaign_presets")
    .upsert({ name, campaign_keys: keys, created_by: user.id }, { onConflict: "name" })
    .select("id, name, campaign_keys")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ preset: data });
}

export async function DELETE(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { id?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { error } = await createAdminClient().from("campaign_presets").delete().eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
