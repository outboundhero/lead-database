// Bison groups: install sides for a push, and the Groups-tab parser.
//
//   npx tsx --env-file=.env.local scripts/test-bison-groups.mts
//
// Pure pass: scripts/lib/bison-groups.mjs, and — the point of it — the WORKER's
// own routing (push-side.mjs campaignsForLead) on campaigns sided by install, for
// a client with no saved group: every lead lands on exactly one side, none is
// refused, none reaches both workspaces. Cross-group pushes stay refused.
// Live pass (needs GOOGLE_SERVICE_ACCOUNT_B64): the shared parser reads the real
// Groups tab exactly as the "Sync groups" route's inline parser did before
// 2026-11-18.
import {
  BISON_GROUPS, installRole, groupOfInstalls, sideCampaignsByInstall, parseGroupsTab,
  GROUPS_TAB_GID, ONBOARDING_SHEET_DEFAULT,
} from "./lib/bison-groups.mjs";
import { campaignsForLead } from "./lib/push-side.mjs";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

const G1B = "app.outboundhero.co", G1C = "personal.cleaningoutbound.com";
const G2B = "app.facilityreach.com", G2C = "personal.outboundclean.com";
const FREE = new Set(["gmail.com", "yahoo.com"]);
type Camp = { id: number; instance_url: string; side?: "b2b" | "b2c" };
// The six campaigns of a new client, as the push dialog sends them (no sides).
const sixOn = (b2b: string, b2c: string): Camp[] => [
  { id: 1, instance_url: b2b }, { id: 2, instance_url: b2b }, { id: 3, instance_url: b2b },
  { id: 4, instance_url: b2c }, { id: 5, instance_url: b2c }, { id: 6, instance_url: b2c },
];

console.log("installRole / groupOfInstalls");
eq("group 1 B2B install", installRole(G1B), { group: 1, side: "b2b" });
eq("group 1 B2C install", installRole(G1C), { group: 1, side: "b2c" });
eq("group 2 B2B install", installRole(G2B), { group: 2, side: "b2b" });
eq("group 2 B2C install", installRole(G2C), { group: 2, side: "b2c" });
eq("unknown install", installRole("evil.example.com"), null);
eq("group 1 pair", groupOfInstalls([G1B, G1C]), 1);
eq("group 2 pair", groupOfInstalls([G2C, G2B]), 2);
eq("one install", groupOfInstalls([G2B]), 2);
eq("B2B of group 1 + B2C of group 2", groupOfInstalls([G1B, G2C]), null);
eq("both B2B installs", groupOfInstalls([G1B, G2B]), null);
eq("unknown install in the set", groupOfInstalls([G1B, "evil.example.com"]), null);
eq("pairs match the cron/route mapping", BISON_GROUPS, { 1: { b2b: G1B, b2c: G1C }, 2: { b2b: G2B, b2c: G2C } });

console.log("\nsideCampaignsByInstall + the worker's routing (client with NO saved group)");
{
  const camps = sixOn(G1B, G1C);
  const r = sideCampaignsByInstall(camps);
  eq("resolves group 1", r.group, 1);
  eq("every campaign sided from its install", camps.map((c) => c.side), ["b2b", "b2b", "b2b", "b2c", "b2c", "b2c"]);
  const noMapping = new Map<string, string>();   // the worker's instanceSide for an unmapped client
  const biz = campaignsForLead({ campaigns: camps, email: "jo@acme-cleaning.com", clientTag: "SG", freemailDomains: FREE, instanceSide: noMapping });
  eq("worker: company email → only the 3 B2B campaigns", [biz.refuse ?? null, biz.side, biz.targets?.map((c: Camp) => c.id)], [null, "b2b", [1, 2, 3]]);
  const per = campaignsForLead({ campaigns: camps, email: "jo@gmail.com", clientTag: "SG", freemailDomains: FREE, instanceSide: noMapping });
  eq("worker: gmail → only the 3 B2C campaigns", [per.refuse ?? null, per.side, per.targets?.map((c: Camp) => c.id)], [null, "b2c", [4, 5, 6]]);
  const before = sixOn(G1B, G1C);
  const refused = campaignsForLead({ campaigns: before, email: "jo@acme-cleaning.com", clientTag: "SG", freemailDomains: FREE, instanceSide: noMapping });
  eq("worker still refuses the same campaigns WITHOUT sides (the guard is intact)", typeof refused.refuse, "string");
}
{
  const camps = sixOn(G2B, G2C);
  eq("group 2 pair resolves group 2", sideCampaignsByInstall(camps).group, 2);
  eq("group 2 sides", camps.map((c) => c.side), ["b2b", "b2b", "b2b", "b2c", "b2c", "b2c"]);
}

console.log("\nsaved group that is wrong or partial");
{
  // Saved group 2 (stale sheet), campaigns on group 1: nothing sided by the saved installs.
  const camps = sixOn(G1B, G1C);
  eq("stale group 2 + group-1 campaigns → group 1", sideCampaignsByInstall(camps).group, 1);
  // Saved B2B only: the B2B campaigns were already sided by the route; B2C gets its install's side.
  const partial: Camp[] = [{ id: 1, instance_url: G1B, side: "b2b" }, { id: 4, instance_url: G1C }];
  eq("partial mapping filled", [sideCampaignsByInstall(partial).group, partial.map((c) => c.side)], [1, ["b2b", "b2c"]]);
  const kept: Camp[] = [{ id: 1, instance_url: G1B, side: "b2b" }, { id: 4, instance_url: G1C, side: "b2c" }];
  eq("existing sides are never changed", [sideCampaignsByInstall(kept).group, kept.map((c) => c.side)], [1, ["b2b", "b2c"]]);
}

console.log("\ncross-group pushes stay refused, untouched");
{
  const camps: Camp[] = [{ id: 1, instance_url: G1B }, { id: 2, instance_url: G2C }];
  const r = sideCampaignsByInstall(camps);
  eq("group-1 B2B + group-2 B2C → no group", r.group, null);
  eq("…and no side is stamped", camps.map((c) => c.side ?? null), [null, null]);
  const three: Camp[] = [{ id: 1, instance_url: G1B }, { id: 2, instance_url: G1C }, { id: 3, instance_url: G2B }];
  eq("three installs across both groups → no group", sideCampaignsByInstall(three).group, null);
}

console.log("\nparseGroupsTab");
const HDR = ["B2B #1 (OutboundHero) & B2C #1 (CleaningOutbound)", "Status", "Churn Date", "Plan",
  "B2B #2 (FacilityReach) & B2C #2 (OutboundClean)", "Status", "Churn Date", "Plan"];
{
  const rows = [HDR,
    ["mcc", "Active", "", "Tier 1 (Base)", "SBTB", "Active", "", "Tier 1 (Base)"],
    ["CCGNWA ", "Churned", "11/1/2026", "Tier 0.5 (Trial)", "JPS", "Active", "", ""],
    ["", "", "", "", "CCHS", "Active", "", ""],
    ["CCHS", "Active", "", "", "", "", "", ""],
    ["Active", "", "", "", "Tier 1 (Base)", "", "", ""]];
  const r = parseGroupsTab(rows);
  eq("tags by header, cleaned, Status/Plan values rejected", [...(r.groups ?? new Map()).entries()],
    [["MCC", 1], ["SBTB", 2], ["CCGNWA", 1], ["JPS", 2], ["CCHS", 2]]);
  eq("first occurrence wins (CCHS in group 2 first)", r.groups?.get("CCHS"), 2);
  const both = parseGroupsTab([HDR, ["XYZ", "", "", "", "XYZ", "", "", ""]]);
  eq("same row, both columns → group 1", both.groups?.get("XYZ"), 1);
  eq("moved columns still found by header", parseGroupsTab([["Notes", ...HDR], ["n", "ABC", "", "", "", "DEF"]]).groups?.get("DEF"), 2);
  eq("missing headers → error", typeof parseGroupsTab([["Tag", "Status"], ["ABC", "Active"]]).error, "string");
  eq("no data rows → error", typeof parseGroupsTab([HDR]).error, "string");
  eq("only junk → error", typeof parseGroupsTab([HDR, ["Active", "", "", "", "Churned"]]).error, "string");
}

if (process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
  console.log("\nLIVE: the shared parser vs the Sync-groups route's old inline parser, on the real Groups tab");
  const { parseServiceAccount, getAccessToken, tabTitleByGid, readRange } = await import("../src/lib/google/sheets");
  const token = await getAccessToken(parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_B64));
  const id = process.env.ONBOARDING_SHEET_ID || ONBOARDING_SHEET_DEFAULT;
  const title = await tabTitleByGid(token, id, GROUPS_TAB_GID);
  const rows = await readRange(token, id, `'${title.replace(/'/g, "''")}'!A1:L400`);
  // The route's parser exactly as it was before this change.
  const oldParse = () => {
    const header = rows[0].map((h: unknown) => String(h ?? ""));
    const g1 = header.findIndex((h: string) => /b2b\s*#?\s*1/i.test(h)), g2 = header.findIndex((h: string) => /b2b\s*#?\s*2/i.test(h));
    const NOT = /^(true|false|missing in group|owner|status|notes|active|churned|paused|plan|churn date|not found|healthy|confirmed churn|tier .*)$/i;
    const m = new Map<string, number>();
    for (const row of rows.slice(1)) for (const [col, grp] of [[g1, 1], [g2, 2]] as const) {
      const t = String(row[col] ?? "").trim().toUpperCase();
      if (t && !NOT.test(t) && !/^b2[bc]\b/i.test(t) && !m.has(t)) m.set(t, grp);
    }
    return m;
  };
  const a = [...(parseGroupsTab(rows).groups ?? new Map()).entries()], b = [...oldParse().entries()];
  eq(`identical tag → group map (${b.length} tags)`, a, b);
} else {
  console.log("\nSKIP live pass (no GOOGLE_SERVICE_ACCOUNT_B64)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
