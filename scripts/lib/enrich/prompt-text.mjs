// A personalisation prompt as the Clay tab's editor shows it, and back
// (migration 139, enrich_prompt_overrides). Pure: no database, no network.
//
// A Clay prompt is a JavaScript expression the engine evaluates per row
// (formula.mjs, node:vm), for example
//   "Write about " + Clay.formatForAIPrompt({{f_abc}}) + " in " + {{f_def}}?.city
// The editor never saves an expression a person typed: it shows the prompt as
// plain text with placeholders, and writes the expression itself.
//
//   promptToText(formula, catalogue)  the expression as text, when it is only
//     a concatenation (+) of JS string literals, column references ({{f_id}}
//     or {{key}}, optionally followed by ?.field, .field or ?.["field"]),
//     Clay.formatForAIPrompt(<reference>) and brackets around any of these.
//     Each reference is written {{Column Name}} or {{Column Name.field}}, with
//     the catalogue's names. Anything else (a condition, another call, another
//     operator, a comment, a read deeper than one field, two columns added
//     before any text) gives { ok: false, reason }: the editor then shows the
//     original read only, and a new text can still be written from scratch.
//   textToPrompt(text, catalogue)  the text as the expression the pipeline
//     runs: every piece of text JSON-quoted, every placeholder
//     Clay.formatForAIPrompt(<the column's ref>), with ?.field (or
//     ?.["field"]) for a field, joined with +. A placeholder that names no
//     column of the catalogue, or a field the column does not have, is an
//     error that names it.
//
// Placeholders: {{Name}} and {{Name.field}}. Names match whatever their case
// and extra spaces; {{ and }} mean a placeholder and nothing else, so a text
// that holds them outside one is refused, both ways.
//
// The catalogue (prompt-editor.mjs promptCatalogue) lists the columns a step
// may read: { name, ref, key, fields? }, ref "{{f_<field id>}}" for a column
// compiled from a Clay original (rewritten to its key when the table is
// compiled, as the original's own references are) or "{{<key>}}" for one of
// the template's own columns. Names are unique within a catalogue.

/** @typedef {{ name: string, ref: string, key: string, fields?: string[] }} PromptCatalogueEntry */
/** @typedef {{ text: string } | { ref: string, field: string | null, formatted: boolean }} PromptPart */

/** A placeholder in the editor's text: {{ then anything but braces, then }}. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
/** A column reference in an expression, as formula.mjs and the compiler read them. */
const REF_TOKEN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/y;
const IDENT = /[A-Za-z_$][\w$]*/y;
const IDENT_ONLY = /^[A-Za-z_$][\w$]*$/;

/** A name as placeholders match it: spaces made single, trimmed, lower case. */
export const normName = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Why an expression can't be shown as text. */
class Unreadable extends Error {}

const SOME = (what) => new Unreadable(`It uses ${what}, which the editor does not write`);

/**
 * One JavaScript string literal from `start` (its opening quote), with the
 * usual escapes worked out. Legacy octal escapes and a raw line break are
 * refused (never guessed).
 *
 * @param {string} src
 * @param {number} start
 * @returns {{ value: string, end: number }}
 */
function readString(src, start) {
  const q = src[start];
  let out = "";
  let i = start + 1;
  while (i < src.length) {
    const c = src[i];
    if (c === q) return { value: out, end: i + 1 };
    if (c === "\n" || c === "\r") break;
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const d = src[i + 1];
    if (d === undefined) break;
    i += 2;
    switch (d) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "v":
        out += "\v";
        break;
      case "0":
        if (/[0-9]/.test(src[i] ?? "")) throw SOME("an octal escape");
        out += "\0";
        break;
      case "x": {
        const h = src.slice(i, i + 2);
        if (!/^[0-9A-Fa-f]{2}$/.test(h)) throw SOME("a broken escape");
        out += String.fromCharCode(parseInt(h, 16));
        i += 2;
        break;
      }
      case "u": {
        if (src[i] === "{") {
          const end = src.indexOf("}", i);
          const h = end < 0 ? "" : src.slice(i + 1, end);
          const cp = /^[0-9A-Fa-f]{1,6}$/.test(h) ? parseInt(h, 16) : NaN;
          if (!(cp <= 0x10ffff)) throw SOME("a broken escape");
          out += String.fromCodePoint(cp);
          i = end + 1;
        } else {
          const h = src.slice(i, i + 4);
          if (!/^[0-9A-Fa-f]{4}$/.test(h)) throw SOME("a broken escape");
          out += String.fromCharCode(parseInt(h, 16));
          i += 4;
        }
        break;
      }
      case "\r": // a line continuation
        if (src[i] === "\n") i++;
        break;
      case "\n":
      case " ":
      case " ":
        break;
      default:
        if (/[1-9]/.test(d)) throw SOME("an octal escape");
        out += d;
    }
  }
  throw SOME("a text that is not closed");
}

/** The expression's tokens: str, ref, id, +, (, ), [, ], ?. and . */
function tokens(src) {
  /** @type {Array<{ t: string, v?: string }>} */
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c) || c === "﻿") {
      i++;
      continue;
    }
    if (c === "/" && (src[i + 1] === "/" || src[i + 1] === "*")) throw SOME("a comment");
    if (c === '"' || c === "'") {
      const s = readString(src, i);
      out.push({ t: "str", v: s.value });
      i = s.end;
      continue;
    }
    if (c === "`") throw SOME("a template literal");
    if (c === "{") {
      REF_TOKEN.lastIndex = i;
      const m = REF_TOKEN.exec(src);
      if (!m) throw SOME("a brace that is no column reference");
      out.push({ t: "ref", v: m[1] });
      i = REF_TOKEN.lastIndex;
      continue;
    }
    if (c === "+") {
      if (src[i + 1] === "+" || src[i + 1] === "=") throw SOME("an operator other than +");
      out.push({ t: "+" });
      i++;
      continue;
    }
    if (c === "(" || c === ")" || c === "[" || c === "]") {
      out.push({ t: c });
      i++;
      continue;
    }
    if (c === "?" && src[i + 1] === "." && !/[0-9]/.test(src[i + 2] ?? "")) {
      out.push({ t: "?." });
      i += 2;
      continue;
    }
    if (c === "." && !/[0-9]/.test(src[i + 1] ?? "")) {
      out.push({ t: "." });
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      IDENT.lastIndex = i;
      const m = IDENT.exec(src);
      out.push({ t: "id", v: m?.[0] ?? c });
      i = IDENT.lastIndex;
      continue;
    }
    if (/[0-9.]/.test(c)) throw SOME("a number");
    if (c === "?" || c === ":") throw SOME("a condition (? :)");
    throw SOME("an operator other than +");
  }
  return out;
}

/**
 * The parts of an expression the editor can show as text, in order: pieces of
 * text and column references (with one field at most), or why it can't.
 * Structural only: which columns the references name is not checked here.
 *
 * @param {string | null | undefined} formula
 * @returns {{ ok: true, parts: PromptPart[] } | { ok: false, reason: string }}
 */
export function parsePrompt(formula) {
  if (typeof formula !== "string" || !formula.trim()) return { ok: false, reason: "There is no prompt" };
  try {
    const toks = tokens(formula);
    let p = 0;
    const peek = () => toks[p];
    const take = (t) => (toks[p]?.t === t ? toks[p++] : null);
    const expect = (t, why) => {
      if (!take(t)) throw SOME(why);
    };
    /** The field read after a reference: one level at most, never a call. */
    const access = () => {
      /** @type {string | null} */
      let field = null;
      if (take("?.")) {
        if (peek()?.t === "id") field = /** @type {string} */ (toks[p++].v);
        else if (take("[")) {
          const s = take("str");
          if (!s) throw SOME("a field worked out by an expression");
          expect("]", "a bracket that is not closed");
          field = /** @type {string} */ (s.v);
        } else throw SOME("a call");
      } else if (take(".")) {
        const id = take("id");
        if (!id) throw SOME("a field worked out by an expression");
        field = /** @type {string} */ (id.v);
      } else if (take("[")) {
        const s = take("str");
        if (!s) throw SOME("a field worked out by an expression");
        expect("]", "a bracket that is not closed");
        field = /** @type {string} */ (s.v);
      }
      const next = peek()?.t;
      if (next === "?." || next === "." || next === "[") throw SOME("a read deeper than one field");
      if (next === "(") throw SOME("a call");
      return field;
    };
    const arg = () => {
      if (take("(")) {
        const a = arg();
        expect(")", "a bracket that is not closed");
        return a;
      }
      const r = take("ref");
      if (!r) throw SOME("Clay.formatForAIPrompt of something other than one column");
      return { ref: /** @type {string} */ (r.v), field: access() };
    };
    /** @returns {{ parts: PromptPart[], str: boolean }} */
    const term = () => {
      const tk = peek();
      if (!tk) throw SOME("an expression that ends too early");
      if (take("(")) {
        const e = expr();
        expect(")", "a bracket that is not closed");
        return e;
      }
      if (tk.t === "str") {
        p++;
        return { parts: [{ text: /** @type {string} */ (tk.v) }], str: true };
      }
      if (tk.t === "ref") {
        p++;
        return { parts: [{ ref: /** @type {string} */ (tk.v), field: access(), formatted: false }], str: false };
      }
      if (tk.t === "id" && tk.v === "Clay" && toks[p + 1]?.t === "." && toks[p + 2]?.t === "id" && toks[p + 2].v === "formatForAIPrompt" && toks[p + 3]?.t === "(") {
        p += 4;
        const a = arg();
        expect(")", "a bracket that is not closed");
        return { parts: [{ ref: a.ref, field: a.field, formatted: true }], str: true };
      }
      throw SOME(tk.t === "id" ? "a name that is no column (a function or a variable)" : "an operator where a text or a column should be");
    };
    /** @returns {{ parts: PromptPart[], str: boolean }} */
    const expr = () => {
      const chain = [term()];
      while (take("+")) chain.push(term());
      // JavaScript adds left to right: two columns first may add up as numbers instead of joining as text.
      if (chain.length > 1 && !chain[0].str && !chain[1].str) throw SOME("two columns added before any text (they may add up as numbers)");
      return { parts: chain.flatMap((x) => x.parts), str: chain.length > 1 || chain[0].str };
    };
    const e = expr();
    if (p < toks.length) throw SOME(toks[p].t === "(" ? "a call" : "an operator other than +");
    return { ok: true, parts: e.parts };
  } catch (err) {
    if (err instanceof Unreadable) return { ok: false, reason: err.message };
    throw err;
  }
}

/** The catalogue looked up by a reference's id ("f_abc" or a key), by key and by name. */
function indexOf(catalogue) {
  const byRef = new Map();
  const byKey = new Map();
  const byName = new Map();
  for (const e of catalogue ?? []) {
    const m = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/.exec(String(e?.ref ?? ""));
    if (m && !byRef.has(m[1])) byRef.set(m[1], e);
    if (e?.key && !byKey.has(e.key)) byKey.set(e.key, e);
    const n = normName(e?.name);
    if (n && !byName.has(n)) byName.set(n, e);
  }
  return { byRef, byKey, byName };
}

/** A field of a catalogue column: exactly as written, else whatever its case and spaces; null when it has none such. */
function fieldOf(entry, want) {
  const list = Array.isArray(entry?.fields) ? entry.fields : [];
  return list.find((f) => f === want) ?? list.find((f) => normName(f) === normName(want)) ?? null;
}

/**
 * An expression as the editor's text, or why it can't be shown so.
 *
 * @param {string | null | undefined} formula
 * @param {PromptCatalogueEntry[]} catalogue
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function promptToText(formula, catalogue) {
  const parsed = parsePrompt(formula);
  if (!parsed.ok) return parsed;
  const index = indexOf(catalogue);
  let text = "";
  let run = "";
  for (const part of parsed.parts) {
    if ("text" in part) {
      run += part.text;
      continue;
    }
    const e = index.byRef.get(part.ref) ?? index.byKey.get(part.ref);
    if (!e) return { ok: false, reason: "It reads a column this step can't read in the editor (a later or hidden column)" };
    let placeholder = e.name;
    if (part.field != null) {
      const f = (Array.isArray(e.fields) ? e.fields : []).find((x) => x === part.field);
      if (!f) return { ok: false, reason: `It reads a field of ${e.name} the editor does not list` };
      if (/[{}]/.test(f) || index.byName.has(normName(`${e.name}.${f}`))) return { ok: false, reason: `It reads a field of ${e.name} that can't be written as a placeholder` };
      placeholder = `${e.name}.${f}`;
    }
    if (run.includes("{{") || run.includes("}}")) return { ok: false, reason: 'Its text holds "{{" or "}}", which the editor keeps for placeholders' };
    text += `${run}{{${placeholder}}}`;
    run = "";
  }
  if (run.includes("{{") || run.includes("}}")) return { ok: false, reason: 'Its text holds "{{" or "}}", which the editor keeps for placeholders' };
  return { ok: true, text: text + run };
}

/** A few characters around a spot of the text, for an error. */
function near(text, at) {
  const s = text.slice(Math.max(0, at - 20), at + 20).replace(/\s+/g, " ").trim();
  return s.length > 0 ? `"${s}"` : "the start";
}

/** ?.field, or ?.["field"] for a field that is no plain name. */
const fieldAccess = (f) => (IDENT_ONLY.test(f) ? `?.${f}` : `?.[${JSON.stringify(f)}]`);

/**
 * The editor's text as the expression the pipeline runs, or the errors that
 * stop it (each naming the placeholder or the spot). Nothing a person typed
 * reaches the expression except as quoted text.
 *
 * @param {string | null | undefined} text
 * @param {PromptCatalogueEntry[]} catalogue
 * @returns {{ formula: string | null, errors: string[] }}
 */
export function textToPrompt(text, catalogue) {
  const src = typeof text === "string" ? text : "";
  if (!src.trim()) return { formula: null, errors: ["The prompt is empty"] };
  const index = indexOf(catalogue);
  /** @type {string[]} */
  const errors = [];
  const fail = (e) => {
    if (!errors.includes(e)) errors.push(e);
  };
  /** @type {string[]} */
  const parts = [];
  const literal = (s, at) => {
    if (!s) return;
    const hits = [s.indexOf("{{"), s.indexOf("}}")].filter((n) => n >= 0);
    if (hits.length) {
      fail(`"{{" or "}}" outside a placeholder near ${near(src, at + Math.min(...hits))}: a placeholder is {{Column name}} or {{Column name.field}}`);
      return;
    }
    parts.push(JSON.stringify(s));
  };
  let last = 0;
  for (const m of src.matchAll(PLACEHOLDER)) {
    const at = /** @type {number} */ (m.index);
    literal(src.slice(last, at), last);
    last = at + m[0].length;
    const raw = m[1].replace(/\s+/g, " ").trim();
    if (!raw) {
      fail("An empty placeholder {{ }}: write a column's name inside");
      continue;
    }
    const whole = index.byName.get(normName(raw));
    if (whole) {
      parts.push(`Clay.formatForAIPrompt(${whole.ref})`);
      continue;
    }
    let done = false;
    for (let dot = raw.lastIndexOf("."); dot > 0; dot = raw.lastIndexOf(".", dot - 1)) {
      const e = index.byName.get(normName(raw.slice(0, dot)));
      if (!e) continue;
      const want = raw.slice(dot + 1).trim();
      const f = want ? fieldOf(e, want) : null;
      if (f != null) parts.push(`Clay.formatForAIPrompt(${e.ref}${fieldAccess(f)})`);
      else if (Array.isArray(e.fields) && e.fields.length) fail(`{{${raw}}}: ${e.name} has no field "${want}" (its fields: ${e.fields.join(", ")})`);
      else fail(`{{${raw}}}: ${e.name} has no fields to read`);
      done = true;
      break;
    }
    if (!done) fail(`Unknown placeholder {{${raw}}}: no column this step can read is called "${raw}"`);
  }
  literal(src.slice(last), last);
  if (errors.length) return { formula: null, errors };
  return { formula: parts.join(" + "), errors: [] };
}
