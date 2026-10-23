import { createAdminClient } from "@/lib/supabase/admin";
import { QUERY_ID_HEADER, isQueryId } from "./query-id";

// Server side of the Leads query ids (see ./query-id). PostgREST does not stop
// a query when its caller goes away: measured 2026-10-21, a count whose request
// was aborted at 4 s kept running until 14.7 s, and a heavy one runs to its
// 120 s limit while holding parallel workers the next search needs.
//
// The searches this server process is running are kept in a registry, so a
// cancel — from the page (POST /api/leads/cancel) or from the request's own
// disconnect — keeps trying until that search's RPC has settled: the search
// may still be on its way to PostgREST (it tags itself ~10 ms after it starts
// running in the database). A cancel for an id not running here is remembered
// for 2 minutes, and a search that arrives with that id is refused before it
// reaches the database. Kept on globalThis: the build inlines this module into
// each route's chunk, so module state alone would not be shared (checked
// 2026-10-23). Railway runs one replica; were there more, the direct attempts
// in cancelLeadQueries would still reach a search running on another one.

type Search = { settled: boolean; cancelling: boolean };
type Registry = {
  running: Map<string, Search>;
  cancelled: Map<string, number>; // id -> expiry: refuse the search if it arrives
  settled: Map<string, number>;   // id -> expiry: finished recently, nothing to cancel
  unavailableUntil: number;       // fn_cancel_lead_queries missing (migration 119 not applied)
};

const REGISTRY = "__leadQueryRegistry";
const shared = globalThis as typeof globalThis & { [REGISTRY]?: Registry };
const registry: Registry = (shared[REGISTRY] ??= {
  running: new Map(), cancelled: new Map(), settled: new Map(), unavailableUntil: 0,
});

const REMEMBER_MS = 120_000;
const UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
const DIRECT_RETRY_MS = [0, 500];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The caller's query id, or null when absent or malformed (nothing is tagged then). */
export function readQueryId(req: Request): string | null {
  const v = req.headers.get(QUERY_ID_HEADER)?.trim().toLowerCase() ?? "";
  return isQueryId(v) ? v : null;
}

/** The error an RPC returns when fn_cancel_lead_queries stopped it — expected, not a failure. */
export function isCancelledError(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "57014" && /user request/i.test(error.message ?? "");
}

/**
 * Backends signalled; "missing" when the function is not deployed (it then is
 * not tried again for 5 minutes, logged once); "failed" for any other error,
 * which is worth another try.
 */
async function cancelRpc(tags: string[]): Promise<number | "missing" | "failed"> {
  if (Date.now() < registry.unavailableUntil) return "missing";
  try {
    const { data, error, status } = await createAdminClient().rpc("fn_cancel_lead_queries", { p_tags: tags });
    if (error) {
      if (error.code === "PGRST202" || status === 404) {
        registry.unavailableUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
        console.warn("fn_cancel_lead_queries is not deployed (migration 119); Leads searches are not cancelled for 5 minutes");
        return "missing";
      }
      console.error("Cancel lead query RPC error:", error.message);
      return "failed";
    }
    return typeof data === "number" ? data : 0;
  } catch (err) {
    console.error("Cancel lead query error:", err);
    return "failed";
  }
}

/** Keep cancelling a search this process is running until its RPC settles (~2 min at most). */
async function cancelUntilSettled(id: string, s: Search): Promise<void> {
  if (s.cancelling) return;
  s.cancelling = true;
  try {
    let failures = 0;
    for (let delay = 0, waited = 0; !s.settled && waited <= 125_000; delay = delay ? Math.min(delay * 2, 1000) : 250) {
      if (delay) {
        await sleep(delay);
        waited += delay;
      }
      if (s.settled) return;
      const n = await cancelRpc([id]);
      if (n === "missing" || (typeof n === "number" && n > 0)) return; // stopped, or cannot be
      if (n === "failed" && ++failures >= 5) return;                    // each failure is logged; stop there
    }
  } finally {
    s.cancelling = false; // a later cancel for the same search may try again
  }
}

function prune(m: Map<string, number>) {
  const now = Date.now();
  for (const [id, until] of m) if (until < now) m.delete(id);
}

/**
 * Register a search just before its RPC. `refused` = the page has already
 * given up on it (an earlier cancel for this id, or the client is gone): do
 * not start it. Call `done()` once the RPC has settled.
 */
export function beginSearch(req: Request, queryId: string | null): { refused: boolean; done: () => void } {
  if (!queryId) return { refused: req.signal.aborted, done: () => {} };
  prune(registry.cancelled);
  if (registry.cancelled.delete(queryId) || req.signal.aborted) return { refused: true, done: () => {} };
  const s: Search = { settled: false, cancelling: false };
  registry.running.set(queryId, s);
  // Next aborts req.signal when the response closes before it finished — the
  // browser went away (measured with next start, 2026-10-23).
  const onAbort = () => { void cancelUntilSettled(queryId, s); };
  req.signal.addEventListener("abort", onAbort, { once: true });
  return {
    refused: false,
    done: () => {
      s.settled = true;
      registry.running.delete(queryId);
      prune(registry.settled);
      registry.settled.set(queryId, Date.now() + REMEMBER_MS);
      req.signal.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * The page gave up on these searches. One running in this process is cancelled
 * until its RPC settles; one that finished recently is left alone; any other id
 * is remembered (so the search is refused if it arrives later) and tried
 * directly in case it runs elsewhere. Never throws; returns how many searches
 * were found to cancel.
 */
export async function cancelLeadQueries(ids: string[]): Promise<number> {
  prune(registry.cancelled);
  prune(registry.settled);
  let found = 0;
  let elsewhere: string[] = [];
  for (const id of new Set(ids.filter(isQueryId))) {
    const s = registry.running.get(id);
    if (s) {
      found++;
      void cancelUntilSettled(id, s);
    } else if (!registry.settled.has(id)) {
      registry.cancelled.set(id, Date.now() + REMEMBER_MS);
      elsewhere.push(id);
    }
  }
  for (const delay of DIRECT_RETRY_MS) {
    if (!elsewhere.length) break;
    if (delay) await sleep(delay);
    elsewhere = elsewhere.filter((id) => registry.cancelled.has(id)); // refused meanwhile → nothing to do
    if (!elsewhere.length) break;
    const n = await cancelRpc(elsewhere);
    if (n === "missing") break;
    if (typeof n === "number") {
      found += n;
      if (n >= elsewhere.length) break;
    }
  }
  return found;
}
