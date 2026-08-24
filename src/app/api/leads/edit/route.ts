import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

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
//   * city/state edits RE-RESOLVE location_id / state_code / country_code
//     synchronously against the geo reference. Targeting matches those derived
//     columns, never the free-text ones, so leaving them alone would keep
//     targeting the old place — and merely NULLing them would hide the lead
//     from city targeting until the location worker's WEEKLY cron caught up.
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
// Only these change WHERE a lead is. A postal_code fix alone must not disturb a
// good resolution, since nothing resolves by ZIP.
const LOCATION_FIELDS = new Set(["city", "state", "country"]);
const COUNTRY_PRIORITY = ["US", "CA", "AU", "NZ", "GB", "IE"];
const foldAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

// Re-resolve the geo columns targeting actually matches on, synchronously.
//
// Targeting never reads the free-text city/state columns: a city entry becomes
// `location_id = ANY(...)` and a state entry becomes
// `country_code = X AND state_code = Y` (migration 066). So an edit that leaves
// those derived columns untouched would keep targeting the OLD place, and one
// that merely NULLs them would leave the lead invisible to city targeting until
// the location worker next runs — which is a WEEKLY cron. Hence: resolve here.
async function resolveLocation(city: string | null, state: string | null, country: string | null) {
  const pool = getPool();
  const out = {
    location_id: null as number | null,
    state_code: null as string | null,
    country_code: null as string | null,
    canonical_city: null as string | null,
    location_status: "unresolved" as "resolved" | "partial" | "unresolved" | null,
  };
  if (!city && !state) {
    // Location text cleared entirely — no claim either way.
    return { ...out, location_status: null };
  }

  if (state) {
    const wanted = country?.trim().toUpperCase();
    const { rows } = await pool.query(
      `SELECT country_code, state_code FROM geo_admin1
        WHERE (state_code = $1 OR LOWER(name) = LOWER($2))
          AND ($3::text IS NULL OR country_code = $3)
        ORDER BY array_position($4::text[], country_code) NULLS LAST
        LIMIT 1`,
      [state.trim().toUpperCase(), state.trim(), wanted || null, COUNTRY_PRIORITY]
    );
    if (rows.length) {
      out.state_code = rows[0].state_code;
      out.country_code = rows[0].country_code;
      out.location_status = "partial"; // state verified, city not yet
    }
  }

  if (city && out.state_code && out.country_code) {
    const { rows } = await pool.query(
      `SELECT g.geoname_id, g.city FROM geo_locations g
       JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
       WHERE g.country_code = $1 AND a.state_code = $2
         AND g.city_key = regexp_replace(lower($3), '[^a-z]', '', 'g')
       ORDER BY g.population DESC NULLS LAST
       LIMIT 1`,
      [out.country_code, out.state_code, foldAccents(city.trim())]
    );
    if (rows.length) {
      out.location_id = Number(rows[0].geoname_id);
      out.canonical_city = rows[0].city as string;
      out.location_status = "resolved";
    }
    // City typed but not found in the reference -> stays 'partial': the state
    // is still trustworthy, so state-level targeting keeps working.
  }
  return out;
}
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
  let locationNote = "";
  if (Object.keys(changed).some((k) => LOCATION_FIELDS.has(k))) {
    const b = before as Record<string, unknown>;
    const nextCity = (patch.city !== undefined ? patch.city : (b.city as string | null)) || null;
    const nextState = (patch.state !== undefined ? patch.state : (b.state as string | null)) || null;
    const nextCountry = (patch.country !== undefined ? patch.country : (b.country as string | null)) || null;
    try {
      const geo = await resolveLocation(nextCity, nextState, nextCountry);
      update.location_id = geo.location_id;
      update.state_code = geo.state_code;
      update.country_code = geo.country_code;
      update.location_status = geo.location_status;
      update.location_source = "manual-edit";
      // Canonical spelling/casing from the reference, matching what the
      // location worker writes, so the text column agrees with location_id.
      if (geo.canonical_city) update.city = geo.canonical_city;
      locationNote =
        geo.location_status === "resolved" ? " (location re-resolved)"
        : geo.location_status === "partial" ? " (state resolved; city not in the geo reference)"
        : geo.location_status === "unresolved" ? " (location could not be resolved — sent to the Unresolved queue)"
        : " (location cleared)";
    } catch (e) {
      // Never fail the whole edit because the geo lookup was unavailable. Park
      // the lead in the Unresolved queue so the worker/operator picks it up
      // rather than silently leaving stale coordinates behind.
      console.error("lead edit: geo resolution failed", e instanceof Error ? e.message : e);
      update.location_id = null;
      update.state_code = null;
      update.country_code = null;
      update.location_status = "unresolved";
      update.location_source = "manual-edit";
      locationNote = " (location queued for re-resolution)";
    }
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
    notes: `Edited in app by ${who}: ${Object.keys(changed).join(", ")}${locationNote}`,
  });
  if (histErr) console.error("lead edit: history insert failed", histErr.message);

  return NextResponse.json({ lead: after, changed, locationNote: locationNote.trim() || undefined });
}
