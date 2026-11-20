#!/usr/bin/env node
// The database backfill (migration 138): scripts/lib/backfill/, the cron
// script scripts/backfill-worker.mjs, the share actions' refusal of a backfill
// job, the Sharing page's jobs list and Backfill route, and the share push
// taking the backfill's rows.
//
// LOCAL DATABASE ONLY: made-up clients BFTEST_*, made-up leads at
// .bftest.example and made-up imports bftest-..., all removed at the end (and
// any a cut-off run left). It applies 138 (idempotent) and leaves it applied.
// It switches overlap_sharing and database_backfill on for its own clients
// only, writes a made-up stand-in into never_contact_inboxes, and puts the
// three settings back as they were. It refuses to run while the database
// holds share jobs, shares, backfill runs or cursors that are not its own, a
// backfill-worker lease, or a client tagged DATABASE.
//
//   node --env-file=.env.local scripts/test-backfill.mjs
//
// Run it under the shared local-database lock. Nothing reaches a network:
// fetch is refused except the local Supabase API (the Uploads page's query),
// DNS is refused, and the share push gets a stand-in campaign reader. No paid
// key is read. It spawns the cron script once, switched off.
//
//   A. pure: the setting and its save, windows, keys, places, order, caps
//   B. migration 138 applied twice, its after-checks, the back-out rolled back
//   C. candidates read in one and in several windows; the plans
//   D. every reason, one lead each
//   E. firings: off, preview, apply, again, the caps, low places first, the
//      skips, the lease, a time limit, a rules change, a client tagged DATABASE
//   F. the share push takes the backfill's rows
//   G. undo, the actions' refusals, the jobs list, the route, the Uploads page
//   H. the cron script, switched off
//   Z. everything removed, the settings back

import pg from "pg";
import dns from "node:dns";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { settingsFrom } from "./lib/enrich/settings.mjs";
import {
  BACKFILL_DEFAULTS, BACKFILL_LOCK_KEY, BACKFILL_ORIGIN, backfillFrom, backfillOn, cleanDatabaseBackfill,
} from "./lib/backfill/settings.mjs";
import {
  cityIdsOf, orderClients, orderPlaces, passOf, placeKey, placesOf, windowBounds, windowsFor,
} from "./lib/backfill/places.mjs";
import { backfillReasonsSql, candidateSql, countPlace, decideWindow, ownersOf, readWindow, windowStatement } from "./lib/backfill/decide.mjs";
import { acquireLease, backfillOnce, oneLine, releaseLease, roomOf, skipOf, totalsOf } from "./lib/backfill/run.mjs";
import { previewShareJob, applyShareJob, retryShareJob, ShareActionError, undoShareJob } from "./lib/share/actions.mjs";
import { read } from "./lib/share/db.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
for (const k of [
  "OPENAI_API_KEY", "ENRICH_REOON_API_KEY", "REOON_API_KEY", "FINDEMAIL_API_KEY", "ANTHROPIC_API_KEY", "AIARK_API_KEY", "AIARK_WEBHOOK_URL",
  "AIARK_AUTO_ADD_URL", "AIARK_AUTO_ADD_KEY", "FINDYMAIL_API_KEY", "PROSPEO_API_KEY", "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY",
  "ICYPEAS_API_KEY", "EMAILBISON_API_KEY", "EMAILBISON_BASE_URL", "EMAILBISON_KEYS", "SHARE_PUSH_KEY", "SHARE_PUSH_URL",
]) delete process.env[k];

let passed = 0;
let failed = 0;
function ok(name, cond, detail = "") {
  if (cond) passed++;
  else failed++;
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${!cond && detail ? ` : ${String(detail).slice(0, 900)}` : ""}`);
}
const sec = (s) => console.log(`\n${s}`);
const source = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** The same object whatever its key order (jsonb gives keys back in its own order). */
const keysSorted = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, keysSorted(o[k])])) : o);
const sameObj = (a, b) => same(keysSorted(a), keysSorted(b));
const sorted = (xs) => [...xs].sort();
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const RUN = randomUUID().slice(0, 6);
const HOST = "bftest.example";
const FILE = "bftest-"; // every made-up import's file name starts with it
const T = (s) => `BFTEST_${s}`;
const mail = (who) => `${who}-${RUN}@${who.split("-")[0]}-co.${HOST}`;
/** A made-up lead id whose first byte is b: it falls in a known window. */
const idAt = (b) => `${b.toString(16).padStart(2, "0")}${randomUUID().slice(2)}`;
/** The made-up owners of this suite's leases: a cut-off run's lease is recognised and removed. */
const OWNER_1 = "bf000000-0000-4000-8000-000000000001";
const OWNER_2 = "bf000000-0000-4000-8000-000000000002";
const USER = "bf000000-0000-4000-8000-0000000000aa";
const B2B2 = "app.facilityreach.com";
const B2C2 = "personal.outboundclean.com";

// ── No network (the local Supabase API only) ────────────────────────────────

const API = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const apiHost = (() => {
  try {
    return new URL(API).host;
  } catch {
    return "";
  }
})();
const realFetch = globalThis.fetch;
const net = { refused: 0, dns: 0, local: 0 };
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (apiHost && u.host === apiHost && ["127.0.0.1", "localhost"].includes(u.hostname)) {
    net.local++;
    return realFetch(input, init);
  }
  net.refused++;
  throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
};
for (const name of ["resolveMx", "resolve", "resolve4", "resolve6", "resolveAny", "lookup"]) {
  dns.promises[name] = async () => {
    net.dns++;
    throw Object.assign(new Error("DNS refused: this test allows no network"), { code: "ECONNREFUSED" });
  };
}

// ── The routes' TypeScript, compiled as it is imported ──────────────────────

const require = createRequire(import.meta.url);
const pgUrl = pathToFileURL(require.resolve("pg")).href;
const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}`,
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
export async function requireRole(min) {
  const t = globalThis.__bfTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}`,
  "@/lib/enrich/queries": `export async function workerState() { return null; }`,
  "@/lib/db/pool": `import pg from "${pgUrl}";
let p = null;
export function getPool() {
  if (!p) { p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }); globalThis.__bfTest.pools.push(p); }
  return p;
}`,
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
const TS = (globalThis.__bfTest = { role: null, userId: USER, pools: [] });
const srcModule = (p) => import(new URL(p, SRC).href);
const as = (role) => {
  TS.role = role;
};
async function call(handler, { query } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const res = await handler({ nextUrl: new URL(`http://backfill.test/api${qs}`), headers: new Headers() });
  return { status: res.status, body: res.body, headers: res.headers };
}

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0] ?? null;
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const dbOf = (p) => ({ query: (sql, params = []) => read(p, sql, params) });

/** Every row this suite (or a run of it that was cut off) made, removed. Backfill jobs and runs are its own when every receiver is a BFTEST_ client. */
async function cleanup() {
  const mine = `(cardinality(receivers) > 0 AND NOT EXISTS (SELECT 1 FROM unnest(receivers) r WHERE NOT starts_with(r, 'BFTEST_')))`;
  await pool.query(`DELETE FROM push_items WHERE batch_id IN (SELECT id FROM push_batches WHERE starts_with(coalesce(client_tag, ''), 'BFTEST_'))`);
  await pool.query(`DELETE FROM push_batches WHERE starts_with(coalesce(client_tag, ''), 'BFTEST_')`);
  if ((await one(`SELECT to_regclass('public.share_backfill_runs') IS NOT NULL AS ok`)).ok) {
    await pool.query(`DELETE FROM share_backfill_runs WHERE ${mine}`);
    await pool.query(`DELETE FROM share_backfill_cursors WHERE starts_with(receiver_tag, 'BFTEST_')`);
    await pool.query(`DELETE FROM upload_batches WHERE id IN (SELECT batch_id FROM share_jobs WHERE kind = 'backfill' AND ${mine})`);
  }
  await pool.query(`DELETE FROM upload_batches WHERE filename LIKE $1`, [`${FILE}%`]);
  await pool.query(`DELETE FROM lead_shares WHERE starts_with(receiver_tag, 'BFTEST_') OR starts_with(origin_tag, 'BFTEST_')`);
  await pool.query(`DELETE FROM worker_locks WHERE key = $1 AND owner = ANY($2::uuid[])`, [BACKFILL_LOCK_KEY, [OWNER_1, OWNER_2]]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM client_location_coverage WHERE starts_with(client_tag, 'BFTEST_')`);
  await pool.query(`DELETE FROM client_targeting WHERE starts_with(client_tag, 'BFTEST_')`);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, 'BFTEST_')`);
  await pool.query(`DELETE FROM client_tags WHERE tag = $1 AND name = 'made-up bftest marker'`, [BACKFILL_ORIGIN]);
}

const saved = new Map();
async function saveSettings() {
  for (const key of ["overlap_sharing", "database_backfill", "never_contact_inboxes"]) {
    saved.set(key, await one(`SELECT value, updated_by FROM enrich_settings WHERE key = $1`, [key]));
  }
}
async function restoreSettings() {
  for (const [key, row] of saved) {
    if (row) await pool.query(`UPDATE enrich_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1`, [key, JSON.stringify(row.value), row.updated_by]);
    else await pool.query(`DELETE FROM enrich_settings WHERE key = $1`, [key]);
  }
}
const upsertSetting = (key, value) =>
  pool.query(`INSERT INTO enrich_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);

const SINCE = new Date(Date.now() - 5 * 3600_000).toISOString();
let LIST = [];
let PUSH = [];
const setSharing = (patch = {}) =>
  upsertSetting("overlap_sharing", {
    enabled: true, tags: LIST, mode: "preview", pools: { cleaning: ["Cleaning", "Canada Cleaning"] }, isolated_tag_suffixes: ["-OS"], push_tags: PUSH,
    push_every_minutes: 15, push_max_per_job: 1000, push_max_per_day: 2000, held_retry_days: 7, write_tags: false, tag_rows_per_day: 20000, since: SINCE,
    wait_location_minutes: 180, recheck_days: 7, ...patch,
  });
const setBackfill = (patch = {}) =>
  upsertSetting("database_backfill", { enabled: true, tags: [], mode: "preview", max_per_run: 5000, max_minutes: 40, recheck_days: 7, untagged: true, ...patch });
const PATTERN = "bftestbox@|bftest-dept"; // a made-up stand-in, never the Clay original
const setFilter = (on) =>
  upsertSetting(
    "never_contact_inboxes",
    on
      ? { enabled: false, pattern: PATTERN, source: "test-backfill: made-up stand-in", sha256: sha(PATTERN), read_at: new Date().toISOString(), rows_per_day: 5000, chunk_rows: 500 }
      : { enabled: false, pattern: null, source: null, sha256: null, read_at: null, rows_per_day: 5000, chunk_rows: 500 }
  );

const GEO = {};
async function loadGeoIds() {
  const { rows } = await pool.query(
    `SELECT a.state_code || '|' || g.city_key AS k, min(g.geoname_id)::text AS id
       FROM geo_locations g JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
      WHERE g.country_code = 'US' AND (a.state_code, g.city_key) IN (('NV', 'reno'), ('NV', 'sparks'), ('UT', 'provo'), ('WY', 'cheyenne'), ('WY', 'casper'))
      GROUP BY 1`
  );
  for (const r of rows) GEO[r.k] = r.id;
  return ["NV|reno", "NV|sparks", "UT|provo", "WY|cheyenne", "WY|casper"].every((k) => GEO[k]);
}

const NV = (extra = {}) => ({ country: "US", state: "NV", ...extra });
const ST = (state) => ({ country: "US", state });
async function client(s, { status = "Active", group, type = "Cleaning", places, exclude = [], b2b = null, b2c = null, tag = T(s), rules = true } = {}) {
  await pool.query(
    `INSERT INTO client_tags (tag, group_no, status, client_type, on_groups_tab, churn_cell_state, groups_tab_read_at, name, b2b_instance, b2c_instance)
     VALUES ($1, $2, $3, $4, true, 'empty', now(), $5, $6, $7)`,
    [tag, group, status, type, `made-up ${tag.toLowerCase()}`, b2b, b2c]
  );
  if (rules) {
    await pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_terms, require_location, notes)
       VALUES ($1, '{US}', $2::jsonb, $3::text[], true, 'test-backfill: made up')`,
      [tag, JSON.stringify(places), exclude]
    );
  }
  return tag;
}

/** A lead as the location backfill leaves it (placed), unless told otherwise. */
async function lead(who, { city = "Reno", state = "NV", geo = GEO["NV|reno"], status = "resolved", tags = null, type = "personal", company = `${who} Co`,
  validation = "valid", esp = null, bounced = false, suppressed = false, email = mail(who), id = null } = {}) {
  const placed = status === "resolved" || status === "partial";
  const { rows: [r] } = await pool.query(
    `INSERT INTO leads (id, email, company, city, state, state_code, country, country_code, location_status, location_id, tags, email_type,
                        validation_status, esp, is_bounced, is_suppressed)
     VALUES (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, 'USA', $7, $8, $9::bigint, $10, $11, $12, $13, $14, $15)
     RETURNING id::text AS id`,
    [id, email, company, city, state, placed ? state : null, placed ? "US" : null, status, status === "resolved" ? geo : null, tags, type, validation, esp,
      bounced, suppressed]
  );
  return r.id;
}

/** A made-up import of `origin` and its share job (applied), as the share step leaves one. */
async function importJob(slug, origin) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO upload_batches (filename, total_rows, inserted_rows, status, batch_type, field_mapping, add_tags, completed_at)
     VALUES ($1, 1, 1, 'complete', 'leads', '{}'::jsonb, ARRAY[$2], now()) RETURNING id::text AS id`,
    [`${FILE}${RUN}-${slug}.csv`, origin]
  );
  await pool.query(
    `INSERT INTO share_jobs (batch_id, origin_tag, origin_pool, state, topup, mode, batch_done_at, decided_at, applied_at, new_leads)
     VALUES ($1, $2, 'cleaning', 'applied', false, 'apply', now(), now(), now(), 1)`,
    [b.id, origin]
  );
  return b.id;
}
async function share(batch, leadId, receiver, { origin, outcome = "shared", applied = true, push = null, undone = false }) {
  await pool.query(
    `INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, applied_at, push_state, undone_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END, $7, CASE WHEN $8::boolean THEN now() END)`,
    [batch, leadId, origin, receiver, outcome, applied, applied ? push : null, undone]
  );
}
async function pushBatch(tag, { status = "complete", ids = null, items = [] } = {}) {
  const { rows: [b] } = await pool.query(
    `INSERT INTO push_batches (campaigns, client_tag, status, selected_ids) VALUES ('[]'::jsonb, $1, $2, $3::uuid[]) RETURNING id::text AS id`,
    [tag, status, ids]
  );
  for (const [leadId, st] of items) await pool.query(`INSERT INTO push_items (batch_id, lead_id, email, status) VALUES ($1, $2, 'x', $3)`, [b.id, leadId, st]);
  return b.id;
}
async function coverage(tag, locations) {
  await pool.query(
    `INSERT INTO client_location_coverage (client_tag, threshold, total_available, payload, computed_at)
     VALUES ($1, 500, 0, $2::jsonb, now())
     ON CONFLICT (client_tag) DO UPDATE SET payload = EXCLUDED.payload, computed_at = now()`,
    [tag, JSON.stringify({ tag, threshold: 500, locations })]
  );
}

/** What the backfill has written, in counts. */
const state = () =>
  one(`SELECT (SELECT count(*) FROM share_backfill_runs)::int AS runs, (SELECT count(*) FROM share_backfill_cursors)::int AS cursors,
              (SELECT coalesce(max(updated_at)::text, '') FROM share_backfill_cursors) AS cursor_at,
              (SELECT count(*) FROM upload_batches WHERE batch_type = 'backfill')::int AS batches,
              (SELECT count(*) FROM share_jobs WHERE kind = 'backfill')::int AS jobs,
              (SELECT count(*) FROM lead_shares)::int AS shares,
              (SELECT count(*) FROM worker_locks WHERE key = '${BACKFILL_LOCK_KEY}')::int AS locks`);
const logs = [];
const fire = (o = {}) => backfillOnce(pool, { log: (l) => logs.push(l), ...o });
const runRow = (id) => one(`SELECT * FROM share_backfill_runs WHERE id = $1`, [id]);
const cursorOf = (tag, key) => one(`SELECT * FROM share_backfill_cursors WHERE receiver_tag = $1 AND place_key = $2`, [tag, key]);
const sharesOf = (tag, batchId = null) =>
  all(`SELECT lead_id::text AS lead_id, outcome, matched_place, applied_at, applied_by, push_state, push_note, undone_at, origin_tag, batch_id::text AS batch_id
         FROM lead_shares WHERE receiver_tag = $1 AND origin_tag = '${BACKFILL_ORIGIN}' AND ($2::uuid IS NULL OR batch_id = $2) ORDER BY lead_id`, [tag, batchId]);

// The suite's made-up clients and their leads.
const A = T("RX"); // a receiver: Reno (a city) and Utah (state-wide); its group mate C; an exclusion term
const B = T("B"); // a second receiver: Sparks
const C = T("C"); // A's Bison group mate (Nevada): its pushes, shares and tag keep leads back from A
const O = T("O"); // another client of the pool (Wyoming): its leads may go to A
const XOS = T("X-OS"); // isolated by its tag ending: its leads go to no one
const N = T("N"); // isolated by its type
const P = T("P"); // Paused: cannot receive
const F = T("F"); // off the push list (Idaho)
const K1 = T("K1"); // the cap a client a firing (Montana)
const K2 = T("K2"); // the cap a client a day (North Dakota)
const R1 = T("R1"); // the cap a firing, not low (South Dakota)
const R2 = T("R2"); // the cap a firing, low (Nebraska)
const L = T("L"); // low places first: Kansas (enough), Oklahoma (low)
const TIME = T("TIME"); // a time limit and a rules change (Oregon)
const NONE = T("NONE"); // listed, but no client
const ctx = {}; // what later parts need

async function setup() {
  await client("RX", { group: 8801, places: [NV({ city: "Reno" }), ST("UT")], exclude: ["Bftestvending"], b2b: B2B2, b2c: B2C2 });
  await client("B", { group: 8802, places: [NV({ city: "Sparks" })] });
  await client("C", { group: 8801, places: [NV()] });
  await client("O", { group: 8803, places: [ST("WY")] });
  await client("X-OS", { group: 8804, places: [ST("WY")] });
  await client("N", { group: 8805, type: "Non-Cleaning", places: [ST("ID")] });
  await client("P", { group: 8806, status: "Paused", places: [ST("ID")] });
  await client("F", { group: 8807, places: [ST("ID")] });
  await client("K1", { group: 8810, places: [ST("MT")] });
  await client("K2", { group: 8811, places: [ST("ND")] });
  await client("R1", { group: 8812, places: [ST("SD")] });
  await client("R2", { group: 8813, places: [ST("NE")] });
  await client("L", { group: 8814, places: [ST("KS"), ST("OK")] });
  await client("TIME", { group: 8815, places: [ST("OR")] });
  LIST = [A, B, C, O, XOS, N, P, F, K1, K2, R1, R2, L, TIME];
  PUSH = LIST.filter((t) => t !== F);
  await setSharing();
  await setFilter(true);
}

// ── A. Pure ─────────────────────────────────────────────────────────────────

async function partA() {
  sec("A. Pure: the setting and its save, windows, keys, places, order, caps");
  const d = backfillFrom([]);
  ok("no row: the defaults, switched off", same(d, { enabled: false, tags: [], mode: "preview", max_per_run: 5000, max_minutes: 40, recheck_days: 7, untagged: true }), JSON.stringify(d));
  const seeded = JSON.parse(/'(\{"enabled": false[^']*\})'::jsonb/.exec(source("supabase/migrations/138_database_backfill.sql").replace(/\s+/g, " "))?.[1] ?? "null");
  ok("... the same as 138 seeds it", same(backfillFrom([{ key: "database_backfill", value: seeded }]), d) && same({ ...BACKFILL_DEFAULTS, tags: [...BACKFILL_DEFAULTS.tags] }, d));
  const odd = backfillFrom([{ key: "database_backfill", value: { enabled: "true", tags: [" bftest_a ", "BFTEST_A", "*", 7, ""], mode: "APPLY", max_per_run: 0, max_minutes: 51, recheck_days: 90, untagged: "no" } }]);
  ok("field by field: enabled only when true, tags trimmed, upper case, once each, mode apply only exactly, a value out of range or of the wrong type its default",
    same(odd, { enabled: false, tags: ["BFTEST_A"], mode: "preview", max_per_run: 5000, max_minutes: 40, recheck_days: 90, untagged: true }), JSON.stringify(odd));
  const on = backfillFrom({ enabled: true, tags: ["bftest_b"], mode: "apply", max_per_run: 50_000, max_minutes: 5, recheck_days: 1, untagged: false });
  ok("... values at the ends of their ranges kept (the value itself read too)", same(on, { enabled: true, tags: ["BFTEST_B"], mode: "apply", max_per_run: 50_000, max_minutes: 5, recheck_days: 1, untagged: false }));
  ok("backfillOn: switched on and the client listed, any case", backfillOn(on, " bftest_b ") && !backfillOn(on, "BFTEST_A") && !backfillOn(odd, "BFTEST_A") && !backfillOn(on, ""));

  const good = cleanDatabaseBackfill({ enabled: true, tags: ["bftest_a", " BFTEST_A "], mode: "apply", max_per_run: 100, max_minutes: 10, recheck_days: 3, untagged: false });
  ok("the save: a good value taken, tags upper case once each", good.error === null &&
    same(good.value, { enabled: true, tags: ["BFTEST_A"], mode: "apply", max_per_run: 100, max_minutes: 10, recheck_days: 3, untagged: false }), JSON.stringify(good));
  const bad = cleanDatabaseBackfill({ enabled: "yes", tags: ["not a tag!"], mode: "always", max_per_run: 50_001, max_minutes: 4, recheck_days: 0, untagged: 1 });
  ok("... every bad field refused with its reason, never quietly replaced", bad.value === null && bad.errors.length === 7 &&
    /from 1 to 50,000/.test(bad.error) && /from 5 to 50/.test(bad.error) && /from 1 to 90/.test(bad.error) && /preview or apply/.test(bad.error) &&
    /is not a client tag/.test(bad.error), JSON.stringify(bad.errors));
  const kept = cleanDatabaseBackfill({ enabled: false }, { previous: on });
  ok("... a field left out keeps its stored value", same(kept.value, { ...on, enabled: false }), JSON.stringify(kept));
  ok("... not an object: refused", cleanDatabaseBackfill(null).value === null && cleanDatabaseBackfill([]).errors.length === 1);

  const want = [[0, 1], [50_000, 1], [50_001, 4], [100_000, 4], [100_001, 8], [800_000, 32], [800_001, 64], [6_400_000, 256], [1e9, 256], [null, 1]];
  ok("windowsFor: one window to 50,000 leads, else the smallest power of two with at most 25,000 a window, at most 256",
    want.every(([n, w]) => windowsFor(n) === w), JSON.stringify(want.map(([n]) => windowsFor(n))));
  const holes = [];
  for (let w = 1; w <= 256; w *= 2) {
    const b = Array.from({ length: w }, (_, i) => windowBounds(w, i));
    if (w === 1) {
      if (b[0].lo !== null || b[0].hi !== null) holes.push("1: has bounds");
      continue;
    }
    if (b[0].lo !== "00000000-0000-0000-0000-000000000000") holes.push(`${w}: first lo ${b[0].lo}`);
    if (b[w - 1].hi !== null) holes.push(`${w}: last hi`);
    for (let i = 0; i + 1 < w; i++) if (b[i].hi !== b[i + 1].lo || !(b[i].lo < b[i].hi)) holes.push(`${w}: window ${i}`);
    for (const id of [...Array.from({ length: 200 }, () => randomUUID()), "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff"]) {
      const n = b.filter((x) => id >= x.lo && (x.hi == null || id < x.hi)).length;
      if (n !== 1) holes.push(`${w}: ${id} in ${n}`);
    }
  }
  ok("windowBounds: for 1 to 256 windows the bounds cover the uuid space with no gap and no overlap", holes.length === 0, holes.slice(0, 5).join("; "));
  let threw = 0;
  for (const [w, i] of [[3, 0], [512, 0], [4, 4], [4, -1]]) {
    try {
      windowBounds(w, i);
    } catch {
      threw++;
    }
  }
  ok("... and refuses a window count that is no power of two up to 256, or a window that does not exist", threw === 4);

  ok("placeKey: a city reduced to letters, as the top-up keys places", placeKey({ country: "us", state: "tx", city: "San Antonio" }) === "US|TX|sanantonio" &&
    placeKey({ country: "US", state: "TX" }) === "US|TX" && placeKey({ country: "US", state: "TX", city: "  " }) === "US|TX");
  const ids = new Map([["BFTEST_Q|1", new Set(["2", "1"])]]);
  const pl = placesOf("BFTEST_Q", [NV({ city: "Reno" }), NV({ city: "Nowhere" }), ST("ut"), { country: "US" }, ST("UT"), "junk", { state: "NV" }], ids);
  ok("placesOf: a resolved city with its ids, a state, the unknown city apart; no country-wide, duplicate or malformed entry",
    same(pl.places.map((p) => [p.key, p.kind, p.label, p.ids, p.entry]), [["US|NV|reno", "city", "Reno, NV", ["1", "2"], 1], ["US|UT", "state", "UT (state-wide)", null, 3]]) &&
      same(pl.unresolved, [{ key: "US|NV|nowhere", label: "Nowhere, NV", entry: 2 }]), JSON.stringify(pl));
  const P0 = (st, entry) => ({ key: `US|${st}`, kind: "state", country: "US", state: st, city: null, label: st, ids: null, entry });
  const cov = new Map([["US|X1", 900], ["US|X2", 10], ["US|X3", 300], ["US|X4", 50]]);
  const ranked = orderPlaces([P0("X5", 1), P0("X1", 2), P0("X2", 3), P0("X6", 4), P0("X3", 5), P0("X4", 6)], cov, 100);
  ok("orderPlaces: under the minimum first (fewest first), then the rest (fewest first), then the uncounted in entry order",
    same(ranked.map((p) => [p.state, p.low]), [["X2", true], ["X4", true], ["X3", false], ["X1", false], ["X5", false], ["X6", false]]), JSON.stringify(ranked.map((p) => p.state)));
  const oc = orderClients([
    { tag: "D", lowPlaces: 0, servedAt: 5 }, { tag: "C", lowPlaces: 0, servedAt: null }, { tag: "B", lowPlaces: 2, servedAt: 100 },
    { tag: "A", lowPlaces: 0, servedAt: 5 }, { tag: "E", lowPlaces: 1, servedAt: null },
  ]);
  ok("orderClients: a low place first, then the least recently served (never first), then tag order", same(oc.map((c) => c.tag), ["E", "B", "C", "A", "D"]));
  ok("passOf: new, a rules change, a done pass to read again, a fresh done pass, carrying on",
    passOf(null) === "new" && passOf({ rules_changed: true, next_window: 4, windows: 4 }) === "rules" &&
      passOf({ rules_changed: false, next_window: 4, windows: 4, recheck_due: true }) === "recheck" &&
      passOf({ rules_changed: false, next_window: 4, windows: 4, recheck_due: false }) === "done" && passOf({ rules_changed: false, next_window: 1, windows: 4 }) === "continue");
  const owners = ownersOf("Outlook, bftest_a ,BFTEST_A,BFTEST_NOPE", new Map([["BFTEST_A", {}]]));
  ok("ownersOf: the lead's tags that are clients, once each, any case", same(owners, ["BFTEST_A"]) && ownersOf(null, new Map()).length === 0);
  ok("roomOf: the smallest room binds, a tie goes to the firing's cap, then the day's",
    same(roomOf({ job: 5, day: 3, run: 3 }), { room: 3, cap: "run_total" }) && same(roomOf({ job: 2, day: 3, run: 9 }), { room: 2, cap: "run" }) &&
      same(roomOf({ job: 4, day: -1, run: 9 }), { room: 0, cap: "day" }));
  const tot = totalsOf({ X: { checked: 3, fits: 2, shared: 2, capped: "run" }, Y: { skipped: "isolated" }, Z: { not_reached: "time" }, W: { error: "boom" } });
  ok("totalsOf: served, skipped, not reached, capped and failed clients, and the counts added up",
    tot.clients === 4 && tot.served === 2 && tot.skipped === 1 && tot.not_reached === 1 && tot.capped === 1 && tot.errors === 1 && tot.checked === 3 && tot.shared === 2, JSON.stringify(tot));
  ok("oneLine: one line, no email address, at most 300 characters", oneLine(new Error(`a\nb for someone-${RUN}@x.${HOST} c`)) === "a b for <email> c" &&
    oneLine("x".repeat(400)).length === 300);
  const both = candidateSql({ city: false, bounds: "both" });
  const lower = candidateSql({ city: true, bounds: "lower" });
  const none = candidateSql({ city: false, bounds: "none" });
  ok("the window statement's three texts: both bounds, the lower one, none; never a null test on a bound",
    /l\.id >= \$3::uuid AND l\.id < \$4::uuid/.test(both) && /fn_regex_escape\(\$5\)/.test(both) && /l\.id >= \$2::uuid/.test(lower) && !/l\.id </.test(lower) &&
      /fn_regex_escape\(\$3\)/.test(lower) && !/l\.id >=/.test(none) && /fn_regex_escape\(\$3\)/.test(none) && ![both, lower, none].some((s) => /\$\d+(::\w+)? IS NULL/.test(s)) &&
      ![both, lower, none].some((s) => /ORDER BY|LIMIT/.test(s)));
  const st = windowStatement({ kind: "state", state: "UT", country: "US" }, windowBounds(4, 3), "BFTEST_Z");
  ok("... the parameters in their places", same(st.params, ["UT", "US", "c0000000-0000-0000-0000-000000000000", "BFTEST_Z"]));
  const facts = (o) => ({ tag: "X", receiver: { block: null }, places: [{}], pool: "cleaning", pushList: true, onList: true, ...o });
  ok("skipOf: not a client, off the list, cannot receive, isolated, off the push list (apply only), no places",
    skipOf(facts({ receiver: null }), { mode: "apply" }) === "not a client" && skipOf(facts({ onList: false }), { mode: "apply" }) === "not on the backfill list" &&
      skipOf(facts({ onList: false }), { mode: "preview" }) === null && skipOf(facts({ receiver: { block: "status Paused" } }), { mode: "apply" }) === "cannot receive: status Paused" &&
      skipOf(facts({ pool: null }), { mode: "apply" }) === "isolated" && skipOf(facts({ pushList: false }), { mode: "apply" }) === "not on the push list" &&
      skipOf(facts({ pushList: false }), { mode: "preview" }) === null && skipOf(facts({ places: [] }), { mode: "apply" }) === "no places");
  const asked = [];
  const no138 = { query: async (sql) => (asked.push(sql), { rows: [{ ok: false }] }), connect: async () => { throw new Error("no connection may be taken"); } };
  const nr = await backfillOnce(no138, {});
  ok("a database without 138: the firing says so and runs one statement only", nr.state === "not_ready" && nr.ready === false && asked.length === 1);
}

// ── B. Migration 138 ────────────────────────────────────────────────────────

const SNAP_SQL = `
  SELECT 'con' AS k, conname AS n, oid::text AS o, pg_get_constraintdef(oid) AS d FROM pg_constraint
   WHERE conrelid IN ('public.upload_batches'::regclass, 'public.share_jobs'::regclass)
     AND conname IN ('upload_batches_batch_type_check', 'share_jobs_kind_check')
  UNION ALL SELECT 'rel', relname, oid::text, relrowsecurity::text FROM pg_class
   WHERE relname IN ('share_backfill_runs', 'share_backfill_cursors', 'share_jobs_backfill_idx', 'share_backfill_runs_recent_idx')
  UNION ALL SELECT 'trg', tgname, oid::text, '' FROM pg_trigger WHERE tgname = 'trg_share_backfill_cursors_updated_at'
  UNION ALL SELECT 'col', column_name, ordinal_position::text, column_default || ' ' || is_nullable FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'share_jobs' AND column_name = 'kind'
  UNION ALL SELECT 'set', key, updated_at::text, value::text FROM enrich_settings WHERE key = 'database_backfill'
  UNION ALL SELECT 'acl', relname, '', coalesce(relacl::text, '') FROM pg_class WHERE relname IN ('share_backfill_runs', 'share_backfill_cursors')
  ORDER BY 1, 2`;

async function partB() {
  sec("B. Migration 138: applied twice, its after-checks, the back-out rolled back");
  const file = source("supabase/migrations/138_database_backfill.sql");
  const c = await pool.connect();
  try {
    await c.query(file);
    const s1 = (await c.query(SNAP_SQL)).rows;
    await c.query(file);
    const s2 = (await c.query(SNAP_SQL)).rows;
    ok("applied twice: the second run changes nothing (the same objects, oids, rights and setting)", s1.length === 11 && same(s1, s2), JSON.stringify({ n: s1.length }));
    const o = (await c.query(
      `SELECT bool_and((SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass)) AS rls,
              bool_or(has_table_privilege('anon', 'public.' || t, 'SELECT') OR has_table_privilege('authenticated', 'public.' || t, 'SELECT')) AS readable,
              (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'upload_batches_batch_type_check') AS batch_type,
              (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'share_jobs_kind_check') AS kind,
              (SELECT column_default || ' ' || is_nullable FROM information_schema.columns WHERE table_name = 'share_jobs' AND column_name = 'kind') AS kind_col,
              (SELECT pg_get_indexdef('public.share_jobs_backfill_idx'::regclass)) AS idx,
              (SELECT value FROM enrich_settings WHERE key = 'database_backfill') AS setting
         FROM unnest(ARRAY['share_backfill_runs', 'share_backfill_cursors']) t`
    )).rows[0];
    ok("its after-checks hold: both tables server-only (RLS on, no anon or authenticated read), the batch type takes backfill, kind defaults to import",
      o.rls === true && o.readable === false && /'leads'.*'bounces'.*'backfill'/.test(o.batch_type) && /'import'.*'backfill'/.test(o.kind) &&
        o.kind_col === "'import'::text NO" && /WHERE \(kind = 'backfill'::text\)/.test(o.idx), JSON.stringify(o));
    ok("... and the switch is there (138 seeds it off; this database's value is kept)", o.setting && typeof o.setting === "object" && "enabled" in o.setting);
    // The back-out exactly as the file's comment says it, in a transaction that is rolled back.
    const lines = file.split("\n");
    const at = lines.findIndex((l) => l.startsWith("-- Back-out"));
    const backout = [];
    for (const l of lines.slice(at + 1)) {
      const m = /^--\s{3}(\S.*;)$/.exec(l);
      if (!m) continue;
      if (/^(BEGIN|COMMIT);$/.test(m[1])) continue;
      if (/^\(|DELETE FROM upload_batches/.test(m[1])) continue;
      backout.push(m[1]);
    }
    await c.query("BEGIN");
    let inside = null;
    try {
      for (const stmt of backout) await c.query(stmt);
      inside = (await c.query(
        `SELECT to_regclass('public.share_backfill_runs') IS NULL AND to_regclass('public.share_backfill_cursors') IS NULL AS gone,
                NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'share_jobs' AND column_name = 'kind') AS no_kind,
                (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'upload_batches_batch_type_check') AS batch_type,
                NOT EXISTS (SELECT 1 FROM enrich_settings WHERE key = 'database_backfill') AS no_setting`
      )).rows[0];
    } finally {
      await c.query("ROLLBACK");
    }
    ok("the back-out as written: both tables, the kind, the index and the setting gone, the batch type check as before 138",
      backout.length === 7 && inside?.gone && inside?.no_kind && inside?.no_setting && !/backfill/.test(inside?.batch_type ?? "backfill"), JSON.stringify({ n: backout.length, inside }));
    ok("... rolled back: 138 as it was", same((await c.query(SNAP_SQL)).rows, s1));
  } finally {
    c.release();
  }
}

// ── C. Candidates and plans ─────────────────────────────────────────────────

function planNodes(plan) {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    out.push(n);
    for (const k of n.Plans ?? []) walk(k);
  };
  walk(plan[0].Plan);
  return out;
}
/** A plan with the small-table shortcuts off (as scripts/test-sharing.mjs reads them): what the planner does on 9.8M leads. */
async function explain(sql, params, { bitmap = false } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const off = bitmap ? ["enable_seqscan", "enable_indexscan", "enable_indexonlyscan"] : ["enable_seqscan", "enable_bitmapscan", "enable_hashjoin", "enable_mergejoin"];
    for (const k of off) await c.query(`SET LOCAL ${k} = off`);
    const { rows: [r] } = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return planNodes(r["QUERY PLAN"]);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}
const show = (nodes) => JSON.stringify(nodes.map((x) => [x["Node Type"], x["Relation Name"], x["Index Name"], x["Index Cond"]]));
const BIG = new Set(["leads", "lead_shares", "push_items", "upload_batch_leads", "lead_history"]);
const scans = (nodes) => nodes.filter((x) => x["Node Type"] === "Seq Scan" && BIG.has(x["Relation Name"])).map((x) => x["Relation Name"]);

async function partC() {
  sec("C. Candidates read in one window and in several give the same set; the plans");
  const reno = [];
  const utah = [];
  for (let i = 1; i <= 30; i++) reno.push(await lead(`cr${i}`));
  for (let i = 1; i <= 30; i++) utah.push(await lead(`cu${i}`, { city: "Provo", state: "UT", geo: GEO["UT|provo"] }));
  // Not candidates: A's own tag, not contactable, no usable place, another city or state.
  await lead("cx-own", { tags: `Outlook, ${A.toLowerCase()}` });
  await lead("cx-bounced", { bounced: true });
  await lead("cx-suppressed", { suppressed: true });
  await lead("cx-invalid", { validation: "invalid" });
  await lead("cx-noplace", { status: "unresolved" });
  await lead("cx-mime", { esp: "Mimecast" });
  ctx.cxSparks = await lead("cx-sparks", { city: "Sparks", geo: GEO["NV|sparks"] });
  await lead("cx-wy", { city: "Cheyenne", state: "WY", geo: GEO["WY|cheyenne"] });
  const geoIds = await cityIdsOf(dbOf(pool), [A]);
  const { places } = placesOf(A, [NV({ city: "Reno" }), ST("UT")], geoIds);
  const renoPlace = places.find((p) => p.kind === "city");
  const utahPlace = places.find((p) => p.kind === "state");
  ctx.places = { reno: renoPlace, utah: utahPlace };
  ctx.lead = { reno, utah };
  const readAll = async (place, w) => {
    const ids = new Set();
    for (let i = 0; i < w; i++) for (const r of await readWindow(pool, { place, bounds: windowBounds(w, i), receiver: A })) ids.add(r.id);
    return ids;
  };
  for (const [name, place, expected] of [["the city place (Reno)", renoPlace, reno], ["the state place (Utah)", utahPlace, utah]]) {
    const one1 = await readAll(place, 1);
    const sets = [];
    for (const w of [2, 16, 256]) sets.push(await readAll(place, w));
    ok(`${name}: one window reads exactly its contactable leads, never one carrying the receiver's tag`, same(sorted(one1), sorted(expected)), `${one1.size} of ${expected.length}`);
    ok(`... and 2, 16 or 256 windows read the same set`, sets.every((s) => same(sorted(s), sorted(one1))), JSON.stringify(sets.map((s) => s.size)));
  }
  const n = await countPlace(pool, renoPlace);
  const u = await countPlace(pool, utahPlace);
  ok("a place's count for its pass: every lead there, contactable or not (index only)", n === 30 + 5 && u === 30, JSON.stringify({ n, u }));
  const { rows: [sq] } = await pool.query(
    `WITH ids AS (SELECT gen_random_uuid() AS id FROM generate_series(1, 300)),
          w AS (SELECT i, $1::text[] AS lo, $2::text[] AS hi FROM generate_series(1, 16) i)
     SELECT count(*) FILTER (WHERE n <> 1)::int AS bad FROM (
       SELECT ids.id, (SELECT count(*) FROM w WHERE ids.id >= (w.lo)[w.i]::uuid AND (w.hi[w.i] IS NULL OR ids.id < (w.hi)[w.i]::uuid)) AS n FROM ids) x`,
    [Array.from({ length: 16 }, (_, i) => windowBounds(16, i).lo), Array.from({ length: 16 }, (_, i) => windowBounds(16, i).hi)]
  );
  ok("... in SQL too, every uuid falls in exactly one of 16 windows (Postgres orders uuids as their text)", sq.bad === 0, JSON.stringify(sq));

  // The plans as the production table would get them: 10,000 made-up filler leads elsewhere, the statistics refreshed.
  await pool.query(
    `INSERT INTO leads (email, company, city, state, state_code, country, country_code, location_status, location_id, email_type, validation_status)
     SELECT 'qf' || g || '-' || $1 || '@qf-co.' || $2, 'Filler Co ' || g, CASE WHEN g % 2 = 0 THEN 'Cheyenne' ELSE 'Casper' END, 'WY', 'WY', 'USA', 'US',
            'resolved', (CASE WHEN g % 2 = 0 THEN $3 ELSE $4 END)::bigint, 'personal', 'valid'
       FROM generate_series(1, 10000) g`,
    [RUN, HOST, GEO["WY|cheyenne"], GEO["WY|casper"]]
  );
  await pool.query(`ANALYZE public.leads, public.lead_shares, public.push_items, public.push_batches`);
  const usesIndex = (nodes, index) => nodes.some((x) => x["Index Name"] === index);
  for (const [label, place, index] of [["a state place", utahPlace, "idx_leads_state_code"], ["a city place", renoPlace, "idx_leads_location_id"]]) {
    for (const [what, w, i] of [["one window (no bounds)", 1, 0], ["a middle window", 4, 1], ["the last window", 4, 3]]) {
      const st = windowStatement(place, windowBounds(w, i), A);
      const plain = await explain(st.sql, st.params);
      const bitmap = await explain(st.sql, st.params, { bitmap: true });
      ok(`EXPLAIN of ${label}'s window statement, ${what}: ${index}, no scan of leads (index paths and bitmap paths)`,
        usesIndex(plain, index) && usesIndex(bitmap, index) && scans(plain).length === 0 && scans(bitmap).length === 0, `${show(plain)} ${show(bitmap)}`);
    }
  }
  const ids = [...reno, ...Array.from({ length: 1970 }, () => randomUUID())];
  const rp = await explain(backfillReasonsSql(true), [ids, A, 8801, PATTERN]);
  const usesPk = rp.some((x) => x["Index Name"] === "leads_pkey" && /\bid\b/.test(x["Index Cond"] ?? ""));
  const byIndex = (rel) => rp.some((x) => x["Relation Name"] === rel && x["Index Name"]) && !rp.some((x) => x["Relation Name"] === rel && !x["Index Name"]);
  ok("EXPLAIN of the reasons statement (2,000 ids): anchored on the ids (leads by key), push_items and lead_shares by an index, no scan of a big table",
    usesPk && scans(rp).length === 0 && byIndex("push_items") && byIndex("lead_shares"), show(rp));
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`qf%-${RUN}@qf-co.${HOST}`]);
  await pool.query(`ANALYZE public.leads`);
}

// ── D. Reasons ──────────────────────────────────────────────────────────────

async function decideCtx({ untagged = true, filter = true } = {}) {
  const rows = await all(`SELECT key, value FROM enrich_settings`);
  const settings = settingsFrom(rows);
  const clients = new Map((await all(`SELECT tag, client_type, group_no FROM client_tags`)).map((r) => [r.tag, r]));
  return { settings, untagged, clients, pattern: filter ? settings.never_contact_inboxes.pattern : null, geoIds: await cityIdsOf(dbOf(pool), [A]) };
}
const receiverA = async () => {
  const r = await one(`SELECT ct.tag, ct.client_type, ct.group_no, t.include_locations FROM client_tags ct JOIN client_targeting t ON t.client_tag = ct.tag WHERE ct.tag = $1`, [A]);
  return { ...r, include_locations: r.include_locations };
};

async function partD() {
  sec("D. Every reason, one lead each (A: Reno and Utah, group mate C)");
  const L0 = {};
  L0.shared = await lead("d-shared");
  L0.filtered = await lead("d-filtered", { type: "general", email: `${RUN}bftestbox@df-co.${HOST}` });
  L0.sent = await lead("d-sent");
  L0.inflightItem = await lead("d-inflight1");
  L0.inflightLive = await lead("d-inflight2");
  L0.applied = await lead("d-applied");
  L0.undone = await lead("d-undone");
  L0.alsoFits = await lead("d-alsofits");
  L0.otherPool = await lead("d-otherpool", { tags: XOS });
  L0.groupItem = await lead("d-groupitem");
  L0.groupShare = await lead("d-groupshare");
  L0.groupOwner = await lead("d-groupowner", { tags: C });
  L0.samePool = await lead("d-samepool", { tags: `Outlook,${O}` });
  L0.noFit = await lead("d-nofit", { company: "Bftestvending Supply" });
  ctx.d = L0;
  await pushBatch(A, { status: "complete", items: [[L0.sent, "sent"]] });
  await pushBatch(A, { status: "gathering", items: [[L0.inflightItem, "pending"]] });
  await pushBatch(A, { status: "pending", ids: [L0.inflightLive] });
  await pushBatch(C, { status: "complete", items: [[L0.groupItem, "sent"]] });
  const imp = await importJob("d-import", O);
  ctx.importJob = imp;
  await share(imp, L0.applied, A, { origin: O });
  await share(imp, L0.undone, A, { origin: O, undone: true });
  await share(imp, L0.alsoFits, A, { origin: O, outcome: "also_fits", applied: false });
  await share(imp, L0.groupShare, C, { origin: O, push: "queued" });

  const receiver = await receiverA();
  const rows = await readWindow(pool, { place: ctx.places.reno, bounds: windowBounds(1, 0), receiver: A });
  const dec = await decideWindow(pool, { receiver, rows, ctx: await decideCtx() });
  const of = (id) => dec.outcomes.get(id);
  ok("an untagged lead that fits and has no reason: shared, with the city entry it matched",
    of(L0.shared) === "shared" && same(dec.shared.find((s) => s.id === L0.shared)?.place, { country: "US", state: "NV", city: "Reno", label: "Reno, NV" }));
  ok("filtered_inbox: a general inbox the (made-up stand-in) filter matches", of(L0.filtered) === "filtered_inbox", of(L0.filtered));
  ok("already_sent: an item sent in a push for the receiver", of(L0.sent) === "already_sent", of(L0.sent));
  ok("in_flight: an item pending in a push being gathered, and a live push's selected ids", of(L0.inflightItem) === "in_flight" && of(L0.inflightLive) === "in_flight");
  ok("already_shared: any earlier share row for the receiver, applied, undone, or also_fits", of(L0.applied) === "already_shared" && of(L0.undone) === "already_shared" &&
    of(L0.alsoFits) === "already_shared", JSON.stringify([of(L0.applied), of(L0.undone), of(L0.alsoFits)]));
  ok("other_pool: a lead carrying an isolated client's tag", of(L0.otherPool) === "other_pool", of(L0.otherPool));
  ok("same_install: a group mate's push item, a live share to a group mate, a lead tagged with a group mate whose rules it fits",
    of(L0.groupItem) === "same_install" && of(L0.groupShare) === "same_install" && of(L0.groupOwner) === "same_install",
    JSON.stringify([of(L0.groupItem), of(L0.groupShare), of(L0.groupOwner)]));
  ok("a lead of another client of the same pool (another group): shared", of(L0.samePool) === "shared", of(L0.samePool));
  ok("a lead outside the receiver's rules (its exclusion term): no outcome, it does not fit", of(L0.noFit) === undefined && !dec.shared.some((s) => s.id === L0.noFit));
  ok("C's 30 Reno leads: all shared, in id order", ctx.lead.reno.every((id) => of(id) === "shared") &&
    same(dec.shared.map((s) => s.id), sorted(dec.shared.map((s) => s.id))));
  ok("the counts add up: checked, fits, the reasons and the shares", dec.checked === rows.length && dec.fits === dec.outcomes.size &&
    dec.shared.length + Object.values(dec.reasons).reduce((a, b) => a + b, 0) === dec.fits, JSON.stringify({ checked: dec.checked, fits: dec.fits, reasons: dec.reasons }));
  ctx.renoShared = dec.shared.length;
  const off = await decideWindow(pool, { receiver, rows, ctx: await decideCtx({ untagged: false }) });
  ok("untagged leads off: the untagged lead is untagged_off, a lead of the pool's other client still shared",
    off.outcomes.get(L0.shared) === "untagged_off" && off.outcomes.get(L0.samePool) === "shared" && off.reasons.untagged_off === 40, JSON.stringify(off.reasons));
  const seen = await decideWindow(pool, { receiver, rows, ctx: await decideCtx(), seen: new Set([L0.shared]) });
  ok("a lead this firing already took: already_shared", seen.outcomes.get(L0.shared) === "already_shared");
  const nf = await decideWindow(pool, { receiver, rows, ctx: await decideCtx({ filter: false }) });
  ok("with no filter loaded, the general inbox is not left out", nf.outcomes.get(L0.filtered) === "shared");
}

// ── E. Firings ──────────────────────────────────────────────────────────────

async function partE() {
  sec("E. Firings");
  // Off.
  await setBackfill({ enabled: false, tags: [A, B], mode: "apply" });
  const s0 = await state();
  const off = await fire();
  ok("switched off (as shipped): the firing answers off and writes nothing", off.state === "off" && off.run === null && same(await state(), s0), JSON.stringify(off));

  // B's leads in Sparks (with part C's one there).
  ctx.lead.sparks = [ctx.cxSparks];
  for (let i = 1; i <= 5; i++) ctx.lead.sparks.push(await lead(`es${i}`, { city: "Sparks", geo: GEO["NV|sparks"] }));
  const nB = ctx.lead.sparks.length;

  // Preview.
  await setBackfill({ enabled: true, tags: [A, B], mode: "preview" });
  const p = await fire();
  const pr = await runRow(p.run);
  const s1 = await state();
  const expectA = ctx.renoShared + ctx.lead.utah.length;
  ok("preview: one run row (preview, done, no job), no cursor, no batch, job or share",
    p.state === "done" && pr.mode === "preview" && pr.state === "done" && pr.batch_id === null && s1.runs === s0.runs + 1 && s1.cursors === s0.cursors &&
      s1.batches === s0.batches && s1.jobs === s0.jobs && s1.shares === s0.shares, JSON.stringify({ s0, s1 }));
  ok("... its counts: A would share its Reno and Utah leads with no reason, B its Sparks leads", pr.counts[A]?.would_share === expectA && pr.counts[B]?.would_share === nB &&
    pr.counts[A].already_sent === 1 && pr.counts[A].same_install === 3 && pr.counts[A].places === 2, JSON.stringify(pr.counts));

  // Apply.
  await setBackfill({ enabled: true, tags: [A, B], mode: "apply" });
  const a = await fire();
  const ar = await runRow(a.run);
  const job = await one(
    `SELECT j.*, b.batch_type, b.status AS b_status, b.source_label, b.filename, b.field_mapping, b.uploaded_by FROM share_jobs j JOIN upload_batches b ON b.id = j.batch_id
      WHERE j.batch_id = $1`,
    [ar?.batch_id ?? null]
  );
  ctx.jobE3 = ar?.batch_id ?? null;
  const rowsA = await sharesOf(A, ctx.jobE3);
  const rowsB = await sharesOf(B, ctx.jobE3);
  ok("apply: the run (apply, done) names its share job", a.state === "done" && ar.mode === "apply" && ar.state === "done" && Boolean(job), JSON.stringify({ a, ar: ar?.state }));
  ok("... one batch of type backfill: complete, labelled Database backfill, no file, no field mapping, no uploader",
    job?.batch_type === "backfill" && job.b_status === "complete" && job.source_label === "Database backfill" && job.filename === null && job.field_mapping === null &&
      job.uploaded_by === null && (await state()).batches === s1.batches + 1);
  ok("... one job: kind backfill, origin DATABASE, applied in apply mode, its two receivers applied, new_leads its distinct leads",
    job?.kind === "backfill" && job.origin_tag === "DATABASE" && job.origin_pool === "cleaning" && job.state === "applied" && job.mode === "apply" &&
      same(sorted(job.receivers), sorted([A, B])) && same(sorted(job.receivers_applied), sorted([A, B])) && job.new_leads === rowsA.length + rowsB.length,
    JSON.stringify({ kind: job?.kind, state: job?.state, receivers: job?.receivers, new_leads: job?.new_leads }));
  ok("... A's shares are what the preview said, and B's: shared, applied by no one, queued, from DATABASE",
    rowsA.length === expectA && rowsB.length === nB && [...rowsA, ...rowsB].every((r) => r.outcome === "shared" && r.applied_at && r.applied_by === null &&
      r.push_state === "queued" && r.origin_tag === "DATABASE" && !r.undone_at), JSON.stringify({ a: rowsA.length, b: rowsB.length, expectA }));
  const renoSet = new Set(ctx.lead.reno);
  ok("... each with the include entry it matched: Reno's leads the city entry, Utah's the state entry, Sparks' B's city",
    rowsA.filter((r) => renoSet.has(r.lead_id)).every((r) => sameObj(r.matched_place, { country: "US", state: "NV", city: "Reno", label: "Reno, NV" })) &&
      rowsA.filter((r) => ctx.lead.utah.includes(r.lead_id)).every((r) => sameObj(r.matched_place, { country: "US", state: "UT", city: null, label: "UT (state-wide)" })) &&
      rowsB.every((r) => r.matched_place?.label === "Sparks, NV"), JSON.stringify([rowsA[0]?.matched_place, rowsB[0]?.matched_place]));
  ok("... the job's counts per receiver: checked, fits, shared and each reason", job?.counts?.[A]?.shared === expectA && job.counts[A].already_sent === 1 &&
    job.counts[A].in_flight === 2 && job.counts[A].already_shared === 3 && job.counts[A].same_install === 3 && job.counts[B]?.shared === nB, JSON.stringify(job?.counts));
  const cur = await all(`SELECT receiver_tag, place_key, windows, next_window, place_rows, pass_done_at IS NOT NULL AS done, shared::int AS shared, checked::int AS checked
                           FROM share_backfill_cursors WHERE receiver_tag = ANY($1::text[]) ORDER BY 1, 2`, [[A, B]]);
  ok("... its cursors: Reno, Utah and Sparks, one window each, read, the pass done, the shares counted",
    same(cur.map((c) => [c.receiver_tag, c.place_key, c.windows, c.next_window, c.done]),
      [[A, "US|NV|reno", 1, 1, true], [A, "US|UT", 1, 1, true], [B, "US|NV|sparks", 1, 1, true]].sort((x, y) => (`${x[0]}|${x[1]}` < `${y[0]}|${y[1]}` ? -1 : 1))) &&
      cur.reduce((s, c) => s + c.shared, 0) === expectA + nB, JSON.stringify(cur));
  const hist = await one(
    `SELECT count(*)::int AS n FROM upload_batches WHERE id = $1 AND source_batch_id IS NULL AND (source_label IS NULL OR source_label <> 'Emails found') AND batch_type <> 'backfill'`,
    [ctx.jobE3]
  );
  ok("... and the Uploads history's query (as the page reads it) leaves the batch out", hist.n === 0);
  ok("... the run's counts are the shares written", ar.counts[A]?.shared === expectA && ar.counts[B]?.shared === nB && ar.totals?.shared === expectA + nB && ar.totals?.served === 2);
  ctx.expectA = expectA;

  // Again: nothing new.
  const before = await state();
  const again = await fire();
  const gr = await runRow(again.run);
  ok("a second firing shares nothing new: every place's pass is done, no batch or job made",
    again.state === "done" && gr.batch_id === null && gr.counts[A]?.shared === 0 && gr.counts[A]?.windows === 0 && (await state()).shares === before.shares &&
      (await state()).batches === before.batches, JSON.stringify(gr.counts));

  // The cap a client a firing (overlap sharing's push_max_per_job).
  ctx.lead.k1 = [];
  for (let i = 1; i <= 5; i++) ctx.lead.k1.push(await lead(`ek1${i}`, { city: "Helena", state: "MT", geo: null }));
  await setSharing({ push_max_per_job: 2 });
  await setBackfill({ tags: [K1], mode: "apply" });
  const k = [];
  for (let i = 0; i < 3; i++) {
    const f = await fire();
    k.push({ ...(await runRow(f.run)).counts[K1], cursor: await cursorOf(K1, "US|MT") });
  }
  ok("the cap a client a firing (2): 2, 2, then 1; a capped window is not passed, the last one ends the pass",
    same(k.map((x) => x.shared), [2, 2, 1]) && same(k.map((x) => x.capped ?? null), ["run", "run", null]) && same(k.map((x) => x.cursor.next_window), [0, 0, 1]) &&
      k[2].cursor.pass_done_at !== null && (await sharesOf(K1)).length === 5, JSON.stringify(k.map((x) => [x.shared, x.capped, x.cursor.next_window])));
  ok("... each firing that shared made its own backfill job", (await one(`SELECT count(DISTINCT batch_id)::int AS n FROM lead_shares WHERE receiver_tag = $1`, [K1])).n === 3);

  // The cap a client a day (overlap sharing's push_max_per_day), shares of another job counted.
  ctx.lead.k2 = [];
  for (let i = 1; i <= 4; i++) ctx.lead.k2.push(await lead(`ek2${i}`, { city: "Fargo", state: "ND", geo: null }));
  const elsewhere = await lead("ek2-other", { city: "Seattle", state: "WA", geo: null });
  const impK2 = await importJob("k2-import", O);
  await share(impK2, elsewhere, K2, { origin: O, push: "queued" });
  await setSharing({ push_max_per_day: 3 });
  await setBackfill({ tags: [K2], mode: "apply" });
  const d1 = (await runRow((await fire()).run)).counts[K2];
  const d2 = (await runRow((await fire()).run)).counts[K2];
  ok("the cap a client a day (3, one share of an import today): 2 written, capped day; the next firing skips it",
    d1.shared === 2 && d1.capped === "day" && d2.skipped === "day cap reached" && (await sharesOf(K2)).length === 2, JSON.stringify({ d1, d2 }));
  await setSharing();

  // The cap a firing (database_backfill.max_per_run), and a client with a low place first.
  ctx.lead.r1 = [];
  ctx.lead.r2 = [];
  for (let i = 1; i <= 2; i++) ctx.lead.r1.push(await lead(`er1${i}`, { city: "Pierre", state: "SD", geo: null }));
  for (let i = 1; i <= 4; i++) ctx.lead.r2.push(await lead(`er2${i}`, { city: "Omaha", state: "NE", geo: null }));
  await coverage(R1, [{ label: "SD (state-wide)", kind: "state", country: "US", state: "SD", city: null, available: 900, resolved: true }]);
  await coverage(R2, [{ label: "NE (state-wide)", kind: "state", country: "US", state: "NE", city: null, available: 10, resolved: true }]);
  await setBackfill({ tags: [R1, R2], mode: "apply", max_per_run: 3 });
  const r1 = await fire();
  const rr1 = await runRow(r1.run);
  ok("the cap a firing (3): the client with a low place (R2) first, 3 of its 4 written, the firing stopped (run_cap), R1 not reached",
    r1.state === "stopped" && rr1.stop_reason === "run_cap" && rr1.counts[R2]?.shared === 3 && rr1.counts[R2]?.capped === "run_total" &&
      rr1.counts[R2]?.low_places === 1 && rr1.counts[R1]?.not_reached === "run_cap" && rr1.totals.not_reached === 1, JSON.stringify(rr1.counts));
  const r2 = await fire();
  const rr2 = await runRow(r2.run);
  ok("... the next firing: R2's window read again (its 3 already_shared, the last one written), then R1's 2",
    r2.state === "done" && rr2.counts[R2]?.shared === 1 && rr2.counts[R2]?.already_shared === 3 && rr2.counts[R1]?.shared === 2 &&
      (await sharesOf(R2)).length === 4 && (await sharesOf(R1)).length === 2, JSON.stringify(rr2.counts));

  // Low places first inside a client.
  ctx.lead.ks = [await lead("eks1", { city: "Topeka", state: "KS", geo: null }), await lead("eks2", { city: "Topeka", state: "KS", geo: null })];
  ctx.lead.ok = [await lead("eok1", { city: "Tulsa", state: "OK", geo: null }), await lead("eok2", { city: "Tulsa", state: "OK", geo: null })];
  await coverage(L, [
    { label: "KS (state-wide)", kind: "state", country: "US", state: "KS", city: null, available: 900, resolved: true },
    { label: "OK (state-wide)", kind: "state", country: "US", state: "OK", city: null, available: 10, resolved: true },
  ]);
  await setSharing({ push_max_per_job: 2 });
  await setBackfill({ tags: [L], mode: "apply" });
  const lr = await runRow((await fire()).run);
  const lShared = (await sharesOf(L)).map((r) => r.lead_id);
  ok("low places first: of Kansas (900) and Oklahoma (10, under the minimum of 500), Oklahoma's leads are written first",
    lr.counts[L]?.shared === 2 && lr.counts[L]?.capped === "run" && same(sorted(lShared), sorted(ctx.lead.ok)) && !(await cursorOf(L, "US|KS")),
    JSON.stringify({ counts: lr.counts[L], lShared }));
  await setSharing();

  // Skipped clients.
  ctx.lead.f = [await lead("ef1", { city: "Boise", state: "ID", geo: null }), await lead("ef2", { city: "Boise", state: "ID", geo: null })];
  await setBackfill({ tags: [N, P, F, NONE], mode: "apply" });
  const sk = await runRow((await fire()).run);
  ok("skipped with their reasons: isolated, cannot receive, off the push list, not a client",
    sk.counts[N]?.skipped === "isolated" && sk.counts[P]?.skipped === "cannot receive: status Paused" && sk.counts[F]?.skipped === "not on the push list" &&
      sk.counts[NONE]?.skipped === "not a client" && sk.totals.skipped === 4 && sk.batch_id === null, JSON.stringify(sk.counts));
  await setBackfill({ tags: [F], mode: "preview" });
  const fp = await runRow((await fire()).run);
  ok("... in preview a client off the push list is still read, and its counts say so", fp.counts[F]?.would_share === 2 && fp.counts[F]?.push_list === false,
    JSON.stringify(fp.counts[F]));
  const tagged = await runRow((await fire({ tag: A })).run);
  ok("--tag: only that client (in preview, read even when not on the list)", same(Object.keys(tagged.counts), [A]) && tagged.counts[A]?.on_list === false);

  // The lease.
  const l1 = await acquireLease(pool, OWNER_1);
  const l2 = await acquireLease(pool, OWNER_2);
  await releaseLease(pool, OWNER_2);
  const still = await one(`SELECT owner::text AS owner FROM worker_locks WHERE key = $1`, [BACKFILL_LOCK_KEY]);
  await releaseLease(pool, OWNER_1);
  const l3 = await acquireLease(pool, OWNER_2);
  await releaseLease(pool, OWNER_2);
  ok("the lease: one firing holds it, a second is refused, only its owner gives it back", l1 && !l2 && still?.owner === OWNER_1 && l3 &&
    (await state()).locks === 0);

  // A time limit, and the window read again next time.
  const ids = [0x0a, 0x3f, 0x41, 0x7f, 0x80, 0xc1].map((b) => idAt(b));
  for (let i = 0; i < ids.length; i++) await lead(`etm${i}`, { city: "Salem", state: "OR", geo: null, id: ids[i] });
  ctx.lead.tm = ids;
  await pool.query(
    `INSERT INTO share_backfill_cursors (receiver_tag, place_key, windows, next_window, place_rows, rules_at)
     SELECT $1, 'US|OR', 4, 1, 6, t.updated_at FROM client_targeting t WHERE t.client_tag = $1`,
    [TIME]
  );
  await setBackfill({ tags: [TIME], mode: "apply" });
  const t1 = await fire({ deadline: Date.now() - 1 });
  const tr1 = await runRow(t1.run);
  const c1 = await cursorOf(TIME, "US|OR");
  ok("a time limit: the firing stops (time), the client is not reached, its cursor stays at its window",
    t1.state === "stopped" && tr1.stop_reason === "time" && tr1.counts[TIME]?.not_reached === "time" && c1.next_window === 1 && (await sharesOf(TIME)).length === 0,
    JSON.stringify({ t1, counts: tr1.counts }));
  const tr2 = await runRow((await fire()).run);
  const c2 = await cursorOf(TIME, "US|OR");
  const got2 = (await sharesOf(TIME)).map((r) => r.lead_id);
  ok("... the next firing reads from that window to the end: 3 windows, the leads of windows 2 to 4 written, the pass done",
    tr2.counts[TIME]?.windows === 3 && c2.next_window === 4 && c2.pass_done_at && same(sorted(got2), sorted(ids.slice(2))), JSON.stringify({ counts: tr2.counts[TIME], got2 }));

  // A rules change starts a new pass.
  await pool.query(`UPDATE client_targeting SET updated_at = clock_timestamp() WHERE client_tag = $1`, [TIME]);
  const tr3 = await runRow((await fire()).run);
  const c3 = await cursorOf(TIME, "US|OR");
  ok("a rules change starts a new pass: the windows worked out again (one), every lead read, the 2 never read before written, the rest already shared",
    tr3.counts[TIME]?.shared === 2 && tr3.counts[TIME]?.already_shared === 4 && c3.windows === 1 && c3.next_window === 1 && Number(c3.checked) === 6 &&
      Number(c3.shared) === 2 && (await sharesOf(TIME)).length === 6, JSON.stringify({ counts: tr3.counts[TIME], c3 }));

  // A client tagged DATABASE.
  await pool.query(
    `INSERT INTO client_tags (tag, status, client_type, name) VALUES ($1, 'Active', 'Cleaning', 'made-up bftest marker')`,
    [BACKFILL_ORIGIN]
  );
  const db0 = await fire();
  await pool.query(`DELETE FROM client_tags WHERE tag = $1 AND name = 'made-up bftest marker'`, [BACKFILL_ORIGIN]);
  const dbr = await runRow(db0.run);
  ok("a client tagged DATABASE: the firing ends with an error run, nothing written", db0.state === "error" && dbr.state === "error" &&
    dbr.last_error === "a client is tagged DATABASE" && dbr.batch_id === null);
}

// ── F. The share push ───────────────────────────────────────────────────────

async function partF() {
  sec("F. The share push takes the backfill's rows");
  const push = await srcModule("lib/sharing/push.ts");
  const queued = (await sharesOf(A, ctx.jobE3)).filter((r) => r.push_state === "queued").map((r) => r.lead_id);
  const asked = [];
  const readCampaigns = async (tag) => {
    asked.push(tag);
    return { data: [{ id: 990001, name: `${A}: Main`, status: "active", instance_url: B2B2, created_at: "2026-10-01T00:00:00Z", total_leads: 1 }], errors: [] };
  };
  const r = await push.pushReceiverShares(pool, { receiver: A, readCampaigns });
  const batches = await all(`SELECT * FROM push_batches WHERE client_tag = $1 AND push_options ->> 'source' = 'share'`, [A]);
  const after = await sharesOf(A, ctx.jobE3);
  ok("the share push takes A's backfill rows: one share batch on the B2B side with exactly those leads",
    r.status === 200 && r.body.pushed === queued.length && batches.length === 1 && batches[0].email_side === "b2b" &&
      same(sorted(batches[0].selected_ids), sorted(queued)) && batches[0].push_options.skipAlreadySent === true && same(asked, [A]),
    JSON.stringify({ status: r.status, body: r.body, n: batches.length }));
  ok("... and marks each of them pushed with that batch", after.every((x) => x.push_state === "pushed") &&
    (await one(`SELECT count(*)::int AS n FROM lead_shares WHERE push_batch_id = $1`, [batches[0]?.id ?? null])).n === queued.length);
  ctx.pushBatch = batches[0]?.id ?? null;
}

// ── G. Undo and the page ────────────────────────────────────────────────────

async function partG() {
  sec("G. Undo, the actions' refusals, the jobs list, the route, the Uploads page");
  const u = await undoShareJob(pool, { batchId: ctx.jobE3, receiver: B, userId: USER });
  const rowsB = await sharesOf(B, ctx.jobE3);
  const nB = ctx.lead.sparks.length;
  ok("Undo on a backfill job (B only): its queued shares are undone and dropped (undone)", u.undone === nB &&
    rowsB.every((r) => r.undone_at && r.push_state === "dropped" && r.push_note === "undone"), JSON.stringify(u));
  await pool.query(`UPDATE client_targeting SET updated_at = clock_timestamp() WHERE client_tag = $1`, [B]);
  await setBackfill({ tags: [B], mode: "apply" });
  const ub = await runRow((await fire()).run);
  ok("... and the next firing never takes them again (a new pass reads them: already_shared)", ub.counts[B]?.shared === 0 && ub.counts[B]?.already_shared === nB,
    JSON.stringify(ub.counts[B]));
  for (const [name, fn] of [["previewShareJob", previewShareJob], ["applyShareJob", applyShareJob], ["retryShareJob", retryShareJob]]) {
    let err = null;
    try {
      await fn(pool, { batchId: ctx.jobE3, userId: USER });
    } catch (e) {
      err = e;
    }
    ok(`${name} answers 409 on a backfill job: only Undo applies to it`, err instanceof ShareActionError && err.status === 409 &&
      err.message === "A database backfill job is made by the backfill; only Undo applies to it.", err?.message);
  }

  const server = await srcModule("lib/sharing/server.ts");
  const c = await pool.connect();
  let lists = null;
  try {
    await c.query("BEGIN READ ONLY");
    lists = {
      backfill: await server.listJobs(c, { state: null, origin: null, before: null, limit: 200, kind: "backfill" }),
      imports: await server.listJobs(c, { state: null, origin: null, before: null, limit: 200, kind: "import" }),
      origin: await server.listJobs(c, { state: null, origin: BACKFILL_ORIGIN, before: null, limit: 200 }),
      detail: await server.jobDetail(c, ctx.jobE3),
      importDetail: await server.jobDetail(c, ctx.importJob),
    };
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
  const ids = (l) => sorted(l.jobs.map((j) => j.batch_id));
  ok("listJobs gives kind: the backfill jobs under kind backfill (the same as under origin DATABASE), the imports under import",
    lists.backfill.jobs.length > 0 && lists.backfill.jobs.every((j) => j.kind === "backfill") && lists.backfill.jobs.some((j) => j.batch_id === ctx.jobE3) &&
      same(ids(lists.backfill), ids(lists.origin)) && lists.imports.jobs.every((j) => j.kind === "import") && lists.imports.jobs.some((j) => j.batch_id === ctx.importJob));
  ok("jobDetail gives kind: backfill with its label, origin and receivers; an import's import",
    lists.detail?.job.kind === "backfill" && lists.detail.job.source_label === "Database backfill" && lists.detail.job.origin_tag === BACKFILL_ORIGIN &&
      lists.detail.receivers.some((r) => r.tag === A && r.outcomes.shared > 0) && lists.importDetail?.job.kind === "import");

  const route = await srcModule("app/api/sharing/backfill/route.ts");
  await setBackfill({ enabled: true, tags: [A, B, NONE], mode: "preview" });
  as("viewer");
  const v0 = await call(route.GET);
  as("manager");
  const v = await call(route.GET);
  const ca = v.body?.clients?.find((x) => x.tag === A);
  ok("the route: viewers get 403; a manager gets the switch with the caps in force, the newest runs, and per listed client its places with their passes",
    v0.status === 403 && v.status === 200 && v.body.ready === true && v.body.switch.enabled === true && v.body.switch.perClientFiring === 1000 &&
      v.body.switch.perClientDay === 2000 && v.body.switch.perFiring === 5000 && v.body.runs.length > 0 && v.body.runs.length <= 20 && ca?.pool === "cleaning" && ca.receiveBlock === null &&
      ca.onPushList === true && same(ca.places.map((p) => [p.key, p.windows, p.windowsRead]), [["US|NV|reno", 1, 1], ["US|UT", 1, 1]]) &&
      v.body.clients.find((x) => x.tag === NONE)?.isClient === false && ca.backfillShares.pushed > 0 && v.body.warning === null,
    JSON.stringify({ s: v.status, sw: v.body?.switch, ca, w: v.body?.warning }).slice(0, 900));
  await pool.query(`UPDATE share_backfill_runs SET started_at = started_at - interval '3 hours' WHERE ${"receivers && $1::text[]"}`, [LIST]);
  const stale = await call(route.GET);
  ok("... and warns when the backfill is on and its newest firing is older than 2 hours", /may not be running/.test(stale.body?.warning ?? ""), stale.body?.warning);
  const before = await state();
  const pv = await call(route.GET, { query: { preview: A.toLowerCase() } });
  ok("the preview for a manager: per place what the next firing would do (here nothing new), and nothing written",
    pv.status === 200 && pv.body.ready === true && pv.body.tag === A && pv.body.skip === null && pv.body.places.length === 2 &&
      pv.body.places.every((p) => p.pass === "done") && same(await state(), before), JSON.stringify(pv.body).slice(0, 600));
  await pool.query(`UPDATE client_targeting SET updated_at = clock_timestamp() WHERE client_tag = $1`, [A]);
  const pv2 = await call(route.GET, { query: { preview: A } });
  ok("... after a rules change: each place read again, none would be shared again (shared before, or in the push F made), still nothing written",
    pv2.status === 200 && pv2.body.places.every((p) => p.pass === "rules" && p.windowsRead === 1) && pv2.body.counts.would_share === 0 &&
      pv2.body.counts.already_shared + pv2.body.counts.in_flight >= ctx.expectA && same(await state(), before), JSON.stringify(pv2.body?.counts));
  const pvP = await call(route.GET, { query: { preview: P } });
  ok("... a client that would be skipped says why", pvP.status === 200 && pvP.body.skip === "cannot receive: status Paused");
  ok("... a preview of something that is no tag: 400", (await call(route.GET, { query: { preview: "not a tag!" } })).status === 400);

  const page = source("src/app/(app)/uploads/page.tsx");
  ok("the Uploads page keeps its pinned query texts and leaves out backfill batches as a call of its own",
    page.includes(`.is("source_batch_id", null)`) && page.includes('.or(`source_label.is.null,source_label.neq."${FOUND_LABEL}"`)') &&
      page.includes(`.neq("batch_type", "backfill")`));
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(API, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
  const { data, error } = await sb.from("upload_batches").select("id").in("id", [ctx.jobE3, ctx.importJob])
    .is("source_batch_id", null).or(`source_label.is.null,source_label.neq."Emails found"`).neq("batch_type", "backfill");
  ok("... the same query through the local Supabase API: the import stays, the backfill batch does not",
    !error && same((data ?? []).map((x) => x.id), [ctx.importJob]), JSON.stringify({ error, data }));
}

// ── H. The cron script ──────────────────────────────────────────────────────

async function partH() {
  sec("H. The cron script, switched off");
  await setBackfill({ enabled: false, tags: [A], mode: "apply" });
  const before = await state();
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./backfill-worker.mjs", import.meta.url))], {
    env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", timeout: 60_000,
  });
  ok("spawned switched off: exit 0, one line saying so, nothing written (no run, lease, batch or share)",
    r.status === 0 && /switched off/.test(r.stdout) && r.stdout.trim().split("\n").length === 1 && same(await state(), before), `${r.status} ${r.stdout} ${r.stderr}`);
  const pkg = JSON.parse(source("package.json"));
  ok("npm run backfill-worker runs it", pkg.scripts?.["backfill-worker"] === "node scripts/backfill-worker.mjs");
}

// ── Run ─────────────────────────────────────────────────────────────────────

const baseline = {};
const others = () =>
  one(`SELECT (SELECT count(*) FROM leads WHERE email NOT LIKE $1)::int AS leads,
              (SELECT count(*) FROM push_batches WHERE NOT starts_with(coalesce(client_tag, ''), 'BFTEST_'))::int AS pushes,
              (SELECT count(*) FROM client_tags WHERE NOT starts_with(tag, 'BFTEST_'))::int AS clients,
              (SELECT count(*) FROM upload_batches WHERE filename IS NULL OR filename NOT LIKE '${FILE}%')::int AS batches`, [`%.${HOST}`]);

let crashed = null;
try {
  await cleanup();
  const pre = await one(
    `SELECT (SELECT count(*) FROM share_jobs)::int AS jobs, (SELECT count(*) FROM lead_shares)::int AS shares,
            CASE WHEN to_regclass('public.share_backfill_runs') IS NULL THEN 0 ELSE (SELECT count(*) FROM share_backfill_runs)::int END AS runs,
            (SELECT count(*) FROM worker_locks WHERE key = $1)::int AS locks,
            (SELECT count(*) FROM client_tags WHERE tag = $2)::int AS marker`,
    [BACKFILL_LOCK_KEY, BACKFILL_ORIGIN]
  );
  const preCursors = (await one(`SELECT to_regclass('public.share_backfill_cursors') IS NOT NULL AS ok`)).ok
    ? (await one(`SELECT count(*)::int AS n FROM share_backfill_cursors`)).n
    : 0;
  if (pre.jobs || pre.shares || pre.runs || preCursors || pre.locks || pre.marker) {
    console.error(`Refusing to run: the local database holds share jobs, shares, backfill runs or cursors that are not this suite's, a backfill-worker lease, or a client tagged ${BACKFILL_ORIGIN} (${JSON.stringify({ ...pre, cursors: preCursors })}).`);
    process.exit(1);
  }
  if (!(await loadGeoIds())) throw new Error("the local geo reference does not hold the made-up places' cities");
  Object.assign(baseline, await others());
  await partB();
  await saveSettings();
  await partA();
  await setup();
  await partC();
  await partD();
  await partE();
  await partF();
  await partG();
  await partH();
  const made = await one(
    `SELECT (SELECT count(*) FROM share_backfill_runs)::int AS runs, (SELECT count(*) FROM share_jobs WHERE kind = 'backfill')::int AS jobs,
            (SELECT count(*) FROM lead_shares WHERE origin_tag = $1)::int AS shares, (SELECT count(*) FROM share_backfill_cursors)::int AS cursors`,
    [BACKFILL_ORIGIN]
  );
  console.log(`\n  (the suite's firings wrote ${made.runs} runs, ${made.jobs} backfill jobs, ${made.shares} backfill shares, ${made.cursors} cursors)`);
} catch (e) {
  crashed = e;
  ok("the suite ran to its end", false, e?.stack ?? e);
} finally {
  sec("Z. Everything removed, the settings back");
  try {
    await cleanup();
    if (saved.size) await restoreSettings();
    const left = await one(
      `SELECT (SELECT count(*) FROM share_jobs)::int AS jobs, (SELECT count(*) FROM lead_shares)::int AS shares,
              (SELECT count(*) FROM share_backfill_runs)::int AS runs, (SELECT count(*) FROM share_backfill_cursors)::int AS cursors,
              (SELECT count(*) FROM upload_batches WHERE batch_type = 'backfill')::int AS backfill_batches,
              (SELECT count(*) FROM leads WHERE email LIKE $1)::int AS leads, (SELECT count(*) FROM client_tags WHERE starts_with(tag, 'BFTEST_'))::int AS clients,
              (SELECT count(*) FROM worker_locks WHERE key = $2)::int AS locks`,
      [`%.${HOST}`, BACKFILL_LOCK_KEY]
    );
    ok("nothing of this suite is left: no share job, share, run, cursor, backfill batch, made-up lead, client or lease",
      Object.values(left).every((n) => n === 0), JSON.stringify(left));
    const now = await others();
    ok("nothing else moved: other leads, pushes, clients and batches as before", same(now, baseline), JSON.stringify({ baseline, now }));
    if (saved.size) {
      const back = await all(`SELECT key, value FROM enrich_settings WHERE key = ANY($1::text[]) ORDER BY key`, [[...saved.keys()]]);
      ok("overlap_sharing, database_backfill and never_contact_inboxes are as they were", back.every((r) => same(r.value, saved.get(r.key)?.value)) &&
        back.length === [...saved.values()].filter(Boolean).length);
    }
    ok("nothing reached a network (no fetch but the local API, no DNS)", net.refused === 0 && net.dns === 0, JSON.stringify(net));
  } catch (e) {
    ok("the cleanup ran", false, e?.stack ?? e);
  }
  for (const p of TS.pools) await p.end().catch(() => {});
  await pool.end();
  console.log(`\n${passed} passed, ${failed} failed${crashed ? " (stopped early)" : ""}`);
  process.exit(failed ? 1 : 0);
}
