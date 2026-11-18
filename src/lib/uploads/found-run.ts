import { after } from "next/server";
import { enrichPool, withTx } from "@/lib/enrich/db";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { importRows, type ImportCounters } from "@/lib/uploads/import-rows";
import { beginFound, finishFound } from "@/lib/uploads/found";
import { FOUND_STALE_HOURS, foundTags } from "../../../scripts/lib/enrich/upload-people.mjs";

// Adds an upload's found emails to the lead database (migration 130). The
// upload's no-email rows sit in the client's People (pipeline) table; a person
// whose Outcome is "Approved email" goes through the Uploads page's own import
// (src/lib/uploads/import-rows.ts) as one new batch (a round): the upload's
// rule for duplicates, its tags (and the client's), its replace fields, and
// the found address in the email column. So a found person becomes the lead
// the upload would have made had the row had that email. As the AI Ark add
// does (src/lib/aiark/add-run.ts): one round per upload at a time (an advisory
// lock on the upload), the answer as soon as the round's batch exists, the
// import after it (Next `after()`), then each person's "Add to the database"
// cell settled, with 3 tries.
//
// Who asks: the worker (POST /api/uploads/found/auto, `auto`), at most once an
// upload every 10 minutes, or the Uploads page's "Add the found emails now"
// (POST /api/uploads/people, manager and up), which also takes again the
// people a round could not store. Nothing here logs an address or a key.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const STALLED = `Stalled: no final status after ${FOUND_STALE_HOURS} hours (server restarted?). Rows imported before that point are kept.`;

export async function startUploadFound(
  uploadId: string,
  userId: string | null,
  { auto = false }: { auto?: boolean } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  // One spelling of the id, so every caller takes the same lock.
  const batchId = uploadId.trim().toLowerCase();
  let start;
  try {
    start = await withTx(
      async (c) => {
        // One round per upload at a time: a second press waits here, then finds the first under way.
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('upload-found:' || $1))`, [batchId]);
        const { rows: [found] } = await c.query(`SELECT 1 FROM upload_batches WHERE id = $1`, [batchId]);
        if (!found) return { status: 404, error: "No such upload" };
        // This upload's rounds that never got a final status (a restart) are dead, as the Uploads page treats them.
        await c.query(
          `UPDATE upload_batches SET status = 'error', error_log = $2::jsonb, completed_at = now()
            WHERE source_batch_id = $1 AND status = 'processing' AND created_at < now() - make_interval(hours => $3)`,
          [batchId, JSON.stringify([STALLED]), FOUND_STALE_HOURS]
        );
        const begun = await beginFound(c, { batchId, userId, retryErrors: !auto });
        if (begun.busy) return { status: 409, error: "This upload's found emails are being added already. Wait for that round to finish." };
        if (begun.notReady) return { status: 409, error: begun.notReady };
        return begun;
      },
      { timeoutMs: 30_000 }
    );
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(`[uploads/found] could not start a round for ${batchId}: ${e?.message ?? err}${e?.code ? ` (${e.code})` : ""}`);
    return { status: 500, body: { error: "Could not start adding the found emails" } };
  }
  if ("error" in start) return { status: start.status, body: { error: start.error } };

  const { batchId: round, batchAt, filename, rows, people, settled, layout, upload, clientTag, tableId } = start;
  if (round && batchAt && filename && layout && tableId) {
    after(async () => {
      try {
        const counters = await importRows(getPool(), rows, {
          batchId: round,
          filename,
          headers: layout.headers,
          fieldMapping: layout.fieldMapping,
          duplicateStrategy: upload.duplicate_strategy,
          overrideFields: upload.override_fields ?? [],
          addTags: foundTags(upload.add_tags, clientTag),
          onProgress: (c) => writeProgress(round, c),
        });
        const nothingLanded = counters.inserted + counters.merged + counters.replaced + counters.skipped === 0;
        await writeProgress(round, counters, counters.errors > 0 && nothingLanded ? "error" : "complete");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error(`[uploads/found] import ${round} failed: ${msg}`);
        await enrichPool()
          .query(`UPDATE upload_batches SET status = 'error', error_log = $2::jsonb, completed_at = now() WHERE id = $1`, [round, JSON.stringify([msg])])
          .catch(() => {});
      }
      // Whatever the import did, each person's cell says so and stops reading as being added.
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await finishFound(enrichPool(), { tableId, batchId: round, batchAt, strategy: upload.duplicate_strategy, people });
          return;
        } catch (err) {
          console.error(`[uploads/found] settling ${round} failed: ${err instanceof Error ? err.message : err}`);
          await sleep(2_000 * attempt);
        }
      }
    });
  }
  // A worker's round that found nobody to add or settle leaves no audit line.
  if (!auto || people.length + settled > 0) {
    await logAudit({
      action: "upload_found",
      performedBy: userId,
      details: `${clientTag}: upload ${batchId}${auto ? " (automatic)" : ""}, ${people.length} to add, ${settled} settled${round ? `, round ${round}` : ""}`,
    });
  }
  return { status: 202, body: { batchId: round, adding: people.length, settled } };
}

/** The round's counters, as the Uploads page shows them. The last write (with a status) stops its polling, so it is retried. */
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
        console.error(`[uploads/found] progress write failed for ${batchId}: ${err instanceof Error ? err.message : err}`);
        return;
      }
      await sleep(2_000 * attempt);
    }
  }
}
