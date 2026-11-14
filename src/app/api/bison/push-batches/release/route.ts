import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { releaseScoringBatch } from "../../../../../../scripts/lib/enrich/fit-push.mjs";

// POST /api/bison/push-batches/release {batchId}: lets a push that waits for
// fit scoring ('scoring', only while the fit gate covers its client) go on
// without waiting (owner and admin). It goes to 'pending', fenced on 'scoring'
// so a cancel wins, and is logged. The push-time check still skips the leads
// whose company has no score yet, and queues their companies for scoring.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: { batchId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isUuid(body.batchId)) return NextResponse.json({ error: "batchId (uuid) is required" }, { status: 400 });
  const batchId = body.batchId;
  try {
    const out = await withTx(
      async (c) => {
        const released = await releaseScoringBatch(c, { batchId, userId: auth.user.id });
        if (released) return { released: true as const };
        const { rows: [b] } = await c.query(`SELECT status, client_tag FROM push_batches WHERE id = $1`, [batchId]);
        return { released: false as const, status: (b?.status as string | undefined) ?? null };
      },
      { timeoutMs: 8_000 }
    );
    if (!out.released) {
      if (!out.status) return NextResponse.json({ error: "Push batch not found" }, { status: 404 });
      return NextResponse.json({ error: `Batch is ${out.status}: only a push waiting for scoring can be released` }, { status: 409 });
    }
    await logAudit({
      action: "bison_push_batch_released",
      performedBy: auth.user.id,
      details: `Released push batch ${batchId} without waiting for fit scoring; its unscored companies are still skipped at push time`,
    });
    return NextResponse.json({ released: true, batchId });
  } catch (err) {
    console.error("push-batches/release:", err);
    return NextResponse.json({ error: "Could not release the push" }, { status: 500 });
  }
}
