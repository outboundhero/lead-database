import { NextRequest, NextResponse } from "next/server";
import { stringify } from "csv-stringify/sync";
import { requireRole } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { isUuid, notApplied, sharingTx, tagOf } from "@/lib/sharing/db";
import { jobRows } from "@/lib/sharing/server";

// GET /api/sharing/csv?id=<batch id>&receiver=<tag>: a share job's rows as CSV
// (plan 1.11): receiver, email, company, city, state, matched place, outcome,
// push state, applied, undone. Every receiver unless one is named; at most
// 200,000 rows. Manager and up.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const q = req.nextUrl.searchParams;
  const id = q.get("id");
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a share job's id" }, { status: 400 });
  const receiverRaw = q.get("receiver");
  const receiver = receiverRaw ? tagOf(receiverRaw) : null;
  if (receiverRaw && !receiver) return NextResponse.json({ error: "receiver must be a client tag" }, { status: 400 });
  try {
    const rows = await sharingTx(getPool(), (c) => jobRows(c, id, receiver), { readOnly: true, timeoutMs: 60_000 });
    const csv = stringify([
      ["receiver", "email", "company", "city", "state", "matched place", "outcome", "push state", "applied", "undone"],
      ...rows.map((r) => [
        r.receiver_tag,
        r.email ?? "",
        r.company ?? "",
        r.city ?? "",
        r.state ?? "",
        r.matched_place ?? "",
        r.outcome,
        r.push_state ?? "",
        r.applied_at ? new Date(r.applied_at).toISOString() : "",
        r.undone_at ? new Date(r.undone_at).toISOString() : "",
      ]),
    ]);
    const name = `share-job-${id.slice(0, 8)}${receiver ? `-${receiver}` : ""}.csv`;
    return new Response(csv, {
      status: 200,
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" },
    });
  } catch (err) {
    if (notApplied(err)) return NextResponse.json({ error: "Sharing is not set up in this database yet" }, { status: 404 });
    console.error("sharing/csv:", err);
    return NextResponse.json({ error: "Could not build the CSV" }, { status: 500 });
  }
}
