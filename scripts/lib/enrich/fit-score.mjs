// The fit scorer (2B.3): companies scored 1 to 5, with a home-office flag
// and a short reason, by OutboundHero's rule (enrich_settings.fit_rule.prompt),
// sent verbatim. Our only addition is a fixed format part: the companies as a
// JSON list with ids, and the answer format. It says nothing about what a
// good fit is (D16).
//
// It is a loop of the enrich-worker (fitLoopOnce, called by its fit loop),
// separate from the AI Ark loop, so scoring never holds up pulls. It works
// company_fit_queue in priority order:
//   1  companies of pushes waiting in 'scoring', and companies the push-time
//      check found unscored (fit-push.mjs);
//   2  pipeline companies that pass the client's rules (enrich_companies.passes),
//      queued here from enrich_companies when their row has finished;
//   3  companies in existing campaigns (fit-backfill.mjs).
//
// One call scores fit_scoring.batch_size companies (25), fit_scoring.calls_in_flight
// calls at once (2), on models.fit_score (gpt-6-luna, reasoning effort low),
// with no tools and one send per attempt. Each call checks the day's fit cap
// first (spend_caps.openai_usd_per_day.fit) and adds what it cost after.
// A company missing from an answer, or answered with something that isn't a
// score, is tried again on its own; after 3 tries it is written 'unscorable'.
// A company the model says can't be scored (score null) is 'unscorable' at once.
//
// Writes: company_fit (never over a manual score), then the company's aliases
// (company_fit_keys), then the score copied onto the pipeline's company rows.
// An unchanged input hash (the facts, the rule version and the model) skips
// the call.
//
// It does nothing while scoring is off, the rule is not set ("Waiting for the
// rule"), models.fit_score is not set, OPENAI_API_KEY is missing, or OpenAI
// refused for billing (the loop then stops until scoring is switched off and
// on again, or the worker restarts).

import { createHash, randomUUID } from "node:crypto";
import { addOpenAiSpend, CAP_REACHED, spendAllowed } from "./spend.mjs";
import { addAliases, COPY_TO_COMPANIES_SQL, keysFromRow } from "./fit-keys.mjs";

export const FIT_MAX_TRIES = 3;
export const REASON_MAX = 300;
export const DESCRIPTION_MAX = 500;
export const TITLES_MAX = 5;
export const FIT_SOURCES = Object.freeze(["pipeline", "campaigns", "push"]);
const CLAIM_STALE_MIN = 15;
const PIPELINE_PAGE = 500;
const CALL_TIMEOUT_MS = 120_000;
const BACKOFF_MS = [60_000, 120_000, 300_000, 900_000];
const OPENAI_URL = "https://api.openai.com/v1/responses";
export const WAITING_FOR_RULE = "Waiting for the rule";

/**
 * The fixed format part (ours). It names the answer's fields and nothing about
 * what a good fit or a home office is: that is the rule's.
 */
export const FIT_FORMAT_TEXT = [
  "Use the rule above to score each company in the JSON list below.",
  "Each company has an id and the facts held about it; a fact that is missing is not known.",
  "Answer with exactly one result per company, with its id.",
  "score: a whole number from 1 to 5 as the rule gives it, or null when the company can't be scored from these facts.",
  "home_office: true or false as the rule's home-office flag gives it, or null when it can't be told.",
  "reason: one short sentence.",
].join("\n");

/** The strict answer schema: { results: [{ id, score, home_office, reason }] }. */
export const FIT_ANSWER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "score", "home_office", "reason"],
        properties: {
          id: { type: "string" },
          score: { type: ["integer", "null"] },
          home_office: { type: ["boolean", "null"] },
          reason: { type: "string" },
        },
      },
    },
  },
});

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {import("./settings.mjs").PipelineSettings} PipelineSettings
 * @typedef {import("./fit-keys.mjs").FitKey} FitKey
 * @typedef {{ name?: string, domain?: string, city?: string, state?: string, industry?: string, description?: string,
 *             employees?: string, company_type?: string, titles?: string[] }} FitFacts
 */

// ── The loop's state, for the heartbeat and the tab ─────────────────────────

const loop = {
  state: "idle",
  why: /** @type {string | null} */ (null),
  last_error: /** @type {string | null} */ (null),
  last_error_at: /** @type {string | null} */ (null),
  billing_stopped: false,
  stop_seen_off: false,
  backoff_until: 0,
  failures: 0,
  calls: 0,
  scored: 0,
  unscorable: 0,
  reused: 0,
};

/** What the fit loop is doing, for the worker's heartbeat (info.fit) and the fit panel. */
export function fitLoopStatus() {
  return {
    state: loop.state,
    why: loop.why,
    last_error: loop.last_error,
    last_error_at: loop.last_error_at,
    billing_stopped: loop.billing_stopped,
    backoff_until: loop.backoff_until ? new Date(loop.backoff_until).toISOString() : null,
    failures: loop.failures,
    calls: loop.calls,
    scored: loop.scored,
    unscorable: loop.unscorable,
    reused: loop.reused,
  };
}

/** For tests: forget the loop's state. */
export function resetFitLoop() {
  Object.assign(loop, {
    state: "idle", why: null, last_error: null, last_error_at: null, billing_stopped: false, stop_seen_off: false,
    backoff_until: 0, failures: 0, calls: 0, scored: 0, unscorable: 0, reused: 0,
  });
}

function noteError(message) {
  loop.last_error = String(message).slice(0, 500);
  loop.last_error_at = new Date().toISOString();
}

/**
 * Can the scorer run? { ready, why }. Scoring off, no rule, no model, no key,
 * or a billing stop each keep it idle and say so.
 *
 * @param {PipelineSettings} settings
 * @param {Record<string, string | undefined>} env
 */
export function fitReadiness(settings, env) {
  if (!settings?.fit_scoring?.enabled) return { ready: false, why: "Scoring is off" };
  if (!settings.fit_rule?.prompt) return { ready: false, why: WAITING_FOR_RULE };
  if (!settings.models?.fit_score?.model) return { ready: false, why: "No model is set for fit_score" };
  if (!String(env?.OPENAI_API_KEY ?? "").trim()) return { ready: false, why: "Needs OPENAI_API_KEY on the worker" };
  return { ready: true, why: null };
}

// ── Pure parts ──────────────────────────────────────────────────────────────

/** JSON with sorted keys, so equal facts always hash the same. */
function stable(v) {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
}

/**
 * The hash of what a score depends on: the facts, the rule version and the
 * model. The same hash on a stored score means a call would change nothing.
 *
 * @param {{ facts: FitFacts, ruleVersion: string | null, model: string }} p
 */
export function inputsHash({ facts, ruleVersion, model }) {
  return createHash("sha256").update(stable({ facts: facts ?? {}, rule: ruleVersion ?? null, model })).digest("hex").slice(0, 40);
}

const cut = (v, max) => Array.from(String(v ?? "").replace(/\s+/g, " ").trim()).slice(0, max).join("");

/**
 * A company's facts as the scorer is given them: only the fields that hold
 * something, the description at most 500 characters, up to 5 titles.
 *
 * @param {Record<string, unknown>} raw
 * @returns {FitFacts}
 */
export function cleanFacts(raw) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of ["name", "domain", "city", "state", "industry", "employees", "company_type"]) {
    const v = cut(raw?.[k], 200);
    if (v) out[k] = v;
  }
  const d = cut(raw?.description, DESCRIPTION_MAX);
  if (d) out.description = d;
  const titles = Array.isArray(raw?.titles)
    ? [...new Set(raw.titles.map((t) => cut(t, 120)).filter(Boolean))].slice(0, TITLES_MAX)
    : [];
  if (titles.length) out.titles = titles;
  return /** @type {FitFacts} */ (out);
}

/**
 * The OpenAI Responses request for one call: the rule verbatim as the
 * instructions, our format part and the companies as the input, a strict JSON
 * answer, no tools.
 *
 * @param {{ prompt: string, companies: Array<{ id: string } & FitFacts>, model: string, effort?: string | null }} p
 */
export function buildFitRequest({ prompt, companies, model, effort = null }) {
  return {
    model,
    instructions: prompt,
    input: `${FIT_FORMAT_TEXT}\n\nCompanies:\n${JSON.stringify(companies)}`,
    ...(effort ? { reasoning: { effort } } : {}),
    text: { format: { type: "json_schema", name: "fit_scores", strict: true, schema: FIT_ANSWER_SCHEMA } },
  };
}

/**
 * The answer, checked: every id answered once, a score a whole number 1 to 5
 * (or null: can't be scored), a reason cut to 300 characters. `bad` holds the
 * ids not answered, answered twice, or answered with something else.
 *
 * @param {any} json  OpenAI's answer
 * @param {string[]} ids
 * @returns {{ ok: Array<{ id: string, score: number | null, home_office: boolean | null, reason: string | null }>, bad: string[], parsed: boolean }}
 */
export function parseFitAnswer(json, ids) {
  const textOut =
    json?.output_text ??
    (Array.isArray(json?.output) ? json.output : []).flatMap((o) => o?.content ?? []).find((c) => c?.type === "output_text")?.text;
  let parsed = null;
  try {
    parsed = typeof textOut === "string" ? JSON.parse(textOut) : null;
  } catch {
    parsed = null;
  }
  const want = new Set(ids);
  const byId = new Map();
  const twice = new Set();
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    const id = typeof r?.id === "string" ? r.id.trim() : typeof r?.id === "number" ? String(r.id) : null;
    if (!id || !want.has(id)) continue;
    if (byId.has(id)) twice.add(id);
    else byId.set(id, r);
  }
  const ok = [];
  const bad = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r || twice.has(id)) {
      bad.push(id);
      continue;
    }
    const score = r.score;
    if (!(score === null || (Number.isInteger(score) && score >= 1 && score <= 5))) {
      bad.push(id);
      continue;
    }
    const reason = cut(typeof r.reason === "string" ? r.reason : "", REASON_MAX);
    ok.push({ id, score, home_office: typeof r.home_office === "boolean" ? r.home_office : null, reason: reason || null });
  }
  return { ok, bad, parsed: Boolean(parsed) };
}

/** Is an OpenAI refusal about billing (or the key)? Those stop the loop instead of being retried. */
function billingRefusal(status, json) {
  const code = String(json?.error?.code ?? json?.error?.type ?? "").toLowerCase();
  if (status === 402) return "OpenAI refused for billing (402)";
  if (status === 429 && /quota|billing/.test(code)) return `OpenAI refused for billing (${code})`;
  if (status === 401 || status === 403) return `OpenAI refused the key (${status})`;
  return null;
}

// ── The queue ───────────────────────────────────────────────────────────────

const ENQUEUE_SQL = `
  INSERT INTO company_fit_queue AS q (key_kind, key, priority, facts, aliases, source)
  SELECT x.key_kind, x.key, x.priority, x.facts, coalesce(x.aliases, '[]'::jsonb), x.source
    FROM jsonb_to_recordset($1::jsonb) AS x(key_kind text, key text, priority smallint, facts jsonb, aliases jsonb, source text)
   WHERE CASE $2::text
           WHEN 'unscored' THEN NOT EXISTS (SELECT 1 FROM company_fit_keys k WHERE k.key_kind = x.key_kind AND k.key = x.key)
           WHEN 'stale' THEN NOT EXISTS (
             SELECT 1 FROM company_fit_keys k JOIN company_fit f ON f.key_kind = k.fit_kind AND f.key = k.fit_key
              WHERE k.key_kind = x.key_kind AND k.key = x.key
                AND (f.status = 'manual' OR (f.model = $3 AND f.rule_version IS NOT DISTINCT FROM $4)))
           ELSE true
         END
  ON CONFLICT (key_kind, key) DO UPDATE
    SET priority = least(q.priority, EXCLUDED.priority),
        aliases = (SELECT coalesce(jsonb_agg(DISTINCT a), '[]'::jsonb) FROM jsonb_array_elements(q.aliases || EXCLUDED.aliases) a),
        facts = CASE WHEN q.claim_token IS NULL AND EXCLUDED.priority <= q.priority THEN EXCLUDED.facts ELSE q.facts END,
        source = CASE WHEN EXCLUDED.priority < q.priority THEN EXCLUDED.source ELSE q.source END
  RETURNING (xmax = 0) AS inserted, key_kind, key`;

/**
 * Queues companies for the scorer, once each: a company already queued keeps
 * one row, at the higher priority, with the aliases of both.
 * skip: "unscored" leaves out keys that already have a score (the push paths),
 * "stale" leaves out keys scored under the current rule version and model, or
 * by hand (the scoring run), null queues every one.
 *
 * @param {Db} db
 * @param {Array<FitKey & { aliases?: FitKey[], facts: FitFacts, priority: number, source: string }>} items
 * @param {{ skip?: "unscored" | "stale" | null, model?: string | null, ruleVersion?: string | null }} [opts]
 * @returns {Promise<{ queued: number, touched: Array<FitKey & { inserted: boolean }> }>}
 */
export async function enqueueCompanies(db, items, { skip = null, model = null, ruleVersion = null } = {}) {
  const byKey = new Map();
  for (const it of items ?? []) {
    if (!it?.key || !["domain", "name"].includes(it.key_kind)) continue;
    if (!FIT_SOURCES.includes(it.source)) throw new Error(`Unknown fit source "${it.source}"`);
    const id = `${it.key_kind}:${it.key}`;
    const prev = byKey.get(id);
    const aliases = [...(prev?.aliases ?? []), ...(it.aliases ?? [])].filter((a) => a?.key && !(a.key_kind === it.key_kind && a.key === it.key));
    const uniq = [...new Map(aliases.map((a) => [`${a.key_kind}:${a.key}`, { key_kind: a.key_kind, key: a.key }])).values()];
    if (!prev || it.priority < prev.priority) byKey.set(id, { ...it, aliases: uniq });
    else byKey.set(id, { ...prev, aliases: uniq });
  }
  if (!byKey.size) return { queued: 0, touched: [] };
  const list = [...byKey.values()].map((it) => ({
    key_kind: it.key_kind, key: it.key, priority: Math.max(1, Math.min(3, Math.trunc(it.priority))),
    facts: cleanFacts(it.facts ?? {}), aliases: it.aliases, source: it.source,
  }));
  const { rows } = await db.query(ENQUEUE_SQL, [JSON.stringify(list), skip ?? "none", model, ruleVersion]);
  return { queued: rows.filter((r) => r.inserted).length, touched: rows.map((r) => ({ key_kind: r.key_kind, key: r.key, inserted: r.inserted })) };
}

/**
 * One company queued for the scorer (enqueueCompanies for one).
 *
 * @param {Db} db
 * @param {{ key: FitKey, aliases?: FitKey[], facts: FitFacts, priority?: number, source: string }} p
 */
export async function enqueueCompany(db, { key, aliases = [], facts, priority = 3, source }) {
  const { queued } = await enqueueCompanies(db, [{ ...key, aliases, facts, priority, source }]);
  return queued > 0;
}

/**
 * Claims up to n queued companies, highest priority first, with a claim token.
 * Claims older than 15 minutes (a worker that died) are taken back first.
 *
 * @param {Db} db
 * @param {number} n
 * @returns {Promise<{ token: string, rows: any[] }>}
 */
export async function claimQueue(db, n) {
  await db.query(
    `UPDATE company_fit_queue SET claim_token = NULL, claimed_at = NULL
      WHERE claim_token IS NOT NULL AND claimed_at < now() - make_interval(mins => $1)`,
    [CLAIM_STALE_MIN]
  );
  const token = randomUUID();
  // MATERIALIZED: the locked page is read once. As a plain IN (...) sub-select
  // the planner may run it again, and with SKIP LOCKED a second run can hand
  // back other rows, so one claim could take more than n.
  const { rows } = await db.query(
    `WITH c AS MATERIALIZED (
       SELECT key_kind, key FROM company_fit_queue
        WHERE claim_token IS NULL
        ORDER BY priority, enqueued_at, key_kind, key
        LIMIT $2
          FOR UPDATE SKIP LOCKED)
     UPDATE company_fit_queue q SET claim_token = $1, claimed_at = now()
       FROM c WHERE q.key_kind = c.key_kind AND q.key = c.key
     RETURNING q.*`,
    [token, Math.max(1, Math.trunc(n))]
  );
  rows.sort((a, b) => a.priority - b.priority || new Date(a.enqueued_at).getTime() - new Date(b.enqueued_at).getTime());
  return { token, rows };
}

/** Lets claimed rows go back to the queue, untouched but for the error and, when counted, a try. */
async function release(db, token, keys, { error = null, tried = false } = {}) {
  if (!keys.length) return;
  await db.query(
    `UPDATE company_fit_queue q
        SET claim_token = NULL, claimed_at = NULL, last_error = coalesce($3, q.last_error),
            attempts = q.attempts + CASE WHEN $4 THEN 1 ELSE 0 END
       FROM jsonb_to_recordset($2::jsonb) AS x(key_kind text, key text)
      WHERE q.key_kind = x.key_kind AND q.key = x.key AND q.claim_token = $1`,
    [token, JSON.stringify(keys.map((k) => ({ key_kind: k.key_kind, key: k.key }))), error ? String(error).slice(0, 500) : null, tried]
  );
}

// ── Writing scores ──────────────────────────────────────────────────────────

/**
 * @typedef {FitKey & { score: number | null, home_office: boolean | null, reason: string | null,
 *                      status: "scored" | "unscorable", inputs_hash: string | null, source: string,
 *                      aliases?: FitKey[] }} FitResult
 */

/**
 * Writes scores: company_fit (never over a manual score), then each
 * company's aliases, then the copies on the pipeline's company rows, then the
 * queue rows are let go (only those this claim holds, when a token is given).
 *
 * @param {Db} db
 * @param {FitResult[]} results
 * @param {{ model: string | null, ruleVersion: string | null, token?: string | null }} opts
 * @returns {Promise<number>}  scores written (a manual score kept counts as not written)
 */
export async function writeScores(db, results, { model, ruleVersion, token = null }) {
  const list = (results ?? []).filter((r) => r?.key && ["domain", "name"].includes(r.key_kind));
  if (!list.length) return 0;
  const rows = list.map((r) => ({
    key_kind: r.key_kind,
    key: r.key,
    score: r.status === "scored" ? r.score : null,
    home_office: r.home_office ?? null,
    reason: r.reason ? cut(r.reason, REASON_MAX) : null,
    status: r.status === "scored" && Number.isInteger(r.score) ? "scored" : "unscorable",
    inputs_hash: r.inputs_hash ?? null,
    source: FIT_SOURCES.includes(r.source) ? r.source : "campaigns",
  }));
  const { rows: written } = await db.query(
    `INSERT INTO company_fit AS f (key_kind, key, score, home_office, reason, status, model, rule_version, inputs_hash, source, scored_by, scored_at)
     SELECT x.key_kind, x.key, x.score, x.home_office, x.reason, x.status, $2, $3, x.inputs_hash, x.source, NULL, now()
       FROM jsonb_to_recordset($1::jsonb)
            AS x(key_kind text, key text, score smallint, home_office boolean, reason text, status text, inputs_hash text, source text)
     ON CONFLICT (key_kind, key) DO UPDATE
       SET score = EXCLUDED.score, home_office = EXCLUDED.home_office, reason = EXCLUDED.reason, status = EXCLUDED.status,
           model = EXCLUDED.model, rule_version = EXCLUDED.rule_version, inputs_hash = EXCLUDED.inputs_hash,
           source = EXCLUDED.source, scored_by = NULL, scored_at = now()
       WHERE f.status <> 'manual'
     RETURNING f.key_kind, f.key`,
    [JSON.stringify(rows), model, ruleVersion]
  );
  // Aliases point at the score, whoever wrote it (a manual score keeps them too).
  const aliases = list.flatMap((r) => (r.aliases ?? []).map((a) => ({ key_kind: a.key_kind, key: a.key, fit_kind: r.key_kind, fit_key: r.key })));
  await addAliases(db, aliases);
  const canon = JSON.stringify(list.map((r) => ({ key_kind: r.key_kind, key: r.key })));
  await db.query(COPY_TO_COMPANIES_SQL, [canon]);
  await db.query(
    `DELETE FROM company_fit_queue q USING jsonb_to_recordset($1::jsonb) AS x(key_kind text, key text)
      WHERE q.key_kind = x.key_kind AND q.key = x.key AND ($2::uuid IS NULL OR q.claim_token = $2)`,
    [canon, token]
  );
  return written.length;
}

// ── Pipeline companies into the queue ───────────────────────────────────────

/**
 * Pipeline companies that pass the client's rules and have no score yet
 * (enrich_companies: passes, no fit key yet): each gets its fit key, and is
 * queued at priority 2, or, when its key already has a score (scored from the
 * campaigns or for another client), takes that score at once. A company with
 * no key at all (no domain and no state) is marked so and not asked again.
 *
 * @param {Db} db
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ queued: number, copied: number, keyless: number }>}
 */
/**
 * A pipeline company's fields as the scorer's facts read them ($1 is the
 * limit; the caller adds the WHERE): its name, domain, place, industry and
 * size from enrich_companies, AI Ark's description and company type from its
 * input cells, the titles held there (held_people), and the domains of its
 * contacts' emails (aliases).
 */
const pipelineSql = (where) => `
  SELECT e.row_id, e.company, e.domain, e.city, e.state, e.industry, e.employees, e.fit_key_kind, e.fit_key,
         public.fn_fit_domain_ok(e.domain) AS website_key,
         public.fn_fit_name_key(e.company, e.city, e.state) AS name_key,
         (SELECT jsonb_object_agg(c.column_key, c.value) FROM enrich_cells c
           WHERE c.row_id = e.row_id AND c.column_key IN ('description', 'company_type', 'held_people')
             AND c.value IS NOT NULL) AS cells,
         (SELECT coalesce(jsonb_agg(DISTINCT d.k), '[]'::jsonb)
            FROM (SELECT public.fn_fit_domain_ok(split_part(ct.email, '@', 2)) AS k
                    FROM enrich_contacts ct WHERE ct.company_row_id = e.row_id AND ct.email IS NOT NULL) d
           WHERE d.k IS NOT NULL) AS contact_domains
    FROM enrich_companies e
   WHERE ${where}
   ORDER BY e.row_id
   LIMIT $1`;

/** One pipeline company as a queue item, under the given key (its own, else worked out from its fields). */
function pipelineItem(r, k, priority) {
  const cells = r.cells ?? {};
  const titles = Array.isArray(cells.held_people?.titles) ? cells.held_people.titles : [];
  const aliases = [...k.aliases, ...(r.contact_domains ?? []).map((d) => ({ key_kind: "domain", key: d }))];
  return {
    row_id: r.row_id,
    key_kind: k.key_kind,
    key: k.key,
    aliases,
    priority,
    source: "pipeline",
    facts: {
      name: r.company, domain: r.website_key ?? r.domain, city: r.city, state: r.state, industry: r.industry,
      employees: r.employees, description: typeof cells.description === "string" ? cells.description : "",
      company_type: typeof cells.company_type === "string" ? cells.company_type : "", titles,
    },
  };
}

export async function enqueuePipelineCompanies(db, { limit = PIPELINE_PAGE } = {}) {
  const { rows } = await db.query(pipelineSql(`e.passes IS TRUE AND e.fit_key IS NULL AND e.fit_scored_at IS NULL`), [
    Math.max(1, limit),
  ]);
  if (!rows.length) return { queued: 0, copied: 0, keyless: 0 };
  const keyless = [];
  const items = [];
  for (const r of rows) {
    const k = keysFromRow({ website_key: r.website_key, name_key: r.name_key });
    if (!k) {
      keyless.push(r.row_id);
      continue;
    }
    items.push(pipelineItem(r, k, 2));
  }
  if (keyless.length) {
    await db.query(
      `UPDATE enrich_companies SET fit_scored_at = now(), fit_reason = $2, updated_at = now() WHERE row_id = ANY($1::bigint[])`,
      [keyless, "No key to score: no domain that stands for the company, and no state"]
    );
  }
  if (!items.length) return { queued: 0, copied: 0, keyless: keyless.length };
  // Each row takes its key now, so the score finds it when it is written.
  await db.query(
    `UPDATE enrich_companies e SET fit_key_kind = x.key_kind, fit_key = x.key, updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS x(row_id bigint, key_kind text, key text)
      WHERE e.row_id = x.row_id`,
    [JSON.stringify(items.map((i) => ({ row_id: i.row_id, key_kind: i.key_kind, key: i.key })))]
  );
  // A key that already has a score: the row takes it, and the company's aliases point at it.
  const { rows: held } = await db.query(
    `SELECT DISTINCT x.key_kind, x.key, k.fit_kind, k.fit_key
       FROM jsonb_to_recordset($1::jsonb) AS x(key_kind text, key text)
       JOIN company_fit_keys k ON k.key_kind = x.key_kind AND k.key = x.key`,
    [JSON.stringify(items.map((i) => ({ key_kind: i.key_kind, key: i.key })))]
  );
  const scored = new Map(held.map((h) => [`${h.key_kind}:${h.key}`, h]));
  const fresh = items.filter((i) => !scored.has(`${i.key_kind}:${i.key}`));
  const copied = items.filter((i) => scored.has(`${i.key_kind}:${i.key}`));
  if (copied.length) {
    await addAliases(
      db,
      copied.flatMap((i) => {
        const h = scored.get(`${i.key_kind}:${i.key}`);
        return i.aliases.map((a) => ({ ...a, fit_kind: h.fit_kind, fit_key: h.fit_key }));
      })
    );
    await db.query(COPY_TO_COMPANIES_SQL, [JSON.stringify(held.map((h) => ({ key_kind: h.fit_kind, key: h.fit_key })))]);
  }
  const { queued } = await enqueueCompanies(db, fresh);
  return { queued, copied: copied.length, keyless: keyless.length };
}

/**
 * The SQL condition of a pipeline company whose score is not current: scored
 * under another rule version or model, and not set by hand (the parameter
 * numbers of the model and the rule version are given). A re-score (a scoring run after the rule or the model changed)
 * queues these again.
 */
const stalePipeline = (model, rule) => `e.passes IS TRUE AND e.fit_key IS NOT NULL
   AND EXISTS (SELECT 1 FROM company_fit_keys k JOIN company_fit f ON f.key_kind = k.fit_kind AND f.key = k.fit_key
                WHERE k.key_kind = e.fit_key_kind AND k.key = e.fit_key AND f.status <> 'manual'
                  AND (f.model IS DISTINCT FROM ${model}::text OR f.rule_version IS DISTINCT FROM ${rule}::text))`;

/**
 * Pipeline companies whose score is not current, after a row id, queued again
 * at priority 3 under their own key: the pipeline's part of a scoring run (a
 * "Re-score" after the rule or the model changed). A page at a time.
 *
 * @param {Db} db
 * @param {{ after?: number, limit?: number, model: string | null, ruleVersion: string | null }} p
 * @returns {Promise<{ queued: number, seen: number, last: number, done: boolean }>}
 */
export async function enqueueStalePipelineCompanies(db, { after = 0, limit = PIPELINE_PAGE, model, ruleVersion }) {
  const { rows } = await db.query(pipelineSql(`e.row_id > $2 AND ${stalePipeline("$3", "$4")}`), [
    Math.max(1, limit), after, model, ruleVersion,
  ]);
  const items = rows.map((r) => {
    const own = keysFromRow({ website_key: r.website_key, name_key: r.name_key });
    const aliases = (own ? [{ key_kind: own.key_kind, key: own.key }, ...own.aliases] : []).filter(
      (a) => !(a.key_kind === r.fit_key_kind && a.key === r.fit_key)
    );
    return pipelineItem(r, { key_kind: r.fit_key_kind, key: r.fit_key, aliases }, 3);
  });
  const { queued } = await enqueueCompanies(db, items, { skip: "stale", model, ruleVersion });
  return { queued, seen: rows.length, last: rows.length ? Number(rows[rows.length - 1].row_id) : after, done: rows.length < limit };
}

/**
 * How many pipeline companies a scoring run would queue: those never scored
 * (the fit loop takes them anyway, at priority 2) and those whose score is not
 * current.
 *
 * @param {Db} db
 * @param {{ model: string | null, ruleVersion: string | null }} p
 */
export async function pipelineToScore(db, { model, ruleVersion }) {
  const { rows: [r] } = await db.query(
    `SELECT count(*) FILTER (WHERE e.fit_key IS NULL AND e.fit_scored_at IS NULL)::int AS unscored,
            count(*) FILTER (WHERE ${stalePipeline("$1", "$2")})::int AS stale
       FROM enrich_companies e WHERE e.passes IS TRUE`,
    [model, ruleVersion]
  );
  return { unscored: r.unscored, stale: r.stale };
}

// ── One tick of the loop ────────────────────────────────────────────────────

/** Runs fn over list with at most limit at once. */
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

/**
 * One tick of the fit loop: queues the pipeline's unscored companies, claims
 * up to batch_size x calls_in_flight queued companies, skips those whose
 * score would not change, and scores the rest. Returns how many companies it
 * settled (scored, unscorable, or kept as they were).
 *
 * @param {{ pool: Db, env?: Record<string, string | undefined>, log?: (m: string) => void, settings: PipelineSettings,
 *           fetchImpl?: typeof fetch }} p
 * @returns {Promise<number>}
 */
export async function fitLoopOnce({ pool, env = process.env, log = () => {}, settings, fetchImpl = fetch }) {
  if (!settings?.fit_scoring?.enabled) loop.stop_seen_off = true;
  if (loop.billing_stopped && loop.stop_seen_off && settings?.fit_scoring?.enabled) {
    loop.billing_stopped = false;
    log("fit: scoring was switched off and on again; trying OpenAI again");
  }
  const ready = fitReadiness(settings, env);
  if (!ready.ready || loop.billing_stopped) {
    loop.state = "idle";
    loop.why = loop.billing_stopped ? loop.why : ready.why;
    return 0;
  }
  loop.stop_seen_off = false;
  if (Date.now() < loop.backoff_until) {
    loop.state = "waiting";
    return 0;
  }
  const model = /** @type {string} */ (settings.models.fit_score?.model);
  const effort = settings.models.fit_score?.reasoning_effort ?? null;
  const ruleVersion = settings.fit_rule.version ?? null;
  const prompt = /** @type {string} */ (settings.fit_rule.prompt);
  const prices = settings.spend_caps.openai_prices;

  await enqueuePipelineCompanies(pool);

  const cap = await spendAllowed(pool, "openai_usd_fit", settings);
  if (!cap.ok) {
    loop.state = "waiting";
    loop.why = cap.why ?? CAP_REACHED.openai_usd_fit;
    return 0;
  }

  const size = settings.fit_scoring.batch_size;
  const inFlight = settings.fit_scoring.calls_in_flight;
  const { token, rows } = await claimQueue(pool, size * inFlight);
  if (!rows.length) {
    loop.state = "idle";
    loop.why = null;
    return 0;
  }
  loop.state = "scoring";
  loop.why = null;

  // Unchanged inputs, or a manual score: no call.
  const withHash = rows.map((r) => ({ ...r, hash: inputsHash({ facts: r.facts, ruleVersion, model }) }));
  const { rows: stored } = await pool.query(
    `SELECT f.key_kind, f.key, f.status, f.inputs_hash FROM company_fit f
       JOIN jsonb_to_recordset($1::jsonb) AS x(key_kind text, key text) ON f.key_kind = x.key_kind AND f.key = x.key`,
    [JSON.stringify(rows.map((r) => ({ key_kind: r.key_kind, key: r.key })))]
  );
  const storedBy = new Map(stored.map((s) => [`${s.key_kind}:${s.key}`, s]));
  const keep = [];
  const toScore = [];
  for (const r of withHash) {
    const s = storedBy.get(`${r.key_kind}:${r.key}`);
    if (s && (s.status === "manual" || s.inputs_hash === r.hash)) keep.push(r);
    else toScore.push(r);
  }
  let settled = 0;
  if (keep.length) {
    // Nothing to score again: only the aliases and the copies are brought up to date.
    await addAliases(pool, keep.flatMap((r) => (r.aliases ?? []).map((a) => ({ ...a, fit_kind: r.key_kind, fit_key: r.key }))));
    const canon = JSON.stringify(keep.map((r) => ({ key_kind: r.key_kind, key: r.key })));
    await pool.query(COPY_TO_COMPANIES_SQL, [canon]);
    await pool.query(
      `DELETE FROM company_fit_queue q USING jsonb_to_recordset($1::jsonb) AS x(key_kind text, key text)
        WHERE q.key_kind = x.key_kind AND q.key = x.key AND q.claim_token = $2`,
      [canon, token]
    );
    loop.reused += keep.length;
    settled += keep.length;
  }

  // A company tried before goes alone; the rest in batches.
  const groups = [];
  const fresh = toScore.filter((r) => r.attempts === 0);
  for (const r of toScore.filter((x) => x.attempts > 0)) groups.push([r]);
  for (let i = 0; i < fresh.length; i += size) groups.push(fresh.slice(i, i + size));

  let stop = false;
  await runPool(groups, inFlight, async (group) => {
    if (stop) {
      await release(pool, token, group);
      return;
    }
    const allowed = await spendAllowed(pool, "openai_usd_fit", settings);
    if (!allowed.ok) {
      stop = true;
      loop.state = "waiting";
      loop.why = allowed.why ?? CAP_REACHED.openai_usd_fit;
      await release(pool, token, group);
      return;
    }
    const ids = group.map((_, i) => String(i + 1));
    const body = buildFitRequest({ prompt, model, effort, companies: group.map((r, i) => ({ id: ids[i], ...cleanFacts(r.facts) })) });
    let res;
    let json = null;
    try {
      res = await fetchImpl(OPENAI_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      json = await res.json().catch(() => null);
    } catch (e) {
      const why = e?.name === "TimeoutError" ? "OpenAI did not answer in time" : `OpenAI: ${e?.cause?.code ?? e?.message ?? "request failed"}`;
      noteError(why);
      loop.backoff_until = Date.now() + BACKOFF_MS[Math.min(loop.failures++, BACKOFF_MS.length - 1)];
      stop = true;
      await release(pool, token, group, { error: why });
      return;
    }
    loop.calls++;
    if (!res.ok) {
      const billing = billingRefusal(res.status, json);
      const why = billing ?? `OpenAI answered ${res.status}: ${String(json?.error?.message ?? "no message").slice(0, 200)}`;
      noteError(why);
      if (billing) {
        loop.billing_stopped = true;
        loop.state = "stopped";
        loop.why = `${billing}: scoring stopped. Once it is fixed, switch scoring off and on again.`;
        log(`fit: ${billing}; the loop stops`);
      } else {
        loop.backoff_until = Date.now() + BACKOFF_MS[Math.min(loop.failures++, BACKOFF_MS.length - 1)];
      }
      stop = true;
      await release(pool, token, group, { error: why });
      return;
    }
    loop.failures = 0;
    // An answered call is billed, whatever it holds.
    await addOpenAiSpend(pool, "fit", { model, usage: json?.usage ?? null, searches: 0 }, prices);
    const { ok, bad } = parseFitAnswer(json, ids);
    const byId = new Map(group.map((r, i) => [ids[i], r]));
    /** @type {FitResult[]} */
    const results = ok.map((a) => {
      const r = byId.get(a.id);
      return {
        key_kind: r.key_kind, key: r.key, score: a.score, home_office: a.home_office, reason: a.reason,
        status: a.score === null ? "unscorable" : "scored", inputs_hash: r.hash, source: r.source, aliases: r.aliases ?? [],
      };
    });
    const missing = bad.map((id) => byId.get(id));
    const spent = missing.filter((r) => r.attempts + 1 >= FIT_MAX_TRIES);
    for (const r of spent) {
      results.push({
        key_kind: r.key_kind, key: r.key, score: null, home_office: null,
        reason: `Not answered after ${FIT_MAX_TRIES} tries`, status: "unscorable", inputs_hash: null, source: r.source,
        aliases: r.aliases ?? [],
      });
    }
    await writeScores(pool, results, { model, ruleVersion, token });
    const again = missing.filter((r) => r.attempts + 1 < FIT_MAX_TRIES);
    await release(pool, token, again, { error: "Not in the answer: tried again on its own", tried: true });
    loop.scored += results.filter((r) => r.status === "scored").length;
    loop.unscorable += results.filter((r) => r.status === "unscorable").length;
    settled += results.length;
  });
  return settled;
}

// ── The blocked refresh (after a threshold or require_scored change) ────────

/**
 * Brings company_fit.blocked up to date after the gate's threshold or
 * require_scored changed (the gate route marks fit_gate_refresh.pending): in
 * batches of 20,000, until a batch finds nothing, then clears pending, unless
 * another change came meanwhile (its since differs). Up to 5 batches a tick.
 *
 * @param {Db} db
 * @returns {Promise<number>}  rows brought up to date
 */
export async function refreshBlockedOnce(db) {
  const { rows } = await db.query(`SELECT value FROM enrich_settings WHERE key = 'fit_gate_refresh'`);
  const v = rows[0]?.value;
  if (!v || v.pending !== true) return 0;
  let total = 0;
  for (let i = 0; i < 5; i++) {
    const { rows: [r] } = await db.query(`SELECT public.fn_fit_refresh_blocked($1) AS n`, [20_000]);
    const n = Number(r?.n ?? 0);
    total += n;
    if (n === 0) {
      await db.query(
        `UPDATE enrich_settings SET value = jsonb_set(value, '{pending}', 'false'::jsonb), updated_at = now()
          WHERE key = 'fit_gate_refresh' AND (value->>'pending')::boolean
            AND (value->>'since') IS NOT DISTINCT FROM $1`,
        [v.since ?? null]
      );
      break;
    }
  }
  return total;
}
