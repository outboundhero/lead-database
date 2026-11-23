// Loading the original Clay columns into enrich_originals (2A.1), for
// scripts/enrich-seed-originals.mjs and the tests.
//
// The exports are the Clay CLI's files ({ workspace, data: [...] }), one per
// table, kept outside this public repo: they hold client text (D1). The seed
//   1. refuses an export unless it has 68, 88 and 76 columns, and each
//      column's name fits the key expected at its position (ORIGINAL_KEYS), so
//      a client whose table layout differs stops here (D15);
//   2. lists in unknown_refs any {{f_<id>}} that matches no column of the three
//      exports (they appear only in Clay's formulaPrompt texts);
//   3. derives the people tracks (D11) from the role finders' "roles" and the
//      AI searches' title lists, and refuses a phrase its cited column does
//      not hold verbatim; a file of tracks may be given instead, and is checked
//      the same way;
//   4. compares each AI column's model with the models setting, and only says
//      so: it never overwrites a setting;
//   5. writes everything in one transaction (people_tracks only for the
//      default variant, the one shared setting), and reports counts, never
//      prompt text.
//
// A client's own tables rarely keep that layout (columns added, removed,
// moved or renamed), so they load by name instead (seedByName, 4.1 and
// 4.2): each column matched to the default's layout by its name, then by
// its field id; missing positions filled from the default with their
// references re-pointed; the variant refused when a compiled column differs
// or the templates do not compile from it. The default stays an
// exact-layout load (seedOriginals).
//
// Since 2026-11-21 the default is refreshed from the template client's
// current tables (refreshDefault: matched by name, columns added since 11-14
// stored at extension positions), and a client keeps only its own
// personalisation columns, as an overlay on the default (personalisationOverlay,
// seedPersonalisation): every client runs the default's other steps. Every
// loader stores definitions with their credentials redacted
// (redactCredentials): the Clay CLI's exports hold live API keys.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { examplesFor } from "./ai-examples.mjs";
import { CLAY_REF, OriginalsMissing, answerFields, bindingText, fromOf, loadOriginals, originalOf, parseFrom } from "./compile-original.mjs";
import { evaluate, makeContext } from "./formula.mjs";
import {
  keysOf, NAME_ALIASES, nameFits, ORIGINAL_COUNTS, ORIGINAL_EXTENSIONS, ORIGINAL_KEYS, ORIGINAL_KINDS, OVERLAY_AI_POSITIONS, OVERLAY_POSITIONS, slugKey,
} from "./original-keys.mjs";
import { settingsFrom, TRACKS } from "./settings.mjs";
import { compileTemplates } from "./templates.mjs";
import { COMPANY_COLUMNS_V2 } from "./company-template-v2.mjs";
import { INBOX_COLUMNS, INBOX_INPUTS } from "./inbox-template.mjs";
import { PEOPLE_COLUMNS, PEOPLE_INPUTS } from "./people-template.mjs";

/** The AI columns and the model setting each reads (6.2). */
export const AI_COLUMNS = Object.freeze({
  "C#24": "companys_website",
  "C#31": "email_extraction_claygent",
  "C#32": "email_extraction_claygent_2",
  "C#41": "company_decision_maker_facilities_1_claygent",
  "C#48": "company_decision_maker_facilities_2_claygent",
  "C#50": "company_decision_maker_location_company_check",
  "C#56": "company_decision_maker_ceo_claygent",
  "P#27": "current_employer",
  "P#60": "people_claygent",
  "P#61": "people_question_ai",
  "G#19": "inbox_first_name_ai",
  "G#48": "inbox_claygent",
  "G#49": "inbox_question_ai",
});

/**
 * Where each track's phrases come from, in Spencer's order (D11): the role
 * finder's "roles" first, then the AI search's title list.
 */
export const TRACK_SOURCES = Object.freeze({
  operations: Object.freeze(["C#37", "C#41"]),
  facility_office: Object.freeze(["C#44", "C#48"]),
  ceo: Object.freeze(["C#52", "C#56"]),
});

const text = (v) => (v == null ? "" : String(v));

/**
 * One export file: its parsed body and the sha256 of its bytes.
 *
 * @param {string} path
 * @returns {{ path: string, sha256: string, data: any[] }}
 */
export function readExport(path) {
  const bytes = readFileSync(path);
  let body;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${path} is not JSON`);
  }
  if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
    throw new Error(`${path} is not a Clay CLI export: it has no data list`);
  }
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), data: body.data };
}

/**
 * Why an export's layout does not fit its template kind: the column count and
 * each position's name (the names themselves are never printed).
 *
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {any[]} data
 * @returns {string[]}
 */
export function layoutProblems(kind, data) {
  const want = ORIGINAL_COUNTS[kind];
  if (!Array.isArray(data) || data.length !== want) return [`${kind}: ${Array.isArray(data) ? data.length : 0} columns, ${want} expected`];
  const out = [];
  data.forEach((c, i) => {
    const pos = i + 1;
    if (!c || typeof c !== "object" || typeof c.id !== "string" || !/^f_[A-Za-z0-9_]+$/.test(c.id)) {
      out.push(`${fromOf(kind, pos)} has no field id`);
    } else if (!["source", "basic", "action"].includes(c.type)) {
      out.push(`${fromOf(kind, pos)} has an unknown type`);
    } else if (typeof c.name !== "string" || !nameFits(kind, pos, c.name)) {
      out.push(`${fromOf(kind, pos)}'s name does not fit the key ${ORIGINAL_KEYS[kind][pos]}`);
    }
  });
  return out;
}

/** Every string inside a value, depth first. */
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// ── Credentials ─────────────────────────────────────────────────────────────

/** What a credential is stored as (the stored default and the fixtures already hold it so). */
export const REDACTED = "[redacted]";
/** The bindings an http-api-v2 column sends a key in, and the names a key goes by there. */
const CREDENTIAL_BINDINGS = Object.freeze(["headers", "queryString"]);
const CREDENTIAL_KEY = /^(authorization|x-api-key|api[-_]?key|apikey|key|token|access[-_]?token|secret)$/i;
/** A string literal longer than 16 characters inside a formula. */
const LONG_LITERAL = /"(?:[^"\\]|\\.){17,}"|'(?:[^'\\]|\\.){17,}'/;

/**
 * A copy of a Clay column with every credential replaced by REDACTED: in each
 * inputsBinding named "headers" or "queryString", the formulaMap value of a
 * key matching CREDENTIAL_KEY; a value that already holds a {{f_ reference is
 * left (it reads a column, it is no key). The values are never returned or
 * printed: only how many were replaced, and (refused) the bindings still
 * holding a string literal longer than 16 characters next to such a
 * reference, which no loader stores ("a credential could not be redacted").
 *
 * @param {any} column  a Clay column as exported
 * @returns {{ column: any, redacted: number, refused: string[] }}  refused: "headers.Authorization" and the like
 */
export function redactCredentials(column) {
  const out = column && typeof column === "object" ? structuredClone(column) : column;
  let redacted = 0;
  /** @type {string[]} */
  const refused = [];
  const list = out?.settings?.inputsBinding;
  for (const b of Array.isArray(list) ? list : []) {
    if (!b || !CREDENTIAL_BINDINGS.includes(b.name) || !b.formulaMap || typeof b.formulaMap !== "object") continue;
    for (const [k, v] of Object.entries(b.formulaMap)) {
      if (!CREDENTIAL_KEY.test(k) || v == null || (typeof v !== "string" && typeof v !== "number")) continue;
      const s = String(v);
      if (!s.trim() || s === REDACTED) continue;
      if (/\{\{\s*f_/.test(s)) {
        if (LONG_LITERAL.test(s)) refused.push(`${b.name}.${k}`);
        continue;
      }
      b.formulaMap[k] = REDACTED;
      redacted++;
    }
  }
  return { column: out, redacted, refused };
}

/**
 * The enrich_originals rows of three exports, one variant, with each column's
 * unknown references. Every definition is stored with its credentials
 * redacted (redactCredentials); a credential that can't be redacted refuses
 * the load.
 *
 * @param {{ companies: { sha256: string, data: any[] }, people: { sha256: string, data: any[] }, inboxes: { sha256: string, data: any[] } }} exports
 * @param {{ variant?: string, seededBy?: string | null, stats?: { redacted?: Record<string, number> } | null }} [opts]
 *   stats: when given, stats.redacted gets the values redacted per kind
 * @returns {Array<import("./compile-original.mjs").OriginalRow & { seeded_by: string | null }>}
 */
export function originalRows(exports, { variant = "default", seededBy = null, stats = null } = {}) {
  const ids = new Set();
  for (const kind of ORIGINAL_KINDS) for (const c of exports[kind].data) ids.add(c.id);
  const rows = [];
  /** @type {Record<string, number>} */
  const redactedBy = { companies: 0, people: 0, inboxes: 0 };
  for (const kind of ORIGINAL_KINDS) {
    exports[kind].data.forEach((c, i) => {
      const unknown = new Set();
      for (const s of strings(c.settings ?? {})) for (const m of s.matchAll(CLAY_REF)) if (!ids.has(m[1])) unknown.add(m[1]);
      const safe = redactCredentials(c);
      if (safe.refused.length) throw new Error(`${fromOf(kind, i + 1)}: a credential could not be redacted, so nothing was loaded`);
      redactedBy[kind] += safe.redacted;
      rows.push({
        variant,
        template_kind: /** @type {any} */ (kind),
        position: i + 1,
        key: ORIGINAL_KEYS[kind][i + 1],
        name: c.name,
        clay_field_id: c.id,
        clay_type: c.type,
        clay_action: c.type === "action" ? text(c.settings?.actionKey) || null : null,
        definition: safe.column,
        unknown_refs: [...unknown],
        source_sha256: exports[kind].sha256,
        seeded_by: seededBy,
      });
    });
  }
  if (stats) stats.redacted = redactedBy;
  return rows;
}

/** The rows keyed "kind:position", as loadOriginals() gives them. */
export const originalsMap = (rows) => new Map(rows.map((r) => [`${r.template_kind}:${r.position}`, r]));

// ── The people tracks (D11) ─────────────────────────────────────────────────

/** A role finder's "roles": its body formula worked out with a made-up domain, then read as JSON. */
function finderRoles(def) {
  const body = bindingText(def, "body");
  if (!body) return [];
  const expr = body.replace(CLAY_REF, "{{x}}");
  let out;
  try {
    out = JSON.parse(String(evaluate(makeContext(), expr, { x: "example.com" })));
  } catch {
    return [];
  }
  return Array.isArray(out?.roles) ? out.roles.filter((r) => typeof r === "string" && r.trim()).map((r) => r.trim()) : [];
}

/**
 * An AI search's title list: the comma list after the prompt's opening
 * "Identify the ", up to where the sentence goes on (" likely ", or " of " / " at "
 * before a column). An item that holds a column (C#41's "<city> Office
 * Operations") is left out: it holds the city.
 */
function promptTitles(def) {
  const prompt = bindingText(def, "prompt");
  if (!prompt) return [];
  const pieces = [];
  const rx = /"((?:[^"\\]|\\.)*)"|\{\{\s*f_[A-Za-z0-9_]+\s*\}\}/g;
  for (const m of prompt.matchAll(rx)) {
    if (m[1] == null) pieces.push("\u0001");
    else {
      try {
        pieces.push(JSON.parse(`"${m[1]}"`));
      } catch {
        pieces.push(m[1]);
      }
    }
  }
  const all = pieces.join("");
  const at = all.indexOf("Identify the ");
  if (at < 0) return [];
  const rest = all.slice(at + "Identify the ".length);
  const end = rest.search(/ likely | of \u0001| at \u0001|\.\s|\n/);
  const list = end >= 0 ? rest.slice(0, end) : rest;
  return list
    .split(/,\s*(?:or\s+|and\s+)?|\s+or\s+/)
    .map((t) => t.trim())
    .filter((t) => t && !t.includes("\u0001"));
}

/**
 * The people tracks derived from the originals: per track, the role finder's
 * roles, then the AI search's titles that are not already there (no case).
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @returns {import("./settings.mjs").PeopleTracks}
 */
export function deriveTracks(originals) {
  /** @type {any} */
  const out = { order: [...TRACKS] };
  for (const t of TRACKS) {
    const [finder, search] = TRACK_SOURCES[t];
    const phrases = [];
    const seen = new Set();
    for (const p of [...finderRoles(originalOf(originals, finder).definition), ...promptTitles(originalOf(originals, search).definition)]) {
      const k = p.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      phrases.push(p);
    }
    out[t] = { phrases, from: [finder, search] };
  }
  return out;
}

/**
 * Why a tracks value can't be stored: a track missing or empty, or a phrase
 * that none of its cited columns holds verbatim.
 *
 * @param {any} tracks
 * @param {import("./compile-original.mjs").Originals} originals
 * @returns {string[]}
 */
export function trackProblems(tracks, originals) {
  const out = [];
  if (!tracks || typeof tracks !== "object") return ["No tracks"];
  for (const t of TRACKS) {
    const x = tracks[t];
    if (!x || !Array.isArray(x.phrases) || !x.phrases.length) {
      out.push(`${t}: no phrases`);
      continue;
    }
    const from = Array.isArray(x.from) && x.from.length ? x.from : TRACK_SOURCES[t];
    let texts;
    try {
      texts = from.map((f) => JSON.stringify(originalOf(originals, f).definition?.settings ?? {}));
    } catch (e) {
      out.push(`${t}: ${e.message}`);
      continue;
    }
    // JSON keeps a phrase's letters as they are; quotes inside it would be escaped.
    const held = (p) => texts.some((s) => s.includes(JSON.stringify(p).slice(1, -1)));
    x.phrases.forEach((p, i) => {
      if (typeof p !== "string" || !p.trim()) out.push(`${t}: phrase ${i + 1} is empty`);
      else if (!held(p)) out.push(`${t}: phrase ${i + 1} is not in ${from.join(" or ")}`);
    });
  }
  return out;
}

// ── Models ──────────────────────────────────────────────────────────────────

/**
 * Each AI column's original model beside the setting it runs with. The seed
 * prints the ones that differ; it never changes a setting.
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @param {Array<{ key: string, value: any }>} settingRows
 * @returns {Array<{ from: string, setting: string, original: string | null, current: string | null }>}
 */
export function modelDifferences(originals, settingRows) {
  const models = settingsFrom(settingRows).models;
  const out = [];
  for (const [from, setting] of Object.entries(AI_COLUMNS)) {
    let original = null;
    try {
      const raw = bindingText(originalOf(originals, from).definition, "model");
      original = raw ? JSON.parse(raw) : null;
    } catch {
      original = null;
    }
    const current = models[setting]?.model ?? null;
    if (original !== current) out.push({ from, setting, original, current });
  }
  return out;
}

// ── Writing ─────────────────────────────────────────────────────────────────

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 */

/**
 * Seeds one variant of the originals, inside the caller's transaction (the
 * CLI opens it and rolls it back for --dry). Refuses a different layout, an
 * unusable variant name, and tracks a cited column does not hold.
 *
 * @param {Db} db
 * @param {{ exports: { companies: { sha256: string, data: any[] }, people: { sha256: string, data: any[] }, inboxes: { sha256: string, data: any[] } },
 *           variant?: string, seededBy?: string | null, tracks?: any }} opts
 *   tracks: the people tracks to store (checked), else they are derived from the originals
 * @returns {Promise<{ variant: string, counts: Record<string, number>, unknown: Array<{ from: string, ids: number }>,
 *   tracks: { stored: boolean, phrases: Record<string, number> }, models: ReturnType<typeof modelDifferences>, replaced: number }>}
 */
export async function seedOriginals(db, { exports, variant = "default", seededBy = null, tracks = null }) {
  if (!/^[a-z0-9][a-z0-9_]*$/.test(variant)) throw new Error(`"${variant}" is not a variant name (lower case letters, digits and _)`);
  const problems = ORIGINAL_KINDS.flatMap((k) => layoutProblems(k, exports?.[k]?.data));
  if (problems.length) throw new Error(`The exports' layout differs from the originals', so nothing was loaded:\n  ${problems.slice(0, 20).join("\n  ")}`);
  const rows = originalRows(exports, { variant, seededBy });
  const originals = originalsMap(rows);
  const chosen = tracks ?? deriveTracks(originals);
  const bad = trackProblems(chosen, originals);
  if (bad.length) throw new Error(`The people tracks were refused, so nothing was loaded:\n  ${bad.join("\n  ")}`);
  const { rows: settingRows } = await db.query(`SELECT key, value FROM enrich_settings`);
  const models = modelDifferences(originals, settingRows);

  const { rowCount: replaced } = await db.query(`DELETE FROM enrich_originals WHERE variant = $1`, [variant]);
  await db.query(
    `INSERT INTO enrich_originals (variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition,
                                   unknown_refs, source_sha256, seeded_by, seeded_at)
     SELECT x.variant, x.template_kind, x.position, x.key, x.name, x.clay_field_id, x.clay_type, x.clay_action, x.definition,
            coalesce(x.unknown_refs, '{}'), x.source_sha256, x.seeded_by, now()
       FROM jsonb_to_recordset($1::jsonb) AS x(variant text, template_kind text, position int, key text, name text,
            clay_field_id text, clay_type text, clay_action text, definition jsonb, unknown_refs text[], source_sha256 text,
            seeded_by text)`,
    [JSON.stringify(rows)]
  );
  let stored = false;
  if (variant === "default") {
    await db.query(
      `INSERT INTO enrich_settings (key, value, updated_at) VALUES ('people_tracks', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        WHERE enrich_settings.value IS DISTINCT FROM EXCLUDED.value`,
      [JSON.stringify(chosen)]
    );
    stored = true;
  }
  /** @type {Record<string, number>} */
  const counts = {};
  for (const k of ORIGINAL_KINDS) counts[k] = rows.filter((r) => r.template_kind === k).length;
  return {
    variant,
    counts,
    unknown: rows.filter((r) => r.unknown_refs.length).map((r) => ({ from: fromOf(r.template_kind, r.position), ids: r.unknown_refs.length })),
    tracks: { stored, phrases: Object.fromEntries(TRACKS.map((t) => [t, chosen[t].phrases.length])) },
    models,
    replaced: replaced ?? 0,
  };
}

// ── By name: a client's own tables (4.1, 4.2) ───────────────────────────────

/** The original positions the templates compile: every C#n, P#n and G#n their columns name as `from`. */
export const COMPILED_POSITIONS = Object.freeze([
  ...new Set([...COMPANY_COLUMNS_V2, ...INBOX_INPUTS, ...INBOX_COLUMNS, ...PEOPLE_INPUTS, ...PEOPLE_COLUMNS].map((c) => c?.from).filter((f) => parseFrom(f))),
]);

/** The research and question AI columns a client variant must hold as its own (D16). */
export const OWN_AI_POSITIONS = Object.freeze(["P#60", "P#61", "G#48", "G#49"]);

/** The AI columns whose table examples the by-name seed counts (reported only). */
export const EXAMPLE_POSITIONS = Object.freeze(["P#61", "G#49", "G#19"]);

const FIELD_ID = /^f_[A-Za-z0-9_]+$/;
const CLAY_TYPES = Object.freeze(["source", "basic", "action"]);
/** A field id standing alone in a text: inside {{...}}, or a bare key such as a write-to's formulaMap key. */
const ID_TOKEN = /(?<![A-Za-z0-9_])f_[A-Za-z0-9_]+/g;
const KIND_LABEL = Object.freeze({ companies: "Companies", people: "People", inboxes: "General" });
const firstLine = (e) => String(e?.message ?? e ?? "").split("\n")[0];
const byPosition = (a, b) => a.position - b.position;

/**
 * A client's export of one table matched to the default's layout by column
 * name (4.1). A position's canonical name is the slug (slugKey) of the base
 * variant's column name there, so C#3 and C#4 are covered too. A client
 * column matches the position whose canonical slug equals the slug of its own
 * name, read through NAME_ALIASES unless that slug is itself canonical. Two
 * client columns with one slug are both ambiguous and neither is matched. A
 * position still unmatched then takes an unmatched, unambiguous client column
 * holding the base's field id for that position (renamed). The other client
 * columns are extra (never stored); the positions left are missing
 * (mergeVariant fills them from the base).
 *
 * withExtensions: the canonical positions are the base's positions 1..count
 * plus any extension positions (ORIGINAL_EXTENSIONS) the base holds, so a
 * refreshed default's extension columns match too. Without it, positions
 * 1..count only, as before.
 *
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {any[]} data  the export's columns, as the Clay CLI lists them
 * @param {Array<{ template_kind: string, position: number, name: string, clay_field_id: string }>} defaultRows  the base variant's rows (any kinds)
 * @param {{ aliases?: Record<string, string>, withExtensions?: boolean }} [opts]
 * @returns {{ byPosition: Map<number, any>, sameplace: Array<{ position: number, name: string }>,
 *   moved: Array<{ position: number, at: number, name: string }>, renamed: Array<{ position: number, at: number, name: string }>,
 *   aliased: Array<{ position: number, at: number, name: string }>, extra: string[], ambiguous: string[], ambiguousAt: number[],
 *   missing: number[] }}
 *   at: the column's own position in the export; ambiguousAt: positions whose name two client columns gave
 */
export function mapByName(kind, data, defaultRows, { aliases = NAME_ALIASES[kind], withExtensions = false } = {}) {
  const total = ORIGINAL_COUNTS[kind];
  /** @type {Map<number, any>} */
  const base = new Map();
  for (const r of defaultRows ?? []) if (r?.template_kind === kind) base.set(r.position, r);
  const positions = Array.from({ length: total }, (_, i) => i + 1);
  if (withExtensions) {
    for (const p of Object.keys(ORIGINAL_EXTENSIONS[kind]).map(Number).sort((a, b) => a - b)) if (base.has(p)) positions.push(p);
  }
  /** @type {Map<string, number>} */
  const canon = new Map();
  const shared = new Set();
  for (const p of positions) {
    const s = slugKey(base.get(p)?.name ?? "");
    if (!s) continue;
    if (canon.has(s)) shared.add(s);
    else canon.set(s, p);
  }
  for (const s of shared) canon.delete(s); // a name two positions share matches neither by name
  const cols = Array.isArray(data) ? data : [];
  const slugOf = (c) => {
    const s = slugKey(c?.name ?? "");
    return canon.has(s) ? s : aliases?.[s] ?? s;
  };
  /** @type {Map<string, number[]>} */
  const bySlug = new Map();
  cols.forEach((c, i) => {
    const s = slugOf(c);
    if (!s) return;
    if (!bySlug.has(s)) bySlug.set(s, []);
    bySlug.get(s).push(i);
  });
  /** @type {Map<number, any>} */
  const matched = new Map();
  const taken = new Set();
  const ambiguousIdx = new Set();
  const out = { sameplace: [], moved: [], renamed: [], aliased: [], extra: [], ambiguous: [], ambiguousAt: [], missing: [] };
  const nameAt = (i) => String(cols[i]?.name ?? "");
  for (const [s, idxs] of bySlug) {
    const p = canon.get(s);
    if (idxs.length > 1) {
      for (const i of idxs) ambiguousIdx.add(i);
      if (p != null) out.ambiguousAt.push(p);
      continue;
    }
    if (p == null) continue;
    const i = idxs[0];
    matched.set(p, cols[i]);
    taken.add(i);
    const entry = { position: p, at: i + 1, name: nameAt(i) };
    if (i + 1 === p) out.sameplace.push({ position: p, name: entry.name });
    else out.moved.push(entry);
    if (slugKey(cols[i]?.name ?? "") !== s) out.aliased.push(entry);
  }
  // A renamed column keeps its field id. Two client columns with one id match neither.
  /** @type {Map<string, number>} */
  const byId = new Map();
  cols.forEach((c, i) => {
    if (taken.has(i) || ambiguousIdx.has(i) || typeof c?.id !== "string") return;
    byId.set(c.id, byId.has(c.id) ? -1 : i);
  });
  for (const p of positions) {
    if (matched.has(p)) continue;
    const id = base.get(p)?.clay_field_id;
    const i = id ? byId.get(id) : undefined;
    if (i == null || i < 0) continue;
    matched.set(p, cols[i]);
    taken.add(i);
    out.renamed.push({ position: p, at: i + 1, name: nameAt(i) });
  }
  for (const p of positions) if (!matched.has(p)) out.missing.push(p);
  cols.forEach((c, i) => {
    if (taken.has(i)) return;
    (ambiguousIdx.has(i) ? out.ambiguous : out.extra).push(nameAt(i));
  });
  for (const k of ["sameplace", "moved", "renamed", "aliased"]) out[k].sort(byPosition);
  out.ambiguousAt.sort((a, b) => a - b);
  return { byPosition: matched, ...out };
}

/**
 * A copy of a definition with each field id token the map holds rewritten,
 * in every string and every object key (write-to mappings are keyed by the
 * target's field ids).
 *
 * @param {any} v
 * @param {Map<string, string>} map  the base's field id -> the client's
 * @returns {any}
 */
export function repointIds(v, map) {
  const s = (t) => (map.size ? t.replace(ID_TOKEN, (id) => map.get(id) ?? id) : t);
  if (typeof v === "string") return s(v);
  if (Array.isArray(v)) return v.map((x) => repointIds(x, map));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [s(k), repointIds(x, map)]));
  return v;
}

/**
 * @typedef {{ from_default: boolean, own: number, total: number, moved: number, renamed: number, filled: number,
 *             sameplace: Array<{ from: string, name: string }>, moved_columns: Array<{ from: string, at: number, name: string }>,
 *             renamed_columns: Array<{ from: string, at: number, name: string }>, aliased: Array<{ from: string, at: number, name: string }>,
 *             extra: string[], ambiguous: string[], ambiguous_at: string[], missing: string[] }} KindReport
 *   Names are the client's column names: the report stays outside the repo, and nothing prints them.
 * @typedef {{ variant: string, kinds: Record<string, KindReport>, unknown: Array<{ from: string, ids: number }>,
 *             invalid: string[], shared_ids: string[], credentials: string[], redacted: Record<string, number> }} MergeReport
 *   credentials: positions whose credential could not be redacted; redacted: the values redacted per kind
 */

/**
 * A client's variant from its own exports matched by name (mapByName),
 * completed from the base variant (4.1). Every position holds the client's
 * column when it has one, else the base's row there, in which each field id
 * of a position the client has, in any of the three tables, is rewritten to
 * the client's id for that position (references and write-to targets alike);
 * a filled row keeps the base's field id and sha256 and is seeded_by
 * "<who> (filled from default)". The rows are what originalRows() makes for
 * an exact layout: complete (68, 88, 76), canonical positions and keys, the
 * client's own names, unknown_refs over the merged variant.
 *
 * @param {{ companies?: { sha256: string, data: any[] } | null, people: { sha256: string, data: any[] }, inboxes: { sha256: string, data: any[] } }} exportsByKind
 *   companies absent or null: all 68 Companies positions are the base's
 * @param {Array<import("./compile-original.mjs").OriginalRow>} defaultRows  the base variant's rows, complete
 * @param {{ variant: string, seededBy?: string | null }} opts
 * @returns {{ rows: Array<import("./compile-original.mjs").OriginalRow & { seeded_by: string | null }>, report: MergeReport }}
 */
export function mergeVariant(exportsByKind, defaultRows, { variant, seededBy = null }) {
  /** @type {Map<string, any>} */
  const base = new Map();
  for (const r of defaultRows ?? []) base.set(`${r.template_kind}:${r.position}`, r);
  for (const k of ORIGINAL_KINDS) {
    for (let p = 1; p <= ORIGINAL_COUNTS[k]; p++) if (!base.has(`${k}:${p}`)) throw new Error(`The base variant has no ${fromOf(k, p)}`);
  }
  /** @type {Record<string, ReturnType<typeof mapByName> | null>} */
  const maps = {};
  for (const k of ORIGINAL_KINDS) {
    const exp = exportsByKind?.[k];
    maps[k] = exp ? mapByName(/** @type {any} */ (k), exp.data, defaultRows) : null;
  }
  /** @type {Map<string, string>} */
  const repoint = new Map();
  for (const k of ORIGINAL_KINDS) {
    for (const [p, c] of maps[k]?.byPosition ?? []) {
      const from = base.get(`${k}:${p}`).clay_field_id;
      if (typeof c?.id === "string" && c.id !== from) repoint.set(from, c.id);
    }
  }
  const filledBy = [seededBy, "(filled from default)"].filter(Boolean).join(" ");
  const rows = [];
  const invalid = [];
  /** @type {string[]} */
  const credentials = [];
  /** @type {Record<string, number>} */
  const redacted = { companies: 0, people: 0, inboxes: 0 };
  /** The definition as stored: its credentials redacted (redactCredentials). */
  const safe = (k, p, def) => {
    const r = redactCredentials(def);
    redacted[k] += r.redacted;
    if (r.refused.length) credentials.push(`${fromOf(k, p)}: a credential could not be redacted`);
    return r.column;
  };
  for (const k of ORIGINAL_KINDS) {
    for (let p = 1; p <= ORIGINAL_COUNTS[k]; p++) {
      const c = maps[k]?.byPosition.get(p);
      const b = base.get(`${k}:${p}`);
      const at = { variant, template_kind: /** @type {any} */ (k), position: p, key: ORIGINAL_KEYS[k][p] };
      if (c) {
        if (typeof c.id !== "string" || !FIELD_ID.test(c.id)) invalid.push(`${fromOf(k, p)} has no field id`);
        else if (!CLAY_TYPES.includes(c.type)) invalid.push(`${fromOf(k, p)} has an unknown type`);
        rows.push({
          ...at, name: String(c.name ?? ""), clay_field_id: c.id, clay_type: c.type,
          clay_action: c.type === "action" ? text(c.settings?.actionKey) || null : null,
          definition: safe(k, p, c), unknown_refs: [], source_sha256: exportsByKind[k].sha256, seeded_by: seededBy,
        });
      } else {
        rows.push({
          ...at, name: b.name, clay_field_id: b.clay_field_id, clay_type: b.clay_type, clay_action: b.clay_action,
          definition: safe(k, p, repointIds(b.definition, repoint)), unknown_refs: [], source_sha256: b.source_sha256, seeded_by: filledBy,
        });
      }
    }
  }
  const ids = new Set(rows.map((r) => r.clay_field_id));
  for (const r of rows) {
    const unknown = new Set();
    for (const s of strings(r.definition?.settings ?? {})) for (const m of s.matchAll(CLAY_REF)) if (!ids.has(m[1])) unknown.add(m[1]);
    r.unknown_refs = [...unknown];
  }
  // Two rows of one table with one field id would read as one column.
  const sharedIds = [];
  for (const k of ORIGINAL_KINDS) {
    /** @type {Map<string, number>} */
    const seen = new Map();
    for (const r of rows) {
      if (r.template_kind !== k) continue;
      const first = seen.get(r.clay_field_id);
      if (first != null) sharedIds.push(`${fromOf(k, first)} and ${fromOf(k, r.position)} share a field id`);
      else seen.set(r.clay_field_id, r.position);
    }
  }
  /** @type {Record<string, KindReport>} */
  const kinds = {};
  for (const k of ORIGINAL_KINDS) {
    const m = maps[k];
    const total = ORIGINAL_COUNTS[k];
    const label = (p) => fromOf(k, p);
    kinds[k] = m
      ? {
          from_default: false, own: m.byPosition.size, total, moved: m.moved.length, renamed: m.renamed.length, filled: m.missing.length,
          sameplace: m.sameplace.map((x) => ({ from: label(x.position), name: x.name })),
          moved_columns: m.moved.map((x) => ({ from: label(x.position), at: x.at, name: x.name })),
          renamed_columns: m.renamed.map((x) => ({ from: label(x.position), at: x.at, name: x.name })),
          aliased: m.aliased.map((x) => ({ from: label(x.position), at: x.at, name: x.name })),
          extra: m.extra, ambiguous: m.ambiguous, ambiguous_at: m.ambiguousAt.map(label), missing: m.missing.map(label),
        }
      : {
          from_default: true, own: 0, total, moved: 0, renamed: 0, filled: total, sameplace: [], moved_columns: [], renamed_columns: [],
          aliased: [], extra: [], ambiguous: [], ambiguous_at: [], missing: Array.from({ length: total }, (_, i) => label(i + 1)),
        };
  }
  return {
    rows,
    report: {
      variant,
      kinds,
      unknown: rows.filter((r) => r.unknown_refs.length).map((r) => ({ from: fromOf(r.template_kind, r.position), ids: r.unknown_refs.length })),
      invalid,
      shared_ids: sharedIds,
      credentials,
      redacted,
    },
  };
}

/** How many table examples a use-ai column holds, or why they can't be read. */
export function tableExampleCount(def) {
  const raw = bindingText(def, "tableExamples");
  if (raw == null) return { count: 0 };
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    return { count: null, error: "not JSON" };
  }
  return Array.isArray(list) ? { count: list.length } : { count: null, error: "not a list" };
}

/** compileTemplates() as a check: the first line of the first failure, or ok. */
function compiles(rows, settings) {
  try {
    compileTemplates(originalsMap(rows), { settings });
    return { ok: true, first_line: null };
  } catch (e) {
    return { ok: false, first_line: firstLine(e) };
  }
}

/**
 * @typedef {{ check: "variant" | "exports" | "ids" | "credentials" | "ambiguous" | "type" | "own_ai" | "compile", text: string }} Refusal
 * @typedef {{ variant: string, status: "loaded" | "refused", reasons: Refusal[], notes: string[],
 *             counts: Record<string, { from_default: boolean, own: number, total: number, moved: number, renamed: number, filled: number }>,
 *             extra: number, unknown: number, replaced: number,
 *             report: (MergeReport & { compile: { ok: boolean, first_line: string | null, companies_from_default: null | "no_export" | "did_not_compile",
 *                 retry_first_line?: string | null },
 *               tracks: { phrases: Record<string, number>, problems: string[] } | null, models: ReturnType<typeof modelDifferences>,
 *               examples: Record<string, { own: boolean, count: number | null, error?: string }> }) | null }} ByNameResult
 */

const INSERT_ORIGINALS = `
  INSERT INTO enrich_originals (variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition,
                                unknown_refs, source_sha256, seeded_by, seeded_at)
  SELECT x.variant, x.template_kind, x.position, x.key, x.name, x.clay_field_id, x.clay_type, x.clay_action, x.definition,
         coalesce(x.unknown_refs, '{}'), x.source_sha256, x.seeded_by, now()
    FROM jsonb_to_recordset($1::jsonb) AS x(variant text, template_kind text, position int, key text, name text,
         clay_field_id text, clay_type text, clay_action text, definition jsonb, unknown_refs text[], source_sha256 text,
         seeded_by text)`;

/**
 * Loads a client's own variant from its Clay exports matched by name, inside
 * the caller's transaction (the script opens one per client and rolls it back
 * for --dry). The checks, in this order (4.2); every refusal is named in the
 * result and a refused client writes nothing:
 *   1. the variant: a client's variant name, never "default" (the default
 *      stays an exact-layout load) or the base itself;
 *   2. the People and General exports present (no Companies export: all 68
 *      Companies positions are the base's), each column taken with a field id
 *      and a known type, and no two rows of a table with one field id;
 *   3. no ambiguous name at a compiled position;
 *   4. at each compiled position, the client's column of the base's type and,
 *      for an action, Clay action;
 *   5. the research and question AI columns (P#60, P#61, G#48, G#49) the
 *      client's own, never filled (D16);
 *   6. the three templates compile from it; when they don't and the Companies
 *      columns are the client's own, once more with all 68 Companies positions
 *      the base's, kept so when that compiles ("companies: from the default,
 *      its own did not compile: <first line>"); else refused with the first
 *      line of the first failure;
 *   7. the tracks and model differences, and 8. the table examples of P#61,
 *      G#49 and G#19: reported only. Tracks are never stored for a client
 *      variant, and the settings are never changed.
 *
 * @param {Db} db
 * @param {{ exports: { companies?: { sha256: string, data: any[] } | null, people?: { sha256: string, data: any[] } | null, inboxes?: { sha256: string, data: any[] } | null },
 *           variant: string, seededBy?: string | null, settings?: Array<{ key: string, value: any }> | null, base?: string }} opts
 *   settings: the enrich_settings rows the templates compile with (read here when null);
 *   base: the variant that gives the layout and fills the gaps ("default"; the tests pass their own)
 * @returns {Promise<ByNameResult>}
 */
export async function seedByName(db, { exports, variant, seededBy = null, settings = null, base = "default" }) {
  /** @type {Refusal[]} */
  const reasons = [];
  /** @type {string[]} */
  const notes = [];
  const refuse = (check, t) => reasons.push({ check, text: t });
  const done = (extra = {}) => ({ variant, status: reasons.length ? "refused" : "loaded", reasons, notes, counts: {}, extra: 0, unknown: 0, replaced: 0, report: null, ...extra });

  if (typeof variant !== "string" || !/^[a-z0-9][a-z0-9_]*$/.test(variant)) refuse("variant", `"${variant}" is not a variant name (lower case letters, digits and _)`);
  else if (variant === "default") refuse("variant", "The default variant is never loaded by name: it stays an exact-layout load (no --by-name)");
  else if (variant === base) refuse("variant", "A variant is never loaded by name over the base it is matched against");
  if (reasons.length) return done();

  for (const k of /** @type {const} */ (["people", "inboxes"])) {
    if (!Array.isArray(exports?.[k]?.data)) refuse("exports", `No ${KIND_LABEL[k]} export`);
  }
  if (exports?.companies != null && !Array.isArray(exports.companies.data)) refuse("exports", "The Companies export has no column list");
  if (reasons.length) return done();

  const baseRows = [...(await loadOriginals(db, base, { base })).values()]; // complete: an overlay is never a base
  const settingRows = settings ?? (await db.query(`SELECT key, value FROM enrich_settings`)).rows;
  const pipelineSettings = settingsFrom(settingRows);
  const own = { companies: exports.companies ?? null, people: exports.people, inboxes: exports.inboxes };
  const first = mergeVariant(own, baseRows, { variant, seededBy });
  for (const t of first.report.invalid) refuse("exports", t);
  for (const t of first.report.shared_ids) refuse("ids", t);
  for (const t of first.report.credentials) refuse("credentials", t);

  const compiled = new Set(COMPILED_POSITIONS);
  const rowAt = (rows, from) => {
    const p = /** @type {{ kind: string, position: number }} */ (parseFrom(from));
    return rows.find((r) => r.template_kind === p.kind && r.position === p.position);
  };
  for (const k of ORIGINAL_KINDS) {
    for (const from of first.report.kinds[k].ambiguous_at) if (compiled.has(from)) refuse("ambiguous", `${from}: two of the client's columns have its name`);
  }
  for (const from of COMPILED_POSITIONS) {
    if (!canonical(from)) continue; // an extension position (C#69): a variant loaded by name never holds one
    if (!isOwn(first, from)) continue; // filled: the base's own column
    const r = rowAt(first.rows, from);
    const b = rowAt(baseRows, from);
    if (r.clay_type !== b.clay_type) refuse("type", `${from}: a ${r.clay_type ?? "(no type)"} where the template needs ${b.clay_type}`);
    else if (b.clay_type === "action" && r.clay_action !== b.clay_action) refuse("type", `${from}: a ${r.clay_action ?? "(no action)"} where the template needs ${b.clay_action}`);
  }
  for (const from of OWN_AI_POSITIONS) if (!isOwn(first, from)) refuse("own_ai", `${from}: its research or question AI column is not its own`);

  // 6. Compile; the Companies columns from the base once when the client's own don't compile.
  let merged = first;
  let compile = { ...compiles(first.rows, pipelineSettings), companies_from_default: own.companies ? null : "no_export" };
  if (!own.companies) notes.push("companies: from the default");
  if (!compile.ok && own.companies) {
    const retry = mergeVariant({ ...own, companies: null }, baseRows, { variant, seededBy });
    const again = compiles(retry.rows, pipelineSettings);
    if (again.ok) {
      merged = retry;
      notes.push(`companies: from the default, its own did not compile: ${compile.first_line}`);
      compile = { ok: true, first_line: compile.first_line, companies_from_default: "did_not_compile" };
    } else {
      // Reported beside the first failure: what still fails with the base's Companies columns.
      compile = { ...compile, retry_first_line: again.first_line };
    }
  }
  if (!compile.ok) refuse("compile", String(compile.first_line));

  // 7 and 8: reported only.
  const originals = originalsMap(merged.rows);
  let tracks;
  try {
    const derived = deriveTracks(originals);
    tracks = { phrases: Object.fromEntries(TRACKS.map((t) => [t, derived[t].phrases.length])), problems: trackProblems(derived, originals) };
  } catch (e) {
    tracks = { phrases: {}, problems: [firstLine(e)] };
  }
  const models = modelDifferences(originals, settingRows);
  /** @type {Record<string, { own: boolean, count: number | null, error?: string }>} */
  const examples = {};
  for (const from of EXAMPLE_POSITIONS) examples[from] = { own: isOwn(merged, from), ...tableExampleCount(originalOf(originals, from).definition) };

  const counts = Object.fromEntries(ORIGINAL_KINDS.map((k) => {
    const x = merged.report.kinds[k];
    return [k, { from_default: x.from_default, own: x.own, total: x.total, moved: x.moved, renamed: x.renamed, filled: x.filled }];
  }));
  const report = {
    ...merged.report,
    // The client's own Companies mapping, when the Companies columns were taken from the base after all.
    ...(merged !== first ? { companies_own: first.report.kinds.companies } : {}),
    compile,
    tracks,
    models,
    examples,
  };
  let replaced = 0;
  if (!reasons.length) {
    ({ rowCount: replaced } = await db.query(`DELETE FROM enrich_originals WHERE variant = $1`, [variant]));
    await db.query(INSERT_ORIGINALS, [JSON.stringify(merged.rows)]);
  }
  return done({
    counts,
    extra: ORIGINAL_KINDS.reduce((n, k) => n + first.report.kinds[k].extra.length, 0),
    unknown: merged.report.unknown.length,
    replaced: replaced ?? 0,
    report,
  });
}

/** Is the variant's row at a position the client's own column (not filled from the base)? Never an extension position. */
function isOwn(merged, from) {
  const p = parseFrom(from);
  const k = p ? merged.report.kinds[p.kind] : null;
  return Boolean(k) && canonical(from) && !k.from_default && !k.missing.includes(from);
}

/** A canonical position (1..ORIGINAL_COUNTS of its table), not an extension one. */
function canonical(from) {
  const p = parseFrom(from);
  return Boolean(p) && p.position >= 1 && p.position <= ORIGINAL_COUNTS[p.kind];
}

// ── The default refreshed from the template client's current tables (1.5) ───

/** A variant name, as enrich_originals.variant takes it. */
const VARIANT_NAME = /^[a-z0-9][a-z0-9_]*$/;
/** What a backup of a variant's rows says it is (--refresh-default writes one, --restore-default reads it). */
export const BACKUP_KIND = "enrich_originals backup";

/** JSON with every object's keys sorted: jsonb keeps no key order. */
function sortedJson(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(",")}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(",")}}`;
}
/** Two Clay columns alike where it counts: their type and settings. */
const sameColumn = (a, b) => sortedJson({ type: a?.type ?? null, settings: a?.settings ?? null }) === sortedJson({ type: b?.type ?? null, settings: b?.settings ?? null });
/** Each track's phrase count, or null when there are no tracks. */
const phraseCounts = (tracks) =>
  tracks && typeof tracks === "object" ? Object.fromEntries(TRACKS.map((t) => [t, Array.isArray(tracks[t]?.phrases) ? tracks[t].phrases.length : 0])) : null;
const actionOf = (c) => (c?.type === "action" ? text(c.settings?.actionKey) || null : null);

const BACKUP_ROWS = `
  SELECT variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition::text AS definition, unknown_refs,
         source_sha256, seeded_by, seeded_at::text AS seeded_at
    FROM enrich_originals WHERE variant = $1 ORDER BY template_kind, position`;

/**
 * @typedef {{ check: "variant" | "exports" | "base" | "missing" | "ambiguous" | "ids" | "type" | "credentials" | "compile" | "tracks", text: string }} RefreshRefusal
 * @typedef {{ kind: string, at: string, variant: string, rows: any[], people_tracks?: { value: string, updated_by: string | null, updated_at: string } | null }} OriginalsBackup
 *   The old rows of a variant as stored (definitions and times as text, so they go back exactly), and for the default
 *   the stored people tracks (null when there were none).
 * @typedef {{ status: "loaded" | "refused", reasons: RefreshRefusal[], into: string, base: string,
 *             counts: Record<string, { total: number, canonical: number, extensions: string[], moved: number, renamed: number, aliased: number, extra: number }> | null,
 *             extensions: string[], extra: Record<string, string[]>, redacted: Record<string, number>, notes: string[],
 *             compile: { ok: boolean, first_line: string | null } | null,
 *             tracks: { before: Record<string, number> | null, after: Record<string, number> | null, problems: string[], stored: boolean } | null,
 *             models: ReturnType<typeof modelDifferences>, examples: Record<string, { count: number | null, error?: string }>,
 *             replaced: number, backup: OriginalsBackup | null, report: Record<string, any> | null }} RefreshResult
 *   extra: the names of the export's columns that are no position (report only, never printed)
 */

/**
 * The default (or, for the tests, another variant: into) made from the
 * template client's current Clay tables, matched by name against the base,
 * inside the caller's transaction. Refuses, writing nothing, at the first
 * check that fails:
 *   1. into and base are variant names; into "default" only over base "default";
 *   2. each export matched by name (mapByName withExtensions): every canonical
 *      position matched, no ambiguous name at a compiled position;
 *   3. each extension position the base does not hold yet takes the unmatched
 *      column whose name slugs to its key (two: ambiguous; none: absent);
 *      other unmatched columns are extra, listed and never stored;
 *   4. each compiled position keeps the base's type and Clay action;
 *   5. the rows: canonical and extension positions with their keys, the
 *      export's names, field ids, types and actions, definitions with their
 *      credentials redacted, no two rows of a table with one field id;
 *   6. the templates compile from them;
 *   7. the people tracks derived from them (or the ones given) pass their
 *      check; stored in enrich_settings.people_tracks for "default" only;
 *   8. models and the table example counts: reported only;
 *   9. beforeWrite(backup) with the old rows of into and the stored tracks,
 *      then the old rows replaced.
 *
 * @param {Db} db
 * @param {{ exports: { companies: { sha256: string, data: any[] }, people: { sha256: string, data: any[] }, inboxes: { sha256: string, data: any[] } },
 *           base?: string, into?: string, seededBy?: string | null, settings?: Array<{ key: string, value: any }> | null, tracks?: any,
 *           beforeWrite?: ((backup: OriginalsBackup) => unknown) | null }} opts
 *   settings: the enrich_settings rows the templates compile with (read here when null)
 * @returns {Promise<RefreshResult>}
 */
export async function refreshDefault(db, { exports, base = "default", into = "default", seededBy = null, settings = null, tracks = null, beforeWrite = null }) {
  /** @type {RefreshRefusal[]} */
  const reasons = [];
  const refuse = (check, t) => reasons.push({ check, text: t });
  /** @type {RefreshResult} */
  const out = {
    status: "refused", reasons, into, base, counts: null, extensions: [], extra: { companies: [], people: [], inboxes: [] },
    redacted: { companies: 0, people: 0, inboxes: 0 }, notes: [], compile: null, tracks: null, models: [], examples: {}, replaced: 0, backup: null, report: null,
  };
  const done = () => Object.assign(out, { status: reasons.length ? "refused" : "loaded" });

  // 1.
  for (const [what, v] of [["into", into], ["base", base]]) {
    if (typeof v !== "string" || !VARIANT_NAME.test(v)) refuse("variant", `${what}: "${v}" is not a variant name (lower case letters, digits and _)`);
  }
  if (!reasons.length && into === "default" && base !== "default") refuse("variant", "The default is refreshed over itself only (base default)");
  for (const k of ORIGINAL_KINDS) if (!Array.isArray(exports?.[k]?.data)) refuse("exports", `No ${KIND_LABEL[k]} export`);
  if (reasons.length) return done();
  /** @type {import("./compile-original.mjs").Originals} */
  let baseMap;
  try {
    baseMap = await loadOriginals(db, base, { base }); // complete: an overlay is never a base
  } catch (e) {
    if (!(e instanceof OriginalsMissing)) throw e;
    refuse("base", firstLine(e));
    return done();
  }
  const baseRows = [...baseMap.values()];

  // 2.
  const maps = Object.fromEntries(ORIGINAL_KINDS.map((k) => [k, mapByName(k, exports[k].data, baseRows, { withExtensions: true })]));
  const compiledSet = new Set(COMPILED_POSITIONS);
  for (const k of ORIGINAL_KINDS) {
    for (let p = 1; p <= ORIGINAL_COUNTS[k]; p++) if (!maps[k].byPosition.has(p)) refuse("missing", `The template client's ${KIND_LABEL[k]} table lacks ${fromOf(k, p)}`);
    for (const p of maps[k].ambiguousAt) if (compiledSet.has(fromOf(k, p))) refuse("ambiguous", `${fromOf(k, p)}: two of the template client's columns have its name`);
  }

  // 3.
  /** @type {Record<string, Map<number, any>>} */
  const placed = {};
  for (const k of ORIGINAL_KINDS) {
    const m = maps[k];
    placed[k] = new Map(m.byPosition);
    const taken = new Set(m.byPosition.values());
    const free = exports[k].data.filter((c) => !taken.has(c));
    const stored = new Set();
    for (const [pos, key] of Object.entries(ORIGINAL_EXTENSIONS[k])) {
      const p = Number(pos);
      if (placed[k].has(p)) continue; // the base holds it and the export still has it
      if (baseMap.has(`${k}:${p}`)) {
        out.notes.push(`${fromOf(k, p)}: held by the base, no longer in the export`);
        continue;
      }
      const hits = free.filter((c) => slugKey(c?.name ?? "") === key);
      if (hits.length > 1) refuse("ambiguous", `${fromOf(k, p)}: two of the template client's columns have its name`);
      else if (hits.length === 1) {
        placed[k].set(p, hits[0]);
        stored.add(hits[0]);
      }
    }
    out.extra[k] = free.filter((c) => !stored.has(c)).map((c) => String(c?.name ?? ""));
  }

  // 4.
  for (const from of COMPILED_POSITIONS) {
    const p = /** @type {{ kind: "companies" | "people" | "inboxes", position: number }} */ (parseFrom(from));
    const c = placed[p.kind].get(p.position);
    const b = baseMap.get(`${p.kind}:${p.position}`);
    if (!c || !b) continue; // missing (refused above), or an extension the base does not hold yet
    if (c.type !== b.clay_type) refuse("type", `${from}: a ${c.type ?? "(no type)"} where the template needs ${b.clay_type}`);
    else if (b.clay_type === "action" && actionOf(c) !== b.clay_action) refuse("type", `${from}: a ${actionOf(c) ?? "(no action)"} where the template needs ${b.clay_action}`);
  }

  // 5.
  const by = [seededBy, "(refreshed from the template client's current tables)"].filter(Boolean).join(" ");
  const rows = [];
  for (const k of ORIGINAL_KINDS) {
    const keys = keysOf(k);
    for (const p of [...placed[k].keys()].sort((a, b) => a - b)) {
      const c = placed[k].get(p);
      const from = fromOf(k, p);
      if (typeof c?.id !== "string" || !FIELD_ID.test(c.id)) {
        refuse("exports", `${from} has no field id`);
        continue;
      }
      if (!CLAY_TYPES.includes(c.type)) {
        refuse("exports", `${from} has an unknown type`);
        continue;
      }
      const safe = redactCredentials(c);
      out.redacted[k] += safe.redacted;
      if (safe.refused.length) refuse("credentials", `${from}: a credential could not be redacted`);
      if (p > ORIGINAL_COUNTS[k]) out.extensions.push(from);
      rows.push({
        variant: into, template_kind: /** @type {any} */ (k), position: p, key: keys[p], name: String(c.name ?? ""), clay_field_id: c.id,
        clay_type: c.type, clay_action: actionOf(c), definition: safe.column, unknown_refs: [], source_sha256: exports[k].sha256, seeded_by: by,
      });
    }
  }
  const ids = new Set(rows.map((r) => r.clay_field_id));
  for (const r of rows) {
    const unknown = new Set();
    for (const s of strings(r.definition?.settings ?? {})) for (const m of s.matchAll(CLAY_REF)) if (!ids.has(m[1])) unknown.add(m[1]);
    r.unknown_refs = [...unknown];
  }
  for (const k of ORIGINAL_KINDS) {
    /** @type {Map<string, number>} */
    const seen = new Map();
    for (const r of rows) {
      if (r.template_kind !== k) continue;
      const first = seen.get(r.clay_field_id);
      if (first != null) refuse("ids", `${fromOf(k, first)} and ${fromOf(k, r.position)} share a field id`);
      else seen.set(r.clay_field_id, r.position);
    }
  }
  out.counts = Object.fromEntries(ORIGINAL_KINDS.map((k) => [k, {
    total: rows.filter((r) => r.template_kind === k).length, canonical: ORIGINAL_COUNTS[k],
    extensions: out.extensions.filter((f) => parseFrom(f)?.kind === k), moved: maps[k].moved.length, renamed: maps[k].renamed.length,
    aliased: maps[k].aliased.length, extra: out.extra[k].length,
  }]));
  out.report = Object.fromEntries(ORIGINAL_KINDS.map((k) => [k, {
    moved_columns: maps[k].moved.map((x) => ({ from: fromOf(k, x.position), at: x.at, name: x.name })),
    renamed_columns: maps[k].renamed.map((x) => ({ from: fromOf(k, x.position), at: x.at, name: x.name })),
    aliased: maps[k].aliased.map((x) => ({ from: fromOf(k, x.position), at: x.at, name: x.name })),
    ambiguous: maps[k].ambiguous, extra: out.extra[k],
  }]));

  // 6.
  const settingRows = settings ?? (await db.query(`SELECT key, value FROM enrich_settings`)).rows;
  out.compile = compiles(rows, settingsFrom(settingRows));
  if (!out.compile.ok) refuse("compile", String(out.compile.first_line));

  // 7. and 8.
  const originals = originalsMap(rows);
  const storedTracks = settingRows.find((r) => r.key === "people_tracks")?.value ?? null;
  let chosen = null;
  /** @type {string[]} */
  let problems = [];
  try {
    chosen = tracks ?? deriveTracks(originals);
    problems = trackProblems(chosen, originals);
  } catch (e) {
    problems = [firstLine(e)];
  }
  if (problems.length) refuse("tracks", problems.length > 1 ? `${problems[0]} (and ${problems.length - 1} more)` : problems[0]);
  out.tracks = { before: phraseCounts(storedTracks), after: problems.length ? null : phraseCounts(chosen), problems, stored: false };
  try {
    out.models = modelDifferences(originals, settingRows);
  } catch {
    out.models = [];
  }
  for (const from of EXAMPLE_POSITIONS) {
    try {
      out.examples[from] = tableExampleCount(originalOf(originals, from).definition);
    } catch (e) {
      out.examples[from] = { count: null, error: firstLine(e) };
    }
  }
  if (reasons.length) return done();

  // 9.
  const old = (await db.query(BACKUP_ROWS, [into])).rows;
  /** @type {OriginalsBackup} */
  const backup = { kind: BACKUP_KIND, at: new Date().toISOString(), variant: into, rows: old };
  if (into === "default") {
    const { rows: t } = await db.query(`SELECT value::text AS value, updated_by, updated_at::text AS updated_at FROM enrich_settings WHERE key = 'people_tracks'`);
    backup.people_tracks = t[0] ? { value: t[0].value, updated_by: t[0].updated_by ?? null, updated_at: t[0].updated_at } : null;
  }
  out.backup = backup;
  if (beforeWrite) await beforeWrite(backup);
  const { rowCount: replaced } = await db.query(`DELETE FROM enrich_originals WHERE variant = $1`, [into]);
  await db.query(INSERT_ORIGINALS, [JSON.stringify(rows)]);
  out.replaced = replaced ?? 0;
  if (into === "default") {
    await db.query(
      `INSERT INTO enrich_settings (key, value, updated_at) VALUES ('people_tracks', $1::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        WHERE enrich_settings.value IS DISTINCT FROM EXCLUDED.value`,
      [JSON.stringify(chosen)]
    );
    out.tracks.stored = true;
  }
  return done();
}

const RESTORE_ORIGINALS = `
  INSERT INTO enrich_originals (variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition,
                                unknown_refs, source_sha256, seeded_by, seeded_at)
  SELECT x.variant, x.template_kind, x.position, x.key, x.name, x.clay_field_id, x.clay_type, x.clay_action, x.definition::jsonb,
         coalesce(x.unknown_refs, '{}'), x.source_sha256, x.seeded_by, x.seeded_at::timestamptz
    FROM jsonb_to_recordset($1::jsonb) AS x(variant text, template_kind text, position int, key text, name text,
         clay_field_id text, clay_type text, clay_action text, definition text, unknown_refs text[], source_sha256 text,
         seeded_by text, seeded_at text)`;

/**
 * Puts a variant back exactly as a backup holds it (refreshDefault's), inside
 * the caller's transaction: its rows, and for "default" the stored people
 * tracks (the row removed when there was none).
 *
 * @param {Db} db
 * @param {OriginalsBackup} backup
 * @returns {Promise<{ variant: string, rows: number, replaced: number, tracks: "restored" | "removed" | "not touched" }>}
 */
export async function restoreBackup(db, backup) {
  if (!backup || backup.kind !== BACKUP_KIND || typeof backup.variant !== "string" || !VARIANT_NAME.test(backup.variant) || !Array.isArray(backup.rows)) {
    throw new Error("Not a backup of the originals (--refresh-default writes them)");
  }
  if (backup.rows.some((r) => r?.variant !== backup.variant || typeof r?.definition !== "string")) throw new Error("The backup's rows are not all of its variant, as stored");
  const { rowCount: replaced } = await db.query(`DELETE FROM enrich_originals WHERE variant = $1`, [backup.variant]);
  if (backup.rows.length) await db.query(RESTORE_ORIGINALS, [JSON.stringify(backup.rows)]);
  /** @type {"restored" | "removed" | "not touched"} */
  let tracks = "not touched";
  if (backup.variant === "default" && Object.hasOwn(backup, "people_tracks")) {
    // Deleted and inserted, so its updated_at goes back as it was (an update would set it to now).
    await db.query(`DELETE FROM enrich_settings WHERE key = 'people_tracks'`);
    const t = backup.people_tracks;
    if (t) {
      await db.query(`INSERT INTO enrich_settings (key, value, updated_by, updated_at) VALUES ('people_tracks', $1::jsonb, $2::uuid, $3::timestamptz)`, [t.value, t.updated_by ?? null, t.updated_at]);
      tracks = "restored";
    } else tracks = "removed";
  }
  return { variant: backup.variant, rows: backup.rows.length, replaced: replaced ?? 0, tracks };
}

// ── A client's own personalisation, as an overlay on the default (1.6) ──────

/**
 * @typedef {{ check: "no_steps" | "type" | "unmapped_column" | "credentials" | "compile" | "examples", from: string | null, text: string }} OverlayCheck
 * @typedef {{ status: "own" | "base" | "same" | "not_read", checks: OverlayCheck[], filled: string[], aliased: string[], renamed: string[], unread: string[] }} KindResult
 *   own: the client's personalisation rows are stored; base: the client runs the default's (the checks say why);
 *   same: its columns are the default's, nothing stored; not_read: no export of the table;
 *   unread: the positions whose prompt stopped reading a company link column (UNREAD_LINK_COLUMNS)
 */

const PERSONAL_KINDS = Object.freeze(["people", "inboxes"]);
/** A column's type in words: its Clay action, or its type. */
const typeWords = (type, action) => (type === "action" ? action ?? "(no action)" : type ?? "(no type)");

/**
 * The client columns a personalisation prompt no longer reads (the owner's
 * rule, 2026-11-24: the research step needs the website, city, state, company
 * name and categories, not the company's LinkedIn or Facebook link). The
 * template client's tables have no such columns, so a prompt reading them used
 * to put the whole kind on the default's steps (unmapped_column). Names as
 * Clay shows them, matched whatever their case and spacing.
 */
export const UNREAD_LINK_COLUMNS = Object.freeze(["company linkedin link", "company facebook link", "company linkedin url", "company facebook url"]);
const columnName = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
/** A reference as a prompt reads it: {{f_id}}, or the same inside Clay.formatForAIPrompt(...). */
const PROMPT_REF = String.raw`(?:Clay\.formatForAIPrompt\(\s*\{\{\s*(f_[A-Za-z0-9_]+)\s*\}\}\s*\)|\{\{\s*(f_[A-Za-z0-9_]+)\s*\}\})`;
/** ` and the LinkedIn page at " + <ref> + "`: the clause the clients' research prompts read a link with. */
const LINK_CLAUSE = new RegExp(String.raw` ?and the (?:LinkedIn|Facebook) page at "\s*\+\s*` + PROMPT_REF + String.raw`\s*\+\s*"`, "g");
const ANY_REF = new RegExp(PROMPT_REF, "g");

/**
 * A prompt expression that no longer reads the given columns: each clause
 * ` and the LinkedIn page at " + {{f_x}} + "` (or Facebook) leaves the
 * expression, so "…at " + {{web}} + " of the company " + … is what remains,
 * and any other read of them becomes "" (an empty value, as an empty cell
 * reads in a prompt).
 *
 * @param {string} expr
 * @param {Set<string>} ids  the columns' field ids
 * @returns {{ text: string, dropped: number, blanked: number }}
 */
export function withoutLinkReads(expr, ids) {
  let dropped = 0;
  let blanked = 0;
  const own = (a, b) => ids.has(a ?? b);
  const text = String(expr ?? "")
    .replace(LINK_CLAUSE, (whole, a, b) => (own(a, b) ? (dropped++, "") : whole))
    .replace(ANY_REF, (whole, a, b) => (own(a, b) ? (blanked++, '""') : whole));
  return { text, dropped, blanked };
}

/**
 * A column with its prompt (the "prompt" input) no longer reading the given
 * columns. Only the prompt changes: a run condition, an example or any other
 * setting that reads them still counts as unmapped.
 *
 * @param {any} column
 * @param {Set<string>} ids
 * @returns {{ column: any, dropped: number, blanked: number }}
 */
function promptWithoutLinks(column, ids) {
  const bindings = column?.settings?.inputsBinding;
  if (!ids.size || !Array.isArray(bindings)) return { column, dropped: 0, blanked: 0 };
  let dropped = 0;
  let blanked = 0;
  const next = bindings.map((b) => {
    if (b?.name !== "prompt" || typeof b.formulaText !== "string") return b;
    const out = withoutLinkReads(b.formulaText, ids);
    dropped += out.dropped;
    blanked += out.blanked;
    return out.dropped || out.blanked ? { ...b, formulaText: out.text } : b;
  });
  return dropped || blanked ? { column: { ...column, settings: { ...column.settings, inputsBinding: next } }, dropped, blanked } : { column, dropped, blanked };
}

/**
 * A client's personalisation columns (OVERLAY_POSITIONS: P#57 to P#62,
 * G#45 to G#50) as an overlay on the base, People and General decided apart:
 *   1. no export of the table: not_read;
 *   2. the client's tables matched by name (mapByName withExtensions); each
 *      field id the client's columns were matched by is re-pointed to the
 *      base's id at that position (its own table first);
 *   3. the research and question steps (OVERLAY_AI_POSITIONS) not both the
 *      client's own: the default's, check no_steps;
 *   4. each overlay position: the client's column, or the base's row (filled);
 *   5. another type or Clay action than the base's there: check type;
 *   6. the definition re-pointed (repointIds: references, the table examples'
 *      keys, its own id) and its credentials redacted; its prompt no longer
 *      reads the company link columns (UNREAD_LINK_COLUMNS: the clause that
 *      names one leaves, any other read is ""); a reference left to a column
 *      the base does not have: check unmapped_column;
 *   7. the rows keep the base's field ids and keys, the client's names;
 *   8. every row alike the base's (type and settings): same, nothing stored;
 *   9. the templates compile from the base with the kind's rows (both kinds
 *      together, else each alone; check compile) and the question step's
 *      table examples read (check examples).
 * A kind on the default's (status "base") stores nothing: the client runs the
 * default's steps there, under shared_text_ok only (config.text_variant).
 *
 * @param {{ companies?: { sha256: string, data: any[] } | null, people?: { sha256: string, data: any[] } | null, inboxes?: { sha256: string, data: any[] } | null }} exportsByKind
 *   companies: optional, never needed (only to re-point and to name a column read)
 * @param {Array<import("./compile-original.mjs").OriginalRow>} baseRows  the base variant's rows, complete
 * @param {{ variant: string, seededBy?: string | null, settings?: Array<{ key: string, value: any }> | null }} opts
 *   settings: the enrich_settings rows the templates compile with (the defaults when null)
 * @returns {{ rows: Array<import("./compile-original.mjs").OriginalRow & { seeded_by: string | null }>,
 *   kinds: { people: KindResult, inboxes: KindResult }, report: Record<string, any> }}
 */
export function personalisationOverlay(exportsByKind, baseRows, { variant, seededBy = null, settings = null }) {
  /** @type {Map<string, any>} */
  const base = new Map((baseRows ?? []).map((r) => [`${r.template_kind}:${r.position}`, r]));
  const baseIds = new Set((baseRows ?? []).map((r) => r.clay_field_id));
  const pipelineSettings = settingsFrom(Array.isArray(settings) ? settings : []);
  const read = Object.fromEntries(ORIGINAL_KINDS.map((k) => [k, Array.isArray(exportsByKind?.[k]?.data) ? exportsByKind[k] : null]));
  const maps = Object.fromEntries(ORIGINAL_KINDS.map((k) => [k, read[k] ? mapByName(/** @type {any} */ (k), read[k].data, baseRows, { withExtensions: true }) : null]));
  /** A client column's words for a check: its name and table, or the id alone when its table was not read. */
  const columnOf = (id) => {
    for (const k of ORIGINAL_KINDS) {
      const c = read[k]?.data.find((x) => x?.id === id);
      if (c) return `${String(c.name ?? "")} (${KIND_LABEL[k]})`;
    }
    return id;
  };
  /** The client's company link columns the base has no column for (their ids, in any of its tables). */
  const linkIds = new Set(
    ORIGINAL_KINDS.flatMap((k) => (read[k]?.data ?? []).filter((x) => UNREAD_LINK_COLUMNS.includes(columnName(x?.name)) && typeof x?.id === "string" && !baseIds.has(x.id)).map((x) => x.id))
  );
  const ownBy = [seededBy, "(personalisation)"].filter(Boolean).join(" ");
  const filledBy = [seededBy, "(personalisation, filled from default)"].filter(Boolean).join(" ");
  /** @type {Record<string, KindResult>} */
  const kinds = {};
  /** @type {Record<string, any[]>} */
  const kindRows = { people: [], inboxes: [] };
  /** @type {Record<string, any>} */
  const report = { variant, kinds: {}, compile: {}, examples: {} };

  for (const k of PERSONAL_KINDS) {
    const m = maps[k];
    if (!m) {
      kinds[k] = { status: "not_read", checks: [], filled: [], aliased: [], renamed: [], unread: [] };
      report.kinds[k] = { ...kinds[k], redacted: 0, columns: [] };
      continue;
    }
    // 2. The client's field ids matched to a position, re-pointed to the base's ids there (its own table first).
    /** @type {Map<string, string>} */
    const toBase = new Map();
    for (const kk of [k, ...ORIGINAL_KINDS.filter((x) => x !== k)]) {
      for (const [p, c] of maps[kk]?.byPosition ?? []) {
        const b = base.get(`${kk}:${p}`);
        if (b && typeof c?.id === "string" && !toBase.has(c.id)) toBase.set(c.id, b.clay_field_id);
      }
    }
    const inOverlay = (x) => OVERLAY_POSITIONS[k].includes(x.position);
    /** @type {KindResult} */
    const res = {
      status: "own", checks: [], filled: [], aliased: m.aliased.filter(inOverlay).map((x) => fromOf(k, x.position)),
      renamed: m.renamed.filter(inOverlay).map((x) => fromOf(k, x.position)), unread: [],
    };
    const onBase = (check, from, t) => {
      res.status = "base";
      res.checks.push({ check, from, text: t });
    };
    // 3.
    for (const p of OVERLAY_AI_POSITIONS[k]) {
      if (!m.byPosition.has(p) || m.ambiguousAt.includes(p)) onBase("no_steps", fromOf(k, p), `${fromOf(k, p)}: no research or question step of its own`);
    }
    let redacted = 0;
    const columns = [];
    const rows = [];
    for (const p of OVERLAY_POSITIONS[k]) {
      const from = fromOf(k, p);
      const b = base.get(`${k}:${p}`);
      if (!b) throw new Error(`The base variant has no ${from}`);
      const c = m.byPosition.get(p);
      // 4.
      if (!c) {
        res.filled.push(from);
        rows.push({
          variant, template_kind: k, position: p, key: b.key, name: b.name, clay_field_id: b.clay_field_id, clay_type: b.clay_type,
          clay_action: b.clay_action, definition: redactCredentials(b.definition).column, unknown_refs: [], source_sha256: b.source_sha256, seeded_by: filledBy,
        });
        continue;
      }
      columns.push({ from, name: String(c.name ?? ""), at: read[k].data.indexOf(c) + 1 });
      // 5.
      if (c.type !== b.clay_type || (b.clay_type === "action" && actionOf(c) !== b.clay_action)) {
        onBase("type", from, `${from}: a ${typeWords(c.type, actionOf(c))} where the default's is ${typeWords(b.clay_type, b.clay_action)}`);
        continue;
      }
      // 6.
      const safe = redactCredentials(repointIds(c, toBase));
      redacted += safe.redacted;
      if (safe.refused.length) onBase("credentials", from, `${from}: a credential could not be redacted`);
      const linkless = promptWithoutLinks(safe.column, linkIds);
      if (linkless.dropped || linkless.blanked) res.unread.push(from);
      safe.column = linkless.column;
      const left = [...new Set(strings(safe.column?.settings ?? {}).flatMap((s) => [...s.matchAll(CLAY_REF)].map((x) => x[1])))].filter((id) => !baseIds.has(id));
      for (const id of left) onBase("unmapped_column", from, `${from} reads ${columnOf(id)}, which the default's tables do not have`);
      // 7.
      rows.push({
        variant, template_kind: k, position: p, key: ORIGINAL_KEYS[k][p], name: String(c.name ?? ""), clay_field_id: b.clay_field_id, clay_type: c.type,
        clay_action: actionOf(c), definition: safe.column, unknown_refs: [], source_sha256: read[k].sha256, seeded_by: ownBy,
      });
    }
    // 8.
    if (res.status === "own" && rows.every((r) => sameColumn(r.definition, base.get(`${k}:${r.position}`).definition))) res.status = "same";
    kinds[k] = res;
    kindRows[k] = rows;
    report.kinds[k] = { ...res, redacted, columns };
  }

  // 9. The templates compile with the kinds' rows, and the question steps' examples read.
  /** The base with these kinds' rows in their places, as loadOriginals composes an overlay. */
  const compose = (ks) => {
    /** @type {Map<string, any>} */
    const map = new Map([...base].map(([key, r]) => [key, { ...r, text_variant: "default" }]));
    for (const k of ks) for (const r of kindRows[k]) map.set(`${k}:${r.position}`, r);
    return map;
  };
  const compileOf = (ks) => {
    try {
      compileTemplates(compose(ks), { settings: pipelineSettings });
      return null;
    } catch (e) {
      return firstLine(e);
    }
  };
  const own = () => PERSONAL_KINDS.filter((k) => kinds[k].status === "own");
  const failCompile = (k, line) => {
    kinds[k].status = "base";
    kinds[k].checks.push({ check: "compile", from: null, text: line });
  };
  const first = own();
  if (first.length) {
    const together = compileOf(first);
    report.compile.together = together;
    if (together != null) {
      // Each kind alone (the list taken before any is set aside, so the second is compiled on its own too).
      for (const k of first) {
        const alone = first.length > 1 ? compileOf([k]) : together;
        report.compile[k] = alone;
        if (alone != null) failCompile(k, alone);
      }
      const rest = own();
      const still = rest.length > 1 ? compileOf(rest) : null;
      if (still != null) for (const k of rest) failCompile(k, still);
    }
  }
  for (const k of own()) {
    const at = OVERLAY_AI_POSITIONS[k][1];
    const composed = compose([k]);
    const def = composed.get(`${k}:${at}`)?.definition ?? null;
    const ex = examplesFor(def, composed, k, Object.keys(answerFields(def))[0]);
    report.examples[fromOf(k, at)] = "error" in ex ? { error: ex.error } : { count: ex.count };
    if ("error" in ex) {
      kinds[k].status = "base";
      kinds[k].checks.push({ check: "examples", from: fromOf(k, at), text: `${fromOf(k, at)}: its table examples could not be read (${ex.error})` });
    }
  }
  for (const k of PERSONAL_KINDS) if (report.kinds[k]) Object.assign(report.kinds[k], { status: kinds[k].status, checks: kinds[k].checks });
  const rows = PERSONAL_KINDS.flatMap((k) => (kinds[k].status === "own" ? kindRows[k] : []));
  return { rows, kinds: /** @type {{ people: KindResult, inboxes: KindResult }} */ (kinds), report };
}

/**
 * A client's personalisation stored as its variant, an overlay on the base,
 * inside the caller's transaction (the script opens one per client, or a
 * savepoint per client in a dry run). Refused (nothing read or written) for
 * a name that is no variant, "default" or the base itself; not_read (nothing
 * written) when neither People nor General was read. Otherwise the client's
 * earlier rows (an overlay, or a complete variant loaded by name) are
 * replaced by the rows of its own kinds, and by none when no kind is its own,
 * so it compiles from the default.
 *
 * @param {Db} db
 * @param {{ exports: { companies?: { sha256: string, data: any[] } | null, people?: { sha256: string, data: any[] } | null, inboxes?: { sha256: string, data: any[] } | null },
 *           variant: string, seededBy?: string | null, settings?: Array<{ key: string, value: any }> | null, base?: string }} opts
 * @returns {Promise<{ status: "loaded" | "refused" | "not_read", variant: string, kinds: { people: KindResult, inboxes: KindResult } | null,
 *   stored: number, replaced: number, report: Record<string, any> | null, reasons: Array<{ check: string, text: string }> }>}
 */
export async function seedPersonalisation(db, { exports, variant, seededBy = null, settings = null, base = "default" }) {
  const refused = (t) => ({ status: /** @type {const} */ ("refused"), variant, kinds: null, stored: 0, replaced: 0, report: null, reasons: [{ check: "variant", text: t }] });
  if (typeof variant !== "string" || !VARIANT_NAME.test(variant)) return refused(`"${variant}" is not a variant name (lower case letters, digits and _)`);
  if (variant === "default") return refused("The default variant is never a client's personalisation");
  if (variant === base) return refused("A client's personalisation is never stored over the base it is composed with");
  const people = Array.isArray(exports?.people?.data) ? exports.people : null;
  const inboxes = Array.isArray(exports?.inboxes?.data) ? exports.inboxes : null;
  if (!people && !inboxes) {
    const none = () => ({ status: /** @type {const} */ ("not_read"), checks: [], filled: [], aliased: [], renamed: [], unread: [] });
    return { status: "not_read", variant, kinds: { people: none(), inboxes: none() }, stored: 0, replaced: 0, report: null, reasons: [] };
  }
  const baseRows = [...(await loadOriginals(db, base, { base })).values()]; // complete, else OriginalsMissing
  const settingRows = settings ?? (await db.query(`SELECT key, value FROM enrich_settings`)).rows;
  const companies = Array.isArray(exports?.companies?.data) ? exports.companies : null;
  const out = personalisationOverlay({ companies, people, inboxes }, baseRows, { variant, seededBy, settings: settingRows });
  const { rowCount: replaced } = await db.query(`DELETE FROM enrich_originals WHERE variant = $1`, [variant]);
  if (out.rows.length) await db.query(INSERT_ORIGINALS, [JSON.stringify(out.rows)]);
  return { status: "loaded", variant, kinds: out.kinds, stored: out.rows.length, replaced: replaced ?? 0, report: out.report, reasons: [] };
}
