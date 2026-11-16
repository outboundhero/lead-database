// The LinkedIn seed (D-P4-4, D-P4-5): each client's places and excluded
// keywords from its newest Clay search of each kind, and the shared starter
// keyword list, read from the normalized Clay copy (normalized.json, version
// 3, with its seed_picks block) kept OUTSIDE this public repo. Driven by
// scripts/linkedin-seed.mjs; a dry run unless --apply.
//
// The file is the only way client data reaches the database here: this code
// holds none, and the tests use made-up files.
//
// Per database client and kind, the file's seed_picks block names the search
// to copy (the newest configured search Clay ran, by set-up date, across the
// client's Clay tags and campaigns; picked outside the repo) with its raw
// place and keyword lists. The seed:
//   1. converts the places into client_targeting's format against the geo
//      reference of the database it writes to (convertPick); what can't be
//      placed goes to the row's unplaced list with why and suggestions;
//   2. gives a client with one kind only the other kind's lists (copied_from);
//   3. treats a people search Clay limited to a list of companies as a search
//      of its own places (flag company_list);
//   4. writes the starter list once, then one row per client and kind
//      (seedLinkedinRow): never over a person's save, nothing when unchanged,
//      each write logged with the file's sha256;
//   5. never touches client_targeting, the linkedin_sources switch or its list.
//
// Plain JavaScript: the seed script and the tests share it.

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { LINKEDIN_FLAGS, LINKEDIN_KINDS, seedLinkedinRow, writeStarter } from "./linkedin-settings.mjs";
import { normTag } from "../enrich/settings.mjs";

/** The normalized.json layout this seed reads: version 3, with seed_picks. */
export const SEED_FILE_VERSION = 3;
export const SEED_PICKS_VERSION = 1;
export const STARTER_LIST = "keywords_exclude.starter";
/** Clay's place fields a pick carries (normalized.json's field names). */
export const PLACE_FIELDS = Object.freeze(["countries", "states", "states_exclude", "cities", "cities_exclude", "free_text_places", "free_text_places_exclude"]);

/**
 * One Clay search the seed copies.
 * @typedef {{
 *   source_id: string, clay_tag: string, campaign: string | null, set_up_at: string, status: string, records: number | null,
 *   fingerprint: string | null, company_list: { size: number } | null, raw_location: boolean, include_style: string[],
 *   places: Record<(typeof PLACE_FIELDS)[number], string[]>, keywords_exclude: string[],
 * }} SeedPick
 *   set_up_at: the Clay source's updatedAt (else createdAt), ISO; company_list: Clay looked only inside a list of
 *   companies (its size); include_style: Clay include fields the search set (industries_include, keywords_include,
 *   seniority, ...), which are not carried over
 * @typedef {{ people: SeedPick | null, companies: SeedPick | null, flags?: string[], notes?: string[],
 *   campaigns_not_seeded?: Array<{ kind: string, campaign: string | null, clay_tag: string, source_id: string, set_up_at: string,
 *                                  status: string, records: number | null }> }} SeedClient
 * @typedef {{ path: string, sha256: string, starter: { items: string[], version: number, source: string },
 *   clients: Array<[string, SeedClient]> }} SeedFile
 */

export class SeedLayoutError extends Error {
  constructor(errors) {
    super(`The seed file's layout is not the one this seed reads (normalized.json version ${SEED_FILE_VERSION} with seed_picks):\n  ${errors.slice(0, 20).join("\n  ")}${errors.length > 20 ? `\n  ... and ${errors.length - 20} more` : ""}`);
    this.name = "SeedLayoutError";
    this.errors = errors;
  }
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
/** A part Builder L1 has not built yet: it throws, so nothing half-built runs. The arguments are the final ones. */
function todo(name) {
  throw new Error(`TODO(L1): ${name} is not built yet`);
}
const isTexts = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Every way the file differs from the layout this seed reads (empty: it fits).
 * Names paths and tags only, never a value.
 *
 * @param {unknown} json
 * @returns {string[]}
 */
export function checkSeedLayout(json) {
  const errors = [];
  if (!isObject(json)) return ["the file is not a JSON object"];
  if (json.about?.version !== SEED_FILE_VERSION) errors.push(`about.version is ${JSON.stringify(json.about?.version ?? null)}, not ${SEED_FILE_VERSION} (version 2 has no seed_picks: run the prep step first)`);
  const starter = json.lists?.[STARTER_LIST];
  if (!isObject(starter) || !isTexts(starter.items) || !starter.items.length) errors.push(`lists["${STARTER_LIST}"].items is missing or not a list of text`);
  if (isObject(starter) && !(Number.isInteger(starter.version) && starter.version >= 1)) errors.push(`lists["${STARTER_LIST}"].version is not a whole number`);
  const sp = json.seed_picks;
  if (!isObject(sp)) return [...errors, "seed_picks is missing"];
  if (sp.version !== SEED_PICKS_VERSION) errors.push(`seed_picks.version is ${JSON.stringify(sp.version ?? null)}, not ${SEED_PICKS_VERSION}`);
  if (!isObject(sp.clients) || !Object.keys(sp.clients).length) return [...errors, "seed_picks.clients is missing or empty"];
  for (const [tag, c] of Object.entries(sp.clients)) {
    const at = `seed_picks.clients.${tag}`;
    if (normTag(tag) !== tag || !/^[A-Z0-9][A-Z0-9_&-]{0,63}$/.test(tag)) errors.push(`${at}: not a client tag as client_tags holds it`);
    if (!isObject(c)) {
      errors.push(`${at}: not an object`);
      continue;
    }
    if (!c.people && !c.companies) errors.push(`${at}: neither a people nor a companies search`);
    for (const kind of LINKEDIN_KINDS) {
      const p = c[kind];
      if (p === null || p === undefined) continue;
      const pk = `${at}.${kind}`;
      if (!isObject(p)) {
        errors.push(`${pk}: not an object`);
        continue;
      }
      for (const f of ["source_id", "clay_tag", "set_up_at", "status"]) if (typeof p[f] !== "string" || !p[f]) errors.push(`${pk}.${f}: missing`);
      if (typeof p.set_up_at === "string" && Number.isNaN(Date.parse(p.set_up_at))) errors.push(`${pk}.set_up_at: not a date`);
      if (p.campaign !== null && typeof p.campaign !== "string") errors.push(`${pk}.campaign: not text or null`);
      if (p.records !== null && !Number.isInteger(p.records)) errors.push(`${pk}.records: not a whole number or null`);
      if (p.fingerprint !== null && typeof p.fingerprint !== "string") errors.push(`${pk}.fingerprint: not text or null`);
      if (p.company_list !== null && !(isObject(p.company_list) && Number.isInteger(p.company_list.size))) errors.push(`${pk}.company_list: not { size } or null`);
      if (typeof p.raw_location !== "boolean") errors.push(`${pk}.raw_location: not true or false`);
      if (!isTexts(p.include_style)) errors.push(`${pk}.include_style: not a list of text`);
      if (!isObject(p.places)) errors.push(`${pk}.places: missing`);
      else for (const f of PLACE_FIELDS) if (!isTexts(p.places[f])) errors.push(`${pk}.places.${f}: not a list of text`);
      if (!isTexts(p.keywords_exclude)) errors.push(`${pk}.keywords_exclude: not a list of text`);
    }
    if (c.flags !== undefined && !(isTexts(c.flags) && c.flags.every((f) => Object.hasOwn(LINKEDIN_FLAGS, f)))) errors.push(`${at}.flags: not a list of known flags`);
    if (c.notes !== undefined && !isTexts(c.notes)) errors.push(`${at}.notes: not a list of text`);
    if (c.campaigns_not_seeded !== undefined && !Array.isArray(c.campaigns_not_seeded)) errors.push(`${at}.campaigns_not_seeded: not a list`);
  }
  return errors;
}

/** Is `file` inside `dir` (both resolved through links)? */
export function isInside(file, dir) {
  const rel = path.relative(realpathSync(dir), realpathSync(file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Reads the seed file: refuses one inside the repo (it holds client data),
 * records its sha256, and refuses a layout other than this seed's.
 *
 * @param {string} file
 * @param {{ repoRoot: string }} opts
 * @returns {SeedFile}
 */
export function readSeedFile(file, { repoRoot }) {
  if (isInside(file, repoRoot)) throw new Error("The seed file must be kept outside the repository: it holds client data, and the repo is public.");
  const bytes = readFileSync(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let json;
  try {
    json = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SeedLayoutError(["the file is not JSON"]);
  }
  const errors = checkSeedLayout(json);
  if (errors.length) throw new SeedLayoutError(errors);
  const s = json.lists[STARTER_LIST];
  return {
    path: realpathSync(file),
    sha256,
    starter: { items: s.items, version: s.version, source: typeof s.source === "string" ? s.source : "normalized.json" },
    clients: Object.entries(json.seed_picks.clients),
  };
}

/**
 * The geo reference the conversion reads, for the countries a seed names:
 * every city by (country, state, key) with its spelling and population, every
 * key's states, the state names, the country names and aliases.
 *
 * TODO(L1): build it from geo_locations, geo_admin1, supported_countries and
 * location_aliases (country) of the database the seed writes to.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} _db
 * @param {{ countries?: string[] }} [_opts]
 * @returns {Promise<object>}
 */
export async function loadCityIndex(_db, _opts = {}) {
  return todo("loadCityIndex", _db, _opts);
}

/**
 * One Clay search's places in client_targeting's format (the rules of the
 * seed specification, section 3: the most specific place filter gives the
 * entries and the coarser ones restrict them; cities paired with the listed
 * states; a name in several listed states settled by the client's other
 * search, else its rules' places, else kept in every listed state; free-text
 * places; spelling variants; accents folded; what can't be placed goes to
 * unplaced with why and suggestions). Pure.
 *
 * TODO(L1): port the specification's rules; parity with the local preview
 * (p4-seed-work/seed-preview.json) is checked outside the repo.
 *
 * @param {SeedPick} _pick
 * @param {{ kind: "people" | "companies", cities: object, other: SeedPick | null,
 *           rules: import("./linkedin-settings.mjs").PlaceEntry[] }} _ctx
 *   cities: loadCityIndex()'s answer; other: the client's search of the other kind; rules: its client_targeting places
 * @returns {{ include: import("./linkedin-settings.mjs").PlaceEntry[], exclude: import("./linkedin-settings.mjs").PlaceEntry[],
 *   unplaced: import("./linkedin-settings.mjs").UnplacedValue[], notes: string[], flags: string[] }}
 */
export function convertPick(_pick, _ctx) {
  return todo("convertPick", _pick, _ctx);
}

/**
 * Plans the seed of every client in the file (no write): per client and kind
 * the row to write (places, unplaced, keywords, notes, flags, copied_from,
 * provenance), the clients skipped and why (not a database client, no
 * client_tags row), and the report's counts.
 *
 * TODO(L1): convertPick per kind, the one-kind copy, the review case (a search
 * that left out the client's own cities takes the other kind's places), the
 * company-list and include-style flags, campaigns not seeded into the notes.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} _db
 * @param {SeedFile} _file
 * @param {{ only?: string[] | null }} [_opts]
 * @returns {Promise<{ rows: Array<{ tag: string, kind: "people" | "companies", value: object, provenance: object }>,
 *   skipped: Array<{ tag: string, why: string }>, starter: SeedFile["starter"] }>}
 */
export async function planSeed(_db, _file, _opts = {}) {
  return todo("planSeed", _db, _file, _opts);
}

/**
 * Writes a plan inside the caller's transaction: the starter list, then each
 * row (seedLinkedinRow: never over a person's save, nothing when unchanged,
 * logged with the file's sha256).
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {Awaited<ReturnType<typeof planSeed>>} plan
 * @param {{ sha256: string, seededBy: string, geo: object }} opts
 * @returns {Promise<{ starter: { status: string, count: number }, rows: Array<{ tag: string, kind: string, status: string, errors?: string[] }> }>}
 */
export async function applySeed(db, plan, { sha256, seededBy, geo }) {
  const starter = await writeStarter(db, { items: plan.starter.items, version: plan.starter.version, source: plan.starter.source, sha256 });
  const rows = [];
  for (const r of plan.rows) {
    const out = await seedLinkedinRow(db, { tag: r.tag, kind: r.kind, value: r.value, provenance: r.provenance, sha256, seededBy, geo });
    rows.push({ tag: r.tag, kind: r.kind, ...out });
  }
  return { starter, rows };
}
