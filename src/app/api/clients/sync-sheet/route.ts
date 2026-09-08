import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getPool } from "@/lib/db/pool";
import { logAudit } from "@/lib/api/log-audit";
import { parseServiceAccount, getAccessToken, sheetsGet, readRange } from "@/lib/google/sheets";

// POST /api/clients/sync-sheet — on-demand FULL client sync, same merge as the
// 6-hourly client-sync cron (scripts/sync-clients-from-sheet.mjs), so a client
// added or churned in the sheet shows up now instead of within 6 hours.
//
// Sources, merged in cron order:
//   1. CLIENTS_SHEET_ID "Sheet1" cols A/B      -> tags + group/instance pair
//   2. optional owner/status tab (same book)    -> owner, status
//   3. tracker "Client Tracker" tab             -> full roster + name + health
//   4. tracker "Onboarding Form Responses" tab  -> status (authoritative) + type
// Then one transaction: upsert-with-COALESCE (a roster-only row never clears an
// instance mapping) and delete tags absent from every sheet — identical
// semantics to the cron, so running both concurrently converges to the same row.

export const maxDuration = 120;

const cleanTag = (v: unknown) => String(v ?? "").trim().toUpperCase();
const isTag = (v: string) =>
  !!v && !/^(true|false|missing in group|owner|status|notes)$/i.test(v) && !/^b2[bc]\b/i.test(v);

const GROUPS: Record<number, { b2b: string; b2c: string }> = {
  1: { b2b: "app.outboundhero.co", b2c: "personal.cleaningoutbound.com" },
  2: { b2b: "app.facilityreach.com", b2c: "personal.outboundclean.com" },
};

interface ClientRow {
  tag: string;
  group_no: number | null;
  b2b: string | null;
  b2c: string | null;
  owner?: string | null;
  status?: string | null;
  name?: string | null;
  client_type?: string | null;
  source?: string | null;
}

export async function POST() {
  const server = await createClient();
  const { data: { user } } = await server.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("user_profiles").select("email, role").eq("id", user.id).single();
  if (!profile || !["owner", "admin", "manager"].includes(profile.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const saB64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  const sheetId = process.env.CLIENTS_SHEET_ID;
  if (!saB64 || !sheetId) {
    return NextResponse.json(
      { error: "GOOGLE_SERVICE_ACCOUNT_B64 / CLIENTS_SHEET_ID are not configured on this service." },
      { status: 503 }
    );
  }

  const clients = new Map<string, ClientRow>();
  const warnings: string[] = [];
  try {
    const token = await getAccessToken(parseServiceAccount(saB64));

    // 1. Groups sheet: two columns of tags.
    const rows = await readRange(token, sheetId, "Sheet1!A1:B400");
    for (const row of rows.slice(1)) {
      for (const [col, group] of [[0, 1], [1, 2]] as const) {
        const tag = cleanTag(row[col]);
        if (isTag(tag) && !clients.has(tag)) {
          clients.set(tag, { tag, group_no: group, ...GROUPS[group], source: "groups_sheet" });
        }
      }
    }

    // 2. Optional owner/status tab in the same workbook.
    try {
      const meta = await sheetsGet<{ sheets?: Array<{ properties?: { title?: string } }> }>(
        token, `${sheetId}?fields=sheets.properties.title`
      );
      const extra = (meta.sheets ?? [])
        .map((s) => s.properties?.title ?? "")
        .find((t) => /project|added|owner/i.test(t));
      if (extra) {
        const ex = await readRange(token, sheetId, `'${extra.replace(/'/g, "''")}'!A1:K400`);
        for (const row of ex.slice(1)) {
          for (const [tCol, oCol, sCol] of [[0, 1, 2], [5, 6, 7]] as const) {
            const c = clients.get(cleanTag(row[tCol]));
            if (c) {
              if (row[oCol]) c.owner = String(row[oCol]).trim();
              if (row[sCol]) c.status = String(row[sCol]).trim();
            }
          }
        }
      }
    } catch (e) {
      warnings.push(`owner/status tab skipped: ${e instanceof Error ? e.message : e}`);
    }

    // 3 + 4. Client Tracker roster + Onboarding statuses/types.
    const trackerId = process.env.CLIENT_TRACKER_SHEET_ID;
    if (trackerId) {
      const tv = await readRange(token, trackerId, "'Client Tracker'!A1:H1000");
      for (const row of tv.slice(1)) {
        const name = (row[0] ?? "").trim();
        const health = (row[7] ?? "").trim();
        for (const raw of (row[1] ?? "").trim().split(/\s*&\s*/)) {
          const tag = cleanTag(raw);
          if (!isTag(tag)) continue;
          const existing = clients.get(tag);
          if (existing) {
            if (name) existing.name = name;
            if (health) existing.status = health;
          } else {
            clients.set(tag, {
              tag, group_no: null, b2b: null, b2c: null,
              name: name || null, status: health || null, source: "tracker",
            });
          }
        }
      }
      try {
        const ob = await readRange(token, trackerId, "'Onboarding Form Responses'!A1:F3000");
        for (const row of ob.slice(1)) {
          const status = (row[4] ?? "").trim();
          const clientType = (row[5] ?? "").trim();
          for (const raw of (row[0] ?? "").trim().split(/\s*&\s*|\s*\/\s*/)) {
            const c = clients.get(cleanTag(raw));
            if (!c) continue;
            if (status) c.status = status;
            if (clientType) c.client_type = clientType;
          }
        }
      } catch (e) {
        warnings.push(`Onboarding tab skipped: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      warnings.push("CLIENT_TRACKER_SHEET_ID not set — roster/status merge skipped.");
    }
  } catch (e) {
    return NextResponse.json(
      { error: `Could not read the client sheets: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }

  const list = [...clients.values()];
  if (list.length === 0) {
    return NextResponse.json(
      { error: "Refusing to sync: 0 client tags parsed (sheet read likely failed)." },
      { status: 502 }
    );
  }

  // Diff base, so the response can say what actually changed.
  const { data: before, error: readErr } = await admin
    .from("client_tags").select("tag, status, group_no");
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  const beforeByTag = new Map((before ?? []).map((r) => [r.tag as string, r]));

  const pool = getPool();
  const conn = await pool.connect();
  let removed = 0;
  try {
    await conn.query("begin");
    await conn.query(
      `insert into client_tags (tag, group_no, b2b_instance, b2c_instance, owner, status, name, client_type, source, synced_at)
       select * from unnest($1::text[], $2::int[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], array_fill(now(), array[$10::int]))
       on conflict (tag) do update set
         group_no = coalesce(excluded.group_no, client_tags.group_no),
         b2b_instance = coalesce(excluded.b2b_instance, client_tags.b2b_instance),
         b2c_instance = coalesce(excluded.b2c_instance, client_tags.b2c_instance),
         owner = coalesce(excluded.owner, client_tags.owner),
         status = coalesce(excluded.status, client_tags.status),
         name = coalesce(excluded.name, client_tags.name),
         client_type = coalesce(excluded.client_type, client_tags.client_type),
         source = case when excluded.group_no is not null then excluded.source else client_tags.source end,
         synced_at = now()`,
      [
        list.map((c) => c.tag), list.map((c) => c.group_no), list.map((c) => c.b2b),
        list.map((c) => c.b2c), list.map((c) => c.owner ?? null), list.map((c) => c.status ?? null),
        list.map((c) => c.name ?? null), list.map((c) => c.client_type ?? null),
        list.map((c) => c.source ?? null), list.length,
      ]
    );
    const del = await conn.query(
      `delete from client_tags where tag <> all($1::text[])`,
      [list.map((c) => c.tag)]
    );
    removed = del.rowCount ?? 0;
    await conn.query("commit");
  } catch (e) {
    await conn.query("rollback").catch(() => {});
    return NextResponse.json(
      { error: `Sync failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 }
    );
  } finally {
    conn.release();
  }

  const added: string[] = [];
  const statusChanged: Array<{ tag: string; from: string | null; to: string | null }> = [];
  for (const c of list) {
    const b = beforeByTag.get(c.tag);
    if (!b) { added.push(c.tag); continue; }
    const to = c.status ?? (b.status as string | null);
    if ((b.status ?? null) !== (to ?? null)) {
      statusChanged.push({ tag: c.tag, from: (b.status as string | null) ?? null, to: to ?? null });
    }
  }

  await logAudit({
    action: "Clients Synced From Sheet",
    performedBy: profile.email ?? user.id,
    details:
      `${list.length} tags in sheets · ${added.length} added · ` +
      `${statusChanged.length} status changes · ${removed} removed`,
  });

  return NextResponse.json({
    ok: true,
    total: list.length,
    added,
    statusChanged,
    removed,
    warnings,
  });
}
