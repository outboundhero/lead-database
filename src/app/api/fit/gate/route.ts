import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanGate, fitGateView, readFitSettings, saveGate } from "@/lib/companies/fit";

// GET /api/fit/gate: the fit gate's setting (owner and admin).
// PUT /api/fit/gate {enabled?, tags?, threshold?, client_types?, require_scored?}:
//     saves it, writes logAudit('fit_gate') and marks the blocked refresh
//     pending (the worker's fit loop brings company_fit.blocked up to date in
//     batches; the panel shows "Refresh pending" meanwhile). Shipped OFF with
//     no client on its list: the gate goes on one client at a time, each after
//     its EXPLAIN on production (design 9.2). While it is off the eligibility
//     and export functions return exactly what they returned before 127.

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  try {
    const out = await withTx(async (c) => fitGateView(c, await readFitSettings(c)), { readOnly: true, timeoutMs: 8_000 });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("fit/gate GET:", err);
    return NextResponse.json({ error: "Could not read the fit gate" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  try {
    const out = await withTx(
      async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('fit-settings'))`);
        const s = await readFitSettings(c);
        const cleaned = await cleanGate(c, body, s);
        if (cleaned.errors.length) return { status: 400 as const, error: cleaned.errors.join(". ") };
        if (cleaned.changes.length) await saveGate(c, cleaned.value);
        return { changes: cleaned.changes, gate: await fitGateView(c, await readFitSettings(c)) };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    if (out.changes.length) {
      await logAudit({ action: "fit_gate", performedBy: auth.user.id, details: out.changes.join("; ") });
    }
    return NextResponse.json(out);
  } catch (err) {
    console.error("fit/gate PUT:", err);
    return NextResponse.json({ error: "Could not save the fit gate" }, { status: 500 });
  }
}
