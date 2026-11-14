import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanFitSettings, fitSettingsView, readFitSettings, saveFitSettings } from "@/lib/companies/fit";

// GET /api/fit/settings: the scoring settings (admin): the fit rule and
//     its version, scoring on or off, companies a call, calls at once, the model.
// PUT /api/fit/settings {rule?, scoring?, model?}: saves the parts given.
//     The rule is the agency's own (D16): an admin pastes it here; nothing else
//     ever writes it. Its version must change whenever its text does, so every
//     score keeps the version it was made under, and a scoring run after a
//     change re-scores (after its estimate is confirmed). Read fresh by the
//     worker within 30 seconds. Every change is in the audit log.

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  try {
    const out = await withTx(async (c) => fitSettingsView(await readFitSettings(c)), { readOnly: true, timeoutMs: 8_000 });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("fit/settings GET:", err);
    return NextResponse.json({ error: "Could not read the scoring settings" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  try {
    const out = await withTx(
      async (c) => {
        // Two saves at once must not interleave: the second sees the first's values.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('fit-settings'))`);
        const s = await readFitSettings(c);
        const cleaned = cleanFitSettings(body, s);
        if (cleaned.errors.length) return { status: 400 as const, error: cleaned.errors.join(". ") };
        if (cleaned.changes.length) await saveFitSettings(c, cleaned.value);
        return { changes: cleaned.changes, settings: fitSettingsView(await readFitSettings(c)) };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    if (out.changes.length) {
      await logAudit({ action: "fit_settings", performedBy: auth.user.id, details: out.changes.join("; ") });
    }
    return NextResponse.json(out);
  } catch (err) {
    console.error("fit/settings PUT:", err);
    return NextResponse.json({ error: "Could not save the scoring settings" }, { status: 500 });
  }
}
