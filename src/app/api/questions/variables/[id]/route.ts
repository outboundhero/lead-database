import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { changedFields, cleanVariableFields, copyTag, fieldsOf, lengthsText, variableRow, variableView } from "@/lib/questions/server";
import { canonicalVariableName } from "../../../../../../scripts/lib/questions/names.mjs";

// GET /api/questions/variables/<id> (manager and up): one variable, all of it,
//     and the placeholders each prompt may use.
// PUT /api/questions/variables/<id> {services?, clientContext?, researchPrompt?,
//     peoplePrompt?, generalPrompt?, maxWords?, version} (admin and up): saves
//     the fields sent (a field left out is kept). The name can't change. A
//     version other than the stored one answers 409 with `changed`; a field
//     refused answers 400 with every reason. A save that changes anything adds
//     one to version and to prompt_version (values written before are then
//     stale: still sent, and written again by the next job). Answers as GET.

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not a variable id" }, { status: 400 });
  try {
    const row = await withTx((c) => variableRow(c, id), { readOnly: true, timeoutMs: 8_000 });
    if (!row) return NextResponse.json({ error: "No such variable" }, { status: 404 });
    return NextResponse.json(variableView(row), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("questions/variables/[id] GET:", err);
    return NextResponse.json({ error: "Could not load the question variable" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not a variable id" }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  if (typeof body.version !== "number" || !Number.isInteger(body.version)) {
    return NextResponse.json({ error: "version is required: the variable's version as the page loaded it" }, { status: 400 });
  }
  const version = body.version;

  try {
    const out = await withTx(
      async (c) => {
        const current = await variableRow(c, id, { lock: true });
        if (!current) return { status: 404, error: "No such variable" };
        if (Number(current.version) !== version) {
          return { status: 409, error: `${copyTag(current.name)} was changed since this page loaded it, so nothing was saved. It now shows it as it is.`, changed: true };
        }
        if (body.name !== undefined && canonicalVariableName(body.name) !== current.name) {
          const msg = "The name can't change once the variable is made: make a new variable for a new name.";
          return { status: 400, error: msg, errors: [msg] };
        }
        const before = fieldsOf(current);
        const { value, errors } = cleanVariableFields(body, before);
        if (errors.length) return { status: 400, error: errors.join(" "), errors };
        const changed = changedFields(before, value);
        if (!changed.length) return { row: current, changed, value };
        await c.query(
          `UPDATE question_variables
              SET services = $2, client_context = $3, research_prompt = $4, people_prompt = $5, general_prompt = $6,
                  max_words = $7, version = version + 1, prompt_version = prompt_version + 1, updated_by = $8
            WHERE id = $1`,
          [id, value.services, value.client_context, value.research_prompt, value.people_prompt, value.general_prompt, value.max_words, auth.user.id]
        );
        await c.query(
          `INSERT INTO question_variable_log (variable_id, action, before, after, by_user) VALUES ($1, 'save', $2::jsonb, $3::jsonb, $4)`,
          [id, JSON.stringify(before), JSON.stringify(value), auth.user.id]
        );
        return { row: (await variableRow(c, id))!, changed, value };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if ("errors" in out && out.errors?.length) answer.errors = out.errors;
      if ("changed" in out && out.changed === true) answer.changed = true;
      return NextResponse.json(answer, { status: out.status });
    }
    if (out.changed.length) {
      await logAudit({
        action: "question_variable",
        performedBy: auth.user.id,
        details: `${copyTag(out.row.name)} saved (${out.changed.join(", ")} changed; prompt version ${out.row.prompt_version}): ${lengthsText(out.value)}`,
      });
    }
    return NextResponse.json(variableView(out.row));
  } catch (err) {
    console.error("questions/variables/[id] PUT:", err);
    return NextResponse.json({ error: "Could not save the question variable" }, { status: 500 });
  }
}
