import type { Pool, PoolClient } from "pg";

// One transaction on the web app's pg pool (getPool()) with its own statement
// timeout. SET LOCAL only: a session-level SET over the transaction pooler
// leaks onto whichever client gets the backend next (CLAUDE.md, the
// 2026-09-16 push-worker outage).

export async function sharingTx<T>(
  pool: Pool,
  fn: (c: PoolClient) => Promise<T>,
  { readOnly = false, timeoutMs = 15_000 }: { readOnly?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  const client = await pool.connect();
  const onError = (e: Error) => console.error("[sharing] connection lost:", e.message);
  client.on("error", onError);
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1_000, Math.floor(timeoutMs))}`);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.off("error", onError);
    client.release();
  }
}

/** A missing table, column or function: the migration that makes it is not applied here yet. */
export function notApplied(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703" || code === "42883";
}

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** A client tag as client_tags holds it (trimmed, upper case), or "" when it is not one. */
export function tagOf(v: unknown): string {
  const t = typeof v === "string" ? v.trim().toUpperCase() : "";
  return /^[A-Z0-9][A-Z0-9_&-]{0,63}$/.test(t) ? t : "";
}

/** ISO text of a timestamp column (pg gives a Date), or null. */
export function iso(v: unknown): string | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
