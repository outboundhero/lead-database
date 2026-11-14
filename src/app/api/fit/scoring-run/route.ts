import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { logAudit } from "@/lib/api/log-audit";
import { fitRuns, idleReason, readFitSettings } from "@/lib/companies/fit";
import { createScoreRun, estimateScoreRun, runGoing } from "../../../../../scripts/lib/enrich/fit-backfill.mjs";

// GET  /api/fit/scoring-run: what scoring every company in the Email Bison copy
//      would cost (companies, calls, dollars, days at the daily fit cap), plus
//      the pipeline's companies not scored yet or scored under an old rule or
//      model, and the last scoring runs. Owner and admin.
// POST /api/fit/scoring-run {confirm: true}: starts it, after the estimate was
//      seen. The worker's fit loop walks the copy in pages, paced, and queues
//      each company once at priority 3 (scripts/lib/enrich/fit-backfill.mjs);
//      nothing is re-synced first (D40). Also the "Re-score" after the rule or
//      the model changed. Refused (409) while scoring is off, the rule or the
//      model is not set, a run is going, or the worker running is not one that
//      scores.

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  try {
    const out = await withTx(
      async (c) => {
        const s = await readFitSettings(c);
        return {
          estimate: await estimateScoreRun(c, s),
          idle_reason: idleReason(s),
          runs: await fitRuns(c, { kind: "score", limit: 5 }),
        };
      },
      { readOnly: true, timeoutMs: 30_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("fit/scoring-run GET:", err);
    return NextResponse.json({ error: "Could not work out the estimate" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: { confirm?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (body.confirm !== true) {
    return NextResponse.json({ error: "Look at the estimate first, then confirm it (confirm: true)" }, { status: 400 });
  }
  try {
    const out = await withTx(
      async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('fit-scoring-run'))`);
        const s = await readFitSettings(c);
        const idle = idleReason(s);
        if (idle) return { status: 409, error: `${idle}, so no scoring run was started.` };
        const going = await runGoing(c, "score");
        if (going) return { status: 409, error: "A scoring run is going already. Let it finish first." };
        const w = await workerState(c);
        const caps = Array.isArray(w?.info?.capabilities) ? w.info.capabilities : [];
        if (!w?.online) return { status: 409, error: "The service that scores is off, so nothing was started." };
        if (!caps.includes("fit_scoring")) {
          return { status: 409, error: "The worker running now doesn't score companies yet, so nothing was started. Deploy the latest worker first." };
        }
        const estimate = await estimateScoreRun(c, s);
        const run = await createScoreRun(c, { userId: auth.user.id, estimate });
        return { run: { id: run.id, status: run.status }, estimate };
      },
      { timeoutMs: 30_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "fit_scoring_run",
      performedBy: auth.user.id,
      details: `scoring run ${out.run.id}: about ${out.estimate.companies} companies, ${out.estimate.calls} calls, about $${out.estimate.usd}`,
    });
    return NextResponse.json(out, { status: 201 });
  } catch (err) {
    console.error("fit/scoring-run POST:", err);
    return NextResponse.json({ error: "Could not start the scoring run" }, { status: 500 });
  }
}
