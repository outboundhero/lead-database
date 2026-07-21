#!/usr/bin/env node
// push-worker.mjs — queued Email Bison campaign pushes.
//
// Runs as an always-on Railway service in the same project (start command:
// npm run push-worker). Ports the corofy enrich-worker's claim/stale-reclaim/
// persist-before-attach/finalize discipline, minus the enrichment stage —
// leads come straight from our DB.
//
// Flow (migration 052): POST /api/bison/push-batch inserts a push_batches row;
// this worker claims it:
//   gather  -> resolve the filtered/selected lead ids into push_items
//   push    -> per item: create the lead on each DISTINCT target instance
//              (bison_ids persisted BEFORE any attach — crash recovery never
//              duplicates creates), attach per campaign in chunks of 100,
//              'sent' once attached to ALL target campaigns
//   refresh -> recompute batch counters/status from item states (self-healing)
//
// Concurrency/crash model:
//   * Every claim stamps a fresh claim_token; every item write is fenced on
//     that token, so an overlapping worker (normal during Railway deploys) can
//     reclaim stale items without the old worker clobbering its state.
//   * Graceful shutdown releases claimed-but-unprocessed items immediately.
//   * 401/403 from an instance (or a missing key) is fatal for that batch:
//     batch -> 'error', its claimed items are released untouched.
//   * Cancelled batch mid-flight: claimed items are released untouched;
//     housekeeping marks remaining 'pending' items 'skipped'.
//
// Env:
//   DATABASE_URL          required — Supabase pooler URL
//   EMAILBISON_KEYS       JSON map of instance domain -> token (per-instance keys)
//   EMAILBISON_API_KEY    single/default Bison token (fallback for any instance)
//   EMAILBISON_BASE_URL   default instance domain (default app.outboundhero.co)
//   PUSH_CLAIM_BATCH      items claimed per push cycle (default 50)
//   PUSH_POLL_MS          idle sleep between cycles (default 4000)
//   PUSH_WORKER_ONCE      "1" = process until idle, then exit (cron-style/testing)

import pg from "pg";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname });

const env = process.env;
const POLL_MS = Number(env.PUSH_POLL_MS) || 4000;
const CLAIM_BATCH = Math.min(200, Number(env.PUSH_CLAIM_BATCH) || 50);
const RATE = 5; // per-instance Bison requests/sec
const STALE_MIN = 10; // reclaim items stuck in 'pushing' after this long
const MAX_ATTEMPTS = 3;
const ATTACH_CHUNK = 100;
const GATHER_CHUNK = 5000;
const ONCE = env.PUSH_WORKER_ONCE === "1";

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
pool.on("error", (e) => console.error("pg pool idle-client error:", e.message)); // never crash the loop

let shuttingDown = false;
process.on("SIGTERM", () => { shuttingDown = true; console.log("SIGTERM — releasing unprocessed items, then exiting"); });
process.on("SIGINT", () => { shuttingDown = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Multi-instance keys (mirrors src/lib/bison/keys.ts / bounce-worker):
// EMAILBISON_KEYS is a JSON map of instance domain -> token; EMAILBISON_API_KEY
// is the untagged default. Bison lead ids are per-workspace, so every instance
// a batch's campaigns live on gets its own create.
// ---------------------------------------------------------------------------
const normalizeDomain = (v) => v.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
const KEY_MAP = (() => {
  const out = {};
  try {
    if (env.EMAILBISON_KEYS) {
      for (const [d, k] of Object.entries(JSON.parse(env.EMAILBISON_KEYS))) {
        if (typeof k === "string" && k.trim()) out[normalizeDomain(d)] = k.trim();
      }
    }
  } catch { console.error("EMAILBISON_KEYS is not valid JSON — ignoring"); }
  return out;
})();
const DEFAULT_KEY = (env.EMAILBISON_API_KEY ?? "").trim() || null;
const DEFAULT_DOMAIN = normalizeDomain(env.EMAILBISON_BASE_URL || "app.outboundhero.co");

// Returns { base, key, domain } for a campaign's instance, or null when no key covers it.
function authFor(instanceUrl) {
  const domain = instanceUrl ? normalizeDomain(instanceUrl) : DEFAULT_DOMAIN;
  const key = KEY_MAP[domain] ?? DEFAULT_KEY;
  return key ? { base: `https://${domain}`, key, domain } : null;
}

// Per-instance rate gate: call starts on one instance are spaced >= 1/RATE sec apart.
const nextStartByBase = new Map();
async function rateGate(base) {
  const now = Date.now();
  const at = Math.max(now, nextStartByBase.get(base) ?? 0);
  nextStartByBase.set(base, at + Math.ceil(1000 / RATE) + 15);
  if (at > now) await sleep(at - now);
}

async function bison(auth, method, path, body, attempt = 1) {
  await rateGate(auth.base);
  let res;
  try {
    res = await fetch(auth.base + path, {
      method,
      headers: { Authorization: `Bearer ${auth.key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    if (attempt < MAX_ATTEMPTS) {
      await sleep(1000 * attempt);
      return bison(auth, method, path, body, attempt + 1);
    }
    throw new Error(`Bison ${method} ${auth.base}${path}: ${e instanceof Error ? e.message : "network error"}`);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
    await sleep(1500 * attempt); // 429/5xx are retryable
    return bison(auth, method, path, body, attempt + 1);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const msg = json?.data?.message || json?.message || text.slice(0, 200);
    const err = new Error(`Bison ${method} ${auth.base}${path} -> ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// EXACT create payload from src/lib/bison/push-leads.ts (enrichment as custom variables).
function leadPayload(l) {
  const vars = [];
  if (l.category) vars.push({ name: "category", value: String(l.category) });
  if (l.subcategory) vars.push({ name: "subcategory", value: String(l.subcategory) });
  if (l.city) vars.push({ name: "city", value: String(l.city) });
  if (l.state) vars.push({ name: "state", value: String(l.state) });
  return {
    first_name: l.first_name ?? "",
    last_name: l.last_name ?? "",
    email: l.email,
    ...(l.title ? { title: l.title } : {}),
    ...(l.company ? { company: l.company } : {}),
    ...(l.notes ? { notes: l.notes } : {}),
    custom_variables: vars,
  };
}

async function findLeadByEmail(auth, email, tries = 1) {
  for (let t = 0; t < tries; t++) {
    if (t > 0) await sleep(2000); // Bison search indexing delay
    const found = await bison(auth, "GET", `/api/leads?search=${encodeURIComponent(email)}`);
    const hit = (found?.data ?? []).find((l) => (l.email || "").toLowerCase() === email.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// Live-Bison semantics proven by the corofy enrich-worker (runs in production
// daily): POST /api/leads does NOT upsert — a duplicate email fails with a
// "taken / already exists" validation error. Handle it corofy's way: find the
// existing lead by search (retrying for indexing delay), PUT to refresh its
// fields, and reuse its id. Other 4xx are real validation errors.
async function createLead(auth, lead) {
  try {
    const json = await bison(auth, "POST", "/api/leads", leadPayload(lead));
    const id = json?.data?.id ?? json?.id ?? json?.lead?.id; // defensive id read
    if (id != null) return String(id);
    throw new Error(`create ${lead.email}: could not read Bison lead id from response`);
  } catch (e) {
    if (!/taken|already exists|duplicate/i.test(e.message)) throw e;
  }
  const hit = await findLeadByEmail(auth, lead.email, 3);
  if (!hit) throw new Error(`lead ${lead.email} exists in Bison but was not found by search`);
  await bison(auth, "PUT", `/api/leads/${hit.id}`, leadPayload(lead)); // refresh fields
  return String(hit.id);
}

// ---------------------------------------------------------------------------
// Queue plumbing — every item write is fenced on the claim_token taken at claim
// time (push_items PK is (batch_id, lead_id)).
// ---------------------------------------------------------------------------
const JSON_COLS = new Set(["bison_ids", "target_campaigns"]);

// Fenced write: no-op (returns false) if another worker has reclaimed the item since.
// Any write that releases the item (claimed_at -> null) also drops the fence token.
async function setItem(item, token, fields) {
  const releases = "claimed_at" in fields && fields.claimed_at === null;
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 4}`).join(", ");
  const { rowCount } = await pool.query(
    `update push_items set ${sets}${releases ? ", claim_token = null" : ""}
      where batch_id = $1 and lead_id = $2 and claim_token = $3`,
    [item.batch_id, item.lead_id, token, ...keys.map((k) => (JSON_COLS.has(k) ? JSON.stringify(fields[k]) : fields[k]))]
  );
  if (rowCount === 0) console.warn(`lost claim on item ${item.batch_id}/${item.lead_id} — skipping write`);
  return rowCount > 0;
}

// Transient failure -> back to 'pending' for a retry; terminal 'failed' after MAX_ATTEMPTS.
async function failOrRetry(item, token, err, extraFields = {}) {
  const msg = err instanceof Error ? err.message : String(err);
  const attempts = item.attempts + 1;
  const status = attempts >= MAX_ATTEMPTS ? "failed" : "pending";
  await setItem(item, token, { ...extraFields, status, attempts, error: msg, claimed_at: null });
}

// Release claimed-but-unprocessed items untouched (shutdown / cancelled / fatal batch).
async function releaseItems(items, token) {
  if (items.length === 0) return;
  for (const i of items) {
    await pool.query(
      `update push_items set status = 'pending', claim_token = null, claimed_at = null
        where batch_id = $1 and lead_id = $2 and claim_token = $3`,
      [i.batch_id, i.lead_id, token]
    );
  }
}

// 401/403 (or missing key) from an instance = fatal for the whole batch.
async function failBatch(batchId, msg) {
  await pool.query(
    `update push_batches set status = 'error', error = $2
      where id = $1 and status in ('gathering','processing')`,
    [batchId, msg]
  );
  console.error(`batch ${batchId} -> error: ${msg}`);
}

// ---------------------------------------------------------------------------
// Housekeeping (~60s): stale reclaim + counter rollup + cancel/complete finalize.
// ---------------------------------------------------------------------------
async function reclaimStale() {
  const { rowCount } = await pool.query(
    `update push_items set status = 'pending', claim_token = null, claimed_at = null
      where status = 'pushing' and claimed_at < now() - ($1 || ' minutes')::interval`,
    [STALE_MIN]
  );
  if (rowCount > 0) console.warn(`reclaimed ${rowCount} stale pushing item(s)`);
  // A worker killed mid-gather strands the batch in 'gathering' — updated_at
  // stops moving once the claim write lands, so stale means dead. Re-gather is
  // idempotent (push_items insert is ON CONFLICT DO NOTHING).
  const { rowCount: g } = await pool.query(
    `update push_batches set status = 'pending'
      where status = 'gathering' and updated_at < now() - interval '15 minutes'`
  );
  if (g > 0) console.warn(`reset ${g} stranded gathering batch(es) to pending`);
}

// Recompute counters/finish-state of every active batch from the item rollup
// (self-heals batches whose final refresh was missed by a crash — cheap: the
// active-batch set is always tiny).
async function refreshActiveBatches() {
  // Cancelled batches: remaining queued items become 'skipped' (nothing claims
  // them anymore — the push claim only joins 'processing' batches).
  await pool.query(
    `update push_items set status = 'skipped', error = 'batch cancelled', claim_token = null, claimed_at = null
      where status = 'pending'
        and batch_id in (select id from push_batches where status = 'cancelled')`
  );
  await pool.query(
    `update push_batches b set
        processed = s.processed,
        sent      = s.sent,
        failed    = s.failed,
        skipped   = s.skipped,
        status    = case when b.status = 'processing' and s.unfinished = 0 then 'complete' else b.status end,
        completed_at = case when b.status = 'processing' and s.unfinished = 0 and b.completed_at is null
                            then now() else b.completed_at end
       from (
         select batch_id,
                count(*) filter (where status in ('sent','failed','skipped')) as processed,
                count(*) filter (where status = 'sent')                       as sent,
                count(*) filter (where status = 'failed')                     as failed,
                count(*) filter (where status = 'skipped')                    as skipped,
                count(*) filter (where status in ('pending','pushing'))       as unfinished
           from push_items
          where batch_id in (select id from push_batches where status in ('gathering','processing','cancelled'))
          group by batch_id
       ) s
      where b.id = s.batch_id and b.status in ('gathering','processing','cancelled')`
  );
  // Cancelled batches finish once nothing is mid-flight.
  await pool.query(
    `update push_batches b set completed_at = now()
      where b.status = 'cancelled' and b.completed_at is null
        and not exists (select 1 from push_items i where i.batch_id = b.id and i.status = 'pushing')`
  );
}

// ---------------------------------------------------------------------------
// Stage 1 — gather: claim ONE pending batch, resolve its lead ids + emails into
// push_items, flip to 'processing' (or straight to 'complete' when empty).
// ---------------------------------------------------------------------------
// Eligibility gate (both paths — mirrors the synchronous /api/bison/push).
const ELIGIBLE =
  `l.email is not null and l.email <> '' and l.is_bounced = false ` +
  `and (l.validation_status in ('valid','catch_all') or l.validation_status is null)`;

async function gatherCycle() {
  const { rows: [batch] } = await pool.query(
    `update push_batches b
        set status = 'gathering', started_at = coalesce(b.started_at, now())
      where b.id = (
        select id from push_batches where status = 'pending'
         order by created_at limit 1
         for update skip locked
      )
      returning b.*`
  );
  if (!batch) return false;
  console.log(`gathering batch ${batch.id}`);
  try {
    let rows;
    if (batch.selected_ids?.length) {
      ({ rows } = await pool.query(
        `select l.id, l.email from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE}`,
        [batch.selected_ids]
      ));
    } else {
      // fn_lead_filter_conditions returns trusted SQL fragments (the same helper
      // the export/validation RPCs use) — join them with the eligibility gate.
      const { rows: [c] } = await pool.query(
        `select fn_lead_filter_conditions($1::jsonb) as conds`,
        [JSON.stringify(batch.filters ?? {})]
      );
      const where = [...(c?.conds ?? []), ELIGIBLE].join(" and ");
      const from = batch.range_from;
      const span = batch.range_to != null ? batch.range_to - (from ?? 1) + 1 : null;
      // Keyset pagination: a broad filter over the whole table must never pull
      // millions of rows into Node memory in one query. The range offset
      // applies to the first page only; afterwards l.id > last carries on.
      let remaining = span ?? batch.max_leads ?? null;
      let offset = from != null && from > 1 ? Number(from) - 1 : 0;
      let lastId = null;
      rows = { length: 0 }; // gathered count only — pages stream straight to push_items
      for (;;) {
        const page = remaining != null ? Math.min(GATHER_CHUNK, remaining) : GATHER_CHUNK;
        if (page <= 0) break;
        const params = [];
        let sql = `select l.id, l.email from leads l where ${where}`;
        if (lastId != null) { params.push(lastId); sql += ` and l.id > $${params.length}`; }
        params.push(page);
        sql += ` order by l.id limit $${params.length}`;
        if (offset > 0) { params.push(offset); sql += ` offset $${params.length}`; }
        const { rows: pageRows } = await pool.query(sql, params);
        offset = 0;
        if (pageRows.length === 0) break;
        await pool.query(
          `insert into push_items (batch_id, lead_id, email)
           select $1, t.lead_id, t.email from unnest($2::uuid[], $3::text[]) as t(lead_id, email)
           on conflict (batch_id, lead_id) do nothing`,
          [batch.id, pageRows.map((r) => r.id), pageRows.map((r) => r.email)]
        );
        rows.length += pageRows.length;
        lastId = pageRows[pageRows.length - 1].id;
        if (remaining != null) remaining -= pageRows.length;
        if (pageRows.length < page) break;
      }
    }
    if (Array.isArray(rows)) {
      for (let i = 0; i < rows.length; i += GATHER_CHUNK) {
        const chunk = rows.slice(i, i + GATHER_CHUNK);
        await pool.query(
          `insert into push_items (batch_id, lead_id, email)
           select $1, t.lead_id, t.email from unnest($2::uuid[], $3::text[]) as t(lead_id, email)
           on conflict (batch_id, lead_id) do nothing`,
          [batch.id, chunk.map((r) => r.id), chunk.map((r) => r.email)]
        );
      }
    }
    // Fenced on status: a cancel that landed mid-gather wins.
    const { rowCount } = await pool.query(
      `update push_batches set total = $2,
              status = case when $2 = 0 then 'complete' else 'processing' end,
              completed_at = case when $2 = 0 then now() else completed_at end
        where id = $1 and status = 'gathering'`,
      [batch.id, rows.length]
    );
    if (rowCount === 0) console.warn(`batch ${batch.id} was cancelled during gather`);
    else console.log(`batch ${batch.id}: gathered ${rows.length} item(s)`);
  } catch (e) {
    await failBatch(batch.id, `gather failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Stage 2 — push: create the Bison lead on each DISTINCT instance the item's
// target campaigns live on (bison_ids + target_campaigns persisted BEFORE any
// attach), then attach per campaign in chunks, finalizing 'sent' only when the
// item is attached to ALL its target campaigns.
// ---------------------------------------------------------------------------
async function pushCycle() {
  const token = randomUUID();
  const { rows: items } = await pool.query(
    `update push_items i
        set status = 'pushing', claim_token = $2, claimed_at = now()
      where (i.batch_id, i.lead_id) in (
        select p.batch_id, p.lead_id
          from push_items p
          join push_batches b on b.id = p.batch_id
         where p.status = 'pending' and b.status = 'processing'
         order by p.batch_id, p.lead_id
         limit $1
         for update of p skip locked
      )
      returning i.*`,
    [CLAIM_BATCH, token]
  );
  if (items.length === 0) return false;

  const { rows: leadRows } = await pool.query(
    `select id, email, first_name, last_name, title, company, notes, category, subcategory, city, state
       from leads where id = any($1::uuid[])`,
    [[...new Set(items.map((i) => i.lead_id))]]
  );
  const leads = new Map(leadRows.map((l) => [l.id, l]));
  const { rows: batchRows } = await pool.query(
    `select id, campaigns, status from push_batches where id = any($1::uuid[])`,
    [[...new Set(items.map((i) => i.batch_id))]]
  );
  const batchOf = new Map(batchRows.map((b) => [b.id, b]));

  const fatalBatches = new Set(); // batch ids that hit 401/403/missing-key this cycle
  const toAttach = new Map();     // `${domain}|${campaignId}` -> { auth, campaignId, entries: [{item, leadId}] }
  const finals = [];              // items that reached the attach phase
  const keyOf = (i) => `${i.batch_id}|${i.lead_id}`;

  for (let n = 0; n < items.length; n++) {
    const item = items[n];
    if (shuttingDown) {
      // Release what we haven't touched, but still run attach/finalize below for
      // items whose leads were already created — abandoning them mid-claim would
      // park them as 'pushing' until the stale-reclaim window.
      await releaseItems(items.slice(n), token);
      break;
    }
    const batch = batchOf.get(item.batch_id);
    if (!batch || batch.status !== "processing" || fatalBatches.has(item.batch_id)) {
      await releaseItems([item], token); // cancelled/errored mid-flight — leave untouched
      continue;
    }
    const lead = leads.get(item.lead_id);
    if (!lead || !lead.email) {
      await setItem(item, token, { status: "failed", error: !lead ? "lead no longer exists" : "lead has no email", claimed_at: null });
      continue;
    }
    // Target campaigns are decided once and persisted — a retry reuses them.
    const targets = item.target_campaigns?.length
      ? item.target_campaigns
      : (batch.campaigns ?? []).map((c) => ({ id: String(c.id), instance_url: c.instance_url }));
    if (targets.length === 0) {
      await setItem(item, token, { status: "failed", error: "batch has no campaigns", claimed_at: null });
      continue;
    }
    const bisonIds = { ...(item.bison_ids ?? {}) };
    try {
      // One create per DISTINCT instance involved (Bison lead ids are
      // per-workspace); crash recovery reuses any previously-persisted id.
      for (const t of targets) {
        const auth = authFor(t.instance_url);
        if (!auth) {
          const domain = t.instance_url ? normalizeDomain(t.instance_url) : DEFAULT_DOMAIN;
          throw Object.assign(new Error(`no API key for instance ${domain}`), { configFatal: true });
        }
        if (bisonIds[auth.domain] == null) bisonIds[auth.domain] = await createLead(auth, lead);
      }
      // Persist BEFORE any attach — crash recovery must never duplicate creates.
      const ok = await setItem(item, token, { bison_ids: bisonIds, target_campaigns: targets });
      if (!ok) continue; // lost the claim — another worker owns this item now
      item.bison_ids = bisonIds;
      item.target_campaigns = targets;

      const attached = new Set(item.attached_ids ?? []);
      for (const t of targets) {
        if (attached.has(String(t.id))) continue; // already attached on an earlier attempt
        const auth = authFor(t.instance_url);
        const key = `${auth.domain}|${t.id}`;
        if (!toAttach.has(key)) toAttach.set(key, { auth, campaignId: t.id, entries: [] });
        toAttach.get(key).entries.push({ item, leadId: bisonIds[auth.domain] });
      }
      finals.push(item);
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.configFatal) {
        fatalBatches.add(item.batch_id);
        await failBatch(item.batch_id, e.message);
        await releaseItems([item], token);
      } else {
        // Persist any creates that DID succeed so a retry never re-creates, and
        // treat deterministic 4xx (bad email etc.) as terminal — retrying a 422
        // three times is pure Bison traffic.
        const partial = Object.keys(bisonIds).length ? { bison_ids: bisonIds } : {};
        const terminal = e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429;
        if (terminal) {
          await setItem(item, token, { ...partial, status: "failed", attempts: item.attempts + 1, error: e.message, claimed_at: null });
        } else {
          await failOrRetry(item, token, e, partial);
        }
      }
    }
  }

  // Attach per campaign in chunks; tally per-item successes across campaigns.
  const okByItem = new Map();  // item key -> Set of campaign ids attached this cycle
  const errByItem = new Map(); // item key -> last attach error
  for (const { auth, campaignId, entries } of toAttach.values()) {
    for (let i = 0; i < entries.length; i += ATTACH_CHUNK) {
      const chunk = entries.slice(i, i + ATTACH_CHUNK).filter((e) => !fatalBatches.has(e.item.batch_id));
      if (chunk.length === 0) continue;
      try {
        await bison(auth, "POST", `/api/campaigns/${campaignId}/leads/attach-leads`, { lead_ids: chunk.map((e) => e.leadId) });
        for (const { item } of chunk) {
          if (!okByItem.has(keyOf(item))) okByItem.set(keyOf(item), new Set());
          okByItem.get(keyOf(item)).add(String(campaignId));
        }
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          for (const { item } of chunk) {
            if (!fatalBatches.has(item.batch_id)) {
              fatalBatches.add(item.batch_id);
              await failBatch(item.batch_id, e.message);
            }
          }
        }
        for (const { item } of chunk) errByItem.set(keyOf(item), e);
      }
    }
  }

  // Finalize: 'sent' once attached to ALL target campaigns; partial progress is
  // persisted in attached_ids so a retry only re-attaches what's missing.
  for (const item of finals) {
    if (fatalBatches.has(item.batch_id)) {
      await releaseItems([item], token);
      continue;
    }
    const attached = new Set(item.attached_ids ?? []);
    for (const cid of okByItem.get(keyOf(item)) ?? []) attached.add(cid);
    const attachedArr = [...attached];
    const done = item.target_campaigns.every((t) => attached.has(String(t.id)));
    if (done) {
      await setItem(item, token, { status: "sent", attempts: 0, attached_ids: attachedArr, error: null, claimed_at: null });
    } else {
      await failOrRetry(item, token, errByItem.get(keyOf(item)) ?? new Error("attach incomplete"), { attached_ids: attachedArr });
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main loop — PUSH_WORKER_ONCE=1 drains all queued work (one full pass until
// idle) and exits; otherwise polls forever.
// ---------------------------------------------------------------------------
console.log(
  `push-worker up — rate ${RATE}/s/instance, claim ${CLAIM_BATCH}, poll ${POLL_MS}ms, stale ${STALE_MIN}m, ` +
  `keys: ${Object.keys(KEY_MAP).length} mapped${DEFAULT_KEY ? " + default" : ""}${ONCE ? ", once" : ""}`
);
let lastSweep = 0;
while (!shuttingDown) {
  try {
    if (Date.now() - lastSweep > 60_000) {
      await reclaimStale();
      await refreshActiveBatches(); // self-heal batches stranded by a crash
      lastSweep = Date.now();
    }
    const didGather = await gatherCycle();
    const didPush = await pushCycle();
    if (didGather || didPush) await refreshActiveBatches();
    else if (ONCE) break;
    else await sleep(POLL_MS);
  } catch (e) {
    console.error("cycle error:", e instanceof Error ? e.message : e);
    if (ONCE) break;
    await sleep(POLL_MS);
  }
}
if (ONCE && !shuttingDown) {
  await reclaimStale();
  await refreshActiveBatches();
}
await pool.end();
console.log("push-worker stopped");
