import { Pool } from "pg";

// The costing route's own small pool. The shared pool (src/lib/db/pool.ts)
// waits up to 2 minutes for a free connection behind exports, and the spec
// wants an answer in under ~10 s. Failing fast is the right failure here:
// ReplyRouter keeps its last good data and shows the error.
let pool: Pool | null = null;

export function getCostingPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL!,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: { rejectUnauthorized: false },
    });
    pool.on("error", (err) => console.error(`[costing pool] idle client error: ${err.message}`));
  }
  return pool;
}
