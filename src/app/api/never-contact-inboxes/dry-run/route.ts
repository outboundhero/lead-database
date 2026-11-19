import { NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { dryRun } from "../../../../../scripts/lib/never-contact-inboxes.mjs";

// POST /api/never-contact-inboxes/dry-run: counts the general inboxes the
// loaded Clay General inboxes filter matches that are not on the never-contact
// list yet, with a sample for each part of the filter, and stores the count as
// a dry run an admin can apply once the owner has approved it. Writes nothing
// to leads or the list. Admin only.

export const dynamic = "force-dynamic";
export const maxDuration = 150;

export async function POST() {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  try {
    const out = await withTx(
      async (c) => {
        const { rows: [ready] } = await c.query(`SELECT to_regclass('public.never_contact_inbox_runs') IS NOT NULL AS ok`);
        if (!ready.ok) return { status: 409, error: "Never-contact inboxes are not installed yet (migration 136)." };
        return dryRun(c, { by: auth.user.id });
      },
      { timeoutMs: 120_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "never_contact_inboxes_dry_run",
      performedBy: auth.user.id,
      details: `General inboxes on the Clay filter: ${out.run.counted} not on the never-contact list yet (dry run ${out.run.id})`,
    });
    return NextResponse.json({ run: out.run }, { status: 201 });
  } catch (err) {
    console.error("never-contact-inboxes/dry-run POST:", err);
    return NextResponse.json({ error: "The dry run did not finish" }, { status: 500 });
  }
}
