import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logAudit } from "@/lib/api/log-audit";
import { getPool } from "@/lib/db/pool";
import {
  parseServiceAccount,
  getAccessToken,
  tabTitleByGid,
  readRange,
} from "@/lib/google/sheets";

// Client RULES sync (the AI one). Deliberately separate from
// /api/clients/sync-groups, which is instant and free — this one can spend money,
// so it is its own button and always previews first.
//
//   GET  ?preview=1  which clients' onboarding text changed, and the AI cost
//   GET              the latest jobs, for the progress panel
//   POST             queue a job (the worker picks it up within ~5s)
//
// The work itself runs in scripts/sync-client-targeting-from-sheet.mjs --serve
// on an always-on Railway service, so closing the tab never interrupts it —
// same model as the Bison push worker.

export const maxDuration = 60;

const SHEET_ID =
  process.env.ONBOARDING_SHEET_ID || "1MGqSgGNoeN6WgjZnT7_Ij_nZftyyj7Z9DT77rVYLKuQ";
const ONBOARDING_TAB_GID = 581954884;

// Rough per-client estimate from observed runs: one gpt-4o location call plus
// one gpt-4o exclusion call dominate; taxonomy matching is batched on mini.
// Deliberately generous so the number shown is never a surprise underestimate.
const EST_USD_PER_CLIENT = 0.05;

const cleanTag = (v: unknown) => String(v ?? "").trim().toUpperCase();

function splitClientTag(tag: string): string[] {
  for (const sep of [" & ", " / ", " AND "]) {
    const i = tag.indexOf(sep);
    if (i === -1) continue;
    const l = tag.slice(0, i).trim();
    const r = tag.slice(i + sep.length).trim();
    if (l.length >= 3 && r.length >= 3) return [l, r];
  }
  return [tag];
}

async function requireRole(allowed: string[]) {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles").select("email, role").eq("id", user.id).single();
  if (!profile || !allowed.includes(profile.role)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { user, profile, admin };
}

/**
 * Which clients would actually be re-parsed. A client is only re-parsed when the
 * verbatim text in its onboarding row differs from what was stored last time
 * (client_targeting.sheet_raw) — everyone else is skipped and costs nothing,
 * which is what makes re-clicking this button safe.
 */
async function computeChanged(): Promise<
  { tags: string[]; totalInSheet: number; unmatched: number }
> {
  const saB64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  if (!saB64) throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 is not configured on this service.");

  const token = await getAccessToken(parseServiceAccount(saB64));
  const title = await tabTitleByGid(token, SHEET_ID, ONBOARDING_TAB_GID);
  const rows = await readRange(token, SHEET_ID, `'${title.replace(/'/g, "''")}'!A1:R3000`);
  if (rows.length < 2) throw new Error("The onboarding tab returned no data rows.");

  // Same header discovery the sync script uses — the sheet has gained columns
  // before, so never address them by position.
  const header = rows[0].map((h) => String(h ?? "").toLowerCase());
  const findCol = (needle: string) => header.findIndex((h) => h.includes(needle));
  const dataCount = (i: number) => rows.slice(1).filter((r) => String(r[i] ?? "").trim()).length;
  const tagCol = findCol("client abbreviation");
  const targetCol = findCol("target industries");
  const locationsCol = findCol("inclusion locations");
  const exclusionCol = header
    .map((h, i) => (h.includes("exclusion industries") ? i : -1))
    .filter((i) => i >= 0)
    .sort((a, b) => dataCount(b) - dataCount(a))[0] ?? -1;
  if (tagCol < 0 || targetCol < 0 || exclusionCol < 0 || locationsCol < 0) {
    throw new Error("Could not find the expected columns in the onboarding sheet.");
  }

  const sheetClients = new Map<string, { target: string; exclusion: string; locations: string }>();
  for (const row of rows.slice(1)) {
    const raw = cleanTag(row[tagCol]);
    if (!raw) continue;
    for (const tag of splitClientTag(raw)) {
      sheetClients.set(tag, {
        target: String(row[targetCol] ?? "").trim(),
        exclusion: String(row[exclusionCol] ?? "").trim(),
        locations: String(row[locationsCol] ?? "").trim(),
      });
    }
  }

  const pool = getPool();
  const { rows: known } = await pool.query<{ tag: string }>(`select tag from client_tags`);
  const knownTags = new Set(known.map((r) => r.tag));
  const { rows: existing } = await pool.query<{ client_tag: string; sheet_raw: unknown }>(
    `select client_tag, sheet_raw from client_targeting`
  );
  const rawByTag = new Map(existing.map((r) => [r.client_tag, r.sheet_raw]));

  const tags: string[] = [];
  let unmatched = 0;
  for (const [tag, cur] of sheetClients) {
    if (!knownTags.has(tag)) { unmatched++; continue; }
    const stored = rawByTag.get(tag) ?? null;
    if (JSON.stringify(stored) !== JSON.stringify(cur)) tags.push(tag);
  }
  return { tags: tags.sort(), totalInSheet: sheetClients.size, unmatched };
}

export async function GET(request: NextRequest) {
  const gate = await requireRole(["owner", "admin", "manager"]);
  if ("error" in gate) return gate.error;

  if (request.nextUrl.searchParams.get("preview") === "1") {
    try {
      const { tags, totalInSheet, unmatched } = await computeChanged();
      return NextResponse.json({
        changed: tags,
        changedCount: tags.length,
        totalInSheet,
        unmatched,
        estimatedCostUsd: Number((tags.length * EST_USD_PER_CLIENT).toFixed(2)),
      });
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Preview failed" },
        { status: 502 }
      );
    }
  }

  const { data, error } = await gate.admin
    .from("targeting_sync_jobs")
    .select("id, status, client_tags, total, processed, synced, failed, ai_calls, ai_cost_usd, phase, error, log, created_at, started_at, completed_at")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(request: NextRequest) {
  const gate = await requireRole(["owner", "admin", "manager"]);
  if ("error" in gate) return gate.error;

  let body: { clientTags?: string[] };
  try { body = await request.json(); } catch { body = {}; }

  // Never queue a second job on top of a running one — two syncs writing the
  // same client_targeting rows would race, and the AI spend would double.
  const { data: active } = await gate.admin
    .from("targeting_sync_jobs")
    .select("id, status")
    .in("status", ["pending", "running"])
    .limit(1);
  if (active && active.length > 0) {
    return NextResponse.json(
      { error: "A rules sync is already running. Wait for it to finish.", jobId: active[0].id },
      { status: 409 }
    );
  }

  const tags = Array.isArray(body.clientTags)
    ? [...new Set(body.clientTags.map(cleanTag).filter(Boolean))]
    : [];
  if (tags.length === 0) {
    return NextResponse.json(
      { error: "Nothing to sync — no client's onboarding answers have changed." },
      { status: 400 }
    );
  }

  const { data: job, error } = await gate.admin
    .from("targeting_sync_jobs")
    .insert({
      status: "pending",
      client_tags: tags,
      total: tags.length * 2 + 1,
      created_by: gate.user.id,
      phase: "Queued",
    })
    .select("id")
    .single();
  if (error || !job) {
    return NextResponse.json({ error: error?.message ?? "Could not queue the sync" }, { status: 500 });
  }

  await logAudit({
    action: "Client Rules Sync Queued",
    performedBy: gate.profile.email ?? gate.user.id,
    details: `${tags.length} client(s): ${tags.slice(0, 20).join(", ")}${tags.length > 20 ? "…" : ""}`,
  });

  return NextResponse.json({ jobId: job.id, queued: tags.length });
}
