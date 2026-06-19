// Classifies a lead as 'general' (role-based / shared inbox) or 'personal' (individual decision-maker).
// Two signals:
//   1. Email Bison exports often label shared contacts with "(general)" in the first/last name
//      or job title field (~75% of OutboundHero's existing data per voice memo)
//   2. Role-prefix detection on the email local part — info@, sales@, support@, etc.
// Caller passes in any of the candidate name/title fields; missing fields are fine.

const ROLE_PREFIXES =
  /^(info|contact|hello|sales|support|admin|team|office|marketing|noreply|no-?reply|mail|careers|hr|jobs|press|media|billing|accounts?|invoices?|enquir(?:y|ies)|inquir(?:y|ies)|hi|help|service|reception|frontdesk|orders|shop|store|web|webmaster|postmaster|abuse)@/i;

// Matches "(general)", "(General Email)", "(general inbox)", "(GENERAL)", etc.
const GENERAL_PAREN = /\(\s*general[^)]*\)/i;

export interface EmailTypeInput {
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  job_title?: string | null;
}

export type EmailType = "general" | "personal";

export function detectEmailType(input: EmailTypeInput): EmailType {
  const { email, first_name, last_name, job_title } = input;

  // "(general)" parenthetical anywhere in name/title
  if (GENERAL_PAREN.test(first_name ?? "")) return "general";
  if (GENERAL_PAREN.test(last_name ?? "")) return "general";
  if (GENERAL_PAREN.test(job_title ?? "")) return "general";

  // Role-based email local part
  if (email && ROLE_PREFIXES.test(email.trim())) return "general";

  return "personal";
}
