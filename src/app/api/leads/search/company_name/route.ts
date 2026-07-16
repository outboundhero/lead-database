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

  const baseQuery = () =>
    supabase
      .from("leads")
      .select(
        "id, email, first_name, last_name, title, company, phone, website, source, country, city, state, seniority, general_industry, annual_revenue, company_size, created_at"
      )
      .order("created_at", { ascending: false })
      .limit(100);

  let data: Record<string, unknown>[] | null = null;
  let error: { message: string } | null = null;

  if (website && company) {
    // Two parameterized .ilike() queries merged client-side — .or() takes a
    // raw PostgREST filter string, so interpolating user input into it allows
    // filter-grammar injection (a comma injects an extra predicate).
    const [byWebsite, byCompany] = await Promise.all([
      baseQuery().ilike("website", `%${website.trim()}%`),
      baseQuery().ilike("company", `%${company.trim()}%`),
    ]);
    error = byWebsite.error ?? byCompany.error;
    const seen = new Set<string>();
    data = [...(byWebsite.data ?? []), ...(byCompany.data ?? [])]
      .filter((row) => !seen.has(row.id) && (seen.add(row.id), true))
      .sort(
        (a, b) =>
          new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime()
      )
      .slice(0, 100);
  } else if (website) {
    ({ data, error } = await baseQuery().ilike("website", `%${website.trim()}%`));
  } else if (company) {
    ({ data, error } = await baseQuery().ilike("company", `%${company.trim()}%`));
  }

  if (error) {
    await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/leads/search/company_name_raw", statusCode: 500, durationMs: Date.now() - start, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = data ?? [];
  await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/leads/search/company_name_raw", statusCode: 200, responseCount: results.length, durationMs: Date.now() - start });

  return NextResponse.json({ results, count: results.length });
}
