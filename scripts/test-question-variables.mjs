#!/usr/bin/env node
// Checks for question variables (migration 139): the prompt placeholders and
// their rendering, the question writer's rules, the gather (the same leads the
// export popup's push would send, proven against the push-worker's own
// gatherCycle, and pinned to its text), the routes under /api/questions, the
// Bison routes, question jobs end to end through the enrich-worker's step, the
// settings sheet's question_variables, and the worker's wiring.
//
// LOCAL DATABASE ONLY: it makes made-up clients (XQ3A-OS, XQ3B, XQ3C), made-up
// leads on .xq3.xxtest.example addresses, made-up variables (named xq3...) and
// jobs, and removes all of it at the end. The settings it changes and today's
// question spend are put back.
//
//   node --env-file=.env.local scripts/test-question-variables.mjs
//
// Stop the enrichment worker first: it refuses to run while a worker's
// heartbeat is fresh. Migration 139 must be in the local database. Nothing here
// reaches a network: fetch is replaced (OpenAI and made-up Bison installs
// answer from stubs, every other address is refused and counted), no paid key
// is read, and the OpenAI key the writer is given is a made-up string. The
// routes run for real through the TypeScript loader
// (scripts/fixtures/test-support.mjs), with stand-ins only for the session, the
// audit log and the worker's heartbeat.
//
//   A. placeholders: rendering, names any case and spacing, errors; the service area
//   B. the writer's rules: words, long dashes, braces, lower case, the correction, failures
//   C. the gather is the push's: gather.mjs and the push-worker's gatherCycle (cut
//      from its source) on the same selections; the pinned lines
//   D. the routes: roles, shapes, 400s and 409s
//   E. Bison: pages, made only where missing, tokens kept to their install, the copy check
//   F. jobs end to end: gather, research once per company, People and General
//      prompts, the word limit then a retry then an error, dashes and braces
//      cleaned, lower case, spend, the budget and switch pauses, retries, a key
//      refusal, claim and stale reclaim, the job snapshot's cap and rewrite
//   G. the settings sheet's question_variables
//   H. the worker: its capability and the step's wiring

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checker, dropPaidKeys, localDatabaseUrl, routeLoader } from "./fixtures/test-support.mjs";
import { isSharePush } from "./lib/overlap-topup.mjs";
import { openAiCost } from "./lib/enrich/spend.mjs";
import { readSettings, resetSettingsCache } from "./lib/enrich/settings.mjs";
import { questionSettingsFrom } from "./lib/questions/settings.mjs";
import { contextFor, placeholderErrors, QUESTION_PLACEHOLDERS, RESEARCH_PLACEHOLDERS, renderQuestionPrompt } from "./lib/questions/render.mjs";
import { loadServiceArea, serviceAreaOf } from "./lib/questions/service-area.mjs";
import { QUESTION_JOBS_CAPABILITY } from "./lib/questions/capability.mjs";
import * as G from "./lib/questions/gather.mjs";
import * as W from "./lib/questions/writer.mjs";
import * as J from "./lib/questions/jobs.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const count = checker();
const { check, section } = count;
const t0 = Date.now();

const A = "XQ3A-OS";
const B = "XQ3B";
const C = "XQ3C";
const TAGS = [A, B, C];
const HOST = "xq3.xxtest.example";
const NAMED = `named.${HOST}`;
const BULK = `bulk.${HOST}`;
const B2B = `b2b.${HOST}`;
const B2C = `b2c.${HOST}`;
const NOKEY = `nokey.${HOST}`;
const EVIL = `elsewhere.${HOST}`;
const KEY = "xq3-made-up-openai-key";
const TOKENS = { [B2B]: "xq3-made-up-token-b2b", [B2C]: "xq3-made-up-token-b2c" };
const EM = String.fromCharCode(0x2014); // a long dash, made at run time so this file holds none
const BULK_N = 5020;
process.env.EMAILBISON_KEYS = JSON.stringify(TOKENS);
delete process.env.EMAILBISON_API_KEY;
delete process.env.EMAILBISON_BASE_URL;

const RESEARCH = "Research {{Company}} ({{Company Website}}) for {{Services}} in {{Service Area}}. [xq3-research]";
const PEOPLE = "[xq3-people] Write a question for {{First Name}}, {{Title}} at {{Company}}. {{research.company_summary}} {{Client Context}}";
const GENERAL = "[xq3-general] Write a question for the team at {{Company}}. {{ Research . Best_Fit }}";

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const sorted = (a) => [...a].map(String).sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const keysAre = (o, keys) => o && JSON.stringify(Object.keys(o).sort()) === JSON.stringify([...keys].sort());

// ── The network ─────────────────────────────────────────────────────────────

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const words = (n, first) => [first, ...Array.from({ length: n - 1 }, (_, i) => `word${i + 1}`)].join(" ") + "?";
/** What the question stub answers each person, call by call (the last answer repeats). */
const PLAN = {
  Avery: ["Would a made-up pilot help your team this spring?"],
  Blake: ["Could your office use a made-up weekly check?"],
  Casey: [words(25, "Casey"), "Could Casey use a shorter made-up question?"],
  Drew: [`Is your team ready ${EM} or still planning?`],
  Emery: [words(30, "Emery")],
  Finley: ["Does the made-up group plan a refresh?"],
  Harper: ["{Harper} is the made-up plan ready?"],
  Old: ["Is the made-up season busy for you?"],
};
const net = {
  openai: 0,
  bodies: [], // every OpenAI request body
  auth: new Set(), // the Authorization headers OpenAI got
  researched: [], // the company of each research call
  asked: new Map(), // person -> question calls
  fail: [], // statuses OpenAI answers before its normal answers
  bison: [], // { host, method, path, auth }
  refused: 0,
};
const bison = {
  vars: {
    [B2B]: [...Array.from({ length: 15 }, (_, i) => `made-up variable ${i + 1}`), "question", "city", "state"],
    [B2C]: ["question", "city", "XQ3A-OS QUESTION"],
  },
  linksOnly: new Set([B2C]), // B2C pages with links.next and no meta
  steps: {
    101: [{ email_subject: "Hello {FIRST_NAME}", email_body: "Hi there, {xq3a-os question} Thanks" }],
    102: [{ email_subject: "{QUESTION}", email_body: "A made-up body" }],
    103: [{ email_subject: "Hi", email_body: "{UNIQUE SERVICE QUESTION} and more" }],
  },
  fail: {}, // host -> status to answer once
};
const BISON_HOSTS = new Set([B2B, B2C, NOKEY, EVIL]);

globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let body = null;
  try {
    body = init.body ? JSON.parse(init.body) : null;
  } catch {
    body = null;
  }
  if (u.hostname === "api.openai.com") {
    net.openai++;
    net.bodies.push(body);
    net.auth.add(headers.authorization);
    const failing = net.fail.shift();
    if (failing) return json(failing, { error: { message: "made-up failure", code: failing === 429 ? "insufficient_quota" : null } });
    const name = body?.text?.format?.name;
    let answer;
    if (name === "research") {
      const company = /Research (.*?) \(/.exec(body.input)?.[1] ?? "";
      net.researched.push(company);
      answer = { company_summary: `A made-up summary of ${company}`, service_spaces: "Made-up offices", best_fit: "Made-up fit" };
    } else {
      const general = String(body?.input).includes("[xq3-general]");
      const who = general ? "general" : /Write a question for ([^,]*),/.exec(body.input)?.[1] ?? "";
      const n = net.asked.get(who) ?? 0;
      net.asked.set(who, n + 1);
      const plan = PLAN[who] ?? ["What does the made-up team need next?"];
      answer = { question: plan[Math.min(n, plan.length - 1)] };
    }
    const searches = body?.tools?.length ? [{ type: "web_search_call", action: { type: "search" } }] : [];
    return json(200, {
      output: [...searches, { type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }],
      usage: { input_tokens: 1000, output_tokens: 50 },
    });
  }
  if (BISON_HOSTS.has(u.hostname)) {
    const host = u.hostname;
    net.bison.push({ host, method, path: `${u.pathname}${u.search}`, auth: headers.authorization ?? null });
    if (bison.fail[host]) {
      const s = bison.fail[host];
      delete bison.fail[host];
      return json(s, { message: "made-up failure" });
    }
    if (u.pathname === "/api/custom-variables" && method === "GET") {
      const page = Number(u.searchParams.get("page") ?? 1);
      const names = bison.vars[host] ?? [];
      const last = Math.max(1, Math.ceil(names.length / 15));
      const data = names.slice((page - 1) * 15, page * 15).map((name, i) => ({ id: (page - 1) * 15 + i + 1, name }));
      const next = page < last ? `https://${host}/api/custom-variables?page=${page + 1}` : null;
      return json(200, { data, links: { next }, meta: bison.linksOnly.has(host) ? {} : { current_page: page, last_page: last } });
    }
    if (u.pathname === "/api/custom-variables" && method === "POST") {
      (bison.vars[host] ??= []).push(body?.name);
      return json(201, { data: { id: 900, name: body?.name } });
    }
    const m = /^\/api\/campaigns\/v1\.1\/(\d+)\/sequence-steps$/.exec(u.pathname);
    if (m && method === "GET") {
      const steps = bison.steps[m[1]];
      return steps ? json(200, { data: { sequence_steps: steps } }) : json(404, { message: "Not found" });
    }
    return json(404, { message: "Not found" });
  }
  net.refused++;
  throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
};

// ── The routes ──────────────────────────────────────────────────────────────

const loader = routeLoader(randomUUID());
const { T, route, srcModule, call, heartbeat } = loader;
let R = null;
const WITH_QUESTIONS = ["company_runs", "pipeline_v2", QUESTION_JOBS_CAPABILITY];

// ── Setup and cleanup ───────────────────────────────────────────────────────

let settingsBefore = null; // every enrich_settings row, as it was
let spendBefore = null; // today's openai_usd_questions, as it was
const SPEND_TODAY = `day = (now() AT TIME ZONE 'utc')::date AND kind = 'openai_usd_questions'`;
const L = {}; // the made-up leads, by name

async function cleanup() {
  const vids = (await all(`SELECT id FROM question_variables WHERE name LIKE 'xq3%'`)).map((r) => r.id);
  await pool.query(`DELETE FROM question_jobs WHERE client_tag = ANY($1::text[]) OR variable_id = ANY($2::uuid[])`, [TAGS, vids]);
  await pool.query(`DELETE FROM client_question_settings WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM question_variable_log WHERE variable_id = ANY($1::uuid[]) OR after ->> 'name' LIKE 'xq3%'`, [vids]);
  await pool.query(`DELETE FROM question_variables WHERE id = ANY($1::uuid[])`, [vids]);
  await pool.query(`DELETE FROM push_batches WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM client_variables WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_variables_log WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[])`, [TAGS]);
  if (settingsBefore) {
    const now = await all(`SELECT key, value FROM enrich_settings`);
    for (const r of now) {
      const was = settingsBefore.find((x) => x.key === r.key);
      if (!was) await pool.query(`DELETE FROM enrich_settings WHERE key = $1`, [r.key]);
      else if (JSON.stringify(was.value) !== JSON.stringify(r.value)) {
        await pool.query(`UPDATE enrich_settings SET value = $2 WHERE key = $1`, [r.key, JSON.stringify(was.value)]);
      }
    }
  }
  if (spendBefore !== null) {
    if (spendBefore.used === null) await pool.query(`DELETE FROM enrich_spend_daily WHERE ${SPEND_TODAY}`);
    else await pool.query(`UPDATE enrich_spend_daily SET used = $1::numeric WHERE ${SPEND_TODAY}`, [spendBefore.used]);
  }
  resetSettingsCache();
}

async function setQs(v) {
  await pool.query(
    `INSERT INTO enrich_settings (key, value) VALUES ('question_variables', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ ...questionSettingsFrom(null), ...v })]
  );
}

async function lead(name, o) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO leads (email, first_name, last_name, title, company, domain, city, state, email_type, validation_status,
                        is_bounced, country_code, created_at)
     VALUES ($1, $2, 'Madeup', $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12::timestamptz, now()))
     RETURNING id`,
    [o.email, o.first ?? null, o.title ?? null, o.company ?? null, o.domain ?? null, o.city ?? null, o.state ?? null,
      o.type ?? "personal", o.validation ?? null, o.bounced === true, o.country ?? null, o.createdAt ?? null]
  );
  L[name] = r.id;
}

async function setup() {
  await pool.query(
    `INSERT INTO client_tags (tag, name, status, client_type, b2b_instance, b2c_instance)
     VALUES ($1, 'Question test A', 'Active', 'Cleaning', $4, $5),
            ($2, 'Question test B', 'Active', NULL, NULL, NULL),
            ($3, 'Question test C', 'Active', 'OS', $6, NULL)`,
    [A, B, C, B2B, B2C, NOKEY]
  );
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, sheet_raw, updated_at)
     VALUES ($1, '{US}', '[]', '[]', '{}', false, $2::jsonb, now()),
            ($3, '{US}', $4::jsonb, '[]', '{}', false, NULL, now())`,
    [A, JSON.stringify({ target: "A made-up target answer", locations: "  Made-up County and nearby  " }), B,
      JSON.stringify([
        { country: "US", state: "IL", city: "Springfield" },
        { country: "US", state: "IL", city: "Peoria" },
        { country: "US", state: "MO" },
      ])]
  );
  const alpha = { company: "Alphatest Facilities", domain: `alpha.${NAMED}`, city: "Springfield", state: "IL" };
  const beta = { company: "Betatest Offices", domain: `beta.${NAMED}`, city: "Peoria", state: "IL" };
  await lead("avery", { ...alpha, email: `avery@alpha.${NAMED}`, first: "Avery", title: "Owner" });
  await lead("blake", { ...alpha, email: `blake@alpha.${NAMED}`, first: "Blake", title: "Office Manager" });
  await lead("info", { ...alpha, email: `info@alpha.${NAMED}`, first: "Info", type: "general" });
  await lead("old", { ...alpha, email: `old@alpha.${NAMED}`, first: "Old", title: "Director", createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
  await lead("casey", { ...beta, email: `casey@beta.${NAMED}`, first: "Casey", title: "Owner" });
  await lead("drew", { ...beta, email: `drew@beta.${NAMED}`, first: "Drew", title: "Owner" });
  await lead("emery", { ...beta, email: `emery@beta.${NAMED}`, first: "Emery", title: "Owner" });
  await lead("finley", { email: `finley@gamma.${NAMED}`, first: "Finley", title: "Owner", company: "Gammatest Group", city: "Springfield", state: "IL" });
  await lead("harper", { email: `harper@delta.${NAMED}`, first: "Harper", title: "Owner", company: "Deltatest Ltd", domain: `delta.${NAMED}` });
  await lead("gray", { email: `gray@nowhere.${NAMED}`, first: "Gray", title: "Owner" });
  await lead("bounced", { ...alpha, email: `bounced@alpha.${NAMED}`, first: "Bounced", bounced: true });
  await lead("invalid", { ...alpha, email: `invalid@alpha.${NAMED}`, first: "Invalid", validation: "invalid" });
  await lead("canada", { ...beta, email: `canada@beta.${NAMED}`, first: "Canada", country: "CA" });
  await pool.query(
    `INSERT INTO leads (email, first_name, email_type)
     SELECT 'b' || lpad(n::text, 5, '0') || '@' || $1, 'Bulk', 'personal' FROM generate_series(1, $2::int) n`,
    [BULK, BULK_N]
  );
}

const SEL_NAMED = { filters: { emailSuffix: { include: [`.${NAMED}`], exclude: [] } }, clientTag: A, pushOptions: { includeAlreadyPushed: false } };

// ── A. Placeholders ─────────────────────────────────────────────────────────

function partA() {
  section("A. Placeholders: rendering, names any case and spacing, errors; the service area");
  check("the research prompt reads company-level names only; the question prompts add the person and the research answer",
    !RESEARCH_PLACEHOLDERS.includes("Title") && !RESEARCH_PLACEHOLDERS.includes("First Name") &&
      ["Title", "First Name", "research.company_summary", "research.service_spaces", "research.best_fit"].every((n) => QUESTION_PLACEHOLDERS.includes(n)) &&
      RESEARCH_PLACEHOLDERS.every((n) => QUESTION_PLACEHOLDERS.includes(n)));
  const lead = { company: "Acmetest", domain: "", email: "Pat@Acme.XQ3.xxtest.example", category: "Cleaning", subcategory: "Office", additional_category: "",
    title: "Owner", city: "Springfield", state: "IL", first_name: "Pat" };
  const ctx = contextFor(lead, { services: "Made-up services", client_context: "Made-up context" },
    { serviceArea: "Made-up area", research: { company_summary: "Sum", service_spaces: "Spaces", best_fit: "Fit" } });
  const out = renderQuestionPrompt(
    "{{Company}}|{{ company   website }}|{{CATEGORY}}|{{Sub-Category}}|{{Additional Category}}|{{Title}}|{{First Name}}|{{City}}|{{State}}|" +
      "{{Services}}|{{Client Context}}|{{Service Area}}|{{research.company_summary}}|{{ Research . Best_Fit }}|{{research.service_spaces}}", ctx);
  check("every placeholder renders, names any case and spacing; Company Website falls back to the email's domain; an empty value is \"\"",
    out === "Acmetest|acme.xq3.xxtest.example|Cleaning|Office||Owner|Pat|Springfield|IL|Made-up services|Made-up context|Made-up area|Sum|Fit|Spaces", out);
  check("the lead's own domain wins over the email's", contextFor({ ...lead, domain: "site.xq3.xxtest.example" }, {}).companyWebsite === "site.xq3.xxtest.example");
  check("an unknown name and a research field with no answer render as \"\"; single braces and text stay",
    renderQuestionPrompt("a {{Nope}} b {{research.nothing}} {single} c", ctx) === "a  b  {single} c" &&
      renderQuestionPrompt("{{research.best_fit}}", contextFor(lead, {}, {})) === "");
  const e1 = placeholderErrors("Hi {{Company}} {{Favourite Colour}} and {{favourite   colour}} {{Title}}", RESEARCH_PLACEHOLDERS);
  check("an unknown placeholder is named once, as typed; a person's name in the research prompt is refused",
    e1.length === 2 && e1[0].startsWith("Unknown placeholder {{Favourite Colour}}") && e1[1].startsWith("Unknown placeholder {{Title}}"), JSON.stringify(e1));
  check("... and allowed in a question prompt", placeholderErrors("{{Title}} {{research.best_fit}} {{ first   NAME }}", QUESTION_PLACEHOLDERS).length === 0);
  const e2 = placeholderErrors("{{Company} and {{ }} then }} and {{Company", QUESTION_PLACEHOLDERS);
  check("an empty pair, an unclosed {{ and a stray }} are each an error", e2.some((e) => /empty placeholder/.test(e)) &&
    e2.some((e) => /unclosed/.test(e)) && e2.some((e) => /stray/.test(e)), JSON.stringify(e2));
  check("plain text and single braces are no error", placeholderErrors("A {json} like {\"a\": 1} text", QUESTION_PLACEHOLDERS).length === 0);

  const sheet = { sheet_raw: { locations: `  ${"x".repeat(700)}  ` }, include_locations: [{ state: "IL", city: "Springfield" }] };
  check("service area: the client's own value first", serviceAreaOf(sheet, { value: " Own area " }) === "Own area");
  check("... else the sheet's places text, trimmed, at most 600 characters", serviceAreaOf(sheet, null) === "x".repeat(600));
  const places = Array.from({ length: 14 }, (_, i) => ({ country: "US", state: i % 2 ? "IL" : "mo", city: `City${i + 1}` }));
  const label = serviceAreaOf({ sheet_raw: null, include_locations: [...places, { country: "US", state: "TX" }] }, { value: "  " });
  check("... else the distinct states, then the first 12 cities as \"City, ST\"",
    label === `MO, IL, TX: ${places.slice(0, 12).map((p) => `${p.city}, ${p.state.toUpperCase()}`).join("; ")}`, label);
  check("... and \"\" with none of the three", serviceAreaOf(null, null) === "");
}

// ── B. The writer's rules ───────────────────────────────────────────────────

function partB() {
  section("B. The writer's rules: words, long dashes, braces, lower case, the correction, failures");
  check("words are runs between spaces", W.wordsOf("  one two\tthree\n four ") === 4 && W.wordsOf("") === 0);
  check("the rules an answer breaks",
    JSON.stringify(W.questionProblems("", 16)) === '["empty"]' &&
      JSON.stringify(W.questionProblems(words(17, "Too"), 16)) === '["long"]' &&
      JSON.stringify(W.questionProblems(`Ready ${EM} now? {x}`, 16)) === '["dash","brace"]' &&
      W.questionProblems("Is this fine?", 16).length === 0);
  const en = String.fromCharCode(0x2013);
  check("a long dash with spaces becomes a comma, one between two characters a space; braces go; no comma is left at the ends",
    W.cleanQuestion(`Is your team ready ${EM} or still planning?`) === "Is your team ready, or still planning?" &&
      W.cleanQuestion(`Open 2019${en}2020 {Name}?`) === "Open 2019 2020 Name?" &&
      W.cleanQuestion(`${EM} Ready? ${EM}`) === "Ready?",
    W.cleanQuestion(`${EM} Ready? ${EM}`));
  check("the first letter is lower case, as Clay's question column writes it", W.lowerFirst(" Would it help? ") === "would it help?" && W.lowerFirst("") === "");
  const fix = W.correctionFor(words(20, "Long"), ["long", "dash"], 16);
  check("the correction names each rule broken", /20 words; use at most 16/.test(fix) && /long dash/.test(fix) && !/[\u2012-\u2015]/.test(fix));
  check("a refused key, billing and a request OpenAI won't take stop the job; no answer, 429 and 5xx are tried again",
    W.failureOf({ status: 401 }).kind === "fatal" && W.failureOf({ status: 429, json: { error: { code: "insufficient_quota" } } }).kind === "fatal" &&
      W.failureOf({ status: 400, json: { error: { message: "Bad model" } } }).kind === "fatal" && W.failureOf({ status: 429, json: {} }).kind === "retry" &&
      W.failureOf({ status: 503, error: "HTTP 503" }).kind === "retry" && W.failureOf({ status: 0, error: "timed out" }).kind === "retry" &&
      !JSON.stringify(W.failureOf({ status: 401 })).includes(KEY));
  check("the research answer's schema: three strings, strict", JSON.stringify(W.RESEARCH_SCHEMA.required) === '["company_summary","service_spaces","best_fit"]' &&
    W.RESEARCH_SCHEMA.additionalProperties === false && JSON.stringify(W.QUESTION_SCHEMA.required) === '["question"]');
  check("the research model: the setting's, else the pipeline's research step; the question model likewise",
    W.researchModelOf({ research_model: "m-r" }, null).model === "m-r" &&
      W.researchModelOf({ research_model: null }, { models: { people_claygent: { model: "m-p", reasoning_effort: "low" } } }).effort === "low" &&
      W.questionModelOf({ question_model: null }, { models: { people_question_ai: { model: "m-q" } } }).model === "m-q" &&
      W.questionModelOf({ question_model: null }, { models: {} }) === null);
  check("a personal address gets the People prompt, anything else the General one",
    W.promptKindOf({ email_type: "personal" }) === "people" && W.promptKindOf({ email_type: "general" }) === "general" && W.promptKindOf({}) === "general");
}

// ── C. The gather is the push's ─────────────────────────────────────────────

const pw = readFileSync(new URL("./push-worker.mjs", import.meta.url), "utf8");
const pushRoute = readFileSync(new URL("../src/app/api/bison/push-batch/route.ts", import.meta.url), "utf8");
const squeeze = (s) => s.replace(/\s+/g, " ");
const piece = (src, name) => {
  const m = new RegExp(`const ${name} =\\s*((?:\`[^\`]*\`\\s*\\+?\\s*)+);`).exec(src);
  return m ? [...m[1].matchAll(/`([^`]*)`/g)].map((x) => x[1]).join("") : null;
};
/** The pins the push-worker no longer holds (whitespace aside). */
const missingPins = (src) => G.PUSH_GATHER_PINS.filter((p) => !squeeze(src).includes(squeeze(p)));

/** The push-worker's own gatherCycle, cut out of its source, run on one made-up batch inside the caller's transaction. */
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const gatherBody = /async function gatherCycle\(\) \{([\s\S]*?)\n\}/.exec(pw)?.[1] ?? null;
const stopBody = /function shareStopReason\(batch, block\) \{([\s\S]*?)\n\}/.exec(pw)?.[1] ?? null;
async function pushGather(c, sel) {
  const gatherCycle = new AsyncFunction("pool", "batchScope", "isSharePush", "failBatch", "ELIGIBLE", "NOT_SENT_FOR_CLIENT", "SHARE_CANCEL_SQL",
    "RECEIVE_BLOCK_SQL", "shareStopReason", "GATHER_CHUNK", "console", gatherBody);
  const { rows: [b] } = await c.query(
    `INSERT INTO push_batches (campaigns, filters, selected_ids, range_from, range_to, max_leads, client_tag, email_side, push_options, status)
     VALUES ('[]'::jsonb, $1::jsonb, $2::uuid[], $3, $4, $5, $6, $7, $8::jsonb, 'pending') RETURNING id`,
    [sel.filters ? JSON.stringify(sel.filters) : null, sel.selected_ids, sel.range_from, sel.range_to, sel.max_leads, sel.client_tag, sel.email_side,
      sel.push_options ? JSON.stringify(sel.push_options) : null]
  );
  const failed = [];
  const quiet = { log() {}, warn() {}, error() {} };
  await gatherCycle(c, (alias) => `and ${alias}.id = '${b.id}'`, isSharePush, async (_id, msg) => failed.push(msg), piece(pw, "ELIGIBLE"),
    piece(pw, "NOT_SENT_FOR_CLIENT"), piece(pw, "SHARE_CANCEL_SQL"), piece(pw, "RECEIVE_BLOCK_SQL"), new Function("batch", "block", stopBody),
    Number(/const GATHER_CHUNK = (\d+);/.exec(pw)?.[1]), quiet);
  const { rows } = await c.query(`SELECT lead_id FROM push_items WHERE batch_id = $1`, [b.id]);
  return { ids: rows.map((r) => r.lead_id), failed };
}

async function partC() {
  section("C. The gather is the push's: gather.mjs against the push-worker's own gatherCycle, and the pinned lines");
  check("the push-worker's gatherCycle and its statements are where this test reads them",
    Boolean(gatherBody && stopBody && piece(pw, "ELIGIBLE") && piece(pw, "NOT_SENT_FOR_CLIENT")));
  check("drift: every line gather.mjs mirrors is still in the push-worker (whitespace aside)", missingPins(pw).length === 0, JSON.stringify(missingPins(pw)));
  check("... the eligibility gate is the push-worker's, word for word", piece(pw, "ELIGIBLE") === G.ELIGIBLE);
  check("... and so is the page size", Number(/const GATHER_CHUNK = (\d+);/.exec(pw)?.[1]) === G.GATHER_CHUNK);
  const drifted = pw.replace("and pi.status = 'sent' and pi.batch_id <> '${batch.id}'", "and pi.status = 'done' and pi.batch_id <> '${batch.id}'")
    .replace("const GATHER_CHUNK = 5000;", "const GATHER_CHUNK = 2000;");
  check("... and a changed line fails the check", missingPins(drifted).length === 2);
  const routeMissing = G.PUSH_ROUTE_PINS.filter((p) => !squeeze(pushRoute).includes(squeeze(p)));
  check("drift: the push-batch route still turns the popup's body into a batch the way selection.ts copies", routeMissing.length === 0, JSON.stringify(routeMissing));

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // A finished push of A a day ago: Avery sent, Blake failed.
    const { rows: [prior] } = await c.query(
      `INSERT INTO push_batches (campaigns, client_tag, status, created_at) VALUES ('[]'::jsonb, $1, 'complete', now() - interval '1 day') RETURNING id`, [A]);
    await c.query(`INSERT INTO push_items (batch_id, lead_id, email, status) VALUES ($1, $2, 'a@x', 'sent'), ($1, $3, 'b@x', 'failed')`, [prior.id, L.avery, L.blake]);
    const cases = [
      ["filters, already-pushed left out (the popup's default)", SEL_NAMED, (ids) => !ids.includes(L.avery) && ids.includes(L.blake) && ids.length === 9],
      ["filters, already-pushed sent too", { ...SEL_NAMED, pushOptions: { includeAlreadyPushed: true } }, (ids) => ids.length === 10 && ids.includes(L.avery)],
      ["filters, retryFailed", { ...SEL_NAMED, pushOptions: { retryFailed: true } }, (ids) => same(ids, [L.blake])],
      ["filters, onlyNewSinceLast", { ...SEL_NAMED, pushOptions: { includeAlreadyPushed: true, onlyNewSinceLast: true } }, (ids) => ids.length === 9 && !ids.includes(L.old)],
      ["filters, a range", { ...SEL_NAMED, rangeFrom: 2, rangeTo: 4 }, (ids) => ids.length === 3],
      ["filters, maxLeads over two pages", { filters: { emailSuffix: { include: [`@${BULK}`] } }, clientTag: A, maxLeads: 5010 }, (ids) => ids.length === 5010],
      ["filters, every page of the bulk", { filters: { emailSuffix: { include: [`@${BULK}`] } }, clientTag: A }, (ids) => ids.length === BULK_N],
      ["filters, a range across the first page's end", { filters: { emailSuffix: { include: [`@${BULK}`] } }, clientTag: A, rangeFrom: 4990, rangeTo: 5015 }, (ids) => ids.length === 26],
      ["selected ids: the eligibility gate only (no targeting on this path)", { selectedIds: [L.avery, L.bounced, L.invalid, L.casey, L.canada], clientTag: A },
        (ids) => same(ids, [L.avery, L.casey, L.canada])],
      ["selected ids, the B2B side", { selectedIds: [L.avery, L.casey], clientTag: A, emailSide: "b2b" }, (ids) => same(ids, [L.avery, L.casey])],
    ];
    for (const [label, raw, expect] of cases) {
      await c.query("SAVEPOINT eq");
      const r = await R.selection.resolveSelection(c, raw, A);
      if (r.errors) {
        check(`${label}: resolved`, false, JSON.stringify(r.errors));
        await c.query("ROLLBACK TO SAVEPOINT eq");
        continue;
      }
      const sel = G.selectionOf(r.selection);
      const mine = await G.pushSetIds(c, sel);
      const counts = await G.readinessCounts(c, sel, { id: randomUUID(), prompt_version: 1 });
      const push = await pushGather(c, r.selection);
      check(`${label}: the same leads as the push's own gather (${mine.length})`,
        push.failed.length === 0 && same(mine, push.ids) && expect(mine) && counts.selected === mine.length && counts.missing === mine.length,
        JSON.stringify({ mine: mine.length, push: push.ids.length, failed: push.failed, selected: counts.selected }));
      await c.query("ROLLBACK TO SAVEPOINT eq");
    }
    const b2c = await R.selection.resolveSelection(c, { selectedIds: [L.avery], clientTag: A, emailSide: "b2c" }, A);
    check("selected ids with no lead of the side asked: refused, as push-batch refuses it", b2c.errors?.[0] === "No b2c leads in the selection", JSON.stringify(b2c));
    const refusals = [
      [{ filters: SEL_NAMED.filters, rangeFrom: 2 }, /rangeFrom\/rangeTo must be positive integers/],
      [{ selectedIds: [L.avery], rangeFrom: 1, rangeTo: 2 }, /cannot be combined with selectedIds/],
      [{ rangeFrom: 1, rangeTo: 2 }, /requires filters/],
      [{}, /Provide selectedIds or filters/],
      [{ selectedIds: ["not-an-id"] }, /uuid strings/],
      [{ filters: SEL_NAMED.filters, maxLeads: 0 }, /maxLeads must be a positive integer/],
      [{ filters: SEL_NAMED.filters, clientTag: B }, /is for XQ3B, not XQ3A-OS/],
      [{ filters: SEL_NAMED.filters, emailSide: "both" }, /emailSide must be/],
    ];
    for (const [raw, re] of refusals) {
      const r = await R.selection.resolveSelection(c, raw, A);
      check(`a selection push-batch refuses is refused: ${re.source}`, Boolean(r.errors?.some((e) => re.test(e))), JSON.stringify(r.errors));
    }
    const kept = await R.selection.resolveSelection(c, { ...SEL_NAMED, filters: { ...SEL_NAMED.filters, excludeIds: [L.blake] } }, A);
    check("the select-all's unchecked rows ride in the filters, and the gather leaves them out",
      Array.isArray(kept.selection?.filters?.excludeIds) && !(await G.pushSetIds(c, G.selectionOf(kept.selection))).includes(L.blake));
    const top = await R.selection.resolveSelection(c, { filters: SEL_NAMED.filters, includeAlreadyPushed: true }, A);
    check("includeAlreadyPushed is also taken at the top level; the client is always the route's tag",
      top.selection?.push_options?.includeAlreadyPushed === true && top.selection.client_tag === A && top.selection.filters.applyClientTargeting === A);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

// ── D. The routes ───────────────────────────────────────────────────────────

const VARIABLES_KEYS = ["tag", "isOs", "switchOn", "workerReady", "current", "variables"];
const DETAIL_KEYS = ["id", "name", "copyTag", "createdForTag", "services", "clientContext", "researchPrompt", "peoplePrompt", "generalPrompt",
  "maxWords", "version", "promptVersion", "archived", "updatedAt", "updatedBy"];
const LIST_KEYS = ["id", "name", "copyTag", "createdForTag", "services", "maxWords", "promptVersion", "archived", "usedBy"];
const JOB_KEYS = ["id", "variableId", "variableName", "status", "total", "done", "failed", "skipped", "companies", "researched", "spendUsd", "note",
  "error", "createdAt", "completedAt"];
const READY_KEYS = ["selected", "withValue", "stale", "missing", "errors", "companiesMissing", "estimate"];
const ctx = {};

async function partD() {
  section("D. The routes: roles, shapes, 400s and 409s");
  T.audits.length = 0;
  T.worker = null;
  T.role = "viewer";
  const fakeId = randomUUID();
  const viewer = [
    await call(R.variables.GET, { query: { tag: A } }),
    await call(R.variable.GET, { params: { id: fakeId } }),
    await call(R.context.GET, { query: { tag: A } }),
    await call(R.bison.GET, { query: { tag: A, variableId: fakeId } }),
    await call(R.readiness.POST, { body: { tag: A, variableId: fakeId, selection: SEL_NAMED } }),
    await call(R.jobs.GET, { query: { tag: A } }),
    await call(R.jobs.POST, { body: { tag: A, variableId: fakeId, selection: SEL_NAMED } }),
    await call(R.cancel.POST, { body: { jobId: fakeId } }),
    await call(R.values.GET, { query: { variableId: fakeId } }),
    await call(R.copy.POST, { body: { tag: A, variableId: fakeId, campaigns: [{ instance_url: B2B, id: 1 }] } }),
    await call(R.client.PUT, { body: { tag: A, variableId: null } }),
  ];
  check("a viewer is refused every route (403)", viewer.every((r) => r.status === 403), viewer.map((r) => r.status).join(","));
  T.role = "manager";
  const mgr = [
    await call(R.variables.POST, { body: { tag: A, name: "xq3 nope" } }),
    await call(R.variable.PUT, { params: { id: fakeId }, body: { version: 1 } }),
    await call(R.archive.POST, { params: { id: fakeId }, body: { archived: true, version: 1 } }),
    await call(R.bison.POST, { body: { tag: A, variableId: fakeId } }),
  ];
  check("a manager may not make, save, archive or make in Bison (403): admins only", mgr.every((r) => r.status === 403), mgr.map((r) => r.status).join(","));

  const listA = await call(R.variables.GET, { query: { tag: A.toLowerCase() } });
  const b = listA.body;
  check("the client's list: its exact shape, an OS client (its -OS ending), switched off, no worker, the default question",
    listA.status === 200 && keysAre(b, VARIABLES_KEYS) && b.tag === A && b.isOs === true && b.switchOn === false && b.workerReady === false &&
      keysAre(b.current, ["variableId"]) && b.current.variableId === null && !b.variables.some((v) => v.name.startsWith("xq3")),
    JSON.stringify(b));
  const isOsB = (await call(R.variables.GET, { query: { tag: B } })).body.isOs;
  const isOsC = (await call(R.variables.GET, { query: { tag: C } })).body.isOs;
  check("... OS by its type OS as well; a client of neither is not", isOsB === false && isOsC === true);
  check("... an unknown client is a 404, a tag that is not one a 400",
    (await call(R.variables.GET, { query: { tag: "XQ3ZZ" } })).status === 404 && (await call(R.variables.GET, { query: { tag: "not a tag!" } })).status === 400);

  T.role = "admin";
  const make = (body) => call(R.variables.POST, { body: { tag: A, services: "Made-up services", clientContext: "Made-up context", researchPrompt: RESEARCH,
    peoplePrompt: PEOPLE, generalPrompt: GENERAL, maxWords: 16, ...body } });
  const refusedMake = [
    ["a name Bison already uses for every lead", await make({ name: "{Question}" }), /already sent with every lead/],
    ["a name with characters Bison's names don't hold", await make({ name: "xq3 bad!name" }), /letters, digits, spaces, dashes or underscores/],
    ["an unknown placeholder, named", await make({ name: "xq3 one", peoplePrompt: "Hi {{Favourite Colour}}" }), /People question prompt: Unknown placeholder \{\{Favourite Colour\}\}/],
    ["a person in the research prompt", await make({ name: "xq3 one", researchPrompt: "About {{Title}}" }), /Research prompt: Unknown placeholder \{\{Title\}\}/],
    ["an unclosed placeholder", await make({ name: "xq3 one", generalPrompt: "Hi {{Company" }), /General question prompt: An unclosed/],
    ["max words out of range", await make({ name: "xq3 one", maxWords: 3 }), /Max words must be a whole number from 4 to 40/],
    ["a prompt too long", await make({ name: "xq3 one", researchPrompt: "x".repeat(20_001) }), /at most 20,000/],
  ];
  for (const [label, r, re] of refusedMake) {
    check(`make: ${label}: 400 with the reason`, r.status === 400 && Array.isArray(r.body.errors) && r.body.errors.some((e) => re.test(e)), JSON.stringify(r.body).slice(0, 300));
  }
  check("make: an unknown client is a 404", (await make({ tag: "XQ3ZZ", name: "xq3 zz" })).status === 404);
  const made = await make({ name: "  {XQ3A-OS   Question}  " });
  const v = made.body?.variable;
  ctx.vid = v?.id;
  check("make: 201, the name stored as Bison stores it, the copy form, versions 1, the placeholders each prompt may use",
    made.status === 201 && keysAre(made.body, ["variable", "placeholders"]) && keysAre(v, DETAIL_KEYS) && v.name === "xq3a-os question" &&
      v.copyTag === "{XQ3A-OS QUESTION}" && v.createdForTag === A && v.version === 1 && v.promptVersion === 1 && v.maxWords === 16 &&
      v.archived === false && v.researchPrompt === RESEARCH && JSON.stringify(made.body.placeholders.research) === JSON.stringify(RESEARCH_PLACEHOLDERS) &&
      JSON.stringify(made.body.placeholders.question) === JSON.stringify(QUESTION_PLACEHOLDERS),
    JSON.stringify(made.body).slice(0, 400));
  const log = await one(`SELECT action, after FROM question_variable_log WHERE variable_id = $1`, [ctx.vid]);
  check("... logged with its fields (server-only); the audit line holds lengths only, never a prompt or the services",
    log?.action === "create" && log.after.people_prompt === PEOPLE &&
      T.audits.some((a) => a.action === "question_variable" && /research prompt \d+/.test(a.details)) &&
      !T.audits.some((a) => /xq3-people|xq3-research|Made-up services|Made-up context/.test(a.details ?? "")));
  const dup = await make({ name: "XQ3A-OS question" });
  check("make: the same name again is a 400 that says it exists", dup.status === 400 && /already exists/.test(dup.body.error), JSON.stringify(dup.body));
  const copied = await call(R.variables.POST, { body: { tag: B, name: "xq3b question", copyFromId: ctx.vid, services: "B's made-up services" } });
  const cv = copied.body?.variable;
  ctx.vidB = cv?.id;
  check("make with copyFromId: every field left out is copied, a field sent wins",
    copied.status === 201 && cv.services === "B's made-up services" && cv.clientContext === "Made-up context" && cv.researchPrompt === RESEARCH &&
      cv.peoplePrompt === PEOPLE && cv.generalPrompt === GENERAL && cv.maxWords === 16 && cv.createdForTag === B, JSON.stringify(copied.body).slice(0, 300));

  T.role = "manager";
  const got = await call(R.variable.GET, { params: { id: ctx.vid } });
  check("one variable: the same view, for a manager", got.status === 200 && JSON.stringify(got.body.variable) === JSON.stringify(v));
  check("... a bad id is a 400, an unknown one a 404",
    (await call(R.variable.GET, { params: { id: "nope" } })).status === 400 && (await call(R.variable.GET, { params: { id: fakeId } })).status === 404);
  T.role = "admin";
  const stale = await call(R.variable.PUT, { params: { id: ctx.vid }, body: { version: 0, services: "Changed" } });
  check("save over an old version: 409 with changed, nothing saved",
    stale.status === 409 && stale.body.changed === true && (await one(`SELECT services FROM question_variables WHERE id = $1`, [ctx.vid])).services === "Made-up services",
    JSON.stringify(stale.body));
  const saved = await call(R.variable.PUT, { params: { id: ctx.vid }, body: { version: 1, maxWords: 18 } });
  check("save: version and prompt version go up; a field left out is kept",
    saved.status === 200 && saved.body.variable.version === 2 && saved.body.variable.promptVersion === 2 && saved.body.variable.maxWords === 18 &&
      saved.body.variable.peoplePrompt === PEOPLE, JSON.stringify(saved.body).slice(0, 200));
  const back = await call(R.variable.PUT, { params: { id: ctx.vid }, body: { version: 2, maxWords: 16 } });
  const nothing = await call(R.variable.PUT, { params: { id: ctx.vid }, body: { version: 3, maxWords: 16, services: "  Made-up services  " } });
  check("save with nothing changed: answered as it is, no version spent",
    back.body.variable.version === 3 && nothing.status === 200 && nothing.body.variable.version === 3 && nothing.body.variable.promptVersion === 3);
  const renamed = await call(R.variable.PUT, { params: { id: ctx.vid }, body: { version: 3, name: "xq3 other" } });
  const badPh = await call(R.variable.PUT, { params: { id: ctx.vid }, body: { version: 3, generalPrompt: "{{Nope}}" } });
  check("save: the name can't change, and an unknown placeholder is a 400",
    renamed.status === 400 && /name can't change/.test(renamed.body.error) && badPh.status === 400 && /\{\{Nope\}\}/.test(badPh.body.error));

  const arcStale = await call(R.archive.POST, { params: { id: ctx.vid }, body: { archived: true, version: 1 } });
  const arc = await call(R.archive.POST, { params: { id: ctx.vid }, body: { archived: true, version: 3 } });
  check("archive: an old version is a 409; then archived, version up",
    arcStale.status === 409 && arcStale.body.changed === true && arc.status === 200 && arc.body.variable.archived === true && arc.body.variable.version === 4);
  T.role = "manager";
  const chooseArchived = await call(R.client.PUT, { body: { tag: A, variableId: ctx.vid } });
  check("an archived variable can't be a client's question (400)", chooseArchived.status === 400 && /archived/.test(chooseArchived.body.error));
  T.role = "admin";
  const restored = await call(R.archive.POST, { params: { id: ctx.vid }, body: { archived: false, version: 4 } });
  check("restore: archived no more", restored.status === 200 && restored.body.variable.archived === false && restored.body.variable.version === 5);
  ctx.version = restored.body.variable.version;

  T.role = "manager";
  T.audits.length = 0;
  const chosen = await call(R.client.PUT, { body: { tag: A, variableId: ctx.vid } });
  check("the client's question: saved for a manager; the list says so, with who uses it",
    chosen.status === 200 && keysAre(chosen.body, VARIABLES_KEYS) && chosen.body.current.variableId === ctx.vid &&
      chosen.body.variables.find((x) => x.id === ctx.vid)?.usedBy.includes(A) && keysAre(chosen.body.variables[0], LIST_KEYS) &&
      chosen.body.variables[0].createdForTag === A,
    JSON.stringify(chosen.body).slice(0, 300));
  const toDefault = await call(R.client.PUT, { body: { tag: A, variableId: null } });
  check("... null is the default {QUESTION}", toDefault.body.current.variableId === null);
  await call(R.client.PUT, { body: { tag: A, variableId: ctx.vid } });
  check("... a bad id is a 400, an unknown variable a 400, an unknown client a 404, and the audit line names the choice",
    (await call(R.client.PUT, { body: { tag: A, variableId: "x" } })).status === 400 &&
      (await call(R.client.PUT, { body: { tag: A, variableId: fakeId } })).status === 400 &&
      (await call(R.client.PUT, { body: { tag: "XQ3ZZ", variableId: null } })).status === 404 &&
      T.audits.some((a) => a.action === "question_variable_client" && a.details === `${A} uses {XQ3A-OS QUESTION}`));

  const target = await call(R.context.GET, { query: { tag: A } });
  check("the onboarding target answer, for Fill from onboarding; none is null",
    target.status === 200 && keysAre(target.body, ["target"]) && target.body.target === "A made-up target answer" &&
      (await call(R.context.GET, { query: { tag: B } })).body.target === null);

  const ready = await call(R.readiness.POST, { body: { tag: A, variableId: ctx.vid, selection: SEL_NAMED } });
  const rb = ready.body;
  check("readiness: its shape; the push's leads, none written, four companies to research (one lead has neither site nor company)",
    ready.status === 200 && keysAre(rb, READY_KEYS) && keysAre(rb.estimate, ["researchCalls", "questionCalls"]) && rb.selected === 10 && rb.withValue === 0 &&
      rb.missing === 10 && rb.stale === 0 && rb.errors === 0 && rb.companiesMissing === 4 && rb.estimate.questionCalls === 10 && rb.estimate.researchCalls === 4,
    JSON.stringify(rb));
  const badReady = await call(R.readiness.POST, { body: { tag: A, variableId: ctx.vid, selection: { rangeFrom: 1 } } });
  check("readiness: a selection push-batch refuses is a 400 with the reasons; an unknown variable a 404",
    badReady.status === 400 && Array.isArray(badReady.body.errors) &&
      (await call(R.readiness.POST, { body: { tag: A, variableId: fakeId, selection: SEL_NAMED } })).status === 404);

  const start = (body = {}) => call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: SEL_NAMED, ...body } });
  T.worker = null;
  const noWorker = await start();
  T.worker = heartbeat({ capabilities: ["company_runs", "pipeline_v2"] });
  const oldWorker = await start();
  T.worker = heartbeat({ capabilities: WITH_QUESTIONS });
  const off = await start();
  check("a job: 409 with no worker, 409 with a worker that lacks question_jobs, 409 while the switch is off for the client",
    noWorker.status === 409 && oldWorker.status === 409 && /Deploy the latest worker/.test(oldWorker.body.error) && off.status === 409 &&
      off.body.error.startsWith(`Question variables are off for ${A}`), JSON.stringify([noWorker.body, oldWorker.body, off.body]));
  await setQs({ enabled: true, tags: [A] });
  check("... the switch on for another client only: still 409 for this one",
    (await call(R.jobs.POST, { body: { tag: B, variableId: ctx.vidB, selection: { ...SEL_NAMED, clientTag: B } } })).status === 409);
  check("... a bad selection, a bad maxLeads or rewrite: 400",
    (await start({ selection: { rangeFrom: 1 } })).status === 400 && (await start({ maxLeads: 0 })).status === 400 &&
      (await start({ maxLeads: 250_001 })).status === 400 && (await start({ rewrite: "yes" })).status === 400);
  const ok = await start({ maxLeads: 5 });
  check("... else queued: { jobId }, the selection stored as the push batch would store it",
    ok.status === 200 && keysAre(ok.body, ["jobId"]), JSON.stringify(ok.body));
  const row = await one(`SELECT * FROM question_jobs WHERE id = $1`, [ok.body.jobId]);
  check("... the job: queued, for the client, the selection's filters (as buildRpcFilters makes them) with the client's targeting, max 5",
    row?.status === "queued" && row.client_tag === A && row.selection.filters?.applyClientTargeting === A && row.selection.selected_ids === null &&
      row.selection.push_options?.includeAlreadyPushed === false && row.max_leads === 5 && row.rewrite === false);
  check("... a second job of the same client and variable while one is open: 409", (await start()).status === 409);
  const listed = await call(R.jobs.GET, { query: { tag: A } });
  check("the client's jobs: newest first, each in its exact shape",
    listed.status === 200 && keysAre(listed.body, ["jobs"]) && listed.body.jobs[0]?.id === ok.body.jobId && keysAre(listed.body.jobs[0], JOB_KEYS) &&
      listed.body.jobs[0].variableName === "xq3a-os question" && listed.body.jobs[0].status === "queued");
  const cancelled = await call(R.cancel.POST, { body: { jobId: ok.body.jobId } });
  check("cancel: { cancelled, job }, the job cancelled; again: 409; an unknown job: 404",
    cancelled.status === 200 && cancelled.body.cancelled === true && cancelled.body.job.status === "cancelled" &&
      (await call(R.cancel.POST, { body: { jobId: ok.body.jobId } })).status === 409 && (await call(R.cancel.POST, { body: { jobId: fakeId } })).status === 404);
  await setQs({ enabled: false, tags: [] });
}

// ── E. Bison ────────────────────────────────────────────────────────────────

async function partE() {
  section("E. Bison: pages, made only where missing, tokens kept to their install, the copy check");
  T.role = "manager";
  net.bison.length = 0;
  const live = await call(R.bison.GET, { query: { tag: A, variableId: ctx.vid } });
  const by = Object.fromEntries((live.body?.installs ?? []).map((i) => [i.install, i]));
  check("the live read: its shape; missing on the B2B install (18 variables over 2 pages), there on the B2C one (any case)",
    live.status === 200 && keysAre(live.body, ["name", "copyTag", "installs"]) && live.body.name === "xq3a-os question" &&
      by[B2B]?.side === "b2b" && by[B2B].exists === false && by[B2B].error === null && by[B2C]?.side === "b2c" && by[B2C].exists === true &&
      keysAre(by[B2B], ["install", "side", "exists", "error"]),
    JSON.stringify(live.body));
  check("... B2B read by meta.last_page (pages 1 and 2), B2C by links.next",
    net.bison.some((x) => x.host === B2B && x.path.endsWith("page=2")) && net.bison.filter((x) => x.host === B2C).length === 1);
  check("... each install got its own token only, and no answer holds one",
    net.bison.every((x) => x.auth === `Bearer ${TOKENS[x.host]}`) && !JSON.stringify(live.body).includes("made-up-token"));
  T.role = "admin";
  const madeIn = await call(R.bison.POST, { body: { tag: A, variableId: ctx.vid } });
  check("Create in Bison: made on the install that lacked it only",
    madeIn.status === 200 && JSON.stringify(madeIn.body) === JSON.stringify({ created: [B2B], existed: [B2C], failed: [] }) &&
      bison.vars[B2B].includes("xq3a-os question") && net.bison.filter((x) => x.method === "POST").length === 1, JSON.stringify(madeIn.body));
  const again = await call(R.bison.POST, { body: { tag: A, variableId: ctx.vid } });
  check("... again: nothing to make", JSON.stringify(again.body) === JSON.stringify({ created: [], existed: [B2B, B2C], failed: [] }));
  check("a client with no installs saved: an empty list, and nothing to make in (409)",
    JSON.stringify((await call(R.bison.GET, { query: { tag: B, variableId: ctx.vid } })).body.installs) === "[]" &&
      (await call(R.bison.POST, { body: { tag: B, variableId: ctx.vid } })).status === 409);
  const nokey = await call(R.bison.GET, { query: { tag: C, variableId: ctx.vid } });
  check("an install with no key: not asked, said so", nokey.body.installs[0]?.exists === null && /No Bison key is set/.test(nokey.body.installs[0]?.error) &&
    !net.bison.some((x) => x.host === NOKEY));
  bison.fail[B2B] = 500;
  const broken = await call(R.bison.GET, { query: { tag: A, variableId: ctx.vid } });
  check("an install that answers 500: exists unknown, with the status", broken.body.installs.find((i) => i.install === B2B)?.exists === null &&
    /HTTP 500/.test(broken.body.installs.find((i) => i.install === B2B)?.error));
  const asked = [];
  const offsite = async (u) => {
    asked.push(new URL(u).hostname);
    return json(200, { data: [{ id: 1, name: "q" }], links: { next: `https://${EVIL}/api/custom-variables?page=2` } });
  };
  const names = await R.bisonLib.listVariableNames({ base: `https://${B2C}`, key: "made-up" }, offsite);
  check("a links.next to another host is never followed (the token stays home)", JSON.stringify(names) === '["q"]' && !asked.includes(EVIL));

  T.role = "manager";
  net.bison.length = 0;
  const copy = await call(R.copy.POST, {
    body: { tag: A, variableId: ctx.vid, campaigns: [{ instance_url: B2B, id: 101 }, { instance_url: `https://${B2B}/`, id: "102" }, { instance_url: B2C, id: 103 },
      { instance_url: `unknown.${HOST}`, id: 104 }, { instance_url: B2B, id: 105 }] },
  });
  const cc = copy.body?.campaigns ?? [];
  check("the copy check: the variable any case, the default {QUESTION} as its own token, the order kept, its shape",
    copy.status === 200 && cc.length === 5 && keysAre(cc[0], ["instance_url", "id", "usesVariable", "usesQuestion", "error"]) &&
      cc[0].usesVariable === true && cc[0].usesQuestion === false && cc[1].usesVariable === false && cc[1].usesQuestion === true && cc[1].id === 102 &&
      cc[2].usesVariable === false && cc[2].usesQuestion === false && cc[2].error === null,
    JSON.stringify(cc));
  check("... a campaign on an install with no key: an error, not asked; one Bison can't find: an error",
    /No Bison key is set/.test(cc[3].error) && /HTTP 404/.test(cc[4].error) && !net.bison.some((x) => x.host.startsWith("unknown.")));
  check("... a bad body is a 400", (await call(R.copy.POST, { body: { tag: A, variableId: ctx.vid, campaigns: [] } })).status === 400 &&
    (await call(R.copy.POST, { body: { tag: A, variableId: ctx.vid, campaigns: [{ instance_url: B2B, id: "1x" }] } })).status === 400);
}

// ── F. Jobs end to end ──────────────────────────────────────────────────────

const logs = [];
const deps = (env = { OPENAI_API_KEY: KEY }) => ({ fetch: globalThis.fetch, env, log: (m) => logs.push(m) });
async function runSteps(d = deps(), max = 40) {
  const out = [];
  for (let i = 0; i < max; i++) {
    const s = await J.questionStep(pool, d);
    out.push(s);
    if (!s.jobId) break;
  }
  return out;
}
const jobRow = (id) => one(`SELECT * FROM question_jobs WHERE id = $1`, [id]);
const valueOf = (lead, vid = ctx.vid) => one(`SELECT * FROM lead_question_values WHERE variable_id = $1 AND lead_id = $2`, [vid, lead]);
const spentToday = async () => Number((await one(`SELECT used FROM enrich_spend_daily WHERE ${SPEND_TODAY}`))?.used ?? 0);
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
/** Lets a paused job be looked at again now, as a minute later. */
const later = (id) => pool.query(`UPDATE question_jobs SET claimed_at = now() - interval '2 minutes' WHERE id = $1`, [id]);

async function partF() {
  section("F. Jobs end to end: OpenAI stubbed");
  const QS = { enabled: true, tags: [A], usd_per_day: 5, concurrency: 2, max_searches: 1, research_model: "gpt-6-luna", question_model: "gpt-6-luna", max_words: 16 };
  await setQs(QS);
  resetSettingsCache();
  const prices = (await readSettings(pool)).spend_caps.openai_prices;
  const researchUsd = openAiCost({ model: "gpt-6-luna", usage: { input_tokens: 1000, output_tokens: 50 }, searches: 1 }, prices).usd;
  const questionUsd = openAiCost({ model: "gpt-6-luna", usage: { input_tokens: 1000, output_tokens: 50 }, searches: 0 }, prices).usd;
  T.role = "manager";
  T.worker = heartbeat({ capabilities: WITH_QUESTIONS });
  const spend0 = await spentToday();
  net.openai = 0;
  net.bodies.length = 0;
  net.researched.length = 0;
  net.asked.clear();
  const started = await call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: SEL_NAMED } });
  const jobId = started.body?.jobId;
  check("a job for the push's leads is queued", started.status === 200 && Boolean(jobId), JSON.stringify(started.body));

  const steps = await runSteps();
  const job = await jobRow(jobId);
  check("the worker's steps: gathered, written in a slice, done; then nothing to do",
    steps[0]?.jobId === jobId && steps.at(-1)?.jobId === null && job.status === "done" && job.completed_at !== null && job.note === null,
    JSON.stringify({ steps, status: job.status, note: job.note, error: job.error }));
  check("... its counts: 10 leads, 8 written, 1 failed (too long), 1 skipped (nothing to research), 4 companies, each researched once",
    job.total === 10 && job.done === 8 && job.failed === 1 && job.skipped === 1 && job.companies === 4 && job.researched === 4,
    JSON.stringify({ total: job.total, done: job.done, failed: job.failed, skipped: job.skipped, companies: job.companies, researched: job.researched }));
  check("research: one call per company, shared by its leads", same(net.researched, ["Alphatest Facilities", "Betatest Offices", "Gammatest Group", "Deltatest Ltd"]) &&
    new Set(net.researched).size === 4, JSON.stringify(net.researched));
  const researchBodies = net.bodies.filter((x) => x?.text?.format?.name === "research");
  check("... with the web search tool at the setting's most searches, the strict schema, the research model, the client's service area (the sheet's text)",
    researchBodies.length === 4 && researchBodies.every((x) => x.tools?.[0]?.type === "web_search" && x.max_tool_calls === 1 && x.model === "gpt-6-luna" &&
      x.text.format.strict === true && /in Made-up County and nearby\./.test(x.input) && /\((alpha|beta|gamma|delta)\.named\./.test(x.input)),
    JSON.stringify(researchBodies.map((x) => x.input)));
  const questionBodies = net.bodies.filter((x) => x?.text?.format?.name === "question");
  check("questions: no tool, the strict schema; the General prompt for the general inbox only, the People prompt for the rest",
    questionBodies.length === 13 && questionBodies.every((x) => !x.tools && x.text.format.strict === true) &&
      questionBodies.filter((x) => x.input.includes("[xq3-general]")).length === 1 && net.asked.get("general") === 1 &&
      questionBodies.filter((x) => x.input.includes("[xq3-people]")).length === 12,
    `${questionBodies.length} ${JSON.stringify([...net.asked])}`);
  check("... the question prompts read the research answer and the client context",
    questionBodies.some((x) => x.input.includes("A made-up summary of Alphatest Facilities Made-up context")) &&
      questionBodies.some((x) => x.input.includes("Write a question for the team at Alphatest Facilities. Made-up fit")));
  check("... the made-up key, and only it, went to OpenAI", net.auth.size === 1 && net.auth.has(`Bearer ${KEY}`));

  const avery = await valueOf(L.avery);
  check("a value: the answer with its first letter lower case, as Clay's question column; the raw answer kept; words, kind, version, company, model, cost",
    avery?.status === "done" && avery.value === "would a made-up pilot help your team this spring?" && avery.raw === PLAN.Avery[0] && avery.words === 9 &&
      avery.prompt_kind === "people" && avery.prompt_version === 3 && avery.company_key === `alpha.${NAMED}` && avery.model === "gpt-6-luna" &&
      near(avery.cost_usd, questionUsd), JSON.stringify(avery));
  const info = await valueOf(L.info);
  check("... the general inbox's value comes from the General prompt", info?.status === "done" && info.prompt_kind === "general" && info.value === "what does the made-up team need next?");
  const casey = await valueOf(L.casey);
  check("over the word limit: asked once more with a correction, and the second answer kept",
    net.asked.get("Casey") === 2 && casey?.status === "done" && casey.value === "could Casey use a shorter made-up question?" && near(casey.cost_usd, 2 * questionUsd) &&
      questionBodies.some((x) => x.input.includes("Write a question for Casey,") && /it had 25 words; use at most 16/.test(x.input)), JSON.stringify(casey));
  const emery = await valueOf(L.emery);
  check("... still over after the retry: an error \"over 16 words\", no value, the answer kept as raw",
    net.asked.get("Emery") === 2 && emery?.status === "error" && emery.value === null && emery.note === "over 16 words" && emery.words === 30 && emery.raw === PLAN.Emery[0],
    JSON.stringify(emery));
  const drew = await valueOf(L.drew);
  check("a long dash: asked once more, still there, then a comma; the raw answer keeps it",
    net.asked.get("Drew") === 2 && drew?.status === "done" && drew.value === "is your team ready, or still planning?" && drew.raw === PLAN.Drew[0], JSON.stringify(drew));
  const harper = await valueOf(L.harper);
  check("braces: asked once more, then taken out", net.asked.get("Harper") === 2 && harper?.value === "harper is the made-up plan ready?", JSON.stringify(harper));
  const gray = await valueOf(L.gray);
  check("a lead with no site and no company: skipped with the reason, nothing called",
    gray?.status === "skipped" && gray.note === "No company or website to research" && !net.asked.has("Gray"));
  const finley = await valueOf(L.finley);
  check("a company with no site: keyed by company|city|state", finley?.company_key === "gammatest group|springfield|IL" && finley.status === "done");
  const research = await all(`SELECT company_key, status, prompt_version, research, cost_usd FROM question_research WHERE variable_id = $1`, [ctx.vid]);
  check("the research rows: one per company, done, the current prompt version, the answer's three fields, the call's cost",
    research.length === 4 && research.every((r) => r.status === "done" && r.prompt_version === 3 && Object.keys(r.research).length === 3 && near(r.cost_usd, researchUsd)));
  const expected = 4 * researchUsd + 13 * questionUsd;
  const spent = (await spentToday()) - spend0;
  check("spend: every call's dollars under openai_usd_questions, the job's total the same",
    near(spent, expected) && near(job.spend_usd, expected), JSON.stringify({ spent, expected, job: job.spend_usd }));

  // Values written: readiness, the review list.
  const ready = (await call(R.readiness.POST, { body: { tag: A, variableId: ctx.vid, selection: SEL_NAMED } })).body;
  check("readiness after the job: 8 with a current value, 2 errors or skips, nothing to research",
    ready.selected === 10 && ready.withValue === 8 && ready.errors === 2 && ready.missing === 0 && ready.stale === 0 && ready.companiesMissing === 0, JSON.stringify(ready));
  const values = await call(R.values.GET, { query: { variableId: ctx.vid, tag: A, limit: "3" } });
  check("the review list: newest first, 3, company and title, never an email",
    values.status === 200 && values.body.values.length === 3 && keysAre(values.body.values[0], ["company", "title", "value", "status", "note", "generatedAt"]) &&
      !JSON.stringify(values.body).includes("@") && values.body.values[0].generatedAt >= values.body.values[2].generatedAt);
  check("... for another client's jobs: nothing; a bad limit: 400",
    (await call(R.values.GET, { query: { variableId: ctx.vid, tag: B } })).body.values.length === 0 &&
      (await call(R.values.GET, { query: { variableId: ctx.vid, limit: "500" } })).status === 400);

  // The snapshot itself: the push set minus current values, unless rewrite; the cap; run twice.
  const sel = (await R.selection.resolveSelection(pool, SEL_NAMED, A)).selection;
  const mkJob = async (o) => (await one(
    `INSERT INTO question_jobs (variable_id, client_tag, selection, rewrite, max_leads, status) VALUES ($1, $2, $3::jsonb, $4, $5, 'cancelled') RETURNING *`,
    [ctx.vid, A, JSON.stringify(sel), o.rewrite === true, o.max ?? null]));
  const variable = { id: ctx.vid, prompt_version: 3 };
  const j1 = await mkJob({});
  const g1 = await G.gatherJob(pool, j1, variable);
  const items1 = (await all(`SELECT lead_id FROM question_job_items WHERE job_id = $1`, [j1.id])).map((r) => r.lead_id);
  check("the snapshot: the push's leads minus those with a current value (the error and the skip are written again)",
    g1.seen === 10 && same(items1, [L.emery, L.gray]) && g1.inserted === 2, JSON.stringify(g1));
  const g1b = await G.gatherJob(pool, j1, variable);
  check("... run again: nothing new (a cut-short gather simply runs again)", g1b.inserted === 0 && g1b.items === 2);
  const j2 = await mkJob({ rewrite: true, max: 4 });
  const g2 = await G.gatherJob(pool, j2, variable);
  check("... rewrite takes every lead, capped at max_leads", g2.items === 4 && g2.inserted === 4);
  const j3 = await mkJob({ rewrite: true });
  check("... a stale value (an older prompt version) is written again", (await G.gatherJob(pool, j3, { id: ctx.vid, prompt_version: 4 }, {})).items === 10 &&
    (await G.gatherJob(pool, await mkJob({}), { id: ctx.vid, prompt_version: 4 })).items === 10);
  await pool.query(`DELETE FROM question_jobs WHERE client_tag = $1 AND status = 'cancelled' AND started_at IS NULL AND created_by IS NULL`, [A]);

  // Research reuse across jobs, and a new prompt version.
  net.researched.length = 0;
  net.asked.clear();
  const one1 = await call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: { selectedIds: [L.blake], clientTag: A }, rewrite: true } });
  await runSteps();
  check("a later job: the company's stored research is reused (no research call), the lead written again",
    (await jobRow(one1.body.jobId)).status === "done" && net.researched.length === 0 && net.asked.get("Blake") === 1);
  T.role = "admin";
  const v4 = await call(R.variable.PUT, { params: { id: ctx.vid }, body: { version: ctx.version, services: "Other made-up services" } });
  ctx.version = v4.body.variable.version;
  T.role = "manager";
  const one2 = await call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: { selectedIds: [L.blake], clientTag: A } } });
  await runSteps();
  const blake = await valueOf(L.blake);
  check("after a prompt change: the company is researched again, and the value has the new prompt version",
    v4.body.variable.promptVersion === 4 && (await jobRow(one2.body.jobId)).status === "done" && same(net.researched, ["Alphatest Facilities"]) &&
      blake.prompt_version === 4 && blake.status === "done");
  const readyNow = (await call(R.readiness.POST, { body: { tag: A, variableId: ctx.vid, selection: SEL_NAMED } })).body;
  check("readiness then: 1 current, 7 stale, 3 companies to research again",
    readyNow.withValue === 1 && readyNow.stale === 7 && readyNow.errors === 2 && readyNow.companiesMissing === 3, JSON.stringify(readyNow));

  // The budget.
  await setQs({ ...QS, usd_per_day: await spentToday() });
  const budgetJob = (await call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: { selectedIds: [L.avery], clientTag: A } } })).body.jobId;
  const callsBefore = net.openai;
  await runSteps();
  let bj = await jobRow(budgetJob);
  check("today's budget used up: the job is gathered, then paused with the reason, and nothing is sent",
    bj.status === "paused" && bj.note === "Today's question budget is used up" && bj.total === 1 && net.openai === callsBefore, JSON.stringify(bj));
  check("... a paused job is not looked at again within the minute", (await J.questionStep(pool, deps())).jobId === null);
  await setQs({ ...QS, usd_per_day: 5 });
  await later(budgetJob);
  await runSteps();
  bj = await jobRow(budgetJob);
  check("... with room again (the next UTC day, here a raised budget) it resumes by itself and finishes", bj.status === "done" && bj.done === 1 && bj.note === null,
    JSON.stringify(bj));

  // The switch.
  const switchJob = (await call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: { selectedIds: [L.casey], clientTag: A } } })).body.jobId;
  await setQs({ ...QS, tags: [] });
  await runSteps();
  const sj = await jobRow(switchJob);
  check("switched off for the client: the job is paused with the reason", sj.status === "paused" && sj.note === `Question variables are off for ${A}` && sj.total === 0,
    JSON.stringify(sj));
  await setQs(QS);
  await later(switchJob);
  await runSteps();
  check("... and resumes from the gather once it is on again", (await jobRow(switchJob)).status === "done");

  // Lost answers: three tries, then an error that never replaces a done value.
  const retryJob = (await call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: { selectedIds: [L.finley], clientTag: A }, rewrite: true } })).body.jobId;
  const finleyBefore = await valueOf(L.finley);
  net.fail.push(500, 500, 500);
  await runSteps();
  const rj = await jobRow(retryJob);
  const finleyAfter = await valueOf(L.finley);
  const item = await one(`SELECT status, attempts FROM question_job_items WHERE job_id = $1`, [retryJob]);
  check("an answer lost three times: the lead's try ends in an error after 3 attempts, the job is done with 1 failed",
    rj.status === "done" && rj.failed === 1 && item.status === "error" && item.attempts === 3 && net.fail.length === 0, JSON.stringify({ rj, item }));
  check("... and the value written before stays (an error never replaces a done value)",
    finleyAfter.status === "done" && finleyAfter.value === finleyBefore.value);

  // A refused key: the job pauses, the lead goes back with its try not counted.
  const keyJob = (await call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: { selectedIds: [L.harper], clientTag: A }, rewrite: true } })).body.jobId;
  net.fail.push(401);
  await runSteps();
  const kj = await jobRow(keyJob);
  const kitem = await one(`SELECT status, attempts FROM question_job_items WHERE job_id = $1`, [keyJob]);
  check("OpenAI refuses the key: the job pauses with the reason, the lead is pending again with its try not counted",
    kj.status === "paused" && kj.note === "OpenAI refused the key (401/403)" && kitem.status === "pending" && kitem.attempts === 0, JSON.stringify({ kj, kitem }));
  await later(keyJob);
  await runSteps(deps({}));
  check("no OPENAI_API_KEY on the worker: paused, saying so", (await jobRow(keyJob)).note === "Needs OPENAI_API_KEY on the worker");
  T.role = "admin";
  const arc = await call(R.archive.POST, { params: { id: ctx.vid }, body: { archived: true, version: ctx.version } });
  await later(keyJob);
  await runSteps();
  check("an archived variable: its open job waits, saying so", (await jobRow(keyJob)).note === "{XQ3A-OS QUESTION} is archived: restore it to go on");
  const res = await call(R.archive.POST, { params: { id: ctx.vid }, body: { archived: false, version: arc.body.variable.version } });
  ctx.version = res.body.variable.version;
  T.role = "manager";
  await call(R.cancel.POST, { body: { jobId: keyJob } });

  // Claim and stale reclaim.
  const claimJob = (await call(R.jobs.POST, { body: { tag: A, variableId: ctx.vid, selection: { selectedIds: [L.avery, L.blake], clientTag: A }, rewrite: true } })).body.jobId;
  const t1 = randomUUID();
  const t2 = randomUUID();
  const c1 = await J.claimJob(pool, t1);
  const c2 = await J.claimJob(pool, t2);
  await pool.query(`UPDATE question_jobs SET claimed_at = now() - interval '11 minutes' WHERE id = $1`, [claimJob]);
  const c3 = await J.claimJob(pool, t2);
  check("a job is claimed by one step at a time; a claim older than 10 minutes is taken over",
    c1?.id === claimJob && c2 === null && c3?.id === claimJob && c3.claim_token === t2);
  await J.releaseJob(pool, claimJob, t1);
  check("... a claim given back with an old token changes nothing", (await jobRow(claimJob)).claim_token === t2);
  await J.releaseJob(pool, claimJob, t2);
  await G.gatherJob(pool, await jobRow(claimJob), { id: ctx.vid, prompt_version: 4 });
  const i1 = await J.claimItems(pool, claimJob, t1, 10);
  const i2 = await J.claimItems(pool, claimJob, t2, 10);
  await pool.query(`UPDATE question_job_items SET claimed_at = now() - interval '11 minutes' WHERE job_id = $1`, [claimJob]);
  const i3 = await J.claimItems(pool, claimJob, t2, 10);
  check("items: claimed once; a working item whose claim is over 10 minutes old is taken again, its try counted",
    i1.length === 2 && i2.length === 0 && i3.length === 2 && i3.every((x) => x.attempts === 2));
  await call(R.cancel.POST, { body: { jobId: claimJob } });
  check("nothing open is left of this part", (await one(`SELECT count(*)::int AS n FROM question_jobs WHERE client_tag = $1 AND status IN ('queued','gathering','running','paused')`, [A])).n === 0);

  // The service area's own value wins over the sheet's text; loadServiceArea reads both rows.
  check("the service area as the writer reads it: the sheet's text", (await loadServiceArea(pool, A)) === "Made-up County and nearby");
  await pool.query(`INSERT INTO client_variables (client_tag, name, value) VALUES ($1, 'service_area', 'A made-up own area')`, [A]);
  check("... the client's own value first, and the places label for a client with neither",
    (await loadServiceArea(pool, A)) === "A made-up own area" && (await loadServiceArea(pool, B)) === "IL, MO: Springfield, IL; Peoria, IL");
  await pool.query(`DELETE FROM client_variables WHERE client_tag = $1`, [A]);
}

// ── G. The settings sheet ───────────────────────────────────────────────────

async function partG() {
  section("G. The settings sheet's question_variables");
  T.role = "manager";
  check("managers can't read the settings (403)", (await call(R.settings.GET)).status === 403);
  T.role = "admin";
  await setQs({ concurrency: 3 });
  const got = await call(R.settings.GET);
  const qv = got.body?.value?.question_variables;
  check("the sheet reads question_variables as the worker does", got.status === 200 &&
    JSON.stringify(qv) === JSON.stringify(questionSettingsFrom((await one(`SELECT value FROM enrich_settings WHERE key = 'question_variables'`)).value)), JSON.stringify(qv));
  const input = R.companies.settingsInputOf(got.body.value);
  check("... and sends back everything but concurrency", input.question_variables && !("concurrency" in input.question_variables) &&
    keysAre(input.question_variables, ["enabled", "tags", "max_words", "research_model", "question_model", "max_searches", "usd_per_day"]));
  const edit = (f) => {
    const x = structuredClone(input);
    f(x.question_variables, x);
    return { body: { version: got.body.version, ...x } };
  };
  const refused = async (label, f, re) => {
    const r = await call(R.settings.PUT, edit(f));
    check(`refused: ${label}`, r.status === 400 && re.test(r.body.error ?? ""), `${r.status} ${r.body.error ?? ""}`);
  };
  await refused("a client list with something that is not a tag", (q) => { q.tags = ["not a tag!"]; }, /Question variables: not a tag! is not a client tag/);
  await refused("dollars a day over 500", (q) => { q.usd_per_day = 600; }, /OpenAI dollars a day must be a number from 0 to 500/);
  await refused("max words under 4", (q) => { q.max_words = 3; }, /max words must be a whole number from 4 to 40/);
  await refused("most searches over 5", (q) => { q.max_searches = 6; }, /most searches must be a whole number from 0 to 5/);
  await refused("a model that is no model id", (q) => { q.research_model = "bad model!"; }, /research model: a model id/);
  await refused("a switch that is not on or off", (q) => { q.enabled = "yes"; }, /Question variables must be on or off/);
  const saved = await call(R.settings.PUT, edit((q) => {
    q.enabled = true;
    q.tags = [" xq3a-os ", "XQ3A-OS", "XQ3B"];
    q.usd_per_day = 2.5;
    q.max_words = 18;
    q.max_searches = 3;
    q.research_model = "  ";
    q.question_model = "made-up-model-1";
  }));
  const stored = (await one(`SELECT value FROM enrich_settings WHERE key = 'question_variables'`)).value;
  check("saved: tags upper case once each, an empty model is the pipeline's (null), concurrency kept as stored, the change listed",
    saved.status === 200 && JSON.stringify(stored.tags) === JSON.stringify([A, B]) && stored.enabled === true && stored.usd_per_day === 2.5 &&
      stored.max_words === 18 && stored.max_searches === 3 && stored.research_model === null && stored.question_model === "made-up-model-1" &&
      stored.concurrency === 3 && saved.body.changes.includes("question variables off to on"), JSON.stringify({ stored, changes: saved.body.changes }));
  const now = await call(R.settings.GET);
  const left = structuredClone(R.companies.settingsInputOf(now.body.value));
  delete left.question_variables;
  const keep = await call(R.settings.PUT, { body: { version: now.body.version, ...left } });
  check("a save that leaves question_variables out keeps it", keep.status === 200 &&
    JSON.stringify((await one(`SELECT value FROM enrich_settings WHERE key = 'question_variables'`)).value) === JSON.stringify(stored));
  const sheet = readFileSync(new URL("../src/components/companies/settings-sheet.tsx", import.meta.url), "utf8");
  check("the sheet has the section, admin only like the rest of the sheet", sheet.includes('label="Question variables"') && sheet.includes("setQuestion(\"usd_per_day\""));
}

// ── H. The worker ───────────────────────────────────────────────────────────

function partH() {
  section("H. The worker: its capability and the step's wiring");
  const worker = readFileSync(new URL("./enrich-worker.mjs", import.meta.url), "utf8");
  check("the capability is question_jobs, the one the routes check", QUESTION_JOBS_CAPABILITY === "question_jobs" && J.QUESTION_JOBS_CAPABILITY === QUESTION_JOBS_CAPABILITY);
  check("the enrich-worker lists it in its heartbeat and runs the step once a loop, on its own pool, not awaited, with a busy flag",
    worker.includes('import { QUESTION_JOBS_CAPABILITY, questionStep } from "./lib/questions/jobs.mjs";') &&
      worker.includes("CAPABILITIES.push(QUESTION_JOBS_CAPABILITY);") && worker.includes("questionStep(questionPool, { env, log, shouldStop: () => shuttingDown })") &&
      /if \(!questionBusy && Date\.now\(\) - lastQuestion > \(questionState\.idle \? QUESTION_IDLE_MS : 0\)\) \{[\s\S]*?questionInFlight = questionTick\(\);/.test(worker));
  check("... reports the step in its heartbeat, waits for it when stopping, and a draining worker waits for an open job",
    worker.includes("questions: { ...questionState },") && worker.includes("await questionInFlight;") && worker.includes("await questionPool.end()") &&
      worker.includes("!questionBusy && questionState.idle &&"));
  const tab = readFileSync(new URL("../src/components/clay/question-variable-tab.tsx", import.meta.url), "utf8");
  check("the Clay tab's tab keeps the export and props the setup sheet imports", tab.includes("export function QuestionVariableTab({ tag }: { tag: string })"));
}

// ── Run ─────────────────────────────────────────────────────────────────────

let enrichDb = null;
try {
  const ready = await one(
    `SELECT to_regclass('public.question_jobs') IS NOT NULL AND to_regclass('public.lead_question_values') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'push_batches' AND column_name = 'question_variable_id') AS ok`
  );
  if (!ready.ok) throw new Error("migration 139 is not in this database");
  const live = await one(
    `SELECT count(*)::int AS n FROM enrich_worker_state WHERE last_seen > now() - interval '60 seconds' AND coalesce(info->>'stopped', 'false') <> 'true'`
  );
  if (live.n) throw new Error("an enrichment worker is running: stop it first");
  const others = await one(
    `SELECT count(*)::int AS n FROM question_jobs WHERE status IN ('queued', 'gathering', 'running', 'paused') AND NOT (client_tag = ANY($1::text[]))`,
    [TAGS]
  );
  if (others.n) throw new Error("another client's question job is open in this database: this run would work it");
  await cleanup(); // anything an interrupted run left behind
  settingsBefore = await all(`SELECT key, value FROM enrich_settings`);
  spendBefore = { used: (await one(`SELECT used::text AS used FROM enrich_spend_daily WHERE ${SPEND_TODAY}`))?.used ?? null };
  await setQs({ enabled: false, tags: [] });
  enrichDb = await srcModule("lib/enrich/db.ts");
  R = {
    variables: await route("questions/variables"),
    variable: await route("questions/variables/[id]"),
    archive: await route("questions/variables/[id]/archive"),
    client: await route("questions/client"),
    context: await route("questions/context"),
    bison: await route("questions/bison"),
    readiness: await route("questions/readiness"),
    jobs: await route("questions/jobs"),
    cancel: await route("questions/jobs/cancel"),
    values: await route("questions/values"),
    copy: await route("questions/copy-check"),
    settings: await route("companies/settings"),
    selection: await srcModule("lib/questions/selection.ts"),
    bisonLib: await srcModule("lib/questions/bison.ts"),
    companies: await srcModule("lib/companies/server.ts"),
  };
  partA();
  partB();
  await setup();
  await partC();
  await partD();
  await partE();
  await partF();
  await partG();
  partH();
  check("nothing tried to reach any other address", net.refused === 0, String(net.refused));
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM leads WHERE email LIKE $2) AS leads,
            (SELECT count(*)::int FROM question_variables WHERE name LIKE 'xq3%') AS variables,
            (SELECT count(*)::int FROM question_jobs WHERE client_tag = ANY($1::text[])) AS jobs,
            (SELECT count(*)::int FROM push_batches WHERE client_tag = ANY($1::text[])) AS batches,
            (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[])) AS clients,
            (SELECT count(*)::int FROM client_targeting WHERE client_tag = ANY($1::text[])) AS rules,
            (SELECT count(*)::int FROM client_question_settings WHERE client_tag = ANY($1::text[])) AS choices`,
    [TAGS, `%.${HOST}`]
  );
  const back = settingsBefore
    ? JSON.stringify(await all(`SELECT key, value FROM enrich_settings ORDER BY key`)) ===
      JSON.stringify([...settingsBefore].sort((a, b) => (a.key < b.key ? -1 : 1)))
    : true;
  const spendBack = spendBefore
    ? ((await one(`SELECT used::text AS used FROM enrich_spend_daily WHERE ${SPEND_TODAY}`))?.used ?? null) === spendBefore.used
    : true;
  const clean = Object.values(left).every((n) => n === 0) && back && spendBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, settingsBack: back, spendBack })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await enrichDb?.enrichPool().end().catch(() => {});
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
