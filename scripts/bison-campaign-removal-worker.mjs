#!/usr/bin/env node
// bison-campaign-removal-worker.mjs — take misrouted leads out of the wrong
// campaigns (2026-09-24 B2B/B2C incident).
//
//   node scripts/bison-campaign-removal-worker.mjs --tag=CCOC --dry-run
//   node scripts/bison-campaign-removal-worker.mjs --tag=CCOC
//   node scripts/bison-campaign-removal-worker.mjs                 all queued
//   node scripts/bison-campaign-removal-worker.mjs --limit=50000 --pace=400
//
// The queue (migration 117) holds one row per (campaign, lead) to remove, with
// the lead's id ON THAT INSTALL — the same person has a different id on each.
// Work is grouped per campaign so one DELETE carries many lead_ids:
//   DELETE /api/campaigns/{campaign_id}/leads  {lead_ids:[…]}
//
// This only REMOVES. Putting the leads into the correct campaign is deliberately
// not done here: re-pushing them through the corrected pipeline re-checks
// suppression, eligibility and dedupe, which a blind re-attach would not.
//
// Bison 429s hard under sustained load, so the same pacing discipline as the
// mirror sync applies: a 429 is an instruction to wait, not a blip.

import pg from "pg";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const argv = process.argv.slice(2);
const flag = (n) => {
  const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return h ? (h.includes("=") ? h.slice(h.indexOf("=") + 1) : true) : undefined;
};
const num = (v, d) => (Number.isFinite(Number(v)) && v !== "" && v != null ? Number(v) : d);
const DRY = !!flag("dry-run");
const TAG = typeof flag("tag") === "string" ? flag("tag") : null;
const INSTANCE = typeof flag("instance") === "string" ? flag("instance") : null;
const LIMIT = num(flag("limit"), 100000);
const PACE_MS = num(flag("pace"), 400);
const PER_CALL = num(flag("per-call"), 100);   // lead_ids per DELETE
const LANES = num(flag("lanes"), 3);          // campaigns worked at once per install
const MAX_ATTEMPTS = 3;

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...m) => console.log(ts(), ...m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL is required"); process.exit(1); }
const KEYS = process.env.EMAILBISON_KEYS ? JSON.parse(process.env.EMAILBISON_KEYS) : {};
if (!Object.keys(KEYS).length) { console.error("EMAILBISON_KEYS is required"); process.exit(1); }

// Watchdog: sized for a cron slot by default. The one-off remediation runs for
// hours, so --watchdog=0 disables it (2026-09-24: the default 50 min silently
// killed all four workers mid-run with 2.1M rows still queued).
const WATCHDOG_MIN = num(flag("watchdog"), 50);
if (WATCHDOG_MIN > 0) {
  setTimeout(() => { console.error(`WATCHDOG: ${WATCHDOG_MIN} min — exiting`); process.exit(0); }, WATCHDOG_MIN * 60_000).unref();
}

// One lease PER INSTALL so the four installs can drain in parallel — they are
// four separate servers (distinct IPs), so their rate limits are independent.
const LOCK_KEY = `bison-campaign-removal-worker${INSTANCE ? `:${INSTANCE}` : ""}`;
const LOCK_OWNER = randomUUID();
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = (s, p = []) => client.query(s, p);

let removed = 0, failed = 0, calls = 0, waits = 0, absent = 0;
try {
  const { rows: lock } = await q(
    `INSERT INTO worker_locks (key, owner, locked_until) VALUES ($1, $2, now() + interval '1 hour')
     ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, locked_until = EXCLUDED.locked_until
       WHERE worker_locks.locked_until < now() RETURNING owner`, [LOCK_KEY, LOCK_OWNER]);
  if (!lock.length) { log("another run holds the lease — exiting"); process.exit(0); }

  const { rows: groups } = await q(
    `select instance_url, campaign_id, client_tag, count(*)::int n
       from bison_campaign_removals
      where status = 'pending' and attempts < $1
        ${TAG ? `and client_tag = $${INSTANCE ? 3 : 2}` : ""} ${INSTANCE ? "and instance_url = $2" : ""}
      group by 1,2,3 order by 4 desc`,
    [MAX_ATTEMPTS, ...(INSTANCE ? [INSTANCE] : []), ...(TAG ? [TAG] : [])]);
  if (!groups.length) { log("nothing queued"); process.exit(0); }
  const total = groups.reduce((s, g) => s + g.n, 0);
  log(`${total.toLocaleString()} removal(s) across ${groups.length} campaign(s)` +
      `${TAG ? ` for ${TAG}` : ""}${DRY ? " [DRY RUN]" : ""} (pace ${PACE_MS}ms, ${PER_CALL}/call)`);

  let budget = LIMIT;
  // LANES campaigns in flight per install. Each lane owns one campaign, so the
  // slice queries can never overlap, and one install sees at most LANES
  // concurrent requests — still far below the load that earned a blanket 429.
  const queue = [...groups];
  const lane = async () => {
   for (;;) {
    const g = queue.shift();
    if (!g || budget <= 0) return;
    if (budget <= 0) break;
    const key = KEYS[g.instance_url];
    if (!key) { log(`  no API key for ${g.instance_url} — skipping campaign ${g.campaign_id}`); continue; }
    for (;;) {
      if (budget <= 0) break;
      const { rows: batch } = await q(
        `select id, bison_lead_id from bison_campaign_removals
          where status = 'pending' and attempts < $4 and instance_url = $1 and campaign_id = $2
          order by id limit $3`,
        [g.instance_url, g.campaign_id, Math.min(PER_CALL, budget), MAX_ATTEMPTS]);
      if (!batch.length) break;
      const ids = batch.map((r) => Number(r.bison_lead_id));
      if (DRY) {
        log(`  [dry] DELETE ${g.instance_url}/api/campaigns/${g.campaign_id}/leads × ${ids.length}`);
        budget -= ids.length;
        // mark nothing; a dry run must be repeatable
        if (batch.length < PER_CALL) break; else continue;
      }
      let res;
      try {
        res = await fetch(`https://${g.instance_url}/api/campaigns/${g.campaign_id}/leads`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ lead_ids: ids }),
        });
      } catch (e) { res = { ok: false, status: 0, text: async () => e.message }; }
      calls++;
      if (res.status === 429) {
        const ra = Number(res.headers?.get?.("retry-after"));
        const ms = Number.isFinite(ra) && ra > 0 ? ra * 1000 : 45_000;
        waits++; log(`  429 from ${g.instance_url} — waiting ${Math.round(ms / 1000)}s`);
        await sleep(ms);
        continue;                      // same slice, try again
      }
      if (res.ok) {
        await q(`update bison_campaign_removals set status='done', attempts=attempts+1, completed_at=now() where id = any($1::bigint[])`,
          [batch.map((r) => r.id)]);
        removed += ids.length; budget -= ids.length;
        // a clean pass earns the slice size back
      } else {
        // Bison validates the WHOLE array: if ANY id is not in this campaign it
        // returns 422 and removes nothing, naming the offending POSITIONS
        // ("The selected lead_ids.22 is invalid"). Verified 2026-09-24: a lead
        // that IS in the campaign deletes with 200; one that is not gives that
        // 422. So "invalid" means "already not in this campaign" — the end
        // state we wanted is already true, and those rows are settled, not
        // failed. The full body must be read: truncating it loses most of the
        // positions and the resend fails again on the ones that were missed.
        const body = await res.text();
        const badIdx = new Set([...body.matchAll(/lead_ids\.(\d+)/g)].map((m) => Number(m[1])));
        if (res.status === 422 && badIdx.size) {
          const settle = batch.filter((_, i) => badIdx.has(i)).map((r) => r.id);
          if (settle.length) {
            await q(`update bison_campaign_removals set status='done', attempts=attempts+1, completed_at=now(),
                            last_error='already not in this campaign' where id = any($1::bigint[])`, [settle]);
            absent += settle.length; budget -= settle.length;
          }
          // Measured 2026-09-24: only 1.8% of queued rows are stale, so the
          // cheap play is to settle the ones Bison named and resend the rest at
          // full size — ~2-3 calls per 100 rows. (Halving the slice on a stale
          // hit was tried and was far worse: at a 2% stale rate a 100-slice
          // trips ~84% of the time, so slices collapsed and never recovered.)
          if (PACE_MS > 0) await sleep(PACE_MS);
          continue;
        }
        const short = body.slice(0, 200).replace(/\s+/g, " ");
        await q(`update bison_campaign_removals set status = case when attempts + 1 >= $2 then 'failed' else 'pending' end,
                        attempts = attempts + 1, last_error = $3 where id = any($1::bigint[])`,
          [batch.map((r) => r.id), MAX_ATTEMPTS, `HTTP ${res.status}: ${short}`]);
        failed += ids.length;
        log(`  campaign ${g.campaign_id}@${g.instance_url}: HTTP ${res.status} ${short}`);
        if (res.status === 401 || res.status === 403 || res.status === 404) break;
      }
      if (PACE_MS > 0) await sleep(PACE_MS);
    }
   }
  };
  await Promise.all(Array.from({ length: Math.max(1, LANES) }, lane));
  const { rows: [left] } = await q(
    `select count(*)::int n from bison_campaign_removals where status='pending'${TAG ? " and client_tag=$1" : ""}`,
    TAG ? [TAG] : []);
  log(`removed ${removed.toLocaleString()}, already-absent ${absent.toLocaleString()}, failed ${failed.toLocaleString()}, ${calls} API call(s)` +
      `${waits ? `, ${waits} rate-limit wait(s)` : ""} — ${left.n.toLocaleString()} still queued`);
} catch (e) {
  console.error(ts(), "ERROR", e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await q("DELETE FROM worker_locks WHERE key=$1 AND owner=$2", [LOCK_KEY, LOCK_OWNER]).catch(() => {});
  await client.end();
}
process.exit(process.exitCode ?? 0);
