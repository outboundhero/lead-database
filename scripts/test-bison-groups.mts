// Bison groups: install sides for a push, and the Groups-tab parser.
//
//   npx tsx --env-file=.env.local scripts/test-bison-groups.mts
//
// Pure pass: scripts/lib/bison-groups.mjs, and — the point of it — the WORKER's
// own routing (push-side.mjs campaignsForLead) on campaigns sided by install, for
// a client with no saved group: every lead lands on exactly one side, none is
// refused, none reaches both workspaces. Cross-group pushes stay refused.
// Churn dates (migration 132): the Churn Date cell of every listed tag, found
// by header, read as a raw value (a date cell comes as a day number), a tag
// listed twice, a missing column, the summary the syncs answer with, and the
// savepoint recordGroupsTab() writes the read in (on a stand-in database).
// Live pass (needs GOOGLE_SERVICE_ACCOUNT_B64): the shared parser reads the real
// Groups tab exactly as the "Sync groups" route's inline parser did before
// 2026-11-18, and the raw read the readers use since 2026-11-20 gives the same
// tag to group map as the formatted read (it prints counts only, no cell).
import {
  BISON_GROUPS, installRole, groupOfInstalls, sideCampaignsByInstall, parseGroupsTab,
  GROUPS_TAB_GID, GROUPS_TAB_RENDER, ONBOARDING_SHEET_DEFAULT, churnReport, groupsTabA1, isActiveStatus,
  isGroupsTabTag, recordGroupsTab,
} from "./lib/bison-groups.mjs";
import { groupsTabRecord } from "./lib/overlap-topup.mjs";
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

console.log("\nparseGroupsTab: churn dates (migration 132)");
// A Google Sheets day number (days since 1899-12-30), as the raw read gives a date cell.
const serial = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
{
  const rows: unknown[][] = [HDR,
    ["SDATE", "Active", serial("2026-12-31"), "Tier 1 (Base)", "TDATE", "Active", "1/5/2027", ""],
    ["BLANK", "Active", "", "", "DASH", "Active", "-", ""],
    ["NA", "Active", "N/A", "", "NONE", "Active", "none", ""],
    ["TBD", "Active", "TBD", "", "SHORT"],
    ["TWICE", "Active", "3/1/2027", "", "TWICE", "Active", "2/1/2027", ""],
    ["BAD2", "Active", "2/1/2027", "", "", "", "", ""],
    ["", "", "", "", "BAD2", "Active", "TBD", ""],
    ["FRAC", "Active", serial("2027-03-04") + 0.75, "", "ISO", "Active", "2026-12-31", ""],
    [true, "", "", "", 12345, "", 12, ""]];
  const r = parseGroupsTab(rows);
  const cell = (t: string) => r.churn?.get(t) ?? null;
  eq("groups unchanged by the churn columns", [...(r.groups ?? new Map()).entries()],
    [["SDATE", 1], ["TDATE", 2], ["BLANK", 1], ["DASH", 2], ["NA", 1], ["NONE", 2], ["TBD", 1], ["SHORT", 2],
      ["TWICE", 1], ["BAD2", 1], ["FRAC", 1], ["ISO", 2], ["12345", 2]]);
  eq("one churn cell for every listed tag", [...(r.churn ?? new Map()).keys()], [...(r.groups ?? new Map()).keys()]);
  eq("a date cell (day number) is a date", cell("SDATE"), { state: "date", date: "2026-12-31", cell: String(serial("2026-12-31")) });
  eq("M/D/YYYY text is a date", cell("TDATE"), { state: "date", date: "2027-01-05", cell: "1/5/2027" });
  eq("a blank cell is empty", cell("BLANK"), { state: "empty", date: null, cell: null });
  eq("a row that stops at the tag is empty", cell("SHORT"), { state: "empty", date: null, cell: null });
  eq('"-" is a non-answer', cell("DASH"), { state: "non_answer", date: null, cell: "-" });
  eq('"N/A" is a non-answer', cell("NA"), { state: "non_answer", date: null, cell: "N/A" });
  eq('"none" is a non-answer', cell("NONE"), { state: "non_answer", date: null, cell: "none" });
  eq('"TBD" is unreadable', cell("TBD"), { state: "unreadable", date: null, cell: "TBD" });
  eq("ISO text is unreadable (strict M/D/YYYY)", cell("ISO")?.state, "unreadable");
  eq("a day number with a time drops the time", cell("FRAC")?.date, "2027-03-04");
  eq("a number tag cell is read as its text; its tiny number cell is unreadable", cell("12345"), { state: "unreadable", date: null, cell: "12" });
  eq("a boolean in a tag column is no tag", r.groups?.has("TRUE"), false);
  eq("listed twice in one row: group 1, the earliest date", [r.groups?.get("TWICE"), cell("TWICE")?.date], [1, "2027-02-01"]);
  eq("listed twice, one cell unreadable: unreadable (it blocks)", [r.groups?.get("BAD2"), cell("BAD2")?.state], [1, "unreadable"]);
  eq("duplicates reported once each, in the order they repeat", r.duplicates, ["TWICE", "BAD2"]);
  eq("no churn error", r.churnError, null);

  const moved = parseGroupsTab([
    ["Notes", "B2B #1", "Plan", "Status", "Churn\nDate", "B2B #2", "Churn Date", "Status"],
    ["n", "MOVED1", "", "Active", "12/1/2026", "MOVED2", "1/2/2027", "Active"]]);
  eq("moved churn columns found by header (a line break in the header too)",
    [moved.churn?.get("MOVED1")?.date, moved.churn?.get("MOVED2")?.date], ["2026-12-01", "2027-01-02"]);

  const g2only = parseGroupsTab([
    ["B2B #1", "Status", "Plan", "B2B #2", "Status", "Churn Date"],
    ["ONE", "Active", "", "TWO", "Active", "12/1/2026"]]);
  eq("group 1 never takes group 2's churn column", [g2only.churn, typeof g2only.churnError, /group 1\b/.test(g2only.churnError ?? "")], [null, "string", true]);
  eq("…and its groups still apply", [...(g2only.groups ?? new Map()).entries()], [["ONE", 1], ["TWO", 2]]);
  const none = parseGroupsTab([
    ["B2B #1", "Status", "B2B #2", "Status"], ["ONE", "Active", "TWO", "Active"]]);
  eq("no churn column at all: churn null, the error names both groups, groups apply",
    [none.churn, /group 1 and 2/.test(none.churnError ?? ""), none.groups?.size], [null, true, 2]);
  eq("a churn header left of the tag column does not count",
    parseGroupsTab([["Churn Date", "B2B #1", "Status", "B2B #2", "Churn Date"], ["", "ONE", "", "TWO", "1/2/2027"]]).churn, null);
  eq("a cell longer than 64 characters is a note, not a tag", [isGroupsTabTag("X".repeat(64)), isGroupsTabTag("X".repeat(65))], [true, false]);

  // What the syncs answer and the dry run prints.
  const rep = churnReport(r);
  eq("churnReport: dates, non-answers, unreadable, blank, duplicates",
    [rep.read, rep.dates.map((d) => `${d.tag} ${d.date}`), rep.nonAnswers.map((x) => x.tag), rep.unreadable.map((x) => x.tag), rep.blank, rep.duplicates],
    [true, ["SDATE 2026-12-31", "TDATE 2027-01-05", "TWICE 2027-02-01", "FRAC 2027-03-04"], ["DASH", "NA", "NONE"], ["TBD", "BAD2", "ISO", "12345"], 2, ["TWICE", "BAD2"]]);
  eq("churnReport of an unread tab and of a tab with no churn column",
    [churnReport(null).read, churnReport({ error: "x" }).error, churnReport(none).read, typeof churnReport(none).error], [false, "x", false, "string"]);
  eq("the record lists every tag once; a date only with the state date",
    JSON.parse(groupsTabRecord(r.churn ?? new Map())).filter((e: { tag: string }) => ["SDATE", "DASH", "TBD"].includes(e.tag)),
    [{ tag: "SDATE", churn_cell_state: "date", churn_date: "2026-12-31", churn_cell: String(serial("2026-12-31")) },
      { tag: "DASH", churn_cell_state: "non_answer", churn_date: null, churn_cell: "-" },
      { tag: "TBD", churn_cell_state: "unreadable", churn_date: null, churn_cell: "TBD" }]);
  eq("Active or Healthy, trimmed, any case", ["Active", " healthy ", "ACTIVE", "Paused", "", null, "Confirmed Churn"].map(isActiveStatus),
    [true, true, true, false, false, false, false]);
  eq("the readers' range and raw read", [groupsTabA1("Groups 'B'"), GROUPS_TAB_RENDER],
    ["'Groups ''B'''!A1:L400", { valueRenderOption: "UNFORMATTED_VALUE", dateTimeRenderOption: "SERIAL_NUMBER" }]);
}

console.log("\nrecordGroupsTab (a stand-in database)");
{
  type Call = { sql: string; params?: unknown[] };
  const fakeDb = (answer: (q: Call) => { rows: unknown[] }) => {
    const seen: Call[] = [];
    return {
      seen,
      query: async (sql: string, params?: unknown[]) => { seen.push({ sql, params }); return answer({ sql, params }); },
    };
  };
  const good = parseGroupsTab([HDR, ["AAA", "Active", "1/2/2027", "", "BBB", "Active", "", ""]]);
  const okDb = fakeDb(({ sql }) => (/to_regprocedure/.test(sql) ? { rows: [{ ok: true }] }
    : /fn_client_groups_tab_record/.test(sql) ? { rows: [{ recorded: { listed: 2, unlisted: 5, not_in_roster: [] } }] } : { rows: [] }));
  const r1 = await recordGroupsTab(okDb, good);
  eq("a good read: recorded in a savepoint, nothing to warn", [r1, okDb.seen.map((q) => q.sql.split(/\s/).slice(0, 2).join(" "))],
    [{ recorded: { listed: 2, unlisted: 5, not_in_roster: [] }, warning: null },
      ["SELECT to_regprocedure('public.fn_client_groups_tab_record(jsonb)')", "SAVEPOINT groups_tab_record", "SELECT fn_client_groups_tab_record($1::jsonb)", "RELEASE SAVEPOINT"]]);
  eq("…with the read as its one parameter", JSON.parse(String(okDb.seen[2].params?.[0])),
    [{ tag: "AAA", churn_cell_state: "date", churn_date: "2027-01-02", churn_cell: "1/2/2027" },
      { tag: "BBB", churn_cell_state: "empty", churn_date: null, churn_cell: null }]);
  const badDb = fakeDb(({ sql }) => {
    if (/to_regprocedure/.test(sql)) return { rows: [{ ok: true }] };
    if (/fn_client_groups_tab_record/.test(sql)) throw new Error("made-up refusal");
    return { rows: [] };
  });
  const r2 = await recordGroupsTab(badDb, good);
  eq("a refused record rolls back to its savepoint and warns; the group writes stay",
    [r2.recorded, /made-up refusal/.test(r2.warning ?? ""), badDb.seen.slice(-2).map((q) => q.sql)],
    [null, true, ["ROLLBACK TO SAVEPOINT groups_tab_record", "RELEASE SAVEPOINT groups_tab_record"]]);
  const no132 = fakeDb(() => ({ rows: [{ ok: false }] }));
  const r3 = await recordGroupsTab(no132, good);
  eq("a database without 132: nothing written, a warning", [r3.recorded, /132/.test(r3.warning ?? ""), no132.seen.length], [null, true, 1]);
  const unused = fakeDb(() => { throw new Error("must not be asked"); });
  const r4 = await recordGroupsTab(unused, { error: "unreadable" });
  const r5 = await recordGroupsTab(unused, parseGroupsTab([["B2B #1", "B2B #2"], ["AAA", "BBB"]]));
  eq("an unread tab or one with no churn column: no query, a warning",
    [r4.recorded, r5.recorded, unused.seen.length, typeof r4.warning, /Churn Date/.test(r5.warning ?? "")], [null, null, 0, "string", true]);
}

if (process.env.GOOGLE_SERVICE_ACCOUNT_B64) {
  console.log("\nLIVE: the shared parser vs the Sync-groups route's old inline parser, on the real Groups tab");
  const { parseServiceAccount, getAccessToken, tabTitleByGid, readRange } = await import("../src/lib/google/sheets");
  const token = await getAccessToken(parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_B64));
  const id = process.env.ONBOARDING_SHEET_ID || ONBOARDING_SHEET_DEFAULT;
  const title = await tabTitleByGid(token, id, GROUPS_TAB_GID);
  const rows = await readRange(token, id, groupsTabA1(title));
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
  // The raw read the three readers use since 2026-11-20 (churn dates): the same groups, and churn cells read.
  const raw = parseGroupsTab(await readRange(token, id, groupsTabA1(title), GROUPS_TAB_RENDER));
  eq("the raw read gives the same tag → group map", [...(raw.groups ?? new Map()).entries()], b);
  const rr = churnReport(raw);
  console.log(`       churn cells: ${rr.read ? `${rr.dates.length} dates, ${rr.nonAnswers.length} non-answers, ${rr.unreadable.length} unreadable, ${rr.blank} blank, ${rr.duplicates.length} listed twice` : rr.error}`);
  eq("the raw read finds both Churn Date columns", rr.read, true);
} else {
  console.log("\nSKIP live pass (no GOOGLE_SERVICE_ACCOUNT_B64)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
