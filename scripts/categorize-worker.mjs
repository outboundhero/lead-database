#!/usr/bin/env node
// categorize-worker.mjs — classify leads into the lead_categories taxonomy.
//
// Tiered cascade (cheap -> expensive):
//   Tier 0  keyword match: category keywords against company/question/domain.
//           Free, resolves the majority (trade names usually contain the trade).
//   Tier 1  Claude Haiku classification for what keywords couldn't place.
//           Batched 25 leads/call, structured outputs (guaranteed-valid JSON),
//           taxonomy in a cached system prompt. Gated on ANTHROPIC_API_KEY —
//           without a key the worker is keyword-only and leaves the rest NULL
//           (same gating pattern as the Reoon validation key).
//
// Manual assignments (category_source='manual') are never overwritten.
//
// Usage:
//   node scripts/categorize-worker.mjs                 categorize uncategorized leads
//   node scripts/categorize-worker.mjs --dry-run       classify but don't write
//   node scripts/categorize-worker.mjs --keyword-only  skip the AI tier
//   node scripts/categorize-worker.mjs --recheck-all   redo ai/keyword rows too (not manual)
//   node scripts/categorize-worker.mjs --limit 500     cap leads this run
//
// Env:
//   DATABASE_URL           required — Supabase pooler URL
//   ANTHROPIC_API_KEY      optional — enables the AI tier
//   CATEGORIZE_MODEL       optional — default claude-haiku-4-5
//   CATEGORIZE_AI_BATCH    optional — leads per AI call (default 25)
//   CATEGORIZE_PAGE        optional — leads per DB page (default 1000)
//
// Railway: run as a cron service (schedule e.g. 0 * * * *) with start command
// `node scripts/categorize-worker.mjs` — new leads get categorized every run.

import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const KEYWORD_ONLY = args.includes("--keyword-only");
const RECHECK_ALL = args.includes("--recheck-all");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? parseInt(args[i + 1], 10) : Infinity;
})();

const MODEL = process.env.CATEGORIZE_MODEL || "claude-haiku-4-5";
const AI_BATCH = parseInt(process.env.CATEGORIZE_AI_BATCH ?? "25", 10);
const PAGE = parseInt(process.env.CATEGORIZE_PAGE ?? "1000", 10);
const OTHER = "Other";

// ─── Tier 0: keyword matcher ────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatchers(categories) {
  return categories.map((c) => ({
    name: c.name,
    regexes: c.keywords.map((k) => new RegExp(`\\b${escapeRegex(k)}\\b`, "i")),
  }));
}

// Score each category: company-name hits weigh 3 (a trade in the name is a
// near-certain signal), question/domain hits weigh 1. Assign only when there
// is a single strict winner; ties and zero-scores escalate to the AI tier.
function classifyByKeywords(lead, matchers) {
  const company = lead.company ?? "";
  const question = lead.question ?? "";
  const domain = lead.domain ?? "";
  let best = null;
  let bestScore = 0;
  let tied = false;
  let bestCompanyHit = false;

  for (const m of matchers) {
    let score = 0;
    let companyHit = false;
    for (const re of m.regexes) {
      if (re.test(company)) { score += 3; companyHit = true; }
      if (re.test(question)) score += 1;
      if (re.test(domain)) score += 1;
    }
    if (score > bestScore) {
      best = m.name; bestScore = score; tied = false; bestCompanyHit = companyHit;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  if (bestScore === 0 || tied) return null;
  return { category: best, confidence: bestCompanyHit ? 0.9 : 0.7 };
}

// ─── Tier 1: Claude Haiku classification ────────────────────────────────────

function buildSystemPrompt(categories) {
  const lines = categories.map(
    (c) => `- ${c.name}: ${c.keywords.join(", ")}${c.description ? ` (${c.description})` : ""}`
  );
  return `You classify B2B leads into business categories.

Categories (with example keywords):
${lines.join("\n")}
- ${OTHER}: use when none of the categories fit.

For each numbered lead you receive (company name, a personalization line about the business, and its website domain), pick exactly one category from the list above. Judge what the BUSINESS does, not the words alone. Report a confidence between 0 and 1.`;
}

function buildSchema(categoryNames) {
  return {
    type: "object",
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            index: { type: "integer" },
            category: { type: "string", enum: [...categoryNames, OTHER] },
            confidence: { type: "number" },
          },
          required: ["index", "category", "confidence"],
          additionalProperties: false,
        },
      },
    },
    required: ["results"],
    additionalProperties: false,
  };
}

async function classifyByAI(anthropic, leads, systemPrompt, schema) {
  const numbered = leads
    .map(
      (l, i) =>
        `${i}. company: ${l.company ?? "-"} | about: ${(l.question ?? "-").slice(0, 200)} | domain: ${l.domain ?? "-"}`
    )
    .join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Classify these leads:\n${numbered}` }],
    output_config: { format: { type: "json_schema", schema } },
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error("AI response truncated (max_tokens) — lower CATEGORIZE_AI_BATCH");
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const { results } = JSON.parse(text);
  const usage = response.usage;
  return { results: results ?? [], usage };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function persist(client, rows) {
  if (rows.length === 0) return;
  await client.query(
    `UPDATE leads SET
       category = v.category,
       category_confidence = v.confidence,
       category_source = v.source,
       categorized_at = now(),
       updated_at = now()
     FROM (
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::real[], $4::text[])
         AS t(id, category, confidence, source)
     ) v
     WHERE leads.id = v.id`,
    [
      rows.map((r) => r.id),
      rows.map((r) => r.category),
      rows.map((r) => r.confidence),
      rows.map((r) => r.source),
    ]
  );
}

async function refreshCategoryFilterCache(client) {
  await client.query(
    `INSERT INTO filter_options_cache (col_name, options, updated_at)
     SELECT 'category', COALESCE(ARRAY(
       SELECT DISTINCT TRIM(category) FROM leads
       WHERE category IS NOT NULL AND TRIM(category) <> ''
       ORDER BY 1
     ), '{}'), now()
     ON CONFLICT (col_name)
     DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at`
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const aiEnabled = !KEYWORD_ONLY && !!process.env.ANTHROPIC_API_KEY;
  const anthropic = aiEnabled ? new Anthropic() : null;

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: categories } = await client.query(
    "SELECT name, keywords, description FROM lead_categories ORDER BY name"
  );
  if (categories.length === 0) {
    console.error("No taxonomy in lead_categories — seed it first (scripts/seed-categories.mjs).");
    await client.end();
    process.exit(1);
  }

  const matchers = buildMatchers(categories);
  const systemPrompt = buildSystemPrompt(categories);
  const schema = buildSchema(categories.map((c) => c.name));

  console.log(
    `categorize-worker: ${categories.length} categories, model=${aiEnabled ? MODEL : "(keyword only)"}${DRY_RUN ? " DRY RUN" : ""}${RECHECK_ALL ? " RECHECK-ALL" : ""}`
  );

  const whereClause = RECHECK_ALL
    ? "(category_source IS DISTINCT FROM 'manual')"
    : "category IS NULL";

  const counts = { keyword: 0, ai: 0, other: 0, unresolved: 0, errors: 0 };
  let aiInputTokens = 0;
  let aiOutputTokens = 0;
  let lastId = "00000000-0000-0000-0000-000000000000";
  let processed = 0;

  while (processed < LIMIT) {
    const { rows: leads } = await client.query(
      `SELECT id, company, question, domain FROM leads
       WHERE ${whereClause} AND id > $1
       ORDER BY id LIMIT $2`,
      [lastId, Math.min(PAGE, LIMIT - processed)]
    );
    if (leads.length === 0) break;
    lastId = leads[leads.length - 1].id;
    processed += leads.length;

    // Tier 0 — keywords
    const resolved = [];
    const aiQueue = [];
    for (const lead of leads) {
      const hit = classifyByKeywords(lead, matchers);
      if (hit) {
        resolved.push({ id: lead.id, category: hit.category, confidence: hit.confidence, source: "keyword" });
        counts.keyword++;
      } else {
        aiQueue.push(lead);
      }
    }

    // Tier 1 — Claude Haiku
    if (aiEnabled && aiQueue.length > 0) {
      for (let i = 0; i < aiQueue.length; i += AI_BATCH) {
        const chunk = aiQueue.slice(i, i + AI_BATCH);
        try {
          const { results, usage } = await classifyByAI(anthropic, chunk, systemPrompt, schema);
          aiInputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          aiOutputTokens += usage.output_tokens ?? 0;
          const byIndex = new Map(results.map((r) => [r.index, r]));
          chunk.forEach((lead, j) => {
            const r = byIndex.get(j);
            if (!r) { counts.unresolved++; return; }
            resolved.push({
              id: lead.id,
              category: r.category,
              confidence: Math.max(0, Math.min(1, r.confidence)),
              source: "ai",
            });
            if (r.category === OTHER) counts.other++;
            else counts.ai++;
          });
        } catch (err) {
          counts.errors++;
          counts.unresolved += chunk.length;
          console.error(`  AI chunk failed (${chunk.length} leads): ${err.message} — will retry next run`);
        }
      }
    } else {
      counts.unresolved += aiQueue.length;
    }

    if (!DRY_RUN) await persist(client, resolved);
    console.log(
      `  page done: ${processed} scanned | keyword=${counts.keyword} ai=${counts.ai} other=${counts.other} unresolved=${counts.unresolved}`
    );

    // Dry runs never write, so the "category IS NULL" scan doesn't shrink —
    // keyset pagination (id > lastId) still advances. Nothing extra needed.
  }

  if (!DRY_RUN && (counts.keyword || counts.ai || counts.other)) {
    await refreshCategoryFilterCache(client);
  }

  const estCost = (aiInputTokens / 1e6) * 1 + (aiOutputTokens / 1e6) * 5; // Haiku 4.5 $1/$5 per MTok
  console.log(
    `categorize-worker done: keyword=${counts.keyword} ai=${counts.ai} other=${counts.other} unresolved=${counts.unresolved} errors=${counts.errors}` +
      (aiEnabled ? ` | AI tokens in=${aiInputTokens} out=${aiOutputTokens} (~$${estCost.toFixed(2)})` : "")
  );
  await client.end();
}

main().catch((err) => {
  console.error("categorize-worker fatal:", err);
  process.exit(1);
});
