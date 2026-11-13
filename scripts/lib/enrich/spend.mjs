// What the pipeline spends in a UTC day (enrich_spend_daily, migration 125),
// against enrich_settings.spend_caps (settings.mjs):
//
//   reoon_checks         Reoon checks made by the pipeline's own steps (G#39,
//                        P#11 and the AI Ark email check on the company row),
//                        at most spend_caps.reoon_checks_per_day (1,500): the
//                        pipeline's share of the account the validation worker
//                        also spends (D44).
//   openai_usd_pipeline  dollars of OpenAI for the company, inbox and people AI
//                        columns, at most spend_caps.openai_usd_per_day.pipeline.
//   openai_usd_fit       dollars of OpenAI for the fit scorer, re-scores and the
//                        scoring run, at most spend_caps.openai_usd_per_day.fit.
//
// A paid step asks before its call (spendAllowed, or takeReoonCheck, which
// counts the check in the same statement) and, for OpenAI, adds what the call
// cost after it (addOpenAiSpend, from the usage OpenAI returned). Past a cap
// the cell waits and the hourly sweep picks it up the next UTC day.
//
// A day is the UTC day of the database's clock, so every process agrees.

import { SETTINGS_DEFAULTS } from "./settings.mjs";

export const SPEND_KINDS = ["reoon_checks", "openai_usd_pipeline", "openai_usd_fit"];
/** The OpenAI loops a cap is kept for: the pipeline's AI columns, and fit scoring. */
export const OPENAI_LOOPS = ["pipeline", "fit"];

const TODAY = `(now() AT TIME ZONE 'utc')::date`;

/** Why a cell waits when its cap is reached. Shown on the cell and the tab. */
export const CAP_REACHED = Object.freeze({
  reoon_checks: "Today's Reoon share is used up",
  openai_usd_pipeline: "Today's OpenAI cap for the pipeline is reached",
  openai_usd_fit: "Today's OpenAI cap for fit scoring is reached",
});

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[], rowCount?: number | null }> }} Db
 * @typedef {import("./settings.mjs").PipelineSettings} PipelineSettings
 */

/**
 * Today's cap for one kind.
 *
 * @param {string} kind  one of SPEND_KINDS
 * @param {Pick<PipelineSettings, "spend_caps"> | null | undefined} settings
 * @returns {number}
 */
export function capFor(kind, settings) {
  const caps = settings?.spend_caps ?? SETTINGS_DEFAULTS.spend_caps;
  switch (kind) {
    case "reoon_checks":
      return caps.reoon_checks_per_day;
    case "openai_usd_pipeline":
      return caps.openai_usd_per_day.pipeline;
    case "openai_usd_fit":
      return caps.openai_usd_per_day.fit;
    default:
      throw new Error(`Unknown spend kind "${kind}"`);
  }
}

/**
 * What the pipeline has spent today, per kind (0 when nothing yet).
 *
 * @param {Db} db
 * @returns {Promise<{ reoon_checks: number, openai_usd_pipeline: number, openai_usd_fit: number }>}
 */
export async function spentToday(db) {
  const { rows } = await db.query(
    `SELECT kind, used FROM enrich_spend_daily WHERE day = ${TODAY} AND kind = ANY($1::text[])`,
    [SPEND_KINDS]
  );
  const out = { reoon_checks: 0, openai_usd_pipeline: 0, openai_usd_fit: 0 };
  for (const r of rows) out[/** @type {keyof typeof out} */ (r.kind)] = Number(r.used);
  return out;
}

/**
 * May a paid call of this kind be made now? A read: it counts nothing.
 * { ok: true, used, cap } or { ok: false, used, cap, why }.
 *
 * @param {Db} db
 * @param {string} kind  one of SPEND_KINDS
 * @param {Pick<PipelineSettings, "spend_caps"> | null | undefined} settings
 * @returns {Promise<{ ok: boolean, used: number, cap: number, why?: string }>}
 */
export async function spendAllowed(db, kind, settings) {
  const cap = capFor(kind, settings);
  const { rows } = await db.query(`SELECT used FROM enrich_spend_daily WHERE day = ${TODAY} AND kind = $1`, [kind]);
  const used = Number(rows[0]?.used ?? 0);
  if (used < cap) return { ok: true, used, cap };
  return { ok: false, used, cap, why: CAP_REACHED[/** @type {keyof typeof CAP_REACHED} */ (kind)] };
}

/**
 * Takes one of today's Reoon checks, in one statement: true when it was
 * counted (there was room under spend_caps.reoon_checks_per_day), false when
 * today's share is used up. Two workers can't both take the last one.
 *
 * @param {Db} db
 * @param {Pick<PipelineSettings, "spend_caps"> | null | undefined} settings
 * @returns {Promise<boolean>}
 */
export async function takeReoonCheck(db, settings) {
  const cap = capFor("reoon_checks", settings);
  if (!(cap > 0)) return false;
  const { rows } = await db.query(
    `INSERT INTO enrich_spend_daily AS s (day, kind, used, updated_at)
     VALUES (${TODAY}, 'reoon_checks', 1, now())
     ON CONFLICT (day, kind) DO UPDATE SET used = s.used + 1, updated_at = now()
      WHERE s.used < $1
     RETURNING used`,
    [cap]
  );
  return rows.length > 0;
}

/**
 * What one OpenAI call cost, in dollars, from the usage it returned:
 * input tokens (plus each search's fixed search tokens, for a model that bills
 * them that way) at the model's input price, output tokens (reasoning tokens
 * are part of them) at its output price, and each web search call at
 * web_search_call. A model with no price is counted at the dearest prices
 * held, so an unknown model is never counted as cheap; priced is then false.
 *
 * @param {{ model: string, usage?: { input_tokens?: number, output_tokens?: number } | null, searches?: number }} call
 * @param {Record<string, any> | null | undefined} prices  settings.spend_caps.openai_prices
 * @returns {{ usd: number, priced: boolean }}
 */
export function openAiCost({ model, usage, searches = 0 }, prices) {
  const table = prices ?? SETTINGS_DEFAULTS.spend_caps.openai_prices;
  const known = Object.entries(table).filter(([k, v]) => k !== "web_search_call" && v && typeof v === "object").map(([, v]) => v);
  let p = model && model !== "web_search_call" ? table[model] : null;
  const priced = Boolean(p && typeof p === "object");
  if (!priced) {
    p = {
      in: Math.max(0, ...known.map((v) => Number(v.in) || 0)),
      out: Math.max(0, ...known.map((v) => Number(v.out) || 0)),
      search_tokens: Math.max(0, ...known.map((v) => Number(v.search_tokens) || 0)),
    };
  }
  const n = Math.max(0, Number(searches) || 0);
  const tokensIn = Math.max(0, Number(usage?.input_tokens) || 0) + n * (Number(p.search_tokens) || 0);
  const tokensOut = Math.max(0, Number(usage?.output_tokens) || 0);
  const perSearch = Number(table.web_search_call);
  const usd =
    (tokensIn * Number(p.in)) / 1e6 +
    (tokensOut * Number(p.out)) / 1e6 +
    n * (Number.isFinite(perSearch) ? perSearch : SETTINGS_DEFAULTS.spend_caps.openai_prices.web_search_call);
  return { usd: Math.round(usd * 1e6) / 1e6, priced };
}

/**
 * Adds what one OpenAI call cost to today's total for its loop. Called after
 * every call that was answered, whatever the answer, since OpenAI bills it.
 *
 * @param {Db} db
 * @param {"pipeline" | "fit"} loop
 * @param {{ model: string, usage?: { input_tokens?: number, output_tokens?: number } | null, searches?: number }} call
 * @param {Record<string, any> | null | undefined} prices  settings.spend_caps.openai_prices
 * @returns {Promise<{ usd: number, priced: boolean, used: number }>}  used: today's total for the loop after this call
 */
export async function addOpenAiSpend(db, loop, call, prices) {
  if (!OPENAI_LOOPS.includes(loop)) throw new Error(`Unknown OpenAI loop "${loop}"`);
  const { usd, priced } = openAiCost(call, prices);
  const { rows } = await db.query(
    `INSERT INTO enrich_spend_daily AS s (day, kind, used, updated_at)
     VALUES (${TODAY}, $1, $2::numeric, now())
     ON CONFLICT (day, kind) DO UPDATE SET used = s.used + EXCLUDED.used, updated_at = now()
     RETURNING used`,
    [`openai_usd_${loop}`, String(usd)]
  );
  return { usd, priced, used: Number(rows[0]?.used ?? usd) };
}
