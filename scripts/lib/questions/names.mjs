// Question variable names (139). EmailBison keeps custom variable names in
// lower case ("question", "unique service question") and campaign copy writes
// them upper case in braces ({QUESTION}). We store the lower-case name, the way
// Bison does, and show the copy form wherever a person reads it.
//
// Pure: no database, no network. Shared by the web routes, the enrich-worker's
// question writer and the push-worker.

/** Names the push already sends for every lead; a question variable may not reuse one. */
export const RESERVED_VARIABLE_NAMES = Object.freeze([
  "question",
  "category",
  "sub-category",
  "additional category",
  "city",
  "state",
  "domain",
  "address",
  "company phone",
  "google maps url",
  "person linkedin url",
]);

const NAME_RE = /^[a-z0-9][a-z0-9 _-]{0,62}$/;

/**
 * The stored form of a typed name: lower case, trimmed, inner runs of
 * whitespace collapsed to one space. Braces typed around it ({ACME-OS QUESTION})
 * are dropped.
 * @param {unknown} input
 * @returns {string}
 */
export function canonicalVariableName(input) {
  return String(input ?? "")
    .trim()
    .replace(/^\{+|\}+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Why a stored name cannot be used, in plain words, or null when it can.
 * @param {string} name a canonical name (see canonicalVariableName)
 * @returns {string | null}
 */
export function variableNameError(name) {
  if (!name) return "Give the variable a name.";
  if (!NAME_RE.test(name)) {
    return "Use letters, digits, spaces, dashes or underscores (at most 63), starting with a letter or digit.";
  }
  if (RESERVED_VARIABLE_NAMES.includes(name)) return `"${name}" is already sent with every lead; pick another name.`;
  return null;
}

/**
 * How campaign copy writes the variable: {ACME-OS QUESTION}.
 * @param {string} name
 * @returns {string}
 */
export function copyTag(name) {
  return `{${String(name).toUpperCase()}}`;
}

/**
 * The suggested name for a client's own variable: "<tag> question" (tag lower case).
 * @param {string} tag
 * @returns {string}
 */
export function defaultVariableNameFor(tag) {
  return canonicalVariableName(`${tag} question`);
}

/**
 * Whether a client sells other services (an "OS" client): its type in the
 * client list is OS, or its tag ends with one of the given suffixes (the
 * sharing setting's isolated_tag_suffixes, default ["-OS"]).
 * @param {{ tag?: string | null, clientType?: string | null }} client
 * @param {readonly string[]} [suffixes]
 * @returns {boolean}
 */
export function isOsClient(client, suffixes = ["-OS"]) {
  const type = String(client?.clientType ?? "").trim().toUpperCase();
  if (type === "OS") return true;
  const tag = String(client?.tag ?? "").trim().toUpperCase();
  if (!tag) return false;
  return suffixes.some((s) => {
    const suffix = String(s ?? "").trim().toUpperCase();
    return suffix !== "" && tag.endsWith(suffix) && tag.length > suffix.length;
  });
}
