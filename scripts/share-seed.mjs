#!/usr/bin/env node
// Seeds overlap sharing for imports made before their batch could list its
// leads (plan 1.9, the first live test), run by an operator like the folder
// import. Dry by default: it prints, for each named batch, the new leads it
// finds (made inside the batch's window, with the origin's tag) beside the
// batch's inserted rows, and stops when they differ. With --write it writes
// those leads into upload_batch_leads (outcome new) and one share job per
// batch, forced to preview, and nothing else (scripts/lib/share/seed.mjs).
// The batches and the origin tag are named here on the command line, never in
// this file. It prints counts only, never an address.
//
//   node --env-file=.env.local scripts/share-seed.mjs --tag <ORIGIN> --batch <id> [--batch <id> ...] [--write]
//
// The share step decides the job(s) once overlap sharing is on (with a
// "since" set) and the location run has passed the imports; it stops at
// "previewed" for an admin.

import pg from "pg";
import { seedPlan, seedWrite } from "./lib/share/seed.mjs";

const args = process.argv.slice(2);
const values = (name) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--") ? [args[i + 1]] : []));
const WRITE = args.includes("--write");
const tag = values("tag")[0] ?? "";
const batchIds = values("batch");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const local = ["127.0.0.1", "localhost"].includes(new URL(process.env.DATABASE_URL).hostname);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2, ssl: local ? false : { rejectUnauthorized: false } });
pool.on("error", (e) => console.warn(`pool error: ${e.message}`));

const when = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "not finished");

try {
  const plan = await seedPlan(pool, { tag, batchIds });
  console.log(`origin ${plan.origin || "(none)"}: ${plan.pool ? `pool ${plan.pool}` : "isolated or no client"}, ${plan.onList ? "on" : "not on"} the sharing list`);
  for (const b of plan.batches) {
    console.log(`  batch ${b.id} (${b.filename ?? "no file name"}), ${when(b.created_at)} to ${when(b.completed_at)} UTC: ` +
      `${b.ids.length} new lead(s) found, ${b.inserted_rows} inserted by the import, ${b.placed} with a usable place now`);
  }
  console.log(`found ${plan.found} (${plan.distinct} distinct) against ${plan.expected} inserted${plan.together ? "; the windows overlap, so all go to the first batch's one job" : ""}`);
  if (!plan.ok) {
    for (const p of plan.problems) console.log(`  stop: ${p}`);
    console.log("nothing was written");
    process.exitCode = 1;
  } else if (!WRITE) {
    console.log(`dry run: nothing was written. With --write: ${plan.writes.length} lead list(s) and ${plan.writes.length} share job(s), forced to preview`);
  } else {
    const done = await seedWrite(pool, plan);
    console.log(`written: ${done.listed} lead list row(s), ${done.jobs} share job(s) in preview, waiting for the share step`);
    if (!plan.pool || !plan.onList) console.log(`note: the share step skips the job while ${plan.origin} is ${plan.pool ? "off the sharing list" : "isolated"}`);
  }
} catch (e) {
  console.error(`share-seed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
