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
// takes its model from there when its column names a setting.

import { CLIENT_ACTIONS } from "./client-checks.mjs";
import { COMPANY_ACTIONS } from "./company-actions.mjs";
import { bareDomain } from "./domain.mjs";

export { bareDomain };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SITE_TIMEOUT_MS = 8_000;
const RESPONSE_CAP = 32_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (v) => (v == null ? "" : String(v).trim());

/** A provider answer cut down to what enrich_cell_runs keeps. */
export function capped(value) {
  if (value == null) return null;
  const s = JSON.stringify(value);
  return s.length <= RESPONSE_CAP ? value : { truncated: true, head: s.slice(0, RESPONSE_CAP) };
}

/**
 * JSON over HTTP with retries on 429/5xx and network errors. Never throws for
 * an HTTP status: the caller decides what a status means.
 */
async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 30_000, tries = 3 } = {}) {
  let last = { ok: false, status: 0, json: null, error: "no attempt" };
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(timeoutMs) });
      const raw = await res.text();
      let json = null;
      try { json = JSON.parse(raw); } catch { /* not JSON */ }
      last = { ok: res.ok, status: res.status, json, error: res.ok ? null : `HTTP ${res.status}: ${raw.slice(0, 200)}` };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      last = { ok: false, status: 0, json: null, error: timeout ? `timed out after ${timeoutMs / 1000}s` : (e?.cause?.code || e?.message || "request failed") };
    }
    if (attempt < tries) await sleep(2_000 * attempt);
  }
  return last;
}

const retryableStatus = (s) => s === 0 || s === 429 || s >= 500;

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

// ── get-domain-from-company-name (Clay "Clearbit") ──────────────────────────
// Clearbit's Name to Domain API. Not yet run against a live key: confirm the
// response shape on the first real call.

async function domainFromName({ inputs, env }) {
  const name = text(inputs.companyName);
  if (!name) return { status: "empty", note: "No company name" };
  const r = await httpJson(`https://company.clearbit.com/v1/domains/find?name=${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${env.CLEARBIT_API_KEY}`, accept: "application/json" },
    timeoutMs: 20_000,
  });
  const run = { request: { companyName: name }, response: capped(r.json), http_status: r.status || null, error: r.ok ? null : r.error };
  if (r.status === 404 || r.status === 422) return { status: "empty", note: "Clearbit has no domain for this name", run };
  if (!r.ok) {
    return { status: "error", note: `Clearbit: ${r.error}`, retryable: retryableStatus(r.status), run };
  }
  const domain = text(r.json?.domain);
  return domain
    ? { status: "done", value: r.json, display: domain, run }
    : { status: "empty", note: "Clearbit returned no domain", run };
}

// ── use-ai (Clay "Claygent": an AI agent with web search) ───────────────────
// OpenAI Responses API with web search and a strict JSON answer, as Corofy's
// production enrichment does (gpt-4o-mini, the model Clay's column uses).
//
// A column can name a model setting (config.model_setting, a key of
// enrich_settings.models): the model, the most searches (max_tool_calls) and
// the reasoning effort then come from that setting at run time, and a setting
// that is missing is an error, never some other model. config.tool picks the
// search tool: "web_search" ($10 per 1,000 calls), else the old default
// "web_search_preview" ($25 per 1,000 on non-reasoning models), which a column
// with no tool keeps, so its requests are unchanged. Inputs city, region and
// country, when given, tell the search where the office is (user_location).

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

async function aiWeb({ inputs, config, env, settings }) {
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
  const toolType = config.tool || "web_search_preview";
  const location = userLocation(inputs);
  const tool = { type: toolType, ...(location ? { user_location: location } : {}) };
  const fields = Object.keys(config.answer ?? { response: "text" });
  const schema = {
    type: "object",
    additionalProperties: false,
    required: fields,
    properties: Object.fromEntries(fields.map((f) => [f, { type: "string", description: config.answer_description || "" }])),
  };
  const r = await httpJson("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      tools: [tool],
      input: prompt,
      ...(setting?.max_searches ? { max_tool_calls: setting.max_searches } : {}),
      ...(setting?.reasoning_effort ? { reasoning: { effort: setting.reasoning_effort } } : {}),
      text: { format: { type: "json_schema", name: "answer", schema, strict: true } },
    }),
    timeoutMs: 120_000,
  });
  const request = {
    model,
    ...(config.model_setting ? { model_setting: config.model_setting, tool: toolType } : {}),
    ...(setting?.max_searches ? { max_tool_calls: setting.max_searches } : {}),
    ...(setting?.reasoning_effort ? { reasoning_effort: setting.reasoning_effort } : {}),
    ...(location ? { user_location: location } : {}),
    prompt: prompt.slice(0, 8_000),
  };
  if (!r.ok) {
    const keyProblem = r.status === 401 || r.status === 403;
    return {
      status: "error",
      note: keyProblem ? "OpenAI refused the key (401/403)" : `OpenAI: ${r.error}`,
      retryable: retryableStatus(r.status),
      run: { request, response: capped(r.json), http_status: r.status || null, error: r.error },
    };
  }
  const out = r.json ?? {};
  const textOut =
    out.output_text ?? out.output?.flatMap((o) => o?.content ?? []).find((c) => c?.type === "output_text")?.text;
  let answer = null;
  try { answer = JSON.parse(textOut); } catch { /* left null */ }
  const sources = (out.output ?? [])
    .flatMap((o) => o?.content ?? [])
    .flatMap((c) => c?.annotations ?? [])
    .filter((a) => a?.type === "url_citation")
    .map((a) => a.url);
  // Each search the model made is billed on its own: kept beside the tokens for the cost query.
  const webSearches = (out.output ?? []).filter((o) => o?.type === "web_search_call").length;
  const run = { request, response: capped({ answer, sources, usage: out.usage ?? null, web_searches: webSearches }), http_status: r.status };
  if (!answer) return { status: "error", note: "The agent's answer was not valid JSON", retryable: true, run, model };
  const main = text(answer[fields[0]]);
  // The prompt tells the agent to answer "N/A" when it cannot confirm a site.
  // That is kept as an empty cell rather than passed on as if it were a URL.
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
  domain_from_name: { run: domainFromName, cache: true },
  ai_web: { run: aiWeb, cache: true, emptyAs: "" },
  later: { run: later, cache: false },
  ...CLIENT_ACTIONS, // AI Ark run tables: lead_lookup, client_area, client_exclusions
  ...COMPANY_ACTIONS, // the Companies template: client_office, held_general_email, pick_emails, verify_emails
};
