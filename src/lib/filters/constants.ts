export const LEAD_SOURCES = [
  "Apollo",
  "Claygent",
  "Google Maps",
  "LeadRocks",
  "Leadswift",
  "Pitchbook",
  "Reoon",
  "Sales Nav",
  "upload",
  "ZoomInfo",
] as const;

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

export const ESP_VALUES = [
  "Google",
  "Microsoft / Outlook",
  "Yahoo",
  "Zoho",
  "GoDaddy",
  "Amazon Web Services",
  "Apple",
  "Rackspace",
  "OVH",
  "IONOS",
  "Proofpoint",
  "Mimecast",
  "Barracuda",
  "Cisco",
  "FastMail",
  "Namecheap",
  "Mail.ru",
  "Yandex",
  "Tencent",
  "SiteGround",
  "One.com",
  "Open-Xchange",
  "Strato",
  "Gandi",
  "Beget",
  "Tucows",
  "123 Reg",
  "Custom Mail Server",
  "Other",
  "Not Found",
] as const;

export const SENIORITY_LEVELS = [
  "c_suite",
  "vp",
  "director",
  "manager",
] as const;

export const SENIORITY_LABELS: Record<string, string> = {
  c_suite: "C-Suite",
  vp: "VP",
  director: "Director",
  manager: "Manager",
};
