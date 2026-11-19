import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { requestSync, syncStatus } from "../../../../../scripts/lib/bison-sync-runs.mjs";

// The top bar's Bison sync panel (2026-11-20, migration 131).
//
// GET  /api/bison/sync — any signed-in user: the waiting/running sync, the last
//      finished one, and the last watermark write (shown before any run is logged).
// POST /api/bison/sync — "Sync now" (owner/admin/manager): records a request. The
//      bison-sync cron checks every 30 minutes (scripts/bison-sync-cron.mjs) and
//      runs the incremental sync — new Bison leads only — then logs the outcome.
//      A second press while one is waiting or running returns that one.

export const dynamic = "force-dynamic";

const q = async (sql: string, params?: unknown[]) => (await getPool().query(sql, params)).rows;

export async function GET() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await syncStatus(q), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data: profile } = await createAdminClient()
    .from("user_profiles").select("email, role").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json({ error: "Only owners, admins and managers can start a Bison sync." }, { status: 403 });
  }
  try {
    const result = await requestSync(q, profile.email ?? user.email ?? user.id);
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
