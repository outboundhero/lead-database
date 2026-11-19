#!/usr/bin/env node
// sync-clients-from-sheet.mjs — mirror the client-groups sheet into client_tags.
//
// Sheet (CLIENTS_SHEET_ID, "Sheet1"): header row
//   "B2B #1 (OutboundHero) & B2C #1 (CleaningOutbound)"  -> group 1 tags (col A)
//   "B2B #2 (FacilityReach) & B2C #2 (OutboundClean)"    -> group 2 tags (col B)
// Each subsequent row's cell is ONE client tag. group -> instance pair:
//   group 1: b2b app.outboundhero.co     / b2c personal.cleaningoutbound.com
//   group 2: b2b app.facilityreach.com   / b2c personal.outboundclean.com
// A second tab may carry owner + status ("Churned") keyed by tag; merged in.
//
// Auth reuses the taxonomy sync's service-account JWT + private_key sanitizer.
//
// Also merges the "Client Tracker" tab of CLIENT_TRACKER_SHEET_ID (col A =
// Company Name, col B = Client Abbreviation — may hold "&"-joined tags, col H =
// Health). This adds the FULL client roster (incl. churned clients, which have
// no instance mapping) so the send-wizard knows every tag.
//
// GROUPS (2026-11-18): the tracker's "Groups" tab (ONBOARDING_SHEET_ID, the tab
// the team keeps current and the "Sync groups" button reads) decides the group of
// every roster tag it lists; Sheet1 only fills tags the tab does not list. Sheet1
// had drifted — CCGNWA and CCHS were group 2 there but group 1 in the tab and in
// Bison — and every run of this cron put the old group back.
//
// CHURN DATES (2026-11-20, migration 132): the Groups tab is read with raw
// values (GROUPS_TAB_RENDER: a date cell comes as a day number, whatever the
// sheet shows), and each good read also records, in the same transaction as
// the group writes, which clients the tab lists and the Churn Date cell of
// each one it lists (recordGroupsTab in scripts/lib/bison-groups.mjs). A client
// the tab does not list, or whose churn date is within 15 days, cannot receive
// shared leads or top-up pulls. A tab that cannot be read records nothing, so
// the last good read stands.
//
// Env: GOOGLE_SERVICE_ACCOUNT_B64, CLIENTS_SHEET_ID, CLIENT_TRACKER_SHEET_ID, DATABASE_URL,
//      ONBOARDING_SHEET_ID (optional; defaults to the tracker workbook)
// Usage:
//   node scripts/sync-clients-from-sheet.mjs
//   node scripts/sync-clients-from-sheet.mjs --dry-run   (writes nothing; also prints the group changes a
//     real run would make, the churn dates, the non-answers, the unreadable churn cells, the tags listed
//     twice, and every Active or Healthy client the Groups tab does not list)
// scripts/test-churn-dates.mjs runs main() with the sheets stubbed and its own database client.

import crypto from "node:crypto";
import pg from "pg";
import {
  BISON_GROUPS, GROUPS_TAB_GID, GROUPS_TAB_RENDER, ONBOARDING_SHEET_DEFAULT, churnReport, groupsTabA1, isActiveStatus,
  lockClientTagsSync, parseGroupsTab, recordGroupsTab,
} from "./lib/bison-groups.mjs";

const DRY = process.argv.includes("--dry-run");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Group -> instance pair. Bare domains (match bisonAuthFor / EMAILBISON_KEYS keys).
const GROUPS = BISON_GROUPS;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    })
  );
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).access_token;
}

async function sheetsGet(token, path) {
  const backoffMs = [2000, 8000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 403) throw new Error("403 from Google Sheets — share the sheet with the service account email (Viewer is enough).");
    if ((res.status === 429 || res.status >= 500) && attempt < backoffMs.length) {
      console.warn(`  Sheets API HTTP ${res.status}, retrying in ${backoffMs[attempt] / 1000}s…`);
      await sleep(backoffMs[attempt]);
      continue;
    }
    if (!res.ok) throw new Error(`Sheets API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

const cleanTag = (v) => String(v ?? "").trim().toUpperCase();
// Not a real client tag: blank, obvious header fragments, or boolean junk.
const isTag = (v) => v && !/^(true|false|missing in group|owner|status|notes)$/i.test(v) && !/^b2[bc]\b/i.test(v);

/** The database for one run (the test hands in a client of its own). */
async function connectDb(env) {
  const db = new pg.Client({ connectionString: env.DATABASE_URL });
  await db.connect();
  return db;
}

/** Tag and cell, for the dry run's lists. */
const cellList = (xs) => xs.map((x) => `${x.tag} ${JSON.stringify(x.cell ?? "")}`).join(", ") || "none";

/**
 * One run. env: the environment (GOOGLE_SERVICE_ACCOUNT_B64, the sheet ids,
 * DATABASE_URL); dry: --dry-run; connect(env): the database client, which
 * gets "begin", "commit", "rollback" and end() as from pg.
 */
export async function main({ env = process.env, dry = DRY, connect = connectDb } = {}) {
  const saB64 = env.GOOGLE_SERVICE_ACCOUNT_B64;
  const sheetId = env.CLIENTS_SHEET_ID;
  if (!saB64 || !sheetId) throw new Error("GOOGLE_SERVICE_ACCOUNT_B64 and CLIENTS_SHEET_ID must be set.");
  const rawJson = Buffer.from(saB64, "base64").toString("utf8").trim();
  let sa;
  try {
    sa = JSON.parse(rawJson);
  } catch {
    sa = JSON.parse(
      rawJson.replace(/("private_key"\s*:\s*")([\s\S]*?)("\s*[,}])/, (_, open, key, close) =>
        open + key.replace(/\r/g, "").replace(/\n/g, "\\n") + close)
    );
  }
  console.log(`service account: ${sa.client_email}`);
  const token = await getAccessToken(sa);

  // Primary tab: two columns of tags (group 1 = A, group 2 = B).
  const grid = await sheetsGet(token, `${sheetId}/values/${encodeURIComponent("Sheet1!A1:B400")}`);
  const rows = grid.values ?? [];
  const clients = new Map(); // tag -> { tag, group_no, ...instances }
  for (const row of rows.slice(1)) {
    for (const [col, group] of [[0, 1], [1, 2]]) {
      const tag = cleanTag(row[col]);
      if (isTag(tag) && !clients.has(tag)) {
        clients.set(tag, { tag, group_no: group, ...GROUPS[group] });
      }
    }
  }

  // Optional owner/status tab ("Project Added …"): tag in col A/F, owner col B/G,
  // status col C/H. Best-effort — merged only when the tag is already known.
  try {
    const meta = await sheetsGet(token, `${sheetId}?fields=sheets.properties.title`);
    const extra = (meta.sheets ?? []).map((s) => s.properties.title).find((t) => /project|added|owner/i.test(t));
    if (extra) {
      const ex = await sheetsGet(token, `${sheetId}/values/${encodeURIComponent(`'${extra.replace(/'/g, "''")}'!A1:K400`)}`);
      for (const row of (ex.values ?? []).slice(1)) {
        for (const [tCol, oCol, sCol] of [[0, 1, 2], [5, 6, 7]]) {
          const tag = cleanTag(row[tCol]);
          const c = clients.get(tag);
          if (c) {
            if (row[oCol]) c.owner = String(row[oCol]).trim();
            if (row[sCol]) c.status = String(row[sCol]).trim();
          }
        }
      }
    }
  } catch (e) {
    console.warn(`  owner/status tab skipped: ${e.message}`);
  }

  // Every groups-sheet client has an instance mapping.
  for (const c of clients.values()) c.source = "groups_sheet";

  // ── Client Tracker: full roster + name + health (churned clients too) ──────
  const trackerId = env.CLIENT_TRACKER_SHEET_ID;
  if (trackerId) {
    try {
      const tv = await sheetsGet(token, `${trackerId}/values/${encodeURIComponent("'Client Tracker'!A1:H1000")}`);
      let added = 0;
      for (const row of (tv.values ?? []).slice(1)) {
        const name = (row[0] ?? "").trim();
        const abbr = (row[1] ?? "").trim();
        const health = (row[7] ?? "").trim(); // col H — legacy status fallback
        if (!abbr) continue;
        // Abbreviation cells can hold several "&"-joined tags (e.g. "CPGH & CPGA").
        for (const raw of abbr.split(/\s*&\s*/)) {
          const tag = cleanTag(raw);
          if (!isTag(tag)) continue;
          const existing = clients.get(tag);
          if (existing) {
            // groups-sheet client: enrich with name + health, keep instances.
            if (name) existing.name = name;
            if (health) existing.status = health;
          } else {
            // roster-only (typically churned): no instance mapping.
            clients.set(tag, { tag, group_no: null, b2b: null, b2c: null, name: name || null, status: health || null, source: "tracker" });
            added++;
          }
        }
      }
      // Onboarding Form Responses tab (same workbook): col A = abbreviation,
      // col E = Status (Active/Churned/Not Found — AUTHORITATIVE, overrides
      // health), col F = Client Type (Cleaning/Non-Cleaning). Later rows win
      // (form resubmissions append).
      try {
        const ob = await sheetsGet(token, `${trackerId}/values/${encodeURIComponent("'Onboarding Form Responses'!A1:F3000")}`);
        let typed = 0;
        for (const row of (ob.values ?? []).slice(1)) {
          const abbr = (row[0] ?? "").trim();
          const status = (row[4] ?? "").trim();
          const clientType = (row[5] ?? "").trim();
          if (!abbr) continue;
          for (const raw of abbr.split(/\s*&\s*|\s*\/\s*/)) {
            const tag = cleanTag(raw);
            const c = clients.get(tag) ?? (tag.includes("&") ? null : clients.get(tag));
            if (!c) continue;
            if (status) c.status = status;
            if (clientType) { c.client_type = clientType; typed++; }
          }
        }
        console.log(`Onboarding tab merged: status/type applied (${typed} typed).`);
      } catch (e) {
        console.warn(`  Onboarding tab skipped: ${e.message}`);
      }
      console.log(`Client Tracker merged: +${added} roster-only tags.`);
    } catch (e) {
      console.warn(`  Client Tracker skipped: ${e.message}`);
    }
  } else {
    console.warn("  CLIENT_TRACKER_SHEET_ID not set — skipping roster merge (instance-mapped tags only).");
  }

  // ── Groups tab: the group the team keeps current wins over Sheet1 ──────────
  // Tags only in the tab are not added (the roster stays Sheet1 + Client
  // Tracker, as with the "Sync groups" button). If the tab cannot be read, NO
  // group is written this run: the COALESCE upsert below then keeps every saved
  // group instead of restoring Sheet1's stale ones. Nor is any churn date: the
  // last good read stands.
  const groupsSheetId = env.ONBOARDING_SHEET_ID || ONBOARDING_SHEET_DEFAULT;
  let groupsTab = null; // parseGroupsTab()'s answer, set only when the tab was read
  try {
    const meta = await sheetsGet(token, `${groupsSheetId}?fields=sheets.properties(sheetId,title)`);
    const title = (meta.sheets ?? []).map((s) => s.properties).find((p) => p?.sheetId === GROUPS_TAB_GID)?.title;
    if (!title) throw new Error(`no tab with gid ${GROUPS_TAB_GID}`);
    const gv = await sheetsGet(
      token,
      `${groupsSheetId}/values/${encodeURIComponent(groupsTabA1(title))}?${new URLSearchParams(GROUPS_TAB_RENDER)}`
    );
    const parsed = parseGroupsTab(gv.values ?? []);
    if (parsed.error) throw new Error(parsed.error);
    const overrides = [], filled = [], notInRoster = [];
    for (const [tag, group] of parsed.groups) {
      const c = clients.get(tag);
      if (!c) { notInRoster.push(tag); continue; }
      if (c.group_no == null) filled.push(tag);
      else if (c.group_no !== group) overrides.push(`${tag} ${c.group_no}→${group}`);
      Object.assign(c, { group_no: group, ...GROUPS[group], source: "groups_tab" });
    }
    console.log(
      `Groups tab "${title}": ${parsed.groups.size} tags — overrides Sheet1 for ${overrides.length} (${overrides.join(", ") || "none"}), ` +
      `maps ${filled.length} tracker-only tags, ${notInRoster.length} not in any roster (${notInRoster.join(", ") || "none"}).`
    );
    const churn = churnReport(parsed);
    if (churn.read) {
      console.log(
        `Groups tab churn cells: ${churn.dates.length} dates, ${churn.nonAnswers.length} non-answers, ` +
        `${churn.unreadable.length} unreadable (${churn.unreadable.map((x) => x.tag).join(", ") || "none"}), ${churn.blank} blank; ` +
        `listed twice: ${churn.duplicates.join(", ") || "none"}.`
      );
    } else {
      console.warn(`  ${churn.error} No churn record this run; the last good read stands.`);
    }
    groupsTab = parsed;
  } catch (e) {
    for (const c of clients.values()) { c.group_no = null; c.b2b = null; c.b2c = null; }
    console.warn(
      `  Groups tab unreadable (${e.message}): writing NO groups and no churn dates this run; ` +
      "every saved group and the last good read are kept."
    );
  }

  const list = [...clients.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  const mapped = list.filter((c) => c.group_no != null).length;
  console.log(`${list.length} client tags total — ${mapped} instance-mapped, ${list.length - mapped} roster-only (churned/unmapped).`);

  if (dry) {
    // Read-only preview of what a real run would change in client_tags.
    const db = await connect(env);
    try {
      await db.query("begin read only");
      const { rows } = await db.query("select tag, group_no, status from client_tags");
      const saved = new Map(rows.map((r) => [r.tag, r.group_no]));
      const listed = new Set(list.map((c) => c.tag));
      const moves = list.filter((c) => c.group_no != null && saved.has(c.tag) && saved.get(c.tag) !== c.group_no)
        .map((c) => `${c.tag} ${saved.get(c.tag) ?? "-"}→${c.group_no}`);
      const added = list.filter((c) => !saved.has(c.tag)).map((c) => c.tag);
      const stale = rows.filter((r) => !listed.has(r.tag)).map((r) => r.tag);
      console.log(`--dry-run: a real run would change ${moves.length} group(s): ${moves.join(", ") || "none"}`);
      console.log(`--dry-run: add ${added.length} tag(s): ${added.join(", ") || "none"}; remove ${stale.length} stale: ${stale.join(", ") || "none"}`);
      // Churn dates: what a real run would record. A client keeps the status
      // the sheets give it, else the saved one (the upsert's COALESCE).
      if (!groupsTab) {
        console.log("--dry-run: the Groups tab could not be read, so a real run would record no churn date (the last good read stands).");
      } else {
        const churn = churnReport(groupsTab);
        if (churn.read) {
          console.log(`--dry-run: churn dates (${churn.dates.length}): ${churn.dates.map((d) => `${d.tag} ${d.date}`).join(", ") || "none"}`);
          console.log(`--dry-run: non-answers, no churn date (${churn.nonAnswers.length}): ${cellList(churn.nonAnswers)}`);
          console.log(`--dry-run: unreadable churn cells, these clients cannot receive until fixed (${churn.unreadable.length}): ${cellList(churn.unreadable)}`);
        } else {
          console.log(`--dry-run: ${churn.error} A real run would record no churn date.`);
        }
        console.log(`--dry-run: listed twice on the Groups tab (${churn.duplicates.length}): ${churn.duplicates.join(", ") || "none"}`);
        const savedStatus = new Map(rows.map((r) => [r.tag, r.status]));
        const missing = list
          .filter((c) => isActiveStatus(c.status ?? savedStatus.get(c.tag)) && !groupsTab.groups.has(c.tag))
          .map((c) => c.tag);
        console.log(
          `--dry-run: Active or Healthy clients the Groups tab does not list, they cannot receive (${missing.length}): ${missing.join(", ") || "none"}`
        );
      }
      await db.query("rollback");
    } finally {
      await db.end();
    }
    console.log("--dry-run: no DB writes.");
    return;
  }
  if (list.length === 0) throw new Error("Refusing to sync 0 tags (sheet read likely failed).");

  const client = await connect(env);
  try {
    await client.query("begin");
    // One reader of the Groups tab writes at a time (the cron, "Sync with sheet", "Sync groups").
    await lockClientTagsSync(client);
    // Upsert all incoming FIRST, then delete stale — never leaves a hole.
    // A groups_sheet row must never be overwritten to NULL instances by a
    // roster-only tracker row (COALESCE preserves the mapping).
    for (const c of list) {
      await client.query(
        `insert into client_tags (tag, group_no, b2b_instance, b2c_instance, owner, status, name, client_type, source, synced_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
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
        [c.tag, c.group_no, c.b2b, c.b2c, c.owner ?? null, c.status ?? null, c.name ?? null, c.client_type ?? null, c.source ?? null]
      );
    }
    const del = await client.query(`delete from client_tags where tag <> all($1::text[])`, [list.map((c) => c.tag)]);
    // The Groups tab read (132): on_groups_tab for every row, the churn cell of
    // every listed one, in this transaction. Not when the tab could not be read.
    let recorded = null;
    if (groupsTab) {
      const r = await recordGroupsTab(client, groupsTab);
      if (r.warning) console.warn(`  ${r.warning}`);
      recorded = r.recorded;
    }
    await client.query("commit");
    console.log(`synced ${list.length} client tags (removed ${del.rowCount} stale).`);
    if (recorded) {
      console.log(
        `Groups tab recorded: ${recorded.listed} clients listed, ${recorded.unlisted} not listed` +
        `${recorded.not_in_roster.length ? `; listed but not clients: ${recorded.not_in_roster.join(", ")}` : ""}.`
      );
    }
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

// Only when run as a script: the test imports main() and runs it itself.
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (IS_MAIN) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
