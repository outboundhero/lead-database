import { NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { stopApply } from "../../../../../scripts/lib/never-contact-inboxes.mjs";

// POST /api/never-contact-inboxes/stop: stops the apply that is going (its
// backlog or its following of new imports). Addresses already marked stay on
// the never-contact list. Admin only, audited.

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  try {
    const run = await withTx(async (c) => {
      const { rows: [ready] } = await c.query(`SELECT to_regclass('public.never_contact_inbox_runs') IS NOT NULL AS ok`);
      return ready.ok ? stopApply(c) : null;
    });
    if (!run) return NextResponse.json({ error: "No apply is going." }, { status: 409 });
    await logAudit({
      action: "never_contact_inboxes_stop",
      performedBy: auth.user.id,
      details: `General inboxes on the Clay filter: apply ${run.id} stopped after ${run.suppressed} marked`,
    });
    return NextResponse.json({ run });
  } catch (err) {
    console.error("never-contact-inboxes/stop POST:", err);
    return NextResponse.json({ error: "Could not stop the apply" }, { status: 500 });
  }
}
