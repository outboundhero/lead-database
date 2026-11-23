import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { resolveSelection } from "@/lib/questions/selection";
import { clientOf, copyTag, JOB_COLUMNS, jobViewOf, questionSettingsNow, questionWorker, variableRow } from "@/lib/questions/server";
import type { JobsView } from "@/lib/questions/types";
import { questionSwitchOn } from "../../../../../scripts/lib/questions/settings.mjs";
import { JOB_CAP } from "../../../../../scripts/lib/questions/gather.mjs";

// GET  /api/questions/jobs?tag=TAG (manager and up): the client's 20 newest
//      question jobs, with their progress, spend, and the note that says why
//      one waits.
// POST /api/questions/jobs {tag, variableId, selection, rewrite?, maxLeads?}
//      (manager and up): asks the enrich-worker to write the variable for the
//      leads the export popup is about to push (the selection as readiness
//      takes it). The worker gathers them, leaving out leads that already hold
//      a current value unless rewrite, at most maxLeads (1 to 250,000, the
//      default). 409 while the worker running lacks question_jobs, while
//      question variables are off for the client, and while a job of the same
//      client and variable is still open. The selection is stored as the push
//      batch would store it.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const rows = await withTx(
      async (c) =>
        (
          await c.query(
            `SELECT ${JOB_COLUMNS}
               FROM question_jobs j JOIN question_variables v ON v.id = j.variable_id
              WHERE j.client_tag = $1
              ORDER BY j.created_at DESC
              LIMIT 20`,
            [tag]
          )
        ).rows,
      { readOnly: true, timeoutMs: 8_000 }
    );
    const body: JobsView = { jobs: rows.map(jobViewOf) };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("questions/jobs GET:", err);
    return NextResponse.json({ error: "Could not load the question jobs" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; variableId?: unknown; selection?: unknown; rewrite?: unknown; maxLeads?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body?.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  if (!isUuid(body.variableId)) return NextResponse.json({ error: "variableId is not a variable id" }, { status: 400 });
  const variableId = body.variableId;
  if (body.rewrite !== undefined && typeof body.rewrite !== "boolean") return NextResponse.json({ error: "rewrite must be true or false" }, { status: 400 });
  const maxLeads = body.maxLeads ?? null;
  if (maxLeads !== null && (typeof maxLeads !== "number" || !Number.isInteger(maxLeads) || maxLeads < 1 || maxLeads > JOB_CAP)) {
    return NextResponse.json({ error: `maxLeads must be a whole number from 1 to ${JOB_CAP.toLocaleString("en-US")}` }, { status: 400 });
  }
  const rewrite = body.rewrite === true;

  try {
    const out = await withTx(
      async (c) => {
        if (!(await clientOf(c, tag))) return { status: 404, error: `${tag} is not a client` };
        const v = await variableRow(c, variableId);
        if (!v) return { status: 404, error: "No such variable" };
        const name = copyTag(v.name);
        if (v.archived_at != null) return { status: 400, error: `${name} is archived: restore it to write it` };
        if (!v.research_prompt.trim() || (!v.people_prompt.trim() && !v.general_prompt.trim())) {
          return { status: 400, error: `${name} needs its research prompt and a question prompt before it can be written (Clay tab, Client setup)` };
        }
        const r = await resolveSelection(c, body.selection, tag);
        if (r.errors) return { status: 400, error: r.errors.join(" "), errors: r.errors };
        const worker = await questionWorker(c);
        if (!worker?.online) return { status: 409, error: "The worker that writes questions is off, so nothing was started." };
        if (!worker.ready) {
          return { status: 409, error: "The worker running doesn't write question variables yet, so nothing was started. Deploy the latest worker first." };
        }
        const { qs } = await questionSettingsNow(c);
        if (!questionSwitchOn(qs, tag)) {
          return { status: 409, error: `Question variables are off for ${tag} (turn them on under Companies tab, Settings), so nothing was started.` };
        }
        const { rows: open } = await c.query<{ id: string }>(
          `SELECT id FROM question_jobs
            WHERE client_tag = $1 AND variable_id = $2 AND status IN ('queued', 'gathering', 'running', 'paused')
            LIMIT 1`,
          [tag, variableId]
        );
        if (open.length) return { status: 409, error: `A job is already writing ${name} for ${tag}: let it finish, or cancel it first.` };
        const { rows: [job] } = await c.query<{ id: string }>(
          `INSERT INTO question_jobs (variable_id, client_tag, selection, rewrite, max_leads, created_by)
           VALUES ($1, $2, $3::jsonb, $4, $5, $6)
           RETURNING id`,
          [variableId, tag, JSON.stringify(r.selection), rewrite, maxLeads, auth.user.id]
        );
        return { jobId: job.id, name, ids: r.selection.selected_ids?.length ?? null };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if ("errors" in out && out.errors?.length) answer.errors = out.errors;
      return NextResponse.json(answer, { status: out.status });
    }
    await logAudit({
      action: "question_job",
      performedBy: auth.user.id,
      details: `${out.name} for ${tag}: job ${out.jobId} queued over ${out.ids === null ? "the filters" : `${out.ids} selected leads`}` +
        `${rewrite ? ", rewriting current values" : ""}${maxLeads !== null ? `, at most ${maxLeads} leads` : ""}`,
    });
    return NextResponse.json({ jobId: out.jobId });
  } catch (err) {
    console.error("questions/jobs POST:", err);
    return NextResponse.json({ error: "Could not start the question job" }, { status: 500 });
  }
}
