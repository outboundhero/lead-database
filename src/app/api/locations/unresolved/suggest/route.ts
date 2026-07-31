import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";

// POST /api/locations/unresolved/suggest  { variation }
// One AI suggestion for a queue variation, using the lead context behind it
// (companies, domains, phones, addresses). Returns a proposal only — the user
// still confirms, and the confirm path validates against the geo reference.
// Nothing is written here.
export async function POST(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 501 });

  let body: { variation?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const variation = (body.variation ?? "").trim();
  if (!variation) return NextResponse.json({ error: "variation required" }, { status: 400 });

  const pool = getPool();
  try {
    const { rows: sample } = await pool.query(`
      SELECT company, COALESCE(website, domain, split_part(lower(email), '@', 2)) AS site,
             COALESCE(company_phone, phone) AS phone, address, postal_code
      FROM leads
      WHERE location_status = 'unresolved'
        AND COALESCE(NULLIF(btrim(city), ''), raw_data->>'city_pre_clean', raw_data->>'state_pre_clean', '(none)') = $1
      LIMIT 12`, [variation]);

    const system = `You identify where a raw location string from a B2B lead database refers to.
Supported countries ONLY: US, CA, AU, NZ, GB, IE.
You get the raw text plus sample leads carrying it (company, website, phone, address) — use them as evidence.
Verdicts: "city" (give country+state_code+city), "state" (country+state_code), "foreign" (real place outside the six countries), "junk" (not a location).
Answer only what the evidence supports; use "unknown" if genuinely unclear.
Respond JSON: {"kind":"city|state|foreign|junk|unknown","country":string|null,"state_code":string|null,"city":string|null,"reason":string}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "gpt-4o-mini", temperature: 0, response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify({ text: variation, sample_leads: sample }) },
        ],
      }),
    });
    const data = await res.json();
    if (data.error) return NextResponse.json({ error: data.error.message }, { status: 502 });
    const out = JSON.parse(data.choices[0].message.content);

    // Validate a city/state proposal against the reference before returning it,
    // so the UI never offers a place that would be rejected on save.
    let valid = true;
    if (out.kind === "city" && out.city && out.state_code && out.country) {
      const { rows } = await pool.query(`
        SELECT g.city FROM geo_locations g
        JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
        WHERE g.country_code = $1 AND a.state_code = $2
          AND g.city_key = regexp_replace(lower($3), '[^a-z]', '', 'g')
        ORDER BY g.population DESC LIMIT 1`, [out.country, out.state_code, out.city]);
      if (rows.length) out.city = rows[0].city; else valid = false;
    } else if (out.kind === "state" && out.state_code && out.country) {
      const { rows } = await pool.query(
        `SELECT 1 FROM geo_admin1 WHERE country_code = $1 AND state_code = $2`, [out.country, out.state_code]);
      valid = rows.length > 0;
    }
    return NextResponse.json({ suggestion: { ...out, valid }, sampleCount: sample.length });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "suggest failed" }, { status: 500 });
  }
}
