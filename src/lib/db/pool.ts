import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL!;

    pool = new Pool({
      connectionString,
      max: 15,                          // ~10 parallel deep-offset exports with headroom
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 120000,  // queue waits up to 2 min for a free connection
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}
