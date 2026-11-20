#!/usr/bin/env node
// Checks for the Clay originals and the pipeline's three templates (design
// 8.1). LOCAL DATABASE ONLY: it loads the made-up exports
// (scripts/fixtures/clay-originals) as made-up clients' own variants (tags
// starting OGTEST_), makes their tables, and removes all of it at the end. The
// "default" originals already in the database are never changed; one check
// sets them aside for a moment and puts them back.
//
//   node --env-file=.env.local scripts/test-originals.mjs
//   CLAY_ORIGINALS_DIR=<folder outside the repo> node --env-file=.env.local scripts/test-originals.mjs
//
// With CLAY_ORIGINALS_DIR (the real Clay CLI exports, never in this repo) it
// also compiles the real originals in memory and prints counts only.
//
// Stop the enrichment worker first. Nothing here reaches a network: fetch is
// replaced and refuses every address.
//
//   A. no database: the layout check, references rewritten, changes, the three
//      templates against the fixtures, ai_web from use-ai, write-tos, no
//      original text in the repo, the people tracks, settings
//   B. local database: the seed script, ensurePipelineTables and the pull
//      route's refusals, the settings migration 125 merges

import pg from "pg";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FIXTURE_MARKER, FIXTURE_TRACKS, fixtureExports, fixtureSeedExports, fixtureText } from "./fixtures/clay-originals/fixtures.mjs";
import { checker, dropPaidKeys, installNet, localDatabaseUrl, routeLoader, seedFixtureVariant } from "./fixtures/test-support.mjs";
import { nameFits, ORIGINAL_COUNTS } from "./lib/enrich/original-keys.mjs";
import { applyChange, compileColumn, loadOriginals, OriginalsMissing, originalsSummary, refMap, rewriteRefs } from "./lib/enrich/compile-original.mjs";
import { deriveTracks, layoutProblems, originalRows, originalsMap, readExport, trackProblems } from "./lib/enrich/seed-originals.mjs";
import { compileTemplates, ensurePipelineTables, hasRetiredV1, RetiredV1Table, variantFor, variantName } from "./lib/enrich/templates.mjs";
import { AIARK_EMAIL_REOON_APPEND, COMPANY_ABSENT_KEYS, COMPANY_REFS, COMPANY_RUN_IF_CHANGES } from "./lib/enrich/company-template-v2.mjs";
import { INBOX_INPUT_KEYS } from "./lib/enrich/inbox-template.mjs";
import { PEOPLE_INPUT_KEYS, PEOPLE_WRITTEN_KEYS } from "./lib/enrich/people-template.mjs";
import { ACTIONS, answerSchema } from "./lib/enrich/actions.mjs";
import { refs } from "./lib/enrich/formula.mjs";
import { cleanModelSetting, flagOn, MODEL_SETTINGS, settingsFrom, SETTINGS_DEFAULTS } from "./lib/enrich/settings.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
process.env.AIARK_DEMO = "1";
const net = installNet();
const count = checker(); // the totals live on this object
const { check, section } = count;
const totals = () => ({ passed: count.passed, failed: count.failed });
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/clay-originals/", import.meta.url));
const RUN = randomUUID().slice(0, 6);
const PREFIX = "OGTEST_";
const tag = (s) => `${PREFIX}${s}`;
const ASIDE = `zz_aside_${RUN}`;

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const sha = (s) => createHash("sha256").update(s).digest("hex");

// ── A. No database ──────────────────────────────────────────────────────────

const exps = fixtureExports();
const seedExps = fixtureSeedExports();
const fixtureOriginals = originalsMap(originalRows(seedExps));
const compiled = compileTemplates(fixtureOriginals, { settings: null });
const col = (kind, key) => compiled[kind].find((c) => c.key === key);
const texts = (c) => [c.formula, c.run_if, ...(c.waterfall ?? []), ...Object.values(c.inputs ?? {})].filter((x) => typeof x === "string");

function partA() {
  section("A1. The layout check");
  check("the fixtures have 68, 88 and 76 columns, every name fitting the key at its position",
    ["companies", "people", "inboxes"].every((k) => exps[k].data.length === ORIGINAL_COUNTS[k] && layoutProblems(k, exps[k].data).length === 0));
  check("... checked by name for every position but C#3 and C#4",
    exps.companies.data.every((c, i) => nameFits("companies", i + 1, c.name)) && !nameFits("companies", 24, "Something Else Entirely"));
  const renamed = structuredClone(exps.companies.data);
  renamed[23].name = "Website Finder Renamed";
  const short = exps.people.data.slice(0, 87);
  const p1 = layoutProblems("companies", renamed);
  const p2 = layoutProblems("people", short);
  check("a renamed column is named by position, without printing either name", p1.length === 1 && /^C#24's name does not fit the key companys_website$/.test(p1[0]) && !p1[0].includes("Renamed"), p1.join("; "));
  check("a missing column: refused by its count", p2.length === 1 && p2[0] === "people: 87 columns, 88 expected", p2.join("; "));
  const files = ["companies", "people", "inboxes"].map((k) => readFileSync(path.join(FIXTURE_DIR, `${k}.json`), "utf8") === fixtureText(exps[k]));
  check("the fixture files are what fixtures.mjs builds (run it with --write after a change)", files.every(Boolean), JSON.stringify(files));

  section("A2. References rewritten to keys");
  const own = refMap(fixtureOriginals, "companies", COMPANY_REFS);
  const r1 = rewriteRefs(`{{f_fxC05}} + {{ f_fxC29 }} + {{f_nowhere}} + {{f_nowhere}}`, own);
  check("ids become keys; an unknown id is kept as it is and reported once", r1.text === "{{company}} + {{use_domain}} + {{f_nowhere}} + {{f_nowhere}}" && JSON.stringify(r1.unknown) === '["f_nowhere"]', JSON.stringify(r1));
  const leftover = Object.entries(compiled).flatMap(([k, cols]) => cols.flatMap((c) => texts(c).filter((t) => /\{\{\s*f_/.test(t)).map(() => `${k}.${c.key}`)));
  check("no Clay id is left in any compiled formula, waterfall step, run condition or input", leftover.length === 0, leftover.join(", "));
  const c16 = col("companies", "exclusion_large_company_check");
  check("a formula: C#16 reads the company, AI Ark's domain (C#21), category and sub-category", ["company", "domain", "category", "sub_category", "apify_indeed_sources"].every((k) => refs(c16.formula).has(k)), c16.formula);
  const c26 = col("companies", "use_website");
  check("{formula} waterfall steps: C#26's three steps read C#25, C#23 and C#21 as keys",
    c26.waterfall.length === 3 && refs(c26.waterfall[0]).has("company_website_response") && refs(c26.waterfall[1]).has("clearbit") && refs(c26.waterfall[2]).has("domain"));
  const plain = compileColumn(
    { key: "zz_plain", from: "C#29", kind: "waterfall" },
    new Map([["companies:29", { ...fixtureOriginals.get("companies:29"), definition: { settings: { formulaWaterfall: ["{{f_fxC28}}?.normalizedUrl", { formula: "{{f_fxC05}}" }] } } }]]),
    { own }
  );
  check("... and plain text steps too", JSON.stringify(plain.waterfall) === JSON.stringify(["{{normalize_a_domain}}?.normalizedUrl", "{{company}}"]), JSON.stringify(plain.waterfall));
  const c28 = col("companies", "normalize_a_domain");
  check("run conditions and input bindings: C#28 on {{use_website}}, type \"bare\"", c28.run_if.startsWith("{{use_website}} && {{check_if_url_is_valid}}?.valid") && c28.inputs.url === "{{use_website}}" && c28.inputs.type === '"bare"', JSON.stringify({ run_if: c28.run_if, inputs: c28.inputs }));
  const c36 = col("companies", "general_email_write_to");
  const g39 = col("inboxes", "reoon_validation");
  check("formulaMap values: C#36's mapping and G#39's query string read our keys",
    c36.inputs["map:domain"] === "{{use_domain}}" && c36.inputs["map:client_tag"] === "{{client_tag}}" && c36.inputs["map:company_address"] === "{{use_address}}" && g39.inputs.email === "{{general_email}}",
    JSON.stringify({ c36: c36.inputs, g39: g39.inputs }));
  check("write-to mapping keys: the target ids become the target template's keys",
    Object.keys(c36.config.cells).sort().join() === [...INBOX_INPUT_KEYS].filter((k) => !["company_row", "found_in"].includes(k)).sort().join() && c36.config.object_paths.general_email === "value",
    JSON.stringify(c36.config.cells));
  const p61 = col("people", "question_ai");
  const exported = exps.people.data[60].settings.inputsBinding.find((x) => x.name === "tableExamples").formulaText;
  check("table examples stay as exported, in config, never in the inputs", p61.config.table_examples === exported && exported.includes("{{f_fxP28}}") && !Object.values(p61.inputs).some((v) => String(v).includes("fx-example")), JSON.stringify(Object.keys(p61.inputs)));

  section("A3. A change to an original");
  check("one match: applied", applyChange("a && {{x}} && b", { find: "{{x}}", replace: "{{y}}" }) === "a && {{y}} && b");
  const thrown = (fn) => {
    try {
      fn();
      return "";
    } catch (e) {
      return e.message;
    }
  };
  check("no match: refused", /found nothing to replace/.test(thrown(() => applyChange("a && b", { find: "{{x}}", replace: "y", in: "t.run_if" }))));
  check("two matches: refused", /more than once/.test(thrown(() => applyChange("{{x}} || {{x}}", { find: "{{x}}", replace: "y" }))));
  check("the compiler refuses a change whose text it can't find",
    /found nothing to replace/.test(thrown(() => compileColumn({ key: "zz", from: "C#41", kind: "action", action: "ai_web", model_setting: "companys_website", changes: [{ in: "run_if", find: "{{nothing_like_this}}", replace: "", why: "test" }] }, fixtureOriginals, { own }))));

  section("A4. The three templates against the fixtures");
  const ABSENT = new Set([...COMPANY_ABSENT_KEYS, "created_at"]);
  for (const [kind, cols] of Object.entries(compiled)) {
    const keys = new Set(cols.map((c) => c.key));
    const outside = [...new Set(cols.flatMap((c) => texts(c).flatMap((t) => [...refs(t)]).filter((k) => !keys.has(k) && !ABSENT.has(k))))];
    check(`${kind}: every {{key}} is a column of the template or a declared absent one`, outside.length === 0, outside.join(", "));
    const unknownAction = cols.filter((c) => c.kind === "action" && !ACTIONS[c.action]).map((c) => `${c.key}:${c.action}`);
    check(`${kind}: every action is in ACTIONS`, unknownAction.length === 0, unknownAction.join(", "));
  }
  check("order() finds no loop in any of them (compileTemplates checks it)", Object.values(compiled).every((cols) => cols.length > 40));
  const c31 = col("companies", "email_extraction_claygent");
  const c24 = col("companies", "companys_website");
  check("C#30 compiles to first_general_email, C#59 to use_address, C#9 to client_tag, C#21 to domain",
    c31.run_if.includes("{{first_general_email}}") && !c31.run_if.includes("icypeas") && c24.inputs.prompt.includes("{{use_address}}") && c36.inputs["map:client_tag"] === "{{client_tag}}" && c24.run_if.startsWith("!{{domain}}"),
    JSON.stringify({ c31: c31.run_if.slice(0, 160), c24: c24.run_if.slice(0, 60) }));
  const c41 = col("companies", "company_decision_maker_facilities_1_claygent");
  const c56 = col("companies", "company_decision_maker_ceo_claygent");
  check("C#41 and C#56: the role finders' clauses replaced by their track, settled with nobody found",
    c41.run_if === `{{master_filter}} && ${COMPANY_RUN_IF_CHANGES.company_decision_maker_facilities_1_claygent.replace} && {{safe_to_run}}` &&
      c56.run_if.includes(COMPANY_RUN_IF_CHANGES.company_decision_maker_ceo_claygent.replace) && !/findymail|anymail/.test(c41.run_if + c56.run_if),
    JSON.stringify({ c41: c41.run_if, c56: c56.run_if }));
  const g39i = col("companies", "aiark_email_reoon");
  check("G#38 to G#40 on the company row: G#39's condition on AI Ark's email, with the head office clause appended",
    g39i.run_if.endsWith(AIARK_EMAIL_REOON_APPEND) && g39i.run_if.startsWith("!!{{aiark_email}} && !!{{safe_to_run}}") && g39i.inputs.email === "{{aiark_email}}" && col("companies", "aiark_email_approved").formula.includes("{{aiark_email_reoon}}"),
    g39i.run_if);
  const withId = compiled.companies.filter((c) => c.clay_field_id).length;
  check("compiled columns carry their Clay field id; ours and phase 1's do not", withId === compiled.companies.filter((c) => /^Clay's /.test(c.description ?? "")).length && withId > 25 && !col("companies", "office").clay_field_id, `${withId}`);

  section("A5. ai_web from use-ai");
  const ans = c41.config.answer;
  check("Clay's answer fields, in Clay's order, with their types and descriptions",
    Object.keys(ans).join() === "Person_2_Full_Name,confidence,reasoning,Person_2_Title,Person_2_LinkedIn_URL" && ans.Person_2_LinkedIn_URL.type === "url" && ans.Person_2_Full_Name.description.includes(FIXTURE_MARKER),
    JSON.stringify(ans));
  const c50 = col("companies", "company_decision_maker_location_company_check");
  check("a select field becomes an enum of its option texts", JSON.stringify(answerSchema(c50.config).schema.properties.result.enum) === '["Yes","No"]');
  const ai = Object.values(compiled).flat().filter((c) => c.action === "ai_web");
  check("claygent sends the web search tool; use-ai sends none",
    ai.filter((c) => c.config.use_case === "claygent").every((c) => c.config.tool === "web_search") && ai.filter((c) => c.config.use_case === "use-ai").every((c) => c.config.tool === "none") && ai.length === 12,
    ai.map((c) => `${c.key}:${c.config.tool}`).join());
  check("each names its own model setting, which defaults to gpt-6-luna; the original's model is kept beside it",
    ai.every((c) => MODEL_SETTINGS.includes(c.config.model_setting) && SETTINGS_DEFAULTS.models[c.config.model_setting].model === "gpt-6-luna") && c24.config.original_model === "gpt-4o-mini" && col("people", "claygent").config.original_model === "gpt-6-luna");
  const caps = Object.fromEntries(ai.map((c) => [c.config.model_setting, SETTINGS_DEFAULTS.models[c.config.model_setting].max_searches ?? null]));
  const sortedJson = (o) => JSON.stringify(Object.fromEntries(Object.entries(o).sort(([x], [y]) => x.localeCompare(y))));
  check("most tool calls as design 6.2", sortedJson(caps) === sortedJson({
    companys_website: 3, email_extraction_claygent: 2, email_extraction_claygent_2: 2, company_decision_maker_facilities_1_claygent: 2,
    company_decision_maker_facilities_2_claygent: 3, company_decision_maker_location_company_check: 1, company_decision_maker_ceo_claygent: 2,
    current_employer: 2, people_claygent: 2, people_question_ai: null, inbox_claygent: 3, inbox_question_ai: null,
  }), sortedJson(caps));
  check("no reasoning effort by default but for the fit score's low", MODEL_SETTINGS.every((k) => (k === "fit_score" ? SETTINGS_DEFAULTS.models[k].reasoning_effort === "low" : !SETTINGS_DEFAULTS.models[k].reasoning_effort)));
  check("no user location, N/A kept, the OpenAI key needed, memory by setting", ai.every((c) => c.config.user_location === false && c.config.keep_na === true && c.needs_env.join() === "OPENAI_API_KEY" && c.config.memory === `${c.config.model_setting}_v1`));
  check("... remembered 365 days for C#24 and P#27, the email span for the others",
    ai.every((c) => c.config.memory_days === (["companys_website", "current_employer"].includes(c.config.model_setting) ? "website" : "email")));
  const flags = Object.fromEntries(ai.map((c) => [c.key, (c.config.flag ?? []).join("+")]));
  check("switches: the AI searches behind people_pipeline and ai_searches, C#50 and P#27 behind linkedin_profile_reads, personalisation behind its own",
    flags.company_decision_maker_facilities_1_claygent === "people_pipeline+ai_searches" && flags.company_decision_maker_location_company_check === "people_pipeline+ai_searches+linkedin_profile_reads" &&
      flags.current_employer === "linkedin_profile_reads" && flags.claygent === "personalisation" && flags.companys_website === "" && flags.email_extraction_claygent === "",
    JSON.stringify(flags));
  const keyed = Object.values(compiled).flat().filter((c) => c.config?.key_env);
  check("the finders and Enrichley run by their key and never make a row wait",
    keyed.length === 10 && keyed.every((c) => c.needs_env.length === 0 && ["FINDYMAIL_API_KEY", "PROSPEO_API_KEY", "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY"].includes(c.config.key_env)),
    keyed.map((c) => `${c.key}:${c.config.key_env}`).join());
  const p48 = col("people", "find_work_email_anymail_finder");
  check("Anymail Finder's request as exported: method, URL and body compiled, the Authorization header left to the key",
    p48.inputs.url === '"https://api.anymailfinder.com/v5.1/fixture/person"' && p48.inputs.body.includes("Clay.formatForJSON({{full_name}})") && !("Authorization" in (p48.config.headers ?? {})) && !JSON.stringify(p48).includes("[redacted]"),
    JSON.stringify({ inputs: p48.inputs, config: p48.config }));

  section("A6. Write-tos");
  const c43 = col("companies", "person_2_facilities_1_write_to");
  check("C#43: People inputs as themselves, the formula columns as written_<key>, its writer and track",
    c43.config.cells.full_name === "written_full_name" && c43.config.cells.company_website === "company_website" && c43.config.cells.client_tag === "client_tag" &&
      PEOPLE_WRITTEN_KEYS.every((k) => c43.config.cells[k] === `written_${k}`) && c43.config.mode === "one" && c43.config.writer.track === "operations" && c43.config.target_kind === "people",
    JSON.stringify(c43.config));
  check("C#36: one inbox row per address (array of objects), each target an input of the inbox template",
    c36.config.target_kind === "inboxes" && c36.config.mode === "array" && Object.values(c36.config.cells).every((k) => INBOX_INPUT_KEYS.includes(k)) && c36.inputs.items === "{{extract_urls_and_emails_from_text}}?.urlsAndEmails");
  check("every People write-to target is an input or a written value", ["person_2_facilities_1_write_to", "person_3_facilities_2_write_to", "person_1_ceo_write_to"].every((k) => Object.values(col("companies", k).config.cells).every((cell) => PEOPLE_INPUT_KEYS.includes(cell))));

  section("A7. The repo holds no original text");
  check("the fixtures' text reaches the compiled columns (from the made-up originals)", c24.inputs.prompt.includes(`${FIXTURE_MARKER}-c24`) && c16.formula.includes(FIXTURE_MARKER));
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) {
        if (!["node_modules", ".next", "fixtures"].includes(name)) walk(p);
      } else if (/\.(m?js|tsx?)$/.test(name) && !/^test-/.test(name) && readFileSync(p, "utf8").includes(FIXTURE_MARKER)) {
        offenders.push(path.relative(ROOT, p));
      }
    }
  };
  walk(path.join(ROOT, "scripts", "lib"));
  walk(path.join(ROOT, "src"));
  for (const name of readdirSync(path.join(ROOT, "scripts"))) {
    const p = path.join(ROOT, "scripts", name);
    if (/\.m?[jt]s$/.test(name) && !/^test-/.test(name) && statSync(p).isFile() && readFileSync(p, "utf8").includes(FIXTURE_MARKER)) offenders.push(`scripts/${name}`);
  }
  check("no module of scripts/lib, scripts or src holds the fixtures' text", offenders.length === 0, offenders.join(", "));

  section("A8. The people tracks");
  const tracks = deriveTracks(fixtureOriginals);
  check("derived from the role finders' roles, then the AI searches' title lists, once each, in Spencer's order",
    tracks.order.join() === "operations,facility_office,ceo" && ["operations", "facility_office", "ceo"].every((t) => JSON.stringify(tracks[t].phrases) === JSON.stringify(FIXTURE_TRACKS[t])) && tracks.operations.from.join() === "C#37,C#41",
    JSON.stringify(tracks));
  check("an item that holds a column (\"<city> Office Lead\") is left out", !tracks.operations.phrases.some((p) => /Office Lead/.test(p)));
  const bad = structuredClone(tracks);
  bad.ceo.phrases.push("Chief Imaginary Officer");
  check("a phrase its cited columns don't hold is refused", JSON.stringify(trackProblems(tracks, fixtureOriginals)) === "[]" && trackProblems(bad, fixtureOriginals).join() === "ceo: phrase 4 is not in C#52 or C#56");

  section("A9. Settings, read and checked");
  const s = settingsFrom([
    { key: "models", value: { companys_website: { model: "gpt-6-luna", reasoning_effort: "minimal", max_searches: 9 }, inbox_claygent: null, current_employer: { model: "Not A Model!" } } },
    { key: "company_pipeline", value: { enabled: true, tags: ["ogtest_a", " OGTEST_A ", 5], inboxes_per_company: 0, max_pull_size: 20 } },
    { key: "spend_caps", value: { reoon_checks_per_day: -1, openai_prices: { "gpt-6-luna": { in: "x" } } } },
  ]);
  check("minimal is refused for a Luna model, and searches over 5 are dropped", JSON.stringify(s.models.companys_website) === '{"model":"gpt-6-luna"}' && cleanModelSetting({ model: "gpt-5-nano", reasoning_effort: "minimal" }).reasoning_effort === "minimal");
  check("a model set to null or to something that isn't a model id is unset; a key the row doesn't hold takes its default",
    s.models.inbox_claygent === null && s.models.current_employer === null && s.models.email_extraction_claygent.model === "gpt-6-luna");
  check("an invalid value keeps its default; tags are upper case, once each", s.company_pipeline.inboxes_per_company === 5 && s.company_pipeline.max_pull_size === 20 && JSON.stringify(s.company_pipeline.tags) === '["OGTEST_A"]' && s.spend_caps.reoon_checks_per_day === 1500 && s.spend_caps.openai_prices["gpt-6-luna"].in === 0.1);
  check("phase 1's own settings are not read", !("email_checks_per_company" in s.company_pipeline) && !MODEL_SETTINGS.some((k) => ["website_search", "email_search_first", "email_search_second"].includes(k)));
  const on = settingsFrom([
    { key: "company_pipeline", value: { enabled: true, tags: ["OGTEST_A"], linkedin_profile_reads: true } },
    { key: "people_pipeline", value: { enabled: true, tags: ["OGTEST_B"], ai_searches: true } },
    { key: "personalisation", value: { enabled: true, tags: ["OGTEST_A"] } },
  ]);
  check("a switch is off for a client not on its list", flagOn(on, "company_pipeline", "OGTEST_A") && !flagOn(on, "company_pipeline", "OGTEST_B") && flagOn(on, "people_pipeline", "ogtest_b") && !flagOn(on, "people_pipeline", "OGTEST_A"));
  check("a sub-switch needs its parent on for the client", flagOn(on, "ai_searches", "OGTEST_B") && !flagOn(on, "ai_searches", "OGTEST_A") && flagOn(on, "linkedin_profile_reads", "OGTEST_A") && !flagOn(on, "linkedin_profile_reads", "OGTEST_B"));
  check("personalisation needs the client's own originals (or shared_text_ok)", !flagOn(on, "personalisation", "OGTEST_A") && flagOn(on, "personalisation", "OGTEST_A", { variant: "ogtest_a" }));
  check("everything ships off", MODEL_SETTINGS.length === 14 && ["company_pipeline", "people_pipeline", "ai_searches", "auto_buy", "personalisation", "promotion", "fit_scoring"].every((f) => !flagOn(settingsFrom([]), f, "OGTEST_A")));
}

/** The real exports, compiled in memory (counts only; the files stay where they are, outside the repo). */
function partReal(dir) {
  section("A10. The real Clay exports (CLAY_ORIGINALS_DIR), in memory");
  const real = { companies: readExport(path.join(dir, "companies.json")), people: readExport(path.join(dir, "people.json")), inboxes: readExport(path.join(dir, "inboxes.json")) };
  const problems = ["companies", "people", "inboxes"].flatMap((k) => layoutProblems(k, real[k].data));
  check("their layout fits ORIGINAL_KEYS", problems.length === 0, `${problems.length} problems`);
  const originals = originalsMap(originalRows(real));
  const t = compileTemplates(originals);
  check("the three templates compile from them, as from the fixtures", ["companies", "inboxes", "people"].every((k) => t[k].length === compiled[k].length), JSON.stringify(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length]))));
  check("their tracks pass the seed's check", trackProblems(deriveTracks(originals), originals).length === 0);
}

// ── B. The local database ───────────────────────────────────────────────────

const A = tag("A"); // its own variant: the tables, a second call, a prune
const V = tag("V"); // a companies_v1 table
const M = tag("M"); // no variant of its own: originals missing
let originalSettings = null;
let tmp = null;

const seedScript = fileURLToPath(new URL("./enrich-seed-originals.mjs", import.meta.url));
function seedCli(args) {
  const r = spawnSync(process.execPath, [seedScript, ...args], { env: { PATH: process.env.PATH, DATABASE_URL: url }, encoding: "utf8", timeout: 120_000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const fixtureFiles = (over = {}) => ["companies", "people", "inboxes"].flatMap((k) => [`--${k}`, over[k] ?? path.join(FIXTURE_DIR, `${k}.json`)]);
const variantRows = async (v) => (await one(`SELECT count(*)::int AS n, md5(string_agg(definition::text || source_sha256, '' ORDER BY template_kind, position)) AS h FROM enrich_originals WHERE variant = $1`, [v]));

async function partB(routes) {
  const { T, call, heartbeat, runs } = routes;
  tmp = mkdtempSync(path.join(os.tmpdir(), "test-originals-"));
  const defaultBefore = await variantRows("default");
  const settingsBefore = JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`));

  section("B1. The seed script");
  const dryVariant = `ogtest_dry_${RUN}`;
  const dry = seedCli([...fixtureFiles(), "--variant", dryVariant, "--dry"]);
  check("--dry: everything inside a transaction that is rolled back, nothing kept", dry.code === 0 && /Dry run \(nothing kept\)/.test(dry.out) && (await variantRows(dryVariant)).n === 0, dry.out.slice(0, 300));
  const v = `ogtest_seed_${RUN}`;
  const first = seedCli([...fixtureFiles(), "--variant", v]);
  const h1 = await variantRows(v);
  const second = seedCli([...fixtureFiles(), "--variant", v]);
  const h2 = await variantRows(v);
  const shas = await all(`SELECT template_kind, min(source_sha256) AS s, count(DISTINCT source_sha256)::int AS n FROM enrich_originals WHERE variant = $1 GROUP BY 1`, [v]);
  const fileSha = Object.fromEntries(["companies", "people", "inboxes"].map((k) => [k, sha(readFileSync(path.join(FIXTURE_DIR, `${k}.json`)))]));
  check("232 columns loaded; a second run replaces them with the same rows", first.code === 0 && second.code === 0 && h1.n === 232 && h2.h === h1.h && /\(232 rows replaced\)/.test(second.out), `${first.out.slice(0, 200)} | ${second.out.slice(0, 200)}`);
  check("each file's sha256 is recorded on its columns", shas.length === 3 && shas.every((x) => x.n === 1 && x.s === fileSha[x.template_kind]), JSON.stringify(shas));
  check("it prints counts and the models that differ, never a prompt, a list or a name",
    /companies 68, people 88, inboxes 76/.test(first.out) && /C#24 companys_website: the original gpt-4o-mini, the setting gpt-6-luna/.test(first.out) && !first.out.includes(FIXTURE_MARKER) && !first.out.includes("Widget"),
    first.out.slice(0, 600));
  const shortFile = path.join(tmp, "people-short.json");
  writeFileSync(shortFile, JSON.stringify({ ...exps.people, data: exps.people.data.slice(0, 87) }));
  const renamedFile = path.join(tmp, "companies-renamed.json");
  writeFileSync(renamedFile, JSON.stringify({ ...exps.companies, data: exps.companies.data.map((c, i) => (i === 30 ? { ...c, name: "Some Other Column" } : c)) }));
  const badV = `ogtest_bad_${RUN}`;
  const short = seedCli([...fixtureFiles({ people: shortFile }), "--variant", badV]);
  const renamedRun = seedCli([...fixtureFiles({ companies: renamedFile }), "--variant", badV]);
  check("a missing column refuses, and nothing is loaded", short.code === 1 && /people: 87 columns, 88 expected/.test(short.out) && (await variantRows(badV)).n === 0, short.out.slice(0, 300));
  check("a renamed column refuses, naming the position only", renamedRun.code === 1 && /C#31's name does not fit the key email_extraction_claygent/.test(renamedRun.out) && !renamedRun.out.includes("Some Other Column") && (await variantRows(badV)).n === 0, renamedRun.out.slice(0, 300));
  const tracksFile = path.join(tmp, "tracks.json");
  const t = deriveTracks(fixtureOriginals);
  t.operations.phrases.push("Vice President of Imaginary Things");
  writeFileSync(tracksFile, JSON.stringify(t));
  const tracksRun = seedCli([...fixtureFiles(), "--variant", badV, "--tracks", tracksFile]);
  check("tracks with a phrase its cited column doesn't hold refuse, and nothing is loaded", tracksRun.code === 1 && /people tracks were refused/.test(tracksRun.out) && (await variantRows(badV)).n === 0, tracksRun.out.slice(0, 300));
  check("a client variant loads beside default, which is left as it was", JSON.stringify(await variantRows("default")) === JSON.stringify(defaultBefore));
  check("the seed changes no setting (only the default variant writes people_tracks)", JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`)) === settingsBefore);
  const sum = await originalsSummary(pool, v);
  check("originalsSummary: the client's variant complete", sum.client?.complete === true && sum.client.total === 232, JSON.stringify(sum));
  await pool.query(`DELETE FROM enrich_originals WHERE variant = ANY($1::text[])`, [[v, dryVariant, badV]]);

  section("B2. ensurePipelineTables");
  const vA = await seedFixtureVariant(pool, A);
  const c = await pool.connect();
  let first2;
  let again;
  try {
    await c.query("BEGIN");
    first2 = await ensurePipelineTables(c, A);
    await c.query("COMMIT");
    await c.query("BEGIN");
    again = await ensurePipelineTables(c, A);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
  const tables = await all(`SELECT id, kind, name, template, source_note FROM enrich_tables WHERE client_tag = $1 ORDER BY kind`, [A]);
  const colsOf = async (id) => one(`SELECT count(*)::int AS n, count(clay_field_id)::int AS ids, count(DISTINCT key)::int AS k FROM enrich_columns WHERE table_id = $1`, [id]);
  const counts = {};
  for (const x of tables) counts[x.kind] = await colsOf(x.id);
  check("three tables, named \"(pipeline)\", with their templates and the client's variant noted",
    tables.length === 3 && tables.map((x) => `${x.kind}:${x.template}:${x.name}`).join("|") === "companies:companies_v2:Companies (pipeline)|inboxes:inboxes_v1:General (pipeline)|people:people_v1:People (pipeline)" &&
      tables.every((x) => x.source_note.includes(`(variant ${vA})`)) && first2.variant === vA,
    JSON.stringify(tables));
  check("their columns are the compiled templates, with clay_field_id set on the compiled ones",
    ["companies", "inboxes", "people"].every((k) => counts[k].n === compiled[k].length && counts[k].k === counts[k].n && counts[k].ids === compiled[k].filter((x) => x.clay_field_id).length),
    JSON.stringify(counts));
  check("a second call duplicates nothing", again.companies === first2.companies && Object.values(again.created).every((x) => x === false) && Object.values(first2.created).every((x) => x === true) && (await one(`SELECT count(*)::int AS n FROM enrich_tables WHERE client_tag = $1`, [A])).n === 3);
  const prompt = await one(`SELECT inputs->>'prompt' AS p FROM enrich_columns WHERE table_id = $1 AND key = 'companys_website'`, [first2.companies]);
  const stored41 = await one(`SELECT config FROM enrich_columns WHERE table_id = $1 AND key = 'company_decision_maker_facilities_1_claygent'`, [first2.companies]);
  check("stored as jsonb, an AI column keeps Clay's field order (answer_order), so its first field stays the cell's display",
    stored41.config.answer_order.join() === "Person_2_Full_Name,confidence,reasoning,Person_2_Title,Person_2_LinkedIn_URL" && answerSchema(stored41.config).fields.join() === stored41.config.answer_order.join(),
    JSON.stringify({ order: stored41.config.answer_order, keys: Object.keys(stored41.config.answer) }));
  check("a client's own variant is used when loaded", prompt.p.includes(`${FIXTURE_MARKER}-c24`) && (await variantFor(pool, A)) === vA && variantName("OGTEST A&B") === "ogtest_a_b" && variantName("DEFAULT") === null);
  await pool.query(`INSERT INTO enrich_columns (table_id, key, name, position, kind) VALUES ($1, 'zz_gone', 'Gone', 999, 'input')`, [first2.companies]);
  const { rows: [row] } = await pool.query(`INSERT INTO enrich_rows (table_id, row_key, run_status) VALUES ($1, $2, 'done') RETURNING id`, [first2.companies, `aiark:ogtest-${RUN}`]);
  await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value) VALUES ($1, 'zz_gone', $2, 'done', '"x"'), ($1, 'company', $2, 'done', '"Kept"')`, [row.id, first2.companies]);
  await (async () => {
    const cc = await pool.connect();
    try {
      await cc.query("BEGIN");
      await ensurePipelineTables(cc, A);
      await cc.query("COMMIT");
    } finally {
      cc.release();
    }
  })();
  const pruned = await all(`SELECT column_key FROM enrich_cells WHERE row_id = $1 ORDER BY 1`, [row.id]);
  check("a column the template no longer has is pruned, with its cells; other cells stay",
    !(await one(`SELECT 1 AS x FROM enrich_columns WHERE table_id = $1 AND key = 'zz_gone'`, [first2.companies])) && pruned.map((x) => x.column_key).join() === "company",
    JSON.stringify(pruned));

  // A client with a phase 1 table.
  await seedFixtureVariant(pool, V);
  await pool.query(`INSERT INTO enrich_tables (client_tag, kind, name, template, source_note) VALUES ($1, 'companies', 'Companies (pipeline)', 'companies_v1', 'phase 1')`, [V]);
  let refusedV1 = null;
  try {
    await ensurePipelineTables(pool, V);
  } catch (e) {
    refusedV1 = e;
  }
  check("a client with a companies_v1 table is refused (D24), and nothing is made", refusedV1 instanceof RetiredV1Table && refusedV1.tag === V && (await hasRetiredV1(pool, V)) && (await one(`SELECT count(*)::int AS n FROM enrich_tables WHERE client_tag = $1`, [V])).n === 1);

  // The pull route's refusals, in their order.
  await pool.query(`UPDATE enrich_settings SET value = value || jsonb_build_object('enabled', true, 'tags', '[]'::jsonb) WHERE key = 'company_pipeline'`);
  const pull = (t) => call(runs.POST, { body: { tag: t, mode: "demo", size: 10, matchCount: 5, rulesVersion: null, filtersVersion: null } });
  T.worker = heartbeat();
  const notListed = await pull(A);
  await pool.query(`UPDATE enrich_settings SET value = value || jsonb_build_object('tags', $1::jsonb) WHERE key = 'company_pipeline'`, [JSON.stringify([A, V, M])]);
  T.worker = heartbeat({ capabilities: ["company_runs"] });
  const oldWorker = await pull(A);
  T.worker = heartbeat();
  const v1Route = await pull(V);
  check("the pull route: 409 for a client not on company_pipeline.tags", notListed.status === 409 && /not on the company pipeline's client list/.test(notListed.body?.error ?? ""), JSON.stringify(notListed));
  check("... 409 for a worker without pipeline_v2", oldWorker.status === 409 && /Clay originals yet/.test(oldWorker.body?.error ?? ""), JSON.stringify(oldWorker));
  check("... 409 for a client with a companies_v1 table (D24)", v1Route.status === 409 && /companies_v1/.test(v1Route.body?.error ?? ""), JSON.stringify(v1Route));

  // Originals missing: the default set aside for a moment (when there is one), M has no variant.
  const aside = await pool.query(`UPDATE enrich_originals SET variant = $1 WHERE variant = 'default'`, [ASIDE]);
  let missing = null;
  let missingRoute = null;
  try {
    try {
      await ensurePipelineTables(pool, M);
    } catch (e) {
      missing = e;
    }
    missingRoute = await pull(M);
    let loadErr = null;
    try {
      await loadOriginals(pool, "default");
    } catch (e) {
      loadErr = e;
    }
    check("with the originals missing: OriginalsMissing, with the counts found", missing instanceof OriginalsMissing && loadErr instanceof OriginalsMissing && loadErr.counts.companies === 0 && /scripts\/enrich-seed-originals\.mjs/.test(loadErr.message));
    check("... and the route answers 409 \"The Clay originals are not loaded\"", missingRoute.status === 409 && /The Clay originals are not loaded/.test(missingRoute.body?.error ?? ""), JSON.stringify(missingRoute));
    check("... and nothing was made for the client", (await one(`SELECT count(*)::int AS n FROM enrich_tables WHERE client_tag = $1`, [M])).n === 0);
  } finally {
    await pool.query(`UPDATE enrich_originals SET variant = 'default' WHERE variant = $1`, [ASIDE]);
  }
  check(`the default originals are back as they were (${aside.rowCount} rows set aside)`, JSON.stringify(await variantRows("default")) === JSON.stringify(defaultBefore));

  section("B3. The settings migration 125 merges");
  const settings = settingsFrom(await all(`SELECT key, value FROM enrich_settings`));
  const stored = Object.fromEntries((await all(`SELECT key, value FROM enrich_settings`)).map((r) => [r.key, r.value]));
  check("company_pipeline gained its client list, LinkedIn reads, inboxes per company and the AI Ark floor, and lost the checks per company",
    ["tags", "linkedin_profile_reads", "inboxes_per_company", "min_balance"].every((k) => k in stored.company_pipeline) && !("email_checks_per_company" in stored.company_pipeline));
  check("models holds the twelve original-column settings 125 seeded and no phase 1 key",
    MODEL_SETTINGS.filter((k) => !["fit_score", "inbox_first_name_ai"].includes(k)).every((k) => k in stored.models) && !["website_search", "email_search_first", "email_search_second"].some((k) => k in stored.models) && settings.models.companys_website?.model?.length > 0);
  const storedNoG19 = Object.fromEntries(Object.entries(stored.models).filter(([k]) => k !== "inbox_first_name_ai"));
  check("G#19's setting (inbox_first_name_ai), which no migration seeds, reads gpt-6-luna from its default",
    settingsFrom([{ key: "models", value: storedNoG19 }]).models.inbox_first_name_ai?.model === "gpt-6-luna" &&
      ("inbox_first_name_ai" in stored.models || settings.models.inbox_first_name_ai?.model === "gpt-6-luna"));
  check("people_pipeline, personalisation and spend_caps are there, every switch off", ["people_pipeline", "personalisation", "spend_caps"].every((k) => k in stored) && !stored.people_pipeline.enabled && !stored.personalisation.enabled);
  const body = readFileSync(new URL("../supabase/migrations/125_people_pipeline.sql", import.meta.url), "utf8");
  const inner = body.slice(body.indexOf("BEGIN;") + "BEGIN;".length, body.lastIndexOf("COMMIT;"));
  const cc = await pool.connect();
  try {
    await cc.query("BEGIN");
    await cc.query(`UPDATE enrich_settings SET value = value || '{"max_pull_size": 777}'::jsonb || '{"email_checks_per_company": 4}'::jsonb WHERE key = 'company_pipeline'`);
    await cc.query(`UPDATE enrich_settings SET value = value || '{"companys_website": {"model": "gpt-zz-test", "max_searches": 1}, "website_search": {"model": "gpt-5-nano"}}'::jsonb WHERE key = 'models'`);
    await cc.query(inner);
    const after = Object.fromEntries((await cc.query(`SELECT key, value FROM enrich_settings`)).rows.map((r) => [r.key, r.value]));
    check("125 run again keeps stored values and removes phase 1's keys",
      after.company_pipeline.max_pull_size === 777 && !("email_checks_per_company" in after.company_pipeline) && after.models.companys_website.model === "gpt-zz-test" && !("website_search" in after.models),
      JSON.stringify({ cp: after.company_pipeline, w: after.models.companys_website }));
  } catch (e) {
    check("125 run again keeps stored values and removes phase 1's keys", false, e.message);
  } finally {
    await cc.query("ROLLBACK").catch(() => {});
    cc.release();
  }
}

async function cleanup() {
  await pool.query(`UPDATE enrich_originals SET variant = 'default' WHERE starts_with(variant, 'zz_aside_') AND NOT EXISTS (SELECT 1 FROM enrich_originals WHERE variant = 'default')`);
  const tables = (await all(`SELECT id FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM enrich_originals WHERE starts_with(variant, 'ogtest')`);
  if (originalSettings) {
    for (const r of originalSettings) await pool.query(`UPDATE enrich_settings SET value = $2 WHERE key = $1`, [r.key, JSON.stringify(r.value)]);
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

const t0 = Date.now();
let enrichDb = null;
try {
  const ready = await one(`SELECT to_regclass('public.enrich_originals') IS NOT NULL AS ok`);
  if (!ready.ok) throw new Error("migration 125 is not in this database");
  await cleanup(); // anything an interrupted run left behind
  originalSettings = await all(`SELECT key, value FROM enrich_settings WHERE key = 'company_pipeline'`);
  partA();
  if (process.env.CLAY_ORIGINALS_DIR) partReal(process.env.CLAY_ORIGINALS_DIR);
  const loader = routeLoader(randomUUID());
  enrichDb = await loader.srcModule("lib/enrich/db.ts");
  await partB({ ...loader, runs: await loader.route("companies/runs") });
  check("nothing tried to reach any address", net.calls.refused === 0 && Object.values(net.calls).every((n) => n === 0), JSON.stringify(net.calls));
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1)) AS tables,
            (SELECT count(*)::int FROM enrich_originals WHERE starts_with(variant, 'ogtest') OR starts_with(variant, 'zz_aside_')) AS originals`,
    [PREFIX]
  );
  const back = originalSettings ? JSON.stringify(await all(`SELECT key, value FROM enrich_settings WHERE key = 'company_pipeline'`)) === JSON.stringify(originalSettings) : true;
  const clean = left.tables === 0 && left.originals === 0 && back;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, back })}`}`);
  const { passed, failed } = totals();
  console.log(`${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await enrichDb?.enrichPool().end().catch(() => {});
  await pool.end();
  process.exit(failed || !clean ? 1 : 0);
}
