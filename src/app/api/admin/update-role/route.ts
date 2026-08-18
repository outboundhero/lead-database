import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/api/log-audit";

// POST /api/admin/update-role — change a user's role.
//
// SECURITY: this route previously had NO authentication and NO role check while
// using the service-role client, and it took `performedBy` from the request
// body. Any authenticated session — a viewer included — could promote itself to
// owner. The gate below mirrors api/admin/delete-user and api/admin/invite, and
// the actor is now derived from the session, never from the payload.
//
// Escalation rules:
//   * only an owner may GRANT the owner role
//   * only an owner may change an existing owner's role
//   * the last remaining owner can never be demoted (no lock-out)

const VALID_ROLES = ["owner", "admin", "manager", "viewer"] as const;

export async function POST(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Role check — only owner and admin can change roles.
  const { data: callerProfile } = await supabase
    .from("user_profiles")
    .select("email, role")
    .eq("id", user.id)
    .single();

  if (!callerProfile || !["owner", "admin"].includes(callerProfile.role)) {
    return NextResponse.json(
      { error: "Only owners and admins can change roles" },
      { status: 403 }
    );
  }

  let body: { userId?: string; newRole?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId, newRole } = body;
  if (!userId || !newRole) {
    return NextResponse.json({ error: "userId and newRole required" }, { status: 400 });
  }
  if (!VALID_ROLES.includes(newRole as (typeof VALID_ROLES)[number])) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const { data: profile } = await supabase
    .from("user_profiles")
    .select("email, role")
    .eq("id", userId)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  if (profile.role === newRole) {
    return NextResponse.json({ success: true, unchanged: true });
  }

  const callerIsOwner = callerProfile.role === "owner";

  // Only an owner may hand out the owner role.
  if (newRole === "owner" && !callerIsOwner) {
    return NextResponse.json(
      { error: "Only an owner can grant the owner role" },
      { status: 403 }
    );
  }
  // Only an owner may change another owner's role.
  if (profile.role === "owner" && !callerIsOwner) {
    return NextResponse.json(
      { error: "Only an owner can change an owner's role" },
      { status: 403 }
    );
  }
  // Never leave the project without an owner.
  if (profile.role === "owner" && newRole !== "owner") {
    const { count } = await supabase
      .from("user_profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "owner");
    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        { error: "This is the last owner — promote another owner first" },
        { status: 409 }
      );
    }
  }

  const { error } = await supabase
    .from("user_profiles")
    .update({ role: newRole })
    .eq("id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAudit({
    action: "Role Changed",
    // Actor comes from the session, not the request body.
    performedBy: callerProfile.email ?? user.id,
    details: `${profile.email}: ${profile.role} → ${newRole}`,
  });

  return NextResponse.json({ success: true });
}
