import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/api/log-audit";
import { getPool } from "@/lib/db/pool";

// POST /api/clients/sync-rules/revert  { jobId }
//
// Puts every client this job touched back to exactly the rules it had before.
//
// WHY THIS EXISTS: re-parsing the onboarding text is not deterministic. Measured
// on client Q with byte-identical sheet text, a re-run moved include_locations
// 8 -> 18 and exclude_industries 2 -> 16, adding whole categories (Manufacturing,
// Shipping & Logistics, Dealerships, Religious...) that were never excluded
// before. That silently changes who a client is contacted about, so a sync has
// to be undoable.
//
// Restores only the fields the sync writes. exclude_locations, require_location,
// allow_inferred_location, commercial_cleaning and notes are never touched by
// the sync, so they are never touched here either.

const FIELDS = [
  "countries",
  "include_locations",
  "include_industries",
  "include_keywords",
  "exclude_industries",
  "exclude_keywords",
  "exclude_terms",
  "include_terms",
  "sheet_raw",
] as const;

interface Snapshot {
  client_tag: string;
  [k: string]: unknown;
}

export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles").select("email, role").eq("id", user.id).single();
  if (!profile || !["owner", "admin"].includes(profile.role)) {
    return NextResponse.json(
      { error: "Only owners and admins can revert a rules sync" },
      { status: 403 }
    );
  }

  let body: { jobId?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const jobId = (body.jobId ?? "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) {
    return NextResponse.json({ error: "jobId (uuid) required" }, { status: 400 });
  }

  const { data: job } = await admin
    .from("targeting_sync_jobs")
    .select("id, status, snapshot, reverted_at")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Sync not found" }, { status: 404 });
  if (["pending", "running"].includes(job.status)) {
    return NextResponse.json({ error: "That sync is still running — wait for it to finish." }, { status: 409 });
  }
  if (job.reverted_at) {
    return NextResponse.json({ error: "That sync has already been reverted." }, { status: 409 });
  }

  const snapshot = (job.snapshot ?? []) as Snapshot[];
  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    return NextResponse.json(
      { error: "No snapshot was recorded for that sync, so it can't be reverted." },
      { status: 400 }
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    // One transaction: either every client goes back or none does.
    await client.query("begin");
    let restored = 0;
    for (const row of snapshot) {
      if (!row?.client_tag) continue;
      const sets = FIELDS.map((f, i) => `${f} = $${i + 2}`).join(", ");
      const values = FIELDS.map((f) => {
        const v = row[f];
        // jsonb columns must go back as JSON text; text[] as JS arrays.
        return f === "include_locations" || f === "sheet_raw" ? JSON.stringify(v ?? null) : (v ?? []);
      });
      const { rowCount } = await client.query(
        `update client_targeting set ${sets}, updated_at = now() where client_tag = $1`,
        [row.client_tag, ...values]
      );
      restored += rowCount ?? 0;
    }
    await client.query("commit");

    await admin.from("targeting_sync_jobs").update({ reverted_at: new Date().toISOString() }).eq("id", jobId);
    await logAudit({
      action: "Client Rules Sync Reverted",
      performedBy: profile.email ?? user.id,
      details: `Job ${jobId}: restored ${restored} client(s)`,
    });

    return NextResponse.json({ restored });
  } catch (e) {
    await client.query("rollback").catch(() => {});
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Revert failed" },
      { status: 500 }
    );
  } finally {
    client.release();
  }
}
