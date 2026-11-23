// The question writer (139): one lead's value of a question variable, from a
// research call per company (OpenAI with web search) and a question call per
// lead (no tools), each answered in a strict JSON schema.
//
// Everything it needs is handed to it (db, fetch, env, log), so the checks in
// scripts/test-question-variables.mjs run it with no network and no key.
//
// Research, once per company and variable: the company's key is its domain,
// else company|city|state (gather.mjs COMPANY_KEY_SQL, read with the lead). A
// stored done answer of the variable's current prompt version is reused;
// otherwise the research prompt is sent with the web search tool (at most
// max_searches calls; 0 sends no tool) for {company_summary, service_spaces,
// best_fit}, on question_variables.research_model, else the pipeline's
// people_claygent model (enrich_settings.models).
//
// Question, once per lead: the People prompt for a personal address
// (email_type 'personal'), the General prompt for anything else, with no tool,
// for {question}, on question_model, else the pipeline's people_question_ai
// model. The answer must be at most max_words words (the variable's own), with
// no long dash and no curly brace; when it breaks a rule it is asked once more,
// with a short correction. Then long dashes become a comma (or a space between
// two characters) and braces are taken out; still too long, the lead's value
// is an error "over N words", with no value. The value is the answer with its
// first letter lower case, as Clay's "question" column writes it.
//
// The request is built and priced as the pipeline's AI steps build and price
// theirs (scripts/lib/enrich/actions.mjs aiWeb; openAiCost from spend.mjs,
// imported, never changed): one send per attempt, 120 s, json_schema strict.
// Every answered call adds its dollars to enrich_spend_daily under its own
// kind, openai_usd_questions, so the pipeline's caps are untouched. Before
// every call today's total is read; at or over question_variables.usd_per_day
// the writer stops and the job is paused until the next UTC day.

import { openAiCost } from "../enrich/spend.mjs";
import { billingCode, searchesIn } from "../enrich/actions.mjs";
import { copyTag } from "./names.mjs";
import { contextFor, RESEARCH_FIELDS, renderQuestionPrompt } from "./render.mjs";

export const QUESTION_SPEND_KIND = "openai_usd_questions";
export const OPENAI_URL = "https://api.openai.com/v1/responses";
export const CALL_TIMEOUT_MS = 120_000;
/** lead_question_values.value holds at most this many characters. */
export const VALUE_MAX = 600;
const RAW_MAX = 2000;
const NOTE_MAX = 300;
const TODAY = `(now() AT TIME ZONE 'utc')::date`;

/** Why a job waits, in plain words (question_jobs.note). */
export const NOTES = Object.freeze({
  budget: "Today's question budget is used up",
  switchOff: (tag) => `Question variables are off for ${tag}`,
  noKey: "Needs OPENAI_API_KEY on the worker",
  noModel: "No research or question model is set: set one under Companies tab, Settings (Question variables), or the pipeline's models",
  archived: (name) => `${copyTag(name)} is archived: restore it to go on`,
  noResearchPrompt: (name) => `${copyTag(name)} has no research prompt: write one to go on`,
});

/** The research answer: three strings, in this order. */
export const RESEARCH_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [...RESEARCH_FIELDS],
  properties: Object.fromEntries(RESEARCH_FIELDS.map((f) => [f, { type: "string" }])),
});

/** The question answer: one string. */
export const QUESTION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["question"],
  properties: { question: { type: "string" } },
});

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {{ fetch?: typeof fetch, env?: Record<string, string | undefined>, log?: (m: string) => void, now?: () => number }} Deps
 * @typedef {ReturnType<typeof import("./settings.mjs").questionSettingsFrom>} QuestionSettings
 */

const text = (v) => (v == null ? "" : String(v).trim());
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * The model of the research call: the question setting's, else the pipeline's
 * research step (people_claygent) with its reasoning effort. Null when neither
 * is set.
 * @param {QuestionSettings} qs
 * @param {{ models?: Record<string, { model?: string, reasoning_effort?: string | null } | null> } | null | undefined} settings
 */
export function researchModelOf(qs, settings) {
  if (qs?.research_model) return { model: qs.research_model, effort: null };
  const s = settings?.models?.people_claygent;
  return s?.model ? { model: s.model, effort: s.reasoning_effort ?? null } : null;
}

/** The model of the question call: the question setting's, else the pipeline's question step (people_question_ai). */
export function questionModelOf(qs, settings) {
  if (qs?.question_model) return { model: qs.question_model, effort: null };
  const s = settings?.models?.people_question_ai;
  return s?.model ? { model: s.model, effort: s.reasoning_effort ?? null } : null;
}

// ── The question's rules ────────────────────────────────────────────────────

/** Long dashes: figure dash, en dash, em dash, horizontal bar, and the minus sign. */
const DASH = /[\u2012-\u2015\u2212]/;
const DASH_RUN = /\s*[\u2012-\u2015\u2212]+\s*/g;
const BRACE = /[{}]/;

/** Words, as a person counts them: runs of characters between spaces. */
export function wordsOf(s) {
  const t = text(s);
  return t ? t.split(/\s+/).length : 0;
}

/**
 * The rules an answer breaks: "empty", "long" (over maxWords words), "dash"
 * (a long dash), "brace" (a curly brace).
 * @param {unknown} answer
 * @param {number} maxWords
 * @returns {string[]}
 */
export function questionProblems(answer, maxWords) {
  const t = text(answer);
  if (!t) return ["empty"];
  const out = [];
  if (wordsOf(t) > maxWords) out.push("long");
  if (DASH.test(t)) out.push("dash");
  if (BRACE.test(t)) out.push("brace");
  return out;
}

/**
 * The answer made safe to send: each long dash (with the spaces around it)
 * becomes ", " when a space stood beside it and " " between two characters,
 * braces are taken out, spaces squeezed, and no comma is left at either end.
 * @param {unknown} answer
 */
export function cleanQuestion(answer) {
  return text(answer)
    .replace(DASH_RUN, (m) => (/\s/.test(m) ? ", " : " "))
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/,(\s*,)+/g, ",")
    .replace(/^[\s,]+|[\s,]+$/g, "");
}

/** As Clay's "question" column: the first letter lower case. */
export function lowerFirst(s) {
  const t = text(s);
  return t ? t.charAt(0).toLowerCase() + t.slice(1) : t;
}

/** The short correction sent with the one retry. */
export function correctionFor(answer, problems, maxWords) {
  const fix = [];
  if (problems.includes("empty")) fix.push("it was empty");
  if (problems.includes("long")) fix.push(`it had ${wordsOf(answer)} words; use at most ${maxWords}`);
  if (problems.includes("dash")) fix.push("it used a long dash; use a comma instead");
  if (problems.includes("brace")) fix.push("it used curly braces; leave them out");
  return `Your last answer was ${JSON.stringify(text(answer))}. Write it again: ${fix.join("; ")}.`;
}

// ── Spend ───────────────────────────────────────────────────────────────────

/** Dollars the question writer spent today (UTC). */
export async function questionSpentToday(db) {
  const { rows } = await db.query(`SELECT used FROM enrich_spend_daily WHERE day = ${TODAY} AND kind = $1`, [QUESTION_SPEND_KIND]);
  return Number(rows[0]?.used ?? 0);
}

/** May one more call be made today? A read: it counts nothing. */
export async function budgetAllows(db, qs) {
  const used = await questionSpentToday(db);
  const cap = Number(qs?.usd_per_day ?? 0);
  return { ok: used < cap, used, cap };
}

/** Adds one call's dollars to today's total; answers the total after it. */
export async function addQuestionSpend(db, usd) {
  const { rows } = await db.query(
    `INSERT INTO enrich_spend_daily AS s (day, kind, used, updated_at)
     VALUES (${TODAY}, $1, $2::numeric, now())
     ON CONFLICT (day, kind) DO UPDATE SET used = s.used + EXCLUDED.used, updated_at = now()
     RETURNING used`,
    [QUESTION_SPEND_KIND, String(Math.max(0, Number(usd) || 0))]
  );
  return Number(rows[0]?.used ?? 0);
}

// ── OpenAI ──────────────────────────────────────────────────────────────────

/**
 * One send to the Responses API, never retried here, never throwing. The error
 * text holds no key and no request.
 * @param {Deps} deps
 * @param {Record<string, unknown>} body
 */
export async function callOpenAi(deps, body, timeoutMs = CALL_TIMEOUT_MS) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    const res = await fetchFn(OPENAI_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${deps.env?.OPENAI_API_KEY ?? ""}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, json, error: res.ok ? null : `HTTP ${res.status}` };
  } catch (e) {
    const err = /** @type {any} */ (e);
    const timeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, status: 0, json: null, error: timeout ? `timed out after ${timeoutMs / 1000}s` : String(err?.cause?.code || err?.message || "request failed") };
  }
}

/**
 * What a refused or lost call means: "fatal" (the key, billing, or a request
 * OpenAI will never take: the job pauses, nothing more is sent), "retry" (no
 * answer, 429, 5xx: the lead is tried again later) or "error" (this lead only).
 */
export function failureOf(r) {
  if (r.status === 401 || r.status === 403) return { kind: "fatal", note: "OpenAI refused the key (401/403)" };
  const billing = r.status === 429 || r.status === 402 ? billingCode(r.json) : null;
  if (billing) return { kind: "fatal", note: `OpenAI refused for billing (${billing})` };
  if (r.status === 0 || r.status === 429 || r.status >= 500) return { kind: "retry", note: `OpenAI: ${r.error}` };
  const message = text(r.json?.error?.message);
  if (r.status === 400 || r.status === 404 || r.status === 422) {
    return { kind: "fatal", note: cut(`OpenAI refused the request (HTTP ${r.status})${message ? `: ${message}` : ""}`, NOTE_MAX) };
  }
  return { kind: "error", note: cut(`OpenAI: ${r.error}${message ? `: ${message}` : ""}`, NOTE_MAX) };
}

/** The answer object, the searches made and the usage, as aiWeb reads a response. */
export function parseResponse(json) {
  const out = json ?? {};
  const textOut = out.output_text ?? out.output?.flatMap((o) => o?.content ?? []).find((c) => c?.type === "output_text")?.text;
  let answer = null;
  try {
    answer = JSON.parse(textOut);
  } catch {
    /* left null */
  }
  return { answer: answer && typeof answer === "object" && !Array.isArray(answer) ? answer : null, searches: searchesIn(out), usage: out.usage ?? null };
}

/** The request body, as aiWeb builds one. */
function requestBody({ model, effort }, input, schemaName, schema, tools) {
  return {
    model,
    ...(tools.searches > 0 ? { tools: [{ type: "web_search" }] } : {}),
    input,
    ...(tools.searches > 0 ? { max_tool_calls: tools.searches } : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    text: { format: { type: "json_schema", name: schemaName, schema, strict: true } },
  };
}

// ── Research ────────────────────────────────────────────────────────────────

/**
 * The company's research answer: stored and current (reused), or asked now and
 * stored. Answers { ok: true, research, cost, model, researched } or
 * { ok: false, retry, note, cost } or { stop } (the job must pause: no model,
 * the budget, or a fatal refusal).
 * @param {Deps & { db: Db }} deps
 * @param {{ variable: any, lead: any, companyKey: string, serviceArea: string, qs: QuestionSettings, settings: any }} a
 */
export async function researchFor(deps, { variable, lead, companyKey, serviceArea, qs, settings }) {
  const db = deps.db;
  const { rows: [stored] } = await db.query(
    `SELECT status, prompt_version, research FROM question_research WHERE variable_id = $1 AND company_key = $2`,
    [variable.id, companyKey]
  );
  if (stored?.status === "done" && Number(stored.prompt_version) === Number(variable.prompt_version)) {
    return { ok: true, research: stored.research, cost: 0, model: null, researched: false, reused: true };
  }
  const m = researchModelOf(qs, settings);
  if (!m) return { stop: NOTES.noModel };
  if (!(await budgetAllows(db, qs)).ok) return { stop: NOTES.budget };
  const prompt = renderQuestionPrompt(variable.research_prompt, contextFor(lead, variable, { serviceArea }));
  const r = await callOpenAi(deps, requestBody(m, prompt, "research", RESEARCH_SCHEMA, { searches: Number(qs?.max_searches) || 0 }));
  if (!r.ok) {
    const f = failureOf(r);
    if (f.kind === "fatal") return { stop: f.note };
    await storeResearch(db, { variable, companyKey, status: "error", research: {}, note: f.note, model: m.model, cost: 0 });
    return { ok: false, retry: f.kind === "retry", note: `The company research failed: ${f.note}`, cost: 0 };
  }
  const { answer, searches, usage } = parseResponse(r.json);
  const { usd } = openAiCost({ model: m.model, usage, searches }, settings?.spend_caps?.openai_prices);
  await addQuestionSpend(db, usd);
  const research = answer && RESEARCH_FIELDS.every((f) => typeof answer[f] === "string")
    ? Object.fromEntries(RESEARCH_FIELDS.map((f) => [f, answer[f]]))
    : null;
  if (!research) {
    const note = "The research answer was not valid JSON";
    await storeResearch(db, { variable, companyKey, status: "error", research: {}, note, model: m.model, cost: usd });
    return { ok: false, retry: true, note: `The company research failed: ${note}`, cost: usd };
  }
  await storeResearch(db, { variable, companyKey, status: "done", research, note: null, model: m.model, cost: usd });
  return { ok: true, research, cost: usd, model: m.model, researched: true, reused: false };
}

/** One company's research row; an error never replaces a done answer of the same prompt version. */
async function storeResearch(db, { variable, companyKey, status, research, note, model, cost }) {
  await db.query(
    `INSERT INTO question_research (variable_id, company_key, prompt_version, status, research, note, model, cost_usd, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::numeric, now())
     ON CONFLICT (variable_id, company_key) DO UPDATE
        SET prompt_version = EXCLUDED.prompt_version, status = EXCLUDED.status, research = EXCLUDED.research,
            note = EXCLUDED.note, model = EXCLUDED.model, cost_usd = EXCLUDED.cost_usd, created_at = now()
      WHERE question_research.status <> 'done' OR EXCLUDED.status = 'done'
         OR question_research.prompt_version <> EXCLUDED.prompt_version`,
    [variable.id, companyKey, variable.prompt_version, status, JSON.stringify(research ?? {}), note ? cut(note, NOTE_MAX) : null, model, String(cost ?? 0)]
  );
}

// ── The question ────────────────────────────────────────────────────────────

/** Which prompt a lead gets: the People prompt for a personal address, the General prompt for anything else. */
export const promptKindOf = (lead) => (lead?.email_type === "personal" ? "people" : "general");

/**
 * Writes one lead's question. Answers { status: "done" | "error", raw, value,
 * words, cost, model, note } (an answer was had), or { retry, note, cost }
 * (no usable answer: try the lead again later), or { stop, cost }.
 * @param {Deps & { db: Db }} deps
 * @param {{ variable: any, lead: any, kind: "people" | "general", research: Record<string, unknown>, serviceArea: string,
 *   qs: QuestionSettings, settings: any }} a
 */
export async function questionFor(deps, { variable, lead, kind, research, serviceArea, qs, settings }) {
  const db = deps.db;
  const m = questionModelOf(qs, settings);
  if (!m) return { stop: NOTES.noModel, cost: 0 };
  const maxWords = Number(variable.max_words) || Number(qs?.max_words) || 16;
  const template = kind === "people" ? variable.people_prompt : variable.general_prompt;
  const prompt = renderQuestionPrompt(template, contextFor(lead, variable, { serviceArea, research }));
  let cost = 0;
  let raw = null;
  let problems = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!(await budgetAllows(db, qs)).ok) {
      if (raw != null) break; // the first answer stands, cleaned below
      return { stop: NOTES.budget, cost };
    }
    const input = attempt === 1 ? prompt : `${prompt}\n\n${correctionFor(raw, problems, maxWords)}`;
    const r = await callOpenAi(deps, requestBody(m, input, "question", QUESTION_SCHEMA, { searches: 0 }));
    if (!r.ok) {
      const f = failureOf(r);
      if (f.kind === "fatal") return { stop: f.note, cost };
      if (raw != null) break; // the retry was lost: the first answer stands
      return { retry: f.kind === "retry", note: f.note, cost };
    }
    const { answer, searches, usage } = parseResponse(r.json);
    const { usd } = openAiCost({ model: m.model, usage, searches }, settings?.spend_caps?.openai_prices);
    await addQuestionSpend(db, usd);
    cost += usd;
    if (typeof answer?.question !== "string") {
      if (raw != null) break;
      return { retry: true, note: "The question answer was not valid JSON", cost };
    }
    raw = answer.question;
    problems = questionProblems(raw, maxWords);
    if (!problems.length) break;
  }
  const cleaned = cleanQuestion(raw);
  const words = wordsOf(cleaned);
  const base = { raw: cut(text(raw), RAW_MAX) || null, words, cost, model: m.model };
  if (!cleaned) return { ...base, status: "error", value: null, note: "empty answer" };
  if (words > maxWords) return { ...base, status: "error", value: null, note: `over ${maxWords} words` };
  if (cleaned.length > VALUE_MAX) return { ...base, status: "error", value: null, note: `over ${VALUE_MAX} characters` };
  return { ...base, status: "done", value: lowerFirst(cleaned), note: null };
}

/**
 * One lead's row of lead_question_values. An error or a skip never replaces a
 * done value: a value already written stays sendable until a new one is had.
 * @param {Db} db
 */
export async function storeValue(db, row) {
  await db.query(
    `INSERT INTO lead_question_values (variable_id, lead_id, status, value, raw, words, prompt_kind, prompt_version,
                                       company_key, note, model, cost_usd, generated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::numeric, now())
     ON CONFLICT (variable_id, lead_id) DO UPDATE
        SET status = EXCLUDED.status, value = EXCLUDED.value, raw = EXCLUDED.raw, words = EXCLUDED.words,
            prompt_kind = EXCLUDED.prompt_kind, prompt_version = EXCLUDED.prompt_version, company_key = EXCLUDED.company_key,
            note = EXCLUDED.note, model = EXCLUDED.model, cost_usd = EXCLUDED.cost_usd, generated_at = now()
      WHERE lead_question_values.status <> 'done' OR EXCLUDED.status = 'done'`,
    [
      row.variable_id, row.lead_id, row.status, row.value ?? null, row.raw ?? null,
      Number.isInteger(row.words) ? Math.min(row.words, 32767) : null, row.prompt_kind ?? null, row.prompt_version,
      row.company_key ?? null, row.note ? cut(String(row.note), NOTE_MAX) : null, row.model ?? null, String(row.cost_usd ?? 0),
    ]
  );
}

/**
 * One lead of a job, start to end. Answers what the job does with its item:
 *   { kind: "done" | "error" | "skipped", row?, cost, researched }   row: the value row to store (none when the
 *                                                                     lead is gone or already has a current value)
 *   { kind: "failed", again, row, note, cost, researched }           no answer had: tried again later when `again`
 *                                                                     and tries are left, else row (an error) is stored
 *   { kind: "stop", note, cost, researched }                          pause the job; the lead goes back to pending
 *
 * @param {Deps & { db: Db }} deps
 * @param {{ job: any, variable: any, lead: any | undefined, existing: { status: string, prompt_version: number } | undefined,
 *   qs: QuestionSettings, settings: any, serviceArea: string, memo: Map<string, Promise<any>> }} a
 */
export async function writeLead(deps, { job, variable, lead, existing, qs, settings, serviceArea, memo }) {
  if (!lead) return { kind: "skipped", note: "The lead no longer exists", cost: 0, researched: 0 };
  if (!job.rewrite && existing?.status === "done" && Number(existing.prompt_version) === Number(variable.prompt_version)) {
    return { kind: "skipped", note: "Already written", cost: 0, researched: 0 };
  }
  const kind = promptKindOf(lead);
  const row = { variable_id: variable.id, lead_id: lead.id, prompt_kind: kind, prompt_version: variable.prompt_version, company_key: lead.company_key ?? null };
  const template = kind === "people" ? variable.people_prompt : variable.general_prompt;
  if (!text(template)) {
    const note = `${copyTag(variable.name)} has no ${kind === "people" ? "People" : "General"} question prompt`;
    return { kind: "skipped", row: { ...row, status: "skipped", note, cost_usd: 0 }, cost: 0, researched: 0 };
  }
  if (!lead.company_key) {
    const note = "No company or website to research";
    return { kind: "skipped", row: { ...row, status: "skipped", note, cost_usd: 0 }, cost: 0, researched: 0 };
  }

  // One research a company per slice, shared by its leads: the first asks, the others wait for that answer.
  let mine = false;
  let pending = memo.get(lead.company_key);
  if (!pending) {
    mine = true;
    pending = researchFor(deps, { variable, lead, companyKey: lead.company_key, serviceArea, qs, settings });
    memo.set(lead.company_key, pending);
  }
  const res = await pending;
  const researchCost = mine ? Number(res.cost) || 0 : 0;
  const researched = mine && res.researched ? 1 : 0;
  if (res.stop) return { kind: "stop", note: res.stop, cost: researchCost, researched };
  if (!res.ok) {
    return {
      kind: "failed", again: res.retry === true, note: res.note, cost: researchCost, researched,
      row: { ...row, status: "error", note: res.note, cost_usd: 0 },
    };
  }

  const q = await questionFor(deps, { variable, lead, kind, research: res.research, serviceArea, qs, settings });
  const cost = researchCost + (Number(q.cost) || 0);
  if (q.stop) return { kind: "stop", note: q.stop, cost, researched };
  if (!q.status) {
    return {
      kind: "failed", again: q.retry === true, note: q.note, cost, researched,
      row: { ...row, status: "error", note: q.note, cost_usd: Number(q.cost) || 0 },
    };
  }
  return {
    kind: q.status,
    cost,
    researched,
    row: { ...row, status: q.status, value: q.value, raw: q.raw, words: q.words, note: q.note, model: q.model, cost_usd: Number(q.cost) || 0 },
  };
}
