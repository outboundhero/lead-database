import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";

// POST /api/fit/review/queue {tag, ids}: queues approved review items for
// removal (owner and admin), through fn_queue_fit_removals (migration 126):
// their leads go into bison_campaign_removals as 'fit_held', which no misroute
// run reads. Left out: any lead that replied or is interested anywhere in the
// Email Bison copy, any lead also in a Nurture campaign, any company no longer
// blocked. Nothing is removed here: a person runs the removal worker's dry run
// (--reason=fit --dry-run), then the real run naming it (--confirm=<id>), which
// reads each lead live again before its DELETE and fails closed. Refused (409)
// while the gate does not cover the client (so a removed lead can't be pushed
// straight back) and when none of the items is approved.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; ids?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length || ids.length > 5000 || !ids.every((x) => Number.isSafeInteger(x) && (x as number) > 0)) {
    return NextResponse.json({ error: "ids is a list of review item ids (at most 5,000)" }, { status: 400 });
  }
  try {
    const out = await withTx(
      async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('fit-review:' || $1))`, [tag]);
        const { rows: [g] } = await c.query(`SELECT public.fn_fit_gate_applies($1) AS on`, [tag]);
        if (g?.on !== true) {
          return {
            status: 409,
            error: `The fit gate does not cover ${tag}, so nothing was queued: a lead taken out of a campaign could be pushed straight back. Put the client on the gate first.`,
          };
        }
        const { rows: [a] } = await c.query(
          `SELECT count(*)::int AS n FROM fit_review_items WHERE client_tag = $1 AND id = ANY($2::bigint[]) AND decision = 'approved'`,
          [tag, ids]
        );
        if (!a.n) return { status: 409, error: "None of these items is approved, so nothing was queued." };
        const { rows: [q] } = await c.query(`SELECT public.fn_queue_fit_removals($1, $2::bigint[]) AS n`, [tag, ids]);
        return { queued: Number(q.n), approved: a.n };
      },
      { timeoutMs: 60_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "fit_removal_queue",
      performedBy: auth.user.id,
      details: `${tag}: ${out.queued} lead(s) held for removal from ${out.approved} approved item(s); nothing removed until a dry run and a confirmed run`,
    });
    return NextResponse.json({
      ...out,
      next: {
        dry_run: `node scripts/bison-campaign-removal-worker.mjs --reason=fit --tag=${tag} --lanes=1 --dry-run`,
        real_run: `node scripts/bison-campaign-removal-worker.mjs --reason=fit --tag=${tag} --lanes=1 --confirm=<dry run id>`,
      },
    });
  } catch (err) {
    console.error("fit/review/queue:", err);
    return NextResponse.json({ error: "Could not queue the removals" }, { status: 500 });
  }
}
