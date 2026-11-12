import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";

// POST /api/companies/runs/cancel {id}: stops a queued or running company
// pull. Cancel means no new paid call: the worker sees it on its next write,
// a page AI Ark already answered is still written (it is paid for), and every
// company pulled so far stays in the client's table and is still enriched.
// The pull's sources get its counts now, as the worker would at its finish.
// Manager and up.

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
  if (!isUuid(body.id)) return NextResponse.json({ error: "id must be a pull id" }, { status: 400 });
  try {
    const out = await withTx(async (c) => {
      const { rows } = await c.query(
        `UPDATE aiark_company_runs
            SET status = 'cancelled', finished_at = coalesce(finished_at, now())
          WHERE id = $1 AND status IN ('queued', 'running')
          RETURNING id, client_tag, pulled, from_registry, source_id, registry_source_id,
                    coalesce((progress->>'bought')::int, 0) AS returned`,
        [body.id]
      );
      const r = rows[0];
      if (!r) return null;
      // Bought rows are the pull's own source (received: the companies AI Ark returned; created: the
      // new rows), as the worker records them when a pull finishes; copies are the registry source.
      const bought = Math.max(0, Number(r.pulled) - Number(r.from_registry));
      if (r.source_id) {
        await c.query(`UPDATE enrich_sources SET received = $2, created = $3 WHERE id = $1`, [r.source_id, Number(r.returned), bought]);
      }
      if (r.registry_source_id) {
        await c.query(`UPDATE enrich_sources SET received = $2, created = $2 WHERE id = $1`, [r.registry_source_id, Number(r.from_registry)]);
      }
      return r;
    });
    if (!out) return NextResponse.json({ error: "That pull is not queued or running" }, { status: 409 });
    await logAudit({
      action: "companies_run_cancel",
      performedBy: auth.user.id,
      details: `${out.client_tag}: pull ${out.id} cancelled at ${out.pulled} pulled`,
    });
    return NextResponse.json({ cancelled: true });
  } catch (err) {
    console.error("companies/runs/cancel:", err);
    return NextResponse.json({ error: "Could not cancel the pull" }, { status: 500 });
  }
}
