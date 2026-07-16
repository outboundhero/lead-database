// keys.ts — Email Bison multi-instance key resolution.
//
// The client runs THREE separate Bison instances (not workspaces):
//   app.outboundhero.co / app.facilityreach.com / personal.outboundclean.com
// API tokens are per-instance, so each instance needs its own key.
//
// Env:
//   EMAILBISON_KEYS       JSON map of instance domain -> API token, e.g.
//                         {"app.outboundhero.co":"tok1","app.facilityreach.com":"tok2"}
//   EMAILBISON_API_KEY    single/default token — used for any instance without
//                         a map entry (also the simple single-instance setup)
//   EMAILBISON_BASE_URL   default instance domain when a lead/campaign has none

export interface BisonInstance {
  domain: string;
  key: string;
}

export function normalizeDomain(v: string): string {
  return v.replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim().toLowerCase();
}

export function bisonInstances(): BisonInstance[] {
  const out: BisonInstance[] = [];
  const raw = process.env.EMAILBISON_KEYS;
  if (raw) {
    try {
      for (const [domain, key] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
        if (typeof key === "string" && key.trim()) {
          out.push({ domain: normalizeDomain(domain), key: key.trim() });
        }
      }
    } catch {
      console.error("EMAILBISON_KEYS is not valid JSON — ignoring");
    }
  }
  const fallback = process.env.EMAILBISON_API_KEY?.trim();
  if (fallback) {
    const domain = normalizeDomain(process.env.EMAILBISON_BASE_URL || "app.outboundhero.co");
    if (!out.some((i) => i.domain === domain)) out.push({ domain, key: fallback });
  }
  return out;
}

/**
 * Resolve the base URL + token for a given instance domain (a lead's
 * instance_url or a campaign's instance). Exact domain match first. The
 * untagged EMAILBISON_API_KEY fallback applies ONLY when EMAILBISON_KEYS is
 * not configured at all — when a per-instance map exists, an unlisted domain
 * throws rather than leaking a token to an unknown host. Returns null when no
 * usable key exists.
 */
export function bisonAuthFor(instanceUrl?: string | null): { base: string; key: string } | null {
  const instances = bisonInstances();
  if (instances.length === 0) return null;

  const domain = instanceUrl ? normalizeDomain(instanceUrl) : "";
  if (domain) {
    const hit = instances.find((i) => i.domain === domain);
    if (hit) return { base: `https://${hit.domain}`, key: hit.key };
    if (process.env.EMAILBISON_KEYS?.trim()) {
      throw new Error(`No Bison key configured for instance ${domain} — add it to EMAILBISON_KEYS`);
    }
    const fallback = process.env.EMAILBISON_API_KEY?.trim();
    if (fallback) return { base: `https://${domain}`, key: fallback };
    return null;
  }
  // No instance specified — use the first configured one.
  return { base: `https://${instances[0].domain}`, key: instances[0].key };
}
