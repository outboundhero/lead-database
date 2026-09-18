import { NextRequest, NextResponse, after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db/pool";
import { importRows, type ImportCounters } from "@/lib/uploads/import-rows";
import { normalizeBisonRow } from "@/lib/uploads/parse-bison";
import type { FieldMapping } from "@/lib/uploads/normalize-row";
import { parse } from "csv-parse/sync";

// POST /api/uploads/process — CSV import.
//
// Generic CSVs go through the bulk engine in src/lib/uploads/import-rows.ts
// (set-based, chunked, transactional; see its header for the rules: holdbacks
// for rows without an email, merge/replace/skip for duplicates, additional
// locations for the same person at a different place, MX-based ESP detection).
// The request returns { batchId } as soon as the batch row exists; the import
// itself runs after the response (Next `after()` — the Railway process is
// long-lived, so a 10k-row file's ~3 minutes never meet an HTTP timeout) and
// the Uploads page follows it by polling upload_batches. A batch that dies
// without a final status is marked 'error' by the sweep at the top of the
// next upload.
// The Email Bison export format keeps its original per-row path below — it is
// used rarely now that the Bison mirror exists, and its semantics (never
// downgrade is_bounced, keep DB timestamps) are worth not disturbing.
//
// Deliberately NOT here any more: the inline `fn_sync_companies` call. The
// 2026-09-16 audit measured it at ~5 min and 5 GB of temp per call; it belongs
// to the categorize worker, which loops it correctly.

export const maxDuration = 300;
const STRATEGIES = new Set(["skip", "merge", "replace"]);
const STALE_AFTER_MS = 3 * 3600_000;

interface UploadConfig {
  headers: string[];
  fieldMapping: FieldMapping;
  duplicateStrategy: "skip" | "merge" | "replace";
  overrideFields?: string[];
  filename: string;
  format?: "generic" | "bison";
  delimiter?: string;
  /** Tags stamped on every row (client tag), added to a lead's existing tags. */
  addTags?: string[];
}
const TAG_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

const norm = (s: string) => s.trim().toLowerCase();

export async function POST(request: NextRequest) {
  const serverSupabase = await createClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const supabase = createAdminClient();
  // Role gate (was missing): importing writes to the whole database.
  const { data: profile } = await supabase.from("user_profiles").select("role").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden: your role cannot import leads" }, { status: 403 });
  }

  let config: UploadConfig;
  let csvText: string;
  try {
    const raw = request.headers.get("X-Upload-Config");
    if (!raw) return NextResponse.json({ error: "Missing X-Upload-Config header" }, { status: 400 });
    // Sent URI-encoded (header values must be Latin-1; filenames and CSV
    // headers are not). A bare JSON object is still accepted.
    config = JSON.parse(raw.trimStart().startsWith("{") ? raw : decodeURIComponent(raw));
    // NUL bytes (present in 2 of the client's 20 files) cannot be stored in
    // text or jsonb — Postgres rejects the whole 2,000-row payload (22P05).
    csvText = (await request.text()).split("\0").join("");
  } catch (err) {
    return NextResponse.json({ error: `Failed to read upload: ${err instanceof Error ? err.message : "Unknown error"}` }, { status: 400 });
  }

  const { headers, fieldMapping, duplicateStrategy, overrideFields = [], filename, format = "generic", delimiter, addTags = [] } = config;
  const isBison = format === "bison";
  if ((!fieldMapping && !isBison) || !duplicateStrategy) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }
  if (!STRATEGIES.has(duplicateStrategy) || !Array.isArray(overrideFields) || !Array.isArray(headers) || !headers.every((h) => typeof h === "string")) {
    return NextResponse.json({ error: "Invalid duplicate strategy or mapping" }, { status: 400 });
  }
  if (!Array.isArray(addTags) || addTags.length > 5 || !addTags.every((t) => typeof t === "string" && TAG_RE.test(t.trim()))) {
    return NextResponse.json({ error: "Invalid tags (up to 5, letters/digits/space/_ . -)" }, { status: 400 });
  }

  // csv-parse, as every ingestion path uses, so quoting/escaping is identical.
  // The delimiter is whatever the browser-side parser detected for this file.
  let allRows: string[][];
  try {
    allRows = parse(csvText, {
      skip_empty_lines: true, relax_quotes: true, relax_column_count: true, bom: true,
      delimiter: typeof delimiter === "string" && delimiter.length === 1 ? delimiter : ",",
    }) as string[][];
  } catch (err) {
    return NextResponse.json({ error: `CSV parse failed: ${err instanceof Error ? err.message : "Unknown error"}` }, { status: 400 });
  }
  const sourceHeaders = allRows[0] ?? [];
  const rows = allRows.slice(1);
  if (rows.length === 0) return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });

  // The mapping was built from the first file's header row in the browser.
  // Refuse a file whose columns sit elsewhere instead of importing them into
  // the wrong fields.
  if (!isBison) {
    if (sourceHeaders.length !== headers.length) {
      return NextResponse.json({ error: `Column count differs from the mapped file (${sourceHeaders.length} vs ${headers.length}) — map this file separately` }, { status: 400 });
    }
    for (const idx of Object.keys(fieldMapping).map(Number)) {
      if (norm(sourceHeaders[idx] ?? "") !== norm(headers[idx] ?? "")) {
        return NextResponse.json({ error: `Column ${idx + 1} is "${sourceHeaders[idx]}" here but "${headers[idx]}" in the mapped file — map this file separately` }, { status: 400 });
      }
    }
  }

  // Batches that never got a final status (process restart, crash) would poll
  // forever in the UI; anything still 'processing' after 3 h is dead.
  await supabase.from("upload_batches")
    .update({ status: "error", error_log: ["Stalled: no final status after 3 hours (server restarted?). Rows imported before that point are kept."], completed_at: new Date().toISOString() })
    .eq("status", "processing").lt("created_at", new Date(Date.now() - STALE_AFTER_MS).toISOString());

  const { data: batch, error: batchError } = await supabase
    .from("upload_batches")
    .insert({
      filename,
      total_rows: rows.length,
      status: "processing",
      uploaded_by: user.id,
      duplicate_strategy: duplicateStrategy,
      field_mapping: isBison ? null : fieldMapping,
      source_headers: sourceHeaders,
      batch_type: "leads",
    })
    .select()
    .single();
  if (batchError || !batch) {
    return NextResponse.json({ error: batchError?.message ?? "Failed to create batch" }, { status: 500 });
  }
  const batchId = batch.id as string;

  if (isBison) return processBisonLegacy(supabase, rows, headers, batchId, filename);

  const writeProgress = async (c: ImportCounters, status?: "complete" | "error") => {
    const patch = {
      processed_rows: c.processed,
      inserted_rows: c.inserted,
      merged_rows: c.merged,
      replaced_rows: c.replaced,
      skipped_rows: c.skipped,
      no_email_rows: c.no_email,
      in_file_duplicates: c.in_file_duplicates,
      locations_added: c.locations_added,
      esp_detected: c.esp_detected,
      error_rows: c.errors,
      error_log: c.error_log.length ? c.error_log : null,
      ...(status ? { status, completed_at: new Date().toISOString() } : {}),
    };
    // The final write is what stops the UI polling: retry it.
    for (let attempt = 1; ; attempt++) {
      const { error } = await supabase.from("upload_batches").update(patch).eq("id", batchId);
      if (!error) return;
      if (!status || attempt >= 3) { console.error(`[uploads] progress write failed for ${batchId}: ${error.message}`); return; }
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  };

  after(async () => {
    try {
      const counters = await importRows(getPool(), rows, {
        batchId, filename, headers, fieldMapping, duplicateStrategy, overrideFields,
        addTags: addTags.map((t) => t.trim()),
        onProgress: (c) => writeProgress(c),
      });
      const nothingLanded = counters.inserted + counters.merged + counters.replaced + counters.skipped === 0;
      await writeProgress(counters, counters.errors > 0 && nothingLanded ? "error" : "complete");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error(`[uploads] import ${batchId} failed: ${msg}`);
      await supabase.from("upload_batches").update({ status: "error", error_log: [msg], completed_at: new Date().toISOString() }).eq("id", batchId);
    }
  });

  return NextResponse.json({ batchId, totalRows: rows.length }, { status: 202 });
}

// ── Email Bison export format: original per-row upsert, unchanged semantics ──
async function processBisonLegacy(
  supabase: ReturnType<typeof createAdminClient>,
  rows: string[][],
  headers: string[],
  batchId: string,
  filename: string,
) {
  const CHUNK_SIZE = 500;
  let inserted = 0, skipped = 0, merged = 0, errors = 0;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    for (const row of chunk) {
      try {
        const normalized = normalizeBisonRow(row, headers);
        if (!normalized || !normalized.email) { skipped++; continue; }
        const email = normalized.email as string;
        // Full upsert so engagement/esp/validation-relevant fields are always
        // refreshed. Never downgrade is_bounced; never regress DB timestamps.
        const { data: existing } = await supabase.from("leads").select("id, is_bounced").eq("email", email).maybeSingle();
        if (existing) {
          if (existing.is_bounced) { normalized.is_bounced = true; delete normalized.bounced_at; delete normalized.bounce_source; }
          delete normalized.created_at; delete normalized.updated_at;
          const { error } = await supabase.from("leads").update(normalized).eq("id", existing.id);
          if (error) errors++; else merged++;
        } else {
          const { error } = await supabase.from("leads").insert(normalized);
          if (error) errors++; else inserted++;
        }
      } catch { errors++; }
    }
    await supabase.from("upload_batches").update({
      processed_rows: Math.min(i + CHUNK_SIZE, rows.length), inserted_rows: inserted, skipped_rows: skipped, merged_rows: merged, error_rows: errors,
    }).eq("id", batchId);
  }
  await supabase.from("upload_batches").update({
    status: "complete", processed_rows: rows.length, inserted_rows: inserted, skipped_rows: skipped, merged_rows: merged, error_rows: errors,
    completed_at: new Date().toISOString(),
  }).eq("id", batchId);
  return NextResponse.json({ batchId, inserted, skipped, merged, replaced: 0, errors, filename });
}
