#!/usr/bin/env node
// The Clay tab's enrichment worker (Phase 1 of the Clay replacement).
//
// Flow: claim queued enrich_rows (FOR UPDATE SKIP LOCKED, one claim token per
// claim) → load the row's cells → evaluate every column in dependency order
// (scripts/lib/enrich/engine.mjs: the client's own Clay formulas, waterfalls
// and run conditions, plus the actions behind them) → write the cells that
// changed → mark the row done / waiting (a provider key is missing) / error,
// or re-queue it with backoff when a call failed for a reason worth retrying.
//
// Rows run concurrently and independently: a slow AI call never holds up the
// others, and a free slot is refilled as soon as a row finishes: the loop
// claims again at once (a claim that took rows with slots still free asks
// again at once too), and waits ENRICH_POLL_MS only when nothing was
// claimable. The 60-second housekeeping block (the stale sweep, the releases,
// the moves and the hand-back) and the 10-second heartbeat run beside the rows,
// not awaited, each with a busy flag, on a pool of their own (3 connections),
// so neither leaves a slot empty or takes a connection a row is waiting for.
//
// A rate limit is waited out in place (scripts/lib/enrich/http.mjs
// paidHttpJson): a 429 from OpenAI (the AI columns) or from Findymail,
// Prospeo, Anymail Finder or Enrichley that is not a billing, quota or credits
// refusal waits for its Retry-After or x-ratelimit-reset (at most 60 s a wait,
// 3 retries, 2 minutes in all) and sends the same request again, so the row
// keeps its slot instead of going back to the queue. A 429 is not billed; a
// refusal stops as before, and a send with no answer is never sent again here.
// The heartbeat carries OpenAI's latest rate-limit headers per model and the
// waits so far.
//
// Rows of AI Ark tab pulls (tables of kind 'ai_ark') are claimed before any
// other row, oldest first; then the email checks (General inboxes rows), then
// the rest, each shared in fair turns across the tables with due rows (each
// table's oldest rows first; scripts/lib/enrich/claim.mjs). A pull's rows are
// quick database checks and its leads wait for them; a general email becomes a
// lead only once its check is done, and its row is made after its company's,
// so claimed oldest first across every table the checks (and the leads) waited
// for the whole company backlog; and one client's big backlog no longer holds
// up another client's rows.
//
// Crash model: a row is 'running' with a claim token while it is worked. A
// crash leaves it 'running'; after STALE_MIN the sweep re-queues it and it is
// evaluated again. Paid answers are reused when their inputs are unchanged
// (enrich_cells.input_hash), so a re-run never pays twice. Every write is
// fenced on the claim token: a row that was reclaimed meanwhile is left alone.
//
// AI Ark runs (the AI Ark tab) are worked here too, one at a time, in a loop of
// their own beside the rows (scripts/lib/aiark/runs.mjs): each slice pulls a
// page of people into the run's table, and the row loop then works out each
// person's outcome like any other row.
//
// Company pulls (the Companies tab, scripts/lib/aiark/company-runs.mjs) share
// that loop: people slices and company slices take turns, through one AI Ark
// client, so one throttle holds both at AIARK_RPS. The Companies tab's people
// runs (scripts/lib/aiark/people-runs.mjs: a Look, a Buy, the settling of each
// company) are the third kind of slice, taking their turn the same way. A
// pull's companies land in the client's Companies (pipeline) table, whose
// columns are the original Clay columns (companies_v2); its general emails
// become rows of the client's General (pipeline) table, and its people
// rows of People (pipeline). When a row finishes the worker writes its summary
// for the Companies tab, fenced on the row's claim: a company row into
// enrich_companies, an inbox or People row into enrich_contacts, then its
// company's listing. Rows of a retired companies_v1 table are never claimed
// (D24).
//
// Every 5 minutes, template rows waiting on a key or a day's cap are queued
// again when what kept each one waiting has cleared, and rows whose email
// finder or Enrichley step was skipped for a key the worker now holds are
// queued again; answers already held are reused, so only those cells pay.
//
// Google Maps places sent to a client's inbound URL (migration 129) arrive in
// its Companies (pipeline) table as held rows, which are never claimed. Once a
// minute, beside the stale sweep, the worker turns them into queued rows,
// oldest first, for the clients on the company_pipeline switch only
// (scripts/lib/enrich/held.mjs; the database checks the switch, and its guard
// refuses any other release while a client is off).
//
// An upload's no-email rows (migration 130) go to the client's People table.
// In the same minute the worker decides where each finished upload's kept-back
// rows go (the one client tag among the upload's tags, else not sent) and
// copies them into that client's People (pipeline) table as held rows, a
// chunk at a time (scripts/lib/enrich/upload-move.mjs). Then it releases held
// People rows for the clients on the people_pipeline switch, while the table
// has fewer than 2,000 rows queued, running or waiting (held.mjs). On an
// upload row the finders and Enrichley run only for a person inside the
// client's area and clear of its rules, and OpenAI never runs. Every minute,
// with AIARK_AUTO_ADD_URL and AIARK_AUTO_ADD_KEY set, it asks the web app to
// add an upload's approved found emails to leads (POST /api/uploads/found/auto
// { batch }), at most once per upload every 10 minutes
// (scripts/lib/enrich/upload-found.mjs); without them the Uploads page's
// button does it. None of this costs anything until a client is switched on
// and the caps are set.
//
// Settings (enrich_settings: the switches and their client lists, the models,
// the spend caps, how long paid answers are remembered) are read at most every
// 30 s and handed to the actions, so a model is swapped without a deploy.
//
// Fit scoring (phase 3) has a loop of its own beside the AI Ark loop, so
// scoring never holds up pulls. Each tick: a push waiting in 'scoring'
// (fit-push.mjs), the scorer (fit-score.mjs: idle while scoring is off, the
// rule is not set or OPENAI_API_KEY is missing), the blocked refresh after a
// gate change, and a step of a scoring or review run over the Email Bison copy
// (fit-backfill.mjs). Every minute, clients whose approved contacts wait are
// promoted into leads through the web app (POST /api/companies/promote/auto,
// the AIARK_AUTO_ADD_URL origin and AIARK_AUTO_ADD_KEY), at most one round per
// client every 2 minutes; promotion ships off and covers no client, and needs
// no fit score (fit scoring is kept for v2, switched off). On the same minute,
// not awaited and with a busy flag of its own, clients whose promoted leads
// are placed and ready are asked to be pushed into their campaigns
// (POST /api/companies/promote/auto/push, the same address and key), at most
// once every 2 minutes per client, while promotion.auto_push is on (migration
// 140, scripts/lib/enrich/promote-push.mjs; ships off).
// FIT_POLL_MS (5000): the fit loop's sleep when it had nothing to do.
//
// Overlap sharing (migrations 133 and 134, scripts/lib/share/): every 60 s,
// not awaited, with a busy flag and on a pool of its own (2 connections), the
// share step finds finished imports, waits for their places, decides which
// other clients their new leads fit and why not, applies them in apply mode
// within the push caps, asks the web app to push applied shares
// (POST /api/sharing/push/auto, SHARE_PUSH_KEY; SHARE_PUSH_URL or the
// AIARK_AUTO_ADD_URL origin), writes the receivers' tags while write_tags is
// on, and prunes. It does nothing at all while overlap_sharing is off or has
// no "since"; it ships off and covers no client.
//
// Question variables (migration 139, scripts/lib/questions/): once per loop,
// not awaited, with a busy flag and on a pool of its own (3 connections), the
// question step claims the oldest open question job and gathers its leads or
// writes one slice of them (research per company and a question per lead, on
// OpenAI, under question_variables.usd_per_day; jobs.mjs questionStep). A job
// is paused with its reason while question variables are off for its client,
// the day's budget is used up or OPENAI_API_KEY is missing, and resumes by
// itself. With no job open the step waits 10 s between looks. The heartbeat
// lists question_jobs; the web app starts no job without it. Ships off: no
// job can start while the switch covers no client.
//
// Env: DATABASE_URL (required). OPENAI_API_KEY: optional; without it, the
// columns that need it show "Needs key" and the row waits.
// FINDYMAIL_API_KEY, PROSPEO_API_KEY, ANYMAIL_FINDER_API_KEY, ENRICHLEY_API_KEY:
// optional; without one, its steps show "Needs <KEY> (not held)" and the row
// never waits for them. With one, each call first takes one of the vendor's
// calls for the day (enrich_settings.spend_caps.vendor_calls_per_day, 129); no
// cap set (0, the default) or none left, and the step waits, as Reoon's does.
// ENRICH_REOON_API_KEY: the company pipeline's Reoon key (in production the
// validation worker's account, sharing its daily credits), spent on daily credits only;
// ENRICH_REOON_THREADS (4, at most 5) Reoon checks at once.
// AIARK_API_KEY — live AI Ark runs; AIARK_DEMO=1 — demo runs with made-up
// people (AIARK_DEMO_CREDITS, 25000); AIARK_WEBHOOK_URL — needed only for the
// export strategy; AIARK_RPS (4). AIARK_AUTO_ADD_URL and AIARK_AUTO_ADD_KEY — a
// finished pull's people with an email go to the database with no button (this
// app's /api/aiark/add/auto; the same key on the web service). The same pair
// has the worker ask for uploads' found emails to be added (/api/uploads/found/auto).
// ENRICH_CONCURRENCY (6), ENRICH_POLL_MS (2000: the wait when nothing is
// claimable), ENRICH_STALE_MIN (15), ENRICH_WORKER_ID ("enrich-worker"),
// ENRICH_ONCE=1 (drain the queue, then exit).

import os from "node:os";
import pg from "pg";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";
import { order } from "./lib/enrich/formula.mjs";
import { claimRows } from "./lib/enrich/claim.mjs";
import { runRow } from "./lib/enrich/engine.mjs";
import { readSettings } from "./lib/enrich/settings.mjs";
import { projectCompanyV2 } from "./lib/enrich/project-company.mjs";
import { projectContact } from "./lib/enrich/project-contacts.mjs";
import { reoonBalanceInfo, requeueRowsForHeldKeys, requeueWaitingTemplateRows } from "./lib/enrich/company-actions.mjs";
import { absentKeyNote, OPTIONAL_KEYS } from "./lib/enrich/pipeline-actions.mjs";
import { originalsSummary } from "./lib/enrich/compile-original.mjs";
import { spentToday } from "./lib/enrich/spend.mjs";
import { openAiRateLimits } from "./lib/enrich/actions.mjs";
import { rateLimitWaits } from "./lib/enrich/http.mjs";
import { PIPELINE_TEMPLATES, RETIRED_TEMPLATES, variantOfNote } from "./lib/enrich/templates.mjs";
import { advanceOneRun, runDue } from "./lib/aiark/runs.mjs";
import { advanceOneCompanyRun, companyRunDue } from "./lib/aiark/company-runs.mjs";
import { advanceOnePeopleRun, peopleRunDue } from "./lib/aiark/people-runs.mjs";
import { autoAddConfig, pullsToAdd, requestAdd } from "./lib/aiark/add.mjs";
import { PERSON_SEARCH_KEYS } from "./lib/aiark/columns.mjs";
import { fitLoopOnce, fitLoopStatus, refreshBlockedOnce } from "./lib/enrich/fit-score.mjs";
import { advanceScoringBatch } from "./lib/enrich/fit-push.mjs";
import { advanceBackfill } from "./lib/enrich/fit-backfill.mjs";
import { promoteAutoConfig, promoteDue, requestPromote } from "./lib/enrich/promote.mjs";
import {
  PROMOTION_PUSH_CAPABILITY, promotePushConfig, PUSH_ASK_EVERY_MS, pushDue, pushLogLine, requestPromotePush,
} from "./lib/enrich/promote-push.mjs";
import { releaseHeldPeopleRows, releaseHeldRows } from "./lib/enrich/held.mjs";
import { moveUploadRows } from "./lib/enrich/upload-move.mjs";
import { copyPullNoEmail, handBackFound, PULL_NO_EMAIL_CAPABILITY } from "./lib/enrich/pull-no-email.mjs";
import { askForFound, foundAutoConfig } from "./lib/enrich/upload-found.mjs";
import { UPLOAD_CAPABILITY } from "./lib/enrich/upload-people.mjs";
import { SHARING_CAPABILITY, sharePushConfig } from "./lib/overlap-topup.mjs";
import { newShareMemory, SHARE_EVERY_MS, shareRefusals, shareRound } from "./lib/share/step.mjs";
import { SHARE_UNREADY } from "./lib/share/db.mjs";
import { QUESTION_JOBS_CAPABILITY, questionStep } from "./lib/questions/jobs.mjs";
dotenv.config({ path: new URL("../.env.local", import.meta.url).pathname, quiet: true });

const env = process.env;
const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== "" && Number.isFinite(n) ? n : d;
};
const CONCURRENCY = Math.max(1, Math.min(32, num(env.ENRICH_CONCURRENCY, 6)));
const POLL_MS = Math.max(500, num(env.ENRICH_POLL_MS, 2000));
const STALE_MIN = Math.max(5, num(env.ENRICH_STALE_MIN, 15));
const MAX_ATTEMPTS = 3;
const ONCE = env.ENRICH_ONCE === "1";
const WORKER_ID = env.ENRICH_WORKER_ID || "enrich-worker";
const PROVIDER_KEYS = ["OPENAI_API_KEY", "ENRICH_REOON_API_KEY"];
const SEARCH_KEYS = [
  ...new Set([
    "company", "address", "website", "domain", "use_website", "use_domain", "place_id", "phone", "use_city", "use_state",
    "general_email", ...PERSON_SEARCH_KEYS,
  ]),
];
// What this worker can run: the Companies tab starts a pull or a people run only when the worker says it can.
// pipeline_v2: the Clay originals' templates (companies_v2, inboxes_v1, people_v1).
// linkedin_sources: LinkedIn company pulls and LinkedIn people runs (migration 128), claimed from the same two
// run tables by the same slices (a people run's source says whether it looks by company or by area).
// held_release: held Google Maps rows (migration 129) are released once a minute for clients switched on; the
// Clay tab warns while the worker running lacks it.
// upload_people (UPLOAD_CAPABILITY): uploads' no-email rows are copied into the People tables and released under
// people_pipeline (migration 130), and found emails are asked to be added; the Uploads page warns without it.
const CAPABILITIES = ["company_runs", "pipeline_v2", "people_runs", "linkedin_sources", "held_release", UPLOAD_CAPABILITY];
// Waiting template rows are looked at again every 5 minutes (it was hourly), so a row waiting on a key or a day's cap
// runs within minutes of it clearing.
const SWEEP_WAITING_MS = 5 * 60_000;

if (!env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: CONCURRENCY + 3,
  keepAlive: true,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 70_000,
});
pool.on("error", (e) => log(`pg pool idle-client error: ${e.message}`)); // never crash the loop

// The 60-second housekeeping block and the heartbeat run beside the rows on a
// pool of their own (see "Housekeeping beside the rows"), so a slow release or
// a heartbeat never takes a connection a row slot is waiting for. One block
// and one heartbeat at a time; the heartbeat reads two things at once.
const housekeepingPool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 3,
  keepAlive: true,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 70_000,
});
housekeepingPool.on("error", (e) => log(`housekeeping pool idle-client error: ${e.message}`)); // never crash the loop

const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let shuttingDown = false;
process.on("SIGTERM", () => { shuttingDown = true; log("SIGTERM — finishing rows in flight, then exiting"); });
process.on("SIGINT", () => { shuttingDown = true; });

const stats = { processed: 0, failed: 0, calls: 0 };
let inFlight = 0;
const aiark = { slices: 0, company_slices: 0, people_slices: 0, active: null, idle: true };

// ── Table definitions (columns change rarely; re-read every 30 s) ───────────

const defs = new Map();
async function tableDef(id) {
  const hit = defs.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const { rows: [table] } = await pool.query(
    `SELECT id, client_tag, kind, name, template, source_note FROM enrich_tables WHERE id = $1`, [id]);
  if (!table) throw new Error(`table ${id} no longer exists`);
  // The originals variant the columns were compiled from: the personalisation switch reads it.
  table.variant = table.template ? variantOfNote(table.source_note) : undefined;
  const { rows: columns } = await pool.query(
    `SELECT key, name, position, kind, action, formula, waterfall, inputs, config, run_if, provider, needs_env, phase
       FROM enrich_columns WHERE table_id = $1 ORDER BY position`, [id]);
  const { rows: counts } = await pool.query(
    `SELECT source_table, count(*)::int AS n FROM imported_company_keys WHERE client_tag = $1 GROUP BY 1`, [table.client_tag]);
  table.keyCounts = Object.fromEntries(counts.map((r) => [r.source_table, r.n]));
  let ordered;
  let orderError = null;
  try {
    ordered = order(columns);
  } catch (e) {
    orderError = e.message;
    ordered = columns;
  }
  const def = { at: Date.now(), table, ordered, orderError };
  defs.set(id, def);
  return def;
}

// ── Queue ───────────────────────────────────────────────────────────────────

/** Up to n queued rows, AI Ark pull rows first, then the email checks, under one claim token (claim.mjs); never a retired template's row. */
async function claim(n) {
  return claimRows(pool, n, { token: randomUUID(), retired: [...RETIRED_TEMPLATES], log });
}

/**
 * Rows stuck in 'running' past STALE_MIN (a worker died with them) are queued
 * again. Never throws: a failure is logged, the rest of the block still runs,
 * and the next block tries again.
 */
async function reclaimStale() {
  try {
    const { rowCount } = await housekeepingPool.query(
      `UPDATE enrich_rows
          SET run_status = 'queued', claim_token = NULL, claimed_at = NULL, next_run_at = now(), updated_at = now()
        WHERE run_status = 'running' AND claimed_at < now() - make_interval(mins => $1)`,
      [STALE_MIN]
    );
    if (rowCount) log(`re-queued ${rowCount} row(s) stuck in 'running' for over ${STALE_MIN} min`);
  } catch (e) {
    log(`re-queuing stale rows: ${e.message}`);
  }
}

let heldUnreadyLogged = false;

/**
 * Held Google Maps rows of the clients on the company_pipeline switch become
 * queued (held.mjs). Never throws: a failure here is logged and must not stop
 * the queue.
 */
async function releaseHeld() {
  try {
    const { released, tables, refused } = await releaseHeldRows(housekeepingPool);
    if (released) log(`released ${released} held row(s) in ${tables} Companies (pipeline) table(s): their clients are on the company_pipeline switch`);
    if (refused) log(`${refused} table(s) kept their held rows: the client was switched off before the release`);
  } catch (e) {
    // 42883: fn_enrich_company_switch_on is missing, so migration 129 is not applied yet.
    if (e?.code === "42883") {
      if (!heldUnreadyLogged) log("held rows are not released: migration 129 is not applied");
      heldUnreadyLogged = true;
      return;
    }
    log(`releasing held rows: ${e.message}`);
  }
}

// What a database without migration 130 answers: no upload_people (42P01), no add_tags (42703), no switch function (42883).
const UPLOADS_UNREADY = new Set(["42P01", "42703", "42883"]);
let uploadsUnreadyLogged = false;
let peopleUnreadyLogged = false;
let peopleFullBefore = 0;

/**
 * Uploads' no-email rows into their clients' People tables as held rows
 * (upload-move.mjs): free, nothing queued. Never throws.
 */
async function moveUploads() {
  try {
    const settings = await readSettings(housekeepingPool);
    const { decided, notSent, moved, batches, waiting } = await moveUploadRows(housekeepingPool, { settings, log });
    if (decided || moved || waiting) {
      log(`uploads' no-email rows: ${decided} upload(s) decided (${notSent} not sent), ${moved} row(s) copied held into People tables from ${batches} upload(s)` +
        (waiting ? `, ${waiting} upload(s) waiting for their client's tables` : ""));
    }
  } catch (e) {
    if (UPLOADS_UNREADY.has(e?.code)) {
      if (!uploadsUnreadyLogged) log("uploads' no-email rows are not moved: migration 130 is not applied");
      uploadsUnreadyLogged = true;
      return;
    }
    log(`moving uploads' no-email rows: ${e.message}`);
  }
}

/**
 * Held People rows of the clients on the people_pipeline switch become queued
 * (held.mjs releaseHeldPeopleRows), within each table's room. Never throws;
 * the Maps release above runs whatever happens here.
 */
async function releaseHeldPeople() {
  try {
    const { released, tables, refused, full } = await releaseHeldPeopleRows(housekeepingPool);
    if (released || refused || full !== peopleFullBefore) {
      log(`released ${released} held People row(s) in ${tables} table(s): their clients are on the people_pipeline switch` +
        (refused ? `; ${refused} table(s) kept them: the client was switched off before the release` : "") +
        (full ? `; ${full} table(s) have 2,000 rows in work or waiting, the rest stay held for now` : ""));
    }
    peopleFullBefore = full;
  } catch (e) {
    if (UPLOADS_UNREADY.has(e?.code)) {
      if (!peopleUnreadyLogged) log("held People rows are not released: migration 130 is not applied");
      peopleUnreadyLogged = true;
      return;
    }
    log(`releasing held People rows: ${e.message}`);
  }
}

// AI Ark tab pulls' people with no email (pull-no-email.mjs): copied held into
// their clients' People (pipeline) tables once the client is on People runs,
// right after the uploads' move, and an approved address found there handed
// back to the pull's row right after the People release. Both free: nothing
// is queued, paid or added to leads here. The heartbeat lists pull_no_email.
CAPABILITIES.push(PULL_NO_EMAIL_CAPABILITY);
let pullsUnreadyLogged = false;
let handBackUnreadyLogged = false;

/** People with no email from finished AI Ark pulls into their clients' People tables, held. Never throws. */
async function copyPulls() {
  try {
    const settings = await readSettings(housekeepingPool);
    const { runs, copied, already, waiting } = await copyPullNoEmail(housekeepingPool, { settings, log });
    if (runs || waiting) {
      log(`AI Ark pulls' people with no email: ${copied} copied held into People tables, ${already} followed in a row there already, from ${runs} pull(s)` +
        (waiting ? `; ${waiting} pull(s) waiting for their client's tables` : ""));
    }
  } catch (e) {
    if (UPLOADS_UNREADY.has(e?.code)) {
      if (!pullsUnreadyLogged) log("AI Ark pulls' people with no email are not copied: migration 130 is not applied");
      pullsUnreadyLogged = true;
      return;
    }
    log(`copying AI Ark pulls' people with no email: ${e.message}`);
  }
}

/** Addresses the People tables found for AI Ark pulls' people, handed back to the pulls' rows. Never throws. */
async function handBackPulls() {
  try {
    const { found, closed } = await handBackFound(housekeepingPool, { log });
    if (found || closed) log(`AI Ark pulls: ${found} address(es) found in People tables handed back to their pull rows, ${closed} search(es) closed with none`);
  } catch (e) {
    if (UPLOADS_UNREADY.has(e?.code)) {
      if (!handBackUnreadyLogged) log("AI Ark pulls' found addresses are not handed back: migration 130 is not applied");
      handBackUnreadyLogged = true;
      return;
    }
    log(`handing back AI Ark pulls' found addresses: ${e.message}`);
  }
}

/** Writes cells and run records, but only while this worker still holds the row. */
async function writeCells(r, cells, runs) {
  if (!cells.length && !runs.length) return true;
  const { rows } = await pool.query(
    `WITH ok AS (SELECT 1 FROM enrich_rows WHERE id = $1 AND claim_token = $3),
     c AS (
       INSERT INTO enrich_cells AS e (row_id, column_key, table_id, status, value, display, note, input_hash, runs, updated_at)
       SELECT $1, x.column_key, $2, x.status, x.value, x.display, x.note, x.input_hash, coalesce(x.runs, 0), now()
         FROM jsonb_to_recordset($4::jsonb)
              AS x(column_key text, status text, value jsonb, display text, note text, input_hash text, runs int)
        WHERE EXISTS (SELECT 1 FROM ok)
       ON CONFLICT (row_id, column_key) DO UPDATE
         SET status = EXCLUDED.status, value = EXCLUDED.value, display = EXCLUDED.display, note = EXCLUDED.note,
             input_hash = EXCLUDED.input_hash, runs = e.runs + EXCLUDED.runs, updated_at = now()
       RETURNING 1),
     h AS (
       INSERT INTO enrich_cell_runs (row_id, column_key, status, provider, request, response, error, http_status, duration_ms, started_at)
       SELECT $1, y.column_key, y.status, y.provider, y.request, y.response, y.error, y.http_status, y.duration_ms, y.started_at
         FROM jsonb_to_recordset($5::jsonb)
              AS y(column_key text, status text, provider text, request jsonb, response jsonb, error text,
                   http_status int, duration_ms int, started_at timestamptz)
        WHERE EXISTS (SELECT 1 FROM ok)
       RETURNING 1)
     SELECT (SELECT count(*) FROM ok)::int AS held, (SELECT count(*) FROM c)::int AS cells, (SELECT count(*) FROM h)::int AS runs`,
    [r.id, r.table_id, r.claim_token, JSON.stringify(cells), JSON.stringify(runs)]
  );
  return rows[0].held > 0;
}

async function finish(r, { status, nextRunAt = null, lastError = null, search = null }) {
  const { rowCount } = await pool.query(
    `UPDATE enrich_rows
        SET run_status = $3, next_run_at = coalesce($4::timestamptz, next_run_at), claim_token = NULL, claimed_at = NULL,
            run_force = NULL, last_error = $5, search_text = coalesce($6, search_text),
            finished_at = CASE WHEN $3 = 'queued' THEN finished_at ELSE now() END, updated_at = now()
      WHERE id = $1 AND claim_token = $2`,
    [r.id, r.claim_token, status, nextRunAt, lastError, search]
  );
  if (!rowCount) log(`row ${r.id}: claim lost before finishing (re-queued elsewhere) — left as is`);
}

// ── One row ─────────────────────────────────────────────────────────────────

async function processRow(r) {
  const def = await tableDef(r.table_id);
  if (def.orderError) {
    await finish(r, { status: "error", lastError: def.orderError });
    return;
  }
  const { rows: stored } = await pool.query(
    `SELECT column_key, status, value, display, note, input_hash FROM enrich_cells WHERE row_id = $1`, [r.id]);
  const cells = new Map(stored.map((c) => [c.column_key, c]));
  const pending = new Map();
  const runs = [];
  let held = true;
  const flush = async () => {
    if (!held) return;
    const batch = [...pending].map(([column_key, c]) => ({ column_key, ...c }));
    const hist = runs.splice(0);
    pending.clear();
    held = await writeCells(r, batch, hist);
  };

  const settings = await readSettings(pool);
  const result = await runRow({
    row: r,
    table: def.table,
    columns: def.ordered,
    cells,
    env,
    db: pool,
    settings,
    hooks: {
      changed: (key, cell) => pending.set(key, cell),
      running: async (key, prev) => {
        pending.set(key, {
          status: "running", value: prev?.value ?? null, display: prev?.display ?? null,
          note: null, input_hash: prev?.input_hash ?? null, runs: 0,
        });
        await flush();
      },
      ran: async (run) => {
        runs.push(run);
        await flush();
      },
    },
  });
  await flush();
  if (!held) {
    log(`row ${r.id}: claim lost mid-run — stopped writing`);
    return;
  }
  stats.calls += result.calls;

  const search = SEARCH_KEYS.map((k) => result.values[k])
    .filter((v) => typeof v === "string" && v)
    .join(" ")
    .toLowerCase()
    .slice(0, 2000);
  // A pipeline row's summary goes to the Companies tab when the row finishes
  // (not when it is queued again), while this worker still holds it: a company
  // row as a company, an inbox or People row as one of its company's contacts.
  const project = (status) => {
    const opts = {
      rowId: r.id, claimToken: r.claim_token, tableId: r.table_id, clientTag: def.table.client_tag, values: result.values,
      waiting: status === "waiting", failed: status === "error",
    };
    switch (def.table.template) {
      case PIPELINE_TEMPLATES.companies.template:
        return projectCompanyV2(pool, opts);
      case PIPELINE_TEMPLATES.inboxes.template:
        return projectContact(pool, { ...opts, kind: "general" });
      case PIPELINE_TEMPLATES.people.template:
        return projectContact(pool, { ...opts, kind: "person" });
      default:
        return null;
    }
  };
  if (result.retryable && r.attempts < MAX_ATTEMPTS) {
    const delay = 30_000 * 2 ** (r.attempts - 1);
    await finish(r, { status: "queued", nextRunAt: new Date(Date.now() + delay).toISOString(), lastError: result.retryable, search });
  } else if (result.errors) {
    await project("error");
    await finish(r, { status: "error", lastError: result.retryable ?? `${result.errors} cell(s) failed`, search });
  } else {
    const status = result.needsKey ? "waiting" : "done";
    await project(status);
    await finish(r, { status, search });
  }
  stats.processed++;
}

async function safeProcess(r) {
  try {
    await processRow(r);
  } catch (e) {
    stats.failed++;
    log(`row ${r.id}: ${e.message}`);
    // Put it back with backoff; after MAX_ATTEMPTS it is parked as an error.
    const status = r.attempts < MAX_ATTEMPTS ? "queued" : "error";
    await finish(r, {
      status,
      nextRunAt: new Date(Date.now() + 60_000 * r.attempts).toISOString(),
      lastError: `worker: ${String(e.message).slice(0, 300)}`,
    }).catch((e2) => log(`row ${r.id}: could not release (${e2.message}); the stale sweep will`));
  }
}

// ── Heartbeat (the Clay tab's "worker running" pill) ────────────────────────

/** The originals loaded and today's spend, for the heartbeat; null when they can't be read (before migration 125). */
async function pipelineInfo() {
  try {
    const [originals, spend] = await Promise.all([originalsSummary(housekeepingPool), spentToday(housekeepingPool)]);
    return { originals, spend };
  } catch {
    return { originals: null, spend: null };
  }
}

async function heartbeat({ starting = false, stopping = false } = {}) {
  const { originals, spend } = await pipelineInfo();
  const info = {
    concurrency: CONCURRENCY,
    in_flight: inFlight,
    ...stats,
    keys: Object.fromEntries([...PROVIDER_KEYS, ...OPTIONAL_KEYS].map((k) => [k, Boolean(env[k])])),
    // The email finders' and Enrichley's keys: a step whose key is not held is skipped, never waited for.
    optional_keys: Object.fromEntries(OPTIONAL_KEYS.map((k) => [k, Boolean(env[k])])),
    capabilities: CAPABILITIES,
    // The Clay originals loaded (default variant), for the tab's "originals loaded" pill.
    originals,
    // What the pipeline spent today (UTC): Reoon checks, OpenAI dollars, and the calls to the email finders and
    // Enrichley (spend.mjs SPEND_KINDS), against enrich_settings.spend_caps.
    spend_today: spend,
    // The pipeline's Reoon account as last read (daily credits, instant credits, when): the Companies tab shows the checks left today.
    reoon: reoonBalanceInfo(),
    // OpenAI's rate-limit headers as the AI columns' calls last read them, per model ({ limit_tokens, remaining_tokens,
    // limit_requests, remaining_requests, reset_*, at }): the account's limits without OpenAI's dashboard.
    openai_rate_limits: openAiRateLimits(),
    // The rate limits waited out in place since the worker started (http.mjs): sends made again, the time waited, and
    // calls still limited after their waits (those rows went back to the queue).
    rate_limit_waits: rateLimitWaits(),
    aiark: {
      key: Boolean(env.AIARK_API_KEY),
      demo: env.AIARK_DEMO === "1",
      webhook: Boolean(env.AIARK_WEBHOOK_URL),
      auto_add: Boolean(autoAdd),
      active_run: aiark.active,
      slices: aiark.slices,
      company_slices: aiark.company_slices,
      people_slices: aiark.people_slices,
    },
    // The fit loop (phase 3): what the scorer is doing and why, and the loop's counters.
    fit: { ...fitLoopStatus(), loop: { ...fitState }, promote_auto: Boolean(promoteAuto) },
    // Uploads' no-email rows (130): whether found emails are added with no button.
    upload_people: { found_auto: Boolean(foundAuto) },
    // Overlap sharing (134): whether applied shares are pushed with no button (SHARE_PUSH_KEY and the web address set),
    // and the push timer's last failed ask per receiving client, cleared by its next push that goes through.
    sharing: { push_auto: Boolean(sharePush), refusals: shareRefusals(shareMemory) },
    // Question jobs (139): the step's counters, the job it last looked at and why that job waits, if it does.
    questions: { ...questionState },
    host: os.hostname(),
    pid: process.pid,
    stopped: stopping,
  };
  await housekeepingPool.query(
    `INSERT INTO enrich_worker_state (id, started_at, last_seen, info) VALUES ($1, now(), now(), $2)
     ON CONFLICT (id) DO UPDATE
       SET last_seen = now(), info = EXCLUDED.info,
           started_at = CASE WHEN $3::boolean THEN now() ELSE enrich_worker_state.started_at END`,
    [WORKER_ID, info, starting]
  );
}

// ── AI Ark runs (one at a time: the API's rate limit is per key) ────────────
// The AI Ark tab's people slices, company slices and the Companies tab's
// people-run slices take turns going first, so no kind of run waits behind
// the others; all use the same AI Ark client and throttle.

async function peopleSlice() {
  const id = await advanceOneRun({ pool, env, log, shouldStop: () => shuttingDown });
  if (id) aiark.slices++;
  return id;
}

async function companySlice() {
  const id = await advanceOneCompanyRun({ pool, env, log, shouldStop: () => shuttingDown });
  if (id) aiark.company_slices++;
  return id;
}

/** A people run of the Companies tab: one Look page, or up to 10 Export Singles, or settling. */
async function pipelinePeopleSlice() {
  const id = await advanceOnePeopleRun({ pool, env, log, shouldStop: () => shuttingDown, maxBuysPerSlice: 10 });
  if (id) aiark.people_slices++;
  return id;
}

const SLICE_KINDS = [
  { slice: peopleSlice, name: "people runs" },
  { slice: companySlice, name: "company pulls" },
  { slice: pipelinePeopleSlice, name: "pipeline people runs" },
];
let firstKind = 0;

/**
 * One slice of whichever kind has work, the kinds taking turns to go first.
 * An error in one kind is logged and the others still get their turn.
 */
async function advanceOneRunInTurn() {
  const turn = SLICE_KINDS.map((_, i) => SLICE_KINDS[(firstKind + i) % SLICE_KINDS.length]);
  firstKind = (firstKind + 1) % SLICE_KINDS.length;
  for (const { slice, name } of turn) {
    if (shuttingDown) break;
    try {
      const id = await slice();
      if (id) return id;
    } catch (e) {
      log(`AI Ark loop error (${name}): ${e.message}`);
    }
  }
  return null;
}

async function aiarkLoop() {
  while (!shuttingDown) {
    let worked = null;
    aiark.idle = false;
    try {
      worked = await advanceOneRunInTurn();
    } catch (e) {
      log(`AI Ark loop error: ${e.message}`);
    }
    aiark.active = worked;
    aiark.idle = !worked;
    await sleep(worked ? 50 : POLL_MS);
  }
}

// ── Fit loop (phase 3): its own loop, so scoring never holds up pulls ───────
// Pushes waiting in 'scoring', the scorer, the blocked refresh after a gate
// change, and a step of a scoring or review run. OpenAI only. An error in one
// step is logged and the others still get their turn.

CAPABILITIES.push("fit_scoring");
const FIT_POLL_MS = ONCE ? 500 : Math.max(1000, num(env.FIT_POLL_MS, 5000));
const fitState = { ticks: 0, batches: 0, scored: 0, refreshed: 0, backfill: 0, idle: true, last_error: null };

async function fitTick() {
  const settings = await readSettings(pool);
  let worked = false;
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      fitState.last_error = `${name}: ${String(e.message).slice(0, 300)}`;
      log(`fit loop error (${name}): ${e.message}`);
      return null;
    }
  };
  if (await step("waiting pushes", () => advanceScoringBatch({ pool, log }))) {
    fitState.batches++;
    worked = true;
  }
  const scored = await step("scorer", () => fitLoopOnce({ pool, env, log, settings }));
  if (scored) {
    fitState.scored += scored;
    worked = true;
  }
  const refreshed = await step("blocked refresh", () => refreshBlockedOnce(pool));
  if (refreshed) {
    fitState.refreshed += refreshed;
    worked = true;
  }
  if (await step("campaign runs", () => advanceBackfill({ pool, log, settings }))) {
    fitState.backfill++;
    worked = true;
  }
  return worked;
}

async function fitLoop() {
  while (!shuttingDown) {
    fitState.idle = false;
    let worked = false;
    try {
      worked = await fitTick();
    } catch (e) {
      log(`fit loop error: ${e.message}`);
    }
    fitState.ticks++;
    fitState.idle = !worked;
    await sleep(worked ? 50 : FIT_POLL_MS);
  }
}

// Approved contacts into leads: the web app runs the import (TypeScript); the
// worker only asks, at most one round per client every 2 minutes (it was 10),
// so a client's approved emails become leads within minutes. A client's two
// minutes are timed from the start of the check that asked it: checks come a
// minute apart, so it is asked every second check, never every third because
// this check's database read came back a little faster than the last one's.
const PROMOTE_CHECK_MS = 60_000;
const PROMOTE_EVERY_MS = 2 * 60_000;
const promoteAuto = promoteAutoConfig(env);
const promotedAt = new Map();
let promoteBusy = false;

async function promoteWaiting() {
  if (!promoteAuto || promoteBusy) return;
  promoteBusy = true;
  const checkedAt = Date.now();
  try {
    const settings = await readSettings(pool);
    for (const tag of await promoteDue(pool, settings)) {
      if (checkedAt - (promotedAt.get(tag) ?? 0) < PROMOTE_EVERY_MS) continue;
      promotedAt.set(tag, checkedAt);
      const r = await requestPromote(promoteAuto, tag);
      log(`promotion for ${tag}: ${r.ok ? "started" : `not started, ${r.status ?? "no answer"}: ${r.why}`}`);
    }
  } catch (e) {
    log(`promoting approved contacts: ${e.message}`);
  } finally {
    promoteBusy = false;
  }
}

// Promoted leads into the client's campaigns (migration 140): the web app picks
// the campaigns and queues the push batch (TypeScript); the worker only asks,
// for a client whose leads are placed and ready, at most once every 2 minutes.
// Its own busy flag, so a slow Bison read never holds up the promotion asks.
CAPABILITIES.push(PROMOTION_PUSH_CAPABILITY);
const promotePush = promotePushConfig(env);
const pushAskedAt = new Map();
let pushBusy = false;
let pushUnreadyLogged = false;

async function pushPromoted() {
  if (!promotePush || pushBusy) return;
  pushBusy = true;
  try {
    const settings = await readSettings(pool);
    for (const tag of await pushDue(pool, settings)) {
      if (Date.now() - (pushAskedAt.get(tag) ?? 0) < PUSH_ASK_EVERY_MS) continue;
      pushAskedAt.set(tag, Date.now());
      log(pushLogLine(tag, await requestPromotePush(promotePush, tag)));
    }
  } catch (e) {
    if (UPLOADS_UNREADY.has(e?.code)) {
      if (!pushUnreadyLogged) log("promoted leads are not pushed: migration 140 is not applied");
      pushUnreadyLogged = true;
      return;
    }
    log(`pushing promoted leads: ${e.message}`);
  } finally {
    pushBusy = false;
  }
}

// An upload's approved found emails into leads: the web app runs the import
// (TypeScript); the worker only asks, at most once per upload every 10 minutes
// (FOUND_EVERY_MS, upload-found.mjs). Off without the auto-add address and key.
const FOUND_CHECK_MS = 60_000;
const foundAuto = foundAutoConfig(env);
const foundAskedAt = new Map();
let foundBusy = false;
let foundUnreadyLogged = false;

async function addFoundEmails() {
  if (!foundAuto || foundBusy) return;
  foundBusy = true;
  try {
    await askForFound(pool, { config: foundAuto, askedAt: foundAskedAt, log });
  } catch (e) {
    if (UPLOADS_UNREADY.has(e?.code)) {
      if (!foundUnreadyLogged) log("found emails are not added: migration 130 is not applied");
      foundUnreadyLogged = true;
      return;
    }
    log(`adding found emails: ${e.message}`);
  } finally {
    foundBusy = false;
  }
}

// ── Overlap sharing (migrations 133 and 134) ────────────────────────────────
// A round every 60 s, not awaited, with a busy flag (scripts/lib/share/step.mjs).
// Its statements run one at a time on a pool of their own, so they never take
// a connection a row or a slice is waiting for; each stays under the same 70 s
// query timeout as the main pool. Off, it reads the settings and stops.

CAPABILITIES.push(SHARING_CAPABILITY);
const sharePool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 2,
  keepAlive: true,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 70_000,
});
sharePool.on("error", (e) => log(`share pool idle-client error: ${e.message}`)); // never crash the loop
const sharePush = sharePushConfig(env);
const shareMemory = newShareMemory();
let shareBusy = false;
let shareInFlight = Promise.resolve();
let shareUnreadyLogged = false;

async function shareStep() {
  if (shareBusy) return;
  shareBusy = true;
  try {
    const settings = await readSettings(pool);
    const r = await shareRound(sharePool, { settings, memory: shareMemory, env, log, shouldStop: () => shuttingDown });
    shareUnreadyLogged = false;
    if (r.discovered || r.decided || r.failed || r.rechecked || r.pushes || r.tagsAdded || r.tagsRemoved || r.pruned?.lists || r.pruned?.rows) {
      log(`overlap sharing: ${r.discovered} import(s) found, ${r.decided} decided${r.failed ? `, ${r.failed} failed` : ""}` +
        `${r.rechecked ? `, ${r.rechecked} rechecked` : ""}${r.pushes ? `, ${r.pushes} push request(s)` : ""}` +
        `${r.tagsAdded || r.tagsRemoved ? `, ${r.tagsAdded} tag(s) written, ${r.tagsRemoved} taken off` : ""}` +
        `${r.pruned?.lists || r.pruned?.rows ? `, pruned ${r.pruned.lists} list row(s) and ${r.pruned.rows} log row(s)` : ""}`);
    }
  } catch (e) {
    if (SHARE_UNREADY.has(e?.code)) {
      if (!shareUnreadyLogged) log("overlap sharing is idle: migrations 133 and 134 are not applied");
      shareUnreadyLogged = true;
      return;
    }
    log(`overlap sharing: ${e.message}`);
  } finally {
    shareBusy = false;
  }
}

// ── Question variables (migration 139) ──────────────────────────────────────
// One step a loop, not awaited, with a busy flag (scripts/lib/questions/jobs.mjs).
// Its statements run on a pool of their own, so a long gather page or a slice's
// writes never take a connection a row or a slice is waiting for. With nothing
// to do it waits QUESTION_IDLE_MS before looking again.

CAPABILITIES.push(QUESTION_JOBS_CAPABILITY);
const QUESTION_IDLE_MS = 10_000;
const questionPool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 3,
  keepAlive: true,
  connectionTimeoutMillis: 30_000,
  idleTimeoutMillis: 30_000,
  query_timeout: 70_000,
});
questionPool.on("error", (e) => log(`question pool idle-client error: ${e.message}`)); // never crash the loop
const questionState = { steps: 0, slices: 0, written: 0, idle: true, job: null, last_error: null };
let questionBusy = false;
let questionInFlight = Promise.resolve();
let questionUnreadyLogged = false;
// What a database without migration 139 answers: no question tables (42P01) or columns (42703).
const QUESTIONS_UNREADY = new Set(["42P01", "42703"]);

async function questionTick() {
  if (questionBusy) return;
  questionBusy = true;
  try {
    const r = await questionStep(questionPool, { env, log, shouldStop: () => shuttingDown });
    questionUnreadyLogged = false;
    questionState.steps++;
    questionState.idle = !r.worked;
    questionState.job = r.jobId ? { id: r.jobId, status: r.status ?? null, note: r.note ?? null } : null;
    if (r.written) {
      questionState.slices++;
      questionState.written += r.written;
    }
    questionState.last_error = null;
  } catch (e) {
    questionState.idle = true;
    if (QUESTIONS_UNREADY.has(e?.code)) {
      if (!questionUnreadyLogged) log("question jobs are idle: migration 139 is not applied");
      questionUnreadyLogged = true;
      return;
    }
    questionState.last_error = String(e?.message ?? e).slice(0, 300);
    log(`question jobs: ${e.message}`);
  } finally {
    questionBusy = false;
    // A job with more to do takes its next step on the loop's next turn. With rows in flight the loop used to look
    // again every 250 ms, so the loop is woken that long after the step; with none, it looks every POLL_MS, as before.
    if (!questionState.idle && inFlight > 0) setTimeout(wake, 250).unref();
  }
}

// ── Template rows waiting on a key or a cap: queued again once it cleared ───

let sweepBusy = false;
let retiredLogged = false;

async function sweepWaitingTemplateRows() {
  if (sweepBusy) return;
  sweepBusy = true;
  try {
    const settings = await readSettings(pool);
    const { queued, waiting, why } = await requeueWaitingTemplateRows(pool, env, { settings });
    if (queued) log(`queued ${queued} waiting pipeline row(s) again: what kept them waiting has cleared`);
    if (waiting && why) log(`${waiting} pipeline row(s) left waiting: ${why}`);
    const held = await requeueRowsForHeldKeys(pool, env, { keys: OPTIONAL_KEYS, noteOf: absentKeyNote });
    if (held.queued) log(`queued ${held.queued} pipeline row(s) again: their steps for ${held.keys.join(", ")} can run now`);
    if (!retiredLogged) {
      const { rows: [v1] } = await pool.query(
        `SELECT count(*)::int AS n FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id
          WHERE t.template = ANY($1::text[]) AND r.run_status IN ('queued', 'running')`,
        [[...RETIRED_TEMPLATES]]
      );
      if (v1.n) log(`${v1.n} row(s) of a retired companies_v1 table are left as they are: they are never worked (D24)`);
      retiredLogged = true;
    }
  } catch (e) {
    log(`sweeping waiting pipeline rows: ${e.message}`);
  } finally {
    sweepBusy = false;
  }
}

// ── Finished pulls: people with an email go to the database ─────────────────

const AUTO_ADD_EVERY_MS = 30_000;
const autoAdd = autoAddConfig(env);
let autoAddBusy = false;

async function addFinishedPulls() {
  if (!autoAdd || autoAddBusy) return;
  autoAddBusy = true;
  try {
    for (const run of await pullsToAdd(pool)) {
      const r = await requestAdd(autoAdd, run.id);
      log(`AI Ark run ${run.id.slice(0, 8)} (${run.client_tag}): add ${r.ok ? "started" : `not started, ${r.status ?? "no answer"}: ${r.why}`}`);
    }
  } catch (e) {
    log(`adding finished pulls: ${e.message}`);
  } finally {
    autoAddBusy = false;
  }
}

// ── Housekeeping beside the rows: the 60-second block and the heartbeat ─────
// Neither is awaited by the row loop, so a big release, an upload's move or a
// slow heartbeat never leaves a slot empty. The loop starts each one whenever
// it is not running (its busy flag); each looks at its own clock, so the block
// starts 60 s after the last one ended and the heartbeat 10 s after the last
// one, as when the loop awaited them. Both run on the housekeeping pool. A
// stopping worker waits for both before the pools close, and a draining worker
// (ENRICH_ONCE) exits only after a claim that started once the last block had
// ended, so rows a release queued are worked before it exits.

let lastSweep = 0;
let housekeepingBusy = false;
let housekeepingInFlight = Promise.resolve();
let housekept = 0; // 60-second blocks ended

/** The 60-second block, when its minute has come. Its steps never throw. */
async function housekeeping() {
  housekeepingBusy = true;
  try {
    if (Date.now() - lastSweep > 60_000) {
      await reclaimStale();
      await releaseHeld();
      await moveUploads();
      await copyPulls();
      await releaseHeldPeople();
      await handBackPulls();
      lastSweep = Date.now();
      housekept++;
    }
  } catch (e) {
    // Not awaited, so nothing may escape: anything a step did not catch is logged and the block runs again in a minute.
    log(`housekeeping: ${e.message}`);
    lastSweep = Date.now();
    housekept++;
  } finally {
    housekeepingBusy = false;
  }
}

let lastBeat = Date.now();
let beatBusy = false;
let beatInFlight = Promise.resolve();

/** The heartbeat, when 10 s have passed since the last one. A failure is logged and tried again 10 s later. */
async function beat() {
  beatBusy = true;
  try {
    if (Date.now() - lastBeat > 10_000) {
      try {
        await heartbeat();
      } catch (e) {
        log(`heartbeat: ${e.message}`);
      }
      lastBeat = Date.now();
    }
  } finally {
    beatBusy = false;
  }
}

// ── Free slots: the loop claims again the moment a row finishes ─────────────

let wakes = 0; // rows finished, and question steps with more to do, so far: each ends the loop's wait
let wakeLoop = null; // set while the loop waits

/** Ends the loop's wait now, or its next one when it is not waiting. */
function wake() {
  wakes++;
  wakeLoop?.();
}

/** A row is done: its slot is free, and the loop claims for it at once. */
function rowFinished() {
  inFlight--;
  wake();
}

/**
 * Waits for a wake, or `ms` at most. `seen` is the wakes counted when the
 * loop last looked, so one that came meanwhile (a row that finished during
 * the claim) ends the wait at once.
 */
function untilWoken(seen, ms) {
  if (wakes !== seen) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      wakeLoop = null;
      resolve();
    };
    timer = setTimeout(done, ms);
    wakeLoop = done;
  });
}

// ── Main loop ───────────────────────────────────────────────────────────────

async function main() {
  log(`enrich-worker ${WORKER_ID}: concurrency ${CONCURRENCY}, keys: ` +
    [...PROVIDER_KEYS, "AIARK_API_KEY"].map((k) => `${k} ${env[k] ? "set" : "missing"}`).join(", ") +
    (env.AIARK_DEMO === "1" ? ", AI Ark demo on" : "") + (ONCE ? " (drain and exit)" : ""));
  await heartbeat({ starting: true });
  lastBeat = Date.now();
  const runs = aiarkLoop();
  const fits = fitLoop();
  let lastAdd = 0;
  let lastWaitingSweep = 0;
  let lastPromote = 0;
  let lastFound = 0;
  let lastShare = 0;
  let lastQuestion = 0;
  while (!shuttingDown) {
    try {
      if (!questionBusy && Date.now() - lastQuestion > (questionState.idle ? QUESTION_IDLE_MS : 0)) {
        lastQuestion = Date.now();
        // One step a loop; a step still busy keeps its own promise, so a stopping worker waits for it.
        questionInFlight = questionTick();
      }
      if (Date.now() - lastAdd > AUTO_ADD_EVERY_MS) {
        lastAdd = Date.now();
        addFinishedPulls();
      }
      if (Date.now() - lastShare > SHARE_EVERY_MS) {
        lastShare = Date.now();
        // A round still busy keeps its own promise, so a stopping worker waits for it.
        if (!shareBusy) shareInFlight = shareStep();
      }
      if (Date.now() - lastPromote > PROMOTE_CHECK_MS) {
        lastPromote = Date.now();
        promoteWaiting();
        pushPromoted();
      }
      if (Date.now() - lastFound > FOUND_CHECK_MS) {
        lastFound = Date.now();
        addFoundEmails();
      }
      if (Date.now() - lastWaitingSweep > SWEEP_WAITING_MS) {
        lastWaitingSweep = Date.now();
        sweepWaitingTemplateRows();
      }
      // The 60-second block and the heartbeat, beside the rows (not awaited): each starts when its time has come.
      if (!housekeepingBusy) housekeepingInFlight = housekeeping();
      if (!beatBusy) beatInFlight = beat();
      const seen = wakes;
      const blocksBefore = housekept;
      const free = CONCURRENCY - inFlight;
      const claimed = free > 0 ? await claim(free) : [];
      for (const r of claimed) {
        inFlight++;
        safeProcess(r).finally(rowFinished);
      }
      if (ONCE && !claimed.length && inFlight === 0 && !housekeepingBusy && housekept === blocksBefore &&
        aiark.idle && fitState.idle && !questionBusy && questionState.idle &&
        !(await runDue(pool)) && !(await companyRunDue(pool)) && !(await peopleRunDue(pool))) break;
      // Rows taken and slots still free: there may be more, so ask again at once. Otherwise wait for a row to finish
      // (its slot is claimed for at once) or, at most, POLL_MS: then nothing was claimable and the queue is read again.
      if (claimed.length && inFlight < CONCURRENCY) continue;
      await untilWoken(seen, POLL_MS);
    } catch (e) {
      log(`loop error: ${e.message}`);
      await sleep(POLL_MS);
    }
  }
  shuttingDown = true;
  const deadline = Date.now() + 25_000;
  while (inFlight > 0 && Date.now() < deadline) await sleep(250);
  if (inFlight > 0) log(`${inFlight} row(s) still in flight at exit — the stale sweep will re-queue them`);
  // The AI Ark slice in flight is waited for, with no deadline: a paid call
  // already sent must have its person written before the pool closes. Told to
  // stop, a slice makes no new paid call, so this is the one in flight at most
  // (an Export Single gets 90 s); the service's drain time must cover it.
  await runs;
  // The fit loop's step in flight is waited for too: an OpenAI call already sent is written before the pool closes.
  await fits;
  // So is the share round in flight (told to stop, it ends after the step it is on), then its own pool closes.
  await shareInFlight;
  await sharePool.end().catch(() => {});
  // And the question step in flight: told to stop, it ends after the lead (or gather page) it is on.
  await questionInFlight;
  await questionPool.end().catch(() => {});
  // The 60-second block and the heartbeat in flight end first, so the stopping heartbeat is the last one written,
  // then their pool closes.
  await housekeepingInFlight;
  await beatInFlight;
  await heartbeat({ stopping: true }).catch(() => {});
  await housekeepingPool.end().catch(() => {});
  log(`stopped: ${stats.processed} rows processed, ${stats.calls} provider calls, ${stats.failed} failures`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
