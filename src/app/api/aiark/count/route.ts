import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { enrichPool, isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import {
  AiArkError,
  aiArkFor,
  cleanPeopleFilters,
  cleanTag,
  clientInfo,
  competitorsFor,
  geo,
  modes,
  peopleOrDefaults,
  personInputs,
  plan,
  savedPeople,
  subsetTargeting,
  TAG_RE,
  targetingOf,
} from "@/lib/aiark/server";
import { recordTopupCount, topupCountFits, topupPullForCount } from "../../../../../scripts/lib/topup/pulls.mjs";
import { samePlaces } from "../../../../../scripts/lib/aiark/start-run.mjs";
import type { CountResult, PeopleFilters, RunMode } from "@/lib/aiark/types";

// POST /api/aiark/count {tag, mode, filters?, rulesVersion?, places?, topupPullId?}:
// how many people AI Ark has for a client's rules and people filters, one
// People Preview page per search, 1 credit each (demo: made-up people, nothing
// spent). `filters` lets the tab count before saving; without it the saved
// filters (or the starting point) are used. Counts include people bought
// before: leaving them out takes AI Ark exclusion lists, which are kept for
// pulls. `rulesVersion` is the rules' version the tab loaded: when the rules
// have changed since, the answer is 409 with `changed` and nothing is spent.
// The answer carries the version it searched with, so a count made before a
// rules change is not taken for one made after. Manager and up.
//
// places (optional): some of the client's own include locations; the count
// covers only those. topupPullId (optional): a prepared weekly top-up pull of
// this client. The count then covers the pull's places, is refused unless the
// pull could start (the top-up's switches, the client's receive rule) and its
// credits plus the pull's brake fit the weekly budget, and the credits it
// spends are added to topup_pulls.count_credits, so the budget counts them.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SAMPLE = 10;

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; mode?: unknown; filters?: unknown; rulesVersion?: unknown; places?: unknown; topupPullId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const mode = body.mode === "live" || body.mode === "demo" ? (body.mode as RunMode) : null;
  if (!mode) return NextResponse.json({ error: "mode must be live or demo" }, { status: 400 });
  const ready = modes()[mode];
  if (!ready.ready) return NextResponse.json({ error: ready.why, needsKey: mode === "live" }, { status: 409 });

  let override: PeopleFilters | null = null;
  if (body.filters !== undefined) {
    const { value, errors } = cleanPeopleFilters(body.filters);
    if (errors.length) return NextResponse.json({ error: errors.join(" · "), errors }, { status: 400 });
    override = value as PeopleFilters;
  }
  if (body.places !== undefined && body.places !== null && !Array.isArray(body.places)) {
    return NextResponse.json({ error: "places must be a list of the client's own places" }, { status: 400 });
  }
  if (body.topupPullId !== undefined && body.topupPullId !== null && !isUuid(body.topupPullId)) {
    return NextResponse.json({ error: "topupPullId must be a top-up pull id" }, { status: 400 });
  }
  const topupPullId = isUuid(body.topupPullId) ? body.topupPullId : null;
  if (topupPullId && override) {
    return NextResponse.json({ error: "A top-up pull counts with the client's saved filters, not filters from the page." }, { status: 400 });
  }

  let requests: object[];
  let rulesVersion: string | null;
  try {
    const p = await withTx(
      async (c) => {
        const client = await clientInfo(c, tag);
        const targeting = await targetingOf(c, tag);
        let places: unknown[] | null = Array.isArray(body.places) ? body.places : null;
        const pull = topupPullId ? await topupPullForCount(c, { tag, pullId: topupPullId, clientType: client?.client_type ?? null }) : null;
        if (pull && "error" in pull) return pull;
        if (pull) {
          if (places && !samePlaces(places, pull.places)) {
            return { status: 400, error: "These places are not the prepared top-up pull's, so nothing was counted." };
          }
          places = pull.places;
        }
        let use = targeting;
        if (places && targeting) {
          const sub = subsetTargeting(targeting, places);
          if (sub.error !== null) return { status: 400, error: sub.error.replace("nothing was started", "nothing was counted") };
          use = sub.targeting;
        }
        const people = override ?? peopleOrDefaults(await savedPeople(c, tag), client?.client_type ?? null).value;
        const competitors = await competitorsFor(c, client?.client_type ?? null);
        const planned = { ...plan(use, people, await geo(c), client?.client_type ?? null, competitors), rulesVersion: targeting?.version ?? null };
        if (pull && !planned.blockers.length) {
          // The count's credits (1 a search) and the pull's brake must both fit the budget left.
          const fits = await topupCountFits(c, { tag, pull, searches: planned.searches });
          if ("error" in fits) return fits;
        }
        return planned;
      },
      { readOnly: true, timeoutMs: 10_000 }
    );
    if ("error" in p) return NextResponse.json({ error: p.error }, { status: p.status });
    if (body.rulesVersion !== undefined && p.rulesVersion !== body.rulesVersion) {
      return NextResponse.json(
        { error: `${tag}'s rules (locations and exclusions) changed since this page loaded them, so nothing was counted. Reload to see them.`, changed: true },
        { status: 409 }
      );
    }
    if (p.blockers.length) return NextResponse.json({ error: p.blockers.join(" ") }, { status: 400 });
    requests = p.requests;
    rulesVersion = p.rulesVersion;
  } catch (err) {
    console.error("aiark/count plan:", err);
    return NextResponse.json({ error: "Could not work out the search" }, { status: 500 });
  }

  const got = await aiArkFor(mode, { env: process.env, db: enrichPool() });
  if (!got.client) return NextResponse.json({ error: got.why, needsKey: mode === "live" }, { status: 409 });
  const perSearch: number[] = [];
  let sample: CountResult["sample"] = [];
  let credits = 0;
  try {
    for (let i = 0; i < requests.length; i++) {
      const page = await got.client.preview(requests[i], { page: 0, size: i === 0 ? SAMPLE : 1 });
      credits += 1;
      perSearch.push(page.totalElements);
      if (i === 0) {
        sample = page.content.slice(0, SAMPLE).map((p: unknown) => {
          const x = personInputs(p) as Record<string, string | undefined>;
          return {
            name: x.full_name ?? "—",
            title: x.title ?? null,
            company: x.company ?? null,
            place: [x.city, x.state].filter(Boolean).join(", ") || x.country || null,
          };
        });
      }
    }
  } catch (e) {
    const err = e instanceof AiArkError ? e : null;
    const status = err?.kind === "credits" ? 402 : err?.kind === "rate" ? 429 : 502;
    if (topupPullId && credits) await recordTopupCount(enrichPool(), topupPullId, { credits, total: null });
    if (mode === "live" && credits) {
      await logAudit({ action: "aiark_count", performedBy: auth.user.id, details: `${tag}: stopped after ${credits} credits — ${err?.message ?? "error"}` });
    }
    return NextResponse.json({ error: err?.message ?? "AI Ark did not answer", credits }, { status });
  }
  const total = perSearch.reduce((s, n) => s + n, 0);
  if (topupPullId) await recordTopupCount(enrichPool(), topupPullId, { credits, total });
  if (mode === "live") {
    await logAudit({
      action: "aiark_count",
      performedBy: auth.user.id,
      details: `${tag}: ${total} matches in ${perSearch.length} searches, ${credits} credits${topupPullId ? ` (weekly top-up pull ${topupPullId})` : ""}`,
    });
  }
  const out: CountResult = { mode, total, perSearch, credits, sample, rulesVersion };
  return NextResponse.json(out);
}
