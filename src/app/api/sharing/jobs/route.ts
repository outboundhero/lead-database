import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { notApplied, sharingTx, tagOf } from "@/lib/sharing/db";
import { JOBS_CURSOR, listJobs, switchView } from "@/lib/sharing/server";
import type { JobsAnswer } from "@/lib/sharing/types";
import { settingsFrom } from "../../../../../scripts/lib/enrich/settings.mjs";

// GET /api/sharing/jobs?state=&origin=&before=&limit=: the share jobs, newest
// first (share_jobs, migration 134), a page at a time (before: the previous
// page's next), with counts by state, the jobs that decided at the place wait
// limit this week, the switch and whether the worker running now runs the
// share step. Manager and up. Before migration 134 the answer says so (ready
// false).

export const dynamic = "force-dynamic";

const STATES = new Set(["waiting", "deciding", "previewed", "applied", "skipped", "no_lead_list", "error", "undone"]);

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const q = req.nextUrl.searchParams;
  const state = q.get("state") || null;
  if (state && !STATES.has(state)) return NextResponse.json({ error: "Unknown state" }, { status: 400 });
  const originRaw = q.get("origin");
  const origin = originRaw ? tagOf(originRaw) : null;
  if (originRaw && !origin) return NextResponse.json({ error: "origin must be a client tag" }, { status: 400 });
  const before = q.get("before") || null;
  if (before && !JOBS_CURSOR.test(before)) return NextResponse.json({ error: "before must be the next value of a page" }, { status: 400 });
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  try {
    const out = await sharingTx(getPool(), (c) => listJobs(c, { state, origin, before, limit }), { readOnly: true, timeoutMs: 15_000 });
    return NextResponse.json({ ready: true, ...out } satisfies JobsAnswer, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (notApplied(err)) {
      const empty: JobsAnswer = { ready: false, jobs: [], next: null, byState: {}, waitedLimit: 0, worker: null, switch: switchView(settingsFrom([])) };
      return NextResponse.json(empty);
    }
    console.error("sharing/jobs:", err);
    return NextResponse.json({ error: "Could not load the share jobs" }, { status: 500 });
  }
}
