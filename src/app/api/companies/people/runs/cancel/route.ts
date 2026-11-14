import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cancelPeopleRun } from "@/lib/companies/people";

// POST /api/companies/people/runs/cancel {id}: stops a people run that is
// queued, running or waiting for Buy. Cancel means no new paid call: the
// worker sees it before its next Preview page or Export Single. Everyone
// bought or copied so far stays in the client's People table and is still
// worked. The run's sources get their counts now. Manager and up.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!isUuid(body.id)) return NextResponse.json({ error: "id must be a people run id" }, { status: 400 });
  const id = body.id;
  try {
    const out = await withTx((c) => cancelPeopleRun(c, { runId: id }));
    if (!out) return NextResponse.json({ error: "That people run is not going" }, { status: 409 });
    await logAudit({
      action: "companies_people_run_cancel",
      performedBy: auth.user.id,
      details: `${out.client_tag}: people run ${out.id} cancelled at ${out.bought} bought, ${out.copied} copied`,
    });
    return NextResponse.json({ cancelled: true });
  } catch (err) {
    console.error("companies/people/runs/cancel:", err);
    return NextResponse.json({ error: "Could not cancel the people run" }, { status: 500 });
  }
}
