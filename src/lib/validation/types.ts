// Shared types for the email validation service layer.
//
// Two-step gate at export time:
//   1. Find leads whose validation_status is NULL or older than VALIDATION_REVALIDATE_DAYS
//   2. Run them through Reoon (primary) → FindEmail (fallback)
//   3. Persist status + provider + timestamp + raw response
//   4. fn_export_leads enforces validation_status IN ('valid','catch_all') AND is_bounced = false

export type ValidationStatus = "valid" | "catch_all" | "invalid" | "pending";
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
