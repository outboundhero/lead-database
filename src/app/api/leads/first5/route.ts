import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateApiToken } from "@/lib/api/validate-token";
import { logApiRequest } from "@/lib/api/log-request";

export async function GET(request: NextRequest) {
  const start = Date.now();
  const auth = await validateApiToken(request);
  if (!auth.valid) {
    return NextResponse.json({ error: auth.error }, { status: 401 });
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, email, first_name, last_name, title, company, phone, website, source, country, city, state, seniority, general_industry, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "GET", endpoint: "/api/leads/first5", statusCode: 500, durationMs: Date.now() - start, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = data ?? [];
  await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "GET", endpoint: "/api/leads/first5", statusCode: 200, responseCount: results.length, durationMs: Date.now() - start });

  return NextResponse.json({ results, count: results.length });
}
