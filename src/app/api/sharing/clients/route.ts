import { NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { getPool } from "@/lib/db/pool";
import { notApplied, sharingTx } from "@/lib/sharing/db";
import { sharingClients } from "@/lib/sharing/server";
import type { ClientsAnswer } from "@/lib/sharing/types";

// GET /api/sharing/clients: every client with its sharing pool (or isolated),
// why it cannot receive (fn_client_receive_block, 132), whether it is on the
// sharing list and on the push list, and the shares it took in the last 7
// days. Manager and up. The settings sheet's "add every active client of one
// type" reads it too.

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  try {
    const out = await sharingTx(getPool(), (c) => sharingClients(c), { readOnly: true, timeoutMs: 15_000 });
    return NextResponse.json({ ready: true, ...out } satisfies ClientsAnswer, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (notApplied(err)) return NextResponse.json({ ready: false, clients: [], pools: {}, isolatedSuffixes: [] } satisfies ClientsAnswer);
    console.error("sharing/clients:", err);
    return NextResponse.json({ error: "Could not load the clients" }, { status: 500 });
  }
}
