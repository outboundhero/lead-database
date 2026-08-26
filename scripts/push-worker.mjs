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
import { espBucket } from "./lib/esp-bucket.mjs";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname });

const env = process.env;
const POLL_MS = Number(env.PUSH_POLL_MS) || 4000;
// Leads claimed per cycle. Bigger is materially cheaper per lead: the fixed
// per-cycle costs (claim, lead/batch fetch, one eligibility statement per
// client) amortise, and — the bigger effect — each attach call carries more
// leads. At 100 claimed the cycle touched 43 campaigns, so an attach POST
// moved barely 2 leads; the same call moves ~8 at 400. Ceiling raised from 200.
const CLAIM_BATCH = Math.min(1000, Number(env.PUSH_CLAIM_BATCH) || 50);
const RATE = Math.max(1, Number(process.env.PUSH_RATE) || 5); // per-instance Bison requests/sec (per process)
// Leads processed at once. The per-item work is almost entirely WAITING — a
// ~274ms lead lookup, then a create — so doing them one at a time left the
// process idle nearly all the time. Each item is independently fenced by its
// claim token, so concurrent items cannot tread on each other; the per-instance
// rate gate above still decides how hard any single Bison install is hit.
const CONCURRENCY = Math.max(1, Math.min(32, Number(env.PUSH_CONCURRENCY) || 8));
// How often the batch counters are recomputed (see the note in the main loop).
const REFRESH_MS = Math.max(5_000, Number(env.PUSH_REFRESH_MS) || 20_000);
const STALE_MIN = Math.max(10, Number(process.env.PUSH_STALE_MIN) || 30); // reclaim items stuck in 'pushing' after this long
const MAX_ATTEMPTS = 3;
const ATTACH_CHUNK = 100;
const GATHER_CHUNK = 5000;
const ONCE = env.PUSH_WORKER_ONCE === "1";

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
// Enough connections for the concurrent item tasks plus the cycle's own
// queries. At the old fixed 5, ten in-flight leads queued on the pool and
// undid much of the concurrency.
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: Math.max(6, Math.min(24, CONCURRENCY + 4)),
});
pool.on("error", (e) => console.error("pg pool idle-client error:", e.message)); // never crash the loop

let shuttingDown = false;
process.on("SIGTERM", () => { shuttingDown = true; console.log("SIGTERM — releasing unprocessed items, then exiting"); });
process.on("SIGINT", () => { shuttingDown = true; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run `fn` over `list` with at most `limit` in flight. Used wherever the work
// is Bison round-trips: the per-instance rate gate still decides how hard any
// one install is hit, so this only stops the process idling between calls.
async function runPool(list, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
      while (i < list.length) {
        const n = i++;
        await fn(list[n], n);
      }
    })
  );
}

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
// Bison rejects an ENTIRE lead with 422 when a custom variable isn't defined
// on that instance ("You do not have a custom variable named subcategory").
// Instances differ, so we learn per-domain which names are unsupported and
// drop them from later payloads instead of failing every lead.
const unsupportedVars = new Map(); // domain -> Set(varName)
function isVarUnsupported(domain, name) {
  return unsupportedVars.get(domain)?.has(name) ?? false;
}
function markVarUnsupported(domain, name) {
  if (!unsupportedVars.has(domain)) unsupportedVars.set(domain, new Set());
  unsupportedVars.get(domain).add(name);
  console.warn(`  instance ${domain} has no custom variable "${name}" — dropping it from further pushes`);
}

function leadPayload(l, tags, domain) {
  const vars = [];
  const addVar = (name, value) => {
    if (value == null || value === "") return;
    if (domain && isVarUnsupported(domain, name)) return;
    vars.push({ name, value: String(value) });
  };
  // Names must match the variables defined ON THE INSTANCES exactly —
  // they use "sub-category" / "additional category", and sending the
  // underscore variants 422-failed entire batches. Full set mirrors the Clay
  // "Create or update lead" mapping (sync-bison-custom-variables.mjs).
  addVar("person linkedin url", l.person_linkedin);
  addVar("category", l.category);
  addVar("sub-category", l.subcategory);
  addVar("additional category", l.additional_category);
  addVar("city", l.city);
  addVar("state", l.state);
  addVar("domain", l.domain);
  addVar("address", l.address);
  addVar("question", l.question);
  addVar("company phone", l.company_phone);
  addVar("google maps url", l.google_maps_url);
  return {
    first_name: l.first_name ?? "",
    last_name: l.last_name ?? "",
    email: l.email,
    ...(l.title ? { title: l.title } : {}),
    ...(l.company ? { company: l.company } : {}),
    ...(l.notes ? { notes: l.notes } : {}),
    custom_variables: vars,
    // Client tag(s) attached to the lead in Bison (create + PUT carry them so
    // it's idempotent). Merges the batch's client tag with any tags the lead
    // already carries in our DB. Sent as a `tags` string array.
    ...(tags && tags.length ? { tags } : {}),
  };
}

// Tags to attach in Bison = the batch's client tag + the lead's existing DB tags
// (comma-joined), de-duplicated case-insensitively.
function tagsForLead(clientTag, leadTags) {
  const out = [];
  const seen = new Set();
  const add = (t) => { const k = String(t).trim(); if (k && !seen.has(k.toLowerCase())) { seen.add(k.toLowerCase()); out.push(k); } };
  if (clientTag) add(clientTag);
  if (leadTags) for (const t of String(leadTags).split(",")) add(t);
  return out;
}

async function findLeadByEmail(auth, email, tries = 1) {
  // DIRECT LOOKUP ONLY: Bison accepts the email as the lead id
  // (GET /api/leads/{email}, same as the bounce-worker's replies endpoint),
  // answers in ~250ms, and matches case-insensitively regardless of how the
  // address is stored — verified on all four installs 2026-08-25.
  //
  // The ?search= fallback that used to sit here is deliberately GONE. That
  // endpoint now takes 34s+ or times out outright on EVERY install, and bison()
  // retries a timeout twice more, so ONE call cost ~93s. pushCycle resolves
  // leads serially and once per instance, so a single lead absent from two
  // installs burned ~3 minutes: the queue stalled at 278k pending with 0 items
  // sent in 95s, and 1,524 items failed on nothing but timeouts (2026-08-25).
  //
  // Do not reinstate it as a "safety net". It cannot find anything the direct
  // route misses — it only decides how slowly we discover the lead is absent.
  //
  // `tries` still covers the post-create indexing delay, but now retries the
  // direct route at ~0.25s a go instead of the 30s search.
  for (let t = 0; t < tries; t++) {
    if (t > 0) await sleep(1000);
    try {
      const direct = await bison(auth, "GET", `/api/leads/${encodeURIComponent(email)}`);
      const hit = direct?.data ?? direct;
      if (hit && hit.id != null && (hit.email || "").toLowerCase() === email.toLowerCase()) return hit;
    } catch (e) {
      if (e.status !== 404 && e.status !== 422) throw e; // real error, not "absent"
    }
  }
  return null;
}

// Live-Bison semantics proven by the corofy enrich-worker (runs in production
// daily): POST /api/leads does NOT upsert — a duplicate email fails with a
// "taken / already exists" validation error. Handle it corofy's way: find the
// existing lead by search (retrying for indexing delay), PUT to refresh its
// fields, and reuse its id. Other 4xx are real validation errors.
async function createLead(auth, lead, tags) {
  // One pass per custom variable we might send (+1): an instance can be missing
  // SEVERAL of them (a B2C instance often defines none), and each attempt only
  // reveals the next missing name. Too few passes and the lead still fails.
  for (let pass = 0; pass < 7; pass++) {
    try {
      const json = await bison(auth, "POST", "/api/leads", leadPayload(lead, tags, auth.domain));
      const id = json?.data?.id ?? json?.id ?? json?.lead?.id; // defensive id read
      if (id != null) return String(id);
      throw new Error(`create ${lead.email}: could not read Bison lead id from response`);
    } catch (e) {
      // NB the message continues after the name ("... named subcategory. Please
      // create it first"), so capture the identifier only — anchoring to $
      // swallowed the trailing sentence and blocked a bogus variable name.
      const missing = e.message.match(/custom variable named\s+"?([A-Za-z0-9_-]+)/i);
      if (missing) { markVarUnsupported(auth.domain, missing[1]); continue; }
      if (/taken|already exists|duplicate/i.test(e.message)) break; // duplicate -> find+PUT below
      throw e;
    }
  }
  const hit = await findLeadByEmail(auth, lead.email, 6);
  if (!hit) throw new Error(`lead ${lead.email} exists in Bison but could not be fetched by email`);
  await bison(auth, "PUT", `/api/leads/${hit.id}`, leadPayload(lead, tags, auth.domain)); // refresh fields + tags
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
      // Export accounting (client req #8): dedupe/new-only/retry semantics are
      // per CLIENT TAG — every batch that carried the same tag counts, not just
      // pushes to the same campaigns.
      const accounting = [];
      const opts = batch.push_options ?? {};
      if (batch.client_tag) {
        const tagLit = `'${String(batch.client_tag).replace(/'/g, "''")}'`;
        if (opts.includeAlreadyPushed !== true) {
          accounting.push(`not exists (
            select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
            where pb.client_tag = ${tagLit} and pi.lead_id = l.id
              and pi.status = 'sent' and pi.batch_id <> '${batch.id}')`);
        }
        if (opts.onlyNewSinceLast === true) {
          const { rows: [last] } = await pool.query(
            `select max(created_at) as at from push_batches
             where client_tag = $1 and id <> $2 and status in ('processing','complete')`,
            [batch.client_tag, batch.id]);
          if (last?.at) accounting.push(`l.created_at > '${new Date(last.at).toISOString()}'::timestamptz`);
        }
        if (opts.retryFailed === true) {
          accounting.push(`exists (
            select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
            where pb.client_tag = ${tagLit} and pi.lead_id = l.id and pi.status = 'failed')`);
        }
      }
      const where = [...(c?.conds ?? []), ELIGIBLE, ...accounting].join(" and ");
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
  // PUSH_TIMING=1 logs where a cycle's wall clock actually goes. Throughput
  // work should be driven by these numbers, not by guesses about which stage
  // looks expensive.
  const TIMING = env.PUSH_TIMING === "1";
  const t = { start: Date.now(), claim: 0, prep: 0, elig: 0, items: 0, attach: 0, final: 0 };
  const mark = (k, from) => { if (TIMING) t[k] = Date.now() - from; };
  const tClaim = Date.now();
  const token = randomUUID();
  const { rows: items } = await pool.query(
    `update push_items i
        set status = 'pushing', claim_token = $2, claimed_at = now()
      where (i.batch_id, i.lead_id) in (
        select p.batch_id, p.lead_id
          from push_items p
          join push_batches b on b.id = p.batch_id
         where p.status = 'pending' and b.status = 'processing'
         -- lead_id order interleaves concurrent batches, so pushes to
         -- DIFFERENT Bison instances proceed in parallel instead of one
         -- batch fully draining before the next starts.
         order by p.lead_id
         limit $1
         for update of p skip locked
      )
      returning i.*`,
    [CLAIM_BATCH, token]
  );
  if (items.length === 0) return false;
  mark("claim", tClaim);
  const tPrep = Date.now();

  const { rows: leadRows } = await pool.query(
    `select id, email, first_name, last_name, title, company, notes, category, subcategory,
            additional_category, city, state, tags, person_linkedin, domain, address, question,
            company_phone, google_maps_url, esp, email_type
       from leads where id = any($1::uuid[])`,
    [[...new Set(items.map((i) => i.lead_id))]]
  );
  const leads = new Map(leadRows.map((l) => [l.id, l]));
  const { rows: batchRows } = await pool.query(
    `select id, campaigns, status, client_tag from push_batches where id = any($1::uuid[])`,
    [[...new Set(items.map((i) => i.batch_id))]]
  );
  const batchOf = new Map(batchRows.map((b) => [b.id, b]));

  const fatalBatches = new Set(); // batch ids that hit 401/403/missing-key this cycle
  const toAttach = new Map();     // `${domain}|${campaignId}` -> { auth, campaignId, entries: [{item, leadId}] }
  const finals = [];              // items that reached the attach phase
  const keyOf = (i) => `${i.batch_id}|${i.lead_id}`;

  // Per-cycle cache of each client tag's eligibility WHERE clause. Rebuilt
  // every cycle so targeting-config edits apply to in-flight batches.
  const eligWhereCache = new Map();
  async function eligibilityWhere(tag) {
    if (!tag) return null;
    if (eligWhereCache.has(tag)) return eligWhereCache.get(tag);
    const { rows } = await pool.query(`select fn_client_eligibility_conditions($1) as conds`, [tag]);
    const conds = rows[0]?.conds ?? [];
    const where = conds.length ? conds.join(" and ") : null;
    eligWhereCache.set(tag, where);
    return where;
  }

  // ONE eligibility query per client tag per cycle, not one per lead.
  //
  // These WHERE clauses are enormous — JPCA's is 23,595 characters (a 230-title
  // regex, plus every targeted city as a geoname id array). The cost is Postgres
  // PLANNING that string, which is paid per statement and is almost independent
  // of how many leads it checks. Measured 2026-08-26: 313ms per lead one at a
  // time, 280ms for FIFTY in one statement — 5.6ms a lead, ~56x cheaper.
  //
  // Same guarantee as before: still evaluated at push time, immediately before
  // any Bison write, against the CURRENT rules.
  mark("prep", tPrep);
  const tElig = Date.now();
  const eligibleIds = new Set();
  const ineligible = new Set();
  {
    const byTag = new Map();
    for (const it of items) {
      const b = batchOf.get(it.batch_id);
      if (!b?.client_tag) continue;
      if (!byTag.has(b.client_tag)) byTag.set(b.client_tag, []);
      byTag.get(b.client_tag).push(it.lead_id);
    }
    // One statement per tag, and the tags run together — a 100-lead claim can
    // span a dozen clients, and a dozen ~280ms statements in series was most of
    // a second per cycle for no reason.
    await runPool([...byTag.entries()], 4, async ([tag, leadIds]) => {
      const where = await eligibilityWhere(tag);
      if (!where) { for (const id of leadIds) eligibleIds.add(`${tag}|${id}`); return; }
      const { rows } = await pool.query(
        `select l.id from leads l where l.id = any($1::uuid[]) and ${where}`,
        [[...new Set(leadIds)]]
      );
      const ok = new Set(rows.map((r) => r.id));
      for (const id of leadIds) (ok.has(id) ? eligibleIds : ineligible).add(`${tag}|${id}`);
    });
  }

  // CONCURRENT, not serial. Each lead is mostly WAITING on Bison (a ~274ms
  // lookup, then a create), so one-at-a-time left the process idle for most of
  // every second. Items are independent — each write is fenced on its own claim
  // token — and the per-instance rate gate still bounds how hard any single
  // install is hit, so this raises utilisation rather than the request rate.
  mark("elig", tElig);
  const tItems = Date.now();
  let cursor = 0;
  const processItem = async (item) => {
    const batch = batchOf.get(item.batch_id);
    if (!batch || batch.status !== "processing" || fatalBatches.has(item.batch_id)) {
      await releaseItems([item], token); // cancelled/errored mid-flight — leave untouched
      return;
    }
    const lead = leads.get(item.lead_id);
    if (!lead || !lead.email) {
      await setItem(item, token, { status: "failed", error: !lead ? "lead no longer exists" : "lead has no email", claimed_at: null });
      return;
    }
    // FINAL ELIGIBILITY GATE: immediately before any Bison write, re-validate
    // the lead against the client's targeting rules (supported country,
    // include/exclude locations, industry/keyword exclusions). The lead or the
    // rules may have changed since the batch was queued — never push on stale
    // eligibility.
    if (batch.client_tag && ineligible.has(`${batch.client_tag}|${item.lead_id}`)) {
      await setItem(item, token, { status: "skipped", error: "ineligible per client targeting at push time", claimed_at: null });
      return;
    }
    // Target campaigns are decided once and persisted — a retry reuses them.
    // ESP ROUTING (client req #9): when the batch's campaigns carry buckets,
    // a lead attaches ONLY to the campaign(s) matching its email provider:
    //   outlook  — ESP is Microsoft/Outlook
    //   seg      — ESP is a recognized security email gateway
    //   default  — Google, custom mail servers, unknown, everything else
    const allCampaigns = batch.campaigns ?? [];
    const routed = allCampaigns.some((c) => c.bucket);
    const bucket = routed ? espBucket(lead.esp) : null;
    // WORKSPACE SPLIT (2026-08-26): business addresses send from the client's
    // B2B install, personal ones from its B2C install. Batches queued before
    // this carry no `side` at all, and those still attach to every campaign —
    // which is how 100% of their leads ended up in BOTH workspaces.
    const sided = allCampaigns.some((c) => c.side);
    const side = lead.email_type === "personal" ? "b2c" : "b2b";
    // De-duplicate by instance+id: the same campaign listed twice would be
    // attached twice, and Bison rejects the second attach as "already in
    // another sequence" — turning a clean push into a partial failure. Batches
    // queued before 2026-08-25 can carry duplicates because the picker showed
    // them (Bison drops search= from its own pagination links, so the scoped
    // list re-collected campaigns it had already returned).
    const seenTarget = new Set();
    const targets = (
      item.target_campaigns?.length
        ? item.target_campaigns
        : allCampaigns
            // A campaign with no side sits on neither of this client's
            // instances; it stays open to any lead rather than being dropped.
            .filter((c) => !sided || !c.side || c.side === side)
            .filter((c) => !routed || (c.bucket ?? "default") === bucket)
            .map((c) => ({ id: String(c.id), instance_url: c.instance_url }))
    ).filter((t) => {
      const k = `${t.instance_url ?? ""}|${t.id}`;
      if (seenTarget.has(k)) return false;
      seenTarget.add(k);
      return true;
    });
    if (targets.length === 0) {
      // NEVER fall back to "send it somewhere". A lead with no campaign of its
      // own is parked with the reason spelled out (client req #5: surface the
      // failure instead of silently putting the lead in the wrong place).
      if (sided || routed) {
        const why = [
          sided ? `no ${side.toUpperCase()} campaign on this batch` : null,
          routed ? `no campaign for the "${bucket}" bucket` : null,
        ].filter(Boolean).join("; ");
        await setItem(item, token, {
          status: "skipped",
          error: `${why} (email: ${lead.email_type ?? "unknown"}, esp: ${lead.esp ?? "unknown"})`,
          claimed_at: null,
        });
      } else {
        await setItem(item, token, { status: "failed", error: "batch has no campaigns", claimed_at: null });
      }
      return;
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
        if (bisonIds[auth.domain] == null) {
          // SEARCH-FIRST: these databases were imported FROM Bison exports, so
          // nearly every lead already exists on its instance — one search hit
          // replaces the create→422→search→refresh round trip entirely.
          const existing = await findLeadByEmail(auth, lead.email, 1);
          if (existing && existing.id != null) {
            bisonIds[auth.domain] = String(existing.id);
          } else {
            bisonIds[auth.domain] = await createLead(auth, lead, tagsForLead(batch.client_tag, lead.tags));
          }
        }
      }
      // Persist BEFORE any attach — crash recovery must never duplicate creates.
      const ok = await setItem(item, token, { bison_ids: bisonIds, target_campaigns: targets });
      if (!ok) return; // lost the claim — another worker owns this item now
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
  };

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) {
        const n = cursor++;
        if (shuttingDown) {
          // Release everything not yet started, then let the attach/finalize
          // below still run for items whose leads were already created —
          // abandoning those mid-claim would park them as 'pushing' until the
          // stale-reclaim window.
          await releaseItems(items.slice(n), token);
          cursor = items.length;
          return;
        }
        await processItem(items[n]);
      }
    })
  );

  // Attach per campaign in chunks; tally per-item successes across campaigns.
  // Bison 422s a WHOLE chunk with "No leads were added because they are either
  // in other sequences, have previously bounced, or unsubscribed" even when
  // only some of the chunk is blocked — so on that error we retry per lead to
  // separate genuinely-blocked leads (a terminal Bison business rule, not a
  // failure) from collateral chunk-mates.
  const BISON_BLOCKED_RE = /No leads were added|other sequences|previously bounced|unsubscribed/i;
  const okByItem = new Map();      // item key -> Set of campaign ids attached this cycle
  const blockedByItem = new Map(); // item key -> Set of campaign ids Bison refused
  const errByItem = new Map();     // item key -> last attach error
  const markOk = (item, campaignId) => {
    if (!okByItem.has(keyOf(item))) okByItem.set(keyOf(item), new Set());
    okByItem.get(keyOf(item)).add(String(campaignId));
  };
  const markBlocked = (item, campaignId) => {
    if (!blockedByItem.has(keyOf(item))) blockedByItem.set(keyOf(item), new Set());
    blockedByItem.get(keyOf(item)).add(String(campaignId));
  };
  mark("items", tItems);
  const tAttach = Date.now();
  // Campaigns are attached CONCURRENTLY. They are independent, frequently on
  // different installs, and this loop used to run one campaign at a time behind
  // the rate gate — so a cycle spanning 13 campaigns paid all of them in series.
  await runPool([...toAttach.values()], CONCURRENCY, async ({ auth, campaignId, entries }) => {
    for (let i = 0; i < entries.length; i += ATTACH_CHUNK) {
      const chunk = entries.slice(i, i + ATTACH_CHUNK).filter((e) => !fatalBatches.has(e.item.batch_id));
      if (chunk.length === 0) continue;
      try {
        await bison(auth, "POST", `/api/campaigns/${campaignId}/leads/attach-leads`, { lead_ids: chunk.map((e) => e.leadId) });
        for (const { item } of chunk) markOk(item, campaignId);
      } catch (e) {
        if (e.status === 401 || e.status === 403) {
          for (const { item } of chunk) {
            if (!fatalBatches.has(item.batch_id)) {
              fatalBatches.add(item.batch_id);
              await failBatch(item.batch_id, e.message);
            }
          }
          continue;
        }
        if (e.status === 422 && BISON_BLOCKED_RE.test(e.message)) {
          // Per-lead separation, CONCURRENTLY. Roughly one lead in ten is
          // already in another sequence, which is enough to 422 a whole
          // hundred-lead chunk — and this then re-attached all hundred one at a
          // time to find them. Same calls, no longer in series.
          await runPool(chunk, CONCURRENCY, async (entry) => {
            try {
              await bison(auth, "POST", `/api/campaigns/${campaignId}/leads/attach-leads`, { lead_ids: [entry.leadId] });
              markOk(entry.item, campaignId);
            } catch (e2) {
              if (e2.status === 422 && BISON_BLOCKED_RE.test(e2.message)) markBlocked(entry.item, campaignId);
              else errByItem.set(keyOf(entry.item), e2);
            }
          });
          continue;
        }
        for (const { item } of chunk) errByItem.set(keyOf(item), e);
      }
    }
  });

  mark("attach", tAttach);
  const tFinal = Date.now();
  // Finalize: 'sent' once attached to ALL target campaigns; partial progress is
  // persisted in attached_ids so a retry only re-attaches what's missing.
  // Finalizing is one small UPDATE per item, but each is a round trip to
  // Supabase (~210ms from Railway), and doing 100 of them in series cost 21s of
  // a 56s cycle — 37% of the time, for writes that do not depend on each other.
  await runPool(finals, CONCURRENCY, async (item) => {
    if (fatalBatches.has(item.batch_id)) {
      await releaseItems([item], token);
      return;
    }
    const attached = new Set(item.attached_ids ?? []);
    for (const cid of okByItem.get(keyOf(item)) ?? []) attached.add(cid);
    const blocked = blockedByItem.get(keyOf(item)) ?? new Set();
    const attachedArr = [...attached];
    // 'done' = every target either attached or terminally refused by Bison's
    // business rules (already in another sequence / bounced / unsubscribed
    // THERE) — retrying a refusal never succeeds.
    const done = item.target_campaigns.every((t) => attached.has(String(t.id)) || blocked.has(String(t.id)));
    if (done && attached.size > 0) {
      await setItem(item, token, { status: "sent", attempts: 0, attached_ids: attachedArr, claimed_at: null,
        error: blocked.size ? `partial: Bison refused campaigns [${[...blocked].join(",")}] (in another sequence / bounced / unsubscribed)` : null });
    } else if (done) {
      await setItem(item, token, { status: "skipped", attached_ids: attachedArr, claimed_at: null,
        error: "Bison refused all target campaigns: lead is in another sequence, previously bounced, or unsubscribed on that instance" });
    } else {
      await failOrRetry(item, token, errByItem.get(keyOf(item)) ?? new Error("attach incomplete"), { attached_ids: attachedArr });
    }
  });
  mark("final", tFinal);
  if (TIMING) {
    const total = Date.now() - t.start;
    console.log(
      `cycle: ${items.length} items in ${(total / 1000).toFixed(1)}s ` +
      `(${(items.length / (total / 1000) * 60).toFixed(0)}/min) — ` +
      `claim ${t.claim}ms, prep ${t.prep}ms, elig ${t.elig}ms, items ${t.items}ms, ` +
      `attach ${t.attach}ms, final ${t.final}ms, campaigns ${toAttach.size}`
    );
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main loop — PUSH_WORKER_ONCE=1 drains all queued work (one full pass until
// idle) and exits; otherwise polls forever.
// ---------------------------------------------------------------------------
console.log(
  `push-worker up — rate ${RATE}/s/instance, concurrency ${CONCURRENCY}, claim ${CLAIM_BATCH}, ` +
  `poll ${POLL_MS}ms, stale ${STALE_MIN}m, refresh ${REFRESH_MS / 1000}s, ` +
  `keys: ${Object.keys(KEY_MAP).length} mapped${DEFAULT_KEY ? " + default" : ""}${ONCE ? ", once" : ""}`
);
let lastSweep = 0;
let lastRefresh = 0;
while (!shuttingDown) {
  try {
    if (Date.now() - lastSweep > 60_000) {
      await reclaimStale();
      await refreshActiveBatches(); // self-heal batches stranded by a crash
      lastSweep = Date.now();
    }
    const didGather = await gatherCycle();
    const didPush = await pushCycle();
    // The counter refresh aggregates every row of every active batch — ~1M
    // rows, 0.48s measured — and only feeds the progress display. Running it
    // after EVERY cycle taxed each lead with a share of that. The 60s sweep
    // above still calls it, so a finished batch is detected either way.
    if ((didGather || didPush) && Date.now() - lastRefresh > REFRESH_MS) {
      await refreshActiveBatches();
      lastRefresh = Date.now();
    }
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
