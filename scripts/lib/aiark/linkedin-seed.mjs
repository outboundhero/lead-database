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

// ── The geo reference the conversion reads ──────────────────────────────────

/** Countries whose cities the seed places (the Clay searches name the United States and Canada only). */
export const SEED_COUNTRIES = Object.freeze(["US", "CA"]);
// A state name more than one country has belongs to the first of these, as in geo.mjs.
const COUNTRY_ORDER = ["US", "CA", "AU", "NZ", "GB", "IE"];

const clean = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
/** Accents folded, curly quotes straightened, spaces collapsed, lower case: how names are compared. */
const fold = (v) =>
  String(v ?? "").normalize("NFD").replace(/\p{Mn}/gu, "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
/** geo.mjs cityKey: accents folded, everything but a-z dropped (geo_locations.city_key). */
const keyOf = (v) => fold(v).replace(/[^a-z]/g, "");
/** geo.mjs entryKey: the send gate's key for a stored entry (no accent folding). */
const entryKeyOf = (v) => clean(v).toLowerCase().replace(/[^a-z]/g, "");
/** Accents folded, case and spacing kept. */
const asciiFold = (v) => String(v ?? "").normalize("NFD").replace(/\p{Mn}/gu, "");
const near = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The index the conversion reads, from plain rows (loadCityIndex reads them from
 * the database; the tests pass made-up ones). Pure.
 *
 * @param {{ cities: Array<{ country: string, state: string, key?: string, name: string, pop?: number | null }>,
 *           states: Array<{ country: string, state: string, name: string }>,
 *           countries: Array<{ code: string, name: string, display_name?: string | null }>,
 *           aliases?: Array<{ alias_key: string, country_code: string }> }} rows
 *   cities in the order ties are settled in (loadCityIndex: most populous first, then the lowest geoname id)
 */
export function buildCityIndex({ cities, states, countries, aliases = [] }) {
  const city = new Map(); // "C|S|key" -> [{ name, pop }], most populous first
  const keyStates = new Map(); // key -> ["C|S", ...]
  const keysByState = new Map(); // "C|S" -> keys, sorted
  for (const r of cities ?? []) {
    const c = clean(r.country).toUpperCase();
    const s = clean(r.state).toUpperCase();
    const k = r.key ? String(r.key) : keyOf(r.name);
    if (!c || !s || !k) continue;
    const at = `${c}|${s}|${k}`;
    if (!city.has(at)) {
      city.set(at, []);
      if (!keyStates.has(k)) keyStates.set(k, []);
      keyStates.get(k).push(`${c}|${s}`);
      if (!keysByState.has(`${c}|${s}`)) keysByState.set(`${c}|${s}`, []);
      keysByState.get(`${c}|${s}`).push(k);
    }
    city.get(at).push({ name: String(r.name), pop: Number(r.pop) || 0 });
  }
  for (const list of city.values()) list.sort((a, b) => b.pop - a.pop); // stable: the given order settles ties
  for (const keys of keysByState.values()) keys.sort(near);
  const rank = (c) => (COUNTRY_ORDER.includes(c) ? COUNTRY_ORDER.indexOf(c) : COUNTRY_ORDER.length);
  const stateByName = new Map(); // folded name -> { country, state }
  const stateName = new Map(); // "C|S" -> name
  for (const r of [...(states ?? [])].sort((a, b) => rank(clean(a.country).toUpperCase()) - rank(clean(b.country).toUpperCase()))) {
    const c = clean(r.country).toUpperCase();
    const s = clean(r.state).toUpperCase();
    if (!stateByName.has(fold(r.name))) stateByName.set(fold(r.name), { country: c, state: s });
    stateName.set(`${c}|${s}`, String(r.name));
  }
  const trailing = [...stateByName].sort((a, b) => b[0].length - a[0].length);
  const countryByKey = new Map();
  const countryName = new Map();
  for (const r of countries ?? []) {
    const code = clean(r.code).toUpperCase();
    countryName.set(code, String(r.name));
    for (const n of [r.name, r.display_name, r.code]) if (n) countryByKey.set(keyOf(n), code);
  }
  for (const a of aliases ?? []) if (a?.alias_key) countryByKey.set(String(a.alias_key), clean(a.country_code).toUpperCase());
  return { city, keyStates, keysByState, stateByName, stateName, trailing, countryByKey, countryName };
}

/**
 * The geo reference the conversion reads, for the countries a seed names:
 * every city by (country, state, key) with its spelling and population (the
 * most populous first, ties by the lowest geoname id), every key's states, the
 * state names, the country names and aliases. One query after another (pg 9).
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {{ countries?: string[] }} [opts]
 * @returns {Promise<ReturnType<typeof buildCityIndex>>}
 */
export async function loadCityIndex(db, { countries = SEED_COUNTRIES } = {}) {
  const want = [...new Set((countries ?? SEED_COUNTRIES).map((c) => clean(c).toUpperCase()).filter(Boolean))];
  const { rows: cities } = await db.query(
    `SELECT g.country_code AS country, a.state_code AS state, g.city_key AS key, g.city AS name, coalesce(g.population, 0)::float8 AS pop
       FROM geo_locations g
       JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
      WHERE g.country_code = ANY($1::text[])
      ORDER BY coalesce(g.population, 0) DESC, g.geoname_id`,
    [want]
  );
  const { rows: states } = await db.query(`SELECT country_code AS country, state_code AS state, name FROM geo_admin1`);
  const { rows: names } = await db.query(`SELECT code, name, display_name FROM supported_countries`);
  const { rows: aliases } = await db.query(`SELECT alias_key, country_code FROM location_aliases WHERE level = 'country'`);
  return buildCityIndex({ cities, states, countries: names, aliases });
}

// ── Converting one Clay search's places (R3's specification, section 3) ─────

// Another spelling of the same name: tried when the name as written is not a city of the state.
const SPELLING_VARIANTS = [
  ["St. -> Saint", /^st(?=[a-z])/, "saint"], ["Saint -> St.", /^saint(?=[a-z])/, "st"],
  ["Ste. -> Sainte", /^ste(?=[a-z])/, "sainte"],
  ["Ft. -> Fort", /^ft(?=[a-z])/, "fort"], ["Fort -> Ft.", /^fort(?=[a-z])/, "ft"],
  ["Mt. -> Mount", /^mt(?=[a-z])/, "mount"], ["Mount -> Mt.", /^mount(?=[a-z])/, "mt"],
  ["AFB -> Air Force Base", /afb$/, "airforcebase"],
];
// "The" added or dropped: when the name as written is no city anywhere, or the variant in the
// listed state is at least as big as every city of the written name elsewhere.
const THE_VARIANTS = [["leading 'The' added", /^(?!the)/, "the"], ["leading 'The' dropped", /^the(?=[a-z])/, ""]];
// A word added or dropped: only when the name as written is no city anywhere in the United States
// or Canada (otherwise it names that other place).
const WORD_VARIANTS = [
  ["trailing Township/Twp/Village/Borough dropped", /(?<=[a-z])(township|twp|village|borough)$/, ""],
  ["trailing City dropped", /(?<=[a-z]{3})city$/, ""],
  ["leading 'City of'/'Town of'/'Township of'/'District of'/'Village of' dropped", /^(cityof|townof|townshipof|districtof|villageof)(?=[a-z])/, ""],
];
const VARIANTS = [...SPELLING_VARIANTS, ...THE_VARIANTS, ...WORD_VARIANTS];
const NAMED_AS_STATE = "a city named like its state: the geo reference's city of that name";
const WORD = "(?<![\\p{L}\\p{N}_])";
const END = "(?![\\p{L}\\p{N}_])";
const METRO_RX = new RegExp(`${WORD}(greater|metro|metropolitan|metroplex|area|region|county|counties|parish)${END}`, "iu");
const METRO_WORDS_RX = new RegExp(`${WORD}(greater|metro|metropolitan|metroplex|area|region|county|counties|parish|downtown)${END}`, "giu");
const HOME = ["US", "CA"];

/** The conversion's reads of the index. */
function geoOf(ix) {
  const has = (c, s, k) => ix.city.has(`${c}|${s}|${k}`);
  const statesOf = (k) => ix.keyStates.get(k) ?? [];
  const known = (k) => statesOf(k).some((cs) => HOME.includes(cs.split("|")[0]));
  const popOf = (c, s, k) => ix.city.get(`${c}|${s}|${k}`)?.[0]?.pop ?? -1;
  /** The geo reference's spelling of a city key in a state (its most populous record), accents folded. */
  const geoName = (c, s, k) => {
    const rows = ix.city.get(`${c}|${s}|${k}`);
    return rows?.length ? asciiFold(rows[0].name) : null;
  };
  /** A city named exactly like its state, where the state holds "<name> City" and no city of the name itself. */
  const namedAsState = (c, s, k) => {
    const name = ix.stateName.get(`${c}|${s}`);
    return name && keyOf(name) === k && has(c, s, `${k}city`) ? `${k}city` : null;
  };
  return { ix, has, statesOf, known, popOf, geoName, namedAsState };
}

const splitCS = (cs) => {
  const [country, state] = cs.split("|");
  return { country, state };
};
const sortCS = (list) => [...list].sort((a, b) => near(`${a.country}|${a.state}`, `${b.country}|${b.state}`));

/** (key found, variant label or null) for city key k in state (c, s). */
function findCity(g, c, s, k, { words = true } = {}) {
  if (g.has(c, s, k)) return { key: k, label: null };
  const named = g.namedAsState(c, s, k);
  if (named) return { key: named, label: NAMED_AS_STATE };
  for (const [label, a, b] of words ? VARIANTS : SPELLING_VARIANTS) {
    const k2 = k.replace(a, b);
    if (k2 !== k && g.has(c, s, k2)) return { key: k2, label };
  }
  return { key: null, label: null };
}

/**
 * Hits for city key k in the listed states: as written in any of them first;
 * only when it is a city of none of them, its spelling variants, then "The",
 * then (only when the name is no city anywhere) a word variant.
 */
function findInStates(g, pool, k) {
  const exact = pool.filter((p) => g.has(p.country, p.state, k)).map((p) => ({ ...p, key: k, label: null }));
  if (exact.length) return exact;
  const named = pool.map((p) => ({ p, k2: g.namedAsState(p.country, p.state, k) })).filter((x) => x.k2);
  if (named.length) return named.map(({ p, k2 }) => ({ ...p, key: k2, label: NAMED_AS_STATE }));
  const elsewhere = Math.max(-1, ...g.statesOf(k).filter((cs) => HOME.includes(cs.split("|")[0])).map((cs) => {
    const { country, state } = splitCS(cs);
    return g.popOf(country, state, k);
  }));
  for (const [name, group] of [["spelling", SPELLING_VARIANTS], ["the", THE_VARIANTS], ["word", g.known(k) ? [] : WORD_VARIANTS]]) {
    const hits = [];
    for (const p of pool) {
      for (const [label, a, b] of group) {
        const k2 = k.replace(a, b);
        if (k2 !== k && g.has(p.country, p.state, k2)) {
          if (name === "the" && g.popOf(p.country, p.state, k2) < elsewhere) continue;
          hits.push({ ...p, key: k2, label });
          break;
        }
      }
    }
    if (hits.length) return hits;
  }
  return [];
}

/** The city text stored: the geo reference's spelling of the matched city, accents folded; else what was written, folded. */
function writtenCity(g, raw, c, s, found) {
  const name = found ? g.geoName(c, s, found) : null;
  if (name && entryKeyOf(name) === found) return name;
  return asciiFold(clean(raw));
}

/**
 * "Quuxville Zedland" -> a city and its state; "Zedland" -> the state alone; "Quuxville Canada" ->
 * a city and a country with no state; else the text as a city. Only states of the allowed
 * countries; an optional comma before the state.
 */
function splitCityState(g, text, allowed) {
  const orig = clean(text);
  const f = fold(orig);
  for (const [name, cs] of g.ix.trailing) {
    if (!allowed.has(cs.country)) continue;
    if (f === name) return { city: "", state: cs, country: cs.country };
    for (const sep of [" ", ", ", ","]) {
      if (f.endsWith(sep + name)) {
        const cut = (sep + name).length;
        const city = orig.length === f.length ? orig.slice(0, orig.length - cut).trim() : f.slice(0, f.length - cut).trim();
        return { city: city.replace(/,+$/, ""), state: cs, country: cs.country };
      }
    }
  }
  const names = [...new Set([...g.ix.countryName.values()].map(fold).concat(["usa", "united states of america", "canada"]))].sort((a, b) => b.length - a.length);
  for (const cname of names) {
    const code = g.ix.countryByKey.get(keyOf(cname));
    if (!allowed.has(code)) continue;
    if (f === cname) return { city: "", state: null, country: code };
    if (f.endsWith(` ${cname}`) || f.endsWith(`, ${cname}`)) return { city: orig.slice(0, orig.length - cname.length).trim().replace(/,+$/, ""), state: null, country: code };
  }
  return { city: orig, state: null, country: null };
}

/**
 * Suggestions for an unplaced value, never applied: the same name in other
 * states; in the listed states, the cities whose key starts with the value's,
 * or is the start of it (5 letters or more); for a metro or joined name, its
 * parts as cities. The listed states first, the most populous first, at most 6.
 */
function suggestionsFor(g, name, states) {
  const base = name.replace(METRO_WORDS_RX, " ");
  const k = keyOf(base);
  const pool = states?.length ? sortCS(states) : null;
  const found = new Map();
  const add = (c, s, kk) => {
    if (g.has(c, s, kk)) found.set(`${c}|${s}|${kk}`, { country: c, state: s, key: kk });
  };
  if (k) {
    const keys = new Set([...g.statesOf(keyOf(name)), ...g.statesOf(k)]);
    for (const cs of [...keys].sort(near)) {
      const { country, state } = splitCS(cs);
      if (HOME.includes(country)) add(country, state, g.has(country, state, k) ? k : keyOf(name));
    }
    if (pool && k.length >= 5) {
      for (const p of pool) {
        const list = g.ix.keysByState.get(`${p.country}|${p.state}`) ?? [];
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid] < k) lo = mid + 1;
          else hi = mid;
        }
        for (let i = lo; i < list.length && list[i].startsWith(k); i++) add(p.country, p.state, list[i]);
        for (let j = 5; j < k.length; j++) add(p.country, p.state, k.slice(0, j));
      }
    }
  }
  for (const part of base.split(/\s*[-\u2013/,&]\s*|\s+and\s+/)) {
    const pk = keyOf(part);
    if (pk.length < 3 || pk === k) continue;
    const where = pool ?? sortCS(g.statesOf(pk).map(splitCS));
    for (const p of where) add(p.country, p.state, pk);
  }
  const listed = new Set((states ?? []).map((p) => `${p.country}|${p.state}`));
  return [...found.values()]
    .sort((a, b) => Number(!listed.has(`${a.country}|${a.state}`)) - Number(!listed.has(`${b.country}|${b.state}`)) ||
      g.popOf(b.country, b.state, b.key) - g.popOf(a.country, a.state, a.key) || near(`${a.country}|${a.state}|${a.key}`, `${b.country}|${b.state}|${b.key}`))
    .slice(0, 6)
    .map((f) => ({ country: f.country, state: f.state, city: g.geoName(f.country, f.state, f.key) }));
}

/**
 * A city name with no state of its own, as Clay's filters AND together: in a
 * listed state if any, else in a listed country (the United States when none is
 * listed). Answers its entries, or why it can't be placed, and the notes.
 */
function placeCity(g, raw, states, countries, field, side) {
  const name = clean(raw);
  const k = keyOf(name);
  const notes = [];
  if (!k) return { entries: [], unplaced: { side, field, value: String(raw ?? ""), why: "empty after cleaning", cands: [] }, notes };
  const pool = states?.length ? sortCS(states) : null;
  const allowed = new Set(countries?.length ? countries : ["US"]);
  let hits = [];
  if (pool) hits = findInStates(g, pool, k);
  else {
    for (const cs of [...g.statesOf(k)].sort(near)) {
      const p = splitCS(cs);
      if (allowed.has(p.country)) hits.push({ ...p, key: k, label: null });
    }
    if (!hits.length) {
      for (const [label, a, b] of [...SPELLING_VARIANTS, ...(g.known(k) ? [] : [...THE_VARIANTS, ...WORD_VARIANTS])]) {
        const k2 = k.replace(a, b);
        if (k2 === k) continue;
        for (const cs of [...g.statesOf(k2)].sort(near)) {
          const p = splitCS(cs);
          if (allowed.has(p.country)) hits.push({ ...p, key: k2, label });
        }
        if (hits.length) break;
      }
    }
  }
  if (!hits.length) {
    const parts = name.split(/\s*[-\u2013/]\s*/).filter(Boolean);
    const elsewhere = g.statesOf(k).filter((cs) => HOME.includes(cs.split("|")[0])).sort(near);
    let why;
    if (METRO_RX.test(name)) why = "a county, metro area or region, not a city";
    else if (parts.length === 2 && parts.every((p) => g.ix.keyStates.has(keyOf(p)))) why = "two cities joined into one name (a metro name), not one city";
    else if (pool && elsewhere.length) {
      why = `not a city of a listed state in the geo reference, which has a city of that name only in ${elsewhere.slice(0, 4).join(", ")}${elsewhere.length > 4 ? " and others" : ""}`;
    } else if (pool) why = "not a city of a listed state in the geo reference, nor anywhere else (a neighbourhood, base, township or other local name)";
    else why = "not a city of the listed countries in the geo reference";
    return { entries: [], unplaced: { side, field, value: name, why, cands: suggestionsFor(g, name, states) }, notes };
  }
  if (!pool && new Set(hits.map((h) => `${h.country}|${h.state}`)).size > 1) {
    return {
      entries: [],
      unplaced: {
        side, field, value: name, why: `no state listed, and the geo reference has a city of that name in ${hits.length} states`,
        cands: hits.map((h) => ({ country: h.country, state: h.state, city: g.geoName(h.country, h.state, h.key) })),
      },
      notes,
    };
  }
  const entries = [];
  for (const h of hits) {
    const e = { country: h.country, state: h.state, city: writtenCity(g, name, h.country, h.state, h.key) };
    entries.push(e);
    if (h.label) notes.push(`${name} (${h.country}|${h.state}): ${h.label} -> ${e.city}`);
    else if (entryKeyOf(name) !== h.key) notes.push(`${name} (${h.country}|${h.state}): accents folded -> ${e.city}`);
  }
  if (hits.length > 1) notes.push(`${name}: a city in ${hits.length} of the listed states, one entry each`);
  return { entries, unplaced: null, notes };
}

const placeKey = (e) => `${e.country}|${e.state ?? ""}|${entryKeyOf(e.city ?? "")}`;
/** Entries once each (country, state, the city's send-gate key), in their order. */
function dedupe(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const k = placeKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ country: e.country, ...(e.state ? { state: e.state } : {}), ...(e.city ? { city: e.city } : {}) });
  }
  return out;
}

/** Clay's place fields of a search, Clay's own conversion (no other search, no rules): R3's convert(). */
function convertPlaces(g, places) {
  const notes = [];
  let unplaced = [];
  const countries = [];
  for (const x of places.countries ?? []) {
    const code = g.ix.countryByKey.get(keyOf(x));
    if (code) countries.push(code);
    else unplaced.push({ side: "include", field: "countries", value: x, why: "not a supported country", cands: [] });
  }
  const allowed = new Set(countries.length ? countries : ["US", "CA"]);
  const states = [];
  for (const x of places.states ?? []) {
    const st = g.ix.stateByName.get(fold(x));
    if (st && (!countries.length || countries.includes(st.country))) states.push(st);
    else if (st) unplaced.push({ side: "include", field: "states", value: x, why: `a state of ${st.country}, outside the listed countries`, cands: [] });
    else unplaced.push({ side: "include", field: "states", value: x, why: "not a state or province name", cands: [] });
  }
  const S = [...new Map(states.map((s) => [`${s.country}|${s.state}`, s])).values()];
  const inS = (st) => S.some((x) => x.country === st.country && x.state === st.state);
  let include = [];
  let level = "none";
  if ((places.cities ?? []).length || (places.free_text_places ?? []).length) {
    level = "city";
    for (const x of places.cities ?? []) {
      const r = placeCity(g, x, S, countries, "cities", "include");
      include.push(...r.entries);
      notes.push(...r.notes);
      if (r.unplaced) unplaced.push(r.unplaced);
    }
    for (const x of places.free_text_places ?? []) {
      const { city, state: st, country: cc } = splitCityState(g, x, allowed);
      if (!city && st) {
        if (S.length && inS(st)) {
          // A free-text value equal to a state the states filter already lists cannot mean that
          // state (it would make every other free-text value pointless): it is the city of that name there.
          const k = keyOf(x);
          const f = findCity(g, st.country, st.state, k, { words: !g.known(k) });
          if (f.key) {
            include.push({ country: st.country, state: st.state, city: writtenCity(g, x, st.country, st.state, f.key) });
            notes.push(`"${x}": both a city and a state; the states filter already lists ${st.state}, so read as the city -> ${include.at(-1).city}`);
          } else {
            include.push({ country: st.country, state: st.state });
            notes.push(`"${x}" is a whole state`);
          }
        } else if (S.length) {
          unplaced.push({ side: "include", field: "free_text_places", value: x, why: "a state that is not a listed state", cands: [] });
        } else {
          include.push({ country: st.country, state: st.state });
          notes.push(`"${x}" is a whole state`);
        }
        continue;
      }
      if (!city && cc) {
        include.push({ country: cc });
        notes.push(`"${x}" is a whole country`);
        continue;
      }
      let r;
      if (st) {
        if (S.length && !inS(st)) {
          unplaced.push({ side: "include", field: "free_text_places", value: x, why: `its state (${st.state}) is not a listed state`, cands: [] });
          continue;
        }
        r = placeCity(g, city, [st], [st.country], "free_text_places", "include");
      } else {
        r = placeCity(g, city, S, cc ? [cc] : countries, "free_text_places", "include");
      }
      include.push(...r.entries);
      notes.push(...r.notes);
      if (r.unplaced) unplaced.push({ ...r.unplaced, value: x });
    }
  } else if (S.length) {
    level = "state";
    include = states.map((s) => ({ country: s.country, state: s.state }));
  } else if (countries.length) {
    level = "country";
    include = countries.map((c) => ({ country: c }));
  }
  // A city name with no state, found in several states: when every placed city of this search is
  // in one state that also has this name, it is placed there (noted); otherwise it stays unplaced.
  const one = [...new Set(include.filter((e) => e.city).map((e) => `${e.country}|${e.state}`))];
  if (one.length === 1) {
    const { country: c1, state: s1 } = splitCS(one[0]);
    const keep = [];
    for (const u of unplaced) {
      if (u.side === "include" && u.why.startsWith("no state listed") && u.cands.some((x) => x.country === c1 && x.state === s1)) {
        const { city } = splitCityState(g, u.value, allowed);
        const f = findCity(g, c1, s1, keyOf(city));
        include.push({ country: c1, state: s1, city: writtenCity(g, city, c1, s1, f.key) });
        notes.push(`"${u.value}": no state given; every other place of this search is in ${c1}|${s1}, so placed there`);
      } else keep.push(u);
    }
    unplaced = keep;
  }
  if (level === "city") {
    const covered = new Set(include.map((e) => `${e.country}|${e.state ?? ""}`));
    const idle = states.filter((s) => !covered.has(`${s.country}|${s.state}`));
    if (idle.length) {
      notes.push(`listed state(s) with none of the listed places in them, so Clay's search had no place there (place filters AND together): ${idle.map((s) => `${s.country}|${s.state}`).join(", ")}`);
    }
  }
  const exclude = [];
  for (const x of places.states_exclude ?? []) {
    const st = g.ix.stateByName.get(fold(x));
    if (st) exclude.push({ country: st.country, state: st.state });
    else unplaced.push({ side: "exclude", field: "states_exclude", value: x, why: "not a state or province name", cands: [] });
  }
  for (const x of places.cities_exclude ?? []) {
    const r = placeCity(g, x, S, countries, "cities_exclude", "exclude");
    exclude.push(...r.entries);
    notes.push(...r.notes);
    if (r.unplaced) unplaced.push(r.unplaced);
  }
  for (const x of places.free_text_places_exclude ?? []) {
    const { city, state: st, country: cc } = splitCityState(g, x, allowed);
    if (!city && st) {
      exclude.push({ country: st.country, state: st.state });
      continue;
    }
    if (!city && cc) {
      exclude.push({ country: cc });
      continue;
    }
    const r = placeCity(g, city, st ? [st] : S, st ? [st.country] : cc ? [cc] : countries, "free_text_places_exclude", "exclude");
    exclude.push(...r.entries);
    notes.push(...r.notes);
    if (r.unplaced) unplaced.push({ ...r.unplaced, value: x });
  }
  return { include: dedupe(include), exclude: dedupe(exclude), unplaced, notes, level };
}

const hasFreeText = (pick) => (pick?.places?.free_text_places ?? []).some((x) => clean(x));
const unplacedOut = (u) => ({ side: u.side, field: u.field, value: u.value, why: u.why, suggestions: dedupe((u.cands ?? []).filter((e) => e.city || e.state)) });

/**
 * One Clay search's places in client_targeting's format (the rules of the
 * seed specification, section 3: the most specific place filter gives the
 * entries and the coarser ones restrict them; cities paired with the listed
 * states; a name in several listed states settled by the client's other
 * search, else its rules' places, else kept in every listed state; free-text
 * places; spelling variants; accents folded; what can't be placed goes to
 * unplaced with why and suggestions). Pure.
 *
 * @param {SeedPick} pick
 * @param {{ kind: "people" | "companies", cities: ReturnType<typeof buildCityIndex>, other: SeedPick | null,
 *           rules: import("./linkedin-settings.mjs").PlaceEntry[] }} ctx
 *   cities: loadCityIndex()'s answer; other: the client's search of the other kind; rules: its client_targeting places
 * @returns {{ include: import("./linkedin-settings.mjs").PlaceEntry[], exclude: import("./linkedin-settings.mjs").PlaceEntry[],
 *   unplaced: import("./linkedin-settings.mjs").UnplacedValue[], notes: string[], flags: string[],
 *   level: "city" | "state" | "country" | "none", setAside: import("./linkedin-settings.mjs").PlaceEntry[] }}
 *   level: the most specific place filter Clay's search set; setAside: entries a name in several listed states lost
 */
export function convertPick(pick, { kind, cities, other = null, rules = [] }) {
  if (!LINKEDIN_KINDS.includes(kind)) throw new Error(`kind must be people or companies, not "${kind}"`);
  const g = geoOf(cities);
  const c = convertPlaces(g, pick?.places ?? {});
  // A name placed in several listed states (Clay matched it in all of them): keep the state(s) the
  // client's other search names it in with its state (free text), else those its rules hold it
  // in; else every listed state. A name this search wrote with its own state is never settled.
  const explicit = new Set(hasFreeText(pick) ? c.include.filter((e) => e.city).map((e) => keyOf(e.city)) : []);
  const otherNamed = new Map();
  if (other && hasFreeText(other)) {
    for (const e of convertPlaces(g, other.places ?? {}).include) {
      if (!e.city) continue;
      const k = keyOf(e.city);
      if (!otherNamed.has(k)) otherNamed.set(k, new Set());
      otherNamed.get(k).add(`${e.country}|${e.state}`);
    }
  }
  const rulesIn = new Map();
  for (const e of Array.isArray(rules) ? rules : []) {
    const k = keyOf(e?.city ?? "");
    if (!rulesIn.has(k)) rulesIn.set(k, new Set());
    rulesIn.get(k).add(`${clean(e?.country).toUpperCase()}|${clean(e?.state).toUpperCase()}`);
  }
  const notes = c.notes.filter((n) => !/: a city in \d+ of the listed states, one entry each$/.test(n));
  const byKey = new Map();
  for (const e of c.include) {
    if (!e.city) continue;
    const k = keyOf(e.city);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(e);
  }
  const drop = new Set();
  const setAside = [];
  for (const [k, es] of byKey) {
    if (es.length < 2 || explicit.has(k)) continue;
    const states = new Set(es.map((e) => `${e.country}|${e.state}`));
    const meet = (set) => new Set([...(set ?? [])].filter((x) => states.has(x)));
    let keep = null;
    let how = "";
    const named = meet(otherNamed.get(k));
    const ruled = meet(rulesIn.get(k));
    if (named.size) {
      keep = named;
      how = "the other search names it with its state";
    } else if (ruled.size && ruled.size !== states.size) {
      keep = ruled;
      how = "the client's database rules hold it there";
    }
    if (keep && keep.size !== states.size) {
      const gone = es.filter((e) => !keep.has(`${e.country}|${e.state}`));
      for (const e of gone) {
        drop.add(placeKey(e));
        setAside.push(e);
      }
      notes.push(`${es[0].city}: a city of ${states.size} listed states; kept ${[...keep].sort(near).join(", ")} (${how}); set aside ${gone.map((e) => `${e.country}|${e.state}`).join(", ")}`);
    } else {
      notes.push(`${es[0].city}: a city of ${states.size} listed states, nothing names one of them; one entry each`);
    }
  }
  const include = c.include.filter((e) => !drop.has(placeKey(e)));
  const flags = [];
  if (!include.length || include.every((e) => !e.state)) flags.push("whole_countries");
  return { include, exclude: c.exclude, unplaced: c.unplaced.map(unplacedOut), notes, flags, level: c.level, setAside };
}

// ── The plan ────────────────────────────────────────────────────────────────

const OTHER = { people: "companies", companies: "people" };
const kwClean = (list) => {
  const out = [];
  const seen = new Set();
  for (const x of Array.isArray(list) ? list : []) {
    const t = clean(x);
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
};
const textOf = (e) => [e.city, e.state, e.country].filter(Boolean).join(", ");
const day = (iso) => String(iso ?? "").slice(0, 10);
const provenanceOf = (p) =>
  p ? { clay_source_id: p.source_id, clay_campaign: p.campaign ?? null, clay_set_up_at: p.set_up_at ?? null, clay_fingerprint: p.fingerprint ?? null } : {};

/**
 * Plans the seed of every client in the file (no write): per client and kind
 * the row to write (places, unplaced, keywords, notes, flags, copied_from,
 * provenance), the clients skipped and why (not a database client, no
 * client_tags row), and the report's counts.
 *
 * Per client: each kind's own search converted (convertPick); a search that
 * covered whole states and left out at least half of the cities the other
 * search includes (Clay's search of "the state minus the client's own
 * cities") takes the other kind's places and is held for review; a kind the
 * client has no search of copies the other kind's places, unplaced values and
 * keywords (copied_from). Flags: review, company_list (a people search Clay
 * limited to a list of companies, seeded as a search of its own places),
 * include_style, whole_countries, unconfirmed_match and campaigns_not_seeded
 * (the other campaigns go in the notes).
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db
 * @param {SeedFile} file
 * @param {{ only?: string[] | null, cities?: ReturnType<typeof buildCityIndex> | null }} [opts]
 *   cities: an index already loaded (the tests), else loadCityIndex(db)
 * @returns {Promise<{ rows: Array<{ tag: string, kind: "people" | "companies", value: object, provenance: object }>,
 *   skipped: Array<{ tag: string, why: string }>, starter: SeedFile["starter"] }>}
 */
export async function planSeed(db, file, { only = null, cities = null } = {}) {
  const want = only?.length ? new Set(only.map((t) => normTag(t))) : null;
  const clients = file.clients.filter(([tag]) => !want || want.has(normTag(tag)));
  const index = cities ?? (await loadCityIndex(db));
  const tags = clients.map(([tag]) => normTag(tag));
  const viaTags = [...new Set(clients.flatMap(([, c]) => LINKEDIN_KINDS.map((k) => c[k]?.clay_tag).filter(Boolean).map((t) => normTag(t))))];
  const { rows: known } = await db.query(`SELECT tag FROM client_tags WHERE tag = ANY($1::text[])`, [tags]);
  const isClient = new Set(known.map((r) => r.tag));
  const { rows: ruleRows } = await db.query(
    `SELECT client_tag, include_locations FROM client_targeting WHERE client_tag = ANY($1::text[])`,
    [[...new Set([...tags, ...viaTags])]]
  );
  const rulesOf = new Map(ruleRows.map((r) => [r.client_tag, Array.isArray(r.include_locations) ? r.include_locations : []]));

  const rows = [];
  const skipped = [];
  for (const [rawTag, client] of clients) {
    const tag = normTag(rawTag);
    if (!isClient.has(tag)) {
      skipped.push({ tag, why: "no client_tags row (not a database client here)" });
      continue;
    }
    // The client's own rules; a client with none takes those of the Clay tag its searches come from.
    const via = LINKEDIN_KINDS.map((k) => client[k]?.clay_tag).filter(Boolean).map((t) => normTag(t)).find((t) => rulesOf.has(t));
    const rules = rulesOf.get(tag) ?? (via ? rulesOf.get(via) : []) ?? [];
    const conv = {};
    for (const k of LINKEDIN_KINDS) {
      if (client[k]) conv[k] = convertPick(client[k], { kind: k, cities: index, other: client[OTHER[k]] ?? null, rules });
    }
    // A search of whole states that left out the client's own cities (its other search includes them).
    const inverted = {};
    for (const k of Object.keys(conv)) {
      const o = OTHER[k];
      const cv = conv[k];
      if (!conv[o] || cv.level !== "state" || !cv.exclude.length) continue;
      const otherKeys = new Set([...conv[o].include, ...conv[o].setAside].filter((e) => e.city).map((e) => `${e.country}|${e.state}|${keyOf(e.city)}`));
      const ex = cv.exclude.filter((e) => e.city);
      const hit = ex.filter((e) => otherKeys.has(`${e.country}|${e.state}|${keyOf(e.city)}`));
      if (ex.length && hit.length * 2 >= ex.length) inverted[k] = { hit: hit.length, of: ex.length };
    }
    const clientFlags = Array.isArray(client.flags) ? client.flags : [];
    const campaigns = Array.isArray(client.campaigns_not_seeded) ? client.campaigns_not_seeded : [];
    const clientNotes = (Array.isArray(client.notes) ? client.notes : []).map(clean).filter(Boolean);
    for (const k of LINKEDIN_KINDS) {
      const o = OTHER[k];
      const own = client[k] ?? null;
      if (!own && !client[o]) continue;
      const notes = [];
      const flags = [];
      let places;
      let keywords;
      let copied = null;
      let provenance;
      if (own) {
        const cv = conv[k];
        places = cv;
        keywords = kwClean(own.keywords_exclude);
        provenance = provenanceOf(own);
        notes.push(...cv.notes);
        if (inverted[k]) {
          places = conv[o];
          flags.push("review");
          notes.push(
            `Held for review: Clay's ${k} search covered whole states and left out ${inverted[k].hit} of the ${inverted[k].of} cities it excluded, which the ${o} search includes, so this takes the ${o} search's places. Clay's own places: ${cv.include.map(textOf).join("; ") || "none"}. Left out: ${cv.exclude.map(textOf).join("; ") || "none"}.${cv.unplaced.length ? ` Not placed: ${cv.unplaced.map((u) => u.value).join("; ")}.` : ""}`
          );
        }
        if (own.company_list) {
          flags.push("company_list");
          notes.push(`Clay looked only inside a list of ${Number(own.company_list.size).toLocaleString("en-US")} companies; seeded as a search of its own places.`);
        }
        if (own.include_style?.length) {
          flags.push("include_style");
          notes.push(`Clay's search also named what to find (${own.include_style.join(", ")}), which is not carried over: the standard filters apply.`);
        }
      } else {
        copied = o;
        places = conv[o];
        keywords = kwClean(client[o].keywords_exclude);
        provenance = provenanceOf(client[o]);
        notes.push(`No ${k} search Clay ran: this copies the ${o} search's places, unplaced values and keywords.`);
      }
      if (!places.include.length || places.include.every((e) => !e.state)) flags.push("whole_countries");
      if (clientFlags.includes("unconfirmed_match")) {
        flags.push("unconfirmed_match");
        notes.push("The Clay tag's match to this client is not confirmed.");
      }
      if (campaigns.length || clientFlags.includes("campaigns_not_seeded")) flags.push("campaigns_not_seeded");
      for (const x of campaigns) {
        notes.push(`Not seeded: the ${x.kind} search of the campaign ${x.campaign ?? "(none)"} (Clay tag ${x.clay_tag}, search ${x.source_id}, set up ${day(x.set_up_at)}, ${x.status ?? "no status"}, ${x.records ?? 0} records).`);
      }
      notes.push(...clientNotes);
      rows.push({
        tag,
        kind: k,
        value: {
          include_locations: places.include,
          exclude_locations: places.exclude,
          unplaced: places.unplaced,
          exclude_keywords: keywords,
          notes,
          flags: [...new Set(flags)],
          copied_from: copied,
        },
        provenance,
      });
    }
  }
  return { rows, skipped, starter: file.starter };
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
