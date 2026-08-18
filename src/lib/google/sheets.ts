// Google Sheets read helper — service-account JWT -> access token -> values API.
//
// Extracted from scripts/sync-clients-from-sheet.mjs / sync-taxonomy-from-sheet.mjs /
// sync-client-targeting-from-sheet.mjs, which each carried their own copy. The
// scripts still hold theirs (they run under plain node without the @/ alias);
// this is the single implementation for anything inside the Next app.
//
// READ-ONLY BY CONSTRUCTION: only the spreadsheets.readonly scope is requested,
// so a token minted here cannot write to a sheet even by mistake.

import crypto from "node:crypto";

export const SHEETS_READONLY = "https://www.googleapis.com/auth/spreadsheets.readonly";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri: string;
}

function b64url(buf: crypto.BinaryLike): string {
  return Buffer.from(buf as Buffer)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Parse GOOGLE_SERVICE_ACCOUNT_B64. Some blobs carry RAW newlines inside the
 * private_key string, which is invalid JSON — parse as-is first, then escape
 * newlines inside the private_key value ONLY (pretty-printed JSON needs its
 * structural newlines left alone; PEM bodies never contain a quote character,
 * so the value span ends at the next quote followed by ',' or '}').
 */
export function parseServiceAccount(b64: string): ServiceAccount {
  const raw = Buffer.from(b64, "base64").toString("utf8").trim();
  try {
    return JSON.parse(raw) as ServiceAccount;
  } catch {
    return JSON.parse(
      raw.replace(
        /("private_key"\s*:\s*")([\s\S]*?)("\s*[,}])/,
        (_m, open: string, key: string, close: string) =>
          open + key.replace(/\r/g, "").replace(/\n/g, "\\n") + close
      )
    ) as ServiceAccount;
  }
}

/** Mint a short-lived access token for the given read-only scopes. */
export async function getAccessToken(
  sa: ServiceAccount,
  scopes: string[] = [SHEETS_READONLY]
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: scopes.join(" "),
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
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Google token exchange failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`
    );
  }
  return ((await res.json()) as { access_token: string }).access_token;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET against the Sheets v4 API with the same backoff the sync scripts use:
 * 429 (per-minute read quota) and 5xx are retried, 403 gets an actionable
 * message because it always means the sheet isn't shared with the service account.
 */
export async function sheetsGet<T = unknown>(token: string, path: string): Promise<T> {
  const backoffMs = [2000, 8000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (res.status === 403) {
      throw new Error(
        "Google Sheets returned 403 — share the sheet with the service account email (Viewer is enough)."
      );
    }
    if ((res.status === 429 || res.status >= 500) && attempt < backoffMs.length) {
      await sleep(backoffMs[attempt]);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Sheets API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  }
}

/** Resolve a tab's title from its gid, so a rename never breaks the read. */
export async function tabTitleByGid(
  token: string,
  sheetId: string,
  gid: number
): Promise<string> {
  const meta = await sheetsGet<{
    sheets?: Array<{ properties?: { title?: string; sheetId?: number } }>;
  }>(token, `${sheetId}?fields=sheets.properties`);
  const hit = (meta.sheets ?? [])
    .map((s) => s.properties)
    .find((p) => p?.sheetId === gid);
  if (!hit?.title) throw new Error(`No tab with gid ${gid} in spreadsheet ${sheetId}`);
  return hit.title;
}

/** Read a rectangular range as rows of strings. */
export async function readRange(
  token: string,
  sheetId: string,
  a1: string
): Promise<string[][]> {
  const json = await sheetsGet<{ values?: string[][] }>(
    token,
    `${sheetId}/values/${encodeURIComponent(a1)}`
  );
  return json.values ?? [];
}
