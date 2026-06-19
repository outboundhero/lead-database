import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeRow, type FieldMapping } from "@/lib/uploads/normalize-row";
import { normalizeBisonRow } from "@/lib/uploads/parse-bison";
import Papa from "papaparse";

export const maxDuration = 300;

interface UploadConfig {
  headers: string[];
  fieldMapping: FieldMapping;
  duplicateStrategy: "skip" | "merge" | "replace";
  overrideFields?: string[];
  filename: string;
  format?: "generic" | "bison"; // bison = use the Email Bison parser, ignore fieldMapping
}

const CHUNK_SIZE = 500;

export async function POST(request: NextRequest) {
  // Auth check
  const { createClient: createServerClient } = await import("@/lib/supabase/server");
  const serverSupabase = await createServerClient();
  const { data: { user } } = await serverSupabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  let config: UploadConfig;
  let csvText: string;

  try {
    const configStr = request.headers.get("X-Upload-Config");
    if (!configStr) {
      return NextResponse.json(
        { error: "Missing X-Upload-Config header" },
        { status: 400 }
      );
    }
    config = JSON.parse(configStr);
    csvText = await request.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read upload: ${msg}` },
      { status: 400 }
    );
  }

  const { headers, fieldMapping, duplicateStrategy, overrideFields = [], filename, format = "generic" } = config;

  const isBison = format === "bison";
  if ((!fieldMapping && !isBison) || !duplicateStrategy) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Parse CSV server-side
  const parsed = Papa.parse(csvText, { skipEmptyLines: true });
  const allRows = parsed.data as string[][];

  // Skip header row
  const rows = allRows.slice(1);

  if (rows.length === 0) {
    return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });
  }

  // Create upload batch record
  const { data: batch, error: batchError } = await supabase
    .from("upload_batches")
    .insert({
      filename,
      total_rows: rows.length,
      status: "processing",
    })
    .select()
    .single();

  if (batchError || !batch) {
    return NextResponse.json(
      { error: batchError?.message ?? "Failed to create batch" },
      { status: 500 }
    );
  }

  const batchId = batch.id;
  let inserted = 0;
  let skipped = 0;
  let merged = 0;
  let replaced = 0;
  let errors = 0;

  // Process in chunks
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const historyBatch: {
      lead_id: string;
      event_type: string;
      changed_fields: Record<string, { old: unknown; new: unknown }> | null;
      notes: string;
    }[] = [];

    for (const row of chunk) {
      try {
        const normalized = isBison
          ? normalizeBisonRow(row, headers)
          : normalizeRow(row, headers, fieldMapping);
        if (!normalized || !normalized.email) {
          skipped++;
          continue;
        }

        const email = normalized.email as string;

        // Check if lead exists
        const { data: existing } = await supabase
          .from("leads")
          .select("id")
          .eq("email", email)
          .maybeSingle();

        if (existing) {
          // Duplicate found
          switch (duplicateStrategy) {
            case "skip":
              skipped++;
              break;
            case "merge": {
              // Only fill blank fields
              const { data: current } = await supabase
                .from("leads")
                .select("*")
                .eq("id", existing.id)
                .single();
              if (current) {
                const updates: Record<string, unknown> = {};
                const changedFields: Record<string, { old: unknown; new: unknown }> = {};
                for (const [key, val] of Object.entries(normalized)) {
                  if (key === "email") continue;
                  if (val && !current[key]) {
                    updates[key] = val;
                    changedFields[key] = { old: current[key] ?? null, new: val };
                  }
                }
                if (Object.keys(updates).length > 0) {
                  updates.updated_at = new Date().toISOString();
                  await supabase
                    .from("leads")
                    .update(updates)
                    .eq("id", existing.id);
                  historyBatch.push({
                    lead_id: existing.id,
                    event_type: "updated",
                    changed_fields: changedFields,
                    notes: `Merged from upload: ${filename}`,
                  });
                }
              }
              merged++;
              break;
            }
            case "replace": {
              // Only override fields the user selected
              const { data: current } = await supabase
                .from("leads")
                .select("*")
                .eq("id", existing.id)
                .single();
              if (current) {
                const updates: Record<string, unknown> = {};
                const changedFields: Record<string, { old: unknown; new: unknown }> = {};
                for (const [key, val] of Object.entries(normalized)) {
                  if (key === "email") continue;
                  if (!overrideFields.includes(key)) continue;
                  if (val && val !== current[key]) {
                    updates[key] = val;
                    changedFields[key] = { old: current[key] ?? null, new: val };
                  }
                }
                if (Object.keys(updates).length > 0) {
                  updates.updated_at = new Date().toISOString();
                  await supabase
                    .from("leads")
                    .update(updates)
                    .eq("id", existing.id);
                  historyBatch.push({
                    lead_id: existing.id,
                    event_type: "updated",
                    changed_fields: Object.keys(changedFields).length > 0 ? changedFields : null,
                    notes: `Replaced fields [${overrideFields.join(", ")}] from upload: ${filename}`,
                  });
                }
              }
              replaced++;
              break;
            }
          }
        } else {
          // New lead — insert
          const { data: insertedLead, error: insertError } = await supabase
            .from("leads")
            .insert(normalized)
            .select("id")
            .single();
          if (insertError) {
            errors++;
          } else {
            inserted++;
            if (insertedLead) {
              historyBatch.push({
                lead_id: insertedLead.id,
                event_type: "created",
                changed_fields: null,
                notes: `Created from upload: ${filename}`,
              });
            }
          }
        }
      } catch {
        errors++;
      }
    }

    // Flush history records for this chunk
    if (historyBatch.length > 0) {
      await supabase.from("lead_history").insert(historyBatch);
    }

    // Update batch progress after each chunk
    await supabase
      .from("upload_batches")
      .update({
        processed_rows: Math.min(i + CHUNK_SIZE, rows.length),
        skipped_rows: skipped,
        merged_rows: merged,
        replaced_rows: replaced,
      })
      .eq("id", batchId);
  }

  // Mark complete
  await supabase
    .from("upload_batches")
    .update({
      status: "complete",
      processed_rows: rows.length,
      skipped_rows: skipped,
      merged_rows: merged,
      replaced_rows: replaced,
      completed_at: new Date().toISOString(),
    })
    .eq("id", batchId);

  return NextResponse.json({
    batchId,
    inserted,
    skipped,
    merged,
    replaced,
    errors,
  });
}
