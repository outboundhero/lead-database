import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import {
  cleanVariableFields,
  clientOf,
  EMPTY_FIELDS,
  fieldsOf,
  lengthsText,
  questionSettingsNow,
  variableRow,
  variablesView,
  variableView,
} from "@/lib/questions/server";
import { canonicalVariableName, copyTag, variableNameError } from "../../../../../scripts/lib/questions/names.mjs";

// GET  /api/questions/variables?tag=TAG (manager and up): the client's
//      question variable choice and every variable (its own first), whether it
//      is an OS client, whether question variables are on for it, and whether
//      the worker running writes question jobs.
// POST /api/questions/variables {tag, name, services, clientContext,
//      researchPrompt, peoplePrompt, generalPrompt, maxWords?, copyFromId?}
//      (admin and up): makes a variable for the client. The name is stored as
//      Bison stores a custom variable's (lower case, spaces squeezed, braces
//      dropped) and can't change afterwards; copyFromId fills every field the
//      body leaves out from another variable. Every prompt's placeholders are
//      checked (400 names each unknown one). Answers as GET
//      /api/questions/variables/<id>, 201. The log keeps the fields; the audit
//      log only their lengths.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => {
        const client = await clientOf(c, tag);
        if (!client) return { status: 404, error: `${tag} is not a client` };
        return { body: await variablesView(c, client) };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(out.body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("questions/variables GET:", err);
    return NextResponse.json({ error: "Could not load the question variables" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const name = canonicalVariableName(body.name);
  const copyFromId = body.copyFromId === undefined || body.copyFromId === null || body.copyFromId === "" ? null : body.copyFromId;
  if (copyFromId !== null && !isUuid(copyFromId)) return NextResponse.json({ error: "copyFromId is not a variable id" }, { status: 400 });

  try {
    const out = await withTx(
      async (c) => {
        if (!(await clientOf(c, tag))) return { status: 404, error: `${tag} is not a client` };
        // A new variable starts from the setting's max words (the sheet's "Max words"), unless it copies another.
        let base = { ...EMPTY_FIELDS, max_words: (await questionSettingsNow(c)).qs.max_words };
        if (copyFromId) {
          const from = await variableRow(c, copyFromId as string);
          if (!from) return { status: 400, error: "The variable to start from no longer exists", errors: ["The variable to start from no longer exists"] };
          base = fieldsOf(from);
        }
        const { value, errors } = cleanVariableFields(body, base);
        const nameError = variableNameError(name);
        if (nameError) errors.unshift(nameError);
        else {
          const { rows } = await c.query(`SELECT 1 FROM question_variables WHERE name = $1`, [name]);
          if (rows.length) errors.unshift(`A variable named ${copyTag(name)} already exists: pick it from the list, or give this one another name.`);
        }
        if (errors.length) return { status: 400, error: errors.join(" "), errors };
        const { rows: [made] } = await c.query<{ id: string }>(
          `INSERT INTO question_variables (name, created_for_tag, services, client_context, research_prompt, people_prompt,
                                           general_prompt, max_words, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
           RETURNING id`,
          [name, tag, value.services, value.client_context, value.research_prompt, value.people_prompt, value.general_prompt,
            value.max_words, auth.user.id]
        );
        await c.query(
          `INSERT INTO question_variable_log (variable_id, action, before, after, by_user) VALUES ($1, 'create', NULL, $2::jsonb, $3)`,
          [made.id, JSON.stringify({ name, created_for_tag: tag, ...value }), auth.user.id]
        );
        const row = await variableRow(c, made.id);
        return { row: row!, value, copied: copyFromId !== null };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if ("errors" in out && out.errors?.length) answer.errors = out.errors;
      return NextResponse.json(answer, { status: out.status });
    }
    await logAudit({
      action: "question_variable",
      performedBy: auth.user.id,
      details: `${copyTag(out.row.name)} made for ${tag}${out.copied ? " (started from another variable)" : ""}: ${lengthsText(out.value)}`,
    });
    return NextResponse.json(variableView(out.row), { status: 201 });
  } catch (err) {
    if ((err as { code?: string })?.code === "23505") {
      const msg = `A variable named ${copyTag(name)} already exists: pick it from the list, or give this one another name.`;
      return NextResponse.json({ error: msg, errors: [msg] }, { status: 400 });
    }
    console.error("questions/variables POST:", err);
    return NextResponse.json({ error: "Could not make the question variable" }, { status: 500 });
  }
}
