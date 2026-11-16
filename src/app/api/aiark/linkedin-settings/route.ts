import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, clientInfo, geo, TAG_RE } from "@/lib/aiark/server";
import { previewView, readSettingsNow, settingsView, switchView } from "@/lib/linkedin/server";
import { LINKEDIN_KINDS, type LinkedinKind, type LinkedinSettingsResponse, type LinkedinSettingsSaved } from "@/lib/linkedin/types";
import { saveLinkedinSettings } from "../../../../../scripts/lib/aiark/linkedin-settings.mjs";

// GET  /api/aiark/linkedin-settings?tag=ABC[&kind=people|companies]: a
//      client's LinkedIn settings for its people search and its company search
//      (both kinds when kind is left out), as the AI Ark tab's LinkedIn card
//      shows them: its own places and excluded keywords (client_linkedin_settings,
//      or for a client with no row its rules' places and the starter keywords),
//      the standard filters every client shares, the keywords AI Ark is sent and
//      those checked after the pull, its places outside its sending rules (not
//      searched), what a search would send, where the lists came from, the log
//      and the LinkedIn switch for the client. Works with the switch off.
// POST /api/aiark/linkedin-settings {tag, kind, value}: the same plan for lists
//      not saved yet (the card's preview while editing), with each reason a save
//      would refuse. Nothing is written.
// PUT  /api/aiark/linkedin-settings {tag, kind, value, version}: saves one
//      kind's lists (saveLinkedinSettings): 409 with `changed` when they changed
//      since the page loaded them, 400 with every reason, 404 for a tag that is
//      no client. A client's first save makes its own row from what was shown.
//      Every save is logged with the lists before and after
//      (client_linkedin_settings_log, server-only); the audit log gets counts only.
// No AI Ark call anywhere here. Manager and up, like the people filters.

export const dynamic = "force-dynamic";

const kindOf = (v: unknown): LinkedinKind | null => (LINKEDIN_KINDS.includes(v as LinkedinKind) ? (v as LinkedinKind) : null);

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const tag = cleanTag(sp.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const rawKind = sp.get("kind");
  const kind = rawKind ? kindOf(rawKind) : null;
  if (rawKind && !kind) return NextResponse.json({ error: "kind must be people or companies" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => {
        const client = await clientInfo(c, tag);
        if (!client) return { status: 404, error: `${tag} is not a client` };
        const g = await geo(c);
        const settings = await readSettingsNow(c);
        const body: LinkedinSettingsResponse = {
          client: { tag: client.tag, name: client.name ?? null, clientType: client.client_type ?? null, status: client.status ?? null },
          switch: switchView(settings, tag),
        };
        for (const k of kind ? [kind] : LINKEDIN_KINDS) body[k] = await settingsView(c, { tag, kind: k, g });
        return { body };
      },
      { readOnly: true, timeoutMs: 10_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(out.body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("aiark/linkedin-settings GET:", err);
    return NextResponse.json({ error: "Could not load the LinkedIn settings" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; kind?: unknown; value?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body?.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const kind = kindOf(body.kind);
  if (!kind) return NextResponse.json({ error: "kind must be people or companies" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => {
        if (!(await clientInfo(c, tag))) return { status: 404, error: `${tag} is not a client` };
        return { preview: await previewView(c, { tag, kind, value: body.value, g: await geo(c) }) };
      },
      { readOnly: true, timeoutMs: 10_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    return NextResponse.json(out.preview, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("aiark/linkedin-settings POST:", err);
    return NextResponse.json({ error: "Could not work out the LinkedIn search" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; kind?: unknown; value?: unknown; version?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body?.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const kind = kindOf(body.kind);
  if (!kind) return NextResponse.json({ error: "kind must be people or companies" }, { status: 400 });
  if (typeof body.version !== "string") return NextResponse.json({ error: "version is required: the settings' version as the page loaded them" }, { status: 400 });
  const version = body.version;

  try {
    const out = await withTx(
      async (c) => {
        const g = await geo(c);
        const r = await saveLinkedinSettings(c, { tag, kind, input: body.value, version, userId: auth.user.id, geo: g });
        if ("error" in r) return { status: r.status, error: r.error, errors: r.errors, changed: r.changed === true };
        const view = await settingsView(c, { tag, kind, g });
        const saved: LinkedinSettingsSaved = { saved: r.saved, unchanged: r.unchanged, view };
        return { saved };
      },
      { timeoutMs: 20_000 }
    );
    if ("error" in out) {
      const answer: Record<string, unknown> = { error: out.error };
      if (out.errors?.length) answer.errors = out.errors;
      if (out.changed) answer.changed = true;
      return NextResponse.json(answer, { status: out.status });
    }
    if (out.saved.saved) {
      const own = out.saved.view.own;
      await logAudit({
        action: "linkedin_settings",
        performedBy: auth.user.id,
        details: `${tag} ${kind}: ${own.include_locations.length} places, ${own.exclude_locations.length} left out, ${own.unplaced.length} unplaced, ${own.exclude_keywords.length} keywords`,
      });
    }
    return NextResponse.json(out.saved);
  } catch (err) {
    console.error("aiark/linkedin-settings PUT:", err);
    return NextResponse.json({ error: "Could not save the LinkedIn settings" }, { status: 500 });
  }
}
