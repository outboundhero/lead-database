// The Companies template's own phase 1 checks (company-template-v2.mjs keeps
// them as T#17 to T#26), registered in ACTIONS beside the Clay ones
// (actions.mjs), and the Reoon helpers every pipeline check goes through:
//
//   client_office       free   the office in the client's area: every office of
//                              the company judged as client_area judges a person
//                              (judgePlace), the head office first; on a LinkedIn
//                              pull's row (hq_only) the head office alone
//   held_general_email  free   a general inbox for this company the database
//                              already holds: role addresses at its domain, then
//                              general-inbox leads at the same company and office
//
// Reoon: reoonVerifyRaw() is the one paid check (pipeline-actions.mjs
// reoon_verify), inside this process's one pool of slots and one balance
// cache. The hourly sweep (requeueWaitingTemplateRows, requeueRowsForHeldKeys)
// queues template rows again once what kept them waiting has cleared.
//
// Each run() resolves to { status, value, display, note, retryable, run }, as
// in actions.mjs. No message ever carries a key or a request URL.

import { findState } from "../aiark/geo.mjs";
import { stateHalves } from "../aiark/company-filters.mjs";
import { companyAsHeld, FREE_MAIL, geoFor, heldAddresses, judgePlace, targetingFor } from "./client-checks.mjs";
import { bareDomain } from "./domain.mjs";
import { CAP_NOT_SET, CAP_REACHED, spendAllowed, VENDOR_SPEND_KINDS } from "./spend.mjs";

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const plural = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

// ── client_office ───────────────────────────────────────────────────────────

/** A city as AI Ark wrote it, with capitals when it came all lower case ("hoboken" -> "Hoboken"). */
function cityName(s) {
  const t = text(s);
  return /\p{Lu}/u.test(t) ? t : t.replace(/(^|[\s'.-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
}

/** The offices cell (JSON text, or already an array). */
function parseOffices(v) {
  if (Array.isArray(v)) return v.filter((o) => o && typeof o === "object");
  try {
    const a = JSON.parse(text(v) || "[]");
    return Array.isArray(a) ? a.filter((o) => o && typeof o === "object") : [];
  } catch {
    return [];
  }
}

/** Is a cell's value the text "true" (or true)? */
const isTrue = (v) => v === true || text(v).toLowerCase() === "true";

async function clientOffice({ inputs, table, row, db }) {
  const t = await targetingFor(db, table.client_tag, row?.next_run_at);
  if (!t) return { status: "error", note: `${table.client_tag} has no targeting rules`, retryable: false };
  const offices = parseOffices(inputs.offices);
  if (!offices.length) {
    const why = "AI Ark gave no office for this company, so the lead database couldn't place it";
    return { status: "done", value: { inside: false, hq: false, office: null, why, offices_inside: 0 }, display: "Can't tell", note: why };
  }
  const hqOnly = isTrue(inputs.hq_only);
  if (hqOnly && !offices.some((o) => o.hq)) {
    const why = "AI Ark gave no head office for this company, and a LinkedIn pull keeps head offices only, so the lead database couldn't place it";
    return { status: "done", value: { inside: false, hq: false, office: null, why, offices_inside: 0 }, display: "Can't tell", note: why };
  }
  const { geo } = await geoFor(db);
  const judged = [];
  for (const o of offices) {
    // "nj - new jersey": whichever half is a state the lead database knows.
    const state = stateHalves(o.state).find((h) => findState(geo, h)) ?? text(o.state);
    judged.push({ office: o, verdict: await judgePlace({ city: o.city, state, country: o.country }, { targeting: t, db }) });
  }
  const inside = judged.filter((j) => j.verdict.value === true);
  // A LinkedIn pull's row (hq_only): the head office alone counts, as Clay's company search kept head offices.
  const counted = hqOnly ? inside.filter((j) => j.office.hq) : inside;
  const chosen = counted.find((j) => j.office.hq) ?? counted[0] ?? null;
  const shown = chosen ?? judged.find((j) => j.office.hq) ?? judged[0];
  const place = shown.verdict.place ?? null;
  const country = place?.country ?? null;
  const state = place?.state ?? null;
  const office = {
    street: text(shown.office.street) || null,
    city: cityName(shown.office.city) || null,
    state,
    state_name: country && state ? geo.stateName.get(`${country}|${state}`) ?? null : null,
    country,
    country_name: country ? geo.countryName.get(country) ?? null : null,
    postal_code: text(shown.office.postal_code) || null,
  };
  if (hqOnly && !chosen) {
    const cantTell = shown.verdict.display === "Can't tell";
    const branches = inside.length;
    const why = shown.verdict.note;
    return {
      status: "done",
      value: { inside: false, hq: true, office, why, offices_inside: branches },
      display: cantTell ? "Can't tell" : "Outside (head office)",
      note: `The head office is not in the client's area, and a LinkedIn pull keeps head offices only: ${why}.${branches ? ` ${plural(branches, "other office is", "other offices are")} inside; an AI Ark pull of the same company would count ${branches === 1 ? "it" : "them"}.` : ""}`,
    };
  }
  if (chosen) {
    const which = chosen.office.hq ? (hqOnly ? "The head office (a LinkedIn pull keeps head offices only)" : "The head office") : "A branch (the head office is not inside)";
    return {
      status: "done",
      value: { inside: true, hq: Boolean(chosen.office.hq), office, why: chosen.verdict.note, offices_inside: inside.length },
      display: "Inside",
      note: `${which} is in the client's area: ${chosen.verdict.note}. ${plural(inside.length, "office is", "offices are")} inside, of ${judged.length}.`,
    };
  }
  const cantTell = shown.verdict.display === "Can't tell";
  return {
    status: "done",
    value: { inside: false, hq: false, office, why: shown.verdict.note, offices_inside: 0 },
    display: cantTell ? "Can't tell" : "Outside",
    note: `None of the ${plural(judged.length, "office", "offices")} is in the client's area. ${shown.office.hq ? "Head office" : "First office"}: ${shown.verdict.note}`,
  };
}

// ── held_general_email ──────────────────────────────────────────────────────

/** The role addresses looked up at a company's domain. */
export const ROLE_ADDRESSES = [
  "info", "contact", "office", "hello", "admin", "team", "mail", "sales", "service", "reception", "frontdesk", "inquiries",
  "enquiries", "hi",
];

// Never contact stops the company; a usable inbox (a lead, then the Email Bison
// copy) ends the search; a bounced one is searched past and never offered again.
const heldWeight = (r) => (r.listed || r.is_suppressed ? 0 : r.is_bounced ? 3 : r.lead_id ? 1 : 2);

async function heldGeneralEmail({ inputs, db }) {
  const domain = bareDomain(inputs.domain);
  const company = companyAsHeld(inputs.company);
  const city = text(inputs.city);
  const state = text(inputs.state).toUpperCase();
  const country = text(inputs.country).toUpperCase();
  const found = [];
  const looked = [];
  if (domain && !FREE_MAIL.has(domain)) {
    looked.push(`${ROLE_ADDRESSES.length} role addresses at ${domain}`);
    for (const r of await heldAddresses(db, ROLE_ADDRESSES.map((l) => `${l}@${domain}`))) found.push({ ...r, matched_on: "role address" });
  }
  if (company && city && state) {
    const { geo } = await geoFor(db);
    const stateName = geo.stateName.get(`${country}|${state}`) ?? state;
    looked.push(`general inboxes of "${company}" in ${city}, ${state}`);
    // lower(TRIM(company)) is idx_leads_company_norm (migration 049).
    const { rows } = await db.query(
      `SELECT l.email, l.id AS lead_id, l.is_bounced, l.bounce_type, l.is_suppressed,
              s.email IS NOT NULL AS listed, s.reason,
              EXISTS (SELECT 1 FROM bison_leads b WHERE lower(b.email) = l.email) AS in_bison
         FROM leads l
         LEFT JOIN suppressed_emails s ON s.email = l.email
        WHERE lower(TRIM(l.company)) = lower(TRIM($1)) AND l.email_type = 'general' AND l.email IS NOT NULL
          AND lower(TRIM(l.city)) = lower($2)
          AND (upper(TRIM(l.state)) = $3 OR lower(TRIM(l.state)) = lower($4))
        LIMIT 50`,
      [company, city, state, stateName]
    );
    for (const r of rows) if (!found.some((f) => f.email === r.email)) found.push({ ...r, matched_on: "general inbox at the company" });
  }
  if (!found.length) {
    return { status: "empty", note: looked.length ? `Nothing held: ${looked.join("; ")}` : "No domain, and no company with a city and state, to look up" };
  }
  const best = found.reduce((a, b) => (heldWeight(b) < heldWeight(a) ? b : a));
  const never = Boolean(best.listed || best.is_suppressed);
  const excluded = [...new Set(found.filter((r) => r.is_bounced || r.listed || r.is_suppressed).map((r) => r.email))];
  const value = {
    email: best.email,
    lead_id: best.lead_id ?? null,
    in_bison: Boolean(best.in_bison),
    bounced: !never && Boolean(best.is_bounced),
    never_contact: never,
    matched_on: best.matched_on,
    excluded,
  };
  const display = never ? "Never contact" : best.is_bounced ? "Bounced" : best.lead_id ? "In the database" : "In Email Bison";
  const note = never
    ? `${best.email} is on the never-contact list${best.reason ? ` (${best.reason})` : ""}, so the company is left alone`
    : best.is_bounced
      ? `${best.email} bounced${best.bounce_type ? ` (${best.bounce_type})` : ""}: the search goes on without it`
      : `${best.email} is ${best.lead_id ? "already a lead" : "in the copy of Email Bison"} (${best.matched_on}), so nothing is searched for`;
  return { status: "done", value, display, note };
}

// ── Reoon ───────────────────────────────────────────────────────────────────

const REOON_API = "https://emailverifier.reoon.com/api/v1";
// The shared account's balance is read again when the one held is over a
// minute old (D44): the validation worker spends the same daily credits.
const BALANCE_TTL_MS = 60_000;
const VERIFY_TIMEOUT_MS = 60_000;
const NATIVE = new Set(["safe", "valid", "role_account", "catch_all", "invalid", "disposable", "spamtrap", "disabled", "inbox_full", "unknown"]);

/**
 * Reoon's word -> email_validations.status. Exactly mapStatus in
 * scripts/validation-worker.mjs (which can't be imported: it is a script).
 */
export function mapReoonStatus(native) {
  const s = String(native ?? "").toLowerCase().trim();
  switch (s) {
    case "safe": case "valid": case "role_account": return "valid";
    case "catch_all": return "catch_all";
    case "invalid": case "disposable": case "spamtrap": case "disabled": return "invalid";
    case "inbox_full": return "risky";
    default: return "unknown";
  }
}

let balance = { key: null, at: 0, daily: null, instant: null, error: null };
let active = 0;
const waiting = [];

/** ENRICH_REOON_API_KEY, if it is usable. Never logged. */
export function reoonKey(env) {
  const k = String(env?.ENRICH_REOON_API_KEY ?? "").trim();
  return k && !/[^\x20-\x7e]/.test(k) ? k : null;
}

/** How many Reoon calls may run at once in this process: ENRICH_REOON_THREADS, 4 by default, Reoon's 5 at most. */
function threads(env) {
  const n = Number(env?.ENRICH_REOON_THREADS);
  return Number.isInteger(n) && n >= 1 ? Math.min(5, n) : 4;
}

async function withSlot(env, fn) {
  while (active >= threads(env)) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** A GET to Reoon. The URL holds the key, so it never reaches an error, and the key is cut out of any text kept. */
async function reoonGet(path, key, timeoutMs) {
  try {
    const res = await fetch(`${REOON_API}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const raw = (await res.text()).split(key).join("[key]");
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, json, raw: raw.slice(0, 200) };
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { ok: false, status: 0, json: null, error: timeout ? `no answer within ${timeoutMs / 1000}s` : text(e?.cause?.code) || "request failed" };
  }
}

/**
 * The Reoon account's balance (check-account-balance, free), read at most once
 * a minute. { ok: true, daily, instant } or { ok: false, why, retryable }.
 */
export async function reoonBalance(env, { force = false } = {}) {
  const key = reoonKey(env);
  if (!key) return { ok: false, why: "Needs ENRICH_REOON_API_KEY on the worker", retryable: false };
  if (!force && balance.key === key && balance.daily != null && Date.now() - balance.at < BALANCE_TTL_MS) {
    return { ok: true, daily: balance.daily, instant: balance.instant };
  }
  const r = await reoonGet(`/check-account-balance/?key=${encodeURIComponent(key)}`, key, 30_000);
  const daily = Number(r.json?.remaining_daily_credits);
  const instant = Number(r.json?.remaining_instant_credits);
  if (!r.ok || r.json?.status !== "success" || !Number.isFinite(daily)) {
    const refused = r.status === 401 || r.status === 403 || /key/i.test(text(r.json?.reason));
    const why = refused ? "Reoon refused ENRICH_REOON_API_KEY" : `Reoon's balance could not be read (${r.error ?? `HTTP ${r.status}`})`;
    balance = { key, at: Date.now(), daily: null, instant: null, error: why };
    return { ok: false, why, retryable: !refused };
  }
  balance = { key, at: Date.now(), daily, instant: Number.isFinite(instant) ? instant : null, error: null };
  return { ok: true, daily, instant: balance.instant };
}

/** The last balance read, for the worker's heartbeat: daily and instant credits, and when. */
export function reoonBalanceInfo() {
  return { daily: balance.daily, instant: balance.instant, read_at: balance.at ? new Date(balance.at).toISOString() : null, error: balance.error };
}

/**
 * May a paid check be made now? The key, then the validation worker's rule for
 * its own account, applied to this one: daily credits only, so nothing is
 * checked while the account holds any instant (paid) credit.
 */
export async function reoonMayCheck(env) {
  const b = await reoonBalance(env);
  if (!b.ok) return b;
  if (b.instant !== 0) {
    return { ok: false, why: `The Reoon account holds instant credits (${b.instant ?? "unknown"}). This pipeline spends daily credits only, so nothing was checked.`, retryable: false };
  }
  if (!(b.daily > 0)) return { ok: false, why: "Reoon's daily credits are used up. The row waits and is tried again once they renew.", retryable: false };
  return { ok: true };
}

/** The notes a waiting cell gets from Reoon's gate (reoonBalance, reoonMayCheck, reoonVerifyRaw). */
const REOON_WAIT = /^(?:Reoon|The Reoon account)\b/;
const NEEDS_ON_WORKER = /^Needs (.+) on the worker$/;
/** Templates no longer worked (templates.mjs RETIRED_TEMPLATES; repeated here to keep this module free of the templates). */
const RETIRED = ["companies_v1"];
/** The notes of a step waiting on its vendor's daily calls (used up, or no cap set yet), to the ledger kind they wait on (129). */
const VENDOR_WAITS = new Map(
  VENDOR_SPEND_KINDS.flatMap((k) => [
    [CAP_REACHED[/** @type {keyof typeof CAP_REACHED} */ (k)], k],
    [CAP_NOT_SET[/** @type {keyof typeof CAP_NOT_SET} */ (k)], k],
  ])
);

/**
 * Why a waiting row may run now: every note of its waiting cells must have
 * cleared. "Waiting for <column>" follows from another cell and is not a
 * reason of its own. A step waiting on its vendor's daily calls clears once
 * the day's calls have room again: the next UTC day, or a higher cap; a cap
 * of 0 never clears. A reason this sweep doesn't know keeps the old rule:
 * both paid keys set and Reoon may be spent.
 */
function clearance(env, db, settings) {
  const memo = new Map();
  const once = (k, f) => {
    if (!memo.has(k)) memo.set(k, f());
    return memo.get(k);
  };
  const reoonGate = () => once("reoon", () => reoonMayCheck(env));
  const share = () => once("share", () => spendAllowed(db, "reoon_checks", settings));
  const openai = () => once("openai", () => spendAllowed(db, "openai_usd_pipeline", settings));
  const vendor = (kind) => once(`vendor:${kind}`, () => spendAllowed(db, kind, settings));
  /** @returns {Promise<string | null>} why it still waits, or null */
  return async (notes) => {
    const reasons = (notes ?? []).filter((n) => n && !/^Waiting for /.test(n) && !/^Not worked out|not worked out/.test(n));
    for (const n of reasons) {
      const needs = NEEDS_ON_WORKER.exec(n);
      if (needs) {
        const missing = needs[1].split(/\s+and\s+/).filter((k) => !text(env?.[k]));
        if (missing.length) return `Needs ${missing.join(" and ")} on the worker`;
        continue;
      }
      if (n === CAP_REACHED.openai_usd_pipeline) {
        const a = await openai();
        if (!a.ok) return a.why;
        continue;
      }
      const kind = VENDOR_WAITS.get(n);
      if (kind) {
        const a = await vendor(kind);
        if (!a.ok) return a.why;
        continue;
      }
      if (n === CAP_REACHED.reoon_checks) {
        const a = await share();
        if (!a.ok) return a.why;
        const g = await reoonGate();
        if (!g.ok) return g.why;
        continue;
      }
      if (REOON_WAIT.test(n)) {
        const g = await reoonGate();
        if (!g.ok) return g.why;
        continue;
      }
      if (!text(env?.OPENAI_API_KEY) || !reoonKey(env)) return "Needs OPENAI_API_KEY and ENRICH_REOON_API_KEY on the worker";
      const g = await reoonGate();
      if (!g.ok) return g.why;
    }
    return null;
  };
}

/**
 * The worker's hourly sweep: template rows waiting on a key or a day's cap are
 * queued again in pages (oldest first), and only when what made each one wait
 * has cleared: the key is set, Reoon may be spent and the day's Reoon share
 * has room, the day's OpenAI cap has room, or the day's calls of an email
 * finder or Enrichley have room (never while its cap is 0). Answers already
 * held are reused, so only the waiting cells call a provider. A row whose
 * step needs a key we do not hold never waits (it is skipped), so it never
 * comes here.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} db
 * @param {Record<string, string | undefined>} env
 * @param {{ settings?: import("./settings.mjs").PipelineSettings | null, pageSize?: number, maxPages?: number }} [opts]
 * @returns {Promise<{ queued: number, waiting: number, why: string | null }>}  why: what keeps the most rows waiting
 */
export async function requeueWaitingTemplateRows(db, env, { settings = null, pageSize = 5000, maxPages = 20 } = {}) {
  const cleared = clearance(env, db, settings);
  const kept = new Map();
  let queued = 0;
  let after = 0;
  for (let page = 0; page < maxPages; page++) {
    const { rows } = await db.query(
      `SELECT r.id, coalesce(array_agg(DISTINCT c.note) FILTER (WHERE c.note IS NOT NULL), '{}') AS notes
         FROM enrich_rows r
         JOIN enrich_tables t ON t.id = r.table_id
         LEFT JOIN enrich_cells c ON c.row_id = r.id AND c.status = 'needs_key'
        WHERE t.template IS NOT NULL AND NOT (t.template = ANY($3::text[])) AND r.run_status = 'waiting' AND r.id > $1
        GROUP BY r.id
        ORDER BY r.id
        LIMIT $2`,
      [after, pageSize, RETIRED]
    );
    if (!rows.length) break;
    const ready = [];
    for (const r of rows) {
      const why = await cleared(r.notes);
      if (why) kept.set(why, (kept.get(why) ?? 0) + 1);
      else ready.push(r.id);
    }
    if (ready.length) {
      const { rowCount } = await db.query(
        `UPDATE enrich_rows SET run_status = 'queued', next_run_at = now(), attempts = 0, last_error = NULL, updated_at = now()
          WHERE id = ANY($1::bigint[]) AND run_status = 'waiting'`,
        [ready]
      );
      queued += rowCount ?? 0;
    }
    after = Number(rows.at(-1).id);
    if (rows.length < pageSize) break;
  }
  const top = [...kept].sort((a, b) => b[1] - a[1])[0] ?? null;
  return { queued, waiting: [...kept.values()].reduce((a, b) => a + b, 0), why: top ? top[0] : null };
}

/**
 * The other half of the sweep: a keyed step (an email finder or Enrichley)
 * skipped as "Needs <KEY> (not held)" runs once its key is set. The rows whose
 * cells say so for a key now held are queued again, in pages, table by table
 * and column by column (the cells' own index). Their other answers are reused.
 *
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} db
 * @param {Record<string, string | undefined>} env
 * @param {{ keys: readonly string[], noteOf: (key: string) => string, pageSize?: number, maxPages?: number }} opts
 *   keys: the optional keys (pipeline-actions.mjs OPTIONAL_KEYS); noteOf: their skipped note (absentKeyNote)
 * @returns {Promise<{ queued: number, keys: string[] }>}  keys: the ones now held
 */
export async function requeueRowsForHeldKeys(db, env, { keys, noteOf, pageSize = 5000, maxPages = 20 }) {
  const held = (keys ?? []).filter((k) => text(env?.[k]));
  if (!held.length) return { queued: 0, keys: [] };
  const notes = held.map(noteOf);
  const { rows: columns } = await db.query(
    `SELECT c.table_id, array_agg(c.key) AS keys
       FROM enrich_columns c JOIN enrich_tables t ON t.id = c.table_id
      WHERE t.template IS NOT NULL AND c.config->>'key_env' = ANY($1::text[])
      GROUP BY c.table_id`,
    [held]
  );
  let queued = 0;
  let pages = 0;
  for (const t of columns) {
    let after = 0;
    while (pages < maxPages) {
      pages++;
      const { rows } = await db.query(
        `SELECT DISTINCT row_id FROM enrich_cells
          WHERE table_id = $1 AND column_key = ANY($2::text[]) AND status = 'skipped' AND note = ANY($3::text[]) AND row_id > $4
          ORDER BY row_id LIMIT $5`,
        [t.table_id, t.keys, notes, after, pageSize]
      );
      if (!rows.length) break;
      const { rowCount } = await db.query(
        `UPDATE enrich_rows SET run_status = 'queued', next_run_at = now(), attempts = 0, last_error = NULL, updated_at = now()
          WHERE id = ANY($1::bigint[]) AND run_status IN ('done', 'waiting')`,
        [rows.map((r) => r.row_id)]
      );
      queued += rowCount ?? 0;
      after = Number(rows.at(-1).row_id);
      if (rows.length < pageSize) break;
    }
  }
  return { queued, keys: held };
}

/**
 * One paid Reoon check (power mode, GET /api/v1/verify?email=&key=&mode=power,
 * as G#39 and P#11 ask), for the pipeline's reoon_verify step. It runs inside this process's one pool of Reoon slots
 * (ENRICH_REOON_THREADS, at most 5) and spends from the one balance cache, so
 * the worker never has two of either. The key is cut out of Reoon's answer
 * before it is parsed, so `json` never holds it.
 *
 * It makes the call: the caller first asks reoonMayCheck() (daily credits
 * only) and, for the pipeline, takes one of today's checks (spend.mjs). An
 * unknown result is not charged by Reoon and is not taken off the balance.
 *
 * @param {string} email
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{ ok: true, native: string, status: string, json: Record<string, any> }
 *   | { ok: false, why: string, retryable: boolean, keyProblem: boolean, http_status: number, json: Record<string, any> | null }>}
 *   native: Reoon's own word (safe, role_account, catch_all, invalid, ...); status: it mapped as
 *   email_validations holds it (mapReoonStatus); json: Reoon's whole answer, as G#40 and P#12 read it
 */
export async function reoonVerifyRaw(email, env) {
  const key = reoonKey(env);
  if (!key) return { ok: false, keyProblem: true, retryable: false, why: "Needs ENRICH_REOON_API_KEY on the worker", http_status: 0, json: null };
  return withSlot(env, async () => {
    const r = await reoonGet(`/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}&mode=power`, key, VERIFY_TIMEOUT_MS);
    const native = text(r.json?.status).toLowerCase();
    if (r.ok && NATIVE.has(native)) {
      if (native !== "unknown" && balance.daily != null) balance.daily = Math.max(0, balance.daily - 1);
      return { ok: true, native, status: mapReoonStatus(native), json: r.json };
    }
    balance.at = 0; // read the balance again before the next check
    const reason = text(r.json?.reason ?? r.json?.message) || r.error || (r.raw ? r.raw : "no answer");
    if (r.status === 401 || r.status === 403 || /api key|invalid key/i.test(reason)) {
      return { ok: false, keyProblem: true, retryable: false, why: "Reoon refused ENRICH_REOON_API_KEY", http_status: r.status, json: r.json };
    }
    return {
      ok: false, keyProblem: false, retryable: r.status === 0 || r.status === 429 || r.status >= 500,
      why: `HTTP ${r.status || "no answer"}: ${reason}`, http_status: r.status, json: r.json,
    };
  });
}

export const COMPANY_ACTIONS = {
  client_office: { run: clientOffice, cache: false },
  held_general_email: { run: heldGeneralEmail, cache: false },
};

/** For tests: forget the Reoon balance read and free every check slot. */
export function resetCompanyActions() {
  balance = { key: null, at: 0, daily: null, instant: null, error: null };
  active = 0;
  waiting.splice(0).forEach((r) => r());
}
