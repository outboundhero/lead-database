// Validation orchestrator: Reoon (primary) → Findymail (second layer).
//
// Escalation rule (client spec): Findymail is called ONLY when Reoon's native
// status is catch_all / risky / unknown (or Reoon errored). Reoon 'valid' and
// 'invalid'/'disposable'/'spamtrap' are terminal — no Findymail credit spent.
// Findymail is verify-only (never the finder). See providers/*.ts.
//
// Persists results into leads.validation_status / validation_provider /
// validated_at / validation_response. Updates a validation_jobs row with live
// progress so the export UI can poll for "X of Y validated, N credits used".
//
// Designed to be called inline from /api/exports/stream BEFORE the streaming
// loop starts — so by the time fn_export_leads runs, every matching lead has
// a non-NULL validation_status and the export RPC's hard gate
// (validation_status IN ('valid','catch_all') AND is_bounced = false) excludes
// invalid rows naturally.

import { createAdminClient } from "@/lib/supabase/admin";
import * as reoon from "./providers/reoon";
import * as findemail from "./providers/findemail";
import type { ValidationResult } from "./types";

interface LeadToValidate {
  id: string;
  email: string;
}

interface ValidateOptions {
  batchSize?: number;          // default 100, override via VALIDATION_BATCH_SIZE
  onProgress?: (done: number, creditsUsed: number) => void | Promise<void>;
  signal?: AbortSignal;
}

interface ValidateOutcome {
  total: number;
  validated: number;            // total rows whose status was updated (incl. invalid)
  creditsUsed: number;
  errors: number;
}

function batchSize(opt?: number): number {
  if (opt && opt > 0) return opt;
  const env = process.env.VALIDATION_BATCH_SIZE;
  const n = env ? parseInt(env, 10) : NaN;
  return !isNaN(n) && n > 0 ? n : 100;
}

export function isValidationEnabled(): boolean {
  return !!process.env.REOON_API_KEY;
}

export async function validateLeads(
  leads: LeadToValidate[],
  options: ValidateOptions = {},
): Promise<ValidateOutcome> {
  if (leads.length === 0) {
    return { total: 0, validated: 0, creditsUsed: 0, errors: 0 };
  }
  if (!isValidationEnabled()) {
    // Gracefully no-op when no API key is configured (dev convenience).
    return { total: leads.length, validated: 0, creditsUsed: 0, errors: 0 };
  }

  const size = batchSize(options.batchSize);
  const admin = createAdminClient();

  let totalDone = 0;
  let totalCredits = 0;
  let totalErrors = 0;

  for (let i = 0; i < leads.length; i += size) {
    if (options.signal?.aborted) break;
    const batch = leads.slice(i, i + size);
    const emails = batch.map((b) => b.email);

    // Reoon first
    let reoonResults: ValidationResult[];
    try {
      reoonResults = await reoon.validateBatch(emails, { signal: options.signal });
    } catch (err) {
      console.error("Reoon batch failed:", err);
      // Synthesize per-email results with nativeStatus 'error' so they both
      // escalate to Findymail and — if that layer is unavailable too — hit the
      // persist-loop skip below and stay unwritten for retry. (Rows Findymail
      // rescues aren't errors; the persist loop counts the rest.)
      reoonResults = emails.map((email) => ({
        email,
        status: null,
        provider: "reoon" as const,
        nativeStatus: "error",
        raw: { error: err instanceof Error ? err.message : "unknown" },
      }));
    }
    // Credits: count only genuinely parsed provider responses — HTTP failures
    // (raw {httpStatus:...}) and network errors (raw {error:...}) spend nothing.
    totalCredits += reoonResults.filter((r) => r && r.nativeStatus !== "error").length;

    // Escalate to Findymail only for Reoon's uncertain verdicts (catch_all /
    // risky / unknown) and Reoon errors — NOT for a clean valid/invalid.
    const FALLBACK_STATUSES = new Set(["catch_all", "risky", "unknown", "error"]);
    const inconclusive = reoonResults
      .map((r, idx) => ({ r, idx }))
      // `r &&` guards a hole in the provider's results array (defensive).
      .filter(({ r }) => r && FALLBACK_STATUSES.has(r.nativeStatus ?? "unknown"));

    const finalResults: ValidationResult[] = [...reoonResults];

    if (inconclusive.length > 0 && process.env.FINDEMAIL_API_KEY) {
      const fallbackEmails = inconclusive.map(({ r }) => r.email);
      try {
        const findResults = await findemail.validateBatch(fallbackEmails, { signal: options.signal });
        totalCredits += findResults.filter((r) => r && r.nativeStatus !== "error").length;
        findResults.forEach((fr, j) => {
          finalResults[inconclusive[j].idx] = fr;
        });
      } catch (err) {
        console.error("Findymail second-layer failed:", err);
        totalErrors += inconclusive.length;
      }
    }

    // Persist: bulk-update by (id, status, provider, raw) — use individual
    // updates batched in a Promise.all since Supabase JS doesn't support
    // multi-row UPDATE WITH different values in one call.
    const now = new Date().toISOString();
    await Promise.all(
      finalResults.map((r, j) => {
        const id = batch[j].id;
        // A genuine provider outage (both layers errored) is left UNWRITTEN so
        // the lead keeps its prior status and is re-picked next export — a
        // transient blip must never permanently mark a real lead invalid.
        // (`!r` guards a hole in a provider's results array.)
        if (!r || r.nativeStatus === "error") {
          totalErrors++;
          return Promise.resolve();
        }
        // status null = inconclusive verdict the Findymail layer never resolved
        // (no FINDEMAIL_API_KEY, or the layer threw). Persist the native
        // 'risky'/'unknown' rather than falsely downgrading to 'invalid'. The
        // export gate (validation_status IN ('valid','catch_all') OR IS NULL)
        // still keeps these rows out of exports; they re-validate after the
        // 45-day TTL instead of being written off.
        const persistedStatus = r.status ?? (r.nativeStatus === "risky" ? "risky" : "unknown");
        return admin
          .from("leads")
          .update({
            validation_status: persistedStatus,
            validation_provider: r.provider,
            validated_at: now,
            validation_response: r.raw as Record<string, unknown> | null,
          })
          .eq("id", id);
      }),
    );

    totalDone += batch.length;
    if (options.onProgress) await options.onProgress(totalDone, totalCredits);
  }

  return {
    total: leads.length,
    validated: totalDone,
    creditsUsed: totalCredits,
    errors: totalErrors,
  };
}
