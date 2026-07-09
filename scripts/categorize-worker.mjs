#!/usr/bin/env node
// categorize-worker.mjs — FALLBACK category enrichment, cached per company.
//
// Bison is the PRIMARY category source: leads arrive with category /
// subcategory / additional category personalization variables which the import
// ingests directly (category_source='bison'). This worker only handles leads
// that arrived WITHOUT category data, and it works at the COMPANY level so a
// company name that has ever been categorized — by Bison or by this worker —
// is never re-processed:
//
//   Step 1  fn_sync_companies(): upsert companies (name+city+state identity),
//           seed company categories from categorized leads, propagate cached
//           company categories to uncategorized leads.  All free.
//   Step 2  Companies still uncategorized -> keyword tier (taxonomy keywords
//           vs company name / domain / sample question).  Free.
//   Step 3  Remainder -> Claude Haiku, 25 companies per call, structured
//           outputs restricted to the taxonomy names (or 'Other').
//           Gated on ANTHROPIC_API_KEY (no key = keyword-only).
//   Step 4  fn_sync_companies() again -> propagate the new company categories
//           to all their leads; refresh the filter dropdown cache.
//   Step 5  Leads with NO company name (rare) get classified individually.
//
// Manual assignments (category_source='manual') are never overwritten.
//
// Usage:
//   node scripts/categorize-worker.mjs                 run
//   node scripts/categorize-worker.mjs --dry-run       classify but don't write
//   node scripts/categorize-worker.mjs --keyword-only  skip the AI tier
//   node scripts/categorize-worker.mjs --limit 500     cap companies this run
//
// Env:
//   DATABASE_URL           required — Supabase pooler URL
//   ANTHROPIC_API_KEY      optional — enables the AI tier
//   CATEGORIZE_MODEL       optional — default claude-haiku-4-5
//   CATEGORIZE_AI_BATCH    optional — companies per AI call (default 25)
//   CATEGORIZE_PAGE        optional — companies per DB page (default 1000)
//
// Railway: run as a cron service (e.g. 0 * * * *) with start command
// `node scripts/categorize-worker.mjs`.

import pg from "pg";
import Anthropic from "@anthropic-ai/sdk";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const KEYWORD_ONLY = args.includes("--keyword-only");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  return i >= 0 ? parseInt(args[i + 1], 10) : Infinity;
})();

const MODEL = process.env.CATEGORIZE_MODEL || "claude-haiku-4-5";
const AI_BATCH = parseInt(process.env.CATEGORIZE_AI_BATCH ?? "25", 10);
const PAGE = parseInt(process.env.CATEGORIZE_PAGE ?? "1000", 10);
const OTHER = "Other";

// ─── Keyword tier ────────────────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildMatchers(categories) {
  return categories.map((c) => ({
    name: c.name,
    regexes: c.keywords.map((k) => new RegExp(`\\b${escapeRegex(k)}\\b`, "i")),
  }));
}

// Name hits weigh 3 (a trade in the company name is a near-certain signal),
// question/domain hits weigh 1. Assign only on a single strict winner.
function classifyByKeywords(subject, matchers) {
  const name = subject.name ?? "";
  const question = subject.question ?? "";
  const domain = subject.domain ?? "";
  let best = null;
  let bestScore = 0;
  let tied = false;
  let bestNameHit = false;

  for (const m of matchers) {
    let score = 0;
    let nameHit = false;
    for (const re of m.regexes) {
      if (re.test(name)) { score += 3; nameHit = true; }
      if (re.test(question)) score += 1;
      if (re.test(domain)) score += 1;
    }
    if (score > bestScore) {
      best = m.name; bestScore = score; tied = false; bestNameHit = nameHit;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  if (bestScore === 0 || tied) return null;
  return { category: best, confidence: bestNameHit ? 0.9 : 0.7 };
}

// ─── AI tier ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(categories) {
  const lines = categories.map(
    (c) => `- ${c.name}: ${c.keywords.join(", ")}${c.description ? ` (${c.description})` : ""}`
  );
  return `You classify businesses into categories.

Categories (with example keywords):
${lines.join("\n")}
- ${OTHER}: use when none of the categories fit.

For each numbered business you receive (company name, an optional line about the business, and its website domain), pick exactly one category from the list above. Judge what the BUSINESS does, not the words alone. Report a confidence between 0 and 1.`;
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

async function classifyByAI(anthropic, subjects, systemPrompt, schema) {
  const numbered = subjects
    .map(
      (s, i) =>
        `${i}. company: ${s.name ?? "-"} | about: ${(s.question ?? "-").slice(0, 200)} | domain: ${s.domain ?? "-"}`
    )
    .join("\n");

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Classify these businesses:\n${numbered}` }],
    output_config: { format: { type: "json_schema", schema } },
  });

  if (response.stop_reason === "max_tokens") {
    throw new Error("AI response truncated (max_tokens) — lower CATEGORIZE_AI_BATCH");
  }
  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
  const { results } = JSON.parse(text);
  return { results: results ?? [], usage: response.usage };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function persistCompanies(client, rows) {
  if (rows.length === 0) return;
  await client.query(
    `UPDATE companies SET
       category = v.category,
       category_source = v.source,
       categorized_at = now()
     FROM (
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[])
         AS t(id, category, source)
     ) v
     WHERE companies.id = v.id AND companies.category IS NULL`,
    [rows.map((r) => r.id), rows.map((r) => r.category), rows.map((r) => r.source)]
  );
}

async function persistLeads(client, rows) {
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

async function refreshFilterCache(client) {
  for (const col of ["category", "subcategory"]) {
    await client.query(
      `INSERT INTO filter_options_cache (col_name, options, updated_at)
       SELECT '${col}', COALESCE(ARRAY(
         SELECT DISTINCT TRIM(${col}) FROM leads
         WHERE ${col} IS NOT NULL AND TRIM(${col}) <> ''
         ORDER BY 1
       ), '{}'), now()
       ON CONFLICT (col_name)
       DO UPDATE SET options = EXCLUDED.options, updated_at = EXCLUDED.updated_at`
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function syncCompanies(client, label) {
  const { rows } = await client.query("SELECT * FROM fn_sync_companies()");
  const r = rows[0];
  console.log(
    `  sync (${label}): companies+${r.companies_inserted} seeded=${r.companies_seeded} leads-propagated=${r.leads_propagated}`
  );
}

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
    console.error("No taxonomy in lead_categories — seed it first (npm run seed-categories).");
    await client.end();
    process.exit(1);
  }

  const matchers = buildMatchers(categories);
  const systemPrompt = buildSystemPrompt(categories);
  const schema = buildSchema(categories.map((c) => c.name));

  console.log(
    `categorize-worker: ${categories.length} categories, model=${aiEnabled ? MODEL : "(keyword only)"}${DRY_RUN ? " DRY RUN" : ""}`
  );

  // Step 1 — cache pass: sync companies, seed from Bison, propagate cache hits.
  if (!DRY_RUN) await syncCompanies(client, "pre");

  // Step 2+3 — classify companies that are still uncategorized.
  const counts = { keyword: 0, ai: 0, other: 0, unresolved: 0, errors: 0 };
  let aiInputTokens = 0;
  let aiOutputTokens = 0;
  let lastId = "00000000-0000-0000-0000-000000000000";
  let processed = 0;

  while (processed < LIMIT) {
    const { rows: companies } = await client.query(
      `SELECT c.id, c.name, c.domain,
              (SELECT l.question FROM leads l
               WHERE l.company IS NOT NULL
                 AND lower(TRIM(l.company)) = lower(TRIM(c.name))
                 AND l.question IS NOT NULL
               LIMIT 1) AS question
       FROM companies c
       WHERE c.category IS NULL AND c.id > $1
       ORDER BY c.id LIMIT $2`,
      [lastId, Math.min(PAGE, LIMIT - processed)]
    );
    if (companies.length === 0) break;
    lastId = companies[companies.length - 1].id;
    processed += companies.length;

    const resolved = [];
    const aiQueue = [];
    for (const company of companies) {
      const hit = classifyByKeywords(company, matchers);
      if (hit) {
        resolved.push({ id: company.id, category: hit.category, source: "keyword" });
        counts.keyword++;
      } else {
        aiQueue.push(company);
      }
    }

    if (aiEnabled && aiQueue.length > 0) {
      for (let i = 0; i < aiQueue.length; i += AI_BATCH) {
        const chunk = aiQueue.slice(i, i + AI_BATCH);
        try {
          const { results, usage } = await classifyByAI(anthropic, chunk, systemPrompt, schema);
          aiInputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          aiOutputTokens += usage.output_tokens ?? 0;
          const byIndex = new Map(results.map((r) => [r.index, r]));
          chunk.forEach((company, j) => {
            const r = byIndex.get(j);
            if (!r) { counts.unresolved++; return; }
            resolved.push({ id: company.id, category: r.category, source: "ai" });
            if (r.category === OTHER) counts.other++;
            else counts.ai++;
          });
        } catch (err) {
          counts.errors++;
          counts.unresolved += chunk.length;
          console.error(`  AI chunk failed (${chunk.length} companies): ${err.message} — will retry next run`);
        }
      }
    } else {
      counts.unresolved += aiQueue.length;
    }

    if (!DRY_RUN) await persistCompanies(client, resolved);
    console.log(
      `  companies: ${processed} scanned | keyword=${counts.keyword} ai=${counts.ai} other=${counts.other} unresolved=${counts.unresolved}`
    );
  }

  // Step 4 — propagate new company categories to their leads + refresh dropdowns.
  if (!DRY_RUN) {
    await syncCompanies(client, "post");
    await refreshFilterCache(client);
  }

  // Step 5 — leads with no company name can't use the company cache; classify
  // individually (keyword tier only unless AI enabled).
  const { rows: orphans } = await client.query(
    `SELECT id, company AS name, question, domain FROM leads
     WHERE category IS NULL AND (company IS NULL OR TRIM(company) = '')
     LIMIT 5000`
  );
  if (orphans.length > 0) {
    const resolved = [];
    const aiQueue = [];
    for (const lead of orphans) {
      const hit = classifyByKeywords(lead, matchers);
      if (hit) resolved.push({ id: lead.id, category: hit.category, confidence: hit.confidence, source: "keyword" });
      else aiQueue.push(lead);
    }
    if (aiEnabled) {
      for (let i = 0; i < aiQueue.length; i += AI_BATCH) {
        const chunk = aiQueue.slice(i, i + AI_BATCH);
        try {
          const { results, usage } = await classifyByAI(anthropic, chunk, systemPrompt, schema);
          aiInputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
          aiOutputTokens += usage.output_tokens ?? 0;
          const byIndex = new Map(results.map((r) => [r.index, r]));
          chunk.forEach((lead, j) => {
            const r = byIndex.get(j);
            if (r) resolved.push({ id: lead.id, category: r.category, confidence: Math.max(0, Math.min(1, r.confidence)), source: "ai" });
          });
        } catch (err) {
          counts.errors++;
          console.error(`  AI chunk failed (${chunk.length} company-less leads): ${err.message}`);
        }
      }
    }
    if (!DRY_RUN) await persistLeads(client, resolved);
    console.log(`  company-less leads classified: ${resolved.length}/${orphans.length}`);
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
