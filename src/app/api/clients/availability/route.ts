import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// GET /api/clients/availability?tag=X
// Available leads for a client = eligible per the client's targeting rules
// (fn_client_eligibility_conditions), contactable (valid email, not bounced),
// and never pushed for this tag. Drives the low-availability popup (<250)
// with the client's targeting summary so the operator sees WHY it's low.

const ELIGIBLE =
  "l.email is not null and l.email <> '' and l.is_bounced = false " +
  "and (l.validation_status in ('valid','catch_all') or l.validation_status is null)";

export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tag = request.nextUrl.searchParams.get("tag")?.trim();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });

  const pool = getPool();
  try {
    const { rows: eligRows } = await pool.query(
      `select fn_client_eligibility_conditions($1) as conds`, [tag]);
    const conds: string[] = eligRows[0]?.conds ?? [];
    const notPushed = `not exists (
      select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
      where pb.client_tag = $1 and pi.lead_id = l.id and pi.status = 'sent')`;
    const where = [ELIGIBLE, ...conds, notPushed].join(" and ");
    const { rows } = await pool.query(
      `select count(*)::bigint as n from leads l where ${where}`, [tag]);
    const available = Number(rows[0]?.n ?? 0);

    const admin = createAdminClient();
    const [{ data: targeting }, { data: tagRow }] = await Promise.all([
      admin
        .from("client_targeting")
        .select("include_locations, exclude_locations, include_industries, include_keywords, exclude_industries, exclude_keywords, countries")
        .eq("client_tag", tag)
        .maybeSingle(),
      admin.from("client_tags").select("client_type, status").eq("tag", tag).maybeSingle(),
    ]);

    return NextResponse.json({
      tag,
      available,
      targeting: targeting ?? null,
      client_type: tagRow?.client_type ?? null,
      status: tagRow?.status ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "availability failed" }, { status: 500 });
  }
}
