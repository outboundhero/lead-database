import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateApiToken } from "@/lib/api/validate-token";
import { logApiRequest } from "@/lib/api/log-request";

export async function POST(request: NextRequest) {
  const start = Date.now();
  const auth = await validateApiToken(request);
  if (!auth.valid) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  let body: { website?: string; company?: string };
  try {
    body = await request.json();
  } catch {
    await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/leads/search/company_name_raw", statusCode: 400, durationMs: Date.now() - start, error: "Invalid JSON body" });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { website, company } = body;
  if (!website && !company) {
    await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/leads/search/company_name_raw", statusCode: 400, durationMs: Date.now() - start, error: "At least one of website or company is required" });
    return NextResponse.json(
      { error: "At least one of website or company is required" },
      { status: 400 }
    );
  }

  const supabase = createAdminClient();

  let query = supabase
    .from("leads")
    .select(
      "id, email, first_name, last_name, title, company, phone, website, source, country, city, state, seniority, general_industry, annual_revenue, company_size, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (website && company) {
    query = query.or(
      `website.ilike.%${website.trim()}%,company.ilike.%${company.trim()}%`
    );
  } else if (website) {
    query = query.ilike("website", `%${website.trim()}%`);
  } else if (company) {
    query = query.ilike("company", `%${company.trim()}%`);
  }

  const { data, error } = await query;

  if (error) {
    await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/leads/search/company_name_raw", statusCode: 500, durationMs: Date.now() - start, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = data ?? [];
  await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/leads/search/company_name_raw", statusCode: 200, responseCount: results.length, durationMs: Date.now() - start });

  return NextResponse.json({ results, count: results.length });
}
