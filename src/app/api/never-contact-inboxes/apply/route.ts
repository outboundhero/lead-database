import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { startApply } from "../../../../../scripts/lib/never-contact-inboxes.mjs";

// POST /api/never-contact-inboxes/apply {dryRunId}: marks never contact the
// general inboxes a dry run counted, once the owner has approved that count.
// The dry run must be of the filter loaded now and at most 24 hours old, the
// switch on, and no other apply going. This only records the apply: the
// topup-worker does the work at its hourly firings, at most rows_per_day
// addresses a day, through fn_suppress_general_inboxes() (each address goes
// on the never-contact list, its leads are flagged, and Bison is asked to
// unsubscribe it on every install, which cannot be undone in Bison). Once the
// backlog is done it keeps marking newly imported general inboxes while the
// switch is on. Admin only, audited.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: { dryRunId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!isUuid(body?.dryRunId)) return NextResponse.json({ error: "dryRunId must be a dry run's id" }, { status: 400 });
  const dryRunId = body.dryRunId;
  try {
    const out = await withTx(async (c) => {
      const { rows: [ready] } = await c.query(`SELECT to_regclass('public.never_contact_inbox_runs') IS NOT NULL AS ok`);
      if (!ready.ok) return { status: 409, error: "Never-contact inboxes are not installed yet (migration 136)." };
      return startApply(c, { dryRunId, by: auth.user.id });
    });
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "never_contact_inboxes_apply",
      performedBy: auth.user.id,
      details: `General inboxes on the Clay filter: apply ${out.run.id} started on dry run ${dryRunId} (${out.run.counted} counted)`,
    });
    return NextResponse.json({ run: out.run }, { status: 201 });
  } catch (err) {
    console.error("never-contact-inboxes/apply POST:", err);
    return NextResponse.json({ error: "Could not start the apply" }, { status: 500 });
  }
}
