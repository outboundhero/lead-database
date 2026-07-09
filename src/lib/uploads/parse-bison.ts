// Email Bison CSV import.
//
// A Bison export has a fixed column set plus a `custom_variables` column holding a
// JSON array of {name, value} pairs (city, state, domain, address, question, etc.).
// The generic field-mapper (one CSV column -> one DB field) can't unpack that JSON
// into multiple columns, so Bison rows take this dedicated path instead.
//
// What this does per row:
//   - Direct map: first_name, last_name, email, title, company, notes, created_at, updated_at
//   - Unpack custom_variables JSON -> city, state (normalized), domain, address,
//     question, company_phone, google_maps_url
//   - Map "comma separated tags" -> tags column AND derive esp (Bison tags ARE the ESP:
//     "Outlook", "Google", "Custom Mail Server", etc.)
//   - Engagement ints: emails_sent, opens, replies, bounces, unique_replies, unique_opens
//   - Bison identity: bison_lead_id, workspace_id, workspace_name, instance_url, bison_status
//   - source = 'Email Bison'
//   - bounces > 0  -> is_bounced=true, bounce_source='emailbison_csv'
//   - email_type   -> general | personal (via detectEmailType)

import { detectEmailType } from "./detect-email-type";
import { normalizeStateValue } from "./geography";

const BISON_REQUIRED_HEADERS = ["lead id", "workspace id", "custom_variables"];

/** True when the CSV header row looks like an Email Bison export. */
export function detectBisonFormat(headers: string[]): boolean {
  const lower = headers.map((h) => h.trim().toLowerCase());
  return BISON_REQUIRED_HEADERS.every((h) => lower.includes(h));
}

// Tag values Bison emits that are really ESP labels.
const ESP_TAGS: Record<string, string> = {
  outlook: "Microsoft",
  microsoft: "Microsoft",
  "office 365": "Microsoft",
  google: "Google",
  "google workspace": "Google",
  gmail: "Google",
  yahoo: "Yahoo",
  "custom mail server": "Custom",
  zoho: "Zoho",
  proofpoint: "Proofpoint",
  mimecast: "Mimecast",
  barracuda: "Barracuda",
};

function parseInt0(v: string | undefined): number {
  const n = parseInt((v ?? "").trim(), 10);
  return isNaN(n) ? 0 : n;
}

interface BisonCustomVar {
  name?: string;
  value?: string;
}

function parseCustomVariables(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || !raw.trim()) return out;
  try {
    const arr = JSON.parse(raw) as BisonCustomVar[];
    if (!Array.isArray(arr)) return out;
    for (const item of arr) {
      if (item && typeof item.name === "string" && typeof item.value === "string") {
        out[item.name.trim().toLowerCase()] = item.value.trim();
      }
    }
  } catch {
    // malformed JSON — skip, don't fail the row
  }
  return out;
}

/**
 * Transform one Bison CSV row into a leads-table object.
 * Returns null if there's no usable email.
 */
export function normalizeBisonRow(
  row: string[],
  headers: string[],
): Record<string, unknown> | null {
  // header(lowercased+trimmed) -> column index
  const idx: Record<string, number> = {};
  headers.forEach((h, i) => {
    idx[h.trim().toLowerCase()] = i;
  });
  const get = (name: string): string | undefined => {
    const i = idx[name];
    return i === undefined ? undefined : row[i]?.trim();
  };

  const email = get("email")?.toLowerCase();
  if (!email) return null;

  const lead: Record<string, unknown> = {};
  lead.email = email;

  const firstName = get("first_name");
  const lastName = get("last_name");
  const title = get("title");
  const company = get("company");
  const notes = get("notes");

  if (firstName) lead.first_name = firstName;
  if (lastName) lead.last_name = lastName;
  if (title) lead.title = title;
  if (company) lead.company = company;
  if (notes) lead.notes = notes;

  // Bison identity / workspace
  const bisonLeadId = parseInt((get("lead id") ?? "").trim(), 10);
  if (!isNaN(bisonLeadId)) lead.bison_lead_id = bisonLeadId;
  const wsId = parseInt((get("workspace id") ?? "").trim(), 10);
  if (!isNaN(wsId)) lead.workspace_id = wsId;
  const wsName = get("workspace name");
  if (wsName) lead.workspace_name = wsName;
  const instanceUrl = get("instance_url");
  if (instanceUrl) lead.instance_url = instanceUrl;
  const bisonStatus = get("status");
  if (bisonStatus) lead.bison_status = bisonStatus;

  // Engagement
  lead.emails_sent = parseInt0(get("emails_sent"));
  lead.opens = parseInt0(get("opens"));
  lead.replies = parseInt0(get("replies"));
  lead.unique_replies = parseInt0(get("unique_replies"));
  lead.unique_opens = parseInt0(get("unique_opens"));
  const bounces = parseInt0(get("bounces"));
  lead.bounces = bounces;

  // Tags -> tags column + derive esp
  const tags = get("comma separated tags");
  if (tags) {
    lead.tags = tags;
    // tag may be comma-separated; first recognizable ESP wins
    for (const t of tags.split(",").map((s) => s.trim().toLowerCase())) {
      if (ESP_TAGS[t]) {
        lead.esp = ESP_TAGS[t];
        break;
      }
    }
  }

  // custom_variables JSON -> flattened columns. The source uses the literal
  // placeholder "there" (and occasionally "null"/"n/a") for missing values, so
  // filter those out rather than storing junk.
  const cv = parseCustomVariables(get("custom_variables"));
  const clean = (v: string | undefined): string | undefined => {
    if (!v) return undefined;
    const t = v.trim();
    const low = t.toLowerCase();
    if (!t || low === "there" || low === "null" || low === "n/a" || low === "none") return undefined;
    return t;
  };
  if (clean(cv.city)) lead.city = cv.city;
  if (clean(cv.state)) lead.state = normalizeStateValue(cv.state) ?? cv.state;
  if (clean(cv.domain)) lead.domain = cv.domain;
  if (clean(cv.address)) {
    lead.address = cv.address;
    // ~43% of addresses are full street addresses ("123 Main St, City, ST 12345").
    // Pull out ZIP + street; "City, State"-only addresses yield nothing here.
    const addr = cv.address.trim();
    const zip = addr.match(/\b\d{5}(?:-\d{4})?\b/);
    if (zip) lead.postal_code = zip[0];
    if (/^\s*\d/.test(addr)) lead.street = addr.split(",")[0].trim();
  }
  if (clean(cv.question)) lead.question = cv.question;
  if (clean(cv["company phone"])) lead.company_phone = cv["company phone"];
  if (clean(cv["google maps url"])) lead.google_maps_url = cv["google maps url"];

  // Bison-native category enrichment (client adds these as personalization
  // variables and enriches inside Bison; we just ingest). Variable names may
  // vary slightly per workspace, so match common spellings.
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = clean(cv[k]);
      if (v) return v;
    }
    return undefined;
  };
  const cvCategory = pick("category", "business category");
  const cvSubcategory = pick("subcategory", "sub category", "sub_category");
  const cvAdditional = pick("additional category", "additional_category", "additional categories");
  if (cvCategory) {
    lead.category = cvCategory;
    lead.category_source = "bison";
    lead.category_confidence = 1;
    lead.categorized_at = new Date().toISOString();
  }
  if (cvSubcategory) lead.subcategory = cvSubcategory;
  if (cvAdditional) lead.additional_category = cvAdditional;

  // Timestamps (Bison provides them; fall back to DB defaults if absent)
  const createdAt = get("created_at");
  const updatedAt = get("updated_at");
  if (createdAt) lead.created_at = createdAt;
  if (updatedAt) lead.updated_at = updatedAt;

  // Derived fields
  lead.source = "Email Bison";
  // Set is_bounced explicitly (not just when true) so bulk upserts that union
  // keys across rows never write NULL into this NOT NULL column.
  lead.is_bounced = bounces > 0;
  if (bounces > 0) {
    lead.bounce_source = "emailbison_csv";
    lead.bounced_at = new Date().toISOString();
  }
  lead.email_type = detectEmailType({
    email,
    first_name: firstName,
    last_name: lastName,
    job_title: title,
  });

  return lead;
}
