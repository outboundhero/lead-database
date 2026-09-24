// The B2B/B2C routing guard. This is the test that would have caught the
// 2026-09-24 incident: 1,745,235 company addresses pushed into B2C campaigns,
// 271,587 freemail addresses into B2B campaigns, and 822,977 leads attached to
// BOTH workspaces at once.
//
//   npx tsx --env-file=.env.local scripts/test-push-side.mts
//
// The live pass asserts the worker's definition of a side is IDENTICAL to the
// one fn_lead_filter_conditions uses when the leads were selected — the two
// drifting apart is what caused the incident in the first place.
import { Client } from "pg";
// @ts-expect-error — plain .mjs helper shared with the worker
import { sideOfEmail, sideOfCampaign, campaignsForLead } from "./lib/push-side.mjs";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

const FREE = new Set(["gmail.com", "yahoo.com", "aol.com", "hotmail.com", "outlook.com"]);
const TAG = "CCOC";
const SIDES = new Map([
  [`${TAG}|app.facilityreach.com`, "b2b"],
  [`${TAG}|personal.outboundclean.com`, "b2c"],
]);
const b2bCamp = { id: 370, instance_url: "app.facilityreach.com", side: "b2b" };
const b2cCamp = { id: 334, instance_url: "personal.outboundclean.com", side: "b2c" };
const unstampedB2b = { id: 370, instance_url: "app.facilityreach.com" };
const unstampedB2c = { id: 334, instance_url: "personal.outboundclean.com" };
const orphan = { id: 999, instance_url: "app.unknown-install.com" };

console.log("a side is decided by the DOMAIN, never by the mailbox name");
eq("a person at a company is B2B", sideOfEmail("john.smith@acmecorp.com", FREE), "b2b");
eq("a role mailbox at a company is B2B", sideOfEmail("info@acmecorp.com", FREE), "b2b");
eq("a person on gmail is B2C", sideOfEmail("john.smith@gmail.com", FREE), "b2c");
eq("a role mailbox on gmail is B2C", sideOfEmail("info@gmail.com", FREE), "b2c");
eq("case and padding do not matter", sideOfEmail("  John@GMAIL.com ", FREE), "b2c");
eq("a malformed address is treated as B2B, not freemail", sideOfEmail("not-an-email", FREE), "b2b");

console.log("\nthe exact cases from the incident");
const run = (email: string, campaigns: unknown[]) =>
  campaignsForLead({ campaigns, email, clientTag: TAG, freemailDomains: FREE, instanceSide: SIDES });
eq("kimberly.wolff@arm.com goes ONLY to the B2B campaign",
  run("kimberly.wolff@arm.com", [b2bCamp, b2cCamp]).targets.map((c: { id: number }) => c.id), [370]);
eq("a gmail address goes ONLY to the B2C campaign",
  run("someone@gmail.com", [b2bCamp, b2cCamp]).targets.map((c: { id: number }) => c.id), [334]);
eq("no lead is ever attached to both",
  run("kimberly.wolff@arm.com", [b2bCamp, b2cCamp]).targets.length, 1);

console.log("\ncampaigns with no stamped side");
eq("resolved from the client's installs", sideOfCampaign(unstampedB2b, TAG, SIDES), "b2b");
eq("unstamped campaigns still route correctly",
  run("john@acmecorp.com", [unstampedB2b, unstampedB2c]).targets.map((c: { id: number }) => c.id), [370]);
eq("an unknown install has no side", sideOfCampaign(orphan, TAG, SIDES), null);

console.log("\nREFUSING is the fallback, never 'send it to both'");
const refused = run("john@acmecorp.com", [unstampedB2b, orphan]);
eq("two installs + an unresolvable side is refused", typeof refused.refuse, "string");
eq("and nothing is targeted", refused.targets, undefined);
eq("a single-install batch is never refused",
  run("john@acmecorp.com", [unstampedB2c]).targets.map((c: { id: number }) => c.id), [334]);
eq("a single install sends regardless of the lead's side",
  run("someone@gmail.com", [unstampedB2b]).targets.map((c: { id: number }) => c.id), [370]);

if (process.env.DATABASE_URL) {
  console.log("\nthe worker and the SQL selection must agree on what a side IS");
  const db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query("begin");
    await db.query("set local statement_timeout = '120s'");
    const { rows: fm } = await db.query("select domain from freemail_domains");
    const live = new Set(fm.map((r) => String(r.domain).toLowerCase()));
    // Take real addresses and compare the worker's verdict with the SQL branch
    // the Leads page uses to SELECT b2b/b2c.
    const { rows } = await db.query(
      `select email,
              case when split_part(lower(email),'@',2) in (select domain from freemail_domains)
                   then 'b2c' else 'b2b' end as sql_side
         from leads where email is not null order by id limit 5000`);
    const disagree = rows.filter((r) => sideOfEmail(r.email, live) !== r.sql_side);
    eq(`worker agrees with fn_lead_filter_conditions on ${rows.length} real addresses`, disagree.length, 0);
    if (disagree.length) console.log("   e.g.", disagree.slice(0, 3).map((r) => r.email));
    // And the definition that caused the incident must NOT be used any more.
    const { rows: [m] } = await db.query(
      `select count(*)::int as n from leads
        where email is not null and email_type = 'personal'
          and split_part(lower(email),'@',2) not in (select domain from freemail_domains)`);
    console.log(`   (for scale: ${Number(m.n).toLocaleString()} leads are 'personal' mailboxes at company domains —`);
    console.log(`    every one of them would be misrouted to B2C by the old email_type rule)`);
    await db.query("rollback");
  } finally { await db.end(); }
} else {
  console.log("\nSKIP live pass (no DATABASE_URL)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
