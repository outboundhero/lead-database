export interface LeadField {
  key: string;
  label: string;
  aliases: string[];
}

// Rows per no-email download part (client works in Clay, whose CSV limit is
// 50k rows; asked for ≤45k, 49,999 keeps the part count minimal). Shared by
// the holdbacks route and the UI links so the part maths never diverges.
export const HOLDBACK_PART_SIZE = 49_999;

// Cell values that mean "nothing here". Dropped from incoming rows and treated
// as blank in the database by the merge (1,773,590 leads carry company_phone =
// 'there', Bison's template fallback; 11,279 carry '--').
export const BLANKISH_VALUES = ["", "--", "-", "there", "#ERROR!", "N/A", "n/a", "NA", "null", "NULL", "None", "none"];
const BLANKISH_SET = new Set(BLANKISH_VALUES.map((v) => v.toLowerCase()));
export const isBlankish = (v: unknown): boolean => v == null || BLANKISH_SET.has(String(v).trim().toLowerCase());

// The seven ESP labels Bison writes (the ESP chip matches exactly, the Mimecast
// default exclusion and espBucket() depend on them). A file's own ESP column is
// folded onto these; anything unrecognised is dropped so the MX lookup fills it.
const ESP_LABELS: Array<[RegExp, string]> = [
  [/mimecast/i, "Mimecast"],
  [/pphosted|proofpoint/i, "Proofpoint"],
  [/barracuda/i, "Barracuda"],
  [/google|gmail|g ?suite|workspace/i, "Google"],
  [/outlook|office ?365|o365|microsoft|exchange|hotmail/i, "Microsoft"],
  [/zoho/i, "Zoho"],
  [/^(custom|other|self.?hosted|private)$/i, "Custom"],
];
export function normalizeEspLabel(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  for (const [re, label] of ESP_LABELS) if (re.test(v)) return label;
  return null;
}

// Canonical field set — only the fields present in the Email Bison CSV export
// (plus OutboundHero product fields: source, esp, email_type). Anything not here
// is intentionally excluded so the app surfaces only data we actually have.
export const LEAD_FIELDS: LeadField[] = [
  { key: "email", label: "Email", aliases: ["email", "email_address", "e-mail", "e_mail"] },
  { key: "first_name", label: "First Name", aliases: ["first_name", "firstname", "first name", "fname"] },
  { key: "last_name", label: "Last Name", aliases: ["last_name", "lastname", "last name", "lname", "surname"] },
  { key: "title", label: "Title", aliases: ["title", "job_title", "jobtitle", "job title", "position"] },
  { key: "company", label: "Company", aliases: ["company", "company_name", "company_name_raw", "companyname", "company name", "organization"] },
  { key: "source", label: "Source", aliases: ["source", "lead_source", "data_source"] },
  { key: "esp", label: "ESP", aliases: ["esp", "email_provider", "email_service_provider"] },
  { key: "category", label: "Category", aliases: ["category", "business_category", "industry_category"] },
  { key: "subcategory", label: "Subcategory", aliases: ["subcategory", "sub_category", "sub category"] },
  { key: "additional_category", label: "Additional Category", aliases: ["additional_category", "additional category", "additional categories"] },
  { key: "email_type", label: "Email Type", aliases: ["email_type", "type"] },
  { key: "city", label: "City", aliases: ["city", "locality"] },
  { key: "state", label: "State", aliases: ["state", "province", "region"] },
  { key: "domain", label: "Domain", aliases: ["domain", "company_domain", "email_domain"] },
  { key: "address", label: "Address", aliases: ["address", "full_address", "street_address"] },
  { key: "street", label: "Street", aliases: ["street", "street_line"] },
  { key: "postal_code", label: "ZIP / Postal Code", aliases: ["postal_code", "zip", "zipcode", "zip_code", "postcode"] },
  { key: "company_phone", label: "Company Phone", aliases: ["company_phone", "company phone", "business_phone"] },
  { key: "google_maps_url", label: "Google Maps URL", aliases: ["google_maps_url", "google maps url", "maps_url", "gmaps"] },
  { key: "question", label: "Personalization Question", aliases: ["question", "custom_question", "personalization"] },
  { key: "notes", label: "Notes", aliases: ["notes", "note"] },
  { key: "tags", label: "Tags", aliases: ["tags", "tag", "comma separated tags", "keywords", "keyword"] },
  // Deliverability (OutboundHero)
  { key: "category_source", label: "Category Source", aliases: ["category_source"] },
  { key: "category_confidence", label: "Category Confidence", aliases: ["category_confidence"] },
  { key: "validation_status", label: "Validation Status", aliases: ["validation_status"] },
  { key: "is_bounced", label: "Bounced", aliases: ["is_bounced", "bounced"] },
  // Engagement (Email Bison)
  { key: "workspace_name", label: "Workspace", aliases: ["workspace_name", "workspace name", "workspace"] },
  { key: "emails_sent", label: "Emails Sent", aliases: ["emails_sent", "emails sent", "sent"] },
  { key: "opens", label: "Opens", aliases: ["opens"] },
  { key: "replies", label: "Replies", aliases: ["replies"] },
  { key: "bounces", label: "Bounces", aliases: ["bounces"] },
  { key: "created_at", label: "Created Date", aliases: ["created_at", "created_date", "created"] },
  { key: "updated_at", label: "Last Updated Date", aliases: ["updated_at", "updated_date", "last_updated"] },
];

export function autoMatchField(csvHeader: string): string | null {
  const normalized = csvHeader.toLowerCase().trim().replace(/[\s-]+/g, "_");
  for (const field of LEAD_FIELDS) {
    if (field.aliases.some((a) => a.replace(/[\s-]+/g, "_") === normalized)) {
      return field.key;
    }
  }
  return null;
}
