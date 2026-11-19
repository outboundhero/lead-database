import { bisonInstances, type BisonInstance } from "./keys";

// The live Email Bison campaign read, by name, across every configured install.
//
// Moved here from src/app/api/bison/campaigns/route.ts (overlap sharing, 2026-11)
// so the share push can read a client's campaigns on the server, the way the
// export popup reads them through that route. The route keeps its cache and its
// answer; this file holds the search itself, its limits and its errors.
//
// An answer is { data, errors }. errors names each install that failed or
// stopped early ("partial"); a caller that must not act on an incomplete list
// (the share push) treats any error as "try again later".

export const MAX_PAGES = 300;               // safety cap per instance (~4,500 campaigns)
// Per HTTP request. 8s was too tight and produced a false "list incomplete"
// warning on every client: app.facilityreach.com answers its campaign pages in
// ~7.1s under load (measured 2026-08-25), so it tripped at random even though
// nothing was actually missing. The scoped search is only a few pages now, so a
// longer ceiling costs nothing on the happy path.
export const PAGE_TIMEOUT_MS = 20_000;
export const INSTANCE_BUDGET_MS = 60_000;   // per instance, across all its pages
export const PAGE_CONCURRENCY = 8;          // pages fetched in parallel per instance
// NOTE: Bison HARD-CAPS a page at 15 rows and ignores per_page/limit entirely
// (measured 2026-08-25), so page COUNT is the cost driver: hence the parallel
// page fetch in the route's full read and the search path below.

export type BisonCampaignRow = Record<string, unknown>;

// TWO PAGINATION STYLES, one reader (measured 2026-08-26):
//   page-cursor : meta = {current_page, last_page, total}, links.next = ?page=2
//   keyset      : meta = {per_page, next_cursor},          links.next = ?cursor=…
// app.outboundhero.co served the first style in the morning and the second by
// the afternoon, so neither can be assumed. Anything that derives page COUNT
// from meta.last_page silently collapses to ONE page (15 rows) on a keyset
// install, and meta.total is absent there too, so the "list incomplete"
// warning cannot fire either. Follow links.next instead: it exists in both.
export function nextUrl(json: unknown): string | null {
  const links = (json as { links?: { next?: unknown } } | null)?.links;
  return typeof links?.next === "string" && links.next ? links.next : null;
}

// Bison drops ?search= from its own next-links in BOTH styles, so page 2 onward
// silently becomes the whole unfiltered install. Re-apply the term every hop.
export function withSearch(url: string, term: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set("search", term);
    return u.toString();
  } catch {
    return url;
  }
}

// Last line of defence against a campaign appearing twice in the picker. Rows
// are keyed by `instance#id` in the UI, so a duplicate is not merely cosmetic:
// two rows sharing a React key make both checkboxes toggle as one.
export function dedupeCampaigns(rows: BisonCampaignRow[]): BisonCampaignRow[] {
  const seen = new Set<string>();
  const out: BisonCampaignRow[] = [];
  for (const c of rows) {
    const key = `${c.instance_url ?? ""}#${c.id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// Server-side search: the escape hatch from that pagination. A client-scoped
// picker asks for exactly the campaigns it needs instead of enumerating the
// whole install and silently running out of budget.
//
// CAREFUL (measured 2026-08-25): Bison DROPS the search term from its own
// pagination links. A search response's links.next is plain
// `/api/campaigns?page=2`, so following it walks the ENTIRE UNFILTERED install
// from page 2 on (meta.total flips 32 -> 1429 mid-walk). That is how the picker
// once showed one client's SEGs campaign twice: once from the real search page,
// then again when the unfiltered walk reached it. Page explicitly with search=
// on every request instead. (For that client: 1429 rows in 50s following
// links.next, vs 32 rows over 3 pages in ~1s paging explicitly.)
export async function searchInstances(
  instances: BisonInstance[],
  term: string
): Promise<{ data: BisonCampaignRow[]; errors: string[] }> {
  const data: BisonCampaignRow[] = [];
  const errors: string[] = [];
  await Promise.all(
    instances.map(async ({ domain, key }) => {
      const startedAt = Date.now();
      const get = async (url: string) => {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        return res.json();
      };
      try {
        // Follow the install's OWN next-link but re-apply search= to it every
        // time. That covers both pagination styles Bison serves (see the note
        // on nextUrl), and both of them drop the search term from their links.
        let url: string | null = withSearch(`https://${domain}/api/campaigns`, term);
        for (let page = 0; url && page < MAX_PAGES; page++) {
          const json = await get(url);
          const rows = Array.isArray(json?.data) ? json.data : [];
          for (const c of rows) data.push({ ...c, instance_url: domain });
          if (rows.length === 0) break;
          const next = nextUrl(json);
          url = next ? withSearch(next, term) : null;
          if (url && Date.now() - startedAt > INSTANCE_BUDGET_MS) {
            errors.push(`${domain}: partial, stopped after ${Math.round((Date.now() - startedAt) / 1000)}s`);
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error && err.name === "TimeoutError"
          ? `timed out after ${PAGE_TIMEOUT_MS / 1000}s`
          : err instanceof Error ? err.message : "fetch failed";
        errors.push(`${domain}: ${msg}`);
      }
    })
  );
  return { data: dedupeCampaigns(data), errors };
}

/**
 * One client's live campaigns: the search above with the client's tag as the
 * term, on every configured install, read fresh (no cache), as the export
 * popup's client scope reads them. With no Bison key configured the answer is
 * an error, never an empty list that looks complete.
 */
export async function searchClientCampaigns(tag: string): Promise<{ data: BisonCampaignRow[]; errors: string[] }> {
  const instances = bisonInstances();
  if (instances.length === 0) {
    return { data: [], errors: ["No Bison keys configured (EMAILBISON_KEYS or EMAILBISON_API_KEY)"] };
  }
  return searchInstances(instances, tag.trim());
}
