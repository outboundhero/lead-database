import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { hasPermission } from "@/types/auth";
import {
  cleanTag,
  clientInfo,
  companyFiltersFor,
  companyModes,
  companyPlanView,
  companyRunsFor,
  countsFor,
  creditsLeft,
  geo,
  pipelineView,
  readPipelineSettings,
  savedPeople,
  TAG_RE,
  targetingOf,
  workerView,
} from "@/lib/companies/server";
import type { CompaniesSetup } from "@/lib/companies/types";

// GET /api/companies/setup?tag=ABC: everything the Companies tab shows for a
// client. Its rules (client_targeting), its company filters (the size and
// industries saved on the AI Ark tab, or a cleaning client's standard ones),
// what AI Ark would be asked, its pulls, the counts on its list, the worker,
// the settings' switch and caps (the stored settings too, for admins) and the
// AI Ark balance, a free call. No paid call, nothing stored. Manager and up.

export const dynamic = "force-dynamic";

const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);

async function setupFor(c: PoolClient, tag: string | null, admin: boolean) {
  const settings = await readPipelineSettings(c);
  const base = {
    modes: companyModes(),
    worker: workerView(await workerState(c)),
    pipeline: pipelineView(settings.value),
    settings: admin ? settings : null,
  };
  if (!tag) {
    return { ...base, client: null, targeting: null, filters: companyFiltersFor(null, null), plan: null, runs: [], counts: null };
  }
  const client = await clientInfo(c, tag);
  const targeting = await targetingOf(c, tag);
  const filters = companyFiltersFor(await savedPeople(c, tag), client?.client_type ?? null);
  return {
    ...base,
    client,
    targeting: targeting
      ? {
          updatedAt: targeting.updated_at,
          version: targeting.version,
          places: count(targeting.include_locations),
          excludePlaces: count(targeting.exclude_locations),
          excludeTerms: count(targeting.exclude_terms),
        }
      : null,
    filters,
    plan: companyPlanView(targeting, filters.value, await geo(c), client?.client_type ?? null),
    runs: await companyRunsFor(c, tag),
    counts: await countsFor(c, tag),
  };
}

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (tag && !TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx((c) => setupFor(c, tag || null, hasPermission(auth.role, "admin")), { readOnly: true, timeoutMs: 10_000 });
    const credits: CompaniesSetup["credits"] = {};
    if (out.modes.demo.ready) credits.demo = await creditsLeft("demo");
    if (out.modes.live.ready) credits.live = await creditsLeft("live");
    const body: CompaniesSetup = { ...out, credits };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("companies/setup:", err);
    return NextResponse.json({ error: "Could not load the Companies tab" }, { status: 500 });
  }
}
