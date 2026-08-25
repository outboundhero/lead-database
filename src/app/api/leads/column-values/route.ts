import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import type { FilterState } from "@/types/filters";
import { DEFAULT_FILTER_STATE, normalizeFilterState } from "@/types/filters";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";

// POST /api/leads/column-values  { filters, column, search? }
//
// The distinct values a table header's filter dropdown offers. They come from
// the CURRENT filtered view, not the whole table, so the list only ever shows
// values you could actually reach — the way a spreadsheet filter behaves.
//
// Session-authed (unlike /api/leads/filter, which is service-role with no
// in-route auth — see the CLAUDE.md TODO). The RPC is reached with the service
// key only after the caller is confirmed.

// Mirrors the whitelist inside fn_lead_column_values (migration 088). Name and
// email are deliberately absent: they are near-unique per row, so a value
// picker over them is meaningless. Kept here too so a bad column is a 400
// rather than a database exception.
const FILTERABLE = new Set([
  "source", "title", "company", "city", "state", "email_type", "esp",
  "category", "subcategory", "validation_status", "replies", "country",
  "seniority", "general_industry", "specific_industry", "company_size",
  "location_status", "additional_category", "postal_code", "annual_revenue",
]);

const service = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { filters?: unknown; column?: string; search?: string; limit?: number };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const column = (body.column ?? "").trim();
  if (!FILTERABLE.has(column)) {
    return NextResponse.json({ error: `Column "${column}" can't be filtered` }, { status: 400 });
  }

  const filters: FilterState = { ...DEFAULT_FILTER_STATE, ...normalizeFilterState(body.filters) };

  // Drop THIS column's own keep-list before asking for its values. Otherwise
  // unticking a value would remove it from its own dropdown and there would be
  // no way to tick it back on — the classic broken-facet bug.
  const { [column]: _self, ...others } = filters.columnFilters ?? {};
  void _self;
  const p_filters = buildRpcFilters({ ...filters, columnFilters: others });

  const { data, error } = await service.rpc("fn_lead_column_values", {
    p_filters,
    p_column: column,
    p_search: (body.search ?? "").trim(),
    p_limit: Math.min(Math.max(Number(body.limit) || 200, 1), 500),
  });

  if (error) {
    console.error("column-values RPC error:", error.message);
    // A statement timeout here must not look like a broken UI — the dropdown
    // shows the reason and the user can narrow the view and retry.
    const timedOut = /statement timeout|canceling statement/i.test(error.message);
    return NextResponse.json(
      { error: timedOut ? "Too many rows to summarise — narrow the filters and try again" : error.message },
      { status: timedOut ? 503 : 500 }
    );
  }

  return NextResponse.json({
    values: data?.values ?? [],
    distinctTotal: data?.distinct_total ?? 0,
    scanned: data?.scanned ?? 0,
    // true = counts come from a capped scan, not the full view. The UI says so
    // rather than presenting sampled counts as exact.
    sampled: !!data?.sampled,
  });
}
