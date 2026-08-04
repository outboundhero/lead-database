import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { normalizeFilterState } from "@/types/filters";

// POST /api/bison/push-stats  { clientTag, filters?, selectedIds? }
//
// Pre-push accounting for one client tag (client req #8):
//   matching      — leads the current selection/filters resolve to (eligible)
//   alreadyPushed — of those, ever 'sent' in ANY batch carrying this tag
//   notPushed     — matching - alreadyPushed
//   newSinceLast  — matching leads created after the tag's last batch
//   failedForTag  — leads whose latest attempt for this tag failed (retryable)
//   lastExportAt  — when the tag's last batch was queued
//
// "Pushed" is defined per client tag across every batch with that tag —
// pushes to unrelated clients never count.

// Must mirror the push-worker's gather eligibility exactly.
const ELIGIBLE =
  "l.email is not null and l.email <> '' and l.is_bounced = false " +
  "and (l.validation_status in ('valid','catch_all') or l.validation_status is null)";

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { clientTag?: string; filters?: unknown; selectedIds?: string[] };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const clientTag = (body.clientTag ?? "").trim();
  if (!clientTag) return NextResponse.json({ error: "clientTag required" }, { status: 400 });
  const hasIds = Array.isArray(body.selectedIds) && body.selectedIds.length > 0;
  if (!hasIds && !body.filters) return NextResponse.json({ error: "Provide selectedIds or filters" }, { status: 400 });

  const pool = getPool();
  try {
    // The same trusted WHERE the gather stage will use.
    let where: string;
    const params: unknown[] = [];
    if (hasIds) {
      params.push(body.selectedIds);
      where = `l.id = any($1::uuid[]) and ${ELIGIBLE}`;
    } else {
      const pf = { ...buildRpcFilters(normalizeFilterState(body.filters)), applyClientTargeting: clientTag };
      const { rows } = await pool.query(`select fn_lead_filter_conditions($1::jsonb) as conds`, [JSON.stringify(pf)]);
      where = [...(rows[0]?.conds ?? []), ELIGIBLE].join(" and ");
    }

    const tagParam = params.length + 1;
    params.push(clientTag);
    const pushedExists = `exists (
      select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
      where pb.client_tag = $${tagParam} and pi.lead_id = l.id and pi.status = 'sent')`;
    const failedExists = `exists (
      select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
      where pb.client_tag = $${tagParam} and pi.lead_id = l.id and pi.status = 'failed')`;

    const { rows: [last] } = await pool.query(
      `select max(created_at) as at from push_batches where client_tag = $1 and status in ('processing','complete')`,
      [clientTag]);
    const lastAt = last?.at ? new Date(last.at).toISOString() : null;
    const sinceCond = lastAt ? `l.created_at > '${lastAt}'::timestamptz` : "false";

    const { rows: [stats] } = await pool.query(
      `select count(*)::bigint as matching,
              count(*) filter (where ${pushedExists})::bigint as already_pushed,
              count(*) filter (where ${sinceCond})::bigint as new_since_last,
              count(*) filter (where ${failedExists} and not ${pushedExists})::bigint as failed_for_tag
         from leads l where ${where}`,
      params);

    const matching = Number(stats?.matching ?? 0);
    const alreadyPushed = Number(stats?.already_pushed ?? 0);
    return NextResponse.json({
      clientTag,
      matching,
      alreadyPushed,
      notPushed: matching - alreadyPushed,
      newSinceLast: lastAt ? Number(stats?.new_since_last ?? 0) : matching,
      failedForTag: Number(stats?.failed_for_tag ?? 0),
      lastExportAt: lastAt,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "stats failed" }, { status: 500 });
  }
}
