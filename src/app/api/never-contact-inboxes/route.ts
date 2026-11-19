import { NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { neverContactStatus } from "../../../../scripts/lib/never-contact-inboxes.mjs";
import type { NeverContactView } from "./types";

// GET /api/never-contact-inboxes: the General inboxes tab. Whether the Clay
// General inboxes filter is loaded (where it was read, when, the first 12 of
// its sha256; never the filter), the switch and the pace, how many addresses
// were marked today and in all, the live apply, the newest dry run with its
// count and a sample for each part, and recent runs. Manager and up. Read only.

export const dynamic = "force-dynamic";

const NOT_READY: NeverContactView = {
  ready: false, loaded: false, source: null, readAt: null, sha12: null, parts: 0, enabled: false, on: false,
  rowsPerDay: 0, chunkRows: 0, today: 0, total: 0, live: null, latestDryRun: null, runs: [],
};

export async function GET() {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  try {
    const view = await withTx(
      async (c): Promise<NeverContactView> => {
        const { rows: [ready] } = await c.query(`SELECT to_regclass('public.never_contact_inbox_runs') IS NOT NULL AS ok`);
        if (!ready.ok) return NOT_READY;
        return { ready: true, ...(await neverContactStatus(c)) } as NeverContactView;
      },
      { readOnly: true, timeoutMs: 15_000 }
    );
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("never-contact-inboxes GET:", err);
    return NextResponse.json({ error: "Could not load the general inboxes check" }, { status: 500 });
  }
}
