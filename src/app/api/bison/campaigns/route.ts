import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { bisonInstances } from "@/lib/bison/keys";

// Live Email Bison campaign read across ALL configured instances: the client
// runs three separate Bison installs (outboundhero / facilityreach /
// outboundclean), each with its own API token (EMAILBISON_KEYS json map, or a
// single EMAILBISON_API_KEY). Campaigns are merged and tagged with their
// instance domain so pushes route to the right install. A 30-second in-memory
// cache keeps bursts cheap while staying effectively real-time; ?fresh=1
// bypasses it.

const CACHE_TTL_MS = 60_000;          // considered fresh
const STALE_OK_MS = 15 * 60_000;     // served while a refresh runs behind it
const MAX_PAGES = 300;               // safety cap per instance (~4,500 campaigns)
// Per HTTP request. 8s was too tight and produced a false "list incomplete"
// warning on every client: app.facilityreach.com answers its campaign pages in
// ~7.1s under load (measured 2026-08-25), so it tripped at random even though
// nothing was actually missing. The scoped search is only a few pages now, so a
// longer ceiling costs nothing on the happy path.
const PAGE_TIMEOUT_MS = 20_000;
const INSTANCE_BUDGET_MS = 60_000;   // per instance, across all its pages
const PAGE_CONCURRENCY = 8;          // pages fetched in parallel per instance
// NOTE: Bison HARD-CAPS a page at 15 rows and ignores per_page/limit entirely
// (measured 2026-08-25), so page COUNT is the cost driver — hence the parallel
// page fetch in refresh() and the search path below.

// Server-side search — the escape hatch from that pagination. A client-scoped
// picker asks for exactly the campaigns it needs instead of enumerating the
// whole install and silently running out of budget.
//
// CAREFUL (measured 2026-08-25): Bison DROPS the search term from its own
// pagination links. A search response's links.next is plain
// `/api/campaigns?page=2` — so following it walks the ENTIRE UNFILTERED install
// from page 2 on (meta.total flips 32 -> 1429 mid-walk). That is how the picker
// ended up showing "JPCA: SEGs" twice: once from the real search page, then
// again when the unfiltered walk reached it. Page explicitly with search= on
// every request instead, driven by meta.last_page. (JPCA: 1429 rows in 50s
// following links.next, vs 32 rows over 3 pages in ~1s paging explicitly.)
const searchCache = new Map<string, { at: number; data: Array<Record<string, unknown>>; errors: string[] }>();

// TWO PAGINATION STYLES, one reader (measured 2026-08-26):
//   page-cursor : meta = {current_page, last_page, total}, links.next = ?page=2
//   keyset      : meta = {per_page, next_cursor},          links.next = ?cursor=…
// app.outboundhero.co served the first style in the morning and the second by
// the afternoon, so neither can be assumed. Anything that derives page COUNT
// from meta.last_page silently collapses to ONE page (15 rows) on a keyset
// install — and meta.total is absent there too, so the "list incomplete"
// warning cannot fire either. Follow links.next instead: it exists in both.
function nextUrl(json: unknown): string | null {
  const links = (json as { links?: { next?: unknown } } | null)?.links;
  return typeof links?.next === "string" && links.next ? links.next : null;
}

// Bison drops ?search= from its own next-links in BOTH styles, so page 2 onward
// silently becomes the whole unfiltered install. Re-apply the term every hop.
function withSearch(url: string, term: string): string {
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
function dedupeCampaigns(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const c of rows) {
    const key = `${c.instance_url ?? ""}#${c.id ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

async function searchInstances(
  instances: ReturnType<typeof bisonInstances>,
  term: string
): Promise<{ data: Array<Record<string, unknown>>; errors: string[] }> {
  const data: Array<Record<string, unknown>> = [];
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
            errors.push(`${domain}: partial — stopped after ${Math.round((Date.now() - startedAt) / 1000)}s`);
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
let cache: { at: number; data: Array<Record<string, unknown>>; errors: string[] } | null = null;
let inFlight: Promise<void> | null = null;
// Errors from the most recent attempt, kept even when it failed outright — a
// total failure is not cached, so without this the picker would report a
// useless "campaign fetch failed" instead of naming the instance and reason.
let lastErrors: string[] = [];

async function refresh(instances: ReturnType<typeof bisonInstances>): Promise<void> {
  const campaigns: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  await Promise.all(
    instances.map(async ({ domain, key }) => {
      const startedAt = Date.now();
      const get = async (target?: number | string) => {
        const url = typeof target === "string"
          ? target
          : `https://${domain}/api/campaigns${target ? `?page=${target}` : ""}`;
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
        });
        if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
        return res.json();
      };
      try {
        // Bison caps a page at 15 rows no matter what per_page says, so the
        // page COUNT is what costs time: outboundhero is ~1,429 campaigns over
        // ~96 pages.
        const first = await get();
        const list = Array.isArray(first?.data) ? first.data : [];
        for (const c of list) campaigns.push({ ...c, instance_url: domain });
        const expected: number | null = typeof first?.meta?.total === "number" ? first.meta.total : null;
        const lastPage = Math.min(Number(first?.meta?.last_page) || 1, MAX_PAGES);

        // KEYSET INSTALL (no last_page): pages are only reachable one at a time
        // through links.next, so this walks serially — ~21s for outboundhero's
        // 94 pages, inside the 60s budget. Deriving a page count from the
        // absent meta.last_page instead would silently stop at 15 campaigns.
        if (lastPage <= 1 && nextUrl(first)) {
          let url: string | null = nextUrl(first);
          let hops = 0;
          while (url && hops < MAX_PAGES) {
            if (Date.now() - startedAt > INSTANCE_BUDGET_MS) {
              errors.push(`${domain}: partial — stopped after ${Math.round((Date.now() - startedAt) / 1000)}s`);
              break;
            }
            const json = await get(url);
            const rows = Array.isArray(json?.data) ? json.data : [];
            for (const c of rows) campaigns.push({ ...c, instance_url: domain });
            if (rows.length === 0) break;
            url = nextUrl(json);
            hops++;
          }
        } else if (lastPage > 1) {
          const pages = Array.from({ length: lastPage - 1 }, (_, i) => i + 2);
          let next = 0;
          let aborted = false;
          await Promise.all(
            Array.from({ length: Math.min(PAGE_CONCURRENCY, pages.length) }, async () => {
              while (next < pages.length && !aborted) {
                const page = pages[next++];
                if (Date.now() - startedAt > INSTANCE_BUDGET_MS) { aborted = true; break; }
                try {
                  const json = await get(page);
                  const rows = Array.isArray(json?.data) ? json.data : [];
                  for (const c of rows) campaigns.push({ ...c, instance_url: domain });
                } catch {
                  aborted = true; // one bad page means the list is incomplete
                }
              }
            })
          );
          if (aborted) errors.push(`${domain}: partial — stopped after ${Math.round((Date.now() - startedAt) / 1000)}s`);
        }

        // Say so when the install holds more than we fetched, instead of
        // handing back a short list that looks complete.
        // Count DISTINCT campaigns: a duplicate must not mask a short list.
        const got = new Set(
          campaigns.filter((c) => c.instance_url === domain).map((c) => c.id)
        ).size;
        if (expected != null && got < expected) {
          errors.push(`${domain}: ${got} of ${expected} campaigns (list incomplete)`);
        }
      } catch (err) {
        const msg = err instanceof Error && err.name === "TimeoutError"
          ? `timed out after ${PAGE_TIMEOUT_MS / 1000}s`
          : err instanceof Error ? err.message : "fetch failed";
        errors.push(`${domain}: ${msg}`);
      }
    })
  );

  // Don't cache a total failure — an empty picker would replay for the full
  // TTL even after the instances recover.
  lastErrors = errors;
  const deduped = dedupeCampaigns(campaigns);
  if (deduped.length > 0 || errors.length === 0) {
    cache = { at: Date.now(), data: deduped, errors };
  }
}

function refreshOnce(instances: ReturnType<typeof bisonInstances>): Promise<void> {
  if (!inFlight) {
    inFlight = refresh(instances).finally(() => { inFlight = null; });
  }
  return inFlight;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const instances = bisonInstances();
  if (instances.length === 0) {
    return NextResponse.json(
      { error: "No Bison keys configured (EMAILBISON_KEYS or EMAILBISON_API_KEY)" },
      { status: 503 }
    );
  }

  const params = new URL(request.url).searchParams;
  const fresh = params.get("fresh") === "1";
  const search = (params.get("search") ?? "").trim();

  // Scoped read: ask each instance for just this client's campaigns. This is
  // the only path that is guaranteed COMPLETE — the unscoped enumeration below
  // can hit MAX_PAGES or the per-instance time budget and drop an entire
  // install from the picker (facilityreach's CCGCT campaigns sat on page 17+).
  if (search) {
    const key = search.toLowerCase();
    const hit = searchCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return NextResponse.json({ campaigns: hit.data, errors: hit.errors, cached: true, scoped: search });
    }
    const { data, errors } = await searchInstances(instances, search);
    if (data.length > 0 || errors.length === 0) {
      searchCache.set(key, { at: Date.now(), data, errors });
      if (searchCache.size > 50) searchCache.delete(searchCache.keys().next().value as string);
    }
    return NextResponse.json({ campaigns: data, errors, cached: false, scoped: search });
  }

  const age = cache ? Date.now() - cache.at : Infinity;

  if (!fresh && cache) {
    if (age < CACHE_TTL_MS) {
      return NextResponse.json({ campaigns: cache.data, errors: cache.errors, cached: true });
    }
    if (age < STALE_OK_MS) {
      // STALE-WHILE-REVALIDATE: hand back what we have immediately and refresh
      // behind it. Reading four live Bison installs takes seconds, and the
      // picker previously sat on "Loading campaigns…" for every one of them,
      // every time the cache lapsed. A campaign created moments ago shows up on
      // the next open, or right away via the picker's refresh (?fresh=1).
      void refreshOnce(instances).catch(() => {});
      return NextResponse.json({ campaigns: cache.data, errors: cache.errors, cached: true, stale: true });
    }
  }

  await refreshOnce(instances);
  // If everything failed, cache is untouched (possibly null) — surface the real
  // reasons from this attempt rather than a generic message.
  const failed = !cache || cache.at < Date.now() - CACHE_TTL_MS;
  return NextResponse.json({
    campaigns: cache?.data ?? [],
    errors: failed && lastErrors.length ? lastErrors : (cache?.errors ?? lastErrors),
    cached: false,
  });
}
