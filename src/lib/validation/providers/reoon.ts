import type { ValidationResult, ValidationStatus } from "../types";

// Reoon email verification — PRIMARY provider.
//
// Uses the single-email endpoint in POWER mode (real SMTP mailbox check) inside
// a concurrency pool. Power mode is required for a meaningful deliverability
// gate: quick mode only checks syntax+MX and returns "valid" for non-existent
// mailboxes (e.g. a fake @gmail address), which would never trigger the
// Findymail second layer. Override with REOON_MODE if ever needed.
//
// The orchestrator (validate-leads.ts) reads `nativeStatus` and escalates to
// Findymail only for catch_all / risky / unknown / error. This provider reports
// the native status verbatim plus a provisional terminal status:
//   valid                            → 'valid'
//   invalid / disposable / spamtrap  → 'invalid'
//   catch_all / accept_all           → 'catch_all'  (native still drives escalation)
//   risky / unknown / other          → null         (native drives escalation)
//
// Endpoint: GET https://emailverifier.reoon.com/api/v1/verify/?email=..&key=..&mode=power

const REOON_BASE = "https://emailverifier.reoon.com/api/v1/verify/";
const MODE = process.env.REOON_MODE || "power";

interface ReoonResponse {
  status?: string;
  is_safe_to_send?: boolean;
  is_deliverable?: boolean;
  is_catch_all?: boolean;
  is_disposable?: boolean;
  is_role_account?: boolean;
  [key: string]: unknown;
}

function mapStatus(resp: ReoonResponse): { status: ValidationStatus | null; native: string } {
  const s = (resp.status ?? "").toString().toLowerCase().trim();
  switch (s) {
    case "valid":
    case "safe":
    case "safe_to_send":
      return { status: "valid", native: "valid" };
    case "invalid":
      return { status: "invalid", native: "invalid" };
    case "disposable":
      return { status: "invalid", native: "disposable" };
    case "spamtrap":
      return { status: "invalid", native: "spamtrap" };
    case "catch_all":
    case "accept_all":
    case "acceptable":
      return { status: "catch_all", native: "catch_all" };
    case "risky":
      return { status: null, native: "risky" };
    case "unknown":
    case "":
      return { status: null, native: "unknown" };
    default:
      return { status: null, native: s || "unknown" };
  }
}

async function verifyOne(email: string, apiKey: string, signal?: AbortSignal): Promise<ValidationResult> {
  const url = `${REOON_BASE}?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=${encodeURIComponent(MODE)}`;
  try {
    const res = await fetch(url, { method: "GET", signal });
    if (!res.ok) {
      return { email, status: null, provider: "reoon", nativeStatus: "error", raw: { httpStatus: res.status } };
    }
    const json = (await res.json()) as ReoonResponse;
    const { status, native } = mapStatus(json);
    return { email, status, provider: "reoon", nativeStatus: native, raw: json };
  } catch (err) {
    return {
      email,
      status: null,
      provider: "reoon",
      nativeStatus: "error",
      raw: { error: err instanceof Error ? err.message : "unknown error" },
    };
  }
}

export async function validateBatch(
  emails: string[],
  options?: { concurrency?: number; signal?: AbortSignal },
): Promise<ValidationResult[]> {
  const envKey = process.env.REOON_API_KEY;
  if (!envKey) {
    throw new Error("REOON_API_KEY not configured");
  }
  const apiKey: string = envKey;
  // Power mode is SMTP-bound (~3s/email); concurrency hides the latency.
  const concurrency = options?.concurrency ?? parseInt(process.env.REOON_CONCURRENCY ?? "12", 10);
  const results: ValidationResult[] = new Array(emails.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < emails.length) {
      const i = nextIdx++;
      const email = emails[i];
      if (!email) continue;
      results[i] = await verifyOne(email, apiKey, options?.signal);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, emails.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
