// Clay-style formulas: a JavaScript expression in which {{key}} reads another
// cell of the same row. The client's Clay formulas are stored verbatim (only
// their {{«Column»}} references are rewritten to keys), so evaluating them here
// gives Clay's answer, quirks included — "house" still matches "Warehouse".
//
// An empty cell reads as undefined, which is what the formulas' own optional
// chaining (`{{x}}?.includes(…)`, `!{{x}}`) expects.
//
// node:vm is used for its per-evaluation time limit, NOT as a security
// boundary: formulas come from enrich_columns, written by migrations and
// scripts/enrich-seed-table.mjs. If formulas ever become editable in the UI,
// that editing must be owner-only.

import vm from "node:vm";

const REF = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;
const TIMEOUT_MS = 250;
const compiled = new Map();

export const isEmpty = (v) =>
  v === undefined || v === null || v === "" || (typeof v === "number" && Number.isNaN(v));

/** Column keys an expression reads. */
export function refs(text) {
  const out = new Set();
  for (const m of String(text ?? "").matchAll(REF)) out.add(m[1]);
  return out;
}

function compile(expr) {
  let script = compiled.get(expr);
  if (!script) {
    const src = String(expr).replace(REF, (_, key) => `$[${JSON.stringify(key)}]`);
    script = new vm.Script(`(${src}\n)`, { filename: "formula" });
    compiled.set(expr, script);
    if (compiled.size > 5000) compiled.delete(compiled.keys().next().value);
  }
  return script;
}

// The one Clay helper the copied formulas use (HTTP bodies, Phase 2).
const CLAY = Object.freeze({
  formatForJSON: (v) => JSON.stringify(v == null ? "" : String(v)).slice(1, -1),
});

/** One context per row: the row's values are swapped in before each evaluation. */
export function makeContext() {
  return vm.createContext({ $: {}, Clay: CLAY });
}

export function evaluate(ctx, expr, values) {
  ctx.$ = values;
  return compile(expr).runInContext(ctx, { timeout: TIMEOUT_MS });
}

/** The same values, with empty cells read as "" (for text a prompt is built from). */
export function emptyAsText(values) {
  return new Proxy(values, {
    get: (target, key) => (typeof key === "string" && isEmpty(target[key]) ? "" : target[key]),
  });
}

/**
 * Columns in an order where every column comes after the columns it reads.
 * Clay evaluates by dependency, not by position (CHECK sits left of the Use
 * Domain it reads), so position alone is not enough. Ties keep table order.
 */
export function order(columns) {
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const deps = new Map();
  for (const c of columns) {
    const texts = [c.formula, c.run_if, ...(Array.isArray(c.waterfall) ? c.waterfall : []), ...Object.values(c.inputs ?? {})];
    const d = new Set();
    for (const t of texts) for (const k of refs(t)) if (k !== c.key && byKey.has(k)) d.add(k);
    deps.set(c.key, d);
  }
  const done = new Set();
  const out = [];
  const pending = [...columns].sort((a, b) => a.position - b.position);
  while (pending.length) {
    const i = pending.findIndex((c) => [...deps.get(c.key)].every((k) => done.has(k)));
    if (i === -1) {
      throw new Error(`columns depend on each other in a loop: ${pending.map((c) => c.key).join(", ")}`);
    }
    const [c] = pending.splice(i, 1);
    done.add(c.key);
    out.push(c);
  }
  return out;
}
