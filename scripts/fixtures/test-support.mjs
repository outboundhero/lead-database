// What scripts/test-originals.mjs and scripts/test-pipeline-v2.mjs share:
// the local-database guard, check(), the made-up originals seeded as a test
// client's own variant, a fetch that answers OpenAI, Reoon, Google's DNS, the
// email finders, Enrichley and made-up websites from stubs and refuses every
// other address, the worker's pass over one row, and a loader for the routes'
// TypeScript. Nothing here reaches a network or reads a paid key.

import { readFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { pathToFileURL } from "node:url";
import { fixtureSeedExports } from "./clay-originals/fixtures.mjs";
import { seedOriginals } from "../lib/enrich/seed-originals.mjs";
import { PIPELINE_TEMPLATES, variantName, variantOfNote } from "../lib/enrich/templates.mjs";
import { CLAIM_SQL } from "../lib/enrich/claim.mjs";
import { runRow } from "../lib/enrich/engine.mjs";
import { order } from "../lib/enrich/formula.mjs";
import { projectCompanyV2 } from "../lib/enrich/project-company.mjs";
import { projectContact } from "../lib/enrich/project-contacts.mjs";
import { setPageReadDeps } from "../lib/enrich/page-read.mjs";

/** DATABASE_URL, refused unless it is the local database. */
export function localDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
    process.exit(1);
  }
  return url;
}

/** Every key a step could spend with: removed from the environment, whatever the shell holds. */
export const PAID_KEYS = [
  "OPENAI_API_KEY", "ENRICH_REOON_API_KEY", "REOON_API_KEY", "FINDEMAIL_API_KEY", "ANTHROPIC_API_KEY",
  "AIARK_API_KEY", "AIARK_WEBHOOK_URL", "AIARK_AUTO_ADD_URL", "AIARK_AUTO_ADD_KEY",
  "FINDYMAIL_API_KEY", "PROSPEO_API_KEY", "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY", "ICYPEAS_API_KEY",
  // The share push's key and address (overlap sharing): no test asks a real web app to push.
  "SHARE_PUSH_KEY", "SHARE_PUSH_URL",
];
export function dropPaidKeys() {
  for (const k of PAID_KEYS) delete process.env[k];
}

/** check(name, ok, detail) lines and a total. */
export function checker() {
  const out = {
    passed: 0,
    failed: 0,
    check(name, ok, detail = "") {
      if (ok) out.passed++;
      else out.failed++;
      console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` : ${String(detail).slice(0, 600)}` : ""}`);
    },
    section: (s) => console.log(`\n${s}`),
  };
  return out;
}

/** Runs fn on a client of its own inside a transaction. */
export async function inTx(pool, fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** The made-up originals loaded as a test client's own variant (its tag in lower case). */
export async function seedFixtureVariant(pool, tag) {
  const variant = variantName(tag);
  if (!variant) throw new Error(`${tag} has no variant name`);
  await inTx(pool, (c) => seedOriginals(c, { exports: fixtureSeedExports(), variant, seededBy: "tests" }));
  return variant;
}

// ── The network ─────────────────────────────────────────────────────────────

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const lost = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });

/** Reoon's answer for one word, with the fields G#40 and P#12 read. */
export function reoonAnswer(email, status) {
  const safe = status === "safe";
  return {
    email, status, overall_score: safe ? 98 : 20, is_safe_to_send: safe, is_valid_syntax: true, is_disposable: false,
    is_role_account: status === "role_account", is_catch_all: status === "catch_all", is_deliverable: safe,
    can_connect_smtp: true, mx_accepts_mail: true, domain: String(email).split("@")[1] ?? "", username: String(email).split("@")[0] ?? "",
  };
}

const AI_DEFAULTS = { result: "No", confidence: "low", reasoning: "", company_summary: "A made-up summary.", spaces: "Offices." };

/**
 * Replaces fetch for the whole process. OpenAI answers by the fixtures'
 * "[fx:<column>] <field>=<value>;" marker; Reoon, Google's DNS, the finders
 * and Enrichley from the maps here; websites under .example answer unless
 * dead; anything else is refused and counted.
 */
export function installNet() {
  const net = {
    calls: { openai: 0, reoon: 0, balance: 0, dns: 0, probe: 0, findymail: 0, prospeo: 0, anymail: 0, enrichley: 0, refused: 0 },
    bodies: [], // OpenAI request bodies
    asked: [], // { marker, who } per OpenAI call
    openai: new Map(), // "<marker>|<who>" or "<marker>" -> answer fields
    openaiFail: [], // what OpenAI answers before its normal answers: a status, { status, body }, or 0 for no answer
    searchItems: null, // the output items before the message (default: one web_search_call when a tool is sent)
    reoon: new Map(), // address -> Reoon's word, or a whole answer
    verified: [], // addresses Reoon was asked about
    balance: { daily: 400, instant: 0 },
    dead: new Set(), // website hosts that don't answer
    vendors: { findymail: new Map(), prospeo: new Map(), anymail: new Map(), enrichley: new Map() },
    vendorFail: {}, // vendor -> status to answer once
    requests: [], // { vendor, path, auth, body }: what the finders and Enrichley were sent
    // The pages the email searches open (page-read.mjs, a fetch with redirect "manual"), by "<origin><path>": an
    // HTML string, or { status, body, headers }. Any other page of a .example site is "<html></html>".
    pages: new Map(),
    read: [], // the page addresses opened, in order
  };
  net.calls.page = 0;
  // The page reader's host check: a .example host resolves to a public address, nothing else resolves (no DNS).
  setPageReadDeps({ lookup: testLookup });
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body = null;
    try {
      body = init.body ? JSON.parse(init.body) : null;
    } catch {
      body = init.body ?? null;
    }
    if (u.hostname === "api.openai.com") {
      net.calls.openai++;
      net.bodies.push(body);
      const fail = net.openaiFail.shift();
      if (fail === 0) throw lost();
      if (fail != null) return json(fail.status ?? fail, fail.body ?? { error: { message: "made-up failure" } });
      const m = /\[fx:(\w+)\] (\w+)=([^;]*);/.exec(body?.input ?? "");
      const marker = m?.[1] ?? "";
      const who = (m?.[3] ?? "").trim();
      net.asked.push({ marker, who });
      const plan = net.openai.get(`${marker}|${who}`) ?? net.openai.get(marker) ?? {};
      const fields = body?.text?.format?.schema?.required ?? [];
      const answer = Object.fromEntries(fields.map((f) => [f, plan[f] ?? AI_DEFAULTS[f] ?? "N/A"]));
      const searches = net.searchItems ?? (body?.tools?.length ? [{ type: "web_search_call", action: { type: "search" } }] : []);
      return json(200, {
        output: [...searches, { type: "message", content: [{ type: "output_text", text: JSON.stringify(answer) }] }],
        usage: { input_tokens: 900, output_tokens: 40 },
      });
    }
    if (u.hostname === "emailverifier.reoon.com") {
      if (u.pathname.includes("check-account-balance")) {
        net.calls.balance++;
        return json(200, { status: "success", remaining_daily_credits: net.balance.daily, remaining_instant_credits: net.balance.instant });
      }
      if (u.pathname.endsWith("/verify")) {
        net.calls.reoon++;
        const email = u.searchParams.get("email");
        net.verified.push(email);
        const v = net.reoon.get(email) ?? "invalid";
        return json(200, typeof v === "string" ? reoonAnswer(email, v) : v);
      }
    }
    if (u.hostname === "dns.google.com") {
      net.calls.dns++;
      const name = u.searchParams.get("name");
      return json(200, { Status: 0, Question: [{ name, type: 15 }], Answer: [{ name, type: 15, TTL: 300, data: `10 mx.${name}.` }] });
    }
    const vendor = { "app.findymail.com": "findymail", "api.prospeo.io": "prospeo", "api.anymailfinder.com": "anymail", "api.enrichley.io": "enrichley" }[u.hostname];
    if (vendor) {
      net.calls[vendor]++;
      const auth = headers.authorization ?? headers["x-key"] ?? headers["x-api-key"] ?? null;
      net.requests.push({ vendor, path: u.pathname, auth, body });
      const failOnce = net.vendorFail[vendor];
      if (failOnce) {
        delete net.vendorFail[vendor];
        return json(failOnce, { error: "made-up refusal" });
      }
      const plans = net.vendors[vendor];
      if (vendor === "findymail") {
        const key = body?.linkedin_url ?? body?.name;
        const email = plans.get(key);
        return email ? json(200, { contact: { name: body?.name ?? "", domain: body?.domain ?? "", email } }) : json(404, { error: "Not found" });
      }
      if (vendor === "prospeo") {
        const key = body?.data?.linkedin_url ?? body?.data?.full_name;
        const email = plans.get(key);
        return email
          ? json(200, { error: false, person: { full_name: body?.data?.full_name ?? "", email: { status: "VERIFIED", revealed: true, email } } })
          : json(400, { error: true, error_code: "NO_MATCH" });
      }
      if (vendor === "anymail") {
        const key = body?.linkedin_url ?? body?.full_name;
        const hit = plans.get(key);
        return json(200, { success: true, results: hit ? { email: hit.email, validation: hit.validation ?? "valid" } : { email: null, validation: null } });
      }
      const hit = plans.get(body?.email);
      return json(200, { email: body?.email, valid: hit?.valid ?? false, result: hit?.result ?? "invalid", credits_consumed: true });
    }
    if (u.hostname.endsWith(".example") && init.redirect === "manual") {
      net.calls.page++;
      net.read.push(u.href);
      if (net.dead.has(u.hostname.replace(/^www\./, ""))) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      const page = net.pages.get(`${u.origin}${u.pathname}`) ?? net.pages.get(`${u.origin}${u.pathname.replace(/\/$/, "")}`);
      if (page && typeof page === "object") {
        return new Response(page.body ?? "", { status: page.status ?? 200, headers: { "content-type": "text/html", ...(page.headers ?? {}) } });
      }
      return new Response(typeof page === "string" ? page : "<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (u.hostname.endsWith(".example")) {
      net.calls.probe++;
      if (net.dead.has(u.hostname.replace(/^www\./, ""))) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      return new Response("<html></html>", { status: 200 });
    }
    net.calls.refused++;
    throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
  };
  return net;
}

/** The page reader's host lookup in the tests: a .example host is a public address, nothing else resolves. */
export async function testLookup(host) {
  if (String(host).endsWith(".example")) return [{ address: "93.184.215.14", family: 4 }];
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
}

/** The same rule for a spawned worker: websites under .example answer, nothing else does, and no host is looked up. */
export const WORKER_PRELOAD = `globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname.endsWith(".example")) return new Response("<html></html>", { status: 200 });
  throw Object.assign(new TypeError("fetch failed: no network in this test"), { cause: { code: "ECONNREFUSED" } });
};
const pageRead = await import(${JSON.stringify(new URL("../lib/enrich/page-read.mjs", import.meta.url).href)});
pageRead.setPageReadDeps({ lookup: async (host) => {
  if (String(host).endsWith(".example")) return [{ address: "93.184.215.14", family: 4 }];
  throw Object.assign(new Error("getaddrinfo ENOTFOUND " + host), { code: "ENOTFOUND" });
} });`;

// ── The worker's pass over one row ──────────────────────────────────────────

const workerSource = readFileSync(new URL("../enrich-worker.mjs", import.meta.url), "utf8");
/** The worker's own statements, so a row here is written as the worker writes it. */
export const WORKER_SQL = Object.freeze({
  writeCells: /async function writeCells\([\s\S]*?pool\.query\(\s*`([\s\S]*?)`/.exec(workerSource)[1],
  finish: /async function finish\(r, [\s\S]*?pool\.query\(\s*`([\s\S]*?)`/.exec(workerSource)[1],
  // The claim is three statements (scripts/lib/enrich/claim.mjs: AI Ark pull rows, the email checks, then
  // every other table's). The suites ask it for every row it could take now (n = 100,000), which is what the three
  // take together, so here they run as one statement with the worker's parameters ($1 token, $2 n, $3 retired).
  claim: `WITH pulls AS (${CLAIM_SQL.pulls}), inboxes AS (${CLAIM_SQL.inboxes}), rest AS (${CLAIM_SQL.rest}) SELECT * FROM pulls UNION ALL SELECT * FROM inboxes UNION ALL SELECT * FROM rest`,
});

/** A table as the worker reads it: the variant from its note, its columns in dependency order. */
export async function tableDef(pool, id) {
  const { rows: [table] } = await pool.query(`SELECT id, client_tag, kind, name, template, source_note FROM enrich_tables WHERE id = $1`, [id]);
  table.variant = table.template ? variantOfNote(table.source_note) : undefined;
  table.keyCounts = {};
  const { rows: columns } = await pool.query(
    `SELECT key, name, position, kind, action, formula, waterfall, inputs, config, run_if, provider, needs_env, phase
       FROM enrich_columns WHERE table_id = $1 ORDER BY position`,
    [id]
  );
  return { table, columns: order(columns) };
}

/**
 * One pass of the worker's row loop (processRow in scripts/enrich-worker.mjs):
 * claim, work every column, write the cells and run records, then queue a
 * retryable row again, or write its summary (company, inbox or People row, by
 * its table's template) and finish it.
 *
 * @returns the engine's answer with status, projected, runs, paid (net calls made) and cell(key)
 */
export async function workRow(pool, net, rowId, { env, settings }) {
  const { rows: [r] } = await pool.query(
    `UPDATE enrich_rows SET run_status = 'running', claim_token = gen_random_uuid(), claimed_at = now(), attempts = attempts + 1, updated_at = now()
      WHERE id = $1 RETURNING id, table_id, run_force, attempts, created_at, claim_token, next_run_at`,
    [rowId]
  );
  const { table, columns } = await tableDef(pool, r.table_id);
  const { rows: stored } = await pool.query(`SELECT column_key, status, value, display, note, input_hash FROM enrich_cells WHERE row_id = $1`, [r.id]);
  const cells = new Map(stored.map((c) => [c.column_key, c]));
  const pending = new Map();
  const runs = [];
  const before = { ...net.calls };
  const result = await runRow({ row: r, table, columns, cells, env, db: pool, settings, hooks: { changed: (k, c) => pending.set(k, c), ran: (x) => runs.push(x) } });
  await pool.query(WORKER_SQL.writeCells, [r.id, r.table_id, r.claim_token, JSON.stringify([...pending].map(([column_key, c]) => ({ column_key, ...c }))), JSON.stringify(runs)]);
  const project = (status) => {
    const opts = { rowId: r.id, claimToken: r.claim_token, tableId: r.table_id, clientTag: table.client_tag, values: result.values, waiting: status === "waiting", failed: status === "error" };
    if (table.template === PIPELINE_TEMPLATES.companies.template) return projectCompanyV2(pool, opts);
    if (table.template === PIPELINE_TEMPLATES.inboxes.template) return projectContact(pool, { ...opts, kind: "general" });
    if (table.template === PIPELINE_TEMPLATES.people.template) return projectContact(pool, { ...opts, kind: "person" });
    return null;
  };
  let status;
  let projected = null;
  if (result.retryable && r.attempts < 3) {
    status = "queued";
    await pool.query(WORKER_SQL.finish, [r.id, r.claim_token, "queued", new Date(Date.now() + 30_000).toISOString(), result.retryable, null]);
  } else if (result.errors) {
    status = "error";
    projected = await project(status);
    await pool.query(WORKER_SQL.finish, [r.id, r.claim_token, status, null, result.retryable ?? `${result.errors} cell(s) failed`, null]);
  } else {
    status = result.needsKey ? "waiting" : "done";
    projected = await project(status);
    await pool.query(WORKER_SQL.finish, [r.id, r.claim_token, status, null, null, null]);
  }
  const paid = Object.fromEntries(Object.keys(net.calls).map((k) => [k, net.calls[k] - before[k]]));
  return { ...result, status, projected, runs, paid, table, cell: (k) => pending.get(k) ?? cells.get(k) };
}

// ── The routes' TypeScript, compiled as it is imported ──────────────────────
// "@/..." is src/, as in tsconfig. The session, the audit log and the worker's
// heartbeat are stand-ins the checks set through globalThis.__routeTest.

export const ROUTE_STUBS = {
  "next/server": `export class NextRequest {}
export class NextResponse {
  static json(body, init = {}) { return { status: init.status ?? 200, body, headers: init.headers ?? {} }; }
}`,
  "@/lib/enrich/auth": `import { NextResponse } from "next/server";
import { hasPermission } from "@/types/auth";
export async function requireRole(min) {
  const t = globalThis.__routeTest;
  if (!t.role) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!hasPermission(t.role, min)) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  return { user: { id: t.userId }, role: t.role };
}
export function intakeKeyStatus() { return "unauthorized"; }`,
  "@/lib/api/log-audit": `export async function logAudit(entry) { globalThis.__routeTest.audits.push(entry); }`,
  "@/lib/enrich/queries": `export async function workerState() { return globalThis.__routeTest.worker; }`,
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

/**
 * Registers the loader once and returns { T, route, srcModule, call, heartbeat }:
 * T is the stand-ins' state (role, userId, audits, worker).
 *
 * call(handler, { body, query, headers, params }) hands the handler a request
 * stand-in (json(), text(), nextUrl, headers) and, as Next does for a route
 * with a dynamic segment, { params: Promise<params> } as its second argument.
 * text() gives a string body as it is, anything else as JSON.
 */
export function routeLoader(userId) {
  const require = createRequire(import.meta.url);
  const src = new URL("../../src/", import.meta.url).href;
  register(`data:text/javascript,${encodeURIComponent(HOOKS)}`, {
    data: { typescript: pathToFileURL(require.resolve("typescript")).href, src, stubs: ROUTE_STUBS },
  });
  const T = (globalThis.__routeTest = { role: "manager", userId, audits: [], worker: null });
  const srcModule = (p) => import(new URL(p, src).href);
  const route = (p) => srcModule(`app/api/${p}/route.ts`);
  const call = async (handler, { body, query, headers, params } = {}) => {
    const qs = query ? `?${new URLSearchParams(query)}` : "";
    const req = {
      json: async () => body,
      text: async () => (typeof body === "string" ? body : body === undefined ? "" : JSON.stringify(body)),
      nextUrl: new URL(`http://routes.test/api${qs}`),
      headers: new Headers(headers ?? {}),
    };
    const res = await handler(req, { params: Promise.resolve(params ?? {}) });
    return { status: res.status, body: res.body };
  };
  const heartbeat = ({ online = true, capabilities = ["company_runs", "pipeline_v2"] } = {}) => ({
    id: "routes-test",
    last_seen: new Date().toISOString(),
    started_at: new Date().toISOString(),
    seconds_ago: online ? 2 : 600,
    online,
    info: { capabilities, keys: {}, reoon: null },
  });
  return { T, route, srcModule, call, heartbeat };
}
