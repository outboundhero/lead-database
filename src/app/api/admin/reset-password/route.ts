import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/api/log-audit";

export async function POST(request: NextRequest) {
  const supabase = createAdminClient();

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

  // Get user email
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("email")
    .eq("id", userId)
    .single();

  if (!profile?.email) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  // Send password reset email
  const { error } = await supabase.auth.resetPasswordForEmail(profile.email, {
    redirectTo: `${request.nextUrl.origin}/login`,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await logAudit({
    action: "Password Reset",
    performedBy,
    details: `User Email: ${profile.email}`,
  });

  return NextResponse.json({ success: true });
}
