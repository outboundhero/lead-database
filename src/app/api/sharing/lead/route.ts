import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { isUuid, notApplied, sharingTx } from "@/lib/sharing/db";
import { leadShares } from "@/lib/sharing/server";

// GET /api/sharing/lead?id=<lead id>: every share of one lead, newest first
// (the lead detail panel): from which client to which, the outcome, and
// whether it was applied, pushed or undone. Manager and up.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const id = req.nextUrl.searchParams.get("id");
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a lead id" }, { status: 400 });
  try {
    const shares = await sharingTx(getPool(), (c) => leadShares(c, id), { readOnly: true, timeoutMs: 10_000 });
    return NextResponse.json({ shares }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (notApplied(err)) return NextResponse.json({ shares: [] });
    console.error("sharing/lead:", err);
    return NextResponse.json({ error: "Could not load the lead's shares" }, { status: 500 });
  }
}
