#!/usr/bin/env node
// Never-contact inboxes (migration 136): the seed, the dry run, the apply and
// its sweep, the follow step for new imports, the routes and the command.
// LOCAL DATABASE ONLY. Everything here is made up: Clay originals as variants
// nctest_a to nctest_g (never the real "default" variant), a stand-in filter,
// leads, Bison mirror rows and never-contact addresses under .nctest.example.
// The never_contact_inboxes setting is put back at the end and everything else
// the run made is removed. No other test's rows are touched.
//
//   node --env-file=.env.local scripts/test-never-contact-inboxes.mjs
//
// Do not start the topup-worker for this: its never-contact step (sweep) runs
// here as exported. Nothing reaches a network and no paid key is read.
//
//   S. the seed: the picking rule (the filter most columns share, which must
//      hold the marker; ties and none are "not loaded"), bad shapes refused,
//      what it writes and what it leaves alone, the command
//   D. the dry run: the count, a sample for each part, nothing written
//   A. the apply: its refusals, the switch off, the pace and the daily cap,
//      personal and untyped addresses never touched, an address already on
//      the list left as it is, the Bison queue, idempotent, the follow step
//      for new imports, stop, a changed filter
//   R. the routes: who may do what, the status never holds the filter

import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { checker, dropPaidKeys, installNet, localDatabaseUrl, routeLoader } from "./fixtures/test-support.mjs";
import { inboxPatternOf, settingsFrom } from "./lib/enrich/settings.mjs";
import {
  dryRun, filterParts, negatedFilterLiterals, neverContactStatus, pickFilter, readFilter, seedFilter, startApply, stopApply, sweep,
} from "./lib/never-contact-inboxes.mjs";
import { generalInboxMatches, NEVER_CONTACT_REASON } from "./lib/overlap-topup.mjs";

const url = localDatabaseUrl();
dropPaidKeys();
const net = installNet();
const count = checker();
const { check, section } = count;

const pool = new pg.Pool({ connectionString: url, max: 6 });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const all = async (sql, params) => (await pool.query(sql, params)).rows;
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

const RUN = randomUUID().slice(0, 6);
const HOST = "nctest.example";
const LIKE = `%.${HOST}`;
const ADMIN = randomUUID();
// The made-up stand-in filter: four parts, one with the \. escape, one holding the marker.
const P = "nctest-box@|nctestdept|nctestzone\\.nctest|customerservice@nctest";
const Q = "nctest-quiet@|nctest-other-dept"; // a second filter with no marker
const P2 = "nctest-moved@|customerservice@nctest"; // another usable filter, for "the filter changed"
const VARIANTS = ["nctest_a", "nctest_b", "nctest_c", "nctest_d", "nctest_e", "nctest_f", "nctest_g"];
const neg = (re, ref = "{{f_email}}") => `!/${re}/i.test(${ref})`;
const CLI = new URL("./never-contact-inboxes.mjs", import.meta.url).pathname;

/** The setting as it was before the run, put back at the end. */
let settingBefore = null;
const runIds = new Set();

async function setSetting(over) {
  await pool.query(
    `UPDATE enrich_settings SET value = value || $1::jsonb WHERE key = 'never_contact_inboxes'`,
    [JSON.stringify(over)]
  );
}
const setting = async () => (await one(`SELECT value FROM enrich_settings WHERE key = 'never_contact_inboxes'`)).value;

async function addOriginals(variant, formulas) {
  let pos = 0;
  for (const f of formulas) {
    pos++;
    await pool.query(
      `INSERT INTO enrich_originals (variant, template_kind, position, key, name, clay_field_id, clay_type, clay_action, definition, source_sha256, seeded_by)
       VALUES ($1, 'inboxes', $2, $3, $4, $5, 'action', 'nctest-action', $6::jsonb, $7, 'nctest')`,
      [variant, pos, `nctest_col_${pos}`, `G${pos} made-up column`, `f_nctest_${variant}_${pos}`,
        JSON.stringify({ settings: f == null ? {} : { conditionalRunFormulaText: f } }), "0".repeat(64)]
    );
  }
}

let leadSeq = 0;
/** A made-up lead, created `ago` before now (in order of creation). */
async function addLead(email, emailType, { ago = "2 hours" } = {}) {
  leadSeq++;
  const { rows: [r] } = await pool.query(
    `INSERT INTO leads (email, email_type, company, created_at)
     VALUES ($1, $2, 'nctest lead', now() - $3::interval + make_interval(secs => $4))
     RETURNING id, email, is_suppressed`,
    [email, emailType, ago, leadSeq / 1000]
  );
  return r;
}
const leadOf = (email) => one(`SELECT id, email, is_suppressed FROM leads WHERE email = $1`, [email]);
const listed = (email) => one(`SELECT email, reason, notes, suppressed_by FROM suppressed_emails WHERE email = $1`, [email]);

async function cleanup() {
  await pool.query(`DELETE FROM bison_unsubscribe_queue WHERE email LIKE $1`, [LIKE]);
  await pool.query(`DELETE FROM bison_leads WHERE email LIKE $1`, [LIKE]);
  await pool.query(`DELETE FROM suppressed_emails WHERE email LIKE $1`, [LIKE]);
  await pool.query(`DELETE FROM leads WHERE email LIKE $1`, [LIKE]);
  await pool.query(`DELETE FROM enrich_originals WHERE variant = ANY($1::text[])`, [VARIANTS]);
  const shas = [P, Q, P2].map(sha);
  // Applies first: they name their dry runs.
  await pool.query(`DELETE FROM never_contact_inbox_runs WHERE kind = 'apply' AND (id = ANY($1::uuid[]) OR pattern_sha256 = ANY($2::text[]))`, [[...runIds], shas]);
  await pool.query(`DELETE FROM never_contact_inbox_runs WHERE id = ANY($1::uuid[]) OR pattern_sha256 = ANY($2::text[])`, [[...runIds], shas]);
}

// ── S. The seed ─────────────────────────────────────────────────────────────

async function partS() {
  section("S1. The run conditions and the picking rule (pure)");
  check("a negated, case blind literal is read; a plain one, or one without the i flag, is not",
    JSON.stringify(negatedFilterLiterals(`${neg(P)} && /${Q}/i.test({{a}}) && !/${Q}/.test({{b}})`)) === JSON.stringify([P]));
  check("the escape \\. stays as written", negatedFilterLiterals(neg("a\\.b|c"))[0] === "a\\.b|c");
  const cols = (...fs) => fs.map((formula) => ({ formula }));
  const most = pickFilter(cols(neg(P), neg(P), `${neg(P)} && ${neg(P, "{{f_other}}")}`, neg(Q), neg(Q), null, `/${P}/i.test({{x}})`));
  check("the filter most columns share wins; a column holding it twice counts once; columns without one are not counted",
    most.pattern === P && most.used === 3 && most.total === 5, JSON.stringify(most));
  const tie = pickFilter(cols(neg(P), neg(P), neg(Q), neg(Q)));
  check("a tie at the top is not loaded, and says so", tie.pattern === null && /each shared by 2/.test(tie.why), JSON.stringify(tie));
  const noMarker = pickFilter(cols(neg(Q), neg(Q), neg(Q), neg(P)));
  check("a top filter without the marker is not loaded", noMarker.pattern === null && /does not hold customerservice@/.test(noMarker.why), JSON.stringify(noMarker));
  const none = pickFilter(cols(null, "{{f_a}} != ''"));
  check("no filter at all is not loaded", none.pattern === null && none.total === 0 && /holds a filter/.test(none.why));
  check("the marker is matched in any case", pickFilter(cols(neg("NCTEST-x@|CustomerService@nctest"))).pattern === "NCTEST-x@|CustomerService@nctest");

  section("S2. Reading the made-up originals");
  await addOriginals("nctest_a", [neg(P), `{{f_x}} && ${neg(P)}`, `${neg(P)} && ${neg(P, "{{f_email2}}")}`, neg(Q), neg(Q), `/${P}/i.test({{f_email}})`, `!/${P}/.test({{f_email}})`, null]);
  await addOriginals("nctest_b", [neg(P), neg(P), neg(Q), neg(Q)]);
  await addOriginals("nctest_c", [neg(Q), neg(Q), neg(Q), neg(P)]);
  await addOriginals("nctest_d", [neg("nctest(box)@|customerservice@nctest"), neg("nctest(box)@|customerservice@nctest")]);
  await addOriginals("nctest_e", [neg("nctest-box@||customerservice@nctest")]);
  await addOriginals("nctest_f", [null, "{{f_a}} != ''"]);
  await addOriginals("nctest_g", [neg(P2)]);
  const a = await readFilter(pool, { variant: "nctest_a" });
  check("variant nctest_a: the shared filter, with where it was read", a.pattern === P && a.sha256 === sha(P) && a.source === "nctest_a inboxes: 3 of 5 run conditions", JSON.stringify({ ...a, pattern: a.pattern === P }));
  check("a tie (nctest_b) and a top filter without the marker (nctest_c) are not loaded",
    (await readFilter(pool, { variant: "nctest_b" })).pattern === null && (await readFilter(pool, { variant: "nctest_c" })).pattern === null);
  const d = await readFilter(pool, { variant: "nctest_d" });
  const e = await readFilter(pool, { variant: "nctest_e" });
  check("a filter with a group, or an empty part, is refused by the shape check", d.pattern === null && /shape/.test(d.why) && e.pattern === null && /shape/.test(e.why), `${d.why} | ${e.why}`);
  check("no run condition with a filter, or no such variant, is not loaded",
    (await readFilter(pool, { variant: "nctest_f" })).pattern === null && /no General inboxes columns/.test((await readFilter(pool, { variant: "nctest_zz" })).why));
  check("the shape check is the settings' own (a wrong sha reads as not loaded)",
    inboxPatternOf({ pattern: P, sha256: sha(P) }) === P && inboxPatternOf({ pattern: P, sha256: sha(Q) }) === null);

  section("S3. The seed writes the filter, and only the filter");
  await setSetting({ enabled: false, pattern: null, source: null, sha256: null, read_at: null, rows_per_day: 777, chunk_rows: 55 });
  const before = await setting();
  const bad = await seedFilter(pool, { variant: "nctest_b" });
  check("a seed that reads no filter writes nothing", bad.loaded === false && JSON.stringify(await setting()) === JSON.stringify(before), JSON.stringify(bad));
  const ok = await seedFilter(pool, { variant: "nctest_a" });
  const after = await setting();
  check("the seed stores pattern, source, sha256 and read_at", ok.loaded && after.pattern === P && after.sha256 === sha(P) &&
    after.source === "nctest_a inboxes: 3 of 5 run conditions" && Boolean(Date.parse(after.read_at)) && ok.parts === 4 && ok.changed === true);
  check("the switch and the pace are left as they were", after.enabled === false && after.rows_per_day === 777 && after.chunk_rows === 55);
  const s = settingsFrom([{ key: "never_contact_inboxes", value: after }]);
  check("the settings read it as loaded, and the switch stays off", s.never_contact_inboxes.pattern === P && s.flagOn("never_contact_inboxes", "") === false);
  const again = await seedFilter(pool, { variant: "nctest_a" });
  check("seeding the same filter again says it is the same", again.loaded && again.changed === false);

  section("S4. The command");
  const env = { ...process.env, DATABASE_URL: url };
  const out = execFileSync(process.execPath, [CLI, "--seed", "--variant", "nctest_a"], { env, encoding: "utf8" });
  check("--seed prints where, how many parts and the sha, never the filter",
    /Loaded from nctest_a inboxes: 3 of 5 run conditions: 4 parts, sha256 [0-9a-f]{12}/.test(out) && !out.includes(P), out.trim());
  let refused = null;
  try {
    execFileSync(process.execPath, [CLI, "--seed", "--variant", "nctest_c"], { env, encoding: "utf8" });
  } catch (err) {
    refused = String(err.stdout ?? "");
  }
  check("--seed of a variant with no usable filter exits 1 and writes nothing", refused !== null && /Not loaded/.test(refused) && (await setting()).pattern === P, refused ?? "exit 0");
}

// ── D. The dry run ──────────────────────────────────────────────────────────

const L = {};
async function seedLeads() {
  for (let i = 1; i <= 6; i++) L[`g${i}`] = await addLead(`nctest-box@g${i}-${RUN}.${HOST}`, "general");
  L.dept = await addLead(`info@nctestdept-${RUN}.${HOST}`, "general");
  L.zone = await addLead(`hello-${RUN}@nctestzone.${HOST}`, "general");
  L.zoneX = await addLead(`hello-${RUN}@sub.nctestzoneXnctest.${HOST}`, "general"); // the escaped dot: no match
  L.cs = await addLead(`customerservice@nctest-${RUN}.${HOST}`, "general");
  L.plain = await addLead(`office@plain-${RUN}.${HOST}`, "general");
  L.personal = await addLead(`nctest-box@p-${RUN}.${HOST}`, "personal");
  L.untyped = await addLead(`nctest-box@n-${RUN}.${HOST}`, null);
  // Already never contact, for another reason: left exactly as it is.
  await pool.query(
    `INSERT INTO suppressed_emails (email, reason, notes) VALUES ($1, 'nctest other reason', 'made up')`, [`nctest-box@pre-${RUN}.${HOST}`]);
  L.pre = await addLead(`nctest-box@pre-${RUN}.${HOST}`, "general");
  // Bison holds two of them: g1 on two installs, g2 on one.
  for (const [email, inst, id] of [[L.g1.email, "https://one.nctest.example", 1], [L.g1.email, "https://two.nctest.example", 2], [L.g2.email, "https://one.nctest.example", 3]]) {
    await pool.query(`INSERT INTO bison_leads (instance_url, bison_id, email) VALUES ($1, $2, $3)`, [inst, 990_000_000 + id, email]);
  }
}
const MATCHING = () => [L.g1, L.g2, L.g3, L.g4, L.g5, L.g6, L.dept, L.zone, L.cs];

async function partD() {
  section("D1. The JavaScript test agrees with Postgres on the made-up leads");
  const rows = await all(`SELECT email, email_type, coalesce(email_type = 'general' AND email ~* $1, false) AS hit FROM leads WHERE email LIKE $2`, [P, LIKE]);
  check("generalInboxMatches() and ~* agree on every made-up lead", rows.every((r) => generalInboxMatches(P, r.email, r.email_type) === r.hit) && rows.length === 14, `${rows.length} leads`);

  section("D2. The count and a sample for each part");
  const listBefore = await one(`SELECT count(*)::int AS n FROM suppressed_emails`);
  const flaggedBefore = await one(`SELECT count(*)::int AS n FROM leads WHERE is_suppressed`);
  const r = await dryRun(pool, { by: ADMIN });
  runIds.add(r.run.id);
  const parts = r.run.sample.parts;
  check("the count: general inboxes the filter matches that are not on the list yet (9 of 14 made-up leads)",
    r.run.counted === 9 && r.run.kind === "dry_run" && r.run.state === "done" && r.run.pattern_sha256 === sha(P) && r.run.bound_at, JSON.stringify(r.run.counted));
  check("one line for each part, in the filter's order",
    JSON.stringify(parts.map((p) => p.part)) === JSON.stringify(filterParts(P)), JSON.stringify(parts.map((p) => p.part)));
  check("each part's count, and at most 5 addresses as a sample",
    parts[0].count === 6 && parts[0].sample.length === 5 && parts[1].count === 1 && parts[2].count === 1 && parts[3].count === 1 &&
      parts[0].sample.every((x) => x.startsWith("nctest-box@g")), JSON.stringify(parts.map((p) => [p.count, p.sample.length])));
  check("the escaped dot: an address with another character there is not counted", !parts.some((p) => p.sample.includes(L.zoneX.email)));
  check("personal, untyped and already listed addresses are not counted",
    !parts.some((p) => p.sample.some((x) => [L.personal.email, L.untyped.email, L.pre.email].includes(x))));
  check("a dry run writes nothing to leads or the list",
    (await one(`SELECT count(*)::int AS n FROM suppressed_emails`)).n === listBefore.n && (await one(`SELECT count(*)::int AS n FROM leads WHERE is_suppressed`)).n === flaggedBefore.n);
  return r.run;
}

// ── A. The apply ────────────────────────────────────────────────────────────

async function partA(dry) {
  section("A1. Refusals");
  await setSetting({ enabled: false, rows_per_day: 4, chunk_rows: 3 });
  let r = await startApply(pool, { dryRunId: dry.id, by: ADMIN });
  check("switched off: refused", r.status === 409 && /switched off/.test(r.error), JSON.stringify(r));
  let threw = null;
  try {
    await pool.query(`SELECT * FROM fn_suppress_general_inboxes(ARRAY[$1::uuid], $2, $3)`, [L.g1.id, sha(P), randomUUID()]);
  } catch (e) {
    threw = e.code;
  }
  check("switched off: the writer itself refuses (object_not_in_prerequisite_state)", threw === "55000", String(threw));
  const off = await sweep(pool, {});
  check("switched off: the sweep does nothing", off.idle !== null && off.suppressed === 0 && !(await listed(L.g1.email)));
  await setSetting({ enabled: true });
  r = await startApply(pool, { dryRunId: randomUUID(), by: ADMIN });
  check("an id that is no dry run: refused", r.status === 404);
  await pool.query(`UPDATE never_contact_inbox_runs SET created_at = now() - interval '25 hours' WHERE id = $1`, [dry.id]);
  r = await startApply(pool, { dryRunId: dry.id, by: ADMIN });
  check("a dry run more than 24 hours old: refused", r.status === 409 && /24 hours/.test(r.error), JSON.stringify(r));
  await pool.query(`UPDATE never_contact_inbox_runs SET created_at = now() WHERE id = $1`, [dry.id]);
  const otherDry = await one(
    `INSERT INTO never_contact_inbox_runs (kind, state, pattern_sha256, bound_at, counted) VALUES ('dry_run', 'done', $1, now(), 1) RETURNING id`, [sha(Q)]);
  runIds.add(otherDry.id);
  r = await startApply(pool, { dryRunId: otherDry.id, by: ADMIN });
  check("a dry run of another filter: refused", r.status === 409 && /another filter/.test(r.error), JSON.stringify(r));
  await setSetting({ pattern: null });
  r = await startApply(pool, { dryRunId: dry.id, by: ADMIN });
  check("no filter loaded: refused", r.status === 409 && /not loaded/.test(r.error), JSON.stringify(r));
  await setSetting({ pattern: P });

  section("A2. The apply, paced");
  r = await startApply(pool, { dryRunId: dry.id, by: ADMIN });
  runIds.add(r.run?.id);
  check("an approved dry run starts an apply: running, the dry run's bound and count", r.run?.state === "running" && r.run.dry_run_id === dry.id &&
    new Date(r.run.bound_at).getTime() === new Date(dry.bound_at).getTime() && r.run.counted === 9, JSON.stringify(r));
  const twice = await startApply(pool, { dryRunId: dry.id, by: ADMIN });
  check("a second apply while one is going: refused", twice.status === 409 && /already running/.test(twice.error));
  const s1 = await sweep(pool, {});
  check("first firing: stops at the day's cap (4), in chunks of 3", s1.suppressed === 4 && s1.capped === true && s1.state === "running", JSON.stringify(s1));
  const today = await one(`SELECT count(*)::int AS n FROM suppressed_emails WHERE reason = $1 AND email LIKE $2`, [NEVER_CONTACT_REASON, LIKE]);
  check("the list holds 4 addresses with the reason clay_general_filter", today.n === 4);
  const g1 = await listed(L.g1.email);
  check("each one names the run and the filter's first 12, and who applied it",
    g1 && g1.notes.includes(r.run.id) && g1.notes.includes(sha(P).slice(0, 12)) && g1.suppressed_by === ADMIN, JSON.stringify(g1));
  const s2 = await sweep(pool, {});
  check("the same day again: nothing more", s2.suppressed === 0 && s2.capped === true, JSON.stringify(s2));
  const dayAfter = () => pool.query(
    `UPDATE suppressed_emails SET created_at = created_at - interval '1 day' WHERE reason = $1 AND email LIKE $2`, [NEVER_CONTACT_REASON, LIKE]);
  await dayAfter();
  const s3 = await sweep(pool, {});
  check("the next day: 4 more, the cut chunk done again without marking anyone twice", s3.suppressed === 4 && s3.capped === true, JSON.stringify(s3));
  await dayAfter();
  const s4 = await sweep(pool, {});
  const run = await one(`SELECT * FROM never_contact_inbox_runs WHERE id = $1`, [r.run.id]);
  check("the day after: the last one, then the backlog is done and the apply follows new imports",
    s4.suppressed === 1 && s4.capped === false && run.state === "following" && run.suppressed === 9, JSON.stringify({ s4, state: run.state, suppressed: run.suppressed }));
  const matching = await all(`SELECT l.email, l.is_suppressed, s.reason FROM leads l LEFT JOIN suppressed_emails s ON s.email = l.email WHERE l.id = ANY($1::uuid[])`, [MATCHING().map((x) => x.id)]);
  check("every counted address is on the list with the reason, and its lead flagged",
    matching.length === 9 && matching.every((m) => m.is_suppressed && m.reason === NEVER_CONTACT_REASON), JSON.stringify(matching.filter((m) => !m.is_suppressed || m.reason !== NEVER_CONTACT_REASON)));
  check("the run's counts: 9 marked, 9 leads flagged", run.leads_flagged === 9, JSON.stringify({ flagged: run.leads_flagged }));
  for (const [name, lead] of [["a personal address", L.personal], ["an untyped address", L.untyped], ["a general inbox the filter does not match", L.plain], ["the escaped dot's near miss", L.zoneX]]) {
    const now = await leadOf(lead.email);
    check(`${name} is never touched`, now.is_suppressed === false && !(await listed(lead.email)));
  }
  const pre = await listed(L.pre.email);
  check("an address already on the list keeps its own reason and notes", pre.reason === "nctest other reason" && pre.notes === "made up");
  const q = await all(`SELECT email, instance_url, action, status, requested_by FROM bison_unsubscribe_queue WHERE email LIKE $1 ORDER BY email, instance_url`, [LIKE]);
  check("Bison: one unsubscribe queued for each install the mirror holds the address on (g1 twice, g2 once)",
    q.length === 3 && q.every((x) => x.action === "unsubscribe" && x.status === "pending" && x.requested_by === ADMIN) &&
      q.filter((x) => x.email === L.g1.email).length === 2 && run.bison_queued === 3, JSON.stringify(q));
  const s5 = await sweep(pool, {});
  check("idempotent: another firing marks nothing", s5.suppressed === 0 && (await one(`SELECT suppressed FROM never_contact_inbox_runs WHERE id = $1`, [r.run.id])).suppressed === 9);

  section("A3. Following new imports");
  const fresh = await addLead(`nctest-box@new1-${RUN}.${HOST}`, "general", { ago: "10 minutes" });
  const tooNew = await addLead(`nctest-box@new2-${RUN}.${HOST}`, "general", { ago: "0 seconds" });
  const s6 = await sweep(pool, {});
  check("a general inbox imported 10 minutes ago is marked; one imported now waits for the next firing",
    s6.suppressed === 1 && (await leadOf(fresh.email)).is_suppressed && !(await listed(tooNew.email)), JSON.stringify(s6));
  const newPersonal = await addLead(`nctest-box@new3-${RUN}.${HOST}`, "personal", { ago: "9 minutes" });
  await sweep(pool, {});
  check("a new personal address is never touched", !(await listed(newPersonal.email)));

  section("A4. Stop");
  const stopped = await stopApply(pool);
  check("stop ends the apply", stopped?.id === r.run.id && stopped.state === "stopped" && stopped.finished_at);
  const after = await addLead(`nctest-box@new4-${RUN}.${HOST}`, "general", { ago: "8 minutes" });
  const s7 = await sweep(pool, {});
  check("after stop nothing is marked", s7.idle === "no apply" && !(await listed(after.email)));
  check("stopping again finds nothing", (await stopApply(pool)) === null);

  section("A5. A changed filter");
  const dry2 = await dryRun(pool, { by: ADMIN });
  runIds.add(dry2.run.id);
  const live = await startApply(pool, { dryRunId: dry2.run.id, by: ADMIN });
  runIds.add(live.run?.id);
  const reseed = await seedFilter(pool, { variant: "nctest_g" });
  const was = await one(`SELECT state, last_error FROM never_contact_inbox_runs WHERE id = $1`, [live.run.id]);
  check("reading a different filter stops the apply of the old one", reseed.changed && reseed.stoppedApply === live.run.id && was.state === "stopped" && /different/.test(was.last_error), JSON.stringify({ reseed, was }));
  const stale = await one(
    `INSERT INTO never_contact_inbox_runs (kind, state, pattern_sha256, dry_run_id, bound_at, counted, started_at)
     VALUES ('apply', 'running', $1, $2, now(), 0, now()) RETURNING id`, [sha(P), dry2.run.id]);
  runIds.add(stale.id);
  const s8 = await sweep(pool, {});
  const st = await one(`SELECT state, last_error FROM never_contact_inbox_runs WHERE id = $1`, [stale.id]);
  check("an apply of a filter that is no longer loaded ends as an error, and marks nothing", s8.suppressed === 0 && st.state === "error" && /changed/.test(st.last_error), JSON.stringify({ s8, st }));
  await seedFilter(pool, { variant: "nctest_a" });
}

// ── R. The routes and the status ────────────────────────────────────────────

async function partR() {
  section("R1. The status never holds the filter");
  const status = await neverContactStatus(pool);
  check("loaded, with source, the first 12 of the sha and the number of parts", status.loaded && status.sha12 === sha(P).slice(0, 12) && status.parts === 4 && status.source.startsWith("nctest_a"));
  const { T, route, call } = routeLoader(ADMIN);
  const [view, dry, apply, stop] = await Promise.all([
    route("never-contact-inboxes"), route("never-contact-inboxes/dry-run"), route("never-contact-inboxes/apply"), route("never-contact-inboxes/stop"),
  ]);
  T.role = "viewer";
  check("a viewer cannot see it", (await call(view.GET)).status === 403);
  T.role = "manager";
  const got = await call(view.GET);
  check("a manager sees the status, which never holds the whole filter", got.status === 200 && got.body.ready && got.body.loaded && !JSON.stringify(got.body).includes(P), JSON.stringify(got.body).slice(0, 300));
  check("a manager may not run a dry run, apply or stop",
    (await call(dry.POST)).status === 403 && (await call(apply.POST, { body: { dryRunId: randomUUID() } })).status === 403 && (await call(stop.POST)).status === 403);
  T.role = "admin";
  const d = await call(dry.POST);
  runIds.add(d.body?.run?.id);
  check("an admin's dry run: 201, counted, audited", d.status === 201 && Number.isInteger(d.body.run.counted) && T.audits.some((a) => a.action === "never_contact_inboxes_dry_run"), JSON.stringify(d));
  check("a bad apply body: 400", (await call(apply.POST, { body: { dryRunId: "nope" } })).status === 400);
  const ap = await call(apply.POST, { body: { dryRunId: d.body.run.id } });
  runIds.add(ap.body?.run?.id);
  check("an admin's apply: 201, audited", ap.status === 201 && ap.body.run.state === "running" && T.audits.some((a) => a.action === "never_contact_inboxes_apply"), JSON.stringify(ap));
  const view2 = await call(view.GET);
  check("the status shows the live apply and the newest dry run with its parts",
    view2.body.live?.id === ap.body.run.id && view2.body.latestDryRun?.id === d.body.run.id && view2.body.latestDryRun.sample.parts.length === 4);
  const sp = await call(stop.POST);
  check("an admin's stop: 200, audited; a second stop finds nothing (409)",
    sp.status === 200 && sp.body.run.state === "stopped" && T.audits.some((a) => a.action === "never_contact_inboxes_stop") && (await call(stop.POST)).status === 409);

  section("R2. The command's dry run");
  const out = execFileSync(process.execPath, [CLI, "--dry-run"], { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
  const id = /Dry run ([0-9a-f-]{36})/.exec(out)?.[1];
  runIds.add(id);
  check("--dry-run prints the count and each part with its sample, never the whole filter, and writes no mark",
    Boolean(id) && /general inboxes match/.test(out) && filterParts(P).every((p) => out.includes(p)) && !out.includes(P), out.trim().slice(0, 400));
}

const t0 = Date.now();
try {
  const ready = await one(
    `SELECT to_regclass('public.never_contact_inbox_runs') IS NOT NULL AS runs,
            to_regprocedure('public.fn_suppress_general_inboxes(uuid[], text, uuid, uuid, text)') IS NOT NULL AS fn`
  );
  if (!ready.runs || !ready.fn) throw new Error("migration 136 is not in this database");
  await cleanup();
  settingBefore = await one(`SELECT value FROM enrich_settings WHERE key = 'never_contact_inboxes'`);
  if (!settingBefore) throw new Error("the never_contact_inboxes setting is missing");
  const busy = await one(
    `SELECT (SELECT count(*)::int FROM never_contact_inbox_runs WHERE kind = 'apply' AND state IN ('running', 'following')) AS live,
            (SELECT count(*)::int FROM suppressed_emails WHERE reason = $1) AS marked`,
    [NEVER_CONTACT_REASON]
  );
  check("before the run: no apply going and no address with the reason in this database", busy.live === 0 && busy.marked === 0, JSON.stringify(busy));
  if (busy.live || busy.marked) throw new Error("not run: this database already has never-contact inbox work");
  await partS();
  await seedLeads();
  const others = await one(`SELECT count(*)::int AS n FROM leads WHERE email_type = 'general' AND email ~* $1 AND email NOT LIKE $2`, [P, LIKE]);
  check("no lead outside this test matches the stand-in filter", others.n === 0);
  if (others.n) throw new Error("not run: other leads match the stand-in");
  const dry = await partD();
  await partA(dry);
  await partR();
  check("nothing tried to reach any other address", net.calls.refused === 0, `${net.calls.refused} refused`);
} catch (e) {
  count.failed++;
  console.error("\nUNEXPECTED:", e);
} finally {
  await cleanup().catch((e) => console.error("cleanup failed:", e.message));
  if (settingBefore) {
    await pool.query(`UPDATE enrich_settings SET value = $1::jsonb WHERE key = 'never_contact_inboxes'`, [JSON.stringify(settingBefore.value)]).catch(() => {});
  }
  const left = await one(
    `SELECT (SELECT count(*)::int FROM leads WHERE email LIKE $1) AS leads,
            (SELECT count(*)::int FROM suppressed_emails WHERE email LIKE $1) AS listed,
            (SELECT count(*)::int FROM bison_unsubscribe_queue WHERE email LIKE $1) AS queued,
            (SELECT count(*)::int FROM bison_leads WHERE email LIKE $1) AS mirror,
            (SELECT count(*)::int FROM enrich_originals WHERE variant = ANY($2::text[])) AS originals,
            (SELECT count(*)::int FROM never_contact_inbox_runs WHERE id = ANY($3::uuid[])) AS runs`,
    [LIKE, VARIANTS, [...runIds].filter(Boolean)]
  );
  const now = await one(`SELECT value FROM enrich_settings WHERE key = 'never_contact_inboxes'`);
  const settingBack = !settingBefore || JSON.stringify(now?.value) === JSON.stringify(settingBefore.value);
  const clean = Object.values(left).every((n) => n === 0) && settingBack;
  console.log(`\ncleaned up: ${clean ? "yes" : `NO ${JSON.stringify({ ...left, settingBack })}`}`);
  console.log(`${count.passed} passed, ${count.failed} failed (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  await pool.end();
  process.exit(count.failed || !clean ? 1 : 0);
}
