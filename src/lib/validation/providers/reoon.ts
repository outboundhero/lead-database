import type { ValidationResult } from "../types";

// Reoon email verification — primary provider.
//
// Reoon offers both single and bulk endpoints. We use the single-email "instant"
// endpoint inside a small concurrency pool (5 in-flight at a time per batch) —
// it's the most reliable across plan tiers and avoids the async-task polling
// model the bulk endpoint uses, which adds latency.
//
// Status mapping (per Reoon docs):
//   valid / safe / safe_to_send  → 'valid'
//   catch_all / accept_all       → 'catch_all'
//   invalid / disposable / role / unknown / risky → 'invalid'
//   anything else / network err  → null (orchestrator will fall back to FindEmail)
//
// Endpoint shape:
//   GET https://emailverifier.reoon.com/api/v1/verify/?email=foo@bar&key=XXX&mode=quick
//
// API key comes from process.env.REOON_API_KEY.

const REOON_BASE = "https://emailverifier.reoon.com/api/v1/verify/";

interface ReoonSingleResponse {
  status?: string;
  is_safe_to_send?: boolean;
  is_disposable?: boolean;
  is_role_account?: boolean;
  smtp_check?: string;
  [key: string]: unknown;
}

function mapStatus(resp: ReoonSingleResponse): "valid" | "catch_all" | "invalid" | null {
  const s = (resp.status ?? "").toString().toLowerCase();
  switch (s) {
    case "valid":
    case "safe":
    case "safe_to_send":
      return "valid";
    case "catch_all":
    case "accept_all":
    case "acceptable":
      return "catch_all";
    case "invalid":
    case "disposable":
    case "role":
    case "risky":
      return "invalid";
    case "unknown":
    case "":
      return null;
    default:
      return null;
  }
}

async function verifyOne(email: string, apiKey: string, signal?: AbortSignal): Promise<ValidationResult> {
  const url = `${REOON_BASE}?email=${encodeURIComponent(email)}&key=${encodeURIComponent(apiKey)}&mode=quick`;
  try {
    const res = await fetch(url, { method: "GET", signal });
    if (!res.ok) {
      return { email, status: null, provider: "reoon", raw: { httpStatus: res.status } };
    }
    const json = (await res.json()) as ReoonSingleResponse;
    return { email, status: mapStatus(json), provider: "reoon", raw: json };
  } catch (err) {
    return {
      email,
      status: null,
      provider: "reoon",
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
  const concurrency = options?.concurrency ?? 5;
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
