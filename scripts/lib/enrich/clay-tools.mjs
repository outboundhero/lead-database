// Our exact copies of two of Clay's built-in tools, run where the original
// Clay columns call them (D38 lifted for these two on 2026-11-20):
//
//   clay_normalize_company_name    Clay's normalize-company-name, G#14 and P#29.
//                                  G#15 and P#30 read ?.normalized_name, and
//                                  G#20's second step reads G#15.
//   clay_extract_email_components  Clay's extract-email-components, G#16. G#17
//                                  reads ?.username, G#18 ?.guessedName.
//
// The rules were worked out from Clay's own answers on real rows (kept out of
// this public repo) and reproduce every one of them. Clay's quirks are copied,
// none fixed: one suffix only; a dot in its patterns matches any character, so
// "Telecom" reads as ending in ".com", "Corp." and "P.C." are kept and "CO2" is
// cut; "& Co" keeps its "&" in mixed case; title case is lodash's
// startCase(camelCase()) without lodash's ordinal rule ("5TH" gives "5 Th").
//
// Clay's third tool in those tables, normalize-phone-number (P#18, G#35),
// still waits (D38): its answers need libphonenumber's country metadata.
// tool-standins.mjs (our own stand-ins, never Clay's) stays unused.
//
// Both actions are free and local: cache false, so no spinner, no run record,
// and the answer is worked out again on every pass (as normalize_url). Their
// inputs are the original's own bindings, compiled by toolInputs() for the
// template modules; their run conditions are the originals', verbatim.

import capitalize from "lodash/capitalize.js";
import deburr from "lodash/deburr.js";
import upperFirst from "lodash/upperFirst.js";
import { getDomain, getDomainWithoutSuffix } from "tldts";
import { bindingOf, originalOf, rewriteRefs } from "./compile-original.mjs";

// ── lodash's word splitting, without its ordinal rule ───────────────────────
// The pieces of lodash 4.17's unicode word pattern (lodash/_unicodeWords.js),
// minus rsOrdUpper and rsOrdLower: Clay splits "5TH" into "5" and "TH", where
// lodash keeps "5th" whole. Everything else is lodash's own.

const rsAstralRange = "\\ud800-\\udfff";
const rsComboMarksRange = "\\u0300-\\u036f";
const reComboHalfMarksRange = "\\ufe20-\\ufe2f";
const rsComboSymbolsRange = "\\u20d0-\\u20ff";
const rsComboRange = rsComboMarksRange + reComboHalfMarksRange + rsComboSymbolsRange;
const rsDingbatRange = "\\u2700-\\u27bf";
const rsLowerRange = "a-z\\xdf-\\xf6\\xf8-\\xff";
const rsMathOpRange = "\\xac\\xb1\\xd7\\xf7";
const rsNonCharRange = "\\x00-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\xbf";
const rsPunctuationRange = "\\u2000-\\u206f";
const rsSpaceRange =
  " \\t\\x0b\\f\\xa0\\ufeff\\n\\r\\u2028\\u2029\\u1680\\u180e\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200a\\u202f\\u205f\\u3000";
const rsUpperRange = "A-Z\\xc0-\\xd6\\xd8-\\xde";
const rsVarRange = "\\ufe0e\\ufe0f";
const rsBreakRange = rsMathOpRange + rsNonCharRange + rsPunctuationRange + rsSpaceRange;

const rsApos = "['\\u2019]";
const rsBreak = `[${rsBreakRange}]`;
const rsCombo = `[${rsComboRange}]`;
const rsDigits = "\\d+";
const rsDingbat = `[${rsDingbatRange}]`;
const rsLower = `[${rsLowerRange}]`;
const rsMisc = `[^${rsAstralRange}${rsBreakRange}${rsDigits}${rsDingbatRange}${rsLowerRange}${rsUpperRange}]`;
const rsFitz = "\\ud83c[\\udffb-\\udfff]";
const rsModifier = `(?:${rsCombo}|${rsFitz})`;
const rsNonAstral = `[^${rsAstralRange}]`;
const rsRegional = "(?:\\ud83c[\\udde6-\\uddff]){2}";
const rsSurrPair = "[\\ud800-\\udbff][\\udc00-\\udfff]";
const rsUpper = `[${rsUpperRange}]`;
const rsZWJ = "\\u200d";

const rsMiscLower = `(?:${rsLower}|${rsMisc})`;
const rsMiscUpper = `(?:${rsUpper}|${rsMisc})`;
const rsOptContrLower = `(?:${rsApos}(?:d|ll|m|re|s|t|ve))?`;
const rsOptContrUpper = `(?:${rsApos}(?:D|LL|M|RE|S|T|VE))?`;
const reOptMod = `${rsModifier}?`;
const rsOptVar = `[${rsVarRange}]?`;
const rsOptJoin = `(?:${rsZWJ}(?:${[rsNonAstral, rsRegional, rsSurrPair].join("|")})${rsOptVar}${reOptMod})*`;
const rsSeq = rsOptVar + reOptMod + rsOptJoin;
const rsEmoji = `(?:${[rsDingbat, rsRegional, rsSurrPair].join("|")})${rsSeq}`;

const reUnicodeWord = new RegExp(
  [
    `${rsUpper}?${rsLower}+${rsOptContrLower}(?=${[rsBreak, rsUpper, "$"].join("|")})`,
    `${rsMiscUpper}+${rsOptContrUpper}(?=${[rsBreak, rsUpper + rsMiscLower, "$"].join("|")})`,
    `${rsUpper}?${rsMiscLower}+${rsOptContrLower}`,
    `${rsUpper}+${rsOptContrUpper}`,
    rsDigits,
    rsEmoji,
  ].join("|"),
  "g"
);
const reHasUnicodeWord = /[a-z][A-Z]|[A-Z]{2}[a-z]|[0-9][a-zA-Z]|[a-zA-Z][0-9]|[^a-zA-Z0-9 ]/;
const reAsciiWord = /[^\x00-\x2f\x3a-\x40\x5b-\x60\x7b-\x7f]+/g;
const reApos = new RegExp(rsApos, "g");

/** lodash's words(), without the ordinal rule. */
const words = (s) => (reHasUnicodeWord.test(s) ? s.match(reUnicodeWord) : s.match(reAsciiWord)) || [];
/** lodash's createCompounder(): deburred, apostrophes dropped, then the words folded. */
const compounder = (fold) => (s) => words(deburr(String(s)).replace(reApos, "")).reduce(fold, "");
const camelCase = compounder((acc, w, i) => {
  const word = w.toLowerCase();
  return acc + (i ? capitalize(word) : word);
});
const startCase = compounder((acc, w, i) => acc + (i ? " " : "") + upperFirst(w));

// ── normalize-company-name ──────────────────────────────────────────────────

/** The suffixes, as regex text with their dots unescaped, as Clay has them: "co." also cuts "CO2", "p.c" cuts "P.C" but not "P.C.". */
const SUFFIXES = [
  "llc", "llc.", "l.l.c.", "l.l.c", "pllc", "llp", "inc", "inc.", "incorporated", "ltd", "ltd.",
  "corp", "corporation", "co", "co.", "company", "group", "technologies", "holdings", "global", "p.c", "b.v.",
];
const SUFFIX = new RegExp(`,?\\s+(?:${SUFFIXES.join("|")})$`, "i");

/**
 * Clay's normalize-company-name, step by step in Clay's order:
 *   1. every double quote deleted;
 *   2. every Extended_Pictographic code point (emoji, the registered sign) and U+FE0F deleted;
 *   3. each "(...)" group (to the first ")") replaced by a space;
 *   4. cut at the first whitespace followed by "-" or "|";
 *   5. cut at the first whitespace followed by "d.b.a" (each dot any character) or "dba", any case;
 *   6. whitespace runs collapsed to one space, trimmed;
 *   7. any character then a lower-case "com" at the end deleted (before step 8, case sensitive);
 *   8. ONE suffix deleted: optional comma, whitespace, then a word of SUFFIXES at the end, any case;
 *   9. trailing commas deleted, trimmed;
 *  10. with titleCase, text that equals its own upper or lower case becomes lodash's
 *      startCase(camelCase(text)), split without the ordinal rule.
 * original_name is the input unchanged (String() of a non-string). An empty
 * result is returned as "" (never seen in Clay's answers).
 *
 * @param {unknown} name
 * @param {{ titleCase?: boolean }} [opts]
 * @returns {{ original_name: string, normalized_name: string }}
 */
export function normalizeCompanyName(name, { titleCase = false } = {}) {
  const original = typeof name === "string" ? name : String(name);
  let s = original.replace(/"/g, "");
  s = s.replace(/\p{Extended_Pictographic}|\uFE0F/gu, "");
  s = s.replace(/\([^)]*\)/g, " ");
  s = s.split(/\s[-|]/)[0];
  s = s.split(/\s(?:d.b.a|dba)/i)[0];
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/.com$/, "");
  s = s.replace(SUFFIX, "");
  s = s.replace(/,+$/, "").trim();
  if (titleCase && (s === s.toUpperCase() || s === s.toLowerCase())) s = startCase(camelCase(s));
  return { original_name: original, normalized_name: s };
}

// ── extract-email-components ────────────────────────────────────────────────

/** The provider by the domain's name label, so regional domains (yahoo.co.nz, hotmail.es) map like the .com ones; anything else is UNKNOWN. */
const PROVIDERS = new Map([
  ["gmail", "GMAIL"], ["yahoo", "YAHOO"], ["aol", "AOL"], ["hotmail", "HOTMAIL"], ["outlook", "OUTLOOK"], ["live", "OUTLOOK"],
  ["msn", "MSN"], ["icloud", "ICLOUD"], ["me", "ICLOUD"], ["protonmail", "PROTONMAIL"], ["qq", "TENCENT-QQ"],
]);

/**
 * Clay's extract-email-components: the address split at its LAST "@". The
 * username keeps its case; the domain is the registrable domain of the lower
 * case host (the public suffix list, tldts), else the host; the guessed name is
 * the username split on "." and "-", each part capitalised (lodash), joined
 * with one space ("_" and digits don't split); the provider comes from the
 * domain's name label (PROVIDERS). Null when there is no "@" (never seen: the
 * run condition needs a valid address).
 *
 * @param {unknown} email
 * @returns {{ domain: string, address: string, isGmail: boolean, isYahoo: boolean, isProton: boolean, isYandex: boolean,
 *   isiCloud: boolean, username: string, isHotmail: boolean, guessedName: string, emailProvider: string,
 *   isLikelyCompanyEmail: boolean, isLikelyPersonalEmail: boolean, isLikelyEducationEmail: boolean } | null}
 */
export function extractEmailComponents(email) {
  const address = typeof email === "string" ? email : email == null ? "" : String(email);
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const username = address.slice(0, at);
  const host = address.slice(at + 1).toLowerCase();
  const domain = getDomain(host) || host;
  const guessedName = username.split(/[.-]/).map((part) => capitalize(part)).join(" ");
  const label = getDomainWithoutSuffix(host) || domain.split(".")[0];
  const emailProvider = PROVIDERS.get(label) ?? "UNKNOWN";
  const personal = emailProvider !== "UNKNOWN";
  // Clay's own key order.
  return {
    domain,
    address,
    isGmail: emailProvider === "GMAIL",
    isYahoo: emailProvider === "YAHOO",
    isProton: emailProvider === "PROTONMAIL",
    isYandex: emailProvider === "YANDEX",
    isiCloud: emailProvider === "ICLOUD",
    username,
    isHotmail: emailProvider === "HOTMAIL",
    guessedName,
    emailProvider,
    isLikelyCompanyEmail: !personal,
    isLikelyPersonalEmail: personal,
    isLikelyEducationEmail: /\.edu$/.test(domain),
  };
}

// ── The cells, as Clay shows them ───────────────────────────────────────────

/** normalize-company-name's cell display. */
export const companyNameDisplay = (out) => `\u2705 ${out.normalized_name}`;
/** extract-email-components' cell display. */
export const emailComponentsDisplay = (out) => `Domain: ${out.domain} | Name: ${out.guessedName}`;

// ── The actions ─────────────────────────────────────────────────────────────

const blank = (v) => v === undefined || v === null || v === "" || (typeof v === "number" && Number.isNaN(v));
const failure = (tool, e) => ({
  status: "error",
  note: `Our copy of Clay's ${tool} failed: ${String(e?.message ?? e).slice(0, 200)}`,
  retryable: false,
});

async function runNormalizeCompanyName({ inputs }) {
  try {
    const name = inputs?.companyName;
    if (blank(name)) return { status: "empty", note: "No company name" };
    // Off unless the original says so: Clay's default is not in what its answers show.
    const titleCase = inputs?.titleCase === true || inputs?.titleCase === "true";
    const out = normalizeCompanyName(name, { titleCase });
    return { status: "done", value: out, display: companyNameDisplay(out), note: "Clay's normalize-company-name (exact copy)" };
  } catch (e) {
    return failure("normalize-company-name", e);
  }
}

async function runExtractEmailComponents({ inputs }) {
  try {
    const email = inputs?.email;
    const out = blank(email) ? null : extractEmailComponents(email);
    if (!out) return { status: "empty", note: "Not an email address" };
    return { status: "done", value: out, display: emailComponentsDisplay(out), note: "Clay's extract-email-components (exact copy)" };
  } catch (e) {
    return failure("extract-email-components", e);
  }
}

/**
 * The two tools as actions, registered in PIPELINE_ACTIONS
 * (pipeline-actions.mjs). Free and local: cache false.
 */
export const CLAY_TOOL_ACTIONS = Object.freeze({
  clay_normalize_company_name: Object.freeze({ run: runNormalizeCompanyName, cache: false }),
  clay_extract_email_components: Object.freeze({ run: runExtractEmailComponents, cache: false }),
});

/** The input bindings each tool's original must hold. */
export const CLAY_TOOL_BINDINGS = Object.freeze({
  clay_normalize_company_name: Object.freeze(["companyName"]),
  clay_extract_email_components: Object.freeze(["email"]),
});

/**
 * A tool column's inputs, compiled from its original: every input binding the
 * original holds with a formula (companyName and titleCase on G#14 and P#29,
 * email on G#16), its {{f_<id>}} references rewritten with the template's map.
 * So the inputs are the original's own: G#14 compiles to
 * { companyName: "{{company}}", titleCase: "true" } on the default originals.
 * Throws when a required binding is missing or a reference is one the
 * template does not map, so the template does not compile from that variant.
 *
 * @param {import("./compile-original.mjs").Originals} originals
 * @param {string} from  the original, "G#14"
 * @param {Map<string, string>} idToKey  the template's own id-to-key map (refMap with its REFS)
 * @param {string} action  a key of CLAY_TOOL_ACTIONS
 * @returns {Record<string, string>}
 */
export function toolInputs(originals, from, idToKey, action) {
  const required = Object.hasOwn(CLAY_TOOL_BINDINGS, action) ? CLAY_TOOL_BINDINGS[/** @type {keyof typeof CLAY_TOOL_BINDINGS} */ (action)] : null;
  if (!required) throw new Error(`${from}: "${action}" is not one of the Clay tools in clay-tools.mjs`);
  const def = originalOf(originals, from).definition;
  for (const name of required) {
    const t = bindingOf(def, name)?.formulaText;
    if (typeof t !== "string" || !t.trim()) throw new Error(`${from}: the original has no ${name} input`);
  }
  /** @type {Record<string, string>} */
  const out = {};
  const list = def?.settings?.inputsBinding;
  for (const b of Array.isArray(list) ? list : []) {
    if (typeof b?.name !== "string" || typeof b.formulaText !== "string" || !b.formulaText.trim()) continue;
    const r = rewriteRefs(b.formulaText, idToKey);
    if (r.unknown.length) throw new Error(`${from} reads a column this template does not map`);
    out[b.name] = r.text;
  }
  return out;
}
