import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";

// GET /api/clients/location-coverage?tag=X[&threshold=500][&fresh=1]
//
// Per-location lead availability for ONE client, so an operator can see which
// of the client's target areas need more scraping rather than only that the
// total is low.
//
// Scope is the client's INCLUDE (preferred) locations only. Exclusions are
// deliberately not counted: a place the client does not want needs no leads.
//
// Cost: one grouped scan over the client's eligible set (13-30s measured), so
// results are cached per tag and the caller is expected to fetch in the
// background rather than block on it.

const ELIGIBLE =
  "l.email is not null and l.email <> '' and l.is_bounced = false " +
  "and (l.validation_status in ('valid','catch_all') or l.validation_status is null)";

const CACHE_TTL_MS = 15 * 60_000;
type Entry = { country: string; state?: string; city?: string };
type Row = { label: string; kind: "city" | "state"; country: string; state: string | null; city: string | null; available: number; resolved: boolean };
const cache = new Map<string, { at: number; payload: unknown }>();

export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tag = request.nextUrl.searchParams.get("tag")?.trim();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  const threshold = Math.min(Math.max(Number(request.nextUrl.searchParams.get("threshold")) || 500, 1), 100_000);
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";

  const key = `${tag}|${threshold}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...(hit.payload as object), cached: true });
  }

  const pool = getPool();
  try {
    const admin = createAdminClient();
    const { data: targeting } = await admin
      .from("client_targeting").select("include_locations").eq("client_tag", tag).maybeSingle();
    const entries: Entry[] = Array.isArray(targeting?.include_locations) ? targeting!.include_locations : [];
    if (entries.length === 0) {
      const payload = { tag, threshold, locations: [], low: [], totalAvailable: null, hasTargeting: false };
      cache.set(key, { at: Date.now(), payload });
      return NextResponse.json({ ...payload, cached: false });
    }

    const { rows: eligRows } = await pool.query(
      `select fn_client_eligibility_conditions($1) as conds`, [tag]);
    const conds: string[] = eligRows[0]?.conds ?? [];
    const notPushed = `not exists (
      select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
      where pb.client_tag = $1 and pi.lead_id = l.id and pi.status = 'sent')`;
    const where = [ELIGIBLE, ...conds, notPushed].join(" and ");

    // ONE grouped scan. Counting each location with its own query would mean
    // 105 scans of an 8.2M-row table for a client like JPCA.
    const { rows: agg } = await pool.query(
      `select l.country_code, l.state_code, l.location_id, count(*)::int as n
         from leads l where ${where}
        group by 1, 2, 3`, [tag]);

    const byLocation = new Map<string, number>();
    const byState = new Map<string, number>();
    let totalAvailable = 0;
    for (const r of agg) {
      totalAvailable += r.n;
      if (r.location_id != null) byLocation.set(String(r.location_id), (byLocation.get(String(r.location_id)) ?? 0) + r.n);
      const sk = `${r.country_code ?? ""}|${r.state_code ?? ""}`;
      byState.set(sk, (byState.get(sk) ?? 0) + r.n);
    }

    // Resolve every city entry to geoname ids in ONE round trip, matching
    // fn_location_entry_condition exactly (city_key on the normalised name).
    const cityEntries = entries.filter((e) => e.city && e.state);
    const idsByIdx = new Map<number, string[]>();
    if (cityEntries.length > 0) {
      const { rows } = await pool.query(
        `select e.idx::int as idx, array_agg(g.geoname_id::text) as ids
           from unnest($1::text[], $2::text[], $3::text[]) with ordinality as e(country, state, city, idx)
           join geo_admin1 a on a.country_code = e.country and a.state_code = upper(e.state)
           join geo_locations g on g.country_code = e.country and g.admin1_code = a.admin1_code
            and g.city_key = regexp_replace(lower(e.city), '[^a-z]', '', 'g')
          group by e.idx`,
        [cityEntries.map((e) => e.country), cityEntries.map((e) => e.state), cityEntries.map((e) => e.city)]
      );
      for (const r of rows) idsByIdx.set(Number(r.idx), r.ids ?? []);
    }

    let cityIdx = 0;
    const locations: Row[] = entries.map((e) => {
      if (e.city && e.state) {
        cityIdx += 1;
        const ids = idsByIdx.get(cityIdx) ?? [];
        return {
          label: `${e.city}, ${e.state}`,
          kind: "city" as const,
          country: e.country, state: e.state ?? null, city: e.city ?? null,
          available: ids.reduce((s, id) => s + (byLocation.get(id) ?? 0), 0),
          // An entry the geo reference doesn't know matches nothing at push
          // time either — surfaced so it isn't read as "no leads here".
          resolved: ids.length > 0,
        };
      }
      const sk = `${e.country}|${String(e.state ?? "").toUpperCase()}`;
      return {
        label: e.state ? `${e.state} (state-wide)` : e.country,
        kind: "state" as const,
        country: e.country, state: e.state ?? null, city: null,
        available: e.state ? (byState.get(sk) ?? 0) : totalAvailable,
        resolved: true,
      };
    });

    locations.sort((a, b) => a.available - b.available);
    const payload = {
      tag,
      threshold,
      hasTargeting: true,
      totalAvailable,
      locations,
      low: locations.filter((l) => l.available < threshold),
    };
    cache.set(key, { at: Date.now(), payload });
    if (cache.size > 40) cache.delete(cache.keys().next().value as string);
    return NextResponse.json({ ...payload, cached: false });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "coverage failed" },
      { status: 500 }
    );
  }
}
