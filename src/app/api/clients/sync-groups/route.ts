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

// POST /api/clients/sync-groups — on-demand Bison group re-sync.
//
// Clients get moved between the two Bison groups in the tracker's "Groups" tab,
// but client_tags only picks that up on the 6-hourly client-sync cron (which
// reads a DIFFERENT workbook that has drifted out of date). This button reads
// the Groups tab the team actually maintains and applies group changes now.
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

const SHEET_ID =
  process.env.ONBOARDING_SHEET_ID || "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const GROUPS_TAB_GID = 239723744;

// group -> instance pair. Bare domains, matching EMAILBISON_KEYS / bisonAuthFor.
// Same mapping as scripts/sync-clients-from-sheet.mjs.
const GROUPS: Record<number, { b2b: string; b2c: string }> = {
  1: { b2b: "app.outboundhero.co", b2c: "personal.cleaningoutbound.com" },
  2: { b2b: "app.facilityreach.com", b2c: "personal.outboundclean.com" },
};

const cleanTag = (v: unknown) => String(v ?? "").trim().toUpperCase();

// Reject blanks, header fragments, and — critically — the values that live in
// the Status/Plan columns, so a layout change can never turn one into a client.
const NOT_A_TAG =
  /^(true|false|missing in group|owner|status|notes|active|churned|paused|plan|churn date|not found|healthy|confirmed churn|tier .*)$/i;
const isTag = (v: string) => !!v && !NOT_A_TAG.test(v) && !/^b2[bc]\b/i.test(v);

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
  if (rows.length < 2) {
    return NextResponse.json({ error: "The Groups tab returned no data rows." }, { status: 502 });
  }

  // ── locate the two tag columns by header, not by position ──────────────────
  const header = rows[0].map((h) => String(h ?? ""));
  const colOf = (re: RegExp) => header.findIndex((h) => re.test(h));
  const g1Col = colOf(/b2b\s*#?\s*1/i);
  const g2Col = colOf(/b2b\s*#?\s*2/i);
  if (g1Col < 0 || g2Col < 0) {
    return NextResponse.json(
      {
        error:
          "Could not find the group columns in the Groups tab. Expected headers containing " +
          `"B2B #1" and "B2B #2"; got: ${header.filter(Boolean).join(" | ")}`,
      },
      { status: 502 }
    );
  }

  // tag -> group number. First occurrence wins; a tag listed in both columns
  // keeps group 1 (same precedence as the cron).
  const sheetGroups = new Map<string, number>();
  for (const row of rows.slice(1)) {
    for (const [col, group] of [[g1Col, 1], [g2Col, 2]] as const) {
      const tag = cleanTag(row[col]);
      if (isTag(tag) && !sheetGroups.has(tag)) sheetGroups.set(tag, group);
    }
  }
  if (sheetGroups.size === 0) {
    return NextResponse.json(
      { error: "Refusing to sync: 0 client tags parsed from the Groups tab." },
      { status: 502 }
    );
  }

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
