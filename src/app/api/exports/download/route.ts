import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Final export files are named export_<jobId>.csv (see exports/process). Part
// files and anything else in the bucket are not downloadable through here.
const EXPORT_FILE_PATTERN =
  /^export_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/i;

export async function GET(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const filePath = request.nextUrl.searchParams.get("file");
  if (!filePath) {
    return NextResponse.json({ error: "Missing file parameter" }, { status: 400 });
  }
  if (filePath.includes("..") || filePath.startsWith("/") || !EXPORT_FILE_PATTERN.test(filePath)) {
    return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // The signed URL is minted with the service role, so enforce the export_jobs
  // RLS rule here too: the requester owns the job, or is admin/owner.
  const { data: job } = await supabase
    .from("export_jobs")
    .select("id, requested_by")
    .eq("file_path", filePath)
    .maybeSingle();

  if (!job) {
    return NextResponse.json({ error: "Export not found" }, { status: 404 });
  }

  if (job.requested_by !== user.id) {
    const { data: profile } = await supabase
      .from("user_profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || !["owner", "admin"].includes(profile.role)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { data, error } = await supabase.storage
    .from("csv-exports")
    .createSignedUrl(filePath, 3600);

  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to generate download link" },
      { status: 500 }
    );
  }

  return NextResponse.json({ url: data.signedUrl });
}
