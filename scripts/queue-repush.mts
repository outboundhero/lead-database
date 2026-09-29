// Put the misrouted leads into the campaign they SHOULD have gone to.
//
//   npx tsx --env-file=.env.local scripts/queue-repush.mts --tag=CCOC --dry
//   npx tsx --env-file=.env.local scripts/queue-repush.mts --tag=CCOC
//   npx tsx --env-file=.env.local scripts/queue-repush.mts            (every client)
//
// After the 2026-09-24 B2B/B2C incident, 1,328,519 attachments only needed
// REMOVING — those leads were cross-posted, so they were already in the correct
// campaign too. The other 1,720,107 went to the wrong side ONLY: once removed
// they are in no campaign at all, and this puts them where they belong.
//
// It does NOT attach them directly. For these leads the Bison record does not
// even exist on the correct install — the original push only created it on the
// wrong one — so there is no id to attach. Instead it queues a normal push
// batch per client per side, which makes the push-worker do the whole job with
// the routing FIXED (7d7e5d9): create the lead on the right install, pick the
// right ESP-bucket campaign, and re-check suppression, client eligibility and
// dedupe on the way. A blind re-attach would skip all of that.
//
// Run it only AFTER that client's removals are done, so a lead is never in both
// campaigns at once.
import { Client } from "pg";

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const h = argv.find((a) => a === `--${n}` || a.startsWith(`--${n}=`));
  return h ? (h.includes("=") ? h.slice(h.indexOf("=") + 1) : true) : undefined;
};
const TAG = typeof flag("tag") === "string" ? (flag("tag") as string) : null;
const DRY = !!flag("dry");
// 25k, not 200k: a push batch's gather is ONE query over its selected_ids, and
// a gather that runs past the worker's 15-minute stale reset can never commit
// — an 81,793-lead JPU batch sat in 'gathering' for 14 hours that way
// (2026-09-25). Every 25k batch since has gathered well inside the window.
const MAX_PER_BATCH = Number(flag("max") ?? 25000);
// Only queue work whose target install is in this list. The removals hammer two
// installs for hours; pushing to those at the same time would stack load on the
// same server and risk the blanket 429 that once killed the mirror sync. The
// finished installs are idle, so their side can be re-pushed immediately.
const ONLY = typeof flag("instance") === "string"
  ? new Set((flag("instance") as string).split(",").map((x) => x.trim()).filter(Boolean))
  : null;

const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
// Every statement in its OWN transaction with SET LOCAL. This used to issue a
// session-level `set statement_timeout = 0` over DATABASE_URL — the 6543
// transaction pooler, which hands the backend to the next client without
// resetting GUCs, so the setting could land on a push-worker's connection
// (CLAUDE.md: the 2026-09-16 outage was exactly this).
const q = async (sql: string, p: unknown[] = []) => {
  await db.query("begin");
  try {
    await db.query("set local statement_timeout = 0");
    const rows = (await db.query(sql, p)).rows;
    await db.query("commit");
    return rows;
  } catch (e) {
    await db.query("rollback").catch(() => {});
    throw e;
  }
};

// Live campaign status from Bison. Leads are only ever added to a campaign
// that is Active or Draft (client decision 2026-09-29): an archived, paused or
// completed campaign will not send, so putting a lead there helps no one.
const KEYS: Record<string, string> = (() => {
  const raw = String(process.env.EMAILBISON_KEYS ?? "").trim().replace(/^'|'$/g, "");
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
})();
const KEEP_STATUSES = new Set(["active", "draft"]);
const statusCache = new Map<string, string>();
async function liveStatus(inst: string, id: string | number): Promise<string> {
  const k = `${inst}|${id}`;
  if (statusCache.has(k)) return statusCache.get(k)!;
  let status = "unknown";
  if (KEYS[inst]) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = await fetch(`https://${inst}/api/campaigns/${id}`, {
        headers: { Authorization: `Bearer ${KEYS[inst]}`, Accept: "application/json" },
      });
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 30_000)); continue; }
      if (r.status === 404) { status = "not found"; break; }
      const j = await r.json().catch(() => null);
      status = String(j?.data?.status ?? j?.status ?? "unknown").toLowerCase();
      break;
    }
  } else {
    status = "no api key";
  }
  statusCache.set(k, status);
  return status;
}

// Leads that ended up ONLY on the wrong side, with the side they should be on.
const rows = await q(`
  with camp as (
    select b.id batch_id, b.client_tag, cc->>'id' cid, cc->>'instance_url' inst,
           coalesce(cc->>'side', case when cc->>'instance_url' = ct.b2b_instance then 'b2b'
                                      when cc->>'instance_url' = ct.b2c_instance then 'b2c' end) side
      from push_batches b
      left join client_tags ct on ct.tag = b.client_tag,
           lateral jsonb_array_elements(b.campaigns) cc
     where b.client_tag is not null and coalesce(b.sent,0) > 0
       ${TAG ? "and b.client_tag = $1" : ""}
  ), att as (
    -- Resolve every attachment to its INSTALL through the item's own
    -- target_campaigns ({id, instance_url}). attached_ids holds bare campaign
    -- ids, and several clients use the SAME ids on both installs (CCHS has
    -- 214/215/216 on facilityreach and on outboundclean). Matching by id alone
    -- counted a lead sitting in the wrong install's 214 as already in the right
    -- one, so the first run (2026-09-25) re-added nothing at all for CCHS,
    -- CCGNH, CCGHAL, CVJLEX, CVJLOU or JPLA.
    select i.batch_id, i.lead_id, i.email, t->>'id' cid, t->>'instance_url' inst
      from push_items i,
           lateral jsonb_array_elements(coalesce(i.target_campaigns, '[]'::jsonb)) t
     where i.status = 'sent'
       and (t->>'id') = any(coalesce(i.attached_ids, '{}'::text[]))
  ), j as (
    select camp.client_tag, att.lead_id, att.email,
           case when split_part(lower(att.email),'@',2) in (select domain from freemail_domains)
                then 'b2c' else 'b2b' end addr,
           camp.side
      from att join camp on camp.batch_id = att.batch_id
                        and camp.cid = att.cid
                        and camp.inst = att.inst
     where camp.side is not null
  )
  select client_tag, addr as side, array_agg(distinct lead_id) as lead_ids
    from (
      select client_tag, lead_id, email, addr,
             count(*) filter (where side = addr) correct
        from j group by 1,2,3,4
    ) p
   where correct = 0
     -- Already tried by a push made AFTER the routing fix, and deliberately not
     -- sent: outside the client's targeting, refused by Bison (unsubscribed,
     -- bounced, in another sequence) or unfetchable. That verdict came from the
     -- corrected pipeline, so re-queueing would only repeat it.
     and not exists (
       select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
        where pb.client_tag = p.client_tag and pb.email_side = p.addr
          and pb.created_at >= '2026-09-24 20:00+00'
          and pi.lead_id = p.lead_id and pi.status in ('skipped', 'failed'))
   group by 1,2`, TAG ? [TAG] : []);

if (!rows.length) { console.log("nothing to re-push"); await db.end(); process.exit(0); }

let queued = 0;
for (const r of rows) {
  const ids: string[] = r.lead_ids;
  // The campaigns for the side this lead SHOULD be on — taken from the client's
  // own most recent push so the bucket split (Google+Custom / Outlook / SEGs)
  // is exactly the one the operator chose.
  // The template must actually CONTAIN campaigns for the side being pushed.
  // Taking "the most recent batch" alone breaks once this script has queued a
  // one-sided re-push for that client: its own batch becomes the newest and
  // has no campaigns for the other side (2026-09-25: DO/b2c and JPHO/b2c were
  // skipped that way).
  const [src] = await q(
    `select b.campaigns, ct.b2b_instance, ct.b2c_instance
       from push_batches b left join client_tags ct on ct.tag = b.client_tag
      where b.client_tag = $1
        and exists (
          select 1 from jsonb_array_elements(b.campaigns) cc
           where coalesce(cc->>'side',
                          case when cc->>'instance_url' = ct.b2b_instance then 'b2b'
                               when cc->>'instance_url' = ct.b2c_instance then 'b2c' end) = $2)
      order by b.created_at desc limit 1`, [r.client_tag, r.side]);
  if (!src) { console.log(`  ${r.client_tag}: no campaign template — skipped`); continue; }
  const want = r.side === "b2b" ? src.b2b_instance : src.b2c_instance;
  type Camp = { id: string | number; instance_url?: string; side?: string; bucket?: string; name?: string };
  const campaigns: Camp[] = (src.campaigns as Camp[])
    .filter((c) => (c.side ?? (c.instance_url === src.b2b_instance ? "b2b" : c.instance_url === src.b2c_instance ? "b2c" : null)) === r.side)
    .map((c) => ({ ...c, side: r.side as string }));
  if (ONLY && !campaigns.some((c) => c.instance_url && ONLY.has(c.instance_url))) {
    console.log(`  ${r.client_tag}/${r.side}: target install busy — deferred (${ids.length.toLocaleString()} lead(s))`);
    continue;
  }
  if (!campaigns.length) {
    console.log(`  ${r.client_tag}/${r.side}: no ${r.side} campaign on ${want ?? "(install unknown)"} — skipped, needs a campaign choice`);
    continue;
  }
  // Only campaigns that are live-Active or Draft in Bison right now.
  const withStatus = await Promise.all(campaigns.map(async (c) => ({
    c, status: c.instance_url ? await liveStatus(c.instance_url, c.id) : "no install",
  })));
  const dropped = withStatus.filter((x) => !KEEP_STATUSES.has(x.status));
  const usable = withStatus.filter((x) => KEEP_STATUSES.has(x.status)).map((x) => x.c);
  if (dropped.length) {
    console.log(`  ${r.client_tag}/${r.side}: not using ${dropped.map((x) => `${x.c.id}@${x.c.instance_url} (${x.status})`).join(", ")}`);
  }
  if (!usable.length) {
    console.log(`  ${r.client_tag}/${r.side}: no Active or Draft campaign left — skipped (${ids.length.toLocaleString()} lead(s))`);
    continue;
  }
  campaigns.splice(0, campaigns.length, ...usable);
  for (let i = 0; i < ids.length; i += MAX_PER_BATCH) {
    const slice = ids.slice(i, i + MAX_PER_BATCH);
    console.log(`  ${r.client_tag}/${r.side}: ${slice.length.toLocaleString()} lead(s) → ${campaigns.map((c) => `${c.id}@${c.instance_url}`).join(", ")}${DRY ? "  [dry]" : ""}`);
    if (DRY) { queued += slice.length; continue; }
    await q(
      `insert into push_batches (campaigns, selected_ids, client_tag, email_side, status, filters)
       values ($1::jsonb, $2::uuid[], $3, $4, 'pending', null)`,
      [JSON.stringify(campaigns), slice, r.client_tag, r.side]);
    queued += slice.length;
  }
}
console.log(`\n${DRY ? "would queue" : "queued"} ${queued.toLocaleString()} lead(s) for re-push`);
await db.end();
