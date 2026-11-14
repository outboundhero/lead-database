// The email finders and Enrichley, one small adapter each (updates 3 and 4 of
// the phase 2 build): the People template's P#46 to P#54 and Enrichley's
// G#41 and P#13. pipeline-actions.mjs wraps each one: without its key on the
// worker the step is skipped as "Needs <KEY> (not held)" before any call.
//
// Findymail, Prospeo and Enrichley are Clay's own actions, whose requests are
// not in the export: each adapter is built from the vendor's public API docs,
// cited above it. Anymail Finder's requests are in the export (http-api-v2):
// its adapter sends the compiled method, URL and body as they are, with the
// Authorization header built from the key at run time.
//
// Every adapter makes one call per attempt (the row's own retry handles a
// lost answer), keeps the vendor's answer as the cell's value in the shape
// the originals read, and never puts the key in a note, an error or a run
// record. A field name a vendor's docs left unconfirmed is read in one place,
// so a wrong one is a one-line fix.

import { capped, httpJson } from "./http.mjs";

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const TIMEOUT_MS = 60_000;

/** The key cut out of anything kept. */
function scrub(v, key) {
  if (!key) return v;
  if (typeof v === "string") return v.split(key).join("[key]");
  if (Array.isArray(v)) return v.map((x) => scrub(x, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, key)]));
  return v;
}

/** One call, its answer scrubbed of the key, and the run record. */
async function send({ url, method = "POST", headers, body, key, request }) {
  const r = await httpJson(url, { method, headers, body, timeoutMs: TIMEOUT_MS, tries: 1 });
  const json = scrub(r.json, key);
  const error = r.ok ? null : scrub(r.error, key);
  return { ...r, json, error, run: { request, response: capped(json), http_status: r.status || null, error } };
}

/** What an HTTP failure means for the cell. Statuses a vendor documents differently are handled by the caller first. */
function failure(vendor, keyName, r) {
  const s = r.status;
  if (s === 401 || s === 403) return { status: "error", note: `${vendor} refused ${keyName} (HTTP ${s})`, retryable: false, run: r.run };
  if (s === 402) return { status: "error", note: `${vendor}: the account is out of credits (HTTP 402)`, retryable: false, run: r.run };
  if (s === 429) return { status: "error", note: `${vendor}: rate limited (HTTP 429), tried again later`, retryable: true, run: r.run };
  if (s === 0 || s >= 500) return { status: "error", note: `${vendor}: ${s ? `HTTP ${s}` : "no answer"}${r.error ? ` (${String(r.error).slice(0, 160)})` : ""}`, retryable: true, run: r.run };
  return { status: "error", note: `${vendor} refused the request (HTTP ${s})${r.error ? `: ${String(r.error).slice(0, 160)}` : ""}`, retryable: false, run: r.run };
}

/** An address a vendor returned, or null for none, a masked one ("j***@x.com") or something that is not one. */
function address(v) {
  const s = text(v).toLowerCase();
  return /^[^\s@*]+@[^\s@*]+\.[a-z]{2,}$/.test(s) ? s : null;
}

// ── Findymail ───────────────────────────────────────────────────────────────
// Docs: https://app.findymail.com/docs/ (read 2026-11-14).
//   Find from name:     POST https://app.findymail.com/api/search/name {"name", "domain"}
//   Find from LinkedIn: POST https://app.findymail.com/api/search/business-profile {"linkedin_url"}
//   Auth: Authorization: Bearer <key>. 200 {"contact": {"name", "domain", "email"}}. One finder
//   credit only when an email is found. 402 no credits, 423 subscription paused, 429 busy.
//   UNCONFIRMED: the not-found body (read as: no contact.email, or 404).

const FINDYMAIL = "https://app.findymail.com/api/search";

async function findymail(path, payload, { env, request }) {
  const key = text(env?.FINDYMAIL_API_KEY);
  const r = await send({
    url: `${FINDYMAIL}/${path}`,
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    key,
    request,
  });
  if (r.status === 404) return { status: "empty", note: "Findymail found no email", run: r.run };
  if (r.status === 423) return { status: "error", note: "Findymail: the subscription is paused (HTTP 423)", retryable: false, run: r.run };
  if (!r.ok) return failure("Findymail", "FINDYMAIL_API_KEY", r);
  const contact = r.json?.contact ?? r.json?.payload?.contact ?? null;
  const email = address(contact?.email);
  if (!email) return { status: "empty", note: "Findymail found no email", run: r.run };
  return { status: "done", value: { email, contact }, display: email, note: "Found by Findymail", run: r.run };
}

/** P#46: Findymail by full name and the company's domain. Value { email, contact }: P#47 and P#50 read .email. */
export async function findymailByName({ inputs, env }) {
  const name = text(inputs.full_name);
  const domain = text(inputs.company_domain);
  if (!name || !domain) return { status: "empty", note: "No full name and domain to search with" };
  return findymail("name", { name, domain }, { env, request: { full_name: name, company_domain: domain } });
}

/** P#51: Findymail by the person's LinkedIn URL. Value { email, contact }: P#52, P#53 and P#55 read .email. */
export async function findymailByLinkedin({ inputs, env }) {
  const url = text(inputs.profile_url);
  if (!url) return { status: "empty", note: "No LinkedIn URL" };
  return findymail("business-profile", { linkedin_url: url }, { env, request: { profile_url: url } });
}

// ── Prospeo ─────────────────────────────────────────────────────────────────
// Docs: https://prospeo.io/api-docs/enrich-person (read 2026-11-14; the old
// email-finder page now shows the API introduction).
//   POST https://api.prospeo.io/enrich-person, header X-KEY, body
//   {"only_verified_email": bool, "data": {"full_name", "company_website"} or {"linkedin_url"}}.
//   200 {"error": false, "person": {"email": {"status", "revealed", "email"}, ...}}.
//   No match is HTTP 400 with error_code NO_MATCH, and costs nothing. 1 credit per email found.
//   UNCONFIRMED: email statuses other than VERIFIED, and the 429 body.

const PROSPEO = "https://api.prospeo.io/enrich-person";

async function prospeo(data, { env, onlyVerified, request }) {
  const key = text(env?.PROSPEO_API_KEY);
  const r = await send({
    url: PROSPEO,
    headers: { "x-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ only_verified_email: onlyVerified, data }),
    key,
    request,
  });
  const code = text(r.json?.error_code).toUpperCase();
  if (code === "NO_MATCH" || code === "INVALID_DATAPOINTS") return { found: false, r };
  if (code === "INVALID_API_KEY") return { fail: { status: "error", note: `Prospeo refused PROSPEO_API_KEY (HTTP ${r.status})`, retryable: false, run: r.run } };
  if (code === "INSUFFICIENT_CREDITS") return { fail: { status: "error", note: "Prospeo: the account is out of credits", retryable: false, run: r.run } };
  if (code === "INTERNAL_ERROR") return { fail: { status: "error", note: "Prospeo: an internal error, tried again later", retryable: true, run: r.run } };
  if (!r.ok || r.json?.error === true) return { fail: failure("Prospeo", "PROSPEO_API_KEY", r) };
  const person = r.json?.person ?? null;
  const mail = person?.email && typeof person.email === "object" ? person.email : {};
  return { found: Boolean(address(mail.email)), r, person, mail, email: address(mail.email) };
}

/** P#47: Prospeo by full name and the company's domain. Value { email, status, person }: P#48 and P#50 read .email. */
export async function prospeoByName({ inputs, env }) {
  const name = text(inputs.full_name);
  const domain = text(inputs.company_domain);
  if (!name || !domain) return { status: "empty", note: "No full name and domain to search with" };
  // Clay's include_catch_all, unset in the original: only verified addresses then.
  const onlyVerified = inputs.include_catch_all !== true && text(inputs.include_catch_all).toLowerCase() !== "true";
  const out = await prospeo({ full_name: name, company_website: domain }, { env, onlyVerified, request: { full_name: name, company_domain: domain, only_verified_email: onlyVerified } });
  if (out.fail) return out.fail;
  if (!out.found) return { status: "empty", note: "Prospeo found no email", run: out.r.run };
  return {
    status: "done",
    value: { email: out.email, status: out.mail.status ?? null, person: out.person },
    display: out.email,
    note: `Found by Prospeo${out.mail.status ? ` (${out.mail.status})` : ""}`,
    run: out.r.run,
  };
}

/** P#52: Prospeo by the person's LinkedIn URL. Value: Prospeo's person, whose email is { email, status }: P#53 and P#55 read .email.email. */
export async function prospeoByLinkedin({ inputs, env }) {
  const url = text(inputs.personal_linkedin_url);
  if (!url) return { status: "empty", note: "No LinkedIn URL" };
  const out = await prospeo({ linkedin_url: url }, { env, onlyVerified: true, request: { personal_linkedin_url: url, only_verified_email: true } });
  if (out.fail) return out.fail;
  if (!out.found) return { status: "empty", note: "Prospeo found no email", run: out.r.run };
  return {
    status: "done",
    value: { ...out.person, email: { ...out.mail, email: out.email } },
    display: out.email,
    note: `Found by Prospeo${out.mail.status ? ` (${out.mail.status})` : ""}`,
    run: out.r.run,
  };
}

// ── Anymail Finder ──────────────────────────────────────────────────────────
// The request each original column holds, sent as it is: P#48 (by name and
// company) and P#53 (by LinkedIn URL). Docs: https://anymailfinder.com/email-finder-api/docs
// (read 2026-11-14): Authorization: <key> (the raw key, no "Bearer"). A valid
// email costs 1 credit; not found and blacklisted are free; no rate limit.
// The originals read the answer's results.email and results.validation.

export const ANYMAIL_HOST = "api.anymailfinder.com";

/** P#48 and P#53. Value: Anymail Finder's answer as sent. */
export async function anymailFinder({ inputs, config, env }) {
  const key = text(env?.ANYMAIL_FINDER_API_KEY);
  let u;
  try {
    u = new URL(text(inputs.url));
  } catch {
    return { status: "error", note: "The request's URL is not a URL", retryable: false };
  }
  if (u.protocol !== "https:" || u.hostname !== ANYMAIL_HOST) {
    return { status: "error", note: `Only https://${ANYMAIL_HOST} may be called, so nothing was sent`, retryable: false };
  }
  const method = text(inputs.method).toUpperCase() || "POST";
  const body = inputs.body == null || inputs.body === "" ? undefined : typeof inputs.body === "string" ? inputs.body : JSON.stringify(inputs.body);
  const headers = { ...(config?.headers ?? {}), "content-type": "application/json", accept: "application/json", authorization: key };
  let request = { method, url: u.href };
  try {
    request = { ...request, body: body ? JSON.parse(body) : null };
  } catch {
    request = { ...request, body: body ?? null };
  }
  const r = await send({ url: u.href, method, headers, body: method === "GET" ? undefined : body, key, request });
  if (r.status === 404) return { status: "empty", note: "Anymail Finder found no email", run: r.run };
  if (!r.ok) return failure("Anymail Finder", "ANYMAIL_FINDER_API_KEY", r);
  const email = address(r.json?.results?.email);
  const validation = text(r.json?.results?.validation);
  if (!email) return { status: "empty", note: "Anymail Finder found no email", run: r.run };
  return { status: "done", value: r.json, display: email, note: `Found by Anymail Finder${validation ? ` (${validation})` : ""}`, run: r.run };
}

// ── Enrichley ───────────────────────────────────────────────────────────────
// Docs: https://docs.enrichley.io/api-reference/endpoint/email-validation.md (read 2026-11-14).
//   POST https://api.enrichley.io/api/v1/validate-single-email, header X-Api-Key, body {"email"}.
//   200 {"email", "valid": bool, "result": ok | catch_all_validated | catch_all | invalid | unknown, ...}.
//   One credit a check (whether invalid or unknown results are free is UNCONFIRMED).
//   G#42 and P#14 read .valid, G#43 .result, P#50 and P#55 .valid and .email.

const ENRICHLEY = "https://api.enrichley.io/api/v1/validate-single-email";

/** G#41, P#13, P#49 and P#54. Value: Enrichley's answer, with the address checked as .email. */
export async function enrichleyVerify({ inputs, env }) {
  const email = text(inputs.email).toLowerCase();
  if (!email) return { status: "empty", note: "No address to check" };
  const key = text(env?.ENRICHLEY_API_KEY);
  const r = await send({
    url: ENRICHLEY,
    headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ email }),
    key,
    request: { email },
  });
  if (!r.ok) return failure("Enrichley", "ENRICHLEY_API_KEY", r);
  if (!r.json || typeof r.json !== "object" || typeof r.json.valid !== "boolean") {
    return { status: "error", note: "Enrichley's answer had no valid field", retryable: false, run: r.run };
  }
  const value = { ...r.json, email: address(r.json.email) ?? email };
  return { status: "done", value, display: `${value.valid ? "Valid" : "Not valid"}${value.result ? `: ${value.result}` : ""}`, note: "Checked by Enrichley", run: r.run };
}
