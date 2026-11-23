// The Clay tab's prompt editor, server side (migration 139): what the
// editor shows for a client's four editable personalisation steps (People
// P#60 research and P#61 question AI, General G#48 and G#49), saving a
// client's own text and resetting it to the Clay original. The route
// (src/app/api/enrich/prompts/route.ts) holds the roles, the transaction and
// the per-client lock; prompt-overrides.mjs and templates.mjs apply the
// edits when the tables compile; prompt-text.mjs turns text into the
// expression the pipeline runs and back.
//
// What a step may read (promptCatalogue): every column of its table that runs
// before it (the run order the worker uses, formula.mjs order), compiled from
// the client's originals in memory, so it works for a client with no tables
// yet. A later step, a column that is never run here and a hidden column of
// our own are left out. A column compiled from a Clay original is referred to
// by its field id ({{f_...}}, rewritten to its key when the tables compile,
// as the original's own references are); one of the template's own by its key.

import { bindingText, loadOriginals, OriginalsMissing, refMap, rewriteRefs } from "./compile-original.mjs";
import { emptyAsText, evaluate, makeContext, order } from "./formula.mjs";
import { keyFor } from "./original-keys.mjs";
import { COMPANY_REFS } from "./company-template-v2.mjs";
import { INBOX_REFS } from "./inbox-template.mjs";
import { PEOPLE_REFS } from "./people-template.mjs";
import { applyPromptOverrides, compileTemplates, ensurePipelineTables, PIPELINE_TEMPLATES, variantFor, variantName } from "./templates.mjs";
import { firstLine, isPromptPosition, PROMPT_KINDS, PROMPT_POSITIONS, PROMPT_ROLES, withPromptOverrides } from "./prompt-overrides.mjs";
import { normName, promptToText, textToPrompt } from "./prompt-text.mjs";
import { normTag } from "./settings.mjs";

/** The longest text the editor saves (enrich_prompt_overrides.prompt_text). */
export const PROMPT_TEXT_MAX = 40_000;
/** The longest expression stored (enrich_prompt_overrides.formula). */
export const PROMPT_FORMULA_MAX = 80_000;

const REFS_OF = Object.freeze({ companies: COMPANY_REFS, people: PEOPLE_REFS, inboxes: INBOX_REFS });

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 * @typedef {import("./prompt-text.mjs").PromptCatalogueEntry} PromptCatalogueEntry
 * @typedef {{ tag: string, own: string, variant: string, fallback: string | null,
 *             originals: import("./compile-original.mjs").Originals,
 *             compiled: Record<string, Array<Record<string, any>>> }} PromptBase
 * @typedef {{ template_kind: "people" | "inboxes", position: number, prompt_text: string, formula: string, version: number,
 *             updated_at: string | null, updated_by_email: string | null }} PromptOverrideRow
 * @typedef {{ kind: "people" | "inboxes", position: number, key: string, name: string, role: "research" | "question",
 *             source: "edited" | "client" | "default", text: string | null, originalText: string | null,
 *             originalAdvanced: boolean, originalReason: string | null,
 *             placeholders: Array<{ name: string, fields?: string[] }>, version: number | null,
 *             updatedAt: string | null, updatedBy: string | null, problem: string | null }} PromptColumnView
 */

/**
 * A text as it is stored: no NUL, no lone UTF-16 halves (made U+FFFD, as
 * Postgres would refuse them), line breaks as \n. Nothing else changes.
 *
 * @param {unknown} v
 * @returns {string}
 */
export function cleanPromptText(v) {
  if (typeof v !== "string") return "";
  return v
    .replace(/\u0000/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "�")
    .replace(/\r\n?/g, "\n");
}

/** Single-level fields read from a column anywhere in its table: {{key}}?.field, .field, ?.["field"]; never a method call. */
const FIELD_READ = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}\s*(?:(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)(?![\w$])(?!\s*(?:\?\.)?\s*\()|(?:\?\.)?\s*\[\s*("(?:[^"\\\n]|\\.)*")\s*\])/g;

/** @param {Array<Record<string, any>>} columns @returns {Map<string, Set<string>>} */
function fieldsRead(columns) {
  /** @type {Map<string, Set<string>>} */
  const out = new Map();
  for (const c of columns) {
    const texts = [c.formula, c.run_if, ...(Array.isArray(c.waterfall) ? c.waterfall : []), ...Object.values(c.inputs ?? {})];
    for (const t of texts) {
      for (const m of String(t ?? "").matchAll(FIELD_READ)) {
        let field = m[2] ?? null;
        if (field == null && m[3]) {
          try {
            field = JSON.parse(m[3]);
          } catch {
            field = null;
          }
        }
        if (typeof field !== "string" || !field || /[{}]/.test(field)) continue;
        if (!out.has(m[1])) out.set(m[1], new Set());
        /** @type {Set<string>} */ (out.get(m[1])).add(field);
      }
    }
  }
  return out;
}

/**
 * The columns one AI step may read, as the editor's placeholders (see the header).
 *
 * @param {Array<Record<string, any>>} columns  one table's compiled columns (compileTemplates)
 * @param {import("./compile-original.mjs").Originals} originals  what they were compiled from
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {string} aiKey  the step's key ("claygent", "question_ai", ...)
 * @returns {PromptCatalogueEntry[]}  in table order, names unique (a second one gets " (2)")
 */
export function promptCatalogue(columns, originals, kind, aiKey) {
  const ordered = order(columns.map((c) => ({ ...c })));
  const at = ordered.findIndex((c) => c.key === aiKey);
  if (at < 0) return [];
  /** @type {Map<string, string>} our key -> the field id an original refers to it by */
  const idOf = new Map();
  for (const [id, key] of refMap(originals, kind, REFS_OF[kind] ?? {})) if (!idOf.has(key)) idOf.set(key, id);
  const reads = fieldsRead(columns);
  const taken = new Set();
  /** @type {PromptCatalogueEntry[]} */
  const out = [];
  for (const c of ordered.slice(0, at).sort((a, b) => a.position - b.position)) {
    if (c.phase > 1 || (c.hidden && !c.clay_field_id)) continue;
    const base = String(c.name ?? c.key).replace(/\{/g, "(").replace(/\}/g, ")").replace(/\s+/g, " ").trim() || c.key;
    let name = base;
    for (let n = 2; taken.has(normName(name)); n++) name = `${base} (${n})`;
    taken.add(normName(name));
    const answer = c.action === "ai_web" && Array.isArray(c.config?.answer_order) ? c.config.answer_order.filter((f) => typeof f === "string" && f && !/[{}]/.test(f)) : [];
    const seen = c.action === "ai_web" || c.data_type === "json" ? [...(reads.get(c.key) ?? [])].sort() : [];
    const fields = [...new Set([...answer, ...seen])];
    out.push({ name, ref: idOf.has(c.key) ? `{{${idOf.get(c.key)}}}` : `{{${c.key}}}`, key: c.key, ...(fields.length ? { fields } : {}) });
  }
  return out;
}

/**
 * The client's originals and their templates compiled in memory, as
 * ensurePipelineTables would compile them before any edit: its own variant,
 * or "default" when its own does not compile (fallback says why).
 *
 * @param {Db} db
 * @param {string} tag
 * @param {{ settings?: any, base?: string }} [opts]  base: the variant an overlay is composed with (the tests pass their own)
 * @returns {Promise<PromptBase>}
 */
export async function promptBase(db, tag, { settings = null, base = "default" } = {}) {
  const t = normTag(tag);
  const own = await variantFor(db, t);
  let variant = own;
  /** @type {string | null} */
  let fallback = null;
  let originals = await loadOriginals(db, own, { base });
  let compiled;
  try {
    compiled = compileTemplates(originals, { settings });
  } catch (e) {
    if (own === "default" || e instanceof OriginalsMissing) throw e;
    fallback = firstLine(e, 300);
    variant = "default";
    originals = await loadOriginals(db, "default");
    compiled = compileTemplates(originals, { settings });
  }
  return { tag: t, own, variant, fallback, originals, compiled };
}

/**
 * The client's prompt edits with who saved them last: [] before migration 139.
 *
 * @param {Db} db
 * @param {string} tag
 * @returns {Promise<PromptOverrideRow[]>}
 */
export async function promptOverrideRows(db, tag) {
  const { rows: [ready] } = await db.query(`SELECT to_regclass('public.enrich_prompt_overrides') IS NOT NULL AS ok`);
  if (!ready?.ok) return [];
  const { rows } = await db.query(
    `SELECT o.template_kind, o.position, o.prompt_text, o.formula, o.version, o.updated_at, up.email AS updated_by_email
       FROM enrich_prompt_overrides o LEFT JOIN user_profiles up ON up.id = o.updated_by
      WHERE o.client_tag = $1 ORDER BY o.template_kind DESC, o.position`,
    [normTag(tag)]
  );
  return rows.map((r) => ({
    template_kind: r.template_kind,
    position: Number(r.position),
    prompt_text: r.prompt_text,
    formula: r.formula,
    version: Number(r.version),
    updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at ?? null,
    updated_by_email: r.updated_by_email ?? null,
  }));
}

/**
 * The editor's view of the four steps: whose text runs (edited, the client's
 * own Clay text, or the default's), the text, the Clay original as text,
 * the placeholders, the edit's version and who saved it, and why an edit is
 * not running (problem: it no longer compiles, so the original runs).
 *
 * @param {PromptBase} base
 * @param {PromptOverrideRow[]} rows
 * @param {{ settings?: any }} [opts]
 * @returns {PromptColumnView[]}
 */
export function promptColumnViews(base, rows, { settings = null } = {}) {
  const edits = applyPromptOverrides(base.originals, rows, { tag: base.tag, settings });
  /** @type {PromptColumnView[]} */
  const out = [];
  for (const kind of PROMPT_KINDS) {
    for (const position of PROMPT_POSITIONS[kind]) {
      const key = /** @type {string} */ (keyFor(kind, position));
      const row = base.originals.get(`${kind}:${position}`);
      const col = base.compiled[kind]?.find((c) => c.key === key && c.action === "ai_web");
      const catalogue = promptCatalogue(base.compiled[kind] ?? [], base.originals, kind, key);
      const original = row ? promptToText(bindingText(row.definition, "prompt"), catalogue) : { ok: false, reason: "Its Clay original is not loaded" };
      const edit = rows.find((r) => r.template_kind === kind && Number(r.position) === position) ?? null;
      const skip = edits.skipped.find((s) => s.template_kind === kind && s.position === position) ?? null;
      const ownText = Boolean(row) && base.variant !== "default" && row?.text_variant !== "default";
      out.push({
        kind,
        position,
        key,
        name: col?.name ?? row?.name ?? key,
        role: /** @type {"research" | "question"} */ (PROMPT_ROLES[kind][/** @type {never} */ (position)]),
        source: edit ? "edited" : ownText ? "client" : "default",
        text: edit ? edit.prompt_text : original.ok ? original.text : null,
        originalText: original.ok ? original.text : null,
        originalAdvanced: !original.ok,
        originalReason: original.ok ? null : original.reason,
        placeholders: catalogue.map((e) => (e.fields ? { name: e.name, fields: [...e.fields] } : { name: e.name })),
        version: edit ? edit.version : null,
        updatedAt: edit ? edit.updated_at : null,
        updatedBy: edit ? edit.updated_by_email : null,
        problem: skip ? `The Clay original runs instead of this edit (${skip.reason})` : null,
      });
    }
  }
  return out;
}

/**
 * The GET shape of /api/enrich/prompts.
 *
 * @param {Db} db
 * @param {string} tag
 * @param {{ settings: any, base?: PromptBase }} opts  settings: settingsFrom()'s value
 */
export async function promptsView(db, tag, { settings, base = undefined }) {
  const b = base ?? (await promptBase(db, tag, { settings }));
  const rows = await promptOverrideRows(db, b.tag);
  const ps = settings?.personalisation ?? {};
  return {
    tag: b.tag,
    personalisation: { enabled: ps.enabled === true, listed: Array.isArray(ps.tags) && ps.tags.includes(b.tag), sharedTextOk: ps.shared_text_ok === true },
    columns: promptColumnViews(b, rows, { settings }),
  };
}

/** Does the expression work out to text with every cell empty, once its references are our keys? */
function worksOut(formula, originals, kind) {
  try {
    const { text, unknown } = rewriteRefs(formula, refMap(originals, kind, REFS_OF[kind] ?? {}));
    if (unknown.length) return false;
    return typeof evaluate(makeContext(), text, emptyAsText({})) === "string";
  } catch {
    return false;
  }
}

/**
 * @typedef {{ status: number, error: string, errors?: string[], changed?: boolean }} Refusal
 */

/**
 * Saves a client's own text for one step. The caller holds the client's
 * pipeline lock (templates.mjs lockPipelineTables) in its transaction. Refused,
 * with nothing written: 400 for a position that is not editable, an empty or
 * long text, a placeholder this step can't read (each named), or a text the
 * templates don't compile with (with the client's other edits that run); 409
 * (changed) when the step's edit is not at `version` (null: not edited) any
 * more. A text equal to the saved one, written the same way, writes nothing
 * (unchanged). Otherwise the edit is stored with version + 1 and logged,
 * before and after.
 *
 * @param {Db} db
 * @param {{ tag: string, kind: unknown, position: unknown, text: unknown, version: number | null, userId: string | null,
 *           settings?: any, base?: PromptBase }} args
 * @returns {Promise<Refusal | { saved: boolean, unchanged: boolean, version: number, before: number | null, after: number }>}
 */
export async function savePromptOverride(db, { tag, kind, position, text, version, userId, settings = null, base = undefined }) {
  const t = normTag(tag);
  if (!isPromptPosition(kind, position)) return { status: 400, error: "Only the research and question steps can be edited: People 60 and 61, General 48 and 49" };
  const pos = Number(position);
  const clean = cleanPromptText(text);
  if (!clean.trim()) return { status: 400, error: "The prompt is empty", errors: ["The prompt is empty"] };
  if (clean.length > PROMPT_TEXT_MAX) {
    const e = `The prompt is ${clean.length.toLocaleString("en-US")} characters; at most ${PROMPT_TEXT_MAX.toLocaleString("en-US")}`;
    return { status: 400, error: e, errors: [e] };
  }
  const { rows: [cur] } = await db.query(
    `SELECT version, prompt_text, formula FROM enrich_prompt_overrides WHERE client_tag = $1 AND template_kind = $2 AND position = $3 FOR UPDATE`,
    [t, kind, pos]
  );
  if ((version ?? null) !== (cur ? Number(cur.version) : null)) {
    return { status: 409, error: "This prompt was changed since the page loaded it: it has been loaded again", changed: true };
  }
  const b = base ?? (await promptBase(db, t, { settings }));
  const key = /** @type {string} */ (keyFor(kind, pos));
  const conv = textToPrompt(clean, promptCatalogue(b.compiled[kind] ?? [], b.originals, kind, key));
  if (conv.errors.length || !conv.formula) return { status: 400, error: conv.errors[0] ?? "The prompt could not be read", errors: conv.errors };
  if (conv.formula.length > PROMPT_FORMULA_MAX) {
    const e = "The prompt is too long once written as the pipeline's expression: shorten it";
    return { status: 400, error: e, errors: [e] };
  }
  const others = (await promptOverrideRows(db, t)).filter((r) => !(r.template_kind === kind && r.position === pos));
  const running = applyPromptOverrides(b.originals, others, { tag: t, settings }).applied;
  try {
    compileTemplates(withPromptOverrides(b.originals, [...running, { template_kind: kind, position: pos, formula: conv.formula }], { variant: variantName(t) }), { settings });
  } catch (e) {
    if (e instanceof OriginalsMissing) throw e;
    const why = `The pipeline can't run this prompt: ${firstLine(e)}`;
    return { status: 400, error: why, errors: [why] };
  }
  if (!worksOut(conv.formula, b.originals, kind)) {
    const e = "The pipeline can't run this prompt";
    return { status: 400, error: e, errors: [e] };
  }
  // The same text written the same way: nothing to save (a renamed column would write it another way, and is saved).
  if (cur && cur.prompt_text === clean && cur.formula === conv.formula) return { saved: false, unchanged: true, version: Number(cur.version), before: clean.length, after: clean.length };
  const { rows: [w] } = await db.query(
    `INSERT INTO enrich_prompt_overrides (client_tag, template_kind, position, prompt_text, formula, version, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6, now())
     ON CONFLICT (client_tag, template_kind, position) DO UPDATE
       SET prompt_text = EXCLUDED.prompt_text, formula = EXCLUDED.formula, version = enrich_prompt_overrides.version + 1,
           updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING version`,
    [t, kind, pos, clean, conv.formula, userId ?? null]
  );
  await db.query(
    `INSERT INTO enrich_prompt_override_log (client_tag, template_kind, position, action, before_text, after_text, by_user)
     VALUES ($1, $2, $3, 'save', $4, $5, $6)`,
    [t, kind, pos, cur?.prompt_text ?? null, clean, userId ?? null]
  );
  return { saved: true, unchanged: false, version: Number(w.version), before: cur ? String(cur.prompt_text).length : null, after: clean.length };
}

/**
 * Resets one step to its Clay original: deletes the client's edit and logs
 * it. The caller holds the client's pipeline lock. 409 (changed) when the
 * edit is not at `version` any more; nothing to reset (no edit, version null)
 * writes nothing.
 *
 * @param {Db} db
 * @param {{ tag: string, kind: unknown, position: unknown, version: number | null, userId: string | null }} args
 * @returns {Promise<Refusal | { reset: boolean, before: number | null }>}
 */
export async function resetPromptOverride(db, { tag, kind, position, version, userId }) {
  const t = normTag(tag);
  if (!isPromptPosition(kind, position)) return { status: 400, error: "Only the research and question steps can be edited: People 60 and 61, General 48 and 49" };
  const pos = Number(position);
  const { rows: [cur] } = await db.query(
    `SELECT version, prompt_text FROM enrich_prompt_overrides WHERE client_tag = $1 AND template_kind = $2 AND position = $3 FOR UPDATE`,
    [t, kind, pos]
  );
  if ((version ?? null) !== (cur ? Number(cur.version) : null)) {
    return { status: 409, error: "This prompt was changed since the page loaded it: it has been loaded again", changed: true };
  }
  if (!cur) return { reset: false, before: null };
  await db.query(`DELETE FROM enrich_prompt_overrides WHERE client_tag = $1 AND template_kind = $2 AND position = $3`, [t, kind, pos]);
  await db.query(
    `INSERT INTO enrich_prompt_override_log (client_tag, template_kind, position, action, before_text, after_text, by_user)
     VALUES ($1, $2, $3, 'reset', $4, NULL, $5)`,
    [t, kind, pos, cur.prompt_text, userId ?? null]
  );
  return { reset: true, before: String(cur.prompt_text).length };
}

/**
 * Compiles the client's pipeline tables again when it has any, so an edit
 * applies to its next rows at once (the worker reads columns within 30 s).
 * The caller holds the client's pipeline lock. In a savepoint: when the tables
 * can't be compiled now (the originals are not loaded, or the client still has
 * a companies_v1 table) nothing of it is written and the note says why; the
 * edit itself stays and applies at the next compile.
 *
 * @param {Db} db
 * @param {string} tag
 * @param {{ settings?: any }} [opts]
 * @returns {Promise<{ recompiled: boolean, note: string | null, skipped: import("./prompt-overrides.mjs").SkippedOverride[] }>}
 */
export async function recompileIfTables(db, tag, { settings = null } = {}) {
  const t = normTag(tag);
  const { rows: [has] } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM enrich_tables WHERE client_tag = $1 AND template = ANY($2::text[])) AS has`,
    [t, Object.values(PIPELINE_TEMPLATES).map((x) => x.template)]
  );
  if (!has?.has) return { recompiled: false, note: "The client has no pipeline tables yet: the edit applies when they are made", skipped: [] };
  await db.query("SAVEPOINT prompt_tables");
  try {
    const r = await ensurePipelineTables(db, t, { settings });
    await db.query("RELEASE SAVEPOINT prompt_tables");
    return { recompiled: true, note: null, skipped: r.prompts?.skipped ?? [] };
  } catch (e) {
    const name = /** @type {{ name?: unknown } | null} */ (e)?.name;
    if (name !== "OriginalsMissing" && name !== "RetiredV1Table") throw e;
    await db.query("ROLLBACK TO SAVEPOINT prompt_tables");
    return { recompiled: false, note: `The tables were not compiled again: ${firstLine(e, 300)}`, skipped: [] };
  }
}
