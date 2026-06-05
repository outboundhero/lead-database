import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { parse } from "csv-parse/sync";
import { logAudit } from "@/lib/api/log-audit";

// POST /api/uploads/bounces
// Body: CSV text. Headers can include any columns; the `email` column is the only one we read.
// Marks every matching lead as is_bounced=true with bounce_source='emailbison_upload'.
//
// Returns { matched, unmatched, total, batchId }.

export const maxDuration = 300;

interface BounceConfig {
  emailColumnIndex: number;  // 0-based index in the CSV
  filename: string;
}

export async function POST(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Permission check — admin or owner only (bounce list is a destructive write).
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["owner", "admin"].includes(profile.role)) {
    return NextResponse.json({ error: "Admin role required" }, { status: 403 });
  }

  let config: BounceConfig;
  try {
    const configHeader = request.headers.get("X-Upload-Config");
    if (!configHeader) throw new Error("Missing X-Upload-Config header");
    config = JSON.parse(configHeader);
  } catch {
    return NextResponse.json({ error: "Invalid upload config" }, { status: 400 });
  }

  if (typeof config.emailColumnIndex !== "number" || config.emailColumnIndex < 0) {
    return NextResponse.json({ error: "emailColumnIndex must be a non-negative number" }, { status: 400 });
  }

  const csvText = await request.text();
  if (!csvText.trim()) {
    return NextResponse.json({ error: "Empty CSV body" }, { status: 400 });
  }

  // Parse — assume first row is headers, skip it
  let rows: string[][];
  try {
    rows = parse(csvText, { skip_empty_lines: true, relax_quotes: true, relax_column_count: true });
  } catch (err) {
    return NextResponse.json(
      { error: `CSV parse failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 400 },
    );
  }

  const emails = rows
    .slice(1)
    .map((r) => r[config.emailColumnIndex])
    .filter((e): e is string => typeof e === "string" && e.trim().length > 0)
    .map((e) => e.trim().toLowerCase());

  const unique = Array.from(new Set(emails));
  const total = unique.length;
  if (total === 0) {
    return NextResponse.json({ error: "No valid emails found in the email column" }, { status: 400 });
  }

  // Create the upload batch row first so the UI can poll progress.
  const { data: batch, error: batchErr } = await admin
    .from("upload_batches")
    .insert({
      filename: config.filename ?? null,
      total_rows: total,
      status: "processing",
      batch_type: "bounces",
      uploaded_by: user.id,
    })
    .select("id")
    .single();
  if (batchErr || !batch) {
    return NextResponse.json({ error: batchErr?.message ?? "Failed to create batch row" }, { status: 500 });
  }

  // Bulk mark bounced. Supabase JS doesn't have a single UPDATE ... WHERE IN ... statement
  // for large arrays cleanly; we chunk to avoid URL length limits.
  const now = new Date().toISOString();
  let matched = 0;
  const CHUNK = 1000;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const { data: updated, error: upErr } = await admin
      .from("leads")
      .update({
        is_bounced: true,
        bounced_at: now,
        bounce_source: "emailbison_upload",
      })
      .in("email", slice)
      .select("id");
    if (upErr) {
      await admin
        .from("upload_batches")
        .update({ status: "error", completed_at: new Date().toISOString() })
        .eq("id", batch.id);
      return NextResponse.json({ error: upErr.message }, { status: 500 });
    }
    matched += updated?.length ?? 0;
  }
  const unmatched = total - matched;

  await admin
    .from("upload_batches")
    .update({
      status: "complete",
      merged_rows: matched,
      skipped_rows: unmatched,
      completed_at: new Date().toISOString(),
    })
    .eq("id", batch.id);

  await logAudit({
    action: "Bounces Imported",
    details: `Marked ${matched.toLocaleString()} leads as bounced (${unmatched.toLocaleString()} emails not found). Source file: ${config.filename ?? "—"}`,
  });

  return NextResponse.json({
    matched,
    unmatched,
    total,
    batchId: batch.id,
  });
}
