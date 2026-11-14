import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { cleanTag, TAG_RE, workerView } from "@/lib/companies/server";
import { peopleSetup } from "@/lib/companies/people";

// GET /api/companies/people/setup?tag=ABC: what the Companies tab's people
// panel shows for a client, read free. The people runs' switch for this
// client, the tracks and their phrases (read only, from the Clay originals'
// seed), the excluded titles, the companies a run would take and those left
// out, the estimate, its newest runs, the Clay originals loaded, today's spend
// against the caps, and the steps that wait for a key. No paid call, nothing
// stored. Manager and up.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => {
        const worker = await workerState(c);
        return { ...(await peopleSetup(c, tag, worker)), worker: workerView(worker) };
      },
      { readOnly: true, timeoutMs: 10_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("companies/people/setup:", err);
    return NextResponse.json({ error: "Could not load the people runs" }, { status: 500 });
  }
}
