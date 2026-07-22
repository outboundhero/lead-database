import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 130; // the refresh scans leads.tags (~8s at 2.3M)

// POST /api/clients/refresh — recompute the per-client stats cache.
export async function POST() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin.from("user_profiles").select("role").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await admin.rpc("fn_refresh_client_stats");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ refreshedAt: data });
}
