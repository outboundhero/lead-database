import { NextRequest, NextResponse, after } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { enrichPool, isUuid, withTx } from "@/lib/enrich/db";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { importRows, type ImportCounters } from "@/lib/uploads/import-rows";
import { addState, beginAdd, EXTRA_FIELDS, finishAdd, IMPORT_COLUMNS, STALE_HOURS } from "@/lib/aiark/server";
import type { AddState } from "@/lib/aiark/types";

// GET  /api/aiark/add?run=<id> — where a run's people stand: ready to add,
//      added, skipped, being added, not stored.
// POST /api/aiark/add {run} — adds a finished live run's "Ready to add" people
//      to the lead database (scripts/lib/aiark/add.mjs). Anyone who has since
//      become a lead, reached the Email Bison copy or the never-contact list is
//      skipped at once; the rest go through the Uploads page's import engine as
//      one upload batch (on the Uploads page like any upload): duplicates
//      skipped, never merged, the client's tag added, source AI Ark. The answer
//      comes as soon as the batch exists; the import runs after it (Next
//      `after()`, as uploads do), then each person's "Add to the database" cell
//      says what happened. A demo run's people are made up and never added.
//      Manager and up.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RUN_FIELDS = `id, client_tag, mode, table_id, finished_at IS NOT NULL AS finished`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  const runId = body.run;
  if (!isUuid(runId)) return NextResponse.json({ error: "run must be an AI Ark run id" }, { status: 400 });

  let start;
  try {
    start = await withTx(
      async (c) => {
        // One add per run at a time: a second press waits here, then finds the first under way.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('aiark-add:' || $1))`, [runId]);
        const { rows: [run] } = await c.query(`SELECT ${RUN_FIELDS} FROM aiark_runs WHERE id = $1`, [runId]);
        if (!run) return { status: 404, error: "No such AI Ark run" };
        if (run.mode !== "live") return { status: 400, error: "A demo run's people are made up, so they are never added to the database." };
        if (!run.finished) return { status: 409, error: "This pull hasn't finished yet. Add its people once it has." };
        // Batches that never got a final status (a restart) are dead, as the Uploads page treats them.
        await c.query(
          `UPDATE upload_batches SET status = 'error', error_log = $1::jsonb, completed_at = now()
            WHERE status = 'processing' AND created_at < now() - make_interval(hours => $2)`,
          [JSON.stringify([`Stalled: no final status after ${STALE_HOURS} hours (server restarted?). Rows imported before that point are kept.`]), STALE_HOURS]
        );
        const filename = `AI Ark pull · ${run.client_tag} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
        const begun = await beginAdd(c, { tableId: run.table_id, userId: auth.user.id, filename });
        if (begun.busy) return { status: 409, error: "This pull's people are being added already." };
        return { run, filename, ...begun };
      },
      { timeoutMs: 30_000 }
    );
  } catch (err) {
    console.error("aiark/add:", err);
    return NextResponse.json({ error: "Could not start adding the run's people" }, { status: 500 });
  }
  if ("error" in start) return NextResponse.json({ error: start.error }, { status: start.status });

  const { run, filename, batchId, batchAt, rows, people, skipped } = start;
  if (batchId && batchAt) {
    after(async () => {
      try {
        const counters = await importRows(getPool(), rows, {
          batchId,
          filename,
          headers: IMPORT_COLUMNS.map(([h]) => h),
          fieldMapping: Object.fromEntries(IMPORT_COLUMNS.map(([, k], i) => [i, k])),
          duplicateStrategy: "skip",
          overrideFields: [],
          addTags: [run.client_tag],
          extraFields: EXTRA_FIELDS,
          onProgress: (c) => writeProgress(batchId, c),
        });
        const nothingLanded = counters.inserted + counters.skipped === 0;
        await writeProgress(batchId, counters, counters.errors > 0 && nothingLanded ? "error" : "complete");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[aiark/add] import ${batchId} failed: ${msg}`);
        await enrichPool()
          .query(`UPDATE upload_batches SET status = 'error', error_log = $2::jsonb, completed_at = now() WHERE id = $1`, [batchId, JSON.stringify([msg])])
          .catch(() => {});
      }
      // Whatever the import did, each person's cell says so and stops reading as being added.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await finishAdd(enrichPool(), { tableId: run.table_id, batchId, batchAt, people });
          return;
        } catch (err) {
          console.error(`[aiark/add] settling ${batchId} failed: ${err instanceof Error ? err.message : err}`);
          await sleep(2_000 * attempt);
        }
      }
    });
  }
  await logAudit({
    action: "aiark_add",
    performedBy: auth.user.id,
    details: `${run.client_tag}: run ${run.id}, ${people.length} to add, ${skipped} skipped${batchId ? `, upload ${batchId}` : ""}`,
  });
  return NextResponse.json({ batchId, adding: people.length, skipped }, { status: 202 });
}

/** The batch's counters, as the Uploads page shows them. The last write (with a status) stops its polling, so it is retried. */
async function writeProgress(batchId: string, c: ImportCounters, status?: "complete" | "error") {
  for (let attempt = 1; ; attempt++) {
    try {
      await enrichPool().query(
        `UPDATE upload_batches
            SET processed_rows = $2, inserted_rows = $3, merged_rows = $4, replaced_rows = $5, skipped_rows = $6,
                no_email_rows = $7, in_file_duplicates = $8, locations_added = $9, esp_detected = $10, error_rows = $11,
                error_log = $12::jsonb, status = coalesce($13::text, status),
                completed_at = CASE WHEN $13::text IS NULL THEN completed_at ELSE now() END
          WHERE id = $1`,
        [
          batchId, c.processed, c.inserted, c.merged, c.replaced, c.skipped, c.no_email, c.in_file_duplicates,
          c.locations_added, c.esp_detected, c.errors, c.error_log.length ? JSON.stringify(c.error_log) : null, status ?? null,
        ]
      );
      return;
    } catch (err) {
      if (!status || attempt >= 3) {
        console.error(`[aiark/add] progress write failed for ${batchId}: ${err instanceof Error ? err.message : err}`);
        return;
      }
      await sleep(2_000 * attempt);
    }
  }
}
