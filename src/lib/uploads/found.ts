import type { PoolClient } from "pg";
import {
  ADD_COLUMN,
  FOUND_ROUND_MAX,
  FOUND_SOURCE_LABEL,
  FOUND_TAKE_SQL,
  MOVE_RETRY_MINUTES,
  NOT_SENT_WHY,
  WAIT_WHY,
  foundBatchFilename,
  foundImportLayout,
  foundImportRow,
  foundTags,
  isUsableAddress,
  liveFoundBatch,
  parseUploadRowKey,
} from "../../../scripts/lib/enrich/upload-people.mjs";

// The database side of adding an upload's found emails to leads (migration 130).
//
// The worker copies an upload's no-email rows into the client's People
// (pipeline) table (scripts/lib/enrich/upload-move.mjs). A person whose Outcome
// there is "Approved email" goes to leads through the Uploads page's own import
// (src/lib/uploads/import-rows.ts), with the upload's duplicate rule, its tags
// and its fields, and the found address in its email column.
// src/lib/uploads/found-run.ts runs a round: beginFound() inside one
// transaction that holds the upload's lock, the import after the answer, then
// finishFound(). Each person's add_to_database cell says what happened:
//
//   running {batch_id}                                  a round has them ("Adding…")
//   done    {added: true, lead_id, batch_id}            the round made the lead ("Added")
//   done    {added: false, reason: "lead", lead_id, batch_id}
//                                                       a lead with the address was there, and the
//                                                       upload's rule applied to it ("Already in the database")
//   error   {batch_id}                                  the import could not store them; only the
//                                                       button takes them again ("Not added")
//   done    {added: false, reason: "address", batch_id: null}
//                                                       the found address is not one the import
//                                                       stores; never taken again ("Not added")
//   done    {added: false, reason: "row", batch_id: null}
//                                                       their kept-back row is gone, so there is
//                                                       nothing to import; never taken again ("Not added")
//
// A round is one upload_batches row (source_label "Emails found",
// source_batch_id the upload), listed under its upload on the Uploads page.
// Nothing here logs an address.

/** Anything with pg's query(): a pool, or a client inside a transaction. */
export interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export type Strategy = "skip" | "merge" | "replace";
const STRATEGIES: readonly string[] = ["skip", "merge", "replace"];

/** The upload a round adds found people for, as the round needs it (upload_batches). */
export interface FoundUpload {
  id: string;
  filename: string | null;
  uploaded_by: string | null;
  duplicate_strategy: Strategy;
  field_mapping: Record<string, string> | null;
  source_headers: string[] | null;
  add_tags: string[] | null;
  override_fields: string[] | null;
  status: string;
}

/** One person a round takes: their People row and the found address (trimmed, lower case). */
export interface FoundPerson {
  row_id: number;
  email: string;
}

export type FoundLayout = ReturnType<typeof foundImportLayout>;

// ── Where an upload's no-email rows stand ───────────────────────────────────

/** Where an upload's no-email rows stand (the Uploads page's People column). */
export type PeopleState = "moving" | "moved" | "not_sent" | "undecided" | "before" | "none" | "processing";

/** The facts the state and its words are read from: one upload_batches row and its upload_people row. */
export interface PeopleFacts {
  /** batch_type 'leads', no source label and a field mapping: made by the Uploads page or the folder script. */
  isUpload: boolean;
  /** Its status is complete or error. */
  final: boolean;
  /** It has kept-back rows (upload_holdbacks). */
  hasKept: boolean;
  /** add_tags is recorded (made since 130). */
  tagsKnown: boolean;
  state: "moving" | "moved" | "not_sent" | null;
  reason: string | null;
  clientTag: string | null;
  tableId: string | null;
  sourceId: string | null;
  nextSeq: number;
  movedRows: number;
  keptBack: number;
}

export function peopleStateOf(f: PeopleFacts): PeopleState {
  if (!f.isUpload) return "none";
  if (f.state) return f.state;
  if (!f.final) return "processing";
  if (!f.hasKept) return "none";
  return f.tagsKnown ? "undecided" : "before";
}

/** The rows were copied into a People table that has since been deleted (its source row went with it). */
export const peopleTableGone = (f: PeopleFacts) =>
  (f.state === "moving" || f.state === "moved") && f.nextSeq > 0 && (!f.tableId || !f.sourceId);

/** Found people can be added: the rows are (being) copied, into a table and a source row that still exist. */
export const peopleReady = (f: PeopleFacts) => (f.state === "moving" || f.state === "moved") && Boolean(f.tableId && f.sourceId);

const SEND_HINT = "An admin can send them to a client's People table.";
const fmt = (n: number) => n.toLocaleString("en-US");
const words = (map: Readonly<Record<string, string>>, key: string | null) => (key && Object.hasOwn(map, key) ? map[key] : null);

/** Where the upload's no-email rows stand, in plain words; null when there is nothing to say. */
export function peopleWhy(f: PeopleFacts): string | null {
  const tag = f.clientTag ?? "the client";
  switch (peopleStateOf(f)) {
    case "none":
      return f.isUpload ? "This upload had no rows without an email." : null;
    case "processing":
      return "This upload is still being imported. Its no-email rows go to a People table once it has finished.";
    case "before":
      return `This upload was made before uploads recorded their tags, so its no-email rows were not sent to a People table. ${SEND_HINT}`;
    case "undecided":
      return "The worker sends this upload's no-email rows to its client's People table within a minute of the upload finishing.";
    case "not_sent":
      return `${words(NOT_SENT_WHY, f.reason) ?? "The upload names no single client."} ${SEND_HINT}`;
    case "moving": {
      if (peopleTableGone(f)) return `${tag}'s People table was deleted. The worker copies the rows it had not copied yet into a new one.`;
      const wait = words(WAIT_WHY, f.reason);
      if (wait) return `${wait} The worker tries again every ${MOVE_RETRY_MINUTES} minutes.`;
      return f.nextSeq > 0
        ? `Being copied into ${tag}'s People table: ${fmt(f.movedRows)} of ${fmt(f.keptBack)} rows so far.`
        : `The worker is copying this upload's no-email rows into ${tag}'s People table.`;
    }
    case "moved":
      return peopleTableGone(f) ? `${tag}'s People table was deleted, so this upload's found people can't be added any more.` : `In ${tag}'s People table.`;
  }
}

/** Why a round can't start for this upload, or null when it can. */
function notReadyWhy(f: PeopleFacts): string | null {
  if (peopleReady(f)) return null;
  const state = peopleStateOf(f);
  if (state === "none" && !f.isUpload) return "Only an upload's no-email rows go to a People table, and this batch is not an upload.";
  if (state === "moving" && !peopleTableGone(f)) {
    return `Nothing to add yet: the worker has not copied this upload's no-email rows into ${f.clientTag ?? "the client"}'s People table.`;
  }
  return peopleWhy(f) ?? "This upload's no-email rows are not in a People table.";
}

// ── A round ─────────────────────────────────────────────────────────────────

const UPLOAD_SQL = `
  SELECT b.id, b.filename, b.uploaded_by, b.duplicate_strategy, b.field_mapping, b.source_headers, b.add_tags, b.override_fields, b.status,
         (b.batch_type = 'leads' AND b.source_label IS NULL AND b.field_mapping IS NOT NULL) AS is_upload,
         b.no_email_rows,
         EXISTS (SELECT 1 FROM upload_holdbacks h WHERE h.batch_id = b.id) AS has_kept,
         p.state, p.reason, p.client_tag, p.table_id, p.source_id, p.next_seq, p.moved_rows
    FROM upload_batches b
    LEFT JOIN upload_people p ON p.batch_id = b.id
   WHERE b.id = $1`;

/** The facts of one row of UPLOAD_SQL (or of any query with its columns). */
export function factsOf(r: Record<string, unknown>): PeopleFacts {
  return {
    isUpload: r.is_upload === true,
    final: r.status === "complete" || r.status === "error",
    hasKept: r.has_kept === true,
    tagsKnown: Array.isArray(r.add_tags),
    state: r.state === "moving" || r.state === "moved" || r.state === "not_sent" ? r.state : null,
    reason: typeof r.reason === "string" ? r.reason : null,
    clientTag: typeof r.client_tag === "string" ? r.client_tag : null,
    tableId: typeof r.table_id === "string" ? r.table_id : null,
    sourceId: typeof r.source_id === "string" ? r.source_id : null,
    nextSeq: Number(r.next_seq ?? 0),
    movedRows: Number(r.moved_rows ?? 0),
    keptBack: Number(r.kept_back ?? r.no_email_rows ?? 0),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stringsOr = (v: unknown, fallback: string[] | null): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fallback;

type CellWrite = { row_id: number; status: "done" | "error" | "running"; value: Record<string, unknown>; display: string; note: string | null };

/**
 * Writes add_to_database cells, never over a cell that is done: a round that
 * finished meanwhile has settled that person for good. Returns the row ids
 * written. Only rows that still exist are written.
 */
async function writeAddCells(c: Queryable, tableId: string, cells: CellWrite[]): Promise<number[]> {
  if (!cells.length) return [];
  const { rows } = await c.query(
    `INSERT INTO enrich_cells AS c (row_id, column_key, table_id, status, value, display, note, updated_at)
     SELECT x.row_id, $2, $3, x.status, x.value, x.display, x.note, now()
       FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, status text, value jsonb, display text, note text)
       JOIN enrich_rows r ON r.id = x.row_id
     ON CONFLICT (row_id, column_key) DO UPDATE
        SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, note = EXCLUDED.note, updated_at = now()
      WHERE c.status IS DISTINCT FROM 'done'
     RETURNING c.row_id`,
    [JSON.stringify(cells), ADD_COLUMN, tableId]
  );
  return rows.map((r) => Number(r.row_id));
}

const NOT_STORED_ADDRESS =
  "The address found for this person is not one the import can store as an email, so they were not added. They are not taken again.";
const NOT_STORED_ROW = "This person's row of the upload is gone, so there is nothing to add them with. They are not taken again.";
const ADDED_NOTE = "Added to the lead database by the upload's own import: the upload's fields and tags, with the address found here.";
const RULE_WORDS: Record<Strategy, string> = {
  skip: "skip: it was left as it was",
  merge: "merge: its blank fields were filled",
  replace: "replace: the upload's chosen fields were written over it",
};

export type BeginFound =
  | { busy: true }
  | {
      busy: false;
      /** Why no round can start for this upload, in plain words. */
      notReady?: string;
      /** The round's batch (upload_batches), or null when nobody was taken. */
      batchId: string | null;
      /** The round's created_at as Postgres prints it (microseconds kept). */
      batchAt: string | null;
      /** The round's file name ("Emails found · <file> · <time> UTC"). */
      filename: string | null;
      /** Each person's import row, in the layout's columns. */
      rows: string[][];
      people: FoundPerson[];
      /** People settled without the import: an address the import can't store, a missing row, or added by a round that died. */
      settled: number;
      layout: FoundLayout | null;
      upload: FoundUpload;
      clientTag: string;
      /** The client's People (pipeline) table the people are in (upload_people.table_id). */
      tableId: string | null;
    };

/**
 * Starts a round of one upload, inside the caller's transaction (which holds
 * the upload's lock). Busy while a round of this upload is live. Takes the
 * People rows with an approved email still to add (FOUND_TAKE_SQL, at most
 * FOUND_ROUND_MAX; retryErrors also takes the people a round could not store).
 * Settles at once: an address the import can't store, a person whose kept-back
 * row is gone, and a person a dead round left running whose lead that round
 * made (its 'created' history line is not older than the round). Then makes
 * the round's batch with the upload's rule, its tags (and the client's) and
 * its replace fields, and marks each person's cell running. Throws when the
 * upload does not exist (the caller checks first).
 */
export async function beginFound(
  c: PoolClient,
  { batchId, userId, retryErrors }: { batchId: string; userId: string | null; retryErrors: boolean }
): Promise<BeginFound> {
  const { rows: [u] } = await c.query(UPLOAD_SQL, [batchId]);
  if (!u) throw new Error("No such upload");
  const facts = factsOf(u);
  const upload: FoundUpload = {
    id: String(u.id),
    filename: (u.filename as string | null) ?? null,
    uploaded_by: (u.uploaded_by as string | null) ?? null,
    duplicate_strategy: (STRATEGIES.includes(String(u.duplicate_strategy)) ? u.duplicate_strategy : "skip") as Strategy,
    field_mapping: (u.field_mapping as Record<string, string> | null) ?? null,
    source_headers: stringsOr(u.source_headers, null),
    add_tags: stringsOr(u.add_tags, null),
    override_fields: stringsOr(u.override_fields, null),
    status: String(u.status),
  };
  const clientTag = facts.clientTag ?? "";
  const none = {
    busy: false as const, batchId: null, batchAt: null, filename: null, rows: [], people: [], settled: 0, layout: null, upload, clientTag,
    tableId: facts.tableId,
  };
  const notReady = notReadyWhy(facts);
  if (notReady) return { ...none, notReady };
  const tableId = facts.tableId!;

  const { rows: live } = await c.query(
    `SELECT 1 FROM upload_batches b WHERE b.source_batch_id = $1 AND ${liveFoundBatch("b")} LIMIT 1`,
    [batchId]
  );
  if (live.length) return { busy: true };

  const { rows: taken } = await c.query(FOUND_TAKE_SQL, [tableId, facts.sourceId, FOUND_ROUND_MAX, retryErrors]);
  if (!taken.length) return none;

  const settle: CellWrite[] = [];
  const candidates: Array<FoundPerson & { seq: number; deadRound: string | null }> = [];
  for (const t of taken) {
    const row_id = Number(t.row_id);
    const email = String(t.email ?? "");
    const key = parseUploadRowKey(String(t.row_key ?? ""));
    if (!isUsableAddress(email)) {
      settle.push({ row_id, status: "done", value: { added: false, reason: "address", batch_id: null }, display: "Not added", note: NOT_STORED_ADDRESS });
    } else if (!key || key.batchId !== batchId.toLowerCase()) {
      settle.push({ row_id, status: "done", value: { added: false, reason: "row", batch_id: null }, display: "Not added", note: NOT_STORED_ROW });
    } else {
      const dead = t.add_status === "running" && typeof t.add_batch === "string" && UUID.test(t.add_batch) ? t.add_batch : null;
      candidates.push({ row_id, email, seq: key.seq, deadRound: dead });
    }
  }

  // A dead round's people whose lead that round made: settled as its own, not imported again.
  const dead = candidates.filter((p) => p.deadRound);
  const addedByDead = new Map<number, { lead_id: string; batch_id: string }>();
  if (dead.length) {
    const { rows } = await c.query(
      `SELECT x.row_id, l.id AS lead_id, x.batch_id
         FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, email text, batch_id uuid)
         JOIN upload_batches b ON b.id = x.batch_id
         JOIN leads l ON l.email = x.email
        WHERE EXISTS (SELECT 1 FROM lead_history h
                       WHERE h.lead_id = l.id AND h.event_type = 'created' AND h.created_at >= b.created_at)`,
      [JSON.stringify(dead.map((p) => ({ row_id: p.row_id, email: p.email, batch_id: p.deadRound })))]
    );
    for (const r of rows) addedByDead.set(Number(r.row_id), { lead_id: String(r.lead_id), batch_id: String(r.batch_id) });
  }
  for (const [row_id, a] of addedByDead) {
    settle.push({
      row_id,
      status: "done",
      value: { added: true, lead_id: a.lead_id, batch_id: a.batch_id },
      display: "Added",
      note: ADDED_NOTE,
    });
  }

  // Each person's kept-back row, by its seq.
  const wanted = candidates.filter((p) => !addedByDead.has(p.row_id));
  const raws = new Map<number, unknown[]>();
  if (wanted.length) {
    const { rows } = await c.query(`SELECT seq, raw FROM upload_holdbacks WHERE batch_id = $1 AND seq = ANY($2::int[])`, [
      batchId,
      [...new Set(wanted.map((p) => p.seq))],
    ]);
    for (const r of rows) raws.set(Number(r.seq), Array.isArray(r.raw) ? r.raw : []);
  }
  const toAdd: Array<FoundPerson & { seq: number }> = [];
  for (const p of wanted) {
    if (raws.has(p.seq)) toAdd.push(p);
    else settle.push({ row_id: p.row_id, status: "done", value: { added: false, reason: "row", batch_id: null }, display: "Not added", note: NOT_STORED_ROW });
  }
  const settled = (await writeAddCells(c, tableId, settle)).length;
  if (!toAdd.length) return { ...none, settled };

  // The round: the upload's rule, its tags (the client's added), its replace fields.
  const filename = foundBatchFilename(upload.filename ?? "");
  const layout = foundImportLayout(upload.source_headers, upload.field_mapping);
  const { rows: [batch] } = await c.query(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, duplicate_strategy, field_mapping, source_headers,
                                 batch_type, source_label, add_tags, override_fields, source_batch_id)
     VALUES ($1, $2, $3, 'processing', $4, $5::jsonb, $6::jsonb, 'leads', $7, $8::text[], $9::text[], $10)
     RETURNING id, created_at::text AS created_at`,
    [
      userId ?? upload.uploaded_by,
      filename,
      toAdd.length,
      upload.duplicate_strategy,
      JSON.stringify(layout.fieldMapping),
      JSON.stringify(layout.headers),
      FOUND_SOURCE_LABEL,
      foundTags(upload.add_tags, clientTag),
      upload.override_fields ?? [],
      batchId,
    ]
  );
  const roundId = String(batch.id);
  const marked = new Set(
    await writeAddCells(
      c,
      tableId,
      toAdd.map((p) => ({ row_id: p.row_id, status: "running", value: { batch_id: roundId }, display: "Adding…", note: null }))
    )
  );
  const people = toAdd.filter((p) => marked.has(p.row_id));
  if (!people.length) {
    // Everyone was settled by a round that finished meanwhile: no round after all.
    await c.query(`DELETE FROM upload_batches WHERE id = $1`, [roundId]);
    return { ...none, settled };
  }
  if (people.length < toAdd.length) await c.query(`UPDATE upload_batches SET total_rows = $2 WHERE id = $1`, [roundId, people.length]);
  return {
    busy: false,
    batchId: roundId,
    batchAt: String(batch.created_at),
    filename,
    rows: people.map((p) => foundImportRow(layout, raws.get(p.seq) ?? [], p.email)),
    people: people.map(({ row_id, email }) => ({ row_id, email })),
    settled,
    layout,
    upload,
    clientTag,
    tableId,
  };
}

/**
 * Settles each person a round took, from what the database holds after the
 * import: a lead with the address whose 'created' history line is at or after
 * the round began is this round's ("Added"); another lead was there first, and
 * the upload's rule applied to it ("Already in the database"); no lead means
 * the import could not store them ("Not added", an error the button takes
 * again). The 'created' line, not created_at: an upload may map a Created
 * Date column. Only cells still running for this round are written.
 */
export async function finishFound(
  db: Queryable,
  { tableId, batchId, batchAt, strategy, people }: { tableId: string; batchId: string; batchAt: string; strategy: string; people: FoundPerson[] }
): Promise<void> {
  if (!people.length) return;
  const rule = RULE_WORDS[(STRATEGIES.includes(strategy) ? strategy : "skip") as Strategy];
  await db.query(
    `WITH m AS (
       SELECT x.row_id, l.id AS lead_id,
              EXISTS (SELECT 1 FROM lead_history h
                       WHERE h.lead_id = l.id AND h.event_type = 'created' AND h.created_at >= $4::timestamptz) AS mine
         FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, email text)
         JOIN enrich_rows r ON r.id = x.row_id
         LEFT JOIN leads l ON l.email = x.email
     )
     INSERT INTO enrich_cells AS c (row_id, column_key, table_id, status, value, display, note, updated_at)
     SELECT m.row_id, $2, $3,
            CASE WHEN m.lead_id IS NULL THEN 'error' ELSE 'done' END,
            CASE WHEN m.lead_id IS NULL THEN jsonb_build_object('batch_id', $5::text)
                 WHEN m.mine THEN jsonb_build_object('added', true, 'lead_id', m.lead_id, 'batch_id', $5::text)
                 ELSE jsonb_build_object('added', false, 'reason', 'lead', 'lead_id', m.lead_id, 'batch_id', $5::text) END,
            CASE WHEN m.lead_id IS NULL THEN 'Not added' WHEN m.mine THEN 'Added' ELSE 'Already in the database' END,
            CASE WHEN m.lead_id IS NULL THEN $6
                 WHEN m.mine THEN $7
                 ELSE $8 END,
            now()
       FROM m
     ON CONFLICT (row_id, column_key) DO UPDATE
        SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, note = EXCLUDED.note, updated_at = now()
      WHERE c.status = 'running' AND c.value->>'batch_id' = $5`,
    [
      JSON.stringify(people),
      ADD_COLUMN,
      tableId,
      batchAt,
      batchId,
      "The import could not store this person (the round's errors on the Uploads page say why). Add the found emails on the Uploads page to try again.",
      ADDED_NOTE,
      `A lead with this address was in the database already, so the upload's rule for duplicates applied to it (${rule}).`,
    ]
  );
}
