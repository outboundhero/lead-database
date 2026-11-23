// The question variable a push sends besides the usual eleven (migration 139).
// Used by scripts/push-worker.mjs, tested by scripts/test-push-question-var.mjs.
//
// A push batch can name one question variable (push_batches.question_variable_id
// and question_variable_name, chosen in the export popup). For such a batch the
// worker:
//   - reads the written values once per cycle (lead_question_values, status
//     'done'), one statement per variable;
//   - skips a lead that has no value ("no {X} written yet"), with no Bison call;
//   - checks once per install (GET /api/custom-variables, cached ten minutes)
//     that the install has the variable, and fails the lead when it does not
//     ("{X} isn't set up on <install>: create it on the Clay tab"): Bison
//     refuses a whole lead whose payload names a variable the install lacks;
//   - sends it after the eleven fixed names when it creates the lead, and
//     PATCHes it onto a lead the install already holds. PATCH with only
//     custom_variables changes just that variable; PUT clears every field and
//     variable it is not sent, so it is never used for this.
// A batch that names no variable (every batch before 139, and every push
// without one) is pushed exactly as before: no read, no check, no PATCH, the
// same payload.
//
// Pure: no database (loadQuestionValues runs on the pool it is given), no
// network (installHasVariable calls the worker's own Bison function), and no
// state of its own (the caches belong to the caller).

import { RESERVED_VARIABLE_NAMES, copyTag } from "./questions/names.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The stored form of a name (names.mjs, and 139's CHECK on question_variables.name).
const NAME_RE = /^[a-z0-9][a-z0-9 _-]{0,62}$/;

/** A positive answer of GET /api/custom-variables is trusted this long per install. */
export const CUSTOM_VARIABLES_TTL_MS = 10 * 60_000;
/**
 * A list that LACKS the name is read again after this long, so a variable
 * created on the Clay tab after a push failed is seen within a minute (a retry
 * from the Exports page then goes through) without a read per lead meanwhile.
 */
export const MISSING_RECHECK_MS = 60_000;
/** Pages of 15: far more variables than any install holds (about a dozen each in 2026-11). */
const MAX_PAGES = 40;

/** The statement each cycle runs once per variable its batches name. $1 the variable, $2 the cycle's lead ids. */
export const QUESTION_VALUES_SQL =
  `select lead_id, value from lead_question_values
    where variable_id = $1 and lead_id = any($2::uuid[]) and status = 'done'`;

/**
 * The variable a batch row names, or null when it names none (the push is then
 * exactly as before 139).
 *
 * `problem` is set when the batch names a variable the worker cannot send: its
 * row was deleted after the push was queued (the id is set to NULL by the
 * foreign key, the name stays), or the name is not a usable one. Every lead of
 * such a batch is skipped with that reason.
 *
 * @param {{ question_variable_id?: string | null, question_variable_name?: string | null } | null | undefined} batchRow
 * @returns {{ id: string | null, name: string, copyTag: string, problem: string | null } | null}
 */
export function questionVarFor(batchRow) {
  const rawId = batchRow?.question_variable_id;
  const rawName = batchRow?.question_variable_name;
  const hasId = rawId != null && rawId !== "";
  const name = typeof rawName === "string" ? rawName.trim().toLowerCase() : "";
  if (!hasId && !name) return null;
  const id = typeof rawId === "string" && UUID_RE.test(rawId) ? rawId.toLowerCase() : null;
  if (!NAME_RE.test(name) || RESERVED_VARIABLE_NAMES.includes(name)) {
    return { id, name, copyTag: name ? copyTag(name) : "", problem: "this push names a question variable that cannot be sent (no usable name)" };
  }
  const tag = copyTag(name);
  if (!id) return { id: null, name, copyTag: tag, problem: `${tag} no longer exists (deleted after this push was queued)` };
  return { id, name, copyTag: tag, problem: null };
}

/**
 * What one lead sends for its batch's question variable:
 *   { vars: [] }                when the batch names none (today's push);
 *   { vars: [{ name, value }] } when the lead has a written value;
 *   { skip: reason }            when it has none (or the batch's variable cannot be sent);
 *   { retry: error }            when this cycle could not read the values (the lead is tried again).
 *
 * @param {{ id: string }} lead
 * @param {Map<string, Map<string, string> | Error>} valuesMap loadQuestionValues' answer
 * @param {object | null | undefined} batch the batch row
 */
export function extraVarsFor(lead, valuesMap, batch) {
  const qv = questionVarFor(batch);
  if (!qv) return { vars: [] };
  if (qv.problem) return { skip: qv.problem };
  const values = valuesMap?.get(qv.id);
  if (values instanceof Error) return { retry: values };
  const value = values?.get(String(lead?.id ?? ""));
  if (typeof value !== "string" || value.trim() === "") return { skip: `no ${qv.copyTag} written yet` };
  return { vars: [{ name: qv.name, value }] };
}

/**
 * The fixed custom variables with the extra ones after them. An extra one never
 * displaces or repeats a fixed name (or another extra), and an empty value is
 * left out, as the fixed ones are. With no extra the SAME array comes back, so a
 * push without a question variable sends exactly the payload it always did.
 *
 * @param {Array<{ name: string, value: string }>} vars
 * @param {Array<{ name: string, value: string }> | null | undefined} extra
 */
export function appendExtraVars(vars, extra) {
  if (!Array.isArray(extra) || extra.length === 0) return vars;
  const taken = new Set([...RESERVED_VARIABLE_NAMES, ...vars.map((v) => String(v?.name ?? "").trim().toLowerCase())]);
  const out = [...vars];
  for (const v of extra) {
    const name = String(v?.name ?? "").trim().toLowerCase();
    if (!name || taken.has(name) || v.value == null || v.value === "") continue;
    taken.add(name);
    out.push({ name, value: String(v.value) });
  }
  return out;
}

/**
 * The body of PATCH /api/leads/{id} that sets one custom variable and leaves
 * every other field and variable of the lead as it is.
 * @param {string} name
 * @param {string} value
 */
export function patchPayload(name, value) {
  return { custom_variables: [{ name: String(name), value: String(value) }] };
}

/**
 * Whether a lead, as Bison returned it, already holds this value under this
 * name (any case). A lead found on the install that already holds it needs no PATCH.
 */
export function holdsValue(bisonLead, name, value) {
  const list = Array.isArray(bisonLead?.custom_variables) ? bisonLead.custom_variables : [];
  const want = String(name ?? "").trim().toLowerCase();
  return list.some((v) => v && String(v.name ?? "").trim().toLowerCase() === want && String(v.value ?? "") === String(value));
}

/** The fixed name (one of the eleven every push sends) this is, in any case, or null. */
export function fixedVariableName(name) {
  const n = String(name ?? "").trim().toLowerCase();
  return RESERVED_VARIABLE_NAMES.includes(n) ? n : null;
}

/**
 * The whole variable name Bison's refusal names ("You do not have a custom
 * variable named company phone. Please create it first"), or null. Quoted names
 * are taken inside their quotes; otherwise up to ". Please", any other
 * punctuation, or the end of the line. The old capture stopped at the first
 * space, so a missing multi-word name ("company phone", "acme-os question")
 * could never be learned.
 *
 * @param {unknown} message an error message, Bison's text or the worker's "Bison POST ... -> 422: ..." wrapper
 * @returns {string | null}
 */
export function missingVariableName(message) {
  const text = String(message ?? "");
  const m = /custom variable named\s*/i.exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length).split(/\r?\n/)[0];
  const closing = { '"': '"', "'": "'", "`": "`", "\u201C": "\u201D", "\u2018": "\u2019" }[rest[0]];
  let name;
  if (closing) {
    const end = rest.indexOf(closing, 1);
    name = end > 0 ? rest.slice(1, end) : rest.slice(1);
  } else {
    // Names never hold any of these characters, so the first one ends the name.
    const cut = rest.search(/[.,;:!?(]|\s+please\b/i);
    name = cut >= 0 ? rest.slice(0, cut) : rest;
  }
  name = name.trim();
  return name && name.length <= 120 ? name : null;
}

/** Why a lead of a batch fails when its install lacks the batch's variable. */
export function notSetUpReason(name, install) {
  return `${copyTag(String(name ?? "").toLowerCase())} isn't set up on ${install}: create it on the Clay tab`;
}

/**
 * That failure as an error the worker's item handler records at once: status 422
 * is what Bison answers for such a lead, and a 4xx fails the item without a retry.
 */
export function notSetUpError(name, install) {
  return Object.assign(new Error(notSetUpReason(name, install)), { status: 422, questionVariable: true });
}

async function readCustomVariables(fetchFn, auth) {
  const names = new Set();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const json = await fetchFn(auth, "GET", `/api/custom-variables?page=${page}`);
    const rows = Array.isArray(json?.data) ? json.data : [];
    for (const r of rows) {
      const n = String(r?.name ?? "").trim().toLowerCase();
      if (n) names.add(n);
    }
    const last = Number(json?.meta?.last_page);
    const more = Number.isFinite(last) && last > 0 ? page < last : Boolean(json?.links?.next) && rows.length > 0;
    if (!more) return names;
  }
  throw new Error(`more than ${MAX_PAGES} pages of custom variables on ${auth?.domain}`);
}

/**
 * Whether an install has this custom variable (names compared in lower case,
 * as Bison stores them). One read of GET /api/custom-variables per install,
 * shared by the leads that ask at the same time and kept in `cache` for ten
 * minutes; a list that lacks the name is read again after a minute. A failed
 * read is not kept, and throws to the caller (the lead is tried again).
 *
 * @param {(auth: object, method: string, path: string) => Promise<any>} fetchFn the worker's Bison call (rate gate, timeout, retries)
 * @param {{ domain: string }} auth the install
 * @param {string} name the variable's stored name
 * @param {Map<string, { at: number, names: Promise<Set<string>> }>} cache per install domain
 * @param {{ now?: () => number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function installHasVariable(fetchFn, auth, name, cache, { now = Date.now } = {}) {
  const want = String(name ?? "").trim().toLowerCase();
  const key = String(auth?.domain ?? "");
  const hit = cache.get(key);
  if (hit) {
    const names = await hit.names;
    const age = now() - hit.at;
    if (age < CUSTOM_VARIABLES_TTL_MS && (names.has(want) || age < MISSING_RECHECK_MS)) return names.has(want);
    // Another lead may have started the new read while this one waited: share it.
    const newer = cache.get(key);
    if (newer && newer !== hit) return (await newer.names).has(want);
  }
  const entry = { at: now(), names: readCustomVariables(fetchFn, auth) };
  cache.set(key, entry);
  entry.names.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return (await entry.names).has(want);
}

/**
 * The written values this cycle's leads send: Map variable id -> Map lead id ->
 * value, read only for the items whose batch names a variable (no statement at
 * all otherwise), one statement per variable. A variable whose read fails maps
 * to the Error, and its leads are tried again (extraVarsFor answers `retry`).
 *
 * @param {{ query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {Array<{ batch_id: string, lead_id: string }>} items
 * @param {Map<string, object>} batchOf batch id -> batch row
 */
export async function loadQuestionValues(db, items, batchOf) {
  const byVar = new Map();
  for (const it of items) {
    const qv = questionVarFor(batchOf.get(it.batch_id));
    if (!qv || qv.problem) continue;
    if (!byVar.has(qv.id)) byVar.set(qv.id, new Set());
    byVar.get(qv.id).add(String(it.lead_id));
  }
  const out = new Map();
  for (const [id, leadIds] of byVar) {
    try {
      const { rows } = await db.query(QUESTION_VALUES_SQL, [id, [...leadIds]]);
      out.set(id, new Map(rows.map((r) => [String(r.lead_id), r.value])));
    } catch (e) {
      out.set(id, e instanceof Error ? e : new Error(String(e)));
    }
  }
  return out;
}
