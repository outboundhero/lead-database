import { NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { settingsFrom } from "../../../../../scripts/lib/enrich/settings.mjs";

// POST /api/topup/run: "Run now" on the Low places tab. Asks for a weekly
// pass at the topup-worker's next hourly firing (a "requested" pass), without
// waiting for the week to be up. Refused while the weekly top-up is switched
// off, or while a pass is already waiting or running. Admin only.

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  try {
    const out = await withTx(async (c) => {
      const { rows: [ready] } = await c.query(`SELECT to_regclass('public.topup_passes') IS NOT NULL AS ok`);
      if (!ready.ok) return { status: 409, error: "The weekly top-up is not installed yet (migration 135)." };
      const { rows: srows } = await c.query(`SELECT key, value FROM enrich_settings WHERE key = 'weekly_topup'`);
      if (!settingsFrom(srows).weekly_topup.enabled) {
        return { status: 409, error: "The weekly top-up is switched off. Switch it on in the Companies settings first." };
      }
      const { rows } = await c.query(
        `INSERT INTO topup_passes (state, trigger, requested_by) VALUES ('requested', 'button', $1)
         ON CONFLICT DO NOTHING RETURNING id, requested_at`,
        [auth.user.id]
      );
      if (!rows[0]) return { status: 409, error: "A pass is already waiting or running." };
      return { pass: rows[0] };
    });
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({ action: "topup_run_now", performedBy: auth.user.id, details: `Weekly top-up pass asked for (pass ${out.pass.id})` });
    return NextResponse.json({ pass: out.pass, note: "The pass starts at the topup-worker's next hourly firing." }, { status: 201 });
  } catch (err) {
    console.error("topup/run POST:", err);
    return NextResponse.json({ error: "Could not ask for a pass" }, { status: 500 });
  }
}
