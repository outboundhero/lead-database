import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { clientOf, copyTag, variableRow, variablesView } from "@/lib/questions/server";

// PUT /api/questions/client {tag, variableId} (manager and up): which question
//     variable the client's pushes use; null is the default {QUESTION}. An
//     archived variable can't be chosen. Answers as GET
//     /api/questions/variables?tag=TAG. The export popup and the Clay tab both
//     save the choice here; a push still names its variable itself.

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; variableId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body?.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const variableId = body.variableId ?? null;
  if (variableId !== null && !isUuid(variableId)) {
    return NextResponse.json({ error: "variableId must be a variable's id, or null for the default {QUESTION}" }, { status: 400 });
  }

  try {
    const out = await withTx(
      async (c) => {
        const client = await clientOf(c, tag);
        if (!client) return { status: 404, error: `${tag} is not a client` };
        let label = "the default {QUESTION}";
        if (variableId) {
          const v = await variableRow(c, variableId);
          if (!v) return { status: 400, error: "No such variable" };
          if (v.archived_at != null) return { status: 400, error: `${copyTag(v.name)} is archived: restore it, or pick another` };
          label = copyTag(v.name);
        }
        const { rows: [was] } = await c.query<{ variable_id: string | null }>(
          `SELECT variable_id FROM client_question_settings WHERE client_tag = $1 FOR UPDATE`,
          [tag]
        );
        const changed = !was || (was.variable_id ?? null) !== variableId;
        if (changed) {
          await c.query(
            `INSERT INTO client_question_settings (client_tag, variable_id, updated_by) VALUES ($1, $2, $3)
             ON CONFLICT (client_tag) DO UPDATE SET variable_id = EXCLUDED.variable_id, updated_by = EXCLUDED.updated_by`,
            [tag, variableId, auth.user.id]
          );
        }
        return { body: await variablesView(c, client), changed, label };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    if (out.changed) {
      await logAudit({ action: "question_variable_client", performedBy: auth.user.id, details: `${tag} uses ${out.label}` });
    }
    return NextResponse.json(out.body);
  } catch (err) {
    console.error("questions/client PUT:", err);
    return NextResponse.json({ error: "Could not save the client's question" }, { status: 500 });
  }
}
