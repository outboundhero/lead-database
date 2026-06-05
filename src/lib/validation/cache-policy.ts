// 45-day re-validation TTL. Override with VALIDATION_REVALIDATE_DAYS env var.

const DEFAULT_TTL_DAYS = 45;

function ttlDays(): number {
  const raw = process.env.VALIDATION_REVALIDATE_DAYS;
  if (!raw) return DEFAULT_TTL_DAYS;
  const n = parseInt(raw, 10);
  return isNaN(n) || n <= 0 ? DEFAULT_TTL_DAYS : n;
}

export function needsRevalidation(validatedAt: string | Date | null | undefined): boolean {
  if (!validatedAt) return true;
  const ts = typeof validatedAt === "string" ? new Date(validatedAt).getTime() : validatedAt.getTime();
  if (isNaN(ts)) return true;
  const ageMs = Date.now() - ts;
  const ttlMs = ttlDays() * 24 * 60 * 60 * 1000;
  return ageMs > ttlMs;
}

export function getTtlDays(): number {
  return ttlDays();
}
