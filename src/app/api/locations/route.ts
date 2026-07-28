import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// GET /api/locations — browse the normalized geo hierarchy with lead counts.
//   (no params)        -> countries with lead counts
//   ?country=US        -> that country's states with lead counts
//   ?country=US&state=WA -> that state's cities with lead counts (top 500)
export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const country = request.nextUrl.searchParams.get("country")?.trim().toUpperCase() || null;
  const state = request.nextUrl.searchParams.get("state")?.trim().toUpperCase() || null;
  const pool = getPool();

  try {
    if (!country) {
      const { rows } = await pool.query(`
        SELECT sc.code, sc.display_name, COALESCE(n.leads, 0)::int AS leads
        FROM supported_countries sc
        LEFT JOIN (
          SELECT country_code, count(*) AS leads FROM leads
          WHERE country_code IS NOT NULL GROUP BY country_code
        ) n ON n.country_code = sc.code
        WHERE sc.enabled
        ORDER BY n.leads DESC NULLS LAST`);
      return NextResponse.json({ level: "countries", rows });
    }
    if (!state) {
      const { rows } = await pool.query(`
        SELECT a.state_code, a.name, COALESCE(n.leads, 0)::int AS leads
        FROM geo_admin1 a
        LEFT JOIN (
          SELECT state_code, count(*) AS leads FROM leads
          WHERE country_code = $1 AND state_code IS NOT NULL GROUP BY state_code
        ) n ON n.state_code = a.state_code
        WHERE a.country_code = $1
        ORDER BY n.leads DESC NULLS LAST, a.name`, [country]);
      return NextResponse.json({ level: "states", rows });
    }
    const { rows } = await pool.query(`
      SELECT l.city, l.state, l.state_code, l.country, l.country_code, count(*)::int AS leads
      FROM leads l
      WHERE l.country_code = $1 AND l.state_code = $2 AND l.city IS NOT NULL
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY leads DESC
      LIMIT 500`, [country, state]);
    return NextResponse.json({ level: "cities", rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "query failed" }, { status: 500 });
  }
}
