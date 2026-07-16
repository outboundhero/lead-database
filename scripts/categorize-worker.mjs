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
//   Step 3  Remainder -> AI (gpt-4o-mini by default, or Claude Haiku), 25
//           companies per call, strict JSON schema restricted to the taxonomy
//           names (or 'Other'). Gated on OPENAI_API_KEY / ANTHROPIC_API_KEY
//           (no key = keyword-only).
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
//   CATEGORIZE_LIMIT       optional — max companies per run (default 50000)
//   OPENAI_API_KEY         optional — enables the AI tier (gpt-4o-mini)
//   ANTHROPIC_API_KEY      optional — alternative provider (claude-haiku-4-5)
//   CATEGORIZE_PROVIDER    optional — force 'openai' or 'anthropic'
//   CATEGORIZE_MODEL       optional — override the model id
//   CATEGORIZE_AI_BATCH    optional — companies per AI call (default 25)
//   CATEGORIZE_PAGE        optional — companies per DB page (default 1000)
//
// Railway: run as a cron service (e.g. 0 * * * *) with start command
// `node scripts/categorize-worker.mjs`.

import pg from "pg";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const KEYWORD_ONLY = args.includes("--keyword-only");
// Cap per run: --limit flag, else CATEGORIZE_LIMIT, else 50k companies — never
// unbounded (the uncategorized backlog can exceed 1M companies).
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  const raw = i >= 0 ? args[i + 1] : process.env.CATEGORIZE_LIMIT ?? "50000";
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Invalid --limit / CATEGORIZE_LIMIT value: ${raw ?? "(missing)"}`);
    process.exit(1);
  }
  return n;
})();

// Lease-row lock (worker_locks table) so overlapping cron runs exit cleanly.
// Deliberately NOT a pg advisory lock: DATABASE_URL is the transaction-mode
// pooler (port 6543), where session-scoped locks stick to arbitrary pooled
// backends — a crashed run could poison a backend and disable the worker
// permanently. A lease row is pooler-safe and self-expires.
const LOCK_KEY = "categorize-worker";
const LOCK_LEASE = "2 hours";
const LOCK_OWNER = randomUUID();

async function acquireLock(client) {
  const { rows } = await client.query(
    `INSERT INTO worker_locks (key, owner, locked_until)
     VALUES ($1, $2, now() + $3::interval)
     ON CONFLICT (key) DO UPDATE
       SET owner = EXCLUDED.owner, locked_until = EXCLUDED.locked_until
       WHERE worker_locks.locked_until < now()
     RETURNING owner`,
    [LOCK_KEY, LOCK_OWNER, LOCK_LEASE]
  );
  return rows.length > 0;
}

async function releaseLock(client) {
  try {
    await client.query("DELETE FROM worker_locks WHERE key = $1 AND owner = $2", [LOCK_KEY, LOCK_OWNER]);
  } catch { /* lease expires on its own */ }
}

// Provider: OpenAI (gpt-4o-mini, default when OPENAI_API_KEY is set) or
// Anthropic (claude-haiku-4-5). Force with CATEGORIZE_PROVIDER=openai|anthropic.
const PROVIDER =
  process.env.CATEGORIZE_PROVIDER ||
  (process.env.OPENAI_API_KEY ? "openai" : "anthropic");
const MODEL =
  process.env.CATEGORIZE_MODEL ||
  (PROVIDER === "openai" ? "gpt-4o-mini" : "claude-haiku-4-5");
const AI_BATCH = parseInt(process.env.CATEGORIZE_AI_BATCH ?? "25", 10);
const PAGE = parseInt(process.env.CATEGORIZE_PAGE ?? "1000", 10);
const OTHER = "Other";

// ─── Keyword tier ────────────────────────────────────────────────────────────

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One combined alternation regex per category (fast at 2,700+ keywords across
// millions of companies: ~40 regex tests per field instead of ~2,700).
// Lookarounds instead of \b: \b silently fails when a keyword starts/ends with
// a non-word char ('café', 'c++', '... (soy, oat, almond)'). Global flag so
// classifyByKeywords can see WHICH keywords matched, not just that one did.
function buildMatchers(categories) {
  return categories
    .filter((c) => c.keywords.length > 0)
    .map((c) => ({
      name: c.name,
      regex: new RegExp(
        `(?<![\\w])(?:${c.keywords.map(escapeRegex).join("|")})(?![\\w])`,
        "gi"
      ),
    }));
}

// Name hits weigh 3 (a trade in the company name is a near-certain signal),
// question/domain hits weigh 1. Assign only on a single strict winner whose
// evidence includes a keyword of length >= 4 or 2+ distinct keywords — a lone
// hit on a short junk token ('cc', 's4') is left for the AI tier.
function classifyByKeywords(subject, matchers) {
  const fields = [
    [subject.name ?? "", 3],
    [subject.question ?? "", 1],
    [subject.domain ?? "", 1],
  ];
  let best = null;
  let bestScore = 0;
  let tied = false;
  let bestKeywords = null;

  for (const m of matchers) {
    let score = 0;
    const hits = new Set();
    for (const [text, weight] of fields) {
      const found = text.match(m.regex);
      if (found) {
        score += weight;
        for (const h of found) hits.add(h.toLowerCase());
      }
    }
    if (score > bestScore) {
      best = m.name; bestScore = score; tied = false; bestKeywords = hits;
    } else if (score === bestScore && score > 0) {
      tied = true;
    }
  }

  if (bestScore === 0 || tied) return null;
  const strongEvidence =
    bestKeywords.size >= 2 || [...bestKeywords].some((k) => k.length >= 4);
  if (!strongEvidence) return null;
  const confidence = Math.min(
    0.95,
    0.6 + 0.1 * bestScore + 0.05 * (bestKeywords.size - 1)
  );
  return { category: best, confidence };
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

function numberedList(subjects) {
  return subjects
    .map(
      (s, i) =>
        `${i}. company: ${s.name ?? "-"} | about: ${(s.question ?? "-").slice(0, 200)} | domain: ${s.domain ?? "-"}`
    )
    .join("\n");
}

// Both providers enforce the same strict JSON schema, so the model can only
// answer with taxonomy category names (or 'Other') — never invented labels.
// Returns { results, usage: { input, output } }.
async function classifyByAI(anthropic, subjects, systemPrompt, schema) {
  const numbered = numberedList(subjects);

  if (PROVIDER === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Classify these businesses:\n${numbered}` },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "classification", strict: true, schema },
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
    }
    const json = await res.json();
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new Error("AI response truncated (max_tokens) — lower CATEGORIZE_AI_BATCH");
    }
    const { results } = JSON.parse(choice?.message?.content ?? "{}");
    return {
      results: results ?? [],
      usage: { input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0 },
    };
  }

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
  const u = response.usage;
  return {
    results: results ?? [],
    usage: {
      input: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
    },
  };
}

// Model output is untrusted: only integer indexes in [0, n) count, duplicated
// indexes are dropped entirely (can't tell which copy is right), and mismatches
// are logged. Subjects with no usable result stay unresolved for the next run.
function indexResults(results, n, label) {
  const byIndex = new Map();
  let invalid = 0;
  for (const r of results) {
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= n) {
      invalid++;
      continue;
    }
    if (byIndex.has(r.index)) {
      byIndex.set(r.index, null);
      invalid++;
      continue;
    }
    byIndex.set(r.index, r);
  }
  for (const [k, v] of byIndex) if (v === null) byIndex.delete(k);
  if (invalid > 0 || byIndex.size < n) {
    console.error(
      `  AI index mismatch (${label}): ${byIndex.size}/${n} usable results, ${invalid} invalid/duplicate indexes`
    );
  }
  return byIndex;
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
  const aiKey = PROVIDER === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  const aiEnabled = !KEYWORD_ONLY && !!aiKey;
  const anthropic = aiEnabled && PROVIDER === "anthropic" ? new Anthropic() : null;

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  if (!(await acquireLock(client))) {
    console.log("categorize-worker: previous run still holds the lock lease — exiting.");
    await client.end();
    return;
  }

  const { rows: categories } = await client.query(
    "SELECT name, keywords, description FROM lead_categories ORDER BY name"
  );
  if (categories.length === 0) {
    console.error("No taxonomy in lead_categories — seed it first (npm run seed-categories).");
    await releaseLock(client);
    await client.end();
    process.exit(1);
  }

  const matchers = buildMatchers(categories);
  const systemPrompt = buildSystemPrompt(categories);
  const schema = buildSchema(categories.map((c) => c.name));

  console.log(
    `categorize-worker: ${categories.length} categories, model=${aiEnabled ? `${PROVIDER}/${MODEL}` : "(keyword only)"}${DRY_RUN ? " DRY RUN" : ""}`
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
          aiInputTokens += usage.input;
          aiOutputTokens += usage.output;
          const byIndex = indexResults(results, chunk.length, "companies");
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
          aiInputTokens += usage.input;
          aiOutputTokens += usage.output;
          const byIndex = indexResults(results, chunk.length, "leads");
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

  const [inRate, outRate] = PROVIDER === "openai" ? [0.15, 0.6] : [1, 5]; // $/MTok: gpt-4o-mini vs haiku-4-5
  const estCost = (aiInputTokens / 1e6) * inRate + (aiOutputTokens / 1e6) * outRate;
  console.log(
    `categorize-worker done: keyword=${counts.keyword} ai=${counts.ai} other=${counts.other} unresolved=${counts.unresolved} errors=${counts.errors}` +
      (aiEnabled ? ` | AI tokens in=${aiInputTokens} out=${aiOutputTokens} (~$${estCost.toFixed(2)})` : "")
  );
  // If we die before this, the lease self-expires after LOCK_LEASE.
  await releaseLock(client);
  await client.end();
}

main().catch((err) => {
  console.error("categorize-worker fatal:", err);
  process.exit(1);
});
