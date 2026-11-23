#!/usr/bin/env node
// Checks for a client's own text in its personalisation AI steps (migration
// 139, the Clay tab's prompt editor): the text to expression conversion
// (prompt-text.mjs), what a step may read (prompt-editor.mjs
// promptCatalogue), the compile hook (prompt-overrides.mjs, templates.mjs
// applyPromptOverrides and ensurePipelineTables) and the route
// /api/enrich/prompts. LOCAL DATABASE ONLY.
//
// Everything is made up: the originals are the fixtures'
// (scripts/fixtures/clay-originals), loaded as the made-up clients' own
// variants (xq1a, xq1c) or as a made-up base (xq1_base_<run>) under a
// General-only overlay (xq1b); tags start XQ1 ("Prompt test" clients). All
// of it is removed at the end. The local "default" originals are never read
// or changed.
//
//   node --env-file=.env.local scripts/test-prompt-overrides.mjs
//
// Stop the enrichment worker first. Nothing reaches a network: fetch is
// replaced and refuses every address. It refuses to run while any client is
// on the company_pipeline, people_pipeline, personalisation or promotion
// lists, while a held row exists outside its own tags, while a real client
// tag starts with XQ1, or before migration 139.
//
//   A. text and expressions (no database): parsing, round trips on the
//      fixture originals, placeholders, quoting
//   B. what a step may read, and the compile in memory (no database)
//   C. the compile hook on the local database: an edit compiled into the
//      tables, reset, a broken edit left out on its own with a note, the
//      text variant for a client on the default's text
//   D. the route through the TypeScript loader: roles, shapes, 400, 409, 404,
//      save, reset, the audit lines

import pg from "pg";
import { randomUUID } from "node:crypto";
import { checker, dropPaidKeys, inTx, installNet, localDatabaseUrl, routeLoader, seedFixtureVariant } from "./fixtures/test-support.mjs";
import { FIXTURE_MARKER, fixtureSeedExports } from "./fixtures/clay-originals/fixtures.mjs";
import { originalRows, originalsMap, seedOriginals } from "./lib/enrich/seed-originals.mjs";
import { bindingText, refMap, rewriteRefs } from "./lib/enrich/compile-original.mjs";
import { emptyAsText, evaluate, makeContext, refs } from "./lib/enrich/formula.mjs";
import { PEOPLE_REFS } from "./lib/enrich/people-template.mjs";
import { INBOX_REFS } from "./lib/enrich/inbox-template.mjs";
import { COMPANY_REFS } from "./lib/enrich/company-template-v2.mjs";
import { applyPromptOverrides, compileTemplates, ensurePipelineTables, lockPipelineTables, variantOfNote } from "./lib/enrich/templates.mjs";
import { isPromptPosition, withPromptOverrides } from "./lib/enrich/prompt-overrides.mjs";
import { normName, parsePrompt, promptToText, textToPrompt } from "./lib/enrich/prompt-text.mjs";
import { cleanPromptText, promptBase, promptCatalogue, promptColumnViews, promptOverrideRows, savePromptOverride } from "./lib/enrich/prompt-editor.mjs";
import { flagOn, settingsFrom } from "./lib/enrich/settings.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const RUN = randomUUID().slice(0, 6);
const PREFIX = "XQ1";
const A = "XQ1A"; // the fixtures as its own (complete) variant; the route's client
const B = "XQ1B"; // the default's text in People: a General-only overlay over a made-up base
const C = "XQ1C"; // the fixtures as its own variant, no tables: the route before any table
const TAGS = [A, B, C];
const BASE = `xq1_base_${RUN}`;
const VARIANT_LIKE = "xq1%";
const USER = randomUUID();

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const same = (a, b) => canon(a) === canon(b);
const canon = (v) => JSON.stringify(sortKeys(v));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const REFS_OF = { companies: COMPANY_REFS, people: PEOPLE_REFS, inboxes: INBOX_REFS };

// ── The fixtures, in memory ─────────────────────────────────────────────────

const fixture = originalsMap(originalRows(fixtureSeedExports(), { variant: "xq1_memory" }));
const fixtureCompiled = compileTemplates(fixture);
const promptOf = (originals, kind, position) => bindingText(originals.get(`${kind}:${position}`).definition, "prompt");
const colOf = (compiled, kind, key) => compiled[kind].find((c) => c.key === key);

/** A made-up value for every column a prompt reads: an AI step's answer fields, a JSON input's fields, else text. */
function sampleValues(compiled, kind, keys) {
  const out = {};
  for (const k of keys) {
    const col = colOf(compiled, kind, k);
    if (col?.action === "ai_web") out[k] = Object.fromEntries((col.config.answer_order ?? []).map((f) => [f, `made-up ${f} of ${k}`]));
    else if (col?.data_type === "json") out[k] = { name: `Made Up Person`, url: "https://profile.xq1test.example/p", latest_experience_company: "Made-up Co" };
    else out[k] = `made-up ${k}`;
  }
  return out;
}

/** The prompt as the engine renders it (refs rewritten to keys, empty cells as ""), with made-up values. */
function render(formula, originals, compiled, kind, values = null) {
  const text = rewriteRefs(formula, refMap(originals, kind, REFS_OF[kind])).text;
  const vals = values ?? sampleValues(compiled, kind, refs(text));
  return evaluate(makeContext(), text, emptyAsText(vals));
}

// ── A. Text and expressions ─────────────────────────────────────────────────

function partA() {
  section("A1. What the editor can show as text");
  const ok = (f) => parsePrompt(f).ok === true;
  const no = (f, re) => {
    const r = parsePrompt(f);
    return r.ok === false && re.test(r.reason);
  };
  check("literals, + and references with one field (?.x, .x, ?.[\"x y\"]), Clay.formatForAIPrompt and brackets",
    ok(`"a" + {{f_x}} + 'b' + {{f_x}}?.f + {{f_x}}.g + {{f_x}}?.["h i"] + Clay.formatForAIPrompt({{f_x}}) + ("c" + (Clay.formatForAIPrompt(({{key_y}}?.z))))`));
  const esc = parsePrompt(`"q\\"uote \\\\ back\\nline\\ttab \\u00e9 \\x41 \\u{1F600} \\v\\b\\f\\0" + 'it\\'s' + "a\\
b"`);
  check("escapes worked out as JavaScript does (quotes, backslash, \\n, \\t, \\u, \\x, \\u{}, \\v \\b \\f \\0, a line continuation)",
    esc.ok && esc.parts.map((p) => p.text).join("") === "q\"uote \\ back\nline\ttab é A \u{1F600} \v\b\f\0it'sab", JSON.stringify(esc));
  check("refused, with why: a condition, another call, another operator, a comment, a template literal, a number",
    no(`"a" + ({{f_x}} ? "y" : "z")`, /condition/) && no(`"a" + {{f_x}}.toLowerCase()`, /call/) && no(`"a" + Clay.formatForJSON({{f_x}})`, /call|name/) &&
      no(`"a" + ({{f_x}} || "z")`, /operator/) && no(`"a" - {{f_x}}`, /operator/) && no(`"a" // c`, /comment/) && no("`a${1}`", /template/) && no(`"a" + 1`, /number/));
  check("... a read deeper than one field, a field worked out by an expression, two columns added before any text, an unclosed text, an octal escape",
    no(`"a" + {{f_x}}?.b?.c`, /deeper/) && no(`"a" + {{f_x}}[{{f_y}}]`, /expression/) && no(`{{f_x}} + {{f_y}} + "a"`, /numbers/) && no(`"a`, /not closed/) &&
      no(`"a\\1"`, /octal/) && no(`process.exit()`, /name/) && parsePrompt("").ok === false && parsePrompt(null).ok === false);
  check("... while a text first makes the rest text ('\"a\" + {{x}} + {{y}}' reads)", ok(`"a" + {{f_x}} + {{f_y}}`) && ok(`{{f_x}} + "a" + {{f_y}}`));

  section("A2. Round trips on the fixture originals: text, then the expression again, renders the same prompt");
  const steps = [["people", 60, "claygent"], ["people", 61, "question_ai"], ["inboxes", 48, "claygent"], ["inboxes", 49, "question_ai"],
    ["companies", 50, "company_decision_maker_location_company_check"], ["people", 27, "current_employer"]];
  for (const [kind, position, key] of steps) {
    const cat = promptCatalogue(fixtureCompiled[kind], fixture, kind, key);
    const original = promptOf(fixture, kind, position);
    const t = promptToText(original, cat);
    const back = t.ok ? textToPrompt(t.text, cat) : { formula: null, errors: ["not read"] };
    const parts = back.formula ? parsePrompt(back.formula) : { ok: false };
    const before = render(original, fixture, fixtureCompiled, kind);
    const after = back.formula ? render(back.formula, fixture, fixtureCompiled, kind) : null;
    check(`${kind}:${position}: shown as text with placeholders, written back as quoted text and Clay.formatForAIPrompt only, rendering the same prompt`,
      t.ok && back.errors.length === 0 && /\{\{[^{}]+\}\}/.test(t.text) && t.text.includes(FIXTURE_MARKER) && parts.ok &&
        parts.parts.every((p) => "text" in p || p.formatted === true) && before === after && before.includes(FIXTURE_MARKER),
      JSON.stringify({ ok: t.ok, reason: t.reason, errors: back.errors, same: before === after }));
  }
  const cat61 = promptCatalogue(fixtureCompiled.people, fixture, "people", "question_ai");
  const t61 = promptToText(promptOf(fixture, "people", 61), cat61);
  check("the research step's answer field is written {{Name.field}} (P#61 reads P#60's company_summary)", t61.ok && t61.text.includes("{{Claygent.company_summary}}"), t61.text);
  const t50 = promptToText(promptOf(fixture, "companies", 50), promptCatalogue(fixtureCompiled.companies, fixture, "companies", "company_decision_maker_location_company_check"));
  check("a bracketed field ({{f}}?.[\"Person_3_LinkedIn_URL\"]) is a field too", t50.ok && t50.text.includes(".Person_3_LinkedIn_URL}}"), t50.ok ? "" : t50.reason);

  section("A3. Placeholders when saving");
  const cat = cat61;
  const company = cat.find((e) => e.key === "company");
  const research = cat.find((e) => e.key === "claygent");
  const conv = textToPrompt("Hi {{company}} / {{  CLAYGENT .  company_summary }} / {{Claygent.Company_Summary}}", cat);
  check("names and fields match whatever their case and extra spaces, and become the column's ref",
    conv.errors.length === 0 && conv.formula === `"Hi " + Clay.formatForAIPrompt(${company.ref}) + " / " + Clay.formatForAIPrompt(${research.ref}?.company_summary) + " / " + Clay.formatForAIPrompt(${research.ref}?.company_summary)`,
    JSON.stringify(conv));
  const bad = textToPrompt("A {{Nope Column}} B {{Claygent.nothing}} C {{Company.x}} D {{ }} E {{Title}}", cat);
  check("an unknown placeholder, an unknown field, a field of a text column and an empty placeholder: each an error that names it, no expression",
    bad.formula === null && bad.errors.length === 4 && bad.errors[0].includes("{{Nope Column}}") && bad.errors[1].includes("{{Claygent.nothing}}") &&
      bad.errors[1].includes("company_summary") && bad.errors[2].includes("{{Company.x}}") && /empty placeholder/.test(bad.errors[3]),
    JSON.stringify(bad.errors));
  const stray = textToPrompt("Use {{Company} and }} here", cat);
  check("\"{{\" or \"}}\" outside a placeholder is refused", stray.formula === null && stray.errors.length === 1 && /outside a placeholder/.test(stray.errors[0]), JSON.stringify(stray.errors));
  check("an empty text is refused", textToPrompt("  \n ", cat).errors[0] === "The prompt is empty" && textToPrompt(null, cat).formula === null);
  const tricky = 'Say "hi" \\ to {{Company}}\n\tthen " + process.exit(1) + " and ${x} {single} braces {{{Company}}}';
  const tc = textToPrompt(tricky, cat);
  const vals = { company: "Acme" };
  const shown = tc.formula ? evaluate(makeContext(), rewriteRefs(tc.formula, refMap(fixture, "people", PEOPLE_REFS)).text, emptyAsText(vals)) : null;
  check("quotes, backslashes, line breaks, code-like text and single braces stay text: the expression renders exactly the text typed",
    tc.errors.length === 0 && shown === 'Say "hi" \\ to Acme\n\tthen " + process.exit(1) + " and ${x} {single} braces {Acme}', JSON.stringify({ errors: tc.errors, shown }));
  const back = tc.formula ? promptToText(tc.formula, cat) : { ok: false };
  check("... and reads back as the same text", back.ok && back.text === tricky, JSON.stringify(back));
  check("the same name twice: the whole name wins over Name.field", (() => {
    const c2 = [{ name: "A", ref: "{{f_a}}", key: "a", fields: ["b"] }, { name: "A.b", ref: "{{f_ab}}", key: "ab" }];
    return textToPrompt("{{A.b}}", c2).formula === "Clay.formatForAIPrompt({{f_ab}})" && promptToText('"" + {{f_a}}?.b', c2).ok === false;
  })());
  check("text holding \"{{\" can't be shown, nor a column the catalogue lacks, nor a field it does not list",
    promptToText('"a {{b}} c"', cat).ok === false && promptToText('"a" + {{f_nowhere}}', cat).ok === false && promptToText(`"a" + ${research.ref}?.not_listed`, cat).ok === false);
  check("cleanPromptText: NUL dropped, lone halves made U+FFFD, line breaks \\n, nothing else", cleanPromptText("a\u0000b\r\nc\rd\ud800e\tf") === "ab\nc\nd�e\tf" && cleanPromptText(5) === "");
  check("normName: spaces made single, trimmed, lower case", normName("  Use   CITY ") === "use city");
}

// ── B. What a step may read; the compile in memory ──────────────────────────

function partB() {
  section("B1. What a step may read");
  const cat60 = promptCatalogue(fixtureCompiled.people, fixture, "people", "claygent");
  const cat61 = promptCatalogue(fixtureCompiled.people, fixture, "people", "question_ai");
  const keys60 = new Set(cat60.map((e) => e.key));
  check("the research step: the columns before it in run order, never itself or a later one",
    keys60.has("company") && keys60.has("use_city") && keys60.has("email_provider_check_api") && keys60.has("in_area") &&
      !["claygent", "question_ai", "question", "person_outcome", "add_to_database"].some((k) => keys60.has(k)), [...keys60].join(","));
  check("the question step reads the research step, with its answer fields in Clay's order",
    same(cat61.find((e) => e.key === "claygent")?.fields?.slice(0, 3), ["company_summary", "spaces", "reasoning"]) && !cat61.some((e) => e.key === "question_ai"));
  check("hidden columns of our own are left out (company_row, written_city), a never-run one too (add_to_database)",
    !cat61.some((e) => ["company_row", "written_city", "add_to_database"].includes(e.key)));
  check("a column from a Clay original is referred to by its field id, one of ours by its key",
    cat61.find((e) => e.key === "company")?.ref === "{{f_fxP28}}" && cat61.find((e) => e.key === "in_area")?.ref === "{{in_area}}" && cat61.find((e) => e.key === "in_database")?.ref === "{{f_fxP04}}");
  const names = cat61.map((e) => normName(e.name));
  check("names are unique", new Set(names).size === names.length);
  check("a step that is no editable one is refused by position", isPromptPosition("people", 60) && isPromptPosition("inboxes", 49) && !isPromptPosition("people", 48) && !isPromptPosition("companies", 24) && !isPromptPosition("x", 60));

  section("B2. An edit compiled in memory");
  const text = "[fx:P60] business={{Company}}; Describe {{Company}} in {{Use City}}, in one line.";
  const f60 = textToPrompt(text, cat60).formula;
  const f61 = textToPrompt("[fx:P61] business={{Company}}; summary={{Claygent.company_summary}}; One short question.", cat61).formula;
  const edited = compileTemplates(withPromptOverrides(fixture, [{ template_kind: "people", position: 60, formula: f60 }, { template_kind: "people", position: 61, formula: f61 }], { variant: "xq1_memory" }));
  const o60 = colOf(fixtureCompiled, "people", "claygent");
  const e60 = colOf(edited, "people", "claygent");
  const e61 = colOf(edited, "people", "question_ai");
  const rendered = evaluate(makeContext(), e60.inputs.prompt, emptyAsText({ company: "Acme", use_city: "Springfield" }));
  check("the edited step: its prompt is the edit (refs rewritten to keys), its memory key follows it, prompt_source edited",
    rendered === "[fx:P60] business=Acme; Describe Acme in Springfield, in one line." && e60.inputs.memory_key === e60.inputs.prompt && e60.inputs.prompt !== o60.inputs.prompt &&
      e60.config.prompt_source === "edited" && o60.config.prompt_source === "clay", JSON.stringify({ rendered, src: e60.config.prompt_source }));
  check("... everything else is the original's: model setting, tool, answer fields, run condition, memory kind",
    same({ ...e60.config, prompt_source: null }, { ...o60.config, prompt_source: null }) && e60.run_if === o60.run_if && e60.config.model_setting === "people_claygent" && e60.clay_field_id === o60.clay_field_id);
  const o61 = colOf(fixtureCompiled, "people", "question_ai");
  check("the question step keeps its table examples: the same examples sha, a memory key of the new prompt and the examples",
    e61.config.examples_sha === o61.config.examples_sha && e61.config.examples_count === 1 && e61.inputs.memory_key.includes(`examples:${o61.config.examples_sha}`) &&
      e61.inputs.memory_key !== o61.inputs.memory_key && e61.config.prompt_source === "edited");
  const others = (set) => [...set.companies, ...set.inboxes, ...set.people].filter((c) => !["claygent", "question_ai"].includes(c.key) || c.action !== "ai_web" || !set.people.includes(c));
  check("no other column changes", canon(others(edited)) === canon(others(fixtureCompiled)));

  section("B3. Whose text runs: the text variant");
  const onDefault = new Map([...fixture].map(([k, r]) => [k, { ...r, text_variant: "default" }])); // as composed from a base
  const plain = compileTemplates(onDefault);
  const one60 = compileTemplates(withPromptOverrides(onDefault, [{ template_kind: "people", position: 60, formula: f60 }], { variant: "xq1x" }));
  const tv = (set, kind, key) => colOf(set, kind, key)?.config?.text_variant;
  check("on the default's text, before any edit: every personalisation step reads default", ["email_domain", "email_provider_check_api", "claygent", "question_ai", "question"].every((k) => tv(plain, "people", k) === "default"));
  check("an edited research step and the steps of its kind with no client text become the client's; the unedited question AI keeps default; General is untouched",
    tv(one60, "people", "claygent") === "xq1x" && ["email_domain", "email_provider_check_api", "question"].every((k) => tv(one60, "people", k) === "xq1x") &&
      tv(one60, "people", "question_ai") === "default" && ["email_domain", "claygent", "question_ai", "question"].every((k) => tv(one60, "inboxes", k) === "default"));
  const ps = (shared) => settingsFrom([{ key: "personalisation", value: { enabled: true, tags: ["XQ1X"], shared_text_ok: shared } }]);
  const runs = (set, key, shared) => flagOn(ps(shared), "personalisation", "XQ1X", { variant: tv(set, "people", key) });
  check("so for a listed client without shared text: the edited step runs, the default's question AI doesn't; with shared text both do",
    runs(one60, "claygent", false) && runs(one60, "email_provider_check_api", false) && !runs(one60, "question_ai", false) && runs(one60, "question_ai", true) && !runs(plain, "claygent", false));
  const noVariant = compileTemplates(withPromptOverrides(onDefault, [{ template_kind: "people", position: 60, formula: f60 }], { variant: null }));
  check("a tag with no variant name: the text variant is left as it was", tv(noVariant, "people", "claygent") === "default" && colOf(noVariant, "people", "claygent").config.prompt_source === "edited");

  section("B4. applyPromptOverrides: each edit kept only when it compiles");
  const broken = { template_kind: "people", position: 61, formula: '"x" + Clay.formatForAIPrompt({{f_xq1_nowhere}})' };
  const notEditor = { template_kind: "inboxes", position: 49, formula: '"x" + ({{f_fxG12}} ? "a" : "b")' };
  const notEditable = { template_kind: "people", position: 27, formula: '"x"' };
  const good = { template_kind: "people", position: 60, formula: f60 };
  const r = applyPromptOverrides(fixture, [good, broken, notEditor, notEditable], { tag: "XQ1X" });
  const why = (k, p) => r.skipped.find((s) => s.template_kind === k && s.position === p)?.reason ?? "";
  check("a good edit applied; one reading a column no template maps, one not of the editor's shape and one at a step that is not editable: left out, each with why",
    r.applied.length === 1 && r.applied[0].position === 60 && r.skipped.length === 3 && /^it does not compile: .*f_xq1_nowhere/.test(why("people", 61)) &&
      /not one the editor writes/.test(why("inboxes", 49)) && /not one of the editable prompts/.test(why("people", 27)),
    JSON.stringify(r.skipped));
  const rc = compileTemplates(r.originals);
  check("... the good one compiled in, the broken one's step compiled from its original", colOf(rc, "people", "claygent").config.prompt_source === "edited" &&
    colOf(rc, "people", "question_ai").inputs.prompt === colOf(fixtureCompiled, "people", "question_ai").inputs.prompt && colOf(rc, "people", "question_ai").config.prompt_source === "clay");
  check("no edits: the originals given back as they are", applyPromptOverrides(fixture, [], { tag: "XQ1X" }).originals === fixture);
}

// ── C. The compile hook on the local database ───────────────────────────────

const colIn = (tag, kind, key) =>
  one(`SELECT c.inputs, c.config, c.run_if FROM enrich_columns c JOIN enrich_tables t ON t.id = c.table_id WHERE t.client_tag = $1 AND t.kind = $2 AND t.template IS NOT NULL AND c.key = $3`, [tag, kind, key]);
const noteOf = async (tag, kind) => (await one(`SELECT source_note FROM enrich_tables WHERE client_tag = $1 AND kind = $2 AND template IS NOT NULL`, [tag, kind]))?.source_note ?? null;

async function partC() {
  section("C1. An edit saved and compiled into the client's tables");
  const first = await inTx(pool, (c) => ensurePipelineTables(c, A));
  const plain60 = await colIn(A, "people", "claygent");
  check("before any edit: prompt_source clay on the four steps, nothing applied or left out",
    plain60?.config?.prompt_source === "clay" && (await colIn(A, "inboxes", "question_ai"))?.config?.prompt_source === "clay" && first.prompts.applied.length === 0 && first.prompts.skipped.length === 0);
  const base = await promptBase(pool, A);
  const text = "[fx:P60] business={{Company}}; Describe {{Company}} in {{Use City}}, in one line.";
  const saved = await inTx(pool, async (c) => {
    await lockPipelineTables(c, A);
    return savePromptOverride(c, { tag: A, kind: "people", position: 60, text, version: null, userId: USER, base });
  });
  const row = await one(`SELECT prompt_text, formula, version FROM enrich_prompt_overrides WHERE client_tag = $1 AND template_kind = 'people' AND position = 60`, [A]);
  check("saved: version 1, the text as typed, the expression written by the server", saved.saved === true && saved.version === 1 && row?.prompt_text === text && row.version === 1 &&
    row.formula === textToPrompt(text, promptCatalogue(base.compiled.people, base.originals, "people", "claygent")).formula, JSON.stringify(saved));
  const again = await inTx(pool, (c) => ensurePipelineTables(c, A));
  const e60 = await colIn(A, "people", "claygent");
  const expected = colOf(compileTemplates(withPromptOverrides(base.originals, [{ template_kind: "people", position: 60, formula: row.formula }], { variant: "xq1a" })), "people", "claygent");
  check("compiled: the stored column is the in-memory compile of the edit (prompt, memory key, prompt_source edited, text_variant the client's)",
    same(e60.inputs, expected.inputs) && same(e60.config, expected.config) && e60.config.prompt_source === "edited" && e60.config.text_variant === "xq1a" &&
      e60.inputs.memory_key !== plain60.inputs.memory_key && again.prompts.applied.join() === "P#60" && variantOfNote(await noteOf(A, "people")) === "xq1a",
    JSON.stringify({ applied: again.prompts.applied, src: e60?.config?.prompt_source }));
  check("... rendering the edit", evaluate(makeContext(), e60.inputs.prompt, emptyAsText({ company: "Acme", use_city: "Springfield" })) === "[fx:P60] business=Acme; Describe Acme in Springfield, in one line.");
  check("... the other steps as they were", same((await colIn(A, "people", "question_ai")).inputs, colOf(compileTemplates(base.originals), "people", "question_ai").inputs) &&
    (await colIn(A, "people", "question_ai")).config.prompt_source === "clay");

  section("C2. Reset: the original comes back");
  await pool.query(`DELETE FROM enrich_prompt_overrides WHERE client_tag = $1`, [A]);
  await inTx(pool, (c) => ensurePipelineTables(c, A));
  const back = await colIn(A, "people", "claygent");
  check("with the edit deleted, the next compile gives the original's column back exactly", same(back.inputs, plain60.inputs) && same(back.config, plain60.config) && back.config.prompt_source === "clay");

  section("C3. A broken edit is left out on its own, with a note");
  const f48 = textToPrompt("[fx:G48] business={{Company}}; A short summary.", promptCatalogue(base.compiled.inboxes, base.originals, "inboxes", "claygent")).formula;
  await pool.query(
    `INSERT INTO enrich_prompt_overrides (client_tag, template_kind, position, prompt_text, formula, updated_by)
     VALUES ($1, 'people', 61, 'made-up broken edit', $2, $3), ($1, 'inboxes', 48, 'made-up good edit', $4, $3)`,
    [A, '"x " + Clay.formatForAIPrompt({{f_xq1_nowhere}})', USER, f48]
  );
  const fell = await inTx(pool, (c) => ensurePipelineTables(c, A));
  const pNote = await noteOf(A, "people");
  const gNote = await noteOf(A, "inboxes");
  check("the broken People edit is not applied, the General one is; the client is not sent back to the default",
    fell.variant === "xq1a" && fell.fallback === null && fell.prompts.applied.join() === "G#48" && fell.prompts.skipped.length === 1 && fell.prompts.skipped[0].position === 61,
    JSON.stringify(fell.prompts));
  check("... the People table's note says so after the usual note, and still names the variant; the General table's note is the usual one",
    pNote?.startsWith("Pipeline template people_v1, compiled from the Clay originals (variant xq1a); prompt edits not applied, the Clay original runs instead: P#61 (") &&
      variantOfNote(pNote) === "xq1a" && gNote === "Pipeline template inboxes_v1, compiled from the Clay originals (variant xq1a)", JSON.stringify({ pNote, gNote }));
  check("... P#61 compiled from its original, G#48 from the edit",
    (await colIn(A, "people", "question_ai")).config.prompt_source === "clay" && (await colIn(A, "inboxes", "claygent")).config.prompt_source === "edited");
  const views = promptColumnViews(await promptBase(pool, A), await promptOverrideRows(pool, A));
  const v61 = views.find((v) => v.kind === "people" && v.position === 61);
  const v48 = views.find((v) => v.kind === "inboxes" && v.position === 48);
  check("the editor's view: P#61 edited with a problem saying the original runs, G#48 edited with none", v61.source === "edited" && /Clay original runs instead/.test(v61.problem ?? "") &&
    v61.text === "made-up broken edit" && v48.source === "edited" && v48.problem === null);
  await pool.query(`DELETE FROM enrich_prompt_overrides WHERE client_tag = $1`, [A]);
  await inTx(pool, (c) => ensurePipelineTables(c, A));
  check("with both deleted, the note is the usual one again", (await noteOf(A, "people")) === "Pipeline template people_v1, compiled from the Clay originals (variant xq1a)");

  section("C4. A client on the default's text (a General-only overlay over a made-up base)");
  const bBase = await promptBase(pool, B, { base: BASE });
  const f60 = textToPrompt("[fx:P60] business={{Company}}; One line on {{Company}}.", promptCatalogue(bBase.compiled.people, bBase.originals, "people", "claygent")).formula;
  await pool.query(`INSERT INTO enrich_prompt_overrides (client_tag, template_kind, position, prompt_text, formula, updated_by) VALUES ($1, 'people', 60, 'made-up', $2, $3)`, [B, f60, USER]);
  const bt = await inTx(pool, (c) => ensurePipelineTables(c, B, { base: BASE }));
  const tvB = async (kind, key) => (await colIn(B, kind, key))?.config?.text_variant;
  check("its People research edited: that step and the People steps with no client text read the client's variant, the question AI keeps default",
    bt.variant === "xq1b" && (await tvB("people", "claygent")) === "xq1b" && (await tvB("people", "email_domain")) === "xq1b" && (await tvB("people", "email_provider_check_api")) === "xq1b" &&
      (await tvB("people", "question")) === "xq1b" && (await tvB("people", "question_ai")) === "default");
  check("... its own General text unchanged (the overlay's variant)", (await tvB("inboxes", "claygent")) === "xq1b" && (await tvB("inboxes", "question_ai")) === "xq1b");
  const bViews = promptColumnViews(bBase, await promptOverrideRows(pool, B));
  const src = (kind, p) => bViews.find((v) => v.kind === kind && v.position === p)?.source;
  check("the editor's sources: People research edited, People question AI the default's, General the client's own Clay text",
    src("people", 60) === "edited" && src("people", 61) === "default" && src("inboxes", 48) === "client" && src("inboxes", 49) === "client", JSON.stringify(bViews.map((v) => v.source)));
}

// ── D. The route ────────────────────────────────────────────────────────────

const loader = routeLoader(USER);
const { T, route, call } = loader;

async function partD() {
  section("D1. Roles, shapes and refusals");
  await pool.query(`DELETE FROM enrich_prompt_override_log WHERE client_tag = ANY($1::text[])`, [TAGS]); // part C's save
  const R = await route("enrich/prompts");
  T.role = "viewer";
  const viewer = await call(R.GET, { query: { tag: C } });
  T.role = null;
  const anon = await call(R.GET, { query: { tag: C } });
  T.role = "manager";
  const get = await call(R.GET, { query: { tag: C } });
  check("GET: 403 for a viewer, 401 without a session", viewer.status === 403 && anon.status === 401);
  const cols = get.body?.columns ?? [];
  check("GET (manager): the four steps in order, for a client with no tables yet", get.status === 200 && get.body.tag === C &&
    cols.map((c) => `${c.kind}:${c.position}:${c.role}:${c.key}`).join() === "people:60:research:claygent,people:61:question:question_ai,inboxes:48:research:claygent,inboxes:49:question:question_ai" &&
    (await one(`SELECT count(*)::int AS n FROM enrich_tables WHERE client_tag = $1`, [C])).n === 0, JSON.stringify(get.body).slice(0, 400));
  const c60 = cols[0] ?? {};
  check("... each with its source (the client's own Clay text), the text, the original as text, placeholders, no version",
    cols.every((c) => c.source === "client" && typeof c.text === "string" && c.text === c.originalText && c.originalAdvanced === false && c.version === null && c.updatedAt === null && c.updatedBy === null && c.problem === null) &&
      c60.placeholders.some((p) => p.name === "Company" && !p.fields) && cols[1].placeholders.some((p) => p.name === "Claygent" && p.fields?.includes("company_summary")) &&
      get.body.personalisation.enabled === false && get.body.personalisation.listed === false && get.body.personalisation.sharedTextOk === false);
  check("... and no expression or field id in the answer", !JSON.stringify(get.body).includes("formatForAIPrompt") && !/\{\{f_/.test(JSON.stringify(get.body)));
  check("GET: 400 for a bad tag, 404 for a tag that is no client", (await call(R.GET, { query: { tag: "bad tag!" } })).status === 400 && (await call(R.GET, { query: { tag: "XQ1Z" } })).status === 404);

  const put = (body) => call(R.PUT, { body });
  const del = (body) => call(R.DELETE, { body });
  T.role = "manager";
  const mgr = await put({ tag: A, kind: "people", position: 60, text: "x", version: null });
  check("PUT and DELETE: 403 below admin", mgr.status === 403 && (await del({ tag: A, kind: "people", position: 60, version: null })).status === 403);
  T.role = "admin";
  const refusals = await Promise.all([
    put({ tag: A, kind: "companies", position: 24, text: "x", version: null }),
    put({ tag: A, kind: "people", position: 59, text: "x", version: null }),
    put({ tag: A, kind: "people", position: 60, text: "x" }),
    put({ tag: A, kind: "people", position: 60, version: null }),
    put({ tag: "XQ1Z", kind: "people", position: 60, text: "x", version: null }),
  ]);
  check("400 for another kind or position, a missing version or text; 404 for a tag that is no client",
    refusals.slice(0, 4).every((r) => r.status === 400) && refusals[4].status === 404, JSON.stringify(refusals.map((r) => [r.status, r.body?.error])));
  const badPh = await put({ tag: A, kind: "people", position: 60, text: "Hello {{Not A Column}} and {{Company.x}}", version: null });
  check("400 for placeholders the step can't read, each named in errors, nothing written",
    badPh.status === 400 && badPh.body.errors?.length === 2 && badPh.body.errors[0].includes("{{Not A Column}}") && badPh.body.errors[1].includes("{{Company.x}}") &&
      (await one(`SELECT count(*)::int AS n FROM enrich_prompt_overrides WHERE client_tag = $1`, [A])).n === 0, JSON.stringify(badPh.body));
  const later = await put({ tag: A, kind: "people", position: 60, text: "Reads {{Question}} first", version: null });
  check("... a later step can't be read (the question is after the research)", later.status === 400 && later.body.errors?.[0]?.includes("{{Question}}"), JSON.stringify(later.body));

  section("D2. Save, a stale version, reset");
  const text = "[fx:P60] business={{Company}}; Write two lines about {{Company}} in {{Use City}}.";
  T.audits = [];
  const s1 = await put({ tag: A, kind: "people", position: 60, text, version: null });
  const v1 = s1.body?.columns?.find((c) => c.kind === "people" && c.position === 60);
  check("saved: the GET shape with the edit (source edited, version 1, the text), saved and compiled again (the client has tables)",
    s1.status === 200 && s1.body.saved === true && s1.body.recompiled === true && s1.body.note === null && v1?.source === "edited" && v1.version === 1 && v1.text === text &&
      v1.updatedBy === null && typeof v1.updatedAt === "string" && v1.originalText !== text, JSON.stringify(s1.body).slice(0, 400));
  const stored = await colIn(A, "people", "claygent");
  check("... the client's table runs it now", stored.config.prompt_source === "edited" && evaluate(makeContext(), stored.inputs.prompt, emptyAsText({ company: "Acme", use_city: "Springfield" })) === "[fx:P60] business=Acme; Write two lines about Acme in Springfield.");
  const stale = await put({ tag: A, kind: "people", position: 60, text: `${text} Again.`, version: null });
  check("409 with changed when the version is not the edit's any more, nothing written", stale.status === 409 && stale.body.changed === true &&
    (await one(`SELECT version FROM enrich_prompt_overrides WHERE client_tag = $1 AND template_kind = 'people' AND position = 60`, [A])).version === 1, JSON.stringify(stale.body));
  const same1 = await put({ tag: A, kind: "people", position: 60, text, version: 1 });
  check("the same text again: nothing saved (version still 1), no audit line", same1.status === 200 && same1.body.saved === false &&
    same1.body.columns.find((c) => c.position === 60 && c.kind === "people").version === 1 && T.audits.length === 1);
  const s2 = await put({ tag: A, kind: "people", position: 60, text: `${text} Keep it short.`, version: 1 });
  check("a second save at version 1: version 2", s2.status === 200 && s2.body.saved === true && s2.body.columns.find((c) => c.position === 60 && c.kind === "people").version === 2);
  const staleDel = await del({ tag: A, kind: "people", position: 60, version: 1 });
  const reset = await del({ tag: A, kind: "people", position: 60, version: 2 });
  const r60 = reset.body?.columns?.find((c) => c.kind === "people" && c.position === 60);
  check("DELETE: 409 at a stale version; at the edit's version the original comes back (source client, no version)", staleDel.status === 409 && staleDel.body.changed === true &&
    reset.status === 200 && reset.body.saved === true && reset.body.recompiled === true && r60?.source === "client" && r60.version === null && r60.text === r60.originalText);
  check("... and the table runs the original again", (await colIn(A, "people", "claygent")).config.prompt_source === "clay");
  const nothing = await del({ tag: A, kind: "people", position: 60, version: null });
  check("nothing to reset: 200, nothing saved", nothing.status === 200 && nothing.body.saved === false);
  const log = await all(`SELECT action, before_text, after_text, by_user FROM enrich_prompt_override_log WHERE client_tag = $1 AND template_kind = 'people' AND position = 60 ORDER BY id`, [A]);
  check("the log: save, save, reset, with the text before and after and who", log.map((l) => l.action).join() === "save,save,reset" && log[0].before_text === null && log[0].after_text === text &&
    log[1].before_text === text && log[2].after_text === null && log.every((l) => l.by_user === USER), JSON.stringify(log.map((l) => l.action)));
  check("the audit lines: lengths only, never the text", T.audits.length === 3 && T.audits.every((a) => a.action === "enrich_prompt" && a.performedBy === USER && !a.details.includes("Write two lines") && !a.details.includes("{{")) &&
    /XQ1A P#60 \(research\): prompt saved, \d+ characters \(was the Clay original\), tables compiled again/.test(T.audits[0].details) && /reset to the Clay original/.test(T.audits[2].details),
    JSON.stringify(T.audits.map((a) => a.details)));
  const noTables = await put({ tag: C, kind: "inboxes", position: 49, text: "[fx:G49] business={{Company}}; One question.", version: null });
  check("a client with no tables: saved, not compiled, and the note says when it applies", noTables.status === 200 && noTables.body.saved === true && noTables.body.recompiled === false &&
    /no pipeline tables yet/.test(noTables.body.note ?? "") && (await one(`SELECT count(*)::int AS n FROM enrich_tables WHERE client_tag = $1`, [C])).n === 0);
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query(`DELETE FROM enrich_tables WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM enrich_prompt_overrides WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM enrich_prompt_override_log WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM enrich_originals WHERE variant LIKE $1`, [VARIANT_LIKE]);
  await pool.query(`DELETE FROM enrich_memory WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[]) AND name LIKE 'Prompt test %'`, [TAGS]);
}

const t0 = Date.now();
let clean = false;
let started = false;
try {
  const ready = await one(`SELECT to_regclass('public.enrich_prompt_overrides') IS NOT NULL AND to_regclass('public.enrich_prompt_override_log') IS NOT NULL AS ok`);
  if (!ready.ok) throw new Error("migration 139 is not in this database");
  const s = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
  const listed = ["company_pipeline", "people_pipeline", "personalisation", "promotion"].filter((k) => s[k]?.tags?.length);
  if (listed.length) throw new Error(`Refusing to run: a client is on the ${listed.join(", ")} list(s)`);
  const held = await one(`SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id WHERE r.run_status = 'held' AND NOT starts_with(t.client_tag, $1)`, [PREFIX]);
  if (held.n) throw new Error(`Refusing to run: ${held.n} held row(s) exist outside ${PREFIX}`);
  const real = await one(`SELECT count(*)::int AS n FROM client_tags WHERE starts_with(tag, $1) AND NOT (tag = ANY($2::text[]) AND name LIKE 'Prompt test %')`, [PREFIX, TAGS]);
  if (real.n) throw new Error(`Refusing to run: ${real.n} client tag(s) start with ${PREFIX} and are not this test's`);
  started = true;
  await cleanup(); // anything an interrupted run left behind
  partA();
  partB();
  await pool.query(`INSERT INTO client_tags (tag, name, status) VALUES ($1, 'Prompt test A', 'Active'), ($2, 'Prompt test B', 'Active'), ($3, 'Prompt test C', 'Active')`, [A, B, C]);
  await seedFixtureVariant(pool, A);
  await seedFixtureVariant(pool, C);
  await inTx(pool, (c) => seedOriginals(c, { exports: fixtureSeedExports(), variant: BASE, seededBy: "tests" }));
  await pool.query(
    `INSERT INTO enrich_originals (variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition, unknown_refs, source_sha256, seeded_by)
     SELECT 'xq1b', template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition, unknown_refs, source_sha256, 'tests (overlay)'
       FROM enrich_originals WHERE variant = $1 AND template_kind = 'inboxes' AND position BETWEEN 45 AND 50`,
    [BASE]
  );
  await partC();
  await partD();
  check("nothing tried to reach any address", net.calls.refused === 0 && Object.values(net.calls).every((n) => n === 0), JSON.stringify(net.calls));
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  if (started) await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM enrich_tables WHERE client_tag = ANY($1::text[])) AS tables,
            (SELECT count(*)::int FROM enrich_originals WHERE variant LIKE $2) AS originals,
            (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[]) AND name LIKE 'Prompt test %') AS clients,
            (SELECT count(*)::int FROM enrich_prompt_overrides WHERE client_tag = ANY($1::text[])) AS edits,
            (SELECT count(*)::int FROM enrich_prompt_override_log WHERE client_tag = ANY($1::text[])) AS log`,
    [TAGS, VARIANT_LIKE]
  ).catch(() => null);
  clean = Boolean(left) && Object.values(left).every((n) => n === 0);
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify(left)}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
