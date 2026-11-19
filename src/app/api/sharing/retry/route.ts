import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { logAudit } from "@/lib/api/log-audit";
import { getPool } from "@/lib/db/pool";
import { jobTarget, shareActionRefusal } from "@/lib/sharing/actions";
import { retryShareJob } from "../../../../../scripts/lib/share/actions.mjs";

// POST /api/sharing/retry {batchId}: send a share job in error back round
// (plan 1.13), admin and up. Audited. The work is the share step's own
// (scripts/lib/share/actions.mjs).

export const dynamic = "force-dynamic";

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
    const out = await retryShareJob(getPool(), { batchId: target.batchId, userId: auth.user.id });
    await logAudit({
      action: "Share Job Retried",
      performedBy: auth.user.id,
      details: `Sent share job ${target.batchId} round again (now ${out.state ?? "unknown"})`,
    });
    return NextResponse.json(out);
  } catch (err) {
    const refused = shareActionRefusal(err);
    if (refused) return refused;
    console.error("sharing/retry:", err);
    return NextResponse.json({ error: "Could not retry the share job" }, { status: 500 });
  }
}
