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
//
// An AI column's table examples (P#61, G#49, G#19) are laid out by
// ai-examples.mjs into the text sent as each request's instructions
// (config.examples_text), next to the binding kept as exported
// (config.table_examples). Its remembered answers then depend on the examples
// too, so two variants with one prompt and other examples never share one.
//
// A variant is complete (every canonical position of the three tables, plus
// any extension positions: original-keys.mjs ORIGINAL_EXTENSIONS) or an overlay
// (only a client's own personalisation rows, OVERLAY_POSITIONS), which
// loadOriginals composes with "default". A personalisation column notes the
// variant whose text it runs (config.text_variant), and G#19 carries
// config.on_error "empty" (the engine reads a failure as empty, as Clay does).

import { examplesFor } from "./ai-examples.mjs";
import { keysOf, knownPosition, ORIGINAL_COUNTS, ORIGINAL_KINDS, OVERLAY_POSITIONS } from "./original-keys.mjs";

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
 *             definition: Record<string, any>, unknown_refs: string[], source_sha256: string, text_variant?: string }} OriginalRow
 *   text_variant: set on a row loadOriginals copied from the base into an overlay ("default"): the variant
 *   whose text the row is, where variant names the variant the rows were loaded for
 * @typedef {Map<string, OriginalRow>} Originals  keyed "kind:position", e.g. "companies:24"
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 * @typedef {{ shape: "complete" | "overlay" | "partial", kinds: { people: boolean, inboxes: boolean } }} Shape
 */

/**
 * What a variant's rows make: "complete" (a row at every canonical position
 * of the three tables, 1..ORIGINAL_COUNTS, and any extension positions),
 * "overlay" (rows only at OVERLAY_POSITIONS: for each kind it holds, all six of
 * that kind; People only, General only, or both) or "partial" (anything else,
 * a row at a position knownPosition refuses included). kinds: which of People
 * and General the rows hold.
 *
 * @param {Array<{ template_kind: string, position: number }>} rows
 * @returns {Shape}
 */
export function shapeOf(rows) {
  /** @type {Record<string, Set<number>>} */
  const at = { companies: new Set(), people: new Set(), inboxes: new Set() };
  let unknown = false;
  for (const r of rows ?? []) {
    const k = r?.template_kind;
    const p = Number(r?.position);
    if (!Object.hasOwn(at, k) || !knownPosition(/** @type {any} */ (k), p) || at[k].has(p)) {
      unknown = true;
      continue;
    }
    at[k].add(p);
  }
  const kinds = { people: at.people.size > 0, inboxes: at.inboxes.size > 0 };
  if (unknown) return { shape: "partial", kinds };
  const canonical = (k) => {
    for (let p = 1; p <= ORIGINAL_COUNTS[k]; p++) if (!at[k].has(p)) return false;
    return true;
  };
  if (ORIGINAL_KINDS.every(canonical)) return { shape: "complete", kinds };
  const overlayKind = (k) => !at[k].size || (at[k].size === OVERLAY_POSITIONS[k].length && OVERLAY_POSITIONS[k].every((p) => at[k].has(p)));
  if (!at.companies.size && (kinds.people || kinds.inboxes) && overlayKind("people") && overlayKind("inboxes")) return { shape: "overlay", kinds };
  return { shape: "partial", kinds };
}

/** The rows found per kind, canonical positions only (OriginalsMissing's counts). */
function canonicalCounts(rows) {
  /** @type {Record<string, number>} */
  const counts = { companies: 0, people: 0, inboxes: 0 };
  for (const r of rows) if (Object.hasOwn(counts, r.template_kind) && r.position <= ORIGINAL_COUNTS[r.template_kind]) counts[r.template_kind]++;
  return counts;
}

/** One variant's rows, or none before migration 125. */
async function variantRows(db, variant) {
  try {
    const { rows } = await db.query(
      `SELECT variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition, unknown_refs, source_sha256
         FROM enrich_originals WHERE variant = $1`,
      [variant]
    );
    return rows;
  } catch (e) {
    if (e?.code !== "42P01") throw e; // migration 125 not applied: nothing is loaded
    return [];
  }
}

/**
 * Every original column of one variant, keyed "kind:position". A complete
 * variant is returned as stored (its extension rows too). An overlay is
 * composed with the base (complete, else OriginalsMissing(base, ...)): the
 * base's map with the overlay's rows put in their places, every row copied
 * from the base carrying text_variant "default" (the shared text, whatever
 * the base's own name). Anything else throws OriginalsMissing(variant, ...).
 *
 * @param {Db} db
 * @param {string} [variant]
 * @param {{ base?: string }} [opts]  the variant an overlay is composed with ("default"; the tests pass their own)
 * @returns {Promise<Originals>}
 */
export async function loadOriginals(db, variant = "default", { base = "default" } = {}) {
  const rows = await variantRows(db, variant);
  const { shape } = shapeOf(rows);
  /** @type {Originals} */
  const out = new Map();
  if (shape === "complete") {
    for (const r of rows) out.set(`${r.template_kind}:${r.position}`, r);
    return out;
  }
  if (shape !== "overlay" || base === variant) throw new OriginalsMissing(variant, canonicalCounts(rows));
  const baseRows = await variantRows(db, base);
  if (shapeOf(baseRows).shape !== "complete") throw new OriginalsMissing(base, canonicalCounts(baseRows));
  for (const r of baseRows) out.set(`${r.template_kind}:${r.position}`, { ...r, text_variant: "default" });
  for (const r of rows) out.set(`${r.template_kind}:${r.position}`, r);
  return out;
}

/**
 * How many originals are loaded, for the Companies tab's pill and the worker's
 * heartbeat: the default set, and the client's own variant when one is loaded.
 * complete: every canonical position present (extensions allowed); a client's
 * overlay counts as complete while the default is. total: the row count.
 *
 * @param {Db} db
 * @param {string | null} [variant]  a client's variant name (templates.mjs variantName), or null
 * @returns {Promise<{ default: { total: number, complete: boolean },
 *   client: { variant: string, total: number, shape: Shape["shape"], complete: boolean } | null }>}
 */
export async function originalsSummary(db, variant = null) {
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT variant, template_kind, position FROM enrich_originals WHERE variant = ANY($1::text[])`,
      [variant && variant !== "default" ? ["default", variant] : ["default"]]
    ));
  } catch (e) {
    if (e?.code !== "42P01") throw e;
  }
  const of = (v) => rows.filter((r) => r.variant === v);
  const defaultComplete = shapeOf(of("default")).shape === "complete";
  const own = variant && variant !== "default" ? shapeOf(of(variant)).shape : null;
  return {
    default: { total: of("default").length, complete: defaultComplete },
    client: variant && variant !== "default" && own
      ? { variant, total: of(variant).length, shape: own, complete: own === "complete" || (own === "overlay" && defaultComplete) }
      : null,
  };
}

/**
 * One template's id-to-key map: positions from the variant's definitions,
 * keys from { ...keysOf(kind), ...refs } (extension rows map too). A
 * write-to's target ids use the target template's map.
 *
 * @param {Originals} originals
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {Record<number, string>} [refs]  the template's REFS (position to key)
 * @returns {Map<string, string>}  Clay field id -> our key
 */
export function refMap(originals, kind, refs = {}) {
  /** @type {Record<number, string>} */
  const keys = { ...keysOf(kind), ...refs };
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


// ── Reading an original's definition ───────────────────────────────────────

/** C#n, P#n, G#n: the original's template kind. */
const KIND_OF_LETTER = Object.freeze({ C: "companies", P: "people", G: "inboxes" });
const LETTER_OF_KIND = Object.freeze({ companies: "C", people: "P", inboxes: "G" });

/**
 * "C#24" as { kind: "companies", position: 24 }, or null for anything else
 * (phase 1's "T#17", or null for our own columns).
 *
 * @param {string | null | undefined} from
 * @returns {{ kind: "companies" | "people" | "inboxes", position: number } | null}
 */
export function parseFrom(from) {
  const m = /^([CPG])#(\d+)$/.exec(String(from ?? ""));
  return m ? { kind: /** @type {any} */ (KIND_OF_LETTER[m[1]]), position: Number(m[2]) } : null;
}

/** "companies", 24 -> "C#24" */
export const fromOf = (kind, position) => `${LETTER_OF_KIND[kind]}#${position}`;

/**
 * The original row a spec names, or an error saying which one is missing.
 *
 * @param {Originals} originals
 * @param {string} from  "C#24"
 * @returns {OriginalRow}
 */
export function originalOf(originals, from) {
  const p = parseFrom(from);
  if (!p) throw new Error(`"${from}" is not an original column`);
  const row = originals.get(`${p.kind}:${p.position}`);
  if (!row) throw new Error(`The original ${from} is not loaded`);
  return row;
}

/**
 * An id-to-key map that holds only the given positions of one kind: an
 * original compiled a second time into another template (an instance, D8) may
 * read only the references its REFS name, so any other reference stays unknown
 * and the compiler refuses it.
 *
 * @param {Originals} originals
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {Record<number, string>} refs  position to key
 * @returns {Map<string, string>}
 */
export function instanceMap(originals, kind, refs) {
  const out = new Map();
  for (const [pos, key] of Object.entries(refs)) {
    const row = originals.get(`${kind}:${pos}`);
    if (row) out.set(row.clay_field_id, key);
  }
  return out;
}

/** Clay's data types as enrich_columns.data_type holds them. */
const DATA_TYPES = Object.freeze({ text: "text", boolean: "boolean", url: "url", json: "json", number: "number", email: "text", select: "text" });

/**
 * The value of a constant formula: a JavaScript string literal ("\"power\""),
 * true, false or a number. undefined for anything else (an expression).
 *
 * @param {string | null | undefined} formula
 * @returns {string | number | boolean | undefined}
 */
export function literal(formula) {
  if (formula == null) return undefined;
  const t = String(formula).trim();
  if (/^"(?:[^"\\]|\\.)*"$/s.test(t)) {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return undefined;
}

/** One of an action's input bindings, by Clay's input name. */
export function bindingOf(def, name) {
  const list = def?.settings?.inputsBinding;
  return Array.isArray(list) ? list.find((b) => b?.name === name) ?? null : null;
}

/** An input binding's formula text, or null. */
export const bindingText = (def, name) => {
  const b = bindingOf(def, name);
  return typeof b?.formulaText === "string" ? b.formulaText : null;
};

/**
 * A use-ai column's answer fields, in Clay's order, each { type, description,
 * options? }: options are the texts of a select field's choices. A column
 * with no readable fields answers one text field, "response".
 *
 * @param {Record<string, any> | null} def
 * @returns {Record<string, { type: string, description: string, options?: string[] }>}
 */
export function answerFields(def) {
  const raw = bindingOf(def, "answerSchemaType")?.formulaMap?.fields;
  let parsed = null;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      const lit = literal(raw);
      if (typeof lit === "string") {
        try {
          parsed = JSON.parse(lit);
        } catch {
          parsed = null;
        }
      }
    }
  }
  /** @type {Record<string, { type: string, description: string, options?: string[] }>} */
  const out = {};
  for (const [name, f] of Object.entries(parsed && typeof parsed === "object" ? parsed : {})) {
    const type = typeof f?.type === "string" && f.type ? f.type : "string";
    const field = { type, description: typeof f?.description === "string" ? f.description : "" };
    if (type === "select") {
      let opts = f?.options;
      if (typeof opts === "string") {
        try {
          opts = JSON.parse(opts);
        } catch {
          opts = [];
        }
      }
      field.options = (Array.isArray(opts) ? opts : []).map((o) => (o && typeof o === "object" ? o.text : o)).filter((o) => typeof o === "string" && o);
    }
    out[name] = field;
  }
  return Object.keys(out).length ? out : { response: { type: "string", description: "" } };
}

/**
 * The host an http-api-v2 column calls: from its url formula's leading string
 * literal (the rest may be an expression, as Google's DNS URL is).
 *
 * @param {Record<string, any> | null} def
 * @returns {string | null}
 */
export function urlHost(def) {
  const t = bindingText(def, "url");
  if (!t) return null;
  const m = /^\s*"((?:[^"\\]|\\.)*)"/.exec(t);
  if (!m) return null;
  try {
    return new URL(JSON.parse(`"${m[1]}"`)).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// ── The compiler ───────────────────────────────────────────────────────────

/**
 * @typedef {{ in: string, find?: string, replace?: string, append?: string, and?: string, why: string }} ColumnChange
 *   An exact change to one compiled field ("run_if", "formula", "waterfall[i]" or "inputs.<name>"):
 *   find replaced by replace (find must occur once), or append added at the end. On "run_if" only,
 *   and: a clause that must also hold. The run condition becomes "(<compiled>) && <clause>"
 *   (runIfAnd), or the clause alone when there was none, so the clause can't bind to the last term
 *   of an original whose top level has "||".
 * @typedef {{ key: string, from?: string | null, kind: "input" | "formula" | "waterfall" | "action", action?: string,
 *             model_setting?: string, tool?: "web_search" | "none", flag?: string[], key_env?: string,
 *             written?: boolean, change?: boolean, phase?: number, name?: string, formula?: string,
 *             waterfall?: string[], run_if?: string | null, inputs?: Record<string, string>,
 *             config?: Record<string, any>, changes?: ColumnChange[], memory_days?: string | number,
 *             data_type?: string, description?: string, note?: string, why?: string, provider?: string,
 *             hidden?: boolean, on_error?: "empty", optional?: boolean }} ColumnSpec
 *   A template column as the template modules declare it (company-template-v2.mjs, inbox-template.mjs,
 *   people-template.mjs). from: "C#24", "P#11", "G#39" (compiled from that original), "T#17" (phase 1's
 *   template) or null (ours). A spec's own formula, waterfall, run_if (even null) or inputs replace the
 *   original's. on_error "empty": a failure of the column is read as empty by the steps after it, as in
 *   Clay (engine.mjs), kept in config.on_error. optional: the template leaves the column out when the
 *   originals don't hold its original (an extension position).
 * @typedef {{ own: Map<string, string>, targets?: Record<string, Map<string, string>>,
 *             cellFor?: (kind: string, key: string) => string | null, record?: Record<string, string> }} CompileMaps
 *   own: the template's id-to-key map; targets: the write-to targets' maps by kind; cellFor: the cell a
 *   write-to fills for a target column (an input as itself, a D30 column as written_<key>); record: what
 *   lookup_company_data answers under each Clay name the originals read (P#8).
 */

/** The keyed provider steps, their key and their vendor (pipeline-actions.mjs KEYED_STEPS). */
const KEYED = Object.freeze({
  findymail_find_work_email: { key: "FINDYMAIL_API_KEY", vendor: "Findymail" },
  prospeo_find_work_email: { key: "PROSPEO_API_KEY", vendor: "Prospeo" },
  anymail_finder: { key: "ANYMAIL_FINDER_API_KEY", vendor: "Anymail Finder" },
  enrichley_verify_email: { key: "ENRICHLEY_API_KEY", vendor: "Enrichley" },
  findymail_find_work_email_from_linkedin: { key: "FINDYMAIL_API_KEY", vendor: "Findymail" },
  prospeo_linkedin_email_search: { key: "PROSPEO_API_KEY", vendor: "Prospeo" },
});

/** Bindings an http-api-v2 column sends as itself, and the ones that only steer Clay's own client. */
const SECRET_HEADER = /^authorization$/i;
const REDACTED = /\[redacted\]/i;

/**
 * A run condition with one more clause that must hold: "(<run_if>) && <clause>",
 * or the clause alone when there was none. The newline before the closing
 * bracket keeps a trailing line comment in the original from swallowing it, as
 * formula.mjs wraps every expression it evaluates.
 *
 * @param {string | null | undefined} runIf
 * @param {string} clause
 * @returns {string}
 */
export function runIfAnd(runIf, clause) {
  const extra = String(clause ?? "").trim();
  if (!extra) throw new Error("A run condition change has no clause to add");
  return runIf == null || !String(runIf).trim() ? extra : `(${runIf}\n) && ${extra}`;
}

/** Applies a column's changes to its compiled fields. */
function applyChanges(row, changes) {
  for (const c of changes ?? []) {
    const where = String(c.in ?? "");
    if (c.and != null) {
      if (where !== "run_if") throw new Error(`${row.key}: a clause to add ("and") is only for the run condition, not "${where}"`);
      row.run_if = runIfAnd(row.run_if, c.and);
      continue;
    }
    const edit = (text) => {
      if (c.append != null) return `${String(text ?? "")}${c.append}`;
      return applyChange(text, { find: c.find, replace: c.replace ?? "", in: `${row.key}.${where}`, why: c.why });
    };
    if (where === "run_if") row.run_if = edit(row.run_if);
    else if (where === "formula") row.formula = edit(row.formula);
    else if (/^waterfall\[\d+\]$/.test(where)) {
      const i = Number(/\[(\d+)\]/.exec(where)[1]);
      if (!Array.isArray(row.waterfall) || i >= row.waterfall.length) throw new Error(`${row.key}: no waterfall step ${i}`);
      row.waterfall[i] = edit(row.waterfall[i]);
    } else if (where.startsWith("inputs.")) {
      const name = where.slice("inputs.".length);
      if (!(name in row.inputs)) throw new Error(`${row.key}: no input ${name}`);
      row.inputs[name] = edit(row.inputs[name]);
    } else throw new Error(`${row.key}: a change to "${where}" is not supported`);
  }
}

/**
 * One template column compiled into an enrich_columns row: the original's
 * formula, waterfall, run condition, inputs and action settings, rewritten by
 * the maps, with the column's changes applied and its spec's own settings
 * (model setting, tool, flags, key_env) in config. Rules for AI columns (2A.1):
 * the model from the setting named after the column, max_tool_calls from it,
 * no user location, Clay's answer fields with their types, keep_na, the table
 * examples and runBudget kept in config as exported, and the examples' text
 * sent as the request's instructions (ai-examples.mjs). Each paid column gets
 * its own memory kind ("<setting key>_v1", or "<action>_v1").
 *
 * A reference the maps don't hold is refused, never guessed: the compiled text
 * would otherwise read nothing.
 *
 * @param {ColumnSpec} spec
 * @param {Originals} originals
 * @param {CompileMaps} maps
 * @returns {Record<string, any>} an enrich_columns row (key, name, kind, action, formula, waterfall,
 *   inputs, config, run_if, data_type, description, provider, needs_env, phase, hidden, clay_field_id);
 *   the template sets position
 */
export function compileColumn(spec, originals, maps) {
  const orig = parseFrom(spec.from) ? originalOf(originals, /** @type {string} */ (spec.from)) : null;
  const def = orig?.definition ?? null;
  const settings = def?.settings ?? {};
  const own = maps?.own ?? new Map();
  /** @type {string[]} */
  const unknown = [];
  const rw = (t) => {
    if (t == null) return null;
    const r = rewriteRefs(t, own);
    for (const u of r.unknown) if (!unknown.includes(u)) unknown.push(u);
    return r.text;
  };
  const row = {
    key: spec.key,
    name: spec.name ?? orig?.name ?? spec.key,
    kind: spec.kind,
    action: null,
    formula: null,
    waterfall: null,
    inputs: {},
    config: {},
    run_if: null,
    data_type: spec.data_type ?? DATA_TYPES[settings.dataTypeSettings?.type] ?? (spec.kind === "action" ? "json" : "text"),
    description: null,
    provider: spec.provider ?? null,
    needs_env: [],
    phase: spec.phase ?? 1,
    hidden: spec.hidden ?? false,
    clay_field_id: orig?.clay_field_id ?? null,
  };
  const runIf = () => ("run_if" in spec ? spec.run_if ?? null : rw(settings.conditionalRunFormulaText ?? null));

  if (spec.kind === "input") {
    row.provider ??= "Input";
  } else if (spec.kind === "formula") {
    row.formula = spec.formula ?? rw(settings.formulaText ?? null);
    if (row.formula == null) throw new Error(`${spec.key}: ${spec.from ?? "the spec"} has no formula`);
    row.provider ??= "Formula";
  } else if (spec.kind === "waterfall") {
    if (spec.waterfall) row.waterfall = [...spec.waterfall];
    else if (Array.isArray(settings.formulaWaterfall)) {
      row.waterfall = settings.formulaWaterfall.map((s) => rw(typeof s === "string" ? s : s?.formula ?? ""));
    } else if (settings.formulaText != null) {
      row.waterfall = [rw(settings.formulaText)];
    } else throw new Error(`${spec.key}: ${spec.from ?? "the spec"} has no formula or waterfall`);
    // D30: a column the write-tos fill reads the written value first.
    if (spec.written) row.waterfall = [`{{written_${spec.key}}}`, ...row.waterfall];
    row.provider ??= "Formula";
  } else if (spec.kind === "action") {
    if (!spec.action) throw new Error(`${spec.key}: an action column needs an action`);
    row.action = spec.action;
    compileAction(spec, def, rw, row, maps, runIf, originals);
  } else {
    throw new Error(`${spec.key}: unknown column kind "${spec.kind}"`);
  }

  applyChanges(row, spec.changes);
  if (unknown.length) {
    throw new Error(`${spec.key} (${spec.from}) reads ${unknown.length} column(s) this template does not map: ${unknown.join(", ")}`);
  }
  if (Array.isArray(spec.flag) && spec.flag.length) row.config.flag = [...spec.flag];
  // Set after the action's own config (ai_web replaces row.config).
  if (spec.on_error != null) {
    if (spec.on_error !== "empty") throw new Error(`${spec.key}: on_error must be "empty"`);
    row.config.on_error = "empty";
  }
  // The variant whose text a personalisation step runs: an overlay row's own, "default" for a row composed from the
  // base, a complete variant's own name. The engine's personalisation switch reads it (engine.mjs switchedOff).
  if (Array.isArray(spec.flag) && spec.flag.includes("personalisation")) row.config.text_variant = orig?.text_variant ?? orig?.variant ?? "default";
  if (spec.key_env) {
    row.config.key_env = spec.key_env;
    row.needs_env = []; // a key we may not hold never makes the row wait (R28)
  }
  const whys = (spec.changes ?? []).map((c) => c.why).filter(Boolean);
  const own_note = spec.description ?? spec.note ?? null;
  row.description = orig
    ? [`Clay's ${orig.name} (${spec.from}), ${spec.change || whys.length ? "changed" : "verbatim"}.`, ...whys, own_note].filter(Boolean).join(" ")
    : own_note;
  return row;
}

/** An action column's inputs, config and run condition, by the action it compiles to. */
function compileAction(spec, def, rw, row, maps, runIf, originals) {
  const original = Boolean(def);
  switch (spec.action) {
    case "ai_web": {
      if (!original) throw new Error(`${spec.key}: ai_web compiles from an original use-ai column`);
      if (!spec.model_setting) throw new Error(`${spec.key}: an AI column needs its model setting`);
      const prompt = rw(bindingText(def, "prompt"));
      if (!prompt) throw new Error(`${spec.key}: ${spec.from} has no prompt`);
      const useCase = literal(bindingText(def, "useCase"));
      const examples = bindingText(def, "tableExamples");
      const budget = literal(bindingText(def, "runBudget"));
      const cents = Number(literal(bindingText(def, "maxCostInCents")));
      const answer = answerFields(def);
      // The examples laid out for the requests (ai-examples.mjs), or why they can't be read: never a guess. Their
      // references name columns of the column's own table, read from the variant's originals, not from this template.
      /** @type {Record<string, any>} */
      const shown = {};
      if (examples != null) {
        const ex = examplesFor(def, originals, /** @type {{ kind: any }} */ (parseFrom(spec.from)).kind, Object.keys(answer)[0]);
        if ("error" in ex) shown.examples_error = ex.error;
        else Object.assign(shown, { examples_text: ex.text, examples_count: ex.count, examples_sha: ex.sha });
      }
      row.inputs = { prompt, memory_key: prompt };
      // Sent with examples, the remembered answer depends on them too: two variants with one prompt and other
      // examples never share an answer. The memory kind stays "<setting>_v1".
      if (shown.examples_count > 0) row.inputs.memory_key = `[(${prompt}\n), ${JSON.stringify(`examples:${shown.examples_sha}`)}].join("\\n")`;
      row.config = {
        model_setting: spec.model_setting,
        tool: spec.tool ?? (useCase === "claygent" ? "web_search" : "none"),
        answer,
        // jsonb keeps no key order, so Clay's order (the first field is the cell's display) is kept as a list.
        answer_order: Object.keys(answer),
        user_location: false,
        keep_na: true,
        memory: `${spec.model_setting}_v1`,
        memory_days: spec.memory_days ?? "email",
        original_model: literal(bindingText(def, "model")) ?? null,
        use_case: useCase ?? null,
        ...(Number.isFinite(cents) && cents > 0 ? { max_cost_cents: cents } : {}),
        // The examples as exported (table_examples, never sent as they are), and as sent: examples_text goes as
        // each request's instructions (actions.mjs aiWeb) with examples_count and examples_sha beside it, or
        // examples_error says why they could not be read, and the column is then never run.
        ...(examples != null ? { table_examples: examples, run_budget: budget ?? null, ...shown } : {}),
      };
      row.run_if = runIf();
      row.needs_env = ["OPENAI_API_KEY"];
      row.provider ??= "OpenAI";
      row.data_type = "json";
      return;
    }
    case "check_url":
    case "normalize_url": {
      const names = spec.action === "check_url" ? ["url", "tryVariants", "treatTimeoutsAsInvalid"] : ["url", "type"];
      for (const n of names) {
        const t = bindingText(def, n);
        if (t != null) row.inputs[n] = rw(t);
      }
      if (!row.inputs.url) throw new Error(`${spec.key}: ${spec.from} has no url input`);
      row.run_if = runIf();
      row.provider ??= spec.action === "check_url" ? "Website check" : "Formula";
      row.data_type = "json";
      return;
    }
    case "write_to_table": {
      const colMap = bindingOf(def, "columnValuesToColumnMappings")?.formulaMap ?? {};
      const objMap = bindingOf(def, "objectPathsToColumnMappings")?.formulaMap ?? {};
      const ids = [...Object.keys(colMap), ...Object.keys(objMap)];
      const targets = maps?.targets ?? {};
      const kind = Object.keys(targets).find((k) => ids.length > 0 && ids.every((id) => targets[k].has(id)));
      if (!kind) throw new Error(`${spec.key}: the columns ${spec.from} writes are in no target template`);
      const tmap = targets[kind];
      /** @type {Record<string, string>} */
      const cells = {};
      /** @type {string[]} */
      const unmapped = [];
      const cellOf = (tkey) => {
        const cell = maps?.cellFor ? maps.cellFor(kind, tkey) : tkey;
        if (cell) cells[tkey] = cell;
        else if (!unmapped.includes(tkey)) unmapped.push(tkey);
      };
      for (const [id, expr] of Object.entries(colMap)) {
        const tkey = /** @type {string} */ (tmap.get(id));
        row.inputs[`map:${tkey}`] = rw(String(expr));
        cellOf(tkey);
      }
      /** @type {Record<string, string>} */
      const objectPaths = {};
      for (const [id, pathExpr] of Object.entries(objMap)) {
        const tkey = /** @type {string} */ (tmap.get(id));
        const path = literal(String(pathExpr));
        if (typeof path !== "string" || !path) throw new Error(`${spec.key}: an object path of ${spec.from} is not a plain name`);
        objectPaths[tkey] = path;
        cellOf(tkey);
      }
      const array = literal(bindingText(def, "mode")) === "arrayOfObjects";
      if (array) {
        const items = bindingText(def, "value");
        if (!items) throw new Error(`${spec.key}: ${spec.from} writes an array but names none`);
        row.inputs.items = rw(items);
      }
      row.config = {
        target_kind: kind,
        mode: array ? "array" : "one",
        object_paths: objectPaths,
        cells,
        row_key: array ? "company_value" : "company_column",
        ...(unmapped.length ? { unmapped } : {}),
        ...(spec.config ?? {}),
      };
      row.run_if = runIf();
      row.provider ??= "Write to table";
      return;
    }
    case "reoon_verify": {
      const qs = bindingOf(def, "queryString")?.formulaMap ?? {};
      const email = rw(typeof qs.email === "string" ? qs.email : null);
      if (!email) throw new Error(`${spec.key}: ${spec.from} sends Reoon no address`);
      row.inputs = { email, memory_key: email };
      row.config = { mode: literal(qs.mode) ?? "power", memory: "reoon_v1", memory_days: "email" };
      row.run_if = runIf();
      row.needs_env = ["ENRICH_REOON_API_KEY"];
      row.provider ??= "Reoon";
      return;
    }
    case "dns_mx": {
      const url = rw(bindingText(def, "url"));
      if (!url) throw new Error(`${spec.key}: ${spec.from} has no url`);
      row.inputs = { url, memory_key: url };
      row.config = { memory: "dns_mx_v1", memory_days: 30 };
      row.run_if = runIf();
      row.provider ??= "Google DNS";
      return;
    }
    case "find_emails_in_text": {
      const t = bindingText(def, "text");
      if (!t) throw new Error(`${spec.key}: ${spec.from} has no text input`);
      row.inputs = { text: rw(t), ...(spec.inputs ?? {}) };
      row.run_if = runIf();
      row.provider ??= "Formula (stand-in)";
      return;
    }
    case "lookup_company_data": {
      row.inputs = { ...(spec.inputs ?? {}) };
      row.config = { record: { ...(maps?.record ?? {}) }, ...(spec.config ?? {}) };
      row.run_if = runIf();
      row.provider ??= "Clay tab";
      return;
    }
    case "waiting": {
      row.inputs = {};
      row.config = { why: spec.why ?? spec.note ?? "Waiting for the original", ...(def?.settings?.actionKey ? { clay_action: def.settings.actionKey } : {}) };
      row.run_if = null; // never run: nothing it reads matters
      row.provider ??= "Waiting for the original";
      return;
    }
    case "anymail_finder": {
      const method = bindingText(def, "method");
      const url = bindingText(def, "url");
      const body = bindingText(def, "body");
      if (!url) throw new Error(`${spec.key}: ${spec.from} has no url`);
      row.inputs = {
        method: rw(method ?? "\"POST\""),
        url: rw(url),
        ...(body != null ? { body: rw(body) } : {}),
      };
      row.inputs.memory_key = `JSON.stringify([${row.inputs.url}, ${row.inputs.body ?? "null"}])`;
      /** @type {Record<string, string>} */
      const headers = {};
      for (const [h, v] of Object.entries(bindingOf(def, "headers")?.formulaMap ?? {})) {
        if (SECRET_HEADER.test(h) || REDACTED.test(String(v))) continue; // built from the key at run time
        const lit = literal(String(v));
        if (typeof lit === "string") headers[h] = lit;
      }
      row.config = { headers, memory: "anymail_finder_v1", memory_days: "email" };
      row.run_if = runIf();
      row.provider ??= KEYED.anymail_finder.vendor;
      return;
    }
    default: {
      if (KEYED[spec.action]) {
        /** @type {string[]} */
        const exprs = [];
        for (const b of def?.settings?.inputsBinding ?? []) {
          if (typeof b?.formulaText !== "string") continue;
          row.inputs[b.name] = rw(b.formulaText);
          exprs.push(row.inputs[b.name]);
        }
        if (!exprs.length) throw new Error(`${spec.key}: ${spec.from} has no inputs`);
        row.inputs.memory_key = `JSON.stringify([${exprs.join(", ")}])`;
        row.config = { memory: `${spec.action}_v1`, memory_days: "email" };
        row.run_if = runIf();
        row.provider ??= KEYED[spec.action].vendor;
        return;
      }
      // Our own action (lead_lookup, client_area, held_people, people_at_company, later ...):
      // its inputs, run condition and config are the spec's.
      row.inputs = { ...(spec.inputs ?? {}) };
      row.config = { ...(spec.config ?? {}) };
      row.run_if = "run_if" in spec ? spec.run_if ?? null : original ? rw(def?.settings?.conditionalRunFormulaText ?? null) : null;
    }
  }
}
