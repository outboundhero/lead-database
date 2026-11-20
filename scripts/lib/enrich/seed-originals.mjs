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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CLAY_REF, bindingText, fromOf, loadOriginals, originalOf, parseFrom } from "./compile-original.mjs";
import { evaluate, makeContext } from "./formula.mjs";
import { NAME_ALIASES, nameFits, ORIGINAL_COUNTS, ORIGINAL_KEYS, ORIGINAL_KINDS, slugKey } from "./original-keys.mjs";
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

/**
 * The enrich_originals rows of three exports, one variant, with each column's
 * unknown references.
 *
 * @param {{ companies: { sha256: string, data: any[] }, people: { sha256: string, data: any[] }, inboxes: { sha256: string, data: any[] } }} exports
 * @param {{ variant?: string, seededBy?: string | null }} [opts]
 * @returns {Array<import("./compile-original.mjs").OriginalRow & { seeded_by: string | null }>}
 */
export function originalRows(exports, { variant = "default", seededBy = null } = {}) {
  const ids = new Set();
  for (const kind of ORIGINAL_KINDS) for (const c of exports[kind].data) ids.add(c.id);
  const rows = [];
  for (const kind of ORIGINAL_KINDS) {
    exports[kind].data.forEach((c, i) => {
      const unknown = new Set();
      for (const s of strings(c.settings ?? {})) for (const m of s.matchAll(CLAY_REF)) if (!ids.has(m[1])) unknown.add(m[1]);
      rows.push({
        variant,
        template_kind: /** @type {any} */ (kind),
        position: i + 1,
        key: ORIGINAL_KEYS[kind][i + 1],
        name: c.name,
        clay_field_id: c.id,
        clay_type: c.type,
        clay_action: c.type === "action" ? text(c.settings?.actionKey) || null : null,
        definition: c,
        unknown_refs: [...unknown],
        source_sha256: exports[kind].sha256,
        seeded_by: seededBy,
      });
    });
  }
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
 * @param {"companies" | "people" | "inboxes"} kind
 * @param {any[]} data  the export's columns, as the Clay CLI lists them
 * @param {Array<{ template_kind: string, position: number, name: string, clay_field_id: string }>} defaultRows  the base variant's rows (any kinds)
 * @param {{ aliases?: Record<string, string> }} [opts]
 * @returns {{ byPosition: Map<number, any>, sameplace: Array<{ position: number, name: string }>,
 *   moved: Array<{ position: number, at: number, name: string }>, renamed: Array<{ position: number, at: number, name: string }>,
 *   aliased: Array<{ position: number, at: number, name: string }>, extra: string[], ambiguous: string[], ambiguousAt: number[],
 *   missing: number[] }}
 *   at: the column's own position in the export; ambiguousAt: positions whose name two client columns gave
 */
export function mapByName(kind, data, defaultRows, { aliases = NAME_ALIASES[kind] } = {}) {
  const total = ORIGINAL_COUNTS[kind];
  /** @type {Map<number, any>} */
  const base = new Map();
  for (const r of defaultRows ?? []) if (r?.template_kind === kind) base.set(r.position, r);
  /** @type {Map<string, number>} */
  const canon = new Map();
  const shared = new Set();
  for (let p = 1; p <= total; p++) {
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
  for (let p = 1; p <= total; p++) {
    if (matched.has(p)) continue;
    const id = base.get(p)?.clay_field_id;
    const i = id ? byId.get(id) : undefined;
    if (i == null || i < 0) continue;
    matched.set(p, cols[i]);
    taken.add(i);
    out.renamed.push({ position: p, at: i + 1, name: nameAt(i) });
  }
  for (let p = 1; p <= total; p++) if (!matched.has(p)) out.missing.push(p);
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
 *             invalid: string[], shared_ids: string[] }} MergeReport
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
          definition: c, unknown_refs: [], source_sha256: exportsByKind[k].sha256, seeded_by: seededBy,
        });
      } else {
        rows.push({
          ...at, name: b.name, clay_field_id: b.clay_field_id, clay_type: b.clay_type, clay_action: b.clay_action,
          definition: repointIds(b.definition, repoint), unknown_refs: [], source_sha256: b.source_sha256, seeded_by: filledBy,
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
 * @typedef {{ check: "variant" | "exports" | "ids" | "ambiguous" | "type" | "own_ai" | "compile", text: string }} Refusal
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

  const baseRows = [...(await loadOriginals(db, base)).values()];
  const settingRows = settings ?? (await db.query(`SELECT key, value FROM enrich_settings`)).rows;
  const pipelineSettings = settingsFrom(settingRows);
  const own = { companies: exports.companies ?? null, people: exports.people, inboxes: exports.inboxes };
  const first = mergeVariant(own, baseRows, { variant, seededBy });
  for (const t of first.report.invalid) refuse("exports", t);
  for (const t of first.report.shared_ids) refuse("ids", t);

  const compiled = new Set(COMPILED_POSITIONS);
  const rowAt = (rows, from) => {
    const p = /** @type {{ kind: string, position: number }} */ (parseFrom(from));
    return rows.find((r) => r.template_kind === p.kind && r.position === p.position);
  };
  for (const k of ORIGINAL_KINDS) {
    for (const from of first.report.kinds[k].ambiguous_at) if (compiled.has(from)) refuse("ambiguous", `${from}: two of the client's columns have its name`);
  }
  for (const from of COMPILED_POSITIONS) {
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

/** Is the variant's row at a position the client's own column (not filled from the base)? */
function isOwn(merged, from) {
  const p = parseFrom(from);
  const k = p ? merged.report.kinds[p.kind] : null;
  return Boolean(k) && !k.from_default && !k.missing.includes(from);
}
