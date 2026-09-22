// Bulk never-contact: suppress / restore a whole selection (migration 115).
//
// Suppression is a promise to a real person, and restoring puts an address back
// into live campaigns — so both directions are exercised against REAL rows
// inside a transaction that is rolled back. Nothing here persists.
//
//   npx tsx --env-file=.env.local scripts/test-suppress-bulk.mts
import { Client } from "pg";
import { DEFAULT_FILTER_STATE, normalizeFilterState, countActiveFilters } from "../src/types/filters";
import { buildRpcFilters } from "../src/lib/filters/build-rpc-filters";

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error("DATABASE_URL is required");
let passed = 0, failed = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ` — ${extra}` : ""}`); }
};

const db = new Client({ connectionString: DB, ssl: { rejectUnauthorized: false } });
await db.connect();
const q = async (sql: string, p: unknown[] = []) => (await db.query(sql, p)).rows;

try {
  await db.query("begin");
  await db.query("set local statement_timeout = '180s'");

  const leads = await q(`select id, email from leads where is_suppressed = false and email is not null order by id limit 250`);
  const emails = leads.map((r) => String(r.email));

  // How many of these are visible to the default filters BEFORE anything is
  // suppressed. It is not 250: the default view also hides leads whose location
  // never resolved, so "restored" means "back to this number", not "all of them".
  const pDefault = buildRpcFilters(normalizeFilterState(DEFAULT_FILTER_STATE));
  const [{ c: baseConds }] = await q(`select fn_lead_filter_conditions($1::jsonb) c`, [JSON.stringify(pDefault)]);
  const baseWhere = (baseConds as string[]).join(" and ");
  const baselineVisible = Number((await q(
    `select count(*)::int n from leads l where l.email = any($1::text[]) and ${baseWhere}`, [emails]))[0].n);

  console.log("suppressing a set");
  const t0 = Date.now();
  const [s1] = await q(`select * from fn_suppress_emails($1::text[], 'bulk test', null, null, 'tester')`, [emails]);
  const ms = Date.now() - t0;
  ok(`${emails.length} addresses in one statement (${ms} ms)`, Number(s1.suppressed) === emails.length);
  ok("every lead row is flagged", Number(s1.leads_flagged) === emails.length);
  ok("leads.is_suppressed is set",
    Number((await q(`select count(*)::int n from leads where email = any($1::text[]) and is_suppressed`, [emails]))[0].n) === emails.length);
  ok("the reason is recorded",
    Number((await q(`select count(*)::int n from suppressed_emails where email = any($1::text[]) and reason = 'bulk test'`, [emails]))[0].n) === emails.length);

  console.log("\nre-running is safe");
  const [s2] = await q(`select * from fn_suppress_emails($1::text[], null, null, null, 'tester')`, [emails]);
  ok("no lead is flagged twice", Number(s2.leads_flagged) === 0);
  ok("a later call cannot wipe the original reason",
    Number((await q(`select count(*)::int n from suppressed_emails where email = any($1::text[]) and reason = 'bulk test'`, [emails]))[0].n) === emails.length);

  console.log("\nthe suppression gate actually hides them");
  const visible = Number((await q(
    `select count(*)::int n from leads l where l.email = any($1::text[]) and ${baseWhere}`, [emails]))[0].n);
  ok(`all ${baselineVisible} that were visible are now hidden`, visible === 0, `${visible} still visible`);

  console.log("\nrestoring");
  const t1 = Date.now();
  const [u1] = await q(`select * from fn_unsuppress_emails($1::text[])`, [emails]);
  ok(`${emails.length} addresses restored (${Date.now() - t1} ms)`, Number(u1.unsuppressed) === emails.length);
  ok("every lead is active again", Number(u1.leads_restored) === emails.length);
  ok("nothing is left on the block list",
    Number((await q(`select count(*)::int n from suppressed_emails where email = any($1::text[])`, [emails]))[0].n) === 0);
  const backVisible = Number((await q(
    `select count(*)::int n from leads l where l.email = any($1::text[]) and ${baseWhere}`, [emails]))[0].n);
  ok("the same leads are visible again (back to the pre-suppression baseline)",
    backVisible === baselineVisible, `baseline ${baselineVisible}, now ${backVisible}`);

  console.log("\nedges");
  ok("an empty set is a no-op", Number((await q(`select suppressed from fn_suppress_emails($1::text[])`, [[]]))[0].suppressed) === 0);
  const [s3] = await q(`select * from fn_suppress_emails($1::text[])`, [["  MiXeD@Case.COM ", "mixed@case.com", "", null]]);
  ok("case/space variants collapse to one address", Number(s3.suppressed) === 1);
  ok("restoring an address that was never blocked is harmless",
    Number((await q(`select unsuppressed from fn_unsuppress_emails($1::text[])`, [["nobody@nowhere.invalid"]]))[0].unsuppressed) === 0);

  console.log("\nthe route's filtered resolution matches what the table shows");
  // The API resolves a "select all N" by re-running the same filters. It must
  // cover the same leads the operator saw — the only permitted difference is
  // rows with no email, which cannot be suppressed.
  const state = normalizeFilterState({ ...DEFAULT_FILTER_STATE, location: { ...DEFAULT_FILTER_STATE.location, state: { include: ["WY"], exclude: [], operator: "OR" as const } } });
  ok("such a selection counts as filtered", countActiveFilters(state) > 0);
  const [{ c: c2 }] = await q(`select fn_lead_filter_conditions($1::jsonb) c`, [JSON.stringify(buildRpcFilters(state))]);
  const where = [...(c2 as string[]), "l.is_bounced = false"].join(" and ");
  const shown = Number((await q(`select count(*)::int n from leads l where ${where}`))[0].n);
  const resolved = Number((await q(`select count(distinct lower(l.email))::int n from leads l where ${where} and l.email is not null`))[0].n);
  const noEmail = Number((await q(`select count(*)::int n from leads l where ${where} and l.email is null`))[0].n);
  ok("resolution accounts for every row shown", resolved <= shown && shown - noEmail >= resolved,
    `shown ${shown}, resolved ${resolved}, no-email ${noEmail}`);
  console.log(`  (WY: ${shown.toLocaleString()} shown → ${resolved.toLocaleString()} addresses, ${noEmail.toLocaleString()} without an email)`);
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed  (all inside a rolled-back transaction)`);
process.exit(failed ? 1 : 0);
