import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanPeopleFilters, cleanTag, TAG_RE } from "@/lib/aiark/server";

// PUT /api/aiark/people-filters {tag, filters} — saves a client's people
// filters for the AI Ark tab (client_people_filters): job titles, seniority,
// departments, company size, industries. The client sheets carry none of
// these, and nothing here writes to a sheet. Manager and up.

export const dynamic = "force-dynamic";

export async function PUT(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; filters?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const { value: f, errors } = cleanPeopleFilters(body.filters);
  if (errors.length) return NextResponse.json({ error: errors.join(" · "), errors }, { status: 400 });

  try {
    const out = await withTx(async (c) => {
      const { rows: known } = await c.query(`SELECT 1 FROM client_tags WHERE tag = $1`, [tag]);
      if (!known.length) return { error: `${tag} is not a client` };
      const { rows } = await c.query(
        `INSERT INTO client_people_filters
                (client_tag, titles, title_mode, exclude_titles, seniority, departments, employee_bands, industries, exclude_industries, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (client_tag) DO UPDATE
           SET titles = EXCLUDED.titles, title_mode = EXCLUDED.title_mode, exclude_titles = EXCLUDED.exclude_titles,
               seniority = EXCLUDED.seniority, departments = EXCLUDED.departments, employee_bands = EXCLUDED.employee_bands,
               industries = EXCLUDED.industries, exclude_industries = EXCLUDED.exclude_industries, updated_by = EXCLUDED.updated_by
         RETURNING updated_at`,
        [tag, f.titles, f.title_mode, f.exclude_titles, f.seniority, f.departments, JSON.stringify(f.employee_bands), f.industries, f.exclude_industries, auth.user.id]
      );
      return { updatedAt: rows[0].updated_at as string };
    });
    if ("error" in out) return NextResponse.json(out, { status: 404 });
    await logAudit({
      action: "aiark_people_filters",
      performedBy: auth.user.id,
      details: `${tag}: ${f.titles.length} titles (${f.title_mode}), ${f.exclude_titles.length} excluded titles, seniority [${f.seniority.join(", ")}], ${f.departments.length} departments, ${f.employee_bands.length} size bands, ${f.industries.length}/${f.exclude_industries.length} industries`,
    });
    return NextResponse.json({ saved: true, updatedAt: out.updatedAt, value: f });
  } catch (err) {
    console.error("aiark/people-filters:", err);
    return NextResponse.json({ error: "Could not save the people filters" }, { status: 500 });
  }
}
