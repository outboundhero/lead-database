import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// PATCH /api/leads/edit  { id, fields: { city: "Austin", ... } }
//
// Session-authenticated in-app lead editing (operator fix-ups from the lead
// detail panel). Distinct from /api/leads/update, which is the token-authed
// endpoint for external API consumers.
//
// Rules that make an edit safe rather than something a worker undoes later:
//   * category/subcategory/additional_category edits stamp category_source =
//     'manual', which the categorize worker and the Clay import both refuse to
//     overwrite.
//   * city/state edits clear the resolved geo columns so the location worker
//     re-resolves from the corrected text — otherwise location_id still points
//     at the old place and targeting keeps using it (matching is by geoname id,
//     not the free-text column).
//   * every change is written to lead_history with a field-level diff, so the
//     History section of the panel shows who changed what.

const EDITABLE_FIELDS = [
  "first_name", "last_name", "title", "email",
  "company", "company_phone", "phone", "website", "domain",
  "category", "subcategory", "additional_category",
  "general_industry", "specific_industry", "seniority",
  "street", "city", "state", "postal_code", "address", "country",
  "person_linkedin", "company_linkedin", "google_maps_url",
  "notes", "question", "tags",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

const CATEGORY_FIELDS = new Set(["category", "subcategory", "additional_category"]);
const LOCATION_FIELDS = new Set(["city", "state", "postal_code", "country"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles").select("role, full_name, email").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json({ error: "Your role can't edit leads — ask an admin" }, { status: 403 });
  }

  let body: { id?: string; fields?: Record<string, unknown> };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const id = (body.id ?? "").trim();
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "A valid lead id is required" }, { status: 400 });
  if (!body.fields || typeof body.fields !== "object") {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  // Whitelist + normalize. Empty string means "clear this field" -> null.
  const patch: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(body.fields)) {
    if (!EDITABLE_FIELDS.includes(key as EditableField)) {
      return NextResponse.json({ error: `Field "${key}" can't be edited here` }, { status: 400 });
    }
    if (raw === null || raw === undefined) { patch[key] = null; continue; }
    const value = String(raw).trim();
    if (value.length > 2000) return NextResponse.json({ error: `"${key}" is too long (max 2000 characters)` }, { status: 400 });
    patch[key] = value === "" ? null : value;
  }
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: "No fields to update" }, { status: 400 });

  if (patch.email !== undefined) {
    if (!patch.email) return NextResponse.json({ error: "Email can't be empty" }, { status: 400 });
    patch.email = patch.email.toLowerCase();
    if (!EMAIL_RE.test(patch.email)) return NextResponse.json({ error: `"${patch.email}" is not a valid email address` }, { status: 400 });
  }

  // Read the current row so the history diff records real before/after values
  // and unchanged fields are dropped (no pointless rewrite of an 8M-row table).
  const { data: before, error: readErr } = await admin
    .from("leads").select("*").eq("id", id).maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!before) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const changed: Record<string, { old: unknown; new: unknown }> = {};
  for (const [key, value] of Object.entries(patch)) {
    const old = (before as Record<string, unknown>)[key] ?? null;
    if ((old ?? null) === value) continue;
    changed[key] = { old, new: value };
  }
  if (Object.keys(changed).length === 0) {
    return NextResponse.json({ lead: before, changed: {}, message: "No changes" });
  }

  const update: Record<string, unknown> = { ...patch, updated_at: new Date().toISOString() };
  if (Object.keys(changed).some((k) => CATEGORY_FIELDS.has(k))) {
    update.category_source = "manual"; // never overwritten by the worker or Clay
    update.category_confidence = null;
  }
  if (Object.keys(changed).some((k) => LOCATION_FIELDS.has(k))) {
    // Re-resolve from the corrected text — the location worker picks these up.
    update.location_id = null;
    update.location_status = null;
    update.location_source = "manual-edit";
  }

  const { data: after, error: updateErr } = await admin
    .from("leads").update(update).eq("id", id).select("*").single();
  if (updateErr) {
    const dup = /duplicate key|leads_email_key/i.test(updateErr.message);
    return NextResponse.json(
      { error: dup ? "Another lead already has that email address" : updateErr.message },
      { status: dup ? 409 : 500 }
    );
  }

  // Audit trail — the panel's History section reads this table.
  const who = profile.full_name || profile.email || user.email || "Unknown user";
  const { error: histErr } = await admin.from("lead_history").insert({
    lead_id: id,
    event_type: "updated",
    changed_fields: changed,
    performed_by: user.id,
    performed_by_name: who,
    notes: `Edited in app by ${who}: ${Object.keys(changed).join(", ")}`,
  });
  if (histErr) console.error("lead edit: history insert failed", histErr.message);

  return NextResponse.json({ lead: after, changed });
}
