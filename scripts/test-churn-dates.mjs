#!/usr/bin/env node
// Churn dates and the Clients page (migration 132): each of the three readers
// of the Groups tab records a good read in the same transaction as its group
// writes, and records nothing when the tab cannot be read; the receive rule
// gives the right reason for each state; GET /api/clients answers the new
// fields.
// LOCAL DATABASE ONLY. Made-up clients named CHTEST_ and a letter (and CHTEST_V-OS),
// made-up sheets, a made-up import with share rows (file chtest-*) and made-up
// top-up passes.
// NOTHING IS EVER COMMITTED: each part runs inside one transaction that is
// rolled back at its end, and a reader's own begin, commit and rollback become
// savepoints inside it, so a reader sees and writes exactly what it would and
// then it is all undone. A reader rewrites every client_tags row (and the
// script and "Sync with sheet" delete the rows the made-up sheets do not
// list), so while a part runs it holds row locks on client_tags: run it under
// the shared local-database lock.
//
//   lockf -k -t 3600 <the lock file> node --env-file=.env.local scripts/test-churn-dates.mjs
//
// Nothing here reaches a network: fetch answers a made-up Google token address
// and the Sheets API from stubs and refuses every other address, and the
// service account's key is made here. The routes run for real through a small
// loader that compiles their TypeScript, with stand-ins only for: the session
// (the Supabase server client, and the admin client's role lookup), the audit
// log, and the shared pg pool (the test's transaction).
//
//   S. scripts/sync-clients-from-sheet.mjs main(): --dry-run, then four reads
//   R. POST /api/clients/sync-sheet: the same four reads
//   G. POST /api/clients/sync-groups: the same four reads, and its own answer
//   C. GET /api/clients: the new fields, and a database without the newer objects
//   N. nothing reached a network, nothing was left, no other client changed
// Each reader's four reads: (1) a good read, with the receive reason of every
// state; (2) a cleared cell clears the date, a client dropped from the tab is
// cleared and blocked; (3) a tab that cannot be read writes nothing; (4) a tab
// with no Churn Date column writes the groups and no churn record.

import pg from "pg";
import crypto from "node:crypto";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { BISON_GROUPS, GROUPS_TAB_GID } from "./lib/bison-groups.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
// No paid key reaches anything here, whatever the shell holds.
for (const k of [
  "OPENAI_API_KEY", "ENRICH_REOON_API_KEY", "REOON_API_KEY", "FINDEMAIL_API_KEY", "ANTHROPIC_API_KEY",
  "AIARK_API_KEY", "AIARK_WEBHOOK_URL", "AIARK_AUTO_ADD_URL", "AIARK_AUTO_ADD_KEY", "FINDYMAIL_API_KEY", "PROSPEO_API_KEY",
  "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY", "ICYPEAS_API_KEY", "EMAILBISON_API_KEY", "EMAILBISON_BASE_URL", "EMAILBISON_KEYS",
]) delete process.env[k];

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` : ${String(detail).slice(0, 900)}` : ""}`);
}
const section = (s) => console.log(`\n${s}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (name, got, want) => check(name, same(got, want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── The made-up Google side ─────────────────────────────────────────────────

const TOKEN_URI = "https://oauth2.chtest.example/token";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
const IDS = { clients: "chtest-clients", tracker: "chtest-tracker", groups: "chtest-onboarding" };
const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  client_email: "chtest-sync@chtest.example",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  token_uri: TOKEN_URI,
};
const ENV = {
  GOOGLE_SERVICE_ACCOUNT_B64: Buffer.from(JSON.stringify(SA)).toString("base64"),
  CLIENTS_SHEET_ID: IDS.clients,
  CLIENT_TRACKER_SHEET_ID: IDS.tracker,
  ONBOARDING_SHEET_ID: IDS.groups,
  DATABASE_URL: url,
};
Object.assign(process.env, ENV); // the routes read process.env (sync-groups at load time)

const net = { refused: [], requests: [] };
let sheets = null; // { values: Map<"id|range", rows>, groupsMeta: [...] }, set per read
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = String(init.method ?? "GET").toUpperCase();
  if (u === TOKEN_URI && method === "POST") {
    net.requests.push({ kind: "token" });
    return json(200, { access_token: "chtest-token", expires_in: 3600 });
  }
  if (u.startsWith(SHEETS) && method === "GET") {
    const auth = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])).authorization;
    if (auth !== "Bearer chtest-token") return json(401, { error: "no token" });
    const parsed = new URL(u);
    const path = parsed.pathname.replace("/v4/spreadsheets/", "");
    const [id, rest] = [path.split("/")[0], path.split("/").slice(1).join("/")];
    if (!rest) {
      net.requests.push({ kind: "meta", id, query: parsed.search });
      if (id === IDS.groups) return json(200, { sheets: sheets.groupsMeta });
      if (id === IDS.clients) return json(200, { sheets: [{ properties: { sheetId: 0, title: "Sheet1" } }] });
      return json(200, { sheets: [] });
    }
    const range = decodeURIComponent(rest.replace(/^values\//, ""));
    net.requests.push({ kind: "values", id, range, query: parsed.search });
    const values = sheets.values.get(`${id}|${range}`);
    if (!values) return json(400, { error: `made-up sheets have no ${id} ${range}` });
    return json(200, { range, values });
  }
  net.refused.push(u);
  throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
};

// ── The routes' TypeScript, compiled as it is imported ──────────────────────

const require = createRequire(import.meta.url);
const SRC = new URL("../src/", import.meta.url).href;
const STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}`,
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => {
    const t = globalThis.__chTest;
    return { data: { user: t.role ? { id: t.userId } : null } };
  } } };
}`,
  // Only the routes' role lookup goes through the admin client.
  "@/lib/supabase/admin": `export function createAdminClient() {
  const t = globalThis.__chTest;
  return {
    from(table) {
      if (table !== "user_profiles") throw new Error("this test's admin client answers user_profiles only, not " + table);
      const b = {
        select() { return b; }, eq() { return b; }, single() { return b; },
        then(ok, bad) { return Promise.resolve({ data: t.role ? { email: "chtest-manager@chtest.example", role: t.role } : null, error: null }).then(ok, bad); },
      };
      return b;
    },
  };
}`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__chTest.audits.push(entry); }`,
  "@/lib/db/pool": `export function getPool() { return globalThis.__chTest.pool; }`,
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
const T = (globalThis.__chTest = { role: "manager", userId: crypto.randomUUID(), audits: [], pool: null });
const route = (p) => import(new URL(`app/api/${p}/route.ts`, SRC).href);

// ── The database ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: url, max: 3 });
const PREFIX = "CHTEST_";
const LIKE = "CHTEST\\_%";

/**
 * A database client for a reader: its begin, commit and rollback become
 * savepoints in the test's open transaction on c, so nothing it writes is
 * ever committed. end() and release() leave c open. intercept(sql) may answer
 * a statement instead of the database (null: the database answers).
 */
function nested(c, intercept = null) {
  const stack = [];
  let n = 0;
  const done = { rows: [], rowCount: null };
  return {
    async query(sql, params) {
      const s = typeof sql === "string" ? sql.trim().toLowerCase() : "";
      if (s === "begin" || s === "begin read only") {
        const sp = `chtest_reader_${++n}`;
        stack.push(sp);
        await c.query(`SAVEPOINT ${sp}`);
        if (s === "begin read only") await c.query("SET LOCAL transaction_read_only = on");
        return done;
      }
      if (s === "commit") {
        await c.query(`RELEASE SAVEPOINT ${stack.pop()}`);
        return done;
      }
      if (s === "rollback") {
        const sp = stack.pop();
        if (sp) {
          await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          await c.query(`RELEASE SAVEPOINT ${sp}`);
        }
        return done;
      }
      return intercept?.(sql) ?? c.query(sql, params);
    },
    async end() {},
    release() {},
  };
}
/**
 * The web app's pool, inside the test's transaction on c. A real pool runs
 * parallel queries on separate connections; here they take turns on c.
 */
function poolOn(c, intercept = null) {
  let last = Promise.resolve();
  return {
    query(sql, params) {
      const next = last.then(() => intercept?.(sql) ?? c.query(sql, params));
      last = next.catch(() => {});
      return next;
    },
    connect: async () => nested(c, intercept),
  };
}

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

/** console output of fn, kept instead of printed. */
async function quiet(fn) {
  const lines = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...a) => lines.push(a.map(String).join(" "));
  try {
    const result = await fn();
    return { result, lines, error: null };
  } catch (e) {
    return { result: null, lines, error: e };
  } finally {
    Object.assign(console, keep);
  }
}

// ── The made-up clients and their sheets ────────────────────────────────────

const today = (await pool.query(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS d`)).rows[0].d;
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const serial = (iso) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;
const mdy = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}/${iso.slice(0, 4)}`;

const OK_PLACES = [{ country: "US", state: "AZ" }, { country: "US", state: "AZ", city: "Tucson" }];
// t: the letter after CHTEST_; status and type as the onboarding form gives them; sheet1: its group in
// Sheet1 (null: only the Client Tracker lists it); seed: the group saved before the read;
// tab: [[group, churn cell], ...] on the Groups tab (none: not listed); places: its rules
// (undefined: no rules row); then what read 1 must record and the reason it cannot receive.
const CAST = [
  { t: "R", status: "Active", type: "Cleaning", sheet1: 1, seed: 2, tab: [[1, serial(day(30))]], places: OK_PLACES,
    want: { state: "date", date: day(30), cell: String(serial(day(30))) }, block: null },
  { t: "B", status: "Healthy", type: "Cleaning", sheet1: 2, seed: 2, tab: [[2, "N/A"]], places: OK_PLACES,
    want: { state: "non_answer", date: null, cell: "N/A" }, block: null },
  { t: "C", status: "Active", type: "Cleaning", sheet1: 1, seed: 1, tab: [[1, "TBD"]], places: OK_PLACES,
    want: { state: "unreadable", date: null, cell: "TBD" }, block: "churn cell unreadable" },
  { t: "D", status: "Active", type: "Cleaning", sheet1: 1, seed: 1, tab: [[1, mdy(day(10))]], places: OK_PLACES,
    want: { state: "date", date: day(10), cell: mdy(day(10)) }, block: `churn date ${day(10)}` },
  { t: "E", status: "Active", type: "Cleaning", sheet1: 2, seed: 2, tab: [[2, serial(day(-5))]], places: OK_PLACES,
    want: { state: "date", date: day(-5), cell: String(serial(day(-5))) }, block: `churn date ${day(-5)}` },
  { t: "F", status: "Active", type: "Cleaning", sheet1: 1, seed: 1, tab: [], places: OK_PLACES,
    want: { state: null, date: null, cell: null }, block: "not on the Groups tab" },
  { t: "G", status: "Paused", type: "Cleaning", sheet1: 1, seed: 1, tab: [[1, ""]], places: OK_PLACES,
    want: { state: "empty", date: null, cell: null }, block: "status Paused" },
  { t: "H", status: "Active", type: "Cleaning", sheet1: 1, seed: 1, tab: [[1, ""]], places: undefined,
    want: { state: "empty", date: null, cell: null }, block: "no rules row" },
  { t: "I", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[1, ""]], places: [],
    want: { state: "empty", date: null, cell: null }, block: "no places" },
  { t: "J", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[2, ""]], places: [OK_PLACES[0], { country: "US" }],
    want: { state: "empty", date: null, cell: null }, block: "a country-wide place" },
  { t: "X", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[2, ""]], places: [{ state: "AZ" }],
    want: { state: "empty", date: null, cell: null }, block: "a place with no country" },
  { t: "L", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [], places: OK_PLACES,
    want: { state: null, date: null, cell: null }, block: "no group" },
  { t: "M", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[1, mdy(day(40))], [2, serial(day(20))]], places: OK_PLACES,
    want: { state: "date", date: day(20), cell: String(serial(day(20))) }, block: null },
  { t: "N", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[1, serial(day(40))], [2, "TBD"]], places: OK_PLACES,
    want: { state: "unreadable", date: null, cell: "TBD" }, block: "churn cell unreadable" },
  { t: "O", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[1, "-"]], places: OK_PLACES,
    want: { state: "non_answer", date: null, cell: "-" }, block: null },
  { t: "P", status: "Active", type: "Non-Cleaning", sheet1: null, seed: null, tab: [[2, "none"]], places: OK_PLACES,
    want: { state: "non_answer", date: null, cell: "none" }, block: null },
  { t: "Y", status: "Active", type: "Canada Cleaning", sheet1: null, seed: null, tab: [[1, ""]], places: OK_PLACES,
    want: { state: "empty", date: null, cell: null }, block: null },
  { t: "S", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[1, mdy(day(15))]], places: OK_PLACES,
    want: { state: "date", date: day(15), cell: mdy(day(15)) }, block: `churn date ${day(15)}` },
  { t: "U", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[2, serial(day(16))]], places: OK_PLACES,
    want: { state: "date", date: day(16), cell: String(serial(day(16))) }, block: null },
  { t: "V-OS", status: "Active", type: "Cleaning", sheet1: null, seed: null, tab: [[1, ""]], places: OK_PLACES,
    want: { state: "empty", date: null, cell: null }, block: null },
  { t: "W", status: "Confirmed Churn", type: "Cleaning", sheet1: null, seed: null, tab: [], places: OK_PLACES,
    want: { state: null, date: null, cell: null }, block: "status Confirmed Churn" },
].map((x) => ({ ...x, tag: PREFIX + x.t }));
const ONLY_ON_TAB = `${PREFIX}Z`; // the tab lists it; no roster does
const BISON = { 1: [BISON_GROUPS[1].b2b, BISON_GROUPS[1].b2c], 2: [BISON_GROUPS[2].b2b, BISON_GROUPS[2].b2c] };

const GROUPS_HEADER = ["B2B #1 & B2C #1", "Status", "Churn Date", "Plan", "B2B #2 & B2C #2", "Status", "Churn Date", "Plan"];

/** The Groups tab as the raw read gives it: one row per listing, group 1 left, group 2 right. */
function groupsTab(cast, { header = GROUPS_HEADER, extra = [[2, ONLY_ON_TAB, ""]] } = {}) {
  const listings = [];
  for (const x of cast) for (const [g, cell] of x.tab) listings.push([g, x.tag, cell]);
  listings.push(...extra);
  const g1 = listings.filter((l) => l[0] === 1);
  const g2 = listings.filter((l) => l[0] === 2);
  const rows = [header];
  const wide = header.length >= 8;
  for (let i = 0; i < Math.max(g1.length, g2.length); i++) {
    const a = g1[i];
    const b = g2[i];
    rows.push(wide
      ? [a?.[1] ?? "", a ? "Active" : "", a?.[2] ?? "", "", b?.[1] ?? "", b ? "Active" : "", b?.[2] ?? "", ""]
      : [a?.[1] ?? "", a ? "Active" : "", b?.[1] ?? "", b ? "Active" : ""]);
  }
  return rows;
}

/** The made-up sheets for one read: the roster sheets stay; the Groups tab is given. */
function setSheets({ cast = CAST, tab = groupsTab(cast), readable = true } = {}) {
  const sheet1 = [["B2B #1 & B2C #1", "B2B #2 & B2C #2"]];
  const s1 = CAST.filter((x) => x.sheet1 === 1).map((x) => x.tag);
  const s2 = CAST.filter((x) => x.sheet1 === 2).map((x) => x.tag);
  for (let i = 0; i < Math.max(s1.length, s2.length); i++) sheet1.push([s1[i] ?? "", s2[i] ?? ""]);
  const tracker = [["Company Name", "Client Abbreviation", "", "", "", "", "", "Health"],
    ...CAST.map((x) => [`Chtest ${x.t} Co`, x.tag, "", "", "", "", "", ""])];
  const onboarding = [["Abbreviation", "", "", "", "Status", "Client Type"],
    ...CAST.map((x) => [x.tag, "", "", "", x.status, x.type])];
  sheets = {
    groupsMeta: readable
      ? [{ properties: { sheetId: 7, title: "Other" } }, { properties: { sheetId: GROUPS_TAB_GID, title: "Groups" } }]
      : [{ properties: { sheetId: 7, title: "Other" } }],
    values: new Map([
      [`${IDS.clients}|Sheet1!A1:B400`, sheet1],
      [`${IDS.tracker}|'Client Tracker'!A1:H1000`, tracker],
      [`${IDS.tracker}|'Onboarding Form Responses'!A1:F3000`, onboarding],
      [`${IDS.groups}|'Groups'!A1:L400`, tab],
    ]),
  };
}

/** The made-up clients as saved before a read, and their rules, in the test's transaction. */
async function seed(c) {
  for (const x of CAST) {
    const [b2b, b2c] = x.seed ? BISON[x.seed] : [null, null];
    await c.query(
      `INSERT INTO client_tags (tag, group_no, b2b_instance, b2c_instance, status, name, client_type, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'chtest')`,
      [x.tag, x.seed, b2b, b2c, x.status, `Chtest ${x.t} Co`, x.type]
    );
    if (x.places !== undefined) {
      await c.query(`INSERT INTO client_targeting (client_tag, include_locations, source) VALUES ($1, $2::jsonb, 'manual')`,
        [x.tag, JSON.stringify(x.places)]);
    }
  }
}

/** What client_tags holds for the made-up clients, and each one's receive reason. */
async function states(c) {
  const { rows } = await c.query(
    `SELECT tag, group_no, on_groups_tab, churn_cell_state AS state, to_char(churn_date, 'YYYY-MM-DD') AS date, churn_cell AS cell,
            groups_tab_read_at = now() AS read_now, groups_tab_read_at = '2000-01-01T00:00:00Z'::timestamptz AS sentinel,
            fn_client_receive_block(tag) AS block, fn_client_can_receive(tag) AS can
       FROM client_tags WHERE tag LIKE $1 ORDER BY tag`, [LIKE]);
  return new Map(rows.map((r) => [r.tag, r]));
}
const sentinel = (c) => c.query(`UPDATE client_tags SET groups_tab_read_at = '2000-01-01T00:00:00Z' WHERE tag LIKE $1`, [LIKE]);

/** Read 1 as every reader must record it: each state and its reason. */
function checkRead1(who, st) {
  for (const x of CAST) {
    const r = st.get(x.tag);
    const listed = x.tab.length > 0;
    check(`${who}: ${x.tag} ${listed ? `"${x.want.cell ?? ""}" is ${x.want.state}` : "not listed"}, ${x.block ? `blocked: ${x.block}` : "can receive"}`,
      r && r.on_groups_tab === listed && r.state === x.want.state && r.date === x.want.date && r.cell === x.want.cell
        && r.block === x.block && r.can === (x.block === null) && r.read_now === true,
      JSON.stringify(r));
  }
}

/** Read 2: R's cell cleared, C dropped from the tab, D's date moved past the guard. */
const READ2 = CAST.map((x) => x.t === "R" ? { ...x, tab: [[1, ""]] } : x.t === "C" ? { ...x, tab: [] }
  : x.t === "D" ? { ...x, tab: [[1, serial(day(30))]] } : x);
function checkRead2(who, st) {
  const a = st.get(`${PREFIX}R`);
  const cc = st.get(`${PREFIX}C`);
  const d = st.get(`${PREFIX}D`);
  check(`${who}: a cleared cell clears the date (R empty, no date, can receive)`,
    a?.state === "empty" && a.date === null && a.cell === null && a.on_groups_tab === true && a.block === null, JSON.stringify(a));
  check(`${who}: a client the tab no longer lists is cleared and blocked (C)`,
    cc?.on_groups_tab === false && cc.state === null && cc.date === null && cc.cell === null && cc.block === "not on the Groups tab",
    JSON.stringify(cc));
  check(`${who}: a date moved past the 15 days lets the client receive (D)`, d?.date === day(30) && d.block === null, JSON.stringify(d));
}
/** Reads 3 and 4 wrote no churn record: everything as read 2 left it, the sentinel time kept. */
function checkUnchanged(who, st, what) {
  const a = st.get(`${PREFIX}R`);
  const cc = st.get(`${PREFIX}C`);
  const d = st.get(`${PREFIX}D`);
  check(`${who}: ${what}: no churn record (the read time and every churn field as the last good read left them)`,
    [...st.values()].every((r) => r.sentinel === true)
      && a?.state === "empty" && a.on_groups_tab === true && cc?.on_groups_tab === false && d?.date === day(30)
      && st.get(`${PREFIX}B`)?.state === "non_answer",
    JSON.stringify([...st.values()].filter((r) => !r.sentinel).map((r) => r.tag)));
}
/** A tab with no Churn Date column, on which B moved to group 1. */
const NO_CHURN_HEADER = ["B2B #1 & B2C #1", "Status", "B2B #2 & B2C #2", "Status"];
const READ4 = READ2.map((x) => (x.t === "B" ? { ...x, tab: [[1, ""]] } : x));

/** Every Sheets request since `from`: the Groups tab read raw, every other range (when the reader reads others) formatted. */
function checkRequests(who, from, { others: readsOthers = true } = {}) {
  const reqs = net.requests.slice(from).filter((r) => r.kind === "values");
  const groups = reqs.filter((r) => r.id === IDS.groups);
  const others = reqs.filter((r) => r.id !== IDS.groups);
  check(`${who}: the Groups tab is read raw (UNFORMATTED_VALUE, SERIAL_NUMBER)${readsOthers ? ", every other tab formatted" : ", and nothing else"}`,
    groups.length > 0 && groups.every((r) => r.query === "?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER")
      && (readsOthers ? others.length > 0 && others.every((r) => !/RenderOption/.test(r.query)) : others.length === 0),
    JSON.stringify(reqs));
}

const fingerprint = async (q) => (await q.query(
  `SELECT count(*)::int AS n, md5(coalesce(string_agg(t::text, '|' ORDER BY t.tag), '')) AS h FROM client_tags t WHERE t.tag NOT LIKE $1`, [LIKE])).rows[0];
const leftovers = async () => (await pool.query(
  `SELECT (SELECT count(*) FROM client_tags WHERE tag LIKE $1)::int AS tags,
          (SELECT count(*) FROM client_targeting WHERE client_tag LIKE $1)::int AS rules,
          (SELECT count(*) FROM client_stats WHERE tag LIKE $1)::int AS stats,
          (SELECT count(*) FROM upload_batches WHERE filename LIKE 'chtest-%')::int AS batches,
          (SELECT count(*) FROM lead_shares WHERE receiver_tag LIKE $1 OR origin_tag LIKE $1)::int AS shares,
          (SELECT count(*) FROM topup_flags WHERE client_tag LIKE $1)::int AS flags`, [LIKE])).rows[0];

// ── Before ──────────────────────────────────────────────────────────────────

section("P. the local database");
{
  const { rows: [h] } = await pool.query(
    `SELECT to_regprocedure('public.fn_client_groups_tab_record(jsonb)') IS NOT NULL AS rec,
            to_regprocedure('public.fn_client_receive_block(text)') IS NOT NULL AS block,
            to_regclass('public.lead_shares') IS NOT NULL AND to_regclass('public.topup_flags') IS NOT NULL AS later`);
  check("migration 132 (the record and the receive rule), 134 and 135 are in the local database", h.rec && h.block && h.later, JSON.stringify(h));
  if (!(h.rec && h.block && h.later)) {
    console.log("\nStopping: apply 132 to 135 to the local database first.");
    await pool.end();
    process.exit(1);
  }
  const left = await leftovers();
  check("nothing of this test is in the database (it never commits)", Object.values(left).every((n) => n === 0), JSON.stringify(left));
}
const before = await fingerprint(pool);

// ── S. The roster sync script ───────────────────────────────────────────────

section("S. scripts/sync-clients-from-sheet.mjs main()");
const { main: syncScript } = await import("./sync-clients-from-sheet.mjs");
{
  // --dry-run: the lists, and nothing written.
  await rolledBack(async (c) => {
    await seed(c);
    setSheets();
    const mark = (await fingerprint(c)).h + (await c.query(`SELECT md5(string_agg(t::text, '|' ORDER BY t.tag)) AS h FROM client_tags t WHERE t.tag LIKE $1`, [LIKE])).rows[0].h;
    const from = net.requests.length;
    const run = await quiet(() => syncScript({ env: ENV, dry: true, connect: async () => nested(c) }));
    const line = (start) => run.lines.find((l) => l.startsWith(start)) ?? "";
    check("dry run: finishes and says it wrote nothing", !run.error && run.lines.includes("--dry-run: no DB writes."), run.error?.message ?? run.lines.slice(-3).join(" / "));
    const dates = line("--dry-run: churn dates");
    check("dry run: lists the parsed dates", [`${PREFIX}R ${day(30)}`, `${PREFIX}D ${day(10)}`, `${PREFIX}E ${day(-5)}`, `${PREFIX}M ${day(20)}`, `${PREFIX}U ${day(16)}`]
      .every((s) => dates.includes(s)) && !dates.includes(`${PREFIX}C `), dates);
    const non = line("--dry-run: non-answers");
    check("dry run: lists the non-answers with their cells", [`${PREFIX}B "N/A"`, `${PREFIX}O "-"`, `${PREFIX}P "none"`].every((s) => non.includes(s)), non);
    const bad = line("--dry-run: unreadable churn cells");
    check("dry run: lists the unreadable cells (a tag listed twice with one included)", [`${PREFIX}C "TBD"`, `${PREFIX}N "TBD"`].every((s) => bad.includes(s)), bad);
    const twice = line("--dry-run: listed twice");
    check("dry run: lists the tags listed twice", twice.includes(`${PREFIX}M`) && twice.includes(`${PREFIX}N`) && !twice.includes(`${PREFIX}R`), twice);
    const missing = (line("--dry-run: Active or Healthy clients the Groups tab does not list").split("): ")[1] ?? "").split(", ");
    check("dry run: lists every Active client the tab does not list, and no other",
      same(missing.filter((t) => t.startsWith(PREFIX)), [`${PREFIX}F`, `${PREFIX}L`]), JSON.stringify(missing));
    const after = (await fingerprint(c)).h + (await c.query(`SELECT md5(string_agg(t::text, '|' ORDER BY t.tag)) AS h FROM client_tags t WHERE t.tag LIKE $1`, [LIKE])).rows[0].h;
    check("dry run: wrote nothing", after === mark);
    checkRequests("dry run", from);
    setSheets({ readable: false });
    const blind = await quiet(() => syncScript({ env: ENV, dry: true, connect: async () => nested(c) }));
    check("dry run with the tab unreadable: says no churn date would be recorded",
      blind.lines.some((l) => l.startsWith("--dry-run: the Groups tab could not be read")), blind.lines.join(" / ").slice(-400));
  });

  // The four reads.
  await rolledBack(async (c) => {
    await seed(c);
    const run = async () => quiet(() => syncScript({ env: ENV, connect: async () => nested(c) }));
    setSheets();
    const from = net.requests.length;
    const r1 = await run();
    check("read 1: the run finishes", !r1.error, r1.error?.message);
    checkRequests("script", from);
    checkRead1("script read 1", await states(c));
    const rec = r1.lines.find((l) => l.startsWith("Groups tab recorded:")) ?? "";
    check("read 1: the record reports the listed clients and the tag that is no client",
      rec.includes(`${CAST.filter((x) => x.tab.length).length} clients listed`) && rec.includes(ONLY_ON_TAB), rec);
    check("read 1: the churn cells line names the unreadable ones",
      r1.lines.some((l) => l.startsWith("Groups tab churn cells:") && l.includes(`${PREFIX}C`) && l.includes(`${PREFIX}N`)));
    const g = await states(c);
    check("read 1: groups as the tab says (R moved 2 to 1, Y gained 1), F kept from Sheet1, L none",
      g.get(`${PREFIX}R`)?.group_no === 1 && g.get(`${PREFIX}Y`)?.group_no === 1 && g.get(`${PREFIX}F`)?.group_no === 1 && g.get(`${PREFIX}L`)?.group_no === null);

    setSheets({ cast: READ2, tab: groupsTab(READ2) });
    const r2 = await run();
    check("read 2: the run finishes", !r2.error, r2.error?.message);
    checkRead2("script read 2", await states(c));

    await sentinel(c);
    setSheets({ cast: READ2, tab: groupsTab(READ2), readable: false });
    const r3 = await run();
    check("read 3 (tab unreadable): the run finishes and warns", !r3.error && r3.lines.some((l) => l.includes("Groups tab unreadable")), r3.lines.join(" / ").slice(-300));
    checkUnchanged("script read 3", await states(c), "the tab could not be read");
    check("read 3: every saved group kept", (await states(c)).get(`${PREFIX}R`)?.group_no === 1);

    setSheets({ cast: READ4, tab: groupsTab(READ4, { header: NO_CHURN_HEADER, extra: [] }) });
    const r4 = await run();
    check("read 4 (no Churn Date column): the run finishes and says why nothing about churn was recorded",
      !r4.error && r4.lines.some((l) => l.includes('no "Churn Date" column')), r4.lines.join(" / ").slice(-300));
    const s4 = await states(c);
    checkUnchanged("script read 4", s4, "no Churn Date column");
    check("read 4: the groups still apply (B moved to group 1)", s4.get(`${PREFIX}B`)?.group_no === 1, JSON.stringify(s4.get(`${PREFIX}B`)));
  });
}

// ── R. POST /api/clients/sync-sheet ─────────────────────────────────────────

section("R. POST /api/clients/sync-sheet");
const syncSheet = await route("clients/sync-sheet");
await rolledBack(async (c) => {
  await seed(c);
  T.pool = poolOn(c);
  T.audits = [];
  const post = async () => {
    const res = await syncSheet.POST();
    return { status: res.status, body: res.body };
  };
  setSheets();
  const from = net.requests.length;
  const r1 = await post();
  check("read 1: 200", r1.status === 200, JSON.stringify(r1.body).slice(0, 400));
  checkRequests("sync-sheet", from);
  checkRead1("sync-sheet read 1", await states(c));
  const gt = r1.body?.groupsTab;
  check("read 1: the answer's groupsTab says what the cells held and what was recorded",
    gt?.read === true && gt.unreadable.map((u) => u.tag).join() === `${PREFIX}C,${PREFIX}N` && gt.duplicates.join() === `${PREFIX}M,${PREFIX}N`
      && gt.dates.length === 6 && gt.recorded?.not_in_roster?.includes(ONLY_ON_TAB) && gt.recorded?.listed === CAST.filter((x) => x.tab.length).length,
    JSON.stringify(gt).slice(0, 600));
  check("read 1: audited, with the Groups tab line", T.audits.some((a) => a.action === "Clients Synced From Sheet" && /Groups tab: \d+ listed/.test(a.details)),
    JSON.stringify(T.audits));
  check("read 1: no churn warning", (r1.body?.warnings ?? []).every((w) => !/churn/i.test(w)), JSON.stringify(r1.body?.warnings));

  setSheets({ cast: READ2, tab: groupsTab(READ2) });
  const r2 = await post();
  check("read 2: 200", r2.status === 200, JSON.stringify(r2.body).slice(0, 300));
  checkRead2("sync-sheet read 2", await states(c));

  await sentinel(c);
  setSheets({ cast: READ2, tab: groupsTab(READ2), readable: false });
  const r3 = await post();
  check("read 3 (tab unreadable): 200, groupsTab null, a warning", r3.status === 200 && r3.body?.groupsTab === null
    && (r3.body?.warnings ?? []).some((w) => w.includes("Groups tab unreadable")), JSON.stringify(r3.body).slice(0, 400));
  checkUnchanged("sync-sheet read 3", await states(c), "the tab could not be read");

  setSheets({ cast: READ4, tab: groupsTab(READ4, { header: NO_CHURN_HEADER, extra: [] }) });
  const r4 = await post();
  const s4 = await states(c);
  check("read 4 (no Churn Date column): 200, the answer says why, a warning", r4.status === 200 && r4.body?.groupsTab?.read === false
    && (r4.body?.warnings ?? []).some((w) => w.includes('no "Churn Date" column')), JSON.stringify(r4.body).slice(0, 400));
  checkUnchanged("sync-sheet read 4", s4, "no Churn Date column");
  check("read 4: the groups still apply (B moved to group 1)", s4.get(`${PREFIX}B`)?.group_no === 1);
});

// ── G. POST /api/clients/sync-groups ────────────────────────────────────────

section("G. POST /api/clients/sync-groups");
const syncGroups = await route("clients/sync-groups");
await rolledBack(async (c) => {
  await seed(c);
  T.pool = poolOn(c);
  T.audits = [];
  const post = async () => {
    const res = await syncGroups.POST();
    return { status: res.status, body: res.body };
  };
  setSheets();
  const from = net.requests.length;
  const r1 = await post();
  check("read 1: 200", r1.status === 200, JSON.stringify(r1.body).slice(0, 400));
  checkRequests("sync-groups", from, { others: false });
  checkRead1("sync-groups read 1", await states(c));
  const b = r1.body ?? {};
  check("read 1: gained, moved and not-in-database as before (Y gained, R moved 2 to 1, Z not a client)",
    b.gained?.includes(`${PREFIX}Y`) && b.moved?.some((m) => m.tag === `${PREFIX}R` && m.from === 2 && m.to === 1) && b.notInDb?.includes(ONLY_ON_TAB)
      && !b.gained?.includes(`${PREFIX}R`), JSON.stringify(b).slice(0, 500));
  check("read 1: a client with a group the tab does not list keeps it, and is reported (F)",
    b.missingFromSheet?.includes(`${PREFIX}F`) && (await states(c)).get(`${PREFIX}F`)?.group_no === 1);
  const g1 = await states(c);
  check("read 1: the groups written (R 1, Y 1, J 2) with their installs",
    g1.get(`${PREFIX}R`)?.group_no === 1 && g1.get(`${PREFIX}Y`)?.group_no === 1 && g1.get(`${PREFIX}J`)?.group_no === 2
      && (await c.query(`SELECT b2b_instance, b2c_instance FROM client_tags WHERE tag = $1`, [`${PREFIX}Y`])).rows[0]?.b2b_instance === BISON[1][0]);
  const other = (await c.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT on_groups_tab AND groups_tab_read_at = now() AND churn_cell_state IS NULL)::int AS cleared
       FROM client_tags WHERE tag NOT LIKE $1`, [LIKE])).rows[0];
  check("read 1: every other client is written too (not listed, read now, no churn fields)", other.n === other.cleared, JSON.stringify(other));
  check("read 1: the answer's groupsTab and no warning", b.groupsTab?.read === true && b.groupsTab?.recorded?.not_in_roster?.includes(ONLY_ON_TAB)
    && (b.warnings ?? []).length === 0, JSON.stringify(b.groupsTab).slice(0, 300));
  check("read 1: audited", T.audits.some((a) => a.action === "Client Groups Synced" && /Groups tab: \d+ listed/.test(a.details)));

  setSheets({ cast: READ2, tab: groupsTab(READ2) });
  const r2 = await post();
  check("read 2: 200", r2.status === 200);
  checkRead2("sync-groups read 2", await states(c));

  await sentinel(c);
  setSheets({ cast: READ2, tab: groupsTab(READ2), readable: false });
  const r3 = await post();
  check("read 3 (tab unreadable): 502, nothing written", r3.status === 502 && /Could not read the Groups sheet/.test(r3.body?.error ?? ""),
    JSON.stringify(r3.body));
  checkUnchanged("sync-groups read 3", await states(c), "the tab could not be read");

  setSheets({ cast: READ4, tab: groupsTab(READ4, { header: NO_CHURN_HEADER, extra: [] }) });
  const r4 = await post();
  const s4 = await states(c);
  check("read 4 (no Churn Date column): 200, the move applied, a warning, groupsTab says why",
    r4.status === 200 && r4.body?.moved?.some((m) => m.tag === `${PREFIX}B` && m.to === 1) && r4.body?.groupsTab?.read === false
      && (r4.body?.warnings ?? []).some((w) => w.includes('no "Churn Date" column')), JSON.stringify(r4.body).slice(0, 400));
  checkUnchanged("sync-groups read 4", s4, "no Churn Date column");
  check("read 4: B is in group 1", s4.get(`${PREFIX}B`)?.group_no === 1);

  // A record the function refuses leaves the group writes and warns (a tag the
  // parser keeps but the record cannot take: a made-up stand-in for a bad read).
  const { rows: [{ n: fnBefore }] } = await c.query(`SELECT count(*)::int AS n FROM client_tags WHERE tag LIKE $1 AND groups_tab_read_at = '2000-01-01T00:00:00Z'`, [LIKE]);
  T.pool = poolOn(c, (sql) => (/fn_client_groups_tab_record\(\$1/.test(sql) ? Promise.reject(new Error("made-up refusal")) : null));
  setSheets({ cast: READ2, tab: groupsTab(READ2) });
  const r5 = await post();
  const s5 = await states(c);
  check("a refused record: 200, B back in group 2, the churn fields untouched, a warning",
    r5.status === 200 && s5.get(`${PREFIX}B`)?.group_no === 2 && [...s5.values()].filter((r) => r.sentinel).length === fnBefore
      && (r5.body?.warnings ?? []).some((w) => w.includes("made-up refusal")), JSON.stringify(r5.body?.warnings));
});

// ── C. GET /api/clients ─────────────────────────────────────────────────────

section("C. GET /api/clients");
const clientsRoute = await route("clients");
await rolledBack(async (c) => {
  await seed(c);
  T.pool = poolOn(c);
  setSheets();
  const read = await syncGroups.POST();
  check("the made-up clients' Groups tab read is recorded first", read.status === 200);
  const now = (await c.query(`SELECT now() AS t`)).rows[0].t.toISOString();

  // Stats, shares and top-up passes, all made up and rolled back.
  await c.query(`INSERT INTO client_stats (tag, leads, categorized, bounced, contactable, personal, business) VALUES ($1, 1234, 1000, 5, 900, 300, 600)`, [`${PREFIX}R`]);
  const { rows: [batch] } = await c.query(`INSERT INTO upload_batches (filename, status, completed_at) VALUES ('chtest-share.csv', 'complete', now()) RETURNING id`);
  await c.query(`INSERT INTO share_jobs (batch_id, origin_tag, state, mode, batch_done_at) VALUES ($1, $2, 'applied', 'apply', now())`, [batch.id, `${PREFIX}R`]);
  const share = (receiver, outcome, applied, undone = false) => c.query(
    `INSERT INTO lead_shares (batch_id, lead_id, origin_tag, receiver_tag, outcome, applied_at, undone_at)
     VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6)`,
    [batch.id, `${PREFIX}R`, receiver, outcome, applied, undone ? new Date() : null]);
  await share(`${PREFIX}B`, "shared", new Date());
  await share(`${PREFIX}B`, "shared", new Date());
  await share(`${PREFIX}B`, "shared", new Date(Date.now() - 8 * 86_400_000)); // older than 7 days
  await share(`${PREFIX}B`, "shared", new Date(), true); // undone
  await share(`${PREFIX}B`, "also_fits", new Date()); // not a share
  await share(`${PREFIX}D`, "shared", null); // a preview, not applied
  const pass = async (finished) => (await c.query(
    `INSERT INTO topup_passes (state, trigger, finished_at) VALUES ('done', 'manual', $1) RETURNING id`, [finished])).rows[0].id;
  const latest = await pass(new Date(Date.now() + 3_600_000));
  const older = await pass(new Date(Date.now() - 86_400_000));
  const flag = (p, tag, kind, key = null) => c.query(`INSERT INTO topup_flags (pass_id, client_tag, kind, place_key) VALUES ($1, $2, $3, $4)`, [p, tag, kind, key]);
  await flag(latest, `${PREFIX}R`, "low", "us|az|tucson");
  await flag(latest, `${PREFIX}R`, "low", "us|az");
  await flag(latest, `${PREFIX}R`, "unresolved", "us|az|nowhere");
  await flag(latest, `${PREFIX}B`, "all_ok");
  await flag(older, `${PREFIX}C`, "low", "us|az"); // an older pass: never counted

  const res = await clientsRoute.GET();
  const body = res.body ?? {};
  check("200 with the clients", res.status === 200 && Array.isArray(body.clients), JSON.stringify(body).slice(0, 300));
  const rows = new Map((body.clients ?? []).map((r) => [r.tag, r]));
  const { rows: sql } = await c.query(
    `SELECT tag, fn_client_receive_block(tag) AS block, to_char(churn_date, 'YYYY-MM-DD') AS date, churn_cell, churn_cell_state, on_groups_tab
       FROM client_tags WHERE tag LIKE $1`, [LIKE]);
  check("every made-up client: the churn fields, the Groups tab mark and receive_block as stored",
    sql.length === CAST.length && sql.every((s) => {
      const r = rows.get(s.tag);
      return r && r.receive_block === s.block && r.churn_date === s.date && r.churn_cell === s.churn_cell
        && r.churn_cell_state === s.churn_cell_state && r.on_groups_tab === s.on_groups_tab && r.groups_tab_read_at === now;
    }), JSON.stringify(sql.map((s) => [s.tag, rows.get(s.tag)?.receive_block, s.block])));
  const a = rows.get(`${PREFIX}R`);
  eq("R: its fields", a && {
    churn_date: a.churn_date, churn_cell_state: a.churn_cell_state, on_groups_tab: a.on_groups_tab, receive_block: a.receive_block,
    pool: a.pool, low_places: a.low_places, shared_7d: a.shared_7d, leads: a.leads, churned: a.churned, sendable: a.sendable,
  }, {
    churn_date: day(30), churn_cell_state: "date", on_groups_tab: true, receive_block: null,
    pool: "cleaning", low_places: 3, shared_7d: 0, leads: 1234, churned: false, sendable: true,
  });
  eq("shared in, last 7 days: applied, not undone, outcome shared only (B 2, D 0)", [rows.get(`${PREFIX}B`)?.shared_7d, rows.get(`${PREFIX}D`)?.shared_7d], [2, 0]);
  eq("low places: the latest finished pass only (R 3, B 0 with an all_ok row, C none: null)",
    [rows.get(`${PREFIX}R`)?.low_places, rows.get(`${PREFIX}B`)?.low_places, rows.get(`${PREFIX}C`)?.low_places], [3, 0, null]);
  eq("pools: Cleaning and Canada Cleaning in cleaning; Non-Cleaning and a -OS tag isolated",
    [`${PREFIX}R`, `${PREFIX}Y`, `${PREFIX}P`, `${PREFIX}V-OS`].map((t) => rows.get(t)?.pool), ["cleaning", "cleaning", null, null]);
  eq("the churned badge rule stays (W: Confirmed Churn), with its reason", [rows.get(`${PREFIX}W`)?.churned, rows.get(`${PREFIX}W`)?.receive_block],
    [true, "status Confirmed Churn"]);
  const missing = body.missingFromTab ?? [];
  check("missingFromTab: the Active and Healthy clients the tab does not list (F, L), not the Paused or Churned",
    missing.includes(`${PREFIX}F`) && missing.includes(`${PREFIX}L`) && !missing.includes(`${PREFIX}W`) && !missing.includes(`${PREFIX}R`)
      && !missing.includes(`${PREFIX}G`) && same(missing, [...missing].sort()), JSON.stringify(missing.filter((t) => t.startsWith(PREFIX))));
  eq("groupsTabReadAt, receiveRule, refreshedAt", [body.groupsTabReadAt, body.receiveRule, typeof body.refreshedAt], [now, true, "string"]);
  check("rows sorted by leads (R, with 1,234, before every made-up client)",
    (body.clients ?? []).findIndex((r) => r.tag === `${PREFIX}R`) < (body.clients ?? []).findIndex((r) => r.tag === `${PREFIX}B`));

  // A database without 132 to 135: the page still works, the new fields are empty.
  T.pool = poolOn(c, (s) => (/to_regprocedure\('public\.fn_client_receive_block/.test(s)
    ? Promise.resolve({ rows: [{ churn: false, settings: false, topup: false, shares: false }] }) : null));
  const old = await clientsRoute.GET();
  const oa = (old.body?.clients ?? []).find((r) => r.tag === `${PREFIX}R`);
  eq("without the newer objects: 200, no receive fields, the default pools, the old fields kept", [old.status, old.body?.receiveRule, old.body?.missingFromTab,
    oa && [oa.churn_date, oa.churn_cell_state, oa.on_groups_tab, oa.groups_tab_read_at, oa.receive_block, oa.low_places, oa.shared_7d, oa.pool, oa.leads]],
  [200, false, [], [null, null, false, null, null, null, 0, "cleaning", 1234]]);

  T.role = null;
  const anon = await clientsRoute.GET();
  check("no session: 401", anon.status === 401);
  T.role = "manager";
});

// ── N. Nothing left ─────────────────────────────────────────────────────────

section("N. nothing reached a network, nothing was left, no other client changed");
check("no request left for the network", net.refused.length === 0, JSON.stringify(net.refused));
const left = await leftovers();
check("nothing of this test is in the database", Object.values(left).every((n) => n === 0), JSON.stringify(left));
const after = await fingerprint(pool);
check("every other client_tags row exactly as before", after.n === before.n && after.h === before.h, `${before.n} rows before, ${after.n} after`);

await pool.end();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
