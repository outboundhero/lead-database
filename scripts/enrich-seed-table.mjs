#!/usr/bin/env node
// Loads one Clay-tab table definition (a client's Clay table, column by column)
// into enrich_tables + enrich_columns.
//
//   node scripts/enrich-seed-table.mjs <spec.json> [--prune] [--dry]
//
// The spec is { client_tag, kind, name, source_note, columns: [...] }, with each
// column's formulas, waterfall, run condition and inputs copied verbatim from
// Clay (only {{«Column»}} references rewritten to keys). Specs hold a client's
// exclusion lists and prompts, so they are kept outside the public repo
// (enrich-specs/ is git-ignored); the database is where they live.
//
// Re-running is safe: the table and every column are upserted by key. Columns
// missing from the spec are kept unless --prune is given (which also deletes
// their cells). Rows already in the table are NOT re-run; queue them from the
// Clay tab ("Re-run whole table") after changing a formula.

import fs from "node:fs";
import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const PRUNE = args.includes("--prune");
const DRY = args.includes("--dry");
if (!file) {
  console.error("usage: node scripts/enrich-seed-table.mjs <spec.json> [--prune] [--dry]");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(file, "utf8"));
const KINDS = new Set(["input", "formula", "waterfall", "action"]);
const tag = String(spec.client_tag ?? "").trim().toUpperCase();
if (!tag || !["companies", "people", "inboxes"].includes(spec.kind) || !spec.name || !Array.isArray(spec.columns)) {
  console.error("spec needs client_tag, kind (companies | people | inboxes), name and columns[]");
  process.exit(1);
}
const keys = new Set();
for (const c of spec.columns) {
  if (!/^[a-z][a-z0-9_]*$/.test(c.key ?? "")) throw new Error(`bad column key: ${JSON.stringify(c.key)}`);
  if (keys.has(c.key)) throw new Error(`duplicate column key: ${c.key}`);
  if (!KINDS.has(c.kind)) throw new Error(`${c.key}: bad kind ${c.kind}`);
  if (c.kind === "action" && !c.action) throw new Error(`${c.key}: action column without an action`);
  keys.add(c.key);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout = '60s'");
  const { rows: [table] } = await client.query(
    `INSERT INTO enrich_tables (client_tag, kind, name, source_note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_tag, kind, name) DO UPDATE SET source_note = EXCLUDED.source_note
     RETURNING id, (xmax = 0) AS created`,
    [tag, spec.kind, spec.name, spec.source_note ?? null]
  );
  const cols = spec.columns.map((c) => ({
    key: c.key,
    name: c.name,
    position: c.position,
    kind: c.kind,
    action: c.kind === "action" ? c.action : null,
    formula: c.formula ?? null,
    waterfall: c.waterfall ?? null,
    inputs: c.inputs ?? {},
    config: c.config ?? {},
    run_if: c.run_if ?? null,
    data_type: c.data_type ?? "text",
    description: c.description ?? null,
    provider: c.provider ?? null,
    needs_env: c.needs_env ?? [],
    phase: c.phase ?? 1,
    hidden: Boolean(c.hidden),
    clay_field_id: c.clay_field_id ?? null,
  }));
  const { rows: written } = await client.query(
    `INSERT INTO enrich_columns AS e (table_id, key, name, position, kind, action, formula, waterfall, inputs, config,
                                       run_if, data_type, description, provider, needs_env, phase, hidden, clay_field_id)
     SELECT $1, x.key, x.name, x.position, x.kind, x.action, x.formula, x.waterfall, x.inputs, x.config,
            x.run_if, x.data_type, x.description, x.provider, x.needs_env, x.phase, x.hidden, x.clay_field_id
       FROM jsonb_to_recordset($2::jsonb) AS x(key text, name text, position int, kind text, action text, formula text,
            waterfall jsonb, inputs jsonb, config jsonb, run_if text, data_type text, description text, provider text,
            needs_env text[], phase smallint, hidden boolean, clay_field_id text)
     ON CONFLICT (table_id, key) DO UPDATE SET
       name = EXCLUDED.name, position = EXCLUDED.position, kind = EXCLUDED.kind, action = EXCLUDED.action,
       formula = EXCLUDED.formula, waterfall = EXCLUDED.waterfall, inputs = EXCLUDED.inputs, config = EXCLUDED.config,
       run_if = EXCLUDED.run_if, data_type = EXCLUDED.data_type, description = EXCLUDED.description,
       provider = EXCLUDED.provider, needs_env = EXCLUDED.needs_env, phase = EXCLUDED.phase, hidden = EXCLUDED.hidden,
       clay_field_id = EXCLUDED.clay_field_id
     RETURNING key, (xmax = 0) AS created`,
    [table.id, JSON.stringify(cols)]
  );
  const { rows: extra } = await client.query(
    `SELECT key FROM enrich_columns WHERE table_id = $1 AND NOT (key = ANY ($2::text[])) ORDER BY position`,
    [table.id, [...keys]]
  );
  let pruned = 0;
  if (PRUNE && extra.length) {
    const gone = extra.map((r) => r.key);
    await client.query(`DELETE FROM enrich_cells WHERE table_id = $1 AND column_key = ANY ($2::text[])`, [table.id, gone]);
    pruned = (await client.query(`DELETE FROM enrich_columns WHERE table_id = $1 AND key = ANY ($2::text[])`, [table.id, gone])).rowCount;
  }
  // The worker re-reads a table's columns every 30 s; bumping updated_at makes
  // the change visible in the tab straight away.
  await client.query(`UPDATE enrich_tables SET updated_at = now() WHERE id = $1`, [table.id]);
  await client.query(DRY ? "ROLLBACK" : "COMMIT");
  const created = written.filter((r) => r.created).length;
  console.log(
    `${DRY ? "[dry run, rolled back] " : ""}${tag} · ${spec.kind} · "${spec.name}" (${table.created ? "new" : "existing"} table ${table.id}): ` +
      `${created} columns added, ${written.length - created} updated` +
      (extra.length ? `, ${PRUNE ? `${pruned} pruned` : `${extra.length} not in the spec kept (--prune removes them)`}` : "")
  );
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  console.error("seed failed:", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
