import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// GET /api/locations/unresolved/leads?variation=Springfield
// The leads behind one unresolved variation, with the context a human needs to
// work out where the place actually is: company, website/domain, phone,
// address, postal code.
export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const variation = request.nextUrl.searchParams.get("variation")?.trim();
  if (!variation) return NextResponse.json({ error: "variation required" }, { status: 400 });

  try {
    const { rows } = await getPool().query(`
      SELECT id, email, first_name, last_name, company, title,
             COALESCE(website, domain, split_part(lower(email), '@', 2)) AS website,
             COALESCE(company_phone, phone) AS phone,
             address, postal_code, city, state
      FROM leads
      WHERE location_status = 'unresolved'
        AND COALESCE(NULLIF(btrim(city), ''), raw_data->>'city_pre_clean', raw_data->>'state_pre_clean', '(none)') = $1
      ORDER BY (company IS NULL), company
      LIMIT 200`, [variation]);
    return NextResponse.json({ variation, rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "query failed" }, { status: 500 });
  }
}
