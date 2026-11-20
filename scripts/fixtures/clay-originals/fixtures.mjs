// Made-up Clay CLI exports for the tests (design 4.1 and 8): the three
// original tables' layout (68, 88 and 76 columns, each position's type, Clay
// action and the references its formulas make), with made-up prompts, lists,
// examples, URLs and names. Nothing here comes from a real Clay table: the real
// exports hold client text and stay out of this public repo (D1).
//
// Every made-up prompt, list and example holds FIXTURE_MARKER, so a test can
// prove that compiled text reaches enrich_columns only through
// enrich_originals, never from a module's source (test-originals.mjs A7).
//
// The logic follows the originals' shape where the tests need it: the website
// search runs only without a domain and has no SAFE TO RUN clause, the second
// email search has no URL check, a blocklist holds ".ca", the CEO write-to
// checks Person_2 fields and the write-tos' "||" clause skips their title
// filters, the run conditions of C#41 and C#56 hold the role finders' clauses
// the companies_v2 template replaces, and so on.
//
//   node scripts/fixtures/clay-originals/fixtures.mjs --write
// writes companies.json, people.json and inboxes.json beside this file.
// test-originals.mjs checks that the files are what this module builds.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ORIGINAL_COUNTS, ORIGINAL_KEYS } from "../../lib/enrich/original-keys.mjs";

/** In every made-up prompt, list and example: never in a module of scripts/lib or src. */
export const FIXTURE_MARKER = "zqx-fixture-only";
const M = FIXTURE_MARKER;
const UPDATED = "2026-01-01T00:00:00.000Z";

const LETTER = { companies: "C", people: "P", inboxes: "G" };
/** A made-up field id: f_fxC24 is the companies fixture's position 24. */
export const fixtureId = (kind, position) => `f_fx${LETTER[kind]}${String(position).padStart(2, "0")}`;
const id = (L, n) => `f_fx${L}${String(n).padStart(2, "0")}`;
const C = (n) => `{{${id("C", n)}}}`;
const P = (n) => `{{${id("P", n)}}}`;
const G = (n) => `{{${id("G", n)}}}`;

/** A made-up column name that slugs to our key: its words in title case. */
const nameOf = (key) => key.split("_").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");

const lit = (v) => JSON.stringify(v);
const b = (name, formulaText) => ({ name, formulaText, optional: false });
const bOpt = (name) => ({ name, optional: true });
const bMap = (name, formulaMap) => ({ name, formulaMap, optional: true });

function table(kind) {
  const L = LETTER[kind];
  const cols = new Map();
  const base = (n, type) => ({ type, id: id(L, n), name: n === 3 && kind === "companies" ? "Job Sources (made up)" : n === 4 && kind === "companies" ? "Cities (made up)" : nameOf(ORIGINAL_KEYS[kind][n]), updatedAt: UPDATED });
  const t = {
    source(n) {
      cols.set(n, { ...base(n, "source"), sources: [] });
    },
    input(n, dt = "text") {
      cols.set(n, { ...base(n, "basic"), settings: { type: "basic", dataTypeSettings: { type: dt } } });
    },
    formula(n, dt, formulaText) {
      cols.set(n, { ...base(n, "basic"), settings: { type: "basic", dataTypeSettings: { type: dt }, formulaType: "formula", formulaText } });
    },
    waterfall(n, dt, steps) {
      cols.set(n, { ...base(n, "basic"), settings: { type: "basic", dataTypeSettings: { type: dt }, formulaType: "waterfall", formulaWaterfall: steps.map((formula) => ({ formula })) } });
    },
    action(n, actionKey, bindings = [], runIf = null) {
      cols.set(n, {
        ...base(n, "action"),
        settings: {
          type: "action", actionKey, actionVersion: 1, dataTypeSettings: { type: "json" }, inputsBinding: bindings,
          ...(runIf ? { conditionalRunFormulaText: runIf } : {}),
        },
      });
    },
    /** A use-ai column: claygent (with web search) or use-ai (no tool). */
    ai(n, { useCase, prompt, model = "gpt-4o-mini", cents = null, fields, examples = null, budget = null, runIf }) {
      t.action(n, "use-ai", [
        b("useCase", lit(useCase)),
        b("prompt", prompt),
        b("model", lit(model)),
        ...(cents != null ? [b("maxCostInCents", lit(String(cents)))] : [bOpt("maxCostInCents")]),
        bMap("answerSchemaType", { type: lit("json"), fields: JSON.stringify(fields), jsonType: lit("Fields") }),
        ...(examples ? [b("tableExamples", JSON.stringify(examples)), b("runBudget", String(budget ?? 0.1))] : []),
        bMap("_metadata", { modelSource: "user" }),
      ], runIf);
    },
    done() {
      const data = [];
      for (let n = 1; n <= ORIGINAL_COUNTS[kind]; n++) {
        if (!cols.has(n)) throw new Error(`fixture ${kind} position ${n} is not defined`);
        data.push(cols.get(n));
      }
      return { workspace: { id: 0, name: "Made-up workspace for the tests" }, data };
    },
  };
  return t;
}

const field = (type, description) => ({ type, description });
const person = (k) => ({
  [`Person_${k}_Full_Name`]: field("string", `${M}: the person's full name, nothing else`),
  confidence: field("string", ""),
  reasoning: field("string", ""),
  [`Person_${k}_Title`]: field("string", `${M}: their job title`),
  [`Person_${k}_LinkedIn_URL`]: field("url", `${M}: their profile link`),
});
const roles = (list) => `"{\\"domain\\": \\"" + Clay.formatForJSON(${C(29)}) + "\\", \\"roles\\": ${JSON.stringify(list).replace(/"/g, '\\"')}}"`;
const finder = (t, n, list) =>
  t.action(n, "http-api-v2", [
    b("method", lit("POST")),
    b("url", lit("https://findymail.example/api/fixture-domain")),
    b("body", roles(list)),
    bMap("headers", { Accept: lit("application/json"), Authorization: "[redacted]" }),
  ], `${C(17)} && ${C(29)} && ${C(13)} && ${C(27)}?.valid`);
const writePeople = (t, n, k, src, runIf) =>
  t.action(n, "write-to-other-table-v2", [
    b("tableId", lit("t_fixture_people")),
    bOpt("objectPathsToColumnMappings"),
    bMap("columnValuesToColumnMappings", {
      [id("P", 31)]: C(59), [id("P", 34)]: C(65), [id("P", 28)]: C(5), [id("P", 22)]: C(8), [id("P", 33)]: C(64),
      [id("P", 20)]: C(7), [id("P", 17)]: C(67), [id("P", 44)]: `${C(src)}?.["Person_${k}_Title"]`,
      [id("P", 45)]: `${C(src)}?.["Person_${k}_LinkedIn_URL"]`, [id("P", 36)]: C(26), [id("P", 43)]: `${C(src)}?.["Person_${k}_Full_Name"]`,
      [id("P", 35)]: C(66), [id("P", 26)]: C(9),
    }),
    b("mode", lit("")),
  ], runIf);
const nameCheck = (src, k) => `!!${C(src)}?.["Person_${k}_Full_Name"] && !["${M}", "n/a", "test person", "unknown"].some((s) => ${C(src)}?.["Person_${k}_Full_Name"]?.toLowerCase()?.includes(s))`;
const titleFilter = (src, k) => `!["intern", "assistant"].some((w) => ${C(src)}?.["Person_${k}_Title"]?.toLowerCase()?.includes(w))`;
const nameFilter = (src, k) => `!["bot", "${M}"].some((w) => ${C(src)}?.["Person_${k}_Full_Name"]?.toLowerCase()?.includes(w))`;

// ── Companies (68) ──────────────────────────────────────────────────────────

function companies() {
  const t = table("companies");
  t.source(1);
  t.source(2);
  t.source(3);
  t.formula(4, "text", `${C(2)}?.cities ?? ""`);
  t.formula(5, "text", `${C(1)}?.name || ${C(2)}?.company_name || ${C(3)}?.company`);
  t.input(6);
  t.waterfall(7, "text", [C(60), `${C(59)}?.split(",")?.[0]?.trim()`]);
  t.waterfall(8, "text", [C(62), `${C(59)}?.split(",")?.[1]?.trim()`]);
  t.input(9);
  t.waterfall(10, "text", [C(29), C(5)]);
  t.action(11, "lookup-row-in-other-table", [b("tableId", lit("t_fixture_older_a")), b("fields|rowValue", C(10))], `!!${C(10)}`);
  t.action(12, "lookup-row-in-other-table", [b("tableId", lit("t_fixture_older_b")), b("fields|rowValue", C(10))], `!!${C(10)}`);
  t.formula(13, "boolean", `!${C(11)}?.record?.CHECK && !${C(12)}?.record?.CHECK`);
  t.formula(14, "boolean", `!["${M} keyword", "made-up excluded word"].some((w) => [${C(5)}, ${C(21)}, ${C(64)}, ${C(65)}].join(" ").toLowerCase().includes(w))`);
  t.formula(15, "boolean", `["${M} town"].some((s) => String(${C(7)} ?? "").toLowerCase().includes(s)) || (!${C(7)} && !${C(8)})`);
  // Brand domains anywhere in the name, website, category or the description (quirk 11).
  t.formula(16, "boolean", `!["${M}-c16", "megamart.example", "bigbox.example", "chainstore.example"].some((w) => [${C(5)}, ${C(21)}, ${C(64)}, ${C(65)}, ${C(3)}?.company].join(" ").toLowerCase().includes(w))`);
  // The job-row clause reads a source the pipeline has no rows for.
  t.formula(17, "boolean", `(${C(15)} && ${C(16)} && ${C(14)}) || Boolean(${C(2)}?.company_name)`);
  t.input(18, "date");
  t.input(19, "date");
  t.formula(20, "url", `${C(1)}?.linkedin_url?.length > 10 && !["n/a", "none"].includes(String(${C(1)}?.linkedin_url).toLowerCase()) ? ${C(1)}?.linkedin_url : ""`);
  t.formula(21, "text", `${C(1)}?.domain || ${C(2)}?.domain`);
  t.formula(22, "text", `${C(1)}?.domain || ${C(2)}?.domain`);
  t.action(23, "get-domain-from-company-name", [b("companyName", C(5))], `!${C(21)} || ["${M}-c23"].some((v) => ${C(21)}.includes(v))`);
  // The website search: only without a domain, and no SAFE TO RUN clause (quirk 15); city and state joined with no space (quirk 10).
  t.ai(24, {
    useCase: "claygent", cents: 1,
    prompt: `"${M}-c24 [fx:C24] business=" + ${C(5)} + "; place=" + ${C(7)} + ${C(8)} + "; address=" + ${C(59)} + "; kind=" + ${C(64)} + " / " + ${C(65)} + "; profile=" + ${C(20)} + "; Look the business up and give its own website, or N/A."`,
    fields: { response: field("url", `${M}: the website alone`) },
    runIf: `!${C(22)} && ${C(14)} && ${C(17)} && ${C(5)} && (!${C(21)} || ["directory.example"].some((v) => ${C(21)}.includes(v))) && ${C(15)} && ${C(16)}`,
  });
  t.formula(25, "url", `${C(24)}?.response`);
  // ".ca" in the lists drops a Canadian website, and any "www.ca..." one (quirk 6).
  const sites = `["directory.example", "listings.example", ".ca", "${M}-c26"]`;
  t.waterfall(26, "url", [
    `${sites}.every((d) => !${C(25)}?.includes(d)) ? ${C(25)} : ""`,
    `${C(23)}?.domain && !["directory.example"].some((d) => ${C(23)}?.domain.includes(d)) ? ${C(23)}?.domain : ""`,
    `${C(21)} && !${sites}.some((d) => ${C(21)}.includes(d)) ? ${C(21)} : ""`,
  ]);
  t.action(27, "check-url", [b("url", C(26)), b("tryVariants", "true"), b("treatTimeoutsAsInvalid", "false")], `${C(26)} && ${C(14)} && ${C(16)} && ${C(15)}`);
  t.action(28, "normalize-url", [b("url", C(26)), b("type", lit("bare"))], `${C(26)} && ${C(27)}?.valid && ${C(14)} && ${C(16)} && ${C(15)}`);
  t.waterfall(29, "url", [
    `${C(28)}?.normalizedUrl`,
    `${sites}.every((d) => !${C(25)}?.includes(d)) ? ${C(25)} : ""`,
    `${C(23)}?.domain || ""`,
    `${C(21)} && !${sites}.some((d) => ${C(21)}.includes(d)) ? ${C(21)} : ""`,
  ]);
  const noFirst = `!(!!${C(30)} && ((${C(30)}?.emails?.[0]?.email || "")?.length))`;
  t.action(30, "icypeas-find-emails-for-domain", [b("domain", C(29))], `${C(17)} && ${C(29)} && ${C(13)} && ${C(27)}?.valid`);
  t.ai(31, {
    useCase: "claygent", cents: 1,
    prompt: `"${M}-c31 [fx:C31] business=" + ${C(5)} + "; site=" + ${C(26)} + "; place=" + ${C(7)} + ", " + ${C(8)} + "; address=" + ${C(59)} + "; kind=" + ${C(64)} + "; Read the site and list its general email addresses, comma separated, or N/A."`,
    fields: { company_emails_found: field("string", `${M}: the addresses found`) },
    runIf: `${C(17)} === true && (!!${C(26)} || ${C(3)}?.id) && ${noFirst} && ${C(13)} && ${C(27)}?.valid && ${C(14)} && ${C(16)} && ${C(15)}`,
  });
  // No URL check here (quirk 5): a dead website can still pay for this search.
  t.ai(32, {
    useCase: "claygent", cents: 1,
    prompt: `"${M}-c32 [fx:C32] business=" + ${C(5)} + "; site=" + ${C(26)} + "; place=" + ${C(7)} + ", " + ${C(8)} + "; Search listings for the business's general email addresses, comma separated, or N/A."`,
    fields: { company_emails_found: field("string", `${M}: the addresses found`) },
    runIf: `(!${C(31)}?.company_emails_found || ["n/a", "none", "not found", "${M}"].some((x) => String(${C(31)}?.company_emails_found ?? "").toLowerCase().indexOf(x) >= 0)) && ${C(17)} === true && (!!${C(26)} || ${C(3)}?.id) && ${noFirst} && ${C(13)} && ${C(14)} && ${C(16)} && ${C(15)}`,
  });
  t.formula(33, "text", `${C(29)} ? ["hello", "${M}"].map((x) => x + "@" + ${C(29)}).join(",") : ""`);
  t.action(34, "find-urls-and-emails-in-text", [
    b("text", `${C(30)}?.emails?.["0"]?.email + ", " + ${C(30)}?.emails?.["1"]?.email + ", " + ${C(31)}?.company_emails_found + ", " + ${C(32)}?.company_emails_found`),
  ], `${C(30)} || ${C(31)} || ${C(32)}`);
  t.formula(35, "text", `${C(34)}?.urlsAndEmails?.[0]?.value`);
  t.action(36, "write-to-other-table-v2", [
    b("tableId", lit("t_fixture_inboxes")),
    bMap("objectPathsToColumnMappings", { [id("G", 13)]: lit("value") }),
    bMap("columnValuesToColumnMappings", {
      [id("G", 31)]: C(29), [id("G", 33)]: C(26), [id("G", 34)]: C(67), [id("G", 24)]: C(8), [id("G", 28)]: C(9),
      [id("G", 9)]: C(65), [id("G", 8)]: C(64), [id("G", 22)]: C(7), [id("G", 26)]: C(59), [id("G", 12)]: C(5), [id("G", 10)]: C(66),
    }),
    b("value", `${C(34)}?.urlsAndEmails`),
    b("mode", lit("arrayOfObjects")),
  ], `!!${C(34)}?.urlsAndEmails?.length`);
  finder(t, 37, ["Chief Widget Officer", "Head of Gadget Operations"]);
  t.action(38, "write-to-other-table-v2", [b("tableId", lit("t_fixture_people"))], `${C(37)}?.contacts?.length > 0`);
  t.action(39, "http-api-v2", [b("url", lit("https://anymail.example/fixture-operations"))], `!!${C(29)}`);
  t.action(40, "write-to-other-table-v2", [b("tableId", lit("t_fixture_people"))], `!!${C(39)}?.result?.email`);
  // The role finders' clauses, as the originals hold them, around the AI search's own.
  t.ai(41, {
    useCase: "claygent", cents: 1,
    prompt: `"${M}-c41 [fx:C41] business=" + ${C(5)} + "; site=" + ${C(26)} + "; domain=" + ${C(29)} + "; Identify the Head of Gadget Operations, Widget Floor Director, or " + ${C(7)} + " Office Lead likely in charge at " + ${C(5)} + ". Give their name, title and profile."`,
    fields: person(2),
    runIf: `${C(17)} && !${C(37)}?.contacts?.[0]?.email && ${C(37)} && !${C(39)}?.result?.email && (${C(39)} || !${C(39)}) && ${C(13)}`,
  });
  t.formula(42, "boolean", nameCheck(41, 2));
  // The "||" clause skips the title and name filters (quirk 3).
  writePeople(t, 43, 2, 41, `${C(41)} && ${C(42)} && ${titleFilter(41, 2)} && ${nameFilter(41, 2)} || (${C(41)}?.["Person_2_Full_Name"] && ${C(42)})`);
  finder(t, 44, ["Office Wrangler", "Facility Keeper"]);
  t.action(45, "write-to-other-table-v2", [b("tableId", lit("t_fixture_people"))], `${C(44)}?.contacts?.length > 0`);
  t.action(46, "http-api-v2", [b("url", lit("https://anymail.example/fixture-facility"))], `!!${C(29)}`);
  t.action(47, "write-to-other-table-v2", [b("tableId", lit("t_fixture_people"))], `!!${C(46)}?.result?.email`);
  t.ai(48, {
    useCase: "claygent", cents: 3,
    prompt: `"${M}-c48 [fx:C48] business=" + ${C(5)} + "; site=" + ${C(26)} + "; Identify the Office Wrangler, Facility Keeper, or Workplace Steward of " + ${C(5)} + " in " + ${C(7)} + ". Give their name, title and profile."`,
    fields: person(3),
    runIf: `${C(17)} && ${C(13)} && (${C(29)} || ${C(2)}?.title || ${C(3)}?.id) && ${C(27)}?.valid && ${C(14)} && ${C(16)} && ${C(15)}`,
  });
  t.formula(49, "boolean", nameCheck(48, 3));
  t.ai(50, {
    useCase: "claygent", cents: 1,
    prompt: `"${M}-c50 [fx:C50] profile=" + Clay.formatForAIPrompt(${C(48)}?.["Person_3_LinkedIn_URL"]) + "; person=" + Clay.formatForAIPrompt(${C(48)}) + "; place=" + ${C(7)} + ", " + ${C(8)} + "; business=" + ${C(5)} + "; Does the profile show this place and business? Yes or No."`,
    fields: { result: { type: "select", options: JSON.stringify([{ id: "fx-yes", text: "Yes" }, { id: "fx-no", text: "No" }]), description: `${M}: Yes or No` } },
    runIf: `${C(48)} && !!${C(48)}?.["Person_3_LinkedIn_URL"] && ${C(49)}`,
  });
  // It reads C#41's title (quirk 2), and without C#50 writes only people with no profile link.
  writePeople(t, 51, 3, 48, `(${C(48)} && ${C(49)} && ${titleFilter(41, 2)} && ${nameFilter(48, 3)} || (${C(48)}?.["Person_3_Full_Name"] && ${C(49)})) && (${C(50)}?.result?.toLowerCase() === "yes" || (!${C(48)}?.["Person_3_LinkedIn_URL"] && !!${C(48)}?.["Person_3_Full_Name"]))`);
  finder(t, 52, ["Widget Founder", "Gadget Owner"]);
  t.action(53, "write-to-other-table-v2", [b("tableId", lit("t_fixture_people"))], `${C(52)}?.contacts?.length > 0`);
  t.action(54, "http-api-v2", [b("url", lit("https://anymail.example/fixture-ceo"))], `!!${C(29)}`);
  t.action(55, "write-to-other-table-v2", [b("tableId", lit("t_fixture_people"))], `!!${C(54)}?.result?.email`);
  t.ai(56, {
    useCase: "claygent", cents: 1,
    prompt: `"${M}-c56 [fx:C56] business=" + ${C(5)} + "; site=" + ${C(26)} + "; Identify the Widget Founder, Gadget Owner, or Chief Gadget Executive at " + ${C(5)} + ". Give their name, title and profile."`,
    fields: person(1),
    runIf: `${C(17)} && ((!${C(52)}?.contacts?.[0]?.email && ${C(52)}) || !${C(52)}) && !${C(54)}?.result?.email && (${C(54)} || !${C(54)}) && ${C(13)} && ${C(14)} && ${C(16)}`,
  });
  t.formula(57, "boolean", nameCheck(56, 1));
  // It checks Person_2 fields that the CEO search never answers (quirk 2).
  writePeople(t, 58, 1, 56, `${C(56)} && ${C(57)} && ${titleFilter(56, 2)} && ${nameFilter(56, 2)} || (${C(56)}?.["Person_2_Full_Name"] && ${C(57)})`);
  t.formula(59, "text", `${C(1)}?.location`);
  for (const n of [60, 61, 62, 63]) t.input(n);
  t.formula(64, "text", `${C(1)}?.industry`);
  t.formula(65, "text", `${C(1)}?.description`);
  t.input(66);
  t.input(67);
  t.formula(68, "text", `""`);
  return t.done();
}

// ── General (76) ────────────────────────────────────────────────────────────

function inboxes() {
  const t = table("inboxes");
  t.input(1, "date");
  t.input(2, "date");
  t.formula(3, "boolean", "false");
  t.action(4, "lookup-row-in-other-table", [b("tableId", lit("t_fixture_inboxes")), b("fields|rowValue", G(13))], `${G(1)} || ${G(13)}`);
  t.formula(5, "boolean", `true || !${G(4)}?.record?.["General Email"]`);
  t.formula(6, "select", `${G(5)} ? "New" : "Duplicate"`);
  t.waterfall(7, "text", [G(13)]);
  for (const n of [8, 9, 10]) t.input(n);
  t.formula(11, "text", `${G(20)}`);
  t.input(12);
  t.input(13);
  t.action(14, "normalize-company-name", [b("companyName", G(12)), b("titleCase", "true")], G(12));
  t.formula(15, "text", `${G(14)}?.normalized_name`);
  t.action(16, "extract-email-components", [b("email", G(13))], `!!${G(13)} && ${G(44)} === true`);
  t.formula(17, "text", `${G(16)}?.username`);
  t.formula(18, "text", `${G(16)}?.guessedName`);
  t.ai(19, {
    useCase: "use-ai", model: "gpt-6-luna",
    prompt: `"${M}-g19 [fx:G19] name=" + ${G(18)} + "; email=" + ${G(13)} + "; Is this a first name?"`,
    fields: { response: field("string", "") },
    examples: [{ inputs: { [G(18)]: "Made Upname", [G(13)]: `madeup@${M}.example` }, output: `${M} example answer`, recordId: "fx-example-1" }],
    budget: 0.1,
    runIf: `!!${G(13)} && ${G(44)} === true && !!${G(18)}`,
  });
  t.waterfall(20, "text", [
    `${G(19)}?.response && !${G(19)}?.response?.includes("not a name") ? ${G(19)}?.response : ""`,
    `${G(15)}?.replace(/\\b(LLC|Inc\\.)\\b/gi, "").trim() + " Team"`,
  ]);
  t.formula(21, "text", lit("(General Email)"));
  t.input(22);
  t.formula(23, "text", `${G(22)} ? String(${G(22)}).toLowerCase().replace(/\\b\\w/g, (c) => c.toUpperCase()) : "local"`);
  t.input(24);
  t.waterfall(25, "text", [G(24), `${G(26)}?.split(",")?.[2]?.trim()`, lit("your area")]);
  t.input(26);
  t.waterfall(27, "text", [G(26), lit("(No Address Available)")]);
  t.input(28);
  t.formula(29, "url", `"https://maps.example/?q=" + encodeURIComponent(String(${G(12)} ?? ""))`);
  t.waterfall(30, "text", [G(29), lit("(No map link)")]);
  t.input(31);
  t.waterfall(32, "text", [G(31)]);
  t.input(33);
  t.input(34);
  t.action(35, "normalize-phone-number", [b("phoneNumber", G(34))], `!!${G(34)}`);
  t.waterfall(36, "text", [`${G(35)}?.number?.national`, lit("there")]);
  // A shorter brand list than C#16's.
  t.formula(37, "boolean", `!["${M}-g37", "megamart.example", "bigbox.example"].some((w) => [${G(12)}, ${G(33)}, ${G(8)}, ${G(9)}].join(" ").toLowerCase().includes(w))`);
  t.formula(38, "boolean", `!!${G(13)} && !["${M}-g38", "noreply", "@example.com", "invoice", "careers"].some((x) => ${G(13)}?.toLowerCase()?.includes(x))`);
  // Reoon: its regex holds \.edu (quirk 12: P#11's does not).
  t.action(39, "http-api-v2", [
    b("method", lit("GET")),
    b("url", lit("https://reoon.example/api/fixture-verify")),
    bMap("queryString", { key: "[redacted]", mode: lit("power"), email: G(13) }),
  ], `!!${G(13)} && !!${G(5)} && !/zqxfixture@|no-?reply@|unsubscribe@|\\.edu/i.test(${G(13)}) && ${G(38)} && ${G(37)}`);
  t.formula(40, "boolean", `${G(39)}?.is_valid_syntax === true && ${G(39)}?.is_deliverable === true && ${G(39)}?.is_safe_to_send === true && String(${G(39)}?.status ?? "").includes("safe")`);
  t.action(41, "enrichley-verify-email", [b("email", G(13))], `(!${G(40)} && ${G(39)} && ["catch_all", "unknown", "role_account"].some((s) => String(${G(39)}?.status ?? "").includes(s))) && !!${G(5)} && ${G(38)} && ${G(37)}`);
  t.formula(42, "boolean", `${G(41)}?.valid`);
  t.formula(43, "text", `${G(41)}?.result`);
  t.formula(44, "boolean", `${G(40)} || ${G(42)}`);
  t.formula(45, "url", `${G(44)} ? String(${G(13)}).split("@")[1] : ""`);
  t.action(46, "http-api-v2", [b("method", lit("GET")), b("url", `"https://dns.google.com/resolve?type=MX&name=" + ${G(45)}`)], `!!${G(45)} && ${G(38)} && ${G(37)}`);
  t.formula(47, "boolean", "true");
  t.ai(48, {
    useCase: "claygent", model: "gpt-6-luna", cents: 10,
    prompt: `"${M}-g48 [fx:G48] business=" + ${G(12)} + "; domain=" + ${G(32)} + "; place=" + ${G(23)} + ", " + ${G(25)} + "; kind=" + ${G(8)} + "; Summarise what this business does."`,
    fields: { company_summary: field("string", `${M}: a short summary`), spaces: field("string", ""), reasoning: field("string", "") },
    runIf: `${G(44)} === true && !!${G(46)} && ${G(38)} && ${G(37)}`,
  });
  t.ai(49, {
    useCase: "use-ai", model: "gpt-6-luna",
    prompt: `"${M}-g49 [fx:G49] business=" + ${G(12)} + "; summary=" + ${G(48)}?.company_summary + "; Write one question."`,
    fields: { response: field("string", `${M}: the question`) },
    examples: [{ inputs: { [G(12)]: "Made-up Widget Shop" }, output: `${M} example question?`, recordId: "fx-example-2" }],
    budget: 0.1,
    runIf: `${G(44)} === true && !!${G(48)}`,
  });
  t.formula(50, "text", `(${G(49)}?.response ?? "").slice(0, 1).toLowerCase() + (${G(49)}?.response ?? "").slice(1)`);
  for (let n = 51; n <= 76; n++) {
    if (n === 51) t.formula(n, "select", `"B2B"`);
    else t.action(n, "http-api-v2", [b("url", lit("https://sender.example/fixture"))], "false");
  }
  return t.done();
}

// ── People (88) ─────────────────────────────────────────────────────────────

function people() {
  const t = table("people");
  t.source(1);
  t.input(2, "date");
  t.input(3, "date");
  t.action(4, "lookup-row-in-other-table", [b("tableId", lit("t_fixture_people")), b("fields|rowValue", P(7))], `!!${P(7)}`);
  t.formula(5, "boolean", `!${P(4)}?.record?.["Full Name"]`);
  t.formula(6, "select", `${P(5)} ? "New" : "Duplicate"`);
  t.waterfall(7, "text", [P(9), `${P(43)} + " | " + ${P(38)}`, P(45)]);
  // A single "|" between its two clauses (quirk 14).
  t.action(8, "lookup-row-in-other-table", [b("tableId", lit("t_fixture_companies")), b("fields|rowValue", P(36))], `!!${P(43)} | !!${P(36)}`);
  t.input(9, "email");
  t.formula(10, "boolean", `!["${M}-p10", "megamart.example", "zohoish.example"].some((w) => [${P(28)}, ${P(36)}, ${P(38)}, ${P(33)}, ${P(34)}].join(" ").toLowerCase().includes(w))`);
  t.action(11, "http-api-v2", [
    b("method", lit("GET")),
    b("url", lit("https://reoon.example/api/fixture-verify")),
    bMap("queryString", { key: "[redacted]", mode: lit("power"), email: P(9) }),
  ], `!!${P(9)} && ${P(5)} === true && !/zqxfixture@|no-?reply@|unsubscribe@/i.test(${P(9)})`);
  t.formula(12, "boolean", `${P(11)}?.is_valid_syntax === true && ${P(11)}?.is_deliverable === true && ${P(11)}?.is_safe_to_send === true && String(${P(11)}?.status ?? "").includes("safe")`);
  t.action(13, "enrichley-verify-email", [b("email", P(9))], `(!${P(12)} && ${P(11)} && ["unknown", "catch_all", "role_account"].indexOf(${P(11)}?.status) >= 0) && ${P(5)} === true && !/zqxfixture@|no-?reply@/i.test(${P(9)})`);
  t.formula(14, "boolean", `${P(13)}?.valid`);
  t.waterfall(15, "text", [`${P(12)} ? ${P(9)} : ""`, `${P(14)} === true ? ${P(9)} : ""`]);
  t.formula(16, "boolean", `!${P(9)} || (!!${P(9)} && !${P(15)} && ((!!${P(11)} && !${P(12)}) || (!!${P(13)} && !${P(14)})))`);
  t.formula(17, "text", `${P(8)}?.record?.Phone`);
  t.action(18, "normalize-phone-number", [b("phoneNumber", P(17))], `!!${P(17)} && ${P(5)} === true`);
  t.waterfall(19, "text", [`${P(18)}?.number?.national`, lit("there")]);
  // The first part of the address, which is the street for a full address (quirk 9).
  t.formula(20, "text", `${P(31)}?.split(",")?.[0]`);
  t.formula(21, "text", `${P(20)} ? String(${P(20)}).trim() : "local"`);
  t.formula(22, "text", `String(${P(31)} ?? "").split(",")[1]?.trim().split(" ")[0] || ${P(8)}?.record?.["Use State"]`);
  t.formula(23, "text", `${P(22)} || "local"`);
  t.formula(24, "text", `"https://maps.example/?q=" + encodeURIComponent(String(${P(28)} ?? ""))`);
  t.waterfall(25, "text", [P(24), lit("(No map link)")]);
  t.input(26);
  t.ai(27, {
    useCase: "claygent", cents: 1,
    prompt: `"${M}-p27 [fx:P27] person=" + Clay.formatForAIPrompt(${P(1)}?.name) + "; profile=" + Clay.formatForAIPrompt(${P(1)}?.url) + "; Which business does this person work at now?"`,
    fields: { company: field("string", `${M}: the business`), confidence: field("string", ""), reasoning: field("string", ""), website: field("url", "") },
    runIf: `(${P(8)} || !!${P(36)}) && !${P(1)}?.latest_experience_company`,
  });
  t.formula(28, "text", `${P(1)}?.latest_experience_company || ${P(8)}?.record?.Company || ${P(27)}?.company`);
  t.action(29, "normalize-company-name", [b("companyName", P(28)), b("titleCase", "true")], `!!${P(28)} && ${P(5)} === true`);
  t.formula(30, "text", `${P(29)}?.normalized_name`);
  t.formula(31, "text", `${P(8)}?.record?.Address || ${P(1)}?.location_name`);
  t.waterfall(32, "text", [P(31), lit("(No Address Available)")]);
  t.formula(33, "text", `${P(8)}?.record?.Category`);
  t.formula(34, "text", `${P(8)}?.record?.["Sub Category"]`);
  t.input(35);
  t.input(36, "url");
  t.action(37, "normalize-url", [b("url", P(36)), b("type", lit("bare"))], `!!${P(43)} || ${P(8)}`);
  t.formula(38, "url", `${P(37)}?.normalizedUrl`);
  const firstWord = `String(${P(43)} ?? "").split(" ")[0]`;
  t.formula(39, "text", `${firstWord}.length > 1 ? ${firstWord} : ${P(43)}`);
  t.formula(40, "text", `${P(1)}?.last_name || String(${P(43)} ?? "").split(" ").pop()`);
  t.formula(41, "text", `${firstWord}.length > 1 ? ${firstWord} : ${P(43)}`);
  t.formula(42, "text", `String(${P(43)} ?? "").split(" ").slice(1).join(" ") || "(General Email)"`);
  // The source read without "?." (quirk 13): an error when it is absent.
  t.formula(43, "text", `${P(1)}.name`);
  t.formula(44, "text", `${P(1)}.latest_experience_title`);
  t.formula(45, "url", `${P(1)}.url`);
  const wants = `(!${P(9)} || ${P(16)} === true) && ${P(5)} === true`;
  t.action(46, "findymail-find-work-email", [b("full_name", P(43)), b("company_domain", P(38))], `(!!${P(43)} && !!${P(38)}) && ${wants} && !${P(15)}`);
  t.action(47, "prospeo-find-work-email-v2", [b("full_name", P(43)), b("company_domain", P(38)), bOpt("include_catch_all")], `!${P(46)}?.email && (!!${P(43)} && !!${P(38)}) && ${wants} && !${P(15)}`);
  t.action(48, "http-api-v2", [
    b("method", lit("POST")),
    b("url", lit("https://api.anymailfinder.com/v5.1/fixture/person")),
    b("body", `"{\\"full_name\\": \\"" + Clay.formatForJSON(${P(43)}) + "\\", \\"domain\\": \\"" + Clay.formatForJSON(${P(38)}) + "\\", \\"company_name\\": \\"" + Clay.formatForJSON(${P(28)}) + "\\"}"`),
    bMap("headers", { Authorization: "[redacted]" }),
    b("removeNull", "true"),
  ], `!${P(46)}?.email && (!${P(47)} || !${P(47)}?.email) && (!!${P(43)} && !!${P(38)}) && ${wants} && !${P(15)}`);
  t.action(49, "enrichley-verify-email", [b("email", `${P(48)}?.results?.email`)], `${P(48)} && ${P(48)}?.results?.email && ${wants}`);
  t.waterfall(50, "email", [
    `${P(46)}?.email`,
    `${P(47)}?.email`,
    `String(${P(48)}?.results?.validation ?? "").toLowerCase() === "valid" ? ${P(48)}?.results?.email : ""`,
    `${P(49)}?.valid === true ? ${P(49)}?.email : ""`,
  ]);
  t.action(51, "findymail-find-work-email-from-linkedin", [b("profile_url", P(45))], `(!${P(43)} || !${P(38)} || !${P(46)}?.email && !${P(50)}) && ${P(16)} === true && !!${P(45)} && ${P(5)} === true && !${P(50)} && !${P(15)} && !!${P(8)}`);
  t.action(52, "prospeo-linkedin-email-search", [b("personal_linkedin_url", P(45))], `!!${P(45)} && (!${P(51)} || !${P(51)}?.email) && ${P(5)} === true && ${P(16)} && !${P(15)} && !${P(50)}`);
  t.action(53, "http-api-v2", [
    b("method", lit("POST")),
    b("url", lit("https://api.anymailfinder.com/v5.1/fixture/linkedin")),
    b("body", `"{\\"linkedin_url\\": \\"" + Clay.formatForJSON(${P(45)}) + "\\"}"`),
    bMap("headers", { Authorization: "[redacted]" }),
  ], `!!${P(45)} && (!${P(51)} || !${P(51)}?.email) && ${P(5)} === true && ${P(16)} && !${P(15)} && !${P(50)} && (!${P(52)} || !${P(52)}?.email?.email)`);
  t.action(54, "enrichley-verify-email", [b("email", `${P(53)}?.results?.email`)], `${P(53)}?.results?.email && ${P(5)} === true && ${P(16)}`);
  t.waterfall(55, "email", [P(50), P(15), `${P(51)}?.email`, `${P(52)}?.email?.email`, `${P(54)}?.valid === true ? ${P(54)}?.email : ""`]);
  t.formula(56, "boolean", `!!${P(55)} && !["${M}-p56", "noreply", "@example.com", "test@"].some((x) => String(${P(55)}).toLowerCase().includes(x))`);
  t.formula(57, "url", `${P(55)}?.split("@")?.[1]`);
  t.action(58, "http-api-v2", [b("method", lit("GET")), b("url", `"https://dns.google.com/resolve?type=MX&name=" + ${P(57)}`)], `(!!${P(15)} || !!${P(55)}) && !!${P(57)} && ${P(5)} === true`);
  t.formula(59, "boolean", "true");
  t.ai(60, {
    useCase: "claygent", model: "gpt-6-luna", cents: 1,
    prompt: `"${M}-p60 [fx:P60] business=" + ${P(28)} + "; site=" + ${P(36)} + "; place=" + ${P(21)} + ", " + ${P(23)} + "; kind=" + ${P(33)} + " / " + ${P(34)} + "; Summarise what this business does."`,
    fields: { company_summary: field("string", `${M}: a short summary`), spaces: field("string", ""), reasoning: field("string", "") },
    runIf: `!!${P(55)} && ${P(5)} === true && !!${P(58)}`,
  });
  t.ai(61, {
    useCase: "use-ai", model: "gpt-6-luna",
    prompt: `"${M}-p61 [fx:P61] business=" + ${P(28)} + "; title=" + ${P(44)} + "; summary=" + ${P(60)}?.company_summary + "; Write one question."`,
    fields: { response: field("string", `${M}: the question`) },
    examples: [{ inputs: { [P(28)]: "Made-up Widget Shop", [P(44)]: "Owner" }, output: `${M} example question?`, recordId: "fx-example-3" }],
    budget: 0.1,
    runIf: `${P(60)} && !!${P(55)} && ${P(5)} === true && !!${P(58)}`,
  });
  t.formula(62, "text", `(${P(61)}?.response ?? "").slice(0, 1).toLowerCase() + (${P(61)}?.response ?? "").slice(1)`);
  for (let n = 63; n <= 88; n++) {
    if (n === 63) t.formula(n, "select", `"B2B"`);
    else t.action(n, "http-api-v2", [b("url", lit("https://sender.example/fixture"))], "false");
  }
  return t.done();
}

/** The three made-up exports, as the Clay CLI writes them ({ workspace, data }). */
export function fixtureExports() {
  return { companies: companies(), people: people(), inboxes: inboxes() };
}

/** The file text of each export, as --write writes it. */
export const fixtureText = (exp) => `${JSON.stringify(exp, null, 2)}\n`;

/** The exports as the seed takes them: { kind: { sha256, data } }. */
export function fixtureSeedExports() {
  const exp = fixtureExports();
  return Object.fromEntries(
    Object.entries(exp).map(([k, v]) => [k, { path: `fixture:${k}`, sha256: createHash("sha256").update(fixtureText(v)).digest("hex"), data: v.data }])
  );
}

/** The people tracks the seed derives from these exports. */
export const FIXTURE_TRACKS = Object.freeze({
  operations: ["Chief Widget Officer", "Head of Gadget Operations", "Widget Floor Director"],
  facility_office: ["Office Wrangler", "Facility Keeper", "Workplace Steward"],
  ceo: ["Widget Founder", "Gadget Owner", "Chief Gadget Executive"],
});

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  const exp = fixtureExports();
  for (const [k, v] of Object.entries(exp)) writeFileSync(new URL(`./${k}.json`, import.meta.url), fixtureText(v));
  console.log(`wrote ${Object.entries(exp).map(([k, v]) => `${k}.json (${v.data.length})`).join(", ")}`);
}
