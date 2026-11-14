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

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { CLAY_REF, bindingText, fromOf, originalOf } from "./compile-original.mjs";
import { evaluate, makeContext } from "./formula.mjs";
import { nameFits, ORIGINAL_COUNTS, ORIGINAL_KEYS, ORIGINAL_KINDS } from "./original-keys.mjs";
import { settingsFrom, TRACKS } from "./settings.mjs";

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
