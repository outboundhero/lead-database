import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { FilterState } from "@/types/filters";
import type { Lead } from "@/types/database";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { findCursorForRangeStart } from "@/lib/exports/skip-cursor";
import { getPool } from "@/lib/db/pool";
import { validateLeads, isValidationEnabled } from "@/lib/validation/validate-leads";
import { getTtlDays } from "@/lib/validation/cache-policy";

// Kept for the auth/markJobError path. The actual export RPC calls go through
// the direct pg pool below to bypass the Supabase HTTP gateway (~60s timeout).
const supabaseAdmin = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);


function escapeCsv(val: unknown): string {
  if (val === null || val === undefined) return "";
  const str = Array.isArray(val) ? val.join("; ") : String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export const maxDuration = 600; // 10 min max for streaming

export async function POST(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json();
  const { filters, columnSelection, limit, rangeFrom, rangeTo, jobId } = body as {
    filters: FilterState;
    columnSelection: string[];
    limit?: number;
    rangeFrom?: number;
    rangeTo?: number;
    jobId?: string;
  };

  if (!filters || !columnSelection?.length) {
    return new Response("Missing required fields", { status: 400 });
  }

  // maxRows is the max number of rows to emit:
  //   - If rangeFrom + rangeTo set: emit (rangeTo - rangeFrom + 1) rows starting at rangeFrom
  //   - Else if limit set: emit `limit` rows from beginning
  //   - Else: capped at HARD_ROW_CAP (was unbounded, but unbounded exports
  //     against the unfiltered table reliably zombie at maxDuration since
  //     19M rows × ~10K rows/sec ≈ 32 min > 10 min cap. Beyond this the
  //     user should chunk via rangeFrom/rangeTo).
  const HARD_ROW_CAP = 10_000_000;
  const requestedMax = rangeFrom && rangeTo
    ? rangeTo - rangeFrom + 1
    : limit && limit > 0
      ? limit
      : HARD_ROW_CAP;
  if (requestedMax > HARD_ROW_CAP) {
    return new Response(
      `Export too large (${requestedMax.toLocaleString()} rows). ` +
      `Maximum is ${HARD_ROW_CAP.toLocaleString()} per export. ` +
      `Use rangeFrom/rangeTo to split into smaller chunks.`,
      { status: 400 }
    );
  }
  const maxRows = requestedMax;
  const p_filters = buildRpcFilters(filters);
  // Larger batches = fewer round-trips to PG and fewer per-batch overhead.
  // 75K rows × ~20 cols × ~50 chars ≈ 75MB per batch in Node memory, well
  // within Railway's 8GB. Tested: 25K → 75K cuts ~30% off total export time.
  const batchSize = 75000;
  const encoder = new TextEncoder();

  async function markJobError(reason: string) {
    if (!jobId) return;
    try {
      const adminDb = createAdminClient();
      // Fetch existing meta so we don't clobber rangeFrom/rangeTo etc.
      const { data: existing } = await adminDb
        .from("export_jobs")
        .select("filters_used")
        .eq("id", jobId)
        .single();
      const existingFilters = (existing?.filters_used ?? {}) as Record<string, unknown>;
      const existingMeta = (existingFilters._meta ?? {}) as Record<string, unknown>;
      await adminDb.from("export_jobs").update({
        status: "error",
        completed_at: new Date().toISOString(),
        filters_used: {
          ...existingFilters,
          _meta: { ...existingMeta, error: reason.slice(0, 500) },
        } as unknown as Record<string, unknown>,
      }).eq("id", jobId);
      console.error(`Export ${jobId} marked as error: ${reason}`);
    } catch (e) {
      console.error("Failed to mark export job as error:", e);
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let errored = false;
      let aborted = false;
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed by client */ }
      };
      // Aborts the stream so the browser/fetch consumer sees a failed download
      // instead of a silently-truncated CSV that looks complete.
      const safeError = (msg: string) => {
        if (closed) return;
        closed = true;
        errored = true;
        try { controller.error(new Error(msg)); } catch { /* already closed */ }
      };
      const safeEnqueue = (chunk: Uint8Array) => {
        if (closed) return;
        try { controller.enqueue(chunk); } catch {
          // enqueue throws when the consumer (browser) has gone away. Mark
          // aborted (not errored) so the post-loop block records the job as
          // 'cancelled' instead of overwriting it as 'complete' with the
          // partial row count the user actually received.
          closed = true;
          aborted = true;
        }
      };

      // Detect browser disconnect via the request signal — fires earlier and
      // more reliably than waiting for enqueue to throw. Without this, the
      // server keeps fetching batches for up to 600s after the user closed
      // the tab, wasting CPU and a pool client.
      request.signal.addEventListener("abort", () => {
        aborted = true;
        closed = true;
      });

      try {
        // ─── Pre-export validation pass ─────────────────────────────────
        // For every lead matching the user's filters that hasn't been validated in
        // the last VALIDATION_REVALIDATE_DAYS (default 45), run Reoon → FindEmail
        // and write the result back. fn_export_leads then naturally excludes
        // anything still invalid via its hard validation_status gate.
        if (isValidationEnabled() && jobId) {
          try {
            const adminDb = createAdminClient();
            const ttl = getTtlDays();
            const cutoff = new Date(Date.now() - ttl * 24 * 60 * 60 * 1000).toISOString();
            const pool = getPool();
            const preScan = await pool.query(
              `SELECT l.id, l.email
               FROM leads l
               WHERE (l.validation_status IS NULL OR l.validated_at < $1::timestamptz)
                 AND l.is_bounced = false
               LIMIT 200000`,
              [cutoff],
            );
            const candidates = preScan.rows as { id: string; email: string }[];
            if (candidates.length > 0) {
              // Create the validation_jobs row so the UI can poll progress.
              const { data: vjob } = await adminDb
                .from("validation_jobs")
                .insert({
                  export_job_id: jobId,
                  total: candidates.length,
                  status: "running",
                  started_at: new Date().toISOString(),
                })
                .select("id")
                .single();
              const vjobId = vjob?.id as string | undefined;

              const outcome = await validateLeads(candidates, {
                signal: request.signal,
                onProgress: async (done, creditsUsed) => {
                  if (!vjobId) return;
                  await adminDb
                    .from("validation_jobs")
                    .update({ completed: done, credits_used: creditsUsed })
                    .eq("id", vjobId);
                },
              });
              if (vjobId) {
                await adminDb
                  .from("validation_jobs")
                  .update({
                    status: outcome.errors > 0 && outcome.errors === outcome.total ? "error" : "complete",
                    completed: outcome.validated,
                    credits_used: outcome.creditsUsed,
                    completed_at: new Date().toISOString(),
                  })
                  .eq("id", vjobId);
              }
            }
          } catch (vErr) {
            // Don't fail the whole export if validation breaks — log and proceed.
            // The export RPC's hard gate will still filter out anything that
            // remained NULL, so the user will get fewer rows but not bad data.
            console.error("Pre-export validation pass failed:", vErr);
          }
        }
        // ────────────────────────────────────────────────────────────────

        // CSV header
        safeEnqueue(encoder.encode(columnSelection.join(",") + "\n"));

        let totalRows = 0;
        let hasMore = true;

        // For range exports, use composite cursor "<iso_timestamp>|<uuid>" so the
        // RPC paginates with stable (created_at, id) ordering — needed because
        // OFFSET-anchored ranges depend on a deterministic order. For non-range
        // exports, leave cursor null and pass UUID-only cursors after the first
        // batch — the RPC then uses fast PK-index `ORDER BY l.id`. Random UUID
        // order doesn't matter when you're dumping the entire filtered set.
        const isRangeExport = !!(rangeFrom && rangeFrom > 1);
        let cursor: string | null = null;
        if (isRangeExport) {
          try {
            const { cursor: anchor, found } = await findCursorForRangeStart(
              supabaseAdmin,
              p_filters,
              rangeFrom
            );
            if (!found) {
              await markJobError(`Range start ${rangeFrom} is beyond available data`);
              safeError(`Range start ${rangeFrom} is beyond available data`);
              return;
            }
            cursor = anchor;
          } catch (err) {
            const msg = `Skip-to-cursor failed: ${err instanceof Error ? err.message : "unknown"}`;
            await markJobError(msg);
            safeError(msg);
            return;
          }
        }

        // Use direct pg pool for export RPC calls — bypasses the Supabase
        // HTTP gateway's ~60s upstream-request timeout. The function's own
        // statement_timeout (600s) becomes the actual ceiling.
        const pool = getPool();

        const adminDb = createAdminClient();

        while (hasMore && totalRows < maxRows && !closed) {
          // Cancel-button check: the UI's Cancel writes status='cancelled'
          // to the DB. Without this poll the server-side stream never sees
          // it and overwrites status back to 'complete' at the end. Polling
          // every batch (~5s of work each) is cheap relative to the batch
          // query itself.
          if (jobId && totalRows > 0) {
            const { data: jobStatus } = await adminDb
              .from("export_jobs")
              .select("status")
              .eq("id", jobId)
              .single();
            if (jobStatus?.status === "cancelled") {
              aborted = true;
              break;
            }
          }

          const take = Math.min(batchSize, maxRows - totalRows);

          let pgResult;
          try {
            pgResult = await pool.query(
              "SELECT fn_export_leads($1::jsonb, $2, $3, $4) AS data",
              [JSON.stringify(p_filters), cursor, take, 0]
            );
          } catch (err) {
            const msg = `RPC error after ${totalRows.toLocaleString()} rows: ${err instanceof Error ? err.message : "unknown"}`;
            console.error("Stream export RPC error:", msg);
            await markJobError(msg);
            safeError(msg);
            return;
          }

          const data = pgResult.rows[0]?.data as { data?: Lead[] } | null;
          const leads = (data?.data ?? []) as Lead[];
          if (leads.length === 0) break;

          // Build CSV chunk and stream it
          let chunk = "";
          for (const lead of leads) {
            chunk += columnSelection.map((col) => escapeCsv(lead[col as keyof Lead])).join(",") + "\n";
          }
          safeEnqueue(encoder.encode(chunk));

          totalRows += leads.length;

          // Live row_count update so the Exports page shows progress instead
          // of a perpetual em-dash. Don't await — we don't care if a single
          // progress write fails, and we don't want to add latency per batch.
          if (jobId) {
            void adminDb
              .from("export_jobs")
              .update({ row_count: totalRows })
              .eq("id", jobId);
          }

          const lastLead = leads[leads.length - 1] as Lead & { created_at?: string };
          cursor = isRangeExport && lastLead.created_at
            ? `${lastLead.created_at}|${lastLead.id}`
            : lastLead.id;
          hasMore = leads.length === take && totalRows < maxRows;
        }

        // Final status decision:
        //   errored  → 'error'     (set already by safeError → markJobError)
        //   aborted  → 'cancelled' (user clicked Cancel OR closed the tab)
        //   else     → 'complete'
        // Without the aborted branch, partial downloads were being marked
        // 'complete' with a truncated row_count, fooling the exports table
        // into showing them as successful.
        if (jobId && !errored) {
          const startJob = await adminDb.from("export_jobs").select("created_at").eq("id", jobId).single();
          const durationSec = startJob.data
            ? Math.round((Date.now() - new Date(startJob.data.created_at).getTime()) / 1000)
            : 0;
          await adminDb.from("export_jobs").update({
            status: aborted ? "cancelled" : "complete",
            row_count: totalRows,
            duration_seconds: durationSec,
            completed_at: new Date().toISOString(),
          }).eq("id", jobId);
        }

        safeClose();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        console.error("Stream export failed:", err);
        await markJobError(msg);
        safeError(msg);
      }
    },
  });

  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-");

  // Gzip the response on-the-fly. CSVs compress 5-10× since they're mostly
  // repetitive ASCII. The browser auto-decompresses based on the
  // Content-Encoding header, so the user gets a regular .csv file but
  // the bytes-over-the-wire are 5-10× smaller. Big win on slower networks.
  const compressedStream = stream.pipeThrough(new CompressionStream("gzip"));

  return new Response(compressedStream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Disposition": `attachment; filename="export_${timestamp}.csv"`,
      "Cache-Control": "no-cache",
    },
  });
}
