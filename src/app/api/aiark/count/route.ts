import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { enrichPool, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import {
  AiArkError,
  aiArkFor,
  cleanPeopleFilters,
  cleanTag,
  clientInfo,
  geo,
  modes,
  peopleOrDefaults,
  personInputs,
  plan,
  savedPeople,
  TAG_RE,
  targetingOf,
} from "@/lib/aiark/server";
import type { CountResult, PeopleFilters, RunMode } from "@/lib/aiark/types";

// POST /api/aiark/count {tag, mode, filters?} — how many people AI Ark has for
// a client's rules and people filters: one People Preview page per search,
// 1 credit each (demo: made-up people, nothing spent). `filters` lets the tab
// count before saving; without it the saved filters (or the starting point)
// are used. Counts include people bought before — leaving them out takes
// AI Ark exclusion lists, which are kept for pulls. Manager and up.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SAMPLE = 10;

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; mode?: unknown; filters?: unknown };
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

  let requests: object[];
  try {
    const p = await withTx(
      async (c) => {
        const client = await clientInfo(c, tag);
        const targeting = await targetingOf(c, tag);
        const people = override ?? peopleOrDefaults(await savedPeople(c, tag), client?.client_type ?? null).value;
        return plan(targeting, people, await geo(c));
      },
      { readOnly: true, timeoutMs: 10_000 }
    );
    if (p.blockers.length) return NextResponse.json({ error: p.blockers.join(" ") }, { status: 400 });
    requests = p.requests;
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
    if (mode === "live" && credits) {
      await logAudit({ action: "aiark_count", performedBy: auth.user.id, details: `${tag}: stopped after ${credits} credits — ${err?.message ?? "error"}` });
    }
    return NextResponse.json({ error: err?.message ?? "AI Ark did not answer", credits }, { status });
  }
  const total = perSearch.reduce((s, n) => s + n, 0);
  if (mode === "live") {
    await logAudit({ action: "aiark_count", performedBy: auth.user.id, details: `${tag}: ${total} matches in ${perSearch.length} searches, ${credits} credits` });
  }
  const out: CountResult = { mode, total, perSearch, credits, sample };
  return NextResponse.json(out);
}
