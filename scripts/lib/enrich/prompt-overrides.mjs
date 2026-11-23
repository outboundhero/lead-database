// A client's own text for its personalisation AI steps (migration 139,
// enrich_prompt_overrides), applied when its pipeline tables compile
// (templates.mjs ensurePipelineTables). The Clay originals in
// enrich_originals are never changed: an edit replaces only the prompt
// binding of the original it is for, in memory, so the model setting, the
// answer fields, the table examples and the run condition stay the
// original's, refs are rewritten as the original's own, and the memory key
// follows the new prompt. Reset deletes the row, and the next compile takes
// the original's prompt again.
//
// The editable steps: People P#60 (research) and P#61 (question AI), General
// G#48 (research) and G#49 (question AI). Each compiled one carries
// config.prompt_source, "edited" or "clay".
//
// Whose text runs (the personalisation switch, settings.mjs flagOn): an
// edited step is the client's own text, so it carries config.text_variant =
// the client's variant name (templates.mjs variantName) and runs for a client
// on personalisation.tags without "shared personalisation text", whether or
// not the client has its own Clay originals. So do the steps of that kind
// that hold no client text and that the AI steps read or write (P#57, P#58,
// P#62; G#45, G#46, G#50: the email domain, its MX lookup and the final
// question). An AI step of the same kind that is not edited keeps the text
// variant it had: the client's own Clay text, or "default" (which runs only
// with shared text on).
//
// Pure, except loadPromptOverrides (one read).

import { bindingOf, fromOf } from "./compile-original.mjs";
import { keyFor, OVERLAY_AI_POSITIONS, OVERLAY_POSITIONS } from "./original-keys.mjs";

/** The editable prompts by kind: People P#60 and P#61, General G#48 and G#49. */
export const PROMPT_POSITIONS = OVERLAY_AI_POSITIONS;

/** What each editable step does. */
export const PROMPT_ROLES = Object.freeze({
  people: Object.freeze({ 60: "research", 61: "question" }),
  inboxes: Object.freeze({ 48: "research", 49: "question" }),
});

/** The kinds that have editable prompts, in the order they are shown and applied. */
export const PROMPT_KINDS = Object.freeze(["people", "inboxes"]);

/**
 * Is (kind, position) one of the editable prompts?
 *
 * @param {unknown} kind
 * @param {unknown} position
 * @returns {kind is "people" | "inboxes"}
 */
export function isPromptPosition(kind, position) {
  return typeof kind === "string" && Object.hasOwn(PROMPT_POSITIONS, kind) && PROMPT_POSITIONS[/** @type {"people" | "inboxes"} */ (kind)].includes(Number(position));
}

/**
 * @typedef {{ template_kind: "people" | "inboxes", position: number, formula: string, version?: number }} PromptOverride
 * @typedef {{ template_kind: string, position: number, reason: string }} SkippedOverride
 */

/**
 * The client's prompt edits, people first: [] before migration 139 (checked
 * with to_regclass first, so a missing table never aborts the caller's
 * transaction).
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {string} tag  the client's tag, upper case
 * @returns {Promise<PromptOverride[]>}
 */
export async function loadPromptOverrides(db, tag) {
  const { rows: [ready] } = await db.query(`SELECT to_regclass('public.enrich_prompt_overrides') IS NOT NULL AS ok`);
  if (!ready?.ok) return [];
  const { rows } = await db.query(
    `SELECT template_kind, position, formula, version FROM enrich_prompt_overrides WHERE client_tag = $1 ORDER BY template_kind DESC, position`,
    [tag]
  );
  return rows.map((r) => ({ template_kind: r.template_kind, position: Number(r.position), formula: r.formula, version: r.version }));
}

/** "P#60" for an override. */
export const overrideLabel = (o) => fromOf(o.template_kind, o.position);

/**
 * The originals with the overrides' prompts in place of the originals', and
 * the text variant of the steps they make the client's own (see the header).
 * A new map: the one given is not changed. Throws when an override's original
 * is missing or has no prompt binding.
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @param {PromptOverride[]} overrides
 * @param {{ variant?: string | null }} [opts]  the client's variant name (null: text variants are left as they are)
 * @returns {import("./compile-original.mjs").Originals}
 */
export function withPromptOverrides(originals, overrides, { variant = null } = {}) {
  const out = new Map(originals);
  /** @type {Set<"people" | "inboxes">} */
  const kinds = new Set();
  for (const o of overrides ?? []) {
    const k = `${o.template_kind}:${o.position}`;
    const row = out.get(k);
    if (!row) throw new Error(`${overrideLabel(o)}: its Clay original is not loaded`);
    const definition = structuredClone(row.definition ?? {});
    const binding = bindingOf(definition, "prompt");
    if (!binding) throw new Error(`${overrideLabel(o)}: its Clay original has no prompt`);
    binding.formulaText = o.formula;
    out.set(k, { ...row, definition, prompt_edited: true, ...(variant ? { text_variant: variant } : {}) });
    kinds.add(o.template_kind);
  }
  if (variant) {
    for (const kind of kinds) {
      for (const p of OVERLAY_POSITIONS[kind] ?? []) {
        if (PROMPT_POSITIONS[kind].includes(p)) continue; // an AI step is the client's own when edited, or by its own Clay text
        const k = `${kind}:${p}`;
        const row = out.get(k);
        if (row) out.set(k, { ...row, text_variant: variant });
      }
    }
  }
  return out;
}

/**
 * Marks each compiled editable step with config.prompt_source: "edited" when
 * its original carries an override's prompt (withPromptOverrides), else
 * "clay". Changes the compiled rows in place.
 *
 * @param {Record<string, Array<Record<string, any>>>} compiled  compileTemplates()'s lists
 * @param {import("./compile-original.mjs").Originals} originals  the originals they were compiled from
 */
export function markPromptSources(compiled, originals) {
  for (const kind of PROMPT_KINDS) {
    for (const position of PROMPT_POSITIONS[kind]) {
      const key = keyFor(kind, position);
      const col = compiled?.[kind]?.find((c) => c.key === key && c.action === "ai_web");
      if (!col) continue;
      col.config = { ...col.config, prompt_source: /** @type {any} */ (originals.get(`${kind}:${position}`))?.prompt_edited ? "edited" : "clay" };
    }
  }
}

/** The first line of an error, at most 200 characters. */
export const firstLine = (e, max = 200) => String(e?.message ?? e).split("\n")[0].slice(0, max);

/**
 * What a table's note says about the edits that were not applied (the Clay
 * original runs instead), or "" when there are none.
 *
 * @param {SkippedOverride[]} skipped  one kind's
 * @returns {string}
 */
export function skippedNote(skipped) {
  if (!skipped?.length) return "";
  return `; prompt edits not applied, the Clay original runs instead: ${skipped.map((s) => `${fromOf(/** @type {any} */ (s.template_kind), s.position)} (${String(s.reason).slice(0, 200)})`).join("; ")}`;
}
