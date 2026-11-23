import { bisonAuthFor, bisonInstances, normalizeDomain } from "@/lib/bison/keys";

// EmailBison for question variables (139), read from its API reference
// (/api/reference.openapi, checked 2026-11-23): custom variables are per
// install (one workspace per token in EMAILBISON_KEYS); GET
// /api/custom-variables lists them, 15 a page ({data: [{id, name}], links,
// meta}); POST /api/custom-variables {name} makes one; GET
// /api/campaigns/v1.1/{id}/sequence-steps gives a campaign's steps
// (data.sequence_steps[] with email_subject and email_body), whose copy
// writes a variable as {NAME}.
//
// A token only ever goes to an install that is configured (bisonInstances):
// bisonAuthFor alone would hand the untagged fallback key to any domain. Each
// request gives up after 20 s. No error text holds a token.

export const BISON_TIMEOUT_MS = 20_000;
/** The most pages of custom variables read from one install (15 a page). */
const PAGES_MAX = 40;

export interface BisonAuth {
  base: string;
  key: string;
}

type FetchFn = typeof fetch;

/** The auth of one of our installs, or why there is none. */
export function authOf(install: string): { auth: BisonAuth; error?: undefined } | { error: string; auth?: undefined } {
  const domain = normalizeDomain(String(install ?? ""));
  if (!domain || !bisonInstances().some((i) => i.domain === domain)) return { error: `No Bison key is set for ${domain || "this install"}` };
  try {
    const auth = bisonAuthFor(domain);
    return auth ? { auth } : { error: `No Bison key is set for ${domain}` };
  } catch {
    return { error: `No Bison key is set for ${domain}` };
  }
}

async function bisonJson(fetchFn: FetchFn, url: string, auth: BisonAuth, init: { method?: string; body?: unknown } = {}) {
  try {
    const res = await fetchFn(url, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${auth.key}`, Accept: "application/json", "Content-Type": "application/json" },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(BISON_TIMEOUT_MS),
    });
    const raw = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(raw);
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, json: json as Record<string, unknown> | null, error: res.ok ? null : `Bison answered HTTP ${res.status}` };
  } catch (e) {
    const name = (e as { name?: string })?.name;
    const timeout = name === "TimeoutError" || name === "AbortError";
    return { ok: false, status: 0, json: null, error: timeout ? `Bison did not answer within ${BISON_TIMEOUT_MS / 1000} s` : "Bison could not be reached" };
  }
}

const namesOf = (json: Record<string, unknown> | null) =>
  (Array.isArray(json?.data) ? (json!.data as Array<{ name?: unknown }>) : [])
    .map((v) => (typeof v?.name === "string" ? v.name.trim().toLowerCase() : ""))
    .filter(Boolean);

/**
 * Every custom variable name of an install, lower case. Pages by meta.last_page
 * (?page=N on the same install), else by links.next while it stays on the
 * install. Throws a plain-words Error when a page can't be read.
 */
export async function listVariableNames(auth: BisonAuth, fetchFn: FetchFn = fetch): Promise<string[]> {
  const first = await bisonJson(fetchFn, `${auth.base}/api/custom-variables?page=1`, auth);
  if (!first.ok) throw new Error(first.error ?? "Bison could not be read");
  const names = new Set(namesOf(first.json));
  const meta = (first.json?.meta ?? null) as { last_page?: unknown } | null;
  const last = Number(meta?.last_page);
  if (Number.isInteger(last) && last > 1) {
    for (let page = 2; page <= Math.min(last, PAGES_MAX); page++) {
      const r = await bisonJson(fetchFn, `${auth.base}/api/custom-variables?page=${page}`, auth);
      if (!r.ok) throw new Error(r.error ?? "Bison could not be read");
      for (const n of namesOf(r.json)) names.add(n);
    }
    return [...names];
  }
  let next = (first.json?.links as { next?: unknown } | undefined)?.next;
  for (let pages = 1; typeof next === "string" && next && pages < PAGES_MAX; pages++) {
    let url: URL;
    try {
      url = new URL(next, auth.base);
    } catch {
      break;
    }
    if (url.origin !== new URL(auth.base).origin) break; // never send the token anywhere else
    const r = await bisonJson(fetchFn, url.href, auth);
    if (!r.ok) throw new Error(r.error ?? "Bison could not be read");
    for (const n of namesOf(r.json)) names.add(n);
    next = (r.json?.links as { next?: unknown } | undefined)?.next;
  }
  return [...names];
}

/** Makes a custom variable on an install. Throws a plain-words Error when Bison refuses. */
export async function createVariableNamed(auth: BisonAuth, name: string, fetchFn: FetchFn = fetch): Promise<void> {
  const r = await bisonJson(fetchFn, `${auth.base}/api/custom-variables`, auth, { method: "POST", body: { name } });
  if (!r.ok) {
    const message = typeof (r.json as { message?: unknown } | null)?.message === "string" ? String((r.json as { message: string }).message).slice(0, 200) : "";
    throw new Error(`${r.error ?? "Bison refused"}${message ? `: ${message}` : ""}`);
  }
}

/** A campaign's copy: every step's subject and body. Throws a plain-words Error when it can't be read. */
export async function campaignCopy(auth: BisonAuth, campaignId: number, fetchFn: FetchFn = fetch): Promise<string[]> {
  const r = await bisonJson(fetchFn, `${auth.base}/api/campaigns/v1.1/${campaignId}/sequence-steps`, auth);
  if (!r.ok) throw new Error(r.error ?? "Bison could not be read");
  const data = (r.json?.data ?? null) as { sequence_steps?: unknown } | null;
  const steps = Array.isArray(data?.sequence_steps) ? (data!.sequence_steps as Array<Record<string, unknown>>) : [];
  return steps.flatMap((s) => [s?.email_subject, s?.email_body]).filter((t): t is string => typeof t === "string");
}

/**
 * Whether copy uses the variable ({ACME-OS QUESTION}, any case) and the
 * default {QUESTION} (as its own token: the braces close it, so
 * {UNIQUE SERVICE QUESTION} is not it).
 */
export function copyUses(texts: string[], name: string): { usesVariable: boolean; usesQuestion: boolean } {
  const tagText = `{${name}}`.toLowerCase();
  return {
    usesVariable: texts.some((t) => t.toLowerCase().includes(tagText)),
    usesQuestion: texts.some((t) => /\{question\}/i.test(t)),
  };
}
