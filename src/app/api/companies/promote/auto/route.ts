import { NextRequest, NextResponse } from "next/server";
import { intakeKeyStatus } from "@/lib/enrich/auth";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { startPromote } from "@/lib/companies/promote-run";

// POST /api/companies/promote/auto {tag}: the enrichment worker, once a client's
// approved contacts wait, at most one round per client every 10 minutes
// (scripts/enrich-worker.mjs). The same round as the button
// (src/lib/companies/promote-run.ts), and the same refusals. Outside the
// session middleware: a Bearer AIARK_AUTO_ADD_KEY is the only auth, and with
// none set (or one under 32 characters) this is off and every call is refused.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const key = intakeKeyStatus(req.headers.get("authorization"), process.env.AIARK_AUTO_ADD_KEY);
  if (key === "not_configured") return NextResponse.json({ error: "Automatic promotion is off" }, { status: 503 });
  if (key === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: { tag?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const out = await startPromote({ tag, userId: null, automatic: true });
  return NextResponse.json(out.body, { status: out.status });
}
