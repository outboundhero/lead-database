#!/usr/bin/env node
// The client list (2026-11-21, "make the client dropdown instant"): GET /api/bison/client-tags checks
// the session, reads with ONE statement through the shared pg pool and says where its time went
// (Server-Timing), and every client dropdown reads one cached, prefetched list
// (src/lib/clients/roster.ts).
// LOCAL DATABASE ONLY. Made-up clients RTTEST_A (sendable, Active), RTTEST_B (churned, no install) and
// RTTEST_C (no install), with client_stats rows for A and B (C has none: its count reads null).
// NOTHING IS EVER COMMITTED: the route runs inside one transaction that is rolled back at its end. It
// refuses to run while client_tags or client_stats hold RTTEST_ rows (it would misread them as its own).
//
//   lockf -k -t 3600 <the lock file> node --env-file=.env.local scripts/test-client-roster.mjs
//
// Nothing here reaches a network: the route's session check is a stand-in, the store's fetch is a
// stand-in, and any other fetch is refused. The route and the store run for real through a small loader
// that compiles their TypeScript, with stand-ins only for next/server, the Supabase server client (the
// session) and the shared pg pool (the test's transaction, counting statements).
//
//   A. the route: 401 without a user; 200 with every field, the name and the old sort; one statement;
//      Server-Timing (auth, db, total) and Cache-Control on every answer; a failing pool gives 500
//   B. the store: one fetch for concurrent refreshes; fresh, stale and forced; the stored list per user;
//      a failure keeps the list; signing out clears memory and storage; listeners; storage that throws;
//      server rendering
//   C. wiring: who fetches the list, the layout, sign out, the Clients page, the consumers
//   N. nothing reached a network, nothing was left, no other client changed

import pg from "pg";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire, register } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` : ${String(detail).slice(0, 900)}` : ""}`);
}
const section = (s) => console.log(`\n${s}`);
/** JSON with object keys sorted, so two values compare whatever their key order. */
const stable = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const same = (a, b) => stable(a) === stable(b);
const eq = (name, got, want) => check(name, same(got, want), `got ${stable(got)} want ${stable(want)}`);

// ── No network ──────────────────────────────────────────────────────────────

const ROSTER_PATH = "/api/bison/client-tags";
const net = { calls: [], refused: [], active: 0, maxActive: 0 };
let answer = null; // (init) => Response-like, or a promise of one: the stand-in route's answer
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (u !== ROSTER_PATH || !answer) {
    net.refused.push(u);
    throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
  }
  net.calls.push({ url: u, init });
  net.active++;
  net.maxActive = Math.max(net.maxActive, net.active);
  try {
    return await answer(init);
  } finally {
    net.active--;
  }
};

// ── The TypeScript, compiled as it is imported ──────────────────────────────

const require = createRequire(import.meta.url);
const SRC = new URL("../src/", import.meta.url).href;
const T = (globalThis.__rtTest = { user: null, pool: null, statements: [], failPool: false });
const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}`,
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => ({ data: { user: globalThis.__rtTest.user }, error: null }) } };
}`,
  "@/lib/db/pool": `export function getPool() { return globalThis.__rtTest.pool; }`,
};
const HOOKS = `import { existsSync, readFileSync } from "node:fs";
let ts;
let src;
let stubs = {};
export async function initialize(data) {
  src = data.src;
  stubs = data.stubs;
  ts = (await import(data.typescript)).default;
}
const TS_FILE = /\\.tsx?$/;
function find(base) {
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    const u = new URL(base + ext);
    if (existsSync(u)) return u.href;
  }
  return null;
}
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(stubs, specifier)) return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  let hit = null;
  if (specifier.startsWith("@/")) hit = find(new URL(specifier.slice(2), src).href);
  else if (/^\\.\\.?\\//.test(specifier) && TS_FILE.test(context.parentURL ?? "") && !/\\.[cm]?[jt]sx?$/.test(specifier)) {
    hit = find(new URL(specifier, context.parentURL).href);
  }
  return hit ? { url: hit, shortCircuit: true } : next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("file:") && TS_FILE.test(url)) {
    const out = ts.transpileModule(readFileSync(new URL(url), "utf8"), {
      fileName: url,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return next(url, context);
}`;
register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, {
  data: { typescript: pathToFileURL(require.resolve("typescript")).href, src: SRC, stubs: STUBS },
});

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 2 });
const PREFIX = "RTTEST_";
const LIKE = "RTTEST\\_%";

async function leftovers() {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*) FROM client_tags WHERE tag LIKE $1)::int AS tags,
            (SELECT count(*) FROM client_stats WHERE tag LIKE $1)::int AS stats`, [LIKE]);
  return r;
}
/** Every client_tags and client_stats row, as one hash, to show nothing else changed. */
async function fingerprint() {
  const { rows: [r] } = await pool.query(
    `SELECT (SELECT count(*) FROM client_tags)::int AS tags_n,
            (SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t.tag), '')) FROM client_tags t) AS tags_h,
            (SELECT count(*) FROM client_stats)::int AS stats_n,
            (SELECT md5(coalesce(string_agg(s::text, '|' ORDER BY s.tag), '')) FROM client_stats s) AS stats_h`);
  return r;
}

const before = await leftovers();
if (before.tags || before.stats) {
  console.error(`Refusing to run: the database holds RTTEST_ rows (${before.tags} in client_tags, ${before.stats} in client_stats). They would be misread as this test's own.`);
  await pool.end();
  process.exit(1);
}
const printBefore = await fingerprint();

/** Runs fn(c) inside one transaction that is always rolled back. */
async function rolledBack(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

/** The web app's pool, on the test's transaction: counts every statement the route sends. */
function countingPool(c) {
  return {
    query(sql, params) {
      T.statements.push(typeof sql === "string" ? sql : sql?.text ?? String(sql));
      if (T.failPool) return Promise.reject(new Error("RTTEST: the pool is down"));
      return c.query(sql, params);
    },
    connect() {
      throw new Error("the route must not hold a client of its own");
    },
  };
}

const FIELDS = ["b2b_instance", "b2c_instance", "churned", "client_type", "contactable", "group_no", "name", "owner", "sendable", "status", "tag"];
const rank = (t) => (t.sendable ? 0 : 1) + (t.churned ? 1 : 0);
const byOldRule = (a, b) => rank(a) - rank(b) || a.tag.localeCompare(b.tag);
const TIMING = /^auth;dur=(\d+\.\d), db;dur=(\d+\.\d), total;dur=(\d+\.\d)$/;
function timingOk(res, { db }) {
  const m = TIMING.exec(res?.headers?.["Server-Timing"] ?? "");
  if (!m) return false;
  const [auth, dbMs, total] = m.slice(1).map(Number);
  if (!db && dbMs !== 0) return false;
  return total + 0.2 >= auth + dbMs;
}

// ── A. The route ────────────────────────────────────────────────────────────

section("A. GET /api/bison/client-tags");
const clientTags = await import(new URL("app/api/bison/client-tags/route.ts", SRC).href);
let localTiming = null;
await rolledBack(async (c) => {
  await c.query(
    `INSERT INTO client_tags (tag, name, group_no, b2b_instance, b2c_instance, owner, status, client_type) VALUES
       ($1, 'RTTEST Alpha Cleaning', 1, 'b2b-a.rttest.example', 'b2c-a.rttest.example', 'RTTEST Owner', 'Active', 'Cleaning'),
       ($2, NULL, NULL, NULL, NULL, NULL, 'Confirmed Churn', 'Non-Cleaning'),
       ($3, 'RTTEST Charlie', 2, NULL, NULL, 'RTTEST Owner', 'Active', NULL)`,
    [`${PREFIX}A`, `${PREFIX}B`, `${PREFIX}C`]);
  await c.query(`INSERT INTO client_stats (tag, leads, contactable) VALUES ($1, 1200, 900), ($2, 10, 0)`, [`${PREFIX}A`, `${PREFIX}B`]);
  T.pool = countingPool(c);

  // No session.
  T.user = null;
  T.statements = [];
  const anon = await clientTags.GET();
  eq("no user: 401 Unauthorized", [anon.status, anon.body], [401, { error: "Unauthorized" }]);
  check("no user: no statement reached the database", T.statements.length === 0, JSON.stringify(T.statements));
  check("no user: Server-Timing (auth, db 0.0, total) and Cache-Control private, no-store",
    timingOk(anon, { db: false }) && anon.headers["Cache-Control"] === "private, no-store", JSON.stringify(anon.headers));

  // A session.
  T.user = { id: "00000000-0000-4000-8000-0000000a11ce" };
  T.statements = [];
  const res = await clientTags.GET();
  const tags = res.body?.tags ?? [];
  check("a user: 200 with the list", res.status === 200 && Array.isArray(res.body?.tags) && tags.length > 0, JSON.stringify(res.body).slice(0, 300));
  check("exactly one statement, the joined read, with no SET or transaction around it",
    T.statements.length === 1 && /FROM client_tags t LEFT JOIN client_stats s ON s\.tag = t\.tag/.test(T.statements[0])
      && !T.statements.some((s) => /^\s*(SET|BEGIN|COMMIT)\b/i.test(s)), JSON.stringify(T.statements));
  check("Server-Timing with auth, db and total (one decimal each), Cache-Control private, no-store",
    timingOk(res, { db: true }) && res.headers["Cache-Control"] === "private, no-store", JSON.stringify(res.headers));
  localTiming = res.headers["Server-Timing"];
  check("every row holds exactly the eleven fields (the old ten and the name)",
    tags.every((t) => same(Object.keys(t).sort(), FIELDS)), JSON.stringify(tags.find((t) => !same(Object.keys(t).sort(), FIELDS))));

  const byTag = new Map(tags.map((t) => [t.tag, t]));
  eq("RTTEST_A: sendable, Active, its name, owner, group, installs and contactable count", byTag.get(`${PREFIX}A`), {
    tag: `${PREFIX}A`, name: "RTTEST Alpha Cleaning", group_no: 1, b2b_instance: "b2b-a.rttest.example", b2c_instance: "b2c-a.rttest.example",
    owner: "RTTEST Owner", status: "Active", client_type: "Cleaning", churned: false, sendable: true, contactable: 900,
  });
  eq("RTTEST_B: churned, no install, a stats row of 0 reads 0", byTag.get(`${PREFIX}B`), {
    tag: `${PREFIX}B`, name: null, group_no: null, b2b_instance: null, b2c_instance: null,
    owner: null, status: "Confirmed Churn", client_type: "Non-Cleaning", churned: true, sendable: false, contactable: 0,
  });
  eq("RTTEST_C: no install, not churned, no stats row reads null", byTag.get(`${PREFIX}C`), {
    tag: `${PREFIX}C`, name: "RTTEST Charlie", group_no: 2, b2b_instance: null, b2c_instance: null,
    owner: "RTTEST Owner", status: "Active", client_type: null, churned: false, sendable: false, contactable: null,
  });
  eq("the sort among the three as before: sendable first (A), then not sendable (C), then not sendable and churned (B)",
    tags.filter((t) => t.tag.startsWith(PREFIX)).map((t) => t.tag), [`${PREFIX}A`, `${PREFIX}C`, `${PREFIX}B`]);
  check("the whole list follows the old rule (sendable and active first, then by tag)",
    tags.every((t, i) => i === 0 || byOldRule(tags[i - 1], t) <= 0));

  // What the old route answered (two reads, then the same mapping and sort), from the same rows.
  const { rows: oldTags } = await c.query(`SELECT tag, group_no, b2b_instance, b2c_instance, owner, status, client_type FROM client_tags ORDER BY tag`);
  const { rows: oldStats } = await c.query(`SELECT tag, contactable FROM client_stats`);
  const statByTag = new Map(oldStats.map((s) => [s.tag, Number(s.contactable ?? 0)]));
  const old = oldTags.map((r) => ({
    tag: r.tag, group_no: r.group_no ?? null, b2b_instance: r.b2b_instance ?? null, b2c_instance: r.b2c_instance ?? null,
    owner: r.owner ?? null, status: r.status ?? null, client_type: r.client_type ?? null,
    churned: typeof r.status === "string" && r.status.toLowerCase().includes("churn"),
    sendable: !!r.b2b_instance || !!r.b2c_instance,
    contactable: statByTag.get(r.tag) ?? null,
  }));
  old.sort(byOldRule);
  const withoutName = tags.map(({ name: _name, ...rest }) => rest);
  check(`every client exactly as the old route gave it, in the same order (${old.length} clients)`, same(withoutName, old),
    JSON.stringify(withoutName.find((t, i) => !same(t, old[i]))));
  const { rows: names } = await c.query(`SELECT tag, name FROM client_tags`);
  const nameByTag = new Map(names.map((r) => [r.tag, r.name ?? null]));
  check("name: each client's client_tags.name (null when it has none)", tags.every((t) => t.name === nameByTag.get(t.tag)));

  // The pool fails.
  T.failPool = true;
  T.statements = [];
  const broken = await clientTags.GET();
  T.failPool = false;
  check("a failing pool: 500 with the error, after one statement", broken.status === 500
    && /RTTEST: the pool is down/.test(String(broken.body?.error)) && T.statements.length === 1, JSON.stringify([broken.status, broken.body]));
  check("a failing pool: Server-Timing and Cache-Control still on the answer",
    timingOk(broken, { db: true }) && broken.headers["Cache-Control"] === "private, no-store", JSON.stringify(broken.headers));
});
console.log(`  (local database) Server-Timing of the 200 answer: ${localTiming} (auth is a stand-in here)`);

// ── B. The store ────────────────────────────────────────────────────────────

section("B. the cached list (src/lib/clients/roster.ts)");
const roster = await import(new URL("lib/clients/roster.ts", SRC).href);
const KEY = (user) => `${roster.ROSTER_STORE_PREFIX}${user}`;
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  keys() { return [...this.map.keys()]; }
}
const area = new MemoryStorage();
const win = { localStorage: area };
const rosterKeys = () => area.keys().filter((k) => k.startsWith(roster.ROSTER_STORE_PREFIX));
const storedOf = (user) => {
  const raw = area.getItem(KEY(user));
  return raw === null ? null : JSON.parse(raw);
};

const row = (tag, extra = {}) => ({
  tag, name: null, group_no: 1, b2b_instance: `b2b-${tag.slice(-1).toLowerCase()}.rttest.example`, b2c_instance: null,
  owner: null, status: "Active", client_type: "Cleaning", churned: false, sendable: true, contactable: 10, ...extra,
});
const LIST1 = [row(`${PREFIX}A`), row(`${PREFIX}C`, { b2b_instance: null, sendable: false, contactable: null })];
const LIST2 = [row(`${PREFIX}A`, { contactable: 11, name: "RTTEST Alpha Cleaning" })];
const jsonAnswer = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const listAnswer = (tags) => () => jsonAnswer(200, { tags });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise((r) => setImmediate(r));
const state = () => roster.getRosterState();
const Probe = () => {
  const r = roster.useClientRoster({ refreshOnMount: true });
  return createElement("span", null, r.clients === null ? "no list" : `${r.clients.length} clients`);
};

// Server rendering first: no window.
check("server: no window here yet", typeof globalThis.window === "undefined");
roster.setRosterOwner("rttest-user-server");
const serverRefresh = await roster.refreshRoster({ force: true });
check("server: a refresh never fetches and answers no list", serverRefresh === null && net.calls.length === 0);
eq("server: the state is the empty one", state(), { clients: null, fetchedAt: null, loading: false, error: null });
check("server rendering with refreshOnMount: no list, no fetch", renderToString(createElement(Probe)) === "<span>no list</span>" && net.calls.length === 0);

// The browser.
globalThis.window = win;
let told = 0;
let unsubscribe = roster.subscribeRoster(() => told++);

answer = listAnswer(LIST1);
const first = await roster.refreshRoster();
check("no owner named yet: a refresh still loads the list (one fetch)", net.calls.length === 1 && same(first, LIST1) && same(state().clients, LIST1), JSON.stringify(state()));
check("the fetch asks for no cache and does not follow a redirect", net.calls[0].init?.cache === "no-store" && net.calls[0].init?.redirect === "manual");
eq("the state: the list, when it came, not loading, no error", [state().fetchedAt, state().loading, state().error], [clock, false, null]);
check("a name the server rendering gave was never kept: nothing stored without an owner", rosterKeys().length === 0, JSON.stringify(area.keys()));
check("listeners are told of the changes", told >= 2, `told ${told}`);

const U1 = "rttest-user-1";
roster.setRosterOwner(U1);
eq("naming the owner stores the list fetched before it under that user", storedOf(U1), { v: 1, at: clock, owner: U1, clients: LIST1 });
eq("and keeps showing it", state().clients, LIST1);

let calls = net.calls.length;
const fresh = await roster.refreshRoster();
check("fresh (under a minute): no fetch", net.calls.length === calls && same(fresh, LIST1));

clock += roster.ROSTER_FRESH_MS + 1000;
const gate = deferred();
answer = () => gate.promise;
const p1 = roster.refreshRoster();
const p2 = roster.refreshRoster();
check("stale: two refreshes at once (two dropdowns open), one fetch", net.calls.length === calls + 1, `${net.calls.length - calls} fetches`);
check("while it is in flight: loading, and the old list still shown", state().loading === true && same(state().clients, LIST1));
gate.resolve(jsonAnswer(200, { tags: LIST2 }));
const [r1, r2] = await Promise.all([p1, p2]);
check("both callers get the new list", same(r1, LIST2) && same(r2, LIST2) && same(state().clients, LIST2));
eq("the new list is stored for the owner, with its time", storedOf(U1), { v: 1, at: clock, owner: U1, clients: LIST2 });

calls = net.calls.length;
answer = listAnswer(LIST1);
await roster.refreshRoster({ force: true });
check("force: fetches although fresh", net.calls.length === calls + 1 && same(state().clients, LIST1));

// A forced refresh while one is in flight.
clock += roster.ROSTER_FRESH_MS + 1000;
calls = net.calls.length;
const slow = deferred();
const queue = [() => slow.promise, listAnswer(LIST2)];
answer = (init) => queue.shift()(init);
const pStale = roster.refreshRoster();
const pForce = roster.refreshRoster({ force: true });
const pForce2 = roster.refreshRoster({ force: true });
await tick();
check("a forced refresh while one is in flight: no second fetch at the same time", net.calls.length === calls + 1 && net.active === 1);
slow.resolve(jsonAnswer(200, { tags: LIST1 }));
const [rStale, rForce, rForce2] = await Promise.all([pStale, pForce, pForce2]);
check("then exactly one more fetch, after it; both forced callers get its list",
  net.calls.length === calls + 2 && same(rStale, LIST1) && same(rForce, LIST2) && same(rForce2, LIST2) && same(state().clients, LIST2),
  JSON.stringify([net.calls.length - calls, rStale, rForce]));
check("never two fetches in flight at once (whole test so far)", net.maxActive === 1, `max ${net.maxActive}`);

// Failures keep the list.
const shown = state().clients;
const shownAt = state().fetchedAt;
answer = () => jsonAnswer(500, { error: "RTTEST boom" });
const r500 = await roster.refreshRoster({ force: true });
check("a failed refresh (500): resolves null, keeps the list and its time, sets the error",
  r500 === null && state().clients === shown && state().fetchedAt === shownAt && /RTTEST boom/.test(state().error ?? "") && state().loading === false,
  JSON.stringify(state()));
answer = () => jsonAnswer(401, { error: "Unauthorized" });
await roster.refreshRoster({ force: true });
check("a 401 (the session has gone): the list stays shown, the error says to sign in",
  state().clients === shown && /sign in/i.test(state().error ?? ""), JSON.stringify(state().error));
answer = () => ({ ok: false, status: 0, type: "opaqueredirect", json: async () => { throw new Error("an opaque answer has no body"); } });
await roster.refreshRoster({ force: true });
check("a redirect to the login page (no session at the middleware): a failure, the list stays",
  state().clients === shown && /sign in/i.test(state().error ?? ""), JSON.stringify(state().error));
answer = () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } });
await roster.refreshRoster({ force: true });
check("an answer that is not JSON: a failure, the list stays", state().clients === shown && /not JSON/.test(state().error ?? ""), JSON.stringify(state().error));
answer = () => jsonAnswer(200, { nothing: true });
await roster.refreshRoster({ force: true });
check("an answer with no list: a failure, the list stays", state().clients === shown && /no list/.test(state().error ?? ""), JSON.stringify(state().error));
eq("the stored list is untouched by the failures", storedOf(U1)?.clients, LIST2);

answer = listAnswer(LIST1);
await roster.refreshRoster({ force: true });
check("a success after failures clears the error", state().error === null && same(state().clients, LIST1));

answer = listAnswer([{ ...row(`${PREFIX}A`), extra: "dropped", contactable: "12" }, { name: "RTTEST no tag" }, { tag: "" }, null]);
await roster.refreshRoster({ force: true });
eq("rows keep only the known fields, of their types; rows without a tag are dropped",
  state().clients, [{ ...row(`${PREFIX}A`), contactable: null }]);

answer = listAnswer([]);
await roster.refreshRoster({ force: true });
check("a list emptied by a sync is [] (the dropdown says No clients), not null", Array.isArray(state().clients) && state().clients.length === 0 && state().fetchedAt === clock);
eq("and it is stored as such", storedOf(U1)?.clients, []);

const toldBefore = told;
unsubscribe();
answer = listAnswer(LIST1);
await roster.refreshRoster({ force: true });
check("an unsubscribed listener is told nothing more", told === toldBefore, `${told - toldBefore} more`);
unsubscribe = roster.subscribeRoster(() => told++);

// Signing out.
area.setItem("rttest-other-app", "kept");
area.setItem(KEY("rttest-someone-else"), "{}");
roster.clearClientRoster();
eq("signing out: memory empty", state(), { clients: null, fetchedAt: null, loading: false, error: null });
check("signing out: every stored list gone, other keys kept", rosterKeys().length === 0 && area.getItem("rttest-other-app") === "kept", JSON.stringify(area.keys()));

const U2 = "rttest-user-2";
roster.setRosterOwner(U2);
const late = deferred();
answer = () => late.promise;
const pLate = roster.refreshRoster();
roster.clearClientRoster();
late.resolve(jsonAnswer(200, { tags: LIST1 }));
const rLate = await pLate;
check("a fetch in flight when signing out keeps nothing (no list, nothing stored)",
  rLate === null && state().clients === null && state().loading === false && rosterKeys().length === 0, JSON.stringify(state()));

// The stored list, per user.
const U3 = "rttest-user-3";
area.setItem(KEY(U3), JSON.stringify({ v: 1, at: clock - 5 * 60_000, owner: U3, clients: LIST2 }));
calls = net.calls.length;
roster.setRosterOwner(U3);
check("the owner's stored list shows at once, with its time, before any fetch",
  same(state().clients, LIST2) && state().fetchedAt === clock - 5 * 60_000 && net.calls.length === calls, JSON.stringify(state()));
answer = listAnswer(LIST1);
await roster.refreshRoster();
check("it is five minutes old: the app-load refresh fetches it again", net.calls.length === calls + 1 && same(state().clients, LIST1));

roster.clearClientRoster();
area.setItem(KEY(U3), JSON.stringify({ v: 1, at: clock - 60_000, owner: U3, clients: LIST2 }));
const U4 = "rttest-user-4";
roster.setRosterOwner(U4);
check("another user signing in: the first user's stored list is not shown, and is removed",
  state().clients === null && area.getItem(KEY(U3)) === null && area.getItem("rttest-other-app") === "kept", JSON.stringify(area.keys()));

roster.clearClientRoster();
const U5 = "rttest-user-5";
const U6 = "rttest-user-6";
roster.setRosterOwner(U5);
answer = listAnswer(LIST1);
await roster.refreshRoster();
const held = deferred();
answer = () => held.promise;
const pHeld = roster.refreshRoster({ force: true });
roster.setRosterOwner(U6);
check("another user named with no reload: the first user's list leaves memory and storage",
  state().clients === null && area.getItem(KEY(U5)) === null, JSON.stringify([state().clients, area.keys()]));
held.resolve(jsonAnswer(200, { tags: LIST2 }));
check("and the first user's fetch in flight keeps nothing", (await pHeld) === null && state().clients === null && area.getItem(KEY(U6)) === null);

roster.clearClientRoster();
const U7 = "rttest-user-7";
area.setItem(KEY(U7), JSON.stringify({ v: 1, at: clock - roster.ROSTER_STORE_MAX_AGE_MS - 60_000, owner: U7, clients: LIST1 }));
roster.setRosterOwner(U7);
check("a stored list older than seven days is not shown, and is removed", state().clients === null && area.getItem(KEY(U7)) === null);

for (const [what, value] of [
  ["not JSON", "not json"],
  ["of another version", JSON.stringify({ v: 2, at: clock, owner: "rttest-user-8", clients: LIST1 })],
  ["of another owner", JSON.stringify({ v: 1, at: clock, owner: "rttest-user-9", clients: LIST1 })],
  ["with no list", JSON.stringify({ v: 1, at: clock, owner: "rttest-user-8" })],
]) {
  roster.clearClientRoster();
  area.setItem(KEY("rttest-user-8"), value);
  roster.setRosterOwner("rttest-user-8");
  check(`a stored list ${what} is not shown, and is removed`, state().clients === null && area.getItem(KEY("rttest-user-8")) === null);
}

// Storage that throws.
roster.clearClientRoster();
Object.defineProperty(win, "localStorage", { configurable: true, get() { throw new Error("SecurityError: storage is refused"); } });
let threw = null;
try {
  roster.setRosterOwner("rttest-user-10");
  answer = listAnswer(LIST1);
  await roster.refreshRoster();
  roster.clearClientRoster();
  roster.setRosterOwner("rttest-user-10");
  await roster.refreshRoster({ force: true });
} catch (e) {
  threw = e;
}
check("localStorage whose access throws (private mode): no throw, the list works from memory", threw === null && same(state().clients, LIST1), String(threw));
const refusing = {};
for (const m of ["getItem", "setItem", "removeItem", "key"]) refusing[m] = () => { throw new Error("QuotaExceededError"); };
Object.defineProperty(refusing, "length", { get() { throw new Error("QuotaExceededError"); } });
Object.defineProperty(win, "localStorage", { configurable: true, value: refusing, writable: true });
threw = null;
let fromMemory = false;
try {
  roster.clearClientRoster();
  roster.setRosterOwner("rttest-user-11");
  answer = listAnswer(LIST2);
  const got = await roster.refreshRoster();
  fromMemory = same(got, LIST2) && same(state().clients, LIST2);
  roster.clearClientRoster();
} catch (e) {
  threw = e;
}
check("localStorage whose every call throws (quota): no throw, the list works from memory, signing out still empties it",
  threw === null && fromMemory && state().clients === null, String(threw));

// Server rendering again, with a list in the browser's memory.
win.localStorage = area;
roster.setRosterOwner("rttest-user-12");
answer = listAnswer(LIST1);
await roster.refreshRoster();
delete globalThis.window;
calls = net.calls.length;
check("server rendering reads the server snapshot even while memory holds a list", renderToString(createElement(Probe)) === "<span>no list</span>" && net.calls.length === calls);
globalThis.window = win;
roster.clearClientRoster();
unsubscribe();
Date.now = realNow;
check("nothing of the store left in the stand-in storage", rosterKeys().length === 0, JSON.stringify(area.keys()));

// ── C. Wiring ───────────────────────────────────────────────────────────────

section("C. wiring (source checks)");
const ROOT_DIR = fileURLToPath(new URL("../", import.meta.url));
const source = (p) => readFileSync(join(ROOT_DIR, p), "utf8");
function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT_DIR, dir)).sort()) {
    const p = `${dir}/${name}`;
    if (statSync(join(ROOT_DIR, p)).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const naming = walk("src").filter((p) => /["'`]\/api\/bison\/client-tags\b/.test(source(p)));
eq("no file under src/ names the list's route but the store", naming, ["src/lib/clients/roster.ts"]);

const ROSTER_IMPORT = /import \{[^}]*\buseClientRoster\b[^}]*\} from "@\/lib\/clients\/roster";/;
for (const p of [
  "src/components/filters/client-selector.tsx",
  "src/components/filters/filter-presets.tsx",
  "src/components/exports/send-to-bison-wizard.tsx",
  "src/components/exports/column-selector.tsx",
  "src/components/uploads/upload-people.tsx",
]) {
  const s = source(p);
  check(`${p}: reads the shared list (useClientRoster), fetches no list of its own`, ROSTER_IMPORT.test(s) && /useClientRoster\(/.test(s) && !/client-tags/.test(s));
}
const up = source("src/components/uploads/upload-people.tsx");
check("upload-people.tsx: no .from(\"client_tags\") left, no browser Supabase client", !/\.from\(\s*["']client_tags["']\s*\)/.test(up) && !/@\/lib\/supabase\/client/.test(up));

const sel = source("src/components/filters/client-selector.tsx");
check("the selector: Loading only while there is no list, No clients for an empty one, Retry forces, opening refreshes",
  /clients === null \?/.test(sel) && />No clients</.test(sel) && /onClick=\{\(\) => refresh\(true\)\}/.test(sel) && /onOpenChange=\{\(open\) => \{ if \(open\) refresh\(\); \}\}/.test(sel));
check("the selector: onRosterLoaded fires from an effect whenever a new list arrives",
  /useEffect\(\(\) => \{\s*if \(clients\) onLoadedRef\.current\?\.\(clients\);\s*\}, \[clients\]\);/.test(sel));
check("the selector: its props and the ClientRosterEntry type are unchanged",
  /export interface ClientRosterEntry \{/.test(sel) && /clientTag\?: string \| null;/.test(sel) && /onChange: \(tag: string \| null\) => void;/.test(sel)
    && /onSelected\?: \(tag: string\) => void;/.test(sel) && /onRosterLoaded\?: \(roster: ClientRosterEntry\[\]\) => void;/.test(sel));

const layout = source("src/app/(app)/layout.tsx");
check("the app layout renders the prefetch with the signed-in user's id",
  /import \{ ClientRosterPrefetch \} from "@\/components\/clients\/client-roster-prefetch";/.test(layout) && /<ClientRosterPrefetch userId=\{user\.id\} \/>/.test(layout));
const pre = source("src/components/clients/client-roster-prefetch.tsx");
check("the prefetch: a client component that names the owner, then refreshes; again when the tab comes back after ROSTER_REFOCUS_MS",
  /^"use client";/.test(pre) && pre.indexOf("setRosterOwner(userId)") > 0 && pre.indexOf("setRosterOwner(userId)") < pre.indexOf("void refreshRoster()")
    && /visibilitychange/.test(pre) && /ROSTER_REFOCUS_MS/.test(pre) && /return null;/.test(pre));

const menu = source("src/components/layout/user-menu.tsx");
const logout = menu.slice(menu.indexOf("async function handleLogout"), menu.indexOf("router.push(\"/login\")"));
check("sign out clears the list before the session goes", logout.includes("clearClientRoster();") && logout.indexOf("clearClientRoster();") < logout.indexOf("signOut()"));

const clientsPage = source("src/app/(app)/clients/page.tsx");
for (const fn of ["refreshStats", "syncGroups", "syncSheet", "patchClient"]) {
  const start = clientsPage.indexOf(`async function ${fn}(`);
  const end = clientsPage.indexOf("\n  }\n", start);
  const body = clientsPage.slice(start, end);
  const thrown = body.indexOf("if (!res.ok) throw");
  check(`the Clients page, ${fn}: a forced refresh of the list once it succeeded`,
    start > 0 && thrown > 0 && body.indexOf("void refreshRoster({ force: true });") > thrown);
}

const routeSrc = source("src/app/api/bison/client-tags/route.ts");
const routeCode = routeSrc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
check("the route: the row type from the store as a type only, re-exported",
  /^import type \{ ClientTagRow \} from "@\/lib\/clients\/roster";$/m.test(routeSrc) && /^export type \{ ClientTagRow \};$/m.test(routeSrc)
    && (routeSrc.match(/@\/lib\/clients\/roster/g) ?? []).length === 1);
check("the route: the session check before the pool, one query, no supabase-js read, no SET, headers in NextResponse.json's init",
  routeCode.indexOf("auth.getUser()") > 0 && routeCode.indexOf("auth.getUser()") < routeCode.indexOf("getPool()")
    && (routeCode.match(/getPool\(\)/g) ?? []).length === 1 && !/\.from\(/.test(routeCode) && !/\bSET\b/.test(routeCode)
    && /headers: headers\(/.test(routeCode) && !/\.headers\.set\(/.test(routeCode));

const store = source("src/lib/clients/roster.ts");
const imports = [...store.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
eq("the store imports nothing but react (nothing of the server)", imports, ["react"]);
const code = store.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l));
check("the store touches window and localStorage only in its two guarded helpers",
  code.filter((l) => /\bwindow\b|localStorage/.test(l)).every((l) => /^const inBrowser = \(\) => typeof window !== "undefined";$/.test(l.trim())
    || /^return inBrowser\(\) \? window\.localStorage \?\? null : null;$/.test(l.trim())),
  JSON.stringify(code.filter((l) => /\bwindow\b|localStorage/.test(l))));

// ── N. Nothing left ─────────────────────────────────────────────────────────

section("N. nothing reached a network, nothing was left, no other client changed");
check("no request left for the network", net.refused.length === 0, JSON.stringify(net.refused));
const left = await leftovers();
check("nothing of this test is in the database", left.tags === 0 && left.stats === 0, JSON.stringify(left));
const printAfter = await fingerprint();
check("every client_tags and client_stats row exactly as before", same(printAfter, printBefore),
  `${printBefore.tags_n}/${printBefore.stats_n} rows before, ${printAfter.tags_n}/${printAfter.stats_n} after`);

await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
