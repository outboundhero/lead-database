import { createAdminClient } from "@/lib/supabase/admin";
import type { NextRequest } from "next/server";

export async function validateApiToken(
  request: NextRequest
): Promise<{ valid: true; tokenId: string; tokenName: string } | { valid: false; error: string }> {
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) {
    return { valid: false, error: "Missing or invalid Authorization header. Use: Bearer <token>" };
  }

  const token = auth.slice(7).trim();
  if (!token) {
    return { valid: false, error: "Empty token" };
  }

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("api_tokens")
    .select("id, name, is_active")
    .eq("token", token)
    .single();

  if (error || !data) {
    return { valid: false, error: "Invalid API token" };
  }

  if (!data.is_active) {
    return { valid: false, error: "API token has been revoked" };
  }

  // Update last_used_at in the background
  void supabase
    .from("api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", data.id);

  return { valid: true, tokenId: data.id, tokenName: data.name };
}
