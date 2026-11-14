import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import { logAudit } from "@/lib/api/log-audit";
import { workerView } from "@/lib/companies/server";
import { approveBuy, peopleRunById, readSettingsFresh } from "@/lib/companies/people";

// POST /api/companies/people/runs/buy {id}: a manager's click on Buy. A people
// run whose Look is done stops in "looked" (people_pipeline.auto_buy is off);
// this queues it again to buy its picks, one Export Single each (1 credit with
// an email, none without, by AI Ark's docs). Refused with a 409 unless the
// run is waiting for it, while people runs are off for its client, or while
// the worker can't do people runs. Recorded with who clicked. Manager and up.

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!isUuid(body.id)) return NextResponse.json({ error: "id must be a people run id" }, { status: 400 });
  const id = body.id;
  try {
    const out = await withTx(async (c) => {
      const { rows: [run] } = await c.query<{ client_tag: string; status: string }>(
        `SELECT client_tag, status FROM aiark_people_runs WHERE id = $1 FOR UPDATE`,
        [id]
      );
      if (!run) return { status: 404, error: "No such people run" };
      if (run.status !== "looked") return { status: 409, error: "That people run is not waiting for Buy" };
      const settings = await readSettingsFresh(c);
      if (!settings.flagOn("people_pipeline", run.client_tag)) {
        return { status: 409, error: `People runs are off for ${run.client_tag}, so nothing is bought. An admin can switch them on in the settings.` };
      }
      const worker = workerView(await workerState(c));
      if (!worker?.online || !worker.peopleRuns) {
        return { status: 409, error: "The worker that buys people is off or older than people runs, so nothing is bought yet." };
      }
      const approved = await approveBuy(c, { runId: id, userId: auth.user.id });
      if (!approved) return { status: 409, error: "That people run is not waiting for Buy" };
      return { run: await peopleRunById(c, id), approved };
    });
    if ("error" in out) return NextResponse.json({ error: out.error }, { status: out.status });
    await logAudit({
      action: "companies_people_buy",
      performedBy: auth.user.id,
      details: `${out.approved.client_tag}: Buy approved for people run ${id} (${out.approved.picked} picked, at most ${out.approved.max_people} people)`,
    });
    return NextResponse.json({ run: out.run });
  } catch (err) {
    console.error("companies/people/runs/buy:", err);
    return NextResponse.json({ error: "Could not approve the Buy" }, { status: 500 });
  }
}
