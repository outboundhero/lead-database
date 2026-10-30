import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { logAudit } from "@/lib/api/log-audit";

// POST /api/enrich/run — put rows back in the worker's queue.
//   { table, scope: "rows",    rows: [ids], column?, force? }  chosen rows; force re-buys paid answers
//   { table, scope: "column",  column, only? }                  one column for every row (or only rows whose
//                                                               cell is in state `only`, e.g. "error")
//   { table, scope: "errors" }                                  every row with a failed cell, failed cells forced
//   { table, scope: "waiting" }                                 rows that were waiting for a provider key
//   { table, scope: "all" }                                     the whole table; unchanged paid answers are reused
// Rows the worker is running right now are left alone and counted.
// Manager and up: a re-run can spend provider credits.

export const dynamic = "force-dynamic";

const KEY = /^[a-z][a-z0-9_]*$/;
const STATES = new Set(["done", "empty", "skipped", "error", "needs_key"]);

export async function POST(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  let body: { table?: string; scope?: string; rows?: unknown[]; column?: string; force?: boolean; only?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body is not JSON" }, { status: 400 });
  }
  const { table, scope } = body;
  if (!isUuid(table)) return NextResponse.json({ error: "table must be a table id" }, { status: 400 });
  const column = body.column && KEY.test(body.column) ? body.column : null;
  const requeue = `run_status = 'queued', next_run_at = now(), attempts = 0, last_error = NULL, updated_at = now()`;

  try {
    const out = await withTx(
      async (c) => {
        const running = async () =>
          (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = $1 AND run_status = 'running'`, [table]))
            .rows[0].n;
        switch (scope) {
          case "rows": {
            const ids = (body.rows ?? []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, 5_000);
            if (!ids.length) return { error: "rows is empty" };
            const force = body.force ? [column ?? "*"] : null;
            const r = await c.query(
              `UPDATE enrich_rows SET ${requeue}, run_force = coalesce($3::text[], run_force)
                WHERE table_id = $1 AND id = ANY ($2::bigint[]) AND run_status <> 'running'`,
              [table, ids, force]
            );
            return { queued: r.rowCount ?? 0, skippedRunning: ids.length - (r.rowCount ?? 0) };
          }
          case "column": {
            if (!column) return { error: "column is required" };
            const only = body.only && STATES.has(body.only) ? body.only : null;
            const r = await c.query(
              `UPDATE enrich_rows r SET ${requeue}, run_force = array_append(coalesce(r.run_force, '{}'), $2)
                WHERE r.table_id = $1 AND r.run_status <> 'running'
                  AND ($3::text IS NULL OR EXISTS (
                        SELECT 1 FROM enrich_cells e WHERE e.row_id = r.id AND e.column_key = $2 AND e.status = $3))`,
              [table, column, only]
            );
            return { queued: r.rowCount ?? 0, skippedRunning: await running() };
          }
          case "errors": {
            const a = await c.query(
              `UPDATE enrich_rows r SET ${requeue}, run_force = e.keys
                 FROM (SELECT row_id, array_agg(column_key) AS keys
                         FROM enrich_cells WHERE table_id = $1 AND status = 'error' GROUP BY row_id) e
                WHERE r.id = e.row_id AND r.table_id = $1 AND r.run_status <> 'running'`,
              [table]
            );
            const b = await c.query(`UPDATE enrich_rows SET ${requeue} WHERE table_id = $1 AND run_status = 'error'`, [table]);
            return { queued: (a.rowCount ?? 0) + (b.rowCount ?? 0), skippedRunning: await running() };
          }
          case "waiting": {
            const r = await c.query(`UPDATE enrich_rows SET ${requeue} WHERE table_id = $1 AND run_status = 'waiting'`, [table]);
            return { queued: r.rowCount ?? 0, skippedRunning: 0 };
          }
          case "all": {
            const r = await c.query(`UPDATE enrich_rows SET ${requeue} WHERE table_id = $1 AND run_status <> 'running'`, [table]);
            return { queued: r.rowCount ?? 0, skippedRunning: await running() };
          }
          default:
            return { error: "scope must be rows, column, errors, waiting or all" };
        }
      },
      { timeoutMs: 30_000 }
    );
    if ("error" in out) return NextResponse.json(out, { status: 400 });
    await logAudit({
      action: "enrich_run",
      performedBy: auth.user.id,
      details: `table ${table}: ${scope}${column ? ` (${column})` : ""}${body.force ? " forced" : ""} — ${out.queued} rows queued`,
    });
    return NextResponse.json(out);
  } catch (err) {
    console.error("enrich/run:", err);
    return NextResponse.json({ error: "Could not queue the rows" }, { status: 500 });
  }
}
