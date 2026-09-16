// Regression test for the default Mimecast ESP exclusion (2026-09-16).
//
//   DATABASE_URL=... npx tsx scripts/test-esp-default.mts
//
// Asserts the four properties the feature depends on: a fresh page / Reset
// excludes Mimecast, removing the chip STICKS through normalizeFilterState,
// stored payloads that already carry an esp key are never rewritten, and the
// live SQL fragment is NULL-safe (leads with no ESP must not disappear).
import pg from "pg";
import {
  DEFAULT_FILTER_STATE,
  normalizeFilterState,
  countActiveFilters,
  isDefaultEsp,
} from "../src/types/filters";
import { buildRpcFilters } from "../src/lib/filters/build-rpc-filters";

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  console.log(cond ? "PASS" : "FAIL", name, detail);
  if (!cond) failed++;
};

// Fresh page + Reset target.
ok("fresh default excludes Mimecast", JSON.stringify(DEFAULT_FILTER_STATE.esp.exclude) === '["Mimecast"]');
ok("fresh page counts 0 active filters (Delete stays disabled)", countActiveFilters(DEFAULT_FILTER_STATE) === 0, String(countActiveFilters(DEFAULT_FILTER_STATE)));

// A payload with no esp key at all gets the default.
ok("normalize({}) injects the default", JSON.stringify(normalizeFilterState({}).esp.exclude) === '["Mimecast"]');

// Operator removed the chip: the explicit empty exclude must survive normalize.
const removed = normalizeFilterState({ ...DEFAULT_FILTER_STATE, esp: { include: [], exclude: [], operator: "OR", includeUnknown: false } });
ok("removal survives normalize (removal sticks)", removed.esp.exclude.length === 0);
ok("removal counts as an active filter (Reset appears)", countActiveFilters(removed) === 1, String(countActiveFilters(removed)));

// Existing presets / shared searches / batches that store exclude:[] are untouched.
ok("stored exclude:[] is not rewritten", normalizeFilterState({ esp: { include: [], exclude: [] } }).esp.exclude.length === 0);

// RPC serialization: exact literal, no Contains/Exact mode (esp ignores modes).
const rpc = buildRpcFilters(DEFAULT_FILTER_STATE) as { esp?: Record<string, unknown> };
ok("rpc esp.exclude = [Mimecast]", JSON.stringify(rpc.esp?.exclude) === '["Mimecast"]', JSON.stringify(rpc.esp));
ok("rpc esp carries no mode keys", !!rpc.esp && !("excludeMode" in rpc.esp) && !("includeMode" in rpc.esp));
ok("isDefaultEsp distinguishes default / removed / customised",
  isDefaultEsp(DEFAULT_FILTER_STATE.esp) && !isDefaultEsp(removed.esp) && !isDefaultEsp({ include: ["Google"], exclude: ["Mimecast"], operator: "OR" }));

// Live SQL: the fragment the database actually runs must keep NULL-ESP leads.
if (process.env.DATABASE_URL) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("set statement_timeout='60s'");
  const { rows } = await c.query("select fn_lead_filter_conditions($1::jsonb) as conds", [JSON.stringify(rpc)]);
  const frag = (rows[0].conds as string[]).find((s) => s.includes("Mimecast"));
  ok("live SQL fragment is NULL-safe", !!frag && frag.includes("l.esp IS NULL OR") && frag.includes("<> ALL"), frag);
  await c.end();
} else {
  console.log("SKIP live SQL check (no DATABASE_URL)");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
