import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { resolveSelection } from "@/lib/questions/selection";
import { clientOf, variableRow } from "@/lib/questions/server";
import type { ReadinessView } from "@/lib/questions/types";
import { readinessCounts, selectionOf } from "../../../../../scripts/lib/questions/gather.mjs";

// POST /api/questions/readiness {tag, variableId, selection} (manager and up):
//      for the leads the export popup's push would send for this selection
//      (the selection is the body it would send to /api/bison/push-batch, minus
//      campaigns, force and the question fields; checked as push-batch checks
//      it), how many have a current value of the variable, an older one, an
//      error, or none, how many companies still need research, and what a job
//      would call. One read-only statement over the push set (gather.mjs
//      readinessCounts), 20 s at most: a selection too big to count in that
//      answers 504.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; variableId?: unknown; selection?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body?.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  if (!isUuid(body.variableId)) return NextResponse.json({ error: "variableId is not a variable id" }, { status: 400 });
  const variableId = body.variableId;
  try {
    const out = await withTx(
      async (c) => {
        if (!(await clientOf(c, tag))) return { status: 404, error: `${tag} is not a client` };
        const v = await variableRow(c, variableId);
        if (!v) return { status: 404, error: "No such variable" };
        const r = await resolveSelection(c, body.selection, tag);
        if (r.errors) return { status: 400, error: r.errors.join(" "), errors: r.errors };
        const counts: ReadinessView = await readinessCounts(c, selectionOf(r.selection), { id: v.id, prompt_version: Number(v.prompt_version) });
        return { counts };
      },
      { readOnly: true, timeoutMs: 20_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if ("errors" in out && out.errors?.length) answer.errors = out.errors;
      return NextResponse.json(answer, { status: out.status });
    }
    return NextResponse.json(out.counts, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if ((err as { code?: string })?.code === "57014") {
      return NextResponse.json(
        { error: "Counting this selection took too long: narrow the filters or set a lead range, then look again." },
        { status: 504 }
      );
    }
    console.error("questions/readiness POST:", err);
    return NextResponse.json({ error: "Could not count the selection" }, { status: 500 });
  }
}
