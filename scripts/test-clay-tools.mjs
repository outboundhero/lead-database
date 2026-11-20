#!/usr/bin/env node
// Our exact copies of Clay's normalize-company-name and extract-email-components
// (scripts/lib/enrich/clay-tools.mjs), wired into the General and People
// templates (G#14, G#16 and P#29; G#15, G#17, G#18 and P#30 read them), and
// G#19 as an AI step on its own model setting (inbox_first_name_ai). Made-up
// data only: company names holding "Tltest", addresses whose local part holds
// "tltest" or that end in .tltest.example, and the made-up client TLTEST_A.
//
//   node --env-file=.env.local scripts/test-clay-tools.mjs
//
// A and B need no database. C uses the LOCAL database only: the made-up Clay
// originals (scripts/fixtures/clay-originals) as TLTEST_A's own variant, its
// three pipeline tables, and rows worked in memory from those tables' stored
// columns (no row is written to them). What those rows record (Reoon's answer
// and the remembered answers of TLTEST_A, today's spend) is removed or put
// back at the end, with the tables and the variant. It refuses to run while
// any client is on the company_pipeline, people_pipeline, personalisation or
// promotion list, while another client's row is held, or while a worker's
// heartbeat is fresh: stop the worker first.
//
// Nothing here reaches a network: fetch answers OpenAI and Reoon from stubs
// and refuses every other address. The keys are made up.
//
//   A. normalizeCompanyName: one check per rule and quirk, each expected
//      value worked out by hand from Clay's rules
//   B. extractEmailComponents: the 14 fields, the providers and flags, the
//      display; the two actions
//   C. wiring: the compiled templates, inbox and People rows worked in
//      memory, toolInputs' refusals, G#19 and its model setting, what still
//      waits, the stand-ins left as they were

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checker, dropPaidKeys, inTx, installNet, localDatabaseUrl, routeLoader, seedFixtureVariant, tableDef } from "./fixtures/test-support.mjs";
import { fixtureId, fixtureSeedExports } from "./fixtures/clay-originals/fixtures.mjs";
import { originalRows, originalsMap } from "./lib/enrich/seed-originals.mjs";
import { refMap } from "./lib/enrich/compile-original.mjs";
import { compileTemplates, ensurePipelineTables, variantName } from "./lib/enrich/templates.mjs";
import { INBOX_REFS, inboxColumns } from "./lib/enrich/inbox-template.mjs";
import { runRow, stable } from "./lib/enrich/engine.mjs";
import { ACTIONS } from "./lib/enrich/actions.mjs";
import { PIPELINE_ACTIONS } from "./lib/enrich/pipeline-actions.mjs";
import { MODEL_SETTINGS, settingsFrom, SETTINGS_DEFAULTS } from "./lib/enrich/settings.mjs";
import * as standins from "./lib/enrich/tool-standins.mjs";
import {
  CLAY_TOOL_ACTIONS, CLAY_TOOL_BINDINGS, companyNameDisplay, emailComponentsDisplay, extractEmailComponents, normalizeCompanyName, toolInputs,
} from "./lib/enrich/clay-tools.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

const PREFIX = "TLTEST_";
const A = `${PREFIX}A`;
const RUN = randomUUID().slice(0, 6);
const HOST = "tltest.example";
const at = (local, slug) => `${local}@${slug}-${RUN}.${HOST}`;
const KEYS = { OPENAI_API_KEY: "made-up-openai", ENRICH_REOON_API_KEY: "made-up-reoon" };
const CHECK_MARK = "\u2705";
const SWITCH_LISTS = ["company_pipeline", "people_pipeline", "personalisation", "promotion"];

const thrown = (fn) => {
  try {
    fn();
    return "";
  } catch (e) {
    return String(e?.message ?? e);
  }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── A. normalizeCompanyName ─────────────────────────────────────────────────

/** One check over several names: each [input, expected] (title case on unless a third item says false). */
function names(label, cases) {
  const wrong = [];
  for (const [input, want, titleCase = true] of cases) {
    const got = normalizeCompanyName(input, { titleCase }).normalized_name;
    if (got !== want) wrong.push(`${JSON.stringify(input)} gave ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
  }
  check(label, wrong.length === 0, wrong.join("; "));
}

function partA() {
  section("A. normalizeCompanyName, rule by rule");
  names("1-2. double quotes, emoji, the registered sign and U+FE0F deleted; the degree sign and a curly apostrophe kept", [
    ["\"Plover\" Tltest \u{1F680} Studio\u00AE", "Plover Tltest Studio"],
    ["Plover Tltest \u2764\uFE0F Care", "Plover Tltest Care"],
    ["Plover\u00B0 Tltest\u2019s Care", "Plover\u00B0 Tltest\u2019s Care"],
  ]);
  names("3. each (...) group becomes a space, the text after it stays", [
    ["Plover (North) Tltest (East)", "Plover Tltest"],
    ["Plover Tltest (North - East) Care", "Plover Tltest Care"],
  ]);
  names("4. cut at whitespace then \"-\" or \"|\"; not at \"--\", \"- \", an en dash or \"/\"", [
    ["Plover Tltest - Cleaning Crew", "Plover Tltest"],
    ["Plover Tltest | Cleaning", "Plover Tltest"],
    ["Plover Tltest -Crew", "Plover Tltest"],
    ["Plover--Tltest", "Plover--Tltest"],
    ["Plover- Tltest", "Plover- Tltest"],
    ["Plover \u2013 Tltest", "Plover \u2013 Tltest"],
    ["Plover / Tltest", "Plover / Tltest"],
  ]);
  names("5. cut at \"dba\" or \"d.b.a\", any case", [
    ["Plover Tltest DBA Quillon Care", "Plover Tltest"],
    ["Plover Tltest d.b.a. Quillon", "Plover Tltest"],
    ["Plover Tltest dba Quillon", "Plover Tltest"],
  ]);
  names("5. ... its dots match any character: a word shaped d?b?a after a space cuts, one whose a is not two after the b doesn't", [
    ["Plover Dabra Tltest", "Plover"],
    ["Plover Dabble Tltest", "Plover Dabble Tltest"],
  ]);
  names("6. whitespace collapsed and trimmed", [["  Plover   Tltest  ", "Plover Tltest"]]);
  names("7. a trailing any-character plus lower-case \"com\" deleted, case sensitive, before the suffix step", [
    ["Plover Tltest.com", "Plover Tltest"],
    ["Plover Telecom", "Plover Tel"],
    ["Plover Tltest.Com", "Plover Tltest.Com"],
    ["PLOVER TLTEST.COM", "Plover Tltest Com"],
    ["Quillcom Inc", "Quillcom"],
  ]);
  names("8. one suffix only, after whitespace (a comma before it goes too)", [
    ["Plover Tltest Group LLC", "Plover Tltest Group"],
    ["Plover Tltest Company Inc", "Plover Tltest Company"],
    ["Plover, Tltest, LLC", "Plover, Tltest"],
    ["Plover Tltest Holdings, Inc.", "Plover Tltest Holdings"],
    ["PLOVER,INC.", "Plover Inc"],
    ["Plover,Inc.", "Plover,Inc."],
  ]);
  names("8. ... the suffixes' dots match any character: CO2, P.C, PLC and BLVD go; P.C., PC and Corp. stay; Corp goes", [
    ["Plover CO2", "Plover"],
    ["Plover Tltest P.C", "Plover Tltest"],
    ["Plover Tltest PLC", "Plover Tltest"],
    ["Plover BLVD", "Plover"],
    ["Plover Tltest P.C.", "Plover Tltest P.C."],
    ["Plover Tltest PC", "Plover Tltest PC"],
    ["Plover Corp", "Plover"],
    ["Plover Corp.", "Plover Corp."],
  ]);
  names("9. trailing commas deleted after the suffix step (Inc, goes as \"inc.\"; PLLC, stays)", [
    ["Plover Tltest PLLC,", "Plover Tltest PLLC"],
    ["Plover Tltest Inc,", "Plover Tltest"],
  ]);
  names("8-10. \"& Co\": the \"&\" stays in mixed case, the all-caps path drops it", [
    ["Plover Tltest & Co", "Plover Tltest &"],
    ["PLOVER TLTEST & CO", "Plover Tltest"],
  ]);
  names("10. title case only for all-upper or all-lower text", [
    ["plover tltest cleaning", "Plover Tltest Cleaning"],
    ["PLOVER TLTEST CLEANING", "Plover Tltest Cleaning"],
    ["Plover TLTEST cleaning", "Plover TLTEST cleaning"],
    ["PLOVER-TLTEST CLEANING", "Plover Tltest Cleaning"],
  ]);
  names("10. digits split from letters (no ordinal rule: 5TH gives 5 Th), apostrophes dropped, single letters merge", [
    ["PLOVER 5TH AVE", "Plover 5 Th Ave"],
    ["PLOVER4TLTEST", "Plover 4 Tltest"],
    ["PLOVER'S TLTEST", "Plovers Tltest"],
    ["PLOVER\u2019S TLTEST", "Plovers Tltest"],
    ["A B C", "A BC"],
    ["R.J. TLTEST", "R J Tltest"],
    ["TLTEST D.D.S.", "Tltest DDS"],
  ]);
  names("titleCase off leaves the case as it is", [["PLOVER TLTEST LLC", "PLOVER TLTEST", false], ["plover tltest", "plover tltest", false]]);
  check("titleCase is off unless asked; original_name is the input unchanged (String() of a non-string)",
    same(normalizeCompanyName("PLOVER TLTEST LLC"), { original_name: "PLOVER TLTEST LLC", normalized_name: "PLOVER TLTEST" }) &&
      same(normalizeCompanyName("  Plover \"Tltest\"  ", { titleCase: true }), { original_name: "  Plover \"Tltest\"  ", normalized_name: "Plover Tltest" }) &&
      same(normalizeCompanyName(42, { titleCase: true }), { original_name: "42", normalized_name: "42" }));
  check("an empty result is \"\" (never seen in Clay's answers)", normalizeCompanyName("(Tltest)", { titleCase: true }).normalized_name === "");
}

// ── B. extractEmailComponents and the two actions ───────────────────────────

const PROVIDER_FLAGS = { GMAIL: "isGmail", YAHOO: "isYahoo", HOTMAIL: "isHotmail", ICLOUD: "isiCloud", PROTONMAIL: "isProton" };

async function partB() {
  section("B. extractEmailComponents");
  const ann = extractEmailComponents("tltest.ann-lee@gmail.com");
  check("the 14 fields of a Gmail address, in Clay's order",
    same(ann, {
      domain: "gmail.com", address: "tltest.ann-lee@gmail.com", isGmail: true, isYahoo: false, isProton: false, isYandex: false, isiCloud: false,
      username: "tltest.ann-lee", isHotmail: false, guessedName: "Tltest Ann Lee", emailProvider: "GMAIL",
      isLikelyCompanyEmail: false, isLikelyPersonalEmail: true, isLikelyEducationEmail: false,
    }),
    JSON.stringify(ann));
  const co = extractEmailComponents("tltest.bo@Plover.TLTEST.example");
  check("a company address: the registrable domain in lower case, UNKNOWN, likely a company's",
    co.domain === HOST && co.username === "tltest.bo" && co.guessedName === "Tltest Bo" && co.emailProvider === "UNKNOWN" &&
      co.isLikelyCompanyEmail === true && co.isLikelyPersonalEmail === false && Object.keys(co).length === 14,
    JSON.stringify(co));
  const uk = extractEmailComponents("Tltest.Info@Mail.Plover-Tltest.co.uk");
  const jp = extractEmailComponents("tltest_k2@sales.plover-tltest.co.jp");
  check("a sub-domain host gives its registrable domain under a two-part suffix (.co.uk, .co.jp); the username keeps its case",
    uk.domain === "plover-tltest.co.uk" && uk.username === "Tltest.Info" && uk.guessedName === "Tltest Info" &&
      jp.domain === "plover-tltest.co.jp" && jp.emailProvider === "UNKNOWN",
    JSON.stringify([uk.domain, uk.username, jp.domain]));
  check("the guessed name splits on \".\" and \"-\" only: \"_\" and digits don't split; each part capitalised",
    jp.guessedName === "Tltest_k2" && extractEmailComponents(`77tltest@x.${HOST}`).guessedName === "77tltest" &&
      extractEmailComponents(`TLTEST.MARY_K2@x.${HOST}`).guessedName === "Tltest Mary_k2" && extractEmailComponents(`tltest.o-neil@x.${HOST}`).guessedName === "Tltest O Neil");
  const providers = {
    "me.com": "ICLOUD", "icloud.com": "ICLOUD", "mac.com": "UNKNOWN", "proton.me": "UNKNOWN", "protonmail.com": "PROTONMAIL", "qq.com": "TENCENT-QQ",
    "live.com": "OUTLOOK", "outlook.com": "OUTLOOK", "msn.com": "MSN", "aol.com": "AOL", "yahoo.co.nz": "YAHOO", "hotmail.es": "HOTMAIL", "yandex.ru": "UNKNOWN",
  };
  const wrong = [];
  for (const [d, want] of Object.entries(providers)) {
    const o = extractEmailComponents(`tltest@${d}`);
    const flagsOk = Object.entries(PROVIDER_FLAGS).every(([p, f]) => o[f] === (want === p)) && o.isYandex === false &&
      o.isLikelyPersonalEmail === (want !== "UNKNOWN") && o.isLikelyCompanyEmail === (want === "UNKNOWN");
    if (o.emailProvider !== want || o.domain !== d || !flagsOk) wrong.push(`${d}: ${o.emailProvider}`);
  }
  check("the provider by the domain's name label (regional domains like the .com), with its flags: OUTLOOK and MSN are not Hotmail, mac.com and proton.me are UNKNOWN, isYandex stays false",
    wrong.length === 0, wrong.join(", "));
  check("isLikelyEducationEmail: the domain ends in .edu", extractEmailComponents("tltest@campus.tltest.edu").isLikelyEducationEmail === true && ann.isLikelyEducationEmail === false);
  const two = extractEmailComponents(`tltest@x@plover.${HOST}`);
  check("split at the last \"@\"; no \"@\" gives null", two.username === "tltest@x" && two.domain === HOST && extractEmailComponents("tltest.no-at-sign") === null && extractEmailComponents(null) === null);
  check("the displays, as Clay shows the cells", emailComponentsDisplay(ann) === "Domain: gmail.com | Name: Tltest Ann Lee" &&
    companyNameDisplay({ normalized_name: "Plover Tltest" }) === `${CHECK_MARK} Plover Tltest`);

  section("B. The two actions");
  const run = (action, inputs) => CLAY_TOOL_ACTIONS[action].run({ inputs, config: {}, env: {}, db: null });
  const on = await run("clay_normalize_company_name", { companyName: "PLOVER TLTEST LLC", titleCase: true });
  const onText = await run("clay_normalize_company_name", { companyName: "PLOVER TLTEST LLC", titleCase: "true" });
  const absent = await run("clay_normalize_company_name", { companyName: "PLOVER TLTEST LLC" });
  const offText = await run("clay_normalize_company_name", { companyName: "PLOVER TLTEST LLC", titleCase: "false" });
  check("company name: done with the whole answer, Clay's display and our note; title case on for true or \"true\" only",
    on.status === "done" && same(on.value, { original_name: "PLOVER TLTEST LLC", normalized_name: "Plover Tltest" }) && on.display === `${CHECK_MARK} Plover Tltest` &&
      on.note === "Clay's normalize-company-name (exact copy)" && onText.value.normalized_name === "Plover Tltest" &&
      absent.value.normalized_name === "PLOVER TLTEST" && offText.value.normalized_name === "PLOVER TLTEST",
    JSON.stringify([on, absent.value]));
  const noName = await Promise.all([undefined, null, ""].map((v) => run("clay_normalize_company_name", { companyName: v, titleCase: true })));
  check("company name: none gives empty, \"No company name\"", noName.every((r) => r.status === "empty" && r.note === "No company name"));
  const mail = await run("clay_extract_email_components", { email: "tltest.ann-lee@gmail.com" });
  check("email: done with the 14 fields, Clay's display and our note", mail.status === "done" && same(mail.value, ann) &&
    mail.display === "Domain: gmail.com | Name: Tltest Ann Lee" && mail.note === "Clay's extract-email-components (exact copy)");
  const notMail = await Promise.all([undefined, "", "tltest-no-at"].map((v) => run("clay_extract_email_components", { email: v })));
  check("email: none, or no \"@\", gives empty, \"Not an email address\"", notMail.every((r) => r.status === "empty" && r.note === "Not an email address"));
  const bad = { toString() { throw new Error("made-up failure"); } };
  const e1 = await run("clay_normalize_company_name", { companyName: bad });
  const e2 = await run("clay_extract_email_components", { email: bad });
  check("an exception is an error that is not retried", [e1, e2].every((r) => r.status === "error" && r.retryable === false && /made-up failure/.test(r.note)), JSON.stringify([e1, e2]));
}

// ── C. Wiring ───────────────────────────────────────────────────────────────

const fixtureOriginals = originalsMap(originalRows(fixtureSeedExports()));
const compiled = compileTemplates(fixtureOriginals, { settings: null });
const col = (kind, key) => compiled[kind].find((c) => c.key === key);
const texts = (c) => [c.formula, c.run_if, ...(c.waterfall ?? []), ...Object.values(c.inputs ?? {})].filter((x) => typeof x === "string");
const TOOL_ACTIONS = ["clay_normalize_company_name", "clay_extract_email_components"];

function partC1() {
  section("C1. The templates compiled from the made-up originals");
  const g14 = col("inboxes", "normalize_company_name");
  const g16 = col("inboxes", "identify_email_type_and_extract_company_domain_from_email");
  const p29 = col("people", "normalize_company_name");
  check("G#14 and P#29 run our copy of normalize-company-name, G#16 our extract-email-components",
    g14.action === "clay_normalize_company_name" && p29.action === "clay_normalize_company_name" && g16.action === "clay_extract_email_components" &&
      [g14, g16, p29].every((c) => c.kind === "action" && c.provider === "Clay tool (exact copy)" && c.needs_env.length === 0 && same(c.config, {})));
  check("their inputs are the originals' own bindings, the references rewritten to keys",
    same(g14.inputs, { companyName: "{{company}}", titleCase: "true" }) && same(p29.inputs, { companyName: "{{company}}", titleCase: "true" }) &&
      same(g16.inputs, { email: "{{general_email}}" }),
    JSON.stringify([g14.inputs, g16.inputs, p29.inputs]));
  check("their run conditions are the originals', verbatim: G#14 on the company, G#16 on an approved address (G#44), P#29 on SAFE TO RUN; P#29 has no upload gate",
    g14.run_if === "{{company}}" && g16.run_if === "!!{{general_email}} && {{email_valid}} === true" && p29.run_if === "!!{{company}} && {{safe_to_run}} === true",
    JSON.stringify([g14.run_if, g16.run_if, p29.run_if]));
  check("each carries its Clay field id, and no Clay id is left in their text",
    g14.clay_field_id === fixtureId("inboxes", 14) && g16.clay_field_id === fixtureId("inboxes", 16) && p29.clay_field_id === fixtureId("people", 29) &&
      [g14, g16, p29].every((c) => texts(c).every((t) => !/\{\{\s*f_/.test(t))));
  check("G#15, G#17, G#18 and P#30 read the tools' fields", col("inboxes", "normalized_company_name").formula === "{{normalize_company_name}}?.normalized_name" &&
    col("inboxes", "username").formula === "{{identify_email_type_and_extract_company_domain_from_email}}?.username" &&
    col("inboxes", "guessed_name").formula === "{{identify_email_type_and_extract_company_domain_from_email}}?.guessedName" &&
    col("people", "normalized_company_name").formula === "{{normalize_company_name}}?.normalized_name");
  const g19 = col("inboxes", "first_name_ai");
  check("G#19 is an AI step on its own model setting, inbox_first_name_ai, with no tool and no switch; its run condition and table examples are the original's",
    g19.action === "ai_web" && g19.config.model_setting === "inbox_first_name_ai" && g19.config.tool === "none" && !g19.config.flag &&
      g19.config.memory === "inbox_first_name_ai_v1" && same(g19.needs_env, ["OPENAI_API_KEY"]) && typeof g19.config.table_examples === "string" &&
      g19.run_if === "!!{{general_email}} && {{email_valid}} === true && !!{{guessed_name}}" && g19.clay_field_id === fixtureId("inboxes", 19),
    JSON.stringify({ action: g19.action, config: { ...g19.config, answer: undefined, table_examples: undefined }, run_if: g19.run_if }));
  const phone = [col("inboxes", "normalize_phone_number"), col("people", "normalize_phone_number")];
  check("P#18 and G#35 (normalize-phone-number) still wait", phone.every((c) => c.action === "waiting" && c.run_if === null && c.config.clay_action === "normalize-phone-number" && /normalize-phone-number/.test(c.config.why)));
  const waiting = Object.values(compiled).flat().filter((c) => c.action === "waiting").map((c) => c.key);
  check("nothing else waits", same([...new Set(waiting)], ["normalize_phone_number"]) && waiting.length === 2, waiting.join(", "));

  section("C2. Registration");
  check("both actions are in PIPELINE_ACTIONS (last) and ACTIONS, free and local (cache false)",
    same(Object.keys(PIPELINE_ACTIONS).slice(-2), TOOL_ACTIONS) && TOOL_ACTIONS.every((a) => ACTIONS[a] === CLAY_TOOL_ACTIONS[a] && ACTIONS[a].cache === false));
  check("each names the bindings it needs", same(CLAY_TOOL_BINDINGS, { clay_normalize_company_name: ["companyName"], clay_extract_email_components: ["email"] }));
  check("no action name starts with normalize_ (the stand-ins' names, which no template column may use)",
    !Object.keys(ACTIONS).some((a) => a.startsWith("normalize_") && a !== "normalize_url") && !ACTIONS.normalize_company_name && !ACTIONS.normalize_phone_number);
  const src = ["inbox-template.mjs", "people-template.mjs", "company-template-v2.mjs"].map((f) => readFileSync(new URL(`./lib/enrich/${f}`, import.meta.url), "utf8")).join("\n");
  check("tool-standins.mjs stays as it was and unused: its exports are there, no template names them",
    typeof standins.normalizeCompanyName === "function" && typeof standins.normalizePhoneNumber === "function" &&
      same(Object.keys(standins.TOOL_STANDIN_ACTIONS), ["normalize_company_name", "normalize_phone_number"]) &&
      !/action:\s*"normalize_(company_name|phone_number)"/.test(src) && !/tool-standins/.test(src));

  section("C3. toolInputs refuses what it can't compile (in memory)");
  const without = (kind, position, edit) => {
    const m = new Map(fixtureOriginals);
    const key = `${kind}:${position}`;
    const row = structuredClone(m.get(key));
    edit(row.definition.settings);
    m.set(key, row);
    return m;
  };
  const noName = without("inboxes", 14, (s) => { s.inputsBinding = s.inputsBinding.filter((b) => b.name !== "companyName"); });
  const own = refMap(noName, "inboxes", INBOX_REFS);
  check("a G#14 with no companyName binding: refused, and the General template does not compile from it",
    thrown(() => toolInputs(noName, "G#14", own, "clay_normalize_company_name")) === "G#14: the original has no companyName input" &&
      thrown(() => inboxColumns(noName)) === "G#14: the original has no companyName input" && /no companyName input/.test(thrown(() => compileTemplates(noName))));
  const blankName = without("people", 29, (s) => { s.inputsBinding = s.inputsBinding.map((b) => (b.name === "companyName" ? { ...b, formulaText: "  " } : b)); });
  check("... a blank companyName binding on P#29 too", /^P#29: the original has no companyName input$/.test(thrown(() => compileTemplates(blankName))));
  const unknown = without("inboxes", 16, (s) => { s.inputsBinding = s.inputsBinding.map((b) => (b.name === "email" ? { ...b, formulaText: "{{f_tltest_nowhere}}" } : b)); });
  check("a G#16 whose email reads a column the template does not map: refused",
    thrown(() => toolInputs(unknown, "G#16", refMap(unknown, "inboxes", INBOX_REFS), "clay_extract_email_components")) === "G#16 reads a column this template does not map" &&
      thrown(() => compileTemplates(unknown)) === "G#16 reads a column this template does not map");
  check("an action that is not one of the tools: refused", /is not one of the Clay tools/.test(thrown(() => toolInputs(fixtureOriginals, "G#14", own, "normalize_company_name"))));
  check("the made-up originals themselves compile (the refusals came from the edits)", compiled.inboxes.length > 40 && compiled.people.length > 40);
}

async function partC2() {
  section("C4. G#19's model setting");
  const i = MODEL_SETTINGS.indexOf("inbox_first_name_ai");
  check("MODEL_SETTINGS holds inbox_first_name_ai, right before inbox_claygent (14 settings)",
    i > 0 && MODEL_SETTINGS[i + 1] === "inbox_claygent" && MODEL_SETTINGS.length === 14);
  check("its default is gpt-6-luna with no searches and no reasoning effort", same(SETTINGS_DEFAULTS.models.inbox_first_name_ai, { model: "gpt-6-luna" }));
  const stored = settingsFrom([{ key: "models", value: { companys_website: { model: "gpt-6-luna", max_searches: 3 } } }]);
  check("a stored models row without it takes the default (no migration)", stored.models.inbox_first_name_ai?.model === "gpt-6-luna" && !stored.models.inbox_first_name_ai.max_searches);
  const { MODEL_STEPS } = await routeLoader(randomUUID()).srcModule("lib/companies/types.ts");
  const step = MODEL_STEPS.find((s) => s.key === "inbox_first_name_ai");
  check("the settings sheet's list holds it, before inbox_claygent",
    same(step, { key: "inbox_first_name_ai", label: "First name (inboxes)", hint: "Guesses a first name from a general inbox's address, with Clay's examples. No web search.", tool: "none", table: "General" }) &&
      MODEL_STEPS[MODEL_STEPS.indexOf(step) + 1]?.key === "inbox_claygent",
    JSON.stringify(step));
  check("... and the sheet's steps are the model settings but the fit scorer, in the same order", same(MODEL_STEPS.map((s) => s.key), MODEL_SETTINGS.filter((k) => k !== "fit_score")));
}

// ── C. Rows worked in memory, from TLTEST_A's stored columns ────────────────

/** One row worked in memory, as the worker would, forced (no answer reused): its cells, the engine's answer and the run records. */
async function work(def, inputs, settings) {
  const stored = new Map(Object.entries(inputs).filter(([, v]) => v !== "" && v != null).map(([k, v]) => [k, { status: "done", value: v }]));
  const cells = new Map(stored);
  const runs = [];
  const out = await runRow({
    row: { id: 0, created_at: new Date("2026-11-21T00:00:00Z"), run_force: ["*"], next_run_at: new Date() },
    table: def.table, columns: def.columns, cells: stored, env: KEYS, db: pool, settings,
    hooks: { changed: (k, c) => cells.set(k, c), ran: (r) => runs.push(r) },
  });
  return { ...out, cells, runs, cell: (k) => cells.get(k) };
}

/** G#19 on this branch is skipped while its examples are not sent (actions.mjs); once they are, the planned answer "not a name". */
const g19Settled = (c) => (c?.status === "skipped" && /table examples/.test(c.note ?? "")) || (c?.status === "done" && c.value?.response === "not a name");

async function partC3(settings) {
  section("C5. TLTEST_A's tables, compiled from its own variant (the made-up originals)");
  const variant = await seedFixtureVariant(pool, A);
  const ids = await inTx(pool, (c) => ensurePipelineTables(c, A));
  const inbox = await tableDef(pool, ids.inboxes);
  const people = await tableDef(pool, ids.people);
  const storedCol = (def, key) => def.columns.find((c) => c.key === key);
  const pairs = [[inbox, "inboxes", "normalize_company_name"], [inbox, "inboxes", "identify_email_type_and_extract_company_domain_from_email"], [people, "people", "normalize_company_name"]];
  // jsonb keeps no key order, so the inputs are compared with their keys sorted.
  check("the stored tool columns are the compiled ones (action, inputs, run condition), through jsonb",
    ids.variant === variant && variant === variantName(A) &&
      pairs.every(([def, kind, key]) => { const s = storedCol(def, key); const c = col(kind, key); return s.action === c.action && stable(s.inputs) === stable(c.inputs) && s.run_if === c.run_if; }) &&
      storedCol(inbox, "first_name_ai").action === "ai_web" && storedCol(inbox, "first_name_ai").config.model_setting === "inbox_first_name_ai",
    JSON.stringify(pairs.map(([def, , key]) => { const s = storedCol(def, key); return { key, action: s.action, inputs: s.inputs, run_if: s.run_if }; })));

  section("C6. An inbox row worked in memory: Reoon approves the address");
  net.openai.set("G19", { response: "not a name" });
  const email = at("info", "plover");
  net.reoon.set(email, "safe");
  const base = { general_email: email, company: "PLOVER TLTEST CLEANING LLC", client_tag: A, domain: `plover-${RUN}.${HOST}`, website: `plover-${RUN}.${HOST}`, city: "Tltestville", state: "IL" };
  const r1 = await work(inbox, base, settings);
  const g14 = r1.cell("normalize_company_name");
  const g16 = r1.cell("identify_email_type_and_extract_company_domain_from_email");
  check("G#14: Clay's answer and display, worked out locally (no run record)",
    g14?.status === "done" && same(g14.value, { original_name: "PLOVER TLTEST CLEANING LLC", normalized_name: "Plover Tltest Cleaning" }) &&
      g14.display === `${CHECK_MARK} Plover Tltest Cleaning` && g14.runs === 0 && !r1.runs.some((x) => x.column_key === "normalize_company_name"),
    JSON.stringify(g14));
  check("G#15 holds the normalized name", r1.cell("normalized_company_name")?.value === "Plover Tltest Cleaning");
  check("G#16: the 14 fields and Clay's display, worked out locally (no run record)",
    g16?.status === "done" && same(g16.value, extractEmailComponents(email)) && g16.display === `Domain: ${HOST} | Name: Info` && g16.runs === 0 &&
      !r1.runs.some((x) => x.column_key === "identify_email_type_and_extract_company_domain_from_email"),
    JSON.stringify(g16));
  check("G#17 and G#18 hold the username and the guessed name", r1.cell("username")?.value === "info" && r1.cell("guessed_name")?.value === "Info");
  check("G#19 runs on its own setting: skipped while its examples are not sent, else the planned answer", g19Settled(r1.cell("first_name_ai")), JSON.stringify(r1.cell("first_name_ai")));
  check("G#20 falls to its second step: \"<normalized name> Team\"", r1.cell("use_first_name")?.value === "Plover Tltest Cleaning Team", JSON.stringify(r1.cell("use_first_name")));
  check("the row is done: approved, nothing in error or waiting",
    r1.errors === 0 && r1.needsKey === 0 && !r1.retryable && r1.cell("inbox_outcome")?.value === "Approved",
    JSON.stringify({ errors: r1.errors, needsKey: r1.needsKey, retryable: r1.retryable, outcome: r1.cell("inbox_outcome")?.value }));

  section("C7. Inbox rows the originals' run conditions stop");
  const rejected = at("office", "quillon");
  net.reoon.set(rejected, "invalid");
  const r2 = await work(inbox, { ...base, general_email: rejected, company: "Quillon Tltest Care" }, settings);
  check("an address Reoon rejects: G#16 is not run, G#17, G#18 and G#19 stay empty, G#20 reads the company",
    r2.cell("identify_email_type_and_extract_company_domain_from_email")?.status === "skipped" && /Run condition not met/.test(r2.cell("identify_email_type_and_extract_company_domain_from_email")?.note ?? "") &&
      r2.cell("username")?.status === "empty" && r2.cell("guessed_name")?.status === "empty" && r2.cell("first_name_ai")?.status === "skipped" &&
      r2.cell("normalized_company_name")?.value === "Quillon Tltest Care" && r2.cell("use_first_name")?.value === "Quillon Tltest Care Team" &&
      r2.cell("inbox_outcome")?.value === "Rejected by Reoon" && r2.errors === 0 && r2.needsKey === 0,
    JSON.stringify({ g16: r2.cell("identify_email_type_and_extract_company_domain_from_email"), g20: r2.cell("use_first_name")?.value, outcome: r2.cell("inbox_outcome")?.value }));
  const noCompany = at("team", "nocompany");
  net.reoon.set(noCompany, "safe");
  const r3 = await work(inbox, { ...base, general_email: noCompany, company: "" }, settings);
  check("no company: G#14 is not run and G#15 is empty, so G#20's second step gives \"undefined Team\", as in Clay (promotion holds it back)",
    r3.cell("normalize_company_name")?.status === "skipped" && /Run condition not met/.test(r3.cell("normalize_company_name")?.note ?? "") &&
      r3.cell("normalized_company_name")?.status === "empty" && r3.cell("guessed_name")?.value === "Team" && g19Settled(r3.cell("first_name_ai")) &&
      r3.cell("use_first_name")?.value === "undefined Team",
    JSON.stringify({ g14: r3.cell("normalize_company_name"), g20: r3.cell("use_first_name")?.value }));

  section("C8. A People row worked in memory");
  const source = { name: "Pat Tltest", last_name: "Tltest", latest_experience_title: "Owner", latest_experience_company: "PLOVER TLTEST CLEANING LLC", url: "", location_name: "", domain: `plover-${RUN}.${HOST}` };
  const p = await work(people, { find_people_from_linkedin_company_url: source, client_tag: A, found_by: "aiark", stage: "no_email", person_country: "US" }, settings);
  const p29 = p.cell("normalize_company_name");
  check("P#29 runs on SAFE TO RUN: Clay's answer and display; P#30 holds the normalized name",
    p.cell("safe_to_run")?.value === true && p29?.status === "done" && p29.value?.normalized_name === "Plover Tltest Cleaning" &&
      p29.display === `${CHECK_MARK} Plover Tltest Cleaning` && p29.runs === 0 && p.cell("normalized_company_name")?.value === "Plover Tltest Cleaning",
    JSON.stringify({ safe: p.cell("safe_to_run"), p29, p30: p.cell("normalized_company_name") }));
  check("P#18 still waits on the row", p.cell("normalize_phone_number")?.status === "skipped" && /normalize-phone-number/.test(p.cell("normalize_phone_number")?.note ?? ""));
}

// ── Run ─────────────────────────────────────────────────────────────────────

let spendBefore = null;

async function cleanup() {
  const tables = (await all(`SELECT id FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  await pool.query(`DELETE FROM enrich_memory WHERE starts_with(client_tag, $1) OR table_id = ANY($2::uuid[]) OR key LIKE $3`, [PREFIX, tables, `%.${HOST}%`]);
  await pool.query(`DELETE FROM email_validations WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM enrich_originals WHERE starts_with(variant, $1)`, [PREFIX.toLowerCase()]);
  if (spendBefore) {
    await pool.query(`DELETE FROM enrich_spend_daily WHERE NOT ((day::text || '|' || kind) = ANY($1::text[]))`, [spendBefore.map((r) => `${r.day}|${r.kind}`)]);
    for (const r of spendBefore) {
      await pool.query(
        `INSERT INTO enrich_spend_daily (day, kind, used, updated_at) VALUES ($1::date, $2, $3::numeric, $4)
         ON CONFLICT (day, kind) DO UPDATE SET used = EXCLUDED.used, updated_at = EXCLUDED.updated_at`,
        [r.day, r.kind, r.used, r.updated_at]
      );
    }
  }
}

const spendNow = () => all(`SELECT day::text AS day, kind, used::text AS used FROM enrich_spend_daily ORDER BY day, kind`);
const t0 = Date.now();
try {
  await partA();
  await partB();
  partC1();
  await partC2();

  const ready = await one(`SELECT to_regclass('public.enrich_originals') IS NOT NULL AS m125`);
  if (!ready.m125) throw new Error("migration 125 is not in this database");
  const worker = await one(`SELECT count(*)::int AS n FROM enrich_worker_state WHERE last_seen > now() - interval '30 seconds' AND NOT coalesce((info->>'stopped')::boolean, false)`);
  if (worker.n) throw new Error("an enrichment worker's heartbeat is fresh: stop it first");
  const rows = await all(`SELECT key, value FROM enrich_settings`);
  const base = settingsFrom(rows);
  const held = await one(
    `SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id WHERE r.run_status = 'held' AND NOT starts_with(t.client_tag, $1)`,
    [PREFIX]
  );
  const listed = Object.fromEntries(SWITCH_LISTS.map((k) => [k, base[k].tags]));
  const free = held.n === 0 && Object.values(listed).every((t) => t.length === 0);
  check("before part C: no client on the company_pipeline, people_pipeline, personalisation or promotion list, and no other client's held row", free, JSON.stringify({ held: held.n, ...listed }));
  if (!free) throw new Error("not run: a client is on a switch's list, or held rows are in the way here");
  await cleanup(); // anything an interrupted run left behind
  spendBefore = await all(`SELECT day::text AS day, kind, used::text AS used, updated_at FROM enrich_spend_daily ORDER BY day, kind`);
  const spend = rows.find((r) => r.key === "spend_caps")?.value ?? {};
  const settings = settingsFrom([
    ...rows.filter((r) => r.key !== "spend_caps"),
    { key: "spend_caps", value: { ...spend, reoon_checks_per_day: 100_000, openai_usd_per_day: { pipeline: 10_000, fit: 10_000 } } },
  ]);
  await partC3(settings);
  check("nothing tried to reach any other address", net.calls.refused === 0, `${net.calls.refused} refused`);
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1)) AS tables,
            (SELECT count(*)::int FROM enrich_originals WHERE starts_with(variant, $2)) AS originals,
            (SELECT count(*)::int FROM enrich_memory WHERE starts_with(client_tag, $1)) AS memory,
            (SELECT count(*)::int FROM email_validations WHERE email LIKE $3) AS validations`,
    [PREFIX, PREFIX.toLowerCase(), `%.${HOST}`]
  );
  const spendBack = !spendBefore || same(await spendNow(), spendBefore.map(({ day, kind, used }) => ({ day, kind, used })));
  const clean = Object.values(left).every((n) => n === 0) && spendBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, spendBack })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
