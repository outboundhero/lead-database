import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import {
  cleanPeopleFilters,
  cleanTag,
  clientInfo,
  createRun,
  geo,
  modes,
  plan,
  RUN_FIELDS,
  runsFor,
  savedPeople,
  TAG_RE,
  targetingOf,
} from "@/lib/aiark/server";
import type { PeopleFilters, RunMode, RunStrategy } from "@/lib/aiark/types";

// GET  /api/aiark/runs?tag=ABC — a client's AI Ark runs, newest first (the
//      tab polls this while a run is going).
// POST /api/aiark/runs {tag, mode, strategy, size, matchCount?} — queues a
//      pull. It always uses the client's SAVED people filters and its current
//      rules, never filters from the request, so a run is exactly what the tab
//      showed as saved. One active run per client. The enrichment worker does
//      the pulling. Manager and up — a live run spends AI Ark credits.

export const dynamic = "force-dynamic";

const MAX_SIZE = 10_000;

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (tag && !TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const runs = await withTx((c) => runsFor(c, tag || null), { readOnly: true, timeoutMs: 8_000 });
    return NextResponse.json({ runs }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("aiark/runs GET:", err);
    return NextResponse.json({ error: "Could not load the runs" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; mode?: unknown; strategy?: unknown; size?: unknown; matchCount?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const mode = body.mode === "live" || body.mode === "demo" ? (body.mode as RunMode) : null;
  const strategy = body.strategy === "single" || body.strategy === "export" ? (body.strategy as RunStrategy) : null;
  const size = Number(body.size);
  if (!mode) return NextResponse.json({ error: "mode must be live or demo" }, { status: 400 });
  if (!strategy) return NextResponse.json({ error: "strategy must be single or export" }, { status: 400 });
  if (!Number.isInteger(size) || size < 1 || size > MAX_SIZE) {
    return NextResponse.json({ error: `size must be a whole number from 1 to ${MAX_SIZE.toLocaleString("en-US")}` }, { status: 400 });
  }
  const m = modes();
  if (!m[mode].ready) return NextResponse.json({ error: m[mode].why, needsKey: mode === "live" }, { status: 409 });
  if (mode === "live" && strategy === "export" && !m.exportLive.ready) {
    return NextResponse.json({ error: m.exportLive.why }, { status: 409 });
  }
  const matchCount = typeof body.matchCount === "number" && Number.isSafeInteger(body.matchCount) && body.matchCount >= 0 ? body.matchCount : null;

  try {
    const out = await withTx(
      async (c) => {
        // Two clicks at once must not start two runs for the client.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('aiark-run:' || $1))`, [tag]);
        const { rows: active } = await c.query(
          `SELECT id FROM aiark_runs WHERE client_tag = $1 AND status IN ('queued', 'running') LIMIT 1`,
          [tag]
        );
        if (active.length) return { status: 409, error: `${tag} already has a run going. Cancel it or let it finish first.` };
        const client = await clientInfo(c, tag);
        if (!client) return { status: 404, error: `${tag} is not a client` };
        const targeting = await targetingOf(c, tag);
        const saved = await savedPeople(c, tag);
        if (!saved) return { status: 400, error: "Save the people filters first: a pull always uses the saved filters." };
        const { updated_at: peopleUpdatedAt, ...raw } = saved;
        const people = cleanPeopleFilters(raw).value as PeopleFilters;
        const p = plan(targeting, people, await geo(c));
        const blocked = [...p.blockers, ...p.pullBlockers];
        if (blocked.length) return { status: 400, error: blocked.join(" ") };
        const run = await createRun(c, {
          tag,
          mode,
          strategy,
          size,
          filters: {
            people,
            people_updated_at: peopleUpdatedAt,
            targeting_updated_at: targeting?.updated_at ?? null,
            report: p.report,
            notes: p.notes,
          },
          requests: p.requests,
          matchCount,
          createdBy: auth.user.id,
        });
        const { rows } = await c.query(`SELECT ${RUN_FIELDS} FROM aiark_runs r LEFT JOIN user_profiles up ON up.id = r.created_by WHERE r.id = $1`, [run.id]);
        return { run: rows[0] };
      },
      { timeoutMs: 20_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "aiark_run",
      performedBy: auth.user.id,
      details: `${tag}: ${mode} ${strategy} pull of ${size} people queued (run ${out.run.id})`,
    });
    return NextResponse.json({ run: out.run }, { status: 201 });
  } catch (err) {
    console.error("aiark/runs POST:", err);
    return NextResponse.json({ error: "Could not start the run" }, { status: 500 });
  }
}
