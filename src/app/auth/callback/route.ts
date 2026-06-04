import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  // Use the public domain, not the internal container origin (localhost:8080)
  const origin = request.headers.get("x-forwarded-host")
    ? `${request.headers.get("x-forwarded-proto") || "https"}://${request.headers.get("x-forwarded-host")}`
    : "https://database-renaissance-production.up.railway.app";

  const supabase = await createClient();

  if (code) {
    const { data } = await supabase.auth.exchangeCodeForSession(code);

    // If type=invite in query params, redirect to accept-invite
    if (type === "invite") {
      return NextResponse.redirect(new URL("/accept-invite", origin));
    }

    // If type=recovery, redirect to set-password
    if (type === "recovery") {
      return NextResponse.redirect(new URL("/set-password", origin));
    }

    // Check if this is an invited user who hasn't set up their account
    // (user_metadata.role exists but they came through an invite link)
    if (data?.user?.user_metadata?.role && !data?.user?.user_metadata?.setup_complete) {
      return NextResponse.redirect(new URL("/accept-invite", origin));
    }
  } else if (tokenHash && type) {
    await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as "invite" | "recovery" | "email" });

    if (type === "invite") {
      return NextResponse.redirect(new URL("/accept-invite", origin));
    }
    if (type === "recovery") {
      return NextResponse.redirect(new URL("/set-password", origin));
    }
  }

  return NextResponse.redirect(new URL("/leads", origin));
}
