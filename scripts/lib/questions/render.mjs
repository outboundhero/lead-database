// Question variable prompts (139): the placeholders a person types into a
// variable's research prompt and its People and General question prompts, the
// save-time check of them, and how a prompt is rendered for one lead.
//
// Pure, with no imports at all (no database, no network, no node: module), so
// the Clay tab's editor loads it as it is.
//
// Syntax: {{Name}} or {{Name.field}}. A name matches whatever its case, and
// spaces inside the braces are ignored: at the ends, around the dot and
// squeezed between words ("{{ company   website }}" is {{Company Website}},
// "{{Research . Best_Fit}}" is {{research.best_fit}}). "{{" and "}}" mean
// nothing else: a pair that names no placeholder the prompt may use, an empty
// pair, an unclosed "{{" and a stray "}}" are each an error a save refuses,
// named in its message.
//
// The research prompt is answered once per company and reused by every lead
// of that company, so it may only read what is the same for all of them: no
// person (Title, First Name) and no research answer. The question prompts may
// read everything, the research answer's fields included.

/** What the research prompt may read. */
export const RESEARCH_PLACEHOLDERS = Object.freeze([
  "Company",
  "Company Website",
  "Category",
  "Sub-Category",
  "Additional Category",
  "City",
  "State",
  "Services",
  "Client Context",
  "Service Area",
]);

/** The research answer's fields, in order: the json_schema the research call asks for. */
export const RESEARCH_FIELDS = Object.freeze(["company_summary", "service_spaces", "best_fit"]);

/** What the People and General question prompts may read. */
export const QUESTION_PLACEHOLDERS = Object.freeze([
  "Company",
  "Company Website",
  "Category",
  "Sub-Category",
  "Additional Category",
  "Title",
  "First Name",
  "City",
  "State",
  "Services",
  "Client Context",
  "Service Area",
  ...RESEARCH_FIELDS.map((f) => `research.${f}`),
]);

/** Where each placeholder's value comes from in a render context (see contextFor). */
const SOURCE = Object.freeze({
  company: "company",
  "company website": "companyWebsite",
  category: "category",
  "sub-category": "subCategory",
  "additional category": "additionalCategory",
  title: "title",
  city: "city",
  state: "state",
  "first name": "firstName",
  services: "services",
  "client context": "clientContext",
  "service area": "serviceArea",
});

/** A pair of double braces with no brace inside: the only shape a placeholder has. */
const PAIR = /\{\{([^{}]*)\}\}/g;

/**
 * A placeholder's name as it is matched: lower case, trimmed, inner runs of
 * spaces squeezed to one, none around a dot.
 * @param {unknown} name
 * @returns {string}
 */
export function placeholderKey(name) {
  return String(name ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*/g, ".")
    .toLowerCase();
}

/**
 * Why a prompt can't be saved, one plain-words message per problem (each
 * unknown placeholder named once, as typed), or [] when it can.
 * @param {unknown} template
 * @param {readonly string[]} allowed  RESEARCH_PLACEHOLDERS or QUESTION_PLACEHOLDERS
 * @returns {string[]}
 */
export function placeholderErrors(template, allowed) {
  const text = String(template ?? "");
  const ok = new Set((allowed ?? []).map(placeholderKey));
  const errors = [];
  const seen = new Set();
  for (const m of text.matchAll(PAIR)) {
    const shown = m[1].trim().replace(/\s+/g, " ");
    const key = placeholderKey(m[1]);
    if (!key) {
      if (!seen.has("")) errors.push('An empty placeholder "{{}}": put a name between the braces, or take them out.');
      seen.add("");
      continue;
    }
    if (ok.has(key) || seen.has(key)) {
      seen.add(key);
      continue;
    }
    seen.add(key);
    errors.push(`Unknown placeholder {{${shown}}}: ${allowedText(allowed)}.`);
  }
  const rest = text.replace(PAIR, "");
  if (rest.includes("{{")) errors.push('An unclosed "{{": close it with "}}", or take it out.');
  if (rest.includes("}}")) errors.push('A stray "}}" with no "{{" before it.');
  return errors;
}

function allowedText(allowed) {
  const list = (allowed ?? []).map((n) => `{{${n}}}`);
  return list.length ? `this prompt may use ${list.join(", ")}` : "this prompt may use no placeholder";
}

const plain = (v) => (v == null ? "" : String(v).trim());

/**
 * The prompt with each placeholder replaced by its value. An empty or missing
 * value renders as "". A placeholder the context doesn't know renders as ""
 * too (a save refuses one, so it only happens to a prompt saved before a
 * placeholder was taken away). Text outside the pairs is kept as it is.
 * @param {unknown} template
 * @param {Record<string, unknown> & { research?: Record<string, unknown> | null }} ctx  see contextFor
 * @returns {string}
 */
export function renderQuestionPrompt(template, ctx) {
  return String(template ?? "").replace(PAIR, (_, raw) => {
    const key = placeholderKey(raw);
    if (key.startsWith("research.")) {
      const field = key.slice("research.".length);
      const research = ctx?.research && typeof ctx.research === "object" ? ctx.research : {};
      const hit = Object.keys(research).find((k) => k.toLowerCase() === field);
      return hit ? plain(research[hit]) : "";
    }
    const from = SOURCE[/** @type {keyof typeof SOURCE} */ (key)];
    return from ? plain(ctx?.[from]) : "";
  });
}

/**
 * The domain of an address: what follows its last "@", lower case.
 * @param {unknown} email
 */
export function emailDomain(email) {
  const s = plain(email);
  const at = s.lastIndexOf("@");
  return at >= 0 ? s.slice(at + 1).toLowerCase() : "";
}

/**
 * A lead's render context. Company Website is the lead's domain, else its
 * email's domain. Services and Client Context are the variable's; Service Area
 * is the client's (service-area.mjs); research is the company's research
 * answer, or null for the research prompt itself.
 *
 * @param {{ company?: unknown, domain?: unknown, email?: unknown, category?: unknown, subcategory?: unknown,
 *   additional_category?: unknown, title?: unknown, city?: unknown, state?: unknown, first_name?: unknown }} lead
 * @param {{ services?: unknown, client_context?: unknown }} variable
 * @param {{ serviceArea?: unknown, research?: Record<string, unknown> | null }} [more]
 */
export function contextFor(lead, variable, { serviceArea = "", research = null } = {}) {
  return {
    company: plain(lead?.company),
    companyWebsite: plain(lead?.domain) || emailDomain(lead?.email),
    category: plain(lead?.category),
    subCategory: plain(lead?.subcategory),
    additionalCategory: plain(lead?.additional_category),
    title: plain(lead?.title),
    city: plain(lead?.city),
    state: plain(lead?.state),
    firstName: plain(lead?.first_name),
    services: plain(variable?.services),
    clientContext: plain(variable?.client_context),
    serviceArea: plain(serviceArea),
    research: research && typeof research === "object" ? research : null,
  };
}
