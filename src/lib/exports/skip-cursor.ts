import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lead } from "@/types/database";
import { getPool } from "@/lib/db/pool";

/**
 * Build a stable cursor anchor so subsequent paginated queries
 * (`WHERE (created_at, id) > (cursor_created_at, cursor_id)`) start at row
 * `rangeFrom` (1-indexed, inclusive).
 *
 * Returns a `cursor` string in the format `"<iso_timestamp>|<uuid>"` which the
 * RPC parses back into a composite tuple. Returns `null` cursor for rangeFrom
 * <= 1 (start from the beginning).
 *
 * Why a direct pg connection: the Supabase HTTP gateway (Cloudflare → PostgREST)
 * times out at ~60s. For deeply filtered OFFSETs (e.g. 850K rows into a 12M-row
 * filtered set) the SQL itself can take longer than 60s even when the function's
 * statement_timeout is 300s.
 *
 * The `_supabase` parameter is kept for API compatibility but unused.
 */
export async function findCursorForRangeStart(
  _supabase: SupabaseClient,
  p_filters: unknown,
  rangeFrom: number
): Promise<{ cursor: string | null; found: boolean }> {
  if (!rangeFrom || rangeFrom <= 1) {
    return { cursor: null, found: true };
  }

  // To start at row `rangeFrom`, we need the row at position (rangeFrom - 1)
  // as the cursor anchor. RPC's p_skip uses OFFSET (0-indexed), so we want
  // OFFSET (rangeFrom - 2) LIMIT 1.
  const pool = getPool();
  let result;
  try {
    result = await pool.query(
      "SELECT fn_export_leads($1::jsonb, NULL, 1, $2) AS data",
      [JSON.stringify(p_filters), rangeFrom - 2]
    );
  } catch (err) {
    throw new Error(`Skip-to-cursor failed: ${err instanceof Error ? err.message : "unknown"}`);
  }

  const payload = result.rows[0]?.data as { data?: Lead[] } | null;
  const leads = (payload?.data ?? []) as Lead[];
  if (leads.length === 0) {
    return { cursor: null, found: false };
  }

  const lead = leads[0];
  // RPC returns created_at as ISO string already (jsonb serialization).
  const createdAt = (lead as Lead & { created_at?: string }).created_at;
  if (!createdAt) {
    throw new Error("Skip-to-cursor anchor row missing created_at");
  }

  return { cursor: `${createdAt}|${lead.id}`, found: true };
}
