// One row of a Clay-tab table, evaluated the way Clay does it: every column in
// dependency order — formulas and waterfalls straight from the client's Clay
// table, actions behind their run conditions.
//
// The engine writes no cells itself. It reports through hooks:
//   changed(key, cell)  a cell's new state (the worker batches these)
//   running(key, prev)  an external call is about to start (the grid shows a spinner)
//   ran(run)            an external call finished (kept in enrich_cell_runs)
// Its one write is the shared memory of paid answers (enrich_memory, below).
//
// Shared memory: an action column with config.memory (a kind such as
// email_search_first_v1) and an input memory_key reuses a paid answer any row,
// table or client already got for that key: the cell takes it, noted "Reused",
// and no provider is called. A done or empty answer is remembered for the
// days enrich_settings gives (company_pipeline.memory_days). A forced re-run
// pays again, as it does past the cell's own cache.
//
// Template tables (enrich_tables.template, the Companies pipeline) are strict:
// a formula, waterfall step, run condition or action input that reads a cell
// in error makes its own cell an error, and one that reads a cell waiting on a
// key makes its own cell wait, so a paid step never runs on a guess (with the
// Reoon key missing, the second email search must not read "nothing usable"
// and pay). Other tables keep their rule: only formulas react, to errors.
//
// Switches (pipeline templates): a column with config.flag (a list of
// switches, settings.mjs FLAGS) runs only while every one of them is on for
// the table's client (flagOn). Otherwise it is skipped, noted "Switched off:
// <switch>", and read as empty.
//
// Keyed steps (pipeline templates): a column with config.key_env runs only
// while that key is on the worker. Without it the cell is skipped, noted
// "Needs <KEY> (not held)", read as empty, with no call and no run record, and
// the row never waits for it (unlike needs_env, which makes the cell wait).
// With it, the step's vendor cap decides (email-vendors.mjs, migration 129).
//
// Memory keys: a compiled AI column remembers by its rendered prompt, so for
// an ai_web column the model in force is put in front of the key (a swapped
// model asks again), and a key over 200 characters is stored as its sha256
// (enrich_memory's primary key is kind and key). A column's config.memory_days
// is a number of days, or the name of one of company_pipeline.memory_days.
//
// Waiting: only keys we hold (needs_env: OpenAI, Reoon) and the day's caps
// make a cell wait. The caps are the actions' own answers (ai_web,
// reoon_verify and the keyed steps answer needs_key with spend.mjs's
// CAP_REACHED words, or CAP_NOT_SET while a vendor has no cap); the hourly
// sweep resumes the row once the reason has cleared.
//
// Phases: a column of a later phase is shown and never run. Every pipeline
// column that may run is phase 1, its switches and keys deciding (the fit
// hooks too, as fit_lookup); add_to_database stays a later phase: only
// promotion writes it.

import { createHash } from "node:crypto";
import { emptyAsText, evaluate, isEmpty, makeContext, refs } from "./formula.mjs";
import { ACTIONS, capped } from "./actions.mjs";
import { absentKeyNote } from "./pipeline-actions.mjs";
import { flagOn, SETTINGS_DEFAULTS, settingsFrom } from "./settings.mjs";

const DISPLAY_MAX = 300;
const msg = (e) => String(e?.message ?? e).slice(0, 300);
const text = (v) => (v == null ? "" : String(v).trim());

/** The key a remembered answer is kept under: the model in front for an AI column, a sha256 when over 200 characters. */
export function memoryKey(raw, { model = null } = {}) {
  const key = model ? `${model}\n${raw}` : raw;
  return key.length > 200 ? `sha256:${createHash("sha256").update(key).digest("hex")}` : key;
}

/** A remembered answer, if one is still fresh. */
async function recall(db, kind, key) {
  const { rows } = await db.query(
    `SELECT status, value, display, client_tag, created_at FROM enrich_memory
      WHERE kind = $1 AND key = $2 AND expires_at > now()`,
    [kind, key]
  );
  return rows[0] ?? null;
}

/** Keeps a paid answer for every row, table and client; the newest answer replaces an older one. */
async function remember(db, { kind, key, res, provider, table, row, days }) {
  await db.query(
    `INSERT INTO enrich_memory (kind, key, status, value, display, provider, model, client_tag, table_id, row_id, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, now() + make_interval(days => $11))
     ON CONFLICT (kind, key) DO UPDATE
       SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, provider = EXCLUDED.provider,
           model = EXCLUDED.model, client_tag = EXCLUDED.client_tag, table_id = EXCLUDED.table_id, row_id = EXCLUDED.row_id,
           created_at = now(), expires_at = EXCLUDED.expires_at`,
    [
      kind, key, res.status, res.status === "done" && !isEmpty(res.value) ? JSON.stringify(res.value) : null,
      res.status === "done" ? (res.display == null ? null : String(res.display).slice(0, DISPLAY_MAX)) : null,
      provider ?? null, res.model ?? null, table?.client_tag ?? null, table?.id ?? null, row?.id ?? null, days,
    ]
  );
}

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
 * @param row      { id, created_at, run_force, next_run_at }
 * @param table    { id, client_tag, keyCounts, template, variant? }  variant: the originals variant (templates.mjs)
 * @param columns  the table's columns in dependency order (formula.order)
 * @param cells    Map column key -> stored cell { status, value, display, note, input_hash }
 * @param settings readSettings()'s value (settings.mjs); the defaults when not given
 * @returns        { values, errors, needsKey, retryable, calls }
 */
export async function runRow({ row, table, columns, cells, env, db, hooks = {}, settings = null }) {
  const force = new Set(row.run_force ?? []);
  const forced = (key) => force.has("*") || force.has(key);
  const strict = Boolean(table?.template);
  const config = settings ?? settingsFrom([]);
  /** The first switch on a column that is off for this client, or null. An unknown switch counts as off. */
  const switchedOff = (col) => {
    const flags = Array.isArray(col.config?.flag) ? col.config.flag : [];
    for (const f of flags) {
      let on = false;
      try {
        on = flagOn(config, f, table?.client_tag, { variant: table?.variant });
      } catch {
        on = false;
      }
      if (!on) return f;
    }
    return null;
  };
  const ctx = makeContext();
  const created = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  const values = { created_at: created };
  const summary = { errors: 0, needsKey: 0, retryable: null, calls: 0 };
  const failed = new Set(); // the columns that ended this pass in error
  const waiting = new Set(); // the columns that ended this pass waiting on a key

  /**
   * The row's values, noting which failed (and, in a template table, which
   * waiting) cells an evaluation actually reads: a branch that returns before
   * reaching one keeps its answer.
   */
  const watch = (base, { waitingToo }) => {
    const read = { failed: new Set(), waiting: new Set() };
    if (!failed.size && !(waitingToo && waiting.size)) return { scope: base, read };
    const scope = new Proxy(base, {
      get: (t, k) => {
        if (failed.has(k)) read.failed.add(k);
        else if (waitingToo && waiting.has(k)) read.waiting.add(k);
        return t[k];
      },
    });
    return { scope, read };
  };
  const names = (keys) => columns.filter((c) => keys.has(c.key)).map((c) => c.name ?? c.key).join(", ");
  /** The cell for an evaluation that read a failed or waiting cell, or null when it read neither. */
  const blocked = (read, what) =>
    read.failed.size
      ? { status: "error", note: `${what}: ${names(read.failed)} failed` }
      : read.waiting.size
        ? { status: "needs_key", note: `Waiting for ${names(read.waiting)}` }
        : null;

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
    if (cell.status === "error") {
      summary.errors++;
      failed.add(col.key);
    }
    if (cell.status === "needs_key") {
      summary.needsKey++;
      waiting.add(col.key);
    }
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

    const off = switchedOff(col);
    if (off) {
      put(col, { status: "skipped", note: `Switched off: ${off}` });
      continue;
    }

    if (col.kind === "formula") {
      // A failed cell reads as empty, and an empty check reads as "nothing
      // found", so a formula that reads one would give a confident wrong
      // answer. What counts is what the evaluation actually reads: a branch
      // that returns before reaching a failed check keeps its answer.
      const { scope, read } = watch(values, { waitingToo: strict });
      let v;
      let err = null;
      try {
        v = evaluate(ctx, col.formula, scope);
      } catch (e) {
        err = e;
      }
      const stop = blocked(read, "Not worked out");
      if (stop) {
        put(col, stop);
      } else if (err) {
        put(col, { status: "error", note: `Formula error: ${msg(err)}` });
      } else {
        put(col, { status: isEmpty(v) ? "empty" : "done", value: v, note: typeof v === "boolean" ? listMatches(col.formula, values) : null });
      }
      continue;
    }

    if (col.kind === "waterfall") {
      const steps = Array.isArray(col.waterfall) ? col.waterfall : [];
      const errs = [];
      let won = 0;
      let v;
      let stop = null;
      for (let i = 0; i < steps.length && !won; i++) {
        // In a template table a step over a failed or waiting cell can't say
        // whether it would have won, so the waterfall stops there.
        const { scope, read } = strict ? watch(values, { waitingToo: true }) : { scope: values, read: null };
        let r;
        let err = null;
        try {
          r = evaluate(ctx, steps[i], scope);
        } catch (e) {
          err = e;
        }
        stop = read && blocked(read, `Step ${i + 1} not worked out`);
        if (stop) break;
        if (err) errs.push(`step ${i + 1}: ${msg(err)}`);
        else if (!isEmpty(r) && r !== false) {
          won = i + 1;
          v = r;
        }
      }
      if (stop) {
        put(col, stop);
        continue;
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
      const { scope, read } = strict ? watch(values, { waitingToo: true }) : { scope: values, read: null };
      let ok = false;
      let err = null;
      try {
        ok = Boolean(evaluate(ctx, col.run_if, scope));
      } catch (e) {
        err = msg(e);
      }
      const stop = read && blocked(read, "Run condition not worked out");
      if (stop) {
        put(col, stop);
        continue;
      }
      if (!ok) {
        put(col, { status: "skipped", note: err ? `Run condition could not be evaluated: ${err}` : "Run condition not met" });
        continue;
      }
    }
    const base = impl.emptyAs === "" ? emptyAsText(values) : values;
    const { scope, read } = strict ? watch(base, { waitingToo: true }) : { scope: base, read: null };
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
    const inputStop = read && blocked(read, "Inputs not worked out");
    if (inputStop) {
      put(col, inputStop);
      continue;
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
    // Another row, table or client paid for this answer already: reuse it.
    const kind = text(col.config?.memory);
    const rawKey = kind ? text(inputs.memory_key) : "";
    const model = col.action === "ai_web" && col.config?.model_setting ? config.models?.[col.config.model_setting]?.model ?? "" : null;
    const memKey = rawKey ? memoryKey(rawKey, { model }) : "";
    if (memKey && !forced(col.key)) {
      let hit = null;
      try {
        hit = await recall(db, kind, memKey);
      } catch (e) {
        put(col, { status: "error", note: `The shared answers could not be read: ${msg(e)}` });
        if (!summary.retryable) summary.retryable = `${col.name}: the shared answers could not be read`;
        continue;
      }
      if (hit) {
        const on = hit.created_at instanceof Date ? hit.created_at.toISOString().slice(0, 10) : String(hit.created_at ?? "").slice(0, 10);
        put(col, {
          status: hit.status,
          value: hit.value,
          display: hit.display ?? undefined,
          note: `Reused: ${hit.status === "done" ? "found" : "nothing found"} for ${hit.client_tag ?? "another client"} on ${on}`,
          input_hash: hash,
          runs: 0,
        });
        continue;
      }
    }
    const missing = (col.needs_env ?? []).filter((k) => !env[k]);
    if (missing.length) {
      put(col, { status: "needs_key", note: `Needs ${missing.join(" and ")} on the worker` });
      continue;
    }
    const keyEnv = text(col.config?.key_env);
    if (keyEnv && !text(env?.[keyEnv])) {
      put(col, { status: "skipped", note: absentKeyNote(keyEnv) });
      continue;
    }

    const local = impl.cache === false; // free lookups: no spinner, no run history
    if (!local) await hooks.running?.(col.key, prev);
    const started = new Date();
    let res;
    try {
      res = await impl.run({ inputs, config: col.config ?? {}, row, table, column: col, db, env, settings: config });
    } catch (e) {
      res = { status: "error", note: msg(e), retryable: true, run: { error: msg(e) } };
    }
    let rememberNote = "";
    if (memKey && (res.status === "done" || res.status === "empty")) {
      const days = config.company_pipeline?.memory_days ?? SETTINGS_DEFAULTS.company_pipeline.memory_days;
      const fixed = col.config?.memory_days;
      const span =
        res.status !== "done"
          ? days.nothing_found
          : typeof fixed === "number" && Number.isInteger(fixed) && fixed > 0
            ? fixed
            : days[fixed] ?? days.email;
      try {
        await remember(db, { kind, key: memKey, res, provider: col.provider ?? col.action, table, row, days: span });
      } catch (e) {
        rememberNote = ` (not kept for other rows: ${msg(e)})`;
      }
    }
    put(col, {
      status: res.status,
      value: res.value,
      display: res.display,
      note: res.note ? `${res.note}${rememberNote}` : rememberNote.trim() || null,
      input_hash: res.status === "error" || res.status === "needs_key" ? null : hash,
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
