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
// Env: GOOGLE_SERVICE_ACCOUNT_B64, CLIENTS_SHEET_ID, DATABASE_URL
// Usage:
//   node scripts/sync-clients-from-sheet.mjs
//   node scripts/sync-clients-from-sheet.mjs --dry-run

import crypto from "node:crypto";
import pg from "pg";

const DRY = process.argv.includes("--dry-run");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Group -> instance pair. Bare domains (match bisonAuthFor / EMAILBISON_KEYS keys).
const GROUPS = {
  1: { b2b: "app.outboundhero.co", b2c: "personal.cleaningoutbound.com" },
  2: { b2b: "app.facilityreach.com", b2c: "personal.outboundclean.com" },
};

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

async function main() {
  const saB64 = process.env.GOOGLE_SERVICE_ACCOUNT_B64;
  const sheetId = process.env.CLIENTS_SHEET_ID;
  if (!saB64 || !sheetId) {
    console.error("GOOGLE_SERVICE_ACCOUNT_B64 and CLIENTS_SHEET_ID must be set.");
    process.exit(1);
  }
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

  const list = [...clients.values()].sort((a, b) => a.tag.localeCompare(b.tag));
  console.log(`${list.length} client tags (group1: ${list.filter((c) => c.group_no === 1).length}, group2: ${list.filter((c) => c.group_no === 2).length})`);
  console.log("sample:", list.slice(0, 6).map((c) => `${c.tag}→g${c.group_no}`).join(", "));

  if (DRY) {
    console.log("--dry-run: no DB writes.");
    return;
  }
  if (list.length === 0) {
    console.error("Refusing to sync 0 tags (sheet read likely failed).");
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("begin");
    // Upsert all incoming FIRST, then delete stale — never leaves a hole.
    for (const c of list) {
      await client.query(
        `insert into client_tags (tag, group_no, b2b_instance, b2c_instance, owner, status, synced_at)
         values ($1,$2,$3,$4,$5,$6, now())
         on conflict (tag) do update set
           group_no = excluded.group_no, b2b_instance = excluded.b2b_instance,
           b2c_instance = excluded.b2c_instance,
           owner = coalesce(excluded.owner, client_tags.owner),
           status = coalesce(excluded.status, client_tags.status),
           synced_at = now()`,
        [c.tag, c.group_no, c.b2b, c.b2c, c.owner ?? null, c.status ?? null]
      );
    }
    const del = await client.query(`delete from client_tags where tag <> all($1::text[])`, [list.map((c) => c.tag)]);
    await client.query("commit");
    console.log(`synced ${list.length} client tags (removed ${del.rowCount} stale).`);
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
