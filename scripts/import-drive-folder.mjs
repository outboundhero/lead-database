#!/usr/bin/env node
/**
 * Runner: import every Bison instance export in a folder, mapping filename ->
 * instance, a few files in parallel. Each file is a separate
 * import-bison-drive.mjs process so one bad file can't stop the rest, and
 * progress/results are logged per file.
 *
 * Usage: node scripts/import-drive-folder.mjs <folder> [--parallel=3] [--dry-run]
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const folder = process.argv[2];
if (!folder) { console.error("Usage: import-drive-folder.mjs <folder>"); process.exit(1); }
const PAR = Number((process.argv.find((a) => a.startsWith("--parallel=")) || "").split("=")[1]) || 3;
const DRY = process.argv.includes("--dry-run");

// filename prefix -> Bison instance domain
const INSTANCES = [
  ["outboundhero-", "app.outboundhero.co"],
  ["facilityreach-", "app.facilityreach.com"],
  ["outboundclean-", "personal.outboundclean.com"],
  ["cleaningoutbound-", "personal.cleaningoutbound.com"],
];
function instanceFor(name) {
  for (const [prefix, domain] of INSTANCES) if (name.startsWith(prefix)) return domain;
  return null;
}

const files = fs.readdirSync(folder).filter((f) => f.endsWith(".csv")).sort();
const jobs = [];
for (const f of files) {
  const inst = instanceFor(f);
  if (!inst) { console.warn(`SKIP (unknown instance): ${f}`); continue; }
  jobs.push({ file: path.join(folder, f), name: f, instance: inst });
}
console.log(`${jobs.length} files, ${PAR} at a time:`);
for (const j of jobs) console.log(`  ${j.name} -> ${j.instance}`);

const results = [];
const queue = [...jobs];
async function worker(id) {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    const t0 = Date.now();
    console.log(`[w${id}] START ${job.name}`);
    const code = await new Promise((resolve) => {
      const p = spawn("node", [
        "--env-file=.env.local", "scripts/import-bison-drive.mjs",
        job.file, `--instance=${job.instance}`, ...(DRY ? ["--dry-run"] : []),
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let lastLine = "";
      p.stdout.on("data", (d) => { const s = String(d); const m = s.trim().split("\n").pop(); if (m) lastLine = m; });
      p.stderr.on("data", (d) => process.stderr.write(`[w${id}] ${d}`));
      p.on("close", (c) => { console.log(`[w${id}] DONE ${job.name} (${Math.round((Date.now() - t0) / 60000)}m): ${lastLine.trim()}`); resolve(c); });
    });
    results.push({ file: job.name, code });
  }
}
await Promise.all(Array.from({ length: PAR }, (_, i) => worker(i + 1)));
const failed = results.filter((r) => r.code !== 0);
console.log(`\nALL DONE: ${results.length} files, ${failed.length} failed`);
for (const f of failed) console.log(`  FAILED: ${f.file} (exit ${f.code})`);
