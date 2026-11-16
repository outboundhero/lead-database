import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanSettingsInput, readPipelineSettings, storedSettings } from "@/lib/companies/server";
import type { SettingsState } from "@/lib/companies/types";

// GET /api/companies/settings: the pipeline's settings as the worker reads them
//     (enrich_settings: company pulls, people runs, personalisation, the spend
//     caps, the model of each original AI step and the LinkedIn searches), with
//     their version.
// PUT /api/companies/settings {version, company_pipeline, people_pipeline,
//     personalisation, spend_caps, models, linkedin_sources?}: saves the
//     settings sheet's edits. linkedin_sources (the switch, its client list and
//     the people a LinkedIn run buys at one company, 1 to 100) is optional:
//     left out, what is stored is kept.
//     Every switch keeps its client list (tags, upper case; an empty list
//     covers no client). Numbers must be whole and in range, model ids match
//     ^[a-z0-9][a-z0-9.\-]{1,60}$, a reasoning effort is none, minimal, low,
//     medium, high, xhigh or max (or not sent; a Luna model refuses minimal),
//     and a web step's most searches is 1 to 5: anything else is refused
//     (400), never quietly replaced. Keys the sheet doesn't edit are kept
//     (memory_days, openai_prices, fit_score, anything a later phase adds). A
//     version other than the stored one answers 409 with `changed`. The worker
//     reads the settings every 30 s, so a change reaches it within that, with
//     no deploy. Admin and up.

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  try {
    const out = await withTx<SettingsState>((c) => readPipelineSettings(c), { readOnly: true, timeoutMs: 8_000 });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("companies/settings GET:", err);
    return NextResponse.json({ error: "Could not load the settings" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!body || typeof body.version !== "string") return NextResponse.json({ error: "version is required" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => {
        const current = await readPipelineSettings(c, { lock: true });
        if (current.version !== body.version) {
          return { status: 409, error: "The settings changed since this sheet loaded them, so nothing was saved. It now shows them as they are.", changed: true };
        }
        const { value, errors, changes } = cleanSettingsInput(body, current.value, await storedSettings(c));
        if (!value) return { status: 400, error: errors.join(" "), errors };
        if (!changes.length) return { saved: current, changes };
        for (const [key, v] of Object.entries(value)) {
          await c.query(
            `INSERT INTO enrich_settings (key, value, updated_by) VALUES ($1, $2, $3)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [key, JSON.stringify(v), auth.user.id]
          );
        }
        return { saved: await readPipelineSettings(c), changes };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) {
      return NextResponse.json({ error: out.error, changed: "changed" in out, errors: "errors" in out ? out.errors : undefined }, { status: out.status });
    }
    if (out.changes.length) {
      await logAudit({ action: "enrich_settings", performedBy: auth.user.id, details: `Pipeline settings: ${out.changes.join("; ")}` });
    }
    return NextResponse.json({ ...out.saved, changes: out.changes });
  } catch (err) {
    console.error("companies/settings PUT:", err);
    return NextResponse.json({ error: "Could not save the settings" }, { status: 500 });
  }
}
