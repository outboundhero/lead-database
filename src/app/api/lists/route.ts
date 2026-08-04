import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// User-editable named term lists (client req #4) — apply/edit/duplicate/create
// without dev involvement. The "Commercial cleaning titles" built-in is
// two-way: saving it also rewrites commercial_cleaning_excluded_titles, the
// table behind the Commercial Cleaning filter toggle AND the push-time gate.

const KINDS = new Set(["titles", "keywords", "domains", "gateways", "competitors"]);
const CC_TITLES_LIST = "Commercial cleaning titles";

async function requireEditor() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const admin = createAdminClient();
  const { data: profile } = await admin.from("user_profiles").select("role").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return { error: NextResponse.json({ error: "Your role can't edit lists — ask an admin" }, { status: 403 }) };
  }
  return { user, admin };
}

export async function GET() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await createAdminClient()
    .from("custom_lists")
    .select("id, name, kind, items, description, built_in, updated_at")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ lists: data ?? [] });
}

function cleanItems(items: unknown): string[] | null {
  if (!Array.isArray(items)) return null;
  const out = [...new Set(items.map((s) => String(s).trim()).filter((s) => s && s.length <= 120))];
  return out.slice(0, 2000);
}

// POST — create (or duplicate by sending an existing list's items under a new name)
export async function POST(request: NextRequest) {
  const gate = await requireEditor();
  if ("error" in gate) return gate.error;
  let body: { name?: string; kind?: string; items?: unknown; description?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const name = (body.name ?? "").trim();
  if (!name || name.length > 80) return NextResponse.json({ error: "List needs a name (max 80 chars)" }, { status: 400 });
  if (!KINDS.has(body.kind ?? "")) return NextResponse.json({ error: `kind must be one of: ${[...KINDS].join(", ")}` }, { status: 400 });
  const items = cleanItems(body.items) ?? [];
  const { data, error } = await gate.admin
    .from("custom_lists")
    .insert({ name, kind: body.kind, items, description: body.description?.trim() || null, created_by: gate.user.id })
    .select("id, name, kind, items, description, built_in, updated_at")
    .single();
  if (error) {
    return NextResponse.json(
      { error: error.message.includes("duplicate") ? `A list named "${name}" already exists` : error.message },
      { status: 400 }
    );
  }
  return NextResponse.json({ list: data });
}

// PUT — edit items/name/description
export async function PUT(request: NextRequest) {
  const gate = await requireEditor();
  if ("error" in gate) return gate.error;
  let body: { id?: string; name?: string; items?: unknown; description?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id)) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { data: existing } = await gate.admin
    .from("custom_lists").select("id, name, built_in, kind").eq("id", body.id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "List not found" }, { status: 404 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const items = body.items !== undefined ? cleanItems(body.items) : undefined;
  if (body.items !== undefined) {
    if (!items) return NextResponse.json({ error: "items must be an array of strings" }, { status: 400 });
    if (!items.length) return NextResponse.json({ error: "A list can't be emptied — delete it instead" }, { status: 400 });
    patch.items = items;
  }
  if (typeof body.name === "string" && body.name.trim() && !existing.built_in) patch.name = body.name.trim();
  if (typeof body.description === "string") patch.description = body.description.trim() || null;

  const { data, error } = await gate.admin
    .from("custom_lists").update(patch).eq("id", body.id)
    .select("id, name, kind, items, description, built_in, updated_at").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Two-way sync for the commercial-cleaning gate table.
  if (existing.name === CC_TITLES_LIST && items) {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(`delete from commercial_cleaning_excluded_titles`);
      await client.query(
        `insert into commercial_cleaning_excluded_titles (term)
         select distinct lower(t) from unnest($1::text[]) as t on conflict do nothing`,
        [items]
      );
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return NextResponse.json(
        { error: `List saved, but the Commercial Cleaning gate table failed to update: ${e instanceof Error ? e.message : e}` },
        { status: 500 }
      );
    } finally {
      client.release();
    }
  }
  return NextResponse.json({ list: data });
}

export async function DELETE(request: NextRequest) {
  const gate = await requireEditor();
  if ("error" in gate) return gate.error;
  let body: { id?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.id || !/^[0-9a-f-]{36}$/i.test(body.id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { data: existing } = await gate.admin
    .from("custom_lists").select("built_in").eq("id", body.id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "List not found" }, { status: 404 });
  if (existing.built_in) return NextResponse.json({ error: "Built-in lists can't be deleted (edit or duplicate them instead)" }, { status: 400 });
  const { error } = await gate.admin.from("custom_lists").delete().eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
