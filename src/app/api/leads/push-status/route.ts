import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// POST /api/leads/push-status  { leadIds: string[], clientTag: string }
//   -> { pushed: string[] }   // subset of leadIds already sent to a MAIN campaign
//
// Backs the "Main Campaigns" column on the Leads table.
//
// WHY A SEPARATE ROUTE rather than folding this into the filter RPC: the filter
// query is the expensive one (a regex sweep over the matched set), and this is
// 50 primary-key-ish probes. Bolting it on would make every filter change pay
// for it and would serialise the two. The page fires this alongside the filter
// request, so the table renders on the filter's schedule and the column fills
// in when it arrives.
//
// "Pushed" means: sent, for THIS client, and actually attached to a campaign
// that is not a Nurture. Three details matter:
//   * status='sent' alone is not enough — the worker marks an item sent even
//     when Bison refused some campaigns, recording "partial: ..." in error. So
//     we check the campaign id against attached_ids, the authoritative record
//     of what was really attached.
//   * the campaign NAME only exists on push_batches.campaigns (a snapshot taken
//     at queue time); push_items.target_campaigns carries ids only.
//   * a campaign entry with no name is treated as MAIN. That over-reports
//     rather than under-reports, and matches how the pickers behave.
//
// Known gap: the legacy synchronous /api/bison/push writes no push_items at all,
// so anything sent through that path is invisible here.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_IDS = 500; // a page is 50-200; this is a sanity bound, not a feature

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { leadIds?: unknown; clientTag?: unknown };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const clientTag = typeof body.clientTag === "string" ? body.clientTag.trim() : "";
  const leadIds = Array.isArray(body.leadIds)
    ? [...new Set(body.leadIds.filter((v): v is string => typeof v === "string" && UUID.test(v)))].slice(0, MAX_IDS)
    : [];

  // No client selected means the column has nothing to say — don't touch the DB.
  if (!clientTag || leadIds.length === 0) return NextResponse.json({ pushed: [] });

  try {
    const pool = getPool();
    const { rows } = await pool.query<{ lead_id: string }>(
      `select distinct pi.lead_id
         from push_items pi
         join push_batches pb on pb.id = pi.batch_id
         cross join lateral jsonb_array_elements(pb.campaigns) c
        where pi.lead_id = any($1::uuid[])
          and pi.status = 'sent'
          and pb.client_tag = $2
          and c->>'id' = any(pi.attached_ids)
          and coalesce(c->>'name', '') !~* 'nurture'`,
      [leadIds, clientTag]
    );
    return NextResponse.json({ pushed: rows.map((r) => r.lead_id) });
  } catch (e) {
    // The column is informational — never fail the page over it.
    console.error("push-status error:", e);
    return NextResponse.json({ pushed: [] });
  }
}
