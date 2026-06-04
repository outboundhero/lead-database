import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { filters, columnSelection, limit, rangeFrom, rangeTo, action, jobId, rowCount } = body;
  const adminSupabase = createAdminClient();

  if (action === "start") {
    // Self-heal stuck 'processing' rows before checking the queue. Zombies
    // happen when Next.js maxDuration (600s) terminates the streaming
    // function, or Railway redeploys, or the server crashes mid-stream — in
    // all those cases the JS catch block can't run, so the row stays
    // 'processing' forever and counts toward the concurrent limit. Without
    // this cleanup, zombies accumulate and eventually fill all 4 queue
    // slots, blocking new exports indefinitely. Threshold of 15 min gives
    // legitimate slow exports buffer beyond the 600s maxDuration ceiling.
    await adminSupabase
      .from("export_jobs")
      .update({
        status: "error",
        completed_at: new Date().toISOString(),
      })
      .eq("status", "processing")
      .lt("created_at", new Date(Date.now() - 15 * 60 * 1000).toISOString());

    // Cap concurrent exports — each fn_export_leads call burns CPU on the
    // shared Supabase instance. Letting too many run in parallel makes them
    // all glacial. Queue at 4 (sized for 2XL's 8 cores ≈ 2 cores per export).
    // Client retries on 429 with a "Queued" toast, so users wait their turn
    // instead of seeing a hard error.
    const { count: running } = await adminSupabase
      .from("export_jobs")
      .select("*", { count: "exact", head: true })
      .eq("status", "processing");

    if ((running ?? 0) >= 4) {
      return NextResponse.json(
        { error: "Too many exports running. Wait for one to finish, then try again." },
        { status: 429 }
      );
    }

    const { data: job } = await adminSupabase
      .from("export_jobs")
      .insert({
        requested_by: user.id,
        filters_used: {
          _meta: {
            exported_by: user.email ?? "unknown",
            export_type: "stream",
            rangeFrom: rangeFrom ?? null,
            rangeTo: rangeTo ?? null,
            limit: limit ?? null,
          },
          ...filters,
        } as unknown as Record<string, unknown>,
        column_selection: columnSelection,
        status: "processing",
      })
      .select("id")
      .single();

    return NextResponse.json({ jobId: job?.id });
  }

  if (action === "complete" && jobId) {
    const { data: job } = await adminSupabase
      .from("export_jobs")
      .select("id, created_at")
      .eq("id", jobId)
      .single();

    if (job) {
      const durationSec = Math.round((Date.now() - new Date(job.created_at).getTime()) / 1000);
      await adminSupabase
        .from("export_jobs")
        .update({
          status: "complete",
          row_count: rowCount ?? null,
          duration_seconds: durationSec,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Invalid action" }, { status: 400 });
}
