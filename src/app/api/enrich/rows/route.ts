import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { insertRows, type IncomingRow } from "@/lib/enrich/insert-rows";
import { logAudit } from "@/lib/api/log-audit";
import { ROW_STATUSES, type GridRow, type RowStatus, type RowsPage } from "@/lib/enrich/types";

// The Clay tab's rows.
//   GET    ?table=&page=&size=&q=&status=&f=col:state,…&sort=col:asc|desc
//          One page, filtered, searched and sorted on the server (no client-side cap).
//          f states: done | empty | skipped | error | needs_key | running | true | false | none
//   POST   { table, label, rows: [{ inputs, reference }] }  — CSV import, at most 2,000 rows a call
//   DELETE { table, ids }                                    — admins only

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CELL_STATES = new Set(["done", "empty", "skipped", "error", "needs_key", "running"]);
const KEY = /^[a-z][a-z0-9_]*$/;
const MAX_IMPORT = 2_000;

const int = (v: string | null, d: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
};

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const sp = req.nextUrl.searchParams;
  const table = sp.get("table");
  if (!isUuid(table)) return NextResponse.json({ error: "table must be a table id" }, { status: 400 });
  const size = Math.min(200, Math.max(10, int(sp.get("size"), 50)));
  const page = Math.max(1, int(sp.get("page"), 1));
  const q = (sp.get("q") ?? "").trim().toLowerCase().slice(0, 200);
  const status = sp.get("status");

  const params: unknown[] = [table];
  const where = ["r.table_id = $1"];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (q) where.push(`r.search_text LIKE ${p(`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`)}`);
  if (status && ROW_STATUSES.includes(status as RowStatus)) where.push(`r.run_status = ${p(status)}`);
  for (const f of (sp.get("f") ?? "").split(",").filter(Boolean).slice(0, 8)) {
    const [col, state] = f.split(":");
    if (!KEY.test(col ?? "")) continue;
    const c = p(col);
    if (state === "true" || state === "false") {
      where.push(
        `EXISTS (SELECT 1 FROM enrich_cells c WHERE c.row_id = r.id AND c.column_key = ${c} AND c.status = 'done' AND c.value = to_jsonb(${p(state === "true")}::boolean))`
      );
    } else if (state === "none") {
      where.push(`NOT EXISTS (SELECT 1 FROM enrich_cells c WHERE c.row_id = r.id AND c.column_key = ${c})`);
    } else if (CELL_STATES.has(state)) {
      where.push(`EXISTS (SELECT 1 FROM enrich_cells c WHERE c.row_id = r.id AND c.column_key = ${c} AND c.status = ${p(state)})`);
    }
  }
  const filtered = where.length > 1;
  const whereParams = [...params]; // the count reuses exactly these
  const [sortCol, sortDir] = (sp.get("sort") ?? "").split(":");
  const dir = sortDir === "desc" ? "DESC" : "ASC";
  const order = KEY.test(sortCol ?? "")
    ? `(SELECT c.display FROM enrich_cells c WHERE c.row_id = r.id AND c.column_key = ${p(sortCol)}) ${dir} NULLS LAST, r.id ${dir}`
    : `r.id ${dir}`;
  const limit = p(size);
  const offset = p((page - 1) * size);

  try {
    const out = await withTx<RowsPage>(
      async (c) => {
        const { rows } = await c.query(
          `SELECT r.id, r.row_key, r.run_status, r.last_error, r.created_at, r.reference, coalesce(cells.cells, '{}'::jsonb) AS cells
             FROM enrich_rows r
             LEFT JOIN LATERAL (
               SELECT jsonb_object_agg(e.column_key, jsonb_build_object(
                        's', e.status, 'd', e.display, 'n', e.note,
                        'v', CASE WHEN jsonb_typeof(e.value) IN ('boolean', 'number') THEN e.value
                                  WHEN jsonb_typeof(e.value) = 'string' AND length(e.value #>> '{}') <= 300 THEN e.value END)) AS cells
                 FROM enrich_cells e WHERE e.row_id = r.id
             ) cells ON true
            WHERE ${where.join(" AND ")}
            ORDER BY ${order}
            LIMIT ${limit} OFFSET ${offset}`,
          params
        );
        let total: number;
        if (filtered) {
          const { rows: [n] } = await c.query(
            `SELECT count(*)::int AS n FROM enrich_rows r WHERE ${where.join(" AND ")}`,
            whereParams
          );
          total = n.n;
        } else {
          const { rows: [t] } = await c.query(`SELECT row_count FROM enrich_tables WHERE id = $1`, [table]);
          total = t?.row_count ?? 0;
        }
        return {
          rows: rows.map((r) => ({ ...r, id: Number(r.id) }) as GridRow),
          total,
          page,
          size,
        };
      },
      { readOnly: true, timeoutMs: 10_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("enrich/rows GET:", err);
    const timedOut = (err as { code?: string } | null)?.code === "57014";
    return NextResponse.json({ error: timedOut ? "The search took too long" : "Could not load rows" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { table?: string; label?: string; rows?: IncomingRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  if (!isUuid(body.table)) return NextResponse.json({ error: "table must be a table id" }, { status: 400 });
  if (!Array.isArray(body.rows) || body.rows.length === 0) return NextResponse.json({ error: "rows is empty" }, { status: 400 });
  if (body.rows.length > MAX_IMPORT) return NextResponse.json({ error: `At most ${MAX_IMPORT} rows per call` }, { status: 400 });
  try {
    const result = await withTx(
      async (c) => {
        const { rows: cols } = await c.query<{ key: string }>(
          `SELECT key FROM enrich_columns WHERE table_id = $1 AND kind = 'input'`,
          [body.table]
        );
        if (!cols.length) return null;
        return insertRows(c, {
          tableId: body.table!,
          inputKeys: cols.map((r) => r.key),
          source: { kind: "csv", label: String(body.label ?? "CSV import").slice(0, 200), createdBy: auth.user.id },
          rows: body.rows!,
        });
      },
      { timeoutMs: 45_000 }
    );
    if (!result) return NextResponse.json({ error: "No such table" }, { status: 404 });
    return NextResponse.json(result);
  } catch (err) {
    console.error("enrich/rows POST:", err);
    return NextResponse.json({ error: "Import failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireRole("admin");
  if ("error" in auth) return auth.error;
  let body: { table?: string; ids?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const ids = (body.ids ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!isUuid(body.table) || !ids.length) {
    return NextResponse.json({ error: "table and ids are required" }, { status: 400 });
  }
  try {
    const deleted = await withTx(
      async (c) =>
        (await c.query(`DELETE FROM enrich_rows WHERE table_id = $1 AND id = ANY ($2::bigint[]) AND run_status <> 'running'`, [body.table, ids]))
          .rowCount ?? 0,
      { timeoutMs: 30_000 }
    );
    await logAudit({ action: "enrich_rows_delete", performedBy: auth.user.id, details: `table ${body.table}: ${deleted} rows` });
    return NextResponse.json({ deleted, skippedRunning: ids.length - deleted });
  } catch (err) {
    console.error("enrich/rows DELETE:", err);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
