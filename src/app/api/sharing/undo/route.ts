import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { logAudit } from "@/lib/api/log-audit";
import { getPool } from "@/lib/db/pool";
import { jobTarget, shareActionRefusal } from "@/lib/sharing/actions";
import { undoShareJob } from "../../../../../scripts/lib/share/actions.mjs";

// POST /api/sharing/undo {batchId, receiver?}: undo a share job (or one
// receiver of it), admin and up (plan 1.7). Its shares are marked undone,
// queued and held pushes are dropped, share pushes not gathered yet are
// cancelled, and the tags it wrote are taken off, paced. Leads already pushed
// stay in their campaigns: the answer counts them (taking them out is a
// separate step). Audited. The work is the share step's own
// (scripts/lib/share/actions.mjs).

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const target = jobTarget(body);
  if ("error" in target) return NextResponse.json({ error: target.error }, { status: 400 });
  try {
    const out = await undoShareJob(getPool(), { batchId: target.batchId, receiver: target.receiver, userId: auth.user.id });
    await logAudit({
      action: "Share Job Undone",
      performedBy: auth.user.id,
      details:
        `Undid share job ${target.batchId}${target.receiver ? ` for ${target.receiver}` : ""}: ${out.undone ?? 0} share(s) undone, ` +
        `${out.tagsToRemove ?? 0} tag(s) to take off, ${(out.cancelledPushes ?? []).length} push(es) cancelled, ` +
        `${out.pushedLeads ?? 0} lead(s) already pushed stay in their campaigns`,
    });
    return NextResponse.json(out);
  } catch (err) {
    const refused = shareActionRefusal(err);
    if (refused) return refused;
    console.error("sharing/undo:", err);
    return NextResponse.json({ error: "Could not undo the share job" }, { status: 500 });
  }
}
