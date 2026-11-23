#!/usr/bin/env node
// Checks for the default refreshed from the template client's current tables
// and each client's own personalisation as an overlay on it (2026-11-21): the
// layout's extensions and overlays, credentials redacted on every load,
// refreshDefault, personalisationOverlay and seedPersonalisation, the seed
// script's new modes, G#19 read as empty when it fails (as in Clay), and the
// Clay grid's find_email column of AI Ark run tables. LOCAL DATABASE ONLY.
//
// Everything is made up: the exports are the fixtures'
// (scripts/fixtures/clay-originals), the clients' with their field ids
// relabelled, the base is the fixtures seeded as pstest_base_<run>, tags start
// PSTEST_ and variants pstest_; all of it is removed at the end. The local
// "default" originals and people tracks are never changed (one check restores
// the default inside a transaction that is rolled back); the fallback check
// compiles the local default, so it must be loaded.
//
//   node --env-file=.env.local scripts/test-personalisation-originals.mjs
//
// Stop the enrichment worker first. Nothing reaches a network: fetch is
// replaced (OpenAI answers from a stub, every other address is refused). It
// refuses to run while any client is on the company_pipeline, people_pipeline,
// personalisation or promotion lists, or while a held row exists outside its
// own tags.
//
//   A. the layout: keysOf, knownPosition, shapeOf
//   B. credentials redacted
//   C. refreshDefault
//   D. personalisation overlays
//   E. the seed script's --refresh-default, --restore-default and --personalisation
//   F. G#19 read as empty when it fails; the personalisation switch reads text_variant
//   G. the Clay grid's find_email (source checks)

import pg from "pg";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIXTURE_MARKER, fixtureSeedExports, fixtureText } from "./fixtures/clay-originals/fixtures.mjs";
import { checker, dropPaidKeys, inTx, installNet, localDatabaseUrl } from "./fixtures/test-support.mjs";
import { keysOf, knownPosition, ORIGINAL_COUNTS, ORIGINAL_EXTENSIONS, ORIGINAL_KINDS, OVERLAY_AI_POSITIONS, OVERLAY_POSITIONS } from "./lib/enrich/original-keys.mjs";
import { loadOriginals, OriginalsMissing, originalsSummary, shapeOf } from "./lib/enrich/compile-original.mjs";
import {
  BACKUP_KIND, mergeVariant, originalRows, originalsMap, personalisationOverlay, REDACTED, redactCredentials, refreshDefault, restoreBackup,
  seedOriginals, seedPersonalisation,
} from "./lib/enrich/seed-originals.mjs";
import { compileTemplates, ensurePipelineTables, variantFor, variantOfNote } from "./lib/enrich/templates.mjs";
import { READ_AS_EMPTY, runRow } from "./lib/enrich/engine.mjs";
import { settingsFrom } from "./lib/enrich/settings.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN = randomUUID().slice(0, 6);
const PREFIX = "PSTEST_";
const BASE = `pstest_base_${RUN}`;
const NEW = `pstest_new_${RUN}`;
const KINDS = ORIGINAL_KINDS;
const LETTER = { companies: "C", people: "P", inboxes: "G" };

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const thrown = (fn) => {
  try {
    fn();
    return "";
  } catch (e) {
    return String(e?.message ?? e);
  }
};

/** JSON with every object's keys sorted: jsonb keeps no key order. */
const canon = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
/** Every string and key of a value through fn. */
function mapText(v, fn) {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapText(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [fn(k), mapText(x, fn)]));
  return v;
}
/** A made-up column name from one of our keys (the fixtures name every column so). */
const nameOf = (key) => key.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
const fid = (kind, position) => `f_fx${LETTER[kind]}${String(position).padStart(2, "0")}`;
const ref = (kind, position) => `{{${fid(kind, position)}}}`;

/**
 * A made-up client's exports: the fixtures, each field id relabelled (f_fxP60 as
 * f_psP60) unless asked not to, as a table built apart would have them.
 */
function clientExports({ relabel = true, edit = null } = {}) {
  const exp = fixtureSeedExports();
  /** @type {Record<string, { sha256: string, data: any[] }>} */
  const out = {};
  for (const k of KINDS) out[k] = { sha256: "", data: relabel ? mapText(exp[k].data, (s) => s.replace(/f_fx([CPG]\d\d)/g, "f_ps$1")) : structuredClone(exp[k].data) };
  if (edit) edit(out);
  for (const k of KINDS) out[k].sha256 = sha(JSON.stringify(out[k].data));
  return out;
}
const col = (exp, kind, position) => exp[kind].data.find((c) => c.id.endsWith(`${LETTER[kind]}${String(position).padStart(2, "0")}`));
const without = (exp, kind, position) => {
  exp[kind].data = exp[kind].data.filter((c) => c !== col(exp, kind, position));
};
const binding = (c, name) => c.settings.inputsBinding.find((b) => b.name === name);
/** The client's own text in a research step: its prompt changed, so it is no longer the base's. */
const ownText = (exp, kind, position) => {
  const b = binding(col(exp, kind, position), "prompt");
  b.formulaText = b.formulaText.replace("Summarise what this business does.", "Summarise what this made-up business does, in one line.");
};
const rowOf = (rows, kind, position) => rows.find((r) => r.template_kind === kind && r.position === position);
const fixtureRows = (variant = "pstest_x") => originalRows(fixtureSeedExports(), { variant, seededBy: "tests" });

/** A made-up token of 40 characters (never a real key). */
const FAKE_TOKEN = "zzfake0pstest0token0not0a0real0key0zzzz0";

// ── A. The layout ───────────────────────────────────────────────────────────

function partA() {
  section("A. The layout: extensions and overlays");
  check("keysOf: ORIGINAL_KEYS with the extension keys", keysOf("companies")[5] === "company" && keysOf("companies")[69] === "inclusion_keywords_filter" &&
    keysOf("companies")[70] === "dupe_check_3" && keysOf("people")[89] === "dupe_check_2" && keysOf("inboxes")[77] === "dupe_check_2" &&
    Object.keys(keysOf("people")).length === 89 && Object.keys(keysOf("inboxes")).length === 77 && Object.keys(keysOf("companies")).length === 70);
  check("knownPosition: 1..count and the extensions only",
    knownPosition("companies", 1) && knownPosition("companies", 68) && knownPosition("companies", 69) && knownPosition("companies", 70) && !knownPosition("companies", 71) &&
      !knownPosition("companies", 0) && knownPosition("people", 89) && !knownPosition("people", 90) && knownPosition("inboxes", 77) && !knownPosition("inboxes", 78) &&
      !knownPosition("people", 2.5) && !knownPosition("elsewhere", 1));
  check("the overlay positions: P#57 to P#62 and G#45 to G#50; the AI steps P#60, P#61, G#48, G#49",
    same(OVERLAY_POSITIONS, { people: [57, 58, 59, 60, 61, 62], inboxes: [45, 46, 47, 48, 49, 50] }) && same(OVERLAY_AI_POSITIONS, { people: [60, 61], inboxes: [48, 49] }) &&
      same(ORIGINAL_EXTENSIONS, { companies: { 69: "inclusion_keywords_filter", 70: "dupe_check_3" }, people: { 89: "dupe_check_2" }, inboxes: { 77: "dupe_check_2" } }));
  const rows = fixtureRows().map((r) => ({ template_kind: r.template_kind, position: r.position }));
  const at = (kind, ps) => ps.map((position) => ({ template_kind: kind, position }));
  const ext = [...at("companies", [69, 70]), ...at("people", [89]), ...at("inboxes", [77])];
  check("shapeOf: a complete variant, and one with extensions", same(shapeOf(rows), { shape: "complete", kinds: { people: true, inboxes: true } }) && shapeOf([...rows, ...ext]).shape === "complete");
  check("shapeOf: an overlay of People only, General only, or both",
    same(shapeOf(at("people", OVERLAY_POSITIONS.people)), { shape: "overlay", kinds: { people: true, inboxes: false } }) &&
      same(shapeOf(at("inboxes", OVERLAY_POSITIONS.inboxes)), { shape: "overlay", kinds: { people: false, inboxes: true } }) &&
      same(shapeOf([...at("people", OVERLAY_POSITIONS.people), ...at("inboxes", OVERLAY_POSITIONS.inboxes)]), { shape: "overlay", kinds: { people: true, inboxes: true } }));
  check("shapeOf: anything else is partial (five of six, a Companies row, another position, an unknown one, a row twice, nothing)",
    [
      at("people", [57, 58, 59, 60, 61]),
      [...at("people", OVERLAY_POSITIONS.people), ...at("companies", [24])],
      [...at("people", OVERLAY_POSITIONS.people), ...at("people", [56])],
      [...rows, ...at("companies", [71])],
      [...rows.filter((r) => !(r.template_kind === "people" && r.position === 3))],
      [...at("people", OVERLAY_POSITIONS.people), ...at("people", [60])],
      [],
    ].every((x) => shapeOf(x).shape === "partial"));
}

// ── B. Credentials ──────────────────────────────────────────────────────────

/** A made-up HTTP column with a made-up token in its headers. */
const httpColumn = (headers, queryString = null) => ({
  type: "action", id: "f_psH01", name: "Pstest Http Column",
  settings: {
    type: "action", actionKey: "http-api-v2",
    inputsBinding: [
      { name: "url", formulaText: '"https://made-up.pstest.example/api"' },
      { name: "headers", formulaMap: headers, optional: true },
      ...(queryString ? [{ name: "queryString", formulaMap: queryString, optional: true }] : []),
    ],
  },
});

function partB() {
  section("B. Credentials redacted on every load");
  const input = httpColumn({ Authorization: JSON.stringify(`Bearer ${FAKE_TOKEN}`), Accept: '"application/json"' }, { key: JSON.stringify(FAKE_TOKEN), mode: '"power"', email: "{{f_psH02}}" });
  const before = JSON.stringify(input);
  const r = redactCredentials(input);
  const hdr = binding(r.column, "headers").formulaMap;
  const qs = binding(r.column, "queryString").formulaMap;
  check("an Authorization header and a Reoon-shaped key: stored as \"[redacted]\", counted; the rest kept; the input untouched",
    REDACTED === "[redacted]" && hdr.Authorization === REDACTED && qs.key === REDACTED && r.redacted === 2 && hdr.Accept === '"application/json"' &&
      qs.mode === '"power"' && qs.email === "{{f_psH02}}" && JSON.stringify(input) === before && !JSON.stringify(r.column).includes(FAKE_TOKEN) && !r.refused.length,
    JSON.stringify({ redacted: r.redacted, refused: r.refused }));
  const names = redactCredentials(httpColumn({ "X-API-KEY": '"zzfake-a"', api_key: '"zzfake-b"', apiKey: '"zzfake-c"', "access-token": '"zzfake-d"', token: '"zzfake-e"', Secret: '"zzfake-f"', "X-Other": '"kept"' }));
  check("every key name a credential goes by, in any case; another header kept",
    names.redacted === 6 && Object.entries(binding(names.column, "headers").formulaMap).every(([k, v]) => (k === "X-Other" ? v === '"kept"' : v === REDACTED)));
  const readsColumn = redactCredentials(httpColumn({ Authorization: '"Bearer " + {{f_psK01}}' }));
  check("a value that reads a column is no key: kept", binding(readsColumn.column, "headers").formulaMap.Authorization === '"Bearer " + {{f_psK01}}' && readsColumn.redacted === 0 && !readsColumn.refused.length);
  const stuck = redactCredentials(httpColumn({ Authorization: `"Bearer ${FAKE_TOKEN}" + {{f_psK01}}` }));
  check("a long literal beside a column reference can't be redacted: refused, named by binding and key", same(stuck.refused, ["headers.Authorization"]) && stuck.redacted === 0);
  const fx = fixtureSeedExports();
  const untouched = KINDS.every((k) => fx[k].data.every((c) => {
    const x = redactCredentials(c);
    return x.redacted === 0 && JSON.stringify(x.column) === JSON.stringify(c);
  }));
  check("the fixtures already hold \"[redacted]\": not one of their columns changes", untouched);

  const withToken = fixtureSeedExports();
  binding(col(withToken, "companies", 37), "headers").formulaMap.Authorization = JSON.stringify(`Bearer ${FAKE_TOKEN}`);
  const stats = {};
  const rows = originalRows(withToken, { variant: "pstest_b", seededBy: "tests", stats });
  check("originalRows redacts (the exact-layout seed): the token is stored as \"[redacted]\", counted per kind",
    binding(rowOf(rows, "companies", 37).definition, "headers").formulaMap.Authorization === REDACTED && !JSON.stringify(rows).includes(FAKE_TOKEN) &&
      same(stats.redacted, { companies: 1, people: 0, inboxes: 0 }) && binding(col(withToken, "companies", 37), "headers").formulaMap.Authorization.includes(FAKE_TOKEN));
  const stuckExp = fixtureSeedExports();
  binding(col(stuckExp, "people", 48), "headers").formulaMap.Authorization = `"${FAKE_TOKEN}" + {{f_fxP43}}`;
  check("... and refuses a credential it can't redact", /^P#48: a credential could not be redacted/.test(thrown(() => originalRows(stuckExp, { variant: "pstest_b" }))));
  const base = fixtureRows("pstest_b_base");
  const merged = mergeVariant(clientExports({ edit: (e) => (binding(col(e, "people", 48), "headers").formulaMap.Authorization = JSON.stringify(FAKE_TOKEN)) }), base, { variant: "pstest_b", seededBy: "tests" });
  check("mergeVariant redacts (by name): stored \"[redacted]\", counted, nothing refused",
    binding(rowOf(merged.rows, "people", 48).definition, "headers").formulaMap.Authorization === REDACTED && !JSON.stringify(merged.rows).includes(FAKE_TOKEN) &&
      merged.report.redacted.people === 1 && !merged.report.credentials.length);
  const mergedStuck = mergeVariant(clientExports({ edit: (e) => (binding(col(e, "people", 48), "headers").formulaMap.Authorization = `"${FAKE_TOKEN}" + {{f_psP43}}`) }), base, { variant: "pstest_b" });
  check("... and names one it can't redact", same(mergedStuck.report.credentials, ["P#48: a credential could not be redacted"]));
}

// ── C. The refresh ──────────────────────────────────────────────────────────

const TERMS = ["pstest-widget", "pstest-gadget", "pstest-sprocket", "pstest-gizmo", "pstest-doohickey", "pstest-contraption", "pstest-thingamajig", "pstest-whatsit", "pstest-device", `${FIXTURE_MARKER}-incl`];
/** A made-up lookup column, as Clay's duplicate checks are. */
const lookup = (id, key, reads) => ({
  type: "action", id, name: nameOf(key),
  settings: {
    type: "action", actionKey: "lookup-row-in-other-table", actionVersion: 1, dataTypeSettings: { type: "json" },
    inputsBinding: [{ name: "tableId", formulaText: '"t_pstest_older"', optional: false }, { name: "fields|rowValue", formulaText: reads, optional: false }],
    conditionalRunFormulaText: `!!${reads}`,
  },
});

/**
 * The made-up template client's "current" tables: the fixtures (the base's field
 * ids), plus an inclusion keyword filter and a third duplicate check in the middle
 * of Companies, a second duplicate check at position 5 of People and General, and
 * the Master Filter ANDing the filter in.
 */
function currentExports({ edit = null } = {}) {
  const exp = fixtureSeedExports();
  /** @type {Record<string, { sha256: string, data: any[] }>} */
  const out = {};
  for (const k of KINDS) out[k] = { sha256: "", data: structuredClone(exp[k].data) };
  const c = (n) => ref("companies", n);
  const filter = {
    type: "basic", id: "f_psX69", name: nameOf("inclusion_keywords_filter"),
    settings: {
      type: "basic", dataTypeSettings: { type: "boolean" }, formulaType: "formula",
      formulaText: `${JSON.stringify(TERMS)}.some((w) => [${c(5)}, ${c(21)}, ${c(64)}, ${c(65)}].join(" ").toLowerCase().includes(w))`,
    },
  };
  out.companies.data.splice(12, 0, lookup("f_psX70", "dupe_check_3", c(10)));
  out.companies.data.splice(15, 0, filter);
  col(out, "companies", 17).settings.formulaText = `(${c(15)} && ${c(16)} && ${c(14)} && {{f_psX69}}) || Boolean(${c(2)}?.company_name)`;
  out.people.data.splice(4, 0, lookup("f_psX89", "dupe_check_2", ref("people", 7)));
  out.inboxes.data.splice(4, 0, lookup("f_psX77", "dupe_check_2", ref("inboxes", 13)));
  if (edit) edit(out);
  for (const k of KINDS) out[k].sha256 = sha(JSON.stringify(out[k].data));
  return out;
}

/** refreshDefault in a transaction that is always rolled back. */
async function refreshDry(exports, opts = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await refreshDefault(c, { exports, base: BASE, into: NEW, seededBy: "tests", ...opts });
    out.rowsInside = (await c.query(`SELECT count(*)::int AS n FROM enrich_originals WHERE variant = $1`, [opts.into ?? NEW])).rows[0].n;
    return out;
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}
const variantHash = async (v) =>
  one(
    `SELECT count(*)::int AS n, md5(string_agg(concat_ws('|', template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition::text,
            unknown_refs::text, source_sha256, seeded_by, seeded_at::text), '#' ORDER BY template_kind, position)) AS h
       FROM enrich_originals WHERE variant = $1`,
    [v]
  );
const tracksRow = async () => one(`SELECT value::text AS v, updated_by, updated_at::text AS t FROM enrich_settings WHERE key = 'people_tracks'`);

async function partC() {
  section("C. The default refreshed from the template client's current tables");
  const tracksBefore = await tracksRow();
  let backup = null;
  const out = await inTx(pool, (c) => refreshDefault(c, { exports: currentExports(), base: BASE, into: NEW, seededBy: "tests", beforeWrite: (b) => (backup = b) }));
  const stored = await all(`SELECT template_kind, position, key, name, clay_field_id, seeded_by, unknown_refs FROM enrich_originals WHERE variant = $1 ORDER BY template_kind, position`, [NEW]);
  const n = (k) => stored.filter((r) => r.template_kind === k).length;
  check("loaded: 70, 89 and 77 rows, the four extensions placed", out.status === "loaded" && !out.reasons.length && n("companies") === 70 && n("people") === 89 && n("inboxes") === 77 &&
    same(out.extensions, ["C#69", "C#70", "P#89", "G#77"]), JSON.stringify({ status: out.status, reasons: out.reasons, n: KINDS.map(n) }));
  check("C#69, C#70, P#89 and G#77 at their keys with the new columns' ids",
    same(["companies:69", "companies:70", "people:89", "inboxes:77"].map((k) => { const [kind, p] = k.split(":"); const r = rowOf(stored, kind, Number(p)); return [r?.key, r?.clay_field_id]; }),
      [["inclusion_keywords_filter", "f_psX69"], ["dupe_check_3", "f_psX70"], ["dupe_check_2", "f_psX89"], ["dupe_check_2", "f_psX77"]]));
  check("every other column at its canonical position and key, with the base's field id",
    KINDS.every((k) => {
      for (let p = 1; p <= ORIGINAL_COUNTS[k]; p++) {
        const r = rowOf(stored, k, p);
        if (r?.clay_field_id !== fid(k, p) || r.key !== keysOf(k)[p]) return false;
      }
      return true;
    }) && stored.every((r) => r.seeded_by === "tests (refreshed from the template client's current tables)" && !r.unknown_refs.length));
  check("moved columns counted, nothing extra, tracks checked and not stored (another variant than default)",
    out.counts.companies.moved > 0 && out.counts.people.moved > 0 && KINDS.every((k) => out.counts[k].extra === 0) && out.tracks.problems.length === 0 &&
      out.tracks.stored === false && same(await tracksRow(), tracksBefore) && out.compile.ok === true);
  check("the backup handed over before the write: the old rows of the variant (none here), no tracks for a variant other than default",
    backup?.kind === BACKUP_KIND && backup.variant === NEW && Array.isArray(backup.rows) && backup.rows.length === 0 && !("people_tracks" in backup) && out.replaced === 0);
  const originals = await loadOriginals(pool, NEW);
  check("loadOriginals loads a variant with extensions (236 rows), and originalsSummary calls it complete",
    originals.size === 236 && originals.get("companies:69")?.key === "inclusion_keywords_filter" && (await originalsSummary(pool, NEW)).client?.complete === true &&
      (await originalsSummary(pool, NEW)).client?.shape === "complete" && (await originalsSummary(pool, NEW)).client?.total === 236);
  const compiled = compileTemplates(originals);
  const keys = compiled.companies.map((c) => c.key);
  const incl = compiled.companies.find((c) => c.key === "inclusion_keywords_filter");
  const master = compiled.companies.find((c) => c.key === "master_filter");
  check("compiled: the inclusion filter right before the Master Filter, which reads it; it is the client's own terms (client_inclusions), never the template client's list",
    keys.indexOf("inclusion_keywords_filter") === keys.indexOf("master_filter") - 1 && master.formula.includes("{{inclusion_keywords_filter}}") &&
      incl.kind === "action" && incl.action === "client_inclusions" && incl.clay_field_id === "f_psX69" && !incl.formula &&
      ["{{company}}", "{{industry}}", "{{description}}"].every((k) => Object.values(incl.inputs ?? {}).includes(k)) &&
      !JSON.stringify(incl).includes(`${FIXTURE_MARKER}-incl`),
    JSON.stringify({ at: keys.indexOf("inclusion_keywords_filter"), master: master?.formula?.slice(0, 160), incl: { kind: incl?.kind, action: incl?.action, inputs: incl?.inputs } }));
  const baseOriginals = await loadOriginals(pool, BASE);
  const baseCompiled = compileTemplates(baseOriginals);
  check("the base, with no extensions, compiles exactly as the fixtures do (every field, keys sorted: jsonb keeps no key order), with no inclusion filter",
    canon(baseCompiled) === canon(compileTemplates(originalsMap(originalRows(fixtureSeedExports(), { variant: BASE })))) &&
      !baseCompiled.companies.some((c) => c.key === "inclusion_keywords_filter") && !baseCompiled.companies.find((c) => c.key === "master_filter").formula.includes("inclusion"));

  const extra = await refreshDry(currentExports({ edit: (e) => e.people.data.push({ type: "basic", id: "f_psE01", name: "Pstest Extra Column", settings: { type: "basic", dataTypeSettings: { type: "text" } } }) }));
  check("an extra column: listed by name in the report, counted, never stored", extra.status === "loaded" && same(extra.extra.people, ["Pstest Extra Column"]) && extra.counts.people.extra === 1 && extra.rowsInside === 236);
  const token = await refreshDry(currentExports({ edit: (e) => (binding(col(e, "companies", 37), "headers").formulaMap.Authorization = JSON.stringify(`Bearer ${FAKE_TOKEN}`)) }));
  check("a live-looking key in the template client's tables: stored as \"[redacted]\", counted", token.status === "loaded" && token.redacted.companies === 1 && token.rowsInside === 236);
  const missing = await refreshDry(currentExports({ edit: (e) => without(e, "companies", 36) }));
  check("refused: a canonical column missing (nothing written)", missing.status === "refused" && missing.reasons.some((r) => r.check === "missing" && r.text === "The template client's Companies table lacks C#36") && missing.rowsInside === 236, JSON.stringify(missing.reasons));
  const twice = await refreshDry(currentExports({ edit: (e) => e.companies.data.push(lookup("f_psX71", "dupe_check_3", ref("companies", 10))) }));
  check("refused: two columns for one extension", twice.status === "refused" && twice.reasons.some((r) => r.check === "ambiguous" && r.text.startsWith("C#70:")) && twice.rowsInside === 236, JSON.stringify(twice.reasons));
  const type = await refreshDry(currentExports({ edit: (e) => (col(e, "people", 46).settings.actionKey = "pstest-made-up-action") }));
  check("refused: another Clay action at a compiled position", type.status === "refused" && type.reasons.some((r) => r.check === "type" && r.text === "P#46: a pstest-made-up-action where the template needs findymail-find-work-email"), JSON.stringify(type.reasons));
  const noPrompt = await refreshDry(currentExports({ edit: (e) => (col(e, "companies", 24).settings.inputsBinding = col(e, "companies", 24).settings.inputsBinding.filter((b) => b.name !== "prompt")) }));
  check("refused: the templates do not compile from it, with the first line", noPrompt.status === "refused" && noPrompt.reasons.some((r) => r.check === "compile" && r.text === "companys_website: C#24 has no prompt"), JSON.stringify(noPrompt.reasons));
  const intoDefault = await refreshDry(currentExports(), { into: "default" });
  check("refused: the default over any base but itself", intoDefault.status === "refused" && intoDefault.reasons[0]?.check === "variant" && intoDefault.rowsInside === 232, JSON.stringify(intoDefault.reasons));
  const noBase = await refreshDry(currentExports(), { base: `pstest_nobase_${RUN}` });
  check("refused: a base that is not loaded", noBase.status === "refused" && noBase.reasons[0]?.check === "base" && /is not loaded|not loaded/.test(noBase.reasons[0]?.text ?? ""), JSON.stringify(noBase.reasons));
}

// ── D. Overlays ─────────────────────────────────────────────────────────────

/** seedPersonalisation in a transaction that is always rolled back. */
async function overlayDry(exports, variant, { keepRows = false, ...opts } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await seedPersonalisation(c, { exports, variant, seededBy: "tests", base: BASE, ...opts });
    out.rowsInside = (await c.query(`SELECT template_kind, position FROM enrich_originals WHERE variant = $1`, [variant])).rows;
    if (keepRows) out.storedRows = (await c.query(`SELECT template_kind, position, definition FROM enrich_originals WHERE variant = $1`, [variant])).rows;
    return out;
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}
const statusOf = (out) => [out.kinds?.people?.status, out.kinds?.inboxes?.status].join("/");
const checksIn = (out, kind) => (out.kinds?.[kind]?.checks ?? []).map((x) => x.check);
const textOf = (cols, key) => cols.find((c) => c.key === key);
const tableCols = async (tag, kind) => all(`SELECT c.key, c.config, c.inputs FROM enrich_columns c JOIN enrich_tables t ON t.id = c.table_id WHERE t.client_tag = $1 AND t.kind = $2`, [tag, kind]);

async function partD() {
  section("D. Personalisation overlays");
  const ownBoth = () => clientExports({ edit: (e) => (ownText(e, "people", 60), ownText(e, "inboxes", 48)) });
  const o1 = await inTx(pool, (c) => seedPersonalisation(c, { exports: ownBoth(), variant: "pstest_o1", seededBy: "tests", base: BASE }));
  const rows = await all(`SELECT template_kind, position, key, name, clay_field_id, definition, seeded_by FROM enrich_originals WHERE variant = 'pstest_o1' ORDER BY template_kind, position`);
  check("a client whose personalisation maps: loaded, 12 rows (P#57 to P#62, G#45 to G#50), both tables its own",
    o1.status === "loaded" && o1.stored === 12 && statusOf(o1) === "own/own" && rows.length === 12 &&
      same(rows.map((r) => `${r.template_kind}:${r.position}`), [...OVERLAY_POSITIONS.inboxes.map((p) => `inboxes:${p}`), ...OVERLAY_POSITIONS.people.map((p) => `people:${p}`)]),
    JSON.stringify({ status: o1.status, kinds: o1.kinds }));
  check("... their field ids re-pointed to the base's (the rows and every reference), names the client's, seeded_by noting it",
    rows.every((r) => r.clay_field_id === fid(r.template_kind, r.position) && r.definition.id === r.clay_field_id && r.seeded_by === "tests (personalisation)" && r.name === nameOf(r.key)) &&
      !JSON.stringify(rows.map((r) => r.definition)).includes("f_ps"));
  const p61 = rowOf(rows, "people", 61);
  const examples = JSON.parse(binding(p61.definition, "tableExamples").formulaText);
  check("... the table examples' keys re-pointed too", Object.keys(examples[0].inputs).every((k) => /^\{\{f_fxP\d\d\}\}/.test(k)), JSON.stringify(Object.keys(examples[0].inputs)));
  check("variantFor picks the overlay", (await variantFor(pool, "PSTEST_O1")) === "pstest_o1");
  const composed = await loadOriginals(pool, "pstest_o1", { base: BASE });
  check("loadOriginals composes it with the base: 232 rows, the overlay's in their places, the base's carrying text_variant default",
    composed.size === 232 && composed.get("people:60").variant === "pstest_o1" && !("text_variant" in composed.get("people:60")) &&
      composed.get("companies:24").text_variant === "default" && composed.get("people:59").variant === "pstest_o1" && composed.get("people:56").text_variant === "default");
  let missingBase = null;
  try {
    await loadOriginals(pool, "pstest_o1", { base: `pstest_nobase_${RUN}` });
  } catch (e) {
    missingBase = e;
  }
  check("... and an overlay over a base not loaded: OriginalsMissing for the base", missingBase instanceof OriginalsMissing && missingBase.variant === `pstest_nobase_${RUN}`);
  const summary = await originalsSummary(pool, "pstest_o1");
  check("originalsSummary: the client's overlay, complete while the default is", summary.client?.shape === "overlay" && summary.client.total === 12 && summary.client.complete === summary.default.complete);
  const made = await inTx(pool, (c) => ensurePipelineTables(c, "PSTEST_O1", { base: BASE }));
  const tables = await all(`SELECT kind, source_note FROM enrich_tables WHERE client_tag = 'PSTEST_O1' ORDER BY kind`);
  const people = await tableCols("PSTEST_O1", "people");
  const inboxes = await tableCols("PSTEST_O1", "inboxes");
  check("ensurePipelineTables compiles from it, noted (variant pstest_o1), no fallback",
    made.variant === "pstest_o1" && made.own_variant === "pstest_o1" && made.fallback === null && tables.length === 3 && tables.every((t) => variantOfNote(t.source_note) === "pstest_o1"),
    JSON.stringify({ variant: made.variant, fallback: made.fallback }));
  check("... the client's own research text in both tables, the base's text everywhere else",
    String(textOf(people, "claygent")?.inputs?.prompt ?? "").includes("made-up business does, in one line") && String(textOf(inboxes, "claygent")?.inputs?.prompt ?? "").includes("made-up business does, in one line") &&
      String(textOf(await tableCols("PSTEST_O1", "companies"), "companys_website")?.inputs?.prompt ?? "").includes(`${FIXTURE_MARKER}-c24`));
  check("... each personalisation column's text_variant the client's",
    ["email_domain", "email_provider_check_api", "claygent", "question_ai", "question"].every((k) => textOf(people, k)?.config?.text_variant === "pstest_o1") &&
      ["email_domain", "email_host_lookup_google_dns", "claygent", "question_ai", "question"].every((k) => textOf(inboxes, k)?.config?.text_variant === "pstest_o1"));
  const qa = textOf(people, "question_ai")?.config;
  check("... and its examples laid out with the base's column names", typeof qa?.examples_text === "string" && qa.examples_text.includes('"Company":"Made-up Widget Shop"') && qa.examples_text.includes('"Title":"Owner"') && !qa.examples_text.includes("f_"), String(qa?.examples_text ?? qa?.examples_error).slice(0, 300));

  const o2 = await inTx(pool, (c) => seedPersonalisation(c, { exports: clientExports({ edit: (e) => (ownText(e, "people", 60), without(e, "inboxes", 48)) }), variant: "pstest_o2", seededBy: "tests", base: BASE }));
  check("People only: General has no research step of its own, so it runs the default's (no_steps); 6 rows stored",
    o2.stored === 6 && statusOf(o2) === "own/base" && checksIn(o2, "inboxes").includes("no_steps") && shapeOf(await all(`SELECT template_kind, position FROM enrich_originals WHERE variant = 'pstest_o2'`)).kinds.inboxes === false,
    JSON.stringify(o2.kinds));
  await inTx(pool, (c) => ensurePipelineTables(c, "PSTEST_O2", { base: BASE }));
  check("... compiled: People's personalisation steps run the client's text, General's the default's (text_variant default)",
    textOf(await tableCols("PSTEST_O2", "people"), "question_ai")?.config?.text_variant === "pstest_o2" && textOf(await tableCols("PSTEST_O2", "inboxes"), "question_ai")?.config?.text_variant === "default" &&
      textOf(await tableCols("PSTEST_O2", "inboxes"), "claygent")?.config?.text_variant === "default");

  const o3 = await overlayDry(clientExports({
    edit: (e) => {
      e.people.data.push({ type: "basic", id: "f_psX60", name: "Pstest Company Link", settings: { type: "basic", dataTypeSettings: { type: "url" } } });
      const b = binding(col(e, "people", 60), "prompt");
      b.formulaText = b.formulaText.replace(`"; Summarise`, `"; link=" + {{f_psX60}} + "; Summarise`);
      ownText(e, "inboxes", 48);
    },
  }), "pstest_o3");
  check("P#60 reads a column the base does not have: People on the default's (unmapped_column), General its own",
    statusOf(o3) === "base/own" && o3.kinds.people.checks.some((x) => x.check === "unmapped_column" && x.text === "P#60 reads Pstest Company Link (People), which the default's tables do not have") &&
      o3.stored === 6 && o3.rowsInside.every((r) => r.template_kind === "inboxes"),
    JSON.stringify(o3.kinds.people));
  // The company LinkedIn and Facebook link columns are not read (the owner's rule, 2026-11-24): the clause that names
  // one leaves the prompt, any other read becomes "", and the client keeps its own steps.
  const linkCols = (e) => {
    e.people.data.push(
      { type: "basic", id: "f_psLI", name: "Company LinkedIn Link", settings: { type: "basic", dataTypeSettings: { type: "url" } } },
      { type: "basic", id: "f_psFB", name: " company  facebook link ", settings: { type: "basic", dataTypeSettings: { type: "url" } } }
    );
    e.inboxes.data.push({ type: "basic", id: "f_psLU", name: "Company LinkedIn URL", settings: { type: "basic", dataTypeSettings: { type: "url" } } });
  };
  const ownBothText = (e) => (ownText(e, "people", 60), ownText(e, "inboxes", 48));
  const linkEdit = (e) => {
    linkCols(e);
    const p = binding(col(e, "people", 60), "prompt");
    p.formulaText = p.formulaText.replace(`"; Summarise`, `" and the Facebook page at " + {{f_psFB}} + " and the LinkedIn page at " + Clay.formatForAIPrompt({{f_psLI}}) + "; Summarise`);
    const g = binding(col(e, "inboxes", 48), "prompt");
    g.formulaText = g.formulaText.replace(`"; Summarise`, `"; li=" + {{f_psLU}} + "; Summarise`);
    ownBothText(e);
  };
  const o3b = await overlayDry(clientExports({ edit: linkEdit }), "pstest_o3b", { keepRows: true });
  const plain = await overlayDry(clientExports({ edit: ownBothText }), "pstest_o3c", { keepRows: true });
  const promptOf = (out, kind, position) => {
    const d = out.storedRows?.find((r) => r.template_kind === kind && r.position === position)?.definition;
    return d ? binding(d, "prompt")?.formulaText ?? null : null;
  };
  check("the company LinkedIn and Facebook link columns: both tables keep the client's own steps, the prompts no longer read them",
    statusOf(o3b) === "own/own" && same(o3b.kinds.people.unread, ["P#60"]) && same(o3b.kinds.inboxes.unread, ["G#48"]) && o3b.stored === 12 &&
      !o3b.kinds.people.checks.length && !o3b.kinds.inboxes.checks.length && same(plain.kinds.people.unread, []),
    JSON.stringify({ people: o3b.kinds.people, inboxes: o3b.kinds.inboxes }));
  const p60 = promptOf(o3b, "people", 60);
  check("... P#60: both clauses gone (the formatted read too), so its prompt is the client's own text word for word",
    typeof p60 === "string" && p60 === promptOf(plain, "people", 60) && !/page at|f_psLI|f_psFB/.test(p60), String(p60).slice(0, 300));
  const g48 = promptOf(o3b, "inboxes", 48);
  check("... G#48: a read in no such clause is an empty value",
    typeof g48 === "string" && g48 === String(promptOf(plain, "inboxes", 48)).replace(`"; Summarise`, `"; li=" + "" + "; Summarise`) && !g48.includes("f_psLU"), String(g48).slice(0, 300));
  const o3d = await overlayDry(clientExports({
    edit: (e) => {
      linkCols(e);
      col(e, "people", 60).settings.conditionalRunFormulaText = "!!{{f_psLI}}";
      ownBothText(e);
    },
  }), "pstest_o3d");
  check("... but a link column read anywhere else (here P#60's run condition) still keeps People on the default's (unmapped_column)",
    statusOf(o3d) === "base/own" && o3d.kinds.people.checks.some((x) => x.check === "unmapped_column" && x.text === "P#60 reads Company LinkedIn Link (People), which the default's tables do not have") &&
      same(o3d.kinds.people.unread, []),
    JSON.stringify(o3d.kinds.people));
  const o4 = await overlayDry(clientExports({ edit: (e) => (without(e, "people", 61), ownText(e, "inboxes", 48)) }), "pstest_o4");
  check("no P#61: People on the default's (no_steps)", statusOf(o4) === "base/own" && o4.kinds.people.checks.some((x) => x.check === "no_steps" && x.from === "P#61"), JSON.stringify(o4.kinds.people));
  const o5 = await overlayDry(clientExports({ edit: (e) => (col(e, "people", 58).settings.actionKey = "pstest-made-up-action", ownText(e, "people", 60)) }), "pstest_o5");
  check("P#58 of another Clay action: People on the default's (type)", o5.kinds.people.status === "base" && o5.kinds.people.checks.some((x) => x.check === "type" && x.text === "P#58: a pstest-made-up-action where the default's is http-api-v2"), JSON.stringify(o5.kinds.people));
  const o6 = await overlayDry(clientExports({ relabel: false, edit: (e) => (col(e, "people", 62).name = "Pstest Opener", ownText(e, "people", 60)) }), "pstest_o6");
  check("a renamed column found by its field id: mapped, listed as renamed, its own name kept",
    o6.kinds.people.status === "own" && same(o6.kinds.people.renamed, ["P#62"]) && o6.report.kinds.people.columns.find((x) => x.from === "P#62")?.name === "Pstest Opener", JSON.stringify(o6.kinds.people));
  const o7 = await overlayDry(clientExports(), "pstest_o7");
  check("identical to the base (once re-pointed): the same as the default's in both tables, nothing stored", statusOf(o7) === "same/same" && o7.stored === 0 && o7.rowsInside.length === 0);
  const o8 = await overlayDry(clientExports({ edit: (e) => (binding(col(e, "people", 61), "tableExamples").formulaText = "{not json", ownText(e, "inboxes", 48)) }), "pstest_o8");
  check("examples that can't be read: People on the default's (examples)", statusOf(o8) === "base/own" && o8.kinds.people.checks.some((x) => x.check === "examples" && /not JSON/.test(x.text)), JSON.stringify(o8.kinds.people));
  const o10 = await overlayDry(clientExports({
    edit: (e) => {
      col(e, "people", 60).settings.inputsBinding = col(e, "people", 60).settings.inputsBinding.filter((b) => b.name !== "prompt");
      ownText(e, "inboxes", 48);
    },
  }), "pstest_o10");
  check("People that do not compile: on the default's (compile, its first line); General compiled alone, its own",
    statusOf(o10) === "base/own" && o10.kinds.people.checks.some((x) => x.check === "compile" && x.text === "claygent: P#60 has no prompt") && typeof o10.report.compile.together === "string",
    JSON.stringify({ people: o10.kinds.people, compile: o10.report.compile }));
  const notRead = await overlayDry({ companies: null, people: null, inboxes: null }, "pstest_o11");
  check("no People and no General export: not read, nothing written", notRead.status === "not_read" && statusOf(notRead) === "not_read/not_read" && notRead.rowsInside.length === 0);
  const overNew = await overlayDry(ownBoth(), "pstest_o12", { base: NEW });
  check("over a base with extensions (the refreshed variant): own in both tables", overNew.status === "loaded" && statusOf(overNew) === "own/own" && overNew.stored === 12, JSON.stringify(overNew.kinds));

  await inTx(pool, (c) => seedOriginals(c, { exports: fixtureSeedExports(), variant: "pstest_o9", seededBy: "tests" }));
  const o9 = await inTx(pool, (c) => seedPersonalisation(c, { exports: ownBoth(), variant: "pstest_o9", seededBy: "tests", base: BASE }));
  check("an earlier complete variant of the client is replaced by its overlay", o9.replaced === 232 && o9.stored === 12 && shapeOf(await all(`SELECT template_kind, position FROM enrich_originals WHERE variant = 'pstest_o9'`)).shape === "overlay");
  const def = await overlayDry(ownBoth(), "default");
  const onBase = await overlayDry(ownBoth(), BASE);
  check("refused: default, and the base itself (nothing read or written)", def.status === "refused" && def.reasons[0].check === "variant" && onBase.status === "refused" && onBase.rowsInside.length === 232);
  const pure = personalisationOverlay(ownBoth(), [...(await loadOriginals(pool, BASE)).values()], { variant: "pstest_pure" });
  check("personalisationOverlay is pure: the same rows and results without a database", pure.rows.length === 12 && statusOf(pure) === "own/own" && pure.rows.every((r) => r.variant === "pstest_pure"));

  // The fallback: an overlay that reads a base id that is gone (as after a refresh that renamed field ids).
  await pool.query(
    `UPDATE enrich_originals SET definition = replace(definition::text, '{{f_fxP28}}', '{{f_fxGONE}}')::jsonb WHERE variant = 'pstest_o1' AND template_kind = 'people' AND position = 61`
  );
  const defaultReady = (await originalsSummary(pool)).default.complete;
  let fell = null;
  let fellErr = null;
  try {
    fell = await inTx(pool, (c) => ensurePipelineTables(c, "PSTEST_O1", { base: BASE }));
  } catch (e) {
    fellErr = e;
  }
  const notes = await all(`SELECT kind, source_note FROM enrich_tables WHERE client_tag = 'PSTEST_O1' ORDER BY kind`);
  check("an overlay whose base id is gone: the tables compile from default, and say why (needs the local default originals)",
    defaultReady && !fellErr && fell.variant === "default" && fell.own_variant === "pstest_o1" && /^question_ai \(P#61\) reads 1 column\(s\) this template does not map: f_fxGONE/.test(fell.fallback ?? "") &&
      notes.every((x) => variantOfNote(x.source_note) === "default" && x.source_note.includes("the client's own variant pstest_o1 did not compile")),
    JSON.stringify({ defaultReady, err: fellErr?.message, variant: fell?.variant, fallback: fell?.fallback }));
}

// ── E. The seed script ──────────────────────────────────────────────────────

const seedScript = fileURLToPath(new URL("./enrich-seed-originals.mjs", import.meta.url));
let tmp = null;
function cli(args) {
  const r = spawnSync(process.execPath, [seedScript, ...args], { env: { PATH: process.env.PATH, DATABASE_URL: url }, encoding: "utf8", timeout: 180_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}
/** Three export files, as the Clay CLI writes them. */
function writeExports(dir, exp) {
  mkdirSync(dir, { recursive: true });
  /** @type {Record<string, string>} */
  const files = {};
  for (const k of KINDS) {
    if (!exp[k]) continue;
    files[k] = path.join(dir, `${k}.json`);
    writeFileSync(files[k], fixtureText({ workspace: { id: 0, name: "Made-up workspace for the tests" }, data: exp[k].data }));
  }
  return files;
}
const fileArgs = (files) => KINDS.flatMap((k) => [`--${k}`, files[k]]);
const modeOf = (file) => statSync(file).mode & 0o777;

async function partE() {
  section("E. The seed script");
  tmp = mkdtempSync(path.join(os.tmpdir(), "test-personalisation-originals-"));
  const cur = writeExports(path.join(tmp, "current"), currentExports());
  const CLI = `pstest_cli_${RUN}`;
  await inTx(pool, (c) => seedOriginals(c, { exports: fixtureSeedExports(), variant: CLI, seededBy: "tests" }));
  const before = await variantHash(CLI);
  const tracksBefore = await tracksRow();

  const noBackup = cli(["--refresh-default", ...fileArgs(cur), "--into", CLI, "--base", BASE]);
  check("--refresh-default without --backup (and without --dry): refused, nothing written", noBackup.code === 1 && /--backup <file> is required/.test(noBackup.out) && same(await variantHash(CLI), before), noBackup.out.slice(0, 300));
  const inRepo = cli(["--refresh-default", ...fileArgs(cur), "--into", CLI, "--base", BASE, "--backup", path.join(ROOT, "scripts", "pstest-backup.json")]);
  check("--backup inside the repo: refused, nothing written", inRepo.code === 1 && /inside this repo/.test(inRepo.out) && !existsSync(path.join(ROOT, "scripts", "pstest-backup.json")) && same(await variantHash(CLI), before));
  const dry = cli(["--refresh-default", ...fileArgs(cur), "--into", CLI, "--base", BASE, "--dry"]);
  check("--dry: would refresh, the counts in one line, nothing kept",
    dry.code === 0 && dry.stdout.startsWith(`${CLI}: would refresh; companies 70 (68 + C#69, C#70), people 89 (88 + P#89), general 77 (76 + G#77); moved `) &&
      /, extra 0 \(not stored\); credentials redacted 0; compile ok; tracks operations \d+->3, facility_office \d+->3, ceo \d+->3; models differing \d+ \(settings unchanged\)/.test(dry.stdout) &&
      same(await variantHash(CLI), before),
    dry.out.slice(0, 600));
  const backupFile = path.join(tmp, "backup.json");
  const real = cli(["--refresh-default", ...fileArgs(cur), "--into", CLI, "--base", BASE, "--backup", backupFile]);
  const backup = existsSync(backupFile) ? JSON.parse(readFileSync(backupFile, "utf8")) : null;
  check("a real refresh: refreshed, the backup written first (mode 0600) with the old 232 rows, the variant now 236 rows",
    real.code === 0 && real.stdout.startsWith(`${CLI}: refreshed; `) && backup?.kind === BACKUP_KIND && backup.variant === CLI && backup.rows.length === 232 && modeOf(backupFile) === 0o600 &&
      (await variantHash(CLI)).n === 236 && same(await tracksRow(), tracksBefore),
    real.out.slice(0, 400));
  const again = cli(["--refresh-default", ...fileArgs(cur), "--into", CLI, "--base", BASE, "--backup", backupFile]);
  check("--backup naming a file that exists: refused, the older backup kept", again.code === 1 && /exists/.test(again.out) && JSON.parse(readFileSync(backupFile, "utf8")).rows.length === 232);
  const restoreDry = cli(["--restore-default", backupFile, "--dry"]);
  check("--restore-default --dry: would restore, nothing kept", restoreDry.code === 0 && restoreDry.stdout.startsWith(`Would restore variant ${CLI}: 232 rows (236 replaced); people tracks not touched`) && (await variantHash(CLI)).n === 236, restoreDry.out.slice(0, 300));
  const restored = cli(["--restore-default", backupFile]);
  check("--restore-default puts the rows back exactly (every column, the seeding time included)", restored.code === 0 && same(await variantHash(CLI), before), restored.out.slice(0, 300));
  const notBackup = path.join(tmp, "not-a-backup.json");
  writeFileSync(notBackup, JSON.stringify({ variant: CLI, rows: [] }));
  const bad = cli(["--restore-default", notBackup]);
  check("a file that is no backup: refused, nothing changed", bad.code === 1 && /Not a backup/.test(bad.out) && same(await variantHash(CLI), before));

  // The default and its people tracks put back by restoreBackup, inside a transaction rolled back (nothing is kept).
  const defaultNow = await variantHash("default");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const rows = (await c.query(`SELECT variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition::text AS definition, unknown_refs, source_sha256, seeded_by, seeded_at::text AS seeded_at FROM enrich_originals WHERE variant = 'default' ORDER BY template_kind, position`)).rows;
    const t = (await c.query(`SELECT value::text AS value, updated_by, updated_at::text AS updated_at FROM enrich_settings WHERE key = 'people_tracks'`)).rows[0] ?? null;
    await c.query(`UPDATE enrich_originals SET name = name || ' (changed)' WHERE variant = 'default'`);
    if (t) await c.query(`UPDATE enrich_settings SET value = '{}'::jsonb WHERE key = 'people_tracks'`);
    const out = await restoreBackup(c, { kind: BACKUP_KIND, at: "", variant: "default", rows, people_tracks: t });
    const after = (await c.query(`SELECT count(*)::int AS n, md5(string_agg(concat_ws('|', template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition::text, unknown_refs::text, source_sha256, seeded_by, seeded_at::text), '#' ORDER BY template_kind, position)) AS h FROM enrich_originals WHERE variant = 'default'`)).rows[0];
    const tAfter = (await c.query(`SELECT value::text AS value, updated_by, updated_at::text AS updated_at FROM enrich_settings WHERE key = 'people_tracks'`)).rows[0] ?? null;
    check("restoreBackup puts the default and the stored people tracks back exactly (their updated_at too), in a transaction rolled back",
      same(after, defaultNow) && same(tAfter, t) && out.tracks === (t ? "restored" : "removed") && out.rows === rows.length);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
  check("... and the local default is as it was", same(await variantHash("default"), defaultNow));

  const good = writeExports(path.join(tmp, "pstest_p1"), clientExports({ edit: (e) => (ownText(e, "people", 60), ownText(e, "inboxes", 48)) }));
  const unmapped = writeExports(path.join(tmp, "pstest_p4"), clientExports({
    edit: (e) => {
      e.people.data.push({ type: "basic", id: "f_psX60", name: "Pstest Company Link", settings: { type: "basic", dataTypeSettings: { type: "url" } } });
      const b = binding(col(e, "people", 60), "prompt");
      b.formulaText = b.formulaText.replace(`"; Summarise`, `"; link=" + {{f_psX60}} + "; Summarise`);
    },
  }));
  const planFile = path.join(tmp, "plan.json");
  writeFileSync(planFile, JSON.stringify([
    { tag: "PSTEST_P1", companies: null, people: good.people, inboxes: good.inboxes },
    { tag: "PSTEST_P2", variant: "default", companies: null, people: good.people, inboxes: good.inboxes },
    { tag: "PSTEST_P3", companies: null, people: null, inboxes: null, not_read: { people: "not read here (workspace 2)", inboxes: "not read here (workspace 2)" } },
    { tag: "PSTEST_P4", companies: null, people: unmapped.people, inboxes: unmapped.inboxes },
  ]));
  const reportFile = path.join(tmp, "report.json");
  const plan = cli(["--personalisation", "--plan", planFile, "--base", BASE, "--report", reportFile]);
  const lines = plan.stdout.split("\n");
  check("--personalisation --plan: a line per client (own, refused, not read, the default's), then the totals",
    plan.code === 0 && lines.includes("PSTEST_P1 variant pstest_p1: people own (filled 0); general own (filled 0)") && lines.includes("PSTEST_P2 variant default: refused (variant)") &&
      lines.includes("PSTEST_P3 variant pstest_p3: not read") && lines.includes("PSTEST_P4 variant pstest_p4: people the default's (unmapped_column); general same as the default's") &&
      lines.includes("4 clients: own personalisation in both tables 1, People only 0, General only 0; the default's in both 1 (by check: unmapped_column 1, no_steps 0, type 0, compile 0, examples 0); same as the default's 0; not read 1; refused 1") &&
      lines.includes("Tables: people own 1, the default's 1 (unmapped_column 1), same 0, not read 1; general own 1, the default's 0, same 1, not read 1"),
    plan.out.slice(0, 1200));
  check("... stored: 12 rows for the client of its own, none for the others",
    (await one(`SELECT count(*)::int AS n FROM enrich_originals WHERE variant = 'pstest_p1'`)).n === 12 && (await one(`SELECT count(*)::int AS n FROM enrich_originals WHERE variant = ANY($1::text[])`, [["pstest_p3", "pstest_p4"]])).n === 0);
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
  check("--report: the full JSON (names and reasons), mode 0600",
    modeOf(reportFile) === 0o600 && report?.clients?.find((x) => x.tag === "PSTEST_P4")?.kinds?.people?.checks?.some((x) => x.text.includes("Pstest Company Link")));
  check("stdout holds no column name, prompt or list", ![plan.out, dry.out, real.out].some((o) => o.includes("Pstest Company Link") || o.includes(FIXTURE_MARKER) || o.includes("Summarise") || o.includes(nameOf("inclusion_keywords_filter"))));
  const reportInRepo = cli(["--personalisation", "--plan", planFile, "--base", BASE, "--report", path.join(ROOT, "scripts", "pstest-report.json")]);
  check("--report inside the repo: refused before anything is read", reportInRepo.code === 1 && /inside this repo/.test(reportInRepo.out) && !existsSync(path.join(ROOT, "scripts", "pstest-report.json")));
  await pool.query(`DELETE FROM enrich_originals WHERE variant = 'pstest_p1'`);
  const combined = cli(["--refresh-default", ...fileArgs(cur), "--into", CLI, "--base", BASE, "--personalisation", "--plan", planFile, "--dry"]);
  const cl = combined.stdout.split("\n");
  check("--refresh-default with --personalisation --plan and --dry: the refresh, then each client over it, all in one transaction rolled back",
    combined.code === 0 && cl[0].startsWith(`${CLI}: would refresh; companies 70`) && cl.includes("PSTEST_P1 variant pstest_p1: people own (filled 0); general own (filled 0)") &&
      /dry run, nothing kept/.test(combined.stdout) && same(await variantHash(CLI), before) && (await one(`SELECT count(*)::int AS n FROM enrich_originals WHERE variant = 'pstest_p1'`)).n === 0,
    combined.out.slice(0, 800));
  const single = cli(["--personalisation", "--variant", "pstest_p5", "--people", good.people, "--inboxes", good.inboxes, "--base", BASE, "--dry"]);
  check("--personalisation --variant: one client, dry", single.code === 0 && single.stdout.startsWith("client variant pstest_p5: people own (filled 0); general own (filled 0)") && (await one(`SELECT count(*)::int AS n FROM enrich_originals WHERE variant = 'pstest_p5'`)).n === 0, single.out.slice(0, 300));
  const noBase = cli(["--personalisation", "--plan", planFile, "--base", `pstest_nobase_${RUN}`, "--dry"]);
  check("a base that is not loaded stops the run", noBase.code === 1 && /is not loaded/.test(noBase.out), noBase.out.slice(0, 300));
}

// ── F. G#19 read as empty; the personalisation switch ───────────────────────

/** The General columns G#19 and G#20 need, worked in memory as the worker would (forced: nothing reused). */
async function g19Row(columns, { env, inputs }) {
  const cells = new Map();
  const before = net.calls.openai;
  const out = await runRow({
    row: { id: 0, created_at: new Date().toISOString(), run_force: ["*"], next_run_at: new Date() },
    table: { id: null, client_tag: "PSTEST_F", template: "inboxes_v1", variant: "default", keyCounts: {} },
    columns, cells: new Map(Object.entries(inputs).map(([k, v]) => [k, { status: "done", value: v }])), env, db: null, settings: settingsFrom([]),
    hooks: { changed: (k, c) => cells.set(k, c) },
  });
  return { ...out, cell: (k) => cells.get(k), sent: net.calls.openai - before };
}

async function partF() {
  section("F. G#19 read as empty when it fails, as in Clay");
  const compiled = compileTemplates(originalsMap(fixtureRows()));
  const g19 = compiled.inboxes.find((c) => c.key === "first_name_ai");
  const withOnError = Object.values(compiled).flat().filter((c) => "on_error" in (c.config ?? {}));
  check("the compiled G#19 carries on_error \"empty\", and no other column does", g19.config.on_error === "empty" && withOnError.length === 1 && withOnError[0].key === "first_name_ai");
  check("its note and G#20's say so", /G#20 falls to "<Company> Team", as in Clay/.test(g19.description) && /"<Company> Team", when G#19 gives no usable first name or fails/.test(compiled.inboxes.find((c) => c.key === "use_first_name").description));
  const pick = (keys) => keys.map((k) => compiled.inboxes.find((c) => c.key === k));
  const inputs = [
    { key: "general_email", kind: "input", phase: 1 }, { key: "company", kind: "input", phase: 1 }, { key: "email_valid", kind: "input", phase: 1 }, { key: "guessed_name", kind: "input", phase: 1 },
  ].map((c) => ({ ...c, name: c.key, config: {} }));
  const columns = [...inputs, ...pick(["normalize_company_name", "normalized_company_name", "first_name_ai", "use_first_name"])];
  const values = { general_email: "jordan.lee@widgetco.pstest.example", company: "Pstest Widget Cleaning LLC", email_valid: true, guessed_name: "Jordan Lee" };
  const env = { OPENAI_API_KEY: "made-up-pstest-openai" };
  const teamOf = (r) => `${String(r.cell("normalized_company_name")?.value ?? "").replace(/\b(LLC|Inc\.)\b/gi, "").trim()} Team`;

  net.openaiFail = [400];
  const r400 = await g19Row(columns, { env, inputs: values });
  check("G#19 answered a 400 (not retryable): its cell an error noted as read as empty, G#20 \"<Normalized> Team\", no error counted, the row not tried again",
    r400.sent === 1 && r400.cell("first_name_ai")?.status === "error" && String(r400.cell("first_name_ai")?.note ?? "").endsWith(READ_AS_EMPTY) &&
      r400.cell("use_first_name")?.status === "done" && r400.cell("use_first_name")?.value === teamOf(r400) && teamOf(r400) !== " Team" && r400.errors === 0 && !r400.retryable,
    JSON.stringify({ g19: r400.cell("first_name_ai"), g20: r400.cell("use_first_name"), errors: r400.errors, retryable: r400.retryable }));
  net.openaiFail = [500];
  const r500 = await g19Row(columns, { env, inputs: values });
  check("a 500: the same, and the row is tried again (retryable), no error counted",
    r500.cell("first_name_ai")?.status === "error" && r500.cell("use_first_name")?.value === teamOf(r500) && r500.errors === 0 && typeof r500.retryable === "string" && /first name ai/i.test(r500.retryable),
    JSON.stringify({ errors: r500.errors, retryable: r500.retryable }));
  net.openaiFail = [];
  const noKey = await g19Row(columns, { env: {}, inputs: values });
  check("no OpenAI key: G#19 waits as before, and so does G#20", noKey.sent === 0 && noKey.cell("first_name_ai")?.status === "needs_key" && noKey.needsKey > 0 && noKey.cell("use_first_name")?.status === "needs_key" && noKey.errors === 0);
  const strict = columns.map((c) => (c.key === "first_name_ai" ? { ...c, config: Object.fromEntries(Object.entries(c.config).filter(([k]) => k !== "on_error")) } : c));
  net.openaiFail = [400];
  const control = await g19Row(strict, { env, inputs: values });
  check("without on_error (a column compiled before this), a failure still fails the row as before",
    control.cell("first_name_ai")?.status === "error" && !String(control.cell("first_name_ai")?.note ?? "").endsWith(READ_AS_EMPTY) && control.cell("use_first_name")?.status === "error" && control.errors === 2,
    JSON.stringify({ g20: control.cell("use_first_name"), errors: control.errors }));
  net.openaiFail = [];

  section("F2. The personalisation switch reads the column's text_variant");
  const pers = (sharedOk) => settingsFrom([{ key: "personalisation", value: { enabled: true, tags: ["PSTEST_E"], shared_text_ok: sharedOk } }]);
  const tiny = (key, textVariant) => ({ key, name: key, kind: "formula", formula: '"made up"', phase: 1, config: { flag: ["personalisation"], ...(textVariant ? { text_variant: textVariant } : {}) } });
  const work = async (variant, settings) => {
    const cells = new Map();
    await runRow({
      row: { id: 0, created_at: new Date().toISOString() }, table: { client_tag: "PSTEST_E", template: "people_v1", variant, keyCounts: {} },
      columns: [tiny("on_default", "default"), tiny("on_own", "pstest_e"), tiny("on_table", null)], cells: new Map(), env: {}, db: null, settings, hooks: { changed: (k, c) => cells.set(k, c) },
    });
    return (k) => cells.get(k)?.status;
  };
  const own = await work("pstest_e", pers(false));
  check("the client's own text runs, the default's text is switched off (no shared_text_ok), an old column reads the table's variant",
    own("on_own") === "done" && own("on_default") === "skipped" && own("on_table") === "done");
  const shared = await work("pstest_e", pers(true));
  const onDefault = await work("default", pers(false));
  check("... with shared_text_ok the default's text runs too; a table on default runs neither old nor default columns",
    shared("on_default") === "done" && onDefault("on_table") === "skipped" && onDefault("on_default") === "skipped" && onDefault("on_own") === "done");
}

// ── G. The Clay grid ────────────────────────────────────────────────────────

function partG() {
  section("G. The Clay grid shows AI Ark pull tables' find_email as built (source checks)");
  const source = (p) => readFileSync(path.join(ROOT, p), "utf8");
  const cell = source("src/components/clay/clay-cell.tsx");
  check("clay-cell: FOUND_COLUMN, both predicates take { run }, find_email written elsewhere only in a run's table",
    cell.includes('export const FOUND_COLUMN = "find_email";') && /export const writtenElsewhere = \(col: EnrichColumn, opts\?: ColumnOpts\) =>/.test(cell) &&
      /export const notRunHere = \(col: EnrichColumn, opts\?: ColumnOpts\) => col\.phase > 1 && col\.key !== ADDED_COLUMN && !foundByPulls\(col, opts\);/.test(cell) &&
      /const foundByPulls = \(col: EnrichColumn, opts\?: ColumnOpts\) => Boolean\(opts\?\.run\) && col\.phase > 1 && col\.key === FOUND_COLUMN;/.test(cell));
  check("... HeaderStats and ClayCell take run; a find_email cell shows its words (green when found or approved), the header \"Nothing sent yet\"",
    /export function HeaderStats\(\{ col, counts, rows, copy, run \}/.test(cell) && /\n {2}run,\n\}: \{/.test(cell) && cell.includes("/^(Found by|Approved by) /.test(text)") &&
      cell.includes('found ? "Nothing sent yet" : "Nothing added yet"') && cell.includes("col.key === FOUND_COLUMN ? <FoundValue cell={cell} /> : <AddedValue cell={cell} />"));
  check("... add_to_database stays as it was", cell.includes('export const ADDED_COLUMN = "add_to_database";') && cell.includes('cell.d === "Added"') && cell.includes("function AddedValue({ cell }: { cell: GridCell | undefined })"));
  const grid = source("src/components/clay/clay-grid.tsx");
  check("clay-grid: a run prop, passed to the header, its stats, every cell and the three notRunHere calls",
    /\n {2}run\?: boolean;\n\}/.test(grid) && grid.includes("copy={props.copy} run={props.run} />") && grid.includes("rows={rowCount} copy={copy} run={run} />") &&
      (grid.match(/notRunHere\(col, \{ run \}\)/g) ?? []).length === 3 && !/notRunHere\(col\)/.test(grid));
  const panel = source("src/components/clay/cell-panel.tsx");
  check("cell-panel: a run prop for both predicates; the held notes as pinned",
    /\n {2}run: isRun,\n/.test(panel) && (panel.match(/writtenElsewhere\(col!, \{ run: isRun \}\)/g) ?? []).length === 2 && panel.includes("notRunHere(col!, { run: isRun })") &&
      panel.includes("Held: a person an AI Ark pull bought with no email. The worker starts it while its client is on People runs, at most 2,000 rows of this table at a time; nothing runs or is spent on it until then.") &&
      /startsWith\("AI Ark pull"\)/.test(panel) && /heldNote\(shown\.row\.template\)/.test(panel) && panel.includes("Held: a no-email row of an upload. It is worked once its client is on People runs"));
  const page = source("src/app/(app)/leads/clay/page.tsx");
  check("the Clay page: run={isRun} to the grid and the panel, notRunHere with { run: isRun }; the add bar line as pinned",
    (page.match(/run=\{isRun\}/g) ?? []).length === 2 && (page.match(/notRunHere\(c, \{ run: isRun \}\)/g) ?? []).length === 2 && !page.includes("filter(notRunHere)") &&
      page.includes("state.pipeline ? `${fmt(state.pipeline)} no email${state.sent ? ` (${fmt(state.sent)} sent to the People table)` : \", not sent yet\"}` : \"\""));
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query(`DELETE FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM enrich_originals WHERE starts_with(variant, 'pstest_')`);
  await pool.query(`DELETE FROM enrich_memory WHERE starts_with(client_tag, $1)`, [PREFIX]);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

const t0 = Date.now();
let clean = false;
let defaultBefore = null;
let tracksBefore = null;
try {
  const ready = await one(`SELECT to_regclass('public.enrich_originals') IS NOT NULL AS ok`);
  if (!ready.ok) throw new Error("migration 125 is not in this database");
  const s = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
  const listed = ["company_pipeline", "people_pipeline", "personalisation", "promotion"].filter((k) => s[k]?.tags?.length);
  if (listed.length) throw new Error(`Refusing to run: a client is on the ${listed.join(", ")} list(s)`);
  const held = await one(
    `SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id WHERE r.run_status = 'held' AND NOT starts_with(t.client_tag, $1)`,
    [PREFIX]
  );
  if (held.n) throw new Error(`Refusing to run: ${held.n} held row(s) exist outside ${PREFIX}`);
  await cleanup(); // anything an interrupted run left behind
  defaultBefore = await variantHash("default");
  tracksBefore = await tracksRow();
  partA();
  partB();
  await inTx(pool, (c) => seedOriginals(c, { exports: fixtureSeedExports(), variant: BASE, seededBy: "tests" }));
  await partC();
  await partD();
  await partE();
  await partF();
  partG();
  check("the local default originals and people tracks are as they were", same(await variantHash("default"), defaultBefore) && same(await tracksRow(), tracksBefore));
  check("nothing tried to reach any address but the OpenAI stub (3 sends, all made-up failures)", net.calls.refused === 0 && net.calls.openai === 3 && Object.entries(net.calls).every(([k, n]) => k === "openai" || n === 0), JSON.stringify(net.calls));
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1)) AS tables,
            (SELECT count(*)::int FROM enrich_originals WHERE starts_with(variant, 'pstest_')) AS originals,
            (SELECT count(*)::int FROM enrich_memory WHERE starts_with(client_tag, $1)) AS memory`,
    [PREFIX]
  );
  clean = left.tables === 0 && left.originals === 0 && left.memory === 0 && !(tmp && existsSync(tmp));
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify(left)}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
