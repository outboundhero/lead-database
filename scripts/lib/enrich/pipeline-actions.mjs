// The pipeline templates' own actions (2A.5), registered in ACTIONS
// (actions.mjs) beside the Clay ones and phase 1's:
//
//   write_to_table      free   Clay's "Write to other table": C#36 into General
//                              inboxes, C#43, C#51, C#58 into People
//   reoon_verify        Reoon  G#39, P#11 and the AI Ark email check (D8), inside
//                              the daily-credit rule and the pipeline's daily share
//   find_emails_in_text free   the named stand-in for C#34's Clay tool (D38)
//   dns_mx              free   P#58, G#46: Google's public DNS, MX only
//   lookup_company_data free   P#8: the company row by id
//   people_at_company   free   the people side of a company row, per track
//   held_people         free   named usable leads already held at the company (D11, D28)
//   absent_key          free   a step whose key is not held: skipped, read as empty
//   waiting             free   a step waiting for the original (D38): never run
//   the keyed steps     paid   the email finders (P#46 to P#54) and Enrichley (G#41,
//                              P#13, P#49, P#54), each run only while its key is on
//                              the worker, and within its vendor's daily calls
//                              (KEYED_STEPS)
//
// Each run() resolves to { status, value, display, note, retryable, run }, as
// in actions.mjs. No message ever carries a key or a request URL with a key.
//
// Keyed steps (D6, R28): a step whose key is not on the worker is skipped with
// the note "Needs <KEY> (not held)". It is read as empty, as when the Clay
// column did not run, it is never paid, and it never makes the row wait. The
// engine checks a column's config.key_env before calling (no run record is
// kept); each keyed action checks again. When a key arrives, the rows whose
// cells say "Needs <KEY> (not held)" are queued again by the hourly sweep
// (requeueRowsForHeldKeys, company-actions.mjs).
//
// With its key held, a keyed step takes one of its vendor's calls for the day
// right before each request (email-vendors.mjs, spend.mjs takeVendorCall;
// enrich_settings.spend_caps.vendor_calls_per_day, migration 129). With no cap
// set (0, the default) or none left, nothing is sent and the cell waits, as
// reoon_verify's does past the Reoon share; the hourly sweep
// (requeueWaitingTemplateRows) queues the row again once the cap allows it.

import { normTag, TRACKS } from "./settings.mjs";
import { capped, httpJson, lostSendGuard, retryableStatus } from "./http.mjs";
import { CAP_REACHED, takeReoonCheck } from "./spend.mjs";
import { reoonMayCheck, reoonVerifyRaw } from "./company-actions.mjs";
import { companyAsHeld, geoFor } from "./client-checks.mjs";
import { ensurePipelineTables, PIPELINE_TEMPLATES } from "./templates.mjs";
import { PEOPLE_WRITERS } from "./people-template.mjs";
import { anymailFinder, enrichleyVerify, findymailByLinkedin, findymailByName, prospeoByLinkedin, prospeoByName } from "./email-vendors.mjs";

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

// ── Keys the pipeline may not hold ──────────────────────────────────────────

/** The provider keys a keyed step runs with. The owner sets them on the enrich-worker; nothing here reads their values beyond "is it set". */
export const OPTIONAL_KEYS = Object.freeze(["FINDYMAIL_API_KEY", "PROSPEO_API_KEY", "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY"]);

/** The note on a keyed step's cell while its key is not held. */
export const absentKeyNote = (key) => `Needs ${key} (not held)`;

/** Is a provider key set on this worker? Never logs or returns the value. */
export function keyHeld(env, key) {
  return Boolean(text(env?.[key]));
}

/**
 * The keyed steps: the action, the key it runs with, the vendor, the daily
 * cap its calls count against (cap: settings.mjs VENDOR_CAP_KEYS; the ledger
 * kind is "<cap>_calls"), the original columns compiled to it, its inputs (the
 * originals' input names, compiled verbatim) and the fields of its value the
 * originals read.
 *
 * The finders run in the originals' order with their run conditions verbatim:
 * by name and domain (P#46 Findymail, P#47 Prospeo, P#48 Anymail Finder, P#49
 * Enrichley on Anymail Finder's address, P#50 the first valid), then by
 * LinkedIn URL (P#51 Findymail, P#52 Prospeo, P#53 Anymail Finder, P#54
 * Enrichley on it), into P#55 Use Work Email.
 */
export const KEYED_STEPS = Object.freeze({
  findymail_find_work_email: {
    key: "FINDYMAIL_API_KEY", vendor: "Findymail", cap: "findymail", originals: ["P#46"], inputs: ["full_name", "company_domain"],
    reads: "email",
  },
  prospeo_find_work_email: {
    key: "PROSPEO_API_KEY", vendor: "Prospeo", cap: "prospeo", originals: ["P#47"], inputs: ["full_name", "company_domain", "include_catch_all"],
    reads: "email",
  },
  anymail_finder: {
    key: "ANYMAIL_FINDER_API_KEY", vendor: "Anymail Finder", cap: "anymail_finder", originals: ["P#48", "P#53"], inputs: ["method", "url", "body"],
    host: "api.anymailfinder.com", reads: "results.email, results.validation",
  },
  enrichley_verify_email: {
    key: "ENRICHLEY_API_KEY", vendor: "Enrichley", cap: "enrichley", originals: ["G#41", "P#13", "P#49", "P#54"], inputs: ["email"],
    reads: "valid, result, email",
  },
  findymail_find_work_email_from_linkedin: {
    key: "FINDYMAIL_API_KEY", vendor: "Findymail", cap: "findymail", originals: ["P#51"], inputs: ["profile_url"],
    reads: "email",
  },
  prospeo_linkedin_email_search: {
    key: "PROSPEO_API_KEY", vendor: "Prospeo", cap: "prospeo", originals: ["P#52"], inputs: ["personal_linkedin_url"],
    reads: "email.email",
  },
});

/**
 * The values the compiled originals read from each keyed step (2A.4). An
 * adapter returns at least these fields; the rest of the vendor's answer may
 * be kept beside them.
 *
 * @typedef {{ email: string | null } & Record<string, any>} FinderEmail
 *   findymail_find_work_email, prospeo_find_work_email, findymail_find_work_email_from_linkedin
 * @typedef {{ email: { email: string | null } & Record<string, any> } & Record<string, any>} ProspeoLinkedinAnswer
 *   prospeo_linkedin_email_search: P#53 and P#55 read .email.email
 * @typedef {{ results?: { email?: string | null, validation?: string | null } & Record<string, any> } & Record<string, any>} AnymailFinderAnswer
 *   anymail_finder: Anymail Finder's JSON answer as sent (P#49, P#50 read .results.email and .results.validation)
 * @typedef {{ email: string, valid: boolean, result: string | null } & Record<string, any>} EnrichleyAnswer
 *   enrichley_verify_email: G#42 and P#14 read .valid, G#43 .result, P#50 and P#55 .valid and .email
 */

/**
 * A keyed step's run(): skipped without its key, refused after two sends with
 * no answer, else the vendor's adapter (email-vendors.mjs, one call an attempt;
 * the compiled column keeps a memory of answers per step, by its inputs). The
 * adapter takes one of the vendor's daily calls right before its request, so
 * neither refusal here counts a call.
 */
function keyed(action, adapter) {
  const { key } = KEYED_STEPS[action];
  return async (ctx) => {
    if (!keyHeld(ctx?.env, key)) return { status: "skipped", note: absentKeyNote(key) };
    const stop = await lostSendGuard(ctx);
    if (stop) return stop;
    return adapter(ctx);
  };
}

// ── people_at_company ───────────────────────────────────────────────────────

/**
 * The people sources a track waits for. LinkedIn people runs stay out (phase 4,
 * decision 23): an area search never looks at a given company on purpose, so
 * waiting for it would keep the AI searches (C#41, C#56) from ever running. A
 * LinkedIn person with a track phrase still counts in `found` (enrich_contacts).
 */
export const PEOPLE_SOURCES = Object.freeze(["ai_ark"]);

/**
 * The value of a company row's people_at_company cell (contract I4).
 *
 * @typedef {{ settled: boolean, found: boolean }} TrackState
 *   settled: every people source has settled the track for this company (bought, no candidate
 *            left, or its tries used, with none of its People rows queued or running);
 *   found: a person of that track at the company is usable (approved or held) or waiting for Enrichley
 * @typedef {"not_looked" | "looking" | "stopped" | "settled" | "skipped_held"} SourceState
 * @typedef {{ looked: boolean, settled: boolean, usable: number, held: number, total: number,
 *             tracks: { operations: TrackState, facility_office: TrackState, ceo: TrackState },
 *             sources: Record<string, SourceState> }} PeopleAtCompany
 *   looked: a people run has looked at the company; settled: every track is settled;
 *   held: named usable leads already in the database at the company and state (held_people's count);
 *   usable: held, plus People rows at the company whose email is usable (enrich_contacts.usable);
 *   total: People rows at the company
 */

/**
 * @typedef {{ source: string, state: string, tracks: Record<string, { settled?: boolean } | undefined> | null,
 *             run_status: string }} RunCompanyEntry  an aiark_people_run_companies row with its run's source and status
 * @typedef {{ track: string | null, total: number, usable: number, found: number }} TrackCounts  enrich_contacts per track
 */

/**
 * people_at_company's value from what the people runs recorded and the
 * company's People rows. Pure, so the tests and the tab can use it.
 *
 * @param {{ entries: RunCompanyEntry[], counts: TrackCounts[], held: number }} parts
 *   entries: newest run first; counts: enrich_contacts of kind person, per track
 * @returns {PeopleAtCompany}
 */
export function peopleAtCompanyValue({ entries, counts, held }) {
  /** @type {Map<string, RunCompanyEntry>} */
  const newest = new Map();
  for (const e of entries ?? []) if (e && !newest.has(e.source)) newest.set(e.source, e);
  /** @type {Record<string, SourceState>} */
  const sources = {};
  for (const s of PEOPLE_SOURCES) {
    const e = newest.get(s);
    sources[s] = !e
      ? "not_looked"
      : e.state === "skipped_held"
        ? "skipped_held"
        : e.state === "settled"
          ? "settled"
          : ["done", "stopped", "error", "cancelled"].includes(e.run_status)
            ? "stopped"
            : "looking";
  }
  const skippedHeld = PEOPLE_SOURCES.some((s) => sources[s] === "skipped_held");
  const trackSettled = (e, t) => Boolean(e) && (e.state === "settled" || e.state === "skipped_held" || e.tracks?.[t]?.settled === true);
  const by = new Map((counts ?? []).map((c) => [c.track, c]));
  const tracks = /** @type {PeopleAtCompany["tracks"]} */ (
    Object.fromEntries(
      TRACKS.map((t) => [
        t,
        {
          settled: PEOPLE_SOURCES.every((s) => trackSettled(newest.get(s), t)),
          found: skippedHeld || Number(by.get(t)?.found ?? 0) > 0,
        },
      ])
    )
  );
  const sum = (f) => (counts ?? []).reduce((a, c) => a + (Number(c[f]) || 0), 0);
  const heldCount = Math.max(0, Math.trunc(Number(held) || 0));
  return {
    looked: [...newest.values()].some((e) => e.state !== "waiting"),
    settled: TRACKS.every((t) => tracks[t].settled),
    usable: heldCount + sum("usable"),
    held: heldCount,
    total: sum("total"),
    tracks,
    sources,
  };
}

async function peopleAtCompany({ inputs, row, db }) {
  const { rows: entries } = await db.query(
    `SELECT r.source, rc.state, rc.tracks, r.status AS run_status
       FROM aiark_people_run_companies rc
       JOIN aiark_people_runs r ON r.id = rc.run_id
      WHERE rc.company_row_id = $1
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT 20`,
    [row.id]
  );
  const { rows: counts } = await db.query(
    `SELECT track, count(*)::int AS total,
            count(*) FILTER (WHERE usable)::int AS usable,
            count(*) FILTER (WHERE usable OR verdict = 'enrichley')::int AS found
       FROM enrich_contacts
      WHERE company_row_id = $1 AND kind = 'person'
      GROUP BY track`,
    [row.id]
  );
  const value = peopleAtCompanyValue({ entries, counts, held: inputs.held });
  const per = TRACKS.map((t) => `${t}: ${value.tracks[t].settled ? "settled" : "open"}${value.tracks[t].found ? ", found" : ""}`).join("; ");
  const display = value.settled ? `Settled: ${value.usable} usable` : value.looked ? "Being looked at" : "Not looked at yet";
  return { status: "done", value, display, note: `${value.total} people rows, ${value.held} held in the database. ${per}` };
}

// ── The value shapes ────────────────────────────────────────────────────────

/**
 * @typedef {{ written: number, rows: number[], capped: number }} WriteToValue
 *   write_to_table: rows written (or found already written), their row ids, and how many were
 *   left unwritten by company_pipeline.inboxes_per_company
 * @typedef {{ count: number, titles: string[] }} HeldPeopleValue
 *   held_people: named usable leads at the same company and state, counted up to 50, and up to 5 titles
 * @typedef {{ record: Record<string, any>, row: { row_id: number, aiark_id: string | null, company: string | null,
 *             phone: string | null, use_address: string | null, category: string | null, sub_category: string | null,
 *             use_city: string | null, use_state: string | null, use_website: string | null, use_domain: string | null } }} CompanyDataValue
 *   lookup_company_data: record holds the company row's values under the Clay column names the
 *   originals read (P#17, P#22, P#28, P#31, P#33, P#34), mapped at compile time from enrich_originals
 *   (config.record: { <Clay name>: <our key> }), so no Clay name is in this repo; row holds the same
 *   under our keys, for our own formulas
 * @typedef {{ urlsAndEmails: Array<{ type: "email", value: string, found_in: string | null }> }} FoundEmailsValue
 *   find_emails_in_text: every address in the text, in order, lower case, once each; no URLs (D38)
 */

/** A value as the text an input cell holds: objects as JSON, nothing for empty. */
function cellText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

/** Work on a client of its own, in a transaction, when db is a pool; else on db as it is. */
async function inTx(db, fn) {
  if (typeof db?.connect !== "function") return fn(db);
  const c = await db.connect();
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

// ── write_to_table (Clay's "Write to other table": C#36, C#43, C#51, C#58) ──

/** The client's pipeline table of a kind, or null. */
async function targetTable(db, tag, kind) {
  const { rows } = await db.query(
    `SELECT id FROM enrich_tables WHERE client_tag = $1 AND kind = $2 AND template = $3`,
    [tag, kind, PIPELINE_TEMPLATES[kind].template]
  );
  return rows[0]?.id ?? null;
}

const SEARCH_CELLS = {
  inboxes: ["general_email", "company", "domain", "city", "state"],
  people: ["written_full_name", "written_title", "written_company", "company_website", "written_city", "written_state"],
};

const WRITE_ROWS = `
  WITH x AS (SELECT * FROM jsonb_to_recordset($3::jsonb) AS x(row_key text, search text, cells jsonb)),
  r AS (
    INSERT INTO enrich_rows (table_id, source_id, row_key, search_text)
    SELECT $1::uuid, $2::uuid, x.row_key, coalesce(x.search, '') FROM x
    ON CONFLICT (table_id, row_key) DO NOTHING
    RETURNING id, row_key
  ),
  c AS (
    INSERT INTO enrich_cells (row_id, column_key, table_id, status, value, display)
    SELECT r.id, kv.key, $1::uuid, 'done', to_jsonb(kv.value), left(kv.value, 300)
      FROM r JOIN x ON x.row_key = r.row_key CROSS JOIN LATERAL jsonb_each_text(x.cells) AS kv
    RETURNING 1
  ),
  s AS (
    UPDATE enrich_sources SET received = received + (SELECT count(*) FROM x)::int, created = created + (SELECT count(*) FROM r)::int
     WHERE id = $2::uuid
    RETURNING 1
  )
  SELECT (SELECT coalesce(array_agg(id ORDER BY id), '{}') FROM r) AS inserted,
         (SELECT coalesce(array_agg(e.id ORDER BY e.id), '{}') FROM enrich_rows e JOIN x ON e.table_id = $1::uuid AND e.row_key = x.row_key) AS existing,
         (SELECT count(*) FROM c)::int AS cells, (SELECT count(*) FROM s)::int AS sourced`;

/**
 * Writes the row(s) the original's mapping describes into the client's
 * General or People table: a target input as itself, a D30 People
 * column as written_<key> (config.cells, worked out at compile time). Each row
 * is upserted on (table_id, row_key) with a write_to source and queued; a
 * repeat writes nothing new. At most company_pipeline.inboxes_per_company
 * inbox rows a company (D7); the rest are counted, not written.
 */
async function writeToTable({ inputs, config, row, table, column, db, settings }) {
  const kind = config?.target_kind;
  if (!PIPELINE_TEMPLATES[kind] || kind === "companies") return { status: "error", note: `Unknown target "${kind}"`, retryable: false };
  const tag = normTag(table?.client_tag);
  const cells = config.cells ?? {};
  const tagKey = Object.keys(cells).find((k) => cells[k] === "client_tag");
  const mappedTag = tagKey ? normTag(cellText(inputs[`map:${tagKey}`])) : "";
  if (mappedTag && mappedTag !== tag) {
    return { status: "error", note: `The mapped client tag (${mappedTag}) is not this table's (${tag}), so nothing was written`, retryable: false };
  }
  /** @type {Record<string, string>} */
  const base = {};
  for (const [tkey, cell] of Object.entries(cells)) {
    if (config.object_paths?.[tkey]) continue;
    const v = cellText(inputs[`map:${tkey}`]);
    if (v) base[cell] = v;
  }
  if (tagKey) base[cells[tagKey]] = tag;
  base.company_row = String(row.id);

  /** @type {Array<{ row_key: string, cells: Record<string, string> }>} */
  let items = [];
  let capped = 0;
  if (config.mode === "array") {
    const paths = Object.entries(config.object_paths ?? {});
    const [keyTarget] = paths[0] ?? [];
    const seen = new Set();
    for (const item of Array.isArray(inputs.items) ? inputs.items : []) {
      if (!item || typeof item !== "object") continue;
      const own = {};
      for (const [tkey, path] of paths) {
        const v = cellText(item[path]);
        if (v) own[cells[tkey]] = tkey === keyTarget ? v.toLowerCase() : v;
      }
      const id = own[cells[keyTarget]];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (kind === "inboxes" && typeof item.found_in === "string" && item.found_in) own.found_in = item.found_in;
      items.push({ row_key: `w:${row.id}:${id}`, cells: { ...base, ...own } });
    }
    const cap = kind === "inboxes" ? settings?.company_pipeline?.inboxes_per_company ?? 5 : Infinity;
    if (items.length > cap) {
      capped = items.length - cap;
      items = items.slice(0, cap);
    }
  } else {
    const writer = config.writer ?? PEOPLE_WRITERS[column?.key] ?? {};
    const extra = kind === "people"
      ? { found_by: writer.found_by ?? "", track: writer.track ?? "", stage: "found", source: "AI search (write-to)" }
      : {};
    items = [{ row_key: `w:${row.id}:${column.key}`, cells: Object.fromEntries(Object.entries({ ...base, ...extra }).filter(([, v]) => v)) }];
  }
  if (!items.length) return { status: "empty", note: "Nothing to write" };

  let target = await targetTable(db, tag, kind);
  if (!target) {
    await inTx(db, (c) => ensurePipelineTables(c, tag, { settings }));
    target = await targetTable(db, tag, kind);
  }
  if (!target) return { status: "error", note: `${tag} has no ${PIPELINE_TEMPLATES[kind].name} table`, retryable: false };
  const { rows: [source] } = await db.query(
    `INSERT INTO enrich_sources (table_id, kind, external_id, label) VALUES ($1, 'write_to', $2, $3)
     ON CONFLICT (table_id, kind, external_id) WHERE external_id IS NOT NULL DO UPDATE SET label = EXCLUDED.label
     RETURNING id`,
    [target, `write_to:${column.key}`, `Written by ${column.name ?? column.key}`]
  );
  const payload = items.map((it) => ({
    row_key: it.row_key,
    search: SEARCH_CELLS[kind].map((k) => it.cells[k]).filter(Boolean).join(" ").toLowerCase().slice(0, 2000),
    cells: it.cells,
  }));
  const { rows: [w] } = await db.query(WRITE_ROWS, [target, source.id, JSON.stringify(payload)]);
  const ids = [...new Set([...(w.inserted ?? []), ...(w.existing ?? [])].map(Number))].sort((a, b) => a - b);
  const fresh = (w.inserted ?? []).length;
  const what = kind === "inboxes" ? "inbox row" : "People row";
  return {
    status: "done",
    value: { written: ids.length, rows: ids, capped },
    display: `${ids.length} ${what}${ids.length === 1 ? "" : "s"}`,
    note: `${fresh} new, ${ids.length - fresh} already written${capped ? `; ${capped} more left out by the cap of ${items.length} a company` : ""}`,
  };
}

// ── reoon_verify (G#39, P#11 and the AI Ark email on the company row) ───────

/** Reoon verdicts that can never be approved: reused from email_validations for free. */
const FINAL_REJECTIONS = Object.freeze(["spamtrap", "invalid", "disposable", "disabled"]);
const FRESH_DAYS = 90;

/**
 * One Reoon check in power mode, as G#39 and P#11 ask. A final rejection
 * already in email_validations (90 days) is reused for free; any other address
 * is checked, since G#40 and P#12 need Reoon's whole answer. Before the check:
 * Reoon's daily-credit rule, then the pipeline's own daily share. Past either,
 * the cell waits and the sweep resumes it.
 */
async function reoonVerify({ inputs, env, db, settings }) {
  const email = text(inputs.email).toLowerCase();
  if (!email) return { status: "empty", note: "No address" };
  const { rows: [known] } = await db.query(
    `SELECT native_status, validated_at FROM email_validations
      WHERE email = $1 AND validated_at > now() - make_interval(days => $2) AND native_status = ANY($3::text[])`,
    [email, FRESH_DAYS, FINAL_REJECTIONS]
  );
  if (known) {
    const on = known.validated_at instanceof Date ? known.validated_at.toISOString().slice(0, 10) : String(known.validated_at).slice(0, 10);
    return {
      status: "done",
      value: { email, status: known.native_status, reused_from: "email_validations" },
      display: known.native_status,
      note: `Reused: Reoon said ${known.native_status} on ${on}, which can never be approved, so nothing was paid`,
    };
  }
  const gate = await reoonMayCheck(env);
  if (!gate.ok) return gate.retryable ? { status: "error", note: gate.why, retryable: true } : { status: "needs_key", note: gate.why };
  if (!(await takeReoonCheck(db, settings))) return { status: "needs_key", note: CAP_REACHED.reoon_checks };
  const r = await reoonVerifyRaw(email, env);
  const run = { request: { email, mode: "power" }, response: capped(r.json), http_status: r.http_status ?? null, error: r.ok ? null : r.why };
  if (!r.ok) return r.keyProblem ? { status: "needs_key", note: r.why, run } : { status: "error", note: `Reoon: ${r.why}`, retryable: r.retryable, run };
  // The newer verdict wins, as in the validation worker's table.
  await db.query(
    `INSERT INTO email_validations (email, status, native_status, provider, validated_at)
     VALUES ($1, $2, $3, 'reoon', now())
     ON CONFLICT (email) DO UPDATE
       SET status = EXCLUDED.status, native_status = EXCLUDED.native_status, provider = EXCLUDED.provider,
           task_id = NULL, validated_at = EXCLUDED.validated_at
     WHERE email_validations.validated_at <= EXCLUDED.validated_at`,
    [email, r.status, r.native]
  );
  return { status: "done", value: r.json, display: r.native, note: `Reoon: ${r.native}`, run: { ...run, http_status: 200 } };
}

// ── find_emails_in_text (the named stand-in for C#34's Clay tool, D38) ──────

const EMAIL_RX = /[a-z0-9._%+'-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;

/** Every address in a text, in order, lower case, once each. */
export function emailsIn(value) {
  const out = [];
  for (const raw of String(value ?? "").match(EMAIL_RX) ?? []) {
    const e = raw.toLowerCase().replace(/^[._'-]+/, "").replace(/\.+$/, "");
    if (e.includes("@") && !out.includes(e)) out.push(e);
  }
  return out;
}

/** Where an address was found: the first general email's source (database, aiark), else the search that answered it. */
function foundIn(email, sources) {
  const first = sources?.first;
  if (Array.isArray(first?.emails) && first.emails.some((x) => String(x?.email ?? "").toLowerCase() === email)) {
    return typeof first.source === "string" ? first.source : null;
  }
  if (emailsIn(sources?.claygent_1).includes(email)) return "claygent_1";
  if (emailsIn(sources?.claygent_2).includes(email)) return "claygent_2";
  return null;
}

async function findEmailsInText({ inputs }) {
  const emails = emailsIn(inputs.text);
  if (!emails.length) return { status: "empty", note: "No address in the text" };
  const urlsAndEmails = emails.map((value) => ({ type: "email", value, found_in: foundIn(value, inputs.sources) }));
  return {
    status: "done",
    value: { urlsAndEmails },
    display: emails.join(", "),
    note: `${emails.length} address${emails.length === 1 ? "" : "es"}. A stand-in for Clay's tool (D38): addresses only, no URLs.`,
  };
}

// ── dns_mx (P#58, G#46: Google's public DNS, MX only, free) ────────────────

async function dnsMx({ inputs }) {
  let u;
  try {
    u = new URL(text(inputs.url));
  } catch {
    return { status: "empty", note: "No URL" };
  }
  if (u.protocol !== "https:" || u.hostname !== "dns.google.com") {
    return { status: "error", note: "Only https://dns.google.com may be called, so nothing was sent", retryable: false };
  }
  const name = text(u.searchParams.get("name"));
  if (!name || name === "undefined" || name === "null") return { status: "empty", note: "No domain to look up" };
  const r = await httpJson(u.href, { tries: 1, timeoutMs: 15_000 });
  const run = { request: { name, type: u.searchParams.get("type") }, response: capped(r.json), http_status: r.status || null, error: r.ok ? null : r.error };
  if (!r.ok || !r.json) return { status: "error", note: `Google DNS: ${r.error ?? "no JSON"}`, retryable: retryableStatus(r.status), run };
  const mx = Array.isArray(r.json.Answer) ? r.json.Answer.filter((a) => a?.type === 15).length : 0;
  return { status: "done", value: r.json, display: mx ? `${mx} MX record${mx === 1 ? "" : "s"}` : "No MX record", run };
}

// ── lookup_company_data (P#8: the company row by its id) ────────────────────

const ROW_KEYS = ["aiark_id", "company", "phone", "use_address", "category", "sub_category", "use_city", "use_state", "use_website", "use_domain"];

async function lookupCompanyData({ inputs, config, table, db }) {
  const id = Number.parseInt(text(inputs.company_row), 10);
  if (!Number.isInteger(id) || id <= 0) return { status: "empty", note: "No company row" };
  const { rows: [r] } = await db.query(
    `SELECT t.client_tag, t.template FROM enrich_rows r JOIN enrich_tables t ON t.id = r.table_id WHERE r.id = $1`,
    [id]
  );
  if (!r) return { status: "empty", note: `The company row ${id} is gone` };
  if (normTag(r.client_tag) !== normTag(table?.client_tag)) {
    return { status: "error", note: `The company row ${id} belongs to another client`, retryable: false };
  }
  const record = config?.record ?? {};
  const keys = [...new Set([...ROW_KEYS, ...Object.values(record)])];
  const { rows: cells } = await db.query(
    `SELECT column_key, value FROM enrich_cells WHERE row_id = $1 AND column_key = ANY($2::text[]) AND status = 'done'`,
    [id, keys]
  );
  const v = Object.fromEntries(cells.map((c) => [c.column_key, c.value]));
  const value = {
    record: Object.fromEntries(Object.entries(record).filter(([, k]) => v[k] != null).map(([name, k]) => [name, v[k]])),
    row: { row_id: id, ...Object.fromEntries(ROW_KEYS.map((k) => [k, v[k] ?? null])) },
  };
  return { status: "done", value, display: text(v.company) || `Company row ${id}`, note: `From the company row ${id} (${r.template ?? "no template"})` };
}

// ── held_people (D11, D28: named usable leads at the company and state) ─────

async function heldPeople({ inputs, db }) {
  const company = companyAsHeld(inputs.company);
  const state = text(inputs.state).toUpperCase();
  const country = text(inputs.country).toUpperCase();
  if (!company || !state) return { status: "done", value: { count: 0, titles: [] }, display: "None held", note: "No company with a state to look up" };
  const { geo } = await geoFor(db);
  const stateName = geo.stateName.get(`${country}|${state}`) ?? state;
  // lower(TRIM(company)) is idx_leads_company_norm; the LIMIT sits inside, so the scan stops at 50.
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n,
            coalesce((array_agg(h.title ORDER BY h.title) FILTER (WHERE h.title IS NOT NULL AND btrim(h.title) <> ''))[1:5], '{}') AS titles
       FROM (SELECT l.title FROM leads l
              WHERE lower(TRIM(l.company)) = lower(TRIM($1)) AND l.email_type = 'personal' AND l.email IS NOT NULL
                AND (l.state_code = $2 OR upper(TRIM(l.state)) = $2 OR lower(TRIM(l.state)) = lower($3))
                AND NOT coalesce(l.is_bounced, false) AND NOT coalesce(l.is_suppressed, false)
                AND NOT EXISTS (SELECT 1 FROM suppressed_emails s WHERE s.email = l.email)
              LIMIT 50) h`,
    [company, state, stateName]
  );
  const count = Number(r?.n ?? 0);
  const titles = (r?.titles ?? []).map((t) => text(t)).filter(Boolean);
  return {
    status: "done",
    value: { count, titles },
    display: count ? `${count >= 50 ? "50 or more" : count} held` : "None held",
    note: count
      ? `${count >= 50 ? "50 or more" : count} usable named lead${count === 1 ? "" : "s"} at "${company}" in ${state} already in the database${titles.length ? ` (${titles.join(", ")})` : ""}`
      : `No usable named lead at "${company}" in ${state}`,
  };
}

/** A step whose key is not held and whose provider is not built: config.key names the key. */
async function absentKey({ config }) {
  return { status: "skipped", note: absentKeyNote(text(config?.key) || "a key") };
}

/** A step waiting for the original (D38): never run; config.why says what it waits for. */
async function waiting({ config }) {
  return { status: "skipped", note: text(config?.why) || "Waiting for the original" };
}

export const PIPELINE_ACTIONS = {
  write_to_table: { run: writeToTable, cache: true },
  reoon_verify: { run: reoonVerify, cache: true },
  find_emails_in_text: { run: findEmailsInText, cache: false },
  dns_mx: { run: dnsMx, cache: true },
  lookup_company_data: { run: lookupCompanyData, cache: false },
  people_at_company: { run: peopleAtCompany, cache: false },
  held_people: { run: heldPeople, cache: false },
  absent_key: { run: absentKey, cache: false },
  waiting: { run: waiting, cache: false },
  findymail_find_work_email: { run: keyed("findymail_find_work_email", findymailByName), cache: true },
  prospeo_find_work_email: { run: keyed("prospeo_find_work_email", prospeoByName), cache: true },
  anymail_finder: { run: keyed("anymail_finder", anymailFinder), cache: true },
  enrichley_verify_email: { run: keyed("enrichley_verify_email", enrichleyVerify), cache: true },
  findymail_find_work_email_from_linkedin: { run: keyed("findymail_find_work_email_from_linkedin", findymailByLinkedin), cache: true },
  prospeo_linkedin_email_search: { run: keyed("prospeo_linkedin_email_search", prospeoByLinkedin), cache: true },
};
