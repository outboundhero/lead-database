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
  const cols = 10;
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const b = i * cols;
    values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5}::jsonb,$${b+6},$${b+7},$${b+8},$${b+9},$${b+10})`);
    params.push(
      r.instance_url, r.bison_id, r.email, r.status, JSON.stringify(r.campaigns ?? null),
      r.emails_sent, r.opens, r.replies, r.bison_created_at, r.bison_updated_at
    );
  });
  // Last write wins: a re-sync refreshes campaign membership and engagement.
  await pool.query(
    `insert into bison_leads (instance_url, bison_id, email, status, campaigns,
                              emails_sent, opens, replies, bison_created_at, bison_updated_at)
     values ${values.join(",")}
     on conflict (instance_url, bison_id) do update set
       email = excluded.email, status = excluded.status, campaigns = excluded.campaigns,
       emails_sent = excluded.emails_sent, opens = excluded.opens, replies = excluded.replies,
       bison_created_at = excluded.bison_created_at, bison_updated_at = excluded.bison_updated_at,
       synced_at = now()`,
    params
  );
  return rows.length;
}

function mapLead(domain, r) {
  const st = r.overall_stats ?? {};
  return {
    instance_url: domain,
    bison_id: Number(r.id),
    email: (r.email ?? "").toLowerCase() || null,
    status: r.status ?? null,
    campaigns: r.lead_campaign_data ?? null,
    emails_sent: num(st.emails_sent),
    opens: num(st.opens),
    replies: num(st.replies),
    bison_created_at: ts(r.created_at),
    bison_updated_at: ts(r.updated_at),
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
console.log(`syncing ${list.length} instance(s), ${SHARDS} shards each${MAX_ROWS !== Infinity ? `, max ${MAX_ROWS} rows` : ""}`);
let grand = 0;
for (const [domain, key] of list) grand += await syncInstance(domain, key);
const { rows: tot } = await pool.query(`select count(*)::bigint n from bison_leads`);
console.log(`\ndone: ${grand.toLocaleString()} rows this run; bison_leads now holds ${Number(tot[0].n).toLocaleString()}`);
await pool.end();
