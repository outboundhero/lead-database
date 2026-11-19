import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { isUuid, notApplied, sharingTx } from "@/lib/sharing/db";
import { batchBadges } from "@/lib/sharing/server";

// GET /api/sharing/batches?ids=<id>,<id>: the Uploads page's badge, per
// import batch that has a share job: its state and how many clients it was
// shared to (applied) or would be (preview). Batches with no job are left out.
// Manager and up; at most 100 ids.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const ids = [...new Set((req.nextUrl.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length > 100 || !ids.every(isUuid)) return NextResponse.json({ error: "ids must be up to 100 batch ids" }, { status: 400 });
  if (!ids.length) return NextResponse.json({ batches: {} });
  try {
    const batches = await sharingTx(getPool(), (c) => batchBadges(c, ids), { readOnly: true, timeoutMs: 10_000 });
    return NextResponse.json({ batches }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (notApplied(err)) return NextResponse.json({ batches: {} });
    console.error("sharing/batches:", err);
    return NextResponse.json({ error: "Could not load the share jobs" }, { status: 500 });
  }
}
