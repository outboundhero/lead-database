#!/usr/bin/env node
// Checks for the per-client inbound URLs (migration 129): the receiving route
// POST /api/enrich/intake/<token>, the Clay tab's management route
// /api/enrich/inbound, the Run route with held rows, the table route's Maps
// deliveries and the settings route's daily caps of the email finders and
// Enrichley. LOCAL DATABASE ONLY: it makes made-up clients (IBTEST_A,
// IBTEST_B, IBTEST_C) with the made-up Clay originals as their own variants,
// their URLs, pipeline tables and held rows (made-up places on
// .ibtest.example sites), and removes all of it at the end. The settings it
// changes are put back.
//
//   node --env-file=.env.local scripts/test-inbound.mjs
//
// Stop the enrichment worker first: it refuses to run while a worker's
// heartbeat is fresh. Migration 129 must be in the local database. Nothing
// here reaches a network: fetch is replaced and refuses every address, and
// no paid key is read. The routes run for real through the TypeScript loader
// (scripts/fixtures/test-support.mjs), with stand-ins only for the session,
// the audit log and the worker's heartbeat. About 25 s: one check waits out
// the intake's 15 s statement timeout.
//
//   T1. URLs: create (and the client's tables), one live URL per client,
//       reveal, the site address, rotate, revoke, accepted names, roles, the
//       list, the audit lines
//   T2. the URL table is server-only
//   T3. the receiving route's answers: tokens, sizes, not a chunk, the Test,
//       a chunk stored held (keys, cells, offices, source, meta), a delivery
//       seen before, chunk ids, blank search fields, places with no id, odd
//       text, no "full" phrase, name or token in any answer, never 410
//   T4. the client name check, Accept this name, and a table that can't be made
//   T6. load and errors: ten at once, the slots, a lock held past the
//       statement timeout, an unexpected error, a passing one
//   R.  the Run route leaves held rows held and counts them; the table
//       route's held count and Maps deliveries
//   S.  the settings route: the vendor caps (admin only), and a client
//       switched on

import pg from "pg";
import { randomUUID } from "node:crypto";
import { checker, dropPaidKeys, installNet, localDatabaseUrl, routeLoader, seedFixtureVariant } from "./fixtures/test-support.mjs";
import { placeInputs } from "./lib/enrich/maps-place.mjs";
import { settingsFrom, VENDOR_CAP_KEYS, VENDOR_CAP_LABELS } from "./lib/enrich/settings.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const RUN = randomUUID().slice(0, 6);
const TAGS = ["IBTEST_A", "IBTEST_B", "IBTEST_C"];
const [A, B, C] = TAGS;
const VARIANTS = TAGS.map((t) => t.toLowerCase());
const SITE = "https://leads.ibtest.example";
const INTAKE = `${SITE}/api/enrich/intake/`;
const SETTING_KEYS = ["company_pipeline", "people_pipeline", "personalisation", "spend_caps", "models", "linkedin_sources"];
process.env.NEXT_PUBLIC_SITE_URL = SITE;

const pool = new pg.Pool({ connectionString: url, max: 4 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => n.toLocaleString("en-US");
const norm = (v) =>
  Array.isArray(v) ? v.map(norm) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])])) : v;
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

// ── Made-up places and chunks ───────────────────────────────────────────────

const placeId = (n) => `ibtest-place-${RUN}-${n}`;
/** A made-up DataForSEO maps_search item, with the fields the docs give it. */
const place = (n, over = {}) => ({
  type: "maps_search",
  title: `Inbound Test Dental ${n}`,
  place_id: placeId(n),
  cid: String(n),
  url: `https://www.dental${n}.ibtest.example/`,
  domain: `dental${n}.ibtest.example`,
  phone: "+1 217-555-0100",
  category: "Dentist",
  category_ids: ["dentist"],
  additional_categories: ["Cosmetic dentist"],
  address: `${n} Main Street, Springfield, IL 62701`,
  address_info: { borough: null, address: `${n} Main Street`, city: "Springfield", zip: "62701", region: "Illinois", country_code: "US" },
  rating: { value: 4.5, votes_count: 10 },
  ...over,
});
const EXTRA = { keyword: "dentist", city: "Springfield", state: "IL", category: "dentist", scrape_queue_id: "ibtest-queue-1" };
let seq = 0;
/** A chunk as the scraper app sends it: taskId rewritten to <task>-<chunk>, with originalTaskId, unless rewrite is false. */
function chunk(items, { client = A, extra, task = `ibtest-task-${RUN}-${++seq}`, index = 1, total = 1, rewrite = true } = {}) {
  return {
    taskId: rewrite ? `${task}-${index}` : task,
    ...(rewrite ? { originalTaskId: task } : {}),
    chunkIndex: index,
    totalChunks: total,
    totalItems: items.length,
    extra: extra === undefined ? { client, ...EXTRA } : extra,
    postbackData: { tasks: [{ id: `${task}-provider`, status_code: 20000, result: [{ items }] }] },
  };
}
const testCall = (more = {}) => ({ test: true, source: "gmaps-scraper", timestamp: new Date().toISOString(), ...more });

// ── The routes ──────────────────────────────────────────────────────────────

const loader = routeLoader(randomUUID());
const { T, route, srcModule, call, heartbeat } = loader;
let R = null; // the route modules and the shared ones, loaded once the database is checked
/** Every intake answer, with the client name its chunk carried, for the checks over all of them. */
const answers = [];

async function post(token, body, headers) {
  const r = await call(R.intake.POST, { body, params: { token }, headers });
  const sent = body && typeof body === "object" ? body.extra?.client ?? body.client ?? null : null;
  answers.push({ status: r.status, text: JSON.stringify(r.body ?? null), sent: typeof sent === "string" ? sent : null });
  return r;
}
const manage = (body) => call(R.inbound.POST, { body });
const tokenOf = (full) => String(full ?? "").slice(INTAKE.length);
const urlRow = (tag) => one(`SELECT * FROM enrich_inbound_urls WHERE client_tag = $1 AND revoked_at IS NULL`, [tag]);
const tableOf = (tag) => one(`SELECT id FROM enrich_tables WHERE client_tag = $1 AND kind = 'companies' AND template = 'companies_v2'`, [tag]);
const inputKeys = async (tableId) => (await all(`SELECT key FROM enrich_columns WHERE table_id = $1 AND kind = 'input'`, [tableId])).map((r) => r.key);
const rowsIn = async (tableId) => (await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = $1`, [tableId])).n;
const heldIn = async (tableId) => (await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = $1 AND run_status = 'held'`, [tableId])).n;
const placeRow = (tableId, n) => one(`SELECT * FROM enrich_rows WHERE table_id = $1 AND row_key = $2`, [tableId, `maps:${placeId(n)}`]);
const sourceOf = (tableId, externalId) => one(`SELECT * FROM enrich_sources WHERE table_id = $1 AND kind = 'maps' AND external_id = $2`, [tableId, externalId]);
const cellsOf = async (rowId) =>
  Object.fromEntries((await all(`SELECT column_key, value, status FROM enrich_cells WHERE row_id = $1`, [rowId])).map((c) => [c.column_key, c]));

// ── Setup and cleanup ───────────────────────────────────────────────────────

let settingsBefore = null;

async function cleanup() {
  const tables = (await all(`SELECT id FROM enrich_tables WHERE client_tag = ANY($1::text[])`, [TAGS])).map((r) => r.id);
  await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
  await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tables]).catch(() => {});
  await pool.query(`DELETE FROM enrich_inbound_urls WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM enrich_originals WHERE variant = ANY($1::text[])`, [VARIANTS]);
  await pool.query(`DELETE FROM client_targeting WHERE client_tag = ANY($1::text[])`, [TAGS]);
  await pool.query(`DELETE FROM client_tags WHERE tag = ANY($1::text[])`, [TAGS]);
  if (settingsBefore) {
    for (const key of SETTING_KEYS) {
      const was = settingsBefore.find((r) => r.key === key);
      if (was) await pool.query(`UPDATE enrich_settings SET value = $2 WHERE key = $1`, [key, JSON.stringify(was.value)]);
      else await pool.query(`DELETE FROM enrich_settings WHERE key = $1`, [key]);
    }
  }
}

async function addClients() {
  await pool.query(
    `INSERT INTO client_tags (tag, name, status) VALUES ($1, 'Inbound test A', 'Active'), ($2, 'Inbound test B', 'Active'), ($3, 'Inbound test C', 'Paused')`,
    TAGS
  );
  // A and C have targeting rules; B has none.
  for (const t of [A, C]) {
    await pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, updated_at)
       VALUES ($1, '{US}', $2, '[]', '{}', false, now())`,
      [t, JSON.stringify([{ city: "Springfield", state: "IL", country: "US" }])]
    );
  }
  for (const t of TAGS) await seedFixtureVariant(pool, t); // the made-up Clay originals, as each client's own variant
}

// ── T2. Server-only ─────────────────────────────────────────────────────────

async function partT2() {
  section("T2. The URL table is server-only");
  const rls = await one(`SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'public.enrich_inbound_urls'::regclass`);
  const p = await one(
    `SELECT has_table_privilege('anon', 'public.enrich_inbound_urls', 'SELECT,INSERT,UPDATE,DELETE') AS anon,
            has_table_privilege('authenticated', 'public.enrich_inbound_urls', 'SELECT,INSERT,UPDATE,DELETE') AS auth,
            has_function_privilege('anon', 'public.fn_enrich_company_switch_on(text)', 'EXECUTE') AS fn_anon,
            has_function_privilege('authenticated', 'public.fn_enrich_company_switch_on(text)', 'EXECUTE') AS fn_auth`
  );
  check("RLS is on, and anon and authenticated hold no right on the table or the switch check",
    rls?.on === true && !p.anon && !p.auth && !p.fn_anon && !p.fn_auth, JSON.stringify({ rls, p }));
  for (const role of ["anon", "authenticated"]) {
    const c = await pool.connect();
    let code = null;
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${role}`);
      await c.query(`SELECT count(*) FROM enrich_inbound_urls`);
    } catch (e) {
      code = e.code;
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
    check(`... and an ${role} session reading it is refused (42501)`, code === "42501", String(code));
  }
}

// ── T1. URLs ────────────────────────────────────────────────────────────────

const tok = {}; // the live token of each client, as the tests know it
const retiredTokens = []; // tokens rotated or revoked during the run

async function partT1() {
  section("T1. URLs: create, one live URL per client, reveal, rotate, revoke, names, roles, the list, the audit lines");
  T.role = "manager";
  T.audits.length = 0;

  const madeA = await manage({ action: "create", tag: A });
  tok[A] = tokenOf(madeA.body?.url);
  check("create: 201 with the full URL, the site address, the path and a 43-character URL-safe token made on the server",
    madeA.status === 201 && madeA.body.url === `${INTAKE}${tok[A]}` && /^[A-Za-z0-9_-]{43}$/.test(tok[A]) && madeA.body.masked === `${INTAKE}${tok[A].slice(0, 6)}…`,
    JSON.stringify(madeA.body));
  const storedA = await urlRow(A);
  check("... stored once, live, for the Companies target, by the manager, with no accepted name",
    storedA?.token === tok[A] && storedA.target === "companies" && storedA.created_by === T.userId && storedA.accepted_names.length === 0 && storedA.last_used_at === null);
  const tablesA = await all(`SELECT id, template, row_count FROM enrich_tables WHERE client_tag = $1 ORDER BY template`, [A]);
  const tA = await tableOf(A);
  check("... and the client's three pipeline tables, empty, the Companies one with the place id input",
    same(tablesA.map((t) => t.template), ["companies_v2", "inboxes_v1", "people_v1"]) && tablesA.every((t) => t.row_count === 0) &&
      madeA.body.table_id === tA?.id && (await inputKeys(tA.id)).includes("place_id"),
    JSON.stringify(tablesA));
  check("... with no warning: the client has targeting rules", madeA.body.warning === null);

  const twice = await manage({ action: "create", tag: A });
  check("a second create: 409, still one live URL",
    twice.status === 409 && (await one(`SELECT count(*)::int AS n FROM enrich_inbound_urls WHERE client_tag = $1 AND revoked_at IS NULL`, [A])).n === 1,
    JSON.stringify(twice.body));

  const madeB = await manage({ action: "create", tag: B });
  tok[B] = tokenOf(madeB.body?.url);
  check("create for a client with no targeting rules: made, with a warning that its places stop at the area check",
    madeB.status === 201 && /no targeting rules/.test(madeB.body.warning ?? ""), JSON.stringify(madeB.body));

  const unknown = await manage({ action: "create", tag: "IBTEST_ZZ" });
  check("create for a tag not in the client list: 404, nothing made",
    unknown.status === 404 && (await one(`SELECT count(*)::int AS n FROM enrich_tables WHERE client_tag = 'IBTEST_ZZ'`)).n === 0 &&
      (await one(`SELECT count(*)::int AS n FROM enrich_inbound_urls WHERE client_tag = 'IBTEST_ZZ'`)).n === 0);
  const badTag = await manage({ action: "create", tag: "not a tag!" });
  const badAction = await manage({ action: "steal", tag: A });
  check("a tag that is not one, or an action that is not one: 400", badTag.status === 400 && badAction.status === 400);

  const shown = await manage({ action: "reveal", tag: A });
  check("reveal: the full URL of the live one", shown.status === 200 && shown.body.url === madeA.body.url);

  delete process.env.NEXT_PUBLIC_SITE_URL;
  const noSiteReveal = await manage({ action: "reveal", tag: A });
  const noSiteCreate = await manage({ action: "create", tag: C });
  const noSiteRotate = await manage({ action: "rotate", tag: A });
  const noSiteList = await call(R.inbound.GET);
  process.env.NEXT_PUBLIC_SITE_URL = SITE;
  const listedA = noSiteList.body?.clients?.find((c) => c.tag === A);
  check("without the site address: reveal, create and rotate refused (409), nothing made or changed",
    noSiteReveal.status === 409 && noSiteCreate.status === 409 && noSiteRotate.status === 409 && !(await urlRow(C)) && (await urlRow(A)).token === tok[A],
    JSON.stringify([noSiteReveal.body, noSiteCreate.body]));
  check("... and the list says so, with the URLs masked without an address",
    noSiteList.body.site === false && listedA?.url?.masked === `/api/enrich/intake/${tok[A].slice(0, 6)}…`, JSON.stringify(listedA?.url));

  const madeC = await manage({ action: "create", tag: C });
  tok[C] = tokenOf(madeC.body?.url);
  check("create for a third client", madeC.status === 201 && /^[A-Za-z0-9_-]{43}$/.test(tok[C]));

  T.worker = null;
  const list = await call(R.inbound.GET);
  const ours = (list.body?.clients ?? []).filter((c) => TAGS.includes(c.tag));
  const firstOther = list.body.clients.findIndex((c) => c.status !== "Active");
  const lastActive = list.body.clients.map((c) => c.status).lastIndexOf("Active");
  check("the list: every client of client_tags, Active first", list.status === 200 && list.body.clients.length >= 3 && (firstOther === -1 || lastActive < firstOther));
  check("... ours each with its URL masked, its table, held 0, switched off, and whether it has rules",
    ours.length === 3 && ours.every((c) => c.listed && c.url?.masked.endsWith("…") && c.table_id && c.held === 0 && c.switched_on === false) &&
      ours.find((c) => c.tag === A).has_rules === true && ours.find((c) => c.tag === B).has_rules === false,
    JSON.stringify(ours));
  check("... never a token", !Object.values(tok).some((t) => JSON.stringify(list.body).includes(t)));
  check("... the site is set, and no worker has run", list.body.site === true && list.body.worker === null);
  T.worker = heartbeat();
  const oldWorker = (await call(R.inbound.GET, { query: { tag: A } })).body.worker;
  T.worker = heartbeat({ capabilities: ["company_runs", "pipeline_v2", "held_release"] });
  const newWorker = (await call(R.inbound.GET, { query: { tag: A } })).body.worker;
  T.worker = null;
  check("... and whether the worker releases held places (held_release in its heartbeat)",
    oldWorker?.online === true && oldWorker.releases === false && newWorker?.releases === true, JSON.stringify({ oldWorker, newWorker }));
  const onlyA = await call(R.inbound.GET, { query: { tag: A.toLowerCase() } });
  const badQuery = await call(R.inbound.GET, { query: { tag: "no such tag!" } });
  check("?tag= lists that client alone; a tag that is not one is a 400",
    onlyA.status === 200 && onlyA.body.clients.length === 1 && onlyA.body.clients[0].tag === A && badQuery.status === 400);

  T.role = "viewer";
  const v1 = await call(R.inbound.GET);
  const v2 = await manage({ action: "reveal", tag: A });
  const v3 = await manage({ action: "create", tag: A });
  T.role = null;
  const v4 = await call(R.inbound.GET);
  T.role = "manager";
  check("a viewer gets 403 for the list and every action; no session, 401", v1.status === 403 && v2.status === 403 && v3.status === 403 && v4.status === 401);

  const before = T.audits.length;
  const acc = await manage({ action: "accept_name", tag: A, name: "  ibtest   legacy name " });
  check("accept_name keeps the name trimmed, single-spaced and upper case", acc.status === 200 && same(acc.body.accepted_names, ["IBTEST LEGACY NAME"]), JSON.stringify(acc.body));
  const acc2 = await manage({ action: "accept_name", tag: A, name: "IBTEST LEGACY NAME" });
  check("... once: accepting it again changes nothing and writes no audit line",
    acc2.status === 200 && acc2.body.accepted_names.length === 1 && T.audits.length === before + 1);
  const empty = await manage({ action: "accept_name", tag: A, name: "   " });
  check("... a blank name: 400", empty.status === 400);
  for (let i = 1; i <= 20; i++) await manage({ action: "accept_name", tag: C, name: `IBTEST NAME ${i}` });
  const full = await manage({ action: "accept_name", tag: C, name: "IBTEST NAME 21" });
  check("at most 20 names a URL: the 21st is refused (409)", full.status === 409 && (await urlRow(C)).accepted_names.length === 20, JSON.stringify(full.body));
  const drop = await manage({ action: "drop_name", tag: C, name: "ibtest name 20" });
  const dropAgain = await manage({ action: "drop_name", tag: C, name: "IBTEST NAME 20" });
  check("drop_name takes one back; a name not accepted is a 404",
    drop.status === 200 && drop.body.accepted_names.length === 19 && !drop.body.accepted_names.includes("IBTEST NAME 20") && dropAgain.status === 404);
  await pool.query(`UPDATE enrich_inbound_urls SET accepted_names = '{}' WHERE client_tag = $1`, [C]);

  const oldA = await urlRow(A);
  const rot = await manage({ action: "rotate", tag: A });
  const newTok = tokenOf(rot.body?.url);
  const oldRow = await one(`SELECT * FROM enrich_inbound_urls WHERE id = $1`, [oldA.id]);
  const newRow = await urlRow(A);
  check("rotate: a new URL at once; the old one revoked, by the manager, pointing to it; the accepted names carried over",
    rot.status === 200 && newTok !== tok[A] && newRow.token === newTok && oldRow.revoked_at !== null && oldRow.revoked_by === T.userId &&
      oldRow.replaced_by === newRow.id && same(newRow.accepted_names, ["IBTEST LEGACY NAME"]),
    JSON.stringify(rot.body));
  const oldAnswer = await post(tok[A], testCall());
  const newAnswer = await post(newTok, testCall());
  check("... the old URL answers 404 at once, and the new one works",
    oldAnswer.status === 404 && newAnswer.status === 200 && newAnswer.body.client_tag === A, JSON.stringify([oldAnswer.body, newAnswer.body]));
  const oldNoted = await one(`SELECT last_refused, last_refused_at FROM enrich_inbound_urls WHERE id = $1`, [oldA.id]);
  check("... and the old URL notes the delivery it refused", oldNoted.last_refused === "A chunk came to this URL after it was revoked" && oldNoted.last_refused_at !== null);
  const retired = tok[A];
  retiredTokens.push(retired);
  tok[A] = newTok;

  const rev = await manage({ action: "revoke", tag: B });
  const tB = await tableOf(B);
  const revAnswer = await post(tok[B], chunk([place(900)], { client: B }));
  const revNoted = await one(`SELECT revoked_at, revoked_by, last_refused FROM enrich_inbound_urls WHERE token = $1`, [tok[B]]);
  check("revoke: the URL answers 404 from then on, nothing is stored, and the refusal is noted",
    rev.status === 200 && revAnswer.status === 404 && revNoted.revoked_at !== null && revNoted.revoked_by === T.userId &&
      revNoted.last_refused === R.inb.REFUSED_NOTES.revoked && (await rowsIn(tB.id)) === 0);
  const revAgain = await manage({ action: "revoke", tag: B });
  const remade = await manage({ action: "create", tag: B });
  check("... revoking again is a 404, and the client can have a new URL", revAgain.status === 404 && remade.status === 201);
  const retiredB = tok[B];
  retiredTokens.push(retiredB);
  tok[B] = tokenOf(remade.body?.url);

  const lines = T.audits.filter((a) => a.action === "enrich_inbound_url").map((a) => a.details);
  const everyToken = [...Object.values(tok), retired, retiredB];
  check("one audit line per change, each naming the tag",
    [`Inbound URL created for ${A}`, `Inbound URL created for ${B}`, `Inbound URL created for ${C}`, `Inbound URL rotated for ${A}`, `Inbound URL revoked for ${B}`].every((l) => lines.includes(l)) &&
      lines.some((l) => l.includes("IBTEST LEGACY NAME") && l.includes(A)) && lines.filter((l) => l === `Inbound URL created for ${B}`).length === 2,
    JSON.stringify(lines));
  check("... never a token or a URL, and none for a reveal",
    T.audits.every((a) => !everyToken.some((t) => String(a.details).includes(t)) && !String(a.details).includes("/api/enrich/intake")) &&
      !lines.some((l) => /reveal|shown/i.test(l)));
}

// ── T3. The receiving route's answers ───────────────────────────────────────

async function partT3() {
  section("T3. The receiving route's answers");
  const { INTAKE_ANSWERS, REFUSED_NOTES, SCRAPER_FULL_PHRASES, makeToken } = R.inb;
  const tA = (await tableOf(A)).id;
  const keys = await inputKeys(tA);
  const urlA = await urlRow(A);

  const p = R.enrichDb.enrichPool();
  const realConnect = p.connect;
  let connects = 0;
  p.connect = function (...args) {
    connects++;
    return realConnect.apply(this, args);
  };
  const malformed = ["", "short", tok[A].slice(0, 42), `${tok[A]}x`, `${tok[A].slice(0, 42)}=`, `${tok[A].slice(0, 42)}.`, "../../../etc/passwd"];
  const bad = [];
  for (const t of malformed) bad.push(await post(t, chunk([place(1)])));
  delete p.connect;
  check("a malformed token: 404, before any query (no connection taken)",
    bad.every((r) => r.status === 404 && r.body.error === INTAKE_ANSWERS.unknown) && connects === 0, `${bad.map((r) => r.status)} connects=${connects}`);
  const stranger = await post(makeToken(), chunk([place(1)]));
  check("a well-formed token nobody holds: 404", stranger.status === 404 && stranger.body.error === INTAKE_ANSWERS.unknown);
  check("the route answers POST only (Next answers 405 to the rest)", same(Object.keys(R.intake).filter((k) => /^[A-Z]+$/.test(k)), ["POST"]));

  const notJson = await post(tok[A], "{not json");
  check("not JSON: 422, noted", notJson.status === 422 && notJson.body.error === INTAKE_ANSWERS.notChunk && (await urlRow(A)).last_refused === REFUSED_NOTES.notJson);
  const shapes = [{ hello: "there" }, { postbackData: { tasks: "a list it is not" } }, [1, 2], "null", "42"];
  const notChunks = [];
  for (const s of shapes) notChunks.push(await post(tok[A], s));
  check("JSON that is not a chunk (no postbackData.tasks list): 422, noted",
    notChunks.every((r) => r.status === 422 && r.body.error === INTAKE_ANSWERS.notChunk) && (await urlRow(A)).last_refused === REFUSED_NOTES.notChunk,
    notChunks.map((r) => r.status).join(","));
  const MB5 = 5 * 1024 * 1024;
  const byHeader = await post(tok[A], chunk([place(1)]), { "content-length": String(MB5 + 1) });
  const byBody = await post(tok[A], "x".repeat(MB5 + 1));
  const byBytes = await post(tok[A], "é".repeat(MB5 / 2 + 1)); // under 5 M characters, over 5 MB
  check("over 5 MB, by its Content-Length or by its bytes: 413",
    [byHeader, byBody, byBytes].every((r) => r.status === 413 && r.body.error === INTAKE_ANSWERS.tooLarge), [byHeader, byBody, byBytes].map((r) => r.status).join(","));
  check("... and nothing was stored by any of these", (await rowsIn(tA)) === 0);

  // The Test.
  const sourcesBefore = (await one(`SELECT count(*)::int AS n FROM enrich_sources WHERE table_id = $1`, [tA])).n;
  const t1 = await post(tok[A], testCall());
  const u1 = await urlRow(A);
  check("the Test: 200 with the client's tag, the table and whether it is switched on; no name check when no name was sent",
    t1.status === 200 && t1.body.ok === true && t1.body.test === true && t1.body.client_tag === A && t1.body.table === "Companies (pipeline)" &&
      t1.body.switched_on === false && !("name_check" in t1.body),
    JSON.stringify(t1.body));
  check("... it notes the Test's time and no name, and makes nothing: no source, no row, no delivery",
    u1.last_test_at !== null && u1.last_test_name === null && (await one(`SELECT count(*)::int AS n FROM enrich_sources WHERE table_id = $1`, [tA])).n === sourcesBefore &&
      (await rowsIn(tA)) === 0 && u1.last_used_at === null);
  const t2 = await post(tok[A], testCall({ client: " ibtest_a " }));
  const t3 = await post(tok[A], testCall({ client: "IBTEST OTHER NAME" }));
  check("a Test with a client name: the name check in the answer, the name noted",
    t2.status === 200 && same(t2.body.name_check, { fits: true, how: "tag" }) && t3.status === 200 && same(t3.body.name_check, { fits: false, how: null }) &&
      (await urlRow(A)).last_test_name === "IBTEST OTHER NAME",
    JSON.stringify([t2.body, t3.body]));

  // A chunk.
  const first = chunk([place(1), place(2), place(3, { place_id: undefined }), place(2)]);
  const a1 = await post(tok[A], first);
  check("a chunk: 200 after the commit, with its counts (a place twice in it counts once, one with no place id is skipped)",
    a1.status === 200 && a1.body.ok === true && a1.body.client_tag === A && a1.body.received === 4 && a1.body.created === 2 && a1.body.duplicates === 1 &&
      a1.body.skipped === 1 && a1.body.duplicate_delivery === false && a1.body.held === true,
    JSON.stringify(a1.body));
  const rows = await all(`SELECT id, row_key, run_status, source_id FROM enrich_rows WHERE table_id = $1 ORDER BY row_key`, [tA]);
  check("... read at once from another connection: 2 rows, keyed maps:<place id>, both held",
    rows.length === 2 && rows[0].row_key === `maps:${placeId(1)}` && rows[1].row_key === `maps:${placeId(2)}` && rows.every((r) => r.run_status === "held"),
    JSON.stringify(rows));
  const src = await sourceOf(tA, first.taskId);
  check("... one source of kind maps: the chunk id, the label, the counts, the URL it came through",
    src && src.label === "dentist · Springfield · IL" && src.received === 4 && src.created === 2 && src.duplicates === 1 && src.skipped === 1 &&
      src.inbound_url_id === urlA.id && rows.every((r) => r.source_id === src.id),
    JSON.stringify(src));
  check("... and its meta: the task, the search, the client name as compared, how it fit, the chunk's place",
    same(src?.meta, {
      task_id: first.originalTaskId, keyword: "dentist", city: "Springfield", state: "IL", category: "dentist", scrape_queue_id: "ibtest-queue-1",
      client_name: "IBTEST_A", name_check: "tag", chunk_index: 1, total_chunks: 1,
    }),
    JSON.stringify(src?.meta));
  const cells = await cellsOf(rows[0].id);
  const want = Object.fromEntries(Object.entries(placeInputs(place(1), first.extra, A)).filter(([k]) => keys.includes(k)));
  check("... a row's input cells are the place as mapped (placeInputs), and nothing else",
    Object.keys(cells).length === Object.keys(want).length && Object.entries(want).every(([k, v]) => cells[k]?.value === v && cells[k].status === "done"),
    JSON.stringify({ got: Object.fromEntries(Object.entries(cells).map(([k, c]) => [k, c.value])), want }));
  check("... the place's own fields: name, place id, website, domain, phone, Maps category as industry, source, client",
    cells.company?.value === "Inbound Test Dental 1" && cells.place_id?.value === placeId(1) && cells.website?.value === "https://www.dental1.ibtest.example/" &&
      cells.domain?.value === "dental1.ibtest.example" && cells.phone?.value === "+1 217-555-0100" && cells.industry?.value === "Dentist" &&
      cells.source?.value === "Google Maps" && cells.client_tag?.value === A);
  check("... the offices: one office, the place itself, as the head office",
    same(JSON.parse(cells.offices?.value ?? "null"), [{ street: "1 Main Street", city: "Springfield", state: "Illinois", country: "US", postal_code: "62701", hq: true }]) &&
      cells.office_count?.value === "1");
  check("... the Maps inputs: actual and searched city and state, and the searched category",
    cells.actual_city?.value === "Springfield" && cells.actual_state?.value === "Illinois" && cells.call_city?.value === "Springfield" &&
      cells.call_state?.value === "IL" && cells.call_category?.value === "dentist");
  const used1 = (await urlRow(A)).last_used_at;
  check("... the delivery is noted on the URL (last_used_at)", used1 instanceof Date);

  const again = await post(tok[A], first);
  check("the same chunk again: 200, a delivery seen before, nothing new",
    again.status === 200 && again.body.duplicate_delivery === true && again.body.created === 0 && (await rowsIn(tA)) === 2 &&
      (await one(`SELECT count(*)::int AS n FROM enrich_sources WHERE table_id = $1 AND kind = 'maps'`, [tA])).n === 1,
    JSON.stringify(again.body));
  const seen = await post(tok[A], chunk([place(1), place(4)]));
  check("a place already in the table, from another chunk: a duplicate, left as it is", seen.status === 200 && seen.body.created === 1 && seen.body.duplicates === 1);
  const used2 = (await urlRow(A)).last_used_at;
  await pool.query(`UPDATE enrich_inbound_urls SET last_used_at = now() - interval '2 minutes' WHERE id = $1`, [urlA.id]);
  const aged = (await urlRow(A)).last_used_at;
  await post(tok[A], chunk([place(14)]));
  const used3 = (await urlRow(A)).last_used_at;
  check("last_used_at is written at most once a minute: kept for a delivery soon after, renewed once older",
    used2?.getTime() === used1?.getTime() && used3?.getTime() > aged?.getTime(), JSON.stringify({ used1, used2, aged, used3 }));

  const plain = chunk([place(5)], { rewrite: false, task: `ibtest-plain-${RUN}`, index: 3 });
  const noIndex = { ...chunk([place(6)], { rewrite: false, task: `ibtest-noindex-${RUN}` }), chunkIndex: undefined };
  const longTask = chunk([place(7)], { rewrite: false, task: `ibtest-long-${RUN}-${"x".repeat(600)}` });
  await post(tok[A], plain);
  await post(tok[A], noIndex);
  const lp = await post(tok[A], longTask);
  const longSrc = await one(`SELECT external_id FROM enrich_sources WHERE table_id = $1 AND kind = 'maps' AND external_id LIKE 'sha256:%'`, [tA]);
  check("chunk ids: <taskId>-<chunkIndex> without the scraper app's rewrite, the taskId with no index, a long one as its sha256",
    !!(await sourceOf(tA, `ibtest-plain-${RUN}-3`)) && !!(await sourceOf(tA, `ibtest-noindex-${RUN}`)) && lp.status === 200 && /^sha256:[0-9a-f]{64}$/.test(longSrc?.external_id ?? ""));
  const noTask = chunk([place(8)]);
  delete noTask.taskId;
  delete noTask.originalTaskId;
  const nt1 = await post(tok[A], noTask);
  const nt2 = await post(tok[A], noTask);
  check("a chunk with no taskId: stored, and sent again it adds no row (places are once per client)",
    nt1.status === 200 && nt1.body.created === 1 && nt2.status === 200 && nt2.body.created === 0 && nt2.body.duplicates === 1);

  const blank = await post(tok[A], chunk([place(9)], { extra: { client: A, keyword: "", city: "", state: "", category: "", scrape_queue_id: "" } }));
  const blankRow = await placeRow(tA, 9);
  const blankCells = blankRow ? await cellsOf(blankRow.id) : {};
  const blankSrc = await one(`SELECT label FROM enrich_sources WHERE id = $1`, [blankRow?.source_id]);
  check("blank search city, state and category: stored all the same, labelled Google Maps (the place's own address places it)",
    blank.status === 200 && blank.body.created === 1 && blankSrc?.label === "Google Maps" && !blankCells.call_city && blankCells.actual_city?.value === "Springfield");

  const odd = await post(tok[A], chunk(
    [place(10, { title: "Inbound\u0000 Test \ud800 Dental 10" }), place(11, { place_id: { not: "text" } }), place(12, { place_id: "p".repeat(1001) }), place(13, { address_info: undefined })],
    { extra: { client: A, ...EXTRA, keyword: "dent\u0000ist" } }
  ));
  const oddRow = await placeRow(tA, 10);
  const oddCells = oddRow ? await cellsOf(oddRow.id) : {};
  const noOffice = await placeRow(tA, 13);
  const noOfficeCells = noOffice ? await cellsOf(noOffice.id) : {};
  check("odd places: text with a NUL and a lone surrogate stored cleaned, a place id that is not text or too long skipped, no address: no office",
    odd.status === 200 && odd.body.created === 2 && odd.body.skipped === 2 && oddCells.company?.value === "Inbound Test � Dental 10" &&
      !!noOffice && !noOfficeCells.offices && !noOfficeCells.office_count,
    JSON.stringify({ body: odd.body, company: oddCells.company?.value }));

  check("every refusal's body is under 200 characters (the scraper app keeps 200 on the card)",
    Object.values(INTAKE_ANSWERS).every((e) => JSON.stringify({ error: e }).length < 200 && !SCRAPER_FULL_PHRASES.test(e)));
}

// ── T4. The client name check ───────────────────────────────────────────────

async function partT4() {
  section("T4. The client name check, Accept this name, and a table that can't be made");
  const { INTAKE_ANSWERS, REFUSED_NOTES } = R.inb;
  const tA = (await tableOf(A)).id;
  const tC = (await tableOf(C)).id;

  const both = "IBTEST_A & IBTEST_C";
  const partA = await post(tok[A], chunk([place(20)], { client: both }));
  const partC = await post(tok[C], chunk([place(20)], { client: both }));
  const metaA = (await one(`SELECT s.meta FROM enrich_sources s JOIN enrich_rows r ON r.source_id = s.id WHERE r.table_id = $1 AND r.row_key = $2`, [tA, `maps:${placeId(20)}`]))?.meta;
  check("a compound scraper name holding the tag is stored for each client it names (one part fits)",
    partA.status === 200 && partA.body.created === 1 && partC.status === 200 && partC.body.created === 1 && metaA?.name_check === "part" && metaA.client_name === both,
    JSON.stringify([partA.body, partC.body, metaA]));
  const lower = await post(tok[A], chunk([place(21)], { client: "  ibtest_a  " }));
  check("... the name is compared trimmed and upper case", lower.status === 200 && lower.body.created === 1);

  const other = chunk([place(22)], { client: "IBTEST OTHER NAME" });
  const mis = await post(tok[A], other);
  const u = await urlRow(A);
  check("a name that doesn't fit: 429 (the scraper app keeps the chunk and uses no try), nothing stored",
    mis.status === 429 && mis.body.error === INTAKE_ANSWERS.nameMismatch && !(await placeRow(tA, 22)) && !(await sourceOf(tA, other.taskId)), JSON.stringify(mis.body));
  check("... the URL notes why and the name, for the Clay tab; the answer never repeats the name",
    u.last_refused === REFUSED_NOTES.nameMismatch && u.refused_name === "IBTEST OTHER NAME" && u.last_refused_at !== null && !/OTHER NAME/i.test(mis.body.error));
  const seenBefore = (await call(R.inbound.GET, { query: { tag: A } })).body.clients[0].url;
  check("... the list shows the refused name, not fitting yet", seenBefore.refused_name === "IBTEST OTHER NAME" && seenBefore.refused_fits_now === false && seenBefore.last_refused === REFUSED_NOTES.nameMismatch);
  const accept = await manage({ action: "accept_name", tag: A, name: "IBTEST OTHER NAME" });
  const resent = await post(tok[A], other);
  const how = (await sourceOf(tA, other.taskId))?.meta?.name_check;
  check("after Accept this name, the same chunk is stored, as an accepted name", accept.status === 200 && resent.status === 200 && resent.body.created === 1 && how === "accepted", JSON.stringify(resent.body));
  check("... and the list says the refused name fits now", (await call(R.inbound.GET, { query: { tag: A } })).body.clients[0].url.refused_fits_now === true);

  const wrongClient = await post(tok[A], chunk([place(23)], { client: B }));
  check("another client's tag on this URL: 429", wrongClient.status === 429 && wrongClient.body.error === INTAKE_ANSWERS.nameMismatch);
  const noExtra = await post(tok[A], chunk([place(24)], { extra: null }));
  const un = await urlRow(A);
  check("a chunk with no extra block (no client name): 429, noted as having no name",
    noExtra.status === 429 && un.last_refused === REFUSED_NOTES.noName && un.refused_name === null);
  const missing = await post(tok[A], chunk([place(25)], { extra: { ...EXTRA } }));
  const blankName = await post(tok[A], chunk([place(26)], { client: "   " }));
  const objName = await post(tok[A], chunk([place(27)], { client: { name: A } }));
  check("... the same with no client in it, a blank one, or one that isn't text", [missing, blankName, objName].every((r) => r.status === 429));
  const leaked = await all(`SELECT row_key FROM enrich_rows WHERE table_id = $1 AND row_key = ANY($2::text[])`, [tA, [23, 24, 25, 26, 27].map((n) => `maps:${placeId(n)}`)]);
  check("nothing was stored for any refused chunk", leaked.length === 0, JSON.stringify(leaked));

  // A table made before the Maps inputs is brought up to date before the chunk is stored.
  await pool.query(`DELETE FROM enrich_columns WHERE table_id = $1 AND key = 'place_id'`, [tC]);
  const upgraded = await post(tok[C], chunk([place(28)], { client: C }));
  const upRow = await placeRow(tC, 28);
  check("a Companies table without the place id input is brought up to date first, then the chunk stored",
    upgraded.status === 200 && upgraded.body.created === 1 && (await inputKeys(tC)).includes("place_id") && !!upRow && (await cellsOf(upRow.id)).place_id?.value === placeId(28),
    JSON.stringify(upgraded.body));

  // The client's Companies table can't be made: a retired companies_v1 table (D24).
  await pool.query(`DELETE FROM enrich_tables WHERE id = $1`, [tC]);
  await pool.query(`INSERT INTO enrich_tables (client_tag, kind, name, template) VALUES ($1, 'companies', 'Companies (retired, test)', 'companies_v1')`, [C]);
  const notReady = await post(tok[C], chunk([place(30)], { client: C }));
  const uc = await urlRow(C);
  check("the client's Companies table can't be made (a retired companies_v1 table): 429, nothing made or stored, noted",
    notReady.status === 429 && notReady.body.error === INTAKE_ANSWERS.notReady && !(await tableOf(C)) && uc.last_refused === REFUSED_NOTES.notReady,
    JSON.stringify(notReady.body));
  await pool.query(`DELETE FROM enrich_tables WHERE client_tag = $1 AND template = 'companies_v1'`, [C]);
  const remade = await post(tok[C], chunk([place(30)], { client: C }));
  const tC2 = await tableOf(C);
  check("... once it can be made, the next chunk makes the client's table and is stored",
    remade.status === 200 && remade.body.created === 1 && !!tC2 && (await heldIn(tC2.id)) === 1, JSON.stringify(remade.body));
}

// ── T6. Load and errors ─────────────────────────────────────────────────────

async function partT6() {
  section("T6. Load and errors");
  const { INTAKE_ANSWERS } = R.inb;
  const tA = (await tableOf(A)).id;
  const deadlocks = async () => Number((await one(`SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()`)).deadlocks);

  // Ten deliveries at once, with overlapping places in opposite orders.
  const placesN = Array.from({ length: 30 }, (_, i) => place(100 + i));
  const bodies = Array.from({ length: 10 }, (_, k) => {
    const items = placesN.slice(k, k + 21); // 21 places from the k-th: together all 30, most in several chunks
    return chunk(k % 2 ? [...items].reverse() : items);
  });
  const deadBefore = await deadlocks();
  const results = await Promise.all(bodies.map((b) => post(tok[A], b)));
  check("ten deliveries at once, overlapping places in opposite orders: each 200 or 429, never 500",
    results.every((r) => r.status === 200 || r.status === 429), results.map((r) => r.status).join(","));
  for (const [i, r] of results.entries()) if (r.status === 429) results[i] = await post(tok[A], bodies[i]);
  const stored = (await one(`SELECT count(*)::int AS n FROM enrich_rows WHERE table_id = $1 AND row_key = ANY($2::text[])`, [tA, placesN.map((p) => `maps:${p.place_id}`)])).n;
  const sum = (k) => results.reduce((s, r) => s + (r.body?.[k] ?? 0), 0);
  check("... the counts add up: 30 places, each stored once, held; created and duplicates make up what was received",
    results.every((r) => r.status === 200) && stored === 30 && sum("created") === 30 && sum("created") + sum("duplicates") + sum("skipped") === sum("received"),
    JSON.stringify({ stored, created: sum("created"), duplicates: sum("duplicates"), received: sum("received") }));
  await sleep(2_000); // the server reports its counters about once a second
  check("... and no deadlock", (await deadlocks()) === deadBefore);

  // The slots: 3 in this process, a 2 s wait for one.
  const { INTAKE_SLOTS, takeIntakeSlot, releaseIntakeSlot } = R.gm;
  for (let i = 0; i < INTAKE_SLOTS; i++) await takeIntakeSlot();
  let t0 = Date.now();
  const busy = await post(tok[A], chunk([place(200)]));
  const waited = Date.now() - t0;
  check("every slot held past 2 s: 429 busy after the wait, nothing stored",
    busy.status === 429 && busy.body.error === INTAKE_ANSWERS.busy && waited >= 1_900 && waited < 5_000 && !(await placeRow(tA, 200)), `${busy.status} after ${waited} ms`);
  const waiting = post(tok[A], chunk([place(200)]));
  await sleep(500);
  releaseIntakeSlot();
  const served = await waiting;
  for (let i = 1; i < INTAKE_SLOTS; i++) releaseIntakeSlot();
  check("... a delivery waiting for a slot takes the first one freed, and is stored", served.status === 200 && served.body.created === 1);

  // A lock held past the statement timeout (15 s), here on the table's row, which every insert's key check takes.
  const locker = await pool.connect();
  let locked;
  try {
    await locker.query("BEGIN");
    await locker.query(`SELECT id FROM enrich_tables WHERE id = $1 FOR UPDATE`, [tA]);
    t0 = Date.now();
    locked = await post(tok[A], chunk([place(201)]));
  } finally {
    await locker.query("ROLLBACK").catch(() => {});
    locker.release();
  }
  const ms = Date.now() - t0;
  check("another connection holding the table's row past the 15 s statement timeout: 429 busy, within the scraper app's 30 s, nothing stored",
    locked.status === 429 && locked.body.error === INTAKE_ANSWERS.busy && ms >= 14_000 && ms < 25_000 && !(await placeRow(tA, 201)), `${locked.status} after ${ms} ms`);

  // An unexpected error, and a passing one, where the transaction would start.
  const p = R.enrichDb.enrichPool();
  const logged = [];
  const realError = console.error;
  let boom;
  let slow;
  console.error = (...a) => logged.push(a.map((x) => (x instanceof Error ? `${x.name} ${x.message}` : String(x))).join(" "));
  try {
    p.connect = async () => {
      throw Object.assign(new Error("made-up failure"), { code: "XX999" });
    };
    boom = await post(tok[A], chunk([place(202)]));
    p.connect = async () => {
      throw new Error("timeout exceeded when trying to connect");
    };
    slow = await post(tok[A], chunk([place(203)]));
  } finally {
    delete p.connect;
    console.error = realError;
  }
  check("an unexpected error: 500, intake failed (one try used)", boom.status === 500 && boom.body.error === INTAKE_ANSWERS.failed, JSON.stringify(boom.body));
  check("... logged without the token, a URL or the body",
    logged.length >= 1 && logged.every((l) => !l.includes(tok[A]) && !l.includes("/api/enrich/intake/") && !l.includes("Inbound Test Dental")), JSON.stringify(logged));
  check("the pool's wait for a connection: 429 busy (no try used)", slow.status === 429 && slow.body.error === INTAKE_ANSWERS.busy);
  check("only that forced error ever answered 500", answers.filter((a) => a.status === 500).length === 1);
}

// ── R. The Run route and the table route ────────────────────────────────────

async function partR() {
  section("R. The Run route leaves held rows held; the table route's held count and Maps deliveries");
  const tA = (await tableOf(A)).id;
  const held = (await all(`SELECT id FROM enrich_rows WHERE table_id = $1 AND run_status = 'held' ORDER BY id`, [tA])).map((r) => Number(r.id));
  const heldCount = held.length;
  const { rows: [done] } = await pool.query(
    `INSERT INTO enrich_rows (table_id, row_key, search_text, run_status) VALUES ($1, $2, '', 'done') RETURNING id`,
    [tA, `maps:ibtest-done-${RUN}`]
  );
  const doneId = Number(done.id);
  const runAs = (body) => call(R.run.POST, { body: { table: tA, ...body } });
  const reset = () => pool.query(`UPDATE enrich_rows SET run_status = 'done' WHERE id = $1`, [doneId]);
  T.audits.length = 0;

  const r1 = await runAs({ scope: "rows", rows: [held[0], held[1], doneId], force: true });
  check("rows: the done row queued, the two held rows left alone and counted",
    r1.status === 200 && r1.body.queued === 1 && r1.body.skippedHeld === 2 && r1.body.skippedRunning === 0, JSON.stringify(r1.body));
  await reset();
  const r2 = await runAs({ scope: "column", column: "client_office" });
  check("column: every held row left alone and counted", r2.status === 200 && r2.body.queued === 1 && r2.body.skippedHeld === heldCount, JSON.stringify(r2.body));
  await reset();
  const r3 = await runAs({ scope: "column", column: "client_office", only: "error" });
  check("column, errors only: no held row has one", r3.status === 200 && r3.body.queued === 0 && r3.body.skippedHeld === 0, JSON.stringify(r3.body));
  const r4 = await runAs({ scope: "errors" });
  const r5 = await runAs({ scope: "waiting" });
  check("errors and waiting: held rows are neither", r4.status === 200 && r4.body.skippedHeld === 0 && r5.status === 200 && r5.body.skippedHeld === 0);
  const r6 = await runAs({ scope: "all" });
  check("all: the done row queued, every held row left alone and counted", r6.status === 200 && r6.body.queued === 1 && r6.body.skippedHeld === heldCount, JSON.stringify(r6.body));
  check("after every scope, every held row is still held", (await heldIn(tA)) === heldCount);
  check("the audit line says how many held rows were left alone",
    T.audits.some((a) => a.action === "enrich_run" && a.details.includes(`${heldCount} held rows left alone`)), JSON.stringify(T.audits.map((a) => a.details)));
  let guard = null;
  try {
    await pool.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [held[0]]);
  } catch (e) {
    guard = e.code;
  }
  check("the database's guard refuses a release while the client is off (23514), so the route must skip held rows", guard === "23514", String(guard));

  const heldRows = await call(R.rows.GET, { query: { table: tA, status: "held", size: "200" } });
  check("the rows route filters on Held", heldRows.status === 200 && heldRows.body.total === heldCount && heldRows.body.rows.every((r) => r.run_status === "held"), String(heldRows.body?.total));
  const detail = await call(R.table.GET, { query: { id: tA } });
  const urlIds = (await all(`SELECT id FROM enrich_inbound_urls WHERE client_tag = $1`, [A])).map((r) => r.id);
  const d = detail.body?.deliveries ?? [];
  check("the table route: the held count, and the newest Maps deliveries with the URL each came through",
    detail.status === 200 && detail.body.statuses.held === heldCount && d.length === 10 && d.every((x) => x.kind === "maps" && urlIds.includes(x.inbound_url_id)) &&
      d.every((x, i) => i === 0 || new Date(d[i - 1].created_at) >= new Date(x.created_at)),
    JSON.stringify({ held: detail.body?.statuses?.held, n: d.length }));
  return { tA, held };
}

// ── S. The settings route: the vendor caps, and a client switched on ────────

async function partS({ tA, held }) {
  section("S. The settings route: the email finders' and Enrichley's daily caps (admin), and a client switched on");
  const serverLib = await srcModule("lib/companies/server.ts");
  const types = await srcModule("lib/companies/types.ts");
  const edit = (state, f) => {
    const x = structuredClone(serverLib.settingsInputOf(state.value));
    f(x);
    return { body: { version: state.version, ...x } };
  };
  T.role = "manager";
  const m1 = await call(R.settings.GET);
  const m2 = await call(R.settings.PUT, { body: {} });
  check("managers can't read or save them (403)", m1.status === 403 && m2.status === 403);
  T.role = "admin";
  const got = await call(R.settings.GET);
  const caps0 = got.body?.value?.spend_caps?.vendor_calls_per_day;
  check("the settings carry the four caps, each a whole number (0 until set)",
    got.status === 200 && same(Object.keys(caps0 ?? {}).sort(), [...VENDOR_CAP_KEYS].sort()) && VENDOR_CAP_KEYS.every((k) => Number.isInteger(caps0[k])), JSON.stringify(caps0));
  check("the sheet's list is the worker's: the same keys, in order, with the same names",
    same(types.VENDOR_CAPS.map((v) => v.key), [...VENDOR_CAP_KEYS]) && types.VENDOR_CAPS.every((v) => v.label === VENDOR_CAP_LABELS[v.key]));
  check("the sheet sends them back as they are (settingsInputOf)", same(serverLib.settingsInputOf(got.body.value).spend_caps.vendor_calls_per_day, caps0));

  for (const [label, f, re] of [
    ["a cap under 0: 400", (x) => { x.spend_caps.vendor_calls_per_day.findymail = -1; }, /Findymail calls a day must be a whole number from 0 to 100,000/],
    ["a cap that is not whole: 400", (x) => { x.spend_caps.vendor_calls_per_day.prospeo = 1.5; }, /Prospeo calls a day must be a whole number/],
    ["a cap over 100,000: 400", (x) => { x.spend_caps.vendor_calls_per_day.enrichley = 100_001; }, /Enrichley calls a day must be a whole number/],
    ["a vendor left out: 400", (x) => { delete x.spend_caps.vendor_calls_per_day.anymail_finder; }, /Anymail Finder calls a day must be a whole number/],
    ["not the caps' shape: 400", (x) => { x.spend_caps.vendor_calls_per_day = "lots"; }, /must be a number for each of them/],
  ]) {
    const r = await call(R.settings.PUT, edit(got.body, f));
    check(label, r.status === 400 && re.test(r.body.error ?? ""), `${r.status} ${r.body.error ?? ""}`);
  }
  check("... and a refused save writes nothing", (await call(R.settings.GET)).body.version === got.body.version);

  const want = Object.fromEntries(VENDOR_CAP_KEYS.map((k, i) => [k, caps0[k] === [200, 0, 50, 1_000][i] ? [200, 0, 50, 1_000][i] + 1 : [200, 0, 50, 1_000][i]]));
  T.audits.length = 0;
  const saved = await call(R.settings.PUT, edit(got.body, (x) => { x.spend_caps.vendor_calls_per_day = { ...want }; }));
  const stored = (await one(`SELECT value FROM enrich_settings WHERE key = 'spend_caps'`)).value;
  const wantChanges = VENDOR_CAP_KEYS.filter((k) => caps0[k] !== want[k]).map((k) => `${VENDOR_CAP_LABELS[k]} calls a day ${fmt(caps0[k])} to ${fmt(want[k])}`);
  check("a save: 200, each changed cap listed and logged (\"Findymail calls a day 0 to 200\")",
    saved.status === 200 && wantChanges.length > 0 && wantChanges.every((c) => saved.body.changes.includes(c)) &&
      T.audits.some((a) => a.action === "enrich_settings" && wantChanges.every((c) => a.details.includes(c))),
    JSON.stringify(saved.body.changes ?? saved.body));
  const was = settingsBefore.find((r) => r.key === "spend_caps")?.value ?? {};
  check("... stored, with the other caps and the prices kept",
    same(stored.vendor_calls_per_day, want) && stored.reoon_checks_per_day === got.body.value.spend_caps.reoon_checks_per_day &&
      same(stored.openai_usd_per_day, got.body.value.spend_caps.openai_usd_per_day) && same(stored.openai_prices ?? null, was.openai_prices ?? null),
    JSON.stringify(stored));
  check("... and the worker reads them (settingsFrom)", same(settingsFrom(await all(`SELECT key, value FROM enrich_settings`)).spend_caps.vendor_calls_per_day, want));
  const now = await call(R.settings.GET);
  const keep = await call(R.settings.PUT, edit(now.body, (x) => {
    delete x.spend_caps.vendor_calls_per_day;
    x.spend_caps.reoon_checks_per_day = x.spend_caps.reoon_checks_per_day === 1_499 ? 1_498 : 1_499;
  }));
  check("a save without the caps (an older sheet) keeps them as stored",
    keep.status === 200 && same((await one(`SELECT value FROM enrich_settings WHERE key = 'spend_caps'`)).value.vendor_calls_per_day, want) &&
      !keep.body.changes.some((c) => c.includes("calls a day")),
    JSON.stringify(keep.body.changes ?? keep.body));

  // A switched on (Company pulls on, A on its list, typed in lower case).
  const now2 = await call(R.settings.GET);
  const on = await call(R.settings.PUT, edit(now2.body, (x) => {
    x.company_pipeline.enabled = true;
    x.company_pipeline.tags = [A.toLowerCase()];
  }));
  const test = await post(tok[A], testCall());
  const listed = (await call(R.inbound.GET)).body.clients.filter((c) => TAGS.includes(c.tag));
  check("switched on: the Test and the list say so for that client only",
    on.status === 200 && test.body.switched_on === true && listed.find((c) => c.tag === A)?.switched_on === true &&
      listed.filter((c) => c.tag !== A).every((c) => c.switched_on === false),
    JSON.stringify(listed.map((c) => [c.tag, c.switched_on])));
  const heldNow = await heldIn(tA);
  const stillHeld = await call(R.run.POST, { body: { table: tA, scope: "all" } });
  check("... the Run route still leaves held rows alone (only the worker releases them)",
    stillHeld.status === 200 && stillHeld.body.skippedHeld === heldNow && (await heldIn(tA)) === heldNow, JSON.stringify(stillHeld.body));
  const c = await pool.connect();
  let released = null;
  try {
    await c.query("BEGIN");
    released = (await c.query(`UPDATE enrich_rows SET run_status = 'queued' WHERE id = $1`, [held[0]])).rowCount;
  } catch (e) {
    released = e.code;
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
  check("... and the guard lets a held row go while the client is on (rolled back here: releasing is the worker's job)", released === 1, String(released));
  T.role = "manager";
}

// ── Every answer ────────────────────────────────────────────────────────────

function partAll(retired) {
  section("Every answer the receiving route gave in this run");
  const { SCRAPER_FULL_PHRASES } = R.inb;
  const statuses = new Set(answers.map((a) => a.status));
  const tokens = [...Object.values(tok), ...retired];
  check(`never 410, and 500 only for the forced error (${fmt(answers.length)} answers)`,
    !statuses.has(410) && answers.filter((a) => a.status === 500).length === 1, [...statuses].join(","));
  check("no answer holds a scraper app \"full\" phrase or a token", answers.every((a) => !SCRAPER_FULL_PHRASES.test(a.text) && !tokens.some((t) => a.text.includes(t))));
  check("no refusal repeats the chunk's client name",
    answers.every((a) => a.status === 200 || !a.sent?.trim() || !a.text.toUpperCase().includes(a.sent.trim().replace(/\s+/g, " ").toUpperCase())));
}

// ── Run ─────────────────────────────────────────────────────────────────────

const t0 = Date.now();
let enrichDb = null;
try {
  const ready = await one(
    `SELECT to_regclass('public.enrich_inbound_urls') IS NOT NULL AND to_regprocedure('public.fn_enrich_company_switch_on(text)') IS NOT NULL AS ok`
  );
  if (!ready.ok) throw new Error("migration 129 is not in this database");
  const live = await one(
    `SELECT count(*)::int AS n FROM enrich_worker_state WHERE last_seen > now() - interval '60 seconds' AND coalesce(info->>'stopped', 'false') <> 'true'`
  );
  if (live.n) throw new Error("an enrichment worker is running: stop it first");
  await cleanup(); // anything an interrupted run left behind
  settingsBefore = await all(`SELECT key, value FROM enrich_settings WHERE key = ANY($1::text[])`, [SETTING_KEYS]);
  await addClients();
  enrichDb = await srcModule("lib/enrich/db.ts");
  R = {
    intake: await route("enrich/intake/[token]"),
    inbound: await route("enrich/inbound"),
    run: await route("enrich/run"),
    rows: await route("enrich/rows"),
    table: await route("enrich/table"),
    settings: await route("companies/settings"),
    gm: await srcModule("lib/enrich/gmaps.ts"),
    inb: await srcModule("lib/enrich/inbound.ts"),
    enrichDb,
  };
  await partT2();
  await partT1();
  await partT3();
  await partT4();
  await partT6();
  const r = await partR();
  await partS(r);
  partAll(retiredTokens);
  check("nothing tried to reach any address", Object.values(net.calls).every((n) => n === 0), JSON.stringify(net.calls));
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  const left = await one(
    `SELECT (SELECT count(*)::int FROM enrich_tables WHERE client_tag = ANY($1::text[])) AS tables,
            (SELECT count(*)::int FROM enrich_inbound_urls WHERE client_tag = ANY($1::text[])) AS urls,
            (SELECT count(*)::int FROM enrich_originals WHERE variant = ANY($2::text[])) AS originals,
            (SELECT count(*)::int FROM client_tags WHERE tag = ANY($1::text[])) AS clients,
            (SELECT count(*)::int FROM client_targeting WHERE client_tag = ANY($1::text[])) AS rules`,
    [TAGS, VARIANTS]
  );
  const back = settingsBefore
    ? same(await all(`SELECT key, value FROM enrich_settings WHERE key = ANY($1::text[]) ORDER BY key`, [SETTING_KEYS]), [...settingsBefore].sort((a, b) => (a.key < b.key ? -1 : 1)))
    : true;
  const clean = Object.values(left).every((n) => n === 0) && back;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, settingsBack: back })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await enrichDb?.enrichPool().end().catch(() => {});
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
