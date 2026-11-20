// AI Ark tab pulls: the people with no email go to the email finders
// (2026-11-21), as an upload's no-email rows do (migration 130). A pull's
// person whose Outcome is "No email" passed every check (not held, inside the
// client's area, clear of its rules) and has no usable address. Once the
// client is on People runs, the worker copies each such person into the
// client's People (pipeline) table, where the email finders and Enrichley look
// for the address; an approved one comes back to the pull's row, which is
// worked again and added to the database by the AI Ark add (button, or
// automatic with the auto-add variables). No migration: the copy uses
// enrich_rows, enrich_cells, an enrich_sources row of kind ai_ark and
// aiark_runs.progress.
//
// Two steps, both in the worker's 60-second block, neither of which pays,
// queues a row or writes a lead:
//
//  1. The copy (copyPullNoEmail), right after the uploads' move. Runs: live,
//     finished (any status, cancelled ones too), with a table, whose client
//     is on People runs (fn_enrich_people_switch_on, migration 130: the
//     database's own reading of the switch that also releases held People
//     rows), no row of its table queued or running, not claimed by the run
//     engine, and not done copying; oldest finished first. So nothing is
//     copied, and no table is made, for a client that is off. One run at a
//     time (FOR UPDATE SKIP LOCKED on its aiark_runs row), one chunk a
//     transaction: the client's pipeline tables made or brought up to date
//     first (under the per-client lock, in a savepoint, as upload-move.mjs
//     does), then up to `chunk` of the pull's rows in id order whose Outcome
//     is "No email" and which have no find_email cell. Each goes in held,
//     keyed by the person (aiarkPersonRowKey), with the People inputs
//     pullPeopleInputs gives and one source row per run and People table
//     (kind ai_ark, external_id "pull:<run id>"). A person whose key is taken
//     (another run bought them) is not copied again: that row is followed.
//     The pull row's find_email cell (a phase 3 column the engine never
//     works) records where the person went, so a row deleted from the People
//     table is never put back and a repeat copies nothing.
//  2. The hand-back (handBackFound), right after the People release. For the
//     runs with People rows still open (progress.no_email.open), each pull
//     row whose find_email cell is "sent" is joined to its People row: gone,
//     it is "Removed from the People table"; done with "Approved email" and
//     an address traced to its finder or Enrichley (personVerdict), the
//     address goes to the pull's row through emailFound() with who found it,
//     the validation status that gives and the People row's question; done
//     with any other Outcome, the pull row's search is closed with that
//     Outcome. Rows still held, queued, running, waiting or in error are left
//     for a later minute.
//
// progress.no_email (written with jsonb_set, only on a finished run: the run
// engine writes progress only while it holds its claim):
//   { state: "copying" | "done" | "waiting", reason?, next_try_at?, copied, already, open, at }
// waiting: the client's tables can't be made now (originals_missing,
// retired_v1) or a chunk failed (failed); tried again after
// MOVE_RETRY_MINUTES.
//
// The pull row's find_email cell (value):
//   done  { state: "sent", people_table_id, people_row_id, at }   "Sent to the People table" / "In the People table already"
//   done  { state: "found", ..., email, found_by, approved_by, status }   "Found by <vendor>" / "Approved by <vendor>"
//   done  { state: "closed", ..., outcome }                        "People table: <Outcome>", "The pull's row changed"
//   done  { state: "gone", ... }                                   "Removed from the People table"
//   empty { state: "no_id" }                                       "No AI Ark id": never copied

import { bareDomain } from "./domain.mjs";
import { normTag } from "./settings.mjs";
import { aiarkPersonRowKey } from "./people-template.mjs";
import { ensurePipelineTables, lockPipelineTables, PIPELINE_TEMPLATES } from "./templates.mjs";
import { tablesRefusalReason } from "./upload-move.mjs";
import { ADD_COLUMN, APPROVED_OUTCOME, MOVE_CHUNK, MOVE_MAX_CHUNKS, MOVE_RETRY_MINUTES } from "./upload-people.mjs";
import { personVerdict, VERDICT_CELLS, vendorName, verdictSource } from "./email-verdict.mjs";
import { emailFound } from "../aiark/add.mjs";
import { LEASE_MIN } from "../aiark/runs.mjs";

/** The worker's heartbeat capability: it copies AI Ark pulls' people with no email and hands found addresses back. */
export const PULL_NO_EMAIL_CAPABILITY = "pull_no_email";
/** The pull table's column whose cell says where a person with no email went (columns.mjs; phase 3, never worked by the engine). */
export const FIND_EMAIL_COLUMN = "find_email";
/** The pull's Outcome that sends a person to the People table (columns.mjs). */
export const PULL_NO_EMAIL_OUTCOME = "No email";
/** found_by and stage of a pull's person in the People table (PEOPLE_INPUTS). */
export const PULL_FOUND_BY = "aiark";
export const PULL_STAGE = "no_email";
/** The pull row's cells a copy reads (RUN_COLUMNS inputs). */
export const PULL_CELLS = Object.freeze([
  "full_name", "first_name", "last_name", "title", "seniority", "department", "company", "domain", "city", "state", "country",
  "linkedin", "aiark_id", "email_status", "email_domain_type", "pulled_before",
]);
const SOURCE_KIND = "ai_ark";
const SENT_NOTE = "Copied to the client's People (pipeline) table, where the email finders look for an address.";
const FOLLOWED_NOTE =
  "The person was in the client's People (pipeline) table already (another run put them there): that row is followed, and an address found there comes back here.";

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {Db & { connect: () => Promise<Db & { release: () => void }> }} Pool
 */

const text = (v) => (v == null || typeof v === "object" ? "" : String(v).replace(/\u0000/g, "").replace(/\s+/g, " ").trim().slice(0, 5000));

/**
 * The Source a copied person's People row shows (and its source row's label):
 * "AI Ark pull <the pull's UTC day>: no email". The cell panel tells such a
 * held row by its start, "AI Ark pull".
 *
 * @param {{ created_at?: Date | string | null } | null | undefined} run
 */
export function pullSourceLabel(run) {
  const at = run?.created_at instanceof Date ? run.created_at : new Date(String(run?.created_at ?? ""));
  return Number.isNaN(at.getTime()) ? "AI Ark pull: no email" : `AI Ark pull ${at.toISOString().slice(0, 10)}: no email`;
}

/**
 * A pull row's person as the input cells of a People row: the person source
 * object P#1's place holds (as sourceObject() builds it from AI Ark's record),
 * the client's tag, the company's domain as its website, the person's place
 * as the written city and state (D13), their AI Ark facts, found_by "aiark",
 * stage "no_email" and the Source. No company row and no email: the finders
 * look for it. Only cells with a value are given, the source object always.
 *
 * @param {Record<string, unknown> | null | undefined} cells  the pull row's cells, by key, as text
 * @param {{ tag: string, label: string }} opts
 * @returns {Record<string, any>}
 */
export function pullPeopleInputs(cells, { tag, label }) {
  const c = cells ?? {};
  const t = (k) => text(c[k]);
  const domain = bareDomain(t("domain")) ?? "";
  const source = {
    name: t("full_name") || [t("first_name"), t("last_name")].filter(Boolean).join(" "),
    last_name: t("last_name"),
    latest_experience_title: t("title"),
    latest_experience_company: t("company"),
    url: t("linkedin"),
    location_name: [t("city"), t("state"), t("country")].filter(Boolean).join(", "),
    domain,
  };
  const inputs = {
    find_people_from_linkedin_company_url: source,
    client_tag: normTag(tag),
    company_website: domain,
    written_city: t("city"),
    written_state: t("state"),
    person_aiark_id: t("aiark_id"),
    found_by: PULL_FOUND_BY,
    stage: PULL_STAGE,
    person_first_name: t("first_name"),
    person_last_name: t("last_name"),
    seniority: t("seniority"),
    department: t("department"),
    person_city: t("city"),
    person_state: t("state"),
    person_country: t("country"),
    aiark_email_status: t("email_status"),
    aiark_email_domain_type: t("email_domain_type"),
    pulled_before: t("pulled_before"),
    source: text(label),
  };
  return Object.fromEntries(Object.entries(inputs).filter(([k, v]) => k === "find_people_from_linkedin_company_url" || v));
}

/** A copied person's search text, as people runs make it: name, title, company and place, lower case. */
function searchText(inputs) {
  const s = inputs.find_people_from_linkedin_company_url ?? {};
  return [s.name, s.latest_experience_title, s.latest_experience_company, inputs.written_city, inputs.written_state]
    .filter(Boolean).join(" ").toLowerCase().slice(0, 2000);
}

// ── The copy ────────────────────────────────────────────────────────────────

// A run the copy may take now ($1: run ids, or null for any). Not claimed by
// the run engine: a cancel sets finished_at while a slice may still hold the
// run, and that slice writes progress whole.
const TAKES = `
  r.mode = 'live' AND r.finished_at IS NOT NULL AND r.table_id IS NOT NULL
  AND (r.claim_token IS NULL OR r.claimed_at < now() - make_interval(mins => ${LEASE_MIN}))
  AND coalesce(r.progress #>> '{no_email,state}', '') <> 'done'
  AND (coalesce(r.progress #>> '{no_email,state}', '') <> 'waiting'
       OR coalesce((r.progress #>> '{no_email,next_try_at}')::timestamptz, '-infinity'::timestamptz) <= now())
  AND ($1::uuid[] IS NULL OR r.id = ANY($1::uuid[]))
  AND public.fn_enrich_people_switch_on(r.client_tag)
  AND NOT EXISTS (SELECT 1 FROM enrich_rows q WHERE q.table_id = r.table_id AND q.run_status IN ('queued', 'running'))`;

const DUE = `SELECT r.id FROM aiark_runs r WHERE ${TAKES} ORDER BY r.finished_at, r.id LIMIT $2`;

const LOCK = `
  SELECT r.id, r.client_tag, r.table_id, r.created_at, r.created_by
    FROM aiark_runs r
   WHERE r.id = $2 AND ${TAKES}
     FOR UPDATE OF r SKIP LOCKED`;

// The client's People (pipeline) table and its input columns (upload-move.mjs's PEOPLE_TABLE).
const PEOPLE_TABLE = `
  SELECT t.id, coalesce(array_agg(k.key) FILTER (WHERE k.key IS NOT NULL), '{}') AS keys
    FROM enrich_tables t
    LEFT JOIN enrich_columns k ON k.table_id = t.id AND k.kind = 'input'
   WHERE t.client_tag = $1 AND t.kind = $2 AND t.template = $3
   GROUP BY t.id`;

const SOURCE = `
  INSERT INTO enrich_sources (table_id, kind, external_id, label, created_by, meta)
  VALUES ($1, '${SOURCE_KIND}', $2, $3, $4, $5::jsonb)
  ON CONFLICT (table_id, kind, external_id) WHERE external_id IS NOT NULL DO UPDATE SET label = EXCLUDED.label
  RETURNING id`;

// A pull row whose Outcome is "No email" and which has no find_email cell (enrich_cells_filter_idx), as SQL.
const NOT_SENT = (o) => `
  ${o}.column_key = 'outcome' AND ${o}.status = 'done' AND ${o}.value #>> '{}' = '${PULL_NO_EMAIL_OUTCOME}'
  AND NOT EXISTS (SELECT 1 FROM enrich_cells f WHERE f.row_id = ${o}.row_id AND f.column_key = '${FIND_EMAIL_COLUMN}')`;

const TAKE_ROWS = `
  SELECT o.row_id,
         (SELECT jsonb_object_agg(c.column_key, c.value #>> '{}') FROM enrich_cells c
           WHERE c.row_id = o.row_id AND c.status = 'done' AND c.column_key = ANY($3::text[])) AS cells
    FROM enrich_cells o
   WHERE o.table_id = $1 AND ${NOT_SENT("o")}
   ORDER BY o.row_id
   LIMIT $2`;

// The chunk's People rows, held, with their input cells; a key already in the
// table is left as it is, and its row is followed (LOOK_SQL's shape,
// people-runs.mjs: the source object is a JSON object, everything else text).
const WRITE_HELD = `
  WITH x AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(pull_row_id bigint, row_key text, search text, cells jsonb)),
  r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text, run_status)
    SELECT $1::uuid, $2::uuid, x.row_key, coalesce(x.search, ''), 'held' FROM x ORDER BY x.pull_row_id
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id, row_key
  ),
  c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $1::uuid, 'done', kv.value,
           left(CASE WHEN jsonb_typeof(kv.value) = 'string' THEN kv.value #>> '{}' ELSE coalesce(kv.value ->> 'name', kv.value::text) END, 300)
      FROM r JOIN x ON x.row_key = r.row_key CROSS JOIN LATERAL jsonb_each(x.cells) AS kv
    RETURNING 1
  )
  SELECT x.pull_row_id, x.row_key, coalesce(r.id, e.id) AS people_row_id, (r.id IS NOT NULL) AS created
    FROM x
    LEFT JOIN r ON r.row_key = x.row_key
    LEFT JOIN enrich_rows e ON r.id IS NULL AND e.table_id = $1::uuid AND e.row_key = x.row_key`;

// The pull rows' find_email cells (written here: the engine never works the column).
const WRITE_FIND = `
  INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display, note, updated_at)
  SELECT x.row_id, '${FIND_EMAIL_COLUMN}', $1::uuid, x.status, x.value || jsonb_build_object('at', now()), x.display, x.note, now()
    FROM jsonb_to_recordset($2::jsonb) AS x(row_id bigint, status text, value jsonb, display text, note text)
  ON CONFLICT (row_id, column_key) DO NOTHING`;

const COUNT_SOURCE = `
  UPDATE enrich_sources SET received = received + $2, created = created + $3, duplicates = duplicates + $4 WHERE id = $1`;

// The pull's People rows still waiting for an answer (find_email "sent").
const OPEN_COUNT = (r) => `(SELECT count(*)::int FROM enrich_cells f
   WHERE f.table_id = ${r}.table_id AND f.column_key = '${FIND_EMAIL_COLUMN}' AND f.value ->> 'state' = 'sent')`;
const KEPT = (key) => `coalesce((r.progress #>> '{no_email,${key}}')::int, 0)`;

const PROGRESS = `
  UPDATE aiark_runs r
     SET progress = jsonb_set(r.progress, '{no_email}', jsonb_build_object(
           'state', CASE WHEN EXISTS (SELECT 1 FROM enrich_cells o WHERE o.table_id = r.table_id AND ${NOT_SENT("o")}) THEN 'copying' ELSE 'done' END,
           'copied', ${KEPT("copied")} + $2, 'already', ${KEPT("already")} + $3, 'open', ${OPEN_COUNT("r")}, 'at', now()), true)
   WHERE r.id = $1 AND r.finished_at IS NOT NULL
  RETURNING r.progress #>> '{no_email,state}' AS state`;

const WAIT = `
  UPDATE aiark_runs r
     SET progress = jsonb_set(r.progress, '{no_email}', jsonb_build_object(
           'state', 'waiting', 'reason', $2::text, 'next_try_at', now() + make_interval(mins => $3),
           'copied', ${KEPT("copied")}, 'already', ${KEPT("already")}, 'open', ${OPEN_COUNT("r")}, 'at', now()), true)
   WHERE r.id = $1 AND r.finished_at IS NOT NULL`;

/** The client's People table and its input keys, made or brought up to date first when `ensure` (under the lock, in a savepoint). */
async function peopleTableFor(c, tag, { ensure, settings, ensureTables }) {
  const t = PIPELINE_TEMPLATES.people;
  if (ensure) {
    await lockPipelineTables(c, tag);
    await c.query("SAVEPOINT pull_no_email_tables");
    try {
      await ensureTables(c, tag, { settings });
      await c.query("RELEASE SAVEPOINT pull_no_email_tables");
    } catch (e) {
      const reason = tablesRefusalReason(e);
      if (!reason) throw e;
      await c.query("ROLLBACK TO SAVEPOINT pull_no_email_tables");
      return { refused: reason };
    }
  }
  const { rows: [table] } = await c.query(PEOPLE_TABLE, [tag, t.kind, t.template]);
  return table ? { id: table.id, keys: new Set(table.keys) } : null;
}

/**
 * One chunk of one run, in one transaction.
 *
 * @returns {Promise<{ skipped?: true, waiting?: string, created?: number, already?: number, read?: number, done?: boolean }>}
 */
async function copyChunk(pool, runId, { size, settings, round, runIds, ensureTables }) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout = '60s'");
    const { rows: [run] } = await c.query(LOCK, [runIds, runId]);
    if (!run) {
      await c.query("ROLLBACK");
      return { skipped: true };
    }
    const { rows: taken } = await c.query(TAKE_ROWS, [run.table_id, size, [...PULL_CELLS]]);
    const tag = normTag(run.client_tag);
    const label = pullSourceLabel(run);
    /** @type {Array<{ row_id: number, status: string, value: Record<string, unknown>, display: string, note: string }>} */
    const finds = [];
    /** The people to copy, one per row key; a second pull row with a key already here follows the first (twins). */
    /** @type {Map<string, { pull_row_id: number, row_key: string, search: string, all: Record<string, any> }>} */
    const people = new Map();
    /** @type {Array<{ pull_row_id: number, row_key: string }>} */
    const twins = [];
    for (const t of taken) {
      const cells = t.cells ?? {};
      const id = text(cells.aiark_id);
      if (!id) {
        finds.push({
          row_id: Number(t.row_id), status: "empty", value: { state: "no_id" }, display: "No AI Ark id",
          note: "Not copied to the People table: the row has no AI Ark id to key the person by.",
        });
        continue;
      }
      const rowKey = aiarkPersonRowKey(id);
      if (people.has(rowKey)) {
        twins.push({ pull_row_id: Number(t.row_id), row_key: rowKey });
        continue;
      }
      const all = pullPeopleInputs(cells, { tag, label });
      people.set(rowKey, { pull_row_id: Number(t.row_id), row_key: rowKey, search: searchText(all), all });
    }
    let created = 0;
    let already = 0;
    if (people.size) {
      // The client's tables are made or brought up to date first, once a round, before any of its people go in.
      let table = round.refused.has(tag)
        ? { refused: round.refused.get(tag) }
        : await peopleTableFor(c, tag, { ensure: !round.ensured.has(tag), settings, ensureTables });
      if (!table?.refused && !table?.id) table = await peopleTableFor(c, tag, { ensure: true, settings, ensureTables }); // deleted since this round made it
      if (table?.refused) {
        // Nothing of this chunk is written: the run waits, and is tried again after MOVE_RETRY_MINUTES.
        round.refused.set(tag, table.refused);
        await c.query(WAIT, [run.id, table.refused, MOVE_RETRY_MINUTES]);
        await c.query("COMMIT");
        return { waiting: table.refused };
      }
      if (!table?.id) throw new Error(`${tag} has no People (pipeline) table after it was made`);
      round.ensured.add(tag);
      const payload = [...people.values()].map((p) => ({
        pull_row_id: p.pull_row_id, row_key: p.row_key, search: p.search,
        cells: Object.fromEntries(Object.entries(p.all).filter(([k]) => table.keys.has(k))),
      }));
      const { rows: [source] } = await c.query(SOURCE, [
        table.id, `pull:${run.id}`, label, run.created_by ?? null, JSON.stringify({ run_id: run.id, pull_table_id: run.table_id }),
      ]);
      const { rows: written } = await c.query(WRITE_HELD, [table.id, source.id, JSON.stringify(payload)]);
      const byKey = new Map(written.map((w) => [w.row_key, w]));
      for (const w of written) {
        if (w.created) created++;
        else already++;
        finds.push(sentCell(Number(w.pull_row_id), table.id, Number(w.people_row_id), w.created));
      }
      for (const t of twins) {
        const w = byKey.get(t.row_key);
        if (!w?.people_row_id) continue; // never: the first of the key was just written
        already++;
        finds.push(sentCell(t.pull_row_id, table.id, Number(w.people_row_id), false));
      }
      await c.query(COUNT_SOURCE, [source.id, payload.length + twins.length, created, already]);
    }
    if (finds.length) await c.query(WRITE_FIND, [run.table_id, JSON.stringify(finds)]);
    // Nobody left to copy makes the run done (no table or source row is made for a run that copies nobody).
    const { rows: [p] } = await c.query(PROGRESS, [run.id, created, already]);
    await c.query("COMMIT");
    return { created, already, read: taken.length, done: p?.state === "done" };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** A pull row's find_email cell for a person now in the People table (created) or followed there. */
function sentCell(pullRowId, peopleTableId, peopleRowId, created) {
  return {
    row_id: pullRowId,
    status: "done",
    value: { state: "sent", people_table_id: peopleTableId, people_row_id: peopleRowId },
    display: created ? "Sent to the People table" : "In the People table already",
    note: created ? SENT_NOTE : FOLLOWED_NOTE,
  };
}

/**
 * The worker's minute of copying: the people with no email of finished live
 * AI Ark pulls into their clients' People (pipeline) tables, held, for the
 * clients on People runs only. At most maxChunks chunks of `chunk` rows in
 * all; a run whose chunk failed is logged and tried again after
 * MOVE_RETRY_MINUTES, so it never holds up the others.
 *
 * @param {Pool} pool
 * @param {{ settings?: import("./settings.mjs").PipelineSettings | null, runIds?: string[] | null, chunk?: number, maxChunks?: number,
 *           log?: (line: string) => void, ensureTables?: typeof ensurePipelineTables }} [opts]
 * @returns {Promise<{ runs: number, copied: number, already: number, waiting: number }>}
 *   runs: runs whose rows were copied this round; copied: People rows made; already: people followed in a row
 *   another run made; waiting: runs whose client's tables can't be made now
 */
export async function copyPullNoEmail(pool, {
  settings = null, runIds = null, chunk = MOVE_CHUNK, maxChunks = MOVE_MAX_CHUNKS, log = () => {}, ensureTables = ensurePipelineTables,
} = {}) {
  const size = Math.max(1, Math.min(10_000, Math.trunc(Number(chunk)) || MOVE_CHUNK));
  const budget = Math.max(1, Math.trunc(Number(maxChunks)) || MOVE_MAX_CHUNKS);
  const ids = runIds == null ? null : [...runIds];
  let runs = 0;
  let copied = 0;
  let already = 0;
  let waiting = 0;
  let chunks = 0;
  /** This round's clients: those whose tables were made or brought up to date, and those whose tables can't be made now (why). */
  const round = { ensured: new Set(), refused: new Map() };
  const { rows: due } = await pool.query(DUE, [ids, budget]);
  for (const { id } of due) {
    let touched = false;
    while (chunks < budget) {
      chunks++;
      let r;
      try {
        r = await copyChunk(pool, id, { size, settings, round, runIds: ids, ensureTables });
      } catch (e) {
        log(`AI Ark pull ${id}: its people with no email were not copied this time (${/** @type {Error} */ (e).message}); tried again in ${MOVE_RETRY_MINUTES} minutes`);
        await pool.query(WAIT, [id, "failed", MOVE_RETRY_MINUTES]).catch(() => {});
        break;
      }
      if (r.skipped) {
        chunks--; // another worker has it, or it no longer qualifies: nothing was done here
        break;
      }
      if (r.waiting) {
        waiting++;
        break;
      }
      copied += r.created ?? 0;
      already += r.already ?? 0;
      if (r.read) touched = true;
      if (r.done || !r.read) break;
    }
    if (touched) runs++;
    if (chunks >= budget) break;
  }
  return { runs, copied, already, waiting };
}

// ── The hand-back ───────────────────────────────────────────────────────────

const OPEN_RUNS = `
  SELECT r.id, r.table_id
    FROM aiark_runs r
   WHERE r.table_id IS NOT NULL AND r.finished_at IS NOT NULL AND coalesce((r.progress #>> '{no_email,open}')::int, 0) > 0
     AND ($1::uuid[] IS NULL OR r.id = ANY($1::uuid[]))
   ORDER BY r.finished_at, r.id
   LIMIT $2`;

// A run's pull rows sent to the People table, with their People row (or none: deleted).
const SENT_ROWS = `
  SELECT f.row_id AS pull_row_id, f.value AS sent, p.id AS people_row_id, p.table_id AS people_table_id, p.run_status AS people_status,
         (SELECT jsonb_object_agg(c.column_key, c.value) FROM enrich_cells c
           WHERE c.row_id = p.id AND c.status = 'done' AND c.column_key = ANY($3::text[])) AS cells
    FROM enrich_cells f
    LEFT JOIN enrich_rows p ON p.id = (f.value ->> 'people_row_id')::bigint
   WHERE f.table_id = $1 AND f.column_key = '${FIND_EMAIL_COLUMN}' AND f.value ->> 'state' = 'sent'
   ORDER BY f.row_id
   LIMIT $2`;

// A pull row's search ended (closed, gone, found): only while its cell still says sent.
const SETTLE_FIND = `
  UPDATE enrich_cells f
     SET value = f.value || $3::jsonb || jsonb_build_object('at', now()), display = $4, note = $5, updated_at = now()
   WHERE f.row_id = $1 AND f.column_key = '${FIND_EMAIL_COLUMN}' AND f.table_id = $2 AND f.value ->> 'state' = 'sent'`;

const SETTLE_MANY = `
  UPDATE enrich_cells f
     SET value = f.value || x.value || jsonb_build_object('at', now()), display = x.display, note = x.note, updated_at = now()
    FROM jsonb_to_recordset($2::jsonb) AS x(row_id bigint, value jsonb, display text, note text)
   WHERE f.row_id = x.row_id AND f.column_key = '${FIND_EMAIL_COLUMN}' AND f.table_id = $1 AND f.value ->> 'state' = 'sent'`;

// The People row's add_to_database cell, only when it has none (a followed people-run row may hold promotion's).
const MARK_PEOPLE_ROW = `
  INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display, note, updated_at)
  VALUES ($1, '${ADD_COLUMN}', $2, 'done', $3::jsonb, 'Sent to the AI Ark pull',
          'Handed back to the AI Ark pull''s row, which is worked again and added to the database from there.', now())
  ON CONFLICT (row_id, column_key) DO NOTHING`;

const RECOUNT_OPEN = `
  UPDATE aiark_runs r
     SET progress = jsonb_set(r.progress, '{no_email,open}', to_jsonb(${OPEN_COUNT("r")}), true)
   WHERE r.id = $1 AND r.finished_at IS NOT NULL AND jsonb_typeof(r.progress -> 'no_email') = 'object'`;

/** The cells a hand-back reads from a People row: its Outcome, its question and what its verdict reads. */
const PEOPLE_CELLS = Object.freeze([...new Set(["person_outcome", "question", ...VERDICT_CELLS.person])]);

/** "Found by Findymail", "Approved by Enrichley": who gave the address, in a word. */
const foundWords = (v) => (v.found_by ? `Found by ${vendorName(v.found_by)}` : `Approved by ${vendorName(v.approved_by)}`);

/**
 * One found address handed back to its pull row, in one transaction: the
 * pull row takes it (emailFound), its find_email cell says found, and the
 * People row's add_to_database cell says where the address went (when it has
 * none). "running": the pull row is being worked, left for the next minute;
 * "changed": its Outcome is no longer "No email".
 *
 * @returns {Promise<"found" | "running" | "changed">}
 */
async function handBackOne(pool, { pullTableId, pullRowId, peopleRowId, peopleTableId, verdict, question }) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL statement_timeout = '30s'");
    const ok = await emailFound(c, {
      rowId: pullRowId,
      email: verdict.address,
      status: "VALID",
      domainType: verdict.status === "catch_all" ? "CATCH_ALL" : "SMTP",
      extra: { email_found_source: verdictSource(verdict), email_found_status: verdict.status ?? "", question },
    });
    if (!ok) {
      const { rows: [row] } = await c.query(`SELECT run_status FROM enrich_rows WHERE id = $1`, [pullRowId]);
      await c.query("ROLLBACK");
      return row?.run_status === "running" ? "running" : "changed";
    }
    await c.query(SETTLE_FIND, [
      pullRowId, pullTableId,
      JSON.stringify({ state: "found", email: verdict.address, found_by: verdict.found_by, approved_by: verdict.approved_by, status: verdict.status }),
      foundWords(verdict),
      "Found in the client's People (pipeline) table and handed back: this row is checked again and added to the database from here.",
    ]);
    await c.query(MARK_PEOPLE_ROW, [
      peopleRowId, peopleTableId,
      JSON.stringify({ added: false, reason: "aiark_pull", pull_row_id: pullRowId, pull_table_id: pullTableId, email: verdict.address }),
    ]);
    await c.query("COMMIT");
    return "found";
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * The worker's minute of handing back: for at most `runs` runs with People
 * rows open, oldest first, at most `limit` of each run's pull rows sent to
 * the People table, as the header says. Then each run's open count is
 * recounted.
 *
 * @param {Pool} pool
 * @param {{ runIds?: string[] | null, runs?: number, limit?: number, log?: (line: string) => void }} [opts]
 * @returns {Promise<{ found: number, closed: number }>}  found: addresses handed back; closed: searches ended without one (gone included)
 */
export async function handBackFound(pool, { runIds = null, runs = 20, limit = 200, log = () => {} } = {}) {
  const most = Math.max(1, Math.trunc(Number(runs)) || 20);
  const each = Math.max(1, Math.min(5_000, Math.trunc(Number(limit)) || 200));
  const { rows: open } = await pool.query(OPEN_RUNS, [runIds == null ? null : [...runIds], most]);
  let found = 0;
  let closed = 0;
  for (const run of open) {
    const { rows } = await pool.query(SENT_ROWS, [run.table_id, each, [...PEOPLE_CELLS]]);
    /** @type {Array<{ row_id: number, value: Record<string, unknown>, display: string, note: string }>} */
    const ends = [];
    for (const r of rows) {
      const pullRowId = Number(r.pull_row_id);
      if (r.people_row_id == null) {
        ends.push({
          row_id: pullRowId, value: { state: "gone" }, display: "Removed from the People table",
          note: "Its People row was deleted, so nothing comes back; it is never copied again.",
        });
        continue;
      }
      if (r.people_status !== "done") continue; // held, queued, running, waiting or in error: a later minute
      const cells = r.cells ?? {};
      const outcome = typeof cells.person_outcome === "string" ? cells.person_outcome : "";
      if (outcome !== APPROVED_OUTCOME) {
        ends.push({
          row_id: pullRowId, value: { state: "closed", outcome }, display: `People table: ${outcome || "no Outcome"}`,
          note: "The People table finished with this person and found no address to hand back.",
        });
        continue;
      }
      const verdict = personVerdict(cells);
      if (!verdict) {
        ends.push({
          row_id: pullRowId, value: { state: "closed", outcome }, display: "People table: Approved email, approval not traced",
          note: "The People table approved an address that can't be traced to an email finder or Enrichley, so it is not handed back (as promotion holds such an address back).",
        });
        continue;
      }
      const question = typeof cells.question === "string" ? cells.question.trim() : "";
      let r2;
      try {
        r2 = await handBackOne(pool, {
          pullTableId: run.table_id, pullRowId, peopleRowId: Number(r.people_row_id), peopleTableId: r.people_table_id, verdict, question,
        });
      } catch (e) {
        log(`AI Ark pull row ${pullRowId}: its found address was not handed back this time (${/** @type {Error} */ (e).message})`);
        continue;
      }
      if (r2 === "found") found++;
      else if (r2 === "changed") {
        ends.push({
          row_id: pullRowId, value: { state: "closed", outcome }, display: "The pull's row changed",
          note: "The pull's row no longer says No email (it was worked again), so the found address was not handed back.",
        });
      }
    }
    if (ends.length) {
      const { rowCount } = await pool.query(SETTLE_MANY, [run.table_id, JSON.stringify(ends)]);
      closed += rowCount ?? 0;
    }
    await pool.query(RECOUNT_OPEN, [run.id]);
  }
  return { found, closed };
}
