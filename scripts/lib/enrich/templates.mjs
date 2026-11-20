// A client's three pipeline template tables on the Clay tab: Companies
// (companies_v2), General (inboxes_v1) and People (people_v1), each
// one enrich_tables row per client (unique on client_tag, kind, template),
// with columns compiled from the Clay originals in enrich_originals.
//
// ensurePipelineTables() runs inside the transaction of the pull route and the
// people-run route. It refuses a client that still has a retired companies_v1
// table (D24: its pulls wait for the owner's decision), raises OriginalsMissing
// while the originals are not loaded (the routes answer 409), and otherwise
// makes or updates the three tables. A client whose own Clay tables were
// exported has its own variant of the originals (its tag in lower case);
// every other client compiles from "default" (D15). When a client's own
// variant does not compile (a template changed since it was loaded, say), its
// tables compile from "default" instead and their note says why; the worker
// then reads them as "default", so personalisation stays off for the client.

import { loadOriginals, OriginalsMissing } from "./compile-original.mjs";
import { ORIGINAL_COUNTS, ORIGINAL_KEYS } from "./original-keys.mjs";
import { COMPANY_REFS, COMPANY_TABLE_NAME_V2, COMPANY_TEMPLATE_V2, companyColumnsV2 } from "./company-template-v2.mjs";
import { INBOX_TABLE_NAME, INBOX_TEMPLATE, inboxColumns } from "./inbox-template.mjs";
import { PEOPLE_TABLE_NAME, PEOPLE_TEMPLATE, peopleColumns } from "./people-template.mjs";
import { order } from "./formula.mjs";
import { normTag } from "./settings.mjs";

/** The three pipeline templates, by enrich_tables.kind. */
export const PIPELINE_TEMPLATES = Object.freeze({
  companies: Object.freeze({ kind: "companies", template: COMPANY_TEMPLATE_V2, name: COMPANY_TABLE_NAME_V2 }),
  inboxes: Object.freeze({ kind: "inboxes", template: INBOX_TEMPLATE, name: INBOX_TABLE_NAME }),
  people: Object.freeze({ kind: "people", template: PEOPLE_TEMPLATE, name: PEOPLE_TABLE_NAME }),
});

/** Templates no longer worked or made (D24). */
export const RETIRED_TEMPLATES = Object.freeze(["companies_v1"]);

/** A client that still has a companies_v1 table: its pulls are refused until the owner decides (D24). */
export class RetiredV1Table extends Error {
  /** @param {string} tag */
  constructor(tag) {
    super(`${tag} still has a companies_v1 table: its pulls wait until the owner decides what happens to it (delete it, or keep it read-only under another name)`);
    this.name = "RetiredV1Table";
    this.tag = tag;
  }
}

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 * @typedef {"companies" | "inboxes" | "people"} TemplateKind
 */

/**
 * A client's own originals variant name: its tag in lower case, every run of
 * characters other than letters and digits made one underscore (so it fits
 * enrich_originals.variant). Null when nothing usable is left, or for a tag
 * that would read as "default".
 *
 * @param {string} tag
 * @returns {string | null}
 */
export function variantName(tag) {
  const v = normTag(tag).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return v && v !== "default" && /^[a-z0-9][a-z0-9_]*$/.test(v) ? v : null;
}

/**
 * Which originals a client's tables compile from: its own variant when all of
 * it is loaded, else "default".
 *
 * @param {Db} db
 * @param {string} tag
 * @returns {Promise<string>}
 */
export async function variantFor(db, tag) {
  const own = variantName(tag);
  if (!own) return "default";
  try {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE template_kind = 'companies')::int AS c,
              count(*) FILTER (WHERE template_kind = 'people')::int AS p,
              count(*) FILTER (WHERE template_kind = 'inboxes')::int AS i
         FROM enrich_originals WHERE variant = $1`,
      [own]
    );
    const r = rows[0] ?? {};
    const full = r.c === ORIGINAL_COUNTS.companies && r.p === ORIGINAL_COUNTS.people && r.i === ORIGINAL_COUNTS.inboxes;
    return full ? own : "default";
  } catch (e) {
    if (e?.code === "42P01") return "default"; // migration 125 not applied
    throw e;
  }
}

/**
 * Does the client still have a phase 1 (companies_v1) table?
 *
 * @param {Db} db
 * @param {string} tag
 * @returns {Promise<boolean>}
 */
export async function hasRetiredV1(db, tag) {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM enrich_tables WHERE client_tag = $1 AND template = ANY($2::text[])) AS v1`,
    [normTag(tag), [...RETIRED_TEMPLATES]]
  );
  return rows[0].v1 === true;
}

/**
 * The client's template table of one kind, made when it doesn't exist. It
 * touches no column: ensurePipelineTables() compiles them. Tests may call it
 * on its own to get a table id to write rows into.
 *
 * @param {Db} db  a client inside the caller's transaction
 * @param {string} tag
 * @param {TemplateKind} kind
 * @param {{ variant?: string, note?: string | null }} [opts]
 *   note: the table's source_note in full, instead of the one naming the variant
 *   (ensurePipelineTables' fallback note; variantOfNote must still read it)
 * @returns {Promise<{ id: string, created: boolean }>}
 */
export async function ensureTable(db, tag, kind, { variant = "default", note = null } = {}) {
  const t = PIPELINE_TEMPLATES[kind];
  if (!t) throw new Error(`Unknown template kind "${kind}"`);
  const { rows: [table] } = await db.query(
    `INSERT INTO enrich_tables (client_tag, kind, name, source_note, template)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (client_tag, kind, template) WHERE template IS NOT NULL
     DO UPDATE SET source_note = EXCLUDED.source_note
     RETURNING id, (xmax = 0) AS created`,
    [
      normTag(tag), t.kind, t.name,
      note ?? `Pipeline template ${t.template}, compiled from the Clay originals (variant ${variant})`, t.template,
    ]
  );
  return { id: table.id, created: table.created };
}

/**
 * The note of a client's table compiled from "default" because its own
 * variant did not compile: variantOfNote reads "default" from it.
 *
 * @param {TemplateKind} kind
 * @param {string} own  the client's own variant
 * @param {string} reason  the first line of the compile failure
 * @returns {string}
 */
export function fallbackNote(kind, own, reason) {
  return `Pipeline template ${PIPELINE_TEMPLATES[kind].template}, compiled from the Clay originals (variant default); the client's own variant ${own} did not compile: ${reason}`;
}

/** The variant a table's columns were compiled from, as ensureTable notes it on the table. */
export function variantOfNote(note) {
  const m = /\(variant ([a-z0-9][a-z0-9_]*)\)/.exec(String(note ?? ""));
  return m ? m[1] : "default";
}

/**
 * The three templates' columns, compiled from one variant's originals. Each
 * list is checked as the worker would read it: no two columns share a key and
 * order() finds no loop. Pure: the tests and the seed's dry run use it.
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @param {{ settings?: import("./settings.mjs").PipelineSettings | null }} [opts]
 * @returns {{ companies: Array<Record<string, any>>, inboxes: Array<Record<string, any>>, people: Array<Record<string, any>> }}
 */
export function compileTemplates(originals, { settings = null } = {}) {
  const out = {
    companies: companyColumnsV2(originals),
    inboxes: inboxColumns(originals),
    people: peopleColumns(originals, settings?.people_tracks ?? null, { companyKeys: { ...ORIGINAL_KEYS.companies, ...COMPANY_REFS } }),
  };
  for (const [kind, cols] of Object.entries(out)) {
    const keys = new Set();
    for (const c of cols) {
      if (keys.has(c.key)) throw new Error(`The ${kind} template has the column ${c.key} twice`);
      keys.add(c.key);
    }
    order(cols.map((c) => ({ ...c })));
  }
  return out;
}

const UPSERT_COLUMNS = `
  INSERT INTO enrich_columns AS e (table_id, key, name, position, kind, action, formula, waterfall, inputs, config, run_if,
                                   data_type, description, provider, needs_env, phase, hidden, clay_field_id)
  SELECT $1, x.key, x.name, x.position, x.kind, x.action, x.formula, x.waterfall, coalesce(x.inputs, '{}'::jsonb),
         coalesce(x.config, '{}'::jsonb), x.run_if, x.data_type, x.description, x.provider, coalesce(x.needs_env, '{}'), x.phase,
         coalesce(x.hidden, false), x.clay_field_id
    FROM jsonb_to_recordset($2::jsonb) AS x(key text, name text, position int, kind text, action text, formula text,
         waterfall jsonb, inputs jsonb, config jsonb, run_if text, data_type text, description text, provider text,
         needs_env text[], phase smallint, hidden boolean, clay_field_id text)
  ON CONFLICT (table_id, key) DO UPDATE SET
    name = EXCLUDED.name, position = EXCLUDED.position, kind = EXCLUDED.kind, action = EXCLUDED.action,
    formula = EXCLUDED.formula, waterfall = EXCLUDED.waterfall, inputs = EXCLUDED.inputs, config = EXCLUDED.config,
    run_if = EXCLUDED.run_if, data_type = EXCLUDED.data_type, description = EXCLUDED.description,
    provider = EXCLUDED.provider, needs_env = EXCLUDED.needs_env, phase = EXCLUDED.phase, hidden = EXCLUDED.hidden,
    clay_field_id = EXCLUDED.clay_field_id, updated_at = now()
  WHERE (e.name, e.position, e.kind, e.action, e.formula, e.waterfall, e.inputs, e.config, e.run_if, e.data_type,
         e.description, e.provider, e.needs_env, e.phase, e.hidden, e.clay_field_id)
        IS DISTINCT FROM
        (EXCLUDED.name, EXCLUDED.position, EXCLUDED.kind, EXCLUDED.action, EXCLUDED.formula, EXCLUDED.waterfall,
         EXCLUDED.inputs, EXCLUDED.config, EXCLUDED.run_if, EXCLUDED.data_type, EXCLUDED.description, EXCLUDED.provider,
         EXCLUDED.needs_env, EXCLUDED.phase, EXCLUDED.hidden, EXCLUDED.clay_field_id)`;

/**
 * Brings each template table's columns up to date with its template, compiled
 * from the variant's originals: upserts the columns by key (as
 * ensureTemplateTable did in phase 1), with clay_field_id on every compiled
 * column, and prunes the columns a template no longer has, with their cells.
 * A column whose definition is unchanged is not written. Rows already worked
 * are not re-run.
 *
 * @param {Db} db
 * @param {{ companies: string, inboxes: string, people: string }} ids  the three table ids
 * @param {import("./compile-original.mjs").Originals} originals
 * @param {{ settings?: import("./settings.mjs").PipelineSettings | null, variant: string }} opts
 * @returns {Promise<{ written: Record<string, number>, pruned: Record<string, string[]> }>}
 */
export async function syncTemplateColumns(db, ids, originals, { settings = null, variant }) {
  const compiled = compileTemplates(originals, { settings });
  /** @type {Record<string, number>} */
  const written = {};
  /** @type {Record<string, string[]>} */
  const pruned = {};
  for (const kind of /** @type {TemplateKind[]} */ (["companies", "inboxes", "people"])) {
    const tableId = ids[kind];
    const cols = compiled[kind];
    const r = await db.query(`${UPSERT_COLUMNS} RETURNING e.key`, [tableId, JSON.stringify(cols)]);
    written[kind] = r.rows.length;
    const { rows: gone } = await db.query(
      `DELETE FROM enrich_columns WHERE table_id = $1 AND NOT (key = ANY($2::text[])) RETURNING key`,
      [tableId, cols.map((c) => c.key)]
    );
    pruned[kind] = gone.map((g) => g.key);
    if (pruned[kind].length) {
      await db.query(`DELETE FROM enrich_cells WHERE table_id = $1 AND column_key = ANY($2::text[])`, [tableId, pruned[kind]]);
    }
  }
  void variant;
  return { written, pruned };
}

/**
 * The per-client lock under which a client's pipeline tables are made, held to
 * the end of the caller's transaction: the same one the Maps intake and the
 * Clay tab's Create take (src/lib/enrich/gmaps.ts lockPipelineTables), so two
 * of them never make one client's tables at once.
 *
 * @param {Db} db  a client inside the caller's transaction
 * @param {string} tag
 */
export async function lockPipelineTables(db, tag) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext('enrich-pipeline-tables:' || $1))`, [normTag(tag)]);
}

/**
 * The client's three pipeline tables, made or brought up to date, compiled
 * from its variant of the originals. Runs inside the caller's transaction.
 * Throws RetiredV1Table (D24) or OriginalsMissing; the routes answer 409 to
 * both.
 *
 * A client's own variant (complete: variantFor) that does not compile with
 * the templates of this code, for any reason but OriginalsMissing, is set
 * aside for the call: the tables compile from "default", and their note names
 * the variant and the first line of the failure (fallbackNote, 300
 * characters at most). variantOfNote reads "default" from that note, so the
 * worker never treats them as the client's own (personalisation stays off).
 *
 * @param {Db} db  a client inside the caller's transaction
 * @param {string} tag
 * @param {{ settings?: import("./settings.mjs").PipelineSettings | null }} [opts]
 * @returns {Promise<{ companies: string, inboxes: string, people: string, variant: string, own_variant: string | null,
 *   fallback: string | null, created: { companies: boolean, inboxes: boolean, people: boolean } }>}
 *   table ids, the variant they were compiled from, the client's own variant when all of it is loaded (else null),
 *   why its own variant was set aside (null when it was not), and which tables were made now
 */
export async function ensurePipelineTables(db, tag, { settings = null } = {}) {
  const t = normTag(tag);
  if (!t) throw new Error("No client tag");
  if (await hasRetiredV1(db, t)) throw new RetiredV1Table(t);
  const own = await variantFor(db, t);
  let variant = own;
  let originals = await loadOriginals(db, own);
  /** @type {string | null} */
  let fallback = null;
  if (own !== "default") {
    try {
      compileTemplates(originals, { settings });
    } catch (e) {
      if (e instanceof OriginalsMissing) throw e;
      fallback = String(e?.message ?? e).split("\n")[0].slice(0, 300);
      variant = "default";
      originals = await loadOriginals(db, "default");
    }
  }
  /** @param {TemplateKind} kind */
  const note = (kind) => (fallback == null ? null : fallbackNote(kind, own, fallback));
  const c = await ensureTable(db, t, "companies", { variant, note: note("companies") });
  const i = await ensureTable(db, t, "inboxes", { variant, note: note("inboxes") });
  const p = await ensureTable(db, t, "people", { variant, note: note("people") });
  const ids = { companies: c.id, inboxes: i.id, people: p.id };
  await syncTemplateColumns(db, ids, originals, { settings, variant });
  return {
    ...ids,
    variant,
    own_variant: own === "default" ? null : own,
    fallback,
    created: { companies: c.created, inboxes: i.created, people: p.created },
  };
}
