import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { fitState, readFitSettings } from "@/lib/companies/fit";

// GET /api/fit/state?tag=ABC: what the fit panel shows. The rule (set or
// waiting, and its version, never its text), the model, scoring on or off,
// why the scorer is idle, the queue by priority, the worker's fit loop and
// its last error, "Refresh pending", today's fit spend against its cap, the
// gate (and whether it covers the client), the scores held, and promotion's
// switch with the client's promotable emails. Manager and up. Read only.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const raw = req.nextUrl.searchParams.get("tag");
  const tag = raw ? cleanTag(raw) : null;
  if (tag !== null && !TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => fitState(c, await readFitSettings(c), tag, await workerState(c)),
      { readOnly: true, timeoutMs: 15_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("fit/state:", err);
    return NextResponse.json({ error: "Could not read the fit scoring state" }, { status: 500 });
  }
}
