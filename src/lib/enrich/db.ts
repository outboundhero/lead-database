import { Pool, type PoolClient } from "pg";

// The Clay tab's own small pool. It fails fast (10 s to get a connection)
// instead of queueing behind exports on the shared pool (src/lib/db/pool.ts).
// A local Supabase (`supabase start`) has no TLS, so SSL is off for a
// localhost DATABASE_URL and on, as in the shared pool, everywhere else.
let pool: Pool | null = null;

function isLocalDatabase(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function enrichPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL!;
    pool = new Pool({
      connectionString,
      max: 6,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: isLocalDatabase(connectionString) ? false : { rejectUnauthorized: false },
    });
    pool.on("error", (err) => console.error(`[enrich pool] idle client error: ${err.message}`));
  }
  return pool;
}

/**
 * One transaction with its own statement timeout. SET LOCAL only: a
 * session-level SET over the transaction pooler leaks onto whichever client
 * gets the backend next (it once took the push-worker down for 51 minutes).
 */
export async function withTx<T>(
  fn: (client: PoolClient) => Promise<T>,
  { readOnly = false, timeoutMs = 15_000 }: { readOnly?: boolean; timeoutMs?: number } = {}
): Promise<T> {
  const client = await enrichPool().connect();
  const onError = (e: Error) => console.error("[enrich] connection lost:", e.message);
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

export const isUuid = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
