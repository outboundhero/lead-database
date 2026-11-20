// Clay's table examples of a use-ai column, as they go with every request of
// the column (P#61, G#49 and G#19 hold some).
//
// Clay keeps a column's examples in its "tableExamples" input binding: a JSON
// list with one { inputs, output, recordId } per example. Each input is keyed
// by the reference exactly as the prompt writes it ({{f_<id>}}, or
// {{f_<id>}}?.field for an AI column's answer field) and holds the text saved
// with the example; output is the answer's first field as plain text. The
// examples carry their own inputs, so the rows they came from are never read.
//
// How Clay hands them to the model is not documented. The layout here is the
// one that fits Clay's own token counts best (measured 2026-11-20 on three
// columns and two models): a fixed sentence of ours, then for each example its
// inputs as JSON keyed by column name and its answer as JSON. Clay's exact
// wording is not known. The text goes as the request's instructions
// (actions.mjs aiWeb); the prompt itself is sent unchanged.
//
// The examples are client text: they live in enrich_originals and reach
// enrich_columns.config (examples_text) only when a template is compiled
// (compile-original.mjs). None is in this public repo.

import { createHash } from "node:crypto";

/** The sentence in front of the examples (ours: Clay's wording is not documented). */
export const EXAMPLES_PREAMBLE =
  "Examples from other rows of this table. Each example is that row's inputs as JSON, keyed by column name, then the answer expected for it as JSON.";

/** {{f_<id>}} at the start of an example's input key; what follows it is a path into that column's value. */
const REF = /^\s*\{\{\s*(f_[A-Za-z0-9_]+)\s*\}\}/;
/** One step of a path: ?.name or .name, or ?.["name"], ['name'] or [0]. */
const STEP = /^\s*(?:\??\.\s*([A-Za-z_$][\w$]*)|(?:\?\.)?\[\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+)\s*\])/;

const isObject = (v) => v != null && typeof v === "object" && !Array.isArray(v);

/** The tableExamples binding's text, or null (compile-original.mjs bindingText's rule; read here so the two modules don't import each other). */
function examplesBinding(def) {
  const list = def?.settings?.inputsBinding;
  const b = Array.isArray(list) ? list.find((x) => x?.name === "tableExamples") : null;
  return typeof b?.formulaText === "string" ? b.formulaText : null;
}

/** A bracketed step's name: a quoted string's text, or the index as written. Null when it can't be read. */
function stepName(raw) {
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (raw.startsWith("'")) return raw.slice(1, -1).replace(/\\(.)/g, "$1");
  return raw;
}

/**
 * The column name an example's input key stands for: the referenced column's
 * name, then each step of the path after it joined with dots
 * ("{{f_x}}?.company_summary" is "Claygent.company_summary"). Null when the
 * key is not a reference to a column of the table, or its path can't be read.
 *
 * @param {string} key
 * @param {Map<string, string>} names  Clay field id -> column name, of the column's own table
 * @returns {string | null}
 */
function referenceName(key, names) {
  const m = REF.exec(key);
  if (!m || !names.has(m[1])) return null;
  const parts = [String(names.get(m[1]) ?? "")];
  let rest = key.slice(m[0].length);
  while (rest.trim()) {
    const s = STEP.exec(rest);
    if (!s) return null;
    const step = s[1] ?? stepName(s[2]);
    if (step == null) return null;
    parts.push(step);
    rest = rest.slice(s[0].length);
  }
  return parts.join(".");
}

/** An object's JSON from [key, value] pairs in their order: compact, as JSON.stringify writes one, no key moved. */
const objectJson = (pairs) => `{${pairs.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",")}}`;

/**
 * A use-ai column's table examples as the text sent with its requests.
 *
 * Each example, in stored order: its inputs as one JSON object in their stored
 * order, each key the column name of its reference (a name already used by
 * another reference gets " (2)", " (3)", in the order the references first
 * appear) and each value the saved text ("" for null), then on the next line
 * its answer, { [answerField]: output } ("" for a null output). The text is
 * EXAMPLES_PREAMBLE and the examples, a blank line between each.
 *
 * Unreadable examples give { error } and nothing else, never a guess: "not
 * JSON", "not a list", "an example has no inputs object", or "an example reads
 * a column this table does not hold" (an id of no column of the table, a key
 * that is not a reference, or a path that can't be read).
 *
 * @param {Record<string, any> | null} def  the original's definition (enrich_originals.definition)
 * @param {import("./compile-original.mjs").Originals} originals  the variant's originals: the column names
 * @param {"companies" | "people" | "inboxes"} kind  the column's own table, whose columns its references name
 * @param {string} answerField  the column's first answer field ("response" for P#61, G#49 and G#19)
 * @returns {{ text: string | null, count: number, sha: string | null } | { error: string }}
 *   text and count; sha: the first 16 hex of the text's sha256. No examples (an empty list, or no
 *   binding): { text: null, count: 0, sha: null }, and the column runs without any.
 */
export function examplesFor(def, originals, kind, answerField) {
  const raw = examplesBinding(def);
  if (raw == null) return { text: null, count: 0, sha: null };
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return { error: "not JSON" };
  }
  if (!Array.isArray(list)) return { error: "not a list" };
  if (!list.length) return { text: null, count: 0, sha: null };

  /** @type {Map<string, string>} */
  const names = new Map();
  for (const row of originals?.values?.() ?? []) if (row?.template_kind === kind) names.set(row.clay_field_id, row.name);
  /** @type {Map<string, string>} */
  const labels = new Map(); // an input key -> its name in the examples
  const used = new Set();
  const labelOf = (key) => {
    if (labels.has(key)) return labels.get(key);
    const base = referenceName(key, names);
    if (base == null) return null;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} (${n})`;
    used.add(name);
    labels.set(key, name);
    return name;
  };

  const blocks = [];
  for (const example of list) {
    if (!isObject(example) || !isObject(example.inputs)) return { error: "an example has no inputs object" };
    /** @type {Array<[string, unknown]>} */
    const inputs = [];
    for (const [key, value] of Object.entries(example.inputs)) {
      const name = labelOf(key);
      if (name == null) return { error: "an example reads a column this table does not hold" };
      inputs.push([name, value ?? ""]);
    }
    blocks.push(`${objectJson(inputs)}\n${objectJson([[answerField, example.output ?? ""]])}`);
  }
  const text = [EXAMPLES_PREAMBLE, ...blocks].join("\n\n");
  return { text, count: list.length, sha: createHash("sha256").update(text).digest("hex").slice(0, 16) };
}
