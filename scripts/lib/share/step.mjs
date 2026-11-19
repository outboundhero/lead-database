// The share step: one round of overlap sharing in the enrich-worker
// (scripts/enrich-worker.mjs runs it every 60 seconds, not awaited, with a busy
// flag, on its own pool of 2 connections). It does nothing at all unless
// overlap_sharing.enabled is true and overlap_sharing.since is set.
//
// Each round, in order (contract 4.4):
//   1. discover   new finished import batches get their share job (jobs.mjs)
//   2. wait       a waiting job is taken once a location run has passed its
//                 import, or at its wait limit (a red notice and a log line)
//   3. decide     taken jobs are decided, a Bison group of receivers at a
//                 time, until the round's time is up; in apply mode each is
//                 applied within the push caps (settleJob)
//   4. recheck    jobs whose daily look at their no-place leads is due
//   5. push       the push timer (upkeep.mjs)
//   6. tags       the paced tag writer
//   7. prune      at most hourly
// A part that fails is logged and the next one runs. A missing migration
// (SHARE_UNREADY) is thrown on, so the worker says it once and stays idle.

import { claimDue, decideJob, discoverJobs, recheckOne } from "./jobs.mjs";
import { isUnready } from "./db.mjs";
import { newUpkeepMemory, prune, pushTimer, writeTags } from "./upkeep.mjs";

/** How often the worker runs a round. */
export const SHARE_EVERY_MS = 60_000;
/** How long a round may decide and recheck before it leaves the rest for the next round. */
export const ROUND_BUDGET_MS = 45_000;

/**
 * @typedef {import("./db.mjs").Pool} Pool
 * @typedef {import("../enrich/settings.mjs").PipelineSettings} PipelineSettings
 * @typedef {{ upkeep: import("./upkeep.mjs").UpkeepMemory }} ShareMemory
 */

/** The step's memory in the worker process (the timers' last runs). */
export function newShareMemory() {
  return { upkeep: newUpkeepMemory() };
}

/**
 * One round.
 *
 * @param {Pool} pool  the step's own pool
 * @param {{ settings: PipelineSettings, memory: ShareMemory, env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *           log?: (line: string) => void, shouldStop?: () => boolean, budgetMs?: number, now?: () => number }} opts
 * @returns {Promise<{ idle: boolean, discovered: number, decided: number, paused: boolean, failed: number, rechecked: number,
 *                     pushes: number, tagsAdded: number, tagsRemoved: number, pruned: { lists: number, rows: number } | null,
 *                     errors: string[] }>}
 */
export async function shareRound(pool, {
  settings, memory, env = process.env, fetchImpl = fetch, log = () => {}, shouldStop = () => false, budgetMs = ROUND_BUDGET_MS, now = Date.now,
}) {
  const out = {
    idle: true, discovered: 0, decided: 0, paused: false, failed: 0, rechecked: 0, pushes: 0, tagsAdded: 0, tagsRemoved: 0,
    pruned: /** @type {{ lists: number, rows: number } | null} */ (null), errors: /** @type {string[]} */ ([]),
  };
  const os = settings?.overlap_sharing;
  if (!os?.enabled || !os.since) return out;
  out.idle = false;
  const deadline = now() + budgetMs;
  const part = async (name, fn) => {
    if (shouldStop()) return;
    try {
      await fn();
    } catch (e) {
      if (isUnready(e)) throw e;
      const line = `${name}: ${/** @type {Error} */ (e)?.message ?? e}`;
      out.errors.push(line);
      log(`overlap sharing, ${line}`);
    }
  };

  await part("discover", async () => {
    out.discovered = (await discoverJobs(pool, { settings })).found;
  });
  await part("decide", async () => {
    while (!shouldStop() && now() < deadline) {
      const job = await claimDue(pool);
      if (!job) break;
      if (job.hit_now) {
        log(`share job ${String(job.batch_id).slice(0, 8)} (${job.origin_tag}): no location run finished after its import within ` +
          `${os.wait_location_minutes} minutes; it is decided with the places known now (is the location cron running?)`);
      }
      const r = await decideJob(pool, job, { settings, deadline, shouldStop, log });
      if (r === "decided") out.decided++;
      if (r === "failed") out.failed++;
      if (r === "paused") {
        out.paused = true;
        break;
      }
    }
  });
  await part("recheck", async () => {
    while (!shouldStop() && now() < deadline) {
      const r = await recheckOne(pool, { settings, shouldStop, log });
      if (!r) break;
      out.rechecked++;
    }
  });
  await part("push", async () => {
    out.pushes = (await pushTimer(pool, { settings, memory: memory.upkeep, env, fetchImpl, now, log })).length;
  });
  await part("tags", async () => {
    const t = await writeTags(pool, { settings, memory: memory.upkeep });
    out.tagsAdded = t.added;
    out.tagsRemoved = t.removed;
  });
  await part("prune", async () => {
    out.pruned = await prune(pool, { memory: memory.upkeep, now });
  });
  return out;
}
