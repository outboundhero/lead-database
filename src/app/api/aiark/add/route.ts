import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { addState } from "@/lib/aiark/server";
import { startAdd } from "@/lib/aiark/add-run";
import type { AddState } from "@/lib/aiark/types";

// GET  /api/aiark/add?run=<id> — where a run's people stand: ready to add,
//      added, skipped, being added, not stored, waiting in the pipeline.
// POST /api/aiark/add {run} — the button: adds a finished live run's "Ready to
//      add" people to the lead database (src/lib/aiark/add-run.ts). Manager and up.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RUN_FIELDS = `id, client_tag, mode, table_id, finished_at IS NOT NULL AS finished`;

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const id = req.nextUrl.searchParams.get("run");
  if (!isUuid(id)) return NextResponse.json({ error: "run must be an AI Ark run id" }, { status: 400 });
  try {
    const out = await withTx<AddState | null>(
      async (c) => {
        const { rows: [run] } = await c.query(`SELECT ${RUN_FIELDS} FROM aiark_runs WHERE id = $1`, [id]);
        if (!run) return null;
        return { run: { id: run.id, mode: run.mode, finished: run.finished }, ...(await addState(c, run.table_id)) };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    if (!out) return NextResponse.json({ error: "No such AI Ark run" }, { status: 404 });
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("aiark/add:", err);
    return NextResponse.json({ error: "Could not read where the run's people stand" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { run?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!isUuid(body.run)) return NextResponse.json({ error: "run must be an AI Ark run id" }, { status: 400 });
  const out = await startAdd(body.run, auth.user.id);
  return NextResponse.json(out.body, { status: out.status });
}
