import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  // Auth check
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Role check
  const supabase = createAdminClient();
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (!profile || !["owner", "admin"].includes(profile.role)) {
    return NextResponse.json({ error: "Only owners and admins can use this" }, { status: 403 });
  }

  let body: { emails: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { emails } = body;
  if (!emails?.length) {
    return NextResponse.json({ error: "No emails provided" }, { status: 400 });
  }

  if (emails.length > 100000) {
    return NextResponse.json({ error: "Maximum 100,000 emails per check" }, { status: 400 });
  }

  try {
    const found: string[] = [];
    const notFound: string[] = [];

    // Check in batches of 1000
    for (let i = 0; i < emails.length; i += 1000) {
      const chunk = emails.slice(i, i + 1000);
      const { data } = await supabase
        .from("leads")
        .select("email")
        .in("email", chunk);

      const foundEmails = new Set((data ?? []).map((r) => r.email));
      for (const email of chunk) {
        if (foundEmails.has(email)) {
          found.push(email);
        } else {
          notFound.push(email);
        }
      }
    }

    return NextResponse.json({
      total: emails.length,
      found: found.length,
      notFound: notFound.length,
      foundEmails: found,
      notFoundEmails: notFound,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Check failed" },
      { status: 500 }
    );
  }
}
