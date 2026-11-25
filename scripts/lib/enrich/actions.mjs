// The Clay actions behind the Companies table's action columns.
//
// Each run() resolves to
//   { status: 'done' | 'empty' | 'error', value, display, note, retryable, run }
// where run = { request, response, http_status, error } is kept in
// enrich_cell_runs. An expected outcome (not found, a dead website) is a result,
// not an exception. Error text never carries a request URL or a key.
//
//   cache: false — free lookups that must see new data (keys imported since the
//                  last run) are re-done every run instead of reused.
//   emptyAs: ''  — empty cells read as "" while the inputs are bound (prompts).
//
// Every run() also gets `settings` (scripts/lib/enrich/settings.mjs): ai_web
// takes its model from there when its column names a setting. HTTP lives in
// http.mjs, shared with the pipeline's own actions.

import { CLIENT_ACTIONS } from "./client-checks.mjs";
import { COMPANY_ACTIONS } from "./company-actions.mjs";
import { bareDomain } from "./domain.mjs";
import { answerWith, capped, lostSendGuard, paidHttpJson, retryableStatus } from "./http.mjs";
import { FIT_ACTIONS } from "./fit-keys.mjs";
import { pageStart, pagesForPrompt, readSite, readsPages, siteInPrompt } from "./page-read.mjs";
import { PIPELINE_ACTIONS } from "./pipeline-actions.mjs";
import { addOpenAiSpend, spendAllowed } from "./spend.mjs";

export { bareDomain, capped };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SITE_TIMEOUT_MS = 8_000;

const text = (v) => (v == null ? "" : String(v).trim());

// ── normalize-url (Clay "Normalize a Domain", type "bare"; bareDomain is in domain.mjs) ──

async function normalizeUrl({ inputs }) {
  const domain = bareDomain(inputs.url);
  if (!domain) return { status: "empty", note: `"${text(inputs.url)}" has no domain` };
  return { status: "done", value: { normalizedUrl: domain }, display: domain };
}

// ── check-url (Clay "Check if URL is Valid") ────────────────────────────────

function siteVariants(raw, tryVariants) {
  const s = text(raw);
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  let u;
  try { u = new URL(hasScheme ? s : `https://${s}`); } catch { return []; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return [];
  const out = [u.href];
  if (tryVariants) {
    const other = u.protocol === "https:" ? "http:" : "https:";
    const host = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
    for (const [proto, h] of [[other, u.hostname], [u.protocol, host], [other, host]]) {
      const v = new URL(u.href);
      v.protocol = proto;
      v.hostname = h;
      out.push(v.href);
    }
  }
  return [...new Set(out)];
}

async function probe(url) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
    });
    res.body?.cancel().catch(() => {});
    return { url, status: res.status, final_url: res.url, ms: Date.now() - t0 };
  } catch (e) {
    const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
    return { url, error: timeout ? "timeout" : (e?.cause?.code || e?.message || "failed"), timeout, ms: Date.now() - t0 };
  }
}

// A site that answers at all is up, even when it turns a bot away.
const answered = (status) => status < 400 || [401, 403, 405, 406, 429].includes(status);

async function checkUrl({ inputs }) {
  const raw = text(inputs.url);
  if (!raw) return { status: "empty", note: "No URL" };
  const tryVariants = inputs.tryVariants !== false;
  const timeoutInvalid = inputs.treatTimeoutsAsInvalid === true;
  const candidates = siteVariants(raw, tryVariants);
  if (!candidates.length) {
    return { status: "done", value: { valid: false, url: raw, reason: "not a website address" }, display: "Invalid", note: "Not a website address" };
  }
  const tried = [];
  for (const url of candidates) {
    const p = await probe(url);
    tried.push(p);
    if (p.status && answered(p.status)) {
      return {
        status: "done",
        value: { valid: true, url: p.final_url || url, status: p.status, tried },
        display: "Valid",
        note: `${p.status} from ${p.final_url || url}`,
        run: { request: { url: raw, tryVariants, treatTimeoutsAsInvalid: timeoutInvalid }, response: { tried } },
      };
    }
    if (p.timeout && !timeoutInvalid) {
      return {
        status: "done",
        value: { valid: true, url, timedOut: true, tried },
        display: "Valid",
        note: "Timed out — counted as valid (Clay setting: timeouts are not invalid)",
        run: { request: { url: raw, tryVariants, treatTimeoutsAsInvalid: timeoutInvalid }, response: { tried } },
      };
    }
  }
  const lastErr = tried.map((t) => t.error || `HTTP ${t.status}`).join(" · ");
  return {
    status: "done",
    value: { valid: false, url: raw, tried },
    display: "Invalid",
    note: lastErr,
    run: { request: { url: raw, tryVariants, treatTimeoutsAsInvalid: timeoutInvalid }, response: { tried } },
  };
}

// ── lookup-row-in-other-table (Clay "DUPE CHECK") ───────────────────────────
// Clay looked the key up in the client's older Clay tables. Here those tables'
// keys are imported once into imported_company_keys.

async function lookupKey({ inputs, config, table, db }) {
  const key = text(inputs.key);
  if (!key) return { status: "empty", note: "No CHECK key" };
  const { rows } = await db.query(
    `SELECT 1 FROM imported_company_keys WHERE client_tag = $1 AND source_table = $2 AND company_key = $3 LIMIT 1`,
    [table.client_tag, config.source_table, key]
  );
  if (rows.length) {
    return {
      status: "done",
      value: { record: { CHECK: key, table: config.source_table } },
      display: "Already worked",
      note: `Found in "${config.source_table}"`,
    };
  }
  const imported = table.keyCounts?.[config.source_table] ?? 0;
  return {
    status: "empty",
    note: imported
      ? `Not in "${config.source_table}" (${imported.toLocaleString("en-US")} keys imported)`
      : `Not found — no keys from "${config.source_table}" have been imported yet`,
  };
}

// ── use-ai (Clay "Claygent": an AI agent with web search) ───────────────────
// OpenAI Responses API with a strict JSON answer. A column names its model
// setting (config.model_setting, a key of enrich_settings.models): the model,
// the most tool calls (max_tool_calls) and the reasoning effort come from that
// setting at run time, and a setting that is missing is an error, never some
// other model.
//
// The compiled originals (2A.1, 2A.5) also set:
//   answer         Clay's answer fields, { field: { type, description, options } }:
//                  url and string are strings with the field's description, a
//                  select an enum of its option texts. Phase 1's { field: "text" }
//                  form still works.
//   tool           "web_search" (claygent; $10 per 1,000 calls) or "none" (use-ai).
//   user_location  false: no location is sent (the originals send none).
//   keep_na        an "N/A" answer stays the answer, as in Clay.
//   table_examples Clay's table examples as exported, never sent as they are.
//   examples_text  the same examples laid out by ai-examples.mjs (examples_count,
//                  examples_sha beside it): sent with every request as its
//                  instructions, the prompt staying the input. A column whose
//                  examples could not be read (examples_error), or whose table
//                  was compiled before they were laid out, is not run; one with
//                  none sends exactly what a column without examples sends.
// One send per attempt: the row's own retry handles a lost answer, and a cell
// sent twice with no answer is not sent again (http.mjs). OpenAI's billing
// refusals are never retried. A rate limit (a 429 that is not a billing or
// quota refusal, openAiRateLimited) is waited out and sent again in place,
// within the bounds of http.mjs paidHttpJson, so the row keeps its slot
// instead of going back to the queue; a 429 is not billed. Each call checks
// the day's OpenAI cap for its loop first and adds what it cost after
// (spend.mjs). The run record keeps the rate-limit headers OpenAI sent
// (response.rate_limit) and the waits (response.rate_limited), and the
// worker's heartbeat the latest headers per model (openAiRateLimits).
//
// The two email searches (page-read.mjs readsPages) open the company's own
// pages first, as Clay's Claygent visits them: the place's page (input
// page_url) when it is on the website's site, else the website (input site,
// or the site the prompt names on a table compiled before those inputs), then
// its contact, location and about pages. The pages, the addresses found on
// them and an excerpt of each go after the prompt; both keep their web search,
// as Clay's Claygent does. The run record keeps which pages were read.

/** OpenAI's approximate user location, from the inputs, or null. country is a 2-letter code. */
function userLocation(inputs) {
  const city = text(inputs.city);
  const region = text(inputs.region);
  const country = text(inputs.country).toUpperCase();
  if (!city && !region && !country) return null;
  return {
    type: "approximate",
    ...(/^[A-Z]{2}$/.test(country) ? { country } : {}),
    ...(region ? { region } : {}),
    ...(city ? { city } : {}),
  };
}

/** OpenAI's billing and spend refusals: never worth sending again. */
const BILLING_CODES = new Set(["insufficient_quota", "organization_usage_limit_exceeded", "credit_balance_exhausted", "billing_hard_limit_reached"]);
export function billingCode(json) {
  const err = json?.error ?? {};
  for (const c of [err.code, err.type]) {
    const code = text(c);
    if (code && (BILLING_CODES.has(code) || /_spend_limit_exceeded$/.test(code))) return code;
  }
  return null;
}

/**
 * Is this 429 a plain rate limit, waited out and sent again in place? Never a
 * billing or quota refusal: billingCode's codes, or, when OpenAI gives no rate
 * limit code, words of one (quota, billing, credit). Those stop, as before.
 *
 * @param {{ status: number, json: any }} r
 */
export function openAiRateLimited(r) {
  if (r?.status !== 429 || billingCode(r.json)) return false;
  const err = r.json?.error ?? {};
  if (text(err.code) === "rate_limit_exceeded" || ["requests", "tokens"].includes(text(err.type))) return true;
  return !/quota|billing|credit/i.test(`${text(err.code)} ${text(err.type)} ${text(err.message)}`);
}

/** OpenAI's rate-limit headers, as a run record and the heartbeat keep them. */
const RATE_LIMIT_HEADERS = Object.freeze([
  ["limit_requests", "x-ratelimit-limit-requests"],
  ["remaining_requests", "x-ratelimit-remaining-requests"],
  ["limit_tokens", "x-ratelimit-limit-tokens"],
  ["remaining_tokens", "x-ratelimit-remaining-tokens"],
  ["reset_requests", "x-ratelimit-reset-requests"],
  ["reset_tokens", "x-ratelimit-reset-tokens"],
]);

/**
 * The rate-limit headers of one OpenAI answer: the limits and what is left as
 * numbers, the resets as OpenAI writes them ("1s", "6m0s"). Null when it sent
 * none (no answer at all, or a stand-in).
 *
 * @param {{ get: (name: string) => string | null } | null | undefined} headers
 * @returns {Record<string, number | string> | null}
 */
export function openAiRateLimit(headers) {
  if (!headers || typeof headers.get !== "function") return null;
  /** @type {Record<string, number | string>} */
  const out = {};
  for (const [field, name] of RATE_LIMIT_HEADERS) {
    const v = headers.get(name);
    if (v == null || v === "") continue;
    out[field] = field.startsWith("reset_") || !Number.isFinite(Number(v)) ? String(v) : Number(v);
  }
  return Object.keys(out).length ? out : null;
}

// The latest headers per model (OpenAI's limits are per model), for the
// heartbeat: the owner reads the account's token and request limits there,
// without OpenAI's dashboard. A few models at most; the oldest goes first.
const latestRateLimits = new Map();
const RATE_LIMIT_MODELS_KEPT = 10;

function keepRateLimit(model, limits) {
  if (!limits) return;
  latestRateLimits.delete(model);
  latestRateLimits.set(model, { ...limits, at: new Date().toISOString() });
  while (latestRateLimits.size > RATE_LIMIT_MODELS_KEPT) latestRateLimits.delete(latestRateLimits.keys().next().value);
}

/** What OpenAI last said of its rate limits, per model, with when: { [model]: { limit_tokens, remaining_tokens, ..., at } }. */
export function openAiRateLimits() {
  return Object.fromEntries(latestRateLimits);
}

/** For tests: forget the rate limits read. */
export function resetOpenAiRateLimits() {
  latestRateLimits.clear();
}

/**
 * The JSON schema of the answer: Clay's fields in Clay's order. A compiled
 * column keeps that order in config.answer_order, since enrich_columns.config
 * is jsonb, which keeps no key order; the first field is the cell's display.
 */
export function answerSchema(config) {
  const answer = config.answer && typeof config.answer === "object" ? config.answer : { response: "text" };
  const keys = Object.keys(answer);
  const listed = Array.isArray(config.answer_order) ? config.answer_order.filter((f) => typeof f === "string" && Object.hasOwn(answer, f)) : [];
  const fields = listed.length === keys.length && new Set(listed).size === keys.length ? listed : keys;
  /** @type {Record<string, any>} */
  const properties = {};
  for (const f of fields) {
    const spec = answer[f];
    if (spec && typeof spec === "object") {
      const p = { type: spec.type === "number" ? "number" : spec.type === "boolean" ? "boolean" : "string" };
      if (spec.description) p.description = String(spec.description);
      if (spec.type === "select" && Array.isArray(spec.options) && spec.options.length) p.enum = spec.options.map(String);
      properties[f] = p;
    } else {
      properties[f] = { type: "string", description: config.answer_description || "" };
    }
  }
  return { fields, schema: { type: "object", additionalProperties: false, required: fields, properties } };
}

/** The web searches a response made: a web_search_call is a search unless its action says it opened or read a page. */
export const searchesIn = (out) =>
  (out?.output ?? []).filter((o) => o?.type === "web_search_call" && (o.action?.type ?? "search") === "search").length;

async function aiWeb({ inputs, config, env, settings, db, row, column }) {
  // Table examples held but not laid out (unreadable, or a table compiled before they were): never sent without them.
  if (config.table_examples != null && config.examples_count !== 0 && typeof config.examples_text !== "string") {
    return {
      status: "skipped",
      note: config.examples_error
        ? `Its table examples could not be read (${config.examples_error}), so it is not run (nothing was sent)`
        : "Its table examples are not compiled yet: the client's tables are brought up to date on its next pull or people run",
    };
  }
  const examples = Number(config.examples_count) > 0 && typeof config.examples_text === "string" ? config.examples_text : null;
  const prompt = text(inputs.prompt);
  if (!prompt) return { status: "empty", note: "Empty prompt" };
  let model = config.model || "gpt-4o-mini";
  let setting = null;
  if (config.model_setting) {
    setting = settings?.models?.[config.model_setting] ?? null;
    if (!setting?.model) {
      return {
        status: "error",
        note: `No model is set for "${config.model_setting}" (the Companies tab's settings), so nothing was sent`,
        retryable: false,
      };
    }
    model = setting.model;
  }
  const loop = config.spend_loop === "fit" ? "fit" : "pipeline";
  if (db && settings) {
    const gate = await spendAllowed(db, `openai_usd_${loop}`, settings);
    if (!gate.ok) return { status: "needs_key", note: gate.why };
  }
  const stop = await lostSendGuard({ db, row, column });
  if (stop) return stop;

  const toolType = config.tool || "web_search_preview";
  const location = config.user_location === false ? null : userLocation(inputs);
  // The company's own pages, read first by the email searches (free).
  let read = null;
  if (readsPages(column)) {
    const start = pageStart(inputs.page_url, text(inputs.site) || siteInPrompt(prompt));
    if (start) read = await readSite(start);
  }
  const noTool = toolType === "none";
  const tool = noTool ? null : { type: toolType, ...(location ? { user_location: location } : {}) };
  const pagesText = read ? pagesForPrompt(read, { tools: Boolean(tool) }) : "";
  const input = pagesText ? `${prompt}\n\n${pagesText}` : prompt;
  const { fields, schema } = answerSchema(config);
  const r = await paidHttpJson("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      ...(tool ? { tools: [tool] } : {}),
      ...(examples ? { instructions: examples } : {}),
      input,
      ...(tool && setting?.max_searches ? { max_tool_calls: setting.max_searches } : {}),
      ...(setting?.reasoning_effort ? { reasoning: { effort: setting.reasoning_effort } } : {}),
      text: { format: { type: "json_schema", name: "answer", schema, strict: true } },
    }),
    timeoutMs: 120_000,
  }, { isRateLimit: openAiRateLimited });
  const rateLimit = openAiRateLimit(r.headers);
  keepRateLimit(model, rateLimit);
  const limits = { ...(rateLimit ? { rate_limit: rateLimit } : {}), ...(r.rate_limited ? { rate_limited: r.rate_limited } : {}) };
  const request = {
    model,
    ...(config.model_setting ? { model_setting: config.model_setting, tool: noTool ? "none" : toolType } : {}),
    ...(tool && setting?.max_searches ? { max_tool_calls: setting.max_searches } : {}),
    ...(setting?.reasoning_effort ? { reasoning_effort: setting.reasoning_effort } : {}),
    ...(location ? { user_location: location } : {}),
    prompt: prompt.slice(0, 8_000),
    ...(examples ? { examples: config.examples_count, instructions: examples.slice(0, 8_000) } : {}),
    ...(read
      ? {
          pages: {
            start: read.start,
            emails: read.emails,
            read: read.pages.map((p) => ({ url: p.url, kind: p.kind, ...(p.status ? { status: p.status } : {}), ...(p.error ? { error: p.error } : { emails: p.emails?.length ?? 0 }) })),
          },
          pages_text: pagesText.slice(0, 9_000),
        }
      : readsPages(column)
        ? { pages: { start: null, note: "No website to open" } }
        : {}),
  };
  if (!r.ok) {
    const keyProblem = r.status === 401 || r.status === 403;
    const billing = r.status === 429 || r.status === 402 ? billingCode(r.json) : null;
    return {
      status: "error",
      note: keyProblem
        ? "OpenAI refused the key (401/403)"
        : billing
          ? `OpenAI refused for billing (${billing}), so it is not sent again`
          : `OpenAI: ${r.error}`,
      retryable: !billing && !keyProblem && retryableStatus(r.status),
      run: { request, response: capped(answerWith(r.json, limits)), http_status: r.status || null, error: r.error },
    };
  }
  const out = r.json ?? {};
  const textOut =
    out.output_text ?? out.output?.flatMap((o) => o?.content ?? []).find((c) => c?.type === "output_text")?.text;
  let answer = null;
  try {
    answer = JSON.parse(textOut);
  } catch {
    /* left null */
  }
  const sources = (out.output ?? [])
    .flatMap((o) => o?.content ?? [])
    .flatMap((c) => c?.annotations ?? [])
    .filter((a) => a?.type === "url_citation")
    .map((a) => a.url);
  // Each search the model made is billed on its own: kept beside the tokens for the cost query.
  const webSearches = searchesIn(out);
  let cost = null;
  if (db) {
    try {
      cost = await addOpenAiSpend(db, loop, { model, usage: out.usage ?? null, searches: webSearches }, settings?.spend_caps?.openai_prices);
    } catch {
      cost = null; // the answer stands; the cap reads what was counted
    }
  }
  const run = {
    request,
    response: capped({ answer, sources, usage: out.usage ?? null, web_searches: webSearches, ...(cost ? { cost_usd: cost.usd } : {}), ...limits }),
    http_status: r.status,
  };
  if (!answer || typeof answer !== "object") return { status: "error", note: "The agent's answer was not valid JSON", retryable: true, run, model };
  const main = text(answer[fields[0]]);
  if (config.keep_na) {
    // As in Clay: the answer is kept as returned, an "N/A" included.
    return { status: "done", value: answer, display: main || "(no answer)", run, model };
  }
  // Phase 1's rule: an "N/A" is kept as an empty cell rather than passed on as if it were a URL.
  if (!main || /^n\/?a\.?$/i.test(main)) {
    return { status: "empty", note: `The agent answered "${main || "(nothing)"}"`, run, model };
  }
  return { status: "done", value: answer, display: main, run, model };
}

// A later phase's column is shown and never run (the engine skips phase > 1);
// this entry only makes "later" a known action.
async function later() {
  return { status: "skipped", note: "Built in a later phase" };
}

export const ACTIONS = {
  check_url: { run: checkUrl, cache: true },
  normalize_url: { run: normalizeUrl, cache: false },
  lookup_key: { run: lookupKey, cache: false },
  ai_web: { run: aiWeb, cache: true, emptyAs: "" },
  later: { run: later, cache: false },
  ...CLIENT_ACTIONS, // AI Ark run tables: lead_lookup, client_area, client_exclusions
  ...COMPANY_ACTIONS, // the Companies template's phase 1 checks: client_office, held_general_email
  ...PIPELINE_ACTIONS, // the pipeline templates (pipeline-actions.mjs): write-tos, Reoon, the finders, Enrichley, people
  ...FIT_ACTIONS, // fit_lookup (fit-keys.mjs): the shared fit score on a Companies (pipeline) row, free
};
