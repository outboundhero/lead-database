import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// POST /api/bison/push-batches/retry  { batchId }
// Requeue a batch's FAILED items (client req #10 "Retry option"). The batch is
// reopened to 'processing' so the always-on worker picks the items up within a
// poll cycle. Sent/skipped items are untouched.
export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { batchId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const batchId = (body.batchId ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(batchId)) return NextResponse.json({ error: "batchId (uuid) required" }, { status: 400 });

  const pool = getPool();
  try {
    const { rowCount } = await pool.query(
      `update push_items set status = 'pending', attempts = 0, error = null, claim_token = null, claimed_at = null
        where batch_id = $1 and status = 'failed'`,
      [batchId]
    );
    if (rowCount === 0) return NextResponse.json({ error: "No failed contacts to retry in this push" }, { status: 400 });
    await pool.query(
      `update push_batches
          set status = 'processing', completed_at = null,
              failed = greatest(0, failed - $2), processed = greatest(0, processed - $2), updated_at = now()
        where id = $1 and status in ('complete', 'error')`,
      [batchId, rowCount]
    );
    return NextResponse.json({ requeued: rowCount });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "retry failed" }, { status: 500 });
  }
}
