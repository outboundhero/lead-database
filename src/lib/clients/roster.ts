// The client list every client dropdown reads (2026-11-21: "make the client dropdown instant").
//
// One list per browser tab, fetched from GET /api/bison/client-tags and kept: in memory, and in
// localStorage per signed-in user (`ohdb:client-roster:v1:<userId>`), so a dropdown shows it at once,
// also right after a reload. It is fetched again in the background: when the app loads
// (ClientRosterPrefetch in the app layout), when a dropdown opens and the list is over a minute old
// (ROSTER_FRESH_MS), when the tab comes back after ten minutes (ROSTER_REFOCUS_MS), and at once after a
// sync or a status change on the Clients page. One fetch at a time: callers share it. A failed fetch
// (a 401 once the session has gone, a network error) keeps the list shown and sets `error`. Signing out
// clears memory and every stored list; signing in as another user drops the other user's stored list.
//
// Client code: the route imports only its row type (`import type`), so nothing here reaches the server
// bundle. Nothing touches window or localStorage outside the guarded functions below, and server
// rendering reads the server snapshot (no list), so a page renders the same on the server and on its
// first paint in the browser.

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

/** One client of the list (GET /api/bison/client-tags). */
export interface ClientTagRow {
  tag: string;
  name: string | null;
  group_no: number | null;
  b2b_instance: string | null;
  b2c_instance: string | null;
  owner: string | null;
  status: string | null;
  client_type: string | null; // "Cleaning" | "Non-Cleaning" (Onboarding col F)
  churned: boolean; // its status says churn ("Confirmed Churn", "Churned")
  sendable: boolean; // has an instance pair (roster-only churned clients don't)
  contactable: number | null; // cached contactable-lead count (client_stats); null without a stats row
}

/** A dropdown opening refreshes the list in the background when it is older than this. */
export const ROSTER_FRESH_MS = 60_000;
/** The tab coming back refreshes the list when it is older than this. */
export const ROSTER_REFOCUS_MS = 10 * 60_000;
/** A stored list older than this is never shown. */
export const ROSTER_STORE_MAX_AGE_MS = 7 * 24 * 3_600_000;
/** The route the list comes from (fetched here only). */
export const ROSTER_URL = "/api/bison/client-tags";
/** localStorage keys: one per signed-in user, this prefix and the user's id. */
export const ROSTER_STORE_PREFIX = "ohdb:client-roster:v1:";

export interface RosterState {
  clients: ClientTagRow[] | null;
  fetchedAt: number | null;
  loading: boolean;
  error: string | null;
}

const SERVER_SNAPSHOT: RosterState = { clients: null, fetchedAt: null, loading: false, error: null };

let state: RosterState = SERVER_SNAPSHOT;
let owner: string | null = null; // the signed-in user setRosterOwner named
let listOwner: string | null = null; // whose list state.clients is (null: fetched before an owner was named)
let inflight: Promise<ClientTagRow[] | null> | null = null;
let followUp: Promise<ClientTagRow[] | null> | null = null;
let generation = 0; // moves when memory is cleared: a fetch of an older generation keeps nothing
const listeners = new Set<() => void>();

const inBrowser = () => typeof window !== "undefined";

function update(next: Partial<RosterState>) {
  state = { ...state, ...next };
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // one listener's failure never stops the others
    }
  }
}

/** This browser's localStorage, or null (server, private mode, storage refused: the access itself can throw). */
function storage(): Storage | null {
  try {
    return inBrowser() ? window.localStorage ?? null : null;
  } catch {
    return null;
  }
}

const text = (v: unknown) => (typeof v === "string" ? v : null);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isRow = (r: unknown): r is Record<string, unknown> =>
  !!r && typeof r === "object" && typeof (r as { tag?: unknown }).tag === "string" && (r as { tag: string }).tag !== "";

/** A row of the list as stored and shown: only the known fields, each of its type. */
function toRow(r: Record<string, unknown>): ClientTagRow {
  return {
    tag: r.tag as string,
    name: text(r.name),
    group_no: count(r.group_no),
    b2b_instance: text(r.b2b_instance),
    b2c_instance: text(r.b2c_instance),
    owner: text(r.owner),
    status: text(r.status),
    client_type: text(r.client_type),
    churned: r.churned === true,
    sendable: r.sendable === true,
    contactable: count(r.contactable),
  };
}

/** The user's stored list when it is theirs and under the max age; anything else stored there is removed. */
function readStored(userId: string, now: number): { at: number; clients: ClientTagRow[] } | null {
  const s = storage();
  if (!s) return null;
  const key = ROSTER_STORE_PREFIX + userId;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    let v: { v?: unknown; at?: unknown; owner?: unknown; clients?: unknown } | null = null;
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
    const at = typeof v?.at === "number" ? v.at : NaN;
    if (v?.v !== 1 || v.owner !== userId || !Array.isArray(v.clients) || !(now - at <= ROSTER_STORE_MAX_AGE_MS) || at > now + ROSTER_FRESH_MS) {
      s.removeItem(key);
      return null;
    }
    return { at, clients: v.clients.filter(isRow).map(toRow) };
  } catch {
    return null;
  }
}

function writeStored(userId: string, at: number, clients: ClientTagRow[]) {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(ROSTER_STORE_PREFIX + userId, JSON.stringify({ v: 1, at, owner: userId, clients }));
  } catch {
    // quota or private mode: the list still works from memory
  }
}

/** Removes every stored list but `keep` (a key, or null for none). */
function dropStored(keep: string | null) {
  const s = storage();
  if (!s) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k !== null && k.startsWith(ROSTER_STORE_PREFIX) && k !== keep) keys.push(k);
    }
    for (const k of keys) s.removeItem(k);
  } catch {
    // storage refused: nothing more can be done
  }
}

/** Empties memory; a fetch in flight from before keeps nothing. */
function resetMemory() {
  generation++;
  inflight = null;
  followUp = null;
  listOwner = null;
  update({ clients: null, fetchedAt: null, loading: false, error: null });
}

const isFresh = (now: number) =>
  state.clients !== null && state.fetchedAt !== null && now >= state.fetchedAt && now - state.fetchedAt < ROSTER_FRESH_MS;

/** Names the signed-in user: shows their stored list at once (when under the max age) and drops other users' stored lists. */
export function setRosterOwner(userId: string): void {
  if (!inBrowser() || !userId || owner === userId) return;
  owner = userId;
  const key = ROSTER_STORE_PREFIX + userId;
  dropStored(key);
  // Another user's list in memory (signed in as someone else without a reload): it goes.
  if (state.clients !== null && listOwner !== null && listOwner !== userId) resetMemory();
  if (state.clients !== null) {
    // Fetched before the owner was named, with this session: it is this user's list.
    listOwner = userId;
    if (state.fetchedAt !== null) writeStored(userId, state.fetchedAt, state.clients);
    return;
  }
  const stored = readStored(userId, Date.now());
  if (stored) {
    listOwner = userId;
    update({ clients: stored.clients, fetchedAt: stored.at });
  }
}

export function getRosterState(): RosterState {
  return state;
}

const getServerSnapshot = () => SERVER_SNAPSHOT;

export function subscribeRoster(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function failureText(res: Response): Promise<string> {
  if (res.status === 401 || res.type === "opaqueredirect") return "Not signed in: sign in again to load the clients.";
  let said: unknown = null;
  try {
    said = ((await res.json()) as { error?: unknown } | null)?.error;
  } catch {
    said = null;
  }
  return typeof said === "string" && said ? `The client list could not be loaded: ${said}` : `The client list could not be loaded (HTTP ${res.status}).`;
}

async function load(gen: number): Promise<ClientTagRow[] | null> {
  let clients: ClientTagRow[];
  try {
    // redirect "manual": without a session the middleware answers with a redirect to the login page,
    // which must read as a failure, not as a page to parse.
    const res = await fetch(ROSTER_URL, { cache: "no-store", credentials: "same-origin", redirect: "manual", headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(await failureText(res));
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      throw new Error("The client list could not be read (the answer was not JSON).");
    }
    const tags = (body as { tags?: unknown } | null)?.tags;
    if (!Array.isArray(tags)) throw new Error("The client list could not be read (no list in the answer).");
    clients = tags.filter(isRow).map(toRow);
  } catch (e) {
    if (gen !== generation) return null;
    update({ loading: false, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
  // Cleared (signed out) or another user named while it was in flight: nothing of it is kept.
  if (gen !== generation) return null;
  const at = Date.now();
  listOwner = owner;
  update({ clients, fetchedAt: at, loading: false, error: null });
  if (owner) writeStored(owner, at, clients);
  return clients;
}

function startFetch(): Promise<ClientTagRow[] | null> {
  const p: Promise<ClientTagRow[] | null> = load(generation).finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  update({ loading: true });
  return p;
}

/**
 * Fetches the list unless it is fresh (`force`: always). One fetch in flight at a time, and callers
 * share it; a forced refresh asked while one is in flight is answered by one more fetch after it (the
 * one in flight may have started before the change the caller just made). Never rejects: a failure
 * keeps the old list, sets `error` and resolves null. On the server it never fetches.
 */
export function refreshRoster(opts: { force?: boolean } = {}): Promise<ClientTagRow[] | null> {
  if (!inBrowser()) return Promise.resolve(state.clients);
  if (inflight) {
    if (!opts.force) return inflight;
    if (!followUp) {
      const gen = generation;
      followUp = inflight.then(() => {
        followUp = null;
        if (gen !== generation) return null;
        return inflight ?? startFetch();
      });
    }
    return followUp;
  }
  if (!opts.force && isFresh(Date.now())) return Promise.resolve(state.clients);
  return startFetch();
}

/** Signing out: empties memory and removes every stored list of this browser. */
export function clearClientRoster(): void {
  owner = null;
  resetMemory();
  dropStored(null);
}

/**
 * The list for a component: shown at once when cached; `refresh()` refreshes it in the background when
 * stale (`refresh(true)`: always). With `refreshOnMount` it does that when the component mounts.
 */
export function useClientRoster(opts: { refreshOnMount?: boolean } = {}): RosterState & { refresh: (force?: boolean) => void } {
  const snapshot = useSyncExternalStore(subscribeRoster, getRosterState, getServerSnapshot);
  const refreshOnMount = opts.refreshOnMount === true;
  useEffect(() => {
    if (refreshOnMount) void refreshRoster();
  }, [refreshOnMount]);
  const refresh = useCallback((force?: boolean) => {
    void refreshRoster({ force: force === true });
  }, []);
  return useMemo(() => ({ ...snapshot, refresh }), [snapshot, refresh]);
}
