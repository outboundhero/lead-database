#!/usr/bin/env node
// Checks for rate limits waited out in place (scripts/lib/enrich/http.mjs
// paidHttpJson): the AI columns' OpenAI calls (actions.mjs ai_web) and the
// email finders and Enrichley (email-vendors.mjs), plus the worker's wiring
// for the speed changes of 2026-11-26. No database and no network: fetch
// answers from the queues planned here, the waits are recorded instead of
// slept, and the steps run on a fake database that answers the spend, daily
// cap and lost-send queries.
//
//   node scripts/test-rate-limit-retry.mjs
//
//   R1. the wait a 429 asks for: retry-after-ms, Retry-After (seconds or a
//       date), the answer's own words, the x-ratelimit-reset headers, or none
//   R2. paidHttpJson: a 429 then a 200 is sent again and answered once;
//       Retry-After honoured; the caps (60 s a wait, 3 retries, 2 minutes in
//       all); the backoff with no hint; a refusal, a send with no answer and a
//       5xx are sent once
//   R3. ai_web: the 429 waited out with its cost counted once, the headers in
//       the run record and the heartbeat's latest per model; insufficient_quota
//       and quota words never sent again; the caps; the lost-send guard
//   R4. the finders and Enrichley: a 429 waited out with one of the day's
//       calls; out of credits never sent again; the caps; the lost-send guard
//   R5. the worker: the 60-second block and the heartbeat beside the rows on a
//       pool of their own, a free slot claimed at once, the drain and the stop,
//       promotion every 2 minutes, the waiting sweep every 5 minutes

import { readFileSync } from "node:fs";
import { checker } from "./fixtures/test-support.mjs";
import { askedWaitMs, durationMs, paidHttpJson, RATE_LIMIT_RETRY, rateLimitWaits, setRateLimitDeps } from "./lib/enrich/http.mjs";
import { ACTIONS, openAiRateLimited, openAiRateLimits, resetOpenAiRateLimits } from "./lib/enrich/actions.mjs";
import { anymailFinder, enrichleyVerify, findymailByName, prospeoByName, vendorRateLimited } from "./lib/enrich/email-vendors.mjs";
import { runRow } from "./lib/enrich/engine.mjs";
import { settingsFrom } from "./lib/enrich/settings.mjs";

const t0 = Date.now();
const count = checker();
const { check, section } = count;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── Stand-ins ───────────────────────────────────────────────────────────────

/** What each host answers next, in order: { status, body, headers }, or 0 for no answer at all. */
const answers = new Map();
/** Every request sent: { host, path, body }. */
let sent = [];
const plan = (host, ...list) => answers.set(host, list);
const sentTo = (host) => sent.filter((s) => s.host === host);
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  sent.push({ host: u.hostname, path: u.pathname, body: init.body ?? null });
  const next = answers.get(u.hostname)?.shift();
  if (next === undefined) throw Object.assign(new TypeError("fetch failed: nothing planned for this host"), { cause: { code: "ECONNREFUSED" } });
  if (next === 0) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: { "content-type": "application/json", ...(next.headers ?? {}) } });
};

/** The waits asked for, in ms, recorded instead of slept; no jitter unless a check sets one. */
let slept = [];
let jitter = 0;
setRateLimitDeps({ sleep: async (ms) => { slept.push(ms); }, random: () => jitter });

const fresh = () => {
  sent = [];
  slept = [];
  jitter = 0;
  answers.clear();
};

/**
 * A database that answers the steps' statements: today's spend (nothing yet),
 * the vendors' daily calls (always room), OpenAI's cost (added up), and the
 * lost-send count of enrich_cell_runs (`lost`).
 */
function fakeDb({ lost = 0 } = {}) {
  const db = {
    openaiSpend: [], // the dollars added, one entry per answered call
    vendorCalls: [], // the day's calls taken, by kind
    async query(sql, params = []) {
      if (/FROM enrich_cell_runs/.test(sql)) return { rows: [{ n: lost }] };
      if (/INSERT INTO enrich_spend_daily/.test(sql)) {
        if (/\$2::numeric/.test(sql)) {
          db.openaiSpend.push(Number(params[1]));
          return { rows: [{ used: db.openaiSpend.reduce((a, b) => a + b, 0) }] };
        }
        db.vendorCalls.push(params[1]);
        return { rows: [{ used: db.vendorCalls.length }] };
      }
      return { rows: [] };
    },
  };
  return db;
}

const settings = settingsFrom([
  {
    key: "spend_caps",
    value: {
      openai_usd_per_day: { pipeline: 5, fit: 5 },
      vendor_calls_per_day: { findymail: 100, prospeo: 100, anymail_finder: 100, enrichley: 100 },
    },
  },
]);
const KEYS = {
  OPENAI_API_KEY: "made-up-openai-key-r1",
  FINDYMAIL_API_KEY: "made-up-findymail-key-r2",
  PROSPEO_API_KEY: "made-up-prospeo-key-r3",
  ANYMAIL_FINDER_API_KEY: "made-up-anymail-key-r4",
  ENRICHLEY_API_KEY: "made-up-enrichley-key-r5",
};
const OPENAI = "api.openai.com";
const answerOf = (text) => ({
  output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ response: text }) }] }],
  usage: { input_tokens: 900, output_tokens: 40 },
});
const limitHeaders = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`x-ratelimit-${k}`, String(v)]));
const tpmLimit = (wait) => ({
  error: {
    message: `Rate limit reached for gpt-test in organization org-madeup on tokens per min (TPM): Limit 30000, Used 29500, Requested 900. Please try again in ${wait}. Visit https://platform.openai.com/account/rate-limits to learn more.`,
    type: "tokens", param: null, code: "rate_limit_exceeded",
  },
});

// ── R1 ──────────────────────────────────────────────────────────────────────
section("R1. The wait a 429 asks for");
check("durationMs: OpenAI's forms and plain seconds; anything else is none",
  durationMs("20ms") === 20 && durationMs("1.5s") === 1500 && durationMs("6m0s") === 360_000 && durationMs("1h2m3s") === 3_723_000 &&
    durationMs("30") === 30_000 && durationMs(" 2S ") === 2000 && [null, undefined, "", "abc", "5x", "1s2", "-3", "s"].every((v) => durationMs(v) === null));
const ask = (headers, json = null, error = null, now) => askedWaitMs({ headers: new Headers(headers), json, error }, now);
const NOW = Date.parse("2026-11-26T10:00:00Z");
check("retry-after-ms first, then Retry-After in seconds",
  ask({ "retry-after-ms": "250", "retry-after": "9" }) === 250 && ask({ "retry-after": "7" }) === 7000 && ask({ "retry-after": "1.5" }) === 1500);
check("Retry-After as a date: the time until then, never below 0",
  ask({ "retry-after": new Date(NOW + 30_000).toUTCString() }, null, null, NOW) === 30_000 && ask({ "retry-after": new Date(NOW - 5_000).toUTCString() }, null, null, NOW) === 0);
check("the answer's own words come before the reset headers (OpenAI's message gives this request's wait)",
  ask(limitHeaders({ "reset-tokens": "6m0s", "remaining-tokens": 0 }), tpmLimit("1.5s")) === 1500 &&
    ask({}, { error: { message: "Please try again in 20ms." } }) === 20 && ask({}, null, "HTTP 429: Please retry after 20 seconds.") === 20_000 &&
    ask({}, { message: "Too many requests, retry after 30s" }) === 30_000);
check("the reset header of the limit used up (its remaining is 0)",
  ask(limitHeaders({ "remaining-requests": 0, "reset-requests": "120ms", "remaining-tokens": 5000, "reset-tokens": "6m0s" })) === 120 &&
    ask(limitHeaders({ "remaining-requests": 12, "reset-requests": "1s", "remaining-tokens": 0, "reset-tokens": "45s" })) === 45_000);
check("... else the longest reset; a plain x-ratelimit-reset in seconds or as a Unix time",
  ask(limitHeaders({ "reset-requests": "1s", "reset-tokens": "20s" })) === 20_000 && ask({ "x-ratelimit-reset": "30" }) === 30_000 &&
    ask({ "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 12) }, null, null, NOW) === 12_000 &&
    ask({ "x-ratelimit-reset": String(NOW + 4_000) }, null, null, NOW) === 4_000);
check("nothing usable: none (the caller backs off on its own)",
  ask({}) === null && ask({ "retry-after": "soon" }) === null && askedWaitMs({ headers: null, json: null, error: null }) === null);

// ── R2 ──────────────────────────────────────────────────────────────────────
section("R2. paidHttpJson: a rate limit waited out and the same request sent again");
const HOST = "api.made-up-vendor.example";
const URL_ = `https://${HOST}/v1/find`;
const always = { isRateLimit: () => true };
const go = (rule = always, body = JSON.stringify({ name: "Pat Example" })) => paidHttpJson(URL_, { method: "POST", headers: { "content-type": "application/json" }, body }, rule);
const totals0 = rateLimitWaits();

fresh();
plan(HOST, { status: 429, body: { error: "slow down" }, headers: { "retry-after": "2" } }, { status: 200, body: { ok: 1 } });
const a1 = await go();
check("a 429 then a 200: sent twice, answered once with the 200", a1.ok && a1.status === 200 && a1.json?.ok === 1 && sentTo(HOST).length === 2, JSON.stringify({ status: a1.status, sent: sent.length }));
check("... the same request both times", sent[0]?.body === sent[1]?.body && sent[0]?.path === sent[1]?.path);
check("... after the 2 s Retry-After asked for, and the waits are on the answer", same(slept, [2000]) && same(a1.rate_limited, { retries: 1, waited_ms: 2000 }), JSON.stringify({ slept, rl: a1.rate_limited }));

fresh();
plan(HOST, { status: 200, body: { ok: 2 } });
const plain = await go();
check("a 200 at once: one send, no wait, rate_limited null", plain.ok && sent.length === 1 && slept.length === 0 && plain.rate_limited === null);

fresh();
plan(HOST, { status: 429, headers: { "retry-after": "600" } }, { status: 200 });
await go();
check("each wait at most 60 s: a Retry-After of 10 minutes waits 60 s", same(slept, [RATE_LIMIT_RETRY.waitMaxMs]) && RATE_LIMIT_RETRY.waitMaxMs === 60_000, JSON.stringify(slept));

fresh();
plan(HOST, ...Array(5).fill({ status: 429, headers: { "retry-after": "1" } }));
const a3 = await go();
check("at most 3 retries: a 429 that never ends is sent 4 times, then answered as the 429 it is",
  sentTo(HOST).length === 4 && a3.status === 429 && !a3.ok && same(slept, [1000, 1000, 1000]) && same(a3.rate_limited, { retries: 3, waited_ms: 3000 }) && RATE_LIMIT_RETRY.retries === 3,
  JSON.stringify({ sent: sent.length, slept, rl: a3.rate_limited }));

fresh();
plan(HOST, ...Array(5).fill({ status: 429, headers: { "retry-after": "50" } }));
const a4 = await go();
check("at most 2 minutes of waiting in all: two waits of 50 s, a third would pass 120 s, so 3 sends",
  sentTo(HOST).length === 3 && same(slept, [50_000, 50_000]) && a4.status === 429 && RATE_LIMIT_RETRY.totalMaxMs === 120_000, JSON.stringify({ sent: sent.length, slept }));

fresh();
plan(HOST, ...Array(5).fill({ status: 429 }));
await go();
check("no hint at all: 2 s, 4 s, 8 s", same(slept, [2000, 4000, 8000]), JSON.stringify(slept));

fresh();
plan(HOST, { status: 429, headers: { "retry-after": "0" } }, { status: 200 });
await go();
check("a wait of 0 still waits a quarter second", same(slept, [RATE_LIMIT_RETRY.waitMinMs]) && RATE_LIMIT_RETRY.waitMinMs === 250, JSON.stringify(slept));

fresh();
jitter = 0.999;
plan(HOST, { status: 429, headers: { "retry-after": "2" } }, { status: 429, headers: { "retry-after": "600" } }, { status: 200 });
await go();
check("a little jitter (under half a second) on top, never past the 60 s cap", slept[0] === 2499 && slept[1] === 60_000, JSON.stringify(slept));

fresh();
plan(HOST, { status: 429, body: { error_code: "INSUFFICIENT_CREDITS" } }, { status: 200 });
const refused = await go({ isRateLimit: () => false });
check("a 429 the caller calls a refusal: sent once, no wait, answered as it is", sent.length === 1 && slept.length === 0 && refused.status === 429 && refused.rate_limited === null);

fresh();
plan(HOST, 0, { status: 200 });
const lost = await go();
check("a send with no answer (status 0) is never sent again here: the lost-send guard counts it", sent.length === 1 && slept.length === 0 && lost.status === 0 && lost.error === "ECONNRESET");

fresh();
plan(HOST, { status: 503 }, { status: 200 });
const busy = await go();
check("a 5xx is answered at once, as before (the row's own retry takes it)", sent.length === 1 && slept.length === 0 && busy.status === 503);

fresh();
plan(HOST, { status: 429, headers: { "retry-after": "1" } }, 0);
const thenLost = await go();
check("a 429, then no answer: two sends, the lost one answered as lost", sent.length === 2 && thenLost.status === 0 && same(thenLost.rate_limited, { retries: 1, waited_ms: 1000 }));

const totals = rateLimitWaits();
check("the process's totals for the heartbeat: the sends made again, the time waited, the calls still limited after their waits",
  totals.retries - totals0.retries === 1 + 1 + 3 + 2 + 3 + 1 + 2 + 1 && totals.waited_ms - totals0.waited_ms === 2000 + 60_000 + 3000 + 100_000 + 14_000 + 250 + 2499 + 60_000 + 1000 &&
    totals.gave_up - totals0.gave_up === 3,
  JSON.stringify({ totals0, totals }));

// ── R3 ──────────────────────────────────────────────────────────────────────
section("R3. ai_web: OpenAI's rate limits");
const aiConfig = { model: "gpt-test", tool: "none", answer: { response: { type: "string", description: "" } }, user_location: false };
const aiRun = (db, { row = { id: 7, run_force: [] }, config = aiConfig } = {}) =>
  ACTIONS.ai_web.run({ inputs: { prompt: "Write one made-up line about Example Dental." }, config, env: KEYS, settings, db, row, column: { key: "zz_line" } });
resetOpenAiRateLimits();

fresh();
let db = fakeDb();
plan(OPENAI,
  { status: 429, body: tpmLimit("1.5s"), headers: limitHeaders({ "limit-tokens": 30000, "remaining-tokens": 0, "limit-requests": 500, "remaining-requests": 499, "reset-tokens": "6m0s", "reset-requests": "120ms" }) },
  { status: 200, body: answerOf("A made-up line."), headers: limitHeaders({ "limit-tokens": 30000, "remaining-tokens": 28100, "limit-requests": 500, "remaining-requests": 498, "reset-tokens": "1.6s", "reset-requests": "240ms" }) });
const r1 = await aiRun(db);
check("a 429 rate limit, then the answer: the cell is done, OpenAI was sent the request twice",
  r1.status === "done" && r1.value?.response === "A made-up line." && sentTo(OPENAI).length === 2 && sent[0].body === sent[1].body, JSON.stringify({ status: r1.status, note: r1.note, sent: sent.length }));
check("... after the 1.5 s its message asked for, not the 6 minutes of the tokens reset", same(slept, [1500]), JSON.stringify(slept));
check("... its cost counted once (a 429 is not billed)", db.openaiSpend.length === 1 && db.openaiSpend[0] > 0, JSON.stringify(db.openaiSpend));
const rl = r1.run?.response?.rate_limit;
check("the run record keeps the rate-limit headers of the answer, the limits as numbers",
  same(rl, { limit_requests: 500, remaining_requests: 498, limit_tokens: 30000, remaining_tokens: 28100, reset_requests: "240ms", reset_tokens: "1.6s" }) && r1.run.http_status === 200,
  JSON.stringify(r1.run?.response));
check("... and the wait, beside the answer, usage and cost as before",
  same(r1.run.response.rate_limited, { retries: 1, waited_ms: 1500 }) && r1.run.response.answer?.response === "A made-up line." && r1.run.response.usage?.input_tokens === 900 &&
    typeof r1.run.response.cost_usd === "number");
const latest = openAiRateLimits();
check("the heartbeat's latest, per model: the token and request limits and what was left, with when",
  Object.keys(latest).join() === "gpt-test" && latest["gpt-test"].limit_tokens === 30000 && latest["gpt-test"].remaining_tokens === 28100 &&
    latest["gpt-test"].limit_requests === 500 && !Number.isNaN(Date.parse(latest["gpt-test"].at)), JSON.stringify(latest));

fresh();
db = fakeDb();
plan(OPENAI,
  { status: 429, body: tpmLimit("2s"), headers: limitHeaders({ "limit-tokens": 30000, "remaining-tokens": 0 }) },
  { status: 200, body: answerOf("Another made-up line.") });
const ranRecords = [];
const changed = new Map();
const viaEngine = await runRow({
  row: { id: 8, created_at: new Date(), run_force: [] }, table: { id: "t-r3", client_tag: "RLTEST_A" }, cells: new Map(), env: KEYS, db, settings,
  columns: [{ key: "zz_line", name: "Made-up line", kind: "action", action: "ai_web", phase: 1, position: 1, inputs: { prompt: '"Write another made-up line."' }, config: aiConfig }],
  hooks: { changed: (k, c) => changed.set(k, c), ran: (x) => ranRecords.push(x) },
});
check("through the engine: one call, one run record (done, with its wait), the cell done, the row not retried",
  viaEngine.calls === 1 && ranRecords.length === 1 && ranRecords[0].status === "done" && ranRecords[0].http_status === 200 && same(ranRecords[0].response?.rate_limited, { retries: 1, waited_ms: 2000 }) &&
    changed.get("zz_line")?.status === "done" && !viaEngine.retryable && !viaEngine.errors && sentTo(OPENAI).length === 2,
  JSON.stringify({ calls: viaEngine.calls, runs: ranRecords.length, retryable: viaEngine.retryable, cell: changed.get("zz_line")?.status }));
check("... an answer that carries no rate-limit headers leaves the latest as they were", openAiRateLimits()["gpt-test"]?.remaining_tokens === 28100, JSON.stringify(openAiRateLimits()));

fresh();
db = fakeDb();
plan(OPENAI, { status: 429, body: { error: { code: "insufficient_quota", type: "insufficient_quota", message: "You exceeded your current quota (made up)." } } }, { status: 200, body: answerOf("never") });
const quota = await aiRun(db);
check("insufficient_quota is never sent again: one send, no wait, the billing note, not retried",
  sentTo(OPENAI).length === 1 && slept.length === 0 && quota.status === "error" && quota.retryable === false &&
    quota.note === "OpenAI refused for billing (insufficient_quota), so it is not sent again" && db.openaiSpend.length === 0, JSON.stringify({ note: quota.note, sent: sent.length }));

fresh();
db = fakeDb();
plan(OPENAI, { status: 429, body: { error: { code: "made_up_code", type: "made_up", message: "Your monthly quota is used up (made up)." } } }, { status: 200, body: answerOf("never") });
const words = await aiRun(db);
check("a 429 with no known code that speaks of a quota is not waited out either: one send, answered as before (the row's retry)",
  sentTo(OPENAI).length === 1 && slept.length === 0 && words.status === "error" && words.retryable === true && /^OpenAI: HTTP 429/.test(words.note ?? ""), JSON.stringify({ note: words.note }));
check("the rule itself: rate_limit_exceeded is a rate limit even when its message names billing; billing codes and quota words never",
  openAiRateLimited({ status: 429, json: { error: { code: "rate_limit_exceeded", message: "Add a payment method at https://platform.openai.com/account/billing (made up)." } } }) &&
    openAiRateLimited({ status: 429, json: null }) && openAiRateLimited({ status: 429, json: { error: { type: "requests", message: "made up" } } }) &&
    !openAiRateLimited({ status: 429, json: { error: { code: "insufficient_quota" } } }) && !openAiRateLimited({ status: 429, json: { error: { type: "insufficient_quota" } } }) &&
    !openAiRateLimited({ status: 429, json: { error: { code: "made_up_spend_limit_exceeded" } } }) && !openAiRateLimited({ status: 429, json: { error: { message: "billing hard limit (made up)" } } }) &&
    !openAiRateLimited({ status: 500, json: null }));

fresh();
db = fakeDb();
plan(OPENAI, ...Array(5).fill({ status: 429, body: tpmLimit("1s") }));
const capped4 = await aiRun(db);
check("a rate limit past the caps: 4 sends, then the row's retry as before (retryable), nothing billed",
  sentTo(OPENAI).length === 4 && same(slept, [1000, 1000, 1000]) && capped4.status === "error" && capped4.retryable === true && /^OpenAI: HTTP 429/.test(capped4.note ?? "") &&
    db.openaiSpend.length === 0, JSON.stringify({ sent: sent.length, slept, note: capped4.note }));
check("... its run record keeps OpenAI's answer and the waits", capped4.run?.http_status === 429 && capped4.run.response?.error?.code === "rate_limit_exceeded" &&
  same(capped4.run.response.rate_limited, { retries: 3, waited_ms: 3000 }), JSON.stringify(capped4.run?.response).slice(0, 300));

fresh();
db = fakeDb({ lost: 2 });
plan(OPENAI, { status: 200, body: answerOf("never") });
const guarded = await aiRun(db);
check("the lost-send guard as it was: sent twice with no answer, nothing is sent", sent.length === 0 && guarded.status === "error" && /Sent 2 times with no answer/.test(guarded.note ?? ""), guarded.note);

fresh();
db = fakeDb({ lost: 1 });
plan(OPENAI, 0, { status: 200, body: answerOf("never") });
const lostAi = await aiRun(db);
check("a send with no answer: once, no wait, tried again by the row (its record has no HTTP status, so the guard counts it)",
  sent.length === 1 && slept.length === 0 && lostAi.status === "error" && lostAi.retryable === true && lostAi.run?.http_status === null && db.openaiSpend.length === 0,
  JSON.stringify({ sent: sent.length, run: lostAi.run }));

// ── R4 ──────────────────────────────────────────────────────────────────────
section("R4. The email finders and Enrichley");
const FINDYMAIL = "app.findymail.com";
const PROSPEO = "api.prospeo.io";
const ENRICHLEY = "api.enrichley.io";
const ANYMAIL = "api.anymailfinder.com";
const ctx = (db, inputs, extra = {}) => ({ inputs, config: {}, env: KEYS, db, settings, row: { id: 9, run_force: [] }, column: { key: "find_work_email_findymail" }, ...extra });
const person = { full_name: "Pat Example", company_domain: "example-dental.example" };

fresh();
db = fakeDb();
plan(FINDYMAIL, { status: 429, body: { message: "Too many requests" }, headers: { "retry-after": "3" } }, { status: 200, body: { contact: { name: "Pat Example", domain: "example-dental.example", email: "pat@example-dental.example" } } });
const f1 = await findymailByName(ctx(db, person));
check("Findymail: a 429, then the address: found, sent twice, one of the day's calls taken",
  f1.status === "done" && f1.value?.email === "pat@example-dental.example" && sentTo(FINDYMAIL).length === 2 && same(db.vendorCalls, ["findymail_calls"]) && same(slept, [3000]),
  JSON.stringify({ status: f1.status, note: f1.note, calls: db.vendorCalls, slept }));
check("... its run record keeps the answer and the wait, never the key",
  f1.run?.response?.contact?.email === "pat@example-dental.example" && same(f1.run.response.rate_limited, { retries: 1, waited_ms: 3000 }) && f1.run.http_status === 200 &&
    !JSON.stringify(f1).includes(KEYS.FINDYMAIL_API_KEY));

fresh();
db = fakeDb();
plan(FINDYMAIL, { status: 402, body: { message: "No credits left" } }, { status: 200, body: {} });
const f402 = await findymailByName(ctx(db, person));
check("Findymail out of credits (402): one send, not retried", sentTo(FINDYMAIL).length === 1 && slept.length === 0 && f402.retryable === false && /out of credits/.test(f402.note ?? ""));

fresh();
db = fakeDb();
plan(PROSPEO, { status: 429, body: { error: true, error_code: "INSUFFICIENT_CREDITS" } }, { status: 200, body: {} });
const p1 = await prospeoByName(ctx(db, person));
check("Prospeo's INSUFFICIENT_CREDITS on a 429 is never sent again: one send, no wait, out of credits",
  sentTo(PROSPEO).length === 1 && slept.length === 0 && p1.status === "error" && p1.retryable === false && p1.note === "Prospeo: the account is out of credits", JSON.stringify({ note: p1.note }));

fresh();
db = fakeDb();
plan(PROSPEO, { status: 429, body: { error: true, error_code: "RATE_LIMITED" } }, { status: 200, body: { error: false, person: { full_name: "Pat Example", email: { status: "VERIFIED", revealed: true, email: "pat@example-dental.example" } } } });
const p2 = await prospeoByName(ctx(db, person));
check("Prospeo's RATE_LIMITED: waited out (2 s with no hint) and found", p2.status === "done" && p2.value?.email === "pat@example-dental.example" && sentTo(PROSPEO).length === 2 && same(slept, [2000]));

fresh();
db = fakeDb();
plan(ENRICHLEY, { status: 429, body: { error: "Insufficient credits remaining (made up)" } }, { status: 200, body: { email: "pat@example-dental.example", valid: true, result: "ok" } });
const e1 = await enrichleyVerify(ctx(db, { email: "pat@example-dental.example" }));
check("Enrichley: a 429 that reads as out of credits is not waited out; answered as before",
  sentTo(ENRICHLEY).length === 1 && slept.length === 0 && e1.status === "error" && e1.note === "Enrichley: rate limited (HTTP 429), tried again later" && e1.retryable === true, JSON.stringify({ note: e1.note }));

fresh();
db = fakeDb();
plan(ENRICHLEY, ...Array(5).fill({ status: 429, body: { error: "Too many requests" } }));
const e2 = await enrichleyVerify(ctx(db, { email: "pat@example-dental.example" }));
check("Enrichley past the caps: 4 sends on one of the day's calls, then the row's retry as before",
  sentTo(ENRICHLEY).length === 4 && same(db.vendorCalls, ["enrichley_calls"]) && same(slept, [2000, 4000, 8000]) && e2.retryable === true && e2.note === "Enrichley: rate limited (HTTP 429), tried again later",
  JSON.stringify({ sent: sent.length, calls: db.vendorCalls, slept, note: e2.note }));

fresh();
db = fakeDb();
plan(ANYMAIL, { status: 429, body: { error: "rate_limited" }, headers: { "x-ratelimit-reset": "5" } }, { status: 200, body: { success: true, results: { email: "pat@example-dental.example", validation: "valid" } } });
const am = await anymailFinder(ctx(db, { url: `https://${ANYMAIL}/v5.1/find-email/person`, method: "POST", body: { full_name: "Pat Example", domain: "example-dental.example" } }));
check("Anymail Finder: the x-ratelimit-reset wait, then found", am.status === "done" && sentTo(ANYMAIL).length === 2 && same(slept, [5000]) && same(db.vendorCalls, ["anymail_finder_calls"]));

check("the vendors' rule: a plain 429 is a rate limit; credits, quota, billing or payment words never",
  vendorRateLimited({ status: 429, json: { message: "Too many requests" }, error: "HTTP 429: ..." }) && vendorRateLimited({ status: 429, json: null, error: null }) &&
    !vendorRateLimited({ status: 429, json: { error_code: "INSUFFICIENT_CREDITS" }, error: null }) && !vendorRateLimited({ status: 429, json: null, error: "HTTP 429: monthly quota reached" }) &&
    !vendorRateLimited({ status: 429, json: { message: "Payment required" }, error: null }) && !vendorRateLimited({ status: 402, json: null, error: null }));

fresh();
db = fakeDb({ lost: 2 });
plan(FINDYMAIL, { status: 200, body: { contact: { email: "pat@example-dental.example" } } });
const fg = await ACTIONS.findymail_find_work_email.run(ctx(db, person));
check("the keyed step's lost-send guard as it was: sent twice with no answer, nothing is sent and no call is taken",
  sent.length === 0 && db.vendorCalls.length === 0 && fg.status === "error" && /Sent 2 times with no answer/.test(fg.note ?? ""), JSON.stringify(fg));

fresh();
db = fakeDb();
plan(FINDYMAIL, 0, { status: 200, body: {} });
const fl = await findymailByName(ctx(db, person));
check("a finder's send with no answer: once, no wait, tried again by the row, no HTTP status kept",
  sent.length === 1 && slept.length === 0 && fl.retryable === true && fl.run?.http_status === null && /no answer/.test(fl.note ?? ""), JSON.stringify(fl));

// ── R5 ──────────────────────────────────────────────────────────────────────
section("R5. The worker");
const ws = readFileSync(new URL("./enrich-worker.mjs", import.meta.url), "utf8");
const mainSrc = ws.slice(ws.indexOf("async function main()"));
check("the housekeeping pool: its own, 3 connections, the same timeouts as the others",
  /const housekeepingPool = new pg\.Pool\(\{[^}]*max: 3,[^}]*connectionTimeoutMillis: 30_000,[^}]*query_timeout: 70_000,/.test(ws) &&
    /housekeepingPool\.on\("error"/.test(ws));
check("the 60-second block, unchanged in order, runs in the background function with its busy flag, the loop never awaiting it",
  /async function housekeeping\(\) \{\s*housekeepingBusy = true;\s*try \{\s*if \(Date\.now\(\) - lastSweep > 60_000\) \{\s*await reclaimStale\(\);\s*await releaseHeld\(\);\s*await moveUploads\(\);\s*await copyPulls\(\);\s*await releaseHeldPeople\(\);\s*await handBackPulls\(\);\s*lastSweep = Date\.now\(\);/.test(ws) &&
    mainSrc.includes("if (!housekeepingBusy) housekeepingInFlight = housekeeping();") && !/await (reclaimStale|releaseHeld|moveUploads|copyPulls|releaseHeldPeople|handBackPulls)\(\)/.test(mainSrc));
check("... and so does the heartbeat, 10 s apart, a failure logged and never thrown",
  /async function beat\(\) \{\s*beatBusy = true;\s*try \{\s*if \(Date\.now\(\) - lastBeat > 10_000\) \{\s*try \{\s*await heartbeat\(\);\s*\} catch \(e\) \{\s*log\(`heartbeat: /.test(ws) &&
    mainSrc.includes("if (!beatBusy) beatInFlight = beat();") && !/await heartbeat\(\);/.test(mainSrc));
check("the block's steps and the heartbeat use the housekeeping pool, never a row slot's",
  ["releaseHeldRows(housekeepingPool)", "moveUploadRows(housekeepingPool, { settings, log })", "copyPullNoEmail(housekeepingPool, { settings, log })",
    "releaseHeldPeopleRows(housekeepingPool)", "handBackFound(housekeepingPool, { log })", "originalsSummary(housekeepingPool), spentToday(housekeepingPool)"].every((s) => ws.includes(s)) &&
    /async function reclaimStale\(\) \{\s*try \{\s*const \{ rowCount \} = await housekeepingPool\.query\(/.test(ws) && /await housekeepingPool\.query\(\s*`INSERT INTO enrich_worker_state/.test(ws));
check("a finished row's slot is claimed for at once: no fixed sleep while slots are free, POLL_MS only when nothing was claimable",
  mainSrc.includes("safeProcess(r).finally(rowFinished);") && mainSrc.includes("if (claimed.length && inFlight < CONCURRENCY) continue;") &&
    mainSrc.includes("const seen = wakes;") && mainSrc.includes("await untilWoken(seen, POLL_MS);") && !/sleep\(claimed\.length/.test(ws) &&
    /function wake\(\) \{\s*wakes\+\+;\s*wakeLoop\?\.\(\);\s*\}/.test(ws) && /function rowFinished\(\) \{\s*inFlight--;\s*wake\(\);\s*\}/.test(ws) &&
    /if \(wakes !== seen\) return Promise\.resolve\(\);/.test(ws));
check("... and a question job with more to do still takes its next step a quarter second after the last while rows are in flight",
  /\} finally \{\s*questionBusy = false;\s*(\/\/[^\n]*\n\s*)*if \(!questionState\.idle && inFlight > 0\) setTimeout\(wake, 250\)\.unref\(\);\s*\}/.test(ws));
check("a draining worker (ENRICH_ONCE) exits only after a claim that followed the last block",
  /if \(ONCE && !claimed\.length && inFlight === 0 && !housekeepingBusy && housekept === blocksBefore &&/.test(mainSrc) && /const blocksBefore = housekept;\s*const free = CONCURRENCY - inFlight;/.test(mainSrc));
check("a stopping worker waits for the block and the heartbeat in flight, writes the stopping heartbeat last, then closes their pool, then the main pool",
  /await housekeepingInFlight;\s*await beatInFlight;\s*await heartbeat\(\{ stopping: true \}\)\.catch\(\(\) => \{\}\);\s*await housekeepingPool\.end\(\)\.catch\(\(\) => \{\}\);[\s\S]*await pool\.end\(\)/.test(mainSrc));
check("promotion: at most one round per client every 2 minutes, timed from the check that asked",
  /const PROMOTE_EVERY_MS = 2 \* 60_000;/.test(ws) && /const checkedAt = Date\.now\(\);/.test(ws) &&
    /if \(checkedAt - \(promotedAt\.get\(tag\) \?\? 0\) < PROMOTE_EVERY_MS\) continue;\s*promotedAt\.set\(tag, checkedAt\);/.test(ws) && /const PROMOTE_CHECK_MS = 60_000;/.test(ws));
check("waiting rows are swept every 5 minutes", /const SWEEP_WAITING_MS = 5 \* 60_000;/.test(ws));
check("the heartbeat carries OpenAI's latest rate-limit headers and the waits",
  ws.includes("openai_rate_limits: openAiRateLimits(),") && ws.includes("rate_limit_waits: rateLimitWaits(),"));

console.log(`\n${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
process.exit(count.failed ? 1 : 0);
