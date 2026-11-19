#!/usr/bin/env node
// Never-contact inboxes from the terminal (migration 136): the seed and the
// dry run. Applying is not here: an admin applies an approved dry run on the
// Sharing page (General inboxes tab), and the topup-worker does the work.
//
//   node scripts/never-contact-inboxes.mjs --seed [--variant v]
//       Reads the Clay General inboxes filter from the loaded Clay originals
//       (variant "default" unless told) and stores it in
//       enrich_settings.never_contact_inboxes. Prints where it was read, how
//       many parts it has and the first 12 of its sha256, never the filter.
//   node scripts/never-contact-inboxes.mjs --dry-run
//       Counts the general inboxes the stored filter matches that are not on
//       the never-contact list yet, with a sample for each part of the
//       filter, and stores the count as a dry run an admin can apply. Writes
//       nothing to leads or the list.
//
// The filter is the client's own text (D1): it stays in the database. These
// commands print each part's count and sample, never the whole filter.

import pg from "pg";
import dotenv from "dotenv";
import { dryRun, seedFilter } from "./lib/never-contact-inboxes.mjs";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const value = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

if (has("seed") === has("dry-run")) {
  console.error("Usage: node scripts/never-contact-inboxes.mjs --seed [--variant v] | --dry-run");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
pool.on("error", (e) => console.error(`pg pool: ${e.message}`));

async function tx(fn, timeoutMs) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

try {
  if (has("seed")) {
    const variant = value("variant") ?? "default";
    const r = await tx((c) => seedFilter(c, { variant }), 60_000);
    if (!r.loaded) {
      console.log(`Not loaded (${r.source}): ${r.why}`);
      console.log("Nothing was written.");
      process.exitCode = 1;
    } else {
      console.log(`Loaded from ${r.source}: ${r.parts} parts, sha256 ${r.sha256?.slice(0, 12)}${r.changed ? " (a different filter from before)" : " (the same filter as before)"}.`);
      if (r.stoppedApply) console.log(`The apply that was running on the old filter was stopped (${r.stoppedApply}). Run a new dry run.`);
      console.log("The switch and the pace were left as they were.");
    }
  } else {
    const r = await tx((c) => dryRun(c, {}), 600_000);
    if ("error" in r) {
      console.log(r.error);
      process.exitCode = 1;
    } else {
      const { run } = r;
      console.log(`Dry run ${run.id}: ${Number(run.counted).toLocaleString("en-US")} general inboxes match and are not on the never-contact list (leads created up to ${new Date(run.bound_at).toISOString()}).`);
      console.log("Each part of the filter (an address can match more than one):");
      for (const p of run.sample.parts) {
        console.log(`  ${String(p.count).padStart(8)}  ${p.part}${p.sample.length ? `   e.g. ${p.sample.join(", ")}` : ""}`);
      }
      console.log(`\nNothing was written to leads or the list. Once the owner approves this count, an admin applies it on the Sharing page (General inboxes) within 24 hours.`);
    }
  }
} catch (e) {
  console.error(e?.message ?? e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
