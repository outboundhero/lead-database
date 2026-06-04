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

  let body: { website?: string };
  try {
    body = await request.json();
  } catch {
    await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/enrich_email", statusCode: 400, durationMs: Date.now() - start, error: "Invalid JSON body" });
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { website } = body;
  if (!website || typeof website !== "string" || !website.trim()) {
    await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/enrich_email", statusCode: 400, durationMs: Date.now() - start, error: "website is required" });
    return NextResponse.json(
      { error: "website is required" },
      { status: 400 }
    );
  }

  // Normalize: strip protocol, www, trailing slashes → "example.com"
  const domain = website.trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();

  if (!domain) {
    return NextResponse.json({ error: "Invalid website" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // Uses fn_enrich_email RPC which queries the indexed website_domain column —
  // exact match, sub-millisecond even at 6M rows.
  const { data, error } = await supabase
    .rpc("fn_enrich_email", { p_domain: domain });

  if (error) {
    await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/enrich_email", statusCode: 500, durationMs: Date.now() - start, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const results = (data ?? []).map((lead: { email: string; first_name: string | null; last_name: string | null }) => ({
    email: lead.email,
    first_name: lead.first_name,
    last_name: lead.last_name,
    full_name: [lead.first_name, lead.last_name].filter(Boolean).join(" ") || null,
  }));

  await logApiRequest({ tokenId: auth.tokenId, tokenName: auth.tokenName, method: "POST", endpoint: "/api/enrich_email", statusCode: 200, responseCount: results.length, durationMs: Date.now() - start });

  return NextResponse.json({ results, count: results.length });
}
