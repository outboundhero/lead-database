import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { reviewPage } from "@/lib/companies/fit";

// GET /api/fit/review?tag=ABC&campaign=<install>|<id>&after=<item id>: one
// client's review list of bad fits already in its campaigns, a page at a time
// (keyset by item id), with the list's totals, its campaigns, the last build,
// whether the gate covers the client, the fit removals queued and the last
// dry runs. Manager and up. Read only. The counts come from the Email Bison
// copy, which is stale for most rows: each item shows its oldest sync date,
// and removal reads every lead live before it acts.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const tag = cleanTag(sp.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const after = Number(sp.get("after") ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) return NextResponse.json({ error: "after is an item id" }, { status: 400 });
  let campaign: { instance_url: string; campaign_id: string } | null = null;
  const raw = sp.get("campaign");
  if (raw) {
    const at = raw.lastIndexOf("|");
    const inst = raw.slice(0, at);
    const id = raw.slice(at + 1);
    if (at <= 0 || !/^\d+$/.test(id)) return NextResponse.json({ error: "campaign is <install>|<campaign id>" }, { status: 400 });
    campaign = { instance_url: inst, campaign_id: id };
  }
  try {
    const out = await withTx(async (c) => reviewPage(c, { tag, campaign, after }), { readOnly: true, timeoutMs: 15_000 });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("fit/review:", err);
    return NextResponse.json({ error: "Could not load the review list" }, { status: 500 });
  }
}
