import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { notApplied, sharingTx, tagOf } from "@/lib/sharing/db";
import { backfillView } from "@/lib/sharing/backfill";
import type { BackfillPreview, BackfillView } from "@/lib/sharing/types";
import { previewBackfill } from "../../../../../scripts/lib/backfill/run.mjs";

// GET /api/sharing/backfill: the Sharing page's Backfill tab (the database
//     backfill, migration 138): the switch and the caps in force, a warning
//     when it is on and no firing ran in the last 2 hours, the newest 20 runs,
//     and per listed client its pool or "isolated", whether it can receive,
//     whether it is on the push list, its places with each pass's progress,
//     its low places, its shares today against the day cap and its live
//     backfill shares by push state. Before 138 it answers ready false.
// GET /api/sharing/backfill?preview=TAG: what the next apply firing would do
//     for that client, read only (nothing is written, not even a run row):
//     per place the windows it would read, the leads checked, those that fit,
//     those it would share within today's caps, and each reason; or why the
//     client would be skipped. At most 25 seconds: past that, 504.
// Manager and up. Read only.

export const dynamic = "force-dynamic";

/** The preview's budget: the route answers within it. */
const PREVIEW_MS = 25_000;

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const asked = req.nextUrl.searchParams.get("preview");
  if (asked !== null) {
    const tag = tagOf(asked);
    if (!tag) return NextResponse.json({ error: "preview must be a client tag" }, { status: 400 });
    try {
      const out = (await previewBackfill(getPool(), { tag, budgetMs: PREVIEW_MS })) as BackfillPreview;
      if (out.timedOut) {
        return NextResponse.json(
          { error: `The preview of ${tag} took longer than ${PREVIEW_MS / 1000} seconds, so it was stopped. Its places hold many leads: run a preview firing from the terminal instead (node scripts/backfill-worker.mjs --preview --tag ${tag}).` },
          { status: 504 }
        );
      }
      return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (notApplied(err)) return NextResponse.json({ ready: false, tag } satisfies BackfillPreview);
      console.error("sharing/backfill preview:", err);
      return NextResponse.json({ error: "Could not preview the backfill for that client" }, { status: 500 });
    }
  }
  try {
    const out = await sharingTx(getPool(), (c) => backfillView(c), { readOnly: true, timeoutMs: 15_000 });
    return NextResponse.json(out satisfies BackfillView, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (notApplied(err)) return NextResponse.json({ ready: false, switch: null, warning: null, runs: [], clients: [] } satisfies BackfillView);
    console.error("sharing/backfill:", err);
    return NextResponse.json({ error: "Could not load the database backfill" }, { status: 500 });
  }
}
