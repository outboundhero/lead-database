// An upload's no-email rows into the client's People table (migration 130).
//
// Once a minute, in the worker's 60-second block, moveUploadRows() does two
// things. Neither costs anything, queues a row, calls a provider or writes
// leads.
//
//  1. Decide. A finished upload (complete or error) that kept rows back and
//     records its tags (upload_batches.add_tags, written since 130) gets its
//     upload_people row: moving, with the one client tag among its tags, or
//     not_sent with the reason (no tag, no client tag, or more than one). An
//     upload made before 130 records no tags and is never decided here: an
//     admin sends it by hand on the Uploads page.
//  2. Move. The kept-back rows of a moving upload go into the client's People
//     (pipeline) table as held rows, keyed "upload:<batch id>:<seq>", with
//     their People inputs (uploadPeopleInputs) and the upload's source row
//     (kind upload, "Upload: <file>"). One transaction a chunk of MOVE_CHUNK
//     rows, at most MOVE_MAX_CHUNKS a round. upload_people.next_seq marks how
//     far the copy got, so a row an admin deleted from the table is never put
//     back, and a repeat inserts nothing (ON CONFLICT on the row key).
//
// The client's three pipeline tables are made or brought up to date once a
// round per client, before any of its rows go in, under the per-client lock
// and in a savepoint: the upload gates (people-template.mjs) must be in the
// People table's columns before an upload row is worked. When they can't be
// made now (the Clay originals not loaded, or a retired companies_v1 table),
// the upload stays moving with the reason (WAIT_WHY) and is tried again after
// MOVE_RETRY_MINUTES; nothing is copied meanwhile.
//
// The rows wait, held and free, until releaseHeldPeopleRows() (held.mjs)
// releases them under the people_pipeline switch.

import { OriginalsMissing } from "./compile-original.mjs";
import { ensurePipelineTables, lockPipelineTables, PIPELINE_TEMPLATES, RetiredV1Table } from "./templates.mjs";
import {
  MOVE_CHUNK, MOVE_MAX_CHUNKS, MOVE_RETRY_MINUTES, peopleSearchText, routeTagOf, UPLOAD_SOURCE_KIND, uploadPeopleInputs, uploadRowKey,
  uploadSourceLabel,
} from "./upload-people.mjs";

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {Db & { connect: () => Promise<Db & { release: () => void }> }} Pool
 */

/** Uploads decided at most per round. */
export const DECIDE_MAX = 50;

/** The reason (upload_people.reason, WAIT_WHY) for each refusal of ensurePipelineTables(). */
export function tablesRefusalReason(e) {
  const name = /** @type {{ name?: unknown } | null} */ (e)?.name;
  if (e instanceof OriginalsMissing || name === "OriginalsMissing") return "originals_missing";
  if (e instanceof RetiredV1Table || name === "RetiredV1Table") return "retired_v1";
  return null;
}

// Finished uploads with kept-back rows that record their tags and have no
// upload_people row yet, oldest first.
const UNDECIDED = `
  SELECT b.id, b.add_tags
    FROM upload_batches b
   WHERE b.batch_type = 'leads' AND b.source_label IS NULL AND b.field_mapping IS NOT NULL AND b.add_tags IS NOT NULL
     AND b.status IN ('complete', 'error')
     AND EXISTS (SELECT 1 FROM upload_holdbacks h WHERE h.batch_id = b.id)
     AND NOT EXISTS (SELECT 1 FROM upload_people p WHERE p.batch_id = b.id)
   ORDER BY b.created_at, b.id
   LIMIT $1`;

const DECIDE = `
  INSERT INTO upload_people (batch_id, state, reason, client_tag) VALUES ($1, $2, $3, $4)
  ON CONFLICT (batch_id) DO NOTHING`;

// The moving uploads whose turn it is, oldest first (upload_people_moving_idx).
const DUE = `
  SELECT batch_id FROM upload_people
   WHERE state = 'moving' AND next_try_at <= now()
   ORDER BY next_try_at, batch_id
   LIMIT $1`;

// One moving upload, locked for its chunk; another worker's chunk is skipped, not waited for.
const LOCK = `
  SELECT p.batch_id, p.client_tag, p.next_seq, b.filename, b.uploaded_by, b.field_mapping
    FROM upload_people p
    JOIN upload_batches b ON b.id = p.batch_id
   WHERE p.batch_id = $1 AND p.state = 'moving' AND p.next_try_at <= now()
     FOR UPDATE OF p SKIP LOCKED`;

// The client's People (pipeline) table and its input columns.
const PEOPLE_TABLE = `
  SELECT t.id, coalesce(array_agg(k.key) FILTER (WHERE k.key IS NOT NULL), '{}') AS keys
    FROM enrich_tables t
    LEFT JOIN enrich_columns k ON k.table_id = t.id AND k.kind = 'input'
   WHERE t.client_tag = $1 AND t.kind = $2 AND t.template = $3
   GROUP BY t.id`;

const SOURCE = `
  INSERT INTO enrich_sources (table_id, kind, external_id, label, created_by, meta)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  ON CONFLICT (table_id, kind, external_id) WHERE external_id IS NOT NULL DO UPDATE SET label = EXCLUDED.label
  RETURNING id`;

const KEPT_BACK = `
  SELECT seq, raw FROM upload_holdbacks WHERE batch_id = $1 AND seq >= $2 ORDER BY seq LIMIT $3`;

// The chunk's rows, held, with their input cells, in seq order; a row already
// in the table (its key) is left as it is (WRITE_ROWS' shape, pipeline-actions.mjs).
const WRITE_HELD = `
  WITH x AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(seq int, row_key text, search text, cells jsonb)),
  r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text, run_status)
    SELECT $1::uuid, $2::uuid, x.row_key, coalesce(x.search, ''), 'held' FROM x ORDER BY x.seq
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id, row_key
  ),
  c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $1::uuid, 'done', to_jsonb(kv.value), left(kv.value, 300)
      FROM r JOIN x ON x.row_key = r.row_key CROSS JOIN LATERAL jsonb_each_text(x.cells) AS kv
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM r)::int AS created, (SELECT count(*) FROM c)::int AS cells`;

const COUNT_SOURCE = `
  UPDATE enrich_sources SET received = received + $2, created = created + $3, duplicates = duplicates + $4 WHERE id = $1`;

const PROGRESS = `
  UPDATE upload_people p
     SET next_seq = $2, moved_rows = p.moved_rows + $3, table_id = $4, source_id = $5, reason = NULL, updated_at = now(),
         state = CASE WHEN EXISTS (SELECT 1 FROM upload_holdbacks h WHERE h.batch_id = p.batch_id AND h.seq >= $2) THEN 'moving' ELSE 'moved' END,
         moved_at = CASE WHEN EXISTS (SELECT 1 FROM upload_holdbacks h WHERE h.batch_id = p.batch_id AND h.seq >= $2) THEN p.moved_at ELSE now() END
   WHERE p.batch_id = $1
  RETURNING p.state`;

const WAIT = `
  UPDATE upload_people SET reason = $2, next_try_at = now() + make_interval(mins => $3), updated_at = now()
   WHERE batch_id = $1 AND state = 'moving'`;

/**
 * Decides where the no-email rows of up to DECIDE_MAX finished uploads go:
 * moving to the one client tag among the upload's tags, or not_sent with why.
 *
 * @param {Db} db
 * @param {{ log?: (line: string) => void }} [opts]
 * @returns {Promise<{ decided: number, notSent: number }>}
 */
export async function decideUploads(db, { log = () => {} } = {}) {
  const { rows: batches } = await db.query(UNDECIDED, [DECIDE_MAX]);
  if (!batches.length) return { decided: 0, notSent: 0 };
  const { rows: clients } = await db.query(`SELECT tag FROM client_tags`);
  const known = clients.map((c) => c.tag);
  let decided = 0;
  let notSent = 0;
  for (const b of batches) {
    const { tag, why } = routeTagOf(b.add_tags, known);
    try {
      const { rowCount } = await db.query(DECIDE, [b.id, tag ? "moving" : "not_sent", tag ? null : why, tag]);
      if (rowCount) {
        decided++;
        if (!tag) notSent++;
      }
    } catch (e) {
      // 23503: the upload was deleted meanwhile. Anything else is logged and the
      // upload is asked about again next round; the others are decided now.
      if (/** @type {{ code?: string }} */ (e)?.code !== "23503") log(`upload ${b.id}: its no-email rows could not be sent anywhere: ${/** @type {Error} */ (e).message}`);
    }
  }
  return { decided, notSent };
}

/** The client's People table and its input keys, made or brought up to date first when `ensure` (under the lock, in a savepoint). */
async function peopleTableFor(c, tag, { ensure, settings }) {
  const t = PIPELINE_TEMPLATES.people;
  if (ensure) {
    await lockPipelineTables(c, tag);
    await c.query("SAVEPOINT upload_people_tables");
    try {
      await ensurePipelineTables(c, tag, { settings });
      await c.query("RELEASE SAVEPOINT upload_people_tables");
    } catch (e) {
      const reason = tablesRefusalReason(e);
      if (!reason) throw e;
      await c.query("ROLLBACK TO SAVEPOINT upload_people_tables");
      return { refused: reason };
    }
  }
  const { rows: [table] } = await c.query(PEOPLE_TABLE, [tag, t.kind, t.template]);
  return table ? { id: table.id, keys: new Set(table.keys) } : null;
}

/**
 * One chunk of one moving upload, in one transaction.
 *
 * @returns {Promise<{ skipped?: true, waiting?: string, created?: number, read?: number, done?: boolean }>}
 */
async function moveChunk(pool, batchId, { size, settings, round }) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout = '60s'");
    const { rows: [p] } = await c.query(LOCK, [batchId]);
    if (!p) {
      await c.query("ROLLBACK");
      return { skipped: true };
    }
    const tag = p.client_tag;
    let table = round.refused.has(tag)
      ? { refused: round.refused.get(tag) }
      : await peopleTableFor(c, tag, { ensure: !round.ensured.has(tag), settings });
    if (!table?.refused && !table?.id) table = await peopleTableFor(c, tag, { ensure: true, settings }); // deleted since this round made it
    if (table?.refused) {
      round.refused.set(tag, table.refused);
      await c.query(WAIT, [batchId, table.refused, MOVE_RETRY_MINUTES]);
      await c.query("COMMIT");
      return { waiting: table.refused };
    }
    if (!table?.id) throw new Error(`${tag} has no People (pipeline) table after it was made`);
    round.ensured.add(tag);
    const { rows: [source] } = await c.query(SOURCE, [
      table.id, UPLOAD_SOURCE_KIND, String(batchId), uploadSourceLabel(p.filename), p.uploaded_by ?? null, JSON.stringify({ batch_id: batchId }),
    ]);
    const { rows: kept } = await c.query(KEPT_BACK, [batchId, p.next_seq, size]);
    let created = 0;
    if (kept.length) {
      const payload = kept.map((h) => {
        const all = uploadPeopleInputs({ raw: h.raw, fieldMapping: p.field_mapping, clientTag: tag, filename: p.filename });
        const cells = Object.fromEntries(Object.entries(all).filter(([k]) => table.keys.has(k)));
        return { seq: h.seq, row_key: uploadRowKey(batchId, h.seq), search: peopleSearchText(cells), cells };
      });
      ({ created } = (await c.query(WRITE_HELD, [table.id, source.id, JSON.stringify(payload)])).rows[0]);
      await c.query(COUNT_SOURCE, [source.id, kept.length, created, kept.length - created]);
    }
    const next = kept.length ? Number(kept[kept.length - 1].seq) + 1 : Number(p.next_seq);
    const { rows: [after] } = await c.query(PROGRESS, [batchId, next, created, table.id, source.id]);
    await c.query("COMMIT");
    return { created, read: kept.length, done: after?.state === "moved" };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * The worker's minute of moving: decide the uploads not decided yet, then copy
 * the kept-back rows of the moving ones into their clients' People tables as
 * held rows, at most maxChunks chunks of `chunk` rows in all. An upload whose
 * chunk failed for any other reason is logged and tried again after
 * MOVE_RETRY_MINUTES, so it never holds up the others.
 *
 * @param {Pool} db  a pool
 * @param {{ settings?: import("./settings.mjs").PipelineSettings | null, chunk?: number, maxChunks?: number,
 *           log?: (line: string) => void }} [opts]  MOVE_CHUNK, MOVE_MAX_CHUNKS
 * @returns {Promise<{ decided: number, notSent: number, moved: number, batches: number, waiting: number }>}
 *   decided: uploads given their upload_people row now (notSent of them not sent); moved: People rows made;
 *   batches: uploads whose rows went in this round; waiting: uploads whose client's tables can't be made now
 */
export async function moveUploadRows(db, { settings = null, chunk = MOVE_CHUNK, maxChunks = MOVE_MAX_CHUNKS, log = () => {} } = {}) {
  const size = Math.max(1, Math.min(10_000, Math.trunc(Number(chunk)) || MOVE_CHUNK));
  const budget = Math.max(1, Math.trunc(Number(maxChunks)) || MOVE_MAX_CHUNKS);
  const { decided, notSent } = await decideUploads(db, { log });
  let moved = 0;
  let waiting = 0;
  let chunks = 0;
  const touched = new Set();
  /** This round's clients: those whose tables were made or brought up to date, and those whose tables can't be made now (why). */
  const round = { ensured: new Set(), refused: new Map() };
  const { rows: due } = await db.query(DUE, [budget]);
  for (const { batch_id: batchId } of due) {
    while (chunks < budget) {
      chunks++;
      let r;
      try {
        r = await moveChunk(db, batchId, { size, settings, round });
      } catch (e) {
        log(`upload ${batchId}: its no-email rows were not copied this time (${/** @type {Error} */ (e).message}); tried again in ${MOVE_RETRY_MINUTES} minutes`);
        await db.query(WAIT, [batchId, null, MOVE_RETRY_MINUTES]).catch(() => {});
        break;
      }
      if (r.skipped) {
        chunks--; // another worker has it: nothing was done here
        break;
      }
      if (r.waiting) {
        waiting++;
        break;
      }
      moved += r.created ?? 0;
      if (r.read) touched.add(batchId);
      if (r.done) break;
    }
    if (chunks >= budget) break;
  }
  return { decided, notSent, moved, batches: touched.size, waiting };
}
