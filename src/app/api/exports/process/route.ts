import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { FilterState } from "@/types/filters";
import type { Lead } from "@/types/database";
import { buildRpcFilters } from "@/lib/filters/build-rpc-filters";
import { findCursorForRangeStart } from "@/lib/exports/skip-cursor";

interface ExportPayload {
  filters: FilterState;
  columnSelection: string[];
  selectedIds?: string[];
  limit?: number | null;
  rangeFrom?: number;
  rangeTo?: number;
}

// Service role client for RPC calls (no gateway timeout)
const supabaseAdmin = createSupabaseClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);


function leadToCsvRow(lead: Lead, columns: string[]): string {
  return columns
    .map((col) => {
      const val = lead[col as keyof Lead];
      if (val === null || val === undefined) return "";
      const str = Array.isArray(val) ? val.join("; ") : String(val);
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    })
    .join(",");
}

async function processExport(
  jobId: string,
  filters: FilterState,
  columnSelection: string[],
  selectedIds: string[] | undefined,
  limit: number | null,
  rangeFrom?: number,
  rangeTo?: number
) {
  const supabase = createAdminClient();
  const startTime = Date.now();

  try {
    // offset for selectedIds slicing; for cursor-based filtered exports we use rangeFrom directly
    const offset = rangeFrom && rangeFrom > 1 ? rangeFrom - 1 : 0;
    // maxRows is the max number of rows to emit:
    //   - If rangeFrom + rangeTo set: emit (rangeTo - rangeFrom + 1) rows
    //   - Else if limit set: emit `limit` rows
    //   - Else: unbounded
    const maxRows = rangeFrom && rangeTo
      ? rangeTo - rangeFrom + 1
      : limit && limit > 0
        ? limit
        : Infinity;
    let totalRows = 0;
    let partIndex = 0;
    const partFiles: string[] = [];

    // Upload CSV chunks to storage as we go (avoid memory buildup)
    async function uploadChunk(csvChunk: string) {
      const partName = `export_${jobId}_part${partIndex}.csv`;
      await supabase.storage.from("exports").upload(partName, csvChunk, {
        contentType: "text/csv",
        upsert: true,
      });
      partFiles.push(partName);
      partIndex++;
    }

    // Process in chunks of 50K rows to limit memory
    const CHUNK_SIZE = 50000;
    let csvBuffer: string[] = [columnSelection.join(",")];
    let bufferRows = 0;

    async function flushBuffer() {
      if (csvBuffer.length > 0) {
        await uploadChunk(csvBuffer.join("\n"));
        csvBuffer = [];
        bufferRows = 0;
      }
    }

    if (selectedIds && selectedIds.length > 0) {
      const take = maxRows === Infinity ? selectedIds.length : Math.min(selectedIds.length, maxRows);
      const ids = selectedIds.slice(offset, offset + take);

      for (let i = 0; i < ids.length; i += 1000) {
        const chunk = ids.slice(i, i + 1000);
        const { data } = await supabase.from("leads").select("*").in("id", chunk);
        const leads = (data ?? []) as Lead[];
        for (const lead of leads) {
          csvBuffer.push(leadToCsvRow(lead, columnSelection));
          bufferRows++;
        }
        totalRows += leads.length;

        if (bufferRows >= CHUNK_SIZE) await flushBuffer();

        await supabase
          .from("export_jobs")
          .update({ row_count: totalRows })
          .eq("id", jobId);
      }
    } else {
      const p_filters = buildRpcFilters(filters);
      const batchSize = 10000;
      // Range exports use composite cursor (timestamp|uuid) for stable ordering;
      // non-range exports use UUID-only cursors which trigger fast PK-index scan.
      const isRangeExport = !!(rangeFrom && rangeFrom > 1);
      let cursor: string | null = null;
      let hasMore = true;

      if (isRangeExport) {
        const { cursor: anchor, found } = await findCursorForRangeStart(
          supabaseAdmin,
          p_filters,
          rangeFrom
        );
        if (!found) {
          return;
        }
        cursor = anchor;
      }

      while (hasMore && totalRows < maxRows) {
        const take = Math.min(batchSize, maxRows - totalRows);

        const { data, error } = await supabaseAdmin.rpc("fn_export_leads", {
          p_filters,
          p_cursor: cursor,
          p_limit: take,
          p_skip: 0,
        });

        if (error) {
          console.error("Export RPC error:", error);
          break;
        }

        const leads = (data?.data ?? []) as Lead[];
        for (const lead of leads) {
          csvBuffer.push(leadToCsvRow(lead, columnSelection));
          bufferRows++;
        }
        totalRows += leads.length;

        // Flush to storage when buffer is large
        if (bufferRows >= CHUNK_SIZE) await flushBuffer();

        // Update progress and check for cancellation
        const { data: jobStatus } = await supabase
          .from("export_jobs")
          .select("status")
          .eq("id", jobId)
          .single();

        if (jobStatus?.status === "cancelled") {
          console.log(`Export ${jobId} was cancelled`);
          // Clean up part files
          if (partFiles.length > 0) {
            await supabase.storage.from("exports").remove(partFiles);
          }
          return;
        }

        await supabase
          .from("export_jobs")
          .update({ row_count: totalRows })
          .eq("id", jobId);

        if (leads.length > 0) {
          const lastLead = leads[leads.length - 1] as Lead & { created_at?: string };
          cursor = isRangeExport && lastLead.created_at
            ? `${lastLead.created_at}|${lastLead.id}`
            : lastLead.id;
        }
        hasMore = leads.length === take && leads.length > 0 && totalRows < maxRows;
      }
    }

    // Flush remaining buffer
    await flushBuffer();

    // Merge all parts into final file
    const allParts: string[] = [];
    for (const partName of partFiles) {
      const { data: partData } = await supabase.storage
        .from("exports")
        .download(partName);
      if (partData) {
        const text = await partData.text();
        allParts.push(text);
      }
    }

    const finalCsv = allParts.join("\n");
    const fileName = `export_${jobId}.csv`;

    const { error: uploadError } = await supabase.storage
      .from("exports")
      .upload(fileName, finalCsv, { contentType: "text/csv", upsert: true });

    if (uploadError) throw uploadError;

    // Clean up part files
    if (partFiles.length > 0) {
      await supabase.storage.from("exports").remove(partFiles);
    }

    const durationMs = Date.now() - startTime;
    const durationSec = Math.round(durationMs / 1000);

    await supabase
      .from("export_jobs")
      .update({
        status: "complete",
        file_path: fileName,
        row_count: totalRows,
        completed_at: new Date().toISOString(),
        duration_seconds: durationSec,
      })
      .eq("id", jobId);
  } catch (err) {
    console.error("Export failed:", err);
    await supabase
      .from("export_jobs")
      .update({ status: "error" })
      .eq("id", jobId);
  }
}

export async function POST(request: NextRequest) {
  const serverSupabase = await createClient();
  const {
    data: { user },
  } = await serverSupabase.auth.getUser();

  const adminSupabase = createAdminClient();

  let body: ExportPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { filters, columnSelection, selectedIds, limit, rangeFrom, rangeTo } = body;
  if (!filters || !columnSelection?.length) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const exportType = selectedIds && selectedIds.length > 0 ? "selected" : "filtered";

  // Check concurrent exports — max 3 at a time
  const { count } = await adminSupabase
    .from("export_jobs")
    .select("*", { count: "exact", head: true })
    .eq("status", "processing");

  if ((count ?? 0) >= 3) {
    return NextResponse.json(
      { error: "Too many exports running. Please wait for one to finish." },
      { status: 429 }
    );
  }

  const { data: job, error: jobError } = await adminSupabase
    .from("export_jobs")
    .insert({
      requested_by: user?.id ?? null,
      filters_used: {
        _meta: { exported_by: user?.email ?? "unknown", export_type: exportType },
        ...filters,
      } as unknown as Record<string, unknown>,
      selected_ids: selectedIds ?? null,
      column_selection: columnSelection,
      status: "processing",
    })
    .select()
    .single();

  if (jobError || !job) {
    return NextResponse.json(
      { error: jobError?.message ?? "Failed to create export job" },
      { status: 500 }
    );
  }

  void processExport(job.id, filters, columnSelection, selectedIds, limit ?? null, rangeFrom, rangeTo);

  return NextResponse.json({ jobId: job.id, queued: true });
}
