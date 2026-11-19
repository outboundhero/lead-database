import { NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { notApplied, sharingTx } from "@/lib/sharing/db";
import { heldView } from "@/lib/sharing/server";
import type { HeldAnswer } from "@/lib/sharing/types";

// GET /api/sharing/held: what waits (plan 1.11): held shares by client and
// reason with their age, queued shares by client, the leads of the last 30
// days' share jobs that still have no usable place (by the place text they
// carry: fix them on the Locations page), and which Bison installs the lead
// mirror covers (a share push can only leave out leads already in a campaign
// on a mirrored install). Manager and up.

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  try {
    const out = await sharingTx(getPool(), (c) => heldView(c), { readOnly: true, timeoutMs: 20_000 });
    return NextResponse.json({ ready: true, ...out } satisfies HeldAnswer, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (notApplied(err)) {
      return NextResponse.json({ ready: false, held: [], queued: [], noPlace: [], mirror: [], heldRetryDays: 0 } satisfies HeldAnswer);
    }
    console.error("sharing/held:", err);
    return NextResponse.json({ error: "Could not load the held shares" }, { status: 500 });
  }
}
