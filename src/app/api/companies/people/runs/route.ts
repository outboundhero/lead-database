import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { logAudit } from "@/lib/api/log-audit";
import { cleanTag, companyModes, countsFor, creditsLeft, TAG_RE, workerView } from "@/lib/companies/server";
import {
  activePeopleRun,
  createPeopleRun,
  PeopleRunRefused,
  peopleRunById,
  peopleRunsFor,
  readSettingsFresh,
} from "@/lib/companies/people";
import type { RunMode } from "@/lib/aiark/types";

// GET  /api/companies/people/runs?tag=ABC: a client's 10 newest people runs,
//      with their counters and candidates by verdict, the worker, and the
//      tab's counts. The tab polls this every 5 s while a run is going.
// POST /api/companies/people/runs {tag, mode, source, maxPeople}: starts a
//      people run's Look for the client's eligible companies. In one
//      transaction it makes the client's pipeline tables ready (or brings
//      their columns up to date), the run's sources, its row and its
//      companies in batches; the enrichment worker does the looking and, after
//      a manager's Buy, the buying. Refused with a 409 while people runs are
//      off or the client is not on their list, while the worker is offline or
//      doesn't do people runs, while the client has a run going, while the
//      Clay originals or the people tracks are not loaded, without a pipeline
//      Companies table (or with a retired companies_v1 one), with AI Ark's
//      balance under the people runs' minimum, or with no eligible company.
//      Manager and up: a live run spends AI Ark credits.

export const dynamic = "force-dynamic";

const fmt = (n: number) => n.toLocaleString("en-US");
const refusal = (e: unknown): string | null => {
  if (e instanceof PeopleRunRefused) return e.message;
  const name = (e as { name?: string } | null)?.name;
  if (name === "OriginalsMissing") return "The Clay originals are not loaded, so no people run can start. Load them with scripts/enrich-seed-originals.mjs.";
  if (name === "RetiredV1Table") return (e as Error).message;
  return null;
};

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const tag = cleanTag(req.nextUrl.searchParams.get("tag"));
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  try {
    const out = await withTx(
      async (c) => ({
        runs: await peopleRunsFor(c, tag),
        worker: workerView(await workerState(c)),
        counts: await countsFor(c, tag),
      }),
      { readOnly: true, timeoutMs: 8_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("companies/people/runs GET:", err);
    return NextResponse.json({ error: "Could not load the people runs" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { tag?: unknown; mode?: unknown; source?: unknown; maxPeople?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const tag = cleanTag(body.tag);
  if (!TAG_RE.test(tag)) return NextResponse.json({ error: "tag is not a client tag" }, { status: 400 });
  const mode = body.mode === "live" || body.mode === "demo" ? (body.mode as RunMode) : null;
  if (!mode) return NextResponse.json({ error: "mode must be live or demo" }, { status: 400 });
  const source = body.source === undefined || body.source === null ? "ai_ark" : body.source;
  if (source !== "ai_ark") return NextResponse.json({ error: "source must be ai_ark" }, { status: 400 });
  const maxPeople = body.maxPeople === undefined || body.maxPeople === null ? null : Number(body.maxPeople);
  if (maxPeople !== null && (!Number.isInteger(maxPeople) || maxPeople < 1 || maxPeople > 10_000)) {
    return NextResponse.json({ error: "maxPeople must be a whole number from 1 to 10,000" }, { status: 400 });
  }
  const ready = companyModes()[mode];
  if (!ready.ready) return NextResponse.json({ error: ready.why, needsKey: mode === "live" }, { status: 409 });

  try {
    // The checks that need no transaction come first, so a refused run writes nothing.
    const pre = await withTx(
      async (c) => {
        const settings = await readSettingsFresh(c);
        const pp = settings.people_pipeline;
        if (!pp.enabled) return { status: 409, error: "People runs are off, so nothing was started. An admin can switch them on in the settings." };
        if (!settings.flagOn("people_pipeline", tag)) {
          return { status: 409, error: `${tag} is not on the people runs' client list, so nothing was started. An admin can add it in the settings.` };
        }
        if (maxPeople !== null && maxPeople > pp.max_people_per_run) {
          return { status: 400, error: `A people run buys at most ${fmt(pp.max_people_per_run)} people for now (the settings' most people a run).` };
        }
        if (!settings.people_tracks) {
          return { status: 409, error: "The people tracks are not loaded (the Clay originals' seed writes them), so nothing was started." };
        }
        const worker = workerView(await workerState(c));
        if (!worker?.online) return { status: 409, error: "People runs can't start yet: the service that runs them is off, so nothing was started." };
        if (!worker.peopleRuns) {
          return { status: 409, error: "The worker that is running doesn't do people runs yet, so nothing was started. Deploy the latest worker first." };
        }
        const going = await activePeopleRun(c, tag);
        if (going) return { status: 409, error: `${tag} already has a people run going (${going.status}). Cancel it or let it finish first.` };
        const { rows: [table] } = await c.query<{ template: string }>(
          `SELECT template FROM enrich_tables WHERE client_tag = $1 AND kind = 'companies' AND template IS NOT NULL
            ORDER BY template = 'companies_v2' DESC LIMIT 1`,
          [tag]
        );
        if (!table) return { status: 409, error: `${tag} has no pipeline Companies table yet: pull companies first, then look for their people.` };
        if (table.template !== "companies_v2") {
          return { status: 409, error: `${tag}'s Companies table is ${table.template}, not the pipeline's companies_v2: its people can't be looked for until an admin decides what happens to it.` };
        }
        return { minBalance: pp.min_balance };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    if ("error" in pre) return NextResponse.json({ error: pre.error }, { status: pre.status });

    // AI Ark's balance, read free (at most 5 s): a run never starts under the people runs' minimum.
    const left = await creditsLeft(mode);
    if (left.credits === null) {
      return NextResponse.json({ error: `AI Ark's balance could not be read (${left.error ?? "no answer"}), so nothing was started.` }, { status: 409 });
    }
    if (left.credits < pre.minBalance) {
      return NextResponse.json(
        { error: `AI Ark has ${fmt(left.credits)} credits, under the people runs' minimum of ${fmt(pre.minBalance)}, so nothing was started.` },
        { status: 409 }
      );
    }

    const run = await withTx(
      async (c) => {
        // Two clicks at once must not start two runs for the client (createPeopleRun takes the same lock).
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('aiark-people-run:' || $1))`, [tag]);
        const settings = await readSettingsFresh(c);
        const r = await createPeopleRun(c, { tag, mode, source: "ai_ark", maxPeople, createdBy: auth.user.id, settings });
        return peopleRunById(c, r.id);
      },
      { timeoutMs: 30_000 }
    );
    await logAudit({
      action: "companies_people_run",
      performedBy: auth.user.id,
      details: `${tag}: ${mode} people run queued for ${run?.companies ?? "?"} companies, at most ${run?.max_people ?? "?"} people (run ${run?.id})`,
    });
    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    const why = refusal(err);
    if (why) return NextResponse.json({ error: why }, { status: 409 });
    console.error("companies/people/runs POST:", err);
    return NextResponse.json({ error: "Could not start the people run" }, { status: 500 });
  }
}
