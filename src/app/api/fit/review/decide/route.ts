import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { decideItems } from "@/lib/companies/fit";
import type { ReviewDecision } from "@/lib/companies/fit-types";

// POST /api/fit/review/decide {tag, ids, decision} or {tag, bulk: "under_2_no_replies", decision}:
// approves or rejects review items (manager), recorded by name (who and when).
// In bulk: every pending item of the client scored under 2 with no reply and
// no interest. Approving queues nothing: an owner or admin queues the approved
// items for removal (review/queue), and a person runs the removal after a dry run.

export const dynamic = "force-dynamic";

const DECISIONS: ReviewDecision[] = ["approved", "rejected", "pending"];

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; ids?: unknown; bulk?: unknown; decision?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const decision = DECISIONS.includes(body.decision as ReviewDecision) ? (body.decision as ReviewDecision) : null;
  if (!decision) return NextResponse.json({ error: "decision is approved, rejected or pending" }, { status: 400 });
  const bulk = body.bulk === "under_2_no_replies" ? "under_2_no_replies" : null;
  if (body.bulk != null && !bulk) return NextResponse.json({ error: "bulk can only be under_2_no_replies" }, { status: 400 });
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!bulk && (!ids.length || ids.length > 5000 || !ids.every((x) => Number.isSafeInteger(x) && (x as number) > 0))) {
    return NextResponse.json({ error: "ids is a list of review item ids (at most 5,000)" }, { status: 400 });
  }
  if (bulk && decision === "pending") return NextResponse.json({ error: "A bulk decision approves or rejects" }, { status: 400 });
  try {
    const changed = await withTx((c) => decideItems(c, { tag, ids: ids as number[], bulk, decision, userId: auth.user.id }), {
      timeoutMs: 15_000,
    });
    if (changed) {
      await logAudit({
        action: "fit_review_decide",
        performedBy: auth.user.id,
        details: `${tag}: ${changed} item(s) ${decision}${bulk ? " (all under 2 with no replies)" : ""}`,
      });
    }
    return NextResponse.json({ changed });
  } catch (err) {
    console.error("fit/review/decide:", err);
    return NextResponse.json({ error: "Could not save the decision" }, { status: 500 });
  }
}
