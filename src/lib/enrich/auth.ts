import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasPermission, type UserRole } from "@/types/auth";

/**
 * Session + role gate for the Clay tab's routes. The role comes from
 * user_profiles, never from the request body.
 */
export async function requireRole(min: UserRole) {
  const server = await createClient();
  const {
    data: { user },
  } = await server.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) } as const;
  const { data: profile } = await createAdminClient()
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const role = (profile?.role ?? "viewer") as UserRole;
  if (!hasPermission(role, min)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  }
  return { user, role } as const;
}

const MIN_KEY_LENGTH = 32;

/**
 * A Bearer key for the routes the enrichment worker calls (AIARK_AUTO_ADD_KEY:
 * POST /api/aiark/add/auto and POST /api/companies/promote/auto), checked the
 * way the costing feed checks its key (src/lib/costing/feed.ts): constant time
 * over sha256 hashes, the configured value trimmed, and unset or shorter than
 * 32 characters = not configured, which fails closed. The name is older than
 * those routes: the shared-key Maps intake it was made for is gone
 * (migration 129 gave each client its own inbound URL).
 */
export function intakeKeyStatus(
  authorization: string | null,
  configured: string | undefined
): "ok" | "unauthorized" | "not_configured" {
  const expected = configured?.trim() ?? "";
  if (expected.length < MIN_KEY_LENGTH) return "not_configured";
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization?.trim() ?? "");
  if (!m) return "unauthorized";
  const a = createHash("sha256").update(m[1]).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b) ? "ok" : "unauthorized";
}
