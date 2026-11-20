#!/usr/bin/env node
// Overlap sharing's push gaps (the gaps contract, items 1 and 2): share rows
// left "pushed" behind a push that ended without sending them
// (scripts/lib/share/settle.mjs, run by the share step each round), the
// Exports page's Retry leaving share pushes out, the job detail's push line
// and the Held tab's groups that say how a push ended, and the push timer's
// refused asks, kept per client in the worker's memory and shown on the Held
// tab.
//
// LOCAL DATABASE ONLY: made-up clients GSTEST_A to GSTEST_F, made-up imports,
// share jobs, shares and pushes, made-up people at .gstest.example, all
// removed at the end (and any left by a run that was cut off). It switches
// overlap_sharing on for its clients and puts every settings row back as it
// was. The settle, the share round and the Exports page's "retry all" read
// the whole database, so it refuses to run while the database holds share
// jobs, shares or lead lists that are not its own, an ended share push not
// settled, a failed push item, or a cancelled push with items still pending.
//
//   node --env-file=.env.local scripts/test-share-gaps.mjs
//
// Run it under the shared local-database lock when other suites share the
// database. Migrations 131 to 136 must be in the local database. It starts no
// worker: the push worker's statements, texts and stop rule are read from
// scripts/push-worker.mjs and run here as written.
//
// Nothing here reaches a network: fetch answers the Bison campaign search
// from a made-up plan for the four install domains (with made-up keys) and
// refuses everything else, and the push timer is handed a stand-in. No paid
// key is read. The routes run for real through a small loader that compiles
// their TypeScript, with stand-ins only for the session (a made-up user with a
// role), the audit log, the worker's heartbeat, the shared pg pool (local, no
// TLS) and the Supabase clients; the Bearer key check is the real
// intakeKeyStatus() and the share step's actions are the real ones.
//
//   U. settleOutcome, pure: every rule, skipNote and batchErrorNote
//   W. the push worker's and the undo's own texts, fed to the settle
//   S. settleEndedPushes on the database
//   J. the job route: how each push ended, settled or not
//   R. the retry window after settling
//   N. never twice
//   X. the Exports page's Retry
//   F. the push timer's refusals
//   H. the held route
//   O. whole rounds
//   Z. nothing reached the network, everything removed

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { checker, dropPaidKeys, localDatabaseUrl } from "./fixtures/test-support.mjs";
import { FIT_SKIP } from "./lib/enrich/fit-push.mjs";
import { settingsFrom } from "./lib/enrich/settings.mjs";
import { undoShareJob } from "./lib/share/actions.mjs";
import {
  batchErrorNote, ITEM_FAILED_NOTE, OPERATOR_CANCEL_NOTE, SETTLE_BATCHES_PER_ROUND, SETTLE_CANDIDATES_SQL, SETTLE_MS, SETTLE_ROWS_SQL,
  SETTLED_KEY, settleEndedPushes, settleOutcome, skipNote,
} from "./lib/share/settle.mjs";
import { newShareMemory, shareRefusals, shareRound } from "./lib/share/step.mjs";
import { newUpkeepMemory, pushRefusals, pushTimer } from "./lib/share/upkeep.mjs";

const url = localDatabaseUrl();
// No paid key reaches anything here, whatever the shell holds.
dropPaidKeys();
for (const k of ["EMAILBISON_API_KEY", "EMAILBISON_BASE_URL", "EMAILBISON_KEYS"]) delete process.env[k];

// The four installs (scripts/lib/bison-groups.mjs), with made-up keys: only the stand-in fetch below ever sees them.
const B2B1 = "app.outboundhero.co";
const B2C1 = "personal.cleaningoutbound.com";
const B2B2 = "app.facilityreach.com";
const B2C2 = "personal.outboundclean.com";
const INSTALLS = [B2B1, B2C1, B2B2, B2C2];
process.env.EMAILBISON_KEYS = JSON.stringify(Object.fromEntries(INSTALLS.map((d, i) => [d, `gstest-made-up-key-${i}`])));

const A = "GSTEST_A"; // the origin of the imports
const B = "GSTEST_B"; // the main receiver: every way a push can end
const C = "GSTEST_C"; // paused; only pushes the worker cancelled ("cannot receive"), held and retried daily
const D = "GSTEST_D"; // a push cancelled on the Exports page while processing, sent again with Push shared
const E = "GSTEST_E"; // the whole round
const F = "GSTEST_F"; // routine pushes for the Exports page's Retry, and the refused asks
const TAGS = [A, B, C, D, E, F];
const RUN = randomUUID().slice(0, 6);
const HOST = "gstest.example";
const FILE = `gstest-${RUN}`;
const biz = (who) => `${who}-${RUN}@${who}-co.${HOST}`;
const PUSH_ENV = { SHARE_PUSH_KEY: "gstest-made-up-share-push-key-0123456789", SHARE_PUSH_URL: `https://web.${HOST}` };
const PUSH_URL = `https://web.${HOST}/api/sharing/push/auto`;

const out = checker();
const check = out.check;
const section = out.section;
const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (xs) => [...xs].sort();

// ── No network: a made-up Bison campaign search ──────────────────────────────

const net = { refused: 0, hosts: new Set(), bison: 0, plan: {} };
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  net.hosts.add(u.hostname);
  if (INSTALLS.includes(u.hostname) && u.pathname === "/api/campaigns") {
    net.bison++;
    const term = (u.searchParams.get("search") ?? "").toLowerCase();
    const rows = (net.plan[u.hostname] ?? []).filter((c) => String(c.name).toLowerCase().includes(term));
    return new Response(JSON.stringify({ data: rows, links: { next: null } }), { status: 200 });
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
  const t = globalThis.__gsTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__gsTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__gsTest.worker; }`,
  "@/lib/db/pool": `import pg from "${pgUrl}";
let p = null;
export function getPool() {
  if (!p) { p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 6 }); globalThis.__gsTest.pools.push(p); }
  return p;
}`,
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => {
    const t = globalThis.__gsTest;
    return { data: { user: t.role ? { id: t.userId, email: "gstest-user@${HOST}" } : null } };
  } } };
}`,
  // No route here reads the admin client: any use is refused, so nothing can reach Supabase.
  "@/lib/supabase/admin": `export function createAdminClient() { throw new Error("the share gaps suite's routes use no Supabase admin client"); }`,
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

const T = (globalThis.__gsTest = { role: null, userId: randomUUID(), audits: [], worker: null, pools: [] });
const srcModule = (p) => import(new URL(p, SRC).href);
const route = (p) => srcModule(`app/api/${p}/route.ts`);
const as = (role) => {
  T.role = role;
};
async function call(handler, { body, query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const req = { json: async () => body, nextUrl: new URL(`http://share-gaps.test/api${qs}`), headers: new Headers({}) };
  const res = await handler(req);
  return { status: res.status, body: res.body };
}
/** A worker heartbeat as workerState() gives it. */
const heartbeat = ({ online = true, refusals = [] } = {}) => ({
  id: "share-gaps-test", last_seen: new Date().toISOString(), started_at: new Date().toISOString(), seconds_ago: online ? 2 : 600, online,
  info: { capabilities: ["company_runs", "sharing"], keys: {}, sharing: { push_auto: true, refusals } },
});
/** The push route as the push timer reaches it: a stand-in that records each ask and answers by plan (200 by default). */
function pushStub(plan = {}) {
  const asked = [];
  const fetchImpl = async (u, init) => {
    const body = JSON.parse(init.body);
    asked.push({ url: String(u), ...body });
    const a = plan[body.receiver]?.(body) ?? {
      status: 200, body: { receiver: body.receiver, pushed: 0, batches: [], held: 0, dropped: 0, left: 0, note: "nothing to push" },
    };
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  };
  return { asked, fetchImpl, plan };
}

// ── The database ────────────────────────────────────────────────────────────

let settingsBefore = null;
let baseline = null;

async function setSharing(v) {
  const base = settingsBefore.find((r) => r.key === "overlap_sharing")?.value ?? {};
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'overlap_sharing'`, [JSON.stringify({ ...base, ...v })]);
}
const SHARING_ON = (extra = {}) => ({
  enabled: true, mode: "preview", tags: TAGS, push_tags: [B, C, D, E, F], since: new Date(Date.now() - 3600_000).toISOString(),
  held_retry_days: 7, push_every_minutes: 15, write_tags: false, ...extra,
});
const settingsNow = async () => settingsFrom(await all(`SELECT key, value FROM enrich_settings`));

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

async function lead(email, { bounced = false } = {}) {
  const r = await one(
    `INSERT INTO leads (email, company, city, state, country_code, location_status, email_type, validation_status, is_bounced)
     VALUES ($1, 'Made-up Cleaning Co', 'Phoenix', 'AZ', 'US', 'resolved', 'personal', 'valid', $2) RETURNING id`,
    [email, bounced]
  );
  return r.id;
}

/** A finished import of the origin and its share job (applied), as the share step leaves them. */
async function job(origin = A) {
  const b = await one(
    `INSERT INTO upload_batches (filename, total_rows, inserted_rows, status, batch_type, field_mapping, add_tags, completed_at)
     VALUES ($1, 1, 1, 'complete', 'leads', '{}'::jsonb, ARRAY[$2], now()) RETURNING id`,
    [`${FILE}-${randomUUID().slice(0, 4)}.csv`, origin]
  );
  await pool.query(
    `INSERT INTO share_jobs (batch_id, origin_tag, origin_pool, state, mode, batch_done_at, decided_at, applied_at, new_leads)
     VALUES ($1, $2, 'cleaning', 'applied', 'preview', now(), now(), now(), 1)`,
    [b.id, origin]
  );
  return b.id;
}

/** One share row, applied and queued. */
async function share(batch, leadId, receiver) {
  const r = await one(
    `INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, applied_at, push_state, matched_place)
     VALUES ($1, $2, $3, $4, 'shared', now(), 'queued', '{"country": "US", "state": "AZ", "city": null, "label": "AZ"}'::jsonb)
     RETURNING id::text AS id`,
    [batch, leadId, A, receiver]
  );
  return r.id;
}

/** A share push as src/lib/sharing/push.ts inserts it, its rows marked pushed with it the way push.ts marks them. */
async function sharePush(receiver, shareIds, leadIds, { status = "pending", error = null, total = null, completed = false } = {}) {
  const b = await one(
    `INSERT INTO push_batches (created_by, campaigns, filters, selected_ids, client_tag, email_side, push_options, status, error, total, completed_at)
     VALUES (NULL, '[]'::jsonb, NULL, $1::uuid[], $2, 'b2b', $3::jsonb, $4, $5, $6, CASE WHEN $7::boolean THEN now() END) RETURNING id`,
    [leadIds, receiver, JSON.stringify({ source: "share", skipAlreadySent: true }), status, error, total, completed]
  );
  if (shareIds.length) {
    await pool.query(`UPDATE lead_shares SET push_state = 'pushed', push_batch_id = $2, pushed_at = now(), push_note = NULL WHERE id = ANY($1::bigint[])`, [
      shareIds, b.id,
    ]);
  }
  return b.id;
}

/** A routine export push (no push_options), with its counters. */
async function routinePush(tag, { status = "complete", list = [], counters = {} } = {}) {
  const b = await one(
    `INSERT INTO push_batches (campaigns, client_tag, status, total, processed, sent, failed, completed_at)
     VALUES ('[]'::jsonb, $1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [tag, status, counters.total ?? list.length, counters.processed ?? 0, counters.sent ?? 0, counters.failed ?? 0]
  );
  await items(b.id, list);
  return b.id;
}

async function items(batchId, list) {
  for (const [leadId, status, error = null] of list) {
    await pool.query(`INSERT INTO push_items (batch_id, lead_id, email, status, error) VALUES ($1, $2, 'gstest-item', $3, $4)`, [batchId, leadId, status, error]);
  }
}

const rowsOf = async (ids) =>
  Object.fromEntries(
    (await all(
      `SELECT id::text AS id, push_state, push_note, held_since, held_at, push_batch_id, pushed_at, undone_at FROM lead_shares WHERE id = ANY($1::bigint[])`,
      [ids]
    )).map((r) => [r.id, r])
  );
const batchRow = (id) => one(`SELECT id, status, error, total, processed, sent, failed, completed_at, push_options FROM push_batches WHERE id = $1`, [id]);
async function stamped(id) {
  const o = (await batchRow(id))?.push_options;
  return Boolean(o && typeof o[SETTLED_KEY] === "string" && Number.isFinite(Date.parse(o[SETTLED_KEY])) && o.source === "share" && o.skipAlreadySent === true);
}
const itemOf = async (batchId, leadId) => one(`SELECT status, error, attempts FROM push_items WHERE batch_id = $1 AND lead_id = $2`, [batchId, leadId]);
const snapshot = () =>
  all(`SELECT id::text AS id, push_state, push_note, held_since, held_at, push_batch_id FROM lead_shares WHERE starts_with(receiver_tag, 'GSTEST_') ORDER BY id`);
const stamps = () =>
  all(`SELECT id, push_options->>'${SETTLED_KEY}' AS at FROM push_batches WHERE starts_with(coalesce(client_tag, ''), 'GSTEST_') ORDER BY id`);

async function counts() {
  return one(`SELECT (SELECT count(*) FROM leads WHERE email NOT LIKE $1)::int AS leads,
                     (SELECT count(*) FROM push_batches WHERE NOT starts_with(coalesce(client_tag, ''), 'GSTEST_'))::int AS pushes,
                     (SELECT count(*) FROM push_items WHERE batch_id NOT IN (SELECT id FROM push_batches WHERE starts_with(coalesce(client_tag, ''), 'GSTEST_')))::int AS items,
                     (SELECT count(*) FROM client_tags WHERE NOT starts_with(tag, 'GSTEST_'))::int AS clients,
                     (SELECT count(*) FROM share_jobs)::int AS jobs, (SELECT count(*) FROM lead_shares)::int AS shares`, [`%.${HOST}`]);
}

async function cleanup() {
  await pool.query(`DELETE FROM push_items WHERE batch_id IN (SELECT id FROM push_batches WHERE starts_with(coalesce(client_tag, ''), 'GSTEST_'))`);
  await pool.query(`DELETE FROM push_batches WHERE starts_with(coalesce(client_tag, ''), 'GSTEST_')`);
  await pool.query(`DELETE FROM upload_batches WHERE filename LIKE 'gstest-%'`); // share_jobs and lead_shares go with them
  await pool.query(`DELETE FROM lead_shares WHERE starts_with(receiver_tag, 'GSTEST_') OR starts_with(origin_tag, 'GSTEST_')`);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, 'GSTEST_')`);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, 'GSTEST_')`);
  if (settingsBefore) {
    for (const r of settingsBefore) await pool.query(`UPDATE enrich_settings SET value = $2::jsonb WHERE key = $1`, [r.key, JSON.stringify(r.value)]);
    await pool.query(`DELETE FROM enrich_settings WHERE NOT (key = ANY($1::text[]))`, [settingsBefore.map((r) => r.key)]);
  }
}

/** The push worker's statements, as test-share-push.mjs reads them. */
function piece(pw, name) {
  const m = new RegExp(`const ${name} =\\s*((?:\`[^\`]*\`\\s*\\+?\\s*)+);`).exec(pw);
  return m ? [...m[1].matchAll(/`([^`]*)`/g)].map((x) => x[1]).join("") : null;
}

function planNodes(plan) {
  const outNodes = [];
  const walk = (n) => {
    if (!n) return;
    outNodes.push(n);
    for (const k of n.Plans ?? []) walk(k);
  };
  walk(plan[0].Plan);
  return outNodes;
}

/** A statement's plan with the planner's small-table shortcuts off (as scripts/test-sharing.mjs does): the local tables are tiny. */
async function explain(sql, params) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    for (const k of ["enable_seqscan", "enable_bitmapscan", "enable_hashjoin", "enable_mergejoin"]) await c.query(`SET LOCAL ${k} = off`);
    const { rows: [r] } = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return planNodes(r["QUERY PLAN"]);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

const ctx = {};

// ── U. settleOutcome ────────────────────────────────────────────────────────

function partU() {
  section("U. settleOutcome, pure: every rule, skipNote and batchErrorNote");
  const bt = (status, error = null, gathered = true) => ({ status, error, gathered });
  const it = (status, error = null) => ({ status, error });
  const rw = (o = {}) => ({ undone: false, leadGone: false, sentElsewhere: false, ...o });
  const keep = { keep: true };
  const held = (note, retry = true) => ({ state: "held", note, retry });
  const dropped = (note) => ({ state: "dropped", note });
  const is = (o, want) => same(o, want);
  const ended = [bt("complete"), bt("cancelled"), bt("cancelled", `Cancelled: ${C} cannot receive (status Paused)`, false), bt("error", "gather failed: x", false)];

  check("1. an item sent stays pushed, whatever the push's end, undone or not",
    ended.every((b) => is(settleOutcome(b, it("sent"), rw()), keep) && is(settleOutcome(b, it("sent"), rw({ undone: true })), keep)));
  check("2. an undone share whose lead was not sent: dropped, undone",
    is(settleOutcome(bt("complete"), it("failed", "x"), rw({ undone: true })), dropped("undone")) &&
      is(settleOutcome(bt("cancelled", null, false), null, rw({ undone: true })), dropped("undone")) &&
      is(settleOutcome(bt("complete"), null, rw({ undone: true, leadGone: true })), dropped("undone")));
  check("3. no item in a gathered push (the gather left it out): no_lead, else already_sent, else not_eligible",
    is(settleOutcome(bt("complete"), null, rw({ leadGone: true, sentElsewhere: true })), dropped("no_lead")) &&
      is(settleOutcome(bt("complete"), null, rw({ sentElsewhere: true })), dropped("already_sent")) &&
      is(settleOutcome(bt("complete"), null, rw()), dropped("not_eligible")) &&
      is(settleOutcome(bt("cancelled"), null, rw()), dropped("not_eligible")) &&
      is(settleOutcome(bt("error", "x"), null, rw({ sentElsewhere: true })), dropped("already_sent")));
  check("4. skipped as ineligible at push time: dropped, not_eligible, also in a cancelled push",
    is(settleOutcome(bt("complete"), it("skipped", "ineligible per client targeting at push time"), rw()), dropped("not_eligible")) &&
      is(settleOutcome(bt("cancelled"), it("skipped", "ineligible per client targeting at push time"), rw()), dropped("not_eligible")));
  check("5. Bison refused all its campaigns: dropped, bison_refused",
    is(settleOutcome(bt("complete"), it("skipped", "Bison refused all target campaigns: lead is in another sequence, previously bounced, or unsubscribed on that instance"), rw()),
      dropped("bison_refused")));
  check("6a. cancelled by the worker's receive check: held with its reason, retried (a reason with brackets kept whole)",
    is(settleOutcome(bt("cancelled", `Cancelled: ${C} cannot receive (status Paused)`, false), null, rw()), held("cannot receive: status Paused")) &&
      is(settleOutcome(bt("cancelled", `Cancelled: ${C} cannot receive (churn date 2026-12-01 (in 11 days))`, false), null, rw()),
        held("cannot receive: churn date 2026-12-01 (in 11 days)")));
  check("6b. cancelled for no ids, or by an undo: held, \"push cancelled: <why>\", retried",
    is(settleOutcome(bt("cancelled", "Cancelled: a share push with no lead ids", false), null, rw()), held("push cancelled: a share push with no lead ids")) &&
      is(settleOutcome(bt("cancelled", "Cancelled: shares in it were undone on the Sharing page", false), null, rw()),
        held("push cancelled: shares in it were undone on the Sharing page")));
  check("6c. cancelled on the Exports page (no error, or an older one kept from before a reopen): held, never retried by itself",
    [null, "", "gather failed: made-up", `Bison POST https://${B2B2}/api/leads -> 401: Unauthorized`].every((e) =>
      is(settleOutcome(bt("cancelled", e, false), null, rw()), held(OPERATOR_CANCEL_NOTE, false))));
  check("... a lead that failed in a push cancelled on the Exports page gets the cancel's note, not a retry",
    is(settleOutcome(bt("cancelled"), it("failed", "x"), rw()), held(OPERATOR_CANCEL_NOTE, false)) &&
      is(settleOutcome(bt("cancelled"), it("skipped", "batch cancelled"), rw()), held(OPERATOR_CANCEL_NOTE, false)));
  check("7. its own item failed: held, \"push failed for this lead\", retried (before the push's own error)",
    is(settleOutcome(bt("complete"), it("failed", "x"), rw()), held(ITEM_FAILED_NOTE)) &&
      is(settleOutcome(bt("error", "gather failed: x"), it("failed", "x"), rw()), held(ITEM_FAILED_NOTE)));
  check("8. any other skip: held with skipNote, retried; \"batch cancelled\" in a push no longer cancelled (reopened): its push was cancelled",
    is(settleOutcome(bt("complete"), it("skipped", FIT_SKIP.unscored), rw()), held("not sent: company not scored yet (fit gate)")) &&
      is(settleOutcome(bt("complete"), it("skipped", "batch cancelled"), rw()), held("not sent: its push was cancelled")) &&
      is(settleOutcome(bt("error", "x"), it("skipped", "refusing to push: x"), rw()), held("not sent: the client's B2B and B2C installs are not set")));
  check("9. a push in error: a lead still pending, or never gathered, held with the push's note, retried",
    is(settleOutcome(bt("error", `Bison POST https://${B2B2}/api/campaigns/1/leads/attach-leads -> 403: Forbidden`), it("pending"), rw()),
      held("push failed: Bison refused the key")) &&
      is(settleOutcome(bt("error", "gather failed: x", false), null, rw()), held("push failed: the gather failed")));
  check("10. anything else (never reached for a push the settle takes): left pushed",
    is(settleOutcome(bt("complete"), it("pending"), rw()), keep) && is(settleOutcome(bt("complete", null, false), null, rw()), keep) &&
      is(settleOutcome(bt("error", "x"), it("pushing"), rw()), keep));

  const skips = [
    [FIT_SKIP.unscored, "not sent: company not scored yet (fit gate)"],
    [FIT_SKIP.nokey, "not sent: no company key to score (fit gate)"],
    ["refusing to push: no saved installs. Set b2b_instance/b2c_instance for this client tag, or re-queue from the wizard.",
      "not sent: the client's B2B and B2C installs are not set"],
    ["no B2C campaign on this batch (email: personal, esp: Google)", "not sent: no campaign for its side or mail provider"],
    ['no campaign for the "outlook" bucket (email: personal, esp: Microsoft)', "not sent: no campaign for its side or mail provider"],
    ['no B2B campaign on this batch; no campaign for the "seg" bucket (email: general, esp: unknown)', "not sent: no campaign for its side or mail provider"],
    ["batch cancelled", "not sent: its push was cancelled"],
    ["a made-up reason", "not sent: skipped by the push worker"],
    [null, "not sent: skipped by the push worker"],
  ];
  check("skipNote: each push-time skip in words, and a fallback", skips.every(([e, w]) => skipNote(e) === w), JSON.stringify(skips.map(([e]) => skipNote(e))));
  const email = `gstest-someone-${RUN}@gstest-co.${HOST}`;
  const errors = [
    [`Bison POST https://${B2B2}/api/leads/${email} -> 401: Unauthorized`, "push failed: Bison refused the key"],
    [`Bison POST https://${B2B2}/api/campaigns/9101/leads/attach-leads -> 403: Forbidden`, "push failed: Bison refused the key"],
    [`no API key for instance ${B2C2}`, "push failed: Bison refused the key"],
    [`gather failed: duplicate key value (email)=(${email})`, "push failed: the gather failed"],
    [`Bison GET https://${B2B2}/api/leads/${email} -> 500: made-up`, "push failed: the push stopped with an error"],
    [null, "push failed: the push stopped with an error"],
  ];
  check("batchErrorNote: a refused key, a failed gather, and a fallback", errors.every(([e, w]) => batchErrorNote(e) === w),
    JSON.stringify(errors.map(([e]) => batchErrorNote(e))));
  check("... an error holding an address gives a note without it, and so does the settle",
    errors.every(([e]) => !batchErrorNote(e).includes("@")) &&
      !JSON.stringify(settleOutcome(bt("error", errors[0][0]), it("pending"), rw())).includes("@") &&
      !JSON.stringify(settleOutcome(bt("complete"), it("skipped", `made-up skip for ${email}`), rw())).includes("@"));
}

// ── W. The worker's texts ───────────────────────────────────────────────────

function partW() {
  section("W. The push worker's and the undo's own texts, fed to the settle");
  const pw = source("scripts/push-worker.mjs");
  const fn = /function shareStopReason\(batch, block\) \{([\s\S]*?)\n\}/.exec(pw)?.[1];
  check("the worker's stop rule is where this test reads it", Boolean(fn));
  const shareStopReason = new Function("batch", "block", fn ?? "return null;");
  const row = { undone: false, leadGone: false, sentElsewhere: false };
  const cannot = shareStopReason({ selected_ids: ["x"], client_tag: C }, "status Paused");
  check("its cannot-receive text, as the worker writes it on the push, settles to \"cannot receive: status Paused\", retried",
    same(settleOutcome({ status: "cancelled", error: cannot, gathered: false }, null, row), { state: "held", note: "cannot receive: status Paused", retry: true }), cannot);
  const noIds = shareStopReason({ selected_ids: [] }, null);
  check("its no-ids text settles to \"push cancelled: a share push with no lead ids\"",
    same(settleOutcome({ status: "cancelled", error: noIds, gathered: false }, null, row), { state: "held", note: "push cancelled: a share push with no lead ids", retry: true }), noIds);
  const undoText = /error = '(Cancelled: [^']+)'/.exec(source("scripts/lib/share/jobs.mjs"))?.[1];
  check("the undo's text (jobs.mjs) settles to \"push cancelled: shares in it were undone on the Sharing page\"",
    same(settleOutcome({ status: "cancelled", error: undoText, gathered: false }, null, row),
      { state: "held", note: "push cancelled: shares in it were undone on the Sharing page", retry: true }), undoText);
  check("the push-time skips the rules read are the worker's own", [
    'error: "ineligible per client targeting at push time"',
    'error: "Bison refused all target campaigns: lead is in another sequence',
    "error: `refusing to push: ${sideCall.refuse}. `",
    "sideDropped ? `no ${String(sideCall.side).toUpperCase()} campaign on this batch` : null",
    'routed ? `no campaign for the "${bucket}" bucket` : null',
    "set status = 'skipped', error = 'batch cancelled'",
  ].every((t) => pw.includes(t)));
  check("... and so are the push errors", [
    "failBatch(batch.id, `gather failed: ",
    "new Error(`no API key for instance ${domain}`)",
    "new Error(`Bison ${method} ${auth.base}${path} -> ${res.status}: ${msg}`)",
  ].every((t) => pw.includes(t)));
  const cancelRoute = source("src/app/api/bison/push-batches/cancel/route.ts");
  check("the Exports page's cancel sets the status and completed_at only (the error is left as it was), for these states",
    cancelRoute.includes('.update({ status: "cancelled", completed_at: new Date().toISOString() })') &&
      cancelRoute.includes('const CANCELLABLE = ["pending", "gathering", "processing", "scoring"];'));
}

// ── S. settleEndedPushes ────────────────────────────────────────────────────

/** The Exports page's cancel (src/app/api/bison/push-batches/cancel/route.ts), as SQL. */
const OPERATOR_CANCEL = `UPDATE push_batches SET status = 'cancelled', completed_at = now()
  WHERE id = $1 AND status IN ('pending', 'gathering', 'processing', 'scoring')`;

async function partS(routes) {
  section("S. settleEndedPushes on the database");
  ctx.jobB = await job(A);
  const keys = ["w1", "w2", "o1", "o2", "e4", "e5", "e6", "e7", "c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "p1", "p2"];
  const L = {};
  for (const k of keys) L[k] = await lead(biz(`b-${k}`), { bounced: k === "c7" });
  const S = {};
  for (const k of keys) S[k] = await share(ctx.jobB, L[k], B);
  ctx.L = L;
  ctx.S = S;

  // B's pushes, each ended (or not) a different way.
  ctx.W1 = await sharePush(B, [S.w1, S.w2], [L.w1, L.w2], { status: "cancelled", error: `Cancelled: ${B} cannot receive (status Paused)`, completed: true });
  ctx.O2 = await sharePush(B, [S.o1, S.o2], [L.o1, L.o2], { status: "scoring" });
  ctx.E1raw = `Bison POST https://${B2B2}/api/leads/${biz("b-e6")} -> 401: Unauthorized`;
  ctx.E1 = await sharePush(B, [S.e4, S.e5, S.e6], [L.e4, L.e5, L.e6], { status: "error", error: ctx.E1raw, total: 3 });
  await items(ctx.E1, [[L.e4, "sent"], [L.e5, "failed", `Bison POST https://${B2B2}/api/leads -> 422: ${biz("b-e5")} is not valid`], [L.e6, "pending"]]);
  ctx.E2raw = "gather failed: canceling statement due to statement timeout";
  ctx.E2 = await sharePush(B, [S.e7], [L.e7], { status: "error", error: ctx.E2raw });
  const cKeys = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10"];
  ctx.C1 = await sharePush(B, cKeys.map((k) => S[k]), cKeys.map((k) => L[k]), { status: "complete", total: 7, completed: true });
  await items(ctx.C1, [
    [L.c1, "sent"],
    [L.c2, "skipped", "ineligible per client targeting at push time"],
    [L.c3, "skipped", "Bison refused all target campaigns: lead is in another sequence, previously bounced, or unsubscribed on that instance"],
    [L.c4, "skipped", FIT_SKIP.unscored],
    [L.c5, "failed", `Bison POST https://${B2B2}/api/leads -> 422: ${biz("b-c5")} is not valid`],
    [L.c9, "failed", "made-up failure"],
    [L.c10, "sent"],
  ]);
  ctx.R0 = await routinePush(B, { list: [[L.c6, "sent"]], counters: { total: 1, processed: 1, sent: 1 } }); // c6 sent for B before
  await pool.query(`DELETE FROM leads WHERE id = $1`, [L.c8]);
  await pool.query(`UPDATE lead_shares SET undone_at = now(), undone_by = $2 WHERE id = ANY($1::bigint[])`, [[S.c9, S.c10], T.userId]);
  ctx.P1 = await sharePush(B, [S.p1, S.p2], [L.p1, L.p2], { status: "processing", total: 2 });
  await items(ctx.P1, [[L.p1, "pending"], [L.p2, "pending"]]);
  ctx.N0 = await sharePush(B, [], null, { status: "cancelled", error: "Cancelled: a share push with no lead ids", completed: true });

  // C: a push the worker cancelled. D: a push still processing, one lead mid-push.
  ctx.jobC = await job(A);
  ctx.lc = await lead(biz("c-w1"));
  ctx.sc = await share(ctx.jobC, ctx.lc, C);
  ctx.W2 = await sharePush(C, [ctx.sc], [ctx.lc], { status: "cancelled", error: `Cancelled: ${C} cannot receive (status Paused)`, completed: true });
  ctx.jobD = await job(A);
  ctx.ld = [await lead(biz("d1")), await lead(biz("d2")), await lead(biz("d3"))];
  ctx.sd = [];
  for (const id of ctx.ld) ctx.sd.push(await share(ctx.jobD, id, D));
  ctx.O1 = await sharePush(D, ctx.sd, ctx.ld, { status: "processing", total: 3 });
  await items(ctx.O1, [[ctx.ld[0], "pushing"], [ctx.ld[1], "pending"], [ctx.ld[2], "pending"]]);
  await pool.query(`UPDATE push_items SET claim_token = gen_random_uuid(), claimed_at = now() WHERE batch_id = $1 AND status = 'pushing'`, [ctx.O1]);

  // An operator cancels O2 (waiting for scoring) and O1 (mid-processing) on the Exports page.
  const oc = [await pool.query(OPERATOR_CANCEL, [ctx.O2]), await pool.query(OPERATOR_CANCEL, [ctx.O1])];
  check("(an operator cancel on the Exports page, as its route writes it)", oc.every((r) => r.rowCount === 1));

  as("manager");
  ctx.jobBefore = await call(routes.job.GET, { query: { id: ctx.jobB } });

  const lines = [];
  const first = await settleEndedPushes(pool, { log: (l) => lines.push(l) });
  const r = await rowsOf(Object.values(S));
  const row = (k) => r[S[k]];

  const p = [row("p1"), row("p2")];
  check("1. a push still processing, its items pending: untouched, not stamped",
    p.every((x) => x.push_state === "pushed" && x.push_batch_id === ctx.P1) && !(await stamped(ctx.P1)));
  check("2. a cancel by the worker's receive check: its shares held with the reason, held_since set, the push kept on them, the push stamped",
    [row("w1"), row("w2")].every((x) => x.push_state === "held" && x.push_note === "cannot receive: status Paused" && x.held_since && x.held_at &&
      x.push_batch_id === ctx.W1 && x.pushed_at) && (await stamped(ctx.W1)), JSON.stringify([row("w1"), row("w2")]));
  const d0 = await rowsOf(ctx.sd);
  check("3. a push cancelled on the Exports page with one lead still pushing: nothing happens yet, not stamped",
    ctx.sd.every((id) => d0[id].push_state === "pushed" && d0[id].push_batch_id === ctx.O1) && !(await stamped(ctx.O1)));
  check("4. a push in error: sent stays pushed, a failed lead \"push failed for this lead\", a pending one the push's note (never its raw error)",
    row("e4").push_state === "pushed" && row("e4").push_batch_id === ctx.E1 &&
      row("e5").push_state === "held" && row("e5").push_note === ITEM_FAILED_NOTE && row("e5").held_since &&
      row("e6").push_state === "held" && row("e6").push_note === "push failed: Bison refused the key" && row("e6").held_since &&
      (await stamped(ctx.E1)), JSON.stringify([row("e4"), row("e5"), row("e6")]));
  check("... and one never gathered (the gather failed): the push's note",
    row("e7").push_state === "held" && row("e7").push_note === "push failed: the gather failed" && row("e7").held_since && (await stamped(ctx.E2)));
  const want = {
    c1: ["pushed", null], c2: ["dropped", "not_eligible"], c3: ["dropped", "bison_refused"], c4: ["held", "not sent: company not scored yet (fit gate)"],
    c5: ["held", ITEM_FAILED_NOTE], c6: ["dropped", "already_sent"], c7: ["dropped", "not_eligible"], c8: ["dropped", "no_lead"],
  };
  check("5. a complete push: sent, ineligible, refused by Bison, fit gate, failed, sent elsewhere, left out, lead deleted",
    Object.entries(want).every(([k, [state, note]]) => row(k).push_state === state && row(k).push_note === note && row(k).push_batch_id === ctx.C1 && row(k).pushed_at) &&
      row("c4").held_since && row("c5").held_since && (await stamped(ctx.C1)),
    JSON.stringify(Object.fromEntries(Object.keys(want).map((k) => [k, [row(k).push_state, row(k).push_note]]))));
  check("6. an undone share on an ended push: dropped, undone; one undone after its lead was sent stays pushed",
    row("c9").push_state === "dropped" && row("c9").push_note === "undone" && row("c10").push_state === "pushed" && row("c10").push_note === null);
  check("... a push cancelled while waiting for scoring (no items): its shares held, cancelled on the Exports page, held_since empty",
    [row("o1"), row("o2")].every((x) => x.push_state === "held" && x.push_note === OPERATOR_CANCEL_NOTE && x.held_since === null && x.held_at) &&
      (await stamped(ctx.O2)));
  check("... a share push with no lead ids is only stamped; the other client's cancelled push settled too",
    (await stamped(ctx.N0)) && (await rowsOf([ctx.sc]))[ctx.sc].push_note === "cannot receive: status Paused" && (await stamped(ctx.W2)));
  check("the call's counts: 7 pushes, 10 held, 6 dropped, 3 left pushed (sent)",
    same(first, { batches: 7, kept: 3, held: 10, dropped: 6 }), JSON.stringify(first));
  const lineRe = /^overlap sharing: share push [0-9a-f]{8} \(GSTEST_[A-F], (complete|cancelled|error)\): \d+ held, \d+ dropped, \d+ sent$/;
  check("one log line per push that moved shares, in words, with no address",
    lines.length === 6 && lines.every((l) => lineRe.test(l) && !l.includes("@")) &&
      lines.includes(`overlap sharing: share push ${ctx.C1.slice(0, 8)} (${B}, complete): 2 held, 6 dropped, 2 sent`), JSON.stringify(lines));

  // O1: the lead mid-push ends sent, the push worker's housekeeping skips the rest, then the settle takes it.
  const pw = source("scripts/push-worker.mjs");
  const refresh = /async function refreshActiveBatches\(\) \{[\s\S]*?await pool\.query\(\s*`([\s\S]*?)`/.exec(pw)?.[1] ?? "";
  check("(the push worker's housekeeping statement is where this test reads it)", /set status = 'skipped', error = 'batch cancelled'/.test(refresh));
  await pool.query(`UPDATE push_items SET status = 'sent', claim_token = NULL, claimed_at = NULL WHERE batch_id = $1 AND lead_id = $2`, [ctx.O1, ctx.ld[0]]);
  await pool.query(refresh);
  const skipped = await all(`SELECT status, error FROM push_items WHERE batch_id = $1 AND lead_id = ANY($2::uuid[])`, [ctx.O1, ctx.ld.slice(1)]);
  const second = await settleEndedPushes(pool);
  const d1 = await rowsOf(ctx.sd);
  check("3. ... once it ends sent and the housekeeping skips the pending ones: the sent share stays pushed, the rest held, never retried by itself",
    skipped.every((x) => x.status === "skipped" && x.error === "batch cancelled") && second.batches === 1 &&
      d1[ctx.sd[0]].push_state === "pushed" && d1[ctx.sd[0]].push_batch_id === ctx.O1 &&
      ctx.sd.slice(1).every((id) => d1[id].push_state === "held" && d1[id].push_note === OPERATOR_CANCEL_NOTE && d1[id].held_since === null &&
        d1[id].held_at && d1[id].push_batch_id === ctx.O1) && (await stamped(ctx.O1)), JSON.stringify({ second, d1 }));

  // 7. Again: nothing changes.
  const snap = await snapshot();
  const st = await stamps();
  const again = await settleEndedPushes(pool);
  check("7. a second call changes nothing and settles no push; every stamp is where it was",
    same(again, { batches: 0, kept: 0, held: 0, dropped: 0 }) && same(await snapshot(), snap) && same(await stamps(), st), JSON.stringify(again));

  // 8. A push an undo cancelled: the undo moved its shares; the settle only stamps it.
  const jobU = await job(A);
  const lu = [await lead(biz("u1")), await lead(biz("u2"))];
  const su = [await share(jobU, lu[0], B), await share(jobU, lu[1], B)];
  ctx.U1 = await sharePush(B, su, lu, { status: "pending" });
  const undone = await undoShareJob(pool, { batchId: jobU, receiver: null, userId: T.userId });
  const u0 = await snapshot();
  const u = await settleEndedPushes(pool);
  const ub = await batchRow(ctx.U1);
  check("8. a push an undo cancelled is only stamped: its shares stay as the undo left them",
    same(undone.cancelledPushes, [ctx.U1]) && ub.status === "cancelled" && same(u, { batches: 1, kept: 0, held: 0, dropped: 0 }) &&
      same(await snapshot(), u0) && (await stamped(ctx.U1)) && Object.values(await rowsOf(su)).every((x) => x.push_state === "dropped" && x.push_note === "undone"),
    JSON.stringify({ undone, u }));

  // 9. Two settles at once (two workers during a deploy).
  const many = [];
  for (let i = 0; i < 4; i++) {
    const ls = [await lead(biz(`c-m${i}a`)), await lead(biz(`c-m${i}b`))];
    const ss = [await share(ctx.jobC, ls[0], C), await share(ctx.jobC, ls[1], C)];
    many.push(...ss);
    await sharePush(C, ss, ls, { status: "cancelled", error: `Cancelled: ${C} cannot receive (status Paused)`, completed: true });
  }
  const p1 = new pg.Pool({ connectionString: url, max: 2 });
  const p2 = new pg.Pool({ connectionString: url, max: 2 });
  let both;
  try {
    both = await Promise.all([settleEndedPushes(p1), settleEndedPushes(p2)]);
  } finally {
    await p1.end();
    await p2.end();
  }
  const m = await rowsOf(many);
  check("9. two calls at once settle each push and each share once",
    both[0].batches + both[1].batches === 4 && both[0].held + both[1].held === 8 &&
      many.every((id) => m[id].push_state === "held" && m[id].push_note === "cannot receive: status Paused"), JSON.stringify(both));

  // 10. More ended pushes than a call takes.
  for (let i = 0; i < 3; i++) {
    const l = await lead(biz(`c-x${i}`));
    await sharePush(C, [await share(ctx.jobC, l, C)], [l], { status: "cancelled", error: `Cancelled: ${C} cannot receive (status Paused)`, completed: true });
  }
  const n1 = await settleEndedPushes(pool, { maxMs: 0 });
  const n2 = await settleEndedPushes(pool, { maxBatches: 1 });
  const n3 = await settleEndedPushes(pool);
  const n4 = await settleEndedPushes(pool);
  check("10. more ended pushes than a call takes: the rest the next call (maxBatches 1: one; maxMs 0: the first only)",
    n1.batches === 1 && n2.batches === 1 && n3.batches === 1 && n4.batches === 0 && SETTLE_BATCHES_PER_ROUND === 20 && SETTLE_MS === 15_000,
    JSON.stringify([n1, n2, n3, n4]));

  // 12. One push whose statement fails: logged, left for the next call; the others settled.
  const bad = [];
  for (let i = 0; i < 2; i++) {
    const l = await lead(biz(`c-f${i}`));
    bad.push(await sharePush(C, [await share(ctx.jobC, l, C)], [l], { status: "cancelled", error: `Cancelled: ${C} cannot receive (status Paused)`, completed: true }));
  }
  const failing = {
    query: (...a) => pool.query(...a),
    connect: async () => {
      const c = await pool.connect();
      return {
        query: (sql, params) => (sql === SETTLE_ROWS_SQL && params?.[0] === bad[0]
          ? Promise.reject(Object.assign(new Error("made-up failure in one push"), { code: "XX000" }))
          : c.query(sql, params)),
        release: (e) => c.release(e),
      };
    },
  };
  const failLines = [];
  const f1 = await settleEndedPushes(failing, { log: (l) => failLines.push(l) });
  const leftOver = !(await stamped(bad[0])) && (await stamped(bad[1]));
  const f2 = await settleEndedPushes(pool);
  check("12. a push whose statement fails is logged and left for the next call; the others are settled",
    f1.batches === 1 && leftOver && failLines.some((l) => l.startsWith(`overlap sharing: share push ${bad[0].slice(0, 8)} could not be settled, tried again next round`)) &&
      f2.batches === 1 && (await stamped(bad[0])), JSON.stringify({ f1, f2, failLines }));

  // 11. The plans.
  await pool.query(`ANALYZE public.lead_shares, public.push_items, public.push_batches`);
  const show = (nodes) => JSON.stringify(nodes.map((x) => [x["Node Type"], x["Relation Name"], x["Index Name"]]));
  const seq = (nodes, rels) => nodes.filter((x) => x["Node Type"] === "Seq Scan" && rels.includes(x["Relation Name"]));
  const rowsPlan = await explain(SETTLE_ROWS_SQL, [ctx.C1, B, true]);
  check("11. EXPLAIN of the row statement (small-table shortcuts off): lead_shares by lead_shares_lead_idx, no scan of lead_shares or push_items",
    rowsPlan.some((x) => x["Relation Name"] === "lead_shares" && x["Index Name"] === "lead_shares_lead_idx") && seq(rowsPlan, ["lead_shares", "push_items"]).length === 0,
    show(rowsPlan));
  const candPlan = await explain(SETTLE_CANDIDATES_SQL, [["share", "topup"], SETTLE_BATCHES_PER_ROUND]);
  check("... and the candidates read push_items by an index, never a scan", candPlan.some((x) => x["Relation Name"] === "push_items" && x["Index Name"]) &&
    seq(candPlan, ["push_items"]).length === 0, show(candPlan));
}

// ── J. The job route ────────────────────────────────────────────────────────

async function partJ(routes) {
  section("J. The job route: how each push ended, settled or not");
  as("manager");
  const before = ctx.jobBefore;
  const after = await call(routes.job.GET, { query: { id: ctx.jobB } });
  const of = (res, id) => res.body?.pushBatches?.find((b) => b.id === id);
  const want = [
    [ctx.W1, "cancelled", `${B} cannot receive (status Paused)`],
    [ctx.O2, "cancelled", "cancelled on the Exports page"],
    [ctx.E1, "error", "push failed: Bison refused the key"],
    [ctx.E2, "error", "push failed: the gather failed"],
    [ctx.C1, "complete", null],
    [ctx.P1, "processing", null],
  ];
  check("before the settle: each push's status and how it ended, in words; none settled",
    before.status === 200 && want.every(([id, st, note]) => of(before, id)?.status === st && of(before, id)?.endNote === note && of(before, id)?.settled === false),
    JSON.stringify(before.body?.pushBatches));
  check("after it: the ended ones settled, the one still processing not",
    after.status === 200 && want.every(([id, st, note]) => of(after, id)?.status === st && of(after, id)?.endNote === note && of(after, id)?.settled === (st !== "processing")),
    JSON.stringify(after.body?.pushBatches));
  const text = JSON.stringify([before.body?.pushBatches, after.body?.pushBatches]);
  check("never a raw error: no address, no Bison request, no gather text, no \"Cancelled: \"",
    ![ctx.E1raw, ctx.E2raw, "@", "->", "Cancelled: "].some((t) => text.includes(t)), text);
  as("viewer");
  check("viewers get 403", (await call(routes.job.GET, { query: { id: ctx.jobB } })).status === 403);
}

// ── R. The retry window ─────────────────────────────────────────────────────

async function partR(routes, pushLib) {
  section("R. The retry window after settling");
  const settings = await settingsNow();
  const s1 = pushStub();
  const made = await pushTimer(pool, { settings, memory: newUpkeepMemory(), env: PUSH_ENV, fetchImpl: s1.fetchImpl });
  const heldAsks = made.filter((x) => x.retryHeld).map((x) => x.receiver);
  check("the push timer asks again (retryHeld) for B (cancelled by the worker, failed leads) and C (cancelled by the worker only), never for D (only a push cancelled on the Exports page)",
    heldAsks.includes(B) && heldAsks.includes(C) && !made.some((x) => x.receiver === D) && s1.asked.every((a) => a.url === PUSH_URL), JSON.stringify(made));

  const S = ctx.S;
  const retried = [S.w1, S.w2, S.e5, S.e6, S.e7, S.c4, S.c5];
  const r = await pushLib.pushReceiverShares(pool, {
    receiver: B,
    retryHeld: true,
    readCampaigns: async (tag) => ({ data: [{ ...camp(9101, `${tag}: Google + Custom`), instance_url: B2B2 }], errors: [] }),
  });
  const after = await rowsOf([...retried, S.o1, S.o2]);
  check("pushReceiverShares with retryHeld takes the shares the worker's cancel and the failed leads held, not those of the push cancelled on the Exports page",
    r.status === 200 && r.body.pushed === retried.length && r.body.batches.length === 1 &&
      retried.every((id) => after[id].push_state === "pushed" && after[id].push_batch_id === r.body.batches[0] && after[id].push_note === null) &&
      [S.o1, S.o2].every((id) => after[id].push_state === "held" && after[id].push_note === OPERATOR_CANCEL_NOTE && after[id].push_batch_id === ctx.O2),
    JSON.stringify(r.body));
  const s2 = pushStub();
  const made2 = await pushTimer(pool, { settings, memory: newUpkeepMemory(), env: PUSH_ENV, fetchImpl: s2.fetchImpl });
  check("... and the timer then asks for C only: B's held shares left are a push cancelled on the Exports page",
    made2.some((x) => x.receiver === C && x.retryHeld) && !made2.some((x) => x.receiver === B || x.receiver === D), JSON.stringify(made2));

  // Push shared with held: the only way the shares of a push cancelled on the Exports page go again.
  net.plan = { [B2B2]: [camp(9401, `${D}: Google + Custom`)] };
  as("admin");
  const dry = await call(routes.push.POST, { body: { receiver: D, held: true, dryRun: true } });
  check("Push shared (held, dry run) counts the shares of the push cancelled on the Exports page",
    dry.status === 200 && same(dry.body.queue, { [D]: 2 }) && same(dry.body.notOnPushList, {}), JSON.stringify(dry.body));
  const bisonBefore = net.bison;
  const audits0 = T.audits.length;
  const go = await call(routes.push.POST, { body: { receiver: D, held: true } });
  const d = await rowsOf(ctx.sd);
  const newBatch = go.body?.results?.[0]?.batches?.[0];
  const nb = newBatch ? await one(`SELECT selected_ids, client_tag, push_options, status FROM push_batches WHERE id = $1`, [newBatch]) : null;
  check("... and without it requeues them (note, held_since, held_at cleared) and pushes them through the campaign search",
    go.status === 200 && same(go.body.queued, { [D]: 2 }) && go.body.results[0]?.pushed === 2 && net.bison > bisonBefore &&
      ctx.sd.slice(1).every((id) => d[id].push_state === "pushed" && d[id].push_batch_id === newBatch && d[id].push_note === null && d[id].held_since === null &&
        d[id].held_at === null) && nb && same(sorted(nb.selected_ids), sorted(ctx.ld.slice(1))) && nb.push_options?.skipAlreadySent === true &&
      T.audits.length === audits0 + 1 && T.audits.at(-1).action === "Shares Queued For Push",
    JSON.stringify({ body: go.body, d }));
  check("... the lead already sent in the cancelled push is left where it was",
    d[ctx.sd[0]].push_state === "pushed" && d[ctx.sd[0]].push_batch_id === ctx.O1);
  ctx.newD = newBatch;
}

// ── N. Never twice ──────────────────────────────────────────────────────────

async function partN() {
  section("N. Never twice");
  const pw = source("scripts/push-worker.mjs");
  const ELIGIBLE = piece(pw, "ELIGIBLE");
  const NOT_SENT = piece(pw, "NOT_SENT_FOR_CLIENT");
  check("(the push worker's gather statements are where this test reads them)", Boolean(ELIGIBLE && NOT_SENT));
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const ids = [ctx.ld[0], ctx.ld[1]];
    const { rows: [b] } = await c.query(
      `INSERT INTO push_batches (campaigns, selected_ids, client_tag, push_options, status) VALUES ('[]'::jsonb, $1::uuid[], $2, $3::jsonb, 'gathering') RETURNING id`,
      [ids, D, JSON.stringify({ source: "share", skipAlreadySent: true })]
    );
    const got = (await c.query(`select l.id, l.email from leads l where l.id = any($1::uuid[]) and ${ELIGIBLE} and ${NOT_SENT}`, [ids, D, b.id])).rows.map((x) => x.id);
    check("the push worker's selected-ids gather (skipAlreadySent) over the requeued lead and the lead sent in the cancelled push takes only the first",
      same(got, [ctx.ld[1]]), JSON.stringify(got));
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
  const moved = await one(
    `SELECT count(*)::int AS n FROM lead_shares s JOIN push_items i ON i.batch_id = s.push_batch_id AND i.lead_id = s.lead_id
      WHERE starts_with(s.receiver_tag, 'GSTEST_') AND i.status = 'sent' AND s.push_state <> 'pushed'`
  );
  const S = ctx.S;
  const sent = await rowsOf([S.e4, S.c1, S.c10, ctx.sd[0]]);
  check("no settled share whose lead was sent is ever requeued: each stays pushed with the push that sent it",
    moved.n === 0 && sent[S.e4].push_batch_id === ctx.E1 && sent[S.c1].push_batch_id === ctx.C1 && sent[S.c10].push_batch_id === ctx.C1 &&
      sent[ctx.sd[0]].push_batch_id === ctx.O1 && Object.values(sent).every((x) => x.push_state === "pushed"), JSON.stringify({ moved, sent }));
}

// ── X. The Exports page's Retry ─────────────────────────────────────────────

async function partX(routes) {
  section("X. The Exports page's Retry");
  as("manager");
  const L = ctx.L;
  const c1Before = await batchRow(ctx.C1);
  const r1 = await call(routes.retry.POST, { body: { batchId: ctx.C1 } });
  check("a share push's own Retry: 409 pointing at the Sharing page; its failed item and the push left as they were",
    r1.status === 409 && r1.body.error === "This is a share push: its leads are pushed again from the Sharing page (Held tab), not from here." &&
      (await itemOf(ctx.C1, L.c5)).status === "failed" && same(await batchRow(ctx.C1), c1Before), JSON.stringify(r1.body));
  const e1Before = await batchRow(ctx.E1);
  const r2 = await call(routes.retry.POST, { body: { batchId: ctx.E1 } });
  check("... one in error too", r2.status === 409 && (await itemOf(ctx.E1, L.e5)).status === "failed" && same(await batchRow(ctx.E1), e1Before));

  const lf = [await lead(biz("f-r1")), await lead(biz("f-r2"))];
  const rb1 = await routinePush(F, { list: [[lf[0], "sent"], [lf[1], "failed", "made-up 500"]], counters: { total: 2, processed: 2, sent: 1, failed: 1 } });
  const r3 = await call(routes.retry.POST, { body: { all: true } });
  const b1 = await batchRow(rb1);
  check("retry all: a routine push's failed item requeued and the push reopened; the share pushes' failed items left alone",
    r3.status === 200 && r3.body.requeued === 1 && r3.body.batches === 1 && b1.status === "processing" && b1.completed_at === null && b1.failed === 0 &&
      b1.processed === 1 && (await itemOf(rb1, lf[1])).status === "pending" && (await itemOf(ctx.C1, L.c5)).status === "failed" &&
      (await itemOf(ctx.C1, L.c9)).status === "failed" && (await itemOf(ctx.E1, L.e5)).status === "failed" && same(await batchRow(ctx.C1), c1Before) &&
      same(await batchRow(ctx.E1), e1Before), JSON.stringify(r3.body));
  const lf2 = [await lead(biz("f-r3")), await lead(biz("f-r4"))];
  const rb2 = await routinePush(F, { status: "error", list: [[lf2[0], "failed", "made-up"], [lf2[1], "failed", "made-up"]], counters: { total: 2, processed: 2, failed: 2 } });
  const r4 = await call(routes.retry.POST, { body: { batchId: rb2 } });
  const b2 = await batchRow(rb2);
  const it2 = await all(`SELECT status, attempts, error FROM push_items WHERE batch_id = $1`, [rb2]);
  check("a routine push alone, as before: its failed items requeued, reopened to processing, its counters rolled back",
    r4.status === 200 && r4.body.requeued === 2 && r4.body.batches === 1 && b2.status === "processing" && b2.failed === 0 && b2.processed === 0 &&
      it2.every((x) => x.status === "pending" && x.attempts === 0 && x.error === null), JSON.stringify(r4.body));
  as(null);
  check("no session: 401, as before", (await call(routes.retry.POST, { body: { all: true } })).status === 401);
}

// ── F. Refusals ─────────────────────────────────────────────────────────────

async function partF() {
  section("F. The push timer's refusals");
  const settings = await settingsNow();
  ctx.jobF = await job(A);
  const sf = [await share(ctx.jobF, await lead(biz("f-q1")), F), await share(ctx.jobF, await lead(biz("f-q2")), F)];
  await share(ctx.jobF, await lead(biz("c-q1")), C);
  const refusal = "made-up refusal: the campaign search reported an error";
  const s = pushStub({ [F]: () => ({ status: 409, body: { error: refusal, kept: 2 } }) });
  const mem = newUpkeepMemory();
  let clock = Date.parse("2026-11-20T12:00:00.000Z");
  const tick = () => pushTimer(pool, { settings, memory: mem, env: PUSH_ENV, fetchImpl: s.fetchImpl, now: () => clock });
  const asksOf = (tag) => s.asked.filter((a) => a.receiver === tag).length;

  const made = await tick();
  check("a 409 for one client and a 200 for another: only the refused one is kept, with when, the status, the error and kept",
    made.some((x) => x.receiver === F && x.status === 409) && made.some((x) => x.receiver === C && x.ok) && same([...mem.refusals.keys()], [F]) &&
      same(mem.refusals.get(F), { receiver: F, at: new Date(clock).toISOString(), status: 409, error: refusal, kept: 2, retryHeld: false }),
    JSON.stringify({ made, refusals: [...mem.refusals.values()] }));
  const n0 = asksOf(F);
  clock += 10 * 60_000;
  await tick();
  check("... it stays while the client is not asked again (inside push_every_minutes)", asksOf(F) === n0 && mem.refusals.get(F)?.status === 409);
  clock += 6 * 60_000;
  delete s.plan[F];
  await tick();
  check("the next ask after push_every_minutes goes through (200): the refusal is cleared", asksOf(F) === n0 + 1 && !mem.refusals.has(F));
  clock += 16 * 60_000;
  s.plan[F] = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  await tick();
  check("a fetch that throws is kept too: no status, nothing kept",
    same(mem.refusals.get(F), { receiver: F, at: new Date(clock).toISOString(), status: null, error: "ECONNRESET", kept: null, retryHeld: false }),
    JSON.stringify(mem.refusals.get(F)));
  await pool.query(`UPDATE lead_shares SET push_state = 'dropped', push_note = 'undone' WHERE id = ANY($1::bigint[])`, [sf]);
  clock += 60_000;
  const n1 = asksOf(F);
  await tick();
  check("a client with nothing queued or held any more is forgotten, unasked", asksOf(F) === n1 && !mem.refusals.has(F));
  const sf3 = await share(ctx.jobF, await lead(biz("f-q3")), F);
  s.plan[F] = () => ({ status: 409, body: { error: refusal, kept: "2" } });
  clock += 16 * 60_000;
  await tick();
  check("... a kept that is not a whole number reads null", mem.refusals.get(F)?.status === 409 && mem.refusals.get(F)?.kept === null);
  await pool.query(`UPDATE lead_shares SET push_state = 'dropped', push_note = 'undone' WHERE id = $1`, [sf3]);
  // A held retry refused: kept with retryHeld; a 200 for that client, queued or held, clears it.
  s.plan[C] = (body) => (body.retryHeld ? { status: 503, body: { error: "Share pushes are off: no SHARE_PUSH_KEY is set" } } : undefined);
  clock += 25 * 3600_000;
  await tick();
  const rc = mem.refusals.get(C);
  check("a refused held retry is kept with retryHeld", rc?.status === 503 && rc.retryHeld === true && rc.kept === null && rc.error === "Share pushes are off: no SHARE_PUSH_KEY is set",
    JSON.stringify(rc));
  delete s.plan[C];
  clock += 16 * 60_000;
  await tick();
  check("... and the next 200 for that client clears it", !mem.refusals.has(C));

  const big = newUpkeepMemory();
  for (let i = 204; i >= 0; i--) {
    const tag = `GSTEST_Z${String(i).padStart(3, "0")}`;
    big.refusals.set(tag, { receiver: tag, at: new Date(0).toISOString(), status: 409, error: "made-up", kept: 1, retryHeld: false });
  }
  const list = pushRefusals(big);
  check("pushRefusals: sorted by client, at most 200, copies",
    list.length === 200 && list[0].receiver === "GSTEST_Z000" && list[199].receiver === "GSTEST_Z199" && list.every((x, i) => i === 0 || list[i - 1].receiver < x.receiver) &&
      list[0] !== big.refusals.get("GSTEST_Z000"));
  check("... [] for a memory without them", same(pushRefusals(null), []) && same(pushRefusals({}), []) && same(pushRefusals({ refusals: [] }), []));
  check("shareRefusals: [] for a new memory, the push timer's list otherwise",
    same(shareRefusals(newShareMemory()), []) && same(shareRefusals({ upkeep: big }), list) && same(shareRefusals(null), []));
  const ws = source("scripts/enrich-worker.mjs");
  check("the worker's heartbeat carries them inside sharing",
    /sharing: \{ push_auto: Boolean\(sharePush\), refusals: shareRefusals\(shareMemory\) \},/.test(ws) &&
      /import \{ newShareMemory, SHARE_EVERY_MS, shareRefusals, shareRound \} from "\.\/lib\/share\/step\.mjs";/.test(ws));
}

// ── H. The held route ───────────────────────────────────────────────────────

async function partH(routes) {
  section("H. The held route");
  const good = { receiver: F, at: "2026-11-20T11:00:00.000Z", status: 409, error: `made-up refusal ${"x".repeat(600)}`, kept: 2, retryHeld: false };
  T.worker = heartbeat({
    refusals: [good, { ...good, receiver: "not a tag!" }, { ...good, receiver: C, status: "409" }, { ...good, receiver: D, at: "yesterday" }],
  });
  as("manager");
  const h = await call(routes.held.GET);
  check("the worker's refusals: the good one only, its error cut to 500; the worker online",
    h.status === 200 && same(h.body.refusals, [{ ...good, error: good.error.slice(0, 500) }]) && same(h.body.worker, { online: true, secondsAgo: 2, sharing: true }),
    JSON.stringify({ refusals: h.body.refusals?.map((x) => ({ ...x, error: x.error.length })), worker: h.body.worker }));
  const op = h.body.held?.find((g) => g.receiver === B && g.note === OPERATOR_CANCEL_NOTE);
  const wc = h.body.held?.find((g) => g.receiver === C && g.note === "cannot receive: status Paused");
  check("a group of a push cancelled on the Exports page: manual, aged from when it was held, not retried",
    op && op.manual === true && op.retried === false && op.rows === 2 && op.oldest !== null && Number.isFinite(Date.parse(op.oldest)), JSON.stringify(op));
  check("a group the worker's cancel held: retried, not manual", wc && wc.retried === true && wc.manual === false && wc.oldest !== null, JSON.stringify(wc));
  T.worker = heartbeat({ online: false, refusals: [good] });
  const off = await call(routes.held.GET);
  check("an offline worker: what it reported last, and online false", off.body.worker?.online === false && off.body.refusals?.length === 1);
  T.worker = null;
  const none = await call(routes.held.GET);
  check("no worker: no refusals, worker null", same(none.body.refusals, []) && none.body.worker === null);
  as("viewer");
  check("viewers get 403", (await call(routes.held.GET)).status === 403);

  const tab = source("src/components/sharing/held-tab.tsx").replace(/\s+/g, " ");
  check("the Held tab: the refused pushes block, the offline note, the manual badge and the footer",
    ["Pushes refused", "the last push was refused", "The worker is offline; this is what it reported last.",
      "Kept by the running worker: cleared by the next push for that client that goes through. A worker restart forgets it until the next try.",
      "Not retried: Push shared sends them", "Shares of a push cancelled on the Exports page are never tried again by themselves.", "(held shares tried again)"]
      .every((t) => tab.includes(t)));
  const labels = await srcModule("lib/sharing/labels.ts");
  check("the three new drop notes in words", labels.pushNoteText("already_sent") === "already sent to this client by another push" &&
    labels.pushNoteText("not_eligible") === "not eligible when pushed (no email, bounced, not valid, or outside the client's rules then)" &&
    labels.pushNoteText("bison_refused") === "Bison refused it (in another sequence, bounced or unsubscribed there)" &&
    labels.pushNoteText(OPERATOR_CANCEL_NOTE) === OPERATOR_CANCEL_NOTE);
  const jd = source("src/components/sharing/job-detail.tsx").replace(/\s+/g, " ");
  check("the job detail's push line says how it ended and whether it is settled",
    jd.includes("{b.endNote ? ` · ${b.endNote}` : \"\"}") && jd.includes("\" · settled\"") &&
      jd.includes("\" · not settled yet: its leads that were not sent get their end state at the next share round\""));
}

// ── O. Whole rounds ─────────────────────────────────────────────────────────

async function partO() {
  section("O. Whole rounds");
  const step = source("scripts/lib/share/step.mjs");
  const iRecheck = step.indexOf('part("recheck"');
  const iSettle = step.indexOf('part("settle"');
  const iPush = step.indexOf('part("push"');
  check("the settle part runs after the recheck and before the push timer", iRecheck > 0 && iSettle > iRecheck && iPush > iSettle);
  const untouched = { query: async () => { throw new Error("no statement may run"); }, connect: async () => { throw new Error("no connection may be taken"); } };
  const off = await shareRound(untouched, { settings: settingsFrom([]), memory: newShareMemory() });
  const base = settingsBefore.find((r) => r.key === "overlap_sharing")?.value ?? {};
  const noSince = await shareRound(untouched, { settings: settingsFrom([{ key: "overlap_sharing", value: { ...base, ...SHARING_ON(), since: null } }]), memory: newShareMemory() });
  check("sharing off (as shipped), or on with no since: a round runs no statement, the settle included",
    off.idle === true && off.settled === 0 && off.errors.length === 0 && noSince.idle === true && noSince.settled === 0 && noSince.errors.length === 0);
  const missing = {
    query: async () => { throw Object.assign(new Error("relation does not exist"), { code: "42P01" }); },
    connect: async () => ({
      query: async (sql) => {
        if (/^(BEGIN|SET|ROLLBACK)/.test(sql)) return { rows: [] };
        throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
      },
      release() {},
    }),
  };
  let code = null;
  try {
    await settleEndedPushes(missing);
  } catch (e) {
    code = e.code;
  }
  check("a missing migration (42P01) is thrown on by the settle, so the step stays idle", code === "42P01");

  await setSharing(SHARING_ON({ since: new Date().toISOString() }));
  const settings = await settingsNow();
  const jobE = await job(A);
  const le = [await lead(biz("e1")), await lead(biz("e2"))];
  const se = [await share(jobE, le[0], E), await share(jobE, le[1], E)];
  const eb = await sharePush(E, se, le, { status: "cancelled", error: `Cancelled: ${E} cannot receive (status Paused)`, completed: true });
  const s = pushStub();
  const memory = newShareMemory();
  let clock = Date.parse("2026-11-21T09:00:00.000Z");
  const lines = [];
  const round = () => shareRound(pool, { settings, memory, env: PUSH_ENV, fetchImpl: s.fetchImpl, now: () => clock, log: (l) => lines.push(l) });
  const heldAsks = (from) => s.asked.slice(from).filter((a) => a.receiver === E && a.retryHeld === true).length;
  const r1 = await round();
  const er = await rowsOf(se);
  check("a round with sharing on settles the ended push (settled 1); no part fails",
    r1.idle === false && r1.settled === 1 && r1.errors.length === 0 && (await stamped(eb)) &&
      se.every((id) => er[id].push_state === "held" && er[id].push_note === "cannot receive: status Paused"), JSON.stringify({ r1, lines }));
  check("... and the same round's push timer asks for its held shares (retryHeld)", heldAsks(0) === 1 && s.asked.every((a) => a.url === PUSH_URL), JSON.stringify(s.asked));
  clock += 3600_000;
  const n1 = s.asked.length;
  const r2 = await round();
  check("an hour later: nothing new to settle, and it is not asked again", r2.settled === 0 && r2.errors.length === 0 && heldAsks(n1) === 0, JSON.stringify(r2));
  clock += 24 * 3600_000;
  const n2 = s.asked.length;
  const r3 = await round();
  check("a day later it is asked again", r3.errors.length === 0 && heldAsks(n2) === 1, JSON.stringify(r3));
}

// ── Run ─────────────────────────────────────────────────────────────────────

const t0 = Date.now();
let crashed = null;
try {
  await cleanup();
  const foreign = await one(
    `SELECT (SELECT count(*) FROM share_jobs)::int AS jobs, (SELECT count(*) FROM lead_shares)::int AS shares,
            (SELECT count(*) FROM upload_batch_leads)::int AS lists,
            (SELECT count(*) FROM push_batches b
              WHERE coalesce(b.push_options->>'source', '') IN ('share', 'topup') AND b.status IN ('complete', 'cancelled', 'error')
                AND NOT (coalesce(b.push_options, '{}'::jsonb) ? '${SETTLED_KEY}'))::int AS unsettled,
            (SELECT count(*) FROM push_items WHERE status = 'failed')::int AS failed,
            (SELECT count(*) FROM push_items i JOIN push_batches b ON b.id = i.batch_id WHERE b.status = 'cancelled' AND i.status = 'pending')::int AS cancelled_pending`
  );
  if (Object.values(foreign).some((n) => n > 0)) {
    console.error(`Refusing to run: the local database holds rows the settle, the share round or "retry all" would touch (${JSON.stringify(foreign)}).`);
    await pool.end();
    process.exit(1);
  }
  settingsBefore = await all(`SELECT key, value FROM enrich_settings ORDER BY key`);
  baseline = await counts();
  check("sharing is off as found (it ships off)", settingsFrom(settingsBefore.filter((r) => r.key === "overlap_sharing")).overlap_sharing.enabled === false);
  partU();
  partW();
  await client(A, { group: 1, b2b: B2B1, b2c: B2C1 });
  await client(B);
  await client(C, { status: "Paused" });
  await client(D);
  await client(E);
  await client(F);
  await setSharing(SHARING_ON());
  const routes = {
    held: await route("sharing/held"),
    job: await route("sharing/job"),
    push: await route("sharing/push"),
    retry: await route("bison/push-batches/retry"),
  };
  const pushLib = await srcModule("lib/sharing/push.ts");
  await partS(routes);
  await partJ(routes);
  await partR(routes, pushLib);
  await partN();
  await partX(routes);
  await partF();
  await partH(routes);
  await partO();
} catch (e) {
  crashed = e;
  check("the suite ran to its end", false, e?.stack ?? e);
} finally {
  section("Z. Nothing reached the network, everything removed");
  check("no request left this machine: only the four made-up installs' campaign search answered", net.refused === 0 && [...net.hosts].every((h) => INSTALLS.includes(h)),
    JSON.stringify({ refused: net.refused, hosts: [...net.hosts] }));
  try {
    await cleanup();
    const left = await one(
      `SELECT (SELECT count(*) FROM client_tags WHERE starts_with(tag, 'GSTEST_'))::int AS tags,
              (SELECT count(*) FROM leads WHERE email LIKE $1)::int AS leads,
              (SELECT count(*) FROM push_batches WHERE starts_with(coalesce(client_tag, ''), 'GSTEST_'))::int AS batches,
              (SELECT count(*) FROM lead_shares WHERE starts_with(receiver_tag, 'GSTEST_') OR starts_with(origin_tag, 'GSTEST_'))::int AS shares,
              (SELECT count(*) FROM upload_batches WHERE filename LIKE 'gstest-%')::int AS uploads`,
      [`%.${HOST}`]
    );
    check("every made-up row is gone", left && Object.values(left).every((n) => n === 0), JSON.stringify(left));
    if (baseline) check("nothing else moved: other leads, pushes, items, clients, share jobs and shares as before", same(await counts(), baseline), JSON.stringify({ baseline, now: await counts() }));
    const back = await all(`SELECT key, value FROM enrich_settings ORDER BY key`);
    check("the settings are back as they were, overlap_sharing included", Boolean(settingsBefore) && same(
      Object.fromEntries(back.map((r) => [r.key, r.value])),
      Object.fromEntries((settingsBefore ?? []).map((r) => [r.key, r.value]))
    ));
  } catch (e) {
    check("the cleanup ran", false, e?.stack ?? e);
  }
  for (const p of T.pools) await p.end().catch(() => {});
  await pool.end();
  console.log(`\n${out.passed} passed, ${out.failed} failed${crashed ? " (stopped early)" : ""} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(out.failed ? 1 : 0);
}
