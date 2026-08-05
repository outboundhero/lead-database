import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeFilterState } from "@/types/filters";

// Shareable search links: POST a FilterState -> {id}; GET ?id= -> {filters}.
// The link (/leads?s=<id>) restores the exact search — big filter sets don't
// fit in a URL, so the state lives in shared_searches keyed by content hash.

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { filters?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body.filters || typeof body.filters !== "object") {
    return NextResponse.json({ error: "filters required" }, { status: 400 });
  }
  // Normalize + strip pagination so equivalent searches share one link.
  const normalized = normalizeFilterState(body.filters);
  const { page: _p, ...rest } = normalized;
  void _p;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 32);

  const admin = createAdminClient();
  const { data: existing } = await admin.from("shared_searches").select("id").eq("filters_hash", hash).maybeSingle();
  if (existing) return NextResponse.json({ id: existing.id });
  const { data, error } = await admin
    .from("shared_searches")
    .insert({ filters: rest, filters_hash: hash, created_by: user.id })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ id: data.id });
}

export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id")?.trim();
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { data, error } = await createAdminClient().from("shared_searches").select("filters").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Search link not found" }, { status: 404 });
  return NextResponse.json({ filters: data.filters });
}
