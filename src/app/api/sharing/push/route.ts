import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { logAudit } from "@/lib/api/log-audit";
import { getPool } from "@/lib/db/pool";
import { isUuid, notApplied, sharingTx, tagOf } from "@/lib/sharing/db";
import { pushReceiverShares } from "@/lib/sharing/push";
import { readSettings } from "@/lib/sharing/server";
import { flagOn } from "../../../../../scripts/lib/enrich/settings.mjs";

// POST /api/sharing/push {batchId?, receiver?, held?, dryRun?}: the Sharing
// page's "Push shared" (plan 1.8). Admin and up.
//
// It takes applied, live shares (outcome shared or own_topup) of one job
// and/or one receiving client that were never pushed (push_state empty), and
// with held also the held ones, and queues them for receivers on the push list
// (flagOn "share_push"); then it runs the share push for each of those
// receivers at once (src/lib/sharing/push.ts, as the worker's timer does).
// Adding a client to the push list never queues its older shares: this is how
// they go.
//
//   dryRun: only the counts it would queue, per receiver, and the rows of
//           receivers off the push list it leaves alone (the confirm names them).
//   Answer: {queued: {tag: n}, notOnPushList: {tag: n}, results: [push answers]}.
//   409 while sharing is switched off. Audited.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: { batchId?: unknown; receiver?: unknown; held?: unknown; dryRun?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  const batchId = body.batchId === undefined || body.batchId === null ? null : body.batchId;
  if (batchId !== null && !isUuid(batchId)) return NextResponse.json({ error: "batchId must be a share job's id" }, { status: 400 });
  const receiver = body.receiver === undefined || body.receiver === null ? null : tagOf(body.receiver);
  if (receiver === "") return NextResponse.json({ error: "receiver must be a client tag" }, { status: 400 });
  if (!batchId && !receiver) return NextResponse.json({ error: "Name a share job, a receiving client, or both" }, { status: 400 });
  const withHeld = body.held === true;
  const dryRun = body.dryRun === true;

  const pool = getPool();
  const where = `s.applied_at IS NOT NULL AND s.undone_at IS NULL AND s.outcome IN ('shared', 'own_topup')
     AND (s.push_state IS NULL OR ($3::boolean AND s.push_state = 'held'))
     AND ($1::uuid IS NULL OR s.batch_id = $1) AND ($2::text IS NULL OR s.receiver_tag = $2)`;
  let plan: { enabled: boolean; queue: Record<string, number>; notOnPushList: Record<string, number> };
  try {
    plan = await sharingTx(
      pool,
      async (c) => {
        const settings = await readSettings(c);
        const { rows } = await c.query(`SELECT s.receiver_tag, count(*)::int AS n FROM lead_shares s WHERE ${where} GROUP BY 1`, [
          batchId, receiver, withHeld,
        ]);
        const queue: Record<string, number> = {};
        const notOnPushList: Record<string, number> = {};
        for (const r of rows) {
          if (flagOn(settings, "share_push", r.receiver_tag)) queue[r.receiver_tag] = r.n;
          else notOnPushList[r.receiver_tag] = r.n;
        }
        return { enabled: settings.overlap_sharing.enabled, queue, notOnPushList };
      },
      { readOnly: true, timeoutMs: 15_000 }
    );
  } catch (err) {
    if (notApplied(err)) return NextResponse.json({ error: "Sharing is not set up in this database yet" }, { status: 503 });
    console.error("sharing/push:", err);
    return NextResponse.json({ error: "Could not count the shares" }, { status: 500 });
  }
  if (dryRun) return NextResponse.json({ dryRun: true, enabled: plan.enabled, queue: plan.queue, notOnPushList: plan.notOnPushList });
  if (!plan.enabled) return NextResponse.json({ error: "Sharing is switched off, so nothing was queued.", notOnPushList: plan.notOnPushList }, { status: 409 });

  const receivers = Object.keys(plan.queue);
  let queued: Record<string, number> = {};
  try {
    queued = await sharingTx(
      pool,
      async (c) => {
        // Re-read under the transaction: only receivers on the push list now.
        const settings = await readSettings(c);
        const onList = receivers.filter((t) => flagOn(settings, "share_push", t));
        if (!onList.length) return {};
        const { rows } = await c.query(
          `UPDATE lead_shares s SET push_state = 'queued', push_note = NULL, held_since = NULL, held_at = NULL
            WHERE ${where} AND s.receiver_tag = ANY($4::text[])
            RETURNING s.receiver_tag`,
          [batchId, receiver, withHeld, onList]
        );
        const out: Record<string, number> = {};
        for (const r of rows) out[r.receiver_tag] = (out[r.receiver_tag] ?? 0) + 1;
        return out;
      },
      { timeoutMs: 60_000 }
    );
  } catch (err) {
    console.error("sharing/push queue:", err);
    return NextResponse.json({ error: "Could not queue the shares" }, { status: 500 });
  }
  const total = Object.values(queued).reduce((a, b) => a + b, 0);
  if (total) {
    await logAudit({
      action: "Shares Queued For Push",
      performedBy: auth.user.id,
      details: `Push shared${batchId ? ` for job ${batchId}` : ""}${receiver ? ` to ${receiver}` : ""}${withHeld ? " (held ones too)" : ""}: ` +
        Object.entries(queued).map(([t, n]) => `${t} ${n}`).join(", "),
    });
  }
  const results = [];
  for (const t of Object.keys(queued)) {
    try {
      const out = await pushReceiverShares(pool, { receiver: t });
      results.push(out.status === 200 ? out.body : { receiver: t, ...out.body });
    } catch (err) {
      console.error(`sharing/push ${t}:`, err);
      results.push({ receiver: t, error: err instanceof Error ? err.message : String(err), kept: queued[t] });
    }
  }
  return NextResponse.json({ queued, notOnPushList: plan.notOnPushList, results });
}
