import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// GET /api/filters/presets — List user's presets + shared presets
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const admin = createAdminClient();

  const { data, error } = await admin
    .from("filter_presets")
    .select("*")
    .or(`user_id.eq.${user?.id ?? ""},is_shared.eq.true`)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ presets: data });
}

// POST /api/filters/presets — Create a new preset
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    name: string;
    filters: Record<string, unknown>;
    is_shared?: boolean;
    client_tag?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const clientTag =
    typeof body.client_tag === "string" && body.client_tag.trim()
      ? body.client_tag.trim()
      : null;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("filter_presets")
    .insert({
      user_id: user.id,
      name: body.name.trim(),
      filters: body.filters,
      is_shared: body.is_shared ?? false,
      client_tag: clientTag,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ preset: data });
}

// PUT /api/filters/presets — Update an existing preset in place (re-save the
// current filters onto a saved search, rename it, or (re)assign a client tag).
// Only the owner may update their own preset.
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    id: string;
    name?: string;
    filters?: Record<string, unknown>;
    is_shared?: boolean;
    client_tag?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (body.filters !== undefined) update.filters = body.filters;
  if (typeof body.name === "string") {
    if (!body.name.trim()) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }
    update.name = body.name.trim();
  }
  if (typeof body.is_shared === "boolean") update.is_shared = body.is_shared;
  if (body.client_tag !== undefined) {
    update.client_tag =
      typeof body.client_tag === "string" && body.client_tag.trim()
        ? body.client_tag.trim()
        : null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("filter_presets")
    .update(update)
    .eq("id", body.id)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) {
    // PGRST116 = .single() matched no row (wrong id or not owned by this user).
    if ((error as { code?: string }).code === "PGRST116") {
      return NextResponse.json({ error: "Preset not found" }, { status: 404 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: "Preset not found" }, { status: 404 });
  }

  return NextResponse.json({ preset: data });
}

// DELETE /api/filters/presets — Delete a preset
export async function DELETE(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("filter_presets")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
