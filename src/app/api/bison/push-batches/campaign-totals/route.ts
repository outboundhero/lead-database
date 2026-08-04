import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// GET /api/bison/push-batches/campaign-totals?batchId=…
// Per-campaign attach totals for one batch — the "routing totals by campaign"
// line of the status box (client req #10). Computed on demand (an unnest over
// one batch's items), not in the 4s poll.
export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const batchId = request.nextUrl.searchParams.get("batchId")?.trim();
  if (!batchId || !/^[0-9a-f-]{36}$/i.test(batchId)) {
    return NextResponse.json({ error: "batchId (uuid) required" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const { data: batch } = await admin
      .from("push_batches")
      .select("campaigns")
      .eq("id", batchId)
      .maybeSingle();
    if (!batch) return NextResponse.json({ error: "Batch not found" }, { status: 404 });

    const { rows } = await getPool().query(
      `select c as campaign_id, count(*)::bigint as leads
         from push_items, unnest(attached_ids) as c
        where batch_id = $1
        group by c`,
      [batchId]
    );
    const counts = new Map(rows.map((r) => [String(r.campaign_id), Number(r.leads)]));
    const { rows: skipRows } = await getPool().query(
      `select count(*)::bigint as n from push_items
        where batch_id = $1 and status = 'skipped' and error like 'no campaign for %'`,
      [batchId]
    );
    const totals = (batch.campaigns ?? []).map(
      (c: { id: number | string; name?: string; bucket?: string; instance_url?: string }) => ({
        id: c.id,
        name: c.name ?? `Campaign ${c.id}`,
        bucket: c.bucket ?? null,
        instance_url: c.instance_url,
        leads: counts.get(String(c.id)) ?? 0,
      })
    );
    return NextResponse.json({ batchId, totals, skippedNoBucketCampaign: Number(skipRows[0]?.n ?? 0) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "totals failed" }, { status: 500 });
  }
}
