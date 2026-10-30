import { NextResponse } from "next/server";

// POST /api/aiark/webhook — the address AI Ark requires on every Export
// People with Email job (it must be public HTTPS; set AIARK_WEBHOOK_URL to
// this route). The worker reads export results by polling, so the body —
// every exported person and email — is never read, stored or logged here,
// and nothing is sent anywhere else. AI Ark documents no signature for this
// call, which is another reason not to trust it. Outside the session
// middleware: AI Ark has no session.

export const dynamic = "force-dynamic";

export async function POST() {
  return new NextResponse(null, { status: 204 });
}
