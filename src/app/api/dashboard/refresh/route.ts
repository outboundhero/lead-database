import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";

// fn_dashboard_stats aggregates across all leads and upserts today's snapshot
// (including the `stats` JSONB) itself. We call it via the direct pg pool to
// bypass the Supabase HTTP gateway's ~60s timeout; the function's own 300s
// statement_timeout is the actual ceiling.
export const maxDuration = 300;

export async function POST() {
  try {
    const pool = getPool();
    await pool.query("SELECT fn_dashboard_stats()");
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Dashboard refresh failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
