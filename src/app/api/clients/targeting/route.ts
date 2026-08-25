import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// Per-client-tag targeting rules (client spec req 14-16). Location entries are
// {country, state?, city?}; each is validated against the geo reference before
// saving — a rule that names an unknown place is rejected, not stored.

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
    // client_type ("Cleaning" / "Non-Cleaning", Onboarding col F) rides along so
    // a client with no saved config yet can default the commercial-cleaning
    // exclusions the way that client type expects, rather than always to off.
    const { data: tagRow } = await admin
      .from("client_tags").select("client_type").eq("tag", tag).maybeSingle();
    return NextResponse.json({ targeting: data, client_type: tagRow?.client_type ?? null });
  }
  const { data, error } = await admin.from("client_targeting").select("*");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ targeting: data ?? [] });
}

// GeoNames spells out abbreviations ("St. George" -> "Saint George") and drops
// some suffixes ("Suisun City" -> "Suisun"). Variants are tried only after the
// exact key misses, so "Kansas City" never degrades to "Kansas".
function cityVariants(city: string): string[] {
  const out: string[] = [];
  const abbr: Array<[RegExp, string]> = [
    [/^st\.?\s+/i, "Saint "], [/^ste\.?\s+/i, "Sainte "], [/^ft\.?\s+/i, "Fort "], [/^mt\.?\s+/i, "Mount "],
  ];
  for (const [re, full] of abbr) if (re.test(city)) out.push(city.replace(re, full));
  if (/\s+city$/i.test(city)) out.push(city.replace(/\s+city$/i, ""));
  return out;
}

// city_key is accent-folded; the SQL regexp only strips non-letters, so fold here.
const foldAccents = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");

async function validateEntries(entries: Array<{ country: string; state?: string; city?: string }>) {
  const pool = getPool();
  for (const e of entries) {
    const country = (e.country ?? "").trim().toUpperCase();
    if (!country) return `entry missing country`;
    const c = await pool.query(`SELECT 1 FROM supported_countries WHERE code = $1 AND enabled`, [country]);
    if (!c.rows.length) return `unsupported country "${e.country}"`;
    e.country = country;
    if (e.state) {
      // accept either the code ("WA") or the full name ("Washington")
      const raw = e.state.trim();
      const s = await pool.query(
        `SELECT state_code FROM geo_admin1
         WHERE country_code = $1 AND (state_code = $2 OR LOWER(name) = LOWER($3)) LIMIT 1`,
        [country, raw.toUpperCase(), raw]);
      if (!s.rows.length) return `unknown state "${e.state}" in ${country}`;
      e.state = s.rows[0].state_code;
    }
    if (e.city) {
      if (!e.state) return `city "${e.city}" needs a state`;
      let found: string | null = null;
      for (const candidate of [e.city, ...cityVariants(e.city)]) {
        const g = await pool.query(`
          SELECT g.city FROM geo_locations g
          JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
          WHERE g.country_code = $1 AND a.state_code = $2
            AND g.city_key = regexp_replace(lower($3), '[^a-z]', '', 'g')
          ORDER BY g.population DESC NULLS LAST LIMIT 1`,
          [country, e.state, foldAccents(candidate)]);
        if (g.rows.length) { found = g.rows[0].city; break; }
      }
      if (!found) return `"${e.city}" is not a known place in ${e.state}, ${country}`;
      e.city = found; // canonical DB casing/spelling
    }
  }
  return null;
}

// Trim, lower-case, drop blanks, de-duplicate — mirrors what migration 078 did
// to the existing data so hand-edits and migrated rows stay consistent.
function cleanTerms(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const raw of v) {
    const t = String(raw).trim().toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen].sort();
}

// PUT /api/clients/targeting — upsert a config (admin/owner)
export async function PUT(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data: profile } = await admin.from("user_profiles").select("role").eq("id", user.id).single();
  if (!profile || !["owner", "admin"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: Partial<TargetingConfig>;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const tag = (body.client_tag ?? "").trim();
  if (!tag) return NextResponse.json({ error: "client_tag required" }, { status: 400 });

  const { data: tagRow } = await admin.from("client_tags").select("tag").eq("tag", tag).maybeSingle();
  if (!tagRow) return NextResponse.json({ error: `Unknown client tag "${tag}"` }, { status: 400 });

  const include = Array.isArray(body.include_locations) ? body.include_locations : [];
  const exclude = Array.isArray(body.exclude_locations) ? body.exclude_locations : [];
  for (const [label, list] of [["include", include], ["exclude", exclude]] as const) {
    const err = await validateEntries(list);
    if (err) return NextResponse.json({ error: `${label} location: ${err}` }, { status: 400 });
  }
  const countries = (Array.isArray(body.countries) ? body.countries : ["US"])
    .map((c) => String(c).trim().toUpperCase()).filter(Boolean);

  // source/sheet_raw/sheet_synced_at are deliberately NOT written here, so
  // sheet-sync provenance survives manual saves.
  const { error } = await admin.from("client_targeting").upsert({
    client_tag: tag,
    countries,
    include_locations: include,
    exclude_locations: exclude,
    // The dialog now sends only the merged lists. Terms are lower-cased for
    // consistent de-duplication; matching is case-insensitive regardless.
    include_terms: cleanTerms(body.include_terms),
    exclude_terms: cleanTerms(body.exclude_terms),
    require_location: !!body.require_location,
    allow_inferred_location: body.allow_inferred_location !== false,
    commercial_cleaning: !!body.commercial_cleaning,
    notes: typeof body.notes === "string" ? body.notes : null,
    updated_at: new Date().toISOString(),
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
