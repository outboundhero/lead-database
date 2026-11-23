import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { hasLocationTables, lockClientPlaces, logPlaces, placesOf, targetingRow } from "@/lib/clients/location-server";
import { cleanCountries, cleanTerms, countryErrors, entriesOf, samePlaces, validateEntries, type Places } from "@/lib/clients/targeting-validate";
import { cleanMinimum, coverageSettings } from "../../../../../scripts/lib/coverage.mjs";

// Per-client-tag targeting rules (client spec req 14-16). Location entries are
// {country, state?, city?}; each is validated against the geo reference before
// saving (src/lib/clients/targeting-validate.ts, shared with the Clay tab's
// /api/clients/location): a rule that names an unknown place is rejected, not
// stored.
//
// Since migration 139 a save that changes the places (countries, include or
// exclude places) locks them: the onboarding-sheet sync then leaves them alone
// until someone follows the sheet again (PUT /api/clients/location {unlock}).
// The change is logged with the places before and after (client_targeting_log),
// and the audit log gets counts only.

export interface TargetingConfig {
  client_tag: string;
  countries: string[];
  include_locations: Array<{ country: string; state?: string; city?: string }>;
  exclude_locations: Array<{ country: string; state?: string; city?: string }>;
  // Merged term lists (migrations 078/079). exclude_terms is THE list that
  // gates sends — whole-word, plural-tolerant, across category, subcategory,
  // additional_category, company, general_industry and specific_industry.
  // include_terms gates nothing; it only pre-fills the Leads filters.
  include_terms: string[];
  exclude_terms: string[];
  // Superseded by the two above, kept so old payloads/readers don't break.
  include_industries: string[];
  include_keywords: string[];
  exclude_industries: string[];
  exclude_keywords: string[];
  require_location: boolean;
  allow_inferred_location: boolean;
  commercial_cleaning: boolean;
  notes: string | null;
  // The client's minimum of good leads a place (migration 135); null means the
  // weekly top-up's default (weekly_topup.default_minimum). The sheet sync
  // never writes it.
  min_leads_per_place?: number | null;
  // Sheet-sync provenance (read-only here; written by sync-targeting).
  source?: "manual" | "sheet";
  sheet_synced_at?: string | null;
}

// GET /api/clients/targeting?tag=X — one config (404 if none yet)
// GET /api/clients/targeting        — all configs
export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tag = request.nextUrl.searchParams.get("tag")?.trim();
  const admin = createAdminClient();
  if (tag) {
    const { data, error } = await admin.from("client_targeting").select("*").eq("client_tag", tag).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // Who edited the places by hand (migration 139), for the dialog's lock line.
    let lockedBy: string | null = null;
    if (data?.locations_locked && data.locations_locked_by) {
      const { data: who } = await admin.from("user_profiles").select("email").eq("id", data.locations_locked_by).maybeSingle();
      lockedBy = who?.email ?? null;
    }
    // client_type ("Cleaning" / "Non-Cleaning", Onboarding col F) rides along so
    // a client with no saved config yet can default the commercial-cleaning
    // exclusions the way that client type expects, rather than always to off.
    const { data: tagRow } = await admin
      .from("client_tags").select("client_type").eq("tag", tag).maybeSingle();
    // The minimum that applies while the client's own is empty, for the dialog's placeholder.
    const { defaultMinimum } = await coverageSettings(getPool());
    return NextResponse.json({
      targeting: data,
      client_type: tagRow?.client_type ?? null,
      default_min_leads_per_place: defaultMinimum,
      locked_by_email: lockedBy,
    });
  }
  const { data, error } = await admin.from("client_targeting").select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ targeting: data ?? [] });
}

// PUT /api/clients/targeting: upsert a config (admin/owner). Places that changed are
// locked against the sheet sync and logged (migration 139; without it the save is
// as before, with no lock).
export async function PUT(request: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;

  let body: Partial<TargetingConfig>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const tag = (body.client_tag ?? "").trim();
  if (!tag) return NextResponse.json({ error: "client_tag required" }, { status: 400 });

  const countries = cleanCountries(body.countries) ?? ["US"];
  // Sent: a whole number from 1 to 100,000, or empty for the default. Left out: kept as stored.
  const minimum = "min_leads_per_place" in body ? cleanMinimum(body.min_leads_per_place) : null;
  if (minimum?.error) return NextResponse.json({ error: minimum.error }, { status: 400 });
  const excludeTerms = cleanTerms(body.exclude_terms);

  try {
    const out = await withTx(
      async (c) => {
        const { rows: [tagRow] } = await c.query(`SELECT tag FROM client_tags WHERE tag = $1`, [tag]);
        if (!tagRow) return { status: 400, error: `Unknown client tag "${tag}"` };

        const places: Places = { countries, include_locations: [], exclude_locations: [] };
        for (const [label, field, list] of [
          ["include", "include_locations", body.include_locations],
          ["exclude", "exclude_locations", body.exclude_locations],
        ] as const) {
          const checked = await validateEntries(c, entriesOf(list) ?? []);
          if (checked.errors.length) {
            const errors = checked.errors.map((e) => `${label} location: ${e}`);
            return { status: 400, error: errors[0], errors };
          }
          places[field] = checked.entries;
        }
        const badCountries = await countryErrors(c, countries);
        if (badCountries.length) return { status: 400, error: badCountries[0], errors: badCountries };

        // Migration 139: changed places lock, under the same per-client lock the Clay tab's saves take.
        const lockable = await hasLocationTables(c);
        let before: Places | null = null;
        let lock = false;
        if (lockable) {
          await lockClientPlaces(c, tag);
          const row = await targetingRow(c, tag, { forUpdate: true });
          before = row ? placesOf(row) : null;
          lock = !samePlaces(before, places);
        }

        // source/sheet_raw/sheet_synced_at are deliberately NOT written here, so
        // sheet-sync provenance survives manual saves.
        await c.query(
          `INSERT INTO client_targeting AS t (client_tag, countries, include_locations, exclude_locations, include_terms, exclude_terms,
                                              require_location, allow_inferred_location, commercial_cleaning, notes,
                                              min_leads_per_place, updated_at${lock ? ", locations_locked, locations_locked_by, locations_locked_at" : ""})
           VALUES ($1, $2::text[], $3::jsonb, $4::jsonb, $5::text[], $6::text[], $7, $8, $9, $10, $11, now()${lock ? ", true, $13, now()" : ""})
           ON CONFLICT (client_tag) DO UPDATE SET
             countries = EXCLUDED.countries, include_locations = EXCLUDED.include_locations,
             exclude_locations = EXCLUDED.exclude_locations, include_terms = EXCLUDED.include_terms,
             exclude_terms = EXCLUDED.exclude_terms, require_location = EXCLUDED.require_location,
             allow_inferred_location = EXCLUDED.allow_inferred_location, commercial_cleaning = EXCLUDED.commercial_cleaning,
             notes = EXCLUDED.notes,
             min_leads_per_place = CASE WHEN $12 THEN EXCLUDED.min_leads_per_place ELSE t.min_leads_per_place END,
             updated_at = now()${lock ? ", locations_locked = true, locations_locked_by = $13, locations_locked_at = now()" : ""}`,
          [
            tag, places.countries, JSON.stringify(places.include_locations), JSON.stringify(places.exclude_locations),
            // The dialog now sends only the merged lists. Terms are lower-cased for
            // consistent de-duplication; matching is case-insensitive regardless.
            cleanTerms(body.include_terms), excludeTerms,
            !!body.require_location, body.allow_inferred_location !== false, !!body.commercial_cleaning,
            typeof body.notes === "string" ? body.notes : null,
            minimum ? minimum.value : null, Boolean(minimum),
            ...(lock ? [auth.user.id] : []),
          ]
        );
        if (lock) await logPlaces(c, { tag, action: "save", before, after: places, userId: auth.user.id });
        return { lock, places };
      },
      { timeoutMs: 20_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if (out.errors?.length) answer.errors = out.errors;
      return NextResponse.json(answer, { status: out.status });
    }
    await logAudit({
      action: "client_targeting",
      performedBy: auth.user.id,
      details: `${tag}: ${out.places.include_locations.length} places in, ${out.places.exclude_locations.length} out, ${out.places.countries.length} countries, ${excludeTerms.length} exclude terms${out.lock ? "; places kept from the sheet sync (edited by hand)" : ""}`,
    });
    return NextResponse.json({ ok: true, locked: out.lock });
  } catch (err) {
    console.error("clients/targeting PUT:", err);
    return NextResponse.json({ error: "Could not save the targeting rules" }, { status: 500 });
  }
}
