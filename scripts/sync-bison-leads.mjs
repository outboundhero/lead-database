// Mirror Email Bison's leads into bison_leads (migration 089).
//
//   node scripts/sync-bison-leads.mjs --instance personal.outboundclean.com
//   node scripts/sync-bison-leads.mjs --all --shards 8
//   node scripts/sync-bison-leads.mjs --instance X --resume     # continue a stopped run
//   node scripts/sync-bison-leads.mjs --instance X --max 5000   # bounded trial
//
// WHAT THE API FORCES ON US (all measured 2026-08-26):
//   * A page is 15 rows and cannot be changed. per_page / limit / page_size /
//     perPage / size / count are all accepted and all ignored.
//   * Page-NUMBER pagination dies past ~1000 pages with a 422 telling you to use
//     cursors, so it cannot enumerate a 7.9M-lead install at all.
//   * Cursor pagination needs pagination_type=cursor, AND Bison drops that
//     parameter from its own links.next — follow the link as given and you get
//     nothing usable. Every hop must re-apply it. (The campaigns endpoint drops
//     `search` the same way; assume any parameter is dropped.)
//   * The cursor is a base64 {"id":N,"_pointsToNextItems":true} walking
//     DOWNWARD by id. That is what makes this shardable: craft a cursor at any
//     id and a walk starts there, so the id space splits into concurrent ranges.
//     8 shards sustained 569 leads/sec with zero 429s.
import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname });

const env = process.env;
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? (args[i + 1] ?? true) : d; };
const has = (n) => args.includes(`--${n}`);

const SHARDS = Math.max(1, Math.min(16, Number(flag("shards")) || 8));
const MAX_ROWS = Number(flag("max")) || Infinity;
const RESUME = has("resume");
// Only fetch leads newer than the highest id already mirrored. This is what the
// every-3-days job runs; a full pass is hours, this is seconds.
const INCREMENTAL = has("incremental");
// Skip promoting new leads into the leads table (mirror only).
const NO_IMPORT = has("no-import");
const WRITE_CHUNK = 500;          // rows per upsert statement
const PAGE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

if (!env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 6 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function instances() {
  const map = env.EMAILBISON_KEYS ? JSON.parse(env.EMAILBISON_KEYS) : {};
  const one = flag("instance");
  if (one && typeof one === "string") {
    if (!map[one]) { console.error(`no API key for ${one}`); process.exit(1); }
    return [[one, map[one]]];
  }
  return Object.entries(map);
}

const cursorFor = (id) =>
  Buffer.from(JSON.stringify({ id, _pointsToNextItems: true })).toString("base64").replace(/=+$/, "");

// Always re-applies pagination_type; never trusts Bison's own link to keep it.
function pageUrl(domain, { cursor } = {}) {
  const u = new URL(`https://${domain}/api/leads`);
  u.searchParams.set("pagination_type", "cursor");
  if (cursor) u.searchParams.set("cursor", cursor);
  return u.toString();
}

async function getPage(url, key) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: res.status < 500 });
      return await res.json();
    } catch (e) {
      if (e.fatal || attempt >= MAX_RETRIES) throw e;
      await sleep(600 * attempt * attempt); // 0.6s, 2.4s, 5.4s
    }
  }
}

// Highest lead id on an install — the top of the id space to split.
async function topId(domain, key) {
  const j = await getPage(pageUrl(domain), key);
  const ids = (j.data ?? []).map((r) => Number(r.id)).filter(Number.isFinite);
  return ids.length ? Math.max(...ids) : 0;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const ts = (v) => (v ? new Date(String(v).replace(" ", "T") + (String(v).endsWith("Z") ? "" : "Z")) : null);

async function writeRows(rows) {
  if (rows.length === 0) return 0;
  const cols = 14;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const b = i * cols;
    values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5}::jsonb,$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14})`);
    params.push(
      r.instance_url, r.bison_id, r.email, r.status, JSON.stringify(r.campaigns ?? null),
      r.emails_sent, r.opens, r.replies, r.bison_created_at, r.bison_updated_at,
      r.first_name, r.last_name, r.company, r.title
    );
  });
  // Last write wins: a re-sync refreshes campaign membership and engagement.
  // imported_at is NOT touched — a refreshed row must not look un-imported.
  await pool.query(
    `insert into bison_leads (instance_url, bison_id, email, status, campaigns,
                              emails_sent, opens, replies, bison_created_at, bison_updated_at,
                              first_name, last_name, company, title)
     values ${values.join(",")}
     on conflict (instance_url, bison_id) do update set
       email = excluded.email, status = excluded.status, campaigns = excluded.campaigns,
       emails_sent = excluded.emails_sent, opens = excluded.opens, replies = excluded.replies,
       bison_created_at = excluded.bison_created_at, bison_updated_at = excluded.bison_updated_at,
       first_name = excluded.first_name, last_name = excluded.last_name,
       company = excluded.company, title = excluded.title,
       synced_at = now()`,
    params
  );
  return rows.length;
}

// Promote mirrored leads that our own database does not have yet.
//
// Matching is a plain equality on email: every address in leads is already
// lowercase (0 of 82,001 sampled were not) and the mirror lowercases on the way
// in, so this uses leads_email_key. Wrapping it in lower() does not — that
// version timed out at 120s where this answers in ~2s.
//
// DISTINCT ON (email) because the same person legitimately exists on several
// installs, and one INSERT cannot touch the same conflict target twice.
async function importNew(batchSize = 5000) {
  let imported = 0;
  for (;;) {
    const { rows } = await pool.query(
      `with picked as (
         select instance_url, bison_id, email, first_name, last_name, company, title
           from bison_leads
          where imported_at is null and email is not null
          order by instance_url, bison_id desc
          limit $1
       ), fresh as (
         select distinct on (p.email) p.email, p.first_name, p.last_name, p.company, p.title
           from picked p
          where not exists (select 1 from leads l where l.email = p.email)
          order by p.email
       ), ins as (
         insert into leads (email, first_name, last_name, company, title, source)
         select email, first_name, last_name, company, title, 'Email Bison' from fresh
         on conflict (email) do nothing
         returning 1
       ), mark as (
         update bison_leads b set imported_at = now()
           from picked p
          where b.instance_url = p.instance_url and b.bison_id = p.bison_id
          returning 1
       )
       select (select count(*) from ins) as inserted, (select count(*) from mark) as marked`,
      [batchSize]
    );
    const inserted = Number(rows[0]?.inserted ?? 0);
    const marked = Number(rows[0]?.marked ?? 0);
    imported += inserted;
    if (marked === 0) break;
    if (inserted > 0) console.log(`   imported ${imported.toLocaleString()} new lead(s)…`);
  }
  return imported;
}

const str = (v) => { const s = String(v ?? "").trim(); return s ? s.slice(0, 500) : null; };

function mapLead(domain, r) {
  const st = r.overall_stats ?? {};
  return {
    instance_url: domain,
    bison_id: Number(r.id),
    email: (r.email ?? "").toLowerCase().trim() || null,
    status: r.status ?? null,
    campaigns: r.lead_campaign_data ?? null,
    emails_sent: num(st.emails_sent),
    opens: num(st.opens),
    replies: num(st.replies),
    bison_created_at: ts(r.created_at),
    bison_updated_at: ts(r.updated_at),
    first_name: str(r.first_name),
    last_name: str(r.last_name),
    company: str(r.company),
    title: str(r.title),
  };
}

// One shard: walk DOWN from `from_id` until it passes `to_id`.
async function runShard(domain, key, shard, fromId, toId, budget) {
  let cursorId = fromId;
  let seen = 0;
  let buffer = [];
  const { rows: st } = await pool.query(
    `select cursor_id, done from bison_sync_state where instance_url=$1 and shard=$2`, [domain, shard]);
  if (RESUME && st[0] && !st[0].done && st[0].cursor_id != null) cursorId = Number(st[0].cursor_id);
  if (RESUME && st[0]?.done) return 0;

  await pool.query(
    `insert into bison_sync_state (instance_url, shard, from_id, to_id, cursor_id, started_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (instance_url, shard) do update set
       from_id=excluded.from_id, to_id=excluded.to_id,
       cursor_id=coalesce(bison_sync_state.cursor_id, excluded.cursor_id),
       started_at=now(), done=false, updated_at=now()`,
    [domain, shard, fromId, toId, cursorId]);

  let url = pageUrl(domain, { cursor: cursorFor(cursorId) });
  while (url) {
    if (budget.used >= budget.max) break;
    const j = await getPage(url, key);
    const rows = Array.isArray(j.data) ? j.data : [];
    if (rows.length === 0) break;

    let passedEnd = false;
    for (const r of rows) {
      const id = Number(r.id);
      if (Number.isFinite(id)) {
        if (id <= toId) { passedEnd = true; break; }   // this shard's range is done
        cursorId = id;
      }
      buffer.push(mapLead(domain, r));
      seen++; budget.used++;
      if (budget.used >= budget.max) { passedEnd = true; break; }
    }
    if (buffer.length >= WRITE_CHUNK) { await writeRows(buffer.splice(0, buffer.length)); }
    if (passedEnd) break;

    const next = j.links?.next;
    // Re-apply pagination_type: Bison's own next-link drops it.
    url = next ? pageUrl(domain, { cursor: new URL(next).searchParams.get("cursor") }) : null;

    await pool.query(
      `update bison_sync_state set cursor_id=$3, rows_seen=$4, updated_at=now()
        where instance_url=$1 and shard=$2`, [domain, shard, cursorId, seen]);
  }
  if (buffer.length) await writeRows(buffer);
  await pool.query(
    `update bison_sync_state set cursor_id=$3, rows_seen=$4, done=$5, updated_at=now()
      where instance_url=$1 and shard=$2`,
    [domain, shard, cursorId, seen, budget.used < budget.max]);
  return seen;
}

async function syncInstance(domain, key) {
  const started = Date.now();
  const top = await topId(domain, key);
  if (!top) { console.log(`${domain}: no leads`); return 0; }

  // INCREMENTAL (what the 3-day job runs): ids only ever increase, and the walk
  // goes downward, so everything newer than the highest id we already hold is
  // exactly the set of new leads. One shard, stop on arrival — seconds instead
  // of hours, and no re-reading of millions of unchanged rows.
  if (INCREMENTAL) {
    const { rows } = await pool.query(
      `select coalesce(max(bison_id), 0)::bigint as known from bison_leads where instance_url = $1`, [domain]);
    const known = Number(rows[0]?.known ?? 0);
    if (!known) {
      console.log(`\n=== ${domain} — nothing mirrored yet, run a full sync first ===`);
      return 0;
    }
    if (top <= known) { console.log(`\n=== ${domain} — no new leads (top ${top.toLocaleString()}) ===`); return 0; }
    console.log(`\n=== ${domain} — incremental: ids ${(known + 1).toLocaleString()}..${top.toLocaleString()} ===`);
    const budget = { used: 0, max: MAX_ROWS };
    const n = await runShard(domain, key, 0, top + 1, known, budget);
    const secs = (Date.now() - started) / 1000;
    console.log(`${domain}: ${n.toLocaleString()} new rows in ${secs.toFixed(0)}s`);
    return n;
  }

  console.log(`\n=== ${domain} — top id ${top.toLocaleString()}, ${SHARDS} shards ===`);

  // Split the id space evenly. Ids are not contiguous (deleted leads), so
  // shards finish at different times; that is fine, they are independent.
  const bounds = Array.from({ length: SHARDS }, (_, i) => ({
    shard: i,
    from: Math.floor(top - (i * top) / SHARDS) + 1,
    to: Math.floor(top - ((i + 1) * top) / SHARDS),
  }));
  const budget = { used: 0, max: MAX_ROWS };
  let total = 0;
  const tick = setInterval(() => {
    const secs = (Date.now() - started) / 1000;
    console.log(`   … ${budget.used.toLocaleString()} rows, ${(budget.used / secs).toFixed(0)}/sec`);
  }, 15000);
  try {
    const counts = await Promise.all(
      bounds.map((b) => runShard(domain, key, b.shard, b.from, b.to, budget)
        .catch((e) => { console.log(`   shard ${b.shard} failed: ${e.message}`); return 0; }))
    );
    total = counts.reduce((a, b) => a + b, 0);
  } finally { clearInterval(tick); }
  const secs = (Date.now() - started) / 1000;
  console.log(`${domain}: ${total.toLocaleString()} rows in ${secs.toFixed(0)}s (${(total / secs).toFixed(0)}/sec)`);
  return total;
}

const list = instances();
console.log(
  `${INCREMENTAL ? "incremental" : "full"} sync of ${list.length} instance(s)` +
  `${INCREMENTAL ? "" : `, ${SHARDS} shards each`}${MAX_ROWS !== Infinity ? `, max ${MAX_ROWS} rows` : ""}`
);
let grand = 0;
for (const [domain, key] of list) grand += await syncInstance(domain, key);

let imported = 0;
if (!NO_IMPORT) {
  console.log("\nimporting leads Bison has that we don't…");
  imported = await importNew();
}

const { rows: tot } = await pool.query(
  `select (select count(*) from bison_leads)::bigint as mirrored,
          (select count(*) from bison_leads where imported_at is null and email is not null)::bigint as pending`);
console.log(
  `\ndone: ${grand.toLocaleString()} rows fetched, ${imported.toLocaleString()} new lead(s) added to the database.\n` +
  `bison_leads holds ${Number(tot[0].mirrored).toLocaleString()} (${Number(tot[0].pending).toLocaleString()} not yet checked for import).`
);
// New leads arrive with no location and no category, so they are invisible to
// targeting until the location and categorize workers reach them — expected,
// and worth remembering when a client's available count does not move.
await pool.end();
