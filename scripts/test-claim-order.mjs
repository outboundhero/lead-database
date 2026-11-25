#!/usr/bin/env node
// The enrichment worker's claim order (scripts/lib/enrich/claim.mjs): rows of
// AI Ark tab pulls (tables of kind 'ai_ark') are claimed before any other row,
// then the rest, oldest first. LOCAL DATABASE ONLY: made-up tables of the
// made-up client CLAIMTEST_A and their rows, all removed at the end, also when
// a check fails (and at the start, after a run that was killed).
//
//   node --env-file=.env.local scripts/test-claim-order.mjs
//
// Stop the enrichment worker first, and don't start it for this: a claim takes
// due rows of every table in the database, so the script refuses to run while
// a worker's heartbeat is fresh, or while a row of any other table is queued
// and due (or due within 10 minutes). No network, no key.
//
//   A. the order: pull rows first even when every other row is older, then the
//      rest oldest first across tables (a tie by id); a pull row queued later
//      still goes first; the rest's statement runs only when the pull rows did
//      not fill the claim
//   B. claimed rows are running with their claim's token and an attempt
//      counted; rows of a paused table (a pull's and another), of a retired
//      template's table (companies_v1), held, finished and waiting rows, and
//      rows not due yet are never claimed
//   C. two claims at once take different rows, and neither waits for the other
//   D. claiming the rest fails: the pull rows already claimed are handed back
//      and the failure logged; with no pull row claimed, the failure is thrown
//   E. the plans (EXPLAIN, never ANALYZE): whether each statement reads the
//      queue index enrich_rows_queue_idx as planned now, and that it can

import pg from "pg";
import { randomUUID } from "node:crypto";
import { CLAIM_SQL, claimRows, PULL_KIND } from "./lib/enrich/claim.mjs";
import { RETIRED_TEMPLATES } from "./lib/enrich/templates.mjs";

const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
  console.error("Refusing to run: DATABASE_URL must point at the local database (127.0.0.1 / localhost).");
  process.exit(1);
}
// A claim that waited for another's locks would hang the script: every statement gives up after 10 s instead.
const pool = new pg.Pool({ connectionString: url, max: 4, statement_timeout: 10_000 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
}
const section = (s) => console.log(`\n${s}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameSet = (a, b) => same([...a].sort(), [...b].sort());

const TAG = "CLAIMTEST_A";
const RETIRED = [...RETIRED_TEMPLATES];
const QUEUE_INDEX = "enrich_rows_queue_idx";
/** Table key → id, for every made-up table. */
const tables = {};
/** Row label → id (text), for every made-up row. */
const rows = {};
/** Row label → what it was made as. */
const made = {};
let base = "";

async function table(key, { kind, paused = false, template = null }) {
  const { id } = await one(
    `INSERT INTO enrich_tables (client_tag, kind, name, source_note, is_paused, template)
     VALUES ($1, $2, $3, 'test-claim-order: made up', $4, $5) RETURNING id`,
    [TAG, kind, `Claim test ${key}`, paused, template]
  );
  tables[key] = id;
}

/** A made-up row of table `t`, due `minutes` after the run's base time (negative: due since), in `status`. */
async function row(label, t, minutes, status = "queued") {
  const { id } = await one(
    `INSERT INTO enrich_rows (table_id, row_key, run_status, next_run_at)
     VALUES ($1, $2, $3, $4::timestamptz + make_interval(mins => $5)) RETURNING id`,
    [tables[t], `claimtest:${label}`, status, base, minutes]
  );
  rows[label] = String(id);
  made[label] = { status };
}

const label = (id) => Object.keys(rows).find((k) => rows[k] === String(id)) ?? `unknown row ${id}`;
const labels = (ids) => ids.map(label).join(", ") || "nothing";
const ids = (...names) => names.map((n) => rows[n]);
const stateOf = async (names) =>
  all(`SELECT id::text AS id, run_status, claim_token, claimed_at, attempts FROM enrich_rows WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids(...names)]);

/** The pool, noting which of the claim's two statements ran. */
function recorded(db = pool) {
  const ran = [];
  return {
    ran,
    db: {
      query: (sql, params) => {
        ran.push(sql === CLAIM_SQL.pulls ? "pulls" : sql === CLAIM_SQL.rest ? "rest" : "other");
        return db.query(sql, params);
      },
    },
  };
}

/** Every claim section A makes: its token and the rows it took. */
const claims = [];
async function claim(n) {
  const token = randomUUID();
  const { db, ran } = recorded();
  const got = await claimRows(db, n, { token, retired: RETIRED });
  const out = { got, ids: got.map((r) => String(r.id)), ran, token };
  claims.push(out);
  return out;
}

// ── A and B. The order, and what is never claimed ───────────────────────────

async function partAB() {
  section("A. Pull rows first, then the rest oldest first");
  await table("pull", { kind: PULL_KIND });
  await table("pull 2", { kind: PULL_KIND });
  await table("pull paused", { kind: PULL_KIND, paused: true });
  await table("people", { kind: "people" });
  await table("companies", { kind: "companies" });
  await table("people paused", { kind: "people", paused: true });
  await table("retired", { kind: "companies", template: RETIRED[0] });
  // Never claimed, though most are older than any row below.
  await row("paused pull row", "pull paused", -300);
  await row("paused people row", "people paused", -290);
  await row("retired template row", "retired", -280);
  await row("held row", "people", -270, "held");
  await row("done row", "companies", -260, "done");
  await row("waiting row", "people", -250, "waiting");
  await row("future pull row", "pull", 60);
  await row("future people row", "people", 60);
  // Other rows, all older than every pull row; o3 and o3b are due at the same moment.
  await row("o1", "people", -240);
  await row("o2", "companies", -230);
  await row("o3", "people", -220);
  await row("o3b", "companies", -220);
  await row("o4", "people", -210);
  // Pull rows, in two pull tables.
  await row("p1", "pull", -60);
  await row("p2", "pull 2", -50);
  await row("p3", "pull", -40);

  let c = await claim(2);
  check("a claim of 2: the two oldest pull rows, though four other rows waited longer; they filled it, so the rest's statement never ran",
    sameSet(c.ids, ids("p1", "p2")) && same(c.ran, ["pulls"]), `${labels(c.ids)}; ran ${c.ran.join(", ")}`);
  c = await claim(2);
  check("the next claim of 2: the last pull row, then the oldest other row, in that order",
    same(c.ids, ids("p3", "o1")) && same(c.ran, ["pulls", "rest"]), `${labels(c.ids)}; ran ${c.ran.join(", ")}`);
  check("both under the claim's one token", c.got.length === 2 && c.got.every((r) => r.claim_token === c.token));
  check("each claimed row comes back as the worker reads it: id, table, forced columns, attempts, created and due times, token",
    c.got.every((r) => same(Object.keys(r).sort(), ["attempts", "claim_token", "created_at", "id", "next_run_at", "run_force", "table_id"])),
    JSON.stringify(Object.keys(c.got[0] ?? {})));
  await row("p4", "pull", -1);
  c = await claim(1);
  check("a pull row queued after every other row still goes first", same(c.ids, ids("p4")), labels(c.ids));
  const order = [];
  for (let i = 0; i < 4; i++) order.push(...(await claim(1)).ids);
  check("then the rest one at a time: oldest first across tables, a tie by id", same(order, ids("o2", "o3", "o3b", "o4")), labels(order));
  c = await claim(5);
  check("then nothing more: no other row is claimable, and both statements looked",
    c.ids.length === 0 && same(c.ran, ["pulls", "rest"]), `${labels(c.ids)}; ran ${c.ran.join(", ")}`);
  {
    const { db, ran } = recorded();
    const none = await claimRows(db, 0, { token: randomUUID(), retired: RETIRED });
    let refused = null;
    try {
      await claimRows(db, 2, { token: "", retired: RETIRED });
    } catch (e) {
      refused = e;
    }
    check("no free slot: nothing claimed and no statement sent; no token: refused before any statement",
      none.length === 0 && refused instanceof TypeError && ran.length === 0, `${none.length} claimed, ${refused}, ran ${ran.join(", ")}`);
  }

  section("B. What a claim leaves, and what it never takes");
  const taken = claims.flatMap((x) => x.got.map((r) => ({ id: String(r.id), token: x.token })));
  const state = await stateOf(taken.map((t) => label(t.id)));
  const byId = new Map(state.map((s) => [s.id, s]));
  const wrong = taken.filter((t) => {
    const s = byId.get(t.id);
    return !s || s.run_status !== "running" || s.claim_token !== t.token || s.attempts !== 1 || !s.claimed_at;
  });
  check(`every claimed row (${taken.length}) is running with its own claim's token, claimed now, its attempt counted`,
    taken.length === 9 && wrong.length === 0, `${taken.length} taken; wrong: ${labels(wrong.map((t) => t.id))}`);
  const never = ["paused pull row", "paused people row", "retired template row", "held row", "done row", "waiting row", "future pull row", "future people row"];
  const left = await stateOf(never);
  const moved = left.filter((s) => s.run_status !== made[label(s.id)].status || s.claim_token !== null || s.attempts !== 0 || s.claimed_at !== null);
  check("never claimed: a paused pull table's row, a paused table's row, a retired template's row, held, done and waiting rows, rows not due yet",
    left.length === never.length && moved.length === 0, labels(moved.map((s) => s.id)));
}

// ── C. Two claims at once ───────────────────────────────────────────────────

async function partC() {
  section("C. Two claims at once take different rows, and neither waits");
  await row("c1", "pull", -30);
  await row("c2", "pull 2", -29);
  await row("c3", "pull", -28);
  await row("d1", "people", -200);
  await row("d2", "companies", -199);
  await row("d3", "people", -198);
  const tokenX = randomUUID();
  const tokenY = randomUUID();
  const x = await pool.connect();
  let gotX = [];
  let gotY = [];
  let errY = null;
  let ms = 0;
  try {
    await x.query("BEGIN");
    gotX = await claimRows(x, 4, { token: tokenX, retired: RETIRED });
    // The first claim is not committed yet: its rows are locked, and the second claim must pass them by.
    const t0 = Date.now();
    try {
      gotY = await claimRows(pool, 2, { token: tokenY, retired: RETIRED });
    } catch (e) {
      errY = e;
    }
    ms = Date.now() - t0;
    await x.query("COMMIT");
  } catch (e) {
    await x.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    x.release();
  }
  const idsX = gotX.map((r) => String(r.id));
  const idsY = gotY.map((r) => String(r.id));
  check("the first claim of 4: the three pull rows, then the oldest other row", sameSet(idsX, ids("c1", "c2", "c3", "d1")), labels(idsX));
  check("a second claim of 2 meanwhile: passes every locked row by (pull rows and the other row) and takes the next two, without waiting",
    !errY && sameSet(idsY, ids("d2", "d3")) && ms < 5000, errY ? String(errY.message) : `${labels(idsY)} in ${ms} ms`);
  const s = await stateOf(["c1", "c2", "c3", "d1", "d2", "d3"]);
  const tokenOf = Object.fromEntries(s.map((r) => [label(r.id), r.claim_token]));
  check("each row is running under the token of the claim that took it",
    s.every((r) => r.run_status === "running") && ["c1", "c2", "c3", "d1"].every((k) => tokenOf[k] === tokenX) && ["d2", "d3"].every((k) => tokenOf[k] === tokenY),
    JSON.stringify(s.map((r) => [label(r.id), r.run_status])));
}

// ── D. Claiming the rest fails ──────────────────────────────────────────────

async function partD() {
  section("D. Claiming the rest fails");
  await row("e1", "pull", -20);
  await row("f1", "people", -190);
  const failing = {
    query: (sql, params) => (sql === CLAIM_SQL.rest ? Promise.reject(new Error("made-up failure")) : pool.query(sql, params)),
  };
  const logs = [];
  const token = randomUUID();
  const got = await claimRows(failing, 3, { token, retired: RETIRED, log: (m) => logs.push(m) });
  const [e1] = await stateOf(["e1"]);
  check("the pull row already claimed is handed back to be worked now, and the failure is logged once",
    same(got.map((r) => String(r.id)), ids("e1")) && e1.run_status === "running" && e1.claim_token === token &&
      logs.length === 1 && /made-up failure/.test(logs[0]) && /1 AI Ark pull row/.test(logs[0]),
    `${labels(got.map((r) => String(r.id)))}; ${JSON.stringify(logs)}`);
  let thrown = null;
  try {
    await claimRows(failing, 3, { token: randomUUID(), retired: RETIRED, log: (m) => logs.push(m) });
  } catch (e) {
    thrown = e;
  }
  const [f1] = await stateOf(["f1"]);
  check("with no pull row due, the same failure is thrown (nothing was claimed, nothing to hand back)",
    /made-up failure/.test(String(thrown?.message)) && logs.length === 1 && f1.run_status === "queued" && f1.claim_token === null && f1.attempts === 0,
    `${thrown}; ${JSON.stringify(f1)}`);
  const again = await claimRows(pool, 3, { token: randomUUID(), retired: RETIRED });
  check("the next claim takes the other row as usual", same(again.map((r) => String(r.id)), ids("f1")), labels(again.map((r) => String(r.id))));
}

// ── E. The plans ────────────────────────────────────────────────────────────

async function explain(sql, forced) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    // Only for this EXPLAIN: with sequential scans and sorts off, the planner reads the queue in the
    // index's order if the statement lets it at all.
    if (forced) await c.query("SET LOCAL enable_seqscan = off; SET LOCAL enable_sort = off");
    return (await c.query(`EXPLAIN ${sql}`, [randomUUID(), 6, RETIRED])).rows.map((r) => r["QUERY PLAN"]);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

async function partE() {
  section(`E. The plans (EXPLAIN only; nothing is claimed)`);
  for (const [name, sql] of Object.entries(CLAIM_SQL)) {
    const now = await explain(sql, false);
    const uses = now.some((l) => l.includes(QUEUE_INDEX));
    console.log(`  ${name}: as planned on this database now, reads ${QUEUE_INDEX}: ${uses ? "yes" : "no"}`);
    for (const l of now) console.log(`      ${l}`);
    const forced = await explain(sql, true);
    check(`${name}: can read the queue in ${QUEUE_INDEX}'s order (sequential scans and sorts off for that EXPLAIN)`,
      forced.some((l) => l.includes(QUEUE_INDEX)), forced.join(" | "));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query(`DELETE FROM enrich_tables WHERE client_tag = $1`, [TAG]);
}

const t0 = Date.now();
let clean = false;
try {
  await cleanup();
  const workers = await all(
    `SELECT id FROM enrich_worker_state WHERE last_seen > now() - interval '30 seconds' AND coalesce(info->>'stopped', 'false') <> 'true'`
  );
  check("before the run: no enrichment worker's heartbeat in the last 30 s (it would race these claims)", workers.length === 0, workers.map((w) => w.id).join(", "));
  const others = await all(
    `SELECT t.kind, count(*)::int AS n FROM enrich_rows q JOIN enrich_tables t ON t.id = q.table_id
      WHERE q.run_status = 'queued' AND q.next_run_at <= now() + interval '10 minutes' AND NOT t.is_paused
        AND (t.template IS NULL OR NOT (t.template = ANY($1::text[]))) AND t.client_tag <> $2
      GROUP BY 1 ORDER BY 1`,
    [RETIRED, TAG]
  );
  check("before the run: no row of another table is queued and due, or due within 10 minutes (a claim here would take it)",
    others.length === 0, others.map((o) => `${o.n} in ${o.kind} tables`).join(", "));
  if (workers.length || others.length) throw new Error("not run: a claim here would race the worker or take rows that are not this test's");
  base = (await one(`SELECT now()::text AS t`)).t;
  await partAB();
  await partC();
  await partD();
  await partE();
} catch (e) {
  failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  try {
    await cleanup();
    const left = await one(
      `SELECT (SELECT count(*)::int FROM enrich_tables WHERE client_tag = $1) AS tables,
              (SELECT count(*)::int FROM enrich_rows WHERE table_id = ANY($2::uuid[])) AS rows`,
      [TAG, Object.values(tables)]
    );
    clean = left.tables === 0 && left.rows === 0;
    console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify(left)}`}`);
  } catch (e) {
    console.error("cleanup failed:", e.message);
  }
  console.log(`${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(failed || !clean ? 1 : 0);
}
