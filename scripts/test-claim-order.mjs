#!/usr/bin/env node
// The enrichment worker's claim order (scripts/lib/enrich/claim.mjs): rows of
// AI Ark tab pulls (tables of kind 'ai_ark') are claimed before any other row,
// oldest first, then the email checks (General inboxes rows, kind 'inboxes'),
// then the rest, those two in fair turns between their tables. LOCAL DATABASE
// ONLY: made-up tables of the made-up client CLAIMTEST_A and their rows, all
// removed at the end, also when a check fails (and at the start, after a run
// that was killed).
//
//   node --env-file=.env.local scripts/test-claim-order.mjs
//
// Stop the enrichment worker first, and don't start it for this: a claim takes
// due rows of every table in the database, so the script refuses to run while
// a worker's heartbeat is fresh, or while a row of any other table is queued
// and due (or due within 10 minutes). No network, no key. F needs migration
// 142 applied to the local database.
//
//   A. the order: pull rows first even when every other row is older, then the
//      email checks even when the other rows are older, then the rest; a claim
//      of one row takes the oldest (a tie by id); a pull row queued later still
//      goes first; a part's statement runs only when the parts before it did
//      not fill the claim
//   B. claimed rows are running with their claim's token and an attempt
//      counted; rows of a paused table (a pull's and another), of a retired
//      template's table (companies_v1), held, finished and waiting rows, and
//      rows not due yet are never claimed
//   C. two claims at once take different rows, and neither waits for the other
//   D. claiming the rest fails: the pull rows already claimed are handed back
//      and the failure logged; with no pull row claimed, the failure is thrown
//   E. fair turns: a big older backlog in one table and a few newer rows in
//      others, among the email checks and among the rest. A claim of n takes
//      from every such table, each table's oldest rows first, and exactly what
//      the passes take (worked out here pass by pass: at most ceil(slots left /
//      tables) a table, slots still free round again); the tiers' order holds;
//      two claims at once take different rows without waiting; rows that are
//      never claimed still aren't
//   F. the plans (EXPLAIN only, never EXPLAIN ANALYZE): the pull rows'
//      statement can read the queue in enrich_rows_queue_idx's order; with the
//      statistics of a big backlog, the turns read each table's queue, and lock
//      their rows, on enrich_rows_table_queue_idx (migration 142); without that
//      index (dropped inside a transaction that is rolled back) a claim takes
//      the same rows

import pg from "pg";
import { randomUUID } from "node:crypto";
import { CLAIM_ORDER, CLAIM_SQL, claimRows, EMAIL_CHECK_KIND, PULL_KIND } from "./lib/enrich/claim.mjs";
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
const TABLE_QUEUE_INDEX = "enrich_rows_table_queue_idx";
/** What every claimed row comes back with: the worker reads these. */
const RETURNED = ["attempts", "claim_token", "created_at", "id", "next_run_at", "run_force", "table_id"];
/** Table key → id, for every made-up table. */
const tables = {};
/** Row label → id (text), for every made-up row. */
const rows = {};
/** Row label → what it was made as: its status, table key, due minutes and (E's claimable rows) part. */
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
  made[label] = { status, t, minutes };
}

const label = (id) => Object.keys(rows).find((k) => rows[k] === String(id)) ?? `unknown row ${id}`;
const labels = (ids) => ids.map(label).join(", ") || "nothing";
const ids = (...names) => names.map((n) => rows[n]);
const stateOf = async (names) =>
  all(`SELECT id::text AS id, run_status, claim_token, claimed_at, attempts FROM enrich_rows WHERE id = ANY($1::bigint[]) ORDER BY id`, [ids(...names)]);

/** The pool, noting which of the claim's statements ran. */
function recorded(db = pool) {
  const ran = [];
  const nameOf = (sql) => Object.keys(CLAIM_SQL).find((k) => CLAIM_SQL[k] === sql) ?? "other";
  return {
    ran,
    db: {
      query: (sql, params) => {
        ran.push(nameOf(sql));
        return db.query(sql, params);
      },
    },
  };
}

/** Every claim sections A and E make: its token and the rows it took. */
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
  section("A. Pull rows first, then the email checks, then the rest; a claim of one row takes the oldest");
  await table("pull", { kind: PULL_KIND });
  await table("pull 2", { kind: PULL_KIND });
  await table("pull paused", { kind: PULL_KIND, paused: true });
  // No template: one client holds one table per template (enrich_tables_template_uniq), and the order goes by kind alone.
  await table("inboxes", { kind: EMAIL_CHECK_KIND });
  await table("inboxes 2", { kind: EMAIL_CHECK_KIND });
  await table("inboxes paused", { kind: EMAIL_CHECK_KIND, paused: true });
  await table("people", { kind: "people" });
  await table("companies", { kind: "companies" });
  await table("people paused", { kind: "people", paused: true });
  await table("retired", { kind: "companies", template: RETIRED[0] });
  // Never claimed, though most are older than any row below.
  await row("paused pull row", "pull paused", -300);
  await row("paused inbox row", "inboxes paused", -295);
  await row("paused people row", "people paused", -290);
  await row("retired template row", "retired", -280);
  await row("held row", "people", -270, "held");
  await row("done row", "companies", -260, "done");
  await row("waiting row", "people", -250, "waiting");
  await row("future pull row", "pull", 60);
  await row("future inbox row", "inboxes", 60);
  await row("future people row", "people", 60);
  // Other rows, all older than every pull row; o3 and o3b are due at the same moment.
  await row("o1", "people", -240);
  await row("o2", "companies", -230);
  await row("o3", "people", -220);
  await row("o3b", "companies", -220);
  await row("o4", "people", -210);
  // Email checks, in two General inboxes tables: one older than every other row, two newer.
  await row("i1", "inboxes", -245);
  await row("i2", "inboxes 2", -100);
  await row("i3", "inboxes", -10);
  // Pull rows, in two pull tables.
  await row("p1", "pull", -60);
  await row("p2", "pull 2", -50);
  await row("p3", "pull", -40);

  let c = await claim(2);
  check("a claim of 2: the two oldest pull rows, though four other rows waited longer; they filled it, so the rest's statement never ran",
    sameSet(c.ids, ids("p1", "p2")) && same(c.ran, ["pulls"]), `${labels(c.ids)}; ran ${c.ran.join(", ")}`);
  c = await claim(2);
  check("the next claim of 2: the last pull row, then the oldest email check; they filled it, so the rest's statement never ran",
    same(c.ids, ids("p3", "i1")) && same(c.ran, ["pulls", "inboxes"]), `${labels(c.ids)}; ran ${c.ran.join(", ")}`);
  check("both under the claim's one token", c.got.length === 2 && c.got.every((r) => r.claim_token === c.token));
  check("each claimed row comes back as the worker reads it: id, table, forced columns, attempts, created and due times, token",
    c.got.every((r) => same(Object.keys(r).sort(), RETURNED)), JSON.stringify(Object.keys(c.got[0] ?? {})));
  await row("p4", "pull", -1);
  c = await claim(1);
  check("a pull row queued after every other row still goes first", same(c.ids, ids("p4")), labels(c.ids));
  const order = [];
  for (let i = 0; i < 7; i++) order.push(...(await claim(1)).ids);
  check("then one at a time: the email checks oldest first across tables though every other row waited longer, then the rest oldest first, a tie by id (a turn of one row: the oldest of the tables' oldest)",
    same(order, ids("i2", "i3", "o1", "o2", "o3", "o3b", "o4")), labels(order));
  await row("i4", "inboxes 2", -1);
  await row("o5", "people", -300);
  c = await claim(2);
  check("an email check queued after an older other row still goes before it", same(c.ids, ids("i4", "o5")) && same(c.ran, ["pulls", "inboxes", "rest"]),
    `${labels(c.ids)}; ran ${c.ran.join(", ")}`);
  c = await claim(5);
  check("then nothing more: no other row is claimable, and all three statements looked",
    c.ids.length === 0 && same(c.ran, ["pulls", "inboxes", "rest"]), `${labels(c.ids)}; ran ${c.ran.join(", ")}`);
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
    taken.length === 14 && wrong.length === 0, `${taken.length} taken; wrong: ${labels(wrong.map((t) => t.id))}`);
  const never = ["paused pull row", "paused inbox row", "paused people row", "retired template row", "held row", "done row", "waiting row", "future pull row", "future inbox row", "future people row"];
  const left = await stateOf(never);
  const moved = left.filter((s) => s.run_status !== made[label(s.id)].status || s.claim_token !== null || s.attempts !== 0 || s.claimed_at !== null);
  check("never claimed: a paused pull table's row, a paused General inboxes table's row, a paused table's row, a retired template's row, held, done and waiting rows, rows not due yet",
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
      logs.length === 1 && /made-up failure/.test(logs[0]) && /claiming rows of other tables/.test(logs[0]) && /1 row\(s\) already claimed/.test(logs[0]),
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

// ── E. Fair turns ───────────────────────────────────────────────────────────

/** E's rows that a claim may take now, by label (each made by dueRow), until a claim takes them. */
const pending = new Set();
/** A due queued row of E, claimable in `part` (pulls, inboxes or rest, by its table's kind). */
async function dueRow(lbl, t, minutes, part) {
  await row(lbl, t, minutes);
  made[lbl].part = part;
  pending.add(lbl);
}
/** The claim's age order: due time, then id. */
const older = (a, b) => made[a].minutes - made[b].minutes || Number(rows[a]) - Number(rows[b]);

/**
 * What a claim of n takes of the pending rows, worked out as the fair turns
 * are worded, pass by pass: the pull rows oldest first; then the email checks,
 * then the rest, each so: every table with due rows left offers up to
 * max(1, ceil(slots left / those tables)) of its oldest; when that is more rows
 * than slots, earlier turns go first, then older rows; slots still free go
 * round again.
 */
function passes(n) {
  const of = (part) => [...pending].filter((l) => made[l].part === part).sort(older);
  const out = of("pulls").slice(0, n);
  for (const part of ["inboxes", "rest"]) {
    const queues = new Map();
    for (const l of of(part)) queues.set(made[l].t, [...(queues.get(made[l].t) ?? []), l]);
    const taken = new Map([...queues.keys()].map((t) => [t, 0]));
    for (;;) {
      const left = n - out.length;
      const open = [...queues.keys()].filter((t) => taken.get(t) < queues.get(t).length);
      if (left <= 0 || !open.length) break;
      const quota = Math.max(1, Math.ceil(left / open.length));
      const offered = open.flatMap((t) => queues.get(t).slice(taken.get(t), taken.get(t) + quota).map((l, i) => ({ l, t, turn: taken.get(t) + i })));
      offered.sort((a, b) => a.turn - b.turn || older(a.l, b.l));
      for (const o of offered.slice(0, left)) {
        out.push(o.l);
        taken.set(o.t, taken.get(o.t) + 1);
      }
    }
  }
  return out;
}

/** Whether a claim's rows come in the parts' order (pull rows, the email checks, the rest), as claimRows hands them back. */
const partsInOrder = (ls) => ls.every((l, i) => i === 0 || CLAIM_ORDER.indexOf(made[ls[i - 1]]?.part) <= CLAIM_ORDER.indexOf(made[l]?.part));

/** Whether every table gave the claim its oldest pending rows: inside a table, oldest first. */
function oldestOfEachTable(ls, before) {
  const byTable = new Map();
  for (const l of ls) byTable.set(made[l]?.t, [...(byTable.get(made[l]?.t) ?? []), l]);
  return [...byTable].every(([t, got]) => sameSet(got, [...before].filter((l) => made[l].t === t).sort(older).slice(0, got.length)));
}

/** Records what a claim took (labels), so the pending rows and the passes follow it. */
function took(ls) {
  for (const l of ls) pending.delete(l);
}

/** A claim of n in E, checked against the passes: its labels, what the passes take, the statements that ran. */
async function fairClaim(n) {
  const want = passes(n);
  const before = new Set(pending);
  const c = await claim(n);
  const got = c.ids.map(label);
  took(got);
  const ok = sameSet(got, want) && partsInOrder(got) && oldestOfEachTable(got, before);
  return { ...c, labels: got, want, ok, why: `took ${got.join(", ") || "nothing"}; the passes take ${want.join(", ") || "nothing"}; ran ${c.ran.join(", ")}` };
}
const range = (prefix, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

async function partE() {
  section("E. Fair turns: every table with due rows gets its share of the slots, each its oldest rows first");
  await table("fair pull", { kind: PULL_KIND });
  await table("fair inboxes big", { kind: EMAIL_CHECK_KIND });
  await table("fair inboxes small", { kind: EMAIL_CHECK_KIND });
  await table("fair companies big", { kind: "companies" });
  await table("fair companies mid", { kind: "companies" });
  await table("fair people small", { kind: "people" });
  // Nothing of A-D is due now. Never claimed, though older than every row below: rows of these tables, and of A's
  // paused and retired tables.
  await row("fair held inbox row", "fair inboxes big", -1000, "held");
  await row("fair waiting inbox row", "fair inboxes big", -999, "waiting");
  await row("fair held company row", "fair companies big", -998, "held");
  await row("fair error company row", "fair companies big", -997, "error");
  await row("fair done company row", "fair companies big", -996, "done");
  await row("fair paused pull row", "pull paused", -995);
  await row("fair paused inbox row", "inboxes paused", -994);
  await row("fair paused people row", "people paused", -993);
  await row("fair retired row", "retired", -992);
  await row("fair future inbox row", "fair inboxes big", 60);
  await row("fair future company row", "fair companies big", 60);
  // The backlogs, each older than the tier before it: 30 company rows (the oldest), 8 email checks, then
  // a few newer rows in other tables, and two pull rows (the newest of all).
  for (let i = 1; i <= 30; i++) await dueRow(`cb${i}`, "fair companies big", -901 + i, "rest");
  for (let i = 1; i <= 8; i++) await dueRow(`ib${i}`, "fair inboxes big", -601 + i, "inboxes");
  for (let i = 1; i <= 4; i++) await dueRow(`cm${i}`, "fair companies mid", -301 + i, "rest");
  for (let i = 1; i <= 3; i++) await dueRow(`is${i}`, "fair inboxes small", -31 + i, "inboxes");
  for (let i = 1; i <= 3; i++) await dueRow(`ps${i}`, "fair people small", -26 + i, "rest");
  await dueRow("fp1", "fair pull", -5, "pulls");
  await dueRow("fp2", "fair pull", -4, "pulls");
  const start = claims.length;

  let c = await fairClaim(4);
  check("a claim of 4: the two pull rows first, though they are the newest rows, then one email check from each General inboxes table, " +
    "the small table's too, though the big one's whole backlog is older; filled, so the rest's statement never ran",
    sameSet(c.labels, ["fp1", "fp2", "ib1", "is1"]) && same(c.ran, ["pulls", "inboxes"]) && c.ok, c.why);
  c = await fairClaim(6);
  check("a claim of 6 between the two General inboxes tables: three each, but the small one has two left, so its slot goes round again " +
    "to the big one (oldest first across tables, all six were the big backlog's)",
    sameSet(c.labels, ["ib2", "ib3", "ib4", "ib5", "is2", "is3"]) && same(c.ran, ["pulls", "inboxes"]) && c.ok, c.why);
  c = await fairClaim(6);
  check("a claim of 6: the big table's last three email checks go before every other row, though the company backlog is older " +
    "(the tiers' order holds), then one row from each of the three other tables",
    sameSet(c.labels, ["ib6", "ib7", "ib8", "cb1", "cm1", "ps1"]) && same(c.ran, ["pulls", "inboxes", "rest"]) && c.ok, c.why);
  check("rows of the turns come back as the worker reads them, as the pull rows' do",
    c.got.length === 6 && c.got.every((r) => same(Object.keys(r).sort(), RETURNED) && r.claim_token === c.token), JSON.stringify(Object.keys(c.got[0] ?? {})));
  c = await fairClaim(4);
  check("a claim of 4 over three tables: at most ceil(4/3) = 2 a table, every table's next row first, then the oldest second one",
    sameSet(c.labels, ["cb2", "cb3", "cm2", "ps2"]) && c.ok, c.why);
  c = await fairClaim(7);
  check("a claim of 7: three a table; the two smaller tables' last rows, and the slot they leave goes round again to the big one",
    sameSet(c.labels, ["cb4", "cb5", "cb6", "cb7", "cm3", "cm4", "ps3"]) && c.ok, c.why);

  // Two claims at once: the first is not committed yet, so its rows are locked and look queued to the second.
  await dueRow("is4", "fair inboxes small", -9, "inboxes");
  await dueRow("is5", "fair inboxes small", -8, "inboxes");
  await dueRow("ps4", "fair people small", -7, "rest");
  await dueRow("ps5", "fair people small", -6, "rest");
  await dueRow("ps6", "fair people small", -5, "rest");
  const wantX = passes(4);
  const tokenX = randomUUID();
  const tokenY = randomUUID();
  const x = await pool.connect();
  let gotX = [];
  let gotY = [];
  let errY = null;
  let ms = 0;
  try {
    await x.query("BEGIN");
    gotX = (await claimRows(x, 4, { token: tokenX, retired: RETIRED })).map((r) => label(r.id));
    const t0 = Date.now();
    try {
      gotY = (await claimRows(pool, 4, { token: tokenY, retired: RETIRED })).map((r) => label(r.id));
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
  took([...gotX, ...gotY]);
  check("the first of two claims at once, of 4: the two new email checks, then a row from each other table with due rows, as the passes take",
    sameSet(gotX, ["is4", "is5", "cb8", "ps4"]) && sameSet(gotX, wantX), `took ${gotX.join(", ")}; the passes take ${wantX.join(", ")}`);
  check("a second claim of 4 meanwhile: passes by every row the first holds (both email checks held, so their slots go to the rest) " +
    "and takes each table's next rows, without waiting",
    !errY && sameSet(gotY, ["cb9", "cb10", "ps5", "ps6"]) && ms < 5000, errY ? String(errY.message) : `${gotY.join(", ")} in ${ms} ms`);
  const sXY = await stateOf([...gotX, ...gotY]);
  const tokenOf = Object.fromEntries(sXY.map((r) => [label(r.id), r.claim_token]));
  check("each of those rows is running under the token of the claim that took it",
    sXY.length === 8 && sXY.every((r) => r.run_status === "running") && gotX.every((k) => tokenOf[k] === tokenX) && gotY.every((k) => tokenOf[k] === tokenY),
    JSON.stringify(sXY.map((r) => [label(r.id), r.run_status])));

  c = await fairClaim(100);
  check("a claim of 100: every row left, the rest of the company backlog, and nothing else", sameSet(c.labels, range("cb", 11, 30)) && c.ok, c.why);
  c = await fairClaim(5);
  check("then nothing more: no row of E is claimable, and all three statements looked", c.labels.length === 0 && same(c.ran, [...CLAIM_ORDER]), c.why);

  const taken = [
    ...claims.slice(start).flatMap((y) => y.got.map((r) => ({ id: String(r.id), token: y.token }))),
    ...gotX.map((l) => ({ id: rows[l], token: tokenX })),
    ...gotY.map((l) => ({ id: rows[l], token: tokenY })),
  ];
  const state = new Map((await stateOf(taken.map((t) => label(t.id)))).map((s) => [s.id, s]));
  const wrong = taken.filter((t) => {
    const s = state.get(t.id);
    return !s || s.run_status !== "running" || s.claim_token !== t.token || s.attempts !== 1 || !s.claimed_at;
  });
  check(`each of E's ${Object.values(made).filter((m) => m.part).length} due rows was claimed once (${taken.length} taken), and is running with its own claim's token, its attempt counted once`,
    taken.length === 55 && new Set(taken.map((t) => t.id)).size === 55 && wrong.length === 0 && pending.size === 0,
    `${taken.length} taken; wrong: ${labels(wrong.map((t) => t.id))}; still pending: ${[...pending].join(", ")}`);
  const never = ["fair held inbox row", "fair waiting inbox row", "fair held company row", "fair error company row", "fair done company row",
    "fair paused pull row", "fair paused inbox row", "fair paused people row", "fair retired row", "fair future inbox row", "fair future company row",
    "paused pull row", "paused inbox row", "paused people row", "retired template row", "held row", "done row", "waiting row",
    "future pull row", "future inbox row", "future people row"];
  const left = await stateOf(never);
  const moved = left.filter((s) => s.run_status !== made[label(s.id)].status || s.claim_token !== null || s.attempts !== 0 || s.claimed_at !== null);
  check("still never claimed: rows of paused tables (a pull's, a General inboxes table's, another), of the retired template's table, held, waiting, " +
    "failed, finished and not yet due rows, E's older than every row the turns took",
    left.length === never.length && moved.length === 0, labels(moved.map((s) => s.id)));
}

// ── F. The plans ────────────────────────────────────────────────────────────

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

/** Rows in the big table of withBacklog; each of its six small tables holds 5. */
const BACKLOG = 10_000;

/**
 * Runs fn(client) inside a transaction that is rolled back, over a made-up
 * backlog of tables of `kind`: one of BACKLOG rows due for hours and six of 5
 * rows due for minutes, with the tables' statistics taken (ANALYZE inside the
 * transaction), as production's are by autovacuum. dropIndex: the turns'
 * index is dropped first, inside the same transaction.
 */
async function withBacklog(kind, fn, { dropIndex = false } = {}) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    if (dropIndex) {
      // An ACCESS EXCLUSIVE lock until the rollback: given up at once rather than queued behind another session.
      await c.query("SET LOCAL lock_timeout = '2s'");
      await c.query(`DROP INDEX ${TABLE_QUEUE_INDEX}`);
    }
    const make = async (name) =>
      (await c.query(`INSERT INTO enrich_tables (client_tag, kind, name, source_note) VALUES ($1, $2, $3, 'test-claim-order: made up') RETURNING id`,
        [TAG, kind, `Claim test plan ${name}`])).rows[0].id;
    const add = (t, n, prefix, from) =>
      c.query(`INSERT INTO enrich_rows (table_id, row_key, run_status, next_run_at)
               SELECT $1, $2 || g, 'queued', now() - make_interval(mins => $3) + make_interval(secs => g) FROM generate_series(1, $4::int) g`,
        [t, `claimtest:plan ${prefix} `, from, n]);
    await add(await make("big"), BACKLOG, "big", 600);
    for (let i = 1; i <= 6; i++) await add(await make(`small ${i}`), 5, `small ${i}`, 10);
    await c.query("ANALYZE enrich_rows");
    await c.query("ANALYZE enrich_tables");
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

/** The plan of `sql` on c, and a claim of 12 on c: the row keys it took (sorted) and how long it took. */
async function planAndClaim(c, sql) {
  const plan = (await c.query(`EXPLAIN ${sql}`, [randomUUID(), 12, RETIRED])).rows.map((r) => r["QUERY PLAN"]);
  const t0 = Date.now();
  const got = await claimRows(c, 12, { token: randomUUID(), retired: RETIRED });
  const ms = Date.now() - t0;
  const keys = (await c.query(`SELECT row_key FROM enrich_rows WHERE id = ANY($1::bigint[]) ORDER BY row_key`, [got.map((r) => r.id)])).rows.map((r) => r.row_key);
  return { plan, keys, ms };
}

/** The plan's reads of the queue (enrich_rows as q, q_1 …: each table's oldest rows, the locked pick) and the read under its LockRows. */
function queueReads(plan) {
  const reads = plan.filter((l) => /Scan\b.* on enrich_rows q(_\d+)?\b/.test(l));
  const lock = plan.findIndex((l) => l.includes("LockRows"));
  return { reads, locked: lock < 0 ? null : plan.slice(lock + 1).find((l) => /Scan\b.* on enrich_rows\b/.test(l)) ?? null };
}

async function partF() {
  section(`F. The plans (EXPLAIN only, never EXPLAIN ANALYZE; the claims here are rolled back)`);
  {
    const now = await explain(CLAIM_SQL.pulls, false);
    console.log(`  pulls: as planned on this database now, reads ${QUEUE_INDEX}: ${now.some((l) => l.includes(QUEUE_INDEX)) ? "yes" : "no"}`);
    for (const l of now) console.log(`      ${l}`);
    const forced = await explain(CLAIM_SQL.pulls, true);
    check(`pulls: can read the queue in ${QUEUE_INDEX}'s order (sequential scans and sorts off for that EXPLAIN)`,
      forced.some((l) => l.includes(QUEUE_INDEX)), forced.join(" | "));
  }
  const idx = await one(
    `SELECT i.indisvalid AND i.indisready AS ok, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = to_regclass($1)`,
    [`public.${TABLE_QUEUE_INDEX}`]
  );
  check(`migration 142 is applied here: ${TABLE_QUEUE_INDEX} is valid, on the queued rows by table_id, next_run_at, id`,
    Boolean(idx?.ok) && /\(table_id, next_run_at, id\) WHERE \(run_status = 'queued'::text\)/.test(idx?.def ?? ""),
    idx ? idx.def : "missing: psql -f supabase/migrations/142_enrich_rows_table_queue_idx.sql on the local database");
  if (!idx?.ok) return;
  for (const [name, kind] of [["inboxes", EMAIL_CHECK_KIND], ["rest", "companies"]]) {
    const withIt = await withBacklog(kind, (c) => planAndClaim(c, CLAIM_SQL[name]));
    const { reads, locked } = queueReads(withIt.plan);
    console.log(`  ${name}: as planned over a backlog of ${BACKLOG.toLocaleString("en-US")} rows in one table and 5 in each of six others:`);
    for (const l of withIt.plan) console.log(`      ${l}`);
    check(`${name}: each table's oldest due rows are read on ${TABLE_QUEUE_INDEX}, and so are the rows its turn locks`,
      reads.length >= 2 && reads.every((l) => l.includes(TABLE_QUEUE_INDEX)) && Boolean(locked?.includes(TABLE_QUEUE_INDEX)), `${reads.join(" | ")}; locked: ${locked}`);
    const without = await withBacklog(kind, (c) => planAndClaim(c, CLAIM_SQL[name]), { dropIndex: true });
    console.log(`  ${name}: without ${TABLE_QUEUE_INDEX}:`);
    for (const l of without.plan) console.log(`      ${l}`);
    console.log(`  ${name}: a claim of 12 took ${withIt.ms} ms with the index, ${without.ms} ms without`);
    const big = withIt.keys.filter((k) => k.startsWith("claimtest:plan big ")).length;
    check(`${name}: a claim of 12 over those seven tables: 2 of the backlog, the rest the six others', each table's oldest; without the index the very same rows`,
      withIt.keys.length === 12 && big === 2 && new Set(withIt.keys.map((k) => k.replace(/ \d+$/, ""))).size === 7 && same(withIt.keys, without.keys) &&
        !without.plan.some((l) => l.includes(TABLE_QUEUE_INDEX)),
      `with: ${withIt.keys.join(", ")}; without: ${without.keys.join(", ")}`);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function cleanup() {
  await pool.query(`DELETE FROM enrich_tables WHERE client_tag = $1`, [TAG]);
}

const t0 = Date.now();
let clean = false;
let analyzed = false;
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
  analyzed = true;
  await partF();
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
    // F's statistics were rolled back, but ANALYZE keeps a table's page and row counts whatever happens to its
    // transaction: taken again here, they describe the tables as they are.
    if (analyzed) await pool.query("ANALYZE enrich_rows; ANALYZE enrich_tables");
  } catch (e) {
    console.error("cleanup failed:", e.message);
  }
  console.log(`${passed} passed, ${failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(failed || !clean ? 1 : 0);
}
