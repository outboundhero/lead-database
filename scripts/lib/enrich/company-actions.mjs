// The Companies template's own actions (company-template.mjs), registered in
// ACTIONS beside the Clay ones (actions.mjs):
//
//   client_office       free   the office in the client's area: every office of
//                              the company judged as client_area judges a person
//                              (judgePlace), the head office first
//   held_general_email  free   a general inbox for this company the database
//                              already holds: role addresses at its domain, then
//                              general-inbox leads at the same company and office
//   pick_emails         free   addresses pulled out of an answer, junk left out,
//                              the company's own domain first, at most 5
//   verify_emails       Reoon  the first usable address, at most
//                              email_checks_per_company paid checks a company; a
//                              verdict from the last 90 days is reused for free
//
// Each run() resolves to { status, value, display, note, retryable, run }, as
// in actions.mjs. No message ever carries a key or a request URL.

import { findState } from "../aiark/geo.mjs";
import { stateHalves } from "../aiark/company-filters.mjs";
import { companyAsHeld, FREE_MAIL, geoFor, heldAddresses, judgePlace, targetingFor } from "./client-checks.mjs";
import { JUNK_DOMAINS, JUNK_LOCAL_PARTS, JUNK_LOCAL_PREFIXES, JUNK_TLDS } from "./company-template.mjs";
import { bareDomain } from "./domain.mjs";

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

async function clientOffice({ inputs, table, row, db }) {
  const t = await targetingFor(db, table.client_tag, row?.next_run_at);
  if (!t) return { status: "error", note: `${table.client_tag} has no targeting rules`, retryable: false };
  const offices = parseOffices(inputs.offices);
  if (!offices.length) {
    const why = "AI Ark gave no office for this company, so the lead database couldn't place it";
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
  const chosen = inside.find((j) => j.office.hq) ?? inside[0] ?? null;
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
  if (chosen) {
    const which = chosen.office.hq ? "The head office" : "A branch (the head office is not inside)";
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

// ── pick_emails ─────────────────────────────────────────────────────────────

const EMAIL_RX = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const IMAGE_RX = /\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif)$/i;
const JUNK_LOCALS = new Set(JUNK_LOCAL_PARTS);

/** Why an address is never an office's general inbox, or null when it may be. */
export function junkReason(address) {
  const a = text(address).toLowerCase();
  const at = a.lastIndexOf("@");
  if (at < 1) return "not an address";
  const host = a.slice(at + 1);
  if (IMAGE_RX.test(host)) return "an image file name";
  const tld = host.split(".").pop();
  if (JUNK_TLDS.includes(tld)) return "a government or military address";
  if (JUNK_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return "a placeholder or platform address";
  const local = a.slice(0, at).replace(/\+.*$/, "").replace(/[._'-]/g, "");
  if (JUNK_LOCALS.has(local) || JUNK_LOCAL_PREFIXES.some((p) => local.startsWith(p))) return `a ${a.slice(0, at)}@ address`;
  return null;
}

/** Text out of anything an answer cell may hold. */
function textOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join(" ");
  if (typeof v === "object") return Object.values(v).map(textOf).join(" ");
  return String(v);
}

/**
 * The candidates in some text: lower case, once each, junk left out, the
 * excluded ones left out, the company's domain first, then free mail (small
 * businesses use it), then anything else; at most 5.
 */
export function pickEmailList({ texts, exclude = [], domain = null, max = 5 }) {
  const skip = new Set((Array.isArray(exclude) ? exclude : [exclude]).map((e) => text(e).toLowerCase()).filter(Boolean));
  const own = bareDomain(domain);
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const raw of textOf(texts).match(EMAIL_RX) ?? []) {
    const email = raw.toLowerCase().replace(/^[._'-]+/, "").replace(/\.+$/, "");
    if (!email.includes("@") || seen.has(email)) continue;
    seen.add(email);
    const why = junkReason(email) ?? (skip.has(email) ? "checked or ruled out already" : null);
    if (why) dropped.push({ email, why });
    else kept.push(email);
  }
  const rank = (e) => {
    const host = e.slice(e.lastIndexOf("@") + 1);
    if (own && (host === own || host.endsWith(`.${own}`))) return 0;
    return FREE_MAIL.has(host) ? 1 : 2;
  };
  const emails = kept.map((e, i) => ({ e, i })).sort((x, y) => rank(x.e) - rank(y.e) || x.i - y.i).map((x) => x.e).slice(0, max);
  return { emails, dropped };
}

async function pickEmails({ inputs }) {
  const { emails, dropped } = pickEmailList({ texts: inputs.texts, exclude: inputs.exclude, domain: inputs.domain });
  const droppedNote = dropped.length ? ` Left out: ${dropped.slice(0, 4).map((d) => `${d.email} (${d.why})`).join(", ")}${dropped.length > 4 ? " …" : ""}` : "";
  if (!emails.length) return { status: "empty", note: `No usable address.${droppedNote}` };
  return { status: "done", value: { emails, dropped }, display: emails.join(", "), note: `${plural(emails.length, "address", "addresses")} to check.${droppedNote}` };
}

// ── verify_emails (Reoon) ───────────────────────────────────────────────────

const REOON_API = "https://emailverifier.reoon.com/api/v1";
const BALANCE_TTL_MS = 10 * 60_000;
const VERIFY_TIMEOUT_MS = 60_000;
const FRESH_DAYS = 90;
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
function reoonKey(env) {
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
 * The Reoon account's balance (check-account-balance, free), read at most every
 * 10 minutes. { ok: true, daily, instant } or { ok: false, why, retryable }.
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

/** One paid check (power mode). { ok, status, native } or { ok: false, why, retryable, keyProblem }. */
async function reoonVerify(email, env) {
  const key = reoonKey(env);
  return withSlot(env, async () => {
    const r = await reoonGet(`/verify?email=${encodeURIComponent(email)}&key=${encodeURIComponent(key)}&mode=power`, key, VERIFY_TIMEOUT_MS);
    const native = text(r.json?.status).toLowerCase();
    if (r.ok && NATIVE.has(native)) {
      if (native !== "unknown" && balance.daily != null) balance.daily = Math.max(0, balance.daily - 1);
      return { ok: true, native, status: mapReoonStatus(native) };
    }
    balance.at = 0; // read the balance again before the next check
    const reason = text(r.json?.reason ?? r.json?.message) || r.error || (r.raw ? r.raw : "no answer");
    if (r.status === 401 || r.status === 403 || /api key|invalid key/i.test(reason)) {
      return { ok: false, keyProblem: true, why: "Reoon refused ENRICH_REOON_API_KEY", status: r.status };
    }
    return { ok: false, retryable: r.status === 0 || r.status === 429 || r.status >= 500, why: `HTTP ${r.status || "no answer"}: ${reason}`, status: r.status };
  });
}

/** Addresses out of the emails input: an array, or text separated by commas or spaces. */
function addressesOf(v) {
  const list = Array.isArray(v) ? v : text(v).split(/[,;\s]+/);
  return [...new Set(list.map((e) => text(e).toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)))].slice(0, 10);
}

async function verifyEmails({ inputs, env, db, settings }) {
  const emails = addressesOf(inputs.emails);
  if (!emails.length) return { status: "empty", note: "No address to check" };
  const cap = settings?.company_pipeline?.email_checks_per_company ?? 3;
  const spent = Math.max(0, Number(inputs.spent) || 0);
  const { rows } = await db.query(
    `SELECT email, status, native_status FROM email_validations
      WHERE email = ANY($1::text[]) AND validated_at > now() - make_interval(days => $2)
        AND status IN ('valid', 'catch_all', 'invalid')`,
    [emails, FRESH_DAYS]
  );
  const fresh = new Map(rows.map((r) => [r.email, r]));
  const checked = [];
  let paid = 0;
  let valid = null;
  let catchAll = null;
  let stop = null; // why checking ended before a valid address: cap | wait | error
  for (const email of emails) {
    let status;
    let native;
    let cached = false;
    const hit = fresh.get(email);
    if (hit) {
      status = hit.status;
      native = hit.native_status;
      cached = true;
    } else {
      if (spent + paid >= cap) {
        stop = { kind: "cap", why: `The cap of ${plural(cap, "paid check", "paid checks")} for this company is reached` };
        break;
      }
      const gate = await reoonMayCheck(env);
      if (!gate.ok) {
        stop = { kind: gate.retryable ? "error" : "wait", why: gate.why };
        break;
      }
      const r = await reoonVerify(email, env);
      if (!r.ok && r.keyProblem) {
        stop = { kind: "wait", why: r.why };
        break;
      }
      if (!r.ok) {
        // Never read as "nothing usable": the row is tried again, and the verdicts saved so far are reused for free.
        return {
          status: "error", note: `Reoon: ${r.why}`, retryable: r.retryable,
          run: { request: { emails, spent, cap }, response: { checked, paid }, http_status: r.status || null, error: r.why },
        };
      }
      status = r.status;
      native = r.native;
      // The newer verdict wins, as in the validation worker's table.
      await db.query(
        `INSERT INTO email_validations (email, status, native_status, provider, validated_at)
         VALUES ($1, $2, $3, 'reoon', now())
         ON CONFLICT (email) DO UPDATE
           SET status = EXCLUDED.status, native_status = EXCLUDED.native_status, provider = EXCLUDED.provider,
               task_id = NULL, validated_at = EXCLUDED.validated_at
         WHERE email_validations.validated_at <= EXCLUDED.validated_at`,
        [email, status, native]
      );
      if (native !== "unknown") paid++; // Reoon refunds unknown results
    }
    checked.push({ email, status, native: native ?? null, cached });
    if (status === "valid") {
      valid = email;
      break;
    }
    if (status === "catch_all" && !catchAll) catchAll = email;
  }
  const winner = valid ? { email: valid, status: "valid" } : catchAll ? { email: catchAll, status: "catch_all" } : null;
  const run = { request: { emails, spent, cap }, response: { checked, paid } };
  if (!winner && stop?.kind === "wait") return { status: "needs_key", note: stop.why, run };
  if (!winner && stop?.kind === "error") return { status: "error", note: stop.why, retryable: true, run };
  const summary = checked.map((c) => `${c.email} ${c.status}${c.cached ? " (reused)" : ""}`).join(", ");
  const note = `${summary || "Nothing checked"}.${paid ? ` ${plural(paid, "paid check", "paid checks")}.` : ""}${stop ? ` ${stop.why}.` : ""}`;
  return {
    status: "done",
    value: { email: winner?.email ?? null, status: winner?.status ?? null, checked, paid },
    display: winner ? `${winner.status === "valid" ? "Valid" : "Catch-all"}: ${winner.email}` : "None usable",
    note,
    run,
  };
}

export const COMPANY_ACTIONS = {
  client_office: { run: clientOffice, cache: false },
  held_general_email: { run: heldGeneralEmail, cache: false },
  pick_emails: { run: pickEmails, cache: false },
  verify_emails: { run: verifyEmails, cache: true },
};

/** For tests: forget the Reoon balance read and free every check slot. */
export function resetCompanyActions() {
  balance = { key: null, at: 0, daily: null, instant: null, error: null };
  active = 0;
  waiting.splice(0).forEach((r) => r());
}
