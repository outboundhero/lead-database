import type { PoolClient } from "pg";

// Adds rows to a Clay-tab table: one enrich_sources row for the delivery, one
// enrich_rows row per new company, and a cell per input value, in a single
// statement, inside the caller's transaction. Used by the inbound URLs (Google
// Maps places, migration 129) and the CSV import. A row whose key is already
// in the table is a duplicate and changes nothing; a Maps chunk delivered
// twice is recognised by its id.
//
// Rows are written in key order, so two deliveries that share places, in
// whatever order they list them, take the same locks in the same order and
// can't deadlock.

export interface IncomingRow {
  inputs: Record<string, unknown>;
  /** The client's own Clay results for this row (CSV import), kept for side-by-side checks. */
  reference?: Record<string, string> | null;
}

export interface InsertResult {
  sourceId: string | null;
  duplicateDelivery: boolean;
  received: number;
  created: number;
  duplicates: number;
  skipped: number;
}

/** What a new row starts as: queued (worked by the worker), or held (migration 129: released only while its client is switched on). */
export type InsertRunStatus = "queued" | "held";

const SEARCH_KEYS = ["company", "address", "website", "domain", "place_id", "phone"];
const clean = (v: unknown) => (v == null ? "" : String(v).replace(/\u0000/g, "").trim());

/** The Google place id when there is one; otherwise the name and address. */
export function rowKey(inputs: Record<string, string>): string | null {
  const place = clean(inputs.place_id);
  if (place) return place;
  const name = clean(inputs.company).toLowerCase();
  if (!name) return null;
  return `name:${name}|${clean(inputs.address).toLowerCase()}`;
}

export async function insertRows(
  client: PoolClient,
  opts: {
    tableId: string;
    inputKeys: string[];
    source: { kind: "maps" | "csv" | "demo" | "api"; externalId?: string | null; label?: string | null; meta?: object; createdBy?: string | null };
    rows: IncomingRow[];
    /** The status of the rows this delivery creates. Default queued; an inbound URL's Maps rows are held. */
    runStatus?: InsertRunStatus;
    /** One row's key from its cleaned inputs; null skips the row (counted). Default rowKey() above. */
    rowKey?: (inputs: Record<string, string>) => string | null;
    /** The inbound URL the delivery came through (enrich_sources.inbound_url_id, migration 129). */
    inboundUrlId?: string | null;
  }
): Promise<InsertResult> {
  const runStatus: InsertRunStatus = opts.runStatus ?? "queued";
  if (runStatus !== "queued" && runStatus !== "held") throw new Error(`insertRows: unknown run status "${String(runStatus)}"`);
  const keyOf = opts.rowKey ?? rowKey;
  const allowed = new Set(opts.inputKeys);
  const seen = new Set<string>();
  const batch: { row_key: string; search_text: string; reference: Record<string, string> | null; cells: Record<string, string> }[] = [];
  let skipped = 0;
  let inDelivery = 0;
  for (const r of opts.rows) {
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.inputs ?? {})) {
      if (!allowed.has(k)) continue;
      const c = clean(v);
      if (c) inputs[k] = c.slice(0, 5_000);
    }
    const key = keyOf(inputs);
    if (!key) {
      skipped++;
      continue;
    }
    if (seen.has(key)) {
      inDelivery++;
      continue;
    }
    seen.add(key);
    const reference = r.reference && Object.keys(r.reference).length ? r.reference : null;
    const search_text = SEARCH_KEYS.map((k) => inputs[k]).filter(Boolean).join(" ").toLowerCase().slice(0, 2_000);
    batch.push({ row_key: key, search_text, reference, cells: inputs });
  }
  batch.sort((a, b) => (a.row_key < b.row_key ? -1 : a.row_key > b.row_key ? 1 : 0));

  // inbound_url_id (129) is named only when given, so a CSV import writes what it wrote before 129.
  const viaUrl = opts.inboundUrlId != null;
  const src = await client.query<{ id: string }>(
    `INSERT INTO enrich_sources (table_id, kind, external_id, label, received, skipped, meta, created_by${viaUrl ? ", inbound_url_id" : ""})
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8${viaUrl ? ", $9" : ""})
     ON CONFLICT (table_id, kind, external_id) WHERE external_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      opts.tableId,
      opts.source.kind,
      opts.source.externalId ?? null,
      opts.source.label ?? null,
      opts.rows.length,
      skipped,
      JSON.stringify(opts.source.meta ?? {}),
      opts.source.createdBy ?? null,
      ...(viaUrl ? [opts.inboundUrlId] : []),
    ]
  );
  if (!src.rows.length) {
    // This exact delivery was received before: a retry from the sender.
    return { sourceId: null, duplicateDelivery: true, received: opts.rows.length, created: 0, duplicates: opts.rows.length, skipped: 0 };
  }
  const sourceId = src.rows[0].id;

  let created = 0;
  if (batch.length) {
    const { rows } = await client.query<{ created: number }>(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(row_key text, search_text text, reference jsonb, cells jsonb)
       ),
       ins AS (
         INSERT INTO enrich_rows (table_id, source_id, row_key, search_text, reference, run_status)
         SELECT $1, $2, row_key, search_text, reference, $4 FROM input ORDER BY row_key
         ON CONFLICT (table_id, row_key) DO NOTHING
         RETURNING id, row_key
       ),
       cells AS (
         INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
         SELECT ins.id, kv.key, $1, 'done', to_jsonb(kv.value), left(kv.value, 300)
           FROM ins
           JOIN input USING (row_key)
          CROSS JOIN LATERAL jsonb_each_text(input.cells) AS kv
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM ins)::int AS created`,
      [opts.tableId, sourceId, JSON.stringify(batch), runStatus]
    );
    created = rows[0].created;
  }
  const duplicates = batch.length - created + inDelivery;
  await client.query(`UPDATE enrich_sources SET created = $2, duplicates = $3 WHERE id = $1`, [sourceId, created, duplicates]);
  return { sourceId, duplicateDelivery: false, received: opts.rows.length, created, duplicates, skipped };
}
