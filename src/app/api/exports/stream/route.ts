import { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { normalizeFilterState, type FilterState } from "@/types/filters";
import type { Lead } from "@/types/database";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { findCursorForRangeStart } from "@/lib/exports/skip-cursor";
import { getPool } from "@/lib/db/pool";
import { isValidationEnabled } from "@/lib/validation/validate-leads";
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
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
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

  // Role gate: a `viewer` may filter and browse but not extract data. Without
  // this, any authenticated session could stream the entire leads table.
  {
    const { data: profile } = await createAdminClient()
      .from("user_profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
      return new Response("Forbidden: your role cannot export leads", { status: 403 });
    }
  }

  const body = await request.json();
  const { filters, columnSelection, limit, rangeFrom, rangeTo, jobId, selectedIds } = body as {
    filters: FilterState;
    columnSelection: string[];
    limit?: number;
    rangeFrom?: number;
    rangeTo?: number;
    jobId?: string;
    selectedIds?: string[];
  };

  if (!filters || !columnSelection?.length) {
    return new Response("Missing required fields", { status: 400 });
  }

  // Selected export: the user explicitly picked these lead IDs, so we stream
  // them directly by id (no filters, no validation/bounce gate) instead of the
  // old fire-and-forget background job that never reliably completed.
  const isSelectedExport = Array.isArray(selectedIds) && selectedIds.length > 0;

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
  const maxRows = isSelectedExport ? selectedIds!.length : requestedMax;
  // Old clients / saved payloads may predate newer filter fields — normalize
  // onto DEFAULT_FILTER_STATE so buildRpcFilters never hits missing keys.
  const p_filters = buildRpcFilters(normalizeFilterState(filters));
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

  // ─── Validation never blocks the download (2026-09-14) ─────────────────
  // This route used to run Reoon on up to 2,000 addresses BEFORE streaming a
  // row. At power-mode SMTP speed that is ~20 minutes of silence: on 2026-09-11
  // an 8,451-lead export had validated 1,400 of 2,000 after 15 minutes with zero
  // rows sent ("0.0 MB") when the user cancelled. The largest CSV ever
  // completed through that path was 50 rows.
  //
  // Now the export's addresses are queued at priority 1 for the background
  // validation-worker (Reoon bulk tasks on daily credits) and the file streams
  // immediately. Fire-and-forget: the queue insert catches its own errors and
  // must never delay or fail the download. The export gate is unchanged —
  // results land in email_validations, not leads.validation_status, until the
  // client switches the rule once the backfill completes.
  const willQueue = isValidationEnabled() && !!jobId && !isSelectedExport;

  async function queueForValidation(): Promise<void> {
    try {
      const ttl = getTtlDays();
      const cutoff = new Date(Date.now() - ttl * 24 * 60 * 60 * 1000).toISOString();
      const cap = Math.min(
        Math.max(1, parseInt(process.env.VALIDATION_MAX_PER_EXPORT ?? "", 10) || 10000),
        maxRows,
      );
      const { rowCount } = await getPool().query(
        `insert into validation_queue (email, priority, source)
         select c->>'email', 1, $4
           from jsonb_array_elements(fn_leads_needing_validation($1::jsonb, $2::timestamptz, $3)) c
          where coalesce(c->>'email', '') <> ''
            and not exists (select 1 from email_validations v
                             where v.email = c->>'email' and v.validated_at > $2::timestamptz)
            and not exists (select 1 from validation_task_items ti
                              join validation_tasks t on t.id = ti.task_id and t.status in ('claimed','submitted')
                             where ti.email = c->>'email')
         on conflict (email) do update set priority = least(validation_queue.priority, excluded.priority)`,
        [JSON.stringify(p_filters), cutoff, cap, `export:${jobId}`],
      );
      console.log(`export ${jobId}: ${rowCount ?? 0} address(es) queued for background validation`);
    } catch (e) {
      console.error(`export ${jobId}: queueing addresses for validation failed:`, e);
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
        safeEnqueue(encoder.encode(columnSelection.join(",") + "\n"));

        // Background: queue this export's addresses for validation. Not awaited.
        if (willQueue) void queueForValidation();

        let totalRows = 0;
        let hasMore = true;

        // Every export paginates by a UUID cursor under the RPC's stable
        // `ORDER BY l.id`. Range anchors (skip-cursor) use the same ordering, so
        // the first and continuation batches can't disagree and duplicate/skip
        // rows. isRangeExport only decides whether to seek to an anchor first.
        const isRangeExport = !isSelectedExport && !!(rangeFrom && rangeFrom > 1);
        let cursor: string | null = null;
        let selOffset = 0; // index into selectedIds for the selected-export path
        const SEL_CHUNK = 1000;
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
          // it and overwrites status back to 'complete' at the end. Polled
          // before EVERY batch (including the first — a cancel during the
          // validation pre-pass must stop the export before it streams).
          if (jobId) {
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

          let leads: Lead[];
          if (isSelectedExport) {
            // Stream the explicitly-selected IDs directly, in chunks. No filter
            // and no validation/bounce gate — the user picked these rows.
            const idChunk = selectedIds!.slice(selOffset, selOffset + SEL_CHUNK);
            if (idChunk.length === 0) break;
            selOffset += idChunk.length;
            try {
              const r = await pool.query(
                "SELECT * FROM leads WHERE id = ANY($1::uuid[])",
                [idChunk]
              );
              leads = r.rows as Lead[];
            } catch (err) {
              const msg = `Selected-export query error after ${totalRows.toLocaleString()} rows: ${err instanceof Error ? err.message : "unknown"}`;
              console.error("Stream export query error:", msg);
              await markJobError(msg);
              safeError(msg);
              return;
            }
            hasMore = selOffset < selectedIds!.length;
          } else {
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
            leads = (data?.data ?? []) as Lead[];
          }
          if (leads.length === 0) {
            if (isSelectedExport && hasMore) continue;
            break;
          }

          // Build CSV chunk and stream it
          let chunk = "";
          for (const lead of leads) {
            chunk += columnSelection.map((col) => escapeCsv(lead[col as keyof Lead])).join(",") + "\n";
          }
          safeEnqueue(encoder.encode(chunk));

          totalRows += leads.length;

          // Live row_count update so the Exports page shows progress (and the
          // zombie self-heal in /api/exports/log sees a heartbeat). Fire-and-
          // forget, but the builder is lazy — it only executes when awaited or
          // .then()'d, so attach a no-op handler to actually send it.
          if (jobId) {
            void adminDb
              .from("export_jobs")
              .update({ row_count: totalRows })
              .eq("id", jobId)
              .then(() => {}, () => {});
          }

          if (!isSelectedExport) {
            cursor = leads[leads.length - 1].id;
            hasMore = leads.length === take && totalRows < maxRows;
          }
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
          // .neq guard: a Cancel that landed during the FINAL batch (after the
          // last poll) must not be overwritten back to 'complete'.
          await adminDb.from("export_jobs").update({
            status: aborted ? "cancelled" : "complete",
            row_count: totalRows,
            duration_seconds: durationSec,
            completed_at: new Date().toISOString(),
          }).eq("id", jobId).neq("status", "cancelled");
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
  // (Exports briefly streamed uncompressed so keepalive bytes could survive
  // the blocking validation phase; with that phase gone, all get gzip again.)
  const responseBody = stream.pipeThrough(new CompressionStream("gzip"));

  return new Response(responseBody, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Encoding": "gzip",
      "Content-Disposition": `attachment; filename="export_${timestamp}.csv"`,
      "Cache-Control": "no-cache",
    },
  });
}
