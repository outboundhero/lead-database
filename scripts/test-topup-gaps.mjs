#!/usr/bin/env node
// Two follow-ups to the weekly top-up (migration 135): "free first" (plan
// 2.4), the leads already in the database that a place fix would count for a
// client's low cities, and the AI Ark runs started by hand for clients that
// cannot receive (plan 2.7). LOCAL DATABASE ONLY. Made-up clients GTTEST_A to
// GTTEST_F, made-up leads under .gttest.example, made-up users, a made-up
// stand-in filter. Nothing here works an AI Ark run: the runs are rows with
// made-up values that are never due. No network. The weekly_topup and
// never_contact_inboxes settings are put back at the end and everything else
// the run made is removed. No other test's rows are touched.
//
//   node --env-file=.env.local scripts/test-topup-gaps.mjs
//
// Do not start the topup-worker or the enrich-worker for this: the pass runs
// here as exported.
//
//   F0. the counter on a stand-in database: the city list, keys, known states; readFreeFirst
//   F1. one pass: a client's partial and unresolved leads, no entry for the others, the total
//   F2. the General inboxes filter
//   F4. one statement per state and one map per firing; a pass carried on
//   F3. the done pass keeps free_first next to the other counts and failed_tries
//   F5. a count that fails reads null, and the pass goes on
//   F6. a client rerun with no low city loses its entry
//   H1. hand runs of clients that cannot receive, and the route
//   H2. read only, and the hourly cancel never touches them
//   F8. GET /api/topup: free first as stored, a pass from before it, the links
//   F7. the plans: the counts read leads through their indexes
//   Z.  everything removed

import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checker, dropPaidKeys, installNet, localDatabaseUrl, routeLoader } from "./fixtures/test-support.mjs";
import { coverageSettings } from "./lib/coverage.mjs";
import { entryKey, loadGeo } from "./lib/aiark/geo.mjs";
import {
  FREE_FIRST_CITIES, freeFirstCounter, partialCountSql, readFreeFirst, storeUnresolvedTotal, UNRESOLVED_KEY_SQL, UNRESOLVED_TOTAL_SQL,
  unresolvedMapSql,
} from "./lib/topup/free-first.mjs";
import { handRunsBlocked } from "./lib/topup/hand-runs.mjs";
import { flagClient, passClients, runPass } from "./lib/topup/pass.mjs";
import { readTopupSettings } from "./lib/topup/pulls.mjs";
import { cancelBlockedRuns } from "./lib/topup/run.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 8 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const source = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
// jsonb keeps object keys in its own order: compare objects by key, lists in order.
const canon = (v) =>
  Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const same = (a, b) => JSON.stringify(canon(a) ?? null) === JSON.stringify(canon(b) ?? null);

const PREFIX = "GTTEST_";
const T = (s) => `${PREFIX}${s}`;
const A = T("A"); // Cleaning, Active: low cities Peoria IL, Springfield IL, Gary IN, and WI state-wide
const B = T("B"); // Cleaning, Active: only a state-wide low place (IL)
const C = T("C"); // Cleaning, Active: every place has enough (Springfield IL)
const D = T("D"); // Cleaning, Active: low cities Peoria IL, Peoria IN (one key, two states), Austin TX
const E = T("E"); // Cleaning, Paused: never visited by a pass; hand runs
const F = T("F"); // Cleaning, Active, not on the Groups tab: a low Peoria IL; a hand run
const RUN = randomUUID().slice(0, 6);
const HOST = "gttest.example";
const USERS_AT = `users.${HOST}`;
const USER = randomUUID(); // "Gaps tester"
const USER2 = randomUUID(); // a blank full name: shown by email
const USER2_EMAIL = `gttest-blank-${RUN}@${USERS_AT}`;
const FILTER = "gttest-box@|gttest-dept";
const passIds = new Set();
const logs = [];
const log = (m) => logs.push(m);
const CITY = {};
const PLACE = (city, state) => (city ? { city, state, country: "US" } : { state, country: "US" });
let settingsBefore = null;
let geo = null;
let analyzed = false;

async function setSetting(key, over) {
  await pool.query(`UPDATE enrich_settings SET value = value || $2::jsonb WHERE key = $1`, [key, JSON.stringify(over)]);
}
const TOPUP_ON = {
  enabled: true, client_types: ["Cleaning", "Canada Cleaning"], default_minimum: 5, pull_mode: "off", pull_tags: [],
  weekly_credits: 25000, client_weekly_credits: 25000, max_pull_size: 1000, pulls_per_day: 3,
};
const setFilter = (pattern) =>
  setSetting("never_contact_inboxes", pattern
    ? { enabled: false, pattern, sha256: sha(pattern), source: "gttest stand-in", read_at: new Date().toISOString() }
    : { enabled: false, pattern: null, sha256: null, source: null, read_at: null });

async function addClient(tag, { status = "Active", places = undefined, min = null, onTab = true } = {}) {
  await pool.query(
    `INSERT INTO client_tags (tag, name, client_type, status, group_no, on_groups_tab, churn_cell_state, churn_date, churn_cell, groups_tab_read_at)
     VALUES ($1, $2, 'Cleaning', $3, 1, $4, 'empty', NULL, NULL, now())`,
    [tag, `Gaps test ${tag.slice(PREFIX.length)}`, status, onTab]
  );
  if (places !== undefined) {
    await pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, min_leads_per_place, updated_at)
       VALUES ($1, '{US}', $2::jsonb, '[]'::jsonb, '{}', false, $3, now() - interval '1 hour')`,
      [tag, JSON.stringify(places), min]
    );
  }
}
const RULES = {
  [A]: [PLACE("Peoria", "IL"), PLACE("Springfield", "IL"), PLACE("Gary", "IN"), PLACE(null, "WI")],
  [B]: [PLACE(null, "IL")],
  [C]: [PLACE("Springfield", "IL")],
  [D]: [PLACE("Peoria", "IL"), PLACE("Peoria", "IN"), PLACE("Austin", "TX")],
  [E]: [PLACE("Peoria", "IL")],
  [F]: [PLACE("Peoria", "IL")],
};
// The low cities each client gets (label, state, key), for the numbers it should have.
const LOW_CITIES = {
  [A]: [["Peoria, IL", "IL", "peoria"], ["Springfield, IL", "IL", "springfield"], ["Gary, IN", "IN", "gary"]],
  [D]: [["Peoria, IL", "IL", "peoria"], ["Peoria, IN", "IN", "peoria"], ["Austin, TX", "TX", "austin"]],
  [F]: [["Peoria, IL", "IL", "peoria"]],
};

const STATE_NAME = { IL: "Illinois", IN: "Indiana", TX: "Texas", WI: "Wisconsin" };
let leadSeq = 0;
async function addLead({ local = "owner", email = undefined, type = "personal", status, state = null, city = null, locationId = null,
  bounced = false, suppressed = false, validation = "valid", raw = {} }) {
  leadSeq++;
  await pool.query(
    `INSERT INTO leads (email, email_type, company, country_code, state_code, state, country, city, location_id, location_status,
                        is_bounced, is_suppressed, validation_status, raw_data)
     VALUES ($1, $2, 'gttest lead', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)`,
    [
      email ?? `${local}@l${leadSeq}-${RUN}.${HOST}`, type, state ? "US" : null, state, state ? STATE_NAME[state] : null, state ? "USA" : null,
      city, locationId, status, bounced, suppressed, validation, JSON.stringify({ gttest: RUN, ...raw }),
    ]
  );
}

/** The counts as the pass's own statements give them now, for a baseline before the seeds. */
async function freeNow(pattern) {
  const f = Boolean(pattern);
  const st = {};
  for (const s of ["IL", "IN", "TX", "WI"]) st[s] = (await one(partialCountSql(f), f ? ["US", s, pattern] : ["US", s])).n;
  const keys = Object.fromEntries((await all(unresolvedMapSql(f), f ? [pattern] : [])).map((r) => [r.key, r.n]));
  return { st, keys };
}
const plus = (base, add) => ({
  st: Object.fromEntries(Object.keys(base.st).map((s) => [s, base.st[s] + (add.st[s] ?? 0)])),
  keys: Object.fromEntries([...new Set([...Object.keys(base.keys), ...Object.keys(add.keys)])].map((k) => [k, (base.keys[k] ?? 0) + (add.keys[k] ?? 0)])),
});
/** A client's numbers by the definition: its low cities' states and distinct keys. */
function expectedFor(tag, n) {
  const cities = LOW_CITIES[tag];
  const states = [...new Set(cities.map((c) => `US|${c[1]}`))]
    .map((key) => ({ key, partial: n.st[key.split("|")[1]] }))
    .sort((a, b) => b.partial - a.partial || a.key.localeCompare(b.key));
  return {
    partial: states.reduce((s, x) => s + x.partial, 0),
    unresolved: [...new Set(cities.map((c) => c[2]))].reduce((s, k) => s + (n.keys[k] ?? 0), 0),
    states,
    cities: cities
      .map((c) => ({ label: c[0], unresolved: n.keys[c[2]] ?? 0 }))
      .filter((c) => c.unresolved > 0)
      .sort((a, b) => b.unresolved - a.unresolved || a.label.localeCompare(b.label))
      .slice(0, FREE_FIRST_CITIES),
  };
}

/** A pass asked for now (as Run now does) and worked to the end, for the test's clients. */
async function newPass(db = pool) {
  const { rows: [p] } = await pool.query(`INSERT INTO topup_passes (state, trigger, requested_by) VALUES ('requested', 'manual', $1) RETURNING id`, [USER]);
  passIds.add(p.id);
  const settings = await readTopupSettings(pool);
  return runPass(db, { settings, geo, tagPrefix: PREFIX, log });
}
const flagsOf = (passId, tag) =>
  all(
    `SELECT kind, place_key, label, available, minimum, resolved, receive_block, action FROM topup_flags
      WHERE pass_id = $1 AND client_tag = $2 ORDER BY kind, place_key`,
    [passId, tag]
  );
const countsOf = async (passId) => (await one(`SELECT counts FROM topup_passes WHERE id = $1`, [passId])).counts;

/** The pool, with every statement shown to `onSql` first (which may throw to make it fail). */
function watchedPool(base, onSql) {
  const watch = (target) => async (sql, params) => {
    onSql(typeof sql === "string" ? sql : sql?.text ?? "", params ?? []);
    return target.query(sql, params);
  };
  return {
    query: watch(base),
    connect: async () => {
      const c = await base.connect();
      return { query: watch(c), release: (...a) => c.release(...a) };
    },
  };
}

/** A stand-in database for the counter alone: `answer(sql, params)` gives the rows. */
function standIn(answer) {
  const seen = [];
  const q = async (sql, params) => {
    seen.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(sql)) return { rows: [] };
    return { rows: (await answer(sql, params)) ?? [] };
  };
  return { seen, query: q, connect: async () => ({ query: q, release() {} }) };
}

async function cleanup() {
  const users = (await all(`SELECT id FROM auth.users WHERE email LIKE $1`, [`gttest-%@${USERS_AT}`])).map((r) => r.id);
  const runs = (await all(`SELECT id FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  if (runs.length) {
    await pool.query(`DELETE FROM upload_batches WHERE aiark_run_id = ANY($1::uuid[])`, [runs]);
    await pool.query(`DELETE FROM aiark_people WHERE run_id = ANY($1::uuid[])`, [runs]);
  }
  await pool.query(`DELETE FROM topup_pulls WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  const flagged = (await all(`SELECT DISTINCT pass_id FROM topup_flags WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.pass_id);
  await pool.query(`DELETE FROM topup_passes WHERE id = ANY($1::uuid[]) OR requested_by = ANY($2::uuid[])`, [[...passIds, ...flagged], users]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1 OR (email = '' AND raw_data ? 'gttest')`, [`%.${HOST}`]);
  for (const t of ["client_location_coverage", "client_targeting", "client_people_filters"]) {
    await pool.query(`DELETE FROM ${t} WHERE starts_with(client_tag, $1)`, [PREFIX]);
  }
  await pool.query(`DELETE FROM client_stats WHERE starts_with(tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, $1)`, [PREFIX]);
  if (users.length) {
    await pool.query(`DELETE FROM user_profiles WHERE id = ANY($1::uuid[])`, [users]);
    await pool.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [users]);
  }
}

// ── F0. The counter on a stand-in database ──────────────────────────────────

async function partF0() {
  section("F0. The counter on a stand-in database, and what the route reads back");
  // Twelve low cities in IL with 1 to 12 unresolved leads each, one city whose
  // name has no letters, and leads with no place text at all (key "").
  const names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];
  const map = [...names.map((n, i) => ({ key: entryKey(n), n: i + 1 })), { key: "", n: 99 }];
  let failState = null;
  const db = standIn((sql, params) => {
    if (sql === partialCountSql(false)) {
      if (`${params[0]}|${params[1]}` === failState) throw new Error("made-up failure");
      return [{ n: params[1] === "IL" ? 7 : 2 }];
    }
    if (sql === unresolvedMapSql(false)) return map;
    return [];
  });
  const low = [...names.map((n) => ({ kind: "low", label: `${n}, IL`, place: { country: "US", state: "IL", city: n } })),
    { kind: "low", label: "123, IL", place: { country: "us", state: "il", city: "123" } }];
  const counter = freeFirstCounter(db, { passId: null, pattern: null });
  const got = await counter.forClient(low);
  check(`the city list is capped at ${FREE_FIRST_CITIES}, most first`,
    got.cities.length === FREE_FIRST_CITIES && got.cities[0].label === "Lima, IL" && got.cities[0].unresolved === 12 &&
      got.cities.every((c, i) => i === 0 || got.cities[i - 1].unresolved >= c.unresolved), JSON.stringify(got.cities));
  check("unresolved sums every city (not only the listed ones); a city with no letters names nothing", got.unresolved === 78, String(got.unresolved));
  check("one state, counted once, codes read in upper case", same(got.states, [{ key: "US|IL", partial: 7 }]) && got.partial === 7, JSON.stringify(got.states));
  const statements = db.seen.filter((s) => s === partialCountSql(false) || s === unresolvedMapSql(false)).length;
  await counter.forClient(low);
  check("a second client in the same firing: no statement again", db.seen.filter((s) => s === partialCountSql(false) || s === unresolvedMapSql(false)).length === statements);

  failState = "US|IN";
  const seeded = freeFirstCounter(db, { passId: null, pattern: null, known: { "US|IL": 4, "US|XX": -1, junk: 3 } });
  const two = await seeded.forClient([low[0], { kind: "low", label: "Gary, IN", place: { country: "US", state: "IN", city: "Gary" } }]);
  check("a known state is read from the pass, not counted; one that fails reads null and so does the sum",
    same(two.states, [{ key: "US|IL", partial: 4 }, { key: "US|IN", partial: null }]) && two.partial === null && two.unresolved === 1, JSON.stringify(two));
  check("known values that are not counts are ignored", (await seeded.partial("US|XX")) === 2);

  const broken = standIn(() => {
    throw new Error("made-up failure");
  });
  const none = await freeFirstCounter(broken, { passId: null, pattern: null }).forClient(low.slice(0, 2));
  check("nothing can be counted: partial and unresolved null, no city listed, nothing thrown",
    none.partial === null && none.unresolved === null && none.cities.length === 0 && none.states.every((s) => s.partial === null), JSON.stringify(none));
  const said = [];
  const noTotal = await storeUnresolvedTotal(broken, "00000000-0000-0000-0000-000000000000", { log: (m) => said.push(m) });
  const noStore = standIn((sql) => {
    if (sql === UNRESOLVED_TOTAL_SQL) return [{ n: 6 }];
    throw new Error("made-up failure");
  });
  const counted = await storeUnresolvedTotal(noStore, "00000000-0000-0000-0000-000000000000", { log: (m) => said.push(m) });
  check("the unresolved total never throws: a failed count gives null, a failed store keeps the number; both are logged",
    noTotal === null && counted === 6 && said.length === 2 && /not counted/.test(said[0]) && /not stored/.test(said[1]), JSON.stringify(said));

  const keys = await one(
    `SELECT ${UNRESOLVED_KEY_SQL} AS a, (SELECT ${UNRESOLVED_KEY_SQL} FROM (SELECT NULL::text AS city, '{"city_pre_clean": "Fort  Wayne"}'::jsonb AS raw_data) l) AS b,
            (SELECT ${UNRESOLVED_KEY_SQL} FROM (SELECT '  '::text AS city, '{"state_pre_clean": "Ill."}'::jsonb AS raw_data) l) AS c
       FROM (SELECT ' St. Paul '::text AS city, NULL::jsonb AS raw_data) l`
  );
  check("the queue text's key in SQL is the city key in JavaScript (city, then city_pre_clean, then state_pre_clean)",
    keys.a === entryKey(" St. Paul ") && keys.b === entryKey("Fort  Wayne") && keys.c === "ill", JSON.stringify(keys));

  const r = readFreeFirst({
    clients: 3,
    free_first: {
      at: "2026-11-20T10:00:00+00:00", unresolved_total: 5, states: { "US|IL": 2 },
      clients: {
        X: {
          partial: 2, unresolved: -1, states: [{ key: "US|IL", partial: 2 }, { key: 3 }, "junk", { key: "US|IN", partial: "1" }],
          cities: [{ label: "Peoria, IL", unresolved: 2 }, { label: "Half", unresolved: 1.5 }, { unresolved: 1 }],
        },
        Y: "junk",
      },
    },
  });
  check("readFreeFirst: the total and its time", same(r.top, { unresolvedTotal: 5, at: "2026-11-20T10:00:00+00:00" }), JSON.stringify(r.top));
  check("readFreeFirst: a client's numbers checked, malformed entries left out",
    same(r.clientOf("X"), { partial: 2, unresolved: null, states: [{ key: "US|IL", partial: 2 }, { key: "US|IN", partial: null }], cities: [{ label: "Peoria, IL", unresolved: 2 }] }),
    JSON.stringify(r.clientOf("X")));
  check("readFreeFirst: no entry, or not an object, is null", r.clientOf("Y") === null && r.clientOf("Z") === null && r.clientOf("__proto__") === null);
  check("readFreeFirst: a pass with no free_first (or a malformed one) has none",
    readFreeFirst({ clients: 3 }).top === null && readFreeFirst(null).top === null && readFreeFirst({ free_first: [] }).top === null &&
      readFreeFirst({ clients: 3 }).clientOf("X") === null);
  check("readFreeFirst: a total that is not a count and a time that is not a date read null",
    same(readFreeFirst({ free_first: { at: "soon", unresolved_total: "7" } }).top, { unresolvedTotal: null, at: null }));
}

// ── F1 to F6. The pass ──────────────────────────────────────────────────────

let base = null;
let baseFiltered = null;
let p1 = null;
const SEEDED = { st: { IL: 2, IN: 1, TX: 2, WI: 1 }, keys: { peoria: 2, gary: 1, springfeild: 1 } };
const SEEDED_FILTERED = { st: { IL: 2, IN: 0, TX: 2, WI: 1 }, keys: { peoria: 1, gary: 1, springfeild: 1 } };

async function seedLeads() {
  // Partial leads: a state, city text the reference does not hold, no location_id.
  await addLead({ local: "owner-p1", status: "partial", state: "IL", city: "Peoria Hts" });
  await addLead({ local: "gttest-box", status: "partial", state: "IL", city: "Sprngfield" }); // the filter's text, personal: always counts
  await addLead({ local: "gttest-box", type: "general", status: "partial", state: "IN", city: "Gary Twp" }); // a general inbox the filter matches
  await addLead({ local: "owner-p4", status: "partial", state: "IL", city: "Peoria Hts", bounced: true });
  await addLead({ local: "owner-p5", status: "partial", state: "IN", city: "Gary Twp", suppressed: true });
  await addLead({ email: "", status: "partial", state: "IL", city: "Peoria Hts" }); // no email
  await addLead({ local: "owner-p7", status: "partial", state: "IL", city: "   " }); // blank city
  await addLead({ local: "owner-p8", status: "partial", state: "TX", city: "Austin Metro" });
  await addLead({ local: "owner-p9", status: "partial", state: "TX", city: "Austin Metro" });
  await addLead({ local: "owner-p10", status: "partial", state: "WI", city: "Madison Area" }); // WI is only state-wide for A
  await addLead({ local: "owner-p11", status: "partial", state: "IL", city: "Peoria Hts", validation: "invalid" });
  // Unresolved leads: no state.
  await addLead({ local: "owner-u1", status: "unresolved", city: "Peoria" });
  await addLead({ local: "gttest-dept-info", type: "general", status: "unresolved", city: "Peoria" }); // a general inbox the filter matches
  await addLead({ local: "owner-u3", status: "unresolved", city: "Peoria", bounced: true });
  await addLead({ local: "owner-u4", status: "unresolved", city: null, raw: { city_pre_clean: "Gary" } });
  await addLead({ local: "owner-u5", status: "unresolved", city: "Springfeild" });
  // One resolved lead: C's Springfield has enough (1 of 1), A's is still low (1 of 5).
  await addLead({ local: "owner-r1", status: "resolved", state: "IL", city: "Springfield", locationId: CITY["Springfield, IL"] });
}

async function partF1() {
  section("F1. One pass: free first for the clients with low cities, none for the others");
  const want = plus(base, SEEDED);
  p1 = await newPass();
  check("the pass is done", p1?.state === "done", JSON.stringify(p1?.state));
  const ff = p1.counts.free_first ?? {};
  const aFlags = (await flagsOf(p1.id, A)).filter((f) => f.kind === "low");
  check("A's low places: its three cities (known to the geo reference) and WI state-wide",
    same(aFlags.map((f) => f.place_key).sort(), ["US|IL|peoria", "US|IL|springfield", "US|IN|gary", "US|WI"]) && aFlags.every((f) => f.resolved === true),
    JSON.stringify(aFlags));
  const a = ff.clients?.[A];
  const ea = expectedFor(A, want);
  check("A: partial = its contactable partial leads with city text in IL and IN (3 seeded; bounced, suppressed, no email, not valid, blank city, TX and WI left out)",
    a?.partial === ea.partial && ea.partial === base.st.IL + base.st.IN + 3, JSON.stringify({ a, ea }));
  check("A: its states, most first", same(a?.states, ea.states), JSON.stringify(a?.states));
  check("A: unresolved = two Peoria and one Gary (city_pre_clean); a bounced Peoria and Springfeild left out",
    a?.unresolved === ea.unresolved && ea.unresolved === (base.keys.peoria ?? 0) + (base.keys.springfield ?? 0) + (base.keys.gary ?? 0) + 3,
    JSON.stringify({ a, ea }));
  check("A: its cities with unresolved leads, most first", same(a?.cities, ea.cities), JSON.stringify(a?.cities));
  check("B (only a state-wide low place) and C (every place enough) have no entry",
    !Object.hasOwn(ff.clients ?? {}, B) && !Object.hasOwn(ff.clients ?? {}, C), JSON.stringify(Object.keys(ff.clients ?? {})));
  const d = ff.clients?.[D];
  check("D: Peoria in two states is one key, counted once and listed twice; TX counted for D",
    same(d, expectedFor(D, want)) && d.cities.filter((c) => c.label.startsWith("Peoria")).length === 2, JSON.stringify(d));
  check("F (cannot receive: not on the Groups tab) is counted all the same", same(ff.clients?.[F], expectedFor(F, want)), JSON.stringify(ff.clients?.[F]));
  const total = (await one(`SELECT count(*) FILTER (WHERE location_status = 'unresolved')::int AS n FROM leads`)).n;
  check("unresolved_total equals an independent count of every unresolved lead; at is set",
    ff.unresolved_total === total && total >= 5 && typeof ff.at === "string" && Math.abs(Date.parse(ff.at) - Date.now()) < 10 * 60_000, JSON.stringify({ ff: ff.unresolved_total, total, at: ff.at }));
  check("the states counted in the pass are kept on it (IL, IN, TX; never WI)",
    same(ff.states, { "US|IL": want.st.IL, "US|IN": want.st.IN, "US|TX": want.st.TX }), JSON.stringify(ff.states));
  check("the counts test-topup reads are still there", p1.counts.clients === 5 && p1.counts.low_places === 9 && typeof p1.counts.cannot_receive === "number",
    JSON.stringify({ ...p1.counts, free_first: undefined }));
}

async function partF2() {
  section("F2. The General inboxes filter");
  await setFilter(FILTER);
  const want = plus(baseFiltered, SEEDED_FILTERED);
  const p2 = await newPass();
  const a = p2.counts.free_first?.clients?.[A];
  check("filter loaded: the general inbox it matches among A's partial leads is left out (IN 0); the personal address with the same text still counts (IL 2)",
    same(a, expectedFor(A, want)) && a.states.find((s) => s.key === "US|IN")?.partial === baseFiltered.st.IN &&
      a.states.find((s) => s.key === "US|IL")?.partial === baseFiltered.st.IL + 2, JSON.stringify(a));
  check("and among the unresolved leads (one Peoria left)", a?.unresolved === expectedFor(A, want).unresolved && a.cities.find((c) => c.label === "Peoria, IL")?.unresolved === (baseFiltered.keys.peoria ?? 0) + 1,
    JSON.stringify(a?.cities));
  check("the unresolved total takes no filter", p2.counts.free_first?.unresolved_total === p1.counts.free_first.unresolved_total);
  await setFilter(null);
}

async function partF4() {
  section("F4. One statement per state and one map per firing; a pass carried to a second firing");
  const want = plus(base, SEEDED);
  const seen = { partial: [], map: 0, total: 0 };
  let failD = true;
  const wp = watchedPool(pool, (sql, params) => {
    if (sql === partialCountSql(false) || sql === partialCountSql(true)) seen.partial.push(`${params[0]}|${params[1]}`);
    else if (sql === unresolvedMapSql(false) || sql === unresolvedMapSql(true)) seen.map++;
    else if (sql === UNRESOLVED_TOTAL_SQL) seen.total++;
    if (failD && /fn_client_receive_block/.test(sql) && params[0] === D) throw new Error("gttest: a made-up failure for D");
  });
  const { rows: [p] } = await pool.query(`INSERT INTO topup_passes (state, trigger, requested_by) VALUES ('requested', 'manual', $1) RETURNING id`, [USER]);
  passIds.add(p.id);
  const settings = await readTopupSettings(pool);
  const first = await runPass(wp, { settings, geo, tagPrefix: PREFIX, log });
  check("firing 1: D fails, so the pass stays running", first?.state === "running" && !first.clients_done.includes(D) && first.counts.failed_tries?.[D] === 1,
    JSON.stringify({ state: first?.state, done: first?.clients_done, failed: first?.counts?.failed_tries }));
  check("firing 1: one statement per state (A's IL and IN; F's IL is reused), one map, one total",
    same([...seen.partial].sort(), ["US|IL", "US|IN"]) && seen.map === 1 && seen.total === 1, JSON.stringify(seen));
  const ff1 = first.counts.free_first;
  check("each state counted is on the pass at once", same(ff1?.states, { "US|IL": want.st.IL, "US|IN": want.st.IN }), JSON.stringify(ff1?.states));
  seen.partial = [];
  seen.map = 0;
  seen.total = 0;
  failD = false;
  const second = await runPass(wp, { settings, geo, tagPrefix: PREFIX, log });
  check("firing 2: only D is left; its new state (TX) is counted, IL and IN are read from the pass; one map",
    same(seen.partial, ["US|TX"]) && seen.map === 1, JSON.stringify(seen));
  const ff2 = second?.counts?.free_first ?? {};
  check("firing 2: the total is not counted again (the number and at unchanged)",
    seen.total === 0 && ff2.at === ff1.at && ff2.unresolved_total === ff1.unresolved_total, JSON.stringify({ seen, at1: ff1.at, at2: ff2.at }));
  check("D's numbers use the states read back", same(ff2.clients?.[D], expectedFor(D, want)), JSON.stringify(ff2.clients?.[D]));
  check("the clients of firing 1 kept their entries", same(ff2.clients?.[A], expectedFor(A, want)) && same(ff2.clients?.[F], expectedFor(F, want)));

  section("F3. The done pass keeps free_first next to the other counts and failed_tries");
  const keys = ["clients", "clients_low", "low_places", "unresolved_places", "all_ok", "no_places", "no_rules", "not_covered", "cannot_receive", "pulls"];
  check("done, with every count test-topup reads, failed_tries and free_first",
    second?.state === "done" && keys.every((k) => typeof second.counts[k] === "number") && same(second.counts.failed_tries, { [D]: 1 }) &&
      same(Object.keys(ff2).sort(), ["at", "clients", "states", "unresolved_total"]),
    JSON.stringify({ state: second?.state, counts: { ...second?.counts, free_first: Object.keys(ff2) } }));
  check("the counts are the flags' own (5 clients, 9 low places)", second.counts.clients === 5 && second.counts.low_places === 9, JSON.stringify(second.counts));
}

let p5 = null;
async function partF5() {
  section("F5. A partial count that fails: null, the flags as before, the pass done");
  const want = plus(base, SEEDED);
  const failing = watchedPool(pool, (sql) => {
    if (sql === partialCountSql(false)) throw new Error("gttest: the partial count failed");
  });
  p5 = await newPass(failing);
  check("the pass ends done", p5?.state === "done", JSON.stringify(p5?.state));
  check("A's flags are written as before", same(await flagsOf(p5.id, A), await flagsOf(p1.id, A)));
  const a = p5.counts.free_first?.clients?.[A];
  check("A: partial null, each state null, unresolved still counted",
    a?.partial === null && a.states.length === 2 && a.states.every((s) => s.partial === null) && a.unresolved === expectedFor(A, want).unresolved &&
      same(a.cities, expectedFor(A, want).cities), JSON.stringify(a));
  check("no state is stored on the pass, so a next firing would count them again", same(p5.counts.free_first?.states ?? {}, {}), JSON.stringify(p5.counts.free_first?.states));
  check("the failure is logged, the pass goes on", logs.some((l) => /free first: the partial leads of US\|IL were not counted/.test(l)));
}

async function partF6() {
  section("F6. A client rerun with no low city now loses its entry");
  const before = await countsOf(p5.id);
  await pool.query(`UPDATE client_targeting SET include_locations = $2::jsonb, updated_at = now() WHERE client_tag = $1`, [A, JSON.stringify([PLACE(null, "WI")])]);
  const settings = await readTopupSettings(pool);
  const cov = await coverageSettings(pool);
  const clients = await passClients(pool, { tagPrefix: PREFIX });
  const free = freeFirstCounter(pool, { passId: p5.id, pattern: cov.pattern, known: {}, log });
  await flagClient(pool, { pass: { id: p5.id }, client: clients.find((c) => c.tag === A), settings, geo, cov, free });
  const after = await countsOf(p5.id);
  check("A (now only WI state-wide, still low) has no entry; the others, the states and the total stay",
    before.free_first.clients[A] && !Object.hasOwn(after.free_first.clients, A) && same(after.free_first.clients[D], before.free_first.clients[D]) &&
      same(after.free_first.clients[F], before.free_first.clients[F]) && after.free_first.unresolved_total === before.free_first.unresolved_total &&
      after.free_first.at === before.free_first.at, JSON.stringify(Object.keys(after.free_first.clients)));
  check("its flags now: WI low, no city", same((await flagsOf(p5.id, A)).map((f) => `${f.kind}:${f.place_key}`), ["low:US|WI"]));
  await flagClient(pool, { pass: { id: p5.id }, client: clients.find((c) => c.tag === D), settings, geo, cov });
  check("without a counter (as before this change) nothing is counted or removed", same((await countsOf(p5.id)).free_first, after.free_first));
  // A's rules back; its stored coverage (of the WI-only rules) is newer than them, so it goes too.
  await pool.query(`UPDATE client_targeting SET include_locations = $2::jsonb, updated_at = now() WHERE client_tag = $1`, [A, JSON.stringify(RULES[A])]);
  await pool.query(`DELETE FROM client_location_coverage WHERE client_tag = $1`, [A]);
}

// ── H. Hand runs ────────────────────────────────────────────────────────────

const RUNS = {};
async function addRun(name, tag, { status = "queued", by = null, minsAgo, topup = false, credits = 0, pulled = 0, size = 25, started = false }) {
  const { rows: [r] } = await pool.query(
    `INSERT INTO aiark_runs (client_tag, mode, strategy, status, size_requested, filters, requests, created_by, created_at, started_at,
                             next_run_at, credits_used, pulled, finished_at)
     VALUES ($1, 'demo', 'single', $2, $3, $4::jsonb, '[{"contact": {}}]'::jsonb, $5, now() - make_interval(mins => $6),
             CASE WHEN $7::boolean THEN now() - make_interval(mins => $6) END, now() + interval '1 day', $8, $9,
             CASE WHEN $2 IN ('done', 'cancelled') THEN now() END)
     RETURNING id`,
    [tag, status, size, JSON.stringify(topup ? { people: {}, topup: { pass: null, pull: null, places: ["Peoria, IL"] } } : { people: {} }),
      by, minsAgo, started, credits, pulled]
  );
  RUNS[name] = r.id;
}

async function partH1(routes) {
  section("H1. AI Ark runs started by hand for clients that cannot receive");
  await addRun("eTopup", E, { minsAgo: 240, topup: true });
  await addRun("eHand", E, { by: USER, minsAgo: 180, size: 25 });
  await addRun("eDone", E, { status: "done", by: USER, minsAgo: 300 });
  await addRun("eCancelled", E, { status: "cancelled", by: USER, minsAgo: 360 });
  await addRun("fHand", F, { status: "running", by: USER2, minsAgo: 120, started: true, credits: 3.5, pulled: 7, size: 40 });
  await addRun("eNobody", E, { by: null, minsAgo: 60 });
  await addRun("eGone", E, { by: randomUUID(), minsAgo: 45 });
  await addRun("aHand", A, { by: USER, minsAgo: 30 });
  const list = await handRunsBlocked(pool, { tagPrefix: PREFIX });
  const ids = list.map((r) => r.id);
  check("listed, oldest first: E's queued hand run, F's running one, E's with no user, E's whose user is gone",
    same(ids, [RUNS.eHand, RUNS.fHand, RUNS.eNobody, RUNS.eGone]), JSON.stringify(list.map((r) => [r.client_tag, r.status, r.block])));
  const e = list.find((r) => r.id === RUNS.eHand);
  check("a queued hand run of a Paused client: its tag, status, who started it, size, credits 0 and the reason",
    e?.client_tag === E && e.status === "queued" && e.started_by === "Gaps tester" && e.size_requested === 25 && e.credits_used === 0 && e.block === "status Paused",
    JSON.stringify(e));
  const f = list.find((r) => r.id === RUNS.fHand);
  check("a running hand run of a client not on the Groups tab: that reason; a blank full name shows the email",
    f?.status === "running" && f.block === "not on the Groups tab" && f.started_by === USER2_EMAIL && f.credits_used === 3.5 && f.pulled === 7, JSON.stringify(f));
  check("no user recorded, or one that is gone: started_by null",
    list.find((r) => r.id === RUNS.eNobody)?.started_by === null && list.find((r) => r.id === RUNS.eGone)?.started_by === null);
  check("not listed: the Paused client's top-up run, a done hand run, a cancelled one, a hand run of a client that can receive",
    [RUNS.eTopup, RUNS.eDone, RUNS.eCancelled, RUNS.aHand].every((id) => !ids.includes(id)) &&
      (await one(`SELECT public.fn_client_receive_block($1) AS b`, [A])).b === null);
  check("a limit is kept", (await handRunsBlocked(pool, { tagPrefix: PREFIX, limit: 2 })).length === 2);

  const { T: R, call } = routes;
  R.role = "manager";
  const v = await call(routes.view.GET);
  const hr = (v.body.handRuns ?? []).filter((r) => r.tag.startsWith(PREFIX));
  const row = await one(`SELECT created_at, started_at FROM aiark_runs WHERE id = $1`, [RUNS.fHand]);
  check("GET /api/topup lists the same, oldest first", v.status === 200 && same(hr.map((r) => r.id), ids), JSON.stringify(hr.map((r) => r.id)));
  check("each with its fields as the tab shows them",
    same(hr.find((r) => r.id === RUNS.fHand), {
      id: RUNS.fHand, tag: F, status: "running", mode: "demo", strategy: "single", size: 40, creditsUsed: 3.5, pulled: 7,
      createdAt: new Date(row.created_at).toISOString(), startedAt: new Date(row.started_at).toISOString(), startedBy: USER2_EMAIL, reason: "not on the Groups tab",
    }) && hr.find((r) => r.id === RUNS.eNobody)?.startedBy === null && hr.find((r) => r.id === RUNS.eHand)?.startedAt === null,
    JSON.stringify(hr.find((r) => r.id === RUNS.fHand)));
  check("listed whether or not the top-up is on", await (async () => {
    await setSetting("weekly_topup", { enabled: false });
    const off = await call(routes.view.GET);
    await setSetting("weekly_topup", { enabled: true });
    return same((off.body.handRuns ?? []).filter((r) => r.tag.startsWith(PREFIX)).map((r) => r.id), ids);
  })());
}

async function partH2(routes) {
  section("H2. Read only; the hourly cancel never touches hand runs");
  const snap = () => all(`SELECT id, status, updated_at::text AS u FROM aiark_runs WHERE starts_with(client_tag, $1) ORDER BY id`, [PREFIX]);
  const before = await snap();
  await handRunsBlocked(pool, { tagPrefix: PREFIX });
  await routes.call(routes.view.GET);
  check("listing changed no run (status and updated_at)", same(await snap(), before));
  const cancelled = await cancelBlockedRuns(pool, { tagPrefix: PREFIX });
  check("the hourly cancel cancels the Paused client's top-up run only", same(cancelled.map((r) => r.id), [RUNS.eTopup]), JSON.stringify(cancelled));
  const status = Object.fromEntries((await all(`SELECT id, status FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => [r.id, r.status]));
  check("the hand runs keep going", status[RUNS.eHand] === "queued" && status[RUNS.fHand] === "running" && status[RUNS.eNobody] === "queued" &&
    status[RUNS.eGone] === "queued" && status[RUNS.aHand] === "queued", JSON.stringify(status));
  check("and are still listed", same((await handRunsBlocked(pool, { tagPrefix: PREFIX })).map((r) => r.id), [RUNS.eHand, RUNS.fHand, RUNS.eNobody, RUNS.eGone]));
}

// ── F8. The route ───────────────────────────────────────────────────────────

async function partF8(routes) {
  section("F8. GET /api/topup: free first as stored, a pass from before it, the links");
  const { T: R, call } = routes;
  const p8 = await newPass();
  R.role = "viewer";
  check("a viewer cannot see the tab", (await call(routes.view.GET)).status === 403);
  R.role = "manager";
  const v = await call(routes.view.GET);
  const stored = (await countsOf(p8.id)).free_first;
  const of = (tag) => v.body.clients?.find((c) => c.tag === tag);
  check("a manager sees the newest pass", v.status === 200 && v.body.pass?.id === p8.id, JSON.stringify(v.body.pass?.id));
  check("each client's freeFirst is what the pass stored", [A, D, F].every((t) => same(of(t)?.freeFirst, stored.clients[t])),
    JSON.stringify([A, D, F].map((t) => [of(t)?.freeFirst, stored.clients[t]])));
  check("a client with no entry has null", of(B)?.freeFirst === null && of(C)?.freeFirst === null);
  check("the top level: the unresolved total and when it was counted", same(v.body.freeFirst, { unresolvedTotal: stored.unresolved_total, at: stored.at }),
    JSON.stringify(v.body.freeFirst));

  // A pass from before free first: flags written without a counter, no free_first in its counts.
  const { rows: [old] } = await pool.query(
    `INSERT INTO topup_passes (state, trigger, requested_by, requested_at, started_at, finished_at, counts)
     VALUES ('done', 'manual', $1, now() + interval '1 minute', now(), now(), '{"clients": 1}') RETURNING id`,
    [USER]
  );
  passIds.add(old.id);
  const settings = await readTopupSettings(pool);
  const cov = await coverageSettings(pool);
  const client = (await passClients(pool, { tagPrefix: PREFIX })).find((c) => c.tag === A);
  await flagClient(pool, { pass: { id: old.id }, client, settings, geo, cov });
  const ov = await call(routes.view.GET);
  check("a pass with no free_first: the client's freeFirst null, the top level null",
    ov.body.pass?.id === old.id && ov.body.clients?.find((c) => c.tag === A)?.freeFirst === null && ov.body.freeFirst === null &&
      !("free_first" in (await countsOf(old.id))), JSON.stringify({ pass: ov.body.pass?.id, top: ov.body.freeFirst }));

  const tab = source("src/components/sharing/low-places-tab.tsx");
  check("the Low places tab links to the Locations page's Unresolved queue", tab.includes(`"/locations?tab=unresolved"`) && /href=\{UNRESOLVED_QUEUE\}/.test(tab));
  check("the tab shows the hand runs card and the free-first pill", /AI Ark runs started by hand for clients that cannot receive/.test(tab) && /Free first: /.test(tab));
  const page = source("src/app/(app)/locations/page.tsx");
  check("the Locations page reads ?tab and opens the Unresolved queue",
    /new URLSearchParams\(window\.location\.search\)\.get\("tab"\) === "unresolved"\) setTab\("unresolved"\)/.test(page));
}

// ── F7. The plans ───────────────────────────────────────────────────────────

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
/** The plan with sequential scans off, in a transaction rolled back. */
async function plan(sql, params) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL enable_seqscan = off");
    const { rows: [r] } = await c.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
    return planNodes(r["QUERY PLAN"]);
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}
const indexesOf = (nodes) => [...new Set(nodes.filter((n) => n["Index Name"]).map((n) => n["Index Name"]))].sort();
const seqOnLeads = (nodes) => nodes.some((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "leads");

async function partF7() {
  section("F7. The plans: the counts read leads through their indexes (sequential scans off)");
  await pool.query(
    `INSERT INTO leads (email, email_type, company, country_code, state_code, state, country, city, location_id, location_status, validation_status, raw_data)
     SELECT 'bulk' || g || '@bulk-' || $1 || '.gttest.example', 'personal', 'gttest bulk',
            CASE WHEN g % 25 = 0 THEN NULL ELSE 'US' END,
            CASE WHEN g % 25 = 0 THEN NULL WHEN g % 2 = 0 THEN 'IL' ELSE 'IN' END,
            CASE WHEN g % 25 = 0 THEN NULL WHEN g % 2 = 0 THEN 'Illinois' ELSE 'Indiana' END,
            CASE WHEN g % 25 = 0 THEN NULL ELSE 'USA' END,
            CASE WHEN g % 25 = 0 THEN 'Bulkville' WHEN g % 25 = 1 THEN 'Bulk Twp' WHEN g % 2 = 0 THEN 'Chicago' ELSE 'Hammond' END,
            CASE WHEN g % 25 IN (0, 1) THEN NULL WHEN g % 2 = 0 THEN $2::bigint ELSE $3::bigint END,
            CASE WHEN g % 25 = 0 THEN 'unresolved' WHEN g % 25 = 1 THEN 'partial' ELSE 'resolved' END,
            'valid', jsonb_build_object('gttest', $1::text)
       FROM generate_series(1, 2000) g`,
    [RUN, CITY["Chicago, IL"], CITY["Hammond, IN"]]
  );
  await pool.query(`ANALYZE leads`);
  analyzed = true;
  const n = (await one(`SELECT count(*)::int AS n FROM leads WHERE email LIKE $1`, [`%@bulk-${RUN}.${HOST}`])).n;
  check("2,000 made-up leads across IL and IN, mostly resolved, and leads analyzed", n === 2000);
  const ALLOWED = ["idx_leads_location_status", "idx_leads_state_code"];
  for (const [what, nodes] of [
    ["the partial count", await plan(partialCountSql(false), ["US", "IL"])],
    ["the partial count with the filter", await plan(partialCountSql(true), ["US", "IL", FILTER])],
  ]) {
    const used = indexesOf(nodes);
    console.log(`        ${what}: ${nodes.map((x) => `${x["Node Type"]}${x["Index Name"] ? ` (${x["Index Name"]})` : ""}`).join(" > ")}`);
    check(`${what}: leads through idx_leads_state_code and/or idx_leads_location_status, no Seq Scan on leads`,
      used.length > 0 && used.every((i) => ALLOWED.includes(i)) && !seqOnLeads(nodes), JSON.stringify(nodes.map((x) => [x["Node Type"], x["Index Name"]])));
  }
  for (const [what, nodes] of [
    ["the unresolved map", await plan(unresolvedMapSql(false), [])],
    ["the unresolved map with the filter", await plan(unresolvedMapSql(true), [FILTER])],
    ["the unresolved total", await plan(UNRESOLVED_TOTAL_SQL, [])],
  ]) {
    console.log(`        ${what}: ${nodes.map((x) => `${x["Node Type"]}${x["Index Name"] ? ` (${x["Index Name"]})` : ""}`).join(" > ")}`);
    check(`${what}: leads through idx_leads_location_status, no Seq Scan on leads`,
      same(indexesOf(nodes), ["idx_leads_location_status"]) && !seqOnLeads(nodes), JSON.stringify(nodes.map((x) => [x["Node Type"], x["Index Name"]])));
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

const t0 = Date.now();
try {
  const ready = await one(
    `SELECT to_regclass('public.topup_passes') IS NOT NULL AS passes, to_regprocedure('public.fn_client_receive_block(text)') IS NOT NULL AS fn,
            to_regclass('public.never_contact_inbox_runs') IS NOT NULL AS nc`
  );
  if (!ready.passes || !ready.fn || !ready.nc) throw new Error("migrations 132, 135 and 136 must be in this database");
  await cleanup();
  const busy = await one(
    `SELECT (SELECT count(*)::int FROM topup_passes WHERE state IN ('requested', 'running')) AS open_pass,
            (SELECT count(*)::int FROM worker_locks WHERE key = 'topup-worker') AS lease,
            (SELECT count(*)::int FROM client_tags WHERE starts_with(tag, $1)) AS leftover_clients,
            (SELECT count(*)::int FROM aiark_runs WHERE starts_with(client_tag, $1)) AS leftover_runs,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2 OR email = '') AS leftover_or_empty_email_leads`,
    [PREFIX, `%.${HOST}`]
  );
  check("before the run: no open pass, no top-up lease, no GTTEST_ leftover, no lead with an empty email", Object.values(busy).every((x) => x === 0), JSON.stringify(busy));
  if (!Object.values(busy).every((x) => x === 0)) throw new Error("not run: this database has an open top-up pass, a lease or rows this suite cannot clean");
  settingsBefore = await all(`SELECT key, value FROM enrich_settings WHERE key IN ('weekly_topup', 'never_contact_inboxes')`);
  if (settingsBefore.length !== 2) throw new Error("the weekly_topup or never_contact_inboxes setting is missing");
  await setSetting("weekly_topup", TOPUP_ON);
  await setFilter(null);

  for (const r of await all(
    `SELECT g.city || ', ' || a.state_code AS label, min(g.geoname_id)::text AS id
       FROM geo_locations g JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
      WHERE g.country_code = 'US' AND (a.state_code, g.city_key) IN (('IL', 'peoria'), ('IL', 'springfield'), ('IN', 'gary'), ('IN', 'peoria'),
                                                                     ('TX', 'austin'), ('IL', 'chicago'), ('IN', 'hammond'))
      GROUP BY 1`
  )) {
    CITY[r.label] = r.id;
  }
  if (Object.keys(CITY).length !== 7) throw new Error(`the geo reference lacks a test city: ${JSON.stringify(Object.keys(CITY))}`);
  geo = await loadGeo(pool);
  for (const [id, email, name] of [[USER, `gttest-tester-${RUN}@${USERS_AT}`, "Gaps tester"], [USER2, USER2_EMAIL, "  "]]) {
    await pool.query(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, email]);
    await pool.query(`INSERT INTO user_profiles (id, email, full_name, role, is_active) VALUES ($1, $2, $3, 'manager', true)`, [id, email, name]);
  }
  await addClient(A, { places: RULES[A], min: 5 });
  await addClient(B, { places: RULES[B], min: 100_000 });
  await addClient(C, { places: RULES[C], min: 1 });
  await addClient(D, { places: RULES[D], min: 5 });
  await addClient(E, { status: "Paused", places: RULES[E] });
  await addClient(F, { places: RULES[F], min: 5, onTab: false });

  base = await freeNow(null);
  baseFiltered = await freeNow(FILTER);
  await seedLeads();

  const loader = routeLoader(USER);
  const routes = { ...loader, view: await loader.route("topup") };
  await partF0();
  await partF1();
  await partF2();
  await partF4();
  await partF5();
  await partF6();
  await partH1(routes);
  await partH2(routes);
  await partF8(routes);
  await partF7();
  section("Z. No network");
  check("nothing tried to reach any address", Object.values(net.calls).every((x) => x === 0), JSON.stringify(net.calls));
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  for (const s of settingsBefore ?? []) {
    await pool.query(`UPDATE enrich_settings SET value = $2::jsonb WHERE key = $1`, [s.key, JSON.stringify(s.value)]).catch(() => {});
  }
  // The planner's numbers back to what leads holds without the made-up rows.
  if (analyzed) await pool.query(`ANALYZE leads`).catch(() => {});
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE starts_with(tag, $1)) AS clients,
            (SELECT count(*)::int FROM client_targeting WHERE starts_with(client_tag, $1)) AS targeting,
            (SELECT count(*)::int FROM client_location_coverage WHERE starts_with(client_tag, $1)) AS coverage,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2 OR (email = '' AND raw_data ? 'gttest')) AS leads,
            (SELECT count(*)::int FROM aiark_runs WHERE starts_with(client_tag, $1)) AS runs,
            (SELECT count(*)::int FROM topup_pulls WHERE starts_with(client_tag, $1)) AS pulls,
            (SELECT count(*)::int FROM topup_flags WHERE starts_with(client_tag, $1)) AS flags,
            (SELECT count(*)::int FROM topup_passes WHERE id = ANY($3::uuid[])) AS passes,
            (SELECT count(*)::int FROM auth.users WHERE email LIKE $4) AS users,
            (SELECT count(*)::int FROM user_profiles WHERE email LIKE $4) AS profiles`,
    [PREFIX, `%.${HOST}`, [...passIds], `gttest-%@${USERS_AT}`]
  );
  const now = await all(`SELECT key, value FROM enrich_settings WHERE key IN ('weekly_topup', 'never_contact_inboxes') ORDER BY key`);
  const back = settingsBefore ? same(now, [...settingsBefore].sort((x, y) => x.key.localeCompare(y.key))) : true;
  const clean = Object.values(left).every((x) => x === 0) && back;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, settingsBack: back })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
