import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/api/log-audit";

// POST /api/admin/reset-password — send a password-reset email to a user.
//
// SECURITY: this route previously had NO authentication and NO role check, so
// any authenticated session could trigger a reset email for any account,
// including the owner. Gated to owner/admin like the other admin routes, and
// the actor is derived from the session rather than the request body.

export async function POST(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const { data: callerProfile } = await supabase
    .from("user_profiles")
    .select("email, role")
    .eq("id", user.id)
    .single();

  if (!callerProfile || !["owner", "admin"].includes(callerProfile.role)) {
    return NextResponse.json(
      { error: "Only owners and admins can send password resets" },
      { status: 403 }
    );
  }

  let body: { userId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId } = body;
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("email, role")
    .eq("id", userId)
    .single();

  if (!profile?.email) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // An admin must not be able to force a reset on an owner's account.
  if (profile.role === "owner" && callerProfile.role !== "owner") {
    return NextResponse.json(
      { error: "Only an owner can reset an owner's password" },
      { status: 403 }
    );
  }

  const { error } = await supabase.auth.resetPasswordForEmail(profile.email, {
    redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? request.nextUrl.origin}/login`,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAudit({
    action: "Password Reset",
    performedBy: callerProfile.email ?? user.id,
    details: `User Email: ${profile.email}`,
  });

  return NextResponse.json({ success: true });
}
