import { NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";

// GET /api/enrich/tables — every Clay-tab table, with the worker's heartbeat.
// AI Ark run tables (kind ai_ark) come last, newest first, with their run.

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  try {
    const out = await withTx(
      async (c) => {
        const { rows: tables } = await c.query(
          `SELECT t.id, t.client_tag, ct.name AS client_name, t.kind, t.name, t.row_count, t.is_paused, t.updated_at, t.created_at,
                  CASE WHEN r.id IS NULL THEN NULL ELSE json_build_object(
                    'id', r.id, 'status', r.status, 'mode', r.mode, 'strategy', r.strategy,
                    'pulled', r.pulled, 'size', r.size_requested, 'created_at', r.created_at) END AS run
             FROM enrich_tables t
             LEFT JOIN client_tags ct ON ct.tag = t.client_tag
             LEFT JOIN aiark_runs r ON r.table_id = t.id
            ORDER BY t.client_tag,
                     CASE t.kind WHEN 'companies' THEN 1 WHEN 'people' THEN 2 WHEN 'inboxes' THEN 3 ELSE 4 END,
                     CASE WHEN t.kind = 'ai_ark' THEN t.created_at END DESC NULLS LAST,
                     t.name`
        );
        return { tables, worker: await workerState(c) };
      },
      { readOnly: true, timeoutMs: 8_000 }
    );
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("enrich/tables:", err);
    return NextResponse.json({ error: "Could not load the Clay tables" }, { status: 500 });
  }
}
