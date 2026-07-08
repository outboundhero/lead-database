export interface LeadField {
  key: string;
  label: string;
  aliases: string[];
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
