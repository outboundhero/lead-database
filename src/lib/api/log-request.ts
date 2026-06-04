import { createAdminClient } from "@/lib/supabase/admin";

export async function logApiRequest(params: {
  tokenId: string;
  tokenName: string | null;
  method: string;
  endpoint: string;
  statusCode: number;
  responseCount?: number;
  ipAddress?: string | null;
  durationMs?: number;
  error?: string;
}) {
  try {
    const supabase = createAdminClient();
    const { error } = await supabase.from("api_logs").insert({
      token_id: params.tokenId,
      token_name: params.tokenName,
      method: params.method,
      endpoint: params.endpoint,
      status_code: params.statusCode,
      response_count: params.responseCount ?? null,
      ip_address: params.ipAddress ?? null,
      duration_ms: params.durationMs ?? null,
      error: params.error ?? null,
    });
    if (error) console.error("Failed to log API request:", error.message);
  } catch (err) {
    console.error("Failed to log API request:", err);
  }
}
