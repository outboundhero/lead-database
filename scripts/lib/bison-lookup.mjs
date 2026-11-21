// Looking a lead up in Bison by email address. Used by scripts/push-worker.mjs,
// tested by scripts/test-bison-lookup.mts.
//
// Why (2026-11-21). Bison's GET /api/leads/{id-or-email} reads a path that
// starts with digits as a numeric lead id: GET /api/leads/360abc@example.com
// returns lead #360, someone else. The worker's email check then never matches,
// a create answers "taken", and the item failed with "exists in Bison but could
// not be fetched by email": 831 of the 832 failures of the 20 Nov re-run of
// nine clients (887,021 leads), whose emails started with a digit (the last one
// started with "/"). GET /api/leads?search=<email> finds the right lead, with
// its lead_campaign_data, in ~0.2 s (measured 2026-11-21).

/** True when the direct route cannot be trusted for this address: it does not start with a letter. */
export function directLookupUnsafe(email) {
  return /^[^a-z]/i.test(String(email ?? "").trim());
}

/** The row whose email is exactly this address (any case, trimmed), or null. */
export function exactEmailMatch(rows, email) {
  const want = String(email ?? "").trim().toLowerCase();
  if (!want) return null;
  return (Array.isArray(rows) ? rows : []).find(
    (x) => x && x.id != null && String(x.email ?? "").trim().toLowerCase() === want
  ) ?? null;
}
