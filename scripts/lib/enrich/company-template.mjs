// What an AI Ark company becomes on the Companies template (company-template-v2.mjs):
// the input cells a pull writes for each company (companyInputs), the text a row
// is found by, and phase 1's lists (directories and junk addresses), which the
// fit keys read too (design 2B.2). Phase 1's own template, companies_v1, its
// prompts and its columns are gone: the pipeline's steps are the original Clay
// columns now (company-template-v2.mjs), and a client with a v1 table is
// refused until the owner decides (D24).
//
// Plain JavaScript so the worker and the Next.js routes share it.

import { clip, sizeText } from "../aiark/client.mjs";
import { OFFICES_MAX, officesOf } from "../aiark/company-filters.mjs";
import { bareDomain } from "./domain.mjs";

export const SOURCE_BOUGHT = "AI Ark pull";
export const SOURCE_COPIED = "Copied from an earlier pull (no charge)";

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

/** Text a company row is found by in the Clay tab's search box, until the worker adds what it found. */
export const COMPANY_SEARCH_KEYS = ["company", "domain", "website", "phone", "aiark_email"];
