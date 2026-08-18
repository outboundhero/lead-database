import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// POST /api/bison/push-batches/retry
//   { batchId }   requeue that batch's failed contacts
//   { all: true } requeue failed contacts across EVERY finished batch
//
// Only status = 'failed' is requeued — a genuine error where a retry can
// succeed. 'skipped' is deliberately NEVER retried: those are leads Bison
// itself refused (already in another sequence, previously bounced there, or
// unsubscribed). Retrying them cannot succeed and would burn API calls against
// the per-instance rate limit; production holds ~37k skipped vs ~326 failed.
// 'sent' is obviously untouched, so a retry can never double-send.
//
// Reopening the batch to 'processing' is what makes the always-on push-worker
// pick the items up on its next poll (~4s).

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { batchId?: string; all?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const retryAll = body.all === true;
  const batchId = (body.batchId ?? "").trim();
  if (!retryAll && !/^[0-9a-f-]{36}$/i.test(batchId)) {
    return NextResponse.json({ error: "batchId (uuid) or all:true required" }, { status: 400 });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    // One transaction so item requeues and batch counters can never disagree.
    await client.query("begin");

    const scope = retryAll
      ? { where: `status = 'failed'`, params: [] as unknown[] }
      : { where: `batch_id = $1 and status = 'failed'`, params: [batchId] };

    const { rows: touched } = await client.query<{ batch_id: string; n: string }>(
      `with requeued as (
         update push_items
            set status = 'pending', attempts = 0, error = null,
                claim_token = null, claimed_at = null
          where ${scope.where}
          returning batch_id
       )
       select batch_id, count(*)::text as n from requeued group by batch_id`,
      scope.params
    );

    const requeued = touched.reduce((n, r) => n + Number(r.n), 0);
    if (requeued === 0) {
      await client.query("rollback");
      return NextResponse.json(
        {
          error: retryAll
            ? "Nothing to retry — no genuine errors in any push."
            : "No genuine errors to retry in this push. Contacts Bison refused (already in a sequence, bounced, or unsubscribed) can't be retried.",
        },
        { status: 400 }
      );
    }

    // Reopen each affected batch and roll its counters back by what we requeued.
    for (const r of touched) {
      await client.query(
        `update push_batches
            set status = 'processing', completed_at = null,
                failed = greatest(0, failed - $2),
                processed = greatest(0, processed - $2),
                updated_at = now()
          where id = $1 and status in ('complete', 'error', 'cancelled')`,
        [r.batch_id, Number(r.n)]
      );
    }

    await client.query("commit");
    return NextResponse.json({ requeued, batches: touched.length });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "retry failed" },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
