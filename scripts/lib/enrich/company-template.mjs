// The Companies template (enrich_tables.template = 'companies_v1'): the columns
// of every client's pipeline Companies table on the Clay tab, where AI Ark
// company pulls land (scripts/lib/aiark/company-runs.mjs). One template for
// every client: it holds no client lists, names or prompts with client data.
// client_office and client_exclusions read the client's rules at run time.
//
// The order of work, column by column (the engine follows the dependencies):
//   1. the office in the client's area, then the client's exclusions (free)
//   2. a general inbox for the company already in the database (free)
//   3. the website: AI Ark's, checked for free; a paid search only when it is
//      missing or dead
//   4. the general email: AI Ark's own when the office is the head office, then
//      a first search, then a second search, each checked with Reoon (at most
//      3 paid checks a company)
//   5. the outcome. Listed on the Companies tab: "Has a general email" and
//      "Already in the database".
// A paid step runs only for a company inside the area, clear of the client's
// exclusions, not on the never-contact list and with no usable inbox held.
//
// Plain JavaScript so the worker and the Next.js routes share it.

import { clip, sizeText } from "../aiark/client.mjs";
import { OFFICES_MAX, officesOf } from "../aiark/company-filters.mjs";
import { bareDomain } from "./domain.mjs";

export const COMPANY_TEMPLATE = "companies_v1";
export const TEMPLATE_TABLE_NAME = "Companies (pipeline)";
export const SOURCE_BOUGHT = "AI Ark pull";
export const SOURCE_COPIED = "Copied from an earlier pull (no charge)";
/** The outcomes the Companies tab lists. */
export const LISTED_OUTCOMES = ["Has a general email", "Already in the database"];

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

// ── Lists ───────────────────────────────────────────────────────────────────

/**
 * Sites that are never a business's own website: directories, review and
 * booking sites, social media, marketplaces, map listings, link pages. A
 * website on one of these (or a page under it) counts as no website.
 */
export const DIRECTORY_BLOCKLIST = [
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com", "youtube.com", "tiktok.com", "pinterest.com",
  "linktr.ee", "beacons.ai", "bit.ly", "goo.gl", "google.com", "business.site", "maps.apple.com", "mapquest.com",
  "yelp.com", "yellowpages.com", "yp.com", "bbb.org", "manta.com", "bizapedia.com", "opencorporates.com",
  "chamberofcommerce.com", "zoominfo.com", "apollo.io", "crunchbase.com", "dnb.com", "clearbit.com",
  "angi.com", "angieslist.com", "homeadvisor.com", "thumbtack.com", "houzz.com", "nextdoor.com", "porch.com",
  "tripadvisor.com", "opentable.com", "zagat.com", "restaurantguru.com", "menupages.com", "doordash.com", "ubereats.com",
  "grubhub.com", "healthgrades.com", "zocdoc.com", "webmd.com", "vitals.com", "ratemds.com", "realself.com",
  "opencare.com", "vagaro.com", "booksy.com", "mindbodyonline.com", "squareup.com", "square.site", "upwork.com",
  "fiverr.com", "indeed.com", "glassdoor.com", "amazon.com", "ebay.com", "etsy.com", "walmart.com", "apple.com",
  "microsoft.com", "outlook.com", "gmail.com", "wikipedia.org", "usnews.com", "forbes.com", "nerdwallet.com",
  "loopnet.com", "apartments.com", "zillow.com", "realtor.com", "churchfinder.com", "find-a-church.com",
];

/**
 * Local parts that are never an office's general inbox, written without dots,
 * dashes or underscores ("no-reply" and "no.reply" are both "noreply"). Taken
 * from the old Clay table's "qualified general email" and Reoon checks, less
 * anything client-specific.
 */
export const JUNK_LOCAL_PARTS = [
  "noreply", "donotreply", "unsubscribe", "optout", "remove", "blacklist", "suppression", "canspam", "complaint",
  "complaints", "spam", "abuse", "postmaster", "mailerdaemon", "bounce", "bounces", "webmaster", "legal", "legalteam",
  "privacy", "gdpr", "grc", "compliance", "dataprivacy", "datacompliance", "billing", "invoice", "invoices", "accounts",
  "accountspayable", "payment", "payments", "payroll", "finance", "accounting", "tax", "audit", "ledger", "transactions",
  "credit", "collections", "press", "media", "pr", "news", "newsroom", "publicrelations", "editor", "editors", "investor",
  "investors", "investorrelations", "careers", "jobs", "recruitment", "recruiting", "orders", "orderstatus", "returns",
  "shipping", "dispatch", "ticketing", "confirmations", "notifications", "alerts", "updates", "newsletter", "promotions",
  "feedback", "security", "accessibility", "accommodation", "terms", "disputes", "claims", "customerservice",
  "clientservices", "test", "testing", "demo", "example", "sample", "placeholder", "dummy", "fake", "invalid", "none",
  "na", "null", "unknown", "email", "youremail", "yourname", "name",
];

/** Local parts that start one of these are junk too ("noreply123", "donotreply-us"). */
export const JUNK_LOCAL_PREFIXES = ["noreply", "donotreply", "mailerdaemon", "unsubscribe", "bounce"];

/** Domains that are never a business's inbox: placeholders, site builders' system mail, and the big platforms. */
export const JUNK_DOMAINS = [
  "example.com", "example.org", "example.net", "domain.com", "email.com", "yourdomain.com", "yourcompany.com",
  "company.com", "mysite.com", "website.com", "test.com", "sentry.io", "wixpress.com", "sentry.wixpress.com",
  "squarespace.com", "wix.com", "weebly.com", "godaddy.com", "zoominfo.com", "google.com", "microsoft.com",
  "linkedin.com", "facebook.com", "twitter.com", "instagram.com", "reddit.com", "bbb.org", "yelp.com",
];

/** Top-level domains left out: government and military inboxes. */
export const JUNK_TLDS = ["gov", "mil"];

/**
 * Role-based local parts: an address that starts with one of these is a
 * general inbox. Copied from ROLE_PREFIXES in src/lib/uploads/detect-email-type.ts,
 * which plain node can't import; keep the two the same.
 */
export const ROLE_PREFIX_SOURCE =
  "^(info|contact|hello|sales|support|admin|team|office|marketing|noreply|no-?reply|mail|careers|hr|jobs|press|media|billing|accounts?|invoices?|enquir(?:y|ies)|inquir(?:y|ies)|hi|help|service|reception|frontdesk|orders|shop|store|web|webmaster|postmaster|abuse)@";

// ── What AI Ark returned -> the input cells ─────────────────────────────────

/**
 * The input cells for one AI Ark company record (Company Search, or the
 * registry's trimmed copy). Every value is text; empty ones are left out.
 * offices: JSON, head office first, the same office kept once, at most 25.
 *
 * @param {object} record  AI Ark's company record
 * @param {{ source?: string, pulledBefore?: string | null }} [opts]
 * @returns {Record<string, string>}
 */
export function companyInputs(record, { source = SOURCE_BOUGHT, pulledBefore = null } = {}) {
  const s = record?.summary ?? {};
  const link = record?.link ?? {};
  const contact = record?.contact ?? {};
  const offices = officesOf(record);
  const email = text(contact.email).toLowerCase();
  const out = {
    company: text(s.name) || text(s.legal_name),
    aiark_id: text(record?.id),
    website: text(link.website),
    domain: bareDomain(link.domain) ?? bareDomain(link.website) ?? "",
    linkedin: text(link.linkedin),
    phone: text(contact.phone?.raw) || text(contact.phone?.sanitized),
    aiark_email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "",
    industry: text(s.industry),
    employees: sizeText(s.staff),
    company_type: text(s.type),
    description: clip(text(s.description), 2_000),
    offices: offices.length ? JSON.stringify(offices.slice(0, OFFICES_MAX)) : "",
    office_count: offices.length ? String(offices.length) : "",
    aiark_updated: text(record?.last_updated),
    pulled_before: text(pulledBefore),
    source: text(source),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v));
}

// ── Prompts (generic: no client data) ───────────────────────────────────────
// Template literals over the row's cells; ai_web reads empty cells as "".

const WEBSITE_PROMPT = `\`Find the official website of this business at this office.

Business: \${ {{company}} }
Office address: \${ {{use_address}} }
Industry: \${ {{industry}} }
LinkedIn page: \${ {{linkedin}} }

Rules:
- Answer with the business's own website: its home page, or its page for this office.
- Never answer with a directory, review site, social media page, marketplace, map listing or booking page.
- Confirm on the website that the business has an office in this city and state. If you can't confirm it, answer N/A.

Answer in JSON: {"website": "the address"}, or {"website": "N/A"}.\``;

const EMAIL_RULES = `Leave out no-reply, complaints, billing, legal, privacy, press and careers addresses, and the support desks of large companies.

Answer in JSON with three fields:
- emails: up to 5 addresses, best first, separated by commas, or N/A if you find none
- source_url: the page where you found the first address, or N/A
- office_match: yes if the first address is for this office, no if it is for another office or the head office, unknown otherwise`;

const EMAIL_PROMPT_FIRST = `\`Find the general contact email for this office of the business: a shared inbox such as info@, office@ or the front desk, not a named person's address.

Business: \${ {{company}} }
Website: \${ {{use_website}} }
Office address: \${ {{use_address}} }
Industry: \${ {{industry}} }

Look on the business's contact, about and location pages, and its listings.
${EMAIL_RULES}\``;

const EMAIL_PROMPT_SECOND = `\`Search again, more widely, for the general contact email for this office of the business: a shared inbox such as info@, office@ or the front desk, not a named person's address. A first search found none that could be used.

Business: \${ {{company}} }
Website: \${ {{use_website}} }
Office address: \${ {{use_address}} }
Industry: \${ {{industry}} }

Look beyond the website too: business listings, chamber of commerce and trade association pages, and the business's own social media profiles.
${EMAIL_RULES}\``;

/** The prompts, as the template sends them (for review and the tests). */
export const PROMPTS = { website: WEBSITE_PROMPT, email_first: EMAIL_PROMPT_FIRST, email_second: EMAIL_PROMPT_SECOND };

// ── Formulas ────────────────────────────────────────────────────────────────

const PASSES = "{{passes_filters}}";
const PAID_OK = `${PASSES} && !{{held_usable}} && !{{never_contact}}`;
const WEBSITE_GIVEN = `(() => {
  const blocked = ${JSON.stringify(DIRECTORY_BLOCKLIST)};
  const host = (u) => String(u ?? "").trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\\/\\//, "").split(/[\\/?#\\s]/)[0].replace(/:\\d+$/, "").replace(/^www\\d?\\./, "");
  for (const u of [{{website}}, {{domain}}]) {
    const h = host(u);
    if (h && h.includes(".") && !blocked.some((d) => h === d || h.endsWith("." + d))) return String(u).trim();
  }
  return undefined;
})()`;
const MEMORY_KEY_OFFICE = `[{{use_domain}}?.normalizedUrl, {{use_state}}, {{use_city}}].map((s) => String(s ?? "").trim().toLowerCase()).join("|")`;
const WINNER = `[{{aiark_email_check}}, {{email_check_1}}, {{email_check_2}}].find((c) => c?.email)`;
const AI_LOCATION = { city: "{{use_city}}", region: "{{office}}?.office?.state_name ?? {{use_state}}", country: "{{office}}?.office?.country" };

/** @type {Array<Record<string, unknown>>} */
const COLUMNS = [
  // ── What AI Ark returned (written by the pull) ──────────────────────────
  { key: "company", name: "Company", kind: "input", description: "The company's name on AI Ark." },
  { key: "aiark_id", name: "AI Ark id", kind: "input", description: "AI Ark's id for the company. No pull buys a company whose id is already held." },
  { key: "website", name: "Website (AI Ark)", kind: "input", data_type: "url" },
  { key: "domain", name: "Domain (AI Ark)", kind: "input", data_type: "url", description: "The bare domain of AI Ark's domain, or of its website." },
  { key: "linkedin", name: "LinkedIn", kind: "input", data_type: "url" },
  { key: "phone", name: "Phone", kind: "input" },
  { key: "aiark_email", name: "Email (AI Ark)", kind: "input", description: "The company email AI Ark lists. Not checked by AI Ark: Reoon checks it, and only when the office used is the head office." },
  { key: "industry", name: "Industry", kind: "input" },
  { key: "employees", name: "Employees", kind: "input", description: "AI Ark's headcount figure and band." },
  { key: "company_type", name: "Company type", kind: "input", hidden: true },
  { key: "description", name: "Description", kind: "input", hidden: true },
  { key: "offices", name: "Offices", kind: "input", hidden: true, description: "The head office first, then the other offices AI Ark lists, at most 25, as AI Ark writes them." },
  { key: "office_count", name: "Offices listed", kind: "input", hidden: true },
  { key: "aiark_updated", name: "AI Ark updated", kind: "input", hidden: true, description: "When AI Ark last refreshed the record." },
  {
    key: "pulled_before", name: "Bought before", kind: "input",
    description: "Filled when AI Ark returned a company an earlier pull had already bought (past its exclusion lists). It was paid for again and is written once.",
  },
  { key: "source", name: "Source", kind: "input", description: "AI Ark pull: bought by the pull. Copied from an earlier pull: bought for any client before, inside this client's places, and copied for free." },

  // ── The client's area and exclusions ───────────────────────────────────
  {
    key: "office", name: "Office in the client's area", kind: "action", action: "client_office", data_type: "json", provider: "Client rules",
    inputs: { offices: "{{offices}}" },
    description: "Checks every office against the client's places and excluded places, exactly as the send gate would place a lead there. The head office when it is inside, else the first office inside. Outside: no office is. Can't tell: AI Ark gave no state the lead database could place.",
  },
  { key: "use_city", name: "City", kind: "formula", formula: "{{office}}?.office?.city", description: "The office's city." },
  { key: "use_state", name: "State", kind: "formula", formula: "{{office}}?.office?.state", description: "The office's state, as a code." },
  {
    key: "use_address", name: "Address", kind: "formula", hidden: true,
    formula: `[{{office}}?.office?.street, {{office}}?.office?.city, [{{office}}?.office?.state, {{office}}?.office?.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ") || undefined`,
  },
  { key: "in_area", name: "Inside the client's area", kind: "formula", data_type: "boolean", formula: "{{office}}?.inside === true" },
  {
    key: "rule_match", name: "Client exclusions", kind: "action", action: "client_exclusions", provider: "Client rules",
    inputs: { company: "{{company}}", industry: "{{industry}}", description: "{{description}}" },
    description: "The client's exclusion terms: anywhere in the company name or industry, as the send gate matches them, and as whole words in the description.",
  },
  { key: "passes_filters", name: "Passes the client's rules", kind: "formula", data_type: "boolean", formula: "{{in_area}} === true && !{{rule_match}}" },

  // ── An inbox already held ──────────────────────────────────────────────
  {
    key: "held_email", name: "General inbox in the database", kind: "action", action: "held_general_email", data_type: "json", provider: "Lead database",
    inputs: { domain: "{{domain}}", company: "{{company}}", city: "{{use_city}}", state: "{{use_state}}", country: "{{office}}?.office?.country" },
    run_if: PASSES,
    description: "Looks for this company's general inbox in the lead database, its copy of Email Bison and the never-contact list: 14 role addresses at its domain (info@, office@ …), then general-inbox leads at the same company in the same city and state. Never contact stops the company. A bounced address is searched past, and never used.",
  },
  {
    key: "held_usable", name: "Usable inbox held", kind: "formula", data_type: "boolean",
    formula: "Boolean({{held_email}}?.email) && !{{held_email}}?.bounced && !{{held_email}}?.never_contact",
  },
  { key: "never_contact", name: "Never contact", kind: "formula", data_type: "boolean", formula: "{{held_email}}?.never_contact === true" },

  // ── The website ────────────────────────────────────────────────────────
  {
    key: "website_given", name: "Website to check", kind: "formula", data_type: "url", formula: WEBSITE_GIVEN,
    description: "AI Ark's website, else its domain, unless it is a directory, social media page or similar (those count as no website).",
  },
  {
    key: "website_given_check", name: "AI Ark's website works", kind: "action", action: "check_url", data_type: "json", provider: "Website check",
    inputs: { url: "{{website_given}}" }, run_if: `${PASSES} && Boolean({{website_given}})`,
    description: "Free: tries the address over http and https, with and without www. A timeout counts as working, as in Clay.",
  },
  {
    key: "website_search", name: "Website search", kind: "action", action: "ai_web", data_type: "json", provider: "OpenAI",
    needs_env: ["OPENAI_API_KEY"],
    config: {
      model_setting: "website_search", tool: "web_search", answer: { website: "text" },
      answer_description: "The business's own website address, or N/A", memory: "website_v1", memory_days: "website",
    },
    inputs: { prompt: WEBSITE_PROMPT, memory_key: "{{aiark_id}}", ...AI_LOCATION },
    run_if: `${PAID_OK} && !{{website_given_check}}?.valid`,
    description: "Paid, only when AI Ark's website is missing or doesn't work: a web search for the business's own site at this office. An answer is remembered for every row and client (by AI Ark id), so the same company is never searched twice.",
  },
  {
    key: "website_search_check", name: "Found website works", kind: "action", action: "check_url", data_type: "json", provider: "Website check",
    inputs: { url: "{{website_search}}?.website" }, run_if: "Boolean({{website_search}}?.website)",
  },
  {
    key: "use_website", name: "Website", kind: "waterfall", data_type: "url",
    waterfall: [
      "{{website_given_check}}?.valid ? {{website_given}} : undefined",
      "{{website_search_check}}?.valid ? {{website_search}}?.website : undefined",
    ],
    description: "AI Ark's website when it works, else the website the search found when that works.",
  },
  {
    key: "use_domain", name: "Domain", kind: "action", action: "normalize_url", data_type: "json", provider: "Formula",
    inputs: { url: "{{use_website}}" }, run_if: "Boolean({{use_website}})",
  },

  // ── The general email ──────────────────────────────────────────────────
  {
    key: "aiark_candidates", name: "AI Ark's email, cleaned", kind: "action", action: "pick_emails", data_type: "json", provider: "Formula",
    inputs: { texts: "{{aiark_email}}", exclude: "{{held_email}}?.excluded ?? []", domain: "{{use_domain}}?.normalizedUrl || {{domain}}" },
    run_if: `${PAID_OK} && {{office}}?.hq === true && Boolean({{aiark_email}})`,
    description: "AI Ark's company email, used only when the office in the area is the head office, and only if it is not a no-reply, billing or similar address.",
  },
  {
    key: "aiark_email_check", name: "AI Ark's email checked", kind: "action", action: "verify_emails", data_type: "json", provider: "Reoon",
    inputs: { emails: "{{aiark_candidates}}?.emails", spent: "0" },
    run_if: "{{aiark_candidates}}?.emails?.length > 0",
    description: "Reoon's check (a verdict from the last 90 days is reused for free). Valid or Catch-all is usable.",
  },
  {
    key: "email_search_1", name: "Email search", kind: "action", action: "ai_web", data_type: "json", provider: "OpenAI",
    needs_env: ["OPENAI_API_KEY"],
    config: {
      model_setting: "email_search_first", tool: "web_search", answer: { emails: "text", source_url: "text", office_match: "text" },
      answer_description: "", memory: "email_search_first_v1", memory_days: "email",
    },
    inputs: { prompt: EMAIL_PROMPT_FIRST, memory_key: MEMORY_KEY_OFFICE, ...AI_LOCATION },
    run_if: `${PAID_OK} && Boolean({{use_website}}) && !{{aiark_email_check}}?.email`,
    description: "Paid, only with a working website and nothing usable yet: up to 5 general addresses for this office. Remembered for every row and client by domain and office.",
  },
  {
    key: "candidates_1", name: "Found emails, cleaned", kind: "action", action: "pick_emails", data_type: "json", provider: "Formula",
    inputs: {
      texts: "{{email_search_1}}?.emails",
      exclude: "[...({{held_email}}?.excluded ?? []), ...({{aiark_email_check}}?.checked ?? []).map((c) => c.email)]",
      domain: "{{use_domain}}?.normalizedUrl || {{domain}}",
    },
    run_if: "Boolean({{email_search_1}})",
  },
  {
    key: "email_check_1", name: "Found emails checked", kind: "action", action: "verify_emails", data_type: "json", provider: "Reoon",
    inputs: { emails: "{{candidates_1}}?.emails", spent: "{{aiark_email_check}}?.paid ?? 0" },
    run_if: "{{candidates_1}}?.emails?.length > 0",
  },
  {
    key: "email_search_2", name: "Second email search", kind: "action", action: "ai_web", data_type: "json", provider: "OpenAI",
    needs_env: ["OPENAI_API_KEY"],
    config: {
      model_setting: "email_search_second", tool: "web_search", answer: { emails: "text", source_url: "text", office_match: "text" },
      answer_description: "", memory: "email_search_second_v1", memory_days: "email",
    },
    inputs: { prompt: EMAIL_PROMPT_SECOND, memory_key: MEMORY_KEY_OFFICE, ...AI_LOCATION },
    run_if: `${PAID_OK} && Boolean({{use_website}}) && !{{aiark_email_check}}?.email && !{{email_check_1}}?.email`,
    description: "Paid, only when the first search found nothing usable: a wider search. Remembered like the first.",
  },
  {
    key: "candidates_2", name: "Second search emails, cleaned", kind: "action", action: "pick_emails", data_type: "json", provider: "Formula",
    inputs: {
      texts: "{{email_search_2}}?.emails",
      exclude: "[...({{held_email}}?.excluded ?? []), ...({{aiark_email_check}}?.checked ?? []).map((c) => c.email), ...({{email_check_1}}?.checked ?? []).map((c) => c.email)]",
      domain: "{{use_domain}}?.normalizedUrl || {{domain}}",
    },
    run_if: "Boolean({{email_search_2}})",
  },
  {
    key: "email_check_2", name: "Second search emails checked", kind: "action", action: "verify_emails", data_type: "json", provider: "Reoon",
    inputs: { emails: "{{candidates_2}}?.emails", spent: "({{aiark_email_check}}?.paid ?? 0) + ({{email_check_1}}?.paid ?? 0)" },
    run_if: "{{candidates_2}}?.emails?.length > 0",
  },
  {
    key: "general_email", name: "General email", kind: "waterfall",
    waterfall: [
      "{{held_usable}} ? {{held_email}}?.email : undefined",
      "{{aiark_email_check}}?.email",
      "{{email_check_1}}?.email",
      "{{email_check_2}}?.email",
    ],
    description: "The inbox already held, else AI Ark's email, else the first search's, else the second's.",
  },
  {
    key: "email_verdict", name: "Email verdict", kind: "formula",
    formula: `{{held_usable}} ? "In the database" : (${WINNER}) ? ((${WINNER}).status === "valid" ? "Valid" : "Catch-all") : undefined`,
  },
  {
    key: "found_by", name: "Found by", kind: "formula",
    formula: `{{held_usable}} ? "database" : {{aiark_email_check}}?.email ? "aiark" : {{email_check_1}}?.email ? "search_1" : {{email_check_2}}?.email ? "search_2" : undefined`,
  },
  {
    key: "email_kind", name: "General or named", kind: "formula",
    formula: `{{general_email}} ? (new RegExp(${JSON.stringify(ROLE_PREFIX_SOURCE)}, "i").test({{general_email}}) ? "General" : "Named") : undefined`,
    description: "General when the address starts the way the lead database's general inboxes do (info@, office@ …), else Named.",
  },
  {
    // A usable email wins over a dead website: AI Ark's head-office email is checked
    // without one, and a company with a checked general email has the data the tab is for.
    key: "company_outcome", name: "Outcome", kind: "formula",
    formula:
      `!{{in_area}} ? "Outside the client's area"` +
      ` : {{rule_match}} ? "Excluded by the client's rules"` +
      ` : {{never_contact}} ? "On the never-contact list"` +
      ` : {{held_usable}} ? "Already in the database"` +
      ` : {{general_email}} ? "Has a general email"` +
      ` : !{{use_website}} ? "No working website"` +
      ` : "No general email found"`,
    description: "Listed on the Companies tab: Has a general email and Already in the database. Every other company is only counted there.",
  },

  // ── Later phases: shown, never run ─────────────────────────────────────
  {
    key: "people_at_company", name: "People at the company", kind: "action", action: "later", phase: 2, provider: "AI Ark",
    run_if: `{{company_outcome}} === "Has a general email" || {{company_outcome}} === "Already in the database"`,
    description: "Phase 2: people at this company, from AI Ark's people search by company id.",
  },
  {
    key: "fit_score", name: "Fit score", kind: "action", action: "later", phase: 3, provider: "OpenAI",
    description: "Phase 3: how well the company fits the client, 1 to 5, from its type, size, description and website.",
  },
  {
    key: "home_office", name: "Home office", kind: "action", action: "later", phase: 3, provider: "OpenAI",
    description: "Phase 3: whether the business runs from a home rather than an office.",
  },
];

/** enrich_columns rows for a template table, positions in order. */
export const COMPANY_COLUMNS = COLUMNS.map((c, i) => ({
  key: c.key,
  name: c.name,
  position: i + 1,
  kind: c.kind,
  action: c.action ?? null,
  formula: c.formula ?? null,
  waterfall: c.waterfall ?? null,
  inputs: c.inputs ?? {},
  config: c.config ?? {},
  run_if: c.run_if ?? null,
  data_type: c.data_type ?? "text",
  description: c.description ?? null,
  provider: c.provider ?? (c.kind === "input" ? "AI Ark" : c.kind === "formula" || c.kind === "waterfall" ? "Formula" : null),
  needs_env: c.needs_env ?? [],
  phase: c.phase ?? 1,
  hidden: c.hidden ?? false,
}));

/** The input keys a pull writes for each company. */
export const COMPANY_INPUT_KEYS = COMPANY_COLUMNS.filter((c) => c.kind === "input").map((c) => c.key);

/** Text a company row is found by in the Clay tab's search box, until the worker adds what it found. */
export const COMPANY_SEARCH_KEYS = ["company", "domain", "website", "phone", "aiark_email"];
