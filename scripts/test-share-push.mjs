#!/usr/bin/env node
// Share pushes (overlap sharing, plan 1.8 and 4.3): the share push
// (src/lib/sharing/push.ts) through its two routes, the push worker's part,
// the push route's 24-hour guard, the settings sheet's three new keys, and the
// Sharing page's routes.
//
// LOCAL DATABASE ONLY: made-up clients SPTEST_A to SPTEST_H, made-up imports,
// share jobs and shares, made-up people at .sptest.example (and made-up
// sptest-... freemail addresses for the B2C side), all removed at the end (and
// any left by a run that was cut off). It switches overlap_sharing on for its
// clients, and the fit gate on for one, and puts both back as they were. It
// writes a made-up stand-in into never_contact_inboxes and puts the row back.
//
//   node --env-file=.env.local scripts/test-share-push.mjs
//
// Run it under the shared local-database lock when other suites share the
// database. Migrations 131 to 136 must be in the local database. It starts no
// worker: the push worker's statements and its stop rule are read from
// scripts/push-worker.mjs and run here as written, inside transactions that
// are rolled back.
//
// Nothing here reaches a network: fetch answers the Bison campaign search
// from a made-up plan for the four install domains (with made-up keys) and
// refuses everything else. No paid key is read. The routes run for real
// through a small loader that compiles their TypeScript, with stand-ins only
// for: the session (a made-up user with a role), the Supabase server and admin
// clients of the push route (backed by the local database), the audit log, the
// worker's heartbeat, the shared pg pool (local, no TLS) and the share step's
// actions (scripts/lib/share/actions.mjs, built by the share build; recorded
// here so the routes' wiring is checked on its own). The Bearer key check is
// the real intakeKeyStatus().
//
//   W. wiring: the middleware, the moved campaign search, the pick, the stamping
//   K. the worker route's key and body
//   S. share pushes: off, nothing queued, cannot receive, not on the push list,
//      a search error, nothing picked, the happy path, a second call, one side
//      picked, the fit gate, more than 25,000 rows, held rows retried and aged out
//   P. Push shared: the dry run, older shares, held ones, the audit
//   G. the push route: the 24-hour guard, the stamping, the side split
//   R. the push worker: the stop rule, the cancel, the gather with skipAlreadySent
//   T. the settings route's three keys
//   V. the Sharing page's routes and the share step's actions
//   N. nothing reached the network, everything removed

import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { settingsFrom } from "./lib/enrich/settings.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
// No paid key reaches anything here, whatever the shell holds.
for (const k of [
  "OPENAI_API_KEY", "ENRICH_REOON_API_KEY", "REOON_API_KEY", "CLEARBIT_API_KEY", "FINDEMAIL_API_KEY", "ANTHROPIC_API_KEY",
  "AIARK_API_KEY", "AIARK_WEBHOOK_URL", "AIARK_AUTO_ADD_URL", "AIARK_AUTO_ADD_KEY", "FINDYMAIL_API_KEY", "PROSPEO_API_KEY",
  "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY", "ICYPEAS_API_KEY", "EMAILBISON_API_KEY", "EMAILBISON_BASE_URL", "EMAILBISON_KEYS",
  "SHARE_PUSH_KEY", "SHARE_PUSH_URL",
]) delete process.env[k];

// The four installs (scripts/lib/bison-groups.mjs), with made-up keys: only the stand-in fetch below ever sees them.
const B2B1 = "app.outboundhero.co";
const B2C1 = "personal.cleaningoutbound.com";
const B2B2 = "app.facilityreach.com";
const B2C2 = "personal.outboundclean.com";
process.env.EMAILBISON_KEYS = JSON.stringify(Object.fromEntries([B2B1, B2C1, B2B2, B2C2].map((d, i) => [d, `sptest-made-up-key-${i}`])));
const PUSH_KEY = "sptest-made-up-share-push-key-0123456789abcdef"; // 46 characters

const A = "SPTEST_A"; // the origin of the imports
const B = "SPTEST_B"; // a receiver on group 2 with campaigns on both sides
const C = "SPTEST_C"; // a receiver that cannot receive (Paused)
const D = "SPTEST_D"; // a receiver with campaigns on the B2B side only
const E = "SPTEST_E"; // a receiver for more than 25,000 shares
const F = "SPTEST_F"; // a receiver not on the push list (older shares, Push shared)
const G = "SPTEST_G"; // a receiver under the fit gate
const H = "SPTEST_H"; // a receiver whose campaigns are named for no one
const TAGS = [A, B, C, D, E, F, G, H];
const RUN = randomUUID().slice(0, 6);
const HOST = "sptest.example";
const FILE = `sptest-${RUN}`;
const biz = (who) => `${who}-${RUN}@${who}-co.${HOST}`;
const free = (who) => `sptest-${who}-${RUN}@gmail.com`;

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` : ${String(detail).slice(0, 900)}` : ""}`);
}
const section = (s) => console.log(`\n${s}`);
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs) => [...xs].sort();

// ── No network: a made-up Bison campaign search ──────────────────────────────

const net = { refused: 0, bison: [], plan: {}, fail: {}, pages: {} };
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if ([B2B1, B2C1, B2B2, B2C2].includes(u.hostname) && u.pathname === "/api/campaigns") {
    net.bison.push(u.href);
    const status = net.fail[u.hostname];
    if (status) return new Response(JSON.stringify({ error: "made-up failure" }), { status });
    const term = (u.searchParams.get("search") ?? "").toLowerCase();
    const rows = (net.plan[u.hostname] ?? []).filter((c) => String(c.name).toLowerCase().includes(term));
    // A made-up second page, to see the term put back on every hop.
    const two = net.pages[u.hostname];
    if (two && u.searchParams.get("page") !== "2") {
      return new Response(JSON.stringify({ data: rows, links: { next: `https://${u.hostname}/api/campaigns?page=2` } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: two ? two : rows, links: { next: null } }), { status: 200 });
  }
  net.refused++;
  throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
};
const camp = (id, name, status = "active") => ({ id, name, status, created_at: "2026-10-01T00:00:00Z", total_leads: 10 });

// ── The routes' TypeScript, compiled as it is imported ──────────────────────

const require = createRequire(import.meta.url);
const pgUrl = pathToFileURL(require.resolve("pg")).href;
const SRC = new URL("../src/", import.meta.url).href;
const authTsUrl = new URL("lib/enrich/auth.ts", SRC).href;
const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}`,
  // The session stand-in; the Bearer key check is the real one.
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
export { intakeKeyStatus } from "${authTsUrl}";
export async function requireRole(min) {
  const t = globalThis.__spTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__spTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__spTest.worker; }`,
  "@/lib/db/pool": `import pg from "${pgUrl}";
let p = null;
export function getPool() {
  if (!p) { p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 }); globalThis.__spTest.pools.push(p); }
  return p;
}`,
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => {
    const t = globalThis.__spTest;
    return { data: { user: t.role ? { id: t.userId, email: "sptest-user@${HOST}" } : null } };
  } } };
}`,
  // The push route's admin client, backed by the local database (only the calls that route makes).
  "@/lib/supabase/admin": `export function createAdminClient() {
  const t = globalThis.__spTest;
  return {
    from(table) {
      const op = { table, action: "select", payload: null, filters: [] };
      const b = {
        select() { return b; },
        insert(p) { op.action = "insert"; op.payload = p; return b; },
        update(p) { op.action = "update"; op.payload = p; return b; },
        eq(k, v) { op.filters.push(["eq", k, v]); return b; },
        in(k, v) { op.filters.push(["in", k, v]); return b; },
        gte(k, v) { op.filters.push(["gte", k, v]); return b; },
        order() { return b; },
        limit() { return b; },
        single() { return b; },
        maybeSingle() { return b; },
        then(ok, bad) { return Promise.resolve(t.supabase(op)).then(ok, bad); },
      };
      return b;
    },
  };
}`,
  // The share step's actions (built by the share build), recorded here.
  "../../../../../scripts/lib/share/actions.mjs": `export class ShareActionError extends Error {
  constructor(status, message) { super(message); this.name = "ShareActionError"; this.status = status; }
}
const t = () => globalThis.__spTest.actions;
async function run(name, pool, opts) {
  t().calls.push({ name, opts, pool: Boolean(pool && pool.query) });
  const plan = t().answer[name];
  if (plan && plan.refuse) throw new ShareActionError(plan.refuse[0], plan.refuse[1]);
  if (plan && plan.crash) throw new Error(plan.crash);
  return plan ? plan.body : {};
}
export const previewShareJob = (pool, opts) => run("preview", pool, opts);
export const applyShareJob = (pool, opts) => run("apply", pool, opts);
export const undoShareJob = (pool, opts) => run("undo", pool, opts);
export const retryShareJob = (pool, opts) => run("retry", pool, opts);`,
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

const pool = new pg.Pool({ connectionString: url, max: 6 });
const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0] ?? null;

const T = (globalThis.__spTest = {
  role: null,
  userId: randomUUID(),
  audits: [],
  worker: null,
  pools: [],
  adminOps: [],
  actions: { calls: [], answer: {} },
  // The push route's admin client: answers from, and writes to, the local database.
  async supabase(op) {
    T.adminOps.push(op);
    const eq = (k) => op.filters.find((f) => f[0] === "eq" && f[1] === k)?.[2];
    if (op.table === "user_profiles") return { data: T.role ? { role: T.role } : null, error: null };
    if (op.table === "client_tags" && op.action === "select") {
      return { data: await one(`SELECT tag, group_no, b2b_instance, b2c_instance FROM client_tags WHERE tag = $1`, [eq("tag")]), error: null };
    }
    if (op.table === "client_targeting") {
      return { data: await one(`SELECT countries, include_locations, require_location FROM client_targeting WHERE client_tag = $1`, [eq("client_tag")]), error: null };
    }
    if (op.table === "push_batches" && op.action === "insert") {
      const p = op.payload;
      const row = await one(
        `INSERT INTO push_batches (created_by, campaigns, filters, target_market, selected_ids, range_from, range_to, max_leads, client_tag, email_side, push_options, status)
         VALUES (NULL, $1::jsonb, $2::jsonb, $3::jsonb, $4::uuid[], $5, $6, $7, $8, $9, $10::jsonb, $11) RETURNING id`,
        [JSON.stringify(p.campaigns), p.filters ? JSON.stringify(p.filters) : null, p.target_market ? JSON.stringify(p.target_market) : null,
          p.selected_ids, p.range_from, p.range_to, p.max_leads, p.client_tag, p.email_side, p.push_options ? JSON.stringify(p.push_options) : null, p.status]
      );
      return { data: row, error: null };
    }
    if (op.table === "audit_logs") return { data: null, error: null };
    return { data: null, error: { message: `the test's admin client does not answer ${op.table} ${op.action}` } };
  },
});
const srcModule = (p) => import(new URL(p, SRC).href);
const route = (p) => srcModule(`app/api/${p}/route.ts`);
const as = (role) => {
  T.role = role;
};
async function call(handler, { body, raw, query, headers } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const req = {
    json: async () => (raw !== undefined ? JSON.parse(raw) : body),
    nextUrl: new URL(`http://share-push.test/api${qs}`),
    headers: new Headers(headers ?? {}),
  };
  const res = await handler(req);
  if (res instanceof Response) return { status: res.status, text: await res.text(), headers: res.headers };
  return { status: res.status, body: res.body, headers: res.headers };
}
const bearer = (k = PUSH_KEY) => ({ authorization: `Bearer ${k}` });
const heartbeat = (caps) => ({
  id: "share-push-test", last_seen: new Date().toISOString(), started_at: new Date().toISOString(), seconds_ago: 2, online: true,
  info: { capabilities: caps, keys: {} },
});

// ── The database ────────────────────────────────────────────────────────────

let settingsBefore = null;

async function setSharing(v) {
  const base = settingsBefore.find((r) => r.key === "overlap_sharing")?.value ?? {};
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'overlap_sharing'`, [JSON.stringify({ ...base, ...v })]);
}
const SHARING_ON = (extra = {}) => ({
  enabled: true, mode: "preview", tags: TAGS, push_tags: [B, C, D, E, G, H], since: new Date(Date.now() - 3600_000).toISOString(),
  held_retry_days: 7, ...extra,
});

async function client(tag, { status = "Active", group = 2, b2b = B2B2, b2c = B2C2, type = "Cleaning", places = [{ country: "US", state: "AZ" }] } = {}) {
  await pool.query(
    `INSERT INTO client_tags (tag, group_no, b2b_instance, b2c_instance, status, client_type, name, on_groups_tab, churn_cell_state, groups_tab_read_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, 'empty', now())`,
    [tag, group, b2b, b2c, status, type, `Made-up ${tag.toLowerCase()}`]
  );
  await pool.query(
    `INSERT INTO client_targeting (client_tag, countries, include_locations, require_location) VALUES ($1, ARRAY['US'], $2::jsonb, true)`,
    [tag, JSON.stringify(places)]
  );
}

async function lead(email, extra = {}) {
  const r = await one(
    `INSERT INTO leads (email, company, city, state, country_code, location_status, email_type, validation_status)
     VALUES ($1, $2, 'Phoenix', 'AZ', 'US', 'resolved', $3, 'valid') RETURNING id`,
    [email, extra.company ?? "Made-up Cleaning Co", extra.emailType ?? "personal"]
  );
  return r.id;
}

/** A finished import of the origin and its share job (applied), as the share step leaves them. */
async function job(origin = A, { topup = false } = {}) {
  const b = await one(
    `INSERT INTO upload_batches (filename, total_rows, inserted_rows, status, batch_type, field_mapping, add_tags, completed_at)
     VALUES ($1, 1, 1, 'complete', 'leads', '{}'::jsonb, ARRAY[$2], now()) RETURNING id`,
    [`${FILE}-${randomUUID().slice(0, 4)}.csv`, origin]
  );
  await pool.query(
    `INSERT INTO share_jobs (batch_id, origin_tag, origin_pool, state, topup, mode, batch_done_at, decided_at, applied_at, new_leads)
     VALUES ($1, $2, 'cleaning', 'applied', $3, 'preview', now(), now(), now(), 1)`,
    [b.id, origin, topup]
  );
  return b.id;
}

/** One share row: applied and queued by default. */
async function share(batch, leadId, receiver, { origin = A, outcome = "shared", push = "queued", applied = true } = {}) {
  const r = await one(
    `INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, applied_at, push_state, matched_place)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END, $7, '{"country": "US", "state": "AZ", "city": null, "label": "AZ"}'::jsonb)
     RETURNING id::text AS id`,
    [batch, leadId, outcome === "own_topup" ? receiver : origin, receiver, outcome, applied, applied ? push : null]
  );
  return r.id;
}
const shareRow = (id) => one(`SELECT * FROM lead_shares WHERE id = $1`, [id]);
const batchesOf = (tag) => all(`SELECT * FROM push_batches WHERE client_tag = $1 ORDER BY created_at, id`, [tag]);

async function cleanup() {
  const tagLike = "SPTEST\\_%";
  await pool.query(`DELETE FROM push_items WHERE batch_id IN (SELECT id FROM push_batches WHERE client_tag LIKE $1)`, [tagLike]);
  await pool.query(`DELETE FROM push_batches WHERE client_tag LIKE $1`, [tagLike]);
  await pool.query(`DELETE FROM upload_batches WHERE filename LIKE 'sptest-%'`); // share_jobs and lead_shares go with them
  await pool.query(`DELETE FROM lead_shares WHERE receiver_tag LIKE $1 OR origin_tag LIKE $1`, [tagLike]);
  await pool.query(`DELETE FROM bison_leads WHERE email LIKE $1 OR email LIKE 'sptest-%@gmail.com'`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1 OR email LIKE 'sptest-%@gmail.com'`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag LIKE $1`, [tagLike]);
  await pool.query(`DELETE FROM client_tags WHERE tag LIKE $1`, [tagLike]);
  if (settingsBefore) {
    // Every row as it was (the settings route writes the sheet's other rows too), and none it added.
    for (const r of settingsBefore) await pool.query(`UPDATE enrich_settings SET value = $2::jsonb WHERE key = $1`, [r.key, JSON.stringify(r.value)]);
    await pool.query(`DELETE FROM enrich_settings WHERE NOT (key = ANY($1::text[]))`, [settingsBefore.map((r) => r.key)]);
  }
}

// ── W. Wiring ───────────────────────────────────────────────────────────────

async function partW() {
  section("W. Wiring: the middleware, the moved campaign search, the pick, the stamping");
  const mw = source("src/middleware.ts");
  const matcher = /"(\/\(\(\?![^"]+)"/.exec(mw)?.[1]?.replace(/\\\\/g, "\\");
  const re = new RegExp(`^${matcher}$`);
  check("the worker's share push route is outside the session middleware", !re.test("/api/sharing/push/auto"), matcher);
  check("... and the Sharing page's own routes are not", ["/api/sharing/push", "/api/sharing/jobs", "/api/sharing/apply", "/leads/sharing"].every((p) => re.test(p)));
  check("... and the other worker routes stay outside it", ["/api/aiark/add/auto", "/api/companies/promote/auto", "/api/uploads/found/auto"].every((p) => !re.test(p)) &&
    /api\/aiark\/add\/auto\|api\/companies\/promote\/auto\|/.test(mw));

  const cc = await srcModule("lib/bison/client-campaigns.ts");
  const route = source("src/app/api/bison/campaigns/route.ts");
  check("the campaigns route uses the moved search and keeps no copy of it",
    route.includes(`from "@/lib/bison/client-campaigns"`) && !/async function searchInstances/.test(route) && /searchInstances\(instances, search\)/.test(route));
  net.plan = { [B2B2]: [camp(1, `${B}: Main`), camp(2, "SPTEST_BX: Other")], [B2C2]: [camp(3, `${B}: Main`)] };
  net.pages = { [B2B2]: [camp(4, `${B}: Page two`)] };
  const before = net.bison.length;
  const got = await cc.searchInstances([{ domain: B2B2, key: "k1" }, { domain: B2C2, key: "k2" }], B);
  const asked = net.bison.slice(before);
  check("the search asks each install by name and puts the term back on its own next page",
    got.errors.length === 0 && asked.length === 3 && asked.every((u) => new URL(u).searchParams.get("search") === B) &&
      asked.some((u) => new URL(u).searchParams.get("page") === "2"), JSON.stringify(asked));
  check("... each row carries its install, once each", same(sorted(got.data.map((c) => `${c.instance_url}#${c.id}`)), sorted([`${B2B2}#1`, `${B2B2}#2`, `${B2B2}#4`, `${B2C2}#3`])));
  net.pages = {};
  net.fail[B2C2] = 500;
  const bad = await cc.searchInstances([{ domain: B2B2, key: "k1" }, { domain: B2C2, key: "k2" }], B);
  delete net.fail[B2C2];
  check("an install that fails is named in the errors", bad.errors.length === 1 && bad.errors[0] === `${B2C2}: HTTP 500`, JSON.stringify(bad.errors));
  const keys = process.env.EMAILBISON_KEYS;
  delete process.env.EMAILBISON_KEYS;
  const none = await cc.searchClientCampaigns(B);
  process.env.EMAILBISON_KEYS = keys;
  check("with no Bison key the client search is an error, never an empty list", none.data.length === 0 && /No Bison keys/.test(none.errors[0] ?? ""));

  const { pickShareCampaigns, SHARE_CAMPAIGN_STATUSES } = await srcModule("lib/sharing/pick.ts");
  const installs = { b2b_instance: B2B2, b2c_instance: B2C2 };
  const rows = [
    { ...camp(11, `${B}: Google + Custom`), instance_url: B2B2 },
    { ...camp(12, `${B}: Outlook`, "draft"), instance_url: B2B2 },
    { ...camp(13, `${B}: Outlook (March)`, "paused"), instance_url: B2B2 },
    { ...camp(14, `${B}: Nurture`), instance_url: B2B2 },
    { ...camp(21, `${B}: Google + Custom`), instance_url: B2C2 },
    { ...camp(22, `${B}: SEGs`, "completed"), instance_url: B2C2 },
  ];
  const p1 = pickShareCampaigns(rows, B, installs);
  check("only Active or Draft campaigns are kept", same([...SHARE_CAMPAIGN_STATUSES], ["active", "draft"]));
  check("a paused campaign is dropped before the pick (else its Outlook twin would block it)",
    p1.blocked === null && same(p1.bySide.b2b.map((c) => c.id), [11, 12]) && same(p1.bySide.b2c.map((c) => c.id), [21]) && p1.notLive === 2, JSON.stringify(p1));
  check("... and the same list with the paused one live picks nothing, as the export popup would",
    pickShareCampaigns(rows.map((c) => ({ ...c, status: "active" })), B, installs).blocked?.includes("Outlook campaigns on"));
  check("each picked campaign carries its side and its bucket from the name",
    p1.bySide.b2b.every((c) => c.side === "b2b") && p1.bySide.b2c.every((c) => c.side === "b2c") &&
      p1.bySide.b2b.find((c) => c.id === 12)?.bucket === "outlook" && p1.bySide.b2b.find((c) => c.id === 11)?.bucket === "default");
  const p2 = pickShareCampaigns([{ ...camp(31, "SPTEST_Z: Main"), instance_url: B2B2 }], B, installs);
  check("nothing named for the client: blocked with the popup's reason", p2.blocked === `no campaign is named "${B}: …"` && !p2.bySide.b2b.length);
  const p3 = pickShareCampaigns([{ ...camp(32, `${B}: Main`, "paused"), instance_url: B2B2 }], B, installs);
  check("... and it says when the client's only campaigns are not Active or Draft", /1 of its campaigns are not Active or Draft/.test(p3.blocked ?? ""), p3.blocked);
  const p4 = pickShareCampaigns([{ ...camp(41, `${B}: Main`), instance_url: B2B1 }, { ...camp(42, `${B}: Main`), instance_url: B2C1 }], B, null);
  check("no saved installs: one group's installs take their fixed sides", p4.blocked === null && p4.bySide.b2b[0]?.instance_url === B2B1 && p4.bySide.b2c[0]?.instance_url === B2C1);

  const stamp = await srcModule("lib/bison/push-stamp.ts");
  const cs = [{ name: `${B}: SEGs`, instance_url: B2B2 }, { name: `${B}: Main`, instance_url: B2C2, bucket: "outlook" }, { name: "x", instance_url: B2B1 }];
  const saved = stamp.stampCampaigns(cs, { b2b_instance: `https://${B2B2}/`, b2c_instance: B2C2 });
  check("the shared stamping: a bucket from the name unless one was given, a side from the saved installs, none off them",
    same(saved, { b2b: B2B2, b2c: B2C2 }) && cs[0].bucket === "seg" && cs[0].side === "b2b" && cs[1].bucket === "outlook" && cs[1].side === "b2c" && !cs[2].side && !cs[2].bucket);
  const pb = source("src/app/api/bison/push-batch/route.ts");
  check("the push route stamps and splits through it", pb.includes("stampCampaigns(campaigns, tagRow)") && pb.includes("idsOfSide(getPool(), selectedIds!, emailSide)") &&
    !pb.includes("suggestBucketFromName"));
}

// ── K. The worker route's key and body ──────────────────────────────────────

async function partK(auto) {
  section("K. POST /api/sharing/push/auto: the key and the body");
  const r0 = await call(auto.POST, { body: { receiver: B }, headers: bearer() });
  check("no SHARE_PUSH_KEY set: 503", r0.status === 503);
  process.env.SHARE_PUSH_KEY = "too-short";
  check("a key under 32 characters counts as not set", (await call(auto.POST, { body: { receiver: B }, headers: bearer("too-short") })).status === 503);
  process.env.SHARE_PUSH_KEY = PUSH_KEY;
  const r1 = await call(auto.POST, { body: { receiver: B }, headers: bearer("sptest-wrong-key-sptest-wrong-key-xx") });
  check("a wrong key: 401 with WWW-Authenticate: Bearer", r1.status === 401 && r1.headers?.["WWW-Authenticate"] === "Bearer");
  check("no Bearer at all: 401", (await call(auto.POST, { body: { receiver: B } })).status === 401);
  process.env.AIARK_AUTO_ADD_KEY = PUSH_KEY.replace("share", "aiark");
  check("the AI Ark add key is not the share push key", (await call(auto.POST, { body: { receiver: B }, headers: bearer(process.env.AIARK_AUTO_ADD_KEY) })).status === 401);
  delete process.env.AIARK_AUTO_ADD_KEY;
  check("a body that is not JSON: 400", (await call(auto.POST, { raw: "{nope", headers: bearer() })).status === 400);
  check("a receiver that is no tag: 400", (await call(auto.POST, { body: { receiver: "not a tag!" }, headers: bearer() })).status === 400);
  check("retryHeld that is not true or false: 400", (await call(auto.POST, { body: { receiver: B, retryHeld: "yes" }, headers: bearer() })).status === 400);
}

// ── S. Share pushes ─────────────────────────────────────────────────────────

const ctx = {};

async function partS(auto) {
  section("S. Share pushes");
  const push = (receiver, extra = {}) => call(auto.POST, { body: { receiver, ...extra }, headers: bearer() });

  // The happy path's data: B gets business and freemail leads, its own top-up leads, one in the mirror, one gone.
  ctx.jobAB = await job(A);
  ctx.jobB = await job(B, { topup: true });
  ctx.lb = [await lead(biz("b1")), await lead(biz("b2")), await lead(biz("b3"))];
  ctx.lc = [await lead(free("c1")), await lead(free("c2"))];
  ctx.lmirror = await lead(biz("mirror"));
  ctx.lgone = await lead(biz("gone"));
  ctx.ltop = await lead(biz("top"));
  ctx.sb = [];
  for (const id of [...ctx.lb, ...ctx.lc, ctx.lmirror, ctx.lgone]) ctx.sb.push(await share(ctx.jobAB, id, B));
  ctx.stop = await share(ctx.jobB, ctx.ltop, B, { outcome: "own_topup" });
  ctx.sbNull = await share(ctx.jobAB, await lead(biz("never-queued")), B, { push: null });
  await pool.query(`DELETE FROM leads WHERE id = $1`, [ctx.lgone]);
  await pool.query(
    `INSERT INTO bison_leads (instance_url, bison_id, email, campaigns) VALUES ($1, 990000001, $2, '[{"campaign_id": 9101}]'::jsonb)`,
    [B2B2, biz("mirror")]
  );
  net.plan = {
    [B2B2]: [camp(9101, `${B}: Google + Custom`), camp(9102, `${B}: Outlook`, "draft"), camp(9103, `${B}: Outlook (old)`, "paused"),
      camp(9301, `${D}: Google + Custom`), camp(9501, `${E}: Google + Custom`), camp(9601, `${F}: Google + Custom`), camp(9701, `${G}: Main`)],
    [B2C2]: [camp(9201, `${B}: Google + Custom`)],
  };

  // Ships off.
  const s0 = await push(B);
  check("sharing switched off (as shipped): 409, nothing changes, the shares stay queued",
    s0.status === 409 && s0.body.kept === 8 && /switched off/.test(s0.body.error) && (await batchesOf(B)).length === 0 &&
      (await shareRow(ctx.sb[0])).push_state === "queued", JSON.stringify(s0.body));
  await setSharing(SHARING_ON());

  const bisonBefore = net.bison.length;
  const s1 = await push(H);
  check("nothing queued for the client: 200, nothing to push, no Bison read", s1.status === 200 && s1.body.note === "nothing to push" &&
    s1.body.pushed === 0 && net.bison.length === bisonBefore, JSON.stringify(s1.body));

  // A client that cannot receive.
  const sc = await share(ctx.jobAB, await lead(biz("c-one")), C);
  const s2 = await push(C);
  const rc = await shareRow(sc);
  check("a client that cannot receive: its shares are held with the reason, no Bison read", s2.status === 200 && s2.body.held === 1 &&
    rc.push_state === "held" && rc.push_note === "cannot receive: status Paused" && rc.held_since && net.bison.length === bisonBefore, JSON.stringify(s2.body));

  // Off the push list.
  const sd = await share(ctx.jobAB, await lead(biz("d-off")), D);
  await setSharing(SHARING_ON({ push_tags: [B, C, E, G, H] }));
  const s3 = await push(D);
  check("a client off the push list: held, \"not on the push list\"", s3.status === 200 && (await shareRow(sd)).push_note === "not on the push list" &&
    (await shareRow(sd)).push_state === "held");
  await setSharing(SHARING_ON());

  // A search error holds the round.
  net.fail[B2C2] = 502;
  const s4 = await push(B);
  delete net.fail[B2C2];
  check("any campaign search error: 409, nothing pushed, the shares stay queued", s4.status === 409 && s4.body.kept === 8 &&
    s4.body.error.includes(`${B2C2}: HTTP 502`) && (await batchesOf(B)).length === 0 &&
    (await all(`SELECT push_state FROM lead_shares WHERE id = ANY($1::bigint[])`, [ctx.sb])).every((r) => r.push_state === "queued"));

  // Nothing ticked.
  const sh = await share(ctx.jobAB, await lead(biz("h-one")), H);
  const s5 = await push(H);
  check("no campaign is named for the client: every share held with the pick's reason, nothing inserted",
    s5.status === 200 && s5.body.held === 1 && (await shareRow(sh)).push_note === `no campaign is named "${H}: …"` && (await batchesOf(H)).length === 0, JSON.stringify(s5.body));

  // The happy path.
  const s6 = await push(B);
  const bs = await batchesOf(B);
  const byKey = Object.fromEntries(bs.map((b) => [`${b.push_options?.source}/${b.email_side}`, b]));
  check("the shares go into one batch per source and side", s6.status === 200 && bs.length === 3 &&
    same(sorted(Object.keys(byKey)), ["share/b2b", "share/b2c", "topup/b2b"]) && same(sorted(s6.body.batches), sorted(bs.map((b) => b.id))), JSON.stringify(s6.body));
  const sb2b = byKey["share/b2b"];
  check("... the business leads in the B2B batch, the freemail ones in the B2C batch, the top-up lead in its own",
    same(sorted(sb2b.selected_ids), sorted(ctx.lb)) && same(sorted(byKey["share/b2c"].selected_ids), sorted(ctx.lc)) &&
      same(byKey["topup/b2b"].selected_ids, [ctx.ltop]));
  check("... each batch: the receiver's tag, no filters, no creator, pending, push_options { source, skipAlreadySent }",
    bs.every((b) => b.client_tag === B && b.filters === null && b.created_by === null && b.status === "pending" && b.push_options?.skipAlreadySent === true &&
      Object.keys(b.push_options).length === 2 && b.target_market?.include_locations?.[0]?.state === "AZ"));
  check("... the B2B batch's campaigns: the Active and the Draft one on the B2B install, stamped; the paused one left out",
    same(sb2b.campaigns.map((c) => [c.id, c.instance_url, c.side, c.bucket ?? null]), [[9101, B2B2, "b2b", "default"], [9102, B2B2, "b2b", "outlook"]]) &&
      same(byKey["share/b2c"].campaigns.map((c) => [c.id, c.side]), [[9201, "b2c"]]), JSON.stringify(sb2b.campaigns));
  const rows = await all(`SELECT id::text AS id, push_state, push_note, push_batch_id, pushed_at FROM lead_shares WHERE receiver_tag = $1`, [B]);
  const rowOf = (id) => rows.find((r) => r.id === id);
  check("... and in the same transaction each share is marked pushed with its own batch",
    [...ctx.sb.slice(0, 3)].every((id) => rowOf(id).push_state === "pushed" && rowOf(id).push_batch_id === sb2b.id && rowOf(id).pushed_at) &&
      ctx.sb.slice(3, 5).every((id) => rowOf(id).push_batch_id === byKey["share/b2c"].id) && rowOf(ctx.stop).push_batch_id === byKey["topup/b2b"].id);
  check("a lead the Bison mirror shows in a picked campaign is dropped (in_campaign) and in no batch",
    rowOf(ctx.sb[5]).push_state === "dropped" && rowOf(ctx.sb[5]).push_note === "in_campaign" && !bs.some((b) => b.selected_ids.includes(ctx.lmirror)));
  check("a share whose lead is gone is dropped (no_lead)", rowOf(ctx.sb[6]).push_state === "dropped" && rowOf(ctx.sb[6]).push_note === "no_lead");
  check("an applied share never queued is left alone", rowOf(ctx.sbNull).push_state === null && rowOf(ctx.sbNull).push_batch_id === null);
  check("the answer counts them, and names the install the mirror does not cover", s6.body.pushed === 6 && s6.body.dropped === 2 && s6.body.held === 0 &&
    s6.body.left === 0 && s6.body.note?.includes(`the Bison mirror holds nothing for ${B2C2}`), JSON.stringify(s6.body));
  const s7 = await push(B);
  check("a second call adds nothing", s7.status === 200 && s7.body.note === "nothing to push" && (await batchesOf(B)).length === 3);

  // One side picked.
  ctx.ld = { b2b: await lead(biz("d1")), b2c: await lead(free("d2")) };
  const sd1 = await share(ctx.jobAB, ctx.ld.b2b, D);
  const sd2 = await share(ctx.jobAB, ctx.ld.b2c, D);
  await setSharing(SHARING_ON());
  const s8 = await push(D);
  const db = await batchesOf(D);
  check("one side picked: the B2B leads pushed in a B2B batch, the freemail ones held \"no B2C campaign\"",
    s8.status === 200 && db.length === 1 && same(db[0].selected_ids, [ctx.ld.b2b]) && db[0].email_side === "b2b" &&
      db[0].campaigns.every((c) => c.instance_url === B2B2 && c.side === "b2b") && (await shareRow(sd1)).push_state === "pushed" &&
      (await shareRow(sd2)).push_state === "held" && (await shareRow(sd2)).push_note === "no B2C campaign" && s8.body.held === 1, JSON.stringify(s8.body));
  check("... and the share held earlier off the push list stays held (no retry asked)", (await shareRow(sd)).push_state === "held");

  // Held rows: retried daily within held_retry_days, then left held.
  const s9 = await push(D, { retryHeld: true });
  const rsd = await shareRow(sd);
  check("retryHeld takes the held shares again: the one held off the push list is pushed now, the B2C one held again",
    s9.status === 200 && rsd.push_state === "pushed" && rsd.push_note === null && (await shareRow(sd2)).push_state === "held" &&
      (await shareRow(sd2)).held_at >= (await shareRow(sd2)).held_since, JSON.stringify(s9.body));
  await pool.query(`UPDATE lead_shares SET held_since = now() - interval '8 days' WHERE id = $1`, [sd2]);
  net.plan[B2C2].push(camp(9302, `${D}: Google + Custom`));
  const s10 = await push(D, { retryHeld: true });
  check("a share held longer than held_retry_days is no longer retried, even once a campaign exists", s10.body.note === "nothing to push" &&
    (await shareRow(sd2)).push_state === "held");
  await pool.query(`UPDATE lead_shares SET held_since = now() - interval '2 days' WHERE id = $1`, [sd2]);
  const s11 = await push(D, { retryHeld: true });
  check("... and one inside the window goes once its side has a campaign", s11.body.pushed === 1 && (await shareRow(sd2)).push_state === "pushed");
  const s12 = await push(D);
  check("without retryHeld nothing held is taken", s12.body.note === "nothing to push");

  // The fit gate decides the batch's starting status.
  await client(G, { type: "Cleaning" }).catch(() => {});
  const fg = await one(`SELECT value FROM enrich_settings WHERE key = 'fit_gate'`);
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'fit_gate'`, [
    JSON.stringify({ ...(fg?.value ?? {}), enabled: true, tags: [G], client_types: ["Cleaning"], require_scored: true }),
  ]);
  await share(ctx.jobAB, await lead(biz("g1")), G);
  const s13 = await push(G);
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'fit_gate'`, [JSON.stringify(fg?.value ?? {})]);
  check("a client under the fit gate: its share batch waits in 'scoring', as a push from the route would", s13.status === 200 &&
    (await batchesOf(G))[0]?.status === "scoring", JSON.stringify(s13.body));

  // More than 25,000 rows.
  const t0 = Date.now();
  const { rows: big } = await pool.query(
    `INSERT INTO leads (email, company, city, state, country_code, location_status, email_type, validation_status)
     SELECT 'big-' || g || '-' || $1 || '@big-' || (g % 40) || '.${HOST}', 'Made-up Big Co', 'Phoenix', 'AZ', 'US', 'resolved', 'personal', 'valid'
       FROM generate_series(1, 25001) g RETURNING id`,
    [RUN]
  );
  const jobE = await job(A);
  await pool.query(
    `INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, applied_at, push_state)
     SELECT $1, x, $2, $3, 'shared', now(), 'queued' FROM unnest($4::uuid[]) AS x`,
    [jobE, A, E, big.map((r) => r.id)]
  );
  const s14 = await push(E);
  const eb = await batchesOf(E);
  check("25,001 queued shares make two batches, 25,000 ids and 1", s14.status === 200 && s14.body.pushed === 25001 && eb.length === 2 &&
    same(eb.map((b) => b.selected_ids.length).sort((x, y) => y - x), [25000, 1]) && s14.body.left === 0, JSON.stringify({ ...s14.body, batches: s14.body.batches?.length }));
  const eRows = await one(`SELECT count(*) FILTER (WHERE push_state = 'pushed')::int AS pushed, count(DISTINCT push_batch_id)::int AS batches FROM lead_shares WHERE receiver_tag = $1`, [E]);
  check("... every share marked pushed with one of the two", eRows.pushed === 25001 && eRows.batches === 2);
  const s15 = await push(E);
  check("... and a second call adds nothing", s15.body.note === "nothing to push" && (await batchesOf(E)).length === 2);
  console.log(`        (25,001 shares in ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

// ── P. Push shared ──────────────────────────────────────────────────────────

async function partP(pushRoute, settingsRoute) {
  section("P. Push shared (POST /api/sharing/push)");
  ctx.jobF = await job(A);
  ctx.sf = [await share(ctx.jobF, await lead(biz("f1")), F, { push: null }), await share(ctx.jobF, await lead(biz("f2")), F, { push: null })];
  ctx.sfC = await share(ctx.jobF, await lead(biz("f-c")), C, { push: null });
  as("admin");
  const dry0 = await call(pushRoute.POST, { body: { batchId: ctx.jobF, dryRun: true } });
  check("off the push list, a client's shares are left alone and named in the dry run",
    dry0.status === 200 && same(dry0.body.queue, { [C]: 1 }) && same(dry0.body.notOnPushList, { [F]: 2 }), JSON.stringify(dry0.body));
  // Adding F to the push list through the settings route queues nothing older.
  const st = await call(settingsRoute.GET);
  const { settingsInputOf } = await srcModule("lib/companies/server.ts");
  const input = settingsInputOf(st.body.value);
  input.overlap_sharing.push_tags = [...input.overlap_sharing.push_tags, F];
  const saved = await call(settingsRoute.PUT, { body: { version: st.body.version, ...input } });
  check("adding a client to the push list saves", saved.status === 200 && saved.body.value.overlap_sharing.push_tags.includes(F), JSON.stringify(saved.body).slice(0, 300));
  check("... and queues none of its older shares", (await all(`SELECT push_state FROM lead_shares WHERE id = ANY($1::bigint[])`, [ctx.sf])).every((r) => r.push_state === null));

  as("manager");
  check("managers cannot push (403)", (await call(pushRoute.POST, { body: { batchId: ctx.jobF } })).status === 403);
  as("admin");
  check("a job or a client must be named (400)", (await call(pushRoute.POST, { body: {} })).status === 400);
  check("a bad job id (400)", (await call(pushRoute.POST, { body: { batchId: "nope" } })).status === 400);
  const dry = await call(pushRoute.POST, { body: { batchId: ctx.jobF, dryRun: true } });
  check("on the push list now, the dry run counts its older shares to queue (nothing is written by it)",
    dry.status === 200 && dry.body.queue[F] === 2 && dry.body.queue[C] === 1 && Object.keys(dry.body.notOnPushList).length === 0 && dry.body.enabled === true &&
      (await all(`SELECT push_state FROM lead_shares WHERE id = ANY($1::bigint[])`, [ctx.sf])).every((r) => r.push_state === null), JSON.stringify(dry.body));
  // C is on the push list but cannot receive: it is queued and then held by the push.
  const audits0 = T.audits.length;
  const done = await call(pushRoute.POST, { body: { batchId: ctx.jobF } });
  const fb = await batchesOf(F);
  check("Push shared queues them and pushes at once", done.status === 200 && done.body.queued[F] === 2 && fb.length === 1 &&
    same(sorted(fb[0].selected_ids), sorted((await all(`SELECT lead_id FROM lead_shares WHERE id = ANY($1::bigint[])`, [ctx.sf])).map((r) => r.lead_id))) &&
      (await all(`SELECT push_state FROM lead_shares WHERE id = ANY($1::bigint[])`, [ctx.sf])).every((r) => r.push_state === "pushed"), JSON.stringify(done.body));
  check("... a client that cannot receive gets its shares held, with the reason in its result",
    (await shareRow(ctx.sfC)).push_state === "held" && done.body.results.some((r) => r.receiver === C && r.held === 1));
  check("... and it is audited", T.audits.length === audits0 + 1 && T.audits.at(-1).action === "Shares Queued For Push" && T.audits.at(-1).details.includes(`${F} 2`));
  const again = await call(pushRoute.POST, { body: { batchId: ctx.jobF } });
  check("pressed again, it queues nothing (the held one only with held)", again.status === 200 && Object.keys(again.body.queued).length === 0);
  const withHeld = await call(pushRoute.POST, { body: { receiver: C, held: true, dryRun: true } });
  check("with held, the held shares are counted too", withHeld.body.queue[C] >= 1, JSON.stringify(withHeld.body));
  // Held ones re-queued start their retry window again.
  await pool.query(`UPDATE lead_shares SET held_since = now() - interval '20 days' WHERE id = $1`, [ctx.sfC]);
  await pool.query(`UPDATE client_tags SET status = 'Active' WHERE tag = $1`, [C]);
  net.plan[B2B2].push(camp(9401, `${C}: Google + Custom`));
  const heldPush = await call(pushRoute.POST, { body: { receiver: C, held: true } });
  check("Push shared with held re-queues an old held share and pushes it", heldPush.status === 200 && (await shareRow(ctx.sfC)).push_state === "pushed", JSON.stringify(heldPush.body));
  await pool.query(`UPDATE client_tags SET status = 'Paused' WHERE tag = $1`, [C]);
  await setSharing({ enabled: false });
  const off = await call(pushRoute.POST, { body: { receiver: B } });
  check("with sharing switched off it refuses (409)", off.status === 409);
  await setSharing(SHARING_ON({ push_tags: [B, C, D, E, F, G, H] }));
}

// ── G. The push route ───────────────────────────────────────────────────────

async function partG(batchRoute) {
  section("G. The push route: the 24-hour guard, the stamping, the side split");
  as("manager");
  const ids = [ctx.lb[0], ctx.lc[0]];
  const body = (extra = {}) => ({ campaigns: [{ id: 9101, name: `${B}: Google + Custom`, instance_url: B2B2 }], selectedIds: ids, clientTag: B, ...extra });
  const g1 = await call(batchRoute.POST, { body: body() });
  check("recent share pushes of the client never clash: a popup push goes through", g1.status === 200 && typeof g1.body.batchId === "string", JSON.stringify(g1.body));
  check("... and the answer names them", Array.isArray(g1.body.sharePushes) && g1.body.sharePushes.length === 3 &&
    g1.body.sharePushes.every((s) => ["share", "topup"].includes(s.source) && s.id && s.status === "pending"));
  const stored = await one(`SELECT campaigns, push_options FROM push_batches WHERE id = $1`, [g1.body.batchId]);
  check("... its campaign stamped as before: side from the saved installs, bucket from the name", stored.campaigns[0].side === "b2b" &&
    stored.campaigns[0].bucket === "default" && stored.push_options === null);
  const g2 = await call(batchRoute.POST, { body: body() });
  check("a second popup push still clashes with the first (409), naming it, not a share push",
    g2.status === 409 && g2.body.duplicateOf?.id === g1.body.batchId && Array.isArray(g2.body.sharePushes), JSON.stringify(g2.body).slice(0, 300));
  const g3 = await call(batchRoute.POST, { body: body({ emailSide: "b2c", force: true }) });
  const s3 = await one(`SELECT selected_ids FROM push_batches WHERE id = $1`, [g3.body.batchId]);
  check("the emailSide split through the shared function keeps only that side's leads", g3.status === 200 && same(s3.selected_ids, [ctx.lc[0]]));
  const g4 = await call(batchRoute.POST, { body: { ...body({ emailSide: "b2b", force: true }), selectedIds: [ctx.lc[0]] } });
  check("... and refuses an empty side (400) rather than queue no ids", g4.status === 400 && /No b2b leads/.test(g4.body.error));
  const g5 = await call(batchRoute.POST, { body: { campaigns: [{ id: 9801, name: `${H}: Main`, instance_url: B2B2 }], selectedIds: [ctx.lb[1]], clientTag: H } });
  check("a client with no share push gets the answer as before (no sharePushes key)", g5.status === 200 && !("sharePushes" in g5.body));
}

// ── R. The push worker ──────────────────────────────────────────────────────

async function partR() {
  section("R. The push worker: the stop rule, the cancel, the gather with skipAlreadySent");
  const pw = source("scripts/push-worker.mjs");
  const piece = (name) => {
    const m = new RegExp(`const ${name} =\\s*((?:\`[^\`]*\`\\s*\\+?\\s*)+);`).exec(pw);
    return m ? [...m[1].matchAll(/`([^`]*)`/g)].map((x) => x[1]).join("") : null;
  };
  const ELIGIBLE = piece("ELIGIBLE");
  const NOT_SENT = piece("NOT_SENT_FOR_CLIENT");
  const CANCEL = piece("SHARE_CANCEL_SQL");
  const BLOCK = piece("RECEIVE_BLOCK_SQL");
  const fn = /function shareStopReason\(batch, block\) \{([\s\S]*?)\n\}/.exec(pw)?.[1];
  check("the worker's statements and its stop rule are where this test reads them", Boolean(ELIGIBLE && NOT_SENT && CANCEL && BLOCK && fn));
  const shareStopReason = new Function("batch", "block", fn);
  check("the stop rule: no ids (empty or NULL) cancels, a client that cannot receive cancels, else nothing",
    shareStopReason({ selected_ids: [] }, null) === "Cancelled: a share push with no lead ids" &&
      shareStopReason({ selected_ids: null }, null) === "Cancelled: a share push with no lead ids" &&
      shareStopReason({ selected_ids: ["x"], client_tag: C }, "status Paused") === `Cancelled: ${C} cannot receive (status Paused)` &&
      shareStopReason({ selected_ids: ["x"], client_tag: B }, null) === null);
  const gather = /async function gatherCycle\(\) \{([\s\S]*?)\n\}/.exec(pw)?.[1] ?? "";
  const iShare = gather.indexOf("isSharePush(batch.push_options)");
  const iCancel = gather.indexOf("pool.query(SHARE_CANCEL_SQL, [batch.id, stop])");
  const iGather = gather.indexOf("let rows;");
  check("gatherCycle checks a share or top-up push right after the claim and before any gather, and returns on a cancel",
    iShare > 0 && iCancel > iShare && iGather > iCancel && /if \(stop\) \{[\s\S]*?return true;/.test(gather) &&
      gather.indexOf("set status = 'gathering'") < iShare);
  check("the selected-ids gather adds the not-sent check only for skipAlreadySent with a client, else it is the statement it was",
    gather.includes("const skipSent = batch.push_options?.skipAlreadySent === true && Boolean(batch.client_tag);") &&
      gather.includes("`select l.id, l.email from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE}${skipSent ? ` and ${NOT_SENT_FOR_CLIENT}` : \"\"}`") &&
      gather.includes("skipSent ? [batch.selected_ids, batch.client_tag, batch.id] : [batch.selected_ids]"));
  check("the not-sent check is the filters path's own", /pb\.client_tag = \$2 and pi\.lead_id = l\.id and pi\.status = 'sent' and pi\.batch_id <> \$3/.test(NOT_SENT.replace(/\s+/g, " ")) &&
    /where pb\.client_tag = \$\{tagLit\} and pi\.lead_id = l\.id\s+and pi\.status = 'sent' and pi\.batch_id <> '\$\{batch\.id\}'/.test(gather));

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const blockC = (await c.query(BLOCK, [C])).rows[0].block;
    const blockB = (await c.query(BLOCK, [B])).rows[0].block;
    check("the receive check reads fn_client_receive_block", blockC === "status Paused" && blockB === null, `${blockC} ${blockB}`);
    const mk = async (status, ids, opts) => (await c.query(
      `INSERT INTO push_batches (campaigns, selected_ids, client_tag, push_options, status) VALUES ('[]'::jsonb, $1::uuid[], $2, $3::jsonb, $4) RETURNING id`,
      [ids, B, JSON.stringify(opts), status]
    )).rows[0].id;
    const gath = await mk("gathering", null, { source: "share", skipAlreadySent: true });
    const pend = await mk("pending", null, { source: "share", skipAlreadySent: true });
    const r1 = await c.query(CANCEL, [gath, "Cancelled: a share push with no lead ids"]);
    const r2 = await c.query(CANCEL, [pend, "Cancelled: a share push with no lead ids"]);
    const after = (await c.query(`SELECT id, status, error, completed_at FROM push_batches WHERE id = ANY($1::uuid[])`, [[gath, pend]])).rows;
    const g = after.find((x) => x.id === gath);
    check("the cancel writes status cancelled, the reason and completed_at, fenced on gathering",
      r1.rowCount === 1 && r2.rowCount === 0 && g.status === "cancelled" && g.error === "Cancelled: a share push with no lead ids" && g.completed_at &&
        after.find((x) => x.id === pend).status === "pending");

    // The gather: L1 sent for B before, L2 sent for A only, L3 never sent, L4 pending for B.
    const L = [ctx.lb[0], ctx.lb[1], ctx.lb[2], ctx.lc[0]];
    const old = (await c.query(`INSERT INTO push_batches (campaigns, client_tag, status) VALUES ('[]'::jsonb, $1, 'complete') RETURNING id`, [B])).rows[0].id;
    const oldA = (await c.query(`INSERT INTO push_batches (campaigns, client_tag, status) VALUES ('[]'::jsonb, $1, 'complete') RETURNING id`, [A])).rows[0].id;
    await c.query(`INSERT INTO push_items (batch_id, lead_id, email, status) VALUES ($1, $2, 'x', 'sent'), ($3, $4, 'y', 'sent'), ($1, $5, 'z', 'pending')`,
      [old, L[0], oldA, L[1], L[3]]);
    const now = await mk("gathering", L, { source: "share", skipAlreadySent: true });
    await c.query(`INSERT INTO push_items (batch_id, lead_id, email, status) VALUES ($1, $2, 'w', 'sent')`, [now, L[2]]);
    const skip = (await c.query(`select l.id, l.email from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE} and ${NOT_SENT}`, [L, B, now])).rows.map((r) => r.id);
    const plain = (await c.query(`select l.id, l.email from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE}`, [L])).rows.map((r) => r.id);
    check("with skipAlreadySent the gather leaves out only the lead already sent for the client (its own batch's items aside)",
      same(sorted(skip), sorted([L[1], L[2], L[3]])), JSON.stringify(skip));
    check("... and without it the gather takes them all, as before", same(sorted(plain), sorted(L)));
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

// ── T. The settings route's three keys ──────────────────────────────────────

async function partT(settingsRoute) {
  section("T. The settings route: overlap_sharing, weekly_topup, never_contact_inboxes");
  as("admin");
  // A made-up stand-in filter, loaded (never the real one).
  const pattern = "sptestbox@|sptest-dept|sptestzone\\.test";
  const nc0 = await one(`SELECT value FROM enrich_settings WHERE key = 'never_contact_inboxes'`);
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'never_contact_inboxes'`, [
    JSON.stringify({ ...nc0.value, enabled: false, pattern, sha256: createHash("sha256").update(pattern).digest("hex"), source: "made-up sptest variant", read_at: "2026-11-20T00:00:00.000Z", extra_key: "kept" }),
  ]);
  await setSharing({ ...SHARING_ON(), enabled: false, since: null, made_up_extra: "kept" });
  const st = await call(settingsRoute.GET);
  const v = st.body.value;
  check("GET carries the three keys", st.status === 200 && v.overlap_sharing?.enabled === false && v.weekly_topup?.pull_mode === "off" &&
    v.never_contact_inboxes?.filter?.loaded === true && v.never_contact_inboxes.filter.sha12 === createHash("sha256").update(pattern).digest("hex").slice(0, 12) &&
    v.never_contact_inboxes.filter.source === "made-up sptest variant");
  check("... and never the filter itself", !JSON.stringify(st.body).includes("sptestbox") && !("pattern" in v.never_contact_inboxes));
  const { settingsInputOf } = await srcModule("lib/companies/server.ts");
  const input = settingsInputOf(v);
  const put = (f) => {
    const x = structuredClone(input);
    f?.(x);
    return call(settingsRoute.PUT, { body: { version: st.body.version, ...x } });
  };
  const keys = ["overlap_sharing", "weekly_topup", "never_contact_inboxes"];
  const stamp0 = await all(`SELECT key, updated_at FROM enrich_settings WHERE key = ANY($1::text[]) ORDER BY key`, [keys]);
  const r0 = await put();
  const stamp1 = await all(`SELECT key, updated_at FROM enrich_settings WHERE key = ANY($1::text[]) ORDER BY key`, [keys]);
  check("the sheet's body sent back unchanged saves nothing and writes none of the three rows", r0.status === 200 && r0.body.changes.length === 0 && same(stamp0, stamp1));
  const r1 = await put((x) => {
    x.overlap_sharing.pools = { cleaning: ["Cleaning"], other: ["cleaning "] };
  });
  check("a client type in two pools is refused (400)", r1.status === 400 && /is in both/.test(r1.body.error), r1.body.error);
  const r2 = await put((x) => {
    x.overlap_sharing.push_tags = ["SPTEST_NOT_LISTED"];
  });
  check("a push list client off the sharing list is refused (400)", r2.status === 400 && /must be on the sharing list/.test(r2.body.error));
  const r3 = await put((x) => {
    x.weekly_topup.pull_mode = "always";
  });
  check("a top-up pull mode that is not off, prepare or auto is refused (400)", r3.status === 400 && /off, prepare or auto/.test(r3.body.error));
  const r4 = await put((x) => {
    x.never_contact_inboxes.chunk_rows = 0;
  });
  check("a never-contact step of 0 is refused (400)", r4.status === 400 && /in one step/.test(r4.body.error));
  const before = Date.now();
  const r5 = await put((x) => {
    x.overlap_sharing.enabled = true;
    x.overlap_sharing.since = null;
  });
  const os = (await one(`SELECT value FROM enrich_settings WHERE key = 'overlap_sharing'`)).value;
  check("switching sharing on with no go-live time sets it to now", r5.status === 200 && os.enabled === true && Date.parse(os.since) >= before - 1000 &&
    Date.parse(os.since) <= Date.now() + 1000 && r5.body.changes.some((c) => c.startsWith("overlap sharing off to on")) &&
    r5.body.changes.some((c) => c.startsWith("sharing's go-live time none to")), JSON.stringify(r5.body.changes));
  check("... merged over the stored row (a key the sheet does not edit is kept), audited", os.made_up_extra === "kept" &&
    T.audits.at(-1)?.action === "enrich_settings" && T.audits.at(-1).details.includes("overlap sharing off to on"));
  const st2 = await call(settingsRoute.GET);
  const input2 = settingsInputOf(st2.body.value);
  input2.never_contact_inboxes.enabled = true;
  input2.never_contact_inboxes.rows_per_day = 1234;
  input2.weekly_topup.client_types = ["Cleaning"];
  const r6 = await call(settingsRoute.PUT, { body: { version: st2.body.version, ...input2 } });
  const nc = (await one(`SELECT value FROM enrich_settings WHERE key = 'never_contact_inboxes'`)).value;
  const wt = (await one(`SELECT value FROM enrich_settings WHERE key = 'weekly_topup'`)).value;
  check("never-contact inboxes: the switch and the pace saved, the filter keys kept as the seed wrote them",
    r6.status === 200 && nc.enabled === true && nc.rows_per_day === 1234 && nc.pattern === pattern && nc.source === "made-up sptest variant" &&
      nc.extra_key === "kept" && wt.client_types.length === 1, JSON.stringify(r6.body.errors ?? r6.body.changes));
  check("... and the switch reads on only with the filter loaded", settingsFrom([{ key: "never_contact_inboxes", value: nc }]).flagOn("never_contact_inboxes", "") === true);
  // Not loaded: switching on is refused.
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'never_contact_inboxes'`, [JSON.stringify({ ...nc0.value, enabled: false })]);
  const st3 = await call(settingsRoute.GET);
  const input3 = settingsInputOf(st3.body.value);
  input3.never_contact_inboxes.enabled = true;
  const r7 = await call(settingsRoute.PUT, { body: { version: st3.body.version, ...input3 } });
  check("with the filter not loaded, switching never-contact inboxes on is refused (400)", st3.body.value.never_contact_inboxes.filter.loaded === false &&
    r7.status === 400 && /not loaded/.test(r7.body.error));
  as("manager");
  check("managers cannot read or save the settings (403)", (await call(settingsRoute.GET)).status === 403);
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'never_contact_inboxes'`, [JSON.stringify(nc0.value)]);
}

// ── V. The Sharing page's routes ────────────────────────────────────────────

async function partV() {
  section("V. The Sharing page's routes and the share step's actions");
  const jobs = await route("sharing/jobs");
  const jobR = await route("sharing/job");
  const csv = await route("sharing/csv");
  const clients = await route("sharing/clients");
  const held = await route("sharing/held");
  const badges = await route("sharing/batches");
  const leadR = await route("sharing/lead");
  const apply = await route("sharing/apply");
  const undo = await route("sharing/undo");
  const retry = await route("sharing/retry");
  as("viewer");
  check("viewers see none of it (403)", (await Promise.all([call(jobs.GET), call(clients.GET), call(held.GET), call(jobR.GET, { query: { id: ctx.jobAB } })])).every((r) => r.status === 403));
  as("manager");
  T.worker = heartbeat(["company_runs"]);
  const j = await call(jobs.GET, { query: { origin: A, limit: "200" } });
  check("the jobs list: the test's jobs, newest first, the switch, and the worker lacking the share step",
    j.status === 200 && j.body.ready === true && j.body.jobs.some((x) => x.batch_id === ctx.jobAB) && j.body.switch.enabled === true &&
      j.body.worker?.sharing === false && j.body.jobs.every((x, i, a) => i === 0 || a[i - 1].created_at >= x.created_at), JSON.stringify(j.body).slice(0, 300));
  T.worker = heartbeat(["company_runs", "sharing"]);
  check("... and with it", (await call(jobs.GET, { query: { origin: A } })).body.worker?.sharing === true);
  check("a bad state filter is refused (400)", (await call(jobs.GET, { query: { state: "nope" } })).status === 400);
  // The share step may make many jobs in one statement, all with one created_at: pages must still list each once.
  await pool.query(`UPDATE share_jobs SET created_at = (SELECT max(created_at) FROM share_jobs WHERE origin_tag = $1) WHERE origin_tag = $1`, [A]);
  const seen = [];
  let before = null;
  for (let i = 0; i < 10; i++) {
    const page = await call(jobs.GET, { query: { origin: A, limit: "1", ...(before ? { before } : {}) } });
    seen.push(...page.body.jobs.map((x) => x.batch_id));
    before = page.body.next;
    if (!before) break;
  }
  const mine = (await all(`SELECT batch_id FROM share_jobs WHERE origin_tag = $1`, [A])).map((r) => r.batch_id);
  check("pages of one job each list every job once, when they share one created_at", mine.length >= 3 && same(sorted(seen), sorted(mine)), JSON.stringify({ seen, mine }));
  check("... and a made-up page start is refused (400)", (await call(jobs.GET, { query: { before: "2026-11-20" } })).status === 400);
  const d = await call(jobR.GET, { query: { id: ctx.jobAB } });
  const rb = d.body.receivers?.find((r) => r.tag === B);
  check("a job: per receiver its outcomes, push states, receive check and samples, and the push batches",
    d.status === 200 && rb && rb.outcomes.shared >= 7 && rb.push.pushed >= 5 && rb.push.dropped === 2 && rb.receiveBlock === null && rb.onPushList === true &&
      rb.sample.length >= 7 && d.body.receivers.find((r) => r.tag === C)?.receiveBlock === "status Paused" && d.body.pushBatches.some((b) => b.receiver === B),
    JSON.stringify(rb).slice(0, 400));
  check("an unknown job is 404", (await call(jobR.GET, { query: { id: randomUUID() } })).status === 404);
  const file = await call(csv.GET, { query: { id: ctx.jobAB, receiver: B } });
  const lines = file.text.trim().split("\n");
  check("the CSV: receiver, email, company, city, state, matched place, outcome, push state, note, applied, undone",
    file.status === 200 && lines[0] === "receiver,email,company,city,state,matched place,outcome,push state,note,applied,undone" &&
      lines.length === 1 + 8 && lines.some((l) => l.includes(biz("b1")) && l.includes(",AZ,shared,pushed,")), lines.slice(0, 3).join(" | "));
  const cl = await call(clients.GET);
  const cOf = (t) => cl.body.clients?.find((x) => x.tag === t);
  check("the clients: pool or isolated, why one cannot receive, the two lists",
    cl.status === 200 && cOf(B)?.pool === "cleaning" && cOf(B).receiveBlock === null && cOf(B).onList && cOf(B).onPushList &&
      cOf(C)?.receiveBlock === "status Paused" && cOf(A)?.pool === "cleaning");
  const h = await call(held.GET);
  check("held: by client and reason with its age, and the mirror's installs",
    h.status === 200 && h.body.held.some((x) => x.receiver === H && x.note === `no campaign is named "${H}: …"` && x.rows === 1) &&
      h.body.mirror.length === 4 && h.body.mirror.find((m) => m.install === B2B2)?.covered === true, JSON.stringify(h.body.held));
  const bg = await call(badges.GET, { query: { ids: `${ctx.jobAB},${ctx.jobF},${randomUUID()}` } });
  check("the Uploads badge: shared to N clients per batch with a job, nothing for others",
    bg.status === 200 && bg.body.batches[ctx.jobAB]?.sharedTo >= 4 && bg.body.batches[ctx.jobF]?.sharedTo === 2 && Object.keys(bg.body.batches).length === 2,
    JSON.stringify(bg.body));
  check("... and too many or bad ids are refused (400)", (await call(badges.GET, { query: { ids: "x" } })).status === 400);
  const ls = await call(leadR.GET, { query: { id: ctx.lb[0] } });
  check("a lead's shares", ls.status === 200 && ls.body.shares.length === 1 && ls.body.shares[0].receiver_tag === B && ls.body.shares[0].push_state === "pushed");

  // Apply, undo and retry: admin only, the share step's own actions, audited, its refusals passed on.
  check("managers cannot apply, undo or retry (403)",
    (await Promise.all([call(apply.POST, { body: { batchId: ctx.jobAB } }), call(undo.POST, { body: { batchId: ctx.jobAB } }), call(retry.POST, { body: { batchId: ctx.jobAB } })]))
      .every((r) => r.status === 403));
  as("admin");
  T.actions.answer = {
    preview: { body: { batchId: ctx.jobAB, receivers: [{ tag: B, before: { shared: 7 }, now: { shared: 8 }, overCap: false }] } },
    apply: { body: { batchId: ctx.jobAB, applied: { [B]: 8 }, queued: { [B]: 8 }, skipped: {} } },
    undo: { body: { batchId: ctx.jobAB, undone: 8, tagsToRemove: 0, cancelledPushes: [], pushedLeads: 5 } },
    retry: { refuse: [409, "This job is not in error."] },
  };
  T.actions.calls = [];
  const a0 = T.audits.length;
  const pv = await call(apply.POST, { body: { batchId: ctx.jobAB, receiver: "sptest_b", preview: true } });
  const ap = await call(apply.POST, { body: { batchId: ctx.jobAB } });
  const un = await call(undo.POST, { body: { batchId: ctx.jobAB, receiver: B } });
  const rt = await call(retry.POST, { body: { batchId: ctx.jobAB } });
  check("apply with preview asks the share step's preview and writes no audit", pv.status === 200 && pv.body.receivers[0].now.shared === 8 &&
    same(T.actions.calls[0], { name: "preview", opts: { batchId: ctx.jobAB, receiver: B }, pool: true }));
  check("apply, undo: the share step's actions with the job, the receiver and the admin, each audited",
    ap.status === 200 && un.status === 200 && same(T.actions.calls[1].opts, { batchId: ctx.jobAB, receiver: null, userId: T.userId }) &&
      same(T.actions.calls[2].opts, { batchId: ctx.jobAB, receiver: B, userId: T.userId }) &&
      same(T.audits.slice(a0).map((x) => x.action), ["Share Job Applied", "Share Job Undone"]) && T.audits.at(-1).details.includes("5 lead(s) already pushed"));
  check("a refusal of the share step is passed on with its status", rt.status === 409 && rt.body.error === "This job is not in error.");
  T.actions.answer.apply = { crash: "made-up crash" };
  const logged = [];
  const consoleError = console.error;
  console.error = (...a) => logged.push(a.map(String).join(" ")); // the route logs it; keep this run's output readable
  const crash = await call(apply.POST, { body: { batchId: ctx.jobAB } }).finally(() => {
    console.error = consoleError;
  });
  check("any other error is a 500 that does not leak it, and is logged", crash.status === 500 && !JSON.stringify(crash.body).includes("made-up crash") &&
    logged.some((l) => l.startsWith("sharing/apply:") && l.includes("made-up crash")));
  check("a bad job id or receiver is refused (400)", (await call(apply.POST, { body: { batchId: "x" } })).status === 400 &&
    (await call(undo.POST, { body: { batchId: ctx.jobAB, receiver: "a b" } })).status === 400);
}

// ── Run ─────────────────────────────────────────────────────────────────────

const t0 = Date.now();
try {
  await cleanup();
  settingsBefore = await all(`SELECT key, value FROM enrich_settings ORDER BY key`);
  const sharingShipped = settingsFrom(settingsBefore.filter((r) => r.key === "overlap_sharing"));
  check("sharing is off as found (it ships off)", sharingShipped.overlap_sharing.enabled === false);
  await setSharing({ enabled: false });
  await client(A, { group: 1, b2b: B2B1, b2c: B2C1 });
  await client(B);
  await client(C, { status: "Paused" });
  await client(D);
  await client(E);
  await client(F);
  await client(H);
  const auto = await route("sharing/push/auto");
  const pushRoute = await route("sharing/push");
  const settingsRoute = await route("companies/settings");
  const batchRoute = await route("bison/push-batch");
  await partW();
  await partK(auto);
  process.env.SHARE_PUSH_KEY = PUSH_KEY;
  await partS(auto);
  await partP(pushRoute, settingsRoute);
  await partG(batchRoute);
  await partR();
  await partT(settingsRoute);
  await partV();
} catch (e) {
  failed++;
  console.error("  FAIL the run stopped:", e);
} finally {
  section("N. Nothing reached the network, everything removed");
  check("no request left this machine (only the made-up Bison plan answered)", net.refused === 0, `${net.refused} refused`);
  await cleanup().catch((e) => console.error("cleanup:", e.message));
  const left = await one(
    `SELECT (SELECT count(*) FROM client_tags WHERE tag LIKE 'SPTEST\\_%')::int AS tags,
            (SELECT count(*) FROM leads WHERE email LIKE '%.${HOST}' OR email LIKE 'sptest-%@gmail.com')::int AS leads,
            (SELECT count(*) FROM push_batches WHERE client_tag LIKE 'SPTEST\\_%')::int AS batches,
            (SELECT count(*) FROM lead_shares WHERE receiver_tag LIKE 'SPTEST\\_%')::int AS shares,
            (SELECT count(*) FROM upload_batches WHERE filename LIKE 'sptest-%')::int AS uploads`
  );
  check("every made-up row is gone", left && Object.values(left).every((n) => n === 0), JSON.stringify(left));
  const back = await all(`SELECT key, value FROM enrich_settings ORDER BY key`);
  check("the settings are back as they were", settingsBefore && same(
    Object.fromEntries(back.map((r) => [r.key, r.value])),
    Object.fromEntries(settingsBefore.map((r) => [r.key, r.value]))
  ));
  for (const p of T.pools) await p.end().catch(() => {});
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(failed ? 1 : 0);
}
