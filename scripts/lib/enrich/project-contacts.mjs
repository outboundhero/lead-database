// The Companies tab's contacts (enrich_contacts, migration 125): one summary
// per row of a client's General inboxes (pipeline) and People (pipeline)
// tables, written by the worker when the row finishes, fenced on the row's
// claim token, and the listing of the company they belong to (2A.8).
//
// A company is listed when it passes the client's rules, is not on the
// never-contact list, is not in error, and has at least one usable general
// email or usable person email (held ones included). The same company and
// office (company_key) is listed once. relist() recomputes it in one
// statement; projectCompanyV2() and projectContact() both call it, and the
// company's enrich_companies row lock orders them.
//
// Nothing here reads or writes leads.

import { UPLOAD_FOUND_BY } from "./upload-people.mjs";

export const WAITING_OUTCOME = "Waiting for a key";
export const ERROR_OUTCOME = "Error";

/** enrich_contacts.verdict, as migration 125 allows it. */
export const CONTACT_VERDICTS = Object.freeze(["approved", "enrichley", "rejected", "unchecked", "held", "never_contact", "bounced"]);

/**
 * Each outcome's verdict (inbox_outcome, person_outcome). An outcome that is
 * about the client's rules, not the address, has none (null).
 */
export const VERDICT_BY_OUTCOME = Object.freeze({
  general: Object.freeze({
    "Approved": "approved",
    "Waiting for Enrichley": "enrichley",
    "Rejected by Enrichley": "rejected",
    "Rejected by Reoon": "rejected",
    "Already in the database": "held",
    "On the never-contact list": "never_contact",
    "Bounced": "bounced",
    "Not checked: a large company": "unchecked",
    "Not checked: not a qualified address": "unchecked",
    "Not checked: a role or junk address": "unchecked",
  }),
  person: Object.freeze({
    "Approved email": "approved",
    "Waiting for Enrichley": "enrichley",
    "Rejected by Enrichley": "rejected",
    "Rejected by Reoon": "rejected",
    "Not usable: a role or junk address": "rejected",
    "Already in the database": "held",
    "On the never-contact list": "never_contact",
    "Bounced": "bounced",
    "Not checked: a role or junk address": "unchecked",
    "No email (AI Ark found none)": "unchecked",
    "No email yet": "unchecked",
    "Outside the client's area": null,
    "Excluded by the client's rules": null,
  }),
});

const TRACK_VALUES = new Set(["operations", "facility_office", "ceo"]);
const STAGE_VALUES = new Set(["bought", "no_email", "copied", "found"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * @typedef {{ email: string | null, verdict: string | null, usable: boolean, held: boolean, held_lead_id: string | null,
 *             has_question: boolean, full_name: string | null, title: string | null, linkedin: string | null,
 *             track: string | null, found_by: string | null, stage: string | null, rank: number | null,
 *             city: string | null, state: string | null, outcome: string, company_row_id: number | null }} ContactSummary
 */

/**
 * What enrich_contacts holds for one inbox or People row, from the values
 * runRow worked out. usable: an approved address, or one already held as a
 * lead (neither bounced nor never contact). A row waiting on a key or in
 * error is never usable.
 *
 * @param {"general" | "person"} kind
 * @param {Record<string, any>} values
 * @param {{ waiting?: boolean, failed?: boolean }} [state]
 * @returns {ContactSummary}
 */
export function contactSummary(kind, values, { waiting = false, failed = false } = {}) {
  const v = values ?? {};
  const own = kind === "general" ? str(v.inbox_outcome) : str(v.person_outcome);
  const outcome = waiting ? WAITING_OUTCOME : failed ? ERROR_OUTCOME : own ?? "Not worked out";
  /** @type {Record<string, string | null>} */
  const verdicts = VERDICT_BY_OUTCOME[kind] ?? {};
  const verdict = waiting || failed ? null : verdicts[outcome] ?? null;
  const held = verdict === "held";
  const leadId = str(v.in_database?.lead_id);
  const companyRow = Number.parseInt(String(v.company_row ?? ""), 10);
  const rank = Number.parseInt(String(v.rank ?? ""), 10);
  const email =
    kind === "general"
      ? str(v.general_email)
      : str(v.use_work_email) ?? (held ? str(v.in_database?.address) : null) ?? str(v.email);
  return {
    email: email ? email.toLowerCase() : null,
    verdict,
    usable: verdict === "approved" || held,
    held,
    held_lead_id: held && leadId && UUID.test(leadId) ? leadId : null,
    has_question: Boolean(str(v.question)),
    full_name: kind === "person" ? str(v.full_name) : null,
    title: kind === "person" ? str(v.title) : null,
    linkedin: kind === "person" ? str(v.person_linkedin_url) : null,
    track: kind === "person" && TRACK_VALUES.has(v.track) ? v.track : null,
    found_by: kind === "general" ? str(v.found_in) : str(v.found_by),
    stage: kind === "person" && STAGE_VALUES.has(v.stage) ? v.stage : null,
    rank: kind === "person" && Number.isInteger(rank) && rank >= 0 && rank <= 32_767 ? rank : null,
    city: str(v.city),
    state: str(v.state),
    outcome,
    company_row_id: Number.isInteger(companyRow) && companyRow > 0 ? companyRow : null,
  };
}

const UPSERT = `
  WITH ok AS (SELECT 1 FROM enrich_rows WHERE id = $1 AND claim_token = $2),
  x AS (
    SELECT * FROM jsonb_to_record($3::jsonb) AS x(
      company_row_id bigint, table_id uuid, client_tag text, kind text, email text, verdict text, usable boolean,
      held boolean, held_lead_id uuid, has_question boolean, full_name text, title text, linkedin text, track text,
      found_by text, stage text, rank smallint, city text, state text, outcome text)
  )
  INSERT INTO enrich_contacts AS c (
    row_id, company_row_id, table_id, client_tag, kind, email, verdict, usable, held, held_lead_id, has_question,
    full_name, title, linkedin, track, found_by, stage, rank, city, state, outcome, updated_at)
  SELECT $1, x.company_row_id, x.table_id, x.client_tag, x.kind, x.email, x.verdict, coalesce(x.usable, false),
         coalesce(x.held, false), x.held_lead_id, coalesce(x.has_question, false), x.full_name, x.title, x.linkedin,
         x.track, x.found_by, x.stage, x.rank, x.city, x.state, x.outcome, now()
    FROM x WHERE EXISTS (SELECT 1 FROM ok)
  ON CONFLICT (row_id) DO UPDATE
    SET company_row_id = EXCLUDED.company_row_id, table_id = EXCLUDED.table_id, client_tag = EXCLUDED.client_tag,
        kind = EXCLUDED.kind, email = EXCLUDED.email, verdict = EXCLUDED.verdict, usable = EXCLUDED.usable,
        held = EXCLUDED.held, held_lead_id = EXCLUDED.held_lead_id, has_question = EXCLUDED.has_question,
        full_name = EXCLUDED.full_name, title = EXCLUDED.title, linkedin = EXCLUDED.linkedin, track = EXCLUDED.track,
        found_by = EXCLUDED.found_by, stage = EXCLUDED.stage, rank = EXCLUDED.rank, city = EXCLUDED.city,
        state = EXCLUDED.state, outcome = EXCLUDED.outcome, updated_at = now()
  RETURNING company_row_id`;

/**
 * @typedef {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} Db
 */

/**
 * Writes one inbox or People row's summary, only while the worker still holds
 * the row, then lists or unlists its company. A row with no company_row input
 * is not written, and neither is an upload's row (found_by upload, migration
 * 130), whatever its inputs: its found email goes to leads through the
 * upload's own import, so promotion and the Companies tab never take it.
 *
 * @param {Db} db
 * @param {{ rowId: number | string, claimToken: string, tableId: string, clientTag: string, kind: "general" | "person",
 *           values: Record<string, any>, waiting?: boolean, failed?: boolean }} opts
 * @returns {Promise<{ written: boolean, listed: boolean | null, why?: string }>}  listed: the company's listing after this write
 */
export async function projectContact(db, { rowId, claimToken, tableId, clientTag, kind, values, waiting = false, failed = false }) {
  if (str(values?.found_by) === UPLOAD_FOUND_BY) return { written: false, listed: null, why: "An upload's row" };
  const s = contactSummary(kind, values, { waiting, failed });
  if (!s.company_row_id) return { written: false, listed: null, why: "The row has no company_row input" };
  const { rows } = await db.query(UPSERT, [rowId, claimToken, JSON.stringify({ ...s, table_id: tableId, client_tag: clientTag, kind })]);
  if (!rows[0]) return { written: false, listed: null, why: "The row is no longer held by this worker" };
  const { listed } = await relist(db, s.company_row_id);
  return { written: true, listed };
}

/** What a listed company shows, by what it has (LISTED_OUTCOMES_V2), and a wanted company another row already lists. */
export const LISTED_WORDS = Object.freeze({
  both: "General and people emails",
  general: "Has a general email",
  people: "Has people emails",
  held: "Already in the database",
  taken: "Listed under another row",
});
const DERIVED = Object.values(LISTED_WORDS);

const RELIST = `
  WITH n AS (
    SELECT count(*) FILTER (WHERE kind = 'general' AND usable)::int                AS general_emails,
           count(*) FILTER (WHERE kind = 'general' AND usable AND NOT held)::int   AS general_new,
           count(*) FILTER (WHERE kind = 'general' AND verdict = 'enrichley')::int AS general_waiting,
           count(*) FILTER (WHERE kind = 'person' AND usable AND NOT held)::int    AS people_emails,
           count(*) FILTER (WHERE kind = 'person' AND usable AND held)::int        AS people_held,
           count(*) FILTER (WHERE kind = 'person')::int                            AS people_total,
           (array_agg(email ORDER BY held, row_id) FILTER (WHERE kind = 'general' AND usable))[1]    AS first_general,
           (array_agg(found_by ORDER BY held, row_id) FILTER (WHERE kind = 'general' AND usable))[1] AS first_found_by,
           coalesce(bool_and(held) FILTER (WHERE kind = 'general' AND usable), false)                AS general_held
      FROM enrich_contacts WHERE company_row_id = $1
  ),
  e AS (
    SELECT x.*, r.run_status,
           (SELECT c.value #>> '{}' FROM enrich_cells c
             WHERE c.row_id = x.row_id AND c.column_key = 'company_outcome' AND c.status = 'done') AS own_outcome
      FROM enrich_companies x JOIN enrich_rows r ON r.id = x.row_id
     WHERE x.row_id = $1
       FOR UPDATE OF x
  ),
  b AS (
    -- The company's own outcome: as the worker last wrote it, or, where a
    -- listing word replaced it, read again from its row.
    SELECT e.*, coalesce($2::text,
             CASE WHEN NOT (e.outcome = ANY($3::text[])) THEN e.outcome
                  WHEN e.run_status = 'waiting' THEN 'Waiting for a key'
                  WHEN e.run_status = 'error' THEN 'Error'
                  ELSE coalesce(e.own_outcome, e.outcome) END) AS base
      FROM e
  ),
  w AS (
    SELECT b.row_id, b.client_tag, b.company_key, b.base, n.*,
           coalesce(b.passes, false) AND NOT b.never_contact AND b.base <> 'Error'
             AND n.general_emails + n.people_emails + n.people_held > 0 AS wanted
      FROM b, n
  ),
  taken AS (
    SELECT 1 FROM enrich_companies c, w
     WHERE w.wanted AND w.company_key IS NOT NULL AND c.client_tag = w.client_tag
       AND c.company_key = w.company_key AND c.listed AND c.row_id <> w.row_id
     LIMIT 1
  )
  UPDATE enrich_companies x
     SET general_emails = w.general_emails, general_waiting = w.general_waiting,
         people_emails = w.people_emails, people_held = w.people_held, people_total = w.people_total,
         general_email = w.first_general, held = w.general_held, found_by = w.first_found_by,
         listed = w.wanted AND NOT EXISTS (SELECT 1 FROM taken),
         found_at = CASE WHEN w.wanted AND NOT EXISTS (SELECT 1 FROM taken) THEN coalesce(x.found_at, now()) ELSE x.found_at END,
         outcome = CASE
           WHEN w.wanted AND NOT EXISTS (SELECT 1 FROM taken) THEN
             CASE WHEN w.general_new > 0 AND w.people_emails > 0 THEN $4
                  WHEN w.general_new > 0 THEN $5
                  WHEN w.people_emails > 0 THEN $6
                  ELSE $7 END
           WHEN w.wanted THEN $8
           ELSE w.base END,
         updated_at = now()
    FROM w
   WHERE x.row_id = w.row_id
  RETURNING x.listed, x.outcome`;

/**
 * Recomputes a company's counts, listing and shown outcome from its contacts,
 * in one statement. A listed company shows what it has (LISTED_WORDS); an
 * unlisted one its own outcome (`base` when the worker gives it, else the one
 * it last wrote); a wanted company whose company and office another row
 * already lists shows "Listed under another row". Retried twice when two rows
 * race for the same company and office (the unique partial index on
 * client_tag, company_key where listed). { listed: null } when the company row
 * has no enrich_companies row yet.
 *
 * @param {Db} db
 * @param {number | string} companyRowId
 * @param {{ base?: string | null }} [opts]  base: the company row's own outcome, as projectCompanyV2 just wrote it
 * @returns {Promise<{ listed: boolean | null, outcome: string | null }>}
 */
export async function relist(db, companyRowId, { base = null } = {}) {
  const words = [LISTED_WORDS.both, LISTED_WORDS.general, LISTED_WORDS.people, LISTED_WORDS.held, LISTED_WORDS.taken];
  for (let tries = 0; ; tries++) {
    try {
      const { rows } = await db.query(RELIST, [companyRowId, base, DERIVED, ...words]);
      return rows[0] ? { listed: rows[0].listed === true, outcome: rows[0].outcome } : { listed: null, outcome: null };
    } catch (e) {
      if (e?.code === "23505" && tries < 2) continue;
      throw e;
    }
  }
}
