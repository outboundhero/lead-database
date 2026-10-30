import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import type { ColumnCounts, TableDetail } from "@/lib/enrich/types";

// GET /api/enrich/table?id=<uuid> — one table's columns, the per-column counts
// for the headers (trigger-kept enrich_counters, never a COUNT over cells),
// row status totals, recent deliveries and the worker's heartbeat.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const id = req.nextUrl.searchParams.get("id");
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a table id" }, { status: 400 });
  try {
    const detail = await withTx<TableDetail | null>(
      async (c) => {
        const { rows: [table] } = await c.query(
          `SELECT t.id, t.client_tag, ct.name AS client_name, t.kind, t.name, t.row_count, t.is_paused, t.updated_at, t.source_note
             FROM enrich_tables t LEFT JOIN client_tags ct ON ct.tag = t.client_tag
            WHERE t.id = $1`,
          [id]
        );
        if (!table) return null;
        const [columns, counters, statuses, sources, keys, worker] = await Promise.all([
          c.query(
            `SELECT key, name, position, kind, action, formula, waterfall, inputs, config, run_if, data_type,
                    description, provider, needs_env, phase, hidden, clay_field_id
               FROM enrich_columns WHERE table_id = $1 ORDER BY position`,
            [id]
          ),
          c.query(`SELECT column_key, status, bucket, n::int AS n FROM enrich_counters WHERE table_id = $1 AND n <> 0`, [id]),
          c.query(`SELECT run_status, count(*)::int AS n FROM enrich_rows WHERE table_id = $1 GROUP BY 1`, [id]),
          c.query(
            `SELECT id, kind, label, received, created, duplicates, skipped, created_at
               FROM enrich_sources WHERE table_id = $1 ORDER BY created_at DESC LIMIT 20`,
            [id]
          ),
          c.query(
            `SELECT source_table, count(*)::int AS n FROM imported_company_keys WHERE client_tag = $1 GROUP BY 1`,
            [table.client_tag]
          ),
          workerState(c),
        ]);
        const counts: Record<string, ColumnCounts> = {};
        for (const r of counters.rows) {
          const k = r.bucket && r.status === "done" ? r.bucket : r.status;
          const col = (counts[r.column_key] ??= {});
          col[k as keyof ColumnCounts] = (col[k as keyof ColumnCounts] ?? 0) + r.n;
          if (r.bucket && r.status === "done") col.done = (col.done ?? 0) + r.n;
        }
        return {
          table,
          columns: columns.rows,
          counts,
          statuses: Object.fromEntries(statuses.rows.map((r) => [r.run_status, r.n])),
          sources: sources.rows,
          keyCounts: Object.fromEntries(keys.rows.map((r) => [r.source_table, r.n])),
          worker,
        };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    if (!detail) return NextResponse.json({ error: "No such table" }, { status: 404 });
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("enrich/table:", err);
    return NextResponse.json({ error: "Could not load the table" }, { status: 500 });
  }
}
