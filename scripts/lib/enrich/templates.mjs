// A client's three pipeline template tables on the Clay tab: Companies
// (companies_v2), General inboxes (inboxes_v1) and People (people_v1), each
// one enrich_tables row per client (unique on client_tag, kind, template),
// with columns compiled from the Clay originals in enrich_originals.
//
// ensurePipelineTables() runs inside the transaction of the pull route and the
// people-run route. It refuses a client that still has a retired companies_v1
// table (D24: its pulls wait for Akeesh's decision), raises OriginalsMissing
// while the originals are not loaded (the routes answer 409), and otherwise
// makes or updates the three tables. A client whose own Clay tables were
// exported has its own variant of the originals (its tag in lower case);
// every other client compiles from "default" (D15).

import { loadOriginals } from "./compile-original.mjs";
import { ORIGINAL_COUNTS } from "./original-keys.mjs";
import { COMPANY_TABLE_NAME_V2, COMPANY_TEMPLATE_V2 } from "./company-template-v2.mjs";
import { INBOX_TABLE_NAME, INBOX_TEMPLATE } from "./inbox-template.mjs";
import { PEOPLE_TABLE_NAME, PEOPLE_TEMPLATE } from "./people-template.mjs";
import { normTag } from "./settings.mjs";

/** The three pipeline templates, by enrich_tables.kind. */
export const PIPELINE_TEMPLATES = Object.freeze({
  companies: Object.freeze({ kind: "companies", template: COMPANY_TEMPLATE_V2, name: COMPANY_TABLE_NAME_V2 }),
  inboxes: Object.freeze({ kind: "inboxes", template: INBOX_TEMPLATE, name: INBOX_TABLE_NAME }),
  people: Object.freeze({ kind: "people", template: PEOPLE_TEMPLATE, name: PEOPLE_TABLE_NAME }),
});

/** Templates no longer worked or made (D24). */
export const RETIRED_TEMPLATES = Object.freeze(["companies_v1"]);

/** A client that still has a companies_v1 table: its pulls are refused until Akeesh decides (D24). */
export class RetiredV1Table extends Error {
  /** @param {string} tag */
  constructor(tag) {
    super(`${tag} still has a companies_v1 table: its pulls wait until Akeesh decides what happens to it (delete it, or keep it read-only under another name)`);
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
 * @param {{ variant?: string }} [opts]
 * @returns {Promise<{ id: string, created: boolean }>}
 */
export async function ensureTable(db, tag, kind, { variant = "default" } = {}) {
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
      `Pipeline template ${t.template}, compiled from the Clay originals (variant ${variant})`, t.template,
    ]
  );
  return { id: table.id, created: table.created };
}

/**
 * Brings each template table's columns up to date with its template, compiled
 * from the variant's originals: upserts the columns by key (as
 * ensureTemplateTable did in phase 1) and prunes the columns a template no
 * longer has, with their cells.
 *
 * TODO(A): build it with companyColumnsV2(), inboxColumns() and peopleColumns()
 * (2A.1 to 2A.4); clay_field_id set on every compiled column.
 *
 * @param {Db} db
 * @param {{ companies: string, inboxes: string, people: string }} ids  the three table ids
 * @param {import("./compile-original.mjs").Originals} originals
 * @param {{ settings?: import("./settings.mjs").PipelineSettings | null, variant: string }} opts
 * @returns {Promise<void>}
 */
export async function syncTemplateColumns(db, ids, originals, { settings = null, variant }) {
  throw new Error(
    `TODO(A): syncTemplateColumns is not built yet (variant ${variant}, ${originals.size} originals, tables ${Object.keys(ids).join(", ")}, settings ${settings ? "given" : "not given"})`
  );
}

/**
 * The client's three pipeline tables, made or brought up to date, compiled
 * from its variant of the originals. Runs inside the caller's transaction.
 * Throws RetiredV1Table (D24) or OriginalsMissing; the routes answer 409 to
 * both.
 *
 * @param {Db} db  a client inside the caller's transaction
 * @param {string} tag
 * @param {{ settings?: import("./settings.mjs").PipelineSettings | null }} [opts]
 * @returns {Promise<{ companies: string, inboxes: string, people: string, variant: string }>}  table ids
 */
export async function ensurePipelineTables(db, tag, { settings = null } = {}) {
  const t = normTag(tag);
  if (!t) throw new Error("No client tag");
  if (await hasRetiredV1(db, t)) throw new RetiredV1Table(t);
  const variant = await variantFor(db, t);
  const originals = await loadOriginals(db, variant);
  const companies = (await ensureTable(db, t, "companies", { variant })).id;
  const inboxes = (await ensureTable(db, t, "inboxes", { variant })).id;
  const people = (await ensureTable(db, t, "people", { variant })).id;
  await syncTemplateColumns(db, { companies, inboxes, people }, originals, { settings, variant });
  return { companies, inboxes, people, variant };
}
