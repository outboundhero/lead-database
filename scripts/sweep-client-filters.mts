/**
 * Sweeps EVERY client with location targeting and reports, per client:
 *   - how long the Leads-page query actually takes (fn_filter_leads_v2)
 *   - the total it returns, and whether that total is exact or an estimate
 *   - any lead outside the states the client targets (the wrong-state regression)
 *
 * Point: nobody should have to click through 190 clients by hand to find the
 * slow or wrong ones.
 *
 *   DATABASE_URL=... npx tsx scripts/sweep-client-filters.mts            # all
 *   DATABASE_URL=... npx tsx scripts/sweep-client-filters.mts --slow 8   # flag >8s
 *   DATABASE_URL=... npx tsx scripts/sweep-client-filters.mts BBS CCGCT  # named
 *
 * Uses the SESSION pooler (port 5432) when available: the transaction pooler
 * enforces the role's 2min statement_timeout, which a genuinely slow client
 * would hit, and we want the real number rather than a cancellation.
 */
import { Client } from "pg";

const RAW = process.env.DATABASE_URL;
if (!RAW) throw new Error("DATABASE_URL is required");
const DB = RAW.replace(":6543/", ":5432/");

const args = process.argv.slice(2);
const slowIdx = args.indexOf("--slow");
const SLOW_S = slowIdx >= 0 ? Number(args[slowIdx + 1]) : 8;
const only = args
  .filter((a, i) => !a.startsWith("--") && !(slowIdx >= 0 && i === slowIdx + 1))
  .map((s) => s.toUpperCase());

interface Row { client_tag: string; states: string[] }

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();
  await db.query("set statement_timeout = 0");

  const { rows } = await db.query<Row>(`
    select t.client_tag,
           array_agg(distinct upper(e->>'state')) filter (where e->>'state' is not null) as states
      from client_targeting t, jsonb_array_elements(t.include_locations::jsonb) e
     where jsonb_array_length(coalesce(t.include_locations::jsonb,'[]'::jsonb)) > 0
     group by 1 order by 1`);
  const targets = only.length ? rows.filter((r) => only.includes(r.client_tag)) : rows;

  console.log(`\nSweeping ${targets.length} client(s). Flagging anything over ${SLOW_S}s.\n`);
  console.log("  client    secs     total      exact?  out-of-state");
  console.log("  " + "-".repeat(56));

  const slow: string[] = [], wrong: string[] = [], failed: string[] = [];

  for (const t of targets) {
    // Exactly what the Leads page sends when this client is selected.
    const { rows: [f] } = await db.query<{ filters: unknown }>(`
      select jsonb_build_object(
        'locationTargets', jsonb_build_object('include',
           (select jsonb_agg(e) from client_targeting t2, jsonb_array_elements(t2.include_locations::jsonb) e where t2.client_tag=$1),
           'exclude','[]'::jsonb),
        'location', jsonb_build_object(
           'state', jsonb_build_object('include',
              (select jsonb_agg(distinct e->>'state') from client_targeting t3, jsonb_array_elements(t3.include_locations::jsonb) e where t3.client_tag=$1),
              'exclude','[]'::jsonb),
           'city', jsonb_build_object('include',
              (select jsonb_agg(distinct e->>'city') from client_targeting t4, jsonb_array_elements(t4.include_locations::jsonb) e where t4.client_tag=$1),
              'exclude','[]'::jsonb,'includeMode','exact')),
        'categorySearch', jsonb_build_object('include','[]'::jsonb,'exclude',to_jsonb(coalesce(t.exclude_terms,'{}')),'excludeMode','exact'),
        'commercialCleaning', true
      ) as filters from client_targeting t where t.client_tag=$1`, [t.client_tag]);

    const started = Date.now();
    let total = "?", exact = "?";
    try {
      const { rows: [r] } = await db.query<{ total: string; approx: string }>(
        `select fn_filter_leads_v2($1::jsonb,'','desc',50,0) #>> '{totalCount}' as total,
                fn_filter_leads_v2($1::jsonb,'','desc',50,0) #>> '{isApproximate}' as approx`,
        [JSON.stringify(f.filters)]);
      total = r.total; exact = r.approx === "false" ? "yes" : "NO";
    } catch (e) {
      failed.push(t.client_tag);
      total = "ERROR"; exact = "-";
    }
    // Halved: the query above evaluates the function twice.
    const secs = (Date.now() - started) / 2000;

    // Wrong-state check. This MUST be measured on what the filter actually
    // RETURNS -- an earlier version of this script counted every lead sharing a
    // target city NAME, which is the population the OLD bug would have leaked
    // and says nothing about current behaviour. It reported tens of thousands
    // of false positives.
    let oos = 0;
    try {
      const { rows: [w] } = await db.query<{ w: string }>(
        `select array_to_string(fn_lead_filter_conditions($1::jsonb), ' AND ') as w`,
        [JSON.stringify(f.filters)]);
      if (!w.w) { oos = -1; }
      else {
        const { rows: [c] } = await db.query<{ n: string }>(
          `select count(*) n from leads l
            where ${w.w} and l.is_bounced = false
              and l.state_code is not null and upper(l.state_code) <> all($1::text[])`,
          [t.states ?? []]);
        oos = Number(c.n);
      }
    } catch { oos = -1; }

    if (secs > SLOW_S) slow.push(`${t.client_tag} (${secs.toFixed(1)}s)`);
    if (oos > 0) wrong.push(`${t.client_tag} (${oos})`);

    console.log(
      `  ${t.client_tag.padEnd(9)} ${secs.toFixed(1).padStart(5)}  ${String(total).padStart(9)}` +
      `   ${exact.padStart(5)}   ${oos === 0 ? "0" : oos < 0 ? "?" : `*** ${oos} ***`}` +
      `${secs > SLOW_S ? "   <-- SLOW" : ""}`);
  }

  console.log("\n" + "=".repeat(58));
  console.log(`  slow (> ${SLOW_S}s): ${slow.length ? slow.join(", ") : "none"}`);
  console.log(`  wrong-state    : ${wrong.length ? wrong.join(", ") : "none"}`);
  console.log(`  errored        : ${failed.length ? failed.join(", ") : "none"}`);
  await db.end();
  process.exit(wrong.length || failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
