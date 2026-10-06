// Campaign picker metadata — status, date, lead count, ordering.
//
//   npx tsx scripts/test-campaign-meta.mts
//
// Pure; no database, no Bison.
import {
  byNewestCampaign, campaignLeadCount, campaignStatus, campaignStatusLabel,
  describeCampaign, formatCampaignDate, isArchivedCampaign, isLiveCampaign,
} from "../src/lib/bison/campaign-meta";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};

// The real JPCA pair that started this: same name, one active (March), one draft (June).
const b2bMain = { id: 818, name: "JPCA: Google + Custom (Cleaning Client)", status: "active", created_at: "2026-03-27T17:39:00.000000Z", total_leads: 60916 };
const b2cMain = { id: 146, name: "JPCA: Google + Custom (Cleaning Client)", status: "draft", created_at: "2026-06-09T03:14:00.000000Z", total_leads: 2918 };
const archived = { id: 500, name: "JPCIN: Outlook (2)", status: "archived", created_at: "2026-01-06T00:00:00.000000Z", total_leads: 16211 };
const bare = { id: 7 };

console.log("status");
eq("active", campaignStatus(b2bMain), "active");
eq("draft", campaignStatus(b2cMain), "draft");
eq("case and padding ignored", campaignStatus({ id: 1, status: "  Paused " }), "paused");
eq("Bison's 'Launching' is a status", campaignStatus({ id: 1, status: "Launching" }), "launching");
eq("missing is unknown, not a crash", campaignStatus(bare), "unknown");
eq("garbage is unknown", campaignStatus({ id: 1, status: 42 }), "unknown");
eq("label is capitalised", campaignStatusLabel(b2cMain), "Draft");
eq("unknown label says so", campaignStatusLabel(bare), "Status unknown");
eq("archived detected", isArchivedCampaign(archived), true);
eq("draft is not archived", isArchivedCampaign(b2cMain), false);
eq("active is live", isLiveCampaign(b2bMain), true);
eq("draft is not live", isLiveCampaign(b2cMain), false);

console.log("\ndate and count");
eq("date renders as 9 Jun 2026", formatCampaignDate(b2cMain), "9 Jun 2026");
eq("no date renders empty", formatCampaignDate(bare), "");
eq("unparseable date renders empty", formatCampaignDate({ id: 1, created_at: "yesterday" }), "");
eq("lead count", campaignLeadCount(b2bMain), 60916);
eq("lead count missing is null", campaignLeadCount(bare), null);
eq("lead count as string still counts", campaignLeadCount({ id: 1, total_leads: "12" }), 12);

console.log("\ndescription line");
eq("full line", describeCampaign(b2cMain), "Draft · 9 Jun 2026 · 2,918 leads");
eq("singular lead", describeCampaign({ id: 1, status: "active", total_leads: 1 }), "Active · 1 lead");
eq("nothing known gives empty string", describeCampaign(bare), "");

console.log("\nordering: newest first, undated last, then by id");
const sorted = [bare, b2bMain, archived, b2cMain].sort(byNewestCampaign).map((c) => c.id);
eq("order", sorted, [146, 818, 500, 7]);
eq("two undated fall back to higher id first", [{ id: 3 }, { id: 9 }].sort(byNewestCampaign).map((c) => c.id), [9, 3]);
eq("the JPCA pair: draft B2C (June) sorts above active B2B (March)", [b2bMain, b2cMain].sort(byNewestCampaign)[0].id, 146);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
