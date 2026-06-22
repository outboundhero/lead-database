export interface Lead {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;

  seniority: string | null;
  company: string | null;
  company_size: number | null;
  annual_revenue: number | null;
  general_industry: string | null;
  specific_industry: string | null;
  phone: string | null;
  website: string | null;
  person_linkedin: string | null;
  company_linkedin: string | null;
  source: string | null;
  status: string | null;
  esp: string | null;
  tags: string | null;

  city: string | null;
  state: string | null;
  country: string | null;
  domain: string | null;
  company_overview: string | null;

  // Email-type + validation + bounce (OutboundHero)
  email_type: "general" | "personal" | null;
  validation_status: "valid" | "catch_all" | "invalid" | "pending" | null;
  validation_provider: "reoon" | "findemail" | null;
  validated_at: string | null;
  is_bounced: boolean;
  bounced_at: string | null;
  bounce_source: string | null;

  // Email Bison-native fields
  bison_lead_id: number | null;
  workspace_id: number | null;
  workspace_name: string | null;
  instance_url: string | null;
  notes: string | null;
  bison_status: string | null;
  emails_sent: number | null;
  opens: number | null;
  replies: number | null;
  bounces: number | null;
  unique_replies: number | null;
  unique_opens: number | null;
  address: string | null;
  street: string | null;
  postal_code: string | null;
  question: string | null;
  company_phone: string | null;
  google_maps_url: string | null;

  created_at: string;
  updated_at: string;
}

export interface Company {
  id: string;
  name: string;
  domain: string | null;
  size: string | null;
  annual_revenue: string | null;
  general_industry: string | null;
  specific_industry: string | null;
  overview: string | null;
  linkedin: string | null;
  technologies: string[] | null;
  created_at: string;
}

export interface LeadHistory {
  id: string;
  lead_id: string;
  event_type: "created" | "updated" | "scraped" | "exported";
  changed_fields: Record<string, { old: unknown; new: unknown }> | null;
  performed_by: string | null;
  performed_by_name: string | null;
  notes: string | null;
  created_at: string;
}

export interface UploadBatch {
  id: string;
  uploaded_by: string | null;
  filename: string | null;
  total_rows: number | null;
  processed_rows: number;
  skipped_rows: number;
  merged_rows: number;
  replaced_rows: number;
  status: "pending" | "processing" | "complete" | "error";
  error_log: Record<string, unknown> | null;
  created_at: string;
  completed_at: string | null;
}

export interface ExportJob {
  id: string;
  requested_by: string | null;
  filters_used: Record<string, unknown> | null;
  selected_ids: string[] | null;
  column_selection: string[] | null;
  row_count: number | null;
  status: "pending" | "processing" | "complete" | "error";
  file_path: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ApiToken {
  id: string;
  user_id: string | null;
  name: string;
  token: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
}

export interface ApiLog {
  id: string;
  token_id: string | null;
  token_name: string | null;
  method: string;
  endpoint: string;
  status_code: number;
  response_count: number | null;
  ip_address: string | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface AuditLog {
  id: string;
  action: string;
  performed_by: string | null;
  details: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface FilterPreset {
  id: string;
  user_id: string | null;
  name: string;
  filters: Record<string, unknown>;
  is_shared: boolean;
  created_at: string;
}

export interface DashboardStats {
  total_leads: number;
  general: number;
  personal: number;
  bounced: number;
  valid: number;
  by_state: Array<{ state: string; count: number }>;
  by_esp: Array<{ esp: string; count: number }>;
  by_email_type: Array<{ type: string; count: number }>;
  by_workspace: Array<{ workspace: string; count: number }>;
  by_validation: Array<{ status: string; count: number }>;
  engagement: { emails_sent: number; opens: number; replies: number; bounces: number };
  leads_over_time: Array<{ date: string; count: number }>;
}

export interface DashboardSnapshot {
  id: string;
  snapshot_date: string;
  total_leads: number | null;
  stats: DashboardStats | null;
  created_at: string;
}

// Source values (matches actual DB values after normalization)
export { LEAD_SOURCES } from "@/lib/filters/constants";

export const COMPANY_SIZE_BUCKETS = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5000+",
] as const;

export const REVENUE_BUCKETS = [
  "<$1M",
  "$1M-$10M",
  "$10M-$50M",
  "$50M-$100M",
  "$100M-$500M",
  "$500M+",
] as const;

export const ESP_VALUES = ["google", "microsoft", "other"] as const;
