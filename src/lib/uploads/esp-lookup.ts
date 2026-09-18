import dns from "node:dns/promises";

// ESP detection for uploaded leads via the domain's MX records.
//
// Every ESP value in the database so far came from Email Bison's own tags on
// leads that were exported from Bison; there was no detector of our own, so a
// CSV upload left esp NULL — invisible to the Mimecast default exclusion (NULL
// is deliberately kept) but routed to the "default" campaign bucket even when
// the mailbox sits behind Mimecast or Proofpoint. An MX lookup is the standard
// free answer: the mail exchanger's hostname names the provider.
//
// Validated 2026-09-18 on the client's file: 40 domains in 2.5 s → Microsoft 17,
// Proofpoint 13, Google 3, Mimecast 2, Custom 5. Values use the same seven
// labels Bison writes, so the ESP chip (exact match) and espBucket() work
// unchanged. A lookup failure yields null (unknown), never a guess.

const PATTERNS: Array<[RegExp, string]> = [
  [/mimecast/i, "Mimecast"],
  [/pphosted|proofpoint/i, "Proofpoint"],
  [/barracuda/i, "Barracuda"],
  [/google|googlemail|aspmx/i, "Google"],
  [/outlook|office365|microsoft|hotmail/i, "Microsoft"],
  [/zoho/i, "Zoho"],
];

export function classifyMx(exchanges: string[]): string | null {
  if (exchanges.length === 0) return null;
  const joined = exchanges.join(" ").toLowerCase();
  // Security gateways front the real provider, so test them first: a domain
  // whose MX is mimecast.com but whose mail lives in Microsoft is "Mimecast"
  // for deliverability purposes (that is what Bison's tag says too).
  for (const [re, label] of PATTERNS) if (re.test(joined)) return label;
  return "Custom";
}

export async function lookupEsp(domain: string, timeoutMs = 2500): Promise<string | null> {
  const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs).unref?.());
  try {
    const mx = await Promise.race([dns.resolveMx(domain), timer]);
    if (!mx) return null; // timed out
    return classifyMx(mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange));
  } catch {
    return null; // NXDOMAIN / no MX / DNS error — unknown, not "Custom"
  }
}

// Process-wide cache: the same domains recur across the files of one upload
// session (and MX records rarely change). A hit lives a day; a miss (timeout,
// NXDOMAIN) an hour, so a DNS blip is retried on the next file.
const HIT_TTL_MS = 24 * 3600_000, MISS_TTL_MS = 3600_000, CACHE_MAX = 100_000;
const cache = new Map<string, { esp: string | null; expires: number }>();

/**
 * Resolve ESPs for many domains with bounded concurrency. Returns a map; a
 * missing/null entry means "could not determine".
 */
export async function lookupEspForDomains(
  domains: Iterable<string>,
  concurrency = 40,
): Promise<Map<string, string | null>> {
  const now = Date.now();
  const out = new Map<string, string | null>();
  const unique: string[] = [];
  for (const raw of new Set([...domains].map((d) => d.trim().toLowerCase()).filter(Boolean))) {
    const hit = cache.get(raw);
    if (hit && hit.expires > now) out.set(raw, hit.esp); else unique.push(raw);
  }
  let next = 0;
  async function worker() {
    while (next < unique.length) {
      const d = unique[next++];
      const esp = await lookupEsp(d);
      out.set(d, esp);
      cache.delete(d);   // re-insert so a refreshed key moves to the end of the eviction order
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
      cache.set(d, { esp, expires: now + (esp ? HIT_TTL_MS : MISS_TTL_MS) });
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return out;
}

export function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.includes(".") ? d : null;
}
