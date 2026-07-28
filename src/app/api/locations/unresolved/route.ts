import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// The Unresolved Location queue (client spec req 8/23): distinct raw location
// variations we couldn't confidently resolve, with lead counts. Resolving one
// manually stores a location_aliases row so the same variation auto-resolves
// forever after, and applies the fix to every matching lead immediately.

// GET /api/locations/unresolved — variations by volume
export async function GET() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const { rows } = await getPool().query(`
      SELECT
        COALESCE(NULLIF(btrim(l.city), ''), l.raw_data->>'city_pre_clean', l.raw_data->>'state_pre_clean', '(no location text)') AS variation,
        count(*)::int AS leads
      FROM leads l
      WHERE l.location_status = 'unresolved'
      GROUP BY 1
      ORDER BY leads DESC
      LIMIT 300`);
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "query failed" }, { status: 500 });
  }
}

// POST /api/locations/unresolved — manually resolve one variation (admin).
// body: { variation, country, state?, city? }  city/state may be omitted for
// partial (state- or country-level) resolutions. Pass action:"discard" to mark
// the variation's leads as having no usable location instead.
export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admin = createAdminClient();
  const { data: profile } = await admin.from("user_profiles").select("role").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { variation?: string; country?: string; state?: string; city?: string; action?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const variation = (body.variation ?? "").trim();
  if (!variation) return NextResponse.json({ error: "variation required" }, { status: 400 });

  const pool = getPool();
  const matchWhere = `
    location_status = 'unresolved' AND
    COALESCE(NULLIF(btrim(city), ''), raw_data->>'city_pre_clean', raw_data->>'state_pre_clean', '(no location text)') = $1`;

  try {
    if (body.action === "discard") {
      const r = await pool.query(
        `UPDATE leads SET location_status = NULL, city = NULL,
           raw_data = raw_data || '{"location_review":false}'::jsonb
         WHERE ${matchWhere}`, [variation]);
      return NextResponse.json({ updated: r.rowCount, discarded: true });
    }

    const country = (body.country ?? "").trim().toUpperCase();
    if (!country) return NextResponse.json({ error: "country required" }, { status: 400 });
    const state = (body.state ?? "").trim().toUpperCase() || null;
    const city = (body.city ?? "").trim() || null;

    // validate against the reference; city-level must be a real place
    let geonameId: number | null = null;
    let cityDisp: string | null = null;
    let stateName: string | null = null;
    if (state) {
      const a = await pool.query(
        `SELECT name FROM geo_admin1 WHERE country_code = $1 AND state_code = $2`, [country, state]);
      if (!a.rows.length) return NextResponse.json({ error: `Unknown state ${state} in ${country}` }, { status: 400 });
      stateName = a.rows[0].name;
    }
    if (city) {
      if (!state) return NextResponse.json({ error: "city requires a state" }, { status: 400 });
      const g = await pool.query(`
        SELECT g.geoname_id, g.city FROM geo_locations g
        JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
        WHERE g.country_code = $1 AND a.state_code = $2
          AND g.city_key = regexp_replace(lower($3), '[^a-z]', '', 'g')
        ORDER BY g.population DESC LIMIT 1`, [country, state, city]);
      if (!g.rows.length) return NextResponse.json({ error: `"${city}" is not a known place in ${state}, ${country}` }, { status: 400 });
      geonameId = Number(g.rows[0].geoname_id);
      cityDisp = g.rows[0].city;
    }
    const disp = await pool.query(`SELECT display_name FROM supported_countries WHERE code = $1 AND enabled`, [country]);
    if (!disp.rows.length) return NextResponse.json({ error: `Unsupported country ${country}` }, { status: 400 });

    // store the alias so this variation self-resolves from now on
    await pool.query(`
      INSERT INTO location_aliases (alias_key, level, country_code, state_code, geoname_id, source)
      VALUES (regexp_replace(lower($1), '[^a-z]', '', 'g'), $2, $3, $4, $5, 'manual')
      ON CONFLICT (alias_key) DO UPDATE SET
        level = EXCLUDED.level, country_code = EXCLUDED.country_code,
        state_code = EXCLUDED.state_code, geoname_id = EXCLUDED.geoname_id, source = 'manual'
    `, [variation, city ? "city" : state ? "state" : "country", country, state, geonameId]);

    const r = await pool.query(`
      UPDATE leads SET
        city = COALESCE($2, city), state = COALESCE($3, state), state_code = COALESCE($4, state_code),
        country = $5, country_code = $6, location_id = $7,
        location_status = $8, location_source = 'manual'
      WHERE ${matchWhere}`,
      [variation, cityDisp, stateName, state, disp.rows[0].display_name, country, geonameId,
       geonameId ? "resolved" : "partial"]);
    return NextResponse.json({ updated: r.rowCount, resolved: { city: cityDisp, state: stateName, state_code: state, country_code: country } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "resolve failed" }, { status: 500 });
  }
}
