import { NextRequest, NextResponse } from "next/server";
import { intakeKeyStatus } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { tagOf } from "@/lib/sharing/db";
import { pushReceiverShares } from "@/lib/sharing/push";

// POST /api/sharing/push/auto {receiver, retryHeld?}: the enrich-worker's share
// push timer (overlap sharing, plan 1.8). It asks at most once every
// push_every_minutes per receiving client with queued shares, and once a day
// with retryHeld for held ones. Outside the session middleware: a Bearer
// SHARE_PUSH_KEY is the only auth, its own key so sharing never turns on AI Ark
// adds. With none set (or one under 32 characters) this is off and every call
// is refused.
//
// Answers, always JSON (src/lib/sharing/push.ts does the work):
//   200 {receiver, pushed, batches, held, dropped, left, note}
//   409 {error, kept}  sharing is switched off, or the campaign search reported
//                      an error: nothing changed, the rows stay queued
//   400 a bad body, 401 a wrong key, 503 no key set

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const key = intakeKeyStatus(req.headers.get("authorization"), process.env.SHARE_PUSH_KEY);
  if (key === "not_configured") return NextResponse.json({ error: "Share pushes are off: no SHARE_PUSH_KEY is set" }, { status: 503 });
  if (key === "unauthorized") return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
  let body: { receiver?: unknown; retryHeld?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  const receiver = tagOf(body.receiver);
  if (!receiver) return NextResponse.json({ error: "receiver must be a client tag" }, { status: 400 });
  if (body.retryHeld !== undefined && typeof body.retryHeld !== "boolean") {
    return NextResponse.json({ error: "retryHeld must be true or false" }, { status: 400 });
  }
  try {
    const out = await pushReceiverShares(getPool(), { receiver, retryHeld: body.retryHeld === true });
    return NextResponse.json(out.body, { status: out.status });
  } catch (err) {
    console.error("sharing/push/auto:", err);
    return NextResponse.json({ error: `The share push failed: ${err instanceof Error ? err.message : String(err)}` }, { status: 500 });
  }
}
