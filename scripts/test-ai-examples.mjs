#!/usr/bin/env node
// Clay's table examples sent with an AI column's prompt (P#61, G#49, G#19):
// their layout (ai-examples.mjs), the compiled columns (compile-original.mjs),
// the request (actions.mjs aiWeb) and rows worked in memory by the engine.
// Everything is compiled in memory from the made-up originals
// (scripts/fixtures/clay-originals): no table, column, originals variant or
// setting is written.
//
//   node --env-file=.env.local scripts/test-ai-examples.mjs
//
// LOCAL DATABASE ONLY, and only for what the engine writes while it works a
// row in memory: the shared answers (enrich_memory) of a made-up client
// (CXTEST_A, never added to client_tags), Reoon's verdicts on its made-up
// addresses (.cxtest.example) and today's spend. All three are put back at
// the end. Stop the enrichment worker first. The run refuses while any client
// is on the company_pipeline, people_pipeline, personalisation or promotion
// lists, or while any held row exists outside its own tags.
//
// Nothing here reaches a network: fetch answers OpenAI, Reoon and Google's
// DNS from stubs (scripts/fixtures/test-support.mjs) and refuses and counts any
// other address. No paid key is read from the environment; the keys here are
// made up.
//
//   A. the layout on the made-up originals, and every way an example is read or refused
//   B. the compiled columns: P#61 and G#49 from the templates, G#19 from a test
//      spec, the memory key, every other AI column unchanged
//   C. aiWeb's request: the instructions, the run record, the two skip notes,
//      no instructions without examples
//   D. rows worked in memory: G#49 off and on, sent once then remembered, other
//      examples asking again, an upload People row never sending P#61

import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { checker, dropPaidKeys, installNet, localDatabaseUrl } from "./fixtures/test-support.mjs";
import { FIXTURE_MARKER, fixtureSeedExports } from "./fixtures/clay-originals/fixtures.mjs";
import { originalRows, originalsMap } from "./lib/enrich/seed-originals.mjs";
import { bindingText, compileColumn, refMap } from "./lib/enrich/compile-original.mjs";
import { compileTemplates, variantName } from "./lib/enrich/templates.mjs";
import { INBOX_REFS } from "./lib/enrich/inbox-template.mjs";
import { EXAMPLES_PREAMBLE, examplesFor } from "./lib/enrich/ai-examples.mjs";
import { ACTIONS } from "./lib/enrich/actions.mjs";
import { memoryKey, runRow } from "./lib/enrich/engine.mjs";
import { emptyAsText, evaluate, makeContext, order, refs } from "./lib/enrich/formula.mjs";
import { settingsFrom } from "./lib/enrich/settings.mjs";
import { UPLOAD_FOUND_BY } from "./lib/enrich/upload-people.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

const PREFIX = "CXTEST_";
const TAG = `${PREFIX}A`;
const VARIANT = variantName(TAG);
const RUN = randomUUID().slice(0, 6);
const HOST = "cxtest.example";
const dom = (slug) => `${slug}-${RUN}.${HOST}`;
const COMPANY = `CXTEST Widget Works ${RUN}`;
const KEYS = { OPENAI_API_KEY: "made-up-cxtest-openai", ENRICH_REOON_API_KEY: "made-up-cxtest-reoon" };
const HIGH_CAPS = { reoon_checks_per_day: 100_000, openai_usd_per_day: { pipeline: 10_000, fit: 10_000 } };
const SWITCH_LISTS = ["company_pipeline", "people_pipeline", "personalisation", "promotion"];
const CREATED = new Date("2026-11-21T00:00:00Z");

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha16 = (t) => createHash("sha256").update(t).digest("hex").slice(0, 16);

// ── The made-up originals ───────────────────────────────────────────────────

const originals = originalsMap(originalRows(fixtureSeedExports()));
const defOf = (at) => originals.get(at).definition;

/** A definition with its tableExamples binding's text replaced (a list is written as JSON), or removed for null. */
function withExamples(def, examples) {
  const rest = def.settings.inputsBinding.filter((b) => b.name !== "tableExamples");
  const formulaText = typeof examples === "string" ? examples : JSON.stringify(examples);
  return { ...def, settings: { ...def.settings, inputsBinding: examples === null ? rest : [...rest, { name: "tableExamples", formulaText, optional: false }] } };
}
/** The originals with one column's definition (or name) replaced: a variant in memory. */
function variantWith(at, change) {
  const out = new Map(originals);
  out.set(at, { ...originals.get(at), ...change });
  return out;
}
/** Every original with no tableExamples binding: what the compiler gave before the examples were laid out. */
const stripped = new Map([...originals].map(([k, r]) => [k, r.definition?.settings?.inputsBinding ? { ...r, definition: withExamples(r.definition, null) } : r]));

/** G#19 compiled as an AI column (its template line is Builder T's; on this branch the template keeps it waiting). */
const G19_SPEC = { key: "first_name_ai", from: "G#19", kind: "action", action: "ai_web", model_setting: "inbox_question_ai", tool: "none" };
const compileG19 = (o = originals) => compileColumn(G19_SPEC, o, { own: refMap(o, "inboxes", INBOX_REFS) });

const EXAMPLE_KEYS = ["table_examples", "run_budget", "examples_text", "examples_count", "examples_sha", "examples_error"];
const withoutExampleKeys = (config) => Object.fromEntries(Object.entries(config).filter(([k]) => !EXAMPLE_KEYS.includes(k)));

// ── A. The layout ───────────────────────────────────────────────────────────

function partA() {
  section("A1. The made-up originals' three columns, exactly");
  check("the sentence in front of the examples",
    EXAMPLES_PREAMBLE === "Examples from other rows of this table. Each example is that row's inputs as JSON, keyed by column name, then the answer expected for it as JSON.");
  const g19 = examplesFor(defOf("inboxes:19"), originals, "inboxes", "response");
  const g19Text = `${EXAMPLES_PREAMBLE}\n\n{"Guessed Name":"Made Upname","General Email":"madeup@${FIXTURE_MARKER}.example"}\n{"response":"${FIXTURE_MARKER} example answer"}`;
  check("G#19: its inputs by column name (Guessed Name, General Email, in stored order), then its answer", g19.text === g19Text && g19.count === 1, JSON.stringify(g19));
  const g49 = examplesFor(defOf("inboxes:49"), originals, "inboxes", "response");
  check("G#49", g49.text === `${EXAMPLES_PREAMBLE}\n\n{"Company":"Made-up Widget Shop"}\n{"response":"${FIXTURE_MARKER} example question?"}` && g49.count === 1, JSON.stringify(g49));
  const p61 = examplesFor(defOf("people:61"), originals, "people", "response");
  check("P#61: People's own column names (Company, Title)",
    p61.text === `${EXAMPLES_PREAMBLE}\n\n{"Company":"Made-up Widget Shop","Title":"Owner"}\n{"response":"${FIXTURE_MARKER} example question?"}` && p61.count === 1, JSON.stringify(p61));
  const again = examplesFor(defOf("inboxes:19"), originals, "inboxes", "response");
  check("the sha is the text's sha256 (16 hex), the same each time, and differs per text",
    /^[0-9a-f]{16}$/.test(g19.sha) && g19.sha === sha16(g19Text) && again.sha === g19.sha && new Set([g19.sha, g49.sha, p61.sha]).size === 3);
  check("no recordId and no field id reach the text", ![g19, g49, p61].some((r) => /fx-example|f_fx|\{\{/.test(r.text)));

  section("A2. References, paths and names (in-memory variants)");
  const def49 = defOf("inboxes:49");
  const read = (examples, o = originals, kind = "inboxes", field = "response") => examplesFor(withExamples(def49, examples), o, kind, field);
  const body = (r) => (r.text ?? "").slice(EXAMPLES_PREAMBLE.length + 2);
  const field = read([{ inputs: { "{{f_fxG12}}": "CXTEST Widget Works", "{{f_fxG48}}?.company_summary": "Makes made-up widgets." }, output: "A made-up question?" }]);
  check("a ?.field reference: the column's name, a dot and the field",
    body(field) === '{"Company":"CXTEST Widget Works","Claygent.company_summary":"Makes made-up widgets."}\n{"response":"A made-up question?"}', body(field));
  const paths = read([{ inputs: { '{{f_fxG48}}?.["a b"]': "1", "{{f_fxG48}}.x": "2", "{{f_fxG48}}['single q']": "3", "{{f_fxG48}}?.[0]": "4", "{{ f_fxG48 }}?.y?.z": "5" }, output: "q" }]);
  check("bracket and dotted paths: each step joined with dots",
    body(paths) === '{"Claygent.a b":"1","Claygent.x":"2","Claygent.single q":"3","Claygent.0":"4","Claygent.y.z":"5"}\n{"response":"q"}', body(paths));
  const twice = read([{ inputs: { "{{f_fxG48}}?.x": "1", "{{f_fxG48}}.x": "2" }, output: "q" }]);
  check("two references with one name: the second gets \" (2)\"", body(twice) === '{"Claygent.x":"1","Claygent.x (2)":"2"}\n{"response":"q"}', body(twice));
  const renamed = variantWith("inboxes:22", { name: "Company" });
  const dup = read([
    { inputs: { "{{f_fxG12}}": "a", "{{f_fxG22}}": "b" }, output: "first" },
    { inputs: { "{{f_fxG22}}": "c", "{{f_fxG12}}": "d" }, output: "second" },
  ], renamed);
  check("two columns with one name: \" (2)\" for the one first seen second, kept for it in every example, each example in its stored order",
    body(dup) === '{"Company":"a","Company (2)":"b"}\n{"response":"first"}\n\n{"Company (2)":"c","Company":"d"}\n{"response":"second"}' && dup.count === 2, body(dup));
  const triple = read([{ inputs: { "{{f_fxG48}}?.x": "1", "{{f_fxG48}}.x": "2", "{{f_fxG48}}['x']": "3" }, output: "q" }]);
  check("... and \" (3)\" for a third", body(triple) === '{"Claygent.x":"1","Claygent.x (2)":"2","Claygent.x (3)":"3"}\n{"response":"q"}', body(triple));
  const unsorted = read([{ inputs: { "{{f_fxG48}}?.company_summary": "s", "{{f_fxG12}}": "c" }, output: "q" }]);
  check("keys stay in stored order (never sorted)", body(unsorted).startsWith('{"Claygent.company_summary":"s","Company":"c"}'), body(unsorted));
  const nulls = read([{ inputs: { "{{f_fxG12}}": null, "{{f_fxG13}}": "" }, output: null }]);
  check("a null input and a null output are \"\"", body(nulls) === '{"Company":"","General Email":""}\n{"response":""}', body(nulls));
  const noInputs = read([{ inputs: {}, output: "q" }]);
  check("an example with an empty inputs object is {}", body(noInputs) === '{}\n{"response":"q"}', body(noInputs));
  const otherField = read([{ inputs: { "{{f_fxG12}}": "c" }, output: "q" }], originals, "inboxes", "answer");
  check("the answer is keyed by the column's first answer field", body(otherField).endsWith('{"answer":"q"}'), body(otherField));
  const quoted = read([{ inputs: { "{{f_fxG12}}": 'Say "hi"\nthen go' }, output: "q" }]);
  check("values are JSON-escaped, so a quote or a line break stays inside its example", body(quoted) === '{"Company":"Say \\"hi\\"\\nthen go"}\n{"response":"q"}', body(quoted));

  section("A3. Refused, never guessed: { error } and nothing else");
  const err = (r, e) => same(r, { error: e });
  check("not JSON", err(read("{not json"), "not JSON") && err(read(""), "not JSON"));
  check("not a list", err(read({ inputs: {} }), "not a list") && err(read('"a string"'), "not a list"));
  const noObject = [[{ output: "q" }], [{ inputs: null, output: "q" }], [{ inputs: [], output: "q" }], [{ inputs: "text" }], [null], ["text"], [[{ inputs: {} }]]];
  check("an example with no inputs object (missing, null, a list, a text; the example itself not an object)",
    noObject.every((x) => err(read(x), "an example has no inputs object")), JSON.stringify(noObject.map((x) => read(x))));
  const NOT_HELD = "an example reads a column this table does not hold";
  const notHeld = [
    { "{{f_nope}}": "x" }, // no column has this id
    { "{{f_fxP28}}": "x" }, // a People column, in a General column's examples
    { Company: "x" }, // not a reference
    { "{{f_fxG48}}?.x()": "x" }, // a path that can't be read
    { "{{f_fxG48}} + 1": "x" },
  ];
  check("a reference to no column of the table (an unknown id, another table's column, not a reference, an unreadable path)",
    notHeld.every((inputs) => err(read([{ inputs, output: "q" }]), NOT_HELD)), JSON.stringify(notHeld.map((inputs) => read([{ inputs, output: "q" }]))));
  check("one bad example refuses them all", err(read([{ inputs: { "{{f_fxG12}}": "ok" }, output: "q" }, { inputs: { "{{f_nope}}": "x" }, output: "q" }]), NOT_HELD));

  section("A4. No examples");
  check("an empty list: no text, count 0", same(read([]), { text: null, count: 0, sha: null }));
  check("no binding: the same", same(examplesFor(withExamples(def49, null), originals, "inboxes", "response"), { text: null, count: 0, sha: null }) &&
    same(examplesFor(defOf("inboxes:48"), originals, "inboxes", "response"), { text: null, count: 0, sha: null }));
}

// ── B. The compiled columns ─────────────────────────────────────────────────

/** The compiled columns, and the same compiled from the originals with no examples binding. */
const compiled = compileTemplates(originals);
const plain = compileTemplates(stripped);
const p61 = compiled.people.find((c) => c.key === "question_ai");
const g49 = compiled.inboxes.find((c) => c.key === "question_ai");
const g48 = compiled.inboxes.find((c) => c.key === "claygent");

function partB() {
  section("B1. P#61 and G#49 from the templates, G#19 from a test spec");
  const g19 = compileG19();
  const g19Plain = compileG19(stripped);
  const cases = [
    ["P#61", p61, defOf("people:61"), "people"],
    ["G#49", g49, defOf("inboxes:49"), "inboxes"],
    ["G#19", g19, defOf("inboxes:19"), "inboxes"],
  ];
  for (const [label, col, def, kind] of cases) {
    const ex = examplesFor(def, originals, kind, "response");
    check(`${label}: the examples' text, count and sha in config, the binding kept raw beside them, and no error`,
      col?.action === "ai_web" && col.config.examples_text === ex.text && col.config.examples_count === 1 && col.config.examples_sha === ex.sha &&
        col.config.table_examples === bindingText(def, "tableExamples") && col.config.run_budget === 0.1 && !("examples_error" in col.config),
      JSON.stringify({ count: col?.config?.examples_count, sha: col?.config?.examples_sha, error: col?.config?.examples_error }));
  }
  check("P#61 and G#49 keep their switch (personalisation) and answer one text field, response",
    [p61, g49].every((c) => same(c.config.flag, ["personalisation"]) && same(c.config.answer_order, ["response"])));
  check("G#19 compiles to ai_web on its model setting, with no tool and no switch",
    g19.action === "ai_web" && g19.config.model_setting === "inbox_question_ai" && g19.config.tool === "none" && !g19.config.flag && g19.clay_field_id === "f_fxG19");
  check("G#19's prompt, run condition, answer and memory kind are what they are without examples",
    g19.inputs.prompt === g19Plain.inputs.prompt && g19.run_if === g19Plain.run_if && same(g19.config.answer, g19Plain.config.answer) &&
      g19.config.memory === "inbox_question_ai_v1" && g19Plain.inputs.memory_key === g19Plain.inputs.prompt);

  section("B2. The memory key holds the examples");
  check("with examples: the prompt and the examples' sha, as the contract writes it",
    g19.inputs.memory_key === `[(${g19.inputs.prompt}\n), ${JSON.stringify(`examples:${g19.config.examples_sha}`)}].join("\\n")`, g19.inputs.memory_key);
  const values = emptyAsText({ guessed_name: "Ann Example", general_email: `ann@${dom("widget")}` });
  const ctx = makeContext();
  const prompt = evaluate(ctx, g19.inputs.prompt, values);
  const key = evaluate(ctx, g19.inputs.memory_key, values);
  check("... which works out to the rendered prompt, a line break and examples:<sha>", key === `${prompt}\nexamples:${g19.config.examples_sha}` && prompt.includes("[fx:G19]"), JSON.stringify(key));
  const other = compileG19(variantWith("inboxes:19", { definition: withExamples(defOf("inboxes:19"), [{ inputs: { "{{f_fxG18}}": "Other Name" }, output: "Other" }]) }));
  const sameSet = compileG19(variantWith("inboxes:19", { definition: structuredClone(defOf("inboxes:19")) }));
  const otherKey = evaluate(ctx, other.inputs.memory_key, values);
  check("other examples, the same prompt: another memory key (so another client's examples never reuse an answer)",
    other.inputs.prompt === g19.inputs.prompt && other.inputs.memory_key !== g19.inputs.memory_key && otherKey !== key &&
      memoryKey(otherKey, { model: "gpt-6-luna" }) !== memoryKey(key, { model: "gpt-6-luna" }));
  check("the same examples: the same memory key", sameSet.inputs.memory_key === g19.inputs.memory_key && same(sameSet.config, g19.config));
  const empty = compileG19(variantWith("inboxes:19", { definition: withExamples(defOf("inboxes:19"), []) }));
  check("an empty list: count 0, no text, the memory key the prompt alone",
    empty.config.examples_count === 0 && empty.config.examples_text === null && empty.config.examples_sha === null && empty.config.table_examples === "[]" && empty.inputs.memory_key === empty.inputs.prompt);
  const bad = compileG19(variantWith("inboxes:19", { definition: withExamples(defOf("inboxes:19"), "{not json") }));
  check("unreadable examples still compile: the error in config, the binding raw, no text, the memory key the prompt alone",
    bad.config.examples_error === "not JSON" && bad.config.table_examples === "{not json" && !("examples_text" in bad.config) && !("examples_count" in bad.config) &&
      bad.inputs.memory_key === bad.inputs.prompt && bad.action === "ai_web");
  check("the examples never reach the inputs (only their sha, in the memory key)",
    [p61, g49, g19].every((c) => !Object.values(c.inputs).some((v) => String(v).includes("Made-up Widget Shop") || String(v).includes("Made Upname"))));

  section("B3. Every other AI column is byte for byte what a compile without examples gives");
  const ai = (set) => [...set.companies, ...set.inboxes, ...set.people].filter((c) => c.action === "ai_web");
  const withEx = ai(compiled).filter((c) => c.config.table_examples != null);
  const others = ai(compiled).filter((c) => c.config.table_examples == null);
  const plainOf = (c) => ai(plain).find((p) => p.key === c.key && p.clay_field_id === c.clay_field_id);
  const differ = others.filter((c) => JSON.stringify(c) !== JSON.stringify(plainOf(c)));
  check(`the ${others.length} AI columns without examples: every field, config and inputs byte for byte the same, no examples key, the memory key the prompt`,
    others.length === 10 && differ.length === 0 && others.every((c) => !EXAMPLE_KEYS.some((k) => k in c.config) && c.inputs.memory_key === c.inputs.prompt),
    `${others.length} others; differ: ${differ.map((c) => c.key).join(", ")}`);
  // P#61 and G#49 (and G#19 once its template line is an AI column, Builder T's).
  const exIds = withEx.map((c) => c.clay_field_id);
  check("P#61 and G#49: without the examples' keys, config and the prompt as without examples; only the memory key differs",
    exIds.includes("f_fxP61") && exIds.includes("f_fxG49") && exIds.every((id) => ["f_fxP61", "f_fxG49", "f_fxG19"].includes(id)) && withEx.every((c) => {
      const p = plainOf(c);
      return same(withoutExampleKeys(c.config), p.config) && c.inputs.prompt === p.inputs.prompt && p.inputs.memory_key === p.inputs.prompt &&
        c.inputs.memory_key !== c.inputs.prompt && same({ ...c, config: null, inputs: null }, { ...p, config: null, inputs: null });
    }), withEx.map((c) => c.key).join(", "));
  const nonAi = (set) => [...set.companies, ...set.inboxes, ...set.people].filter((c) => c.action !== "ai_web");
  check("no other column changes either", JSON.stringify(nonAi(compiled)) === JSON.stringify(nonAi(plain)));
}

// ── C. aiWeb's request ──────────────────────────────────────────────────────

const S = settingsFrom([]);
/** One direct call of ai_web (no database: no spend gate, no lost-send guard): its result and the requests it made. */
async function ask(config, prompt, column = { key: "question_ai" }) {
  const before = net.bodies.length;
  const res = await ACTIONS.ai_web.run({ inputs: { prompt, memory_key: prompt }, config, env: KEYS, settings: S, db: null, row: { id: 0 }, column });
  return { res, bodies: net.bodies.slice(before) };
}
const promptFor = (col, values) => evaluate(makeContext(), col.inputs.prompt, emptyAsText(values));

async function partC() {
  section("C1. With examples: the instructions, the prompt as the input");
  const prompt = promptFor(g49, { company: COMPANY, claygent: { company_summary: "Makes made-up widgets." } });
  net.openai.set(`G49|${COMPANY}`, { response: "Would a made-up question help?" });
  const a = await ask(g49.config, prompt);
  const b = a.bodies[0];
  check("one request: instructions the examples' text, input the prompt string, nothing else new",
    a.bodies.length === 1 && b.instructions === g49.config.examples_text && b.input === prompt && same(Object.keys(b), ["model", "instructions", "input", "text"]) &&
      b.model === "gpt-6-luna" && !b.tools, JSON.stringify(b && Object.keys(b)));
  check("the answer as before: done, the planned question", a.res.status === "done" && a.res.value?.response === "Would a made-up question help?" && a.res.display === "Would a made-up question help?");
  const rq = a.res.run?.request ?? {};
  check("the run record: the examples' count and the instructions beside the prompt",
    rq.examples === 1 && rq.instructions === g49.config.examples_text && rq.prompt === prompt && rq.model_setting === "inbox_question_ai", JSON.stringify(Object.keys(rq)));
  const long = `${EXAMPLES_PREAMBLE}\n\n${"x".repeat(9_000)}`;
  const l = await ask({ ...g49.config, examples_text: long, examples_count: 3 }, prompt);
  check("a long text: all of it sent, the first 8,000 characters kept in the run record",
    l.bodies[0]?.instructions === long && l.res.run?.request?.instructions === long.slice(0, 8_000) && l.res.run?.request?.examples === 3);

  section("C2. Without examples: exactly today's request");
  const noEx = plain.inboxes.find((c) => c.key === "question_ai");
  const n = await ask(noEx.config, prompt);
  check("G#49 compiled with no examples: no instructions, the same keys as before, no examples in the run record",
    n.bodies.length === 1 && !("instructions" in n.bodies[0]) && same(Object.keys(n.bodies[0]), ["model", "input", "text"]) && n.bodies[0].input === prompt &&
      !("examples" in (n.res.run?.request ?? {})) && !("instructions" in (n.res.run?.request ?? {})) && n.res.status === "done");
  check("... and its body is the body with examples less the instructions", same({ ...b, instructions: undefined }, { ...n.bodies[0], instructions: undefined }));
  const claygentPrompt = promptFor(g48, { company: COMPANY, use_domain: dom("widget") });
  const c = await ask(g48.config, claygentPrompt, { key: "claygent" });
  check("a Claygent column (no examples): its web search tool and most searches, no instructions",
    c.bodies.length === 1 && same(Object.keys(c.bodies[0]), ["model", "tools", "input", "max_tool_calls", "text"]) && c.bodies[0].tools?.[0]?.type === "web_search" && !("instructions" in c.bodies[0]));
  const zero = compileG19(variantWith("inboxes:19", { definition: withExamples(defOf("inboxes:19"), []) }));
  const z = await ask(zero.config, "[fx:G19] name=Zero Example; Is this a first name?");
  check("examples_count 0 (an empty list): it runs, with no instructions", z.res.status === "done" && z.bodies.length === 1 && !("instructions" in z.bodies[0]));
  const withTool = await ask({ ...g49.config, tool: "web_search" }, prompt);
  check("examples on a Claygent column: the same instructions, with the tool", withTool.bodies[0]?.instructions === g49.config.examples_text && withTool.bodies[0]?.tools?.[0]?.type === "web_search");

  section("C3. Held examples not laid out: never sent");
  const old = withoutExampleKeys(g49.config);
  old.table_examples = g49.config.table_examples;
  old.run_budget = g49.config.run_budget;
  const s1 = await ask(old, prompt);
  check("a table compiled before this change (table_examples, no examples_text): skipped, nothing sent, and why",
    s1.res.status === "skipped" && s1.bodies.length === 0 &&
      s1.res.note === "Its table examples are not compiled yet: the client's tables are brought up to date on its next pull or people run", s1.res.note);
  const badCol = compileG19(variantWith("inboxes:19", { definition: withExamples(defOf("inboxes:19"), [{ inputs: { "{{f_nope}}": "x" }, output: "q" }]) }));
  const s2 = await ask(badCol.config, "[fx:G19] name=Bad Example; Is this a first name?");
  check("unreadable examples: skipped, nothing sent, the reason named",
    s2.res.status === "skipped" && s2.bodies.length === 0 &&
      s2.res.note === "Its table examples could not be read (an example reads a column this table does not hold), so it is not run (nothing was sent)", s2.res.note);
  const s3 = await ask({ ...g49.config, examples_text: 5 }, prompt);
  check("a text that is not a string is not sent", s3.res.status === "skipped" && s3.bodies.length === 0);
}

// ── D. Rows worked in memory ────────────────────────────────────────────────

/** A row worked in memory as the worker would (test-upload-enrich.mjs runs its rows so): its cells from the changed hook, the requests it made. */
async function runInMemory(columns, inputs, { template, settings, variant = VARIANT, force = true }) {
  const stored = new Map(Object.entries(inputs).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, { status: "done", value: v }]));
  const cells = new Map(stored);
  const before = { ...net.calls };
  const bodies = net.bodies.length;
  const out = await runRow({
    row: { id: 0, created_at: CREATED, run_force: force ? ["*"] : [], next_run_at: new Date() },
    table: { id: null, client_tag: TAG, template, variant, keyCounts: {} },
    columns, cells: stored, env: KEYS, db: pool, settings, hooks: { changed: (k, c) => cells.set(k, c) },
  });
  const paid = Object.fromEntries(Object.keys(net.calls).map((k) => [k, net.calls[k] - before[k]]));
  return { ...out, cells, paid, bodies: net.bodies.slice(bodies) };
}
const settingsWith = (rows) => settingsFrom([{ key: "spend_caps", value: HIGH_CAPS }, ...rows]);
const OFF = settingsWith([]);
const ON = settingsWith([{ key: "personalisation", value: { enabled: true, tags: [TAG], shared_text_ok: false } }]);
const marked = (bodies, marker) => bodies.filter((b) => String(b?.input ?? "").includes(`[fx:${marker}] business=${COMPANY};`));

async function partD() {
  section("D1. A General row worked by the compiled template: G#49 off, then on");
  const address = `office@${dom("widget")}`;
  net.reoon.set(address, "safe");
  const QUESTION = "Would a made-up question for the widget works help?";
  net.openai.set(`G49|${COMPANY}`, { response: QUESTION });
  const inbox = {
    general_email: address, domain: dom("widget"), website: `https://www.${dom("widget")}`, state: "IL", client_tag: TAG, category: "Made-up widgets",
    city: "Springfield", company_address: "100 Main Street, Springfield, IL", company: COMPANY, company_row: "0", found_in: "aiark",
  };
  const cols = order(compiled.inboxes.map((c) => ({ ...c })));
  // OpenAI requests are counted per column by the prompt's marker: G#19 (Builder T's template line) asks too once merged.
  const off = await runInMemory(cols, inbox, { template: "inboxes_v1", settings: OFF });
  check("personalisation off: G#45 to G#50 Switched off, as today, and neither G#48 nor G#49 asked",
    ["email_domain", "email_host_lookup_google_dns", "claygent", "question_ai", "question"].every((k) => off.cells.get(k)?.note === "Switched off: personalisation") &&
      marked(off.bodies, "G48").length + marked(off.bodies, "G49").length === 0 && off.values.email_valid === true && off.errors === 0,
    JSON.stringify({ notes: ["claygent", "question_ai"].map((k) => off.cells.get(k)?.note), paid: off.paid, valid: off.values.email_valid }));
  const def = await runInMemory(cols, inbox, { template: "inboxes_v1", settings: ON, variant: "default" });
  check("on, but for a client on the default originals: still Switched off (shared_text_ok false)",
    def.cells.get("question_ai")?.note === "Switched off: personalisation" && marked(def.bodies, "G49").length === 0);
  const on = await runInMemory(cols, inbox, { template: "inboxes_v1", settings: ON });
  const sent = marked(on.bodies, "G49");
  check("on for a client with its own variant: G#49 sends once, its examples as the instructions and its prompt as the input",
    sent.length === 1 && sent[0].instructions === g49.config.examples_text && sent[0].input === promptFor(g49, { company: COMPANY, claygent: on.values.claygent }) &&
      on.cells.get("question_ai")?.status === "done" && on.errors === 0,
    JSON.stringify({ sent: sent.length, status: on.cells.get("question_ai")?.status, note: on.cells.get("question_ai")?.note, errors: on.errors }));
  check("... and G#50 holds the question", on.values.question === `w${QUESTION.slice(1)}` && on.cells.get("question")?.status === "done", JSON.stringify(on.values.question));
  check("... with G#48 asked before it (its summary is in the prompt)", marked(on.bodies, "G48").length === 1 && on.bodies.indexOf(marked(on.bodies, "G48")[0]) < on.bodies.indexOf(sent[0]));

  section("D2. Remembered by prompt and examples");
  const later = await runInMemory(cols, inbox, { template: "inboxes_v1", settings: ON, force: false });
  check("a fresh row, not forced: G#49's answer is reused from the shared answers, nothing sent, the same question",
    marked(later.bodies, "G49").length + marked(later.bodies, "G48").length === 0 && /^Reused: found for CXTEST_A on /.test(later.cells.get("question_ai")?.note ?? "") &&
      later.values.question === on.values.question,
    JSON.stringify({ note: later.cells.get("question_ai")?.note, paid: later.paid }));
  const kept = await one(`SELECT count(*)::int AS n FROM enrich_memory WHERE kind = 'inbox_question_ai_v1' AND client_tag = $1`, [TAG]);
  check("one shared answer kept for G#49, under its setting's memory kind", kept.n === 1, JSON.stringify(kept));
  const otherSet = compileTemplates(variantWith("inboxes:49", { definition: withExamples(defOf("inboxes:49"), [{ inputs: { "{{f_fxG12}}": "Another Made-up Shop" }, output: "Another made-up question?" }]) }));
  const g49b = otherSet.inboxes.find((c) => c.key === "question_ai");
  const other = await runInMemory(order(otherSet.inboxes.map((c) => ({ ...c }))), inbox, { template: "inboxes_v1", settings: ON, force: false });
  const otherSent = marked(other.bodies, "G49");
  check("another variant's examples with the same prompt: not reused, asked again once with its own examples (G#48 still reused)",
    g49b.inputs.prompt === g49.inputs.prompt && otherSent.length === 1 && otherSent[0].instructions === g49b.config.examples_text && otherSent[0].instructions !== g49.config.examples_text &&
      marked(other.bodies, "G48").length === 0,
    JSON.stringify({ sent: otherSent.length, paid: other.paid }));

  section("D3. P#61 on People rows: an AI Ark row sends it, an upload row never");
  const p62 = compiled.people.find((c) => c.key === "question");
  const reads = [...new Set([p61.run_if, ...Object.values(p61.inputs)].flatMap((t) => [...refs(t)]))];
  check("P#61's run condition carries the upload gate (found_by)", reads.includes("found_by") && p61.run_if.includes(`{{found_by}} !== "${UPLOAD_FOUND_BY}"`), p61.run_if);
  // Everything P#61 reads, given as input cells: only its own run condition decides.
  const standIns = reads.map((key) => ({ key, name: key, kind: "input", action: null, phase: 1, inputs: {}, config: {} }));
  const pcols = order([...standIns, { ...p61 }, { ...p62 }]);
  const PQ = "Would a made-up people question help?";
  net.openai.set(`P61|${COMPANY}`, { response: PQ });
  const person = (foundBy) => ({
    company: COMPANY, title: "Office Manager", claygent: { company_summary: "Makes made-up widgets.", spaces: "Offices.", reasoning: "" },
    use_work_email: `pat@${dom("widget")}`, safe_to_run: true, email_provider_check_api: { Status: 0, Answer: [{ type: 15, data: `10 mx.${dom("widget")}.` }] }, found_by: foundBy,
  });
  const fromAiark = await runInMemory(pcols, person("aiark"), { template: "people_v1", settings: ON });
  const pSent = marked(fromAiark.bodies, "P61");
  check("an AI Ark row, personalisation on: P#61 sends once with its examples, P#62 holds the question",
    pSent.length === 1 && pSent[0].instructions === p61.config.examples_text && fromAiark.values.question === `w${PQ.slice(1)}`,
    JSON.stringify({ sent: pSent.length, note: fromAiark.cells.get("question_ai")?.note, q: fromAiark.values.question }));
  const fromUpload = await runInMemory(pcols, person(UPLOAD_FOUND_BY), { template: "people_v1", settings: ON });
  check("an upload row, personalisation on and everything else it reads in place: P#61 never runs, nothing sent, no question",
    fromUpload.cells.get("question_ai")?.status === "skipped" && fromUpload.cells.get("question_ai")?.note === "Run condition not met" && fromUpload.paid.openai === 0 && !fromUpload.values.question,
    JSON.stringify({ cell: fromUpload.cells.get("question_ai"), paid: fromUpload.paid }));
  const pOff = await runInMemory(pcols, person("aiark"), { template: "people_v1", settings: OFF });
  check("personalisation off: P#61 Switched off", pOff.cells.get("question_ai")?.note === "Switched off: personalisation" && pOff.paid.openai === 0);
}

// ── Run ─────────────────────────────────────────────────────────────────────

let spendBefore = null;

/** Why the run must not start (another suite's leftovers, or a client switched on), or null. */
async function refusal() {
  const ready = await one(`SELECT to_regclass('public.enrich_memory') IS NOT NULL AND to_regclass('public.enrich_spend_daily') IS NOT NULL AS ok`);
  if (!ready.ok) return "migrations 124 and 125 are not in this database";
  const lists = await all(`SELECT key, value FROM enrich_settings WHERE key = ANY($1::text[])`, [SWITCH_LISTS]);
  const on = lists.filter((r) => Array.isArray(r.value?.tags) && r.value.tags.length).map((r) => r.key);
  if (on.length) return `a client is on the ${on.join(", ")} list(s)`;
  const held = await one(
    `SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id WHERE r.run_status = 'held' AND NOT starts_with(coalesce(t.client_tag, ''), $1)`,
    [PREFIX]
  );
  if (held.n) return `${held.n} held row(s) of other clients exist`;
  return null;
}

async function cleanup() {
  await pool.query(`DELETE FROM enrich_memory WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1`, [`%.${HOST}`]);
  if (spendBefore) {
    await pool.query(`DELETE FROM enrich_spend_daily WHERE NOT ((day::text || kind) = ANY($1::text[]))`, [spendBefore.map((r) => `${r.day}${r.kind}`)]);
    for (const r of spendBefore) await pool.query(`UPDATE enrich_spend_daily SET used = $3 WHERE day::text = $1 AND kind = $2`, [r.day, r.kind, r.used]);
  }
}

const t0 = Date.now();
let refused = null;
try {
  refused = await refusal();
  if (refused) {
    console.error(`Refusing to run: ${refused}.`);
  } else {
    await cleanup();
    spendBefore = await all(`SELECT day::text AS day, kind, used::text AS used FROM enrich_spend_daily ORDER BY day, kind`);
    partA();
    partB();
    await partC();
    await partD();
    check("nothing tried to reach any other address", net.calls.refused === 0, `${net.calls.refused} refused`);
  }
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  let clean = true;
  if (!refused) {
    await cleanup().catch((e) => console.error("cleanup failed:", e.message));
    const left = await one(
      `SELECT (SELECT count(*)::int FROM enrich_memory WHERE starts_with(client_tag, $1)) AS memory,
              (SELECT count(*)::int FROM email_validations WHERE email LIKE $2) AS validations`,
      [PREFIX, `%.${HOST}`]
    );
    const spendBack = spendBefore ? same(await all(`SELECT day::text AS day, kind, used::text AS used FROM enrich_spend_daily ORDER BY day, kind`), spendBefore) : true;
    clean = left.memory === 0 && left.validations === 0 && spendBack;
    console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, spendBack })}`}`);
  }
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(refused || count.failed || !clean ? 1 : 0);
}
