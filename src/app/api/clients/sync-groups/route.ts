import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import {
  parseServiceAccount,
  getAccessToken,
  tabTitleByGid,
  readRange,
} from "@/lib/google/sheets";
import {
  BISON_GROUPS, GROUPS_TAB_GID, GROUPS_TAB_RENDER, ONBOARDING_SHEET_DEFAULT, churnReport, groupsTabA1,
  lockClientTagsSync, parseGroupsTab, recordGroupsTab,
} from "../../../../../scripts/lib/bison-groups.mjs";

// POST /api/clients/sync-groups — on-demand Bison group re-sync.
//
// Clients get moved between the two Bison groups in the tracker's "Groups" tab.
// Since 2026-11-18 the 6-hourly client-sync cron reads this tab too (over the
// drifted Sheet1 of the allocation workbook, which used to undo moves every run);
// this button applies the tab now instead of at the next cron run.
//
// GROUPS-ONLY, by design:
//   * updates group_no / b2b_instance / b2c_instance / synced_at, and records the
//     read itself (churn dates, see below); nothing else
//   * never INSERTs a tag — roster membership stays the cron's job
//   * never clears an existing mapping (a tag missing from the sheet keeps what
//     it has, same COALESCE semantics as the cron). Moves still apply, because a
//     moved client is still present in the other column.
//
// ⚠ COLUMN LAYOUT — the reason this route does header discovery instead of
// reading A:B like sync-clients-from-sheet.mjs does for its own sheet. The
// Groups tab is:
//     A = group 1 tags | B = Status | C = Churn Date | D = Plan
//     E = group 2 tags | F = Status | G = Churn Date | H = Plan
// Reading A:B would treat "Active"/"Churned" as client tags and create fake
// clients named ACTIVE and CHURNED *with real Bison instance mappings*, which
// would then look sendable in the send-to-Bison wizard.
//
// Churn dates (2026-11-20, migration 132): the tab is read with raw values (a
// date cell comes as a day number). The group updates and the record of the
// read (recordGroupsTab: which clients the tab lists, and each listed client's
// Churn Date cell) are written in ONE transaction, under the lock the three
// readers of the tab share. Nothing is written when the tab cannot be read.
// The record is the one write here that touches clients the tab does not list:
// it marks them "not on the Groups tab", which the sharing and top-up receive
// check reads (fn_client_receive_block). Their groups are still never cleared.

export const maxDuration = 60;

const SHEET_ID = process.env.ONBOARDING_SHEET_ID || ONBOARDING_SHEET_DEFAULT;

// group -> instance pair, and the tab parser (header discovery + the filter that
// rejects Status/Plan values), shared with the client-sync cron and "Sync with
// sheet" so all three read the Groups tab identically (scripts/lib/bison-groups.mjs).
const GROUPS = BISON_GROUPS as Record<number, { b2b: string; b2c: string }>;

export async function POST() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles")
    .select("email, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const saB64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!saB64) {
    return NextResponse.json(
      { error: "GOOGLE_SERVICE_ACCOUNT_B64 is not configured on this service." },
      { status: 503 }
    );
  }

  // ── read the Groups tab (raw values: a date cell comes as a day number) ────
  let rows: unknown[][];
  try {
    const token = await getAccessToken(parseServiceAccount(saB64));
    const title = await tabTitleByGid(token, SHEET_ID, GROUPS_TAB_GID);
    rows = await readRange(token, SHEET_ID, groupsTabA1(title), GROUPS_TAB_RENDER);
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read the Groups sheet: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }
  // ── tag -> group, columns located by header (scripts/lib/bison-groups.mjs) ──
  // First occurrence wins; a tag listed in both columns keeps group 1.
  const parsed = parseGroupsTab(rows);
  if (parsed.error || !parsed.groups) {
    const msg = parsed.error ?? "no groups parsed";
    return NextResponse.json(
      { error: msg.startsWith("0 client tags") ? `Refusing to sync: ${msg}` : msg },
      { status: 502 }
    );
  }
  const sheetGroups = parsed.groups as Map<string, number>;

  // ── compare against client_tags and apply, in one transaction ─────────────
  const gained: string[] = [];
  const moved: Array<{ tag: string; from: number; to: number }> = [];
  const notInDb: string[] = [];
  let unchanged = 0;
  let missingFromSheet: string[] = [];
  let record: Awaited<ReturnType<typeof recordGroupsTab>> | null = null;

  const conn = await getPool().connect();
  try {
    await conn.query("begin");
    await lockClientTagsSync(conn);
    const { rows: existing } = await conn.query<{
      tag: string; group_no: number | null; b2b_instance: string | null; b2c_instance: string | null;
    }>(`select tag, group_no, b2b_instance, b2c_instance from client_tags`);
    const byTag = new Map(existing.map((r) => [r.tag, r]));

    const updates: Array<{ tag: string; group: number }> = [];
    for (const [tag, group] of sheetGroups) {
      const row = byTag.get(tag);
      if (!row) { notInDb.push(tag); continue; }          // never INSERT: the cron's job
      const current = row.group_no;
      const needsInstances = !row.b2b_instance || !row.b2c_instance;
      if (current === group && !needsInstances) { unchanged++; continue; }
      updates.push({ tag, group });
      if (current == null) gained.push(tag);
      else if (current !== group) moved.push({ tag, from: current, to: group });
      else unchanged++; // group already right, only backfills the instance pair
    }
    if (updates.length) {
      await conn.query(
        `update client_tags ct
            set group_no = u.group_no, b2b_instance = u.b2b, b2c_instance = u.b2c, synced_at = now()
           from unnest($1::text[], $2::int[], $3::text[], $4::text[]) as u(tag, group_no, b2b, b2c)
          where ct.tag = u.tag`,
        [
          updates.map((u) => u.tag), updates.map((u) => u.group),
          updates.map((u) => GROUPS[u.group].b2b), updates.map((u) => GROUPS[u.group].b2c),
        ]
      );
    }

    // Tags with a mapping that are absent from the sheet: reported, never cleared.
    missingFromSheet = existing
      .filter((r) => r.group_no != null && !sheetGroups.has(r.tag))
      .map((r) => r.tag);

    // The read itself (132): every client listed or not, each listed client's churn cell.
    record = await recordGroupsTab(conn, parsed);
    await conn.query("commit");
  } catch (e) {
    await conn.query("rollback").catch(() => {});
    return NextResponse.json(
      { error: `Group sync failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  } finally {
    conn.release();
  }

  const churn = churnReport(parsed);
  const recorded = record?.recorded ?? null;
  const warnings = record?.warning ? [record.warning] : [];
  await logAudit({
    action: "Client Groups Synced",
    performedBy: profile.email ?? user.id,
    details:
      `${sheetGroups.size} tags in sheet · ${gained.length} gained a mapping · ` +
      `${moved.length} moved · ${unchanged} unchanged · ${notInDb.length} not in client_tags · ` +
      (recorded
        ? `Groups tab: ${recorded.listed} listed, ${churn.dates.length} churn dates, ${churn.unreadable.length} unreadable`
        : "Groups tab: not recorded"),
  });

  return NextResponse.json({
    ok: true,
    sheetTags: sheetGroups.size,
    gained,
    moved,
    unchanged,
    notInDb,
    missingFromSheet,
    warnings,
    groupsTab: { ...churn, recorded },
  });
}
