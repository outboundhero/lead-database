import type { ValidationResult } from "../types";

// Findymail — SECOND-LAYER verifier, called only when Reoon returns
// catch_all / risky / unknown / error. API key from FINDEMAIL_API_KEY.
//
// ⚠️ VERIFY ONLY — never the email FINDER. We hit exactly one endpoint:
//     POST https://app.findymail.com/api/verify   (checks a given email)
//   and never /api/search/* (which FINDS/appends emails and burns finder
//   credits). This module must not call any other Findymail endpoint.
//
// Live response shape (confirmed against the API):
//     { "email": "...", "verified": true|false, "provider": "Google|Microsoft|..." }
//   It's a binary deliverability check — no catch_all/risky from Findymail:
//     verified === true  → 'valid'
//     verified === false → 'invalid'
//     HTTP/network error → 'invalid' (conservative — don't ship to unverified)

const FINDYMAIL_VERIFY_URL = "https://app.findymail.com/api/verify";

interface FindymailVerifyResponse {
  email?: string;
  verified?: boolean;
  provider?: string;
  [key: string]: unknown;
}

async function verifyOne(email: string, apiKey: string, signal?: AbortSignal): Promise<ValidationResult> {
  try {
    const res = await fetch(FINDYMAIL_VERIFY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ email }),
      signal,
    });
    if (!res.ok) {
      return { email, status: "invalid", provider: "findemail", nativeStatus: "error", raw: { httpStatus: res.status } };
    }
    const json = (await res.json()) as FindymailVerifyResponse;
    const verified = json.verified === true;
    return {
      email,
      status: verified ? "valid" : "invalid",
      provider: "findemail",
      nativeStatus: verified ? "verified" : "unverified",
      raw: json,
    };
  } catch (err) {
    return {
      email,
      status: "invalid",
      provider: "findemail",
      nativeStatus: "error",
      raw: { error: err instanceof Error ? err.message : "unknown error" },
    };
  }
}

export async function validateBatch(
  emails: string[],
  options?: { concurrency?: number; signal?: AbortSignal },
): Promise<ValidationResult[]> {
  const envKey = process.env.FINDEMAIL_API_KEY;
  if (!envKey) {
    throw new Error("FINDEMAIL_API_KEY not configured");
  }
  const apiKey: string = envKey;
  const concurrency = options?.concurrency ?? 8;
  const results: ValidationResult[] = new Array(emails.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < emails.length) {
      const i = nextIdx++;
      const email = emails[i];
      if (!email) {
        // Never leave a hole — the orchestrator indexes results positionally.
        results[i] = { email, status: "invalid", provider: "findemail", nativeStatus: "error", raw: { error: "empty email" } };
        continue;
      }
      results[i] = await verifyOne(email, apiKey, options?.signal);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, emails.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
