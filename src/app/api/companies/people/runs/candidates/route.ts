import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { candidatesPage } from "@/lib/companies/people";

// GET /api/companies/people/runs/candidates?id=&after=: one page of a people
// run's candidates (the people its Look saw) with their screen verdicts and
// picks, by company then person, in keyset pages of 100 (`after` is the page
// before's `next`; no OFFSET). A Preview's last name stays masked. Manager and up.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const id = sp.get("id");
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a people run id" }, { status: 400 });
  const after = sp.get("after");
  try {
    const page = await withTx((c) => candidatesPage(c, { runId: id, after }), { readOnly: true, timeoutMs: 8_000 });
    if (!page) return NextResponse.json({ error: "after is not a page cursor" }, { status: 400 });
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("companies/people/runs/candidates:", err);
    return NextResponse.json({ error: "Could not load the candidates" }, { status: 500 });
  }
}
