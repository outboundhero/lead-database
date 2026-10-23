import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { FilterState } from "@/types/filters";
import { DEFAULT_FILTER_STATE } from "@/types/filters";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { beginSearch, readQueryId } from "@/lib/leads/query-cancel";

// POST /api/leads/count  (body: the same filters as /api/leads/filter)
//
// The Leads page's total, fetched separately from the rows
// (/api/leads/filter?count=0) so the table never waits for it, and only when
// the filters change — not on a page or sort change.
//
// fn_filter_leads_count runs under its own 120 s statement_timeout (PostgREST
// applies the function's setting). Its in-function "15 s, then the planner
// estimate" fallback never fires: SET LOCAL inside a function does not re-arm
// the timer of the statement already running, and EXCEPTION WHEN OTHERS cannot
// catch query_canceled (both measured 2026-10-19). A count that runs out of
// time therefore arrives here as SQLSTATE 57014, and is answered as
// { timedOut: true } rather than as an error — the rows are still right.
//
// Session-authed like /api/leads/column-values; the RPC is reached with the
// service key only after the caller is confirmed.
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  try {
    const filters: FilterState = { ...DEFAULT_FILTER_STATE, ...(body as Partial<FilterState>) };
    // The page's query id rides along as queryTag so a count it gives up on
    // (newer filters) can be cancelled in the database (migration 119); one it
    // gave up on before it got here is not started at all.
    const queryId = readQueryId(req);
    const search = beginSearch(req, queryId);
    if (search.refused) return NextResponse.json({ error: "Count cancelled" }, { status: 409 });
    let res;
    try {
      res = await createAdminClient().rpc("fn_filter_leads_count", {
        p_filters: { ...buildRpcFilters(filters), ...(queryId ? { queryTag: queryId } : {}) },
      });
    } finally {
      search.done();
    }
    const { data, error } = res;
    if (error) {
      // 57014 is the 120 s limit — or a cancel of a count the page abandoned,
      // whose answer nobody is waiting for.
      if (error.code === "57014") {
        return NextResponse.json({ totalCount: null, isApproximate: false, timedOut: true });
      }
      console.error("Filter count RPC error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      totalCount: data?.totalCount ?? 0,
      isApproximate: data?.isApproximate ?? false,
      timedOut: false,
    });
  } catch (err) {
    console.error("Filter count API error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
