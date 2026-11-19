import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import {
  computeCoverage,
  coverageSettings,
  hasMinimumColumn,
  minimumOf,
  storeCoverage,
  wholeMinimum,
} from "../../../../../scripts/lib/coverage.mjs";

// GET /api/clients/location-coverage?tag=X[&threshold=N][&fresh=1]
//
// Per-location lead availability for ONE client, so an operator can see which
// of the client's target areas need more scraping rather than only that the
// total is low.
//
// Scope is the client's INCLUDE (preferred) locations only. Exclusions are
// deliberately not counted: a place the client does not want needs no leads.
//
// A place is low under the client's own minimum (client_targeting
// .min_leads_per_place, set in the Rules dialog), else the weekly top-up's
// default (500); ?threshold=N asks for another number. General inboxes the
// Clay General inboxes filter matches are not counted once that filter is
// loaded. The computation is scripts/lib/coverage.mjs, shared with the
// coverage refresh and the weekly top-up.
//
// Cost: one grouped scan over the client's eligible set (13-30s measured), so
// results are cached per tag and the caller is expected to fetch in the
// background rather than block on it.

const CACHE_TTL_MS = 15 * 60_000;
const cache = new Map<string, { at: number; payload: unknown }>();

export async function GET(request: NextRequest) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const tag = request.nextUrl.searchParams.get("tag")?.trim();
  if (!tag) return NextResponse.json({ error: "tag required" }, { status: 400 });
  const asked = Number(request.nextUrl.searchParams.get("threshold"));
  // A number the caller names wins, clamped as before; without one the client's own minimum applies.
  const forced = Number.isFinite(asked) && asked > 0 ? Math.min(Math.max(Math.round(asked), 1), 100_000) : null;
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";

  const key = `${tag}|${forced ?? "own"}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return NextResponse.json({ ...(hit.payload as object), cached: true });
  }

  const pool = getPool();

  // PRECOMPUTED FIRST (client decision 2026-09-02): the client-sync cron runs
  // scripts/refresh-location-coverage.mjs after every targeting sync and stores
  // one row per client, so selecting a client reads a stored answer instantly
  // instead of triggering a 7-10s grouped scan. The live computation below
  // remains only for fresh=1 (the popup's Recheck button) and for a client the
  // cron has not covered yet.
  if (!fresh) {
    const { rows } = await pool.query(
      `select payload, computed_at from client_location_coverage where client_tag = $1`, [tag]);
    if (rows.length) {
      const payload = { ...(rows[0].payload as object), computedAt: new Date(rows[0].computed_at).toISOString() };
      cache.set(key, { at: Date.now(), payload });
      return NextResponse.json({ ...payload, cached: false, precomputed: true });
    }
  }

  try {
    const own = (await hasMinimumColumn(pool)) ? "min_leads_per_place" : "null::int AS min_leads_per_place";
    const { rows: tRows } = await pool.query(
      `select include_locations, ${own} from client_targeting where client_tag = $1`, [tag]);
    const settings = await coverageSettings(pool);
    const { minimum } = minimumOf({ forced, own: wholeMinimum(tRows[0]?.min_leads_per_place), defaultMinimum: settings.defaultMinimum });
    const entries = Array.isArray(tRows[0]?.include_locations) ? tRows[0].include_locations : [];
    if (entries.length === 0) {
      const payload = { tag, threshold: minimum, locations: [], low: [], totalAvailable: null, hasTargeting: false };
      cache.set(key, { at: Date.now(), payload });
      return NextResponse.json({ ...payload, cached: false });
    }

    // The pool's default statement_timeout is too tight for the largest
    // clients; the scan runs in its own transaction with an explicit budget so
    // it either answers or fails loudly within it.
    const { payload, total } = await computeCoverage(pool, {
      tag, entries, threshold: minimum, pattern: settings.pattern, patternSha256: settings.patternSha256, timeoutMs: 110_000,
    });
    cache.set(key, { at: Date.now(), payload });
    if (cache.size > 40) cache.delete(cache.keys().next().value as string);
    // A live recompute (Recheck, or a client the cron missed) refreshes the
    // stored row too, so the next selection gets this answer instantly.
    await storeCoverage(pool, { tag, threshold: minimum, total, payload }).catch(() => {});
    return NextResponse.json({ ...payload, cached: false });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "coverage failed" },
      { status: 500 }
    );
  }
}
