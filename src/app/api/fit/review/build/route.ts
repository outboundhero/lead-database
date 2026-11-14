import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { enrichPool, withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, TAG_RE } from "@/lib/aiark/server";
import { readFitSettings } from "@/lib/companies/fit";
import {
  createReviewRun,
  liveCampaignsFor,
  reviewCampaignsFor,
  runGoing,
} from "../../../../../../scripts/lib/enrich/fit-backfill.mjs";

// POST /api/fit/review/build {tag}: builds one client's review list (manager).
// The client's campaigns come from its push history and from its live campaign
// names on each install ("TAG:" or "TAG "), both by default (D41), read free
// from Bison as the campaign pickers do; only campaigns that can still send are
// kept, never a Nurture campaign. The worker's fit loop then reads their
// members in the Email Bison copy and lists the blocked companies, per campaign
// (scripts/lib/enrich/fit-backfill.mjs). Decisions already made stay. Refused
// (409) while scoring is off, while a build for the client is going, and while
// the worker running is not one that scores.

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const refusal = (status: number, error: string) => ({ status, error });
  const check = async (c: Parameters<Parameters<typeof withTx>[0]>[0]) => {
    const s = await readFitSettings(c);
    if (!s.fit_scoring.enabled) return refusal(409, "Scoring is off, so no review list was built.");
    if (await runGoing(c, "review", tag)) return refusal(409, `${tag}'s review list is being built already.`);
    const w = await workerState(c);
    const caps = Array.isArray(w?.info?.capabilities) ? w.info.capabilities : [];
    if (!w?.online || !caps.includes("fit_scoring")) {
      return refusal(409, "The worker that builds review lists is not running (or is older than fit scoring), so nothing was started.");
    }
    const { rows } = await c.query(`SELECT 1 FROM client_tags WHERE tag = $1`, [tag]);
    if (!rows.length) return refusal(404, `${tag} is not a client`);
    return null;
  };
  try {
    const first = await withTx(check, { readOnly: true, timeoutMs: 8_000 });
    if (first) return NextResponse.json({ error: first.error }, { status: first.status });
    // Bison is read outside any transaction: a slow install must not hold a connection open.
    const live = await liveCampaignsFor(tag, process.env, fetch);
    const { campaigns, errors } = await reviewCampaignsFor(enrichPool(), tag, live);
    if (!campaigns.length) {
      return NextResponse.json(
        { error: `No campaign of ${tag} that can still send was found (push history and live names)${errors.length ? `: ${errors.join("; ")}` : ""}.` },
        { status: 409 }
      );
    }
    const out = await withTx(
      async (c) => {
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('fit-review:' || $1))`, [tag]);
        const again = await check(c);
        if (again) return again;
        const run = await createReviewRun(c, { tag, userId: auth.user.id, campaigns, nurture: live.nurture, errors });
        return { run: { id: run.id, status: run.status } };
      },
      { timeoutMs: 10_000 }
    );
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "fit_review_build",
      performedBy: auth.user.id,
      details: `${tag}: review list build ${out.run.id} over ${campaigns.length} campaign(s)${errors.length ? `; ${errors.length} could not be read` : ""}`,
    });
    return NextResponse.json({ ...out, campaigns: campaigns.length, errors }, { status: 201 });
  } catch (err) {
    console.error("fit/review/build:", err);
    return NextResponse.json({ error: "Could not start the review list" }, { status: 500 });
  }
}
