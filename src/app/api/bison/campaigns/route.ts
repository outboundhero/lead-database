import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { bisonInstances } from "@/lib/bison/keys";

// Live Email Bison campaign read across ALL configured instances: the client
// runs three separate Bison installs (outboundhero / facilityreach /
// outboundclean), each with its own API token (EMAILBISON_KEYS json map, or a
// single EMAILBISON_API_KEY). Campaigns are merged and tagged with their
// instance domain so pushes route to the right install. A 30-second in-memory
// cache keeps bursts cheap while staying effectively real-time; ?fresh=1
// bypasses it.

const CACHE_TTL_MS = 30_000;
const MAX_PAGES = 50; // pagination safety cap per instance
let cache: { at: number; data: unknown; errors: string[] } | null = null;

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instances = bisonInstances();
  if (instances.length === 0) {
    return NextResponse.json(
      { error: "No Bison keys configured (EMAILBISON_KEYS or EMAILBISON_API_KEY)" },
      { status: 503 }
    );
  }

  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  if (!fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json({ campaigns: cache.data, errors: cache.errors, cached: true });
  }

  const campaigns: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  await Promise.all(
    instances.map(async ({ domain, key }) => {
      try {
        // Bison paginates Laravel-style (data + links.next/meta) — follow
        // links.next until exhausted so instances with many campaigns aren't
        // silently truncated to the first page.
        let url: string | null = `https://${domain}/api/campaigns`;
        for (let page = 0; url && page < MAX_PAGES; page++) {
          const res: Response = await fetch(url, {
            headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
            cache: "no-store",
          });
          if (!res.ok) {
            errors.push(`${domain}: HTTP ${res.status}`);
            return;
          }
          const json = await res.json();
          const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
          for (const c of list) {
            campaigns.push({ ...c, instance_url: domain });
          }
          if (list.length === 0) break;
          url = typeof json?.links?.next === "string" ? json.links.next : null;
        }
      } catch (err) {
        errors.push(`${domain}: ${err instanceof Error ? err.message : "fetch failed"}`);
      }
    })
  );

  // Don't cache a total failure — an empty picker would replay for the full
  // TTL even after the instances recover.
  if (campaigns.length > 0 || errors.length === 0) {
    cache = { at: Date.now(), data: campaigns, errors };
  }
  return NextResponse.json({ campaigns, errors, cached: false });
}
