export interface LeadField {
  key: string;
  label: string;
  aliases: string[];
}

export const LEAD_FIELDS: LeadField[] = [
  { key: "email", label: "Email", aliases: ["email", "email_address", "e-mail", "e_mail"] },
  { key: "first_name", label: "First Name", aliases: ["first_name", "firstname", "first name", "fname"] },
  { key: "last_name", label: "Last Name", aliases: ["last_name", "lastname", "last name", "lname", "surname"] },
  { key: "job_title", label: "Job Title", aliases: ["job_title", "jobtitle", "title", "job title", "position"] },
  { key: "seniority", label: "Seniority", aliases: ["seniority", "seniority_level", "level"] },
  { key: "company_name_raw", label: "Company Name", aliases: ["company_name", "company_name_raw", "company", "companyname", "company name", "organization"] },
  { key: "company_size", label: "Company Size", aliases: ["company_size", "employees", "num_employees", "employee_count", "company size", "headcount"] },
  { key: "annual_revenue", label: "Annual Revenue", aliases: ["annual_revenue", "revenue", "annual revenue", "yearly_revenue"] },
  { key: "general_industry", label: "General Industry", aliases: ["general_industry", "industry", "general industry", "sector"] },
  { key: "specific_industry", label: "Specific Industry", aliases: ["specific_industry", "sub_industry", "specific industry", "niche"] },
  { key: "phone", label: "Phone", aliases: ["phone_number", "phone", "phone number", "telephone", "mobile"] },
  { key: "website", label: "Website", aliases: ["website", "url", "web", "site", "company_website"] },
  { key: "person_linkedin", label: "LinkedIn (Person)", aliases: ["person_linkedin", "linkedin", "linkedin_url", "personal_linkedin", "linkedin url"] },
  { key: "company_linkedin", label: "LinkedIn (Company)", aliases: ["company_linkedin", "company_linkedin_url"] },
  { key: "source", label: "Source", aliases: ["source", "lead_source", "data_source"] },
  { key: "status", label: "Status", aliases: ["status", "lead_status"] },
  { key: "esp", label: "ESP", aliases: ["esp", "email_provider", "email_service_provider"] },
  { key: "city", label: "City", aliases: ["city", "locality"] },
  { key: "state", label: "State", aliases: ["state", "province", "region"] },
  { key: "country", label: "Country", aliases: ["country", "nation", "country_code"] },
  { key: "domain", label: "Domain", aliases: ["domain", "company_domain", "email_domain"] },
  { key: "company_overview", label: "Company Overview", aliases: ["company_overview", "company_description", "description", "about", "overview", "bio"] },
  { key: "keywords", label: "Keywords", aliases: ["keywords", "keyword", "tags"] },
  { key: "technologies", label: "Technologies", aliases: ["technologies", "tech_stack", "tools", "tech"] },
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
