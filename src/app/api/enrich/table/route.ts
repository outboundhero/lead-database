import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/enrich/auth";
import { isUuid, withTx } from "@/lib/enrich/db";
import { workerState } from "@/lib/enrich/queries";
import type { ColumnCounts, SourceSummary, TableDetail } from "@/lib/enrich/types";
import { locationFilterSummary } from "../../../../../scripts/lib/enrich/maps-place.mjs";

// GET /api/enrich/table?id=<uuid> — one table's columns, the per-column counts
// for the headers (trigger-kept enrich_counters, never a COUNT over cells),
// row status totals, recent deliveries and the worker's heartbeat.
// `deliveries` are the table's 10 newest Google Maps chunks (sources of kind
// maps), each with the inbound URL it came through (migration 129) and, when
// the chunk sent a location filter, its summary (`filter`: the version and the
// entries of each list, or the note why it was not kept; migration 139), and
// how many of its skipped places were Google Maps ads (`skipped_ads`; null for
// a delivery stored before that count was kept).
// `uploads` (a People (pipeline) table only, migration 130) are the 10 newest
// uploads whose no-email rows the table holds (sources of kind upload), each
// with its rows still held; `people_switch` says whether the client is on
// People runs (people_pipeline), which releases them. Null on any other table.

/** A location filter a Maps chunk sent, in short (maps-place.mjs locationFilterSummary). */
export type LocationFilterSummary = {
  version: number | null;
  countries: number;
  include: number;
  exclude: number;
  zips: number;
  radius: boolean;
  text: boolean;
  note: string | null;
};
/**
 * A Google Maps chunk the table received, the inbound URL it came through, its location filter in short (null: none
 * sent), and how many of its skipped places were Google Maps ads (null: stored before that count was kept).
 */
export type MapsDelivery = SourceSummary & { inbound_url_id: string | null; filter: LocationFilterSummary | null; skipped_ads: number | null };

/** meta.skipped_ads as a count: a whole number from 0 up, else null. */
const adsCount = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
/** An upload whose no-email rows the table holds: the upload's batch id and its rows still held. */
export type UploadDelivery = SourceSummary & { batch_id: string | null; held: number };
/** What this route answers: the table's detail, its newest Maps deliveries, and on a People (pipeline) table its uploads. */
export type TableDetailView = TableDetail & { deliveries: MapsDelivery[]; uploads: UploadDelivery[]; people_switch: boolean | null };

const PEOPLE_TEMPLATE = "people_v1";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireRole("manager");
  if ("error" in auth) return auth.error;
  const id = req.nextUrl.searchParams.get("id");
  if (!isUuid(id)) return NextResponse.json({ error: "id must be a table id" }, { status: 400 });
  try {
    const detail = await withTx<TableDetailView | null>(
      async (c) => {
        const { rows: [table] } = await c.query(
          `SELECT t.id, t.client_tag, ct.name AS client_name, t.kind, t.template, t.name, t.row_count, t.is_paused, t.updated_at, t.source_note
             FROM enrich_tables t LEFT JOIN client_tags ct ON ct.tag = t.client_tag
            WHERE t.id = $1`,
          [id]
        );
        if (!table) return null;
        const [columns, counters, statuses, sources, deliveries, keys, worker] = await Promise.all([
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
            `SELECT id, kind, label, received, created, duplicates, skipped, created_at, inbound_url_id,
                    meta -> 'location_filter' AS location_filter, meta ->> 'location_filter_note' AS location_filter_note,
                    meta -> 'skipped_ads' AS skipped_ads
               FROM enrich_sources WHERE table_id = $1 AND kind = 'maps' ORDER BY created_at DESC LIMIT 10`,
            [id]
          ),
          c.query(
            `SELECT source_table, count(*)::int AS n FROM imported_company_keys WHERE client_tag = $1 GROUP BY 1`,
            [table.client_tag]
          ),
          workerState(c),
        ]);
        // A People (pipeline) table's uploads, each with its rows still held (enrich_rows by source and status).
        const isPeople = table.template === PEOPLE_TEMPLATE;
        const uploads = isPeople
          ? await c.query(
              `SELECT s.id, s.kind, s.label, s.received, s.created, s.duplicates, s.skipped, s.created_at, s.external_id AS batch_id,
                      (SELECT count(*)::int FROM enrich_rows r WHERE r.source_id = s.id AND r.run_status = 'held') AS held
                 FROM enrich_sources s WHERE s.table_id = $1 AND s.kind = 'upload' ORDER BY s.created_at DESC LIMIT 10`,
              [id]
            )
          : null;
        const peopleSwitch = isPeople
          ? (await c.query(`SELECT public.fn_enrich_people_switch_on($1) AS on`, [table.client_tag])).rows[0]?.on === true
          : null;
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
          deliveries: deliveries.rows.map(({ location_filter, location_filter_note, skipped_ads, ...d }) => ({
            ...d,
            filter: locationFilterSummary(location_filter, location_filter_note),
            skipped_ads: adsCount(skipped_ads),
          })),
          uploads: uploads?.rows ?? [],
          people_switch: peopleSwitch,
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
