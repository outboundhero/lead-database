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
//                              the worker (KEYED_STEPS)
//
// Each run() resolves to { status, value, display, note, retryable, run }, as
// in actions.mjs. No message ever carries a key or a request URL with a key.
//
// Keyed steps (D6, R28): a step whose key is not on the worker is skipped with
// the note "Needs <KEY> (not held)". It is read as empty, as when the Clay
// column did not run, it is never paid, and it never makes the row wait. The
// engine checks a column's config.key_env before calling (no run record is
// kept); each keyed action checks again. When a key arrives, the rows whose
// cells say "Needs <KEY> (not held)" are queued again (TODO(A): the sweep).

import { TRACKS } from "./settings.mjs";

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());

// ── Keys the pipeline may not hold ──────────────────────────────────────────

/** The provider keys a keyed step runs with. Akeesh sets them on the enrich-worker; nothing here reads their values beyond "is it set". */
export const OPTIONAL_KEYS = Object.freeze(["FINDYMAIL_API_KEY", "PROSPEO_API_KEY", "ANYMAIL_FINDER_API_KEY", "ENRICHLEY_API_KEY"]);

/** The note on a keyed step's cell while its key is not held. */
export const absentKeyNote = (key) => `Needs ${key} (not held)`;

/** Is a provider key set on this worker? Never logs or returns the value. */
export function keyHeld(env, key) {
  return Boolean(text(env?.[key]));
}

/**
 * The keyed steps: the action, the key it runs with, the vendor, the original
 * columns compiled to it, its inputs (the originals' input names, compiled
 * verbatim) and the fields of its value the originals read.
 *
 * The finders run in the originals' order with their run conditions verbatim:
 * by name and domain (P#46 Findymail, P#47 Prospeo, P#48 Anymail Finder, P#49
 * Enrichley on Anymail Finder's address, P#50 the first valid), then by
 * LinkedIn URL (P#51 Findymail, P#52 Prospeo, P#53 Anymail Finder, P#54
 * Enrichley on it), into P#55 Use Work Email.
 */
export const KEYED_STEPS = Object.freeze({
  findymail_find_work_email: {
    key: "FINDYMAIL_API_KEY", vendor: "Findymail", originals: ["P#46"], inputs: ["full_name", "company_domain"],
    reads: "email",
  },
  prospeo_find_work_email: {
    key: "PROSPEO_API_KEY", vendor: "Prospeo", originals: ["P#47"], inputs: ["full_name", "company_domain", "include_catch_all"],
    reads: "email",
  },
  anymail_finder: {
    key: "ANYMAIL_FINDER_API_KEY", vendor: "Anymail Finder", originals: ["P#48", "P#53"], inputs: ["method", "url", "body"],
    host: "api.anymailfinder.com", reads: "results.email, results.validation",
  },
  enrichley_verify_email: {
    key: "ENRICHLEY_API_KEY", vendor: "Enrichley", originals: ["G#41", "P#13", "P#49", "P#54"], inputs: ["email"],
    reads: "valid, result, email",
  },
  findymail_find_work_email_from_linkedin: {
    key: "FINDYMAIL_API_KEY", vendor: "Findymail", originals: ["P#51"], inputs: ["profile_url"],
    reads: "email",
  },
  prospeo_linkedin_email_search: {
    key: "PROSPEO_API_KEY", vendor: "Prospeo", originals: ["P#52"], inputs: ["personal_linkedin_url"],
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

/** A keyed step's run(): skipped without its key, else the adapter. */
function keyed(action, adapter) {
  const { key } = KEYED_STEPS[action];
  return async (ctx) => {
    if (!keyHeld(ctx?.env, key)) return { status: "skipped", note: absentKeyNote(key) };
    return adapter(ctx);
  };
}

/** What a step not built yet answers. Never reached while its key is not held. */
const notBuilt = (name) => ({ status: "error", note: `TODO(A): ${name} is not built yet`, retryable: false });

// TODO(A): the adapters. Findymail, Prospeo and Enrichley from each vendor's
// official public API docs (cite the doc URL in a comment above each); Anymail
// Finder from the compiled http-api-v2 inputs verbatim (method, url, body),
// with the Authorization header built from ANYMAIL_FINDER_API_KEY at run time
// and any host but api.anymailfinder.com refused. One call per attempt, no
// retry on a lost answer; memory per step by its inputs (proposal: kind
// "<action>_v1", 90 days); tests stub fetch and refuse every other host.
const findymailFindWorkEmail = async () => notBuilt("findymail_find_work_email");
const prospeoFindWorkEmail = async () => notBuilt("prospeo_find_work_email");
const anymailFinder = async () => notBuilt("anymail_finder");
const enrichleyVerifyEmail = async () => notBuilt("enrichley_verify_email");
const findymailFromLinkedin = async () => notBuilt("findymail_find_work_email_from_linkedin");
const prospeoLinkedinEmailSearch = async () => notBuilt("prospeo_linkedin_email_search");

// ── people_at_company ───────────────────────────────────────────────────────

/** The people sources a track waits for. A later source adds itself here. */
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

// ── The rest (TODO(A)) ──────────────────────────────────────────────────────

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
 * @typedef {{ urlsAndEmails: Array<{ type: "email", value: string, found_in: string }> }} FoundEmailsValue
 *   find_emails_in_text: every address in the text, in order, lower case, once each; no URLs (D38)
 */
const writeToTable = async () => notBuilt("write_to_table");
const reoonVerify = async () => notBuilt("reoon_verify");
const findEmailsInText = async () => notBuilt("find_emails_in_text");
const dnsMx = async () => notBuilt("dns_mx");
const lookupCompanyData = async () => notBuilt("lookup_company_data");
const heldPeople = async () => notBuilt("held_people");

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
  findymail_find_work_email: { run: keyed("findymail_find_work_email", findymailFindWorkEmail), cache: true },
  prospeo_find_work_email: { run: keyed("prospeo_find_work_email", prospeoFindWorkEmail), cache: true },
  anymail_finder: { run: keyed("anymail_finder", anymailFinder), cache: true },
  enrichley_verify_email: { run: keyed("enrichley_verify_email", enrichleyVerifyEmail), cache: true },
  findymail_find_work_email_from_linkedin: { run: keyed("findymail_find_work_email_from_linkedin", findymailFromLinkedin), cache: true },
  prospeo_linkedin_email_search: { run: keyed("prospeo_linkedin_email_search", prospeoLinkedinEmailSearch), cache: true },
};
