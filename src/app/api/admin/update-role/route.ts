import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/api/log-audit";

export async function POST(request: NextRequest) {
  const supabase = createAdminClient();

  let body: { userId: string; newRole: string; performedBy?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId, newRole, performedBy } = body;
  if (!userId || !newRole) {
    return NextResponse.json({ error: "userId and newRole required" }, { status: 400 });
  }

  const validRoles = ["owner", "admin", "manager", "viewer"];
  if (!validRoles.includes(newRole)) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  // Get current user info
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("email, role")
    .eq("id", userId)
    .single();

  if (!profile) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (profile.role === "owner" && newRole !== "owner") {
    return NextResponse.json({ error: "Cannot change owner role" }, { status: 403 });
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
    performedBy,
    details: `${profile.email}: ${profile.role} → ${newRole}`,
  });

  return NextResponse.json({ success: true });
}
