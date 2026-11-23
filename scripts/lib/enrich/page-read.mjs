// Reads a company's own web pages for the email search, as Clay's Claygent
// visits them ("visitWebpage"): the place's page or the website's front page,
// then the contact, location and about pages it links to on the same site, at
// most PAGE_LIMIT pages in PAGE_BUDGET_MS. Each page gives its email addresses
// (mailto links, plain text, Cloudflare's protected addresses and "name [at]
// domain [dot] com"), the same-site links worth opening, and a short excerpt
// of its text for the model. Free: no provider is called.
//
// Only public websites are read: http or https on the usual ports, a host
// name that resolves to public addresses only (never this machine, a private
// network, Railway's internal hosts or a cloud metadata address), checked
// again on every redirect. A page answers in PAGE_TIMEOUT_MS and is read up
// to PAGE_MAX_BYTES; anything but HTML or text is not read.
//
// Used by actions.mjs aiWeb for the columns readsPages() names (the two email
// searches). The engine keys their shared memory with PAGE_READ_MEMORY, so an
// answer remembered before pages were read is never reused, and keeps an
// "N/A" for the nothing-found days only (engine.mjs).

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The columns whose AI reads the company's pages first (by key, so every client's tables have it at once). Both
 * keep their web search, as Clay's Claygent always has its Google search beside the page visits.
 */
export const PAGE_READ_COLUMNS = Object.freeze({ email_extraction_claygent: true, email_extraction_claygent_2: true });
/** Added to a page-reading column's memory kind ("<kind>_pages1": enrich_memory.kind takes [a-z0-9_] only), so answers remembered before pages were read are not reused. */
export const PAGE_READ_MEMORY = "pages1";
/** Pages read at most per company: the start page and three it links to. */
export const PAGE_LIMIT = 4;
export const PAGE_TIMEOUT_MS = 8_000;
export const PAGE_BUDGET_MS = 20_000;
export const PAGE_MAX_BYTES = 1_500_000;
/** Excerpt characters kept per page, and for all pages together. */
export const EXCERPT_PER_PAGE = 2_500;
export const EXCERPT_TOTAL = 8_000;
const MAX_REDIRECTS = 4;
const MAX_EMAILS = 30;

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Does this column read the company's pages before its AI answers? */
export function readsPages(column) {
  return Boolean(column && Object.hasOwn(PAGE_READ_COLUMNS, column.key));
}


// ── Dependencies (the tests put in their own) ───────────────────────────────

const DEFAULT_DEPS = {
  fetch: (url, init) => globalThis.fetch(url, init),
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
};
let deps = { ...DEFAULT_DEPS };
/** For the tests: a fetch and a lookup (host -> [{ address, family }]) in place of the real ones. */
export function setPageReadDeps(next) {
  deps = { ...DEFAULT_DEPS, ...(next ?? {}) };
}

// ── Addresses ───────────────────────────────────────────────────────────────

const text = (v) => (v == null || typeof v === "object" ? "" : String(v).trim());

/** A website as an address to open: "N/A", text with no dot or with spaces is none. Adds https:// when no scheme. */
export function startUrl(raw) {
  const t = text(raw);
  if (!t || /^n\/?a\.?$/i.test(t) || /\s/.test(t) || !t.includes(".")) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, "")}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  u.hash = "";
  return u.href;
}

/** The host without "www.", lower case. */
const siteHost = (host) => String(host ?? "").toLowerCase().replace(/^www\./, "");
const TWO_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "com.br", "co.za", "com.mx", "co.jp"]);
/** The registrable part of a host ("providers.wmchealth.org" -> "wmchealth.org"), near enough for "same site". */
export function baseDomain(host) {
  const parts = siteHost(host).split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return TWO_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}
const sameSite = (a, b) => Boolean(a && b && baseDomain(a) === baseDomain(b));

/** Is this IP address one anyone on the internet could reach (not loopback, private, link-local, reserved)? */
export function isPublicAddress(address) {
  const a = String(address ?? "").toLowerCase();
  const v = isIP(a);
  if (v === 4) {
    const [p, q] = a.split(".").map(Number);
    if (p === 0 || p === 10 || p === 127 || p >= 224) return false;
    if (p === 100 && q >= 64 && q <= 127) return false; // carrier-grade NAT
    if (p === 169 && q === 254) return false; // link-local, cloud metadata
    if (p === 172 && q >= 16 && q <= 31) return false;
    if (p === 192 && (q === 168 || a.startsWith("192.0.0.") || a.startsWith("192.0.2."))) return false;
    if (p === 198 && (q === 18 || q === 19 || a.startsWith("198.51.100."))) return false;
    if (a.startsWith("203.0.113.")) return false;
    return true;
  }
  if (v === 6) {
    if (a === "::" || a === "::1") return false;
    // An IPv4 address inside IPv6 (mapped or the old compatible form), dotted or as two hex groups: judged as IPv4.
    const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (dotted) return isPublicAddress(dotted[1]);
    const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (hex) {
      const hi = parseInt(hex[1], 16);
      const lo = parseInt(hex[2], 16);
      return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (/^(fc|fd)/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a)) return false; // unique local, link-local, multicast
    if (a.startsWith("64:ff9b:") || a.startsWith("2001:db8") || a.startsWith("2001:0db8")) return false;
    return true;
  }
  return false;
}

/** Why this address may not be opened, or null when it may. Resolves the host: every address must be public. */
async function refusal(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "not an address";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "not a web address";
  if (u.port && u.port !== "80" && u.port !== "443") return "not a usual web port";
  if (u.username || u.password) return "an address with a password";
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || /\.(localhost|local|internal|lan|home\.arpa|intranet)$/.test(host)) return "not a public host";
  if (isIP(host)) return isPublicAddress(host) ? null : "not a public address";
  let found;
  try {
    found = await deps.lookup(host);
  } catch {
    return "the host does not resolve";
  }
  const list = Array.isArray(found) ? found : [found];
  if (!list.length) return "the host does not resolve";
  return list.every((x) => isPublicAddress(x?.address)) ? null : "the host resolves to a private address";
}

// ── One page ────────────────────────────────────────────────────────────────

/** A page as fetched: { url (after redirects), status, html } or { url, error }. Never throws. */
async function fetchPage(url, deadline) {
  let at = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const why = await refusal(at);
    if (why) return { url: at, error: why };
    const left = deadline - Date.now();
    if (left <= 0) return { url: at, error: "out of time" };
    let res;
    try {
      res = await deps.fetch(at, {
        redirect: "manual",
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5", "accept-language": "en-US,en;q=0.8" },
        signal: AbortSignal.timeout(Math.min(PAGE_TIMEOUT_MS, left)),
      });
    } catch (e) {
      const name = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : e?.cause?.code ?? "no answer";
      return { url: at, error: String(name) };
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get("location");
      await res.body?.cancel?.().catch?.(() => {});
      if (!to) return { url: at, status: res.status, error: "a redirect with no address" };
      try {
        at = new URL(to, at).href;
      } catch {
        return { url: at, status: res.status, error: "a redirect to a bad address" };
      }
      continue;
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !/text\/html|application\/xhtml|text\/plain/.test(type)) {
      await res.body?.cancel?.().catch?.(() => {});
      return { url: at, status: res.status, error: "not a web page" };
    }
    if (res.status >= 400) {
      await res.body?.cancel?.().catch?.(() => {});
      return { url: at, status: res.status, error: `HTTP ${res.status}` };
    }
    const charset = /charset=([\w-]+)/.exec(type)?.[1] ?? "utf-8";
    return { url: at, status: res.status, html: await readCapped(res, charset) };
  }
  return { url: at, error: "too many redirects" };
}

/** The body as text, at most PAGE_MAX_BYTES. */
async function readCapped(res, charset) {
  let decoder;
  try {
    decoder = new TextDecoder(charset, { fatal: false });
  } catch {
    decoder = new TextDecoder("utf-8", { fatal: false });
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text().catch(() => "");
    return t.slice(0, PAGE_MAX_BYTES);
  }
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      parts.push(value);
      if (size >= PAGE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    /* what was read stands */
  }
  return decoder.decode(Buffer.concat(parts.map((p) => Buffer.from(p))).subarray(0, PAGE_MAX_BYTES));
}

// ── What a page holds ───────────────────────────────────────────────────────

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: ".", hyphen: "-", lowbar: "_" };
/** HTML character references decoded (named ones the pages use for addresses, and every numeric one). */
export function decodeEntities(s) {
  return String(s ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Cloudflare's email protection: the hex after data-cfemail, or after /cdn-cgi/l/email-protection#. */
export function decodeCfEmail(hex) {
  const h = String(hex ?? "");
  if (!/^[0-9a-f]+$/i.test(h) || h.length < 4 || h.length % 2) return "";
  const key = parseInt(h.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ key);
  return out;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}/gi;
const PLACEHOLDER_DOMAINS = /^(example\.(com|org|net)|domain\.com|email\.com|yourdomain\.com|yoursite\.com|yourcompany\.com|company\.com|mysite\.com|website\.com|test\.com|sentry\.io)$/;
const ASSET = /\.(png|jpe?g|gif|webp|svg|bmp|ico|css|js|json|woff2?|ttf|mp4|pdf)$/i;

/** One address cleaned, or "" for a placeholder, a file name or a no-reply address. */
export function cleanEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase().replace(/^mailto:/, "").replace(/[.,;:)\]>'"]+$/, "");
  const m = /^[a-z0-9][a-z0-9._%+-]{0,63}@([a-z0-9.-]+\.[a-z]{2,24})$/.exec(e);
  if (!m) return "";
  const domain = m[1];
  if (PLACEHOLDER_DOMAINS.test(domain) || /(^|\.)wixpress\.com$/.test(domain) || /(^|\.)sentry(-next)?\./.test(domain)) return "";
  if (ASSET.test(e) || /@\d+x\./.test(e)) return "";
  if (/^(no-?reply|do-?not-?reply|noreply-|mailer-daemon|postmaster)/.test(e)) return "";
  return e;
}

/**
 * The addresses in a page, once each: mailto links, Cloudflare-protected ones,
 * the visible text and its "[at] ... [dot]" forms first, then any other the
 * page's own data holds (scripts, JSON-LD, a component's props in an
 * attribute: many site builders put the business email only there).
 */
export function emailsIn(html) {
  const h = String(html ?? "");
  const found = [];
  for (const m of h.matchAll(/href\s*=\s*["']\s*mailto:([^"'?#]+)/gi)) {
    let v = m[1];
    try {
      v = decodeURIComponent(v);
    } catch {
      /* as written */
    }
    found.push(...decodeEntities(v).split(/[,;]/));
  }
  for (const m of h.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) found.push(decodeCfEmail(m[1]));
  for (const m of h.matchAll(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi)) found.push(decodeCfEmail(m[1]));
  const plain = decodeEntities(stripTags(h));
  for (const m of plain.matchAll(EMAIL_RE)) found.push(m[0]);
  // Every part bounded: an unbounded run here backtracks for ever on a long string of letters (inline data).
  for (const m of plain.matchAll(/\b([a-z0-9][a-z0-9._%+-]{0,63})[ \t]{0,3}[[({][ \t]{0,3}at[ \t]{0,3}[\])}][ \t]{0,3}([a-z0-9-]{1,63}(?:[ \t]{0,3}[[({][ \t]{0,3}dot[ \t]{0,3}[\])}][ \t]{0,3}[a-z0-9-]{1,63}){1,4})/gi)) {
    found.push(`${m[1]}@${m[2].replace(/[ \t]*[[({][ \t]*dot[ \t]*[\])}][ \t]*/gi, ".")}`);
  }
  // The page's own data: inline base64 (images, fonts) left out, entities decoded, and the @ and \/ escapes
  // JSON writes, then the same pattern.
  const data = decodeEntities(h.replace(/data:[a-z0-9/+.-]{1,80};base64,[a-z0-9+/=\s]+/gi, " ")).replace(/\\u0040/gi, "@").replace(/\\\//g, "/");
  for (const m of data.matchAll(EMAIL_RE)) found.push(m[0]);
  const out = [];
  for (const f of found) {
    const e = cleanEmail(f);
    if (e && !out.includes(e)) out.push(e);
    if (out.length >= MAX_EMAILS) break;
  }
  return out;
}

/** The page without scripts, styles and comments. */
function stripNoise(html) {
  return String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, " ");
}
/** The page's text, a line per block, tags removed (entities not yet decoded). */
function stripTags(html) {
  return stripNoise(html)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/td|\/th|\/section|\/article|\/address|\/footer|\/header)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

/** The page's visible text: entities decoded, spaces made single, empty lines dropped. */
export function visibleText(html) {
  return decodeEntities(stripTags(html))
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** The page's title. */
export function pageTitle(html) {
  return visibleText(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ""))?.[1] ?? "").slice(0, 200);
}

const LINK_KINDS = [
  { kind: "contact", score: 100, re: /contact|get-?in-?touch|reach-?us|email-?us|connect-?with/i },
  { kind: "location", score: 60, re: /locations?\b|our-?offices?|office-?hours|directions|find-?us|visit-?us/i },
  { kind: "about", score: 40, re: /about/i },
  { kind: "team", score: 25, re: /team|staff|leadership|directory|our-?people/i },
];
const SKIP_LINK = /\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mp3)(\?|$)|\/(wp-login|login|signin|sign-in|cart|checkout|account|search)\b|[?&](share|replytocom)=/i;

/**
 * The same-site links worth opening from a page, best first: contact pages,
 * then location pages, about pages and team pages, judged on the address and
 * the link's text. { url, kind, score }, each address once, no fragments.
 */
export function pageLinks(html, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const seen = new Map();
  // Bounded: an anchor that never closes must not make the search scan the rest of the page from every link.
  for (const m of stripNoise(html).matchAll(/<a\b[^>]{0,500}?\bhref\s*=\s*(["'])([^"'<>]{0,1000})\1[^>]{0,500}>([\s\S]{0,1500}?)<\/a\s*>/gi)) {
    const href = decodeEntities(m[2]).trim();
    if (!href || /^(mailto|tel|javascript|sms|data):/i.test(href) || href.startsWith("#")) continue;
    let u;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !sameSite(u.hostname, base.hostname)) continue;
    u.hash = "";
    const url = u.href.replace(/\/$/, "");
    if (url === base.href.replace(/\/$/, "") || SKIP_LINK.test(url)) continue;
    const label = visibleText(m[3]).slice(0, 80);
    const hay = `${u.pathname} ${label}`;
    const hit = LINK_KINDS.find((k) => k.re.test(hay));
    if (!hit) continue;
    // A shorter path is the site's own page rather than a post that mentions the word.
    const score = hit.score - Math.min(20, u.pathname.split("/").filter(Boolean).length * 4);
    const prev = seen.get(url);
    if (!prev || prev.score < score) seen.set(url, { url, kind: hit.kind, score });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

/**
 * The part of a page's text worth sending: the lines with an address, "email",
 * "contact", a phone number or an address, each with the line before and
 * after, then the start of the page, at most `max` characters.
 */
export function excerpt(html, max = EXCERPT_PER_PAGE) {
  const lines = visibleText(html).split("\n");
  const keep = new Set();
  lines.forEach((l, i) => {
    if (/@|\be-?mail\b|\bcontact\b|\(\d{3}\)\s?\d{3}|\d{3}[-.]\d{3}[-.]\d{4}|\b(suite|street|st\.|avenue|ave\.|road|rd\.|blvd|floor)\b/i.test(l)) {
      for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < lines.length) keep.add(j);
    }
  });
  const picked = [...keep].sort((a, b) => a - b).map((i) => lines[i]);
  let out = picked.join("\n");
  if (out.length < max) {
    const head = lines.slice(0, 40).filter((l) => !picked.includes(l)).join("\n");
    out = (out ? `${out}\n…\n` : "") + head;
  }
  return out.slice(0, max);
}

// ── A site ──────────────────────────────────────────────────────────────────

/**
 * Reads up to PAGE_LIMIT pages of the site that starts at `start`: that page,
 * then the best same-site links it (or the next page) gives; when none of
 * them is a contact page, /contact-us and /contact are tried. Never throws.
 *
 * @param {string} start  an address startUrl() gave
 * @returns {Promise<{ start: string, pages: Array<{ url: string, kind: string, status?: number, error?: string, title?: string, emails?: string[], excerpt?: string }>, emails: string[] }>}
 */
export async function readSite(start, { limit = PAGE_LIMIT, budgetMs = PAGE_BUDGET_MS } = {}) {
  const deadline = Date.now() + budgetMs;
  const pages = [];
  const emails = [];
  const queue = [{ url: start, kind: "start" }];
  const done = new Set();
  let contactSeen = false;
  let guessed = false;
  while (pages.length < limit && Date.now() < deadline) {
    let next = queue.shift();
    if (!next && !contactSeen && !guessed && pages.some((p) => p.html)) {
      guessed = true;
      const origin = new URL(pages.find((p) => p.html).url).origin;
      queue.push({ url: `${origin}/contact-us`, kind: "contact (tried)" }, { url: `${origin}/contact`, kind: "contact (tried)" });
      next = queue.shift();
    }
    if (!next) break;
    const key = next.url.replace(/\/$/, "");
    if (done.has(key)) continue;
    done.add(key);
    const page = await fetchPage(next.url, deadline);
    if (page.html == null) {
      pages.push({ url: page.url, kind: next.kind, ...(page.status ? { status: page.status } : {}), error: page.error });
      continue;
    }
    done.add(page.url.replace(/\/$/, ""));
    const found = emailsIn(page.html);
    for (const e of found) if (!emails.includes(e)) emails.push(e);
    if (next.kind.startsWith("contact")) contactSeen = true;
    pages.push({ url: page.url, kind: next.kind, status: page.status, title: pageTitle(page.html), emails: found, excerpt: excerpt(page.html), html: page.html });
    for (const l of pageLinks(page.html, page.url)) {
      if (l.kind === "contact") contactSeen = true;
      if (!done.has(l.url) && !queue.some((q) => q.url === l.url)) queue.push({ url: l.url, kind: l.kind });
    }
    queue.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
    // A contact page that held an address is enough.
    if (next.kind.startsWith("contact") && found.length) break;
  }
  // The HTML stays here: only what each page gave goes back.
  return { start, pages: pages.map((p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== "html"))), emails: emails.slice(0, MAX_EMAILS) };
}

const kindRank = (k) => ({ contact: 0, location: 1, about: 2, team: 3 })[k] ?? 4;

/**
 * The pages for the model, after the prompt: what was read, the addresses found
 * and an excerpt of each page, at most EXCERPT_TOTAL characters of excerpts.
 * `tools`: whether the request keeps the web search.
 */
export function pagesForPrompt(read, { tools }) {
  const ok = read.pages.filter((p) => !p.error);
  const lines = ["#PAGES READ FROM THE COMPANY WEBSITE#"];
  if (!ok.length) {
    lines.push(`The website (${read.start}) could not be opened (${read.pages.map((p) => p.error).filter(Boolean)[0] ?? "no answer"}).${tools ? " Search the web instead." : ""}`);
    return lines.join("\n");
  }
  lines.push(
    `These pages of the company's own website were opened for you, starting at ${read.start}. Treat them as the primary source.`,
    read.emails.length
      ? `Email addresses found on these pages: ${read.emails.join(", ")}. Return the ones that fit the rules above (from these pages only, never invented); if none fits, answer "N/A".${tools ? " Search the web only when none of them fits." : ""}`
      : `No email address was found on these pages.${tools ? " Search the web as the instructions say." : ' Answer "N/A" unless the pages show one in another form.'}`
  );
  let room = EXCERPT_TOTAL;
  for (const p of ok) {
    if (room <= 200) break;
    const body = String(p.excerpt ?? "").slice(0, room);
    room -= body.length;
    lines.push(`--- ${p.url} (${p.kind}${p.title ? `: ${p.title}` : ""})`, body);
  }
  return lines.join("\n");
}

/** The address the email search should start from: the place's own page when it is on the website's site, else the website. */
export function pageStart(pageUrl, website) {
  const site = startUrl(website);
  const page = startUrl(pageUrl);
  if (page && site) return sameSite(new URL(page).hostname, new URL(site).hostname) ? page : site;
  return page ?? site;
}

/** The website a compiled email-search prompt names ("... official website from site:<site>, ..."), or "". */
export function siteInPrompt(prompt) {
  return /official website from site:\s*([^\s,]+)/i.exec(String(prompt ?? ""))?.[1] ?? "";
}
