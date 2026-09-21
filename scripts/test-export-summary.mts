// Checks the Export-history filter summary against the REAL payloads stored in
// export_jobs.filters_used — the bug it guards (city read as a string, printing
// "City: [object Object]" on every row) was invisible to a unit test written
// from the type annotation, because the annotation was the thing that was wrong.
//
//   npx tsx --env-file=.env.local scripts/test-export-summary.mts
//
// Runs the pure cases with no database; the live pass is skipped when
// DATABASE_URL is unset.
import pg from "pg";
import { formatFilterSummary } from "../src/lib/exports/filter-summary";

let failed = 0, passed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
const ie = (include: string[] = [], exclude: string[] = []) => ({ include, exclude, operator: "OR" });

console.log("shapes as FilterState actually stores them");
eq("empty city object is not a filter", formatFilterSummary({ location: { city: ie(), state: ie(), country: ie() } }), "All leads");
eq("city include renders the values", formatFilterSummary({ location: { city: ie(["Dallas", "Austin"]) } }), "City: Dallas, Austin");
eq("state + country", formatFilterSummary({ location: { state: ie(["TX"]), country: ie(["US"]) } }), "State: TX · Country: US");
eq("long list is capped", formatFilterSummary({ location: { city: ie(["a", "b", "c", "d", "e"]) } }), "City: a, b, c +2 more");
eq("null payload", formatFilterSummary(null), "—");
eq("a client export with targeting", formatFilterSummary({ clientTag: "JPCA", locationTargets: { include: [{ city: "Adger", state: "AL", country: "US" }] } }), "Client: JPCA (1 targeted locations)");
eq("a client export MISSING targeting is called out", formatFilterSummary({ clientTag: "JPCA", locationTargets: { include: [], exclude: [] } }), "Client: JPCA (no location targeting)");
eq("keyword include/exclude still work", formatFilterSummary({ keyword: { include: ["dental"], exclude: ["spa"] } }), "Keyword: dental · Excl: spa");

console.log("\nno summary may ever contain a stringified object");
for (const bad of [
  { location: { city: ie(["Dallas"]) } },
  { location: { city: { include: [{ nested: 1 }], exclude: [] } } },   // non-string members are dropped
  { location: { city: "Dallas" } },                                     // legacy string shape, if any row has it
  { fullName: "x", companyName: "y", source: { include: ["Bison"] } },
]) {
  const s = formatFilterSummary(bad as Record<string, unknown>);
  if (s.includes("[object")) { failed++; console.log(`  FAIL ${JSON.stringify(bad).slice(0, 70)} → ${s}`); }
  else { passed++; console.log(`  ok   ${s}`); }
}

if (process.env.DATABASE_URL) {
  console.log("\nevery payload ever stored in export_jobs");
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  try {
    await c.query("begin");
    await c.query("set local statement_timeout = '60s'");
    const { rows } = await c.query(`select id, created_at, filters_used from export_jobs order by created_at desc limit 200`);
    await c.query("rollback");
    let bad = 0;
    for (const r of rows) {
      const s = formatFilterSummary(r.filters_used);
      if (s.includes("[object")) { bad++; console.log(`  FAIL ${r.id} → ${s.slice(0, 100)}`); }
    }
    if (bad) failed += bad; else { passed++; console.log(`  ok   ${rows.length} stored payloads, none render a stringified object`); }
    const sample = rows[0];
    if (sample) console.log(`  latest: ${formatFilterSummary(sample.filters_used).slice(0, 160)}`);
  } finally { await c.end(); }
} else {
  console.log("\nSKIP live pass (no DATABASE_URL)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
