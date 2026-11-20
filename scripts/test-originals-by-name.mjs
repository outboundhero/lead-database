#!/usr/bin/env node
// Checks for a client's own Clay originals loaded by name (design 4.1 to 4.7):
// mapByName, mergeVariant, seedByName and its checks, the seed script's
// --by-name and --plan, the pipeline's fallback to "default" when a client's
// own variant does not compile, and the read-only fetch script against a fake
// `clay`. LOCAL DATABASE ONLY. Everything is made up: the clients' exports
// are the fixtures' (scripts/fixtures/clay-originals) with their field ids
// relabelled, the base they are matched against is the fixtures seeded as a
// variant of the suite's own, tags start LDTEST_ and variants ldtest_; all of
// it is removed at the end. The "default" originals are never changed; two
// checks compile the local default (a client's fallback), so it must be
// loaded, as for test-people part C.
//
//   node --env-file=.env.local scripts/test-originals-by-name.mjs
//
// Stop the enrichment worker first. Nothing reaches a network: fetch is
// replaced and refuses every address, and the fetch script runs a fake `clay`
// with a PATH that holds no real one. It refuses to run while any client is on
// the company_pipeline, people_pipeline, personalisation or promotion lists,
// or while any held row exists outside its own tags.
//
//   A. no database: mapByName and mergeVariant
//   B. local database: seedByName's checks, the seed script by name, the
//      pipeline's pick and its fallback
//   C. the fetch script, with a fake clay, then its plan through the seed

import pg from "pg";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIXTURE_MARKER, fixtureSeedExports, fixtureText } from "./fixtures/clay-originals/fixtures.mjs";
import { checker, dropPaidKeys, inTx, installNet, localDatabaseUrl } from "./fixtures/test-support.mjs";
import { ORIGINAL_COUNTS, ORIGINAL_KINDS } from "./lib/enrich/original-keys.mjs";
import { CLAY_REF, loadOriginals } from "./lib/enrich/compile-original.mjs";
import {
  AI_COLUMNS, COMPILED_POSITIONS, mapByName, mergeVariant, originalRows, originalsMap, repointIds, seedByName, seedOriginals, tableExampleCount,
} from "./lib/enrich/seed-originals.mjs";
import { compileTemplates, ensurePipelineTables, variantFor, variantName, variantOfNote } from "./lib/enrich/templates.mjs";
import { flagOn, settingsFrom } from "./lib/enrich/settings.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const RUN = randomUUID().slice(0, 6);
const PREFIX = "LDTEST_";
const BASE = `ldtest_base_${RUN}`;
const KINDS = ORIGINAL_KINDS;

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const sha = (s) => createHash("sha256").update(s).digest("hex");

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
/** Every string of a value, keys included. */
function texts(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => texts(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      texts(x, out);
    }
  }
  return out;
}

/**
 * A made-up client's exports: the fixtures, each field id relabelled
 * (f_fxC24 as f_ldC24) unless asked not to, so a client's ids differ from the
 * base's as a separately built table's would.
 */
function clientExports({ relabel = true, edit = null } = {}) {
  const exp = fixtureSeedExports();
  /** @type {Record<string, { sha256: string, data: any[] }>} */
  const out = {};
  for (const k of KINDS) out[k] = { sha256: "", data: relabel ? mapText(exp[k].data, (s) => s.replace(/f_fx([CPG]\d\d)/g, "f_ld$1")) : structuredClone(exp[k].data) };
  if (edit) edit(out);
  for (const k of KINDS) out[k].sha256 = sha(JSON.stringify(out[k].data));
  return out;
}
const col = (exp, kind, position) => exp[kind].data.find((c) => c.id.endsWith(`${{ companies: "C", people: "P", inboxes: "G" }[kind]}${String(position).padStart(2, "0")}`));
const without = (exp, kind, position) => {
  exp[kind].data = exp[kind].data.filter((c) => c !== col(exp, kind, position));
};
const renameIds = (exp, from, to) => {
  for (const k of KINDS) exp[k].data = mapText(exp[k].data, (s) => s.split(from).join(to));
};
const rowOf = (rows, kind, position) => rows.find((r) => r.template_kind === kind && r.position === position);

// ── A. No database ──────────────────────────────────────────────────────────

const baseRows = originalRows(fixtureSeedExports(), { variant: BASE, seededBy: "tests" });

function partA() {
  section("A1. The same layout");
  const same = clientExports();
  const maps = Object.fromEntries(KINDS.map((k) => [k, mapByName(k, same[k].data, baseRows)]));
  check("every column at its own place: none moved, renamed, extra, ambiguous or missing",
    KINDS.every((k) => maps[k].sameplace.length === ORIGINAL_COUNTS[k] && maps[k].byPosition.size === ORIGINAL_COUNTS[k] &&
      !maps[k].moved.length && !maps[k].renamed.length && !maps[k].extra.length && !maps[k].ambiguous.length && !maps[k].missing.length),
    JSON.stringify(Object.fromEntries(KINDS.map((k) => [k, [maps[k].sameplace.length, maps[k].moved.length, maps[k].missing.length]]))));
  const merged = mergeVariant(same, baseRows, { variant: "ldtest_same", seededBy: "tests" });
  check("the rows are the exact-layout seed's (originalRows), field for field",
    canon(merged.rows) === canon(originalRows(same, { variant: "ldtest_same", seededBy: "tests" })) && merged.rows.length === 232);
  check("... with the client's own field ids, none of the base's", merged.rows.every((r) => r.clay_field_id.startsWith("f_ld")) && !texts(merged.rows.map((r) => r.definition)).some((t) => t.includes("f_fx")));

  section("A2. Shuffled");
  const shuffled = clientExports({ edit: (e) => KINDS.forEach((k) => e[k].data.reverse()) });
  const smaps = Object.fromEntries(KINDS.map((k) => [k, mapByName(k, shuffled[k].data, baseRows)]));
  check("every column moved, none missing", KINDS.every((k) => smaps[k].moved.length === ORIGINAL_COUNTS[k] && !smaps[k].sameplace.length && !smaps[k].missing.length));
  const sm = mergeVariant(shuffled, baseRows, { variant: "ldtest_same", seededBy: "tests" });
  check("stored at the canonical positions, as the same layout's rows (but the sha256 of the file)",
    canon(sm.rows.map((r) => ({ ...r, source_sha256: null }))) === canon(merged.rows.map((r) => ({ ...r, source_sha256: null }))));
  check("the compiled templates are the strict compile's",
    canon(compileTemplates(originalsMap(sm.rows))) === canon(compileTemplates(originalsMap(originalRows(same, { variant: "ldtest_same" })))));

  section("A3. A missing column, filled from the base");
  const noC36 = clientExports({ edit: (e) => without(e, "companies", 36) });
  const m3 = mapByName("companies", noC36.companies.data, baseRows);
  const r3 = mergeVariant(noC36, baseRows, { variant: "ldtest_fill", seededBy: "tests" });
  const c36 = rowOf(r3.rows, "companies", 36);
  const c36Texts = texts(c36.definition.settings);
  const mapKeys = Object.keys(c36.definition.settings.inputsBinding.find((b) => b.name === "columnValuesToColumnMappings").formulaMap);
  check("C#36 missing: filled from the base row, its own field id and sha256 the base's, seeded_by noting it",
    JSON.stringify(m3.missing) === "[36]" && c36.clay_field_id === "f_fxC36" && c36.source_sha256 === baseRows.find((r) => r.template_kind === "companies").source_sha256 &&
      c36.seeded_by === "tests (filled from default)" && r3.report.kinds.companies.filled === 1,
    JSON.stringify({ missing: m3.missing, id: c36.clay_field_id, by: c36.seeded_by }));
  check("its references re-pointed to the client's ids (C#34, C#29 ...)", c36Texts.some((t) => t.includes("{{f_ldC34}}")) && !c36Texts.some((t) => t.includes("f_fx")), c36Texts.filter((t) => t.includes("f_")).slice(0, 4).join(" | "));
  check("its write-to targets re-pointed: the mapping's keys are the client's General ids", mapKeys.length > 5 && mapKeys.every((k) => k.startsWith("f_ldG")), mapKeys.join());
  const compiled3 = compileTemplates(originalsMap(r3.rows));
  const strict3 = compileTemplates(originalsMap(originalRows(clientExports(), { variant: "x" })));
  const wt = (c) => c.companies.find((x) => x.key === "general_email_write_to");
  check("it compiles, C#36 as the strict compile's (but its field id)", canon({ ...wt(compiled3), clay_field_id: null }) === canon({ ...wt(strict3), clay_field_id: null }));

  const noP62 = mergeVariant(clientExports({ edit: (e) => without(e, "people", 62) }), baseRows, { variant: "ldtest_fill", seededBy: "tests" });
  const p62 = rowOf(noP62.rows, "people", 62);
  check("P#62 missing: filled, its reference to P#61 re-pointed to the client's P#61, nothing unknown",
    p62.definition.settings.formulaText.includes("{{f_ldP61}}") && !p62.definition.settings.formulaText.includes("f_fx") && !noP62.report.unknown.length, p62.definition.settings.formulaText.slice(0, 120));

  section("A4. Extra columns");
  const extra = clientExports({
    edit: (e) => {
      e.people.data.push({ type: "basic", id: "f_ldX01", name: "Ldtest Extra Column", settings: { type: "basic", dataTypeSettings: { type: "text" } } });
      e.people.data.push({ type: "basic", id: "f_ldX02", name: "Ldtest Note", settings: { type: "basic", dataTypeSettings: { type: "text" } } });
      e.people.data.push({ type: "basic", id: "f_ldX03", name: "LDTEST note", settings: { type: "basic", dataTypeSettings: { type: "text" } } });
    },
  });
  const m4 = mapByName("people", extra.people.data, baseRows);
  const r4 = mergeVariant(extra, baseRows, { variant: "ldtest_extra", seededBy: "tests" });
  check("an extra column is listed by name and never stored", JSON.stringify(m4.extra) === '["Ldtest Extra Column"]' && !r4.rows.some((r) => r.clay_field_id.startsWith("f_ldX")) && r4.rows.length === 232);
  check("two columns of one name that is no position's: ambiguous, listed, harmless", m4.ambiguous.length === 2 && !m4.ambiguousAt.length && !m4.missing.length, JSON.stringify(m4.ambiguous));

  section("A5. Renamed, same field id");
  const renamed = clientExports({ relabel: false, edit: (e) => (col(e, "inboxes", 23).name = "Ldtest Town Used") });
  const m5 = mapByName("inboxes", renamed.inboxes.data, baseRows);
  const r5 = mergeVariant(renamed, baseRows, { variant: "ldtest_ren", seededBy: "tests" });
  check("matched by its field id at G#23, with the client's name kept", JSON.stringify(m5.renamed) === JSON.stringify([{ position: 23, at: 23, name: "Ldtest Town Used" }]) && !m5.missing.length && !m5.extra.length && rowOf(r5.rows, "inboxes", 23).name === "Ldtest Town Used" && r5.report.kinds.inboxes.renamed === 1, JSON.stringify(m5.renamed));

  section("A6. The Enrichley alias");
  const alias = clientExports({
    edit: (e) => {
      col(e, "people", 13).name = "Enrichley Validation";
      col(e, "people", 14).name = "Enrichley Stamp Of Approval";
      col(e, "inboxes", 41).name = "Enrichley Validation";
      col(e, "inboxes", 42).name = "ENRICHLEY stamp of approval";
    },
  });
  const m6p = mapByName("people", alias.people.data, baseRows);
  const m6g = mapByName("inboxes", alias.inboxes.data, baseRows);
  check("the other spelling is matched at P#13, P#14, G#41 and G#42, nothing missing",
    m6p.aliased.map((x) => x.position).join() === "13,14" && m6g.aliased.map((x) => x.position).join() === "41,42" && !m6p.missing.length && !m6g.missing.length && !m6p.extra.length,
    JSON.stringify({ p: m6p.aliased, g: m6g.aliased }));
  const both = clientExports({ edit: (e) => e.people.data.push({ ...structuredClone(col(e, "people", 13)), id: "f_ldX13", name: "Enrichley Validation" }) });
  const m6b = mapByName("people", both.people.data, baseRows);
  check("both spellings in one table: ambiguous at P#13, neither matched", JSON.stringify(m6b.ambiguousAt) === "[13]" && m6b.missing.includes(13), JSON.stringify(m6b.ambiguousAt));

  section("A7. Field ids and examples");
  const map = new Map([["f_fxA01", "f_ldA01"]]);
  const def = { id: "f_fxA01", settings: { formulaText: "{{f_fxA01}} + {{ f_fxA01 }} + {{f_fxA011}} + xf_fxA01", formulaMap: { f_fxA01: "{{f_fxA01}}?.x" } } };
  const re = repointIds(def, map);
  check("repointIds: whole ids in texts and keys, never a longer id or a word that holds one",
    re.settings.formulaText === "{{f_ldA01}} + {{ f_ldA01 }} + {{f_fxA011}} + xf_fxA01" && Object.keys(re.settings.formulaMap).join() === "f_ldA01" && re.settings.formulaMap.f_ldA01 === "{{f_ldA01}}?.x" && def.settings.formulaText.startsWith("{{f_fxA01}}"),
    JSON.stringify(re));
  const g19 = baseRows.find((r) => r.template_kind === "inboxes" && r.position === 19);
  check("tableExampleCount: the fixture's G#19 holds 1; not JSON and not a list are named",
    tableExampleCount(g19.definition).count === 1 && tableExampleCount({ settings: { inputsBinding: [{ name: "tableExamples", formulaText: "{" }] } }).error === "not JSON" &&
      tableExampleCount({ settings: { inputsBinding: [{ name: "tableExamples", formulaText: "{}" }] } }).error === "not a list" && tableExampleCount({}).count === 0);
  check("the compiled positions hold P#61, G#49, C#36 and G#38 (an instance), never a position only a note names",
    ["P#61", "G#49", "C#36", "G#38", "P#1"].every((f) => COMPILED_POSITIONS.includes(f)) && !COMPILED_POSITIONS.includes("C#7") && !COMPILED_POSITIONS.includes("P#2"));
}

// ── B. The local database ───────────────────────────────────────────────────

const seedScript = fileURLToPath(new URL("./enrich-seed-originals.mjs", import.meta.url));
const fetchScript = fileURLToPath(new URL("./clay-fetch-tables.mjs", import.meta.url));
let tmp = null;

function cli(script, args, env = {}) {
  const r = spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, DATABASE_URL: url, ...env }, encoding: "utf8", timeout: 180_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}
/** A client's three export files, as the Clay CLI writes them. */
function writeExports(dir, exp) {
  mkdirSync(dir, { recursive: true });
  const files = {};
  for (const k of KINDS) {
    if (!exp[k]) continue;
    files[k] = path.join(dir, `${k}.json`);
    writeFileSync(files[k], fixtureText({ workspace: { id: 0, name: "Made-up workspace for the tests" }, data: exp[k].data }));
  }
  return files;
}
const variantRows = async (v) => one(`SELECT count(*)::int AS n, md5(string_agg(definition::text || source_sha256, '' ORDER BY template_kind, position)) AS h FROM enrich_originals WHERE variant = $1`, [v]);

/** seedByName in a transaction that is always rolled back. */
async function byNameDry(exports, variant) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await seedByName(c, { exports, variant, seededBy: "tests", base: BASE });
    out.rowsInside = (await c.query(`SELECT count(*)::int AS n FROM enrich_originals WHERE variant = $1`, [variant])).rows[0].n;
    return out;
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}
const checksOf = (out) => out.reasons.map((r) => r.check);

async function partB() {
  tmp = mkdtempSync(path.join(os.tmpdir(), "test-originals-by-name-"));
  section("B1. seedByName's checks (each in a transaction rolled back)");
  const good = await byNameDry(clientExports(), "ldtest_b1");
  check("a client with its own layout: loaded, 232 rows written inside its transaction, nothing refused",
    good.status === "loaded" && good.rowsInside === 232 && !good.reasons.length && good.report.compile.ok && good.counts.people.own === 88,
    JSON.stringify({ status: good.status, reasons: good.reasons, inside: good.rowsInside }));
  check("... the tracks and model differences reported, the examples of P#61, G#49 and G#19 counted",
    good.report.tracks.problems.length === 0 && good.report.tracks.phrases.operations === 3 && Array.isArray(good.report.models) &&
      good.report.examples["P#61"].count === 1 && good.report.examples["G#49"].count === 1 && good.report.examples["G#19"].count === 1 && good.report.examples["G#19"].own === true,
    JSON.stringify({ t: good.report.tracks, e: good.report.examples }));
  check("... and G#19 is among the AI columns whose model is compared with its setting", AI_COLUMNS["G#19"] === "inbox_first_name_ai");

  const def = await byNameDry(clientExports(), "default");
  check("the default variant is refused by name, before anything is read or written", def.status === "refused" && checksOf(def).join() === "variant" && def.report === null && def.replaced === 0, JSON.stringify(def.reasons));
  const onBase = await byNameDry(clientExports(), BASE);
  check("... and so is the base variant itself", onBase.status === "refused" && checksOf(onBase).join() === "variant");
  const noPeople = await byNameDry({ ...clientExports(), people: null }, "ldtest_b1");
  check("no People export: refused", noPeople.status === "refused" && noPeople.reasons.some((r) => r.check === "exports" && /No People export/.test(r.text)), JSON.stringify(noPeople.reasons));

  const newId = await byNameDry(clientExports({ edit: (e) => (col(e, "people", 43).name = "Ldtest Person Name", renameIds(e, "f_ldP43", "f_ldP43x")) }), "ldtest_b1");
  const newIdCompile = newId.reasons.find((r) => r.check === "compile")?.text ?? "";
  check("renamed with a new id, read by compiled columns: refused at compile, with the first failure's first line (and the retry's)",
    newId.status === "refused" && checksOf(newId).join() === "compile" && newIdCompile.length > 0 && !newIdCompile.includes("\n") && !newId.rowsInside &&
      newId.report.kinds.people.extra.includes("Ldtest Person Name") && /does not map: f_ldP43x/.test(newId.report.compile.retry_first_line ?? ""),
    JSON.stringify({ reasons: newId.reasons, retry: newId.report?.compile?.retry_first_line }));

  const dup = await byNameDry(clientExports({ edit: (e) => e.people.data.push({ ...structuredClone(col(e, "people", 60)), id: "f_ldP60c" }) }), "ldtest_b1");
  check("two columns named as P#60: ambiguous at a compiled position, refused", dup.status === "refused" && dup.reasons.some((r) => r.check === "ambiguous" && r.text.startsWith("P#60:")), JSON.stringify(dup.reasons));

  const noP61 = await byNameDry(clientExports({ edit: (e) => without(e, "people", 61) }), "ldtest_b1");
  check("P#61 missing: refused, its question AI column is not its own", noP61.status === "refused" && noP61.reasons.some((r) => r.check === "own_ai" && r.text.startsWith("P#61:")) && !noP61.rowsInside, JSON.stringify(noP61.reasons));
  const noP62 = await byNameDry(clientExports({ edit: (e) => without(e, "people", 62) }), "ldtest_b1");
  check("P#62 missing: filled from the base, loaded",
    noP62.status === "loaded" && noP62.counts.people.filled === 1 && noP62.report.kinds.people.missing.join() === "P#62",
    JSON.stringify({ status: noP62.status, reasons: noP62.reasons, missing: noP62.report?.kinds?.people?.missing }));

  const action = await byNameDry(clientExports({ edit: (e) => (col(e, "people", 46).settings.actionKey = "ldtest-made-up-action") }), "ldtest_b1");
  check("another Clay action at a compiled position: refused, naming both actions",
    action.status === "refused" && action.reasons.some((r) => r.check === "type" && r.text === "P#46: a ldtest-made-up-action where the template needs findymail-find-work-email"),
    JSON.stringify(action.reasons));
  const type = await byNameDry(clientExports({ edit: (e) => (col(e, "inboxes", 20).type = "action") }), "ldtest_b1");
  check("another type at a compiled position: refused", type.status === "refused" && type.reasons.some((r) => r.check === "type" && r.text === "G#20: a action where the template needs basic"), JSON.stringify(type.reasons));

  const noCompanies = await byNameDry({ ...clientExports(), companies: null }, "ldtest_b1");
  check("no Companies export: all 68 filled from the base, it compiles and loads, noted",
    noCompanies.status === "loaded" && noCompanies.counts.companies.from_default && noCompanies.counts.companies.filled === 68 &&
      noCompanies.report.compile.companies_from_default === "no_export" && noCompanies.notes.includes("companies: from the default"),
    JSON.stringify({ status: noCompanies.status, reasons: noCompanies.reasons, notes: noCompanies.notes }));

  const badCompanies = await byNameDry(clientExports({ edit: (e) => (col(e, "companies", 24).settings.inputsBinding = col(e, "companies", 24).settings.inputsBinding.filter((b) => b.name !== "prompt")) }), "ldtest_b1");
  check("Companies that do not compile on their own: compiled again with the base's Companies, loaded so and said so",
    badCompanies.status === "loaded" && badCompanies.counts.companies.from_default && badCompanies.report.compile.companies_from_default === "did_not_compile" &&
      badCompanies.notes.some((n) => n === "companies: from the default, its own did not compile: companys_website: C#24 has no prompt") &&
      badCompanies.report.companies_own?.own === 68 && badCompanies.rowsInside === 232,
    JSON.stringify({ status: badCompanies.status, reasons: badCompanies.reasons, notes: badCompanies.notes }));
  const badBoth = await byNameDry(clientExports({
    edit: (e) => {
      col(e, "companies", 24).settings.inputsBinding = col(e, "companies", 24).settings.inputsBinding.filter((b) => b.name !== "prompt");
      col(e, "inboxes", 48).settings.inputsBinding = col(e, "inboxes", 48).settings.inputsBinding.filter((b) => b.name !== "prompt");
    },
  }), "ldtest_b1");
  check("... but when the base's Companies don't help, refused with the first failure's first line",
    badBoth.status === "refused" && badBoth.reasons.some((r) => r.check === "compile" && r.text === "companys_website: C#24 has no prompt"), JSON.stringify(badBoth.reasons));

  const sameIdTwice = await byNameDry(clientExports({ edit: (e) => (col(e, "people", 20).id = "f_ldP21") }), "ldtest_b1");
  check("two of a table's rows with one field id: refused", sameIdTwice.status === "refused" && sameIdTwice.reasons.some((r) => r.check === "ids"), JSON.stringify(sameIdTwice.reasons));

  section("B2. The seed script by name");
  const gExp = clientExports({
    edit: (e) => {
      e.companies.data.reverse();
      without(e, "people", 62);
      e.people.data.push({ type: "basic", id: "f_ldX01", name: "Ldtest Extra Column", settings: { type: "basic", dataTypeSettings: { type: "text" } } });
      col(e, "inboxes", 41).name = "Enrichley Validation";
    },
  });
  const gFiles = writeExports(path.join(tmp, "ldtest_g"), gExp);
  const rFiles = writeExports(path.join(tmp, "ldtest_r"), clientExports({ edit: (e) => without(e, "people", 61) }));
  const planFile = path.join(tmp, "plan.json");
  writeFileSync(planFile, JSON.stringify([
    { tag: "LDTEST_G", ...gFiles },
    { tag: "LDTEST_R", ...rFiles },
    { tag: "LDTEST_V", ...gFiles },
    { tag: "LDTEST-V", ...gFiles },
    { tag: "LDTEST_N", companies: null, people: null, inboxes: null, not_read: { people: "not read here (workspace 2)", inboxes: "not read here (workspace 2)" } },
    { tag: "LDTEST_W", variant: "ldtest_other", ...gFiles },
    { tag: "LDTEST_X", variant: "default", ...gFiles },
  ]));
  const reportFile = path.join(tmp, "report.json");
  const settingsBefore = JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`));
  const defaultBefore = await variantRows("default");
  const run = cli(seedScript, ["--by-name", "--plan", planFile, "--report", reportFile, "--base", BASE]);
  const lines = run.stdout.split("\n");
  check("--plan: one line per client, the good one loaded with its counts",
    run.code === 0 && lines.includes("LDTEST_G variant ldtest_g: loaded; companies own 68/68 (moved 68, renamed 0, filled 0), people own 87/88 (moved 26, renamed 0, filled 1), inboxes own 76/76 (moved 0, renamed 0, filled 0); extra 1; unknown 0"),
    run.out.slice(0, 900));
  check("... the refused one refused, with its reasons counted",
    lines.some((l) => /^LDTEST_R variant ldtest_r: refused \(\d+ reasons?\); /.test(l)) && (await variantRows("ldtest_r")).n === 0, run.out.slice(0, 900));
  check("... two clients giving one variant: both refused; a variant that is not the tag's, and default, refused; a client not read: not read",
    lines.includes("LDTEST_V variant ldtest_v: refused (1 reason)") && lines.includes("LDTEST-V variant ldtest_v: refused (1 reason)") &&
      lines.includes("LDTEST_W variant ldtest_other: refused (1 reason)") && lines.includes("LDTEST_X variant default: refused (1 reason)") && lines.includes("LDTEST_N variant ldtest_n: not read") &&
      (await variantRows("ldtest_v")).n === 0 && (await variantRows("ldtest_other")).n === 0,
    run.out.slice(0, 1200));
  check("... then the totals",
    lines.includes("Totals: 7 clients: loaded 1 (Companies from the default 0, 0 of them because their own did not compile), refused 5, not read 1") && /^Refused by check \(clients\): variant 4, /.test(lines.find((l) => l.startsWith("Refused by check")) ?? ""),
    run.out.slice(-600));
  check("stdout holds no column name, prompt or list", !run.out.includes(FIXTURE_MARKER) && !run.out.includes("Ldtest Extra Column") && !run.out.includes("Enrichley") && !run.out.includes("Claygent"));
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const gReport = report.clients.find((c) => c.tag === "LDTEST_G");
  check("--report: the full JSON outside the repo, with names and reasons",
    report.base === BASE && report.dry === false && gReport.report.kinds.people.extra.includes("Ldtest Extra Column") && gReport.report.kinds.inboxes.aliased[0]?.name === "Enrichley Validation" &&
      report.clients.find((c) => c.tag === "LDTEST_R").reasons.some((r) => r.check === "own_ai"),
    JSON.stringify(gReport?.report?.kinds?.inboxes?.aliased));
  const stored = await all(`SELECT template_kind, position, key, name, clay_field_id, seeded_by, source_sha256 FROM enrich_originals WHERE variant = 'ldtest_g' ORDER BY template_kind, position`);
  const p62 = stored.find((r) => r.template_kind === "people" && r.position === 62);
  check("a real load writes 232 rows at the canonical positions and keys, the filled one marked",
    stored.length === 232 && KINDS.every((k) => stored.filter((r) => r.template_kind === k).length === ORIGINAL_COUNTS[k]) && p62.key === "question" &&
      / \(filled from default\)$/.test(p62.seeded_by) && p62.clay_field_id === "f_fxP62" && stored.find((r) => r.template_kind === "companies" && r.position === 24).clay_field_id === "f_ldC24",
    JSON.stringify(p62));
  check("the seed changed no setting and left the default variant as it was",
    JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`)) === settingsBefore && JSON.stringify(await variantRows("default")) === JSON.stringify(defaultBefore));

  const dFiles = writeExports(path.join(tmp, "ldtest_d"), gExp);
  const dry = cli(seedScript, ["--by-name", "--variant", "ldtest_d", "--companies", dFiles.companies, "--people", dFiles.people, "--inboxes", dFiles.inboxes, "--dry", "--base", BASE]);
  check("--dry: would load, and nothing is kept", dry.code === 0 && /^client variant ldtest_d: would load; /.test(dry.stdout) && /dry run, nothing kept/.test(dry.stdout) && (await variantRows("ldtest_d")).n === 0, dry.out.slice(0, 600));
  const noCo = cli(seedScript, ["--by-name", "--variant", "ldtest_d", "--no-companies", "--people", dFiles.people, "--inboxes", dFiles.inboxes, "--dry", "--base", BASE]);
  check("--no-companies: the Companies from the base", noCo.code === 0 && /companies own 0\/68 \(moved 0, renamed 0, filled 68, from the default\)/.test(noCo.stdout), noCo.out.slice(0, 600));
  const single = cli(seedScript, ["--by-name", "--variant", "default", "--companies", dFiles.companies, "--people", dFiles.people, "--inboxes", dFiles.inboxes, "--base", BASE]);
  check("one client refused (default by name): exit 1", single.code === 1 && /^client variant default: refused \(1 reason\)/.test(single.stdout), single.out.slice(0, 400));
  const inRepo = cli(seedScript, ["--by-name", "--plan", planFile, "--report", path.join(ROOT, "scripts", "ldtest-report.json"), "--base", BASE]);
  check("--report inside the repo: refused before anything is read or written", inRepo.code === 1 && /inside this repo/.test(inRepo.out) && !existsSync(path.join(ROOT, "scripts", "ldtest-report.json")), inRepo.out.slice(0, 300));
  const noBase = cli(seedScript, ["--by-name", "--plan", planFile, "--base", `ldtest_nobase_${RUN}`, "--dry"]);
  check("a base that is not loaded stops the run, nothing loaded", noBase.code === 1 && /is not loaded/.test(noBase.out), noBase.out.slice(0, 300));

  section("B3. The pipeline's pick: the client's own variant, else default");
  check("variantFor picks the loaded client variant", (await variantFor(pool, "LDTEST_G")) === "ldtest_g");
  const own = await inTx(pool, (c) => ensurePipelineTables(c, "LDTEST_G"));
  const tables = await all(`SELECT id, kind, source_note FROM enrich_tables WHERE client_tag = 'LDTEST_G' ORDER BY kind`);
  const storedOriginals = await loadOriginals(pool, "ldtest_g");
  const expected = compileTemplates(storedOriginals);
  const counts = {};
  for (const t of tables) counts[t.kind] = (await one(`SELECT count(*)::int AS n FROM enrich_columns WHERE table_id = $1`, [t.id])).n;
  check("ensurePipelineTables compiles from it: its variant noted, own_variant set, no fallback",
    own.variant === "ldtest_g" && own.own_variant === "ldtest_g" && own.fallback === null && tables.length === 3 &&
      tables.every((t) => variantOfNote(t.source_note) === "ldtest_g") && KINDS.every((k) => counts[k] === expected[k].length),
    JSON.stringify({ own: { v: own.variant, o: own.own_variant, f: own.fallback }, counts }));
  const prompt = await one(`SELECT inputs->>'prompt' AS p FROM enrich_columns c JOIN enrich_tables t ON t.id = c.table_id WHERE t.client_tag = 'LDTEST_G' AND t.kind = 'people' AND c.key = 'claygent'`);
  check("... the client's own research prompt in its People table", String(prompt?.p ?? "").includes(`${FIXTURE_MARKER}-p60`));

  await pool.query(
    `UPDATE enrich_originals SET definition = jsonb_set(definition, '{settings,inputsBinding}', '[]'::jsonb)
      WHERE variant = 'ldtest_g' AND template_kind = 'people' AND position = 60`
  );
  const defaultReady = (await one(`SELECT count(*)::int AS n FROM enrich_originals WHERE variant = 'default'`)).n === 232;
  let fell = null;
  let fellErr = null;
  try {
    fell = await inTx(pool, (c) => ensurePipelineTables(c, "LDTEST_G"));
  } catch (e) {
    fellErr = e;
  }
  const notes = await all(`SELECT kind, source_note FROM enrich_tables WHERE client_tag = 'LDTEST_G' ORDER BY kind`);
  const ownPrompt = await one(`SELECT inputs->>'prompt' AS p FROM enrich_columns c JOIN enrich_tables t ON t.id = c.table_id WHERE t.client_tag = 'LDTEST_G' AND t.kind = 'people' AND c.key = 'claygent'`);
  check("a stored own variant that no longer compiles: the tables compile from default, and say why (needs the local default originals)",
    defaultReady && !fellErr && fell.variant === "default" && fell.own_variant === "ldtest_g" && fell.fallback === "claygent: P#60 has no prompt" &&
      notes.every((n) => n.source_note.startsWith(`Pipeline template ${{ companies: "companies_v2", inboxes: "inboxes_v1", people: "people_v1" }[n.kind]}, compiled from the Clay originals (variant default); the client's own variant ldtest_g did not compile: claygent: P#60 has no prompt`)) &&
      !String(ownPrompt?.p ?? "").includes(FIXTURE_MARKER),
    JSON.stringify({ defaultReady, err: fellErr?.message, variant: fell?.variant, fallback: fell?.fallback }));
  const pers = settingsFrom([{ key: "personalisation", value: { enabled: true, tags: ["LDTEST_G"] } }]);
  check("... the worker reads them as default, so personalisation is off for the client (it would be on for its own variant)",
    notes.every((n) => variantOfNote(n.source_note) === "default") && !flagOn(pers, "personalisation", "LDTEST_G", { variant: variantOfNote(notes[0].source_note) }) && flagOn(pers, "personalisation", "LDTEST_G", { variant: "ldtest_g" }));
  const plain = await inTx(pool, (c) => ensurePipelineTables(c, "LDTEST_P"));
  check("a client with no own variant: default, own_variant and fallback null", plain.variant === "default" && plain.own_variant === null && plain.fallback === null && variantName("LDTEST_P") === "ldtest_p");
  check("the default variant is still as it was", JSON.stringify(await variantRows("default")) === JSON.stringify(defaultBefore));
}

// ── C. The fetch script, with a fake clay ───────────────────────────────────

const FAKE_CLAY = `#!/bin/sh
F="$(dirname "$0")"
echo "$*" >> "$F/log.txt"
if [ "$1" = "workspaces" ] && [ "$2" = "current" ]; then cat "$F/current.json"; exit 0; fi
if [ "$1" = "tables" ] && [ "$2" = "columns" ] && [ "$3" = "get" ]; then
  T="$F/tables/$4"
  if [ -f "$T.ratelimit" ]; then
    n=$(cat "$T.ratelimit")
    if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$T.ratelimit"; echo '{"error":{"code":"rate_limited","message":"made up","details":{"retryAfter":0}}}' >&2; exit 4; fi
  fi
  if [ -f "$T.then-current.json" ]; then cp "$T.then-current.json" "$F/current.json"; fi
  if [ -f "$T.json" ]; then cat "$T.json"; exit 0; fi
  echo '{"error":{"code":"not_found","message":"made up"}}' >&2; exit 6
fi
echo '{"error":{"code":"validation_error","message":"not in this fake"}}' >&2
exit 2
`;

function fakeClay(name, tables) {
  const dir = path.join(tmp, name);
  mkdirSync(path.join(dir, "tables"), { recursive: true });
  writeFileSync(path.join(dir, "clay"), FAKE_CLAY);
  chmodSync(path.join(dir, "clay"), 0o755);
  writeFileSync(path.join(dir, "current.json"), JSON.stringify({ workspace: { id: "111", name: "Made-up workspace" } }));
  writeFileSync(path.join(dir, "log.txt"), "");
  for (const [id, t] of Object.entries(tables)) {
    if (t.body) writeFileSync(path.join(dir, "tables", `${id}.json`), t.body);
    if (t.rateLimit) writeFileSync(path.join(dir, "tables", `${id}.ratelimit`), String(t.rateLimit));
    if (t.thenCurrent) writeFileSync(path.join(dir, "tables", `${id}.then-current.json`), JSON.stringify({ workspace: { id: t.thenCurrent, name: null } }));
  }
  return { dir, env: { PATH: `${dir}:/usr/bin:/bin` }, log: () => readFileSync(path.join(dir, "log.txt"), "utf8").split("\n").filter(Boolean) };
}
const answer = (data, ws = "111") => `${JSON.stringify({ workspace: { id: ws, name: "Made-up workspace" }, data }, null, 2)}\n`;

async function partC() {
  section("C. The fetch script (a fake clay, never the real one)");
  const exp = clientExports();
  const fake = fakeClay("fake-1", {
    t_ld_c1: { body: answer(exp.companies.data) },
    t_ld_p1: { body: answer(exp.people.data) },
    t_ld_g1: { body: answer(exp.inboxes.data) },
    t_ld_p3: { body: answer(exp.people.data), rateLimit: 1 },
    t_ld_c2: { body: answer(exp.companies.data) },
  });
  const ids = path.join(tmp, "ids.json");
  writeFileSync(ids, JSON.stringify([
    { tag: "LDTEST_F1", workspace: "111", company: "t_ld_c1", people: "t_ld_p1", general: "t_ld_g1" },
    { tag: "LDTEST_F2", workspace: "222", company: "t_ld_c2", people: "t_ld_p2", general: "t_ld_g2" },
    { tag: "LDTEST_F3", workspace: "111", company: null, people: "t_ld_p3", general: "t_ld_g3" },
  ]));
  const out = path.join(tmp, "fetched");
  const r = cli(fetchScript, ["--ids", ids, "--out", out, "--pause-ms", "0", "--retry-ms", "1"], fake.env);
  const log = fake.log();
  const plan = existsSync(path.join(out, "plan.json")) ? JSON.parse(readFileSync(path.join(out, "plan.json"), "utf8")) : [];
  const f1 = plan.find((p) => p.tag === "LDTEST_F1");
  const f2 = plan.find((p) => p.tag === "LDTEST_F2");
  const f3 = plan.find((p) => p.tag === "LDTEST_F3");
  check("reads only the active workspace's tables, one call each (a rate limit retried), never switching",
    r.code === 0 && log[0] === "workspaces current" && !log.some((l) => /switch/.test(l)) && !log.some((l) => /t_ld_[cpg]2/.test(l)) &&
      log.filter((l) => l === "tables columns get t_ld_p3").length === 2 && log.filter((l) => l.startsWith("tables columns get")).length === 6 && log.every((l) => /^(workspaces current|tables columns get t_ld_\w+)$/.test(l)),
    `${r.out.slice(0, 400)} | ${log.join(" ; ")}`);
  check("writes each table as the CLI answered, under the client's variant, and the plan",
    plan.length === 3 && f1.variant === "ldtest_f1" && f1.companies === path.join(out, "ldtest_f1", "companies.json") && readFileSync(f1.people, "utf8") === answer(exp.people.data) && !f1.not_read &&
      f2.not_read?.people === "not read here (workspace 222)" && f2.people === null && !existsSync(path.join(out, "ldtest_f2")) &&
      f3.companies === null && f3.people === path.join(out, "ldtest_f3", "people.json") && f3.not_read?.inboxes === "not found" && !("companies" in (f3.not_read ?? {})),
    JSON.stringify(plan));
  check("prints counts only", /3 clients: 2 read here \(4 tables, 1 not read, 1 retries\), 1 in another workspace \(not read here\)/.test(r.out) && !r.out.includes("LDTEST_F"), r.out.slice(0, 400));

  const seeded = cli(seedScript, ["--by-name", "--plan", path.join(out, "plan.json"), "--dry", "--base", BASE]);
  const sl = seeded.stdout.split("\n");
  check("its plan goes through the seed: the client read would load, the others are not read",
    seeded.code === 0 && sl.some((l) => l.startsWith("LDTEST_F1 variant ldtest_f1: would load; companies own 68/68")) && sl.includes("LDTEST_F2 variant ldtest_f2: not read") && sl.includes("LDTEST_F3 variant ldtest_f3: not read"),
    seeded.out.slice(0, 600));

  const fake2 = fakeClay("fake-2", { t_ld_p9: { body: answer(exp.people.data, "222") }, t_ld_g9: { body: answer(exp.inboxes.data) } });
  writeFileSync(ids, JSON.stringify([{ tag: "LDTEST_F9", workspace: "111", company: null, people: "t_ld_p9", general: "t_ld_g9" }]));
  const out2 = path.join(tmp, "fetched-2");
  const r2 = cli(fetchScript, ["--ids", ids, "--out", out2, "--pause-ms", "0"], fake2.env);
  check("an answer from another workspace stops the whole run: nothing more read, that table not written, no plan",
    r2.code === 2 && /Stopped: A table answered from workspace 222/.test(r2.out) && !existsSync(path.join(out2, "plan.json")) && !existsSync(path.join(out2, "ldtest_f9", "people.json")) && !fake2.log().some((l) => /t_ld_g9|switch/.test(l)),
    `${r2.out.slice(0, 300)} | ${fake2.log().join(" ; ")}`);

  const fake3 = fakeClay("fake-3", { t_ld_p8: { thenCurrent: "222" }, t_ld_g8: { body: answer(exp.inboxes.data) } });
  writeFileSync(ids, JSON.stringify([{ tag: "LDTEST_F8", workspace: "111", company: null, people: "t_ld_p8", general: "t_ld_g8" }]));
  const r3 = cli(fetchScript, ["--ids", ids, "--out", path.join(tmp, "fetched-3"), "--pause-ms", "0"], fake3.env);
  check("a table not found after which the active workspace is another: stopped, the pointer never moved back",
    r3.code === 2 && /no longer 111/.test(r3.out) && !fake3.log().some((l) => /switch|t_ld_g8/.test(l)) && !existsSync(path.join(tmp, "fetched-3", "plan.json")),
    `${r3.out.slice(0, 300)} | ${fake3.log().join(" ; ")}`);

  const fake4 = fakeClay("fake-4", {});
  const r4 = cli(fetchScript, ["--ids", ids, "--out", path.join(ROOT, "scripts", "ldtest-fetched")], fake4.env);
  check("--out inside the repo: refused before any clay call", r4.code === 1 && /inside this repo/.test(r4.out) && fake4.log().length === 0 && !existsSync(path.join(ROOT, "scripts", "ldtest-fetched")), r4.out.slice(0, 300));
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query(`DELETE FROM enrich_tables WHERE starts_with(client_tag, $1) OR starts_with(client_tag, 'LDTEST-')`, [PREFIX]);
  await pool.query(`DELETE FROM enrich_originals WHERE starts_with(variant, 'ldtest_')`);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

const t0 = Date.now();
let clean = false;
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
  partA();
  await inTx(pool, (c) => seedOriginals(c, { exports: fixtureSeedExports(), variant: BASE, seededBy: "tests" }));
  const stored = await loadOriginals(pool, BASE);
  check("the base variant is the fixtures, as the pure checks used them",
    [...stored.values()].every((r) => r.clay_field_id === rowOf(baseRows, r.template_kind, r.position).clay_field_id) && [...stored.values()].every((r) => ![...JSON.stringify(r.definition).matchAll(CLAY_REF)].some((m) => !m[1].startsWith("f_fx"))));
  await partB();
  await partC();
  check("nothing tried to reach any address", net.calls.refused === 0 && Object.values(net.calls).every((n) => n === 0), JSON.stringify(net.calls));
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1) OR starts_with(client_tag, 'LDTEST-')) AS tables,
            (SELECT count(*)::int FROM enrich_originals WHERE starts_with(variant, 'ldtest_')) AS originals`,
    [PREFIX]
  );
  clean = left.tables === 0 && left.originals === 0 && !(tmp && existsSync(tmp));
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify(left)}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
