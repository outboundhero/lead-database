#!/usr/bin/env node
// The question variable on the push side (migration 139): the pure module
// scripts/lib/push-question-var.mjs, the push worker driven against a made-up
// Bison, the push-batch route, the Exports page's list route, and the popup's
// selection helper (src/lib/exports/push-selection.ts).
//
// LOCAL DATABASE ONLY: made-up clients XQ4A-OS, XQ4B and XQ4C-OS (named
// "Made-up xq4 ..."), made-up leads at xq4.xxtest.example, made-up question
// variables named "xq4...", made-up push batches; all removed at the end (and
// any left by a run that was cut off). For the route checks it switches
// question_variables on for its own clients and puts the setting back.
//
//   node --env-file=.env.local scripts/test-push-question-var.mjs
//
// Run it under the shared local-database lock. Migration 139 must be in the
// local database, and no other push batch may be active there (the worker's
// housekeeping touches every batch).
//
// Nothing reaches a network. The push worker runs as a child process
// (PUSH_WORKER_ONCE=1, one install at a time with PUSH_INSTANCE) with fetch
// replaced by a made-up Bison for three made-up installs (*.xxtest.example) and
// made-up keys; every other address is refused and counted. No paid key is read.
// The routes run for real through routeLoader (scripts/fixtures/test-support.mjs),
// with the push routes' Supabase session and admin client and the shared pool
// stood in for by the local database.
//
//   P. the pure module: every export, Bison's refusal shapes, the 10-minute cache,
//      the extra variable never displaces the eleven
//   S. the popup's selection helper: the push body as it was before
//   W. the push worker: a batch without a variable sends exactly the old payload;
//      one with a variable sends it on create, PATCHes existing leads, skips
//      leads without a value, fails cleanly where the install lacks it; a missing
//      multi-word fixed name is learned and dropped
//   R. POST /api/bison/push-batch: questionVariableId without clientTag, not an
//      id, switch off, unknown, archived, stored on success, absent as before
//   L. GET /api/bison/push-batches: question_variable_name, and its fallbacks
//   N. nothing reached the network, everything removed

import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire, register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checker, dropPaidKeys, localDatabaseUrl, routeLoader } from "./fixtures/test-support.mjs";
import {
  appendExtraVars, CUSTOM_VARIABLES_TTL_MS, extraVarsFor, fixedVariableName, holdsValue, installHasVariable,
  loadQuestionValues, missingVariableName, MISSING_RECHECK_MS, notSetUpError, notSetUpReason, patchPayload,
  QUESTION_VALUES_SQL, questionVarFor,
} from "./lib/push-question-var.mjs";
import { RESERVED_VARIABLE_NAMES } from "./lib/questions/names.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
for (const k of ["EMAILBISON_API_KEY", "EMAILBISON_BASE_URL", "EMAILBISON_KEYS", "PUSH_INSTANCE", "PUSH_SPAN_ONLY"]) delete process.env[k];

const t0 = Date.now();
const counts = checker();
const { check, section } = counts;

const RUN = randomUUID().slice(0, 6);
const HOST = "xq4.xxtest.example";
const I1 = "pq-one.xxtest.example"; // the eleven names and the variable
const I2 = "pq-two.xxtest.example"; // the eleven only
const I3 = "pq-three.xxtest.example"; // no "company phone"; lists the variable but refuses it on create
const KEYS = { [I1]: "xq4-made-up-key-one", [I2]: "xq4-made-up-key-two", [I3]: "xq4-made-up-key-three" };
process.env.EMAILBISON_KEYS = JSON.stringify(KEYS);
const A = "XQ4A-OS"; // an OS client with a question variable
const B = "XQ4B"; // a client that pushes without one
const C = "XQ4C-OS"; // an OS client with an archived variable
const TAGS = [A, B, C];
const VAR = "xq4a-os question";
const VAR_TAG = "{XQ4A-OS QUESTION}";
const VAR_ARCH = "xq4c-os old question";
const VAR_GONE = "xq4 gone question";
const email = (who) => `xq4-${who}-${RUN}@${HOST}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const without = (o, key) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k !== key));
// Does a logged request name this lead's address (in a body, or URL-encoded in a path)?
const names = (e, l) => {
  const s = JSON.stringify(e).toLowerCase();
  return s.includes(l.email.toLowerCase()) || s.includes(encodeURIComponent(l.email).toLowerCase());
};
const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([p], [q]) => p.localeCompare(q))) : v));
const ELEVEN = ["person linkedin url", "category", "sub-category", "additional category", "city", "state", "domain", "address", "question", "company phone", "google maps url"];

// The parent never fetches: anything that tries is refused and counted.
let parentRefused = 0;
globalThis.fetch = async () => {
  parentRefused++;
  throw Object.assign(new TypeError("fetch failed: this test allows no network"), { cause: { code: "ECONNREFUSED" } });
};

const pool = new pg.Pool({ connectionString: url, max: 4 });
const all = async (sql, p = []) => (await pool.query(sql, p)).rows;
const one = async (sql, p = []) => (await pool.query(sql, p)).rows[0] ?? null;

// ── The routes' TypeScript (routeLoader), plus the push routes' Supabase clients and pool ──
const userId = randomUUID();
const { T, route, srcModule, call } = routeLoader(userId);
T.adminOps = [];
T.adminAudits = [];
T.missingColumns = [];
const require = createRequire(import.meta.url);
const pgUrl = pathToFileURL(require.resolve("pg")).href;
const EXTRA_STUBS = {
  "@/lib/supabase/server": `export async function createClient() {
  return { auth: { getUser: async () => {
    const t = globalThis.__routeTest;
    return { data: { user: t.role ? { id: t.userId, email: "xq4-user@${HOST}" } : null } };
  } } };
}`,
  "@/lib/supabase/admin": `export function createAdminClient() {
  return {
    from(table) {
      const op = { table, action: "select", fields: null, payload: null, filters: [], limit: null };
      const b = {
        select(f) { if (op.action === "select") op.fields = f ?? "*"; return b; },
        insert(p) { op.action = "insert"; op.payload = p; return b; },
        update(p) { op.action = "update"; op.payload = p; return b; },
        eq(k, v) { op.filters.push(["eq", k, v]); return b; },
        in(k, v) { op.filters.push(["in", k, v]); return b; },
        gte(k, v) { op.filters.push(["gte", k, v]); return b; },
        order() { return b; },
        limit(n) { op.limit = n; return b; },
        single() { return b; },
        maybeSingle() { return b; },
        then(ok, bad) { return Promise.resolve(globalThis.__pqAdmin(op)).then(ok, bad); },
      };
      return b;
    },
  };
}`,
  "@/lib/db/pool": `import pg from "${pgUrl}";
let p = null;
export function getPool() {
  if (!p) { p = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }); globalThis.__pqPools.push(p); }
  return p;
}`,
};
// Registered after routeLoader's hooks, so it is asked first (hooks chain last in, first out).
const EXTRA_HOOKS = `let stubs = {};
export async function initialize(data) { stubs = data.stubs; }
export async function resolve(specifier, context, next) {
  if (Object.hasOwn(stubs, specifier)) return { url: "data:text/javascript," + encodeURIComponent(stubs[specifier]), shortCircuit: true };
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(EXTRA_HOOKS)}`, { data: { stubs: EXTRA_STUBS } });
globalThis.__pqPools = [];
const JSON_COLS = new Set(["campaigns", "filters", "target_market", "push_options"]);
// The push routes' admin client, answered from and written to the local database (only the calls those routes make).
globalThis.__pqAdmin = async (op) => {
  T.adminOps.push(op);
  const eq = (k) => op.filters.find((f) => f[0] === "eq" && f[1] === k)?.[2];
  const fail = (e) => ({ data: null, error: { code: e.code, message: e.message } });
  try {
    if (op.table === "user_profiles") return { data: T.role ? { role: T.role } : null, error: null };
    if (op.table === "client_tags" && op.action === "select") {
      return { data: await one(`SELECT tag, group_no, b2b_instance, b2c_instance FROM client_tags WHERE tag = $1`, [eq("tag")]), error: null };
    }
    if (op.table === "client_targeting" && op.action === "select") {
      return { data: await one(`SELECT ${op.fields} FROM client_targeting WHERE client_tag = $1`, [eq("client_tag")]), error: null };
    }
    if (op.table === "push_batches" && op.action === "insert") {
      // Every key the route sends, as a column: a misspelt one fails here as it would in Supabase.
      const p = { ...op.payload, created_by: null }; // the made-up user is not in auth.users
      const cols = Object.keys(p);
      const vals = cols.map((k) => (JSON_COLS.has(k) && p[k] != null ? JSON.stringify(p[k]) : p[k]));
      const casts = cols.map((k, i) => (JSON_COLS.has(k) ? `$${i + 1}::jsonb` : k === "selected_ids" ? `$${i + 1}::uuid[]` : `$${i + 1}`));
      return { data: await one(`INSERT INTO push_batches (${cols.join(", ")}) VALUES (${casts.join(", ")}) RETURNING id`, vals), error: null };
    }
    if (op.table === "push_batches" && op.action === "select") {
      const fields = String(op.fields).split(",").map((f) => f.trim());
      const gone = fields.find((f) => T.missingColumns.includes(f));
      if (gone) return { data: null, error: { code: "42703", message: `column push_batches.${gone} does not exist` } };
      return {
        data: await all(`SELECT ${fields.join(", ")} FROM push_batches WHERE client_tag LIKE 'XQ4%' ORDER BY created_at DESC LIMIT $1`, [op.limit ?? 20]),
        error: null,
      };
    }
    if (op.table === "audit_logs" && op.action === "insert") {
      T.adminAudits.push(op.payload);
      return { data: null, error: null };
    }
    if (op.table === "client_tags" && op.action === "update") return { data: null, error: null };
    return { data: null, error: { message: `the test's admin client does not answer ${op.table} ${op.action}` } };
  } catch (e) {
    return fail(e);
  }
};

// ── The made-up Bison the worker talks to (child process preload) ────────────
// Plan from PQ_PLAN, every request appended to PQ_LOG with the step PQ_RUN.
// No backticks or template slots in here: it is one String.raw text.
const PRELOAD = String.raw`
import { readFileSync, appendFileSync } from "node:fs";
const plan = JSON.parse(readFileSync(process.env.PQ_PLAN, "utf8"));
const LOG = process.env.PQ_LOG;
const STEP = process.env.PQ_RUN || "";
const state = {};
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();
const out = (status, body) => new Response(JSON.stringify(body), { status: status, headers: { "content-type": "application/json" } });
function stateOf(host) {
  if (!state[host]) {
    const inst = plan.installs[host];
    const s = { next: inst.firstId, byId: {}, byEmail: {}, missed: {} };
    for (const l of inst.existing || []) {
      const c = JSON.parse(JSON.stringify(l));
      s.byId[String(c.id)] = c;
      s.byEmail[lower(c.email)] = c;
    }
    state[host] = s;
  }
  return state[host];
}
globalThis.fetch = async (input, init) => {
  init = init || {};
  const u = new URL(typeof input === "string" ? input : (input.url || String(input)));
  const method = String(init.method || "GET").toUpperCase();
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch (e) { body = String(init.body); }
  const headers = init.headers || {};
  const entry = { step: STEP, method: method, host: u.hostname, path: u.pathname, query: u.search, body: body, auth: headers.Authorization || headers.authorization || null };
  const inst = plan.installs[u.hostname];
  if (!inst) {
    entry.status = "refused";
    appendFileSync(LOG, JSON.stringify(entry) + "\n");
    throw Object.assign(new TypeError("fetch failed: no network in this test"), { cause: { code: "ECONNREFUSED" } });
  }
  const reply = (status, b) => { entry.status = status; appendFileSync(LOG, JSON.stringify(entry) + "\n"); return out(status, b); };
  const s = stateOf(u.hostname);
  const parts = u.pathname.split("/").filter(Boolean);
  const vars = (inst.vars || []).map(lower);
  const refused = (inst.refuseOnCreate || []).map(lower);
  const quoted = (inst.quote || []).map(lower);
  const firstMissing = (list, onCreate) => {
    for (const v of list || []) {
      const n = lower(v && v.name);
      if (vars.indexOf(n) < 0 || (onCreate && refused.indexOf(n) >= 0)) return v.name;
    }
    return null;
  };
  const refusal = (name) => ({ message: quoted.indexOf(lower(name)) >= 0
    ? 'You do not have a custom variable named "' + name + '". Please create it first.'
    : "You do not have a custom variable named " + name + ". Please create it first." });
  if (method === "GET" && u.pathname === "/api/custom-variables") {
    const page = Number(u.searchParams.get("page") || "1");
    const per = 15;
    const last = Math.max(1, Math.ceil(inst.vars.length / per));
    const rows = inst.vars.slice((page - 1) * per, page * per).map((name, i) => ({ id: (page - 1) * per + i + 1, name: name }));
    return reply(200, { data: rows, links: { next: page < last ? "https://" + u.hostname + "/api/custom-variables?page=" + (page + 1) : null }, meta: { current_page: page, last_page: last } });
  }
  if (parts[0] === "api" && parts[1] === "leads" && parts.length === 2 && method === "POST") {
    const missing = firstMissing(body && body.custom_variables, true);
    if (missing) return reply(422, refusal(missing));
    const em = lower(body && body.email);
    if ((inst.taken || []).map(lower).indexOf(em) >= 0) return reply(422, { message: "The email has already been taken." });
    const id = s.next++;
    const lead = { id: id, email: body.email, status: "active", lead_campaign_data: [], custom_variables: body.custom_variables || [] };
    s.byId[String(id)] = lead;
    s.byEmail[em] = lead;
    return reply(200, { data: { id: id } });
  }
  if (parts[0] === "api" && parts[1] === "leads" && parts.length === 3) {
    const key = decodeURIComponent(parts[2]);
    const isId = /^[0-9]+$/.test(key);
    const lead = isId ? s.byId[key] : s.byEmail[lower(key)];
    if (method === "GET") {
      if (!isId && (inst.missFirstLookup || []).map(lower).indexOf(lower(key)) >= 0 && !s.missed[lower(key)]) {
        s.missed[lower(key)] = true;
        return reply(404, { data: { success: false, message: "Lead not found" } });
      }
      return lead ? reply(200, { data: lead }) : reply(404, { data: { success: false, message: "Lead not found" } });
    }
    if (!lead) return reply(404, { message: "Lead not found" });
    if (method === "PUT") {
      lead.custom_variables = (body && body.custom_variables) || [];
      return reply(200, { data: { id: lead.id } });
    }
    if (method === "PATCH") {
      const missing = firstMissing(body && body.custom_variables, false);
      if (missing) return reply(422, refusal(missing));
      for (const v of (body && body.custom_variables) || []) {
        const at = lead.custom_variables.findIndex((x) => lower(x.name) === lower(v.name));
        if (at >= 0) lead.custom_variables[at] = { name: v.name, value: v.value };
        else lead.custom_variables.push({ name: v.name, value: v.value });
      }
      return reply(200, { data: lead });
    }
  }
  if (parts[0] === "api" && parts[1] === "campaigns" && parts[3] === "leads" && parts[4] === "attach-leads" && method === "POST") {
    return reply(200, { data: { message: "Leads successfully added" } });
  }
  if (parts[0] === "api" && parts[1] === "campaigns" && parts.length === 3 && method === "GET") {
    return reply(200, { data: { id: Number(parts[2]), name: "XQ4: Made-up campaign", status: "active" } });
  }
  return reply(404, { message: "not found" });
};
`;
const PLAN_FILE = join(tmpdir(), `xq4-bison-plan-${RUN}.json`);
const LOG_FILE = join(tmpdir(), `xq4-bison-log-${RUN}.jsonl`);
const WORKER = fileURLToPath(new URL("./push-worker.mjs", import.meta.url));
const readLog = () => (existsSync(LOG_FILE) ? readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function runWorker(install, step) {
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(PRELOAD)}`, WORKER], {
    env: {
      ...process.env, DATABASE_URL: url, EMAILBISON_KEYS: JSON.stringify(KEYS), PUSH_WORKER_ONCE: "1", PUSH_INSTANCE: install,
      PUSH_RATE: "200", PUSH_CONCURRENCY: "4", PUSH_SPOT_CHECK: "0", PQ_PLAN: PLAN_FILE, PQ_LOG: LOG_FILE, PQ_RUN: step,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Runs the worker on one install until none of this test's batches there is open (at most four runs). */
async function drain(install, step) {
  let last = { status: 0, out: "" };
  for (let i = 0; i < 4; i++) {
    const open = await one(
      `SELECT count(*)::int AS n FROM push_batches b
        WHERE b.client_tag LIKE 'XQ4%' AND b.campaigns->0->>'instance_url' = $1
          AND (b.status IN ('pending', 'gathering') OR (b.status = 'processing' AND EXISTS (
                SELECT 1 FROM push_items i WHERE i.batch_id = b.id AND i.status IN ('pending', 'pushing'))))`,
      [install]
    );
    if (open.n === 0) break;
    last = runWorker(install, step);
    if (last.status !== 0) break;
  }
  return last;
}

// ── The database ────────────────────────────────────────────────────────────

let settingsBefore = null;

async function cleanup() {
  await pool.query(`DELETE FROM push_items WHERE batch_id IN (SELECT id FROM push_batches WHERE client_tag LIKE 'XQ4%')`);
  await pool.query(`DELETE FROM push_batches WHERE client_tag LIKE 'XQ4%'`);
  await pool.query(`DELETE FROM client_question_settings WHERE client_tag LIKE 'XQ4%'`);
  await pool.query(`DELETE FROM question_variables WHERE name LIKE 'xq4%'`); // its values go with it (cascade)
  await pool.query(`DELETE FROM client_targeting WHERE client_tag LIKE 'XQ4%'`);
  await pool.query(`DELETE FROM client_tags WHERE tag LIKE 'XQ4%' AND name LIKE 'Made-up xq4%'`);
  await pool.query(`DELETE FROM leads WHERE email LIKE 'xq4-%@${HOST}'`);
}

async function setSwitch(v) {
  await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'question_variables'`, [JSON.stringify({ ...settingsBefore, ...v })]);
}

async function client(tag, type, b2b) {
  await pool.query(
    `INSERT INTO client_tags (tag, b2b_instance, status, client_type, name) VALUES ($1, $2, 'Active', $3, $4)`,
    [tag, b2b, type, `Made-up xq4 client ${tag.toLowerCase()}`]
  );
}

const FULL = (who) => ({
  first_name: `First${who}`, last_name: "Madeup", title: "Owner", company: `Xq4 ${who} Co`, notes: `made-up note ${who}`,
  person_linkedin: `https://linkedin.${HOST.replace("xq4.", "")}/in/xq4-${who}`, category: "Made-up Category", subcategory: "Made-up Sub",
  additional_category: "Made-up Extra", city: "Phoenix", state: "AZ", domain: HOST, address: "1 Made-up Way",
  question: `made-up default question for ${who}?`, company_phone: "555-0100", google_maps_url: `https://maps.${HOST.replace("xq4.", "")}/xq4-${who}`,
  tags: "xq4-own-tag",
});
const LEAD_COLS = ["email", "first_name", "last_name", "title", "company", "notes", "person_linkedin", "category", "subcategory",
  "additional_category", "city", "state", "domain", "address", "question", "company_phone", "google_maps_url", "tags"];
async function lead(who, fields = {}) {
  const row = { email: email(who), ...fields };
  const cols = LEAD_COLS.filter((c) => row[c] !== undefined);
  const r = await one(
    `INSERT INTO leads (${cols.join(", ")}, country_code, location_status, email_type, validation_status)
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}, 'US', 'resolved', 'personal', 'valid') RETURNING *`,
    cols.map((c) => row[c])
  );
  return r;
}

async function variable(name, tag, { archived = false, promptVersion = 1 } = {}) {
  return (await one(
    `INSERT INTO question_variables (name, created_for_tag, services, prompt_version, archived_at)
     VALUES ($1, $2, 'Made-up services', $3, CASE WHEN $4 THEN now() ELSE NULL END) RETURNING id`,
    [name, tag, promptVersion, archived]
  )).id;
}

async function value(variableId, leadId, v, { status = "done", promptVersion = 1 } = {}) {
  await pool.query(
    `INSERT INTO lead_question_values (variable_id, lead_id, status, value, prompt_version) VALUES ($1, $2, $3, $4, $5)`,
    [variableId, leadId, status, v, promptVersion]
  );
}

async function batch(tag, install, leadIds, qv = null) {
  return (await one(
    `INSERT INTO push_batches (campaigns, selected_ids, client_tag, status, question_variable_id, question_variable_name)
     VALUES ($1::jsonb, $2::uuid[], $3, 'pending', $4, $5) RETURNING id`,
    [JSON.stringify([{ id: "901", name: `${tag}: Made-up main`, instance_url: install }]), leadIds, tag, qv?.id ?? null, qv?.name ?? null]
  )).id;
}

const itemsOf = async (batchId) =>
  Object.fromEntries((await all(`SELECT lead_id, status, error FROM push_items WHERE batch_id = $1`, [batchId])).map((r) => [r.lead_id, r]));

// ── P. The pure module ──────────────────────────────────────────────────────

async function partP() {
  section("P. scripts/lib/push-question-var.mjs");
  const id = randomUUID();
  check("questionVarFor: a batch that names none (every batch before 139) is null",
    questionVarFor({}) === null && questionVarFor({ question_variable_id: null, question_variable_name: null }) === null &&
      questionVarFor(undefined) === null && questionVarFor({ question_variable_id: "", question_variable_name: "" }) === null);
  check("questionVarFor: id and name, with the copy form",
    same(questionVarFor({ question_variable_id: id, question_variable_name: VAR }), { id, name: VAR, copyTag: VAR_TAG, problem: null }));
  check("... a name stored in another case or with spaces around is read as its stored form",
    questionVarFor({ question_variable_id: id, question_variable_name: " XQ4A-OS Question " })?.name === VAR);
  const gone = questionVarFor({ question_variable_id: null, question_variable_name: VAR_GONE });
  check("questionVarFor: a name whose variable was deleted (the foreign key set the id to NULL) is a problem, not a plain push",
    gone?.id === null && gone.problem === "{XQ4 GONE QUESTION} no longer exists (deleted after this push was queued)", JSON.stringify(gone));
  check("questionVarFor: an id with no usable name (empty, reserved, or not a stored form) is a problem",
    [null, "", "question", "Company Phone", "bad*name", "x".repeat(64)].every((n) => typeof questionVarFor({ question_variable_id: id, question_variable_name: n })?.problem === "string"));

  const b = { question_variable_id: id, question_variable_name: VAR };
  const values = new Map([[id, new Map([["l1", "made-up question one?"], ["l2", "  "]])]]);
  check("extraVarsFor: a batch without a variable sends nothing more", same(extraVarsFor({ id: "l1" }, values, { client_tag: B }), { vars: [] }));
  check("extraVarsFor: a lead with a written value sends it under the stored name",
    same(extraVarsFor({ id: "l1" }, values, b), { vars: [{ name: VAR, value: "made-up question one?" }] }));
  check("extraVarsFor: no value, or a blank one, skips the lead with the reason",
    same(extraVarsFor({ id: "l9" }, values, b), { skip: `no ${VAR_TAG} written yet` }) && same(extraVarsFor({ id: "l2" }, values, b), { skip: `no ${VAR_TAG} written yet` }) &&
      same(extraVarsFor({ id: "l1" }, new Map(), b), { skip: `no ${VAR_TAG} written yet` }));
  const err = new Error("made-up read failure");
  check("extraVarsFor: values that could not be read ask for a retry, never a skip",
    extraVarsFor({ id: "l1" }, new Map([[id, err]]), b).retry === err);
  check("extraVarsFor: a batch whose variable cannot be sent skips with that reason",
    same(extraVarsFor({ id: "l1" }, values, { question_variable_id: null, question_variable_name: VAR_GONE }), { skip: gone.problem }));

  const eleven = ELEVEN.map((name, i) => ({ name, value: `v${i}` }));
  check("appendExtraVars: no extra gives back the very same array (the payload is unchanged)",
    appendExtraVars(eleven, []) === eleven && appendExtraVars(eleven, undefined) === eleven && appendExtraVars(eleven, null) === eleven);
  const twelve = appendExtraVars(eleven, [{ name: VAR, value: "q?" }]);
  check("appendExtraVars: the extra one comes after the eleven, which keep their names, values and order",
    twelve.length === 12 && same(twelve.slice(0, 11), eleven) && same(twelve[11], { name: VAR, value: "q?" }) && eleven.length === 11);
  check("appendExtraVars: it never displaces or repeats a fixed name, in any case, even one this lead does not send",
    same(appendExtraVars(eleven, [{ name: "question", value: "x" }, { name: "Company Phone", value: "x" }]), eleven) &&
      same(appendExtraVars([], [{ name: "QUESTION", value: "x" }]), []));
  check("appendExtraVars: an empty value or a repeated extra is left out; names are stored in lower case",
    same(appendExtraVars(eleven.slice(0, 2), [{ name: "XQ4A-OS Question", value: "a" }, { name: VAR, value: "b" }, { name: "xq4 other", value: "" }]),
      [...eleven.slice(0, 2), { name: VAR, value: "a" }]));

  check("patchPayload: only custom_variables, one name and its value as text",
    same(patchPayload(VAR, "made-up?"), { custom_variables: [{ name: VAR, value: "made-up?" }] }) &&
      Object.keys(patchPayload(VAR, 7)).length === 1 && patchPayload(VAR, 7).custom_variables[0].value === "7");
  check("holdsValue: the same value under the name in any case; anything else does not hold it",
    holdsValue({ custom_variables: [{ name: "XQ4A-OS Question", value: "q?" }] }, VAR, "q?") &&
      !holdsValue({ custom_variables: [{ name: VAR, value: "older?" }] }, VAR, "q?") &&
      !holdsValue({ custom_variables: {} }, VAR, "q?") && !holdsValue(null, VAR, "q?") && !holdsValue({}, VAR, "q?"));
  check("fixedVariableName: the eleven, in any case; nothing else",
    ELEVEN.every((n) => fixedVariableName(n.toUpperCase()) === n) && fixedVariableName(VAR) === null && fixedVariableName("") === null &&
      same([...RESERVED_VARIABLE_NAMES].sort(), [...ELEVEN].sort()));

  const wrap = (m) => `Bison POST https://${I1}/api/leads -> 422: ${m}`;
  const shapes = [
    ["You do not have a custom variable named subcategory", "subcategory"],
    [wrap("You do not have a custom variable named subcategory. Please create it first"), "subcategory"],
    [wrap("You do not have a custom variable named company phone. Please create it first"), "company phone"],
    [wrap(`You do not have a custom variable named "${VAR}". Please create it first.`), VAR],
    [wrap(`You do not have a custom variable named '${VAR}'`), VAR],
    [wrap(`You do not have a custom variable named “${VAR}”.`), VAR],
    [wrap("You do not have a custom variable named XQ4A-OS QUESTION"), "XQ4A-OS QUESTION"],
    ["You do not have a custom variable named google maps url.\nSomething else", "google maps url"],
    ["You do not have a custom variable named additional category, please create it", "additional category"],
    ["You do not have a custom variable named person linkedin url please create it first", "person linkedin url"],
    ["custom variable named   sub-category  ", "sub-category"],
  ];
  const bad = shapes.filter(([m, want]) => missingVariableName(m) !== want);
  check("missingVariableName: the WHOLE name, quoted or up to \". Please\", punctuation or the end of the line",
    bad.length === 0, JSON.stringify(bad.map(([m]) => [m, missingVariableName(m)])));
  check("... where the old capture took only the first word",
    /custom variable named\s+"?([A-Za-z0-9_-]+)/i.exec(shapes[2][0])[1] === "company" && missingVariableName(shapes[2][0]) === "company phone");
  check("missingVariableName: anything else is null",
    [wrap("The email has already been taken."), "", null, undefined, "custom variable named ", "custom variable named ."].every((m) => missingVariableName(m) === null));
  check("notSetUpReason / notSetUpError: the Clay-tab reason, failed at once (422)",
    notSetUpReason(VAR, I2) === `${VAR_TAG} isn't set up on ${I2}: create it on the Clay tab` &&
      notSetUpError(VAR, I2).message === notSetUpReason(VAR, I2) && notSetUpError(VAR, I2).status === 422);

  // installHasVariable: a stand-in for the worker's Bison call and a clock.
  let clock = 1_000_000;
  const now = () => clock;
  const lists = { [I1]: [...ELEVEN, "unique service question", "acme note", "xq4 a", "xq4 b", "XQ4A-OS Question"] };
  const calls = [];
  let failNext = null;
  const fetchFn = async (auth, method, path) => {
    calls.push(`${auth.domain} ${method} ${path}`);
    await new Promise((r) => setTimeout(r, 5));
    if (failNext) { const e = failNext; failNext = null; throw e; }
    const page = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
    const names = lists[auth.domain] ?? [];
    const last = Math.max(1, Math.ceil(names.length / 15));
    return { data: names.slice((page - 1) * 15, page * 15).map((name, i) => ({ id: i + 1, name })), meta: { current_page: page, last_page: last } };
  };
  const cache = new Map();
  const a1 = { domain: I1 };
  const both = await Promise.all([installHasVariable(fetchFn, a1, VAR, cache, { now }), installHasVariable(fetchFn, a1, VAR, cache, { now })]);
  check("installHasVariable: two pages read once for leads asking together; names compared in lower case",
    same(both, [true, true]) && same(calls, [`${I1} GET /api/custom-variables?page=1`, `${I1} GET /api/custom-variables?page=2`]), JSON.stringify(calls));
  clock += CUSTOM_VARIABLES_TTL_MS - 1;
  check("... and not read again within ten minutes", (await installHasVariable(fetchFn, a1, VAR, cache, { now })) === true && calls.length === 2);
  clock += 2;
  check("... read again after ten minutes", (await installHasVariable(fetchFn, a1, VAR, cache, { now })) === true && calls.length === 4);
  check("installHasVariable: a name the install lacks is false", (await installHasVariable(fetchFn, a1, "xq4 missing", cache, { now })) === false && calls.length === 4);
  clock += MISSING_RECHECK_MS - 1;
  check("... and the list that lacks it is not read again within a minute",
    (await installHasVariable(fetchFn, a1, "xq4 missing", cache, { now })) === false && calls.length === 4);
  lists[I1].push("xq4 missing");
  clock += 2;
  check("... but after a minute (created on the Clay tab meanwhile): read again, and found",
    (await installHasVariable(fetchFn, a1, "xq4 missing", cache, { now })) === true && calls.length === 6);
  check("installHasVariable: each install has its own list", (await installHasVariable(fetchFn, { domain: I2 }, VAR, cache, { now })) === false &&
    calls.at(-1) === `${I2} GET /api/custom-variables?page=1`);
  const c2 = new Map();
  failNext = Object.assign(new Error("Bison GET -> 503: made-up"), { status: 503 });
  let threw = null;
  try { await installHasVariable(fetchFn, a1, VAR, c2, { now }); } catch (e) { threw = e; }
  check("installHasVariable: a failed read throws (the lead is tried again) and is not kept",
    threw?.status === 503 && !c2.has(I1) && (await installHasVariable(fetchFn, a1, VAR, c2, { now })) === true);
  const linkOnly = async (auth, method, path) => {
    const page = Number(/page=(\d+)/.exec(path)?.[1] ?? 1);
    return page === 1 ? { data: [{ id: 1, name: "city" }], links: { next: "https://x/api/custom-variables?page=2" } } : { data: [{ id: 2, name: VAR }], links: { next: null } };
  };
  check("installHasVariable: follows links.next when there is no meta.last_page", (await installHasVariable(linkOnly, { domain: "l.xxtest.example" }, VAR, new Map())) === true);
  const endless = async () => ({ data: [{ id: 1, name: "city" }], meta: { last_page: 999 } });
  let tooMany = null;
  try { await installHasVariable(endless, { domain: "e.xxtest.example" }, VAR, new Map()); } catch (e) { tooMany = e; }
  check("installHasVariable: a list longer than any install's is refused, never read as complete", /more than 40 pages/.test(tooMany?.message ?? ""));

  // loadQuestionValues: one statement per variable, none without.
  const v1 = randomUUID(), v2 = randomUUID();
  const queries = [];
  const db = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (params[0] === v2) throw new Error("made-up failure");
      return { rows: params[1].map((l) => ({ lead_id: l, value: `value of ${l}` })) };
    },
  };
  const batchOf = new Map([
    ["b0", { client_tag: B }],
    ["b1", { question_variable_id: v1, question_variable_name: "xq4 one" }],
    ["b1b", { question_variable_id: v1, question_variable_name: "xq4 one" }],
    ["b2", { question_variable_id: v2, question_variable_name: "xq4 two" }],
    ["bg", { question_variable_id: null, question_variable_name: VAR_GONE }],
  ]);
  const none = await loadQuestionValues(db, [{ batch_id: "b0", lead_id: "x1" }, { batch_id: "bg", lead_id: "x2" }], batchOf);
  check("loadQuestionValues: no statement at all when no batch of the cycle names a variable it can send", none.size === 0 && queries.length === 0);
  const got = await loadQuestionValues(db, [
    { batch_id: "b0", lead_id: "x1" }, { batch_id: "b1", lead_id: "y1" }, { batch_id: "b1b", lead_id: "y2" }, { batch_id: "b1", lead_id: "y1" },
    { batch_id: "b2", lead_id: "z1" },
  ], batchOf);
  check("loadQuestionValues: one statement per variable, the cycle's leads of its batches only, each once",
    queries.length === 2 && queries.every((q) => q.sql === QUESTION_VALUES_SQL) && same(queries[0].params, [v1, ["y1", "y2"]]) && same(queries[1].params, [v2, ["z1"]]),
    JSON.stringify(queries.map((q) => q.params)));
  check("loadQuestionValues: values by lead; a failed read is kept as the error (its leads retry)",
    got.get(v1)?.get("y2") === "value of y2" && got.get(v2) instanceof Error && extraVarsFor({ id: "z1" }, got, batchOf.get("b2")).retry instanceof Error);
  check("the values statement reads only written ('done') values of one variable",
    /from lead_question_values\s+where variable_id = \$1 and lead_id = any\(\$2::uuid\[\]\) and status = 'done'/.test(QUESTION_VALUES_SQL));
}

// ── S. The popup's selection helper ─────────────────────────────────────────

async function partS() {
  section("S. src/lib/exports/push-selection.ts: the push body as it was");
  const { pushSelection } = await srcModule("lib/exports/push-selection.ts");
  // The body export-button.tsx built before this change (b2f6845), less the campaigns.
  const oldBody = ({ isSelected, selectedIds, filters, clientTag, includeAlreadyPushed, rangeFrom, rangeTo, force }) => ({
    selectedIds: isSelected ? selectedIds : undefined,
    filters: isSelected ? undefined : filters,
    ...(clientTag ? { clientTag, pushOptions: { includeAlreadyPushed } } : {}),
    force,
    ...(!isSelected && rangeFrom && rangeTo ? { rangeFrom, rangeTo } : !isSelected && rangeTo ? { maxLeads: rangeTo } : {}),
  });
  const newBody = (x) => ({
    ...pushSelection({ selectedIds: x.isSelected ? x.selectedIds : null, filters: x.filters, clientTag: x.clientTag, includeAlreadyPushed: x.includeAlreadyPushed, rangeFrom: x.rangeFrom, rangeTo: x.rangeTo }),
    force: x.force,
  });
  const filters = { tags: { include: ["XQ4B"], exclude: [] }, excludeIds: [randomUUID()] };
  const cases = [];
  for (const isSelected of [true, false])
    for (const clientTag of [null, B])
      for (const includeAlreadyPushed of [true, false])
        for (const [rangeFrom, rangeTo] of [[undefined, undefined], [1, 500], [undefined, 300], [20, undefined], [Number.NaN, 40]])
          for (const force of [false, true]) cases.push({ isSelected, selectedIds: [randomUUID(), randomUUID()], filters, clientTag, includeAlreadyPushed, rangeFrom, rangeTo, force });
  const diff = cases.filter((x) => canon(JSON.parse(JSON.stringify(oldBody(x)))) !== canon(JSON.parse(JSON.stringify(newBody(x)))));
  check(`pushSelection gives the body the popup always sent, in all ${cases.length} cases (selected or filtered, client or not, ranges, force)`,
    diff.length === 0, JSON.stringify(diff[0] ?? null));
  check("pushSelection: no filters and no rows sends neither key (as before)", same(pushSelection({ clientTag: null, includeAlreadyPushed: false }), {}));
  const eb = readFileSync(new URL("../src/components/exports/export-button.tsx", import.meta.url), "utf8");
  const cs = readFileSync(new URL("../src/components/exports/column-selector.tsx", import.meta.url), "utf8");
  check("export-button sends the body through pushSelection, and the variable only with the client",
    eb.includes("...pushSelection({") && /\.\.\.\(pushExtras\.clientTag && pushExtras\.questionVariableId\s*\? \{ questionVariableId: pushExtras\.questionVariableId \}/.test(eb) &&
      eb.includes("pushBase={{ selectedIds: exportType === \"selected\" && selectedIds.length > 0 ? selectedIds : null, filters }}"));
  check("the popup counts and writes for the same selection (pushSelection of the same base)",
    cs.includes("JSON.stringify(pushSelection({") && cs.includes("questionVariableId: questionSend ? questionChoice.variableId : null"));
}

// ── W. The push worker against a made-up Bison ──────────────────────────────

async function partW(ctx) {
  section("W. scripts/push-worker.mjs, once per install, against a made-up Bison");
  const others = await one(
    `SELECT count(*)::int AS n FROM push_batches WHERE client_tag IS DISTINCT FROM NULL AND client_tag NOT LIKE 'XQ4%'
        AND status IN ('pending', 'gathering', 'processing', 'scoring', 'cancelled')`
  );
  const othersUntagged = await one(`SELECT count(*)::int AS n FROM push_batches WHERE client_tag IS NULL AND status IN ('pending', 'gathering', 'processing', 'cancelled')`);
  const pushing = await one(`SELECT count(*)::int AS n FROM push_items i JOIN push_batches b ON b.id = i.batch_id WHERE i.status = 'pushing' AND coalesce(b.client_tag, '') NOT LIKE 'XQ4%'`);
  if (others.n + othersUntagged.n + pushing.n > 0) {
    check("no other push batch is active in the local database (the worker's housekeeping touches every batch)", false,
      `${others.n + othersUntagged.n} active batch(es), ${pushing.n} item(s) pushing: not running the worker`);
    return;
  }

  // The leads.
  const L = {};
  L.H = await lead("h", FULL("h")); // P1: new
  L.I = await lead("i", FULL("i")); // P1: on I1 already
  L.A = await lead("a", FULL("a")); // Q1: new, with a value
  L.Bx = await lead("bx", FULL("bx")); // Q1: on I1 without the variable
  L.C = await lead("c", FULL("c")); // Q1: no value
  L.D = await lead("d", FULL("d")); // Q1: on I1 holding the same value
  L.Dv = await lead("dv", FULL("dv")); // Q1: on I1 holding an older value
  L.E = await lead("e", FULL("e")); // Q1: "taken" on create
  L.F = await lead("f", FULL("f")); // Q1: its value is an error
  L.G = await lead("g", FULL("g")); // Q1: written from an older prompt
  L.Gn = await lead("gn", FULL("gn")); // a batch whose variable was deleted
  L.Lx = await lead("l", FULL("l")); // Q2 (I2 lacks the variable): new
  L.M = await lead("m", FULL("m")); // Q2: on I2 already
  L.N = await lead("n", FULL("n")); // Q2: no value
  L.K = await lead("k", FULL("k")); // P3 (I3 lacks "company phone"): new
  L.O = await lead("o", { ...FULL("o"), company_phone: null }); // Q3 (I3 refuses the variable on create)

  const qv = { id: ctx.varId, name: VAR };
  const vals = { A: "made-up question a?", Bx: "made-up question bx?", D: "made-up question d?", Dv: "made-up question dv?", E: "made-up question e?",
    G: "made-up question g?", Lx: "made-up question l?", M: "made-up question m?", O: "made-up question o?" };
  for (const [k, v] of Object.entries(vals)) await value(ctx.varId, L[k].id, v, k === "G" ? { promptVersion: 1 } : { promptVersion: 2 });
  await value(ctx.varId, L.F.id, null, { status: "error", promptVersion: 2 });

  // Every lead passes the clients' push-time conditions, so what the worker records is about the variable only.
  const elig = async (tag, ids) => {
    const conds = (await one(`SELECT fn_client_eligibility_conditions($1) AS c`, [tag])).c ?? [];
    return (await all(`SELECT l.id FROM leads l WHERE l.id = ANY($1::uuid[])${conds.length ? ` AND ${conds.join(" AND ")}` : ""}`, [ids])).length;
  };
  const ids = Object.values(L).map((l) => l.id);
  check("(the made-up leads pass the made-up clients' push-time conditions)", (await elig(A, ids)) === ids.length && (await elig(B, ids)) === ids.length);

  const wrong = { [VAR]: "made-up question that does not hold?" };
  writeFileSync(PLAN_FILE, JSON.stringify({
    installs: {
      [I1]: {
        firstId: 8001, vars: [...ELEVEN, "unique service question", VAR],
        existing: [
          { id: 7101, email: L.I.email, status: "active", lead_campaign_data: [], custom_variables: [] },
          { id: 7201, email: L.Bx.email, status: "active", lead_campaign_data: [], custom_variables: [{ name: "city", value: "Phoenix" }] },
          { id: 7202, email: L.D.email, status: "active", lead_campaign_data: [], custom_variables: [{ name: "XQ4A-OS Question", value: vals.D }] },
          { id: 7204, email: L.Dv.email, status: "active", lead_campaign_data: [], custom_variables: [{ name: VAR, value: wrong[VAR] }] },
          { id: 7203, email: L.E.email, status: "active", lead_campaign_data: [], custom_variables: [{ name: VAR, value: vals.E }] },
        ],
        missFirstLookup: [L.E.email],
        taken: [L.E.email],
      },
      [I2]: { firstId: 9001, vars: [...ELEVEN], existing: [{ id: 9501, email: L.M.email, status: "active", lead_campaign_data: [], custom_variables: [] }] },
      [I3]: { firstId: 9801, vars: [...ELEVEN.filter((n) => n !== "company phone"), VAR], refuseOnCreate: [VAR], quote: [VAR], existing: [] },
    },
  }));

  // ── W1: a batch without a variable (I1) ──
  const P1 = await batch(B, I1, [L.H.id, L.I.id]);
  const r1 = await drain(I1, "w1");
  check("the worker ran on I1 and exited cleanly (no variable)", r1.status === 0, r1.out.slice(-800));
  const log1 = readLog().filter((e) => e.step === "w1");
  const it1 = await itemsOf(P1);
  check("W1. both leads sent", it1[L.H.id]?.status === "sent" && it1[L.I.id]?.status === "sent", JSON.stringify(it1));
  const fixedOf = (l) => [
    ["person linkedin url", l.person_linkedin], ["category", l.category], ["sub-category", l.subcategory], ["additional category", l.additional_category],
    ["city", l.city], ["state", l.state], ["domain", l.domain], ["address", l.address], ["question", l.question],
    ["company phone", l.company_phone], ["google maps url", l.google_maps_url],
  ].filter(([, v]) => v != null && v !== "").map(([name, v]) => ({ name, value: String(v) }));
  // The payload the worker built before 139 (leadPayload at b2f6845), key for key.
  const oldPayload = (l, tag) => ({
    first_name: l.first_name ?? "", last_name: l.last_name ?? "", email: l.email,
    ...(l.title ? { title: l.title } : {}), ...(l.company ? { company: l.company } : {}), ...(l.notes ? { notes: l.notes } : {}),
    custom_variables: fixedOf(l),
    tags: [tag, ...String(l.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean)],
  });
  const createH = log1.filter((e) => e.method === "POST" && e.path === "/api/leads" && e.body?.email === L.H.email);
  check("W1. a new lead is created with exactly the old payload (byte for byte)",
    createH.length === 1 && JSON.stringify(createH[0].body) === JSON.stringify(oldPayload(L.H, B)), JSON.stringify(createH[0]?.body));
  check("W1. no custom-variables read, no PATCH, no PUT for a batch without a variable",
    !log1.some((e) => e.path === "/api/custom-variables" || e.method === "PATCH" || e.method === "PUT"), JSON.stringify(log1.map((e) => `${e.method} ${e.path}`)));
  check("W1. the existing lead is found and attached, not written to",
    log1.some((e) => e.method === "GET" && e.path === `/api/leads/${encodeURIComponent(L.I.email)}` && e.status === 200) &&
      log1.some((e) => e.path === "/api/campaigns/901/leads/attach-leads" && e.body.lead_ids.includes("7101")));
  check("W1. every call carried its install's own made-up key", log1.every((e) => e.auth === `Bearer ${KEYS[e.host]}`));
  check("W1. the batch completed", (await one(`SELECT status FROM push_batches WHERE id = $1`, [P1]))?.status === "complete");

  // ── W2: a batch with the variable (I1), and one whose variable was deleted ──
  const Q1 = await batch(A, I1, [L.A.id, L.Bx.id, L.C.id, L.D.id, L.Dv.id, L.E.id, L.F.id, L.G.id], qv);
  const QG = await batch(A, I1, [L.Gn.id], { id: null, name: VAR_GONE });
  const r2 = await drain(I1, "w2");
  check("the worker ran on I1 and exited cleanly (with a variable)", r2.status === 0, r2.out.slice(-800));
  const log2 = readLog().filter((e) => e.step === "w2");
  const it2 = await itemsOf(Q1);
  const st = (k) => it2[L[k].id]?.status;
  check("W2. leads with a value are sent", ["A", "Bx", "D", "Dv", "E", "G"].every((k) => st(k) === "sent"), JSON.stringify(it2));
  check("W2. leads without a value (none, or an error) are skipped with \"no {X} written yet\", not failed",
    ["C", "F"].every((k) => st(k) === "skipped" && it2[L[k].id].error === `no ${VAR_TAG} written yet`), JSON.stringify([it2[L.C.id], it2[L.F.id]]));
  const mentions = (l) => log2.some((e) => names(e, l));
  check("W2. ... and Bison is never called for them", !mentions(L.C) && !mentions(L.F));
  const createA = log2.filter((e) => e.method === "POST" && e.path === "/api/leads" && e.body?.email === L.A.email);
  const cvA = createA[0]?.body?.custom_variables ?? [];
  check("W2. a new lead is created with the variable after the eleven, which are unchanged (the default question too)",
    createA.length === 1 && same(cvA.slice(0, 11), fixedOf(L.A)) && same(cvA[11], { name: VAR, value: vals.A }) && cvA.length === 12 &&
      cvA.find((v) => v.name === "question")?.value === L.A.question, JSON.stringify(cvA));
  check("W2. ... and the rest of its payload is the old one",
    same(without(createA[0]?.body, "custom_variables"), without(oldPayload(L.A, A), "custom_variables")));
  const patches = log2.filter((e) => e.method === "PATCH");
  const patchOf = (id) => patches.filter((e) => e.path === `/api/leads/${id}`);
  check("W2. a lead the install holds without the variable gets one PATCH with only that variable",
    patchOf(7201).length === 1 && same(patchOf(7201)[0].body, { custom_variables: [{ name: VAR, value: vals.Bx }] }), JSON.stringify(patches));
  const attachIdx = (id) => log2.findIndex((e) => e.path === "/api/campaigns/901/leads/attach-leads" && e.body.lead_ids.includes(String(id)));
  check("W2. ... before it is attached", attachIdx(7201) > log2.indexOf(patchOf(7201)[0]) && log2.indexOf(patchOf(7201)[0]) >= 0);
  check("W2. a lead already holding the same value is not written to; one holding an older value is PATCHed",
    patchOf(7202).length === 0 && patchOf(7204).length === 1 && same(patchOf(7204)[0].body, { custom_variables: [{ name: VAR, value: vals.Dv }] }) && attachIdx(7202) >= 0);
  const eSeq = log2.filter((e) => e.path !== "/api/campaigns/901/leads/attach-leads" && (names(e, L.E) || e.path === "/api/leads/7203"));
  const eKinds = eSeq.map((e) => `${e.method} ${e.path === "/api/leads/7203" ? "id" : e.path.startsWith("/api/leads/") ? "email" : e.path} ${e.status}`);
  check("W2. a \"taken\" create: lookup, create refused, lookup, PUT (the eleven only), then PATCH of the variable",
    same(eKinds, ["GET email 404", "POST /api/leads 422", "GET email 200", "PUT id 200", "PATCH id 200"]), JSON.stringify(eKinds));
  const putE = eSeq.find((e) => e.method === "PUT");
  check("W2. ... the PUT is the old payload (never carries the variable)", same(putE?.body, oldPayload(L.E, A)), JSON.stringify(putE?.body));
  check("W2. ... and it is attached after the PATCH", attachIdx(7203) > log2.findIndex((e) => e.method === "PATCH" && e.path === "/api/leads/7203"));
  check("W2. a value written from an older prompt is still sent (status done)", st("G") === "sent" &&
    log2.some((e) => e.method === "POST" && e.body?.email === L.G.email && e.body.custom_variables.at(-1)?.value === vals.G));
  check("W2. the install's variables were read once for the whole batch (cached)",
    log2.filter((e) => e.path === "/api/custom-variables").length === 1, String(log2.filter((e) => e.path === "/api/custom-variables").length));
  check("W2. no other PATCH or PUT", patches.length === 3 && log2.filter((e) => e.method === "PUT").length === 1);
  const itG = await itemsOf(QG);
  check("W2. a batch whose variable was deleted skips its leads with that reason, and calls Bison for none",
    itG[L.Gn.id]?.status === "skipped" && itG[L.Gn.id].error === "{XQ4 GONE QUESTION} no longer exists (deleted after this push was queued)" &&
      !readLog().some((e) => names(e, L.Gn)),
    JSON.stringify(itG));
  const bs2 = await all(`SELECT status, sent, skipped, failed FROM push_batches WHERE id = ANY($1::uuid[]) ORDER BY created_at`, [[Q1, QG]]);
  check("W2. both batches completed, with the skipped leads counted as skipped",
    bs2[0]?.status === "complete" && bs2[0].sent === 6 && bs2[0].skipped === 2 && bs2[0].failed === 0 && bs2[1]?.status === "complete" && bs2[1].skipped === 1,
    JSON.stringify(bs2));

  // ── W3: an install that lacks the variable (I2) ──
  const Q2 = await batch(A, I2, [L.Lx.id, L.M.id, L.N.id], qv);
  const r3 = await drain(I2, "w3");
  check("the worker ran on I2 and exited cleanly", r3.status === 0, r3.out.slice(-800));
  const log3 = readLog().filter((e) => e.step === "w3");
  const it3 = await itemsOf(Q2);
  const reason = `${VAR_TAG} isn't set up on ${I2}: create it on the Clay tab`;
  check("W3. leads with a value fail with the Clay-tab reason, at once (no retry)",
    [L.Lx, L.M].every((l) => it3[l.id]?.status === "failed" && it3[l.id].error === reason), JSON.stringify(it3));
  check("W3. ... the lead without a value is still skipped as such", it3[L.N.id]?.status === "skipped" && it3[L.N.id].error === `no ${VAR_TAG} written yet`);
  check("W3. ... after one read of the install's variables, and no lookup, create, PATCH or attach there",
    log3.length === 1 && log3[0].method === "GET" && log3[0].path === "/api/custom-variables", JSON.stringify(log3.map((e) => `${e.method} ${e.path}`)));
  const attempts3 = await all(`SELECT attempts FROM push_items WHERE batch_id = $1 AND status = 'failed'`, [Q2]);
  check("W3. ... each failed on its first attempt", attempts3.length === 2 && attempts3.every((r) => r.attempts === 1));

  // ── W4: a missing multi-word fixed name is learned; a refused question variable is not (I3) ──
  const P3 = await batch(B, I3, [L.K.id]);
  const r4 = await drain(I3, "w4");
  const Q3 = await batch(A, I3, [L.O.id], qv);
  const r5 = await drain(I3, "w5");
  check("the worker ran on I3 twice and exited cleanly", r4.status === 0 && r5.status === 0, (r4.out + r5.out).slice(-800));
  const log4 = readLog().filter((e) => e.step === "w4");
  const postsK = log4.filter((e) => e.method === "POST" && e.path === "/api/leads");
  check("W4. \"company phone\" missing on the install: learned whole and dropped, and the lead is sent",
    postsK.length === 2 && postsK[0].status === 422 && postsK[0].body.custom_variables.some((v) => v.name === "company phone") &&
      postsK[1].status === 200 && !postsK[1].body.custom_variables.some((v) => v.name === "company phone") &&
      same(postsK[1].body.custom_variables, fixedOf(L.K).filter((v) => v.name !== "company phone")) &&
      (await itemsOf(P3))[L.K.id]?.status === "sent", JSON.stringify(postsK.map((e) => [e.status, e.body.custom_variables.map((v) => v.name)])));
  check("W4. ... (the worker said so)", /has no custom variable "company phone"/.test(r4.out));
  const log5 = readLog().filter((e) => e.step === "w5");
  const postsO = log5.filter((e) => e.method === "POST" && e.path === "/api/leads");
  const it5 = await itemsOf(Q3);
  check("W4. the question variable refused on create fails the lead with the Clay-tab reason after ONE create (never dropped)",
    postsO.length === 1 && postsO[0].status === 422 && postsO[0].body.custom_variables.at(-1)?.name === VAR &&
      it5[L.O.id]?.status === "failed" && it5[L.O.id].error === `${VAR_TAG} isn't set up on ${I3}: create it on the Clay tab`,
    JSON.stringify({ posts: postsO.map((e) => e.status), item: it5[L.O.id] }));

  const refused = readLog().filter((e) => e.status === "refused");
  check("W. the worker reached nothing but the made-up installs", refused.length === 0, JSON.stringify(refused.slice(0, 3)));
  ctx.batches = { P1, Q1, QG, Q2, P3, Q3 };
}

// ── R. POST /api/bison/push-batch ───────────────────────────────────────────

async function partR(ctx) {
  section("R. POST /api/bison/push-batch: the question variable");
  const r = await route("bison/push-batch");
  const leadIds = (await all(`SELECT id FROM leads WHERE email LIKE 'xq4-%@${HOST}' ORDER BY email LIMIT 2`)).map((x) => x.id);
  const body = (extra = {}) => ({ campaigns: [{ id: 901, name: `${A}: Made-up main`, instance_url: I1 }], selectedIds: leadIds, ...extra });
  const batches = async () => (await one(`SELECT count(*)::int AS n FROM push_batches WHERE client_tag LIKE 'XQ4%'`)).n;
  const n0 = await batches();
  T.role = "manager";

  await setSwitch({ enabled: true, tags: [A] });
  const r1 = await call(r.POST, { body: body({ questionVariableId: ctx.varId }) });
  check("questionVariableId without clientTag: 400, nothing queued", r1.status === 400 && /only sent with a client/.test(r1.body.error) && (await batches()) === n0, JSON.stringify(r1.body));
  const r2 = await call(r.POST, { body: body({ clientTag: A, questionVariableId: "not-an-id", force: true }) });
  check("questionVariableId that is not an id: 400", r2.status === 400 && /questionVariableId/.test(r2.body.error));

  await setSwitch({ enabled: false, tags: [A] });
  const r3 = await call(r.POST, { body: body({ clientTag: A, questionVariableId: ctx.varId, force: true }) });
  check("the switch off: 400 in plain words, nothing queued", r3.status === 400 && r3.body.error.startsWith(`Question variables are off for ${A}`) && (await batches()) === n0,
    JSON.stringify(r3.body));
  await setSwitch({ enabled: true, tags: [B] });
  const r4 = await call(r.POST, { body: body({ clientTag: A, questionVariableId: ctx.varId, force: true }) });
  check("the switch on but the client not listed: 400 (the switch is per client)", r4.status === 400 && /off for XQ4A-OS/.test(r4.body.error));

  await setSwitch({ enabled: true, tags: [A, C] });
  const r5 = await call(r.POST, { body: body({ clientTag: A, questionVariableId: randomUUID(), force: true }) });
  check("an unknown variable: 400", r5.status === 400 && /no longer exists/.test(r5.body.error));
  const r6 = await call(r.POST, { body: body({ clientTag: C, questionVariableId: ctx.archId, force: true }) });
  check("an archived variable: 400 naming it as copy writes it", r6.status === 400 && r6.body.error.startsWith("{XQ4C-OS OLD QUESTION} is archived"), JSON.stringify(r6.body));
  check("... and nothing was queued by any refusal", (await batches()) === n0);

  T.adminAudits.length = 0;
  T.adminOps.length = 0;
  const r7 = await call(r.POST, { body: body({ clientTag: A, questionVariableId: ctx.varId, force: true }) });
  const s7 = r7.body?.batchId ? await one(`SELECT question_variable_id, question_variable_name, client_tag, status FROM push_batches WHERE id = $1`, [r7.body.batchId]) : null;
  check("on: queued, with the variable's id and stored name on the batch", r7.status === 200 && s7?.question_variable_id === ctx.varId && s7.question_variable_name === VAR && s7.client_tag === A,
    JSON.stringify([r7.body, s7]));
  check("... the answer names it", same(r7.body.questionVariable, { id: ctx.varId, name: VAR }));
  const audit7 = T.adminAudits.at(-1);
  check("... the audit metadata carries its name and no value", audit7?.metadata?.questionVariable === VAR && !JSON.stringify(audit7).includes("made-up question"));

  T.adminAudits.length = 0;
  T.adminOps.length = 0;
  const r8 = await call(r.POST, { body: body({ clientTag: B, force: true }) });
  const s8 = r8.body?.batchId ? await one(`SELECT question_variable_id, question_variable_name FROM push_batches WHERE id = $1`, [r8.body.batchId]) : null;
  const insert8 = T.adminOps.find((o) => o.table === "push_batches" && o.action === "insert");
  check("a push without one is as before: no columns set, no key in the insert, the answer or the audit",
    r8.status === 200 && s8?.question_variable_id === null && s8.question_variable_name === null && insert8 &&
      !Object.keys(insert8.payload).some((k) => k.startsWith("question")) && !("questionVariable" in r8.body) && !("questionVariable" in (T.adminAudits.at(-1)?.metadata ?? {})),
    JSON.stringify([r8.body, Object.keys(insert8?.payload ?? {})]));
  const r9 = await call(r.POST, { body: body({ clientTag: B, questionVariableId: null, force: true }) });
  const s9 = r9.body?.batchId ? await one(`SELECT question_variable_id FROM push_batches WHERE id = $1`, [r9.body.batchId]) : null;
  check("questionVariableId null counts as none (switch off for the client does not matter then)", r9.status === 200 && s9?.question_variable_id === null);

  T.role = "viewer";
  const r10 = await call(r.POST, { body: body({ clientTag: A, questionVariableId: ctx.varId, force: true }) });
  T.role = "manager";
  check("a viewer still cannot push (403)", r10.status === 403);

  const src = readFileSync(new URL("../src/app/api/bison/push-batch/route.ts", import.meta.url), "utf8");
  check("the route's existing pieces are where test-share-push reads them",
    src.includes("stampCampaigns(campaigns, tagRow)") && src.includes("idsOfSide(getPool(), selectedIds!, emailSide)") && !src.includes("suggestBucketFromName"));
  await setSwitch({});
}

// ── L. GET /api/bison/push-batches ──────────────────────────────────────────

async function partL(ctx) {
  section("L. GET /api/bison/push-batches: the variable beside the client");
  const r = await route("bison/push-batches");
  T.role = "viewer";
  T.missingColumns = [];
  const l1 = await call(r.GET, { query: { limit: "50" } });
  const byId = new Map((l1.body?.batches ?? []).map((b) => [b.id, b]));
  check("each batch carries question_variable_name: the name for one with a variable, null otherwise",
    l1.status === 200 && byId.get(ctx.batches.Q1)?.question_variable_name === VAR && byId.get(ctx.batches.P1)?.question_variable_name === null &&
      byId.get(ctx.batches.QG)?.question_variable_name === VAR_GONE, JSON.stringify(l1.body).slice(0, 400));
  T.missingColumns = ["question_variable_name"];
  const l2 = await call(r.GET, { query: { limit: "50" } });
  check("before 139: read without it (200, no such key)", l2.status === 200 && l2.body.batches.length === l1.body.batches.length &&
    l2.body.batches.every((b) => !("question_variable_name" in b) && "fit_total" in b));
  T.missingColumns = ["question_variable_name", "fit_total"];
  const l3 = await call(r.GET, { query: { limit: "50" } });
  check("before 127 too: the base columns (200)", l3.status === 200 && l3.body.batches.every((b) => !("fit_total" in b) && "client_tag" in b));
  T.missingColumns = [];
  T.role = null;
  check("no session: 401", (await call(r.GET, {})).status === 401);
  T.role = "manager";
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  const reg = await one(`SELECT to_regclass('public.lead_question_values') AS t, (SELECT value FROM enrich_settings WHERE key = 'question_variables') AS v`);
  if (!reg?.t || !reg.v) {
    console.error("Refusing to run: migration 139 is not in the local database.");
    process.exit(1);
  }
  const clash = await all(`SELECT tag FROM client_tags WHERE tag LIKE 'XQ4%' AND (name IS NULL OR name NOT LIKE 'Made-up xq4%')`);
  if (clash.length) {
    console.error(`Refusing to run: ${clash.length} client tag(s) starting XQ4 are not this test's.`);
    process.exit(1);
  }
  // The setting as it was, without this test's clients if a cut-off run left them.
  const v = reg.v;
  settingsBefore = { ...v, tags: (Array.isArray(v.tags) ? v.tags : []).filter((t) => !TAGS.includes(t)) };
  let cleaned = false;
  const ctx = {};
  try {
    await cleanup();
    await setSwitch({});
    await client(A, "OS", I1);
    await client(B, "Cleaning", I1);
    await client(C, "OS", I1);
    ctx.varId = await variable(VAR, A, { promptVersion: 2 });
    ctx.archId = await variable(VAR_ARCH, C, { archived: true });
    await partP();
    await partS();
    await partW(ctx);
    await partR(ctx);
    if (ctx.batches) await partL(ctx);
  } catch (e) {
    check("the run finished without an exception", false, e?.stack ?? String(e));
  } finally {
    try {
      await cleanup();
      await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'question_variables'`, [JSON.stringify(settingsBefore)]);
      const left = await one(
        `SELECT (SELECT count(*) FROM client_tags WHERE tag LIKE 'XQ4%')::int AS tags,
                (SELECT count(*) FROM leads WHERE email LIKE $1)::int AS leads,
                (SELECT count(*) FROM question_variables WHERE name LIKE 'xq4%')::int AS vars,
                (SELECT count(*) FROM push_batches WHERE client_tag LIKE 'XQ4%')::int AS batches,
                (SELECT value FROM enrich_settings WHERE key = 'question_variables') AS setting`,
        [`xq4-%@${HOST}`]
      );
      cleaned = left.tags === 0 && left.leads === 0 && left.vars === 0 && left.batches === 0 && same(left.setting, settingsBefore);
      section("N. Nothing reached the network, everything removed");
      check("the test process made no network call", parentRefused === 0, String(parentRefused));
      check("everything this test made is removed and the switch is as it was", cleaned, JSON.stringify(left));
    } catch (e) {
      console.error("cleanup failed:", e?.message ?? e);
    }
    for (const f of [PLAN_FILE, LOG_FILE]) rmSync(f, { force: true });
    for (const p of globalThis.__pqPools) await p.end().catch(() => {});
    await pool.end().catch(() => {});
  }
  console.log(`\ncleaned up: ${cleaned ? "yes" : "NO"}`);
  console.log(`${counts.passed} passed, ${counts.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(counts.failed === 0 && cleaned ? 0 : 1);
}

await main();
