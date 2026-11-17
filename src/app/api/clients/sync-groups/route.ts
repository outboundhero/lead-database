import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/api/log-audit";
import {
  parseServiceAccount,
  getAccessToken,
  tabTitleByGid,
  readRange,
} from "@/lib/google/sheets";
import {
  BISON_GROUPS, GROUPS_TAB_GID, ONBOARDING_SHEET_DEFAULT, parseGroupsTab,
} from "../../../../../scripts/lib/bison-groups.mjs";

// POST /api/clients/sync-groups — on-demand Bison group re-sync.
//
// Clients get moved between the two Bison groups in the tracker's "Groups" tab.
// Since 2026-11-18 the 6-hourly client-sync cron reads this tab too (over the
// drifted Sheet1 of the allocation workbook, which used to undo moves every run);
// this button applies the tab now instead of at the next cron run.
//
// GROUPS-ONLY, by design:
//   * updates group_no / b2b_instance / b2c_instance / synced_at and nothing else
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

  // ── read the Groups tab ────────────────────────────────────────────────────
  let rows: string[][];
  try {
    const token = await getAccessToken(parseServiceAccount(saB64));
    const title = await tabTitleByGid(token, SHEET_ID, GROUPS_TAB_GID);
    rows = await readRange(token, SHEET_ID, `'${title.replace(/'/g, "''")}'!A1:L400`);
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

  // ── compare against client_tags ───────────────────────────────────────────
  const { data: existing, error: readErr } = await admin
    .from("client_tags")
    .select("tag, group_no, b2b_instance, b2c_instance");
  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 });
  }
  const byTag = new Map((existing ?? []).map((r) => [r.tag as string, r]));

  const gained: string[] = [];
  const moved: Array<{ tag: string; from: number; to: number }> = [];
  const notInDb: string[] = [];
  let unchanged = 0;

  for (const [tag, group] of sheetGroups) {
    const row = byTag.get(tag);
    if (!row) { notInDb.push(tag); continue; }          // never INSERT — cron's job
    const current = row.group_no as number | null;
    const pair = GROUPS[group];
    const needsInstances = !row.b2b_instance || !row.b2c_instance;
    if (current === group && !needsInstances) { unchanged++; continue; }

    const { error: updErr } = await admin
      .from("client_tags")
      .update({
        group_no: group,
        b2b_instance: pair.b2b,
        b2c_instance: pair.b2c,
        synced_at: new Date().toISOString(),
      })
      .eq("tag", tag);
    if (updErr) {
      return NextResponse.json(
        { error: `Failed updating ${tag}: ${updErr.message}` },
        { status: 500 }
      );
    }
    if (current == null) gained.push(tag);
    else if (current !== group) moved.push({ tag, from: current, to: group });
    else unchanged++; // group already right, only backfilled the instance pair
  }

  // Tags with a mapping that are absent from the sheet: reported, never cleared.
  const missingFromSheet = (existing ?? [])
    .filter((r) => r.group_no != null && !sheetGroups.has(r.tag as string))
    .map((r) => r.tag as string);

  await logAudit({
    action: "Client Groups Synced",
    performedBy: profile.email ?? user.id,
    details:
      `${sheetGroups.size} tags in sheet · ${gained.length} gained a mapping · ` +
      `${moved.length} moved · ${unchanged} unchanged · ${notInDb.length} not in client_tags`,
  });

  return NextResponse.json({
    ok: true,
    sheetTags: sheetGroups.size,
    gained,
    moved,
    unchanged,
    notInDb,
    missingFromSheet,
  });
}
