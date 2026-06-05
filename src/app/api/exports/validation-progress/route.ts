import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Polled by the Export modal during the pre-export validation pass.
// GET /api/exports/validation-progress?jobId=<export_job_id>
// Returns:
//   { total, completed, creditsUsed, status, errorMessage, startedAt, completedAt }
// or { status: 'none' } if no validation_jobs row exists for that export yet
// (caller treats that as "not started yet" and keeps polling).

export async function GET(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("validation_jobs")
    .select("total, completed, credits_used, status, error_message, started_at, completed_at")
    .eq("export_job_id", jobId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ status: "none" });
  }

  return NextResponse.json({
    total: data.total,
    completed: data.completed,
    creditsUsed: data.credits_used,
    status: data.status,
    errorMessage: data.error_message,
    startedAt: data.started_at,
    completedAt: data.completed_at,
  });
}
