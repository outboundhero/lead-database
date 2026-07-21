import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Cancel a queued Bison push batch. Only flips status while the batch is still
// pending/gathering/processing — the worker checks status between chunks and
// stops; already-pushed leads stay in Bison (there is no un-push).

const CANCELLABLE = ["pending", "gathering", "processing"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Same role gate as queueing a batch.
  const { data: profile } = await admin
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json(
      { error: "Only owners, admins, and managers can cancel Bison push batches" },
      { status: 403 }
    );
  }

  let body: { batchId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.batchId !== "string" || !UUID_RE.test(body.batchId)) {
    return NextResponse.json({ error: "batchId (uuid) is required" }, { status: 400 });
  }

  // Conditional update so a batch finishing concurrently can't be flipped
  // back to cancelled after the fact.
  const { data: updated, error: updateError } = await admin
    .from("push_batches")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", body.batchId)
    .in("status", CANCELLABLE)
    .select("id")
    .maybeSingle();
  if (updateError) {
    return NextResponse.json(
      { error: `Failed to cancel push batch: ${updateError.message}` },
      { status: 500 }
    );
  }
  if (updated) {
    return NextResponse.json({ cancelled: true, batchId: updated.id });
  }

  // Nothing updated — distinguish "unknown batch" from "no longer cancellable".
  const { data: batch, error: fetchError } = await admin
    .from("push_batches")
    .select("id, status")
    .eq("id", body.batchId)
    .maybeSingle();
  if (fetchError) {
    return NextResponse.json(
      { error: `Failed to load push batch: ${fetchError.message}` },
      { status: 500 }
    );
  }
  if (!batch) {
    return NextResponse.json({ error: "Push batch not found" }, { status: 404 });
  }
  return NextResponse.json(
    { error: `Batch is ${batch.status} and can no longer be cancelled` },
    { status: 409 }
  );
}
