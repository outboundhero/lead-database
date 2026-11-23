import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { hasLocationTables, locationAuditDetails, locationView, saveLocation, type LocationSaved, type LocationView } from "@/lib/clients/location-server";

// GET /api/clients/location?tag=TAG: a client's places (countries, include and
//      exclude places, as the Rules dialog edits them), whether they are locked
//      against the onboarding-sheet sync (edited by hand: when and by whom),
//      the sheet's places text (read only), and its service area: its own
//      value (client_variables "service_area"), what the pipeline uses and
//      where that comes from (serviceAreaFor: the own value, else the sheet's
//      text, else a label of the places), and a version. Manager and up.
// PUT /api/clients/location {tag, countries?, includeLocations?,
//      excludeLocations?, serviceArea?: string | null, unlock?: true, version}:
//      admin and up (as the Rules dialog). Places go through the Rules
//      dialog's checks (400 with every reason); changed places are locked, so
//      the sheet sync leaves them alone, and logged (client_targeting_log);
//      unlock hands them back to the sheet (the next sync applies it);
//      serviceArea saves the client's own value, null (or empty) removes it
//      (client_variables_log). 409 with `changed` when anything changed since
//      the page loaded it. Answers the GET shape, with what was saved.
// Migration 139 must be in the database; before it both answer 409. The audit
// log gets counts and lengths only, never a place or the text.

export const dynamic = "force-dynamic";

/** What PUT answers: the client's location as GET shows it, and what this save did. */
export type LocationSaveView = LocationView & { saved: Omit<LocationSaved, "counts"> };

const NOT_READY = "Location values need migration 139 in the database";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => {
        if (!(await hasLocationTables(c))) return { status: 409, error: NOT_READY };
        const { rows } = await c.query(`SELECT 1 FROM client_tags WHERE tag = $1`, [tag]);
        if (!rows.length) return { status: 404, error: `${tag} is not a client` };
        return { view: await locationView(c, tag) };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(out.view, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("clients/location GET:", err);
    return NextResponse.json({ error: "Could not load the client's places" }, { status: 500 });
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
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Body is not an object" }, { status: 400 });
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  if (typeof body.version !== "string") {
    return NextResponse.json({ error: "version is required: the location's version as the page loaded it" }, { status: 400 });
  }
  try {
    const out = await withTx(
      async (c) => {
        if (!(await hasLocationTables(c))) return { status: 409, error: NOT_READY };
        return saveLocation(c, { tag, body, userId: auth.user.id });
      },
      { timeoutMs: 20_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if ("errors" in out && out.errors?.length) answer.errors = out.errors;
      if ("changed" in out && out.changed) answer.changed = true;
      return NextResponse.json(answer, { status: out.status });
    }
    const details = locationAuditDetails(tag, out.saved);
    if (details) await logAudit({ action: "client_location", performedBy: auth.user.id, details });
    const answer: LocationSaveView = {
      ...out.view,
      saved: { places: out.saved.places, unlocked: out.saved.unlocked, serviceArea: out.saved.serviceArea },
    };
    return NextResponse.json(answer);
  } catch (err) {
    console.error("clients/location PUT:", err);
    return NextResponse.json({ error: "Could not save the client's places" }, { status: 500 });
  }
}
