import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { FilterState } from "@/types/filters";
import { DEFAULT_FILTER_STATE } from "@/types/filters";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { beginSearch, isCancelledError, readQueryId } from "@/lib/leads/query-cancel";

// Use service_role key — no RLS, no gateway timeout on RPC
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * Server-side lead filtering via Supabase RPC.
 * The fn_filter_leads_v2 function has SET statement_timeout = '120s'
 * built in, bypassing the default PostgREST gateway timeout.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const filters: FilterState = { ...DEFAULT_FILTER_STATE, ...body };

    const offset = (filters.page - 1) * filters.pageSize;
    const limit = Math.min(filters.pageSize, 200);

    // The page's query id (header) rides to the database as queryTag, so a
    // search the page gives up on can be cancelled there (migration 119).
    // Rows-only requests only: the combined path below would put one id on two
    // queries, and only old open tabs use it (they send no id).
    const queryId = req.nextUrl.searchParams.get("count") === "0" ? readQueryId(req) : null;
    const p_filters = { ...buildRpcFilters(filters), ...(queryId ? { queryTag: queryId } : {}) };
    const rowsCall = () => supabaseAdmin.rpc("fn_filter_leads_v2", {
      p_filters: { ...p_filters, skipCount: true },
      p_sort_by: filters.sortBy === "created_at" ? "" : (filters.sortBy || ""),
      p_sort_dir: filters.sortDir || "desc",
      p_limit: limit,
      p_offset: offset,
    });

    // ?count=0 — rows only. The Leads page fetches the total separately from
    // /api/leads/count, so a slow count can no longer hold the table back: a
    // 50-ending search had its rows in 2.2 s but waited on a count that ran
    // 121 s and timed out (2026-10-19). Without the parameter the response is
    // unchanged (rows + total), for any tab still running the old page.
    // A search the page has already given up on is not started; one it gives
    // up on while it runs is cancelled in the database (query-cancel.ts).
    const search = beginSearch(req, queryId);
    if (search.refused) return NextResponse.json({ error: "Search cancelled" }, { status: 409 });

    if (req.nextUrl.searchParams.get("count") === "0") {
      let rowsRes;
      try { rowsRes = await rowsCall(); } finally { search.done(); }
      if (rowsRes.error) {
        // A cancelled search (57014 "user request") is expected, not a failure.
        if (!isCancelledError(rowsRes.error)) console.error("Filter RPC error:", rowsRes.error);
        return NextResponse.json({ error: rowsRes.error.message }, { status: 500 });
      }
      return NextResponse.json({ data: rowsRes.data?.data ?? [] });
    }

    // The page of rows and the total are two expensive scans over the same
    // filtered set. Running them IN SERIES inside one RPC meant a heavy client
    // filter paid both (CCGCT: rows 4.8s THEN count 4.5s). Fire them together
    // and the wall clock is the slower of the two, not the sum.
    let rowsRes, countRes;
    try {
      [rowsRes, countRes] = await Promise.all([
        rowsCall(),
        supabaseAdmin.rpc("fn_filter_leads_count", { p_filters }),
      ]);
    } finally {
      search.done();
    }

    if (rowsRes.error) {
      if (!isCancelledError(rowsRes.error)) console.error("Filter RPC error:", rowsRes.error);
      return NextResponse.json({ error: rowsRes.error.message }, { status: 500 });
    }

    const rows = rowsRes.data?.data ?? [];
    // A failed COUNT must never fail the whole request — the table is the point.
    // Fall back to what we can prove from the page we already have.
    if (countRes.error) {
      console.error("Filter count RPC error:", countRes.error);
      return NextResponse.json({
        data: rows,
        totalCount: offset + rows.length,
        isApproximate: true,
      });
    }

    return NextResponse.json({
      data: rows,
      totalCount: countRes.data?.totalCount ?? 0,
      isApproximate: countRes.data?.isApproximate ?? false,
    });
  } catch (err) {
    console.error("Filter API error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
