import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { logAudit } from "@/lib/api/log-audit";

export async function POST(request: NextRequest) {
  // Auth check
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Role check — only owner and admin can delete users
  const { data: callerProfile } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!callerProfile || !["owner", "admin"].includes(callerProfile.role)) {
    return NextResponse.json({ error: "Only owners and admins can delete users" }, { status: 403 });
  }

  let body: { userId: string; performedBy?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { userId, performedBy } = body;
  if (!userId) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }

  // Get user info before deleting
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("email, full_name, role")
    .eq("id", userId)
    .single();

  if (profile?.role === "owner") {
    return NextResponse.json({ error: "Cannot delete owner" }, { status: 403 });
  }

  // Delete from user_profiles
  const { error: profileError } = await supabase
    .from("user_profiles")
    .delete()
    .eq("id", userId);

  if (profileError) {
    return NextResponse.json({ error: profileError.message }, { status: 500 });
  }

  // Delete from auth
  const { error: authError } = await supabase.auth.admin.deleteUser(userId);
  if (authError) {
    return NextResponse.json({ error: authError.message }, { status: 500 });
  }

  await logAudit({
    action: "User Deleted",
    performedBy,
    details: `User Email: ${profile?.email ?? userId}`,
  });

  return NextResponse.json({ success: true });
}
