import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// List queued Bison push batches (newest first) for the batch-progress UI.
// Any authenticated user can view; queueing/cancelling stay role-gated.

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawLimit = request.nextUrl.searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      return NextResponse.json(
        { error: `limit must be an integer between 1 and ${MAX_LIMIT}` },
        { status: 400 }
      );
    }
    limit = parsed;
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("push_batches")
    .select("id, campaigns, total, processed, sent, failed, skipped, status, error, created_at, completed_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    return NextResponse.json(
      { error: `Failed to load push batches: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ batches: data ?? [] });
}
