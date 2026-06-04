import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { FilterState } from "@/types/filters";
import { DEFAULT_FILTER_STATE } from "@/types/filters";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";

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

    const p_filters = buildRpcFilters(filters);

    const { data, error } = await supabaseAdmin.rpc("fn_filter_leads_v2", {
      p_filters,
      p_sort_by: filters.sortBy === "created_at" ? "" : (filters.sortBy || ""),
      p_sort_dir: filters.sortDir || "desc",
      p_limit: limit,
      p_offset: offset,
    });

    if (error) {
      console.error("Filter RPC error:", error);
      return NextResponse.json(
        { error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({
      data: data?.data ?? [],
      totalCount: data?.totalCount ?? 0,
      isApproximate: data?.isApproximate ?? false,
    });
  } catch (err) {
    console.error("Filter API error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
