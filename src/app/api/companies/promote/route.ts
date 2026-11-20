import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { startPromote } from "@/lib/companies/promote-run";
import type { PromoteKind } from "@/lib/companies/fit-types";

// POST /api/companies/promote {tag, kind?}: "Promote now" on the Companies tab.
// One round of the client's approved pipeline emails into leads
// (src/lib/companies/promote-run.ts): general inboxes, people, or both when no
// kind is given. Manager and up. Refused (409) while promotion is off or the
// client is not on its list (both set on the settings sheet), and while a
// round is running. No fit score is needed (fit scoring is kept for v2).

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; kind?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  if (body.kind != null && body.kind !== "general" && body.kind !== "person") {
    return NextResponse.json({ error: "kind must be general or person (or left out for both)" }, { status: 400 });
  }
  const out = await startPromote({ tag, kind: (body.kind as PromoteKind | null) ?? null, userId: auth.user.id });
  return NextResponse.json(out.body, { status: out.status });
}
