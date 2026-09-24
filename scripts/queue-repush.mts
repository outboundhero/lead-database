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
const MAX_PER_BATCH = Number(flag("max") ?? 200000);

const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;
await db.query("set statement_timeout = 0");

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
    select i.batch_id, i.lead_id, i.email, a cid
      from push_items i, lateral unnest(coalesce(i.attached_ids,'{}'::text[])) a
     where i.status = 'sent'
  ), j as (
    select camp.client_tag, att.lead_id, att.email,
           case when split_part(lower(att.email),'@',2) in (select domain from freemail_domains)
                then 'b2c' else 'b2b' end addr,
           camp.side
      from att join camp on camp.batch_id = att.batch_id and camp.cid = att.cid
     where camp.side is not null
  )
  select client_tag, addr as side, array_agg(distinct lead_id) as lead_ids
    from (
      select client_tag, lead_id, email, addr,
             count(*) filter (where side = addr) correct
        from j group by 1,2,3,4
    ) p
   where correct = 0
   group by 1,2`, TAG ? [TAG] : []);

if (!rows.length) { console.log("nothing to re-push"); await db.end(); process.exit(0); }

let queued = 0;
for (const r of rows) {
  const ids: string[] = r.lead_ids;
  // The campaigns for the side this lead SHOULD be on — taken from the client's
  // own most recent push so the bucket split (Google+Custom / Outlook / SEGs)
  // is exactly the one the operator chose.
  const [src] = await q(
    `select b.campaigns, ct.b2b_instance, ct.b2c_instance
       from push_batches b left join client_tags ct on ct.tag = b.client_tag
      where b.client_tag = $1 and jsonb_array_length(b.campaigns) > 0
      order by b.created_at desc limit 1`, [r.client_tag]);
  if (!src) { console.log(`  ${r.client_tag}: no campaign template — skipped`); continue; }
  const want = r.side === "b2b" ? src.b2b_instance : src.b2c_instance;
  const campaigns = (src.campaigns as Array<Record<string, unknown>>)
    .filter((c) => (c.side ?? (c.instance_url === src.b2b_instance ? "b2b" : c.instance_url === src.b2c_instance ? "b2c" : null)) === r.side)
    .map((c) => ({ ...c, side: r.side }));
  if (!campaigns.length) {
    console.log(`  ${r.client_tag}/${r.side}: no ${r.side} campaign on ${want ?? "(install unknown)"} — skipped, needs a campaign choice`);
    continue;
  }
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
