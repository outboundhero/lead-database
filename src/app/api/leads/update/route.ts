import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateApiToken } from "@/lib/api/validate-token";
import { logApiRequest } from "@/lib/api/log-request";

const ENDPOINT = "/api/leads/update";

// Columns the API may never set: identity + creation timestamp are immutable,
// and updated_at is managed by this route. Everything else on `leads` is fair
// game ("update any field") — unknown columns are rejected by Postgres and
// surfaced as a 400 below.
const FORBIDDEN_FIELDS = new Set(["id", "created_at", "updated_at"]);

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function POST(request: NextRequest) {
  const start = Date.now();

  const auth = await validateApiToken(request);
  if (!auth.valid) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const fail = async (status: number, error: string) => {
    await logApiRequest({
      tokenId: auth.tokenId,
      tokenName: auth.tokenName,
      method: "POST",
      endpoint: ENDPOINT,
      statusCode: status,
      durationMs: Date.now() - start,
      error,
    });
    return NextResponse.json({ error }, { status });
  };

  // ── Parse + validate body ──────────────────────────────────────────────
  let body: { email?: unknown; fields?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400, "Invalid JSON body");
  }

  if (typeof body.email !== "string" || !body.email.trim()) {
    return fail(400, "`email` is required and must be a non-empty string");
  }
  if (!isPlainObject(body.fields)) {
    return fail(400, "`fields` is required and must be an object of column/value pairs");
  }

  const lookupEmail = body.email.trim().toLowerCase();
  const fields = body.fields;

  const fieldKeys = Object.keys(fields);
  if (fieldKeys.length === 0) {
    return fail(400, "`fields` must contain at least one column to update");
  }

  const forbidden = fieldKeys.filter((k) => FORBIDDEN_FIELDS.has(k));
  if (forbidden.length > 0) {
    return fail(400, `These fields cannot be updated: ${forbidden.join(", ")}`);
  }

  // Build the update payload. If the caller changes `email`, normalize + validate it.
  const updatePayload: Record<string, unknown> = { ...fields };
  if ("email" in updatePayload) {
    if (typeof updatePayload.email !== "string" || !EMAIL_RE.test(updatePayload.email.trim())) {
      return fail(400, "`fields.email` must be a valid email address");
    }
    updatePayload.email = updatePayload.email.trim().toLowerCase();
  }
  updatePayload.updated_at = new Date().toISOString();

  const supabase = createAdminClient();

  // ── Find the target lead (email is UNIQUE → exactly one row) ────────────
  const { data: existing, error: findErr } = await supabase
    .from("leads")
    .select("*")
    .eq("email", lookupEmail)
    .maybeSingle();

  if (findErr) {
    return fail(500, findErr.message);
  }
  if (!existing) {
    return fail(404, `No lead found with email: ${lookupEmail}`);
  }

  // ── Apply the update (by id, the stable key) ────────────────────────────
  const { data: updated, error: updErr } = await supabase
    .from("leads")
    .update(updatePayload)
    .eq("id", existing.id)
    .select("*")
    .single();

  if (updErr) {
    // Unknown column, type mismatch, check-constraint, or unique email
    // collision all land here → caller's fault, return 400 with the detail.
    const isConflict = updErr.code === "23505";
    return fail(
      isConflict ? 409 : 400,
      isConflict ? "Another lead already uses that email" : updErr.message,
    );
  }

  // ── Compute changed_fields for the audit trail ──────────────────────────
  const changed: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of fieldKeys) {
    const before = (existing as Record<string, unknown>)[key];
    const after = (updated as Record<string, unknown>)[key];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changed[key] = { old: before ?? null, new: after ?? null };
    }
  }

  // Record history so the change appears in the lead detail panel (best-effort).
  await supabase.from("lead_history").insert({
    lead_id: existing.id,
    event_type: "updated",
    changed_fields: Object.keys(changed).length > 0 ? changed : null,
    performed_by_name: `API: ${auth.tokenName ?? "token"}`,
    notes: "Updated via API",
  });

  await logApiRequest({
    tokenId: auth.tokenId,
    tokenName: auth.tokenName,
    method: "POST",
    endpoint: ENDPOINT,
    statusCode: 200,
    responseCount: 1,
    durationMs: Date.now() - start,
  });

  return NextResponse.json({
    updated: true,
    email: updated.email,
    changed_fields: changed,
    lead: updated,
  });
}
