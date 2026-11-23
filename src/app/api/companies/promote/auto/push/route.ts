import { NextRequest, NextResponse } from "next/server";
import { intakeKeyStatus } from "@/lib/enrich/auth";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { getPool } from "@/lib/db/pool";
import { pushPromoted } from "@/lib/companies/promote-push";

// POST /api/companies/promote/auto/push {tag}: the enrichment worker, once a
// client's promoted leads are ready to go into its campaigns (placed by the
// location backfill), at most once every 2 minutes per client
// (scripts/enrich-worker.mjs, scripts/lib/enrich/promote-push.mjs). Its path
// is under api/companies/promote/auto, so it is outside the session middleware
// as the promotion round is: a Bearer AIARK_AUTO_ADD_KEY is the only auth, and
// with none set (or one under 32 characters) this is off and every call is
// refused.
//
// Answers, always JSON (src/lib/companies/promote-push.ts does the work):
//   200 {tag, pushed, batch, campaigns, held, held_why, dropped, waiting, note}
//   409 {error, kept}  the push is off for the client, migration 140 is not
//                      applied, no Bison keys, or the campaign search reported
//                      an error: nothing changed, the leads stay queued
//   400 a bad body, 401 a wrong key, 503 no key set

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const key = intakeKeyStatus(req.headers.get("authorization"), process.env.AIARK_AUTO_ADD_KEY);
  if (key === "not_configured") return NextResponse.json({ error: "Automatic pushes are off: no AIARK_AUTO_ADD_KEY is set" }, { status: 503 });
  if (key === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: { tag?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await pushPromoted(getPool(), { tag });
    return NextResponse.json(out.body, { status: out.status });
  } catch (err) {
    console.error("companies/promote/auto/push:", err);
    return NextResponse.json({ error: `The push failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
