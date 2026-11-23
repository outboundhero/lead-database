import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import type { ValuesView } from "@/lib/questions/types";

// GET /api/questions/values?variableId=ID&tag=TAG&limit=20 (manager and up):
//     the newest written values of a variable, for review: the lead's company
//     and title, the value, its status and note. Never an email. With a tag,
//     only leads of that client's jobs. limit 1 to 100 (20).

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const variableId = sp.get("variableId");
  if (!isUuid(variableId)) return NextResponse.json({ error: "variableId is not a variable id" }, { status: 400 });
  const rawTag = sp.get("tag");
  const tag = rawTag ? cleanTag(rawTag) : null;
  if (tag !== null && !TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const rawLimit = sp.get("limit");
  const limit = rawLimit === null ? 20 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return NextResponse.json({ error: "limit must be a whole number from 1 to 100" }, { status: 400 });
  try {
    const rows = await withTx(
      async (c) =>
        (
          await c.query(
            `SELECT l.company, l.title, v.value, v.status, v.note, v.generated_at
               FROM lead_question_values v
               LEFT JOIN leads l ON l.id = v.lead_id
              WHERE v.variable_id = $1
                AND ($2::text IS NULL OR EXISTS (
                      SELECT 1 FROM question_jobs j JOIN question_job_items i ON i.job_id = j.id
                       WHERE j.client_tag = $2 AND j.variable_id = $1 AND i.lead_id = v.lead_id))
              ORDER BY v.generated_at DESC
              LIMIT $3`,
            [variableId, tag, limit]
          )
        ).rows,
      { readOnly: true, timeoutMs: 8_000 }
    );
    const body: ValuesView = {
      values: rows.map((r) => ({
        company: r.company ?? null,
        title: r.title ?? null,
        value: r.value ?? null,
        status: String(r.status),
        note: r.note ?? null,
        generatedAt: new Date(r.generated_at).toISOString(),
      })),
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("questions/values GET:", err);
    return NextResponse.json({ error: "Could not load the written values" }, { status: 500 });
  }
}
