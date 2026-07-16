// Shared types for the email validation service layer.
//
// Two-step gate at export time:
//   1. Find leads whose validation_status is NULL or older than VALIDATION_REVALIDATE_DAYS
//   2. Run them through Reoon (primary) → FindEmail (fallback)
//   3. Persist status + provider + timestamp + raw response
//   4. fn_export_leads enforces validation_status IN ('valid','catch_all') AND is_bounced = false

// 'risky' | 'unknown' are inconclusive verdicts persisted when the Findymail
// second layer can't resolve them (no FINDEMAIL_API_KEY / layer failed). The
// export gate (validation_status IN ('valid','catch_all') OR IS NULL) excludes
// them from exports; they re-validate after the TTL. Requires the widened
// leads_validation_status_check constraint.
export type ValidationStatus = "valid" | "catch_all" | "invalid" | "pending" | "risky" | "unknown";
export type ValidationProvider = "reoon" | "findemail";

export interface ValidationResult {
  email: string;
  status: ValidationStatus | null; // null = provider returned inconclusive, caller should fall back
  provider: ValidationProvider;
  // Provider-native status (lowercased) the orchestrator uses to decide whether
  // to escalate to Findymail. Reoon: valid|invalid|catch_all|disposable|
  // spamtrap|risky|unknown|error. Findymail: verified|unverified.
  nativeStatus?: string;
  raw: unknown;
}

export interface ProviderError {
  email: string;
  error: string;
  provider: ValidationProvider;
}

export interface ValidationProgress {
  total: number;
  completed: number;
  creditsUsed: number;
  status: "pending" | "running" | "complete" | "error" | "cancelled";
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}
