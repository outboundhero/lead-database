import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { cancelLeadQueries } from "@/lib/leads/query-cancel";
import { isQueryId } from "@/lib/leads/query-id";

// POST /api/leads/cancel  (body: { ids: string[] })
//
// The Leads page calls this when it gives up on a search it started — newer
// filters, its own time limit, leaving the page — so the search's query stops
// in the database instead of running on to its 120 s limit (migration 119).
// The ids are the random query ids the page sent with those searches; a search
// that has already finished is simply not found. Session-authed like
// /api/leads/count.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const raw = (body as { ids?: unknown } | null)?.ids;
  const ids = Array.isArray(raw) ? raw.filter(isQueryId).slice(0, 4) : [];
  if (!ids.length) return NextResponse.json({ cancelled: 0 });

  return NextResponse.json({ cancelled: await cancelLeadQueries(ids) });
}
