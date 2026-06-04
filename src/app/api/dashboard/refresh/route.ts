import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// fn_dashboard_stats does a full GROUP BY across 19M leads. Under post-upgrade
// load (cache-cold, autovacuum) it can run 60-180s — past the Supabase HTTP
// gateway's ~60s upstream timeout. We use the direct pg pool below to bypass
// that; the function's own 300s statement_timeout is the actual ceiling.
export const maxDuration = 300;

export async function POST() {
  const supabase = createAdminClient();
  const today = new Date().toISOString().split("T")[0];

  try {
    // Ensure today's row exists
    const { data: existing } = await supabase
      .from("dashboard_snapshots")
      .select("id")
      .eq("snapshot_date", today)
      .limit(1);

    if (!existing || existing.length === 0) {
      await supabase.from("dashboard_snapshots").insert({ snapshot_date: today });
    }

    // Direct pg pool — bypasses the ~60s HTTP gateway timeout.
    const pool = getPool();
    let data: Record<string, unknown>;
    try {
      const pgResult = await pool.query<{ data: Record<string, unknown> }>(
        "SELECT fn_dashboard_stats() AS data"
      );
      data = pgResult.rows[0].data;
    } catch (err) {
      console.error("Dashboard stats RPC error:", err);
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        { status: 500 }
      );
    }

    await supabase
      .from("dashboard_snapshots")
      .update({
        total_leads: data.total_leads,
        total_job_titles: data.total_job_titles,
        leads_by_job_title: data.leads_by_job_title,
        total_general_industries: data.total_general_industries,
        leads_by_general_industry: data.leads_by_general_industry,
        total_specific_industries: data.total_specific_industries,
        leads_by_company_size: data.leads_by_company_size,
        leads_over_time: data.leads_over_time,
      })
      .eq("snapshot_date", today);

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Dashboard refresh failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
