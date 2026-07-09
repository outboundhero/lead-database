import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// Live Email Bison campaign read: the database reads Bison in real time so a
// campaign created in Bison is visible here immediately (for client routing
// and location searches). A 30-second in-memory cache keeps bursts cheap while
// staying effectively real-time; pass ?fresh=1 to bypass it.

const CACHE_TTL_MS = 30_000;
let cache: { at: number; data: unknown } | null = null;

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.EMAILBISON_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "EMAILBISON_API_KEY is not configured" },
      { status: 503 }
    );
  }

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ campaigns: cache.data, cached: true });
  }

  const base = (process.env.EMAILBISON_BASE_URL || "https://app.outboundhero.co").replace(/\/$/, "");
  const res = await fetch(`${base}/api/campaigns`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `Email Bison responded ${res.status}` },
      { status: 502 }
    );
  }
  const json = await res.json();
  const campaigns = Array.isArray(json?.data) ? json.data : json;
  cache = { at: Date.now(), data: campaigns };
  return NextResponse.json({ campaigns, cached: false });
}
