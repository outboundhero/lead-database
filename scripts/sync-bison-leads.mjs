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
// bison_sync_state row that records "everything up to this id is accounted for",
// separate from the real shard rows (0..n). Negative so it can never collide.
const WATERMARK_SHARD = -1;
// Only fetch leads newer than the highest id already mirrored. This is what the
// every-3-days job runs; a full pass is hours, this is seconds.
const INCREMENTAL = has("incremental");
// Skip promoting new leads into the leads table (mirror only).
const NO_IMPORT = has("no-import");
const WRITE_CHUNK = 500;          // rows per upsert statement
const PAGE_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 4;

if (!env.DATABASE_URL) { console.error("DATABASE_URL is not set"); process.exit(1); }
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 6,
  keepAlive: true,
  // Retire connections rather than letting the far end drop them mid-statement.
  idleTimeoutMillis: 30_000,
});
// A pool with no error listener throws on an idle client dying and takes the
// whole process with it — during an hours-long sync that is the difference
// between a hiccup and losing the run.
pool.on("error", (e) => console.log(`   pg pool: ${e.message}`));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every database call in the sync goes through here.
//
// The first full facilityreach run died after 790k rows with SEVEN of eight
// shards reporting "Connection terminated unexpectedly" — a dropped Postgres
// connection, not a Bison problem. Without a retry, one dropped connection
// aborts an entire shard's remaining range, and 1.4M leads went unfetched.
// pg.Pool opens a fresh connection on the next call, so a retry is all this
// needs; the work itself is idempotent (upserts keyed on instance+id).
const TRANSIENT = /Connection terminated|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|terminating connection|server closed|Client has encountered a connection error/i;
async function dbQuery(text, params, attempts = 5) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.query(text, params);
    } catch (e) {
      if (attempt >= attempts || !TRANSIENT.test(String(e?.message ?? ""))) throw e;
      await sleep(400 * attempt * attempt); // 0.4s, 1.6s, 3.6s, 6.4s
    }
  }
}

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

// Bison's custom_variables carry the enrichment: city and state on ~100% of
// leads, category/sub-category/additional category on ~5%. 089 dropped this and
// that is why 368,907 imported leads had no location at all.
//
// Names are lowercase with inconsistent separators — "sub-category" hyphenated,
// "additional category" spaced — so every plausible spelling is accepted.
// Arrives as [{name, value}]; an object form is tolerated too.
const CV_KEYS = {
  cv_city: ["city"],
  cv_state: ["state"],
  cv_category: ["category"],
  cv_subcategory: ["sub-category", "subcategory", "sub category"],
  cv_additional_category: ["additional category", "additional-category", "additional_category"],
  cv_domain: ["domain"],
  cv_address: ["address"],
  cv_phone: ["company phone", "phone", "company phone number"],
  cv_google_maps_url: ["google maps url", "google_maps_url", "maps url"],
  cv_question: ["question"],
};

const CV_COLS = Object.keys(CV_KEYS); // cv_city, cv_state, cv_category, …

async function writeRows(rows) {
  if (rows.length === 0) return 0;
  const cols = 15 + CV_COLS.length; // 14 base + cv_fetched_at + the flattened vars
  const values = [];
  const params = [];
  rows.forEach((r, i) => {
    const b = i * cols;
    const ph = Array.from({ length: cols }, (_, k) => `$${b + k + 1}`);
    ph[4] = `${ph[4]}::jsonb`;
    values.push(`(${ph.join(",")})`);
    params.push(
      r.instance_url, r.bison_id, r.email, r.status, JSON.stringify(r.campaigns ?? null),
      r.emails_sent, r.opens, r.replies, r.bison_created_at, r.bison_updated_at,
      r.first_name, r.last_name, r.company, r.title,
      ...CV_COLS.map((k) => r[k] ?? null),
      new Date()  // cv_fetched_at — these rows carry freshly-read variables
    );
  });
  // Last write wins: a re-sync refreshes campaign membership and engagement.
  // imported_at is NOT touched — a refreshed row must not look un-imported.
  await dbQuery(
    `insert into bison_leads (instance_url, bison_id, email, status, campaigns,
                              emails_sent, opens, replies, bison_created_at, bison_updated_at,
                              first_name, last_name, company, title,
                              ${CV_COLS.join(", ")}, cv_fetched_at)
     values ${values.join(",")}
     on conflict (instance_url, bison_id) do update set
       email = excluded.email, status = excluded.status, campaigns = excluded.campaigns,
       emails_sent = excluded.emails_sent, opens = excluded.opens, replies = excluded.replies,
       bison_created_at = excluded.bison_created_at, bison_updated_at = excluded.bison_updated_at,
       first_name = excluded.first_name, last_name = excluded.last_name,
       company = excluded.company, title = excluded.title,
       ${CV_COLS.map((k) => `${k} = coalesce(excluded.${k}, bison_leads.${k})`).join(", ")},
       cv_fetched_at = excluded.cv_fetched_at,
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
    const { rows } = await dbQuery(
      `with picked as (
         select instance_url, bison_id, email, first_name, last_name, company, title,
                cv_city, cv_state, cv_category, cv_subcategory, cv_additional_category,
                cv_domain, cv_address, cv_phone, cv_google_maps_url, cv_question
           from bison_leads
          where imported_at is null and email is not null
          order by instance_url, bison_id desc
          limit $1
       ), fresh as (
         select distinct on (p.email) p.email, p.first_name, p.last_name, p.company, p.title,
                p.cv_city, p.cv_state, p.cv_category, p.cv_subcategory, p.cv_additional_category,
                p.cv_domain, p.cv_address, p.cv_phone, p.cv_google_maps_url, p.cv_question
           from picked p
          where not exists (select 1 from leads l where l.email = p.email)
            -- SUPPRESSED ADDRESSES ARE NEVER RE-CREATED (091). This is the whole
            -- reason the list is keyed on the address rather than the lead row:
            -- deleting a lead does not stop Bison still holding it, so without
            -- this the next sync would add it straight back and it would go into
            -- a client campaign again. They are still marked imported_at below,
            -- so they are not reconsidered on every future run.
            and not exists (select 1 from suppressed_emails s where s.email = p.email)
          order by p.email
       ), ins as (
         -- The enrichment arrives WITH the lead (client request 2026-09-02):
         -- custom_variables carry city/state on ~100% of leads and the three
         -- category fields on some, so a new lead lands enriched instead of
         -- waiting for a separate backfill to find it. category_source='bison'
         -- only when a category actually came along.
         insert into leads (email, first_name, last_name, company, title, source,
                            city, state, category, subcategory, additional_category,
                            domain, address, company_phone, google_maps_url, question,
                            category_source)
         select email, first_name, last_name, company, title, 'Email Bison',
                cv_city, cv_state, cv_category, cv_subcategory, cv_additional_category,
                cv_domain, cv_address, cv_phone, cv_google_maps_url, cv_question,
                case when cv_category is not null then 'bison' end
           from fresh
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

function customVars(raw) {
  const flat = {};
  if (Array.isArray(raw)) {
    for (const v of raw) if (v?.name != null) flat[String(v.name).trim().toLowerCase()] = v.value;
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) flat[String(k).trim().toLowerCase()] = v;
  }
  const out = {};
  for (const [col, names] of Object.entries(CV_KEYS)) {
    let hit = null;
    for (const n of names) if (flat[n] != null && String(flat[n]).trim() !== "") { hit = flat[n]; break; }
    out[col] = str(hit);
  }
  return out;
}

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
    ...customVars(r.custom_variables),
  };
}

// One shard: walk DOWN from `from_id` until it passes `to_id`.
async function runShard(domain, key, shard, fromId, toId, budget) {
  let cursorId = fromId;
  let seen = 0;
  let buffer = [];
  const { rows: st } = await dbQuery(
    `select cursor_id, done from bison_sync_state where instance_url=$1 and shard=$2`, [domain, shard]);
  if (RESUME && st[0] && !st[0].done && st[0].cursor_id != null) cursorId = Number(st[0].cursor_id);
  if (RESUME && st[0]?.done) return 0;

  await dbQuery(
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

    await dbQuery(
      `update bison_sync_state set cursor_id=$3, rows_seen=$4, updated_at=now()
        where instance_url=$1 and shard=$2`, [domain, shard, cursorId, seen]);
  }
  if (buffer.length) await writeRows(buffer);
  await dbQuery(
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
    // The floor is the highest id we have ever ACCOUNTED FOR — either mirrored,
    // or recorded as a watermark. Keeping them separate is what lets "pull the
    // new leads" work without first pulling 12.7M old ones.
    const { rows } = await dbQuery(
      `select greatest(
                coalesce((select max(bison_id) from bison_leads where instance_url = $1), 0),
                coalesce((select cursor_id from bison_sync_state
                           where instance_url = $1 and shard = ${WATERMARK_SHARD}), 0)
              )::bigint as known`, [domain]);
    const known = Number(rows[0]?.known ?? 0);

    // SEEDING: an install nobody has mirrored gets its watermark set to today's
    // top id and NOTHING is fetched. From the next run on it collects only what
    // is genuinely new. The alternative — refusing until someone runs a full
    // sync — meant three of four installs were simply never watched.
    //
    // A full sync remains worth doing for a different purpose: campaign
    // membership for the net-new forecast needs the back catalogue. New-lead
    // collection does not, and should not wait for it.
    if (!known) {
      await dbQuery(
        `insert into bison_sync_state (instance_url, shard, from_id, to_id, cursor_id, done, started_at)
         values ($1, ${WATERMARK_SHARD}, $2, $2, $2, true, now())
         on conflict (instance_url, shard) do update set cursor_id = excluded.cursor_id, updated_at = now()`,
        [domain, top]);
      console.log(`\n=== ${domain} — first run: watermark set at id ${top.toLocaleString()}, ` +
                  `new leads collected from the next run on (no back catalogue fetched) ===`);
      return 0;
    }

    if (top <= known) { console.log(`\n=== ${domain} — no new leads (top ${top.toLocaleString()}) ===`); return 0; }

    // SHARD THE DELTA. This ran as a single walk and took 2.8 HOURS for 382,790
    // rows (~38/sec) — because our own pushes create leads in Bison far faster
    // than "a few new ones since last time". Split it the same way a full sync
    // splits the id space; a small delta still collapses to one shard.
    const span = top - known;
    const shards = Math.max(1, Math.min(SHARDS, Math.ceil(span / 20000)));
    console.log(`\n=== ${domain} — incremental: ids ${(known + 1).toLocaleString()}..${top.toLocaleString()} ` +
                `(${span.toLocaleString()} ids, ${shards} shard${shards === 1 ? "" : "s"}) ===`);
    const budget = { used: 0, max: MAX_ROWS };
    const bounds = Array.from({ length: shards }, (_, i) => ({
      shard: i,
      from: Math.floor(top - (i * span) / shards) + 1,
      to: Math.floor(top - ((i + 1) * span) / shards),
    }));
    const counts = await Promise.all(
      bounds.map((b) => runShard(domain, key, b.shard, b.from, Math.max(b.to, known), budget)
        .catch((e) => { console.log(`   shard ${b.shard} failed: ${e.message}`); return 0; }))
    );
    const n = counts.reduce((a, b) => a + b, 0);
    // Advance the watermark even if nothing came back, so a quiet install does
    // not re-walk the same empty range every three days.
    await dbQuery(
      `insert into bison_sync_state (instance_url, shard, from_id, to_id, cursor_id, done, started_at)
       values ($1, ${WATERMARK_SHARD}, $2, $2, $2, true, now())
       on conflict (instance_url, shard) do update set cursor_id = greatest(bison_sync_state.cursor_id, excluded.cursor_id), updated_at = now()`,
      [domain, top]);
    const secs = (Date.now() - started) / 1000;
    console.log(`${domain}: ${n.toLocaleString()} new rows in ${secs.toFixed(0)}s (${(n / Math.max(secs, 1)).toFixed(0)}/sec)`);
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

const { rows: tot } = await dbQuery(
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
