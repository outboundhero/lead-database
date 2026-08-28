import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { normalizeFilterState } from "@/types/filters";

// POST /api/bison/push-forecast
//   { clientTag, campaigns: [{id, instance_url}], filters? | selectedIds? }
//
// How many of these leads would ACTUALLY be added to the chosen campaigns, and
// how many are already in them.
//
// This is a different question from /api/bison/push-stats, which reports what
// WE have sent for a client tag. Our push history cannot see a lead that
// reached a campaign any other way — a Clay import, a manual upload, an older
// tool — and those are exactly the duplicates that make a push land smaller
// than expected. Campaign membership comes from bison_leads, which is Bison's
// own lead_campaign_data.
//
// Honest about coverage: campaign membership is only known for installs that
// have been mirrored. Instances without mirror data are named in the response
// rather than being quietly treated as "no duplicates".

const ELIGIBLE =
  "l.email is not null and l.email <> '' and l.is_bounced = false and l.is_suppressed = false " +
  "and (l.validation_status in ('valid','catch_all') or l.validation_status is null)";

interface TargetCampaign { id: number | string; instance_url?: string }

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { clientTag?: string; campaigns?: TargetCampaign[]; filters?: unknown; selectedIds?: string[] };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const clientTag = (body.clientTag ?? "").trim();
  const campaigns = Array.isArray(body.campaigns) ? body.campaigns : [];
  if (campaigns.length === 0) return NextResponse.json({ error: "campaigns required" }, { status: 400 });
  const hasIds = Array.isArray(body.selectedIds) && body.selectedIds.length > 0;
  if (!hasIds && !body.filters) return NextResponse.json({ error: "Provide selectedIds or filters" }, { status: 400 });

  // Campaign ids are per-install: id 43 on one install is a different campaign
  // from id 43 on another, so they are grouped and matched with the instance.
  const byInstance = new Map<string, number[]>();
  for (const c of campaigns) {
    const inst = String(c.instance_url ?? "").trim().toLowerCase();
    const id = Number(c.id);
    if (!inst || !Number.isFinite(id)) continue;
    if (!byInstance.has(inst)) byInstance.set(inst, []);
    byInstance.get(inst)!.push(id);
  }
  if (byInstance.size === 0) return NextResponse.json({ error: "campaigns need an instance_url" }, { status: 400 });

  const pool = getPool();
  try {
    const params: unknown[] = [];
    let where: string;
    if (hasIds) {
      params.push(body.selectedIds);
      where = `l.id = any($1::uuid[]) and ${ELIGIBLE}`;
    } else {
      const pf = {
        ...buildRpcFilters(normalizeFilterState(body.filters)),
        ...(clientTag ? { applyClientTargeting: clientTag } : {}),
      };
      const { rows } = await pool.query(`select fn_lead_filter_conditions($1::jsonb) as conds`, [JSON.stringify(pf)]);
      where = [...(rows[0]?.conds ?? []), ELIGIBLE].join(" and ");
    }

    // Which of the target installs do we actually hold campaign data for?
    const instances = [...byInstance.keys()];
    const { rows: covRows } = await pool.query(
      `select instance_url, count(*)::bigint n from bison_leads
        where instance_url = any($1::text[]) group by 1`, [instances]);
    const covered = new Map(covRows.map((r) => [r.instance_url as string, Number(r.n)]));
    const unknownInstances = instances.filter((i) => !covered.has(i));

    const memberClauses: string[] = [];
    for (const [inst, ids] of byInstance) {
      if (!covered.has(inst)) continue; // no data — cannot claim anything about it
      params.push(inst); const pInst = params.length;
      params.push(ids);  const pIds = params.length;
      memberClauses.push(`(b.instance_url = $${pInst} and b.campaign_ids && $${pIds}::bigint[])`);
    }

    const alreadyExpr = memberClauses.length
      ? `exists (select 1 from bison_leads b where b.email = l.email and (${memberClauses.join(" or ")}))`
      : "false";

    const started = Date.now();
    const { rows: [stats] } = await pool.query(
      `select count(*)::bigint as matching,
              count(*) filter (where ${alreadyExpr})::bigint as already_in_campaigns
         from leads l where ${where}`,
      params
    );

    const matching = Number(stats?.matching ?? 0);
    const alreadyIn = Number(stats?.already_in_campaigns ?? 0);
    return NextResponse.json({
      clientTag: clientTag || null,
      matching,
      alreadyInCampaigns: alreadyIn,
      netNew: matching - alreadyIn,
      campaignCount: campaigns.length,
      // Never let a partially-mirrored answer read as a complete one.
      coverage: {
        known: [...covered.keys()],
        unknown: unknownInstances,
        complete: unknownInstances.length === 0,
      },
      tookMs: Date.now() - started,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "forecast failed" }, { status: 500 });
  }
}
