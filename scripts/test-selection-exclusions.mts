// "Select all N, minus the rows I unchecked" (migration 114).
//
// The risk is a mismatch between what the operator sees checked and what an
// action actually touches — an export shipping a row they unchecked, or a
// delete removing it. So this drives the REAL normalize → buildRpcFilters →
// fn_lead_filter_conditions chain (the export route normalises before
// building, which is where a naive implementation loses the ids) and counts
// real rows.
//
//   npx tsx --env-file=.env.local scripts/test-selection-exclusions.mts
import { Client } from "pg";
import {
  DEFAULT_FILTER_STATE, normalizeFilterState, sanitizeExcludeIds, EXCLUDE_IDS_MAX,
} from "../src/types/filters";
import { buildRpcFilters } from "../src/lib/filters/build-rpc-filters";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
const A = "11111111-2222-3333-4444-555555555555";
const B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

console.log("sanitising");
eq("keeps real uuids", sanitizeExcludeIds([A, B]), [A, B]);
eq("drops junk and duplicates", sanitizeExcludeIds([A, A, "nope", "", null, 7]), [A]);
eq("not an array → empty", sanitizeExcludeIds("x"), []);
eq("caps the list", sanitizeExcludeIds(Array.from({ length: EXCLUDE_IDS_MAX + 50 }, (_, i) => `${String(i).padStart(8, "0")}-2222-3333-4444-555555555555`)).length, EXCLUDE_IDS_MAX);

console.log("\nsurviving the chain the export route uses (normalize → build)");
eq("normalize keeps the ids", normalizeFilterState({ excludeIds: [A, B] }).excludeIds, [A, B]);
eq("normalize drops junk", normalizeFilterState({ excludeIds: ["nope", B] } as never).excludeIds, [B]);
eq("absent when there are none", "excludeIds" in normalizeFilterState({}), false);
eq("builder emits them", (buildRpcFilters(normalizeFilterState({ excludeIds: [A] })) as Record<string, unknown>).excludeIds, [A]);
eq("builder omits the key entirely when unused (payload stays byte-identical)",
  "excludeIds" in (buildRpcFilters(DEFAULT_FILTER_STATE) as Record<string, unknown>), false);
eq("a saved search never carries them", "excludeIds" in normalizeFilterState({ clientTag: "X" }), false);

if (process.env.DATABASE_URL) {
  console.log("\nagainst real rows");
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const tq = async (sql: string, p: unknown[] = []) => {
    await db.query("begin"); await db.query("set local statement_timeout='120s'");
    try { const r = await db.query(sql, p); await db.query("commit"); return r.rows; }
    catch (e) { await db.query("rollback").catch(() => {}); throw e; }
  };
  try {
    const ids = (await tq(`select id from leads where state_code = 'TX' order by id limit 5`)).map((r) => r.id as string);
    const base = { ...DEFAULT_FILTER_STATE, location: { ...DEFAULT_FILTER_STATE.location, state: { include: ["TX"], exclude: [], operator: "OR" as const } } };
    const countWith = async (excludeIds?: string[]) => {
      const p = buildRpcFilters(normalizeFilterState(excludeIds ? { ...base, excludeIds } : base));
      const [{ c }] = await tq(`select fn_lead_filter_conditions($1::jsonb) c`, [JSON.stringify(p)]);
      // bounded slice: the point is the delta, not the absolute number
      const [{ n }] = await tq(`select count(*)::int n from (select * from leads where state_code='TX' order by id limit 50000) l where ${(c as string[]).join(" AND ")}`);
      return Number(n);
    };
    const all = await countWith();
    const minus3 = await countWith(ids.slice(0, 3));
    const minus5 = await countWith(ids);
    eq("unchecking 3 rows removes exactly 3", all - minus3, 3);
    eq("unchecking 5 rows removes exactly 5", all - minus5, 5);
    eq("the rows themselves are untouched",
      Number((await tq(`select count(*)::int n from leads where id = any($1::uuid[])`, [ids]))[0].n), 5);
    console.log(`  (slice of ${all.toLocaleString()} TX leads)`);
  } finally { await db.end(); }
} else {
  console.log("\nSKIP live pass (no DATABASE_URL)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
