import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { canonicalKey, REASON_MAX, setManualScore } from "@/lib/companies/fit";
import type { FitKeyKind } from "@/lib/companies/fit-types";

// POST /api/fit/score {key_kind, key, score, home_office?, reason?}: a person's
// score for one company (admin). Stored as 'manual': no re-score replaces it,
// and every key that leads to it (its aliases) follows it at once, so the gate
// reads it the moment it is saved. key_kind 'domain' takes a domain (any URL
// or address gives its bare domain; free-mail, platform and directory domains
// are refused, as they never stand for one company); 'name' takes
// "company|city|ST" with a state code.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: { key_kind?: unknown; key?: unknown; score?: unknown; home_office?: unknown; reason?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const kind = body.key_kind === "domain" || body.key_kind === "name" ? (body.key_kind as FitKeyKind) : null;
  if (!kind) return NextResponse.json({ error: "key_kind must be domain or name" }, { status: 400 });
  if (typeof body.key !== "string" || !body.key.trim() || body.key.length > 300) {
    return NextResponse.json({ error: "key is the company's domain, or company|city|ST" }, { status: 400 });
  }
  const score = body.score;
  if (!(typeof score === "number" && Number.isInteger(score) && score >= 1 && score <= 5)) {
    return NextResponse.json({ error: "score is a whole number from 1 to 5" }, { status: 400 });
  }
  if (body.home_office != null && typeof body.home_office !== "boolean") {
    return NextResponse.json({ error: "home_office is true, false or left out" }, { status: 400 });
  }
  if (body.reason != null && typeof body.reason !== "string") return NextResponse.json({ error: "reason is text" }, { status: 400 });
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, REASON_MAX) || null : null;
  try {
    const out = await withTx(
      async (c) => {
        const key = await canonicalKey(c, kind, body.key as string);
        if (!key) {
          return {
            status: 400 as const,
            error:
              kind === "domain"
                ? "That is not a domain that can stand for one company (free-mail, platform and directory domains never do)"
                : "A name key is company|city|ST, with the company and a state code",
          };
        }
        return setManualScore(c, { kind, key, score, homeOffice: (body.home_office as boolean | null) ?? null, reason, userId: auth.user.id });
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "fit_manual_score",
      performedBy: auth.user.id,
      details: `${out.key_kind} ${out.key}: ${out.score} of 5 by hand${out.blocked ? " (blocked by the gate's threshold)" : ""}`,
    });
    return NextResponse.json({ saved: out });
  } catch (err) {
    console.error("fit/score:", err);
    return NextResponse.json({ error: "Could not save the score" }, { status: 500 });
  }
}
