import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { logAudit } from "@/lib/api/log-audit";
import { getPool } from "@/lib/db/pool";
import { jobTarget, shareActionRefusal } from "@/lib/sharing/actions";
import { applyShareJob, previewShareJob } from "../../../../../scripts/lib/share/actions.mjs";

// POST /api/sharing/apply {batchId, receiver?, preview?}: apply a share job
// (or one receiver of it) by hand, admin and up (plan 1.9).
//   preview: true  decides it again with the current rules and says, per
//                  receiver, what changed since the preview and whether it is
//                  over a cap. Writes nothing (the Apply confirm shows it).
//   otherwise      applies: logs the shares as applied, and queues their push
//                  for receivers on the push list. Audited.
// The work is the share step's own (scripts/lib/share/actions.mjs).

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
    if (body.preview === true) {
      return NextResponse.json(await previewShareJob(getPool(), { batchId: target.batchId, receiver: target.receiver }));
    }
    const out = await applyShareJob(getPool(), { batchId: target.batchId, receiver: target.receiver, userId: auth.user.id });
    const applied = Object.entries(out.applied ?? {}).map(([t, n]) => `${t} ${n}`).join(", ");
    const queued = Object.entries(out.queued ?? {}).map(([t, n]) => `${t} ${n}`).join(", ");
    await logAudit({
      action: "Share Job Applied",
      performedBy: auth.user.id,
      details: `Applied share job ${target.batchId}${target.receiver ? ` for ${target.receiver}` : ""}: ${applied || "nothing"}` +
        (queued ? `; queued for push: ${queued}` : ""),
    });
    return NextResponse.json(out);
  } catch (err) {
    const refused = shareActionRefusal(err);
    if (refused) return refused;
    console.error("sharing/apply:", err);
    return NextResponse.json({ error: "Could not apply the share job" }, { status: 500 });
  }
}
