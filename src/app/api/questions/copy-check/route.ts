import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { normalizeDomain } from "@/lib/bison/keys";
import { authOf, campaignCopy, copyUses } from "@/lib/questions/bison";
import { clientOf, variableRow } from "@/lib/questions/server";
import type { CopyCheckCampaign, CopyCheckView } from "@/lib/questions/types";

// POST /api/questions/copy-check {tag, variableId, campaigns: [{instance_url,
//      id}]} (manager and up, a live read): for each campaign picked in the
//      export popup, whether its copy (every step's subject and body) uses the
//      variable ({ACME-OS QUESTION}, any case) and whether it still uses the
//      default {QUESTION}. The popup warns; nothing is refused. A campaign
//      whose copy can't be read says why in its error. At most 20 campaigns,
//      4 at a time, 20 s a request, on installs with a key only.

export const dynamic = "force-dynamic";

const MAX_CAMPAIGNS = 20;

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; variableId?: unknown; campaigns?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body?.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  if (!isUuid(body.variableId)) return NextResponse.json({ error: "variableId is not a variable id" }, { status: 400 });
  const variableId = body.variableId;
  if (!Array.isArray(body.campaigns) || body.campaigns.length === 0) {
    return NextResponse.json({ error: "campaigns is required (at least one campaign)" }, { status: 400 });
  }
  if (body.campaigns.length > MAX_CAMPAIGNS) {
    return NextResponse.json({ error: `Too many campaigns (${body.campaigns.length}). At most ${MAX_CAMPAIGNS}.` }, { status: 400 });
  }
  const campaigns: Array<{ instance_url: string; id: number }> = [];
  for (const c of body.campaigns as Array<Record<string, unknown>>) {
    const id = Number(c?.id);
    if (!c || typeof c.instance_url !== "string" || !c.instance_url.trim() || !Number.isSafeInteger(id) || id <= 0 || !/^\d+$/.test(String(c.id))) {
      return NextResponse.json({ error: "Every campaign needs its instance_url and its id" }, { status: 400 });
    }
    campaigns.push({ instance_url: c.instance_url.trim(), id });
  }

  try {
    const got = await withTx(
      async (c) => {
        if (!(await clientOf(c, tag))) return { status: 404, error: `${tag} is not a client` };
        const v = await variableRow(c, variableId);
        if (!v) return { status: 404, error: "No such variable" };
        return { name: v.name };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    if ("error" in got) return NextResponse.json({ error: got.error }, { status: got.status });

    const results: CopyCheckCampaign[] = new Array(campaigns.length);
    let next = 0;
    const lane = async () => {
      while (next < campaigns.length) {
        const i = next++;
        const { instance_url, id } = campaigns[i];
        const a = authOf(normalizeDomain(instance_url));
        if (!a.auth) {
          results[i] = { instance_url, id, usesVariable: false, usesQuestion: false, error: a.error };
          continue;
        }
        try {
          const texts = await campaignCopy(a.auth, id);
          results[i] = { instance_url, id, ...copyUses(texts, got.name), error: null };
        } catch (e) {
          results[i] = { instance_url, id, usesVariable: false, usesQuestion: false, error: e instanceof Error ? e.message : "Bison could not be read" };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, campaigns.length) }, lane));
    const out: CopyCheckView = { campaigns: results };
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("questions/copy-check POST:", err);
    return NextResponse.json({ error: "Could not read the campaigns' copy" }, { status: 500 });
  }
}
