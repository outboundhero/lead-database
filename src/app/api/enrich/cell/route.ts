import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import type { CellDetail, EnrichColumn } from "@/lib/enrich/types";

// GET /api/enrich/cell?row=<id>&col=<key> — everything the cell panel shows:
// the column's Clay formula / run condition, the cell's full value and note,
// the values of the cells it reads, the client's own Clay value (CSV import)
// and every provider call made for it.

export const dynamic = "force-dynamic";

const REF = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const rowId = Number(req.nextUrl.searchParams.get("row"));
  const col = req.nextUrl.searchParams.get("col") ?? "";
  if (!Number.isSafeInteger(rowId) || rowId <= 0 || !/^[a-z][a-z0-9_]*$/.test(col)) {
    return NextResponse.json({ error: "row and col are required" }, { status: 400 });
  }
  try {
    const detail = await withTx<CellDetail | null>(
      async (c) => {
        const { rows: [row] } = await c.query(
          `SELECT r.id, r.table_id, r.run_status, r.last_error, r.created_at, r.reference ->> $2 AS reference, s.label AS source_label,
                  coalesce(
                    -- An AI Ark person: "Name · Company"; a company row: its name.
                    (SELECT n.display || coalesce(' · ' || co.display, '')
                       FROM enrich_cells n
                       LEFT JOIN enrich_cells co ON co.row_id = n.row_id AND co.column_key = 'company'
                      WHERE n.row_id = r.id AND n.column_key = 'full_name'),
                    (SELECT e.display FROM enrich_cells e WHERE e.row_id = r.id AND e.column_key = 'company'),
                    r.row_key) AS title
             FROM enrich_rows r LEFT JOIN enrich_sources s ON s.id = r.source_id
            WHERE r.id = $1`,
          [rowId, col]
        );
        if (!row) return null;
        const { rows: columns } = await c.query<EnrichColumn>(
          `SELECT key, name, position, kind, action, formula, waterfall, inputs, config, run_if, data_type,
                  description, provider, needs_env, phase, hidden, clay_field_id
             FROM enrich_columns WHERE table_id = $1 ORDER BY position`,
          [row.table_id]
        );
        const column = columns.find((x) => x.key === col);
        if (!column) return null;
        const columnNames = Object.fromEntries(columns.map((x) => [x.key, x.name]));
        const texts = [column.formula, column.run_if, ...(column.waterfall ?? []), ...Object.values(column.inputs ?? {})];
        const readKeys = [...new Set(texts.flatMap((t) => [...String(t ?? "").matchAll(REF)].map((m) => m[1])))].filter(
          (k) => k in columnNames && k !== col
        );
        const [cell, reads, runs] = await Promise.all([
          c.query(`SELECT status, value, display, note, runs, updated_at FROM enrich_cells WHERE row_id = $1 AND column_key = $2`, [rowId, col]),
          c.query(`SELECT column_key, status, display FROM enrich_cells WHERE row_id = $1 AND column_key = ANY ($2::text[])`, [rowId, readKeys]),
          c.query(
            `SELECT id, status, provider, request, response, error, http_status, duration_ms, started_at, finished_at
               FROM enrich_cell_runs WHERE row_id = $1 AND column_key = $2 ORDER BY id DESC LIMIT 20`,
            [rowId, col]
          ),
        ]);
        const byKey = new Map(reads.rows.map((r) => [r.column_key, r]));
        return {
          column,
          cell: cell.rows[0] ?? null,
          row: {
            id: Number(row.id),
            title: row.title,
            run_status: row.run_status,
            last_error: row.last_error,
            created_at: row.created_at,
            source_label: row.source_label,
            reference: row.reference,
          },
          reads: readKeys
            .map((k) => ({ key: k, name: columnNames[k], display: byKey.get(k)?.display ?? null, status: byKey.get(k)?.status ?? null }))
            .sort((a, b) => columns.findIndex((x) => x.key === a.key) - columns.findIndex((x) => x.key === b.key)),
          runs: runs.rows.map((r) => ({ ...r, id: Number(r.id) })),
          columnNames,
        };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    if (!detail) return NextResponse.json({ error: "No such cell" }, { status: 404 });
    return NextResponse.json(detail, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("enrich/cell:", err);
    return NextResponse.json({ error: "Could not load the cell" }, { status: 500 });
  }
}
