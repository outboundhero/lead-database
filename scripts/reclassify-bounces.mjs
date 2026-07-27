#!/usr/bin/env node
import "dotenv/config";

/**
 * One-off: re-run the bounce classifier over leads that already have a stored
 * bounce_reason (NDR snippet). Run after adding new classifier categories —
 * e.g. migration 063's 'gateway' (recipient security gateways), which flips
 * previously-hard/unknown leads back to contactable.
 *
 * Leads with no stored reason are untouched — the bounce-worker cron fetches
 * and classifies those from Bison on its own schedule.
 *
 * Usage: node --env-file=.env.local scripts/reclassify-bounces.mjs [--dry-run]
 */

import pg from "pg";
import { classifyBounce } from "./bounce-worker.mjs";

const DRY = process.argv.includes("--dry-run");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3, keepAlive: true });
pool.on("error", (err) => console.warn(`pool error (ignored): ${err.message}`));

const rows = (await pool.query(`
  SELECT id, bounce_type, bounce_reason, is_bounced
  FROM leads
  WHERE bounce_reason IS NOT NULL AND bounce_reason <> ''
`)).rows;
console.log(`leads with stored bounce_reason: ${rows.length}`);

const changes = [];
const moves = {};
for (const r of rows) {
  const { type } = classifyBounce(r.bounce_reason);
  // ONLY apply moves TO 'gateway'. The stored bounce_reason is a truncated
  // snippet of the NDR the worker originally classified — re-running on the
  // snippet can lose the evidence (a dry run showed 5k+ phantom
  // sender->unknown downgrades). Gateway is the one category the original
  // classifier didn't know about, so *->gateway is the only trustworthy move.
  if (type !== "gateway" || r.bounce_type === "gateway") continue;
  changes.push({ id: r.id, type, bounced: false });
  const k = `${r.bounce_type}->${type}`;
  moves[k] = (moves[k] || 0) + 1;
}
console.log(`reclassified: ${changes.length}`);
console.log("moves:", Object.entries(moves).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join("  ") || "none");

if (DRY) { console.log("--dry-run: no writes"); await pool.end(); process.exit(0); }

const CHUNK = 2000;
for (let i = 0; i < changes.length; i += CHUNK) {
  const c = changes.slice(i, i + CHUNK);
  await pool.query(`
    UPDATE leads l SET bounce_type = v.t, is_bounced = v.b, bounce_checked_at = now()
    FROM (SELECT unnest($1::uuid[]) id, unnest($2::text[]) t, unnest($3::bool[]) b) v
    WHERE l.id = v.id
  `, [c.map((x) => x.id), c.map((x) => x.type), c.map((x) => x.bounced)]);
}
console.log(`updated ${changes.length} leads`);

const after = (await pool.query(`
  SELECT bounce_type, count(*) n, count(*) FILTER (WHERE is_bounced) still_excluded
  FROM leads WHERE bounce_type IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)).rows;
console.log("after:", after.map((r) => `${r.bounce_type}=${r.n} (excluded ${r.still_excluded})`).join("  "));
await pool.end();
