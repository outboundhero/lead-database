import { randomBytes } from "node:crypto";

// Per-client inbound URLs (migration 129): what the receiving route
// (POST /api/enrich/intake/<token>), the Clay tab's management route and the
// tests share. The token is the URL's only secret and decides the client: 32
// random bytes made on the server, base64url, 43 characters. The full URL is
// built from NEXT_PUBLIC_SITE_URL, never from a request's origin (inside the
// container that is its own localhost). Nothing here logs or stores a token.
//
// The scraper app (gmaps-UI src/lib/clay-pool.ts) reads every answer this way:
// 2xx deletes its only copy of the chunk; 404 or 410 disables the URL for good;
// 429 keeps the chunk and uses no try; any other answer uses one of its 10
// tries; and a body holding one of its "full" phrases marks the URL full. It
// keeps the answer's first 200 characters as the URL's last error on the card.
// So every answer text below is short, plain, never holds a "full" phrase, and
// never repeats the chunk's client name (sheet text) or the token.

/** Where the receiving route lives. The session middleware lets every path under it through. */
export const INTAKE_PATH = "/api/enrich/intake/";
/** A token's shape: 43 URL-safe base64 characters (32 bytes). Anything else is refused before any query. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** How many characters of a token a masked URL shows. */
export const TOKEN_SHOWN = 6;
/** The most client names a manager can accept for one URL (enrich_inbound_urls.accepted_names). */
export const ACCEPTED_NAMES_MAX = 20;
/** A client name is compared and stored at most this long. */
export const NAME_MAX = 200;

/** A new token: 32 random bytes, base64url (43 characters). */
export function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Does this look like a token? Checked before any query. */
export function isToken(v: unknown): v is string {
  return typeof v === "string" && TOKEN_PATTERN.test(v);
}

/**
 * The site's origin from NEXT_PUBLIC_SITE_URL ("https://host"), or null when
 * it is not set, is not an http or https address, or holds a user name or
 * password. Pass a site to use instead of the environment ("" for none).
 */
export function siteOrigin(site: string | undefined = process.env.NEXT_PUBLIC_SITE_URL): string | null {
  const s = (site ?? "").trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The full inbound URL of a token, or null without a site address (the route then refuses to show one) or for a malformed token. */
export function inboundUrl(token: string, site?: string): string | null {
  if (!isToken(token)) return null;
  const origin = siteOrigin(site);
  return origin ? `${origin}${INTAKE_PATH}${token}` : null;
}

/** The URL as the Clay tab lists it: the origin (when the site address is set), the path and the token's first 6 characters, then "…". */
export function maskedInboundUrl(token: string, site?: string): string {
  const head = typeof token === "string" ? token.slice(0, TOKEN_SHOWN) : "";
  return `${siteOrigin(site) ?? ""}${INTAKE_PATH}${head}…`;
}

// ── The client name check ───────────────────────────────────────────────────

/**
 * A scraper app client name as it is compared and stored: white space made
 * single, trimmed, upper case, at most NAME_MAX characters. Anything that is
 * not text or a number is "".
 */
export function normName(v: unknown): string {
  if (v == null || (typeof v !== "string" && typeof v !== "number")) return "";
  return String(v).replace(/\s+/g, " ").trim().toUpperCase().slice(0, NAME_MAX);
}

/**
 * The parts a compound name may stand for: split on " & ", " / " and " AND "
 * with spaces around them (as the targeting sync splits a sheet tag, so
 * "IB&T & IBTEST_C" gives "IB&T"), and on "&", "/" and the word AND anywhere
 * ("IBX&IBY" gives "IBX" and "IBY"). The whole name is not one of its parts.
 */
export function nameParts(name: unknown): string[] {
  const n = normName(name);
  if (!n) return [];
  const spaced = n.split(/\s+(?:&|\/|AND)\s+/);
  const any = n.split(/\s*(?:&|\/|\bAND\b)\s*/);
  return [...new Set([...spaced, ...any].map((s) => s.trim()).filter((s) => s && s !== n))];
}

export interface NameCheck {
  /** The chunk may be stored for this URL. */
  ok: boolean;
  /** How it fits: the tag itself, a name a manager accepted, or one part of a compound name. Null when it doesn't. */
  how: "tag" | "accepted" | "part" | null;
  /** The name as compared (normName), or null when the chunk had none. Stored as refused_name when refused; never answered. */
  name: string | null;
}

/**
 * Does a chunk's client name (extra.client, the scraper app's own name for
 * the client) fit the URL's client tag? It fits when it is the tag, a name a
 * manager accepted for the URL, or when one of its parts (nameParts) is the
 * tag. No name at all does not fit: the scraper app always sends one.
 */
export function checkName(clientName: unknown, tag: string, accepted: readonly string[] = []): NameCheck {
  const name = normName(clientName);
  if (!name) return { ok: false, how: null, name: null };
  const t = normName(tag);
  if (t && name === t) return { ok: true, how: "tag", name };
  if (accepted.some((a) => normName(a) === name)) return { ok: true, how: "accepted", name };
  if (t && nameParts(name).includes(t)) return { ok: true, how: "part", name };
  return { ok: false, how: null, name };
}

// ── What the receiving route answers, and what it notes on the URL ─────────

/** The scraper app's "this URL is full" phrases (gmaps-UI src/lib/clay-pool.ts:16). No answer here may hold one. */
export const SCRAPER_FULL_PHRASES = /record limit reached|webhook (is )?full|table full|row limit|quota exceeded/i;

/** The receiving route's error answers, { error: <text> }, by status. Each is under 200 characters. */
export const INTAKE_ANSWERS = Object.freeze({
  /** 404: a malformed, unknown or revoked token. The scraper app disables the URL. */
  unknown: "unknown or revoked URL",
  /** 413: a body over 5 MB. One try used. */
  tooLarge: "chunk too large",
  /** 422: not JSON, or no postbackData.tasks list. One try used. */
  notChunk: "not a scraper chunk",
  /** 429: no intake slot within 2 s, or a passing database problem. No try used. */
  busy: "busy, try again shortly",
  /** 429: the chunk's client name does not fit the URL, or it has none. No try used: the chunk waits in the scraper app. */
  nameMismatch:
    "waiting: this chunk's client name does not fit this URL, so nothing was saved. A manager can check it on the lead database's Clay tab (Inbound URLs).",
  /** 429: the client's Companies (pipeline) table is missing and can't be made now. No try used. */
  notReady:
    "waiting: this client's Companies table in the lead database is not ready, so nothing was saved. A manager can check it on the Clay tab (Inbound URLs).",
  /** 500: anything else (a bug). One try used. */
  failed: "intake failed",
});

/** Why a chunk was refused, as enrich_inbound_urls.last_refused notes it for the Clay tab: plain words, never a body, a token or a URL. */
export const REFUSED_NOTES = Object.freeze({
  revoked: "A chunk came to this URL after it was revoked",
  notJson: "A delivery was not JSON",
  notChunk: "A delivery was not a scraper chunk",
  noName: "A chunk came with no client name, so it waits in the scraper app",
  nameMismatch: "A chunk's client name does not fit this URL, so it waits in the scraper app",
  notReady: "The client's Companies table is not ready, so chunks wait in the scraper app",
});
