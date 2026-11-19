import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { isUuid, notApplied, sharingTx } from "@/lib/sharing/db";
import { jobDetail } from "@/lib/sharing/server";

// GET /api/sharing/job?id=<batch id>: one share job: per receiving client its
// rows by outcome and push state, whether it can receive and is on the push
// list, a sample of up to 20 rows (shares first), and the push batches its
// shares went into. Manager and up.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const id = req.nextUrl.searchParams.get("id");
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a share job's id" }, { status: 400 });
  try {
    const out = await sharingTx(getPool(), (c) => jobDetail(c, id), { readOnly: true, timeoutMs: 20_000 });
    if (!out) return NextResponse.json({ error: "No share job with that id" }, { status: 404 });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (notApplied(err)) return NextResponse.json({ error: "Sharing is not set up in this database yet" }, { status: 404 });
    console.error("sharing/job:", err);
    return NextResponse.json({ error: "Could not load the share job" }, { status: 500 });
  }
}
