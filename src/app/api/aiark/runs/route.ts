import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, geo, modes, RUN_FIELDS, runsFor, startRun, TAG_RE } from "@/lib/aiark/server";
import type { RunMode, RunStrategy } from "@/lib/aiark/types";

// GET  /api/aiark/runs?tag=ABC — a client's AI Ark runs, newest first, and the
//      worker's heartbeat (the tab polls this while a run is going).
// POST /api/aiark/runs {tag, mode, strategy, size, matchCount, peopleVersion,
//      rulesVersion, places?, topupPullId?}: queues a pull. It uses the
//      client's SAVED people filters (with none saved, a cleaning client's
//      standard filters) and its current rules, never filters from the request.
//      The page sends the versions of both it loaded, and a 409 with `changed`
//      answers any change since (the page then reloads them), so a run is what
//      the tab showed. A count must come first (matchCount). One active run per
//      client. The enrichment worker does the pulling. Manager and up: a live
//      run spends AI Ark credits.
//
//      places (optional): some of the client's own include locations; the
//      search covers only those. topupPullId (optional): a prepared weekly
//      top-up pull of this client (the Sharing page's Low places tab); the run
//      is marked as a top-up run and must fit the top-up's switches, the
//      client's receive rule, pulls_per_day and the weekly budget. The checks
//      are scripts/lib/aiark/start-run.mjs's, which the topup-worker uses too.

export const dynamic = "force-dynamic";

const MAX_SIZE = 10_000;

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (tag && !TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => {
        const w = await workerState(c);
        return { runs: await runsFor(c, tag || null), worker: w ? { online: w.online, secondsAgo: w.seconds_ago } : null };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("aiark/runs GET:", err);
    return NextResponse.json({ error: "Could not load the runs" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: {
    tag?: unknown; mode?: unknown; strategy?: unknown; size?: unknown; matchCount?: unknown; peopleVersion?: unknown; rulesVersion?: unknown;
    places?: unknown; topupPullId?: unknown;
  };
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
  if (matchCount === null) {
    return NextResponse.json({ error: "Count the matches first: a pull starts only after a count for the saved filters." }, { status: 400 });
  }
  const peopleVersion = typeof body.peopleVersion === "string" ? body.peopleVersion : null;
  const rulesVersion = typeof body.rulesVersion === "string" ? body.rulesVersion : null;
  if (body.places !== undefined && body.places !== null && !Array.isArray(body.places)) {
    return NextResponse.json({ error: "places must be a list of the client's own places" }, { status: 400 });
  }
  const places = Array.isArray(body.places) ? body.places : null;
  if (body.topupPullId !== undefined && body.topupPullId !== null && !isUuid(body.topupPullId)) {
    return NextResponse.json({ error: "topupPullId must be a top-up pull id" }, { status: 400 });
  }
  const topupPullId = isUuid(body.topupPullId) ? body.topupPullId : null;

  try {
    const out = await withTx(
      async (c) => {
        const started = await startRun(c, {
          tag,
          mode,
          strategy,
          size,
          matchCount,
          versions: { people: peopleVersion, rules: rulesVersion },
          places,
          topupPullId,
          createdBy: auth.user.id,
          geo: () => geo(c),
          workerOnline: async (db: unknown) => Boolean((await workerState(db as typeof c))?.online),
        });
        if ("error" in started) return started;
        const { rows } = await c.query(`SELECT ${RUN_FIELDS} FROM aiark_runs r LEFT JOIN user_profiles up ON up.id = r.created_by WHERE r.id = $1`, [started.run.id]);
        return { run: rows[0], topup: Boolean(started.pull) };
      },
      { timeoutMs: 20_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error, changed: out.changed === true, code: out.code }, { status: out.status });
    await logAudit({
      action: "aiark_run",
      performedBy: auth.user.id,
      details: `${tag}: ${mode} ${strategy} pull of ${size} people queued (run ${out.run.id})${
        out.topup ? `, a weekly top-up pull (${topupPullId})` : places ? `, limited to ${places.length} of its places` : ""
      }`,
    });
    return NextResponse.json({ run: out.run }, { status: 201 });
  } catch (err) {
    console.error("aiark/runs POST:", err);
    return NextResponse.json({ error: "Could not start the run" }, { status: 500 });
  }
}
