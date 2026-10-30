import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import {
  cleanPeopleFilters,
  cleanTag,
  clientInfo,
  creditsLeft,
  DEPARTMENT_SUGGESTIONS,
  geo,
  INDUSTRY_SUGGESTIONS,
  modes,
  peopleOrDefaults,
  planView,
  runsFor,
  savedPeople,
  SENIORITY,
  TAG_RE,
  targetingOf,
} from "@/lib/aiark/server";
import type { AiArkSetup, PeopleFilters } from "@/lib/aiark/types";

// GET  /api/aiark/setup?tag=ABC — everything the AI Ark tab shows for a
//      client: its rules, its people filters (saved, or the starting point),
//      what AI Ark would be asked, its runs, the credits left and whether the
//      worker is up. Reading the balance is a free AI Ark call.
// POST /api/aiark/setup {tag, filters} — the plan for filters not saved yet.
//      No AI Ark call, nothing spent.
// Manager and up, like the rest of the AI Ark tab.

export const dynamic = "force-dynamic";

async function setupFor(c: PoolClient, tag: string | null, override: PeopleFilters | null) {
  const g = await geo(c);
  const w = await workerState(c);
  const base = {
    modes: modes(),
    worker: w ? { online: w.online, secondsAgo: w.seconds_ago } : null,
    suggestions: { departments: DEPARTMENT_SUGGESTIONS, industries: INDUSTRY_SUGGESTIONS, seniority: SENIORITY },
  };
  if (!tag) {
    const people = peopleOrDefaults(null, null);
    return { ...base, client: null, targeting: null, people, plan: planView(null, people.value, g), runs: await runsFor(c, null) };
  }
  const client = await clientInfo(c, tag);
  const targeting = await targetingOf(c, tag);
  const people = peopleOrDefaults(await savedPeople(c, tag), client?.client_type ?? null);
  const p = planView(targeting, override ?? people.value, g);
  return {
    ...base,
    client,
    targeting: targeting
      ? {
          updatedAt: targeting.updated_at,
          places: Array.isArray(targeting.include_locations) ? targeting.include_locations.length : 0,
          excludeTerms: Array.isArray(targeting.exclude_terms) ? targeting.exclude_terms.length : 0,
          commercialCleaning: Boolean(targeting.commercial_cleaning),
        }
      : null,
    people,
    plan: p,
    runs: await runsFor(c, tag),
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (tag && !TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx((c) => setupFor(c, tag || null, null), { readOnly: true, timeoutMs: 10_000 });
    const credits: AiArkSetup["credits"] = {};
    if (out.modes.demo.ready) credits.demo = await creditsLeft("demo");
    if (out.modes.live.ready) credits.live = await creditsLeft("live");
    return NextResponse.json({ ...out, credits }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("aiark/setup:", err);
    return NextResponse.json({ error: "Could not load the AI Ark tab" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; filters?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const { value, errors } = cleanPeopleFilters(body.filters);
  try {
    const out = await withTx((c) => setupFor(c, tag, value as PeopleFilters), { readOnly: true, timeoutMs: 10_000 });
    return NextResponse.json({ plan: out.plan, errors }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("aiark/setup POST:", err);
    return NextResponse.json({ error: "Could not work out the plan" }, { status: 500 });
  }
}
