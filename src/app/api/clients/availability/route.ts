import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// GET /api/clients/availability?tag=X[&fresh=1]
//
// Available leads for a client = eligible per the client's targeting rules
// (fn_client_eligibility_conditions), contactable (valid email, not bounced),
// and never pushed for this tag. Drives the low-availability popup (<250)
// with the client's targeting summary so the operator sees WHY it's low.
//
// PRECOMPUTED FIRST (2026-09-17). This used to run a live COUNT over leads on
// every client select. For clients whose eligibility carries no location
// predicate (require_location=false, 12 clients) that is a parallel seq scan of
// the whole table: measured median 85 s, max 121 s, three of six sampled
// requests killed at the pool's 2-minute timeout — to feed an informational
// popup, while the operator waits on the filter query that actually matters.
//
// The same number (same ELIGIBLE gate, same eligibility conditions, same
// not-yet-pushed exclusion) is computed by scripts/refresh-location-coverage.mjs
// on the client-sync cron and stored as client_location_coverage.total_available,
// with one difference: it pre-filters to the client's listed states. For the 12
// no-location-requirement clients that is narrower than the live count (UJ:
// ~209k live vs 761 within its listed locations). That is accepted here: the
// popup exists to say "these locations need more leads", and since migration
// 087 the client's rule is that targeting is by location.
//
// ?fresh=1 still runs the live count, transaction-scoped and capped at 30 s.
// SET LOCAL only — a session-level SET over the transaction pooler leaks onto
// shared backends; that took the push-worker down for 51 min on 2026-09-16.
// A client with no coverage row (no location targeting) gets available: null
// and the page shows no popup: an unbounded live count for such a client is
// exactly the full-table scan this change removes.

const ELIGIBLE =
  "l.email is not null and l.email <> '' and l.is_bounced = false " +
  "and (l.validation_status in ('valid','catch_all') or l.validation_status is null)";

export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tag = request.nextUrl.searchParams.get("tag")?.trim();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";

  const admin = createAdminClient();
  try {
    const [tRes, tagRes, covRes] = await Promise.all([
      admin
        .from("client_targeting")
        .select("include_locations, exclude_locations, include_industries, include_keywords, exclude_industries, exclude_keywords, countries")
        .eq("client_tag", tag)
        .maybeSingle(),
      admin.from("client_tags").select("client_type, status").eq("tag", tag).maybeSingle(),
      admin
        .from("client_location_coverage")
        .select("total_available, computed_at, threshold")
        .eq("client_tag", tag)
        .maybeSingle(),
    ]);
    // supabase-js returns { data: null, error } instead of throwing — surface
    // a failed read as a 500 (as the old pool.query path did), otherwise a
    // broken coverage read is indistinguishable from "client has no targeting".
    const failed = [tRes, tagRes, covRes].find((r) => r.error);
    if (failed?.error) throw new Error(failed.error.message);
    const targeting = tRes.data;
    const tagRow = tagRes.data;
    const cov = covRes.data;

    let available: number | null = null;
    let basis: "precomputed" | "live" | "none" = "none";
    let computedAt: string | null = null;

    if (fresh) {
      const client = await getPool().connect();
      try {
        await client.query("begin");
        await client.query("set local statement_timeout = '30s'");
        const { rows: eligRows } = await client.query(
          `select fn_client_eligibility_conditions($1) as conds`, [tag]);
        const conds: string[] = eligRows[0]?.conds ?? [];
        const notPushed = `not exists (
          select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
          where pb.client_tag = $1 and pi.lead_id = l.id and pi.status = 'sent')`;
        const where = [ELIGIBLE, ...conds, notPushed].join(" and ");
        const { rows } = await client.query(
          `select count(*)::bigint as n from leads l where ${where}`, [tag]);
        await client.query("commit");
        available = Number(rows[0]?.n ?? 0);
        basis = "live";
        computedAt = new Date().toISOString();
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    } else if (cov && cov.total_available != null) {
      // A row with a NULL total degrades to "no popup" like the no-row case —
      // Number(null) is 0 and would fire a false "<250 available" warning.
      available = Number(cov.total_available);
      basis = "precomputed";
      computedAt = (cov.computed_at as string | null) ?? null;
    }

    return NextResponse.json({
      tag,
      available,
      basis,
      computed_at: computedAt,
      targeting: targeting ?? null,
      client_type: tagRow?.client_type ?? null,
      status: tagRow?.status ?? null,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "availability failed" }, { status: 500 });
  }
}
