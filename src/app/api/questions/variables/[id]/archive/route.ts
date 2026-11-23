import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { copyTag, variableRow, variableView } from "@/lib/questions/server";

// POST /api/questions/variables/<id>/archive {archived, version} (admin and
//      up): archives a variable (it is kept, with its values, but a push can't
//      name it and its open jobs wait, paused) or restores it. A version other
//      than the stored one answers 409 with `changed`. Answers as GET
//      /api/questions/variables/<id>. Clients that use it keep it as their
//      choice; the Clay tab says it is archived.

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "Not a variable id" }, { status: 400 });
  let body: { archived?: unknown; version?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (typeof body?.archived !== "boolean") return NextResponse.json({ error: "archived must be true or false" }, { status: 400 });
  if (typeof body.version !== "number" || !Number.isInteger(body.version)) {
    return NextResponse.json({ error: "version is required: the variable's version as the page loaded it" }, { status: 400 });
  }
  const archived = body.archived;
  const version = body.version;

  try {
    const out = await withTx(
      async (c) => {
        const current = await variableRow(c, id, { lock: true });
        if (!current) return { status: 404, error: "No such variable" };
        if (Number(current.version) !== version) {
          return { status: 409, error: `${copyTag(current.name)} was changed since this page loaded it, so nothing was done. It now shows it as it is.`, changed: true };
        }
        const was = current.archived_at != null;
        if (was === archived) return { row: current, changed: false };
        await c.query(
          `UPDATE question_variables
              SET archived_at = CASE WHEN $2::boolean THEN now() ELSE NULL END, version = version + 1, updated_by = $3
            WHERE id = $1`,
          [id, archived, auth.user.id]
        );
        await c.query(
          `INSERT INTO question_variable_log (variable_id, action, before, after, by_user) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)`,
          [id, archived ? "archive" : "restore", JSON.stringify({ archived: was }), JSON.stringify({ archived }), auth.user.id]
        );
        return { row: (await variableRow(c, id))!, changed: true };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if ("changed" in out && out.changed === true) answer.changed = true;
      return NextResponse.json(answer, { status: out.status });
    }
    if (out.changed) {
      await logAudit({
        action: "question_variable",
        performedBy: auth.user.id,
        details: `${copyTag(out.row.name)} ${archived ? "archived" : "restored"}`,
      });
    }
    return NextResponse.json(variableView(out.row));
  } catch (err) {
    console.error("questions/variables/[id]/archive POST:", err);
    return NextResponse.json({ error: "Could not change the question variable" }, { status: 500 });
  }
}
