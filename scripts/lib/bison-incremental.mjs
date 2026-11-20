// The incremental Bison sync's slicing, retries and watermark — pure functions,
// used by scripts/sync-bison-leads.mjs --incremental and tested by
// scripts/test-bison-incremental.mts.
//
// Why (2026-11-20): a slice ("shard") that failed was only logged, the install's
// watermark still jumped to the top id, and the next run started above it — so
// that slice's leads were never fetched by any later incremental run. The floor
// was also the GREATER of the watermark and the highest mirrored id, so a slice
// that succeeded above a failed one lifted the floor past the gap by itself.

// Incremental slices keep their own progress rows (shard 100, 101, …). They used
// to write rows 0..n — the rows a resumed FULL sync reads — and a resumed full
// sync then skipped those slices as already done.
export const INCREMENTAL_SHARD_BASE = 100;

/**
 * Split the new ids (known, top] into at most `maxShards` slices of about
 * `shardSize` ids. Slice 0 is the highest; the last one sits just above `known`.
 * A slice walks DOWN from `from` (exclusive cursor) and stops at `to`, so it
 * covers the ids to+1 … from-1. Together the slices cover known+1 … top exactly.
 */
export function incrementalBounds(known, top, { shardSize = 20000, maxShards = 8, base = INCREMENTAL_SHARD_BASE } = {}) {
  const span = top - known;
  if (span <= 0) return [];
  const shards = Math.max(1, Math.min(maxShards, Math.ceil(span / shardSize)));
  return Array.from({ length: shards }, (_, i) => ({
    shard: base + i,
    from: Math.floor(top - (i * span) / shards) + 1,
    to: Math.max(Math.floor(top - ((i + 1) * span) / shards), known),
  }));
}

/**
 * The new watermark: climb from the lowest slice upward over the slices that
 * completed, and stop at the first that did not. Everything at or below the
 * result is mirrored, so the next run starts there and re-fetches a failed slice
 * (slices above it are read again too — the writes are upserts, so harmless).
 */
export function watermarkAfter(known, bounds, complete) {
  let wm = known;
  for (let i = bounds.length - 1; i >= 0; i--) {
    if (!complete[i]) break;
    wm = bounds[i].from - 1;
  }
  return wm;
}

/**
 * Run every slice concurrently; a slice that throws is retried up to `retries`
 * times, resuming from where it stopped. Logs "shard N failed: …" (the line the
 * bison-sync cron records as an error) only when a slice gives up for good.
 *   run(bound, resume) -> rows seen     isDone(bound) -> did it reach its end
 * Returns per-slice { seen, complete } and the watermark to write.
 */
export async function runIncrementalSlices({ known, bounds, run, isDone, retries = 2, wait = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  const results = await Promise.all(bounds.map(async (b) => {
    let seen = 0;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        seen += await run(b, attempt > 0);
        return { seen, complete: await isDone(b) };
      } catch (e) {
        // Rows this attempt wrote before failing; the retry resumes after them.
        seen += Number(e?.rowsWritten ?? 0) || 0;
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt < retries) {
          log(`   shard ${b.shard} hit an error, retrying from where it stopped (${attempt + 1}/${retries}): ${msg}`);
          await wait(15_000 * (attempt + 1));
        } else {
          log(`   shard ${b.shard} failed: ${msg}`);
        }
      }
    }
    return { seen, complete: false };
  }));
  return { results, watermark: watermarkAfter(known, bounds, results.map((r) => r.complete)) };
}
