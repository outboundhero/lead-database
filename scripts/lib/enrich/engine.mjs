// One row of a Clay-tab table, evaluated the way Clay does it: every column in
// dependency order — formulas and waterfalls straight from the client's Clay
// table, actions behind their run conditions.
//
// The engine never writes to the database itself. It reports through hooks:
//   changed(key, cell)  a cell's new state (the worker batches these)
//   running(key, prev)  an external call is about to start (the grid shows a spinner)
//   ran(run)            an external call finished (kept in enrich_cell_runs)

import { createHash } from "node:crypto";
import { emptyAsText, evaluate, isEmpty, makeContext, refs } from "./formula.mjs";
import { ACTIONS, capped } from "./actions.mjs";

const DISPLAY_MAX = 300;
const msg = (e) => String(e?.message ?? e).slice(0, 300);

/**
 * For a list filter (`["janitorial", …].some(…)`), the list terms that occur
 * in the text the formula reads — so a cell can say WHY it is true or false.
 * An explanation only: the formula's own result is what counts.
 */
function listMatches(expr, values) {
  const m = /\[\s*(['"][^\]]*)\]/s.exec(expr);
  if (!m) return null;
  const terms = [...m[1].matchAll(/(['"])((?:\\.|(?!\1).)*)\1/g)].map((t) => t[2].toLowerCase());
  if (terms.length < 10) return null;
  const hay = [...refs(expr)]
    .map((k) => values[k])
    .filter((v) => !isEmpty(v) && typeof v !== "boolean")
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ")
    .toLowerCase();
  const hits = [...new Set(terms.filter((t) => t && hay.includes(t)))];
  return hits.length ? `Matched: ${hits.slice(0, 6).map((t) => `"${t}"`).join(", ")}${hits.length > 6 ? ` +${hits.length - 6}` : ""}` : null;
}

/** JSON with sorted keys: jsonb reorders object keys, so plain JSON.stringify would see every stored object as changed. */
export function stable(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}

export function displayOf(v) {
  if (isEmpty(v)) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v);
  return s.length > DISPLAY_MAX ? `${s.slice(0, DISPLAY_MAX - 1)}…` : s;
}

/**
 * @param row     { id, created_at, run_force }
 * @param table   { client_tag, keyCounts }
 * @param columns the table's columns in dependency order (formula.order)
 * @param cells   Map column key -> stored cell { status, value, display, note, input_hash }
 * @returns       { values, errors, needsKey, retryable, calls }
 */
export async function runRow({ row, table, columns, cells, env, db, hooks = {} }) {
  const force = new Set(row.run_force ?? []);
  const forced = (key) => force.has("*") || force.has(key);
  const ctx = makeContext();
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  const values = { created_at: created };
  const summary = { errors: 0, needsKey: 0, retryable: null, calls: 0 };

  const put = (col, next) => {
    const cell = {
      status: next.status,
      value: isEmpty(next.value) ? null : next.value,
      display: next.display !== undefined ? (next.display == null ? null : String(next.display).slice(0, DISPLAY_MAX)) : displayOf(next.value),
      note: next.note ? String(next.note).slice(0, 1000) : null,
      input_hash: next.input_hash ?? null,
      runs: next.runs ?? 0,
    };
    // Downstream formulas see a value only when the cell has one.
    values[col.key] = cell.status === "done" && !isEmpty(cell.value) ? cell.value : undefined;
    if (cell.status === "error") summary.errors++;
    if (cell.status === "needs_key") summary.needsKey++;
    const prev = cells.get(col.key);
    const changed =
      !prev ||
      cell.runs > 0 ||
      prev.status !== cell.status ||
      stable(prev.value) !== stable(cell.value) ||
      (prev.display ?? null) !== cell.display ||
      (prev.note ?? null) !== cell.note ||
      (prev.input_hash ?? null) !== cell.input_hash;
    if (changed) hooks.changed?.(col.key, cell);
  };

  for (const col of columns) {
    if (col.kind === "input") {
      const cell = cells.get(col.key);
      if (cell && !isEmpty(cell.value)) values[col.key] = cell.value;
    }
  }

  for (const col of columns) {
    if (col.kind === "input" || col.phase > 1) continue;

    if (col.kind === "formula") {
      try {
        const v = evaluate(ctx, col.formula, values);
        put(col, { status: isEmpty(v) ? "empty" : "done", value: v, note: typeof v === "boolean" ? listMatches(col.formula, values) : null });
      } catch (e) {
        put(col, { status: "error", note: `Formula error: ${msg(e)}` });
      }
      continue;
    }

    if (col.kind === "waterfall") {
      const steps = Array.isArray(col.waterfall) ? col.waterfall : [];
      const errs = [];
      let won = 0;
      let v;
      for (let i = 0; i < steps.length && !won; i++) {
        try {
          const r = evaluate(ctx, steps[i], values);
          if (!isEmpty(r) && r !== false) {
            won = i + 1;
            v = r;
          }
        } catch (e) {
          errs.push(`step ${i + 1}: ${msg(e)}`);
        }
      }
      const note = (won ? `Step ${won} of ${steps.length}` : `All ${steps.length} steps were empty`) +
        (errs.length ? ` (${errs.join("; ")})` : "");
      put(col, { status: won ? "done" : "empty", value: v, note });
      continue;
    }

    // ── action ──
    const impl = ACTIONS[col.action];
    if (!impl) {
      put(col, { status: "error", note: `Unknown action "${col.action}"` });
      continue;
    }
    if (col.run_if) {
      let ok = false;
      let err = null;
      try {
        ok = Boolean(evaluate(ctx, col.run_if, values));
      } catch (e) {
        err = msg(e);
      }
      if (!ok) {
        put(col, { status: "skipped", note: err ? `Run condition could not be evaluated: ${err}` : "Run condition not met" });
        continue;
      }
    }
    const scope = impl.emptyAs === "" ? emptyAsText(values) : values;
    const inputs = {};
    let inputErr = null;
    for (const [name, expr] of Object.entries(col.inputs ?? {})) {
      try {
        inputs[name] = evaluate(ctx, expr, scope);
      } catch (e) {
        inputErr = `${name}: ${msg(e)}`;
        break;
      }
    }
    if (inputErr) {
      put(col, { status: "error", note: `Input error — ${inputErr}` });
      continue;
    }
    const hash = createHash("sha1").update(stable([col.action, col.config ?? {}, inputs])).digest("hex").slice(0, 24);
    const prev = cells.get(col.key);
    if (impl.cache && !forced(col.key) && prev && (prev.status === "done" || prev.status === "empty") && prev.input_hash === hash) {
      // Same inputs as the last run: reuse the answer, never pay for it twice.
      values[col.key] = prev.status === "done" && !isEmpty(prev.value) ? prev.value : undefined;
      continue;
    }
    const missing = (col.needs_env ?? []).filter((k) => !env[k]);
    if (missing.length) {
      put(col, { status: "needs_key", note: `Needs ${missing.join(" and ")} on the worker` });
      continue;
    }

    const local = impl.cache === false; // free lookups: no spinner, no run history
    if (!local) await hooks.running?.(col.key, prev);
    const started = new Date();
    let res;
    try {
      res = await impl.run({ inputs, config: col.config ?? {}, row, table, column: col, db, env });
    } catch (e) {
      res = { status: "error", note: msg(e), retryable: true, run: { error: msg(e) } };
    }
    put(col, {
      status: res.status,
      value: res.value,
      display: res.display,
      note: res.note,
      input_hash: res.status === "error" ? null : hash,
      runs: local ? 0 : 1,
    });
    if (res.status === "error" && res.retryable && !summary.retryable) summary.retryable = `${col.name}: ${res.note}`;
    if (!local) {
      summary.calls++;
      await hooks.ran?.({
        column_key: col.key,
        status: res.status,
        provider: col.provider ?? col.action,
        request: capped(res.run?.request ?? inputs),
        response: capped(res.run?.response ?? null),
        error: res.run?.error ?? (res.status === "error" ? res.note : null),
        http_status: res.run?.http_status ?? null,
        duration_ms: Date.now() - started.getTime(),
        started_at: started.toISOString(),
      });
    }
  }

  return { values, ...summary };
}
