// The incremental Bison sync never skips a slice (2026-11-20).
//
//   npx tsx scripts/test-bison-incremental.mts
//
// Pure: slicing covers the new ids exactly; the watermark climbs only over
// completed slices from the bottom; a failing slice is retried from where it
// stopped and, if it never succeeds, holds the watermark below it — with the
// slices simulated over a fake id space, so "the next run" really refetches.
import {
  incrementalBounds, watermarkAfter, runIncrementalSlices, INCREMENTAL_SHARD_BASE,
} from "./lib/bison-incremental.mjs";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
type B = { shard: number; from: number; to: number };
const covered = (bs: B[]) => bs.flatMap((b) => Array.from({ length: b.from - 1 - b.to }, (_, k) => b.to + 1 + k));

console.log("slicing");
{
  const bs = incrementalBounds(8_763_652, 8_809_907) as B[];   // the 19 Nov app.outboundhero.co delta
  eq("46,255 ids → 3 slices of ~20k", bs.length, 3);
  eq("slice ids start at 100 (not the full sync's 0..7)", bs.map((b) => b.shard), [100, 101, 102]);
  const ids = covered(bs);
  eq("covers known+1 … top with no gap or overlap", [ids.length, new Set(ids).size, Math.min(...ids), Math.max(...ids)], [46_255, 46_255, 8_763_653, 8_809_907]);
  eq("matches the old formula's ranges", bs.map((b) => [b.from, b.to]), [[8_809_908, 8_794_488], [8_794_489, 8_779_070], [8_779_071, 8_763_652]]);
  eq("a 1-id delta is one slice", (incrementalBounds(1_869_799, 1_869_800) as B[]).map((b) => [b.from, b.to]), [[1_869_801, 1_869_799]]);
  eq("never more than 8 slices", incrementalBounds(0, 1_000_000).length, 8);
  eq("nothing new → no slices", incrementalBounds(500, 500).length, 0);
  eq("--shard-size splits a small delta", incrementalBounds(1000, 1600, { shardSize: 200 }).length, 3);
  const odd = incrementalBounds(7, 50, { shardSize: 5 }) as B[];
  const oi = covered(odd);
  eq("uneven split still exact", [oi.length, new Set(oi).size, Math.min(...oi), Math.max(...oi)], [43, 43, 8, 50]);
}

console.log("\nwatermark");
{
  const bs = incrementalBounds(1000, 1600, { shardSize: 200 }) as B[];   // slices 1401-1600, 1201-1400, 1001-1200
  eq("all complete → top", watermarkAfter(1000, bs, [true, true, true]), 1600);
  eq("lowest failed → stays at the old floor", watermarkAfter(1000, bs, [true, true, false]), 1000);
  eq("middle failed → top of the slice below it", watermarkAfter(1000, bs, [true, false, true]), 1200);
  eq("highest failed → top of the slices below", watermarkAfter(1000, bs, [false, true, true]), 1400);
  eq("none complete → old floor", watermarkAfter(1000, bs, [false, false, false]), 1000);
}

// A fake install: ids 1..top exist; a slice "fetches" by adding its ids to `mirror`.
function fakeInstall(top: number) {
  const mirror = new Set<number>();
  const cursor = new Map<number, number>();            // slice -> lowest id fetched so far (resume point)
  const done = new Map<number, boolean>();
  return {
    mirror,
    run: (failPlan: Record<number, number[]>) => async (b: B, resume: boolean) => {
      const plan = failPlan[b.shard] ?? [];
      let c = resume && cursor.has(b.shard) ? cursor.get(b.shard)! : b.from;
      done.set(b.shard, false);
      let seen = 0;
      while (c - 1 > b.to) {
        const id = c - 1;
        if (plan.length && plan[0] === id) {
          plan.shift(); cursor.set(b.shard, c);
          throw Object.assign(new Error(`HTTP 502 at ${id}`), { rowsWritten: seen });   // as runShard reports it
        }
        mirror.add(id); seen++; c = id;
      }
      cursor.set(b.shard, c); done.set(b.shard, true);
      return seen;
    },
    isDone: async (b: B) => done.get(b.shard) === true,
    top,
  };
}
const quiet = { wait: async () => {}, log: () => {} };

console.log("\nretries and the next run (simulated install)");
{
  const inst = fakeInstall(1600);
  const bs = incrementalBounds(1000, 1600, { shardSize: 200 }) as B[];
  // Slice 101 (1201-1400) errors once at id 1300, then succeeds when resumed.
  const r = await runIncrementalSlices({ known: 1000, bounds: bs, run: inst.run({ [INCREMENTAL_SHARD_BASE + 1]: [1300] }), isDone: inst.isDone, ...quiet });
  eq("one error → retried from where it stopped → watermark reaches the top", r.watermark, 1600);
  eq("every new id mirrored exactly once", [inst.mirror.size, Math.min(...inst.mirror), Math.max(...inst.mirror)], [600, 1001, 1600]);
  eq("rows seen add up across the retry", r.results.reduce((a: number, x: { seen: number }) => a + x.seen, 0), 600);
}
{
  const inst = fakeInstall(1600);
  const bs = incrementalBounds(1000, 1600, { shardSize: 200 }) as B[];
  const logs: string[] = [];
  // Slice 101 fails on all three attempts.
  const r1 = await runIncrementalSlices({ known: 1000, bounds: bs, run: inst.run({ [INCREMENTAL_SHARD_BASE + 1]: [1350, 1340, 1330] }), isDone: inst.isDone, wait: async () => {}, log: (m: string) => logs.push(m) });
  eq("three failures → watermark held at the top of the slice below (1200)", r1.watermark, 1200);
  eq("…ids 1201-1329 are missing after this run", [...Array.from({ length: 129 }, (_, k) => 1201 + k)].every((id) => !inst.mirror.has(id)), true);
  eq("logs 2 retries and one final 'shard N failed:' line", [logs.filter((l) => /retrying/.test(l)).length, logs.filter((l) => /shard 101 failed: /.test(l)).length], [2, 1]);
  // The NEXT run starts from the held watermark and gets them.
  const bs2 = incrementalBounds(r1.watermark, 1700, { shardSize: 200 }) as B[];
  const inst2 = { ...inst, top: 1700 };
  const r2 = await runIncrementalSlices({ known: r1.watermark, bounds: bs2, run: inst.run({}), isDone: inst2.isDone, ...quiet });
  eq("next run: watermark reaches the new top", r2.watermark, 1700);
  eq("next run: nothing skipped — every id 1001-1700 mirrored", Array.from({ length: 700 }, (_, k) => 1001 + k).every((id) => inst.mirror.has(id)), true);
}
{
  const inst = fakeInstall(1600);
  const bs = incrementalBounds(1000, 1600, { shardSize: 200 }) as B[];
  // The OLD rule would have moved the watermark to 1600 here; check the new one cannot.
  const r = await runIncrementalSlices({ known: 1000, bounds: bs, run: inst.run({ [INCREMENTAL_SHARD_BASE + 2]: [1100, 1099, 1098] }), isDone: inst.isDone, ...quiet });
  eq("lowest slice fails for good → watermark stays at 1000 (old code: 1600)", r.watermark, 1000);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
