#!/usr/bin/env node
// The web side of an upload's no-email rows (migration 130): the upload route
// records the tags and the replace fields, the found-email hand-off adds a
// found person through the upload's own import, the Uploads page's route
// counts where the rows stand and sends an earlier upload by hand, and the
// Clay tab's routes say what a held upload row waits for.
// LOCAL DATABASE ONLY: made-up clients UPTEST_C and UPTEST_D, made-up users,
// uploads, People tables and people under .upweb.uptest.example, all removed
// at the end (and any left by a run that was cut off). For one check it turns
// the people_pipeline switch on for UPTEST_C and puts it back.
//
//   node --env-file=.env.local scripts/test-upload-enrich-web.mjs
//
// Stop the enrichment worker first, and don't start it for this: the People
// rows are written here by SQL, as the worker's move would write them. Run it
// under the shared local-database lock when other suites share the database.
// Migrations 129 and 130 must be in the local database.
//
// Nothing here reaches a network: fetch refuses every address but the local
// Supabase API, DNS is refused, and the import's mail provider lookup (which
// stays on, as uploads have it) is a stub. No paid key is read. The routes run
// for real through a small loader that compiles their TypeScript, with
// stand-ins only for: the session (requireRole and the Supabase server
// client: a made-up user with a role), the upload route's Supabase admin
// client (it records what the route writes), the audit log, the worker's
// heartbeat, Next's after() (its callbacks are kept and run when the test
// says), the shared pg pool (local, no TLS) and the mail provider lookup. The
// Bearer key check is the real intakeKeyStatus().
//
//   P. the upload route records add_tags and override_fields, both formats
//   A. POST /api/uploads/found/auto: the key, the body, a round
//   R. rounds end to end through the real import: the batch, the cells, the
//      leads, the same result as a direct upload of the row with the email
//      typed in (merge and skip), a second round takes nobody, a dead round's
//      people, the button takes again the people a round could not store
//   S. send: admin only, a client tag only, the states it may change
//   G. GET /api/uploads/people: the states, the counts, the manager rule, the worker
//   C. the Clay tab: a People table's uploads, the held row's template
//   H. the Uploads page's history leaves the rounds out (through the local Supabase API)
//   N. the audit lines, nothing reached the network, everything removed

import pg from "pg";
import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import {
  ADD_COLUMN, APPROVED_OUTCOME, FOUND_SOURCE_LABEL, NOT_SENT_WHY, UPLOAD_CAPABILITY, UPLOAD_SOURCE_KIND, foundTags,
  peopleSearchText, uploadPeopleInputs, uploadRowKey, uploadSourceLabel,
} from "./lib/enrich/upload-people.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
const API = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
if (!API || !["127.0.0.1", "localhost"].includes(new URL(API).hostname)) {
  console.error("Refusing to run: NEXT_PUBLIC_SUPABASE_URL must be the local Supabase API.");
  process.exit(1);
}
// No paid key reaches anything here, whatever the shell holds.
for (const k of [
  "OPENAI_API_KEY", "ENRICH_REOON_API_KEY", "REOON_API_KEY", "CLEARBIT_API_KEY", "FINDEMAIL_API_KEY", "ANTHROPIC_API_KEY",
  "AIARK_API_KEY", "AIARK_WEBHOOK_URL", "AIARK_AUTO_ADD_URL", "AIARK_AUTO_ADD_KEY", "FINDYMAIL_API_KEY", "PROSPEO_API_KEY",
  "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY", "ICYPEAS_API_KEY", "EMAILBISON_API_KEY", "EMAILBISON_BASE_URL", "EMAILBISON_KEYS",
]) delete process.env[k];

const UC = "UPTEST_C"; // with targeting rules
const UD = "UPTEST_D"; // no targeting rules
const TAGS = [UC, UD];
const RUN = randomUUID().slice(0, 6);
const HOST = "upweb.uptest.example"; // every made-up address and domain ends with it
const FILE = `upweb-${RUN}`; // every made-up upload's file name starts with it
const mail = (who) => `${who}-${RUN}@${who}-co.${HOST}`;

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

// ── No network ───────────────────────────────────────────────────────────────

const net = { refused: 0, local: 0, dns: 0 };
const realFetch = globalThis.fetch;
const LOCAL_API_HOST = new URL(API).host;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (u.host === LOCAL_API_HOST) {
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
const authTsUrl = new URL("lib/enrich/auth.ts", SRC).href;
const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}
export function after(fn) { globalThis.__upTest.after.push(fn); }`,
  // The session stand-in; the Bearer key check is the real one.
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
export { intakeKeyStatus } from "${authTsUrl}";
export async function requireRole(min) {
  const t = globalThis.__upTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__upTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__upTest.worker; }`,
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => {
    const t = globalThis.__upTest;
    return { data: { user: t.role ? { id: t.userId } : null } };
  } } };
}`,
  // The upload route's admin client: records every call, answers the role and the batch insert.
  "@/lib/supabase/admin": `export function createAdminClient() {
  const t = globalThis.__upTest;
  return {
    from(table) {
      const op = { table, action: "select", payload: null, filters: [] };
      const b = {
        select() { return b; },
        insert(p) { op.action = "insert"; op.payload = p; return b; },
        update(p) { op.action = "update"; op.payload = p; return b; },
        eq(k, v) { op.filters.push(["eq", k, v]); return b; },
        lt(k, v) { op.filters.push(["lt", k, v]); return b; },
        single() { return b; },
        maybeSingle() { return b; },
        then(ok, bad) { return Promise.resolve(t.supabase(op)).then(ok, bad); },
      };
      return b;
    },
  };
}`,
  "@/lib/db/pool": `import pg from "${pgUrl}";
let p = null;
export function getPool() {
  if (!p) { p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }); globalThis.__upTest.pools.push(p); }
  return p;
}`,
  // The import's mail provider lookup (src/lib/uploads/esp-lookup.ts): on, as for uploads, but never asking DNS.
  "./esp-lookup": `export function domainOfEmail(email) {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const d = email.slice(at + 1).trim().toLowerCase();
  return d.includes(".") ? d : null;
}
export async function lookupEspForDomains(domains) {
  const out = new Map();
  for (const d of domains) { globalThis.__upTest.esp.push(d); out.set(d, "Google"); }
  return out;
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

const T = (globalThis.__upTest = {
  role: null, userId: null, audits: [], worker: null, after: [], pools: [], esp: [], supa: [],
  supabase(op) {
    T.supa.push(op);
    if (op.table === "user_profiles") return { data: T.role ? { role: T.role } : null, error: null };
    if (op.table === "upload_batches" && op.action === "insert") return { data: { id: randomUUID() }, error: null };
    return { data: null, error: null };
  },
});
const srcModule = (p) => import(new URL(p, SRC).href);
const route = (p) => srcModule(`app/api/${p}/route.ts`);
const USERS = {};
const ROLE = { admin: "admin", manager: "manager", other: "manager", viewer: "viewer" };
const as = (who) => {
  T.role = who ? ROLE[who] : null;
  T.userId = who ? USERS[who] : null;
};
async function call(handler, { body, raw, query, headers } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const req = {
    json: async () => (raw !== undefined ? JSON.parse(raw) : body),
    text: async () => (raw !== undefined ? raw : typeof body === "string" ? body : JSON.stringify(body ?? "")),
    nextUrl: new URL(`http://upload-web.test/api${qs}`),
    headers: new Headers(headers ?? {}),
  };
  const res = await handler(req);
  return { status: res.status, body: res.body, headers: res.headers };
}
/** Runs the after() callbacks the routes left, in order, as Next does once the answer is sent. */
async function drainAfter() {
  while (T.after.length) await T.after.shift()();
}
const heartbeat = ({ online = true, moves = true, foundAuto = false } = {}) => ({
  id: "upload-web-test",
  last_seen: new Date().toISOString(),
  started_at: new Date().toISOString(),
  seconds_ago: online ? 2 : 600,
  online,
  info: { capabilities: ["company_runs", "held_release", ...(moves ? [UPLOAD_CAPABILITY] : [])], keys: {}, upload_people: { found_auto: foundAuto } },
});

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

let switchBefore = null; // people_pipeline as it was: { exists, value, updated_by }

/** Every row this suite (or a run of it that was cut off) made, removed. */
async function cleanup() {
  const users = (await all(`SELECT id FROM auth.users WHERE email LIKE $1`, [`upweb-%@${HOST}`])).map((r) => r.id);
  const tables = (await all(`SELECT id FROM enrich_tables WHERE client_tag = ANY($1::text[])`, [TAGS])).map((r) => r.id);
  const uploads = (await all(`SELECT id FROM upload_batches WHERE filename LIKE 'upweb-%'`)).map((r) => r.id);
  await pool.query(`DELETE FROM upload_batches WHERE source_batch_id = ANY($1::uuid[]) OR filename LIKE $2`, [uploads, `${FOUND_SOURCE_LABEL} · upweb-%`]);
  await pool.query(`DELETE FROM upload_batches WHERE id = ANY($1::uuid[]) OR uploaded_by = ANY($2::uuid[])`, [uploads, users]);
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  await pool.query(`DELETE FROM audit_logs WHERE performed_by = ANY($1::text[]) OR details LIKE '%upweb-%'`, [users.map(String)]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]);
  if (switchBefore) {
    if (switchBefore.exists) {
      await pool.query(`UPDATE enrich_settings SET value = $2::jsonb, updated_by = $3 WHERE key = $1`, ["people_pipeline", JSON.stringify(switchBefore.value), switchBefore.updated_by]);
    } else await pool.query(`DELETE FROM enrich_settings WHERE key = 'people_pipeline'`);
  }
}

// The made-up file: the Uploads page's mapping, with a validation status and a
// mail provider column that describe the address the row did not have.
const HEADERS = ["First Name", "Last Name", "Job Title", "Company Name", "Email", "City", "State", "Website", "LinkedIn", "Validation", "Provider", "Notes"];
const MAPPING = { 0: "first_name", 1: "last_name", 2: "title", 3: "company", 4: "email", 5: "city", 6: "state", 7: "domain", 8: "person_linkedin", 9: "validation_status", 10: "esp", 11: "notes" };
const EMAIL_COL = 4;
const ADDRESS_COLS = [9, 10];
const person = (first, last, { title = "Office Manager", company = `${first} Co | Cleaning`, email = "", city = "Springfield", state = "Illinois", notes = "kept" } = {}) => [
  first, last, title, company, email, city, state, `https://www.${first.toLowerCase()}-co.${HOST}/about`,
  `https://www.linkedin.com/in/${first.toLowerCase()}-${RUN}`, "invalid", "Mimecast", notes,
];

let importer = null; // src/lib/uploads/import-rows.ts, through the loader (the stubbed lookup)
let found = null; // src/lib/uploads/found.ts

/**
 * An upload as the Uploads page makes it: the batch (with its tags and replace
 * fields, as the route records them since 130), then the real import of its
 * rows: leads for rows with an email, kept-back rows for the rest.
 */
async function makeUpload(slug, { strategy = "merge", tags = [UC], override = [], rows, by = USERS.manager, recordTags = true, status = "complete" }) {
  const filename = `${FILE}-${slug}.csv`;
  const { rows: [b] } = await pool.query(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, duplicate_strategy, field_mapping, source_headers, batch_type, add_tags, override_fields)
     VALUES ($1, $2, $3, 'processing', $4, $5::jsonb, $6::jsonb, 'leads', $7::text[], $8::text[]) RETURNING id`,
    [by, filename, rows.length, strategy, JSON.stringify(MAPPING), JSON.stringify(HEADERS), recordTags ? tags.map((t) => t.trim()) : null, recordTags ? override : null]
  );
  const c = await importer.importRows(pool, rows, {
    batchId: b.id, filename, headers: HEADERS, fieldMapping: MAPPING, duplicateStrategy: strategy, overrideFields: override, addTags: tags.map((t) => t.trim()),
  });
  await pool.query(
    `UPDATE upload_batches SET status = $2, processed_rows = $3, inserted_rows = $4, merged_rows = $5, no_email_rows = $6, completed_at = now() WHERE id = $1`,
    [b.id, status, c.processed, c.inserted, c.merged, c.no_email]
  );
  return { id: b.id, filename, by, strategy, tags, override, counters: c };
}

const INPUT_COLS = ["written_full_name", "written_company", "found_by", "source"];
/** A made-up People (pipeline) table: the template's name and key, and the columns these checks read. */
async function peopleTable(tag) {
  const { rows: [t] } = await pool.query(
    `INSERT INTO enrich_tables (client_tag, kind, name, template, source_note) VALUES ($1, 'people', 'People (pipeline)', 'people_v1', 'test-upload-enrich-web: made up') RETURNING id`,
    [tag]
  );
  const cols = [...INPUT_COLS, "person_outcome", "use_work_email", ADD_COLUMN];
  for (const [i, key] of cols.entries()) {
    await pool.query(`INSERT INTO enrich_columns (table_id, key, name, position, kind, phase) VALUES ($1, $2, $3, $4, 'input', $5)`, [t.id, key, key, i + 1, key === ADD_COLUMN ? 4 : 1]);
  }
  return t.id;
}

/**
 * What the worker's move does for an upload (scripts/lib/enrich/upload-move.mjs):
 * a source row of kind upload, one People row per kept-back row (its key, its
 * inputs, the status asked for), and the upload_people row. Then what working
 * the rows would leave: the Outcome, the found address and any add cell.
 * plan[seq] = { status, outcome, email, add: [status, value, display] }.
 */
async function moveUpload(up, tag, tableId, plan) {
  const { rows: [src] } = await pool.query(
    `INSERT INTO enrich_sources (table_id, kind, external_id, label, created_by, meta) VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [tableId, UPLOAD_SOURCE_KIND, up.id, uploadSourceLabel(up.filename), up.by, JSON.stringify({ batch_id: up.id })]
  );
  const kept = await all(`SELECT seq, raw FROM upload_holdbacks WHERE batch_id = $1 ORDER BY seq`, [up.id]);
  const rowIds = {};
  for (const k of kept) {
    const p = plan[k.seq] ?? { status: "held" };
    const inputs = uploadPeopleInputs({ raw: k.raw, fieldMapping: MAPPING, clientTag: tag, filename: up.filename });
    const { rows: [r] } = await pool.query(
      `INSERT INTO enrich_rows (table_id, source_id, row_key, search_text, run_status) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [tableId, src.id, uploadRowKey(up.id, k.seq), peopleSearchText(inputs), p.status]
    );
    const cells = Object.entries(inputs).filter(([key]) => INPUT_COLS.includes(key));
    if (p.outcome) cells.push(["person_outcome", p.outcome]);
    if (p.email) cells.push(["use_work_email", p.email]);
    for (const [key, v] of cells) {
      await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display) VALUES ($1, $2, $3, 'done', $4::jsonb, left($5, 300))`, [r.id, key, tableId, JSON.stringify(v), v]);
    }
    if (p.add) {
      await pool.query(`INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [r.id, ADD_COLUMN, tableId, p.add[0], JSON.stringify(p.add[1]), p.add[2] ?? null]);
    }
    rowIds[k.seq] = Number(r.id);
  }
  await pool.query(`UPDATE enrich_sources SET received = $2, created = $2 WHERE id = $1`, [src.id, kept.length]);
  await pool.query(
    `INSERT INTO upload_people (batch_id, state, client_tag, table_id, source_id, next_seq, moved_rows, moved_at) VALUES ($1, 'moved', $2, $3, $4, $5, $5, now())`,
    [up.id, tag, tableId, src.id, kept.length]
  );
  return { sourceId: src.id, rowIds, kept: Object.fromEntries(kept.map((k) => [k.seq, k.raw])) };
}

const addCell = async (rowId) => (await one(`SELECT status, value, display, note FROM enrich_cells WHERE row_id = $1 AND column_key = $2`, [rowId, ADD_COLUMN])) ?? null;
const leadId = async (email) => (await one(`SELECT id FROM leads WHERE email = $1`, [email]))?.id;
/** Two objects with the same entries, in any key order. */
const sameEntries = (a, b) => same(Object.entries(a ?? {}).map(([k, v]) => [String(k), v]).sort(), Object.entries(b ?? {}).map(([k, v]) => [String(k), v]).sort());

/** A lead as these checks compare it: every column but its id and times, and its extra locations. */
/**
 * A lead that was in the database long before any round: its 'created'
 * history line moved five hours back (a dead round here is four hours old). A
 * round reads a lead as its own by that line, so a lead made here a moment
 * before a round must not hang on the database clock between two
 * transactions: the local database's clock was seen to step back about 0.2 s
 * every few seconds.
 */
async function madeLongAgo(email) {
  await pool.query(
    `UPDATE lead_history SET created_at = now() - interval '5 hours' WHERE event_type = 'created' AND lead_id = (SELECT id FROM leads WHERE email = $1)`,
    [email]
  );
}

async function leadState(db, email) {
  const { rows: [l] } = await db.query(`SELECT * FROM leads WHERE email = $1`, [email]);
  if (!l) return null;
  const { rows: locs } = await db.query(
    `SELECT city_text, state_text, state_code, country_code, source FROM lead_locations WHERE lead_id = $1 ORDER BY city_text, state_text, state_code`,
    [l.id]
  );
  for (const k of ["id", "created_at", "updated_at", "validated_at", "bounced_at", "categorized_at", "bounce_checked_at"]) delete l[k];
  return JSON.stringify({ lead: Object.fromEntries(Object.entries(l).sort(([a], [b]) => (a < b ? -1 : 1))), locs });
}

/**
 * The control: the same kept-back row uploaded directly with the address typed
 * into its email column (and the cells that described the missing address
 * blank, as decision 7 has it), through the upload's own import config, in a
 * dry run that is rolled back. The lead it would leave.
 */
async function directUpload(up, raw, email) {
  const typed = HEADERS.map((_, i) => (i === EMAIL_COL ? email : ADDRESS_COLS.includes(i) ? "" : String(raw[i] ?? "")));
  let seen = null;
  await importer.importRows(pool, [typed], {
    batchId: up.id, filename: up.filename, headers: HEADERS, fieldMapping: MAPPING, duplicateStrategy: up.strategy,
    overrideFields: up.override, addTags: up.tags.map((t) => t.trim()),
    dryRun: { inspect: async (c) => { seen = await leadState(c, email); } },
  });
  return seen;
}

// ── P. The upload route ─────────────────────────────────────────────────────

async function partP() {
  section("P. The upload route records the tags and the replace fields");
  const { POST } = await route("uploads/process");
  const config = (over) => encodeURIComponent(JSON.stringify({ headers: HEADERS, fieldMapping: MAPPING, filename: `${FILE}-p.csv`, delimiter: ",", ...over }));
  const csv = [HEADERS, person("Pat", "Lane", { email: "N/A" })].map((r) => r.join(",")).join("\n");
  const inserts = () => T.supa.filter((o) => o.table === "upload_batches" && o.action === "insert").map((o) => o.payload);
  as("manager");
  T.supa.length = 0;
  let r = await call(POST, { raw: csv, headers: { "X-Upload-Config": config({ duplicateStrategy: "replace", overrideFields: ["city", "state", 7], addTags: [" uptest_c ", "Q4 list"] }) } });
  const a = inserts()[0];
  check("a generic upload: 202, and its batch records the tags as the import gets them (trimmed) and the fields its replace rule chose",
    r.status === 202 && same(a?.add_tags, ["uptest_c", "Q4 list"]) && same(a?.override_fields, ["city", "state"]) && a?.duplicate_strategy === "replace" && a?.batch_type === "leads",
    JSON.stringify({ status: r.status, body: r.body, a }));
  const deferred = T.after.length;
  T.after.length = 0; // the import of this made-up row is not run
  check("... the import itself still runs after the answer (one after() callback), as before", deferred === 1, String(deferred));
  T.supa.length = 0;
  r = await call(POST, { raw: csv, headers: { "X-Upload-Config": config({ duplicateStrategy: "merge" }) } });
  T.after.length = 0;
  check("an upload with no tags and no replace fields records empty lists, never null (null means made before 130)",
    r.status === 202 && same(inserts()[0]?.add_tags, []) && same(inserts()[0]?.override_fields, []), JSON.stringify(inserts()[0]));
  T.supa.length = 0;
  const bison = ["email,first_name", ",Pat"].join("\n");
  r = await call(POST, {
    raw: bison,
    headers: { "X-Upload-Config": encodeURIComponent(JSON.stringify({ headers: ["email", "first_name"], filename: `${FILE}-bison.csv`, format: "bison", duplicateStrategy: "skip", addTags: ["UPTEST_D"] })) },
  });
  check("an Email Bison export records them too (no field mapping, so the worker never takes it)",
    r.status === 200 && same(inserts()[0]?.add_tags, ["UPTEST_D"]) && same(inserts()[0]?.override_fields, []) && inserts()[0]?.field_mapping === null,
    JSON.stringify({ status: r.status, ins: inserts()[0] }));
  T.supa.length = 0;
  r = await call(POST, { raw: csv, headers: { "X-Upload-Config": config({ duplicateStrategy: "merge", addTags: ["bad,tag"] }) } });
  check("a refused upload (bad tags) still makes no batch", r.status === 400 && inserts().length === 0, JSON.stringify(r.body));
  const routeSrc = source("src/app/api/uploads/process/route.ts");
  check("the import still gets addTags trimmed and the replace fields as sent, as before",
    /addTags: addTags\.map\(\(t\) => t\.trim\(\)\),\s*onProgress/.test(routeSrc) && /batchId, filename, headers, fieldMapping, duplicateStrategy, overrideFields,/.test(routeSrc));
  T.supa.length = 0;
}

// ── R and A. Rounds ──────────────────────────────────────────────────────────

const ctx = {};

async function partR() {
  const people = await route("uploads/people");
  const auto = await route("uploads/found/auto");
  ctx.people = people;
  ctx.auto = auto;

  section("R1. A round through the button: the batch, the cells, then the import");
  // U1: merge, tags with the client's tag in lower case beside another tag.
  const e1 = mail("bob");
  await pool.query(`INSERT INTO leads (email, first_name, company, tags, city) VALUES ($1, 'Bob', 'Bob Co', 'Outlook', NULL)`, [e1]);
  await madeLongAgo(e1);
  const u1 = await makeUpload("u1", {
    strategy: "merge",
    tags: ["uptest_c", "Q4 list"],
    rows: [
      person("Jane", "Doe", { email: "N/A" }), // seq 0: found, a new lead
      person("Bob", "Ray", { email: "", title: "Facilities Lead", city: "Denver", state: "Colorado" }), // seq 1: found, the existing lead e1
      person("Cara", "Fox", { email: "--" }), // seq 2: the address found can't be stored
      person("Dan", "Gil", { email: "" }), // seq 3: approved, being worked again
      person("Eve", "Hay", { email: "" }), // seq 4: no email found
      person("Fay", "Ito", { email: "none" }), // seq 5: found, row waiting
      person("Gus", "Jay", { email: "" }), // seq 6: found, kept-back row gone
      person("Hal", "Kim", { email: "" }), // seq 7: held
      person("Ida", "Lee", { email: mail("ida") }), // has an email: a lead from the upload itself
    ],
  });
  check("the upload kept back 8 rows and made 1 lead, through the real import", u1.counters.no_email === 8 && u1.counters.inserted === 1, JSON.stringify(u1.counters));
  ctx.u1 = u1;
  ctx.tC = await peopleTable(UC);
  ctx.tD = await peopleTable(UD);
  const A = APPROVED_OUTCOME;
  const m1 = await moveUpload(u1, UC, ctx.tC, {
    0: { status: "done", outcome: A, email: ` ${mail("jane").toUpperCase()} ` },
    1: { status: "done", outcome: A, email: e1 },
    2: { status: "done", outcome: A, email: "not-an-address" },
    3: { status: "queued", outcome: A, email: mail("dan") },
    4: { status: "done", outcome: "No email yet" },
    5: { status: "waiting", outcome: A, email: mail("fay") },
    6: { status: "done", outcome: A, email: mail("gus") },
    7: { status: "held" },
  });
  ctx.m1 = m1;
  await pool.query(`DELETE FROM upload_holdbacks WHERE batch_id = $1 AND seq = 6`, [u1.id]);
  // The controls, before anything is added: the same rows uploaded directly with the addresses typed in.
  const control = {
    jane: await directUpload(u1, m1.kept[0], mail("jane")),
    bob: await directUpload(u1, m1.kept[1], e1),
    fay: await directUpload(u1, m1.kept[5], mail("fay")),
  };
  check("the controls see Jane and Fay as new leads and Bob merged into his lead (dry runs, nothing kept)",
    control.jane && control.fay && control.bob && (await one(`SELECT count(*)::int AS n FROM leads WHERE email = ANY($1::text[])`, [[mail("jane"), mail("fay")]])).n === 0);

  as("manager");
  T.audits.length = 0;
  const auditBefore = T.audits.length;
  let r = await call(people.POST, { body: { action: "add_found", batch: u1.id.toUpperCase() } });
  const r1 = r.body?.batchId;
  check("the button (the upload's own manager): 202, 3 to add, 2 settled at once (an address the import can't store, a row that is gone)",
    r.status === 202 && typeof r1 === "string" && r.body.adding === 3 && r.body.settled === 2, JSON.stringify(r));
  const round = await one(`SELECT * FROM upload_batches WHERE id = $1`, [r1]);
  check("the round is its own batch: 'Emails found', linked to the upload, the upload's rule, its tags, its replace fields, its header row and mapping",
    round?.source_label === FOUND_SOURCE_LABEL && round.source_batch_id === u1.id && round.duplicate_strategy === "merge" && same(round.add_tags, foundTags(["uptest_c", "Q4 list"], UC)) &&
      same(round.override_fields, []) && same(round.source_headers, HEADERS) && sameEntries(round.field_mapping, MAPPING) &&
      round.status === "processing" && round.total_rows === 3 && round.uploaded_by === USERS.manager && round.batch_type === "leads" &&
      round.filename.startsWith(`${FOUND_SOURCE_LABEL} · ${u1.filename} · `),
    JSON.stringify(round));
  const cells = Object.fromEntries(await Promise.all(Object.entries(m1.rowIds).map(async ([seq, id]) => [seq, await addCell(id)])));
  check("Jane, Bob and Fay read 'Adding…', running for this round",
    [0, 1, 5].every((s) => cells[s]?.status === "running" && cells[s].value?.batch_id === r1 && cells[s].display === "Adding…"), JSON.stringify(cells));
  check("Cara's address is settled 'Not added' for good (reason address, no round), Gus's too (his row is gone)",
    cells[2]?.status === "done" && same(cells[2].value, { added: false, reason: "address", batch_id: null }) && cells[2].display === "Not added" &&
      cells[6]?.status === "done" && same(cells[6].value, { added: false, reason: "row", batch_id: null }) && cells[6].display === "Not added",
    JSON.stringify([cells[2], cells[6]]));
  check("Dan (being worked), Eve (no email) and Hal (held) are left alone", cells[3] === null && cells[4] === null && cells[7] === null);
  r = await call(people.POST, { body: { action: "add_found", batch: u1.id } });
  check("a second press while the round is live: 409, busy", r.status === 409 && /being added already/.test(r.body?.error ?? ""), JSON.stringify(r));
  check("... and nothing was added before the answer: the import waits in after()", T.after.length === 1 && (await one(`SELECT count(*)::int AS n FROM leads WHERE email = $1`, [mail("jane")])).n === 0);
  await drainAfter();
  const done = await one(`SELECT status, inserted_rows, merged_rows, error_rows, no_email_rows, esp_detected, processed_rows FROM upload_batches WHERE id = $1`, [r1]);
  check("the round's import finished: 2 new leads, 1 merged, no errors, and its counters on the batch",
    done.status === "complete" && done.inserted_rows === 2 && done.merged_rows === 1 && done.error_rows === 0 && done.no_email_rows === 0 && done.processed_rows === 3,
    JSON.stringify(done));
  const after1 = Object.fromEntries(await Promise.all([0, 1, 5].map(async (s) => [s, await addCell(m1.rowIds[s])])));
  check("Jane and Fay read 'Added' with their new lead and the round",
    [[0, mail("jane")], [5, mail("fay")]].every(([s]) => after1[s]?.status === "done" && after1[s].value?.added === true && after1[s].value.batch_id === r1 && after1[s].display === "Added") &&
      after1[0].value.lead_id === (await leadId(mail("jane"))) && after1[5].value.lead_id === (await leadId(mail("fay"))),
    JSON.stringify(after1));
  check("Bob reads 'Already in the database': the lead was there, and the upload's rule (merge) applied to it",
    after1[1]?.status === "done" && after1[1].value?.added === false && after1[1].value.reason === "lead" && after1[1].value.lead_id === (await leadId(e1)) &&
      after1[1].display === "Already in the database" && /merge/.test(after1[1].note ?? ""),
    JSON.stringify(after1[1]));

  section("R2. The same lead a direct upload of the row with that email makes");
  const real = { jane: await leadState(pool, mail("jane")), bob: await leadState(pool, e1), fay: await leadState(pool, mail("fay")) };
  for (const who of ["jane", "bob", "fay"]) {
    check(`${who}: every field and extra location as the direct upload leaves it`, real[who] !== null && real[who] === control[who], `${real[who]}\n${control[who]}`);
  }
  const jane = await one(`SELECT tags, validation_status, esp, notes, company, domain, state, title FROM leads WHERE email = $1`, [mail("jane")]);
  check("... the upload's tags (the client's once), no validation status, the provider of the found address, the upload's own cells",
    jane.tags === "uptest_c,Q4 list" && jane.validation_status === null && jane.esp === "Google" && jane.notes === "kept" && jane.company === "Jane Co" &&
      jane.domain === `jane-co.${HOST}` && jane.state === "IL" && jane.title === "Office Manager",
    JSON.stringify(jane));
  const bob = await one(`SELECT tags, title, last_name, city FROM leads WHERE email = $1`, [e1]);
  const bobHistory = await one(`SELECT h.notes FROM lead_history h JOIN leads l ON l.id = h.lead_id WHERE l.email = $1 AND h.event_type = 'updated' ORDER BY h.created_at DESC LIMIT 1`, [e1]);
  check("... Bob's lead: blank fields filled, its own tag kept and the upload's added, the merge noted with the round's name",
    bob.tags === "Outlook,uptest_c,Q4 list" && bob.title === "Facilities Lead" && bob.last_name === "Ray" && bob.city === "Denver" &&
      bobHistory?.notes === `Merged from upload: ${round.filename}`,
    JSON.stringify({ bob, bobHistory }));

  section("R3. Again: nobody is taken twice");
  r = await call(people.POST, { body: { action: "add_found", batch: u1.id } });
  check("a second round takes nobody: 202, no batch, nobody to add or settle", r.status === 202 && r.body.batchId === null && r.body.adding === 0 && r.body.settled === 0, JSON.stringify(r));
  check("... and leaves no round behind", (await one(`SELECT count(*)::int AS n FROM upload_batches WHERE source_batch_id = $1`, [u1.id])).n === 1);
  const buttonAudits = T.audits.slice(auditBefore).filter((x) => x.action === "upload_found");
  check("each press wrote one audit line: the client, the upload, how many, the round, and never an address",
    buttonAudits.length === 2 && buttonAudits[0].details === `${UC}: upload ${u1.id}, 3 to add, 2 settled, round ${r1}` && buttonAudits[0].performedBy === USERS.manager &&
      buttonAudits[1].details === `${UC}: upload ${u1.id}, 0 to add, 0 settled` && buttonAudits.every((x) => !x.details.includes("@")),
    JSON.stringify(buttonAudits));
  ctx.r1 = r1;
}

async function partA() {
  const { auto, people } = ctx;
  section("A. POST /api/uploads/found/auto: the worker's request");
  const key = `upweb-${randomUUID()}-${randomUUID()}`;
  const bearer = { authorization: `Bearer ${key}` };
  let r = await call(auto.POST, { body: { batch: ctx.u1.id }, headers: bearer });
  check("no AIARK_AUTO_ADD_KEY on the web app: 503, automatic adding is off", r.status === 503, JSON.stringify(r));
  process.env.AIARK_AUTO_ADD_KEY = "too-short";
  r = await call(auto.POST, { body: { batch: ctx.u1.id }, headers: bearer });
  check("a key under 32 characters counts as none: 503", r.status === 503, JSON.stringify(r));
  process.env.AIARK_AUTO_ADD_KEY = key;
  r = await call(auto.POST, { body: { batch: ctx.u1.id }, headers: { authorization: `Bearer ${key}x` } });
  const noHeader = await call(auto.POST, { body: { batch: ctx.u1.id } });
  check("a wrong key, or none: 401 with WWW-Authenticate", r.status === 401 && r.headers?.["WWW-Authenticate"] === "Bearer" && noHeader.status === 401, JSON.stringify([r, noHeader]));
  const bad = [
    await call(auto.POST, { raw: "{not json", headers: bearer }),
    await call(auto.POST, { body: null, headers: bearer }),
    await call(auto.POST, { body: { batch: "not-a-uuid" }, headers: bearer }),
    await call(auto.POST, { body: { run: ctx.u1.id }, headers: bearer }),
  ];
  check("a body that is not JSON, null, or without an upload id: 400", bad.every((x) => x.status === 400), JSON.stringify(bad.map((x) => x.status)));
  r = await call(auto.POST, { body: { batch: randomUUID() }, headers: bearer });
  check("an upload that does not exist: 404", r.status === 404, JSON.stringify(r));
  const audits = T.audits.length;
  r = await call(auto.POST, { body: { batch: ctx.u1.id }, headers: bearer });
  check("an upload with nobody left to add: 202, nobody, and no audit line for an automatic round that found nothing",
    r.status === 202 && r.body.batchId === null && r.body.adding === 0 && T.audits.length === audits, JSON.stringify(r));

  section("A2. A round the worker asks for (skip), and its people");
  const e2 = mail("kim");
  await pool.query(`INSERT INTO leads (email, first_name, last_name, title, company, tags) VALUES ($1, 'Kim', 'Old', 'Old Title', 'Kim Old Co', 'Outlook')`, [e2]);
  await madeLongAgo(e2);
  const u2 = await makeUpload("u2", {
    strategy: "skip",
    tags: [UC],
    rows: [person("Kim", "Moe", { email: "", title: "New Title" }), person("Lou", "Nye", { email: "" })],
  });
  const m2 = await moveUpload(u2, UC, ctx.tC, {
    0: { status: "done", outcome: APPROVED_OUTCOME, email: e2 },
    1: { status: "done", outcome: APPROVED_OUTCOME, email: mail("lou") },
  });
  const control = { kim: await directUpload(u2, m2.kept[0], e2), lou: await directUpload(u2, m2.kept[1], mail("lou")) };
  r = await call(auto.POST, { body: { batch: u2.id }, headers: bearer });
  check("the worker's request: 202, 2 to add", r.status === 202 && r.body.adding === 2 && typeof r.body.batchId === "string", JSON.stringify(r));
  const autoAudit = T.audits.at(-1);
  check("... one audit line, marked automatic, with no user", autoAudit?.action === "upload_found" && autoAudit.performedBy === null &&
    autoAudit.details === `${UC}: upload ${u2.id} (automatic), 2 to add, 0 settled, round ${r.body.batchId}`, JSON.stringify(autoAudit));
  const round = await one(`SELECT uploaded_by, duplicate_strategy, add_tags FROM upload_batches WHERE id = $1`, [r.body.batchId]);
  check("... the round is the uploader's, with the upload's rule (skip) and tags", round.uploaded_by === USERS.manager && round.duplicate_strategy === "skip" && same(round.add_tags, [UC]), JSON.stringify(round));
  await drainAfter();
  const kim = await addCell(m2.rowIds[0]);
  const lou = await addCell(m2.rowIds[1]);
  check("under skip: Kim's lead is left as it was ('Already in the database'), Lou is added",
    kim?.display === "Already in the database" && /skip/.test(kim.note ?? "") && lou?.display === "Added" &&
      (await one(`SELECT title FROM leads WHERE email = $1`, [e2])).title === "Old Title",
    JSON.stringify({ kim, lou }));
  check("... and both leads are what a direct upload of the rows with those emails leaves",
    (await leadState(pool, e2)) === control.kim && (await leadState(pool, mail("lou"))) === control.lou && control.kim !== null && control.lou !== null);
  ctx.u2 = u2;
  ctx.key = key;
  ctx.bearer = bearer;

  section("A3. A round that died, and people a round could not store");
  const u3 = await makeUpload("u3", {
    strategy: "merge",
    tags: [UC],
    rows: [person("Max", "Orr", { email: "" }), person("Ned", "Poe", { email: "" }), person("Oli", "Que", { email: "" }), person("Pia", "Roy", { email: "" })],
  });
  // A round left processing by a restart, four hours ago.
  const { rows: [dead] } = await pool.query(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, duplicate_strategy, batch_type, source_label, source_batch_id, add_tags, created_at)
     VALUES ($1, $2, 3, 'processing', 'merge', 'leads', $3, $4, $5::text[], now() - interval '4 hours') RETURNING id`,
    [USERS.manager, `${FOUND_SOURCE_LABEL} · ${u3.filename} · dead`, FOUND_SOURCE_LABEL, u3.id, [UC]]
  );
  const { rows: [finished] } = await pool.query(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, batch_type, source_label, source_batch_id)
     VALUES ($1, $2, 1, 'complete', 'leads', $3, $4) RETURNING id`,
    [USERS.manager, `${FOUND_SOURCE_LABEL} · ${u3.filename} · finished`, FOUND_SOURCE_LABEL, u3.id]
  );
  const m3 = await moveUpload(u3, UC, ctx.tC, {
    0: { status: "done", outcome: APPROVED_OUTCOME, email: mail("max"), add: ["running", { batch_id: dead.id }, "Adding…"] },
    1: { status: "done", outcome: APPROVED_OUTCOME, email: mail("ned"), add: ["running", { batch_id: dead.id }, "Adding…"] },
    2: { status: "done", outcome: APPROVED_OUTCOME, email: mail("oli"), add: ["running", { batch_id: dead.id }, "Adding…"] },
    3: { status: "done", outcome: APPROVED_OUTCOME, email: mail("pia"), add: ["error", { batch_id: finished.id }, "Not added"] },
  });
  // The dead round made Max's lead before it died; Oli's lead was there long before it.
  await pool.query(`INSERT INTO leads (email, first_name, company) VALUES ($1, 'Max', 'Max Co'), ($2, 'Oli', 'Oli Co')`, [mail("max"), mail("oli")]);
  await madeLongAgo(mail("oli"));
  r = await call(auto.POST, { body: { batch: u3.id }, headers: bearer });
  const max = await addCell(m3.rowIds[0]);
  const deadAfter = await one(`SELECT status, error_log FROM upload_batches WHERE id = $1`, [dead.id]);
  check("the worker's request: the dead round is marked an error (Stalled), Max is settled as added by it, Ned and Oli are taken again, Pia is not",
    r.status === 202 && r.body.adding === 2 && r.body.settled === 1 && deadAfter.status === "error" && /^Stalled/.test(deadAfter.error_log?.[0] ?? "") &&
      max?.display === "Added" && max.value?.batch_id === dead.id && max.value.lead_id === (await leadId(mail("max"))),
    JSON.stringify({ r, deadAfter, max }));
  const roundNed = r.body.batchId;
  await drainAfter();
  const ned = await addCell(m3.rowIds[1]);
  const oli = await addCell(m3.rowIds[2]);
  const pia = await addCell(m3.rowIds[3]);
  check("... Ned is added by the new round, Oli's lead was there before the dead round (merge applied), Pia still reads 'Not added'",
    ned?.display === "Added" && ned.value?.batch_id === roundNed && oli?.display === "Already in the database" && oli.value?.batch_id === roundNed &&
      pia?.status === "error" && pia.value?.batch_id === finished.id,
    JSON.stringify({ ned, oli, pia }));
  as("manager");
  r = await call(people.POST, { body: { action: "add_found", batch: u3.id } });
  await drainAfter();
  const piaAfter = await addCell(m3.rowIds[3]);
  check("the button takes again the people a round could not store: Pia is added", r.status === 202 && r.body.adding === 1 && piaAfter?.display === "Added", JSON.stringify({ r, piaAfter }));

  section("A4. Settling: only cells still running for the round");
  const fake = randomUUID();
  const other = randomUUID();
  const u3a = m3.rowIds[0];
  await pool.query(`UPDATE enrich_cells SET status = 'running', value = $3::jsonb WHERE row_id = $1 AND column_key = $2`, [u3a, ADD_COLUMN, JSON.stringify({ batch_id: fake })]);
  await pool.query(`UPDATE enrich_cells SET status = 'running', value = $3::jsonb WHERE row_id = $1 AND column_key = $2`, [m3.rowIds[1], ADD_COLUMN, JSON.stringify({ batch_id: other })]);
  await found.finishFound(pool, {
    tableId: ctx.tC, batchId: fake, batchAt: new Date().toISOString(), strategy: "merge",
    people: [{ row_id: u3a, email: mail("nobody") }, { row_id: m3.rowIds[1], email: mail("ned") }],
  });
  const a = await addCell(u3a);
  const b = await addCell(m3.rowIds[1]);
  check("finishFound: no lead for the address is 'Not added' (an error the button takes again); a cell another round holds is left alone",
    a?.status === "error" && same(a.value, { batch_id: fake }) && a.display === "Not added" && b?.status === "running" && b.value?.batch_id === other,
    JSON.stringify({ a, b }));
  // Put both back as they were settled.
  await pool.query(`UPDATE enrich_cells SET status = 'done', value = $3::jsonb, display = 'Added' WHERE row_id = ANY($1::bigint[]) AND column_key = $2`, [[u3a, m3.rowIds[1]], ADD_COLUMN, JSON.stringify({ added: true })]);
  ctx.u3 = u3;
}

// ── S. Send ─────────────────────────────────────────────────────────────────

async function partS() {
  const { people } = ctx;
  section("S. Send an upload's no-email rows by hand");
  // An upload made before 130 (no tags recorded), one the worker did not send, one it has still to read, one still importing, one with no kept-back rows.
  const before = await makeUpload("u4", { recordTags: false, rows: [person("Quin", "Sol", { email: "" }), person("Rae", "Tam", { email: "" })] });
  const several = await makeUpload("u5", { tags: [UC, UD], rows: [person("Sam", "Uno", { email: "" })] });
  await pool.query(`INSERT INTO upload_people (batch_id, state, reason) VALUES ($1, 'not_sent', 'several')`, [several.id]);
  const undecided = await makeUpload("u6", { tags: [UC], rows: [person("Tia", "Vos", { email: "" })] });
  const importing = await makeUpload("u7", { tags: [UC], rows: [person("Uma", "Wey", { email: "" })], status: "processing" });
  const noKept = await makeUpload("u8", { tags: [UC], rows: [person("Val", "Xu", { email: mail("val") })] });
  const { rows: [aiark] } = await pool.query(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, batch_type, source_label, field_mapping) VALUES ($1, $2, 1, 'complete', 'leads', 'AI Ark', '{}'::jsonb) RETURNING id`,
    [USERS.manager, `${FILE}-aiark`]
  );
  ctx.s = { before, several, undecided, importing, noKept, aiark: aiark.id };
  const send = (batch, tag) => call(people.POST, { body: { action: "send", batch, tag } });

  as("manager");
  let r = await send(before.id, UD);
  check("a manager may not send: 403", r.status === 403, JSON.stringify(r));
  as("admin");
  r = await send(before.id, "UPTEST_NOT_A_CLIENT");
  const blank = await send(before.id, "  ");
  check("a tag that is not a client tag, or none: 400, nothing written",
    r.status === 400 && /not a client tag/.test(r.body?.error ?? "") && blank.status === 400 && !(await one(`SELECT 1 AS x FROM upload_people WHERE batch_id = $1`, [before.id])),
    JSON.stringify([r, blank]));
  const auditsBefore = T.audits.length;
  r = await send(before.id, ` ${UD.toLowerCase()} `);
  const row = await one(`SELECT state, reason, client_tag, sent_by, next_seq, table_id, source_id FROM upload_people WHERE batch_id = $1`, [before.id]);
  check("an upload made before 130: sent to the client picked (the tag as client_tags holds it), moving, by the admin, from the start",
    r.status === 200 && r.body.state === "moving" && r.body.client_tag === UD && row?.state === "moving" && row.client_tag === UD && row.reason === null &&
      row.sent_by === USERS.admin && row.next_seq === 0 && row.table_id === null && row.source_id === null,
    JSON.stringify({ r, row }));
  const sendAudit = T.audits.slice(auditsBefore);
  check("... one audit line naming the upload and the tag", sendAudit.length === 1 && sendAudit[0].action === "upload_people_send" && sendAudit[0].performedBy === USERS.admin &&
    sendAudit[0].details.startsWith(`${UD}: upload ${before.id}, its no-email rows sent to the People table by hand`), JSON.stringify(sendAudit));
  r = await send(before.id, UC);
  check("sending it again (to any client): 409, it stays with the first", r.status === 409 && (await one(`SELECT client_tag FROM upload_people WHERE batch_id = $1`, [before.id])).client_tag === UD, JSON.stringify(r));
  r = await send(several.id, UC);
  const sev = await one(`SELECT state, reason, client_tag, sent_by FROM upload_people WHERE batch_id = $1`, [several.id]);
  check("an upload the worker did not send (two client tags): sent to the one picked, its reason cleared",
    r.status === 200 && sev.state === "moving" && sev.reason === null && sev.client_tag === UC && sev.sent_by === USERS.admin, JSON.stringify({ r, sev }));
  const refused = {
    undecided: await send(undecided.id, UC),
    importing: await send(importing.id, UC),
    noKept: await send(noKept.id, UC),
    aiark: await send(aiark.id, UC),
    missing: await send(randomUUID(), UC),
    moved: await send(ctx.u1.id, UD),
  };
  check("never one whose tags the worker has still to read, one still importing, one with nothing kept back, a batch that is not an upload, or one already sent",
    refused.undecided.status === 409 && /worker decides/.test(refused.undecided.body?.error ?? "") && refused.importing.status === 409 && refused.noKept.status === 409 &&
      refused.aiark.status === 409 && refused.missing.status === 404 && refused.moved.status === 409 &&
      (await one(`SELECT count(*)::int AS n FROM upload_people WHERE batch_id = ANY($1::uuid[])`, [[undecided.id, importing.id, noKept.id, aiark.id]])).n === 0,
    JSON.stringify(Object.fromEntries(Object.entries(refused).map(([k, v]) => [k, v.status]))));
  const odd = [
    await call(people.POST, { body: { action: "send", batch: "nope", tag: UC } }),
    await call(people.POST, { body: { action: "delete", batch: before.id } }),
    await call(people.POST, { raw: "not json" }),
  ];
  check("a bad upload id, an unknown action, a body that is not JSON: 400", odd.every((x) => x.status === 400), JSON.stringify(odd.map((x) => x.status)));
  as(null);
  r = await send(before.id, UC);
  check("no session: 401", r.status === 401);
}

// ── G. Where the rows stand ─────────────────────────────────────────────────

async function partG() {
  const { people, u1, s } = ctx;
  section("G. GET /api/uploads/people: the states and the counts");
  as("manager");
  T.worker = heartbeat({ foundAuto: false });
  let r = await call(people.GET, { query: { batch: u1.id } });
  const v = r.body?.batches?.[u1.id];
  check("the upload's own manager sees it: moved to the client's People table, why in plain words, the table, its rules, the switch off",
    r.status === 200 && v?.state === "moved" && v.client_tag === UC && v.why === `In ${UC}'s People table.` && v.table_id === ctx.tC && v.targeting === true &&
      v.switched_on === false && v.kept_back === 8 && v.moved === 8,
    JSON.stringify(v));
  check("... its People rows by status: 1 held, 1 queued, 1 waiting, 5 done",
    same(v?.rows, { held: 1, queued: 1, running: 0, waiting: 1, done: 5, error: 0 }), JSON.stringify(v?.rows));
  check("... 6 found (approved, or with an add result), 2 added, 1 already in the database, 2 not added, nobody adding, 1 not found",
    v?.found === 6 && v.added === 2 && v.already === 1 && v.failed === 2 && v.adding === 0 && v.not_found === 1, JSON.stringify(v));
  check("... the rounds, newest first, with their counters", v?.rounds?.length === 1 && v.rounds[0].id === ctx.r1 && v.rounds[0].inserted === 2 && v.rounds[0].merged === 1 && v.rounds[0].status === "complete",
    JSON.stringify(v?.rounds));
  check("... and the worker: online, it copies upload rows, it does not add found emails by itself", same(r.body.worker, { online: true, moves: true, found_auto: false }), JSON.stringify(r.body.worker));
  T.worker = heartbeat({ moves: false });
  r = await call(people.GET, { query: { batch: u1.id } });
  const noMoves = r.body.worker;
  T.worker = null;
  r = await call(people.GET, { query: { batch: u1.id } });
  check("a worker without upload_people says so; no worker at all reads null", noMoves?.moves === false && r.body.worker === null, JSON.stringify([noMoves, r.body.worker]));

  const ids = [s.before.id, s.several.id, s.undecided.id, s.importing.id, s.noKept.id, s.aiark, ctx.u2.id];
  as("admin");
  r = await call(people.GET, { query: { batches: ids.join(",") } });
  const st = Object.fromEntries(ids.map((id) => [id, r.body?.batches?.[id]?.state]));
  check("each state: an upload sent by hand is moving, one still to read undecided, one importing processing, none for nothing kept back and for an AI Ark batch",
    r.status === 200 && st[s.before.id] === "moving" && st[s.several.id] === "moving" && st[s.undecided.id] === "undecided" && st[s.importing.id] === "processing" &&
      st[s.noKept.id] === "none" && st[s.aiark] === "none" && st[ctx.u2.id] === "moved",
    JSON.stringify(st));
  check("... a moving upload with nothing copied yet says the worker is copying it", /The worker is copying this upload's no-email rows into UPTEST_D's People table/.test(r.body.batches[s.before.id]?.why ?? ""),
    r.body.batches[s.before.id]?.why);
  // Two more states, made by hand for the words: before 130 and never sent, and not sent.
  const before2 = await makeUpload("u9", { recordTags: false, rows: [person("Wes", "Yan", { email: "" })] });
  const notSent = await makeUpload("u10", { tags: ["Q4 list"], rows: [person("Xia", "Zed", { email: "" })] });
  await pool.query(`INSERT INTO upload_people (batch_id, state, reason) VALUES ($1, 'not_sent', 'not_client')`, [notSent.id]);
  r = await call(people.GET, { query: { batches: `${before2.id},${notSent.id}` } });
  const b2 = r.body.batches[before2.id];
  const ns = r.body.batches[notSent.id];
  check("an earlier upload reads before, and one not sent reads not_sent with the reason's words and how to send it",
    b2?.state === "before" && /made before uploads recorded their tags/.test(b2.why) && ns?.state === "not_sent" && ns.reason === "not_client" &&
      ns.why.startsWith(NOT_SENT_WHY.not_client) && /An admin can send them/.test(ns.why) && ns.client_tag === null && ns.found === 0,
    JSON.stringify({ b2, ns }));

  section("G1. The words for a deleted People table and a copy that waits, and the button on uploads that were not sent");
  const base = { isUpload: true, final: true, hasKept: true, tagsKnown: true, reason: null, clientTag: UC, tableId: ctx.tC, sourceId: randomUUID(), nextSeq: 3, movedRows: 3, keptBack: 10 };
  const why = (over) => found.peopleWhy({ ...base, ...over });
  check("moved, its table deleted: the found people can't be added any more; moving, its table deleted: the rest go to a new one",
    why({ state: "moved", tableId: null, sourceId: null }) === `${UC}'s People table was deleted, so this upload's found people can't be added any more.` &&
      why({ state: "moving", tableId: null, sourceId: null }) === `${UC}'s People table was deleted. The worker copies the rows it had not copied yet into a new one.`);
  check("moving: how far the copy got, or what it waits for and when it tries again",
    why({ state: "moving" }) === `Being copied into ${UC}'s People table: 3 of 10 rows so far.` &&
      why({ state: "moving", reason: "originals_missing", tableId: null, sourceId: null, nextSeq: 0 }).endsWith("The worker tries again every 10 minutes."));
  const gone = await makeUpload("u11", { tags: [UC], rows: [person("Yul", "Abe", { email: "" })] });
  await pool.query(
    `INSERT INTO upload_people (batch_id, state, client_tag, next_seq, moved_rows, moved_at) VALUES ($1, 'moved', $2, 1, 1, now())`,
    [gone.id, UC]
  );
  as("admin");
  r = await call(people.GET, { query: { batch: gone.id } });
  const pressed = {
    gone: await call(people.POST, { body: { action: "add_found", batch: gone.id } }),
    notSent: await call(people.POST, { body: { action: "add_found", batch: notSent.id } }),
    before: await call(people.POST, { body: { action: "add_found", batch: before2.id } }),
    undecided: await call(people.POST, { body: { action: "add_found", batch: s.undecided.id } }),
    copying: await call(people.POST, { body: { action: "add_found", batch: s.before.id } }),
    aiark: await call(people.POST, { body: { action: "add_found", batch: s.aiark } }),
  };
  check("an upload whose People table was deleted says so",
    r.body.batches[gone.id]?.state === "moved" && /People table was deleted/.test(r.body.batches[gone.id]?.why ?? "") && r.body.batches[gone.id].table_id === null,
    JSON.stringify(r.body.batches[gone.id]));
  check("the button on an upload with no People rows to add: 409 with the reason in plain words, nothing made",
    Object.values(pressed).every((x) => x.status === 409) && /was deleted/.test(pressed.gone.body.error) && pressed.notSent.body.error.startsWith(NOT_SENT_WHY.not_client) &&
      /made before uploads recorded their tags/.test(pressed.before.body.error) && /within a minute/.test(pressed.undecided.body.error) &&
      /Nothing to add yet/.test(pressed.copying.body.error) && /not an upload/.test(pressed.aiark.body.error) &&
      (await one(`SELECT count(*)::int AS n FROM upload_batches WHERE source_batch_id = ANY($1::uuid[])`, [[gone.id, notSent.id, before2.id, s.undecided.id, s.before.id]])).n === 0,
    JSON.stringify(Object.fromEntries(Object.entries(pressed).map(([k, v]) => [k, [v.status, v.body?.error]]))));

  section("G2. The manager rule, roles and the ids asked for");
  as("other");
  r = await call(people.GET, { query: { batch: u1.id } });
  const list = await call(people.GET, { query: { batches: `${u1.id},${ctx.u2.id}` } });
  check("another manager: 403 for one upload, and the list leaves out the uploads they did not make", r.status === 403 && list.status === 200 && same(list.body.batches, {}), JSON.stringify([r.status, list.body]));
  r = await call(people.POST, { body: { action: "add_found", batch: u1.id } });
  check("... nor may they add its found emails: 403", r.status === 403, JSON.stringify(r));
  as("viewer");
  r = await call(people.GET, { query: { batch: u1.id } });
  check("a viewer: 403", r.status === 403);
  as(null);
  r = await call(people.GET, { query: { batch: u1.id } });
  check("no session: 401", r.status === 401);
  as("admin");
  const tooMany = await call(people.GET, { query: { batches: Array.from({ length: 21 }, () => randomUUID()).join(",") } });
  const badId = await call(people.GET, { query: { batches: `${u1.id},nope` } });
  const none = await call(people.GET, {});
  const missing = await call(people.GET, { query: { batch: randomUUID() } });
  check("more than 20 ids, a bad id or none: 400; one that does not exist: 404", tooMany.status === 400 && badId.status === 400 && none.status === 400 && missing.status === 404,
    JSON.stringify([tooMany.status, badId.status, none.status, missing.status]));

  section("G3. The client's switch");
  await pool.query(`UPDATE enrich_settings SET value = jsonb_set(jsonb_set(value, '{enabled}', 'true'), '{tags}', $1::jsonb) WHERE key = 'people_pipeline'`, [JSON.stringify([UC.toLowerCase()])]);
  r = await call(people.GET, { query: { batch: u1.id } });
  const table = await (await route("enrich/table")).GET;
  const t = await call(table, { query: { id: ctx.tC } });
  check("with the client on People runs, the upload and the People table both say so", r.body.batches[u1.id]?.switched_on === true && t.body?.people_switch === true,
    JSON.stringify([r.body.batches[u1.id]?.switched_on, t.body?.people_switch]));
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'people_pipeline'`, [JSON.stringify(switchBefore.value)]);
}

// ── C. The Clay tab ─────────────────────────────────────────────────────────

async function partC() {
  section("C. The Clay tab: a People table's uploads, a held upload row");
  as("manager");
  T.worker = heartbeat();
  const table = (await route("enrich/table")).GET;
  let r = await call(table, { query: { id: ctx.tC } });
  const ups = r.body?.uploads ?? [];
  const u1 = ups.find((u) => u.batch_id === ctx.u1.id);
  check("the People table's detail lists its uploads, newest first, each with its rows and how many are held",
    r.status === 200 && ups.length === 3 && u1?.label === uploadSourceLabel(ctx.u1.filename) && u1.created === 8 && u1.held === 1 && u1.kind === "upload" &&
      ups.every((u, i) => i === 0 || u.created_at <= ups[i - 1].created_at) && r.body.people_switch === false && r.body.table.template === "people_v1",
    JSON.stringify(ups));
  check("... and the Maps deliveries stay Maps only (none here)", Array.isArray(r.body.deliveries) && r.body.deliveries.length === 0);
  r = await call(table, { query: { id: ctx.tD } });
  check("a People table with no upload yet: an empty list", r.status === 200 && same(r.body.uploads, []), JSON.stringify(r.body?.uploads));
  const cell = (await route("enrich/cell")).GET;
  const held = ctx.m1.rowIds[7];
  r = await call(cell, { query: { row: String(held), col: "written_full_name" } });
  check("a held upload row's cell: the table's template (people_v1, for the held note), the person's name, and the upload as its source",
    r.status === 200 && r.body.row.template === "people_v1" && r.body.row.run_status === "held" && r.body.row.title === "Hal Kim · Hal Co" &&
      r.body.row.source_label === uploadSourceLabel(ctx.u1.filename),
    JSON.stringify(r.body?.row));
  const panel = source("src/components/clay/cell-panel.tsx");
  check("the cell panel's held note for a People table says what the row waits for",
    panel.includes("Held: a no-email row of an upload. It is worked once its client is on People runs") && /heldNote\(shown\.row\.template\)/.test(panel));
}

// ── H. The Uploads page's history ───────────────────────────────────────────

async function partH() {
  section("H. The Uploads page's history leaves the rounds out");
  const page = source("src/app/(app)/uploads/page.tsx");
  const label = /const FOUND_LABEL = "([^"]+)";/.exec(page)?.[1];
  check("the page's label for a round is FOUND_SOURCE_LABEL, and its query leaves out linked rounds and labelled ones",
    label === FOUND_SOURCE_LABEL && page.includes(`.is("source_batch_id", null)`) && page.includes('.or(`source_label.is.null,source_label.neq."${FOUND_LABEL}"`)'));
  const { rows: [orphan] } = await pool.query(
    `INSERT INTO upload_batches (uploaded_by, filename, total_rows, status, batch_type, source_label) VALUES ($1, $2, 1, 'complete', 'leads', $3) RETURNING id`,
    [USERS.manager, `${FOUND_SOURCE_LABEL} · ${FILE}-orphan`, FOUND_SOURCE_LABEL]
  );
  const { createClient } = await import("@supabase/supabase-js");
  const sb = createClient(API, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const ids = [ctx.u1.id, ctx.r1, orphan.id, ctx.s.aiark];
  const { data, error } = await sb.from("upload_batches").select("id").in("id", ids)
    .is("source_batch_id", null).or(`source_label.is.null,source_label.neq."${FOUND_SOURCE_LABEL}"`);
  const got = new Set((data ?? []).map((x) => x.id));
  check("the same query through the local Supabase API: the upload and the AI Ark batch stay, a round and a round whose upload is gone do not",
    !error && got.size === 2 && got.has(ctx.u1.id) && got.has(ctx.s.aiark), JSON.stringify({ error, data }));
}

// ── Run ─────────────────────────────────────────────────────────────────────

const t0 = Date.now();
try {
  const ready = await one(
    `SELECT to_regprocedure('public.fn_enrich_company_switch_on(text)') IS NOT NULL AS m129,
            to_regclass('public.upload_people') IS NOT NULL AND to_regprocedure('public.fn_enrich_people_switch_on(text)') IS NOT NULL AS m130`
  );
  if (!ready.m129 || !ready.m130) throw new Error("migrations 129 and 130 are not both in this database");
  const worker = await one(`SELECT count(*)::int AS n FROM enrich_worker_state WHERE last_seen > now() - interval '30 seconds' AND NOT coalesce((info->>'stopped')::boolean, false)`);
  if (worker.n) throw new Error("an enrichment worker's heartbeat is fresh: stop it first");
  await cleanup();
  const s = await one(`SELECT value, updated_by FROM enrich_settings WHERE key = 'people_pipeline'`);
  const held = await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE run_status = 'held'`);
  const listed = Array.isArray(s?.value?.tags) ? s.value.tags.length : 0;
  check("before the run: no held row anywhere, and no client on the people_pipeline switch's list", held.n === 0 && listed === 0 && Boolean(s), JSON.stringify({ held: held.n, listed }));
  if (held.n || listed || !s) throw new Error("not run: a client is on the people_pipeline switch, or rows are held, here");
  switchBefore = { exists: true, value: s.value, updated_by: s.updated_by };

  for (const t of TAGS) await pool.query(`INSERT INTO client_tags (tag, name, client_type) VALUES ($1, $2, NULL)`, [t, `Upload web test ${t.slice(-1)}`]);
  await pool.query(`INSERT INTO client_targeting (client_tag, countries) VALUES ($1, '{US}')`, [UC]);
  for (const who of ["admin", "manager", "other", "viewer"]) {
    USERS[who] = randomUUID();
    await pool.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [USERS[who], `upweb-${who}-${RUN}@${HOST}`]);
  }
  importer = await srcModule("lib/uploads/import-rows.ts");
  found = await srcModule("lib/uploads/found.ts");

  await partP();
  await partR();
  await partA();
  await partS();
  await partG();
  await partC();
  await partH();

  section("N. The audit lines, the network");
  check("no audit line holds an address", T.audits.every((x) => !String(x.details ?? "").includes("@")), JSON.stringify(T.audits));
  check("the mail provider lookup stayed on for the rounds (its stub was asked) and nothing reached DNS or any address but the local Supabase API",
    T.esp.length > 0 && T.esp.every((d) => d.endsWith(HOST)) && net.dns === 0 && net.refused === 0, JSON.stringify({ ...net, esp: T.esp.length }));
} catch (e) {
  failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  T.after.length = 0;
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[])) AS clients,
            (SELECT count(*)::int FROM enrich_tables WHERE client_tag = ANY($1::text[])) AS tables,
            (SELECT count(*)::int FROM upload_batches WHERE filename LIKE '%upweb-%') AS batches,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2) AS leads,
            (SELECT count(*)::int FROM auth.users WHERE email LIKE $3) AS users,
            (SELECT count(*)::int FROM enrich_rows WHERE run_status = 'held') AS held`,
    [TAGS, `%.${HOST}`, `upweb-%@${HOST}`]
  );
  const s = await one(`SELECT value FROM enrich_settings WHERE key = 'people_pipeline'`);
  const switchBack = !switchBefore || same(s?.value, switchBefore.value);
  const clean = Object.values(left).every((n) => n === 0) && switchBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, switchBack })}`}`);
  console.log(`${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  for (const p of T.pools) await p.end().catch(() => {});
  await (await srcModule("lib/enrich/db.ts")).enrichPool().end().catch(() => {});
  await pool.end();
  process.exit(failed || !clean ? 1 : 0);
}
