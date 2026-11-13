// The originals compiler: one original Clay column (enrich_originals.definition,
// exactly as the Clay CLI exported it) into one enrich_columns row of a
// pipeline template table (2A.1).
//
// One mechanism for every template: the template's REFS are its overrides on
// ORIGINAL_KEYS (position to key). refMap() turns the variant's definitions
// (position to Clay field id) and those keys into an id-to-key map, and
// rewriteRefs() rewrites every {{f_<id>}} in a definition's text with it. A
// change to an original is an exact substring replacement that must match once
// (applyChange), so a change can't drift silently if the original changes.
//
// The originals hold client text, so they live only in the database (D1); no
// prompt or list is in this public repo. A missing original raises
// OriginalsMissing, which the pull and people-run routes answer with 409
// "The Clay originals are not loaded".

import { ORIGINAL_COUNTS, ORIGINAL_KEYS } from "./original-keys.mjs";

/** {{f_<id>}}: how a Clay formula reads another column. */
export const CLAY_REF = /\{\{\s*(f_[A-Za-z0-9_]+)\s*\}\}/g;

/** All three tables' originals: what a variant must hold to compile. */
export const ORIGINALS_TOTAL = Object.values(ORIGINAL_COUNTS).reduce((a, b) => a + b, 0);

/** The originals of a variant are not (all) in enrich_originals. */
export class OriginalsMissing extends Error {
  /**
   * @param {string} variant
   * @param {Record<string, number>} counts  columns found per template kind
   */
  constructor(variant, counts) {
    const found = Object.entries(ORIGINAL_COUNTS)
      .map(([k, n]) => `${k} ${counts?.[k] ?? 0} of ${n}`)
      .join(", ");
    super(`The Clay originals are not loaded (variant "${variant}": ${found}). Load them with scripts/enrich-seed-originals.mjs.`);
    this.name = "OriginalsMissing";
    this.variant = variant;
    this.counts = counts;
  }
}

/**
 * @typedef {{ variant: string, template_kind: "companies" | "people" | "inboxes", position: number, key: string,
 *             name: string, clay_field_id: string, clay_type: "source" | "basic" | "action", clay_action: string | null,
 *             definition: Record<string, any>, unknown_refs: string[], source_sha256: string }} OriginalRow
 * @typedef {Map<string, OriginalRow>} Originals  keyed "kind:position", e.g. "companies:24"
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 */

/**
 * Every original column of one variant, keyed "kind:position". Throws
 * OriginalsMissing unless all three tables are there in full (68, 88, 76).
 *
 * @param {Db} db
 * @param {string} [variant]
 * @returns {Promise<Originals>}
 */
export async function loadOriginals(db, variant = "default") {
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition, unknown_refs, source_sha256
         FROM enrich_originals WHERE variant = $1`,
      [variant]
    ));
  } catch (e) {
    if (e?.code !== "42P01") throw e; // migration 125 not applied: nothing is loaded
  }
  /** @type {Record<string, number>} */
  const counts = { companies: 0, people: 0, inboxes: 0 };
  /** @type {Originals} */
  const out = new Map();
  for (const r of rows) {
    counts[r.template_kind] = (counts[r.template_kind] ?? 0) + 1;
    out.set(`${r.template_kind}:${r.position}`, r);
  }
  if (Object.entries(ORIGINAL_COUNTS).some(([k, n]) => counts[k] !== n)) throw new OriginalsMissing(variant, counts);
  return out;
}

/**
 * How many originals are loaded, for the Companies tab's pill and the worker's
 * heartbeat: the default set, and the client's own variant when one is loaded.
 *
 * @param {Db} db
 * @param {string | null} [variant]  a client's variant name (templates.mjs variantName), or null
 * @returns {Promise<{ default: { total: number, complete: boolean }, client: { variant: string, total: number, complete: boolean } | null }>}
 */
export async function originalsSummary(db, variant = null) {
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT variant, count(*)::int AS n FROM enrich_originals WHERE variant = ANY($1::text[]) GROUP BY variant`,
      [variant && variant !== "default" ? ["default", variant] : ["default"]]
    ));
  } catch (e) {
    if (e?.code !== "42P01") throw e;
  }
  const n = (v) => rows.find((r) => r.variant === v)?.n ?? 0;
  return {
    default: { total: n("default"), complete: n("default") === ORIGINALS_TOTAL },
    client: variant && variant !== "default" ? { variant, total: n(variant), complete: n(variant) === ORIGINALS_TOTAL } : null,
  };
}

/**
 * One template's id-to-key map: positions from the variant's definitions,
 * keys from { ...ORIGINAL_KEYS[kind], ...refs }. A write-to's target ids use
 * the target template's map.
 *
 * @param {Originals} originals
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {Record<number, string>} [refs]  the template's REFS (position to key)
 * @returns {Map<string, string>}  Clay field id -> our key
 */
export function refMap(originals, kind, refs = {}) {
  /** @type {Record<number, string>} */
  const keys = { ...ORIGINAL_KEYS[kind], ...refs };
  const out = new Map();
  for (const row of originals.values()) {
    if (row.template_kind !== kind) continue;
    const key = keys[row.position];
    if (key) out.set(row.clay_field_id, key);
  }
  return out;
}

/**
 * Rewrites every {{f_<id>}} in a text with our key. An id the map doesn't
 * hold is kept as it is and reported, never guessed.
 *
 * @param {string} text
 * @param {Map<string, string>} idToKey
 * @returns {{ text: string, unknown: string[] }}
 */
export function rewriteRefs(text, idToKey) {
  /** @type {string[]} */
  const unknown = [];
  const out = String(text ?? "").replace(CLAY_REF, (whole, id) => {
    const key = idToKey.get(id);
    if (key) return `{{${key}}}`;
    if (!unknown.includes(id)) unknown.push(id);
    return whole;
  });
  return { text: out, unknown };
}

/**
 * One change to an original: `find` replaced by `replace`, refused unless
 * `find` occurs exactly once in the text.
 *
 * @param {string} text
 * @param {{ find: string, replace: string, in?: string, why?: string }} change
 * @returns {string}
 */
export function applyChange(text, { find, replace, in: where = "the text", why = "" }) {
  const s = String(text ?? "");
  if (typeof find !== "string" || !find) throw new Error(`A change to ${where} has nothing to find`);
  const at = s.indexOf(find);
  if (at < 0) throw new Error(`A change to ${where} found nothing to replace: the original may have changed${why ? ` (${why})` : ""}`);
  if (s.indexOf(find, at + 1) >= 0) throw new Error(`A change to ${where} matches more than once, so it is refused${why ? ` (${why})` : ""}`);
  return s.slice(0, at) + String(replace ?? "") + s.slice(at + find.length);
}

/**
 * @typedef {{ key: string, from?: string | null, kind: "input" | "formula" | "waterfall" | "action", action?: string,
 *             model_setting?: string, tool?: "web_search" | "none", flag?: string[], key_env?: string,
 *             written?: boolean, change?: boolean, phase?: number }} ColumnSpec
 *   A template column as the template modules declare it (company-template-v2.mjs, inbox-template.mjs,
 *   people-template.mjs). from: "C#24", "P#11", "G#39", "T#17" (phase 1's template) or null (ours).
 */

/**
 * One template column compiled into an enrich_columns row: the original's
 * formula, waterfall, run condition, inputs and action settings, rewritten by
 * the maps, with the column's changes applied and its spec's own settings
 * (model setting, tool, flags, key_env) in config. Rules for AI columns (2A.1):
 * the model from the setting named after the column, max_tool_calls from it,
 * no user location, Clay's answer fields with their types, keep_na, and the
 * table examples and runBudget kept in config, never sent.
 *
 * TODO(A): build it (2A.1, 2A.5). Each paid column gets memory kind
 * "<setting key>_v1"; clay_field_id and Clay's name come from the original row.
 *
 * @param {ColumnSpec} spec
 * @param {Originals} originals
 * @param {{ own: Map<string, string>, targets?: Record<string, Map<string, string>> }} maps
 *   own: the template's id-to-key map; targets: the write-to targets' maps by kind
 * @returns {Record<string, any>} an enrich_columns row (key, name, position, kind, action, formula, waterfall,
 *   inputs, config, run_if, data_type, description, provider, needs_env, phase, hidden, clay_field_id)
 */
export function compileColumn(spec, originals, maps) {
  const held = `${originals?.size ?? 0} originals, maps for ${maps?.own ? "the template" : "nothing"}`;
  throw new Error(`TODO(A): compileColumn is not built yet (column ${spec?.key ?? "?"}; ${held})`);
}
