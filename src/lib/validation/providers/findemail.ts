import type { ValidationResult } from "../types";

// FindEmail (Findymail) — fallback provider, called only when Reoon returns
// inconclusive / errors. Per-email API. API key from FINDEMAIL_API_KEY env.
//
// Endpoint shape (Findymail public verify endpoint):
//   POST https://app.findymail.com/api/verify
//   Authorization: Bearer <token>
//   Body: { email: "foo@bar" }
//
// Status mapping:
//   valid / verified / safe          → 'valid'
//   catch_all / accept_all / risky   → 'catch_all'
//   invalid / disposable             → 'invalid'
//   unknown / null                   → 'invalid'  (don't escalate further — Reoon already tried)
//
// Always treats network errors as 'invalid' (conservative: don't ship to a
// possibly-bad address when both providers failed).

const FINDEMAIL_URL = "https://app.findymail.com/api/verify";

interface FindEmailResponse {
  status?: string;
  result?: string;
  valid?: boolean;
  catch_all?: boolean;
  [key: string]: unknown;
}

function mapStatus(resp: FindEmailResponse): "valid" | "catch_all" | "invalid" {
  const s = (resp.status ?? resp.result ?? "").toString().toLowerCase();
  if (resp.catch_all === true || s === "catch_all" || s === "accept_all" || s === "risky") {
    return "catch_all";
  }
  if (resp.valid === true || s === "valid" || s === "verified" || s === "safe") {
    return "valid";
  }
  return "invalid";
}

async function verifyOne(email: string, apiKey: string, signal?: AbortSignal): Promise<ValidationResult> {
  try {
    const res = await fetch(FINDEMAIL_URL, {
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
      return {
        email,
        status: "invalid",
        provider: "findemail",
        raw: { httpStatus: res.status },
      };
    }
    const json = (await res.json()) as FindEmailResponse;
    return { email, status: mapStatus(json), provider: "findemail", raw: json };
  } catch (err) {
    return {
      email,
      status: "invalid",
      provider: "findemail",
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
