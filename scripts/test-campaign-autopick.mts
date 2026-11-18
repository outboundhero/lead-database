// Export popup: which of a client's campaigns are ticked for the operator.
//
//   npx tsx scripts/test-campaign-autopick.mts
//
// Pure; no database, no Bison.
import { autoPickCampaigns, INSTALL_GROUP, isClientCampaign } from "../src/lib/bison/campaign-autopick";
import { BISON_GROUPS } from "./lib/bison-groups.mjs";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

const OH = "app.outboundhero.co", CO = "personal.cleaningoutbound.com";
const FR = "app.facilityreach.com", OC = "personal.outboundclean.com";
let n = 0;
const camp = (name: string, instance_url: string, status = "draft") => ({ id: ++n, name, instance_url, status });
// The screenshot that asked for this: CCGSOR's six drafts, three per install.
const ccgsor = [
  camp("CCGSOR: SEGs (Cleaning Client)", CO), camp("CCGSOR: Outlook (Cleaning Client)", CO),
  camp("CCGSOR: Google + Custom (Cleaning Client)", CO),
  camp("CCGSOR: SEGs (Cleaning Client)", OH), camp("CCGSOR: Outlook (Cleaning Client)", OH),
  camp("CCGSOR: Google + Custom (Cleaning Client)", OH),
];
const ids = (r: { picked: { id: number | string }[] }) => r.picked.map((c) => c.id);
const group1 = { b2b_instance: OH, b2c_instance: CO };

console.log("install groups");
eq("the browser copy matches scripts/lib/bison-groups.mjs", INSTALL_GROUP,
  Object.fromEntries(Object.entries(BISON_GROUPS).flatMap(([g, p]) => [[p.b2b, Number(g)], [p.b2c, Number(g)]])));

console.log("whose campaign it is");
eq("TAG: is the client's", isClientCampaign("CCGSOR: SEGs (Cleaning Client)", "CCGSOR"), true);
eq("case and spaces before the colon ignored", isClientCampaign("  ccgsor : Outlook", "CCGSOR"), true);
eq("JPC does not take JPCA's", isClientCampaign("JPCA: SEGs (Cleaning Client)", "JPC"), false);
eq("JPC does not take JPC&A's", isClientCampaign("JPC&A: SEGs (Cleaning Client)", "JPC"), false);
eq("SI does not take SINY-OS's", isClientCampaign("SINY-OS: Outlook", "SI"), false);
eq("tag with & and - matches itself", isClientCampaign("JPC&A: Outlook", "JPC&A") && isClientCampaign("SINY-OS: SEGs", "SINY-OS"), true);
eq("a tag's regex characters are literal", isClientCampaign("JPCXA: Outlook", "JPC.A"), false);
eq("no colon is not the convention", isClientCampaign("CCGSOR SEGs", "CCGSOR"), false);
eq("empty tag matches nothing", isClientCampaign(": SEGs", ""), false);

console.log("ticks all of a clean set");
eq("CCGSOR, installs saved: all six", ids(autoPickCampaigns(ccgsor, "CCGSOR", group1)), ccgsor.map((c) => c.id));
eq("CCGSOR, no installs saved (one group): all six", ids(autoPickCampaigns(ccgsor, "CCGSOR", null)), ccgsor.map((c) => c.id));
eq("blocked is null when picked", autoPickCampaigns(ccgsor, "CCGSOR", group1).blocked, null);
eq("other clients' campaigns in the list are left alone",
  ids(autoPickCampaigns([...ccgsor, camp("CCGSORX: SEGs", OH), camp("BCS: Outlook", OH)], "CCGSOR", group1)),
  ccgsor.map((c) => c.id));
const jpc = [camp("JPC: Outlook", OH), camp("JPCA: Outlook", OH), camp("JPCNJ: Outlook", OH), camp("JPC&A: Outlook", OH)];
eq("JPC gets only JPC's", ids(autoPickCampaigns(jpc, "JPC", group1)), [jpc[0].id]);

console.log("never Nurture, never archived");
const withNurture = [...ccgsor, camp("CCGSOR: Nurture", OH, "active"), camp("CCGSOR: Outlook (old)", OH, "archived")];
eq("nurture and archived skipped, the six ticked", ids(autoPickCampaigns(withNurture, "CCGSOR", group1)), ccgsor.map((c) => c.id));
eq("only nurture/archived: nothing", autoPickCampaigns([camp("X: Nurture", OH), camp("X: SEGs", OH, "archived")], "X", group1).blocked,
  'no campaign is named "X: …"');
eq("no campaigns at all: nothing", autoPickCampaigns([], "X", group1).picked.length, 0);

console.log("installs");
const moved = [...ccgsor, camp("CCGSOR: SEGs (Cleaning Client)", FR, "paused")];
eq("saved installs: a campaign on another group's install is not ticked",
  ids(autoPickCampaigns(moved, "CCGSOR", group1)), ccgsor.map((c) => c.id));
eq("no saved installs and two groups: nothing", autoPickCampaigns(moved, "CCGSOR", null).blocked,
  "CCGSOR's campaigns are not all on one Bison group's installs");
eq("no saved installs, group 2 only: all", autoPickCampaigns([camp("Q: SEGs", FR), camp("Q: SEGs", OC)], "Q", {}).picked.length, 2);
eq("an install in no group, nothing saved: nothing", autoPickCampaigns([camp("Q: SEGs", "other.example")], "Q", null).picked.length, 0);
eq("saved installs but none of its campaigns there: nothing",
  autoPickCampaigns([camp("Q: SEGs", FR)], "Q", group1).blocked,
  `none of Q's campaigns are on its installs (${OH}, ${CO})`);
eq("installs compared as domains (scheme, case, slash)",
  autoPickCampaigns([camp("Q: SEGs", OH)], "Q", { b2b_instance: "https://APP.outboundhero.co/", b2c_instance: null }).picked.length, 1);

console.log("one campaign per install and bucket");
const twoSets = [...ccgsor, camp("CCGSOR: Outlook (Cleaning Client) v2", OH, "active")];
eq("two Outlook campaigns on one install: nothing", autoPickCampaigns(twoSets, "CCGSOR", group1).blocked,
  `2 Outlook campaigns on ${OH}, so tick the ones to use`);
eq("same name on two installs is not a clash", autoPickCampaigns(ccgsor, "CCGSOR", group1).picked.length, 6);
const bespoke = [camp("JMCC: Google + Custom", OH), camp("JMCC: Golf Tournament Ask", OH)];
eq("a bucket-less campaign counts as Google + Custom", autoPickCampaigns(bespoke, "JMCC", group1).blocked,
  `2 Google + Custom campaigns on ${OH}, so tick the ones to use`);
eq("one bespoke campaign per install is fine", autoPickCampaigns([camp("SSP: Deans", OH), camp("SSP: Deans", CO)], "SSP", group1).picked.length, 2);
eq("several clashes are counted", autoPickCampaigns([...twoSets, camp("CCGSOR: SEGs 2", CO)], "CCGSOR", group1).blocked,
  `2 SEG campaigns on ${CO} (and 1 more like it), so tick the ones to use`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
