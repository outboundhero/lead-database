// Regression checks for the "Email ends with" / "Domain ends with" filters
// (client request 2026-09-18): state defaults, sanitising, active-count and
// the RPC payload shape. No database. Run: npx tsx scripts/test-suffix-filters.mts
// (the SQL side is exercised by the migration-110 apply script and the verify
// workflow; the live function is fn_lead_filter_conditions).
import { DEFAULT_FILTER_STATE, normalizeFilterState, countActiveFilters, type FilterState } from "../src/types/filters";
import { buildRpcFilters } from "../src/lib/filters/build-rpc-filters";

let failed = 0, passed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
const base = countActiveFilters(DEFAULT_FILTER_STATE);

console.log("state defaults and sanitising");
eq("defaults exist", { e: DEFAULT_FILTER_STATE.emailSuffix, d: DEFAULT_FILTER_STATE.domainSuffix }, { e: { include: [], exclude: [] }, d: { include: [], exclude: [] } });
eq("old payload without the keys gets defaults", normalizeFilterState({} as Partial<FilterState>).emailSuffix, { include: [], exclude: [] });
eq("null value is sanitised", normalizeFilterState({ emailSuffix: null } as unknown as Partial<FilterState>).emailSuffix, { include: [], exclude: [] });
eq("non-array include is sanitised, exclude kept", normalizeFilterState({ domainSuffix: { include: ".in", exclude: [".org"] } } as unknown as Partial<FilterState>).domainSuffix, { include: [], exclude: [".org"] });
eq("values keep their case (SQL lower-cases), padding trimmed", normalizeFilterState({ emailSuffix: { include: [" .IN "], exclude: ["@Gmail.com"] } }).emailSuffix, { include: [".IN"], exclude: ["@Gmail.com"] });
eq("blank / non-string values are dropped", normalizeFilterState({ emailSuffix: { include: ["", "   ", "\t", null, 7, ".org"], exclude: [" "] } } as unknown as Partial<FilterState>).emailSuffix, { include: [".org"], exclude: [] });
eq("a blank-only suffix is NOT an active filter (bulk-delete guard)", countActiveFilters(normalizeFilterState({ emailSuffix: { include: ["  "], exclude: [""] } })) - countActiveFilters(DEFAULT_FILTER_STATE), 0);

console.log("active-filter count (drives Reset and the bulk-delete guard)");
eq("email include counts +1", countActiveFilters({ ...DEFAULT_FILTER_STATE, emailSuffix: { include: [".in"], exclude: [] } }) - base, 1);
eq("domain exclude counts +1", countActiveFilters({ ...DEFAULT_FILTER_STATE, domainSuffix: { include: [], exclude: [".in"] } }) - base, 1);
eq("both count +2", countActiveFilters({ ...DEFAULT_FILTER_STATE, emailSuffix: { include: [".in"], exclude: [] }, domainSuffix: { include: [".org"], exclude: [] } }) - base, 2);

console.log("RPC payload");
const rpc = (f: Partial<FilterState>) => buildRpcFilters(normalizeFilterState(f)) as Record<string, unknown>;
eq("untouched: keys absent (payload byte-identical to before)", { e: "emailSuffix" in rpc({}), d: "domainSuffix" in rpc({}) }, { e: false, d: false });
eq("include sent", rpc({ emailSuffix: { include: [".in", ".org"], exclude: [] } }).emailSuffix, { include: [".in", ".org"], exclude: [] });
eq("exclude-only sent", rpc({ domainSuffix: { include: [], exclude: [".in"] } }).domainSuffix, { include: [], exclude: [".in"] });
let threw = false; try { buildRpcFilters({ ...DEFAULT_FILTER_STATE, emailSuffix: undefined, domainSuffix: undefined } as unknown as FilterState); } catch { threw = true; }
eq("old stored payload without the keys does not throw in the builder (exports/process path)", threw, false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
