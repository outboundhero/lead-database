import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";

// POST /api/aiark/runs/cancel {id} — stops a queued or running AI Ark run:
// no new paid calls. The worker sees it on its next write and stops after the
// person in flight; everyone already pulled stays in the run's table. AI Ark
// has no way to cancel an export job it has already taken, so that job is
// still charged. The worker reads it to the end, so nobody paid for is lost,
// and sets finished_at when it has. Manager and up.

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
  if (!isUuid(body.id)) return NextResponse.json({ error: "id must be a run id" }, { status: 400 });
  try {
    const out = await withTx(async (c) => {
      const { rows } = await c.query(
        `UPDATE aiark_runs
            SET status = 'cancelled',
                finished_at = CASE WHEN jsonb_typeof(progress->'job') = 'object' THEN finished_at ELSE now() END
          WHERE id = $1 AND status IN ('queued', 'running')
          RETURNING id, client_tag, pulled, source_id, jsonb_typeof(progress->'job') = 'object' AS holds_job,
                    progress #>> '{job,track_id}' AS track_id`,
        [body.id]
      );
      const r = rows[0];
      if (!r) return null;
      if (r.source_id) await c.query(`UPDATE enrich_sources SET received = $2, created = $2 WHERE id = $1`, [r.source_id, r.pulled]);
      return r;
    });
    if (!out) return NextResponse.json({ error: "That run is not queued or running" }, { status: 409 });
    await logAudit({ action: "aiark_run_cancel", performedBy: auth.user.id, details: `${out.client_tag}: run ${out.id} cancelled at ${out.pulled} pulled` });
    return NextResponse.json({
      cancelled: true,
      note: !out.holds_job
        ? null
        : out.track_id
          ? "AI Ark already took this run's export, so it is still charged. Its people will still be read in so nobody is lost, and no new job goes out."
          : "This run's export was already on its way to AI Ark. If AI Ark took it, it is still charged and its people will still be read in so nobody is lost. No new job goes out.",
    });
  } catch (err) {
    console.error("aiark/runs/cancel:", err);
    return NextResponse.json({ error: "Could not cancel the run" }, { status: 500 });
  }
}
