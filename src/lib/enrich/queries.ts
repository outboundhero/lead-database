import type { PoolClient } from "pg";
import type { WorkerState } from "./types";

// The worker writes a heartbeat every ~10 s; 45 s of silence means it is down.
const ONLINE_WITHIN_S = 45;

export async function workerState(client: PoolClient): Promise<WorkerState | null> {
  const { rows } = await client.query(
    `SELECT id, last_seen, started_at, info, extract(epoch FROM now() - last_seen)::int AS seconds_ago
       FROM enrich_worker_state ORDER BY last_seen DESC LIMIT 1`
  );
  const w = rows[0];
  if (!w) return null;
  return {
    id: w.id,
    last_seen: w.last_seen,
    started_at: w.started_at,
    seconds_ago: w.seconds_ago,
    online: w.seconds_ago <= ONLINE_WITHIN_S && !w.info?.stopped,
    info: w.info ?? {},
  };
}
