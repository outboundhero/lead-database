// What the push worker records must match what Bison holds (2026-11-20).
//
//   npx tsx scripts/test-push-attach.mts
//
// Pure: scripts/lib/push-attach.mjs, plus a simulated install that applies
// Bison's own rule (a lead "in_sequence" in another campaign is left out unless
// the attach sets allow_parallel_sending; bounced or unsubscribed leads never go
// in; the call still answers 2xx when some of the chunk went in). The invariant:
// a lead recorded "sent" IS in its campaign, and one recorded "skipped" is not.
import {
  campaignTag, inCampaign, inSequenceElsewhere, planTarget, attachBody, verifyForced, itemOutcome,
} from "./lib/push-attach.mjs";

let passed = 0, failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}\n       got  ${g}\n       want ${w}`); }
};
type Lcd = { campaign_id: number | string; status: string; status_reason?: string | null };
type Lead = { id: number | string; status?: string; lead_campaign_data?: Lcd[] } | null;
type Info = { name: string | null; status: string | null } | null;
const infoOf = (m: Record<string, Info>) => (id: string) => (id in m ? m[id] : null);

console.log("campaign tags");
eq("tag before the colon", campaignTag("AAA: SEGs (Cleaning Client)"), "AAA");
eq("trimmed and upper-cased", campaignTag("  bbb : Outlook"), "BBB");
eq("symbols in a tag survive", campaignTag("AB&C: Outlook (Cleaning Client)"), "AB&C");
eq("nurture campaign", campaignTag("DDD: Google + Custom [Nurture] (Cleaning Client)"), "DDD");
eq("no colon -> null", campaignTag("Some campaign"), null);
eq("null name -> null", campaignTag(null), null);

console.log("\nreading lead_campaign_data (the live shape, 2026-11-20)");
// A lead the 18 Nov push recorded "sent" to campaign 2354 that Bison never added:
// finished in one campaign, stopped in an archived one, in sequence in two others.
const live: Lead = {
  id: 5000001, status: "unverified",
  lead_campaign_data: [
    { campaign_id: 681, status: "sequence_finished", status_reason: null },
    { campaign_id: 801, status: "stopped", status_reason: "stopped_campaign_archived" },
    { campaign_id: 2159, status: "in_sequence", status_reason: null },
    { campaign_id: 2117, status: "in_sequence", status_reason: null },
  ],
};
eq("not in the target", inCampaign(live, 2354), false);
eq("in a stopped campaign counts as in it", inCampaign(live, 801), true);
eq("in sequence elsewhere = only in_sequence entries", inSequenceElsewhere(live, 2354), ["2159", "2117"]);
eq("the target itself is never 'elsewhere'", inSequenceElsewhere(live, 2159), ["2117"]);
eq("no data -> nothing", inSequenceElsewhere({ id: 1 }, 5), []);
eq("garbage entries ignored", inSequenceElsewhere({ id: 1, lead_campaign_data: [null as unknown as Lcd, { campaign_id: 9, status: "in_sequence" }] }, 5), ["9"]);

console.log("\nplanTarget");
const others = infoOf({ "2159": { name: "BBB: Google + Custom (Cleaning Client)", status: "active" },
                        "2117": { name: "CCC: Google + Custom (Cleaning Client)", status: "active" } });
eq("the live case, parallel on: attach, forced, holders named",
  planTarget({ bisonLead: live, campaignId: 2354, clientTag: "AAA", campaignInfo: others, force: true }),
  { action: "attach", force: true, holders: "BBB, CCC" });
eq("the live case, parallel off: blocked, and says who holds it",
  planTarget({ bisonLead: live, campaignId: 2354, clientTag: "AAA", campaignInfo: others, force: false }),
  { action: "blocked", reason: "Bison: in sequence in another campaign (BBB, CCC) and parallel sending is off" });
eq("created by this push: plain attach",
  planTarget({ bisonLead: null, campaignId: 1, clientTag: "AAA", campaignInfo: () => null, force: true }),
  { action: "attach", force: false });
eq("already in the target: present",
  planTarget({ bisonLead: { id: 1, lead_campaign_data: [{ campaign_id: 7, status: "in_sequence" }] }, campaignId: "7", clientTag: "AAA", campaignInfo: () => null, force: true }),
  { action: "present" });
eq("present wins over bounced (it IS in the campaign)",
  planTarget({ bisonLead: { id: 1, status: "bounced", lead_campaign_data: [{ campaign_id: 7, status: "bounced" }] }, campaignId: 7, clientTag: "AAA", campaignInfo: () => null, force: true }),
  { action: "present" });
eq("bounced: blocked even with parallel on",
  planTarget({ bisonLead: { id: 1, status: "bounced", lead_campaign_data: [] }, campaignId: 7, clientTag: "AAA", campaignInfo: () => null, force: true }),
  { action: "blocked", reason: "Bison: the lead is bounced in this workspace" });
eq("unsubscribed (any case): blocked",
  planTarget({ bisonLead: { id: 1, status: "Unsubscribed" }, campaignId: 7, clientTag: "AAA", campaignInfo: () => null, force: true }),
  { action: "blocked", reason: "Bison: the lead is unsubscribed in this workspace" });
eq("only finished/stopped elsewhere: plain attach, nothing to force",
  planTarget({ bisonLead: { id: 1, status: "unverified", lead_campaign_data: [{ campaign_id: 3, status: "sequence_finished" }, { campaign_id: 4, status: "stopped" }] }, campaignId: 7, clientTag: "AAA", campaignInfo: () => null, force: true }),
  { action: "attach", force: false });
const inSeq = (id: number): Lead => ({ id: 1, status: "unverified", lead_campaign_data: [{ campaign_id: id, status: "in_sequence" }] });
eq("in this client's own DRAFT campaign: never forced",
  planTarget({ bisonLead: inSeq(50), campaignId: 7, clientTag: "AAA", campaignInfo: infoOf({ "50": { name: "AAA: Outlook (Cleaning Client)", status: "draft" } }), force: true }),
  { action: "blocked", reason: "already in sequence in this client's campaign \"AAA: Outlook (Cleaning Client)\" (#50)" });
eq("in this client's own ACTIVE nurture: never forced",
  planTarget({ bisonLead: inSeq(51), campaignId: 7, clientTag: "AAA", campaignInfo: infoOf({ "51": { name: "AAA: Outlook [Nurture] (Cleaning Client)", status: "active" } }), force: true }).action,
  "blocked");
eq("tag compare ignores case",
  planTarget({ bisonLead: inSeq(50), campaignId: 7, clientTag: "aaa", campaignInfo: infoOf({ "50": { name: "AAA: Outlook", status: "paused" } }), force: true }).action,
  "blocked");
eq("own campaign with an unknown state counts as live",
  planTarget({ bisonLead: inSeq(50), campaignId: 7, clientTag: "AAA", campaignInfo: infoOf({ "50": { name: "AAA: Outlook", status: null } }), force: true }).action,
  "blocked");
eq("own ARCHIVED campaign sends nothing more: forced",
  planTarget({ bisonLead: inSeq(52), campaignId: 7, clientTag: "AAA", campaignInfo: infoOf({ "52": { name: "AAA: Outlook (Cleaning Client)", status: "archived" } }), force: true }),
  { action: "attach", force: true, holders: "AAA" });
eq("own COMPLETED campaign: forced",
  planTarget({ bisonLead: inSeq(53), campaignId: 7, clientTag: "AAA", campaignInfo: infoOf({ "53": { name: "AAA: SEGs", status: "completed" } }), force: true }).action,
  "attach");
eq("a campaign Bison no longer has: forced, named by id",
  planTarget({ bisonLead: inSeq(54), campaignId: 7, clientTag: "AAA", campaignInfo: () => null, force: true }),
  { action: "attach", force: true, holders: "#54" });
eq("own live AND another client's: own wins, blocked",
  planTarget({ bisonLead: { id: 1, lead_campaign_data: [{ campaign_id: 60, status: "in_sequence" }, { campaign_id: 61, status: "in_sequence" }] }, campaignId: 7, clientTag: "AAA",
    campaignInfo: infoOf({ "60": { name: "BBB: Outlook", status: "active" }, "61": { name: "AAA: SEGs", status: "draft" } }), force: true }).action,
  "blocked");
eq("no client tag on the batch: cannot be 'own', forced",
  planTarget({ bisonLead: inSeq(50), campaignId: 7, clientTag: null, campaignInfo: infoOf({ "50": { name: "AAA: Outlook", status: "draft" } }), force: true }).action,
  "attach");

console.log("\nattach body");
eq("parallel on", attachBody(["11", "12"], true), { lead_ids: ["11", "12"], allow_parallel_sending: true });
eq("parallel off: exactly the old body", attachBody(["11"], false), { lead_ids: ["11"] });

console.log("\nspot check after a 2xx");
{
  const holds = new Set(["1", "2", "3", "4", "5"]);
  let reads = 0;
  const getLead = async (id: string) => { reads++; return { id, lead_campaign_data: holds.has(id) ? [{ campaign_id: 9, status: "in_sequence" }] : [] }; };
  const v = await verifyForced({ leadIds: ["1", "2", "3", "4", "5"], campaignId: 9, getLead, sample: 2 });
  eq("all landed: only the sample is read", [reads, v.landed.size, v.missing.size], [2, 5, 0]);
}
{
  const holds = new Set(["1", "3", "5"]);
  let reads = 0;
  const getLead = async (id: string) => { reads++; return { id, lead_campaign_data: holds.has(id) ? [{ campaign_id: 9, status: "in_sequence" }] : [] }; };
  const v = await verifyForced({ leadIds: ["1", "2", "3", "4", "5"], campaignId: 9, getLead, sample: 2 });
  eq("a miss in the sample: every forced lead is read, misses named", [reads, [...v.missing].sort(), v.landed.size], [5, ["2", "4"], 3]);
}
{
  const getLead = async (id: string) => (id === "1" ? undefined : id === "2" ? null : { id, lead_campaign_data: [{ campaign_id: 9, status: "in_sequence" }] });
  const v = await verifyForced({ leadIds: ["1", "2", "3"], campaignId: 9, getLead, sample: 5 });
  eq("unreadable counts as landed; a lead Bison lacks is missing", [[...v.landed].sort(), [...v.missing], v.unreadable], [["1", "3"], ["2"], 1]);
}

console.log("\nitem outcome");
const T = (...ids: string[]) => ids.map((id) => ({ id }));
eq("in its campaign: sent, no note", itemOutcome({ targets: T("7"), attached: new Set(["7"]), blocked: new Map() }), { status: "sent", error: null });
eq("not added: skipped with the reason", itemOutcome({ targets: T("7"), attached: new Set(), blocked: new Map([["7", "Bison: the lead is bounced in this workspace"]]) }),
  { status: "skipped", error: "Bison: the lead is bounced in this workspace" });
eq("one of two: sent, the other named", itemOutcome({ targets: T("7", "8"), attached: new Set(["7"]), blocked: new Map([["8", "why"]]) }),
  { status: "sent", error: "partial: not added to #8: why" });
eq("none of two: skipped, both named", itemOutcome({ targets: T("7", "8"), attached: new Set(), blocked: new Map([["7", "a"], ["8", "b"]]) }),
  { status: "skipped", error: "#7: a; #8: b" });
eq("a target still open: null (the item is retried)", itemOutcome({ targets: T("7", "8"), attached: new Set(["7"]), blocked: new Map() }), null);
eq("ids outside the targets are ignored", itemOutcome({ targets: T("7"), attached: new Set(["99"]), blocked: new Map() }), null);
eq("no targets: null", itemOutcome({ targets: [], attached: new Set(), blocked: new Map() }), null);

// ── A simulated install, run the way the worker runs a cycle ────────────────
// Bison's rule as measured live: bounced/unsubscribed never go in; a lead in
// sequence in another campaign goes in only with allow_parallel_sending; the
// call answers 2xx whenever ANY lead of the chunk went in, 422 when none did.
type Camp = { name: string; status: string; leads: Set<string> };
function install() {
  const camps = new Map<string, Camp>([
    ["100", { name: "AAA: Google + Custom (Cleaning Client)", status: "draft", leads: new Set() }],   // the target
    ["101", { name: "AAA: Outlook (Cleaning Client)", status: "draft", leads: new Set(["l6"]) }],     // own other bucket
    ["200", { name: "BBB: Google + Custom (Cleaning Client)", status: "active", leads: new Set(["l2", "l3", "l7"]) }],
    ["300", { name: "AAA: Google + Custom (Cleaning Client)", status: "archived", leads: new Set(["l8"]) }],
  ]);
  const status = new Map([["l4", "bounced"], ["l5", "unsubscribed"]]);
  const lead = (id: string): Lead => ({
    id, status: status.get(id) ?? "unverified",
    lead_campaign_data: [...camps].filter(([, c]) => c.leads.has(id)).map(([cid]) => ({ campaign_id: Number(cid), status: "in_sequence" })),
  });
  const attach = (cid: string, body: { lead_ids: string[]; allow_parallel_sending?: boolean }) => {
    const c = camps.get(cid)!;
    let added = 0;
    for (const id of body.lead_ids) {
      const l = lead(id)!;
      if (l.status === "bounced" || l.status === "unsubscribed") continue;
      if (c.leads.has(id)) continue;
      const busy = (l.lead_campaign_data ?? []).some((e) => String(e.campaign_id) !== cid && e.status === "in_sequence");
      if (busy && !body.allow_parallel_sending) continue;
      c.leads.add(id); added++;
    }
    if (added === 0) throw Object.assign(new Error("No leads were added because they are either in other sequences, have previously bounced, or unsubscribed"), { status: 422 });
  };
  return { camps, lead, attach };
}
async function cycle(force: boolean) {
  const bison = install();
  const target = "100";
  const items = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9"];
  bison.camps.get(target)!.leads.add("l9"); // pushed before, already in
  const ok = new Map<string, Set<string>>(), blocked = new Map<string, Map<string, string>>();
  const setOk = (i: string) => ok.set(i, new Set([target]));
  const setBlocked = (i: string, why: string) => blocked.set(i, new Map([[target, why]]));
  const entries: { item: string; forced: boolean }[] = [];
  for (const i of items) {
    const bl = bison.lead(i);
    const info = (id: string) => { const c = bison.camps.get(id); return c ? { name: c.name, status: c.status } : null; };
    const plan = planTarget({ bisonLead: bl, campaignId: target, clientTag: "AAA", campaignInfo: info, force });
    if (plan.action === "present") setOk(i);
    else if (plan.action === "blocked") setBlocked(i, plan.reason ?? "");
    else entries.push({ item: i, forced: plan.force === true });
  }
  try {
    bison.attach(target, attachBody(entries.map((e) => e.item), force));
    const forcedIds = entries.filter((e) => e.forced).map((e) => e.item);
    const v = await verifyForced({ leadIds: forcedIds, campaignId: target, getLead: async (id: string) => bison.lead(id), sample: 2 });
    for (const e of entries) {
      if (v.missing.has(e.item)) setBlocked(e.item, "not added");
      else setOk(e.item);
    }
  } catch {
    for (const e of entries) {
      try { bison.attach(target, attachBody([e.item], force)); setOk(e.item); } catch { setBlocked(e.item, "refused"); }
    }
  }
  const out = new Map(items.map((i) => [i, itemOutcome({ targets: T(target), attached: ok.get(i) ?? new Set(), blocked: blocked.get(i) ?? new Map() })]));
  const held = bison.camps.get(target)!.leads;
  const lies = items.filter((i) => (out.get(i)?.status === "sent") !== held.has(i));
  return { out, held, lies };
}

console.log("\nsimulated install, parallel ON (the client's choice)");
{
  const { out, held, lies } = await cycle(true);
  eq("recorded 'sent' <=> in the campaign, for every lead", lies, []);
  eq("another client's leads went in (l2, l3, l7), as did the archived-own one (l8)", ["l2", "l3", "l7", "l8"].every((i) => held.has(i)), true);
  eq("bounced and unsubscribed stayed out, with the reason", [out.get("l4")?.error, out.get("l5")?.error],
    ["Bison: the lead is bounced in this workspace", "Bison: the lead is unsubscribed in this workspace"]);
  eq("the lead in this client's other live campaign was not forced in", [held.has("l6"), out.get("l6")?.status], [false, "skipped"]);
  eq("the lead already in the campaign is simply sent", out.get("l9"), { status: "sent", error: null });
}
console.log("\nsimulated install, parallel OFF (the old behaviour, now told truthfully)");
{
  const { out, held, lies } = await cycle(false);
  eq("recorded 'sent' <=> in the campaign, for every lead", lies, []);
  eq("another client's leads stayed out", ["l2", "l3", "l7"].some((i) => held.has(i)), false);
  eq("…recorded as skipped, holder named", out.get("l2"), { status: "skipped", error: "Bison: in sequence in another campaign (BBB) and parallel sending is off" });
  eq("fresh leads still go in", [held.has("l1"), out.get("l1")?.status], [true, "sent"]);
}
console.log("\nthe old worker, for contrast: 2xx = everyone attached");
{
  const bison = install();
  const ids = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];
  bison.attach("100", { lead_ids: ids }); // 2xx: l1 went in
  const recordedSent = ids.length, reallyIn = ids.filter((i) => bison.camps.get("100")!.leads.has(i)).length;
  eq("old: 8 recorded sent, 1 really in (the 18 Nov gap in miniature)", [recordedSent, reallyIn], [8, 1]);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
