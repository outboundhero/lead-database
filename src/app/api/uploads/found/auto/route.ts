import { NextRequest, NextResponse } from "next/server";
import { intakeKeyStatus } from "@/lib/enrich/auth";
import { isUuid } from "@/lib/enrich/db";
import { startUploadFound } from "@/lib/uploads/found-run";

// POST /api/uploads/found/auto {batch}: the enrichment worker, when an upload
// has people in its client's People table with an approved email still to
// add: they go to the lead database through the upload's own import, with no
// button (src/lib/uploads/found-run.ts). Outside the session middleware: a
// Bearer AIARK_AUTO_ADD_KEY is the only auth, and with none set (or one under
// 32 characters) this is off and every call is refused. It logs no key and no
// address.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const key = intakeKeyStatus(req.headers.get("authorization"), process.env.AIARK_AUTO_ADD_KEY);
  if (key === "not_configured") return NextResponse.json({ error: "Automatic adding is off" }, { status: 503 });
  if (key === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: { batch?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const batch = body && typeof body === "object" ? body.batch : undefined;
  if (!isUuid(batch)) return NextResponse.json({ error: "batch must be an upload's id" }, { status: 400 });
  const out = await startUploadFound(batch.toLowerCase(), null, { auto: true });
  return NextResponse.json(out.body, { status: out.status });
}
