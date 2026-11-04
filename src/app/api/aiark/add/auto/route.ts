import { NextRequest, NextResponse } from "next/server";
import { intakeKeyStatus } from "@/lib/enrich/auth";
import { isUuid } from "@/lib/enrich/db";
import { startAdd } from "@/lib/aiark/add-run";

// POST /api/aiark/add/auto {run} — the worker, when a pull has finished: its
// "Ready to add" people go to the lead database with no button
// (src/lib/aiark/add-run.ts). Outside the session middleware: a Bearer
// AIARK_AUTO_ADD_KEY is the only auth, and with none set (or one under 32
// characters) this is off and every call is refused.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const key = intakeKeyStatus(req.headers.get("authorization"), process.env.AIARK_AUTO_ADD_KEY);
  if (key === "not_configured") return NextResponse.json({ error: "Automatic adding is off" }, { status: 503 });
  if (key === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: { run?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!isUuid(body.run)) return NextResponse.json({ error: "run must be an AI Ark run id" }, { status: 400 });
  const out = await startAdd(body.run, null, { auto: true });
  return NextResponse.json(out.body, { status: out.status });
}
