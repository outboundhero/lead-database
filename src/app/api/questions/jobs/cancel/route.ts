import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { copyTag, JOB_COLUMNS, jobViewOf } from "@/lib/questions/server";
import type { JobView } from "@/lib/questions/types";

// POST /api/questions/jobs/cancel {jobId} (manager and up): stops an open
//      question job. Values already written stay; a lead the worker is writing
//      at that moment is finished (its call is paid) and the slice stops.
//      Answers { cancelled: true, job }; 409 when the job had already finished.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { jobId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!isUuid(body?.jobId)) return NextResponse.json({ error: "jobId is not a job id" }, { status: 400 });
  const jobId = body.jobId;
  try {
    const out = await withTx(
      async (c) => {
        const { rowCount } = await c.query(
          `UPDATE question_jobs
              SET status = 'cancelled', completed_at = now(), note = NULL
            WHERE id = $1 AND status IN ('queued', 'gathering', 'running', 'paused')`,
          [jobId]
        );
        const { rows: [row] } = await c.query(
          `SELECT ${JOB_COLUMNS}, j.client_tag FROM question_jobs j JOIN question_variables v ON v.id = j.variable_id WHERE j.id = $1`,
          [jobId]
        );
        if (!row) return { status: 404, error: "No such job" };
        if (!rowCount) return { status: 409, error: `That job had already ${row.status === "cancelled" ? "been cancelled" : `ended (${row.status})`}` };
        return { job: jobViewOf(row), tag: String(row.client_tag) };
      },
      { timeoutMs: 8_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "question_job",
      performedBy: auth.user.id,
      details: `${copyTag(out.job.variableName)} for ${out.tag}: job ${out.job.id} cancelled after ${out.job.done} of ${out.job.total} written`,
    });
    const answer: { cancelled: true; job: JobView } = { cancelled: true, job: out.job };
    return NextResponse.json(answer);
  } catch (err) {
    console.error("questions/jobs/cancel POST:", err);
    return NextResponse.json({ error: "Could not cancel the job" }, { status: 500 });
  }
}
