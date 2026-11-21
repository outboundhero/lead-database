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
import { campaignsForLead } from "./lib/push-side.mjs";
import { espBucket } from "./lib/esp-bucket.mjs";
import { eligibilitySql, enqueueLeadCompanies, fitCheckOn, FIT_SKIP } from "./lib/enrich/fit-push.mjs";
import { isSharePush } from "./lib/overlap-topup.mjs";
import { planTarget, inSequenceElsewhere, attachBody, verifyForced, itemOutcome } from "./lib/push-attach.mjs";
import { directLookupUnsafe, exactEmailMatch } from "./lib/bison-lookup.mjs";
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
// Ceiling raised 32 -> 96 (2026-08-29). With the rate gate at 45/s/instance the
// gate stopped being the constraint and this cap became it: per-lead work is
// ~1.5s of waiting (lookup, create, two Supabase round trips), so 400 leads at
// 32 in flight is ~19s — exactly the "items" figure observed. Concurrency is
// what converts waiting into throughput; the gate still bounds how hard any one
// install is hit.
const CONCURRENCY = Math.max(1, Math.min(96, Number(env.PUSH_CONCURRENCY) || 8));
// How often the batch counters are recomputed (see the note in the main loop).
const REFRESH_MS = Math.max(5_000, Number(env.PUSH_REFRESH_MS) || 20_000);
// How many of the OLDEST batches a cycle draws from. 0 = the old behaviour of
// spreading across every active batch at once. See the note in pushCycle.
// NB Number(undefined) is NaN, and `?? 2` does NOT catch NaN — an unset
// variable would silently mean "no focus" and undo the change.
const rawFocus = Number(env.PUSH_BATCH_FOCUS);
const BATCH_FOCUS = Math.max(0, Math.min(20, Number.isFinite(rawFocus) ? rawFocus : 2));
const STALE_MIN = Math.max(10, Number(process.env.PUSH_STALE_MIN) || 30); // reclaim items stuck in 'pushing' after this long
const MAX_ATTEMPTS = 3;
const ATTACH_CHUNK = 100;
const GATHER_CHUNK = 5000;
const ONCE = env.PUSH_WORKER_ONCE === "1";
// PARALLEL SENDING (2026-11-20, the client's decision; scripts/lib/push-attach.mjs).
// Attach with Bison's allow_parallel_sending, so a lead goes in even while it is
// in sequence in ANOTHER client's campaign on the install, as the Clay tables
// this push replaced always did. Without it Bison leaves those leads out while
// still answering 2xx: ~284k of the 18 Nov pushes' "sent" leads never landed.
// A lead in sequence in the SAME client's own live campaign is never forced.
// PUSH_ALLOW_PARALLEL=0 turns forcing off; the leads it would have forced are
// then recorded as skipped, with the campaign holding them named.
const ALLOW_PARALLEL = env.PUSH_ALLOW_PARALLEL !== "0";
// How many forced leads per attach chunk are read back after a 2xx (draft and
// paused campaigns only: Bison syncs an active campaign within ~5 minutes, so
// an immediate read could miss a lead that is on its way). 0 = no check.
// NB Number(undefined) is NaN; guard it, as for PUSH_BATCH_FOCUS above.
const rawSpot = Number(env.PUSH_SPOT_CHECK);
const SPOT_CHECK = Math.max(0, Math.min(10,
  env.PUSH_SPOT_CHECK != null && env.PUSH_SPOT_CHECK !== "" && Number.isFinite(rawSpot) ? Math.floor(rawSpot) : 2));

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
// Enough connections for the concurrent item tasks plus the cycle's own
// queries. At the old fixed 5, ten in-flight leads queued on the pool and
// undid much of the concurrency.
const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Must keep pace with CONCURRENCY: each in-flight lead makes its own writes,
  // and a pool smaller than the concurrency re-serialises them on the way out.
  // Capped well below Supabase's connection limit, which the app and the other
  // workers also draw on.
  max: Math.max(6, Math.min(40, CONCURRENCY + 4)),
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

// ── ONE WORKER PER BISON INSTALL ────────────────────────────────────────────
// The four installs are four separate servers on distinct IPs with INDEPENDENT
// rate limits, so the honest way to use all four is four processes, each
// driving one of them. A single process cannot: its item pool
// (PUSH_CONCURRENCY) is one global ceiling, so whichever install its current
// batch belongs to is the only one doing work — measured 2026-09-25, one
// install ran at 22.5 items/s against its own 45/s gate while the other three
// sat idle with 160k items pending.
//
//   PUSH_INSTANCE=app.facilityreach.com   own the batches that live ONLY there
//   PUSH_SPAN_ONLY=1                      own the batches that span two installs
//   neither                               own everything (original behaviour)
//
// A batch whose campaigns span two installs (96 of them historically, 4.1M
// items — the wizard/export picker lets B2B and B2C be chosen together) is
// claimed by NO per-install worker, because a lead in it routes to one install
// or the other per its email domain and a scoped worker would attach it to the
// wrong one. PUSH_SPAN_ONLY=1 is the service that picks those up, so the four
// scoped workers plus one span worker cover the queue exactly once.
const INSTANCE = (env.PUSH_INSTANCE ?? "").trim().toLowerCase() || null;
const SPAN_ONLY = env.PUSH_SPAN_ONLY === "1";
if (INSTANCE && SPAN_ONLY) {
  console.error("PUSH_INSTANCE and PUSH_SPAN_ONLY are mutually exclusive");
  process.exit(1);
}
if (INSTANCE && !KEY_MAP[INSTANCE] && DEFAULT_DOMAIN !== INSTANCE) {
  // Refuse rather than idle forever on batches we hold no key for.
  console.error(`PUSH_INSTANCE=${INSTANCE} is not in EMAILBISON_KEYS (${Object.keys(KEY_MAP).join(", ") || "empty"})`);
  process.exit(1);
}
// The batches this worker owns, as a SQL fragment. Spliced into several
// queries with different parameter numbering, hence an inlined literal rather
// than a placeholder — INSTANCE is validated against EMAILBISON_KEYS above, so
// it can only ever be one of our own install domains.
const batchScope = (alias) =>
  INSTANCE
    ? `and not exists (select 1 from jsonb_array_elements(${alias}.campaigns) cc
                        where coalesce(cc->>'instance_url', '') <> '${INSTANCE}')`
    : SPAN_ONLY
      ? `and (select count(distinct cc->>'instance_url')
                from jsonb_array_elements(${alias}.campaigns) cc) > 1`
      : "";

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

// opts (optional): { timeoutMs, maxAttempts } for a call that must stay cheap
// when Bison is slow (the address search); every other call keeps 30 s and
// MAX_ATTEMPTS.
async function bison(auth, method, path, body, attempt = 1, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  await rateGate(auth.base);
  let res;
  try {
    res = await fetch(auth.base + path, {
      method,
      headers: { Authorization: `Bearer ${auth.key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30000),
    });
  } catch (e) {
    if (attempt < maxAttempts) {
      await sleep(1000 * attempt);
      return bison(auth, method, path, body, attempt + 1, opts);
    }
    throw new Error(`Bison ${method} ${auth.base}${path}: ${e instanceof Error ? e.message : "network error"}`);
  }
  if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
    await sleep(1500 * attempt); // 429/5xx are retryable
    return bison(auth, method, path, body, attempt + 1, opts);
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
  //
  // THE ONE EXCEPTION (2026-11-21, scripts/lib/bison-lookup.mjs): an address
  // that does not start with a letter. Bison reads a path that starts with
  // digits as a numeric id (GET /api/leads/360abc@… returns lead #360, someone
  // else), so the direct route can never find such a lead: 831 of the 832
  // failures of the 20 Nov re-run. Those addresses, ~0.1% of leads, go through
  // ?search= (measured ~0.2 s on 2026-11-21), each call capped at 20 s with no
  // retries, so a slow search can cost one odd address 20 s, never a stall.
  // Every other lead stays on the direct route, as above.
  const viaSearch = directLookupUnsafe(email);
  for (let t = 0; t < tries; t++) {
    if (t > 0) await sleep(1000);
    try {
      if (viaSearch) {
        const found = await searchLeadByEmail(auth, email);
        if (found) return found;
        continue;
      }
      const direct = await bison(auth, "GET", `/api/leads/${encodeURIComponent(email)}`);
      const hit = direct?.data ?? direct;
      if (hit && hit.id != null && (hit.email || "").toLowerCase() === email.toLowerCase()) return hit;
    } catch (e) {
      if (e.status !== 404 && e.status !== 422) throw e; // real error, not "absent"
    }
  }
  return null;
}

// GET /api/leads?search=<address>: the exact (any case) match, or null. Bison
// drops search= from its own next-links, so pages are asked for by number; a
// page holds at most 15 rows, and three are plenty for one full address.
const SEARCH_CALL = { timeoutMs: 20_000, maxAttempts: 1 };
async function searchLeadByEmail(auth, email) {
  const q = encodeURIComponent(String(email).trim());
  for (let page = 1; page <= 3; page++) {
    const json = await bison(auth, "GET", `/api/leads?search=${q}&page=${page}`, undefined, 1, SEARCH_CALL);
    const rows = Array.isArray(json?.data) ? json.data : [];
    const hit = exactEmailMatch(rows, email);
    if (hit) return hit;
    if (rows.length < 15) return null;
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
      // lead: null = created just now, so it is in no campaign (see planTarget).
      if (id != null) return { id: String(id), lead: null };
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
  // Bison says the address is taken, so the lead exists. If the direct route
  // still cannot read it, one search before giving up (an address
  // directLookupUnsafe does not flag has already been searched for otherwise).
  const hit = (await findLeadByEmail(auth, lead.email, 6))
    ?? (directLookupUnsafe(lead.email) ? null : await searchLeadByEmail(auth, lead.email));
  if (!hit) throw new Error(`lead ${lead.email} exists in Bison but could not be fetched by email`);
  await bison(auth, "PUT", `/api/leads/${hit.id}`, leadPayload(lead, tags, auth.domain)); // refresh fields + tags
  // The existing lead as Bison holds it (its campaigns did not change with the PUT).
  return { id: String(hit.id), lead: hit };
}

// The lead as Bison holds it NOW, by its id on this install: status and
// lead_campaign_data, for planTarget and the spot check. null when Bison has no
// such lead.
async function readLeadById(auth, id) {
  try {
    const json = await bison(auth, "GET", `/api/leads/${encodeURIComponent(id)}`);
    return json?.data ?? json ?? null;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// { name, status } of a campaign on one install, or null when Bison no longer
// has it. Used to tell the client's own campaigns from other clients' (by the
// tag the name starts with) and a finished campaign from a live one. Cached ten
// minutes per install and id (in-flight reads shared); a failed read is not
// cached, and throws to the caller, whose item is then retried.
const CAMPAIGN_INFO_TTL_MS = 10 * 60_000;
const campaignInfoCache = new Map(); // `${domain}|${id}` -> { at, p }
function campaignInfo(auth, id) {
  const k = `${auth.domain}|${id}`;
  const hit = campaignInfoCache.get(k);
  if (hit && Date.now() - hit.at < CAMPAIGN_INFO_TTL_MS) return hit.p;
  const p = (async () => {
    try {
      const json = await bison(auth, "GET", `/api/campaigns/${encodeURIComponent(id)}`);
      const d = json?.data ?? json ?? {};
      return { name: d.name ?? null, status: d.status ?? null };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  })();
  campaignInfoCache.set(k, { at: Date.now(), p });
  p.catch(() => campaignInfoCache.delete(k));
  return p;
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

// Share and top-up pushes (overlap sharing, migrations 134 and 135): batches
// the Sharing page's push queues with push_options.source "share" or "topup"
// and selected_ids. Before any gather, one is cancelled when it lists no lead
// (an empty list would fall through to the filters path below and gather the
// client's whole backlog) or when its client can no longer receive
// (fn_client_receive_block, 132: churn date, status, no group, not on the
// Groups tab, rules). scripts/test-share-push.mjs runs these statements and
// shareStopReason() as they are written here.
const SHARE_CANCEL_SQL =
  `update push_batches set status = 'cancelled', error = $2, completed_at = now()
    where id = $1 and status = 'gathering'`;
const RECEIVE_BLOCK_SQL = `select public.fn_client_receive_block($1) as block`;
// The "not already sent for this client" check of the filters path below, for
// a selected-ids batch with push_options.skipAlreadySent ($2 the batch's
// client tag, $3 the batch).
const NOT_SENT_FOR_CLIENT =
  `not exists (select 1 from push_items pi join push_batches pb on pb.id = pi.batch_id
                where pb.client_tag = $2 and pi.lead_id = l.id and pi.status = 'sent' and pi.batch_id <> $3)`;

/** Why a share or top-up push batch must not be gathered, or null. block: fn_client_receive_block of its client. */
function shareStopReason(batch, block) {
  if (!Array.isArray(batch.selected_ids) || batch.selected_ids.length === 0) return "Cancelled: a share push with no lead ids";
  if (block) return `Cancelled: ${batch.client_tag} cannot receive (${block})`;
  return null;
}

async function gatherCycle() {
  const { rows: [batch] } = await pool.query(
    `update push_batches b
        set status = 'gathering', started_at = coalesce(b.started_at, now())
      where b.id = (
        select g.id from push_batches g
         where g.status = 'pending' ${batchScope("g")}
         order by g.created_at limit 1
         for update skip locked
      )
      returning b.*`
  );
  if (!batch) return false;
  console.log(`gathering batch ${batch.id}`);
  try {
    if (isSharePush(batch.push_options)) {
      const hasIds = Array.isArray(batch.selected_ids) && batch.selected_ids.length > 0;
      const block = hasIds ? (await pool.query(RECEIVE_BLOCK_SQL, [batch.client_tag])).rows[0]?.block ?? null : null;
      const stop = shareStopReason(batch, block);
      if (stop) {
        // Fenced on status, as the gather's own finish is.
        const { rowCount } = await pool.query(SHARE_CANCEL_SQL, [batch.id, stop]);
        console.warn(rowCount ? `batch ${batch.id}: ${stop}` : `batch ${batch.id} was cancelled during gather`);
        return true;
      }
    }
    let rows;
    if (batch.selected_ids?.length) {
      // A share or top-up push leaves out leads already sent for its client,
      // as the filters path's accounting does. Every other batch: as before.
      const skipSent = batch.push_options?.skipAlreadySent === true && Boolean(batch.client_tag);
      ({ rows } = await pool.query(
        `select l.id, l.email from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE}${skipSent ? ` and ${NOT_SENT_FOR_CLIENT}` : ""}`,
        skipSent ? [batch.selected_ids, batch.client_tag, batch.id] : [batch.selected_ids]
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

  // OLDEST BATCHES FIRST, and only a few of them at a time.
  //
  // The claim used to order by lead_id across every active batch, so all of
  // them advanced together and none finished: 16 clients all sat around 11%
  // while the earliest had been queued for six days.
  //
  // Draining oldest-first is also FASTER, which is the non-obvious part. A
  // 400-lead cycle spread over 18 batches touches 93 campaigns, so an attach
  // POST carries ~4 leads; the same 400 taken from the two oldest batches touch
  // 9 campaigns and carry ~44. Attach is the stage that swings between 14s and
  // 116s a cycle, and this cuts the number of those calls by roughly ten times.
  //
  // One batch per INSTALL, so every install is busy while each one still works
  // a single client at a time. PUSH_BATCH_FOCUS caps how many installs are in
  // play (set it to the number of installs, 4); 0 restores the old
  // spread-everything behaviour if a client ever needs to jump the queue.
  let focusIds = null;
  if (BATCH_FOCUS > 0) {
    // ONE BATCH PER INSTALL, oldest first. Taking simply "the N oldest batches"
    // concentrated attach calls nicely but said nothing about WHICH installs
    // they sat on, so the focus could be three batches on the same install
    // while the others idled — measured 2026-09-25 mid-remediation:
    // app.facilityreach.com had 160,357 items pending and was doing nothing
    // because the three oldest batches belonged to two other installs.
    // The rate gate is per-install, so a batch on each install runs at full
    // speed in parallel; within an install it is still one batch at a time,
    // which is what keeps an attach POST carrying ~44 leads instead of ~4.
    const { rows } = await pool.query(
      `select distinct on (x.inst) b.id, x.inst
         from push_batches b
         left join lateral (
           select cc->>'instance_url' as inst
             from jsonb_array_elements(b.campaigns) cc
            where cc->>'instance_url' is not null
            limit 1
         ) x on true
        where b.status = 'processing'
          and exists (select 1 from push_items i
                       where i.batch_id = b.id and i.status = 'pending')
          ${batchScope("b")}
        order by x.inst, b.created_at
        limit $1`,
      [BATCH_FOCUS]
    );
    focusIds = rows.map((r) => r.id);
    if (focusIds.length === 0) return false; // nothing pending anywhere
  }

  // A QUOTA PER FOCUSED BATCH, not "the first N across all of them".
  //
  // This used to be `order by p.batch_id, p.lead_id limit $1`. batch_id is a
  // random uuid, so that ordering drained whichever focused batch happened to
  // hold the lowest uuid, in full, before the next one was touched — every item
  // in a cycle went to ONE install, its per-install rate gate was the only one
  // in use, and the other three installs idled. Spreading the focus across
  // installs (above) is useless without this: the focus decides which batches
  // are eligible, the claim decides who actually gets worked.
  //
  // Each cycle now takes CLAIM_BATCH/installs from each, so one pool of
  // PUSH_CONCURRENCY workers is spread over four independent rate gates.
  // A batch with less than its quota pending simply contributes what it has;
  // as batches drain they leave the focus and the quota for the rest rises.
  const perBatch = focusIds ? Math.max(1, Math.ceil(CLAIM_BATCH / focusIds.length)) : CLAIM_BATCH;
  const { rows: items } = await pool.query(
    focusIds
      ? `update push_items i
            set status = 'pushing', claim_token = $2, claimed_at = now()
          where (i.batch_id, i.lead_id) in (
            select c.batch_id, c.lead_id
              from unnest($3::uuid[]) f(batch_id)
              cross join lateral (
                select p.batch_id, p.lead_id
                  from push_items p
                 where p.batch_id = f.batch_id and p.status = 'pending'
                 limit $1
                 for update of p skip locked
              ) c
          )
          returning i.*`
      : `update push_items i
            set status = 'pushing', claim_token = $2, claimed_at = now()
          where (i.batch_id, i.lead_id) in (
            select p.batch_id, p.lead_id
              from push_items p
              join push_batches b on b.id = p.batch_id
             where p.status = 'pending' and b.status = 'processing'
               ${batchScope("b")}
             order by p.lead_id
             limit $1
             for update of p skip locked
          )
          returning i.*`,
    focusIds ? [perBatch, token, focusIds] : [CLAIM_BATCH, token]
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

  // B2B vs B2C is decided by the ADDRESS DOMAIN — freemail (gmail/yahoo/aol/…)
  // is B2C, a company domain is B2B. This is the same definition the Leads
  // filters and fn_lead_filter_conditions' emailSide branch use, and it is the
  // ONLY correct one (client, 2026-09-24).
  //
  // It used to read `lead.email_type === "personal"`, which asks something else
  // entirely — is this mailbox a person (john@) or a role (info@)? That sent
  // 1,745,235 company addresses into B2C campaigns and 271,587 freemail
  // addresses into B2B campaigns before it was caught.
  const { rows: fmRows } = await pool.query("select domain from freemail_domains");
  const FREEMAIL = new Set(fmRows.map((r) => String(r.domain).toLowerCase()));

  // Which install is this client's B2B one and which is B2C. Used to resolve a
  // campaign whose `side` was never stamped, instead of attaching to both.
  const tags = [...new Set(batchRows.map((b) => b.client_tag).filter(Boolean))];
  const instanceSide = new Map();   // `${tag}|${instance}` -> 'b2b' | 'b2c'
  if (tags.length) {
    const { rows } = await pool.query(
      "select tag, b2b_instance, b2c_instance from client_tags where tag = any($1::text[])", [tags]);
    for (const r of rows) {
      if (r.b2b_instance) instanceSide.set(`${r.tag}|${r.b2b_instance}`, "b2b");
      if (r.b2c_instance) instanceSide.set(`${r.tag}|${r.b2c_instance}`, "b2c");
    }
  }

  const fatalBatches = new Set(); // batch ids that hit 401/403/missing-key this cycle
  const toAttach = new Map();     // `${domain}|${campaignId}` -> { auth, campaignId, entries: [{item, leadId}] }
  const finals = [];              // items that reached the attach phase
  const keyOf = (i) => `${i.batch_id}|${i.lead_id}`;
  // Per-item tallies across this cycle's targets. Declared before processItem,
  // which now records "already in the campaign" and "Bison will not add it"
  // itself, before any attach call (scripts/lib/push-attach.mjs).
  const okByItem = new Map();      // item key -> Set of campaign ids the lead is now in
  const blockedByItem = new Map(); // item key -> Map campaign id -> why it was not added
  const errByItem = new Map();     // item key -> last attach error
  const markOk = (item, campaignId) => {
    if (!okByItem.has(keyOf(item))) okByItem.set(keyOf(item), new Set());
    okByItem.get(keyOf(item)).add(String(campaignId));
  };
  const markBlocked = (item, campaignId, reason) => {
    if (!blockedByItem.has(keyOf(item))) blockedByItem.set(keyOf(item), new Map());
    blockedByItem.get(keyOf(item)).set(String(campaignId), reason);
  };

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

  // FIT GATE, PUSH-TIME CHECK (fit scoring, 2B.7): only while the gate applies
  // to the tag and require_scored is on. Then the per-tag statement below also
  // says which leads' company has no score yet, or no key to score it by;
  // those items are skipped and their companies queued for the scorer at
  // priority 1. Off (every client today), the statement is exactly as before.
  const fitCheckCache = new Map();
  async function fitCheckFor(tag) {
    if (!fitCheckCache.has(tag)) fitCheckCache.set(tag, await fitCheckOn(pool, tag));
    return fitCheckCache.get(tag);
  }
  const fitSkip = new Map(); // `${tag}|${leadId}` -> reason

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
      const fitCheck = await fitCheckFor(tag);
      const { rows } = await pool.query(eligibilitySql(where, fitCheck), [[...new Set(leadIds)]]);
      const ok = new Set(rows.map((r) => r.id));
      for (const id of leadIds) (ok.has(id) ? eligibleIds : ineligible).add(`${tag}|${id}`);
      if (fitCheck) {
        const unscored = [];
        for (const r of rows) {
          if (r.fit === "nokey") fitSkip.set(`${tag}|${r.id}`, FIT_SKIP.nokey);
          else if (r.fit === "unscored") { fitSkip.set(`${tag}|${r.id}`, FIT_SKIP.unscored); unscored.push(r.id); }
        }
        // Queued for the scorer; a failure here must never stop the push.
        if (unscored.length) {
          await enqueueLeadCompanies(pool, unscored, { priority: 1, source: "push" })
            .catch((e) => console.warn(`fit: could not queue ${unscored.length} unscored companies for ${tag}: ${e.message}`));
        }
      }
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
    // Fit gate (only while it applies to the client): no score yet, or no key to score by.
    const fitReason = batch.client_tag ? fitSkip.get(`${batch.client_tag}|${item.lead_id}`) : undefined;
    if (fitReason) {
      await setItem(item, token, { status: "skipped", error: fitReason, claimed_at: null });
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
    // WORKSPACE SPLIT: a company address sends from the client's B2B install,
    // a freemail address from its B2C install.
    // ⚠ NEVER attach to both workspaces — see scripts/lib/push-side.mjs.
    const sideCall = campaignsForLead({
      campaigns: allCampaigns, email: lead.email, clientTag: batch.client_tag,
      freemailDomains: FREEMAIL, instanceSide,
    });
    if (sideCall.refuse) {
      await setItem(item, token, {
        status: "skipped",
        error: `refusing to push: ${sideCall.refuse}. ` +
               "Set b2b_instance/b2c_instance for this client tag, or re-queue from the wizard.",
        claimed_at: null,
      });
      return;
    }
    const sideTargets = new Set(sideCall.targets.map((c) => `${c.instance_url ?? ""}|${c.id}`));
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
            // Single-install batches have nothing to split, so an unresolved
            // side stays open; a two-install batch was refused above.
            .filter((c) => sideTargets.has(`${c.instance_url ?? ""}|${c.id}`))
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
      //
      // ⚠ This block sits OUTSIDE the try/catch below, so anything that throws
      // here aborts the WHOLE cycle: the main loop logs "cycle error" and every
      // one of the ~400 claimed items stays 'pushing' until the 10-minute stale
      // reclaim, with attach and finalize skipped. It referenced `sided` and
      // `side` — both deleted along with the old email_type routing (7d7e5d9) —
      // so from 2026-09-24 every lead with no campaign of its own threw
      // `ReferenceError: sided is not defined` and killed a full cycle instead
      // of being parked. Keep this block free of anything that can throw.
      const sideDropped = sideCall.targets.length === 0 && allCampaigns.length > 0;
      if (sideDropped || routed) {
        const why = [
          sideDropped ? `no ${String(sideCall.side).toUpperCase()} campaign on this batch` : null,
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
    // The lead as Bison holds it, per install: null = created by this push (in
    // no campaign yet). planTarget reads its status and campaigns.
    const bisonLeads = {};
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
            bisonLeads[auth.domain] = existing;
          } else {
            const made = await createLead(auth, lead, tagsForLead(batch.client_tag, lead.tags));
            bisonIds[auth.domain] = made.id;
            bisonLeads[auth.domain] = made.lead;
          }
        } else if (!(auth.domain in bisonLeads)) {
          // A retry with the id already known: read the lead again, so the plan
          // sees what Bison holds NOW. An attempt that attached but never
          // finalized left it IN the campaign, and re-attaching that would come
          // back as Bison's blanket "in other sequences" 422.
          bisonLeads[auth.domain] = await readLeadById(auth, bisonIds[auth.domain]);
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
        const bisonLead = bisonLeads[auth.domain] ?? null;
        // Names and states of the campaigns the lead is in sequence in, so
        // planTarget can tell this client's own live campaigns from the rest.
        const info = new Map();
        for (const id of inSequenceElsewhere(bisonLead, t.id)) info.set(id, await campaignInfo(auth, id));
        const plan = planTarget({
          bisonLead, campaignId: t.id, clientTag: batch.client_tag,
          campaignInfo: (id) => info.get(String(id)) ?? null, force: ALLOW_PARALLEL,
        });
        if (plan.action === "present") { markOk(item, t.id); continue; }            // nothing to attach
        if (plan.action === "blocked") { markBlocked(item, t.id, plan.reason); continue; } // recorded, never sent
        const key = `${auth.domain}|${t.id}`;
        if (!toAttach.has(key)) toAttach.set(key, { auth, campaignId: t.id, entries: [] });
        toAttach.get(key).entries.push({ item, leadId: bisonIds[auth.domain], forced: plan.force === true });
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
        // ONE ITEM MUST NEVER ABORT THE CYCLE. processItem handles its own
        // Bison/API failures; this catches what its internal try does NOT cover
        // — a programming error in the routing block, or a failed status write.
        // Without it such a throw rejects this Promise.all, skips attach and
        // finalize for every item in the cycle, and leaves all ~400 of them
        // 'pushing' until the 10-minute stale reclaim (measured 2026-09-25:
        // a stale `sided` reference did exactly that). Releasing the one item
        // puts it straight back to 'pending' instead.
        try {
          await processItem(items[n]);
        } catch (e) {
          console.error(`item ${items[n].email ?? items[n].lead_id} threw:`,
            e instanceof Error ? e.message : e);
          // failOrRetry, NOT releaseItems: releasing leaves attempts untouched,
          // so an item that throws every time would be re-claimed forever and
          // (with a per-install worker) starve its whole install. This retries
          // it MAX_ATTEMPTS times and then parks it as 'failed' with the error.
          await failOrRetry(items[n], token, e).catch(() => {});
        }
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
  const BISON_REFUSED = "Bison refused it: in another sequence, previously bounced, or unsubscribed there";
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
        await bison(auth, "POST", `/api/campaigns/${campaignId}/leads/attach-leads`,
          attachBody(chunk.map((e) => e.leadId), ALLOW_PARALLEL));
        // A 2xx is not proof: Bison leaves out what it will not add and still
        // answers 2xx. Leads planTarget expected to land without forcing do
        // (every one checked live, 2026-11-20). Forced ones are read back, a
        // couple per chunk, on campaigns that update at once.
        const forced = chunk.filter((e) => e.forced);
        let missing = null;
        if (forced.length && SPOT_CHECK > 0) {
          const target = await campaignInfo(auth, campaignId).catch(() => null);
          const state = String(target?.status ?? "").toLowerCase();
          if (target && state !== "active") {
            const v = await verifyForced({
              leadIds: forced.map((e) => e.leadId), campaignId, sample: SPOT_CHECK,
              getLead: (id) => readLeadById(auth, id).catch(() => undefined),
            });
            missing = v.missing;
            if (missing.size) {
              console.warn(`attach ${auth.domain} #${campaignId}: ${missing.size} of ${forced.length} forced lead(s) ` +
                `not in the campaign after a 2xx (read ${v.read})`);
            }
          }
        }
        for (const e of chunk) {
          if (missing?.has(String(e.leadId))) markBlocked(e.item, campaignId, "Bison did not add it, even with parallel sending on");
          else markOk(e.item, campaignId);
        }
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
              await bison(auth, "POST", `/api/campaigns/${campaignId}/leads/attach-leads`,
                attachBody([entry.leadId], ALLOW_PARALLEL));
              markOk(entry.item, campaignId);
            } catch (e2) {
              if (e2.status === 422 && BISON_BLOCKED_RE.test(e2.message)) markBlocked(entry.item, campaignId, BISON_REFUSED);
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
    const attached = new Set((item.attached_ids ?? []).map(String));
    for (const cid of okByItem.get(keyOf(item)) ?? []) attached.add(cid);
    const blocked = blockedByItem.get(keyOf(item)) ?? new Map();
    const attachedArr = [...attached];
    // Done = every target either holds the lead or will not take it (bounced,
    // unsubscribed, in the same client's other live sequence, or refused by
    // Bison) — retrying a refusal never succeeds. The reason is recorded per
    // campaign, so Exports says why (scripts/lib/push-attach.mjs itemOutcome).
    const outcome = itemOutcome({ targets: item.target_campaigns, attached, blocked });
    if (outcome?.status === "sent") {
      await setItem(item, token, { status: "sent", attempts: 0, attached_ids: attachedArr, claimed_at: null, error: outcome.error });
    } else if (outcome?.status === "skipped") {
      await setItem(item, token, { status: "skipped", attached_ids: attachedArr, claimed_at: null, error: outcome.error });
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
  `focus ${BATCH_FOCUS === 0 ? "all batches" : `${BATCH_FOCUS} per install`}, ` +
  `owns ${INSTANCE ?? (SPAN_ONLY ? "batches spanning 2 installs" : "every install")}, ` +
  `parallel sending ${ALLOW_PARALLEL ? "on" : "off"}, spot check ${SPOT_CHECK}, ` +
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
