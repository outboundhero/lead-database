#!/usr/bin/env node
// The weekly top-up (migration 135): the minimum per client, coverage with
// the general inbox filter, the flag pass, pulls (prepared and automatic),
// the budget, the churn stops, and the routes the Low places tab uses.
// LOCAL DATABASE ONLY. Made-up clients TPTEST_A to TPTEST_H with their rules,
// made-up leads under .tptest.example in four Illinois cities, a made-up
// stand-in filter. AI Ark answers from its demo stand-in only: no paid call,
// no key. The weekly_topup and never_contact_inboxes settings are put back at
// the end and everything else the run made is removed. No other test's rows
// are touched.
//
//   node --env-file=.env.local scripts/test-topup.mjs
//
// Do not start the topup-worker or the enrich-worker for this: their steps run
// here as exported (the pass, the pulls, the cancel, one AI Ark slice).
//
//   M. the minimum: the field's rule, the column's limits, who writes it
//   C. coverage: the client's minimum, the general inbox filter left out, the refresh
//   P. the pass: every Active client flagged or given a reason, one pass a
//      week, Run now, carrying on, stored coverage used or computed again
//   L. the lease
//   Q. prepared pulls: only the low places, exclusions kept, size, expiry
//   S. counting and starting a pull through the AI Ark routes, the marker
//   B. the budget: reserved brakes, count credits, per client, pulls_per_day
//   A. auto pulls: started, waiting for a run, the budget, the day's pulls
//   X. churn: the hourly cancel and the AI Ark slice's check
//   O. off means nothing; the Low places routes

import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checker, dropPaidKeys, installNet, localDatabaseUrl, routeLoader } from "./fixtures/test-support.mjs";
import { cleanMinimum, computeCoverage, coverageSettings, minimumOf } from "./lib/coverage.mjs";
import { loadGeo } from "./lib/aiark/filters.mjs";
import { advanceOneRun, brakeFor, createRun } from "./lib/aiark/runs.mjs";
import { createAiArk } from "./lib/aiark/client.mjs";
import { createDemoTransport, DEMO_TOKEN } from "./lib/aiark/demo.mjs";
import { isTopupRunFilters } from "./lib/overlap-topup.mjs";
import { runPass } from "./lib/topup/pass.mjs";
import { readTopupSettings, startWaitingPulls } from "./lib/topup/pulls.mjs";
import { pullsStartedToday, topupBudget } from "./lib/topup/budget.mjs";
import { acquireLease, cancelBlockedRuns, releaseLease, topupOnce } from "./lib/topup/run.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
process.env.AIARK_DEMO = "1";
process.env.AIARK_DEMO_LATENCY_MS = "0";
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 8 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const source = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const PREFIX = "TPTEST_";
const T = (s) => `${PREFIX}${s}`;
const A = T("A"); // Cleaning, receives, own minimum 4: Springfield (enough), Peoria (low), an unknown city
const B = T("B"); // Cleaning, a churn date in 5 days: flagged, never pulled for
const C = T("C"); // Non-Cleaning: not covered (has saved people filters, for a hand pull limited to places)
const D = T("D"); // Cleaning, rules with no places
const E = T("E"); // Cleaning, no rules row
const F = T("F"); // Cleaning, Paused: not visited
const G = T("G"); // Canada Cleaning, no saved people filters
const H = T("H"); // Cleaning, Healthy, a big tag count, low places
const I = T("I"); // Cleaning, Active, but not listed on the Groups tab: flagged, never pulled for
const RUN = randomUUID().slice(0, 6);
const HOST = "tptest.example";
const USER = randomUUID();
const FILTER = "tptest-box@|tptest-dept";
const IL = (city) => ({ city, state: "IL", country: "US" });
const CITY = {};
const passIds = new Set();
let settingsBefore = null;

async function setSetting(key, over) {
  await pool.query(`UPDATE enrich_settings SET value = value || $2::jsonb WHERE key = $1`, [key, JSON.stringify(over)]);
}
const topup = (over) => setSetting("weekly_topup", over);
const TOPUP_ON = {
  enabled: true, client_types: ["Cleaning", "Canada Cleaning"], default_minimum: 5, pull_mode: "off", pull_tags: [],
  weekly_credits: 25000, client_weekly_credits: 25000, max_pull_size: 1000, pulls_per_day: 3,
};

async function addClient(tag, { type = "Cleaning", status = "Active", places = undefined, exclude = [], min = null, churnInDays = null, onTab = true } = {}) {
  const churn = churnInDays == null ? null : (await one(`SELECT ((now() AT TIME ZONE 'UTC')::date + $1::int)::text AS d`, [churnInDays])).d;
  await pool.query(
    `INSERT INTO client_tags (tag, name, client_type, status, group_no, on_groups_tab, churn_cell_state, churn_date, churn_cell, groups_tab_read_at)
     VALUES ($1, $2, $3, $4, 1, $8, $5, $6::date, $7, now())`,
    [tag, `Top-up test ${tag.slice(PREFIX.length)}`, type, status, churn ? "date" : "empty", churn, churn, onTab]
  );
  if (places !== undefined) {
    await pool.query(
      `INSERT INTO client_targeting (client_tag, countries, include_locations, exclude_locations, exclude_terms, commercial_cleaning, min_leads_per_place, updated_at)
       VALUES ($1, '{US}', $2::jsonb, $3::jsonb, '{}', false, $4, now() - interval '1 hour')`,
      [tag, JSON.stringify(places), JSON.stringify(exclude), min]
    );
  }
  return churn;
}

let leadSeq = 0;
async function addLead(local, type, city) {
  leadSeq++;
  await pool.query(
    `INSERT INTO leads (email, email_type, company, country_code, state_code, location_id, location_status, city, state, country, validation_status)
     VALUES ($1, $2, 'tptest lead', 'US', 'IL', $3, 'resolved', $4, 'IL', 'US', 'valid')`,
    [`${local}@${city.toLowerCase()}-${RUN}-${leadSeq}.${HOST}`, type, CITY[city], city]
  );
}

/** A pass asked for now (as Run now does) and worked to the end, for the test's clients. */
async function newPass(settingsOver = null) {
  if (settingsOver) await topup(settingsOver);
  const { rows: [p] } = await pool.query(`INSERT INTO topup_passes (state, trigger) VALUES ('requested', 'manual') RETURNING id`);
  passIds.add(p.id);
  const settings = await readTopupSettings(pool);
  const done = await runPass(pool, { settings, geo, tagPrefix: PREFIX });
  return done;
}
const flagsOf = (passId) =>
  all(
    `SELECT client_tag, kind, place_key, label, available, minimum, resolved, receive_block, action, reason, pull_id, run_id
       FROM topup_flags WHERE pass_id = $1 ORDER BY client_tag, kind, place_key`,
    [passId]
  );
const pullOf = (passId, tag) => one(`SELECT * FROM topup_pulls WHERE pass_id = $1 AND client_tag = $2`, [passId, tag]);
const runOf = (id) => one(`SELECT * FROM aiark_runs WHERE id = $1`, [id]);
const versions = async (tag) => ({
  rulesVersion: (await one(`SELECT updated_at::text AS v FROM client_targeting WHERE client_tag = $1`, [tag]))?.v ?? null,
  peopleVersion: (await one(`SELECT updated_at::text AS v FROM client_people_filters WHERE client_tag = $1`, [tag]))?.v ?? null,
});

let geo = null;

async function cleanup() {
  const runs = (await all(`SELECT id FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  if (runs.length) {
    await pool.query(`DELETE FROM upload_batches WHERE aiark_run_id = ANY($1::uuid[])`, [runs]);
    await pool.query(`DELETE FROM aiark_people WHERE run_id = ANY($1::uuid[])`, [runs]);
  }
  await pool.query(`DELETE FROM topup_pulls WHERE starts_with(client_tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM aiark_runs WHERE starts_with(client_tag, $1)`, [PREFIX]);
  const tables = (await all(`SELECT id FROM enrich_tables WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.id);
  if (tables.length) {
    await pool.query(`DELETE FROM enrich_tables WHERE id = ANY($1::uuid[])`, [tables]);
    await pool.query(`DELETE FROM enrich_counters WHERE table_id = ANY($1::uuid[])`, [tables]).catch(() => {});
  }
  const flagged = (await all(`SELECT DISTINCT pass_id FROM topup_flags WHERE starts_with(client_tag, $1)`, [PREFIX])).map((r) => r.pass_id);
  await pool.query(`DELETE FROM topup_passes WHERE id = ANY($1::uuid[])`, [[...passIds, ...flagged]]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [`%.${HOST}`]);
  for (const t of ["client_location_coverage", "client_targeting", "client_people_filters"]) {
    await pool.query(`DELETE FROM ${t} WHERE starts_with(client_tag, $1)`, [PREFIX]);
  }
  await pool.query(`DELETE FROM client_stats WHERE starts_with(tag, $1)`, [PREFIX]);
  await pool.query(`DELETE FROM client_tags WHERE starts_with(tag, $1)`, [PREFIX]);
}

// ── M. The minimum ──────────────────────────────────────────────────────────

async function partM() {
  section("M1. The minimum of good leads a place");
  const ok = (v, want) => cleanMinimum(v).error === null && cleanMinimum(v).value === want;
  const bad = (v) => cleanMinimum(v).error !== null;
  check("empty (null, missing, blank) means the default", ok(null, null) && ok(undefined, null) && ok("  ", null));
  check("a whole number from 1 to 100,000 is taken, as text too", ok(1, 1) && ok(100_000, 100_000) && ok("500", 500));
  check("0, 100,001, a fraction, text and a negative are refused", bad(0) && bad(100_001) && bad(2.5) && bad("abc") && bad(-3) && bad(true));
  check("the number used: a forced one, else the client's own, else the default",
    minimumOf({ forced: 7, own: 4, defaultMinimum: 5 }).minimum === 7 && minimumOf({ own: 4, defaultMinimum: 5 }).from === "client" &&
      minimumOf({ own: null, defaultMinimum: 5 }).minimum === 5 && minimumOf({ forced: 0, own: 0, defaultMinimum: 9 }).from === "default");
  let code = null;
  try {
    await pool.query(`UPDATE client_targeting SET min_leads_per_place = 0 WHERE client_tag = $1`, [A]);
  } catch (e) {
    code = e.code;
  }
  check("the column refuses 0 (1 to 100,000)", code === "23514", String(code));
  check("the sheet sync never writes it", !/min_leads_per_place/.test(source("scripts/sync-client-targeting-from-sheet.mjs")));
  const route = source("src/app/api/clients/targeting/route.ts");
  check("the Rules route writes it only when sent, through cleanMinimum, and keeps it otherwise",
    /"min_leads_per_place" in body \? cleanMinimum\(body\.min_leads_per_place\)/.test(route) && /\.\.\.\(minimum \? \{ min_leads_per_place: minimum\.value \} : \{\}\)/.test(route));
  check("the Rules dialog sends it", /min_leads_per_place: minValue/.test(source("src/components/clients/client-targeting-dialog.tsx")));
  const page = source("src/app/(app)/leads/page.tsx");
  check("the Leads page no longer sends a fixed threshold", !/location-coverage\?[^`]*threshold=/.test(page));
}

// ── C. Coverage ─────────────────────────────────────────────────────────────

async function partC() {
  section("C1. Coverage at the client's minimum, with and without the general inbox filter");
  const entries = (await one(`SELECT include_locations FROM client_targeting WHERE client_tag = $1`, [A])).include_locations;
  const plain = await computeCoverage(pool, { tag: A, entries, threshold: 4 });
  const at = (cov, label) => cov.payload.locations.find((l) => l.label === label);
  check("no filter loaded: every general inbox counts (Peoria 5, Springfield 4)",
    at(plain, "Peoria, IL").available === 5 && at(plain, "Springfield, IL").available === 4 && plain.payload.generalInboxFilter === null,
    JSON.stringify(plain.payload.locations));
  check("a place the geo reference does not know: 0 and not resolved", at(plain, "Zzyzxville, IL").resolved === false && at(plain, "Zzyzxville, IL").available === 0);
  const s = await coverageSettings(pool);
  check("coverageSettings reads the default minimum and the loaded filter", s.defaultMinimum === 5 && s.pattern === FILTER && s.patternSha256 === sha(FILTER));
  const filtered = await computeCoverage(pool, { tag: A, entries, threshold: 4, pattern: s.pattern, patternSha256: s.patternSha256 });
  check("filter loaded: the two general inboxes it matches no longer count (Peoria 3); a personal address with the same text still does",
    at(filtered, "Peoria, IL").available === 3 && at(filtered, "Springfield, IL").available === 4 && filtered.payload.generalInboxFilter === sha(FILTER).slice(0, 12),
    JSON.stringify(filtered.payload.locations));
  check("low under the client's minimum: Peoria and the unknown city", JSON.stringify(filtered.payload.low.map((l) => l.label).sort()) === JSON.stringify(["Peoria, IL", "Zzyzxville, IL"]));

  section("C2. The coverage refresh");
  const script = new URL("./refresh-location-coverage.mjs", import.meta.url).pathname;
  const env = { ...process.env, DATABASE_URL: url };
  execFileSync(process.execPath, [script, "--tag", A], { env, encoding: "utf8" });
  let row = await one(`SELECT threshold, payload FROM client_location_coverage WHERE client_tag = $1`, [A]);
  check("each client at its own minimum (A: 4), the filter left out", row.threshold === 4 && row.payload.threshold === 4 &&
    row.payload.locations.find((l) => l.label === "Peoria, IL").available === 3 && row.payload.generalInboxFilter === sha(FILTER).slice(0, 12), JSON.stringify(row));
  execFileSync(process.execPath, [script, "--tag", A, "--threshold", "7"], { env, encoding: "utf8" });
  row = await one(`SELECT threshold FROM client_location_coverage WHERE client_tag = $1`, [A]);
  check("--threshold forces one number", row.threshold === 7);
  execFileSync(process.execPath, [script, "--tag", H], { env, encoding: "utf8" });
  row = await one(`SELECT threshold FROM client_location_coverage WHERE client_tag = $1`, [H]);
  check("a client with no minimum of its own takes the default (5)", row.threshold === 5);
  let refused = false;
  try {
    execFileSync(process.execPath, [script, "--threshold", "abc"], { env, encoding: "utf8", stdio: "pipe" });
  } catch {
    refused = true;
  }
  check("--threshold that is not a whole number from 1 to 100,000 is refused", refused);
  await pool.query(`DELETE FROM client_location_coverage WHERE starts_with(client_tag, $1)`, [PREFIX]);
}

// ── P. The pass ─────────────────────────────────────────────────────────────

async function partP(churnB, routes) {
  section("P1. Every Active client flagged, or given a reason");
  const p1 = await newPass();
  const f = await flagsOf(p1.id);
  const of = (tag) => f.filter((x) => x.client_tag === tag);
  check("the pass is done", p1.state === "done" && p1.finished_at, JSON.stringify(p1));
  const a = of(A);
  check("A: one low place (Peoria, 3 of 4) and one unknown place; Springfield (4 of 4) is not low",
    a.length === 2 && a.some((x) => x.kind === "low" && x.place_key === "US|IL|peoria" && x.available === 3 && x.minimum === 4 && x.resolved === true) &&
      a.some((x) => x.kind === "unresolved" && x.place_key === "US|IL|zzyzxville" && x.resolved === false && x.action === "none" && /fix its name/.test(x.reason)),
    JSON.stringify(a));
  check("A can receive; pulls are off, and its low place says so", a.every((x) => x.receive_block === null) && a.find((x) => x.kind === "low").action === "pull_mode_off");
  const b = of(B);
  check("B: flagged all the same, with its churn date as the reason it cannot receive, and no pull",
    b.length === 1 && b[0].kind === "low" && b[0].receive_block === `churn date ${churnB}` && b[0].action === "cannot_receive" && b[0].minimum === 5, JSON.stringify(b));
  check("C: one 'not covered' row naming its type", of(C).length === 1 && of(C)[0].kind === "not_covered" && /Non-Cleaning/.test(of(C)[0].reason), JSON.stringify(of(C)));
  check("D: no places, and it cannot receive for that reason", of(D).length === 1 && of(D)[0].kind === "no_places" && of(D)[0].receive_block === "no places");
  check("E: no rules", of(E).length === 1 && of(E)[0].kind === "no_rules" && of(E)[0].receive_block === "no rules row");
  check("F (Paused) is not visited", of(F).length === 0);
  check("G (Canada Cleaning) is covered: its empty place is low", of(G).length === 1 && of(G)[0].kind === "low" && of(G)[0].available === 0);
  check("H (Healthy, 161,000 tagged leads) is still flagged", of(H).length === 1 && of(H)[0].kind === "low" && of(H)[0].receive_block === null);
  check("I, not listed on the Groups tab: flagged, with that as the reason, and no pull",
    of(I).length === 1 && of(I)[0].kind === "low" && of(I)[0].receive_block === "not on the Groups tab" && of(I)[0].action === "cannot_receive", JSON.stringify(of(I)));
  check("every visited client has at least one row", [A, B, C, D, E, G, H, I].every((t) => of(t).length >= 1));
  check("the pass's counts", p1.counts.clients === 8 && p1.counts.low_places === 5 && p1.counts.unresolved_places === 1 && p1.counts.not_covered === 1 &&
    p1.counts.cannot_receive === 4, JSON.stringify(p1.counts));
  check("the settings it ran with are kept on the pass", p1.settings?.default_minimum === 5 && p1.settings?.enabled === true);

  section("P2. One pass a week, and Run now");
  const settings = await readTopupSettings(pool);
  check("the week is not up: no new pass", (await runPass(pool, { settings, geo, tagPrefix: PREFIX })) === null);
  await pool.query(`UPDATE topup_passes SET finished_at = now() - interval '8 days' WHERE id = ANY($1::uuid[])`, [[...passIds]]);
  const p2 = await runPass(pool, { settings, geo, tagPrefix: PREFIX });
  if (p2) passIds.add(p2.id);
  check("8 days later the schedule starts one", p2?.state === "done" && p2.trigger === "schedule");
  const { T: R, call } = routes;
  R.role = "manager";
  check("Run now: a manager may not", (await call(routes.run.POST)).status === 403);
  R.role = "admin";
  await topup({ enabled: false });
  const offNow = await call(routes.run.POST);
  check("Run now while the top-up is off: refused", offNow.status === 409 && /switched off/.test(offNow.body.error));
  await topup({ enabled: true });
  const asked = await call(routes.run.POST);
  if (asked.body?.pass?.id) passIds.add(asked.body.pass.id);
  check("Run now: a requested pass, audited", asked.status === 201 && R.audits.some((x) => x.action === "topup_run_now"), JSON.stringify(asked));
  check("Run now twice: refused while one waits", (await call(routes.run.POST)).status === 409);
  const p3 = await runPass(pool, { settings, geo, tagPrefix: PREFIX });
  check("the asked-for pass runs although the week is not up", p3?.id === asked.body.pass.id && p3.state === "done" && p3.trigger === "button");

  section("P3. A pass carries on at the next firing");
  const { rows: [p4] } = await pool.query(`INSERT INTO topup_passes (state, trigger) VALUES ('requested', 'manual') RETURNING id`);
  passIds.add(p4.id);
  const half = await runPass(pool, { settings, geo, tagPrefix: PREFIX, deadline: Date.now() - 1 });
  check("out of time: the pass stays running, no client done", half.state === "running" && half.clients_done.length === 0);
  const rest = await runPass(pool, { settings, geo, tagPrefix: PREFIX });
  check("the next firing finishes it", rest.id === p4.id && rest.state === "done" && rest.clients_done.length === 8, JSON.stringify(rest.clients_done));

  section("P4. Stored coverage: used while fresh, computed again otherwise");
  const peoria = async (passId) => (await flagsOf(passId)).find((x) => x.client_tag === A && x.kind === "low")?.available;
  const fake = (await one(`SELECT payload FROM client_location_coverage WHERE client_tag = $1`, [A])).payload;
  fake.locations = fake.locations.map((l) => (l.label === "Peoria, IL" ? { ...l, available: 1 } : l));
  await pool.query(`UPDATE client_location_coverage SET payload = $2::jsonb, computed_at = now() WHERE client_tag = $1`, [A, JSON.stringify(fake)]);
  check("a stored row newer than the rules, under 24 hours and with the same filter is used as it is", (await peoria((await newPass()).id)) === 1);
  await pool.query(`UPDATE client_location_coverage SET payload = $2::jsonb, computed_at = now() - interval '25 hours' WHERE client_tag = $1`, [A, JSON.stringify(fake)]);
  check("a row older than 24 hours is computed again", (await peoria((await newPass()).id)) === 3);
  await pool.query(`UPDATE client_location_coverage SET payload = $2::jsonb, computed_at = now() WHERE client_tag = $1`, [A, JSON.stringify(fake)]);
  await pool.query(`UPDATE client_targeting SET updated_at = now() + interval '1 second' WHERE client_tag = $1`, [A]);
  check("a row older than the client's rules is computed again", (await peoria((await newPass()).id)) === 3);
  await pool.query(`UPDATE client_targeting SET updated_at = now() - interval '1 hour' WHERE client_tag = $1`, [A]);
  await pool.query(`UPDATE client_location_coverage SET payload = $2::jsonb, computed_at = now() WHERE client_tag = $1`,
    [A, JSON.stringify({ ...fake, generalInboxFilter: "ffffffffffff" })]);
  check("a row counted with another filter is computed again", (await peoria((await newPass()).id)) === 3);
}

// ── L. The lease ────────────────────────────────────────────────────────────

async function partL() {
  section("L1. One firing at a time");
  const [x, y] = [randomUUID(), randomUUID()];
  const first = await acquireLease(pool, x);
  const second = await acquireLease(pool, y);
  await releaseLease(pool, x);
  const third = await acquireLease(pool, y);
  await releaseLease(pool, y);
  check("the lease: the first firing holds it, a second is turned away, then may take it once given back", first && !second && third);
  check("nothing is left in worker_locks", !(await one(`SELECT 1 FROM worker_locks WHERE key = 'topup-worker'`)));
}

// ── Q. Prepared pulls ───────────────────────────────────────────────────────

let prepared = null;
async function partQ() {
  section("Q1. Prepared pulls: only the client's low places");
  const qa = await newPass({ pull_mode: "prepare", pull_tags: [A, B, G], max_pull_size: 4 });
  const fa = await flagsOf(qa.id);
  const pa = await pullOf(qa.id, A);
  check("A: a prepared pull, and its low place says so", pa?.state === "prepared" && pa.mode === "prepare" &&
    fa.find((x) => x.client_tag === A && x.kind === "low").action === "prepared" && fa.find((x) => x.client_tag === A && x.kind === "low").pull_id === pa.id);
  check("B (churn) gets no pull", !(await pullOf(qa.id, B)) && fa.find((x) => x.client_tag === B).action === "cannot_receive");
  const g = fa.find((x) => x.client_tag === G);
  check("G (Canada Cleaning, no saved people filters): no pull, and the flag says why", !(await pullOf(qa.id, G)) && g.action === "no_people_filters" && /people filters/.test(g.reason), JSON.stringify(g));
  check("H is not on the pull list: no pull, and the flag says so", !(await pullOf(qa.id, H)) && fa.find((x) => x.client_tag === H).action === "not_on_pull_list");
  check("A's pull holds only its low place the geo reference knows (Peoria), not Springfield or the unknown city",
    JSON.stringify(pa.places) === JSON.stringify([IL("Peoria")]), JSON.stringify(pa.places));
  const includes = pa.requests.map((r) => r.contact.location.any.include);
  const excludes = pa.requests.map((r) => r.contact.location.any.exclude ?? []);
  check("its requests search Peoria only, with the client's excluded place kept",
    includes.every((i) => JSON.stringify(i) === JSON.stringify(["Peoria, Illinois"])) && excludes.every((e) => e.includes("Decatur, Illinois")), JSON.stringify({ includes, excludes }));
  check("its size is the leads missing there (4 minus 3), and its brake the run's", pa.size === 1 && Number(pa.brake) === brakeFor(1, pa.requests.length), `${pa.size} ${pa.brake}`);

  const qb = await newPass({ pull_tags: [A, B, G, H] });
  const old = await one(`SELECT state, note FROM topup_pulls WHERE id = $1`, [pa.id]);
  check("a new pass expires the pull an older one prepared and nobody started", old.state === "expired" && /newer weekly pass/.test(old.note));
  const ph = await pullOf(qb.id, H);
  check("H on the list: prepared, its size capped by max_pull_size (5 missing, 4 asked)", ph?.size === 4 && /4 \(the largest top-up pull\)/.test(ph.note), JSON.stringify(ph));
  prepared = { pass: qb, a: await pullOf(qb.id, A), h: ph };
}

// ── S. Counting and starting through the AI Ark routes ──────────────────────

async function partS(routes) {
  section("S1. Count a prepared pull");
  const { T: R, call } = routes;
  R.role = "manager";
  const pa = prepared.a;
  const counted = await call(routes.count.POST, { body: { tag: A, mode: "demo", topupPullId: pa.id } });
  const after = await one(`SELECT count_credits::float8 AS c, match_count, counted_at FROM topup_pulls WHERE id = $1`, [pa.id]);
  check("the count covers the pull's places and its credits go on the pull",
    counted.status === 200 && counted.body.credits === pa.requests.length && after.c === counted.body.credits && Number(after.match_count) === counted.body.total && after.counted_at,
    JSON.stringify({ body: counted.body, after }));
  const budget1 = await topupBudget(pool, { tag: A });
  check("the budget counts the count's credits", budget1.used === after.c && budget1.clientUsed === after.c && budget1.reserved === 0, JSON.stringify(budget1));
  check("a count of places that are not the pull's: refused",
    (await call(routes.count.POST, { body: { tag: A, mode: "demo", topupPullId: pa.id, places: [IL("Springfield")] } })).status === 400);
  check("a count of another client's pull: refused", (await call(routes.count.POST, { body: { tag: H, mode: "demo", topupPullId: pa.id } })).status === 404);

  section("S2. Start it: the run is a top-up run");
  const started = await call(routes.runs.POST, {
    body: { tag: A, mode: "demo", strategy: "single", size: pa.size, matchCount: counted.body.total, ...(await versions(A)), topupPullId: pa.id },
  });
  check("started: 201", started.status === 201, JSON.stringify(started.body));
  const run = await runOf(started.body.run.id);
  check("marked filters.topup = { pass, pull, places }", JSON.stringify(run.filters.topup) === JSON.stringify({ pass: prepared.pass.id, pull: pa.id, places: ["Peoria, IL"] }),
    JSON.stringify(run.filters.topup));
  check("recognised as a top-up run, in JavaScript and in SQL", isTopupRunFilters(run.filters) &&
    (await one(`SELECT filters ? 'topup' AS t FROM aiark_runs WHERE id = $1`, [run.id])).t === true);
  check("its requests search the pull's place only", run.requests.every((r) => JSON.stringify(r.contact.location.any.include) === JSON.stringify(["Peoria, Illinois"])));
  const pulled = await one(`SELECT * FROM topup_pulls WHERE id = $1`, [pa.id]);
  check("the pull is started, with the run, who started it and the run's brake",
    pulled.state === "started" && pulled.run_id === run.id && pulled.started_by === USER && Number(pulled.brake) === brakeFor(run.size_requested, run.requests.length));
  const fl = (await flagsOf(prepared.pass.id)).find((x) => x.client_tag === A && x.kind === "low");
  check("its flag says started, with the run", fl.action === "started" && fl.run_id === run.id);
  const again = await call(routes.runs.POST, {
    body: { tag: A, mode: "demo", strategy: "single", size: pa.size, matchCount: 1, ...(await versions(A)), topupPullId: pa.id },
  });
  check("starting it again: refused (a run is going)", again.status === 409 && again.body.code === "run_active");
  const batch = await one(
    `INSERT INTO upload_batches (filename, status, add_tags, aiark_run_id) VALUES ('tptest batch', 'completed', ARRAY[$2], $1) RETURNING id`, [run.id, A]);
  const seen = await one(`SELECT r.filters ? 'topup' AS t FROM upload_batches b JOIN aiark_runs r ON r.id = b.aiark_run_id WHERE b.id = $1`, [batch.id]);
  check("an import batch carrying the run is recognised as a top-up import (as the share step reads it)", seen.t === true);

  section("S3. A hand pull limited to some of a client's places");
  const hand = await call(routes.runs.POST, {
    body: { tag: C, mode: "demo", strategy: "single", size: 10, matchCount: 1, ...(await versions(C)), places: [IL("Peoria")] },
  });
  const hr = hand.status === 201 ? await runOf(hand.body.run.id) : null;
  check("started, its search limited to that place, and not marked as a top-up run",
    hand.status === 201 && JSON.stringify(hr.filters.places) === JSON.stringify(["Peoria, IL"]) && !isTopupRunFilters(hr.filters) &&
      hr.requests.every((r) => JSON.stringify(r.contact.location.any.include) === JSON.stringify(["Peoria, Illinois"])),
    JSON.stringify(hand.body));
  await pool.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [hr?.id]);
  const notOwn = await call(routes.runs.POST, {
    body: { tag: C, mode: "demo", strategy: "single", size: 10, matchCount: 1, ...(await versions(C)), places: [IL("Springfield")] },
  });
  check("a place that is not one of the client's: refused, nothing started", notOwn.status === 400 && /not one of the client's places/.test(notOwn.body.error), JSON.stringify(notOwn.body));
  check("places that are not a list: refused", (await call(routes.runs.POST, {
    body: { tag: C, mode: "demo", strategy: "single", size: 10, matchCount: 1, ...(await versions(C)), places: "Peoria" },
  })).status === 400);
}

// ── B. The budget ───────────────────────────────────────────────────────────

async function partB(routes) {
  section("B1. Reserved brakes, the budget and the day's pulls");
  const { T: R, call } = routes;
  R.role = "manager";
  const runA = await one(`SELECT r.*, p.brake::float8 AS pull_brake FROM topup_pulls p JOIN aiark_runs r ON r.id = p.run_id WHERE p.id = $1`, [prepared.a.id]);
  const b = await topupBudget(pool);
  const counts = (await one(`SELECT coalesce(sum(count_credits), 0)::float8 AS c FROM topup_pulls WHERE starts_with(client_tag, $1)`, [PREFIX])).c;
  check("used = top-up runs' credits plus count credits; held = each going run's brake less what it used",
    b.used === Number(runA.credits_used) + counts && b.reserved === runA.pull_brake - Number(runA.credits_used), JSON.stringify({ b, counts, brake: runA.pull_brake }));
  check("pulls started today: 1", (await pullsStartedToday(pool)) === 1);
  const ph = prepared.h;
  const start = async () =>
    call(routes.runs.POST, { body: { tag: H, mode: "demo", strategy: "single", size: ph.size, matchCount: 1, ...(await versions(H)), topupPullId: ph.id } });
  await topup({ weekly_credits: Math.ceil(b.used + b.reserved) + 1 });
  const r1 = await start();
  check("a pull whose brake would pass the weekly budget does not start", r1.status === 409 && r1.body.code === "budget", JSON.stringify(r1.body));
  const c1 = await call(routes.count.POST, { body: { tag: H, mode: "demo", topupPullId: ph.id } });
  check("nor may it be counted (its count and its brake must both fit)", c1.status === 409 && /budget/.test(c1.body.error), JSON.stringify(c1.body));
  await topup({ weekly_credits: 25000, client_weekly_credits: 1 });
  const r2 = await start();
  check("nor one that would pass the client's own budget", r2.status === 409 && r2.body.code === "budget");
  await topup({ client_weekly_credits: 25000, pulls_per_day: 1 });
  const r3 = await start();
  check("nor one past the day's pulls", r3.status === 409 && r3.body.code === "pulls_per_day" && /limit is 1/.test(r3.body.error), JSON.stringify(r3.body));
  await topup({ pulls_per_day: 3, pull_tags: [A, B, G] });
  const r4 = await start();
  check("nor one for a client off the pull list", r4.status === 409 && r4.body.code === "not_on_pull_list");
  await topup({ pull_tags: [A, B, G, H] });
  check("nothing was started by the refusals", (await one(`SELECT state FROM topup_pulls WHERE id = $1`, [ph.id])).state === "prepared" &&
    (await one(`SELECT count(*)::int AS n FROM aiark_runs WHERE client_tag = $1`, [H])).n === 0);
}

// ── A. Auto pulls ───────────────────────────────────────────────────────────

async function partA() {
  section("A1. Auto mode starts pulls itself, within the budget and the day's pulls");
  const pass = await newPass({ pull_mode: "auto", pull_tags: [A, G, H], pulls_per_day: 4 });
  check("the new pass expired the prepared pull of the last one", (await one(`SELECT state FROM topup_pulls WHERE id = $1`, [prepared.h.id])).state === "expired");
  const pa = await pullOf(pass.id, A);
  const ph = await pullOf(pass.id, H);
  check("auto pulls are written as waiting to start", pa?.mode === "auto" && pa.state === "prepared" && ph?.mode === "auto" && ph.state === "prepared");
  let settings = await readTopupSettings(pool);
  const s1 = await startWaitingPulls(pool, { settings, mode: "demo", geo, tagPrefix: PREFIX });
  const ha = await one(`SELECT * FROM topup_pulls WHERE id = $1`, [ph.id]);
  check("H starts; A waits for its run going", s1.started === 1 && s1.waiting === 1 && ha.state === "started" && ha.started_by === null, JSON.stringify(s1));
  const hrun = await runOf(ha.run_id);
  check("H's run: demo, single, no count, marked as a top-up run", hrun.mode === "demo" && hrun.strategy === "single" && hrun.match_count === null && hrun.created_by === null && isTopupRunFilters(hrun.filters));
  const fa = (await flagsOf(pass.id)).find((x) => x.client_tag === A && x.kind === "low");
  check("A's pull and flag say a run is going", (await one(`SELECT state, note FROM topup_pulls WHERE id = $1`, [pa.id])).state === "prepared" && fa.action === "run_active");
  await pool.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now() WHERE client_tag = $1 AND status IN ('queued', 'running')`, [A]);
  const b = await topupBudget(pool);
  await topup({ weekly_credits: Math.floor(b.used + b.reserved) + 5 });
  settings = await readTopupSettings(pool);
  const s2 = await startWaitingPulls(pool, { settings, mode: "demo", geo, tagPrefix: PREFIX });
  const fa2 = (await flagsOf(pass.id)).find((x) => x.client_tag === A && x.kind === "low");
  check("with no room left in the budget it waits", s2.started === 0 && s2.waiting === 1 && fa2.action === "budget", JSON.stringify(s2));
  await topup({ weekly_credits: 25000, pulls_per_day: 2 });
  settings = await readTopupSettings(pool);
  const s3 = await startWaitingPulls(pool, { settings, mode: "demo", geo, tagPrefix: PREFIX });
  const fa3 = (await flagsOf(pass.id)).find((x) => x.client_tag === A && x.kind === "low");
  check("with the day's pulls started it waits", s3.started === 0 && s3.waiting === 1 && fa3.action === "pulls_per_day", JSON.stringify(s3));
  await topup({ pulls_per_day: 4 });
  settings = await readTopupSettings(pool);
  const s4 = await startWaitingPulls(pool, { settings, mode: "demo", geo, tagPrefix: PREFIX });
  const astarted = await one(`SELECT * FROM topup_pulls WHERE id = $1`, [pa.id]);
  check("then it starts", s4.started === 1 && astarted.state === "started" && astarted.run_id, JSON.stringify(s4));
  check("prepare mode never starts anything by itself", (await startWaitingPulls(pool, { settings: { ...settings, weekly_topup: { ...settings.weekly_topup, pull_mode: "prepare" } }, mode: "demo", geo, tagPrefix: PREFIX })).started === 0);
}

// ── X. Churn ────────────────────────────────────────────────────────────────

async function partX() {
  section("X1. The hourly cancel");
  const handRun = await (async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const r = await createRun(c, { tag: B, mode: "demo", strategy: "single", size: 5, filters: { people: {} }, requests: [{ contact: {} }] });
      await c.query("COMMIT");
      return r;
    } finally {
      c.release();
    }
  })();
  const aRun = (await one(`SELECT run_id FROM topup_pulls WHERE client_tag = $1 AND state = 'started' ORDER BY started_at DESC LIMIT 1`, [A])).run_id;
  const hRun = (await one(`SELECT run_id FROM topup_pulls WHERE client_tag = $1 AND state = 'started' ORDER BY started_at DESC LIMIT 1`, [H])).run_id;
  const date = (await one(`SELECT ((now() AT TIME ZONE 'UTC')::date + 3)::text AS d`)).d;
  await pool.query(`UPDATE client_tags SET churn_cell_state = 'date', churn_date = $2::date, churn_cell = $2 WHERE tag = $1`, [A, date]);
  const cancelled = await cancelBlockedRuns(pool, { tagPrefix: PREFIX });
  const ar = await runOf(aRun);
  check("A's churn date is 3 days off: its top-up run is cancelled, with the reason", cancelled.length === 1 && cancelled[0].id === aRun &&
    ar.status === "cancelled" && ar.finished_at && ar.stop_reason.includes(`churn date ${date}`), JSON.stringify({ cancelled, stop: ar.stop_reason }));
  check("a run someone started by hand for a client that cannot receive is left alone", (await runOf(handRun.id)).status === "queued");
  check("a client that can still receive keeps its run", (await runOf(hRun)).status === "queued");

  section("X2. The AI Ark slice checks before any paid call");
  await pool.query(`UPDATE aiark_runs SET status = 'cancelled', finished_at = now() WHERE id = $1`, [handRun.id]);
  await pool.query(`UPDATE client_tags SET status = 'Paused' WHERE tag = $1`, [H]);
  const tx = createDemoTransport({});
  const clientFor = async () => ({ client: createAiArk({ token: DEMO_TOKEN, transport: tx, wait: async () => {}, rps: 5 }) });
  const worked = await advanceOneRun({ pool, env: { AIARK_DEMO: "1" }, clientFor, log: () => {} });
  const hr = await runOf(hRun);
  check("H is paused: its top-up run is cancelled at its next slice, with the reason, and nothing is bought",
    worked === hRun && hr.status === "cancelled" && /status Paused/.test(hr.stop_reason) && tx.state.previewCalls === 0 && tx.state.charged === 0 && Number(hr.credits_used) === 0,
    JSON.stringify({ worked, status: hr.status, stop: hr.stop_reason, calls: tx.state.previewCalls, charged: tx.state.charged }));
  await pool.query(`UPDATE client_tags SET status = 'Healthy' WHERE tag = $1`, [H]);
  await pool.query(`UPDATE client_tags SET churn_cell_state = 'empty', churn_date = NULL, churn_cell = NULL WHERE tag = $1`, [A]);
}

// ── O. Off, and the routes ──────────────────────────────────────────────────

async function partO(routes) {
  section("O1. Switched off, a firing writes nothing");
  await topup({ enabled: false });
  await setSetting("never_contact_inboxes", { enabled: false });
  const snap = () =>
    one(`SELECT (SELECT count(*)::int FROM topup_passes) AS passes, (SELECT count(*)::int FROM topup_pulls) AS pulls,
                (SELECT count(*)::int FROM topup_flags) AS flags, (SELECT count(*)::int FROM aiark_runs) AS runs,
                (SELECT count(*)::int FROM client_location_coverage) AS coverage`);
  const before = await snap();
  await pool.query(`UPDATE topup_passes SET finished_at = now() - interval '30 days' WHERE id = ANY($1::uuid[])`, [[...passIds]]);
  const out = await topupOnce(pool, { deadline: Date.now() + 60_000, mode: "demo", tagPrefix: PREFIX });
  check("nothing new: no pass, no pull, no flag, no run, no coverage row", JSON.stringify(await snap()) === JSON.stringify(before) &&
    out.pass === null && out.pulls === null && out.neverContact === null && out.cancelled === 0, JSON.stringify(out));
  await topup({ enabled: true, pull_mode: "off" });
  const on = await topupOnce(pool, { deadline: Date.now() + 60_000, mode: "demo", tagPrefix: PREFIX });
  if (on.pass?.id) passIds.add(on.pass.id);
  check("switched on, a firing runs the due pass", on.pass?.state === "done" && on.pulls === null, JSON.stringify(on));

  section("O2. The Low places routes");
  const { T: R, call } = routes;
  R.role = "viewer";
  check("a viewer cannot see the tab", (await call(routes.view.GET)).status === 403);
  R.role = "manager";
  await pool.query(`INSERT INTO client_stats (tag, leads, contactable) VALUES ($1, 161000, 150000)`, [H]);
  const v = await call(routes.view.GET);
  const h = v.body.clients?.find((c) => c.tag === H);
  check("a manager sees the newest pass, each client's places and its tag count beside", v.status === 200 && v.body.ready && v.body.pass?.id === on.pass.id &&
    h?.tagLeads === 161000 && h.places.length === 1 && h.places[0].available === 0, JSON.stringify(h));
  check("the settings and the budget are there", v.body.settings?.enabled === true && v.body.budget?.weekly === 25000 && typeof v.body.budget.used === "number");
  const b = v.body.clients.find((c) => c.tag === B);
  check("a client that cannot receive shows why", /churn date/.test(b?.receiveBlock ?? ""));
}

const t0 = Date.now();
try {
  const ready = await one(
    `SELECT to_regclass('public.topup_passes') IS NOT NULL AS passes, to_regprocedure('public.fn_client_receive_block(text)') IS NOT NULL AS fn,
            to_regclass('public.never_contact_inbox_runs') IS NOT NULL AS nc`
  );
  if (!ready.passes || !ready.fn || !ready.nc) throw new Error("migrations 132, 135 and 136 must be in this database");
  await cleanup();
  const busy = await one(
    `SELECT (SELECT count(*)::int FROM topup_passes WHERE state IN ('requested', 'running')) AS open,
            (SELECT count(*)::int FROM aiark_runs WHERE filters ? 'topup') AS topup_runs,
            (SELECT count(*)::int FROM topup_pulls) AS pulls,
            (SELECT count(*)::int FROM aiark_runs WHERE status IN ('queued', 'running')) AS due,
            (SELECT count(*)::int FROM worker_locks WHERE key = 'topup-worker') AS lease`
  );
  check("before the run: no open pass, no top-up run or pull, no AI Ark run due, no lease in this database",
    Object.values(busy).every((n) => n === 0), JSON.stringify(busy));
  if (!Object.values(busy).every((n) => n === 0)) throw new Error("not run: this database has top-up work or AI Ark runs going");
  settingsBefore = await all(`SELECT key, value FROM enrich_settings WHERE key IN ('weekly_topup', 'never_contact_inboxes')`);
  if (settingsBefore.length !== 2) throw new Error("the weekly_topup or never_contact_inboxes setting is missing");
  await topup(TOPUP_ON);
  await setSetting("never_contact_inboxes", { enabled: false, pattern: FILTER, sha256: sha(FILTER), source: "tptest stand-in", read_at: new Date().toISOString() });

  for (const r of await all(
    `SELECT g.city, g.geoname_id::text AS id FROM geo_locations g JOIN geo_admin1 a ON a.country_code = g.country_code AND a.admin1_code = g.admin1_code
      WHERE g.country_code = 'US' AND a.state_code = 'IL' AND g.city_key IN ('springfield', 'peoria', 'champaign', 'decatur')`
  )) {
    CITY[r.city] = r.id;
  }
  if (Object.keys(CITY).length !== 4) throw new Error("the geo reference lacks the Illinois test cities");
  geo = await loadGeo(pool);
  await addClient(A, { places: [IL("Springfield"), IL("Peoria"), IL("Zzyzxville")], exclude: [IL("Decatur")], min: 4 });
  const churnB = await addClient(B, { places: [IL("Peoria")], churnInDays: 5 });
  await addClient(C, { type: "Non-Cleaning", places: [IL("Peoria")] });
  await pool.query(`INSERT INTO client_people_filters (client_tag, titles) VALUES ($1, '{Office Manager}')`, [C]);
  await addClient(D, { places: [] });
  await addClient(E);
  await addClient(F, { status: "Paused", places: [IL("Peoria")] });
  await addClient(G, { type: "Canada Cleaning", places: [IL("Champaign")] });
  await addClient(H, { status: "Healthy", places: [IL("Champaign")] });
  await addClient(I, { places: [IL("Peoria")], onTab: false });
  for (let i = 0; i < 4; i++) await addLead(`owner${i}`, "personal", "Springfield");
  await addLead("owner", "personal", "Peoria");
  await addLead("tptest-box", "personal", "Peoria"); // a personal address with the filter's text: always counts
  await addLead("tptest-box", "general", "Peoria");
  await addLead("tptest-dept-info", "general", "Peoria");
  await addLead("office", "general", "Peoria"); // a general inbox the filter does not match: counts

  const loader = routeLoader(USER);
  const routes = {
    ...loader,
    count: await loader.route("aiark/count"),
    runs: await loader.route("aiark/runs"),
    view: await loader.route("topup"),
    run: await loader.route("topup/run"),
  };
  await partM();
  await partC();
  await partP(churnB, routes);
  await partL();
  await partQ();
  await partS(routes);
  await partB(routes);
  await partA();
  await partX();
  await partO(routes);
  check("nothing tried to reach any other address", net.calls.refused === 0, `${net.calls.refused} refused`);
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  for (const s of settingsBefore ?? []) {
    await pool.query(`UPDATE enrich_settings SET value = $2::jsonb WHERE key = $1`, [s.key, JSON.stringify(s.value)]).catch(() => {});
  }
  const left = await one(
    `SELECT (SELECT count(*)::int FROM client_tags WHERE starts_with(tag, $1)) AS clients,
            (SELECT count(*)::int FROM client_targeting WHERE starts_with(client_tag, $1)) AS targeting,
            (SELECT count(*)::int FROM leads WHERE email LIKE $2) AS leads,
            (SELECT count(*)::int FROM aiark_runs WHERE starts_with(client_tag, $1)) AS runs,
            (SELECT count(*)::int FROM topup_pulls WHERE starts_with(client_tag, $1)) AS pulls,
            (SELECT count(*)::int FROM topup_flags WHERE starts_with(client_tag, $1)) AS flags,
            (SELECT count(*)::int FROM topup_passes WHERE id = ANY($3::uuid[])) AS passes,
            (SELECT count(*)::int FROM enrich_tables WHERE starts_with(client_tag, $1)) AS tables,
            (SELECT count(*)::int FROM client_location_coverage WHERE starts_with(client_tag, $1)) AS coverage,
            (SELECT count(*)::int FROM worker_locks WHERE key = 'topup-worker') AS lease`,
    [PREFIX, `%.${HOST}`, [...passIds]]
  );
  const now = await all(`SELECT key, value FROM enrich_settings WHERE key IN ('weekly_topup', 'never_contact_inboxes') ORDER BY key`);
  const back = settingsBefore
    ? JSON.stringify(now) === JSON.stringify([...settingsBefore].sort((x, y) => x.key.localeCompare(y.key)))
    : true;
  const clean = Object.values(left).every((n) => n === 0) && back;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, settingsBack: back })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
