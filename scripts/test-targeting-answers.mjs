// Targeting sync: non-answers and echoed examples (scripts/lib/targeting-answers.mjs).
//
//   node scripts/test-targeting-answers.mjs
//
// Pure: no AI, no database, no network. The real prompts are read from the sync
// script's source, so a reworded example line fails here instead of silently
// turning the echo check off.
import { readFileSync } from "node:fs";
import { echoesExample, exampleItems, isNonAnswer, said } from "./lib/targeting-answers.mjs";

let passed = 0, failed = 0;
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`); }
};

// ── Non-answers ─────────────────────────────────────────────────────────────
console.log("non-answers");
const NOT_ANSWERS = [
  "", "   ", "\n", "N/A", "n/a", "NA", "n.a.", "N / A", "None", "none.", "NO", "nil", "null", "Nothing",
  "-", "--", "\u2014", "\u2013", "...", "_", "x", "TBD", "tba", "Unknown", "not sure", "Not applicable",
  "same", "Same as above", "same as before", "see above", "See attached", "see email", "As discussed",
  "Already Provided", "already provided!", "Provided", "provided above", "Already sent", "sent already",
  "given", "shared previously",
];
for (const v of NOT_ANSWERS) check(`no answer: ${JSON.stringify(v)}`, isNonAnswer(v));
check("null and undefined are no answer", isNonAnswer(null) && isNonAnswer(undefined));

const ANSWERS = [
  "No restaurants", "None of: schools, churches", "residential", "salons, residential, bakeries",
  "N/A for Texas, but exclude Austin", "Already provided: Phoenix, Tempe", "Phoenix, AZ", "Tucson, Arizona 30 mile radius",
  "na. residential", "Provided list: gyms, schools", "TX", "Not sure about Mesa, include Phoenix",
];
for (const v of ANSWERS) check(`an answer: ${JSON.stringify(v)}`, !isNonAnswer(v));
check("said keeps an answer, trimmed", said("  salons, gyms ") === "salons, gyms");
check("said turns a non-answer into an empty string", said("Already Provided") === "" && said(null) === "");

// ── The real prompts' examples ──────────────────────────────────────────────
console.log("the prompts' worked examples");
const source = readFileSync(new URL("./sync-client-targeting-from-sheet.mjs", import.meta.url), "utf8");
const promptText = (name) => {
  const start = source.indexOf(`const ${name} = \``);
  if (start < 0) return "";
  const from = start + `const ${name} = \``.length;
  return source.slice(from, source.indexOf("`;", from));
};
const TERMS = exampleItems(promptText("CLIENT_EXCLUSION_PROMPT"), "such as:\n");
const PLACES = exampleItems(promptText("CLIENT_LOCATION_PROMPT"), "returns:\n");
check("the exclusion prompt's example holds its 21 terms", TERMS.size === 21, `got ${TERMS.size}: ${[...TERMS].join(", ")}`);
check("from salon to wholesale bakery", TERMS.has("salon") && TERMS.has("wholesale bakery") && TERMS.has("homeowners association"));
check("the location prompt's example holds its 16 towns, without the state label", PLACES.size === 16 && PLACES.has("andrews") && PLACES.has("wink") && !PLACES.has("texas: andrews"), `got ${PLACES.size}`);
check("the sync script reads the examples with the same markers", source.includes('exampleItems(CLIENT_EXCLUSION_PROMPT, "such as:\\n")') && source.includes('exampleItems(CLIENT_LOCATION_PROMPT, "returns:\\n")'));
check("a missing marker gives an empty set, not an error", exampleItems("no example here", "such as:\n").size === 0);

// ── Echoed examples ─────────────────────────────────────────────────────────
console.log("echoed examples");
const ALL_TERMS = [...TERMS];
check("the 21 terms for an unrelated answer are an echo", echoesExample(ALL_TERMS, TERMS, "restaurants, schools, government"));
check("the 21 terms for a non-answer that slipped through are an echo", echoesExample(ALL_TERMS, TERMS, "Already Provided"));
check("the 21 terms when the client only named residential are still an echo", echoesExample(ALL_TERMS, TERMS, "No residential"));
check("the 21 terms for the example's own input are a real answer", !echoesExample(ALL_TERMS, TERMS, "salons, residential, bakeries, hair salons, barbershops"));
check(
  "a real salon answer that shares a few example words is not an echo",
  !echoesExample(["salon", "salons", "beauty salon", "hair salon", "nail salon", "spa", "day spa", "med spa"], TERMS, "salons, nail salons, spas")
);
check(
  "a real housing answer is not an echo",
  !echoesExample(["residential", "residential property", "apartment complex", "apartments", "condominium", "condo", "homeowners association", "hoa"], TERMS, "residential, apartments, condos, HOAs")
);
check("four example terms are never enough for an echo", !echoesExample(["salon", "bakery", "barber", "condominium", "gym"], TERMS, "gyms"));
check("terms outside the example never count", !echoesExample(["school", "church", "government", "university", "college", "hospital"], TERMS, "schools"));
check("upper case and spaces in a reply still match", echoesExample(ALL_TERMS.map((t) => ` ${t.toUpperCase()} `), TERMS, "restaurants"));

const ALL_TOWNS = [...PLACES];
check("the 16 towns for an Arizona answer are an echo", echoesExample(ALL_TOWNS, PLACES, "Phoenix, Tempe, Mesa and Scottsdale", { unlessText: ["texas", "tx"] }));
check("the 16 towns for a non-answer are an echo", echoesExample(ALL_TOWNS, PLACES, "N/A provided on the call", { unlessText: ["texas", "tx"] }));
check("the 16 towns for a client in Midland, Texas are a real answer", !echoesExample(ALL_TOWNS, PLACES, "Midland, Texas and Odessa, 45 miles", { unlessText: ["texas", "tx"] }));
check("a client that writes TX is never an echo", !echoesExample(ALL_TOWNS, PLACES, "Odessa TX", { unlessText: ["texas", "tx"] }));
check("tx inside another word does not count as Texas", echoesExample(ALL_TOWNS, PLACES, "Phoenix, textiles district", { unlessText: ["texas", "tx"] }));

// ── The sync script keeps the test guard's rule ────────────────────────────
console.log("guards");
check(
  "the sync script still never names AI Ark's cleaning lists (scripts/test-aiark.mjs guard)",
  !/cleaning-filters|CLEANING_(TITLES|EXCLUDE|DEFAULTS|EMPLOYEE)/.test(source)
);
check("non-answers are checked before every AI pass", (source.match(/!isNonAnswer\(c\.(locations|exclusion)\)/g) ?? []).length === 3);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
