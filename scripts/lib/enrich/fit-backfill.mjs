// Existing campaigns (2B.8): scoring every company already in campaigns, and
// one client's review list of the bad fits in its campaigns. Two kinds of
// fit_backfill_runs row, both worked a step at a time by the enrich-worker's
// fit loop (advanceBackfill):
//
//   score   every company behind any membership in the Email Bison copy
//           (bison_leads), whatever client its campaign maps to. The copy is
//           walked by (instance_url, bison_id) in pages of 5,000 (keyset,
//           never OFFSET), joined to leads by address for the facts, and each
//           company is queued once at priority 3; companies scored under the
//           current rule version and model, or by hand, are left out (a new
//           rule or model re-scores them, which is how "Re-score" works). A
//           2-second pause between pages, and none while a push is gathering:
//           the database's disk I/O budget has run out before under bulk work.
//           Then the pipeline's companies whose score is not current (scored
//           under another rule version or model) are queued again too, so a
//           scoring run is also the "Re-score" after a rule or model change.
//           An owner or admin starts it after seeing the estimate.
//   review  one client's campaigns (from push history and from live campaign
//           names, read by the route that starts it), their leads in the
//           copy (campaign_ids, GIN), and for each lead whose company is
//           blocked (company_fit_keys, the gate's own three lookups) an item
//           per campaign and company, with its leads. Nurture campaigns are
//           never listed, and a lead also in a Nurture campaign on that
//           install is flagged (never removed).
//
// The copy is stale for most rows (about two months): the list shows each
// item's oldest sync date, nothing is re-synced first (D40), and removal reads
// every lead live (scripts/lib/bison/fit-removal.mjs).

import { randomUUID } from "node:crypto";
import { enqueueCompanies, enqueueStalePipelineCompanies, pipelineToScore } from "./fit-score.mjs";
import { keysFromRow } from "./fit-keys.mjs";

export const BACKFILL_PAGE = 5000;
export const PAGE_PAUSE_MS = 2000;
/** Leads per company in the copy, measured (send-path notes 5.1): the estimate's divisor on a big copy. */
const LEADS_PER_COMPANY = 2.08;
/** Below this many rows the estimate counts exactly. */
const EXACT_BELOW = 200_000;
const CLAIM_STALE_MIN = 15;
/** Live Bison statuses a review lists (campaign-meta.ts: the ones that can still send). */
export const REVIEW_STATUSES = Object.freeze(["active", "launching", "paused", "draft"]);
const BISON_TIMEOUT_MS = 20_000;
const BISON_MAX_PAGES = 50;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {import("./settings.mjs").PipelineSettings} PipelineSettings
 * @typedef {{ instance_url: string, campaign_id: string, name: string | null, status: string | null,
 *             from: "push_history" | "live_name" }} ReviewCampaign
 */

const isNurture = (name) => /nurture/i.test(String(name ?? ""));

// ── The estimate ────────────────────────────────────────────────────────────

/**
 * What scoring n companies costs, as an estimate: per call the rule's tokens
 * (4 characters a token), our format part and about 80 tokens a company in,
 * about 90 tokens a company out (the answer and low-effort reasoning). The
 * send-path notes measured about $0.000045 a company at gpt-6-luna; this is
 * a little above it on purpose.
 *
 * @param {{ companies: number, batchSize: number, promptChars: number, price: { in: number, out: number } }} p
 */
export function estimateUsd({ companies, batchSize, promptChars, price }) {
  const calls = Math.ceil(Math.max(0, companies) / Math.max(1, batchSize));
  const inPerCall = Math.ceil(Math.max(0, promptChars) / 4) + 150 + 80 * batchSize;
  const outPerCall = 90 * batchSize;
  const usd = (calls * (inPerCall * price.in + outPerCall * price.out)) / 1e6;
  return { calls, usd: Math.round(usd * 100) / 100 };
}

/** The price the caps count for a model: its own, else the dearest held (as spend.mjs does). */
function priceFor(model, prices) {
  const own = prices?.[model];
  if (own && typeof own === "object") return { in: Number(own.in) || 0, out: Number(own.out) || 0 };
  const all = Object.entries(prices ?? {}).filter(([k, v]) => k !== "web_search_call" && v && typeof v === "object").map(([, v]) => v);
  return { in: Math.max(0, ...all.map((v) => Number(v.in) || 0)), out: Math.max(0, ...all.map((v) => Number(v.out) || 0)) };
}

/** The keys of the copy's members (bison_leads p, joined to leads l), as SQL. */
const COPY_KEYS = {
  email_key: `public.fn_fit_domain_ok(nullif(split_part(coalesce(l.email, lower(p.email), ''), '@', 2), ''))`,
  website_key: `public.fn_fit_domain_ok(coalesce(l.domain, p.cv_domain))`,
  name_key: `public.fn_fit_name_key(coalesce(l.company, p.company), coalesce(l.city, p.cv_city), l.state_code)`,
};

/**
 * The estimate an owner or admin sees before a scoring run: companies to
 * score (in the copy, less those scored under the current rule and model or
 * by hand; plus pipeline companies not scored yet or whose score is not
 * current), calls, dollars and days at the fit cap. Exact on a small copy; on a big one, the copy's row estimate
 * over 2.08 leads a company, less every current score.
 *
 * @param {Db} db
 * @param {PipelineSettings} settings
 */
export async function estimateScoreRun(db, settings) {
  const model = settings.models?.fit_score?.model ?? null;
  const ruleVersion = settings.fit_rule?.version ?? null;
  const { rows: [t] } = await db.query(`SELECT greatest(reltuples, 0)::bigint AS n FROM pg_class WHERE oid = 'public.bison_leads'::regclass`);
  const approxRows = Number(t?.n ?? 0);
  let campaignCompanies;
  let exact = false;
  if (approxRows < EXACT_BELOW) {
    const { rows: [c] } = await db.query(
      `WITH k AS (
         SELECT ${COPY_KEYS.email_key} AS ek, ${COPY_KEYS.website_key} AS wk, ${COPY_KEYS.name_key} AS nk
           FROM bison_leads p LEFT JOIN leads l ON l.email = lower(p.email)
          WHERE p.campaign_ids IS NOT NULL AND cardinality(p.campaign_ids) > 0
       ), c AS (
         SELECT DISTINCT CASE WHEN coalesce(ek, wk) IS NOT NULL THEN 'domain' ELSE 'name' END AS kk, coalesce(ek, wk, nk) AS kv
           FROM k WHERE coalesce(ek, wk, nk) IS NOT NULL
       )
       SELECT count(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM company_fit_keys fk JOIN company_fit f ON f.key_kind = fk.fit_kind AND f.key = fk.fit_key
                 WHERE fk.key_kind = c.kk AND fk.key = c.kv
                   AND (f.status = 'manual' OR (f.model = $1 AND f.rule_version IS NOT DISTINCT FROM $2))))::int AS todo
         FROM c`,
      [model, ruleVersion]
    );
    campaignCompanies = c.todo;
    exact = true;
  } else {
    const { rows: [s] } = await db.query(
      `SELECT count(*) FILTER (WHERE status = 'manual' OR (model = $1 AND rule_version IS NOT DISTINCT FROM $2))::int AS current
         FROM company_fit`,
      [model, ruleVersion]
    );
    campaignCompanies = Math.max(0, Math.round(approxRows / LEADS_PER_COMPANY) - s.current);
  }
  const pipe = await pipelineToScore(db, { model, ruleVersion });
  const pipeline = pipe.unscored + pipe.stale;
  const companies = campaignCompanies + pipeline;
  const { calls, usd } = estimateUsd({
    companies,
    batchSize: settings.fit_scoring.batch_size,
    promptChars: settings.fit_rule?.prompt?.length ?? 0,
    price: priceFor(model, settings.spend_caps.openai_prices),
  });
  const cap = settings.spend_caps.openai_usd_per_day.fit;
  return {
    companies,
    campaigns: campaignCompanies,
    pipeline,
    calls,
    usd,
    days_at_cap: cap > 0 ? Math.ceil((usd / cap) * 10) / 10 : null,
    cap,
    exact,
    copy_rows: approxRows,
    model,
    rule_version: ruleVersion,
  };
}

// ── Starting runs ───────────────────────────────────────────────────────────

const RUN_GOING = ["queued", "collecting", "scoring", "building"];

/**
 * A scoring run, confirmed (the route checks scoring is on and no run is
 * going, inside its transaction).
 *
 * @param {Db} db
 * @param {{ userId: string | null, estimate: Record<string, unknown> }} p
 */
export async function createScoreRun(db, { userId, estimate }) {
  const { rows: [r] } = await db.query(
    `INSERT INTO fit_backfill_runs (kind, status, estimate, confirmed_by, confirmed_at, created_by, progress)
     VALUES ('score', 'queued', $1::jsonb, $2, now(), $2, '{}'::jsonb)
     RETURNING *`,
    [JSON.stringify(estimate ?? {}), userId]
  );
  return r;
}

/**
 * A review run for one client, with the campaigns to review and each
 * install's Nurture campaign ids (the route reads both live from Bison).
 *
 * @param {Db} db
 * @param {{ tag: string, userId: string | null, campaigns: ReviewCampaign[], nurture?: Record<string, string[]>,
 *           errors?: string[] }} p
 */
export async function createReviewRun(db, { tag, userId, campaigns, nurture = {}, errors = [] }) {
  const { rows: [r] } = await db.query(
    `INSERT INTO fit_backfill_runs (kind, client_tag, status, campaigns, confirmed_by, confirmed_at, created_by, progress)
     VALUES ('review', $1, 'queued', $2::jsonb, $3, now(), $3, $4::jsonb)
     RETURNING *`,
    [tag, JSON.stringify(campaigns ?? []), userId, JSON.stringify({ nurture, errors })]
  );
  return r;
}

/**
 * Is a run of this kind going (for this client, for a review)?
 *
 * @param {Db} db
 * @param {"score" | "review"} kind
 * @param {string | null} [tag]
 */
export async function runGoing(db, kind, tag = null) {
  const { rows } = await db.query(
    `SELECT id, status FROM fit_backfill_runs
      WHERE kind = $1 AND status = ANY($2::text[]) AND ($3::text IS NULL OR client_tag = $3)
      ORDER BY created_at DESC LIMIT 1`,
    [kind, RUN_GOING, tag]
  );
  return rows[0] ?? null;
}

// ── Live campaign names (read free from Bison, as the pickers do) ───────────

/** EMAILBISON_KEYS as { install domain: token }; nothing else is ever sent a token. */
export function bisonKeys(env = process.env) {
  const out = {};
  try {
    const raw = String(env.EMAILBISON_KEYS ?? "").trim().replace(/^'|'$/g, "");
    for (const [d, k] of Object.entries(raw ? JSON.parse(raw) : {})) {
      const domain = String(d).replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
      if (domain && typeof k === "string" && k.trim()) out[domain] = k.trim();
    }
  } catch {
    /* not JSON: no install */
  }
  return out;
}

/** Bison drops ?search= from its own next links: put it back on every hop. */
function withSearch(url, term) {
  try {
    const u = new URL(url);
    u.searchParams.set("search", term);
    return u.toString();
  } catch {
    return url;
  }
}

async function bisonGet(fetchImpl, url, key) {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(BISON_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Every campaign a search finds on one install, following its next links with the term put back. */
async function searchInstall(fetchImpl, domain, key, term) {
  const rows = [];
  let url = withSearch(`https://${domain}/api/campaigns`, term);
  for (let page = 0; url && page < BISON_MAX_PAGES; page++) {
    const json = await bisonGet(fetchImpl, url, key);
    const data = Array.isArray(json?.data) ? json.data : [];
    rows.push(...data);
    if (!data.length) break;
    const next = typeof json?.links?.next === "string" && json.links.next ? json.links.next : null;
    url = next && new URL(next).hostname === domain ? withSearch(next, term) : null;
  }
  return rows;
}

/**
 * The client's campaigns on each install, read live and free: those whose
 * name starts with the tag ("TAG:" or "TAG ") and whose status can still send,
 * never a Nurture campaign; and each install's Nurture campaign ids (a lead
 * also in one is never removed).
 *
 * @param {string} tag
 * @param {Record<string, string | undefined>} [env]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ campaigns: Array<Omit<ReviewCampaign, "from">>, nurture: Record<string, string[]>,
 *                     statusOf: (domain: string, id: string) => Promise<string | null>, errors: string[] }>}
 */
export async function liveCampaignsFor(tag, env = process.env, fetchImpl = fetch) {
  const keys = bisonKeys(env);
  const t = String(tag ?? "").trim().toUpperCase();
  const campaigns = [];
  const nurture = {};
  const errors = [];
  for (const [domain, key] of Object.entries(keys)) {
    try {
      for (const c of await searchInstall(fetchImpl, domain, key, t)) {
        const name = String(c?.name ?? "");
        const upper = name.trim().toUpperCase();
        if (!(upper.startsWith(`${t}:`) || upper.startsWith(`${t} `))) continue;
        if (isNurture(name)) continue;
        const status = String(c?.status ?? "").trim().toLowerCase();
        if (!REVIEW_STATUSES.includes(status)) continue;
        campaigns.push({ instance_url: domain, campaign_id: String(c.id), name, status });
      }
      nurture[domain] = (await searchInstall(fetchImpl, domain, key, "nurture"))
        .filter((c) => isNurture(c?.name))
        .map((c) => String(c.id));
    } catch (e) {
      errors.push(`${domain}: ${e?.name === "TimeoutError" ? "timed out" : e?.message ?? "failed"}`);
    }
  }
  /** One campaign's live status by id, or null when it can't be read. */
  const statusOf = async (domain, id) => {
    const key = keys[domain];
    if (!key) return null;
    try {
      const json = await bisonGet(fetchImpl, `https://${domain}/api/campaigns/${encodeURIComponent(id)}`, key);
      return String(json?.data?.status ?? json?.status ?? "").trim().toLowerCase() || null;
    } catch {
      return null;
    }
  };
  return { campaigns, nurture, statusOf, errors };
}

/**
 * The campaigns to review for a client: its push history and its live
 * campaign names, both by default (D41), each once (push history first), only
 * those that can still send, never a Nurture campaign.
 *
 * @param {Db} db
 * @param {string} tag
 * @param {Awaited<ReturnType<typeof liveCampaignsFor>>} live
 * @returns {Promise<{ campaigns: ReviewCampaign[], errors: string[] }>}
 */
export async function reviewCampaignsFor(db, tag, live) {
  const { rows: pushed } = await db.query(
    `SELECT DISTINCT cc->>'instance_url' AS instance_url, cc->>'id' AS campaign_id, cc->>'name' AS name
       FROM push_batches b, jsonb_array_elements(b.campaigns) cc
      WHERE b.client_tag = $1 AND cc->>'instance_url' IS NOT NULL AND cc->>'id' IS NOT NULL`,
    [tag]
  );
  const liveBy = new Map(live.campaigns.map((c) => [`${c.instance_url}#${c.campaign_id}`, c]));
  /** @type {Map<string, ReviewCampaign>} */
  const out = new Map();
  const errors = [...live.errors];
  for (const p of pushed) {
    const id = `${p.instance_url}#${p.campaign_id}`;
    if (out.has(id) || isNurture(p.name)) continue;
    const seen = liveBy.get(id);
    const status = seen?.status ?? (await live.statusOf(p.instance_url, p.campaign_id));
    if (!status) {
      errors.push(`${p.instance_url}: campaign ${p.campaign_id} could not be read live, so it is left out`);
      continue;
    }
    if (!REVIEW_STATUSES.includes(status)) continue;
    out.set(id, { instance_url: p.instance_url, campaign_id: String(p.campaign_id), name: seen?.name ?? p.name ?? null, status, from: "push_history" });
  }
  for (const c of live.campaigns) {
    const id = `${c.instance_url}#${c.campaign_id}`;
    if (!out.has(id)) out.set(id, { ...c, from: "live_name" });
  }
  return { campaigns: [...out.values()], errors };
}

// ── Working runs ────────────────────────────────────────────────────────────

/** A transaction on its own client when the db is a pool, else on the client given. */
async function inTx(db, fn) {
  const own = typeof db.connect === "function" ? await db.connect() : null;
  const c = own ?? db;
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    own?.release();
  }
}

/** One page of the copy: each company queued once at priority 3, unless scored under the current rule and model. */
async function scorePage(db, run, settings) {
  const progress = run.progress ?? {};
  const after = progress.cursor ?? null;
  // Keyset on the primary key (instance_url, bison_id): the first page has no
  // lower bound, every later one starts after the last row read.
  const params = after ? [after.instance_url, after.bison_id, BACKFILL_PAGE] : [BACKFILL_PAGE];
  const { rows } = await db.query(
    `WITH p AS (
       SELECT b.instance_url, b.bison_id, b.email, b.company, b.cv_city, b.cv_domain, b.title, b.cv_category
         FROM bison_leads b
        WHERE b.campaign_ids IS NOT NULL AND cardinality(b.campaign_ids) > 0
          ${after ? "AND (b.instance_url, b.bison_id) > ($1::text, $2::bigint)" : ""}
        ORDER BY b.instance_url, b.bison_id
        LIMIT $${after ? 3 : 1})
     SELECT p.instance_url, p.bison_id, coalesce(l.company, p.company) AS company, coalesce(l.city, p.cv_city) AS city,
            coalesce(l.state_code, l.state) AS state, coalesce(l.domain, p.cv_domain) AS domain,
            coalesce(l.title, p.title) AS title, coalesce(l.general_industry, l.category, p.cv_category) AS industry,
            l.company_size, ${COPY_KEYS.email_key} AS email_key, ${COPY_KEYS.website_key} AS website_key,
            ${COPY_KEYS.name_key} AS name_key
       FROM p LEFT JOIN leads l ON l.email = lower(p.email)
      ORDER BY p.instance_url, p.bison_id`,
    params
  );
  const byKey = new Map();
  for (const r of rows) {
    const k = keysFromRow(r);
    if (!k) continue;
    const id = `${k.key_kind}:${k.key}`;
    const c = byKey.get(id) ?? { key_kind: k.key_kind, key: k.key, aliases: [], titles: new Set(), facts: null };
    c.aliases.push(...k.aliases);
    if (r.title) c.titles.add(r.title);
    c.facts ??= {
      name: r.company, domain: r.email_key ?? r.website_key ?? r.domain, city: r.city, state: r.state, industry: r.industry,
      employees: r.company_size == null ? "" : String(r.company_size),
    };
    byKey.set(id, c);
  }
  const items = [...byKey.values()].map((c) => ({
    key_kind: c.key_kind, key: c.key, aliases: c.aliases, priority: 3, source: "campaigns",
    facts: { ...c.facts, titles: [...c.titles].slice(0, 5) },
  }));
  const { queued } = await enqueueCompanies(db, items, {
    skip: "stale", model: settings.models?.fit_score?.model ?? null, ruleVersion: settings.fit_rule?.version ?? null,
  });
  const last = rows[rows.length - 1];
  return {
    done: rows.length < BACKFILL_PAGE,
    cursor: last ? { instance_url: last.instance_url, bison_id: Number(last.bison_id) } : after,
    leads: rows.length,
    companies: byKey.size,
    queued,
  };
}

/**
 * One page of one client's review: the copy's members of its campaigns on
 * one install whose company is blocked, as items (one per campaign and
 * company) and their leads. Counts are added as it goes; the build starts
 * them from zero.
 */
async function reviewPage(db, run, { pageSize = BACKFILL_PAGE } = {}) {
  const progress = run.progress ?? {};
  const campaigns = /** @type {ReviewCampaign[]} */ (Array.isArray(run.campaigns) ? run.campaigns : []);
  const installs = [...new Set(campaigns.map((c) => c.instance_url))].sort();
  const at = Number(progress.install ?? 0);
  if (at >= installs.length) return { done: true, progress };
  const inst = installs[at];
  const mine = campaigns.filter((c) => c.instance_url === inst);
  const byCampaign = new Map(mine.map((c) => [String(c.campaign_id), c]));
  const ids = [...byCampaign.keys()].filter((x) => /^\d+$/.test(x));
  const nurture = new Set((progress.nurture?.[inst] ?? []).map(String));
  const after = Number(progress.after ?? 0);
  const { rows } = await db.query(
    `WITH p AS (
       SELECT b.instance_url, b.bison_id, b.email, b.company, b.cv_city, b.cv_domain, b.campaigns, b.campaign_ids,
              b.replies, b.synced_at
         FROM bison_leads b
        WHERE b.instance_url = $1 AND b.campaign_ids && $2::bigint[] AND b.bison_id > $3
        ORDER BY b.bison_id
        LIMIT $4
     ), k AS (
       SELECT p.*, l.company AS l_company, l.city AS l_city, coalesce(l.state_code, l.state) AS l_state,
              coalesce(l.domain, p.cv_domain) AS l_domain,
              lower(split_part(coalesce(l.email, lower(p.email), ''), '@', 2)) AS ed,
              public.fn_bare_domain(coalesce(l.domain, p.cv_domain)) AS wd,
              public.fn_fit_name_key(coalesce(l.company, p.company), coalesce(l.city, p.cv_city), l.state_code) AS nk
         FROM p LEFT JOIN leads l ON l.email = lower(p.email)
     )
     SELECT k.bison_id, k.email, k.campaigns, k.campaign_ids, k.replies, k.synced_at,
            coalesce(k.l_company, k.company) AS company, coalesce(k.l_city, k.cv_city) AS city, k.l_state AS state,
            k.l_domain AS domain, bk.fit_kind, bk.fit_key, f.score, f.home_office, f.reason, f.model
       FROM k
       LEFT JOIN LATERAL (
         SELECT x.fit_kind, x.fit_key FROM company_fit_keys x
          WHERE x.blocked AND ((x.key_kind = 'domain' AND x.key IN (k.ed, k.wd)) OR (x.key_kind = 'name' AND x.key = k.nk))
          ORDER BY (x.key_kind = 'domain') DESC, x.key LIMIT 1) bk ON true
       LEFT JOIN company_fit f ON f.key_kind = bk.fit_kind AND f.key = bk.fit_key
      ORDER BY k.bison_id`,
    [inst, ids, after, pageSize]
  );
  /** @type {Map<string, any>} */
  const items = new Map();
  const leads = [];
  for (const r of rows) {
    if (!r.fit_kind) continue;
    const memberships = Array.isArray(r.campaigns) ? r.campaigns : [];
    const inNurture = (r.campaign_ids ?? []).some((id) => nurture.has(String(id)));
    for (const m of memberships) {
      const cid = String(m?.campaign_id ?? "");
      const camp = byCampaign.get(cid);
      if (!camp) continue;
      const replied = Number(m?.replies ?? 0) > 0 || String(m?.status ?? "") === "replied" || Number(r.replies ?? 0) > 0;
      const interested = m?.interested === true || m?.interested === "true";
      const id = `${cid}|${r.fit_kind}|${r.fit_key}`;
      const it = items.get(id) ?? {
        instance_url: inst, campaign_id: cid, campaign_name: camp.name ?? null, campaign_status: camp.status ?? null,
        campaign_from: camp.from ?? null, key_kind: r.fit_kind, key: r.fit_key, company: r.company ?? null,
        domain: r.domain ?? null, city: r.city ?? null, state: r.state ?? null, score: r.score, home_office: r.home_office,
        reason: r.reason, model: r.model, leads: 0, emails_sent: 0, replied: 0, interested: 0, removable: 0, oldest_sync: null,
      };
      it.leads++;
      it.emails_sent += Math.max(0, Number(m?.emails_sent ?? 0) || 0);
      if (replied) it.replied++;
      if (interested) it.interested++;
      if (!replied && !interested && !inNurture) it.removable++;
      const synced = r.synced_at instanceof Date ? r.synced_at.toISOString() : r.synced_at ? String(r.synced_at) : null;
      if (synced && (!it.oldest_sync || synced < it.oldest_sync)) it.oldest_sync = synced;
      items.set(id, it);
      leads.push({
        item: id, instance_url: inst, campaign_id: cid, bison_lead_id: Number(r.bison_id), email: r.email ?? null,
        membership_status: m?.status ?? null, replied, interested, in_nurture: inNurture, synced_at: synced,
      });
    }
  }
  if (items.size) {
    const { rows: ids2 } = await db.query(
      `INSERT INTO fit_review_items AS i (client_tag, backfill_id, instance_url, campaign_id, campaign_name, campaign_status,
              campaign_from, key_kind, key, company, domain, city, state, score, home_office, reason, model, leads, emails_sent,
              replied, interested, removable, oldest_sync, built_at)
       SELECT $1, $2, x.instance_url, x.campaign_id, x.campaign_name, x.campaign_status, x.campaign_from, x.key_kind, x.key,
              x.company, x.domain, x.city, x.state, x.score, x.home_office, x.reason, x.model, x.leads, x.emails_sent,
              x.replied, x.interested, x.removable, x.oldest_sync, now()
         FROM jsonb_to_recordset($3::jsonb) AS x(instance_url text, campaign_id text, campaign_name text, campaign_status text,
              campaign_from text, key_kind text, key text, company text, domain text, city text, state text, score smallint,
              home_office boolean, reason text, model text, leads int, emails_sent int, replied int, interested int,
              removable int, oldest_sync timestamptz)
       ON CONFLICT (client_tag, instance_url, campaign_id, key_kind, key) DO UPDATE
         SET backfill_id = EXCLUDED.backfill_id, campaign_name = EXCLUDED.campaign_name,
             campaign_status = EXCLUDED.campaign_status, campaign_from = EXCLUDED.campaign_from,
             company = coalesce(i.company, EXCLUDED.company), domain = coalesce(i.domain, EXCLUDED.domain),
             city = coalesce(i.city, EXCLUDED.city), state = coalesce(i.state, EXCLUDED.state),
             score = EXCLUDED.score, home_office = EXCLUDED.home_office, reason = EXCLUDED.reason, model = EXCLUDED.model,
             leads = i.leads + EXCLUDED.leads, emails_sent = i.emails_sent + EXCLUDED.emails_sent,
             replied = i.replied + EXCLUDED.replied, interested = i.interested + EXCLUDED.interested,
             removable = i.removable + EXCLUDED.removable,
             oldest_sync = CASE WHEN i.oldest_sync IS NULL THEN EXCLUDED.oldest_sync
                                WHEN EXCLUDED.oldest_sync IS NULL THEN i.oldest_sync
                                ELSE least(i.oldest_sync, EXCLUDED.oldest_sync) END,
             built_at = now()
       RETURNING i.id, i.campaign_id, i.key_kind, i.key`,
      [run.client_tag, run.id, JSON.stringify([...items.values()])]
    );
    const itemId = new Map(ids2.map((r) => [`${r.campaign_id}|${r.key_kind}|${r.key}`, r.id]));
    const rowsOut = leads.map((l) => ({ ...l, item_id: itemId.get(l.item) })).filter((l) => l.item_id != null);
    await db.query(
      `INSERT INTO fit_review_leads (item_id, instance_url, campaign_id, bison_lead_id, email, membership_status, replied,
              interested, in_nurture, synced_at)
       SELECT x.item_id, x.instance_url, x.campaign_id, x.bison_lead_id, x.email, x.membership_status, x.replied, x.interested,
              x.in_nurture, x.synced_at
         FROM jsonb_to_recordset($1::jsonb) AS x(item_id bigint, instance_url text, campaign_id text, bison_lead_id bigint,
              email text, membership_status text, replied boolean, interested boolean, in_nurture boolean, synced_at timestamptz)
       ON CONFLICT (item_id, instance_url, campaign_id, bison_lead_id) DO UPDATE
         SET email = EXCLUDED.email, membership_status = EXCLUDED.membership_status, replied = EXCLUDED.replied,
             interested = EXCLUDED.interested, in_nurture = EXCLUDED.in_nurture, synced_at = EXCLUDED.synced_at`,
      [JSON.stringify(rowsOut)]
    );
  }
  const last = rows[rows.length - 1];
  const installDone = rows.length < pageSize;
  return {
    done: false,
    progress: {
      ...progress,
      install: installDone ? at + 1 : at,
      after: installDone ? 0 : Number(last.bison_id),
      leads_seen: Number(progress.leads_seen ?? 0) + rows.length,
    },
    leads: rows.length,
    items: items.size,
  };
}

/** A review build starts clean: this client's review leads go, and its items' counts start from zero (decisions stay). */
async function startReview(db, run) {
  await db.query(
    `DELETE FROM fit_review_leads WHERE item_id IN (SELECT id FROM fit_review_items WHERE client_tag = $1)`,
    [run.client_tag]
  );
  await db.query(
    `UPDATE fit_review_items SET leads = 0, emails_sent = 0, replied = 0, interested = 0, removable = 0, oldest_sync = NULL
      WHERE client_tag = $1`,
    [run.client_tag]
  );
}

/** When a build ends: pending items it found nothing for go; decided ones stay, with no leads. */
async function finishReview(db, run) {
  await db.query(`DELETE FROM fit_review_items WHERE client_tag = $1 AND decision = 'pending' AND leads = 0`, [run.client_tag]);
  const { rows: [n] } = await db.query(`SELECT count(*)::int AS n FROM fit_review_items WHERE client_tag = $1 AND leads > 0`, [run.client_tag]);
  return n.n;
}

/**
 * One step of the oldest run going (a page of the copy, or a page of a
 * client's review), claimed with a token so two workers never work one run.
 * Returns the run id it worked, or null.
 *
 * @param {{ pool: Db, log?: (m: string) => void, settings: PipelineSettings, pageSize?: number }} p
 * @returns {Promise<string | null>}
 */
export async function advanceBackfill({ pool, log = () => {}, settings, pageSize = BACKFILL_PAGE }) {
  const token = randomUUID();
  const { rows: [run] } = await pool.query(
    `UPDATE fit_backfill_runs r SET claim_token = $1, claimed_at = now()
      WHERE r.id = (
        SELECT g.id FROM fit_backfill_runs g
         WHERE g.status = ANY($2::text[])
           AND (g.claim_token IS NULL OR g.claimed_at < now() - make_interval(mins => $3))
           AND (g.progress->>'next_at' IS NULL OR (g.progress->>'next_at')::timestamptz <= now())
         ORDER BY g.created_at
         LIMIT 1
           FOR UPDATE SKIP LOCKED)
      RETURNING r.*`,
    [token, RUN_GOING, CLAIM_STALE_MIN]
  );
  if (!run) return null;
  const save = (c, fields) => {
    const keys = Object.keys(fields);
    return c.query(
      `UPDATE fit_backfill_runs SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(", ")}, claim_token = NULL
        WHERE id = $1 AND claim_token = $2`,
      [run.id, token, ...keys.map((k) => (k === "progress" || k === "campaigns" ? JSON.stringify(fields[k]) : fields[k]))]
    );
  };
  try {
    if (run.kind === "score") {
      if (run.status === "queued") {
        await save(pool, { status: "collecting", progress: { ...(run.progress ?? {}), started_at: new Date().toISOString() } });
        return run.id;
      }
      if (run.status === "collecting") {
        const { rows: [g] } = await pool.query(`SELECT EXISTS (SELECT 1 FROM push_batches WHERE status = 'gathering') AS busy`);
        if (g.busy) {
          await save(pool, { progress: { ...(run.progress ?? {}), next_at: new Date(Date.now() + 30_000).toISOString(), paused: "a push is gathering" } });
          return null;
        }
        if (run.progress?.phase === "pipeline") {
          // The pipeline's companies whose score is not current, a page at a time.
          const step = await enqueueStalePipelineCompanies(pool, {
            after: Number(run.progress?.pipeline_after ?? 0),
            model: settings.models?.fit_score?.model ?? null,
            ruleVersion: settings.fit_rule?.version ?? null,
          });
          await save(pool, {
            status: step.done ? "scoring" : "collecting",
            progress: { ...(run.progress ?? {}), pipeline_after: step.last, paused: null, next_at: new Date(Date.now() + PAGE_PAUSE_MS).toISOString() },
            companies: Number(run.companies ?? 0) + step.seen,
            queued: Number(run.queued ?? 0) + step.queued,
          });
          return run.id;
        }
        const page = await scorePage(pool, run, settings);
        const progress = {
          ...(run.progress ?? {}), cursor: page.cursor, paused: null, phase: page.done ? "pipeline" : "copy",
          next_at: new Date(Date.now() + PAGE_PAUSE_MS).toISOString(),
        };
        await save(pool, {
          progress,
          leads_seen: Number(run.leads_seen ?? 0) + page.leads,
          companies: Number(run.companies ?? 0) + page.companies,
          queued: Number(run.queued ?? 0) + page.queued,
        });
        return run.id;
      }
      if (run.status === "scoring") {
        // Everything a scoring run queues is priority 3 (the copy's companies and the pipeline's re-scores).
        const { rows: [q] } = await pool.query(`SELECT count(*)::int AS n FROM company_fit_queue WHERE priority = 3`);
        if (q.n > 0) {
          await save(pool, { progress: { ...(run.progress ?? {}), waiting: q.n, next_at: new Date(Date.now() + 60_000).toISOString() } });
          return null;
        }
        await pool.query(
          `UPDATE fit_backfill_runs SET status = 'done', finished_at = now(), claim_token = NULL WHERE id = $1 AND claim_token = $2`,
          [run.id, token]
        );
        log(`fit: scoring run ${run.id.slice(0, 8)} done: ${run.queued} companies queued from ${run.leads_seen} leads`);
        return run.id;
      }
    }
    if (run.kind === "review") {
      if (run.status === "queued") {
        await inTx(pool, async (c) => {
          await startReview(c, run);
          await save(c, { status: "building", progress: { ...(run.progress ?? {}), install: 0, after: 0, leads_seen: 0 } });
        });
        return run.id;
      }
      if (run.status === "building") {
        return await inTx(pool, async (c) => {
          const step = await reviewPage(c, run, { pageSize });
          if (step.done) {
            const n = await finishReview(c, run);
            await c.query(
              `UPDATE fit_backfill_runs SET status = 'done', items = $3, finished_at = now(), claim_token = NULL
                WHERE id = $1 AND claim_token = $2`,
              [run.id, token, n]
            );
            log(`fit: review of ${run.client_tag} built: ${n} items`);
          } else {
            await save(c, { progress: step.progress, leads_seen: Number(step.progress.leads_seen ?? 0) });
          }
          return run.id;
        });
      }
    }
    await pool.query(`UPDATE fit_backfill_runs SET claim_token = NULL WHERE id = $1 AND claim_token = $2`, [run.id, token]);
    return null;
  } catch (e) {
    await pool
      .query(`UPDATE fit_backfill_runs SET claim_token = NULL, last_error = $3 WHERE id = $1 AND claim_token = $2`, [
        run.id, token, String(e?.message ?? e).slice(0, 500),
      ])
      .catch(() => {});
    throw e;
  }
}

/**
 * Builds one client's review list to the end, a page at a time (what the
 * worker does across ticks, for the tests and a manual run).
 *
 * @param {Db & { connect?: Function }} db
 * @param {string} runId
 * @param {{ pageSize?: number }} [opts]
 * @returns {Promise<{ items: number, leads: number }>}
 */
export async function buildReview(db, runId, { pageSize = BACKFILL_PAGE } = {}) {
  const get = async () => (await db.query(`SELECT * FROM fit_backfill_runs WHERE id = $1`, [runId])).rows[0];
  let run = await get();
  if (!run || run.kind !== "review") throw new Error("Not a review run");
  if (run.status === "queued") {
    await inTx(db, async (c) => {
      await startReview(c, run);
      await c.query(`UPDATE fit_backfill_runs SET status = 'building', progress = $2::jsonb WHERE id = $1`, [
        runId, JSON.stringify({ ...(run.progress ?? {}), install: 0, after: 0, leads_seen: 0 }),
      ]);
    });
  }
  for (let guard = 0; guard < 100_000; guard++) {
    run = await get();
    if (run.status !== "building") break;
    const done = await inTx(db, async (c) => {
      const step = await reviewPage(c, run, { pageSize });
      if (step.done) {
        const n = await finishReview(c, run);
        await c.query(`UPDATE fit_backfill_runs SET status = 'done', items = $2, finished_at = now() WHERE id = $1`, [runId, n]);
        return true;
      }
      await c.query(`UPDATE fit_backfill_runs SET progress = $2::jsonb, leads_seen = $3 WHERE id = $1`, [
        runId, JSON.stringify(step.progress), Number(step.progress.leads_seen ?? 0),
      ]);
      return false;
    });
    if (done) break;
  }
  const { rows: [r] } = await db.query(
    `SELECT count(DISTINCT i.id)::int AS items, count(l.*)::int AS leads
       FROM fit_review_items i LEFT JOIN fit_review_leads l ON l.item_id = i.id
      WHERE i.client_tag = $1 AND i.leads > 0`,
    [run.client_tag]
  );
  return { items: r.items, leads: r.leads };
}
